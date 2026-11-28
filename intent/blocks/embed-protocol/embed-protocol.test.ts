import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkEmbedRequest, embeddableHeaders, embedUrl, Endpoint, EmbedRefused, frameCookie, hostPageNeeds, normalizeOrigin, originAllowed, parseMessage, pickHostOrigin, popupFeatures, ResizeController, snippet,
  type Envelope, type Incoming,
} from './index.ts';

const HOST = 'https://shop.example.com';
const FRAME = 'https://app.example.org';

/** Two endpoints wired through fake windows; messages are queued so tests control delivery. */
function pair() {
  const hostWin = { name: 'host-window' };
  const frameWin = { name: 'frame-window' };
  const toHost: { m: Envelope; target: string }[] = [];
  const toFrame: { m: Envelope; target: string }[] = [];
  let n = 0;
  const random = (len: number) => `chan${String(++n).padStart(len - 4, '0')}`;
  const host = new Endpoint({ role: 'host', peerOrigin: FRAME, peerWindow: frameWin, post: (m, t) => toFrame.push({ m, target: t }), random });
  const frame = new Endpoint({ role: 'frame', peerOrigin: HOST, peerWindow: hostWin, post: (m, t) => toHost.push({ m, target: t }), random });
  const atHost = (m: unknown): Incoming => ({ origin: FRAME, source: frameWin, data: m });
  const atFrame = (m: unknown): Incoming => ({ origin: HOST, source: hostWin, data: m });
  return { host, frame, toHost, toFrame, atHost, atFrame, hostWin, frameWin };
}
function opened() {
  const p = pair();
  const ready = p.frame.send('ready');
  p.host.receive(p.atHost(ready));
  const init = p.host.send('init', { theme: 'dark' });
  p.frame.receive(p.atFrame(init));
  return { ...p, init };
}

test('origins are exact, and only https (or http on localhost) with no path', () => {
  assert.equal(normalizeOrigin('HTTPS://Shop.Example.com:443'), 'https://shop.example.com');
  assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  for (const bad of ['*', 'null', 'http://evil.com', 'https://a.com/path', 'https://u:p@a.com', 'https://a.com?x=1', 'ftp://a.com', 'nonsense']) assert.throws(() => normalizeOrigin(bad), EmbedRefused, bad);
});

test('the allow-list matches exactly or by one wildcard subdomain level, never by suffix tricks', () => {
  const list = [HOST, 'https://*.partner.net'];
  assert.equal(originAllowed(HOST, list), true);
  assert.equal(originAllowed('https://shop.example.com:8443', list), false, 'another port is another origin');
  assert.equal(originAllowed('http://shop.example.com', list), false);
  assert.equal(originAllowed('https://a.partner.net', list), true);
  assert.equal(originAllowed('https://a.b.partner.net', list), true);
  assert.equal(originAllowed('https://partner.net', list), false, 'the bare domain is not a subdomain');
  assert.equal(originAllowed('https://evilpartner.net', list), false);
  assert.equal(originAllowed('https://partner.net.evil.com', list), false);
  assert.equal(originAllowed('null', list), false);
  assert.throws(() => originAllowed(HOST, ['*']), EmbedRefused);
  assert.throws(() => originAllowed(HOST, ['https://*']), EmbedRefused);
});

test('a frame picks its parent from ancestor origins and the referrer, only if allowed', () => {
  const allowed = [HOST];
  assert.equal(pickHostOrigin(['https://evil.example', HOST], allowed), HOST);
  assert.equal(pickHostOrigin([undefined, `${HOST}/products?id=1`], allowed), HOST);
  assert.equal(pickHostOrigin(['https://evil.example', 'garbage'], allowed), undefined);
});

test('the embed address takes only named parameters, never credentials or secret-looking names', () => {
  assert.equal(embedUrl('https://app.example.org/f/abc#x', { ref: 'home' }, { theme: 'dark', locale: 'de' }), 'https://app.example.org/f/abc?ref=home&theme=dark&locale=de');
  assert.throws(() => embedUrl('javascript:alert(1)'), EmbedRefused);
  assert.throws(() => embedUrl('https://u:p@app.example.org/f'), /credentials/);
  assert.throws(() => embedUrl('https://app.example.org/f', { api_key: 'x' }), /secret/);
  assert.throws(() => embedUrl('https://app.example.org/f', { 'a b': 'x' }), /not an allowed parameter/);
  assert.throws(() => embedUrl('https://app.example.org/f', { a: 'x\ny' }), /control characters/);
  assert.throws(() => embedUrl('http://app.example.org/f'), EmbedRefused);
});

