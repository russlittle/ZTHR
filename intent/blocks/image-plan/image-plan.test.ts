import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from '../imagemeta/index.ts';
import {
  applyStrip, buildSrcset, chooseWidths, cropPlan, displaySize, focalCrop, ImagePlanError, negotiate, pickCandidate, pictureHtml, sizesAttribute, stripPlan, stripPng, urlTemplate,
} from './index.ts';

const url = urlTemplate('/img/{id}?w={w}&h={h}&f={fmt}&q={q}', { id: 'a b' });

// ------------------------------------------------------------ sizes

test('displayed size swaps for the orientations that turn the picture on its side', () => {
  for (const o of [1, 2, 3, 4]) assert.deepEqual(displaySize({ width: 4032, height: 3024 }, o), { width: 4032, height: 3024 });
  for (const o of [5, 6, 7, 8]) assert.deepEqual(displaySize({ width: 4032, height: 3024 }, o), { width: 3024, height: 4032 });
  assert.throws(() => displaySize({ width: 4032, height: 3024 }, 9), /1 to 8/);
  assert.throws(() => displaySize({ width: 0, height: 10 }), /whole numbers/);
});

test('the width ladder never goes above the source, and gives the source its own rung when it falls between rungs', () => {
  assert.deepEqual(chooseWidths({ source: { width: 1000, height: 700 } }), [320, 480, 640, 768, 960, 1000]);
  assert.deepEqual(chooseWidths({ source: { width: 1280, height: 700 } }), [320, 480, 640, 768, 960, 1280]);
  assert.deepEqual(chooseWidths({ source: { width: 200, height: 100 } }), [200]); // smaller than the smallest rung: just itself
  assert.deepEqual(chooseWidths({ source: { width: 5000, height: 3000 } }).at(-1), 3840); // a huge source is not offered whole
  assert.deepEqual(chooseWidths({ source: { width: 5000, height: 3000 }, maxCssWidth: 500, maxDensity: 2 }), [320, 480, 640, 768, 960, 1000]);
  assert.deepEqual(chooseWidths({ source: { width: 3000, height: 2000 }, maxCssWidth: 600, maxDensity: 1 }), [320, 480, 600]);
  assert.deepEqual(chooseWidths({ source: { width: 2000, height: 2000 }, widths: [100, 400, 800], minWidth: 300 }), [400, 800]);
  assert.throws(() => chooseWidths({ source: { width: 100, height: 100 }, widths: [] }), /whole numbers/);
  assert.throws(() => chooseWidths({ source: { width: 100, height: 100 }, widths: [10.5] }), /whole numbers/);
  assert.throws(() => chooseWidths({ source: { width: 100, height: 100 }, maxDensity: 0.5 }), /at least 1/);
  assert.throws(() => chooseWidths({ source: { width: 100, height: 100 }, maxCssWidth: 0 }), /at least 1/);
});

test('srcset lists each width with its proportional height, in order, with encoded URLs', () => {
  const s = buildSrcset({ source: { width: 1280, height: 720 }, format: 'webp', url, quality: 75 });
  assert.deepEqual(s.candidates.map((c) => [c.width, c.height, c.descriptor]), [[320, 180, '320w'], [480, 270, '480w'], [640, 360, '640w'], [768, 432, '768w'], [960, 540, '960w'], [1280, 720, '1280w']]);
  assert.equal(s.candidates[0]!.url, '/img/a%20b?w=320&h=180&f=webp&q=75');
  assert.equal(s.srcset.split(', ').length, 6);
  assert.match(s.srcset, /^\/img\/a%20b\?w=320&h=180&f=webp&q=75 320w, /);
  assert.throws(() => buildSrcset({ source: { width: 1280, height: 720 }, format: 'webp', url, quality: 0 }), /1 to 100/);
  assert.throws(() => buildSrcset({ source: { width: 1280, height: 720 }, format: 'webp', url: () => '/a b.jpg' }), /spaces or commas/);
  assert.throws(() => buildSrcset({ source: { width: 1280, height: 720 }, format: 'webp', url: () => '/a,b.jpg' }), /spaces or commas/);
  assert.throws(() => urlTemplate('/x/{nope}')({ width: 1, height: 1, format: 'png', quality: 1 }), /names \{nope\}/);
});

test('url values are encoded so a hostile name cannot break out of the query', () => {
  const u = urlTemplate('/i?p={path}&w={w}', { path: 'a&w=1#x' });
  assert.equal(u({ width: 5, height: 5, format: 'png', quality: 80 }), '/i?p=a%26w%3D1%23x&w=5');
});

