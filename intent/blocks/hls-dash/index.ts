/**
 * Adaptive streaming manifests. HLS (RFC 8216): write and parse media playlists (EXTINF, TARGETDURATION, MEDIA-SEQUENCE,
 * DISCONTINUITY-SEQUENCE, PLAYLIST-TYPE, BYTERANGE, DISCONTINUITY, KEY, MAP, PROGRAM-DATE-TIME, GAP, ENDLIST) and master
 * playlists (STREAM-INF with bandwidth, resolution, codecs, frame rate and audio group; MEDIA renditions), with the
 * protocol version worked out from what is used and the checks the RFC requires (every EXTINF, rounded, fits the target
 * duration; a variant's audio group exists). DASH (ISO/IEC 23009-1): write and parse an MPD with periods, adaptation sets,
 * representations and SegmentTemplate (by duration or by SegmentTimeline), ISO 8601 durations, the `$Number$`,
 * `$Time$`, `$RepresentationID$`, `$Bandwidth$` identifiers with `%0Nd` widths, and the expansion of a timeline (with
 * `r` repeats) into numbered segments.
 *
 * Live windows: `LivePlaylist` keeps the newest segments, advances MEDIA-SEQUENCE as old ones leave, advances
 * DISCONTINUITY-SEQUENCE when a leaving segment carried a discontinuity, and writes the hold-back of three target
 * durations; `dashLiveEdge` says which segment number is the newest complete one at a given time and which are still
 * inside the time-shift buffer. ABR ladders: `buildLadder` chooses renditions for a source (no upscaling, even
 * dimensions, aspect kept, bitrate scaled by codec) with RFC 6381 codec strings, and writes the master playlist for it.
 *
 * Safety: input size and line counts are capped; an MPD is read with the dav block's reader, which refuses DTDs and
 * entities; URIs with control characters are refused.
 *
 * Out of scope: encryption (KEY is carried, not applied), low-latency HLS (partial segments, blocking reload), DASH
 * content protection and event streams, and producing the media segments themselves.
 */
import { escapeXml, parseXml } from '../dav/index.ts';
import type { El } from '../dav/index.ts';

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const MAX_BYTES = 5_000_000;
const MAX_LINES = 200_000;
const badUri = (u: string) => /[\u0000-\u001f\u007f\s]/.test(u) || u === '';

// ================================================================================================ HLS

export interface ByteRange { readonly length: number; readonly offset?: number }
export interface Key { readonly method: 'NONE' | 'AES-128' | 'SAMPLE-AES'; readonly uri?: string; readonly iv?: string; readonly keyFormat?: string }
export interface MapInfo { readonly uri: string; readonly byteRange?: ByteRange }

export interface Segment {
  readonly uri: string;
  /** Seconds. */
  readonly duration: number;
  readonly title?: string;
  readonly byteRange?: ByteRange;
  readonly discontinuity?: boolean;
  readonly programDateTime?: string;
  readonly key?: Key;
  readonly map?: MapInfo;
  readonly gap?: boolean;
}

export interface MediaPlaylist {
  readonly kind: 'media';
  readonly version?: number;
  readonly targetDuration: number;
  readonly mediaSequence: number;
  readonly discontinuitySequence?: number;
  readonly playlistType?: 'VOD' | 'EVENT';
  readonly independentSegments?: boolean;
  readonly endList: boolean;
  readonly segments: readonly Segment[];
}

export interface Variant {
  readonly uri: string;
  readonly bandwidth: number;
  readonly averageBandwidth?: number;
  readonly resolution?: { readonly width: number; readonly height: number };
  readonly codecs?: string;
  readonly frameRate?: number;
  readonly audio?: string;
  readonly subtitles?: string;
}
export interface Rendition {
  readonly type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
  readonly groupId: string;
  readonly name: string;
  readonly uri?: string;
  readonly language?: string;
  readonly default?: boolean;
  readonly autoselect?: boolean;
  readonly channels?: string;
}
export interface MasterPlaylist {
  readonly kind: 'master';
  readonly version?: number;
  readonly independentSegments?: boolean;
  readonly variants: readonly Variant[];
  readonly renditions: readonly Rendition[];
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6))));

function attrList(attrs: readonly (readonly [string, string | number | boolean | undefined])[]): string {
  return attrs
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'YES' : 'NO') : v}`)
    .join(',');
}
const q = (s: string) => {
  if (/["\r\n]/.test(s)) throw new ManifestError(`a quoted attribute cannot contain a quote or a line break: ${JSON.stringify(s.slice(0, 30))}`);
  return `"${s}"`;
};

function keyLine(k: Key): string {
  return `#EXT-X-KEY:${attrList([['METHOD', k.method], ['URI', k.uri === undefined ? undefined : q(k.uri)], ['IV', k.iv], ['KEYFORMAT', k.keyFormat === undefined ? undefined : q(k.keyFormat)]])}`;
}
const rangeText = (r: ByteRange) => `${r.length}${r.offset === undefined ? '' : `@${r.offset}`}`;

/** The lowest protocol version that allows what the playlist uses (RFC 8216 section 7). */
export function requiredVersion(p: MediaPlaylist): number {
  let v = 1;
  for (const s of p.segments) {
    if (!Number.isInteger(s.duration)) v = Math.max(v, 3);
    if (s.byteRange) v = Math.max(v, 4);
    if (s.map) v = Math.max(v, 6); // a media initialization section needs version 6 (5 only for I-frame-only playlists)
    if (s.key?.iv !== undefined) v = Math.max(v, 2);
    if (s.key?.keyFormat !== undefined) v = Math.max(v, 5);
  }
  return v;
}

