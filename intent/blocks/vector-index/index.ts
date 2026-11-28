/**
 * Nearest-neighbour search over vectors: exact (flat) and approximate (HNSW, after Malkov and Yashunin, 2016),
 * cosine, dot product and Euclidean distance, metadata filters, optional 8-bit quantisation of what is stored,
 * and saving to and loading from bytes.
 *
 * Scores. `score` is always higher-is-better: cosine similarity (vectors are normalised on the way in, so a zero
 * vector is refused), the dot product, or minus the Euclidean distance. Ties are broken by id so results are the
 * same every time. Vectors must be finite numbers of the index's dimension.
 *
 * HNSW. A layered graph of links, built with a level for each vector drawn from an injected random function (so a
 * build is repeatable), the neighbour-selection heuristic that keeps links diverse, and a search that takes `ef`
 * (width) as an argument. Removing a vector leaves it in the graph as a stepping stone, hidden from results, until
 * `compact` rebuilds the index without them; putting a vector with an existing id removes the old one the same way.
 * With a filter, the search walks the graph and only counts what passes; when the filter lets through very little
 * (estimated from a sample) or the walk finds too few, it scans exactly instead, so a filtered query still returns
 * the true best matches.
 *
 * Filters are JSON: `{ colour: "red", year: { $gte: 2020 }, $or: [ ... ], $not: { ... } }` with $eq, $ne, $gt,
 * $gte, $lt, $lte, $in, $nin and $exists, over flat metadata of strings, numbers, booleans and null; a malformed
 * filter is refused, not guessed at.
 *
 * Quantisation. With `store: "int8"` each vector is kept as bytes with its own minimum and step, a quarter of the
 * memory; scores are approximate (each component is off by at most half a step) and rankings very close to exact.
 *
 * Persistence. `save` writes a versioned binary form ending in a SHA-256 digest; `load` checks the magic, version,
 * every length and every index against the header and the limits you pass, and the digest, before it builds anything,
 * so damaged or hostile bytes are refused with a clear message.
 *
 * Out of scope: disk-backed or sharded indexes, product quantisation, concurrent writers (callers serialise
 * writes), and text embedding (see the embeddings block).
 */
import { createHash } from 'node:crypto';

export class VectorError extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class CorruptIndex extends Error {
  constructor(why: string) {
    super(`the saved index cannot be read: ${why}`);
  }
}

export type Metric = 'cosine' | 'dot' | 'l2';
export type Value = string | number | boolean | null;
export type Metadata = Readonly<Record<string, Value>>;
export type Primitive = string | number | boolean | null;
export type Operators = {
  readonly $eq?: Primitive;
  readonly $ne?: Primitive;
  readonly $gt?: number | string;
  readonly $gte?: number | string;
  readonly $lt?: number | string;
  readonly $lte?: number | string;
  readonly $in?: readonly Primitive[];
  readonly $nin?: readonly Primitive[];
  readonly $exists?: boolean;
};
export type Filter = { readonly $and?: readonly Filter[]; readonly $or?: readonly Filter[]; readonly $not?: Filter } & { readonly [field: string]: Primitive | Operators | readonly Filter[] | Filter | undefined };

export interface IndexOptions {
  readonly dim: number;
  readonly metric?: Metric;
  readonly kind?: 'flat' | 'hnsw';
  readonly store?: 'float32' | 'int8';
  /** HNSW links per node on upper layers (default 16); layer 0 holds twice as many. */
  readonly m?: number;
  /** HNSW candidate width while building (default 100). */
  readonly efConstruction?: number;
  /** Source of randomness for levels, in [0, 1). */
  readonly random?: () => number;
  readonly maxDim?: number;
  readonly maxVectors?: number;
}

export interface SearchOptions {
  readonly k?: number;
  readonly filter?: Filter;
  /** HNSW candidate width (default max(k, 64)). Larger is slower and closer to exact. */
  readonly ef?: number;
  /** Only results scoring at least this. */
  readonly minScore?: number;
  /** Scan everything even on an HNSW index. */
  readonly exact?: boolean;
}

export interface Hit {
  readonly id: string;
  readonly score: number;
  readonly metadata: Metadata;
}

const MAX_K = 10_000;
const ID_MAX = 512;

