/**
 * Reads and writes raster images without a native library. PNG (RFC 2083 / ISO 15948): every colour type and bit
 * depth (1-16), palettes with tRNS transparency, the five scanline filters, Adam7 interlacing, chunk CRCs checked,
 * and unknown critical chunks refused; writing picks the smallest colour type that holds the image (grey, palette
 * of 1/2/4/8 bits, RGB or RGBA) and chooses each row's filter by the least-sum-of-differences rule. BMP: 1, 4, 8,
 * 24 and 32 bit uncompressed (BI_RGB and 32-bit BI_BITFIELDS), bottom-up or top-down, written as 24-bit or 32-bit
 * with alpha. GIF: the first frame of GIF87a/GIF89a with local or global palette, transparency and interlacing,
 * LZW decoding bounded by the image size; written as one frame with a palette of up to 256 colours.
 *
 * Every decoder takes a pixel limit and checks the declared size against it before allocating, inflates PNG data
 * with an exact output ceiling computed from the header (so a decompression bomb stops at the ceiling), and refuses
 * truncated or inconsistent files with a typed error. Decoded images are always 8-bit RGBA, straight alpha;
 * 16-bit samples keep their high byte. It uses the imagemeta block to identify the format and refuse oversize
 * images before decoding.
 *
 * Out of scope: colour management (gAMA, iCCP, cHRM are ignored), animation (only the first GIF frame is
 * decoded; the frame count is reported), RLE-compressed BMP, and APNG frames beyond the default image.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { inspect, sniff } from '../imagemeta/index.ts';

export class ImageError extends Error {}

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, rows top to bottom, straight (not premultiplied) alpha. */
  readonly data: Uint8Array;
}

export type Format = 'png' | 'bmp' | 'gif';

export interface Limits {
  /** Most pixels accepted (default 25,000,000). */
  readonly maxPixels?: number;
}

const DEFAULT_MAX = 25_000_000;

const checkSize = (w: number, h: number, max: number) => {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new ImageError('the image has no size');
  if (w * h > max) throw new ImageError(`${w}x${h} is more than the ${max} pixel limit`);
};

export function detect(b: Uint8Array): Format | undefined {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const k = sniff(buf);
  if (k === 'png' || k === 'gif') return k;
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return undefined;
}

export interface Decoded {
  readonly format: Format;
  readonly image: Image;
  readonly info: { readonly bitDepth: number; readonly colorType: string; readonly interlaced: boolean; readonly hasAlpha: boolean; readonly frames?: number };
}

/** Decodes a PNG, BMP or GIF by what its bytes are, whatever its name says. */
export function decode(b: Uint8Array, o: Limits = {}): Decoded {
  const f = detect(b);
  if (f === 'png') return decodePng(b, o);
  if (f === 'bmp') return decodeBmp(b, o);
  if (f === 'gif') return decodeGif(b, o);
  throw new ImageError('this is not a PNG, BMP or GIF image');
}

