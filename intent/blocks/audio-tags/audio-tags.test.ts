import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Malformed, TagError, Unsupported, applyWrite, buildVorbisComment, commonTags, detect, formatGain, formatPeak, id3Genre, makePicture, parseGain, parsePeak, parseVorbisComment, planWrite, playbackGain, readTags, sniffImage } from './index.ts';

// ---------------------------------------------------------------- fixtures, built here by hand and not with the code under test

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const jpeg = (w: number, h: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const AUDIO = Buffer.from(Array.from({ length: 300 }, (_, i) => (i === 0 ? 0xff : i === 1 ? 0xfb : (i * 7 + 3) & 255)));

const syncsafe = (n: number) => Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const be = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const le = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

function frame(v: 3 | 4, id: string, data: Buffer, flags = 0): Buffer {
  return Buffer.concat([Buffer.from(id, 'latin1'), v === 4 ? syncsafe(data.length) : be(data.length), Buffer.from([flags >> 8, flags & 255]), data]);
}
const txt = (enc: number, s: string) => Buffer.concat([Buffer.from([enc]), enc === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]) : enc === 3 ? Buffer.from(s, 'utf8') : Buffer.from(s, 'latin1')]);
function tag(v: 3 | 4, frames: Buffer[], o: { padding?: number; flags?: number } = {}): Buffer {
  const body = Buffer.concat([...frames, Buffer.alloc(o.padding ?? 0)]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([v, 0, o.flags ?? 0]), syncsafe(body.length), body]);
}
const apic = (mime: string, type: number, desc: string, data: Buffer) => Buffer.concat([Buffer.from([0]), Buffer.from(mime, 'latin1'), Buffer.from([0, type]), Buffer.from(desc, 'latin1'), Buffer.from([0]), data]);
/** The unsynchronisation scheme, written out independently: a zero goes after every FF that is followed by E0 or more, or by zero. */
const unsyncBytes = (b: Buffer) => Buffer.from([...b].flatMap((x, i, a) => (x === 0xff && (i + 1 === a.length || a[i + 1]! >= 0xe0 || a[i + 1] === 0) ? [0xff, 0x00] : [x])));

function streaminfo(rate: number, ch: number, bps: number, total: number): Buffer {
  const v = (BigInt(rate) << 44n) | (BigInt(ch - 1) << 41n) | (BigInt(bps - 1) << 36n) | BigInt(total);
  const b = Buffer.alloc(34);
  b.writeUInt16BE(4096, 0);
  b.writeUInt16BE(4096, 2);
  b.writeBigUInt64BE(v, 10);
  return b;
}
const fblock = (last: boolean, type: number, data: Buffer) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255]), data]);
function flac(o: { comments?: string[]; padding?: number; extra?: Buffer[]; picture?: Buffer; total?: number } = {}): Buffer {
  const blocks: Buffer[] = [fblock(false, 0, streaminfo(44100, 2, 16, o.total ?? 441000))];
  const vc = Buffer.concat([le(5), Buffer.from('flacV'), le((o.comments ?? []).length), ...(o.comments ?? []).flatMap((c) => [le(Buffer.byteLength(c)), Buffer.from(c)])]);
  blocks.push(fblock(false, 4, vc));
  for (const e of o.extra ?? []) blocks.push(e);
  if (o.picture) blocks.push(fblock(false, 6, o.picture));
  blocks.push(fblock(true, 1, Buffer.alloc(o.padding ?? 0)));
  return Buffer.concat([Buffer.from('fLaC'), ...blocks, AUDIO]);
}
const flacPic = (type: number, mime: string, desc: string, data: Buffer) => Buffer.concat([be(type), be(mime.length), Buffer.from(mime), be(desc.length), Buffer.from(desc), be(1), be(1), be(24), be(0), be(data.length), data]);

