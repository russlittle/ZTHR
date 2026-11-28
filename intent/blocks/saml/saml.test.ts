import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, randomBytes, sign as nodeSign, type KeyObject } from 'node:crypto';
import { bitString, boolean, explicit, integer, octetString, oid, oidOf, sequence, set, time, toPem, utf8String } from '../asn1-der/index.ts';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { Sp, SamlError, MemoryRequestStore, MemoryReplayCache, parseTime, formatTime, inflateRedirect, verifyRedirectSignature, spMetadata, parseIdpMetadata, NS, BINDING, NAMEID, type SpConfig } from './index.ts';
import { sign, readXml, verifyDocument, childNamed, NS_DSIG } from '../xml-dsig/index.ts';

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
  return toPem('CERTIFICATE', sequence(tbs, algId, bitString(nodeSign('sha256', tbs, o.issuerKey)))).trim();
}
// A fresh key pair and a self-signed certificate for it, made for each run.
const KEY_PAIR = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY = KEY_PAIR.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const CERT = makeCert({ subject: 'example.org', publicKey: KEY_PAIR.publicKey, issuerKey: KEY_PAIR.privateKey });
const SP = 'https://sp.example/metadata';
const ACS = 'https://sp.example/saml/acs';
const IDP = 'https://idp.example/entity';
const SSO = 'https://idp.example/sso';
const T = Date.UTC(2026, 11, 15, 12, 0, 0);
const iso = (ms: number) => formatTime(ms);
let clock = T;
let ctr = 0;
const random = (n: number) => Uint8Array.from({ length: n }, (_, i) => (ctr * 13 + i * 5 + 1) & 0xff);

const cfg = (o: Partial<SpConfig> = {}): SpConfig => ({ entityId: SP, acsUrl: ACS, idp: { entityId: IDP, ssoUrl: SSO, certificates: [CERT] }, now: () => clock, random: (n) => (ctr++, random(n)), ...o });
const mk = (o: Partial<SpConfig> = {}) => new Sp(cfg(o));
const fail = (f: () => unknown, code: string, re?: RegExp) => assert.throws(f, (e: unknown) => e instanceof SamlError && e.code === code && (!re || re.test(e.message)), `${code} ${re ?? ''}`);
const b64 = (s: string) => Buffer.from(s).toString('base64');

