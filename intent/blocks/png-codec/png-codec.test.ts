import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { ImageError, decode, decodeBmp, decodeGif, decodePng, detect, encodeBmp, encodeGif, encodePng } from './index.ts';
import type { Image } from './index.ts';

// Images written by independent encoders (Pillow, ImageMagick); for GIF also the RGBA that Pillow reads back.
const VEC: Record<string, string> = {
  png_rgb8: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHCAIAAABV+fA3AAAAPElEQVR42mNkYGBQZceOWLhNGbjZWbEiuBwXJkKW40dDaHIiEKTKLsLNLoIpJ8nNLsltKsnNLolVTg6CAFf0CTu42FzNAAAAAElFTkSuQmCC',
  png_rgba8: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHCAYAAADam2dgAAAASklEQVR4XmNkYGBgUGVnkMWHWbhNGQS52VnxYiRFXILcODCaIn5BbiwYiyIRQW4oVoXQyG4CWQcyCSQhCcGmkrIgGodJIEVycAwA1F4N0XMnJV4AAAAASUVORK5CYII=',
  png_gray8: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHCAAAAAD/8Di8AAAAEklEQVR4XmNkEIcCJk4YIJ0FAGmAAqwDUyaQAAAAAElFTkSuQmCC',
  png_gray1: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHAQAAAADy4FrNAAAAFUlEQVR4XmOYxMCoEsPgycDkiWAAACCeAr35V/pUAAAAAElFTkSuQmCC',
  png_gray16: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHEAAAAACvYOT/AAAAJklEQVR4XmNkYODewbODZweEBNFMjF+YkCCYhywAZeMUQtFOlEYAYmA6DJhiA2sAAAAASUVORK5CYII=',
  png_pal: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHAgMAAACn9Y/zAAAADFBMVEUA/wdQwzmgh2vwS52ohFnvAAAAAnRSTlP/AOW3MEoAAAAbSURBVHheY5CWZmAJZLjC4sogwniM4RcDEh8AR4IFOgOqpnAAAAAASUVORK5CYII=',
  png_pal4: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHBAMAAAAotXpTAAAAMFBMVEUAAP8QCO8gEN8wGM9AIL9QKK9gMJ9wOI+AQH+QSG+gUF+wWE/AYD/QaC/gcB/weA/iU6oIAAAAGklEQVR4XmNgzjyv2sAkKMgoKMAkKCiImwQAavwD1fvYPboAAAAASUVORK5CYII=',
  png_la: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHCAQAAABwkq/rAAAAFUlEQVR4XmNkYBCXRYVMnILokMZCAAMCBypuTD8eAAAAAElFTkSuQmCC',
  png_rgb8_adam7: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAHCAIAAAEi/sChAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqCxwILBurU7iIAAAAgUlEQVQI123JMQoCMRRF0ReIfBjl24QHgcEuEORXgmCRFaSawlVkPS7ApbiI1LMGl2AxkkbhNJcLAPkGPGbAOl7v5X54oirWM7z1bPPi2FA1DN46TLNpMS1Vi0uCql+ebaKGzRYnaqbmERe24vZXJNn95dlAmSjHX+MFShySREr8AEE4GNhetX8MAAAAAElFTkSuQmCC',
  gif_pal: 'R0lGODdhCQAHAIIAAAAA/x486zx411q0w3jwr5Ysm7Roh9KkcywAAAAACQAHAAAIJgABCCBgQCBBAAEGFDiQcGGAgQUhClTIkGLCgxIHOrSoMCJGggEBADs=',
  gif_transp: 'R0lGODlhCQAHAIIAAAAA/x486zx411q0w3jwr5Ysm7Roh9KkcyH5BAEAAAMALAAAAAAJAAcAAAgmAAEIIGBAIEEAAQYUOJBwYYCBBSEKVMiQYsKDEgc6tKgwIkaCAQEAOw==',
  gif_interlaced: 'R0lGODlhCQAHAPUAAAAAACUHADcJAAMxAAs1ACg4ADA8BUoOAFwQGW8VAEI+ABZqADtxCg5mIzNtKFVDCnpKD2dFHmB4FJQcALkjAIEXMt4qAJ9RFIV/HoxMPMRYGelfHqYeS8slZPAsfbFTWtZaeCGfAEamD2utHizUAFHbFHbiKBmbRj6iUCTQaQr+eEnXeKqGKJC0LbW7PM+NMvSUPJvpPNrCS//JWsDwUOX3ZC8FjBUzljo6r1QMoCBotF9ByEVv0mp28PthlgAAACH5BAAAAAAAIf8LSW1hZ2VNYWdpY2sOZ2FtbWE9MC40NTQ1NDUALAAAAAAJAAcAQAY5QEDgkJhQLIMCqWSK0WoqW27BkGBYL9gJpYhkPiCfjtcjGB6Qi2bTcIREo5ZLNkutBIgKp+O54XZBADs=',
  bmp_rgb24: 'Qk36AAAAAAAAADYAAAAoAAAACQAAAAcAAAABABgAAAAAAMQAAADEDgAAxA4AAAAAAAAAAAAAAD5CHkVnPEyMWlOxeFrWlmH7tGgg0m9F8HZqAAAJNxkQXDIXgUsepmQly30s8JYzFa86OshBXwAA1CwU21Eo4nY86ZtQ8MBk9+V4/gqMBS+gDFQAAJ8hD6ZGHq1rLbSQPLu1S8LaWsn/adAkeNdJAABqFgpxOxR4YB5/hSiGqjKNzzyU9EabGVCiPgAANQsFPDAKQ1UPSnoUUZ8ZWMQeX+kjZg4obTMAAAAAAAclAA5KABVvAByUACO5ACreADEDADgoAA==',
  bmp_pal8: 'Qk2KBAAAAAAAADYEAAAoAAAACQAAAAcAAAABAAgAAAAAAFQAAADEDgAAxA4AAAABAAAAAQAAB/8AADnDUABrh6AAnUvwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDAAECAwABAgAAAAECAwABAgMAAQAAAAABAgMAAQIDAAAAAAMAAQIDAAECAwAAAAIDAAECAwABAgAAAAECAwABAgMAAQAAAAABAgMAAQIDAAAAAA==',
  bmp_gray1: 'Qk1aAAAAAAAAAD4AAAAoAAAACQAAAAcAAAABAAEAAAAAABwAAADEDgAAxA4AAAIAAAACAAAAAAAAAP///wCSAAAASQAAACSAAACSAAAASQAAACSAAACSAAAA',
  bmp_rgba32: 'Qk0yAQAAAAAAADYAAAAoAAAACQAAAAcAAAABACAAAAAAAPwAAADEDgAAxA4AAAAAAAAAAAAAAD5CZh5FZ4M8TIygWlOxvXha1tqWYfv3tGggFNJvRTHwdmpOAAk3VRkQXHIyF4GPSx6mrGQly8l9LPDmljMVA686OiDIQV89ANQsRBTbUWEo4nZ+POmbm1DwwLhk9+XVeP4K8owFLw+gDFQsAJ8hMw+mRlAerWttLbSQijy7tadLwtrEWsn/4WnQJP5410kbAGoWIgpxOz8UeGBcHn+FeSiGqpYyjc+zPJT00EabGe1Qoj4KADULEQU8MC4KQ1VLD0p6aBRRn4UZWMSiHl/pvyNmDtwobTP5AAAAAAAHJR0ADko6ABVvVwAclHQAI7mRACrergAxA8sAOCjo',
};
const GIF_RGBA: Record<string, string> = {
  gif_pal: '0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff1e3cebff5ab4c3ff962c9bffd2a473ff1e3cebff5ab4c3ff962c9bffd2a473ff1e3cebff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff5ab4c3ff962c9bffd2a473ff1e3cebff5ab4c3ff962c9bffd2a473ff1e3cebff5ab4c3ff78f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afff962c9bffd2a473ff1e3cebff5ab4c3ff962c9bffd2a473ff1e3cebff5ab4c3ff962c9bffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff',
  gif_transp: '0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff1e3cebff5ab4c300962c9bffd2a473ff1e3cebff5ab4c300962c9bffd2a473ff1e3cebff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff5ab4c300962c9bffd2a473ff1e3cebff5ab4c300962c9bffd2a473ff1e3cebff5ab4c30078f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afff962c9bffd2a473ff1e3cebff5ab4c300962c9bffd2a473ff1e3cebff5ab4c300962c9bffb46887ff0000ffff3c78d7ff78f0afffb46887ff0000ffff3c78d7ff78f0afffb46887ff',
  gif_interlaced: '000000ff250700ff4a0e00ff6f1500ff941c00ffb92300ffde2a00ff033100ff283800ff0b3500ff303c05ff55430aff7a4a0fff9f5114ffc45819ffe95f1eff0e6623ff336d28ff166a00ff3b710aff607814ff857f1effaa8628ffcf8d32fff4943cff199b46ff3ea250ff219f00ff46a60fff6bad1eff90b42dffb5bb3cffdac24bffffc95aff24d069ff49d778ff2cd400ff51db14ff76e228ff9be93cffc0f050ffe5f764ff0afe78ff2f058cff540ca0ff370900ff5c1019ff811732ffa61e4bffcb2564fff02c7dff153396ff3a3aafff5f41c8ff423e00ff67451eff8c4c3cffb1535affd65a78fffb6196ff2068b4ff456fd2ff6a76f0ff',
};

