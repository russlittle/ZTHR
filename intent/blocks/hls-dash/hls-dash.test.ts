import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLadder, dashLiveEdge, expandTimeline, fillTemplate, formatIsoDuration, ladderMaster, LivePlaylist, ManifestError, parseAttributes, parseIsoDuration,
  parseMasterPlaylist, parseMediaPlaylist, parseMpd, parsePlaylist, requiredVersion, segmentName, segmentUrls, validateMedia, writeMasterPlaylist, writeMediaPlaylist, writeMpd,
} from './index.ts';
import type { MediaPlaylist, Mpd } from './index.ts';

const vod = (): MediaPlaylist => ({
  kind: 'media', targetDuration: 6, mediaSequence: 0, playlistType: 'VOD', endList: true,
  segments: [{ uri: 'a.ts', duration: 6 }, { uri: 'b.ts', duration: 5.96 }, { uri: 'c.ts', duration: 2.5 }],
});

// ------------------------------------------------------------ HLS media

test('a VOD playlist is written in the shape of the RFC example, and the version follows what is used', () => {
  assert.equal(writeMediaPlaylist(vod()), [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:6,', 'a.ts', '#EXTINF:5.96,', 'b.ts', '#EXTINF:2.5,', 'c.ts', '#EXT-X-ENDLIST', '',
  ].join('\n'));
  const whole: MediaPlaylist = { ...vod(), segments: [{ uri: 'a.ts', duration: 6 }] };
  assert.equal(requiredVersion(whole), 1);
  assert.equal(requiredVersion(vod()), 3);
  assert.equal(requiredVersion({ ...vod(), segments: [{ uri: 'a.ts', duration: 6, byteRange: { length: 10, offset: 0 } }] }), 4);
  assert.equal(requiredVersion({ ...vod(), segments: [{ uri: 'a.m4s', duration: 6, map: { uri: 'init.mp4' } }] }), 6);
  assert.equal(requiredVersion({ ...vod(), segments: [{ uri: 'a.m4s', duration: 6, key: { method: 'AES-128', uri: 'k', keyFormat: 'identity' } }] }), 5);
});

