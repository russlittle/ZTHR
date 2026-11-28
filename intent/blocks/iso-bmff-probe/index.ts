/**
 * A reader for ISO base media files: MP4, MOV, M4A, 3GP, and the HEIF family (HEIC, AVIF). It parses the box tree
 * safely (sizes checked against the parent, 64-bit sizes, size-zero "to the end", `uuid` boxes, depth and count limits,
 * a file cut short is reported as truncated rather than crashing) and from it answers what a media server needs:
 * brands, duration (movie header, or the fragment header for fragmented files), a track list (video, audio, subtitle,
 * metadata) with codec fourcc and an RFC 6381 codec string (avc1, hvc1, av01, vp09, mp4a, and the audio fourccs),
 * pixel size, frame rate, sample rate and channels, language, bitrate from the sample table; the display rotation from
 * the track matrix (0, 90, 180, 270; width and height swap for a quarter turn); container checks (ftyp first, moov and
 * mdat present, moov before mdat so playback can start before the download ends, fragments, track durations that agree);
 * the QuickTime metadata keys (content identifier, make, model, creation date); GPS from `©xyz` and from the ISO 6709
 * location key; HEIF still-image items (primary item, type, size, rotation) from iinf, ispe, irot and ipma; Apple Live
 * Photo pairing by content identifier; and Google and Samsung motion photos (a JPEG with an MP4 behind it, found
 * through the XMP offset or by scanning for ftyp after the end of the JPEG).
 *
 * Input is bytes you already hold (read the head and tail of a big file and pass what you have: a box that runs past the
 * end is reported, and the boxes before it are still read). Nothing is decoded: no samples are touched.
 *
 * Out of scope: parsing the media itself, DRM boxes (reported by type only), sample-accurate edit lists, and writing files.
 */

export class IsoError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface Limits {
  readonly maxDepth: number;
  readonly maxBoxes: number;
}
export const DEFAULT_LIMITS: Limits = { maxDepth: 12, maxBoxes: 200_000 };

export interface Box {
  /** Four characters; the bytes read as Latin-1, so `©xyz` is "©xyz". */
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly headerSize: number;
  readonly children: Box[];
  /** For uuid boxes: the 16-byte extended type as hex. */
  readonly uuid?: string;
  /** True when the box declared more bytes than the data holds. */
  readonly truncated: boolean;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'iprp', 'ipco', 'ilst', 'sinf', 'schi']);
