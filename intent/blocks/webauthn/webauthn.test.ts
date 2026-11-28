import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { bitString, boolean, explicit, integer, octetString, oid, oidOf, sequence, set, time, toPem, utf8String } from '../asn1-der/index.ts';
import { BadCbor, Challenges, coseToKey, FLAG, MemoryCredentials, Rejected, WebAuthn, decodeCbor, encodeCbor, parseAuthData, parseCbor } from './index.ts';
import type { Alg, AttestationPolicy, Cbor, RelyingParty } from './index.ts';

// A throwaway attestation CA and authenticator certificate (EC P-256, valid for a century), made fresh for each run.
/** A throwaway certificate made at run time: DER from the asn1-der writers, signed with node:crypto (ECDSA P-256 / SHA-256). */
const certName = (cn: string) => sequence(set(sequence(oid(oidOf('CN')), utf8String(cn))));
function makeCert(o: { subject: string; publicKey: KeyObject; issuer?: string; issuerKey: KeyObject; ca?: boolean }): string {
  const algId = sequence(oid(oidOf('ecdsa-with-SHA256')));
  const exts = o.ca ? [explicit(3, sequence(sequence(oid(oidOf('basicConstraints')), boolean(true), octetString(sequence(boolean(true))))))] : [];
  const tbs = sequence(
    explicit(0, integer(2)), integer(BigInt(`0x${randomBytes(12).toString('hex')}`)), algId, certName(o.issuer ?? o.subject),
    sequence(time(new Date(Date.UTC(2020, 0, 1))), time(new Date(Date.UTC(2120, 0, 1)))),
    certName(o.subject), Buffer.from(o.publicKey.export({ type: 'spki', format: 'der' })), ...exts,
  );
  return toPem('CERTIFICATE', sequence(tbs, algId, bitString(cryptoSign('sha256', tbs, o.issuerKey)))).trim();
}
const rootPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const leafPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const foreignPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ROOT_PEM = `${makeCert({ subject: 'Test Attestation Root', publicKey: rootPair.publicKey, issuerKey: rootPair.privateKey, ca: true })}\n`;
const LEAF_PEM = `${makeCert({ subject: 'Test Authenticator', issuer: 'Test Attestation Root', publicKey: leafPair.publicKey, issuerKey: rootPair.privateKey })}\n`;
const FOREIGN_PEM = `${makeCert({ subject: 'Some Other Root', publicKey: foreignPair.publicKey, issuerKey: foreignPair.privateKey, ca: true })}\n`;
const LEAF_KEY = leafPair.privateKey;

const ORIGIN = 'https://app.example.org';
const RP_ID = 'app.example.org';
const NOW = Date.parse('2030-01-01T00:00:00Z');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

let counter = 0;
const rnd = (n: number) => Buffer.alloc(n, 1 + (counter++ % 250));

const make = (o: Partial<RelyingParty> = {}) => {
  const t = { now: NOW };
  const wa = new WebAuthn({ rpId: RP_ID, rpName: 'Example', origins: [ORIGIN], now: () => t.now, random: rnd, ...o });
  return { wa, t };
};

const coseEc = (pub: KeyObject): Map<number, Cbor> => {
  const j = pub.export({ format: 'jwk' });
  return new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(String(j['x']), 'base64url')], [-3, Buffer.from(String(j['y']), 'base64url')]]);
};
const coseRsa = (pub: KeyObject): Map<number, Cbor> => {
  const j = pub.export({ format: 'jwk' });
  return new Map<number, Cbor>([[1, 3], [3, -257], [-1, Buffer.from(String(j['n']), 'base64url')], [-2, Buffer.from(String(j['e']), 'base64url')]]);
};
const coseEd = (pub: KeyObject): Map<number, Cbor> => new Map<number, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(String(pub.export({ format: 'jwk' })['x']), 'base64url')]]);

