/**
 * Plans for serving pictures on the web, without touching a pixel. Responsive sets: the widths worth making (a ladder
 * that never goes above the source, always includes the source's own width as the last rung when it falls between
 * rungs, and can be limited by the largest size the page ever shows and the screen density), the `srcset` string with
 * width descriptors, the `sizes` string from breakpoint rules, and the `<picture>` markup with one source per format
 * and an `<img>` carrying the real width and height so the page does not jump while loading. Format negotiation reuses
 * the thumbnails block (AVIF and WebP only when the client's Accept header names them; transparency never becomes
 * JPEG). Focal point crops: the largest box of a wanted shape inside the picture, centred on a chosen point, never
 * outside the frame. Metadata stripping: a plan per policy saying what goes (GPS, camera, XMP, comments, trailers) and
 * what stays (the colour profile), whether the rotation must first be baked into the pixels because the EXIF block that
 * held it is going away, and the stripping itself for JPEG (imagemeta block) and PNG (chunks that carry text, EXIF and
 * time stamps are dropped; the pixels and colour chunks are not touched).
 *
 * Sizes are in displayed orientation: a phone photo stored 4032x3024 with EXIF orientation 6 is 3024x4032 here.
 * Everything in markup is escaped, and URL templates are filled with encoded values.
 *
 * Out of scope: resizing and encoding (the thumbnails block and a codec do that), colour conversion (the plan says when
 * it is needed), and CDN configuration.
 */
import { chooseFormat } from '../thumbnails/index.ts';
import type { Format } from '../thumbnails/index.ts';
import { displayed, inspect, stripJpeg } from '../imagemeta/index.ts';
import type { Info } from '../imagemeta/index.ts';

export { chooseFormat };
export type { Format };

export class ImagePlanError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

const MIME: Record<Format, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };

function checkSize(s: Size, what: string): void {
  if (!Number.isInteger(s.width) || !Number.isInteger(s.height) || s.width < 1 || s.height < 1) throw new ImagePlanError(`${what} must be whole numbers, at least 1 by 1`);
}

/** Size as displayed from stored size and EXIF orientation. */
export function displaySize(s: Size, orientation = 1): Size {
  checkSize(s, 'the size');
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw new ImagePlanError('orientation must be 1 to 8');
  return orientation >= 5 ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
}

// ------------------------------------------------------------------------------------------------ srcset

export const DEFAULT_WIDTHS: readonly number[] = [320, 480, 640, 768, 960, 1280, 1600, 1920, 2560, 3840];

export interface Candidate {
  readonly width: number;
  readonly height: number;
  readonly format: Format;
  readonly url: string;
  /** `640w`. */
  readonly descriptor: string;
}

export interface UrlParts {
  readonly width: number;
  readonly height: number;
  readonly format: Format;
  readonly quality: number;
}

export interface SrcsetOptions {
  /** The picture as displayed. */
  readonly source: Size;
  readonly format: Format;
  /** Makes a URL for one candidate. Use `urlTemplate` for the common case. */
  readonly url: (p: UrlParts) => string;
  readonly widths?: readonly number[];
  /** The widest the page ever shows the picture, in CSS pixels. */
  readonly maxCssWidth?: number;
  /** Highest screen density to serve. Default 2. */
  readonly maxDensity?: number;
  /** The narrowest rung. Default 320. */
  readonly minWidth?: number;
  readonly quality?: number;
}

/** A URL from a template such as `/img/{id}?w={w}&h={h}&f={fmt}&q={q}`. Values are encoded. */
export function urlTemplate(template: string, fixed: Readonly<Record<string, string>> = {}): (p: UrlParts) => string {
  return (p) =>
    template.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const v: Record<string, string> = { ...fixed, w: String(p.width), h: String(p.height), fmt: p.format, q: String(p.quality) };
      if (!Object.hasOwn(v, key)) throw new ImagePlanError(`the URL template names {${key}}, which is not given`);
      return encodeURIComponent(v[key] as string);
    });
}

