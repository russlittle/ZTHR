/**
 * Software bills of materials: reading and writing the two formats everyone exchanges, naming a package the same way
 * in both, and finding which components are affected by known vulnerabilities.
 *
 * - PURL: `parsePurl` and `formatPurl` for package URLs (pkg:npm/%40scope/name@1.2.3?arch=x86#sub), with the type
 *   normalisation the spec asks for (lower-case types, npm and github names, pypi names with _ as -), percent-encoding
 *   in both directions, and refusal of anything malformed.
 * - One model for both formats (`Sbom`: components with name, version, purl, licenses, hashes, and the dependency
 *   graph). `parseCycloneDx` and `writeCycloneDx` read and write CycloneDX JSON 1.4 to 1.6 (nested components,
 *   license ids, names and expressions, hashes, dependencies); `parseSpdx` and `writeSpdx` read and write SPDX 2.2 and
 *   2.3 JSON (packages, purl external references, checksums, DEPENDS_ON and DESCRIBES relationships). Input is
 *   checked for size, depth and count before it is trusted; unknown fields are ignored, never copied through.
 * - `matchAdvisories`: for every component with a purl, the advisories whose package and version ranges include it
 *   (introduced <= version < fixed, or <= lastAffected, or a listed version), using the upkeep block's version
 *   comparison; each finding says whether the component is direct or reached through others, with a shortest path
 *   from the root. `fromUpkeep` turns an upkeep Advisory into this block's shape.
 * - VEX: `applyVex` takes statements (not_affected, fixed, affected, under_investigation) and moves findings that
 *   are not affected or fixed out of the active list, with the reason kept; `parseVex` and `writeVex` use CycloneDX's
 *   `vulnerabilities[].analysis` form.
 * - `diffSboms` (added, removed, version changed) and `failing` (findings at or above a severity) for pipelines.
 *
 * Out of scope: SPDX tag-value and RDF, XML CycloneDX, fetching advisories, and signing.
 */
import { randomUUID } from 'node:crypto';
import { compare } from '../upkeep/index.ts';
import type { Advisory } from '../upkeep/index.ts';

export class SbomError extends Error {}

// -------------------------------------------------------------------------------------------------------------
// PURL

export interface Purl {
  readonly type: string;
  readonly namespace?: string;
  readonly name: string;
  readonly version?: string;
  readonly qualifiers?: Readonly<Record<string, string>>;
  readonly subpath?: string;
}

const TYPE = /^[a-z][a-z0-9.+-]*$/;
const dec = (s: string): string => {
  try {
    const r = decodeURIComponent(s);
    if (/[\u0000-\u001f]/.test(r)) throw new SbomError('a package URL contains control characters');
    return r;
  } catch (e) {
    if (e instanceof SbomError) throw e;
    throw new SbomError('a package URL has a bad percent escape');
  }
};
const enc = (s: string): string => encodeURIComponent(s).replace(/%3A/gi, ':');

function normalise(p: Purl): Purl {
  const lower = ['npm', 'github', 'bitbucket', 'gitlab', 'golang', 'composer', 'cargo', 'gem', 'nuget', 'hex', 'pub', 'swift', 'cocoapods'].includes(p.type);
  const lowerName = ['npm', 'github', 'bitbucket', 'gitlab', 'pypi'].includes(p.type);
  let name = p.name;
  let namespace = p.namespace;
  if (p.type === 'pypi') name = name.toLowerCase().replace(/_/g, '-');
  else if (lowerName) {
    name = name.toLowerCase();
    namespace = namespace?.toLowerCase();
  }
  void lower;
  if (['deb', 'rpm', 'apk', 'alpm'].includes(p.type)) namespace = namespace?.toLowerCase();
  return { type: p.type, ...(namespace ? { namespace } : {}), name, ...(p.version ? { version: p.version } : {}), ...(p.qualifiers && Object.keys(p.qualifiers).length ? { qualifiers: p.qualifiers } : {}), ...(p.subpath ? { subpath: p.subpath } : {}) };
}

