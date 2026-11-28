import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Inbox, WebmentionRejected, checkUrl, decodeEntities, discover, findEndpoint, interpret, isPrivateHost, linksTo,
  normalize, outgoingTargets, parseLinkHeader, parseMf2, send, type Fetch, type FetchInit, type FetchResult,
} from './index.ts';

type Reply = Partial<FetchResult> & { status?: number };
const html = (body: string, extra: Reply = {}): Reply => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, ...extra });
function world(pages: Record<string, Reply | ((i: FetchInit) => Reply)>) {
  const calls: { url: string; init: FetchInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    const p = pages[url];
    if (!p) return { status: 404, headers: {}, body: '' };
    const r = typeof p === 'function' ? p(init) : p;
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? '' };
  };
  return { fetch, calls };
}
const T0 = Date.UTC(2024, 4, 6, 12, 0, 0);
const ours = (u: URL) => u.hostname === 'me.example';

test('Link header parsing handles several links, commas in URLs and quoted rels', () => {
  const l = parseLinkHeader('<https://a.example/x,y>; rel="webmention", <https://b.example/>; rel="stylesheet preload"; title="a, b", </wm>; REL=webmention');
  assert.deepEqual(l.map((x) => x.url), ['https://a.example/x,y', 'https://b.example/', '/wm']);
  assert.deepEqual(l[1]!.rels, ['stylesheet', 'preload']);
  assert.deepEqual(l[2]!.rels, ['webmention']);
});

test('endpoint discovery: header beats HTML, first in document order wins, relative resolves', () => {
  const page = '<html><head><base href="https://me.example/b/"><link rel="webmention" href="one"></head><body><a rel="webmention" href="two">x</a></body></html>';
  assert.equal(findEndpoint({ headers: {}, body: page }, 'https://me.example/p'), 'https://me.example/b/one');
  assert.equal(findEndpoint({ headers: { link: ['<https://h.example/ep>; rel="other"', '</hdr>; rel="webmention"'] }, body: page }, 'https://me.example/p'), 'https://me.example/hdr');
  assert.equal(findEndpoint({ headers: {}, body: '<a rel="nofollow webmention" href="">y</a>' }, 'https://me.example/p?q=1'), 'https://me.example/p?q=1', 'an empty href is the page itself');
  assert.equal(findEndpoint({ headers: {}, body: '<a rel="webmention-not" href="/x">y</a><link rel="webmention">' }, 'https://me.example/'), undefined);
  assert.equal(findEndpoint({ headers: {}, body: '<!-- <link rel="webmention" href="/c"> --><p>no</p>' }, 'https://me.example/'), undefined);
});

