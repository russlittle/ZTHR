import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused, displayed, inspect, sniff, stripJpeg } from './index.ts';

const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

const seg = (marker: number, body: Buffer) => {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
};

/** An EXIF block with orientation and a GPS pointer (big-endian TIFF). */
const exif = (orientation: number) => {
  const t = Buffer.alloc(8 + 2 + 24 + 4);
  t.write('MM', 0, 'latin1');
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4);
  t.writeUInt16BE(2, 8);
  t.writeUInt16BE(0x0112, 10);
  t.writeUInt16BE(3, 12);
  t.writeUInt32BE(1, 14);
  t.writeUInt16BE(orientation, 18);
  t.writeUInt16BE(0x8825, 22);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
};

const jpeg = (w: number, h: number, orientation: number) => {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(h, 1);
  sof.writeUInt16BE(w, 3);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x02', 'latin1')), seg(0xe1, exif(orientation)), seg(0xe2, Buffer.from('ICC_PROFILE\0fake', 'latin1')), seg(0xfe, Buffer.from('taken at home')), seg(0xc0, sof), Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])]);
};

test('kind comes from the bytes, not the name, with sizes for each format', () => {
  assert.deepEqual(inspect(png(640, 480)), { kind: 'png', width: 640, height: 480, orientation: 1, mime: 'image/png' });
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x20, 0x00, 0x10, 0x00])]);
  assert.equal(inspect(gif).width, 32);
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUIntLE(1919, 24, 3);
  webp.writeUIntLE(1079, 27, 3);
  assert.deepEqual([inspect(webp).width, inspect(webp).height], [1920, 1080]);
  assert.equal(sniff(Buffer.from('<svg onload=alert(1)>')), undefined);
  assert.throws(() => inspect(Buffer.from('%PDF-1.7 pretending to be a png')), Refused);
});

test('a huge image is refused before decoding; a phone photo knows which way is up', () => {
  assert.throws(() => inspect(png(100_000, 100_000)), /too many pixels/);
  const j = inspect(jpeg(4032, 3024, 6));
  assert.deepEqual([j.width, j.height, j.orientation], [4032, 3024, 6]);
  assert.deepEqual(displayed(j), { width: 3024, height: 4032 });
});

test('stripping removes EXIF (and its GPS) and comments but keeps the colour profile and the picture', () => {
  const before = jpeg(800, 600, 6);
  const after = stripJpeg(before);
  assert.ok(after.length < before.length);
  assert.equal(after.includes(Buffer.from('Exif\0\0', 'latin1')), false);
  assert.equal(after.includes(Buffer.from('taken at home')), false);
  assert.ok(after.includes(Buffer.from('ICC_PROFILE', 'latin1')));
  assert.deepEqual([inspect(after).width, inspect(after).orientation], [800, 1]);
  assert.ok(after.subarray(-9).equals(before.subarray(-9)), 'the image data is untouched');
});

test('images appended after the end of the picture (multi-picture previews, motion-photo trailers) are stripped with their EXIF', () => {
  const mpf = seg(0xe2, Buffer.from('MPF\0II*\0', 'latin1'));
  const first = jpeg(800, 600, 6);
  const withMpf = Buffer.concat([first.subarray(0, 2), mpf, first.subarray(2), jpeg(160, 120, 6), Buffer.from('trailer with secrets')]);
  const after = stripJpeg(withMpf);
  assert.equal(after.includes(Buffer.from('Exif\0\0', 'latin1')), false);
  assert.equal(after.includes(Buffer.from('taken at home')), false);
  assert.equal(after.includes(Buffer.from('MPF\0', 'latin1')), false);
  assert.equal(after.includes(Buffer.from('trailer with secrets')), false);
  assert.ok(after.subarray(-2).equals(Buffer.from([0xff, 0xd9])), 'ends at the end of the first picture');
  assert.deepEqual([inspect(after).width, inspect(after).height], [800, 600]);
});