const W = 9;
const H = 7;
const rgbAt = (x: number, y: number) => [(x * 37 + y * 11) & 255, (x * 7 + y * 53) & 255, (x * y * 5) & 255];
const alphaAt = (x: number, y: number) => (x * 29 + y * 17) & 255;
const grayAt = (x: number, y: number) => (x * 23 + y * 9) & 255;
const b64 = (k: string) => Buffer.from(VEC[k]!, 'base64');
const px = (img: Image, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

function each(img: Image, f: (x: number, y: number, p: number[]) => number[]) {
  assert.equal(img.width, W);
  assert.equal(img.height, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.deepEqual(px(img, x, y), f(x, y, px(img, x, y)), `pixel ${x},${y}`);
}

function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}
function pngOf(w: number, h: number, depth: number, color: number, raw: Buffer, extra: Buffer[] = [], interlace = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = color;
  ihdr[12] = interlace;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

test('PNG: RGB 8-bit from Pillow decodes to the exact pixels', () => {
  const d = decodePng(b64('png_rgb8'));
  assert.deepEqual(d.info, { bitDepth: 8, colorType: 'rgb', interlaced: false, hasAlpha: false });
  each(d.image, (x, y) => [...rgbAt(x, y), 255]);
});

test('PNG: RGBA 8-bit keeps straight alpha', () => {
  const d = decodePng(b64('png_rgba8'));
  assert.equal(d.info.hasAlpha, true);
  each(d.image, (x, y) => [...rgbAt(x, y), alphaAt(x, y)]);
});

test('PNG: grey 8-bit, grey 1-bit (scaled to 0/255), grey 16-bit (high byte), grey+alpha', () => {
  each(decodePng(b64('png_gray8')).image, (x, y) => [grayAt(x, y), grayAt(x, y), grayAt(x, y), 255]);
  const bw = decodePng(b64('png_gray1'));
  assert.equal(bw.info.bitDepth, 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.deepEqual(px(bw.image, x, y).slice(0, 3), (x + y) % 3 === 0 ? [255, 255, 255] : [0, 0, 0], `1-bit ${x},${y}`);
  const g16 = decodePng(b64('png_gray16'));
  assert.equal(g16.info.bitDepth, 16);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = ((x * 3000 + y * 500) & 0xffff) >> 8;
    assert.deepEqual(px(g16.image, x, y), [v, v, v, 255], `16-bit ${x},${y}`);
  }
  const la = decodePng(b64('png_la'));
  assert.equal(la.info.colorType, 'gray-alpha');
  each(la.image, (x, y) => [grayAt(x, y), grayAt(x, y), grayAt(x, y), alphaAt(x, y)]);
});

test('PNG: palettes of 2 and 4 bits, with tRNS making one entry transparent', () => {
  const p2 = decodePng(b64('png_pal'));
  assert.equal(p2.info.bitDepth, 2);
  assert.equal(p2.info.hasAlpha, true);
  each(p2.image, (x, y) => {
    const i = (x + y) % 4;
    return [i * 80, 255 - i * 60, (i * 50 + 7) & 255, i === 1 ? 0 : 255];
  });
  const p4 = decodePng(b64('png_pal4'));
  assert.equal(p4.info.bitDepth, 4);
  each(p4.image, (x, y) => {
    const i = (x * 3 + y) % 16;
    return [i * 16, i * 8, 255 - i * 16, 255];
  });
});

test('PNG: Adam7 interlaced image (ImageMagick) has the same pixels as the plain one', () => {
  const d = decodePng(b64('png_rgb8_adam7'));
  assert.equal(d.info.interlaced, true);
  each(d.image, (x, y) => [...rgbAt(x, y), 255]);
});

test('PNG: every filter type reconstructs, including at the first row and first pixel', () => {
  const w = 5;
  const h = 5;
  const src: number[][] = [];
  for (let y = 0; y < h; y++) src.push(Array.from({ length: w }, (_, x) => (x * 41 + y * 17 + 3) & 255));
  for (let ft = 0; ft < 5; ft++) {
    const rows: number[] = [];
    for (let y = 0; y < h; y++) {
      rows.push(ft);
      for (let x = 0; x < w; x++) {
        const a = x > 0 ? src[y]![x - 1]! : 0;
        const b = y > 0 ? src[y - 1]![x]! : 0;
        const c = x > 0 && y > 0 ? src[y - 1]![x - 1]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        rows.push((src[y]![x]! - pred) & 255);
      }
    }
    const img = decodePng(pngOf(w, h, 8, 0, Buffer.from(rows))).image;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.equal(img.data[(y * w + x) * 4], src[y]![x], `filter ${ft} at ${x},${y}`);
  }
});

test('PNG: tRNS colour key makes matching pixels transparent', () => {
  const raw = Buffer.from([0, 10, 20, 30, 40, 50, 60, 10, 20, 30]);
  const t = Buffer.from([0, 10, 0, 20, 0, 30]);
  const d = decodePng(pngOf(2, 1, 8, 2, Buffer.concat([raw.subarray(0, 1), raw.subarray(1, 7)]), [pngChunk('tRNS', t)]));
  assert.deepEqual([...d.image.data], [10, 20, 30, 0, 40, 50, 60, 255]);
});

test('PNG: corrupted files are refused with a plain reason', () => {
  const good = Buffer.from(b64('png_rgb8'));
  const bad = Buffer.from(good);
  bad[good.length - 20] = bad[good.length - 20]! ^ 0xff;
  assert.throws(() => decodePng(bad), /fails its CRC/);
  assert.throws(() => decodePng(good.subarray(0, good.length - 30)), /cut short/);
  assert.throws(() => decodePng(good.subarray(0, 40)), ImageError);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
  const noEnd = Buffer.from(good.subarray(0, good.length - 12));
  assert.throws(() => decodePng(noEnd), /no IEND/);
  assert.throws(() => decodePng(pngOf(1, 1, 8, 0, Buffer.from([9, 0]))), /unknown filter type 9/);
  assert.throws(() => decodePng(pngOf(1, 1, 3, 0, Buffer.from([0, 0]))), /cannot have bit depth/);
  assert.throws(() => decodePng(pngOf(1, 1, 8, 3, Buffer.from([0, 0]))), /no palette/);
  assert.throws(() => decodePng(pngOf(1, 1, 8, 3, Buffer.from([0, 5]), [pngChunk('PLTE', Buffer.from([1, 2, 3]))])), /past the end of the palette/);
  assert.throws(() => decodePng(pngOf(1, 1, 8, 0, Buffer.from([0, 0]), [pngChunk('ABCD', Buffer.alloc(0))])), /critical chunk ABCD/);
  assert.equal(decodePng(pngOf(1, 1, 8, 0, Buffer.from([0, 7]), [pngChunk('abCD', Buffer.alloc(0))])).image.data[0], 7, 'unknown ancillary chunks are skipped');
});

test('PNG: a decompression bomb and an absurd size are refused before they cost memory', () => {
  const bomb = pngOf(1, 1, 8, 0, Buffer.alloc(50_000_000));
  assert.ok(bomb.length < 100_000, 'the bomb is small on the wire');
  assert.throws(() => decodePng(bomb), /inflates to more than its header allows/);
  const huge = pngOf(100_000, 100_000, 8, 0, Buffer.from([0]));
  assert.throws(() => decodePng(huge), /too many pixels|pixel limit/);
  assert.throws(() => decodePng(b64('png_rgb8'), { maxPixels: 10 }), /pixel/);
  assert.throws(() => decodePng(pngOf(2, 2, 8, 0, Buffer.from([0, 1, 2]))), /bytes where 6 were expected/);
});

test('PNG: the encoder picks the smallest colour type and every result decodes to the same pixels', () => {
  const make = (f: (x: number, y: number) => number[]): Image => {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(f(x, y), (y * W + x) * 4);
    return { width: W, height: H, data };
  };
  const kind = (b: Buffer) => ({ depth: b[24], color: b[25] });
  const bw = make((x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  assert.deepEqual(kind(encodePng(bw)), { depth: 1, color: 0 });
  const g4 = make((x) => [x * 17, x * 17, x * 17, 255]);
  assert.deepEqual(kind(encodePng(g4)), { depth: 4, color: 0 });
  const grad = make((x, y) => [grayAt(x, y), grayAt(x, y), grayAt(x, y), 255]);
  assert.deepEqual(kind(encodePng(grad)), { depth: 8, color: 0 });
  const few = make((x, y) => [...rgbAt(x % 3, y % 2), 255]);
  assert.deepEqual(kind(encodePng(few)), { depth: 4, color: 3 }, 'six colours need 4 bits');
  const two = make((x) => (x % 2 ? [200, 10, 10, 255] : [10, 10, 200, 255]));
  assert.deepEqual(kind(encodePng(two)), { depth: 1, color: 3 });
  const richData = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) richData.set([i & 255, (i * 7) >> 2, i >> 3, 255], i * 4);
  const rich: Image = { width: 32, height: 32, data: richData };
  assert.equal(kind(encodePng(rich)).color, 2, 'more than 256 colours and opaque: RGB');
  const alphaData = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) alphaData.set([i & 255, (i * 7) >> 2, i >> 3, (i * 5) & 255], i * 4);
  const alpha: Image = { width: 32, height: 32, data: alphaData };
  assert.equal(kind(encodePng(alpha)).color, 6, 'many colours with alpha: RGBA');
  assert.equal(kind(encodePng(make((x, y) => [...rgbAt(x, y), alphaAt(x, y)]))).color, 3, 'few colours with alpha: palette with tRNS');
  assert.equal(kind(encodePng(two, { keepRgba: true })).color, 6);
  for (const img of [bw, g4, grad, few, two, rich, alpha]) assert.deepEqual([...decodePng(encodePng(img)).image.data], [...img.data]);
  const tr = make((x, y) => (x === 0 ? [0, 0, 0, 0] : [...rgbAt(x, y), 255]));
  const trPng = encodePng(tr);
  assert.equal(trPng.includes(Buffer.from('tRNS')), true);
  assert.deepEqual([...decodePng(trPng).image.data], [...tr.data]);
});

test('PNG: fixed and adaptive filters and levels all round trip; adaptive is not larger than filter 0 on a gradient', () => {
  const w = 64;
  const h = 64;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x * 4, y * 4, (x + y) * 2, 255], (y * w + x) * 4);
  const img = { width: w, height: h, data };
  for (const filter of [0, 1, 2, 3, 4, 'adaptive'] as const) assert.deepEqual([...decodePng(encodePng(img, { filter, level: filter === 0 ? 0 : 9 })).image.data], [...data], `filter ${filter}`);
  assert.ok(encodePng(img).length < encodePng(img, { filter: 0 }).length);
  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) }), /width x height x 4/);
});

