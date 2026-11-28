/**
 * QR codes and the common barcodes, as module grids and as SVG. QR (ISO/IEC 18004): versions 1-40, error
 * correction L/M/Q/H, numeric, alphanumeric and byte (UTF-8) modes, the eight masks chosen by the penalty rules,
 * and a decoder for a sampled module grid that reads the format and version information (tolerating damaged bits),
 * unmasks, de-interleaves and corrects errors with Reed-Solomon before reading the segments. Code 128 (ISO/IEC
 * 15417): code sets A, B and C chosen for the fewest symbols, FNC1 for GS1-128, check symbol, and a decoder from
 * bar and space widths. EAN-13, EAN-8, UPC-A and UPC-E-free retail codes with check digits (ISO/IEC 15420). Data
 * Matrix ECC 200 (ISO/IEC 16022): square symbols 10x10 to 144x144, ASCII encodation with digit pairs, Reed-Solomon
 * over GF(256)/0x12D, the standard "utah" module placement, and a decoder for a sampled grid.
 *
 * Output is a boolean grid (true = dark) or an SVG string built from numbers and validated colours only, never from
 * caller text, so an SVG cannot carry markup. Decoding starts from an already-sampled grid or run-length widths:
 * finding a code in a camera image (binarising, locating finder patterns, perspective) is out of scope. Not
 * included: QR Kanji mode, Micro QR, structured append, Data Matrix C40/Text/X12/EDIFACT/Base 256 encodation and
 * rectangular symbols, and 2D codes beyond QR and Data Matrix (PDF417, Aztec).
 */

export class BarcodeError extends Error {}

export type Grid = boolean[][];

// --- Galois field and Reed-Solomon ---------------------------------------------------------------------------------

class Field {
  readonly exp = new Uint8Array(512);
  readonly log = new Uint8Array(256);
  constructor(poly: number) {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      this.exp[i] = x;
      this.log[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= poly;
    }
    for (let i = 255; i < 512; i++) this.exp[i] = this.exp[i - 255]!;
  }
  mul(a: number, b: number): number {
    return a === 0 || b === 0 ? 0 : this.exp[this.log[a]! + this.log[b]!]!;
  }
  div(a: number, b: number): number {
    if (b === 0) throw new BarcodeError('division by zero');
    return a === 0 ? 0 : this.exp[(this.log[a]! + 255 - this.log[b]!) % 255]!;
  }
  pow(a: number, n: number): number {
    return a === 0 ? 0 : this.exp[(((this.log[a]! * n) % 255) + 255) % 255]!;
  }
}

const QR_FIELD = new Field(0x11d);
const DM_FIELD = new Field(0x12d);

/** The generator polynomial (without its leading 1, highest degree first) with roots alpha^b .. alpha^(b+n-1). */
function generator(f: Field, n: number, b: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const root = f.pow(2, b + i);
    const next = new Array<number>(g.length + 1).fill(0);
    g.forEach((c, j) => {
      next[j] = next[j]! ^ c;
      next[j + 1] = next[j + 1]! ^ f.mul(c, root);
    });
    g = next;
  }
  return g.slice(1);
}

/** The n check bytes for a block of data. */
export function rsEncode(data: readonly number[], n: number, kind: 'qr' | 'dm'): number[] {
  const f = kind === 'qr' ? QR_FIELD : DM_FIELD;
  const g = generator(f, n, kind === 'qr' ? 0 : 1);
  const rem = new Array<number>(n).fill(0);
  for (const d of data) {
    const factor = d ^ rem.shift()!;
    rem.push(0);
    g.forEach((c, i) => (rem[i] = rem[i]! ^ f.mul(c, factor)));
  }
  return rem;
}

/** Corrects a block (data then check bytes) in place; returns how many bytes were wrong. Throws when it cannot. */
export function rsCorrect(block: number[], nsym: number, kind: 'qr' | 'dm'): number {
  const f = kind === 'qr' ? QR_FIELD : DM_FIELD;
  const b = kind === 'qr' ? 0 : 1;
  const n = block.length;
  const evalAt = (x: number) => {
    let y = 0;
    for (const c of block) y = f.mul(y, x) ^ c;
    return y;
  };
  const S: number[] = [];
  for (let j = 0; j < nsym; j++) S.push(evalAt(f.pow(2, b + j)));
  if (S.every((s) => s === 0)) return 0;
  // Berlekamp-Massey, polynomials ascending.
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let bb = 1;
  for (let i = 0; i < nsym; i++) {
    let d = S[i]!;
    for (let k = 1; k <= L; k++) d ^= f.mul(C[k] ?? 0, S[i - k]!);
    if (d === 0) {
      m++;
      continue;
    }
    const T = C.slice();
    const coef = f.div(d, bb);
    while (C.length < B.length + m) C.push(0);
    B.forEach((v, k) => (C[k + m] = C[k + m]! ^ f.mul(coef, v)));
    if (2 * L <= i) {
      L = i + 1 - L;
      B = T;
      bb = d;
      m = 1;
    } else m++;
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (L > nsym / 2 || C.length - 1 !== L) throw new BarcodeError('too many errors to correct');
  const sigmaAt = (x: number) => {
    let y = 0;
    for (let k = C.length - 1; k >= 0; k--) y = f.mul(y, x) ^ C[k]!;
    return y;
  };
  const positions: number[] = [];
  for (let p = 0; p < n; p++) if (sigmaAt(f.pow(2, -p)) === 0) positions.push(p);
  if (positions.length !== L) throw new BarcodeError('too many errors to correct');
  // Omega = S(x) * sigma(x) mod x^nsym
  const omega = new Array<number>(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let k = 0; k < C.length && k <= i; k++) omega[i] = omega[i]! ^ f.mul(C[k]!, S[i - k]!);
  for (const p of positions) {
    const xInv = f.pow(2, -p);
    let om = 0;
    for (let k = omega.length - 1; k >= 0; k--) om = f.mul(om, xInv) ^ omega[k]!;
    let dsig = 0;
    for (let k = 1; k < C.length; k += 2) dsig ^= f.mul(C[k]!, f.pow(xInv, k - 1));
    if (dsig === 0) throw new BarcodeError('too many errors to correct');
    const mag = f.mul(f.pow(2, p * (1 - b)), f.div(om, dsig));
    block[n - 1 - p] = block[n - 1 - p]! ^ mag;
  }
  for (let j = 0; j < nsym; j++) if (evalAt(f.pow(2, b + j)) !== 0) throw new BarcodeError('too many errors to correct');
  return positions.length;
}

// --- QR code -------------------------------------------------------------------------------------------------------

export type Ecl = 'L' | 'M' | 'Q' | 'H';
const ECL_INDEX: Record<Ecl, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT: Record<Ecl, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECL_FROM_FORMAT = ['M', 'L', 'H', 'Q'] as const;

const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules that can hold data and error correction, for a version. */
function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

/** All codewords (data plus error correction) a version holds. */
export const qrTotalCodewords = (ver: number): number => Math.floor(rawModules(ver) / 8);

/** Data codewords a version holds at an error correction level. */
export function qrDataCodewords(ver: number, ecl: Ecl): number {
  const e = ECL_INDEX[ecl];
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e]![ver]! * NUM_BLOCKS[e]![ver]!;
}

