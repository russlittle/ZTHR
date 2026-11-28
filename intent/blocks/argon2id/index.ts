/**
 * Argon2 (RFC 9106: Argon2id, plus Argon2d and Argon2i) and BLAKE2b (RFC 7693) in pure TypeScript with no
 * dependencies, for platforms where node:crypto has no argon2. 64-bit arithmetic is done on pairs of 32-bit halves,
 * so there is no BigInt in the hot loop. Checked against the RFC 7693 and RFC 9106 test vectors and against node's own
 * blake2b512.
 *
 * Built for use on a server that has to bound its own cost, so every call goes through `checkParams`: memory, passes,
 * lanes, output and input lengths are limited (the defaults are generous but finite; raise them on purpose), and a time
 * budget aborts a hash that takes longer than asked, using an injected clock. `argon2idAsync` yields to the event loop
 * between segments so that one login does not freeze the process; the synchronous form is for workers and scripts.
 * Parameter presets follow RFC 9106 section 4 ("uniformly safe": 2 GiB, t=1, p=4; "memory-constrained": 64 MiB, t=3).
 *
 * Out of scope: threads (lanes are computed one after another, so p only changes the result and the memory layout, not
 * the speed), the version 0x10 algorithm (only 0x13 is produced), and constant-time guarantees beyond what JavaScript
 * offers: the data-dependent addressing of Argon2d, and of Argon2id after its first half-pass, is part of the design.
 */

// ---------------------------------------------------------------- BLAKE2b

const IV = [0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19]; // [lo, hi] pairs

const SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** v[a] += v[b] + m (64-bit, on halves); then rotation helpers work on (lo, hi) index pairs. */
function gb(a: number, b: number, c: number, d: number, xi: number, yi: number): void {
  // a = a + b + x
  let lo = v[2 * a]! + v[2 * b]! + m[2 * xi]!;
  let hi = v[2 * a + 1]! + v[2 * b + 1]! + m[2 * xi + 1]! + (lo > 0xffffffff ? Math.floor(lo / 4294967296) : 0);
  v[2 * a] = lo >>> 0;
  v[2 * a + 1] = hi >>> 0;
  // d = rotr(d ^ a, 32): swap halves
  let dl = v[2 * d]! ^ v[2 * a]!;
  let dh = v[2 * d + 1]! ^ v[2 * a + 1]!;
  v[2 * d] = dh;
  v[2 * d + 1] = dl;
  // c = c + d
  lo = v[2 * c]! + v[2 * d]!;
  hi = v[2 * c + 1]! + v[2 * d + 1]! + (lo > 0xffffffff ? 1 : 0);
  v[2 * c] = lo >>> 0;
  v[2 * c + 1] = hi >>> 0;
  // b = rotr(b ^ c, 24)
  let bl = v[2 * b]! ^ v[2 * c]!;
  let bh = v[2 * b + 1]! ^ v[2 * c + 1]!;
  v[2 * b] = ((bl >>> 24) | (bh << 8)) >>> 0;
  v[2 * b + 1] = ((bh >>> 24) | (bl << 8)) >>> 0;
  // a = a + b + y
  lo = v[2 * a]! + v[2 * b]! + m[2 * yi]!;
  hi = v[2 * a + 1]! + v[2 * b + 1]! + m[2 * yi + 1]! + (lo > 0xffffffff ? Math.floor(lo / 4294967296) : 0);
  v[2 * a] = lo >>> 0;
  v[2 * a + 1] = hi >>> 0;
  // d = rotr(d ^ a, 16)
  dl = v[2 * d]! ^ v[2 * a]!;
  dh = v[2 * d + 1]! ^ v[2 * a + 1]!;
  v[2 * d] = ((dl >>> 16) | (dh << 16)) >>> 0;
  v[2 * d + 1] = ((dh >>> 16) | (dl << 16)) >>> 0;
  // c = c + d
  lo = v[2 * c]! + v[2 * d]!;
  hi = v[2 * c + 1]! + v[2 * d + 1]! + (lo > 0xffffffff ? 1 : 0);
  v[2 * c] = lo >>> 0;
  v[2 * c + 1] = hi >>> 0;
  // b = rotr(b ^ c, 63) = rotl 1
  bl = v[2 * b]! ^ v[2 * c]!;
  bh = v[2 * b + 1]! ^ v[2 * c + 1]!;
  v[2 * b] = ((bl << 1) | (bh >>> 31)) >>> 0;
  v[2 * b + 1] = ((bh << 1) | (bl >>> 31)) >>> 0;
}

