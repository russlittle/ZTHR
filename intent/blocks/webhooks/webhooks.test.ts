import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Inbound, Outbound, Unverified, signature } from './index.ts';

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
