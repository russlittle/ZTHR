/**
 * Decides how to serve a media file to a particular player, and writes the ffmpeg command for it as an argument list.
 *
 * The decision follows the order a media server (Jellyfin, Plex, Immich's video path) uses: DIRECT PLAY when the
 * container, the video, the audio, the bitrate and the subtitles are all things the device takes as they are; REMUX
 * (Jellyfin's "direct stream") when the video can be copied but the container or the audio must change; TRANSCODE when
 * the video itself must be re-encoded (codec, profile, level, resolution, frame rate, bit depth, HDR, or a bitrate
 * above what the connection allows) or subtitles must be burned in. Every step gives its reasons as stable codes with a
 * plain sentence, so a UI can say why, and so tests can pin them.
 *
 * Device profiles say what a player supports (video codecs with the highest profile, level, size, frame rate and bit
 * depth; audio codecs with channel limits; containers; subtitle formats; HLS). A few common ones are provided. Media
 * information comes from the iso-bmff-probe block (`mediaFromProbe`) or is given by hand.
 *
 * ffmpeg arguments are returned as an array, never a shell string: nothing is ever interpreted by a shell. A path that
 * begins with `-` is refused (it would be read as an option), local paths get the `file:` prefix so ffmpeg cannot be
 * steered to `concat:` or `http:` inputs, and text going into a filter graph is escaped. The bitrate ladder reuses the
 * hls-dash block's ladder, capped to the device and the connection.
 *
 * Out of scope: running ffmpeg, probing with ffprobe, hardware detection (the caller says which encoder family to use),
 * and per-title encoding.
 */
import { buildLadder } from '../hls-dash/index.ts';
import type { Rung } from '../hls-dash/index.ts';
import type { Probe } from '../iso-bmff-probe/index.ts';

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'vp8' | 'mpeg4';
export type AudioCodec = 'aac' | 'mp3' | 'opus' | 'ac3' | 'eac3' | 'flac' | 'alac' | 'vorbis';
export type Container = 'mp4' | 'mov' | 'webm' | 'mkv' | 'ts';
export type SubtitleFormat = 'webvtt' | 'srt' | 'ass' | 'pgs' | 'mov_text';

export interface VideoSupport {
  readonly codec: VideoCodec;
  /** h264: baseline < main < high. Others: not checked. */
  readonly maxProfile?: 'baseline' | 'main' | 'high';
  /** Level times ten for h264 (41 = 4.1), level times thirty for hevc (120 = 4.0). */
  readonly maxLevel?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxFps?: number;
  /** Highest bit depth: 8 or 10. Default 8. */
  readonly maxBitDepth?: number;
}
export interface AudioSupport {
  readonly codec: AudioCodec;
  readonly maxChannels?: number;
}
export interface DeviceProfile {
  readonly name: string;
  readonly containers: readonly Container[];
  readonly video: readonly VideoSupport[];
  readonly audio: readonly AudioSupport[];
  readonly subtitles: readonly SubtitleFormat[];
  /** The container that HLS segments are made in, or none when the device cannot play HLS. */
  readonly hls?: 'fmp4' | 'ts';
  readonly hdr?: boolean;
  /** Video bitrate the device can decode, bits per second. */
  readonly maxBitrate?: number;
}