function compress(h: Uint32Array, block: Uint8Array, off: number, t: number, last: boolean): void {
  for (let i = 0; i < 32; i++) {
    const p = off + i * 4;
    m[i] = (block[p]! | (block[p + 1]! << 8) | (block[p + 2]! << 16) | (block[p + 3]! << 24)) >>> 0;
  }
  for (let i = 0; i < 16; i++) v[i] = h[i]!;
  for (let i = 0; i < 16; i++) v[16 + i] = IV[i]!;
  // 128-bit counter: t fits in 53 bits here
  v[24] = (v[24]! ^ (t >>> 0)) >>> 0;
  v[25] = (v[25]! ^ (Math.floor(t / 4294967296) >>> 0)) >>> 0;
  if (last) {
    v[28] = ~v[28]! >>> 0;
    v[29] = ~v[29]! >>> 0;
  }
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10]!;
    gb(0, 4, 8, 12, s[0]!, s[1]!);
    gb(1, 5, 9, 13, s[2]!, s[3]!);
    gb(2, 6, 10, 14, s[4]!, s[5]!);
    gb(3, 7, 11, 15, s[6]!, s[7]!);
    gb(0, 5, 10, 15, s[8]!, s[9]!);
    gb(1, 6, 11, 12, s[10]!, s[11]!);
    gb(2, 7, 8, 13, s[12]!, s[13]!);
    gb(3, 4, 9, 14, s[14]!, s[15]!);
  }
  for (let i = 0; i < 16; i++) h[i] = (h[i]! ^ v[i]! ^ v[i + 16]!) >>> 0;
}

/** BLAKE2b (RFC 7693) with an output of 1 to 64 bytes and an optional key of up to 64 bytes. */
export function blake2b(data: Uint8Array, outLen = 64, key: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError('blake2b output must be 1 to 64 bytes');
  if (key.length > 64) throw new RangeError('blake2b key must be at most 64 bytes');
  const h = new Uint32Array(16);
  for (let i = 0; i < 16; i++) h[i] = IV[i]!;
  h[0] = (h[0]! ^ 0x01010000 ^ (key.length << 8) ^ outLen) >>> 0;
  const full = key.length ? concat(padTo128(key), data) : data;
  const n = full.length;
  let off = 0;
  if (n === 0) compress(h, new Uint8Array(128), 0, 0, true);
  else {
    while (n - off > 128) {
      compress(h, full, off, off + 128, false);
      off += 128;
    }
    const tail = new Uint8Array(128);
    tail.set(full.subarray(off));
    compress(h, tail, 0, n, true);
  }
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = (h[i >> 2]! >>> (8 * (i & 3))) & 0xff;
  return out;
}

function padTo128(k: Uint8Array): Uint8Array {
  const o = new Uint8Array(128);
  o.set(k);
  return o;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    o.set(p, i);
    i += p.length;
  }
  return o;
}
const le32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};

/** H' from RFC 9106 section 3.3: BLAKE2b extended to any output length. */
export function hPrime(input: Uint8Array, outLen: number): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1) throw new RangeError('output length must be positive');
  const first = concat(le32(outLen), input);
  if (outLen <= 64) return blake2b(first, outLen);
  const r = Math.ceil(outLen / 32) - 2;
  const out = new Uint8Array(outLen);
  let vi = blake2b(first, 64);
  out.set(vi.subarray(0, 32), 0);
  for (let i = 1; i < r; i++) {
    vi = blake2b(vi, 64);
    out.set(vi.subarray(0, 32), i * 32);
  }
  vi = blake2b(vi, outLen - 32 * r);
  out.set(vi, r * 32);
  return out;
}

// ---------------------------------------------------------------- Argon2 compression

const BLOCK_WORDS = 256; // 128 u64 as (lo, hi) pairs in a Uint32Array

