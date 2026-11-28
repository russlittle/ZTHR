import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EgressRefused, EgressTwin, allowed, door, routedEgress } from './index.ts';

const allow = {
  'api.weather.example': { purposes: ['weather.forecast'] },
  '*.hooks.example': { purposes: ['webhook.deliver'], methods: ['POST'] },
  'files.example': { purposes: ['*'], ports: [8443] },
};
const PUBLIC = async () => ['93.184.216.34'];

function mk(handler: (url: string, init: RequestInit) => Response | Promise<Response>, extra: Record<string, unknown> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let t = 1000;
  const egress = door({
    allow,
    resolve: PUBLIC,
    now: () => (t += 5),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
    ...extra,
  });
  return { egress, calls };
}

test('a call to an allowed host for its declared purpose goes through and is recorded without query values', async () => {
  const { egress, calls } = mk(() => new Response('{"temp":21}', { status: 200 }));
  const r = await egress.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/v1/f?city=Dayton&apikey=hunter2' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { temp: 21 });
  assert.equal(calls.length, 1);
  assert.equal(egress.records.length, 1);
  const rec = egress.records[0]!;
  assert.equal(rec.outcome, 'sent');
  assert.equal(rec.host, 'api.weather.example');
  assert.equal(rec.path, '/v1/f');
  assert.deepEqual(rec.query, ['city', 'apikey']);
  assert.equal(rec.bytes, 11);
  assert.equal(JSON.stringify(rec).includes('hunter2'), false);
});

test('a host not on the list, or a purpose not declared for it, is refused and recorded as refused', async () => {
  const { egress, calls } = mk(() => new Response('x'));
  await assert.rejects(egress.request({ purpose: 'weather.forecast', url: 'https://evil.example/x' }), /not on the allow-list/);
  await assert.rejects(egress.request({ purpose: 'webhook.deliver', url: 'https://api.weather.example/x' }), /not allowed for webhook.deliver/);
  assert.equal(calls.length, 0, 'nothing left the machine');
  assert.deepEqual(egress.records.map((r) => r.outcome), ['refused', 'refused']);
  assert.match(egress.records[0]!.reason!, /allow-list/);
});

test('http, embedded credentials, bad ports and unnamed purposes are refused', async () => {
  const { egress } = mk(() => new Response('x'));
  await assert.rejects(egress.request({ purpose: 'weather.forecast', url: 'http://api.weather.example/' }), /only https/);
  await assert.rejects(egress.request({ purpose: 'weather.forecast', url: 'https://u:p@api.weather.example/' }), /credentials in the address/);
  await assert.rejects(egress.request({ purpose: 'weather.forecast', url: 'https://api.weather.example:8443/' }), /port 8443/);
  await assert.rejects(egress.request({ purpose: '', url: 'https://api.weather.example/' }), /name its purpose/);
  await assert.rejects(egress.request({ purpose: 'weather.forecast', url: 'not a url' }), /not a valid address/);
  const ok = await egress.request({ purpose: 'anything', url: 'https://files.example:8443/a' });
  assert.equal(ok.status, 200, 'a declared port and a wildcard purpose pass');
});

test('wildcards match names below the zone and never the zone itself or a look-alike', () => {
  assert.equal(allowed('*.hooks.example', 'a.hooks.example'), true);
  assert.equal(allowed('*.hooks.example', 'a.b.hooks.example'), true);
  assert.equal(allowed('*.hooks.example', 'hooks.example'), false);
  assert.equal(allowed('*.hooks.example', 'evilhooks.example'), false);
  assert.equal(allowed('*.hooks.example', 'a.hooks.example.evil.test'), false);
  assert.equal(allowed('API.Weather.example.', 'api.weather.example'), true);
});

test('methods are limited per host', async () => {
  const { egress } = mk(() => new Response(null, { status: 204 }));
  await assert.rejects(egress.request({ purpose: 'webhook.deliver', url: 'https://x.hooks.example/in', method: 'GET' }), /GET is not allowed/);
  const r = await egress.request({ purpose: 'webhook.deliver', url: 'https://x.hooks.example/in', method: 'post', body: '{}' });
  assert.equal(r.status, 204);
});

test('internal addresses are refused even when named by an allowed wildcard that resolves inside', async () => {
  const { egress, calls } = mk(() => new Response('x'), { resolve: async () => ['10.0.0.5'] });
  await assert.rejects(egress.request({ purpose: 'webhook.deliver', method: 'POST', url: 'https://a.hooks.example/in' }), /resolves to the internal address 10.0.0.5/);
  assert.equal(calls.length, 0);
  const mapped = mk(() => new Response('x'), { resolve: async () => ['::ffff:169.254.169.254'] });
  await assert.rejects(mapped.egress.request({ purpose: 'webhook.deliver', method: 'POST', url: 'https://a.hooks.example/in' }), /internal address/);
});

test('IP literals and internal names are refused unless declared internal', async () => {
  const e1 = door({ allow: { '127.0.0.1': { purposes: ['*'] }, 'localhost': { purposes: ['*'] }, 'db': { purposes: ['*'] } }, fetch: async () => new Response('x'), resolve: PUBLIC });
  await assert.rejects(e1.request({ purpose: 'p', url: 'https://127.0.0.1/' }), /internal address/);
  await assert.rejects(e1.request({ purpose: 'p', url: 'https://localhost/' }), /internal name/);
  await assert.rejects(e1.request({ purpose: 'p', url: 'https://db/' }), /internal name/);
  const e2 = door({ allow: { '127.0.0.1': { purposes: ['*'], internal: true } }, fetch: async () => new Response('side'), resolve: PUBLIC });
  assert.equal((await e2.request({ purpose: 'p', url: 'https://127.0.0.1/' })).text(), 'side');
});

