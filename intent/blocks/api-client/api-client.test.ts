import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient, ApiError, BreakerOpen, EgressDenied, MockApi, PaginationLoop, RateLimited, ResponseTooLarge, parseLinkHeader, parseRateLimit, pick, type Auth, type ClientOptions, type Transport } from './index.ts';
import { TimedOut } from '../resilience/index.ts';

const BASE = 'https://api.example.com/v1/';
const ITEMS = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));

function env(o: Partial<ClientOptions> & { transport: Transport }) {
  const clock = { t: Date.UTC(2026, 2, 1) };
  const sleeps: number[] = [];
  const client = new ApiClient({ baseUrl: BASE, now: () => clock.t, sleep: async (ms) => void (sleeps.push(ms), (clock.t += ms)), random: () => 0.5, ...o });
  return { client, clock, sleeps };
}
const ids = async (g: AsyncGenerator<unknown>) => {
  const out: number[] = [];
  for await (const x of g) out.push((x as { id: number }).id);
  return out;
};
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('rate limit headers in every common dialect', () => {
  const now = Date.UTC(2026, 2, 1);
  const h = (o: Record<string, string>) => new Headers(o);
  assert.deepEqual(parseRateLimit(h({ 'retry-after': '120' }), now), { retryAfterMs: 120_000 });
  assert.deepEqual(parseRateLimit(h({ 'retry-after': new Date(now + 30_000).toUTCString() }), now), { retryAfterMs: 30_000 });
  assert.deepEqual(parseRateLimit(h({ 'retry-after': new Date(now - 30_000).toUTCString() }), now), { retryAfterMs: 0 });
  assert.deepEqual(parseRateLimit(h({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(now / 1000 + 60) }), now), { limit: 5000, remaining: 4999, resetAt: now + 60_000 });
  assert.deepEqual(parseRateLimit(h({ 'ratelimit-limit': '100', 'ratelimit-remaining': '0', 'ratelimit-reset': '30' }), now), { limit: 100, remaining: 0, resetAt: now + 30_000 });
  assert.deepEqual(parseRateLimit(h({ ratelimit: 'limit=10, remaining=3, reset=7' }), now), { limit: 10, remaining: 3, resetAt: now + 7000 });
  assert.deepEqual(parseRateLimit(h({ 'retry-after': 'soon', 'x-ratelimit-remaining': 'lots' }), now), {});
});

test('Link headers: relations, quoting, several relations on one link, and junk', () => {
  assert.deepEqual(parseLinkHeader('<https://a/?p=2>; rel="next", <https://a/?p=9>; rel="last"'), { next: 'https://a/?p=2', last: 'https://a/?p=9' });
  assert.deepEqual(parseLinkHeader('<https://a/1>; rel=prev; title="x,y", <https://a/3>; rel="next last"'), { prev: 'https://a/1', next: 'https://a/3', last: 'https://a/3' });
  assert.deepEqual(parseLinkHeader(null), {});
  assert.deepEqual(parseLinkHeader('garbage'), {});
  assert.equal(pick({ a: { b: [1] } }, 'a.b')?.toString(), '1');
  assert.equal(pick({}, 'constructor'), undefined);
  assert.equal(pick({ a: 1 }, 'a.b'), undefined);
});

test('auth styles put the credential in the right place', async () => {
  const cases: [Auth, (h: Record<string, string>, u: URL) => unknown, unknown][] = [
    [{ type: 'bearer', token: 'tok123' }, (h) => h.authorization, 'Bearer tok123'],
    [{ type: 'bearer', token: async () => 'fresh' }, (h) => h.authorization, 'Bearer fresh'],
    [{ type: 'basic', user: 'ana', pass: 'pw' }, (h) => h.authorization, `Basic ${Buffer.from('ana:pw').toString('base64')}`],
    [{ type: 'header', name: 'X-Api-Key', value: 'k1' }, (h) => h['x-api-key'], 'k1'],
    [{ type: 'query', name: 'api_key', value: 'k2' }, (_h, u) => u.searchParams.get('api_key'), 'k2'],
    [{ type: 'none' }, (h) => h.authorization, undefined],
  ];
  for (const [auth, pickIt, want] of cases) {
    const mock = new MockApi({ items: ITEMS, style: 'cursor' });
    const { client } = env({ transport: mock.transport, auth });
    await client.get('items');
    const seen = mock.seen[0]!;
    assert.equal(pickIt(seen.headers, new URL(seen.url)), want, auth.type);
  }
});