test('BMP: 24-bit, 8-bit palette, 1-bit and 32-bit with alpha from Pillow decode to the exact pixels', () => {
  each(decodeBmp(b64('bmp_rgb24')).image, (x, y) => [...rgbAt(x, y), 255]);
  each(decodeBmp(b64('bmp_pal8')).image, (x, y) => {
    const i = (x + y) % 4;
    return [i * 80, 255 - i * 60, (i * 50 + 7) & 255, 255];
  });
  const bw = decodeBmp(b64('bmp_gray1'));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.deepEqual(px(bw.image, x, y).slice(0, 3), (x + y) % 3 === 0 ? [255, 255, 255] : [0, 0, 0], `bmp 1-bit ${x},${y}`);
  const a = decodeBmp(b64('bmp_rgba32'));
  assert.equal(a.info.hasAlpha, true);
  each(a.image, (x, y) => [...rgbAt(x, y), alphaAt(x, y)]);
});

test('BMP: the encoder writes 24-bit or 32-bit, bottom-up, and our decoder and Pillow-made files agree', () => {
  const opaque = decodeBmp(b64('bmp_rgb24')).image;
  const out = encodeBmp(opaque);
  assert.equal(out.readUInt16LE(28), 24);
  assert.equal(out.length, 54 + Math.ceil((W * 24) / 32) * 4 * H);
  assert.deepEqual([...decodeBmp(out).image.data], [...opaque.data]);
  const alpha = decodeBmp(b64('bmp_rgba32')).image;
  const out32 = encodeBmp(alpha);
  assert.equal(out32.readUInt16LE(28), 32);
  assert.equal(out32.readUInt32LE(30), 3);
  assert.deepEqual([...decodeBmp(out32).image.data], [...alpha.data]);
});

