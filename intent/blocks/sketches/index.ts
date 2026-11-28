/**
 * Probabilistic summaries that stay small however much data goes through them, can be merged across shards or
 * days, and can be saved and loaded:
 *
 *  - HyperLogLog (Flajolet et al. 2007, 64-bit hash, linear counting for small sets): how many distinct things.
 *    Standard error is 1.04 / sqrt(2^p); p = 14 uses 16 KiB and is wrong by about 0.8% (one standard deviation).
 *  - t-digest (Dunning and Ertl, merging variant with the k1 scale function): quantiles and the cumulative
 *    distribution, most exact in the tails (p99, p99.9) where they matter, with exact min and max.
 *  - Count-min sketch (Cormode and Muthukrishnan 2005): how many times each thing was seen. Never counts too few,
 *    and counts too many by at most eps * total with probability 1 - delta. Optional conservative update.
 *  - Bloom filter (Bloom 1970, Kirsch-Mitzenmacher double hashing): has this been seen. No false negatives; the
 *    false positive rate is chosen up front and reported as the filter fills.
 *
 * Hashing is SHA-256 (first 64 bits) with a numeric seed, so results are the same on every machine and run.
 * Serialised forms start with a four-letter tag and a version, are big-endian, and are validated completely on
 * load: wrong length, impossible values and trailing bytes are refused, never read as something else. Merging
 * sketches built with different shapes or seeds is refused. No randomness and no clock are used.
 *
 * Out of scope: sketches are approximate by design; where an exact answer is owed, count exactly.
 */
import { createHash } from 'node:crypto';

export class SketchError extends Error {
  constructor(why: string) {
    super(why);
  }
}

const enc = new TextEncoder();
const bytesOf = (x: string | Uint8Array): Uint8Array => (typeof x === 'string' ? enc.encode(x) : x);

/** The first 64 bits of SHA-256(seed, item) as two unsigned 32-bit halves. */
export function hash64(item: string | Uint8Array, seed = 0): { hi: number; lo: number } {
  const s = Buffer.alloc(4);
  s.writeUInt32BE(seed >>> 0);
  const d = createHash('sha256').update(s).update(bytesOf(item)).digest();
  return { hi: d.readUInt32BE(0), lo: d.readUInt32BE(4) };
}

class Reader {
  private pos = 0;
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private readonly what: string;
  constructor(buf: Uint8Array, what: string) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.what = what;
  }
  tag(t: string, version: number): void {
    if (this.buf.length < 5 || Buffer.from(this.buf.subarray(0, 4)).toString('latin1') !== t) throw new SketchError(`that is not a saved ${this.what}`);
    if (this.buf[4] !== version) throw new SketchError(`unsupported ${this.what} version ${this.buf[4]}`);
    this.pos = 5;
  }
  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new SketchError(`the saved ${this.what} is cut short`);
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  done(): void {
    if (this.pos !== this.buf.length) throw new SketchError(`the saved ${this.what} has extra bytes after its end`);
  }
}

// ---------------------------------------------------------------- HyperLogLog

export class HyperLogLog {
  readonly p: number;
  readonly seed: number;
  private readonly regs: Uint8Array;

  constructor(p = 14, seed = 0, registers?: Uint8Array) {
    if (!Number.isInteger(p) || p < 4 || p > 16) throw new SketchError('precision p is a whole number from 4 to 16');
    this.p = p;
    this.seed = seed >>> 0;
    this.regs = registers ?? new Uint8Array(1 << p);
  }

  get registers(): number {
    return this.regs.length;
  }

  /** The expected relative standard error of an estimate. */
  get standardError(): number {
    return 1.04 / Math.sqrt(this.regs.length);
  }

  add(item: string | Uint8Array): void {
    const { hi, lo } = hash64(item, this.seed);
    const p = this.p;
    const idx = hi >>> (32 - p);
    const rest = hi & (2 ** (32 - p) - 1);
    const rank = rest !== 0 ? Math.clz32(rest) - p + 1 : 32 - p + (lo !== 0 ? Math.clz32(lo) : 32) + 1;
    if (rank > this.regs[idx]!) this.regs[idx] = rank;
  }

