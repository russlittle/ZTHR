/**
 * Reading and writing the tags inside audio files, from bytes, with the audio itself never touched.
 *
 *  - ID3v2.2, 2.3 and 2.4 (id3.org): syncsafe and plain sizes, unsynchronisation, extended headers and footers
 *    skipped, the four text encodings, multi-value text (NUL separated), COMM, USLT, TXXX, UFID, APIC and the old
 *    numeric genres; ID3v1 at the end of the file as a fallback. Writing keeps every frame it does not manage
 *    (PRIV, POPM, CHAP...), reuses the padding when the new tag fits so the audio does not move, and otherwise grows
 *    the tag with fresh padding. It writes 2.4 with UTF-8 unless the file already has 2.3, which stays 2.3 with UTF-16.
 *  - FLAC (xiph.org/flac/format.html): the metadata blocks, STREAMINFO for duration, VORBIS_COMMENT and PICTURE
 *    read; writing replaces those two kinds, keeps the others, and uses the padding block so the audio frames
 *    stay where they are when it fits.
 *  - MP4 and M4A (ISO 14496-12 and the iTunes `ilst` atoms): title, artist, album, album artist, composer, genre,
 *    date, track and disc pairs, tempo, lyrics, comment, cover art, and freeform `----` items such as ReplayGain
 *    and MusicBrainz ids. Items not understood are kept byte for byte. A changed `moov` size shifts the audio
 *    when `moov` comes first, so the `stco` and `co64` chunk offsets are corrected.
 *  - Vorbis comments (the standalone codec `parseVorbisComment` and `buildVorbisComment`, as used in FLAC, Ogg and
 *    Opus). Ogg and Opus files are not read or written here (the comment lives inside Ogg pages that need
 *    re-paging and checksums); only the comment codec is.
 *  - One field model for all of them (Vorbis-style names: TITLE, ARTIST, ALBUM, ALBUMARTIST, TRACKNUMBER,
 *    TRACKTOTAL, DISCNUMBER, DISCTOTAL, DATE, GENRE, COMPOSER, COMMENT, LYRICS, BPM, ISRC, REPLAYGAIN_*,
 *    MUSICBRAINZ_*) so a library reads every format the same way, `commonTags` for the typed view and
 *    `planWrite` to show what a write would do (in place or not, bytes before and after) before `applyWrite` does it.
 *  - ReplayGain values read and written in their usual text form, and the playback gain worked out from them with
 *    a pre-amp and clipping prevention. Cover art is checked: the bytes are sniffed (JPEG, PNG, GIF, WebP) for type
 *    and size, a claimed type that disagrees is refused, and the size is limited.
 *
 * Every length read from a file is checked against what remains; a frame, block or atom that claims more than is
 * there ends the parse rather than reading past it. Not here: Ogg/Opus/WMA/APE containers, MP3 audio frames (so no
 * duration for MP3), and ID3v1 writing.
 */

export class TagError extends Error {}
export class Unsupported extends TagError {}
export class Malformed extends TagError {}

export type Fields = Record<string, string[]>;

export interface Picture {
  /** ID3 picture type: 3 is the front cover, 4 the back cover, 0 other. */
  readonly type: number;
  readonly mime: string;
  readonly description: string;
  readonly data: Uint8Array;
}

export type Format = 'id3' | 'flac' | 'mp4' | 'ogg' | 'unknown';

export interface Audio {
  readonly durationSec?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly bitsPerSample?: number;
}

export interface ReadResult {
  readonly format: Format;
  readonly fields: Fields;
  readonly pictures: readonly Picture[];
  readonly audio: Audio;
  /** The tag version, such as "ID3v2.3". */
  readonly version?: string;
}

export interface TagEdit {
  /** Fields to set (replacing all values of that field). */
  readonly set?: Readonly<Record<string, string | readonly string[]>>;
  readonly remove?: readonly string[];
  readonly pictures?: { readonly replace?: readonly Picture[]; readonly add?: readonly Picture[]; readonly removeTypes?: readonly number[]; readonly removeAll?: boolean };
}

const MAX_TAG = 64 * 1024 * 1024;
const MAX_PICTURE = 16 * 1024 * 1024;

const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number) => ((b[o + 3]! << 24) | (b[o + 2]! << 16) | (b[o + 1]! << 8) | b[o]!) >>> 0;
const u24be = (b: Uint8Array, o: number) => (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
const be32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le32 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const buf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.length);
const latin1 = (u: Uint8Array) => buf(u).toString('latin1');

function need(b: Uint8Array, at: number, n: number, what: string): void {
  if (!Number.isInteger(at) || at < 0 || n < 0 || at + n > b.length) throw new Malformed(`${what} runs past the end of the data`);
}

// ---------------------------------------------------------------- ReplayGain and fields

/** "-6.54 dB", "+3.2dB", "−6.54" (a true minus) to a number of decibels. */
export function parseGain(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^\s*([+\-−]?\d+(?:\.\d+)?)\s*(?:dB)?\s*$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]!.replace('−', '-'));
  return Number.isFinite(n) && Math.abs(n) <= 100 ? n : undefined;
}

export const formatGain = (db: number): string => `${db.toFixed(2)} dB`;

export function parsePeak(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text.trim());
  return /^\d+(\.\d+)?$/.test(text.trim()) && Number.isFinite(n) && n >= 0 && n < 100 ? n : undefined;
}

export const formatPeak = (p: number): string => p.toFixed(6);

export interface GainOptions {
  readonly mode?: 'track' | 'album';
  /** Decibels added to the stored gain. */
  readonly preampDb?: number;
  /** Never amplify so far that the stored peak would clip. Default true. */
  readonly preventClipping?: boolean;
  /** Gain for files with no ReplayGain data, in decibels. Default 0. */
  readonly fallbackDb?: number;
}

/** The linear multiplier a player should apply, from the file's ReplayGain fields. */
export function playbackGain(fields: Fields, o: GainOptions = {}): { db: number; linear: number; clipped: boolean; source: 'track' | 'album' | 'none' } {
  const first = (k: string) => fields[k]?.[0];
  const album = { g: parseGain(first('REPLAYGAIN_ALBUM_GAIN')), p: parsePeak(first('REPLAYGAIN_ALBUM_PEAK')) };
  const track = { g: parseGain(first('REPLAYGAIN_TRACK_GAIN')), p: parsePeak(first('REPLAYGAIN_TRACK_PEAK')) };
  const order = (o.mode ?? 'track') === 'album' ? [['album', album], ['track', track]] as const : [['track', track], ['album', album]] as const;
  const pick = order.find(([, v]) => v.g !== undefined);
  const source = pick ? pick[0] : 'none';
  const gain = (pick ? pick[1].g! : o.fallbackDb ?? 0) + (o.preampDb ?? 0);
  let linear = 10 ** (gain / 20);
  let clipped = false;
  const peak = pick?.[1].p;
  if ((o.preventClipping ?? true) && peak !== undefined && peak > 0 && linear * peak > 1) {
    linear = 1 / peak;
    clipped = true;
  }
  return { db: Math.round(20 * Math.log10(linear) * 100) / 100, linear, clipped, source };
}

