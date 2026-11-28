/**
 * Capturing a signature as evidence, not just as a picture. Three ways to sign: drawn (a list of strokes, each
 * a list of points with positions and times), typed (a name set in one of a few named script styles), and
 * uploaded (a PNG or JPEG, checked by its first bytes and its real dimensions). Every capture is stored with the
 * exact words of the intent the signer accepted ("I, Ana, agree to sign..."), the hash of the document, and a
 * device evidence bundle (address, browser, zone, screen, pointer type, time). The bundle is canonically encoded,
 * hashed, and sealed with an HMAC under a key passed in, so later tampering shows. Signing needs the signer's
 * agreement to the electronic-signature disclosure, recorded in the consent block. Drawn strokes are measured
 * (length, duration, speed) and flagged when they look scripted or too slight to mean anything. The picture of a
 * drawn signature is an SVG built from the strokes, with every number a finite, rounded coordinate.
 * Out of scope: handwriting recognition, biometric matching, and PDF placement (the sealing blocks do those).
 */
import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { equal } from '../crypto/index.ts';
import type { Consent } from '../consent/index.ts';

export class CaptureRefused extends Error {
  constructor(why: string) {
    super(`signature not accepted: ${why}`);
  }
}

export interface Point {
  readonly x: number;
  readonly y: number;
  /** Milliseconds since the stroke began the pad, non-decreasing. */
  readonly t: number;
  /** Pen pressure 0..1, when the device has it. */
  readonly p?: number;
}
export type Stroke = readonly Point[];

export interface Pad {
  readonly width: number;
  readonly height: number;
}

export interface StrokeStats {
  readonly strokes: number;
  readonly points: number;
  readonly length: number;
  readonly durationMs: number;
  readonly bbox: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly maxSpeed: number;
}

const LIMITS = { strokes: 100, pointsPerStroke: 5000, points: 20000, padMax: 4000, minLength: 40, upload: 1_000_000, typedMax: 100 };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates strokes against the pad and measures them. */
export function measure(strokes: readonly Stroke[], pad: Pad): StrokeStats {
  if (!num(pad.width) || !num(pad.height) || pad.width <= 0 || pad.height <= 0 || pad.width > LIMITS.padMax || pad.height > LIMITS.padMax) throw new CaptureRefused('the signing pad size is not valid');
  if (!Array.isArray(strokes) || strokes.length === 0) throw new CaptureRefused('nothing was drawn');
  if (strokes.length > LIMITS.strokes) throw new CaptureRefused(`more than ${LIMITS.strokes} strokes`);
  let points = 0;
  let length = 0;
  let maxSpeed = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  let lastT = -Infinity;
  for (const s of strokes) {
    if (!Array.isArray(s) || s.length === 0) throw new CaptureRefused('a stroke has no points');
    if (s.length > LIMITS.pointsPerStroke) throw new CaptureRefused(`a stroke has more than ${LIMITS.pointsPerStroke} points`);
    let prev: Point | undefined;
    for (const p of s) {
      if (!p || !num(p.x) || !num(p.y) || !num(p.t)) throw new CaptureRefused('a point is missing a number');
      if (p.x < 0 || p.y < 0 || p.x > pad.width || p.y > pad.height) throw new CaptureRefused('a point is outside the pad');
      if (p.p !== undefined && (!num(p.p) || p.p < 0 || p.p > 1)) throw new CaptureRefused('pressure must be between 0 and 1');
      if (p.t < lastT) throw new CaptureRefused('points are out of time order');
      lastT = p.t;
      tMin = Math.min(tMin, p.t);
      tMax = Math.max(tMax, p.t);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
      if (prev) {
        const d = Math.hypot(p.x - prev.x, p.y - prev.y);
        length += d;
        if (p.t > prev.t) maxSpeed = Math.max(maxSpeed, d / (p.t - prev.t));
      }
      prev = p;
      points += 1;
    }
  }
  if (points > LIMITS.points) throw new CaptureRefused(`more than ${LIMITS.points} points in all`);
  return { strokes: strokes.length, points, length: Math.round(length * 100) / 100, durationMs: tMax - tMin, bbox: { x0, y0, x1, y1 }, maxSpeed: Math.round(maxSpeed * 1000) / 1000 };
}

