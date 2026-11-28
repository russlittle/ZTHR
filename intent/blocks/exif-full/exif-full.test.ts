import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExifError, ExifLimitError, exifOf, find, formatExposure, inferTakenAt, merge, normaliseCamera, parseIptc, parseTiff, parseXmp, read, withoutLocation } from './index.ts';

// A JPEG written by Pillow 12.3 (big-endian EXIF) from known values: the ground truth is what was put in.
const PILLOW_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QJgRXhpZgAATU0AKgAAAAgACQEPAAIAAAAGAAAAegEQAAIAAAAVAAAAgAESAAMAAAABAAYAAAExAAIAAAAIAAAAlgEyAAIAAAAUAAAAngE7AAIAAAALAAAAsoKYAAIAAAANAAAAvodpAAQAAAABAAAAzIglAAQAAAABAAABlgAAAABDYW5vbgBDYW5vbiBFT1MgNUQgTWFyayBJVgAAR2VuIDEuMAAyMDI0OjA3OjA0IDE4OjMwOjE1AEFuYSBBcnRpc3QAAChjKSBBbmEgMjAyNAAAAAqCmgAFAAAAAQAAAUqCnQAFAAAAAQAAAVKIJwADAAAAAQGQAACQAwACAAAAFAAAAVqQEQACAAAABwAAAW6SCQADAAAAAQAQAACSCgAFAAAAAQAAAXagAgADAAAAAQAIAACgAwADAAAAAQAIAACkNAACAAAAGAAAAX4AAAAAAAAAAQAAAPoAAAAOAAAABTIwMjQ6MDc6MDQgMTg6MzA6MTUAKzAyOjAwAAAAAABVAAAAAUVGMjQtNzBtbSBmLzIuOEwgSUkgVVNNAAAIAAEAAgAAAAJOAAAAAAIABQAAAAMAAAH8AAMAAgAAAAJFAAAAAAQABQAAAAMAAAIUAAUAAQAAAAEAAAAAAAYABQAAAAEAAAIsAAcABQAAAAMAAAI0AB0AAgAAAAsAAAJMAAAAAAAAADAAAAABAAAAMwAAAAEAAALrAAAAGQAAAAIAAAABAAAAFQAAAAEAAADJAAAAGQAAACMAAAABAAAAEAAAAAEAAAAeAAAAAQAAAAkAAAABMjAyNDowNzowNAAA/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A8BooopiP/9k=', 'base64');

type V = { tag: number; type: number; v: number[] | string | Buffer };
const SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const rat = (...pairs: [number, number][]): V['v'] => pairs.flat();
/** Builds a TIFF block: IFD0 (with pointers to the Exif and GPS IFDs when given), and an optional IFD1. */
function tiff(le: boolean, ifd0: V[], exif?: V[], gps?: V[], ifd1?: V[]): Buffer {
  const w16 = (b: Buffer, o: number, n: number) => (le ? b.writeUInt16LE(n, o) : b.writeUInt16BE(n, o));
  const w32 = (b: Buffer, o: number, n: number) => (le ? b.writeUInt32LE(n >>> 0, o) : b.writeUInt32BE(n >>> 0, o));
  const ptr = (tag: number): V => ({ tag, type: 4, v: [0] });
  const lists = [{ name: 'ifd0', es: [...ifd0, ...(exif ? [ptr(0x8769)] : []), ...(gps ? [ptr(0x8825)] : [])] }, ...(exif ? [{ name: 'exif', es: exif }] : []), ...(gps ? [{ name: 'gps', es: gps }] : []), ...(ifd1 ? [{ name: 'ifd1', es: ifd1 }] : [])];
  const offs: Record<string, number> = {};
  let p = 8;
  for (const l of lists) {
    offs[l.name] = p;
    p += 2 + l.es.length * 12 + 4;
  }
  const parts: Buffer[] = [];
  const head = Buffer.alloc(p);
  head.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(head, 2, 42);
  w32(head, 4, 8);
  let data = p;
  for (let li = 0; li < lists.length; li++) {
    const l = lists[li]!;
    let o = offs[l.name]!;
    w16(head, o, l.es.length);
    o += 2;
    for (const e of l.es) {
      let bytes: Buffer;
      let count: number;
      if (typeof e.v === 'string') {
        bytes = Buffer.from(e.v + '\0', 'latin1');
        count = bytes.length;
      } else if (Buffer.isBuffer(e.v)) {
        bytes = e.v;
        count = e.type === 2 || e.type === 7 || e.type === 1 ? bytes.length : bytes.length / SIZE[e.type]!;
      } else if (e.tag === 0x8769 || e.tag === 0x8825) {
        bytes = Buffer.alloc(4);
        w32(bytes, 0, offs[e.tag === 0x8769 ? 'exif' : 'gps']!);
        count = 1;
      } else {
        const n = e.type === 5 || e.type === 10 ? e.v.length / 2 : e.v.length;
        const unit = e.type === 5 || e.type === 10 ? 4 : SIZE[e.type]!;
        bytes = Buffer.alloc(n * (e.type === 5 || e.type === 10 ? 8 : unit));
        e.v.forEach((x, i) => {
          if (unit === 1) bytes[i] = x;
          else if (unit === 2) w16(bytes, i * 2, x);
          else w32(bytes, i * 4, x);
        });
        count = n;
      }
      w16(head, o, e.tag);
      w16(head, o + 2, e.type);
      w32(head, o + 4, count);
      if (bytes.length <= 4) bytes.copy(head, o + 8);
      else {
        w32(head, o + 8, data);
        parts.push(bytes);
        data += bytes.length;
        if (bytes.length % 2) (parts.push(Buffer.alloc(1)), data++);
      }
      o += 12;
    }
    w32(head, o, l.name === 'ifd0' && ifd1 ? offs['ifd1']! : 0);
  }
  return Buffer.concat([head, ...parts]);
}
const A = (tag: number, s: string): V => ({ tag, type: 2, v: s });
const S = (tag: number, ...v: number[]): V => ({ tag, type: 3, v });
const L = (tag: number, ...v: number[]): V => ({ tag, type: 4, v });
const R = (tag: number, ...pairs: [number, number][]): V => ({ tag, type: 5, v: rat(...pairs) });
const ex = (b: Buffer, o = {}) => exifOf(parseTiff(b), o);
const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
const jpeg = (...segs: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segs, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
const exifSeg = (t: Buffer) => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]));
const xmpSeg = (x: string) => seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0' + x, 'utf8'));