export function validateMedia(p: MediaPlaylist): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(p.targetDuration) || p.targetDuration < 1) problems.push('TARGETDURATION must be a whole number of seconds, at least 1');
  if (!Number.isInteger(p.mediaSequence) || p.mediaSequence < 0) problems.push('MEDIA-SEQUENCE must be a whole number, zero or more');
  p.segments.forEach((s, i) => {
    if (!(s.duration > 0) || !Number.isFinite(s.duration)) problems.push(`segment ${i}: duration must be above zero`);
    else if (Math.round(s.duration) > p.targetDuration) problems.push(`segment ${i}: duration ${num(s.duration)} rounds above TARGETDURATION ${p.targetDuration}`);
    if (badUri(s.uri)) problems.push(`segment ${i}: the URI is empty or has spaces or control characters`);
  });
  if (p.playlistType === 'VOD' && !p.endList) problems.push('a VOD playlist must end with ENDLIST');
  if (p.endList && p.playlistType === 'EVENT') { /* allowed once the event is over */ }
  return problems;
}

export function writeMediaPlaylist(p: MediaPlaylist): string {
  const problems = validateMedia(p);
  if (problems.length) throw new ManifestError(`media playlist is not valid: ${problems.join('; ')}`);
  const out = ['#EXTM3U', `#EXT-X-VERSION:${Math.max(p.version ?? 1, requiredVersion(p))}`, `#EXT-X-TARGETDURATION:${p.targetDuration}`];
  if (p.playlistType) out.push(`#EXT-X-PLAYLIST-TYPE:${p.playlistType}`);
  out.push(`#EXT-X-MEDIA-SEQUENCE:${p.mediaSequence}`);
  if (p.discontinuitySequence) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${p.discontinuitySequence}`);
  if (p.independentSegments) out.push('#EXT-X-INDEPENDENT-SEGMENTS');
  let key: string | undefined;
  let map: string | undefined;
  for (const s of p.segments) {
    if (s.discontinuity) out.push('#EXT-X-DISCONTINUITY');
    if (s.key) {
      const line = keyLine(s.key);
      if (line !== key) { out.push(line); key = line; }
    }
    if (s.map) {
      const line = `#EXT-X-MAP:${attrList([['URI', q(s.map.uri)], ['BYTERANGE', s.map.byteRange ? q(rangeText(s.map.byteRange)) : undefined]])}`;
      if (line !== map) { out.push(line); map = line; }
    }
    if (s.programDateTime) out.push(`#EXT-X-PROGRAM-DATE-TIME:${s.programDateTime}`);
    if (s.gap) out.push('#EXT-X-GAP');
    if (s.byteRange) out.push(`#EXT-X-BYTERANGE:${rangeText(s.byteRange)}`);
    out.push(`#EXTINF:${num(s.duration)},${s.title ?? ''}`, s.uri);
  }
  if (p.endList) out.push('#EXT-X-ENDLIST');
  return `${out.join('\n')}\n`;
}

