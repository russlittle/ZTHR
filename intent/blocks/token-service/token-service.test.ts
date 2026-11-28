import assert from 'node:assert/strict';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { BadJwt, TokenRefused, TokenService, decodeJwt, encodeJwt, hs256, jwks } from './index.ts';
import type { JwtKey, Options } from './index.ts';

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ES: JwtKey = { alg: 'ES256', publicKey: ec.publicKey, privateKey: ec.privateKey };
const HS: JwtKey = { alg: 'HS256', secret: Buffer.from('0123456789abcdef0123456789abcdef') };
let n = 0;
const rnd = (len: number) => Buffer.alloc(len, 0).fill(String.fromCharCode(97 + (n++ % 26)));
const make = (o: Partial<Options> = {}) => {
  const t = { now: 1_700_000_000_000 };
  const svc = new TokenService({ issuer: 'https://id.example.org', audience: 'api', keys: { k1: ES, h1: HS }, currentKid: 'k1', now: () => t.now, random: rnd, ...o });
  return { svc, t };
};
const grant = { sub: 'ana', clientId: 'web', scope: ['read', 'write'] };
const refused = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof TokenRefused, String(e));
    return e.why;
  }
  return 'ok';
};

test('RFC 7515 appendix A.1: the published HS256 token verifies, and one changed character does not', () => {
  const key = Buffer.from('AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow', 'base64url');
  // RFC 7515 A.1: header and payload are built from the RFC's JSON texts and signed with the RFC key; the computed signature must equal the published segment.
  const b64j = (s: string) => Buffer.from(s).toString('base64url');
  const input = `${b64j('{"typ":"JWT",\r\n "alg":"HS256"}')}.${b64j('{"iss":"joe",\r\n "exp":1300819380,\r\n "http://example.com/is_root":true}')}`;
  assert.equal(hs256(input, key), 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  const token = `${input}.${hs256(input, key)}`;
  const [h, p, s] = token.split('.');
  assert.equal(hs256(`${h}.${p}`, key), s);
  const { claims } = decodeJwt(token, () => ({ alg: 'HS256', secret: key }), { typ: 'JWT' });
  assert.equal(claims['iss'], 'joe');
  assert.equal(claims['exp'], 1300819380);
  assert.throws(() => decodeJwt(`${h}.${p}.${s!.slice(0, -1)}A`, () => ({ alg: 'HS256', secret: key })), /signature/);
});

test('JWT hardening: none, algorithm confusion, foreign key headers and bad shapes are refused', () => {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const resolve = (kid: string | undefined): JwtKey | undefined => (kid === 'k1' ? ES : kid === 'h1' ? HS : undefined);
  const none = `${b({ alg: 'none', kid: 'k1' })}.${b({ sub: 'x' })}.`;
  assert.throws(() => decodeJwt(none, resolve), BadJwt);
  assert.throws(() => decodeJwt(`${b({ alg: 'none', kid: 'k1' })}.${b({ sub: 'x' })}.AAAA`, resolve), /algorithm/);
  // classic confusion: sign with HS256 using the public key bytes as the secret, naming the ES256 key
  const pub = ec.publicKey.export({ type: 'spki', format: 'der' });
  const input = `${b({ alg: 'HS256', kid: 'k1' })}.${b({ sub: 'x' })}`;
  const forged = `${input}.${createHmac('sha256', pub).update(input).digest('base64url')}`;
  assert.throws(() => decodeJwt(forged, resolve), /algorithm/);
  for (const bad of [{ jku: 'https://evil.example/keys' }, { jwk: {} }, { x5u: 'x' }, { crit: ['b64'] }]) {
    const tok = encodeJwt({ ...bad }, { sub: 'x' }, { ...HS, kid: 'h1' });
    assert.throws(() => decodeJwt(tok, resolve), /header is not accepted/);
  }
  assert.throws(() => decodeJwt(encodeJwt({}, { sub: 'x' }, { ...HS, kid: 'zzz' }), resolve), /unknown key/);
  assert.throws(() => decodeJwt('a.b', resolve), /three parts/);
  assert.throws(() => decodeJwt('a'.repeat(9000), resolve), /size/);
  assert.throws(() => decodeJwt(encodeJwt({}, { sub: 'x' }, { ...HS, kid: 'h1' }), resolve, { typ: 'at+jwt' }), /typ/);
  assert.throws(() => decodeJwt(`${b({ alg: 'ES256', kid: 'k1' })}.${b({})}.${Buffer.alloc(10).toString('base64url')}`, resolve), /signature/, 'a short ES256 signature');
});

test('issue gives a bearer pair; the access token is an RFC 9068 at+jwt with the standard claims', () => {
  const { svc } = make();
  const p = svc.issue(grant);
  assert.equal(p.token_type, 'Bearer');
  assert.equal(p.expires_in, 600);
  assert.equal(p.scope, 'read write');
  const { header, claims } = decodeJwt(p.access_token, (k) => (k === 'k1' ? ES : undefined), { typ: 'at+jwt' });
  assert.equal(header['alg'], 'ES256');
  assert.equal(header['kid'], 'k1');
  assert.deepEqual([claims['iss'], claims['sub'], claims['aud'], claims['client_id'], claims['scope'], claims['iat'], claims['exp']], ['https://id.example.org', 'ana', 'api', 'web', 'read write', 1_700_000_000, 1_700_000_600]);
  assert.match(String(claims['jti']), /./);
  const i = svc.introspect(p.access_token);
  assert.deepEqual([i.active, i.sub, i.scope, i.token_type, i.client_id], [true, 'ana', 'read write', 'access_token', 'web']);
});

test('introspection says only {active:false} to anything wrong', () => {
  const { svc, t } = make();
  const p = svc.issue(grant);
  const other = make({ keys: { k1: { alg: 'ES256', ...generateKeyPairSync('ec', { namedCurve: 'P-256' }) } as JwtKey } });
  const foreign = other.svc.issue(grant).access_token;
  for (const bad of [foreign, 'nonsense', '', 'a.b.c', p.access_token.slice(0, -2) + 'AA', p.refresh_token + 'x', undefined as unknown as string]) assert.deepEqual(svc.introspect(bad), { active: false });
  t.now += 600_000;
  assert.deepEqual(svc.introspect(p.access_token), { active: false }, 'expired at its exp second');
  assert.equal(svc.introspect(p.refresh_token).active, true, 'the refresh token outlives it');
});

test('refresh rotates: a new pair each time, the old refresh token stops working, scope may narrow but not widen', () => {
  const { svc, t } = make();
  const p1 = svc.issue(grant);
  t.now += 20_000;
  const p2 = svc.refresh(p1.refresh_token, { clientId: 'web' });
  assert.notEqual(p2.refresh_token, p1.refresh_token);
  assert.equal(svc.introspect(p2.refresh_token).active, true);
  assert.equal(svc.introspect(p1.refresh_token).active, false, 'the used one is no longer a live token');
  assert.equal(refused(() => svc.refresh(p2.refresh_token, { clientId: 'web', scope: ['read', 'admin'] })), 'scope_widened');
  const p3 = svc.refresh(p2.refresh_token, { clientId: 'web', scope: ['read'] });
  assert.equal(p3.scope, 'read');
  t.now += 20_000;
  assert.equal(refused(() => svc.refresh(p3.refresh_token, { clientId: 'web', scope: ['read', 'write'] })), 'scope_widened', 'what was given up stays given up');
});

test('reusing a spent refresh token after the grace is theft: the family and its access tokens end', () => {
  const { svc, t } = make();
  const p1 = svc.issue(grant);
  t.now += 1000;
  const p2 = svc.refresh(p1.refresh_token, { clientId: 'web' });
  t.now += 11_000;
  assert.equal(refused(() => svc.refresh(p1.refresh_token, { clientId: 'web' })), 'reused');
  assert.equal(svc.introspect(p2.access_token).active, false, 'the thief\'s and the owner\'s tokens both end');
  assert.equal(svc.introspect(p2.refresh_token).active, false);
  assert.equal(refused(() => svc.refresh(p2.refresh_token, { clientId: 'web' })), 'revoked');
  assert.deepEqual(svc.sessions('ana'), []);
});

test('a retry within the grace is a lost response, not theft: it is answered, and the newest token is the one that counts', () => {
  const { svc, t } = make();
  const p1 = svc.issue(grant);
  const lost = svc.refresh(p1.refresh_token, { clientId: 'web' });
  t.now += 5000;
  const retry = svc.refresh(p1.refresh_token, { clientId: 'web' });
  assert.notEqual(retry.refresh_token, lost.refresh_token);
  assert.equal(svc.introspect(retry.refresh_token).active, true);
  assert.equal(svc.introspect(lost.refresh_token).active, false);
  t.now += 20_000;
  assert.equal(refused(() => svc.refresh(p1.refresh_token, { clientId: 'web' })), 'reused');
});

test('refresh is bound to its client; another client presenting it ends the family', () => {
  const { svc } = make();
  const p = svc.issue(grant);
  assert.equal(refused(() => svc.refresh(p.refresh_token, { clientId: 'other' })), 'wrong_client');
  assert.equal(svc.introspect(p.refresh_token).active, false);
});

test('refresh lifetimes: idle expiry slides with use, the absolute limit does not', () => {
  const { svc, t } = make({ refreshIdleMs: 1000_000, refreshAbsoluteMs: 2500_000 });
  let p = svc.issue(grant);
  for (let i = 0; i < 2; i++) {
    t.now += 900_000;
    p = svc.refresh(p.refresh_token, { clientId: 'web' });
  }
  t.now += 700_000;
  assert.equal(refused(() => svc.refresh(p.refresh_token, { clientId: 'web' })), 'expired', 'sliding idle windows never carry it past the absolute limit');
  const q = make({ refreshIdleMs: 1000_000 });
  const a = q.svc.issue(grant);
  q.t.now += 1000_000;
  assert.equal(refused(() => q.svc.refresh(a.refresh_token, { clientId: 'web' })), 'expired');
});

test('sender binding: a bound token is useless without the key thumbprint it was made for', () => {
  const { svc } = make();
  const p = svc.issue({ ...grant, binding: 'thumb-1' });
  assert.equal(p.token_type, 'DPoP');
  assert.equal(svc.introspect(p.access_token).active, false, 'presented bare');
  assert.equal(svc.introspect(p.access_token, { binding: 'thumb-2' }).active, false);
  const ok = svc.introspect(p.access_token, { binding: 'thumb-1' });
  assert.deepEqual([ok.active, ok.cnf], [true, { jkt: 'thumb-1' }]);
  assert.equal(refused(() => svc.refresh(p.refresh_token, { clientId: 'web' })), 'wrong_binding');
  assert.equal(svc.refresh(p.refresh_token, { clientId: 'web', binding: 'thumb-1' }).token_type, 'DPoP');
});

test('revoking a refresh token ends its family; revoking an access token ends only that token', () => {
  const { svc } = make();
  const p = svc.issue(grant);
  const q = svc.refresh(p.refresh_token, { clientId: 'web' });
  const other = svc.issue({ ...grant, sub: 'bo' });
  svc.revoke('not-a-token');
  svc.revoke(q.access_token);
  assert.equal(svc.introspect(q.access_token).active, false);
  assert.equal(svc.introspect(q.refresh_token).active, true);
  svc.revoke(q.refresh_token);
  assert.equal(svc.introspect(q.refresh_token).active, false);
  assert.equal(svc.introspect(other.access_token).active, true, 'nobody else is touched');
});

test('sessions: listed per person, and ending one ends its tokens and nothing else', () => {
  const { svc, t } = make();
  const a = svc.issue({ ...grant, sid: 'laptop' });
  t.now += 1000;
  const b = svc.issue({ ...grant, sid: 'phone', clientId: 'mobile' });
  assert.deepEqual(svc.sessions('ana').map((s) => [s.sid, s.clientId]), [['laptop', 'web'], ['phone', 'mobile']]);
  assert.equal(svc.revokeSession('laptop'), true);
  assert.equal(svc.introspect(a.access_token).active, false);
  assert.equal(svc.introspect(a.refresh_token).active, false);
  assert.equal(svc.introspect(b.access_token).active, true);
  assert.deepEqual(svc.sessions('ana').map((s) => s.sid), ['phone']);
  assert.equal(svc.revokeSession('nope'), false);
});

test('revoking a person ends everything issued up to then, and a later sign-in works', () => {
  const { svc, t } = make();
  const old = svc.issue(grant);
  const bo = svc.issue({ ...grant, sub: 'bo' });
  svc.revokeSubject('ana');
  assert.equal(svc.introspect(old.access_token).active, false);
  assert.equal(svc.introspect(old.refresh_token).active, false);
  assert.equal(refused(() => svc.refresh(old.refresh_token, { clientId: 'web' })), 'revoked');
  assert.equal(svc.introspect(bo.access_token).active, true);
  t.now += 1000;
  const fresh = svc.issue(grant);
  assert.equal(svc.introspect(fresh.access_token).active, true);
});

test('token exchange: narrower scope, an allowed audience, an actor, and never longer than the original', () => {
  const { svc, t } = make({ exchangeAudiences: ['billing'] });
  const p = svc.issue(grant);
  t.now += 300_000;
  const x = svc.exchange({ subjectToken: p.access_token, clientId: 'svc-reports', scope: ['read'], audience: 'billing', actor: 'svc-reports' });
  assert.equal(x.issued_token_type, 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(x.expires_in, 300, 'capped at what the original had left');
  const i = svc.introspect(x.access_token);
  assert.deepEqual([i.scope, i.aud, i.sub, i.client_id, i.act], ['read', 'billing', 'ana', 'svc-reports', { sub: 'svc-reports' }]);
  assert.equal(refused(() => svc.exchange({ subjectToken: p.access_token, clientId: 'x', scope: ['admin'] })), 'scope_widened');
  assert.equal(refused(() => svc.exchange({ subjectToken: p.access_token, clientId: 'x', audience: 'payroll' })), 'not_allowed');
  assert.equal(refused(() => svc.exchange({ subjectToken: p.refresh_token, clientId: 'x' })), 'unknown', 'a refresh token is not exchanged');
  svc.revokeSession(i.sid!);
  assert.equal(svc.introspect(x.access_token).active, false, 'the exchanged token ends with the session');
});

test('a token for one audience is refused by a resource that asks for another', () => {
  const { svc } = make();
  const p = svc.issue(grant);
  assert.equal(svc.introspect(p.access_token, { audience: 'api' }).active, true);
  assert.equal(svc.introspect(p.access_token, { audience: 'billing' }).active, false);
});

test('keys rotate: tokens under the old key verify while it is in the ring, and the JWKS publishes only public ES256 keys', () => {
  const t = { now: 1_700_000_000_000 };
  const old = new TokenService({ issuer: 'i', audience: 'a', keys: { h1: HS }, currentKid: 'h1', now: () => t.now, random: rnd });
  const tok = old.issue(grant).access_token;
  const next = new TokenService({ issuer: 'i', audience: 'a', keys: { h1: HS, k2: ES }, currentKid: 'k2', now: () => t.now, random: rnd });
  assert.equal(next.introspect(tok).active, true);
  assert.equal(decodeJwt(next.issue(grant).access_token, () => ES).header['kid'], 'k2');
  const retired = new TokenService({ issuer: 'i', audience: 'a', keys: { k2: ES }, currentKid: 'k2', now: () => t.now, random: rnd });
  assert.equal(retired.introspect(tok).active, false);
  const set = jwks({ h1: HS, k2: ES });
  assert.equal(set.keys.length, 1);
  assert.deepEqual([set.keys[0]!['kid'], set.keys[0]!['alg'], set.keys[0]!['kty'], 'd' in set.keys[0]!], ['k2', 'ES256', 'EC', false]);
  assert.throws(() => new TokenService({ issuer: 'i', audience: 'a', keys: { h1: HS }, currentKid: 'nope' }), RangeError);
});

test('a token from another issuer, or from the future, is refused', () => {
  const { svc } = make();
  const evil = make({ issuer: 'https://evil.example' }).svc.issue(grant).access_token;
  assert.equal(svc.introspect(evil).active, false);
  const future = new TokenService({ issuer: 'https://id.example.org', audience: 'api', keys: { k1: ES }, currentKid: 'k1', now: () => 1_700_000_000_000 + 3600_000, random: rnd }).issue(grant).access_token;
  assert.equal(svc.introspect(future).active, false);
});

test('sweep drops dead families and old denylist entries and leaves live ones', () => {
  const { svc, t } = make({ refreshIdleMs: 100_000, refreshAbsoluteMs: 200_000 });
  const gone = svc.issue(grant);
  const kept = svc.issue({ ...grant, sub: 'bo' });
  svc.revoke(gone.access_token);
  t.now += 90_000;
  svc.refresh(kept.refresh_token, { clientId: 'web' });
  t.now += 200_000;
  assert.ok(svc.sweep() >= 2);
  assert.equal(svc.introspect(gone.refresh_token).active, false);
});