export type Flag = 'no-timing' | 'perfectly-straight' | 'too-fast' | 'machine-regular';

/** Things a reviewer should know about a drawn signature; none of them refuses it. */
export function flagsOf(strokes: readonly Stroke[], stats: StrokeStats): Flag[] {
  const flags: Flag[] = [];
  if (stats.points > 5 && stats.durationMs === 0) flags.push('no-timing');
  if (stats.maxSpeed > 20) flags.push('too-fast');
  const all = strokes.flat();
  if (all.length >= 3) {
    const a = all[0]!;
    const b = all[all.length - 1]!;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (span > 0 && all.every((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / span < 0.5)) flags.push('perfectly-straight');
  }
  if (all.length >= 20) {
    const deltas = new Set<number>();
    for (let i = 1; i < all.length; i++) deltas.add(all[i]!.t - all[i - 1]!.t);
    if (deltas.size === 1 && stats.durationMs > 0) flags.push('machine-regular');
  }
  return flags;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** An SVG of the strokes. A single-point stroke is drawn as a dot. */
export function strokesToSvg(strokes: readonly Stroke[], pad: Pad): string {
  const paths = strokes.map((s) => {
    if (s.length === 1) return `<circle cx="${r2(s[0]!.x)}" cy="${r2(s[0]!.y)}" r="1.5"/>`;
    return `<path d="${s.map((p, i) => `${i ? 'L' : 'M'}${r2(p.x)} ${r2(p.y)}`).join('')}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(pad.width)} ${r2(pad.height)}" width="${r2(pad.width)}" height="${r2(pad.height)}" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</svg>`;
}

// ---------------------------------------------------------------- typed and uploaded

export const SCRIPT_STYLES = ['script-1', 'script-2', 'script-3'] as const;
export type ScriptStyle = (typeof SCRIPT_STYLES)[number];
const FONTS: Readonly<Record<ScriptStyle, string>> = { 'script-1': "'Snell Roundhand', 'Segoe Script', cursive", 'script-2': "'Brush Script MT', 'Lucida Handwriting', cursive", 'script-3': "'Apple Chancery', 'Palatino Linotype', serif" };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function typedToSvg(name: string, style: ScriptStyle): { name: string; svg: string } {
  if (!(SCRIPT_STYLES as readonly string[]).includes(style)) throw new CaptureRefused(`${JSON.stringify(String(style).slice(0, 30))} is not one of the signature styles`);
  const raw = name.normalize('NFC').trim();
  const n = raw.replace(/ +/g, ' ');
  if (n.length === 0) throw new CaptureRefused('the typed name is empty');
  if ([...n].length > LIMITS.typedMax) throw new CaptureRefused(`the typed name is longer than ${LIMITS.typedMax} characters`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw)) throw new CaptureRefused('the typed name has control or direction-changing characters');
  const w = Math.max(120, Math.min(1200, [...n].length * 26));
  return { name: n, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 60" width="${w}" height="60"><text x="8" y="42" font-size="36" font-family="${esc(FONTS[style])}">${esc(n)}</text></svg>` };
}

export interface ImageFacts {
  readonly type: 'png' | 'jpeg';
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly bytes: number;
}

/** Reads an uploaded image from its bytes, not its name: PNG or JPEG only, real dimensions, bounded size. */
export function inspectImage(b: Uint8Array): ImageFacts {
  if (b.length === 0) throw new CaptureRefused('the uploaded file is empty');
  if (b.length > LIMITS.upload) throw new CaptureRefused('the uploaded image is larger than 1 MB');
  const buf = Buffer.from(b);
  let type: 'png' | 'jpeg';
  let width = 0;
  let height = 0;
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.subarray(12, 16).toString('latin1') === 'IHDR') {
    type = 'png';
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
  } else if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    type = 'jpeg';
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const m = buf[i + 1]!;
      if (m === 0xff) {
        i += 1;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
        height = buf.readUInt16BE(i + 5);
        width = buf.readUInt16BE(i + 7);
        break;
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) i += 2;
      else i += 2 + buf.readUInt16BE(i + 2);
    }
  } else throw new CaptureRefused('the uploaded file is not a PNG or JPEG image');
  if (width < 20 || height < 20) throw new CaptureRefused('the uploaded image is too small to be a signature');
  if (width > 4000 || height > 2000) throw new CaptureRefused('the uploaded image is larger than 4000 by 2000');
  return { type, width, height, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

// ---------------------------------------------------------------- evidence and records

export interface DeviceEvidence {
  readonly ip: string;
  readonly userAgent: string;
  readonly timezone?: string;
  readonly locale?: string;
  readonly screen?: { readonly width: number; readonly height: number };
  readonly pointer?: 'mouse' | 'touch' | 'pen' | 'keyboard';
  readonly sessionId?: string;
}

const clean = (s: string, n: number) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, n);

export function cleanEvidence(e: DeviceEvidence): DeviceEvidence {
  if (!isIP(e.ip)) throw new CaptureRefused('the device address is not an IP address');
  if (typeof e.userAgent !== 'string' || !e.userAgent) throw new CaptureRefused('the browser identification is missing');
  if (e.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: e.timezone });
    } catch {
      throw new CaptureRefused('the time zone is not a real zone');
    }
  }
  if (e.screen && !(num(e.screen.width) && num(e.screen.height) && e.screen.width > 0 && e.screen.height > 0 && e.screen.width < 20000 && e.screen.height < 20000)) throw new CaptureRefused('the screen size is not valid');
  if (e.pointer && !['mouse', 'touch', 'pen', 'keyboard'].includes(e.pointer)) throw new CaptureRefused('the pointer type is not known');
  return { ip: e.ip, userAgent: clean(e.userAgent, 300), ...(e.timezone ? { timezone: e.timezone } : {}), ...(e.locale ? { locale: clean(e.locale, 35) } : {}), ...(e.screen ? { screen: { width: e.screen.width, height: e.screen.height } } : {}), ...(e.pointer ? { pointer: e.pointer } : {}), ...(e.sessionId ? { sessionId: clean(e.sessionId, 100) } : {}) };
}

