/**
 * A CycloneDX 1.5 JSON SBOM for each npm project, read from its package-lock.json: every installed package with its
 * name, version, purl, the lockfile's integrity hashes as hex, its licence, and the dependency graph. The output is
 * deterministic: components, hashes, licences and edges are sorted, the serial number is derived from the content,
 * and no timestamp is written unless one is passed.
 *
 *   node tools/supply/sbom.ts [--out <dir>] [--timestamp <ISO-8601>] [<project dir>...]
 *
 * With no project directories it reads the repository root, intent/ and files/. A directory with a package.json but
 * no package-lock.json is a project with no npm dependencies (files/ is one) and gets an SBOM of the project alone.
 * A directory with neither is skipped and said so.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_NAME = 'zthr-supply-sbom';
export const TOOL_VERSION = '1.0.0';

/** One package entry of a lockfile v2/v3 `packages` map. */
export interface LockEntry {
  readonly name?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly devOptional?: boolean;
  readonly peer?: boolean;
  readonly link?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface Lockfile {
  readonly name?: string;
  readonly version?: string;
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockEntry>>;
}

/** A package as installed, one per lockfile path. */
export interface Pkg {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly integrity: string | undefined;
  readonly resolved: string | undefined;
  /** The licence as the lockfile, or else the installed package.json, gives it; undefined when neither does. */
  readonly licence: string | undefined;
  readonly licenceSource: 'lockfile' | 'package.json' | 'none';
  /** Not a dev dependency: npm installs it with --omit=dev. */
  readonly production: boolean;
  readonly optional: boolean;
  /** Lockfile paths this package's declared dependencies resolve to. */
  readonly deps: readonly string[];
}

export interface Project {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly licence: string | undefined;
  readonly lockfile: boolean;
  readonly packages: readonly Pkg[];
  /** Lockfile paths the project's own dependencies resolve to. */
  readonly deps: readonly string[];
}

/** The name a lockfile path installs: the part after its last node_modules/. */
export function nameFromPath(path: string): string {
  const at = path.lastIndexOf('node_modules/');
  return at < 0 ? basename(path) : path.slice(at + 'node_modules/'.length);
}

/** The package URL of an npm package: the scope's @ percent-encoded, as the purl spec requires. */
export function purl(name: string, version: string): string {
  const encoded = name.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

const SRI_ALGS: Readonly<Record<string, string>> = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };

/** Subresource-integrity strings (`sha512-<base64>`, space separated) as CycloneDX hashes in hex. */
export function integrityToHashes(integrity: string | undefined): { alg: string; content: string }[] {
  if (!integrity) return [];
  const out: { alg: string; content: string }[] = [];
  for (const token of integrity.trim().split(/\s+/)) {
    const dash = token.indexOf('-');
    if (dash < 0) continue;
    const alg = SRI_ALGS[token.slice(0, dash).toLowerCase()];
    const b64 = token.slice(dash + 1).replace(/\?.*$/, '');
    if (!alg || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
    out.push({ alg, content: Buffer.from(b64, 'base64').toString('hex') });
  }
  return dedupeSorted(out, (h) => `${h.alg}:${h.content}`);
}

/** A licence field in any of the shapes npm has used, as one SPDX expression string. */
export function normaliseLicence(license: unknown, licenses?: unknown): string | undefined {
  const one = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v.trim() || undefined;
    if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') return ((v as { type: string }).type).trim() || undefined;
    return undefined;
  };
  const direct = one(license);
  if (direct) return direct;
  if (Array.isArray(license) || Array.isArray(licenses)) {
    const list = ((Array.isArray(license) ? license : licenses) as unknown[]).map(one).filter((x): x is string => !!x);
    if (list.length === 1) return list[0];
    // The legacy `licenses` array offered a choice of licences.
    if (list.length > 1) return list.map((l) => (/\s/.test(l) ? `(${l})` : l)).join(' OR ');
  }
  return undefined;
}

/** Where Node would find dependency `name` when required from the package installed at `from`. */
export function resolveDep(packages: Readonly<Record<string, LockEntry>>, from: string, name: string): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return undefined;
    const at = base.lastIndexOf('/node_modules/');
    if (at >= 0) base = base.slice(0, at);
    else if (base.startsWith('node_modules/')) base = '';
    else base = ''; // a workspace directory: its parent is the project root
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function installedLicence(dir: string, path: string): string | undefined {
  const file = join(dir, path, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const p = readJson(file) as { license?: unknown; licenses?: unknown };
    return normaliseLicence(p.license, p.licenses);
  } catch {
    return undefined;
  }
}

function declared(e: LockEntry): string[] {
  return Object.keys({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies });
}

/** A project read from its directory: the lockfile if there is one, the package.json otherwise. */
export function readProject(dir: string, lock?: Lockfile): Project {
  const lockPath = join(dir, 'package-lock.json');
  const pkgPath = join(dir, 'package.json');
  const manifest = existsSync(pkgPath) ? (readJson(pkgPath) as { name?: string; version?: string; license?: unknown; licenses?: unknown; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string> }) : undefined;
  const lockfile = lock ?? (existsSync(lockPath) ? (readJson(lockPath) as Lockfile) : undefined);
  if (!lockfile) {
    if (!manifest) throw new Error(`${dir}: no package.json or package-lock.json`);
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies });
    if (deps.length) throw new Error(`${dir}: package.json declares dependencies (${deps.join(', ')}) but there is no package-lock.json to pin them`);
    return { dir, name: manifest.name ?? basename(resolve(dir)), version: manifest.version ?? '0.0.0', licence: normaliseLicence(manifest.license, manifest.licenses), lockfile: false, packages: [], deps: [] };
  }
  if ((lockfile.lockfileVersion ?? 1) < 2 || !lockfile.packages) throw new Error(`${dir}: lockfileVersion ${lockfile.lockfileVersion ?? 1} has no packages map; regenerate it with npm 7 or later`);
  const packages = lockfile.packages;
  const root = packages[''] ?? {};
  const pkgs: Pkg[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue;
    if (entry.link) continue; // a symlink to a workspace; the workspace's own entry describes it
    const name = entry.name ?? nameFromPath(path);
    const version = entry.version ?? '0.0.0';
    const fromLock = normaliseLicence(entry.license, entry.licenses);
    const fromInstall = fromLock ? undefined : installedLicence(dir, path);
    const deps = declared(entry).map((d) => resolveDep(packages, path, d)).filter((p): p is string => !!p);
    pkgs.push({
      path, name, version, purl: purl(name, version), integrity: entry.integrity, resolved: entry.resolved,
      licence: fromLock ?? fromInstall, licenceSource: fromLock ? 'lockfile' : fromInstall ? 'package.json' : 'none',
      // npm marks a package needed by both trees as devOptional; it is installed in production, so it counts as one.
      production: !entry.dev, optional: !!(entry.optional || entry.devOptional),
      deps: [...new Set(deps.map((p) => linkTarget(packages, p)))].sort(),
    });
  }
  pkgs.sort((a, b) => cmp(a.path, b.path));
  const rootDeps = declared({ ...root, dependencies: { ...root.dependencies, ...(root as { devDependencies?: Record<string, string> }).devDependencies } })
    .map((d) => resolveDep(packages, '', d)).filter((p): p is string => !!p).map((p) => linkTarget(packages, p));
  return {
    dir, name: root.name ?? lockfile.name ?? manifest?.name ?? basename(resolve(dir)), version: root.version ?? lockfile.version ?? manifest?.version ?? '0.0.0',
    licence: normaliseLicence(root.license, root.licenses) ?? normaliseLicence(manifest?.license, manifest?.licenses), lockfile: true, packages: pkgs, deps: [...new Set(rootDeps)].sort(),
  };
}