const fourcc = (d: Uint8Array, o: number) => String.fromCharCode(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!);
const u16 = (d: Uint8Array, o: number) => (d[o]! << 8) | d[o + 1]!;
const u32 = (d: Uint8Array, o: number) => d[o]! * 0x1000000 + ((d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!);
const i32 = (d: Uint8Array, o: number) => (d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!;
const u64 = (d: Uint8Array, o: number) => u32(d, o) * 4294967296 + u32(d, o + 4);
const hex = (n: number, w = 2) => n.toString(16).padStart(w, '0');

function need(d: Uint8Array, o: number, n: number, what: string): void {
  if (o < 0 || o + n > d.length) throw new IsoError(`${what} is cut short`);
}

/** Parse the boxes between two offsets. Containers are descended into; everything else stays a leaf. */
export function parseBoxes(data: Uint8Array, start = 0, end = data.length, limits: Limits = DEFAULT_LIMITS): Box[] {
  let count = 0;
  const read = (from: number, to: number, depth: number, parent = ''): Box[] => {
    if (depth > limits.maxDepth) throw new IsoError(`boxes nested deeper than ${limits.maxDepth}`);
    const out: Box[] = [];
    let o = from;
    while (o + 8 <= to) {
      if (++count > limits.maxBoxes) throw new IsoError(`more than ${limits.maxBoxes} boxes`);
      let size = u32(data, o);
      const type = fourcc(data, o + 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > to) { out.push({ type, offset: o, size: to - o, headerSize: 8, children: [], truncated: true }); break; }
        size = u64(data, o + 8);
        header = 16;
        if (!Number.isSafeInteger(size)) throw new IsoError('a box size is too large');
      } else if (size === 0) {
        size = to - o;
      }
      let uuid: string | undefined;
      if (type === 'uuid') {
        if (o + header + 16 > to) { out.push({ type, offset: o, size: to - o, headerSize: header, children: [], truncated: true }); break; }
        uuid = Array.from(data.subarray(o + header, o + header + 16), (b) => hex(b)).join('');
        header += 16;
      }
      if (size < header) throw new IsoError(`box "${type}" at ${o} has size ${size}, smaller than its own header`);
      const truncated = o + size > to;
      const boxEnd = Math.min(o + size, to);
      let children: Box[] = [];
      // the items inside an ilst are containers whatever their type (an index, or a tag such as \u00a9nam)
      if (CONTAINERS.has(type) || parent === 'ilst') children = read(o + header, boxEnd, depth + 1, type);
      else if (type === 'meta') {
        // ISO: a full box (4 bytes of version and flags). QuickTime: no full-box header. Tell them apart by what follows.
        const p = o + header;
        const quickTime = p + 8 <= boxEnd && /^[a-z0-9 ]{4}$/i.test(fourcc(data, p + 4)) && u32(data, p) >= 8 && u32(data, p) <= boxEnd - p && /^(hdlr|keys|ilst|free|ctry|lang)$/.test(fourcc(data, p + 4));
        children = read(quickTime ? p : p + 4, boxEnd, depth + 1, type);
      } else if (type === 'iinf') {
        const v = data[o + header] ?? 0;
        children = read(o + header + 4 + (v === 0 ? 2 : 4), boxEnd, depth + 1);
      } else if (type === 'stsd') {
        children = parseSampleEntries(data, o + header + 8, boxEnd, depth + 1, read);
      }
      out.push({ type, offset: o, size: boxEnd - o, headerSize: header, children, ...(uuid ? { uuid } : {}), truncated });
      if (truncated) break;
      o += size;
    }
    return out;
  };
  return read(start, end, 0);
}

function parseSampleEntries(data: Uint8Array, from: number, to: number, depth: number, read: (a: number, b: number, d: number) => Box[]): Box[] {
  // each sample entry is a box whose own fields come before its child boxes; read them as boxes, then re-read the children
  const entries = read(from, to, depth);
  return entries.map((e) => {
    const bodyStart = e.offset + e.headerSize;
    const kind = sampleEntryKind(e.type);
    let childStart = bodyStart;
    if (kind === 'video') childStart = bodyStart + 78;
    else if (kind === 'audio') {
      const ver = bodyStart + 8 <= data.length ? u16(data, bodyStart + 8) : 0;
      childStart = bodyStart + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    } else return { ...e, children: [] };
    const end = e.offset + e.size;
    return { ...e, children: childStart < end ? read(childStart, end, depth + 1) : [] };
  });
}

function sampleEntryKind(t: string): 'video' | 'audio' | 'other' {
  if (/^(avc1|avc3|hvc1|hev1|av01|vp08|vp09|mp4v|encv|dvh1|dvhe|jpeg|mjp2|apch|apcn|apcs|apco|ap4h)$/.test(t)) return 'video';
  if (/^(mp4a|enca|Opus|ac-3|ec-3|alac|fLaC|sowt|twos|lpcm|ipcm|fpcm|samr|sawb|\.mp3)$/.test(t)) return 'audio';
  return 'other';
}

export const find = (boxes: readonly Box[], type: string): Box | undefined => boxes.find((b) => b.type === type);
export const findAll = (boxes: readonly Box[], type: string): Box[] => boxes.filter((b) => b.type === type);
/** Follow a path of box types from the top: `path(top, 'moov', 'trak')` returns the trak boxes. */
export function path(boxes: readonly Box[], ...types: string[]): Box[] {
  return pathFrom(boxes, types);
}
function pathFrom(boxes: readonly Box[], types: string[]): Box[] {
  let level: Box[] = [...boxes];
  types.forEach((t, i) => {
    level = (i === 0 ? level : level.flatMap((b) => b.children)).filter((b) => b.type === t);
  });
  return level;
}
const body = (b: Box) => b.offset + b.headerSize;

// ------------------------------------------------------------------------------------------------ results

export type TrackKind = 'video' | 'audio' | 'subtitle' | 'text' | 'metadata' | 'other';

export interface Track {
  readonly id: number;
  readonly kind: TrackKind;
  readonly handler: string;
  /** The sample entry fourcc: avc1, hvc1, mp4a, and so on. */
  readonly codec: string | undefined;
  /** RFC 6381 string, when the codec configuration box was found. */
  readonly codecString: string | undefined;
  readonly timescale: number;
  readonly durationSeconds: number | undefined;
  readonly language: string | undefined;
  /** Coded size. */
  readonly width: number | undefined;
  readonly height: number | undefined;
  /** Rotation in degrees clockwise to apply when showing: 0, 90, 180 or 270. */
  readonly rotation: 0 | 90 | 180 | 270;
  /** Size as shown, after rotation. */
  readonly displayWidth: number | undefined;
  readonly displayHeight: number | undefined;
  readonly frameRate: number | undefined;
  readonly sampleCount: number | undefined;
  readonly bitrate: number | undefined;
  readonly channels: number | undefined;
  readonly sampleRate: number | undefined;
  readonly enabled: boolean;
}

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude?: number;
}

