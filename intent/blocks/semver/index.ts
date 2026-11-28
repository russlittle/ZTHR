/**
 * Versions: Semantic Versioning 2.0.0 and calendar versions. Parsing is strict (no leading zeros, no missing parts,
 * no "v"), comparison follows the precedence rules of the SemVer spec (build metadata is ignored; a prerelease sorts
 * before its release; numeric identifiers sort below alphanumeric ones), and ranges use the npm grammar: comparators
 * (`>=1.2.3 <2`), `||` alternatives, hyphen ranges, x-ranges (`1.x`, `*`), tilde and caret, with the usual rule that
 * a prerelease only satisfies a range that names a prerelease of the same major.minor.patch. A small solver picks
 * one version of each package so that every constraint holds, preferring the newest, and says which requirements
 * clash when none exists. Calendar versions (`YYYY.0M.MICRO` and kin) parse and compare as numbers per segment.
 *
 * Not here: loose parsing of "v1.2" or "=1.2.3 " forms beyond a leading `=`/`v` in ranges, and registry access.
 * Pure: no clock, no network.
 */

export class InvalidVersion extends Error {
  readonly input: string;
  constructor(input: string, why: string) {
    super(`"${input}" is not a valid version: ${why}`);
    this.name = 'InvalidVersion';
    this.input = input;
  }
}

export class InvalidRange extends Error {
  readonly input: string;
  constructor(input: string, why: string) {
    super(`"${input}" is not a valid range: ${why}`);
    this.name = 'InvalidRange';
    this.input = input;
  }
}

export class TooComplex extends Error {
  constructor(steps: number) {
    super(`the constraint search was stopped after ${steps} steps; narrow the ranges`);
    this.name = 'TooComplex';
  }
}

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly build: readonly string[];
}

const NUM = '(0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const BUILD_ID = '[0-9A-Za-z-]+';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?$`);
const MAX_LENGTH = 256;

export function parse(input: string): SemVer {
  if (typeof input !== 'string') throw new InvalidVersion(String(input), 'not text');
  if (input.length > MAX_LENGTH) throw new InvalidVersion(input.slice(0, 20) + '...', `longer than ${MAX_LENGTH} characters`);
  const m = SEMVER.exec(input);
  if (!m) throw new InvalidVersion(input, 'expected MAJOR.MINOR.PATCH with optional -prerelease and +build, no leading zeros');
  const nums = [m[1]!, m[2]!, m[3]!].map(Number);
  for (const n of nums) if (!Number.isSafeInteger(n)) throw new InvalidVersion(input, 'a number is too large');
  const prerelease = m[4] === undefined ? [] : m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  for (const p of prerelease) if (typeof p === 'number' && !Number.isSafeInteger(p)) throw new InvalidVersion(input, 'a prerelease number is too large');
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease, build: m[5] === undefined ? [] : m[5].split('.') };
}

export function isValid(input: string): boolean {
  try {
    parse(input);
    return true;
  } catch {
    return false;
  }
}

