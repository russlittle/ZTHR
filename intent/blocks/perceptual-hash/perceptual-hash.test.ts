import assert from 'node:assert/strict';
import { test } from 'node:test';
import { raster, resize, type Raster } from '../thumbnails/index.ts';
import { ALGORITHMS, HashError, aHash, dHash, dct8, distance, distanceAnyOrientation, group, hash, judge, nearest, pHash, similarity, toGray, transforms } from './index.ts';

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** A picture of overlapping soft blocks: enough structure to hash, different per seed. */
function scene(seed: number, w = 128, h = 96): Raster {
  const r = rng(seed);
  const blocks = Array.from({ length: 14 }, () => ({ x: r() * w, y: r() * h, w: 10 + r() * w * 0.45, h: 10 + r() * h * 0.45, v: r() * 255 }));
  const out = raster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 128;
    for (const b of blocks) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) v = b.v;
    out.data.set([v, v, v, 255], (y * w + x) * 4);
  }
  return out;
}
const map = (src: Raster, f: (v: number, x: number, y: number) => number): Raster => {
  const out = raster(src.width, src.height);
  for (let i = 0; i < src.data.length; i += 4) {
    const p = i / 4;
    const v = f(src.data[i] as number, p % src.width, Math.floor(p / src.width));
    out.data.set([v, v, v, 255], i);
  }
  return out;
};
const gradient = (w: number, h: number, f: (x: number) => number) => map(raster(w, h), (_v, x) => f(x / (w - 1)) * 255);

test('grey conversion weights green most and treats transparent pixels as white', () => {
  const px = (rgba: number[]) => {
    const r = raster(1, 1);
    r.data.set(rgba);
    return toGray(r).data[0];
  };
  assert.equal(px([255, 255, 255, 255]), 255);
  assert.equal(px([0, 0, 0, 255]), 0);
  assert.equal(px([255, 0, 0, 255]), 76);
  assert.equal(px([0, 255, 0, 255]), 150);
  assert.equal(px([0, 0, 255, 255]), 29);
  assert.equal(px([0, 0, 0, 0]), 255);
  assert.equal(px([0, 0, 0, 128]), 127);
});

test('every hash is 64 bits as 16 hex digits and the same picture always gives the same one', () => {
  const s = scene(1);
  for (const a of ALGORITHMS) {
    const h = hash(s, a);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.equal(hash(scene(1), a), h);
  }
  assert.throws(() => hash(s, 'md5' as never), HashError);
});

