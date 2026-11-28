import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esdsCodec, findMotionPhoto, hevcCodec, IsoError, isLivePhotoPair, parseBoxes, parseIso6709, path, probe, rotationFromMatrix } from './index.ts';

// ------------------------------------------------------------ a tiny box writer for fixtures

const cat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const be = (n: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => Math.floor(n / 2 ** (8 * (bytes - 1 - i))) & 0xff);
const u32 = (n: number) => be(n, 4);
const u16 = (n: number) => be(n, 2);
const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const box = (type: string, ...payload: (Uint8Array | number[])[]): Uint8Array => {
  const body = cat(...payload);
  return cat(u32(8 + body.length), str(type), body);
};
const full = (type: string, version: number, flags: number, ...payload: (Uint8Array | number[])[]) => box(type, [version, ...be(flags, 3)], ...payload);
const fixed = (n: number) => u32(Math.round(n * 65536) >>> 0);
const MATRIX: Record<number, number[]> = {
  0: [...fixed(1), ...fixed(0), ...fixed(0), ...fixed(0), ...fixed(1), ...fixed(0), ...u32(0), ...u32(0), ...u32(0x40000000)],
  90: [...fixed(0), ...fixed(1), ...fixed(0), ...u32((-65536) >>> 0), ...fixed(0), ...fixed(0), ...u32(0), ...u32(0), ...u32(0x40000000)],
  180: [...u32((-65536) >>> 0), ...fixed(0), ...fixed(0), ...fixed(0), ...u32((-65536) >>> 0), ...fixed(0), ...u32(0), ...u32(0), ...u32(0x40000000)],
  270: [...fixed(0), ...u32((-65536) >>> 0), ...fixed(0), ...fixed(1), ...fixed(0), ...fixed(0), ...u32(0), ...u32(0), ...u32(0x40000000)],
};
const mvhd = (timescale: number, duration: number, created = 3_786_912_000) => full('mvhd', 0, 0, u32(created), u32(created), u32(timescale), u32(duration), fixed(1), u16(0x100), new Array(10).fill(0), MATRIX[0]!, new Array(24).fill(0), u32(3));
const tkhd = (id: number, duration: number, w: number, h: number, rot: 0 | 90 | 180 | 270 = 0, flags = 3) =>
  full('tkhd', 0, flags, u32(0), u32(0), u32(id), u32(0), u32(duration), new Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), MATRIX[rot]!, fixed(w), fixed(h));