test('the pasted snippet is escaped, sandboxed and gives the frame only the features asked for', () => {
  const s = snippet({ src: 'https://app.example.org/f/abc', mode: 'inline', title: 'Book "now" <b>', height: 700, allow: ['payment'] });
  assert.equal(s, '<iframe src="https://app.example.org/f/abc" title="Book &quot;now&quot; &lt;b&gt;" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" allow="payment https://app.example.org" style="border:0;width:100%;height:700px"></iframe>');
  assert.throws(() => snippet({ src: 'https://app.example.org/f', mode: 'inline', title: ' ' }), /title/);
  assert.throws(() => snippet({ src: 'https://app.example.org/f', mode: 'inline', title: 't', allow: ['usb'] }), /not one an embed may ask for/);
  assert.throws(() => snippet({ src: 'https://app.example.org/f', mode: 'inline', title: 't', width: '100%;position:fixed' }), /width/);
  const f = snippet({ src: 'https://app.example.org/f', mode: 'floating', title: 'Chat' });
  assert.equal(f, '<script async src="https://app.example.org/embed.js" data-mode="floating" data-src="https://app.example.org/f" data-title="Chat"></script>');
  assert.ok(snippet({ src: 'https://app.example.org/f?a=1&b=2', mode: 'popup', title: "It's open" }).includes('&amp;b=2'));
  assert.equal(popupFeatures(520, 720), 'popup=yes,width=520,height=720,left=380,top=40');
  assert.ok(!popupFeatures(520, 720).includes('noopener'));
  assert.equal(popupFeatures(5000, 10), 'popup=yes,width=1280,height=320,left=0,top=240');
});

test('the message validators accept the contract and refuse everything else', () => {
  const ok = (type: string, payload: unknown, from: 'host' | 'frame', seq = 1) => parseMessage({ ns: 'zthr-embed', v: 1, type, seq, channel: 'abcdefghijklmnop', payload }, from);
  assert.equal(ok('resize', { height: 640 }, 'frame').ok, true);
  assert.equal(ok('event', { name: 'form.submitted', data: { id: 7 } }, 'frame').ok, true);
  assert.equal(ok('navigate', { url: 'https://example.com/thanks' }, 'frame').ok, true);
  assert.equal(ok('init', { theme: 'dark', locale: 'pt-BR', prefill: { email: 'a@b.test', n: 3, yes: true } }, 'host').ok, true);
  const bad = (type: string, payload: unknown, from: 'host' | 'frame') => {
    const r = ok(type, payload, from);
    return r.ok ? 'ok' : r.reason;
  };
  assert.equal(bad('resize', { height: -1 }, 'frame'), 'resize: height is a whole number from 0 to 20000');
  assert.equal(bad('resize', { height: 1.5 }, 'frame'), 'resize: height is a whole number from 0 to 20000');
  assert.equal(bad('resize', { height: 99999 }, 'frame'), 'resize: height is a whole number from 0 to 20000');
  assert.equal(bad('resize', { height: 5, extra: 1 }, 'frame'), 'resize: unknown field extra');
  assert.equal(bad('resize', { height: 5 }, 'host'), 'resize is not sent by the host');
  assert.equal(bad('init', {}, 'frame'), 'init is not sent by the frame');
  assert.equal(bad('navigate', { url: 'javascript:alert(1)' }, 'frame'), 'navigate: url is http or https');
  assert.equal(bad('navigate', { url: 'nope' }, 'frame'), 'navigate: url is a web address');
  assert.equal(bad('event', { name: 'Bad Name' }, 'frame'), 'event: name is lower case letters, digits, dot, dash or underscore');
  assert.equal(bad('event', { name: 'x', data: { big: 'y'.repeat(5000) } }, 'frame'), 'event: data is an object under 4 KB');
  assert.equal(bad('init', { prefill: { 'bad key': 1 } }, 'host'), 'init: prefill name "bad key" is not allowed');
  assert.equal(bad('init', { theme: 'neon' }, 'host'), 'init: theme is light, dark or auto');
  assert.equal(bad('close', { reason: 'because' }, 'frame'), 'close: reason is done, cancel or error');
  assert.equal(bad('constructor', {}, 'frame'), 'unknown message type');
  assert.equal(bad('__proto__', {}, 'frame'), 'unknown message type');
  for (const junk of [null, 'str', 42, [], { ns: 'other' }, { ns: 'zthr-embed', v: 2 }, { ns: 'zthr-embed', v: 1, type: 'ready', seq: 0 }, { ns: 'zthr-embed', v: 1, type: 'ready', seq: 1, channel: 'short' }]) assert.equal(parseMessage(junk, 'frame').ok, false);
  const circular: Record<string, unknown> = {};
  circular.me = circular;
  assert.deepEqual(parseMessage(circular, 'frame'), { ok: false, reason: 'not plain data' });
  assert.deepEqual(parseMessage({ ns: 'zthr-embed', v: 1, type: 'event', seq: 1, payload: { name: 'x', data: { a: 'z'.repeat(20000) } } }, 'frame'), { ok: false, reason: 'too large' });
});

