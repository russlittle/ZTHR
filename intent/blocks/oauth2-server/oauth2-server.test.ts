import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { ClientRegistry } from '../client-registry/index.ts';
import { AuthorizationServer, BadJwt, OAuthError, parseParams, pkceChallenge, signJwt, verifyJwt } from './index.ts';
import type { AuthorizeResult, ServerOptions, Subject } from './index.ts';

function counter() {
  let n = 0;
  return (len: number) => {
    n += 1;
    return Uint8Array.from({ length: len }, (_, i) => (n * 37 + i * 11 + (n >> 3)) & 0xff);
  };
}
const SCOPES = [
  { name: 'openid', description: 'Know who you are' },
  { name: 'profile', description: 'See your name' },
  { name: 'read', description: 'Read your data' },
  { name: 'write', description: 'Change your data', implies: ['read'] },
  { name: 'admin', description: 'Administer everything', implies: ['write'], sensitive: true },
  { name: 'offline_access', description: 'Stay signed in' },
];
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ALICE: Subject = { id: 'alice', authTime: 1_800_000_000_000 };

function setup(over: Partial<ServerOptions> = {}) {
  const t = { v: 1_800_000_000_000 };
  const registry = new ClientRegistry({ now: () => t.v, randomBytes: counter(), policy: { allowedScopes: SCOPES.map((s) => s.name), defaultScopes: ['openid'] } });
  const web = registry.create({ name: 'Web', clientId: 'web', redirectUris: ['https://app.example.org/cb'], grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'], scopes: ['openid', 'profile', 'read', 'write', 'admin', 'offline_access'] });
  const pub = registry.create({ name: 'Native', clientId: 'native', redirectUris: ['http://127.0.0.1/cb'], authMethod: 'none', grantTypes: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'], scopes: ['openid', 'read', 'profile'], applicationType: 'native' });
  const tv = registry.create({ name: 'TV', clientId: 'tv', authMethod: 'none', grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], scopes: ['read', 'profile'] });
  const server = new AuthorizationServer({ issuer: 'https://as.example.org', registry, signing: { alg: 'HS256', key: 'a-signing-secret-of-decent-length', kid: 'k1' }, scopes: SCOPES, now: () => t.v, randomBytes: counter(), ...over });
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  return { t, registry, server, web, pub, tv, webAuth: basic('web', web.secret!), basic };
}
const redirectOf = (r: AuthorizeResult) => {
  assert.equal(r.kind, 'redirect', JSON.stringify(r));
  return new URL((r as { url: string }).url);
};
const authReq = (o: Record<string, string> = {}) => ({ client_id: 'web', redirect_uri: 'https://app.example.org/cb', response_type: 'code', scope: 'openid read', state: 'xyz', code_challenge: CHALLENGE, code_challenge_method: 'S256', nonce: 'n-1', ...o });
function getCode(s: ReturnType<typeof setup>, o: Record<string, string> = {}) {
  const r = s.server.authorize(authReq(o), ALICE);
  if (r.kind === 'consent') return redirectOf(s.server.approve(r.request, ALICE)).searchParams.get('code')!;
  return redirectOf(r).searchParams.get('code')!;
}
const exchange = (s: ReturnType<typeof setup>, code: string, extra: Record<string, string> = {}) =>
  s.server.token({ authorization: s.webAuth, body: { grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.org/cb', code_verifier: VERIFIER, ...extra } });

test('RFC 7636 appendix B: the published verifier produces the published challenge', () => {
  assert.equal(pkceChallenge(VERIFIER), CHALLENGE);
});

test('RFC 7515 appendix A.1: the published HS256 example verifies, and one changed byte does not', () => {
  const key = Buffer.from('AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow', 'base64url');
  const header = Buffer.from('{"typ":"JWT",\r\n "alg":"HS256"}').toString('base64url');
  const payload = Buffer.from('{"iss":"joe",\r\n "exp":1300819380,\r\n "http://example.com/is_root":true}').toString('base64url');
  assert.equal(header, 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9');
  const token = `${header}.${payload}.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`;
  const claims = verifyJwt(token, [{ alg: 'HS256', key }], { now: 1_300_819_000_000 });
  assert.equal(claims.iss, 'joe');
  assert.equal(claims['http://example.com/is_root'], true);
  assert.throws(() => verifyJwt(token.slice(0, -2) + 'AA', [{ alg: 'HS256', key }], { now: 1_300_819_000_000 }), /signature/);
  assert.throws(() => verifyJwt(token, [{ alg: 'HS256', key }], { now: 1_300_819_381_000 }), /expired/);
});

test('JWTs: RS256 and ES256 round-trip, and the token cannot choose its own algorithm', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = 1_800_000_000_000;
  const claims = { sub: 'a', exp: now / 1000 + 60 };
  const rs = signJwt({ alg: 'RS256', key: rsa.privateKey, kid: 'r' }, claims);
  const es = signJwt({ alg: 'ES256', key: ec.privateKey, kid: 'e' }, claims);
  assert.equal(verifyJwt(rs, [{ alg: 'RS256', key: rsa.publicKey, kid: 'r' }], { now }).sub, 'a');
  assert.equal(verifyJwt(es, [{ alg: 'ES256', key: ec.publicKey, kid: 'e' }], { now }).sub, 'a');
  assert.throws(() => verifyJwt(rs, [{ alg: 'ES256', key: ec.publicKey, kid: 'r' }], { now }), /says RS256 but its key is ES256/);
  // The classic confusion: an RS256 token re-signed as HS256 using the public key text as the secret.
  const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const forged = signJwt({ alg: 'HS256', key: pem, kid: 'r' }, claims);
  assert.throws(() => verifyJwt(forged, [{ alg: 'RS256', key: rsa.publicKey, kid: 'r' }], { now }), /says HS256 but its key is RS256/);
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
  assert.throws(() => verifyJwt(none, [{ alg: 'RS256', key: rsa.publicKey }], { now }), BadJwt);
  assert.throws(() => verifyJwt('a.b', [], { now }), /compact/);
  assert.throws(() => verifyJwt(rs, [{ alg: 'RS256', key: rsa.publicKey, kid: 'other' }], { now }), /no key/);
});

test('authorization: login first, then consent with each scope described, then a code on the registered redirect with state and iss', () => {
  const s = setup();
  const r0 = s.server.authorize(authReq(), undefined);
  assert.equal(r0.kind, 'login');
  const r1 = s.server.authorize(authReq(), ALICE);
  assert.equal(r1.kind, 'consent');
  if (r1.kind !== 'consent') return;
  assert.deepEqual(r1.scopes.map((x) => [x.name, x.description, x.alreadyGranted]), [['openid', 'Know who you are', false], ['read', 'Read your data', false]]);
  const u = redirectOf(s.server.approve(r1.request, ALICE));
  assert.equal(u.origin + u.pathname, 'https://app.example.org/cb');
  assert.equal(u.searchParams.get('state'), 'xyz');
  assert.equal(u.searchParams.get('iss'), 'https://as.example.org');
  assert.ok(u.searchParams.get('code'));
  // The person agreed once: the same request does not ask again, but a wider one asks only about the new scope.
  assert.equal(s.server.authorize(authReq(), ALICE).kind, 'redirect');
  const wider = s.server.authorize(authReq({ scope: 'openid read write' }), ALICE);
  assert.equal(wider.kind, 'consent');
  if (wider.kind === 'consent') assert.deepEqual(wider.scopes.map((x) => [x.name, x.alreadyGranted]), [['openid', true], ['read', true], ['write', false]]);
  s.server.withdrawConsent('alice', 'web');
  assert.equal(s.server.authorize(authReq(), ALICE).kind, 'consent');
});

test('a bad client or redirect is shown to the person and never redirected to', () => {
  const s = setup();
  for (const p of [authReq({ redirect_uri: 'https://evil.example.com/cb' }), authReq({ redirect_uri: 'https://app.example.org/cb/' }), authReq({ client_id: 'ghost' }), { response_type: 'code' }]) {
    const r = s.server.authorize(p, ALICE);
    assert.equal(r.kind, 'error-page', JSON.stringify(p));
  }
});

test('every other authorization problem goes back to the client with its error, state and iss', () => {
  const s = setup();
  const err = (o: Record<string, string>) => {
    const u = redirectOf(s.server.authorize(authReq(o), ALICE));
    assert.equal(u.searchParams.get('state'), 'xyz');
    assert.equal(u.searchParams.get('iss'), 'https://as.example.org');
    return u.searchParams.get('error');
  };
  assert.equal(err({ response_type: 'token' }), 'unsupported_response_type');
  assert.equal(err({ code_challenge: '' }), 'invalid_request');
  assert.equal(err({ code_challenge_method: 'plain' }), 'invalid_request');
  assert.equal(err({ code_challenge: 'short' }), 'invalid_request');
  assert.equal(err({ scope: 'openid nonsense' }), 'invalid_scope');
  assert.equal(err({ scope: 'read', max_age: 'soon' }), 'invalid_request');
  const clean = { ...authReq() } as Record<string, string | undefined>;
  delete clean.code_challenge_method;
  const u = redirectOf(s.server.authorize(clean, ALICE));
  assert.equal(u.searchParams.get('error'), 'invalid_request');
});

test('prompt=none never shows a page, prompt=login and a short max_age force a new sign-in, sensitive scopes always ask', () => {
  const s = setup();
  assert.equal(redirectOf(s.server.authorize(authReq({ prompt: 'none' }), undefined)).searchParams.get('error'), 'login_required');
  assert.equal(redirectOf(s.server.authorize(authReq({ prompt: 'none' }), ALICE)).searchParams.get('error'), 'consent_required');
  assert.equal(s.server.authorize(authReq({ prompt: 'login' }), ALICE).kind, 'login');
  s.t.v += 120_000;
  assert.equal(s.server.authorize(authReq({ max_age: '60' }), ALICE).kind, 'login');
  assert.equal(s.server.authorize(authReq({ max_age: '600' }), ALICE).kind, 'consent');
  const r = s.server.authorize(authReq({ scope: 'admin' }), ALICE);
  assert.equal(r.kind, 'consent');
  if (r.kind === 'consent') s.server.approve(r.request, ALICE);
  assert.equal(s.server.authorize(authReq({ scope: 'admin' }), ALICE).kind, 'consent', 'agreeing to a sensitive scope is not remembered');
});

test('denying, and granting less than was asked, are honoured; granting more is refused', () => {
  const s = setup();
  const r = s.server.authorize(authReq({ scope: 'openid read profile' }), ALICE);
  assert.equal(r.kind, 'consent');
  if (r.kind !== 'consent') return;
  const d = redirectOf(s.server.deny(r.request));
  assert.equal(d.searchParams.get('error'), 'access_denied');
  assert.equal(d.searchParams.get('state'), 'xyz');
  assert.throws(() => s.server.approve(r.request, ALICE, ['openid', 'write']), (e: Error) => e instanceof OAuthError && e.code === 'invalid_scope');
  const code = redirectOf(s.server.approve(r.request, ALICE, ['openid'])).searchParams.get('code')!;
  const tok = exchange(s, code);
  assert.equal(tok.body.scope, 'openid');
});

test('the code exchange issues a JWT access token, a refresh token and an ID token with nonce and at_hash, with no-store headers', () => {
  const s = setup();
  const res = exchange(s, getCode(s));
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const b = res.body as Record<string, string | number>;
  assert.equal(b.token_type, 'Bearer');
  assert.equal(b.expires_in, 600);
  assert.equal(b.scope, 'openid read');
  const at = s.server.verifyAccessToken(String(b.access_token));
  assert.deepEqual([at.sub, at.clientId, at.scopes], ['alice', 'web', ['openid', 'read']]);
  const keys = [{ alg: 'HS256' as const, key: 'a-signing-secret-of-decent-length', kid: 'k1' }];
  const idt = verifyJwt(String(b.id_token), keys, { now: s.t.v, issuer: 'https://as.example.org', audience: 'web' });
  assert.equal(idt.sub, 'alice');
  assert.equal(idt.nonce, 'n-1');
  assert.equal(idt.auth_time, 1_800_000_000);
  assert.equal(idt.at_hash, createHash('sha256').update(String(b.access_token)).digest().subarray(0, 16).toString('base64url'));
  assert.ok(b.refresh_token);
  const noOpenid = exchange(s, getCode(s, { scope: 'read' }));
  assert.equal(noOpenid.body.id_token, undefined);
});

test('a wrong verifier, redirect, client, expiry or missing parameter fails the exchange with invalid_grant or invalid_request', () => {
  const s = setup();
  const bad = (r: ReturnType<typeof exchange>, err: string, status = 400) => {
    assert.equal(r.body.error, err, JSON.stringify(r.body));
    assert.equal(r.status, status);
  };
  bad(exchange(s, getCode(s), { code_verifier: 'x'.repeat(43) }), 'invalid_grant');
  bad(exchange(s, getCode(s), { code_verifier: 'short' }), 'invalid_grant');
  bad(exchange(s, getCode(s), { redirect_uri: 'https://app.example.org/other' }), 'invalid_grant');
  bad(exchange(s, 'not-a-code'), 'invalid_grant');
  const c = getCode(s);
  s.t.v += 61_000;
  bad(exchange(s, c), 'invalid_grant');
  bad(s.server.token({ authorization: s.webAuth, body: { grant_type: 'authorization_code', code_verifier: VERIFIER } }), 'invalid_request');
  bad(s.server.token({ authorization: s.webAuth, body: { grant_type: 'authorization_code', code: 'x' } }), 'invalid_request');
  bad(s.server.token({ authorization: s.webAuth, body: {} }), 'invalid_request');
  bad(s.server.token({ authorization: s.webAuth, body: { grant_type: 'password', username: 'a', password: 'b' } }), 'unsupported_grant_type');
  bad(s.server.token({ authorization: s.basic('web', 'wrong'), body: { grant_type: 'authorization_code', code: 'x', code_verifier: VERIFIER } }), 'invalid_client', 401);
});

test('a code is single use, and presenting it again revokes the tokens it produced', () => {
  const s = setup();
  const code = getCode(s);
  const first = exchange(s, code);
  const access = String(first.body.access_token);
  assert.equal(s.server.verifyAccessToken(access).sub, 'alice');
  const again = exchange(s, code);
  assert.equal(again.body.error, 'invalid_grant');
  assert.throws(() => s.server.verifyAccessToken(access), (e: Error) => e instanceof OAuthError && e.code === 'invalid_token');
  assert.equal(s.server.familyRevoked(String(first.body.refresh_token)), true);
});

test("a code issued to one client does not work for another", () => {
  const s = setup();
  const codeForWeb = getCode(s);
  const r = s.server.token({ authorization: undefined, body: { grant_type: 'authorization_code', client_id: 'native', code: codeForWeb, redirect_uri: 'https://app.example.org/cb', code_verifier: VERIFIER } });
  assert.equal(r.body.error, 'invalid_grant');
});

test('a public client uses PKCE alone, and a loopback redirect on any port works', () => {
  const s = setup();
  const r = s.server.authorize({ client_id: 'native', redirect_uri: 'http://127.0.0.1:50123/cb', response_type: 'code', scope: 'read', code_challenge: CHALLENGE, code_challenge_method: 'S256' }, ALICE);
  assert.equal(r.kind, 'consent');
  if (r.kind !== 'consent') return;
  const u = redirectOf(s.server.approve(r.request, ALICE));
  assert.equal(u.host, '127.0.0.1:50123');
  const tok = s.server.token({ body: { grant_type: 'authorization_code', client_id: 'native', code: u.searchParams.get('code')!, redirect_uri: 'http://127.0.0.1:50123/cb', code_verifier: VERIFIER } });
  assert.equal(tok.status, 200);
  const noVerifier = s.server.token({ body: { grant_type: 'authorization_code', client_id: 'native', code: 'x' } });
  assert.equal(noVerifier.body.error, 'invalid_request');
});

test('refresh tokens rotate; a used one presented again revokes the family and every access token in it', () => {
  const s = setup();
  const first = exchange(s, getCode(s)).body;
  const rt1 = String(first.refresh_token);
  const second = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt1 } });
  assert.equal(second.status, 200);
  const rt2 = String(second.body.refresh_token);
  assert.notEqual(rt2, rt1);
  assert.equal(s.server.verifyAccessToken(String(second.body.access_token)).sub, 'alice');
  const replay = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt1 } });
  assert.equal(replay.body.error, 'invalid_grant');
  const after = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt2 } });
  assert.equal(after.body.error, 'invalid_grant', 'the newest token died with the family');
  assert.throws(() => s.server.verifyAccessToken(String(second.body.access_token)), /revoked/);
  assert.throws(() => s.server.verifyAccessToken(String(first.access_token)), /revoked/);
});

