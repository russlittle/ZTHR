/**
 * Seeded property testing for the fuzz suite. Every case draws from its own generator, seeded from the suite seed
 * and the case number, so one failing case can be replayed alone:
 *
 *   FUZZ_SEED=<seed> FUZZ_CASE=<n> node --test test/fuzz/<file>.test.ts
 *
 * FUZZ_SEED changes the seed for a whole run; FUZZ_CASES scales the number of cases (a multiplier, default 1).
 * On failure the error names the property, seed, case and the input (shrunk where a shrinker applies), so the
 * message alone is enough to reproduce. Properties that might loop run in a worker with a deadline, reporting
 * each input before trying it, so a hang is reported with the input that caused it.
 */
import { Worker } from 'node:worker_threads';
import { rng } from '../../blocks/testdata/index.ts';

export const SEED = Number(process.env['FUZZ_SEED'] ?? 20261127);
const ONLY = process.env['FUZZ_CASE'] === undefined ? undefined : Number(process.env['FUZZ_CASE']);
const SCALE = Number(process.env['FUZZ_CASES'] ?? 1);

/** A seed for case `i` of a property: distinct per property name, stable across runs. */
export function caseSeed(seed: number, name: string, i: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const c of `${name}#${i}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export class Rand {
  readonly r: () => number;
  constructor(seed: number) {
    this.r = rng(seed);
  }
  next(): number {
    return this.r();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.r() * (max - min + 1));
  }
  bool(p = 0.5): boolean {
    return this.r() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.r() * list.length)]!;
  }
  array<T>(min: number, max: number, f: (i: number) => T): T[] {
    return Array.from({ length: this.int(min, max) }, (_, i) => f(i));
  }
  bytes(min: number, max: number): Buffer {
    const b = Buffer.alloc(this.int(min, max));
    for (let i = 0; i < b.length; i++) b[i] = this.int(0, 255);
    return b;
  }
  /** A string from an alphabet of pieces (each piece may be several characters). */
  str(min: number, max: number, alphabet: readonly string[]): string {
    let s = '';
    const n = this.int(min, max);
    for (let i = 0; i < n; i++) s += this.pick(alphabet);
    return s;
  }
  /** Any code point, surrogates excluded, weighted toward ASCII. */
  char(): string {
    const k = this.r();
    if (k < 0.6) return String.fromCharCode(this.int(0, 127));
    if (k < 0.85) return String.fromCharCode(this.int(0x80, 0xd7ff));
    if (k < 0.95) return String.fromCharCode(this.int(0xe000, 0xfffd));
    return String.fromCodePoint(this.int(0x10000, 0x10ffff));
  }
  text(min: number, max: number): string {
    let s = '';
    const n = this.int(min, max);
    for (let i = 0; i < n; i++) s += this.char();
    return s;
  }
  /** Flip, set, insert or delete a few bytes. */
  mutate(b: Buffer, edits = this.int(1, 4)): Buffer {
    let out = Buffer.from(b);
    for (let e = 0; e < edits; e++) {
      const at = out.length ? this.int(0, out.length - 1) : 0;
      const k = this.int(0, 5);
      if (k === 0 && out.length) out[at] = out[at]! ^ (1 << this.int(0, 7));
      else if (k === 1 && out.length) out[at] = this.pick([0, 1, 0xff, 0x7f, 0x80, this.int(0, 255)]);
      else if (k === 2) out = Buffer.concat([out.subarray(0, at), Buffer.from([this.int(0, 255)]), out.subarray(at)]);
      else if (k === 3 && out.length) out = Buffer.concat([out.subarray(0, at), out.subarray(at + 1)]);
      else if (k === 4 && out.length) out = out.subarray(0, this.int(0, out.length));
      else if (out.length >= at + 4) out.writeUInt32LE(this.pick([0, 0xffffffff, 0x7fffffff, this.int(0, 0xffffffff)]), at);
    }
    return out;
  }
}

/** A readable, bounded rendering of an input for a failure message. */
export function show(x: unknown, max = 600): string {
  const s = JSON.stringify(x, (_k, v: unknown) => {
    if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'Buffer' && Array.isArray((v as { data?: unknown }).data)) return `<hex ${Buffer.from((v as { data: number[] }).data).toString('hex')}>`;
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()})`;
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    return v;
  });
  const t = s === undefined ? String(x) : s;
  return t.length > max ? `${t.slice(0, max)}… (${t.length} chars)` : t;
}

/** Smaller versions of an input: drop halves, chunks and single elements of strings, arrays and buffers. */
export function shrinkDefault(x: unknown): unknown[] {
  const cut = <T extends { length: number; slice(a: number, b?: number): T }>(v: T, join: (a: T, b: T) => T): T[] => {
    const out: T[] = [];
    for (let size = Math.max(1, v.length >> 1); size >= 1; size = size >> 1) {
      for (let at = 0; at + size <= v.length; at += size) out.push(join(v.slice(0, at), v.slice(at + size)));
      if (size === 1) break;
    }
    return out;
  };
  if (typeof x === 'string') return cut(x, (a, b) => a + b);
  if (Buffer.isBuffer(x)) return cut(x, (a, b) => Buffer.concat([a, b]));
  if (Array.isArray(x)) {
    const smaller: unknown[] = cut(x, (a, b) => [...a, ...b]);
    x.forEach((el, i) => {
      for (const s of shrinkDefault(el).slice(0, 8)) smaller.push(x.map((y, j) => (j === i ? s : y)));
    });
    return smaller;
  }
  return [];
}