/** The widths to make: ladder rungs up to what is useful, never above the source, with the source's own width as the top when it lies between rungs. */
export function chooseWidths(o: { source: Size; widths?: readonly number[]; maxCssWidth?: number; maxDensity?: number; minWidth?: number }): number[] {
  checkSize(o.source, 'the source size');
  const ladder = [...(o.widths ?? DEFAULT_WIDTHS)];
  if (ladder.length === 0 || ladder.some((w) => !Number.isInteger(w) || w < 1)) throw new ImagePlanError('widths must be whole numbers, at least 1');
  const density = o.maxDensity ?? 2;
  if (!(density >= 1)) throw new ImagePlanError('maxDensity must be at least 1');
  const useful = o.maxCssWidth === undefined ? Infinity : Math.ceil(o.maxCssWidth * density);
  if (o.maxCssWidth !== undefined && !(o.maxCssWidth >= 1)) throw new ImagePlanError('maxCssWidth must be at least 1');
  const min = o.minWidth ?? 320;
  const cap = Math.min(o.source.width, useful);
  const rungs = [...new Set(ladder)].sort((a, b) => a - b).filter((w) => w >= Math.min(min, cap) && w <= cap);
  // when the cap falls between rungs, make it a rung of its own, so the largest screen (or the whole picture, for a small
  // source) is served exactly; a source bigger than the whole ladder is not offered at its full size
  if (cap <= (ladder.reduce((a, b) => Math.max(a, b))) && (rungs.length === 0 || (rungs[rungs.length - 1] as number) < cap)) rungs.push(cap);
  return [...new Set(rungs)].sort((a, b) => a - b);
}

export function buildSrcset(o: SrcsetOptions): { candidates: Candidate[]; srcset: string } {
  const quality = o.quality ?? 80;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new ImagePlanError('quality must be a whole number from 1 to 100');
  const widths = chooseWidths(o);
  const candidates = widths.map((w): Candidate => {
    const height = Math.max(1, Math.round((w * o.source.height) / o.source.width));
    const url = o.url({ width: w, height, format: o.format, quality });
    if (/[\s,]/.test(url)) throw new ImagePlanError(`a URL in a srcset cannot hold spaces or commas: ${JSON.stringify(url.slice(0, 40))}`);
    return { width: w, height, format: o.format, url, descriptor: `${w}w` };
  });
  return { candidates, srcset: candidates.map((c) => `${c.url} ${c.descriptor}`).join(', ') };
}

export interface SizeRule {
  /** `(min-width: 1024px)`: the breakpoint in CSS pixels; absent for the default. */
  readonly minViewport?: number;
  /** How wide the picture is there: `50vw` or `640px`. */
  readonly width: string;
}

export function sizesAttribute(rules: readonly SizeRule[]): string {
  if (rules.length === 0) throw new ImagePlanError('sizes needs at least one rule');
  const dflt = rules.filter((r) => r.minViewport === undefined);
  if (dflt.length !== 1) throw new ImagePlanError('sizes needs exactly one rule without a breakpoint, for the default');
  for (const r of rules) if (!/^\d+(?:\.\d+)?(?:px|vw|em|rem)$/.test(r.width) && !/^calc\([^()]*\)$/.test(r.width)) throw new ImagePlanError(`"${r.width}" is not a length`);
  const withBp = rules.filter((r) => r.minViewport !== undefined).sort((a, b) => (b.minViewport as number) - (a.minViewport as number));
  for (const r of withBp) if (!Number.isInteger(r.minViewport) || (r.minViewport as number) < 1) throw new ImagePlanError('a breakpoint must be a whole number of pixels');
  return [...withBp.map((r) => `(min-width: ${r.minViewport}px) ${r.width}`), (dflt[0] as SizeRule).width].join(', ');
}

/** What a browser would pick: the smallest candidate at least as wide as the slot times the density, else the largest. */
export function pickCandidate(candidates: readonly Candidate[], slotCssWidth: number, density: number): Candidate {
  if (candidates.length === 0) throw new ImagePlanError('there are no candidates');
  if (!(slotCssWidth > 0) || !(density > 0)) throw new ImagePlanError('slot width and density must be above zero');
  const need = slotCssWidth * density;
  const sorted = [...candidates].sort((a, b) => a.width - b.width);
  return sorted.find((c) => c.width >= need) ?? (sorted[sorted.length - 1] as Candidate);
}