test('refresh: a parallel retry inside the grace window is refused without killing the family', () => {
  const s = setup({ reuseGraceMs: 2000 });
  const rt1 = String(exchange(s, getCode(s)).body.refresh_token);
  const a = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt1 } });
  s.t.v += 500;
  assert.equal(s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt1 } }).body.error, 'invalid_grant');
  assert.equal(s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: String(a.body.refresh_token) } }).status, 200, 'the family lives');
  s.t.v += 5000;
  s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt1 } });
  assert.equal(s.server.familyRevoked(rt1), true, 'a late replay is theft');
});

test('refresh: scope may narrow but never widen, idle and absolute lifetimes end it, another client cannot use it', () => {
  const s = setup({ refreshIdleSec: 100, refreshAbsoluteSec: 250 });
  const rt = String(exchange(s, getCode(s, { scope: 'read write' })).body.refresh_token);
  const narrow = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt, scope: 'read' } });
  assert.equal(narrow.body.scope, 'read');
  const rt2 = String(narrow.body.refresh_token);
  const wide = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt2, scope: 'read admin' } });
  assert.equal(wide.body.error, 'invalid_scope');
  s.t.v += 90_000;
  const step = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: rt2 } });
  assert.equal(step.status, 200, 'used inside the idle time');
  s.t.v += 90_000;
  const third = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: String(step.body.refresh_token) } });
  assert.equal(third.status, 200);
  s.t.v += 90_000;
  const fourth = s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: String(third.body.refresh_token) } });
  assert.equal(fourth.body.error, 'invalid_grant', 'the absolute lifetime of 250 seconds has passed');
  const s2 = setup();
  const rt3 = String(exchange(s2, getCode(s2)).body.refresh_token);
  assert.equal(s2.server.token({ body: { grant_type: 'refresh_token', client_id: 'native', refresh_token: rt3 } }).body.error, 'invalid_grant');
  assert.equal(s2.server.familyRevoked(rt3), true, 'a token shown by the wrong client is treated as stolen');
});

