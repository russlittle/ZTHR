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

test('a sealed value whose tag was cut short does not open (GCM tags are always the full 16 bytes)', () => {
  const ring = { current: 'k1', keys: { k1: newKey() } };
  const parts = seal(ring, 'secret', 'ctx').split('.');
  parts[4] = Buffer.from(parts[4]!, 'base64url').subarray(0, 4).toString('base64url');
  assert.throws(() => open(ring, parts.join('.'), 'ctx'), Unopenable, 'a 4-byte tag is a 2^32 forgery, not an integrity check');
  const extra = `${seal(ring, 'secret', 'ctx')}.more`;
  assert.throws(() => open(ring, extra, 'ctx'), Unopenable, 'trailing parts are not a sealed value');
  assert.throws(() => open(ring, 'v1.constructor.AAAAAAAAAAAAAAAA.AA.AAAAAAAAAAAAAAAAAAAAAA', 'ctx'), Unopenable, 'a key id that names an inherited property is not in the ring');
});

test('a signed token with anything appended is not the token that was signed', () => {
  const t = sign('s1', 'p', { user: 'ana' }, 60_000, 1000);
  assert.throws(() => verify('s1', 'p', `${t}.extra`, 2000), BadToken);
});

test('a ring key that is empty, not text, or not 32 bytes is refused with a message that says which', () => {
  const good = newKey();
  const sealed = seal({ current: 'k1', keys: { k1: good } }, 'secret');
  assert.throws(() => seal({ current: 'k1', keys: { k1: '' } }, 'x'), /key k1 is not in the ring/);
  assert.throws(() => seal({ current: 'k1', keys: { k1: 5 as unknown as string } }, 'x'), /key k1 is not in the ring/);
  const short = Buffer.alloc(16, 1).toString('base64');
  assert.throws(() => seal({ current: 'k1', keys: { k1: short } }, 'x'), (e: unknown) => e instanceof Unopenable && e.message === 'cannot open: key k1 is not 32 bytes');
  assert.throws(() => open({ current: 'k1', keys: { k1: short } }, sealed), (e: unknown) => e instanceof Unopenable && e.message === 'cannot open: key k1 is not 32 bytes');
});

test('open refuses anything that is not a v1 sealed value, with the reason given', () => {
  const ring = { current: 'k1', keys: { k1: newKey() } };
  const parts = seal(ring, 'secret', 'ctx').split('.');
  const notSealed = (e: unknown) => e instanceof Unopenable && e.message === 'cannot open: not a sealed value';
  assert.throws(() => open(ring, ['v2', ...parts.slice(1)].join('.'), 'ctx'), notSealed, 'another version is not opened as v1');
  assert.throws(() => open(ring, 'garbage', 'ctx'), notSealed);
  const longIv = [...parts];
  longIv[2] = randomId(16);
  assert.throws(() => open(ring, longIv.join('.'), 'ctx'), notSealed, 'a nonce that is not 12 bytes is refused up front');
  const shortTag = [...parts];
  shortTag[4] = randomId(4);
  assert.throws(() => open(ring, shortTag.join('.'), 'ctx'), notSealed);
});

test('tampering is reported as changed-or-elsewhere, and empty and non-ASCII values round-trip', () => {
  const ring = { current: 'k1', keys: { k1: newKey() } };
  assert.equal(open(ring, seal(ring, '', 'c'), 'c'), '');
  assert.equal(open(ring, seal(ring, 'héllo € 日本', 'c'), 'c'), 'héllo € 日本');
  assert.throws(() => open(ring, seal(ring, 'x', 'a'), 'b'), (e: unknown) => e instanceof Unopenable && e.message === 'cannot open: it was changed, or belongs somewhere else');
});

test('a malformed token is refused with the form message, and a token is good through its expiry instant', () => {
  assert.throws(() => verify('s1', 'p', 'nodot'), (e: unknown) => e instanceof BadToken && e.message === 'that token is not in the expected form');
  const t = sign('s1', 'p', { a: 1 }, 60_000, 1000);
  assert.deepEqual(verify('s1', 'p', t, 61_000), { a: 1 }, 'valid exactly at its expiry');
  assert.throws(() => verify('s1', 'p', t, 61_001), /expired/);
});
