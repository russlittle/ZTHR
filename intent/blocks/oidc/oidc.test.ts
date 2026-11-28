import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signWith, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { Keys, SignInFailed, callback, sameState, start, verifyIdToken, type Provider } from './index.ts';

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

test('the state is compared in constant time: equal only when identical, whatever the lengths', () => {
  const s = start(P);
  assert.equal(sameState(s.state, s.state), true);
  assert.equal(sameState(null, s.state), false);
  assert.equal(sameState('', s.state), false);
  assert.equal(sameState(s.state.slice(0, -1), s.state), false, 'a prefix is not a match');
  assert.equal(sameState(`${s.state}x`, s.state), false);
  assert.equal(sameState('state-abc', 'state-ABC'), false, 'case matters');
});

// ---------------------------------------------------------------- gauge-calibration tests

const exactly = (message: string) => ({ message });
const b64 = (x: string) => Buffer.from(x).toString('base64url');
const nowSec = now / 1000;
const rawJwt = (header: object | string, bodyJson: string, key: KeyObject = rsa.privateKey) => {
  const h = b64(typeof header === 'string' ? header : JSON.stringify(header));
  const b = b64(bodyJson);
  return `${h}.${b}.${signWith('sha256', Buffer.from(`${h}.${b}`), key).toString('base64url')}`;
};
const fetchOf = (keys: object[], counter?: { n: number }) =>
  (async () => {
    if (counter) counter.n += 1;
    return new Response(JSON.stringify({ keys }));
  }) as unknown as typeof fetch;

test('the sign-in link names the response type, client, redirect and requested scopes', () => {
  const u = new URL(start({ ...P, scopes: ['openid', 'groups'] }, now).url);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'files');
  assert.equal(u.searchParams.get('redirect_uri'), P.redirectUri);
  assert.equal(u.searchParams.get('scope'), 'openid groups');
  assert.equal(start(P, now).at, now);
});

test('a token that is not three JSON parts is refused with the reason', async () => {
  const keys = new Keys(P.jwksUri, keysFetch);
  const o = { nonce: 'n1', now };
  await assert.rejects(verifyIdToken('a.b', P, keys, o), exactly('the ID token is not a JWT'));
  await assert.rejects(verifyIdToken('a.b.c.d', P, keys, o), exactly('the ID token is not a JWT'));
  await assert.rejects(verifyIdToken(`${b64('not json')}.${b64('{}')}.AAAA`, P, keys, o), exactly("the ID token's header is not JSON"));
  await assert.rejects(verifyIdToken(rawJwt({ alg: 'RS256', kid: 'k1' }, 'not json'), P, keys, o), exactly("the ID token's body is not JSON"));
});

test('a key with no id is found by a token with no kid, and is described plainly when it does not fit', async () => {
  const o = { nonce: 'n1', now };
  const anon = { ...rsa.publicKey.export({ format: 'jwk' }) };
  const ok = rawJwt({ alg: 'RS256' }, JSON.stringify(base));
  assert.equal((await verifyIdToken(ok, P, new Keys(P.jwksUri, fetchOf([anon])), o)).sub, 'u-1');
  const anonEc = { ...ec.publicKey.export({ format: 'jwk' }) };
  await assert.rejects(verifyIdToken(ok, P, new Keys(P.jwksUri, fetchOf([anonEc])), o), exactly("the provider's key  is not one for RS256 signatures"));
});

test('a published key must fit the algorithm, name the same algorithm, and be meant for signatures', async () => {
  const o = { nonce: 'n1', now };
  const ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const keys = new Keys(P.jwksUri, fetchOf([
    jwk(ec.publicKey, 'k2'),
    { ...jwk(rsa.publicKey, 'good'), alg: 'RS256', use: 'sig' },
    { ...jwk(rsa.publicKey, 'otheralg'), alg: 'RS512' },
    { ...jwk(rsa.publicKey, 'enc'), use: 'enc' },
    jwk(ec384.publicKey, 'k384'),
    { ...jwk(rsa.publicKey, 'fake'), crv: 'P-256' },
  ]));
  assert.equal((await verifyIdToken(jwt(base, { kid: 'good' }), P, keys, o)).sub, 'u-1', 'a key that says RS256 and sig is accepted for RS256');
  await assert.rejects(verifyIdToken(jwt(base, { kid: 'k2' }), P, keys, o), exactly("the provider's key k2 is not one for RS256 signatures"));
  await assert.rejects(verifyIdToken(jwt(base, { kid: 'otheralg' }), P, keys, o), exactly("the provider's key otheralg is not one for RS256 signatures"));
  await assert.rejects(verifyIdToken(jwt(base, { kid: 'enc' }), P, keys, o), exactly("the provider's key enc is not one for RS256 signatures"));
  await assert.rejects(verifyIdToken(jwt(base, { alg: 'ES256', kid: 'k384', key: ec384.privateKey }), P, keys, o), exactly("the provider's key k384 is not one for ES256 signatures"));
  await assert.rejects(verifyIdToken(jwt(base, { alg: 'ES256', kid: 'fake' }), P, keys, o), exactly("the provider's key fake is not one for ES256 signatures"));
});

