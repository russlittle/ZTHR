import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, type El } from '../dav/index.ts';
import {
  FeedError, cdata, durationSeconds, escapeAttr, escapeText, etagOf, feedProblems, itunesDuration, rfc3339, rfc822,
  respond, toDate, write, writeAtom, writeJsonFeed, writeRss, xmlSafe, type Feed,
} from './index.ts';

const T0 = Date.UTC(2024, 4, 6, 12, 30, 5);
type Mut<T> = { -readonly [K in keyof T]: T[K] };
const base = (): Mut<Feed> => ({
  title: 'Notes & Things',
  link: 'https://example.com/',
  selfUrl: 'https://example.com/feed.xml',
  description: 'Writing <on> the web',
  language: 'en-GB',
  updated: T0,
  items: [
    { id: 'https://example.com/a', link: 'https://example.com/a', title: 'First', published: T0 - 86_400_000, contentHtml: '<p>Hello</p>', summary: 'Hi', authors: [{ name: 'Ann' }], categories: ['x', 'y'] },
    { id: 'https://example.com/b', link: 'https://example.com/b', title: 'Second', published: T0, updated: T0 + 1000 },
  ],
});
const find = (e: El, name: string): El[] => [...(e.name === name ? [e] : []), ...e.children.flatMap((c) => find(c, name))];

test('RFC 822 and RFC 3339 dates match the specs examples', () => {
  assert.equal(rfc822(new Date(Date.UTC(2002, 8, 7, 0, 0, 1))), 'Sat, 07 Sep 2002 00:00:01 GMT');
  assert.equal(rfc3339(new Date(Date.UTC(2003, 11, 13, 18, 30, 2, 900))), '2003-12-13T18:30:02Z');
});

test('toDate takes dates, numbers and ISO strings and refuses nonsense', () => {
  assert.equal(toDate('2024-05-06')?.toISOString(), '2024-05-06T00:00:00.000Z');
  assert.equal(toDate('2024-05-06T10:00:00+02:00')?.toISOString(), '2024-05-06T08:00:00.000Z');
  assert.equal(toDate('2024-05-06 10:00')?.toISOString(), '2024-05-06T10:00:00.000Z');
  assert.equal(toDate('yesterday'), undefined);
  assert.equal(toDate(Number.NaN), undefined);
  assert.equal(toDate('2024-13-45'), undefined);
});

test('xmlSafe drops control codes and lone surrogates but keeps pairs', () => {
  assert.equal(xmlSafe('a\u0000b\u0008c\u000bd￾e'), 'abcde');
  assert.equal(xmlSafe('x\ud800y'), 'xy');
  assert.equal(xmlSafe('\udc00z'), 'z');
  assert.equal(xmlSafe('tab\tnl\n\u{1F600}'), 'tab\tnl\n\u{1F600}');
});

test('escaping covers text and attributes', () => {
  assert.equal(escapeText('a<b>&c"'), 'a&lt;b&gt;&amp;c"');
  assert.equal(escapeAttr(`"'<&\n`), '&quot;&apos;&lt;&amp;&#10;');
});

test('cdata splits an end marker so the section cannot be closed early', () => {
  const x = cdata('a ]]> <script>');
  assert.equal(x, '<![CDATA[a ]]]]><![CDATA[> <script>]]>');
  const root = parseXml(`<r>${x}</r>`);
  assert.equal(root.text, 'a ]]> <script>');
});

test('durations: seconds and clock forms, and bad ones', () => {
  assert.equal(itunesDuration(75), '1:15');
  assert.equal(itunesDuration(3725), '1:02:05');
  assert.equal(itunesDuration('01:02:03'), '1:02:03');
  assert.equal(itunesDuration('5:07'), '5:07');
  assert.equal(itunesDuration('1:75'), undefined);
  assert.equal(itunesDuration(-1), undefined);
  assert.equal(itunesDuration(1.5), undefined);
  assert.equal(durationSeconds('1:02:03'), 3723);
  assert.equal(durationSeconds(90), 90);
});

test('RSS output is well-formed XML with escaped text and the right structure', () => {
  const xml = writeRss(base());
  const root = parseXml(xml);
  assert.equal(root.name, 'rss');
  assert.equal(root.attrs['version'], '2.0');
  assert.equal(find(root, 'title')[0]!.text, 'Notes & Things');
  assert.equal(find(root, 'description')[0]!.text, 'Writing <on> the web');
  assert.match(xml, /<title>Notes &amp; Things<\/title>/);
  const items = find(root, 'item');
  assert.equal(items.length, 2);
  assert.equal(find(items[0]!, 'title')[0]!.text, 'Second', 'newest first');
  assert.match(xml, /<lastBuildDate>Mon, 06 May 2024 12:30:05 GMT<\/lastBuildDate>/);
  assert.match(xml, /<content:encoded><!\[CDATA\[<p>Hello<\/p>\]\]><\/content:encoded>/);
  assert.match(xml, /<guid isPermaLink="true">https:\/\/example\.com\/a<\/guid>/);
});