test('client credentials: confidential clients only, scopes limited, no refresh token and no ID token', () => {
  const s = setup();
  const r = s.server.token({ authorization: s.webAuth, body: { grant_type: 'client_credentials', scope: 'read' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.refresh_token, undefined);
  assert.equal(r.body.id_token, undefined);
  const a = s.server.verifyAccessToken(String(r.body.access_token));
  assert.deepEqual([a.sub, a.scopes], ['web', ['read']]);
  assert.equal(s.server.token({ authorization: s.webAuth, body: { grant_type: 'client_credentials', scope: 'openid' } }).body.error, 'invalid_scope');
  assert.equal(s.server.token({ authorization: s.webAuth, body: { grant_type: 'client_credentials', scope: 'bogus' } }).body.error, 'invalid_scope');
  assert.equal(s.server.token({ body: { grant_type: 'client_credentials', client_id: 'native' } }).body.error, 'unauthorized_client');
});

test('device flow: codes in the RFC 8628 shape, pending, slow_down, approval, single use', () => {
  const s = setup();
  const dev = s.server.deviceAuthorization({ body: { client_id: 'tv', scope: 'read' } });
  assert.equal(dev.status, 200);
  const d = dev.body as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };
  assert.match(d.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(d.verification_uri, 'https://as.example.org/device');
  assert.equal(d.verification_uri_complete, `https://as.example.org/device?user_code=${d.user_code}`);
  assert.deepEqual([d.expires_in, d.interval], [600, 5]);
  const poll = () => s.server.token({ body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'tv', device_code: d.device_code } });
  assert.equal(poll().body.error, 'slow_down', 'polling at once is too fast');
  s.t.v += 11_000;
  assert.equal(poll().body.error, 'authorization_pending');
  s.t.v += 11_000;
  const looked = s.server.lookupUserCode(` ${d.user_code.toLowerCase().replace('-', ' ')} `, 'ip1');
  assert.equal(looked.client.clientId, 'tv');
  assert.deepEqual(looked.scopes, [{ name: 'read', description: 'Read your data' }]);
  s.server.approveDevice(d.user_code, ALICE, 'ip1');
  const ok = poll();
  assert.equal(ok.status, 200);
  assert.equal(s.server.verifyAccessToken(String(ok.body.access_token)).sub, 'alice');
  assert.ok(ok.body.refresh_token);
  s.t.v += 11_000;
  assert.equal(poll().body.error, 'invalid_grant', 'the device code is spent');
});

test('device flow: denial, expiry, another client, and a locked-out guesser', () => {
  const s = setup();
  const start = () => (s.server.deviceAuthorization({ body: { client_id: 'tv' } }).body as { device_code: string; user_code: string });
  const poll = (code: string, client = 'tv') => s.server.token({ body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: client, device_code: code } });
  const a = start();
  s.server.denyDevice(a.user_code, 'ip1');
  s.t.v += 6000;
  assert.equal(poll(a.device_code).body.error, 'access_denied');
  const b = start();
  s.t.v += 6000;
  assert.equal(poll(b.device_code, 'native').body.error, 'invalid_grant');
  s.t.v += 601_000;
  assert.equal(poll(b.device_code).body.error, 'expired_token');
  const s2 = setup({ deviceTtlSec: 5000 });
  const c = s2.server.deviceAuthorization({ body: { client_id: 'tv' } }).body as { device_code: string; user_code: string };
  for (let i = 0; i < 5; i++) assert.throws(() => s2.server.lookupUserCode('BBBB-BBBB', 'evil'), (e: Error) => e instanceof OAuthError && e.code === 'invalid_grant');
  assert.throws(() => s2.server.lookupUserCode(c.user_code, 'evil'), (e: Error) => e instanceof OAuthError && e.status === 429, 'even the right code is refused during the lockout');
  assert.equal(s2.server.lookupUserCode(c.user_code, 'honest').client.clientId, 'tv', 'another source is unaffected');
  s2.t.v += 901_000;
  assert.equal(s2.server.lookupUserCode(c.user_code, 'evil').client.clientId, 'tv', 'the lockout ends');
  assert.equal(s.server.deviceAuthorization({ body: { client_id: 'web' } }).status, 401, 'a confidential client must authenticate');
  assert.equal(s.server.deviceAuthorization({ body: { client_id: 'tv', scope: 'admin' } }).body.error, 'invalid_scope');
});

