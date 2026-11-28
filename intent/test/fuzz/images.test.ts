/** Fuzz: images (blocks/imagemeta inspect, stripJpeg). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused, inspect, stripJpeg } from '../../blocks/imagemeta/index.ts';
import { bounded, forAll } from './harness.ts';
import { MAX_PIXELS, PRIVATE, gif, jpeg, png, webp } from './images.jobs.ts';

const jobs = new URL('./images.jobs.ts', import.meta.url);

test('inspect on random bytes and mutated PNG/JPEG/GIF/WebP headers returns a sane Info or throws Refused (6000 cases, 9 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'inspectAny', cases: 6000, ms: 9000 });
});

test('stripJpeg on mutated JPEGs never loops and returns a shorter JPEG or throws Refused (4000 cases, 9 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'stripMutated', cases: 4000, ms: 9000 });
});

test('a JPEG segment length of 0 or 1 is refused or read without looping (3000 cases, 9 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'tinyLengths', cases: 3000, ms: 9000 });
});

test('valid PNG, GIF and WebP headers read back their size, or are refused past the pixel cap (400 cases)', async () => {
  await forAll('image header sizes', {
    cases: 400,
    gen: (r) => {
      const w = r.int(1, 0x3fff);
      const h = r.int(1, 0x3fff);
      const k = r.int(0, 2);
      return { w, h, kind: k, bytes: k === 0 ? png(w, h) : k === 1 ? gif(w, h) : webp(r, w, h) };
    },
    shrink: () => [],
    check: ({ w, h, bytes }) => {
      if (w * h > MAX_PIXELS) return assert.throws(() => inspect(bytes), Refused);
      const i = inspect(bytes);
      assert.deepEqual([i.width, i.height], [w, h]);
    },
  });
});

/** The markers of a JPEG's header segments, then whether anything follows the first EOI. */
const walk = (b: Buffer): { markers: number[]; trailing: number } => {
  const markers: number[] = [];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const m = b[p + 1]!;
    markers.push(m);
    if (m === 0xda) break;
    p += 2 + b.readUInt16BE(p + 2);
  }
  const eoi = b.indexOf(Buffer.from([0xff, 0xd9]), p);
  return { markers, trailing: eoi < 0 ? -1 : b.length - (eoi + 2) };
};

test('stripJpeg removes EXIF, XMP, Photoshop, comments and trailers, keeps the size, resets orientation, and is idempotent (400 cases)', async () => {
  await forAll('stripJpeg privacy', {
    cases: 400,
    gen: jpeg,
    shrink: () => [],
    check: (j) => {
      const before = inspect(j.bytes);
      assert.deepEqual([before.width, before.height, before.orientation], [j.width, j.height, j.orientation]);
      const out = stripJpeg(j.bytes);
      const w = walk(out);
      for (const m of w.markers) assert.ok(!PRIVATE.includes(m), `kept marker 0x${m.toString(16)}`);
      assert.equal(w.trailing, 0, 'bytes after the end of the picture');
      const after = inspect(out);
      assert.deepEqual([after.width, after.height, after.orientation], [j.width, j.height, 1]);
      assert.ok(stripJpeg(out).equals(out), 'not idempotent');
    },
  });
});