test('a JPEG written by Pillow reads back to the values it was given', () => {
  const m = read(PILLOW_JPEG);
  const e = m.exif!;
  assert.deepEqual([e.make, e.model, e.camera], ['Canon', 'Canon EOS 5D Mark IV', 'Canon EOS 5D Mark IV']);
  assert.deepEqual([e.orientation, e.software, e.artist, e.copyright], [6, 'Gen 1.0', 'Ana Artist', '(c) Ana 2024']);
  assert.deepEqual([e.exposure, e.fNumber, e.iso, e.focalLength, e.lens, e.width, e.height], ['1/250', 2.8, 400, 85, 'EF24-70mm f/2.8L II USM', 8, 8]);
  assert.deepEqual(e.flash, { fired: false, raw: 16 });
  assert.deepEqual(e.takenAt, { local: '2024-07-04T18:30:15', offset: '+02:00', utc: '2024-07-04T16:30:15.000Z', source: 'offset-tag' });
  assert.ok(Math.abs(e.gps!.lat - (48 + 51 / 60 + 29.88 / 3600)) < 1e-9);
  assert.ok(Math.abs(e.gps!.lon - (2 + 21 / 60 + 8.04 / 3600)) < 1e-9);
  assert.deepEqual([e.gps!.alt, e.gps!.time], [35, '2024-07-04T16:30:09.000Z']);
  assert.deepEqual(m.warnings, []);
  assert.equal(e.bodySerial, undefined);
});

test('little-endian and big-endian files with the same values read the same', () => {
  const build = (le: boolean) => tiff(le, [A(0x010f, 'NIKON CORPORATION'), A(0x0110, 'NIKON D850'), S(0x0112, 3)], [R(0x829a, [1, 2000]), R(0x829d, [4, 1]), S(0x8827, 64), A(0x9003, '2023:12:31 23:59:59'), R(0x920a, [200, 1])], [A(1, 'S'), R(2, [33, 1], [51, 1], [0, 1]), A(3, 'W'), R(4, [70, 1], [0, 1], [0, 1])]);
  const a = ex(build(true));
  const b = ex(build(false));
  assert.deepEqual(a, b);
  assert.deepEqual([a.camera, a.exposure, a.fNumber, a.iso, a.orientation], ['Nikon D850', '1/2000', 4, 64, 3]);
  assert.deepEqual([a.gps!.lat, a.gps!.lon], [-33.85, -70]);
});

