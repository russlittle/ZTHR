import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache } from '../cache/index.ts';
import { MIME, Refused, Thumbnailer, chooseFormat, crc32, crop, decodePng, derivativeKey, encodePng, normalizeSpec, orient, plan, raster, render, resize, snapToLadder } from './index.ts';

/** Pillow 12 reference output for the 9x7 test image resized to 4x3 (each value may differ by 1 from fixed-point rounding). */
const PILLOW_4X3: Record<string, number[]> = {
  box: [65, 118, 171, 157, 167, 135, 122, 111, 100, 68, 121, 174, 121, 132, 142, 100, 124, 120, 136, 146, 156, 124, 135, 145, 136, 125, 114, 100, 153, 163, 129, 118, 107, 139, 128, 117],
  bilinear: [98, 128, 138, 130, 155, 131, 124, 128, 137, 106, 120, 149, 108, 129, 139, 113, 133, 133, 130, 149, 126, 123, 126, 144, 129, 136, 137, 111, 131, 149, 116, 130, 126, 130, 142, 126],
  bicubic: [91, 124, 136, 132, 160, 132, 131, 128, 136, 101, 117, 147, 114, 131, 139, 108, 126, 126, 127, 152, 131, 129, 130, 149, 128, 135, 139, 112, 133, 153, 116, 129, 119, 128, 140, 128],
  lanczos3: [86, 119, 132, 132, 164, 137, 136, 128, 137, 97, 113, 143, 121, 135, 138, 106, 121, 119, 122, 153, 134, 137, 135, 151, 124, 136, 142, 116, 134, 158, 114, 129, 112, 124, 139, 130],
  nearest: [128, 181, 234, 202, 255, 52, 20, 73, 126, 94, 147, 200, 54, 107, 160, 128, 181, 234, 202, 255, 52, 20, 73, 126, 236, 33, 86, 54, 107, 160, 128, 181, 234, 202, 255, 52],
};

const px = (x: number, y: number, c: number) => (x * 37 + y * 91 + c * 53) % 256;
function testImage(w = 9, h = 7) {
  const r = raster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r.data.set([px(x, y, 0), px(x, y, 1), px(x, y, 2), 255], (y * w + x) * 4);
  return r;
}
const rgb = (r: { data: Uint8ClampedArray }) => { const o: number[] = []; for (let i = 0; i < r.data.length; i += 4) o.push(r.data[i]!, r.data[i + 1]!, r.data[i + 2]!); return o; };

test('every kernel agrees with Pillow on a 9x7 image shrunk to 4x3, within one level of rounding', () => {
  for (const k of ['box', 'bilinear', 'bicubic', 'lanczos3', 'nearest'] as const) {
    const got = rgb(resize(testImage(), 4, 3, k));
    const want = PILLOW_4X3[k]!;
    assert.equal(got.length, want.length);
    got.forEach((g, i) => assert.ok(Math.abs(g - want[i]!) <= 1, `${k}[${i}] ${g} vs ${want[i]}`));
  }
});

test('resizing keeps a flat colour flat, in every kernel, up and down', () => {
  for (const k of ['box', 'bilinear', 'bicubic', 'lanczos3', 'nearest'] as const) {
    const flat = raster(10, 6, [12, 200, 99, 255]);
    for (const [w, h] of [[3, 2], [25, 17], [10, 6], [1, 1]] as const) {
      const r = resize(flat, w, h, k);
      assert.equal(r.width, w);
      for (let i = 0; i < r.data.length; i += 4) assert.deepEqual([...r.data.subarray(i, i + 4)], [12, 200, 99, 255], `${k} ${w}x${h}`);
    }
  }
});

test('box shrinking averages exactly: a 4x4 checker becomes four greys', () => {
  const r = raster(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) r.data.set([(x + y) % 2 ? 255 : 0, 0, 0, 255], (y * 4 + x) * 4);
  const s = resize(r, 2, 2, 'box');
  assert.deepEqual([...s.data].filter((_, i) => i % 4 === 0), [128, 128, 128, 128]);
});

test('transparent pixels do not bleed their hidden colour into their neighbours', () => {
  const r = raster(2, 1);
  r.data.set([255, 0, 0, 255, 0, 0, 255, 0]);
  const s = resize(r, 1, 1, 'box');
  assert.deepEqual([...s.data], [255, 0, 0, 128]);
  const clear = resize(raster(2, 2, [9, 9, 9, 0]), 1, 1, 'bilinear');
  assert.equal(clear.data[3], 0);
});