export const PROFILES: Readonly<Record<string, DeviceProfile>> = {
  'chrome': {
    name: 'chrome', containers: ['mp4', 'webm'], hls: 'fmp4', hdr: false,
    video: [{ codec: 'h264', maxProfile: 'high', maxLevel: 52, maxBitDepth: 8 }, { codec: 'vp9', maxBitDepth: 10 }, { codec: 'av1', maxBitDepth: 10 }, { codec: 'vp8' }],
    audio: [{ codec: 'aac', maxChannels: 6 }, { codec: 'mp3', maxChannels: 2 }, { codec: 'opus', maxChannels: 8 }, { codec: 'flac', maxChannels: 8 }, { codec: 'vorbis', maxChannels: 2 }],
    subtitles: ['webvtt'],
  },
  'safari': {
    name: 'safari', containers: ['mp4', 'mov'], hls: 'fmp4', hdr: true,
    video: [{ codec: 'h264', maxProfile: 'high', maxLevel: 52, maxBitDepth: 8 }, { codec: 'hevc', maxBitDepth: 10 }],
    audio: [{ codec: 'aac', maxChannels: 6 }, { codec: 'mp3', maxChannels: 2 }, { codec: 'ac3', maxChannels: 6 }, { codec: 'eac3', maxChannels: 8 }, { codec: 'alac', maxChannels: 2 }, { codec: 'flac', maxChannels: 8 }],
    subtitles: ['webvtt', 'mov_text'],
  },
  'android-tv-basic': {
    name: 'android-tv-basic', containers: ['mp4', 'mkv', 'ts'], hls: 'ts',
    video: [{ codec: 'h264', maxProfile: 'high', maxLevel: 41, maxWidth: 1920, maxHeight: 1080, maxFps: 60, maxBitDepth: 8 }],
    audio: [{ codec: 'aac', maxChannels: 6 }, { codec: 'mp3', maxChannels: 2 }, { codec: 'ac3', maxChannels: 6 }],
    subtitles: ['srt', 'webvtt'], maxBitrate: 20_000_000,
  },
  'chromecast': {
    name: 'chromecast', containers: ['mp4', 'webm'], hls: 'fmp4',
    video: [{ codec: 'h264', maxProfile: 'high', maxLevel: 42, maxWidth: 1920, maxHeight: 1080, maxFps: 60, maxBitDepth: 8 }, { codec: 'vp9', maxWidth: 1920, maxHeight: 1080 }],
    audio: [{ codec: 'aac', maxChannels: 2 }, { codec: 'mp3', maxChannels: 2 }, { codec: 'opus', maxChannels: 2 }],
    subtitles: ['webvtt'], maxBitrate: 12_000_000,
  },
};

// ------------------------------------------------------------------------------------------------ media

export interface MediaVideo {
  readonly codec: VideoCodec;
  readonly profile?: 'baseline' | 'main' | 'high';
  /** Same scale as VideoSupport.maxLevel. */
  readonly level?: number;
  readonly width: number;
  readonly height: number;
  readonly fps?: number;
  readonly bitrate?: number;
  readonly bitDepth?: number;
  readonly hdr?: boolean;
  /** Degrees to turn for display (the container says so; a transcode bakes it in). */
  readonly rotation?: 0 | 90 | 180 | 270;
}
export interface MediaAudio {
  readonly codec: AudioCodec;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly bitrate?: number;
  readonly language?: string;
}
export interface MediaSubtitle {
  readonly format: SubtitleFormat;
  readonly language?: string;
}
export interface MediaInfo {
  readonly container: Container;
  readonly durationSeconds?: number;
  readonly video?: MediaVideo;
  readonly audio: readonly MediaAudio[];
  readonly subtitles: readonly MediaSubtitle[];
}

function targetBitrate(v: MediaVideo, cap: number): number {
  const wanted = v.bitrate ?? 8_000_000;
  return Math.round(Number.isFinite(cap) ? Math.min(cap, wanted) : wanted);
}

const PROFILE_RANK = { baseline: 0, main: 1, high: 2 } as const;

