import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Blocked, checkUrl, clean, cleanUrl, embedIframe, FetchFailed, InvalidOEmbed, isPublicAddress, matchProvider, oembedRequestUrl, parseOEmbed, readCard, safeFetch, withOEmbed } from './index.ts';
import type { Deps, Response } from './index.ts';

const page = (head: string) => `<!doctype html><html><head>${head}</head><body>x</body></html>`;
const enc = (s: string) => new TextEncoder().encode(s);
async function* chunks(...parts: Uint8Array[]) {
  for (const p of parts) yield p;
}
const ok = (body: string | Uint8Array[], headers: Record<string, string> = {}): Response => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body: chunks(...(typeof body === 'string' ? [enc(body)] : body)),
});

test('Open Graph fields are read, with structured image properties attached to the image they follow', () => {
  const c = readCard(
    page(`<meta property="og:title" content="  The Title  "><meta property="og:description" content="A &amp; B">
      <meta property="og:site_name" content="Example"><meta property="og:type" content="article">
      <meta property="og:image" content="/a.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="First">
      <meta property="og:image" content="https://cdn.example.com/b.png"><meta property="og:image:width" content="800">
      <meta property="article:published_time" content="2026-11-01T10:00:00Z"><meta property="og:locale" content="en_GB"><meta property="og:url" content="https://example.com/post">`),
    'https://example.com/post?utm=1',
  );
  assert.deepEqual(c.images, [
    { url: 'https://example.com/a.png', width: 1200, height: 630, alt: 'First' },
    { url: 'https://cdn.example.com/b.png', width: 800 },
  ]);
  assert.equal(c.title, 'The Title');
  assert.equal(c.description, 'A & B');
  assert.equal(c.siteName, 'Example');
  assert.equal(c.type, 'article');
  assert.equal(c.url, 'https://example.com/post');
  assert.equal(c.publishedTime, '2026-11-01T10:00:00Z');
  assert.equal(c.locale, 'en_GB');
});

test('without Open Graph the card falls back to Twitter tags, then to the page itself', () => {
  const tw = readCard(page('<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="T"><meta name="twitter:description" content="D"><meta name="twitter:image" content="i.jpg"><title>ignored</title>'), 'https://www.example.org/dir/p.html');
  assert.deepEqual({ t: tw.title, d: tw.description, i: tw.images[0]?.url, c: tw.twitterCard, s: tw.siteName }, { t: 'T', d: 'D', i: 'https://www.example.org/dir/i.jpg', c: 'summary_large_image', s: 'example.org' });
  const plain = readCard(page('<title>  Plain\n  Title </title><meta name="description" content="Plain d"><meta name="author" content="Ann"><link rel="canonical" href="/canon"><link rel="shortcut icon" href="/f.ico">'), 'https://example.org/x');
  assert.deepEqual({ t: plain.title, d: plain.description, a: plain.author, u: plain.url, i: plain.icon, type: plain.type }, { t: 'Plain Title', d: 'Plain d', a: 'Ann', u: 'https://example.org/canon', i: 'https://example.org/f.ico', type: 'website' });
  const mix = readCard(page('<meta property="og:title" content="OG"><meta name="twitter:title" content="TW"><title>HT</title>'), 'https://e.com/');
  assert.equal(mix.title, 'OG');
});

test('addresses in a page are http(s) only: javascript, data and credentials are dropped', () => {
  const c = readCard(page('<meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AAAA"><meta property="og:image" content="https://u:p@evil.test/x.png"><meta property="og:image" content="//cdn.example.com/ok.png"><link rel="icon" href="vbscript:x">'), 'https://example.com/');
  assert.deepEqual(c.images, [{ url: 'https://cdn.example.com/ok.png' }]);
  assert.equal(c.icon, undefined);
  assert.equal(cleanUrl('https://example.com/a#frag', 'https://x.test'), 'https://example.com/a');
  assert.equal(cleanUrl('x'.repeat(3000), 'https://x.test'), undefined);
});

test('text from a page is made printable and capped; hostile markup stays text', () => {
  assert.equal(clean('a\u0000b‮c​d\n\n e', 50), 'abcd e');
  const long = 'x'.repeat(500);
  const c = readCard(page(`<meta property="og:title" content="${long}"><meta property="og:description" content="&lt;script&gt;alert(1)&lt;/script&gt;">`), 'https://e.com/');
  assert.equal(c.title!.length, 300);
  assert.equal(c.description, '<script>alert(1)</script>', 'kept as plain text for the template to escape');
  assert.equal(clean('\u{1F600}'.repeat(10), 3), '\u{1F600}\u{1F600}\u{1F600}', 'cut on a whole character');
  assert.equal(clean('   ', 10), undefined);
  assert.equal(readCard(page('<meta property="article:published_time" content="yesterday">'), 'https://e.com/').publishedTime, undefined);
});