const pair = (s: string | undefined): { no?: number; of?: number } => {
  const m = /^\s*(\d+)?\s*(?:\/\s*(\d+))?\s*$/.exec(s ?? '');
  return m ? { ...(m[1] ? { no: Number(m[1]) } : {}), ...(m[2] ? { of: Number(m[2]) } : {}) } : {};
};

export interface CommonTags {
  readonly title?: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly albumArtist?: string;
  readonly composers: readonly string[];
  readonly genres: readonly string[];
  readonly track: { no?: number; of?: number };
  readonly disc: { no?: number; of?: number };
  /** As written: "2020", "2020-05", "2020-05-17". */
  readonly date?: string;
  readonly year?: number;
  readonly comment?: string;
  readonly lyrics?: string;
  readonly bpm?: number;
  readonly isrc?: string;
  readonly musicbrainz: Readonly<Record<string, string>>;
  readonly replayGain: { trackGain?: number; trackPeak?: number; albumGain?: number; albumPeak?: number };
}

/** The typed view of a field set. "3/12" in TRACKNUMBER and a separate TRACKTOTAL are both understood. */
export function commonTags(f: Fields): CommonTags {
  const one = (k: string) => f[k]?.[0];
  const track = pair(one('TRACKNUMBER'));
  const disc = pair(one('DISCNUMBER'));
  const tt = Number(one('TRACKTOTAL') ?? one('TOTALTRACKS'));
  const dt = Number(one('DISCTOTAL') ?? one('TOTALDISCS'));
  if (track.of === undefined && Number.isInteger(tt) && tt > 0) track.of = tt;
  if (disc.of === undefined && Number.isInteger(dt) && dt > 0) disc.of = dt;
  const date = one('DATE') ?? one('YEAR');
  const year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
  const bpm = Number(one('BPM'));
  const mb: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith('MUSICBRAINZ_') && v[0]) mb[k.slice(12).toLowerCase()] = v[0];
  const rg = { trackGain: parseGain(one('REPLAYGAIN_TRACK_GAIN')), trackPeak: parsePeak(one('REPLAYGAIN_TRACK_PEAK')), albumGain: parseGain(one('REPLAYGAIN_ALBUM_GAIN')), albumPeak: parsePeak(one('REPLAYGAIN_ALBUM_PEAK')) };
  const title = one('TITLE');
  const album = one('ALBUM');
  const albumArtist = one('ALBUMARTIST');
  const comment = one('COMMENT');
  const lyrics = one('LYRICS');
  const isrc = one('ISRC');
  return {
    ...(title !== undefined ? { title } : {}),
    artists: f.ARTIST ?? [],
    ...(album !== undefined ? { album } : {}),
    ...(albumArtist !== undefined ? { albumArtist } : {}),
    composers: f.COMPOSER ?? [],
    genres: f.GENRE ?? [],
    track,
    disc,
    ...(date !== undefined ? { date } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(lyrics !== undefined ? { lyrics } : {}),
    ...(Number.isFinite(bpm) && bpm > 0 ? { bpm } : {}),
    ...(isrc !== undefined ? { isrc } : {}),
    musicbrainz: mb,
    replayGain: Object.fromEntries(Object.entries(rg).filter(([, v]) => v !== undefined)) as CommonTags['replayGain'],
  };
}

const canon = (k: string): string => {
  if (!/^[\x20-\x3c\x3e-\x7d]{1,64}$/.test(k)) throw new TagError(`bad field name ${JSON.stringify(k.slice(0, 40))}`);
  return k.toUpperCase();
};

/** Apply an edit to a field set. Setting a field to nothing, or to empty strings, removes it. */
export function editFields(f: Fields, e: TagEdit): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(f)) out[k] = [...v];
  for (const k of e.remove ?? []) delete out[canon(k)];
  for (const [k0, v] of Object.entries(e.set ?? {})) {
    const k = canon(k0);
    const vals = (Array.isArray(v) ? [...v] : [v as string]).filter((x) => x !== '');
    for (const s of vals) if (/\u0000/.test(s)) throw new TagError(`${k} contains a NUL`);
    if (vals.length) out[k] = vals;
    else delete out[k];
  }
  return out;
}

// ---------------------------------------------------------------- pictures

export interface ImageInfo {
  readonly mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  readonly width: number;
  readonly height: number;
}