const atom = (type: string, ...p: Buffer[]) => {
  const body = Buffer.concat(p);
  return Buffer.concat([be(8 + body.length), Buffer.from(type, 'latin1'), body]);
};
const adata = (type: number, payload: Buffer) => atom('data', be(type), be(0), payload);
const item = (name: string, ...d: Buffer[]) => atom(name, ...d);
const freeform = (key: string, value: string) => atom('----', atom('mean', be(0), Buffer.from('com.apple.iTunes')), atom('name', be(0), Buffer.from(key)), adata(1, Buffer.from(value)));
const MARK = Buffer.from('<<<the audio samples>>>');
function mp4(o: { moovFirst: boolean; ilst?: Buffer[]; withMeta?: boolean }): Buffer {
  const ftyp = atom('ftyp', Buffer.from('M4A '), be(0), Buffer.from('M4A isom'));
  const mvhd = atom('mvhd', Buffer.from([0, 0, 0, 0]), be(0), be(0), be(1000), be(61_500), Buffer.alloc(80));
  const build = (off: number) => atom('moov', mvhd, atom('trak', atom('mdia', atom('minf', atom('stbl', atom('stco', be(0), be(1), be(off)))))), ...(o.withMeta === false ? [] : [atom('udta', atom('meta', be(0), atom('hdlr', be(0), be(0), Buffer.from('mdir'), Buffer.alloc(13)), atom('ilst', ...(o.ilst ?? []))))]));
  const mdat = atom('mdat', MARK);
  if (o.moovFirst) {
    const size = build(0).length;
    return Buffer.concat([ftyp, build(ftyp.length + size + 8), mdat]);
  }
  return Buffer.concat([ftyp, mdat, build(ftyp.length + 8)]);
}
function chunkOffset(file: Buffer): number {
  const i = file.indexOf('stco');
  return file.readUInt32BE(i + 12);
}

// ---------------------------------------------------------------- ID3

test('ID3v2.4: a hand-built tag reads back, with the syncsafe sizes', () => {
  const hex = '494433040000000000' + '0c' + '54495432' + '00000002' + '0000' + '0341';
  const file = Buffer.concat([Buffer.from(hex, 'hex'), AUDIO]);
  const r = readTags(file);
  assert.deepEqual([r.format, r.version, r.fields], ['id3', 'ID3v2.4', { TITLE: ['A'] }]);
  const sizes = Buffer.concat([tag(4, [frame(4, 'TIT2', txt(3, 'x'.repeat(200)))])]);
  assert.deepEqual(readTags(Buffer.concat([sizes, AUDIO])).fields.TITLE, ['x'.repeat(200)], 'a frame of 201 bytes has a size that needs two syncsafe bytes');
  assert.deepEqual([...syncsafe(257)], [0, 0, 2, 1]);
  assert.throws(() => readTags(Buffer.from('ID3\x04\x00\x00\x00\x00\x80\x00')), Malformed, 'a size with a high bit is not syncsafe');
});

test('ID3v2.3: encodings, multi-value text, track pairs, dates, genres and comments', () => {
  const t = tag(3, [
    frame(3, 'TIT2', txt(1, 'Café – 日本')),
    frame(3, 'TPE1', Buffer.concat([txt(0, 'Alice'), Buffer.from([0]), Buffer.from('Bob')])),
    frame(3, 'TALB', txt(0, 'The Album')),
    frame(3, 'TRCK', txt(0, '3/12')),
    frame(3, 'TPOS', txt(0, '1/2')),
    frame(3, 'TYER', txt(0, '2020')),
    frame(3, 'TDAT', txt(0, '1705')),
    frame(3, 'TCON', txt(0, '(17)Rock')),
    frame(3, 'COMM', Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from([0]), Buffer.from('nice')])),
    frame(3, 'COMM', Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from('iTunNORM'), Buffer.from([0]), Buffer.from('ignored')])),
    frame(3, 'TXXX', Buffer.concat([Buffer.from([0]), Buffer.from('REPLAYGAIN_TRACK_GAIN'), Buffer.from([0]), Buffer.from('-6.54 dB')])),
    frame(3, 'TXXX', Buffer.concat([Buffer.from([0]), Buffer.from('MusicBrainz Album Id'), Buffer.from([0]), Buffer.from('abc-123')])),
    frame(3, 'UFID', Buffer.concat([Buffer.from('http://musicbrainz.org'), Buffer.from([0]), Buffer.from('rec-1')])),
  ], { padding: 100 });
  const r = readTags(Buffer.concat([t, AUDIO]));
  assert.deepEqual(r.fields, {
    TITLE: ['Café – 日本'], ARTIST: ['Alice', 'Bob'], ALBUM: ['The Album'], TRACKNUMBER: ['3'], TRACKTOTAL: ['12'], DISCNUMBER: ['1'], DISCTOTAL: ['2'],
    DATE: ['2020-05-17'], GENRE: ['Rock'], COMMENT: ['nice'], REPLAYGAIN_TRACK_GAIN: ['-6.54 dB'], MUSICBRAINZ_ALBUMID: ['abc-123'], MUSICBRAINZ_TRACKID: ['rec-1'],
  });
  const c = commonTags(r.fields);
  assert.deepEqual([c.title, c.artists, c.track, c.disc, c.year, c.genres, c.replayGain, c.musicbrainz], ['Café – 日本', ['Alice', 'Bob'], { no: 3, of: 12 }, { no: 1, of: 2 }, 2020, ['Rock'], { trackGain: -6.54 }, { albumid: 'abc-123', trackid: 'rec-1' }]);
});