  count(): number {
    const m = this.regs.length;
    let sum = 0;
    let zeros = 0;
    for (const r of this.regs) {
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const alpha = m === 16 ? 0.673 : m === 32 ? 0.697 : m === 64 ? 0.709 : 0.7213 / (1 + 1.079 / m);
    const raw = (alpha * m * m) / sum;
    if (raw <= 2.5 * m && zeros > 0) return Math.round(m * Math.log(m / zeros));
    return Math.round(raw);
  }

  /** The union: this sketch becomes the sketch of everything either one saw. */
  merge(other: HyperLogLog): this {
    if (other.p !== this.p || other.seed !== this.seed) throw new SketchError('only sketches of the same precision and seed can be merged');
    for (let i = 0; i < this.regs.length; i++) if (other.regs[i]! > this.regs[i]!) this.regs[i] = other.regs[i]!;
    return this;
  }

  serialize(): Uint8Array {
    const out = Buffer.alloc(10 + this.regs.length);
    out.write('HLL1', 0, 'latin1');
    out[4] = 1;
    out[5] = this.p;
    out.writeUInt32BE(this.seed, 6);
    out.set(this.regs, 10);
    return out;
  }

  static load(buf: Uint8Array): HyperLogLog {
    const r = new Reader(buf, 'HyperLogLog');
    r.tag('HLL1', 1);
    const p = r.u8();
    if (p < 4 || p > 16) throw new SketchError('the saved HyperLogLog has an impossible precision');
    const seed = r.u32();
    const regs = Uint8Array.from(r.bytes(1 << p));
    r.done();
    const max = 64 - p + 1;
    if (regs.some((x) => x > max)) throw new SketchError('the saved HyperLogLog has a register no hash could produce');
    return new HyperLogLog(p, seed, regs);
  }
}

// ---------------------------------------------------------------- t-digest

interface Centroid {
  mean: number;
  weight: number;
}

export class TDigest {
  readonly compression: number;
  private cents: Centroid[] = [];
  private buffer: Centroid[] = [];
  private total = 0;
  private lo = Infinity;
  private hi = -Infinity;

  constructor(compression = 100) {
    if (!(compression >= 10 && compression <= 10_000)) throw new SketchError('compression is from 10 to 10000');
    this.compression = compression;
  }

  get count(): number {
    return this.total;
  }
  get min(): number {
    return this.lo;
  }
  get max(): number {
    return this.hi;
  }

  add(x: number, weight = 1): void {
    if (!Number.isFinite(x)) throw new SketchError('only finite numbers can be added');
    if (!(weight > 0) || !Number.isFinite(weight)) throw new SketchError('a weight is a positive finite number');
    this.buffer.push({ mean: x, weight });
    this.total += weight;
    if (x < this.lo) this.lo = x;
    if (x > this.hi) this.hi = x;
    if (this.buffer.length >= this.compression * 10) this.compress();
  }

  private k(q: number): number {
    return (this.compression / (2 * Math.PI)) * Math.asin(2 * Math.min(1, Math.max(0, q)) - 1);
  }

  private compress(): void {
    if (!this.buffer.length) return;
    const all = [...this.cents, ...this.buffer].sort((a, b) => a.mean - b.mean);
    this.buffer = [];
    const n = this.total;
    const out: Centroid[] = [];
    let cur = { ...all[0]! };
    let before = 0;
    for (let i = 1; i < all.length; i++) {
      const next = all[i]!;
      const proposed = cur.weight + next.weight;
      if (this.k((before + proposed) / n) - this.k(before / n) <= 1) {
        cur.mean += (next.mean - cur.mean) * (next.weight / proposed);
        cur.weight = proposed;
      } else {
        out.push(cur);
        before += cur.weight;
        cur = { ...next };
      }
    }
    out.push(cur);
    this.cents = out;
  }

  /** Number of centroids kept: the memory in use, however many numbers were added. */
  get size(): number {
    this.compress();
    return this.cents.length;
  }