test('write then parse gives the playlist back, with titles, discontinuities, keys, maps, dates and byte ranges', () => {
  // key and map are sticky: they apply to every segment after the line, so they are on all four
  const common = { map: { uri: 'init.mp4' }, key: { method: 'AES-128' as const, uri: 'https://k/1', iv: '0x00000000000000000000000000000001' } };
  const p: MediaPlaylist = {
    kind: 'media', targetDuration: 10, mediaSequence: 7, discontinuitySequence: 2, independentSegments: true, endList: false,
    segments: [
      { uri: 'a.m4s', duration: 9.009, title: 'intro', programDateTime: '2026-01-01T00:00:00.000Z', ...common },
      { uri: 'b.m4s', duration: 10, discontinuity: true, ...common },
      { uri: 'big.mp4', duration: 4, byteRange: { length: 1000, offset: 0 }, gap: true, ...common },
      { uri: 'big.mp4', duration: 4, byteRange: { length: 500, offset: 1000 }, ...common },
    ],
  };
  const text = writeMediaPlaylist(p);
  assert.equal((text.match(/#EXT-X-KEY/g) ?? []).length, 1); // sticky: written once
  assert.equal((text.match(/#EXT-X-MAP/g) ?? []).length, 1);
  assert.match(text, /#EXT-X-DISCONTINUITY-SEQUENCE:2/);
  const back = parseMediaPlaylist(text);
  assert.deepEqual({ ...back, version: undefined }, { ...p, version: undefined });
});

test('a byte range without an offset continues from the end of the previous range of the same resource', () => {
  const p = parseMediaPlaylist('#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n#EXT-X-BYTERANGE:100@50\nf.mp4\n#EXTINF:4,\n#EXT-X-BYTERANGE:30\nf.mp4\n#EXT-X-ENDLIST\n');
  assert.deepEqual(p.segments.map((s) => s.byteRange), [{ length: 100, offset: 50 }, { length: 30, offset: 150 }]);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n#EXT-X-BYTERANGE:30\nf.mp4\n'), /no offset/);
});

test('the parser takes the RFC 8216 live example, ignores unknown tags and comments, and handles CRLF and a BOM', () => {
  const text = '﻿#EXTM3U\r\n#EXT-X-TARGETDURATION:8\r\n#EXT-X-MEDIA-SEQUENCE:2680\r\n# a comment\r\n#EXT-X-FUTURE-TAG:xyz\r\n#EXTINF:7.975,\r\nhttps://priv.example.com/fileSequence2680.ts\r\n#EXTINF:7.941,\r\nhttps://priv.example.com/fileSequence2681.ts\r\n';
  const p = parseMediaPlaylist(text);
  assert.equal(p.mediaSequence, 2680);
  assert.equal(p.endList, false);
  assert.deepEqual(p.segments.map((s) => s.duration), [7.975, 7.941]);
  assert.equal(p.segments[0]!.uri, 'https://priv.example.com/fileSequence2680.ts');
});

test('the checks of RFC 8216: segment durations that round above the target, a VOD with no ENDLIST, bad numbers', () => {
  const base = vod();
  assert.deepEqual(validateMedia(base), []);
  assert.deepEqual(validateMedia({ ...base, targetDuration: 5 }), ['segment 0: duration 6 rounds above TARGETDURATION 5', 'segment 1: duration 5.96 rounds above TARGETDURATION 5']);
  assert.deepEqual(validateMedia({ ...base, segments: [{ uri: 'a.ts', duration: 6.4 }] }), []); // 6.4 rounds to 6
  assert.equal(validateMedia({ ...base, segments: [{ uri: 'a.ts', duration: 6.5 }] }).length, 1); // 6.5 rounds to 7
  assert.deepEqual(validateMedia({ ...base, endList: false }), ['a VOD playlist must end with ENDLIST']);
  assert.ok(validateMedia({ ...base, segments: [{ uri: 'a b.ts', duration: 1 }, { uri: 'x.ts', duration: 0 }] }).length >= 2);
  assert.throws(() => writeMediaPlaylist({ ...base, targetDuration: 0 }), /not valid/);
});

test('hostile or broken playlists are refused: no header, URI before EXTINF, no target, bad tags, size', () => {
  assert.throws(() => parseMediaPlaylist('#EXT-X-TARGETDURATION:4\n'), /must start with #EXTM3U/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\nseg.ts\n'), /no EXTINF/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts\n'), /TARGETDURATION is required/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4.5\n'), /whole number/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:-3,\nx.ts\n'), /bad EXTINF/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:LIVE\n'), /unknown playlist type/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=ROT13\n'), /unknown key METHOD/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:BYTERANGE="1@2"\n'), /needs a URI/);
  assert.throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PROGRAM-DATE-TIME:yesterday\n'), /PROGRAM-DATE-TIME/);
  assert.throws(() => parseMediaPlaylist(`#EXTM3U\n${'#EXT-X-FOO\n'.repeat(1)}${' '.repeat(5_000_001)}`), /too large/);
});

test('attribute lists keep commas inside quotes and refuse broken ones', () => {
  assert.deepEqual(parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720'), { BANDWIDTH: '1280000', CODECS: '"avc1.4d401f,mp4a.40.2"', RESOLUTION: '1280x720' });
  assert.throws(() => parseAttributes('NOEQUALS'), /no "="/);
  assert.throws(() => parseAttributes('A="open'), /unterminated/);
  assert.throws(() => parseAttributes('bad name=1'), /not an attribute name/);
});

// ------------------------------------------------------------ HLS master

test('a master playlist round trips with audio groups, resolutions and codecs, and a missing group is refused', () => {
  const m = {
    kind: 'master' as const, version: 6, independentSegments: true,
    renditions: [{ type: 'AUDIO' as const, groupId: 'aud', name: 'English', language: 'en', default: true, autoselect: true, uri: 'audio/en.m3u8', channels: '2' }],
    variants: [
      { uri: 'v/720.m3u8', bandwidth: 3_000_000, averageBandwidth: 2_500_000, resolution: { width: 1280, height: 720 }, codecs: 'avc1.4d401f,mp4a.40.2', frameRate: 29.97, audio: 'aud' },
      { uri: 'v/360.m3u8', bandwidth: 900_000 },
    ],
  };
  const text = writeMasterPlaylist(m);
  assert.match(text, /#EXT-X-STREAM-INF:BANDWIDTH=3000000,AVERAGE-BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=29.970,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"\nv\/720.m3u8/);
  assert.deepEqual(parseMasterPlaylist(text), m);
  assert.deepEqual(parsePlaylist(text), m);
  assert.equal(parsePlaylist(writeMediaPlaylist(vod())).kind, 'media');
  assert.throws(() => writeMasterPlaylist({ ...m, renditions: [] }), /audio group "aud" which has no EXT-X-MEDIA/);
  assert.throws(() => writeMasterPlaylist({ ...m, variants: [{ uri: 'x.m3u8', bandwidth: 0 }] }), /BANDWIDTH/);
  assert.throws(() => parseMasterPlaylist('#EXTM3U\nv.m3u8\n'), /no EXT-X-STREAM-INF/);
  assert.throws(() => parseMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:CODECS="x"\nv.m3u8\n'), /needs a BANDWIDTH/);
  assert.throws(() => parseMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=big\nv.m3u8\n'), /bad RESOLUTION/);
  assert.throws(() => parseMasterPlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=GAMES,GROUP-ID="g",NAME="n"\n'), /unknown EXT-X-MEDIA TYPE/);
});

test('a quote in a value that must be quoted is refused when writing, so a name cannot break out of its attribute', () => {
  assert.throws(() => writeMasterPlaylist({ kind: 'master', variants: [], renditions: [{ type: 'AUDIO', groupId: 'g', name: 'a",DEFAULT=YES,X="' }] }), /cannot contain a quote/);
});

// ------------------------------------------------------------ live window

test('a live playlist slides: media sequence advances as old segments leave, and ENDLIST comes only at the end', () => {
  const live = new LivePlaylist({ windowSegments: 3, targetDuration: 6 });
  assert.equal(live.range(), undefined);
  for (let i = 0; i < 5; i++) live.push({ uri: segmentName('seg', i, 'ts'), duration: 6 });
  const p = live.playlist();
  assert.equal(p.mediaSequence, 2);
  assert.deepEqual(p.segments.map((s) => s.uri), ['seg00002.ts', 'seg00003.ts', 'seg00004.ts']);
  assert.deepEqual(live.range(), { first: 2, last: 4 });
  assert.equal(p.endList, false);
  assert.equal(live.holdBackSeconds, 18);
  live.end();
  assert.equal(live.playlist().endList, true);
  assert.throws(() => live.push({ uri: 'x.ts', duration: 6 }), /has ended/);
  assert.match(writeMediaPlaylist(live.playlist()), /#EXT-X-MEDIA-SEQUENCE:2\n[\s\S]*#EXT-X-ENDLIST/);
});

test('the discontinuity sequence advances when a segment that carries a discontinuity leaves the window', () => {
  const live = new LivePlaylist({ windowSegments: 2, targetDuration: 4 });
  live.push({ uri: 'a.ts', duration: 4 });
  live.push({ uri: 'b.ts', duration: 4, discontinuity: true });
  assert.equal(live.discontinuitySequence, 0);
  live.push({ uri: 'c.ts', duration: 4 }); // a leaves: it had no discontinuity
  assert.equal(live.discontinuitySequence, 0);
  live.push({ uri: 'd.ts', duration: 4 }); // b leaves: the break before it is no longer in the playlist
  assert.equal(live.discontinuitySequence, 1);
  assert.equal(live.mediaSequence, 2);
  assert.match(writeMediaPlaylist(live.playlist()), /#EXT-X-DISCONTINUITY-SEQUENCE:1/);
});

test('a live playlist refuses a segment longer than its target and a window that makes no sense', () => {
  const live = new LivePlaylist({ windowSegments: 2, targetDuration: 4 });
  assert.throws(() => live.push({ uri: 'long.ts', duration: 6 }), /rounds above the target/);
  assert.throws(() => new LivePlaylist({ windowSegments: 0, targetDuration: 4 }), /at least 1/);
  assert.throws(() => new LivePlaylist({ windowSegments: 2, targetDuration: 0 }), /at least 1/);
});

// ------------------------------------------------------------ naming and durations

test('template identifiers with and without widths, $$ for a dollar, and refusals', () => {
  assert.equal(fillTemplate('seg-$RepresentationID$-$Number%05d$.m4s', { representationId: 'v720', number: 42 }), 'seg-v720-00042.m4s');
  assert.equal(fillTemplate('t$Time$_b$Bandwidth$', { time: 90000, bandwidth: 2800000 }), 't90000_b2800000');
  assert.equal(fillTemplate('cost$$5/$Number$.m4s', { number: 1 }), 'cost$5/1.m4s');
  assert.equal(fillTemplate('$Number%03d$', { number: 12345 }), '12345'); // width is a minimum
  assert.throws(() => fillTemplate('$Number$', {}), /needs Number/);
  assert.throws(() => fillTemplate('$RepresentationID$', {}), /needs a RepresentationID/);
  assert.throws(() => fillTemplate('$RepresentationID%05d$', { representationId: 'x' }), /takes no format/);
  assert.equal(segmentName('seg-', 7, 'm4s', 3), 'seg-007.m4s');
  assert.throws(() => segmentName('s', -1), /whole number/);
});

test('ISO 8601 durations parse and format, and years and months are refused', () => {
  assert.equal(parseIsoDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseIsoDuration('PT0.5S'), 0.5);
  assert.equal(parseIsoDuration('P1DT2H'), 93600);
  assert.equal(parseIsoDuration('PT30M'), 1800);
  for (const bad of ['P1Y', 'P1M', 'PT', 'P', '1H', 'PT1X']) assert.throws(() => parseIsoDuration(bad), ManifestError, bad);
  assert.equal(formatIsoDuration(3723.5), 'PT1H2M3.5S');
  assert.equal(formatIsoDuration(0), 'PT0S');
  assert.equal(formatIsoDuration(60), 'PT1M');
  assert.equal(parseIsoDuration(formatIsoDuration(7384.25)), 7384.25);
  assert.throws(() => formatIsoDuration(-1), /zero or more/);
});

// ------------------------------------------------------------ DASH

const staticMpd = (): Mpd => ({
  type: 'static', minBufferTime: 2, mediaPresentationDuration: 20,
  periods: [{
    id: 'p0', start: 0,
    adaptationSets: [
      { id: 1, contentType: 'video', mimeType: 'video/mp4', segmentAlignment: true,
        segmentTemplate: { timescale: 90000, duration: 360000, startNumber: 1, initialization: 'init-$RepresentationID$.mp4', media: '$RepresentationID$/seg-$Number%05d$.m4s' },
        representations: [{ id: 'v1', bandwidth: 2_800_000, codecs: 'avc1.4d401f', width: 1280, height: 720, frameRate: '30' }, { id: 'v2', bandwidth: 800_000, codecs: 'avc1.4d401e', width: 640, height: 360 }] },
      { id: 2, contentType: 'audio', mimeType: 'audio/mp4', lang: 'en',
        representations: [{ id: 'a1', bandwidth: 128_000, codecs: 'mp4a.40.2', audioSamplingRate: 48000, segmentTemplate: { timescale: 48000, startNumber: 1, media: 'a/$Time$.m4s', timeline: [{ t: 0, d: 192000, r: 4 }] } }] },
    ],
  }],
});

test('an MPD is written and read back to the same model', () => {
  const m = staticMpd();
  const xml = writeMpd(m);
  assert.match(xml, /<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-live:2011" minBufferTime="PT2S" mediaPresentationDuration="PT20S">/);
  assert.match(xml, /<S t="0" d="192000" r="4"\/>/);
  assert.deepEqual(parseMpd(xml), { ...m, profiles: 'urn:mpeg:dash:profile:isoff-live:2011' });
});

test('values with markup characters are escaped in the MPD, and cannot add attributes', () => {
  const m = staticMpd();
  const evil = { ...m, periods: [{ ...m.periods[0]!, adaptationSets: [m.periods[0]!.adaptationSets[0]!, { ...m.periods[0]!.adaptationSets[1]!, lang: 'en" onload="x' }] }] };
  const xml = writeMpd(evil);
  assert.match(xml, /lang="en&quot; onload=&quot;x"/);
  assert.equal(parseMpd(xml).periods[0]!.adaptationSets[1]!.lang, 'en" onload="x');
});

test('the MPD parser refuses DTDs and entities, other roots, and missing required parts', () => {
  assert.throws(() => parseMpd('<!DOCTYPE MPD [<!ENTITY x "y">]><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1S"/>'), /document type declarations/);
  assert.throws(() => parseMpd('<MPD minBufferTime="PT1S"/>'), /root element must be MPD/);
  assert.throws(() => parseMpd('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"/>'), /minBufferTime/);
  assert.throws(() => parseMpd('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="live" minBufferTime="PT1S"/>'), /static or dynamic/);
  assert.throws(() => parseMpd('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1S"><Period><AdaptationSet><Representation id="x"/></AdaptationSet></Period></MPD>'), /id and bandwidth/);
  assert.throws(() => parseMpd('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" minBufferTime="PT1S"><Period><AdaptationSet><SegmentTemplate media="a"><SegmentTimeline><S d="0"/></SegmentTimeline></SegmentTemplate></AdaptationSet></Period></MPD>'), /bad d, r or t/);
});

test('the writer checks the model: dynamic needs a start time, static needs a duration, duplicate ids, templates need a duration', () => {
  const m = staticMpd();
  assert.throws(() => writeMpd({ ...m, type: 'dynamic' }), /availabilityStartTime/);
  const { mediaPresentationDuration: _d, ...noDur } = m;
  assert.throws(() => writeMpd(noDur as Mpd), /static MPD needs/);
  assert.throws(() => writeMpd({ ...m, periods: [] }), /at least one period/);
  const dup = { ...m, periods: [{ ...m.periods[0]!, adaptationSets: [{ ...m.periods[0]!.adaptationSets[0]!, representations: [{ id: 'x', bandwidth: 1 }, { id: 'x', bandwidth: 2 }] }] }] };
  assert.throws(() => writeMpd(dup), /used twice/);
  const bad = { ...m, periods: [{ ...m.periods[0]!, adaptationSets: [{ representations: [{ id: 'x', bandwidth: 1, segmentTemplate: { media: 'x' } }] }] }] };
  assert.throws(() => writeMpd(bad), /needs a duration or a SegmentTimeline/);
});

test('timelines expand with r repeats, gaps by t, and r=-1 to the next entry or the period end', () => {
  const segs = expandTimeline([{ t: 0, d: 100, r: 2 }, { d: 50 }, { t: 1000, d: 200, r: 1 }], 10);
  assert.deepEqual(segs.map((s) => [s.number, s.time, s.duration]), [[10, 0, 100], [11, 100, 100], [12, 200, 100], [13, 300, 50], [14, 1000, 200], [15, 1200, 200]]);
  assert.deepEqual(expandTimeline([{ t: 0, d: 100, r: -1 }, { t: 450, d: 50 }]).map((s) => s.time), [0, 100, 200, 300, 400, 450]);
  assert.deepEqual(expandTimeline([{ t: 0, d: 100, r: -1 }], 1, 350).map((s) => s.time), [0, 100, 200, 300]);
  assert.throws(() => expandTimeline([{ d: 100, r: -1 }]), /needs the end time/);
  assert.throws(() => expandTimeline([{ d: 0 }]), /d above zero/);
  assert.throws(() => expandTimeline([{ d: 1, r: 1_000_000 }]), /more than 100000/);
});

test('segment URLs come from the template, with the init segment, whether by duration or by timeline', () => {
  const m = staticMpd();
  const as0 = m.periods[0]!.adaptationSets[0]!;
  const v = segmentUrls(as0.representations[0]!, as0.segmentTemplate, 20);
  assert.equal(v.init, 'init-v1.mp4');
  assert.equal(v.segments.length, 5); // 20 s in 4 s segments
  assert.deepEqual(v.segments[0], { url: 'v1/seg-00001.m4s', number: 1, startSeconds: 0, durationSeconds: 4 });
  assert.equal(v.segments[4]!.url, 'v1/seg-00005.m4s');
  assert.equal(v.segments[4]!.startSeconds, 16);
  const a = segmentUrls(m.periods[0]!.adaptationSets[1]!.representations[0]!, undefined);
  assert.deepEqual(a.segments.map((s) => s.url), ['a/0.m4s', 'a/192000.m4s', 'a/384000.m4s', 'a/576000.m4s', 'a/768000.m4s']);
  assert.equal(a.segments[1]!.startSeconds, 4);
  assert.throws(() => segmentUrls(as0.representations[0]!, as0.segmentTemplate), /period duration is needed/);
  assert.throws(() => segmentUrls({ id: 'x', bandwidth: 1 }, undefined), /no SegmentTemplate/);
});

test('the live edge: the newest complete segment, and the oldest still inside the time-shift buffer', () => {
  const live: Mpd = { type: 'dynamic', minBufferTime: 2, availabilityStartTime: '2026-01-01T00:00:00Z', timeShiftBufferDepth: 20, periods: [{ adaptationSets: [{ representations: [{ id: 'v', bandwidth: 1 }] }] }] };
  const t = { timescale: 1000, duration: 4000, startNumber: 1, media: 'v/$Number$.m4s' };
  const at = (s: number) => Date.parse('2026-01-01T00:00:00Z') + s * 1000;
  assert.equal(dashLiveEdge(live, t, at(3.9)), undefined); // nothing is complete yet
  assert.deepEqual(dashLiveEdge(live, t, at(4)), { latest: 1, oldest: 1, latestStartSeconds: 0 });
  assert.deepEqual(dashLiveEdge(live, t, at(50.5)), { latest: 12, oldest: 8, latestStartSeconds: 44 });
  assert.deepEqual(dashLiveEdge({ type: 'dynamic', minBufferTime: 2, availabilityStartTime: live.availabilityStartTime as string, periods: live.periods }, t, at(50.5)), { latest: 12, oldest: 1, latestStartSeconds: 44 });
  assert.deepEqual(dashLiveEdge(live, { ...t, startNumber: 100 }, at(50.5)), { latest: 111, oldest: 107, latestStartSeconds: 44 });
  assert.throws(() => dashLiveEdge(staticMpd(), t, 0), /dynamic MPD/);
  assert.throws(() => dashLiveEdge(live, { media: 'x', timeline: [{ d: 1 }] }, 0), /fixed duration/);
});

// ------------------------------------------------------------ ladder

test('a 1080p source gets five rungs from 240p up, with even widths, no upscaling, and bandwidth above the bitrate', () => {
  const l = buildLadder({ width: 1920, height: 1080 });
  assert.deepEqual(l.map((r) => [r.name, r.width, r.height, r.videoBitrate]), [
    ['240p', 426, 240, 400_000], ['360p', 640, 360, 800_000], ['480p', 854, 480, 1_400_000], ['720p', 1280, 720, 2_800_000], ['1080p', 1920, 1080, 5_000_000],
  ]);
  const top = l.at(-1)!;
  assert.equal(top.maxrate, 7_500_000);
  assert.equal(top.bufsize, 15_000_000);
  assert.equal(top.bandwidth, Math.round((7_500_000 + 128_000) * 1.05));
  assert.equal(top.averageBandwidth, Math.round((5_000_000 + 128_000) * 1.05));
  assert.equal(top.codecs, 'avc1.640028,mp4a.40.2');
  assert.ok(l.every((r) => r.width % 2 === 0 && r.height % 2 === 0));
  assert.ok(l.every((r, i) => i === 0 || r.bandwidth > l[i - 1]!.bandwidth));
});

test('codec scales bitrate, a max bitrate caps it, high frame rate raises it, and a small source is not upscaled', () => {
  assert.equal(buildLadder({ width: 3840, height: 2160, codec: 'hevc' }).at(-1)!.videoBitrate, 11_200_000);
  assert.equal(buildLadder({ width: 3840, height: 2160, codec: 'av1' }).at(-1)!.codecs, 'av01.0.12M.08,mp4a.40.2');
  assert.equal(buildLadder({ width: 1920, height: 1080, maxBitrate: 3_000_000 }).at(-1)!.videoBitrate, 3_000_000);
  assert.equal(buildLadder({ width: 1920, height: 1080, frameRate: 60 }).at(-1)!.videoBitrate, 7_000_000);
  const small = buildLadder({ width: 320, height: 180 });
  assert.deepEqual(small.map((r) => [r.width, r.height]), [[320, 180]]);
  const odd = buildLadder({ width: 1000, height: 562 });
  assert.deepEqual(odd.map((r) => r.height), [240, 360, 480, 562]);
  assert.ok(odd.at(-1)!.videoBitrate > 1_400_000 && odd.at(-1)!.videoBitrate < 2_800_000);
  assert.equal(odd.at(-1)!.width, 1000);
  assert.deepEqual(buildLadder({ width: 1920, height: 1080, includeSource: false }).map((r) => r.height), [240, 360, 480, 720, 1080]);
  assert.throws(() => buildLadder({ width: 0, height: 10 }), /whole numbers/);
});

test('the ladder becomes a master playlist that parses back, one variant per rung', () => {
  const l = buildLadder({ width: 1280, height: 720 });
  const text = writeMasterPlaylist(ladderMaster(l));
  const back = parseMasterPlaylist(text);
  assert.deepEqual(back.variants.map((v) => v.uri), ['240p/index.m3u8', '360p/index.m3u8', '480p/index.m3u8', '720p/index.m3u8']);
  assert.deepEqual(back.variants.map((v) => v.bandwidth), l.map((r) => r.bandwidth));
  assert.deepEqual(back.variants[3]!.resolution, { width: 1280, height: 720 });
  assert.equal(back.variants[0]!.frameRate, 30);
});