test('ID3v2.2 frames and ID3v1 trailers are read', () => {
  const f22 = (id: string, d: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from([0, (d.length >> 8) & 255, d.length & 255]), d]);
  const body = Buffer.concat([f22('TT2', txt(0, 'Old Title')), f22('TP1', txt(0, 'Old Artist')), f22('PIC', Buffer.concat([Buffer.from([0]), Buffer.from('PNG'), Buffer.from([3]), Buffer.from([0]), PNG]))]);
  const file = Buffer.concat([Buffer.from('ID3'), Buffer.from([2, 0, 0]), syncsafe(body.length), body, AUDIO]);
  const r = readTags(file);
  assert.deepEqual([r.version, r.fields.TITLE, r.fields.ARTIST, r.pictures.map((p) => [p.type, p.mime, p.data.length])], ['ID3v2.2', ['Old Title'], ['Old Artist'], [[3, 'image/png', PNG.length]]]);
  assert.throws(() => applyWrite(file, { set: { TITLE: 'x' } }), Unsupported);
  const v1 = Buffer.alloc(128);
  v1.write('TAG', 0);
  v1.write('Song', 3);
  v1.write('Singer', 33);
  v1.write('Record', 63);
  v1.write('1999', 93);
  v1[125] = 0;
  v1[126] = 7;
  v1[127] = 17;
  const only = readTags(Buffer.concat([AUDIO, v1]));
  assert.deepEqual([only.version, only.fields], ['ID3v1', { TITLE: ['Song'], ARTIST: ['Singer'], ALBUM: ['Record'], DATE: ['1999'], TRACKNUMBER: ['7'], GENRE: ['Rock'] }]);
  const both = readTags(Buffer.concat([tag(4, [frame(4, 'TIT2', txt(3, 'v2 title'))]), AUDIO, v1]));
  assert.deepEqual([both.fields.TITLE, both.fields.ARTIST], [['v2 title'], ['Singer']], 'v2 wins, v1 fills what v2 lacks');
});

test('unsynchronisation is undone, so a JPEG cover with FF bytes comes out whole', () => {
  const img = jpeg(64, 32);
  const body = Buffer.concat([frame(3, 'TIT2', txt(0, 'T')), frame(3, 'APIC', apic('image/jpeg', 3, 'front', img))]);
  const raw = unsyncBytes(body);
  assert.ok(raw.length > body.length, 'the fixture really had bytes to protect');
  const file = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0x80]), syncsafe(raw.length), raw, AUDIO]);
  const r = readTags(file);
  assert.equal(r.fields.TITLE?.[0], 'T');
  assert.deepEqual([r.pictures.length, r.pictures[0]!.description, Buffer.from(r.pictures[0]!.data).equals(img)], [1, 'front', true]);
  assert.deepEqual(sniffImage(r.pictures[0]!.data), { mime: 'image/jpeg', width: 64, height: 32 });
});

