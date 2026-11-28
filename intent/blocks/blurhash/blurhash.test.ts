import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blurhashColour, blurhashDecode, blurhashEncode, blurhashInfo, decode83, downscale, encode83, fromBase64, HashError, thumbhashAspectRatio, thumbhashColour, thumbhashDecode, thumbhashEncode, toBase64,
} from './index.ts';

function solid(w: number, h: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([r, g, b, a], i * 4);
  return px;
}
/** Red on the left to blue on the right. */
function gradient(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([Math.round(255 * (1 - x / (w - 1))), 20, Math.round(255 * (x / (w - 1))), 255], (y * w + x) * 4);
  return px;
}
const at = (b: { width: number; pixels: Uint8ClampedArray }, x: number, y: number) => Array.from(b.pixels.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4));

// ------------------------------------------------------------ blurhash

test('base 83 uses the published alphabet and round trips', () => {
  assert.equal(decode83('0'), 0);
  assert.equal(decode83('~'), 82);
  assert.equal(decode83('10'), 83);
  assert.equal(encode83(16711680, 4), 'TI:j');
  assert.equal(decode83('TI:j'), 16711680);
  assert.equal(encode83(0, 2), '00');
  for (const n of [1, 82, 83, 6888, 6889, 571786, 571787]) assert.equal(decode83(encode83(n, 4)), n);
  assert.throws(() => decode83('a b'), /not a base 83 character/);
  assert.throws(() => encode83(83, 1), /does not fit/);
  assert.throws(() => encode83(-1, 2), /does not fit/);
});

test('a solid red image encodes to the hash worked out by hand from the algorithm', () => {
  // size flag 21 = "L" (4x3), and the DC term 255<<16 = 16711680 = "TI:j". The AC terms of a flat image are not zero in this
  // algorithm (its cosines sample at x, not x + 0.5), which is how the reference behaves, so they are not asserted here.
  const red = blurhashEncode(solid(8, 6, 255, 0, 0), 8, 6, 4, 3);
  assert.equal(red.length, 28);
  assert.equal(red[0], 'L');
  assert.equal(red.slice(2, 6), 'TI:j');
  assert.equal(blurhashEncode(solid(8, 6, 255, 255, 255), 8, 6, 1, 1), '00TSUA'); // 1x1: flag 0, max 0, DC 0xFFFFFF = 29,28,30,10
});

test('the published example hashes read as 4x3 and give the DC colour the arithmetic says', () => {
  const published: [string, [number, number, number]][] = [
    ['LEHV6nWB2yk8pyo0adR*.7kCMdnj', [151, 150, 149]],
    ['LGF5]+Yk^6#M@-5c,1J5@[or[Q6.', [131, 126, 152]],
    ['L6PZfSi_.AyE_3t7t7R**0o#DgR4', [221, 217, 213]],
  ];
  for (const [hash, [r, g, b]] of published) {
    assert.deepEqual(blurhashInfo(hash), { componentsX: 4, componentsY: 3 });
    assert.deepEqual(blurhashColour(hash), { r, g, b });
    const bmp = blurhashDecode(hash, 32, 32);
    assert.equal(bmp.pixels.length, 32 * 32 * 4);
    assert.ok(at(bmp, 5, 5)[3] === 255);
    // the mean of the decoded picture is the DC term, in linear light
    let lr = 0, lg = 0, lb = 0;
    const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4;
    for (let i = 0; i < 32 * 32; i++) { lr += lin(bmp.pixels[i * 4]!); lg += lin(bmp.pixels[i * 4 + 1]!); lb += lin(bmp.pixels[i * 4 + 2]!); }
    const back = (v: number) => Math.round(255 * (1.055 * (v / 1024) ** (1 / 2.4) - 0.055));
    assert.ok(Math.abs(back(lr) - r) <= 12 && Math.abs(back(lg) - g) <= 12 && Math.abs(back(lb) - b) <= 12, `${hash}: ${back(lr)},${back(lg)},${back(lb)}`);
  }
});

test('a solid colour keeps its DC exactly, and decodes closer to it the larger the image was', () => {
  const err = (size: number) => {
    const hash = blurhashEncode(solid(size, size, 30, 120, 220), size, size, 4, 3);
    assert.deepEqual(blurhashColour(hash), { r: 30, g: 120, b: 220 });
    const [r, g, b, a] = at(blurhashDecode(hash, 8, 8), 0, 0);
    assert.equal(a, 255);
    return Math.max(Math.abs(r! - 30), Math.abs(g! - 120), Math.abs(b! - 220));
  };
  const [e16, e64, e256] = [err(16), err(64), err(256)];
  assert.ok(e16 > e64 && e64 > e256, `${e16} ${e64} ${e256}`); // the reference algorithm's cosines are sampled at x, not x + 0.5
  assert.ok(e256 <= 3, `${e256}`);
});