test('a redirect is followed only to an allowed host, with the same checks, and secrets are not carried across hosts', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const e = door({
    allow: { 'api.weather.example': { purposes: ['weather.forecast'] }, 'cdn.weather.example': { purposes: ['weather.forecast'] } },
    resolve: PUBLIC,
    fetch: async (url, init) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      if (url.startsWith('https://api.weather.example/a')) return new Response(null, { status: 302, headers: { location: 'https://cdn.weather.example/b' } });
      if (url.startsWith('https://api.weather.example/evil')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/c' } });
      return new Response('done');
    },
  });
  const r = await e.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/a', headers: { Authorization: 'Bearer x', Accept: 'text/plain' } });
  assert.equal(r.text(), 'done');
  assert.equal(r.url, 'https://cdn.weather.example/b');
  assert.equal(seen[1]!.headers['Authorization'], undefined, 'authorization is dropped on another host');
  assert.equal(seen[1]!.headers['Accept'], 'text/plain');
  assert.equal(e.records[0]!.redirects, 1);
  await assert.rejects(e.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/evil' }), /evil.example is not on the allow-list/);
});

test('redirect loops stop at the limit', async () => {
  const e = door({ allow, resolve: PUBLIC, maxRedirects: 2, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://api.weather.example/again' } }) });
  await assert.rejects(e.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/' }), /more than 2 redirects/);
});

test('a POST redirected with 303 becomes a GET without a body', async () => {
  const seen: { m: unknown; b: unknown }[] = [];
  const e = door({
    allow: { 'files.example': { purposes: ['*'] } },
    resolve: PUBLIC,
    fetch: async (url, init) => {
      seen.push({ m: init.method, b: init.body });
      return url.endsWith('/a') ? new Response(null, { status: 303, headers: { location: '/b' } }) : new Response('ok');
    },
  });
  await e.request({ purpose: 'p', url: 'https://files.example/a', method: 'POST', body: 'data' });
  assert.deepEqual(seen, [{ m: 'POST', b: 'data' }, { m: 'GET', b: undefined }]);
});

test('responses over the byte cap are refused, declared or streamed', async () => {
  const declared = mk(() => new Response('x', { headers: { 'content-length': '999999' } }));
  await assert.rejects(declared.egress.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/', maxBytes: 1000 }), /999999 bytes is over the 1000/);
  const streamed = mk(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(600)); c.enqueue(new Uint8Array(600)); c.close(); } })));
  await assert.rejects(streamed.egress.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/', maxBytes: 1000 }), /over the 1000 byte limit/);
  assert.equal(streamed.egress.records[0]!.outcome, 'refused');
});

test('a call that outlives its deadline is aborted and recorded as failed', async () => {
  const { egress } = mk((_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  await assert.rejects(egress.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/', timeoutMs: 20 }), /no answer within 20 ms/);
  assert.equal(egress.records[0]!.outcome, 'failed');
  assert.equal(egress.records[0]!.reason, 'no answer within 20 ms');
});

test('a transport error is recorded and thrown as a plain failure, not a refusal', async () => {
  const { egress } = mk(() => { throw new Error('ECONNRESET'); });
  const err = await egress.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/' }).catch((e) => e);
  assert.equal(err instanceof EgressRefused, false);
  assert.match(err.message, /ECONNRESET/);
  assert.equal(egress.records[0]!.outcome, 'failed');
});

test('records are bounded and handed to a listener', async () => {
  const heard: string[] = [];
  const { egress } = mk(() => new Response('x'), { keepRecords: 2, onRecord: (r: { path: string }) => heard.push(r.path) });
  for (const p of ['/1', '/2', '/3']) await egress.request({ purpose: 'weather.forecast', url: `https://api.weather.example${p}` });
  assert.deepEqual(egress.records.map((r) => r.path), ['/2', '/3']);
  assert.deepEqual(heard, ['/1', '/2', '/3']);
});

test('routed egress runs a service in-process behind the same door', async () => {
  const e = routedEgress({ 'campus.example': { purposes: ['campus.lookup'] } }, { 'campus.example': async (req) => new Response(JSON.stringify({ path: new URL(req.url).pathname }), { status: 200 }) });
  const r = await e.request({ purpose: 'campus.lookup', url: 'https://campus.example/rooms' });
  assert.deepEqual(r.json(), { path: '/rooms' });
  await assert.rejects(e.request({ purpose: 'other', url: 'https://campus.example/rooms' }), /not allowed for other/);
});

test('the twin records what would have been sent and answers from canned replies', async () => {
  const twin = new EgressTwin({ 'api.weather.example': { purposes: ['weather.forecast'] } });
  twin.reply('GET', 'https://api.weather.example/v1/f', 200, '{"ok":true}', { 'content-type': 'application/json' });
  const r = await twin.egress.request({ purpose: 'weather.forecast', url: 'https://api.weather.example/v1/f' });
  assert.equal(r.headers['content-type'], 'application/json');
  assert.deepEqual(r.json(), { ok: true });
  assert.equal(twin.calls.length, 1);
  assert.equal(twin.calls[0]!.method, 'GET');
  await assert.rejects(twin.egress.request({ purpose: 'weather.forecast', url: 'https://nope.example/' }), EgressRefused);
  assert.equal(twin.calls.length, 1, 'refused calls never reach the twin');
});