// --- PNG ------------------------------------------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const COLOR_NAMES: Record<number, string> = { 0: 'gray', 2: 'rgb', 3: 'palette', 4: 'gray-alpha', 6: 'rgba' };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(b: Uint8Array, o: Limits = {}): Decoded {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const max = o.maxPixels ?? DEFAULT_MAX;
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new ImageError('this is not a PNG');
  try {
    inspect(buf, { maxPixels: max });
  } catch (e) {
    throw new ImageError((e as Error).message);
  }
  let pos = 8;
  let ihdr: { w: number; h: number; depth: number; color: number; interlace: number } | undefined;
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  let sawIdat = false;
  let idatDone = false;
  let ended = false;
  let first = true;
  while (pos < buf.length && !ended) {
    if (pos + 12 > buf.length) throw new ImageError('the PNG is cut short');
    const len = buf.readUInt32BE(pos);
    if (len > 0x7fffffff) throw new ImageError('a chunk length is out of range');
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageError('a chunk type is not letters');
    if (pos + 12 + len > buf.length) throw new ImageError('the PNG is cut short');
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) throw new ImageError(`the ${type} chunk fails its CRC check`);
    pos += 12 + len;
    if (first && type !== 'IHDR') throw new ImageError('the first chunk is not IHDR');
    first = false;
    if (type === 'IHDR') {
      if (ihdr || len !== 13) throw new ImageError('the IHDR chunk is wrong');
      ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8]!, color: body[9]!, interlace: body[12]! };
      if (body[10] !== 0 || body[11] !== 0) throw new ImageError('unknown compression or filter method');
      if (ihdr.interlace > 1) throw new ImageError('unknown interlace method');
      if (!DEPTHS[ihdr.color]?.includes(ihdr.depth)) throw new ImageError(`colour type ${ihdr.color} cannot have bit depth ${ihdr.depth}`);
      checkSize(ihdr.w, ihdr.h, max);
    } else if (type === 'PLTE') {
      if (sawIdat) throw new ImageError('PLTE comes after the image data');
      if (plte) throw new ImageError('more than one PLTE');
      if (len === 0 || len % 3 !== 0 || len > 768 || (ihdr && len / 3 > 2 ** ihdr.depth)) throw new ImageError('the palette has an invalid size');
      if (ihdr && (ihdr.color === 0 || ihdr.color === 4)) throw new ImageError('a grey image cannot have a palette');
      plte = Buffer.from(body);
    } else if (type === 'tRNS') {
      if (sawIdat) throw new ImageError('tRNS comes after the image data');
      trns = Buffer.from(body);
    } else if (type === 'IDAT') {
      if (idatDone) throw new ImageError('image data is split by another chunk');
      sawIdat = true;
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      ended = true;
    } else {
      if (sawIdat) idatDone = true;
      if (type[0]! >= 'A' && type[0]! <= 'Z') throw new ImageError(`the critical chunk ${type} is not understood`);
    }
    if (type !== 'IDAT' && sawIdat) idatDone = true;
  }
  if (!ihdr) throw new ImageError('there is no IHDR');
  if (!ended) throw new ImageError('there is no IEND');
  if (!sawIdat) throw new ImageError('there is no image data');
  if (ihdr.color === 3 && !plte) throw new ImageError('a palette image has no palette');
  const { w, h, depth, color } = ihdr;
  const ch = CHANNELS[color]!;
  const bitsPerPixel = ch * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = ihdr.interlace ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const dims = passes.map(([xs, ys, dx, dy]) => ({ xs, ys, dx, dy, pw: w > xs ? Math.ceil((w - xs) / dx) : 0, ph: h > ys ? Math.ceil((h - ys) / dy) : 0 }));
  let expected = 0;
  for (const d of dims) if (d.pw > 0 && d.ph > 0) expected += d.ph * (1 + Math.ceil((d.pw * bitsPerPixel) / 8));
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: Math.max(expected, 1) });
  } catch (e) {
    const m = (e as Error).message;
    throw new ImageError(/larger than|maxOutputLength|Cannot create a Buffer/.test(m) ? 'the image data inflates to more than its header allows' : `the image data cannot be inflated: ${m}`);
  }
  if (raw.length !== expected) throw new ImageError(`the image data is ${raw.length} bytes where ${expected} were expected`);
  const out = new Uint8Array(w * h * 4);
  const trnsKey = (() => {
    if (!trns) return undefined;
    if (color === 0 && trns.length === 2) return [trns.readUInt16BE(0)];
    if (color === 2 && trns.length === 6) return [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)];
    return undefined;
  })();
  const maxv = 2 ** depth - 1;
  const scale8 = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxv));
  let off = 0;
  for (const d of dims) {
    if (d.pw === 0 || d.ph === 0) continue;
    const stride = Math.ceil((d.pw * bitsPerPixel) / 8);
    let prev: Buffer = Buffer.alloc(stride);
    for (let y = 0; y < d.ph; y++) {
      const ft = raw[off++]!;
      const line = Buffer.from(raw.subarray(off, off + stride));
      off += stride;
      if (ft > 4) throw new ImageError(`unknown filter type ${ft}`);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const up = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        const add = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? up : ft === 3 ? (a + up) >> 1 : paeth(a, up, c);
        line[i] = (line[i]! + add) & 255;
      }
      const sample = (idx: number) => {
        // idx counts samples across the row
        if (depth === 8) return line[idx]!;
        if (depth === 16) return (line[idx * 2]! << 8) | line[idx * 2 + 1]!;
        const bit = idx * depth;
        return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & maxv;
      };
      const oy = d.ys + y * d.dy;
      for (let x = 0; x < d.pw; x++) {
        const ox = d.xs + x * d.dx;
        const p = (oy * w + ox) * 4;
        let r: number;
        let g: number;
        let bl: number;
        let a = 255;
        if (color === 0) {
          const v = sample(x);
          r = g = bl = scale8(v);
          if (trnsKey && v === trnsKey[0]) a = 0;
        } else if (color === 2) {
          const sr = sample(x * 3);
          const sg = sample(x * 3 + 1);
          const sb = sample(x * 3 + 2);
          r = scale8(sr);
          g = scale8(sg);
          bl = scale8(sb);
          if (trnsKey && sr === trnsKey[0] && sg === trnsKey[1] && sb === trnsKey[2]) a = 0;
        } else if (color === 3) {
          const i = sample(x);
          if (i * 3 + 2 >= plte!.length) throw new ImageError('a pixel points past the end of the palette');
          r = plte![i * 3]!;
          g = plte![i * 3 + 1]!;
          bl = plte![i * 3 + 2]!;
          if (trns && i < trns.length) a = trns[i]!;
        } else if (color === 4) {
          r = g = bl = scale8(sample(x * 2));
          a = scale8(sample(x * 2 + 1));
        } else {
          r = scale8(sample(x * 4));
          g = scale8(sample(x * 4 + 1));
          bl = scale8(sample(x * 4 + 2));
          a = scale8(sample(x * 4 + 3));
        }
        out[p] = r;
        out[p + 1] = g;
        out[p + 2] = bl;
        out[p + 3] = a;
      }
      prev = line;
    }
  }
  return { format: 'png', image: { width: w, height: h, data: out }, info: { bitDepth: depth, colorType: COLOR_NAMES[color]!, interlaced: ihdr.interlace === 1, hasAlpha: color === 4 || color === 6 || trns !== undefined } };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export interface PngOptions {
  /** zlib level 0-9 (default 6). */
  readonly level?: number;
  /** A fixed filter 0-4 for every row, or "adaptive" (default). */
  readonly filter?: 'adaptive' | 0 | 1 | 2 | 3 | 4;
  /** Keep the colour type RGBA even when a smaller one would hold the image. */
  readonly keepRgba?: boolean;
}