test('keys are fetched once, refreshed for an unknown id at most once a minute, and a failed fetch is reported', async () => {
  const counter = { n: 0 };
  const keys = new Keys(P.jwksUri, fetchOf([jwk(rsa.publicKey, 'k1')], counter));
  const T = now;
  assert.equal((await keys.get('k1', T))?.kid, 'k1');
  assert.equal((await keys.get('k1', T + 120_000))?.kid, 'k1');
  assert.equal(counter.n, 1, 'a known key is not fetched again');
  assert.equal(await keys.get('zz', T + 120_000), undefined);
  assert.equal(counter.n, 2);
  await keys.get('zz', T + 130_000);
  await keys.get('zz', T + 180_000);
  assert.equal(counter.n, 2, 'no refresh within a minute, up to and including the minute');
  await keys.get('zz', T + 180_001);
  assert.equal(counter.n, 3);
  const down = new Keys(P.jwksUri, (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);
  await assert.rejects(down.get('k1', T), exactly("the provider's keys could not be fetched (503)"));
});

test('audience and authorised party: a list of audiences needs this app as azp; a matching azp is fine', async () => {
  const keys = new Keys(P.jwksUri, keysFetch);
  const o = { nonce: 'n1', now };
  assert.equal((await verifyIdToken(jwt({ ...base, azp: 'files' }), P, keys, o)).sub, 'u-1');
  assert.equal((await verifyIdToken(jwt({ ...base, aud: ['files', 'other'], azp: 'files' }), P, keys, o)).sub, 'u-1');
  await assert.rejects(verifyIdToken(jwt({ ...base, aud: ['files', 'other'] }), P, keys, o), exactly('the ID token names another authorised party'));
  assert.equal((await verifyIdToken(jwt({ ...base, aud: ['files'] }), P, keys, o)).sub, 'u-1', 'a single listed audience needs no azp');
  await assert.rejects(verifyIdToken(jwt({ ...base, aud: 7 }), P, keys, o), exactly('the ID token is for another application'));
});

test('expiry and issue time: a missing or unbounded value is refused, and the clock-skew edges are exact', async () => {
  const keys = new Keys(P.jwksUri, keysFetch);
  const o = { nonce: 'n1', now };
  const claims = (extra: Record<string, unknown>) => jwt({ ...base, exp: nowSec + 7200, ...extra });
  const { exp: _e, ...noExp } = base;
  const { iat: _i, ...noIat } = base;
  await assert.rejects(verifyIdToken(jwt(noExp), P, keys, o), exactly('the ID token carries no expiry'));
  await assert.rejects(verifyIdToken(jwt(noIat), P, keys, o), exactly('the ID token carries no issue time'));
  const inf = (field: string) => rawJwt({ alg: 'RS256', kid: 'k1' }, JSON.stringify({ ...base, exp: nowSec + 7200 }).replace(new RegExp(`"${field}":\\d+`), `"${field}":1e999`));
  await assert.rejects(verifyIdToken(inf('exp'), P, keys, o), exactly('the ID token carries no expiry'));
  await assert.rejects(verifyIdToken(inf('iat'), P, keys, o), exactly('the ID token carries no issue time'));
  assert.equal((await verifyIdToken(jwt({ ...base, exp: nowSec - 60 }), P, keys, o)).sub, 'u-1', 'expired exactly the skew ago is still good');
  await assert.rejects(verifyIdToken(jwt({ ...base, exp: nowSec - 61 }), P, keys, o), exactly('the ID token has expired'));
  assert.equal((await verifyIdToken(jwt({ ...base, exp: nowSec - 30 }), P, keys, o)).sub, 'u-1', 'a little past expiry is within the skew');
  assert.equal((await verifyIdToken(claims({ iat: nowSec + 60 }), P, keys, o)).sub, 'u-1', 'issued exactly the skew ahead is still good');
  await assert.rejects(verifyIdToken(claims({ iat: nowSec + 61 }), P, keys, o), exactly('the ID token was issued in the future'));
  await assert.rejects(verifyIdToken(claims({ iat: nowSec + 3600 }), P, keys, o), exactly('the ID token was issued in the future'));
  assert.equal((await verifyIdToken(claims({ iat: nowSec + 3600 }), P, keys, { ...o, skewSec: 4000 })).sub, 'u-1', 'the skew can be widened');
});

test('the callback reports what the provider said, and each way the exchange can fail', async () => {
  const s = start(P, now);
  const keys = new Keys(P.jwksUri, keysFetch);
  const q = (extra: Record<string, string>) => new URLSearchParams({ state: s.state, ...extra });
  const never = (async () => { throw new Error('no request expected'); }) as unknown as typeof fetch;
  await assert.rejects(callback(P, keys, s, q({ error: 'access_denied', error_description: 'User said no' }), { fetch: never, now }), exactly('the provider refused: User said no'));
  await assert.rejects(callback(P, keys, s, q({ error: 'access_denied' }), { fetch: never, now }), exactly('the provider refused: access_denied'));
  await assert.rejects(callback(P, keys, s, q({}), { fetch: never, now }), exactly('the provider sent no code'));
  const reply = (r: Response) => (async () => r) as unknown as typeof fetch;
  await assert.rejects(callback(P, keys, s, q({ code: 'c' }), { fetch: reply(new Response('{}', { status: 400 })), now }), exactly('the provider refused the code (400)'));
  await assert.rejects(callback(P, keys, s, q({ code: 'c' }), { fetch: reply(new Response('{}')), now }), exactly('the provider sent no ID token'));
});

test('the sign-in may take exactly the allowed time, and ten minutes by default', async () => {
  const s = start(P, now);
  const longLived = { ...base, nonce: s.nonce, exp: nowSec + 7200 };
  const f = (async (url: string) => (url === P.jwksUri ? keysFetch(url) : new Response(JSON.stringify({ id_token: jwt(longLived) })))) as unknown as typeof fetch;
  const keys = new Keys(P.jwksUri, f);
  const q = new URLSearchParams({ state: s.state, code: 'c' });
  assert.equal((await callback(P, keys, s, q, { fetch: f, now: now + 5 * 60_000 })).sub, 'u-1', 'five minutes in is well within the default');
  assert.equal((await callback(P, keys, s, q, { fetch: f, now: now + 10 * 60_000 })).sub, 'u-1', 'exactly ten minutes is allowed');
  await assert.rejects(callback(P, keys, s, q, { fetch: f, now: now + 10 * 60_000 + 1 }), exactly('the sign-in took too long; start again'));
  assert.equal((await callback(P, keys, s, q, { fetch: f, now: now + 1000, maxAgeMs: 1000 })).sub, 'u-1', 'exactly the given maximum is allowed');
  await assert.rejects(callback(P, keys, s, q, { fetch: f, now: now + 1001, maxAgeMs: 1000 }), exactly('the sign-in took too long; start again'));
});

test('the code exchange is a form POST with the grant, code, client and secret only when there is one', async () => {
  const s = start(P, now);
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (url === P.jwksUri) return keysFetch(url);
    seen.push({ url, init });
    return new Response(JSON.stringify({ id_token: jwt({ ...base, nonce: s.nonce }) }));
  }) as unknown as typeof fetch;
  const keys = new Keys(P.jwksUri, f);
  const q = new URLSearchParams({ state: s.state, code: 'abc' });
  await callback({ ...P, clientSecret: 'shh' }, keys, s, q, { fetch: f, now });
  await callback(P, keys, s, q, { fetch: f, now });
  const [withSecret, without] = seen;
  assert.equal(withSecret!.url, P.tokenEndpoint);
  assert.equal(withSecret!.init?.method, 'POST');
  assert.deepEqual(withSecret!.init?.headers, { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
  const form = new URLSearchParams(String(withSecret!.init?.body));
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'abc');
  assert.equal(form.get('client_id'), 'files');
  assert.equal(form.get('redirect_uri'), P.redirectUri);
  assert.equal(form.get('client_secret'), 'shh');
  assert.equal(new URLSearchParams(String(without!.init?.body)).has('client_secret'), false);
});