test('a gradient keeps its direction through encode and decode', () => {
  const hash = blurhashEncode(gradient(64, 32), 64, 32, 5, 3);
  assert.equal(hash.length, 4 + 2 * 15);
  const bmp = blurhashDecode(hash, 32, 16);
  const left = at(bmp, 1, 8);
  const right = at(bmp, 30, 8);
  assert.ok(left[0]! > 170 && left[2]! < 90, `left ${left}`);
  assert.ok(right[2]! > 170 && right[0]! < 90, `right ${right}`);
});

test('the number of components sets the length: 1x1 is 6 characters and 9x9 is 166', () => {
  const px = gradient(20, 20);
  assert.equal(blurhashEncode(px, 20, 20, 1, 1).length, 6);
  assert.equal(blurhashEncode(px, 20, 20, 9, 9).length, 4 + 2 * 81);
  assert.deepEqual(blurhashInfo(blurhashEncode(px, 20, 20, 9, 9)), { componentsX: 9, componentsY: 9 });
  assert.deepEqual(blurhashInfo(blurhashEncode(px, 20, 20, 2, 7)), { componentsX: 2, componentsY: 7 });
});

test('punch raises the contrast of the decoded picture, and the same hash always gives the same bytes', () => {
  const hash = blurhashEncode(gradient(40, 40), 40, 40, 4, 4);
  const spread = (p: number) => { const b = blurhashDecode(hash, 20, 20, p); return Math.abs(at(b, 1, 10)[0]! - at(b, 18, 10)[0]!); };
  assert.ok(spread(2) > spread(1), `${spread(2)} vs ${spread(1)}`);
  assert.deepEqual(blurhashDecode(hash, 8, 8), blurhashDecode(hash, 8, 8));
  assert.equal(blurhashEncode(gradient(40, 40), 40, 40, 4, 4), hash);
});