test('sizes puts the widest breakpoint first and needs exactly one default', () => {
  assert.equal(sizesAttribute([{ minViewport: 640, width: '50vw' }, { width: '100vw' }, { minViewport: 1024, width: '33vw' }]), '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw');
  assert.equal(sizesAttribute([{ width: '640px' }]), '640px');
  assert.equal(sizesAttribute([{ width: 'calc(100vw - 2rem)' }]), 'calc(100vw - 2rem)');
  assert.throws(() => sizesAttribute([]), /at least one/);
  assert.throws(() => sizesAttribute([{ minViewport: 640, width: '50vw' }]), /exactly one rule without a breakpoint/);
  assert.throws(() => sizesAttribute([{ width: '100vw' }, { width: '50vw' }]), /exactly one/);
  assert.throws(() => sizesAttribute([{ width: '100%; evil' }]), /not a length/);
  assert.throws(() => sizesAttribute([{ minViewport: 0, width: '1px' }, { width: '2px' }]), /breakpoint/);
});

test('the candidate a browser would take: the smallest that covers the slot at its density, else the largest', () => {
  const { candidates } = buildSrcset({ source: { width: 1280, height: 720 }, format: 'jpeg', url });
  assert.equal(pickCandidate(candidates, 300, 1).width, 320);
  assert.equal(pickCandidate(candidates, 300, 2).width, 640);
  assert.equal(pickCandidate(candidates, 480, 1).width, 480);
  assert.equal(pickCandidate(candidates, 481, 1).width, 640);
  assert.equal(pickCandidate(candidates, 2000, 3).width, 1280);
  assert.throws(() => pickCandidate([], 100, 1), /no candidates/);
  assert.throws(() => pickCandidate(candidates, 0, 1), /above zero/);
});

// ------------------------------------------------------------ picture

test('picture markup: a source per better format, the fallback img with real size, lazy loading, escaped alt', () => {
  const html = pictureHtml({ source: { width: 1280, height: 720 }, formats: ['avif', 'webp', 'jpeg'], url, alt: 'A "quoted" <b>view</b> & more', sizes: '100vw' });
  assert.match(html, /^<picture><source type="image\/avif" srcset="[^"]*f=avif[^"]*" sizes="100vw"><source type="image\/webp"/);
  assert.match(html, /<img src="\/img\/a%20b\?w=640&amp;h=360&amp;f=jpeg&amp;q=80" srcset=/);
  assert.match(html, /width="1280" height="720" alt="A &quot;quoted&quot; &lt;b&gt;view&lt;\/b&gt; &amp; more" loading="lazy" decoding="async">/);
  assert.ok(!html.includes('fetchpriority'));
  assert.ok(!html.includes('<b>'));
  assert.equal((html.match(/<source /g) ?? []).length, 2);
});

test('a single format makes a plain img, eager adds priority, and a class is escaped', () => {
  const html = pictureHtml({ source: { width: 800, height: 600 }, formats: ['jpeg'], url, alt: 'x', sizes: '800px', eager: true, className: 'hero" onload="x' });
  assert.ok(html.startsWith('<img '));
  assert.match(html, /loading="eager" decoding="async" fetchpriority="high" class="hero&quot; onload=&quot;x">$/);
});

test('alt text is required unless the picture is decorative, and a decorative one must have none', () => {
  const base = { source: { width: 800, height: 600 }, formats: ['jpeg'] as const, url, sizes: '100vw' };
  assert.throws(() => pictureHtml({ ...base, formats: [...base.formats], alt: '' }), /needs alt text/);
  assert.match(pictureHtml({ ...base, formats: [...base.formats], alt: '', decorative: true }), /alt=""/);
  assert.throws(() => pictureHtml({ ...base, formats: [...base.formats], alt: 'x', decorative: true }), /empty alt/);
  assert.throws(() => pictureHtml({ ...base, formats: [], alt: 'x' }), /at least one format/);
});

// ------------------------------------------------------------ focal crop