const t32 = { hi: 0, lo: 0 };
/** 32x32 -> 64-bit product, into t32. */
function mul(a: number, b: number): void {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const mid = a0 * b1 + a1 * b0;
  const t = p00 + (mid % 65536) * 65536;
  t32.lo = t >>> 0;
  t32.hi = (a1 * b1 + Math.floor(mid / 65536) + Math.floor(t / 4294967296)) >>> 0;
}

/** a = a + b + 2 * lo32(a) * lo32(b), on word indices into `x`. */
function blamka(x: Uint32Array, a: number, b: number): void {
  const al = x[2 * a]!;
  const bl = x[2 * b]!;
  mul(al, bl);
  const lo = al + bl + 2 * t32.lo;
  const hi = x[2 * a + 1]! + x[2 * b + 1]! + 2 * t32.hi + Math.floor(lo / 4294967296);
  x[2 * a] = lo >>> 0;
  x[2 * a + 1] = hi >>> 0;
}

function gbA(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  blamka(x, a, b);
  let l = x[2 * d]! ^ x[2 * a]!;
  let h = x[2 * d + 1]! ^ x[2 * a + 1]!;
  x[2 * d] = h;
  x[2 * d + 1] = l;
  blamka(x, c, d);
  l = x[2 * b]! ^ x[2 * c]!;
  h = x[2 * b + 1]! ^ x[2 * c + 1]!;
  x[2 * b] = ((l >>> 24) | (h << 8)) >>> 0;
  x[2 * b + 1] = ((h >>> 24) | (l << 8)) >>> 0;
  blamka(x, a, b);
  l = x[2 * d]! ^ x[2 * a]!;
  h = x[2 * d + 1]! ^ x[2 * a + 1]!;
  x[2 * d] = ((l >>> 16) | (h << 16)) >>> 0;
  x[2 * d + 1] = ((h >>> 16) | (l << 16)) >>> 0;
  blamka(x, c, d);
  l = x[2 * b]! ^ x[2 * c]!;
  h = x[2 * b + 1]! ^ x[2 * c + 1]!;
  x[2 * b] = ((l << 1) | (h >>> 31)) >>> 0;
  x[2 * b + 1] = ((h << 1) | (l >>> 31)) >>> 0;
}

function perm(x: Uint32Array, i: readonly number[]): void {
  gbA(x, i[0]!, i[4]!, i[8]!, i[12]!);
  gbA(x, i[1]!, i[5]!, i[9]!, i[13]!);
  gbA(x, i[2]!, i[6]!, i[10]!, i[14]!);
  gbA(x, i[3]!, i[7]!, i[11]!, i[15]!);
  gbA(x, i[0]!, i[5]!, i[10]!, i[15]!);
  gbA(x, i[1]!, i[6]!, i[11]!, i[12]!);
  gbA(x, i[2]!, i[7]!, i[8]!, i[13]!);
  gbA(x, i[3]!, i[4]!, i[9]!, i[14]!);
}

const ROW_IDX: number[][] = [];
const COL_IDX: number[][] = [];
for (let r = 0; r < 8; r++) ROW_IDX.push(Array.from({ length: 16 }, (_, k) => 16 * r + k));
for (let c = 0; c < 8; c++) COL_IDX.push(Array.from({ length: 16 }, (_, k) => 2 * c + (k & 1) + 16 * (k >> 1)));

const R = new Uint32Array(BLOCK_WORDS);
const Q = new Uint32Array(BLOCK_WORDS);

/** next = G(prev, ref), xored into next's old content when `xorOld` (passes after the first). */
function fillBlock(mem: Uint32Array, prev: number, ref: number, next: number, xorOld: boolean): void {
  const P = prev * BLOCK_WORDS;
  const F = ref * BLOCK_WORDS;
  const N = next * BLOCK_WORDS;
  for (let i = 0; i < BLOCK_WORDS; i++) {
    R[i] = (mem[F + i]! ^ mem[P + i]!) >>> 0;
    Q[i] = R[i]!;
  }
  for (const idx of ROW_IDX) perm(Q, idx);
  for (const idx of COL_IDX) perm(Q, idx);
  if (xorOld) for (let i = 0; i < BLOCK_WORDS; i++) mem[N + i] = (mem[N + i]! ^ R[i]! ^ Q[i]!) >>> 0;
  else for (let i = 0; i < BLOCK_WORDS; i++) mem[N + i] = (R[i]! ^ Q[i]!) >>> 0;
}

