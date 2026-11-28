import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, sign as nodeSign, type JsonWebKey } from 'node:crypto';
import { test } from 'node:test';
import { ClaimError, InvalidSignature, InvalidToken, Jwt, KeyError, KeySet, b64u, checkClaims, checkKey, parse, signJws, thumbprint, toKey, unb64u, unsafeDecode, verifyJws, type Alg, type Header } from './index.ts';

const T0 = 1_700_000_000_000;
const clock = { t: T0 };
const now = () => clock.t;

// RFC 7515 appendix A.1 (HS256) and A.3 (ES256); RFC 8037 appendix A (Ed25519); RFC 7638 section 3.1.
const A1_KEY = 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow';
// The RFC's JSON texts are the source of truth; the token is built from them at run time, and only the published signature segment is held as a literal.
const A1_HEADER = '{"typ":"JWT",\r\n "alg":"HS256"}';
const A1_PAYLOAD = '{"iss":"joe",\r\n "exp":1300819380,\r\n "http://example.com/is_root":true}';
const A3_HEADER = '{"alg":"ES256"}';
const A1_SIG = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const A3_SIG = 'DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q';
const b64j = (s: string) => Buffer.from(s).toString('base64url');
const A1_INPUT = `${b64j(A1_HEADER)}.${b64j(A1_PAYLOAD)}`;
const A1_TOKEN = `${A1_INPUT}.${b64u(createHmac('sha256', Buffer.from(A1_KEY, 'base64url')).update(A1_INPUT).digest())}`;
const A3_JWK: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
const A3_TOKEN = `${b64j(A3_HEADER)}.${b64j(A1_PAYLOAD)}.${A3_SIG}`;
const ED_PRIV: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
const ED_TOKEN = 'eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc.hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg';
const RSA_7638: JsonWebKey = { kty: 'RSA', e: 'AQAB', n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw' };

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const hmacKey = (n = 32) => toKey(randomBytes(n), 'secret');

test('RFC 7515 A.1: the published HS256 token verifies, and one changed character does not', () => {
  const key = toKey({ kty: 'oct', k: A1_KEY }, 'secret');
  const r = verifyJws(A1_TOKEN, () => key, { algorithms: ['HS256'] });
  assert.equal(r.header.alg, 'HS256');
  assert.deepEqual(JSON.parse(r.payload.toString()), { iss: 'joe', exp: 1300819380, 'http://example.com/is_root': true });
  assert.equal(A1_TOKEN.split('.')[2], A1_SIG, 'the computed HMAC equals the RFC published signature segment');
  assert.equal(b64u(createHmac('sha256', Buffer.from(A1_KEY, 'base64url')).update(A1_TOKEN.split('.').slice(0, 2).join('.')).digest()), A1_TOKEN.split('.')[2], 'an independent HMAC gives the same signature');
  const bad = A1_TOKEN.replace('eyJpc3MiOiJqb2U', 'eyJpc3MiOiJqb2V');
  assert.throws(() => verifyJws(bad, () => key, { algorithms: ['HS256'] }), InvalidSignature);
});

test('RFC 7515 A.3: the published ES256 token verifies with its public key, and not with another', () => {
  const pub = toKey(A3_JWK, 'public');
  const r = verifyJws(A3_TOKEN, () => pub, { algorithms: ['ES256'] });
  assert.equal(JSON.parse(r.payload.toString()).iss, 'joe');
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  assert.throws(() => verifyJws(A3_TOKEN, () => other, { algorithms: ['ES256'] }), InvalidSignature);
});

test('RFC 8037: Ed25519 reproduces the published token byte for byte, and verifies it', () => {
  const priv = toKey(ED_PRIV, 'private');
  assert.equal(signJws('Example of Ed25519 signing', 'EdDSA', priv), ED_TOKEN);
  const pub = toKey({ kty: 'OKP', crv: 'Ed25519', x: ED_PRIV.x! }, 'public');
  assert.equal(verifyJws(ED_TOKEN, () => pub, { algorithms: ['EdDSA'] }).payload.toString(), 'Example of Ed25519 signing');
  assert.equal(thumbprint({ kty: 'OKP', crv: 'Ed25519', x: ED_PRIV.x! }).length, 43);
});

test('RFC 7638: the thumbprint of the example RSA key, and member order does not matter', () => {
  assert.equal(thumbprint(RSA_7638), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  assert.equal(thumbprint({ n: RSA_7638.n, kty: 'RSA', e: 'AQAB', kid: 'ignored', use: 'sig' } as JsonWebKey), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  assert.throws(() => thumbprint({ kty: 'RSA', e: 'AQAB' }), /missing a required member/);
  assert.throws(() => thumbprint({ kty: 'DSA' } as JsonWebKey), /cannot take the thumbprint/);
});

test('every algorithm signs and verifies, and the token carries kid and typ', () => {
  const ks = new KeySet(now);
  const algs: Alg[] = ['HS256', 'HS384', 'HS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
  for (const a of algs) ks.generate(a);
  ks.add('RS256', rsa.privateKey, { kid: 'rsa-rs' });
  ks.add('RS384', rsa.privateKey, { kid: 'rsa-rs384' });
  ks.add('PS256', rsa.privateKey, { kid: 'rsa-ps' });
  ks.add('PS512', rsa.privateKey, { kid: 'rsa-ps512' });
  const all: Alg[] = [...algs, 'RS256', 'RS384', 'PS256', 'PS512'];
  const jwt = new Jwt({ keys: ks, algorithms: all, issuer: 'https://id.example', audience: 'api', now });
  for (const a of all) {
    const token = jwt.issue({ sub: 'ana', aud: 'api' }, { ttlSec: 60, alg: a });
    const r = jwt.verify(token);
    assert.equal(r.claims.sub, 'ana', a);
    assert.equal(r.header.alg, a);
    assert.equal(r.header.typ, 'JWT');
    assert.equal(typeof r.header.kid, 'string');
  }
  const t = parse(jwt.issue({}, { ttlSec: 60, alg: 'ES256' }));
  assert.deepEqual(Object.keys(t.header), ['alg', 'typ', 'kid']);
  assert.equal(t.signature.length, 64, 'ES256 signatures are the fixed 64-byte form');
});

test('algorithm confusion: an RSA public key cannot be used as an HMAC secret, and "none" is never accepted', () => {
  const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const payload = JSON.stringify({ sub: 'admin', exp: T0 / 1000 + 600 });
  const input = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(payload)}`;
  const forged = `${input}.${b64u(createHmac('sha256', pem).update(input).digest())}`;
  assert.throws(() => verifyJws(forged, () => rsa.publicKey, { algorithms: ['RS256'] }), /HS256 is not accepted here/);
  assert.throws(() => verifyJws(forged, () => rsa.publicKey, { algorithms: ['RS256', 'HS256'] }), /needs a secret key, not a public key/);
  const ks = new KeySet(now);
  ks.add('RS256', rsa.publicKey, { kind: 'public', kid: 'k' });
  const jwt = new Jwt({ keys: ks, algorithms: ['RS256', 'HS256'], now });
  assert.throws(() => jwt.verify(forged), KeyError, 'the key set has no HMAC key, so nothing verifies it');
  for (const none of ['none', 'None', 'NONE', 'nOnE']) {
    const tok = `${b64u(JSON.stringify({ alg: none }))}.${b64u(payload)}.`;
    assert.throws(() => verifyJws(tok, () => hmacKey(), { algorithms: ['HS256'] }), /never accepted/, none);
  }
  assert.throws(() => verifyJws(`${b64u('{"alg":""}')}.${b64u('{}')}.AA`, () => hmacKey(), { algorithms: ['HS256'] }), /not supported/);
  assert.throws(() => verifyJws(A1_TOKEN, () => hmacKey(), { algorithms: [] }), /say which algorithms/);
});

test('keys must suit the algorithm: family, curve, strength', () => {
  assert.throws(() => checkKey('HS256', hmacKey(16), 'verify'), /at least 32 bytes/);
  assert.throws(() => checkKey('HS512', hmacKey(32), 'verify'), /at least 64 bytes/);
  assert.doesNotThrow(() => checkKey('HS256', hmacKey(32), 'verify'));
  assert.throws(() => checkKey('RS256', hmacKey(), 'verify'), /needs an asymmetric key/);
  assert.throws(() => checkKey('RS256', rsa.publicKey, 'sign'), /needs a private key/);
  assert.throws(() => checkKey('RS256', generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey, 'sign'), /at least 2048 bits/);
  assert.throws(() => checkKey('ES256', generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey, 'sign'), /needs a prime256v1 EC key/);
  assert.throws(() => checkKey('ES256', rsa.privateKey, 'sign'), /needs a prime256v1 EC key/);
  assert.throws(() => checkKey('EdDSA', generateKeyPairSync('ed448').privateKey, 'sign'), /Ed25519/);
  assert.throws(() => checkKey('RS256', generateKeyPairSync('ed25519').privateKey, 'sign'), /needs an RSA key/);
  assert.throws(() => toKey('secret', 'private'), /only an HMAC secret/);
  assert.throws(() => toKey({ kty: 'RSA', e: 'AQAB' }, 'public'), KeyError);
  assert.throws(() => signJws('x', 'HS256', hmacKey(8)), KeyError, 'a short HMAC key cannot sign either');
  assert.throws(() => signJws('x', 'none' as Alg, hmacKey()), /not a supported algorithm/);
});

test('malformed tokens are refused for what they are', () => {
  const key = () => hmacKey();
  const ok = (s: string) => verifyJws(s, key, { algorithms: ['HS256'] });
  const [h, p] = A1_TOKEN.split('.');
  for (const [bad, why] of [['a.b', /three parts/], ['a.b.c.d', /three parts/], ['a.b.c.d.e', /encrypted token/], ['', /three parts/], [`.${p}.x`, /header is empty/], [`${h}=.${p}.x`, /not base64url/], [`${h} .${p}.x`, /not base64url/], [`${h}.${p}.x y`, /not base64url/], [`${b64u('[1]')}.${p}.x`, /not a JSON object/], [`${b64u('null')}.${p}.x`, /not a JSON object/], [`${b64u('{"typ":"JWT"}')}.${p}.x`, /no alg/], [`${b64u('not json')}.${p}.x`, /not JSON/], [`${b64u('{"alg":7}')}.${p}.x`, /no alg/], ['x'.repeat(20_000), /longer than/]] as const) assert.throws(() => ok(bad), (e: Error) => e instanceof InvalidToken && why.test(e.message), JSON.stringify(bad.slice(0, 30)));
  assert.throws(() => unb64u('AB'), /canonical/, 'trailing bits must be zero');
  assert.throws(() => unb64u('A'), /not base64url/);
  assert.equal(unb64u('QQ').toString(), 'A');
  assert.throws(() => ok(undefined as unknown as string), InvalidToken);
});

test('signature checks: tampered payload, swapped algorithm, wrong key, DER-form ECDSA, truncated signature', () => {
  const ks = new KeySet(now);
  ks.generate('ES256');
  ks.generate('HS256');
  const jwt = new Jwt({ keys: ks, algorithms: ['ES256', 'HS256'], now });
  const t = jwt.issue({ role: 'user' }, { ttlSec: 60, alg: 'ES256' });
  const [h, p, s] = t.split('.') as [string, string, string];
  const evil = b64u(Buffer.from(p, 'base64url').toString().replace('"user"', '"root"'));
  assert.throws(() => jwt.verify(`${h}.${evil}.${s}`), InvalidSignature);
  assert.throws(() => jwt.verify(`${h}.${p}.${b64u(Buffer.from(s, 'base64url').subarray(0, 60))}`), InvalidSignature, 'a short signature');
  assert.throws(() => jwt.verify(`${h}.${p}.`), InvalidSignature, 'an empty signature');
  const other = new KeySet(now);
  other.add('ES256', generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey, { kid: ks.signingKey('ES256').kid });
  assert.throws(() => new Jwt({ keys: other, algorithms: ['ES256'], now }).verify(t), InvalidSignature, 'same kid, different key');
  const k = ks.signingKey('ES256');
  const der = nodeSign('sha256', Buffer.from(`${h}.${p}`), k.key);
  assert.throws(() => jwt.verify(`${h}.${p}.${b64u(der)}`), InvalidSignature, 'the DER encoding is not the JWS encoding');
});

test('claims: exp, nbf and iat against the clock with a tolerance; exp is required unless said otherwise', () => {
  const nowSec = () => T0 / 1000;
  const run = (c: Record<string, unknown>, r: Partial<Parameters<typeof checkClaims>[2]> = {}, h: Header = { alg: 'HS256' }) => checkClaims(c, h, { now: nowSec, ...r });
  assert.doesNotThrow(() => run({ exp: T0 / 1000 + 10 }));
  assert.throws(() => run({ exp: T0 / 1000 - 61 }), (e: ClaimError) => e.claim === 'exp' && /expired/.test(e.message));
  assert.doesNotThrow(() => run({ exp: T0 / 1000 - 59 }), 'within the tolerance');
  assert.throws(() => run({ exp: T0 / 1000 - 5 }, { toleranceSec: 0 }), /expired/);
  assert.throws(() => run({ exp: T0 / 1000, }, { toleranceSec: 0 }), /expired/, 'exp is the first instant it is no longer valid');
  assert.throws(() => run({ exp: T0 / 1000 + 10, nbf: T0 / 1000 + 61 }), (e: ClaimError) => e.claim === 'nbf');
  assert.doesNotThrow(() => run({ exp: T0 / 1000 + 10, nbf: T0 / 1000 + 59 }));
  assert.throws(() => run({ exp: T0 / 1000 + 10, iat: T0 / 1000 + 120 }), (e: ClaimError) => e.claim === 'iat');
  assert.throws(() => run({}), (e: ClaimError) => e.claim === 'exp' && /no expiry/.test(e.message));
  assert.doesNotThrow(() => run({}, { requireExp: false }));
  for (const bad of ['soon', null, true, [1], {}, Infinity]) assert.throws(() => run({ exp: bad }), ClaimError, String(bad));
});

test('claims: issuer, audience (string or list), subject, token id, lifetime and type', () => {
  const nowSec = () => T0 / 1000;
  const exp = T0 / 1000 + 100;
  const run = (c: Record<string, unknown>, r: Partial<Parameters<typeof checkClaims>[2]> = {}, h: Header = { alg: 'HS256', typ: 'JWT' }) => checkClaims({ exp, ...c }, h, { now: nowSec, ...r });
  assert.doesNotThrow(() => run({ iss: 'a' }, { issuer: ['a', 'b'] }));
  assert.throws(() => run({ iss: 'evil' }, { issuer: 'a' }), (e: ClaimError) => e.claim === 'iss');
  assert.throws(() => run({}, { issuer: 'a' }), (e: ClaimError) => e.claim === 'iss');
  assert.doesNotThrow(() => run({ aud: 'api' }, { audience: 'api' }));
  assert.doesNotThrow(() => run({ aud: ['x', 'api'] }, { audience: ['api', 'other'] }));
  assert.throws(() => run({ aud: ['x'] }, { audience: 'api' }), (e: ClaimError) => e.claim === 'aud');
  assert.throws(() => run({ aud: 5 }, { audience: 'api' }), ClaimError);
  assert.throws(() => run({}, { audience: 'api' }), ClaimError);
  assert.throws(() => run({ sub: 'x' }, { subject: 'y' }), (e: ClaimError) => e.claim === 'sub');
  assert.throws(() => run({}, { requireSub: true }), ClaimError);
  assert.throws(() => run({}, { requireJti: true }), (e: ClaimError) => e.claim === 'jti');
  assert.throws(() => run({ iat: T0 / 1000 - 1000, exp: T0 / 1000 + 100 }, { maxLifetimeSec: 600 }), /longer than 600/);
  assert.doesNotThrow(() => run({ iat: T0 / 1000 - 100 }, { maxLifetimeSec: 600 }));
  assert.throws(() => run({}, { maxLifetimeSec: 600 }), /needs both iat and exp/);
  assert.doesNotThrow(() => run({}, { typ: 'at+jwt' }, { alg: 'ES256', typ: 'application/AT+JWT' }));
  assert.throws(() => run({}, { typ: 'at+jwt' }, { alg: 'ES256', typ: 'JWT' }), (e: ClaimError) => e.claim === 'typ');
  assert.throws(() => run({}, { typ: 'at+jwt' }, { alg: 'ES256' }), ClaimError);
});

test('replay: a token id can be used once', () => {
  const used = new Set<string>();
  const once = (jti: string) => (used.has(jti) ? false : (used.add(jti), true));
  const run = (jti?: string) => checkClaims({ exp: T0 / 1000 + 10, ...(jti ? { jti } : {}) }, { alg: 'HS256' }, { now: () => T0 / 1000, once });
  run('a');
  assert.throws(() => run('a'), (e: ClaimError) => e.claim === 'jti' && /already used/.test(e.message));
  run('b');
  assert.throws(() => run(), /no id/);
});

test('header tricks: crit, jwk, jku, x5u and x5c are not followed', () => {
  const k = hmacKey();
  const mk = (header: Record<string, unknown>) => {
    const input = `${b64u(JSON.stringify(header))}.${b64u('{}')}`;
    return `${input}.${b64u(createHmac('sha256', k.export()).update(input).digest())}`;
  };
  assert.throws(() => verifyJws(mk({ alg: 'HS256', crit: ['exp'], exp: 1 }), () => k, { algorithms: ['HS256'] }), /not understood/);
  assert.throws(() => verifyJws(mk({ alg: 'HS256', crit: [] }), () => k, { algorithms: ['HS256'] }), /not understood/);
  assert.throws(() => verifyJws(mk({ alg: 'HS256', crit: 'b64' }), () => k, { algorithms: ['HS256'] }), /not understood/);
  assert.doesNotThrow(() => verifyJws(mk({ alg: 'HS256', jku: 'https://evil/jwks', x5u: 'https://evil/c', x5c: ['AA'] }), () => k, { algorithms: ['HS256'] }), 'ignored, not an error');
  const attacker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const header = { alg: 'ES256', kid: 'attacker', jwk: attacker.publicKey.export({ format: 'jwk' }) };
  const input = `${b64u(JSON.stringify(header))}.${b64u('{"sub":"admin"}')}`;
  const forged = `${input}.${b64u(nodeSign('sha256', Buffer.from(input), { key: attacker.privateKey, dsaEncoding: 'ieee-p1363' }))}`;
  const ks = new KeySet(now);
  ks.generate('ES256', { kid: 'real' });
  assert.throws(() => new Jwt({ keys: ks, algorithms: ['ES256'], now }).verify(forged), /no key is known/, 'the embedded key is never used');
});

test('kid selection: a kid picks that key; without a kid one live key is used and several are ambiguous', () => {
  const ks = new KeySet(now);
  const a = ks.generate('ES256', { kid: 'a' });
  const jwt = new Jwt({ keys: ks, algorithms: ['ES256'], now });
  const noKid = signJws(JSON.stringify({ exp: T0 / 1000 + 60 }), 'ES256', a.key);
  assert.equal(jwt.verify(noKid).header.kid, undefined);
  ks.generate('ES256', { kid: 'b' });
  assert.throws(() => jwt.verify(noKid), /no key is known/, 'two candidate keys: refuse to guess');
  const withKid = signJws(JSON.stringify({ exp: T0 / 1000 + 60 }), 'ES256', a.key, { kid: 'a' });
  assert.doesNotThrow(() => jwt.verify(withKid));
  const wrongKid = signJws(JSON.stringify({ exp: T0 / 1000 + 60 }), 'ES256', a.key, { kid: 'b' });
  assert.throws(() => jwt.verify(wrongKid), InvalidSignature);
  assert.throws(() => jwt.verify(signJws('{}', 'ES256', a.key, { kid: 'zzz' })), /no key is known/);
  assert.throws(() => ks.add('ES256', a.key, { kid: 'a' }), /already exists/);
});

test('rotation: the new key signs at once, the old one verifies until its grace ends, a revoked key stops now', () => {
  clock.t = T0;
  const ks = new KeySet(now);
  const k1 = ks.generate('ES256');
  const jwt = new Jwt({ keys: ks, algorithms: ['ES256'], issuer: 'iss', now });
  const old = jwt.issue({ n: 1 }, { ttlSec: 3600 });
  clock.t += 1000;
  const k2 = ks.rotate('ES256', 10 * 60_000);
  assert.notEqual(k1.kid, k2.kid);
  assert.equal(ks.get(k1.kid)!.state, 'retiring');
  const fresh = jwt.issue({ n: 2 }, { ttlSec: 3600 });
  assert.equal(parse(fresh).header.kid, k2.kid, 'new tokens use the new key');
  assert.equal(jwt.verify(old).claims.n, 1, 'old tokens still verify during the grace period');
  assert.equal(jwt.verify(fresh).claims.n, 2);
  clock.t += 11 * 60_000;
  assert.throws(() => jwt.verify(old), /no key is known/, 'after the grace period the old key is gone');
  assert.equal(jwt.verify(fresh).claims.n, 2);
  assert.deepEqual(ks.sweep(), [k1.kid]);
  ks.revoke(k2.kid);
  assert.throws(() => jwt.verify(fresh), /no key is known/);
  assert.throws(() => jwt.issue({}, { ttlSec: 60 }), /no active signing key/);
  assert.throws(() => ks.revoke('nope'), KeyError);
});

test('the published JWKS has public keys only, lists retiring keys until their grace ends, and another party can verify with it', () => {
  clock.t = T0;
  const ks = new KeySet(now);
  ks.generate('ES256');
  ks.generate('HS256');
  ks.add('RS256', rsa.privateKey, { kid: 'rsa1' });
  ks.generate('EdDSA');
  const k = ks.rotate('ES384', 60_000);
  const jwks = ks.publicJwks();
  assert.deepEqual(jwks.keys.map((j) => j.alg).sort(), ['ES256', 'ES384', 'EdDSA', 'RS256']);
  const text = JSON.stringify(jwks);
  for (const secret of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"', '"k"', 'oct']) assert.ok(!text.includes(secret), `no ${secret} in the JWKS`);
  assert.ok(jwks.keys.every((j) => j.use === 'sig' && typeof j.kid === 'string'));
  assert.equal(thumbprint(jwks.keys.find((j) => j.kid === 'rsa1')!), thumbprint(rsa.publicKey.export({ format: 'jwk' })));
  const issuer = new Jwt({ keys: ks, algorithms: ['ES384', 'RS256'], issuer: 'https://id.example', now });
  const token = issuer.issue({ sub: 'ana' }, { ttlSec: 60, alg: 'ES384' });
  const { set, skipped } = KeySet.fromJwks(JSON.parse(text), now);
  assert.deepEqual(skipped, []);
  const verifier = new Jwt({ keys: set, algorithms: ['ES384', 'RS256'], issuer: 'https://id.example', now });
  assert.equal(verifier.verify(token).claims.sub, 'ana');
  assert.throws(() => verifier.issue({}, { ttlSec: 60, alg: 'ES384' }), /no active signing key/, 'a loaded JWKS can verify but not sign');
  const retiring = ks.rotate('ES384', 60_000);
  assert.equal(ks.publicJwks().keys.filter((j) => j.alg === 'ES384').length, 2, 'the retiring key is still published so tokens signed with it verify');
  clock.t += 61_000;
  assert.deepEqual(ks.publicJwks().keys.filter((j) => j.alg === 'ES384').map((j) => j.kid), [retiring.kid], 'and withdrawn when its grace ends');
  assert.notEqual(k.kid, retiring.kid);
});

test('loading a JWKS skips what does not belong in one: private keys, secrets, unknown or unwanted algorithms', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const good = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'good' };
  const { set, skipped } = KeySet.fromJwks({ keys: [good, { ...ec.privateKey.export({ format: 'jwk' }), kid: 'private' }, { kty: 'oct', k: 'AAAA', kid: 'secret' }, { kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'weak', alg: 'RS256' }, { ...good, kid: 'enc', use: 'enc' }, { ...good, kid: 'rs', alg: 'RS256' }] }, now, ['ES256', 'RS256']);
  assert.equal(set.get('good')?.alg, 'ES256', 'the algorithm is read from the curve when absent');
  assert.deepEqual(skipped.map((s) => s.split(':')[0]), ['private', 'secret', 'weak', 'enc', 'rs']);
  assert.throws(() => KeySet.fromJwks({}, now), /"keys" array/);
});

test('Jwt.issue sets iss, iat and exp itself; callers cannot override them; unsafeDecode verifies nothing', () => {
  clock.t = T0;
  const ks = new KeySet(now);
  ks.generate('HS256');
  const jwt = new Jwt({ keys: ks, algorithms: ['HS256'], issuer: 'https://id.example', audience: 'api', now, typ: 'at+jwt' });
  const t = jwt.issue({ sub: 'ana', iss: 'https://evil', exp: 99_999_999_999, aud: 'api' }, { ttlSec: 120, jti: 'j1' });
  const c = jwt.verify(t).claims;
  assert.deepEqual([c.iss, c.iat, c.exp, c.jti, c.sub], ['https://id.example', T0 / 1000, T0 / 1000 + 120, 'j1', 'ana']);
  assert.equal(parse(t).header.typ, 'at+jwt');
  assert.throws(() => jwt.issue({}, { ttlSec: 0 }), ClaimError);
  assert.throws(() => jwt.issue({}, { ttlSec: 5, alg: 'ES256' }), /not one of the algorithms in use/);
  assert.throws(() => new Jwt({ keys: ks, algorithms: [], now }), KeyError);
  const forged = `${t.split('.')[0]}.${b64u('{"sub":"root"}')}.AAAA`;
  assert.equal((unsafeDecode(forged).claims as { sub: string }).sub, 'root', 'decoding is not trusting');
  assert.throws(() => jwt.verify(forged), InvalidSignature);
  clock.t += 3 * 60_000;
  assert.throws(() => jwt.verify(t), (e: ClaimError) => e.claim === 'exp');
  assert.throws(() => jwt.verify(t, { requireExp: false }), ClaimError, 'still expired');
});

test('payloads must be JSON objects, and hostile keys are plain data', () => {
  const ks = new KeySet(now);
  const k = ks.generate('HS256');
  const jwt = new Jwt({ keys: ks, algorithms: ['HS256'], now });
  clock.t = T0;
  for (const body of ['[1,2]', '"text"', 'null', '42', 'not json']) assert.throws(() => jwt.verify(signJws(body, 'HS256', k.key, { kid: k.kid })), InvalidToken, body);
  const proto = signJws('{"__proto__":{"admin":true},"exp":' + (T0 / 1000 + 60) + ',"constructor":{"x":1}}', 'HS256', k.key, { kid: k.kid });
  const c = jwt.verify(proto).claims;
  assert.equal(({} as { admin?: boolean }).admin, undefined, 'no pollution');
  assert.equal(Object.getPrototypeOf(c), Object.prototype);
  assert.equal((c as { admin?: boolean }).admin, undefined);
});