test('writing ID3 keeps unmanaged frames, keeps the audio where it was when the tag fits, and grows it when not', () => {
  const priv = frame(4, 'PRIV', Buffer.concat([Buffer.from('owner@example.test'), Buffer.from([0, 1, 2, 3, 0xff, 0xfe])]));
  const popm = frame(4, 'POPM', Buffer.concat([Buffer.from('me@example.test'), Buffer.from([0, 196, 0, 0, 0, 5])]));
  const original = Buffer.concat([tag(4, [frame(4, 'TIT2', txt(3, 'Old')), priv, popm], { padding: 500 }), AUDIO]);
  const out = applyWrite(original, { set: { TITLE: 'A much better title', ARTIST: ['One', 'Two'], 'TRACKNUMBER': '4', TRACKTOTAL: '9' } });
  assert.equal(out.length, original.length, 'it fit in the padding');
  assert.ok(out.subarray(out.length - AUDIO.length).equals(AUDIO));
  assert.ok(out.includes(priv) && out.includes(popm), 'frames not managed here are byte for byte the same');
  const r = readTags(out);
  assert.deepEqual([r.fields.TITLE, r.fields.ARTIST, r.fields.TRACKNUMBER, r.fields.TRACKTOTAL], [['A much better title'], ['One', 'Two'], ['4'], ['9']]);
  const big = applyWrite(out, { set: { COMMENT: 'c'.repeat(3000) } });
  assert.ok(big.length > out.length);
  assert.ok(big.subarray(big.length - AUDIO.length).equals(AUDIO), 'the audio is untouched at the end');
  assert.equal(readTags(big).fields.COMMENT?.[0]?.length, 3000);
  assert.ok(big.includes(priv));
  const removed = applyWrite(big, { remove: ['comment', 'artist'] });
  assert.deepEqual([readTags(removed).fields.COMMENT, readTags(removed).fields.ARTIST], [undefined, undefined]);
  const fresh = applyWrite(AUDIO, { set: { TITLE: 'On a file with no tag' } });
  assert.deepEqual([detect(fresh), readTags(fresh).version, fresh.subarray(fresh.length - AUDIO.length).equals(AUDIO)], ['id3', 'ID3v2.4', true]);
  assert.deepEqual(applyWrite(out, { set: { TITLE: '' } }).includes('Old'), false);
});

test('an ID3v2.3 file stays v2.3 and non-Latin text is written as UTF-16 it can read back', () => {
  const original = Buffer.concat([tag(3, [frame(3, 'TIT2', txt(0, 'Old'))], { padding: 300 }), AUDIO]);
  const out = applyWrite(original, { set: { TITLE: '日本語', ALBUM: 'Plain', DATE: '2021-03-04', COMMENT: 'über', LYRICS: 'la la' } });
  const r = readTags(out);
  assert.deepEqual([r.version, r.fields.TITLE, r.fields.ALBUM, r.fields.DATE, r.fields.COMMENT, r.fields.LYRICS], ['ID3v2.3', ['日本語'], ['Plain'], ['2021-03-04'], ['über'], ['la la']]);
  assert.ok(out.includes(Buffer.from('TYER')) && out.includes(Buffer.from('TDAT')) && !out.includes(Buffer.from('TDRC')), 'v2.3 has no TDRC');
});

test('pictures: added, replaced and removed by type, and a wrong or broken image is refused', () => {
  const front = makePicture(jpeg(64, 32), { type: 3, description: 'front' });
  const back = makePicture(PNG, { type: 4 });
  let f = applyWrite(AUDIO, { pictures: { add: [front, back] } });
  assert.deepEqual(readTags(f).pictures.map((p) => [p.type, p.mime, p.description]), [[3, 'image/jpeg', 'front'], [4, 'image/png', '']]);
  f = applyWrite(f, { pictures: { removeTypes: [4] } });
  assert.deepEqual(readTags(f).pictures.map((p) => p.type), [3]);
  f = applyWrite(f, { pictures: { replace: [back] } });
  assert.deepEqual(readTags(f).pictures.map((p) => p.type), [4]);
  f = applyWrite(f, { pictures: { removeAll: true } });
  assert.equal(readTags(f).pictures.length, 0);
  assert.throws(() => makePicture(PNG, { mime: 'image/jpeg' }), /says image\/jpeg but is image\/png/);
  assert.throws(() => makePicture(Buffer.from('not an image')), /not a JPEG/);
  assert.throws(() => makePicture(Buffer.alloc(0)), /1 byte/);
  assert.throws(() => makePicture(PNG, { type: 21 }), /0 to 20/);
  assert.throws(() => applyWrite(AUDIO, { pictures: { add: [{ type: 3, mime: 'image/png', description: '', data: Buffer.from('junk') }] } }), TagError);
});