  /** The value below which a fraction q (0 to 1) of the weight lies; NaN when empty. */
  quantile(q: number): number {
    if (!(q >= 0 && q <= 1)) throw new SketchError('q is from 0 to 1');
    this.compress();
    const c = this.cents;
    if (!c.length) return NaN;
    if (c.length === 1 || q === 0) return q === 0 ? this.lo : c[0]!.mean;
    if (q === 1) return this.hi;
    const n = this.total;
    const index = q * n;
    const first = c[0]!;
    const last = c[c.length - 1]!;
    if (index < first.weight / 2) return first.weight > 1 && this.lo !== first.mean ? this.lo + (index / (first.weight / 2)) * (first.mean - this.lo) : first.mean;
    if (index > n - last.weight / 2) return last.weight > 1 && this.hi !== last.mean ? last.mean + ((index - (n - last.weight / 2)) / (last.weight / 2)) * (this.hi - last.mean) : last.mean;
    let so = first.weight / 2;
    for (let i = 0; i < c.length - 1; i++) {
      const dw = (c[i]!.weight + c[i + 1]!.weight) / 2;
      if (so + dw > index) {
        const z1 = index - so;
        const z2 = so + dw - index;
        return (c[i]!.mean * z2 + c[i + 1]!.mean * z1) / (z1 + z2);
      }
      so += dw;
    }
    return last.mean;
  }

  /** The fraction of the weight at or below x; NaN when empty. */
  cdf(x: number): number {
    this.compress();
    const c = this.cents;
    if (!c.length) return NaN;
    if (x < this.lo) return 0;
    if (x >= this.hi) return 1;
    const n = this.total;
    if (c.length === 1) return (x - this.lo) / (this.hi - this.lo);
    const first = c[0]!;
    const last = c[c.length - 1]!;
    if (x < first.mean) return first.mean === this.lo ? 0 : (first.weight / 2 / n) * ((x - this.lo) / (first.mean - this.lo));
    if (x > last.mean) return 1 - (last.weight / 2 / n) * ((this.hi - x) / (this.hi - last.mean));
    let so = first.weight / 2;
    for (let i = 0; i < c.length - 1; i++) {
      const a = c[i]!;
      const b = c[i + 1]!;
      const dw = (a.weight + b.weight) / 2;
      if (x < b.mean) {
        const f = b.mean === a.mean ? 0.5 : (x - a.mean) / (b.mean - a.mean);
        return (so + f * dw) / n;
      }
      so += dw;
    }
    return 1;
  }

  merge(other: TDigest): this {
    other.compress();
    for (const c of other.cents) this.buffer.push({ ...c });
    this.total += other.total;
    this.lo = Math.min(this.lo, other.lo);
    this.hi = Math.max(this.hi, other.hi);
    this.compress();
    return this;
  }

  serialize(): Uint8Array {
    this.compress();
    const out = Buffer.alloc(5 + 8 + 4 + 16 + this.cents.length * 16);
    out.write('TDG1', 0, 'latin1');
    out[4] = 1;
    out.writeDoubleBE(this.compression, 5);
    out.writeUInt32BE(this.cents.length, 13);
    out.writeDoubleBE(this.lo === Infinity ? 0 : this.lo, 17);
    out.writeDoubleBE(this.hi === -Infinity ? 0 : this.hi, 25);
    this.cents.forEach((c, i) => {
      out.writeDoubleBE(c.mean, 33 + i * 16);
      out.writeDoubleBE(c.weight, 41 + i * 16);
    });
    return out;
  }

  static load(buf: Uint8Array): TDigest {
    const r = new Reader(buf, 't-digest');
    r.tag('TDG1', 1);
    const compression = r.f64();
    const n = r.u32();
    const lo = r.f64();
    const hi = r.f64();
    if (!(compression >= 10 && compression <= 10_000)) throw new SketchError('the saved t-digest has an impossible compression');
    if (n > compression * 20) throw new SketchError('the saved t-digest has more centroids than its compression allows');
    const d = new TDigest(compression);
    let prev = -Infinity;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const mean = r.f64();
      const weight = r.f64();
      if (!Number.isFinite(mean) || !(weight > 0) || !Number.isFinite(weight)) throw new SketchError('the saved t-digest has an impossible centroid');
      if (mean < prev) throw new SketchError('the saved t-digest centroids are out of order');
      prev = mean;
      total += weight;
      d.cents.push({ mean, weight });
    }
    r.done();
    if (n > 0 && !(Number.isFinite(lo) && Number.isFinite(hi) && lo <= d.cents[0]!.mean && hi >= d.cents[n - 1]!.mean)) throw new SketchError('the saved t-digest has a min or max that its centroids contradict');
    d.total = total;
    if (n > 0) {
      d.lo = lo;
      d.hi = hi;
    }
    return d;
  }
}

// ---------------------------------------------------------------- count-min

