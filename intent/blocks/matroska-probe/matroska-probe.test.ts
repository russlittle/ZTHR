import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatroskaError, codecName, defaultTracks, describe, encode, flatChapters, language2, probe, sizeBytes, writeMatroska } from './index.ts';
import type { WriteSpec } from './index.ts';

const AVCC = Buffer.from([1, 100, 0, 41, 0xff, 0xe1, 0, 0]);
const HVCC = Buffer.from([1, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120, 0, 0]);

const base = (o: Partial<WriteSpec> = {}): WriteSpec => ({
  durationSec: 5400.5, title: 'A Film',
  tracks: [
    { number: 1, kind: 'video', codecId: 'V_MPEG4/ISO/AVC', width: 1920, height: 1080, fps: 23.976, codecPrivate: AVCC, language: 'und' },
    { number: 2, kind: 'audio', codecId: 'A_EAC3', language: 'eng', name: 'English 5.1', channels: 6, sampleRate: 48000 },
    { number: 3, kind: 'audio', codecId: 'A_AAC', language: 'fre', default: false, channels: 2, sampleRate: 44100 },
    { number: 4, kind: 'audio', codecId: 'A_AAC', language: 'eng', default: false, commentary: true, channels: 2 },
    { number: 5, kind: 'subtitle', codecId: 'S_TEXT/UTF8', language: 'eng', default: false },
    { number: 6, kind: 'subtitle', codecId: 'S_HDMV/PGS', language: 'fre', default: false, forced: true },
    { number: 7, kind: 'subtitle', codecId: 'S_TEXT/ASS', language: 'eng', default: false, hearingImpaired: true, bcp47: 'en-GB' },
  ],
  ...o,
});

test('EBML header, info and the duration in seconds', () => {
  const p = probe(writeMatroska(base()));
  assert.deepEqual([p.docType, p.isWebm, p.docTypeVersion], ['matroska', false, 4]);
  assert.equal(p.info.title, 'A Film');
  assert.equal(p.info.timecodeScale, 1_000_000);
  assert.equal(p.info.muxingApp, 'twin-mux');
  assert.equal(p.durationSec, 5400.5);
  assert.equal(p.durationEstimated, false);
  assert.deepEqual(p.warnings, []);
  const scaled = probe(writeMatroska(base({ timecodeScale: 100_000, durationSec: 90 })));
  assert.equal(scaled.info.timecodeScale, 100_000);
  assert.equal(scaled.durationSec, 90);
  assert.equal(probe(writeMatroska(base({ docType: 'webm' }))).isWebm, true);
});

test('tracks: kinds, codecs, languages, flags, sizes, rates, layouts', () => {
  const p = probe(writeMatroska(base()));
  assert.deepEqual(p.tracks.map((t) => [t.number, t.kind, t.codec]), [[1, 'video', 'h264'], [2, 'audio', 'eac3'], [3, 'audio', 'aac'], [4, 'audio', 'aac'], [5, 'subtitle', 'srt'], [6, 'subtitle', 'pgs'], [7, 'subtitle', 'ass']]);
  const v = p.tracks[0]!;
  assert.deepEqual([v.width, v.height, v.fps, v.profile, v.level, v.hdr, v.language], [1920, 1080, 23.976, 'high', '4.1', 'sdr', 'und']);
  const a = p.tracks[1]!;
  assert.deepEqual([a.channels, a.layout, a.sampleRate, a.name, a.default, a.language], [6, '5.1', 48000, 'English 5.1', true, 'eng']);
  assert.equal(p.tracks[2]!.default, false);
  assert.equal(p.tracks[3]!.commentary, true);
  assert.deepEqual(p.tracks.slice(4).map((t) => t.subtitleKind), ['text', 'bitmap', 'text']);
  assert.equal(p.tracks[5]!.forced, true);
  assert.equal(p.tracks[6]!.hearingImpaired, true);
  assert.equal(p.tracks[6]!.bcp47, 'en-GB');
  assert.equal(p.tracks[0]!.uid, '5001');
});

test('a track with no language says "eng", as the format does', () => {
  const p = probe(writeMatroska({ tracks: [{ number: 1, kind: 'audio', codecId: 'A_OPUS' }] }));
  assert.equal(p.tracks[0]!.language, 'eng');
  assert.equal(p.tracks[0]!.layout, 'stereo');
});

