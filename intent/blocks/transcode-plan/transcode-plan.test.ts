import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probe } from '../iso-bmff-probe/index.ts';
import { escapeFilterValue, ffmpegArgs, ladderFor, mediaFromProbe, plan, PlanError, PROFILES } from './index.ts';
import type { MediaInfo } from './index.ts';

const h264 = (over: Partial<NonNullable<MediaInfo['video']>> = {}): NonNullable<MediaInfo['video']> => ({ codec: 'h264', profile: 'high', level: 40, width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, bitDepth: 8, ...over });
const media = (over: Partial<MediaInfo> = {}): MediaInfo => ({ container: 'mp4', durationSeconds: 100, video: h264(), audio: [{ codec: 'aac', channels: 2, bitrate: 128_000 }], subtitles: [], ...over });
const chrome = PROFILES['chrome']!;
const { hls: _noHls, ...chromeNoHls } = chrome;
const bare = (codec: 'hevc' | 'h264'): NonNullable<MediaInfo['video']> => ({ codec, width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, bitDepth: 8 });
const safari = PROFILES['safari']!;
const tv = PROFILES['android-tv-basic']!;
const codes = (p: ReturnType<typeof plan>) => p.reasons.map((x) => x.code);

// ------------------------------------------------------------ the decision

test('direct play when the container, video and audio are all taken as they are', () => {
  const p = plan(media(), chrome);
  assert.equal(p.mode, 'direct-play');
  assert.deepEqual([p.videoAction, p.audioAction, p.subtitleAction], ['copy', 'copy', 'none']);
  assert.deepEqual(p.reasons, []);
  assert.equal(p.target, undefined);
});

test('remux when only the container is wrong: video and audio are copied into one the device plays', () => {
  const p = plan(media({ container: 'mkv' }), chrome);
  assert.equal(p.mode, 'remux');
  assert.deepEqual(codes(p), ['ContainerNotSupported']);
  assert.equal(p.container, 'mp4');
  assert.deepEqual([p.videoAction, p.audioAction], ['copy', 'copy']);
});

test('remux when only the audio must change: the video is copied and the audio re-encoded', () => {
  const p = plan(media({ audio: [{ codec: 'ac3', channels: 6 }] }), chrome);
  assert.equal(p.mode, 'remux');
  assert.deepEqual(codes(p), ['AudioCodecNotSupported']);
  assert.deepEqual([p.videoAction, p.audioAction], ['copy', 'transcode']);
  assert.equal(plan(media({ audio: [{ codec: 'aac', channels: 8 }] }), chrome).audioReasons[0]!.code, 'AudioChannelsNotSupported');
});

test('transcode when the video codec is not supported, with the codec the device does take as the target', () => {
  const p = plan(media({ video: bare('hevc') }), chrome);
  assert.equal(p.mode, 'transcode');
  assert.deepEqual(p.videoReasons.map((x) => x.code), ['VideoCodecNotSupported']);
  assert.equal(p.target!.codec, 'h264');
  assert.equal(p.videoAction, 'transcode');
  assert.equal(plan(media({ video: h264({ codec: 'hevc' }) }), safari).mode, 'direct-play');
  assert.equal(p.reasons[0]!.message, 'the video codec is not supported by this device');
});

test('each video limit has its own reason: profile, level, size, frame rate, bit depth, HDR', () => {
  const only = (v: Partial<NonNullable<MediaInfo['video']>>, profile = tv) => plan(media({ video: h264(v) }), profile).videoReasons.map((x) => x.code);
  assert.deepEqual(only({ profile: 'high' }, { ...tv, video: [{ codec: 'h264', maxProfile: 'main' }] }), ['VideoProfileNotSupported']);
  assert.deepEqual(only({ level: 51 }), ['VideoLevelTooHigh']);
  assert.deepEqual(only({ width: 3840, height: 2160 }), ['VideoResolutionTooHigh']);
  assert.deepEqual(only({ fps: 120 }), ['VideoFramerateTooHigh']);
  assert.deepEqual(only({ bitDepth: 10 }), ['VideoBitDepthNotSupported']);
  assert.deepEqual(only({ hdr: true }), ['HdrNotSupported']);
  assert.deepEqual(only({ level: 40 }), []);
  assert.deepEqual(only({ fps: 60 }), []); // exactly at the limit is fine
});

