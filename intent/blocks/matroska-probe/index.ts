/**
 * Matroska and WebM, read far enough to catalogue and to choose a stream: the EBML header, the segment's info,
 * every track, the chapters, the tags, the attachments, and where the rest of the file lives.
 *
 *  - Header: DocType (matroska or webm), versions.
 *  - Info: timecode scale, duration in seconds (`Duration` x scale), title, muxing and writing application,
 *    date, segment uid; when a file has no duration, an estimate from the last cluster seen.
 *  - Tracks: number, uid, type, codec id and a short name (h264, hevc, av1, aac, eac3, opus, srt, pgs...), flags
 *    (enabled, default, forced, hearing impaired, commentary, original), language (legacy and BCP 47), name,
 *    video size, display size, frame rate from the default duration, interlacing, stereo mode, bit depth and
 *    colour with a verdict (sdr, hdr10, hlg, dolby-vision), H.264 and HEVC profile and level from the codec
 *    private data, audio rate, channels and layout, and whether content encoding compresses or encrypts the track.
 *  - Chapters: editions and nested atoms, start and end in ms, every display string with its language, hidden
 *    and enabled flags; a flat, sorted list with each end filled in.
 *  - Tags (flattened), attachments (name, type, size, cover art, fonts).
 *  - Where things are: the seek head's positions, and for a file read only in part, which parts are still needed
 *    and how many bytes from the start would cover them, so the caller can read again.
 *  - `writeMatroska`: a minimal muxer for fixtures and tests, writing the same elements.
 *
 * The reader is bounds-checked at every step: a declared size never allocates, nesting and element counts are
 * capped, unknown sizes are accepted only where the format allows them, and a damaged element ends that branch
 * with a warning instead of the whole read. It reads headers only; it never decodes a frame.
 */

export class MatroskaError extends Error {}

// ---------------------------------------------------------------- element ids

const ID = {
  EBML: 0x1a45dfa3, DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285, EBMLVersion: 0x4286,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, DateUTC: 0x4461, Title: 0x7ba9, MuxingApp: 0x4d80, WritingApp: 0x5741, SegmentUID: 0x73a4,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagEnabled: 0xb9, FlagDefault: 0x88, FlagForced: 0x55aa, FlagHearingImpaired: 0x55ab, FlagVisualImpaired: 0x55ac, FlagOriginal: 0x55ae, FlagCommentary: 0x55af,
  DefaultDuration: 0x23e383, Name: 0x536e, Language: 0x22b59c, LanguageBCP47: 0x22b59d, CodecID: 0x86, CodecPrivate: 0x63a2, CodecName: 0x258688,
  Video: 0xe0, FlagInterlaced: 0x9a, StereoMode: 0x53b8, PixelWidth: 0xb0, PixelHeight: 0xba, DisplayWidth: 0x54b0, DisplayHeight: 0x54ba,
  Colour: 0x55b0, MatrixCoefficients: 0x55b1, BitsPerChannel: 0x55b2, Range: 0x55b9, TransferCharacteristics: 0x55ba, Primaries: 0x55bb, MaxCLL: 0x55bc, MaxFALL: 0x55bd, MasteringMetadata: 0x55d0,
  Audio: 0xe1, SamplingFrequency: 0xb5, OutputSamplingFrequency: 0x78b5, Channels: 0x9f, BitDepth: 0x6264,
  ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentCompression: 0x5034, ContentEncryption: 0x5035,
  BlockAdditionMapping: 0x41e4, BlockAddIDType: 0x41e7, BlockAddIDName: 0x41a4,
  Chapters: 0x1043a770, EditionEntry: 0x45b9, EditionUID: 0x45bc, EditionFlagHidden: 0x45bd, EditionFlagDefault: 0x45db, EditionFlagOrdered: 0x45dd,
  ChapterAtom: 0xb6, ChapterUID: 0x73c4, ChapterStringUID: 0x5654, ChapterTimeStart: 0x91, ChapterTimeEnd: 0x92, ChapterFlagHidden: 0x98, ChapterFlagEnabled: 0x4598,
  ChapterDisplay: 0x80, ChapString: 0x85, ChapLanguage: 0x437c, ChapLanguageBCP47: 0x437d,
  Tags: 0x1254c367, Tag: 0x7373, Targets: 0x63c0, TargetTypeValue: 0x68ca, TagTrackUID: 0x63c5, SimpleTag: 0x67c8, TagName: 0x45a3, TagString: 0x4487, TagLanguage: 0x447a,
  Attachments: 0x1941a469, AttachedFile: 0x61a7, FileDescription: 0x467e, FileName: 0x466e, FileMediaType: 0x4660, FileData: 0x465c, FileUID: 0x46ae,
  Cluster: 0x1f43b675, ClusterTimecode: 0xe7, Cues: 0x1c53bb6b, Void: 0xec, CRC32: 0xbf,
} as const;

// ---------------------------------------------------------------- low-level reading

interface El {
  readonly id: number;
  readonly start: number;
  readonly data: number;
  /** Where its data ends; the end of the buffer for an unknown size. */
  readonly end: number;
  /** The declared data size; -1 for an unknown size. */
  readonly size: number;
  /** True when the declared end lies beyond the buffer. */
  readonly cut: boolean;
  readonly unknown: boolean;
}

/** An element header at `at`, or undefined when the buffer ends inside it or it is not valid. */
function header(buf: Buffer, at: number, limit: number): El | undefined | 'bad' {
  if (at >= limit) return undefined;
  const b0 = buf[at]!;
  if (b0 === 0) return 'bad';
  const idLen = Math.clz32(b0) - 24 + 1;
  if (idLen > 4) return 'bad';
  if (at + idLen > limit) return undefined;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[at + i]!;
  const s0 = at + idLen;
  if (s0 >= limit) return undefined;
  const c = buf[s0]!;
  if (c === 0) return 'bad';
  const sLen = Math.clz32(c) - 24 + 1;
  if (s0 + sLen > limit) return undefined;
  let size = c & (0xff >> sLen);
  let allOnes = size === 0xff >> sLen;
  for (let i = 1; i < sLen; i++) {
    size = size * 256 + buf[s0 + i]!;
    if (buf[s0 + i] !== 0xff) allOnes = false;
  }
  const data = s0 + sLen;
  if (allOnes) return { id, start: at, data, end: limit, size: -1, cut: false, unknown: true };
  if (!Number.isSafeInteger(size)) return 'bad';
  const end = data + size;
  return { id, start: at, data, end: Math.min(end, limit), size, cut: end > limit, unknown: false };
}