/** Read an attribute list: NAME=value pairs, values quoted (may hold commas) or bare. */
export function parseAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const eq = text.indexOf('=', i);
    if (eq < 0) throw new ManifestError(`attribute list "${text.slice(0, 40)}" has no "="`);
    const name = text.slice(i, eq).trim();
    if (!/^[A-Z0-9-]+$/.test(name)) throw new ManifestError(`"${name.slice(0, 20)}" is not an attribute name`);
    i = eq + 1;
    let value: string;
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new ManifestError('unterminated quoted string in an attribute list');
      value = text.slice(i, end + 1);
      i = end + 1;
    } else {
      const end = text.indexOf(',', i);
      value = text.slice(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    }
    if (text[i] === ',') i++;
    out[name] = value;
  }
  return out;
}
const unq = (s: string | undefined) => (s !== undefined && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
const parseRange = (s: string): { length: number; offset?: number } => {
  const m = /^(\d+)(?:@(\d+))?$/.exec(s);
  if (!m) throw new ManifestError(`"${s.slice(0, 30)}" is not a byte range`);
  return { length: Number(m[1]), ...(m[2] !== undefined ? { offset: Number(m[2]) } : {}) };
};

function lines(text: string): string[] {
  if (text.length > MAX_BYTES) throw new ManifestError('playlist is too large');
  const l = text.replace(/^﻿/, '').split(/\r?\n/);
  if (l.length > MAX_LINES) throw new ManifestError('playlist has too many lines');
  if (l[0]?.trim() !== '#EXTM3U') throw new ManifestError('a playlist must start with #EXTM3U');
  return l.map((x) => x.trim()).filter((x) => x !== '');
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const ls = lines(text);
  let version: number | undefined;
  let target: number | undefined;
  let seq = 0;
  let dseq = 0;
  let type: 'VOD' | 'EVENT' | undefined;
  let independent = false;
  let end = false;
  const segs: Segment[] = [];
  let pending: { duration?: number; title?: string; byteRange?: ByteRange; discontinuity?: boolean; pdt?: string; gap?: boolean } = {};
  let key: Key | undefined;
  let map: MapInfo | undefined;
  const lastEnd = new Map<string, number>();
  for (const line of ls.slice(1)) {
    if (line.startsWith('#EXT')) {
      const colon = line.indexOf(':');
      const tag = colon < 0 ? line : line.slice(0, colon);
      const val = colon < 0 ? '' : line.slice(colon + 1);
      switch (tag) {
        case '#EXT-X-VERSION': version = Number(val); if (!Number.isInteger(version) || version < 1) throw new ManifestError('bad EXT-X-VERSION'); break;
        case '#EXT-X-TARGETDURATION': target = Number(val); if (!Number.isInteger(target) || target < 1) throw new ManifestError('EXT-X-TARGETDURATION must be a whole number of seconds'); break;
        case '#EXT-X-MEDIA-SEQUENCE': seq = Number(val); if (!Number.isInteger(seq) || seq < 0) throw new ManifestError('bad EXT-X-MEDIA-SEQUENCE'); break;
        case '#EXT-X-DISCONTINUITY-SEQUENCE': dseq = Number(val); if (!Number.isInteger(dseq) || dseq < 0) throw new ManifestError('bad EXT-X-DISCONTINUITY-SEQUENCE'); break;
        case '#EXT-X-PLAYLIST-TYPE': if (val !== 'VOD' && val !== 'EVENT') throw new ManifestError(`unknown playlist type "${val}"`); type = val; break;
        case '#EXT-X-INDEPENDENT-SEGMENTS': independent = true; break;
        case '#EXT-X-ENDLIST': end = true; break;
        case '#EXT-X-DISCONTINUITY': pending.discontinuity = true; break;
        case '#EXT-X-GAP': pending.gap = true; break;
        case '#EXT-X-PROGRAM-DATE-TIME': if (Number.isNaN(Date.parse(val))) throw new ManifestError(`bad PROGRAM-DATE-TIME "${val}"`); pending.pdt = val; break;
        case '#EXT-X-BYTERANGE': pending.byteRange = parseRange(val); break;
        case '#EXT-X-KEY': {
          const a = parseAttributes(val);
          const m = a['METHOD'];
          if (m !== 'NONE' && m !== 'AES-128' && m !== 'SAMPLE-AES') throw new ManifestError(`unknown key METHOD "${String(m)}"`);
          key = m === 'NONE' ? { method: 'NONE' } : { method: m, ...(a['URI'] ? { uri: unq(a['URI']) as string } : {}), ...(a['IV'] ? { iv: a['IV'] } : {}), ...(a['KEYFORMAT'] ? { keyFormat: unq(a['KEYFORMAT']) as string } : {}) };
          break;
        }
        case '#EXT-X-MAP': {
          const a = parseAttributes(val);
          if (!a['URI']) throw new ManifestError('EXT-X-MAP needs a URI');
          map = { uri: unq(a['URI']) as string, ...(a['BYTERANGE'] ? { byteRange: parseRange(unq(a['BYTERANGE']) as string) } : {}) };
          break;
        }
        case '#EXTINF': {
          const m = /^(\d+(?:\.\d+)?)(?:,(.*))?$/.exec(val);
          if (!m) throw new ManifestError(`bad EXTINF "${val.slice(0, 30)}"`);
          pending.duration = Number(m[1]);
          if (m[2]) pending.title = m[2];
          break;
        }
        default: break; // unknown tags are ignored, as the RFC requires
      }
      continue;
    }
    if (line.startsWith('#')) continue; // comment
    if (pending.duration === undefined) throw new ManifestError(`URI "${line.slice(0, 40)}" has no EXTINF before it`);
    if (badUri(line)) throw new ManifestError('a segment URI has spaces or control characters');
    let br = pending.byteRange;
    if (br && br.offset === undefined) {
      const prev = lastEnd.get(line);
      if (prev === undefined) throw new ManifestError(`byte range of ${line} has no offset and no earlier range of the same resource`);
      br = { length: br.length, offset: prev };
    }
    if (br) lastEnd.set(line, (br.offset as number) + br.length);
    segs.push({
      uri: line, duration: pending.duration,
      ...(pending.title ? { title: pending.title } : {}),
      ...(br ? { byteRange: br } : {}),
      ...(pending.discontinuity ? { discontinuity: true } : {}),
      ...(pending.pdt ? { programDateTime: pending.pdt } : {}),
      ...(pending.gap ? { gap: true } : {}),
      ...(key && key.method !== 'NONE' ? { key } : {}),
      ...(map ? { map } : {}),
    });
    pending = {};
  }
  if (target === undefined) throw new ManifestError('EXT-X-TARGETDURATION is required');
  const p: MediaPlaylist = {
    kind: 'media', ...(version !== undefined ? { version } : {}), targetDuration: target, mediaSequence: seq,
    ...(dseq ? { discontinuitySequence: dseq } : {}), ...(type ? { playlistType: type } : {}), ...(independent ? { independentSegments: true } : {}),
    endList: end, segments: segs,
  };
  return p;
}

export function writeMasterPlaylist(m: MasterPlaylist): string {
  const groups = new Set(m.renditions.map((r) => `${r.type}:${r.groupId}`));
  for (const v of m.variants) {
    if (!(v.bandwidth > 0) || !Number.isInteger(v.bandwidth)) throw new ManifestError('a variant needs a whole BANDWIDTH above zero');
    if (badUri(v.uri)) throw new ManifestError('a variant URI is empty or has spaces');
    if (v.audio !== undefined && !groups.has(`AUDIO:${v.audio}`)) throw new ManifestError(`variant ${v.uri} names audio group "${v.audio}" which has no EXT-X-MEDIA`);
    if (v.subtitles !== undefined && !groups.has(`SUBTITLES:${v.subtitles}`)) throw new ManifestError(`variant ${v.uri} names subtitles group "${v.subtitles}" which has no EXT-X-MEDIA`);
  }
  const out = ['#EXTM3U', `#EXT-X-VERSION:${m.version ?? 4}`];
  if (m.independentSegments) out.push('#EXT-X-INDEPENDENT-SEGMENTS');
  for (const r of m.renditions) {
    out.push(`#EXT-X-MEDIA:${attrList([
      ['TYPE', r.type], ['GROUP-ID', q(r.groupId)], ['NAME', q(r.name)], ['LANGUAGE', r.language === undefined ? undefined : q(r.language)],
      ['DEFAULT', r.default], ['AUTOSELECT', r.autoselect], ['CHANNELS', r.channels === undefined ? undefined : q(r.channels)], ['URI', r.uri === undefined ? undefined : q(r.uri)],
    ])}`);
  }
  for (const v of m.variants) {
    out.push(`#EXT-X-STREAM-INF:${attrList([
      ['BANDWIDTH', v.bandwidth], ['AVERAGE-BANDWIDTH', v.averageBandwidth], ['RESOLUTION', v.resolution ? `${v.resolution.width}x${v.resolution.height}` : undefined],
      ['FRAME-RATE', v.frameRate === undefined ? undefined : v.frameRate.toFixed(3)], ['CODECS', v.codecs === undefined ? undefined : q(v.codecs)],
      ['AUDIO', v.audio === undefined ? undefined : q(v.audio)], ['SUBTITLES', v.subtitles === undefined ? undefined : q(v.subtitles)],
    ])}`, v.uri);
  }
  return `${out.join('\n')}\n`;
}

export function parseMasterPlaylist(text: string): MasterPlaylist {
  const ls = lines(text);
  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  let version: number | undefined;
  let independent = false;
  let pendingInf: Record<string, string> | undefined;
  for (const line of ls.slice(1)) {
    if (line.startsWith('#EXT-X-VERSION:')) version = Number(line.slice(15));
    else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') independent = true;
    else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      const t = a['TYPE'];
      if (t !== 'AUDIO' && t !== 'VIDEO' && t !== 'SUBTITLES' && t !== 'CLOSED-CAPTIONS') throw new ManifestError(`unknown EXT-X-MEDIA TYPE "${String(t)}"`);
      if (!a['GROUP-ID'] || !a['NAME']) throw new ManifestError('EXT-X-MEDIA needs GROUP-ID and NAME');
      renditions.push({
        type: t, groupId: unq(a['GROUP-ID']) as string, name: unq(a['NAME']) as string,
        ...(a['URI'] ? { uri: unq(a['URI']) as string } : {}), ...(a['LANGUAGE'] ? { language: unq(a['LANGUAGE']) as string } : {}),
        ...(a['DEFAULT'] ? { default: a['DEFAULT'] === 'YES' } : {}), ...(a['AUTOSELECT'] ? { autoselect: a['AUTOSELECT'] === 'YES' } : {}),
        ...(a['CHANNELS'] ? { channels: unq(a['CHANNELS']) as string } : {}),
      });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) pendingInf = parseAttributes(line.slice(18));
    else if (line.startsWith('#')) continue;
    else {
      if (!pendingInf) throw new ManifestError(`URI "${line.slice(0, 40)}" has no EXT-X-STREAM-INF before it`);
      const a = pendingInf;
      const bw = Number(a['BANDWIDTH']);
      if (!Number.isInteger(bw) || bw <= 0) throw new ManifestError('EXT-X-STREAM-INF needs a BANDWIDTH');
      const res = a['RESOLUTION'] ? /^(\d+)x(\d+)$/.exec(a['RESOLUTION']) : null;
      if (a['RESOLUTION'] && !res) throw new ManifestError(`bad RESOLUTION "${a['RESOLUTION']}"`);
      variants.push({
        uri: line, bandwidth: bw,
        ...(a['AVERAGE-BANDWIDTH'] ? { averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) } : {}),
        ...(res ? { resolution: { width: Number(res[1]), height: Number(res[2]) } } : {}),
        ...(a['CODECS'] ? { codecs: unq(a['CODECS']) as string } : {}),
        ...(a['FRAME-RATE'] ? { frameRate: Number(a['FRAME-RATE']) } : {}),
        ...(a['AUDIO'] ? { audio: unq(a['AUDIO']) as string } : {}),
        ...(a['SUBTITLES'] ? { subtitles: unq(a['SUBTITLES']) as string } : {}),
      });
      pendingInf = undefined;
    }
  }
  return { kind: 'master', ...(version !== undefined ? { version } : {}), ...(independent ? { independentSegments: true } : {}), variants, renditions };
}