export function format(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? '-' + v.prerelease.join('.') : ''}${v.build.length ? '+' + v.build.join('.') : ''}`;
}

const asV = (v: string | SemVer): SemVer => (typeof v === 'string' ? parse(v) : v);

function compareId(a: string | number, b: string | number): number {
  const an = typeof a === 'number';
  const bn = typeof b === 'number';
  if (an && bn) return a < b ? -1 : a > b ? 1 : 0;
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1, 0 or 1 by SemVer precedence. Build metadata does not count. */
export function compare(a: string | SemVer, b: string | SemVer): -1 | 0 | 1 {
  const x = asV(a);
  const y = asV(b);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.prerelease.length && !y.prerelease.length) return 0;
  if (!x.prerelease.length) return 1;
  if (!y.prerelease.length) return -1;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = compareId(p, q);
    if (c) return c as -1 | 1;
  }
  return 0;
}

export const gt = (a: string | SemVer, b: string | SemVer) => compare(a, b) > 0;
export const lt = (a: string | SemVer, b: string | SemVer) => compare(a, b) < 0;
export const eq = (a: string | SemVer, b: string | SemVer) => compare(a, b) === 0;

export function sort(list: readonly string[]): string[] {
  return [...list].sort((a, b) => compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}
export function rsort(list: readonly string[]): string[] {
  return sort(list).reverse();
}

export type Release = 'major' | 'minor' | 'patch' | 'prerelease';

/** The next version. `prerelease` bumps the last numeric identifier, or starts `-<id>.0`. */
export function inc(v: string | SemVer, release: Release, id = 'rc'): string {
  const x = asV(v);
  if (release === 'major') return `${x.major + 1}.0.0`;
  if (release === 'minor') return `${x.major}.${x.minor + 1}.0`;
  if (release === 'patch') return x.prerelease.length ? `${x.major}.${x.minor}.${x.patch}` : `${x.major}.${x.minor}.${x.patch + 1}`;
  if (!/^[0-9A-Za-z-]+$/.test(id)) throw new InvalidVersion(id, 'a prerelease label is letters, digits and hyphens');
  if (!x.prerelease.length) return `${x.major}.${x.minor}.${x.patch + 1}-${id}.0`;
  const pre = [...x.prerelease];
  const last = pre.length - 1;
  if (typeof pre[last] === 'number') pre[last] = (pre[last] as number) + 1;
  else pre.push(0);
  return `${x.major}.${x.minor}.${x.patch}-${pre.join('.')}`;
}

export type Difference = 'major' | 'minor' | 'patch' | 'prerelease' | null;
export function diff(a: string | SemVer, b: string | SemVer): Difference {
  const x = asV(a);
  const y = asV(b);
  if (compare(x, y) === 0) return null;
  if (x.major !== y.major) return 'major';
  if (x.minor !== y.minor) return 'minor';
  if (x.patch !== y.patch) return 'patch';
  return 'prerelease';
}

// ---------------------------------------------------------------- ranges

export type Op = '<' | '<=' | '>' | '>=' | '=';
export interface Comparator {
  readonly op: Op;
  readonly version: SemVer;
}
export interface Range {
  readonly raw: string;
  /** Alternatives joined by `||`; each is a list of comparators that must all hold. */
  readonly sets: readonly (readonly Comparator[])[];
}

const mk = (major: number, minor: number, patch: number, prerelease: (string | number)[] = []): SemVer => ({ major, minor, patch, prerelease, build: [] });
const ANY: Comparator = { op: '>=', version: mk(0, 0, 0) };

interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
  pre: (string | number)[];
}

const X = /^(?:x|X|\*)$/;
function parsePartial(s: string, whole: string): Partial {
  const m = /^[vV]?(x|X|\*|0|[1-9]\d*)(?:\.(x|X|\*|0|[1-9]\d*)(?:\.(x|X|\*|0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$/.exec(s);
  if (!m) throw new InvalidRange(whole, `"${s}" is not a version or partial version`);
  const n = (t: string | undefined): number | null => {
    if (t === undefined || X.test(t)) return null;
    const v = Number(t);
    if (!Number.isSafeInteger(v)) throw new InvalidRange(whole, `${t} is too large`);
    return v;
  };
  const major = n(m[1]);
  const minor = major === null ? null : n(m[2]);
  const patch = minor === null ? null : n(m[3]);
  let pre: (string | number)[] = [];
  if (m[4] !== undefined && patch !== null) {
    const ids = m[4].split('.');
    for (const id of ids) if (!new RegExp(`^${PRE_ID}$`).test(id)) throw new InvalidRange(whole, `"${m[4]}" is not a prerelease`);
    pre = ids.map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  }
  return { major, minor, patch, pre };
}

const lower = (p: Partial): Comparator => ({ op: '>=', version: mk(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.pre) });

/** Upper bound just past a partial: 1 -> <2.0.0-0, 1.2 -> <1.3.0-0. Null when the partial is a wildcard. */
function below(p: Partial): Comparator | null {
  if (p.major === null) return null;
  if (p.minor === null) return { op: '<', version: mk(p.major + 1, 0, 0, [0]) };
  if (p.patch === null) return { op: '<', version: mk(p.major, p.minor + 1, 0, [0]) };
  return null;
}

function expand(token: string, whole: string): Comparator[] {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!m) throw new InvalidRange(whole, `cannot read "${token}"`);
  const op = m[1] ?? '';
  const p = parsePartial(m[2]!, whole);
  if (op === '^') {
    if (p.major === null) return [ANY];
    const lo = lower(p);
    const up: Comparator =
      p.major > 0 || p.minor === null ? { op: '<', version: mk(p.major + 1, 0, 0, [0]) }
      : p.minor > 0 || p.patch === null ? { op: '<', version: mk(0, p.minor + 1, 0, [0]) }
      : { op: '<', version: mk(0, 0, p.patch + 1, [0]) };
    return [lo, up];
  }
  if (op === '~' || op === '~>') {
    if (p.major === null) return [ANY];
    const lo = lower(p);
    const up: Comparator = p.minor === null ? { op: '<', version: mk(p.major + 1, 0, 0, [0]) } : { op: '<', version: mk(p.major, p.minor + 1, 0, [0]) };
    return [lo, up];
  }
  const full = p.major !== null && p.minor !== null && p.patch !== null;
  if (op === '' || op === '=') {
    if (p.major === null) return [ANY];
    if (full) return [{ op: '=', version: mk(p.major, p.minor!, p.patch!, p.pre) }];
    return [lower(p), below(p)!];
  }
  if (p.major === null) return op === '<' || op === '>' ? [{ op: '<', version: mk(0, 0, 0, [0]) }] : [ANY];
  if (op === '>') {
    if (full) return [{ op: '>', version: mk(p.major, p.minor!, p.patch!, p.pre) }];
    return [{ op: '>=', version: p.minor === null ? mk(p.major + 1, 0, 0) : mk(p.major, p.minor + 1, 0) }];
  }
  if (op === '>=') return [lower(p)];
  if (op === '<') return [{ op: '<', version: full ? mk(p.major, p.minor!, p.patch!, p.pre) : mk(p.major, p.minor ?? 0, 0, [0]) }];
  // <=
  return full ? [{ op: '<=', version: mk(p.major, p.minor!, p.patch!, p.pre) }] : [below(p)!];
}

export function parseRange(input: string): Range {
  if (typeof input !== 'string') throw new InvalidRange(String(input), 'not text');
  if (input.length > MAX_LENGTH * 4) throw new InvalidRange(input.slice(0, 20) + '...', 'too long');
  const sets: Comparator[][] = [];
  for (const alt of input.split('||')) {
    let s = alt.trim();
    // Hyphen ranges: "1.2.3 - 2.3.4"
    const h = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (h) {
      const a = parsePartial(h[1]!, input);
      const b = parsePartial(h[2]!, input);
      const hi = below(b) ?? (b.major === null ? null : { op: '<=' as const, version: mk(b.major, b.minor!, b.patch!, b.pre) });
      sets.push([a.major === null ? ANY : lower(a), ...(hi ? [hi] : [])]);
      continue;
    }
    // Glue "op version" pairs written with a space: ">= 1.2.3"
    s = s.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
    const tokens = s === '' ? ['*'] : s.split(/\s+/);
    const set: Comparator[] = [];
    for (const t of tokens) set.push(...expand(t, input));
    sets.push(set);
  }
  return { raw: input, sets };
}

export function validRange(input: string): boolean {
  try {
    parseRange(input);
    return true;
  } catch {
    return false;
  }
}

function test(c: Comparator, v: SemVer): boolean {
  const r = compare(v, c.version);
  switch (c.op) {
    case '<': return r < 0;
    case '<=': return r <= 0;
    case '>': return r > 0;
    case '>=': return r >= 0;
    default: return r === 0;
  }
}

export function satisfies(version: string | SemVer, range: string | Range, o: { includePrerelease?: boolean } = {}): boolean {
  const v = asV(version);
  const r = typeof range === 'string' ? parseRange(range) : range;
  return r.sets.some((set) => {
    if (!set.every((c) => test(c, v))) return false;
    if (v.prerelease.length && !o.includePrerelease)
      return set.some((c) => c.version.prerelease.length > 0 && c.version.major === v.major && c.version.minor === v.minor && c.version.patch === v.patch);
    return true;
  });
}

export function maxSatisfying(versions: readonly string[], range: string, o: { includePrerelease?: boolean } = {}): string | null {
  const r = parseRange(range);
  let best: string | null = null;
  for (const v of versions) if (satisfies(v, r, o) && (best === null || compare(v, best) > 0)) best = v;
  return best;
}

export function minSatisfying(versions: readonly string[], range: string, o: { includePrerelease?: boolean } = {}): string | null {
  const r = parseRange(range);
  let best: string | null = null;
  for (const v of versions) if (satisfies(v, r, o) && (best === null || compare(v, best) < 0)) best = v;
  return best;
}

// ---------------------------------------------------------------- solving

export interface Package {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}
export type Universe = Readonly<Record<string, readonly Package[]>>;

export interface Solution {
  readonly ok: true;
  /** One version of every package that is needed. */
  readonly chosen: Readonly<Record<string, string>>;
}
export interface Conflict {
  readonly ok: false;
  readonly package: string;
  readonly message: string;
  /** Who required which range of the package nothing could satisfy. */
  readonly requirements: readonly { readonly by: string; readonly range: string }[];
}

/**
 * Picks one version of each needed package so every constraint holds, newest first, backing up when a choice leads
 * nowhere. `roots` are what the application asks for. A missing package or an empty candidate list is a conflict
 * that names the package and every requirement on it.
 */
export function solve(universe: Universe, roots: Readonly<Record<string, string>>, o: { maxSteps?: number } = {}): Solution | Conflict {
  const maxSteps = o.maxSteps ?? 100_000;
  let steps = 0;
  let deepest: Conflict | null = null;
  type Req = { by: string; range: string };

  const go = (chosen: Map<string, string>, reqs: Map<string, Req[]>, pending: string[]): Map<string, string> | null => {
    if (++steps > maxSteps) throw new TooComplex(maxSteps);
    const name = pending.find((n) => !chosen.has(n));
    if (name === undefined) return chosen;
    const needs = reqs.get(name) ?? [];
    const ranges = needs.map((r) => ({ ...r, parsed: parseRange(r.range) }));
    const pool = universe[name] ?? [];
    const candidates = pool
      .filter((p) => ranges.every((r) => satisfies(p.version, r.parsed, { includePrerelease: false })))
      .sort((a, b) => compare(b.version, a.version));
    if (!candidates.length) {
      const why = pool.length ? `no version of ${name} satisfies ${needs.map((r) => `${r.range} (from ${r.by})`).join(' and ')}` : `${name} is not available`;
      deepest = { ok: false, package: name, message: why, requirements: needs };
      return null;
    }
    for (const c of candidates) {
      const nextReqs = new Map(reqs);
      const nextChosen = new Map(chosen);
      nextChosen.set(name, c.version);
      let bad = false;
      const nextPending = pending.filter((n) => n !== name);
      for (const [dep, range] of Object.entries(c.dependencies ?? {})) {
        const parsed = parseRange(range);
        const have = nextChosen.get(dep);
        const req = { by: `${name}@${c.version}`, range };
        nextReqs.set(dep, [...(nextReqs.get(dep) ?? []), req]);
        if (have !== undefined && !satisfies(have, parsed)) {
          deepest = { ok: false, package: dep, message: `${name}@${c.version} needs ${dep} ${range} but ${dep}@${have} is already chosen`, requirements: nextReqs.get(dep)! };
          bad = true;
          break;
        }
        if (have === undefined && !nextPending.includes(dep)) nextPending.push(dep);
      }
      if (bad) continue;
      const r = go(nextChosen, nextReqs, nextPending);
      if (r) return r;
    }
    return null;
  };

  const reqs = new Map<string, Req[]>();
  const pending: string[] = [];
  for (const [n, range] of Object.entries(roots)) {
    parseRange(range);
    reqs.set(n, [{ by: 'the application', range }]);
    pending.push(n);
  }
  const got = go(new Map(), reqs, pending);
  if (got) return { ok: true, chosen: Object.fromEntries([...got].sort(([a], [b]) => (a < b ? -1 : 1))) };
  return deepest ?? { ok: false, package: '', message: 'no solution', requirements: [] };
}

// ---------------------------------------------------------------- calendar versions

export type CalverToken = 'YYYY' | 'YY' | '0Y' | 'MM' | '0M' | 'WW' | '0W' | 'DD' | '0D' | 'MAJOR' | 'MINOR' | 'MICRO';
const CAL_TOKENS: readonly CalverToken[] = ['YYYY', 'YY', '0Y', 'MM', '0M', 'WW', '0W', 'DD', '0D', 'MAJOR', 'MINOR', 'MICRO'];

export interface Calver {
  readonly format: string;
  readonly parts: readonly number[];
}

/** A calendar version scheme such as `YYYY.0M.MICRO` or `YY.MM.DD`. */
export function calver(format: string) {
  const tokens = format.split('.');
  for (const t of tokens) if (!CAL_TOKENS.includes(t as CalverToken)) throw new InvalidRange(format, `"${t}" is not a calendar token (${CAL_TOKENS.join(', ')})`);
  const zero = (t: string) => t.startsWith('0');
  const parseOne = (input: string): Calver => {
    const segs = input.split('.');
    if (segs.length !== tokens.length) throw new InvalidVersion(input, `expected ${tokens.length} parts like ${format}`);
    const parts = segs.map((s, i) => {
      const t = tokens[i]! as CalverToken;
      if (!/^\d+$/.test(s)) throw new InvalidVersion(input, `${t} must be digits`);
      if (zero(t) ? s.length !== 2 : s.length > 1 && s.startsWith('0')) throw new InvalidVersion(input, zero(t) ? `${t} is two digits` : `${t} has a leading zero`);
      if (t === 'YYYY' && s.length !== 4) throw new InvalidVersion(input, 'YYYY is four digits');
      const n = Number(s);
      if (!Number.isSafeInteger(n)) throw new InvalidVersion(input, `${t} is too large`);
      if ((t === 'MM' || t === '0M') && (n < 1 || n > 12)) throw new InvalidVersion(input, `${n} is not a month`);
      if ((t === 'DD' || t === '0D') && (n < 1 || n > 31)) throw new InvalidVersion(input, `${n} is not a day`);
      if ((t === 'WW' || t === '0W') && (n < 0 || n > 53)) throw new InvalidVersion(input, `${n} is not a week`);
      return n;
    });
    // A full date must exist.
    const at = (names: CalverToken[]) => tokens.findIndex((t) => (names as string[]).includes(t));
    const yi = at(['YYYY', 'YY', '0Y']);
    const mi = at(['MM', '0M']);
    const di = at(['DD', '0D']);
    if (yi >= 0 && mi >= 0 && di >= 0) {
      const y = parts[yi]! + (tokens[yi] === 'YYYY' ? 0 : 2000);
      const d = new Date(Date.UTC(y, parts[mi]! - 1, parts[di]!));
      if (d.getUTCMonth() !== parts[mi]! - 1) throw new InvalidVersion(input, 'that date does not exist');
    }
    return { format, parts };
  };
  return {
    parse: parseOne,
    compare(a: string, b: string): -1 | 0 | 1 {
      const x = parseOne(a).parts;
      const y = parseOne(b).parts;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
      return 0;
    },
    /** The version for a day: the date parts filled in, the counter parts at `counter` (default 0). */
    forDate(d: Date, counter = 0): string {
      const y = d.getUTCFullYear();
      const pad = (n: number) => String(n).padStart(2, '0');
      return tokens
        .map((t) => {
          switch (t as CalverToken) {
            case 'YYYY': return String(y);
            case 'YY': return String(y - 2000);
            case '0Y': return pad(y % 100);
            case 'MM': return String(d.getUTCMonth() + 1);
            case '0M': return pad(d.getUTCMonth() + 1);
            case 'DD': return String(d.getUTCDate());
            case '0D': return pad(d.getUTCDate());
            case 'WW': case '0W': throw new InvalidVersion(format, 'week tokens cannot be filled from a date here');
            default: return String(counter);
          }
        })
        .join('.');
    },
  };
}