/** Turn what the iso-bmff-probe block found into media information. Codec strings give the h264 profile and level. */
export function mediaFromProbe(p: Probe): MediaInfo {
  const brands = [p.majorBrand ?? '', ...p.brands];
  const container: Container = brands.some((b) => b === 'qt  ') ? 'mov' : 'mp4';
  const v = p.tracks.find((t) => t.kind === 'video' && t.enabled) ?? p.tracks.find((t) => t.kind === 'video');
  let video: MediaVideo | undefined;
  if (v && v.width && v.height) {
    const cs = v.codecString ?? '';
    const codec: VideoCodec | undefined = v.codec === 'avc1' || v.codec === 'avc3' ? 'h264' : v.codec === 'hvc1' || v.codec === 'hev1' ? 'hevc' : v.codec === 'av01' ? 'av1' : v.codec === 'vp09' ? 'vp9' : v.codec === 'mp4v' ? 'mpeg4' : undefined;
    if (!codec) throw new PlanError(`video codec "${v.codec ?? 'unknown'}" is not one this planner knows`);
    let profile: MediaVideo['profile'];
    let level: number | undefined;
    let bitDepth: number | undefined = 8;
    const avc = /^avc[13]\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(cs);
    if (avc) {
      const pi = parseInt(avc[1] as string, 16);
      profile = pi === 0x42 || pi === 0x2c ? 'baseline' : pi === 0x4d ? 'main' : 'high';
      bitDepth = pi === 0x6e || pi === 0x7a || pi === 0xf4 ? 10 : 8;
      level = parseInt(avc[3] as string, 16);
    }
    const hvc = /^hvc1\.[A-C]?(\d+)\.[0-9A-F]+\.[LH](\d+)/.exec(cs);
    if (hvc) {
      bitDepth = Number(hvc[1]) === 2 ? 10 : 8; // general_profile_idc 2 is Main 10
      level = Number(hvc[2]);
    }
    const av = /^av01\.\d\.\d+[MH]\.(\d+)/.exec(cs);
    if (av) bitDepth = Number(av[1]);
    video = {
      codec, ...(profile ? { profile } : {}), ...(level !== undefined ? { level } : {}), width: v.width, height: v.height,
      ...(v.frameRate ? { fps: v.frameRate } : {}), ...(v.bitrate ? { bitrate: v.bitrate } : {}), ...(bitDepth ? { bitDepth } : {}), rotation: v.rotation,
    };
  }
  const audio: MediaAudio[] = [];
  for (const t of p.tracks.filter((x) => x.kind === 'audio')) {
    const codec: AudioCodec | undefined = t.codec === 'mp4a' ? (t.codecString?.startsWith('mp4a.6B') || t.codecString?.startsWith('mp4a.69') ? 'mp3' : 'aac') : t.codec === 'Opus' ? 'opus' : t.codec === 'ac-3' ? 'ac3' : t.codec === 'ec-3' ? 'eac3' : t.codec === 'fLaC' ? 'flac' : t.codec === 'alac' ? 'alac' : undefined;
    if (codec) audio.push({ codec, ...(t.channels ? { channels: t.channels } : {}), ...(t.sampleRate ? { sampleRate: t.sampleRate } : {}), ...(t.bitrate ? { bitrate: t.bitrate } : {}), ...(t.language ? { language: t.language } : {}) });
  }
  return { container, ...(p.durationSeconds !== undefined ? { durationSeconds: p.durationSeconds } : {}), ...(video ? { video } : {}), audio, subtitles: [] };
}

// ------------------------------------------------------------------------------------------------ decision

export type ReasonCode =
  | 'ContainerNotSupported' | 'VideoCodecNotSupported' | 'VideoProfileNotSupported' | 'VideoLevelTooHigh' | 'VideoResolutionTooHigh'
  | 'VideoFramerateTooHigh' | 'VideoBitDepthNotSupported' | 'VideoBitrateTooHigh' | 'HdrNotSupported'
  | 'AudioCodecNotSupported' | 'AudioChannelsNotSupported' | 'SubtitleNotSupported' | 'NoAudioTrack' | 'ForcedTranscode';

const SENTENCE: Record<ReasonCode, string> = {
  ContainerNotSupported: 'the container is not one this device plays',
  VideoCodecNotSupported: 'the video codec is not supported by this device',
  VideoProfileNotSupported: 'the video profile is above what this device decodes',
  VideoLevelTooHigh: 'the video level is above what this device decodes',
  VideoResolutionTooHigh: 'the picture is larger than this device can show',
  VideoFramerateTooHigh: 'the frame rate is above what this device decodes',
  VideoBitDepthNotSupported: 'the bit depth is not supported by this device',
  VideoBitrateTooHigh: 'the video bitrate is above what the connection or device allows',
  HdrNotSupported: 'the picture is HDR and this device cannot show it',
  AudioCodecNotSupported: 'the audio codec is not supported by this device',
  AudioChannelsNotSupported: 'the audio has more channels than this device takes',
  SubtitleNotSupported: 'the chosen subtitle format cannot be shown by this device, so it is burned into the picture',
  NoAudioTrack: 'there is no audio track to choose',
  ForcedTranscode: 'a transcode was asked for',
};