test('a vertical phone video is judged by its displayed size, and the transcode target keeps the aspect ratio with even sides', () => {
  const p = plan(media({ video: h264({ width: 3840, height: 2160, rotation: 90 }) }), tv);
  assert.deepEqual(p.videoReasons.map((x) => x.code), ['VideoResolutionTooHigh']);
  assert.deepEqual([p.target!.width, p.target!.height], [606, 1080]); // shown upright: 2160x3840 scaled to fit 1080 high
  const a = ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/o.mp4' });
  assert.equal(a[a.indexOf('-vf') + 1], 'scale=606:1080'); // applied after the picture is turned upright
  assert.ok(p.target!.width % 2 === 0 && p.target!.height % 2 === 0);
  const landscape = plan(media({ video: h264({ width: 3840, height: 2160 }) }), tv);
  assert.deepEqual([landscape.target!.width, landscape.target!.height], [1920, 1080]);
  const odd = plan(media({ video: h264({ width: 2560, height: 1440 }) }), tv);
  assert.deepEqual([odd.target!.width, odd.target!.height], [1920, 1080]);
});

test('a bitrate above the connection or the device limit forces a transcode down to what fits, leaving room for audio', () => {
  const p = plan(media({ video: h264({ bitrate: 30_000_000 }) }), tv);
  assert.deepEqual(p.videoReasons.map((x) => x.code), ['VideoBitrateTooHigh']);
  assert.equal(p.target!.videoBitrate, 20_000_000 - 128_000);
  const slow = plan(media(), chrome, { maxBitrate: 2_000_000 });
  assert.equal(slow.mode, 'transcode');
  assert.equal(slow.target!.videoBitrate, 2_000_000 - 128_000);
  assert.equal(plan(media({ video: h264({ bitrate: 6_000_000 }) }), chrome, { maxBitrate: 8_000_000 }).mode, 'direct-play');
  assert.equal(plan(media({ video: (({ bitrate: _b, ...rest }) => rest)(h264()) }), chrome, { maxBitrate: 1_000_000 }).mode, 'direct-play'); // unknown bitrate cannot be judged
});

test('subtitles the device cannot show are burned in, which forces a transcode; ones it can show stay external', () => {
  const m = media({ subtitles: [{ format: 'ass', language: 'eng' }, { format: 'webvtt', language: 'fra' }] });
  const burn = plan(m, chrome, { subtitleIndex: 0 });
  assert.equal(burn.subtitleAction, 'burn');
  assert.equal(burn.mode, 'transcode');
  assert.deepEqual(burn.subtitleReasons.map((x) => x.code), ['SubtitleNotSupported']);
  const ext = plan(m, chrome, { subtitleIndex: 1 });
  assert.equal(ext.subtitleAction, 'external');
  assert.equal(ext.mode, 'direct-play');
  assert.equal(plan(m, chrome).subtitleAction, 'none');
  assert.throws(() => plan(m, chrome, { subtitleIndex: 5 }), /subtitle track 5 does not exist/);
});

test('audio track choice, forced transcode, silent video, and audio-only media', () => {
  const m = media({ audio: [{ codec: 'ac3', channels: 6 }, { codec: 'aac', channels: 2 }] });
  assert.equal(plan(m, chrome, { audioIndex: 0 }).audioAction, 'transcode');
  assert.equal(plan(m, chrome, { audioIndex: 1 }).audioAction, 'copy');
  assert.throws(() => plan(m, chrome, { audioIndex: 2 }), /audio track 2 does not exist/);
  assert.deepEqual(codes(plan(media(), chrome, { forceTranscode: true })), ['ForcedTranscode']);
  assert.equal(plan(media({ audio: [] }), chrome).audioAction, 'none');
  const song = plan({ container: 'mp4', audio: [{ codec: 'aac', channels: 2 }], subtitles: [] }, chrome);
  assert.deepEqual([song.mode, song.videoAction, song.audioAction], ['direct-play', 'none', 'copy']);
});