export function parsePurl(text: string): Purl {
  if (typeof text !== 'string' || text.length > 2048) throw new SbomError('a package URL is text of at most 2048 characters');
  if (!/^pkg:/i.test(text)) throw new SbomError('a package URL starts with pkg:');
  let rest = text.slice(4).replace(/^\/+/, '');
  let subpath: string | undefined;
  const h = rest.indexOf('#');
  if (h >= 0) {
    subpath = rest
      .slice(h + 1)
      .split('/')
      .filter((s) => s !== '' && s !== '.' && s !== '..')
      .map(dec)
      .join('/');
    rest = rest.slice(0, h);
  }
  let qualifiers: Record<string, string> | undefined;
  const q = rest.indexOf('?');
  if (q >= 0) {
    qualifiers = {};
    for (const kv of rest.slice(q + 1).split('&')) {
      if (kv === '') continue;
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new SbomError('a qualifier is key=value');
      const k = kv.slice(0, eq).toLowerCase();
      if (!/^[a-z][a-z0-9._-]*$/.test(k)) throw new SbomError(`bad qualifier key ${JSON.stringify(k.slice(0, 20))}`);
      const val = dec(kv.slice(eq + 1));
      if (val !== '') qualifiers[k] = val;
    }
    rest = rest.slice(0, q);
  }
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new SbomError('a package URL needs a type and a name');
  const type = rest.slice(0, slash).toLowerCase();
  if (!TYPE.test(type)) throw new SbomError(`bad package type ${JSON.stringify(type.slice(0, 20))}`);
  let path = rest.slice(slash + 1);
  let version: string | undefined;
  const at = path.lastIndexOf('@');
  if (at > path.lastIndexOf('/') && at > 0) {
    version = dec(path.slice(at + 1));
    path = path.slice(0, at);
  }
  const segs = path.split('/').filter((s) => s !== '');
  if (!segs.length) throw new SbomError('a package URL needs a name');
  const name = dec(segs[segs.length - 1]!);
  const ns = segs.slice(0, -1).map(dec);
  if (name === '' || ns.some((s) => s === '')) throw new SbomError('a package URL has an empty part');
  return normalise({ type, ...(ns.length ? { namespace: ns.join('/') } : {}), name, ...(version ? { version } : {}), ...(qualifiers && Object.keys(qualifiers).length ? { qualifiers } : {}), ...(subpath ? { subpath } : {}) });
}

export function formatPurl(p: Purl): string {
  if (!TYPE.test(p.type)) throw new SbomError(`bad package type ${JSON.stringify(String(p.type).slice(0, 20))}`);
  if (!p.name) throw new SbomError('a package URL needs a name');
  const n = normalise(p);
  let s = `pkg:${n.type}/`;
  if (n.namespace) s += `${n.namespace.split('/').map(enc).join('/')}/`;
  s += enc(n.name);
  if (n.version) s += `@${enc(n.version)}`;
  if (n.qualifiers) {
    const parts = Object.keys(n.qualifiers)
      .sort()
      .map((k) => `${k.toLowerCase()}=${enc(n.qualifiers![k]!)}`);
    if (parts.length) s += `?${parts.join('&')}`;
  }
  if (n.subpath) s += `#${n.subpath.split('/').map(enc).join('/')}`;
  return s;
}

/** The same package, whatever the spelling: type, namespace, name (not version or qualifiers). */
export const purlKey = (p: Purl): string => `${p.type}/${p.namespace ?? ''}/${p.name}`;

// -------------------------------------------------------------------------------------------------------------
// Model

export interface Component {
  readonly ref: string;
  readonly name: string;
  readonly version?: string;
  readonly type: string;
  readonly purl?: string;
  readonly licenses: readonly string[];
  readonly hashes: readonly { readonly alg: string; readonly value: string }[];
  readonly supplier?: string;
}
export interface Sbom {
  readonly format: 'cyclonedx' | 'spdx';
  readonly specVersion: string;
  readonly serial?: string;
  readonly created?: string;
  readonly tool?: string;
  readonly name?: string;
  readonly root?: string;
  /** The version of the root when the root is described by the document itself and is not one of the components. */
  readonly rootVersion?: string;
  readonly components: readonly Component[];
  /** ref -> refs it depends on */
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
}

const LIMITS = { bytes: 50_000_000, components: 100_000, depth: 40, edges: 1_000_000 };
const str = (x: unknown, max = 2000): string | undefined => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : undefined);
const obj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