export interface HeifItem {
  readonly id: number;
  readonly type: string;
  readonly primary: boolean;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface Probe {
  readonly majorBrand: string | undefined;
  readonly minorVersion: number | undefined;
  readonly brands: readonly string[];
  readonly kind: 'video' | 'audio' | 'image' | 'unknown';
  readonly durationSeconds: number | undefined;
  readonly timescale: number | undefined;
  readonly creationTime: Date | undefined;
  readonly fragmented: boolean;
  readonly truncated: boolean;
  readonly tracks: readonly Track[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly contentIdentifier: string | undefined;
  readonly gps: GeoPoint | undefined;
  readonly items: readonly HeifItem[];
  readonly checks: readonly Check[];
  readonly topLevel: readonly string[];
  readonly faststart: boolean | undefined;
}

// ------------------------------------------------------------------------------------------------ codec strings

function descriptorLength(d: Uint8Array, o: number): { len: number; next: number } {
  let len = 0;
  let p = o;
  for (let i = 0; i < 4; i++) {
    need(d, p, 1, 'a descriptor');
    const b = d[p++]!;
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { len, next: p };
}

/** mp4a.40.2 from an esds box payload (after its version and flags). */
export function esdsCodec(d: Uint8Array, start: number, end: number): string | undefined {
  let o = start + 4;
  while (o < end) {
    const tag = d[o]!;
    const { len, next } = descriptorLength(d, o + 1);
    if (tag === 0x03) { o = next + 3; continue; } // ES_Descriptor: ES_ID(2) + flags(1), then more descriptors
    if (tag === 0x04) {
      const oti = d[next]!;
      let p = next + 13;
      if (p < end && d[p] === 0x05) {
        const { next: dsi } = descriptorLength(d, p + 1);
        let aot = d[dsi]! >> 3;
        if (aot === 31) aot = 32 + (((d[dsi]! & 7) << 3) | (d[dsi + 1]! >> 5));
        return `mp4a.${hex(oti).toUpperCase()}.${aot}`;
      }
      p = next + len;
      return `mp4a.${hex(oti).toUpperCase()}`;
    }
    o = next + len;
  }
  return undefined;
}

export function hevcCodec(entry: string, d: Uint8Array, o: number): string {
  const b = d[o + 1]!;
  const space = ['', 'A', 'B', 'C'][b >> 6] as string;
  const tier = (b >> 5) & 1 ? 'H' : 'L';
  const profile = b & 0x1f;
  let compat = u32(d, o + 2);
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev * 2) + (compat & 1); compat = Math.floor(compat / 2); }
  const level = d[o + 12]!;
  const constraints = Array.from(d.subarray(o + 6, o + 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  return [`${entry}.${space}${profile}`, rev.toString(16).toUpperCase(), `${tier}${level}`, ...constraints.map((c) => c.toString(16).toUpperCase())].join('.');
}

function codecStringFor(d: Uint8Array, entry: Box): string | undefined {
  const t = entry.type;
  const kid = (n: string) => entry.children.find((c) => c.type === n);
  if (t === 'avc1' || t === 'avc3') {
    const c = kid('avcC');
    return c ? `${t}.${hex(d[body(c) + 1]!)}${hex(d[body(c) + 2]!)}${hex(d[body(c) + 3]!)}` : undefined;
  }
  if (t === 'hvc1' || t === 'hev1') {
    const c = kid('hvcC');
    return c && c.size >= c.headerSize + 13 ? hevcCodec(t, d, body(c)) : undefined;
  }
  if (t === 'av01') {
    const c = kid('av1C');
    if (!c) return undefined;
    const b1 = d[body(c) + 1]!;
    const b2 = d[body(c) + 2]!;
    const profile = b1 >> 5;
    const level = b1 & 0x1f;
    const tier = (b2 >> 7) & 1 ? 'H' : 'M';
    const depth = (b2 >> 6) & 1 ? ((b2 >> 5) & 1 ? 12 : 10) : 8;
    return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`;
  }
  if (t === 'vp09' || t === 'vp08') {
    const c = kid('vpcC');
    if (!c) return undefined;
    const p = body(c) + 4;
    return `${t}.${String(d[p]!).padStart(2, '0')}.${String(d[p + 1]!).padStart(2, '0')}.${String(d[p + 2]! >> 4).padStart(2, '0')}`;
  }
  if (t === 'mp4a') {
    const c = kid('esds');
    return c ? esdsCodec(d, body(c), c.offset + c.size) : undefined;
  }
  if (t === 'Opus') return 'opus';
  if (t === 'fLaC') return 'flac';
  if (t === 'ac-3' || t === 'ec-3' || t === 'alac') return t;
  return undefined;
}

// ------------------------------------------------------------------------------------------------ pieces

/** Display rotation from the 3x3 matrix of a track header (a, b, c, d are 16.16 fixed point). */
export function rotationFromMatrix(a: number, b: number, c: number, dd: number): 0 | 90 | 180 | 270 {
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  const n = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  void c; void dd;
  return n as 0 | 90 | 180 | 270;
}

/** ISO 6709 location: `+37.3349-122.0090+012.345/` in decimal degrees, or degrees and minutes. */
export function parseIso6709(text: string): GeoPoint | undefined {
  const m = /^([+-])(\d{2,3}(?:\.\d+)?|\d{4,5}(?:\.\d+)?|\d{6,7}(?:\.\d+)?)([+-])(\d{3}(?:\.\d+)?|\d{5,6}(?:\.\d+)?|\d{7,8}(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?)(?:CRS\w+)?)?\/?$/.exec(text.trim());
  if (!m) return undefined;
  const conv = (s: string, degDigits: number): number => {
    const [int, frac = ''] = s.split('.');
    const i = int as string;
    if (i.length === degDigits) return Number(s);
    if (i.length === degDigits + 2) return Number(i.slice(0, degDigits)) + Number(`${i.slice(degDigits)}${frac ? `.${frac}` : ''}`) / 60;
    return Number(i.slice(0, degDigits)) + Number(i.slice(degDigits, degDigits + 2)) / 60 + Number(`${i.slice(degDigits + 2)}${frac ? `.${frac}` : ''}`) / 3600;
  };
  const lat = (m[1] === '-' ? -1 : 1) * conv(m[2] as string, 2);
  const lon = (m[3] === '-' ? -1 : 1) * conv(m[4] as string, 3);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { latitude: lat, longitude: lon, ...(m[5] !== undefined ? { altitude: Number(m[5]) } : {}) };
}

const utf8 = (d: Uint8Array, a: number, b: number) => new TextDecoder('utf-8', { fatal: false }).decode(d.subarray(a, b));

function readKeysAndValues(d: Uint8Array, meta: Box): Record<string, string> {
  const keys = meta.children.find((c) => c.type === 'keys');
  const ilst = meta.children.find((c) => c.type === 'ilst');
  const out: Record<string, string> = {};
  if (!keys || !ilst) return out;
  const names: string[] = [];
  let o = body(keys) + 4;
  const count = u32(d, o);
  o += 4;
  for (let i = 0; i < count && o + 8 <= keys.offset + keys.size; i++) {
    const size = u32(d, o);
    if (size < 8 || o + size > keys.offset + keys.size) break;
    names.push(utf8(d, o + 8, o + size));
    o += size;
  }
  for (const item of ilst.children) {
    const idx = u32(d, item.offset + 4) - 1;
    const data = item.children.find((c) => c.type === 'data');
    const name = names[idx];
    if (!data || name === undefined) continue;
    const kind = u32(d, body(data));
    if (kind === 1) out[name] = utf8(d, body(data) + 8, data.offset + data.size);
    else if (kind === 0x16 || kind === 0x15) {
      const len = data.offset + data.size - (body(data) + 8);
      let v = 0;
      for (let i = 0; i < len && i < 6; i++) v = v * 256 + d[body(data) + 8 + i]!;
      out[name] = String(v);
    }
  }
  return out;
}

function probeTrack(d: Uint8Array, trak: Box, movieTimescale: number): Track | undefined {
  const tkhd = trak.children.find((c) => c.type === 'tkhd');
  const mdia = trak.children.find((c) => c.type === 'mdia');
  if (!tkhd || !mdia) return undefined;
  let o = body(tkhd);
  const v = d[o]!;
  const flags = u32(d, o) & 0xffffff;
  o += 4;
  need(d, o, v === 1 ? 32 : 20, 'a track header');
  const id = u32(d, o + (v === 1 ? 16 : 8));
  const duration = v === 1 ? u64(d, o + 24) : u32(d, o + 16);
  const mOff = o + (v === 1 ? 32 : 20) + 8 + 8; // duration, reserved(8), layer/group/volume/reserved(8)
  const mat = mOff + 0;
  need(d, mat, 36 + 8, 'a track header');
  const a = i32(d, mat) / 65536;
  const b = i32(d, mat + 4) / 65536;
  const c = i32(d, mat + 12) / 65536;
  const dd = i32(d, mat + 16) / 65536;
  const rotation = rotationFromMatrix(a, b, c, dd);
  const tw = u32(d, mat + 36) / 65536;
  const th = u32(d, mat + 40) / 65536;

  const mdhd = mdia.children.find((c2) => c2.type === 'mdhd');
  let timescale = movieTimescale;
  let mdur: number | undefined;
  let language: string | undefined;
  if (mdhd) {
    const p = body(mdhd);
    const mv = d[p]!;
    timescale = u32(d, p + (mv === 1 ? 20 : 12));
    mdur = mv === 1 ? u64(d, p + 24) : u32(d, p + 16);
    const lp = u16(d, p + (mv === 1 ? 32 : 20));
    const chars = [(lp >> 10) & 31, (lp >> 5) & 31, lp & 31].map((x) => String.fromCharCode(x + 0x60)).join('');
    language = /^[a-z]{3}$/.test(chars) && chars !== 'und' ? chars : undefined;
  }
  const hdlr = mdia.children.find((c2) => c2.type === 'hdlr');
  const handler = hdlr ? fourcc(d, body(hdlr) + 8) : '';
  const kind: TrackKind = handler === 'vide' || handler === 'pict' ? 'video' : handler === 'soun' ? 'audio' : handler === 'subt' || handler === 'sbtl' ? 'subtitle' : handler === 'text' ? 'text' : handler === 'meta' || handler === 'mdta' ? 'metadata' : 'other';
  const stbl = pathFrom([mdia], ['mdia', 'minf', 'stbl'])[0];
  const stsd = stbl?.children.find((c2) => c2.type === 'stsd');
  const entry = stsd?.children[0];
  let width: number | undefined;
  let height: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  if (entry) {
    const eb = body(entry);
    if (sampleEntryKind(entry.type) === 'video' && eb + 28 <= d.length) {
      width = u16(d, eb + 24);
      height = u16(d, eb + 26);
    } else if (sampleEntryKind(entry.type) === 'audio' && eb + 28 <= d.length) {
      channels = u16(d, eb + 16);
      sampleRate = u32(d, eb + 24) / 65536;
    }
  }
  if (kind === 'video' && (width === undefined || width === 0) && tw > 0) { width = Math.round(tw); height = Math.round(th); }
  const stts = stbl?.children.find((c2) => c2.type === 'stts');
  let sampleCount: number | undefined;
  if (stts) {
    const p = body(stts) + 4;
    const n = u32(d, p);
    let total = 0;
    for (let i = 0; i < n && p + 4 + i * 8 + 8 <= stts.offset + stts.size; i++) total += u32(d, p + 4 + i * 8);
    sampleCount = total;
  }
  const stsz = stbl?.children.find((c2) => c2.type === 'stsz');
  let bytes: number | undefined;
  if (stsz) {
    const p = body(stsz) + 4;
    const fixed = u32(d, p);
    const n = u32(d, p + 4);
    if (fixed > 0) bytes = fixed * n;
    else {
      bytes = 0;
      for (let i = 0; i < n && p + 8 + i * 4 + 4 <= stsz.offset + stsz.size; i++) bytes += u32(d, p + 8 + i * 4);
    }
    sampleCount ??= n;
  }
  const durSec = mdur !== undefined && timescale > 0 ? mdur / timescale : movieTimescale > 0 ? duration / movieTimescale : undefined;
  const swap = rotation === 90 || rotation === 270;
  return {
    id, kind, handler, codec: entry?.type, codecString: entry ? codecStringFor(d, entry) : undefined,
    timescale, durationSeconds: durSec, language,
    width, height, rotation,
    displayWidth: swap ? height : width, displayHeight: swap ? width : height,
    frameRate: kind === 'video' && sampleCount && durSec ? Number((sampleCount / durSec).toFixed(3)) : undefined,
    sampleCount, bitrate: bytes !== undefined && durSec ? Math.round((bytes * 8) / durSec) : undefined,
    channels, sampleRate, enabled: (flags & 1) === 1,
  };
}

function probeHeif(d: Uint8Array, meta: Box): HeifItem[] {
  const pitm = meta.children.find((c) => c.type === 'pitm');
  const primary = pitm ? (d[body(pitm)]! === 0 ? u16(d, body(pitm) + 4) : u32(d, body(pitm) + 4)) : undefined;
  const iinf = meta.children.find((c) => c.type === 'iinf');
  const types = new Map<number, string>();
  for (const infe of iinf?.children.filter((c) => c.type === 'infe') ?? []) {
    const p = body(infe);
    const v = d[p]!;
    if (v >= 2) {
      const id = v === 2 ? u16(d, p + 4) : u32(d, p + 4);
      types.set(id, fourcc(d, p + (v === 2 ? 8 : 10)));
    }
  }
  const ipco = pathFrom([meta], ['meta', 'iprp', 'ipco'])[0] ?? meta.children.find((c) => c.type === 'iprp')?.children.find((c) => c.type === 'ipco');
  const props = ipco?.children ?? [];
  const ipma = meta.children.find((c) => c.type === 'iprp')?.children.find((c) => c.type === 'ipma');
  const assoc = new Map<number, number[]>();
  if (ipma) {
    let p = body(ipma);
    const v = d[p]!;
    const flags = u32(d, p) & 0xffffff;
    p += 4;
    const n = u32(d, p);
    p += 4;
    for (let i = 0; i < n && p < ipma.offset + ipma.size; i++) {
      const id = v < 1 ? u16(d, p) : u32(d, p);
      p += v < 1 ? 2 : 4;
      const cnt = d[p++]!;
      const list: number[] = [];
      for (let k = 0; k < cnt; k++) {
        if (flags & 1) { list.push(u16(d, p) & 0x7fff); p += 2; } else list.push(d[p++]! & 0x7f);
      }
      assoc.set(id, list);
    }
  }
  const items: HeifItem[] = [];
  for (const [id, type] of types) {
    let width: number | undefined;
    let height: number | undefined;
    let rotation: 0 | 90 | 180 | 270 = 0;
    for (const idx of assoc.get(id) ?? []) {
      const prop = props[idx - 1];
      if (!prop) continue;
      if (prop.type === 'ispe') { width = u32(d, body(prop) + 4); height = u32(d, body(prop) + 8); }
      if (prop.type === 'irot') rotation = (((d[body(prop)]! & 3) * 90) as 0 | 90 | 180 | 270);
    }
    items.push({ id, type, primary: id === primary, width, height, rotation });
  }
  return items.sort((a, b) => a.id - b.id);
}

// ------------------------------------------------------------------------------------------------ probe

export function probe(data: Uint8Array, limits: Partial<Limits> = {}): Probe {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const top = parseBoxes(data, 0, data.length, lim);
  const truncated = top.some((b) => b.truncated) || top.length === 0;
  const ftyp = find(top, 'ftyp');
  let major: string | undefined;
  let minor: number | undefined;
  const brands: string[] = [];
  if (ftyp && ftyp.size >= ftyp.headerSize + 8) {
    const p = body(ftyp);
    major = fourcc(data, p);
    minor = u32(data, p + 4);
    for (let o = p + 8; o + 4 <= ftyp.offset + ftyp.size; o += 4) brands.push(fourcc(data, o));
  }
  const moov = find(top, 'moov');
  let movieTimescale: number | undefined;
  let movieDuration: number | undefined;
  let creation: Date | undefined;
  const mvhd = moov?.children.find((c) => c.type === 'mvhd');
  if (mvhd) {
    const p = body(mvhd);
    const v = data[p]!;
    need(data, p, v === 1 ? 32 : 20, 'the movie header');
    const created = v === 1 ? u64(data, p + 4) : u32(data, p + 4);
    movieTimescale = u32(data, p + (v === 1 ? 20 : 12));
    movieDuration = v === 1 ? u64(data, p + 24) : u32(data, p + 16);
    // seconds since 1904-01-01; zero means unset
    if (created > 0) creation = new Date((created - 2082844800) * 1000);
  }
  const fragmented = moov?.children.some((c) => c.type === 'mvex') === true || top.some((b) => b.type === 'moof');
  const mehd = pathFrom(moov ? [moov] : [], ['moov', 'mvex', 'mehd'])[0];
  let durationSeconds = movieTimescale && movieDuration !== undefined ? movieDuration / movieTimescale : undefined;
  if (mehd && movieTimescale && (durationSeconds === undefined || durationSeconds === 0)) {
    const p = body(mehd);
    durationSeconds = (data[p] === 1 ? u64(data, p + 4) : u32(data, p + 4)) / movieTimescale;
  }
  const tracks: Track[] = [];
  for (const trak of moov?.children.filter((c) => c.type === 'trak') ?? []) {
    const t = probeTrack(data, trak, movieTimescale ?? 1);
    if (t) tracks.push(t);
  }
  // metadata keys (QuickTime) and GPS
  let metadata: Record<string, string> = {};
  const metas = [...(moov?.children.filter((c) => c.type === 'meta') ?? []), ...(top.filter((c) => c.type === 'meta'))];
  for (const m of metas) metadata = { ...metadata, ...readKeysAndValues(data, m) };
  let gps: GeoPoint | undefined;
  const xyz = pathFrom(moov ? [moov] : [], ['moov', 'udta', '©xyz'])[0];
  if (xyz && xyz.size > xyz.headerSize + 4) gps = parseIso6709(utf8(data, body(xyz) + 4, xyz.offset + xyz.size).replace(/\0/g, ''));
  const locKey = metadata['com.apple.quicktime.location.ISO6709'];
  if (!gps && locKey) gps = parseIso6709(locKey);
  const items: HeifItem[] = [];
  const topMeta = top.find((c) => c.type === 'meta');
  if (topMeta && topMeta.children.some((c) => c.type === 'iinf')) items.push(...probeHeif(data, topMeta));

  const moovAt = top.findIndex((b) => b.type === 'moov');
  const mdatAt = top.findIndex((b) => b.type === 'mdat');
  const faststart = moovAt >= 0 && mdatAt >= 0 ? moovAt < mdatAt : undefined;
  const checks: Check[] = [];
  const chk = (name: string, ok: boolean, message: string) => void checks.push({ name, ok, message });
  chk('ftyp', ftyp !== undefined, ftyp ? `brand ${major}` : 'there is no ftyp box');
  if (ftyp) chk('ftyp-first', top[0]?.type === 'ftyp' || top[0]?.type === 'wide' || top[0]?.type === 'free', top[0]?.type === 'ftyp' ? 'ftyp is the first box' : `the first box is "${top[0]?.type}", not ftyp`);
  const isImage = items.length > 0;
  if (!isImage) {
    chk('moov', moov !== undefined && !moov.truncated, moov ? (moov.truncated ? 'the movie box is cut short' : 'movie box present') : 'there is no moov box (a download cut short, or a file still being written)');
    chk('mdat', mdatAt >= 0 || fragmented, mdatAt >= 0 || fragmented ? 'media data present' : 'there is no mdat box');
    if (faststart !== undefined) chk('faststart', faststart, faststart ? 'moov comes before mdat: playback can start before the download ends' : 'moov comes after mdat: a player must fetch the end of the file first');
    chk('tracks', tracks.length > 0, tracks.length ? `${tracks.length} track(s)` : 'no tracks');
    const missingCodec = tracks.filter((t) => (t.kind === 'video' || t.kind === 'audio') && !t.codec);
    chk('codecs', missingCodec.length === 0, missingCodec.length ? `track ${missingCodec.map((t) => t.id).join(', ')} has no sample description` : 'every audio and video track has a sample description');
    const ids = tracks.map((t) => t.id);
    chk('track-ids', new Set(ids).size === ids.length && ids.every((i) => i > 0), 'track ids are unique and above zero');
    if (durationSeconds && durationSeconds > 0) {
      const off = tracks.filter((t) => t.durationSeconds !== undefined && Math.abs(t.durationSeconds - durationSeconds) > Math.max(2, durationSeconds * 0.05));
      chk('durations', off.length === 0, off.length ? `track ${off.map((t) => t.id).join(', ')} differs from the movie duration by more than 5%` : 'track durations agree with the movie');
    }
  } else {
    chk('primary-item', items.some((i) => i.primary), items.some((i) => i.primary) ? 'a primary item is declared' : 'no primary item');
  }
  chk('complete', !truncated, truncated ? 'the data ends inside a box' : 'every box is complete');

  const kind: Probe['kind'] = isImage ? 'image' : tracks.some((t) => t.kind === 'video') ? 'video' : tracks.some((t) => t.kind === 'audio') ? 'audio' : 'unknown';
  return {
    majorBrand: major, minorVersion: minor, brands, kind, durationSeconds, timescale: movieTimescale, creationTime: creation, fragmented, truncated,
    tracks, metadata, contentIdentifier: metadata['com.apple.quicktime.content.identifier'], gps, items, checks, topLevel: top.map((b) => b.type), faststart,
  };
}

// ------------------------------------------------------------------------------------------------ pairs

/** A QuickTime movie and a still belong together as a Live Photo when they carry the same content identifier. */
export function isLivePhotoPair(movie: Probe, stillContentIdentifier: string | undefined): boolean {
  return movie.contentIdentifier !== undefined && stillContentIdentifier !== undefined && movie.contentIdentifier.toLowerCase() === stillContentIdentifier.toLowerCase() && movie.kind === 'video';
}

export interface MotionPhoto {
  /** Where the embedded MP4 starts in the file. */
  readonly offset: number;
  readonly length: number;
  readonly source: 'xmp-microvideo' | 'xmp-container' | 'scan';
}

const MP4_BRANDS = /^(isom|iso2|mp41|mp42|avc1|M4V |qt  |3gp\d|dash|MSNV)/;

/** Find the MP4 trailing a JPEG. XMP is trusted only when the ftyp box really is at the offset it names. */
export function findMotionPhoto(jpeg: Uint8Array): MotionPhoto | undefined {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new IsoError('not a JPEG (no start-of-image marker)');
  const text = new TextDecoder('latin1').decode(jpeg.subarray(0, Math.min(jpeg.length, 262_144)));
  const ftypAt = (start: number) => start >= 0 && start + 12 <= jpeg.length && fourcc(jpeg, start + 4) === 'ftyp' && MP4_BRANDS.test(fourcc(jpeg, start + 8));
  const micro = /MicroVideoOffset\s*=\s*"(\d+)"|<GCamera:MicroVideoOffset>(\d+)</.exec(text);
  if (micro && /MicroVideo\s*=\s*"1"|<GCamera:MicroVideo>1</.test(text)) {
    const fromEnd = Number(micro[1] ?? micro[2]);
    const start = jpeg.length - fromEnd;
    if (fromEnd > 0 && ftypAt(start)) return { offset: start, length: fromEnd, source: 'xmp-microvideo' };
  }
  const item = /Item:Semantic\s*=\s*"MotionPhoto"[^>]*?Item:Length\s*=\s*"(\d+)"|Item:Length\s*=\s*"(\d+)"[^>]*?Item:Semantic\s*=\s*"MotionPhoto"/.exec(text);
  if (item) {
    const len = Number(item[1] ?? item[2]);
    const start = jpeg.length - len;
    if (len > 0 && ftypAt(start)) return { offset: start, length: len, source: 'xmp-container' };
  }
  // last resort: the first ftyp box with a sane size and a known brand, past the first 100 bytes.
  for (let i = 100; i + 12 <= jpeg.length; i++) {
    if (jpeg[i + 4] === 0x66 && fourcc(jpeg, i + 4) === 'ftyp' && MP4_BRANDS.test(fourcc(jpeg, i + 8))) {
      const size = u32(jpeg, i);
      if (size >= 16 && size <= 256) return { offset: i, length: jpeg.length - i, source: 'scan' };
    }
  }
  return undefined;
}
