import assert from 'node:assert/strict';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { test } from 'node:test';
import { BadSignature, KeyRegistry, KeyUnusable, generateKey, thumbprint, verifyJws } from './index.ts';
import type { Alg, KeyPolicy } from './index.ts';

const policy = (alg: Alg, more: Partial<KeyPolicy> = {}): KeyPolicy => ({ alg, signForMs: 1000_000, verifyGraceMs: 500_000, publishLeadMs: 100_000, ...more });
const make = (alg: Alg, more: Partial<KeyPolicy> = {}) => {
  const clock = { t: 10_000_000 };
  return { clock, reg: new KeyRegistry({ policy: policy(alg, more), now: () => clock.t }) };
};
const part = (s: string, i: number) => s.split('.')[i]!;
const swap = (token: string, i: number, v: string) => token.split('.').map((p, j) => (j === i ? v : p)).join('.');

test('RFC 7638 section 3.1: the RSA example key has the published thumbprint', () => {
  const n = '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw';
  assert.equal(thumbprint({ kty: 'RSA', n, e: 'AQAB', alg: 'RS256', kid: '2011-04-29' }), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
});

test('RFC 8037 appendix A: the Ed25519 example key has the published thumbprint, and the published signature verifies', () => {
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
  assert.equal(thumbprint(jwk), 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  const head = Buffer.from('{"alg":"EdDSA"}').toString('base64url');
  const body = Buffer.from('Example of Ed25519 signing').toString('base64url');
  assert.equal(head, 'eyJhbGciOiJFZERTQSJ9');
  assert.equal(body, 'RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc');
  const sig = Buffer.from('hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg', 'base64url');
  assert.equal(nodeVerify(null, Buffer.from(`${head}.${body}`), createPublicKey({ key: jwk, format: 'jwk' }), sig), true);
  assert.equal(nodeVerify(null, Buffer.from(`${head}.${body}x`), createPublicKey({ key: jwk, format: 'jwk' }), sig), false);
  // That payload is plain text, not a JSON claim set, so the verifier refuses it.
  assert.throws(() => verifyJws(`${head}.${body}.${sig.toString('base64url')}`, { jwks: { keys: [] }, now: 0 }), /not JSON/);
});

test('each algorithm signs and verifies, and the key id is the key thumbprint', () => {
  for (const alg of ['ES256', 'RS256', 'EdDSA'] as const) {
    const { reg } = make(alg);
    const kid = reg.rotate();
    const jwks = reg.jwks();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0]!.kid, kid);
    assert.equal(thumbprint(jwks.keys[0]!), kid);
    assert.equal(jwks.keys[0]!.alg, alg);
    assert.equal(jwks.keys[0]!.use, 'sig');
    const t = reg.sign({ sub: 'ana' });
    assert.equal(verifyJws(t, { jwks, now: 10_000_000 })['sub'], 'ana');
  }
});

test('the published keys never include private material', () => {
  const { reg } = make('ES256');
  reg.rotate();
  const text = JSON.stringify(reg.jwks());
  assert.ok(!text.includes('"d"'));
  assert.deepEqual(Object.keys(reg.jwks().keys[0]!).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
});

test('a tampered payload or signature is refused', () => {
  const { reg } = make('ES256');
  reg.rotate();
  const t = reg.sign({ sub: 'ana' });
  const o = { jwks: reg.jwks(), now: 10_000_000 };
  const forged = Buffer.from(JSON.stringify({ iat: 10_000, sub: 'eve' })).toString('base64url');
  assert.throws(() => verifyJws(swap(t, 1, forged), o), /does not match its key/);
  assert.throws(() => verifyJws(swap(t, 2, part(t, 2).slice(0, -2) + 'AA'), o), BadSignature);
  assert.throws(() => verifyJws(swap(t, 2, 'AAAA'), o), /wrong signature length/);
  assert.throws(() => verifyJws('a.b', o), /not a compact signature/);
  assert.throws(() => verifyJws('!!.??.**', o), /not base64url/);
});

test('algorithm confusion is refused: none, a swapped algorithm, a header that disagrees with the published key', () => {
  const { reg } = make('RS256');
  const kid = reg.rotate();
  const t = reg.sign({ sub: 'ana' });
  const o = { jwks: reg.jwks(), now: 10_000_000 };
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid })).toString('base64url');
  assert.throws(() => verifyJws(`${none}.${part(t, 1)}.`, o), /not a compact signature/);
  assert.throws(() => verifyJws(swap(t, 0, none), o), /algorithm none is not accepted/);
  const hs = Buffer.from(JSON.stringify({ alg: 'HS256', kid })).toString('base64url');
  assert.throws(() => verifyJws(swap(t, 0, hs), o), /HS256 is not accepted/);
  const es = Buffer.from(JSON.stringify({ alg: 'ES256', kid })).toString('base64url');
  assert.throws(() => verifyJws(swap(t, 0, es), o), /different algorithm than its key/);
  assert.throws(() => verifyJws(t, { ...o, algs: ['ES256'] }), /RS256 is not accepted/);
});

test('an unknown key id is refused', () => {
  const a = make('EdDSA');
  a.reg.rotate();
  const b = make('EdDSA');
  b.reg.rotate();
  assert.throws(() => verifyJws(a.reg.sign({}), { jwks: b.reg.jwks(), now: 10_000_000 }), /is not published/);
});