const authData = (o: { flags: number; count: number; rpId?: string; attested?: { aaguid?: Buffer; id: Buffer; cose: Map<number, Cbor> } }): Buffer => {
  const parts: Buffer[] = [sha(o.rpId ?? RP_ID), Buffer.from([o.flags]), Buffer.alloc(4)];
  parts[2]!.writeUInt32BE(o.count);
  if (o.attested) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(o.attested.id.length);
    parts.push(o.attested.aaguid ?? Buffer.alloc(16, 0), len, o.attested.id, encodeCbor(o.attested.cose));
  }
  return Buffer.concat(parts);
};

interface Fake {
  readonly id: Buffer;
  readonly alg: Alg;
  readonly pub: KeyObject;
  readonly priv: KeyObject;
  count: number;
  flags: number;
}
const fake = (alg: Alg = -7, flags = FLAG.UP | FLAG.UV): Fake => {
  const id = Buffer.from(sha(String(counter++)));
  if (alg === -7) {
    const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { id, alg, pub: k.publicKey, priv: k.privateKey, count: 0, flags };
  }
  if (alg === -8) {
    const k = generateKeyPairSync('ed25519');
    return { id, alg, pub: k.publicKey, priv: k.privateKey, count: 0, flags };
  }
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { id, alg, pub: k.publicKey, priv: k.privateKey, count: 0, flags };
};
const cose = (f: Fake) => (f.alg === -7 ? coseEc(f.pub) : f.alg === -8 ? coseEd(f.pub) : coseRsa(f.pub));
const sign = (f: Fake | KeyObject, data: Buffer): Buffer => {
  if (f instanceof Object && 'priv' in f) return f.alg === -8 ? cryptoSign(null, data, f.priv) : cryptoSign('sha256', data, f.priv);
  return cryptoSign('sha256', data, f as KeyObject);
};

const clientData = (type: string, challenge: string, origin = ORIGIN, extra: object = {}) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));

interface CreateOpts {
  fmt?: 'none' | 'packed-self' | 'packed-x5c' | 'u2f';
  type?: string;
  origin?: string;
  challenge?: string;
  rpId?: string;
  flags?: number;
  aaguid?: Buffer;
  id?: string;
  badSig?: boolean;
  chain?: Buffer[];
  crossOrigin?: boolean;
}
const create = (f: Fake, options: Record<string, unknown>, o: CreateOpts = {}) => {
  const cd = clientData(o.type ?? 'webauthn.create', o.challenge ?? String(options['challenge']), o.origin, o.crossOrigin ? { crossOrigin: true } : {});
  const ad = authData({ flags: (o.flags ?? f.flags) | FLAG.AT, count: f.count, ...(o.rpId ? { rpId: o.rpId } : {}), attested: { id: f.id, cose: cose(f), ...(o.aaguid ? { aaguid: o.aaguid } : {}) } });
  const ch = sha(cd);
  const fmt = o.fmt ?? 'none';
  const leafKey = LEAF_KEY;
  const stmt = new Map<string, Cbor>();
  let name = 'none';
  if (fmt === 'packed-self') {
    name = 'packed';
    const sig = sign(f, Buffer.concat([ad, ch]));
    if (o.badSig) sig[sig.length - 1]! ^= 1;
    stmt.set('alg', f.alg);
    stmt.set('sig', sig);
  } else if (fmt === 'packed-x5c') {
    name = 'packed';
    const sig = cryptoSign('sha256', Buffer.concat([ad, ch]), leafKey);
    if (o.badSig) sig[sig.length - 1]! ^= 1;
    stmt.set('alg', -7);
    stmt.set('sig', sig);
    stmt.set('x5c', o.chain ?? [new X509Certificate(LEAF_PEM).raw]);
  } else if (fmt === 'u2f') {
    name = 'fido-u2f';
    const j = f.pub.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(String(j['x']), 'base64url'), Buffer.from(String(j['y']), 'base64url')]);
    const sig = cryptoSign('sha256', Buffer.concat([Buffer.from([0]), sha(RP_ID), ch, f.id, point]), leafKey);
    stmt.set('sig', sig);
    stmt.set('x5c', [new X509Certificate(LEAF_PEM).raw]);
  }
  const ao = encodeCbor(new Map<string, Cbor>([['fmt', name], ['attStmt', stmt], ['authData', ad]]));
  return { id: o.id ?? f.id.toString('base64url'), response: { clientDataJSON: cd.toString('base64url'), attestationObject: ao.toString('base64url'), transports: ['internal'] } };
};