test('oEmbed discovery prefers JSON and resolves the address', () => {
  const c = readCard(page('<link rel="alternate" type="text/xml+oembed" href="/oe.xml"><link rel="alternate" type="application/json+oembed" href="/oe?url=a&amp;format=json" title="x">'), 'https://e.com/v/1');
  assert.deepEqual({ u: c.oembedUrl, f: c.oembedFormat }, { u: 'https://e.com/oe?url=a&format=json', f: 'json' });
  const x = readCard(page('<link rel="alternate" type="text/xml+oembed" href="/oe.xml">'), 'https://e.com/');
  assert.equal(x.oembedFormat, 'xml');
  assert.equal(readCard(page('<link rel="alternate" type="application/rss+xml" href="/feed">'), 'https://e.com/').oembedUrl, undefined);
});

test('providers match by scheme with wildcards and build the request address', () => {
  const providers = [{ schemes: ['https://*.youtube.com/watch*', 'https://youtu.be/*'], endpoint: 'https://www.youtube.com/oembed' }];
  assert.equal(matchProvider('https://www.youtube.com/watch?v=abc', providers)?.endpoint, 'https://www.youtube.com/oembed');
  assert.equal(matchProvider('https://youtu.be/abc', providers)?.endpoint, 'https://www.youtube.com/oembed');
  assert.equal(matchProvider('https://evil.test/https://www.youtube.com/watch?v=1', providers), undefined, 'the scheme is anchored at the start');
  assert.equal(matchProvider('http://www.youtube.com/watch?v=abc', providers), undefined, 'a different scheme is a different address');
  assert.equal(matchProvider('https://a.youtube.com.evil.test/watch', providers), undefined);
  assert.equal(oembedRequestUrl('https://p.test/oembed', 'https://x.test/a?b=1&c=2', { maxwidth: 640.9 }), 'https://p.test/oembed?url=https%3A%2F%2Fx.test%2Fa%3Fb%3D1%26c%3D2&format=json&maxwidth=640');
});

test('oEmbed responses are checked by type', () => {
  const photo = parseOEmbed({ version: '1.0', type: 'photo', url: 'https://i.test/p.jpg', width: 400, height: '300', title: 'P', author_name: 'A', thumbnail_url: '/t.jpg', thumbnail_width: 10, thumbnail_height: 10 }, 'https://p.test/');
  assert.deepEqual(photo, { type: 'photo', title: 'P', authorName: 'A', thumbnailUrl: 'https://p.test/t.jpg', thumbnailWidth: 10, thumbnailHeight: 10, url: 'https://i.test/p.jpg', width: 400, height: 300 });
  assert.equal(parseOEmbed('{"version":"1.0","type":"link","title":"L"}', 'https://p.test/').type, 'link');
  const bad: [unknown, RegExp][] = [
    [{ type: 'link' }, /version/],
    [{ version: '1.0', type: 'movie' }, /type must be/],
    [{ version: '1.0', type: 'photo', url: 'https://i/p.jpg', width: 1 }, /width and height/],
    [{ version: '1.0', type: 'photo', url: 'javascript:1', width: 1, height: 1 }, /http\(s\) url/],
    [{ version: '1.0', type: 'video', width: 1, height: 1 }, /needs html/],
    [{ version: '1.0', type: 'rich', html: '<b>x</b>', width: -4, height: 1 }, /whole number/],
    [{ version: '1.0', type: 'rich', html: '<b>x</b>', width: 1.5, height: 1 }, /whole number/],
    [{ version: '1.0', type: 'rich', html: 'x'.repeat(20001), width: 1, height: 1 }, /20000/],
    [[1, 2], /not an object/],
    ['{nope', /not JSON/],
  ];
  for (const [input, why] of bad) assert.throws(() => parseOEmbed(input, 'https://p.test/'), (e: Error) => e instanceof InvalidOEmbed && why.test(e.message), JSON.stringify(input).slice(0, 50));
});

