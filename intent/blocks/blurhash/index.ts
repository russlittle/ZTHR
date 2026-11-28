/**
 * Instant image placeholders. BLURHASH (Wolt, 2018): a 20 to 30 character string made from a few low-frequency
 * discrete-cosine components of an image, decoded to a blurred bitmap. The algorithm is the published one: base 83
 * with the `0-9A-Za-z#$%*+,-.:;=?@[]^_{|}~` alphabet, a size flag, a quantised maximum, the DC component as 4
 * characters of sRGB and each AC component as 2 characters quantised to 19 levels per channel with a square-root
 * curve, all maths in linear light. THUMBHASH (Evan Wallace, 2022): a 25 byte hash that also keeps the aspect ratio and
 * an alpha channel, in an LPQA colour space (luminance, yellow-blue, red-green, alpha) with a triangular set of DCT
 * terms; decoded to a bitmap of about 32 pixels on the long side. Blurhash is checked against published example hashes;
 * thumbhash round-trips and keeps aspect and alpha, but is not yet checked against the reference implementation's bytes.
 *
 * Pixels are RGBA bytes, row by row (what a canvas or a decoder such as sharp gives). Also here: the dominant (average)
 * colour of either hash without decoding the bitmap, a box-average downscale so a large image can be fed to thumbhash
 * (which wants 100x100 or smaller), and base64 for thumbhash bytes.
 *
 * Hostile or damaged input is refused: a hash of the wrong length or with characters outside the alphabet, component
 * counts outside 1 to 9, sizes that are not whole numbers, pixel buffers that do not match the size, and decoded
 * bitmaps over a million pixels.
 *
 * Out of scope: decoding JPEG or PNG (give pixels), and rendering the bitmap (a canvas or a CSS blur does that).
 */

export class HashError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, row by row. */
  readonly pixels: Uint8ClampedArray;
}
export interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const MAX_PIXELS_ENCODE = 100_000_000;
const MAX_PIXELS_DECODE = 1_000_000;

function checkSize(width: number, height: number, what: string, max: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new HashError(`${what}: width and height must be whole numbers, at least 1`);
  if (width * height > max) throw new HashError(`${what}: ${width}x${height} is more than ${max} pixels`);
}

// ================================================================================================ blurhash

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decode83(s: string): number {
  let v = 0;
  for (const c of s) {
    const i = INDEX.get(c);
    if (i === undefined) throw new HashError(`"${c}" is not a base 83 character`);
    v = v * 83 + i;
  }
  return v;
}
export function encode83(n: number, length: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 83 ** length) throw new HashError(`${n} does not fit in ${length} base 83 characters`);
  let out = '';
  for (let i = 1; i <= length; i++) out += ALPHABET[Math.floor(n / 83 ** (length - i)) % 83];
  return out;
}

const sRGBToLinear = (v: number): number => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const linearTosRGB = (v: number): number => {
  const x = Math.max(0, Math.min(1, v));
  return x <= 0.0031308 ? Math.trunc(x * 12.92 * 255 + 0.5) : Math.trunc((1.055 * x ** (1 / 2.4) - 0.055) * 255 + 0.5);
};
const signPow = (v: number, e: number): number => Math.sign(v) * Math.abs(v) ** e;

export function blurhashEncode(pixels: ArrayLike<number>, width: number, height: number, componentsX = 4, componentsY = 3): string {
  checkSize(width, height, 'blurhash encode', MAX_PIXELS_ENCODE);
  if (pixels.length !== width * height * 4) throw new HashError(`blurhash encode: expected ${width * height * 4} bytes of RGBA for ${width}x${height}, got ${pixels.length}`);
  if (!Number.isInteger(componentsX) || !Number.isInteger(componentsY) || componentsX < 1 || componentsX > 9 || componentsY < 1 || componentsY > 9) throw new HashError('blurhash components must be whole numbers from 1 to 9');
  // linear copy once, instead of per component
  const linear = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) linear[i * 3 + c] = sRGBToLinear(pixels[i * 4 + c] as number);
  const factors: [number, number, number][] = [];
  for (let j = 0; j < componentsY; j++) {
    for (let i = 0; i < componentsX; i++) {
      const norm = i === 0 && j === 0 ? 1 : 2;
      let r = 0, g = 0, b = 0;
      const cosX = Array.from({ length: width }, (_, x) => Math.cos((Math.PI * i * x) / width));
      for (let y = 0; y < height; y++) {
        const cy = Math.cos((Math.PI * j * y) / height);
        for (let x = 0; x < width; x++) {
          const basis = cosX[x] as number * cy;
          const k = (y * width + x) * 3;
          r += basis * (linear[k] as number);
          g += basis * (linear[k + 1] as number);
          b += basis * (linear[k + 2] as number);
        }
      }
      const scale = norm / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }
  const dc = factors[0] as [number, number, number];
  const ac = factors.slice(1);
  let hash = encode83(componentsX - 1 + (componentsY - 1) * 9, 1);
  let maximumValue: number;
  if (ac.length > 0) {
    const actualMax = Math.max(...ac.flatMap((f) => f.map(Math.abs)));
    const quantised = Math.floor(Math.max(0, Math.min(82, Math.floor(actualMax * 166 - 0.5))));
    maximumValue = (quantised + 1) / 166;
    hash += encode83(quantised, 1);
  } else {
    maximumValue = 1;
    hash += encode83(0, 1);
  }
  hash += encode83((linearTosRGB(dc[0]) << 16) + (linearTosRGB(dc[1]) << 8) + linearTosRGB(dc[2]), 4);
  const q = (v: number) => Math.floor(Math.max(0, Math.min(18, Math.floor(signPow(v / maximumValue, 0.5) * 9 + 9.5))));
  for (const f of ac) hash += encode83(q(f[0]) * 19 * 19 + q(f[1]) * 19 + q(f[2]), 2);
  return hash;
}