const U32 = 0xffff_ffff;

export class CountMin {
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  readonly conservative: boolean;
  private readonly cells: Uint32Array;
  private sum = 0;

  constructor(width: number, depth: number, seed = 0, conservative = false, cells?: Uint32Array) {
    if (!Number.isInteger(width) || width < 1 || width > 1 << 24) throw new SketchError('width is a whole number from 1 to 16777216');
    if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw new SketchError('depth is a whole number from 1 to 32');
    if (width * depth > 1 << 26) throw new SketchError('that sketch would be larger than 64M counters');
    this.width = width;
    this.depth = depth;
    this.seed = seed >>> 0;
    this.conservative = conservative;
    this.cells = cells ?? new Uint32Array(width * depth);
  }

  /** The shape that overcounts by at most eps * total with probability 1 - delta. */
  static forError(eps: number, delta: number, seed = 0, conservative = false): CountMin {
    if (!(eps > 0 && eps < 1) || !(delta > 0 && delta < 1)) throw new SketchError('eps and delta are between 0 and 1');
    return new CountMin(Math.ceil(Math.E / eps), Math.ceil(Math.log(1 / delta)), seed, conservative);
  }

  get total(): number {
    return this.sum;
  }

  private slots(item: string | Uint8Array): number[] {
    const { hi, lo } = hash64(item, this.seed);
    const h2 = lo | 1;
    return Array.from({ length: this.depth }, (_, i) => i * this.width + ((hi + Math.imul(i, h2)) >>> 0) % this.width);
  }

  add(item: string | Uint8Array, count = 1): void {
    if (!Number.isInteger(count) || count < 1) throw new SketchError('a count is a positive whole number');
    const s = this.slots(item);
    this.sum += count;
    if (this.conservative) {
      const target = Math.min(...s.map((i) => this.cells[i]!)) + count;
      for (const i of s) if (this.cells[i]! < target) this.cells[i] = Math.min(U32, target);
    } else for (const i of s) this.cells[i] = Math.min(U32, this.cells[i]! + count);
  }

  /** At least the true count, and over it by at most eps * total with probability 1 - delta. */
  estimate(item: string | Uint8Array): number {
    return Math.min(...this.slots(item).map((i) => this.cells[i]!));
  }

  merge(other: CountMin): this {
    if (other.width !== this.width || other.depth !== this.depth || other.seed !== this.seed) throw new SketchError('only sketches of the same width, depth and seed can be merged');
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = Math.min(U32, this.cells[i]! + other.cells[i]!);
    this.sum += other.sum;
    return this;
  }

  serialize(): Uint8Array {
    const out = Buffer.alloc(5 + 4 + 4 + 4 + 1 + 8 + this.cells.length * 4);
    out.write('CMS1', 0, 'latin1');
    out[4] = 1;
    out.writeUInt32BE(this.width, 5);
    out.writeUInt32BE(this.depth, 9);
    out.writeUInt32BE(this.seed, 13);
    out[17] = this.conservative ? 1 : 0;
    out.writeDoubleBE(this.sum, 18);
    this.cells.forEach((c, i) => out.writeUInt32BE(c, 26 + i * 4));
    return out;
  }

  static load(buf: Uint8Array): CountMin {
    const r = new Reader(buf, 'count-min sketch');
    r.tag('CMS1', 1);
    const width = r.u32();
    const depth = r.u32();
    const seed = r.u32();
    const flag = r.u8();
    const sum = r.f64();
    if (flag > 1) throw new SketchError('the saved count-min sketch has an unknown flag');
    if (width < 1 || width > 1 << 24 || depth < 1 || depth > 32 || width * depth > 1 << 26) throw new SketchError('the saved count-min sketch has an impossible shape');
    if (!(Number.isFinite(sum) && sum >= 0)) throw new SketchError('the saved count-min sketch has an impossible total');
    const raw = r.bytes(width * depth * 4);
    r.done();
    const cells = new Uint32Array(width * depth);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < cells.length; i++) cells[i] = dv.getUint32(i * 4);
    const s = new CountMin(width, depth, seed, flag === 1, cells);
    s.sum = sum;
    return s;
  }
}

// ---------------------------------------------------------------- Bloom filter

export class BloomFilter {
  readonly bits: number;
  readonly hashes: number;
  readonly seed: number;
  private readonly words: Uint32Array;
  private added = 0;