interface GetOpts {
  type?: string;
  origin?: string;
  challenge?: string;
  rpId?: string;
  flags?: number;
  count?: number;
  userHandle?: string | null;
  signWith?: Fake;
}
const get = (f: Fake, options: Record<string, unknown>, o: GetOpts = {}) => {
  const cd = clientData(o.type ?? 'webauthn.get', o.challenge ?? String(options['challenge']), o.origin);
  f.count = o.count ?? f.count + 1;
  const ad = authData({ flags: o.flags ?? f.flags, count: f.count, ...(o.rpId ? { rpId: o.rpId } : {}) });
  const sig = sign(o.signWith ?? f, Buffer.concat([ad, sha(cd)]));
  return { id: f.id.toString('base64url'), response: { clientDataJSON: cd.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url'), ...(o.userHandle !== undefined ? { userHandle: o.userHandle } : {}) } };
};

const coseCheck = (m: Map<number, Cbor>) => coseToKey(encodeCbor(m));
const user = { id: 'user-1', name: 'ana@example.org', displayName: 'Ana' };
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof Rejected, String(e));
    return e.code;
  }
  return 'ok';
};
const register = (w: ReturnType<typeof make>, f: Fake, o: CreateOpts = {}) => {
  const { ceremony, options } = w.wa.beginRegistration(user);
  return w.wa.finishRegistration(ceremony, create(f, options, o));
};

test('RFC 8949 appendix A: the published examples decode, and encode back byte for byte', () => {
  const cases: [string, Cbor][] = [
    ['00', 0], ['01', 1], ['0a', 10], ['17', 23], ['1818', 24], ['1819', 25], ['1864', 100], ['1903e8', 1000], ['1a000f4240', 1000000],
    ['20', -1], ['29', -10], ['3863', -100], ['3903e7', -1000], ['f4', false], ['f5', true], ['f6', null],
    ['40', Buffer.alloc(0)], ['4401020304', Buffer.from([1, 2, 3, 4])], ['60', ''], ['6161', 'a'], ['6449455446', 'IETF'], ['62225c', '"\\'], ['62c3bc', 'ü'], ['63e6b0b4', '水'],
    ['80', []], ['83010203', [1, 2, 3]], ['8301820203820405', [1, [2, 3], [4, 5]]], ['a0', new Map()], ['a201020304', new Map<number | string, Cbor>([[1, 2], [3, 4]])],
    ['a26161016162820203', new Map<number | string, Cbor>([['a', 1], ['b', [2, 3]]])],
  ];
  for (const [h, v] of cases) {
    assert.deepEqual(parseCbor(hex(h)), v, h);
    assert.equal(encodeCbor(v).toString('hex'), h, `encode ${h}`);
  }
  assert.equal(parseCbor(hex('1bffffffffffffffff')), 18446744073709551615n);
  assert.equal(parseCbor(hex('3bffffffffffffffff')), -18446744073709551616n);
});

test('CBOR outside the deterministic subset is refused: floats, tags, indefinite lengths, odd numbers, duplicate keys, depth', () => {
  for (const [h, why] of [['f93c00', /floats/], ['fb3ff199999999999a', /floats/], ['c074323031332d30332d32315432303a30343a30305a', /tags/], ['5f42010243030405ff', /indefinite/], ['9f0102ff', /indefinite/], ['1800', /shortest/], ['190001', /shortest/], ['a201010102', /twice/], ['a2616101616102', /twice/], ['a1f401', /keys/], ['8301', /ran out/], ['41', /longer/], ['62c328', /UTF-8/]] as const) {
    assert.throws(() => parseCbor(hex(h)), (e: Error) => e instanceof BadCbor && why.test(e.message), h);
  }
  assert.throws(() => parseCbor(hex('0001')), /left over/);
  assert.throws(() => parseCbor(Buffer.from('81'.repeat(40) + '00', 'hex')), /deeply/);
  assert.deepEqual(decodeCbor(hex('a1010201'), 0).end, 3, 'what follows is left for the caller');
});

