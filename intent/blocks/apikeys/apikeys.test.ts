import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const rejectedWith = (m: string) => (e: unknown) => e instanceof Rejected && e.message === m;

test('the stored hash is the SHA-256 of the whole secret, as hex, and each person lists only their own keys', async () => {
  const { k, store } = setup();
  const { key, secret } = await k.issue('ana', 'one', ['x']);
  assert.equal(key.hash, createHash('sha256').update(secret).digest('hex'));
  assert.equal((await store.byId(key.id))?.hash, key.hash);
  await k.issue('ben', 'two', ['x']);
  assert.deepEqual((await store.list('ana')).map((x) => x.name), ['one']);
  assert.deepEqual((await k.list('ben')).map((x) => x.name), ['two']);
});

test('a key that is well formed but unknown, or has the wrong secret, is not recognised', async () => {
  const { k } = setup();
  const { key, secret } = await k.issue('ana', 'one', ['x']);
  await assert.rejects(k.check(`zk_live_${'0'.repeat(12)}_abc`, 'x'), rejectedWith('that key is not recognised'));
  await assert.rejects(k.check(`zk_live_${key.id}_wrong`, 'x'), rejectedWith('that key is not recognised'));
  assert.equal((await k.check(secret, 'x')).id, key.id);
});

test('a prefix with punctuation in it is matched literally', async () => {
  const store = memoryKeys();
  const k = new ApiKeys(store, { prefix: 'zk.live+_', now: () => 1000 });
  const { key, secret } = await k.issue('ana', 'one', ['x']);
  assert.equal((await k.check(secret, 'x')).id, key.id);
  await assert.rejects(k.check(secret.replace('zk.live+_', 'zkXlive+_'), 'x'), /not an API key/);
  await assert.rejects(k.check(secret.replace('zk.live+_', 'zklive_'), 'x'), /not an API key/);
});

test('"<prefix>:*" needs something after the colon, and the lone ":*" allows nothing', () => {
  assert.equal(allows([':*'], ':x'), false);
  assert.equal(allows([':*'], ':'), false);
  assert.equal(allows(['files:*'], 'files:r'), true, 'one character after the colon is enough');
  assert.equal(allows(['files:*'], 'files:re'), true);
  assert.equal(allows(['files:*'], 'files:'), false);
});

test('a key retired by rotation stops working at the very instant its overlap ends', async () => {
  const { k, tick } = setup();
  const a = await k.issue('ana', 'sync', ['x']);
  await k.rotate('ana', a.key.id, 5000);
  tick(4999);
  assert.ok(await k.check(a.secret, 'x'));
  tick(1);
  await assert.rejects(k.check(a.secret, 'x'), rejectedWith('that key was replaced; use the new one'));
});

test('last use is recorded on first use and then at most once a minute', async () => {
  const { k, store, tick } = setup();
  const { key, secret } = await k.issue('ana', 'one', ['x']);
  const lastUsed = async () => (await store.byId(key.id))?.lastUsed;
  assert.equal(await lastUsed(), undefined);
  await k.check(secret, 'x');
  assert.equal(await lastUsed(), 1000, 'recorded on first use');
  tick(10_000);
  await k.check(secret, 'x');
  assert.equal(await lastUsed(), 1000, 'not rewritten within the minute');
  tick(50_000);
  await k.check(secret, 'x');
  assert.equal(await lastUsed(), 1000, 'exactly a minute later is still within it');
  tick(1);
  await k.check(secret, 'x');
  assert.equal(await lastUsed(), 61_001, 'after the minute it is recorded again');
});

test('only a key of yours that is live can be rotated, and a key is replaced once', async () => {
  const { k, tick } = setup();
  const a = await k.issue('ana', 'one', ['x']);
  const none = rejectedWith('no such key of yours');
  await assert.rejects(k.rotate('ana', 'ffffffffffff', 1000), none);
  await assert.rejects(k.rotate('ben', a.key.id, 1000), none);
  assert.equal((await k.list('ana'))[0]!.replacedBy, undefined, 'ben could not replace ana\'s key');
  const r = await k.issue('ana', 'revoked', ['x']);
  await k.revoke('ana', r.key.id);
  await assert.rejects(k.rotate('ana', r.key.id, 1000), none);
  await k.rotate('ana', a.key.id, 1000);
  await assert.rejects(k.rotate('ana', a.key.id, 1000), rejectedWith('that key was already replaced; rotate the new one'));
  const e = await k.issue('ana', 'short', ['x'], { ttlMs: 500 });
  tick(500);
  await assert.rejects(k.rotate('ana', e.key.id, 1000), rejectedWith('that key has expired; issue a new one'));
});

test('the list says which keys are active: not revoked, not expired, not past their overlap', async () => {
  const { k, tick } = setup();
  const plain = await k.issue('ana', 'plain', ['x']);
  const a = await k.issue('ana', 'timed', ['x'], { ttlMs: 20_000 });
  const b = await k.rotate('ana', a.key.id, 5000);
  const active = async () => Object.fromEntries((await k.list('ana')).map((x) => [x.id, x.active]));
  assert.deepEqual(await active(), { [plain.key.id]: true, [a.key.id]: true, [b.key.id]: true }, 'during the overlap both are active');
  tick(4999);
  assert.equal((await active())[a.key.id], true);
  tick(1);
  assert.deepEqual(await active(), { [plain.key.id]: true, [a.key.id]: false, [b.key.id]: true }, 'at the end of the overlap the old one is not');
  tick(15_000);
  assert.deepEqual(await active(), { [plain.key.id]: true, [a.key.id]: false, [b.key.id]: false }, 'at its expiry a key is not active');
});
