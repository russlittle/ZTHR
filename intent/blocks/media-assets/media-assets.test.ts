import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { InUse, Library, MediaError, altProblem, cleanName, planDerivative, sniff, srcsetWidths, svgDanger } from './index.ts';

// ------------------------------------------------------------ fixtures built byte by byte

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const text = (s: string) => [...Buffer.from(s, 'latin1')];
const png = (w: number, h: number, pad = 0) => Uint8Array.from([0x89, ...text('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...text('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...Array(pad).fill(7)]);
const gif = (w: number, h: number) => Uint8Array.from([...text('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0, 0, 0]);
const jpeg = (w: number, h: number) =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...text('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xdb, 0, 4, 1, 2, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda, 0, 2]);
const riff = (chunk: string, data: number[]) => Uint8Array.from([...text('RIFF'), ...le16(0), 0, 0, ...text('WEBP'), ...text(chunk), ...le16(data.length), 0, 0, ...data]);
const webpX = (w: number, h: number) => riff('VP8X', [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = (w: number, h: number) => {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return riff('VP8L', [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const webpLossy = (w: number, h: number) => riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
const avif = (w: number, h: number) => Uint8Array.from([...be32(28), ...text('ftyp'), ...text('avif'), 0, 0, 0, 0, ...text('avifmif1'), ...be32(20), ...text('ispe'), 0, 0, 0, 0, ...be32(w), ...be32(h)]);
const svg = (body = '<rect width="10" height="10"/>', attrs = 'width="120" height="80"') => Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`);

const make = (o: Partial<ConstructorParameters<typeof Library>[0]> = {}) => {
  let n = 0;
  return new Library({ newId: () => `id${++n}`, now: () => 1000 + n, ...o });
};

// ------------------------------------------------------------ reading bytes

test('each format is recognised from its bytes with its pixel size', () => {
  assert.deepEqual(sniff(png(640, 480)), { mime: 'image/png', ext: 'png', width: 640, height: 480 });
  assert.deepEqual(sniff(gif(33, 22)), { mime: 'image/gif', ext: 'gif', width: 33, height: 22 });
  assert.deepEqual(sniff(jpeg(1920, 1080)), { mime: 'image/jpeg', ext: 'jpg', width: 1920, height: 1080 });
  assert.deepEqual(sniff(webpX(4000, 3000)), { mime: 'image/webp', ext: 'webp', width: 4000, height: 3000 });
  assert.deepEqual(sniff(webpL(321, 123)), { mime: 'image/webp', ext: 'webp', width: 321, height: 123 });
  assert.deepEqual(sniff(webpLossy(800, 600)), { mime: 'image/webp', ext: 'webp', width: 800, height: 600 });
  assert.deepEqual(sniff(avif(1024, 768)), { mime: 'image/avif', ext: 'avif', width: 1024, height: 768 });
  assert.deepEqual(sniff(svg()), { mime: 'image/svg+xml', ext: 'svg', width: 120, height: 80 });
  assert.deepEqual(sniff(svg('', 'viewBox="0 0 24 16"')), { mime: 'image/svg+xml', ext: 'svg', width: 24, height: 16 });
  assert.equal(sniff(Buffer.from('%PDF-1.7\n'))?.mime, 'application/pdf');
  assert.equal(sniff(Uint8Array.from([0, 0, 0, 24, ...text('ftypisom'), 0, 0, 2, 0]))?.mime, 'video/mp4');
  assert.equal(sniff(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))?.mime, 'video/webm');
  assert.equal(sniff(Buffer.from('ID3\u0004'))?.mime, 'audio/mpeg');
});

test('unknown, tiny, truncated and lying bytes never throw and never claim a size they do not hold', () => {
  assert.equal(sniff(new Uint8Array(0)), undefined);
  assert.equal(sniff(Buffer.from('hello world')), undefined);
  assert.equal(sniff(Buffer.from('<html><svg></svg></html>')), undefined);
  assert.deepEqual(sniff(png(0, 10)), { mime: 'image/png', ext: 'png' }, 'a zero size is not believed');
  assert.deepEqual(sniff(png(10, 10).subarray(0, 24)), { mime: 'image/png', ext: 'png', width: 10, height: 10 });
  assert.equal(sniff(png(10, 10).subarray(0, 12)), undefined);
  assert.deepEqual(sniff(jpeg(10, 10).subarray(0, 12)), { mime: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniff(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), { mime: 'image/jpeg', ext: 'jpg' }, 'a zero length segment does not loop forever');
  assert.deepEqual(sniff(avif(5, 5).subarray(0, 30)), { mime: 'image/avif', ext: 'avif' });
});

test('SVG that could run code or fetch from elsewhere is named and refused', () => {
  for (const [body, why] of [
    ['<script>alert(1)</script>', 'script'],
    ['<rect onclick="x()"/>', 'event handler'],
    ['<foreignObject><div/></foreignObject>', 'foreign'],
    ['<a href="javascript:alert(1)"/>', 'script'],
    ['<image href="https://evil.example/x.png"/>', 'another site'],
    ['<image xlink:href="//evil.example/x.png"/>', 'another site'],
    ['<rect style="fill:url(https://evil.example/a)"/>', 'another site'],
    ['<iframe src="x"/>', 'page or plug-in'],
  ] as const) assert.match(svgDanger(`<svg>${body}</svg>`) ?? '', new RegExp(why), body);
  assert.match(svgDanger('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>') ?? '', /entities/);
  assert.equal(svgDanger('<svg><rect width="1"/><use href="#a"/></svg>'), undefined);
  const lib = make();
  assert.throws(() => lib.upload({ name: 'a.svg', bytes: svg('<script>1</script>') }), /SVG was refused: it contains a script/);
  assert.equal(make({ allowActiveSvg: true }).upload({ name: 'a.svg', bytes: svg('<script>1</script>') }).mime, 'image/svg+xml');
});

// ------------------------------------------------------------ uploads

test('an upload keeps what the bytes say, with size, checksum and a centred focal point', () => {
  const lib = make();
  const bytes = png(640, 480, 100);
  const a = lib.upload({ name: 'Cat.PNG', bytes, claimedMime: 'image/png; charset=binary', tags: ['pets', 'pets'] });
  assert.equal(a.mime, 'image/png');
  assert.equal(a.width, 640);
  assert.equal(a.size, bytes.length);
  assert.equal(a.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(a.focal, { x: 0.5, y: 0.5 });
  assert.deepEqual(a.tags, ['pets']);
  assert.equal(a.revision, 1);
});

test('mislabelled, oversized, empty and unwanted files are refused with the reason', () => {
  const lib = make({ maxBytes: 200, allowed: ['image/png', 'image/jpeg'] });
  assert.throws(() => lib.upload({ name: 'a.png', bytes: png(1, 1), claimedMime: 'image/jpeg' }), /says image\/jpeg but its bytes are image\/png/);
  assert.throws(() => lib.upload({ name: 'a.jpg', bytes: png(1, 1) }), /ends in \.jpg but the bytes are image\/png/);
  assert.throws(() => lib.upload({ name: 'a.png', bytes: png(1, 1, 500) }), /limit is 200/);
  assert.throws(() => lib.upload({ name: 'a.png', bytes: new Uint8Array(0) }), /empty/);
  assert.throws(() => lib.upload({ name: 'a.txt', bytes: Buffer.from('plain') }), /not a kind this library holds/);
  assert.throws(() => lib.upload({ name: 'a.gif', bytes: gif(1, 1) }), /image\/gif files are not accepted/);
  assert.throws(() => lib.upload({ name: 'a.png', bytes: png(1, 1), folderId: 'nope' }), /no folder/);
  assert.equal(lib.upload({ name: 'photo.jpeg', bytes: jpeg(5, 5) }).ext, 'jpg', '.jpeg is a fine name for a jpeg');
  assert.equal(lib.upload({ name: 'noext', bytes: png(1, 1) }).name, 'noext');
});

test('names cannot hold path tricks, control characters or reserved device names', () => {
  for (const bad of ['', '  ', '.', '..', '...', 'a/b.png', 'a\\b.png', 'a\u0000.png', 'x\n.png', 'COM1.png', 'nul', 'trailing.', 'x'.repeat(201), 'a:b', 'a*b']) assert.throws(() => cleanName(bad), MediaError, JSON.stringify(bad.slice(0, 20)));
  assert.equal(cleanName('  Café.png '), 'Café.png');
  assert.equal(cleanName('é.png'), 'é.png', 'names are put in one Unicode form');
});

test('a name already taken gets a number, ignoring case', () => {
  const lib = make();
  const a = lib.upload({ name: 'cat.png', bytes: png(1, 1) });
  const b = lib.upload({ name: 'CAT.png', bytes: png(2, 2) });
  const c = lib.upload({ name: 'cat.png', bytes: png(3, 3) });
  assert.deepEqual([a.name, b.name, c.name], ['cat.png', 'CAT (2).png', 'cat (3).png']);
  const f = lib.createFolder('Pets');
  assert.equal(lib.upload({ name: 'cat.png', bytes: png(1, 1), folderId: f.id }).name, 'cat.png', 'another folder, no clash');
  assert.equal(lib.upload({ name: 'pets', bytes: png(1, 1) }).name, 'pets (2)', 'a file cannot take a folder name either');
});

// ------------------------------------------------------------ folders

test('folders have unique names per level, cannot be moved into themselves, and are deleted only when empty', () => {
  const lib = make();
  const a = lib.createFolder('2026');
  const b = lib.createFolder('Spring', a.id);
  const c = lib.createFolder('Banners', b.id);
  assert.equal(lib.folderPath(c.id), '2026/Spring/Banners');
  assert.throws(() => lib.createFolder('spring', a.id), /already a folder called "Spring"/);
  assert.equal(lib.createFolder('Spring').parentId, undefined, 'the same name at another level is fine');
  assert.throws(() => lib.moveFolder(a.id, c.id), /inside itself/);
  assert.throws(() => lib.moveFolder(a.id, a.id), /inside itself/);
  assert.equal(lib.moveFolder(c.id, undefined).parentId, undefined);
  assert.throws(() => lib.renameFolder(c.id, '2026'), /already a folder/);
  assert.equal(lib.renameFolder(c.id, 'Heroes').name, 'Heroes');
  lib.upload({ name: 'x.png', bytes: png(1, 1), folderId: b.id });
  assert.throws(() => lib.deleteFolder(b.id), /holds 0 folder\(s\) and 1 file\(s\)/);
  assert.throws(() => lib.deleteFolder(a.id), /holds 1 folder\(s\)/);
  lib.deleteFolder(c.id);
  assert.throws(() => lib.folderPath(c.id), /no folder/);
});

test('files rename and move without losing their format or clashing', () => {
  const lib = make();
  const f = lib.createFolder('Docs');
  const a = lib.upload({ name: 'a.png', bytes: png(1, 1) });
  lib.upload({ name: 'b.png', bytes: png(1, 1), folderId: f.id });
  assert.throws(() => lib.rename(a.id, 'a.jpg'), /cannot be renamed \.jpg/);
  assert.equal(lib.rename(a.id, 'b.png').name, 'b.png');
  assert.throws(() => lib.moveAsset(a.id, f.id), /already a file called "b.png"/);
  assert.equal(lib.rename(a.id, 'c.png').name, 'c.png');
  assert.equal(lib.moveAsset(a.id, f.id).folderId, f.id);
  assert.equal(lib.moveAsset(a.id, undefined).folderId, undefined);
  assert.deepEqual(lib.find({ folderId: f.id }).map((x) => x.name), ['b.png']);
});

// ------------------------------------------------------------ focal points and derivatives

test('a focal point is between 0 and 1, and only for images', () => {
  const lib = make();
  const a = lib.upload({ name: 'a.png', bytes: png(100, 100) });
  const p = lib.upload({ name: 'a.pdf', bytes: Buffer.from('%PDF-1.4') });
  assert.deepEqual(lib.setFocal(a.id, { x: 0.1, y: 0.9 }).focal, { x: 0.1, y: 0.9 });
  for (const bad of [{ x: -0.1, y: 0 }, { x: 0, y: 1.1 }, { x: NaN, y: 0.5 }]) assert.throws(() => lib.setFocal(a.id, bad), /between 0 and 1/);
  assert.throws(() => lib.setFocal(p.id, { x: 0.5, y: 0.5 }), /only an image/);
});

const base = { id: 'a1', mime: 'image/jpeg', sha256: 'abc', revision: 1, focal: { x: 0.5, y: 0.5 }, width: 4000, height: 3000 };

test('a cover crop is centred on the focal point and kept inside the picture', () => {
  const wide = planDerivative(base, { name: 'banner', width: 1200, height: 400, fit: 'cover' });
  assert.deepEqual(wide.source, { x: 0, y: 834, width: 4000, height: 1333 });
  assert.deepEqual(wide.output, { width: 1200, height: 400 });
  const sq = planDerivative({ ...base, focal: { x: 0.9, y: 0.5 } }, { name: 'square', width: 300, height: 300, fit: 'cover' });
  assert.deepEqual(sq.source, { x: 1000, y: 0, width: 3000, height: 3000 }, 'pushed against the right edge, not past it');
  const left = planDerivative({ ...base, focal: { x: 0, y: 0 } }, { name: 'square', width: 300, height: 300, fit: 'cover' });
  assert.deepEqual(left.source, { x: 0, y: 0, width: 3000, height: 3000 });
  const tall = planDerivative({ ...base, focal: { x: 0.25, y: 0.5 } }, { name: 'tall', width: 200, height: 400, fit: 'cover' });
  assert.deepEqual(tall.source, { x: 250, y: 0, width: 1500, height: 3000 });
});

test('derivatives are never enlarged', () => {
  const small = { ...base, width: 200, height: 100 };
  assert.deepEqual(planDerivative(small, { name: 'big', width: 400, height: 400, fit: 'cover' }).output, { width: 100, height: 100 });
  assert.deepEqual(planDerivative(base, { name: 'fit', width: 800, height: 800, fit: 'inside' }).output, { width: 800, height: 600 });
  assert.deepEqual(planDerivative({ ...base, width: 500, height: 400 }, { name: 'fit', width: 800, height: 800, fit: 'inside' }).output, { width: 500, height: 400 });
  assert.deepEqual(planDerivative(base, { name: 'fit', width: 800, height: 800, fit: 'inside' }).source, { x: 0, y: 0, width: 4000, height: 3000 });
});

test('the derivative key changes with the file, its revision, the focal point and the preset, and the format follows the preset', () => {
  const spec = { name: 'card', width: 400, height: 300, fit: 'cover' as const };
  const k = planDerivative(base, spec).key;
  assert.match(k, /^[0-9a-f]{16}$/);
  assert.equal(planDerivative({ ...base }, spec).key, k, 'the same input gives the same key');
  assert.notEqual(planDerivative({ ...base, sha256: 'abd' }, spec).key, k);
  assert.notEqual(planDerivative({ ...base, revision: 2 }, spec).key, k);
  assert.notEqual(planDerivative({ ...base, focal: { x: 0.4, y: 0.5 } }, spec).key, k);
  assert.notEqual(planDerivative(base, { ...spec, width: 401 }).key, k);
  const webp = planDerivative(base, { ...spec, format: 'image/webp' });
  assert.equal(webp.path, `a1/card-${webp.key}.webp`);
  assert.equal(planDerivative(base, spec).path, `a1/card-${k}.jpg`);
  assert.throws(() => planDerivative(base, { ...spec, format: 'image/tiff' }), /cannot make image\/tiff/);
  assert.throws(() => planDerivative(base, { ...spec, name: '../x' }), /preset name/);
  assert.throws(() => planDerivative(base, { ...spec, width: 0 }), /whole pixels/);
  assert.throws(() => planDerivative(base, { ...spec, height: 99999 }), /whole pixels/);
  assert.throws(() => planDerivative({ ...base, width: 0 }, spec), /size is not known/);
});

test('the library plans for images with a known size and refuses the rest', () => {
  const lib = make();
  const a = lib.upload({ name: 'a.png', bytes: png(800, 600) });
  lib.setFocal(a.id, { x: 1, y: 1 });
  assert.deepEqual(lib.plan(lib.get(a.id)!, { name: 'sq', width: 100, height: 100, fit: 'cover' }).source, { x: 200, y: 0, width: 600, height: 600 });
  const pdf = lib.upload({ name: 'a.pdf', bytes: Buffer.from('%PDF-1.4') });
  assert.throws(() => lib.plan(pdf, { name: 'sq', width: 1, height: 1, fit: 'cover' }), /only an image/);
});

test('responsive widths never exceed the original, include it, and keep the aspect ratio', () => {
  assert.deepEqual(srcsetWidths({ width: 1000, height: 500 }, [1500, 640, 320, 640, 0, 1.5, -5]), [{ width: 320, height: 160 }, { width: 640, height: 320 }, { width: 1000, height: 500 }]);
  assert.deepEqual(srcsetWidths({ width: 100, height: 50 }, [200]), [{ width: 100, height: 50 }]);
  assert.deepEqual(srcsetWidths({}, [100]), []);
});

test('the best format a client accepts is chosen, with quality values honoured', () => {
  assert.equal(Library.negotiateFormat('image/avif,image/webp,image/*;q=0.8', 'image/jpeg'), 'image/avif');
  assert.equal(Library.negotiateFormat('image/webp,*/*;q=0.8', 'image/jpeg'), 'image/webp');
  assert.equal(Library.negotiateFormat('image/avif;q=0,image/webp', 'image/jpeg'), 'image/webp');
  assert.equal(Library.negotiateFormat('image/png', 'image/png'), 'image/png');
  assert.equal(Library.negotiateFormat(undefined, 'image/jpeg'), 'image/jpeg');
  assert.equal(Library.negotiateFormat('image/avif', 'image/jpeg', ['image/webp']), 'image/jpeg');
});

// ------------------------------------------------------------ replacing and duplicates

test('replacing the file keeps the asset and its uses, bumps the revision, and must be the same kind', () => {
  const lib = make();
  const a = lib.upload({ name: 'a.png', bytes: png(100, 50) });
  lib.setFocal(a.id, { x: 0.2, y: 0.3 });
  lib.setUsage({ kind: 'post', id: 'p1' }, [{ assetId: a.id }]);
  const r = lib.replaceFile(a.id, png(200, 100));
  assert.equal(r.id, a.id);
  assert.equal(r.revision, 2);
  assert.equal(r.width, 200);
  assert.notEqual(r.sha256, a.sha256);
  assert.deepEqual(r.focal, { x: 0.2, y: 0.3 });
  assert.equal(lib.usages(a.id).length, 1);
  assert.throws(() => lib.replaceFile(a.id, jpeg(5, 5)), /new file is image\/jpeg, not image\/png/);
  assert.throws(() => lib.replaceFile(a.id, Buffer.from('nope')), /not a kind/);
});

test('identical files are found by checksum', () => {
  const lib = make();
  const x = lib.upload({ name: 'a.png', bytes: png(5, 5) });
  const y = lib.upload({ name: 'b.png', bytes: png(5, 5) });
  lib.upload({ name: 'c.png', bytes: png(6, 6) });
  assert.deepEqual(lib.duplicates().map((g) => g.map((a) => a.id).sort()), [[x.id, y.id].sort()]);
});

// ------------------------------------------------------------ usage

test('usage is replaced as a set each time a document is saved', () => {
  const lib = make();
  const [a, b, c] = ['a', 'b', 'c'].map((n) => lib.upload({ name: `${n}.png`, bytes: png(n.charCodeAt(0), 9) }));
  lib.setUsage({ kind: 'post', id: 'p1' }, [{ assetId: a!.id, field: 'hero' }, { assetId: b!.id, field: 'body' }, { assetId: b!.id, field: 'body' }]);
  lib.setUsage({ kind: 'page', id: 'home' }, [{ assetId: b!.id }]);
  assert.deepEqual(lib.usages(b!.id), [{ kind: 'page', id: 'home' }, { kind: 'post', id: 'p1', field: 'body' }]);
  assert.deepEqual(lib.unused().map((x) => x.id), [c!.id]);
  lib.setUsage({ kind: 'post', id: 'p1' }, [{ assetId: c!.id, field: 'hero' }]);
  assert.deepEqual(lib.usages(a!.id), [], 'no longer held, no longer counted');
  assert.deepEqual(lib.usages(c!.id), [{ kind: 'post', id: 'p1', field: 'hero' }]);
  assert.throws(() => lib.setUsage({ kind: 'post', id: 'p1' }, [{ assetId: 'ghost' }]), /no asset ghost/);
  assert.equal(lib.usages(c!.id).length, 1, 'a refused save changed nothing');
  lib.setUsage({ kind: 'post', id: 'p1' }, []);
  assert.deepEqual(lib.usages(c!.id), []);
});

test('deleting an asset in use is refused with the list; forcing it leaves dangling uses that are reported', () => {
  const lib = make();
  const a = lib.upload({ name: 'a.png', bytes: png(5, 5) });
  lib.setUsage({ kind: 'post', id: 'p1' }, [{ assetId: a.id, field: 'hero' }]);
  try {
    lib.delete(a.id);
    assert.fail('should refuse');
  } catch (e) {
    assert.ok(e instanceof InUse);
    assert.deepEqual(e.usages, [{ kind: 'post', id: 'p1', field: 'hero' }]);
    assert.match(e.message, /post p1/);
  }
  assert.ok(lib.get(a.id));
  lib.delete(a.id, { force: true });
  assert.equal(lib.get(a.id), undefined);
  assert.deepEqual(lib.danglingUsage(), [{ usage: { kind: 'post', id: 'p1', field: 'hero' }, assetId: a.id }]);
  assert.throws(() => lib.delete(a.id), /no asset/);
});

// ------------------------------------------------------------ alt text

test('alt problems name what is wrong', () => {
  assert.equal(altProblem('A red kite over a beach'), undefined);
  assert.match(altProblem('ok') ?? '', /too short/);
  assert.match(altProblem('x'.repeat(151)) ?? '', /longer than 150/);
  assert.match(altProblem('Image of a cat') ?? '', /starts with "image of"/);
  assert.match(altProblem('photo of a dog') ?? '', /starts with "image of"/);
  assert.match(altProblem('Cat', 'cat.png') ?? '', /file name/, 'the same as the file name');
  assert.match(altProblem('IMG_4021 final') ?? '', /camera or screenshot/);
  assert.match(altProblem('holiday.jpg') ?? '', /looks like a file name/);
  assert.equal(altProblem('Imagery of the harbour at dawn'), undefined, '"imagery" is not "image of"');
});

test('alt text is per language, a decorative image has none, and bad language tags are refused', () => {
  const lib = make();
  const a = lib.upload({ name: 'a.png', bytes: png(5, 5) });
  assert.equal(lib.setAlt(a.id, 'fr-CA', 'Un cerf-volant rouge').alt['fr-CA'], 'Un cerf-volant rouge');
  assert.throws(() => lib.setAlt(a.id, 'english!', 'x'), /not a language tag/);
  assert.throws(() => lib.setAlt(a.id, 'en', 'x'.repeat(1001)), /longer than 1000/);
  const d = lib.setDecorative(a.id, true);
  assert.deepEqual(d.alt, {}, 'marking decorative clears alt text');
  assert.throws(() => lib.setAlt(a.id, 'en', 'a kite'), /decorative image has no alt text/);
  assert.throws(() => lib.upload({ name: 'b.png', bytes: png(5, 5), decorative: true, alt: { en: 'text' } }), /decorative image has no alt text/);
});

test('the alt report counts coverage per language, skips decorative images, lists weak text and ranks what to fix first', () => {
  const lib = make();
  const f = lib.createFolder('Blog');
  const a = lib.upload({ name: 'a.png', bytes: png(1, 1), alt: { en: 'A red kite over a beach', fr: 'Un cerf-volant rouge' } });
  const b = lib.upload({ name: 'b.png', bytes: png(2, 2), folderId: f.id, alt: { en: 'Image of a boat' } });
  const c = lib.upload({ name: 'c.png', bytes: png(3, 3), folderId: f.id });
  const d = lib.upload({ name: 'd.png', bytes: png(4, 4), decorative: true });
  lib.upload({ name: 'doc.pdf', bytes: Buffer.from('%PDF-1.4') });
  lib.setUsage({ kind: 'post', id: '1' }, [{ assetId: c.id }, { assetId: b.id }]);
  lib.setUsage({ kind: 'post', id: '2' }, [{ assetId: c.id }]);
  const r = lib.altReport({ locales: ['en', 'fr'] });
  assert.equal(r.images, 4, 'a pdf is not an image');
  assert.equal(r.decorative, 1);
  assert.deepEqual(r.perLocale.en, { covered: 2, missing: [c.id], coverage: 2 / 3 });
  assert.deepEqual(r.perLocale.fr?.missing.sort(), [b.id, c.id].sort());
  assert.deepEqual(r.issues, [{ assetId: b.id, locale: 'en', problem: 'starts with "image of" or the like; the reader already knows it is an image' }]);
  assert.deepEqual(r.byFolder, { '/': { images: 1, missing: 0 }, Blog: { images: 2, missing: 2 } });
  assert.deepEqual(r.priority, [{ assetId: c.id, uses: 2 }, { assetId: b.id, uses: 1 }]);
  assert.equal(lib.altReport({ locales: ['en'], usedOnly: true }).images, 2);
  assert.equal(lib.altReport({ locales: ['en'] }).perLocale.en?.missing.includes(d.id), false);
  assert.equal(lib.altReport({ locales: ['en'], usedOnly: true }).perLocale.en?.coverage, 0.5);
  void a;
});

test('an empty library has full coverage rather than a division by zero', () => {
  const r = make().altReport({ locales: ['en'] });
  assert.deepEqual(r.perLocale.en, { covered: 0, missing: [], coverage: 1 });
});

test('search finds by folder, deep folder, type, tag, text, usage and missing alt', () => {
  const lib = make();
  const top = lib.createFolder('Top');
  const sub = lib.createFolder('Sub', top.id);
  const a = lib.upload({ name: 'kite.png', bytes: png(1, 1), folderId: sub.id, tags: ['sky'], alt: { en: 'A kite' } });
  const b = lib.upload({ name: 'boat.jpg', bytes: jpeg(1, 1), folderId: top.id });
  const c = lib.upload({ name: 'guide.pdf', bytes: Buffer.from('%PDF-1.4') });
  lib.setUsage({ kind: 'post', id: '1' }, [{ assetId: b.id }]);
  const ids = (q: Parameters<Library['find']>[0]) => lib.find(q).map((x) => x.id).sort();
  assert.deepEqual(ids({ folderId: top.id }), [b.id]);
  assert.deepEqual(ids({ folderId: top.id, deep: true }), [a.id, b.id].sort());
  assert.deepEqual(ids({ mime: 'image/*' }), [a.id, b.id].sort());
  assert.deepEqual(ids({ mime: 'application/pdf' }), [c.id]);
  assert.deepEqual(ids({ tag: 'sky' }), [a.id]);
  assert.deepEqual(ids({ text: 'KITE' }), [a.id]);
  assert.deepEqual(ids({ unused: true }), [a.id, c.id].sort());
  assert.deepEqual(ids({ missingAlt: 'en' }), [b.id]);
});