const mdhd = (timescale: number, duration: number, lang = 'eng') => {
  const l = lang.split('').reduce((acc, ch) => (acc << 5) | (ch.charCodeAt(0) - 0x60), 0);
  return full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(l), u16(0));
};
const hdlr = (type: string) => full('hdlr', 0, 0, u32(0), str(type), new Array(12).fill(0), [0]);
const stts = (count: number, delta: number) => full('stts', 0, 0, u32(1), u32(count), u32(delta));
const stszTable = (sizes: number[]) => full('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
const visualEntry = (type: string, w: number, h: number, ...children: Uint8Array[]) =>
  box(type, new Array(6).fill(0), u16(1), new Array(16).fill(0), u16(w), u16(h), u32(0x480000), u32(0x480000), u32(0), u16(1), new Array(32).fill(0), u16(0x18), u16(0xffff), ...children);
const audioEntry = (type: string, channels: number, rate: number, ...children: Uint8Array[]) =>
  box(type, new Array(6).fill(0), u16(1), u16(0), u16(0), u32(0), u16(channels), u16(16), u16(0), u16(0), u32(rate * 65536), ...children);
const stsd = (...entries: Uint8Array[]) => full('stsd', 0, 0, u32(entries.length), ...entries);
const avcC = (profile: number, compat: number, level: number) => box('avcC', [1, profile, compat, level, 0xff, 0xe0, 0]);
const esds = (aot: number, oti = 0x40) => {
  const dsi = [0x05, 0x02, (aot << 3) | 4, 0x10];
  const dcd = [0x04, 13 + dsi.length, oti, 0x15, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, ...dsi];
  const es = [0x03, 3 + dcd.length, 0, 1, 0, ...dcd];
  return full('esds', 0, 0, es);
};
const minf = (stbl: Uint8Array) => box('minf', stbl);
const trak = (head: Uint8Array, mediaHeader: Uint8Array, handler: string, sampleTable: Uint8Array) => box('trak', head, box('mdia', mediaHeader, hdlr(handler), minf(sampleTable)));
const videoTrak = (id: number, w: number, h: number, secs: number, frames: number, rot: 0 | 90 | 180 | 270 = 0, codec = visualEntry('avc1', w, h, avcC(0x64, 0, 0x1f))) =>
  trak(tkhd(id, secs * 1000, w, h, rot), mdhd(30000, secs * 30000), 'vide', box('stbl', stsd(codec), stts(frames, Math.round((secs * 30000) / frames)), stszTable(Array.from({ length: frames }, () => 5000))));
const audioTrak = (id: number, secs: number) =>
  trak(tkhd(id, secs * 1000, 0, 0), mdhd(44100, secs * 44100, 'fra'), 'soun', box('stbl', stsd(audioEntry('mp4a', 2, 44100, esds(2))), stts(secs * 43, 1024), stszTable(Array.from({ length: secs * 43 }, () => 400))));
const ftyp = (major: string, brands: string[]) => box('ftyp', str(major), u32(512), ...brands.map(str));

function movie(order: 'moov-first' | 'mdat-first' = 'moov-first', extraMoov: Uint8Array[] = [], secs = 10): Uint8Array {
  const moov = box('moov', mvhd(1000, secs * 1000), videoTrak(1, 1920, 1080, secs, secs * 30), audioTrak(2, secs), ...extraMoov);
  const mdat = box('mdat', new Array(64).fill(7));
  return cat(ftyp('isom', ['isom', 'iso2', 'avc1', 'mp41']), ...(order === 'moov-first' ? [moov, mdat] : [mdat, moov]));
}

// ------------------------------------------------------------ the box tree

test('boxes parse with sizes, nesting, 64-bit sizes, size-zero to the end, and uuid extended types', () => {
  const inner = box('free', [1, 2, 3]);
  const data = cat(box('moov', inner), cat(u32(1), str('wide'), be(16 + 4, 8), [9, 9, 9, 9]), cat(u32(0), str('mdat'), [1, 2, 3]));
  const top = parseBoxes(data);
  assert.deepEqual(top.map((b) => [b.type, b.size, b.headerSize]), [['moov', 19, 8], ['wide', 20, 16], ['mdat', 11, 8]]);
  assert.deepEqual(top[0]!.children.map((b) => [b.type, b.size]), [['free', 11]]);
  const u = parseBoxes(cat(box('uuid', Array.from({ length: 16 }, (_, i) => i), [5])));
  assert.equal(u[0]!.uuid, '000102030405060708090a0b0c0d0e0f');
  assert.equal(u[0]!.headerSize, 24);
});

test('a box that runs past the end is marked truncated and the boxes before it still read', () => {
  const full1 = box('free', [1, 2]);
  const cut = cat(full1, cat(u32(100), str('mdat'), [1, 2, 3]));
  const top = parseBoxes(cut);
  assert.deepEqual(top.map((b) => [b.type, b.truncated]), [['free', false], ['mdat', true]]);
  assert.equal(top[1]!.size, cut.length - full1.length);
});

test('malformed trees are refused: a size smaller than the header, too deep, too many boxes', () => {
  assert.throws(() => parseBoxes(cat(u32(4), str('free'))), /smaller than its own header/);
  assert.throws(() => parseBoxes(cat(u32(1), str('free'), be(10, 8))), /smaller than its own header/);
  let nested: Uint8Array = box('free', []);
  for (let i = 0; i < 20; i++) nested = box(i % 2 ? 'trak' : 'moov', nested);
  assert.throws(() => parseBoxes(nested), /nested deeper/);
  assert.throws(() => parseBoxes(cat(...Array.from({ length: 50 }, () => box('free', []))), 0, 400, { maxDepth: 5, maxBoxes: 10 }), /more than 10 boxes/);
  assert.deepEqual(parseBoxes(new Uint8Array(0)), []);
  assert.throws(() => parseBoxes(cat(u32(1), str('mdat'), be(2 ** 60, 8))), /too large/);
});

// ------------------------------------------------------------ probing a movie

test('a movie gives brands, duration, creation time, and a track list with codec strings, sizes and rates', () => {
  const p = probe(movie());
  assert.equal(p.majorBrand, 'isom');
  assert.deepEqual(p.brands, ['isom', 'iso2', 'avc1', 'mp41']);
  assert.equal(p.kind, 'video');
  assert.equal(p.durationSeconds, 10);
  assert.equal(p.creationTime!.toISOString(), '2024-01-01T00:00:00.000Z'); // 3786912000 s after 1904
  assert.equal(p.fragmented, false);
  assert.equal(p.tracks.length, 2);
  const [v, a] = p.tracks as [typeof p.tracks[0], typeof p.tracks[0]];
  assert.deepEqual({ id: v.id, kind: v.kind, codec: v.codec, cs: v.codecString, w: v.width, h: v.height, fps: v.frameRate, dur: v.durationSeconds, rot: v.rotation }, { id: 1, kind: 'video', codec: 'avc1', cs: 'avc1.64001f', w: 1920, h: 1080, fps: 30, dur: 10, rot: 0 });
  assert.equal(v.bitrate, Math.round((300 * 5000 * 8) / 10));
  assert.deepEqual({ id: a.id, kind: a.kind, codec: a.codec, cs: a.codecString, ch: a.channels, sr: a.sampleRate, lang: a.language }, { id: 2, kind: 'audio', codec: 'mp4a', cs: 'mp4a.40.2', ch: 2, sr: 44100, lang: 'fra' });
  assert.equal(v.language, 'eng'); // the default written by the fixture
  const und = probe(cat(ftyp('isom', ['isom']), box('moov', mvhd(1000, 1000), trak(tkhd(1, 1000, 0, 0), mdhd(1000, 1000, 'und'), 'soun', box('stbl', stsd(audioEntry('mp4a', 1, 8000, esds(2)))))), box('mdat', [0]))).tracks[0]!;
  assert.equal(und.language, undefined); // "und" means undetermined
});

test('container checks pass for a sound file and say what is wrong when moov follows mdat', () => {
  const ok = probe(movie());
  assert.ok(ok.checks.every((c) => c.ok), JSON.stringify(ok.checks.filter((c) => !c.ok)));
  assert.equal(ok.faststart, true);
  const late = probe(movie('mdat-first'));
  assert.equal(late.faststart, false);
  const f = late.checks.find((c) => c.name === 'faststart')!;
  assert.equal(f.ok, false);
  assert.match(f.message, /moov comes after mdat/);
  assert.deepEqual(late.topLevel, ['ftyp', 'mdat', 'moov']);
});

test('a download cut off before moov arrives reports it, and a file with no ftyp is called out', () => {
  const whole = movie('mdat-first');
  const cut = whole.subarray(0, whole.length - 30);
  const p = probe(cut);
  assert.equal(p.truncated, true);
  assert.equal(p.checks.find((c) => c.name === 'moov')!.ok, false);
  assert.equal(p.checks.find((c) => c.name === 'complete')!.ok, false);
  const noFtyp = probe(box('mdat', [1, 2, 3]));
  assert.equal(noFtyp.checks.find((c) => c.name === 'ftyp')!.ok, false);
  assert.equal(noFtyp.majorBrand, undefined);
  assert.equal(probe(new Uint8Array(0)).truncated, true);
  assert.equal(probe(new Uint8Array(0)).kind, 'unknown');
});

test('track durations that disagree with the movie are flagged', () => {
  const moov = box('moov', mvhd(1000, 10_000), videoTrak(1, 640, 360, 60, 1800));
  const p = probe(cat(ftyp('isom', ['isom']), moov, box('mdat', [0])));
  assert.equal(p.checks.find((c) => c.name === 'durations')!.ok, false);
});

test('rotation comes from the track matrix, and a quarter turn swaps the displayed width and height', () => {
  for (const [rot, w, h] of [[0, 1920, 1080], [90, 1080, 1920], [180, 1920, 1080], [270, 1080, 1920]] as const) {
    const moov = box('moov', mvhd(1000, 1000), videoTrak(1, 1920, 1080, 1, 30, rot));
    const t = probe(cat(ftyp('qt  ', ['qt  ']), moov, box('mdat', [0]))).tracks[0]!;
    assert.deepEqual([t.rotation, t.displayWidth, t.displayHeight, t.width, t.height], [rot, w, h, 1920, 1080], `rotation ${rot}`);
  }
  assert.equal(rotationFromMatrix(0, 1, -1, 0), 90);
  assert.equal(rotationFromMatrix(-1, 0, 0, -1), 180);
  assert.equal(rotationFromMatrix(0, -1, 1, 0), 270);
  assert.equal(rotationFromMatrix(1, 0, 0, 1), 0);
});

test('a disabled track is reported as such', () => {
  const moov = box('moov', mvhd(1000, 1000), trak(tkhd(1, 1000, 0, 0, 0, 0), mdhd(1000, 1000), 'soun', box('stbl', stsd(audioEntry('mp4a', 1, 8000, esds(2))))));
  assert.equal(probe(cat(ftyp('M4A ', ['M4A ']), moov)).tracks[0]!.enabled, false);
  assert.equal(probe(cat(ftyp('M4A ', ['M4A ']), moov)).kind, 'audio');
});

// ------------------------------------------------------------ codec strings

test('avc, hevc, av1, vp9 and aac codec strings follow RFC 6381', () => {
  const vt = (entry: Uint8Array) => probe(cat(ftyp('isom', ['isom']), box('moov', mvhd(1000, 1000), videoTrak(1, 640, 360, 1, 30, 0, entry)), box('mdat', [0]))).tracks[0]!.codecString;
  assert.equal(vt(visualEntry('avc1', 640, 360, avcC(0x42, 0xc0, 0x1e))), 'avc1.42c01e');
  const hvcC = box('hvcC', [1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0, 0]);
  assert.equal(vt(visualEntry('hvc1', 640, 360, hvcC)), 'hvc1.1.6.L93.90');
  assert.equal(vt(visualEntry('av01', 640, 360, box('av1C', [0x81, 0x08, 0x0c, 0]))), 'av01.0.08M.08');
  assert.equal(vt(visualEntry('av01', 640, 360, box('av1C', [0x81, 0x09, 0x4c, 0]))), 'av01.0.09M.10');
  assert.equal(vt(visualEntry('av01', 640, 360, box('av1C', [0x81, 0x2a, 0xec, 0]))), 'av01.1.10H.12');
  assert.equal(vt(visualEntry('vp09', 640, 360, full('vpcC', 1, 0, [2, 31, 0xa0, 2, 2, 2]))), 'vp09.02.31.10');
  assert.equal(vt(visualEntry('avc1', 640, 360)), undefined); // no avcC: no string, but the fourcc is known
  assert.equal(hevcCodec('hvc1', new Uint8Array([1, 0x21, 0x40, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 120]), 0), 'hvc1.1.2.H120.B0');
  assert.equal(hevcCodec('hev1', new Uint8Array([1, 0x61, 0x40, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 120]), 0), 'hev1.A1.2.H120.B0'); // profile space A
  const aacLc = esds(2);
  assert.equal(esdsCodec(aacLc, 8, aacLc.length), 'mp4a.40.2');
  const he = esds(5);
  assert.equal(esdsCodec(he, 8, he.length), 'mp4a.40.5');
  const mp3 = esds(0, 0x6b);
  assert.equal(esdsCodec(mp3, 8, mp3.length)?.startsWith('mp4a.6B'), true);
});

// ------------------------------------------------------------ fragmented

test('a fragmented file takes its duration from mehd and says so', () => {
  const moov = box('moov', mvhd(1000, 0), box('mvex', full('mehd', 0, 0, u32(7000)), full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))), videoTrak(1, 1280, 720, 1, 30));
  const moof = box('moof', full('mfhd', 0, 0, u32(1)));
  const p = probe(cat(ftyp('iso5', ['iso5', 'dash']), moov, moof, box('mdat', [0])));
  assert.equal(p.fragmented, true);
  assert.equal(p.durationSeconds, 7);
  assert.equal(p.checks.find((c) => c.name === 'mdat')!.ok, true);
});