test('orientation 1 to 8 moves a corner pixel where the EXIF table says', () => {
  const r = raster(3, 2);
  for (let i = 0; i < 6; i++) r.data.set([i * 10, 0, 0, 255], i * 4);
  const reds = (o: number) => { const x = orient(r, o); return [x.width, x.height, ...[...x.data].filter((_, i) => i % 4 === 0)]; };
  assert.deepEqual(reds(1), [3, 2, 0, 10, 20, 30, 40, 50]);
  assert.deepEqual(reds(2), [3, 2, 20, 10, 0, 50, 40, 30]);
  assert.deepEqual(reds(3), [3, 2, 50, 40, 30, 20, 10, 0]);
  assert.deepEqual(reds(4), [3, 2, 30, 40, 50, 0, 10, 20]);
  assert.deepEqual(reds(5), [2, 3, 0, 30, 10, 40, 20, 50]);
  assert.deepEqual(reds(6), [2, 3, 30, 0, 40, 10, 50, 20]);
  assert.deepEqual(reds(7), [2, 3, 50, 20, 40, 10, 30, 0]);
  assert.deepEqual(reds(8), [2, 3, 20, 50, 10, 40, 0, 30]);
  assert.throws(() => orient(r, 9), Refused);
});

test('contain, inside, fill and pad plan the exact sizes', () => {
  const src = { width: 4000, height: 3000 };
  const spec = (o: object) => normalizeSpec({ width: 400, height: 400, ...o });
  assert.deepEqual(plan(src, spec({})).output, { w: 400, h: 300 });
  assert.deepEqual(plan(src, spec({ fit: 'fill' })).output, { w: 400, h: 400 });
  const pad = plan(src, spec({ fit: 'pad' }));
  assert.deepEqual([pad.output, pad.size, pad.canvas], [{ w: 400, h: 400 }, { w: 400, h: 300 }, { w: 400, h: 400, x: 0, y: 50 }]);
  assert.deepEqual(plan({ width: 100, height: 50 }, spec({})).output, { w: 100, h: 50 }, 'no enlarging by default');
  assert.deepEqual(plan({ width: 100, height: 50 }, spec({ upscale: true })).output, { w: 400, h: 200 });
  assert.deepEqual(plan({ width: 100, height: 50 }, spec({ fit: 'inside', upscale: 'true' })).output, { w: 100, h: 50 }, 'inside never enlarges');
  assert.deepEqual(plan(src, normalizeSpec({ width: 200 })).output, { w: 200, h: 150 }, 'one side given');
  assert.deepEqual(plan({ width: 4000, height: 3000, orientation: 6 }, normalizeSpec({ height: 400 })).output, { w: 300, h: 400 }, 'a portrait phone photo');
});

test('cover crops to the box shape around the focal point and clamps at the edges', () => {
  const src = { width: 400, height: 300 };
  const c = (o: object) => plan(src, normalizeSpec({ width: 100, height: 100, fit: 'cover', ...o }));
  assert.deepEqual(c({}).crop, { x: 50, y: 0, w: 300, h: 300 });
  assert.deepEqual(c({ focalX: 0 }).crop, { x: 0, y: 0, w: 300, h: 300 });
  assert.deepEqual(c({ focalX: 1 }).crop, { x: 100, y: 0, w: 300, h: 300 });
  assert.deepEqual(c({ focalX: 0.25 }).crop, { x: 0, y: 0, w: 300, h: 300 }, 'a focal point near an edge is pulled inside');
  assert.deepEqual(c({}).output, { w: 100, h: 100 });
  assert.deepEqual(plan(src, normalizeSpec({ width: 800, height: 400, fit: 'cover' })).output, { w: 400, h: 200 }, 'a small source is not enlarged');
});