function load(input: unknown): Record<string, unknown> {
  let v = input;
  if (typeof input === 'string') {
    if (input.length > LIMITS.bytes) throw new SbomError('the SBOM is too large');
    try {
      v = JSON.parse(input);
    } catch {
      throw new SbomError('the SBOM is not valid JSON');
    }
  }
  const o = obj(v);
  if (!o) throw new SbomError('the SBOM is not a JSON object');
  return o;
}

function checkPurl(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return formatPurl(parsePurl(p));
  } catch {
    return undefined;
  }
}

// ---- CycloneDX

export function parseCycloneDx(input: unknown): Sbom {
  const o = load(input);
  if (o.bomFormat !== 'CycloneDX') throw new SbomError('this is not a CycloneDX document (bomFormat)');
  const spec = str(o.specVersion, 10);
  if (!spec || !/^1\.[4-6]$/.test(spec)) throw new SbomError(`CycloneDX ${String(o.specVersion).slice(0, 10)} is not supported (1.4 to 1.6)`);
  const comps: Component[] = [];
  const seen = new Set<string>();
  const walk = (list: unknown[], depth: number) => {
    if (depth > LIMITS.depth) throw new SbomError('components are nested too deeply');
    for (const raw of list) {
      const c = obj(raw);
      if (!c) continue;
      if (comps.length >= LIMITS.components) throw new SbomError('too many components');
      const name = str(c.name, 500);
      if (!name) throw new SbomError('a component has no name');
      const purl = checkPurl(str(c.purl, 2048));
      const ref = str(c['bom-ref'], 1000) ?? purl ?? `${name}@${str(c.version, 200) ?? ''}`;
      if (seen.has(ref)) throw new SbomError(`two components have the ref ${JSON.stringify(ref.slice(0, 80))}`);
      seen.add(ref);
      const licenses: string[] = [];
      for (const l of arr(c.licenses)) {
        const lo = obj(l);
        const inner = obj(lo?.license);
        const id = str(inner?.id, 200) ?? str(inner?.name, 200) ?? str(lo?.expression, 500);
        if (id) licenses.push(id);
      }
      const hashes = arr(c.hashes).flatMap((h) => {
        const ho = obj(h);
        const alg = str(ho?.alg, 20);
        const value = str(ho?.content, 200);
        return alg && value && /^[0-9a-fA-F]+$/.test(value) ? [{ alg, value: value.toLowerCase() }] : [];
      });
      const supplier = str(obj(c.supplier)?.name, 300);
      const version = str(c.version, 200);
      comps.push({ ref, name, ...(version ? { version } : {}), type: str(c.type, 40) ?? 'library', ...(purl ? { purl } : {}), licenses, hashes, ...(supplier ? { supplier } : {}) });
      walk(arr(c.components), depth + 1);
    }
  };
  walk(arr(o.components), 0);
  const meta = obj(o.metadata);
  const rootComp = obj(meta?.component);
  let root: string | undefined;
  const rootVersion = str(rootComp?.version, 200);
  if (rootComp) {
    const rname = str(rootComp.name, 500);
    root = str(rootComp['bom-ref'], 1000) ?? (rname ? `${rname}@${str(rootComp.version, 200) ?? ''}` : undefined);
  }
  const deps: Record<string, string[]> = {};
  let edges = 0;
  for (const d of arr(o.dependencies)) {
    const dobj = obj(d);
    const ref = str(dobj?.ref, 1000);
    if (!ref) continue;
    const list = arr(dobj?.dependsOn).filter((x): x is string => typeof x === 'string');
    edges += list.length;
    if (edges > LIMITS.edges) throw new SbomError('too many dependency edges');
    deps[ref] = list;
  }
  const tools = obj(meta?.tools);
  const toolName = str(arr(tools?.components ?? meta?.tools).map((t) => obj(t)?.name).find((n) => typeof n === 'string') as string | undefined, 200);
  const serial = str(o.serialNumber, 100);
  const created = str(meta?.timestamp, 40);
  const name = str(rootComp?.name, 500);
  return { format: 'cyclonedx', specVersion: spec, ...(serial ? { serial } : {}), ...(created ? { created } : {}), ...(toolName ? { tool: toolName } : {}), ...(name ? { name } : {}), ...(root ? { root } : {}), ...(root && rootVersion && !seen.has(root) ? { rootVersion } : {}), components: comps, dependencies: deps };
}