test('BMP: top-down files, hostile headers and unsupported compression are handled', () => {
  const rgb = Buffer.from(b64('bmp_rgb24'));
  const td = Buffer.from(rgb);
  td.writeInt32LE(-H, 22);
  const flipped = decodeBmp(td).image;
  assert.deepEqual(px(flipped, 0, 0), [...rgbAt(0, H - 1), 255], 'a top-down file shows its rows in file order');
  const rle = Buffer.from(rgb);
  rle.writeUInt32LE(1, 30);
  assert.throws(() => decodeBmp(rle), /compression 1 is not supported/);
  assert.throws(() => decodeBmp(rgb.subarray(0, 100)), /cut short/);
  const big = Buffer.from(rgb);
  big.writeInt32LE(100000, 18);
  big.writeInt32LE(100000, 22);
  assert.throws(() => decodeBmp(big), /pixel limit/);
  const weird = Buffer.from(rgb);
  weird.writeUInt16LE(16, 28);
  assert.throws(() => decodeBmp(weird), /16 bits per pixel/);
  assert.throws(() => decodeBmp(Buffer.from('BM')), ImageError);
});

test('GIF: palette, transparency and interlacing decode to what Pillow reads', () => {
  for (const k of ['gif_pal', 'gif_transp', 'gif_interlaced']) {
    const d = decodeGif(b64(k));
    const norm = (h: string) => (h.match(/.{8}/g) ?? []).map((p) => (p.endsWith('00') ? '00000000' : p)).join(''); // the colour of a transparent pixel means nothing
    assert.equal(norm(Buffer.from(d.image.data).toString('hex')), norm(GIF_RGBA[k]!), k);
    assert.equal(d.info.frames, 1);
  }
  assert.equal(decodeGif(b64('gif_transp')).info.hasAlpha, true);
  assert.equal(decodeGif(b64('gif_interlaced')).info.interlaced, true);
});