// ---------------------------------------------------------------------------------------------------------------
// Filters

const OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists']);
const isPrim = (v: unknown): v is Primitive => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

type Test = (m: Metadata) => boolean;

/** Compiles a filter into a test, refusing anything malformed. */
export function compileFilter(f: unknown, depth = 0): Test {
  if (depth > 8) throw new VectorError('the filter is nested too deeply');
  if (typeof f !== 'object' || f === null || Array.isArray(f)) throw new VectorError('a filter is an object');
  const tests: Test[] = [];
  for (const [key, val] of Object.entries(f)) {
    if (key === '__proto__') throw new VectorError('not a field name');
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(val) || val.length === 0 || val.length > 100) throw new VectorError(`${key} needs a list of 1 to 100 filters`);
      const subs = val.map((x) => compileFilter(x, depth + 1));
      tests.push(key === '$and' ? (m) => subs.every((t) => t(m)) : (m) => subs.some((t) => t(m)));
    } else if (key === '$not') {
      const sub = compileFilter(val, depth + 1);
      tests.push((m) => !sub(m));
    } else if (key.startsWith('$')) throw new VectorError(`unknown operator ${key}`);
    else if (isPrim(val)) tests.push((m) => Object.hasOwn(m, key) && m[key] === val);
    else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const ops = Object.entries(val);
      if (!ops.length) throw new VectorError(`no condition for ${key}`);
      for (const [op, arg] of ops) {
        if (!OPS.has(op)) throw new VectorError(`unknown operator ${op}`);
        tests.push(compileOp(key, op, arg));
      }
    } else throw new VectorError(`the condition for ${key} is not a value or a set of operators`);
  }
  return (m) => tests.every((t) => t(m));
}

function compileOp(key: string, op: string, arg: unknown): Test {
  const has = (m: Metadata) => Object.hasOwn(m, key);
  const cmp = (a: Value | undefined, b: number | string): number | undefined => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    return undefined;
  };
  switch (op) {
    case '$eq':
      if (!isPrim(arg)) throw new VectorError('$eq needs a value');
      return (m) => has(m) && m[key] === arg;
    case '$ne':
      if (!isPrim(arg)) throw new VectorError('$ne needs a value');
      return (m) => !has(m) || m[key] !== arg;
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte': {
      if (typeof arg !== 'string' && !(typeof arg === 'number' && Number.isFinite(arg))) throw new VectorError(`${op} needs a number or a string`);
      return (m) => {
        const c = has(m) ? cmp(m[key], arg) : undefined;
        if (c === undefined) return false;
        return op === '$gt' ? c > 0 : op === '$gte' ? c >= 0 : op === '$lt' ? c < 0 : c <= 0;
      };
    }
    case '$in':
    case '$nin': {
      if (!Array.isArray(arg) || arg.length > 1000 || !arg.every(isPrim)) throw new VectorError(`${op} needs a list of up to 1000 values`);
      const set = new Set<Primitive>(arg);
      return op === '$in' ? (m) => has(m) && set.has(m[key]!) : (m) => !has(m) || !set.has(m[key]!);
    }
    default:
      if (typeof arg !== 'boolean') throw new VectorError('$exists needs true or false');
      return (m) => has(m) === arg;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Heaps