export function writeCycloneDx(s: Sbom, o: { now?: () => Date; serial?: () => string; specVersion?: '1.4' | '1.5' | '1.6' } = {}): Record<string, unknown> {
  const refs = new Set(s.components.map((c) => c.ref));
  if (refs.size !== s.components.length) throw new SbomError('two components share a ref');
  const rootComp = s.root ? s.components.find((c) => c.ref === s.root) : undefined;
  const license = (l: string) => (/[\s()]/.test(l) || / (AND|OR|WITH) /.test(l) ? { expression: l } : /^[A-Za-z0-9.+-]+$/.test(l) && /[0-9]|^[A-Z]+$/.test(l) ? { license: { id: l } } : { license: { name: l } });
  const comp = (c: Component) => ({
    type: c.type,
    'bom-ref': c.ref,
    name: c.name,
    ...(c.version ? { version: c.version } : {}),
    ...(c.purl ? { purl: c.purl } : {}),
    ...(c.supplier ? { supplier: { name: c.supplier } } : {}),
    ...(c.licenses.length ? { licenses: c.licenses.map(license) } : {}),
    ...(c.hashes.length ? { hashes: c.hashes.map((h) => ({ alg: h.alg, content: h.value })) } : {}),
  });
  return {
    bomFormat: 'CycloneDX',
    specVersion: o.specVersion ?? '1.5',
    serialNumber: s.serial ?? `urn:uuid:${(o.serial ?? randomUUID)()}`,
    version: 1,
    metadata: {
      timestamp: s.created ?? (o.now ?? (() => new Date()))().toISOString(),
      ...(s.tool ? { tools: { components: [{ type: 'application', name: s.tool }] } } : {}),
      ...(rootComp ? { component: comp(rootComp) } : s.name ? { component: { type: 'application', ...(s.root ? { 'bom-ref': s.root } : {}), name: s.name, ...(s.rootVersion ? { version: s.rootVersion } : {}) } } : {}),
    },
    components: s.components.filter((c) => c.ref !== s.root).map(comp),
    dependencies: Object.keys(s.dependencies)
      .sort()
      .map((ref) => ({ ref, dependsOn: [...(s.dependencies[ref] ?? [])].sort() })),
  };
}

// ---- SPDX

export function parseSpdx(input: unknown): Sbom {
  const o = load(input);
  const ver = str(o.spdxVersion, 20);
  const m = /^SPDX-(2\.[23])$/.exec(ver ?? '');
  if (!m) throw new SbomError(`${String(o.spdxVersion ?? 'this document').slice(0, 20)} is not SPDX 2.2 or 2.3 JSON`);
  const comps: Component[] = [];
  const seen = new Set<string>();
  for (const raw of arr(o.packages)) {
    const p = obj(raw);
    if (!p) continue;
    if (comps.length >= LIMITS.components) throw new SbomError('too many packages');
    const ref = str(p.SPDXID, 500);
    const name = str(p.name, 500);
    if (!ref || !/^SPDXRef-[A-Za-z0-9.-]+$/.test(ref) || !name) throw new SbomError('a package needs an SPDXID like SPDXRef-x and a name');
    if (seen.has(ref)) throw new SbomError(`two packages have the id ${ref}`);
    seen.add(ref);
    let purl: string | undefined;
    for (const r of arr(p.externalRefs)) {
      const ro = obj(r);
      if (ro?.referenceType === 'purl' && typeof ro.referenceLocator === 'string') purl = checkPurl(ro.referenceLocator) ?? purl;
    }
    const lic = [str(p.licenseConcluded, 500), str(p.licenseDeclared, 500)].find((l) => l && l !== 'NOASSERTION' && l !== 'NONE');
    const hashes = arr(p.checksums).flatMap((h) => {
      const ho = obj(h);
      const alg = str(ho?.algorithm, 20);
      const value = str(ho?.checksumValue, 200);
      return alg && value && /^[0-9a-fA-F]+$/.test(value) ? [{ alg, value: value.toLowerCase() }] : [];
    });
    const sup = str(p.supplier, 300);
    const version = str(p.versionInfo, 200);
    comps.push({ ref, name, ...(version ? { version } : {}), type: 'library', ...(purl ? { purl } : {}), licenses: lic ? [lic] : [], hashes, ...(sup && sup !== 'NOASSERTION' ? { supplier: sup.replace(/^(Organization|Person): /, '') } : {}) });
  }
  const deps: Record<string, string[]> = {};
  let root: string | undefined;
  let edges = 0;
  for (const r of arr(o.relationships)) {
    const ro = obj(r);
    const a = str(ro?.spdxElementId, 500);
    const b = str(ro?.relatedSpdxElement, 500);
    const t = str(ro?.relationshipType, 40);
    if (!a || !b || !t) continue;
    if (t === 'DESCRIBES' && a === 'SPDXRef-DOCUMENT') root ??= b;
    else if (t === 'DEPENDS_ON' && seen.has(a) && seen.has(b)) (deps[a] ??= []).push(b);
    else if (t === 'DEPENDENCY_OF' && seen.has(a) && seen.has(b)) (deps[b] ??= []).push(a);
    if (++edges > LIMITS.edges) throw new SbomError('too many relationships');
  }
  for (const k of Object.keys(deps)) deps[k] = [...new Set(deps[k])];
  const ci = obj(o.creationInfo);
  const tool = arr(ci?.creators).map((c) => (typeof c === 'string' ? /^Tool: (.+)$/.exec(c)?.[1] : undefined)).find(Boolean);
  const created = str(ci?.created, 40);
  const serial = str(o.documentNamespace, 500);
  const name = str(o.name, 500);
  return { format: 'spdx', specVersion: m[1]!, ...(serial ? { serial } : {}), ...(created ? { created } : {}), ...(tool ? { tool } : {}), ...(name ? { name } : {}), ...(root && seen.has(root) ? { root } : {}), components: comps, dependencies: deps };
}

