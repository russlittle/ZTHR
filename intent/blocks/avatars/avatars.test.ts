import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AvatarError, Directory, PALETTE, SIZE_SET, colorForName, contrast, emailHash, gravatarUrl, hexToRgb, identicon, identiconCells, identiconColor, initials,
  initialsAvatar, isAvatarHash, luminance, serveAvatar, silhouette, sizeFor, srcset,
} from './index.ts';

// ------------------------------------------------------------ hashing and addresses

test('the published Gravatar example hashes to its published MD5, whatever the case and spaces', () => {
  assert.equal(emailHash(' MyEmailAddress@example.com ', 'md5'), '0bc83cb571cd1c50ba6f3e8a78ef1346');
  assert.equal(emailHash('myemailaddress@example.com', 'md5'), '0bc83cb571cd1c50ba6f3e8a78ef1346');
  assert.match(emailHash('myemailaddress@example.com'), /^[0-9a-f]{64}$/);
  assert.notEqual(emailHash('a@example.com'), emailHash('b@example.com'));
});

test('anything that is not an email address is refused', () => {
  for (const bad of ['', '  ', 'nobody', 'a b@c.d', '@x.y', 'x@', `${'a'.repeat(320)}@x.y`]) assert.throws(() => emailHash(bad), AvatarError, bad.slice(0, 20));
});

test('avatar addresses carry a checked size, default, rating and host', () => {
  const md5 = '0bc83cb571cd1c50ba6f3e8a78ef1346';
  assert.equal(gravatarUrl('MyEmailAddress@example.com', { algorithm: 'md5', size: 200, fallback: 'identicon', rating: 'pg' }), `https://www.gravatar.com/avatar/${md5}?s=200&d=identicon&r=pg`);
  assert.equal(gravatarUrl('a@b.co', { algorithm: 'md5', forceDefault: true }), `https://www.gravatar.com/avatar/${emailHash('a@b.co', 'md5')}?s=80&f=y`);
  assert.match(gravatarUrl('a@b.co', { fallback: 'https://cdn.example/a b.png' }), /d=https%3A%2F%2Fcdn\.example%2Fa%20b\.png$/);
  assert.match(gravatarUrl('a@b.co', { host: 'avatars.example:8443' }), /^https:\/\/avatars\.example:8443\/avatar\//);
  for (const size of [0, 2049, 1.5, NaN]) assert.throws(() => gravatarUrl('a@b.co', { size }), /1 to 2048/);
  assert.throws(() => gravatarUrl('a@b.co', { fallback: 'javascript:alert(1)' }), /named style or an https/);
  assert.throws(() => gravatarUrl('a@b.co', { fallback: 'http://x.example/a.png' }), /named style or an https/);
  assert.throws(() => gravatarUrl('a@b.co', { rating: 'z' as 'g' }), /rating/);
  assert.throws(() => gravatarUrl('a@b.co', { host: 'evil.example/x?' }), /not a host name/);
});

test('the size set picks the smallest size that is sharp enough, and 2x for denser screens', () => {
  assert.equal(sizeFor(30), 32);
  assert.equal(sizeFor(32), 32);
  assert.equal(sizeFor(33), 48);
  assert.equal(sizeFor(48, { density: 2 }), 96);
  assert.equal(sizeFor(48, { density: 0.5 }), 48, 'a density below 1 does not shrink it');
  assert.equal(sizeFor(10_000), SIZE_SET.at(-1));
  assert.equal(sizeFor(20, { sizes: [64, 16] }), 64);
  assert.throws(() => sizeFor(0), /more than zero/);
  assert.throws(() => sizeFor(10, { sizes: [] }), /no sizes/);
  assert.equal(srcset((s) => `/a/${s}`, 48), '/a/48 1x, /a/96 2x');
  assert.equal(srcset((s) => `/a/${s}`, 512), '/a/512 1x', 'the same size at both densities is listed once');
});

// ------------------------------------------------------------ colours

test('contrast follows WCAG: black on white is 21, equal colours 1, and #767676 is the lightest grey passing AA on white', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#336699', '#336699'), 1);
  assert.equal(Math.round(contrast('#767676', '#ffffff') * 100) / 100, 4.54);
  assert.ok(contrast('#777777', '#ffffff') < 4.5);
  assert.equal(luminance('#ffffff'), 1);
  assert.deepEqual(hexToRgb('#0a0B0c'), [10, 11, 12]);
  for (const bad of ['red', '#fff', '#12345g', '#1234567', '']) assert.throws(() => hexToRgb(bad), AvatarError);
});

test('every palette colour is readable with white text', () => {
  assert.equal(PALETTE.length, 12);
  assert.equal(new Set(PALETTE).size, 12);
  for (const c of PALETTE) assert.ok(contrast(c, '#ffffff') >= 4.5, `${c} gives ${contrast(c, '#ffffff').toFixed(2)}`);
});

