import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signWith, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { Keys, SignInFailed, callback, start, verifyIdToken, type Provider } from './index.ts';

const P: Provider = { issuer: 'https://idp.example.org', authorizationEndpoint: 'https://idp.example.org/auth', tokenEndpoint: 'https://idp.example.org/token', jwksUri: 'https://idp.example.org/keys', clientId: 'files', redirectUri: 'https://files.example.org/cb' };

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (k: KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid });

function jwt(claims: Record<string, unknown>, o: { kid?: string; alg?: 'RS256' | 'ES256'; key?: KeyObject } = {}) {
  const alg = o.alg ?? 'RS256';
  const h = Buffer.from(JSON.stringify({ alg, kid: o.kid ?? 'k1', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = signWith('sha256', Buffer.from(`${h}.${b}`), alg === 'ES256' ? { key: o.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' } : (o.key ?? rsa.privateKey));
  return `${h}.${b}.${sig.toString('base64url')}`;
}

const now = 1_800_000_000_000;
const base = { iss: P.issuer, sub: 'u-1', aud: 'files', exp: now / 1000 + 300, iat: now / 1000, nonce: 'n1', email: 'ana@example.org', email_verified: true };
const keysFetch = (async () => new Response(JSON.stringify({ keys: [jwk(rsa.publicKey, 'k1'), jwk(ec.publicKey, 'k2')] }))) as unknown as typeof fetch;

test('a sign-in link carries state, a nonce and a PKCE challenge that matches its verifier', () => {
  const s = start(P, now);
  const u = new URL(s.url);
  assert.equal(u.searchParams.get('state'), s.state);
  assert.equal(u.searchParams.get('nonce'), s.nonce);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), createHash('sha256').update(s.verifier).digest('base64url'));
  assert.equal(u.searchParams.get('scope'), 'openid email profile');
});

test('an ID token is believed only when signed by a published key, for this app, unexpired, answering this sign-in', async () => {
  const keys = new Keys(P.jwksUri, keysFetch);
  assert.equal((await verifyIdToken(jwt(base), P, keys, { nonce: 'n1', now })).email, 'ana@example.org');
  assert.equal((await verifyIdToken(jwt(base, { alg: 'ES256', kid: 'k2' }), P, keys, { nonce: 'n1', now })).sub, 'u-1');
  const bad = async (t: string, why: RegExp) => assert.rejects(verifyIdToken(t, P, keys, { nonce: 'n1', now }), why);
  await bad(jwt({ ...base, iss: 'https://evil.example' }), /another issuer/);
  await bad(jwt({ ...base, aud: 'other-app' }), /another application/);
  await bad(jwt({ ...base, exp: now / 1000 - 3600 }), /expired/);
  await bad(jwt({ ...base, nonce: 'n2' }), /does not answer this sign-in/);
  await bad(jwt(base, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /signature does not verify/);
  await bad(jwt(base, { kid: 'unknown' }), /key the provider does not publish/);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(base)).toString('base64url')}.`;
  await bad(none, /not accepted/);
});

test('the callback checks state, exchanges the code with the PKCE verifier, and verifies the token', async () => {
  const s = start(P, now);
  let sent = '';
  const f = (async (url: string, init?: RequestInit) => {
    if (url === P.jwksUri) return keysFetch(url);
    sent = String(init?.body);
    return new Response(JSON.stringify({ id_token: jwt({ ...base, nonce: s.nonce }) }));
  }) as unknown as typeof fetch;
  const keys = new Keys(P.jwksUri, f);
  const c = await callback(P, keys, s, new URLSearchParams({ state: s.state, code: 'abc' }), { fetch: f, now });
  assert.equal(c.sub, 'u-1');
  assert.match(sent, new RegExp(`code_verifier=${s.verifier}`));
  await assert.rejects(callback(P, keys, s, new URLSearchParams({ state: 'forged', code: 'abc' }), { fetch: f, now }), /not started here/);
  await assert.rejects(callback(P, keys, s, new URLSearchParams({ state: s.state, error: 'access_denied' }), { fetch: f, now }), SignInFailed);
  await assert.rejects(callback(P, keys, s, new URLSearchParams({ state: s.state, code: 'abc' }), { fetch: f, now: now + 11 * 60_000 }), /too long/);
});

test('an ID token without an expiry or issue time is refused (OIDC Core 3.1.3.7 requires both)', async () => {
  const keys = new Keys(P.jwksUri, keysFetch);
  const { exp: _exp, ...noExp } = base;
  const { iat: _iat, ...noIat } = base;
  await assert.rejects(verifyIdToken(jwt(noExp), P, keys, { nonce: 'n1', now }), SignInFailed);
  await assert.rejects(verifyIdToken(jwt(noIat), P, keys, { nonce: 'n1', now }), SignInFailed);
  await assert.rejects(verifyIdToken(jwt({ ...base, exp: String(base.exp) }), P, keys, { nonce: 'n1', now }), SignInFailed);
});

test('an azp naming another party is refused even with a single audience', async () => {
  const keys = new Keys(P.jwksUri, keysFetch);
  await assert.rejects(verifyIdToken(jwt({ ...base, azp: 'other-app' }), P, keys, { nonce: 'n1', now }), /authorised party/);
});

test('the header alg must fit the key: an RSA key is never used for ES256, nor an EC key for RS256', async () => {
  const keys = new Keys(P.jwksUri, keysFetch);
  const rsaUnderEs = (() => {
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
    const b = Buffer.from(JSON.stringify(base)).toString('base64url');
    return `${h}.${b}.${signWith('sha256', Buffer.from(`${h}.${b}`), rsa.privateKey).toString('base64url')}`;
  })();
  await assert.rejects(verifyIdToken(rsaUnderEs, P, keys, { nonce: 'n1', now }), SignInFailed);
  await assert.rejects(verifyIdToken(jwt(base, { alg: 'RS256', kid: 'k2' }), P, keys, { nonce: 'n1', now }), SignInFailed);
});