test('the handshake: ready, init with a fresh channel, then both ends talk on it', () => {
  const p = pair();
  const ready = p.frame.send('ready', { features: ['resize'] });
  assert.equal(p.toHost[0]!.target, HOST, 'posted to the exact origin, never "*"');
  assert.deepEqual(p.host.receive(p.atHost(ready)).accepted, true);
  const init = p.host.send('init', { locale: 'en' });
  assert.equal(p.toFrame[0]!.target, FRAME);
  assert.ok(init.channel!.length >= 16);
  assert.equal(p.frame.receive(p.atFrame(init)).accepted, true);
  assert.deepEqual([p.host.state, p.frame.state, p.frame.channel === p.host.channel], ['open', 'open', true]);
  const rs = p.frame.send('resize', { height: 480 });
  const got = p.host.receive(p.atHost(rs));
  assert.equal(got.accepted && got.msg.payload.height, 480);
});

test('a message from the wrong origin, the wrong window or before the handshake is ignored', () => {
  const p = opened();
  const msg = p.frame.send('resize', { height: 100 });
  assert.deepEqual(p.host.receive({ origin: 'https://evil.example', source: p.frameWin, data: msg }), { accepted: false, reason: 'wrong origin' });
  assert.deepEqual(p.host.receive({ origin: FRAME, source: { name: 'another iframe on the same origin' }, data: msg }), { accepted: false, reason: 'wrong source window' });
  assert.deepEqual(p.host.receive({ origin: 'null', source: p.frameWin, data: msg }), { accepted: false, reason: 'wrong origin' });
  const fresh = pair();
  const early = { ns: 'zthr-embed', v: 1, type: 'resize', seq: 1, channel: 'chan000000000000000000', payload: { height: 5 } };
  assert.deepEqual(fresh.host.receive(fresh.atHost(early)), { accepted: false, reason: 'the handshake is not done' });
  assert.equal(p.host.refused.length, 3);
});

test('a wrong channel, a replay and an old sequence number are dropped', () => {
  const p = opened();
  const a = p.frame.send('resize', { height: 100 });
  const b = p.frame.send('resize', { height: 200 });
  assert.equal(p.host.receive(p.atHost(b)).accepted, true);
  assert.deepEqual(p.host.receive(p.atHost(a)), { accepted: false, reason: 'replayed or out of order' });
  assert.deepEqual(p.host.receive(p.atHost(b)), { accepted: false, reason: 'replayed or out of order' });
  assert.deepEqual(p.host.receive(p.atHost({ ...b, seq: 99, channel: 'someotherchannel0000' })), { accepted: false, reason: 'wrong channel' });
  assert.deepEqual(p.host.receive(p.atHost({ ...b, seq: 99, channel: undefined })), { accepted: false, reason: 'wrong channel' });
});

test('a frame cannot send host messages and an unready end cannot send frame traffic', () => {
  const p = pair();
  assert.throws(() => p.frame.send('resize', { height: 5 }), /before the handshake/);
  assert.throws(() => p.frame.send('init', {}), /not sent by the frame/);
  const opened1 = opened();
  assert.deepEqual(opened1.frame.receive(opened1.atFrame({ ns: 'zthr-embed', v: 1, type: 'resize', seq: 5, channel: opened1.frame.channel, payload: { height: 1 } })), { accepted: false, reason: 'resize is not sent by the host' });
});

test('a reload starts again: ready re-initialises with a new channel and the old one stops working', () => {
  const p = opened();
  const oldChannel = p.host.channel!;
  const stale = p.frame.send('resize', { height: 100 });
  const ready2 = p.frame.send('ready');
  assert.equal(p.host.receive(p.atHost(ready2)).accepted, true);
  assert.equal(p.host.state, 'connecting');
  assert.deepEqual(p.host.receive(p.atHost(stale)), { accepted: false, reason: 'the handshake is not done' });
  const init2 = p.host.send('init', {});
  assert.notEqual(init2.channel, oldChannel);
});

test('close ends the connection both ways', () => {
  const p = opened();
  const c = p.frame.send('close', { reason: 'done' });
  assert.equal(p.frame.state, 'closed');
  assert.equal(p.host.receive(p.atHost(c)).accepted, true);
  assert.equal(p.host.state, 'closed');
  assert.throws(() => p.host.send('event', { name: 'x' }), /closed/);
  assert.deepEqual(p.host.receive(p.atHost(p.toHost[0]!.m)), { accepted: false, reason: 'connection is closed' });
});

