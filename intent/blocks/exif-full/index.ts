/**
 * The metadata inside a photo, read safely and in full: EXIF (CIPA DC-008 / TIFF 6.0) from IFD0, the Exif IFD and
 * the GPS IFD, with the thumbnail's place recorded; IPTC-IIM (the Photoshop 8BIM 0x0404 block) for captions,
 * keywords, credits and place names; and XMP (ISO 16684-1) for the same editorial fields plus ratings, read with
 * the dav block's XML parser, which refuses DTDs and entities. Files come in as JPEG, PNG (eXIf, XMP iTXt), WebP
 * (EXIF, XMP chunks) or a bare TIFF header. Everything is bounds-checked against hostile files: every offset and
 * length is tested against the buffer, IFD pointers that loop or repeat are not followed twice, entry counts and
 * value sizes have ceilings, strings are cut at their NUL and stripped of control characters, a damaged entry is
 * skipped with a warning rather than failing the file, and only a bad header or an over-large file throws.
 * Values are made usable: rationals with a zero denominator are absent rather than Infinity or NaN; GPS degrees,
 * minutes and seconds become signed decimal degrees (a no-fix 0,0 is absent); exposure becomes "1/250"; make and
 * model become one camera name without the doubled brand. "When was this taken" is answered with its source: the
 * OffsetTimeOriginal tag if present, else the zone implied by GPS time against the camera's clock (accepted
 * within five minutes of a quarter hour), else the local time with no zone claimed. Body and lens serial numbers
 * are left out unless asked for. `merge` combines EXIF, IPTC, XMP and a sidecar .xmp by stated precedence, and
 * `withoutLocation` removes what says where a photo was taken.
 *
 * Out of scope: maker notes (their size and brand are recorded, their contents are not read: each maker uses its
 * own undocumented layout), writing or rewriting metadata (see imagemeta's stripJpeg for removal), extended XMP
 * split across several JPEG segments, XMP in UTF-16, 8BIM blocks other than IPTC, MPF and other APPn segments,
 * and RAW container formats.
 */
import { parseXml } from '../dav/index.ts';
import type { El } from '../dav/index.ts';

export class ExifError extends Error {}

/** A limit was exceeded: the file is treated as hostile rather than damaged. */
export class ExifLimitError extends ExifError {}

export interface Limits {
  readonly maxFileBytes?: number;
  /** Total IFD entries read across the file. */
  readonly maxEntries?: number;
  /** Largest single value read, in bytes. */
  readonly maxValueBytes?: number;
  readonly maxXmpBytes?: number;
}

const DEFAULTS = { maxFileBytes: 64 * 1024 * 1024, maxEntries: 4096, maxValueBytes: 1 << 20, maxXmpBytes: 1 << 20 };

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

export interface Gps {
  readonly lat: number;
  readonly lon: number;
  readonly alt: number | undefined;
  /** UTC from GPSDateStamp and GPSTimeStamp. */
  readonly time: string | undefined;
  readonly direction: number | undefined;
}

export interface TakenAt {
  /** YYYY-MM-DDTHH:MM:SS as the camera's wall clock showed it. */
  readonly local: string;
  readonly offset: string | undefined;
  /** ISO instant, when a zone is known. */
  readonly utc: string | undefined;
  readonly source: 'offset-tag' | 'gps' | 'none';
}

export interface Exif {
  readonly make: string | undefined;
  readonly model: string | undefined;
  readonly camera: string | undefined;
  readonly lens: string | undefined;
  readonly software: string | undefined;
  readonly orientation: number | undefined;
  readonly description: string | undefined;
  readonly artist: string | undefined;
  readonly copyright: string | undefined;
  readonly userComment: string | undefined;
  readonly takenAt: TakenAt | undefined;
  readonly digitizedAt: string | undefined;
  /** Seconds. */
  readonly exposureTime: number | undefined;
  /** "1/250" or "2s". */
  readonly exposure: string | undefined;
  readonly fNumber: number | undefined;
  readonly iso: number | undefined;
  readonly focalLength: number | undefined;
  readonly focalLength35: number | undefined;
  readonly flash: { readonly fired: boolean; readonly raw: number } | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly gps: Gps | undefined;
  readonly makerNote: { readonly size: number } | undefined;
  /** Where the thumbnail's JPEG bytes are in the TIFF block, checked to lie inside it. */
  readonly thumbnail: { readonly offset: number; readonly length: number } | undefined;
  readonly bodySerial: string | undefined;
  readonly lensSerial: string | undefined;
  readonly warnings: readonly string[];
}

// --- TIFF structure -------------------------------------------------------------------------------------------

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Where the value's bytes start in the buffer. */
  readonly at: number;
  readonly bytes: number;
}

interface Tiff {
  readonly buf: Buffer;
  readonly le: boolean;
  readonly ifd0: Map<number, Entry>;
  readonly ifd1: Map<number, Entry>;
  readonly exif: Map<number, Entry>;
  readonly gps: Map<number, Entry>;
  readonly warnings: string[];
}