test('the Adobe segment, which says how to decode the colours, is kept', () => {
  const adobe = seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x02', 'latin1'));
  const j = jpeg(10, 10, 1);
  const after = stripJpeg(Buffer.concat([j.subarray(0, 2), adobe, j.subarray(2)]));
  assert.ok(after.includes(Buffer.from('Adobe', 'latin1')));
});

test('fill bytes before a marker are allowed, and short or damaged headers are refused cleanly', () => {
  const j = jpeg(640, 480, 3);
  const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
  const filled = Buffer.concat([j.subarray(0, sof), Buffer.from([0xff, 0xff]), j.subarray(sof)]);
  assert.deepEqual([inspect(filled).width, inspect(filled).height, inspect(filled).orientation], [640, 480, 3]);
  assert.throws(() => inspect(png(1, 1).subarray(0, 18)), Refused);
  assert.throws(() => inspect(Buffer.from('GIF89a\x01', 'latin1')), Refused);
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8 ', 8, 'latin1');
  assert.throws(() => inspect(webp), Refused);
  assert.throws(() => inspect(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x05, 0x08])), Refused);
  assert.throws(() => stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00])), Refused);
});

// ---- Mutation-hardening: each case below pins one behaviour of the byte reading. ----

const bytes = (...n: number[]) => Buffer.from(n);
const SOI = bytes(0xff, 0xd8);
const EOI = bytes(0xff, 0xd9);
/** A start-of-frame segment with exactly the 5 body bytes a size needs: precision, height, width. */
const sof = (w: number, h: number, marker = 0xc0) => seg(marker, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255]));
const sos = (data: Buffer) => Buffer.concat([bytes(0xff, 0xda, 0x00, 0x02), data]);

/** A TIFF block with 12-byte short-valued entries; `ifd` and `count` can lie to build damaged ones. */
const tiff = (o: { le?: boolean; ifd?: number; count?: number; entries?: Array<[number, number]>; total?: number }) => {
  const entries = o.entries ?? [];
  const ifd = o.ifd ?? 8;
  const t = Buffer.alloc(o.total ?? ifd + 2 + entries.length * 12);
  const w16 = (v: number, at: number) => (o.le ? t.writeUInt16LE(v, at) : t.writeUInt16BE(v, at));
  t.write(o.le ? 'II' : 'MM', 0, 'latin1');
  w16(42, 2);
  if (o.le) t.writeUInt32LE(ifd, 4);
  else t.writeUInt32BE(ifd, 4);
  if (ifd + 2 <= t.length) w16(o.count ?? entries.length, ifd);
  entries.forEach(([tag, value], i) => {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return;
    w16(tag, e);
    w16(3, e + 2);
    w16(value, e + 8);
  });
  return t;
};
const exifOf = (t: Buffer, header = 'Exif\0\0') => Buffer.concat([Buffer.from(header, 'latin1'), t]);
const ORIENT = 0x0112;
const orientationOf = (...segs: Buffer[]) => inspect(Buffer.concat([SOI, ...segs, sof(8, 8), EOI])).orientation;
const app1 = (t: Buffer, header?: string) => seg(0xe1, exifOf(t, header));

test('a PNG is the full eight-byte signature and nothing less', () => {
  const sig = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.equal(sniff(sig), 'png', 'exactly eight bytes is enough');
  assert.equal(sniff(sig.subarray(0, 7)), undefined);
  assert.equal(sniff(sig.subarray(0, 4)), undefined, 'a short buffer is not read past its end');
  assert.equal(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b)), undefined, 'the second half must match');
  assert.equal(sniff(bytes(0x89, 0x50, 0x4e, 0x48, 0x0d, 0x0a, 0x1a, 0x0a)), undefined, 'the first half must match');
});

