import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadToken, Unopenable, equal, needsReseal, newKey, open, randomId, reseal, seal, sign, verify } from './index.ts';

test('sealed values open with the ring, only in the place they were sealed for', () => {
  const ring = { current: 'k1', keys: { k1: newKey() } };
  const s = seal(ring, 'DOB 1990-01-01', 'students.dob.7');
  assert.ok(!s.includes('1990'));
  assert.notEqual(seal(ring, 'x'), seal(ring, 'x'), 'a fresh nonce every time');
  assert.equal(open(ring, s, 'students.dob.7'), 'DOB 1990-01-01');
  assert.throws(() => open(ring, s, 'students.dob.8'), Unopenable, 'copied to another record, it does not open');
  const parts = s.split('.');
  parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('A') ? 'B' : 'A') + parts[3]!.slice(-1);
  assert.throws(() => open(ring, parts.join('.'), 'students.dob.7'), Unopenable, 'any change is detected');
});

test('keys rotate: new data under the new key, old data still opens, and re-sealing moves it over', () => {
  const k1 = newKey();
  const old = { current: 'k1', keys: { k1 } };
  const s = seal(old, 'secret');
  const ring = { current: 'k2', keys: { k1, k2: newKey() } };
  assert.equal(open(ring, s), 'secret');
  assert.equal(needsReseal(ring, s), true);
  const s2 = reseal(ring, s);
  assert.equal(needsReseal(ring, s2), false);
  assert.throws(() => open({ current: 'k2', keys: { k2: ring.keys.k2 } }, s), /key k1 is not in the ring/);
});

test('signed tokens carry a purpose and an expiry, and a rotated secret still verifies old tokens', () => {
  const t = sign('s1', 'reset-password', { user: 'ana' }, 60_000, 1000);
  assert.deepEqual(verify('s1', 'reset-password', t, 2000), { user: 'ana' });
  assert.throws(() => verify('s1', 'confirm-email', t, 2000), /for something else/);
  assert.throws(() => verify('s1', 'reset-password', t, 70_000), /expired/);
  assert.throws(() => verify('s2', 'reset-password', t, 2000), BadToken);
  assert.deepEqual(verify(['s2', 's1'], 'reset-password', t, 2000), { user: 'ana' });
  const [body, mac] = t.split('.');
  const forged = Buffer.from(Buffer.from(body!, 'base64url').toString().replace('ana', 'eve')).toString('base64url');
  assert.throws(() => verify('s1', 'reset-password', `${forged}.${mac}`, 2000), /not issued here/);
});

test('constant-time equality and random ids', () => {
  assert.ok(equal('abc', 'abc'));
  assert.ok(!equal('abc', 'abd'));
  assert.ok(!equal('abc', 'abcd'));
  assert.match(randomId(), /^[A-Za-z0-9_-]{22}$/);
});