class Heap {
  private readonly a: { d: number; i: number }[] = [];
  private readonly less: (x: { d: number; i: number }, y: { d: number; i: number }) => boolean;
  /** `rank` orders equal distances (by id, so that which of several equal vectors is kept never depends on insertion order). */
  constructor(max: boolean, rank: (i: number) => string | number = (i) => i) {
    this.less = max ? (x, y) => x.d > y.d || (x.d === y.d && rank(x.i) > rank(y.i)) : (x, y) => x.d < y.d || (x.d === y.d && rank(x.i) < rank(y.i));
  }
  get size() {
    return this.a.length;
  }
  peek() {
    return this.a[0]!;
  }
  push(d: number, i: number) {
    const a = this.a;
    a.push({ d, i });
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.less(a[c]!, a[p]!)) break;
      [a[c], a[p]] = [a[p]!, a[c]!];
      c = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let s = p;
        if (l < a.length && this.less(a[l]!, a[s]!)) s = l;
        if (r < a.length && this.less(a[r]!, a[s]!)) s = r;
        if (s === p) break;
        [a[s], a[p]] = [a[p]!, a[s]!];
        p = s;
      }
    }
    return top;
  }
  toArray() {
    return [...this.a];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The index

interface Params {
  dim: number;
  metric: Metric;
  kind: 'flat' | 'hnsw';
  store: 'float32' | 'int8';
  m: number;
  efConstruction: number;
}

const MAGIC = [0x56, 0x49, 0x58, 0x31]; // "VIX1"
const VERSION = 1;
const DIGEST = 16;

export class VectorIndex {
  readonly dim: number;
  readonly metric: Metric;
  readonly kind: 'flat' | 'hnsw';
  readonly store: 'float32' | 'int8';
  private readonly m: number;
  private readonly efConstruction: number;
  private readonly random: () => number;
  private readonly maxDim: number;
  private readonly maxVectors: number;
  private readonly ids: string[] = [];
  private readonly meta: Metadata[] = [];
  private readonly deleted: boolean[] = [];
  private readonly vecs: (Float32Array | Uint8Array)[] = [];
  private readonly mins: number[] = [];
  private readonly steps: number[] = [];
  private readonly byId = new Map<string, number>();
  private readonly levels: number[] = [];
  private readonly links: number[][][] = [];
  private entry = -1;
  private liveCount = 0;
  private readonly mL: number;

  constructor(o: IndexOptions) {
    this.maxDim = o.maxDim ?? 4096;
    this.maxVectors = o.maxVectors ?? 5_000_000;
    if (!Number.isInteger(o.dim) || o.dim < 1 || o.dim > this.maxDim) throw new VectorError(`the dimension must be a whole number from 1 to ${this.maxDim}`);
    this.dim = o.dim;
    this.metric = o.metric ?? 'cosine';
    if (!['cosine', 'dot', 'l2'].includes(this.metric)) throw new VectorError(`unknown metric ${String(this.metric)}`);
    this.kind = o.kind ?? 'flat';
    if (this.kind !== 'flat' && this.kind !== 'hnsw') throw new VectorError(`unknown kind ${String(this.kind)}`);
    this.store = o.store ?? 'float32';
    if (this.store !== 'float32' && this.store !== 'int8') throw new VectorError(`unknown store ${String(this.store)}`);
    this.m = o.m ?? 16;
    this.efConstruction = o.efConstruction ?? 100;
    if (!Number.isInteger(this.m) || this.m < 2 || this.m > 128) throw new VectorError('m must be a whole number from 2 to 128');
    if (!Number.isInteger(this.efConstruction) || this.efConstruction < this.m || this.efConstruction > 10_000) throw new VectorError('efConstruction must be a whole number from m to 10000');
    this.random = o.random ?? Math.random;
    this.mL = 1 / Math.log(this.m);
  }

  /** Vectors that can be returned. */
  get size(): number {
    return this.liveCount;
  }
  /** Vectors held including removed ones still in the graph. */
  get stored(): number {
    return this.ids.length;
  }
  has(id: string): boolean {
    const i = this.byId.get(id);
    return i !== undefined && !this.deleted[i];
  }

  stats(): { live: number; removed: number; kind: string; metric: Metric; store: string; maxLevel: number; bytes: number } {
    let bytes = 0;
    for (const v of this.vecs) bytes += v.byteLength;
    return { live: this.liveCount, removed: this.ids.length - this.liveCount, kind: this.kind, metric: this.metric, store: this.store, maxLevel: this.entry < 0 ? -1 : this.levels[this.entry]!, bytes: bytes + this.mins.length * 8 };
  }

  // --- vectors ---------------------------------------------------------------------------------------------------

  private clean(v: ArrayLike<number>): Float32Array {
    if (!v || v.length !== this.dim) throw new VectorError(`a vector has ${this.dim} numbers, not ${v?.length}`);
    const out = new Float32Array(this.dim);
    let norm = 0;
    for (let i = 0; i < this.dim; i++) {
      const x = v[i]!;
      if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 1e30) throw new VectorError('a vector holds only finite numbers');
      out[i] = x;
      norm += x * x;
    }
    if (this.metric === 'cosine') {
      if (norm === 0) throw new VectorError('a zero vector has no direction, so cosine similarity is undefined');
      const n = Math.sqrt(norm);
      for (let i = 0; i < this.dim; i++) out[i] = out[i]! / n;
    }
    return out;
  }

  private keep(v: Float32Array): { vec: Float32Array | Uint8Array; min: number; step: number } {
    if (this.store === 'float32') return { vec: v, min: 0, step: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of v) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    // The range is kept as 32-bit floats (it is saved that way), and the codes are made against those exact values.
    const min = Math.fround(lo);
    const step = hi > lo ? Math.fround((hi - lo) / 255) : 0;
    const codes = new Uint8Array(this.dim);
    if (step > 0) for (let i = 0; i < this.dim; i++) codes[i] = Math.max(0, Math.min(255, Math.round((v[i]! - min) / step)));
    return { vec: codes, min, step };
  }

  private vec(i: number, into?: Float32Array): Float32Array {
    const s = this.vecs[i]!;
    if (s instanceof Float32Array) return s;
    const out = into ?? new Float32Array(this.dim);
    const lo = this.mins[i]!;
    const st = this.steps[i]!;
    for (let k = 0; k < this.dim; k++) out[k] = lo + s[k]! * st;
    return out;
  }

  /** The stored vector as it is held (normalised for cosine, and rounded if quantised). */
  get(id: string): { vector: Float32Array; metadata: Metadata } | undefined {
    const i = this.byId.get(id);
    if (i === undefined || this.deleted[i]) return undefined;
    return { vector: Float32Array.from(this.vec(i)), metadata: this.meta[i]! };
  }

  /** Distance for the graph: smaller is closer. */
  private distVec(a: Float32Array, b: Float32Array): number {
    let s = 0;
    if (this.metric === 'l2') {
      for (let i = 0; i < this.dim; i++) {
        const d = a[i]! - b[i]!;
        s += d * d;
      }
      return s;
    }
    for (let i = 0; i < this.dim; i++) s += a[i]! * b[i]!;
    return -s;
  }

  private distTo(q: Float32Array, qSum: number, i: number): number {
    const s = this.vecs[i]!;
    if (s instanceof Float32Array) return this.distVec(q, s);
    // Quantised: x = min + code * step, so q.x = min * sum(q) + step * q.code, and |q-x|^2 expands the same way.
    const lo = this.mins[i]!;
    const st = this.steps[i]!;
    if (this.metric === 'l2') {
      let t = 0;
      for (let k = 0; k < this.dim; k++) {
        const d = q[k]! - (lo + s[k]! * st);
        t += d * d;
      }
      return t;
    }
    let dotc = 0;
    for (let k = 0; k < this.dim; k++) dotc += q[k]! * s[k]!;
    return -(lo * qSum + st * dotc);
  }

  private scoreOf(d: number): number {
    return this.metric === 'l2' ? -Math.sqrt(Math.max(0, d)) : -d;
  }

  // --- changes ---------------------------------------------------------------------------------------------------

  /** Adds a vector, or replaces the one with this id. */
  put(id: string, vector: ArrayLike<number>, metadata: Metadata = {}): void {
    if (typeof id !== 'string' || id === '' || id.length > ID_MAX) throw new VectorError(`an id is 1 to ${ID_MAX} characters`);
    const md = cleanMetadata(metadata);
    const v = this.clean(vector);
    const old = this.byId.get(id);
    if (old === undefined && this.ids.length >= this.maxVectors) throw new VectorError(`an index holds at most ${this.maxVectors} vectors`);
    if (old !== undefined && !this.deleted[old]) {
      this.deleted[old] = true;
      this.liveCount--;
    }
    const n = this.ids.length;
    const k = this.keep(v);
    this.ids.push(id);
    this.meta.push(md);
    this.deleted.push(false);
    this.vecs.push(k.vec);
    this.mins.push(k.min);
    this.steps.push(k.step);
    this.byId.set(id, n);
    this.liveCount++;
    this.levels.push(0);
    this.links.push([[]]);
    if (this.kind === 'hnsw') this.insertGraph(n, v);
  }

  /** Removes a vector. It stays in the graph as a stepping stone until `compact`. Returns whether it was there. */
  delete(id: string): boolean {
    const i = this.byId.get(id);
    if (i === undefined || this.deleted[i]) return false;
    this.deleted[i] = true;
    this.liveCount--;
    this.byId.delete(id);
    return true;
  }

  /** A new index with only the vectors that can be returned, and a graph built fresh. */
  compact(random: () => number = this.random): VectorIndex {
    const out = new VectorIndex({ dim: this.dim, metric: this.metric, kind: this.kind, store: this.store, m: this.m, efConstruction: this.efConstruction, random, maxDim: this.maxDim, maxVectors: this.maxVectors });
    for (let i = 0; i < this.ids.length; i++) if (!this.deleted[i]) out.put(this.ids[i]!, this.vec(i), this.meta[i]!);
    return out;
  }

  // --- HNSW ------------------------------------------------------------------------------------------------------

  private maxLinks(level: number) {
    return level === 0 ? this.m * 2 : this.m;
  }

  /** Walks one layer from the entry points and returns the `ef` closest found, nearest first. */
  private layerSearch(q: Float32Array, qSum: number, entries: readonly number[], ef: number, level: number, accept?: (i: number) => boolean, budget = Infinity): { d: number; i: number }[] {
    const visited = new Set<number>(entries);
    const cand = new Heap(false);
    const best = new Heap(true);
    for (const e of entries) {
      const d = this.distTo(q, qSum, e);
      cand.push(d, e);
      if (!accept || accept(e)) best.push(d, e);
    }
    let seen = 0;
    while (cand.size) {
      const c = cand.pop();
      if (best.size >= ef && c.d > best.peek().d) break;
      for (const nb of this.links[c.i]![level] ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        if (++seen > budget) return sortHeap(best);
        const d = this.distTo(q, qSum, nb);
        if (best.size < ef || d < best.peek().d) {
          cand.push(d, nb);
          if (!accept || accept(nb)) {
            best.push(d, nb);
            if (best.size > ef) best.pop();
          }
        } else if (accept && !accept(nb) && cand.size < ef * 4) cand.push(d, nb);
      }
    }
    return sortHeap(best);
  }

  /** The neighbour-selection heuristic: take a candidate only if it is closer to the new node than to any already taken. */
  private select(cands: readonly { d: number; i: number }[], m: number): number[] {
    const out: { d: number; i: number }[] = [];
    const tmpA = new Float32Array(this.dim);
    const tmpB = new Float32Array(this.dim);
    for (const c of cands) {
      if (out.length >= m) break;
      const vc = this.vec(c.i, tmpA);
      let ok = true;
      for (const o of out) {
        if (this.distVec(vc, this.vec(o.i, tmpB)) < c.d) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(c);
    }
    // Fill up with the nearest left over, so a node is never left with too few links.
    for (const c of cands) {
      if (out.length >= m) break;
      if (!out.includes(c)) out.push(c);
    }
    return out.map((c) => c.i);
  }

  private insertGraph(n: number, v: Float32Array) {
    const level = Math.floor(-Math.log(1 - this.random()) * this.mL);
    const lvl = Math.min(level, 32);
    this.levels[n] = lvl;
    this.links[n] = Array.from({ length: lvl + 1 }, () => []);
    if (this.entry < 0) {
      this.entry = n;
      return;
    }
    const q = this.vec(n);
    const qSum = sum(q);
    let eps = [this.entry];
    for (let l = this.levels[this.entry]!; l > lvl; l--) eps = [this.layerSearch(q, qSum, eps, 1, l)[0]!.i];
    for (let l = Math.min(lvl, this.levels[this.entry]!); l >= 0; l--) {
      const found = this.layerSearch(q, qSum, eps, this.efConstruction, l).filter((c) => c.i !== n);
      const chosen = this.select(found, this.m);
      this.links[n]![l] = chosen;
      for (const nb of chosen) {
        const list = this.links[nb]![l]!;
        list.push(n);
        if (list.length > this.maxLinks(l)) {
          const vn = this.vec(nb);
          const scored = list.map((i) => ({ i, d: this.distVec(vn, this.vec(i)) })).sort((a, b) => a.d - b.d || a.i - b.i);
          this.links[nb]![l] = this.select(scored, this.maxLinks(l));
        }
      }
      eps = found.length ? found.map((c) => c.i) : eps;
    }
    if (lvl > this.levels[this.entry]!) this.entry = n;
    void v;
  }

  // --- search ----------------------------------------------------------------------------------------------------

  search(query: ArrayLike<number>, o: SearchOptions = {}): Hit[] {
    const k = o.k ?? 10;
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new VectorError(`k is a whole number from 1 to ${MAX_K}`);
    if (o.ef !== undefined && (!Number.isInteger(o.ef) || o.ef < 1 || o.ef > 100_000)) throw new VectorError('ef is a whole number from 1 to 100000');
    const q = this.clean(query);
    const test = o.filter === undefined ? undefined : compileFilter(o.filter);
    if (this.liveCount === 0) return [];
    const qSum = sum(q);
    const live = (i: number) => !this.deleted[i];
    const pass = (i: number) => live(i) && (test === undefined || test(this.meta[i]!));
    let found: { d: number; i: number }[] | undefined;
    if (this.kind === 'hnsw' && !o.exact && this.entry >= 0) {
      const ef = Math.max(o.ef ?? 64, k);
      let eps = [this.entry];
      for (let l = this.levels[this.entry]!; l > 0; l--) eps = [this.layerSearch(q, qSum, eps, 1, l)[0]!.i];
      if (test === undefined) {
        found = this.layerSearch(q, qSum, eps, ef, 0, live);
      } else if (this.selectivity(test) >= 0.02) {
        found = this.layerSearch(q, qSum, eps, ef, 0, pass, Math.max(ef * 40, 5000));
        if (found.length < Math.min(k, this.countMatching(test, k))) found = undefined;
      }
    }
    if (!found) {
      // Exact: the closest passing vectors out of everything.
      const best = new Heap(true, (i) => this.ids[i]!);
      const keep = k;
      for (let i = 0; i < this.ids.length; i++) {
        if (!pass(i)) continue;
        const d = this.distTo(q, qSum, i);
        if (best.size < keep || d < best.peek().d || (d === best.peek().d && this.ids[i]! < this.ids[best.peek().i]!)) {
          best.push(d, i);
          if (best.size > keep) best.pop();
        }
      }
      found = sortHeap(best);
    }
    const hits = found.map((c): Hit => ({ id: this.ids[c.i]!, score: this.scoreOf(c.d), metadata: this.meta[c.i]! }));
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const min = o.minScore;
    return (min === undefined ? hits : hits.filter((h) => h.score >= min)).slice(0, k);
  }

  /** The share of live vectors a filter lets through, from a sample. */
  private selectivity(test: Test): number {
    let seen = 0;
    let hit = 0;
    const step = Math.max(1, Math.floor(this.ids.length / 400));
    for (let i = 0; i < this.ids.length && seen < 400; i += step) {
      if (this.deleted[i]) continue;
      seen++;
      if (test(this.meta[i]!)) hit++;
    }
    return seen === 0 ? 0 : hit / seen;
  }

  private countMatching(test: Test, upTo: number): number {
    let n = 0;
    for (let i = 0; i < this.ids.length && n < upTo; i++) if (!this.deleted[i] && test(this.meta[i]!)) n++;
    return n;
  }

  // --- saving ----------------------------------------------------------------------------------------------------

  /** The index as bytes. */
  save(): Uint8Array {
    const n = this.ids.length;
    const header = {
      dim: this.dim,
      metric: this.metric,
      kind: this.kind,
      store: this.store,
      m: this.m,
      efConstruction: this.efConstruction,
      count: n,
      ids: this.ids,
      meta: this.meta,
      deleted: this.deleted.flatMap((d, i) => (d ? [i] : [])),
      levels: this.levels,
      entry: this.entry,
    };
    const head = Buffer.from(JSON.stringify(header), 'utf8');
    const vecBytes = this.store === 'float32' ? n * this.dim * 4 : n * (this.dim + 8);
    const graph: number[] = [];
    if (this.kind === 'hnsw') {
      for (let i = 0; i < n; i++) for (let l = 0; l <= this.levels[i]!; l++) {
        const list = this.links[i]![l]!;
        graph.push(list.length, ...list);
      }
    }
    const pad = (4 - ((12 + head.length) % 4)) % 4;
    const total = 12 + head.length + pad + vecBytes + graph.length * 4 + DIGEST;
    const buf = Buffer.alloc(total);
    Buffer.from(MAGIC).copy(buf, 0);
    buf.writeUInt32LE(VERSION, 4);
    buf.writeUInt32LE(head.length, 8);
    head.copy(buf, 12);
    let off = 12 + head.length + pad;
    for (let i = 0; i < n; i++) {
      const s = this.vecs[i]!;
      if (s instanceof Float32Array) {
        for (let k = 0; k < this.dim; k++, off += 4) buf.writeFloatLE(s[k]!, off);
      } else {
        buf.writeFloatLE(this.mins[i]!, off);
        buf.writeFloatLE(this.steps[i]!, off + 4);
        off += 8;
        Buffer.from(s.buffer, s.byteOffset, s.byteLength).copy(buf, off);
        off += this.dim;
      }
    }
    for (const g of graph) {
      buf.writeInt32LE(g, off);
      off += 4;
    }
    createHash('sha256').update(buf.subarray(0, off)).digest().subarray(0, DIGEST).copy(buf, off);
    return new Uint8Array(buf);
  }

  /** Reads an index saved by `save`, refusing anything damaged, oversized or inconsistent. */
  static load(bytes: Uint8Array, o: { random?: () => number; maxDim?: number; maxVectors?: number; maxBytes?: number } = {}): VectorIndex {
    const maxBytes = o.maxBytes ?? 2_000_000_000;
    if (bytes.length > maxBytes) throw new CorruptIndex(`larger than the limit of ${maxBytes} bytes`);
    if (bytes.length < 12 + DIGEST) throw new CorruptIndex('too short');
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!MAGIC.every((b, i) => buf[i] === b)) throw new CorruptIndex('this is not a saved vector index');
    if (buf.readUInt32LE(4) !== VERSION) throw new CorruptIndex(`version ${buf.readUInt32LE(4)} is not supported`);
    const digest = createHash('sha256').update(buf.subarray(0, buf.length - DIGEST)).digest().subarray(0, DIGEST);
    if (!digest.equals(buf.subarray(buf.length - DIGEST))) throw new CorruptIndex('the checksum does not match: the bytes were changed or cut off');
    const headLen = buf.readUInt32LE(8);
    if (headLen > buf.length - 12 - DIGEST) throw new CorruptIndex('the header is longer than the file');
    let h: Record<string, unknown>;
    try {
      h = JSON.parse(buf.subarray(12, 12 + headLen).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new CorruptIndex('the header is not valid');
    }
    const maxDim = o.maxDim ?? 4096;
    const maxVectors = o.maxVectors ?? 5_000_000;
    const int = (v: unknown, lo: number, hi: number, what: string): number => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new CorruptIndex(`${what} is out of range`);
      return v;
    };
    const dim = int(h.dim, 1, maxDim, 'the dimension');
    const count = int(h.count, 0, maxVectors, 'the count');
    const m = int(h.m, 2, 128, 'm');
    const efConstruction = int(h.efConstruction, m, 10_000, 'efConstruction');
    if (h.metric !== 'cosine' && h.metric !== 'dot' && h.metric !== 'l2') throw new CorruptIndex('the metric is unknown');
    if (h.kind !== 'flat' && h.kind !== 'hnsw') throw new CorruptIndex('the kind is unknown');
    if (h.store !== 'float32' && h.store !== 'int8') throw new CorruptIndex('the store is unknown');
    if (!Array.isArray(h.ids) || h.ids.length !== count || !h.ids.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= ID_MAX)) throw new CorruptIndex('the ids do not match the count');
    if (!Array.isArray(h.meta) || h.meta.length !== count) throw new CorruptIndex('the metadata does not match the count');
    if (!Array.isArray(h.levels) || h.levels.length !== count) throw new CorruptIndex('the levels do not match the count');
    if (!Array.isArray(h.deleted) || !h.deleted.every((x) => Number.isInteger(x) && x >= 0 && x < count)) throw new CorruptIndex('the removed list is not valid');
    const entry = int(h.entry, -1, Math.max(count - 1, -1), 'the entry point');
    const idx = new VectorIndex({ dim, metric: h.metric, kind: h.kind, store: h.store, m, efConstruction, ...(o.random ? { random: o.random } : {}), maxDim, maxVectors });
    const pad = (4 - ((12 + headLen) % 4)) % 4;
    let off = 12 + headLen + pad;
    const end = buf.length - DIGEST;
    const vecBytes = h.store === 'float32' ? count * dim * 4 : count * (dim + 8);
    if (off + vecBytes > end) throw new CorruptIndex('the vectors are cut off');
    const levels: number[] = [];
    for (let i = 0; i < count; i++) levels.push(int(h.levels[i], 0, 32, 'a level'));
    if (h.kind === 'hnsw' && count > 0 && (entry < 0 || levels[entry] !== Math.max(...levels))) throw new CorruptIndex('the entry point is not on the top layer');
    if (h.kind === 'flat' && levels.some((l) => l !== 0)) throw new CorruptIndex('a flat index has no layers');
    for (let i = 0; i < count; i++) {
      const id = (h.ids as string[])[i]!;
      const md = cleanMetadata((h.meta as Metadata[])[i]!);
      idx.ids.push(id);
      idx.meta.push(md);
      idx.deleted.push(false);
      if (h.store === 'float32') {
        const v = new Float32Array(dim);
        for (let k = 0; k < dim; k++, off += 4) {
          const x = buf.readFloatLE(off);
          if (!Number.isFinite(x)) throw new CorruptIndex('a vector holds a number that is not finite');
          v[k] = x;
        }
        idx.vecs.push(v);
        idx.mins.push(0);
        idx.steps.push(0);
      } else {
        const lo = buf.readFloatLE(off);
        const st = buf.readFloatLE(off + 4);
        if (!Number.isFinite(lo) || !Number.isFinite(st) || st < 0) throw new CorruptIndex('a quantised vector has a bad range');
        off += 8;
        idx.vecs.push(Uint8Array.from(buf.subarray(off, off + dim)));
        idx.mins.push(lo);
        idx.steps.push(st);
        off += dim;
      }
      idx.levels.push(levels[i]!);
      idx.links.push(Array.from({ length: levels[i]! + 1 }, () => []));
    }
    for (const d of h.deleted as number[]) idx.deleted[d] = true;
    if (h.kind === 'hnsw') {
      for (let i = 0; i < count; i++) {
        for (let l = 0; l <= levels[i]!; l++) {
          if (off + 4 > end) throw new CorruptIndex('the graph is cut off');
          const len = buf.readInt32LE(off);
          off += 4;
          if (len < 0 || len > idx.maxLinks(l) + 1 || off + len * 4 > end) throw new CorruptIndex('a link list is the wrong length');
          const list: number[] = [];
          for (let k = 0; k < len; k++, off += 4) {
            const nb = buf.readInt32LE(off);
            if (nb < 0 || nb >= count || nb === i || levels[nb]! < l) throw new CorruptIndex('a link points outside the graph');
            list.push(nb);
          }
          idx.links[i]![l] = list;
        }
      }
    }
    if (off !== end) throw new CorruptIndex('there is data left over after the graph');
    idx.entry = entry;
    for (let i = 0; i < count; i++) if (!idx.deleted[i]) idx.byId.set(idx.ids[i]!, i);
    idx.liveCount = count - new Set(h.deleted as number[]).size;
    if (idx.byId.size !== idx.liveCount) throw new CorruptIndex('two live vectors share an id');
    return idx;
  }
}

function sortHeap(h: Heap): { d: number; i: number }[] {
  return h.toArray().sort((a, b) => a.d - b.d || a.i - b.i);
}

function sum(v: Float32Array): number {
  let s = 0;
  for (const x of v) s += x;
  return s;
}

function cleanMetadata(m: unknown): Metadata {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new VectorError('metadata is an object');
  const out: Record<string, Value> = {} as Record<string, Value>;
  const keys = Object.keys(m);
  if (keys.length > 64) throw new VectorError('metadata has at most 64 fields');
  for (const k of keys) {
    const v = (m as Record<string, unknown>)[k];
    if (k === '__proto__' || k.startsWith('$') || k.length > 128) throw new VectorError(`${k} is not a good field name`);
    if (!(v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 4096))) throw new VectorError(`the value of ${k} must be a short string, a number, true, false or null`);
    out[k] = v;
  }
  return out;
}
