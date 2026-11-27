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
  assert.equal(out.replay(ep.id), 1);
  await out.flush();
  assert.equal(d!.state, 'delivered');
});