test('a name always gets the same colour from the palette, ignoring case and spaces at the ends', () => {
  assert.equal(colorForName('Ana Lopez'), colorForName('  ana lopez '));
  assert.ok(PALETTE.includes(colorForName('Ana Lopez')));
  const used = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't'].map(colorForName));
  assert.ok(used.size >= 6, 'names spread over the palette');
});

// ------------------------------------------------------------ identicons

test('an identicon is the same every time, and different seeds give different pictures', () => {
  assert.equal(identicon('ana@example.com'), identicon('ana@example.com'));
  const set = new Set(Array.from({ length: 40 }, (_v, i) => identicon(`user-${i}`)));
  assert.equal(set.size, 40);
  assert.notEqual(identiconColor('a'), identiconColor('b'));
  assert.match(identiconColor('a'), /^#[0-9a-f]{6}$/);
});

test('the pattern is symmetric, 5 by 5, and never empty', () => {
  for (let i = 0; i < 200; i++) {
    const rows = identiconCells(`seed-${i}`);
    assert.equal(rows.length, 5);
    for (const r of rows) {
      assert.equal(r.length, 5);
      assert.equal(r[0], r[4]);
      assert.equal(r[1], r[3]);
    }
    assert.ok(rows.some((r) => r.some(Boolean)));
  }
  const filled = identiconCells('x').flat().filter(Boolean).length;
  assert.equal((identicon('x').match(/<rect x=/g) ?? []).length, filled, 'one rect per filled cell');
});

test('the SVG has the size asked, a label for screen readers, and escaped text', () => {
  const svg = identicon('a', { size: 128, label: 'Ana "<b>&' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 70 70" width="128" height="128" role="img" aria-label="Ana &quot;&lt;b&gt;&amp;">/);
  assert.ok(!svg.includes('<b>'));
  assert.match(identicon('a'), /aria-label="Avatar"/);
  assert.match(identicon('a', { shape: 'circle' }), /<clipPath id="av-[0-9a-f]{8}"><circle/);
  assert.notEqual(identicon('a', { shape: 'circle' }).match(/id="(av-[0-9a-f]{8})"/)![1], identicon('b', { shape: 'circle' }).match(/id="(av-[0-9a-f]{8})"/)![1], 'clip ids differ so two avatars inline do not clash');
  for (const size of [0, 7, 2049, 1.5]) assert.throws(() => identicon('a', { size }), /8 to 2048/);
  assert.throws(() => identicon('a', { background: 'url(javascript:1)' }), /colour/);
  assert.throws(() => identicon('a', { background: '#fff" onload="x' }), /colour/);
});

// ------------------------------------------------------------ initials

test('initials come from first and last words, skipping titles and lower-case particles', () => {
  const table: [string, string][] = [
    ['Ana Lopez', 'AL'],
    ['ana lopez', 'AL'],
    ['Zoë van der Berg', 'ZB'],
    ['Dr. Jane Q. Public', 'JP'],
    ['Mary-Jane Watson', 'MW'],
    ['Madonna', 'MA'],
    ['X', 'X'],
    ['ana.lopez@example.com', 'AL'],
    ['ana@example.com', 'AN'],
    ['  Åsa   Öberg  ', 'ÅÖ'],
    ['ÉMILE ZOLA', 'ÉZ'],
    ['王伟', '王伟'],
    ['山田 太郎', '山太'],
    ['Мария Иванова', 'МИ'],
    ['محمد علي', 'مع'],
    ['O\'Brien', 'OB'],
    ['Jr.', 'JR'],
    ['---', '?'],
    ['', '?'],
    ['😀 😀', '?'],
    ['ßa Müller', 'SSM'],
  ];
  for (const [name, want] of table) assert.equal(initials(name), want, JSON.stringify(name));
});

test('initials never run long, and a huge name is cut before it is read', () => {
  assert.equal(initials('a'.repeat(100_000) + ' ' + 'b'.repeat(10)).length <= 4, true);
  assert.equal([...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(initials('Ana Beatriz Carolina Dias'))].length, 2);
});

test('the initials picture has readable text, an escaped label, and a circle when asked', () => {
  const svg = initialsAvatar('Ana Lopez', { size: 96, shape: 'circle' });
  const bg = /<rect width="100" height="100" rx="50" fill="(#[0-9a-f]{6})"/.exec(svg)![1]!;
  assert.equal(bg, colorForName('Ana Lopez'));
  assert.match(svg, />AL<\/text>/);
  assert.match(svg, /fill="#ffffff"/);
  assert.match(svg, /width="96" height="96"/);
  assert.match(initialsAvatar('<script>x</script> y', { label: 'a"b' }), /aria-label="a&quot;b"/);
  assert.ok(!initialsAvatar('<script>alert(1)</script>').includes('<script>'));
  const light = initialsAvatar('x', { background: '#ffee00' });
  assert.match(light, /fill="#000000"/, 'dark text on a light colour');
  assert.match(initialsAvatar('  '), /aria-label="Avatar"/);
  assert.throws(() => initialsAvatar('a', { background: 'red' }), /colour/);
  assert.match(initialsAvatar('Ana Lopez'), /aria-label="Ana Lopez"/);
});

// ------------------------------------------------------------ directory and server

const md5 = emailHash('ana@example.com', 'md5');
const sha = emailHash('ana@example.com', 'sha256');

test('the directory finds a person by either hash of any of their emails, and refuses to take over an email', () => {
  const d = new Directory();
  d.add({ id: 'p1', name: 'Ana Lopez' }, ['ana@example.com', 'ana@work.example']);
  assert.equal(d.lookup(md5)?.id, 'p1');
  assert.equal(d.lookup(sha)?.id, 'p1');
  assert.equal(d.lookup(emailHash('ana@work.example', 'md5'))?.id, 'p1');
  assert.equal(d.lookup(emailHash('bo@example.com')), undefined);
  assert.equal(d.lookup('not-a-hash'), undefined);
  assert.throws(() => d.add({ id: 'p2' }, ['ANA@example.com']), /belongs to another person/);
  assert.equal(d.lookup(md5)?.id, 'p1', 'a refused add changed nothing');
  d.add({ id: 'p1', name: 'Ana L.' }, ['ana@example.com']);
  assert.equal(d.lookup(md5)?.name, 'Ana L.');
  d.remove('p1');
  assert.equal(d.lookup(sha), undefined);
  d.add({ id: 'p2' }, ['ana@example.com']);
  assert.equal(d.lookup(sha)?.id, 'p2', 'a removed person frees their email');
  assert.equal(isAvatarHash(md5) && isAvatarHash(sha) && !isAvatarHash(md5.toUpperCase()) && !isAvatarHash(md5 + '0'), true);
});

test('the server redirects to a chosen picture, makes a default otherwise, and 404s when asked', () => {
  const d = new Directory();
  d.add({ id: 'p1', name: 'Ana Lopez', picture: 'https://cdn.example/ana.png' }, ['ana@example.com']);
  d.add({ id: 'p2', name: 'Bo Chen', style: 'initials' }, ['bo@example.com']);
  assert.deepEqual(serveAvatar(d, md5), { status: 302, location: 'https://cdn.example/ana.png' });
  assert.deepEqual(serveAvatar(d, `${md5.toUpperCase()}.png`), { status: 302, location: 'https://cdn.example/ana.png' });
  const forced = serveAvatar(d, md5, { f: 'y' });
  assert.equal(forced.status, 200);
  const bo = serveAvatar(d, emailHash('bo@example.com'));
  assert.ok(bo.status === 200 && bo.body.includes('>BC</text>'));
  const unknown = emailHash('nobody@example.com');
  const def = serveAvatar(d, unknown, { s: '200' });
  assert.ok(def.status === 200 && def.contentType === 'image/svg+xml' && def.body.includes('width="200"') && def.body === identicon(unknown, { size: 200 }));
  assert.deepEqual(serveAvatar(d, unknown, { d: '404' }), { status: 404, message: 'no avatar' });
  assert.ok(serveAvatar(d, unknown, { d: 'mp' }).status === 200);
  const blank = serveAvatar(d, unknown, { d: 'blank' });
  assert.ok(blank.status === 200 && !blank.body.includes('<rect'));
  assert.deepEqual(serveAvatar(d, unknown, { d: 'https://cdn.example/d.png' }), { status: 302, location: 'https://cdn.example/d.png' });
  const q = serveAvatar(d, unknown, { d: 'initials' });
  assert.ok(q.status === 200 && q.body.includes('>?</text>'));
});

test('the server refuses bad hashes, sizes and defaults', () => {
  const d = new Directory();
  const h = emailHash('x@y.z');
  assert.equal(serveAvatar(d, 'zzz').status, 400);
  assert.equal(serveAvatar(d, '../etc/passwd').status, 400);
  assert.equal(serveAvatar(d, h, { s: '0' }).status, 400);
  assert.equal(serveAvatar(d, h, { s: '5000' }).status, 400);
  assert.equal(serveAvatar(d, h, { s: 'big' }).status, 400);
  assert.equal(serveAvatar(d, h, { d: 'javascript:alert(1)' }).status, 400);
  assert.equal(serveAvatar(d, h, { d: 'http://plain.example/x.png' }).status, 400);
  const tiny = serveAvatar(d, h, { s: '1' });
  assert.ok(tiny.status === 200 && tiny.body.includes('width="8"'), 'a tiny size is drawn at the smallest drawable size');
  assert.match(silhouette(), /aria-label="Avatar"/);
});