test('rendering a plan yields the planned pixels: crop, resize and pad together', () => {
  const src = testImage(8, 4);
  const spec = normalizeSpec({ width: 4, height: 4, fit: 'cover', kernel: 'nearest' });
  const out = render(src, 1, plan(src, spec), spec);
  assert.deepEqual([out.width, out.height], [4, 4]);
  const padSpec = normalizeSpec({ width: 8, height: 8, fit: 'pad', kernel: 'nearest', background: '#ff0000' });
  const padded = render(raster(4, 2, [0, 0, 255, 255]), 1, plan({ width: 4, height: 2 }, { ...padSpec, upscale: false }), { ...padSpec, upscale: false });
  assert.deepEqual([...padded.data.subarray(0, 4)], [255, 0, 0, 255], 'top row is background');
  assert.deepEqual([...padded.data.subarray((3 * 8 + 2) * 4, (3 * 8 + 2) * 4 + 4)], [0, 0, 255, 255], 'the picture sits in the middle');
  assert.throws(() => crop(src, { x: 6, y: 0, w: 5, h: 1 }), Refused);
});

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const pixels = (r: { data: Uint8ClampedArray }) => [...r.data];

test('PNGs written by Pillow decode to the right pixels: grey, palette with transparency, grey+alpha, RGBA, 16-bit, 1-bit', () => {
  const gray = decodePng(b64('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAAAAAC4HznGAAAAEElEQVR4XmNkcHBgOPCfCwAHGAJLtciHQwAAAABJRU5ErkJggg=='));
  assert.deepEqual(pixels(gray).filter((_, i) => i % 4 === 0), [0, 64, 128, 192, 255, 10]);
  const ga = decodePng(b64('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADYv8WvAAAAEklEQVR4XmPk+s/VyCLCyPUfAA0sArhUi1igAAAAAElFTkSuQmCC'));
  assert.deepEqual(pixels(ga), [10, 10, 10, 255, 20, 20, 20, 128, 30, 30, 30, 0, 40, 40, 40, 255]);
  const rgba = decodePng(b64('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4XmP4z8Dwn+E/QwMDiGZkYmYBADX1BIdee5ZqAAAAAElFTkSuQmCC'));
  assert.deepEqual(pixels(rgba), [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4]);
  const g16 = decodePng(b64('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAAAAACB2fwVAAAADUlEQVR4XmP4/9+XAQAHmAJM6S0ZcQAAAABJRU5ErkJggg=='));
  assert.deepEqual([g16.data[0], g16.data[4]], [255, 77]);
  const bit1 = decodePng(b64('iVBORw0KGgoAAAANSUhEUgAAAAoAAAABAQAAAADPjgLTAAAAC0lEQVR4XmMMfQ0AAZsBQkRGEJ0AAAAASUVORK5CYII='));
  assert.deepEqual(pixels(bit1).filter((_, i) => i % 4 === 0), [0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
});

test('encode then decode gives the same pixels, opaque images are written as RGB and are smaller', () => {
  const opaque = testImage(13, 9);
  const o = encodePng(opaque);
  assert.equal(Buffer.from(o).readUInt8(25), 2, 'colour type 2');
  assert.deepEqual(pixels(decodePng(o)), pixels(opaque));
  const a = testImage(13, 9);
  a.data[3] = 7;
  const e = encodePng(a);
  assert.equal(Buffer.from(e).readUInt8(25), 6, 'colour type 6 when any pixel is not opaque');
  assert.deepEqual(pixels(decodePng(e)), pixels(a));
  assert.ok(o.length < e.length);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'the CRC-32 check value');
});

test('hostile PNGs are refused: bad CRC, truncation, interlace, huge size, wrong length, junk', () => {
  const good = Buffer.from(encodePng(testImage(4, 4)));
  const flipped = Buffer.from(good);
  flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 1;
  assert.throws(() => decodePng(flipped), /damaged/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 20)), Refused);
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), /not a PNG/);
  const sized = (w: number, h: number, interlace = 0) => {
    const b = Buffer.from(good);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[28] = interlace;
    b.writeUInt32BE(crc32(b.subarray(12, 29)), 29);
    return b;
  };
  assert.throws(() => decodePng(sized(70000, 70000)), /more than this will decode/, 'a bomb is refused before inflating');
  assert.throws(() => decodePng(sized(4, 4, 1)), /interlaced/);
  assert.throws(() => decodePng(sized(4, 5)), /wrong length|larger/);
  assert.throws(() => decodePng(sized(4, 3)), /larger than its header|wrong length/);
});