const NUMERIC = /^[0-9]*$/;
const ALNUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const ALNUM = /^[0-9A-Z $%*+\-./:]*$/;

export type Mode = 'numeric' | 'alphanumeric' | 'byte';
export interface Segment {
  readonly mode: Mode;
  readonly count: number;
  readonly bits: readonly number[];
}

const pushBits = (out: number[], v: number, n: number) => {
  for (let i = n - 1; i >= 0; i--) out.push((v >>> i) & 1);
};

/** The segment for a text in its best single mode: digits only, then the 45 alphanumeric characters, else UTF-8 bytes. */
export function segmentFor(text: string): Segment {
  const bits: number[] = [];
  if (NUMERIC.test(text)) {
    for (let i = 0; i < text.length; ) {
      const n = Math.min(3, text.length - i);
      pushBits(bits, Number(text.slice(i, i + n)), n * 3 + 1);
      i += n;
    }
    return { mode: 'numeric', count: text.length, bits };
  }
  if (ALNUM.test(text)) {
    let i = 0;
    for (; i + 2 <= text.length; i += 2) pushBits(bits, ALNUM_CHARS.indexOf(text[i]!) * 45 + ALNUM_CHARS.indexOf(text[i + 1]!), 11);
    if (i < text.length) pushBits(bits, ALNUM_CHARS.indexOf(text[i]!), 6);
    return { mode: 'alphanumeric', count: text.length, bits };
  }
  const bytes = Buffer.from(text, 'utf8');
  for (const b of bytes) pushBits(bits, b, 8);
  return { mode: 'byte', count: bytes.length, bits };
}

const MODE_BITS: Record<Mode, number> = { numeric: 1, alphanumeric: 2, byte: 4 };
const countBits = (m: Mode, ver: number) => {
  const t = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
  return ({ numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] } as const)[m][t];
};

export interface QrOptions {
  readonly ecl?: Ecl;
  /** Raise the level when the data still fits (default true). */
  readonly boostEcl?: boolean;
  readonly minVersion?: number;
  readonly maxVersion?: number;
  /** Force a mask 0..7 (default: the lowest penalty). */
  readonly mask?: number;
}

export interface Qr {
  readonly version: number;
  readonly ecl: Ecl;
  readonly mask: number;
  readonly size: number;
  readonly modules: Grid;
  /** Data then error correction codewords, interleaved, as placed in the symbol. */
  readonly codewords: readonly number[];
}

/** Encodes text (or ready segments) as a QR code. Throws BarcodeError when it does not fit version 40. */
export function qrEncode(input: string | readonly Segment[], o: QrOptions = {}): Qr {
  const segs = typeof input === 'string' ? [segmentFor(input)] : input;
  let ecl = o.ecl ?? 'M';
  const lo = o.minVersion ?? 1;
  const hi = o.maxVersion ?? 40;
  if (lo < 1 || hi > 40 || lo > hi) throw new BarcodeError('versions must be within 1..40');
  let ver = lo;
  let used = 0;
  for (; ; ver++) {
    const cap = qrDataCodewords(ver, ecl) * 8;
    used = 0;
    for (const s of segs) {
      const cb = countBits(s.mode, ver);
      if (s.count >= 1 << cb) {
        used = Infinity;
        break;
      }
      used += 4 + cb + s.bits.length;
    }
    if (used <= cap) break;
    if (ver >= hi) throw new BarcodeError('the data is too long for a QR code at this error correction level');
  }
  if (o.boostEcl ?? true) for (const e of ['M', 'Q', 'H'] as const) if (used <= qrDataCodewords(ver, e) * 8 && ECL_INDEX[e] > ECL_INDEX[ecl]) ecl = e;
  const bits: number[] = [];
  for (const s of segs) {
    pushBits(bits, MODE_BITS[s.mode], 4);
    pushBits(bits, s.count, countBits(s.mode, ver));
    bits.push(...s.bits);
  }
  const cap = qrDataCodewords(ver, ecl) * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) pushBits(bits, pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const all = interleaveQr(data, ver, ecl);
  return drawQr(all, ver, ecl, o.mask);
}

function blockLayout(ver: number, ecl: Ecl) {
  const e = ECL_INDEX[ecl];
  const nb = NUM_BLOCKS[e]![ver]!;
  const ecc = ECC_PER_BLOCK[e]![ver]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const shortLen = Math.floor(raw / nb);
  const nShort = nb - (raw % nb);
  return { nb, ecc, raw, shortLen, nShort };
}