// ---------------------------------------------------------------- FLAC and Vorbis comments

test('Vorbis comments: names are case-insensitive, repeated, and the codec round-trips', () => {
  const b = buildVorbisComment('vendor 1.0', { TITLE: ['Song'], ARTIST: ['A', 'B'], DATE: ['2020'] });
  assert.deepEqual(parseVorbisComment(b), { vendor: 'vendor 1.0', fields: { TITLE: ['Song'], ARTIST: ['A', 'B'], DATE: ['2020'] } });
  const odd = Buffer.concat([le(1), Buffer.from('v'), le(3), le(9), Buffer.from('title=abc'), le(5), Buffer.from('nokey'), le(8), Buffer.from('=novalue')]);
  assert.deepEqual(parseVorbisComment(odd).fields, { TITLE: ['abc'] }, 'entries without a valid name are skipped');
  assert.throws(() => parseVorbisComment(Buffer.concat([le(100), Buffer.from('v')])), Malformed);
  assert.throws(() => parseVorbisComment(Buffer.concat([le(0), le(2_000_000)])), /too many/);
  assert.throws(() => parseVorbisComment(Buffer.concat([le(0), le(1), le(50), Buffer.from('x=y')])), Malformed);
});

test('FLAC: tags, duration and cover art are read from the metadata blocks', () => {
  const file = flac({ comments: ['TITLE=Song', 'artist=Someone', 'ARTIST=Else', 'TRACKNUMBER=3/12', 'YEAR=1999', 'REPLAYGAIN_TRACK_GAIN=-6.54 dB', 'REPLAYGAIN_TRACK_PEAK=0.988553'], padding: 64, picture: flacPic(3, 'image/png', 'cover', PNG) });
  const r = readTags(file);
  assert.equal(r.format, 'flac');
  assert.deepEqual(r.audio, { sampleRate: 44100, channels: 2, bitsPerSample: 16, durationSec: 10 });
  assert.deepEqual(r.fields, { TITLE: ['Song'], ARTIST: ['Someone', 'Else'], TRACKNUMBER: ['3'], TRACKTOTAL: ['12'], DATE: ['1999'], REPLAYGAIN_TRACK_GAIN: ['-6.54 dB'], REPLAYGAIN_TRACK_PEAK: ['0.988553'] });
  assert.deepEqual(r.pictures.map((p) => [p.type, p.mime, p.description, p.data.length]), [[3, 'image/png', 'cover', PNG.length]]);
  assert.equal(detect(Buffer.concat([tag(4, [frame(4, 'TIT2', txt(3, 'x'))]), file])), 'flac', 'an ID3 tag in front of FLAC is skipped');
  assert.equal(readTags(Buffer.concat([tag(4, [frame(4, 'TIT2', txt(3, 'x'))]), file])).fields.TITLE?.[0], 'Song');
});