test('capture time: the offset tag, else GPS against the camera clock, else no zone claimed; bad dates refused', () => {
  assert.deepEqual(inferTakenAt('2024:07:04 18:30:15', '+02:00', undefined), { local: '2024-07-04T18:30:15', offset: '+02:00', utc: '2024-07-04T16:30:15.000Z', source: 'offset-tag' });
  assert.equal(inferTakenAt('2024:07:04 18:30:15', '-05:30', undefined)!.utc, '2024-07-05T00:00:15.000Z');
  const gps = (s: string) => inferTakenAt('2024:07:04 18:30:15', undefined, s);
  assert.deepEqual(gps('2024-07-04T16:30:09.000Z'), { local: '2024-07-04T18:30:15', offset: '+02:00', utc: '2024-07-04T16:30:15.000Z', source: 'gps' });
  assert.equal(gps('2024-07-04T16:34:00.000Z')!.source, 'gps', 'a camera clock four minutes off still gives the zone');
  assert.equal(gps('2024-07-04T16:37:30.000Z')!.source, 'none', 'seven and a half minutes off fits no zone');
  assert.equal(inferTakenAt('2024:07:04 12:00:00', undefined, '2024-07-04T06:30:00.000Z')!.offset, '+05:30');
  assert.equal(gps('2024-07-03T16:30:09.000Z')!.source, 'none', 'a day off is not a zone');
  assert.equal(inferTakenAt('2024:07:04 18:30:15', '+25:00', undefined)!.source, 'none', 'an offset beyond 14 hours is ignored');
  assert.equal(inferTakenAt('2024:07:04 18:30:15', 'junk', undefined)!.source, 'none');
  for (const bad of ['0000:00:00 00:00:00', '2024:13:01 00:00:00', '2024:02:30 00:00:00', '2024:07:04 24:00:00', '2024-07-04 18:30:15 ', '', undefined]) assert.equal(inferTakenAt(bad, undefined, undefined), undefined, String(bad));
  assert.equal(inferTakenAt('2024:02:29 12:00:00', undefined, undefined)!.local, '2024-02-29T12:00:00');
});

test('floats stored in place of rationals are read; NaN and Infinity are absent', () => {
  const f = Buffer.alloc(8);
  f.writeDoubleBE(0.004);
  const g = Buffer.alloc(4);
  g.writeFloatBE(Infinity);
  const e = ex(tiff(false, [], [{ tag: 0x829a, type: 12, v: f }, { tag: 0x829d, type: 11, v: g }]));
  assert.deepEqual([e.exposure, e.fNumber], ['1/250', undefined]);
});

test('rationals with a zero denominator are absent, never NaN or Infinity', () => {
  const e = ex(tiff(false, [], [R(0x829a, [1, 0]), R(0x829d, [0, 0]), R(0x920a, [5, 0]), S(0x8827, 0)]));
  assert.deepEqual([e.exposureTime, e.exposure, e.fNumber, e.focalLength, e.iso], [undefined, undefined, undefined, undefined, undefined]);
  const g = ex(tiff(false, [], undefined, [A(1, 'N'), R(2, [1, 0], [0, 1], [0, 1]), A(3, 'E'), R(4, [1, 1], [0, 1], [0, 1])]));
  assert.equal(g.gps, undefined);
  assert.ok(g.warnings.some((w) => /coordinates are missing or not valid/.test(w)));
});

test('GPS: signs, altitude below sea level, no-fix 0,0, and out-of-range values', () => {
  const g = (latRef: string, lat: [number, number][], lonRef: string, lon: [number, number][], more: V[] = []) => ex(tiff(false, [], undefined, [A(1, latRef), R(2, ...lat), A(3, lonRef), R(4, ...lon), ...more])).gps;
  const D = (d: number, m = 0, s = 0): [number, number][] => [[d, 1], [m, 1], [s, 1]];
  assert.deepEqual([g('N', D(10, 30), 'E', D(20, 15))!.lat, g('N', D(10, 30), 'E', D(20, 15))!.lon], [10.5, 20.25]);
  assert.deepEqual([g('S', D(10, 30), 'W', D(20, 15))!.lat, g('S', D(10, 30), 'W', D(20, 15))!.lon], [-10.5, -20.25]);
  assert.equal(g('N', D(10), 'E', D(20), [{ tag: 5, type: 1, v: [1] }, R(6, [4300, 10])])!.alt, -430, 'AltitudeRef 1 is below sea level');
  assert.equal(g('N', D(0), 'E', D(0)), undefined, 'a camera with no fix writes 0,0');
  assert.equal(g('N', D(91), 'E', D(0, 1)), undefined, 'latitude beyond 90');
  assert.equal(g('N', D(10), 'E', D(181)), undefined, 'longitude beyond 180');
  assert.equal(g('N', D(10, 60), 'E', D(20)), undefined, '60 minutes is not valid');
  assert.equal(g('N', D(10, 0, 60), 'E', D(20)), undefined, '60 seconds is not valid');
  assert.equal(g('X', D(10), 'E', D(20)), undefined, 'no usable hemisphere');
  assert.equal(g('N', [[1, 1], [0, 1]], 'E', D(20)), undefined, 'two values instead of three');
  const t = g('N', D(10), 'E', D(20), [A(29, '2024:02:30'), R(7, [1, 1], [2, 1], [3, 1])]);
  assert.equal(t!.time, undefined, 'an impossible date gives no GPS time');
});