test('GIF: the encoder round trips, writes a transparent index, and refuses what a GIF cannot hold', () => {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(x === 4 ? [0, 0, 0, 0] : [...rgbAt(x % 4, y % 3), 255], (y * W + x) * 4);
  const img = { width: W, height: H, data };
  const g = encodeGif(img);
  assert.equal(g.toString('latin1', 0, 6), 'GIF89a');
  const back = decodeGif(g);
  assert.equal(back.info.hasAlpha, true);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.deepEqual(px(back.image, x, y), x === 4 ? [0, 0, 0, 0] : [...rgbAt(x % 4, y % 3), 255]);
  const partial = new Uint8Array(4);
  partial.set([1, 2, 3, 128]);
  assert.throws(() => encodeGif({ width: 1, height: 1, data: partial }), /alpha must be 0 or 255/);
  const many = new Uint8Array(300 * 4);
  for (let i = 0; i < 300; i++) many.set([i & 255, i >> 8, 7, 255], i * 4);
  assert.throws(() => encodeGif({ width: 300, height: 1, data: many }), /300 colours do not fit/);
});

test('GIF: noisy images exercise code-size growth and table resets and still round trip', () => {
  let s = 99;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const w = 200;
  const h = 150;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = Math.floor(rnd() * 200);
    data.set([c, (c * 7) & 255, (c * 13) & 255, 255], i * 4);
  }
  const g = encodeGif({ width: w, height: h, data });
  assert.deepEqual([...decodeGif(g).image.data], [...data]);
  const flat = new Uint8Array(w * h * 4).fill(255);
  assert.ok(encodeGif({ width: w, height: h, data: flat }).length < 400, 'a flat image compresses to almost nothing');
});