// ---------------------------------------------------------------- parameters

export type Variant = 'argon2d' | 'argon2i' | 'argon2id';
const TYPE_CODE: Record<Variant, number> = { argon2d: 0, argon2i: 1, argon2id: 2 };

export interface Argon2Params {
  /** Memory in KiB. */
  readonly memoryKiB: number;
  /** Passes (t). */
  readonly passes: number;
  /** Lanes (p). */
  readonly lanes: number;
  /** Tag length in bytes; 32 is usual. */
  readonly tagLength?: number;
  readonly secret?: Uint8Array;
  readonly associatedData?: Uint8Array;
}

export interface Limits {
  readonly maxMemoryKiB: number;
  readonly maxPasses: number;
  readonly maxLanes: number;
  readonly maxInputBytes: number;
  readonly maxTagLength: number;
  readonly minSaltBytes: number;
  /** Abort a hash that has run longer than this (needs `now`). */
  readonly budgetMs?: number;
}

export const DEFAULT_LIMITS: Limits = { maxMemoryKiB: 256 * 1024, maxPasses: 10, maxLanes: 16, maxInputBytes: 1 << 20, maxTagLength: 256, minSaltBytes: 8 };

export class Argon2Refused extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class Argon2OutOfTime extends Error {
  constructor(ms: number) {
    super(`argon2 exceeded its time budget of ${ms} ms`);
  }
}

/** RFC 9106 section 4 recommendations. */
export const PRESETS = {
  /** "uniformly safe": 2 GiB, one pass, four lanes. Needs raised limits. */
  uniform: { memoryKiB: 2 * 1024 * 1024, passes: 1, lanes: 4, tagLength: 32 },
  /** "memory-constrained": 64 MiB, three passes, four lanes. */
  constrained: { memoryKiB: 64 * 1024, passes: 3, lanes: 4, tagLength: 32 },
} as const satisfies Record<string, Argon2Params>;

export function checkParams(p: Argon2Params, salt: Uint8Array, password: Uint8Array, limits: Limits = DEFAULT_LIMITS): void {
  const ints = (n: number) => Number.isInteger(n);
  if (!ints(p.lanes) || p.lanes < 1 || p.lanes > limits.maxLanes) throw new Argon2Refused(`lanes must be 1 to ${limits.maxLanes}`);
  if (!ints(p.passes) || p.passes < 1 || p.passes > limits.maxPasses) throw new Argon2Refused(`passes must be 1 to ${limits.maxPasses}`);
  if (!ints(p.memoryKiB) || p.memoryKiB < 8 * p.lanes) throw new Argon2Refused(`memory must be at least ${8 * p.lanes} KiB for ${p.lanes} lanes`);
  if (p.memoryKiB > limits.maxMemoryKiB) throw new Argon2Refused(`memory ${p.memoryKiB} KiB is over the limit of ${limits.maxMemoryKiB} KiB`);
  const tl = p.tagLength ?? 32;
  if (!ints(tl) || tl < 4 || tl > limits.maxTagLength) throw new Argon2Refused(`tag length must be 4 to ${limits.maxTagLength}`);
  if (salt.length < limits.minSaltBytes) throw new Argon2Refused(`salt must be at least ${limits.minSaltBytes} bytes`);
  const sizes = [password.length, salt.length, p.secret?.length ?? 0, p.associatedData?.length ?? 0];
  if (sizes.some((s) => s > limits.maxInputBytes)) throw new Argon2Refused('an input is over the size limit');
}

// ---------------------------------------------------------------- the algorithm

export interface Options {
  readonly variant?: Variant;
  readonly limits?: Limits;
  /** Injected clock for the time budget. */
  readonly now?: () => number;
}

