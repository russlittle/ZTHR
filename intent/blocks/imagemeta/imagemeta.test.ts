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