test('FLAC writes go into the padding so the audio does not move, and grow the file only when they must', () => {
  const original = flac({ comments: ['TITLE=Old'], padding: 4000, extra: [fblock(false, 3, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))] });
  const small = applyWrite(original, { set: { TITLE: 'New title', ARTIST: 'Someone' } });
  assert.equal(small.length, original.length, 'same size: it used the padding');
  assert.ok(small.subarray(small.length - AUDIO.length).equals(AUDIO));
  assert.ok(small.includes(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), 'the seek table block is kept');
  assert.deepEqual([readTags(small).fields.TITLE, readTags(small).fields.ARTIST, readTags(small).audio.durationSec], [['New title'], ['Someone'], 10]);
  const bigJpeg = Buffer.concat([jpeg(64, 32), Buffer.alloc(6000, 0x55)]);
  const withArt = applyWrite(small, { pictures: { add: [makePicture(bigJpeg)] } });
  assert.ok(withArt.length > small.length, 'a cover does not fit in 4000 bytes of padding with the rest');
  assert.deepEqual(readTags(withArt).pictures.map((p) => [p.mime, p.data.length]), [['image/jpeg', bigJpeg.length]]);
  assert.ok(withArt.subarray(withArt.length - AUDIO.length).equals(AUDIO));
  const trimmed = applyWrite(withArt, { pictures: { removeAll: true }, remove: ['ARTIST'] });
  assert.equal(readTags(trimmed).pictures.length, 0);
  assert.equal(readTags(trimmed).fields.ARTIST, undefined);
  const last = trimmed.subarray(4);
  assert.ok((last[0]! & 0x7f) === 0, 'STREAMINFO is still first');
  assert.throws(() => applyWrite(original, { set: { 'BAD=NAME': 'x' } }), /bad field name/);
  assert.throws(() => applyWrite(original, { set: { TITLE: 'a\u0000b' } }), /NUL/);
});

// ---------------------------------------------------------------- MP4

const text = (name: string, s: string) => item(name, adata(1, Buffer.from(s)));
const ILST = [text('©nam', 'Song'), text('©ART', 'Artist'), text('©alb', 'Album'), text('aART', 'Album Artist'), text('©day', '2020-05-17'), item('trkn', adata(0, Buffer.from([0, 0, 0, 3, 0, 12, 0, 0]))), item('disk', adata(0, Buffer.from([0, 0, 0, 1, 0, 2]))), item('tmpo', adata(21, Buffer.from([0, 120]))), item('gnre', adata(0, Buffer.from([0, 18]))), item('cpil', adata(21, Buffer.from([1]))), freeform('REPLAYGAIN_TRACK_GAIN', '-6.54 dB'), freeform('MusicBrainz Track Id', 'trk-1'), item('covr', adata(14, PNG))];

test('MP4: iTunes atoms are read: text, pairs, tempo, genre numbers, freeform, cover and duration', () => {
  const r = readTags(mp4({ moovFirst: true, ilst: ILST }));
  assert.equal(r.format, 'mp4');
  assert.equal(r.audio.durationSec, 61.5);
  assert.deepEqual(r.fields, { TITLE: ['Song'], ARTIST: ['Artist'], ALBUM: ['Album'], ALBUMARTIST: ['Album Artist'], DATE: ['2020-05-17'], TRACKNUMBER: ['3'], TRACKTOTAL: ['12'], DISCNUMBER: ['1'], DISCTOTAL: ['2'], BPM: ['120'], GENRE: ['Rock'], REPLAYGAIN_TRACK_GAIN: ['-6.54 dB'], MUSICBRAINZ_TRACKID: ['trk-1'] });
  assert.deepEqual(r.pictures.map((p) => [p.mime, p.data.length]), [['image/png', PNG.length]]);
});

test('MP4 writes keep unknown atoms and fix the chunk offsets when the header moves the audio', () => {
  for (const moovFirst of [true, false]) {
    const original = mp4({ moovFirst, ilst: ILST });
    assert.ok(original.subarray(chunkOffset(original), chunkOffset(original) + MARK.length).equals(MARK), 'fixture: the offset points at the audio');
    const out = applyWrite(original, { set: { TITLE: 'A much longer title than before, to move things', COMPOSER: 'Composer', MUSICBRAINZ_ALBUMID: 'alb-9' }, remove: ['ALBUMARTIST'], pictures: { removeAll: true } });
    const r = readTags(out);
    assert.deepEqual([r.fields.TITLE, r.fields.COMPOSER, r.fields.MUSICBRAINZ_ALBUMID, r.fields.ALBUMARTIST, r.fields.TRACKNUMBER, r.fields.REPLAYGAIN_TRACK_GAIN, r.pictures.length, r.audio.durationSec], [['A much longer title than before, to move things'], ['Composer'], ['alb-9'], undefined, ['3'], ['-6.54 dB'], 0, 61.5]);
    assert.ok(out.subarray(chunkOffset(out), chunkOffset(out) + MARK.length).equals(MARK), `chunk offset still points at the audio (moov ${moovFirst ? 'first' : 'last'})`);
    assert.ok(out.includes(item('cpil', adata(21, Buffer.from([1])))), 'an atom this block does not manage is kept byte for byte');
    assert.equal(moovFirst ? out.length !== original.length : true, true);
  }
});

