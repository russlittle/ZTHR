/**
 * What an extension says about itself and what a host does with that: the manifest (name, version, who wrote it,
 * which host versions it runs on, the permissions it asks for, the other extensions it needs), semantic versions
 * and ranges (Semantic Versioning 2.0.0 precedence, and the npm range forms `^ ~ >= < - x ||`), a signed package
 * (the manifest and the SHA-256 of every file, signed with Ed25519 under a domain-separating prefix), a trust store
 * that says which key may sign which extension names and when, and an update plan that picks the newest version
 * each installed extension can safely move to and says what needs a person's approval first.
 *
 * Safe by default: the package signature algorithm is fixed (an envelope naming any other is refused, so there is no
 * algorithm confusion), a key signs only the names it is scoped to, revoked and expired keys are refused, file
 * paths that climb out of the package or collide are refused, extra or missing or changed files are refused, an
 * unknown permission is an error, and new permissions or a new major version never apply on their own.
 *
 * Out of scope: archive formats (zip, tar) and fetching packages; the caller gives file names and bytes.
 */
import { createHash, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export class ManifestError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}
export class BadVersion extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class BadPackage extends Error {
  readonly code: 'format' | 'algorithm' | 'unknown-key' | 'revoked' | 'expired' | 'not-yet-valid' | 'scope' | 'signature' | 'files' | 'path';
  constructor(code: BadPackage['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// ================================================================== semantic versions

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly build: readonly string[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text: string): Version {
  if (text.length > 256) throw new BadVersion('a version may be at most 256 characters');
  const m = SEMVER.exec(text.trim());
  if (!m) throw new BadVersion(`"${text}" is not a semantic version`);
  const nums = [m[1]!, m[2]!, m[3]!].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) throw new BadVersion(`"${text}" has a number that is too large`);
  const pre = m[4] === undefined ? [] : m[4].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  if (pre.some((x) => typeof x === 'number' && !Number.isSafeInteger(x))) throw new BadVersion(`"${text}" has a number that is too large`);
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease: pre, build: m[5] === undefined ? [] : m[5].split('.') };
}

export const isVersion = (text: string) => {
  try {
    parseVersion(text);
    return true;
  } catch {
    return false;
  }
};

export const formatVersion = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? `-${v.prerelease.join('.')}` : ''}${v.build.length ? `+${v.build.join('.')}` : ''}`;

/** Precedence by the specification: build metadata is ignored, and a release is above its own pre-releases. */
export function compareVersions(a: Version | string, b: Version | string): -1 | 0 | 1 {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  for (const [p, q] of [[x.major, y.major], [x.minor, y.minor], [x.patch, y.patch]] as const) if (p !== q) return p < q ? -1 : 1;
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1;
  if (!y.prerelease.length) return -1;
  const n = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

type Op = '>=' | '>' | '<=' | '<' | '=';
interface Comparator {
  readonly op: Op;
  readonly v: Version;
}

const zero = (major: number, minor: number, patch: number, pre: (string | number)[] = []): Version => ({ major, minor, patch, prerelease: pre, build: [] });
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Partial3 {
  major?: number;
  minor?: number;
  patch?: number;
  pre: (string | number)[];
}

function partial(text: string): Partial3 {
  const m = PARTIAL.exec(text);
  if (!m) throw new BadVersion(`"${text}" is not a version or a range`);
  const get = (s: string | undefined) => (s === undefined || /^[xX*]$/.test(s) ? undefined : Number(s));
  const major = get(m[1]);
  const minor = major === undefined ? undefined : get(m[2]);
  const patch = minor === undefined ? undefined : get(m[3]);
  for (const n of [major, minor, patch]) if (n !== undefined && !Number.isSafeInteger(n)) throw new BadVersion(`"${text}" has a number that is too large`);
  const pre = m[4] === undefined ? [] : m[4].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const out: Partial3 = { pre };
  if (major !== undefined) out.major = major;
  if (minor !== undefined) out.minor = minor;
  if (patch !== undefined) out.patch = patch;
  return out;
}

const upper = (major: number, minor: number, patch: number): Comparator => ({ op: '<', v: zero(major, minor, patch, [0]) });
const lower = (v: Version): Comparator => ({ op: '>=', v });

function desugar(op: string, text: string): Comparator[] {
  const p = partial(text);
  if (p.major === undefined) return op === '<' || op === '>' ? [{ op: '<', v: zero(0, 0, 0, [0]) }] : [lower(zero(0, 0, 0))];
  const { major, minor, patch } = p;
  const full = zero(major, minor ?? 0, patch ?? 0, p.pre);
  if (op === '^') {
    if (minor === undefined) return [lower(full), upper(major + 1, 0, 0)];
    if (patch === undefined) return [lower(full), major > 0 ? upper(major + 1, 0, 0) : upper(0, minor + 1, 0)];
    if (major > 0) return [lower(full), upper(major + 1, 0, 0)];
    if (minor > 0) return [lower(full), upper(0, minor + 1, 0)];
    return [lower(full), upper(0, 0, patch + 1)];
  }
  if (op === '~') return minor === undefined ? [lower(full), upper(major + 1, 0, 0)] : [lower(full), upper(major, minor + 1, 0)];
  const exact = minor !== undefined && patch !== undefined;
  switch (op) {
    case '':
    case '=':
      return exact ? [{ op: '=', v: full }] : minor === undefined ? [lower(full), upper(major + 1, 0, 0)] : [lower(full), upper(major, minor + 1, 0)];
    case '>':
      return exact ? [{ op: '>', v: full }] : minor === undefined ? [lower(zero(major + 1, 0, 0))] : [lower(zero(major, minor + 1, 0))];
    case '>=':
      return [lower(full)];
    case '<':
      return [{ op: '<', v: zero(major, minor ?? 0, patch ?? 0, [0]) }];
    case '<=':
      return exact ? [{ op: '<=', v: full }] : minor === undefined ? [upper(major + 1, 0, 0)] : [upper(major, minor + 1, 0)];
  }
  throw new BadVersion(`unknown operator ${op}`);
}

export type Range = readonly (readonly Comparator[])[];

/** Reads a range such as "^1.2.3 || >=3 <4", "1.2 - 1.4", "~2.1", "1.x" or "*". */
export function parseRange(text: string): Range {
  if (text.length > 256) throw new BadVersion('a range may be at most 256 characters');
  const sets: Comparator[][] = [];
  for (const part of text.split('||')) {
    const tight = part.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').replace(/\s+-\s+/g, ' - ');
    const toks = tight.split(/\s+/).filter(Boolean);
    const set: Comparator[] = [];
    if (!toks.length) set.push(lower(zero(0, 0, 0)));
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (toks[i + 1] === '-') {
        const hi = toks[i + 2];
        if (hi === undefined) throw new BadVersion(`"${text}" ends in a hyphen`);
        const a = partial(t);
        const b = partial(hi);
        if (a.major !== undefined) set.push(lower(zero(a.major, a.minor ?? 0, a.patch ?? 0, a.pre)));
        if (b.major !== undefined) set.push(...desugar('<=', hi));
        i += 2;
        continue;
      }
      const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(t)!;
      set.push(...desugar(m[1] ?? '', m[2]!));
    }
    sets.push(set);
  }
  return sets;
}

const holds = (c: Comparator, v: Version) => {
  const r = compareVersions(v, c.v);
  return c.op === '=' ? r === 0 : c.op === '>' ? r > 0 : c.op === '>=' ? r >= 0 : c.op === '<' ? r < 0 : r <= 0;
};

/** Whether a version is in a range. A pre-release counts only when the range names a pre-release of the same x.y.z. */
export function satisfies(version: string | Version, range: string | Range, o: { includePrerelease?: boolean } = {}): boolean {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  const r = typeof range === 'string' ? parseRange(range) : range;
  return r.some((set) => {
    if (!set.every((c) => holds(c, v))) return false;
    if (v.prerelease.length && !o.includePrerelease) return set.some((c) => c.v.prerelease.length > 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
    return true;
  });
}

export function maxSatisfying(versions: readonly string[], range: string, o: { includePrerelease?: boolean } = {}): string | undefined {
  const r = parseRange(range);
  let best: string | undefined;
  for (const v of versions) if (satisfies(v, r, o) && (best === undefined || compareVersions(v, best) > 0)) best = v;
  return best;
}

export type Bump = 'major' | 'minor' | 'patch' | 'prerelease' | 'none' | 'downgrade';

export function bumpKind(from: string, to: string): Bump {
  const a = parseVersion(from);
  const b = parseVersion(to);
  const c = compareVersions(a, b);
  if (c === 0) return 'none';
  if (c > 0) return 'downgrade';
  if (b.prerelease.length) return 'prerelease';
  return a.major !== b.major ? 'major' : a.minor !== b.minor ? 'minor' : 'patch';
}

// ================================================================== manifests

export type Risk = 'low' | 'medium' | 'high';
export type PermissionCatalogue = Readonly<Record<string, { readonly risk: Risk; readonly description: string }>>;

/** A starting catalogue; a host replaces it with its own. */
export const defaultPermissions: PermissionCatalogue = {
  'content:read': { risk: 'low', description: 'Read published content' },
  'content:write': { risk: 'medium', description: 'Create and change content' },
  'users:read': { risk: 'medium', description: 'Read people and their emails' },
  'users:write': { risk: 'high', description: 'Create and change accounts and roles' },
  'network:outbound': { risk: 'medium', description: 'Make requests to other servers' },
  'files:uploads': { risk: 'medium', description: 'Read and write uploaded files' },
  'settings:write': { risk: 'high', description: 'Change site settings' },
  'code:execute': { risk: 'high', description: 'Run code outside the extension sandbox' },
};

export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly author: { readonly name: string; readonly url?: string };
  readonly license: string;
  readonly homepage?: string;
  /** Ranges of what it runs on, by name: { host: ">=4.2 <6" }. */
  readonly requires: Readonly<Record<string, string>>;
  readonly permissions: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly entry: string;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LICENSE = /^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/;

export function safePath(p: string): string | undefined {
  if (!p || p.length > 255) return 'is empty or too long';
  if (/[\u0000-\u001f\\]/.test(p)) return 'has a control character or a backslash';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'is not relative';
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return 'has an empty, "." or ".." part';
  return undefined;
}

const isHttps = (u: string) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Every problem with a manifest at once; an empty list means it is sound. */
export function manifestProblems(m: unknown, catalogue: PermissionCatalogue = defaultPermissions): string[] {
  const out: string[] = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['the manifest must be an object'];
  const o = m as Record<string, unknown>;
  const str = (k: string, max = 500) => {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim()) out.push(`${k} is required`);
    else if (v.length > max) out.push(`${k} is longer than ${max} characters`);
    return typeof v === 'string' ? v : '';
  };
  const name = str('name', 64);
  if (name && !NAME.test(name)) out.push('name must be lower-case words joined by hyphens');
  const version = str('version', 64);
  if (version && !isVersion(version)) out.push(`version "${version}" is not a semantic version`);
  str('title', 100);
  str('description', 1000);
  const license = str('license', 100);
  if (license && !LICENSE.test(license)) out.push('license must be an SPDX expression such as "MIT" or "GPL-2.0-or-later"');
  const a = o.author;
  if (!a || typeof a !== 'object' || typeof (a as { name?: unknown }).name !== 'string' || !(a as { name: string }).name.trim()) out.push('author.name is required');
  else if ((a as { url?: unknown }).url !== undefined && (typeof (a as { url: unknown }).url !== 'string' || !isHttps((a as { url: string }).url))) out.push('author.url must be an https address');
  if (o.homepage !== undefined && (typeof o.homepage !== 'string' || !isHttps(o.homepage))) out.push('homepage must be an https address');
  const entry = o.entry;
  if (typeof entry !== 'string') out.push('entry is required');
  else {
    const why = safePath(entry);
    if (why) out.push(`entry ${why}`);
  }
  const rangeMap = (k: string, required: boolean) => {
    const v = o[k];
    if (v === undefined) {
      if (required) out.push(`${k} is required`);
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return void out.push(`${k} must be an object of ranges`);
    for (const [n, r] of Object.entries(v)) {
      if (typeof r !== 'string') out.push(`${k}.${n} must be a version range`);
      else
        try {
          parseRange(r);
        } catch {
          out.push(`${k}.${n}: "${r}" is not a version range`);
        }
    }
  };
  rangeMap('requires', true);
  if (o.requires && typeof o.requires === 'object' && !Object.hasOwn(o.requires, 'host')) out.push('requires.host is required: say which host versions it runs on');
  rangeMap('dependencies', false);
  if (o.dependencies && typeof o.dependencies === 'object' && name && Object.hasOwn(o.dependencies, name)) out.push('an extension cannot depend on itself');
  if (!Array.isArray(o.permissions)) out.push('permissions must be a list (it may be empty)');
  else {
    const seen = new Set<string>();
    for (const p of o.permissions) {
      if (typeof p !== 'string') out.push('every permission must be text');
      else if (!Object.hasOwn(catalogue, p)) out.push(`permission "${p}" is not one this host offers`);
      else if (seen.has(p)) out.push(`permission "${p}" is listed twice`);
      else seen.add(p);
    }
  }
  const known = new Set(['name', 'version', 'title', 'description', 'author', 'license', 'homepage', 'requires', 'permissions', 'dependencies', 'entry']);
  for (const k of Object.keys(o)) if (!known.has(k)) out.push(`"${k}" is not a manifest field`);
  return out;
}

/** Parses manifest text or an object, refusing with all problems. Reading is bounded to 64 KiB. */
export function readManifest(input: string | unknown, catalogue: PermissionCatalogue = defaultPermissions): Manifest {
  let v: unknown = input;
  if (typeof input === 'string') {
    if (input.length > 65_536) throw new ManifestError(['the manifest is larger than 64 KiB']);
    try {
      v = JSON.parse(input);
    } catch {
      throw new ManifestError(['the manifest is not valid JSON']);
    }
  }
  const problems = manifestProblems(v, catalogue);
  if (problems.length) throw new ManifestError(problems);
  return v as Manifest;
}

export interface Approval {
  readonly allowed: readonly string[];
  /** Permissions that wait for a person's yes. */
  readonly needsApproval: readonly string[];
  readonly highest: Risk | 'none';
}

/** Splits what an extension asks for into what the host allows outright and what needs a person's approval. */
export function reviewPermissions(requested: readonly string[], o: { granted?: readonly string[]; autoAllow?: readonly Risk[]; catalogue?: PermissionCatalogue } = {}): Approval {
  const cat = o.catalogue ?? defaultPermissions;
  const auto = new Set<Risk>(o.autoAllow ?? ['low']);
  const granted = new Set(o.granted ?? []);
  const allowed: string[] = [];
  const needs: string[] = [];
  let top = 0;
  const rank: Record<Risk, number> = { low: 1, medium: 2, high: 3 };
  for (const p of requested) {
    const e = Object.hasOwn(cat, p) ? cat[p] : undefined;
    if (!e) throw new ManifestError([`permission "${p}" is not one this host offers`]);
    top = Math.max(top, rank[e.risk]);
    if (granted.has(p) || auto.has(e.risk)) allowed.push(p);
    else needs.push(p);
  }
  return { allowed, needsApproval: needs, highest: (['none', 'low', 'medium', 'high'] as const)[top]! };
}

// ================================================================== signed packages

const DOMAIN = 'zthr-plugin-package-v1\n';
const MAX_FILES = 10_000;

export interface PackageEnvelope {
  readonly format: 1;
  readonly manifest: Manifest;
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly size: number }>>;
  readonly signature: { readonly alg: string; readonly keyId: string; readonly signedAt: number; readonly value: string };
}

export type Bytes = string | Uint8Array;
const bytesOf = (b: Bytes) => (typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b));
const sha256 = (b: Bytes) => createHash('sha256').update(bytesOf(b)).digest('hex');

/** JSON with object keys in a fixed order, so the signed bytes never depend on how a file was written. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function signedBytes(manifest: Manifest, files: PackageEnvelope['files'], keyId: string, signedAt: number): Buffer {
  return Buffer.from(DOMAIN + canonicalJson({ format: 1, manifest, files, keyId, signedAt }));
}

function checkPaths(paths: readonly string[]) {
  if (paths.length > MAX_FILES) throw new BadPackage('files', `a package may hold at most ${MAX_FILES} files`);
  const seen = new Set<string>();
  for (const p of paths) {
    const why = safePath(p);
    if (why) throw new BadPackage('path', `file name "${p.slice(0, 80)}" ${why}`);
    const k = p.normalize('NFC').toLowerCase();
    if (seen.has(k)) throw new BadPackage('path', `"${p}" collides with another file name on a case-insensitive disk`);
    seen.add(k);
  }
}

/** Makes a signed package envelope from a manifest and the package's files. */
export function signPackage(manifest: Manifest, files: Readonly<Record<string, Bytes>>, keyId: string, privateKey: KeyObject, signedAt: number, catalogue: PermissionCatalogue = defaultPermissions): PackageEnvelope {
  const problems = manifestProblems(manifest, catalogue);
  if (problems.length) throw new ManifestError(problems);
  checkPaths(Object.keys(files));
  if (!Object.hasOwn(files, manifest.entry)) throw new BadPackage('files', `the entry file ${manifest.entry} is not in the package`);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new BadPackage('algorithm', 'packages are signed with Ed25519 keys only');
  const table: Record<string, { sha256: string; size: number }> = {};
  for (const p of Object.keys(files).sort()) table[p] = { sha256: sha256(files[p]!), size: bytesOf(files[p]!).length };
  const value = edSign(null, signedBytes(manifest, table, keyId, signedAt), privateKey).toString('base64');
  return { format: 1, manifest, files: table, signature: { alg: 'ed25519', keyId, signedAt, value } };
}

export interface TrustedKey {
  /** The public key, base64 of its SPKI DER, or of the raw 32 bytes. */
  readonly publicKey: string;
  /** Extension names it may sign: exact names, or a prefix ending in "*" such as "acme-*". */
  readonly scope: readonly string[];
  readonly notBefore?: number;
  readonly notAfter?: number;
  /** When the key was revoked; packages signed at or after this time are refused. */
  readonly revokedAt?: number;
}

export type TrustStore = Readonly<Record<string, TrustedKey>>;

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyOf(text: string): KeyObject {
  const raw = Buffer.from(text, 'base64');
  const der = raw.length === 32 ? Buffer.concat([SPKI_PREFIX, raw]) : raw;
  let k: KeyObject;
  try {
    k = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new BadPackage('unknown-key', 'the trusted key is not a public key');
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new BadPackage('algorithm', 'the trusted key is not an Ed25519 key');
  return k;
}

const inScope = (scope: readonly string[], name: string) => scope.some((s) => (s.endsWith('*') ? name.startsWith(s.slice(0, -1)) : s === name));

/**
 * Checks an envelope against the files received and the keys trusted, and returns the manifest if all is well.
 * `now` is when the check happens; the key must have been valid, and not revoked, at the time it signed and now.
 */
export function verifyPackage(envelope: PackageEnvelope, contents: Readonly<Record<string, Bytes>>, trust: TrustStore, now: number): Manifest {
  if (!envelope || envelope.format !== 1 || !envelope.signature || !envelope.files || !envelope.manifest) throw new BadPackage('format', 'not a package envelope');
  const sig = envelope.signature;
  if (sig.alg !== 'ed25519') throw new BadPackage('algorithm', `signature algorithm "${String(sig.alg).slice(0, 20)}" is not accepted; only ed25519 is`);
  const key = Object.hasOwn(trust, sig.keyId) ? trust[sig.keyId] : undefined;
  if (!key) throw new BadPackage('unknown-key', `signing key ${String(sig.keyId).slice(0, 40)} is not trusted`);
  if (key.notBefore !== undefined && (sig.signedAt < key.notBefore || now < key.notBefore)) throw new BadPackage('not-yet-valid', 'the signing key was not yet valid');
  if (key.notAfter !== undefined && (sig.signedAt > key.notAfter || now > key.notAfter)) throw new BadPackage('expired', 'the signing key has expired');
  if (key.revokedAt !== undefined && (sig.signedAt >= key.revokedAt || now >= key.revokedAt)) throw new BadPackage('revoked', 'the signing key has been revoked');
  if (typeof envelope.manifest.name !== 'string' || !inScope(key.scope, envelope.manifest.name)) throw new BadPackage('scope', `this key may not sign "${String(envelope.manifest.name).slice(0, 64)}"`);
  const ok = (() => {
    try {
      return edVerify(null, signedBytes(envelope.manifest, envelope.files, sig.keyId, sig.signedAt), publicKeyOf(key.publicKey), Buffer.from(sig.value, 'base64'));
    } catch {
      return false;
    }
  })();
  if (!ok) throw new BadPackage('signature', 'the signature does not match the manifest and file list');
  readManifest(envelope.manifest);
  const declared = Object.keys(envelope.files);
  checkPaths(declared);
  const got = Object.keys(contents);
  for (const p of got) if (!Object.hasOwn(envelope.files, p)) throw new BadPackage('files', `"${p.slice(0, 80)}" is in the package but not in the signed list`);
  for (const p of declared) {
    if (!Object.hasOwn(contents, p)) throw new BadPackage('files', `"${p}" is in the signed list but missing from the package`);
    const b = bytesOf(contents[p]!);
    const want = envelope.files[p]!;
    if (b.length !== want.size || sha256(b) !== want.sha256) throw new BadPackage('files', `"${p}" has been changed since it was signed`);
  }
  if (!Object.hasOwn(envelope.files, envelope.manifest.entry)) throw new BadPackage('files', 'the entry file is not in the package');
  return envelope.manifest;
}

// ================================================================== update plans

export interface CatalogueVersion {
  readonly manifest: Manifest;
  readonly yanked?: boolean;
}
export type Catalogue = Readonly<Record<string, readonly CatalogueVersion[]>>;

export interface Installed {
  readonly name: string;
  readonly version: string;
  readonly granted: readonly string[];
  /** The newest version the person chose not to take, so the same offer is not repeated. */
  readonly skip?: string;
}

export interface PlanOptions {
  /** The host's own version, checked against `requires.host`. */
  readonly host: string;
  /** Other things the host offers (php, node), by name and version. */
  readonly provides?: Readonly<Record<string, string>>;
  readonly allowPrerelease?: boolean;
  readonly catalogue?: PermissionCatalogue;
}

export interface UpdateItem {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly kind: Bump;
  readonly newPermissions: readonly string[];
  /** True when it cannot apply without a person: a new major version, or new permissions that need approval. */
  readonly needsApproval: boolean;
  readonly reasons: readonly string[];
}

export interface UpdatePlan {
  readonly updates: readonly UpdateItem[];
  /** The order to apply them in: what others depend on comes first. */
  readonly order: readonly string[];
  readonly blocked: readonly { readonly name: string; readonly newest: string | undefined; readonly reason: string }[];
  readonly upToDate: readonly string[];
}

export function compatibleWithHost(m: Manifest, o: Pick<PlanOptions, 'host' | 'provides'>): string | undefined {
  for (const [what, range] of Object.entries(m.requires)) {
    const have = what === 'host' ? o.host : (o.provides ?? {})[what];
    if (have === undefined) return `needs ${what}, which this host does not have`;
    if (!satisfies(have, range, { includePrerelease: true })) return `needs ${what} ${range}, and this host has ${have}`;
  }
  return undefined;
}

/** Plans updates for what is installed: the newest compatible version of each, with what needs a person's yes. */
export function planUpdates(installed: readonly Installed[], catalogue: Catalogue, o: PlanOptions): UpdatePlan {
  const updates: UpdateItem[] = [];
  const blocked: { name: string; newest: string | undefined; reason: string }[] = [];
  const upToDate: string[] = [];
  const have = new Map(installed.map((i) => [i.name, i.version]));
  for (const inst of installed) {
    const offers = (Object.hasOwn(catalogue, inst.name) ? catalogue[inst.name]! : []).filter((e) => !e.yanked && (o.allowPrerelease || !parseVersion(e.manifest.version).prerelease.length || parseVersion(inst.version).prerelease.length));
    const newer = offers.filter((e) => compareVersions(e.manifest.version, inst.version) > 0).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
    if (!newer.length) {
      upToDate.push(inst.name);
      continue;
    }
    let chosen: CatalogueVersion | undefined;
    let why = '';
    for (const e of newer) {
      const host = compatibleWithHost(e.manifest, o);
      if (host) {
        why = `${e.manifest.version} ${host}`;
        continue;
      }
      const dep = Object.entries(e.manifest.dependencies ?? {}).find(([n, r]) => {
        const v = have.get(n);
        return v === undefined || !satisfies(v, r, { includePrerelease: true });
      });
      if (dep) {
        const v = have.get(dep[0]);
        why = `${e.manifest.version} needs ${dep[0]} ${dep[1]}${v === undefined ? ', which is not installed' : `, and ${v} is installed`}`;
        continue;
      }
      chosen = e;
      break;
    }
    if (!chosen) {
      blocked.push({ name: inst.name, newest: newer[0]!.manifest.version, reason: why });
      continue;
    }
    const to = chosen.manifest.version;
    if (inst.skip !== undefined && compareVersions(to, inst.skip) <= 0) {
      upToDate.push(inst.name);
      continue;
    }
    const newPermissions = chosen.manifest.permissions.filter((p) => !inst.granted.includes(p));
    const review = reviewPermissions(chosen.manifest.permissions, { granted: inst.granted, ...(o.catalogue ? { catalogue: o.catalogue } : {}) });
    const kind = bumpKind(inst.version, to);
    const reasons: string[] = [];
    if (kind === 'major') reasons.push(`a new major version (${inst.version} to ${to}) may break things`);
    if (review.needsApproval.length) reasons.push(`asks for new permissions: ${review.needsApproval.join(', ')}`);
    updates.push({ name: inst.name, from: inst.version, to, kind, newPermissions, needsApproval: reasons.length > 0, reasons });
  }
  const target = new Map<string, Manifest>();
  for (const u of updates) target.set(u.name, catalogue[u.name]!.find((e) => e.manifest.version === u.to)!.manifest);
  const order = dependencyOrder(updates.map((u) => u.name), (n) => Object.keys(target.get(n)?.dependencies ?? {}));
  return { updates: order.map((n) => updates.find((u) => u.name === n)!), order, blocked, upToDate };
}

/** Puts names in an order where every extension comes after the ones it depends on; a loop is an error. */
export function dependencyOrder(names: readonly string[], depsOf: (name: string) => readonly string[]): string[] {
  const set = new Set(names);
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: string, path: string[]) => {
    const s = state.get(n);
    if (s === 2) return;
    if (s === 1) throw new ManifestError([`dependency loop: ${[...path.slice(path.indexOf(n)), n].join(' -> ')}`]);
    state.set(n, 1);
    for (const d of [...depsOf(n)].sort()) if (set.has(d)) visit(d, [...path, n]);
    state.set(n, 2);
    out.push(n);
  };
  for (const n of [...names].sort()) visit(n, []);
  return out;
}

export interface InstallPlan {
  /** What to install, in order, each at the chosen version. */
  readonly steps: readonly { readonly name: string; readonly version: string }[];
}

/** Chooses versions for an extension and everything it needs, newest compatible first, or says why not. */
export function planInstall(name: string, range: string, installed: readonly Installed[], catalogue: Catalogue, o: PlanOptions): InstallPlan {
  const have = new Map(installed.map((i) => [i.name, i.version]));
  const chosen = new Map<string, Manifest>();
  const resolving: string[] = [];
  const resolve = (n: string, r: string) => {
    const cur = have.get(n);
    if (cur !== undefined && satisfies(cur, r, { includePrerelease: true })) return;
    if (resolving.includes(n)) throw new ManifestError([`dependency loop: ${[...resolving.slice(resolving.indexOf(n)), n].join(' -> ')}`]);
    const already = chosen.get(n);
    if (already) {
      if (!satisfies(already.version, r, { includePrerelease: true })) throw new ManifestError([`${n} is needed at both ${already.version} and ${r}`]);
      return;
    }
    if (cur !== undefined) throw new ManifestError([`${n} ${cur} is installed but ${r} is needed`]);
    const offers = (Object.hasOwn(catalogue, n) ? catalogue[n]! : []).filter((e) => !e.yanked);
    if (!offers.length) throw new ManifestError([`${n} is not in the catalogue`]);
    const fits = offers.filter((e) => satisfies(e.manifest.version, r, { includePrerelease: o.allowPrerelease === true }) && !compatibleWithHost(e.manifest, o));
    if (!fits.length) {
      const newest = offers.map((e) => e.manifest.version).sort(compareVersions).at(-1)!;
      const why = compatibleWithHost(offers.find((e) => e.manifest.version === newest)!.manifest, o);
      throw new ManifestError([`no version of ${n} fits ${r}${why ? ` (newest, ${newest}, ${why})` : ''}`]);
    }
    const best = fits.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0]!.manifest;
    chosen.set(n, best);
    resolving.push(n);
    for (const [d, dr] of Object.entries(best.dependencies ?? {})) resolve(d, dr);
    resolving.pop();
  };
  resolve(name, range);
  const order = dependencyOrder([...chosen.keys()], (n) => Object.keys(chosen.get(n)?.dependencies ?? {}));
  return { steps: order.map((n) => ({ name: n, version: chosen.get(n)!.version })) };
}