interface A {
  id?: string; issuer?: string; nameId?: string; recipient?: string; irt?: string | undefined; subjNoa?: number; condNb?: number | undefined; condNoa?: number; audience?: string | null; authnInstant?: number;
  attrs?: Record<string, string[]>; extraCond?: string; sessionIndex?: string; sessionNoa?: number; version?: string; confNb?: number; method?: string;
}
function assertion(a: A = {}): string {
  const irt = 'irt' in a ? a.irt : undefined;
  const attrs = Object.entries(a.attrs ?? {}).map(([n, vs]) => `<saml:Attribute Name="${n}">${vs.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('');
  return (
    `<saml:Assertion xmlns:saml="${NS.saml}" ID="${a.id ?? '_as1'}" Version="${a.version ?? '2.0'}" IssueInstant="${iso(T - 5000)}"><saml:Issuer>${a.issuer ?? IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${NAMEID.email}">${a.nameId ?? 'alice@example.com'}</saml:NameID><saml:SubjectConfirmation Method="${a.method ?? 'urn:oasis:names:tc:SAML:2.0:cm:bearer'}"><saml:SubjectConfirmationData Recipient="${a.recipient ?? ACS}" NotOnOrAfter="${iso(a.subjNoa ?? T + 300_000)}"${a.confNb ? ` NotBefore="${iso(a.confNb)}"` : ''}${irt ? ` InResponseTo="${irt}"` : ''}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions${a.condNb === undefined ? '' : ` NotBefore="${iso(a.condNb)}"`} NotOnOrAfter="${iso(a.condNoa ?? T + 300_000)}">${a.audience === null ? '' : `<saml:AudienceRestriction><saml:Audience>${a.audience ?? SP}</saml:Audience></saml:AudienceRestriction>`}${a.extraCond ?? ''}</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(a.authnInstant ?? T - 10_000)}" SessionIndex="${a.sessionIndex ?? '_sess1'}"${a.sessionNoa ? ` SessionNotOnOrAfter="${iso(a.sessionNoa)}"` : ''}><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `${attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : ''}</saml:Assertion>`
  );
}
const signIssuer = { ns: NS.saml, local: 'Issuer' };
const signedAssertion = (a: A = {}, key: string | import('node:crypto').KeyObject = KEY) => sign(assertion(a), { privateKey: key, id: a.id ?? '_as1', after: signIssuer });
interface R { status?: string; dest?: string | null; irt?: string; inner: string; issuer?: string }
function response(r: R): string {
  return (
    `<samlp:Response xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="_r1" Version="2.0" IssueInstant="${iso(T - 1000)}"${r.dest === null ? '' : ` Destination="${r.dest ?? ACS}"`}${r.irt ? ` InResponseTo="${r.irt}"` : ''}>` +
    `<saml:Issuer>${r.issuer ?? IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${r.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>${r.inner}</samlp:Response>`
  );
}
const signResp = (xml: string, key: string | import('node:crypto').KeyObject = KEY) => sign(xml, { privateKey: key, id: '_r1', after: signIssuer });

function flow(opts: { a?: A; resp?: Partial<R>; sp?: Partial<SpConfig>; signA?: boolean; signR?: boolean; key?: import('node:crypto').KeyObject } = {}) {
  const sp = mk(opts.sp);
  const req = sp.authnRequest({ relayState: 'rs1' });
  const a = { irt: req.id, ...opts.a };
  const inner = opts.signA === false ? assertion(a) : signedAssertion(a, opts.key ?? KEY);
  let xml = response({ irt: req.id, inner, ...opts.resp });
  if (opts.signR) xml = signResp(xml, opts.key ?? KEY);
  return { sp, req, xml, wire: b64(xml) };
}

test('happy path: signed assertion, facts come back, relay state is restored', () => {
  clock = T;
  const f = flow({ a: { attrs: { mail: ['alice@example.com'], groups: ['a', 'b'] } } });
  const r = f.sp.consume(f.wire);
  assert.equal(r.nameId, 'alice@example.com');
  assert.equal(r.nameIdFormat, NAMEID.email);
  assert.equal(r.sessionIndex, '_sess1');
  assert.deepEqual(r.attributes.groups, ['a', 'b']);
  assert.deepEqual(r.attributes.mail, ['alice@example.com']);
  assert.equal(r.authnContext, 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport');
  assert.equal(r.relayState, 'rs1');
  assert.equal(r.inResponseTo, f.req.id);
  assert.deepEqual(r.signed, ['assertion']);
  assert.equal(r.authnInstant, T - 10_000);
});

test('a signed Response alone is enough; both signed is reported as such', () => {
  clock = T;
  const a = flow({ signA: false, signR: true });
  assert.deepEqual(a.sp.consume(a.wire).signed, ['response']);
  const b = flow({ signA: true, signR: true });
  assert.deepEqual(b.sp.consume(b.wire).signed, ['response', 'assertion']);
});

test('an unsigned message, or one signed by another key, is refused', () => {
  clock = T;
  const un = flow({ signA: false });
  fail(() => un.sp.consume(un.wire), 'signature', /neither/);
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const forged = flow({ key: other.privateKey });
  fail(() => forged.sp.consume(forged.wire), 'signature', /not valid for any trusted key/);
});

test('content changed after signing is refused', () => {
  clock = T;
  const f = flow();
  const tampered = Buffer.from(f.wire, 'base64').toString().replace('alice@example.com', 'root@example.com');
  fail(() => f.sp.consume(b64(tampered)), 'signature', /digest does not match/);
});

test('signature wrapping: an extra unsigned assertion, or a moved one, is refused', () => {
  clock = T;
  const f = flow();
  const xml = Buffer.from(f.wire, 'base64').toString();
  const evil = assertion({ id: '_evil', nameId: 'admin@example.com', irt: f.req.id });
  fail(() => f.sp.consume(b64(xml.replace('</samlp:Response>', `${evil}</samlp:Response>`))), 'assertion', /exactly one/);
  fail(() => f.sp.consume(b64(xml.replace('<samlp:Status>', `<samlp:Extensions>${/<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml)![0]}</samlp:Extensions><samlp:Status>`).replace(/(<\/samlp:Status>)<saml:Assertion[\s\S]*<\/saml:Assertion>/, `$1${evil}`))), 'signature', /./);
  // a signature lifted from the real assertion onto a forged one
  const sig = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(xml)![0];
  const forged = assertion({ id: '_evil', nameId: 'admin@example.com', irt: f.req.id }).replace('</saml:Issuer>', `</saml:Issuer>${sig}`);
  fail(() => f.sp.consume(b64(response({ irt: f.req.id, inner: forged }))), 'signature', /does not point at the element|not in the document/);
});

test('a comment inside a signed NameID cannot change who the user is', () => {
  clock = T;
  const f = flow({ a: { nameId: 'alice@example.com<!-- x -->.evil' } });
  assert.equal(f.sp.consume(f.wire).nameId, 'alice@example.com.evil', 'the whole text, as signed, not a prefix');
});

test('time rules: expiry, not-yet-valid, and the stated skew', () => {
  clock = T;
  const old = flow({ a: { condNoa: T - 200_000, subjNoa: T + 300_000 } });
  fail(() => old.sp.consume(old.wire), 'time', /expired/);
  const early = flow({ a: { condNb: T + 200_000 } });
  fail(() => early.sp.consume(early.wire), 'time', /not valid yet/);
  const within = flow({ a: { condNoa: T - 60_000 } });
  assert.equal(within.sp.consume(within.wire).nameId, 'alice@example.com', 'inside the 120 s skew');
  const strict = flow({ a: { condNoa: T - 60_000 }, sp: { skewSeconds: 0 } });
  fail(() => strict.sp.consume(strict.wire), 'time', /expired/);
  const subj = flow({ a: { subjNoa: T - 200_000 } });
  fail(() => subj.sp.consume(subj.wire), 'confirmation', /expired/);
  const future = flow({ a: { authnInstant: T + 600_000 } });
  fail(() => future.sp.consume(future.wire), 'time', /future/);
  const ended = flow({ a: { sessionNoa: T - 300_000 } });
  fail(() => ended.sp.consume(ended.wire), 'time', /session has already ended/);
});

test('audience, conditions, recipient, destination, issuer, version', () => {
  clock = T;
  const wrongAud = flow({ a: { audience: 'https://other.example/' } });
  fail(() => wrongAud.sp.consume(wrongAud.wire), 'audience');
  const noAud = flow({ a: { audience: null } });
  fail(() => noAud.sp.consume(noAud.wire), 'audience', /no AudienceRestriction/);
  const unk = flow({ a: { extraCond: '<saml:ProxyRestriction Count="0"/>' } });
  fail(() => unk.sp.consume(unk.wire), 'conditions', /unknown condition/);
  const recip = flow({ a: { recipient: 'https://evil.example/acs' } });
  fail(() => recip.sp.consume(recip.wire), 'confirmation', /Recipient/);
  const dest = flow({ signA: false, signR: true, resp: { dest: 'https://evil.example/acs' } });
  fail(() => dest.sp.consume(dest.wire), 'destination');
  const iss = flow({ a: { issuer: 'https://evil.example/' } });
  fail(() => iss.sp.consume(iss.wire), 'issuer');
  const ver = flow({ a: { version: '1.1' } });
  fail(() => ver.sp.consume(ver.wire), 'assertion', /SAML 2.0/);
  const meth = flow({ a: { method: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key' } });
  fail(() => meth.sp.consume(meth.wire), 'confirmation', /no bearer/);
  const nb = flow({ a: { confNb: T - 1000 } });
  fail(() => nb.sp.consume(nb.wire), 'confirmation', /NotBefore/);
});

test('InResponseTo: unknown, reused, expired, and IdP-initiated only when allowed', () => {
  clock = T;
  const f = flow();
  assert.ok(f.sp.consume(f.wire));
  fail(() => f.sp.consume(f.wire), 'in-response-to', /unknown, expired or already used/);
  const other = mk();
  fail(() => other.consume(f.wire), 'in-response-to');
  const late = flow({ a: { subjNoa: T + 2_000_000, condNoa: T + 2_000_000 } });
  clock = T + 700_000;
  fail(() => late.sp.consume(late.wire), 'in-response-to', /expired|unknown/);
  clock = T;
  const unsolicited = new Sp(cfg());
  const wire = b64(response({ inner: signedAssertion({ id: '_u1' }) }));
  fail(() => unsolicited.consume(wire), 'in-response-to', /IdP-initiated login is off/);
  const open = new Sp(cfg({ allowIdpInitiated: true }));
  assert.equal(open.consume(wire).inResponseTo, undefined);
});

test('replay: the same assertion is refused, and a failed check does not use up its ID', () => {
  clock = T;
  const replay = new MemoryReplayCache();
  const sp = new Sp(cfg({ allowIdpInitiated: true, replay }));
  const wire = b64(response({ inner: signedAssertion({ id: '_once' }) }));
  assert.ok(sp.consume(wire));
  fail(() => sp.consume(wire), 'replay');
  clock = T + 1_000_000;
  const old = b64(response({ inner: signedAssertion({ id: '_x', condNoa: T + 100_000, subjNoa: T + 100_000 }) }));
  fail(() => sp.consume(old), 'confirmation');
  assert.equal(replay.size, 1, 'the expired assertion was not remembered');
  clock = T;
});

test('status failure, encrypted assertions, DOCTYPE, junk and oversize input', () => {
  clock = T;
  const st = flow({ resp: { status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }, signA: true });
  fail(() => st.sp.consume(st.wire), 'status', /Responder/);
  const enc = flow();
  const xml = Buffer.from(enc.wire, 'base64').toString().replace('</samlp:Response>', '<saml:EncryptedAssertion/></samlp:Response>');
  fail(() => enc.sp.consume(b64(xml)), 'unsupported', /encrypted/);
  fail(() => mk().consume(b64('<!DOCTYPE x [<!ENTITY a "b">]><samlp:Response xmlns:samlp="x"/>')), 'xml', /document type/);
  fail(() => mk().consume('not base64!!'), 'format');
  fail(() => mk().consume(''), 'format');
  fail(() => mk({ maxResponseBytes: 100 }).consume(b64('<a>' + 'x'.repeat(200) + '</a>')), 'format', /too large/);
  fail(() => mk().consume(b64('<a/>')), 'format', /not a samlp:Response/);
  fail(() => mk().consume(b64(`<samlp:Response xmlns:samlp="${NS.samlp}"/>`)), 'assertion', /exactly one/);
});

test('authentication age and ForceAuthn', () => {
  clock = T;
  const old = flow({ a: { authnInstant: T - 3_600_000 }, sp: { maxAuthAgeSeconds: 600 } });
  fail(() => old.sp.consume(old.wire), 'time', /too long ago/);
  const fresh = flow({ a: { authnInstant: T - 100_000 }, sp: { maxAuthAgeSeconds: 600 } });
  assert.ok(fresh.sp.consume(fresh.wire));
  const sp = mk();
  const req = sp.authnRequest({ forceAuthn: true });
  assert.match(req.xml, /ForceAuthn="true"/);
  clock = T + 30_000;
  const stale = b64(response({ irt: req.id, inner: signedAssertion({ irt: req.id, authnInstant: T - 600_000, condNoa: T + 300_000 }) }));
  fail(() => sp.consume(stale), 'time', /ForceAuthn/);
  clock = T;
});

test('redirect-binding request: deflated, signed over the exact query, verifiable, tamper-evident', () => {
  clock = T;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sp = mk({ signingKey: rsa.privateKey });
  const r = sp.authnRequest({ relayState: 'a b&c' });
  const u = new URL(r.redirectUrl!);
  assert.equal(u.origin + u.pathname, SSO);
  const query = r.redirectUrl!.slice(r.redirectUrl!.indexOf('?') + 1);
  assert.match(query, /^SAMLRequest=[^&]+&RelayState=a%20b%26c&SigAlg=[^&]+&Signature=[^&]+$/);
  assert.equal(inflateRedirect(decodeURIComponent(/SAMLRequest=([^&]+)/.exec(query)![1]!)), r.xml);
  assert.equal(verifyRedirectSignature(query, { key: rsa.publicKey }), true);
  assert.equal(verifyRedirectSignature(query.replace('a%20b', 'a%20c'), { key: rsa.publicKey }), false);
  assert.equal(verifyRedirectSignature(query, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey }), false);
  assert.equal(verifyRedirectSignature(query.replace(/SigAlg=[^&]+/, 'SigAlg=http%3A%2F%2Fevil'), { key: rsa.publicKey }), false);
  assert.match(r.xml, /AssertionConsumerServiceURL="https:\/\/sp.example\/saml\/acs"/);
  const unsigned = mk().authnRequest();
  assert.ok(!/Signature=/.test(unsigned.redirectUrl!));
});

test('post-binding request carries an enveloped signature after Issuer', () => {
  clock = T;
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const sp = mk({ signingKey: ec.privateKey });
  const r = sp.authnRequest({ binding: 'post', relayState: 'x' });
  assert.equal(r.post!.action, SSO);
  assert.equal(r.post!.fields.RelayState, 'x');
  const xml = Buffer.from(r.post!.fields.SAMLRequest!, 'base64').toString();
  assert.match(xml, /<\/saml:Issuer><ds:Signature/);
  assert.doesNotThrow(() => verifyDocument(xml, { keys: [ec.publicKey], after: signIssuer }));
});

test('inflate refuses a bomb and bad data', () => {
  const bomb = deflateRawSync(Buffer.alloc(50_000_000, 0x61)).toString('base64');
  assert.throws(() => inflateRedirect(bomb), SamlError);
  assert.throws(() => inflateRedirect('AAAA'), SamlError);
  assert.equal(inflateRawSync(deflateRawSync(Buffer.from('x'))).toString(), 'x');
});

test('SP metadata has the entity, the ACS, the certificate, and reads back as XML', () => {
  const m = spMetadata({ entityId: SP, acsUrl: ACS, signingCertificate: CERT, authnRequestsSigned: true, nameIdFormats: [NAMEID.email], validUntilMs: T + 86_400_000, organization: { name: 'Ex & Co', url: 'https://ex.example' } });
  const d = readXml(m);
  assert.equal(d.root.local, 'EntityDescriptor');
  assert.match(m, /entityID="https:\/\/sp.example\/metadata"/);
  assert.match(m, /AuthnRequestsSigned="true" WantAssertionsSigned="true"/);
  assert.match(m, new RegExp(`Binding="${BINDING.post}" Location="${ACS}"`));
  assert.match(m, /Ex &amp; Co/);
  assert.match(m, /validUntil="2026-12-16T12:00:00Z"/);
  assert.equal(mk().metadata().includes('<md:EntityDescriptor'), true);
});

test('IdP metadata: must be signed by a pinned certificate, honours validUntil, refuses federations', () => {
  const idpMd = (extra = '') => `<md:EntityDescriptor xmlns:md="${NS.md}" xmlns:ds="${NS_DSIG}" ID="_md1" entityID="${IDP}"${extra}><md:IDPSSODescriptor protocolSupportEnumeration="${NS.samlp}"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${CERT.replace(/-----[A-Z ]+-----|\s/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="${BINDING.redirect}" Location="${SSO}"/><md:SingleSignOnService Binding="${BINDING.post}" Location="http://insecure.example/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  const now = () => T;
  const signed = sign(idpMd(), { privateKey: KEY });
  const m = parseIdpMetadata(signed, { pinned: [CERT], now });
  assert.equal(m.entityId, IDP);
  assert.equal(m.signed, true);
  assert.deepEqual(m.sso, [{ binding: BINDING.redirect, location: SSO }], 'the http endpoint is dropped');
  assert.equal(createPublicKey(m.certificates[0]!).asymmetricKeyType, 'ec');
  assert.throws(() => parseIdpMetadata(idpMd(), { now }), (e: unknown) => e instanceof SamlError && /must be verified/.test(e.message));
  assert.equal(parseIdpMetadata(idpMd(), { now, allowUnsigned: true }).signed, false);
  const forged = signed.replace(IDP, 'https://evil.example/entity');
  assert.throws(() => parseIdpMetadata(forged, { pinned: [CERT], now }), (e: unknown) => e instanceof SamlError && e.code === 'signature');
  const expired = idpMd(` validUntil="${iso(T - 1000)}"`);
  assert.throws(() => parseIdpMetadata(expired, { now, allowUnsigned: true }), (e: unknown) => e instanceof SamlError && e.code === 'time');
  assert.throws(() => parseIdpMetadata(`<md:EntitiesDescriptor xmlns:md="${NS.md}"/>`, { now, allowUnsigned: true }), (e: unknown) => e instanceof SamlError && e.code === 'unsupported');
  // metadata feeds the SP
  const sp = new Sp(cfg({ idp: { entityId: m.entityId, ssoUrl: m.sso[0]!.location, certificates: m.certificates } }));
  assert.ok(sp.authnRequest().redirectUrl);
});

test('times are strict UTC', () => {
  assert.equal(parseTime('2026-12-15T12:00:00Z', 't'), T);
  assert.equal(parseTime('2026-12-15T12:00:00.250Z', 't'), T + 250);
  for (const bad of ['2025-06-01T12:00:00+02:00', '2025-06-01T12:00:00', '2025-02-30T12:00:00Z', '2025-06-01 12:00:00Z', 'yesterday', '2025-06-01T25:00:00Z']) assert.throws(() => parseTime(bad, 't'), SamlError, bad);
  assert.throws(() => parseTime(undefined, 'x'), /x is missing/);
  assert.equal(formatTime(T), '2026-12-15T12:00:00Z');
});

test('stores: requests are single-use and expire; the replay cache refuses to forget live entries', () => {
  const s = new MemoryRequestStore(2);
  s.put({ id: 'a', issuedAt: 0, expiresAt: 100, forceAuthn: false });
  assert.equal(s.take('a', 50)?.id, 'a');
  assert.equal(s.take('a', 50), undefined);
  s.put({ id: 'b', issuedAt: 0, expiresAt: 100, forceAuthn: false });
  assert.equal(s.take('b', 100), undefined, 'expired at the deadline');
  s.put({ id: 'c', issuedAt: 0, expiresAt: 10, forceAuthn: false });
  s.put({ id: 'd', issuedAt: 0, expiresAt: 1000, forceAuthn: false });
  s.put({ id: 'e', issuedAt: 20, expiresAt: 1000, forceAuthn: false });
  assert.ok(s.size <= 2);
  const c = new MemoryReplayCache(2);
  assert.equal(c.seen('1', 100, 0), false);
  assert.equal(c.seen('1', 100, 50), true);
  assert.equal(c.seen('1', 1000, 100), false, 'forgotten after its deadline');
  assert.equal(c.seen('2', 1000, 100), false);
  assert.throws(() => c.seen('3', 100, 100), SamlError);
});

test('configuration is checked: https URLs, pinned certificates', () => {
  assert.throws(() => mk({ acsUrl: 'http://sp.example/acs' }), SamlError);
  assert.throws(() => mk({ idp: { entityId: IDP, ssoUrl: SSO, certificates: [] } }), SamlError);
  assert.throws(() => mk({ idp: { entityId: IDP, ssoUrl: 'ftp://x', certificates: [CERT] } }), SamlError);
  void childNamed;
});