class Reader {
  readonly b: Buffer;
  readonly le: boolean;
  constructor(b: Buffer, le: boolean) {
    this.b = b;
    this.le = le;
  }
  u16(o: number): number {
    return this.le ? this.b.readUInt16LE(o) : this.b.readUInt16BE(o);
  }
  u32(o: number): number {
    return this.le ? this.b.readUInt32LE(o) : this.b.readUInt32BE(o);
  }
  i32(o: number): number {
    return this.le ? this.b.readInt32LE(o) : this.b.readInt32BE(o);
  }
}

export function parseTiff(buf: Buffer, limits: Limits = {}): Tiff {
  const lim = { ...DEFAULTS, ...limits };
  if (buf.length > lim.maxFileBytes) throw new ExifLimitError('the metadata block is too large');
  if (buf.length < 8) throw new ExifError('too short to be a TIFF header');
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new ExifError('the byte order mark is neither II nor MM');
  const r = new Reader(buf, order === 'II');
  if (r.u16(2) !== 42) throw new ExifError('the TIFF magic number is not 42');
  const first = r.u32(4);
  if (first < 8 || first > buf.length - 2) throw new ExifError('the first IFD offset is outside the data');
  const warnings: string[] = [];
  const visited = new Set<number>();
  let total = 0;

  const readIfd = (off: number, name: string): Map<number, Entry> => {
    const out = new Map<number, Entry>();
    if (visited.has(off)) {
      warnings.push(`${name}: the IFD at ${off} was already read (a loop), not followed again`);
      return out;
    }
    visited.add(off);
    if (off < 8 || off + 2 > buf.length) {
      warnings.push(`${name}: the IFD offset ${off} is outside the data`);
      return out;
    }
    let n = r.u16(off);
    if (off + 2 + n * 12 > buf.length) {
      const fits = Math.floor((buf.length - off - 2) / 12);
      warnings.push(`${name}: ${n} entries declared but only ${fits} fit in the data`);
      n = Math.max(fits, 0);
    }
    for (let i = 0; i < n; i++) {
      if (++total > lim.maxEntries) throw new ExifLimitError(`more than ${lim.maxEntries} IFD entries`);
      const e = off + 2 + i * 12;
      const tag = r.u16(e);
      const type = r.u16(e + 2);
      const count = r.u32(e + 4);
      if (type < 1 || type > 12) {
        warnings.push(`${name}: tag 0x${tag.toString(16)} has unknown type ${type}`);
        continue;
      }
      const bytes = count * TYPE_SIZE[type]!;
      if (bytes > lim.maxValueBytes) {
        warnings.push(`${name}: tag 0x${tag.toString(16)} is ${bytes} bytes, over the ${lim.maxValueBytes} limit`);
        continue;
      }
      let at = e + 8;
      if (bytes > 4) {
        at = r.u32(e + 8);
        if (at < 8 || at + bytes > buf.length) {
          warnings.push(`${name}: tag 0x${tag.toString(16)} points outside the data`);
          continue;
        }
      }
      if (out.has(tag)) warnings.push(`${name}: tag 0x${tag.toString(16)} appears twice, the first is used`);
      else out.set(tag, { tag, type, count, at, bytes });
    }
    return out;
  };

  const ifd0 = readIfd(first, 'IFD0');
  const lastEntryEnd = first + 2 + Math.min(r.u16(first), Math.max(0, Math.floor((buf.length - first - 2) / 12))) * 12;
  const nextOff = lastEntryEnd + 4 <= buf.length ? r.u32(lastEntryEnd) : 0;
  const ifd1 = nextOff ? readIfd(nextOff, 'IFD1') : new Map<number, Entry>();
  const sub = (m: Map<number, Entry>, tag: number, name: string) => {
    const e = m.get(tag);
    if (!e) return new Map<number, Entry>();
    if (e.type !== 4 || e.count !== 1) {
      warnings.push(`${name}: the pointer tag has the wrong type`);
      return new Map<number, Entry>();
    }
    return readIfd(r.u32(e.at), name);
  };
  const exif = sub(ifd0, 0x8769, 'Exif IFD');
  const gps = sub(ifd0, 0x8825, 'GPS IFD');
  return { buf, le: r.le, ifd0, ifd1, exif, gps, warnings };
}

// --- value access ---------------------------------------------------------------------------------------------

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function cleanText(s: string, max = 2000): string {
  return s.replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function str(t: Tiff, e: Entry | undefined): string | undefined {
  if (!e || (e.type !== 2 && e.type !== 7)) return undefined;
  let end = e.at + e.bytes;
  const nul = t.buf.indexOf(0, e.at);
  if (nul >= 0 && nul < end) end = nul;
  const s = cleanText(t.buf.toString('utf8', e.at, end));
  return s || undefined;
}

function nums(t: Tiff, e: Entry | undefined, types: readonly number[]): number[] | undefined {
  if (!e || !types.includes(e.type)) return undefined;
  const r = new Reader(t.buf, t.le);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const o = e.at + i * TYPE_SIZE[e.type]!;
    switch (e.type) {
      case 1: case 7: out.push(t.buf[o]!); break;
      case 3: out.push(r.u16(o)); break;
      case 4: out.push(r.u32(o)); break;
      case 6: out.push(t.buf.readInt8(o)); break;
      case 8: out.push(t.le ? t.buf.readInt16LE(o) : t.buf.readInt16BE(o)); break;
      case 9: out.push(r.i32(o)); break;
      default: return undefined;
    }
  }
  return out;
}

