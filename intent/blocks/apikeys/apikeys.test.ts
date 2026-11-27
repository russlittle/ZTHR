import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiKeys, Rejected, memoryKeys } from './index.ts';

const setup = () => {
  let t = 1000;
  const store = memoryKeys();
  return { k: new ApiKeys(store, { now: () => t }), store, tick: (ms: number) => (t += ms) };
};

test('a key is shown once, kept as a hash, and allows only its scopes', async () => {
  const { k, store } = setup();
  const { key, secret } = await k.issue('ana', 'reporting', ['reports:read']);
  assert.match(secret, /^zk_live_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(await store.list('ana')).includes(secret.split('_').pop()!));
  assert.equal((await k.check(secret, 'reports:read')).id, key.id);
  await assert.rejects(k.check(secret, 'reports:write'), /does not allow reports:write/);
  await assert.rejects(k.check(`${secret}x`, 'reports:read'), Rejected);
  await assert.rejects(k.check('zk_test_000000000000_abc', 'reports:read'), /not an API key/);
  await assert.rejects(k.issue('ana', 'none', []), /at least one scope/);
});

test('rotation overlaps, then the old key stops; revoked and expired keys stop at once', async () => {
  const { k, tick } = setup();
  const a = await k.issue('ana', 'sync', ['files:*', '*']);
  const b = await k.rotate('ana', a.key.id, 5000);
  assert.ok(await k.check(a.secret, 'x'), 'the old key works during the overlap');
  assert.ok(await k.check(b.secret, 'x'));
  tick(5001);
  await assert.rejects(k.check(a.secret, 'x'), /was replaced/);
  await k.revoke('ana', b.key.id);
  await assert.rejects(k.check(b.secret, 'x'), /revoked/);
  const c = await k.issue('ana', 'temp', ['x'], { ttlMs: 100 });
  tick(100);
  await assert.rejects(k.check(c.secret, 'x'), /expired/);
  assert.deepEqual((await k.list('ana')).map((x) => x.active), [false, false, false]);
  await assert.rejects(k.revoke('ben', c.key.id), /no such key of yours/);
});