test('HDR verdicts: PQ, HLG, Dolby Vision, plain', () => {
  const hdr = (extra: object) => probe(writeMatroska({ tracks: [{ number: 1, kind: 'video', codecId: 'V_MPEGH/ISO/HEVC', width: 3840, height: 2160, codecPrivate: HVCC, ...extra }] })).tracks[0]!;
  assert.equal(hdr({ transfer: 16 }).hdr, 'hdr10');
  assert.equal(hdr({ transfer: 18 }).hdr, 'hlg');
  assert.equal(hdr({ transfer: 16, dolbyVision: true }).hdr, 'dolby-vision');
  assert.equal(hdr({ transfer: 1 }).hdr, 'sdr');
  assert.equal(hdr({}).hdr, 'sdr');
  assert.deepEqual([hdr({}).profile, hdr({}).level], ['main10', 'main 4']);
  assert.equal(hdr({ transfer: 16 }).colour?.bitsPerChannel, 10);
  assert.equal(hdr({ transfer: 16 }).colour?.transfer, 16);
});

test('chapters: nested, languages, hidden, ends, sorted flat list', () => {
  const p = probe(writeMatroska(base({
    chapters: [
      { startMs: 0, titles: [{ text: 'Opening', language: 'eng' }, { text: 'Ouverture', language: 'fre' }], children: [{ startMs: 30_000, titles: [{ text: 'Credits' }] }] },
      { startMs: 600_000, endMs: 1_200_000, titles: [{ text: 'Act 1' }] },
      { startMs: 700_000, titles: [{ text: 'Secret' }], hidden: true },
      { startMs: 3_600_000, titles: [{ text: 'Act 2 – Fin' }] },
    ],
  })));
  assert.equal(p.editions.length, 1);
  assert.equal(p.editions[0]!.default, true);
  assert.deepEqual(p.editions[0]!.chapters[0]!.titles, [{ text: 'Opening', language: 'eng' }, { text: 'Ouverture', language: 'fre' }]);
  const flat = flatChapters(p);
  assert.deepEqual(flat.map((c) => [c.startMs, c.endMs, c.title, c.depth]), [[0, 30_000, 'Opening', 0], [30_000, 600_000, 'Credits', 1], [600_000, 1_200_000, 'Act 1', 0], [3_600_000, 5_400_500, 'Act 2 – Fin', 0]]);
  assert.equal(flatChapters(p, { language: 'fr' })[0]!.title, 'Ouverture');
  assert.equal(flatChapters(p, { language: 'de' })[0]!.title, 'Opening');
  assert.deepEqual(flatChapters(probe(writeMatroska(base()))), []);
});

test('tags and attachments', () => {
  const p = probe(writeMatroska(base({
    tags: [{ name: 'TITLE', value: 'A Film' }, { name: 'DIRECTOR', value: 'Someone' }],
    attachments: [{ name: 'cover.jpg', mediaType: 'image/jpeg', data: Buffer.alloc(1234), description: 'front' }, { name: 'Arial.ttf', mediaType: 'application/x-truetype-font', data: Buffer.alloc(10) }, { name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('x') }],
  })));
  assert.deepEqual(p.tags.map((t) => [t.name, t.value, t.targetType]), [['TITLE', 'A Film', 50], ['DIRECTOR', 'Someone', 50]]);
  assert.deepEqual(p.attachments.map((a) => [a.name, a.size, a.cover, a.font]), [['cover.jpg', 1234, true, false], ['Arial.ttf', 10, false, true], ['notes.txt', 1, false, false]]);
  assert.equal(p.attachments[0]!.description, 'front');
});

test('the seek head positions point at the elements', () => {
  const buf = writeMatroska(base({ chapters: [{ startMs: 0, titles: [{ text: 'x' }] }] }));
  const p = probe(buf);
  assert.equal(buf.readUInt32BE(p.seek.Tracks!), 0x1654ae6b);
  assert.equal(buf.readUInt32BE(p.seek.Info!), 0x1549a966);
  assert.equal(buf.readUInt32BE(p.seek.Chapters!), 0x1043a770);
  assert.equal(p.seek.Cluster, p.firstCluster);
  assert.equal(buf.readUInt32BE(p.firstCluster!), 0x1f43b675);
});