export function encodePng(img: Image, o: PngOptions = {}): Buffer {
  checkImage(img);
  const { width: w, height: h, data } = img;
  const px = w * h;
  let opaque = true;
  let gray = true;
  const colours = new Map<number, number>();
  for (let i = 0; i < px; i++) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const bl = data[i * 4 + 2]!;
    const a = data[i * 4 + 3]!;
    if (a !== 255) opaque = false;
    if (r !== g || g !== bl) gray = false;
    if (colours.size <= 256) {
      const key = ((r << 24) | (g << 16) | (bl << 8) | a) >>> 0;
      if (!colours.has(key)) colours.set(key, colours.size);
    }
  }
  let color: number;
  let depth = 8;
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  if (o.keepRgba) color = 6;
  else if (gray && opaque) color = 0;
  else if (colours.size <= 256) {
    color = 3;
    const keys = [...colours.keys()];
    plte = Buffer.alloc(keys.length * 3);
    const alphas = Buffer.alloc(keys.length);
    keys.forEach((k, i) => {
      plte![i * 3] = k >>> 24;
      plte![i * 3 + 1] = (k >>> 16) & 255;
      plte![i * 3 + 2] = (k >>> 8) & 255;
      alphas[i] = k & 255;
    });
    let last = alphas.length;
    while (last > 0 && alphas[last - 1] === 255) last--;
    if (last > 0) trns = alphas.subarray(0, last);
    depth = keys.length <= 2 ? 1 : keys.length <= 4 ? 2 : keys.length <= 16 ? 4 : 8;
  } else color = opaque ? 2 : 6;
  if (color === 0) {
    const levels = new Set<number>();
    for (let i = 0; i < px; i++) levels.add(data[i * 4]!);
    // 1, 2 and 4 bit grey only when every level is exactly representable
    for (const d of [1, 2, 4]) {
      const step = 255 / (2 ** d - 1);
      if ([...levels].every((v) => Number.isInteger(v / step))) {
        depth = d;
        break;
      }
    }
  }
  const ch = CHANNELS[color]!;
  const bitsPerPixel = ch * depth;
  const stride = Math.ceil((w * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = data[p]!;
      const g = data[p + 1]!;
      const bl = data[p + 2]!;
      const a = data[p + 3]!;
      if (color === 0 || color === 3) {
        const v = color === 3 ? colours.get(((r << 24) | (g << 16) | (bl << 8) | a) >>> 0)! : Math.round(r / (255 / (2 ** depth - 1)));
        if (depth === 8) line[x] = v;
        else {
          const bit = x * depth;
          line[bit >> 3] = line[bit >> 3]! | (v << (8 - depth - (bit & 7)));
        }
      } else if (color === 2) {
        line[x * 3] = r;
        line[x * 3 + 1] = g;
        line[x * 3 + 2] = bl;
      } else {
        line[x * 4] = r;
        line[x * 4 + 1] = g;
        line[x * 4 + 2] = bl;
        line[x * 4 + 3] = a;
      }
    }
    rows.push(line);
  }
  const filtered: Buffer[] = [];
  let prev: Buffer = Buffer.alloc(stride);
  for (const line of rows) {
    const tryType = (ft: number) => {
      const out = Buffer.alloc(stride + 1);
      out[0] = ft;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const up = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? up : ft === 3 ? (a + up) >> 1 : paeth(a, up, c);
        out[i + 1] = (line[i]! - pred) & 255;
      }
      return out;
    };
    if (o.filter !== undefined && o.filter !== 'adaptive') filtered.push(tryType(o.filter));
    else {
      let best: Buffer | undefined;
      let bestScore = Infinity;
      for (let ft = 0; ft < 5; ft++) {
        const cand = tryType(ft);
        let score = 0;
        for (let i = 1; i < cand.length; i++) score += cand[i]! < 128 ? cand[i]! : 256 - cand[i]!;
        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      filtered.push(best!);
    }
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = color;
  const parts = [PNG_SIG, chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', deflateSync(Buffer.concat(filtered), { level: o.level ?? 6 })), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function checkImage(img: Image): void {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1) throw new ImageError('the image has no size');
  if (img.data.length !== img.width * img.height * 4) throw new ImageError('the pixel data is not width x height x 4 bytes');
}

// --- BMP ------------------------------------------------------------------------------------------------------------

export function decodeBmp(b: Uint8Array, o: Limits = {}): Decoded {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const max = o.maxPixels ?? DEFAULT_MAX;
  if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw new ImageError('this is not a BMP');
  const dataOffset = buf.readUInt32LE(10);
  const hsize = buf.readUInt32LE(14);
  let w: number;
  let hRaw: number;
  let bpp: number;
  let compression = 0;
  let colorsUsed = 0;
  let paletteEntry = 4;
  if (hsize === 12) {
    w = buf.readUInt16LE(18);
    hRaw = buf.readInt16LE(20);
    bpp = buf.readUInt16LE(24);
    paletteEntry = 3;
  } else if (hsize >= 40) {
    if (buf.length < 14 + 40) throw new ImageError('the BMP is cut short');
    w = buf.readInt32LE(18);
    hRaw = buf.readInt32LE(22);
    bpp = buf.readUInt16LE(28);
    compression = buf.readUInt32LE(30);
    colorsUsed = buf.readUInt32LE(46);
  } else throw new ImageError('the BMP header is not a known size');
  if (buf.length < 14 + hsize) throw new ImageError('the BMP is cut short');
  if (w < 1) throw new ImageError('the BMP has no width');
  const topDown = hRaw < 0;
  const h = Math.abs(hRaw);
  checkSize(w, h, max);
  if (![1, 4, 8, 24, 32].includes(bpp)) throw new ImageError(`${bpp} bits per pixel is not supported`);
  if (compression !== 0 && !(compression === 3 && bpp === 32)) throw new ImageError(`BMP compression ${compression} is not supported`);
  let masks = [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];
  if (compression === 3) {
    if (hsize >= 52) masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), hsize >= 56 ? buf.readUInt32LE(66) : 0];
    else masks = [buf.readUInt32LE(14 + hsize), buf.readUInt32LE(18 + hsize), buf.readUInt32LE(22 + hsize), 0];
  }
  let palette: Buffer | undefined;
  if (bpp <= 8) {
    const n = colorsUsed || 2 ** bpp;
    if (n > 2 ** bpp) throw new ImageError('the palette is larger than the bit depth allows');
    const start = 14 + hsize;
    if (start + n * paletteEntry > buf.length) throw new ImageError('the BMP is cut short');
    palette = buf.subarray(start, start + n * paletteEntry);
  }
  const stride = Math.ceil((w * bpp) / 32) * 4;
  if (dataOffset + stride * h > buf.length || dataOffset < 14 + hsize) throw new ImageError('the BMP pixel data is cut short or overlaps the header');
  const out = new Uint8Array(w * h * 4);
  let anyAlpha = false;
  const shiftOf = (m: number) => {
    if (!m) return { s: 0, n: 0 };
    let s = 0;
    while (!((m >>> s) & 1)) s++;
    let n = 0;
    while ((m >>> (s + n)) & 1) n++;
    return { s, n };
  };
  const mk = masks.map(shiftOf);
  const chan = (v: number, i: number) => (mk[i]!.n === 0 ? 255 : Math.round((((v & masks[i]!) >>> mk[i]!.s) * 255) / (2 ** mk[i]!.n - 1)));
  for (let y = 0; y < h; y++) {
    const row = dataOffset + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (bpp === 24) {
        out[p] = buf[row + x * 3 + 2]!;
        out[p + 1] = buf[row + x * 3 + 1]!;
        out[p + 2] = buf[row + x * 3]!;
        out[p + 3] = 255;
      } else if (bpp === 32) {
        const v = buf.readUInt32LE(row + x * 4);
        if (compression === 3) {
          out[p] = chan(v, 0);
          out[p + 1] = chan(v, 1);
          out[p + 2] = chan(v, 2);
          out[p + 3] = chan(v, 3);
          if (masks[3]) anyAlpha = true;
        } else {
          out[p] = (v >>> 16) & 255;
          out[p + 1] = (v >>> 8) & 255;
          out[p + 2] = v & 255;
          out[p + 3] = v >>> 24;
          if (v >>> 24) anyAlpha = true;
        }
      } else {
        const per = 8 / bpp;
        const byte = buf[row + Math.floor(x / per)]!;
        const idx = (byte >> (8 - bpp - (x % per) * bpp)) & (2 ** bpp - 1);
        if (idx * paletteEntry + 2 >= palette!.length) throw new ImageError('a pixel points past the end of the palette');
        out[p] = palette![idx * paletteEntry + 2]!;
        out[p + 1] = palette![idx * paletteEntry + 1]!;
        out[p + 2] = palette![idx * paletteEntry]!;
        out[p + 3] = 255;
      }
    }
  }
  // 32-bit BI_RGB with every alpha byte zero means "no alpha channel".
  if (bpp === 32 && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { format: 'bmp', image: { width: w, height: h, data: out }, info: { bitDepth: bpp, colorType: bpp <= 8 ? 'palette' : bpp === 24 ? 'rgb' : 'rgba', interlaced: false, hasAlpha: bpp === 32 && anyAlpha } };
}