test('registration options carry a challenge, the algorithms, and exclude what is already registered', () => {
  const w = make();
  const first = w.wa.beginRegistration(user);
  assert.match(String(first.options['challenge']), /^[A-Za-z0-9_-]{43}$/, '32 random bytes');
  assert.notEqual(w.wa.beginRegistration(user).options['challenge'], first.options['challenge']);
  assert.deepEqual((first.options['pubKeyCredParams'] as { alg: number }[]).map((p) => p.alg), [-7, -257, -8]);
  assert.deepEqual(first.options['rp'], { id: RP_ID, name: 'Example' });
  assert.deepEqual(first.options['excludeCredentials'], []);
  assert.equal(first.options['attestation'], 'none');
  const f = fake();
  register(w, f);
  const again = w.wa.beginRegistration(user);
  assert.deepEqual((again.options['excludeCredentials'] as { id: string }[]).map((c) => c.id), [f.id.toString('base64url')]);
});

test('a "none" registration is verified and stored with what the authenticator said about itself', () => {
  const w = make();
  const f = fake(-7, FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS);
  const c = register(w, f, { aaguid: Buffer.alloc(16, 0xab) });
  assert.deepEqual([c.id, c.userId, c.alg, c.signCount, c.aaguid, c.backupEligible, c.backedUp, c.fmt, c.attestationTrusted, c.createdAt, c.transports], [f.id.toString('base64url'), 'user-1', -7, 0, 'abababab-abab-abab-abab-abababababab', true, true, 'none', false, NOW, ['internal']]);
  assert.equal(w.wa.credentials.get(c.id), c);
});

test('registration refuses a wrong challenge, origin, type, rp id, missing presence and a cross-origin frame', () => {
  const run = (o: CreateOpts, rp: Partial<RelyingParty> = {}) => {
    const w = make(rp);
    return code(() => register(w, fake(), o));
  };
  assert.equal(run({ challenge: 'AAAA' }), 'challenge');
  assert.equal(run({ origin: 'https://evil.example' }), 'origin');
  assert.equal(run({ origin: 'https://app.example.org.evil.example' }), 'origin');
  assert.equal(run({ crossOrigin: true }), 'origin');
  assert.equal(run({ type: 'webauthn.get' }), 'client_data');
  assert.equal(run({ rpId: 'evil.example' }), 'rp_id');
  assert.equal(run({ flags: FLAG.UV }), 'presence');
  assert.equal(run({ flags: FLAG.UP }, { userVerification: 'required' }), 'verification');
  assert.equal(run({ flags: FLAG.UP | FLAG.BS }), 'flags', 'backed up but not eligible');
  assert.equal(run({ id: 'AAAA' }), 'attestation', 'reported id is not the credential id');
});

test('a ceremony is single-use and lapses', () => {
  const w = make();
  const { ceremony, options } = w.wa.beginRegistration(user);
  const f = fake();
  const resp = create(f, options);
  w.wa.finishRegistration(ceremony, resp);
  assert.equal(code(() => w.wa.finishRegistration(ceremony, create(fake(), options))), 'challenge', 'the same ceremony twice');
  const slow = w.wa.beginRegistration(user);
  w.t.now += 5 * 60_000;
  assert.equal(code(() => w.wa.finishRegistration(slow.ceremony, create(fake(), slow.options))), 'challenge');
  const login = w.wa.beginAuthentication('user-1');
  assert.equal(code(() => w.wa.finishRegistration(login.ceremony, create(fake(), login.options))), 'challenge', 'a sign-in challenge cannot register');
});