// ------------------------------------------------------------ from a probe

test('media information is read from a probe: container, codec, profile and level from the codec string', () => {
  const cat = (...parts: (Uint8Array | number[])[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out; };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const box = (t: string, ...p: (Uint8Array | number[])[]) => { const b = cat(...p); return cat(u32(8 + b.length), str(t), b); };
  const fullBox = (t: string, ...p: (Uint8Array | number[])[]) => box(t, [0, 0, 0, 0], ...p);
  const fx = (n: number) => u32(Math.round(n * 65536));
  const M = [...fx(1), ...fx(0), ...fx(0), ...fx(0), ...fx(1), ...fx(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  const entry = box('avc1', new Array(6).fill(0), u16(1), new Array(16).fill(0), u16(1280), u16(720), u32(0x480000), u32(0x480000), u32(0), u16(1), new Array(32).fill(0), u16(24), u16(0xffff), box('avcC', [1, 0x4d, 0, 0x1f, 0xff, 0xe0, 0]));
  const trak = box('trak', fullBox('tkhd', u32(0), u32(0), u32(1), u32(0), u32(2000), new Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), M, fx(1280), fx(720)),
    box('mdia', fullBox('mdhd', u32(0), u32(0), u32(1000), u32(2000), u16(0x55c4), u16(0)), fullBox('hdlr', u32(0), str('vide'), new Array(12).fill(0), [0]), box('minf', box('stbl', fullBox('stsd', u32(1), entry)))));
  const bytes = cat(box('ftyp', str('isom'), u32(0), str('isom')), box('moov', fullBox('mvhd', u32(0), u32(0), u32(1000), u32(2000), u32(65536), u16(256), new Array(10).fill(0), M, new Array(24).fill(0), u32(2)), trak), box('mdat', [0]));
  const m = mediaFromProbe(probe(bytes));
  assert.equal(m.container, 'mp4');
  assert.deepEqual({ ...m.video! }, { codec: 'h264', profile: 'main', level: 0x1f, width: 1280, height: 720, bitDepth: 8, rotation: 0 });
  assert.equal(m.durationSeconds, 2);
  assert.equal(plan(m, chrome).mode, 'direct-play');
  assert.equal(plan(m, { ...chrome, video: [{ codec: 'h264', maxProfile: 'baseline' }] }).videoReasons[0]!.code, 'VideoProfileNotSupported');
});

// ------------------------------------------------------------ ffmpeg arguments

test('direct play and remux give a stream copy, with faststart for mp4, and the input is a file: path', () => {
  const p = plan(media({ container: 'mkv' }), chrome);
  const a = ffmpegArgs(p, { input: '/media/movie.mkv', output: '/tmp/out.mp4' });
  assert.deepEqual(a, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', 'file:/media/movie.mkv', '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn', '-map_metadata', '-1', '-c:v', 'copy', '-c:a', 'copy', '-f', 'mp4', '-movflags', '+faststart', '/tmp/out.mp4']);
});

test('a transcode sets codec, bitrate, buffer, scale and pixel format, with the audio re-encoded to what the device takes', () => {
  const p = plan(media({ video: h264({ width: 3840, height: 2160, bitrate: 30_000_000 }), audio: [{ codec: 'ac3', channels: 6 }] }), tv);
  const a = ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/o.mp4', startSeconds: 90.5 });
  assert.deepEqual(a.slice(5, 8), ['-ss', '90.5', '-i']);
  const get = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(get('-c:v'), 'libx264');
  assert.equal(get('-vf'), 'scale=1920:1080');
  assert.equal(get('-b:v'), String(20_000_000 - 128_000));
  assert.equal(get('-maxrate'), String(Math.round((20_000_000 - 128_000) * 1.5)));
  assert.equal(get('-bufsize'), String((20_000_000 - 128_000) * 2));
  assert.equal(get('-pix_fmt'), 'yuv420p');
  assert.equal(get('-preset'), 'veryfast');
  assert.equal(get('-c:a'), 'copy'); // the TV takes AC-3 as it is
  assert.equal(a.includes('-ac'), false);
});

test('audio that must change goes to AAC for a device that takes it, with channels capped', () => {
  const p = plan(media({ audio: [{ codec: 'flac', channels: 8 }] }), tv);
  assert.equal(p.audioAction, 'transcode');
  const a = ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/o.mp4' });
  assert.equal(a[a.indexOf('-c:a') + 1], 'aac');
  assert.equal(a[a.indexOf('-ac') + 1], '6');
  assert.equal(a[a.indexOf('-b:a') + 1], '256000');
});

test('HDR is tone-mapped for an SDR device, hardware encoders pick their own codec names, and an impossible one is refused', () => {
  const p = plan(media({ video: h264({ codec: 'hevc', bitDepth: 10, hdr: true }) }), safari.hdr ? { ...safari, hdr: false } : safari);
  const a = ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/o.mp4' });
  assert.match(a[a.indexOf('-vf') + 1]!, /tonemap=tonemap=hable/);
  assert.equal(a[a.indexOf('-c:v') + 1], 'libx265');
  assert.equal(ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/o.mp4', encoder: 'nvenc' })[ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/o.mp4', encoder: 'nvenc' }).indexOf('-c:v') + 1], 'hevc_nvenc');
  const av1 = plan(media({ video: h264({ codec: 'av1' }) }), { ...chrome, video: [{ codec: 'av1' }] }, { maxBitrate: 1_000_000 });
  assert.throws(() => ffmpegArgs(av1, { input: '/m/a.mp4', output: '/t/o.mp4', encoder: 'videotoolbox' }), /cannot make av1/);
});