const uint = (buf: Buffer, e: El): number => {
  const n = e.end - e.data;
  if (n < 1 || n > 8) return 0;
  let v = 0n;
  for (let i = e.data; i < e.end; i++) v = (v << 8n) | BigInt(buf[i]!);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
};
const bigUint = (buf: Buffer, e: El): bigint => {
  let v = 0n;
  for (let i = e.data; i < Math.min(e.end, e.data + 8); i++) v = (v << 8n) | BigInt(buf[i]!);
  return v;
};
const sint = (buf: Buffer, e: El): bigint => {
  const n = e.end - e.data;
  if (n < 1 || n > 8) return 0n;
  const u = bigUint(buf, e);
  return u >= 1n << BigInt(n * 8 - 1) ? u - (1n << BigInt(n * 8)) : u;
};
const float = (buf: Buffer, e: El): number | undefined => {
  const n = e.end - e.data;
  const v = n === 4 ? buf.readFloatBE(e.data) : n === 8 ? buf.readDoubleBE(e.data) : undefined;
  return v !== undefined && Number.isFinite(v) ? v : undefined;
};
const str = (buf: Buffer, e: El, max = 4096): string => buf.toString('utf8', e.data, Math.min(e.end, e.data + max)).replace(/\u0000+$/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const hex = (buf: Buffer, e: El) => buf.toString('hex', e.data, Math.min(e.end, e.data + 64));

// ---------------------------------------------------------------- output types

export type TrackKind = 'video' | 'audio' | 'subtitle' | 'complex' | 'buttons' | 'metadata' | 'other';
export type Hdr = 'sdr' | 'hdr10' | 'hlg' | 'dolby-vision';

export interface Colour {
  readonly bitsPerChannel?: number;
  readonly matrix?: number;
  readonly range?: number;
  readonly transfer?: number;
  readonly primaries?: number;
  readonly maxCll?: number;
  readonly maxFall?: number;
  readonly mastering: boolean;
}

export interface Track {
  readonly number: number;
  readonly uid?: string;
  readonly kind: TrackKind;
  readonly codecId: string;
  /** A short, stable name: h264, hevc, av1, vp9, aac, eac3, dts, truehd, flac, opus, srt, ass, pgs ... */
  readonly codec: string;
  readonly codecName?: string;
  readonly name?: string;
  /** Legacy ISO 639-2 code; "eng" when the file says nothing, as the format specifies. */
  readonly language: string;
  readonly bcp47?: string;
  readonly enabled: boolean;
  readonly default: boolean;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
  readonly commentary: boolean;
  readonly original: boolean;
  /** Subtitle tracks only: text (can be converted) or bitmap (cannot). */
  readonly subtitleKind?: 'text' | 'bitmap';
  readonly width?: number;
  readonly height?: number;
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  readonly fps?: number;
  readonly interlaced?: boolean;
  readonly stereoMode?: number;
  readonly colour?: Colour;
  readonly hdr?: Hdr;
  readonly profile?: string;
  readonly level?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly layout?: string;
  readonly bitDepth?: number;
  readonly compressed: boolean;
  readonly encrypted: boolean;
}

export interface ChapterTitle {
  readonly text: string;
  readonly language: string;
}

export interface Chapter {
  readonly uid?: string;
  readonly stringUid?: string;
  readonly startMs: number;
  readonly endMs?: number;
  readonly titles: readonly ChapterTitle[];
  readonly hidden: boolean;
  readonly enabled: boolean;
  readonly children: readonly Chapter[];
}

export interface Edition {
  readonly uid?: string;
  readonly hidden: boolean;
  readonly default: boolean;
  readonly ordered: boolean;
  readonly chapters: readonly Chapter[];
}

export interface Tag {
  readonly name: string;
  readonly value: string;
  readonly language?: string;
  /** Matroska target level: 50 album/movie, 30 track, 70 collection... */
  readonly targetType?: number;
  readonly trackUid?: string;
}

export interface Attachment {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly description?: string;
  readonly cover: boolean;
  readonly font: boolean;
}

export interface Info {
  readonly timecodeScale: number;
  readonly title?: string;
  readonly muxingApp?: string;
  readonly writingApp?: string;
  /** ISO time from DateUTC (nanoseconds since 2001-01-01). */
  readonly date?: string;
  readonly segmentUid?: string;
}

export interface Probe {
  readonly docType: string;
  readonly docTypeVersion?: number;
  readonly isWebm: boolean;
  readonly info: Info;
  readonly durationSec?: number;
  /** True when the duration came from the last cluster seen and not from the file's own field. */
  readonly durationEstimated: boolean;
  readonly tracks: readonly Track[];
  readonly editions: readonly Edition[];
  readonly tags: readonly Tag[];
  readonly attachments: readonly Attachment[];
  /** Absolute file offsets of top-level elements the seek head names. */
  readonly seek: Readonly<Record<string, number>>;
  /** Offset of the first cluster, if reached. */
  readonly firstCluster?: number;
  /** Top-level parts the seek head says exist but this buffer does not hold. */
  readonly missing: readonly string[];
  /** Read this many bytes from the start of the file to hold everything missing that can be located. */
  readonly needBytes?: number;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------- names

const KIND: Record<number, TrackKind> = { 1: 'video', 2: 'audio', 3: 'complex', 17: 'subtitle', 18: 'buttons', 33: 'metadata' };

const CODEC: [RegExp, string][] = [
  [/^V_MPEG4\/ISO\/AVC$/, 'h264'], [/^V_MPEGH\/ISO\/HEVC$/, 'hevc'], [/^V_AV1$/, 'av1'], [/^V_VP9$/, 'vp9'], [/^V_VP8$/, 'vp8'], [/^V_MPEG2$/, 'mpeg2'], [/^V_MPEG1$/, 'mpeg1'], [/^V_MPEG4\/ISO\/(?:ASP|SP|AP)$/, 'mpeg4'], [/^V_MS\/VFW\/FOURCC$/, 'vfw'], [/^V_THEORA$/, 'theora'], [/^V_REAL/, 'real'],
  [/^A_AAC(?:\/|$)/, 'aac'], [/^A_AC3(?:\/|$)/, 'ac3'], [/^A_EAC3$/, 'eac3'], [/^A_DTS\/EXPRESS$/, 'dts-express'], [/^A_DTS\/LOSSLESS$/, 'dts-ma'], [/^A_DTS$/, 'dts'], [/^A_TRUEHD$/, 'truehd'], [/^A_FLAC$/, 'flac'], [/^A_OPUS$/, 'opus'], [/^A_VORBIS$/, 'vorbis'],
  [/^A_MPEG\/L3$/, 'mp3'], [/^A_MPEG\/L[12]$/, 'mp2'], [/^A_PCM\//, 'pcm'], [/^A_ALAC$/, 'alac'], [/^A_MS\/ACM$/, 'acm'], [/^A_WAVPACK4$/, 'wavpack'], [/^A_TTA1$/, 'tta'],
  [/^S_TEXT\/UTF8$/, 'srt'], [/^S_TEXT\/ASCII$/, 'srt'], [/^S_TEXT\/ASS$|^S_ASS$/, 'ass'], [/^S_TEXT\/SSA$|^S_SSA$/, 'ssa'], [/^S_TEXT\/WEBVTT$/, 'vtt'], [/^S_HDMV\/PGS$/, 'pgs'], [/^S_HDMV\/TEXTST$/, 'textst'], [/^S_VOBSUB$/, 'vobsub'], [/^S_DVBSUB$/, 'dvbsub'], [/^S_KATE$/, 'kate'],
];
const BITMAP = new Set(['pgs', 'vobsub', 'dvbsub']);

export const codecName = (id: string): string => CODEC.find(([re]) => re.test(id))?.[1] ?? id.toLowerCase().replace(/^[vas]_/, '').split('/')[0]!;

const L2: Record<string, string> = { eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', rus: 'ru', por: 'pt', dut: 'nl', nld: 'nl', swe: 'sv', pol: 'pl', ara: 'ar', hin: 'hi', tur: 'tr', nor: 'no', dan: 'da', fin: 'fi', cze: 'cs', ces: 'cs', heb: 'he', gre: 'el', ell: 'el', hun: 'hu', ukr: 'uk', tha: 'th', vie: 'vi' };

/** The two-letter code for a legacy three-letter one, when it has one (and for "und" nothing). */
export const language2 = (l: string): string | undefined => L2[l.toLowerCase()];

const LAYOUT: Record<number, string> = { 1: 'mono', 2: 'stereo', 3: '2.1', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1' };

/** H.264 profile and level from avcC, HEVC from hvcC. */
function profileLevel(codec: string, cp: Buffer): { profile?: string; level?: string } {
  if (codec === 'h264' && cp.length >= 4 && cp[0] === 1) {
    const p = cp[1]!;
    const names: Record<number, string> = { 66: 'baseline', 77: 'main', 88: 'extended', 100: 'high', 110: 'high10', 122: 'high422', 244: 'high444', 44: 'cavlc444' };
    const l = cp[3]!;
    return { profile: names[p] ?? String(p), level: l === 9 ? '1b' : `${Math.floor(l / 10)}.${l % 10}` };
  }
  if (codec === 'hevc' && cp.length >= 13 && cp[0] === 1) {
    const prof = cp[1]! & 0x1f;
    const tier = (cp[1]! & 0x20) !== 0 ? 'high' : 'main';
    const l = cp[12]!;
    return { profile: ({ 1: 'main', 2: 'main10', 3: 'main-still', 4: 'rext' } as Record<number, string>)[prof] ?? String(prof), level: `${tier} ${(l / 30).toFixed(1).replace(/\.0$/, '')}` };
  }
  return {};
}

// ---------------------------------------------------------------- reading

export interface ProbeOptions {
  readonly maxElements?: number;
  readonly maxDepth?: number;
  /** The whole file's size, if known, so what a buffer lacks can be told from what the file lacks. */
  readonly fileSize?: number;
}

const EPOCH_2001 = Date.UTC(2001, 0, 1);

export function probe(buf: Buffer, o: ProbeOptions = {}): Probe {
  const warnings: string[] = [];
  const maxEl = o.maxElements ?? 200_000;
  const maxDepth = o.maxDepth ?? 10;
  let count = 0;
  const warn = (w: string) => {
    if (warnings.length < 30) warnings.push(w);
  };
  const next = (at: number, limit: number): El | undefined | 'bad' => {
    if (++count > maxEl) throw new MatroskaError(`more than ${maxEl} elements`);
    return header(buf, at, limit);
  };
  /** Children of a master element, calling `f` for each; stops at damage. */
  const each = (parent: { data: number; end: number }, depth: number, f: (e: El) => void) => {
    if (depth > maxDepth) {
      warn('elements are nested too deeply; the rest was skipped');
      return;
    }
    for (let at = parent.data; at < parent.end; ) {
      const e = next(at, parent.end);
      if (e === undefined) return;
      if (e === 'bad') {
        warn(`a damaged element at byte ${at}`);
        return;
      }
      if (e.unknown && e.id !== ID.Segment && e.id !== ID.Cluster) {
        warn(`an unknown size on element ${e.id.toString(16)} is not allowed there`);
        return;
      }
      f(e);
      if (e.end <= at) return;
      at = e.end;
    }
  };

  // EBML header
  const h0 = header(buf, 0, buf.length);
  if (!h0 || h0 === 'bad' || h0.id !== ID.EBML) throw new MatroskaError('not a Matroska or WebM file: no EBML header');
  let docType = 'matroska';
  let docTypeVersion: number | undefined;
  each(h0, 1, (e) => {
    if (e.id === ID.DocType) docType = str(buf, e, 32).toLowerCase();
    else if (e.id === ID.DocTypeVersion) docTypeVersion = uint(buf, e);
  });
  if (docType !== 'matroska' && docType !== 'webm') throw new MatroskaError(`the document type is ${JSON.stringify(docType.slice(0, 20))}, not matroska or webm`);

  let segment: El | undefined;
  for (let at = h0.end; at < buf.length; ) {
    const e = next(at, buf.length);
    if (!e || e === 'bad') break;
    if (e.id === ID.Segment) {
      segment = e;
      break;
    }
    at = e.end;
  }
  if (!segment) throw new MatroskaError('no segment: the file is too short or damaged');

  let scale = 1_000_000;
  let durationRaw: number | undefined;
  const info: { -readonly [K in keyof Info]: Info[K] } = { timecodeScale: scale };
  const tracks: Track[] = [];
  const editions: Edition[] = [];
  const tags: Tag[] = [];
  const attachments: Attachment[] = [];
  const seek: Record<string, number> = {};
  const seen = new Set<string>();
  let firstCluster: number | undefined;
  let lastClusterTc: number | undefined;
  let infoSeen = false;

  const SEEK_NAMES: Record<number, string> = { [ID.Info]: 'Info', [ID.Tracks]: 'Tracks', [ID.Chapters]: 'Chapters', [ID.Tags]: 'Tags', [ID.Attachments]: 'Attachments', [ID.Cues]: 'Cues', [ID.Cluster]: 'Cluster' };

  const readInfo = (e: El) => {
    infoSeen = true;
    each(e, 3, (c) => {
      if (c.id === ID.TimecodeScale) scale = Math.max(1, uint(buf, c));
      else if (c.id === ID.Duration) durationRaw = float(buf, c);
      else if (c.id === ID.Title) info.title = str(buf, c);
      else if (c.id === ID.MuxingApp) info.muxingApp = str(buf, c);
      else if (c.id === ID.WritingApp) info.writingApp = str(buf, c);
      else if (c.id === ID.SegmentUID) info.segmentUid = hex(buf, c);
      else if (c.id === ID.DateUTC && c.end - c.data === 8) {
        const ms = Number(sint(buf, c) / 1_000_000n) + EPOCH_2001;
        if (Number.isFinite(ms) && Math.abs(ms) < 8.64e15) info.date = new Date(ms).toISOString();
      }
    });
    info.timecodeScale = scale;
  };

  const readTrack = (e: El) => {
    const t: { -readonly [K in keyof Track]: Track[K] } = { number: 0, kind: 'other', codecId: '', codec: '', language: 'eng', enabled: true, default: true, forced: false, hearingImpaired: false, commentary: false, original: false, compressed: false, encrypted: false };
    let cp: Buffer | undefined;
    let dv = false;
    let colour: { -readonly [K in keyof Colour]: Colour[K] } | undefined;
    let defaultDurationNs: number | undefined;
    let type = 0;
    each(e, 4, (c) => {
      switch (c.id) {
        case ID.TrackNumber: t.number = uint(buf, c); break;
        case ID.TrackUID: t.uid = bigUint(buf, c).toString(); break;
        case ID.TrackType: type = uint(buf, c); t.kind = KIND[type] ?? 'other'; break;
        case ID.FlagEnabled: t.enabled = uint(buf, c) !== 0; break;
        case ID.FlagDefault: t.default = uint(buf, c) !== 0; break;
        case ID.FlagForced: t.forced = uint(buf, c) !== 0; break;
        case ID.FlagHearingImpaired: t.hearingImpaired = uint(buf, c) !== 0; break;
        case ID.FlagCommentary: t.commentary = uint(buf, c) !== 0; break;
        case ID.FlagOriginal: t.original = uint(buf, c) !== 0; break;
        case ID.DefaultDuration: defaultDurationNs = uint(buf, c); break;
        case ID.Name: t.name = str(buf, c); break;
        case ID.Language: t.language = str(buf, c, 16).toLowerCase() || 'eng'; break;
        case ID.LanguageBCP47: t.bcp47 = str(buf, c, 64); break;
        case ID.CodecID: t.codecId = str(buf, c, 100); break;
        case ID.CodecName: t.codecName = str(buf, c, 100); break;
        case ID.CodecPrivate: cp = buf.subarray(c.data, Math.min(c.end, c.data + 4096)); break;
        case ID.Video:
          each(c, 5, (v) => {
            switch (v.id) {
              case ID.PixelWidth: t.width = uint(buf, v); break;
              case ID.PixelHeight: t.height = uint(buf, v); break;
              case ID.DisplayWidth: t.displayWidth = uint(buf, v); break;
              case ID.DisplayHeight: t.displayHeight = uint(buf, v); break;
              case ID.FlagInterlaced: { const x = uint(buf, v); if (x === 1) t.interlaced = true; else if (x === 2) t.interlaced = false; break; }
              case ID.StereoMode: t.stereoMode = uint(buf, v); break;
              case ID.Colour:
                colour = { mastering: false };
                each(v, 6, (k) => {
                  if (k.id === ID.BitsPerChannel) colour!.bitsPerChannel = uint(buf, k);
                  else if (k.id === ID.MatrixCoefficients) colour!.matrix = uint(buf, k);
                  else if (k.id === ID.Range) colour!.range = uint(buf, k);
                  else if (k.id === ID.TransferCharacteristics) colour!.transfer = uint(buf, k);
                  else if (k.id === ID.Primaries) colour!.primaries = uint(buf, k);
                  else if (k.id === ID.MaxCLL) colour!.maxCll = uint(buf, k);
                  else if (k.id === ID.MaxFALL) colour!.maxFall = uint(buf, k);
                  else if (k.id === ID.MasteringMetadata) colour!.mastering = true;
                });
                break;
              default:
            }
          });
          break;
        case ID.Audio:
          each(c, 5, (a) => {
            const hz = a.id === ID.SamplingFrequency || a.id === ID.OutputSamplingFrequency ? float(buf, a) : undefined;
            if (hz !== undefined && (a.id === ID.OutputSamplingFrequency || t.sampleRate === undefined)) t.sampleRate = hz;
            else if (a.id === ID.Channels) t.channels = uint(buf, a);
            else if (a.id === ID.BitDepth) t.bitDepth = uint(buf, a);
          });
          break;
        case ID.ContentEncodings:
          each(c, 5, (enc) => {
            if (enc.id !== ID.ContentEncoding) return;
            each(enc, 6, (x) => {
              if (x.id === ID.ContentCompression) t.compressed = true;
              else if (x.id === ID.ContentEncryption) t.encrypted = true;
            });
          });
          break;
        case ID.BlockAdditionMapping:
          each(c, 5, (m) => {
            if (m.id === ID.BlockAddIDType) {
              const v = uint(buf, m);
              if (v === 0x64766343 || v === 0x64767643 || v === 0x64767743) dv = true;
            }
          });
          break;
        default:
      }
    });
    if (!t.number) {
      warn('a track has no number');
      return;
    }
    t.codec = codecName(t.codecId);
    if (t.kind === 'subtitle') t.subtitleKind = BITMAP.has(t.codec) ? 'bitmap' : 'text';
    if (defaultDurationNs && t.kind === 'video') t.fps = Math.round((1e9 / defaultDurationNs) * 1000) / 1000;
    if (t.kind === 'video') {
      if (colour) t.colour = colour;
      const tr = (colour as Colour | undefined)?.transfer;
      t.hdr = dv ? 'dolby-vision' : tr === 16 ? 'hdr10' : tr === 18 ? 'hlg' : 'sdr';
      if (cp) Object.assign(t, profileLevel(t.codec, cp));
    }
    if (t.kind === 'audio' && t.channels) t.layout = LAYOUT[t.channels] ?? `${t.channels}ch`;
    tracks.push(t);
  };

  const readChapters = (atom: El, depth: number): Chapter => {
    let start = 0;
    let end: number | undefined;
    let uid: string | undefined;
    let sUid: string | undefined;
    let hidden = false;
    let enabled = true;
    const titles: ChapterTitle[] = [];
    const children: Chapter[] = [];
    const ms = (e: El) => Number(bigUint(buf, e) / 1_000_000n);
    each(atom, depth, (c) => {
      if (c.id === ID.ChapterTimeStart) start = ms(c);
      else if (c.id === ID.ChapterTimeEnd) end = ms(c);
      else if (c.id === ID.ChapterUID) uid = bigUint(buf, c).toString();
      else if (c.id === ID.ChapterStringUID) sUid = str(buf, c, 200);
      else if (c.id === ID.ChapterFlagHidden) hidden = uint(buf, c) !== 0;
      else if (c.id === ID.ChapterFlagEnabled) enabled = uint(buf, c) !== 0;
      else if (c.id === ID.ChapterDisplay) {
        let text = '';
        let lang = 'eng';
        each(c, depth + 1, (d) => {
          if (d.id === ID.ChapString) text = str(buf, d, 1000);
          else if (d.id === ID.ChapLanguageBCP47) lang = str(buf, d, 64) || lang;
          else if (d.id === ID.ChapLanguage && lang === 'eng') lang = str(buf, d, 16).toLowerCase() || 'eng';
        });
        titles.push({ text, language: lang });
      } else if (c.id === ID.ChapterAtom) children.push(readChapters(c, depth + 1));
    });
    return { ...(uid ? { uid } : {}), ...(sUid ? { stringUid: sUid } : {}), startMs: start, ...(end !== undefined ? { endMs: end } : {}), titles, hidden, enabled, children };
  };

  const readTags = (e: El) => {
    each(e, 3, (tag) => {
      if (tag.id !== ID.Tag) return;
      let targetType: number | undefined;
      let trackUid: string | undefined;
      const simple: El[] = [];
      each(tag, 4, (c) => {
        if (c.id === ID.Targets)
          each(c, 5, (t) => {
            if (t.id === ID.TargetTypeValue) targetType = uint(buf, t);
            else if (t.id === ID.TagTrackUID) trackUid = bigUint(buf, t).toString();
          });
        else if (c.id === ID.SimpleTag) simple.push(c);
      });
      const walk = (s: El, prefix: string, depth: number) => {
        let name = '';
        let value: string | undefined;
        let lang: string | undefined;
        const nested: El[] = [];
        each(s, depth, (c) => {
          if (c.id === ID.TagName) name = str(buf, c, 200);
          else if (c.id === ID.TagString) value = str(buf, c, 4000);
          else if (c.id === ID.TagLanguage) lang = str(buf, c, 16).toLowerCase();
          else if (c.id === ID.SimpleTag) nested.push(c);
        });
        const full = prefix ? `${prefix}/${name}` : name;
        if (name && value !== undefined && tags.length < 2000) tags.push({ name: full, value, ...(lang && lang !== 'und' ? { language: lang } : {}), ...(targetType !== undefined ? { targetType } : {}), ...(trackUid ? { trackUid } : {}) });
        for (const n of nested) walk(n, full, depth + 1);
      };
      for (const s of simple) walk(s, '', 5);
    });
  };

  const readAttachments = (e: El) => {
    each(e, 3, (f) => {
      if (f.id !== ID.AttachedFile) return;
      let name = '';
      let mediaType = '';
      let description: string | undefined;
      let size = 0;
      each(f, 4, (c) => {
        if (c.id === ID.FileName) name = str(buf, c, 300);
        else if (c.id === ID.FileMediaType) mediaType = str(buf, c, 100).toLowerCase();
        else if (c.id === ID.FileDescription) description = str(buf, c, 300);
        else if (c.id === ID.FileData) size = Math.max(0, c.size);
      });
      if (attachments.length < 1000) {
        attachments.push({ name, mediaType, size, ...(description ? { description } : {}), cover: /^image\//.test(mediaType) && /^cover|^poster|^folder|^front/i.test(name), font: /font|ttf|otf|woff/.test(mediaType) || /\.(?:ttf|otf|woff2?|ttc)$/i.test(name) });
      }
    });
  };

  const handle = (e: El) => {
    const named = SEEK_NAMES[e.id];
    if (e.cut && e.id !== ID.Cluster && e.id !== ID.Cues) {
      warn(`${named ?? e.id.toString(16)} runs past the end of what was read`);
      return;
    }
    if (named && named !== 'Cluster') seen.add(named);
    switch (e.id) {
      case ID.SeekHead:
        each(e, 2, (s) => {
          if (s.id !== ID.Seek) return;
          let id = 0;
          let pos: number | undefined;
          each(s, 3, (c) => {
            if (c.id === ID.SeekID) for (let i = c.data; i < Math.min(c.end, c.data + 4); i++) id = id * 256 + buf[i]!;
            else if (c.id === ID.SeekPosition) pos = uint(buf, c);
          });
          const n = SEEK_NAMES[id];
          if (n && pos !== undefined && !(n in seek)) seek[n] = segment!.data + pos;
        });
        break;
      case ID.Info: readInfo(e); break;
      case ID.Tracks: each(e, 2, (t) => (t.id === ID.TrackEntry ? readTrack(t) : undefined)); break;
      case ID.Chapters:
        each(e, 2, (ed) => {
          if (ed.id !== ID.EditionEntry) return;
          let uid: string | undefined;
          let hidden = false;
          let def = false;
          let ordered = false;
          const chapters: Chapter[] = [];
          each(ed, 3, (c) => {
            if (c.id === ID.EditionUID) uid = bigUint(buf, c).toString();
            else if (c.id === ID.EditionFlagHidden) hidden = uint(buf, c) !== 0;
            else if (c.id === ID.EditionFlagDefault) def = uint(buf, c) !== 0;
            else if (c.id === ID.EditionFlagOrdered) ordered = uint(buf, c) !== 0;
            else if (c.id === ID.ChapterAtom && chapters.length < 5000) chapters.push(readChapters(c, 4));
          });
          editions.push({ ...(uid ? { uid } : {}), hidden, default: def, ordered, chapters });
        });
        break;
      case ID.Tags: readTags(e); break;
      case ID.Attachments: readAttachments(e); break;
      default:
    }
  };

  for (let at = segment.data; at < segment.end; ) {
    const e = next(at, segment.end);
    if (e === undefined) break;
    if (e === 'bad') {
      warn(`a damaged element at byte ${at}`);
      break;
    }
    if (e.id === ID.Cluster) {
      if (firstCluster === undefined) firstCluster = e.start;
      if (!e.cut || e.end - e.data > 16) {
        let tc: number | undefined;
        each({ data: e.data, end: Math.min(e.end, e.data + 64) }, 2, (c) => (c.id === ID.ClusterTimecode ? (tc = uint(buf, c)) : undefined));
        if (tc !== undefined) lastClusterTc = tc;
      }
      if (e.cut || e.unknown) {
        break;
      }
    } else handle(e);
    if (e.end <= at) break;
    at = e.end;
  }

  const missing: string[] = [];
  let need = 0;
  for (const name of ['Info', 'Tracks', 'Chapters', 'Tags', 'Attachments']) {
    if (name in seek && !seen.has(name)) {
      missing.push(name);
      const pos = seek[name]!;
      // The element's size is unknown until read; ask for a generous window after its start.
      if (pos >= buf.length || pos + 16 > buf.length) need = Math.max(need, pos + 1_048_576);
    }
  }
  if (!infoSeen && !('Info' in seek)) warn('the file has no Info element');
  const durationSec = durationRaw !== undefined && durationRaw > 0 ? (durationRaw * scale) / 1e9 : lastClusterTc !== undefined && lastClusterTc > 0 ? (lastClusterTc * scale) / 1e9 : undefined;
  const bound = o.fileSize !== undefined ? Math.min(need, o.fileSize) : need;
  return {
    docType, ...(docTypeVersion !== undefined ? { docTypeVersion } : {}), isWebm: docType === 'webm', info, ...(durationSec !== undefined ? { durationSec } : {}), durationEstimated: !(durationRaw !== undefined && durationRaw > 0),
    tracks, editions, tags, attachments, seek, ...(firstCluster !== undefined ? { firstCluster } : {}), missing, ...(bound > buf.length ? { needBytes: bound } : {}), warnings,
  };
}

// ---------------------------------------------------------------- using what was read

export interface FlatChapter {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string;
  readonly depth: number;
}

/** Chapters of an edition (the default one unless named) as a sorted list; each end is the file's own, or the next start, or the duration. Hidden and disabled atoms are skipped. */
export function flatChapters(p: Probe, o: { edition?: number; language?: string } = {}): FlatChapter[] {
  const ed = o.edition !== undefined ? p.editions[o.edition] : (p.editions.find((e) => e.default && !e.hidden) ?? p.editions.find((e) => !e.hidden) ?? p.editions[0]);
  if (!ed) return [];
  const lang = o.language?.toLowerCase();
  const title = (c: Chapter) => (lang ? c.titles.find((t) => t.language.toLowerCase() === lang || language2(t.language) === lang) : undefined)?.text ?? c.titles[0]?.text ?? '';
  const out: { startMs: number; endMs?: number; title: string; depth: number }[] = [];
  const walk = (cs: readonly Chapter[], depth: number) => {
    for (const c of cs) {
      if (c.enabled && !c.hidden) out.push({ startMs: c.startMs, ...(c.endMs !== undefined ? { endMs: c.endMs } : {}), title: title(c), depth });
      walk(c.children, depth + 1);
    }
  };
  walk(ed.chapters, 0);
  out.sort((a, b) => a.startMs - b.startMs || a.depth - b.depth);
  const dur = p.durationSec !== undefined ? Math.round(p.durationSec * 1000) : undefined;
  return out.map((c, i) => ({ index: i + 1, startMs: c.startMs, endMs: c.endMs ?? out.slice(i + 1).find((n) => n.startMs > c.startMs)?.startMs ?? dur ?? c.startMs, title: c.title, depth: c.depth }));
}

/** The video, audio and subtitle tracks a player should start with, by flags and the languages preferred (two- or three-letter). */
export function defaultTracks(p: Probe, o: { audioLanguages?: readonly string[]; subtitleLanguages?: readonly string[] } = {}): { video?: Track; audio?: Track; subtitle?: Track } {
  const same = (t: Track, l: string) => t.language.toLowerCase() === l.toLowerCase() || language2(t.language) === l.toLowerCase() || t.bcp47?.toLowerCase().split('-')[0] === l.toLowerCase();
  const usable = (k: TrackKind) => p.tracks.filter((t) => t.kind === k && t.enabled);
  const video = usable('video').find((t) => t.default) ?? usable('video')[0];
  const audios = usable('audio').filter((t) => !t.commentary);
  let audio: Track | undefined;
  for (const l of o.audioLanguages ?? []) if ((audio = audios.find((t) => same(t, l) && t.default) ?? audios.find((t) => same(t, l)))) break;
  audio ??= audios.find((t) => t.default) ?? audios[0];
  const subs = usable('subtitle');
  let subtitle: Track | undefined;
  for (const l of o.subtitleLanguages ?? []) if ((subtitle = subs.find((t) => same(t, l) && !t.forced && !t.commentary) ?? subs.find((t) => same(t, l) && !t.commentary))) break;
  subtitle ??= audio && subs.length ? subs.find((t) => t.forced && same(t, audio.language)) : undefined;
  return { ...(video ? { video } : {}), ...(audio ? { audio } : {}), ...(subtitle ? { subtitle } : {}) };
}

/** A one-line description of a track: "video h264 high@4.1 1920x1080 23.976fps hdr10", "audio eac3 5.1 48000Hz eng (English)". */
export function describe(t: Track): string {
  const bits: string[] = [t.kind, t.codec];
  if (t.profile) bits.push(t.level ? `${t.profile}@${t.level}` : t.profile);
  if (t.width && t.height) bits.push(`${t.width}x${t.height}`);
  if (t.fps) bits.push(`${t.fps}fps`);
  if (t.hdr && t.hdr !== 'sdr') bits.push(t.hdr);
  if (t.layout) bits.push(t.layout);
  if (t.sampleRate) bits.push(`${Math.round(t.sampleRate)}Hz`);
  if (t.kind !== 'video') bits.push(t.bcp47 ?? t.language);
  if (t.name) bits.push(`(${t.name})`);
  for (const [f, w] of [[t.default, 'default'], [t.forced, 'forced'], [t.hearingImpaired, 'sdh'], [t.commentary, 'commentary']] as const) if (f && (w !== 'default' || t.kind !== 'video')) bits.push(`[${w}]`);
  return bits.join(' ');
}

// ---------------------------------------------------------------- writing (for fixtures)

export type Node = { readonly id: number; readonly children: readonly Node[] } | { readonly id: number; readonly data: Buffer };

const idBytes = (id: number): Buffer => {
  const n = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[n - 1 - i] = Math.floor(id / 256 ** i) & 0xff;
  return b;
};

export function sizeBytes(n: number, minLen = 1): Buffer {
  let len = Math.max(minLen, 1);
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const b = Buffer.alloc(len);
  let v = BigInt(n) | (1n << BigInt(7 * len));
  for (let i = len - 1; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

export function encode(n: Node, o: { unknownSize?: boolean } = {}): Buffer {
  const body = 'data' in n ? n.data : Buffer.concat(n.children.map((c) => encode(c)));
  return Buffer.concat([idBytes(n.id), o.unknownSize ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : sizeBytes(body.length), body]);
}

const U = (id: number, v: number | bigint): Node => {
  let x = BigInt(v);
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(x & 0xffn));
    x >>= 8n;
  } while (x > 0n);
  return { id, data: Buffer.from(bytes) };
};
const S = (id: number, s: string): Node => ({ id, data: Buffer.from(s, 'utf8') });
const F = (id: number, v: number): Node => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return { id, data: b };
};
const M = (id: number, ...children: (Node | undefined)[]): Node => ({ id, children: children.filter((c): c is Node => c !== undefined) });

export interface WriteTrack {
  readonly number: number;
  readonly kind: 'video' | 'audio' | 'subtitle';
  readonly codecId: string;
  readonly name?: string;
  readonly language?: string;
  readonly bcp47?: string;
  readonly default?: boolean;
  readonly forced?: boolean;
  readonly hearingImpaired?: boolean;
  readonly commentary?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly transfer?: number;
  readonly dolbyVision?: boolean;
  readonly codecPrivate?: Buffer;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly compressed?: boolean;
}

export interface WriteChapter {
  readonly startMs: number;
  readonly endMs?: number;
  readonly titles: readonly { text: string; language?: string }[];
  readonly hidden?: boolean;
  readonly children?: readonly WriteChapter[];
}

export interface WriteSpec {
  readonly docType?: 'matroska' | 'webm';
  readonly durationSec?: number;
  readonly timecodeScale?: number;
  readonly title?: string;
  readonly muxingApp?: string;
  readonly writingApp?: string;
  readonly tracks: readonly WriteTrack[];
  readonly chapters?: readonly WriteChapter[];
  readonly tags?: readonly { name: string; value: string; targetType?: number }[];
  readonly attachments?: readonly { name: string; mediaType: string; data: Buffer; description?: string }[];
  /** Put chapters, tags and attachments after the clusters, as a live mux does (the seek head still names them). */
  readonly trailing?: boolean;
  readonly clusters?: readonly number[];
  readonly unknownSizeSegment?: boolean;
}

/** A small valid file with the elements named. Clusters hold only their timecode. */
export function writeMatroska(s: WriteSpec): Buffer {
  const ch = (c: WriteChapter): Node =>
    M(ID.ChapterAtom, U(ID.ChapterUID, 1000 + c.startMs), U(ID.ChapterTimeStart, BigInt(c.startMs) * 1_000_000n), c.endMs !== undefined ? U(ID.ChapterTimeEnd, BigInt(c.endMs) * 1_000_000n) : undefined, c.hidden ? U(ID.ChapterFlagHidden, 1) : undefined,
      ...c.titles.map((t) => M(ID.ChapterDisplay, S(ID.ChapString, t.text), S(ID.ChapLanguage, t.language ?? 'eng'))), ...(c.children ?? []).map(ch));
  const track = (t: WriteTrack): Node =>
    M(ID.TrackEntry, U(ID.TrackNumber, t.number), U(ID.TrackUID, 5000 + t.number), U(ID.TrackType, t.kind === 'video' ? 1 : t.kind === 'audio' ? 2 : 17),
      t.default === false ? U(ID.FlagDefault, 0) : undefined, t.forced ? U(ID.FlagForced, 1) : undefined, t.hearingImpaired ? U(ID.FlagHearingImpaired, 1) : undefined, t.commentary ? U(ID.FlagCommentary, 1) : undefined,
      t.fps ? U(ID.DefaultDuration, Math.round(1e9 / t.fps)) : undefined, t.name ? S(ID.Name, t.name) : undefined, t.language ? S(ID.Language, t.language) : undefined, t.bcp47 ? S(ID.LanguageBCP47, t.bcp47) : undefined,
      S(ID.CodecID, t.codecId), t.codecPrivate ? { id: ID.CodecPrivate, data: t.codecPrivate } : undefined,
      t.kind === 'video' ? M(ID.Video, U(ID.PixelWidth, t.width ?? 0), U(ID.PixelHeight, t.height ?? 0), t.transfer !== undefined ? M(ID.Colour, U(ID.BitsPerChannel, 10), U(ID.TransferCharacteristics, t.transfer)) : undefined) : undefined,
      t.kind === 'audio' ? M(ID.Audio, F(ID.SamplingFrequency, t.sampleRate ?? 48000), U(ID.Channels, t.channels ?? 2)) : undefined,
      t.dolbyVision ? M(ID.BlockAdditionMapping, U(ID.BlockAddIDType, 0x64767643), S(ID.BlockAddIDName, 'Dolby Vision configuration')) : undefined,
      t.compressed ? M(ID.ContentEncodings, M(ID.ContentEncoding, M(ID.ContentCompression, U(0x4254, 3)))) : undefined);
  const info = M(ID.Info, U(ID.TimecodeScale, s.timecodeScale ?? 1_000_000), s.durationSec !== undefined ? F(ID.Duration, (s.durationSec * 1e9) / (s.timecodeScale ?? 1_000_000)) : undefined, s.title ? S(ID.Title, s.title) : undefined, S(ID.MuxingApp, s.muxingApp ?? 'twin-mux'), S(ID.WritingApp, s.writingApp ?? 'twin-mux'));
  const tracks = M(ID.Tracks, ...s.tracks.map(track));
  const chapters = s.chapters ? M(ID.Chapters, M(ID.EditionEntry, U(ID.EditionUID, 1), U(ID.EditionFlagDefault, 1), ...s.chapters.map(ch))) : undefined;
  const tags = s.tags?.length ? M(ID.Tags, M(ID.Tag, M(ID.Targets, U(ID.TargetTypeValue, s.tags[0]!.targetType ?? 50)), ...s.tags.map((t) => M(ID.SimpleTag, S(ID.TagName, t.name), S(ID.TagString, t.value))))) : undefined;
  const atts = s.attachments?.length ? M(ID.Attachments, ...s.attachments.map((a, i) => M(ID.AttachedFile, a.description ? S(ID.FileDescription, a.description) : undefined, S(ID.FileName, a.name), S(ID.FileMediaType, a.mediaType), { id: ID.FileData, data: a.data }, U(ID.FileUID, 9000 + i)))) : undefined;
  const clusters = (s.clusters ?? [0]).map((tc) => M(ID.Cluster, U(ID.ClusterTimecode, tc)));
  const ebml = encode(M(ID.EBML, U(ID.EBMLVersion, 1), S(ID.DocType, s.docType ?? 'matroska'), U(ID.DocTypeVersion, 4), U(ID.DocTypeReadVersion, 2)));
  const front = [info, tracks, ...(s.trailing ? [] : [chapters, tags, atts])].filter((n): n is Node => n !== undefined);
  const back = s.trailing ? [chapters, tags, atts].filter((n): n is Node => n !== undefined) : [];
  const frontB = front.map((n) => encode(n));
  const clusterB = clusters.map((n) => encode(n));
  const backB = back.map((n) => encode(n));
  const names = (nodes: Node[]) => nodes.map((n) => n.id);
  // The seek head's own size does not depend on the positions' values when positions are written with 4 bytes.
  const seekFor = (offsets: number[]) =>
    M(ID.SeekHead, ...[...names(front), ...(clusters.length ? [ID.Cluster] : []), ...names(back)].map((id, i) => M(ID.Seek, { id: ID.SeekID, data: idBytes(id) }, { id: ID.SeekPosition, data: Buffer.from([(offsets[i]! >>> 24) & 255, (offsets[i]! >>> 16) & 255, (offsets[i]! >>> 8) & 255, offsets[i]! & 255]) })));
  const seekSize = encode(seekFor(Array(front.length + (clusters.length ? 1 : 0) + back.length).fill(0))).length;
  const offsets: number[] = [];
  let pos = seekSize;
  for (const b of frontB) {
    offsets.push(pos);
    pos += b.length;
  }
  if (clusters.length) offsets.push(pos);
  for (const b of clusterB) pos += b.length;
  for (const b of backB) {
    offsets.push(pos);
    pos += b.length;
  }
  const body = Buffer.concat([encode(seekFor(offsets)), ...frontB, ...clusterB, ...backB]);
  const segment = s.unknownSizeSegment ? Buffer.concat([idBytes(ID.Segment), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), body]) : Buffer.concat([idBytes(ID.Segment), sizeBytes(body.length, 4), body]);
  return Buffer.concat([ebml, segment]);
}