test('embedded HTML is never trusted: only one https iframe from an allowed host passes', () => {
  const allowed = ['youtube.com', 'player.vimeo.com'];
  const size = { width: 560, height: 315 };
  assert.deepEqual(embedIframe('<iframe src="https://www.youtube.com/embed/abc" width="640" height="360"></iframe>', allowed, size), { src: 'https://www.youtube.com/embed/abc', width: 640, height: 360 });
  assert.deepEqual(embedIframe('<iframe src="//player.vimeo.com/video/1"></iframe>', allowed, size), { src: 'https://player.vimeo.com/video/1', width: 560, height: 315 });
  const refused = [
    '<iframe src="https://evil.test/embed"></iframe>',
    '<iframe src="https://youtube.com.evil.test/x"></iframe>',
    '<iframe src="http://www.youtube.com/embed/a"></iframe>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe src="https://u:p@www.youtube.com/x"></iframe>',
    '<iframe src="https://www.youtube.com/e"></iframe><script>alert(1)</script>',
    '<iframe src="https://www.youtube.com/e"></iframe><iframe src="https://www.youtube.com/f"></iframe>',
    '<script src="https://www.youtube.com/x.js"></script>',
    '<div><iframe src="https://www.youtube.com/e"></iframe></div>',
    '<iframe src="https://www.youtube.com/e"><img src=x onerror=alert(1)></iframe>',
    '<iframe></iframe>',
    'just text',
  ];
  for (const h of refused) assert.equal(embedIframe(h, allowed, size), null, h);
});

test('an oEmbed answer fills what the page lacked and adds the safe embed', () => {
  const card = readCard(page('<meta property="og:site_name" content="V">'), 'https://v.test/1');
  const oe = parseOEmbed({ version: '1.0', type: 'video', title: 'Clip', author_name: 'Ann', html: '<iframe src="https://player.v.test/1" width="500" height="281"></iframe>', width: 500, height: 281, thumbnail_url: 'https://t.v.test/1.jpg', thumbnail_width: 480, thumbnail_height: 270 }, 'https://v.test/');
  const merged = withOEmbed(card, oe, ['v.test']);
  assert.equal(merged.title, 'Clip');
  assert.equal(merged.author, 'Ann');
  assert.deepEqual(merged.images, [{ url: 'https://t.v.test/1.jpg', width: 480, height: 270 }]);
  assert.deepEqual(merged.embed, { src: 'https://player.v.test/1', width: 500, height: 281 });
  assert.equal(withOEmbed(card, oe, ['other.test']).embed, undefined);
});

test('which addresses are public: the table that matters for SSRF', () => {
  const no = ['127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fec0::1', 'garbage', '1.2.3', '999.1.1.1', ''];
  for (const a of no) assert.equal(isPublicAddress(a), false, a);
  const yes = ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'];
  for (const a of yes) assert.equal(isPublicAddress(a), true, a);
});

test('addresses are refused by their text: scheme, credentials, port, numeric spellings, internal names', () => {
  const refused = ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com', 'javascript:alert(1)', 'http://user:pw@example.com/', 'http://example.com:22/', 'http://example.com:6379/', 'http://127.0.0.1/', 'http://localhost/', 'http://LOCALHOST./', 'http://foo.localhost/',
    'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://intranet/', 'http://printer.local/', 'http://10.1.1.1.nip.io.internal/', 'not a url', '', 'http:///', 'https://' + 'a'.repeat(2100) + '.com'];
  for (const u of refused) assert.throws(() => checkUrl(u), Blocked, u);
  assert.equal(checkUrl('https://Example.COM/a?b#c').href, 'https://example.com/a?b#c');
  assert.equal(checkUrl('http://example.com:8080/', [80, 443, 8080]).port, '8080');
  assert.equal(checkUrl('https://8.8.8.8/').hostname, '8.8.8.8');
});

function net(table: Record<string, string[]>, routes: Record<string, (req: { address: string }) => Response>, seen: { address: string; host: string }[] = []): Deps {
  return {
    resolve: async (h) => table[h] ?? [],
    request: async ({ address, url }) => {
      seen.push({ address, host: url.hostname });
      const r = routes[url.href];
      if (!r) throw new Error(`no route ${url.href}`);
      return r({ address });
    },
  };
}

test('a fetch goes to the checked address, not to a second DNS answer', async () => {
  const seen: { address: string; host: string }[] = [];
  const deps = net({ 'example.com': ['93.184.216.34', '93.184.216.35'] }, { 'https://example.com/p': () => ok('<title>hi</title>') }, seen);
  const r = await safeFetch('https://example.com/p', deps);
  assert.deepEqual(seen, [{ address: '93.184.216.34', host: 'example.com' }]);
  assert.deepEqual({ url: r.url, status: r.status, type: r.contentType, body: r.body, cut: r.truncated }, { url: 'https://example.com/p', status: 200, type: 'text/html', body: '<title>hi</title>', cut: false });
});