/** What an image is, from its bytes: type and pixel size. Undefined for anything else. */
export function sniffImage(d: Uint8Array): ImageInfo | undefined {
  const b = buf(d);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString('latin1', 12, 16) === 'IHDR') return { mime: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const k = b.toString('latin1', 12, 16);
    if (k === 'VP8X') return { mime: 'image/webp', width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (k === 'VP8 ' && b.length >= 30) return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (k === 'VP8L' && b.length >= 25) {
      const v = b.readUInt32LE(21);
      return { mime: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
    }
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1]!;
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return undefined;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 9 > b.length) return undefined;
        return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

/** A picture with its type and size checked. A claimed mime that disagrees with the bytes is refused. */
export function makePicture(data: Uint8Array, o: { type?: number; description?: string; mime?: string } = {}): Picture {
  if (data.length === 0 || data.length > MAX_PICTURE) throw new TagError(`a picture is 1 byte to ${MAX_PICTURE / 1024 / 1024} MiB`);
  const info = sniffImage(data);
  if (!info) throw new TagError('the bytes are not a JPEG, PNG, GIF or WebP image');
  if (info.width < 1 || info.height < 1) throw new TagError('the image has no size');
  if (o.mime !== undefined && o.mime !== info.mime) throw new TagError(`the picture says ${o.mime} but is ${info.mime}`);
  const type = o.type ?? 3;
  if (!Number.isInteger(type) || type < 0 || type > 20) throw new TagError('a picture type is 0 to 20');
  return { type, mime: info.mime, description: o.description ?? '', data };
}

function applyPictures(existing: readonly Picture[], e: TagEdit['pictures']): Picture[] {
  if (!e) return [...existing];
  let out = e.replace ? [...e.replace] : e.removeAll ? [] : [...existing];
  if (e.removeTypes) out = out.filter((p) => !e.removeTypes!.includes(p.type));
  for (const p of e.add ?? []) out.push(p);
  return out;
}

// ---------------------------------------------------------------- Vorbis comments

export function parseVorbisComment(b0: Uint8Array): { vendor: string; fields: Fields } {
  const b = buf(b0);
  need(b, 0, 4, 'the vendor length');
  const vl = u32le(b, 0);
  need(b, 4, vl, 'the vendor string');
  const vendor = b.toString('utf8', 4, 4 + vl);
  let o = 4 + vl;
  need(b, o, 4, 'the comment count');
  const n = u32le(b, o);
  o += 4;
  if (n > 100_000) throw new Malformed('too many comments');
  const fields: Fields = {};
  for (let i = 0; i < n; i++) {
    need(b, o, 4, 'a comment length');
    const l = u32le(b, o);
    o += 4;
    need(b, o, l, 'a comment');
    const s = b.toString('utf8', o, o + l);
    o += l;
    const eq = s.indexOf('=');
    if (eq < 1 || !/^[\x20-\x3c\x3e-\x7d]+$/.test(s.slice(0, eq))) continue;
    (fields[s.slice(0, eq).toUpperCase()] ??= []).push(s.slice(eq + 1));
  }
  return { vendor, fields };
}

export function buildVorbisComment(vendor: string, fields: Fields): Buffer {
  const parts: Buffer[] = [];
  const v = Buffer.from(vendor, 'utf8');
  const entries = Object.entries(fields).flatMap(([k, vals]) => vals.map((x) => Buffer.from(`${k}=${x}`, 'utf8')));
  parts.push(le32(v.length), v, le32(entries.length));
  for (const e of entries) parts.push(le32(e.length), e);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ID3

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];

/** Resolve "(17)", "(17)Rock", "17" and "(RX)" in an ID3 genre. */
export function id3Genre(raw: string): string[] {
  const out: string[] = [];
  let rest = raw;
  for (let m = /^\((\d{1,3}|RX|CR)\)/.exec(rest); m; m = /^\((\d{1,3}|RX|CR)\)/.exec(rest)) {
    rest = rest.slice(m[0].length);
    if (m[1] === 'RX') out.push('Remix');
    else if (m[1] === 'CR') out.push('Cover');
    else out.push(GENRES[Number(m[1])] ?? `(${m[1]})`);
  }
  if (rest) out.push(/^\d{1,3}$/.test(rest) && GENRES[Number(rest)] ? GENRES[Number(rest)]! : rest.replace(/^\(\(/, '('));
  return [...new Set(out)];
}

const syncsafe = (b: Uint8Array, o: number) => {
  if ((b[o]! | b[o + 1]! | b[o + 2]! | b[o + 3]!) & 0x80) throw new Malformed('a size that must be syncsafe has a high bit');
  return (b[o]! << 21) | (b[o + 1]! << 14) | (b[o + 2]! << 7) | b[o + 3]!;
};
const toSyncsafe = (n: number) => Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);

function unsync(b: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]!);
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return Buffer.from(out);
}

function decodeText(enc: number, b: Buffer): string {
  if (enc === 0) return b.toString('latin1');
  if (enc === 3) return b.toString('utf8');
  if (enc === 2) return Buffer.from(b).swap16().toString('utf16le');
  if (enc === 1) {
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
    return b.toString('utf16le');
  }
  throw new Malformed(`unknown text encoding ${enc}`);
}

/** Index of the terminator for this encoding and the width of it, or -1. */
function terminator(enc: number, b: Buffer, from = 0): [number, number] {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [i, 2];
    return [-1, 2];
  }
  const i = b.indexOf(0, from);
  return [i, 1];
}

function splitTerminated(enc: number, b: Buffer): [Buffer, Buffer] {
  const [i, w] = terminator(enc, b);
  return i < 0 ? [b, Buffer.alloc(0)] : [b.subarray(0, i), b.subarray(i + w)];
}

interface Frame {
  id: string;
  flags: number;
  data: Buffer;
  /** Compressed or encrypted: not readable here, so `data` is the stored bytes and is written back as they were. */
  opaque?: boolean;
}

interface Id3Parsed {
  version: 2 | 3 | 4;
  frames: Frame[];
  /** Bytes from the start of the file to the first audio byte (tag, padding, footer). */
  size: number;
  /** Bytes of the tag body (frames plus padding). */
  bodySize: number;
  framesSize: number;
}

function parseId3(b: Buffer): Id3Parsed | undefined {
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'ID3') return undefined;
  const v = b[3]!;
  if (v < 2 || v > 4 || b[4] === 0xff) throw new Unsupported(`ID3v2.${v} is not supported`);
  const flags = b[5]!;
  const body = syncsafe(b, 6);
  if (body > MAX_TAG) throw new Malformed('the tag is larger than 64 MiB');
  need(b, 10, body, 'the ID3 tag');
  const footer = v === 4 && flags & 0x10 ? 10 : 0;
  let data = b.subarray(10, 10 + body);
  if (flags & 0x80 && v < 4) data = unsync(Buffer.from(data));
  let o = 0;
  if (flags & 0x40) {
    if (v === 3) o = 4 + u32be(data, 0);
    else if (v === 4) o = syncsafe(data, 0);
    if (o > data.length) throw new Malformed('the extended header runs past the tag');
  }
  const idLen = v === 2 ? 3 : 4;
  const hLen = v === 2 ? 6 : 10;
  const frames: Frame[] = [];
  let used = o;
  while (o + hLen <= data.length) {
    if (data[o] === 0) break; // padding
    const id = data.toString('latin1', o, o + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = v === 2 ? u24be(data, o + 3) : v === 3 ? u32be(data, o + 4) : syncsafe(data, o + 4);
    const fl = v === 2 ? 0 : data.readUInt16BE(o + 8);
    o += hLen;
    if (o + size > data.length) break;
    let fd: Buffer = Buffer.from(data.subarray(o, o + size));
    o += size;
    used = o;
    if ((v === 3 && fl & 0x00c0) || (v === 4 && fl & 0x000c)) {
      frames.push({ id, flags: fl, data: fd, opaque: true });
      continue;
    }
    if (v === 4) {
      if (fl & 0x0002 || flags & 0x80) fd = unsync(fd);
      if (fl & 0x0001) fd = fd.subarray(4);
    }
    frames.push({ id, flags: fl, data: fd });
  }
  return { version: v as 2 | 3 | 4, frames, size: 10 + body + footer, bodySize: body, framesSize: used };
}

const V22_TO_V23: Record<string, string> = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER', TDA: 'TDAT', TCO: 'TCON', TCM: 'TCOM', COM: 'COMM', ULT: 'USLT', TXX: 'TXXX', PIC: 'APIC', TBP: 'TBPM', TRC: 'TSRC', UFI: 'UFID' };