test('Hamming distance counts differing bits, and refuses mismatched or malformed hashes', () => {
  assert.equal(distance('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(distance('8000000000000001', '0000000000000000'), 2);
  assert.equal(distance('abcdef0123456789', 'abcdef0123456789'), 0);
  assert.equal(distance('f', '0'), 4);
  assert.equal(similarity('0000000000000000', 'ffffffff00000000'), 0.5);
  assert.throws(() => distance('ff', 'fff'), /different sizes/);
  assert.throws(() => distance('xyz', 'abc'), /not a hex hash/);
  assert.throws(() => distance('', ''), /not a hex hash/);
  assert.throws(() => distance('ABCD', 'abcd'), /not a hex hash/);
});

test('flat pictures hash to nothing, and brightness alone changes nothing', () => {
  const grey = raster(40, 30, [90, 90, 90, 255]);
  for (const a of ALGORITHMS) assert.equal(hash(grey, a), '0000000000000000', a);
  assert.deepEqual(Array.from(dct8(new Float64Array(1024).fill(7))).slice(1).every((v) => Math.abs(v) < 1e-9), true);
});

test('difference hash reads brightness direction: dark to light is all zeros, light to dark all ones', () => {
  assert.equal(dHash(gradient(90, 80, (t) => t)), '0000000000000000');
  assert.equal(dHash(gradient(90, 80, (t) => 1 - t)), 'ffffffffffffffff');
});

test('average hash marks the bright half', () => {
  const half = map(raster(64, 64), (_v, x) => (x < 32 ? 0 : 255));
  assert.equal(aHash(half), '0f0f0f0f0f0f0f0f');
  const top = map(raster(64, 64), (_v, _x, y) => (y < 32 ? 255 : 0));
  assert.equal(aHash(top), 'ffffffff00000000');
});

test('the same picture at other sizes is a duplicate under every algorithm', () => {
  const big = scene(5, 256, 192);
  for (const [w, h] of [[128, 96], [64, 48], [320, 240]] as const) {
    const small = resize(big, w, h, 'bilinear');
    for (const a of ALGORITHMS) assert.ok(distance(hash(big, a), hash(small, a)) <= 4, `${a} at ${w}x${h}: ${distance(hash(big, a), hash(small, a))}`);
  }
});

test('brightness, contrast and a little noise leave a picture close; a different picture is far', () => {
  const s = scene(2);
  const brighter = map(s, (v) => Math.min(255, v + 30));
  const flatter = map(s, (v) => 128 + (v - 128) * 0.7);
  const r = rng(99);
  const noisy = map(s, (v) => v + (r() - 0.5) * 16);
  for (const a of ['phash', 'dhash'] as const) {
    for (const [name, v] of [['bright', brighter], ['flat', flatter], ['noisy', noisy]] as const) assert.ok(distance(hash(s, a), hash(v, a)) <= 6, `${a} ${name}: ${distance(hash(s, a), hash(v, a))}`);
  }
  const others = [3, 4, 5, 6, 7, 8].map((k) => scene(k));
  for (const a of ALGORITHMS) {
    const ds = others.map((o) => distance(hash(s, a), hash(o, a)));
    assert.ok(ds.reduce((x, y) => x + y) / ds.length > 14, `${a} ${ds.join(',')}`);
    assert.ok(Math.min(...ds) > 6, `${a} min ${ds.join(',')}`);
  }
});

test('the verdict uses per algorithm thresholds, and a custom pair overrides them', () => {
  const a = '0000000000000000';
  assert.equal(judge(a, '0000000000000007', 'phash'), 'duplicate'); // 3 bits
  assert.equal(judge(a, '00000000000000ff', 'phash'), 'similar'); // 8 bits
  assert.equal(judge(a, '00000000000000ff', 'ahash'), 'different');
  assert.equal(judge(a, '00000000000000ff', 'ahash', { duplicate: 8, similar: 8 }), 'duplicate');
});

test('a turned or flipped copy is found by comparing the eight orientations', () => {
  const s = scene(11);
  assert.equal(transforms(s).length, 8);
  assert.deepEqual(transforms(s).map((t) => [t.width, t.height]), [[128, 96], [128, 96], [128, 96], [128, 96], [96, 128], [96, 128], [96, 128], [96, 128]]);
  const turned = transforms(s)[5] as Raster;
  const plain = distance(pHash(s), pHash(turned));
  const any = distanceAnyOrientation(pHash(s), turned, 'phash');
  assert.ok(plain > 14, `plain ${plain}`);
  assert.ok(any <= 2, `any ${any}`);
  assert.equal(distanceAnyOrientation(pHash(s), s, 'phash'), 0);
});

test('grouping: duplicates join, strangers stay out, the group names a keeper and its widest gap', () => {
  const items = [
    { id: 'a', hash: '0000000000000000' },
    { id: 'b', hash: '0000000000000001' },
    { id: 'c', hash: '0000000000000003' },
    { id: 'x', hash: 'ffffffffffffffff' },
    { id: 'y', hash: 'fffffffffffffffe' },
    { id: 'z', hash: '00ff00ff00ff00ff' },
  ];
  const g = group(items, { threshold: 2 });
  assert.deepEqual(g.map((x) => x.ids), [['a', 'b', 'c'], ['x', 'y']]);
  assert.equal(g[0]?.representative, 'b');
  assert.equal(g[0]?.diameter, 2);
  assert.deepEqual(group(items, { threshold: 2, minSize: 1 }).map((x) => x.ids.length), [3, 2, 1]);
  assert.deepEqual(group(items, { threshold: 0 }), []);
});

test('single linkage chains a slow drift together; complete linkage does not', () => {
  // each is 2 bits from the next, 8 from the first
  const items = ['0000000000000000', '0000000000000003', '000000000000000f', '000000000000003f', '00000000000000ff'].map((h, i) => ({ id: `p${i}`, hash: h }));
  assert.deepEqual(group(items, { threshold: 2, linkage: 'single' }).map((x) => x.ids), [['p0', 'p1', 'p2', 'p3', 'p4']]);
  assert.equal(group(items, { threshold: 2, linkage: 'single' })[0]?.diameter, 8);
  const strict = group(items, { threshold: 4, linkage: 'complete' });
  assert.ok(strict.every((x) => x.diameter <= 4));
  assert.ok(strict.length >= 1 && strict.every((x) => x.ids.length <= 3));
  // order independent
  const rev = group([...items].reverse(), { threshold: 4, linkage: 'complete' });
  assert.deepEqual(rev.map((x) => x.ids.length).sort(), strict.map((x) => x.ids.length).sort());
});

test('grouping refuses bad input: negative or fractional threshold, repeated ids, bad hashes', () => {
  const a = { id: 'a', hash: '00' };
  assert.throws(() => group([a], { threshold: -1 }), /threshold/);
  assert.throws(() => group([a], { threshold: 1.5 }), /threshold/);
  assert.throws(() => group([a, a], { threshold: 1 }), /duplicate item id/);
  assert.throws(() => group([a, { id: 'b', hash: 'zz' }], { threshold: 1 }), /not a hex hash/);
  assert.deepEqual(group([], { threshold: 3 }), []);
});

test('nearest lists matches within the threshold, closest first, capped', () => {
  const items = [{ id: 'c', hash: '000000000000000f' }, { id: 'a', hash: '0000000000000001' }, { id: 'b', hash: '0000000000000002' }, { id: 'far', hash: 'ffffffffffffffff' }];
  assert.deepEqual(nearest('0000000000000000', items, 4), [{ id: 'a', distance: 1 }, { id: 'b', distance: 1 }, { id: 'c', distance: 4 }]);
  assert.equal(nearest('0000000000000000', items, 4, 2).length, 2);
});

test('end to end: a photo library finds its resized and brightened copies among unrelated pictures', () => {
  const originals = [21, 22, 23, 24].map((k) => scene(k, 160, 120));
  const library = [
    ...originals.map((o, i) => ({ id: `orig${i}`, hash: pHash(o) })),
    { id: 'copy0', hash: pHash(resize(originals[0] as Raster, 80, 60, 'bilinear')) },
    { id: 'copy2', hash: pHash(map(originals[2] as Raster, (v) => Math.min(255, v + 25))) },
  ];
  const g = group(library, { threshold: 6 });
  assert.deepEqual(g.map((x) => [...x.ids].sort()), [['copy0', 'orig0'], ['copy2', 'orig2']]);
});
