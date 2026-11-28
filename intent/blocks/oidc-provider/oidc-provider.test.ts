import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  ConfigError, JwtError, KeySet, OAuthError, Provider, WELL_KNOWN, frontchannelPage, halfHash, mapClaims, memoryStore, pkceChallenge, sendBackchannel, validateLogoutToken, verifyJws,
} from './index.ts';
import type { Account, Authn, ErrorResponse, Jwk, ProviderOptions, TokenResponse } from './index.ts';

const ISS = 'https://id.example.com';
const NOW0 = 1_800_000_000_000;
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const rsa = KeySet.generate('RS256', 'rs-1');
const ec = KeySet.generate('ES256', 'es-1');

const ANA: Account = { sub: 'u-ana', attributes: { name: 'Ana Silva', given_name: 'Ana', family_name: 'Silva', email: 'ana@example.com', email_verified: true, phone_number: '+351 000', address: { country: 'PT', locality: 'Porto' }, updated_at: 1_700_000_000, profile: { dept: 'ops' }, extra: { badge: 'B-7' } } };
const accounts = new Map<string, Account>([[ANA.sub, ANA], ['u-bob', { sub: 'u-bob', attributes: { name: 'Bob' } }], ['u-off', { sub: 'u-off', attributes: {}, disabled: true }]]);

interface Rig { p: Provider; clock: { t: number }; store: ReturnType<typeof memoryStore> }
function rig(o: Partial<ProviderOptions> = {}, keys = new KeySet([rsa, ec])): Rig {
  const clock = { t: NOW0 };
  let n = 0;
  const store = memoryStore();
  const p = new Provider({ issuer: ISS, keys, accounts: { get: (s) => accounts.get(s) }, now: () => clock.t, random: (k) => createHash('sha256').update(`r${n++}`).digest().subarray(0, k), store, ...o });
  p.registerClient({ id: 'web', secret: 'web-secret-01234', redirectUris: ['https://app.example.org/cb'], postLogoutRedirectUris: ['https://app.example.org/bye'], scopes: ['profile', 'email', 'phone', 'address'], allowRefresh: true });
  p.registerClient({ id: 'spa', redirectUris: ['https://spa.example.org/cb'], authMethod: 'none', scopes: ['profile'] });
  return { p, clock, store };
}
const authn = (o: Partial<Authn> = {}): Authn => ({ sub: 'u-ana', sid: 'sid-1', authTime: NOW0 / 1000 - 5, ...o });
const q = (o: Record<string, string>) => new URLSearchParams({ client_id: 'web', redirect_uri: 'https://app.example.org/cb', response_type: 'code', scope: 'openid profile email', state: 'xyz', nonce: 'n-0S6_WzA2Mj', code_challenge: CHALLENGE, code_challenge_method: 'S256', ...o });
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
const codeFrom = (url: string): string => new URL(url).searchParams.get('code')!;
function login(r: Rig, over: Record<string, string> = {}, who: Partial<Authn> = {}): string {
  const res = r.p.authorize(q(over), authn(who), { consented: true });
  assert.equal(res.kind, 'redirect');
  return res.kind === 'redirect' ? res.url : '';
}
const WEB = { authorization: basic('web', 'web-secret-01234') };
const exchange = (r: Rig, code: string, extra: Record<string, string> = {}): TokenResponse => r.p.token({ ...WEB, body: { grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.org/cb', code_verifier: VERIFIER, ...extra } });
const fails = (f: () => unknown, code: string, re?: RegExp) => assert.throws(f, (e: unknown) => e instanceof OAuthError && e.code === code && (re === undefined || re.test(e.description)), code);

test('published vectors: RFC 7515 A.3 ES256 verifies, RFC 7636 PKCE challenge, Core at_hash', () => {
  const jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }] };
  // RFC 7515 A.3: header and payload are built from the RFC's JSON texts; the ES256 signature segment is the RFC's published one.
  const b64j = (s: string) => Buffer.from(s).toString('base64url');
  const tok = `${b64j('{"alg":"ES256"}')}.${b64j('{"iss":"joe",\r\n "exp":1300819380,\r\n "http://example.com/is_root":true}')}.DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q`;
  assert.equal(verifyJws(tok, jwks).payload.iss, 'joe');
  assert.throws(() => verifyJws(`${tok.slice(0, -2)}AA`, jwks), /does not verify/);
  assert.equal(pkceChallenge(VERIFIER), CHALLENGE);
  assert.equal(halfHash('jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y'), '77QmUPtjPfzWtF2AnpK9RQ');
});

test('signing and verifying with RS256 and ES256, and the keys that are published', () => {
  const ks = new KeySet([rsa, ec]);
  for (const alg of ['RS256', 'ES256'] as const) {
    const t = ks.sign({ a: 1 }, alg);
    const v = ks.verify(t);
    assert.deepEqual([v.header.alg, v.header.kid, v.header.typ, v.payload.a], [alg, alg === 'RS256' ? 'rs-1' : 'es-1', 'JWT', 1]);
    assert.equal(t.split('.')[2]!.length, alg === 'ES256' ? 86 : 342, 'ES256 signatures are the raw 64 bytes, RS256 256 bytes');
  }
  const set = ks.jwks();
  assert.deepEqual(set.keys.map((k) => [k.kid, k.kty, k.alg, k.use]), [['rs-1', 'RSA', 'RS256', 'sig'], ['es-1', 'EC', 'ES256', 'sig']]);
  for (const k of set.keys) for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(secret in k, false, `no private member ${secret}`);
  assert.throws(() => ks.verify(ks.sign({}, 'RS256'), ['ES256']), /not accepted/);
});