const TEXT_FIELD: Record<string, string> = { TIT2: 'TITLE', TPE1: 'ARTIST', TALB: 'ALBUM', TPE2: 'ALBUMARTIST', TCOM: 'COMPOSER', TBPM: 'BPM', TSRC: 'ISRC', TCON: 'GENRE', TRCK: 'TRACKNUMBER', TPOS: 'DISCNUMBER' };
const FIELD_TEXT = Object.fromEntries(Object.entries(TEXT_FIELD).map(([k, v]) => [v, k])) as Record<string, string>;
const MB_UFID = 'http://musicbrainz.org';
/** Picard's names for MusicBrainz ids, which ID3 (TXXX) and MP4 (freeform) both use. */
const MB_NAMES: Readonly<Record<string, string>> = { MUSICBRAINZ_TRACKID: 'MusicBrainz Track Id', MUSICBRAINZ_ALBUMID: 'MusicBrainz Album Id', MUSICBRAINZ_ARTISTID: 'MusicBrainz Artist Id', MUSICBRAINZ_ALBUMARTISTID: 'MusicBrainz Album Artist Id', MUSICBRAINZ_RELEASEGROUPID: 'MusicBrainz Release Group Id', MUSICBRAINZ_RELEASETRACKID: 'MusicBrainz Release Track Id', MUSICBRAINZ_WORKID: 'MusicBrainz Work Id' };
const MB_READ: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(MB_NAMES).map(([k, v]) => [v.toUpperCase(), k]));

function textValues(enc: number, d: Buffer): string[] {
  const s = decodeText(enc, d);
  const parts = s.split('\u0000');
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function readId3(p: Id3Parsed): { fields: Fields; pictures: Picture[] } {
  const fields: Fields = {};
  const pictures: Picture[] = [];
  const put = (k: string, vals: string[]) => {
    if (vals.length) (fields[k] ??= []).push(...vals);
  };
  let tyer: string | undefined;
  let tdat: string | undefined;
  for (const f0 of p.frames) {
    const id = p.version === 2 ? V22_TO_V23[f0.id] ?? f0.id : f0.id;
    const d = f0.data;
    if (!d.length || f0.opaque) continue;
    if (id === 'APIC') {
      try {
        const enc = d[0]!;
        let rest: Buffer = d.subarray(1);
        let mime: string;
        if (p.version === 2) {
          const f = rest.toString('latin1', 0, 3).toUpperCase();
          mime = f === 'PNG' ? 'image/png' : f === 'JPG' ? 'image/jpeg' : f;
          rest = rest.subarray(3);
        } else {
          const z = rest.indexOf(0);
          if (z < 0) continue;
          mime = rest.toString('latin1', 0, z);
          rest = rest.subarray(z + 1);
        }
        const type = rest[0]!;
        const [desc, data] = splitTerminated(enc, rest.subarray(1));
        if (data.length) pictures.push({ type, mime: mime === 'image/jpg' ? 'image/jpeg' : mime, description: decodeText(enc, Buffer.from(desc)), data: Uint8Array.from(data) });
      } catch {
        // a damaged picture is skipped, the rest of the tag is still good
      }
      continue;
    }
    if (id === 'UFID') {
      const z = d.indexOf(0);
      if (z > 0 && d.toString('latin1', 0, z) === MB_UFID) put('MUSICBRAINZ_TRACKID', [d.toString('latin1', z + 1)]);
      continue;
    }
    if (id === 'TXXX') {
      const enc = d[0]!;
      const [desc, value] = splitTerminated(enc, d.subarray(1));
      const name = decodeText(enc, Buffer.from(desc));
      const key = MB_READ[name.toUpperCase()] ?? name.toUpperCase().replace(/ /g, '_');
      if (/^[A-Z0-9_]{1,64}$/.test(key)) put(key, textValues(enc, Buffer.from(value)).slice(0, 1));
      continue;
    }
    if (id === 'COMM' || id === 'USLT') {
      const enc = d[0]!;
      const [desc, text] = splitTerminated(enc, d.subarray(4));
      if (decodeText(enc, Buffer.from(desc)) === '' || id === 'USLT') put(id === 'COMM' ? 'COMMENT' : 'LYRICS', [decodeText(enc, Buffer.from(text))]);
      continue;
    }
    if (id === 'TYER') tyer = textValues(d[0]!, d.subarray(1))[0];
    else if (id === 'TDAT') tdat = textValues(d[0]!, d.subarray(1))[0];
    else if (id === 'TDRC' || (id === 'TDRL' && !fields.DATE)) put('DATE', textValues(d[0]!, d.subarray(1)).slice(0, 1));
    else if (TEXT_FIELD[id]) {
      let vals = textValues(d[0]!, d.subarray(1));
      if (id === 'TCON') vals = vals.flatMap(id3Genre);
      put(TEXT_FIELD[id]!, vals);
    }
  }
  if (!fields.DATE && tyer) fields.DATE = [tdat && /^\d{4}$/.test(tdat) && /^\d{4}$/.test(tyer) ? `${tyer}-${tdat.slice(2, 4)}-${tdat.slice(0, 2)}` : tyer];
  for (const [k, split] of [['TRACKNUMBER', 'TRACKTOTAL'], ['DISCNUMBER', 'DISCTOTAL']] as const) {
    const v = fields[k]?.[0];
    const m = v ? /^(\d+)\s*\/\s*(\d+)$/.exec(v) : null;
    if (m) {
      fields[k] = [m[1]!];
      fields[split] = [m[2]!];
    }
  }
  return { fields, pictures };
}

function readId3v1(b: Buffer): Fields | undefined {
  if (b.length < 128 || b.toString('latin1', b.length - 128, b.length - 125) !== 'TAG') return undefined;
  const t = b.subarray(b.length - 128);
  const s = (a: number, z: number) => t.toString('latin1', a, z).replace(/[\u0000 ]+$/, '');
  const f: Fields = {};
  const set = (k: string, v: string) => {
    if (v) f[k] = [v];
  };
  set('TITLE', s(3, 33));
  set('ARTIST', s(33, 63));
  set('ALBUM', s(63, 93));
  set('DATE', s(93, 97));
  if (t[125] === 0 && t[126] !== 0) set('TRACKNUMBER', String(t[126]));
  set('COMMENT', t[125] === 0 ? s(97, 125) : s(97, 127));
  if (t[127]! < GENRES.length) f.GENRE = [GENRES[t[127]!]!];
  return f;
}

// --- writing ID3

const latin1ok = (s: string) => [...s].every((c) => c.charCodeAt(0) < 256);

function encodeText(version: 3 | 4, vals: readonly string[]): Buffer {
  const text = vals.join('\u0000');
  if (latin1ok(text)) return Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
  if (version === 4) return Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
  return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/** One text string and its terminator, in the encoding chosen for the frame. */
function encodeTerminated(version: 3 | 4, text: string, enc: number): Buffer {
  if (enc === 0) return Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from([0])]);
  if (enc === 3) return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le'), Buffer.from([0, 0])]);
}

const encFor = (version: 3 | 4, ...texts: string[]) => (texts.every(latin1ok) ? 0 : version === 4 ? 3 : 1);

function frameBytes(version: 3 | 4, id: string, data: Buffer, flags = 0): Buffer {
  const size = version === 4 ? toSyncsafe(data.length) : be32(data.length);
  const fl = Buffer.alloc(2);
  fl.writeUInt16BE(flags);
  return Buffer.concat([Buffer.from(id, 'latin1'), size, fl, data]);
}