export function writeSpdx(input: Sbom, o: { now?: () => Date; namespace?: () => string } = {}): Record<string, unknown> {
  const s: Sbom = input.root && !input.components.some((c) => c.ref === input.root) && input.name ? { ...input, components: [{ ref: input.root, name: input.name, ...(input.rootVersion ? { version: input.rootVersion } : {}), type: 'application', licenses: [], hashes: [] }, ...input.components] } : input;
  const idOf = (ref: string) => (/^SPDXRef-[A-Za-z0-9.-]+$/.test(ref) ? ref : `SPDXRef-${ref.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'x'}`);
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const c of s.components) {
    let id = idOf(c.ref);
    let n = 1;
    while (used.has(id)) id = `${idOf(c.ref)}-${++n}`;
    used.add(id);
    ids.set(c.ref, id);
  }
  const rel: { spdxElementId: string; relationshipType: string; relatedSpdxElement: string }[] = [];
  if (s.root && ids.has(s.root)) rel.push({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: ids.get(s.root)! });
  for (const a of Object.keys(s.dependencies).sort()) for (const b of [...(s.dependencies[a] ?? [])].sort()) if (ids.has(a) && ids.has(b)) rel.push({ spdxElementId: ids.get(a)!, relationshipType: 'DEPENDS_ON', relatedSpdxElement: ids.get(b)! });
  return {
    spdxVersion: `SPDX-${s.format === 'spdx' ? s.specVersion : '2.3'}`,
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: s.name ?? 'sbom',
    documentNamespace: s.serial?.startsWith('http') ? s.serial : (o.namespace ?? (() => `https://example.invalid/spdx/${randomUUID()}`))(),
    creationInfo: { created: (s.created ?? (o.now ?? (() => new Date()))().toISOString()).replace(/\.\d+Z$/, 'Z'), creators: [`Tool: ${s.tool ?? 'sbom-block'}`] },
    packages: s.components.map((c) => ({
      SPDXID: ids.get(c.ref)!,
      name: c.name,
      ...(c.version ? { versionInfo: c.version } : {}),
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: c.licenses[0] ?? 'NOASSERTION',
      licenseDeclared: c.licenses[0] ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      ...(c.supplier ? { supplier: `Organization: ${c.supplier}` } : {}),
      ...(c.hashes.length ? { checksums: c.hashes.map((h) => ({ algorithm: h.alg.toUpperCase().replace(/^SHA-/, 'SHA'), checksumValue: h.value })) } : {}),
      ...(c.purl ? { externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.purl }] } : {}),
    })),
    relationships: rel,
  };
}

// -------------------------------------------------------------------------------------------------------------
// Vulnerabilities

