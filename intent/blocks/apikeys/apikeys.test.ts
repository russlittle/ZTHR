import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiKeys, Rejected, allows, memoryKeys } from './index.ts';

const setup = () => {
  let t = 1000;
  const store = memoryKeys();
  return { k: new ApiKeys(store, { now: () => t }), store, tick: (ms: number) => (t += ms) };
};

test('a key is shown once, kept as a hash, and allows only its scopes', async () => {
  const { k, store } = setup();
  const { key, secret } = await k.issue('ana', 'reporting', ['reports:read']);
  assert.match(secret, /^zk_live_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(await store.list('ana')).includes(secret.slice(`zk_live_${key.id}_`.length)));
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

test('a replacement keeps the expiry the old key had, and a retired or expired key cannot be rotated back to life', async () => {
  const { k, tick } = setup();
  const a = await k.issue('ana', 'ci', ['x'], { ttlMs: 10_000 });
  const b = await k.rotate('ana', a.key.id, 1000);
  assert.equal(b.key.expires, 1000 + 10_000, 'a key made to expire is not replaced by one that never does');
  tick(1001);
  await assert.rejects(k.check(a.secret, 'x'), /was replaced/);
  await assert.rejects(k.rotate('ana', a.key.id, 60_000), Rejected);
  await assert.rejects(k.check(a.secret, 'x'), /was replaced/, 'rotating again must not reopen the overlap');
  tick(10_000);
  await assert.rejects(k.rotate('ana', b.key.id, 60_000), /expired/);
});

test('"<prefix>:*" allows any scope under that prefix and nothing else', async () => {
  const { k } = setup();
  const { secret } = await k.issue('ana', 'files', ['files:*', 'reports:re*']);
  assert.ok(await k.check(secret, 'files:read'));
  assert.ok(await k.check(secret, 'files:share:write'), 'deeper scopes are under the prefix too');
  await assert.rejects(k.check(secret, 'files'), /does not allow files$/, 'the prefix alone is not under itself');
  await assert.rejects(k.check(secret, 'files:'), /does not allow/);
  await assert.rejects(k.check(secret, 'filesystem:read'), /does not allow/, 'a longer word is not under the prefix');
  await assert.rejects(k.check(secret, 'reports:read'), /does not allow/, 'a star not after a colon is literal');
  assert.ok(await k.check(secret, 'reports:re*'));
  assert.equal(allows([':*'], 'x'), false);
});