test('burned-in subtitles go through a filter with the path escaped', () => {
  const m = media({ subtitles: [{ format: 'ass' }] });
  const p = plan(m, chrome, { subtitleIndex: 0 });
  const a = ffmpegArgs(p, { input: "/m/it's: [a],b=c;.mkv", output: '/t/o.mp4' });
  assert.equal(a[a.indexOf('-vf') + 1], "subtitles=filename=/m/it\\'s\\: \\[a\\]\\,b\\=c\\;.mkv:si=0");
  assert.equal(escapeFilterValue('a:b'), 'a\\:b');
  assert.throws(() => escapeFilterValue('a\nb'), /control characters/);
});

test('HLS output names the segment type from the profile, with keyframes at the segment length', () => {
  const p = plan(media({ video: h264({ width: 3840, height: 2160, fps: 25 }) }), chrome, { forceTranscode: true });
  const a = ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/index.m3u8', hls: { segmentSeconds: 6, segmentPattern: '/t/seg-%05d.m4s' } });
  const get = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(get('-f'), 'hls');
  assert.equal(get('-hls_time'), '6');
  assert.equal(get('-hls_segment_type'), 'fmp4');
  assert.equal(get('-hls_segment_filename'), '/t/seg-%05d.m4s');
  assert.equal(get('-g'), '150');
  assert.equal(get('-sc_threshold'), '0');
  assert.equal(a.at(-1), '/t/index.m3u8');
  const tvPlan = plan(media({ video: h264({ fps: 25, codec: 'hevc' }) }), tv);
  assert.equal(ffmpegArgs(tvPlan, { input: '/m/a.mp4', output: '/t/i.m3u8', hls: { segmentSeconds: 4, segmentPattern: '/t/s%d.ts' } })[ffmpegArgs(tvPlan, { input: '/m/a.mp4', output: '/t/i.m3u8', hls: { segmentSeconds: 4, segmentPattern: '/t/s%d.ts' } }).indexOf('-hls_segment_type') + 1], 'mpegts');
  assert.throws(() => ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/i.m3u8', hls: { segmentSeconds: 0, segmentPattern: '/t/s%d.ts' } }), /between 1 and 30/);
  assert.throws(() => ffmpegArgs(p, { input: '/m/a.mp4', output: '/t/i.m3u8', hls: { segmentSeconds: 6, segmentPattern: '/t/seg.m4s' } }), /needs a counter/);
  assert.throws(() => ffmpegArgs(plan(media(), chromeNoHls), { input: '/m/a.mp4', output: '/t/i.m3u8', hls: { segmentSeconds: 6, segmentPattern: '/t/s%d.ts' } }), /cannot play HLS/);
});

test('hostile paths and options are refused: leading dash, protocols, NUL, bad start time and threads', () => {
  const p = plan(media(), chrome);
  const base = { input: '/m/a.mp4', output: '/t/o.mp4' };
  assert.throws(() => ffmpegArgs(p, { ...base, input: '-i /etc/passwd' }), /begins with "-"/);
  assert.throws(() => ffmpegArgs(p, { ...base, output: '-f' }), /begins with "-"/);
  assert.throws(() => ffmpegArgs(p, { ...base, input: 'concat:/etc/passwd|/m/a.mp4' }), /looks like a URL or protocol/);
  assert.throws(() => ffmpegArgs(p, { ...base, input: 'http://evil.example/x.mp4' }), /URL or protocol/);
  assert.throws(() => ffmpegArgs(p, { ...base, input: '/m/a\u0000.mp4' }), /NUL/);
  assert.throws(() => ffmpegArgs(p, { ...base, input: '' }), /empty/);
  assert.throws(() => ffmpegArgs(p, { ...base, startSeconds: -1 }), /zero or more/);
  assert.throws(() => ffmpegArgs(p, { ...base, startSeconds: NaN }), /zero or more/);
  assert.throws(() => ffmpegArgs(p, { ...base, threads: 1.5 }), /whole number/);
  assert.deepEqual(ffmpegArgs(p, { ...base, input: 'C:\\media\\a.mp4' }).slice(5, 7), ['-i', 'C:\\media\\a.mp4']);
  assert.deepEqual(ffmpegArgs(p, { ...base, input: 'file:/m/a.mp4' }).slice(5, 7), ['-i', 'file:/m/a.mp4']);
  assert.equal(PlanError.name, 'PlanError');
});

// ------------------------------------------------------------ ladder

test('the ladder is the standard one cut to the device: no rung above its size, none above its bitrate', () => {
  const full = ladderFor(media({ video: h264({ width: 3840, height: 2160 }) }), chrome);
  assert.deepEqual(full.map((x) => x.height), [240, 360, 480, 720, 1080, 1440, 2160]);
  const cast = ladderFor(media({ video: h264({ width: 3840, height: 2160 }) }), PROFILES['chromecast']!);
  assert.equal(cast.at(-1)!.height, 1080);
  assert.ok(cast.every((x) => x.bandwidth <= 12_000_000));
  const slow = ladderFor(media(), chrome, { maxBitrate: 3_000_000 });
  assert.deepEqual(slow.map((x) => x.height), [240, 360, 480]); // 720p peaks near 4.5 Mbit/s: above the 3 Mbit/s link
  assert.ok(slow.length >= 1);
  const rotated = ladderFor(media({ video: h264({ width: 1920, height: 1080, rotation: 90 }) }), chrome);
  assert.equal(rotated.at(-1)!.width, 1080);
  assert.throws(() => ladderFor({ container: 'mp4', audio: [], subtitles: [] }, chrome), /no video/);
  assert.throws(() => ladderFor(media(), chromeNoHls), /cannot play HLS/);
});