test('scope model: implications expand, unknown and unregistered scopes are refused', () => {
  const s = setup();
  assert.deepEqual(s.server.expandScopes(['admin']).sort(), ['admin', 'read', 'write']);
  assert.deepEqual(s.server.expandScopes(['read']), ['read']);
  assert.deepEqual(s.server.expandScopes([]), []);
  const client = s.registry.get('native')!;
  assert.deepEqual(s.server.parseScopes('read read profile', client), ['read', 'profile']);
  assert.throws(() => s.server.parseScopes('admin', client), /may not ask for the scope admin/);
  assert.throws(() => s.server.parseScopes('nothing', client), /not known/);
  assert.deepEqual(s.server.parseScopes(undefined, client), []);
});

test('revocation: a refresh token ends its grant, an access token ends itself, other clients and strangers change nothing', () => {
  const s = setup();
  const t = exchange(s, getCode(s)).body;
  const other = s.registry.create({ name: 'Other', clientId: 'other', redirectUris: ['https://o.example.org/cb'] });
  const otherAuth = s.basic('other', other.secret!);
  assert.equal(s.server.revoke({ authorization: otherAuth, body: { token: String(t.access_token) } }).status, 200);
  assert.equal(s.server.verifyAccessToken(String(t.access_token)).sub, 'alice', 'not theirs to revoke');
  assert.equal(s.server.revoke({ authorization: s.webAuth, body: { token: 'garbage' } }).status, 200);
  assert.equal(s.server.revoke({ authorization: s.webAuth, body: { token: String(t.access_token) } }).status, 200);
  assert.throws(() => s.server.verifyAccessToken(String(t.access_token)), /revoked/);
  assert.equal(s.server.revoke({ authorization: s.webAuth, body: { token: String(t.refresh_token) } }).status, 200);
  assert.equal(s.server.token({ authorization: s.webAuth, body: { grant_type: 'refresh_token', refresh_token: String(t.refresh_token) } }).body.error, 'invalid_grant');
  assert.equal(s.server.revoke({ authorization: s.basic('web', 'bad'), body: { token: 'x' } }).status, 401);
  assert.equal(s.server.revoke({ authorization: s.webAuth, body: {} }).body.error, 'invalid_request');
});

