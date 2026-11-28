/**
 * Thumbnails and other derivatives of an image, planned and resized in plain TypeScript on raw RGBA pixel buffers.
 * It holds: the resize kernels (nearest, box, bilinear, bicubic as Catmull-Rom, Lanczos 3), applied separably with
 * the kernel widened by the reduction factor so shrinking averages instead of skipping pixels, on premultiplied
 * alpha so a transparent edge never bleeds its hidden colour; EXIF orientation applied to the pixels; the fit modes
 * (contain, cover with a focal point, fill, inside, pad) planned as an exact crop and size before any pixel is
 * touched; a spec that is normalised and bounded so a client cannot ask for unlimited variants; a derivative cache
 * key that is the same for every way of asking for the same picture and changes when the source changes; the
 * output format chosen from the Accept header; and a PNG codec (zlib from node:zlib, CRCs checked, interlacing and
 * decompression bombs refused) so the whole path from bytes to bytes works with no libraries.
 *
 * A `Thumbnailer` ties these to the cache block: one render per key however many callers ask at once, failures not
 * cached, and every derivative of a source dropped together when it changes.
 *
 * Out of scope: decoding and encoding JPEG, WebP, AVIF and GIF. Those codecs are injected (`decoders` and
 * `encoders`); only PNG is built in. Colour management is not done; pixels are resized as stored (sRGB assumed).
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Cache } from '../cache/index.ts';
import { inspect } from '../imagemeta/index.ts';
import type { Kind } from '../imagemeta/index.ts';

export class Refused extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** 8-bit RGBA, row by row, not premultiplied. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export const MAX_SOURCE_PIXELS = 100_000_000;

export function raster(width: number, height: number, fill: readonly [number, number, number, number] = [0, 0, 0, 0]): Raster {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Refused('an image needs a whole width and height of at least 1');
  if (width * height > MAX_SOURCE_PIXELS) throw new Refused(`${width}x${height} is more pixels than this will handle`);
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill.some((v) => v !== 0)) for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}

// ---------------------------------------------------------------- kernels

export type Kernel = 'nearest' | 'box' | 'bilinear' | 'bicubic' | 'lanczos3';
export const KERNELS: readonly Kernel[] = ['nearest', 'box', 'bilinear', 'bicubic', 'lanczos3'];

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const FILTERS: Record<Exclude<Kernel, 'nearest'>, { support: number; fn: (x: number) => number }> = {
  box: { support: 0.5, fn: (x) => (x > -0.5 && x <= 0.5 ? 1 : 0) },
  bilinear: { support: 1, fn: (x) => (Math.abs(x) < 1 ? 1 - Math.abs(x) : 0) },
  bicubic: {
    support: 2,
    fn: (x) => {
      const a = -0.5;
      const t = Math.abs(x);
      if (t < 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
      if (t < 2) return (((t - 5) * t + 8) * t - 4) * a;
      return 0;
    },
  },
  lanczos3: { support: 3, fn: (x) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0) },
};

interface Taps {
  /** First source index for each output index. */
  readonly start: Int32Array;
  readonly count: Int32Array;
  readonly weights: Float64Array;
  readonly stride: number;
}

/** For each output index, which source samples contribute and with what weight; weights sum to 1. */
function taps(inSize: number, outSize: number, kernel: Exclude<Kernel, 'nearest'>): Taps {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const f = FILTERS[kernel];
  const support = f.support * filterScale;
  const stride = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const weights = new Float64Array(outSize * stride);
  for (let i = 0; i < outSize; i++) {
    const center = (i + 0.5) * scale;
    const lo = Math.max(0, Math.floor(center - support + 0.5));
    const hi = Math.min(inSize, Math.floor(center + support + 0.5));
    let sum = 0;
    const n = Math.max(1, hi - lo);
    for (let j = 0; j < n; j++) {
      const w = f.fn((lo + j + 0.5 - center) / filterScale);
      weights[i * stride + j] = w;
      sum += w;
    }
    if (sum === 0) {
      // Degenerate (a box narrower than one sample): take the nearest sample.
      weights[i * stride] = 1;
      start[i] = Math.min(inSize - 1, Math.max(0, Math.floor(center)));
      count[i] = 1;
      continue;
    }
    for (let j = 0; j < n; j++) weights[i * stride + j]! /= sum;
    start[i] = lo;
    count[i] = n;
  }
  return { start, count, weights, stride };
}

