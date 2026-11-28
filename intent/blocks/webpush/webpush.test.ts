import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { newKey } from '../crypto/index.ts';
import { generateVapid, checkVapid, sealVapid, openVapid, vapidToken, vapidAuthorization, encryptPayload, decryptPayload, buildRequest, checkEndpoint, SubscriptionStore, PushSender, PushError, retryAfterMs, pushWorkerSnippet, MAX_PLAINTEXT, type Keys, type PushRequest, type PushResponse } from './index.ts';

const ring = () => ({ current: 'k1', keys: { k1: newKey() } });
const browser = () => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  const auth = randomBytes(16);
  return { priv: e.getPrivateKey(), keys: { p256dh: e.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } as Keys, auth };
};
const EP = 'https://push.example.net/wpush/v2/abc';

test('RFC 8291 appendix A example reproduces byte for byte', () => {
  const body = encryptPayload(
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    'When I grow up, I want to be a watermelon',
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), senderPrivate: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
  );
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const plain = decryptPayload(body, Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'), Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'));
  assert.equal(plain.toString(), 'When I grow up, I want to be a watermelon');
});

test('encrypt then decrypt round trip, with padding and binary data', () => {
  const b = browser();
  for (const data of ['', 'hi', 'é'.repeat(500), Buffer.from([0, 2, 0, 0, 255])]) {
    const body = encryptPayload(b.keys, data, { padding: 10 });
    assert.deepEqual(decryptPayload(body, b.priv, b.auth), Buffer.from(data));
  }
  assert.notDeepEqual(encryptPayload(b.keys, 'x'), encryptPayload(b.keys, 'x'));
});

test('tampering, wrong key and wrong auth fail to decrypt', () => {
  const b = browser();
  const other = browser();
  const body = encryptPayload(b.keys, 'secret');
  assert.throws(() => decryptPayload(body, other.priv, b.auth), /authentication/);
  assert.throws(() => decryptPayload(body, b.priv, other.auth), /authentication/);
  const bad = Buffer.from(body);
  bad[bad.length - 20]! ^= 1;
  assert.throws(() => decryptPayload(bad, b.priv, b.auth), PushError);
  assert.throws(() => decryptPayload(body.subarray(0, 30), b.priv, b.auth), /short|key id/);
});