test('structural damage throws a typed error; the message says what is wrong', () => {
  const ok = tiff(false, [A(0x010f, 'X')]);
  assert.throws(() => parseTiff(Buffer.alloc(0)), ExifError);
  assert.throws(() => parseTiff(ok.subarray(0, 7)), /too short/);
  assert.throws(() => parseTiff(Buffer.concat([Buffer.from('XX'), ok.subarray(2)])), /neither II nor MM/);
  const magic = Buffer.from(ok);
  magic.writeUInt16BE(43, 2);
  assert.throws(() => parseTiff(magic), /not 42/);
  for (const off of [0, 4, 7, 0x7fffffff, ok.length - 1, ok.length]) {
    const b = Buffer.from(ok);
    b.writeUInt32BE(off, 4);
    assert.throws(() => parseTiff(b), /first IFD offset/, String(off));
  }
  assert.throws(() => parseTiff(Buffer.alloc(100), { maxFileBytes: 50 }), /too large/);
});

test('an IFD that points back at one already read is not followed again', () => {
  const b = tiff(false, [A(0x010f, 'Canon')], [S(0x8827, 100)]);
  const ifd0 = 8;
  const n = b.readUInt16BE(ifd0);
  b.writeUInt32BE(8, ifd0 + 2 + n * 12); // IFD1 pointer back to IFD0
  const t = parseTiff(b);
  assert.ok(t.warnings.some((w) => /already read/.test(w)));
  assert.equal(exifOf(t).make, 'Canon');
  const c = tiff(false, [A(0x010f, 'Canon')], [S(0x8827, 100)]);
  // the ExifIFD pointer aimed at IFD0 itself
  for (let i = 0; i < c.readUInt16BE(8); i++) if (c.readUInt16BE(10 + i * 12) === 0x8769) c.writeUInt32BE(8, 10 + i * 12 + 8);
  const u = parseTiff(c);
  assert.ok(u.warnings.some((w) => /Exif IFD: the IFD at 8 was already read/.test(w)));
  assert.equal(exifOf(u).iso, undefined);
});

test('a value that points outside the data, or is huge, is skipped; the rest of the file reads', () => {
  const b = tiff(false, [A(0x010f, 'Canon'), A(0x0110, 'EOS R5 body name that is longer than four bytes'), A(0x0131, 'Firmware')]);
  // entry 2 (model): point its value past the end
  b.writeUInt32BE(b.length + 10, 10 + 1 * 12 + 8);
  // entry 3 (software): claim 4 GiB
  b.writeUInt32BE(0xffffffff, 10 + 2 * 12 + 4);
  const e = ex(b);
  assert.deepEqual([e.make, e.model, e.software], ['Canon', undefined, undefined]);
  assert.equal(e.warnings.filter((w) => /outside the data|over the/.test(w)).length, 2);
  const low = Buffer.from(tiff(false, [A(0x010f, 'Canon'), A(0x0110, 'Some long model name here')]));
  low.writeUInt32BE(2, 10 + 12 + 8); // offset into the header
  assert.equal(ex(low).model, undefined);
  const odd = Buffer.from(tiff(false, [A(0x010f, 'Canon')]));
  odd.writeUInt16BE(99, 10 + 2);
  assert.ok(ex(odd).warnings.some((w) => /unknown type 99/.test(w)));
});

test('entry counts: a count beyond the data is cut to what fits; a flood past the limit is refused', () => {
  const b = tiff(false, [A(0x010f, 'Canon')]);
  b.writeUInt16BE(65_535, 8);
  const e = ex(b);
  assert.equal(e.make, 'Canon', 'the entries that do fit are read');
  assert.ok(e.warnings.some((w) => /65535 entries declared but only/.test(w)));
  const many = tiff(false, Array.from({ length: 300 }, (_, i) => S(0x1000 + i, 1)));
  assert.equal(parseTiff(many).ifd0.size, 300);
  assert.throws(() => parseTiff(many, { maxEntries: 100 }), ExifLimitError);
});