test('GIF: damaged and hostile files are refused', () => {
  const good = Buffer.from(b64('gif_pal'));
  assert.throws(() => decodeGif(good.subarray(0, good.length - 10)), /cut short|less pixel data/);
  assert.throws(() => decodeGif(Buffer.from('GIF89a')), ImageError);
  const huge = Buffer.from(good);
  huge.writeUInt16LE(65535, 6);
  huge.writeUInt16LE(65535, 8);
  assert.throws(() => decodeGif(huge), /pixel limit/);
  assert.throws(() => decodeGif(Buffer.from('PNG nope nope nope')), /not a GIF/);
  const noImage = Buffer.concat([good.subarray(0, 13 + 24), Buffer.from([0x3b])]);
  assert.throws(() => decodeGif(noImage), /no image/);
});

test('detect and decode choose by the bytes, not the name', () => {
  assert.equal(detect(b64('png_rgb8')), 'png');
  assert.equal(detect(b64('gif_pal')), 'gif');
  assert.equal(detect(b64('bmp_rgb24')), 'bmp');
  assert.equal(detect(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), undefined, 'JPEG is not handled here');
  assert.equal(decode(b64('bmp_rgb24')).format, 'bmp');
  assert.equal(decode(b64('gif_pal')).format, 'gif');
  assert.throws(() => decode(Buffer.from('plain text')), /not a PNG, BMP or GIF/);
});