export interface Intent {
  /** The exact words shown to the signer. */
  readonly text: string;
  readonly textSha256: string;
  readonly acceptedAt: string;
}

export const intentStatement = (signerName: string, documentTitle: string) => `I, ${signerName}, have read "${documentTitle}" and intend to sign it electronically. I understand my signature has the same effect as a handwritten one.`;

export type SignatureBody =
  | { readonly method: 'drawn'; readonly pad: Pad; readonly strokes: readonly Stroke[] }
  | { readonly method: 'typed'; readonly name: string; readonly style: ScriptStyle }
  | { readonly method: 'uploaded'; readonly bytes: Uint8Array };

export interface SignatureRecord {
  readonly id: string;
  readonly signerId: string;
  readonly signerName: string;
  readonly documentSha256: string;
  readonly method: 'drawn' | 'typed' | 'uploaded';
  /** The picture: SVG text for drawn and typed, absent for an upload (its hash is in `image`). */
  readonly svg?: string;
  readonly image?: ImageFacts;
  readonly stats?: StrokeStats;
  readonly flags: readonly Flag[];
  readonly intent: Intent;
  readonly evidence: DeviceEvidence;
  readonly consentDoc: string;
  readonly capturedAt: string;
  /** Hash of everything above, and its seal. */
  readonly bundleSha256: string;
  readonly seal: string;
}

/** Stable encoding with keys sorted at every level. */
const canon = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v) ? `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}` : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v));

const bodyOf = (r: Omit<SignatureRecord, 'bundleSha256' | 'seal'>) => canon(r);

export interface CaptureOptions {
  readonly consent: Consent;
  /** The consent document the signer must have agreed to first. */
  readonly consentDoc: string;
  /** Key for sealing bundles; supplied at run time. */
  readonly sealKey: string;
  readonly now: () => Date;
  readonly newId: () => string;
}

export class SignatureCapture {
  private readonly o: CaptureOptions;
  private readonly records = new Map<string, SignatureRecord>();
  private readonly locked = new Set<string>();
  constructor(o: CaptureOptions) {
    if (o.sealKey.length < 16) throw new CaptureRefused('the sealing key is too short');
    this.o = o;
  }