function interleaveQr(data: readonly number[], ver: number, ecl: Ecl): number[] {
  const { nb, ecc, shortLen, nShort } = blockLayout(ver, ecl);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - ecc + (i < nShort ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    blocks.push([...d, ...rsEncode(d, ecc, 'qr')]);
  }
  const out: number[] = [];
  for (let i = 0; i < shortLen + 1; i++)
    blocks.forEach((b, j) => {
      const dataLen = shortLen - ecc + (j < nShort ? 0 : 1);
      if (i < dataLen) out.push(b[i]!);
    });
  for (let i = 0; i < ecc; i++)
    blocks.forEach((b, j) => {
      const dataLen = shortLen - ecc + (j < nShort ? 0 : 1);
      out.push(b[dataLen + i]!);
    });
  return out;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let p = ver * 4 + 10, i = 1; i < n; i++, p -= step) r.splice(1, 0, p);
  return r;
}

interface Canvas {
  readonly size: number;
  readonly m: Grid;
  readonly fn: boolean[][];
}

function newCanvas(ver: number): Canvas {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const c = { size, m, fn };
  const set = (x: number, y: number, v: boolean) => {
    m[y]![x] = v;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const ap = alignmentPositions(ver);
  for (let i = 0; i < ap.length; i++)
    for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i]! + dx, ap[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  drawFormat(c, 0, 0, true);
  drawVersion(c, ver);
  return c;
}

/** The 15 format bits for an error correction level and mask (BCH(15,5), masked with 0x5412). */
export function qrFormatBits(ecl: Ecl, mask: number): number {
  const data = (ECL_FORMAT[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (BCH(18,6)) for versions 7 and up. */
export function qrVersionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

function drawFormat(c: Canvas, ecl: Ecl | 0, mask: number, reserve = false): void {
  const bits = reserve ? 0 : qrFormatBits(ecl as Ecl, mask);
  const size = c.size;
  const set = (x: number, y: number, v: boolean) => {
    c.m[y]![x] = v;
    c.fn[y]![x] = true;
  };
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function drawVersion(c: Canvas, ver: number): void {
  if (ver < 7) return;
  const bits = qrVersionBits(ver);
  for (let i = 0; i < 18; i++) {
    const v = ((bits >>> i) & 1) !== 0;
    const a = c.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    c.m[b]![a] = v;
    c.fn[b]![a] = true;
    c.m[a]![b] = v;
    c.fn[a]![b] = true;
  }
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Visits data module positions in the order codeword bits are placed: two-column strips from the lower right. */
function* dataPositions(c: Canvas): Generator<[number, number]> {
  const size = c.size;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!c.fn[y]![x]) yield [x, y];
      }
  }
}

function penalty(m: Grid): number {
  const size = m.length;
  let p = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) p += 3 + (run - 5);
    const s = Array.from({ length: size }, (_, i) => (get(i) ? '1' : '0')).join('');
    for (const pat of ['10111010000', '00001011101']) for (let at = s.indexOf(pat); at >= 0; at = s.indexOf(pat, at + 1)) p += 40;
  };
  for (let y = 0; y < size; y++) line((i) => m[y]![i]!);
  for (let x = 0; x < size; x++) line((i) => m[i]![x]!);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) p += 3;
  let dark = 0;
  for (const r of m) for (const v of r) if (v) dark++;
  const total = size * size;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

function drawQr(codewords: readonly number[], ver: number, ecl: Ecl, forced?: number): Qr {
  const c = newCanvas(ver);
  let i = 0;
  for (const [x, y] of dataPositions(c)) {
    c.m[y]![x] = i < codewords.length * 8 ? ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0 : false;
    i++;
  }
  const apply = (mask: number) => {
    for (let y = 0; y < c.size; y++) for (let x = 0; x < c.size; x++) if (!c.fn[y]![x] && MASKS[mask]!(x, y)) c.m[y]![x] = !c.m[y]![x];
  };
  let best = forced ?? 0;
  if (forced === undefined) {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      apply(mask);
      drawFormat(c, ecl, mask);
      const s = penalty(c.m);
      if (s < bestScore) {
        bestScore = s;
        best = mask;
      }
      apply(mask);
    }
  } else if (forced < 0 || forced > 7) throw new BarcodeError('mask must be 0..7');
  apply(best);
  drawFormat(c, ecl, best);
  return { version: ver, ecl, mask: best, size: c.size, modules: c.m, codewords };
}

export interface QrDecoded {
  readonly text: string;
  readonly version: number;
  readonly ecl: Ecl;
  readonly mask: number;
  /** Codewords the Reed-Solomon step had to repair. */
  readonly corrected: number;
}

const popcount = (n: number) => {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
};

function readFormat(m: Grid): { ecl: Ecl; mask: number } {
  const size = m.length;
  const get = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  let a = 0;
  for (let i = 0; i <= 5; i++) a |= get(8, i) << i;
  a |= get(8, 7) << 6;
  a |= get(8, 8) << 7;
  a |= get(7, 8) << 8;
  for (let i = 9; i < 15; i++) a |= get(14 - i, 8) << i;
  let b = 0;
  for (let i = 0; i < 8; i++) b |= get(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) b |= get(8, size - 15 + i) << i;
  let best: { ecl: Ecl; mask: number; d: number } | undefined;
  for (const ecl of ['L', 'M', 'Q', 'H'] as const)
    for (let mask = 0; mask < 8; mask++) {
      const f = qrFormatBits(ecl, mask);
      const d = Math.min(popcount(f ^ a), popcount(f ^ b));
      if (!best || d < best.d) best = { ecl, mask, d };
    }
  if (!best || best.d > 3) throw new BarcodeError('the format information is too damaged to read');
  return best;
}