/** 24-bit when opaque, 32-bit with alpha (BITMAPV4 header) otherwise; bottom-up rows. */
export function encodeBmp(img: Image): Buffer {
  checkImage(img);
  const { width: w, height: h, data } = img;
  const opaque = (() => {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
    return true;
  })();
  const bpp = opaque ? 24 : 32;
  const hsize = opaque ? 40 : 108;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const offset = 14 + hsize;
  const size = offset + stride * h;
  const out = Buffer.alloc(size);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(offset, 10);
  out.writeUInt32LE(hsize, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bpp, 28);
  out.writeUInt32LE(opaque ? 0 : 3, 30);
  out.writeUInt32LE(stride * h, 34);
  if (!opaque) {
    out.writeUInt32LE(0x00ff0000, 54);
    out.writeUInt32LE(0x0000ff00, 58);
    out.writeUInt32LE(0x000000ff, 62);
    out.writeUInt32LE(0xff000000, 66);
    out.write('Win ', 70, 'latin1');
  }
  for (let y = 0; y < h; y++) {
    const row = offset + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const q = row + x * (bpp / 8);
      out[q] = data[p + 2]!;
      out[q + 1] = data[p + 1]!;
      out[q + 2] = data[p]!;
      if (!opaque) out[q + 3] = data[p + 3]!;
    }
  }
  return out;
}