// ------------------------------------------------------------ metadata and GPS

test('the ISO 6709 string parses in decimal degrees and in degrees and minutes, and refuses nonsense', () => {
  assert.deepEqual(parseIso6709('+37.3349-122.0090+012.345/'), { latitude: 37.3349, longitude: -122.009, altitude: 12.345 });
  assert.deepEqual(parseIso6709('-33.8688+151.2093/'), { latitude: -33.8688, longitude: 151.2093 });
  const dm = parseIso6709('+4050.5-07400.5/')!;
  assert.ok(Math.abs(dm.latitude - (40 + 50.5 / 60)) < 1e-9);
  assert.ok(Math.abs(dm.longitude - -(74 + 0.5 / 60)) < 1e-9);
  const dms = parseIso6709('+404030-0740030/')!;
  assert.ok(Math.abs(dms.latitude - (40 + 40 / 60 + 30 / 3600)) < 1e-9);
  assert.equal(parseIso6709('+95.0000+000.0000/'), undefined);
  assert.equal(parseIso6709('+10.0+200.0/'), undefined);
  assert.equal(parseIso6709('hello'), undefined);
  assert.equal(parseIso6709(''), undefined);
});

test('GPS is read from the QuickTime ©xyz atom', () => {
  const xyz = box('©xyz', u16(26), u16(0x15c7), str('+37.3349-122.0090+012.345/'));
  const p = probe(cat(ftyp('qt  ', ['qt  ']), box('moov', mvhd(1000, 1000), videoTrak(1, 640, 360, 1, 30), box('udta', xyz)), box('mdat', [0])));
  assert.deepEqual(p.gps, { latitude: 37.3349, longitude: -122.009, altitude: 12.345 });
});

