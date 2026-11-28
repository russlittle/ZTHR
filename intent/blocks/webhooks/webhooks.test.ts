import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { Inbound, Outbound, Unverified, internalAddress, signature } from './index.ts';

test('an inbound webhook is believed only signed, recent and not seen before', () => {
  let t = 1_800_000_000_000;
  const body = '{"type":"payment.succeeded"}';
  const sec = Math.floor(t / 1000);
  const inb = new Inbound(['new-secret', 'old-secret'], { now: () => t });
  inb.verify(body, signature('old-secret', body, sec), 'evt-1');
  assert.throws(() => inb.verify(body, signature('old-secret', body, sec), 'evt-1'), /already received/, 'a replay is refused');
  assert.throws(() => inb.verify(`${body} `, signature('new-secret', body, sec), 'evt-2'), /does not match/, 'one changed byte breaks it');
  assert.throws(() => inb.verify(body, signature('wrong', body, sec), 'evt-3'), Unverified);
  assert.throws(() => inb.verify(body, undefined, 'evt-4'), /no signature/);
  t += 301_000;
  assert.throws(() => inb.verify(body, signature('new-secret', body, sec), 'evt-5'), /too old/);
});

test('outbound: signed, retried with backoff, parked with the last answer, and replayed after a fix', async () => {
  let t = 0;
  let status = 500;
  const got: { sig: string; body: string }[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const h = init!.headers as Record<string, string>;
    got.push({ sig: h['webhook-signature']!, body: String(init!.body) });
    return new Response(status === 204 ? null : '', { status });
  }) as unknown as typeof fetch;
  const paused: string[] = [];
  const out = new Outbound({ fetch: f, now: () => t, maxAttempts: 3, baseMs: 100, pauseAfter: 3, onPaused: (e) => paused.push(e.id) });
  assert.throws(() => out.subscribe('ana', 'http://insecure.example', ['*'], 's'), /https/);
  const ep = out.subscribe('ana', 'https://hooks.example.org/in', ['file.created'], 'shh');
  out.subscribe('ana', 'https://other.example.org/in', ['file.deleted'], 'x');
  const [d] = out.emit('file.created', { id: 7 });
  assert.equal(out.deliveries.length, 1, 'only subscribed endpoints get it');
  await out.flush();
  const { sig, body } = got[0]!;
  new Inbound(['shh'], { now: () => t }).verify(body, sig, 'x');
  assert.equal(d!.next, 100);
  t = 100;
  await out.flush();
  assert.equal(d!.next, 300);
  t = 300;
  await out.flush();
  assert.equal(d!.state, 'parked');
  assert.equal(d!.lastError, 'answered 500');
  assert.deepEqual(paused, [ep.id], 'its owner is told it was paused');
  assert.equal(out.emit('file.created', {}).length, 0, 'a paused endpoint gets nothing new');
  status = 204;
  assert.equal(out.replay(ep.id), 2, 'the parked delivery, and the event emitted while paused');
  await out.flush();
  assert.equal(d!.state, 'delivered');
});

test('a captured request replayed under a fresh delivery id is still a replay', () => {
  const t = 1_800_000_000_000;
  const body = '{"type":"payment.succeeded"}';
  const sig = signature('s', body, Math.floor(t / 1000));
  const inb = new Inbound(['s'], { now: () => t });
  inb.verify(body, sig, 'evt-1');
  assert.throws(() => inb.verify(body, sig, 'evt-forged'), /already received/, 'the id is not signed, so it cannot be what makes a request new');
});