export type Severity = 'low' | 'moderate' | 'high' | 'critical';
const RANK: Record<Severity, number> = { low: 1, moderate: 2, high: 3, critical: 4 };
export interface Range {
  readonly introduced?: string;
  readonly fixed?: string;
  readonly lastAffected?: string;
}
export interface Vuln {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly severity: Severity;
  /** The package by purl type, namespace and name. */
  readonly package: { readonly type: string; readonly namespace?: string; readonly name: string };
  readonly ranges?: readonly Range[];
  readonly versions?: readonly string[];
}

/** An upkeep advisory (package name only, npm unless said) as a Vuln. */
export function fromUpkeep(a: Advisory, type = 'npm'): Vuln {
  const scoped = a.package.startsWith('@') ? a.package.slice(1).split('/') : undefined;
  return { id: a.id, severity: a.severity, package: scoped && scoped.length === 2 ? { type, namespace: `@${scoped[0]}`, name: scoped[1]! } : { type, name: a.package }, ranges: [{ ...(a.introducedIn ? { introduced: a.introducedIn } : {}), fixed: a.fixedIn }] };
}

export function inRanges(version: string, v: Pick<Vuln, 'ranges' | 'versions'>): boolean {
  if (v.versions?.includes(version)) return true;
  return (v.ranges ?? []).some((r) => {
    if (r.introduced && r.introduced !== '0' && compare(version, r.introduced) < 0) return false;
    if (r.fixed) return compare(version, r.fixed) < 0;
    if (r.lastAffected) return compare(version, r.lastAffected) <= 0;
    return true;
  });
}

export interface Finding {
  readonly vuln: string;
  readonly aliases: readonly string[];
  readonly severity: Severity;
  readonly component: string;
  readonly purl: string;
  readonly version: string;
  readonly fixedIn?: string;
  readonly summary?: string;
  /** direct: a dependency of the root; transitive: reached through others; unknown: no graph to say. */
  readonly via: 'direct' | 'transitive' | 'unknown';
  readonly path: readonly string[];
}

function pathsFromRoot(s: Sbom): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!s.root) return out;
  out.set(s.root, [s.root]);
  const q = [s.root];
  for (let i = 0; i < q.length; i++) {
    const cur = q[i]!;
    for (const n of s.dependencies[cur] ?? []) {
      if (out.has(n)) continue;
      out.set(n, [...out.get(cur)!, n]);
      q.push(n);
    }
  }
  return out;
}

export function matchAdvisories(s: Sbom, vulns: readonly Vuln[]): Finding[] {
  const byPkg = new Map<string, Vuln[]>();
  for (const v of vulns) {
    const k = purlKey({ type: v.package.type, ...(v.package.namespace ? { namespace: v.package.namespace } : {}), name: v.package.name });
    const nk = purlKey(normalise({ type: v.package.type, ...(v.package.namespace ? { namespace: v.package.namespace } : {}), name: v.package.name }));
    for (const key of new Set([k, nk])) (byPkg.get(key) ?? byPkg.set(key, []).get(key)!).push(v);
  }
  const paths = pathsFromRoot(s);
  const out: Finding[] = [];
  for (const c of s.components) {
    if (!c.purl || !c.version) continue;
    const p = parsePurl(c.purl);
    for (const v of byPkg.get(purlKey(p)) ?? []) {
      if (!inRanges(c.version, v)) continue;
      const path = paths.get(c.ref);
      const fixed = (v.ranges ?? []).map((r) => r.fixed).filter((x): x is string => !!x && compare(c.version!, x) < 0).sort(compare)[0];
      out.push({
        vuln: v.id,
        aliases: v.aliases ?? [],
        severity: v.severity,
        component: c.ref,
        purl: c.purl,
        version: c.version,
        ...(fixed ? { fixedIn: fixed } : {}),
        ...(v.summary ? { summary: v.summary } : {}),
        via: !path ? 'unknown' : path.length <= 2 ? 'direct' : 'transitive',
        path: path ?? [],
      });
    }
  }
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.vuln.localeCompare(b.vuln) || a.component.localeCompare(b.component));
}

export const failing = (f: readonly Finding[], atLeast: Severity): Finding[] => f.filter((x) => RANK[x.severity] >= RANK[atLeast]);

// ---- VEX

export type VexStatus = 'not_affected' | 'affected' | 'fixed' | 'under_investigation';
export interface VexStatement {
  readonly vuln: string;
  /** A purl without version covers every version; with a version, that one; or a component ref. */
  readonly product: string;
  readonly status: VexStatus;
  readonly justification?: string;
  readonly detail?: string;
}