/** Decodes a sampled QR module grid (true = dark, quiet zone not included). */
export function qrDecode(m: Grid): QrDecoded {
  const size = m.length;
  if (size < 21 || size > 177 || (size - 17) % 4 !== 0 || m.some((r) => r.length !== size)) throw new BarcodeError('not a QR code grid');
  const ver = (size - 17) / 4;
  if (ver >= 7) {
    const want = qrVersionBits(ver);
    let a = 0;
    let b = 0;
    for (let i = 0; i < 18; i++) {
      a |= (m[Math.floor(i / 3)]![size - 11 + (i % 3)] ? 1 : 0) << i;
      b |= (m[size - 11 + (i % 3)]![Math.floor(i / 3)] ? 1 : 0) << i;
    }
    if (Math.min(popcount(a ^ want), popcount(b ^ want)) > 3) throw new BarcodeError('the version information does not match the size');
  }
  const { ecl, mask } = readFormat(m);
  const c = newCanvas(ver);
  const raw: number[] = [];
  let acc = 0;
  let nb = 0;
  for (const [x, y] of dataPositions(c)) {
    const v = m[y]![x]! !== MASKS[mask]!(x, y);
    acc = (acc << 1) | (v ? 1 : 0);
    if (++nb === 8) {
      raw.push(acc);
      acc = 0;
      nb = 0;
    }
  }
  const { nb: nBlocks, ecc, shortLen, nShort } = blockLayout(ver, ecl);
  const blocks: number[][] = Array.from({ length: nBlocks }, () => []);
  let k = 0;
  const dataLen = (j: number) => shortLen - ecc + (j < nShort ? 0 : 1);
  for (let i = 0; i < shortLen - ecc + 1; i++) for (let j = 0; j < nBlocks; j++) if (i < dataLen(j)) blocks[j]!.push(raw[k++]!);
  for (let i = 0; i < ecc; i++) for (let j = 0; j < nBlocks; j++) blocks[j]!.push(raw[k++]!);
  let corrected = 0;
  const data: number[] = [];
  blocks.forEach((b, j) => {
    corrected += rsCorrect(b, ecc, 'qr');
    data.push(...b.slice(0, dataLen(j)));
  });
  return { text: parseSegments(data, ver), version: ver, ecl, mask, corrected };
}

function parseSegments(data: readonly number[], ver: number): string {
  const bits: number[] = [];
  for (const d of data) pushBits(bits, d, 8);
  let p = 0;
  const take = (n: number) => {
    if (p + n > bits.length) throw new BarcodeError('the data ends inside a segment');
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bits[p++]!;
    return v;
  };
  let out = '';
  const bytes: number[] = [];
  const flush = () => {
    if (bytes.length) out += new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes.splice(0)));
  };
  while (bits.length - p >= 4) {
    const mode = take(4);
    if (mode === 0) break;
    if (mode === 7) {
      const first = take(8);
      if (first & 0x80) take(first & 0x40 ? 16 : 8);
      continue;
    }
    if (mode === 1) {
      flush();
      let n = take(countBits('numeric', ver));
      while (n >= 3) (out += String(take(10)).padStart(3, '0'), (n -= 3));
      if (n === 2) out += String(take(7)).padStart(2, '0');
      if (n === 1) out += String(take(4));
    } else if (mode === 2) {
      flush();
      let n = take(countBits('alphanumeric', ver));
      for (; n >= 2; n -= 2) {
        const v = take(11);
        if (v >= 45 * 45) throw new BarcodeError('an alphanumeric pair is out of range');
        out += ALNUM_CHARS[Math.floor(v / 45)]! + ALNUM_CHARS[v % 45]!;
      }
      if (n === 1) {
        const v = take(6);
        if (v >= 45) throw new BarcodeError('an alphanumeric character is out of range');
        out += ALNUM_CHARS[v]!;
      }
    } else if (mode === 4) {
      let n = take(countBits('byte', ver));
      while (n-- > 0) bytes.push(take(8));
    } else throw new BarcodeError(`segment mode ${mode} is not supported`);
  }
  flush();
  return out;
}

// --- Code 128 ------------------------------------------------------------------------------------------------------

const C128: readonly string[] = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

export const CODE128_PATTERNS = C128;
const START_A = 103;
const START_B = 104;
const START_C = 105;
const STOP = 106;
const CODE_A = 101;
const CODE_B = 100;
const CODE_C = 99;
export const FNC1 = 'ñ';

type Set128 = 'A' | 'B' | 'C';

const valueIn = (set: 'A' | 'B', ch: string): number | undefined => {
  const c = ch.charCodeAt(0);
  if (ch === FNC1) return 102;
  if (set === 'B') return c >= 32 && c <= 127 ? c - 32 : undefined;
  return c < 32 ? c + 64 : c >= 32 && c <= 95 ? c - 32 : undefined;
};

/** The symbol values for a text with the fewest symbols, using sets A, B and C (digit pairs). FNC1 is "ñ". */
export function code128Values(text: string): number[] {
  const chars = [...text];
  if (chars.length === 0) throw new BarcodeError('nothing to encode');
  const n = chars.length;
  const sets: Set128[] = ['A', 'B', 'C'];
  const INF = 1e9;
  // cost[i][s]: fewest symbols to encode the first i characters ending in set s (start symbol counted).
  const cost: number[][] = Array.from({ length: n + 1 }, () => [INF, INF, INF]);
  const back: { s: number; w: number }[][] = Array.from({ length: n + 1 }, () => [{ s: -1, w: 0 }, { s: -1, w: 0 }, { s: -1, w: 0 }]);
  for (let s = 0; s < 3; s++) cost[0]![s] = 1;
  for (let i = 0; i < n; i++)
    for (let s = 0; s < 3; s++) {
      const here = cost[i]![s]!;
      if (here >= INF) continue;
      for (let t = 0; t < 3; t++) {
        const sw = i === 0 || s === t ? 0 : 1;
        const set = sets[t]!;
        let w = 0;
        if (set === 'C') {
          if (chars[i] === FNC1) w = 1;
          else if (i + 1 < n && /^\d$/.test(chars[i]!) && /^\d$/.test(chars[i + 1]!)) w = 2;
        } else if (valueIn(set, chars[i]!) !== undefined) w = 1;
        if (w === 0) continue;
        const c = here + sw + 1;
        if (c < cost[i + w]![t]!) {
          cost[i + w]![t] = c;
          back[i + w]![t] = { s, w };
        }
      }
    }
  let t = [0, 1, 2].reduce((a, b) => (cost[n]![b]! < cost[n]![a]! ? b : a));
  if (cost[n]![t]! >= INF) throw new BarcodeError('a character cannot be encoded in Code 128');
  const plan: { set: number; at: number; w: number }[] = [];
  for (let i = n; i > 0; ) {
    const b = back[i]![t]!;
    plan.unshift({ set: t, at: i - b.w, w: b.w });
    i -= b.w;
    t = b.s;
  }
  const out: number[] = [START_A + plan[0]!.set];
  let cur = plan[0]!.set;
  for (const step of plan) {
    if (step.set !== cur) {
      out.push([CODE_A, CODE_B, CODE_C][step.set]!);
      cur = step.set;
    }
    if (step.set === 2) out.push(step.w === 2 ? Number(chars[step.at]! + chars[step.at + 1]!) : 102);
    else out.push(valueIn(step.set === 0 ? 'A' : 'B', chars[step.at]!)!);
  }
  return out;
}