function mdtaMeta(entries: [string, string][], isoFull = false): Uint8Array {
  const keys = full('keys', 0, 0, u32(entries.length), ...entries.map(([k]) => cat(u32(8 + k.length), str('mdta'), str(k))));
  const ilst = box('ilst', ...entries.map(([, v], i) => box(String.fromCharCode(0, 0, 0, i + 1), box('data', u32(1), u32(0), str(v)))));
  const inner = [full('hdlr', 0, 0, u32(0), str('mdta'), new Array(12).fill(0), [0]), keys, ilst];
  return isoFull ? full('meta', 0, 0, ...inner) : box('meta', ...inner);
}

test('QuickTime metadata keys are read (with and without the full-box header), and the content identifier and location come out', () => {
  const entries: [string, string][] = [['com.apple.quicktime.content.identifier', 'ABCD-1234'], ['com.apple.quicktime.make', 'Apple'], ['com.apple.quicktime.location.ISO6709', '+51.5007-000.1246+011.000/']];
  for (const isoFull of [false, true]) {
    const p = probe(cat(ftyp('qt  ', ['qt  ']), box('moov', mvhd(1000, 1000), videoTrak(1, 640, 360, 1, 30), mdtaMeta(entries, isoFull)), box('mdat', [0])));
    assert.equal(p.contentIdentifier, 'ABCD-1234', `isoFull=${isoFull}`);
    assert.equal(p.metadata['com.apple.quicktime.make'], 'Apple');
    assert.deepEqual(p.gps, { latitude: 51.5007, longitude: -0.1246, altitude: 11 });
  }
});