test('the same credential cannot be registered twice', () => {
  const w = make();
  const f = fake();
  register(w, f);
  assert.equal(code(() => register(w, f)), 'duplicate');
});

test('packed self attestation proves possession of the key; a bad signature is refused', () => {
  const policy: AttestationPolicy = { formats: ['none', 'packed'] };
  const w = make({ attestation: policy });
  assert.equal(register(w, fake(), { fmt: 'packed-self' }).fmt, 'packed');
  assert.equal(code(() => register(w, fake(), { fmt: 'packed-self', badSig: true })), 'attestation');
  assert.equal(register(w, fake(-8), { fmt: 'packed-self' }).alg, -8);
  const strict = make();
  assert.equal(code(() => register(strict, fake(), { fmt: 'packed-self' })), 'attestation', 'a format the policy does not list');
});

test('packed x5c: the signature is checked with the certificate and the chain must reach a trusted root', () => {
  const trusted = make({ attestation: { formats: ['packed'], trustedRoots: [ROOT_PEM] } });
  const withLeaf = (rp: Partial<RelyingParty>) => make(rp);
  const c = register(trusted, fake(), { fmt: 'packed-x5c', chain: [new X509Certificate(LEAF_PEM).raw, new X509Certificate(ROOT_PEM).raw] });
  assert.equal(c.attestationTrusted, true);
  assert.equal(register(withLeaf({ attestation: { formats: ['packed'], trustedRoots: [ROOT_PEM] } }), fake(), { fmt: 'packed-x5c' }).attestationTrusted, true, 'the leaf alone, signed by the root');
  assert.equal(code(() => register(trusted, fake(), { fmt: 'packed-x5c', badSig: true })), 'attestation');
  const noRoots = make({ attestation: { formats: ['packed'] } });
  assert.equal(register(noRoots, fake(), { fmt: 'packed-x5c' }).attestationTrusted, false, 'verified, but not chained to anything the policy trusts');
  const wrongRoot = make({ attestation: { formats: ['packed'], trustedRoots: [FOREIGN_PEM] } });
  assert.equal(code(() => register(wrongRoot, fake(), { fmt: 'packed-x5c' })), 'attestation');
  const late = make({ attestation: { formats: ['packed'], trustedRoots: [ROOT_PEM] } });
  late.t.now = Date.parse('2200-01-01T00:00:00Z');
  assert.equal(code(() => register(late, fake(), { fmt: 'packed-x5c' })), 'attestation', 'a certificate past its dates');
  const needsProof = make({ attestation: { formats: ['none', 'packed'], trustedRoots: [ROOT_PEM] } });
  assert.equal(code(() => register(needsProof, fake(), { fmt: 'none' })), 'attestation', 'trusted roots set: "none" is not enough');
  assert.equal(code(() => register(needsProof, fake(), { fmt: 'packed-self' })), 'attestation', 'nor is a self attestation');
});

test('fido-u2f attestation is verified over the U2F registration message', () => {
  const w = make({ attestation: { formats: ['fido-u2f'], trustedRoots: [ROOT_PEM] } });
  const c = register(w, fake(), { fmt: 'u2f' });
  assert.deepEqual([c.fmt, c.attestationTrusted], ['fido-u2f', true]);
  assert.equal(code(() => register(w, fake(-8), { fmt: 'u2f' })), 'attestation', 'U2F is P-256 only');
});

test('the policy can allow or deny authenticator models by AAGUID', () => {
  const good = Buffer.alloc(16, 0x11);
  const bad = Buffer.alloc(16, 0x22);
  const allow = make({ attestation: { formats: ['none'], allowedAaguids: ['11111111-1111-1111-1111-111111111111'] } });
  assert.equal(register(allow, fake(), { aaguid: good }).aaguid, '11111111-1111-1111-1111-111111111111');
  assert.equal(code(() => register(allow, fake(), { aaguid: bad })), 'aaguid');
  const deny = make({ attestation: { formats: ['none'], deniedAaguids: ['22222222-2222-2222-2222-222222222222'] } });
  assert.equal(code(() => register(deny, fake(), { aaguid: bad })), 'aaguid');
  assert.equal(register(deny, fake(), { aaguid: good }).alg, -7);
});