test('a JPEG is FF D8 FF, each byte checked', () => {
  assert.equal(sniff(bytes(0xff, 0xd8, 0xff)), 'jpeg', 'exactly three bytes is enough');
  assert.equal(sniff(bytes(0xff, 0xd8)), undefined);
  assert.equal(sniff(bytes(0xff, 0xd8, 0x00)), undefined);
  assert.equal(sniff(bytes(0xff, 0x00, 0xff)), undefined);
  assert.equal(sniff(bytes(0x00, 0xd8, 0xff)), undefined);
  assert.equal(sniff(bytes(0x00, 0x00, 0xff)), undefined);
  assert.equal(sniff(bytes(0xff, 0x00, 0x00)), undefined);
});

test('GIF is GIF87a or GIF89a only; WebP is RIFF plus WEBP at the right places', () => {
  assert.equal(sniff(Buffer.from('GIF87a')), 'gif');
  assert.equal(sniff(Buffer.from('GIF89a')), 'gif', 'exactly six bytes is enough');
  assert.equal(sniff(Buffer.from('GIF88a')), undefined);
  assert.equal(sniff(Buffer.from('GIF89b')), undefined);
  assert.equal(sniff(Buffer.from('GIF89')), undefined);
  const webp = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  assert.equal(sniff(webp), 'webp', 'exactly twelve bytes is enough');
  assert.equal(sniff(webp.subarray(0, 11)), undefined);
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WAVE', 'latin1')), undefined, 'a RIFF that is not WebP');
  assert.equal(sniff(Buffer.from('RIFX\0\0\0\0WEBP', 'latin1')), undefined, 'WEBP without RIFF');
  assert.equal(sniff(Buffer.from('XXXX\0\0\0\0YYYY', 'latin1')), undefined);
});

test('little-endian EXIF is read little-endian, and every orientation 1 to 8 comes through', () => {
  for (let v = 1; v <= 8; v++) {
    assert.equal(orientationOf(app1(tiff({ entries: [[ORIENT, v]] }))), v, `big-endian ${v}`);
    assert.equal(orientationOf(app1(tiff({ le: true, entries: [[ORIENT, v]] }))), v, `little-endian ${v}`);
  }
});

test('an orientation outside 1 to 8 is upright', () => {
  for (const v of [0, 9, 100, 65535]) assert.equal(orientationOf(app1(tiff({ entries: [[ORIENT, v]] }))), 1, String(v));
});

test('the orientation is found in any entry of the directory, and only as its own tag', () => {
  assert.equal(orientationOf(app1(tiff({ entries: [[0x0100, 3], [ORIENT, 6]] }))), 6, 'second entry');
  assert.equal(orientationOf(app1(tiff({ entries: [[0x0100, 3], [0x0101, 4], [ORIENT, 8]] }))), 8, 'third entry');
  assert.equal(orientationOf(app1(tiff({ entries: [[0x0100, 3], [0x0101, 4]] }))), 1, 'another tag is not the orientation');
  assert.equal(orientationOf(app1(tiff({ le: true, entries: [[0x0100, 3], [ORIENT, 5]] }))), 5);
});

test('the directory count is respected: an entry past it is not read', () => {
  assert.equal(orientationOf(app1(tiff({ count: 1, entries: [[0x0100, 3], [ORIENT, 6]] }))), 1);
});

test('an entry that ends exactly at the end of the block is read; one that is cut off is not', () => {
  assert.equal(orientationOf(app1(tiff({ entries: [[ORIENT, 6]] }))), 6, 'the last entry fills the block');
  // Claims five entries, holds one whole entry and the first four bytes of a second (tag 0x0112, value missing).
  const cut = tiff({ count: 5, entries: [[0x0100, 3]], total: 8 + 2 + 12 + 4 });
  cut.writeUInt16BE(ORIENT, 22);
  assert.equal(orientationOf(app1(cut)), 1);
});