test('a live photo pairs a still and a movie by content identifier, ignoring case, and refuses when either is missing', () => {
  const mov = probe(cat(ftyp('qt  ', ['qt  ']), box('moov', mvhd(1000, 1000), videoTrak(1, 640, 360, 1, 30), mdtaMeta([['com.apple.quicktime.content.identifier', 'abcd-1234']])), box('mdat', [0])));
  assert.equal(isLivePhotoPair(mov, 'ABCD-1234'), true);
  assert.equal(isLivePhotoPair(mov, 'ABCD-9999'), false);
  assert.equal(isLivePhotoPair(mov, undefined), false);
  assert.equal(isLivePhotoPair(probe(movie()), 'ABCD-1234'), false);
});

// ------------------------------------------------------------ HEIC

test('HEIF items: primary item, types, sizes and rotation from ispe, irot and ipma', () => {
  const infe = (id: number, type: string) => full('infe', 2, 0, u16(id), u16(0), str(type), [0]);
  const ispe = (w: number, h: number) => full('ispe', 0, 0, u32(w), u32(h));
  const meta = full('meta', 0, 0,
    full('hdlr', 0, 0, u32(0), str('pict'), new Array(12).fill(0), [0]),
    full('pitm', 0, 0, u16(1)),
    full('iinf', 0, 0, u16(3), infe(1, 'hvc1'), infe(2, 'hvc1'), infe(3, 'Exif')),
    box('iprp', box('ipco', ispe(4032, 3024), box('irot', [1]), ispe(320, 240)), full('ipma', 0, 0, u32(2), u16(1), [2, 1, 2], u16(2), [1, 3])));
  const p = probe(cat(ftyp('heic', ['heic', 'mif1']), meta, box('mdat', [0])));
  assert.equal(p.kind, 'image');
  assert.deepEqual(p.items.map((i) => ({ id: i.id, type: i.type, primary: i.primary, w: i.width, h: i.height, rot: i.rotation })), [
    { id: 1, type: 'hvc1', primary: true, w: 4032, h: 3024, rot: 90 },
    { id: 2, type: 'hvc1', primary: false, w: 320, h: 240, rot: 0 },
    { id: 3, type: 'Exif', primary: false, w: undefined, h: undefined, rot: 0 },
  ]);
  assert.ok(p.checks.every((c) => c.ok));
});