const clamp8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.floor(v + 0.5));

/** Resizes to exactly `width` by `height`. Alpha is premultiplied for the arithmetic and restored after. */
export function resize(src: Raster, width: number, height: number, kernel: Kernel = 'lanczos3'): Raster {
  if (!KERNELS.includes(kernel)) throw new Refused(`unknown kernel ${String(kernel)}`);
  const out = raster(width, height);
  if (kernel === 'nearest') {
    for (let y = 0; y < height; y++) {
      const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / width));
        const s = (sy * src.width + sx) * 4;
        out.data.set(src.data.subarray(s, s + 4), (y * width + x) * 4);
      }
    }
    return out;
  }
  if (width === src.width && height === src.height) {
    out.data.set(src.data);
    return out;
  }
  const hx = taps(src.width, width, kernel);
  const vy = taps(src.height, height, kernel);
  // Horizontal pass into floating point, premultiplied.
  const mid = new Float64Array(width * src.height * 4);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const base = x * hx.stride;
      const s0 = hx.start[x]!;
      for (let j = 0; j < hx.count[x]!; j++) {
        const w = hx.weights[base + j]!;
        const p = (y * src.width + s0 + j) * 4;
        const al = (src.data[p + 3]! / 255) * w;
        r += src.data[p]! * al;
        g += src.data[p + 1]! * al;
        b += src.data[p + 2]! * al;
        a += al;
      }
      const o = (y * width + x) * 4;
      mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
    }
  }
  // Vertical pass, then un-premultiply.
  for (let y = 0; y < height; y++) {
    const base = y * vy.stride;
    const s0 = vy.start[y]!;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < vy.count[y]!; j++) {
        const w = vy.weights[base + j]!;
        const p = ((s0 + j) * width + x) * 4;
        r += mid[p]! * w; g += mid[p + 1]! * w; b += mid[p + 2]! * w; a += mid[p + 3]! * w;
      }
      const o = (y * width + x) * 4;
      const al = Math.min(1, Math.max(0, a));
      if (al <= 1e-9) {
        out.data[o + 3] = 0;
      } else {
        out.data[o] = clamp8(r / al);
        out.data[o + 1] = clamp8(g / al);
        out.data[o + 2] = clamp8(b / al);
        out.data[o + 3] = clamp8(al * 255);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- orientation and cropping

/** Applies an EXIF orientation (1 to 8) so the pixels are upright. */
export function orient(src: Raster, orientation: number): Raster {
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw new Refused(`EXIF orientation ${String(orientation)} does not exist`);
  if (orientation === 1) return src;
  const { width: W, height: H } = src;
  const swap = orientation >= 5;
  const out = raster(swap ? H : W, swap ? W : H);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let sx: number, sy: number;
      switch (orientation) {
        case 2: sx = W - 1 - x; sy = y; break;
        case 3: sx = W - 1 - x; sy = H - 1 - y; break;
        case 4: sx = x; sy = H - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = H - 1 - x; break;
        case 7: sx = W - 1 - y; sy = H - 1 - x; break;
        default: sx = W - 1 - y; sy = x;
      }
      const s = (sy * W + sx) * 4;
      out.data.set(src.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function crop(src: Raster, r: Rect): Raster {
  if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > src.width || r.y + r.h > src.height) throw new Refused('the crop is outside the image');
  if (r.x === 0 && r.y === 0 && r.w === src.width && r.h === src.height) return src;
  const out = raster(r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * src.width + r.x) * 4;
    out.data.set(src.data.subarray(s, s + r.w * 4), y * r.w * 4);
  }
  return out;
}

// ---------------------------------------------------------------- the spec and the plan

export type Fit = 'contain' | 'cover' | 'fill' | 'inside' | 'pad';
export type Format = 'png' | 'jpeg' | 'webp' | 'avif';
export const FITS: readonly Fit[] = ['contain', 'cover', 'fill', 'inside', 'pad'];
export const FORMATS: readonly Format[] = ['png', 'jpeg', 'webp', 'avif'];

/** A fully-specified derivative: every field present, so two equal specs are the same request. */
export interface Spec {
  readonly width: number;
  readonly height: number;
  readonly fit: Fit;
  readonly kernel: Kernel;
  readonly format: Format;
  readonly quality: number;
  /** Where cover keeps the picture, 0 to 1 from the top left; 0.5, 0.5 is the centre. */
  readonly focalX: number;
  readonly focalY: number;
  /** Whether a picture smaller than the box may be enlarged (contain and cover; inside never enlarges). */
  readonly upscale: boolean;
  /** Background for pad, as #rrggbb or #rrggbbaa. */
  readonly background: string;
}

export interface SpecInput {
  width?: number | string | undefined;
  height?: number | string | undefined;
  fit?: string | undefined;
  kernel?: string | undefined;
  format?: string | undefined;
  quality?: number | string | undefined;
  focalX?: number | string | undefined;
  focalY?: number | string | undefined;
  upscale?: boolean | string | undefined;
  background?: string | undefined;
  /** Device pixel ratio: width and height are multiplied by it (1 to 4). */
  dpr?: number | string | undefined;
}

export interface Limits {
  /** Largest side asked for, in pixels. */
  readonly maxSide: number;
  /** Largest width times height asked for. */
  readonly maxPixels: number;
  /** When set, only these widths (and heights) are served: a size ladder that keeps the number of variants small. */
  readonly ladder?: readonly number[];
}

export const DEFAULT_LIMITS: Limits = { maxSide: 4096, maxPixels: 16_000_000 };

/** Rounds a size up to the next rung of a ladder, or to the top rung. */
export function snapToLadder(n: number, ladder: readonly number[]): number {
  const sorted = [...ladder].sort((a, b) => a - b);
  return sorted.find((r) => r >= n) ?? sorted[sorted.length - 1]!;
}

function num(v: unknown, name: string, min: number, max: number, integer: boolean): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Refused(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  return n;
}

/** Fills in defaults, checks every field against the limits, and applies the pixel ratio and the ladder. */
export function normalizeSpec(input: SpecInput, limits: Limits = DEFAULT_LIMITS): Spec {
  const fit = (input.fit ?? 'contain') as Fit;
  if (!FITS.includes(fit)) throw new Refused(`fit must be one of ${FITS.join(', ')}`);
  const kernel = (input.kernel ?? 'lanczos3') as Kernel;
  if (!KERNELS.includes(kernel)) throw new Refused(`kernel must be one of ${KERNELS.join(', ')}`);
  const format = (input.format ?? 'jpeg') as Format;
  if (!FORMATS.includes(format)) throw new Refused(`format must be one of ${FORMATS.join(', ')}`);
  const dpr = num(input.dpr, 'dpr', 1, 4, false) ?? 1;
  let w = num(input.width, 'width', 1, limits.maxSide, true);
  let h = num(input.height, 'height', 1, limits.maxSide, true);
  if (w === undefined && h === undefined) throw new Refused('give a width or a height');
  if (fit === 'cover' || fit === 'fill' || fit === 'pad') if (w === undefined || h === undefined) throw new Refused(`${fit} needs both a width and a height`);
  if (w !== undefined) w = Math.round(w * dpr);
  if (h !== undefined) h = Math.round(h * dpr);
  if (limits.ladder) {
    if (w !== undefined) w = snapToLadder(w, limits.ladder);
    if (h !== undefined) h = snapToLadder(h, limits.ladder);
  }
  if ((w ?? 0) > limits.maxSide || (h ?? 0) > limits.maxSide) throw new Refused(`no side may be more than ${limits.maxSide} pixels`);
  if ((w ?? 1) * (h ?? 1) > limits.maxPixels) throw new Refused(`no more than ${limits.maxPixels} pixels in total`);
  const quality = num(input.quality, 'quality', 1, 100, true) ?? 80;
  const bg = (input.background ?? '#00000000').toLowerCase();
  if (!/^#([0-9a-f]{6}|[0-9a-f]{8})$/.test(bg)) throw new Refused('background must be #rrggbb or #rrggbbaa');
  const up = input.upscale;
  const upscale = up === undefined ? false : up === true || up === 'true' || up === '1' ? true : up === false || up === 'false' || up === '0' ? false : (() => { throw new Refused('upscale must be true or false'); })();
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    width: w ?? 0,
    height: h ?? 0,
    fit,
    kernel,
    format,
    quality,
    focalX: round2(num(input.focalX, 'focalX', 0, 1, false) ?? 0.5),
    focalY: round2(num(input.focalY, 'focalY', 0, 1, false) ?? 0.5),
    upscale: fit === 'inside' ? false : upscale,
    background: bg.length === 7 ? `${bg}ff` : bg,
  };
}

export interface Plan {
  /** The part of the upright source that is used. */
  readonly crop: Rect;
  /** The size the cropped part is resized to. */
  readonly size: { readonly w: number; readonly h: number };
  /** For pad: the final canvas and where the resized picture sits on it. */
  readonly canvas?: { readonly w: number; readonly h: number; readonly x: number; readonly y: number };
  /** The size of the finished derivative. */
  readonly output: { readonly w: number; readonly h: number };
}

/**
 * Works out exactly what to crop and what size to resize to, from the source's stored size and orientation.
 * Nothing is rendered here, so a caller can answer "how big will it be" and cache by the plan.
 */
export function plan(source: { width: number; height: number; orientation?: number }, spec: Spec): Plan {
  const swap = (source.orientation ?? 1) >= 5;
  const dw = swap ? source.height : source.width;
  const dh = swap ? source.width : source.height;
  if (dw < 1 || dh < 1) throw new Refused('the source has no size');
  const whole: Rect = { x: 0, y: 0, w: dw, h: dh };
  let bw = spec.width;
  let bh = spec.height;
  if (bw === 0) bw = Math.max(1, Math.round((bh * dw) / dh));
  if (bh === 0) bh = Math.max(1, Math.round((bw * dh) / dw));
  const fitInside = (maxScale: number) => {
    const s = Math.min(bw / dw, bh / dh, maxScale);
    return { w: Math.max(1, Math.round(dw * s)), h: Math.max(1, Math.round(dh * s)) };
  };
  switch (spec.fit) {
    case 'fill':
      return { crop: whole, size: { w: bw, h: bh }, output: { w: bw, h: bh } };
    case 'contain':
    case 'inside': {
      const size = fitInside(spec.upscale ? Infinity : 1);
      return { crop: whole, size, output: size };
    }
    case 'pad': {
      const size = fitInside(spec.upscale ? Infinity : 1);
      return { crop: whole, size, canvas: { w: bw, h: bh, x: Math.floor((bw - size.w) / 2), y: Math.floor((bh - size.h) / 2) }, output: { w: bw, h: bh } };
    }
    case 'cover': {
      const aspect = bw / bh;
      let cw = Math.min(dw, dh * aspect);
      let ch = cw / aspect;
      if (ch > dh) {
        ch = dh;
        cw = ch * aspect;
      }
      const w = Math.max(1, Math.min(dw, Math.round(cw)));
      const h = Math.max(1, Math.min(dh, Math.round(ch)));
      const x = Math.round(Math.min(dw - w, Math.max(0, spec.focalX * dw - w / 2)));
      const y = Math.round(Math.min(dh - h, Math.max(0, spec.focalY * dh - h / 2)));
      const enough = w >= bw && h >= bh;
      const size = enough || spec.upscale ? { w: bw, h: bh } : { w, h };
      return { crop: { x, y, w, h }, size, output: size };
    }
  }
}

function parseBackground(hex: string): [number, number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), parseInt(hex.slice(7, 9), 16)];
}