function id3Frames(version: 3 | 4, f: Fields, pics: readonly Picture[]): Frame[] {
  const out: Frame[] = [];
  const add = (id: string, data: Buffer) => out.push({ id, flags: 0, data });
  for (const [field, id] of Object.entries(FIELD_TEXT)) {
    if (field === 'TRACKNUMBER' || field === 'DISCNUMBER') continue;
    const v = f[field];
    if (v?.length) add(id, encodeText(version, v));
  }
  for (const [num, tot, id] of [['TRACKNUMBER', 'TRACKTOTAL', 'TRCK'], ['DISCNUMBER', 'DISCTOTAL', 'TPOS']] as const) {
    const n = f[num]?.[0];
    if (n) add(id, encodeText(version, [f[tot]?.[0] && !n.includes('/') ? `${n}/${f[tot]![0]}` : n]));
  }
  const date = f.DATE?.[0];
  if (date) {
    if (version === 4) add('TDRC', encodeText(4, [date]));
    else {
      const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(date);
      if (m) add('TYER', encodeText(3, [m[1]!]));
      if (m?.[2] && m[3]) add('TDAT', encodeText(3, [`${m[3]}${m[2]}`]));
    }
  }
  for (const [field, id] of [['COMMENT', 'COMM'], ['LYRICS', 'USLT']] as const) {
    const t = f[field]?.[0];
    if (t === undefined) continue;
    const enc = encFor(version, t);
    add(id, Buffer.concat([Buffer.from([enc]), Buffer.from('eng', 'latin1'), encodeTerminated(version, '', enc), enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]) : Buffer.from(t, enc === 3 ? 'utf8' : 'latin1')]));
  }
  for (const [k, v] of Object.entries(f)) {
    if (FIELD_TEXT[k] || ['TRACKTOTAL', 'DISCTOTAL', 'DATE', 'COMMENT', 'LYRICS', 'YEAR'].includes(k) || !v.length) continue;
    if (k === 'MUSICBRAINZ_TRACKID') {
      add('UFID', Buffer.concat([Buffer.from(MB_UFID, 'latin1'), Buffer.from([0]), Buffer.from(v[0]!, 'latin1')]));
      continue;
    }
    const desc = MB_NAMES[k] ?? k;
    const enc = encFor(version, desc, v[0]!);
    add('TXXX', Buffer.concat([Buffer.from([enc]), encodeTerminated(version, desc, enc), enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(v[0]!, 'utf16le')]) : Buffer.from(v[0]!, enc === 3 ? 'utf8' : 'latin1')]));
  }
  for (const p of pics) {
    const enc = encFor(version, p.description);
    add('APIC', Buffer.concat([Buffer.from([enc]), Buffer.from(p.mime, 'latin1'), Buffer.from([0, p.type]), encodeTerminated(version, p.description, enc), Buffer.from(p.data)]));
  }
  return out;
}

const MANAGED_ID3 = new Set(['TIT2', 'TPE1', 'TALB', 'TPE2', 'TCOM', 'TBPM', 'TSRC', 'TCON', 'TRCK', 'TPOS', 'TDRC', 'TYER', 'TDAT', 'TIME', 'COMM', 'USLT', 'TXXX', 'UFID', 'APIC']);

function writeId3(file: Buffer, e: TagEdit): Buffer {
  const p = parseId3(file);
  const version: 3 | 4 = p && p.version === 3 ? 3 : 4;
  const current = p ? readId3(p) : { fields: {} as Fields, pictures: [] as Picture[] };
  const fields = editFields(current.fields, e);
  const pics = applyPictures(current.pictures, e.pictures);
  // frames this block does not manage are carried over untouched (v2.2 frames have other ids and cannot be)
  const kept = (p?.frames ?? []).filter((f) => p!.version !== 2 && (f.opaque || !MANAGED_ID3.has(f.id)));
  const made = id3Frames(version, fields, pics).map((f) => frameBytes(version, f.id, f.data));
  const carried = kept.map((f) => frameBytes(version, f.id, f.data, f.opaque ? f.flags : f.flags & (version === 3 ? 0xe000 : 0x7000)));
  const body = Buffer.concat([...made, ...carried]);
  const audioStart = p ? p.size : 0;
  // when the new tag fits in the old one (footer included) the audio stays where it was
  const room = p ? p.size - 10 : 0;
  const total = body.length <= room ? room : body.length + 2048;
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, 0]), toSyncsafe(total)]);
  const tag = Buffer.concat([header, body, Buffer.alloc(total - body.length)]);
  return Buffer.concat([tag, file.subarray(audioStart)]);
}

// ---------------------------------------------------------------- FLAC

interface FlacBlock {
  readonly type: number;
  readonly data: Buffer;
}

function parseFlac(b: Buffer): { prefix: number; blocks: FlacBlock[]; metaEnd: number } {
  let start = 0;
  if (b.toString('latin1', 0, 3) === 'ID3') {
    const p = parseId3(b);
    start = p ? p.size : 0;
  }
  if (b.toString('latin1', start, start + 4) !== 'fLaC') throw new Malformed('not a FLAC stream');
  let o = start + 4;
  const blocks: FlacBlock[] = [];
  for (;;) {
    need(b, o, 4, 'a FLAC block header');
    const last = (b[o]! & 0x80) !== 0;
    const type = b[o]! & 0x7f;
    const len = u24be(b, o + 1);
    o += 4;
    need(b, o, len, 'a FLAC block');
    blocks.push({ type, data: b.subarray(o, o + len) });
    o += len;
    if (last) break;
    if (blocks.length > 1000) throw new Malformed('too many metadata blocks');
  }
  if (blocks[0]!.type !== 0 || blocks[0]!.data.length !== 34) throw new Malformed('a FLAC stream starts with a 34-byte STREAMINFO block');
  return { prefix: start, blocks, metaEnd: o };
}

function flacPicture(d: Buffer): Picture {
  need(d, 0, 8, 'a picture block');
  const type = u32be(d, 0);
  const ml = u32be(d, 4);
  need(d, 8, ml + 4, 'the picture mime');
  const mime = d.toString('latin1', 8, 8 + ml);
  const dl = u32be(d, 8 + ml);
  need(d, 12 + ml, dl + 20, 'the picture description');
  const description = d.toString('utf8', 12 + ml, 12 + ml + dl);
  const o = 12 + ml + dl + 16;
  const n = u32be(d, o);
  need(d, o + 4, n, 'the picture data');
  return { type, mime, description, data: Uint8Array.from(d.subarray(o + 4, o + 4 + n)) };
}

function flacPictureBlock(p: Picture): Buffer {
  const info = sniffImage(p.data);
  const mime = Buffer.from(p.mime, 'latin1');
  const desc = Buffer.from(p.description, 'utf8');
  return Buffer.concat([be32(p.type), be32(mime.length), mime, be32(desc.length), desc, be32(info?.width ?? 0), be32(info?.height ?? 0), be32(0), be32(0), be32(p.data.length), Buffer.from(p.data)]);
}