test('MP4 with no tag area gets one, and a cover is stored with the right type', () => {
  const bare = mp4({ moovFirst: true, withMeta: false });
  assert.deepEqual(readTags(bare).fields, {});
  const out = applyWrite(bare, { set: { TITLE: 'Fresh', TRACKNUMBER: '2', TRACKTOTAL: '8' }, pictures: { add: [makePicture(jpeg(64, 32))] } });
  const r = readTags(out);
  assert.deepEqual([r.fields.TITLE, r.fields.TRACKNUMBER, r.fields.TRACKTOTAL, r.pictures[0]!.mime], [['Fresh'], ['2'], ['8'], 'image/jpeg']);
  assert.ok(out.subarray(chunkOffset(out), chunkOffset(out) + MARK.length).equals(MARK));
});

// ---------------------------------------------------------------- the rest

test('ReplayGain text is parsed and written in its usual form, and the playback gain respects peaks', () => {
  assert.deepEqual(['-6.54 dB', '+3.2dB', '−6.54', '0', 'loud'].map(parseGain), [-6.54, 3.2, -6.54, 0, undefined]);
  assert.equal(parseGain('999 dB'), undefined);
  assert.deepEqual([parsePeak('0.988553'), parsePeak('-1'), parsePeak('x')], [0.988553, undefined, undefined]);
  assert.deepEqual([formatGain(-6.5), formatGain(3), formatPeak(0.5)], ['-6.50 dB', '3.00 dB', '0.500000']);
  const f = { REPLAYGAIN_TRACK_GAIN: ['-6.00 dB'], REPLAYGAIN_ALBUM_GAIN: ['-3.00 dB'], REPLAYGAIN_TRACK_PEAK: ['0.9'], REPLAYGAIN_ALBUM_PEAK: ['0.5'] };
  const t = playbackGain(f);
  assert.deepEqual([t.source, t.db, t.clipped], ['track', -6, false]);
  assert.ok(Math.abs(t.linear - 10 ** (-6 / 20)) < 1e-12);
  assert.equal(playbackGain(f, { mode: 'album' }).db, -3);
  const loud = playbackGain({ REPLAYGAIN_TRACK_GAIN: ['+6.00 dB'], REPLAYGAIN_TRACK_PEAK: ['0.9'] });
  assert.deepEqual([loud.clipped, Math.round(loud.linear * 1e6) / 1e6], [true, Math.round((1 / 0.9) * 1e6) / 1e6]);
  assert.equal(playbackGain({ REPLAYGAIN_TRACK_GAIN: ['+6.00 dB'], REPLAYGAIN_TRACK_PEAK: ['0.9'] }, { preventClipping: false }).clipped, false);
  assert.deepEqual([playbackGain({}).source, playbackGain({}, { fallbackDb: -8, preampDb: 2 }).db], ['none', -6]);
  assert.equal(playbackGain({ REPLAYGAIN_ALBUM_GAIN: ['-3.00 dB'] }).source, 'album', 'a track with only album gain uses it');
});

test('images are recognised by their bytes, with their size', () => {
  assert.deepEqual(sniffImage(PNG), { mime: 'image/png', width: 1, height: 1 });
  assert.deepEqual(sniffImage(jpeg(640, 480)), { mime: 'image/jpeg', width: 640, height: 480 });
  assert.deepEqual(sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.from([10, 0, 20, 0])])), { mime: 'image/gif', width: 10, height: 20 });
  const webp = Buffer.concat([Buffer.from('RIFF'), le(22), Buffer.from('WEBPVP8X'), le(10), Buffer.from([0, 0, 0, 0]), Buffer.from([99, 0, 0]), Buffer.from([49, 0, 0]), Buffer.alloc(4)]);
  assert.deepEqual(sniffImage(webp), { mime: 'image/webp', width: 100, height: 50 });
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0x00])), undefined);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined, 'SVG is not accepted as cover art');
  assert.equal(sniffImage(Buffer.alloc(0)), undefined);
});

