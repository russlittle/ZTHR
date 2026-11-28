import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { sign } from '../crypto/index.ts';
import { BadLink, classify, ipInRanges, OPEN_GIF, openResponse, Recorder, redirectResponse, TrackingError, Tracker, type Hit } from './index.ts';

const secret = randomBytes(32).toString('base64');
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const base = 'https://track.example.com';
const mk = (o: Partial<ConstructorParameters<typeof Tracker>[0]> = {}) => new Tracker({ secret, baseUrl: base, now: () => T0, ...o });
const ctx = { campaign: 'spring', message: 'm1', recipient: 'r-42' };
const human: Hit = { at: T0 + 60_000, method: 'GET', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', ip: '203.0.113.9' };
const tokenOf = (url: string | null) => new URL(url!).pathname.split('/').pop()!.replace(/\.gif$/, '');

test('the open pixel is a real 1x1 gif and is never cached or sniffed', () => {
  assert.deepEqual([...OPEN_GIF.subarray(0, 6)], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.equal(OPEN_GIF.length, 42);
  const r = openResponse();
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/gif');
  assert.equal(r.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['content-length'], '42');
});

test('a click link round-trips the destination through a signed token', () => {
  const t = mk();
  const link = t.clickUrl(ctx, 'https://shop.example.org/sale?a=1&b=2#top', 'hero');
  assert.ok(link.startsWith(`${base}/t/c/`));
  const c = t.resolveClick(tokenOf(link));
  assert.deepEqual([c.url, c.campaign, c.message, c.recipient, c.link], ['https://shop.example.org/sale?a=1&b=2#top', 'spring', 'm1', 'r-42', 'hero']);
  const red = redirectResponse(c.url);
  assert.deepEqual([red.status, red.headers.location, red.headers['referrer-policy'], red.headers['cache-control']], [302, 'https://shop.example.org/sale?a=1&b=2#top', 'no-referrer', 'no-store']);
});

test('only http(s) destinations without embedded credentials can be tracked: no open redirects, no script links', () => {
  const t = mk();
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '//evil.example', '/relative', 'https://user:pw@evil.example/', 'ftp://x.example/', 'https://exa mple.com', 'https://x.example/\u0000', '']) {
    assert.throws(() => t.clickUrl(ctx, bad, 'l'), BadLink, bad);
  }
  assert.throws(() => t.clickUrl(ctx, `https://x.example/${'a'.repeat(3000)}`, 'l'), BadLink);
  const only = mk({ allowHosts: ['shop.example.org', '*.partner.example'] });
  assert.ok(only.clickUrl(ctx, 'https://shop.example.org/x', 'l'));
  assert.ok(only.clickUrl(ctx, 'https://a.partner.example/x', 'l'));
  assert.throws(() => only.clickUrl(ctx, 'https://evilpartner.example/x', 'l'), /not on the list/);
  assert.throws(() => only.clickUrl(ctx, 'https://shop.example.org.evil.test/x', 'l'), BadLink);
});

test('a changed, foreign, expired or wrong-purpose token is refused', () => {
  const t = mk();
  const tok = tokenOf(t.clickUrl(ctx, 'https://shop.example.org/', 'l'));
  const [body, mac] = tok.split('.');
  const other = Buffer.from(JSON.stringify({ p: 'mail-click', d: { u: 'https://evil.example/', c: 'spring', s: T0 }, e: T0 + 1e12 })).toString('base64url');
  assert.throws(() => t.resolveClick(`${other}.${mac}`), BadLink);
  assert.throws(() => t.resolveClick(`${body}.AAAA`), BadLink);
  assert.throws(() => t.resolveClick('garbage'), BadLink);
  assert.throws(() => t.resolveClick(''), BadLink);
  assert.throws(() => t.resolveClick(tokenOf(t.pixelUrl(ctx))), /for something else/);
  assert.throws(() => mk({ secret: randomBytes(32).toString('base64') }).resolveClick(tok), BadLink);
  const late = mk({ now: () => T0 + 400 * 86_400_000 });
  assert.throws(() => late.resolveClick(tok), /expired/);
  const forged = sign(secret, 'mail-click', { u: 'javascript:alert(1)', c: 'x', s: 0 }, 1e9, T0);
  assert.throws(() => t.resolveClick(forged), BadLink, 'even a correctly signed token must not point at a script');
  assert.ok(new BadLink('x') instanceof TrackingError);
});