test('payload size limits and bad keys', () => {
  const b = browser();
  assert.doesNotThrow(() => encryptPayload(b.keys, Buffer.alloc(4096 - 17 - 1)));
  assert.throws(() => encryptPayload(b.keys, Buffer.alloc(4096 - 17)), /fit in a record/);
  assert.throws(() => encryptPayload({ ...b.keys, auth: 'AAAA' }, 'x'), /auth secret/);
  assert.throws(() => encryptPayload({ ...b.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') }, 'x'), /curve/);
  assert.throws(() => encryptPayload({ ...b.keys, p256dh: 'AAAA' }, 'x'), /65 byte/);
  const sub = { endpoint: EP, keys: b.keys };
  const v = generateVapid();
  assert.doesNotThrow(() => buildRequest(sub, 'a'.repeat(MAX_PLAINTEXT), v, { subject: 'mailto:ops@ex.com' }, { ttl: 60 }, { recordSize: 4096 }));
  assert.throws(() => buildRequest(sub, 'a'.repeat(MAX_PLAINTEXT + 1), v, { subject: 'mailto:ops@ex.com' }, { ttl: 60 }), /4096/);
});

test('VAPID keys: generate, check, seal at rest', () => {
  const v = generateVapid();
  assert.equal(Buffer.from(v.publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(v.privateKey, 'base64url').length, 32);
  assert.doesNotThrow(() => checkVapid(v));
  assert.throws(() => checkVapid({ ...v, publicKey: generateVapid().publicKey }), /does not match/);
  const r = ring();
  const s = sealVapid(r, v);
  assert.ok(!JSON.stringify(s).includes(v.privateKey));
  assert.deepEqual(openVapid(r, s), v);
  assert.throws(() => openVapid(r, s, 'other-context'));
});

test('VAPID token: claims, audience is the origin, signature verifies, limits', () => {
  const v = generateVapid();
  const t = 1_700_000_000_000;
  const jwt = vapidToken(v, `${EP}?x=1`, { subject: 'mailto:ops@ex.com', now: () => t });
  const [h, p, sig] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.deepEqual(claims, { aud: 'https://push.example.net', exp: 1_700_000_000 + 12 * 3600, sub: 'mailto:ops@ex.com' });
  const pub = Buffer.from(v.publicKey, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(createVerify('SHA256').update(`${h}.${p}`).verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
  assert.throws(() => vapidToken(v, EP, { subject: 'ops@ex.com' }), /subject/);
  assert.throws(() => vapidToken(v, EP, { subject: 'mailto:a@b.c', ttlSeconds: 90_000 }), /24 hours/);
  assert.match(vapidAuthorization(v, EP, { subject: 'https://ex.com/contact' }), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
});

test('request headers: TTL, Urgency, Topic, encoding; empty payload has no body', () => {
  const b = browser();
  const v = generateVapid();
  const req = buildRequest({ endpoint: EP, keys: b.keys }, 'hello', v, { subject: 'mailto:o@ex.com' }, { ttl: 3600, urgency: 'high', topic: 'chat_1-a' });
  assert.equal(req.headers.TTL, '3600');
  assert.equal(req.headers.Urgency, 'high');
  assert.equal(req.headers.Topic, 'chat_1-a');
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(req.headers['Content-Length'], String(req.body.length));
  const empty = buildRequest({ endpoint: EP, keys: b.keys }, null, v, { subject: 'mailto:o@ex.com' }, { ttl: 0 });
  assert.equal(empty.body.length, 0);
  assert.equal(empty.headers['Content-Encoding'], undefined);
  for (const so of [{ ttl: -1 }, { ttl: 1.5 }, { ttl: 1, topic: 'bad topic!' }, { ttl: 1, topic: 'x'.repeat(33) }, { ttl: 1, urgency: 'urgent' as never }])
    assert.throws(() => buildRequest({ endpoint: EP, keys: b.keys }, 'x', v, { subject: 'mailto:o@ex.com' }, so), PushError);
});

test('endpoints must be public https', () => {
  for (const bad of ['http://push.example.net/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://10.1.2.3/a', 'https://192.168.0.5/a', 'https://169.254.169.254/latest', 'https://[::1]/a', 'https://svc.internal/a', 'https://user:pw@push.example.net/a', 'https://intranet/a', 'nonsense'])
    assert.throws(() => checkEndpoint(bad), PushError, bad);
  assert.doesNotThrow(() => checkEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
});

test('store: keys validated, auth sealed at rest, owners, limits', () => {
  const t = 1_000_000;
  const st = new SubscriptionStore({ ring: ring(), now: () => t, maxPerOwner: 2 });
  const b = browser();
  st.add('u1', { endpoint: EP, keys: b.keys });
  assert.deepEqual(st.forOwner('u1')[0]!.keys, b.keys);
  assert.throws(() => st.add('u2', { endpoint: EP, keys: b.keys }), /another owner/);
  assert.throws(() => st.add('u1', { endpoint: 'https://a.example.net/1', keys: { ...b.keys, auth: 'x' } }), /auth/);
  assert.throws(() => st.add('u1', { endpoint: 'https://a.example.net/1', keys: b.keys, expirationTime: t - 1 }), /expired/);
  st.add('u1', { endpoint: 'https://a.example.net/1', keys: b.keys });
  assert.throws(() => st.add('u1', { endpoint: 'https://a.example.net/2', keys: b.keys }), /too many/);
  st.add('u1', { endpoint: EP, keys: b.keys });
  assert.equal(st.size, 2);
});

test('expiry sweep and replace on subscription change', () => {
  let t = 1000;
  const st = new SubscriptionStore({ ring: ring(), now: () => t });
  const b = browser();
  st.add('u', { endpoint: EP, keys: b.keys, expirationTime: 5000 });
  assert.equal(st.forOwner('u').length, 1);
  t = 5000;
  assert.equal(st.forOwner('u').length, 0);
  assert.equal(st.status(EP), 'unknown');
  t = 6000;
  st.add('u', { endpoint: EP, keys: b.keys });
  const b2 = browser();
  st.replace(EP, { endpoint: 'https://push.example.net/new', keys: b2.keys });
  assert.equal(st.status(EP), 'unknown');
  assert.equal(st.forOwner('u')[0]!.endpoint, 'https://push.example.net/new');
  assert.throws(() => st.replace('https://nope.example.net/x', { endpoint: EP, keys: b.keys }), /no such/);
});

test('Retry-After parsing', () => {
  assert.equal(retryAfterMs('120', 0), 120_000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60_000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT', 10_000), 0);
  assert.equal(retryAfterMs('soon', 0), undefined);
  assert.equal(retryAfterMs(undefined, 0), undefined);
});

const harness = (responses: (PushResponse | Error)[], opts: { dropAfterFailures?: number; dropAfterMs?: number } = {}) => {
  let t = 1_000_000;
  const st = new SubscriptionStore({ ring: ring(), now: () => t, ...opts });
  const sent: PushRequest[] = [];
  const sender = new PushSender({
    vapid: generateVapid(), subject: 'mailto:ops@ex.com', store: st, now: () => t,
    transport: async (req) => {
      sent.push(req);
      const r = responses.shift() ?? { status: 201 };
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const b = browser();
  st.add('u', { endpoint: EP, keys: b.keys });
  return { st, sender, sent, sub: { endpoint: EP, keys: b.keys }, adv: (ms: number) => { t += ms; } };
};

test('201 is sent; 410 and 404 remove the subscription', async () => {
  const h = harness([{ status: 201, headers: { location: 'https://push.example.net/m/1' } }, { status: 410 }]);
  const ok = await h.sender.send(h.sub, 'a', { ttl: 60 });
  assert.deepEqual(ok, { kind: 'sent', status: 201, location: 'https://push.example.net/m/1' });
  const gone = await h.sender.send(h.sub, 'a', { ttl: 60 });
  assert.equal(gone.kind, 'gone');
  assert.equal(h.st.status(EP), 'unknown');
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 60 })).kind, 'gone');
  assert.equal(h.sent.length, 2);
  const h2 = harness([{ status: 404 }]);
  assert.equal((await h2.sender.send(h2.sub, 'a', { ttl: 1 })).kind, 'gone');
});

test('429 and 5xx back off, honour Retry-After, skip until due, then recover', async () => {
  const h = harness([{ status: 429, headers: { 'retry-after': '600' } }, { status: 503 }, { status: 201 }]);
  const r1 = await h.sender.send(h.sub, 'a', { ttl: 60 });
  assert.equal(r1.kind, 'retry');
  assert.equal((r1 as { retryAt: number }).retryAt, 1_000_000 + 600_000);
  const skipped = await h.sender.send(h.sub, 'a', { ttl: 60 });
  assert.equal(skipped.kind, 'skipped');
  assert.equal(h.sent.length, 1);
  h.adv(600_000);
  const r2 = await h.sender.send(h.sub, 'a', { ttl: 60 });
  assert.equal(r2.kind, 'retry');
  assert.equal((r2 as { retryAt: number }).retryAt, h.st.info(EP)!.retryAt);
  assert.equal(h.st.info(EP)!.failures, 2);
  h.adv(24 * 3600_000);
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 60 })).kind, 'sent');
  assert.equal(h.st.info(EP)!.failures, 0);
});

test('network errors and timeouts count as failures; repeated failures over time drop the subscription', async () => {
  const h = harness(Array.from({ length: 5 }, () => new Error('ECONNRESET')), { dropAfterFailures: 3, dropAfterMs: 3600_000 });
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 1 })).kind, 'retry');
  h.adv(3600_000);
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 1 })).kind, 'retry');
  h.adv(3600_000);
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 1 })).kind, 'gone');
  assert.equal(h.st.status(EP), 'unknown');
});