test('text: cut at NUL, control and bidi characters removed, long strings capped, repeated tags use the first', () => {
  const t = tiff(false, [{ tag: 0x010f, type: 2, v: Buffer.from('Can\u0000on\0', 'latin1') }, { tag: 0x0110, type: 2, v: Buffer.from(['A', String.fromCharCode(0x202e), 'B', String.fromCharCode(7), 'C\tD   E\0'].join(''), 'utf8') }, A(0x0131, 'x'.repeat(5000)), A(0x013b, 'first'), A(0x013b, 'second')]);
  const e = ex(t);
  assert.equal(e.make, 'Can');
  assert.equal(e.model, 'ABC D E');
  assert.equal(e.software!.length, 2000);
  assert.equal(e.artist, 'first');
  assert.ok(e.warnings.some((w) => /appears twice/.test(w)));
});

test('UserComment honours its character-code prefix and refuses unknown ones', () => {
  const uc = (code: string, body: Buffer): V => ({ tag: 0x9286, type: 7, v: Buffer.concat([Buffer.from(code.padEnd(8, '\0'), 'latin1'), body]) });
  assert.equal(ex(tiff(false, [], [uc('ASCII', Buffer.from('hello'))])).userComment, 'hello');
  assert.equal(ex(tiff(false, [], [uc('UNICODE', Buffer.from('héllo', 'utf16le').swap16())])).userComment, 'héllo');
  assert.equal(ex(tiff(true, [], [uc('UNICODE', Buffer.from('héllo', 'utf16le'))])).userComment, 'héllo');
  assert.equal(ex(tiff(false, [], [uc('\0\0\0\0\0\0\0\0', Buffer.from('plain'))])).userComment, 'plain');
  assert.equal(ex(tiff(false, [], [uc('JIS', Buffer.from('xx'))])).userComment, undefined);
  assert.equal(ex(tiff(false, [], [{ tag: 0x9286, type: 7, v: Buffer.from('short') }])).userComment, undefined);
});

test('thumbnail location is reported only when it lies inside the data; maker note is sized, not read; serials are opt-in', () => {
  const body = Buffer.alloc(64, 7);
  const mk = (off: number, len: number) => tiff(false, [A(0x010f, 'Canon')], [{ tag: 0x927c, type: 7, v: body }, A(0xa431, 'SN12345'), A(0xa435, 'LENS999')], undefined, [L(0x0201, off), L(0x0202, len)]);
  const good = mk(100, 20);
  const g = ex(good);
  assert.deepEqual(g.thumbnail, { offset: 100, length: 20 });
  assert.deepEqual(g.makerNote, { size: 64 });
  assert.deepEqual([g.bodySerial, g.lensSerial], [undefined, undefined]);
  assert.deepEqual([ex(good, { serials: true }).bodySerial, ex(good, { serials: true }).lensSerial], ['SN12345', 'LENS999']);
  const bad = ex(mk(100, 100_000));
  assert.equal(bad.thumbnail, undefined);
  assert.ok(bad.warnings.some((w) => /thumbnail lies outside/.test(w)));
  assert.equal(ex(mk(2, 10)).thumbnail, undefined, 'inside the header is not a thumbnail');
});

test('containers: JPEG, PNG, WebP and bare TIFF are found; truncation and non-images are handled', () => {
  const t = tiff(false, [A(0x010f, 'Canon')]);
  assert.equal(read(jpeg(exifSeg(t))).exif!.make, 'Canon');
  assert.equal(read(t).exif!.make, 'Canon');
  const crc = Buffer.alloc(4);
  const chunk = (type: string, body: Buffer) => Buffer.concat([Buffer.from([body.length >>> 24, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), Buffer.from(type, 'latin1'), body, crc]);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('eXIf', t), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(read(png).exif!.make, 'Canon');
  const wp = (body: Buffer) => { const h = Buffer.alloc(8); h.write('EXIF', 0, 'latin1'); h.writeUInt32LE(body.length, 4); const rest = Buffer.concat([Buffer.from('WEBP', 'latin1'), h, body, Buffer.alloc(body.length % 2)]); const r = Buffer.alloc(8); r.write('RIFF', 0, 'latin1'); r.writeUInt32LE(rest.length, 4); return Buffer.concat([r, rest]); };
  assert.equal(read(wp(t)).exif!.make, 'Canon');
  assert.equal(read(wp(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]))).exif!.make, 'Canon');
  const cut = jpeg(exifSeg(t)).subarray(0, 20);
  const r = read(cut);
  assert.equal(r.exif, undefined);
  assert.ok(r.warnings.some((w) => /longer than the file/.test(w)));
  assert.throws(() => read(Buffer.from('GIF89a......')), /not a JPEG, PNG, WebP or TIFF/);
  assert.throws(() => read(Buffer.alloc(0)), ExifError);
  assert.equal(read(jpeg()).exif, undefined);
  assert.equal(find(jpeg(exifSeg(t), exifSeg(tiff(false, [A(0x010f, 'Other')])))).tiff!.equals(t), true, 'the first EXIF segment wins');
});