test('two flushes at once send each due delivery once', async () => {
  let calls = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const f = (async () => {
    calls++;
    await gate;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const out = new Outbound({ fetch: f, now: () => 0 });
  out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  out.emit('a', {});
  out.emit('b', {});
  const one = out.flush();
  const two = out.flush();
  release();
  await Promise.all([one, two]);
  assert.equal(calls, 2, 'two deliveries, two requests');
  assert.ok(out.deliveries.every((d) => d.state === 'delivered' && d.attempts === 1));
});

test('an endpoint must be public: loopback, private, link-local and metadata addresses are refused unless allowed', () => {
  const out = new Outbound({ fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch, resolve: async () => ['93.184.216.34'] });
  for (const url of [
    'https://localhost/in',
    'https://api.localhost/in',
    'https://LOCALHOST./in',
    'https://127.0.0.1/in',
    'https://0x7f.1/in',
    'https://2130706433/in',
    'https://10.1.2.3/in',
    'https://172.20.0.1/in',
    'https://192.168.1.1/in',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://[::1]/in',
    'https://[fe80::1]/in',
    'https://[fd00::1]/in',
    'https://[::ffff:127.0.0.1]/in',
    'https://[::ffff:169.254.169.254]/in',
    'https://0.0.0.0/in',
  ])
    assert.throws(() => out.subscribe('ana', url, ['*'], 's'), /must be public/, url);
  out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  out.subscribe('ana', 'https://172.15.0.1/in', ['*'], 's');
  const dev = new Outbound({ allowHosts: ['localhost', '10.0.0.5'] });
  dev.subscribe('ana', 'https://localhost:8443/in', ['*'], 's');
  dev.subscribe('ana', 'https://10.0.0.5/in', ['*'], 's');
});

test('a name that resolves to an internal address at send time is refused (DNS rebinding)', async () => {
  let addr = '93.184.216.34';
  const sent: string[] = [];
  const f = (async (url: string) => (sent.push(url), new Response(null, { status: 204 }))) as unknown as typeof fetch;
  const out = new Outbound({ fetch: f, now: () => 0, resolve: async () => [addr] });
  out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  const [a] = out.emit('a', {});
  await out.flush();
  assert.equal(a!.state, 'delivered');
  addr = '169.254.169.254';
  const [b] = out.emit('b', {});
  await out.flush();
  assert.equal(sent.length, 1, 'nothing was sent to the internal address');
  assert.equal(b!.state, 'pending');
  assert.match(b!.lastError!, /resolves to the internal address 169\.254\.169\.254/);
  const allowed = new Outbound({ fetch: f, now: () => 0, resolve: async () => ['10.0.0.5'], allowHosts: ['hooks.internal.example'] });
  allowed.subscribe('ana', 'https://hooks.internal.example/in', ['*'], 's');
  const [c] = allowed.emit('c', {});
  await allowed.flush();
  assert.equal(c!.state, 'delivered', 'an allowed host is sent to wherever it resolves');
});

test('a handler that fails does not spend the delivery id, so the sender retry is received; one that succeeds does', async () => {
  const t = 1_800_000_000_000;
  const body = '{"type":"payment.succeeded"}';
  const sig = signature('s', body, Math.floor(t / 1000));
  const inb = new Inbound(['s'], { now: () => t });
  await assert.rejects(
    inb.receive(body, sig, 'evt-1', async () => {
      throw new Error('database down');
    }),
    /database down/,
  );
  let handled = 0;
  assert.equal(await inb.receive(body, sig, 'evt-1', async () => ++handled), 1, 'the retry is received');
  await assert.rejects(inb.receive(body, sig, 'evt-1', async () => ++handled), /already received/);
  assert.equal(handled, 1);
  const body2 = '{"type":"refund"}';
  const sig2 = signature('s', body2, Math.floor(t / 1000));
  const r = inb.begin(body2, sig2, 'evt-2');
  assert.throws(() => inb.begin(body2, sig2, 'evt-2'), /being received/, 'a duplicate during handling is refused');
  r.release();
  inb.begin(body2, sig2, 'evt-2').accept();
  assert.throws(() => inb.verify(body2, sig2, 'evt-2'), /already received/);
});

test('events emitted while an endpoint is paused are parked and delivered by the replay', async () => {
  let status = 500;
  const bodies: string[] = [];
  const f = (async (_u: string, init?: RequestInit) => (bodies.push(String(init!.body)), new Response(null, { status }))) as unknown as typeof fetch;
  const out = new Outbound({ fetch: f, now: () => 0, maxAttempts: 1, pauseAfter: 1 });
  const ep = out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  out.emit('first', {});
  await out.flush();
  assert.ok(ep.paused);
  assert.equal(out.emit('while-paused', { n: 1 }).length, 0, 'nothing is sent to a paused endpoint');
  const parked = out.deliveries.find((d) => d.type === 'while-paused')!;
  assert.equal(parked.state, 'parked');
  status = 204;
  assert.equal(out.replay(ep.id), 2);
  await out.flush();
  assert.equal(parked.state, 'delivered');
  assert.ok(bodies.some((b) => b.includes('"while-paused"')));
});

const NOW = 1_800_000_000_000;
const SEC = NOW / 1000;
const stub = (status: number | ((url: string) => number) = 204) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status: typeof status === 'function' ? status(url) : status, body: null };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

test('a signature must be the whole header: nothing before it and nothing after it', () => {
  const body = '{}';
  const sig = signature('s', body, SEC);
  const inb = new Inbound(['s'], { now: () => NOW });
  assert.throws(() => inb.verify(body, `junk ${sig}`, 'a'), /no signature/);
  assert.throws(() => inb.verify(body, `${sig} junk`, 'b'), /no signature/);
  assert.throws(() => inb.verify(body, `${sig}0`, 'c'), /no signature/);
  assert.throws(() => inb.verify(body, '', 'd'), /no signature/);
  inb.verify(body, sig, 'e');
});

test('a signature is current within the tolerance either side, to the second, and not beyond', () => {
  const body = '{}';
  const inb = new Inbound(['s'], { now: () => NOW });
  inb.verify(body, signature('s', body, SEC - 300), 'past-edge');
  inb.verify(body, signature('s', body, SEC + 300), 'future-edge');
  assert.throws(() => inb.verify(body, signature('s', body, SEC - 301), 'past'), /too old or from the future/);
  assert.throws(() => inb.verify(body, signature('s', body, SEC + 301), 'future'), /too old or from the future/);
  const tight = new Inbound(['s'], { now: () => NOW, toleranceSec: 10 });
  tight.verify(body, signature('s', body, SEC - 10), 'a');
  assert.throws(() => tight.verify(body, signature('s', body, SEC - 11), 'b'), /too old/);
});

test('a request without a delivery id is refused, with the reason', () => {
  const body = '{}';
  const sig = signature('s', body, SEC);
  const inb = new Inbound(['s'], { now: () => NOW });
  assert.throws(() => inb.verify(body, sig, undefined), { message: 'the request carries no delivery id' });
  assert.throws(() => inb.verify(body, sig, ''), { message: 'the request carries no delivery id' });
  inb.verify(body, sig, 'ok');
});

test('different deliveries do not shadow each other, and a hold blocks the id or the signed request alone', () => {
  const inb = new Inbound(['s'], { now: () => NOW });
  const a = '{"a":1}';
  const b = '{"b":2}';
  inb.verify(a, signature('s', a, SEC), 'one');
  inb.verify(b, signature('s', b, SEC), 'two');
  assert.throws(() => inb.verify(b, signature('s', b, SEC), 'three'), /already received/, 'same signed request, new id');
  assert.throws(() => inb.verify('{"c":3}', signature('s', '{"c":3}', SEC), 'one'), /already received/, 'same id, new request');
  const c = '{"c":3}';
  const sigC = signature('s', c, SEC);
  const held = inb.begin(c, sigC, 'held');
  assert.throws(() => inb.begin('{"d":4}', signature('s', '{"d":4}', SEC), 'held'), /being received/, 'same id while held');
  assert.throws(() => inb.begin(c, sigC, 'other-id'), /being received/, 'same signed request while held');
  held.release();
  inb.begin(c, sigC, 'held').accept();
});

test('a receipt acts once: a release after an accept or an accept after a release changes nothing', () => {
  const inb = new Inbound(['s'], { now: () => NOW });
  const body = '{}';
  const sig = signature('s', body, SEC);
  const r = inb.begin(body, sig, 'evt');
  r.release();
  r.accept();
  const again = inb.begin(body, sig, 'evt');
  again.accept();
  again.release();
  assert.throws(() => inb.begin(body, sig, 'evt'), /already received/, 'once accepted it stays spent');
});

test('a hold that is never finished, and a spent id, lapse after twice the tolerance', () => {
  let t = NOW;
  const inb = new Inbound(['s'], { now: () => t });
  const at = (offset: number, body: string) => signature('s', body, SEC + offset);
  inb.begin('h0', at(0, 'h0'), 'evt-held');
  inb.verify('s0', at(0, 's0'), 'evt-spent');
  t = NOW + 150_000;
  assert.throws(() => inb.begin('h1', at(150, 'h1'), 'evt-held'), /being received/);
  assert.throws(() => inb.begin('s1', at(150, 's1'), 'evt-spent'), /already received/);
  t = NOW + 600_000;
  assert.throws(() => inb.begin('h2', at(600, 'h2'), 'evt-held'), /being received/, 'exactly twice the tolerance is not yet lapsed');
  assert.throws(() => inb.begin('s2', at(600, 's2'), 'evt-spent'), /already received/);
  t = NOW + 601_000;
  inb.begin('h3', at(601, 'h3'), 'evt-held').release();
  inb.begin('s3', at(601, 's3'), 'evt-spent').release();
});

test('an old request signed at the edge of the window is still a replay at the end of its window', () => {
  let t = NOW;
  const inb = new Inbound(['s'], { now: () => t });
  const sig = signature('s', 'x', SEC + 300);
  inb.verify('x', sig, 'evt-1');
  t = NOW + 600_000;
  assert.throws(() => inb.verify('x', sig, 'evt-2'), /already received/);
});

test('names that mean the machine itself or the metadata service are refused, and only those', () => {
  const out = new Outbound({ fetch: stub().fetch, resolve: async () => ['93.184.216.34'] });
  for (const host of ['localhost', 'a.b.localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal', 'METADATA'])
    assert.throws(() => out.subscribe('ana', `https://${host}/in`, ['*'], 's'), /must be public: .* is an internal address/, host);
  for (const host of ['mymetadata', 'xlocalhost', 'localhost.example.com', 'metadata.example.com', 'instance-data.example.com', 'notinstance-data', 'localhostx.org'])
    out.subscribe('ana', `https://${host}/in`, ['*'], 's');
});

test('an address is internal or not, with or without IPv6 brackets, and anything else is not an address', () => {
  assert.equal(internalAddress('127.0.0.1'), true);
  assert.equal(internalAddress('::1'), true);
  assert.equal(internalAddress('[::1]'), true);
  assert.equal(internalAddress('[::ffff:10.0.0.1]'), true);
  assert.equal(internalAddress('93.184.216.34'), false);
  assert.equal(internalAddress('[2606:2800:220:1::1]'), false);
  assert.equal(internalAddress('example.com'), false);
  assert.equal(internalAddress(''), false);
  assert.equal(internalAddress('::1['), false);
  assert.equal(internalAddress('[::]1'), false);
  assert.equal(internalAddress('[[::1]'), false);
});

test('allowed hosts are matched as written without brackets or a trailing dot, and nothing else', () => {
  const sub = (allowHosts: string[], url: string) => new Outbound({ fetch: stub().fetch, resolve: async () => ['93.184.216.34'], allowHosts }).subscribe('ana', url, ['*'], 's');
  sub(['[::1]'], 'https://[::1]/in');
  sub(['localhost.'], 'https://localhost/in');
  sub(['LOCALHOST'], 'https://localhost/in');
  assert.throws(() => sub(['loc[alhost'], 'https://localhost/in'), /must be public/);
  assert.throws(() => sub(['loc]alhost'], 'https://localhost/in'), /must be public/);
  assert.throws(() => sub(['other'], 'https://localhost/in'), /must be public/);
});

test('what is emitted carries its own id, type, time and data, and a paused endpoint parks it with the reason', async () => {
  const { calls, fetch } = stub(500);
  const out = new Outbound({ fetch, now: () => NOW, pauseAfter: 1, maxAttempts: 1 });
  const ep = out.subscribe('ana', 'https://hooks.example.org/in', ['file.created'], 's');
  const [d] = out.emit('file.created', { id: 7 });
  const sent = JSON.parse(d!.body);
  assert.equal(sent.type, 'file.created');
  assert.deepEqual(sent.data, { id: 7 });
  assert.equal(sent.created, new Date(NOW).toISOString());
  assert.match(sent.id, /^[0-9a-f-]{36}$/);
  await out.flush();
  assert.equal(calls.length, 1);
  assert.equal(ep.paused, 'paused after 1 failed deliveries in a row');
  out.emit('file.created', {});
  const parked = out.deliveries.at(-1)!;
  assert.equal(parked.state, 'parked');
  assert.equal(parked.lastError, 'paused after 1 failed deliveries in a row');
  assert.equal(parked.next, NOW);
});

test('a send is a signed JSON POST that is never redirected, with the delivery id and a timestamp in seconds', async () => {
  const { calls, fetch } = stub(204);
  const out = new Outbound({ fetch, now: () => NOW });
  out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 'shh');
  const [d] = out.emit('a', { n: 1 });
  await out.flush();
  const { url, init } = calls[0]!;
  const h = init.headers as Record<string, string>;
  assert.equal(url, 'https://hooks.example.org/in');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.body, d!.body);
  assert.ok(init.signal);
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['user-agent'], 'zthr-webhooks/1');
  assert.equal(h['webhook-id'], d!.id);
  assert.equal(h['webhook-signature'], signature('shh', d!.body, SEC));
  assert.match(h['webhook-signature']!, new RegExp(`^t=${SEC},`));
});