function* run(password: Uint8Array, salt: Uint8Array, p: Argon2Params, variant: Variant, mem: Uint32Array): Generator<void, Uint8Array> {
  const tagLen = p.tagLength ?? 32;
  const secret = p.secret ?? new Uint8Array(0);
  const ad = p.associatedData ?? new Uint8Array(0);
  const lanes = p.lanes;
  const mPrime = 4 * lanes * Math.floor(p.memoryKiB / (4 * lanes));
  const laneLen = mPrime / lanes;
  const segLen = laneLen / 4;
  const h0 = blake2b(
    concat(le32(lanes), le32(tagLen), le32(p.memoryKiB), le32(p.passes), le32(0x13), le32(TYPE_CODE[variant]), le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad),
    64,
  );
  const toWords = (bytes: Uint8Array, at: number) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < BLOCK_WORDS; i++) mem[at * BLOCK_WORDS + i] = dv.getUint32(i * 4, true);
  };
  for (let l = 0; l < lanes; l++) {
    toWords(hPrime(concat(h0, le32(0), le32(l)), 1024), l * laneLen);
    toWords(hPrime(concat(h0, le32(1), le32(l)), 1024), l * laneLen + 1);
  }
  const addr = new Uint32Array(BLOCK_WORDS);
  const input = new Uint32Array(BLOCK_WORDS);
  for (let pass = 0; pass < p.passes; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < lanes; lane++) {
        const independent = variant === 'argon2i' || (variant === 'argon2id' && pass === 0 && slice < 2);
        let start = 0;
        if (pass === 0 && slice === 0) start = 2;
        // address generation state (counter lives in input word 6, as u64 lo half at index 12)
        const nextAddresses = () => {
          input[12] = (input[12]! + 1) >>> 0;
          if (input[12] === 0) input[13] = (input[13]! + 1) >>> 0;
          addrBlock(input, addr);
        };
        if (independent) {
          input.fill(0);
          input[0] = pass;
          input[2] = lane;
          input[4] = slice;
          input[6] = mPrime;
          input[8] = p.passes;
          input[10] = TYPE_CODE[variant];
          if (pass === 0 && slice === 0) nextAddresses();
        }
        let cur = lane * laneLen + slice * segLen + start;
        let prev = cur % laneLen === 0 ? cur + laneLen - 1 : cur - 1;
        for (let i = start; i < segLen; i++, cur++, prev++) {
          if (cur % laneLen === 1) prev = cur - 1;
          let j1: number;
          let j2: number;
          if (independent) {
            if (i % 128 === 0) nextAddresses();
            j1 = addr[2 * (i % 128)]!;
            j2 = addr[2 * (i % 128) + 1]!;
          } else {
            j1 = mem[prev * BLOCK_WORDS]!;
            j2 = mem[prev * BLOCK_WORDS + 1]!;
          }
          let refLane = j2 % lanes;
          if (pass === 0 && slice === 0) refLane = lane;
          const same = refLane === lane;
          let area: number;
          if (pass === 0) {
            if (slice === 0) area = i - 1;
            else if (same) area = slice * segLen + i - 1;
            else area = slice * segLen + (i === 0 ? -1 : 0);
          } else if (same) area = laneLen - segLen + i - 1;
          else area = laneLen - segLen + (i === 0 ? -1 : 0);
          const rel = Number((BigInt(j1) * BigInt(j1)) >> 32n);
          const relPos = area - 1 - Number((BigInt(area) * BigInt(rel)) >> 32n);
          const startPos = pass === 0 ? 0 : slice === 3 ? 0 : (slice + 1) * segLen;
          const refIdx = refLane * laneLen + ((startPos + relPos) % laneLen);
          fillBlock(mem, prev, refIdx, cur, pass > 0);
        }
        yield;
      }
    }
  }
  const final = new Uint32Array(BLOCK_WORDS);
  for (let l = 0; l < lanes; l++) {
    const at = (l * laneLen + laneLen - 1) * BLOCK_WORDS;
    for (let i = 0; i < BLOCK_WORDS; i++) final[i] = (final[i]! ^ mem[at + i]!) >>> 0;
  }
  const bytes = new Uint8Array(1024);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < BLOCK_WORDS; i++) dv.setUint32(i * 4, final[i]!, true);
  return hPrime(bytes, tagLen);
}