test('a damaged EXIF block in a good file is a warning, not a failure; a flood is a failure', () => {
  const r = read(jpeg(exifSeg(Buffer.from('MM\0*\0\0\0\u0001garbage-and-more', 'latin1'))));
  assert.equal(r.exif, undefined);
  assert.ok(r.warnings.some((w) => /^EXIF:/.test(w)));
  const flood = tiff(false, Array.from({ length: 200 }, (_, i) => S(0x1000 + i, 1)));
  assert.throws(() => read(jpeg(exifSeg(flood)), { maxEntries: 50 }), ExifLimitError);
});

function iim(...sets: [number, number, string | Buffer][]): Buffer {
  return Buffer.concat(sets.map(([rec, ds, d]) => { const data = Buffer.isBuffer(d) ? d : Buffer.from(d, 'latin1'); return Buffer.concat([Buffer.from([0x1c, rec, ds, data.length >> 8, data.length & 255]), data]); }));
}
function photoshop(iptc: Buffer): Buffer {
  const pad = iptc.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const other = Buffer.concat([Buffer.from('8BIM'), Buffer.from([0x04, 0x21, 0, 0]), Buffer.from([0, 0, 0, 3]), Buffer.from('abc'), Buffer.alloc(1)]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(iptc.length);
  return Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), other, Buffer.from('8BIM'), Buffer.from([0x04, 0x04, 0, 0]), size, iptc, pad]);
}

test('IPTC: fields, repeated keywords, UTF-8 declaration, date, and a Photoshop wrapper with padding', () => {
  const block = iim([1, 90, '\u001b%G'], [2, 5, 'Sunset'], [2, 25, 'beach'], [2, 25, 'café'], [2, 80, 'Ana'], [2, 80, 'Bo'], [2, 90, 'Zürich'], [2, 101, 'Switzerland'], [2, 55, '20240704'], [2, 120, 'A caption'], [2, 116, '(c) Ana']);
  const utf = iim([1, 90, '\u001b%G'], [2, 25, Buffer.from('café', 'utf8')], [2, 90, Buffer.from('Zürich', 'utf8')], [2, 5, 'Sunset'], [2, 55, '20240704'], [2, 120, 'A caption'], [2, 80, 'Ana'], [2, 80, 'Bo']);
  const i = parseIptc(utf);
  assert.deepEqual([i.title, i.caption, i.keywords, i.creators, i.city, i.dateCreated], ['Sunset', 'A caption', ['café'], ['Ana', 'Bo'], 'Zürich', '2024-07-04']);
  const latin = parseIptc(iim([2, 90, Buffer.from([0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68])]));
  assert.equal(latin.city, 'Zürich', 'without a charset declaration the text is Latin-1');
  assert.equal(parseIptc(block).keywords.length, 2);
  const fromJpeg = read(jpeg(seg(0xed, photoshop(utf))));
  assert.deepEqual(fromJpeg.iptc!.keywords, ['café']);
  assert.equal(parseIptc(iim([2, 55, '20241399'])).dateCreated, undefined);
  assert.equal(parseIptc(iim([2, 55, '2024-07-04'])).dateCreated, undefined);
});

test('IPTC and Photoshop blocks cut short, with bad markers or with extended lengths, stop with a warning', () => {
  const good = iim([2, 5, 'Title'], [2, 120, 'Caption text']);
  const cut = parseIptc(good.subarray(0, good.length - 4));
  assert.equal(cut.title, 'Title');
  assert.ok(cut.warnings.some((w) => /longer than the block/.test(w)));
  assert.ok(parseIptc(Buffer.concat([good, Buffer.from([0x00, 2, 5, 0, 1, 65])])).warnings.some((w) => /0x1C/.test(w)));
  assert.ok(parseIptc(Buffer.from([0x1c, 2, 120, 0x80, 4, 0, 0, 0, 100])).warnings.some((w) => /extended-length/.test(w)));
  const many = Buffer.concat(Array.from({ length: 50 }, () => iim([2, 25, 'k'])));
  assert.equal(parseIptc(many, { maxDatasets: 10 }).keywords.length, 10);
  const ps = photoshop(good);
  const broken = Buffer.from(ps);
  broken.writeUInt32BE(0x7fffffff, broken.indexOf('8BIM', 15) + 8);
  assert.ok(read(jpeg(seg(0xed, broken))).warnings.some((w) => /longer than the segment/.test(w)));
  assert.ok(read(jpeg(seg(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), Buffer.from('XXXXXXXXXXXXXXXX')])))).warnings.some((w) => /8BIM/.test(w)));
});