test('only answers from 200 up to but not including 300 are acknowledgements', async () => {
  for (const [status, delivered] of [[100, false], [199, false], [200, true], [204, true], [299, true], [300, false], [301, false], [404, false]] as const) {
    const out = new Outbound({ fetch: stub(status).fetch, now: () => NOW, resolve: async () => ['93.184.216.34'] });
    out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
    const [d] = out.emit('a', {});
    await out.flush();
    assert.equal(d!.state === 'delivered', delivered, String(status));
    assert.equal(d!.lastStatus, status);
    if (!delivered) assert.equal(d!.lastError, `answered ${status}`);
  }
});

test('a send that throws is a failure with the reason, an Error or not', async () => {
  for (const [thrown, text] of [[new Error('connection reset'), 'connection reset'], ['plain text', 'plain text'], [42, '42']] as const) {
    const out = new Outbound({
      fetch: (async () => {
        throw thrown;
      }) as unknown as typeof fetch,
      now: () => NOW,
      resolve: async () => ['93.184.216.34'],
    });
    const ep = out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
    const [d] = out.emit('a', {});
    await out.flush();
    assert.equal(d!.lastError, text);
    assert.equal(d!.state, 'pending');
    assert.equal(d!.attempts, 1);
    assert.equal(ep.failuresInARow, 1);
  }
});