export interface Reason {
  readonly code: ReasonCode;
  readonly message: string;
}

export interface PlanOptions {
  /** Bits per second the connection allows for the whole stream. */
  readonly maxBitrate?: number;
  readonly audioIndex?: number;
  readonly subtitleIndex?: number;
  readonly forceTranscode?: boolean;
}

export type Mode = 'direct-play' | 'remux' | 'transcode';

export interface Plan {
  readonly mode: Mode;
  readonly container: Container;
  readonly videoAction: 'copy' | 'transcode' | 'none';
  readonly audioAction: 'copy' | 'transcode' | 'none';
  readonly subtitleAction: 'none' | 'external' | 'burn';
  readonly videoReasons: readonly Reason[];
  readonly audioReasons: readonly Reason[];
  readonly containerReasons: readonly Reason[];
  readonly subtitleReasons: readonly Reason[];
  /** Everything that forced a change, for display. */
  readonly reasons: readonly Reason[];
  /** The video the player receives, if transcoded: its size as shown (rotation already applied), bitrate and codec. */
  readonly target: { readonly width: number; readonly height: number; readonly videoBitrate: number; readonly codec: VideoCodec } | undefined;
  readonly audioIndex: number;
  readonly subtitleIndex: number | undefined;
  readonly media: MediaInfo;
  readonly profile: DeviceProfile;
}

const r = (code: ReasonCode): Reason => ({ code, message: SENTENCE[code] });