test('413 and 400 are not retried; 401 and 403 blame the sender, not the subscription', async () => {
  const h = harness([{ status: 413 }, { status: 400 }, { status: 403 }, { status: 401 }]);
  const a = await h.sender.send(h.sub, 'a', { ttl: 1 });
  assert.equal(a.kind, 'rejected');
  assert.match((a as { reason: string }).reason, /too large/);
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 1 })).kind, 'rejected');
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 1 })).kind, 'vapid');
  assert.equal((await h.sender.send(h.sub, 'a', { ttl: 1 })).kind, 'vapid');
  assert.equal(h.st.vapidFailures, 2);
  assert.equal(h.st.status(EP), 'active');
  assert.equal(h.st.info(EP)!.failures, 0);
});

test('an expired subscription is not sent to and is removed; sendToOwner fans out', async () => {
  const h = harness([]);
  const out = await h.sender.send({ ...h.sub, expirationTime: 999_999 }, 'a', { ttl: 1 });
  assert.deepEqual(out, { kind: 'expired' });
  assert.equal(h.sent.length, 0);
  const h2 = harness([{ status: 201 }]);
  h2.st.add('u', { endpoint: 'https://push.example.net/second', keys: browser().keys });
  const all = await h2.sender.sendToOwner('u', 'hi', { ttl: 5 });
  assert.equal(all.length, 2);
  assert.ok(all.every((x) => x.outcome.kind === 'sent'));
  assert.equal(h2.sent[0]!.headers.Authorization!.startsWith('vapid t='), true);
});

test('the transport sees the encrypted body only and the request decrypts at the browser', async () => {
  const b = browser();
  let seen: PushRequest | undefined;
  const st = new SubscriptionStore({ ring: ring() });
  st.add('u', { endpoint: EP, keys: b.keys });
  const sender = new PushSender({ vapid: generateVapid(), subject: 'mailto:ops@ex.com', store: st, transport: async (r) => { seen = r; return { status: 201 }; } });
  await sender.send({ endpoint: EP, keys: b.keys }, JSON.stringify({ title: 'Hi' }), { ttl: 30 });
  assert.ok(!seen!.body.toString('latin1').includes('Hi'));
  assert.equal(JSON.parse(decryptPayload(seen!.body, b.priv, b.auth).toString()).title, 'Hi');
});

test('worker snippet is valid JavaScript', () => {
  const js = pushWorkerSnippet({ defaultTitle: 'App "x"', resubscribeUrl: '/push/resubscribe' });
  assert.doesNotThrow(() => new Function('self', js));
  assert.ok(js.includes('pushsubscriptionchange'));
});