test('parts after the clusters: a short read says what is missing, a full read has it', () => {
  const full = writeMatroska(base({ trailing: true, chapters: [{ startMs: 0, titles: [{ text: 'One' }] }], tags: [{ name: 'A', value: 'b' }] }));
  const whole = probe(full);
  assert.deepEqual([whole.missing, whole.editions.length, whole.tags.length, whole.needBytes], [[], 1, 1, undefined]);
  const head = full.subarray(0, whole.firstCluster! + 20);
  const part = probe(head, { fileSize: full.length });
  assert.deepEqual(part.missing, ['Chapters', 'Tags']);
  assert.equal(part.editions.length, 0);
  assert.equal(part.tracks.length, 7);
  assert.ok(part.needBytes! > head.length);
  assert.ok(part.needBytes! <= full.length);
  assert.equal(probe(full.subarray(0, part.needBytes!)).editions.length, 1);
});

test('unknown-size segments (live muxes) read to the end of the buffer', () => {
  const p = probe(writeMatroska(base({ unknownSizeSegment: true })));
  assert.equal(p.tracks.length, 7);
  assert.equal(p.durationSec, 5400.5);
});

test('without a duration field, the last cluster gives an estimate', () => {
  const p = probe(writeMatroska({ tracks: base().tracks, clusters: [0, 5000, 10_000, 62_000] }));
  assert.equal(p.durationSec, 62);
  assert.equal(p.durationEstimated, true);
  assert.equal(probe(writeMatroska({ tracks: base().tracks })).durationSec, undefined);
});

test('content compression is reported; a track without a number is skipped with a warning', () => {
  const p = probe(writeMatroska({ tracks: [{ number: 1, kind: 'video', codecId: 'V_VP9', width: 640, height: 360, compressed: true }] }));
  assert.deepEqual([p.tracks[0]!.compressed, p.tracks[0]!.encrypted, p.tracks[0]!.codec], [true, false, 'vp9']);
  const noNum = Buffer.concat([encode({ id: 0x1a45dfa3, children: [{ id: 0x4282, data: Buffer.from('matroska') }] }), Buffer.from([0x18, 0x53, 0x80, 0x67]), sizeBytes(30, 4), encode({ id: 0x1654ae6b, children: [{ id: 0xae, children: [{ id: 0x86, data: Buffer.from('V_AV1') }] }] })]);
  const q = probe(noNum);
  assert.equal(q.tracks.length, 0);
  assert.match(q.warnings.join(), /no number/);
});

test('refusals: not EBML, wrong document type, no segment, empty', () => {
  assert.throws(() => probe(Buffer.from('RIFF....AVI ')), MatroskaError);
  assert.throws(() => probe(Buffer.alloc(0)), MatroskaError);
  assert.throws(() => probe(Buffer.alloc(100)), MatroskaError);
  assert.throws(() => probe(writeMatroska(base()).subarray(0, 30)), /no segment/);
  const odd = encode({ id: 0x1a45dfa3, children: [{ id: 0x4282, data: Buffer.from('video/mp4') }] });
  assert.throws(() => probe(odd), /not matroska or webm/);
});

test('limits: element count and nesting depth stop a hostile file', () => {
  const buf = writeMatroska(base({ chapters: Array.from({ length: 50 }, (_, i) => ({ startMs: i * 1000, titles: [{ text: `c${i}` }] })) }));
  assert.throws(() => probe(buf, { maxElements: 100 }), /more than 100 elements/);
  type N = Parameters<typeof encode>[0];
  let nest: N = { id: 0xb6, children: [{ id: 0x91, data: Buffer.from([0]) }] };
  for (let i = 0; i < 40; i++) nest = { id: 0xb6, children: [nest] };
  const chapters = encode({ id: 0x1043a770, children: [{ id: 0x45b9, children: [nest] }] });
  const seg = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67]), sizeBytes(chapters.length, 4), chapters]);
  const ebml = encode({ id: 0x1a45dfa3, children: [{ id: 0x4282, data: Buffer.from('matroska') }] });
  const p = probe(Buffer.concat([ebml, seg]));
  assert.match(p.warnings.join(), /nested too deeply/);
});