test('an endpoint is paused after its failures even when nobody asked to be told', async () => {
  const out = new Outbound({ fetch: stub(500).fetch, now: () => NOW, pauseAfter: 2 });
  const ep = out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  out.emit('a', {});
  await out.flush();
  assert.equal(ep.paused, undefined);
  assert.equal(ep.failuresInARow, 1);
  const told: string[] = [];
  const out2 = new Outbound({ fetch: stub(500).fetch, now: () => NOW, pauseAfter: 1, onPaused: (e) => told.push(e.id) });
  const ep2 = out2.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  out2.emit('a', {});
  await out2.flush();
  assert.deepEqual(told, [ep2.id]);
  const out3 = new Outbound({ fetch: stub(500).fetch, now: () => NOW, pauseAfter: 1 });
  const ep3 = out3.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  out3.emit('a', {});
  await out3.flush();
  assert.equal(ep3.paused, 'paused after 1 failed deliveries in a row');
});

test('flush sends only what is pending and due, and says how many', async () => {
  let t = NOW;
  const s = stub(500);
  const out = new Outbound({ fetch: s.fetch, now: () => t, baseMs: 1000, maxAttempts: 2, pauseAfter: 100 });
  out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  out.subscribe('ana', 'https://hooks.example.org/in2', ['*'], 's');
  out.emit('a', {});
  assert.equal(await out.flush(), 2);
  assert.equal(s.calls.length, 2);
  assert.equal(await out.flush(), 0, 'backing off: not due yet');
  assert.equal(s.calls.length, 2);
  t += 999;
  assert.equal(await out.flush(), 0, 'still not due');
  t += 1;
  assert.equal(await out.flush(), 2, 'due at exactly its time');
  assert.ok(out.deliveries.every((d) => d.state === 'parked' && d.attempts === 2));
  t += 10 ** 9;
  assert.equal(await out.flush(), 0, 'parked deliveries are not sent');
  assert.equal(s.calls.length, 4);
  const ok = new Outbound({ fetch: stub(204).fetch, now: () => t });
  ok.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  ok.emit('a', {});
  assert.equal(await ok.flush(), 1);
  assert.equal(await ok.flush(), 0, 'delivered deliveries are not sent again');
  const later = new Outbound({ fetch: stub(204).fetch, now: () => t });
  later.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  later.emit('a', {});
  later.deliveries[0]!.next = t + 5;
  assert.equal(await later.flush(), 0, 'not yet due');
  assert.equal(later.deliveries[0]!.attempts, 0);
});