test('damaged EXIF never throws: a tiny block, a directory outside the block, or a foreign header is upright', () => {
  assert.equal(orientationOf(seg(0xe1, Buffer.from('Exif\0\0MM\0*', 'latin1'))), 1, 'shorter than a TIFF header');
  assert.equal(orientationOf(app1(tiff({ ifd: 1000, total: 20 }))), 1, 'directory far outside');
  assert.equal(orientationOf(app1(tiff({ ifd: 19, total: 20 }))), 1, 'directory with one byte left, too few for its count');
  assert.equal(orientationOf(app1(tiff({ entries: [[ORIENT, 6]] }), 'Exif\0\x01')), 1, 'not an Exif header');
  assert.equal(orientationOf(app1(tiff({ entries: [[ORIENT, 6]] }), 'http:/')), 1, 'XMP-like block');
});

test('only the first APP1 segment sets the orientation, and only APP1 carries it', () => {
  const six = app1(tiff({ entries: [[ORIENT, 6]] }));
  assert.equal(orientationOf(six, app1(tiff({ entries: [[ORIENT, 3]] }))), 6, 'a later EXIF does not override');
  assert.equal(orientationOf(six, app1(tiff({ entries: [[0x0100, 3]] }))), 6, 'a later EXIF without orientation does not reset it');
  assert.equal(orientationOf(seg(0xe2, exifOf(tiff({ entries: [[ORIENT, 3]] })))), 1, 'APP2 is not where EXIF lives');
  assert.equal(orientationOf(seg(0xe0, exifOf(tiff({ entries: [[ORIENT, 3]] })))), 1, 'APP0 neither');
});

test('restart markers inside scan data are part of the scan, not the end of it', () => {
  for (const rst of [0xd0, 0xd3, 0xd7]) {
    // After the restart come two zero bytes: read as a segment length they would be a damaged JPEG.
    const data = Buffer.from([0x11, 0xff, rst, 0x00, 0x00, 0x22]);
    const j = Buffer.concat([SOI, seg(0xe0, Buffer.from('JFIF\0')), sof(8, 8), sos(data), EOI]);
    assert.ok(stripJpeg(j).equals(j), `RST${rst - 0xd0} stays inside the scan`);
  }
});

test('a stuffed FF 00 inside scan data is data, not a marker', () => {
  const j = Buffer.concat([SOI, sof(8, 8), sos(Buffer.from([0x11, 0xff, 0x00, 0x00, 0x00, 0x22])), EOI]);
  assert.ok(stripJpeg(j).equals(j));
});

test('the scan ends at the real end-of-image whatever byte precedes it, so appended data is cut', () => {
  for (const last of [0x00, 0xd3, 0x33]) {
    const j = Buffer.concat([SOI, sof(8, 8), sos(Buffer.from([0x11, last])), EOI]);
    const out = stripJpeg(Buffer.concat([j, Buffer.from('appended secrets')]));
    assert.ok(out.equals(j), `scan data ending in ${last.toString(16)}`);
  }
});

test('fill bytes (FF FF) at the end of scan data are kept with the picture', () => {
  const j = Buffer.concat([SOI, sof(8, 8), sos(Buffer.from([0x11, 0xff])), EOI]);
  assert.ok(stripJpeg(j).equals(j), 'every byte survives');
});

test('a scan that runs to the end of the file with no end marker keeps all its bytes', () => {
  for (const tail of [[0x11, 0x22, 0x33], [0x11, 0x22, 0xff]]) {
    const j = Buffer.concat([SOI, sof(8, 8), sos(Buffer.from(tail))]);
    assert.ok(stripJpeg(j).equals(j), `tail ${tail.map((x) => x.toString(16)).join(' ')}`);
  }
});

test('stand-alone markers between segments (TEM, restarts) are skipped over two bytes', () => {
  for (const m of [0x01, 0xd0, 0xd7]) {
    const j = Buffer.concat([SOI, bytes(0xff, m), seg(0xe0, Buffer.from('JFIF\0')), sof(30, 20), EOI]);
    assert.deepEqual([inspect(j).width, inspect(j).height], [30, 20], `marker ${m.toString(16)}`);
    assert.ok(stripJpeg(j).equals(Buffer.concat([SOI, seg(0xe0, Buffer.from('JFIF\0')), sof(30, 20), EOI])), `dropped, and the segments after it kept ${m.toString(16)}`);
  }
});