test('bad blurhash input is refused: components, sizes, buffer length, damaged hashes, huge decodes', () => {
  const px = solid(4, 4, 1, 2, 3);
  assert.throws(() => blurhashEncode(px, 4, 4, 0, 3), /1 to 9/);
  assert.throws(() => blurhashEncode(px, 4, 4, 4, 10), /1 to 9/);
  assert.throws(() => blurhashEncode(px, 4, 4, 1.5, 3), /1 to 9/);
  assert.throws(() => blurhashEncode(px, 5, 4), /expected 80 bytes/);
  assert.throws(() => blurhashEncode(px, 0, 4), /at least 1/);
  assert.throws(() => blurhashEncode(px, 2.5, 4), /whole numbers/);
  assert.throws(() => blurhashInfo('LEHV6nWB2yk8pyo0adR*.7kCMdn'), /28 characters, not 27/);
  assert.throws(() => blurhashInfo('abc'), /at least 6/);
  assert.throws(() => blurhashInfo('LEHV6nWB2yk8pyo0adR*.7kCMdn '), /not a base 83 character/);
  assert.throws(() => blurhashDecode('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 2000, 2000), /more than 1000000 pixels/);
  assert.throws(() => blurhashDecode('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, 0), /punch/);
  assert.throws(() => blurhashDecode('LEHV6nWB2yk8pyo0adR*.7kCMdnj', 10, 10, NaN), /punch/);
  assert.throws(() => blurhashColour('!!!!!!'), HashError);
});

// ------------------------------------------------------------ thumbhash

test('a solid opaque colour gives a 5 byte hash that decodes to that colour', () => {
  const h = thumbhashEncode(solid(16, 16, 200, 80, 40), 16, 16);
  assert.ok(h.length <= 25);
  const c = thumbhashColour(h);
  assert.ok(Math.abs(c.r - 200) <= 3 && Math.abs(c.g - 80) <= 3 && Math.abs(c.b - 40) <= 3, JSON.stringify(c));
  assert.equal(c.a, 1);
  const bmp = thumbhashDecode(h);
  assert.deepEqual([bmp.width, bmp.height], [32, 32]);
  const p = at(bmp, 16, 16);
  assert.ok(Math.abs(p[0]! - 200) <= 4 && Math.abs(p[1]! - 80) <= 4 && Math.abs(p[2]! - 40) <= 4 && p[3] === 255, `${p}`);
});

test('the aspect ratio survives: landscape, portrait and square decode to 32 on the long side', () => {
  const dims = (w: number, h: number) => { const b = thumbhashDecode(thumbhashEncode(gradient(w, h), w, h)); return [b.width, b.height]; };
  assert.deepEqual(dims(40, 20), [32, 18]); // the hash keeps 7 by round(3.5) = 4 levels: a ratio of 1.75, an approximation by design
  assert.deepEqual(dims(20, 40), [18, 32]);
  assert.deepEqual(dims(100, 14), [32, 5]);
  assert.deepEqual(dims(30, 30), [32, 32]);
  assert.equal(thumbhashAspectRatio(thumbhashEncode(gradient(70, 35), 70, 35)), 1.75);
  assert.equal(thumbhashAspectRatio(thumbhashEncode(gradient(35, 70), 35, 70)), 4 / 7);
  assert.equal(thumbhashAspectRatio(thumbhashEncode(gradient(70, 70), 70, 70)), 1);
  assert.equal(thumbhashAspectRatio(thumbhashEncode(gradient(50, 50), 50, 50)), 1);
});

test('an opaque hash is at most 25 bytes; transparency adds a byte and the alpha terms', () => {
  const opaque = thumbhashEncode(gradient(100, 100), 100, 100);
  assert.ok(opaque.length <= 25, `${opaque.length}`);
  const px = gradient(32, 32);
  for (let i = 0; i < 32 * 32; i++) px[i * 4 + 3] = i % 32 < 16 ? 255 : 0; // right half clear
  const clear = thumbhashEncode(px, 32, 32);
  assert.ok(clear.length > opaque.length - 5);
  assert.equal((clear[2]! >> 7) & 1, 1); // the has-alpha flag
  const bmp = thumbhashDecode(clear);
  assert.ok(at(bmp, 2, 16)[3]! > 200, 'left stays opaque');
  assert.ok(at(bmp, 29, 16)[3]! < 60, 'right stays clear');
  assert.ok(thumbhashColour(clear).a < 1);
});

test('a gradient keeps its direction through thumbhash', () => {
  const bmp = thumbhashDecode(thumbhashEncode(gradient(64, 64), 64, 64));
  const left = at(bmp, 2, 16);
  const right = at(bmp, 29, 16);
  assert.ok(left[0]! > right[0]! + 100, `${left} ${right}`);
  assert.ok(right[2]! > left[2]! + 100, `${left} ${right}`);
});

test('thumbhash bytes are stable, and base64 round trips without padding', () => {
  const a = thumbhashEncode(gradient(50, 40), 50, 40);
  assert.deepEqual(a, thumbhashEncode(gradient(50, 40), 50, 40));
  const text = toBase64(a);
  assert.ok(!text.includes('='));
  assert.deepEqual(fromBase64(text), a);
  assert.deepEqual(thumbhashDecode(fromBase64(text)), thumbhashDecode(a));
  assert.throws(() => fromBase64('a*b'), /not base64/);
});

test('bad thumbhash input is refused: oversize, wrong buffer, short or wrong-length hashes', () => {
  assert.throws(() => thumbhashEncode(solid(101, 10, 0, 0, 0), 101, 10), /does not fit in 100x100/);
  assert.throws(() => thumbhashEncode(solid(10, 10, 0, 0, 0), 10, 11), /expected 440 bytes/);
  assert.throws(() => thumbhashEncode(solid(10, 10, 0, 0, 0), 0, 10), /at least 1/);
  const good = thumbhashEncode(gradient(40, 40), 40, 40);
  assert.throws(() => thumbhashDecode(good.subarray(0, 4)), /at least 5 bytes/);
  assert.throws(() => thumbhashDecode(good.subarray(0, good.length - 1)), /should be \d+ bytes/);
  assert.throws(() => thumbhashDecode(new Uint8Array([...good, 0])), /should be \d+ bytes/);
  assert.throws(() => thumbhashColour(new Uint8Array(3)), HashError);
});

// ------------------------------------------------------------ downscale

test('downscale averages boxes of pixels, keeps the shape, and leaves small images alone', () => {
  const px = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]);
  const one = downscale(px, 2, 2, 1);
  assert.deepEqual([one.width, one.height], [1, 1]);
  assert.deepEqual(Array.from(one.pixels), [100, 100, 100, 255]);
  const big = downscale(solid(400, 200, 9, 9, 9), 400, 200, 100);
  assert.deepEqual([big.width, big.height], [100, 50]);
  assert.deepEqual(at(big, 50, 25), [9, 9, 9, 255]);
  const same = downscale(solid(30, 20, 1, 2, 3), 30, 20, 100);
  assert.deepEqual([same.width, same.height], [30, 20]);
  const t = downscale(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0]), 2, 1, 1); // an opaque red and a clear blue: alpha-weighted, so red
  assert.deepEqual(Array.from(t.pixels), [255, 0, 0, 128]);
  assert.throws(() => downscale(px, 3, 2), /expected 24 bytes/);
  assert.throws(() => downscale(px, 2, 2, 0), /maxSide/);
});

test('a big photo goes through downscale and thumbhash end to end', () => {
  const small = downscale(gradient(640, 480), 640, 480, 100);
  const h = thumbhashEncode(small.pixels, small.width, small.height);
  assert.ok(h.length <= 25);
  const c = thumbhashColour(h);
  assert.ok(Math.abs(c.r - 128) < 25 && Math.abs(c.b - 128) < 25, JSON.stringify(c));
});