test('unsupported attestation formats and malformed objects are refused', () => {
  const w = make({ attestation: { formats: ['none'] } });
  const { ceremony, options } = w.wa.beginRegistration(user);
  const f = fake();
  const resp = create(f, options);
  const ao = parseCbor(Buffer.from(resp.response.attestationObject, 'base64url')) as Map<string, Cbor>;
  const tpm = encodeCbor(new Map<string, Cbor>([['fmt', 'tpm'], ['attStmt', new Map()], ['authData', ao.get('authData')!]])).toString('base64url');
  assert.equal(code(() => w.wa.finishRegistration(ceremony, { ...resp, response: { ...resp.response, attestationObject: tpm } })), 'attestation');
  const b = w.wa.beginRegistration(user);
  assert.equal(code(() => w.wa.finishRegistration(b.ceremony, { ...create(f, b.options), response: { clientDataJSON: create(f, b.options).response.clientDataJSON, attestationObject: Buffer.from('ff', 'hex').toString('base64url') } })), 'attestation');
  const c = w.wa.beginRegistration(user);
  const junk = { ...create(f, c.options), response: { clientDataJSON: Buffer.from('not json').toString('base64url'), attestationObject: '' } };
  assert.equal(code(() => w.wa.finishRegistration(c.ceremony, junk)), 'client_data');
});

test('authenticator data is parsed strictly', () => {
  const f = fake();
  const ok = authData({ flags: FLAG.UP | FLAG.AT, count: 7, attested: { id: f.id, cose: cose(f) } });
  const a = parseAuthData(ok);
  assert.deepEqual([a.signCount, a.attested!.credentialId.equals(f.id), a.attested!.aaguid], [7, true, '00000000-0000-0000-0000-000000000000']);
  assert.throws(() => parseAuthData(ok.subarray(0, 36)), /too short/);
  assert.throws(() => parseAuthData(ok.subarray(0, 60)), /cut short|impossible|ran out|CBOR/);
  assert.throws(() => parseAuthData(Buffer.concat([ok, Buffer.from([0])])), /left over/);
  const withExt = parseAuthData(Buffer.concat([authData({ flags: FLAG.UP | FLAG.ED, count: 1 }), encodeCbor(new Map<string, Cbor>([['credProtect', 2]]))]));
  assert.equal(withExt.hasExtensions, true);
  assert.throws(() => parseAuthData(authData({ flags: FLAG.UP | FLAG.ED, count: 1 })), /extensions/);
});

test('sign-in: verified for ES256, RS256 and EdDSA credentials, with the counter and last use recorded', () => {
  for (const alg of [-7, -257, -8] as const) {
    const w = make();
    const f = fake(alg);
    register(w, f);
    w.t.now += 1000;
    const { ceremony, options } = w.wa.beginAuthentication('user-1');
    assert.deepEqual((options['allowCredentials'] as { id: string }[]).map((c) => c.id), [f.id.toString('base64url')]);
    const r = w.wa.finishAuthentication(ceremony, get(f, options));
    assert.deepEqual([r.credential.signCount, r.credential.lastUsedAt, r.counterWarning], [1, NOW + 1000, false], String(alg));
  }
});