test('a name that resolves to any private address is refused, even among public ones', async () => {
  const deps = net({ 'evil.test': ['8.8.8.8', '10.0.0.5'], 'rebind.test': ['::1'], 'gone.test': [] }, { 'https://evil.test/': () => ok('x') });
  await assert.rejects(safeFetch('https://evil.test/', deps), (e: Blocked) => e instanceof Blocked && /10\.0\.0\.5/.test(e.reason));
  await assert.rejects(safeFetch('https://rebind.test/', deps), /::1/);
  await assert.rejects(safeFetch('https://gone.test/', deps), /did not resolve/);
});

test('every redirect hop is checked again, and the number of hops is limited', async () => {
  const redirect = (to: string) => (): Response => ({ status: 302, headers: { location: to }, body: chunks() });
  const deps = net(
    { 'a.test': ['8.8.8.8'], 'b.test': ['8.8.4.4'], 'c.test': ['10.0.0.1'] },
    {
      'https://a.test/1': redirect('https://b.test/2'),
      'https://b.test/2': () => ok('landed'),
      'https://a.test/to-c': redirect('https://c.test/'),
      'https://a.test/to-ip': redirect('http://169.254.169.254/latest'),
      'https://a.test/to-file': redirect('file:///etc/passwd'),
      'https://a.test/loop': redirect('/loop'),
      'https://a.test/nolocation': () => ({ status: 301, headers: {}, body: chunks() }),
    },
  );
  const r = await safeFetch('https://a.test/1', deps);
  assert.deepEqual({ url: r.url, body: r.body, trail: r.redirects }, { url: 'https://b.test/2', body: 'landed', trail: ['https://a.test/1'] });
  await assert.rejects(safeFetch('https://a.test/to-c', deps), /10\.0\.0\.1/);
  await assert.rejects(safeFetch('https://a.test/to-ip', deps), Blocked);
  await assert.rejects(safeFetch('https://a.test/to-file', deps), /file addresses/);
  await assert.rejects(safeFetch('https://a.test/loop', deps), /more than 3 redirects/);
  await assert.rejects(safeFetch('https://a.test/nolocation', deps), FetchFailed);
});

test('the body is read up to the limit and then dropped; types outside the list are not read at all', async () => {
  const big = [enc('a'.repeat(600)), enc('b'.repeat(600)), enc('c'.repeat(600))];
  let pulled = 0;
  async function* counted() {
    for (const c of big) {
      pulled++;
      yield c;
    }
  }
  const deps = net(
    { 'a.test': ['8.8.8.8'] },
    {
      'https://a.test/big': () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: counted() }),
      'https://a.test/exact': () => ok([enc('x'.repeat(1000))]),
      'https://a.test/img': () => ok('GIF89a', { 'content-type': 'image/gif' }),
      'https://a.test/none': () => ({ status: 200, headers: {}, body: chunks(enc('x')) }),
      'https://a.test/latin': () => ok([Uint8Array.from([0x63, 0x61, 0x66, 0xe9])], { 'content-type': 'text/html; charset=iso-8859-1' }),
      'https://a.test/weird': () => ok('ok', { 'content-type': 'text/html; charset=nonsense-9' }),
      'https://a.test/declared': () => ok('ok', { 'content-length': '999999999' }),
    },
  );
  const r = await safeFetch('https://a.test/big', deps, { maxBytes: 1000 });
  assert.equal(r.body.length, 1000);
  assert.equal(r.truncated, true);
  assert.equal(pulled, 2, 'the third chunk was never pulled');
  assert.equal((await safeFetch('https://a.test/exact', deps, { maxBytes: 1000 })).truncated, false, 'exactly the limit is not a cut');
  await assert.rejects(safeFetch('https://a.test/img', deps), /image\/gif is not read/);
  await assert.rejects(safeFetch('https://a.test/none', deps), /\(none\)/);
  assert.equal((await safeFetch('https://a.test/latin', deps)).body, 'café');
  assert.equal((await safeFetch('https://a.test/weird', deps)).body, 'ok');
  assert.equal((await safeFetch('https://a.test/declared', deps, { maxBytes: 100 })).truncated, true, 'a declared length over the limit is flagged');
});