test('damaged files never crash the reader: 600 random corruptions', () => {
  const good = writeMatroska(base({ chapters: [{ startMs: 0, titles: [{ text: 'a' }], children: [{ startMs: 5, titles: [{ text: 'b' }] }] }], tags: [{ name: 'A', value: 'b' }], attachments: [{ name: 'c.jpg', mediaType: 'image/jpeg', data: Buffer.alloc(50) }], trailing: true }));
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  let refused = 0;
  const t0 = Date.now();
  for (let i = 0; i < 600; i++) {
    const b = Buffer.from(good);
    for (let k = 0, n = 1 + rnd(8); k < n; k++) b[rnd(b.length)] = rnd(256);
    const cut = rnd(4) === 0 ? b.subarray(0, rnd(b.length)) : b;
    try {
      const p = probe(cut);
      assert.ok(p.tracks.every((t) => Number.isInteger(t.number)));
    } catch (e) {
      assert.ok(e instanceof MatroskaError, String(e));
      refused++;
    }
  }
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(refused < 600);
});

test('vint sizes: every length from 1 to 8 bytes reads back', () => {
  for (const n of [0, 1, 126, 127, 128, 16_382, 16_383, 2 ** 21, 2 ** 28, 2 ** 35]) {
    const b = sizeBytes(n);
    assert.ok(b.length >= 1 && b.length <= 8);
    assert.equal(b[0]! >> (8 - b.length), 1, `${n} marker`);
  }
  const bigSize = encode({ id: 0x7ba9, data: Buffer.from('T') });
  assert.equal(bigSize.length, 4);
  const wide = Buffer.concat([Buffer.from([0x7b, 0xa9, 0x01, 0, 0, 0, 0, 0, 0, 1]), Buffer.from('T')]);
  const file = Buffer.concat([encode({ id: 0x1a45dfa3, children: [{ id: 0x4282, data: Buffer.from('webm') }] }), Buffer.from([0x18, 0x53, 0x80, 0x67]), sizeBytes(2 + 4 + 8 + 1 + 8, 4), Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x01, 0, 0, 0, 0, 0, 0, 0x0b]), wide]);
  assert.equal(probe(file).info.title, 'T');
});

test('DateUTC counts nanoseconds from 2001-01-01', () => {
  const ns = BigInt(Date.UTC(2020, 5, 15, 12, 30) - Date.UTC(2001, 0, 1)) * 1_000_000n;
  const d = Buffer.alloc(8);
  d.writeBigInt64BE(ns);
  const info = encode({ id: 0x1549a966, children: [{ id: 0x4461, data: d }] });
  const file = Buffer.concat([encode({ id: 0x1a45dfa3, children: [{ id: 0x4282, data: Buffer.from('matroska') }] }), Buffer.from([0x18, 0x53, 0x80, 0x67]), sizeBytes(info.length, 4), info]);
  assert.equal(probe(file).info.date, '2020-06-15T12:30:00.000Z');
});

test('choosing tracks: flags, language preference, forced subtitles, commentary skipped', () => {
  const p = probe(writeMatroska(base()));
  const d = defaultTracks(p);
  assert.deepEqual([d.video?.number, d.audio?.number, d.subtitle?.number], [1, 2, undefined]);
  assert.equal(defaultTracks(p, { audioLanguages: ['fr'] }).audio?.number, 3);
  assert.equal(defaultTracks(p, { audioLanguages: ['de', 'fre'] }).audio?.number, 3);
  assert.equal(defaultTracks(p, { subtitleLanguages: ['en'] }).subtitle?.number, 5);
  assert.equal(defaultTracks(p, { subtitleLanguages: ['en-GB'.slice(0, 2)] }).subtitle?.number, 5);
  assert.equal(defaultTracks(p, { audioLanguages: ['fr'] }).subtitle?.number, 6);
});

test('descriptions, codec names and language codes', () => {
  const p = probe(writeMatroska(base()));
  assert.equal(describe(p.tracks[0]!), 'video h264 high@4.1 1920x1080 23.976fps');
  assert.equal(describe(p.tracks[1]!), 'audio eac3 5.1 48000Hz eng (English 5.1) [default]');
  assert.equal(describe(p.tracks[5]!), 'subtitle pgs fre [forced]');
  assert.equal(codecName('A_DTS/LOSSLESS'), 'dts-ma');
  assert.equal(codecName('A_MPEG/L3'), 'mp3');
  assert.equal(codecName('S_TEXT/WEBVTT'), 'vtt');
  assert.equal(codecName('V_UNKNOWN/THING'), 'unknown');
  assert.equal(language2('fre'), 'fr');
  assert.equal(language2('und'), undefined);
});