// --- GIF ------------------------------------------------------------------------------------------------------------

function lzwDecode(data: Buffer, minCode: number, expected: number): Uint8Array {
  if (minCode < 2 || minCode > 8) throw new ImageError('the GIF LZW code size is invalid');
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const out = new Uint8Array(expected);
  let n = 0;
  let size = minCode + 1;
  let next = eoi + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lens = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    lens[i] = 1;
    prefix[i] = -1;
  }
  let bits = 0;
  let acc = 0;
  let prev = -1;
  let p = 0;
  const emit = (code: number) => {
    const len = lens[code]!;
    if (n + len > expected) throw new ImageError('the GIF has more pixel data than its size');
    let c = code;
    for (let i = len - 1; i >= 0; i--) {
      out[n + i] = suffix[c]!;
      c = prefix[c]!;
    }
    n += len;
  };
  const firstOf = (code: number) => {
    let c = code;
    while (prefix[c]! >= 0) c = prefix[c]!;
    return suffix[c]!;
  };
  for (;;) {
    while (bits < size && p < data.length) {
      acc |= data[p++]! << bits;
      bits += 8;
    }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCode + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev === -1) {
      if (code >= clear) throw new ImageError('the GIF LZW data starts with a bad code');
      emit(code);
      prev = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = firstOf(code);
        lens[next] = lens[prev]! + 1;
        next++;
      }
    } else if (code === next && next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstOf(prev);
      lens[next] = lens[prev]! + 1;
      next++;
      emit(code);
    } else throw new ImageError('the GIF LZW data has a code that is not in the table');
    prev = code;
    if (next === 1 << size && size < 12) size++;
  }
  if (n < expected) throw new ImageError('the GIF has less pixel data than its size');
  return out;
}

