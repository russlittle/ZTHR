import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import {
  NonceCache, SignatureError, cachedResolver, checkDigests, contentDigest, digestHeader, isPrivateAddress, keyDocumentUrl, parseCavage, parseSignatureInput, signCavage, signRequest, signRfc9421, signatureBase, verify,
  type Alg, type ErrorCode, type Req, type VerificationKey,
} from './index.ts';

// Keys are made when the tests run; none are written down.
const ed = generateKeyPairSync('ed25519');
const ed2 = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ec384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const secret = randomBytes(32);

const T0 = Date.parse('2024-05-01T12:00:00Z');
const now = () => T0;
const KEY_ID = 'https://remote.example/users/ana#main-key';
const body = '{"type":"Create","id":"https://remote.example/a/1"}';
const post = (extra: Record<string, string> = {}): Req => ({ method: 'POST', url: 'https://local.example/inbox?x=1', headers: { 'content-type': 'application/activity+json', ...extra }, body });
const withHeaders = (r: Req, add: Record<string, string>): Req => ({ ...r, headers: { ...r.headers, ...add } });
const keys = (alg: Alg, key: KeyObject | Uint8Array, id = KEY_ID) => async (k: string): Promise<VerificationKey | undefined> => (k === id ? { key, alg, owner: 'https://remote.example/users/ana' } : undefined);
const fails = async (p: Promise<unknown>, code: ErrorCode) => assert.rejects(p, (e) => e instanceof SignatureError && e.code === code, code);
const base = { now } as const;

// ------------------------------------------------------------ digests