export function plan(media: MediaInfo, profile: DeviceProfile, options: PlanOptions = {}): Plan {
  const videoReasons: Reason[] = [];
  const audioReasons: Reason[] = [];
  const containerReasons: Reason[] = [];
  const subtitleReasons: Reason[] = [];
  const v = media.video;
  const audioIndex = options.audioIndex ?? 0;
  if (media.audio.length > 0 && (audioIndex < 0 || audioIndex >= media.audio.length)) throw new PlanError(`audio track ${audioIndex} does not exist (there are ${media.audio.length})`);
  const a = media.audio[audioIndex];
  const subIndex = options.subtitleIndex;
  if (subIndex !== undefined && (subIndex < 0 || subIndex >= media.subtitles.length)) throw new PlanError(`subtitle track ${subIndex} does not exist (there are ${media.subtitles.length})`);

  if (!profile.containers.includes(media.container)) containerReasons.push(r('ContainerNotSupported'));

  // sizes are in display orientation: ffmpeg turns the picture upright before any filter runs
  const turned = v?.rotation === 90 || v?.rotation === 270;
  const dispW = v ? (turned ? v.height : v.width) : 0;
  const dispH = v ? (turned ? v.width : v.height) : 0;
  let targetWidth = dispW;
  let targetHeight = dispH;
  let bitrateCap = Infinity;
  if (v) {
    const sup = profile.video.find((s) => s.codec === v.codec);
    if (!sup) videoReasons.push(r('VideoCodecNotSupported'));
    else {
      if (sup.maxProfile && v.profile && PROFILE_RANK[v.profile] > PROFILE_RANK[sup.maxProfile]) videoReasons.push(r('VideoProfileNotSupported'));
      if (sup.maxLevel !== undefined && v.level !== undefined && v.level > sup.maxLevel) videoReasons.push(r('VideoLevelTooHigh'));
      if ((sup.maxWidth !== undefined && dispW > sup.maxWidth) || (sup.maxHeight !== undefined && dispH > sup.maxHeight)) {
        videoReasons.push(r('VideoResolutionTooHigh'));
        const f = Math.min((sup.maxWidth ?? Infinity) / dispW, (sup.maxHeight ?? Infinity) / dispH);
        targetWidth = Math.floor((dispW * f) / 2) * 2;
        targetHeight = Math.floor((dispH * f) / 2) * 2;
      }
      if (sup.maxFps !== undefined && v.fps !== undefined && v.fps > sup.maxFps + 0.01) videoReasons.push(r('VideoFramerateTooHigh'));
      if (v.bitDepth !== undefined && v.bitDepth > (sup.maxBitDepth ?? 8)) videoReasons.push(r('VideoBitDepthNotSupported'));
    }
    if (v.hdr && !profile.hdr) videoReasons.push(r('HdrNotSupported'));
    const limit = Math.min(profile.maxBitrate ?? Infinity, options.maxBitrate ?? Infinity);
    const audioBits = a?.bitrate ?? 128_000;
    bitrateCap = Number.isFinite(limit) ? Math.max(100_000, limit - audioBits) : Infinity;
    if (v.bitrate !== undefined && v.bitrate > bitrateCap) videoReasons.push(r('VideoBitrateTooHigh'));
  }
  if (a) {
    const sup = profile.audio.find((s) => s.codec === a.codec);
    if (!sup) audioReasons.push(r('AudioCodecNotSupported'));
    else if (sup.maxChannels !== undefined && a.channels !== undefined && a.channels > sup.maxChannels) audioReasons.push(r('AudioChannelsNotSupported'));
  } else if (media.audio.length === 0 && v) {
    // a silent video is fine; nothing to decide
  }
  let subtitleAction: Plan['subtitleAction'] = 'none';
  if (subIndex !== undefined) {
    const s = media.subtitles[subIndex] as MediaSubtitle;
    if (profile.subtitles.includes(s.format)) subtitleAction = 'external';
    else {
      subtitleAction = 'burn';
      subtitleReasons.push(r('SubtitleNotSupported'));
    }
  }
  if (options.forceTranscode) videoReasons.push(r('ForcedTranscode'));

  const videoAction: Plan['videoAction'] = !v ? 'none' : videoReasons.length > 0 || subtitleAction === 'burn' ? 'transcode' : 'copy';
  const audioAction: Plan['audioAction'] = !a ? 'none' : audioReasons.length > 0 ? 'transcode' : 'copy';
  const mode: Mode = videoAction === 'transcode' ? 'transcode' : audioAction === 'transcode' || containerReasons.length > 0 ? 'remux' : 'direct-play';
  // the container written: what the device plays, preferring the source's own when it is allowed
  const container: Container = profile.containers.includes(media.container) ? media.container : (profile.containers.find((c) => c === 'mp4') ?? (profile.containers[0] as Container));
  const reasons = [...containerReasons, ...videoReasons, ...audioReasons, ...subtitleReasons];
  // keep the source codec when the device takes it and only size, rate, bitrate or colour must change; otherwise the safest the device has
  const codecFine = v !== undefined && profile.video.some((s) => s.codec === v.codec) && !videoReasons.some((x) => ['VideoCodecNotSupported', 'VideoProfileNotSupported', 'VideoLevelTooHigh', 'VideoBitDepthNotSupported'].includes(x.code));
  const targetCodec: VideoCodec = v !== undefined && codecFine ? v.codec : profile.video.some((s) => s.codec === 'h264') ? 'h264' : ((profile.video[0] as VideoSupport | undefined)?.codec ?? 'h264');
  return {
    mode, container, videoAction, audioAction, subtitleAction, videoReasons, audioReasons, containerReasons, subtitleReasons, reasons,
    target: videoAction === 'transcode' && v ? { width: targetWidth, height: targetHeight, videoBitrate: targetBitrate(v, bitrateCap), codec: targetCodec } : undefined,
    audioIndex, subtitleIndex: subIndex, media, profile,
  };
}

// ------------------------------------------------------------------------------------------------ ffmpeg

export type EncoderFamily = 'software' | 'nvenc' | 'vaapi' | 'videotoolbox';