test('hostile tokens: none, algorithm confusion, tampering, unknown key, critical headers', () => {
  const ks = new KeySet([rsa, ec]);
  const good = ks.sign({ sub: 'x' }, 'RS256');
  const [h, p] = good.split('.');
  assert.throws(() => ks.verify(`${b64({ alg: 'none', kid: 'rs-1' })}.${p}.`), /not accepted/);
  const pub = (rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const hs = `${b64({ alg: 'HS256', kid: 'rs-1' })}.${p}`;
  assert.throws(() => ks.verify(`${hs}.${createHmac('sha256', pub).update(hs).digest('base64url')}`), /not accepted/, 'HS256 with key material as the secret');
  assert.throws(() => ks.verify(`${h}.${b64({ sub: 'admin' })}.${good.split('.')[2]}`), /does not verify/);
  assert.throws(() => ks.verify(`${b64({ alg: 'RS256', kid: 'nope' })}.${p}.${good.split('.')[2]}`), /no key matches/);
  assert.throws(() => ks.verify(`${b64({ alg: 'ES256', kid: 'rs-1' })}.${p}.${good.split('.')[2]}`), /no key matches/, 'a key is only used with its own algorithm');
  assert.throws(() => ks.verify(`${b64({ alg: 'RS256', kid: 'rs-1', crit: ['x'] })}.${p}.${good.split('.')[2]}`), /critical/);
  assert.throws(() => ks.verify('a.b'), JwtError);
  assert.throws(() => ks.verify('x'.repeat(20_000)), /too long/);
});

test('keys rotate: the new key signs, the old one still verifies until removed', () => {
  const ks = new KeySet([rsa]);
  const old = ks.sign({ n: 1 }, 'RS256');
  ks.rotate(KeySet.generate('RS256', 'rs-2'));
  const fresh = ks.sign({ n: 2 }, 'RS256');
  assert.equal(ks.verify(fresh).header.kid, 'rs-2');
  assert.equal(ks.verify(old).header.kid, 'rs-1');
  assert.deepEqual(ks.jwks().keys.map((k) => k.kid), ['rs-1', 'rs-2']);
  assert.throws(() => ks.remove('rs-2'), /rotate first/);
  ks.remove('rs-1');
  assert.throws(() => ks.verify(old), /no key matches/);
  assert.throws(() => ks.rotate({ ...rsa, kid: 'rs-2' }), /already in use/);
  assert.throws(() => new KeySet([]), ConfigError);
  assert.throws(() => KeySet.fromPem('ES256', 'k', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string), /not suitable/);
});

test('discovery lists what is supported and the issuer is checked', () => {
  const d = rig().p.discovery();
  assert.equal(WELL_KNOWN, '/.well-known/openid-configuration');
  assert.deepEqual([d.issuer, d.authorization_endpoint, d.token_endpoint, d.userinfo_endpoint, d.jwks_uri, d.end_session_endpoint], [ISS, `${ISS}/authorize`, `${ISS}/token`, `${ISS}/userinfo`, `${ISS}/jwks`, `${ISS}/logout`]);
  assert.deepEqual([d.response_types_supported, d.code_challenge_methods_supported, d.id_token_signing_alg_values_supported, d.subject_types_supported], [['code'], ['S256'], ['RS256', 'ES256'], ['public']]);
  assert.deepEqual([d.backchannel_logout_supported, d.backchannel_logout_session_supported, d.frontchannel_logout_supported, d.request_parameter_supported, d.authorization_response_iss_parameter_supported], [true, true, true, false, true]);
  assert.ok((d.claims_supported as string[]).includes('email_verified') && (d.scopes_supported as string[]).includes('offline_access'));
  assert.deepEqual(rig({ pairwiseSalt: 's' }).p.discovery().subject_types_supported, ['public', 'pairwise']);
  const mk = (issuer: string, extra = {}) => () => new Provider({ issuer, keys: new KeySet([rsa]), accounts: { get: () => undefined }, now: () => 0, ...extra });
  assert.throws(mk('http://id.example.com'), /https/);
  assert.throws(mk('https://id.example.com/'), /slash/);
  assert.throws(mk('https://id.example.com?x=1'), /query/);
  assert.throws(mk('not a url'), /absolute/);
  mk('http://localhost:8080', { allowHttpLoopback: true })();
});

test('client registration refuses unsafe redirect URIs and weak setups', () => {
  const r = rig();
  const bad = (c: Parameters<Provider['registerClient']>[0], re: RegExp) => assert.throws(() => r.p.registerClient(c), (e: unknown) => e instanceof ConfigError && re.test(e.message));
  bad({ id: 'a', redirectUris: ['http://evil.example/cb'], authMethod: 'none' }, /https/);
  bad({ id: 'a', redirectUris: ['https://x.example/cb#frag'], authMethod: 'none' }, /fragment/);
  bad({ id: 'a', redirectUris: ['https://*.example/cb'], authMethod: 'none' }, /wildcards/);
  bad({ id: 'a', redirectUris: ['https://u:p@x.example/cb'], authMethod: 'none' }, /credentials/);
  bad({ id: 'a', redirectUris: ['/relative'], authMethod: 'none' }, /absolute/);
  bad({ id: 'a', redirectUris: [], authMethod: 'none' }, /1 to 10/);
  bad({ id: 'a', redirectUris: ['https://x.example/cb'], secret: 'short' }, /at least 16/);
  bad({ id: 'a', redirectUris: ['https://x.example/cb'], authMethod: 'none', secret: 'x'.repeat(20) }, /no secret/);
  bad({ id: 'a b', redirectUris: ['https://x.example/cb'], authMethod: 'none' }, /client id/);
  bad({ id: 'web', redirectUris: ['https://x.example/cb'], authMethod: 'none' }, /already exists/);
  bad({ id: 'a', redirectUris: ['https://x.example/cb'], authMethod: 'none', scopes: ['wizard'] }, /unknown scope/);
  bad({ id: 'a', redirectUris: ['https://x.example/cb'], authMethod: 'none', subjectType: 'pairwise' }, /pairwiseSalt/);
  bad({ id: 'a', redirectUris: ['https://x.example/cb'], authMethod: 'none', idTokenAlg: 'ES256' as const, backchannelLogoutUri: 'http://x.example/bc' }, /https/);
  assert.throws(() => rig({ pairwiseSalt: 's' }).p.registerClient({ id: 'm', redirectUris: ['https://a.example/cb', 'https://b.example/cb'], authMethod: 'none', subjectType: 'pairwise' }), /sectorIdentifier/);
});

test('an authorization request is answered with a code, the state and the issuer', () => {
  const r = rig();
  const res = r.p.authorize(q({}), authn(), { consented: true });
  assert.equal(res.kind, 'redirect');
  const u = new URL((res as { url: string }).url);
  assert.deepEqual([u.origin + u.pathname, u.searchParams.get('state'), u.searchParams.get('iss'), u.searchParams.get('code')!.length], ['https://app.example.org/cb', 'xyz', ISS, 43]);
});

test('requests that cannot be trusted get an error page, never a redirect', () => {
  const r = rig();
  const page = (p: URLSearchParams) => { const x = r.p.authorize(p, authn()); assert.equal(x.kind, 'error'); return x.kind === 'error' ? x.error : ''; };
  assert.equal(page(q({ client_id: 'ghost' })), 'invalid_client');
  assert.equal(page(new URLSearchParams({ redirect_uri: 'https://app.example.org/cb' })), 'invalid_client');
  assert.equal(page(q({ redirect_uri: 'https://app.example.org/cb/../evil' })), 'invalid_request');
  assert.equal(page(q({ redirect_uri: 'https://app.example.org/cb?x=1' })), 'invalid_request', 'no partial matching');
  assert.equal(page(q({ redirect_uri: 'https://APP.example.org/cb' })), 'invalid_request');
  const dup = new URLSearchParams(q({}).toString() + '&scope=openid+email');
  assert.equal(page(dup), 'invalid_request');
});

test('requests with a trusted redirect but a bad request come back as OAuth errors on that redirect', () => {
  const r = rig();
  const err = (over: Record<string, string>, drop: string[] = []) => {
    const p = q(over); for (const d of drop) p.delete(d);
    const x = r.p.authorize(p, authn(), { consented: true });
    assert.equal(x.kind, 'redirect', JSON.stringify(over));
    const u = new URL((x as { url: string }).url);
    assert.equal(u.searchParams.get('iss'), ISS);
    return [u.searchParams.get('error'), u.searchParams.get('state')];
  };
  assert.deepEqual(err({ response_type: 'token' }), ['unsupported_response_type', 'xyz']);
  assert.deepEqual(err({ response_type: 'code id_token' }), ['unsupported_response_type', 'xyz']);
  assert.deepEqual(err({ scope: 'profile' }), ['invalid_scope', 'xyz']);
  assert.deepEqual(err({}, ['code_challenge', 'code_challenge_method']), ['invalid_request', 'xyz'], 'PKCE is required');
  assert.deepEqual(err({ code_challenge_method: 'plain' }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ code_challenge: 'short' }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ request: 'eyJ...' }), ['request_not_supported', 'xyz']);
  assert.deepEqual(err({ request_uri: 'https://x/r' }), ['request_uri_not_supported', 'xyz']);
  assert.deepEqual(err({ response_mode: 'fragment' }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ prompt: 'none login' }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ prompt: 'surprise' }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ max_age: '-1' }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ nonce: 'n'.repeat(256) }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ claims: '{nope' }), ['invalid_request', 'xyz']);
  assert.deepEqual(err({ claims: '{"userinfo":{"email":5}}' }), ['invalid_request', 'xyz']);
});