test('sign-in refuses a bad signature, another key, a wrong challenge, origin, type, rp id and missing presence', () => {
  const w = make({ userVerification: 'required' });
  const f = fake();
  register(w, f);
  const attempt = (o: GetOpts) => {
    const { ceremony, options } = w.wa.beginAuthentication('user-1');
    return code(() => w.wa.finishAuthentication(ceremony, get(f, options, o)));
  };
  assert.equal(attempt({ signWith: fake() }), 'signature');
  assert.equal(attempt({ challenge: 'AAAA' }), 'challenge');
  assert.equal(attempt({ origin: 'https://evil.example' }), 'origin');
  assert.equal(attempt({ type: 'webauthn.create' }), 'client_data');
  assert.equal(attempt({ rpId: 'evil.example' }), 'rp_id');
  assert.equal(attempt({ flags: FLAG.UV }), 'presence');
  assert.equal(attempt({ flags: FLAG.UP }), 'verification');
  assert.equal(attempt({}), 'ok');
});

test('a signature over different data (a replayed assertion for another challenge) does not verify', () => {
  const w = make();
  const f = fake();
  register(w, f);
  const first = w.wa.beginAuthentication('user-1');
  const captured = get(f, first.options);
  w.wa.finishAuthentication(first.ceremony, captured);
  const second = w.wa.beginAuthentication('user-1');
  assert.equal(code(() => w.wa.finishAuthentication(second.ceremony, captured)), 'challenge', 'the old response carries the old challenge');
  assert.equal(code(() => w.wa.finishAuthentication(first.ceremony, captured)), 'challenge', 'and a ceremony is used once');
});

test('counters: a counter that does not rise is refused as a possible clone, unless the policy only warns; zeros are allowed', () => {
  const w = make();
  const f = fake();
  register(w, f);
  const step = (o: GetOpts, ww = w) => {
    const { ceremony, options } = ww.wa.beginAuthentication('user-1');
    return ww.wa.finishAuthentication(ceremony, get(f, options, o));
  };
  assert.equal(step({ count: 5 }).credential.signCount, 5);
  assert.equal(code(() => step({ count: 5 })), 'counter');
  assert.equal(code(() => step({ count: 3 })), 'counter');
  assert.equal(step({ count: 6 }).credential.signCount, 6);
  const warn = make({ onCounterRegression: 'warn' });
  register(warn, f);
  step({ count: 9 }, warn);
  const r = step({ count: 2 }, warn);
  assert.deepEqual([r.counterWarning, r.credential.signCount], [true, 9], 'the highest value is kept');
  const zero = make();
  const z = fake();
  register(zero, z);
  for (let i = 0; i < 2; i++) {
    const { ceremony, options } = zero.wa.beginAuthentication('user-1');
    assert.equal(zero.wa.finishAuthentication(ceremony, get(z, options, { count: 0 })).counterWarning, false, 'authenticators with no counter stay at zero');
  }
});

test('whose credential: a credential of another person, and a discoverable sign-in with the right and wrong user handle', () => {
  const w = make();
  const f = fake();
  register(w, f);
  const other = w.wa.beginAuthentication('user-2');
  assert.equal(code(() => w.wa.finishAuthentication(other.ceremony, get(f, other.options))), 'credential');
  const unknown = w.wa.beginAuthentication('user-1');
  assert.equal(code(() => w.wa.finishAuthentication(unknown.ceremony, { ...get(f, unknown.options), id: 'AAAA' })), 'credential');
  const handle = Buffer.from('user-1').toString('base64url');
  const d1 = w.wa.beginAuthentication();
  assert.deepEqual(d1.options['allowCredentials'], []);
  assert.equal(w.wa.finishAuthentication(d1.ceremony, get(f, d1.options, { userHandle: handle })).credential.userId, 'user-1');
  const d2 = w.wa.beginAuthentication();
  assert.equal(code(() => w.wa.finishAuthentication(d2.ceremony, get(f, d2.options))), 'credential', 'a discoverable sign-in must name its user');
  const d3 = w.wa.beginAuthentication();
  assert.equal(code(() => w.wa.finishAuthentication(d3.ceremony, get(f, d3.options, { userHandle: Buffer.from('user-2').toString('base64url') }))), 'credential');
});