/** The check symbol: start value plus each value times its position, modulo 103. */
export function code128Check(values: readonly number[]): number {
  let sum = values[0]!;
  for (let i = 1; i < values.length; i++) sum += values[i]! * i;
  return sum % 103;
}

/** Modules (true = bar) for a text, with check symbol and stop pattern; no quiet zone. */
export function code128(text: string): boolean[] {
  const v = code128Values(text);
  v.push(code128Check(v), STOP);
  const mods: boolean[] = [];
  for (const val of v) {
    let bar = true;
    for (const w of C128[val]!) {
      for (let i = 0; i < Number(w); i++) mods.push(bar);
      bar = !bar;
    }
  }
  return mods;
}

/** Decodes Code 128 from alternating bar and space widths in modules, starting with a bar and ending with the stop bar. */
export function code128Decode(widths: readonly number[]): string {
  const patterns = new Map(C128.map((p, i) => [p, i]));
  const sym: number[] = [];
  let i = 0;
  while (i < widths.length) {
    const len = i + 7 <= widths.length && patterns.get(widths.slice(i, i + 7).join('')) === STOP ? 7 : 6;
    const key = widths.slice(i, i + len).join('');
    const v = patterns.get(key);
    if (v === undefined || (len === 6 && v === STOP)) throw new BarcodeError('a bar pattern is not a Code 128 symbol');
    sym.push(v);
    i += len;
  }
  if (sym.length < 4 || sym[sym.length - 1] !== STOP) throw new BarcodeError('there is no stop pattern');
  if (sym[0]! < START_A || sym[0]! > START_C) throw new BarcodeError('there is no start symbol');
  const body = sym.slice(0, -2);
  if (code128Check(body) !== sym[sym.length - 2]) throw new BarcodeError('the check symbol does not match');
  let set: Set128 = (['A', 'B', 'C'] as const)[sym[0]! - START_A]!;
  let out = '';
  for (const v of body.slice(1)) {
    if (v === CODE_A || v === CODE_B || v === CODE_C) set = v === CODE_A ? 'A' : v === CODE_B ? 'B' : 'C';
    else if (v === 102) out += FNC1;
    else if (v > 102) throw new BarcodeError('a start symbol appears in the middle');
    else if (set === 'C') out += String(v).padStart(2, '0');
    else if (set === 'B') out += String.fromCharCode(v + 32);
    else out += String.fromCharCode(v < 64 ? v + 32 : v - 64);
  }
  return out;
}

/** Run lengths (bar, space, bar, ...) of a module row. */
export function runLengths(mods: readonly boolean[]): number[] {
  const out: number[] = [];
  let run = 0;
  let cur = true;
  for (const m of mods) {
    if (m === cur) run++;
    else {
      out.push(run);
      run = 1;
      cur = m;
    }
  }
  out.push(run);
  return out;
}

// --- EAN / UPC -----------------------------------------------------------------------------------------------------