test('errors never contain the secret, in the body or the URL', async () => {
  const t: Transport = async () => reply(400, { echo: 'you sent key=sekret-key-value and tok-abcdef' });
  const q = env({ transport: t, auth: { type: 'query', name: 'api_key', value: 'sekret-key-value' } });
  await assert.rejects(q.client.get('items'), (e: ApiError) => {
    assert.equal(e.status, 400);
    assert.ok(!e.url.includes('sekret-key-value') && e.url.includes('api_key=%5Bredacted%5D'), e.url);
    assert.ok(!e.body.includes('sekret-key-value') && e.body.includes('[redacted]'));
    return true;
  });
  const b = env({ transport: t, auth: { type: 'bearer', token: 'tok-abcdef' } });
  await assert.rejects(b.client.get('items'), (e: ApiError) => !e.body.includes('tok-abcdef'));
});

test('OAuth client credentials: one token for many calls, a new one after expiry, and again after a 401', async () => {
  const mock = new MockApi({ items: ITEMS, style: 'cursor', oauth: { path: '/oauth/token', clientId: 'cid', clientSecret: 'csecret', expiresIn: 3600 } });
  const { client, clock } = env({ transport: mock.transport, auth: { type: 'oauth2', tokenUrl: 'https://api.example.com/oauth/token', clientId: 'cid', clientSecret: 'csecret', scope: 'read' } });
  await client.get('items');
  await client.get('items');
  assert.equal(mock.issued.length, 1, 'one token for both calls');
  const tokenCall = mock.seen[0]!;
  assert.equal(tokenCall.body, 'grant_type=client_credentials&scope=read');
  assert.equal(tokenCall.headers.authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
  clock.t += 3600_000 - 20_000;
  await client.get('items');
  assert.equal(mock.issued.length, 2, 'refreshed 30 seconds before it expires');
  mock.issued.push('revoked-elsewhere');
  const r = await client.get('items');
  assert.equal(r.status, 200, 'a 401 triggers one new token and a retry');
  assert.equal(mock.issued.length, 4);
  const bad = env({ transport: mock.transport, auth: { type: 'oauth2', tokenUrl: 'https://api.example.com/oauth/token', clientId: 'cid', clientSecret: 'wrong-secret', } });
  await assert.rejects(bad.client.get('items'), (e: ApiError) => /token server answered 401/.test(e.message) && !e.body.includes('wrong-secret'));
});

test('every pagination style reads the whole listing, once each', async () => {
  const specs: [Parameters<ApiClient['paginate']>[0], 'offset' | 'page' | 'cursor' | 'link' | 'next-url'][] = [
    [{ style: 'offset', pageSize: 10, totalPath: 'total', itemsPath: 'items' }, 'offset'],
    [{ style: 'page', pageSize: 10, totalPagesPath: 'total_pages', itemsPath: 'items' }, 'page'],
    [{ style: 'cursor', pageSize: 10, itemsPath: 'items' }, 'cursor'],
    [{ style: 'link', itemsPath: 'items' }, 'link'],
    [{ style: 'next-url', itemsPath: 'items' }, 'next-url'],
  ];
  for (const [spec, style] of specs) {
    const mock = new MockApi({ items: ITEMS, style, pageSize: 10 });
    const { client } = env({ transport: mock.transport });
    assert.deepEqual(await ids(client.paginate(spec, { path: 'items' })), ITEMS.map((i) => i.id), style);
    assert.equal(mock.seen.length, 3, `${style}: three pages`);
  }
  const exact = new MockApi({ items: ITEMS.slice(0, 20), style: 'offset', pageSize: 10 });
  const e = env({ transport: exact.transport });
  assert.equal((await ids(e.client.paginate({ style: 'offset', pageSize: 10, totalPath: 'total', itemsPath: 'items' }, { path: 'items' }))).length, 20);
  assert.equal(exact.seen.length, 2, 'the total says there is nothing more, so no empty page is fetched');
  const none = new MockApi({ items: [], style: 'cursor' });
  assert.deepEqual(await ids(env({ transport: none.transport }).client.paginate({ style: 'cursor', itemsPath: 'items' }, { path: 'items' })), []);
});

test('a listing resumes from its checkpoint, and can be capped', async () => {
  const mock = new MockApi({ items: ITEMS, style: 'cursor', pageSize: 10 });
  const { client } = env({ transport: mock.transport });
  const spec = { style: 'cursor', itemsPath: 'items' } as const;
  let saved: unknown;
  const all: number[] = [];
  await assert.rejects(
    (async () => {
      for await (const it of client.paginate(spec, { path: 'items' }, { maxPages: 1, onPage: (s) => (saved = s) })) all.push((it as { id: number }).id);
    })(),
    /stopped after 1 pages/,
  );
  assert.deepEqual(all, ITEMS.slice(0, 10).map((i) => i.id));
  const rest = await ids(client.paginate(spec, { path: 'items' }, { resume: saved as never }));
  assert.deepEqual(rest, ITEMS.slice(10).map((i) => i.id), 'it carries on from the cursor, not from the start');
  const capped = await ids(client.paginate(spec, { path: 'items' }, { maxItems: 12 }));
  assert.equal(capped.length, 12);
});

test('a cursor or link that comes back is a loop, and a next page on another host is never followed', async () => {
  const loopCursor: Transport = async () => reply(200, { items: [{ id: 1 }], next_cursor: 'same' });
  await assert.rejects(ids(env({ transport: loopCursor }).client.paginate({ style: 'cursor', itemsPath: 'items' }, { path: 'items' })), PaginationLoop);
  const loopLink: Transport = async (url) => reply(200, { items: [{ id: 1 }] }, { link: `<${url}>; rel="next"` });
  await assert.rejects(ids(env({ transport: loopLink }).client.paginate({ style: 'link', itemsPath: 'items' }, { path: 'items' })), PaginationLoop);
  const seenAuth: (string | undefined)[] = [];
  const evil: Transport = async (url, init) => {
    seenAuth.push((init.headers as Record<string, string>).authorization);
    return reply(200, { items: [{ id: 1 }] }, { link: '<https://evil.example/steal>; rel="next"' });
  };
  await assert.rejects(ids(env({ transport: evil, auth: { type: 'bearer', token: 'tok-secret' } }).client.paginate({ style: 'link', itemsPath: 'items' }, { path: 'items' })), (e: Error) => e instanceof EgressDenied && /evil.example/.test(e.message));
  assert.equal(seenAuth.length, 1, 'the credential went only to the first page');
  await assert.rejects(ids(env({ transport: async () => reply(200, { rows: [] }) }).client.paginate({ style: 'cursor', itemsPath: 'items' }, { path: 'items' })), /expected a list at items/);
});

test('when the budget is spent the client waits for the window, then goes on', async () => {
  const clock = { t: Date.UTC(2026, 2, 1) };
  const mock = new MockApi({ items: ITEMS, style: 'cursor', rateLimit: { limit: 2, windowMs: 10_000 }, now: () => clock.t });
  const sleeps: number[] = [];
  const client = new ApiClient({ baseUrl: BASE, transport: mock.transport, now: () => clock.t, sleep: async (ms) => void (sleeps.push(ms), (clock.t += ms)), random: () => 0.5 });
  const r1 = await client.get('items');
  assert.equal(r1.rateLimit.remaining, 1);
  await client.get('items');
  assert.deepEqual(sleeps, [], 'no waiting while there is budget');
  const r3 = await client.get('items');
  assert.equal(r3.status, 200);
  assert.equal(sleeps.length, 1, 'it waited rather than being refused');
  assert.ok(sleeps[0]! > 0 && sleeps[0]! <= 10_000);
  assert.equal(mock.seen.filter((s) => s.method === 'GET').length, 3, 'no request was wasted on a 429');
});

test('429 and 503 with Retry-After are waited out, and a wait that is too long raises RateLimited', async () => {
  let n = 0;
  const t: Transport = async () => (++n < 3 ? reply(429, { e: 1 }, { 'retry-after': '7' }) : reply(200, { ok: true }));
  const { client, sleeps } = env({ transport: t });
  assert.equal((await client.get('x')).attempts, 3);
  assert.deepEqual(sleeps, [7000, 7000]);
  n = 0;
  const t2: Transport = async () => reply(503, {}, { 'retry-after': '120' });
  await assert.rejects(env({ transport: t2, maxWaitMs: 30_000 }).client.get('x'), (e: RateLimited) => e instanceof RateLimited && /wait 120s/.test(e.message));
  const t3: Transport = async () => reply(429, {}, { 'retry-after': '1' });
  await assert.rejects(env({ transport: t3, retry: { attempts: 2, baseMs: 10, maxMs: 10 } }).client.get('x'), RateLimited);
});

test('retries: safe methods on 5xx with jittered backoff; POST only with an idempotency key; client errors never', async () => {
  const mk = (failures: number, status = 503) => {
    let n = 0;
    const seen: { method: string; key: string | undefined }[] = [];
    const t: Transport = async (_u, init) => {
      seen.push({ method: init.method!, key: (init.headers as Record<string, string>)['idempotency-key'] });
      return ++n <= failures ? reply(status, { e: 1 }) : reply(200, { ok: true });
    };
    return { t, seen };
  };
  const a = mk(2);
  const e1 = env({ transport: a.t, retry: { attempts: 4, baseMs: 100, maxMs: 1000 } });
  const r = await e1.client.get('x');
  assert.equal(r.attempts, 3);
  assert.deepEqual(e1.sleeps, [50, 100], 'random 0.5 of 100 then 200');
  const b = mk(1);
  await assert.rejects(env({ transport: b.t }).client.post('x', { a: 1 }), (e: ApiError) => e.status === 503);
  assert.equal(b.seen.length, 1, 'a POST is not repeated: the first might have worked');
  const c = mk(1);
  const rc = await env({ transport: c.t }).client.post('x', { a: 1 }, 'key-123');
  assert.equal(rc.attempts, 2);
  assert.deepEqual(c.seen.map((s) => s.key), ['key-123', 'key-123'], 'the same key both times');
  const d = mk(5, 404);
  await assert.rejects(env({ transport: d.t }).client.get('x'), (e: ApiError) => e.status === 404);
  assert.equal(d.seen.length, 1);
  const f = mk(9);
  await assert.rejects(env({ transport: f.t, retry: { attempts: 3, baseMs: 1, maxMs: 1 }, breaker: false }).client.get('x'), (e: ApiError) => e.status === 503);
  assert.equal(f.seen.length, 3, 'attempts are bounded');
});

test('network failures are retried for safe requests and reported plainly otherwise', async () => {
  let n = 0;
  const flaky: Transport = async () => {
    if (++n < 3) throw new TypeError('fetch failed');
    return reply(200, {});
  };
  assert.equal((await env({ transport: flaky }).client.get('x')).attempts, 3);
  n = 0;
  await assert.rejects(env({ transport: flaky }).client.post('x', {}), (e: ApiError) => /could not reach api.example.com: fetch failed/.test(e.message));
});

test('timeouts: a slow answer is cut off and counts as a failure', async () => {
  const slow: Transport = (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
  await assert.rejects(env({ transport: slow, timeoutMs: 20, retry: { attempts: 1, baseMs: 1, maxMs: 1 } }).client.get('x'), TimedOut);
});

test('a breaker per host stops calls while a service is down', async () => {
  let calls = 0;
  const down: Transport = async () => (calls++, reply(500, {}));
  const { client, clock } = env({ transport: down, retry: { attempts: 1, baseMs: 1, maxMs: 1 }, breaker: { threshold: 3, coolDownMs: 30_000 } });
  for (let i = 0; i < 3; i++) await assert.rejects(client.get('x'), (e: ApiError) => e.status === 500);
  await assert.rejects(client.get('x'), BreakerOpen);
  assert.equal(calls, 3, 'the fourth call never left');
  clock.t += 31_000;
  await assert.rejects(client.get('x'), (e: ApiError) => e.status === 500);
  assert.equal(calls, 4, 'after the cool-down one trial goes through');
});

test('egress: http, internal addresses, other hosts and URL credentials are refused', async () => {
  const t: Transport = async () => reply(200, {});
  for (const base of ['http://api.example.com/', 'https://localhost/', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://169.254.169.254/latest/', 'https://[::1]/', 'https://metadata.google.internal/', 'https://user:pw@api.example.com/', 'ftp://api.example.com/']) assert.throws(() => new ApiClient({ baseUrl: base, transport: t }), EgressDenied, base);
  const { client } = env({ transport: t });
  await Promise.all([
    assert.rejects(client.get('https://evil.example/x'), (e: Error) => e instanceof EgressDenied && /not an allowed host/.test(e.message)),
    assert.rejects(client.get('https://169.254.169.254/'), EgressDenied),
    env({ transport: t, allowHosts: ['cdn.example.net'] }).client.get('https://cdn.example.net/file').then((r) => assert.equal(r.status, 200)),
    new ApiClient({ baseUrl: 'http://localhost:8080/', transport: t, allowInsecure: true }).get('x').then((r) => assert.equal(r.status, 200)),
  ]);
});

test('redirects are followed by hand: credentials stay on the host, internal targets are refused, loops end', async () => {
  const seen: { url: string; auth: string | undefined }[] = [];
  const t: Transport = async (url, init) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
    if (url.endsWith('/old')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/file' } });
    if (url.endsWith('/same')) return new Response(null, { status: 301, headers: { location: '/v1/new' } });
    if (url.endsWith('/metadata')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    if (url.endsWith('/loop')) return new Response(null, { status: 302, headers: { location: 'loop' } });
    return reply(200, { ok: true });
  };
  const e = env({ transport: t, auth: { type: 'bearer', token: 'tok-secret' }, allowHosts: ['cdn.example.net'] });
  await e.client.get('old');
  assert.deepEqual(seen.map((s) => [new URL(s.url).host, s.auth]), [['api.example.com', 'Bearer tok-secret'], ['cdn.example.net', undefined]], 'the CDN never saw the token');
  seen.length = 0;
  await e.client.get('same');
  assert.deepEqual(seen.map((s) => s.auth), ['Bearer tok-secret', 'Bearer tok-secret']);
  await assert.rejects(e.client.get('metadata'), EgressDenied);
  await assert.rejects(e.client.get('loop'), /too many redirects/);
});

test('response size is capped by the header and by what actually arrives', async () => {
  const announced: Transport = async () => reply(200, 'x', { 'content-length': '999999' });
  await assert.rejects(env({ transport: announced, maxResponseBytes: 1000 }).client.get('x'), ResponseTooLarge);
  const streamed: Transport = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(400)); } }), { status: 200 });
  await assert.rejects(env({ transport: streamed, maxResponseBytes: 1000 }).client.get('x'), /sent more than the limit of 1000/);
  const ok = await env({ transport: async () => reply(200, { a: 1 }), maxResponseBytes: 1000 }).client.get('x');
  assert.deepEqual(ok.json, { a: 1 });
});