export interface FfmpegOptions {
  /** Local file path. A leading `-` is refused. */
  readonly input: string;
  /** Output file, or for HLS the playlist path. */
  readonly output: string;
  readonly startSeconds?: number;
  readonly encoder?: EncoderFamily;
  readonly hls?: { readonly segmentSeconds: number; readonly segmentPattern: string };
  /** Path of the subtitle source for burning in (usually the input itself). */
  readonly subtitleSource?: string;
  readonly threads?: number;
}

/** Escape text for use as a value inside an ffmpeg filter graph. */
export function escapeFilterValue(s: string): string {
  if (/[\u0000-\u001f]/.test(s)) throw new PlanError('control characters cannot go in a filter');
  return s.replace(/[\\':,;\[\]=]/g, (c) => `\\${c}`);
}

function safePath(p: string, what: string): string {
  if (typeof p !== 'string' || p === '') throw new PlanError(`${what} path is empty`);
  if (p.startsWith('-')) throw new PlanError(`${what} path "${p.slice(0, 20)}" begins with "-" and would be read as an option`);
  if (/[\u0000]/.test(p)) throw new PlanError(`${what} path has a NUL byte`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) && !/^file:/.test(p) && !/^[A-Za-z]:[\\/]/.test(p)) throw new PlanError(`${what} path "${p.slice(0, 20)}" looks like a URL or protocol; give a local file path`);
  return p;
}

const ENCODERS: Record<EncoderFamily, Partial<Record<VideoCodec, string>>> = {
  software: { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1', vp9: 'libvpx-vp9', vp8: 'libvpx' },
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' },
  videotoolbox: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox' },
};
const AUDIO_ENCODER: Partial<Record<AudioCodec, string>> = { aac: 'aac', mp3: 'libmp3lame', opus: 'libopus', ac3: 'ac3', eac3: 'eac3', flac: 'flac', vorbis: 'libvorbis' };
const FORMAT: Record<Container, string> = { mp4: 'mp4', mov: 'mov', webm: 'webm', mkv: 'matroska', ts: 'mpegts' };
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

export function ffmpegArgs(p: Plan, o: FfmpegOptions): string[] {
  const input = safePath(o.input, 'input');
  const output = safePath(o.output, 'output');
  const enc = o.encoder ?? 'software';
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  if (o.startSeconds !== undefined) {
    if (!(o.startSeconds >= 0) || !Number.isFinite(o.startSeconds)) throw new PlanError('startSeconds must be zero or more');
    if (o.startSeconds > 0) args.push('-ss', String(o.startSeconds));
  }
  if (o.threads !== undefined) {
    if (!Number.isInteger(o.threads) || o.threads < 0) throw new PlanError('threads must be a whole number, zero or more');
    args.push('-threads', String(o.threads));
  }
  args.push('-i', /^file:/.test(input) || /^[A-Za-z]:[\\/]/.test(input) ? input : `file:${input}`);
  const v = p.media.video;
  if (v && p.videoAction !== 'none') args.push('-map', '0:v:0');
  if (p.audioAction !== 'none') args.push('-map', `0:a:${p.audioIndex}`);
  args.push('-sn', '-dn', '-map_metadata', '-1');

  if (v && p.videoAction === 'copy') args.push('-c:v', 'copy');
  if (v && p.videoAction === 'transcode') {
    const t = p.target as NonNullable<Plan['target']>;
    const encoder = ENCODERS[enc][t.codec];
    if (!encoder) throw new PlanError(`the ${enc} encoder family cannot make ${t.codec}`);
    const filters: string[] = [];
    if (p.subtitleAction === 'burn') {
      const src = safePath(o.subtitleSource ?? o.input, 'subtitle source');
      filters.push(`subtitles=filename=${escapeFilterValue(src)}:si=${p.subtitleIndex}`);
    }
    if (v.hdr && !p.profile.hdr) filters.push(TONEMAP);
    const quarter = v.rotation === 90 || v.rotation === 270;
    if (t.width !== (quarter ? v.height : v.width) || t.height !== (quarter ? v.width : v.height)) filters.push(`scale=${t.width}:${t.height}`);
    if (enc === 'vaapi') filters.push('format=nv12', 'hwupload');
    args.push('-c:v', encoder);
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-b:v', String(t.videoBitrate), '-maxrate', String(Math.round(t.videoBitrate * 1.5)), '-bufsize', String(t.videoBitrate * 2));
    if (enc === 'software' && (t.codec === 'h264' || t.codec === 'hevc')) args.push('-preset', 'veryfast');
    if (t.codec === 'h264') args.push('-profile:v', 'high');
    if (t.codec === 'h264' && enc !== 'vaapi') args.push('-pix_fmt', 'yuv420p');
    if (p.profile.hls !== undefined && o.hls) args.push('-g', String(Math.round(o.hls.segmentSeconds * (v.fps ?? 30))), '-sc_threshold', '0');
  }
  if (p.audioAction === 'copy') args.push('-c:a', 'copy');
  if (p.audioAction === 'transcode') {
    const a = p.media.audio[p.audioIndex] as MediaAudio;
    const first = p.profile.audio.find((s) => s.codec === 'aac') ?? (p.profile.audio[0] as AudioSupport);
    const keep = p.profile.audio.find((s) => s.codec === a.codec);
    const target = keep ?? first;
    const ae = AUDIO_ENCODER[target.codec];
    if (!ae) throw new PlanError(`no encoder is known for ${target.codec}`);
    const channels = Math.min(a.channels ?? 2, target.maxChannels ?? 2);
    args.push('-c:a', ae, '-ac', String(channels), '-b:a', String(Math.min(256_000, 64_000 * channels)));
  }
  if (o.hls) {
    if (!p.profile.hls) throw new PlanError(`the ${p.profile.name} profile cannot play HLS`);
    if (!(o.hls.segmentSeconds >= 1 && o.hls.segmentSeconds <= 30)) throw new PlanError('segmentSeconds must be between 1 and 30');
    const pattern = safePath(o.hls.segmentPattern, 'segment');
    if (!pattern.includes('%')) throw new PlanError('the segment pattern needs a counter such as seg-%05d.m4s');
    const fmp4 = p.profile.hls === 'fmp4';
    args.push('-f', 'hls', '-hls_time', String(o.hls.segmentSeconds), '-hls_playlist_type', 'vod', '-hls_segment_type', fmp4 ? 'fmp4' : 'mpegts', '-hls_segment_filename', pattern);
  } else {
    args.push('-f', FORMAT[p.container]);
    if (p.container === 'mp4' || p.container === 'mov') args.push('-movflags', '+faststart');
  }
  args.push(output);
  return args;
}

// ------------------------------------------------------------------------------------------------ ladder

/** Renditions for adaptive streaming to this device: the standard ladder, cut to what the device and connection take. */
export function ladderFor(media: MediaInfo, profile: DeviceProfile, options: { maxBitrate?: number } = {}): Rung[] {
  const v = media.video;
  if (!v) throw new PlanError('there is no video to make a ladder from');
  if (!profile.hls) throw new PlanError(`the ${profile.name} profile cannot play HLS`);
  const rot = v.rotation === 90 || v.rotation === 270;
  const sup = profile.video.find((s) => s.codec === 'h264') ?? (profile.video[0] as VideoSupport);
  let width = rot ? v.height : v.width;
  let height = rot ? v.width : v.height;
  const f = Math.min(1, (sup.maxWidth ?? Infinity) / width, (sup.maxHeight ?? Infinity) / height);
  width = Math.floor((width * f) / 2) * 2;
  height = Math.floor((height * f) / 2) * 2;
  const codec = sup.codec === 'hevc' || sup.codec === 'av1' ? sup.codec : 'h264';
  const cap = Math.min(profile.maxBitrate ?? Infinity, options.maxBitrate ?? Infinity);
  return buildLadder({
    width, height, codec, ...(v.fps ? { frameRate: Math.min(v.fps, sup.maxFps ?? v.fps) } : {}),
    ...(Number.isFinite(cap) ? { maxBitrate: Math.max(100_000, cap - 128_000) } : {}),
  }).filter((x, i) => !Number.isFinite(cap) || i === 0 || x.bandwidth <= cap);
}