test('namespaces are declared only when used', () => {
  const plain = writeRss({ ...base(), selfUrl: undefined as never, items: [{ id: 'x', title: 'T' }] } as Feed);
  assert.doesNotMatch(plain, /xmlns:itunes|xmlns:media|xmlns:content|xmlns:atom/);
  const withMedia = writeRss({ ...base(), items: [{ id: 'm', title: 'M', media: { thumbnail: { url: 'https://e.com/t.png', width: 10 } } }] });
  assert.match(withMedia, /xmlns:media=/);
  assert.match(withMedia, /<media:thumbnail url="https:\/\/e\.com\/t\.png" width="10"\/>/);
  assert.doesNotMatch(withMedia, /xmlns:itunes/);
});

test('a podcast feed carries itunes tags, enclosure and a nested category', () => {
  const f: Feed = {
    ...base(),
    podcast: { author: 'Ann', explicit: false, type: 'serial', owner: { name: 'Ann', email: 'ann@example.com' }, image: 'https://example.com/c.jpg', categories: [['Technology', 'Tech News'], ['Comedy']], locked: { value: true, owner: 'ann@example.com' } },
    items: [{ id: 'ep1', title: 'Ep 1', published: T0, enclosure: { url: 'https://example.com/1.mp3', length: 12345, type: 'audio/mpeg' }, podcast: { duration: 3725, episode: 1, season: 2, episodeType: 'full', explicit: true, transcript: { url: 'https://example.com/1.vtt', type: 'text/vtt', language: 'en' } } }],
  };
  const xml = writeRss(f);
  const root = parseXml(xml);
  assert.match(xml, /<itunes:duration>1:02:05<\/itunes:duration>/);
  assert.match(xml, /<itunes:explicit>true<\/itunes:explicit>/);
  assert.match(xml, /<itunes:category text="Technology"><itunes:category text="Tech News"\/><\/itunes:category>/);
  assert.match(xml, /<enclosure url="https:\/\/example\.com\/1\.mp3" length="12345" type="audio\/mpeg"\/>/);
  assert.match(xml, /<podcast:transcript url="https:\/\/example\.com\/1\.vtt" type="text\/vtt" language="en"\/>/);
  assert.match(xml, /<podcast:locked owner="ann@example\.com">yes<\/podcast:locked>/);
  assert.equal(find(root, 'owner').length, 1);
});

test('Atom output is well-formed, dated in RFC 3339, and links an enclosure', () => {
  const f = base();
  f.items = [{ ...f.items[0]!, enclosure: { url: 'https://example.com/a.mp3', length: 9, type: 'audio/mpeg' } }, f.items[1]!];
  const xml = writeAtom(f);
  const root = parseXml(xml);
  assert.equal(root.name, 'feed');
  assert.equal(root.ns, 'http://www.w3.org/2005/Atom');
  assert.match(xml, /<updated>2024-05-06T12:30:05Z<\/updated>/);
  assert.match(xml, /<link rel="enclosure" type="audio\/mpeg" href="https:\/\/example\.com\/a\.mp3" length="9"\/>/);
  assert.match(xml, /<content type="html">&lt;p&gt;Hello&lt;\/p&gt;<\/content>/);
  assert.equal(find(root, 'entry').length, 2);
  assert.match(xml, /<author><name>Unknown<\/name><\/author>/, 'entries without any author get one, as RFC 4287 requires');
});

test('Atom needs dates and says so', () => {
  assert.throws(() => writeAtom({ ...base(), updated: undefined as never, items: [{ id: 'x', title: 'No date' }] } as Feed), (e: unknown) => e instanceof FeedError && /updated/.test(e.message));
});