test('a JPEG that stops at a segment boundary, or in a header, is cut at that point without error', () => {
  const head = Buffer.concat([SOI, seg(0xe0, Buffer.from('JFIF\0')), sof(8, 8)]);
  assert.ok(stripJpeg(head).equals(head), 'ends exactly after a segment');
  assert.ok(stripJpeg(Buffer.concat([head, bytes(0x41)])).equals(head), 'a single stray byte after the last segment is dropped');
  assert.ok(stripJpeg(Buffer.concat([head, bytes(0xff, 0xe0, 0x00)])).equals(head), 'a segment header cut short is dropped');
  const empty = Buffer.concat([head, bytes(0xff, 0xe0, 0x00, 0x02)]);
  assert.ok(stripJpeg(empty).equals(empty), 'an empty segment that ends the file is kept');
});

test('bytes that are not a marker, in a JPEG, are refused as damaged', () => {
  assert.throws(() => stripJpeg(Buffer.concat([SOI, seg(0xe0, Buffer.from('JFIF\0')), bytes(0x41, 0x42, 0x43, 0x44)])), /the JPEG is damaged/);
  assert.throws(() => stripJpeg(Buffer.concat([SOI, seg(0xe0, Buffer.from('JFIF\0')), Buffer.from('junk between segments'), EOI])), /the JPEG is damaged/);
  assert.throws(() => stripJpeg(Buffer.concat([SOI, bytes(0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9)])), /the JPEG is damaged/);
  assert.throws(() => stripJpeg(Buffer.concat([SOI, bytes(0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9)])), /the JPEG is damaged/);
});

test('the size comes from a real start-of-frame, not from other markers near it', () => {
  const decoy = (m: number) => seg(m, Buffer.from([8, 0, 1, 0, 1, 3, 1, 1, 1]));
  const j = (m: number) => Buffer.concat([SOI, decoy(m), sof(640, 480), EOI]);
  for (const m of [0xbf, 0xc4, 0xc8, 0xcc]) assert.deepEqual([inspect(j(m)).width, inspect(j(m)).height], [640, 480], `marker ${m.toString(16)} is not a frame`);
  for (const m of [0xc0, 0xc1, 0xc2, 0xcf]) {
    const only = Buffer.concat([SOI, sof(77, 55, m), EOI]);
    assert.deepEqual([inspect(only).width, inspect(only).height], [77, 55], `marker ${m.toString(16)} is a frame`);
  }
});

test('a start-of-frame of the shortest legal length is read; a shorter one is refused', () => {
  assert.equal(inspect(Buffer.concat([SOI, sof(5, 6), EOI])).width, 5);
  assert.throws(() => inspect(Buffer.concat([SOI, seg(0xc0, Buffer.from([8, 0, 1, 0])), EOI])), /the JPEG is damaged/);
});

test('refusals say what is wrong', () => {
  assert.throws(() => inspect(Buffer.from('plain text')), /this is not a PNG, JPEG, GIF or WebP image/);
  assert.throws(() => inspect(png(1, 1).subarray(0, 23)), /the PNG is cut short/);
  assert.throws(() => inspect(Buffer.from('GIF89a\x01\x00')), /the GIF is cut short/);
  const lossy = Buffer.alloc(29);
  lossy.write('RIFF', 0, 'latin1');
  lossy.write('WEBPVP8 ', 8, 'latin1');
  assert.throws(() => inspect(lossy), /the WebP is cut short/);
  const bad = png(4, 4);
  bad.write('IDAT', 12, 'latin1');
  assert.throws(() => inspect(bad), /the PNG is damaged/);
  const odd = Buffer.alloc(40);
  odd.write('RIFF', 0, 'latin1');
  odd.write('WEBPABCD', 8, 'latin1');
  assert.throws(() => inspect(odd), /the WebP is damaged/);
  assert.throws(() => inspect(png(0, 10)), /the image has no size/);
  assert.throws(() => inspect(png(10, 0)), /the image has no size/);
  assert.throws(() => inspect(png(0, 0)), /the image has no size/);
});