export interface BlurhashInfo {
  readonly componentsX: number;
  readonly componentsY: number;
}

/** Read the size flag, and check the length and characters, without decoding any colour. */
export function blurhashInfo(hash: string): BlurhashInfo {
  if (typeof hash !== 'string' || hash.length < 6) throw new HashError('a blurhash is at least 6 characters');
  const flag = decode83(hash[0] as string);
  const info = { componentsX: (flag % 9) + 1, componentsY: Math.floor(flag / 9) + 1 };
  const expected = 4 + 2 * info.componentsX * info.componentsY;
  if (hash.length !== expected) throw new HashError(`a ${info.componentsX}x${info.componentsY} blurhash is ${expected} characters, not ${hash.length}`);
  for (const c of hash) if (!INDEX.has(c)) throw new HashError(`"${c}" is not a base 83 character`);
  return info;
}

export function blurhashDecode(hash: string, width: number, height: number, punch = 1): Bitmap {
  checkSize(width, height, 'blurhash decode', MAX_PIXELS_DECODE);
  if (!(punch > 0) || !Number.isFinite(punch)) throw new HashError('punch must be above zero');
  const { componentsX, componentsY } = blurhashInfo(hash);
  const maximumValue = ((decode83(hash[1] as string) + 1) / 166) * punch;
  const colours: [number, number, number][] = [];
  const dcValue = decode83(hash.slice(2, 6));
  colours.push([sRGBToLinear(dcValue >> 16), sRGBToLinear((dcValue >> 8) & 255), sRGBToLinear(dcValue & 255)]);
  for (let i = 1; i < componentsX * componentsY; i++) {
    const v = decode83(hash.slice(4 + i * 2, 6 + i * 2));
    colours.push([signPow((Math.floor(v / 361) - 9) / 9, 2) * maximumValue, signPow(((Math.floor(v / 19) % 19) - 9) / 9, 2) * maximumValue, signPow(((v % 19) - 9) / 9, 2) * maximumValue]);
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  const cosX = Array.from({ length: componentsX }, (_, i) => Array.from({ length: width }, (_, x) => Math.cos((Math.PI * x * i) / width)));
  for (let y = 0; y < height; y++) {
    const cosY = Array.from({ length: componentsY }, (_, j) => Math.cos((Math.PI * y * j) / height));
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < componentsY; j++) {
        for (let i = 0; i < componentsX; i++) {
          const basis = (cosX[i] as number[])[x] as number * (cosY[j] as number);
          const c = colours[i + j * componentsX] as [number, number, number];
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const o = (y * width + x) * 4;
      pixels[o] = linearTosRGB(r);
      pixels[o + 1] = linearTosRGB(g);
      pixels[o + 2] = linearTosRGB(b);
      pixels[o + 3] = 255;
    }
  }
  return { width, height, pixels };
}

/** The average colour of a blurhash: its DC component, read straight from four characters. */
export function blurhashColour(hash: string): Colour {
  blurhashInfo(hash);
  const v = decode83(hash.slice(2, 6));
  return { r: v >> 16, g: (v >> 8) & 255, b: v & 255 };
}

// ================================================================================================ thumbhash

export function thumbhashEncode(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  checkSize(width, height, 'thumbhash encode', 10_000);
  if (width > 100 || height > 100) throw new HashError(`thumbhash encode: ${width}x${height} does not fit in 100x100; use downscale() first`);
  if (rgba.length !== width * height * 4) throw new HashError(`thumbhash encode: expected ${width * height * 4} bytes of RGBA for ${width}x${height}, got ${rgba.length}`);
  const { PI, round, max, cos, abs } = Math;
  let avgR = 0, avgG = 0, avgB = 0, avgA = 0;
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const alpha = (rgba[j + 3] as number) / 255;
    avgR += (alpha / 255) * (rgba[j] as number);
    avgG += (alpha / 255) * (rgba[j + 1] as number);
    avgB += (alpha / 255) * (rgba[j + 2] as number);
    avgA += alpha;
  }
  if (avgA) { avgR /= avgA; avgG /= avgA; avgB /= avgA; }
  const hasAlpha = avgA < width * height;
  const lLimit = hasAlpha ? 5 : 7;
  const lx = max(1, round((lLimit * width) / max(width, height)));
  const ly = max(1, round((lLimit * height) / max(width, height)));
  const n = width * height;
  const l = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n), a = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const alpha = (rgba[j + 3] as number) / 255;
    const r = avgR * (1 - alpha) + (alpha / 255) * (rgba[j] as number);
    const g = avgG * (1 - alpha) + (alpha / 255) * (rgba[j + 1] as number);
    const b = avgB * (1 - alpha) + (alpha / 255) * (rgba[j + 2] as number);
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }
  const encodeChannel = (channel: Float64Array, nx: number, ny: number): [number, number[], number] => {
    let dc = 0;
    const ac: number[] = [];
    let scale = 0;
    const fx = new Float64Array(width);
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < width; x++) fx[x] = cos((PI / width) * cx * (x + 0.5));
        for (let y = 0; y < height; y++) {
          const fy = cos((PI / height) * cy * (y + 0.5));
          for (let x = 0; x < width; x++) f += (channel[x + y * width] as number) * (fx[x] as number) * fy;
        }
        f /= width * height;
        if (cx || cy) { ac.push(f); scale = max(scale, abs(f)); } else dc = f;
      }
    }
    if (scale) for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * (ac[i] as number);
    return [dc, ac, scale];
  };
  const [lDc, lAc, lScale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, 3, 3);
  const alphaPart = hasAlpha ? encodeChannel(a, 5, 5) : undefined;
  const isLandscape = width > height;
  const header24 = round(63 * lDc) | (round(31.5 + 31.5 * pDc) << 6) | (round(31.5 + 31.5 * qDc) << 12) | (round(31 * lScale) << 18) | ((hasAlpha ? 1 : 0) << 23);
  const header16 = (isLandscape ? ly : lx) | (round(63 * pScale) << 3) | (round(63 * qScale) << 9) | ((isLandscape ? 1 : 0) << 15);
  const acStart = hasAlpha ? 6 : 5;
  const lists = hasAlpha ? [lAc, pAc, qAc, (alphaPart as [number, number[], number])[1]] : [lAc, pAc, qAc];
  const total = lists.reduce((s, x) => s + x.length, 0);
  const hash = new Uint8Array(acStart + ((total + 1) >> 1));
  hash[0] = header24 & 255; hash[1] = (header24 >> 8) & 255; hash[2] = header24 >> 16; hash[3] = header16 & 255; hash[4] = header16 >> 8;
  if (alphaPart) hash[5] = round(15 * alphaPart[0]) | (round(15 * alphaPart[2]) << 4);
  let index = 0;
  for (const list of lists) for (const f of list) { hash[acStart + (index >> 1)] = (hash[acStart + (index >> 1)] as number) | (round(15 * f) << ((index++ & 1) << 2)); }
  return hash;
}