test('JSON Feed 1.1 has the right shape and is valid JSON', () => {
  const f = base();
  f.items = [{ ...f.items[0]!, enclosure: { url: 'https://example.com/a.mp3', length: 9, type: 'audio/mpeg' }, podcast: { duration: '1:30' } }];
  const j = JSON.parse(writeJsonFeed(f));
  assert.equal(j.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(j.home_page_url, 'https://example.com/');
  assert.equal(j.items[0].content_html, '<p>Hello</p>');
  assert.equal(j.items[0].date_published, '2024-05-05T12:30:05Z');
  assert.deepEqual(j.items[0].tags, ['x', 'y']);
  assert.deepEqual(j.items[0].attachments, [{ url: 'https://example.com/a.mp3', mime_type: 'audio/mpeg', size_in_bytes: 9, duration_in_seconds: 90 }]);
  assert.equal(j.language, 'en-GB');
});

test('every problem is reported at once, and nothing is written', () => {
  const bad: Feed = {
    title: ' ', link: '/relative', description: '', language: 'not a tag', updated: 'soon',
    items: [
      { id: 'a', title: 'A', link: 'javascript:alert(1)', published: 'nope', enclosure: { url: 'ftp://x/y.mp3', length: -1, type: 'mp3' }, podcast: { duration: '99:99:99:1' } },
      { id: 'a', title: '' },
    ],
  };
  const p = feedProblems(bad);
  assert.ok(p.length >= 10, `got ${p.length}: ${p.join(' | ')}`);
  assert.ok(p.some((x) => /used twice/.test(x)));
  assert.ok(p.some((x) => /enclosure length/.test(x)));
  assert.ok(p.some((x) => /link must be an absolute/.test(x)));
  for (const fmt of ['rss', 'atom', 'json'] as const) {
    assert.throws(() => write(fmt, bad), (e: unknown) => e instanceof FeedError && e.problems.length === p.length);
  }
});

test('hostile text cannot break out of the markup', () => {
  const f = base();
  f.title = 'x</title><script>alert(1)</script>';
  f.items = [{ id: 'h', title: 'a"b<c>&\u0000\u0001', summary: ']]></description><evil/>', contentHtml: '<p>]]></content:encoded><evil/></p>', published: T0 }];
  for (const xml of [writeRss(f), writeAtom(f)]) {
    const root = parseXml(xml);
    assert.equal(find(root, 'evil').length, 0);
    assert.equal(find(root, 'script').length, 0);
  }
  assert.ok(find(parseXml(writeRss(f)), 'title')[0]!.text.includes('</title><script>'));
});

test('maxItems keeps the newest', () => {
  const f = base();
  const x = writeRss(f, { maxItems: 1 });
  assert.equal(find(parseXml(x), 'item').length, 1);
  assert.match(x, /Second/);
  assert.doesNotMatch(x, /First/);
});

test('respond: 200 with validators, then 304 on a matching ETag', () => {
  const o = { now: () => T0 + 10_000 };
  const a = respond('rss', base(), {}, o);
  assert.equal(a.status, 200);
  assert.equal(a.headers['Content-Type'], 'application/rss+xml; charset=utf-8');
  assert.equal(a.headers['ETag'], etagOf(a.body));
  assert.equal(a.headers['Last-Modified'], 'Mon, 06 May 2024 12:30:06 GMT');
  const b = respond('rss', base(), { headers: { 'if-none-match': `W/${a.headers['ETag']}, "other"` } }, o);
  assert.equal(b.status, 304);
  assert.equal(b.body, '');
  assert.equal(b.headers['ETag'], a.headers['ETag']);
  assert.equal(b.headers['Content-Type'], undefined);
});

test('respond: If-None-Match beats If-Modified-Since, and a stale ETag gets a full body', () => {
  const o = { now: () => T0 + 10_000 };
  const lm = respond('atom', base(), {}, o).headers['Last-Modified']!;
  const r = respond('atom', base(), { headers: { 'if-none-match': '"stale"', 'if-modified-since': lm } }, o);
  assert.equal(r.status, 200, 'the date is ignored when an ETag is sent');
  assert.equal(respond('atom', base(), { headers: { 'if-modified-since': lm } }, o).status, 304);
  assert.equal(respond('atom', base(), { headers: { 'if-modified-since': 'Mon, 06 May 2024 12:30:05 GMT' } }, o).status, 200, 'older than the change');
  assert.equal(respond('atom', base(), { headers: { 'if-modified-since': 'garbage' } }, o).status, 200);
  assert.equal(respond('atom', base(), { headers: { 'if-none-match': '*' } }, o).status, 304);
});

test('respond: Last-Modified is never in the future, HEAD has no body, POST is refused', () => {
  const future: Feed = { ...base(), updated: T0 + 10 * 86_400_000 };
  const r = respond('json', future, {}, { now: () => T0 });
  assert.equal(r.headers['Last-Modified'], rfc822(new Date(T0)));
  assert.equal(r.headers['Content-Type'], 'application/feed+json; charset=utf-8');
  const h = respond('json', base(), { method: 'head' }, { now: () => T0 });
  assert.equal(h.status, 200);
  assert.equal(h.body, '');
  const p = respond('rss', base(), { method: 'POST' });
  assert.equal(p.status, 405);
  assert.equal(p.headers['Allow'], 'GET, HEAD');
});

test('the same feed always gives the same bytes and ETag', () => {
  assert.equal(etagOf(writeRss(base())), etagOf(writeRss(base())));
  assert.notEqual(etagOf(writeRss(base())), etagOf(writeAtom(base())));
});