test('the spec is normalised: defaults filled, equal requests equal, limits and bad values refused', () => {
  const a = normalizeSpec({ width: 200, height: 100 });
  assert.deepEqual([a.fit, a.kernel, a.format, a.quality, a.focalX, a.upscale, a.background], ['contain', 'lanczos3', 'jpeg', 80, 0.5, false, '#00000000']);
  assert.deepEqual(normalizeSpec({ width: '200', height: '100', fit: 'contain', quality: '80', upscale: 'false', focalX: '0.5' }), a);
  assert.equal(normalizeSpec({ width: 100, dpr: 2 }).width, 200);
  assert.equal(normalizeSpec({ width: 300, height: 200, fit: 'pad', background: '#FFF000' }).background, '#fff000ff');
  const bad: [object, RegExp][] = [
    [{}, /width or a height/], [{ width: 0 }, /width must be/], [{ width: 5000 }, /width must be/], [{ width: 1.5 }, /whole number/],
    [{ width: 'abc' }, /width must be/], [{ width: 100, fit: 'cover' }, /both/], [{ width: 100, fit: 'zoom' }, /fit must be/],
    [{ width: 100, kernel: 'magic' }, /kernel/], [{ width: 100, format: 'bmp' }, /format/], [{ width: 100, quality: 101 }, /quality/],
    [{ width: 100, background: 'red' }, /background/], [{ width: 4096, height: 4096 }, /pixels in total/], [{ width: 100, dpr: 9 }, /dpr/],
    [{ width: 100, upscale: 'maybe' }, /upscale/],
  ];
  for (const [i, why] of bad) assert.throws(() => normalizeSpec(i), (e: Error) => e instanceof Refused && why.test(e.message), JSON.stringify(i));
});

test('a size ladder bounds how many variants can exist', () => {
  const ladder = [100, 200, 400];
  assert.deepEqual([50, 100, 101, 399, 400, 900].map((n) => snapToLadder(n, ladder)), [100, 100, 200, 400, 400, 400]);
  const lim = { maxSide: 4096, maxPixels: 16_000_000, ladder };
  assert.equal(normalizeSpec({ width: 150 }, lim).width, 200);
  assert.equal(normalizeSpec({ width: 150, dpr: 2 }, lim).width, 400);
});

test('derivative keys: the same for the same picture, different for anything that changes it, and safe as paths', () => {
  const src = { id: 'photos/7', version: 'v1' };
  const k = derivativeKey(src, normalizeSpec({ width: 200, height: 100 }));
  assert.equal(k, derivativeKey(src, normalizeSpec({ width: '200', height: 100, fit: 'contain', quality: 80 })));
  assert.match(k, /^thumbs\/v1\/[0-9a-f]{2}\/[0-9a-f]{32}\/[0-9a-f]{16}\/200x100-contain-[A-Za-z0-9_-]{16}\.jpg$/);
  const others = [
    derivativeKey({ ...src, version: 'v2' }, normalizeSpec({ width: 200, height: 100 })),
    derivativeKey({ ...src, id: 'photos/8' }, normalizeSpec({ width: 200, height: 100 })),
    derivativeKey(src, normalizeSpec({ width: 200, height: 101 })),
    derivativeKey(src, normalizeSpec({ width: 200, height: 100, quality: 79 })),
    derivativeKey(src, normalizeSpec({ width: 200, height: 100, kernel: 'bicubic' })),
    derivativeKey(src, normalizeSpec({ width: 200, height: 100, format: 'png' })),
    derivativeKey(src, normalizeSpec({ width: 200, height: 100, fit: 'inside' })),
  ];
  assert.equal(new Set([k, ...others]).size, 8);
  assert.ok(!derivativeKey({ id: '../../etc/passwd', version: '../x' }, normalizeSpec({ width: 10 })).includes('..'));
  assert.ok(derivativeKey({ id: 'x', version: '1' }, normalizeSpec({ width: 10, format: 'png' })).endsWith('.png'));
});