/** Read either kind of playlist. A master has STREAM-INF; a media playlist has EXTINF. */
export function parsePlaylist(text: string): MediaPlaylist | MasterPlaylist {
  return /^#EXT-X-STREAM-INF:/m.test(text) ? parseMasterPlaylist(text) : parseMediaPlaylist(text);
}

// ------------------------------------------------------------------------------------------------ live window

export interface LiveOptions {
  /** Segments kept in the playlist. */
  readonly windowSegments: number;
  readonly targetDuration: number;
  readonly independentSegments?: boolean;
}

/** A sliding HLS playlist: push segments as they are made, and write the window. */
export class LivePlaylist {
  private readonly o: LiveOptions;
  private segs: Segment[] = [];
  private seq = 0;
  private dseq = 0;
  private ended = false;

  constructor(options: LiveOptions) {
    if (!Number.isInteger(options.windowSegments) || options.windowSegments < 1) throw new ManifestError('windowSegments must be a whole number, at least 1');
    if (!Number.isInteger(options.targetDuration) || options.targetDuration < 1) throw new ManifestError('targetDuration must be a whole number, at least 1');
    this.o = options;
  }

  push(s: Segment): void {
    if (this.ended) throw new ManifestError('the stream has ended; no more segments can be added');
    if (Math.round(s.duration) > this.o.targetDuration) throw new ManifestError(`segment duration ${num(s.duration)} rounds above the target duration ${this.o.targetDuration}`);
    this.segs.push(s);
    while (this.segs.length > this.o.windowSegments) {
      const gone = this.segs.shift() as Segment;
      this.seq++;
      // the discontinuity tag sits on the segment after the break: when the segment holding it leaves, the count moves
      if (gone.discontinuity) this.dseq++;
    }
  }

  end(): void {
    this.ended = true;
  }

  get mediaSequence(): number {
    return this.seq;
  }
  get discontinuitySequence(): number {
    return this.dseq;
  }
  /** Seconds a player should stay behind the live edge (three target durations). */
  get holdBackSeconds(): number {
    return this.o.targetDuration * 3;
  }

  playlist(): MediaPlaylist {
    return {
      kind: 'media', targetDuration: this.o.targetDuration, mediaSequence: this.seq,
      ...(this.dseq ? { discontinuitySequence: this.dseq } : {}), ...(this.o.independentSegments ? { independentSegments: true } : {}),
      endList: this.ended, segments: [...this.segs],
    };
  }

  /** Which media sequence numbers a client may still ask for. */
  range(): { first: number; last: number } | undefined {
    return this.segs.length === 0 ? undefined : { first: this.seq, last: this.seq + this.segs.length - 1 };
  }
}

// ================================================================================================ naming

export interface NameParts {
  readonly number?: number;
  readonly time?: number;
  readonly representationId?: string;
  readonly bandwidth?: number;
}