test('digest headers use the two spellings: SHA-256=base64 and sha-256=:base64:', () => {
  assert.equal(digestHeader(''), 'SHA-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  assert.equal(contentDigest(''), 'sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:');
  assert.match(digestHeader('hi', 'sha-512'), /^SHA-512=[A-Za-z0-9+/]{86}==$/);
  assert.equal(digestHeader('abc'), digestHeader(new TextEncoder().encode('abc')));
});

test('a digest that is present must match the body; unknown algorithms are skipped but cannot be all there is', () => {
  assert.deepEqual(checkDigests({ Digest: digestHeader(body) }, body), ['sha-256']);
  assert.deepEqual(checkDigests({ 'Content-Digest': contentDigest(body, 'sha-512') }, body), ['sha-512']);
  assert.deepEqual(checkDigests({ Digest: `MD5=zzzz, ${digestHeader(body)}` }, body), ['sha-256']);
  assert.deepEqual(checkDigests({}, body), []);
  assert.throws(() => checkDigests({ Digest: digestHeader(body) }, `${body} `), (e) => e instanceof SignatureError && e.code === 'digest');
  assert.throws(() => checkDigests({ 'content-digest': contentDigest('x') }, body), (e) => e instanceof SignatureError && e.code === 'digest');
  assert.throws(() => checkDigests({ Digest: 'MD5=abcd' }, body), (e) => e instanceof SignatureError && e.code === 'digest');
  assert.throws(() => checkDigests({ Digest: 'nonsense' }, body), (e) => e instanceof SignatureError && e.code === 'malformed');
  assert.throws(() => checkDigests({ 'content-digest': 'sha-256=abc' }, body), (e) => e instanceof SignatureError && e.code === 'malformed');
});

// ------------------------------------------------------------ draft-cavage

test('a cavage signature made with signRequest verifies, for Ed25519 and RSA, and says who signed', async () => {
  for (const [alg, pair] of [['ed25519', ed], ['rsa-v1_5-sha256', rsa]] as const) {
    const req = post();
    const added = signRequest(req, { keyId: KEY_ID, key: pair.privateKey, alg, dialect: 'cavage', now });
    assert.ok(added.date && added.digest && added.host === 'local.example');
    const v = await verify(withHeaders(req, added), { ...base, resolve: keys(alg, pair.publicKey) });
    assert.deepEqual([v.dialect, v.keyId, v.alg, v.owner], ['cavage', KEY_ID, alg, 'https://remote.example/users/ana']);
    assert.deepEqual(v.covered, ['(request-target)', 'host', 'date', 'digest']);
  }
});

test('the signing string uses the lower case method and the path with its query', async () => {
  const req = withHeaders(post(), { host: 'local.example', date: new Date(T0).toUTCString(), digest: digestHeader(body) });
  const sig = signCavage(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519' });
  assert.match(sig, /^keyId="https:\/\/remote\.example\/users\/ana#main-key",algorithm="hs2019",headers="\(request-target\) host date digest",signature="[A-Za-z0-9+/=]+"$/);
  const moved = { ...withHeaders(req, { signature: sig }), url: 'https://local.example/inbox?x=2' };
  await fails(verify(moved, { ...base, resolve: keys('ed25519', ed.publicKey) }), 'bad-signature');
  await verify(withHeaders(req, { signature: sig }), { ...base, resolve: keys('ed25519', ed.publicKey) });
});

test('changing the body, a signed header, or the path breaks the signature or the digest', async () => {
  const req = post();
  const ok = withHeaders(req, signRequest(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', dialect: 'cavage', now }));
  const opts = { ...base, resolve: keys('ed25519', ed.publicKey) };
  await verify(ok, opts);
  await fails(verify({ ...ok, body: `${body} ` }, opts), 'digest');
  await fails(verify(withHeaders(ok, { date: new Date(T0 + 1000).toUTCString() }), opts), 'bad-signature');
  await fails(verify({ ...ok, url: 'https://local.example/other' }, opts), 'bad-signature');
  await fails(verify({ ...ok, method: 'PUT' }, opts), 'bad-signature');
  const { signature, ...rest } = ok.headers;
  void signature;
  await fails(verify({ ...ok, headers: rest }, opts), 'missing');
});

test('a signature by another key, or for a key nobody knows, is refused', async () => {
  const req = post();
  const ok = withHeaders(req, signRequest(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', dialect: 'cavage', now }));
  await fails(verify(ok, { ...base, resolve: keys('ed25519', ed2.publicKey) }), 'bad-signature');
  await fails(verify(ok, { ...base, resolve: keys('ed25519', ed.publicKey, 'https://other.example/k') }), 'unknown-key');
});

test('the key decides the algorithm: a signature that names a different one is refused, and a legacy name must match the key', async () => {
  const req = withHeaders(post(), { host: 'local.example', date: new Date(T0).toUTCString(), digest: digestHeader(body) });
  const asRsa = signCavage(req, { keyId: KEY_ID, key: rsa.privateKey, alg: 'rsa-v1_5-sha256', algorithmName: 'rsa-sha256' });
  await verify(withHeaders(req, { signature: asRsa }), { ...base, resolve: keys('rsa-v1_5-sha256', rsa.publicKey) });
  await fails(verify(withHeaders(req, { signature: asRsa }), { ...base, resolve: keys('ed25519', ed.publicKey) }), 'alg');
  await fails(verify(withHeaders(req, { signature: asRsa.replace('rsa-sha256', 'rsa-sha1') }), { ...base, resolve: keys('rsa-v1_5-sha256', rsa.publicKey) }), 'alg');
  assert.throws(() => signCavage(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', algorithmName: 'rsa-sha256' }), (e) => e instanceof SignatureError && e.code === 'alg');
});

test('the Signature header is parsed strictly', () => {
  const p = parseCavage('keyId="k",algorithm="hs2019",created=1700000000,headers="(request-target) (created) host",signature="YWJj"');
  assert.deepEqual([p.keyId, p.created, p.headers], ['k', 1700000000, ['(request-target)', '(created)', 'host']]);
  assert.deepEqual(parseCavage('keyId="k",signature="YQ=="').headers, ['date']);
  for (const bad of ['keyId="a",keyId="b",signature="x"', 'signature="x"', 'keyId="k"', 'keyId=k,signature="x"', 'keyId="k",signature="x",headers="a a"', 'keyId="k",signature="x",created=12x', 'keyId="k,signature="x"', 'keyId="k",signature="x",headers=""']) {
    assert.throws(() => parseCavage(bad), (e) => e instanceof SignatureError && e.code === 'malformed', bad);
  }
});

test('time limits: five minutes of skew either way, a maximum age, and expires', async () => {
  const mk = (at: number, extra: Parameters<typeof signRequest>[1] extends infer _ ? Record<string, unknown> : never = {}) => {
    const r = post();
    void extra;
    return withHeaders(r, signRequest(r, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', dialect: 'cavage', now: () => at }));
  };
  const opts = { resolve: keys('ed25519', ed.publicKey) };
  await verify(mk(T0 - 299_000), { ...opts, now });
  await verify(mk(T0 + 299_000), { ...opts, now });
  await fails(verify(mk(T0 + 301_000), { ...opts, now }), 'skew');
  await fails(verify(mk(T0 - 3_901_000), { ...opts, now }), 'expired');
  await verify(mk(T0 - 3_000_000), { ...opts, now, maxAgeSeconds: 3600 });
  await fails(verify(mk(T0 - 100_000), { ...opts, now, maxAgeSeconds: 60, skewSeconds: 10 }), 'expired');
  await fails(verify(mk(T0 + 20_000), { ...opts, now, skewSeconds: 10 }), 'skew');
  // an explicit expiry
  const r = withHeaders(post(), { host: 'local.example', date: new Date(T0 - 1000).toUTCString(), digest: digestHeader(body) });
  const exp = signCavage(r, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', headers: ['(request-target)', 'host', 'date', 'digest', '(expires)'], created: Math.floor(T0 / 1000) - 10, expires: Math.floor(T0 / 1000) + 100 });
  await verify(withHeaders(r, { signature: exp }), { ...opts, now });
  await verify(withHeaders(r, { signature: exp }), { ...opts, now: () => T0 + 350_000 }); // past expiry, within the skew
  await fails(verify(withHeaders(r, { signature: exp }), { ...opts, now: () => T0 + 450_000 }), 'expired');
});

test('policy: the target, host, a time and the digest of a body must be signed unless the caller turns that off', async () => {
  const full = withHeaders(post(), { host: 'local.example', date: new Date(T0).toUTCString(), digest: digestHeader(body) });
  const sign = (headers: string[]) => withHeaders(full, { signature: signCavage(full, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', headers }) });
  const opts = { ...base, resolve: keys('ed25519', ed.publicKey) };
  await verify(sign(['(request-target)', 'host', 'date', 'digest']), opts);
  await fails(verify(sign(['host', 'date', 'digest']), opts), 'policy'); // no target
  await fails(verify(sign(['(request-target)', 'date', 'digest']), opts), 'policy'); // no host
  await fails(verify(sign(['(request-target)', 'host', 'digest']), opts), 'policy'); // no time
  await fails(verify(sign(['(request-target)', 'host', 'date']), opts), 'policy'); // digest not covered
  await verify(sign(['(request-target)', 'host', 'date']), { ...opts, lax: true });
  await fails(verify(sign(['(request-target)', 'host', 'date', 'digest']), { ...opts, require: ['content-type'] }), 'policy');
  await fails(verify(sign(['(request-target)', 'host', 'date', 'digest']), { ...opts, dialects: ['rfc9421'] }), 'policy');
  await fails(verify(post(), opts), 'missing');
});

// ------------------------------------------------------------ RFC 9421

test('Signature-Input is parsed into components, parameters and the serialised inner list', () => {
  const [a] = parseSignatureInput('sig1=("@method" "@authority" "@query-param";name="q" "content-digest");created=1700000000;keyid="k1";alg="ed25519";nonce="n1";tag="fed"');
  assert.deepEqual(a?.components.map((c) => c.name), ['@method', '@authority', '@query-param', 'content-digest']);
  assert.deepEqual(a?.components[2]?.params, [['name', 'q']]);
  assert.deepEqual([a?.created, a?.keyid, a?.alg, a?.nonce, a?.tag], [1700000000, 'k1', 'ed25519', 'n1', 'fed']);
  assert.equal(a?.serialised, '("@method" "@authority" "@query-param";name="q" "content-digest");created=1700000000;keyid="k1";alg="ed25519";nonce="n1";tag="fed"');
  assert.deepEqual(parseSignatureInput('a=("x");keyid="1", b=("y");keyid="2"').map((s) => s.label), ['a', 'b']);
  assert.deepEqual(parseSignatureInput('a=();created=5')[0]?.components, []);
  for (const bad of ['', 'sig1', 'sig1=("A")', 'sig1=("a" "a")', 'sig1=(a)', 'sig1=("a");created="x"', 'a=("x"), a=("y")', 'sig1=("a")junk', 'sig1=("a";created=1;created=2)', 'sig1=("a"']) {
    assert.throws(() => parseSignatureInput(bad), (e) => e instanceof SignatureError && e.code === 'malformed', bad);
  }
});

test('every algorithm signs and verifies in RFC 9421, and the result names the key', async () => {
  const cases: [Alg, KeyObject | Uint8Array, KeyObject | Uint8Array][] = [
    ['ed25519', ed.privateKey, ed.publicKey],
    ['rsa-v1_5-sha256', rsa.privateKey, rsa.publicKey],
    ['rsa-pss-sha512', rsa.privateKey, rsa.publicKey],
    ['ecdsa-p256-sha256', ec.privateKey, ec.publicKey],
    ['ecdsa-p384-sha384', ec384.privateKey, ec384.publicKey],
    ['hmac-sha256', secret, secret],
  ];
  for (const [alg, priv, pub] of cases) {
    const req = post();
    const added = signRequest(req, { keyId: KEY_ID, key: priv, alg, dialect: 'rfc9421', now });
    assert.ok(added['content-digest'] && added['signature-input']?.includes(`alg="${alg}"`) && added.signature?.startsWith('sig1=:'));
    const v = await verify(withHeaders(req, added), { ...base, resolve: keys(alg, pub) });
    assert.deepEqual([v.dialect, v.alg, v.created], ['rfc9421', alg, Math.floor(T0 / 1000)], alg);
    assert.deepEqual(v.covered, ['@method', '@authority', '@path', '@query', 'content-digest']);
  }
});

test('the signature base lists each component then the parameters, with derived values as the spec defines them', () => {
  const req: Req = { method: 'post', url: 'https://Example.COM:8443/foo/bar?param=Value&Pet=dog', headers: { 'Content-Type': ' application/json ', 'X-Multi': ['a', 'b'] } };
  const p = parseSignatureInput('s=("@method" "@target-uri" "@authority" "@scheme" "@request-target" "@path" "@query" "@query-param";name="Pet" "content-type" "x-multi");created=1')[0]!;
  assert.equal(
    signatureBase(req, p),
    ['"@method": POST', '"@target-uri": https://Example.COM:8443/foo/bar?param=Value&Pet=dog', '"@authority": example.com:8443', '"@scheme": https', '"@request-target": /foo/bar?param=Value&Pet=dog', '"@path": /foo/bar', '"@query": ?param=Value&Pet=dog', '"@query-param";name="Pet": dog', '"content-type": application/json', '"x-multi": a, b', `"@signature-params": ${p.serialised}`].join('\n'),
  );
  const empty = parseSignatureInput('s=("@query" "@path")')[0]!;
  assert.equal(signatureBase({ method: 'GET', url: 'https://a.example', headers: {} }, empty), '"@query": ?\n"@path": /\n"@signature-params": ("@query" "@path")');
  assert.throws(() => signatureBase(req, parseSignatureInput('s=("@query-param";name="nope")')[0]!), (e) => e instanceof SignatureError && e.code === 'missing');
  assert.throws(() => signatureBase(req, parseSignatureInput('s=("x-absent")')[0]!), (e) => e instanceof SignatureError && e.code === 'missing');
  assert.throws(() => signatureBase(req, parseSignatureInput('s=("@status")')[0]!), (e) => e instanceof SignatureError && e.code === 'malformed');
});

test('a relative target needs a Host header and uses it', () => {
  const p = parseSignatureInput('s=("@authority" "@target-uri")')[0]!;
  assert.equal(signatureBase({ method: 'GET', url: '/a?b=1', headers: { Host: 'x.example' } }, p), '"@authority": x.example\n"@target-uri": https://x.example/a?b=1\n"@signature-params": ("@authority" "@target-uri")');
  assert.throws(() => signatureBase({ method: 'GET', url: '/a', headers: {} }, p), (e) => e instanceof SignatureError && e.code === 'missing');
});

test('RFC 9421 verification catches a changed method, path, query, body and signed header', async () => {
  const req = post({ date: new Date(T0).toUTCString() });
  const comps = ['@method', '@authority', '@path', '@query', 'content-digest', 'content-type'];
  const withDigest = withHeaders(req, { 'content-digest': contentDigest(body) });
  const r = signRfc9421(withDigest, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', components: comps, created: Math.floor(T0 / 1000) });
  const ok = withHeaders(withDigest, { 'signature-input': r.signatureInput, signature: r.signature });
  const opts = { ...base, resolve: keys('ed25519', ed.publicKey) };
  await verify(ok, opts);
  await fails(verify({ ...ok, method: 'PUT' }, opts), 'bad-signature');
  await fails(verify({ ...ok, url: 'https://local.example/inbox?x=2' }, opts), 'bad-signature');
  await fails(verify({ ...ok, url: 'https://local.example/inbox2?x=1' }, opts), 'bad-signature');
  await fails(verify({ ...ok, url: 'https://evil.example/inbox?x=1' }, opts), 'bad-signature');
  await fails(verify(withHeaders(ok, { 'content-type': 'text/plain' }), opts), 'bad-signature');
  await fails(verify({ ...ok, body: `${body}!` }, opts), 'digest');
  await fails(verify(withHeaders(ok, { 'signature-input': r.signatureInput.replace('ed25519', 'rsa-pss-sha512') }), opts), 'alg');
  await fails(verify(withHeaders(ok, { 'signature-input': r.signatureInput.replace(`created=${Math.floor(T0 / 1000)}`, `created=${Math.floor(T0 / 1000) + 1}`) }), opts), 'bad-signature');
});

test('a body needs a covered digest; created or a signed date is needed; method and target are needed', async () => {
  const opts = { ...base, resolve: keys('ed25519', ed.publicKey) };
  const go = (components: string[], extra: Record<string, string> = {}, created: number | null = Math.floor(T0 / 1000)) => {
    const req = withHeaders(post({ date: new Date(T0).toUTCString(), 'content-digest': contentDigest(body) }), extra);
    const r = signRfc9421(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', components, ...(created !== null ? { created } : {}) });
    return verify(withHeaders(req, { 'signature-input': r.signatureInput, signature: r.signature }), opts);
  };
  await go(['@method', '@path', '@authority', 'content-digest']);
  await fails(go(['@method', '@path', '@authority']), 'policy');
  await fails(go(['@path', '@authority', 'content-digest']), 'policy');
  await fails(go(['@method', '@authority', 'content-digest']), 'policy');
  await fails(go(['@method', '@path', 'content-digest']), 'policy');
  await fails(go(['@method', '@path', '@authority', 'content-digest'], {}, null), 'policy');
  await go(['@method', '@path', '@authority', 'content-digest', 'date'], {}, null);
  await fails(go(['@method', '@path', '@authority', 'content-digest'], { 'content-digest': contentDigest('x') }), 'digest');
});

test('several signatures: one good one is enough, and the label is matched to its signature', async () => {
  const req = post();
  const a = signRequest(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', dialect: 'rfc9421', now });
  const withA = withHeaders(req, a);
  const proxy = signRfc9421(withA, { keyId: 'https://proxy.example/k', key: ed2.privateKey, alg: 'ed25519', label: 'proxy', components: ['@method', '@authority', '@path', 'content-digest'], created: Math.floor(T0 / 1000) });
  const both = withHeaders(withA, { 'signature-input': `${a['signature-input']}, ${proxy.signatureInput}`, signature: `${a.signature}, ${proxy.signature}` });
  const only = (id: string, k: KeyObject) => async (x: string) => (x === id ? { key: k, alg: 'ed25519' as const } : undefined);
  assert.equal((await verify(both, { ...base, resolve: only('https://proxy.example/k', ed2.publicKey) })).keyId, 'https://proxy.example/k');
  assert.equal((await verify(both, { ...base, resolve: only(KEY_ID, ed.publicKey) })).keyId, KEY_ID);
  await fails(verify(withHeaders(both, { signature: a.signature as string }), { ...base, resolve: only('https://proxy.example/k', ed2.publicKey) }), 'malformed');
  const tagged = signRfc9421(withA, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', components: ['@method', '@authority', '@path', 'content-digest'], created: Math.floor(T0 / 1000), tag: 'fed' });
  const t = withHeaders(withA, { 'signature-input': tagged.signatureInput, signature: tagged.signature });
  await verify(t, { ...base, resolve: only(KEY_ID, ed.publicKey), tag: 'fed' });
  await fails(verify(t, { ...base, resolve: only(KEY_ID, ed.publicKey), tag: 'other' }), 'policy');
});

test('replays are refused when a nonce cache is given', async () => {
  const req = post();
  const ok = withHeaders(req, signRequest(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', dialect: 'rfc9421', now }));
  const nonces = new NonceCache({ now });
  const opts = { ...base, resolve: keys('ed25519', ed.publicKey), nonces };
  await verify(ok, opts);
  await fails(verify(ok, opts), 'replay');
  const later = new NonceCache({ now: () => T0 + 10_000_000 });
  assert.equal(later.claim('a', 1000), true);
  assert.equal(later.claim('a', 1000), false);
});

test('RFC 9421 time rules match the cavage ones', async () => {
  const opts = { resolve: keys('ed25519', ed.publicKey) };
  const at = (t: number) => {
    const req = post();
    return withHeaders(req, signRequest(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', dialect: 'rfc9421', now: () => t, expiresInSeconds: 60 }));
  };
  await verify(at(T0), { ...opts, now });
  await fails(verify(at(T0 + 400_000), { ...opts, now }), 'skew');
  await fails(verify(at(T0 - 400_000), { ...opts, now }), 'expired'); // expires 60 s after creation, 340 s ago, more than the skew
  await verify(at(T0 - 200_000), { ...opts, now });
});

// ------------------------------------------------------------ keys

test('a key id may only lead to a public https address, and the fragment is dropped', () => {
  assert.equal(keyDocumentUrl('https://mastodon.example/users/ana#main-key'), 'https://mastodon.example/users/ana');
  assert.equal(keyDocumentUrl('https://a.example/actor?x=1'), 'https://a.example/actor?x=1');
  assert.equal(keyDocumentUrl('https://a.example/actor', { allowHosts: ['A.example'] }), 'https://a.example/actor');
  for (const bad of ['http://a.example/k', 'ftp://a.example/k', 'https://user:pw@a.example/k', 'https://localhost/k', 'https://x.localhost/k', 'https://intranet/k', 'https://printer.local/k', 'https://127.0.0.1/k', 'https://10.0.0.5/k', 'https://192.168.1.1/k', 'https://169.254.169.254/latest', 'https://[::1]/k', 'https://[fd00::1]/k', 'https://2130706433/k', 'https://a.example:8080/k', 'not a url', 'https://[::ffff:127.0.0.1]/k']) {
    assert.throws(() => keyDocumentUrl(bad), (e) => e instanceof SignatureError && e.code === 'key-url', bad);
  }
  assert.throws(() => keyDocumentUrl('https://b.example/k', { allowHosts: ['a.example'] }), /not an allowed key host/);
  assert.equal(keyDocumentUrl('http://a.example/k', { allowHttp: true }), 'http://a.example/k');
  assert.equal(isPrivateAddress('172.15.0.1'), false);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('the key cache fetches once, remembers misses for a shorter time, and shares one fetch among simultaneous requests', async () => {
  let t = 0;
  let fetched = 0;
  let gate: () => void = () => undefined;
  const wait = new Promise<void>((r) => (gate = r));
  const r = cachedResolver(async (id) => {
    fetched++;
    await wait;
    return id.includes('known') ? { key: ed.publicKey, alg: 'ed25519' } : undefined;
  }, { now: () => t, ttlMs: 1000, negativeTtlMs: 100 });
  const [a, b] = [r('known'), r('known')];
  gate();
  assert.deepEqual([(await a)?.alg, (await b)?.alg], ['ed25519', 'ed25519']);
  assert.equal(fetched, 1);
  await r('known');
  assert.equal(fetched, 1);
  await r('missing');
  await r('missing');
  assert.equal(fetched, 2);
  t = 150;
  await r('missing');
  assert.equal(fetched, 3);
  await r('known');
  assert.equal(fetched, 3);
  t = 1200;
  await r('known');
  assert.equal(fetched, 4);
  await r('known', { fresh: true });
  assert.equal(fetched, 5);
  assert.equal(r.size(), 2);
  r.clear();
  assert.equal(r.size(), 0);
});

test('a rotated key is picked up: a failed check retries once with a fresh key, but a forged signature is still refused', async () => {
  const req = post();
  const signed = withHeaders(req, signRequest(req, { keyId: KEY_ID, key: ed2.privateKey, alg: 'ed25519', dialect: 'cavage', now }));
  let current: KeyObject = ed.publicKey; // the cache still has the old key
  let fetches = 0;
  const r = cachedResolver(async () => ({ key: current, alg: 'ed25519' }), { now: () => 0 });
  await r(KEY_ID); // warm
  current = ed2.publicKey; // the owner rotated
  const counted: typeof r = Object.assign(async (id: string, o?: { fresh?: boolean }) => (fetches++, r(id, o)), { size: r.size, clear: r.clear });
  assert.equal((await verify(signed, { ...base, resolve: counted })).keyId, KEY_ID);
  assert.equal(fetches, 2);
  const forged = withHeaders(req, signRequest(req, { keyId: KEY_ID, key: rsa.privateKey, alg: 'rsa-v1_5-sha256', dialect: 'cavage', now }));
  fetches = 0;
  await fails(verify(forged, { ...base, resolve: counted }), 'bad-signature');
  assert.equal(fetches, 2); // one look, one fresh look, then refused
});

test('keys are checked: weak RSA, wrong curve, wrong type, short or wrong-kind HMAC secrets', async () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const req = post();
  const code = (f: () => unknown) => assert.throws(f, (e) => e instanceof SignatureError && e.code === 'key');
  code(() => signRequest(req, { keyId: KEY_ID, key: weak.privateKey, alg: 'rsa-v1_5-sha256', dialect: 'cavage', now }));
  code(() => signRequest(req, { keyId: KEY_ID, key: ec.privateKey, alg: 'ecdsa-p384-sha384', dialect: 'cavage', now }));
  code(() => signRequest(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'rsa-pss-sha512', dialect: 'rfc9421', now }));
  code(() => signRequest(req, { keyId: KEY_ID, key: rsa.privateKey, alg: 'ed25519', dialect: 'rfc9421', now }));
  code(() => signRequest(req, { keyId: KEY_ID, key: randomBytes(8), alg: 'hmac-sha256', dialect: 'cavage', now }));
  code(() => signRequest(req, { keyId: KEY_ID, key: new Uint8Array(32), alg: 'ed25519', dialect: 'cavage', now }));
  code(() => signRequest(req, { keyId: KEY_ID, key: ed.publicKey, alg: 'ed25519', dialect: 'cavage', now }));
  const ok = withHeaders(req, signRequest(req, { keyId: KEY_ID, key: ec.privateKey, alg: 'ecdsa-p256-sha256', dialect: 'cavage', now }));
  await fails(verify(ok, { ...base, resolve: keys('ecdsa-p256-sha256', weak.publicKey) }), 'key');
  await verify(ok, { ...base, resolve: keys('ecdsa-p256-sha256', ec.publicKey) });
});

test('a garbage signature value is a wrong signature, not a crash', async () => {
  const req = post();
  const ok = withHeaders(req, signRequest(req, { keyId: KEY_ID, key: ed.privateKey, alg: 'ed25519', dialect: 'cavage', now }));
  const opts = { ...base, resolve: keys('ed25519', ed.publicKey) };
  const bad = (sig: string) => withHeaders(ok, { signature: (ok.headers.signature as string).replace(/signature="[^"]*"/, `signature="${sig}"`) });
  await fails(verify(bad('AAAA'), opts), 'bad-signature');
  await fails(verify(bad(''), opts), 'malformed');
  await fails(verify(bad('not base64!'), opts), 'malformed');
});