test('a delivery can be sent again as soon as its attempt is over, even while others are still in flight', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (url.endsWith('/slow')) {
      await gate;
      return { status: 204, body: null };
    }
    return { status: 500, body: null };
  }) as unknown as typeof fetch;
  const out = new Outbound({ fetch: f, now: () => NOW, baseMs: 0, pauseAfter: 100, resolve: async () => ['93.184.216.34'] });
  out.subscribe('ana', 'https://hooks.example.org/fast', ['a'], 's');
  out.subscribe('ana', 'https://hooks.example.org/slow', ['a'], 's');
  out.emit('a', {});
  const first = out.flush();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const second = out.flush();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([first, second]);
  assert.equal(urls.filter((u) => u.endsWith('/fast')).length, 2, 'the finished delivery was due again and was sent');
  assert.equal(urls.filter((u) => u.endsWith('/slow')).length, 1, 'the one still in flight was not sent twice');
});

test('if telling the owner fails, the deliveries not yet sent are still free to be sent next time', async () => {
  const s = stub(500);
  const out = new Outbound({
    fetch: s.fetch,
    now: () => NOW,
    pauseAfter: 1,
    onPaused: () => {
      throw new Error('owner unreachable');
    },
  });
  out.subscribe('ana', 'https://hooks.example.org/first', ['a'], 's');
  out.subscribe('ana', 'https://hooks.example.org/second', ['a'], 's');
  out.emit('a', {});
  await assert.rejects(out.flush(), /owner unreachable/);
  assert.equal(s.calls.length, 1);
  await assert.rejects(out.flush(), /owner unreachable/, 'the second endpoint now fails and pauses too');
  assert.equal(s.calls.length, 2, 'the delivery that never got its turn was sent next time');
});