/** Rationals as numbers; undefined where the denominator is zero. */
function rats(t: Tiff, e: Entry | undefined): (number | undefined)[] | undefined {
  if (!e || (e.type !== 5 && e.type !== 10 && e.type !== 11 && e.type !== 12)) return undefined;
  const r = new Reader(t.buf, t.le);
  const out: (number | undefined)[] = [];
  if (e.type >= 11) {
    // some writers store these as FLOAT or DOUBLE instead of RATIONAL
    for (let i = 0; i < e.count; i++) {
      const v = e.type === 11 ? (t.le ? t.buf.readFloatLE(e.at + i * 4) : t.buf.readFloatBE(e.at + i * 4)) : t.le ? t.buf.readDoubleLE(e.at + i * 8) : t.buf.readDoubleBE(e.at + i * 8);
      out.push(Number.isFinite(v) ? v : undefined);
    }
    return out;
  }
  for (let i = 0; i < e.count; i++) {
    const o = e.at + i * 8;
    const n = e.type === 5 ? r.u32(o) : r.i32(o);
    const d = e.type === 5 ? r.u32(o + 4) : r.i32(o + 4);
    out.push(d === 0 ? undefined : n / d);
  }
  return out;
}

const int = (t: Tiff, e: Entry | undefined) => nums(t, e, [1, 3, 4])?.[0];
const rat = (t: Tiff, e: Entry | undefined) => rats(t, e)?.[0];

function userComment(t: Tiff, e: Entry | undefined): string | undefined {
  if (!e || e.type !== 7 || e.bytes < 8) return undefined;
  const code = t.buf.toString('latin1', e.at, e.at + 8);
  const body = t.buf.subarray(e.at + 8, e.at + e.bytes);
  let s: string;
  if (code.startsWith('ASCII')) s = body.toString('latin1');
  else if (code.startsWith('UNICODE')) {
    const even = body.subarray(0, body.length - (body.length % 2));
    s = t.le ? even.toString('utf16le') : Buffer.from(even).swap16().toString('utf16le');
  } else if (code === '\u0000'.repeat(8)) s = body.toString('utf8');
  else return undefined;
  const nul = s.indexOf('\u0000');
  return cleanText(nul >= 0 ? s.slice(0, nul) : s) || undefined;
}