test('introspection reports live tokens and says only "inactive" for everything else; revokeSubject ends all of a person\'s grants', () => {
  const s = setup();
  const t = exchange(s, getCode(s)).body;
  const live = s.server.introspect(String(t.access_token));
  assert.deepEqual([live.active, live.scope, live.client_id, live.sub], [true, 'openid read', 'web', 'alice']);
  assert.equal(s.server.introspect(String(t.refresh_token)).active, true);
  assert.deepEqual(s.server.introspect('nonsense'), { active: false });
  assert.equal(s.server.revokeSubject('alice'), 1);
  assert.equal(s.server.revokeSubject('alice'), 0);
  assert.deepEqual(s.server.introspect(String(t.access_token)), { active: false });
  assert.deepEqual(s.server.introspect(String(t.refresh_token)), { active: false });
});

test('access tokens expire, and tokens signed by a retired key still verify while the key is listed', () => {
  const s = setup();
  const t = exchange(s, getCode(s)).body;
  s.t.v += 601_000;
  assert.throws(() => s.server.verifyAccessToken(String(t.access_token)), /expired/);
  const old = setup();
  const issued = exchange(old, getCode(old)).body;
  const rotated = new AuthorizationServer({
    issuer: 'https://as.example.org', registry: old.registry, signing: { alg: 'HS256', key: 'a-brand-new-signing-secret-here!', kid: 'k2' }, scopes: SCOPES,
    now: () => old.t.v, randomBytes: counter(), oldKeys: [{ alg: 'HS256', kid: 'k1', key: 'a-signing-secret-of-decent-length' }],
  });
  assert.equal(rotated.verifyAccessToken(String(issued.access_token)).sub, 'alice', 'a server that never saw the token still accepts it by its signature');
});

test('query parameters given twice are refused', () => {
  assert.deepEqual({ ...parseParams('a=1&b=2') }, { a: '1', b: '2' });
  assert.throws(() => parseParams('scope=read&scope=admin'), (e: Error) => e instanceof OAuthError && /more than once/.test(e.message));
});