test('a delivery whose endpoint is gone, or paused while it waited, is not sent', async () => {
  const s = stub(500);
  const out = new Outbound({ fetch: s.fetch, now: () => NOW, pauseAfter: 1 });
  const gone = out.subscribe('ana', 'https://hooks.example.org/gone', ['a'], 's');
  out.emit('a', {});
  out.endpoints.delete(gone.id);
  assert.equal(await out.flush(), 1);
  assert.equal(s.calls.length, 0);
  assert.equal(out.deliveries[0]!.attempts, 0);
  const o2 = new Outbound({ fetch: s.fetch, now: () => NOW, pauseAfter: 1 });
  o2.subscribe('ana', 'https://hooks.example.org/in', ['a'], 's');
  o2.emit('a', { n: 1 });
  o2.emit('a', { n: 2 });
  await o2.flush();
  assert.equal(s.calls.length, 1, 'the first failure paused the endpoint, so the second was not sent');
  assert.equal(o2.deliveries[1]!.attempts, 0);
});

test('an endpoint stored with an internal address is refused at send time, without sending', async () => {
  const s = stub(204);
  const out = new Outbound({ fetch: s.fetch, now: () => NOW, resolve: async () => ['93.184.216.34'] });
  out.endpoints.set('e1', { id: 'e1', owner: 'ana', url: 'https://127.0.0.1/in', secret: 's', types: ['*'], failuresInARow: 0 });
  out.emit('a', {});
  await out.flush();
  assert.equal(s.calls.length, 0);
  assert.equal(out.deliveries[0]!.lastError, 'refused: 127.0.0.1 is an internal address');
});