test('WebP sizes: lossy VP8 (14 bits, scale bits ignored), lossless VP8L (14 bits each, plus one), extended VP8X', () => {
  const lossy = Buffer.alloc(30);
  lossy.write('RIFF', 0, 'latin1');
  lossy.write('WEBPVP8 ', 8, 'latin1');
  lossy.writeUInt16LE(0xc000 | 321, 26);
  lossy.writeUInt16LE(0x4000 | 123, 28);
  assert.deepEqual([inspect(lossy).width, inspect(lossy).height], [321, 123]);
  const lossless = Buffer.alloc(25);
  lossless.write('RIFF', 0, 'latin1');
  lossless.write('WEBPVP8L', 8, 'latin1');
  lossless.writeUInt32LE((299 | (199 << 14)) >>> 0, 21);
  assert.deepEqual([inspect(lossless).width, inspect(lossless).height], [300, 200]);
});

test('the pixel limit is inclusive and can be set', () => {
  assert.equal(inspect(png(10, 10), { maxPixels: 100 }).width, 10);
  assert.throws(() => inspect(png(10, 11), { maxPixels: 100 }), /too many pixels/);
  assert.equal(inspect(png(5000, 10000)).height, 10000, 'fifty million is allowed by default');
  assert.throws(() => inspect(png(5000, 10001)), /too many pixels/);
});

test('displayed size swaps for the rotated orientations 5 to 8 only', () => {
  const info = (orientation: number) => ({ kind: 'jpeg' as const, width: 30, height: 20, orientation, mime: 'image/jpeg' });
  for (const o of [1, 2, 3, 4]) assert.deepEqual(displayed(info(o)), { width: 30, height: 20 }, String(o));
  for (const o of [5, 6, 7, 8]) assert.deepEqual(displayed(info(o)), { width: 20, height: 30 }, String(o));
});

test('stripping refuses anything that is not a JPEG, and keeps or drops the right application segments', () => {
  assert.throws(() => stripJpeg(png(1, 1)), /not a JPEG/);
  const body = (s: string) => Buffer.from(s, 'latin1');
  const wrap = (...s: Buffer[]) => stripJpeg(Buffer.concat([SOI, ...s, sof(8, 8), EOI]));
  assert.equal(wrap(seg(0xe0, body('JFIF\0'))).includes(body('JFIF')), true, 'APP0 stays');
  assert.equal(wrap(seg(0xf0, body('keepme'))).includes(body('keepme')), true, 'a marker past APP15 is not application data');
  assert.equal(wrap(seg(0xef, body('app15 data'))).includes(body('app15')), false, 'APP15 goes');
  assert.equal(wrap(seg(0xee, body('Ducky'))).includes(body('Ducky')), false, 'an APP14 that is not Adobe goes');
  assert.equal(wrap(seg(0xe3, body('Adobe things'))).includes(body('Adobe')), false, 'Adobe text in another segment goes');
  assert.equal(wrap(seg(0xe1, body('Adobe in exif slot'))).includes(body('Adobe')), false, 'Adobe text in APP1 goes');
  assert.equal(wrap(seg(0xee, body('Adobe\0\x64'))).includes(body('Adobe')), true, 'the real Adobe segment stays');
  assert.equal(wrap(seg(0xe2, body('ICC_PROFILE\0x'))).includes(body('ICC_PROFILE')), true, 'the colour profile stays');
  assert.equal(wrap(seg(0xe2, body('MPF\0x'))).includes(body('MPF')), false, 'multi-picture data goes');
});

test('a scan header whose length is under two is damaged, not an empty scan', () => {
  for (const len of [0, 1]) {
    const j = Buffer.concat([SOI, sof(8, 8), bytes(0xff, 0xda, 0x00, len, 0x11, 0x22), EOI]);
    assert.throws(() => stripJpeg(j), /the JPEG is damaged/, `length ${len}`);
  }
});