test('login, re-authentication, max_age, prompt=none and consent decide what happens next', () => {
  const r = rig();
  const bob = () => authn({ sub: 'u-bob' });
  const kind = (over: Record<string, string>, a: Authn | null, o = {}) => { const x = r.p.authorize(q(over), a, o); return x.kind === 'redirect' ? new URL(x.url).searchParams.get('error') ?? 'code' : x.kind === 'login' ? `login:${x.reason}` : x.kind; };
  assert.equal(kind({}, null), 'login:none');
  assert.equal(kind({ prompt: 'none' }, null), 'login_required');
  assert.equal(kind({}, authn({ authTime: NOW0 / 1000 - 400 }), { consented: true }), 'code', 'an old login is fine unless asked otherwise');
  assert.equal(kind({ prompt: 'login' }, authn({ authTime: NOW0 / 1000 - 400 })), 'login:prompt');
  assert.equal(kind({ prompt: 'login' }, authn({ authTime: NOW0 / 1000 - 10 }), { consented: true }), 'code', 'a login a moment ago counts as the one asked for');
  assert.equal(kind({ max_age: '60' }, authn({ authTime: NOW0 / 1000 - 400 })), 'login:max_age');
  assert.equal(kind({ max_age: '600' }, authn({ authTime: NOW0 / 1000 - 400 }), { consented: true }), 'code');
  assert.equal(kind({}, bob()), 'consent');
  assert.equal(kind({ prompt: 'none' }, bob()), 'consent_required');
  const x = r.p.authorize(q({ scope: 'openid profile email phone' }), bob());
  assert.deepEqual(x.kind === 'consent' && [x.clientName, x.scopes], ['web', ['profile', 'email', 'phone']]);
  assert.equal(kind({}, bob(), { consented: true }), 'code');
  assert.equal(kind({}, bob()), 'code', 'the agreement is remembered');
  assert.equal(kind({ scope: 'openid profile email address' }, bob()), 'consent', 'but only for the scopes it covered');
  assert.equal(kind({ prompt: 'consent' }, bob()), 'consent');
});