test('privacy modes: full names the recipient, aggregate does not, off does nothing', () => {
  const full = mk({ mode: 'full' }).resolveOpen(tokenOf(mk({ mode: 'full' }).pixelUrl(ctx)));
  assert.equal(full.recipient, 'r-42');
  const agg = mk({ mode: 'aggregate' });
  const a = agg.resolveOpen(tokenOf(agg.pixelUrl(ctx)));
  assert.equal(a.recipient, undefined);
  assert.ok(!JSON.stringify(Buffer.from(tokenOf(agg.pixelUrl(ctx)).split('.')[0]!, 'base64url').toString()).includes('r-42'));
  const off = mk({ mode: 'off' });
  assert.equal(off.pixelUrl(ctx), null);
  assert.equal(off.clickUrl(ctx, 'https://shop.example.org/', 'l'), 'https://shop.example.org/', 'links stay direct, nothing is recorded');
  assert.throws(() => mk({ baseUrl: 'http://track.example.com' }), /https/);
  assert.throws(() => mk({ secret: 'short' }), /at least 16/);
});

test('rewriting html tracks web links, leaves the rest alone, and adds one pixel', () => {
  const t = mk();
  const html = `<html><body><a href="https://shop.example.org/a?x=1&amp;y=2">A</a> <a class=x href='https://shop.example.org/b'>B</a>
<a href="mailto:me@example.com">M</a><a href="#top">T</a><a href="tel:+100">T</a><a data-track="off" href="https://shop.example.org/unsub">U</a>
<a href="${base}/t/c/already.tok">done</a><a href="javascript:alert(1)">J</a></body></html>`;
  const r = t.rewriteHtml(html, ctx);
  assert.deepEqual(r.links.map((l) => [l.id, l.url]), [['l1', 'https://shop.example.org/a?x=1&y=2'], ['l2', 'https://shop.example.org/b']]);
  assert.equal([...r.html.matchAll(/\/t\/c\//g)].length, 3, 'two new links, and the one already tracked is left as it was');
  assert.ok(r.html.includes('href="mailto:me@example.com"') && r.html.includes('href="#top"') && r.html.includes('href="javascript:alert(1)"'));
  assert.ok(r.html.includes('data-track="off" href="https://shop.example.org/unsub"'));
  assert.equal([...r.html.matchAll(/<img /g)].length, 1);
  assert.ok(r.html.endsWith('</body></html>') && r.html.includes('width="1" height="1" alt="" style="display:none"'));
  const c = t.resolveClick(r.html.match(/\/t\/c\/([^"']+)/)![1]!);
  assert.equal(c.url, 'https://shop.example.org/a?x=1&y=2', 'the entity in the address was decoded before signing');
  assert.equal(mk({ mode: 'off' }).rewriteHtml(html, ctx).html, html);
  assert.ok(mk().rewriteHtml('<p>no body</p>', ctx).html.endsWith('alt="" style="display:none">'));
});

test('a link that fails the host list is left direct, and reported, not dropped', () => {
  const t = mk({ allowHosts: ['shop.example.org'] });
  const r = t.rewriteHtml('<a href="https://other.example/x">x</a><a href="https://shop.example.org/y">y</a>', ctx);
  assert.deepEqual(r.skipped, [{ url: 'https://other.example/x', why: 'the host other.example is not on the list of hosts that may be tracked' }]);
  assert.ok(r.html.includes('href="https://other.example/x"'));
});

test('proxies and scanners are told apart from people', () => {
  const sent = T0;
  const c = (h: Partial<Hit>, kind: 'open' | 'click' = 'open') => classify(kind, { ...human, ...h }, { sentAt: sent });
  assert.deepEqual(c({}), { kind: 'human', reason: 'looks like a person' });
  assert.deepEqual(c({ userAgent: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' }), { kind: 'proxy', reason: 'Gmail image proxy: the open is real but the time and place are not' });
  assert.deepEqual(c({ ip: '17.58.12.9' }), { kind: 'proxy', reason: 'Apple Mail Privacy Protection fetches every image on delivery' });
  assert.equal(c({ ip: '17.58.12.9' }, 'click').kind, 'human', 'a proxy only blurs opens, not clicks');
  assert.equal(c({ userAgent: 'Mozilla/5.0 (compatible; Barracuda Sentinel)' }).kind, 'bot');
  assert.equal(c({ userAgent: 'python-requests/2.31' }, 'click').kind, 'bot');
  assert.equal(c({ userAgent: 'Mozilla/5.0 HeadlessChrome/120' }).kind, 'bot');
  assert.equal(c({ userAgent: '' }).reason, 'no user agent');
  assert.equal(c({ at: sent + 1500 }, 'click').reason, 'arrived within 2000 ms of sending, faster than a person');
  assert.equal(c({ at: sent + 2000 }, 'click').kind, 'human');
  assert.equal(c({ method: 'HEAD' }).reason, 'a HEAD request is a link checker');
  assert.equal(c({ headers: { purpose: 'prefetch' } }).reason, 'a prefetch, not a visit');
  assert.equal(c({ headers: { 'sec-purpose': 'prefetch;prerender' } }).kind, 'bot');
});

test('address ranges are matched as IPv4 networks and nothing else matches', () => {
  assert.ok(ipInRanges('17.0.0.1', ['17.0.0.0/8']));
  assert.ok(ipInRanges('192.0.2.77', ['192.0.2.64/26']));
  assert.ok(!ipInRanges('192.0.2.200', ['192.0.2.64/26']));
  assert.ok(ipInRanges('10.1.2.3', ['10.1.2.3/32']));
  assert.ok(!ipInRanges('2001:db8::1', ['17.0.0.0/8']));
  assert.ok(!ipInRanges('999.1.1.1', ['0.0.0.0/0']));
  assert.ok(!ipInRanges(undefined, ['0.0.0.0/0']));
  assert.throws(() => ipInRanges('1.1.1.1', ['1.1.1.1/33']), /not a network/);
});

test('the recorder counts people once, keeps proxies and bots apart, and counts a click as an open', () => {
  const t = mk();
  let now = T0;
  const rec = new Recorder({ tracker: t, now: () => now });
  const open = (r: string) => tokenOf(t.pixelUrl({ ...ctx, recipient: r }));
  const click = (r: string, link: string, to: string) => tokenOf(t.clickUrl({ ...ctx, recipient: r }, to, link));
  now = T0 + 60_000;
  rec.open(open('a'), human);
  rec.open(open('a'), human);
  rec.open(open('b'), { ...human, ip: '17.1.1.1' });
  rec.open(open('c'), { ...human, userAgent: 'Barracuda' });
  rec.click(click('d', 'hero', 'https://shop.example.org/1'), human);
  rec.click(click('d', 'hero', 'https://shop.example.org/1'), human);
  rec.click(click('a', 'foot', 'https://shop.example.org/2'), human);
  rec.click(click('e', 'hero', 'https://shop.example.org/1'), { ...human, at: T0 + 500 });
  const s = rec.stats('spring', 5);
  assert.deepEqual([s.opens, s.proxyOpens, s.bots, s.clicks, s.uniqueClicks], [2, 1, 2, 3, 2]);
  assert.deepEqual(s.links, { hero: { clicks: 2, unique: 1 }, foot: { clicks: 1, unique: 1 } });
  assert.deepEqual([s.openRate, s.clickRate, s.clickToOpen], [0.4, 0.4, 1]);
  assert.equal(rec.stats('other', 0).openRate, null);
});

test('the recorder refuses events for a campaign that the token does not name, and unknown tokens', () => {
  const t = mk();
  const rec = new Recorder({ tracker: t, now: () => T0 + 60_000 });
  assert.throws(() => rec.open('x.y', human), BadLink);
  assert.throws(() => rec.click(tokenOf(t.pixelUrl(ctx)), human), /for something else/);
  assert.equal(rec.stats('spring', 1).opens, 0);
});

test('opt-out stops all recording about a person, and the signed opt-out link is the only way in', () => {
  const t = mk();
  const rec = new Recorder({ tracker: t, now: () => T0 + 60_000 });
  const link = t.optOutUrl({ recipient: 'r-9' });
  assert.ok(link.startsWith(`${base}/t/x/`));
  assert.equal(rec.optOut(tokenOf(link)), 'r-9');
  assert.ok(rec.isOptedOut('r-9'));
  const ev = rec.open(tokenOf(t.pixelUrl({ ...ctx, recipient: 'r-9' })), human);
  assert.equal(ev, null, 'nothing is stored about an opted-out person');
  assert.equal(rec.stats('spring', 1).opens, 0);
  assert.throws(() => rec.optOut(tokenOf(t.pixelUrl(ctx))), BadLink);
  const clicked = rec.click(tokenOf(t.clickUrl({ ...ctx, recipient: 'r-9' }, 'https://shop.example.org/', 'l')), human);
  assert.deepEqual([clicked.url, clicked.event], ['https://shop.example.org/', null], 'the click still goes through to its destination');
  assert.ok(rec.events().every((e) => e.recipient !== 'r-9'));
});

test('a browser signal to not track is honoured: the event is kept without the person', () => {
  const t = mk();
  const rec = new Recorder({ tracker: t, now: () => T0 + 60_000 });
  const ev = rec.open(tokenOf(t.pixelUrl(ctx)), { ...human, headers: { 'sec-gpc': '1' } });
  assert.equal(ev?.recipient, undefined);
  const ev2 = rec.open(tokenOf(t.pixelUrl(ctx)), { ...human, headers: { dnt: '1' } });
  assert.equal(ev2?.recipient, undefined);
  assert.deepEqual([rec.stats('spring', 2).opens], [2], 'without a person to match them, each counts once');
  assert.ok(rec.events().every((e) => !('ip' in e) && !('userAgent' in e)), 'the address and the browser are never stored');
});

test('the store is bounded: past the cap new events are counted as dropped, not kept', () => {
  const t = mk();
  const rec = new Recorder({ tracker: t, now: () => T0 + 60_000, maxEvents: 3 });
  for (let i = 0; i < 5; i++) rec.open(tokenOf(t.pixelUrl({ ...ctx, recipient: `r${i}` })), human);
  assert.equal(rec.events().length, 3);
  assert.equal(rec.stats('spring', 5).dropped, 2);
});