/** Renders a plan: orient, crop, resize, and for pad composite onto the background. */
export function render(src: Raster, orientation: number, p: Plan, spec: Spec): Raster {
  const upright = orient(src, orientation);
  const cropped = crop(upright, p.crop);
  const sized = p.size.w === cropped.width && p.size.h === cropped.height && spec.kernel !== 'nearest' ? cropped : resize(cropped, p.size.w, p.size.h, spec.kernel);
  if (!p.canvas) return sized;
  const out = raster(p.canvas.w, p.canvas.h, parseBackground(spec.background));
  for (let y = 0; y < sized.height; y++) {
    for (let x = 0; x < sized.width; x++) {
      const s = (y * sized.width + x) * 4;
      const d = ((y + p.canvas.y) * out.width + x + p.canvas.x) * 4;
      const a = sized.data[s + 3]! / 255;
      const ba = out.data[d + 3]! / 255;
      const oa = a + ba * (1 - a);
      for (let c = 0; c < 3; c++) out.data[d + c] = oa === 0 ? 0 : clamp8((sized.data[s + c]! * a + out.data[d + c]! * ba * (1 - a)) / oa);
      out.data[d + 3] = clamp8(oa * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- cache keys

/** Bumped when any rendering behaviour changes, so old derivatives are never served as if they were new. */
export const PIPELINE_VERSION = 'v1';

const EXT: Record<Format, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', avif: 'avif' };
export const MIME: Record<Format, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };

/**
 * The key a derivative is stored under. It depends on the source's id and version (so a changed source never
 * matches an old derivative) and on the whole normalised spec (so every way of asking for the same picture lands
 * on one key). The source id is hashed, so no id can climb out of the directory.
 */
export function derivativeKey(source: { id: string; version: string }, spec: Spec): string {
  const canon = JSON.stringify([spec.width, spec.height, spec.fit, spec.kernel, spec.format, spec.quality, spec.focalX, spec.focalY, spec.upscale, spec.background]);
  const h = createHash('sha256').update(canon).digest('base64url').slice(0, 16);
  const id = createHash('sha256').update(source.id).digest('hex');
  const ver = createHash('sha256').update(source.version).digest('hex').slice(0, 16);
  return `thumbs/${PIPELINE_VERSION}/${id.slice(0, 2)}/${id.slice(0, 32)}/${ver}/${spec.width}x${spec.height}-${spec.fit}-${h}.${EXT[spec.format]}`;
}

/** The cache tag shared by every derivative of one source, for dropping them together. */
export const sourceTag = (sourceId: string) => `source:${createHash('sha256').update(sourceId).digest('hex').slice(0, 32)}`;

// ---------------------------------------------------------------- format choice

export interface FormatChoice {
  readonly format: Format;
  readonly mime: string;
  /** The response varies by the Accept header, so say so to caches. */
  readonly vary: 'Accept';
}

/**
 * Picks the output format from the client's Accept header: AVIF, then WebP, for pictures that tolerate loss, when
 * the client says it takes them and an encoder exists; graphics (PNG, GIF sources) stay lossless; anything with
 * transparency never becomes JPEG.
 */
export function chooseFormat(o: { accept: string | undefined; sourceKind: Kind; hasAlpha: boolean; available?: readonly Format[] }): FormatChoice {
  const available = o.available ?? FORMATS;
  const q = new Map<string, number>();
  for (const part of (o.accept ?? '').split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    if (!type) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const v = qp === undefined ? 1 : Number(qp.slice(2));
    q.set(type.trim(), Number.isFinite(v) ? v : 0);
  }
  const ok = (f: Format) => available.includes(f) && ((q.get(MIME[f]) ?? (q.get('image/*') ?? q.get('*/*') ?? (o.accept === undefined ? (f === 'jpeg' || f === 'png' ? 1 : 0) : 0))) > 0);
  const photo = o.sourceKind === 'jpeg' || o.sourceKind === 'webp';
  const order: Format[] = photo ? ['avif', 'webp', ...(o.hasAlpha ? [] : (['jpeg'] as Format[])), 'png'] : o.hasAlpha ? ['webp', 'png'] : ['png', 'webp'];
  // A wildcard alone does not mean "send me AVIF": only an explicit mention enables the newer formats.
  const explicit = (f: Format) => q.has(MIME[f]) && q.get(MIME[f])! > 0;
  const pick = order.find((f) => available.includes(f) && (f === 'jpeg' || f === 'png' ? ok(f) : explicit(f)));
  const format = pick ?? (o.hasAlpha ? 'png' : photo ? 'jpeg' : 'png');
  return { format, mime: MIME[format], vary: 'Accept' };
}

// ---------------------------------------------------------------- PNG codec

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Writes an 8-bit PNG: RGB when every pixel is opaque, RGBA otherwise, each row filtered by the cheapest of the five filters. */
export function encodePng(r: Raster): Uint8Array {
  let opaque = true;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 3 : 4;
  const stride = r.width * bpp;
  const raw = Buffer.alloc((stride + 1) * r.height);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < r.height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < r.width; x++) for (let c = 0; c < bpp; c++) row[x * bpp + c] = r.data[(y * r.width + x) * 4 + c]!;
    rows.push(row);
  }
  const zero = new Uint8Array(stride);
  for (let y = 0; y < r.height; y++) {
    const row = rows[y]!;
    const prev = y === 0 ? zero : rows[y - 1]!;
    let best = 0, bestCost = Infinity, bestBuf = row;
    for (let f = 0; f < 5; f++) {
      const buf = new Uint8Array(stride);
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i]! - pred) & 0xff;
        buf[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) { bestCost = cost; best = f; bestBuf = buf; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(bestBuf, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

/**
 * Reads a PNG into RGBA. Checks every chunk's CRC, refuses interlaced images and sizes over `maxPixels` before
 * inflating, and caps what inflation may produce at exactly what the header says it should.
 */
export function decodePng(bytes: Uint8Array, maxPixels = MAX_SOURCE_PIXELS): Raster {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) throw new Refused('not a PNG');
  let p = 8;
  let ihdr: Buffer | undefined;
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  let ended = false;
  while (p + 12 <= b.length && !ended) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (len > b.length - p - 12) throw new Refused('the PNG is cut short');
    const data = b.subarray(p + 8, p + 8 + len);
    if (b.readUInt32BE(p + 8 + len) !== crc32(b.subarray(p + 4, p + 8 + len))) throw new Refused(`the PNG chunk ${type} is damaged`);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    p += 12 + len;
  }
  if (!ihdr || ihdr.length !== 13 || !ended || idat.length === 0) throw new Refused('the PNG is incomplete');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!;
  const ctype = ihdr[9]!;
  if (width < 1 || height < 1 || width * height > maxPixels) throw new Refused(`a ${width}x${height} PNG is more than this will decode`);
  if (ihdr[12] !== 0) throw new Refused('interlaced PNGs are not supported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number | undefined>)[ctype];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth) || (ctype !== 0 && ctype !== 3 && depth < 8) || (ctype === 3 && depth === 16) || ((ctype === 2 || ctype === 4 || ctype === 6) && depth < 8)) throw new Refused('that PNG colour type and depth are not supported');
  if (ctype === 3 && !plte) throw new Refused('the palette is missing');
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = (stride + 1) * height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw new Refused('the PNG pixel data is damaged or larger than its header says');
  }
  if (raw.length !== expected) throw new Refused('the PNG pixel data is the wrong length');
  const rowsData = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    if (f > 4) throw new Refused('a PNG row has an unknown filter');
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= bpp ? rowsData[y * stride + i - bpp]! : 0;
      const up = y > 0 ? rowsData[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? rowsData[(y - 1) * stride + i - bpp]! : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : paeth(a, up, c);
      rowsData[y * stride + i] = (x + pred) & 0xff;
    }
  }
  const out = raster(width, height);
  const sample = (y: number, idx: number): number => {
    // The idx-th sample of a row, whatever the depth, scaled to 0..255 (16-bit keeps the high byte).
    if (depth === 8) return rowsData[y * stride + idx]!;
    if (depth === 16) return rowsData[y * stride + idx * 2]!;
    const bitPos = idx * depth;
    const byte = rowsData[y * stride + (bitPos >> 3)]!;
    const v = (byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1);
    return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 0) {
        const g = sample(y, x);
        out.data.set([g, g, g, 255], o);
      } else if (ctype === 2) out.data.set([sample(y, x * 3), sample(y, x * 3 + 1), sample(y, x * 3 + 2), 255], o);
      else if (ctype === 3) {
        const i = sample(y, x);
        if (i * 3 + 2 >= plte!.length) throw new Refused('a pixel names a colour the palette does not have');
        out.data.set([plte![i * 3]!, plte![i * 3 + 1]!, plte![i * 3 + 2]!, trns && i < trns.length ? trns[i]! : 255], o);
      } else if (ctype === 4) {
        const g = sample(y, x * 2);
        out.data.set([g, g, g, sample(y, x * 2 + 1)], o);
      } else out.data.set([sample(y, x * 4), sample(y, x * 4 + 1), sample(y, x * 4 + 2), sample(y, x * 4 + 3)], o);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the thumbnailer

export type Decoder = (bytes: Uint8Array) => Raster;
export type Encoder = (r: Raster, quality: number) => Uint8Array;

export interface Derivative {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly key: string;
  readonly width: number;
  readonly height: number;
}

export interface ThumbnailerOptions {
  readonly cache: Cache<Derivative>;
  /** Decoders by source kind. PNG is built in; add JPEG, WebP and GIF decoders here. */
  readonly decoders?: Partial<Record<Kind, Decoder>>;
  /** Encoders by output format. PNG is built in; add the others here. */
  readonly encoders?: Partial<Record<Format, Encoder>>;
  readonly limits?: Limits;
}

export interface Source {
  readonly id: string;
  /** Changes whenever the source's bytes change (a content hash or an update counter). */
  readonly version: string;
  readonly bytes: () => Promise<Uint8Array>;
}

export class Thumbnailer {
  private readonly o: ThumbnailerOptions;
  private readonly decoders: Partial<Record<Kind, Decoder>>;
  private readonly encoders: Partial<Record<Format, Encoder>>;
  readonly stats = { renders: 0 };

  constructor(o: ThumbnailerOptions) {
    this.o = o;
    this.decoders = { png: (b) => decodePng(b), ...o.decoders };
    this.encoders = { png: (r) => encodePng(r), ...o.encoders };
  }

  get formats(): Format[] {
    return FORMATS.filter((f) => this.encoders[f]);
  }

  /** The derivative for a source and a spec, rendered once however many ask, and kept under its key. */
  async get(source: Source, input: SpecInput): Promise<Derivative> {
    const spec = normalizeSpec(input, this.o.limits ?? DEFAULT_LIMITS);
    if (!this.encoders[spec.format]) throw new Refused(`no encoder for ${spec.format} is installed`);
    const key = derivativeKey(source, spec);
    return this.o.cache.get(key, () => this.render(source, spec, key), [sourceTag(source.id)]);
  }

  /** Drops every derivative of a source (it changed or was deleted). Returns how many were held. */
  invalidate(sourceId: string): number {
    return this.o.cache.invalidateTag(sourceTag(sourceId));
  }

  private async render(source: Source, spec: Spec, key: string): Promise<Derivative> {
    const bytes = await source.bytes();
    const limits = this.o.limits ?? DEFAULT_LIMITS;
    const info = inspect(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { maxPixels: MAX_SOURCE_PIXELS });
    const decode = this.decoders[info.kind];
    if (!decode) throw new Refused(`no decoder for ${info.kind} sources is installed`);
    const src = decode(bytes);
    const p = plan({ width: src.width, height: src.height, orientation: info.orientation }, spec);
    if (p.output.w * p.output.h > limits.maxPixels) throw new Refused('that derivative would be too large');
    const out = render(src, info.orientation, p, spec);
    this.stats.renders++;
    const enc = this.encoders[spec.format]!;
    return { bytes: enc(out, spec.quality), mime: MIME[spec.format], key, width: out.width, height: out.height };
  }
}