function readFlac(b: Buffer): ReadResult {
  const { blocks } = parseFlac(b);
  const si = blocks[0]!.data;
  const sampleRate = (si[10]! << 12) | (si[11]! << 4) | (si[12]! >> 4);
  const channels = ((si[12]! >> 1) & 7) + 1;
  const bps = (((si[12]! & 1) << 4) | (si[13]! >> 4)) + 1;
  const total = (si[13]! & 15) * 2 ** 32 + u32be(si, 14);
  let fields: Fields = {};
  const pictures: Picture[] = [];
  for (const bl of blocks) {
    if (bl.type === 4) fields = parseVorbisComment(bl.data).fields;
    else if (bl.type === 6) {
      try {
        pictures.push(flacPicture(bl.data));
      } catch {
        // a damaged picture block is skipped
      }
    }
  }
  return { format: 'flac', fields: normaliseVorbis(fields), pictures, audio: { sampleRate, channels, bitsPerSample: bps, ...(sampleRate > 0 && total > 0 ? { durationSec: total / sampleRate } : {}) }, version: 'FLAC' };
}

/** Vorbis alternatives onto the shared names (YEAR, TOTALTRACKS and so on). */
function normaliseVorbis(f: Fields): Fields {
  const out: Fields = { ...f };
  if (!out.DATE && out.YEAR) out.DATE = out.YEAR;
  delete out.YEAR;
  if (!out.TRACKTOTAL && out.TOTALTRACKS) out.TRACKTOTAL = out.TOTALTRACKS;
  if (!out.DISCTOTAL && out.TOTALDISCS) out.DISCTOTAL = out.TOTALDISCS;
  delete out.TOTALTRACKS;
  delete out.TOTALDISCS;
  const tn = out.TRACKNUMBER?.[0]?.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (tn) {
    out.TRACKNUMBER = [tn[1]!];
    out.TRACKTOTAL ??= [tn[2]!];
  }
  const dn = out.DISCNUMBER?.[0]?.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (dn) {
    out.DISCNUMBER = [dn[1]!];
    out.DISCTOTAL ??= [dn[2]!];
  }
  return out;
}

function writeFlac(b: Buffer, e: TagEdit): Buffer {
  const { prefix, blocks, metaEnd } = parseFlac(b);
  const cur = readFlac(b);
  const vendor = (() => {
    const vc = blocks.find((x) => x.type === 4);
    try {
      return vc ? parseVorbisComment(vc.data).vendor : 'audio-tags';
    } catch {
      return 'audio-tags';
    }
  })();
  const fields = editFields(cur.fields, e);
  const pics = applyPictures(cur.pictures, e.pictures);
  const keep = blocks.filter((x) => x.type !== 4 && x.type !== 6 && x.type !== 1);
  const made: FlacBlock[] = [{ type: 4, data: buildVorbisComment(vendor, fields) }, ...pics.map((p) => ({ type: 6, data: flacPictureBlock(p) }))];
  const regionStart = prefix + 4;
  const region = metaEnd - regionStart;
  const head = [keep[0]!, ...made, ...keep.slice(1)];
  const size = (list: FlacBlock[]) => list.reduce((a, x) => a + 4 + x.data.length, 0);
  let padding = region - size(head) - 4;
  if (padding < 0) {
    padding = 8192;
  }
  const list = [...head, { type: 1, data: Buffer.alloc(padding) }];
  if (list.some((x) => x.data.length > 0xffffff)) throw new TagError('a metadata block over 16 MiB cannot be written');
  const out = Buffer.concat(list.map((x, i) => Buffer.concat([Buffer.from([(i === list.length - 1 ? 0x80 : 0) | x.type, (x.data.length >>> 16) & 255, (x.data.length >>> 8) & 255, x.data.length & 255]), x.data])));
  return Buffer.concat([b.subarray(0, regionStart), out, b.subarray(metaEnd)]);
}

// ---------------------------------------------------------------- MP4

interface Atom {
  readonly type: string;
  readonly start: number;
  readonly headerSize: number;
  readonly end: number;
}

function atoms(b: Buffer, from: number, to: number): Atom[] {
  const out: Atom[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32be(b, o);
    const type = b.toString('latin1', o + 4, o + 8);
    let hs = 8;
    if (size === 1) {
      need(b, o + 8, 8, 'a 64-bit atom size');
      const hi = u32be(b, o + 8);
      if (hi > 0x1fffff) throw new Malformed('an atom claims more than 2^53 bytes');
      size = hi * 2 ** 32 + u32be(b, o + 12);
      hs = 16;
    } else if (size === 0) size = to - o;
    if (size < hs || o + size > to) throw new Malformed(`the ${JSON.stringify(type)} atom runs past its container`);
    out.push({ type, start: o, headerSize: hs, end: o + size });
    o += size;
  }
  return out;
}

const kids = (b: Buffer, a: Atom, skip = 0) => atoms(b, a.start + a.headerSize + skip, a.end);
const find = (list: Atom[], t: string) => list.find((x) => x.type === t);
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([be32(8 + body.length), Buffer.from(type, 'latin1'), body]);
};

interface Mp4Path {
  moov: Atom;
  udta?: Atom;
  meta?: Atom;
  ilst?: Atom;
}

function mp4Path(b: Buffer): Mp4Path {
  const top = atoms(b, 0, b.length);
  if (!find(top, 'ftyp')) throw new Malformed('not an MP4 file: no ftyp');
  const moov = find(top, 'moov');
  if (!moov) throw new Malformed('no moov atom');
  const udta = find(kids(b, moov), 'udta');
  const meta = udta ? find(kids(b, udta), 'meta') : undefined;
  const ilst = meta ? find(kids(b, meta, 4), 'ilst') : undefined;
  return { moov, ...(udta ? { udta } : {}), ...(meta ? { meta } : {}), ...(ilst ? { ilst } : {}) };
}

interface Item {
  readonly name: string;
  readonly raw: Buffer;
  readonly values: { type: number; data: Buffer }[];
  readonly mean?: string;
  readonly key?: string;
}

function mp4Items(b: Buffer, ilst: Atom): Item[] {
  const items: Item[] = [];
  for (const it of kids(b, ilst)) {
    const raw = b.subarray(it.start, it.end);
    const values: { type: number; data: Buffer }[] = [];
    let mean: string | undefined;
    let key: string | undefined;
    for (const c of kids(b, it)) {
      const body = b.subarray(c.start + c.headerSize, c.end);
      if (c.type === 'data' && body.length >= 8) values.push({ type: u32be(body, 0) & 0xffffff, data: Buffer.from(body.subarray(8)) });
      else if (c.type === 'mean' && body.length >= 4) mean = body.toString('utf8', 4);
      else if (c.type === 'name' && body.length >= 4) key = body.toString('utf8', 4);
    }
    items.push({ name: it.type, raw: Buffer.from(raw), values, ...(mean !== undefined ? { mean } : {}), ...(key !== undefined ? { key } : {}) });
  }
  return items;
}

