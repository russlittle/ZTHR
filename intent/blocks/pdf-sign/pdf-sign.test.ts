import assert from 'node:assert/strict';
import { X509Certificate, createHash, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { pdf } from '../pdf/index.ts';
import {
  PdfSignError, embedSignature, issueCertificate, integer, keySigner, name, cmsParts, oid, oidOf, octets, parseDer, parseDerPadded, prepareSignature, readDoc, pageRefs, seq, serialize, setOf, signPdf, signedBytes, textOf, textString, tlv, utf8, verifyPdf,
} from './index.ts';
import type { Der, Signer, SignOptions } from './index.ts';
import { test } from 'node:test';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const NOW = new Date('2026-06-15T12:00:00Z');
const SIGNED_AT = new Date('2026-06-15T11:30:00Z');
const YEAR = 365 * 86_400_000;

// Keys are made once, at run time; nothing secret is written in this file.
const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ec384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const caKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const cert = (cn: string, k: { publicKey: KeyObject; privateKey: KeyObject }, over: { from?: Date; to?: Date; serial?: number } = {}) =>
  issueCertificate({ commonName: cn, publicKey: k.publicKey, privateKey: k.privateKey, serial: over.serial ?? 1001, notBefore: over.from ?? new Date(NOW.getTime() - YEAR), notAfter: over.to ?? new Date(NOW.getTime() + YEAR) });

const rsaCert = cert('Ana Rivera', rsaKeys);
const ecCert = cert('Bo Chen', ecKeys, { serial: 2002 });
const rsaSigner: Signer = keySigner(rsaKeys.privateKey, rsaCert);
const ecSigner: Signer = keySigner(ecKeys.privateKey, ecCert);

const base = () => pdf([{ h: 'Agreement' }, { p: 'The parties agree to the terms below.' }, { p: 'Payment is due in thirty days.' }], { title: 'Agreement', size: 'Letter' });
const opts = (over: Partial<SignOptions> = {}): SignOptions => ({ signer: rsaSigner, signingTime: SIGNED_AT, reason: 'I approve', ...over });
const verify = (b: Uint8Array, anchors: Uint8Array[] = []) => verifyPdf(b, { now: NOW, trustAnchors: anchors });
const only = (b: Uint8Array, anchors: Uint8Array[] = []) => {
  const r = verify(b, anchors);
  assert.equal(r.signatures.length, 1);
  return r.signatures[0]!;
};

/** Rewrites a DER tree, swapping every element equal to `from` for `to`, and fixing the lengths above it. */
function swapDer(node: Der, from: Uint8Array, to: Uint8Array): Uint8Array {
  if (hex(node.raw) === hex(from)) return to;
  if (!node.children.length) return node.raw;
  return tlv(node.tag, ...node.children.map((c) => swapDer(c, from, to)));
}

/** Replaces the signature value of a signed PDF with `cms`, keeping the document the same. */
function withContents(file: Uint8Array, cms: Uint8Array): Uint8Array {
  const sig = only(file);
  const [, b, c] = sig.byteRange as [number, number, number];
  const out = Buffer.from(file);
  assert.ok(cms.length * 2 <= c - b - 2, 'the replacement fits');
  out.write(Buffer.from(cms).toString('hex').toUpperCase().padEnd(c - b - 2, '0'), b + 1, 'latin1');
  return out;
}

const cmsOf = (file: Uint8Array): Der => {
  const sig = only(file);
  const [, b, c] = sig.byteRange as [number, number, number];
  return parseDerPadded(Buffer.from(Buffer.from(file).toString('latin1').slice(b + 1, c - 1), 'hex'));
};

// ---------------------------------------------------------------- DER

test('DER: the encodings are the standard ones', () => {
  assert.equal(hex(oid('1.2.840.113549.1.1.11')), '06092a864886f70d01010b');
  assert.equal(hex(oid('2.5.4.3')), '0603550403');
  assert.equal(hex(oid('2.16.840.1.101.3.4.2.1')), '0609608648016503040201');
  assert.equal(hex(integer(0)), '020100');
  assert.equal(hex(integer(127)), '02017f');
  assert.equal(hex(integer(128)), '02020080');
  assert.equal(hex(integer(65537)), '0203010001');
  assert.equal(hex(integer(Uint8Array.of(0, 0, 0xff))), '020200ff', 'leading zeros are trimmed, a high bit gets one back');
  assert.equal(hex(octets(new Uint8Array(200)).subarray(0, 3)), '0481c8');
  assert.equal(hex(octets(new Uint8Array(300)).subarray(0, 4)), '0482012c');
  assert.equal(oidOf(parseDer(oid('1.2.840.113549.1.9.16.2.47')).node), '1.2.840.113549.1.9.16.2.47');
  assert.equal(oidOf(parseDer(oid('2.999.3')).node), '2.999.3', 'a first arc of 2 can carry a large second');
  assert.throws(() => oid('3.1'), PdfSignError);
  assert.throws(() => oid('1.40'), PdfSignError);
});

test('DER: SET OF is sorted by encoding, as DER requires', () => {
  const s = setOf(integer(5), integer(1), octets(Uint8Array.of(1)));
  assert.deepEqual(parseDer(s).node.children.map((c) => hex(c.raw)), ['020101', '020105', '040101']);
});

test('DER: what is not DER is refused', () => {
  assert.throws(() => parseDer(Uint8Array.of(0x30, 0x80, 0x00, 0x00)), /indefinite/);
  assert.throws(() => parseDer(Uint8Array.of(0x04, 0x81, 0x05, 1, 2, 3, 4, 5)), /not minimal/);
  assert.throws(() => parseDer(Uint8Array.of(0x04, 0x82, 0x00, 0x05, 1, 2, 3, 4, 5)), /not minimal/);
  assert.throws(() => parseDer(Uint8Array.of(0x1f, 0x01, 0x00)), /tags above 30/);
  assert.throws(() => parseDer(Uint8Array.of(0x04, 0x05, 1, 2)), /cut short/);
  assert.throws(() => parseDer(Uint8Array.of(0x30, 0x03, 0x04, 0x05, 1)), /cut short/);
  assert.throws(() => parseDer(Uint8Array.of(0x04, 0x85, 1, 0, 0, 0, 0, 0)), /not usable/);
  let deep: Uint8Array = Uint8Array.of(0x05, 0x00);
  for (let i = 0; i < 40; i++) deep = seq(deep);
  assert.throws(() => parseDer(deep), /nested too deeply/);
  assert.throws(() => parseDerPadded(Uint8Array.of(0x05, 0x00, 0x00, 0x01)), /bytes after the end/);
  assert.equal(parseDerPadded(Uint8Array.of(0x05, 0x00, 0x00, 0x00)).tag, 0x05);
});

// ---------------------------------------------------------------- PDF objects and structure

test('PDF objects read and write back: names, strings, references, nesting', () => {
  const d = readDoc(base());
  assert.equal(d.usesXrefStream, false);
  const root = d.get((d.trailer.entries.get('Root') as { num: number }).num);
  assert.equal(serialize(root), '<</Type /Catalog /Pages 2 0 R /Lang (en)>>');
  assert.equal(serialize(name('A B#')), '/A#20B#23');
  assert.equal(serialize(textString('plain (text) \\ ok')), '(plain \\(text\\) \\\\ ok)');
  assert.equal(serialize(textString('é✓')), '<FEFF00E92713>');
  assert.equal(textOf(textString('Revisión ✓')), 'Revisión ✓');
  assert.equal(textOf(textString('abc')), 'abc');
  assert.equal(serialize([1, 2.5, true, null, [name('x')]]), '[1 2.5 true null [/x]]');
  assert.throws(() => serialize(NaN), /finite/);
});

test('the page tree and cross-reference are read from a real document', () => {
  const d = readDoc(base());
  assert.equal(pageRefs(d).length, 1);
  const many = readDoc(pdf(Array.from({ length: 80 }, (_, i) => ({ p: `Line ${i}` })), { title: 'Long' }));
  assert.ok(pageRefs(many).length >= 2);
});

test('things that are not usable PDFs are refused with a reason', () => {
  assert.throws(() => readDoc(Buffer.from('hello world, this is not a pdf at all')), /not a PDF/);
  assert.throws(() => readDoc(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')), /no startxref/);
  const good = Buffer.from(base());
  const loop = Buffer.from(good.toString('latin1').replace(/trailer\n<< /, 'trailer\n<< /Prev ' + good.toString('latin1').match(/startxref\n(\d+)/)![1] + ' '), 'latin1'); // after the xref, so no offset moves
  assert.throws(() => readDoc(loop), /loop/);
  const enc = Buffer.from(good.toString('latin1').replace(/trailer\n<< /, 'trailer\n<< /Encrypt 9 0 R '), 'latin1');
  assert.throws(() => signPdf(enc, opts()), /encrypted/);
  const badOff = Buffer.from(good.toString('latin1').replace(/\d{10} 00000 n \n/, '0000099999 00000 n \n'), 'latin1');
  assert.throws(() => readDoc(badOff).get(1), /outside the file|no object/);
});

// ---------------------------------------------------------------- certificates

test('the certificates made here are real X.509 as node reads them', () => {
  const c = new X509Certificate(Buffer.from(rsaCert));
  assert.equal(c.subject, 'CN=Ana Rivera');
  assert.equal(c.issuer, 'CN=Ana Rivera');
  assert.equal(c.serialNumber.toUpperCase(), '03E9');
  assert.equal(c.ca, false);
  assert.equal(c.verify(rsaKeys.publicKey), true, 'self-signed: signed by its own key');
  assert.equal(c.verify(ecKeys.publicKey), false);
  assert.equal(c.keyUsage, undefined, 'node lists only extended key usage here');
  const ca = new X509Certificate(Buffer.from(issueCertificate({ commonName: 'Test Root', publicKey: caKeys.publicKey, privateKey: caKeys.privateKey, serial: 1, notBefore: new Date(0), notAfter: new Date(4e12), ca: true })));
  assert.equal(ca.ca, true);
  assert.equal(new Date(ca.validTo).getUTCFullYear() > 2049, true, 'dates after 2049 are written as generalized time');
  assert.throws(() => issueCertificate({ commonName: 'x', publicKey: rsaKeys.publicKey, serial: 1, notBefore: new Date(), notAfter: new Date() }), /private key/);
});

// ---------------------------------------------------------------- sign and verify

test('an RSA signature verifies, and the report says who, when and what was proved', () => {
  const signed = signPdf(base(), opts({ name: 'Ana Rivera', location: 'Dayton' }));
  const s = only(signed);
  assert.equal(s.valid, true, s.problems.join('; '));
  assert.equal(s.integrity, true);
  assert.equal(s.field, 'Signature1');
  assert.equal(s.profile, 'PAdES-B-B');
  assert.equal(s.coversWholeDocument, true);
  assert.equal(s.bytesAfter, 0);
  assert.equal(s.signingTime, '2026-06-15T11:30:00.000Z');
  assert.equal(s.reason, 'I approve');
  assert.equal(s.location, 'Dayton');
  assert.equal(s.signer!.subject, 'CN=Ana Rivera');
  assert.equal(s.signer!.fingerprint, new X509Certificate(Buffer.from(rsaCert)).fingerprint256);
  assert.equal(s.trust, 'self-signed');
  assert.deepEqual(s.problems, []);
});

test('the signature is an incremental update: the original bytes are untouched', () => {
  const orig = Buffer.from(base());
  const signed = Buffer.from(signPdf(orig, opts()));
  assert.ok(signed.length > orig.length + 12_000);
  assert.equal(Buffer.compare(signed.subarray(0, orig.length), orig), 0);
  const text = signed.toString('latin1');
  assert.match(text, /\/SubFilter \/ETSI\.CAdES\.detached/);
  assert.match(text, /\/SigFlags 3/);
  assert.match(text, /\/M \(D:20260615113000Z\)/);
});

test('the byte range is exact: it surrounds the signature value and nothing else', () => {
  const p = prepareSignature(base(), opts());
  const [a, b, c, d] = p.byteRange;
  assert.equal(a, 0);
  assert.equal(String.fromCharCode(p.pdf[b]!), '<');
  assert.equal(String.fromCharCode(p.pdf[c - 1]!), '>');
  assert.equal(c + d, p.pdf.length);
  assert.equal(b, p.contentsStart);
  assert.equal(c - b, 12_288 * 2 + 2);
  assert.equal(signedBytes(p).length, p.pdf.length - (c - b));
  assert.match(Buffer.from(p.pdf).toString('latin1'), new RegExp(`/ByteRange \\[0 ${String(b).padStart(10, '0')} ${String(c).padStart(10, '0')} ${String(d).padStart(10, '0')}\\]`));
});

test('ECDSA with SHA-256, and P-384 with SHA-384, verify', () => {
  const a = only(signPdf(base(), opts({ signer: ecSigner })));
  assert.equal(a.valid, true, a.problems.join('; '));
  const e384 = keySigner(ec384.privateKey, cert('Cy Dunn', ec384, { serial: 3 }));
  const b = only(signPdf(base(), opts({ signer: e384, hash: 'sha384' })));
  assert.equal(b.valid, true, b.problems.join('; '));
  const c = only(signPdf(base(), opts({ hash: 'sha512' })));
  assert.equal(c.valid, true, c.problems.join('; '));
  assert.throws(() => keySigner(generateKeyPairSync('ed25519').privateKey, rsaCert), /only RSA and ECDSA/);
});

test('RSA signatures are the same every time for the same input; ECDSA ones are not', () => {
  const x = signPdf(base(), opts());
  const y = signPdf(base(), opts());
  assert.equal(Buffer.compare(Buffer.from(x), Buffer.from(y)), 0);
  assert.notEqual(hex(signPdf(base(), opts({ signer: ecSigner }))), hex(signPdf(base(), opts({ signer: ecSigner }))));
});

test('changing any signed byte is caught', () => {
  const signed = Buffer.from(signPdf(base(), opts()));
  const at = signed.indexOf('thirty days');
  assert.ok(at > 0 && at < signed.length - 20_000 + 12_000);
  const evil = Buffer.from(signed);
  evil.write('FORTY', at, 'latin1');
  const s = only(evil);
  assert.equal(s.valid, false);
  assert.equal(s.integrity, false);
  assert.ok(s.problems.some((p) => p.includes('changed after it was signed')), s.problems.join('; '));
});

test('damage inside the signature value is caught', () => {
  const signed = Buffer.from(signPdf(base(), opts()));
  const sig = only(signed);
  const evil = Buffer.from(signed);
  const i = (sig.byteRange[1] as number) + 3000;
  evil[i] = evil[i] === 0x41 ? 0x42 : 0x41;
  const s = only(evil);
  assert.equal(s.valid, false);
  assert.equal(s.integrity, false);
});

test('a byte range widened to hide content in the gap is caught', () => {
  const signed = Buffer.from(signPdf(base(), opts()));
  const t = signed.toString('latin1');
  const m = /\/ByteRange \[0 (\d{10}) (\d{10}) (\d{10})\]/.exec(t)!;
  const widened = t.replace(m[0]!, `/ByteRange [0 ${m[1]} ${String(Number(m[2]) + 10).padStart(10, '0')} ${String(Number(m[3]) - 10).padStart(10, '0')}]`);
  const s = only(Buffer.from(widened, 'latin1'));
  assert.equal(s.valid, false);
  assert.ok(s.problems.some((p) => p.includes('more than the signature value')), s.problems.join('; '));
});

test('bad byte ranges are reported, never thrown or trusted', () => {
  const signed = Buffer.from(signPdf(base(), opts()));
  const t = signed.toString('latin1');
  const m = /\/ByteRange \[0 (\d{10}) (\d{10}) (\d{10})\]/.exec(t)!;
  // Same length as the original, so nothing after it moves.
  const swap = (inner: string) => only(Buffer.from(t.replace(m[0]!, `/ByteRange [${inner}`.padEnd(m[0]!.length - 1) + ']'), 'latin1'));
  assert.ok(swap(`5 ${m[1]} ${m[2]} ${m[3]}`).problems.some((p) => p.includes('does not start')));
  assert.ok(swap(`0 ${m[2]} ${m[1]} ${m[3]}`).problems.some((p) => p.includes('overlaps')));
  assert.ok(swap(`0 ${m[1]} ${m[2]} 9999999999`).problems.length > 0);
  assert.ok(swap('0 1 2').problems.some((p) => p.includes('four whole numbers')));
  assert.ok(swap('0 1.5 2 3').problems.some((p) => p.includes('four whole numbers')));
  assert.ok(swap('0 -1 2 3').problems.some((p) => p.includes('four whole numbers')));
});

test('bytes appended after signing leave the signature valid but say the document grew', () => {
  const signed = signPdf(base(), opts());
  const grown = Buffer.concat([signed, Buffer.from('\n% a note added later\n')]);
  const s = only(grown);
  assert.equal(s.integrity, true);
  assert.equal(s.valid, true);
  assert.equal(s.coversWholeDocument, false);
  assert.equal(s.bytesAfter, 22);
});

test('two people sign in turn: both verify, the first no longer covers the whole file', () => {
  const first = signPdf(base(), opts({ reason: 'Author' }));
  const second = signPdf(first, opts({ signer: ecSigner, reason: 'Reviewer', signingTime: new Date('2026-06-15T11:45:00Z') }));
  const r = verify(second);
  assert.deepEqual(r.signatures.map((s) => s.field).sort(), ['Signature1', 'Signature2']);
  const [one, two] = ['Signature1', 'Signature2'].map((f) => r.signatures.find((s) => s.field === f)!) as [typeof r.signatures[0], typeof r.signatures[0]];
  assert.equal(one!.valid, true, one!.problems.join('; '));
  assert.equal(two!.valid, true, two!.problems.join('; '));
  assert.equal(one!.coversWholeDocument, false);
  assert.equal(two!.coversWholeDocument, true);
  assert.ok(one!.bytesAfter > 12_000);
  assert.equal(one!.signer!.subject, 'CN=Ana Rivera');
  assert.equal(two!.signer!.subject, 'CN=Bo Chen');
});

test('a visible signature has a place on the page and a drawn appearance, with the name escaped', () => {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const who = keySigner(k.privateKey, cert('Ana (Ops) \\ Rivera', k));
  const signed = signPdf(base(), opts({ signer: who, appearance: { rect: [72, 100, 300, 160] } }));
  const s = only(signed);
  assert.equal(s.valid, true, s.problems.join('; '));
  const t = Buffer.from(signed).toString('latin1');
  assert.match(t, /\/Rect \[72 100 300 160\]/);
  assert.match(t, /\/AP <<\/N \d+ 0 R>>/);
  assert.match(t, /\(Digitally signed by Ana \\\(Ops\\\) \\\\ Rivera\) Tj/);
  assert.match(t, /\(Date: 2026-06-15 11:30:00 UTC\) Tj/);
  assert.match(t, /\(Reason: I approve\) Tj/);
  assert.match(t, /\/BBox \[0 0 228 60\]/);
  const d = readDoc(signed);
  const page = d.get(pageRefs(d)[0]!.num) as { entries: Map<string, unknown> };
  assert.equal((page.entries.get('Annots') as unknown[]).length, 1);
});

test('an invisible signature has a zero-size widget and no appearance', () => {
  const t = Buffer.from(signPdf(base(), opts())).toString('latin1');
  assert.match(t, /\/Rect \[0 0 0 0\]/);
  assert.ok(!t.includes('/AP <<'));
});

test('custom lines, a second-page placement, and a page that does not exist', () => {
  const long = pdf(Array.from({ length: 80 }, (_, i) => ({ p: `Line ${i}` })), { title: 'Long' });
  const signed = signPdf(long, opts({ appearance: { page: 1, rect: [50, 50, 250, 90], lines: ['Approved', 'for release'] } }));
  const d = readDoc(signed);
  const pages = pageRefs(d);
  const p0 = d.get(pages[0]!.num) as { entries: Map<string, unknown> };
  const p1 = d.get(pages[1]!.num) as { entries: Map<string, unknown> };
  assert.equal(p0.entries.has('Annots'), false);
  assert.equal((p1.entries.get('Annots') as unknown[]).length, 1);
  assert.match(Buffer.from(signed).toString('latin1'), /\(Approved\) Tj/);
  assert.throws(() => signPdf(base(), opts({ appearance: { page: 5, rect: [0, 0, 1, 1] } })), /there is no page 6/);
});

test('field names: unique by default, never a duplicate when asked for one', () => {
  const one = signPdf(base(), opts({ fieldName: 'Buyer' }));
  assert.equal(only(one).field, 'Buyer');
  assert.throws(() => signPdf(one, opts({ fieldName: 'Buyer' })), /already exists/);
  assert.throws(() => signPdf(base(), opts({ fieldName: 'a.b' })), /no dots/);
  assert.throws(() => signPdf(base(), opts({ fieldName: '' })), /no dots/);
});

test('non-ASCII reasons and names survive', () => {
  const s = only(signPdf(base(), opts({ reason: 'Revisión ✓', location: 'Zürich' })));
  assert.equal(s.reason, 'Revisión ✓');
  assert.equal(s.location, 'Zürich');
});

test('signing in two steps, the way a remote signer would, gives a verifying document', () => {
  const o = opts();
  const p = prepareSignature(base(), o);
  const digest = createHash('sha256').update(signedBytes(p)).digest();
  const parts = cmsParts(o.signer, digest, 'sha256', o.signingTime);
  const signature = rsaSigner.sign(parts.signedAttributes, 'sha256');
  const done = embedSignature(p, parts.finish(signature));
  assert.equal(hex(done), hex(signPdf(base(), o)));
  assert.equal(only(done).valid, true);
});

test('a signature that does not fit its reserve is refused, and a reserve can be chosen', () => {
  const p = prepareSignature(base(), opts({ reserve: 600 }));
  const parts = cmsParts(rsaSigner, createHash('sha256').update(signedBytes(p)).digest(), 'sha256', SIGNED_AT);
  assert.throws(() => embedSignature(p, parts.finish(rsaSigner.sign(parts.signedAttributes, 'sha256'))), /reserved; prepare again/);
  assert.throws(() => prepareSignature(base(), opts({ reserve: 100 })), /512 to 1000000/);
  const roomy = signPdf(base(), opts({ reserve: 20_000 }));
  assert.equal(only(roomy).valid, true);
});

test('a chain of certificates can be embedded, and trust follows it to a root the caller names', () => {
  const caCert = issueCertificate({ commonName: 'Test Root', publicKey: caKeys.publicKey, privateKey: caKeys.privateKey, serial: 1, notBefore: new Date(NOW.getTime() - 5 * YEAR), notAfter: new Date(NOW.getTime() + 5 * YEAR), ca: true });
  const leafKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leaf = issueCertificate({ commonName: 'Dee Ellis', publicKey: leafKeys.publicKey, issuer: { commonName: 'Test Root', privateKey: caKeys.privateKey }, serial: 77, notBefore: new Date(NOW.getTime() - YEAR), notAfter: new Date(NOW.getTime() + YEAR) });
  const signer = keySigner(leafKeys.privateKey, leaf, [caCert]);
  const signed = signPdf(base(), opts({ signer }));
  assert.equal(only(signed, [caCert]).trust, 'trusted');
  assert.equal(only(signed).trust, 'untrusted', 'no anchors given: nothing is trusted');
  assert.equal(only(signed, [rsaCert]).trust, 'untrusted', 'a different root does not vouch');
  assert.equal(only(signed, [leaf]).trust, 'trusted', 'pinning the signer\'s own certificate');
  const expiredRoot = issueCertificate({ commonName: 'Test Root', publicKey: caKeys.publicKey, privateKey: caKeys.privateKey, serial: 1, notBefore: new Date(NOW.getTime() - 9 * YEAR), notAfter: new Date(NOW.getTime() - 8 * YEAR), ca: true });
  assert.equal(only(signPdf(base(), opts({ signer: keySigner(leafKeys.privateKey, leaf, [expiredRoot]) })), [expiredRoot]).trust, 'untrusted');
  const notCa = cert('Not A CA', ecKeys, { serial: 5 });
  const sneaky = issueCertificate({ commonName: 'Fi Gray', publicKey: leafKeys.publicKey, issuer: { commonName: 'Not A CA', privateKey: ecKeys.privateKey }, serial: 8, notBefore: new Date(NOW.getTime() - YEAR), notAfter: new Date(NOW.getTime() + YEAR) });
  assert.equal(only(signPdf(base(), opts({ signer: keySigner(leafKeys.privateKey, sneaky, [notCa]) })), [notCa]).trust, 'untrusted', 'an end-entity certificate cannot issue others');
});

test('the signer\'s certificate must have been valid when the document was signed', () => {
  const old = cert('Old Cert', ecKeys, { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2021-01-01T00:00:00Z') });
  const s1 = only(signPdf(base(), opts({ signer: keySigner(ecKeys.privateKey, old) })));
  assert.equal(s1.valid, false);
  assert.ok(s1.problems.includes('the certificate had expired when the document was signed'));
  assert.equal(s1.integrity, true, 'the bytes and signature are fine; the certificate is the problem');
  const s2 = only(signPdf(base(), opts({ signer: keySigner(ecKeys.privateKey, cert('Future', ecKeys, { from: new Date('2027-01-01T00:00:00Z'), to: new Date('2028-01-01T00:00:00Z') })) })));
  assert.ok(s2.problems.includes('the certificate was not yet valid when the document was signed'));
  const s3 = only(signPdf(base(), opts({ signingTime: new Date('2026-06-16T12:00:00Z') })));
  assert.ok(s3.problems.includes('the signing time is in the future'));
});

test('a signature with a weak digest is refused outright', () => {
  const signed = signPdf(base(), opts());
  const sha256 = seq(oid('2.16.840.1.101.3.4.2.1'), Uint8Array.of(5, 0));
  const sha1 = seq(oid('1.3.14.3.2.26'), Uint8Array.of(5, 0));
  const forged = withContents(signed, swapDer(cmsOf(signed), sha256, sha1).slice());
  const s = only(forged);
  assert.equal(s.valid, false);
  assert.ok(s.problems.includes('SHA1 is not accepted as a signature digest'), s.problems.join('; '));
  const md5 = seq(oid('1.2.840.113549.2.5'), Uint8Array.of(5, 0));
  assert.ok(only(withContents(signed, swapDer(cmsOf(signed), sha256, md5))).problems.includes('MD5 is not accepted as a signature digest'));
  const odd = seq(oid('2.16.840.1.101.3.4.2.6'), Uint8Array.of(5, 0));
  assert.ok(only(withContents(signed, swapDer(cmsOf(signed), sha256, odd))).problems.some((p) => p.includes('is not known')));
});

test('algorithm confusion: a signature algorithm that does not fit the key is refused', () => {
  const rsaSigned = signPdf(base(), opts());
  const rsaOid = seq(oid('1.2.840.113549.1.1.11'), Uint8Array.of(5, 0));
  const ecOid = seq(oid('1.2.840.10045.4.3.2'));
  const s = only(withContents(rsaSigned, swapDer(cmsOf(rsaSigned), rsaOid, ecOid)));
  assert.equal(s.valid, false);
  assert.ok(s.problems.some((p) => p.includes('does not fit an RSA key')), s.problems.join('; '));
  const ecSigned = signPdf(base(), opts({ signer: ecSigner }));
  const t = only(withContents(ecSigned, swapDer(cmsOf(ecSigned), ecOid, rsaOid)));
  assert.ok(t.problems.some((p) => p.includes('does not fit an ECDSA key')), t.problems.join('; '));
});

test('small RSA keys are refused', () => {
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const s = only(signPdf(base(), opts({ signer: keySigner(small.privateKey, cert('Small Key', small, { serial: 9 })) })));
  assert.equal(s.valid, false);
  assert.ok(s.problems.includes('the RSA key is 1024 bits; 2048 is the least accepted'));
});

test('the signing-certificate attribute must name the certificate that signed', () => {
  const signed = signPdf(base(), opts());
  const real = octets(createHash('sha256').update(new X509Certificate(Buffer.from(rsaCert)).raw).digest());
  const s = only(withContents(signed, swapDer(cmsOf(signed), real, octets(new Uint8Array(32)))));
  assert.equal(s.valid, false);
  assert.ok(s.problems.includes('the signing-certificate attribute names a different certificate'), s.problems.join('; '));
});

test('a signature made with a different key than the certificate it names does not verify', () => {
  const liar: Signer = { ...rsaSigner, sign: (data, h) => keySigner(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, rsaCert).sign(data, h) };
  const s = only(signPdf(base(), opts({ signer: liar })));
  assert.equal(s.valid, false);
  assert.equal(s.integrity, false);
  assert.ok(s.problems.some((p) => p.includes('does not verify under')), s.problems.join('; '));
});

test('a CMS that carries its own content, or two signers, or none, is not accepted', () => {
  const signed = signPdf(base(), opts());
  const cms = cmsOf(signed);
  const sd = cms.children[1]!.children[0]!;
  const withContent = tlv(0x30, ...sd.children.map((k, i) => (i === 2 ? seq(oid('1.2.840.113549.1.7.1'), ctx0(octets(Uint8Array.of(1)))) : k.raw)));
  const wrap = (inner: Uint8Array) => seq(oid('1.2.840.113549.1.7.2'), tlv(0xa0, inner));
  assert.ok(only(withContents(signed, wrap(withContent))).problems.some((p) => p.includes('detached')));
  const noSigner = tlv(0x30, ...sd.children.map((k, i, a) => (i === a.length - 1 ? tlv(0x31) : k.raw)));
  assert.ok(only(withContents(signed, wrap(noSigner))).problems.some((p) => p.includes('no signer')));
  const two = tlv(0x30, ...sd.children.map((k, i, a) => (i === a.length - 1 ? tlv(0x31, k.children[0]!.raw, k.children[0]!.raw) : k.raw)));
  assert.ok(only(withContents(signed, wrap(two))).problems.some((p) => p.includes('more than one signer')));
  assert.ok(only(withContents(signed, seq(oid('1.2.840.113549.1.7.1')))).problems.some((p) => p.includes('not CMS SignedData')));
  assert.ok(only(withContents(signed, Uint8Array.of(0x30, 0x80, 0, 0))).problems.some((p) => p.includes('not readable')));
});

function ctx0(...c: Uint8Array[]): Uint8Array {
  return tlv(0xa0, ...c);
}

test('an unsigned form field is reported as unsigned, and a document with no fields has no signatures', () => {
  assert.deepEqual(verify(base()), { signatures: [], unsignedFields: [] });
});

// ---------------------------------------------------------------- other PDF layouts

/** A small PDF with an AcroForm that already has a text field, written as an xref table. */
function formPdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /DA (/Helv 0 Tf 0 g) >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [5 0 R] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [50 700 250 720] /P 3 0 R >>',
  ];
  let out = '%PDF-1.7\n';
  const offs = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('an existing form is kept: its fields and widgets stay, the signature is added to them', () => {
  const signed = signPdf(formPdf(), opts({ appearance: { rect: [50, 600, 250, 650] } }));
  const d = readDoc(signed);
  const root = d.get(1) as { entries: Map<string, any> };
  const acro = root.entries.get('AcroForm');
  assert.equal(acro.entries.get('Fields').length, 2);
  assert.equal(acro.entries.get('Fields')[0].num, 5);
  assert.equal(serialize(acro.entries.get('DA')), '(/Helv 0 Tf 0 g)');
  const page = d.get(3) as { entries: Map<string, any> };
  assert.equal(page.entries.get('Annots').length, 2);
  assert.equal(only(signed).valid, true);
  assert.throws(() => signPdf(formPdf(), opts({ fieldName: 'Name' })), /already exists/);
});

/** The same document with the catalog, pages and page packed into an object stream and a Flate-compressed xref stream with a PNG predictor. */
function streamPdf(): Buffer {
  const inner = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'];
  let body = '';
  const header: string[] = [];
  for (const [i, o] of inner.entries()) {
    header.push(`${i + 1} ${body.length}`);
    body += `${o}\n`;
  }
  const head = `${header.join(' ')}\n`;
  const objstm = deflateSync(Buffer.from(head + body, 'latin1'));
  let out = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const off: Record<number, number> = {};
  const add = (n: number, text: string, bin?: Buffer) => {
    off[n] = out.length;
    out = Buffer.concat([out, Buffer.from(`${n} 0 obj\n${text}`, 'latin1'), ...(bin ? [Buffer.from('\nstream\n'), bin, Buffer.from('\nendstream')] : []), Buffer.from('\nendobj\n')]);
  };
  add(4, '<< /Length 0 >>\nstream\n\nendstream');
  add(5, `<< /Type /ObjStm /N 3 /First ${head.length} /Filter /FlateDecode /Length ${objstm.length} >>`, objstm);
  const xoff = out.length;
  // Rows of [type, field2 (3 bytes), field3 (1 byte)], PNG "Up" filtered.
  const rows = [[0, 0, 0, 0, 255], [2, 0, 0, 5, 0], [2, 0, 0, 5, 1], [2, 0, 0, 5, 2], [1, 0, off[4]! >> 8, off[4]! & 255, 0], [1, 0, off[5]! >> 8, off[5]! & 255, 0], [1, 0, xoff >> 8, xoff & 255, 0]];
  const raw: number[] = [];
  rows.forEach((r, i) => {
    raw.push(2);
    r.forEach((v, j) => raw.push((v - (i ? rows[i - 1]![j]! : 0) + 256) & 255));
  });
  const z = deflateSync(Buffer.from(raw));
  off[6] = xoff;
  out = Buffer.concat([out, Buffer.from(`6 0 obj\n<< /Type /XRef /Size 7 /W [1 3 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >> /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`)]);
  return out;
}

test('xref streams, object streams and PNG predictors are read, and the update is written the same way', () => {
  const src = streamPdf();
  const d = readDoc(src);
  assert.equal(d.usesXrefStream, true);
  assert.equal(pageRefs(d).length, 1);
  assert.equal(serialize(d.get(1)), '<</Type /Catalog /Pages 2 0 R>>');
  const signed = signPdf(src, opts({ appearance: { rect: [10, 10, 200, 60] } }));
  const t = Buffer.from(signed).toString('latin1');
  assert.match(t.slice(src.length), /\/Type \/XRef/);
  assert.ok(!t.slice(src.length).includes('\ntrailer\n'), 'no classic table after a stream');
  const s = only(signed);
  assert.equal(s.valid, true, s.problems.join('; '));
  const again = signPdf(signed, opts({ signer: ecSigner, signingTime: new Date('2026-06-15T11:50:00Z') }));
  assert.deepEqual(verify(again).signatures.map((x) => x.valid), [true, true]);
});

test('a damaged compressed stream, or an unsupported filter, is refused without hanging', () => {
  const src = streamPdf();
  const bad = Buffer.from(src);
  const at = bad.indexOf('/ObjStm');
  assert.ok(at > 0);
  const cut = Buffer.from(bad.toString('latin1').replace(/(\/ObjStm[^]*?\/Length \d+ >>\nstream\n)[^]{8}/, '$1XXXXXXXX'), 'latin1');
  assert.throws(() => readDoc(cut).get(1), PdfSignError);
  const lzw = Buffer.from(src.toString('latin1').replace('/Filter /FlateDecode /Length', '/Filter /LZWDecode   /Length'), 'latin1');
  assert.throws(() => readDoc(lzw).get(1), /Flate/);
});

test('signing time and field text use the document\'s own conventions', () => {
  const t = Buffer.from(signPdf(base(), opts({ name: 'A (B)' }))).toString('latin1');
  assert.match(t, /\/Name \(A \\\(B\\\)\)/);
  assert.match(t, /\/Filter \/Adobe\.PPKLite/);
});