/** Fill a DASH template: $Number$, $Number%05d$, $Time$, $RepresentationID$, $Bandwidth$, and $$ for a dollar sign. */
export function fillTemplate(template: string, p: NameParts): string {
  return template.replace(/\$(RepresentationID|Number|Bandwidth|Time)?(?:%0(\d{1,2})d)?\$/g, (_m, id: string | undefined, width: string | undefined) => {
    if (id === undefined) {
      if (width !== undefined) throw new ManifestError('"$%05d$" has no identifier');
      return '$';
    }
    if (id === 'RepresentationID') {
      if (width !== undefined) throw new ManifestError('RepresentationID takes no format');
      if (p.representationId === undefined) throw new ManifestError('the template needs a RepresentationID');
      return p.representationId;
    }
    const v = id === 'Number' ? p.number : id === 'Time' ? p.time : p.bandwidth;
    if (v === undefined) throw new ManifestError(`the template needs ${id}`);
    const s = String(v);
    return width === undefined ? s : s.padStart(Number(width), '0');
  });
}

/** `seg-00001.m4s` style names for HLS. */
export function segmentName(prefix: string, index: number, ext = 'm4s', pad = 5): string {
  if (!Number.isInteger(index) || index < 0) throw new ManifestError('segment index must be a whole number, zero or more');
  return `${prefix}${String(index).padStart(pad, '0')}.${ext}`;
}

// ================================================================================================ DASH

/** ISO 8601 duration (PnDTnHnMnS) to seconds. Years and months are refused: they have no fixed length. */
export function parseIsoDuration(text: string): number {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  if (!m || text === 'P' || text.endsWith('T')) throw new ManifestError(`"${text.slice(0, 30)}" is not a duration with days, hours, minutes and seconds`);
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}
export function formatIsoDuration(seconds: number): string {
  if (!(seconds >= 0) || !Number.isFinite(seconds)) throw new ManifestError('a duration must be zero or more');
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Number((seconds - h * 3600 - m * 60).toFixed(3));
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}

export interface TimelineEntry { readonly t?: number; readonly d: number; readonly r?: number }
export interface SegmentTemplate {
  readonly timescale?: number;
  /** Fixed segment length in timescale units (when there is no timeline). */
  readonly duration?: number;
  readonly startNumber?: number;
  readonly presentationTimeOffset?: number;
  readonly initialization?: string;
  readonly media: string;
  readonly timeline?: readonly TimelineEntry[];
}
export interface RepresentationDef {
  readonly id: string;
  readonly bandwidth: number;
  readonly codecs?: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: string;
  readonly audioSamplingRate?: number;
  readonly segmentTemplate?: SegmentTemplate;
}
export interface AdaptationSetDef {
  readonly id?: number;
  readonly contentType?: 'video' | 'audio' | 'text';
  readonly mimeType?: string;
  readonly lang?: string;
  readonly segmentAlignment?: boolean;
  readonly segmentTemplate?: SegmentTemplate;
  readonly representations: readonly RepresentationDef[];
}
export interface PeriodDef {
  readonly id?: string;
  /** Seconds from the start of the presentation. */
  readonly start?: number;
  readonly duration?: number;
  readonly adaptationSets: readonly AdaptationSetDef[];
}
export interface Mpd {
  readonly type: 'static' | 'dynamic';
  readonly profiles?: string;
  readonly minBufferTime: number;
  readonly mediaPresentationDuration?: number;
  readonly availabilityStartTime?: string;
  readonly publishTime?: string;
  readonly minimumUpdatePeriod?: number;
  readonly timeShiftBufferDepth?: number;
  readonly suggestedPresentationDelay?: number;
  readonly periods: readonly PeriodDef[];
}

const NS_MPD = 'urn:mpeg:dash:schema:mpd:2011';
export const PROFILE_LIVE = 'urn:mpeg:dash:profile:isoff-live:2011';