const MP4_TEXT: Record<string, string> = { '©nam': 'TITLE', '©ART': 'ARTIST', '©alb': 'ALBUM', aART: 'ALBUMARTIST', '©wrt': 'COMPOSER', '©gen': 'GENRE', '©day': 'DATE', '©cmt': 'COMMENT', '©lyr': 'LYRICS' };
const TEXT_MP4 = Object.fromEntries(Object.entries(MP4_TEXT).map(([k, v]) => [v, k])) as Record<string, string>;
const MP4_MANAGED = new Set([...Object.keys(MP4_TEXT), 'trkn', 'disk', 'tmpo', 'covr', 'gnre']);

function readMp4(b: Buffer): ReadResult {
  const path = mp4Path(b);
  let audio: Audio = {};
  const mvhd = find(kids(b, path.moov), 'mvhd');
  if (mvhd) {
    const body = b.subarray(mvhd.start + mvhd.headerSize, mvhd.end);
    const v = body[0];
    if (v === 0 && body.length >= 20) {
      const ts = u32be(body, 12);
      if (ts > 0) audio = { durationSec: u32be(body, 16) / ts };
    } else if (v === 1 && body.length >= 32) {
      const ts = u32be(body, 20);
      if (ts > 0) audio = { durationSec: (u32be(body, 24) * 2 ** 32 + u32be(body, 28)) / ts };
    }
  }
  const fields: Fields = {};
  const pictures: Picture[] = [];
  if (path.ilst) {
    for (const it of mp4Items(b, path.ilst)) {
      const put = (k: string, v: string[]) => {
        if (v.length) (fields[k] ??= []).push(...v);
      };
      if (MP4_TEXT[it.name]) put(MP4_TEXT[it.name]!, it.values.filter((v) => v.type === 1).map((v) => v.data.toString('utf8')));
      else if (it.name === 'gnre') {
        const g = it.values[0]?.data;
        if (g && g.length >= 2 && GENRES[g.readUInt16BE(0) - 1]) put('GENRE', [GENRES[g.readUInt16BE(0) - 1]!]);
      } else if (it.name === 'trkn' || it.name === 'disk') {
        const d = it.values[0]?.data;
        if (d && d.length >= 6) {
          const no = d.readUInt16BE(2);
          const of = d.readUInt16BE(4);
          const [nk, tk] = it.name === 'trkn' ? ['TRACKNUMBER', 'TRACKTOTAL'] : ['DISCNUMBER', 'DISCTOTAL'];
          if (no) put(nk!, [String(no)]);
          if (of) put(tk!, [String(of)]);
        }
      } else if (it.name === 'tmpo') {
        const d = it.values[0]?.data;
        if (d && d.length >= 2 && d.readUInt16BE(0) > 0) put('BPM', [String(d.readUInt16BE(0))]);
      } else if (it.name === 'covr') {
        for (const v of it.values) {
          const mime = v.type === 14 ? 'image/png' : v.type === 13 ? 'image/jpeg' : v.type === 12 ? 'image/gif' : undefined;
          if (mime && v.data.length) pictures.push({ type: 3, mime, description: '', data: Uint8Array.from(v.data) });
        }
      } else if (it.name === '----' && it.mean === ITUNES && it.key && it.values[0]?.type === 1) {
        const k = it.key.toUpperCase();
        put(MB_READ[k] ?? k.replace(/ /g, '_'), [it.values[0].data.toString('utf8')]);
      }
    }
  }
  return { format: 'mp4', fields, pictures, audio, version: 'MP4' };
}

const ITUNES = 'com.apple.iTunes';
const dataAtom = (type: number, payload: Buffer) => box('data', be32(type), be32(0), payload);

function mp4Item(name: string, ...data: Buffer[]) {
  return box(name, ...data);
}

function buildMp4Items(f: Fields, pics: readonly Picture[]): Buffer[] {
  const out: Buffer[] = [];
  for (const [field, atom] of Object.entries(TEXT_MP4)) {
    const v = f[field];
    if (v?.length) out.push(mp4Item(atom, ...v.map((s) => dataAtom(1, Buffer.from(s, 'utf8')))));
  }
  for (const [num, tot, atom, extra] of [['TRACKNUMBER', 'TRACKTOTAL', 'trkn', 2], ['DISCNUMBER', 'DISCTOTAL', 'disk', 0]] as const) {
    const n = Number(f[num]?.[0] ?? 0);
    const t = Number(f[tot]?.[0] ?? 0);
    if (n > 0 || t > 0) {
      const p = Buffer.alloc(6 + extra);
      p.writeUInt16BE(Math.min(n, 65535), 2);
      p.writeUInt16BE(Math.min(t, 65535), 4);
      out.push(mp4Item(atom, dataAtom(0, p)));
    }
  }
  const bpm = Number(f.BPM?.[0] ?? 0);
  if (bpm > 0) out.push(mp4Item('tmpo', dataAtom(21, Buffer.from([(bpm >> 8) & 255, bpm & 255]))));
  if (pics.length) out.push(mp4Item('covr', ...pics.map((p) => dataAtom(p.mime === 'image/png' ? 14 : p.mime === 'image/gif' ? 12 : 13, Buffer.from(p.data)))));
  for (const [k, v] of Object.entries(f)) {
    if (TEXT_MP4[k] || ['TRACKNUMBER', 'TRACKTOTAL', 'DISCNUMBER', 'DISCTOTAL', 'BPM', 'YEAR'].includes(k) || !v.length) continue;
    const key = MB_NAMES[k] ?? k;
    out.push(box('----', box('mean', be32(0), Buffer.from(ITUNES, 'utf8')), box('name', be32(0), Buffer.from(key, 'utf8')), dataAtom(1, Buffer.from(v[0]!, 'utf8'))));
  }
  return out;
}

/** Add `delta` to every chunk offset at or beyond `boundary`. */
function patchChunkOffsets(moov: Buffer, delta: number, boundary: number): void {
  const walk = (from: number, to: number, depth: number) => {
    if (depth > 16) throw new Malformed('atoms nested too deeply');
    for (const a of atoms(moov, from, to)) {
      const body = a.start + a.headerSize;
      if (a.type === 'stco' || a.type === 'co64') {
        const n = u32be(moov, body + 4);
        const w = a.type === 'stco' ? 4 : 8;
        if (body + 8 + n * w > a.end) throw new Malformed('a chunk offset table runs past its atom');
        for (let i = 0; i < n; i++) {
          const at = body + 8 + i * w;
          if (w === 4) {
            const v = u32be(moov, at);
            if (v >= boundary) moov.writeUInt32BE(v + delta, at);
          } else {
            const v = u32be(moov, at) * 2 ** 32 + u32be(moov, at + 4);
            if (v >= boundary) {
              const nv = v + delta;
              moov.writeUInt32BE(Math.floor(nv / 2 ** 32), at);
              moov.writeUInt32BE(nv % 2 ** 32, at + 4);
            }
          }
        }
      } else if (['trak', 'mdia', 'minf', 'stbl', 'edts'].includes(a.type)) walk(body, a.end, depth + 1);
    }
  };
  walk(8, moov.length, 0);
}