test('backup eligibility cannot change; backup state follows the authenticator', () => {
  const w = make();
  const f = fake(-7, FLAG.UP | FLAG.UV | FLAG.BE);
  register(w, f);
  const a = w.wa.beginAuthentication('user-1');
  assert.equal(w.wa.finishAuthentication(a.ceremony, get(f, a.options, { flags: FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS })).credential.backedUp, true);
  const b = w.wa.beginAuthentication('user-1');
  assert.equal(code(() => w.wa.finishAuthentication(b.ceremony, get(f, b.options, { flags: FLAG.UP | FLAG.UV }))), 'flags', 'was eligible, now says it is not');
});

test('credential management: list without keys, rename, and the last passkey is kept', () => {
  const w = make();
  const a = fake();
  const b = fake();
  register(w, a);
  w.t.now += 10;
  register(w, b);
  const list = w.wa.credentialList('user-1');
  assert.deepEqual(list.map((c) => c.id), [a.id.toString('base64url'), b.id.toString('base64url')]);
  assert.ok(!JSON.stringify(list).includes('cosePublicKey'));
  w.wa.rename('user-1', list[0]!.id, ' Work laptop ');
  assert.equal(w.wa.credentialList('user-1')[0]!.name, 'Work laptop');
  assert.equal(code(() => w.wa.rename('user-1', list[0]!.id, '  ')), 'name');
  assert.equal(code(() => w.wa.rename('user-2', list[0]!.id, 'x')), 'credential', 'not someone else\'s');
  assert.equal(code(() => w.wa.remove('user-2', list[0]!.id)), 'credential');
  w.wa.remove('user-1', list[0]!.id);
  assert.equal(code(() => w.wa.remove('user-1', list[1]!.id)), 'last');
  w.wa.remove('user-1', list[1]!.id, { otherSignIn: true });
  assert.deepEqual(w.wa.credentialList('user-1'), []);
  const ceremony = w.wa.beginAuthentication('user-1');
  assert.equal(code(() => w.wa.finishAuthentication(ceremony.ceremony, get(a, ceremony.options))), 'credential', 'a removed passkey no longer signs in');
});

test('the relying party refuses origins that are not exact https origins, and keys that are too weak or unknown', () => {
  for (const bad of [[], ['http://app.example.org'], ['https://app.example.org/path'], ['*'], ['app.example.org']]) assert.throws(() => new WebAuthn({ rpId: RP_ID, rpName: 'x', origins: bad }), RangeError);
  assert.doesNotThrow(() => new WebAuthn({ rpId: 'localhost', rpName: 'x', origins: ['http://localhost:3000'] }));
  const w = make({ algs: [-7] });
  assert.equal(code(() => register(w, fake(-8))), 'alg', 'an algorithm that was not offered');
  const smallRsa = new Map<number, Cbor>([[1, 3], [3, -257], [-1, Buffer.alloc(128, 1)], [-2, Buffer.from([1, 0, 1])]]);
  assert.throws(() => parseAuthData(authData({ flags: FLAG.UP | FLAG.AT, count: 0, attested: { id: Buffer.alloc(16, 1), cose: smallRsa } })).attested && coseCheck(smallRsa), /2048/);
  const wrongCurve = new Map<number, Cbor>([[1, 2], [3, -7], [-1, 2], [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]]);
  assert.throws(() => coseCheck(wrongCurve), /P-256/);
});

test('a registered ceremony state belongs to the library and can be shared storage: challenges expire and are swept', () => {
  const t = { now: 0 };
  const c = new Challenges({ now: () => t.now, random: rnd, ttlMs: 1000 });
  const one = c.issue('get', 'u');
  t.now = 999;
  assert.equal(c.take(one.id, 'get').user, 'u');
  const two = c.issue('get');
  t.now = 2000;
  assert.throws(() => c.take(two.id, 'get'), /too long/);
  assert.throws(() => c.take('nope', 'get'), /not started here/);
  const store = new MemoryCredentials();
  assert.deepEqual(store.forUser('x'), []);
});