export interface Property<T> {
  readonly cases: number;
  readonly gen: (r: Rand, i: number) => T;
  /** Throws (any error) when the property does not hold. */
  readonly check: (x: T) => void | Promise<void>;
  /** Candidates smaller than x; defaults to shrinkDefault. Pass () => [] to disable. */
  readonly shrink?: (x: T) => T[];
  /** Shrunk candidates must pass this to be tried (keeps shrinking inside the input domain). */
  readonly valid?: (x: T) => boolean;
  readonly seed?: number;
}

export class PropertyFailure extends Error {}

const fails = async <T>(check: (x: T) => void | Promise<void>, x: T): Promise<unknown> => {
  try {
    await check(x);
    return undefined;
  } catch (e) {
    return e ?? new Error('threw a nullish value');
  }
};

/** Runs a property over seeded cases; throws PropertyFailure with seed, case, input and the original error. */
export async function forAll<T>(name: string, p: Property<T>): Promise<void> {
  const seed = p.seed ?? SEED;
  const cases = Math.max(1, Math.round(p.cases * SCALE));
  for (let i = ONLY ?? 0; i < (ONLY === undefined ? cases : ONLY + 1); i++) {
    const x = p.gen(new Rand(caseSeed(seed, name, i)), i);
    let err = await fails(p.check, x);
    if (err === undefined) continue;
    let small = x;
    const shrink = p.shrink ?? ((v: T) => shrinkDefault(v) as T[]);
    for (let budget = 400, progress = true; progress && budget > 0; ) {
      progress = false;
      for (const c of shrink(small)) {
        if (p.valid && !p.valid(c)) continue;
        if (--budget <= 0) break;
        const e = await fails(p.check, c);
        if (e !== undefined) {
          small = c;
          err = e;
          progress = true;
          break;
        }
      }
    }
    const why = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    throw new PropertyFailure(`property "${name}" failed\n  seed: ${seed}  case: ${i}  (replay: FUZZ_SEED=${seed} FUZZ_CASE=${i})\n  input: ${show(x)}\n  shrunk: ${show(small)}\n  error: ${why.slice(0, 800)}`, { cause: err });
  }
}

export interface Bounded {
  /** A module exporting the job: `export function <fn>(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void`. */
  readonly module: URL;
  readonly fn: string;
  readonly cases: number;
  /** The whole job's deadline in ms; a hang shows up as a timeout naming the last input reported. */
  readonly ms: number;
  readonly seed?: number;
}

/** Runs a job in a worker so an infinite loop is caught and reported with the input that caused it. */
export function bounded(b: Bounded): Promise<void> {
  const seed = b.seed ?? SEED;
  const cases = Math.max(1, Math.round(b.cases * SCALE));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { module: b.module.href, fn: b.fn, seed, cases, only: ONLY } });
    let last: { i: number; input: string } | undefined;
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new PropertyFailure(`"${b.fn}" did not finish within ${b.ms} ms (a hang or super-linear time)\n  seed: ${seed}  case: ${last?.i ?? '?'}  (replay: FUZZ_SEED=${seed} FUZZ_CASE=${last?.i ?? 0})\n  input: ${last?.input ?? '(none reported)'}`));
    }, b.ms);
    w.on('message', (m: { kind: 'at'; i: number; input: string } | { kind: 'done' } | { kind: 'fail'; message: string }) => {
      if (m.kind === 'at') last = { i: m.i, input: m.input };
      else if (m.kind === 'done') clearTimeout(timer), resolve();
      else clearTimeout(timer), reject(new PropertyFailure(m.message));
    });
    w.on('error', (e) => (clearTimeout(timer), reject(e)));
    w.on('exit', (code) => {
      if (code !== 0) clearTimeout(timer), reject(new PropertyFailure(`worker for "${b.fn}" exited with ${code}; last input: ${last?.input ?? '(none)'}`));
    });
  });
}

/** For bounded jobs: run cases in the worker, reporting each input first, failing with seed and input. */
export function runCases<T>(name: string, seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void, gen: (r: Rand, i: number) => T, check: (x: T) => void): void {
  for (let i = only ?? 0; i < (only === undefined ? cases : only + 1); i++) {
    const x = gen(new Rand(caseSeed(seed, name, i)), i);
    report(i, x);
    try {
      check(x);
    } catch (e) {
      const why = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
      throw new PropertyFailure(`property "${name}" failed\n  seed: ${seed}  case: ${i}  (replay: FUZZ_SEED=${seed} FUZZ_CASE=${i})\n  input: ${show(x)}\n  error: ${why.slice(0, 800)}`);
    }
  }
}

/** Asserts fn finishes within ms of wall time (for super-linear, not infinite, slowness). */
export function within<T>(ms: number, what: string, fn: () => T): T {
  const t = performance.now();
  const out = fn();
  const took = performance.now() - t;
  if (took > ms) throw new Error(`${what} took ${took.toFixed(0)} ms (limit ${ms} ms)`);
  return out;
}