function writeMp4(b: Buffer, e: TagEdit): Buffer {
  const path = mp4Path(b);
  const cur = readMp4(b);
  const fields = editFields(cur.fields, e);
  const pics = applyPictures(cur.pictures, e.pictures);
  // everything the field model covers is rebuilt; items it does not cover (and freeform items that are not iTunes
  // text) are carried over byte for byte
  const kept = path.ilst ? mp4Items(b, path.ilst).filter((it) => !MP4_MANAGED.has(it.name) && !(it.name === '----' && it.mean === ITUNES && it.values.every((v) => v.type === 1))).map((it) => it.raw) : [];
  const ilst = box('ilst', ...buildMp4Items(fields, pics), ...kept);
  const hdlr = box('hdlr', be32(0), be32(0), Buffer.from('mdir', 'latin1'), Buffer.from('appl', 'latin1'), be32(0), be32(0), Buffer.from([0]));
  const oldMeta = path.meta;
  const metaKids = oldMeta ? kids(b, oldMeta, 4).filter((x) => x.type !== 'ilst' && x.type !== 'free').map((x) => b.subarray(x.start, x.end)) : [hdlr];
  const meta = box('meta', be32(0), ...metaKids, ilst);
  const rebuild = (a: Atom, replace: Map<number, Buffer>): Buffer => {
    const inner = kids(b, a).map((c) => replace.get(c.start) ?? b.subarray(c.start, c.end));
    return box(a.type, ...inner);
  };
  const moovKids = kids(b, path.moov);
  let newMoov: Buffer;
  if (path.udta) {
    const udtaKids = kids(b, path.udta);
    const udtaNew = oldMeta ? rebuild(path.udta, new Map([[oldMeta.start, meta]])) : box('udta', ...udtaKids.map((c) => b.subarray(c.start, c.end)), meta);
    newMoov = rebuild(path.moov, new Map([[path.udta.start, udtaNew]]));
  } else {
    newMoov = box('moov', ...moovKids.map((c) => b.subarray(c.start, c.end)), box('udta', meta));
  }
  const delta = newMoov.length - (path.moov.end - path.moov.start);
  const mdatAfter = atoms(b, 0, b.length).some((a) => a.type === 'mdat' && a.start >= path.moov.end);
  if (delta !== 0 && mdatAfter) patchChunkOffsets(newMoov, delta, path.moov.end);
  return Buffer.concat([b.subarray(0, path.moov.start), newMoov, b.subarray(path.moov.end)]);
}

// ---------------------------------------------------------------- the front door

export function detect(b0: Uint8Array): Format {
  const b = buf(b0);
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'ID3') {
    // an ID3 tag may sit in front of FLAC
    try {
      const p = parseId3(b);
      if (p && b.toString('latin1', p.size, p.size + 4) === 'fLaC') return 'flac';
    } catch {
      return 'id3';
    }
    return 'id3';
  }
  if (b.length >= 128 && b.toString('latin1', b.length - 128, b.length - 125) === 'TAG') return 'id3';
  if (b.length >= 4 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'id3'; // MPEG audio frame sync: an MP3 with no tag yet
  return 'unknown';
}

export function readTags(b0: Uint8Array): ReadResult {
  const b = buf(b0);
  const fmt = detect(b);
  if (fmt === 'flac') return readFlac(b);
  if (fmt === 'mp4') return readMp4(b);
  if (fmt === 'ogg') throw new Unsupported('Ogg and Opus files are not read here; use parseVorbisComment on the comment packet');
  if (fmt === 'id3') {
    const p = parseId3(b);
    const v1 = readId3v1(b);
    if (p) {
      const r = readId3(p);
      const fields = { ...(v1 ?? {}), ...r.fields };
      return { format: 'id3', fields, pictures: r.pictures, audio: {}, version: `ID3v2.${p.version}` };
    }
    return { format: 'id3', fields: v1 ?? {}, pictures: [], audio: {}, ...(v1 ? { version: 'ID3v1' } : {}) };
  }
  throw new Unsupported('not an ID3-tagged, FLAC or MP4 file');
}

/** The new file after the edit. The input is not changed. */
export function applyWrite(b0: Uint8Array, e: TagEdit): Buffer {
  const b = buf(b0);
  const fmt = detect(b);
  if (e.pictures) for (const p of [...(e.pictures.replace ?? []), ...(e.pictures.add ?? [])]) makePicture(p.data, { type: p.type, mime: p.mime, description: p.description });
  if (fmt === 'flac') return writeFlac(b, e);
  if (fmt === 'mp4') return writeMp4(b, e);
  if (fmt === 'id3') {
    const p = parseId3(b);
    if (p && p.version === 2) throw new Unsupported('ID3v2.2 tags are read, not written; the file would be upgraded to 2.4 by removing the old tag first');
    return writeId3(b, e);
  }
  if (fmt === 'ogg') throw new Unsupported('Ogg and Opus files cannot be written here');
  throw new Unsupported('not an ID3-tagged, FLAC or MP4 file');
}

export interface WritePlan {
  readonly format: Format;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  /** The audio does not move: the file is the same length and only the tag region differs. */
  readonly inPlace: boolean;
  readonly fieldsChanged: readonly string[];
  readonly picturesBefore: number;
  readonly picturesAfter: number;
  readonly warnings: readonly string[];
}

/** What a write would do, without doing it to anything but a copy in memory. */
export function planWrite(b0: Uint8Array, e: TagEdit): WritePlan {
  const b = buf(b0);
  const before = readTags(b);
  const out = applyWrite(b, e);
  const after = readTags(out);
  const keys = new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]);
  const changed = [...keys].filter((k) => JSON.stringify(before.fields[k]) !== JSON.stringify(after.fields[k])).sort();
  const warnings: string[] = [];
  for (const k of Object.keys(e.set ?? {})) {
    const key = canon(k);
    if (!changed.includes(key) && JSON.stringify(before.fields[key]) !== JSON.stringify(after.fields[key])) warnings.push(`${key} was not stored as given`);
    if (before.format === 'id3' && after.fields[key] === undefined && (e.set![k] as string) !== '' && !(Array.isArray(e.set![k]) && (e.set![k] as string[]).length === 0)) warnings.push(`${key} was not kept by this format`);
  }
  return { format: before.format, bytesBefore: b.length, bytesAfter: out.length, inPlace: out.length === b.length, fieldsChanged: changed, picturesBefore: before.pictures.length, picturesAfter: after.pictures.length, warnings };
}