// ------------------------------------------------------------ motion photos

function jpegWith(xmp: string, mp4: Uint8Array | undefined, padding = 200): Uint8Array {
  const x = new TextEncoder().encode(xmp);
  return cat([0xff, 0xd8], [0xff, 0xe1], u16(x.length + 2), x, new Array(padding).fill(0x11), [0xff, 0xd9], mp4 ?? []);
}
const smallMp4 = () => cat(ftyp('isom', ['isom', 'mp42']), box('mdat', new Array(40).fill(1)));

test('a Google motion photo is found through MicroVideoOffset, and trusted only if ftyp is really there', () => {
  const mp4 = smallMp4();
  const good = jpegWith(`<x GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${mp4.length}"/>`, mp4);
  assert.deepEqual(findMotionPhoto(good), { offset: good.length - mp4.length, length: mp4.length, source: 'xmp-microvideo' });
  const lying = jpegWith(`<x GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${mp4.length + 7}"/>`, mp4);
  assert.equal(findMotionPhoto(lying)!.source, 'scan'); // the offset points at nothing, so it falls back to scanning
  assert.equal(findMotionPhoto(lying)!.offset, lying.length - mp4.length);
});

test('a Samsung or Pixel container directory with Item:Semantic MotionPhoto names the video length', () => {
  const mp4 = smallMp4();
  const j = jpegWith(`<rdf:li Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${mp4.length}"/>`, mp4);
  assert.deepEqual(findMotionPhoto(j), { offset: j.length - mp4.length, length: mp4.length, source: 'xmp-container' });
});

test('a plain JPEG has no motion photo, and a non-JPEG is refused', () => {
  assert.equal(findMotionPhoto(jpegWith('<x/>', undefined)), undefined);
  assert.throws(() => findMotionPhoto(new Uint8Array([1, 2, 3, 4])), IsoError);
  assert.throws(() => findMotionPhoto(new Uint8Array(0)), /not a JPEG/);
});

test('path() follows box types from the top', () => {
  const top = parseBoxes(movie());
  assert.deepEqual(path(top, 'moov', 'trak').map((b) => b.type), ['trak', 'trak']);
  assert.deepEqual(path(top, 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd').length, 2);
  assert.deepEqual(path(top, 'moov', 'nope'), []);
});