  capture(a: { signerId: string; signerName: string; documentSha256: string; documentTitle: string; intentShown: string; body: SignatureBody; evidence: DeviceEvidence }): SignatureRecord {
    const name = a.signerName.normalize('NFC').trim();
    if (!name || [...name].length > 100) throw new CaptureRefused('the signer name is missing or too long');
    if (!/^[0-9a-f]{64}$/.test(a.documentSha256)) throw new CaptureRefused('the document hash must be 64 hex characters');
    if (!this.o.consent.allowed(a.signerId, this.o.consentDoc)) throw new CaptureRefused(`${a.signerId} has not agreed to ${this.o.consentDoc}`);
    const expected = intentStatement(name, a.documentTitle);
    if (a.intentShown !== expected) throw new CaptureRefused('the intent the signer accepted is not the statement for this document');
    const key = `${a.signerId}|${a.documentSha256}`;
    if (this.locked.has(a.documentSha256)) throw new CaptureRefused('the document is locked; no more signatures can be captured');
    if (this.records.has(key)) throw new CaptureRefused('this signer has already signed this document; clear it first to sign again');
    const evidence = cleanEvidence(a.evidence);
    const at = this.o.now().toISOString();
    let svg: string | undefined;
    let image: ImageFacts | undefined;
    let stats: StrokeStats | undefined;
    let flags: Flag[] = [];
    const b = a.body;
    if (b.method === 'drawn') {
      stats = measure(b.strokes, b.pad);
      if (stats.length < LIMITS.minLength) throw new CaptureRefused('the drawing is too short to be a signature');
      flags = flagsOf(b.strokes, stats);
      svg = strokesToSvg(b.strokes, b.pad);
    } else if (b.method === 'typed') {
      const t = typedToSvg(b.name, b.style);
      svg = t.svg;
    } else if (b.method === 'uploaded') image = inspectImage(b.bytes);
    else throw new CaptureRefused('the signing method is not known');
    const base: Omit<SignatureRecord, 'bundleSha256' | 'seal'> = {
      id: this.o.newId(),
      signerId: a.signerId,
      signerName: name,
      documentSha256: a.documentSha256,
      method: b.method,
      ...(svg ? { svg } : {}),
      ...(image ? { image } : {}),
      ...(stats ? { stats } : {}),
      flags,
      intent: { text: expected, textSha256: createHash('sha256').update(expected).digest('hex'), acceptedAt: at },
      evidence,
      consentDoc: this.o.consentDoc,
      capturedAt: at,
    };
    const text = bodyOf(base);
    const rec: SignatureRecord = { ...base, bundleSha256: createHash('sha256').update(text).digest('hex'), seal: createHmac('sha256', this.o.sealKey).update(text).digest('base64url') };
    this.records.set(key, rec);
    return rec;
  }

  /** Whether a record is exactly as captured: its hash and its seal both hold. */
  verify(r: SignatureRecord): { ok: boolean; why?: string } {
    const { bundleSha256, seal, ...rest } = r;
    const text = bodyOf(rest);
    if (createHash('sha256').update(text).digest('hex') !== bundleSha256) return { ok: false, why: 'the record was changed after capture' };
    if (!equal(createHmac('sha256', this.o.sealKey).update(text).digest('base64url'), seal)) return { ok: false, why: 'the seal does not match; the record was not made here' };
    if (createHash('sha256').update(r.intent.text).digest('hex') !== r.intent.textSha256) return { ok: false, why: 'the intent text does not match its hash' };
    return { ok: true };
  }

  /** Lets a signer start again, until the document is locked. */
  clear(signerId: string, documentSha256: string): void {
    if (this.locked.has(documentSha256)) throw new CaptureRefused('the document is locked');
    this.records.delete(`${signerId}|${documentSha256}`);
  }

  lock(documentSha256: string): SignatureRecord[] {
    this.locked.add(documentSha256);
    return this.forDocument(documentSha256);
  }

  forDocument(documentSha256: string): SignatureRecord[] {
    return [...this.records.values()].filter((r) => r.documentSha256 === documentSha256);
  }
}