export function decodeGif(b: Uint8Array, o: Limits = {}): Decoded {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const max = o.maxPixels ?? DEFAULT_MAX;
  if (buf.length < 13 || !/^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) throw new ImageError('this is not a GIF');
  const sw = buf.readUInt16LE(6);
  const sh = buf.readUInt16LE(8);
  checkSize(sw, sh, max);
  const flags = buf[10]!;
  let pos = 13;
  let global: Buffer | undefined;
  if (flags & 0x80) {
    const n = 3 * 2 ** ((flags & 7) + 1);
    if (pos + n > buf.length) throw new ImageError('the GIF is cut short');
    global = buf.subarray(pos, pos + n);
    pos += n;
  }
  let transparent = -1;
  let frames = 0;
  let result: { out: Uint8Array; interlaced: boolean; anyTransparent: boolean } | undefined;
  const subBlocks = () => {
    const parts: Buffer[] = [];
    for (;;) {
      if (pos >= buf.length) throw new ImageError('the GIF is cut short');
      const n = buf[pos++]!;
      if (n === 0) return Buffer.concat(parts);
      if (pos + n > buf.length) throw new ImageError('the GIF is cut short');
      parts.push(buf.subarray(pos, pos + n));
      pos += n;
    }
  };
  while (pos < buf.length) {
    const t = buf[pos++]!;
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = buf[pos++];
      const blocks = subBlocks();
      if (label === 0xf9 && blocks.length >= 4) transparent = blocks[0]! & 1 ? blocks[3]! : -1;
    } else if (t === 0x2c) {
      if (pos + 9 > buf.length) throw new ImageError('the GIF is cut short');
      const left = buf.readUInt16LE(pos);
      const top = buf.readUInt16LE(pos + 2);
      const w = buf.readUInt16LE(pos + 4);
      const h = buf.readUInt16LE(pos + 6);
      const f = buf[pos + 8]!;
      pos += 9;
      let pal = global;
      if (f & 0x80) {
        const n = 3 * 2 ** ((f & 7) + 1);
        if (pos + n > buf.length) throw new ImageError('the GIF is cut short');
        pal = buf.subarray(pos, pos + n);
        pos += n;
      }
      const minCode = buf[pos++]!;
      const lzw = subBlocks();
      frames++;
      if (!result) {
        if (!pal) throw new ImageError('the GIF has no palette');
        checkSize(w, h, max);
        if (left + w > sw || top + h > sh) throw new ImageError('the frame is outside the GIF screen');
        const idx = lzwDecode(lzw, minCode, w * h);
        const interlaced = (f & 0x40) !== 0;
        const rows: number[] = [];
        if (interlaced) for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) for (let y = start; y < h; y += step) rows.push(y);
        else for (let y = 0; y < h; y++) rows.push(y);
        const out = new Uint8Array(sw * sh * 4);
        let anyT = false;
        rows.forEach((y, i) => {
          for (let x = 0; x < w; x++) {
            const c = idx[i * w + x]!;
            const p = ((top + y) * sw + left + x) * 4;
            if (c * 3 + 2 >= pal!.length) throw new ImageError('a pixel points past the end of the palette');
            if (c === transparent) {
              anyT = true;
              continue;
            }
            out[p] = pal![c * 3]!;
            out[p + 1] = pal![c * 3 + 1]!;
            out[p + 2] = pal![c * 3 + 2]!;
            out[p + 3] = 255;
          }
        });
        result = { out, interlaced, anyTransparent: anyT };
      }
      transparent = -1;
    } else throw new ImageError(`unknown GIF block 0x${t.toString(16)}`);
  }
  if (!result) throw new ImageError('the GIF has no image');
  return { format: 'gif', image: { width: sw, height: sh, data: result.out }, info: { bitDepth: 8, colorType: 'palette', interlaced: result.interlaced, hasAlpha: result.anyTransparent, frames } };
}