const XMP = `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmp:Rating="4" xmp:CreateDate="2024-07-04T18:30:15+02:00" tiff:Make="NIKON CORPORATION" tiff:Model="NIKON D850" photoshop:City="Paris">
<dc:title><rdf:Alt><rdf:li xml:lang="fr">Coucher</rdf:li><rdf:li xml:lang="x-default">Sunset &amp; sea</rdf:li></rdf:Alt></dc:title>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">From the pier</rdf:li></rdf:Alt></dc:description>
<dc:creator><rdf:Seq><rdf:li>Ana</rdf:li><rdf:li>Bo</rdf:li></rdf:Seq></dc:creator>
<dc:subject><rdf:Bag><rdf:li>Beach</rdf:li><rdf:li>sea</rdf:li></rdf:Bag></dc:subject>
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) Ana</rdf:li></rdf:Alt></dc:rights>
<photoshop:Country>France</photoshop:Country>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

test('XMP: attribute and element forms, language alternatives, bags, and the xpacket wrapper', () => {
  const x = parseXmp(XMP);
  assert.deepEqual([x.title, x.description, x.creators, x.keywords, x.rights, x.rating], ['Sunset & sea', 'From the pier', ['Ana', 'Bo'], ['Beach', 'sea'], '(c) Ana', 4]);
  assert.deepEqual([x.make, x.model, x.city, x.country, x.createDate], ['NIKON CORPORATION', 'NIKON D850', 'Paris', 'France', '2024-07-04T18:30:15+02:00']);
  assert.equal(read(jpeg(xmpSeg(XMP))).xmp!.title, 'Sunset & sea');
  const rated = (r: string) => parseXmp(XMP.replace('xmp:Rating="4"', `xmp:Rating="${r}"`)).rating;
  assert.deepEqual(['-1', '6', 'x', '', '0', '5'].map(rated), [undefined, undefined, undefined, undefined, 0, 5]);
  assert.throws(() => parseXmp('<nothing/>'), /no XMP packet/);
});

test('XMP: DTDs, entity bombs, bad XML and oversize are refused without failing the file', () => {
  const bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>' + XMP;
  assert.throws(() => parseXmp(bomb), /not acceptable XML/);
  const xxe = XMP.replace('<x:xmpmeta', '<!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><x:xmpmeta').replace('Sunset &amp; sea', '&e;');
  assert.throws(() => parseXmp(xxe), /not acceptable XML/);
  assert.throws(() => parseXmp(XMP.replace('Sunset &amp; sea', 'Sunset &nbsp; sea')), /not acceptable XML/);
  assert.throws(() => parseXmp(XMP.replace('</rdf:RDF>', '')), /not acceptable XML/);
  const r = read(jpeg(xmpSeg(bomb)));
  assert.equal(r.xmp, undefined);
  assert.ok(r.warnings.some((w) => /^XMP:/.test(w)));
  assert.ok(read(jpeg(xmpSeg(XMP)), { maxXmpBytes: 100 }).warnings.some((w) => /larger than the limit/.test(w)));
});

test('merge: editorial fields by precedence with sidecar first, camera facts from EXIF, keywords joined without duplicates', () => {
  const t = tiff(false, [A(0x010f, 'Canon'), A(0x0110, 'Canon EOS R5'), A(0x010e, 'EXIF description'), A(0x013b, 'Exif Artist'), A(0x8298, 'exif rights')], [A(0x9003, '2024:07:04 18:30:15'), A(0x9011, '+02:00'), A(0xa434, 'RF24-70mm')]);
  const iptc = iim([2, 5, 'IPTC title'], [2, 25, 'Sea'], [2, 25, 'sunset'], [2, 120, 'IPTC caption'], [2, 90, 'Nice'], [2, 95, 'PACA'], [2, 101, 'France'], [2, 110, 'AFP']);
  const m = read(jpeg(exifSeg(t), xmpSeg(XMP), seg(0xed, photoshop(iptc))));
  const out = merge(m);
  assert.deepEqual([out.title, out.caption, out.copyright, out.rating, out.credit], ['Sunset & sea', 'From the pier', '(c) Ana', 4, 'AFP']);
  assert.deepEqual(out.keywords, ['Beach', 'sea', 'sunset'], 'Sea and sea are one keyword; the first spelling stays');
  assert.deepEqual(out.creators, ['Ana', 'Bo']);
  assert.deepEqual([out.camera, out.lens, out.takenAt!.source], ['Canon EOS R5', 'RF24-70mm', 'offset-tag'], 'the sidecar and XMP say Nikon, the sensor says Canon');
  assert.deepEqual(out.place, { city: 'Paris', state: 'PACA', country: 'France' });
  assert.deepEqual([out.from['title'], out.from['credit'], out.from['camera']], ['xmp', 'iptc', 'exif']);
  const sidecar = parseXmp(XMP.replace('Sunset &amp; sea', 'Edited title').replace('xmp:Rating="4"', 'xmp:Rating="1"').replace('NIKON D850', 'Hacked'));
  const s = merge(m, sidecar);
  assert.deepEqual([s.title, s.rating, s.from['title']], ['Edited title', 1, 'sidecar']);
  assert.equal(s.camera, 'Canon EOS R5');
  const bare = merge(read(jpeg(exifSeg(tiff(false, [A(0x013b, 'Only Artist'), A(0x010e, 'Only caption')])))));
  assert.deepEqual([bare.creators, bare.caption, bare.title], [['Only Artist'], 'Only caption', undefined]);
  const noExif = merge(read(jpeg(xmpSeg(XMP))));
  assert.deepEqual([noExif.camera, noExif.takenAt!.utc], ['Nikon D850', '2024-07-04T16:30:15.000Z']);
});

test('withoutLocation removes GPS and place names everywhere and leaves the rest', () => {
  const m = read(PILLOW_JPEG);
  assert.ok(m.exif!.gps);
  const full = read(jpeg(exifSeg(tiff(false, [A(0x010f, 'Canon')], undefined, [A(1, 'N'), R(2, [10, 1], [0, 1], [0, 1]), A(3, 'E'), R(4, [20, 1], [0, 1], [0, 1])])), xmpSeg(XMP), seg(0xed, photoshop(iim([2, 90, 'Nice'], [2, 5, 'T'])))));
  const w = withoutLocation(full);
  assert.deepEqual([w.exif!.gps, w.exif!.make, w.iptc!.city, w.iptc!.title, w.xmp!.city, w.xmp!.country, w.xmp!.title], [undefined, 'Canon', undefined, 'T', undefined, undefined, 'Sunset & sea']);
  assert.ok(full.exif!.gps, 'the original is unchanged');
  assert.equal(merge(w).gps, undefined);
});

test('camera names: brand written once, vendor aliases folded, odd input kept sane', () => {
  const cases: [string | undefined, string | undefined, string | undefined][] = [
    ['NIKON CORPORATION', 'NIKON D850', 'Nikon D850'],
    ['Canon', 'Canon EOS 5D Mark IV', 'Canon EOS 5D Mark IV'],
    ['Canon', 'EOS R5', 'Canon EOS R5'],
    ['SONY', 'ILCE-7M4', 'Sony ILCE-7M4'],
    ['OLYMPUS IMAGING CORP.', 'E-M1MarkII', 'Olympus E-M1MarkII'],
    ['FUJIFILM', 'X-T5', 'Fujifilm X-T5'],
    ['Apple', 'iPhone 15 Pro', 'Apple iPhone 15 Pro'],
    ['Unknown Maker', 'Model 1', 'Unknown Maker Model 1'],
    ['Canon', undefined, 'Canon'],
    [undefined, 'Lone Model', 'Lone Model'],
    [undefined, undefined, undefined],
    ['  Canon\u0000 ', ' EOS  R ', 'Canon EOS R'],
  ];
  for (const [mk, md, want] of cases) assert.equal(normaliseCamera(mk, md), want, `${mk} / ${md}`);
});

test('exposure text: fractions of a second, whole seconds, and nonsense', () => {
  assert.deepEqual([0.004, 1 / 8000, 1 / 3, 0.5, 1, 2, 2.5, 30].map(formatExposure), ['1/250', '1/8000', '1/3', '1/2', '1s', '2s', '2.5s', '30s']);
  assert.deepEqual([0, -1, NaN, Infinity, undefined].map(formatExposure), [undefined, undefined, undefined, undefined, undefined]);
});