const CDX_STATE: Record<string, VexStatus> = { not_affected: 'not_affected', false_positive: 'not_affected', resolved: 'fixed', resolved_with_pedigree: 'fixed', exploitable: 'affected', in_triage: 'under_investigation' };
const TO_CDX: Record<VexStatus, string> = { not_affected: 'not_affected', fixed: 'resolved', affected: 'exploitable', under_investigation: 'in_triage' };

export function parseVex(input: unknown): VexStatement[] {
  const o = load(input);
  const out: VexStatement[] = [];
  for (const raw of arr(o.vulnerabilities)) {
    const v = obj(raw);
    const id = str(v?.id, 200);
    const a = obj(v?.analysis);
    const status = CDX_STATE[str(a?.state, 40) ?? ''];
    if (!id || !status) continue;
    for (const af of arr(v?.affects)) {
      const ref = str(obj(af)?.ref, 2048);
      if (!ref) continue;
      const just = str(a?.justification, 100);
      const detail = str(a?.detail, 2000);
      out.push({ vuln: id, product: ref, status, ...(just ? { justification: just } : {}), ...(detail ? { detail } : {}) });
    }
  }
  return out;
}

export function writeVex(statements: readonly VexStatement[]): Record<string, unknown> {
  const byVuln = new Map<string, VexStatement[]>();
  for (const s of statements) (byVuln.get(`${s.vuln}\u0000${s.status}\u0000${s.justification ?? ''}\u0000${s.detail ?? ''}`) ?? byVuln.set(`${s.vuln}\u0000${s.status}\u0000${s.justification ?? ''}\u0000${s.detail ?? ''}`, []).get(`${s.vuln}\u0000${s.status}\u0000${s.justification ?? ''}\u0000${s.detail ?? ''}`)!).push(s);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    vulnerabilities: [...byVuln.values()].map((g) => ({
      id: g[0]!.vuln,
      analysis: { state: TO_CDX[g[0]!.status], ...(g[0]!.justification ? { justification: g[0]!.justification } : {}), ...(g[0]!.detail ? { detail: g[0]!.detail } : {}) },
      affects: g.map((s) => ({ ref: s.product })),
    })),
  };
}

export interface Applied {
  readonly active: Finding[];
  readonly suppressed: { finding: Finding; statement: VexStatement }[];
}

function productMatches(st: VexStatement, f: Finding): boolean {
  if (st.product === f.component || st.product === f.purl) return true;
  if (st.product.startsWith('pkg:')) {
    try {
      const p = parsePurl(st.product);
      const fp = parsePurl(f.purl);
      return purlKey(p) === purlKey(fp) && (p.version === undefined || p.version === fp.version);
    } catch {
      return false;
    }
  }
  return false;
}

/** not_affected and fixed statements remove findings from the active list; the rest leave them. A later statement wins. */
export function applyVex(findings: readonly Finding[], statements: readonly VexStatement[]): Applied {
  const active: Finding[] = [];
  const suppressed: Applied['suppressed'] = [];
  for (const f of findings) {
    const ids = new Set([f.vuln, ...f.aliases]);
    const st = [...statements].reverse().find((s) => ids.has(s.vuln) && productMatches(s, f));
    if (st && (st.status === 'not_affected' || st.status === 'fixed')) suppressed.push({ finding: f, statement: st });
    else active.push(f);
  }
  return { active, suppressed };
}

// ---- Diff

export function diffSboms(a: Sbom, b: Sbom): { added: Component[]; removed: Component[]; changed: { name: string; from: string | undefined; to: string | undefined }[] } {
  const key = (c: Component) => (c.purl ? purlKey(parsePurl(c.purl)) : `name/${c.name}`);
  const ma = new Map(a.components.map((c) => [key(c), c]));
  const mb = new Map(b.components.map((c) => [key(c), c]));
  const added = [...mb].filter(([k]) => !ma.has(k)).map(([, c]) => c);
  const removed = [...ma].filter(([k]) => !mb.has(k)).map(([, c]) => c);
  const changed = [...mb].filter(([k, c]) => ma.has(k) && ma.get(k)!.version !== c.version).map(([k, c]) => ({ name: c.name, from: ma.get(k)!.version, to: c.version }));
  return { added, removed, changed };
}