test('rotation publishes the new key ahead of use, then it takes over; the old key still verifies in its grace period', () => {
  const { reg, clock } = make('ES256');
  const k1 = reg.rotate();
  const old = reg.sign({ n: 1 });
  clock.t += 900_000;
  const k2 = reg.rotate();
  assert.deepEqual(reg.list().map((k) => k.state), ['active', 'pending']);
  assert.deepEqual(reg.jwks().keys.map((k) => k.kid), [k1, k2], 'published before it signs');
  assert.equal(JSON.parse(Buffer.from(part(reg.sign({}), 0), 'base64url').toString()).kid, k1, 'still the old key signing during the lead');
  clock.t += 100_000;
  assert.deepEqual(reg.list().map((k) => k.state), ['retired', 'active']);
  assert.equal(JSON.parse(Buffer.from(part(reg.sign({}), 0), 'base64url').toString()).kid, k2);
  assert.equal(verifyJws(old, { jwks: reg.jwks(), now: clock.t })['n'], 1);
  clock.t += 500_000;
  assert.deepEqual(reg.list().map((k) => k.state), ['expired', 'active']);
  assert.deepEqual(reg.jwks().keys.map((k) => k.kid), [k2], 'an expired key is no longer published');
});

test('a key past its signing lifetime stops signing, and with nothing active the caller is told to rotate', () => {
  const { reg, clock } = make('EdDSA');
  reg.rotate();
  clock.t += 1000_000;
  assert.throws(() => reg.sign({}), (e: unknown) => e instanceof KeyUnusable && /rotate/.test((e as Error).message));
});

test('a signature limit retires the key after the last allowed signature', () => {
  const { reg } = make('EdDSA', { maxSignatures: 2 });
  reg.rotate();
  reg.sign({});
  reg.sign({});
  assert.equal(reg.list()[0]!.signatures, 2);
  assert.equal(reg.list()[0]!.state, 'retired');
  assert.throws(() => reg.sign({}), KeyUnusable);
  assert.equal(reg.jwks().keys.length, 1, 'it still verifies what it signed');
});

test('a key limited to purposes signs only for them', () => {
  const { reg } = make('ES256', { purposes: ['login'] });
  reg.rotate();
  assert.ok(reg.sign({}, 'login'));
  assert.throws(() => reg.sign({}, 'payments'), /may not sign for payments/);
  assert.throws(() => reg.sign({}), /unnamed purpose/);
  assert.equal(reg.list()[0]!.signatures, 1, 'a refused signing is not counted');
});

test('revoking as compromised voids everything the key signed, and removes it from the published keys', () => {
  const { reg, clock } = make('ES256');
  const kid = reg.rotate();
  const t = reg.sign({ sub: 'ana' });
  const before = reg.jwks();
  clock.t += 1000;
  reg.revoke(kid, 'keyCompromise');
  assert.deepEqual(reg.jwks().keys, []);
  assert.equal(reg.list()[0]!.state, 'revoked');
  assert.throws(() => reg.sign({}), KeyUnusable);
  assert.throws(() => verifyJws(t, { jwks: before, now: clock.t, revoked: reg.revocationList() }), /revoked as compromised/);
});

test('a revocation for another reason keeps tokens issued before it and refuses ones after', () => {
  const { reg, clock } = make('ES256');
  const kid = reg.rotate();
  const early = reg.sign({ sub: 'ana' });
  const jwks = reg.jwks();
  clock.t += 5000;
  reg.revoke(kid, 'superseded');
  const list = reg.revocationList();
  assert.deepEqual(list.entries, [{ kid, revokedAt: 10_005_000, reason: 'superseded' }]);
  assert.equal(verifyJws(early, { jwks, now: clock.t, revoked: list })['sub'], 'ana');
  const forgedLater = swap(early, 1, Buffer.from(JSON.stringify({ iat: 10_006 })).toString('base64url'));
  assert.throws(() => verifyJws(forgedLater, { jwks, now: clock.t, revoked: list }), /revoked before it was issued|does not match/);
});

test('the revocation list counts versions, ignores repeats, and refuses unknown keys', () => {
  const { reg } = make('EdDSA');
  const kid = reg.rotate();
  assert.equal(reg.revocationList().version, 0);
  reg.revoke(kid, 'unspecified');
  reg.revoke(kid, 'keyCompromise');
  const l = reg.revocationList();
  assert.equal(l.version, 1);
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0]!.reason, 'unspecified');
  assert.throws(() => reg.revoke('nope', 'unspecified'), /no key nope/);
});

test('a token issued in the future is refused beyond the allowed skew', () => {
  const { reg, clock } = make('EdDSA');
  reg.rotate();
  const t = reg.sign({});
  const jwks = reg.jwks();
  assert.throws(() => verifyJws(t, { jwks, now: clock.t - 3600_000 }), /issued in the future/);
  assert.ok(verifyJws(t, { jwks, now: clock.t - 30_000 }));
});

test('an RSA key under 2048 bits in a published set is refused', () => {
  const small = generateKey('RS256');
  assert.ok(Buffer.from(small.publicJwk.n!, 'base64url').length === 256);
  const e = Buffer.from('AQAB', 'base64url');
  assert.equal(e.length, 3);
  const { reg } = make('RS256');
  const kid = reg.rotate();
  const t = reg.sign({});
  const weak = { keys: [{ ...reg.jwks().keys[0]!, n: Buffer.alloc(128, 7).toString('base64url') }] };
  assert.throws(() => verifyJws(t, { jwks: weak, now: 10_000_000 }), /under 2048 bits/);
  assert.equal(kid, reg.jwks().keys[0]!.kid);
});