export function validateMpd(m: Mpd): string[] {
  const p: string[] = [];
  if (m.periods.length === 0) p.push('an MPD needs at least one period');
  if (m.type === 'static' && m.mediaPresentationDuration === undefined && m.periods.some((x) => x.duration === undefined)) p.push('a static MPD needs mediaPresentationDuration or a duration on every period');
  if (m.type === 'dynamic' && m.availabilityStartTime === undefined) p.push('a dynamic MPD needs availabilityStartTime');
  if (m.availabilityStartTime !== undefined && Number.isNaN(Date.parse(m.availabilityStartTime))) p.push('availabilityStartTime is not a date');
  const ids = new Set<string>();
  for (const per of m.periods) {
    for (const as of per.adaptationSets) {
      if (as.representations.length === 0) p.push('an adaptation set needs at least one representation');
      for (const r of as.representations) {
        if (ids.has(`${per.id ?? ''}/${as.id ?? ''}/${r.id}`)) p.push(`representation id "${r.id}" is used twice in one adaptation set`);
        ids.add(`${per.id ?? ''}/${as.id ?? ''}/${r.id}`);
        if (!/^[^\s"<>&]+$/.test(r.id)) p.push(`representation id "${r.id}" has characters not allowed in a template`);
        if (!(r.bandwidth > 0)) p.push(`representation ${r.id}: bandwidth must be above zero`);
        const st = r.segmentTemplate ?? as.segmentTemplate;
        if (st && st.timeline === undefined && !(st.duration && st.duration > 0)) p.push(`representation ${r.id}: a SegmentTemplate needs a duration or a SegmentTimeline`);
        if (st && !(st.timescale === undefined || st.timescale > 0)) p.push(`representation ${r.id}: timescale must be above zero`);
      }
    }
  }
  return p;
}

const a = (k: string, v: string | number | boolean | undefined) => (v === undefined ? '' : ` ${k}="${escapeXml(String(v))}"`);

function templateXml(t: SegmentTemplate, pad: string): string {
  const open = `${pad}<SegmentTemplate${a('timescale', t.timescale)}${a('duration', t.timeline ? undefined : t.duration)}${a('startNumber', t.startNumber)}${a('presentationTimeOffset', t.presentationTimeOffset)}${a('initialization', t.initialization)}${a('media', t.media)}`;
  if (!t.timeline) return `${open}/>\n`;
  return `${open}>\n${pad}  <SegmentTimeline>\n${t.timeline.map((s) => `${pad}    <S${a('t', s.t)}${a('d', s.d)}${a('r', s.r)}/>\n`).join('')}${pad}  </SegmentTimeline>\n${pad}</SegmentTemplate>\n`;
}

export function writeMpd(m: Mpd): string {
  const problems = validateMpd(m);
  if (problems.length) throw new ManifestError(`MPD is not valid: ${problems.join('; ')}`);
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="${NS_MPD}"${a('type', m.type)}${a('profiles', m.profiles ?? PROFILE_LIVE)}${a('minBufferTime', formatIsoDuration(m.minBufferTime))}`;
  x += a('mediaPresentationDuration', m.mediaPresentationDuration === undefined ? undefined : formatIsoDuration(m.mediaPresentationDuration));
  x += a('availabilityStartTime', m.availabilityStartTime) + a('publishTime', m.publishTime);
  x += a('minimumUpdatePeriod', m.minimumUpdatePeriod === undefined ? undefined : formatIsoDuration(m.minimumUpdatePeriod));
  x += a('timeShiftBufferDepth', m.timeShiftBufferDepth === undefined ? undefined : formatIsoDuration(m.timeShiftBufferDepth));
  x += a('suggestedPresentationDelay', m.suggestedPresentationDelay === undefined ? undefined : formatIsoDuration(m.suggestedPresentationDelay));
  x += '>\n';
  for (const per of m.periods) {
    x += `  <Period${a('id', per.id)}${a('start', per.start === undefined ? undefined : formatIsoDuration(per.start))}${a('duration', per.duration === undefined ? undefined : formatIsoDuration(per.duration))}>\n`;
    for (const as of per.adaptationSets) {
      x += `    <AdaptationSet${a('id', as.id)}${a('contentType', as.contentType)}${a('mimeType', as.mimeType)}${a('lang', as.lang)}${a('segmentAlignment', as.segmentAlignment)}>\n`;
      if (as.segmentTemplate) x += templateXml(as.segmentTemplate, '      ');
      for (const r of as.representations) {
        x += `      <Representation${a('id', r.id)}${a('mimeType', r.mimeType)}${a('codecs', r.codecs)}${a('bandwidth', r.bandwidth)}${a('width', r.width)}${a('height', r.height)}${a('frameRate', r.frameRate)}${a('audioSamplingRate', r.audioSamplingRate)}`;
        x += r.segmentTemplate ? `>\n${templateXml(r.segmentTemplate, '        ')}      </Representation>\n` : '/>\n';
      }
      x += '    </AdaptationSet>\n';
    }
    x += '  </Period>\n';
  }
  return `${x}</MPD>\n`;
}

const kids = (e: El, name: string) => e.children.filter((c) => c.ns === NS_MPD && c.name === name);
const optNum = (v: string | undefined, what: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ManifestError(`${what} "${v.slice(0, 20)}" is not a number`);
  return n;
};
const optDur = (v: string | undefined) => (v === undefined ? undefined : parseIsoDuration(v));

function readTemplate(e: El | undefined): SegmentTemplate | undefined {
  if (!e) return undefined;
  const tl = kids(e, 'SegmentTimeline')[0];
  const media = e.attrs['media'];
  if (!media) throw new ManifestError('SegmentTemplate needs a media attribute');
  const t: SegmentTemplate = {
    media,
    ...(e.attrs['timescale'] !== undefined ? { timescale: optNum(e.attrs['timescale'], 'timescale') as number } : {}),
    ...(e.attrs['duration'] !== undefined ? { duration: optNum(e.attrs['duration'], 'duration') as number } : {}),
    ...(e.attrs['startNumber'] !== undefined ? { startNumber: optNum(e.attrs['startNumber'], 'startNumber') as number } : {}),
    ...(e.attrs['presentationTimeOffset'] !== undefined ? { presentationTimeOffset: optNum(e.attrs['presentationTimeOffset'], 'presentationTimeOffset') as number } : {}),
    ...(e.attrs['initialization'] !== undefined ? { initialization: e.attrs['initialization'] } : {}),
    ...(tl ? { timeline: kids(tl, 'S').map((s) => ({ ...(s.attrs['t'] !== undefined ? { t: Number(s.attrs['t']) } : {}), d: Number(s.attrs['d']), ...(s.attrs['r'] !== undefined ? { r: Number(s.attrs['r']) } : {}) })) } : {}),
  };
  if (t.timeline?.some((s) => !Number.isFinite(s.d) || s.d <= 0 || (s.r !== undefined && !Number.isInteger(s.r)) || (s.t !== undefined && !Number.isFinite(s.t)))) throw new ManifestError('a SegmentTimeline S element has a bad d, r or t');
  return t;
}

export function parseMpd(xml: string): Mpd {
  const root = parseXml(xml, { maxBytes: MAX_BYTES, maxDepth: 32 });
  if (root.ns !== NS_MPD || root.name !== 'MPD') throw new ManifestError('the root element must be MPD in the urn:mpeg:dash:schema:mpd:2011 namespace');
  const type = root.attrs['type'] ?? 'static';
  if (type !== 'static' && type !== 'dynamic') throw new ManifestError(`MPD type "${type}" must be static or dynamic`);
  const mbt = optDur(root.attrs['minBufferTime']);
  if (mbt === undefined) throw new ManifestError('MPD needs minBufferTime');
  const mpd: Mpd = {
    type, minBufferTime: mbt,
    ...(root.attrs['profiles'] ? { profiles: root.attrs['profiles'] } : {}),
    ...(root.attrs['mediaPresentationDuration'] ? { mediaPresentationDuration: optDur(root.attrs['mediaPresentationDuration']) as number } : {}),
    ...(root.attrs['availabilityStartTime'] ? { availabilityStartTime: root.attrs['availabilityStartTime'] } : {}),
    ...(root.attrs['publishTime'] ? { publishTime: root.attrs['publishTime'] } : {}),
    ...(root.attrs['minimumUpdatePeriod'] ? { minimumUpdatePeriod: optDur(root.attrs['minimumUpdatePeriod']) as number } : {}),
    ...(root.attrs['timeShiftBufferDepth'] ? { timeShiftBufferDepth: optDur(root.attrs['timeShiftBufferDepth']) as number } : {}),
    ...(root.attrs['suggestedPresentationDelay'] ? { suggestedPresentationDelay: optDur(root.attrs['suggestedPresentationDelay']) as number } : {}),
    periods: kids(root, 'Period').map((p): PeriodDef => ({
      ...(p.attrs['id'] ? { id: p.attrs['id'] } : {}),
      ...(p.attrs['start'] ? { start: optDur(p.attrs['start']) as number } : {}),
      ...(p.attrs['duration'] ? { duration: optDur(p.attrs['duration']) as number } : {}),
      adaptationSets: kids(p, 'AdaptationSet').map((s): AdaptationSetDef => {
        const st = readTemplate(kids(s, 'SegmentTemplate')[0]);
        return {
          ...(s.attrs['id'] ? { id: Number(s.attrs['id']) } : {}),
          ...(s.attrs['contentType'] ? { contentType: s.attrs['contentType'] as 'video' } : {}),
          ...(s.attrs['mimeType'] ? { mimeType: s.attrs['mimeType'] } : {}),
          ...(s.attrs['lang'] ? { lang: s.attrs['lang'] } : {}),
          ...(s.attrs['segmentAlignment'] ? { segmentAlignment: s.attrs['segmentAlignment'] === 'true' } : {}),
          ...(st ? { segmentTemplate: st } : {}),
          representations: kids(s, 'Representation').map((r): RepresentationDef => {
            const rt = readTemplate(kids(r, 'SegmentTemplate')[0]);
            const bw = optNum(r.attrs['bandwidth'], 'bandwidth');
            if (!r.attrs['id'] || bw === undefined) throw new ManifestError('a Representation needs id and bandwidth');
            return {
              id: r.attrs['id'], bandwidth: bw,
              ...(r.attrs['codecs'] ? { codecs: r.attrs['codecs'] } : {}), ...(r.attrs['mimeType'] ? { mimeType: r.attrs['mimeType'] } : {}),
              ...(r.attrs['width'] ? { width: Number(r.attrs['width']) } : {}), ...(r.attrs['height'] ? { height: Number(r.attrs['height']) } : {}),
              ...(r.attrs['frameRate'] ? { frameRate: r.attrs['frameRate'] } : {}), ...(r.attrs['audioSamplingRate'] ? { audioSamplingRate: Number(r.attrs['audioSamplingRate']) } : {}),
              ...(rt ? { segmentTemplate: rt } : {}),
            };
          }),
        };
      }),
    })),
  };
  return mpd;
}

export interface TimelineSegment {
  readonly number: number;
  /** Start in timescale units. */
  readonly time: number;
  readonly duration: number;
}

/**
 * Expand a SegmentTimeline into numbered segments. `r` repeats an entry r more times; `r = -1` repeats until the next
 * entry's `t`, or until `endTime` (timescale units) for the last one, which must then be given.
 */
export function expandTimeline(timeline: readonly TimelineEntry[], startNumber = 1, endTime?: number, limit = 100_000): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  let time = 0;
  let number = startNumber;
  timeline.forEach((s, i) => {
    if (s.t !== undefined) time = s.t;
    if (!(s.d > 0)) throw new ManifestError('a timeline entry needs d above zero');
    let repeats = s.r ?? 0;
    if (repeats < 0) {
      const stop = timeline[i + 1]?.t ?? endTime;
      if (stop === undefined) throw new ManifestError('r=-1 on the last entry needs the end time of the period');
      repeats = Math.max(0, Math.ceil((stop - time) / s.d) - 1);
    }
    if (out.length + repeats + 1 > limit) throw new ManifestError(`timeline expands to more than ${limit} segments`);
    for (let k = 0; k <= repeats; k++) {
      out.push({ number: number++, time, duration: s.d });
      time += s.d;
    }
  });
  return out;
}

/** The URLs of a representation's segments, for a template with a timeline or a fixed duration. */
export function segmentUrls(rep: RepresentationDef, inherited: SegmentTemplate | undefined, periodDurationSeconds?: number): { init?: string; segments: { url: string; number: number; startSeconds: number; durationSeconds: number }[] } {
  const t = rep.segmentTemplate ?? inherited;
  if (!t) throw new ManifestError(`representation ${rep.id} has no SegmentTemplate`);
  const scale = t.timescale ?? 1;
  const startNumber = t.startNumber ?? 1;
  const segs: TimelineSegment[] = t.timeline
    ? expandTimeline(t.timeline, startNumber, periodDurationSeconds === undefined ? undefined : periodDurationSeconds * scale + (t.presentationTimeOffset ?? 0))
    : (() => {
        if (periodDurationSeconds === undefined) throw new ManifestError('the period duration is needed to list segments of a fixed duration');
        const n = Math.ceil((periodDurationSeconds * scale) / (t.duration as number));
        return Array.from({ length: n }, (_x, i) => ({ number: startNumber + i, time: i * (t.duration as number), duration: t.duration as number }));
      })();
  const pto = t.presentationTimeOffset ?? 0;
  const base = { representationId: rep.id, bandwidth: rep.bandwidth };
  return {
    ...(t.initialization ? { init: fillTemplate(t.initialization, base) } : {}),
    segments: segs.map((s) => ({ url: fillTemplate(t.media, { ...base, number: s.number, time: s.time }), number: s.number, startSeconds: (s.time - pto) / scale, durationSeconds: s.duration / scale })),
  };
}

/**
 * For a live MPD with a fixed segment duration: the newest complete segment number at `nowMs`, and the oldest still in
 * the time-shift buffer.
 */
export function dashLiveEdge(m: Mpd, t: SegmentTemplate, nowMs: number, periodStartSeconds = 0): { latest: number; oldest: number; latestStartSeconds: number } | undefined {
  if (m.type !== 'dynamic' || m.availabilityStartTime === undefined) throw new ManifestError('live edge needs a dynamic MPD with availabilityStartTime');
  if (!(t.duration && t.duration > 0)) throw new ManifestError('live edge needs a SegmentTemplate with a fixed duration');
  const segSeconds = t.duration / (t.timescale ?? 1);
  const startNumber = t.startNumber ?? 1;
  const elapsed = (nowMs - Date.parse(m.availabilityStartTime)) / 1000 - periodStartSeconds;
  const complete = Math.floor(elapsed / segSeconds); // segments fully made so far
  if (complete < 1) return undefined;
  const latest = startNumber + complete - 1;
  let oldest = startNumber;
  if (m.timeShiftBufferDepth !== undefined) // a segment stays available until its end plus the time-shift depth
  oldest = Math.max(startNumber, startNumber + Math.ceil((elapsed - m.timeShiftBufferDepth) / segSeconds) - 1);
  return { latest, oldest: Math.min(oldest, latest), latestStartSeconds: (latest - startNumber) * segSeconds };
}

// ================================================================================================ ladder

export type VideoCodec = 'h264' | 'hevc' | 'av1';
export interface LadderOptions {
  readonly width: number;
  readonly height: number;
  readonly frameRate?: number;
  readonly codec?: VideoCodec;
  /** Highest bitrate to offer, bits per second. */
  readonly maxBitrate?: number;
  /** Include a rung at source size even if it is not on the standard list. Default true. */
  readonly includeSource?: boolean;
  readonly audioBitrate?: number;
}
export interface Rung {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly videoBitrate: number;
  readonly maxrate: number;
  readonly bufsize: number;
  /** Peak, as HLS BANDWIDTH: video maxrate plus audio, with 5 percent for container overhead. */
  readonly bandwidth: number;
  readonly averageBandwidth: number;
  readonly codecs: string;
  readonly frameRate: number;
}

const BASE: readonly { h: number; kbps: number }[] = [
  { h: 240, kbps: 400 }, { h: 360, kbps: 800 }, { h: 480, kbps: 1400 }, { h: 720, kbps: 2800 }, { h: 1080, kbps: 5000 }, { h: 1440, kbps: 9000 }, { h: 2160, kbps: 16000 },
];
const SCALE: Record<VideoCodec, number> = { h264: 1, hevc: 0.7, av1: 0.6 };

export function codecString(codec: VideoCodec, height: number): string {
  if (codec === 'h264') return height <= 480 ? 'avc1.4d401e' : height <= 720 ? 'avc1.4d401f' : height <= 1080 ? 'avc1.640028' : 'avc1.640033';
  if (codec === 'hevc') return height <= 1080 ? 'hvc1.1.6.L120.90' : 'hvc1.1.6.L150.90';
  return height <= 1080 ? 'av01.0.08M.08' : 'av01.0.12M.08';
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function buildLadder(o: LadderOptions): Rung[] {
  if (!(Number.isInteger(o.width) && o.width > 0 && Number.isInteger(o.height) && o.height > 0)) throw new ManifestError('source width and height must be whole numbers above zero');
  const codec = o.codec ?? 'h264';
  const fps = o.frameRate ?? 30;
  const audio = o.audioBitrate ?? 128_000;
  const aspect = o.width / o.height;
  const heights = BASE.map((b) => b.h).filter((h) => h <= o.height);
  if ((o.includeSource ?? true) && !heights.includes(o.height) && o.height > (heights.at(-1) ?? 0)) heights.push(o.height);
  if (heights.length === 0) heights.push(o.height); // smaller than the smallest rung: just the source
  const rungs: Rung[] = [];
  for (const h of heights) {
    const base = BASE.find((b) => b.h === h);
    // a source size off the list gets a bitrate by pixel count from the nearest rung below
    const below = [...BASE].reverse().find((b) => b.h <= h) ?? (BASE[0] as { h: number; kbps: number });
    const kbps = base ? base.kbps : below.kbps * ((h * h * aspect) / (below.h * below.h * (16 / 9)));
    let video = Math.round(kbps * 1000 * SCALE[codec] * (fps > 30 ? 1.4 : 1));
    if (o.maxBitrate !== undefined) video = Math.min(video, o.maxBitrate);
    const width = h === o.height ? o.width : even(h * aspect);
    const maxrate = Math.round(video * 1.5);
    rungs.push({
      name: `${h}p`, width, height: h,
      videoBitrate: video, maxrate, bufsize: maxrate * 2,
      bandwidth: Math.round((maxrate + audio) * 1.05), averageBandwidth: Math.round((video + audio) * 1.05),
      codecs: `${codecString(codec, h)},mp4a.40.2`, frameRate: fps,
    });
  }
  return rungs;
}

/** The master playlist for a ladder, one media playlist per rung at `<name>/index.m3u8`. */
export function ladderMaster(rungs: readonly Rung[], options: { audioGroup?: boolean; pathFor?: (r: Rung) => string } = {}): MasterPlaylist {
  const path = options.pathFor ?? ((r: Rung) => `${r.name}/index.m3u8`);
  return {
    kind: 'master', version: 6, independentSegments: true,
    renditions: [],
    variants: rungs.map((r) => ({ uri: path(r), bandwidth: r.bandwidth, averageBandwidth: r.averageBandwidth, resolution: { width: r.width, height: r.height }, codecs: r.codecs, frameRate: r.frameRate })),
  };
}

/** The ffmpeg-ready numbers for a rung (the transcode-plan block builds the whole command). */
export function rungArgs(r: Rung): string[] {
  return ['-vf', `scale=${r.width}:${r.height}`, '-b:v', String(r.videoBitrate), '-maxrate', String(r.maxrate), '-bufsize', String(r.bufsize)];
}