// ------------------------------------------------------------------------------------------------ picture markup

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export interface PictureOptions {
  readonly source: Size;
  /** Best first; the last is the fallback in the `<img>`. */
  readonly formats: readonly Format[];
  readonly url: (p: UrlParts) => string;
  readonly alt: string;
  /** `true` when the picture is only decoration: then alt may be empty. */
  readonly decorative?: boolean;
  readonly sizes: string;
  readonly widths?: readonly number[];
  readonly maxCssWidth?: number;
  readonly maxDensity?: number;
  readonly quality?: number;
  /** Above the fold: load at once, with high priority. Default lazy. */
  readonly eager?: boolean;
  readonly className?: string;
}

export function pictureHtml(o: PictureOptions): string {
  if (o.formats.length === 0) throw new ImagePlanError('at least one format is needed');
  if (o.alt === '' && !o.decorative) throw new ImagePlanError('a picture needs alt text, or must be marked decorative');
  if (o.decorative && o.alt !== '') throw new ImagePlanError('a decorative picture has an empty alt');
  const sets = o.formats.map((f) => ({ format: f, ...buildSrcset({ ...o, format: f }) }));
  const fallback = sets[sets.length - 1] as (typeof sets)[number];
  const biggest = fallback.candidates[fallback.candidates.length - 1] as Candidate;
  const middle = fallback.candidates[Math.floor((fallback.candidates.length - 1) / 2)] as Candidate;
  const sources = sets.slice(0, -1).map((s) => `<source type="${MIME[s.format]}" srcset="${esc(s.srcset)}" sizes="${esc(o.sizes)}">`).join('');
  const img =
    `<img src="${esc(middle.url)}" srcset="${esc(fallback.srcset)}" sizes="${esc(o.sizes)}" width="${biggest.width}" height="${biggest.height}" alt="${esc(o.alt)}"` +
    ` loading="${o.eager ? 'eager' : 'lazy'}" decoding="async"${o.eager ? ' fetchpriority="high"' : ''}${o.className ? ` class="${esc(o.className)}"` : ''}>`;
  return sources === '' ? img : `<picture>${sources}${img}</picture>`;
}

// ------------------------------------------------------------------------------------------------ focal crop

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The largest box with the wanted shape that fits inside the picture, centred on the focal point (0 to 1 from the left
 * and top) and then slid back inside the frame if it would stick out. The shape is a width and height (only their ratio
 * matters). Edges are whole pixels and the box is never larger than the picture.
 */
export function focalCrop(source: Size, shape: Size, focal: { x: number; y: number } = { x: 0.5, y: 0.5 }): Rect {
  checkSize(source, 'the source size');
  if (!(shape.width > 0 && shape.height > 0 && Number.isFinite(shape.width) && Number.isFinite(shape.height))) throw new ImagePlanError('the shape needs a width and height above zero');
  if (!(focal.x >= 0 && focal.x <= 1 && focal.y >= 0 && focal.y <= 1)) throw new ImagePlanError('the focal point must be inside the picture: 0 to 1 on each axis');
  const want = shape.width / shape.height;
  let w = source.width;
  let h = Math.round(w / want);
  if (h > source.height) {
    h = source.height;
    w = Math.round(h * want);
  }
  w = Math.max(1, Math.min(source.width, w));
  h = Math.max(1, Math.min(source.height, h));
  const cx = focal.x * source.width;
  const cy = focal.y * source.height;
  const x = Math.round(Math.max(0, Math.min(source.width - w, cx - w / 2)));
  const y = Math.round(Math.max(0, Math.min(source.height - h, cy - h / 2)));
  return { x, y, width: w, height: h };
}

/** The crop and the size to resize it to for a slot, never upscaling past the crop. */
export function cropPlan(source: Size, slot: Size, focal?: { x: number; y: number }): { crop: Rect; output: Size } {
  const crop = focalCrop(source, slot, focal);
  const scale = Math.min(1, slot.width / crop.width);
  return { crop, output: { width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)) } };
}

// ------------------------------------------------------------------------------------------------ stripping

export type StripPolicy = 'keep-all' | 'privacy' | 'minimal';

export interface StripPlan {
  readonly policy: StripPolicy;
  readonly remove: readonly string[];
  readonly keep: readonly string[];
  /** The EXIF block holding the rotation is going, so turn the pixels upright first. */
  readonly bakeOrientation: boolean;
  /** The colour profile is going, so convert to sRGB before encoding or colours will shift. */
  readonly convertToSrgb: boolean;
  readonly notes: readonly string[];
}