test('send discovers the endpoint and posts form-encoded source and target', async () => {
  const w = world({
    'https://them.example/post': html('<link rel="webmention" href="/wm">'),
    'https://them.example/wm': () => ({ status: 201, headers: { location: '/status/1' } }),
  });
  const r = await send('https://me.example/a?x=1&y=2', 'https://them.example/post', { fetch: w.fetch });
  assert.deepEqual(r, { ok: true, status: 201, endpoint: 'https://them.example/wm', location: 'https://them.example/status/1' });
  const post = w.calls.find((c) => c.init.method === 'POST')!;
  assert.equal(post.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(post.init.body, 'source=https%3A%2F%2Fme.example%2Fa%3Fx%3D1%26y%3D2&target=https%3A%2F%2Fthem.example%2Fpost');
});

test('send reports no endpoint, refusals, and unreachable targets without throwing', async () => {
  const w = world({ 'https://them.example/plain': html('<p>hi</p>'), 'https://them.example/ok': html('<link rel="webmention" href="/wm">'), 'https://them.example/wm': { status: 400 } });
  assert.deepEqual(await send('https://me.example/a', 'https://them.example/plain', { fetch: w.fetch }), { ok: false, reason: 'no_endpoint' });
  const refused = await send('https://me.example/a', 'https://them.example/ok', { fetch: w.fetch });
  assert.deepEqual(refused, { ok: false, reason: 'refused', endpoint: 'https://them.example/wm', status: 400 });
  const dead = await send('https://me.example/a', 'https://them.example/x', { fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(dead.ok, false);
  assert.equal((dead as { reason: string }).reason, 'unreachable');
});

test('redirects are followed, each hop is re-checked, and loops stop', async () => {
  const w = world({
    'https://a.example/1': { status: 301, headers: { location: 'https://a.example/2' } },
    'https://a.example/2': html('<link rel="webmention" href="/wm">'),
    'https://a.example/evil': { status: 302, headers: { location: 'http://169.254.169.254/latest' } },
    'https://a.example/loop': { status: 302, headers: { location: 'https://a.example/loop' } },
  });
  assert.equal(await discover('https://a.example/1', { fetch: w.fetch }), 'https://a.example/wm');
  await assert.rejects(discover('https://a.example/evil', { fetch: w.fetch }), (e: unknown) => e instanceof WebmentionRejected && e.code === 'blocked_host');
  await assert.rejects(discover('https://a.example/loop', { fetch: w.fetch }), (e: unknown) => e instanceof WebmentionRejected && e.code === 'too_many_redirects');
});

test('private and odd hosts are blocked, public ones are not', () => {
  for (const h of ['localhost', 'a.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', 'intranet', 'x.internal', 'printer.local']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]', 'sub.me.example']) assert.equal(isPrivateHost(h), false, h);
  assert.throws(() => checkUrl('http://2130706433/'), (e: unknown) => e instanceof WebmentionRejected && e.code === 'blocked_host', 'a decimal IP is normalised, then blocked');
  assert.throws(() => checkUrl('javascript:alert(1)'), /http and https/);
  assert.throws(() => checkUrl('https://user:pw@example.com/'), /user name/);
  assert.throws(() => checkUrl('not a url'), WebmentionRejected);
  assert.doesNotThrow(() => checkUrl('http://127.0.0.1/', true));
});

test('microformats2: h-entry with author card, nested cite, dates and e-content', () => {
  const src = `<div class="h-entry"><a class="p-author h-card" href="https://ann.example/"><img src="/ann.jpg" alt="">Ann</a>
    <h1 class="p-name">A <b>reply</b></h1><a class="u-in-reply-to h-cite" href="https://me.example/post">my post</a>
    <time class="dt-published" datetime="2024-05-06T10:00:00Z">May 6</time><div class="e-content">Nice <i>one</i> &amp; thanks<br>bye</div>
    <a class="u-url" href="/r/1">permalink</a></div>`;
  const mf = parseMf2(src, 'https://ann.example/r/1');
  const e = mf.items[0]!;
  assert.deepEqual(e.type, ['h-entry']);
  assert.equal(e.properties['name']![0], 'A reply');
  const author = e.properties['author']![0] as { type: string[]; properties: Record<string, unknown[]>; value: string };
  assert.deepEqual(author.type, ['h-card']);
  assert.equal(author.properties['url']![0], 'https://ann.example/');
  assert.equal(author.properties['photo']![0], 'https://ann.example/ann.jpg');
  assert.equal(author.properties['name']![0], 'Ann');
  const cite = e.properties['in-reply-to']![0] as { type: string[]; value: string };
  assert.equal(cite.value, 'https://me.example/post');
  assert.equal(e.properties['published']![0], '2024-05-06T10:00:00Z');
  assert.deepEqual(e.properties['content']![0], { html: 'Nice <i>one</i> &amp; thanks<br></br>bye'.replace('<br></br>', '<br>'), value: 'Nice one & thanks\nbye' });
  assert.equal(e.properties['url']![0], 'https://ann.example/r/1');
});

test('microformats2: implied name, url and photo; rels; base href; no prototype keys', () => {
  const mf = parseMf2('<base href="https://cdn.example/x/"><a class="h-card" href="https://bob.example/"><img src="b.png" alt="">Bob</a><link rel="author me" href="/b"><a rel="me" href="https://m.example/@bob">fed</a><p class="__proto__ p-constructor">z</p>', 'https://bob.example/');
  const c = mf.items[0]!;
  assert.equal(c.properties['name']![0], 'Bob');
  assert.equal(c.properties['url']![0], 'https://bob.example/');
  assert.equal(c.properties['photo']![0], 'https://cdn.example/x/b.png');
  assert.deepEqual(mf.rels['me'], ['https://cdn.example/b', 'https://m.example/@bob']);
  assert.deepEqual(mf['rel-urls']['https://cdn.example/b']!.rels, ['author', 'me']);
  assert.equal(({} as Record<string, unknown>)['constructor'] === Object, true);
});

test('children, p- and dt- value rules, and a hostile document do not hang or crash', () => {
  const mf = parseMf2('<div class="h-feed"><div class="h-entry"><abbr class="p-name" title="Full">F</abbr><data class="p-rating" value="5">five</data><time class="dt-published">2024-01-01</time></div><div class="h-entry"><span class="p-name">Two</span></div></div>', 'https://x.example/');
  const feed = mf.items[0]!;
  assert.equal(feed.children!.length, 2);
  assert.equal(feed.children![0]!.properties['name']![0], 'Full');
  assert.equal(feed.children![0]!.properties['rating']![0], '5');
  const deep = parseMf2('<div>'.repeat(5000) + '<span class="h-card p-name">x</span>', 'https://x.example/');
  assert.ok(Array.isArray(deep.items));
  assert.doesNotThrow(() => parseMf2('<a href="x" class="h-card" <<<>>> "unterminated <!-- c <script>var a="<a href=\'/x\'>"', 'https://x.example/'));
});

test('entities decode, and unsafe numeric ones become the replacement character', () => {
  assert.equal(decodeEntities('a &amp; b &lt; &#65;&#x42; &nbsp;|&bogus;'), 'a & b < AB  |&bogus;');
  assert.equal(decodeEntities('&#0;&#xD800;&#1114112;'), '���');
});

test('linksTo finds links in HTML (with fragments, relative, img), JSON and plain text, and not elsewhere', () => {
  const t = 'https://me.example/post';
  const h = (body: string, ct = 'text/html') => ({ headers: { 'content-type': ct }, body });
  assert.equal(linksTo(h('<a href="/post#c1">x</a>'), 'https://me.example/other', t), true);
  assert.equal(linksTo(h('<img src="https://me.example/post">'), 'https://x.example/', t), true);
  assert.equal(linksTo(h('<a href="/post">x</a>'), 'https://x.example/', t), false, 'resolves against the source, not the target');
  assert.equal(linksTo(h('<p>https://me.example/post</p><script>var u="https://me.example/post"</script>'), 'https://x.example/', t), false, 'text and scripts are not links');
  assert.equal(linksTo(h('<a href="https://me.example/post2">x</a><a href="http://me.example/post">y</a>'), 'https://x.example/', t), false);
  assert.equal(linksTo(h('{"a":[{"b":"https://me.example/post"}]}', 'application/json'), 'https://x.example/', t), true);
  assert.equal(linksTo(h('{ broken', 'application/json'), 'https://x.example/', t), false);
  assert.equal(linksTo(h('see (https://me.example/post).', 'text/plain'), 'https://x.example/', t), true);
});

test('interpret classes replies, likes, reposts and bookmarks, with excerpt and clamped dates', () => {
  const page = (cls: string, extra = '') => `<div class="h-entry"><a class="p-author h-card" href="https://a.example/">Ann</a><a class="${cls}" href="https://me.example/post">x</a><div class="p-content">${'word '.repeat(100)}</div>${extra}</div>`;
  const run = (body: string) => interpret(html(body) as FetchResult, 'https://a.example/1', 'https://me.example/post', T0, 50);
  assert.equal(run(page('u-in-reply-to')).type, 'reply');
  assert.equal(run(page('u-like-of')).type, 'like');
  assert.equal(run(page('u-repost-of')).type, 'repost');
  assert.equal(run(page('u-bookmark-of')).type, 'bookmark');
  assert.equal(run('<div class="h-entry"><a href="https://me.example/post">just a link</a></div>').type, 'mention');
  assert.equal(run('<p><a href="https://me.example/post">no mf2 at all</a></p>').type, 'mention');
  const m = run(page('u-in-reply-to', '<time class="dt-published" datetime="2999-01-01T00:00:00Z"></time>'));
  assert.equal(m.author?.name, 'Ann');
  assert.ok(m.text!.length <= 50 && m.text!.endsWith('…'));
  assert.equal(m.published, undefined, 'a date far in the future is dropped');
  assert.equal(run(page('u-like-of', '<time class="dt-published" datetime="2024-05-01T00:00:00Z"></time>')).published, '2024-05-01T00:00:00.000Z');
  assert.equal(interpret({ headers: { 'content-type': 'text/plain' }, body: 'x' }, 'https://a.example/', 'https://me.example/post', T0).type, 'mention');
});

test('receive verifies, stores and classes a reply, and keeps no HTML', async () => {
  const w = world({ 'https://a.example/r': html('<div class="h-entry"><a class="p-author h-card" href="https://a.example/">Ann</a><a class="u-in-reply-to" href="https://me.example/post">p</a><div class="e-content"><script>alert(1)</script><b>Great</b> post</div></div>') });
  const inbox = new Inbox({ fetch: w.fetch, now: () => T0, isTarget: ours });
  const r = await inbox.receive('https://a.example/r', 'https://me.example/post#frag');
  assert.equal(r.status, 'verified');
  assert.ok(r.status === 'verified' && !r.updated);
  const m = (r as { mention: { type: string; text?: string; target: string; verifiedAt: string; author?: { name?: string } } }).mention;
  assert.equal(m.type, 'reply');
  assert.equal(m.text, 'Great post');
  assert.equal(m.target, 'https://me.example/post');
  assert.equal(m.verifiedAt, '2024-05-06T12:00:00.000Z');
  assert.equal(m.author?.name, 'Ann');
  assert.ok(!JSON.stringify(m).includes('<'));
  assert.equal(inbox.list('https://me.example/post').length, 1);
  assert.deepEqual(inbox.summary('https://me.example/post'), { reply: 1, like: 0, repost: 0, bookmark: 0, mention: 0 });
});

test('receive refuses bad requests before fetching anything', async () => {
  const w = world({});
  const inbox = new Inbox({ fetch: w.fetch, now: () => T0, isTarget: ours });
  const code = async (s: string, t: string) => inbox.receive(s, t).then(() => 'ok', (e: unknown) => (e instanceof WebmentionRejected ? e.code : 'other'));
  const before = w.calls.length;
  assert.equal(await code('https://me.example/post', 'https://me.example/post#x'), 'bad_request');
  assert.equal(await code('https://a.example/r', 'https://other.example/post'), 'not_our_target');
  assert.equal(await code('http://localhost/r', 'https://me.example/post'), 'blocked_host');
  assert.equal(await code('ftp://a.example/r', 'https://me.example/post'), 'bad_url');
  assert.equal(await code('nonsense', 'https://me.example/post'), 'bad_url');
  assert.equal(w.calls.length, before, 'nothing was fetched for a rejected request');
  assert.equal(w.calls.length, 0);
  assert.equal(await code('https://a.example/r', 'https://me.example/post'), 'source_gone', 'a source that does not exist is refused after one fetch');
  assert.equal(w.calls.length, 1);
});

test('receive rejects a source without the link, and removes a stored mention when the link goes or the page is gone', async () => {
  let body = '<a class="u-like-of" href="https://me.example/post">like</a>';
  let status = 200;
  const w = world({ 'https://a.example/l': () => html(body, { status }) });
  const inbox = new Inbox({ fetch: w.fetch, now: () => T0, isTarget: ours });
  assert.equal((await inbox.receive('https://a.example/l', 'https://me.example/post')).status, 'verified');
  assert.equal((await inbox.receive('https://a.example/l', 'https://me.example/post').then((r) => r.status === 'verified' && r.updated)), true, 'a repeat updates in place');
  assert.equal(inbox.list().length, 1);
  body = '<p>unliked</p>';
  assert.equal((await inbox.receive('https://a.example/l', 'https://me.example/post')).status, 'removed');
  assert.equal(inbox.list().length, 0);
  await assert.rejects(inbox.receive('https://a.example/l', 'https://me.example/post'), (e: unknown) => e instanceof WebmentionRejected && e.code === 'no_link');
  body = '<a href="https://me.example/post">again</a>';
  await inbox.receive('https://a.example/l', 'https://me.example/post');
  status = 410;
  assert.equal((await inbox.receive('https://a.example/l', 'https://me.example/post')).status, 'removed');
  await assert.rejects(inbox.receive('https://a.example/l', 'https://me.example/post'), (e: unknown) => e instanceof WebmentionRejected && e.code === 'source_gone');
});

test('size limits, error statuses and per-target caps are enforced', async () => {
  const w = world({
    'https://a.example/big': html('<a href="https://me.example/post">x</a>' + 'x'.repeat(5000)),
    'https://a.example/err': html('', { status: 500 }),
    'https://a.example/1': html('<a href="https://me.example/post">1</a>'),
    'https://a.example/2': html('<a href="https://me.example/post">2</a>'),
  });
  const inbox = new Inbox({ fetch: w.fetch, now: () => T0, isTarget: ours, maxBytes: 1000, maxPerTarget: 1 });
  await assert.rejects(inbox.receive('https://a.example/big', 'https://me.example/post'), (e: unknown) => e instanceof WebmentionRejected && e.code === 'too_large');
  await assert.rejects(inbox.receive('https://a.example/err', 'https://me.example/post'), (e: unknown) => e instanceof WebmentionRejected && e.code === 'fetch_failed');
  await inbox.receive('https://a.example/1', 'https://me.example/post');
  await assert.rejects(inbox.receive('https://a.example/2', 'https://me.example/post'), (e: unknown) => e instanceof WebmentionRejected && e.code === 'too_many_mentions');
  assert.equal((await inbox.receive('https://a.example/1', 'https://me.example/post')).status, 'verified', 'updating an existing one is not blocked by the cap');
});

test('recheck drops mentions whose source stopped linking, and snapshots restore', async () => {
  const live: Record<string, string> = { 'https://a.example/1': '<a href="https://me.example/p">1</a>', 'https://a.example/2': '<a href="https://me.example/p">2</a>' };
  const fetch: Fetch = async (url) => (url in live ? { status: 200, headers: { 'content-type': 'text/html' }, body: live[url]! } : { status: 404, headers: {}, body: '' });
  const inbox = new Inbox({ fetch, now: () => T0, isTarget: ours });
  await inbox.receive('https://a.example/1', 'https://me.example/p');
  await inbox.receive('https://a.example/2', 'https://me.example/p');
  const snap = inbox.snapshot();
  live['https://a.example/2'] = '<p>edited</p>';
  delete live['https://a.example/1'];
  const gone = await inbox.recheck('https://me.example/p');
  assert.deepEqual(gone.map((m) => m.source).sort(), ['https://a.example/1', 'https://a.example/2']);
  assert.equal(inbox.list().length, 0);
  inbox.restore(snap);
  assert.equal(inbox.list().length, 2);
  assert.ok(inbox.get('https://a.example/1', 'https://me.example/p#x'));
});

test('outgoingTargets lists each distinct http(s) link once, not itself', () => {
  const html = '<a href="https://a.example/x#1">1</a><a href="https://a.example/x#2">2</a><a href="/self">s</a><a href="mailto:a@b.c">m</a><a href="javascript:void(0)">j</a><a href="/rel/path">r</a><img src="https://i.example/i.png">';
  assert.deepEqual(outgoingTargets(html, 'https://me.example/self'), ['https://a.example/x', 'https://me.example/rel/path']);
  assert.equal(normalize('HTTPS://Me.Example:443/a#b'), 'https://me.example/a');
  assert.equal(normalize('::'), undefined);
});