function checkThumb(hash: Uint8Array): { hasAlpha: boolean; isLandscape: boolean; lx: number; ly: number; length: number } {
  if (!(hash instanceof Uint8Array) || hash.length < 5) throw new HashError('a thumbhash is at least 5 bytes');
  const hasAlpha = (hash[2] as number) >> 7 === 1;
  const isLandscape = (hash[4] as number) >> 7 === 1;
  const header = hash[3] as number;
  const lx = Math.max(3, isLandscape ? (hasAlpha ? 5 : 7) : header & 7);
  const ly = Math.max(3, isLandscape ? header & 7 : hasAlpha ? 5 : 7);
  const count = (nx: number, ny: number) => { let c = 0; for (let cy = 0; cy < ny; cy++) for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) c++; return c; };
  const total = count(lx, ly) + 2 * 5 + (hasAlpha ? 14 : 0);
  const length = (hasAlpha ? 6 : 5) + ((total + 1) >> 1);
  if (hash.length !== length) throw new HashError(`this thumbhash should be ${length} bytes, not ${hash.length}`);
  return { hasAlpha, isLandscape, lx, ly, length };
}

/** Width over height, roughly: the hash keeps only a few levels. */
export function thumbhashAspectRatio(hash: Uint8Array): number {
  const { hasAlpha, isLandscape } = checkThumb(hash);
  const header = hash[3] as number;
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7;
  return lx / ly;
}