test('a crop of a wanted shape is centred on the focal point and slid back inside the frame', () => {
  const src = { width: 4000, height: 3000 };
  assert.deepEqual(focalCrop(src, { width: 1, height: 1 }), { x: 500, y: 0, width: 3000, height: 3000 });
  assert.deepEqual(focalCrop(src, { width: 1, height: 1 }, { x: 0.1, y: 0.5 }), { x: 0, y: 0, width: 3000, height: 3000 });
  assert.deepEqual(focalCrop(src, { width: 1, height: 1 }, { x: 0.95, y: 0.5 }), { x: 1000, y: 0, width: 3000, height: 3000 });
  assert.deepEqual(focalCrop(src, { width: 1, height: 1 }, { x: 0.6, y: 0.5 }), { x: 900, y: 0, width: 3000, height: 3000 });
  const portrait = { width: 3000, height: 4000 };
  assert.deepEqual(focalCrop(portrait, { width: 16, height: 9 }), { x: 0, y: 1156, width: 3000, height: 1688 });
  assert.deepEqual(focalCrop(portrait, { width: 16, height: 9 }, { x: 0.5, y: 0 }), { x: 0, y: 0, width: 3000, height: 1688 });
  assert.deepEqual(focalCrop(src, { width: 4, height: 3 }, { x: 0.2, y: 0.2 }), { x: 0, y: 0, width: 4000, height: 3000 }); // same shape: the whole picture
  assert.deepEqual(focalCrop(src, { width: 400, height: 300 }), { x: 0, y: 0, width: 4000, height: 3000 }); // only the ratio matters
});

test('a crop never leaves the picture, for any focal point and shape', () => {
  const src = { width: 1234, height: 777 };
  for (const shape of [{ width: 1, height: 1 }, { width: 21, height: 9 }, { width: 9, height: 16 }, { width: 3, height: 2 }]) {
    for (const fx of [0, 0.25, 0.5, 0.99, 1]) {
      for (const fy of [0, 0.4, 1]) {
        const c = focalCrop(src, shape, { x: fx, y: fy });
        assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= src.width && c.y + c.height <= src.height && c.width >= 1 && c.height >= 1, JSON.stringify([shape, fx, fy, c]));
        assert.ok(Math.abs(c.width / c.height - shape.width / shape.height) < 0.01 * (shape.width / shape.height) + 1 / Math.min(c.width, c.height) * 2, `ratio ${shape.width}:${shape.height} got ${c.width}x${c.height}`);
      }
    }
  }
});

test('the crop plan resizes to the slot but never past the crop', () => {
  assert.deepEqual(cropPlan({ width: 4000, height: 3000 }, { width: 400, height: 400 }), { crop: { x: 500, y: 0, width: 3000, height: 3000 }, output: { width: 400, height: 400 } });
  assert.deepEqual(cropPlan({ width: 4000, height: 3000 }, { width: 5000, height: 5000 }).output, { width: 3000, height: 3000 });
  assert.deepEqual(cropPlan({ width: 1000, height: 500 }, { width: 600, height: 200 }, { x: 0, y: 0 }), { crop: { x: 0, y: 0, width: 1000, height: 333 }, output: { width: 600, height: 200 } });
  assert.throws(() => focalCrop({ width: 100, height: 100 }, { width: 0, height: 5 }), /above zero/);
  assert.throws(() => focalCrop({ width: 100, height: 100 }, { width: 1, height: 1 }, { x: 1.5, y: 0 }), /focal point/);
  assert.throws(() => focalCrop({ width: 100, height: 100 }, { width: 1, height: 1 }, { x: NaN, y: 0 }), /focal point/);
});

// ------------------------------------------------------------ stripping

const seg = (marker: number, body: Buffer) => {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
};
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
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.from([1, 2, 3, 4])]);
};
const png = (w: number, h: number, extra: Buffer[] = []) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', Buffer.from([9, 9, 9])), chunk('IEND', Buffer.alloc(0))]);
};

test('the strip plan says what goes, what stays, and when the rotation must be baked in first', () => {
  const p = stripPlan({ kind: 'jpeg', orientation: 6 });
  assert.equal(p.bakeOrientation, true);
  assert.equal(p.convertToSrgb, false);
  assert.ok(p.remove.some((r) => r.startsWith('EXIF')) && p.keep.includes('colour profile'));
  assert.match(p.notes[0]!, /orientation 6 is stored in the EXIF block being removed/);
  assert.equal(stripPlan({ kind: 'jpeg', orientation: 1 }).bakeOrientation, false);
  assert.equal(stripPlan({ kind: 'png', orientation: 1 }).bakeOrientation, false);
  const min = stripPlan({ kind: 'jpeg', orientation: 1 }, 'minimal');
  assert.equal(min.convertToSrgb, true);
  assert.ok(min.remove.includes('colour profile'));
  const keep = stripPlan({ kind: 'jpeg', orientation: 3 }, 'keep-all');
  assert.deepEqual([keep.remove, keep.bakeOrientation], [[], false]);
  assert.throws(() => stripPlan({ kind: 'jpeg', orientation: 1 }, 'whatever' as never), /unknown strip policy/);
});