const L_CODE = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R_CODE = L_CODE.map((s) => [...s].map((c) => (c === '0' ? '1' : '0')).join(''));
const G_CODE = R_CODE.map((s) => [...s].reverse().join(''));
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** The GS1 check digit for the digits before it (works for 7, 11, 12 and 13 digit bodies, EAN-8 to GTIN-14). */
export function gs1Check(body: string): number {
  if (!/^\d+$/.test(body)) throw new BarcodeError('digits only');
  let sum = 0;
  [...body].reverse().forEach((d, i) => (sum += Number(d) * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10;
}

export type Retail = 'ean13' | 'ean8' | 'upca';

/** Modules for an EAN-13 (12 or 13 digits), EAN-8 (7 or 8) or UPC-A (11 or 12) code; a wrong check digit is refused. */
export function retailCode(kind: Retail, digits: string): boolean[] {
  const body = { ean13: 12, ean8: 7, upca: 11 }[kind];
  if (!new RegExp(`^\\d{${body}}(\\d)?$`).test(digits)) throw new BarcodeError(`${kind} needs ${body} or ${body + 1} digits`);
  const check = gs1Check(digits.slice(0, body));
  if (digits.length === body + 1 && Number(digits[body]) !== check) throw new BarcodeError(`the check digit should be ${check}`);
  const full = digits.slice(0, body) + check;
  const d = [...full].map(Number);
  let s: string;
  if (kind === 'ean8') s = `101${d.slice(0, 4).map((x) => L_CODE[x]).join('')}01010${d.slice(4).map((x) => R_CODE[x]).join('')}101`;
  else {
    const e = kind === 'upca' ? [0, ...d] : d;
    const par = EAN13_PARITY[e[0]!]!;
    s = `101${e.slice(1, 7).map((x, i) => (par[i] === 'L' ? L_CODE[x] : G_CODE[x])).join('')}01010${e.slice(7).map((x) => R_CODE[x]).join('')}101`;
  }
  return [...s].map((c) => c === '1');
}

/** Reads the digits back from the modules of an EAN-13/UPC-A (95), or EAN-8 (67) code and checks the check digit. */
export function retailDecode(mods: readonly boolean[]): { kind: Retail; digits: string } {
  const s = mods.map((m) => (m ? '1' : '0')).join('');
  const dig = (chunk: string, tables: readonly string[][]): { d: number; t: number } => {
    for (let t = 0; t < tables.length; t++) {
      const d = tables[t]!.indexOf(chunk);
      if (d >= 0) return { d, t };
    }
    throw new BarcodeError('a digit pattern is not valid');
  };
  if (s.length === 67) {
    if (!s.startsWith('101') || s.slice(31, 36) !== '01010' || !s.endsWith('101')) throw new BarcodeError('the guard patterns are missing');
    let out = '';
    for (let i = 0; i < 4; i++) out += dig(s.slice(3 + i * 7, 10 + i * 7), [L_CODE]).d;
    for (let i = 0; i < 4; i++) out += dig(s.slice(36 + i * 7, 43 + i * 7), [R_CODE]).d;
    if (gs1Check(out.slice(0, 7)) !== Number(out[7])) throw new BarcodeError('the check digit does not match');
    return { kind: 'ean8', digits: out };
  }
  if (s.length !== 95) throw new BarcodeError('not an EAN/UPC symbol length');
  if (!s.startsWith('101') || s.slice(45, 50) !== '01010' || !s.endsWith('101')) throw new BarcodeError('the guard patterns are missing');
  let parity = '';
  let out = '';
  for (let i = 0; i < 6; i++) {
    const r = dig(s.slice(3 + i * 7, 10 + i * 7), [L_CODE, G_CODE]);
    parity += r.t === 0 ? 'L' : 'G';
    out += r.d;
  }
  const first = EAN13_PARITY.indexOf(parity);
  if (first < 0) throw new BarcodeError('the left half parity is not valid');
  for (let i = 0; i < 6; i++) out += dig(s.slice(50 + i * 7, 57 + i * 7), [R_CODE]).d;
  const full = `${first}${out}`;
  if (gs1Check(full.slice(0, 12)) !== Number(full[12])) throw new BarcodeError('the check digit does not match');
  return first === 0 ? { kind: 'upca', digits: full.slice(1) } : { kind: 'ean13', digits: full };
}

// --- Data Matrix ECC 200 -------------------------------------------------------------------------------------------

export interface DmSize {
  readonly size: number;
  readonly data: number;
  readonly ecc: number;
  readonly blocks: number;
  readonly regions: number;
  /** Data codewords in blocks beyond the first `shortBlocks`; only 144x144 has unequal blocks. */
}

export const DM_SIZES: readonly DmSize[] = [
  { size: 10, data: 3, ecc: 5, blocks: 1, regions: 1 },
  { size: 12, data: 5, ecc: 7, blocks: 1, regions: 1 },
  { size: 14, data: 8, ecc: 10, blocks: 1, regions: 1 },
  { size: 16, data: 12, ecc: 12, blocks: 1, regions: 1 },
  { size: 18, data: 18, ecc: 14, blocks: 1, regions: 1 },
  { size: 20, data: 22, ecc: 18, blocks: 1, regions: 1 },
  { size: 22, data: 30, ecc: 20, blocks: 1, regions: 1 },
  { size: 24, data: 36, ecc: 24, blocks: 1, regions: 1 },
  { size: 26, data: 44, ecc: 28, blocks: 1, regions: 1 },
  { size: 32, data: 62, ecc: 36, blocks: 1, regions: 2 },
  { size: 36, data: 86, ecc: 42, blocks: 1, regions: 2 },
  { size: 40, data: 114, ecc: 48, blocks: 1, regions: 2 },
  { size: 44, data: 144, ecc: 56, blocks: 1, regions: 2 },
  { size: 48, data: 174, ecc: 68, blocks: 2, regions: 2 },
  { size: 52, data: 204, ecc: 84, blocks: 2, regions: 2 },
  { size: 64, data: 280, ecc: 112, blocks: 4, regions: 4 },
  { size: 72, data: 368, ecc: 144, blocks: 4, regions: 4 },
  { size: 80, data: 456, ecc: 192, blocks: 4, regions: 4 },
  { size: 88, data: 576, ecc: 224, blocks: 4, regions: 4 },
  { size: 96, data: 696, ecc: 272, blocks: 4, regions: 4 },
  { size: 104, data: 816, ecc: 336, blocks: 6, regions: 4 },
  { size: 120, data: 1050, ecc: 408, blocks: 6, regions: 6 },
  { size: 132, data: 1304, ecc: 496, blocks: 8, regions: 6 },
  { size: 144, data: 1558, ecc: 620, blocks: 10, regions: 6 },
];

/** ASCII encodation: digit pairs as 130 + value, other bytes as byte + 1, extended (128-255) via upper shift 235. */
export function dmAsciiCodewords(text: string): number[] {
  const bytes = Buffer.from(text, 'latin1');
  if (bytes.toString('latin1') !== text) throw new BarcodeError('Data Matrix ASCII encodation takes Latin-1 characters only');
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    const n = bytes[i + 1];
    if (c >= 48 && c <= 57 && n !== undefined && n >= 48 && n <= 57) {
      out.push(130 + (c - 48) * 10 + (n - 48));
      i++;
    } else if (c < 128) out.push(c + 1);
    else out.push(235, c - 128 + 1);
  }
  return out;
}

function dmFor(count: number, minSize?: number): DmSize {
  const s = DM_SIZES.find((z) => z.data >= count && z.size >= (minSize ?? 0));
  if (!s) throw new BarcodeError('the data is too long for a Data Matrix symbol');
  return s;
}

/** Fills the unused data codewords: 129, then the scrambled pad (253-state) per ISO 16022. */
function dmPad(cw: number[], total: number): number[] {
  const out = cw.slice();
  if (out.length < total) out.push(129);
  while (out.length < total) {
    const pos = out.length + 1;
    const r = ((149 * pos) % 253) + 1;
    out.push((129 + r) % 254 || 254);
  }
  return out;
}

function dmBlocks(sz: DmSize, data: readonly number[]): number[] {
  const eccPer = sz.ecc / sz.blocks;
  const blocks: number[][] = Array.from({ length: sz.blocks }, () => []);
  data.forEach((d, i) => blocks[i % sz.blocks]!.push(d));
  const eccs = blocks.map((b) => rsEncode(b, eccPer, 'dm'));
  const out = data.slice();
  for (let i = 0; i < eccPer; i++) eccs.forEach((e) => out.push(e[i]!));
  return out;
}

class Placement {
  readonly rows: number;
  readonly cols: number;
  readonly bits: number[];
  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.bits = new Array<number>(rows * cols).fill(-1);
  }
  /** Runs the placement; `visit(row, col, codewordIndex, bit)` is called for every module a codeword bit lands on. */
  run(visit: (row: number, col: number, pos: number, bit: number) => void): void {
    const { rows, cols } = this;
    let pos = 0;
    let row = 4;
    let col = 0;
    const module = (r: number, c: number, p: number, bit: number) => {
      if (r < 0) {
        r += rows;
        c += 4 - ((rows + 4) % 8);
      }
      if (c < 0) {
        c += cols;
        r += 4 - ((cols + 4) % 8);
      }
      this.bits[r * cols + c] = p * 8 + bit;
      visit(r, c, p, bit);
    };
    const utah = (r: number, c: number, p: number) => {
      module(r - 2, c - 2, p, 1);
      module(r - 2, c - 1, p, 2);
      module(r - 1, c - 2, p, 3);
      module(r - 1, c - 1, p, 4);
      module(r - 1, c, p, 5);
      module(r, c - 2, p, 6);
      module(r, c - 1, p, 7);
      module(r, c, p, 8);
    };
    const c1 = (p: number) => {
      module(rows - 1, 0, p, 1);
      module(rows - 1, 1, p, 2);
      module(rows - 1, 2, p, 3);
      module(0, cols - 2, p, 4);
      module(0, cols - 1, p, 5);
      module(1, cols - 1, p, 6);
      module(2, cols - 1, p, 7);
      module(3, cols - 1, p, 8);
    };
    const c2 = (p: number) => {
      module(rows - 3, 0, p, 1);
      module(rows - 2, 0, p, 2);
      module(rows - 1, 0, p, 3);
      module(0, cols - 4, p, 4);
      module(0, cols - 3, p, 5);
      module(0, cols - 2, p, 6);
      module(0, cols - 1, p, 7);
      module(1, cols - 1, p, 8);
    };
    const c3 = (p: number) => {
      module(rows - 3, 0, p, 1);
      module(rows - 2, 0, p, 2);
      module(rows - 1, 0, p, 3);
      module(0, cols - 2, p, 4);
      module(0, cols - 1, p, 5);
      module(1, cols - 1, p, 6);
      module(2, cols - 1, p, 7);
      module(3, cols - 1, p, 8);
    };
    const c4 = (p: number) => {
      module(rows - 1, 0, p, 1);
      module(rows - 1, cols - 1, p, 2);
      module(0, cols - 3, p, 3);
      module(0, cols - 2, p, 4);
      module(0, cols - 1, p, 5);
      module(1, cols - 3, p, 6);
      module(1, cols - 2, p, 7);
      module(1, cols - 1, p, 8);
    };
    const has = (r: number, c: number) => this.bits[r * cols + c]! >= 0;
    do {
      if (row === rows && col === 0) c1(pos++);
      if (row === rows - 2 && col === 0 && cols % 4 !== 0) c2(pos++);
      if (row === rows - 2 && col === 0 && cols % 8 === 4) c3(pos++);
      if (row === rows + 4 && col === 2 && cols % 8 === 0) c4(pos++);
      do {
        if (row < rows && col >= 0 && !has(row, col)) utah(row, col, pos++);
        row -= 2;
        col += 2;
      } while (row >= 0 && col < cols);
      row += 1;
      col += 3;
      do {
        if (row >= 0 && col < cols && !has(row, col)) utah(row, col, pos++);
        row += 2;
        col -= 2;
      } while (row < rows && col >= 0);
      row += 3;
      col += 1;
    } while (row < rows || col < cols);
  }
}