test('a name that resolves to nothing is refused, and a resolved public address is sent to', async () => {
  const s = stub(204);
  let answer: string[] = [];
  const out = new Outbound({ fetch: s.fetch, now: () => NOW, resolve: async () => answer });
  out.subscribe('ana', 'https://hooks.example.org/in', ['*'], 's');
  const [a] = out.emit('a', {});
  await out.flush();
  assert.equal(s.calls.length, 0);
  assert.equal(a!.lastError, 'refused: hooks.example.org did not resolve');
  answer = ['93.184.216.34', '2606:2800:220:1::1'];
  const [b] = out.emit('b', {});
  await out.flush();
  assert.equal(b!.state, 'delivered');
});

test('replaying an endpoint restarts its parked and pending deliveries only, and leaves everything else alone', async () => {
  let t = NOW;
  const out = new Outbound({ fetch: stub(204).fetch, now: () => t });
  const one = out.subscribe('ana', 'https://hooks.example.org/one', ['*'], 's');
  const two = out.subscribe('ana', 'https://hooks.example.org/two', ['*'], 's');
  out.emit('a', {});
  const [p1, p2] = out.deliveries.filter((d) => d.endpoint === one.id).concat(out.emit('b', {}).filter((d) => d.endpoint === one.id));
  const other = out.deliveries.find((d) => d.endpoint === two.id)!;
  const delivered = out.deliveries.at(-1)!;
  void p2;
  p1!.state = 'parked';
  p1!.attempts = 5;
  const pending = out.deliveries.find((d) => d.endpoint === one.id && d !== p1 && d.type === 'b')!;
  pending.attempts = 3;
  pending.next = t + 10_000;
  const done = { ...delivered, id: 'done', endpoint: one.id, state: 'delivered' as const, attempts: 2, next: 7 };
  out.deliveries.push(done);
  other.state = 'parked';
  other.attempts = 4;
  other.next = 9;
  t += 50;
  assert.equal(out.replay(one.id), 2);
  assert.deepEqual([p1!.state, p1!.attempts, p1!.next], ['pending', 0, t]);
  assert.deepEqual([pending.state, pending.attempts, pending.next], ['pending', 0, t]);
  assert.deepEqual([done.state, done.attempts, done.next], ['delivered', 2, 7]);
  assert.deepEqual([other.state, other.attempts, other.next], ['parked', 4, 9]);
  assert.equal(out.replay('no-such-endpoint'), 0);
});

test('the system resolver is used for a name, and a name that lands on this machine is refused', async () => {
  const name = hostname().toLowerCase();
  const found = await lookup(name, { all: true }).catch(() => []);
  const internal = found.filter((a) => internalAddress(a.address));
  const real = globalThis.fetch;
  const s = stub(204);
  globalThis.fetch = s.fetch;
  try {
    const out = new Outbound({ now: () => NOW });
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(name) || internal.length === 0 || internal.length !== found.length) return;
    out.subscribe('ana', `https://${name}/in`, ['*'], 's');
    const [d] = out.emit('a', {});
    await out.flush();
    assert.equal(s.calls.length, 0);
    assert.match(d!.lastError!, new RegExp(`^refused: ${name.replace(/\./g, '\\.')} resolves to the internal address `));
  } finally {
    globalThis.fetch = real;
  }
});