export function thumbhashDecode(hash: Uint8Array): Bitmap {
  const { hasAlpha, lx, ly } = checkThumb(hash);
  const { PI, min, max, cos, round } = Math;
  const header24 = (hash[0] as number) | ((hash[1] as number) << 8) | ((hash[2] as number) << 16);
  const header16 = (hash[3] as number) | ((hash[4] as number) << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const aDc = hasAlpha ? ((hash[5] as number) & 15) / 15 : 1;
  const aScale = ((hash[5] as number) >> 4) / 15;
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  const channel = (nx: number, ny: number, scale: number): number[] => {
    const ac: number[] = [];
    for (let cy = 0; cy < ny; cy++) for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) ac.push(((((hash[acStart + (acIndex >> 1)] as number) >> ((acIndex++ & 1) << 2)) & 15) / 7.5 - 1) * scale);
    return ac;
  };
  const lAc = channel(lx, ly, lScale);
  const pAc = channel(3, 3, pScale * 1.25);
  const qAc = channel(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? channel(5, 5, aScale) : [];
  const ratio = thumbhashAspectRatio(hash);
  const w = round(ratio > 1 ? 32 : 32 * ratio);
  const h = round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const fx: number[] = [];
  const fy: number[] = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc, p = pDc, q = qDc, a = aDc;
      for (let cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++) fx[cx] = cos((PI / w) * (x + 0.5) * cx);
      for (let cy = 0, n = max(ly, hasAlpha ? 5 : 3); cy < n; cy++) fy[cy] = cos((PI / h) * (y + 0.5) * cy);
      for (let cy = 0, j = 0; cy < ly; cy++) for (let cx = cy ? 0 : 1, fy2 = (fy[cy] as number) * 2; cx * ly < lx * (ly - cy); cx++, j++) l += (lAc[j] as number) * (fx[cx] as number) * fy2;
      for (let cy = 0, j = 0; cy < 3; cy++) {
        for (let cx = cy ? 0 : 1, fy2 = (fy[cy] as number) * 2; cx < 3 - cy; cx++, j++) {
          const f = (fx[cx] as number) * fy2;
          p += (pAc[j] as number) * f;
          q += (qAc[j] as number) * f;
        }
      }
      if (hasAlpha) for (let cy = 0, j = 0; cy < 5; cy++) for (let cx = cy ? 0 : 1, fy2 = (fy[cy] as number) * 2; cx < 5 - cy; cx++, j++) a += (aAc[j] as number) * (fx[cx] as number) * fy2;
      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      const g = r - q;
      rgba[i] = max(0, 255 * min(1, r));
      rgba[i + 1] = max(0, 255 * min(1, g));
      rgba[i + 2] = max(0, 255 * min(1, b));
      rgba[i + 3] = max(0, 255 * min(1, a));
    }
  }
  return { width: w, height: h, pixels: rgba };
}

/** The average colour and opacity of a thumbhash, from its first bytes. */
export function thumbhashColour(hash: Uint8Array): Colour & { a: number } {
  const { hasAlpha } = checkThumb(hash);
  const header = (hash[0] as number) | ((hash[1] as number) << 8) | ((hash[2] as number) << 16);
  const l = (header & 63) / 63;
  const p = ((header >> 6) & 63) / 31.5 - 1;
  const q = ((header >> 12) & 63) / 31.5 - 1;
  const b = l - (2 / 3) * p;
  const r = (3 * l - b + q) / 2;
  const g = r - q;
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return { r: c(r), g: c(g), b: c(b), a: hasAlpha ? ((hash[5] as number) & 15) / 15 : 1 };
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}
export function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new HashError('not base64');
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/** Shrink an RGBA image by averaging boxes of pixels (alpha-weighted), so its longer side is at most `maxSide`. */
export function downscale(rgba: ArrayLike<number>, width: number, height: number, maxSide = 100): Bitmap {
  checkSize(width, height, 'downscale', MAX_PIXELS_ENCODE);
  if (rgba.length !== width * height * 4) throw new HashError(`downscale: expected ${width * height * 4} bytes, got ${rgba.length}`);
  if (!Number.isInteger(maxSide) || maxSide < 1) throw new HashError('maxSide must be a whole number, at least 1');
  const f = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * f));
  const h = Math.max(1, Math.round(height * f));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const o = (yy * width + xx) * 4;
        const al = rgba[o + 3] as number;
        r += (rgba[o] as number) * al; g += (rgba[o + 1] as number) * al; b += (rgba[o + 2] as number) * al; a += al; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, pixels: out };
}