  constructor(bits: number, hashes: number, seed = 0, words?: Uint32Array) {
    if (!Number.isInteger(bits) || bits < 8 || bits > 2 ** 31 - 1) throw new SketchError('bits is a whole number from 8 to 2147483647');
    if (!Number.isInteger(hashes) || hashes < 1 || hashes > 64) throw new SketchError('hashes is a whole number from 1 to 64');
    this.bits = bits;
    this.hashes = hashes;
    this.seed = seed >>> 0;
    this.words = words ?? new Uint32Array(Math.ceil(bits / 32));
  }

  /** The smallest filter that holds `n` items with a false positive rate of at most `p`. */
  static forCapacity(n: number, p: number, seed = 0): BloomFilter {
    if (!Number.isInteger(n) || n < 1) throw new SketchError('capacity is a positive whole number');
    if (!(p > 0 && p < 1)) throw new SketchError('the false positive rate is between 0 and 1');
    const bits = Math.ceil((-n * Math.log(p)) / Math.LN2 ** 2);
    return new BloomFilter(Math.max(8, bits), Math.max(1, Math.round((bits / n) * Math.LN2)), seed);
  }

  private positions(item: string | Uint8Array): number[] {
    const { hi, lo } = hash64(item, this.seed);
    const h2 = (lo % this.bits) | 1;
    const h1 = hi % this.bits;
    return Array.from({ length: this.hashes }, (_, i) => (h1 + i * h2) % this.bits);
  }

  add(item: string | Uint8Array): void {
    let changed = false;
    for (const b of this.positions(item)) {
      const w = b >>> 5;
      const m = 1 << (b & 31);
      if (!(this.words[w]! & m)) {
        this.words[w] = this.words[w]! | m;
        changed = true;
      }
    }
    if (changed) this.added++;
  }

  has(item: string | Uint8Array): boolean {
    return this.positions(item).every((b) => (this.words[b >>> 5]! & (1 << (b & 31))) !== 0);
  }

  get bitsSet(): number {
    let n = 0;
    for (let w of this.words) {
      while (w) {
        w &= w - 1;
        n++;
      }
    }
    return n;
  }

  /** How many different items were added, estimated from how full the filter is. */
  estimatedCount(): number {
    const x = this.bitsSet;
    if (x >= this.bits) return Infinity;
    return Math.round((-this.bits / this.hashes) * Math.log(1 - x / this.bits));
  }

  /** The false positive rate right now, from how full it is. */
  falsePositiveRate(): number {
    return (this.bitsSet / this.bits) ** this.hashes;
  }

  merge(other: BloomFilter): this {
    if (other.bits !== this.bits || other.hashes !== this.hashes || other.seed !== this.seed) throw new SketchError('only filters of the same size, hash count and seed can be merged');
    for (let i = 0; i < this.words.length; i++) this.words[i] = this.words[i]! | other.words[i]!;
    this.added = Math.max(this.added, other.added);
    return this;
  }

  serialize(): Uint8Array {
    const out = Buffer.alloc(5 + 4 + 1 + 4 + this.words.length * 4);
    out.write('BLM1', 0, 'latin1');
    out[4] = 1;
    out.writeUInt32BE(this.bits, 5);
    out[9] = this.hashes;
    out.writeUInt32BE(this.seed, 10);
    this.words.forEach((w, i) => out.writeUInt32BE(w, 14 + i * 4));
    return out;
  }

  static load(buf: Uint8Array): BloomFilter {
    const r = new Reader(buf, 'Bloom filter');
    r.tag('BLM1', 1);
    const bits = r.u32();
    const hashes = r.u8();
    const seed = r.u32();
    if (bits < 8 || bits > 2 ** 31 - 1 || hashes < 1 || hashes > 64) throw new SketchError('the saved Bloom filter has an impossible shape');
    const raw = r.bytes(Math.ceil(bits / 32) * 4);
    r.done();
    const words = new Uint32Array(Math.ceil(bits / 32));
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < words.length; i++) words[i] = dv.getUint32(i * 4);
    const spare = words.length * 32 - bits;
    if (spare > 0 && (words[words.length - 1]! >>> (32 - spare)) !== 0) throw new SketchError('the saved Bloom filter has bits set past its end');
    return new BloomFilter(bits, hashes, seed, words);
  }
}