/** One frame, palette of up to 256 colours; pixels with alpha 0 become the transparent index, other partial alpha is refused. */
export function encodeGif(img: Image): Buffer {
  checkImage(img);
  const { width: w, height: h, data } = img;
  if (w > 65535 || h > 65535) throw new ImageError('a GIF is at most 65535 pixels either way');
  const colours = new Map<number, number>();
  const list: number[] = [];
  let hasT = false;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3]!;
    if (a === 0) {
      hasT = true;
      continue;
    }
    if (a !== 255) throw new ImageError('a GIF has no partial transparency: alpha must be 0 or 255');
    const key = (data[i * 4]! << 16) | (data[i * 4 + 1]! << 8) | data[i * 4 + 2]!;
    if (!colours.has(key)) {
      colours.set(key, list.length);
      list.push(key);
    }
  }
  const total = list.length + (hasT ? 1 : 0);
  if (total > 256) throw new ImageError(`${total} colours do not fit a GIF palette of 256`);
  const tIndex = hasT ? list.length : -1;
  let bitsN = 1;
  while (2 ** bitsN < Math.max(2, total)) bitsN++;
  const palette = Buffer.alloc(3 * 2 ** bitsN);
  list.forEach((k, i) => {
    palette[i * 3] = k >> 16;
    palette[i * 3 + 1] = (k >> 8) & 255;
    palette[i * 3 + 2] = k & 255;
  });
  const idx = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) idx[i] = data[i * 4 + 3] === 0 ? tIndex : colours.get((data[i * 4]! << 16) | (data[i * 4 + 1]! << 8) | data[i * 4 + 2]!)!;
  const minCode = Math.max(2, bitsN);
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(w, 6);
  header.writeUInt16LE(h, 8);
  header[10] = 0x80 | ((bitsN - 1) << 4) | (bitsN - 1);
  const parts: Buffer[] = [header, palette];
  if (hasT) parts.push(Buffer.from([0x21, 0xf9, 4, 1, 0, 0, tIndex, 0]));
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(w, 5);
  desc.writeUInt16LE(h, 7);
  parts.push(desc, Buffer.from([minCode]));
  const lzw = lzwEncode(idx, minCode);
  for (let i = 0; i < lzw.length; i += 255) {
    const n = Math.min(255, lzw.length - i);
    parts.push(Buffer.from([n]), lzw.subarray(i, i + n));
  }
  parts.push(Buffer.from([0, 0x3b]));
  return Buffer.concat(parts);
}

function lzwEncode(idx: Uint8Array, minCode: number): Buffer {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  let size = minCode + 1;
  const put = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let table = new Map<number, number>();
  let next = eoi + 1;
  put(clear);
  let cur = -1;
  for (const px of idx) {
    if (cur === -1) {
      cur = px;
      continue;
    }
    const key = cur * 256 + px;
    const hit = table.get(key);
    if (hit !== undefined) cur = hit;
    else {
      put(cur);
      if (next < 4096) {
        table.set(key, next++);
        if (next - 1 === 1 << size && size < 12) size++;
      } else {
        put(clear);
        table = new Map();
        next = eoi + 1;
        size = minCode + 1;
      }
      cur = px;
    }
  }
  if (cur !== -1) put(cur);
  put(eoi);
  if (bits > 0) out.push(acc & 255);
  return Buffer.from(out);
}