test('format choice follows Accept: modern formats only when named, graphics stay lossless, alpha never becomes JPEG', () => {
  const pick = (accept: string | undefined, sourceKind: 'jpeg' | 'png', hasAlpha = false, available?: ('png' | 'jpeg' | 'webp' | 'avif')[]) =>
    chooseFormat({ accept, sourceKind, hasAlpha, ...(available ? { available } : {}) }).format;
  assert.equal(pick('image/avif,image/webp,image/*;q=0.8', 'jpeg'), 'avif');
  assert.equal(pick('image/webp,image/*', 'jpeg'), 'webp');
  assert.equal(pick('image/avif,image/webp', 'jpeg', false, ['jpeg', 'webp', 'png']), 'webp', 'no AVIF encoder installed');
  assert.equal(pick('*/*', 'jpeg'), 'jpeg', 'a wildcard alone does not mean the newest format');
  assert.equal(pick(undefined, 'jpeg'), 'jpeg');
  assert.equal(pick('image/webp;q=0,*/*', 'jpeg'), 'jpeg', 'q=0 refuses');
  assert.equal(pick('image/webp,*/*', 'png'), 'png', 'a graphic stays lossless');
  assert.equal(pick('image/webp', 'png', true), 'webp');
  assert.equal(pick('image/jpeg,*/*', 'jpeg', true), 'png', 'transparency is never flattened into JPEG');
  const c = chooseFormat({ accept: 'image/webp', sourceKind: 'jpeg', hasAlpha: false });
  assert.deepEqual([c.mime, c.vary], [MIME.webp, 'Accept']);
});

test('the thumbnailer renders once per key, caches, and drops every derivative of a source together', async () => {
  const cache = new Cache<import('./index.ts').Derivative>({ ttlMs: 60_000 });
  const t = new Thumbnailer({ cache });
  const bytes = encodePng(testImage(40, 20));
  let reads = 0;
  const src = { id: 'a', version: '1', bytes: async () => { reads++; return bytes; } };
  const [x, y] = await Promise.all([t.get(src, { width: 20, format: 'png' }), t.get(src, { width: '20', format: 'png' })]);
  assert.equal(x, y);
  assert.deepEqual([x.width, x.height, x.mime, reads, t.stats.renders], [20, 10, 'image/png', 1, 1]);
  assert.deepEqual(pixels(decodePng(x.bytes)).length, 20 * 10 * 4);
  await t.get(src, { width: 20, format: 'png' });
  assert.equal(t.stats.renders, 1, 'served from the cache');
  await t.get(src, { width: 10, format: 'png' });
  assert.equal(t.stats.renders, 2);
  assert.equal(t.invalidate('a'), 2);
  await t.get(src, { width: 20, format: 'png' });
  assert.equal(t.stats.renders, 3);
  const v2 = await t.get({ ...src, version: '2' }, { width: 20, format: 'png' });
  assert.notEqual(v2.key, x.key, 'a new version of the source is a new key');
});

test('the thumbnailer refuses what it cannot or should not do, and does not cache failures', async () => {
  const cache = new Cache<import('./index.ts').Derivative>({ ttlMs: 60_000 });
  const t = new Thumbnailer({ cache, limits: { maxSide: 100, maxPixels: 5000 } });
  const png = encodePng(testImage(8, 8));
  const src = (b: Uint8Array) => ({ id: 'z', version: '1', bytes: async () => b });
  await assert.rejects(t.get(src(png), { width: 20, format: 'webp' }), /no encoder for webp/);
  await assert.rejects(t.get(src(png), { width: 500, format: 'png' }), /width must be/);
  await assert.rejects(t.get(src(new Uint8Array(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'))), { width: 20, format: 'png' }), /no decoder for gif/);
  await assert.rejects(t.get(src(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), { width: 20, format: 'png' }));
  assert.equal(cache.size, 0);
  assert.deepEqual(t.formats, ['png']);
  const custom = new Thumbnailer({ cache, encoders: { jpeg: () => new Uint8Array([0xff, 0xd8]) } });
  assert.deepEqual([...(await custom.get(src(png), { width: 4 })).bytes], [0xff, 0xd8]);
});

test('an upright render of a rotated source: EXIF orientation 6 is applied before the plan', () => {
  const src = raster(4, 2);
  for (let i = 0; i < 8; i++) src.data.set([i * 20, 0, 0, 255], i * 4);
  const spec = normalizeSpec({ width: 2, height: 4, fit: 'fill', kernel: 'nearest' });
  const out = render(src, 6, plan({ width: 4, height: 2, orientation: 6 }, spec), spec);
  assert.deepEqual([out.width, out.height], [2, 4]);
  assert.deepEqual([...out.data].filter((_, i) => i % 4 === 0), [80, 0, 100, 20, 120, 40, 140, 60]);
});