test('resize: clamp, ignore jitter, hold bursts, and stop a loop', () => {
  const r = new ResizeController(400, { min: 100, max: 3000, minIntervalMs: 50, loopLimit: 5 });
  assert.deepEqual(r.report(401, 0), { ignore: 'jitter' });
  assert.deepEqual(r.report(400, 0), { ignore: 'same' });
  assert.deepEqual(r.report(600.4, 0), { apply: 600 });
  assert.deepEqual(r.report(900, 10), { hold: true, retryAt: 50 });
  assert.deepEqual(r.report(900, 60), { apply: 900 });
  assert.deepEqual(r.report(99999, 120), { apply: 3000 });
  assert.deepEqual(r.report(-50, 180), { apply: 100 });
  assert.equal(r.height, 100);
  let t = 240;
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) outcomes.push(JSON.stringify(r.report(200 + i * 100, (t += 60))));
  assert.deepEqual(outcomes.slice(0, 1), ['{"apply":200}']);
  assert.ok(outcomes.includes('{"ignore":"loop suspected"}'), outcomes.join());
  assert.deepEqual(r.report(1500, t + 10), { ignore: 'loop suspected' });
  assert.deepEqual(r.report(1600, t + 1500), { apply: 1600 }, 'resizing resumes after the freeze');
});

test('embeddable routes get frame-ancestors as the allow-list and no X-Frame-Options', () => {
  const h = embeddableHeaders({ hostOrigins: [HOST, 'https://*.partner.net'] });
  assert.ok(h['content-security-policy']!.includes(`frame-ancestors ${HOST} https://*.partner.net;`));
  assert.ok(!h['content-security-policy']!.includes("frame-ancestors 'none'"));
  assert.equal(h['x-frame-options'], undefined);
  assert.equal(h['cross-origin-opener-policy'], 'same-origin-allow-popups');
  assert.equal(h['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(embeddableHeaders({ hostOrigins: [HOST], popup: true })['cross-origin-opener-policy'], 'unsafe-none');
  assert.throws(() => embeddableHeaders({ hostOrigins: [] }), EmbedRefused);
  assert.throws(() => embeddableHeaders({ hostOrigins: ['*'] }), EmbedRefused);
  assert.throws(() => embeddableHeaders({ hostOrigins: ['https://a.com; script-src *'] }), EmbedRefused);
});

test('the host page is told what its policy needs, and the frame cookie is partitioned', () => {
  assert.deepEqual(hostPageNeeds(FRAME, 'inline'), { 'frame-src': FRAME });
  assert.deepEqual(hostPageNeeds(FRAME, 'floating'), { 'frame-src': FRAME, 'script-src': FRAME });
  assert.equal(frameCookie('sid', 'abc123', 3600), '__Host-sid=abc123; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=None; Partitioned');
  assert.throws(() => frameCookie('sid', 'a; Domain=evil.com', 60), EmbedRefused);
  assert.throws(() => frameCookie('s id', 'a', 60), EmbedRefused);
  assert.throws(() => frameCookie('sid', 'a', 0), EmbedRefused);
});

test('the request check keeps top-level loads and unknown referrers away from frame-only routes', () => {
  const hosts = [HOST];
  assert.deepEqual(checkEmbedRequest({ secFetchDest: 'iframe', referer: `${HOST}/p?x=1` }, hosts), { allowed: true });
  assert.deepEqual(checkEmbedRequest({ secFetchDest: 'iframe', referer: 'https://evil.example/' }, hosts), { allowed: false, reason: 'https://evil.example is not an allowed page' });
  assert.deepEqual(checkEmbedRequest({ secFetchDest: 'document' }, hosts, { frameOnly: true }), { allowed: false, reason: 'loaded as a top-level page; only framing is allowed' });
  assert.deepEqual(checkEmbedRequest({ secFetchDest: 'script' }, hosts), { allowed: false, reason: 'loaded as script' });
  assert.deepEqual(checkEmbedRequest({ secFetchDest: 'iframe', secFetchSite: 'same-origin', referer: `${FRAME}/inner` }, hosts), { allowed: true }, 'the frame navigating within itself');
  assert.deepEqual(checkEmbedRequest({ referer: 'garbage' }, hosts), { allowed: false, reason: 'unreadable referrer' });
  assert.deepEqual(checkEmbedRequest({}, hosts), { allowed: true }, 'no referrer: frame-ancestors is the authority');
});