/** Encodes Latin-1 text as a Data Matrix ECC 200 square symbol, the smallest that holds it (or at least `minSize`). */
export function dataMatrixEncode(text: string, o: { minSize?: number } = {}): { size: number; modules: Grid; codewords: number[] } {
  const cw = dmAsciiCodewords(text);
  const sz = dmFor(cw.length, o.minSize);
  const all = dmBlocks(sz, dmPad(cw, sz.data));
  const r = sz.regions;
  const inner = sz.size - 2 * r;
  const place = new Placement(inner, inner);
  const mapping = new Array<boolean>(inner * inner).fill(false);
  place.run((row, col, pos, bit) => {
    mapping[row * inner + col] = ((all[pos]! >>> (8 - bit)) & 1) !== 0;
  });
  if (place.bits[inner * inner - 1]! < 0) {
    mapping[inner * inner - 1] = true;
    mapping[(inner - 2) * inner + (inner - 2)] = true;
  }
  const m: Grid = Array.from({ length: sz.size }, () => new Array<boolean>(sz.size).fill(false));
  const side = inner / r;
  for (let ry = 0; ry < r; ry++)
    for (let rx = 0; rx < r; rx++) {
      const x0 = rx * (side + 2);
      const y0 = ry * (side + 2);
      for (let i = 0; i < side + 2; i++) {
        m[y0 + side + 1]![x0 + i] = true; // solid bottom
        m[y0 + i]![x0] = true; // solid left
        m[y0]![x0 + i] = i % 2 === 0; // alternating top (starts dark at left)
        m[y0 + i]![x0 + side + 1] = i % 2 === 1; // alternating right (dark at odd rows from top)
      }
      m[y0 + side + 1]![x0] = true;
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) m[y0 + 1 + y]![x0 + 1 + x] = mapping[(ry * side + y) * inner + rx * side + x]!;
    }
  return { size: sz.size, modules: m, codewords: all };
}