test('JSON bodies are parsed, bad JSON is an error, and POST sends JSON with the right type', async () => {
  const seen: { body: string; type: string | undefined }[] = [];
  const t: Transport = async (_u, init) => {
    seen.push({ body: init.body as string, type: (init.headers as Record<string, string>)['content-type'] });
    return reply(200, '{not json');
  };
  await assert.rejects(env({ transport: t }).client.post('x', { a: [1, 2] }), (e: ApiError) => /not valid JSON/.test(e.message));
  assert.deepEqual(seen[0], { body: '{"a":[1,2]}', type: 'application/json' });
  const empty = await env({ transport: async () => new Response(null, { status: 204 }) }).client.request({ method: 'DELETE', path: 'x/1' });
  assert.deepEqual([empty.status, empty.json, empty.text], [204, undefined, '']);
  const text = await env({ transport: async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }) }).client.get('x');
  assert.deepEqual([text.text, text.json], ['hello', undefined]);
});

test('the mock twin fails for a while, then recovers, and records what it saw', async () => {
  const mock = new MockApi({ items: ITEMS, style: 'cursor', failFirst: { count: 2, status: 502 } });
  const { client } = env({ transport: mock.transport });
  const r = await client.get('items', { q: 'a b', skip: undefined });
  assert.equal(r.attempts, 3);
  assert.equal(mock.seen.length, 3);
  assert.equal(new URL(mock.seen[2]!.url).searchParams.get('q'), 'a b');
  assert.equal(new URL(mock.seen[2]!.url).searchParams.has('skip'), false);
  assert.match(mock.seen[0]!.headers['user-agent']!, /zthr-api-client/);
});