/** A `link: true` entry stands for its target; edges go to the target's entry. */
function linkTarget(packages: Readonly<Record<string, LockEntry>>, path: string): string {
  const e = packages[path];
  return e?.link && typeof e.resolved === 'string' ? e.resolved : path;
}

/** Byte-order comparison: the same on every machine and locale. */
export function cmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function dedupeSorted<T>(xs: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of xs) m.set(key(x), x);
  return [...m.keys()].sort(cmp).map((k) => m.get(k) as T);
}

/** An SPDX licence as CycloneDX writes it: a single identifier as an id, anything compound as an expression. */
export function licenceChoice(licence: string | undefined): object[] {
  if (!licence) return [];
  if (/^[A-Za-z0-9.+-]+$/.test(licence)) return [{ license: { id: licence } }];
  if (/\b(AND|OR|WITH)\b/.test(licence)) return [{ expression: licence }];
  return [{ license: { name: licence } }];
}

/** A version-5-shaped UUID from a SHA-1 of the content, so the same SBOM always carries the same serial number. */
function contentUuid(text: string): string {
  const h = createHash('sha1').update(text).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function splitName(name: string): { group?: string; name: string } {
  if (name.startsWith('@') && name.includes('/')) {
    const i = name.indexOf('/');
    return { group: name.slice(0, i), name: name.slice(i + 1) };
  }
  return { name };
}

export interface SbomOptions {
  /** ISO-8601; written as metadata.timestamp only when given. */
  readonly timestamp?: string;
}

/** The CycloneDX 1.5 document for a project. */
export function toCycloneDx(project: Project, opts: SbomOptions = {}): Record<string, unknown> {
  const refOf = new Map<string, string>();
  const byRef = new Map<string, { pkg: Pkg; paths: string[] }>();
  for (const p of project.packages) {
    refOf.set(p.path, p.purl);
    const seen = byRef.get(p.purl);
    if (seen) {
      seen.paths.push(p.path);
      // The same name@version installed twice: production if either copy is.
      if (p.production && !seen.pkg.production) seen.pkg = p;
    } else byRef.set(p.purl, { pkg: p, paths: [p.path] });
  }
  const rootRef = purl(project.name, project.version);
  const edges = new Map<string, Set<string>>();
  edges.set(rootRef, new Set(project.deps.map((d) => refOf.get(d)).filter((r): r is string => !!r)));
  for (const p of project.packages) {
    const set = edges.get(p.purl) ?? new Set<string>();
    for (const d of p.deps) {
      const r = refOf.get(d);
      if (r && r !== p.purl) set.add(r);
    }
    edges.set(p.purl, set);
  }
  const production = new Set<string>();
  for (const p of project.packages) if (p.production) production.add(p.purl);

  const components = [...byRef.keys()].sort(cmp).map((ref) => {
    const { pkg, paths } = byRef.get(ref) as { pkg: Pkg; paths: string[] };
    const prod = production.has(ref);
    const c: Record<string, unknown> = {
      type: 'library', 'bom-ref': ref, ...splitName(pkg.name), version: pkg.version,
      scope: prod ? (pkg.optional ? 'optional' : 'required') : 'excluded',
    };
    const hashes = integrityToHashes(pkg.integrity);
    if (hashes.length) c.hashes = hashes;
    const lic = licenceChoice(pkg.licence);
    if (lic.length) c.licenses = lic;
    c.purl = ref;
    if (pkg.resolved && /^https?:/.test(pkg.resolved)) c.externalReferences = [{ type: 'distribution', url: pkg.resolved }];
    const props = [
      ...(prod ? [] : [{ name: 'cdx:npm:package:development', value: 'true' }]),
      ...paths.sort(cmp).map((p) => ({ name: 'cdx:npm:package:path', value: p })),
      { name: 'zthr:licence:source', value: pkg.licenceSource },
    ];
    c.properties = props;
    return c;
  });

  const dependencies = [...edges.keys()].sort(cmp).map((ref) => ({ ref, dependsOn: [...(edges.get(ref) as Set<string>)].sort(cmp) }));
  const metadata: Record<string, unknown> = {};
  if (opts.timestamp) metadata.timestamp = new Date(opts.timestamp).toISOString();
  metadata.tools = { components: [{ type: 'application', name: TOOL_NAME, version: TOOL_VERSION }] };
  metadata.component = {
    type: 'application', 'bom-ref': rootRef, ...splitName(project.name), version: project.version,
    ...(project.licence ? { licenses: licenceChoice(project.licence) } : {}), purl: rootRef,
    properties: [{ name: 'zthr:lockfile', value: project.lockfile ? 'package-lock.json' : 'none (no npm dependencies)' }],
  };
  const body = { metadata, components, dependencies };
  const serialNumber = `urn:uuid:${contentUuid(JSON.stringify(body))}`;
  return { $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json', bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber, version: 1, ...body };
}

/** The SBOM as written to disk: two-space JSON with a trailing newline. */
export function render(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The file name an SBOM for a project directory is written under. */
export function sbomFileName(repoRoot: string, dir: string): string {
  const rel = resolve(dir) === resolve(repoRoot) ? 'root' : resolve(dir).slice(resolve(repoRoot).length + 1).replace(/[\\/]+/g, '-');
  return `sbom-${rel || 'root'}.cdx.json`;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PROJECTS = ['.', 'intent', 'files'];

function main(argv: string[]): number {
  let out = join(REPO_ROOT, 'tools', 'supply', 'out');
  let timestamp: string | undefined = process.env.SBOM_TIMESTAMP || undefined;
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--out') out = resolve(argv[++i] ?? '');
    else if (a === '--timestamp') timestamp = argv[++i];
    else dirs.push(a);
  }
  if (timestamp && Number.isNaN(Date.parse(timestamp))) {
    console.error(`--timestamp ${timestamp} is not an ISO-8601 time`);
    return 2;
  }
  mkdirSync(out, { recursive: true });
  for (const d of dirs.length ? dirs : DEFAULT_PROJECTS) {
    const dir = resolve(REPO_ROOT, d);
    if (!existsSync(join(dir, 'package-lock.json')) && !existsSync(join(dir, 'package.json'))) {
      console.log(`${d}: no package.json or package-lock.json, skipped`);
      continue;
    }
    const project = readProject(dir);
    const doc = toCycloneDx(project, timestamp ? { timestamp } : {});
    const file = join(out, sbomFileName(REPO_ROOT, dir));
    const text = render(doc);
    writeFileSync(file, text);
    const prod = (doc.components as { scope: string }[]).filter((c) => c.scope !== 'excluded').length;
    const withHash = (doc.components as { hashes?: unknown }[]).filter((c) => c.hashes).length;
    const edges = (doc.dependencies as { dependsOn: unknown[] }[]).reduce((n, x) => n + x.dependsOn.length, 0);
    const digest = createHash('sha256').update(text).digest('hex');
    console.log(`${d}: ${project.name}@${project.version}, ${(doc.components as unknown[]).length} components (${prod} production), ${withHash} with SHA-512, ${edges} dependency edges -> ${file} sha256:${digest}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