const zeroBlock = new Uint32Array(BLOCK_WORDS);
/** address = G(0, G(0, input)), in place on `out`. */
function addrBlock(input: Uint32Array, out: Uint32Array): void {
  const m3 = new Uint32Array(BLOCK_WORDS * 3);
  m3.set(zeroBlock, 0);
  m3.set(input, BLOCK_WORDS);
  fillBlock(m3, 0, 1, 2, false);
  fillBlock(m3, 0, 2, 2, false);
  out.set(m3.subarray(2 * BLOCK_WORDS, 3 * BLOCK_WORDS));
}

function prepare(password: Uint8Array, salt: Uint8Array, p: Argon2Params, o: Options) {
  checkParams(p, salt, password, o.limits ?? DEFAULT_LIMITS);
  const lanes = p.lanes;
  const mPrime = 4 * lanes * Math.floor(p.memoryKiB / (4 * lanes));
  return { variant: o.variant ?? 'argon2id', mem: new Uint32Array(mPrime * BLOCK_WORDS) };
}

/** Argon2 as raw bytes. Synchronous: it holds the thread for the whole computation. */
export function argon2(password: Uint8Array, salt: Uint8Array, p: Argon2Params, o: Options = {}): Uint8Array {
  const { variant, mem } = prepare(password, salt, p, o);
  const budget = o.limits?.budgetMs ?? DEFAULT_LIMITS.budgetMs;
  const t0 = o.now?.() ?? 0;
  const g = run(password, salt, p, variant, mem);
  for (;;) {
    const r = g.next();
    if (r.done) {
      mem.fill(0);
      return r.value;
    }
    if (budget !== undefined && o.now && o.now() - t0 > budget) {
      mem.fill(0);
      throw new Argon2OutOfTime(budget);
    }
  }
}

/** Same result, but yields to the event loop between segments and honours the time budget. */
export async function argon2Async(password: Uint8Array, salt: Uint8Array, p: Argon2Params, o: Options = {}): Promise<Uint8Array> {
  const { variant, mem } = prepare(password, salt, p, o);
  const budget = o.limits?.budgetMs ?? DEFAULT_LIMITS.budgetMs;
  const t0 = o.now?.() ?? 0;
  const g = run(password, salt, p, variant, mem);
  for (;;) {
    const r = g.next();
    if (r.done) {
      mem.fill(0);
      return r.value;
    }
    if (budget !== undefined && o.now && o.now() - t0 > budget) {
      mem.fill(0);
      throw new Argon2OutOfTime(budget);
    }
    await new Promise<void>((res) => setImmediate(res));
  }
}

export const argon2id = (password: Uint8Array, salt: Uint8Array, p: Argon2Params, o: Omit<Options, 'variant'> = {}) => argon2(password, salt, p, { ...o, variant: 'argon2id' });
export const argon2idAsync = (password: Uint8Array, salt: Uint8Array, p: Argon2Params, o: Omit<Options, 'variant'> = {}) => argon2Async(password, salt, p, { ...o, variant: 'argon2id' });

// ---------------------------------------------------------------- encoded form

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/=+$/, '');
const unb64 = (s: string) => {
  if (!/^[A-Za-z0-9+/]*$/.test(s)) throw new Argon2Refused('bad base64 in hash');
  return new Uint8Array(Buffer.from(s, 'base64'));
};

/** The PHC string form: $argon2id$v=19$m=65536,t=3,p=4$<salt>$<tag>. */
export function encode(variant: Variant, p: Argon2Params, salt: Uint8Array, tag: Uint8Array): string {
  return `$${variant}$v=19$m=${p.memoryKiB},t=${p.passes},p=${p.lanes}$${b64(salt)}$${b64(tag)}`;
}

export function parseEncoded(s: string): { variant: Variant; params: Argon2Params; salt: Uint8Array; tag: Uint8Array } {
  const m = /^\$(argon2id|argon2i|argon2d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(s);
  if (!m) throw new Argon2Refused('not an argon2 hash');
  if (m[2] !== '19') throw new Argon2Refused('only argon2 version 19 (0x13) is supported');
  const tag = unb64(m[7]!);
  return { variant: m[1] as Variant, params: { memoryKiB: Number(m[3]), passes: Number(m[4]), lanes: Number(m[5]), tagLength: tag.length }, salt: unb64(m[6]!), tag };
}

/** Constant-time comparison of two byte strings. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}