test('a JPEG loses its EXIF, comment and GPS pointer but keeps its colour profile, and the size is still readable', () => {
  const src = jpeg(800, 600, 6);
  const r = applyStrip(src);
  assert.equal(r.changed, true);
  assert.equal(r.plan.bakeOrientation, true);
  assert.equal(r.info.orientation, 6);
  assert.ok(src.includes(Buffer.from('taken at home')));
  assert.ok(!r.bytes.includes(Buffer.from('taken at home')));
  assert.ok(!r.bytes.includes(Buffer.from('Exif')));
  assert.ok(r.bytes.includes(Buffer.from('ICC_PROFILE')));
  const after = inspect(r.bytes);
  assert.deepEqual([after.width, after.height, after.orientation], [800, 600, 1]);
});

test('keep-all changes nothing, and other formats are left alone and said so', () => {
  const src = jpeg(10, 10, 1);
  const kept = applyStrip(src, 'keep-all');
  assert.equal(kept.changed, false);
  assert.equal(kept.bytes, src);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x20, 0x00, 0x10, 0x00]), Buffer.alloc(10)]);
  const g = applyStrip(gif);
  assert.equal(g.changed, false);
  assert.ok(g.plan.notes.some((n) => /re-encoding/.test(n)));
});

test('a PNG loses its text, EXIF and time chunks and every other chunk is byte for byte the same', () => {
  const phys = chunk('pHYs', Buffer.alloc(9, 7));
  const src = png(32, 16, [chunk('tEXt', Buffer.from('Comment\0private')), phys, chunk('eXIf', Buffer.from('GPS')), chunk('iCCP', Buffer.from('profile')), chunk('tIME', Buffer.alloc(7)), chunk('iTXt', Buffer.from('xmp'))]);
  const out = stripPng(src);
  assert.equal(out.length, png(32, 16, [phys, chunk('iCCP', Buffer.from('profile'))]).length);
  assert.deepEqual(out, png(32, 16, [phys, chunk('iCCP', Buffer.from('profile'))]));
  assert.ok(!out.includes(Buffer.from('private')));
  const r = applyStrip(src);
  assert.equal(r.changed, true);
  assert.deepEqual([inspect(r.bytes).width, inspect(r.bytes).height], [32, 16]);
  assert.equal(applyStrip(png(4, 4)).changed, false); // nothing to remove
});

test('damaged PNGs are refused: not a PNG, cut short, no end chunk, bad chunk name, a length that runs off the end', () => {
  assert.throws(() => stripPng(Buffer.from('hello world, not a png at all')), /not a PNG/);
  const good = png(4, 4);
  assert.throws(() => stripPng(good.subarray(0, good.length - 5)), /cut short|no end chunk/);
  const noEnd = good.subarray(0, good.length - 12);
  assert.throws(() => stripPng(noEnd), /no end chunk/);
  const badName = Buffer.from(good);
  badName.write('\u0001\u0002\u0003\u0004', 12, 'latin1'); // damage the IHDR chunk name
  assert.throws(() => stripPng(badName), /damaged chunk name/);
  const huge = Buffer.from(good);
  huge.writeUInt32BE(0x7fffffff, 8);
  assert.throws(() => stripPng(huge), /cut short or damaged/);
});

// ------------------------------------------------------------ negotiation

test('the format follows the Accept header and the source: AVIF and WebP only when named, transparency never JPEG', () => {
  const j = inspect(jpeg(10, 10, 1));
  const p = inspect(png(10, 10));
  assert.deepEqual(negotiate({ accept: 'image/avif,image/webp,image/*,*/*;q=0.8', source: j }), { format: 'avif', mime: 'image/avif', vary: 'Accept' });
  assert.equal(negotiate({ accept: 'image/webp,*/*', source: j }).format, 'webp');
  assert.equal(negotiate({ accept: '*/*', source: j }).format, 'jpeg'); // a wildcard alone does not mean "send AVIF"
  assert.equal(negotiate({ accept: undefined, source: j }).format, 'jpeg');
  assert.equal(negotiate({ accept: 'image/avif,image/webp', source: p }).format, 'webp'); // a PNG source is a graphic: lossless webp or png, not avif
  assert.equal(negotiate({ accept: 'image/avif,image/webp', source: j, hasAlpha: true }).format, 'avif');
  assert.equal(negotiate({ accept: '*/*', source: p }).format, 'png');
  assert.equal(negotiate({ accept: 'image/avif', source: j, available: ['jpeg', 'png'] }).format, 'jpeg');
  assert.equal(negotiate({ accept: 'image/avif;q=0,image/webp', source: j }).format, 'webp');
});