function wall(s: string | undefined): { y: number; mo: number; d: number; h: number; mi: number; s: number } | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s ?? '');
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (y < 1 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi) return undefined;
  return { y, mo, d, h, mi, s: sec };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const localOf = (w: NonNullable<ReturnType<typeof wall>>) => `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
const wallMs = (w: NonNullable<ReturnType<typeof wall>>) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

function parseOffset(s: string | undefined): number | undefined {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(s ?? '');
  if (!m) return undefined;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  if (Number(m[3]) > 59 || mins > 14 * 60) return undefined;
  return (m[1] === '-' ? -1 : 1) * mins;
}

const fmtOffset = (mins: number) => `${mins < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(mins) / 60))}:${pad(Math.abs(mins) % 60)}`;

/** When a photo was taken, from the camera's local time, its offset tag, and the GPS clock; with the source named. */
export function inferTakenAt(localTime: string | undefined, offsetTag: string | undefined, gpsUtc: string | undefined): TakenAt | undefined {
  const w = wall(localTime);
  if (!w) return undefined;
  const local = localOf(w);
  const tagMins = parseOffset(offsetTag);
  if (tagMins !== undefined) return { local, offset: fmtOffset(tagMins), utc: new Date(wallMs(w) - tagMins * 60_000).toISOString(), source: 'offset-tag' };
  const g = gpsUtc ? Date.parse(gpsUtc) : NaN;
  if (Number.isFinite(g)) {
    const diffMin = (wallMs(w) - g) / 60_000;
    const q = Math.round(diffMin / 15) * 15;
    if (Math.abs(diffMin - q) <= 5 && Math.abs(q) <= 14 * 60) return { local, offset: fmtOffset(q), utc: new Date(wallMs(w) - q * 60_000).toISOString(), source: 'gps' };
  }
  return { local, offset: undefined, utc: undefined, source: 'none' };
}

function dms(v: (number | undefined)[] | undefined, ref: string | undefined, axis: 'lat' | 'lon'): number | undefined {
  if (!v || v.length !== 3 || v.some((x) => x === undefined || !Number.isFinite(x))) return undefined;
  const [d, m, s] = v as [number, number, number];
  if (d < 0 || m < 0 || m >= 60 || s < 0 || s >= 60) return undefined;
  const sign = ref === (axis === 'lat' ? 'S' : 'W') ? -1 : ref === (axis === 'lat' ? 'N' : 'E') ? 1 : 0;
  if (sign === 0) return undefined;
  const deg = sign * (d + m / 60 + s / 3600);
  return Math.abs(deg) <= (axis === 'lat' ? 90 : 180) ? deg : undefined;
}

function gpsOf(t: Tiff, warnings: string[]): Gps | undefined {
  const g = t.gps;
  if (g.size === 0) return undefined;
  const lat = dms(rats(t, g.get(2)), str(t, g.get(1)), 'lat');
  const lon = dms(rats(t, g.get(4)), str(t, g.get(3)), 'lon');
  if (lat === undefined || lon === undefined) {
    if (g.has(2) || g.has(4)) warnings.push('GPS: the coordinates are missing or not valid');
    return undefined;
  }
  if (lat === 0 && lon === 0) return undefined;
  const altRaw = rat(t, g.get(6));
  const alt = altRaw === undefined ? undefined : (int(t, g.get(5)) === 1 ? -altRaw : altRaw);
  const ts = rats(t, g.get(7));
  const ds = str(t, g.get(29));
  let time: string | undefined;
  const dm = /^(\d{4}):(\d{2}):(\d{2})$/.exec(ds ?? '');
  if (dm && ts && ts.length === 3 && ts.every((x) => x !== undefined && x >= 0)) {
    const [h, mi, s] = ts as [number, number, number];
    if (h < 24 && mi < 60 && s < 60) {
      const d = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), h, mi, Math.floor(s)));
      if (d.getUTCMonth() === Number(dm[2]) - 1 && d.getUTCDate() === Number(dm[3])) time = d.toISOString();
    }
  }
  const dir = rat(t, g.get(17));
  return { lat, lon, alt, time, direction: dir !== undefined && dir >= 0 && dir < 360 ? dir : undefined };
}

export function formatExposure(sec: number | undefined): string | undefined {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return undefined;
  if (sec >= 1) return `${Number.isInteger(sec) ? sec : Number(sec.toFixed(1))}s`;
  const inv = 1 / sec;
  return `1/${Math.abs(inv - Math.round(inv)) <= inv * 0.01 ? Math.round(inv) : Number(inv.toFixed(1))}`;
}

const MAKES: readonly [RegExp, string][] = [
  [/^nikon(?: corporation)?$/i, 'Nikon'],
  [/^canon(?: inc\.?)?$/i, 'Canon'],
  [/^sony(?: corporation)?$/i, 'Sony'],
  [/^olympus(?: imaging corp\.?| corporation| optical co\.?,? ltd\.?)?$/i, 'Olympus'],
  [/^fuji(?:film| photo film co\.?,? ltd\.?)$/i, 'Fujifilm'],
  [/^panasonic$/i, 'Panasonic'],
  [/^apple$/i, 'Apple'],
  [/^samsung(?: electronics)?$/i, 'Samsung'],
  [/^google$/i, 'Google'],
  [/^leica camera ag$|^leica$/i, 'Leica'],
  [/^pentax(?: corporation)?$|^ricoh imaging company,? ltd\.?$/i, 'Pentax'],
  [/^hasselblad$/i, 'Hasselblad'],
  [/^gopro$/i, 'GoPro'],
  [/^dji$/i, 'DJI'],
];

/** One camera name from make and model: brand spelled once, in its usual form. */
export function normaliseCamera(make: string | undefined, model: string | undefined): string | undefined {
  const mk0 = make ? cleanText(make, 100) : '';
  const md = model ? cleanText(model, 100) : '';
  let mk = mk0;
  for (const [re, name] of MAKES) if (re.test(mk0)) mk = name;
  if (!md) return mk || undefined;
  if (!mk) return md;
  const first = md.split(' ')[0]!;
  const brandInModel = MAKES.find(([re]) => re.test(first));
  if (md.toLowerCase().startsWith(mk.toLowerCase() + ' ') || md.toLowerCase() === mk.toLowerCase()) return mk + md.slice(mk.length);
  if (brandInModel && brandInModel[1] === mk) return `${mk}${md.slice(first.length)}`;
  return `${mk} ${md}`;
}

export interface ReadOptions extends Limits {
  /** Include body and lens serial numbers. They identify a particular camera, so are off by default. */
  readonly serials?: boolean;
}

export function exifOf(t: Tiff, o: { serials?: boolean } = {}): Exif {
  const warnings = [...t.warnings];
  const e0 = t.ifd0;
  const ex = t.exif;
  const make = str(t, e0.get(0x010f));
  const model = str(t, e0.get(0x0110));
  const gps = gpsOf(t, warnings);
  const takenLocal = str(t, ex.get(0x9003)) ?? str(t, e0.get(0x0132));
  const offsetTag = str(t, ex.get(0x9011)) ?? (ex.has(0x9003) ? undefined : str(t, ex.get(0x9010)));
  const exposureTime = rat(t, ex.get(0x829a));
  const flash = int(t, ex.get(0x9209));
  const orientation = int(t, e0.get(0x0112));
  const thumbOff = int(t, t.ifd1.get(0x0201));
  const thumbLen = int(t, t.ifd1.get(0x0202));
  const thumb = thumbOff !== undefined && thumbLen !== undefined && thumbLen > 0 && thumbOff >= 8 && thumbOff + thumbLen <= t.buf.length ? { offset: thumbOff, length: thumbLen } : undefined;
  if ((thumbOff !== undefined || thumbLen !== undefined) && !thumb) warnings.push('IFD1: the thumbnail lies outside the data');
  const maker = ex.get(0x927c);
  const takenAt = inferTakenAt(takenLocal, offsetTag, gps?.time);
  if (takenLocal && !takenAt) warnings.push('the capture time is not a valid date');
  const digitized = wall(str(t, ex.get(0x9004)));
  return {
    make, model, camera: normaliseCamera(make, model), lens: str(t, ex.get(0xa434)),
    software: str(t, e0.get(0x0131)),
    orientation: orientation !== undefined && orientation >= 1 && orientation <= 8 ? orientation : undefined,
    description: str(t, e0.get(0x010e)), artist: str(t, e0.get(0x013b)), copyright: str(t, e0.get(0x8298)),
    userComment: userComment(t, ex.get(0x9286)),
    takenAt, digitizedAt: digitized ? localOf(digitized) : undefined,
    exposureTime: exposureTime !== undefined && exposureTime > 0 ? exposureTime : undefined,
    exposure: formatExposure(exposureTime),
    fNumber: (() => { const f = rat(t, ex.get(0x829d)); return f !== undefined && f > 0 ? f : undefined; })(),
    iso: (() => { const i = int(t, ex.get(0x8827)) ?? int(t, ex.get(0x8831)); return i !== undefined && i > 0 ? i : undefined; })(),
    focalLength: (() => { const f = rat(t, ex.get(0x920a)); return f !== undefined && f > 0 ? f : undefined; })(),
    focalLength35: int(t, ex.get(0xa405)),
    flash: flash === undefined ? undefined : { fired: (flash & 1) === 1, raw: flash },
    width: int(t, ex.get(0xa002)), height: int(t, ex.get(0xa003)),
    gps,
    makerNote: maker ? { size: maker.bytes } : undefined,
    thumbnail: thumb,
    bodySerial: o.serials ? str(t, ex.get(0xa431)) : undefined,
    lensSerial: o.serials ? str(t, ex.get(0xa435)) : undefined,
    warnings,
  };
}

// --- containers -----------------------------------------------------------------------------------------------

export interface Found {
  readonly tiff: Buffer | undefined;
  readonly iptc: Buffer | undefined;
  readonly xmp: string | undefined;
  readonly warnings: string[];
}

const XMP_NS = 'http://ns.adobe.com/xap/1.0/\u0000';

function photoshopIptc(b: Buffer, warnings: string[]): Buffer | undefined {
  if (!b.subarray(0, 14).equals(Buffer.from('Photoshop 3.0\u0000'))) return undefined;
  let p = 14;
  while (p + 12 <= b.length) {
    if (b.toString('latin1', p, p + 4) !== '8BIM') {
      warnings.push('Photoshop block: a resource does not start with 8BIM, stopped reading');
      return undefined;
    }
    const id = b.readUInt16BE(p + 4);
    const nameLen = b[p + 6]!;
    const nameEnd = p + 7 + nameLen + ((nameLen + 1) % 2);
    if (nameEnd + 4 > b.length) return undefined;
    const size = b.readUInt32BE(nameEnd);
    const start = nameEnd + 4;
    if (start + size > b.length) {
      warnings.push('Photoshop block: a resource is longer than the segment');
      return undefined;
    }
    if (id === 0x0404) return b.subarray(start, start + size);
    p = start + size + (size % 2);
  }
  return undefined;
}

function fromJpeg(b: Buffer, lim: typeof DEFAULTS): Found {
  const warnings: string[] = [];
  let tiff: Buffer | undefined;
  let iptc: Buffer | undefined;
  let xmp: string | undefined;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      warnings.push('JPEG: a marker is missing, stopped reading');
      break;
    }
    const m = b[p + 1]!;
    if (m === 0xff) { p++; continue; }
    if (m === 0xd9 || m === 0xda) break;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { p += 2; continue; }
    const len = b.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > b.length) {
      warnings.push('JPEG: a segment is longer than the file');
      break;
    }
    const body = b.subarray(p + 4, p + 2 + len);
    if (m === 0xe1) {
      if (body.length > 6 && body.toString('latin1', 0, 6) === 'Exif\u0000\u0000') tiff ??= body.subarray(6);
      else if (body.toString('latin1', 0, XMP_NS.length) === XMP_NS) {
        if (body.length - XMP_NS.length > lim.maxXmpBytes) warnings.push('XMP: larger than the limit, ignored');
        else xmp ??= body.toString('utf8', XMP_NS.length);
      }
    } else if (m === 0xed) iptc ??= photoshopIptc(body, warnings);
    p += 2 + len;
  }
  return { tiff, iptc, xmp, warnings };
}

function fromPng(b: Buffer, lim: typeof DEFAULTS): Found {
  const warnings: string[] = [];
  let tiff: Buffer | undefined;
  let xmp: string | undefined;
  let p = 8;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > b.length) {
      warnings.push('PNG: a chunk is longer than the file');
      break;
    }
    const body = b.subarray(p + 8, p + 8 + len);
    if (type === 'eXIf') tiff ??= body;
    else if (type === 'iTXt' && body.toString('latin1', 0, 18) === 'XML:com.adobe.xmp\u0000') {
      // keyword NUL, compression flag, method, language NUL, translated keyword NUL, text
      const comp = body[18];
      let q = 20;
      for (let i = 0; i < 2; i++) {
        const z = body.indexOf(0, q);
        if (z < 0) { q = body.length; break; }
        q = z + 1;
      }
      if (comp === 0 && q <= body.length && body.length - q <= lim.maxXmpBytes) xmp ??= body.toString('utf8', q);
      else warnings.push('XMP: compressed or oversized iTXt, ignored');
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return { tiff, iptc: undefined, xmp, warnings };
}

function fromWebp(b: Buffer, lim: typeof DEFAULTS): Found {
  const warnings: string[] = [];
  let tiff: Buffer | undefined;
  let xmp: string | undefined;
  let p = 12;
  while (p + 8 <= b.length) {
    const type = b.toString('latin1', p, p + 4);
    const len = b.readUInt32LE(p + 4);
    if (p + 8 + len > b.length) {
      warnings.push('WebP: a chunk is longer than the file');
      break;
    }
    const body = b.subarray(p + 8, p + 8 + len);
    if (type === 'EXIF') tiff ??= body.toString('latin1', 0, 6) === 'Exif\u0000\u0000' ? body.subarray(6) : body;
    else if (type === 'XMP ' && len <= lim.maxXmpBytes) xmp ??= body.toString('utf8');
    p += 8 + len + (len % 2);
  }
  return { tiff, iptc: undefined, xmp, warnings };
}

/** Finds the metadata blocks in a JPEG, PNG, WebP or bare TIFF file. */
export function find(file: Buffer, limits: Limits = {}): Found {
  const lim = { ...DEFAULTS, ...limits };
  if (file.length > lim.maxFileBytes) throw new ExifLimitError('the file is too large');
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) return fromJpeg(file, lim);
  if (file.length >= 8 && file.readUInt32BE(0) === 0x89504e47 && file.readUInt32BE(4) === 0x0d0a1a0a) return fromPng(file, lim);
  if (file.length >= 12 && file.toString('latin1', 0, 4) === 'RIFF' && file.toString('latin1', 8, 12) === 'WEBP') return fromWebp(file, lim);
  if (file.length >= 4 && (file.toString('latin1', 0, 2) === 'II' || file.toString('latin1', 0, 2) === 'MM')) return { tiff: file, iptc: undefined, xmp: undefined, warnings: [] };
  throw new ExifError('not a JPEG, PNG, WebP or TIFF file');
}

// --- IPTC -----------------------------------------------------------------------------------------------------

export interface Iptc {
  readonly title: string | undefined;
  readonly caption: string | undefined;
  readonly headline: string | undefined;
  readonly keywords: readonly string[];
  readonly creators: readonly string[];
  readonly credit: string | undefined;
  readonly source: string | undefined;
  readonly copyright: string | undefined;
  readonly city: string | undefined;
  readonly sublocation: string | undefined;
  readonly state: string | undefined;
  readonly country: string | undefined;
  readonly dateCreated: string | undefined;
  readonly warnings: readonly string[];
}

export function parseIptc(b: Buffer, o: { maxDatasets?: number } = {}): Iptc {
  const max = o.maxDatasets ?? 2000;
  const warnings: string[] = [];
  const sets: { rec: number; ds: number; data: Buffer }[] = [];
  let p = 0;
  while (p + 5 <= b.length) {
    if (b[p] !== 0x1c) {
      warnings.push('IPTC: a dataset does not start with 0x1C, stopped reading');
      break;
    }
    const rec = b[p + 1]!;
    const ds = b[p + 2]!;
    const len = b.readUInt16BE(p + 3);
    if (len & 0x8000) {
      warnings.push('IPTC: an extended-length dataset, stopped reading');
      break;
    }
    if (p + 5 + len > b.length) {
      warnings.push('IPTC: a dataset is longer than the block');
      break;
    }
    if (sets.length >= max) {
      warnings.push(`IPTC: more than ${max} datasets, stopped reading`);
      break;
    }
    sets.push({ rec, ds, data: b.subarray(p + 5, p + 5 + len) });
    p += 5 + len;
  }
  const utf8 = sets.some((s) => s.rec === 1 && s.ds === 90 && s.data.toString('latin1') === '\u001b%G');
  const text = (d: Buffer) => cleanText(d.toString(utf8 ? 'utf8' : 'latin1'), 2000);
  const one = (ds: number) => {
    const s = sets.find((x) => x.rec === 2 && x.ds === ds);
    return s ? text(s.data) || undefined : undefined;
  };
  const many = (ds: number) => sets.filter((x) => x.rec === 2 && x.ds === ds).map((x) => text(x.data)).filter(Boolean);
  const dc = one(55);
  return {
    title: one(5), caption: one(120), headline: one(105), keywords: many(25), creators: many(80), credit: one(110), source: one(115), copyright: one(116),
    city: one(90), sublocation: one(92), state: one(95), country: one(101),
    dateCreated: dc && /^\d{8}$/.test(dc) && !Number.isNaN(Date.parse(`${dc.slice(0, 4)}-${dc.slice(4, 6)}-${dc.slice(6, 8)}T00:00:00Z`)) ? `${dc.slice(0, 4)}-${dc.slice(4, 6)}-${dc.slice(6, 8)}` : undefined,
    warnings,
  };
}

// --- XMP ------------------------------------------------------------------------------------------------------

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
};

export interface Xmp {
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly creators: readonly string[];
  readonly keywords: readonly string[];
  readonly rights: string | undefined;
  /** 0 to 5; -1 (rejected) and anything else is absent. */
  readonly rating: number | undefined;
  readonly label: string | undefined;
  readonly createDate: string | undefined;
  readonly make: string | undefined;
  readonly model: string | undefined;
  readonly city: string | undefined;
  readonly country: string | undefined;
  readonly credit: string | undefined;
}

function listItems(e: El | undefined): string[] {
  if (!e) return [];
  const container = e.children.find((c) => c.ns === NS.rdf && ['Seq', 'Bag', 'Alt'].includes(c.name));
  return (container?.children ?? []).filter((c) => c.ns === NS.rdf && c.name === 'li').map((c) => cleanText(c.text)).filter(Boolean);
}

function altText(e: El | undefined): string | undefined {
  if (!e) return undefined;
  const container = e.children.find((c) => c.ns === NS.rdf && c.name === 'Alt');
  const lis = (container?.children ?? []).filter((c) => c.name === 'li');
  const pick = lis.find((l) => l.attrs['{http://www.w3.org/XML/1998/namespace}lang'] === 'x-default') ?? lis[0];
  return pick ? cleanText(pick.text) || undefined : e.text ? cleanText(e.text) || undefined : undefined;
}

export function parseXmp(text: string, limits: Limits = {}): Xmp {
  const lim = { ...DEFAULTS, ...limits };
  // the xpacket wrapper is a processing instruction with padding; the XML starts at the xmpmeta or RDF element
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new ExifError('the XMP is not acceptable XML: document type declarations are not accepted');
  const start = text.search(/<(?:x:)?xmpmeta|<rdf:RDF/);
  const endTag = text.lastIndexOf('</');
  if (start < 0 || endTag < 0) throw new ExifError('no XMP packet found');
  const close = text.indexOf('>', endTag);
  let doc: El;
  try {
    doc = parseXml(text.slice(start, close + 1), { maxBytes: lim.maxXmpBytes });
  } catch (e) {
    throw new ExifError(`the XMP is not acceptable XML: ${(e as Error).message}`);
  }
  const find = (e: El, ns: string, name: string): El | undefined => (e.ns === ns && e.name === name ? e : e.children.map((c) => find(c, ns, name)).find(Boolean));
  const rdf = find(doc, NS.rdf, 'RDF');
  const descs = (rdf?.children ?? []).filter((c) => c.ns === NS.rdf && c.name === 'Description');
  const prop = (ns: string, name: string): string | undefined => {
    for (const d of descs) {
      const a = d.attrs[`{${ns}}${name}`];
      if (a !== undefined) return cleanText(a) || undefined;
      const c = d.children.find((x) => x.ns === ns && x.name === name);
      if (c && c.children.length === 0 && c.text.trim()) return cleanText(c.text) || undefined;
    }
    return undefined;
  };
  const el = (ns: string, name: string) => descs.map((d) => d.children.find((x) => x.ns === ns && x.name === name)).find(Boolean);
  const ratingRaw = prop(NS.xmp, 'Rating');
  const rating = ratingRaw !== undefined && /^[0-5]$/.test(ratingRaw) ? Number(ratingRaw) : undefined;
  return {
    title: altText(el(NS.dc, 'title')), description: altText(el(NS.dc, 'description')), creators: listItems(el(NS.dc, 'creator')), keywords: listItems(el(NS.dc, 'subject')),
    rights: altText(el(NS.dc, 'rights')), rating, label: prop(NS.xmp, 'Label'), createDate: prop(NS.xmp, 'CreateDate') ?? prop(NS.exif, 'DateTimeOriginal'),
    make: prop(NS.tiff, 'Make'), model: prop(NS.tiff, 'Model'), city: prop(NS.photoshop, 'City'), country: prop(NS.photoshop, 'Country'), credit: prop(NS.photoshop, 'Credit'),
  };
}

// --- everything together --------------------------------------------------------------------------------------

export interface Metadata {
  readonly exif: Exif | undefined;
  readonly iptc: Iptc | undefined;
  readonly xmp: Xmp | undefined;
  readonly warnings: readonly string[];
}

export function read(file: Buffer, o: ReadOptions = {}): Metadata {
  const f = find(file, o);
  const warnings = [...f.warnings];
  let exif: Exif | undefined;
  let iptc: Iptc | undefined;
  let xmp: Xmp | undefined;
  if (f.tiff) {
    try {
      exif = exifOf(parseTiff(f.tiff, o), o.serials === undefined ? {} : { serials: o.serials });
      warnings.push(...exif.warnings);
    } catch (e) {
      if (e instanceof ExifLimitError) throw e;
      warnings.push(`EXIF: ${(e as Error).message}`);
    }
  }
  if (f.iptc) iptc = parseIptc(f.iptc);
  if (iptc) warnings.push(...iptc.warnings);
  if (f.xmp) {
    try {
      xmp = parseXmp(f.xmp, o);
    } catch (e) {
      warnings.push(`XMP: ${(e as Error).message}`);
    }
  }
  return { exif, iptc, xmp, warnings };
}

export interface Merged {
  readonly title: string | undefined;
  readonly caption: string | undefined;
  readonly keywords: readonly string[];
  readonly creators: readonly string[];
  readonly copyright: string | undefined;
  readonly credit: string | undefined;
  readonly rating: number | undefined;
  readonly camera: string | undefined;
  readonly lens: string | undefined;
  readonly takenAt: TakenAt | undefined;
  readonly gps: Gps | undefined;
  readonly place: { readonly city: string | undefined; readonly state: string | undefined; readonly country: string | undefined };
  /** Which source each editorial field came from. */
  readonly from: Readonly<Record<string, 'sidecar' | 'xmp' | 'iptc' | 'exif'>>;
}

const first = <T>(...xs: (readonly [T | undefined, 'sidecar' | 'xmp' | 'iptc' | 'exif'])[]): [T | undefined, 'sidecar' | 'xmp' | 'iptc' | 'exif' | undefined] => {
  for (const [v, s] of xs) if (v !== undefined && v !== '') return [v, s];
  return [undefined, undefined];
};

/**
 * Combines the sources. Editorial fields (title, caption, creators, copyright, credit, rating, place) go sidecar,
 * then embedded XMP, then IPTC, then EXIF; what the camera recorded (camera, lens, time, GPS) goes to EXIF first,
 * because a sidecar edited by hand should not rewrite the sensor's facts. Keywords from all sources are joined,
 * duplicates (ignoring case) dropped, first spelling kept.
 */
export function merge(m: Metadata, sidecar?: Xmp): Merged {
  const from: Record<string, 'sidecar' | 'xmp' | 'iptc' | 'exif'> = {};
  const pick = <T>(name: string, ...xs: (readonly [T | undefined, 'sidecar' | 'xmp' | 'iptc' | 'exif'])[]) => {
    const [v, s] = first(...xs);
    if (s) from[name] = s;
    return v;
  };
  const x = m.xmp;
  const i = m.iptc;
  const e = m.exif;
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const k of [...(sidecar?.keywords ?? []), ...(x?.keywords ?? []), ...(i?.keywords ?? [])]) if (!seen.has(k.toLowerCase())) (seen.add(k.toLowerCase()), keywords.push(k));
  const creators = (sidecar?.creators.length ? sidecar.creators : x?.creators.length ? x.creators : i?.creators.length ? i.creators : e?.artist ? [e.artist] : []) as string[];
  const xmpCam = (s: Xmp | undefined) => (s?.make || s?.model ? normaliseCamera(s.make, s.model) : undefined);
  return {
    title: pick('title', [sidecar?.title, 'sidecar'], [x?.title, 'xmp'], [i?.title, 'iptc'], [i?.headline, 'iptc']),
    caption: pick('caption', [sidecar?.description, 'sidecar'], [x?.description, 'xmp'], [i?.caption, 'iptc'], [e?.description, 'exif']),
    keywords, creators,
    copyright: pick('copyright', [sidecar?.rights, 'sidecar'], [x?.rights, 'xmp'], [i?.copyright, 'iptc'], [e?.copyright, 'exif']),
    credit: pick('credit', [sidecar?.credit, 'sidecar'], [x?.credit, 'xmp'], [i?.credit, 'iptc']),
    rating: pick('rating', [sidecar?.rating, 'sidecar'], [x?.rating, 'xmp']),
    camera: pick('camera', [e?.camera, 'exif'], [xmpCam(x), 'xmp'], [xmpCam(sidecar), 'sidecar']),
    lens: e?.lens,
    takenAt: e?.takenAt ?? (() => { const d = x?.createDate ?? sidecar?.createDate; const w = d?.replace(/-/g, ':').replace(/T/, ' ').slice(0, 19); return inferTakenAt(w, /([+-]\d{2}:\d{2})$/.exec(d ?? '')?.[1], undefined); })(),
    gps: e?.gps,
    place: {
      city: pick('city', [sidecar?.city, 'sidecar'], [x?.city, 'xmp'], [i?.city, 'iptc']),
      state: i?.state,
      country: pick('country', [sidecar?.country, 'sidecar'], [x?.country, 'xmp'], [i?.country, 'iptc']),
    },
    from,
  };
}

/** The same metadata without what says where the photo was taken: GPS, and the IPTC and XMP place names. */
export function withoutLocation(m: Metadata): Metadata {
  return {
    exif: m.exif ? { ...m.exif, gps: undefined } : undefined,
    iptc: m.iptc ? { ...m.iptc, city: undefined, sublocation: undefined, state: undefined, country: undefined } : undefined,
    xmp: m.xmp ? { ...m.xmp, city: undefined, country: undefined } : undefined,
    warnings: m.warnings,
  };
}