test('the code is exchanged for an access token and an ID token that a client can verify', () => {
  const r = rig();
  const res = exchange(r, codeFrom(login(r)));
  assert.deepEqual(res.headers, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  const b = res.body as { access_token: string; token_type: string; expires_in: number; scope: string; id_token: string; refresh_token?: string };
  assert.deepEqual([b.token_type, b.expires_in, b.scope, b.refresh_token], ['Bearer', 600, 'openid profile email', undefined]);
  const { header, payload } = verifyJws(b.id_token, r.p.jwks());
  assert.deepEqual([header.alg, header.kid], ['RS256', 'rs-1']);
  assert.deepEqual(payload, { iss: ISS, sub: 'u-ana', aud: 'web', exp: NOW0 / 1000 + 600, iat: NOW0 / 1000, auth_time: NOW0 / 1000 - 5, at_hash: halfHash(b.access_token), sid: 'sid-1', nonce: 'n-0S6_WzA2Mj' });
});

test('a code works once, for its client, redirect URI and verifier; reuse revokes what it produced', () => {
  const r = rig();
  const code = codeFrom(login(r));
  fails(() => exchange(r, code, { code_verifier: 'x'.repeat(43) }), 'invalid_grant', /does not match/);
  const code2 = codeFrom(login(r));
  fails(() => exchange(r, code2, { redirect_uri: 'https://app.example.org/other' }), 'invalid_grant', /redirect_uri/);
  const code3 = codeFrom(login(r));
  fails(() => exchange(r, code3, { code_verifier: 'short' }), 'invalid_grant', /malformed/);
  const code4 = codeFrom(login(r));
  const ok = exchange(r, code4).body as { access_token: string };
  assert.equal(r.p.userinfo(`Bearer ${ok.access_token}`).body.sub, 'u-ana');
  fails(() => exchange(r, code4), 'invalid_grant', /already used/);
  fails(() => r.p.userinfo(`Bearer ${ok.access_token}`), 'invalid_token');
  const code5 = codeFrom(login(r));
  r.clock.t += 61_000;
  fails(() => exchange(r, code5), 'invalid_grant', /expired/);
  fails(() => exchange(r, 'made-up'), 'invalid_grant');
  fails(() => r.p.token({ ...WEB, body: { grant_type: 'authorization_code', redirect_uri: 'https://app.example.org/cb', code_verifier: VERIFIER } }), 'invalid_grant', /missing/);
  const other = codeFrom(login(r, { client_id: 'spa', redirect_uri: 'https://spa.example.org/cb' }));
  fails(() => exchange(r, other), 'invalid_grant', /another client/);
});

test('clients authenticate by the one method they registered', () => {
  const r = rig();
  const body = (code: string, extra: Record<string, string> = {}) => ({ grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.org/cb', code_verifier: VERIFIER, ...extra });
  fails(() => r.p.token({ authorization: basic('web', 'wrong-secret-0123456789'), body: body(codeFrom(login(r))) }), 'invalid_client');
  fails(() => r.p.token({ body: body(codeFrom(login(r)), { client_id: 'web' }) }), 'invalid_client', /failed/);
  fails(() => r.p.token({ body: body(codeFrom(login(r)), { client_id: 'web', client_secret: 'web-secret-01234' }) }), 'invalid_client', /failed/);
  fails(() => r.p.token({ authorization: basic('ghost', 'x'), body: body('c') }), 'invalid_client');
  fails(() => r.p.token({ authorization: 'Basic !!!', body: body('c') }), 'invalid_client');
  const spa = (code: string, extra: Record<string, string> = {}) => r.p.token({ body: { grant_type: 'authorization_code', code, redirect_uri: 'https://spa.example.org/cb', code_verifier: VERIFIER, client_id: 'spa', ...extra } });
  const sc = () => codeFrom(login(r, { client_id: 'spa', redirect_uri: 'https://spa.example.org/cb' }));
  assert.equal(spa(sc()).status, 200);
  fails(() => r.p.token({ authorization: basic('spa', 'anything'), body: { grant_type: 'authorization_code', code: sc(), redirect_uri: 'https://spa.example.org/cb', code_verifier: VERIFIER } }), 'invalid_client');
  const e = r.p.tokenResponse({ authorization: basic('web', 'wrong-secret-0123456789'), body: body('x') }) as ErrorResponse;
  assert.deepEqual([e.status, e.body.error, e.headers['WWW-Authenticate'], e.headers['Cache-Control']], [401, 'invalid_client', 'Basic realm="token"', 'no-store']);
  fails(() => r.p.token({ ...WEB, body: { grant_type: 'password', username: 'a', password: 'b' } }), 'unsupported_grant_type');
  fails(() => r.p.token({ ...WEB, body: new URLSearchParams('grant_type=authorization_code&grant_type=refresh_token') }), 'invalid_request', /repeated/);
  fails(() => r.p.token({ authorization: basic('spa', 'x'), body: { grant_type: 'refresh_token', refresh_token: 'x' } }), 'invalid_client');
});

test('UserInfo releases claims by scope, by the claims parameter, and drops values of the wrong type', () => {
  const r = rig();
  const get = (over: Record<string, string>) => { const t = exchange(r, codeFrom(login(r, over))).body as { access_token: string }; return r.p.userinfo(`Bearer ${t.access_token}`); };
  const base = get({});
  assert.deepEqual(base.headers, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  assert.deepEqual(base.body, { sub: 'u-ana', name: 'Ana Silva', given_name: 'Ana', family_name: 'Silva', updated_at: 1_700_000_000, email: 'ana@example.com', email_verified: true });
  assert.equal('phone_number' in base.body || 'address' in base.body, false, 'only the scopes that were granted');
  assert.deepEqual(get({ scope: 'openid' }).body, { sub: 'u-ana' });
  assert.deepEqual(get({ scope: 'openid phone address' }).body, { sub: 'u-ana', phone_number: '+351 000', address: { country: 'PT', locality: 'Porto' } });
  assert.deepEqual(get({ scope: 'openid', claims: JSON.stringify({ userinfo: { email: { essential: true }, given_name: null } }) }).body, { sub: 'u-ana', given_name: 'Ana', email: 'ana@example.com' });
  assert.deepEqual(get({ scope: 'openid profile secret_scope' }).body.sub, 'u-ana', 'unknown scopes are ignored');
  const typed: Account = { sub: 't', attributes: { name: 5, email: 'a@b', email_verified: 'yes', updated_at: '2020', address: 'home', nickname: '', phone_number: null } };
  assert.deepEqual(mapClaims(typed, ['name', 'email', 'email_verified', 'updated_at', 'address', 'nickname', 'phone_number', 'sub']), { email: 'a@b' });
});

test('UserInfo checks the token: header form, expiry, revocation, scope, account state', () => {
  const r = rig();
  const t = exchange(r, codeFrom(login(r))).body as { access_token: string };
  const err = (h: string | undefined) => { try { r.p.userinfo(h); } catch (e) { return e as OAuthError; } throw new Error('no error'); };
  assert.deepEqual([err(undefined).code, err(undefined).status], ['invalid_request', 401]);
  assert.equal(err(`Basic ${t.access_token}`).code, 'invalid_request');
  assert.equal(err('Bearer nonsense').code, 'invalid_token');
  assert.equal(err('Bearer nonsense').headers['WWW-Authenticate'], 'Bearer error="invalid_token"');
  assert.equal(r.p.userinfo(`bearer ${t.access_token}`).status, 200);
  accounts.set('u-ana', { ...ANA, disabled: true });
  assert.equal(err(`Bearer ${t.access_token}`).code, 'invalid_token');
  accounts.set('u-ana', ANA);
  r.clock.t += 601_000;
  assert.equal(err(`Bearer ${t.access_token}`).code, 'invalid_token', 'expired');
  const noOpenid = codeFrom(login(r, { scope: 'openid' }));
  const bare = exchange(r, noOpenid).body as { access_token: string };
  assert.deepEqual(r.p.userinfo(`Bearer ${bare.access_token}`).body, { sub: 'u-ana' });
});

test('claims can come from nested attributes, functions and custom scopes', () => {
  const r = rig({ claims: { sources: { department: 'profile.dept', badge: 'extra.badge', preferred_username: (a) => String(a.attributes.email).split('@')[0], name: 'name' }, scopes: { work: ['department', 'badge'] } } });
  r.p.registerClient({ id: 'hr', secret: 'hr-secret-01234ab', redirectUris: ['https://hr.example/cb'], scopes: ['profile', 'work'], firstParty: true });
  const code = codeFrom((r.p.authorize(q({ client_id: 'hr', redirect_uri: 'https://hr.example/cb', scope: 'openid profile work' }), authn()) as { url: string }).url);
  const t = r.p.token({ authorization: basic('hr', 'hr-secret-01234ab'), body: { grant_type: 'authorization_code', code, redirect_uri: 'https://hr.example/cb', code_verifier: VERIFIER } }).body as { access_token: string };
  const ui = r.p.userinfo(`Bearer ${t.access_token}`).body;
  assert.deepEqual([ui.department, ui.badge, ui.preferred_username, ui.name], ['ops', 'B-7', 'ana', 'Ana Silva']);
  const proto: Account = { sub: 'p', attributes: JSON.parse('{"__proto__":{"admin":true},"name":"P"}') as Record<string, unknown> };
  assert.deepEqual(mapClaims(proto, ['__proto__', 'name', 'constructor']), { name: 'P' });
  assert.equal(({} as Record<string, unknown>).admin, undefined);
});

test('claims asked for in the ID token (and, optionally, scope claims) are included', () => {
  const r = rig();
  const t = exchange(r, codeFrom(login(r, { claims: JSON.stringify({ id_token: { email: { essential: true } } }) }))).body as { id_token: string };
  assert.equal(verifyJws(t.id_token, r.p.jwks()).payload.email, 'ana@example.com');
  const plain = exchange(r, codeFrom(login(r))).body as { id_token: string };
  assert.equal('email' in verifyJws(plain.id_token, r.p.jwks()).payload, false, 'by default scope claims come from UserInfo');
  const r2 = rig({ claimsInIdToken: true });
  const full = exchange(r2, codeFrom(login(r2))).body as { id_token: string };
  assert.deepEqual([verifyJws(full.id_token, r2.p.jwks()).payload.email, verifyJws(full.id_token, r2.p.jwks()).payload.name], ['ana@example.com', 'Ana Silva']);
});

test('ES256 ID tokens for clients that ask for them', () => {
  const r = rig();
  r.p.registerClient({ id: 'ec', secret: 'ec-secret-01234ab', redirectUris: ['https://ec.example/cb'], idTokenAlg: 'ES256', firstParty: true });
  const code = codeFrom((r.p.authorize(q({ client_id: 'ec', redirect_uri: 'https://ec.example/cb' }), authn()) as { url: string }).url);
  const t = r.p.token({ authorization: basic('ec', 'ec-secret-01234ab'), body: { grant_type: 'authorization_code', code, redirect_uri: 'https://ec.example/cb', code_verifier: VERIFIER } }).body as { id_token: string };
  assert.deepEqual([verifyJws(t.id_token, r.p.jwks()).header.alg, verifyJws(t.id_token, r.p.jwks(), ['ES256']).payload.aud], ['ES256', 'ec']);
  assert.throws(() => verifyJws(t.id_token, r.p.jwks(), ['RS256']), /not accepted/);
});

test('pairwise subjects differ by sector, stay the same for a person, and match in ID token and UserInfo', () => {
  const r = rig({ pairwiseSalt: 'salt-1' });
  for (const [id, host] of [['pw1', 'one.example'], ['pw2', 'two.example']] as const) r.p.registerClient({ id, secret: `${id}-secret-01234`, redirectUris: [`https://${host}/cb`], subjectType: 'pairwise', firstParty: true });
  const sub = (id: string, host: string, who = 'u-ana') => {
    const code = codeFrom((r.p.authorize(q({ client_id: id, redirect_uri: `https://${host}/cb` }), authn({ sub: who })) as { url: string }).url);
    const t = r.p.token({ authorization: basic(id, `${id}-secret-01234`), body: { grant_type: 'authorization_code', code, redirect_uri: `https://${host}/cb`, code_verifier: VERIFIER } }).body as { access_token: string; id_token: string };
    const fromId = verifyJws(t.id_token, r.p.jwks()).payload.sub;
    assert.equal(r.p.userinfo(`Bearer ${t.access_token}`).body.sub, fromId);
    return fromId as string;
  };
  const a1 = sub('pw1', 'one.example'); const a2 = sub('pw2', 'two.example');
  assert.notEqual(a1, a2);
  assert.equal(a1, sub('pw1', 'one.example'));
  assert.notEqual(a1, sub('pw1', 'one.example', 'u-bob'));
  assert.notEqual(a1, 'u-ana');
  assert.equal(a1.length, 43);
});

test('refresh tokens need offline_access, rotate on use, can narrow scope, and a reused one revokes the grant', () => {
  const r = rig();
  const first = exchange(r, codeFrom(login(r, { scope: 'openid profile email offline_access' }))).body as { refresh_token: string; access_token: string; scope: string };
  assert.equal(first.scope, 'openid profile email offline_access');
  const refresh = (rt: string, extra: Record<string, string> = {}) => r.p.token({ ...WEB, body: { grant_type: 'refresh_token', refresh_token: rt, ...extra } }).body as { refresh_token: string; access_token: string; id_token: string; scope: string };
  const second = refresh(first.refresh_token);
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal(verifyJws(second.id_token, r.p.jwks()).payload.sub, 'u-ana');
  assert.equal('nonce' in verifyJws(second.id_token, r.p.jwks()).payload, false, 'a refreshed ID token carries no nonce');
  assert.equal(r.p.userinfo(`Bearer ${second.access_token}`).status, 200);
  const narrow = refresh(second.refresh_token, { scope: 'openid email' });
  assert.equal(narrow.scope, 'openid email');
  fails(() => refresh(narrow.refresh_token, { scope: 'openid phone' }), 'invalid_scope');
  fails(() => refresh(second.refresh_token), 'invalid_grant', /already used/);
  fails(() => refresh(narrow.refresh_token), 'invalid_grant', /expired or been revoked/);
  fails(() => r.p.userinfo(`Bearer ${narrow.access_token}`), 'invalid_token');
  const none = exchange(r, codeFrom(login(r))).body as { refresh_token?: string };
  assert.equal(none.refresh_token, undefined);
  fails(() => refresh('nonsense'), 'invalid_grant');
  const gone = exchange(r, codeFrom(login(r, { scope: 'openid offline_access' }, { sub: 'u-off' }))).body as { refresh_token: string };
  fails(() => refresh(gone.refresh_token), 'invalid_grant', /no longer active/);
  const aged = exchange(r, codeFrom(login(r, { scope: 'openid offline_access' }))).body as { refresh_token: string };
  r.clock.t += 31 * 86_400_000;
  fails(() => refresh(aged.refresh_token), 'invalid_grant', /expired/);
});

test('revocation ends a token, a refresh token takes its grant with it, and other clients cannot revoke it', () => {
  const r = rig();
  const t = exchange(r, codeFrom(login(r, { scope: 'openid offline_access' }))).body as { access_token: string; refresh_token: string };
  assert.deepEqual(r.p.revoke({ ...WEB, body: { token: 'unknown-token' } }), { status: 200 }, 'an unknown token is not an error');
  r.p.revoke({ body: { client_id: 'spa', token: t.access_token } });
  assert.equal(r.p.userinfo(`Bearer ${t.access_token}`).status, 200, 'another client cannot revoke it');
  fails(() => r.p.revoke({ authorization: basic('web', 'bad-secret-0123456789'), body: { token: t.access_token } }), 'invalid_client');
  assert.equal(r.p.userinfo(`Bearer ${t.access_token}`).status, 200);
  r.p.revoke({ ...WEB, body: { token: t.refresh_token } });
  fails(() => r.p.userinfo(`Bearer ${t.access_token}`), 'invalid_token');
  const t2 = exchange(r, codeFrom(login(r))).body as { access_token: string };
  r.p.revoke({ ...WEB, body: { token: t2.access_token } });
  fails(() => r.p.userinfo(`Bearer ${t2.access_token}`), 'invalid_token');
});

function logoutRig() {
  const r = rig();
  r.p.registerClient({ id: 'bc', secret: 'bc-secret-01234ab', redirectUris: ['https://bc.example/cb'], firstParty: true, backchannelLogoutUri: 'https://bc.example/logout', backchannelLogoutSessionRequired: true });
  r.p.registerClient({ id: 'fc', secret: 'fc-secret-01234ab', redirectUris: ['https://fc.example/cb'], firstParty: true, frontchannelLogoutUri: 'https://fc.example/fc?x=1', frontchannelLogoutSessionRequired: true });
  const tokens: Record<string, { access_token: string; id_token: string }> = {};
  for (const [id, host] of [['web', 'app.example.org'], ['bc', 'bc.example'], ['fc', 'fc.example']] as const) {
    const secret = id === 'web' ? 'web-secret-01234' : `${id}-secret-01234ab`;
    const code = codeFrom((r.p.authorize(q({ client_id: id, redirect_uri: `https://${host}/cb` }), authn(), { consented: true }) as { url: string }).url);
    tokens[id] = r.p.token({ authorization: basic(id, secret), body: { grant_type: 'authorization_code', code, redirect_uri: `https://${host}/cb`, code_verifier: VERIFIER } }).body as { access_token: string; id_token: string };
  }
  return { r, tokens };
}

test('RP-initiated logout with an ID token hint ends the session, revokes its tokens, and redirects only to a registered URI', () => {
  const { r, tokens } = logoutRig();
  const res = r.p.endSession(new URLSearchParams({ id_token_hint: tokens.web!.id_token, post_logout_redirect_uri: 'https://app.example.org/bye', state: 's1' }), { sid: 'sid-1' });
  assert.deepEqual([res.confirmRequired, res.redirectTo, res.plan?.sid, res.plan?.sub], [false, 'https://app.example.org/bye?state=s1', 'sid-1', 'u-ana']);
  for (const id of ['web', 'bc', 'fc']) fails(() => r.p.userinfo(`Bearer ${tokens[id]!.access_token}`), 'invalid_token');
  assert.deepEqual(r.p.endSession(new URLSearchParams({ id_token_hint: tokens.web!.id_token }), { sid: 'sid-1' }).plan, undefined, 'the session is already gone');
  const again = logoutRig();
  fails(() => again.r.p.endSession(new URLSearchParams({ id_token_hint: again.tokens.web!.id_token, post_logout_redirect_uri: 'https://evil.example/' }), null), 'invalid_request', /not registered/);
  fails(() => again.r.p.endSession(new URLSearchParams({ post_logout_redirect_uri: 'https://app.example.org/bye' }), null), 'invalid_request', /needs an id_token_hint/);
  fails(() => again.r.p.endSession(new URLSearchParams({ id_token_hint: 'a.b.c' }), null), 'invalid_request', /not one this provider signed/);
  fails(() => again.r.p.endSession(new URLSearchParams({ id_token_hint: again.tokens.web!.id_token, client_id: 'bc' }), null), 'invalid_request', /does not match/);
  fails(() => again.r.p.endSession(new URLSearchParams({ client_id: 'ghost' }), null), 'invalid_request', /unknown/);
});

test('without an ID token hint nothing happens until the person confirms', () => {
  const { r, tokens } = logoutRig();
  const ask = r.p.endSession(new URLSearchParams({ client_id: 'web', post_logout_redirect_uri: 'https://app.example.org/bye' }), { sid: 'sid-1' });
  assert.deepEqual([ask.confirmRequired, ask.plan, ask.redirectTo], [true, undefined, 'https://app.example.org/bye']);
  assert.equal(r.p.userinfo(`Bearer ${tokens.web!.access_token}`).status, 200, 'still signed in');
  const done = r.p.endSession(new URLSearchParams({ client_id: 'web' }), { sid: 'sid-1' }, { confirmed: true });
  assert.equal(done.plan?.sid, 'sid-1');
  fails(() => r.p.userinfo(`Bearer ${tokens.web!.access_token}`), 'invalid_token');
  assert.equal(r.p.endSession(new URLSearchParams(), null, { confirmed: true }).plan, undefined);
});

test('back-channel logout tokens are signed, specific to each client, and pass the relying party checks', async () => {
  const { r, tokens } = logoutRig();
  const plan = r.p.endSession(new URLSearchParams({ id_token_hint: tokens.web!.id_token }), null).plan!;
  assert.deepEqual(plan.backchannel.map((b) => [b.clientId, b.uri]), [['bc', 'https://bc.example/logout']]);
  const lt = plan.backchannel[0]!.logoutToken;
  const seen = new Set<string>();
  const check = { jwks: r.p.jwks(), issuer: ISS, clientId: 'bc', now: NOW0, seen: (j: string) => (seen.has(j) ? true : (seen.add(j), false)) };
  const v = validateLogoutToken(lt, check);
  assert.deepEqual([v.sub, v.sid], ['u-ana', 'sid-1']);
  const { header, payload } = verifyJws(lt, r.p.jwks());
  assert.equal(header.typ, 'logout+jwt');
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'events', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
  assert.deepEqual(payload.events, { 'http://schemas.openid.net/event/backchannel-logout': {} });
  assert.throws(() => validateLogoutToken(lt, check), /already used/);
  const fresh = { ...check, seen: () => false };
  assert.throws(() => validateLogoutToken(lt, { ...fresh, clientId: 'web' }), /not for this client/);
  assert.throws(() => validateLogoutToken(lt, { ...fresh, issuer: 'https://other.example' }), /wrong issuer/);
  assert.throws(() => validateLogoutToken(lt, { ...fresh, now: NOW0 + 10 * 60_000 }), /expired/);
  assert.throws(() => validateLogoutToken(lt, { ...fresh, now: NOW0 - 10 * 60_000 }), /future/);
  assert.throws(() => validateLogoutToken(tokens.bc!.id_token, fresh), /logout|backchannel/, 'an ID token is not a logout token');
  const forged = `${b64({ alg: 'RS256', kid: 'rs-1' })}.${b64({ ...payload, sid: 'other' })}.${lt.split('.')[2]}`;
  assert.throws(() => validateLogoutToken(forged, fresh), /does not verify/);
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const results = await sendBackchannel(plan, async (url, body, headers) => { posts.push({ url, body, headers }); return { status: 200 }; });
  assert.deepEqual(results, [{ clientId: 'bc', ok: true, status: 200 }]);
  assert.deepEqual([posts[0]!.url, posts[0]!.body.startsWith('logout_token='), posts[0]!.headers['Content-Type']], ['https://bc.example/logout', true, 'application/x-www-form-urlencoded']);
  assert.deepEqual(await sendBackchannel(plan, async () => ({ status: 500 })), [{ clientId: 'bc', ok: false, status: 500 }]);
  assert.deepEqual(await sendBackchannel(plan, async () => { throw new Error('connect ETIMEDOUT'); }), [{ clientId: 'bc', ok: false, error: 'connect ETIMEDOUT' }]);
});

test('front-channel logout builds iss and sid URLs and a page that frames only those origins', () => {
  const { r, tokens } = logoutRig();
  const plan = r.p.endSession(new URLSearchParams({ id_token_hint: tokens.fc!.id_token }), null).plan!;
  assert.deepEqual(plan.frontchannel, [{ clientId: 'fc', url: `https://fc.example/fc?x=1&iss=${encodeURIComponent(ISS)}&sid=sid-1` }]);
  const page = frontchannelPage(plan);
  assert.ok(page.html.includes('<iframe src="https://fc.example/fc?x=1&amp;iss=https%3A%2F%2Fid.example.com&amp;sid=sid-1"'));
  assert.equal(page.headers['Content-Security-Policy'], "default-src 'none'; style-src 'unsafe-inline'; frame-src https://fc.example");
  assert.deepEqual([page.headers['Cache-Control'], page.headers['X-Content-Type-Options']], ['no-store', 'nosniff']);
  const evil = frontchannelPage({ sid: 's', sub: 'u', backchannel: [], frontchannel: [{ clientId: 'x', url: 'https://x.example/"><script>alert(1)</script>' }] });
  assert.equal(evil.html.includes('<script>'), false);
  assert.ok(frontchannelPage({ sid: 's', sub: 'u', backchannel: [], frontchannel: [] }).headers['Content-Security-Policy']!.endsWith("frame-src 'none'"));
});

test('ending a person\'s sessions everywhere, and only the clients that took part are told', () => {
  const r = rig();
  r.p.registerClient({ id: 'bc', secret: 'bc-secret-01234ab', redirectUris: ['https://bc.example/cb'], firstParty: true, backchannelLogoutUri: 'https://bc.example/logout' });
  r.p.registerClient({ id: 'idle', secret: 'idle-secret-01234a', redirectUris: ['https://idle.example/cb'], firstParty: true, backchannelLogoutUri: 'https://idle.example/logout' });
  const go = (sid: string) => r.p.authorize(q({ client_id: 'bc', redirect_uri: 'https://bc.example/cb' }), authn({ sid }));
  go('s-a'); go('s-b');
  r.p.authorize(q({}), authn({ sid: 's-c', sub: 'u-bob' }), { consented: true });
  const plans = r.p.logoutPerson('u-ana');
  assert.deepEqual(plans.map((p) => [p.sid, p.backchannel.map((b) => b.clientId)]), [['s-a', ['bc']], ['s-b', ['bc']]]);
  const lt = verifyJws(plans[0]!.backchannel[0]!.logoutToken, r.p.jwks()).payload;
  assert.equal('sid' in lt, false, 'no sid unless the client asked for it');
  assert.deepEqual(r.p.logoutPerson('u-ana'), []);
  assert.equal(r.p.logoutSession('s-c')?.sub, 'u-bob');
  assert.equal(r.p.logoutSession('unknown'), undefined);
});

test('expired codes and tokens can be purged from the store', () => {
  const r = rig();
  exchange(r, codeFrom(login(r)));
  login(r);
  assert.equal(r.store.purge(NOW0), 0);
  assert.ok(r.store.purge(NOW0 + 700_000) >= 3);
  assert.equal(r.store.purge(NOW0 + 700_000), 0);
});