/** Decodes a sampled Data Matrix grid (square ECC 200, ASCII encodation), correcting errors with Reed-Solomon. */
export function dataMatrixDecode(m: Grid): { text: string; size: number; corrected: number } {
  const size = m.length;
  const sz = DM_SIZES.find((z) => z.size === size);
  if (!sz || m.some((r) => r.length !== size)) throw new BarcodeError('not a supported Data Matrix size');
  const r = sz.regions;
  const inner = size - 2 * r;
  const side = inner / r;
  const mapping = new Array<boolean>(inner * inner).fill(false);
  for (let ry = 0; ry < r; ry++)
    for (let rx = 0; rx < r; rx++) for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) mapping[(ry * side + y) * inner + rx * side + x] = m[ry * (side + 2) + 1 + y]![rx * (side + 2) + 1 + x]!;
  const total = sz.data + sz.ecc;
  const cw = new Array<number>(total).fill(0);
  new Placement(inner, inner).run((row, col, pos, bit) => {
    if (mapping[row * inner + col]) cw[pos] = cw[pos]! | (1 << (8 - bit));
  });
  const eccPer = sz.ecc / sz.blocks;
  const blocks: number[][] = Array.from({ length: sz.blocks }, () => []);
  for (let i = 0; i < sz.data; i++) blocks[i % sz.blocks]!.push(cw[i]!);
  for (let i = 0; i < eccPer; i++) for (let j = 0; j < sz.blocks; j++) blocks[j]!.push(cw[sz.data + i * sz.blocks + j]!);
  let corrected = 0;
  for (const b of blocks) corrected += rsCorrect(b, eccPer, 'dm');
  const data: number[] = new Array<number>(sz.data);
  blocks.forEach((b, j) => {
    for (let i = 0; i < b.length - eccPer; i++) data[i * sz.blocks + j] = b[i]!;
  });
  const bytes: number[] = [];
  let upper = false;
  for (const c of data) {
    if (c === 129) break;
    if (c >= 130 && c <= 229) {
      const v = c - 130;
      bytes.push(48 + Math.floor(v / 10), 48 + (v % 10));
    } else if (c === 235) upper = true;
    else if (c >= 1 && c <= 128) {
      bytes.push(upper ? c - 1 + 128 : c - 1);
      upper = false;
    } else throw new BarcodeError(`codeword ${c} is outside ASCII encodation`);
  }
  return { text: Buffer.from(bytes).toString('latin1'), size, corrected };
}

// --- SVG -----------------------------------------------------------------------------------------------------------

const COLOUR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
const checkColour = (c: string) => {
  if (!COLOUR.test(c)) throw new BarcodeError('a colour must be #hex or a plain colour name');
  return c;
};

export interface SvgOptions {
  /** Quiet zone in modules (default 4 for QR, 2 for Data Matrix, 10 for linear). */
  readonly quiet?: number;
  readonly dark?: string;
  readonly light?: string;
  /** Size of one module in user units (default 1). */
  readonly module?: number;
  /** Text read out by a screen reader; escaped. */
  readonly title?: string;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** An SVG for a 2D grid: one path of horizontal runs, so large codes stay small. */
export function gridToSvg(m: Grid, o: SvgOptions = {}): string {
  const q = o.quiet ?? 4;
  const k = o.module ?? 1;
  const n = m.length;
  const dim = (n + 2 * q) * k;
  const d: string[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; ) {
      if (!m[y]![x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < n && m[y]![e]) e++;
      d.push(`M${(x + q) * k} ${(y + q) * k}h${(e - x) * k}v${k}h${-(e - x) * k}z`);
      x = e;
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img"${o.title ? ` aria-label="${esc(o.title)}"` : ''}>${o.title ? `<title>${esc(o.title)}</title>` : ''}<rect width="${dim}" height="${dim}" fill="${checkColour(o.light ?? '#ffffff')}"/><path d="${d.join('')}" fill="${checkColour(o.dark ?? '#000000')}"/></svg>`;
}

/** An SVG for a linear barcode (bars from a module row), with a quiet zone either side. */
export function barsToSvg(mods: readonly boolean[], o: SvgOptions & { height?: number } = {}): string {
  const q = o.quiet ?? 10;
  const k = o.module ?? 1;
  const h = o.height ?? 50;
  const w = (mods.length + 2 * q) * k;
  const d: string[] = [];
  for (let x = 0; x < mods.length; ) {
    if (!mods[x]) {
      x++;
      continue;
    }
    let e = x;
    while (e < mods.length && mods[e]) e++;
    d.push(`M${(x + q) * k} 0h${(e - x) * k}v${h}h${-(e - x) * k}z`);
    x = e;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges" role="img"${o.title ? ` aria-label="${esc(o.title)}"` : ''}>${o.title ? `<title>${esc(o.title)}</title>` : ''}<rect width="${w}" height="${h}" fill="${checkColour(o.light ?? '#ffffff')}"/><path d="${d.join('')}" fill="${checkColour(o.dark ?? '#000000')}"/></svg>`;
}

/** The grid as text rows of "#" and ".", for logs and tests. */
export const gridToText = (m: Grid): string => m.map((r) => r.map((v) => (v ? '#' : '.')).join('')).join('\n');