export function stripPlan(info: Pick<Info, 'kind' | 'orientation'>, policy: StripPolicy = 'privacy'): StripPlan {
  if (!['keep-all', 'privacy', 'minimal'].includes(policy)) throw new ImagePlanError(`unknown strip policy "${String(policy)}"`);
  const notes: string[] = [];
  if (policy === 'keep-all') return { policy, remove: [], keep: ['everything'], bakeOrientation: false, convertToSrgb: false, notes: ['nothing is removed: location and camera details stay in the file'] };
  const remove: string[] = [];
  const keep: string[] = [];
  switch (info.kind) {
    case 'jpeg': remove.push('EXIF (including GPS and camera serial numbers)', 'XMP', 'Photoshop and IPTC blocks', 'comments', 'multi-picture data', 'anything after the end of the picture'); keep.push('Adobe colour transform'); break;
    case 'png': remove.push('eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'); keep.push('pixels', 'palette', 'transparency', 'gamma and chromaticity', 'sRGB'); break;
    case 'webp': remove.push('EXIF', 'XMP'); keep.push('ICCP', 'animation'); notes.push('WebP chunks are removed when the image is re-encoded; this block does not rewrite WebP files'); break;
    case 'gif': remove.push('comment and application extensions except looping'); keep.push('frames', 'palette'); notes.push('GIF is rewritten only by re-encoding'); break;
  }
  const exifGoes = info.kind === 'jpeg' || info.kind === 'webp';
  const bake = exifGoes && info.orientation !== 1;
  if (bake) notes.push(`orientation ${info.orientation} is stored in the EXIF block being removed: apply it to the pixels, or the picture will show sideways`);
  const minimal = policy === 'minimal';
  if (minimal) { remove.push('colour profile'); notes.push('without the profile, convert to sRGB first'); } else keep.push('colour profile');
  return { policy, remove, keep, bakeOrientation: bake, convertToSrgb: minimal, notes };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/** A PNG without its text, EXIF and time stamp chunks. Every other chunk is copied byte for byte. */
export function stripPng(b: Buffer): Buffer {
  if (b.length < 8 + 12 || !b.subarray(0, 8).equals(PNG_SIG)) throw new ImagePlanError('not a PNG');
  const out: Buffer[] = [PNG_SIG];
  let p = 8;
  let sawEnd = false;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (len > 0x7fffffff || p + 12 + len > b.length) throw new ImagePlanError('the PNG is cut short or damaged');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImagePlanError('the PNG has a damaged chunk name');
    if (!PNG_DROP.has(type)) out.push(b.subarray(p, p + 12 + len));
    p += 12 + len;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) throw new ImagePlanError('the PNG has no end chunk');
  return Buffer.concat(out);
}

/** Apply the policy to bytes where this block can: JPEG and PNG. Others are returned unchanged with `changed: false`. */
export function applyStrip(bytes: Buffer, policy: StripPolicy = 'privacy'): { bytes: Buffer; changed: boolean; plan: StripPlan; info: Info } {
  const info = inspect(bytes);
  const plan = stripPlan(info, policy);
  if (policy === 'keep-all') return { bytes, changed: false, plan, info };
  if (info.kind === 'jpeg') {
    const out = stripJpeg(bytes);
    return { bytes: out, changed: !out.equals(bytes), plan, info };
  }
  if (info.kind === 'png') {
    const out = stripPng(bytes);
    return { bytes: out, changed: !out.equals(bytes), plan, info };
  }
  return { bytes, changed: false, plan, info };
}

/** The format to serve, from the client's Accept header and the source: a thin wrapper that returns the MIME and Vary too. */
export function negotiate(o: { accept: string | undefined; source: Info; hasAlpha?: boolean; available?: readonly Format[] }): { format: Format; mime: string; vary: 'Accept' } {
  const c = chooseFormat({ accept: o.accept, sourceKind: o.source.kind, hasAlpha: o.hasAlpha ?? (o.source.kind === 'png' || o.source.kind === 'gif'), ...(o.available ? { available: o.available } : {}) });
  return { format: c.format, mime: c.mime, vary: 'Accept' };
}

export { displayed };