test('genres from ID3 numbers and parentheses', () => {
  assert.deepEqual(id3Genre('(17)'), ['Rock']);
  assert.deepEqual(id3Genre('(17)(13)'), ['Rock', 'Pop']);
  assert.deepEqual(id3Genre('(17)Hard Rock Revival'), ['Rock', 'Hard Rock Revival']);
  assert.deepEqual(id3Genre('13'), ['Pop']);
  assert.deepEqual(id3Genre('(RX)'), ['Remix']);
  assert.deepEqual(id3Genre('Shoegaze'), ['Shoegaze']);
  assert.deepEqual(id3Genre('(250)'), ['(250)']);
});

test('a plan says what a write would do before it does it', () => {
  const original = Buffer.concat([tag(4, [frame(4, 'TIT2', txt(3, 'Old'))], { padding: 500 }), AUDIO]);
  const p = planWrite(original, { set: { TITLE: 'New', ARTIST: 'Someone' }, remove: ['ALBUM'] });
  assert.deepEqual([p.format, p.inPlace, p.bytesBefore, p.bytesAfter, p.fieldsChanged, p.picturesBefore, p.picturesAfter], ['id3', true, original.length, original.length, ['ARTIST', 'TITLE'], 0, 0]);
  const q = planWrite(original, { pictures: { add: [makePicture(jpeg(640, 480))] } });
  assert.deepEqual([q.picturesAfter, q.fieldsChanged], [1, []]);
  const f = planWrite(flac({ comments: ['TITLE=Old'], padding: 20 }), { set: { COMMENT: 'x'.repeat(100) } });
  assert.deepEqual([f.format, f.inPlace], ['flac', false]);
});

test('truncated and hostile files fail with a clear error, not a crash or a wild read', () => {
  const good = flac({ comments: ['TITLE=x'], padding: 10 });
  for (let n = 4; n < 60; n += 7) assert.throws(() => readTags(good.subarray(0, n)), Malformed, `cut at ${n}`);
  assert.throws(() => readTags(Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0xff, 0xff, 0xff]), Buffer.alloc(8)])), Malformed, 'a block claiming 16 MiB');
  assert.throws(() => readTags(Buffer.concat([Buffer.from('fLaC'), fblock(true, 1, Buffer.alloc(34))])), /STREAMINFO/);
  assert.throws(() => readTags(Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), syncsafe(5000), Buffer.alloc(20)])), /runs past/);
  assert.throws(() => readTags(Buffer.concat([Buffer.from('ID3'), Buffer.from([9, 0, 0]), syncsafe(10), Buffer.alloc(20)])), Unsupported);
  const lying = Buffer.concat([tag(4, [Buffer.concat([Buffer.from('TIT2'), syncsafe(9000), Buffer.from([0, 0]), txt(3, 'abc')])]), AUDIO]);
  assert.deepEqual(readTags(lying).fields, {}, 'a frame that claims more than the tag holds ends the parse');
  const m = mp4({ moovFirst: true, ilst: ILST });
  const bad = Buffer.from(m);
  bad.writeUInt32BE(0x7fffffff, 20 + 8);
  assert.throws(() => readTags(bad), Malformed);
  assert.throws(() => readTags(m.subarray(0, 30)), Malformed);
  let deep = atom('free');
  for (let i = 0; i < 30; i++) deep = atom('trak', deep);
  assert.throws(() => applyWrite(Buffer.concat([atom('ftyp', Buffer.from('M4A '), be(0)), atom('moov', deep), atom('mdat', MARK)]), { set: { TITLE: 'x' } }), /nested too deeply/);
  assert.throws(() => readTags(Buffer.from('OggS\u0000\u0002')), /Ogg/);
  assert.throws(() => readTags(Buffer.from('random bytes that are not audio')), Unsupported);
  assert.throws(() => applyWrite(Buffer.from('OggS....'), { set: { TITLE: 'x' } }), /cannot be written/);
  assert.equal(detect(Buffer.alloc(0)), 'unknown');
  assert.throws(() => applyWrite(AUDIO, { set: { ['a'.repeat(65)]: 'x' } }), /bad field name/);
});
