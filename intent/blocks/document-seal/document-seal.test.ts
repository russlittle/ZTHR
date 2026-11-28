import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Consent } from '../consent/index.ts';
import { SignatureCapture, intentStatement } from '../signature-capture/index.ts';
import { createCertificate, issue } from '../trusted-timestamp/index.ts';
import { SealRefused, Sealer, certificateHtml, certificateLines, certificatePdf, sealIdFromLink, verifyHtml } from './index.ts';
import type { SealRecord, SignerEntry } from './index.ts';

const T0 = new Date('2025-06-01T12:00:00Z');
const key = randomBytes(24).toString('hex');
const doc = Buffer.from('%PDF-1.7\nthe lease, every page\n%%EOF');
const ev = (c: string) => createHash('sha256').update(c).digest('hex');
const signers: SignerEntry[] = [
  { id: 'u2', name: 'Bo Chen', email: 'bo@example.org', method: 'typed', signedAt: '2025-06-01T11:30:00Z', evidenceSha256: ev('bo') },
  { id: 'u1', name: 'Ana Silva', method: 'drawn', signedAt: '2025-06-01T11:00:00Z', evidenceSha256: ev('ana'), ip: '203.0.113.7' },
];

const tsa = () => {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const nb = new Date('2025-01-01T00:00:00Z');
  const na = new Date('2035-01-01T00:00:00Z');
  const caCert = createCertificate({ subject: { commonName: 'Seal Test CA' }, publicKey: ca.publicKey, signingKey: ca.privateKey, serial: 1n, notBefore: nb, notAfter: na, kind: 'ca' });
  const cert = createCertificate({ subject: { commonName: 'Seal Test TSA' }, issuer: { commonName: 'Seal Test CA' }, publicKey: k.publicKey, signingKey: ca.privateKey, serial: 2n, notBefore: nb, notAfter: na, kind: 'tsa' });
  let n = 1n;
  return { ca: caCert, at: (when: string) => async (req: Buffer) => issue(req, { certificate: cert, privateKey: k.privateKey, policy: '1.2.3.4', now: () => new Date(when), nextSerial: () => n++ }) };
};

const make = (o: Partial<ConstructorParameters<typeof Sealer>[0]> = {}) => new Sealer({ sealKey: key, baseUrl: 'https://sign.example.com', now: () => new Date('2025-06-01T12:05:00Z'), ...o });
const input = (o: Partial<Parameters<Sealer['seal']>[0]> = {}) => ({ id: 'seal-001', title: 'Lease agreement', document: doc, signers, completedAt: T0, ...o });
const stamped = () => {
  const t = tsa();
  return { t, sealer: make({ timestamp: t.at('2025-06-01T12:00:30Z'), trustedRoots: [t.ca], nonce: () => 99n }) };
};
const names = (r: { checks: readonly { name: string; ok: boolean }[] }) => r.checks.map((c) => `${c.name}:${c.ok ? 'ok' : 'FAIL'}`).join(' ');

test('a seal records the document hash and size, signers in order of signing, and a hash over all of it', async () => {
  const r = await make().seal(input());
  assert.equal(r.manifest.documentSha256, createHash('sha256').update(doc).digest('hex'));
  assert.equal(r.manifest.documentBytes, doc.length);
  assert.deepEqual(r.manifest.signers.map((s) => s.id), ['u1', 'u2']);
  assert.equal(r.manifest.completedAt, '2025-06-01T12:00:00.000Z');
  assert.match(r.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.timestamp, undefined);
  const again = await make().seal(input({ signers: [...signers].reverse() }));
  assert.equal(again.manifestSha256, r.manifestSha256, 'the order signers are listed in does not matter');
  assert.equal(again.mac, r.mac);
});

test('the verification link carries a key derived from the seal; ids alone are not enough', async () => {
  const s = make();
  const r = await s.seal(input());
  assert.match(r.link, /^https:\/\/sign\.example\.com\/verify\/seal-001\?k=[A-Za-z0-9_-]{22}$/);
  assert.equal(sealIdFromLink(r.link), 'seal-001');
  assert.equal(s.linkMatches(r.link, r), true);
  assert.equal(s.linkMatches(r.link.replace(/k=./, 'k=A'), r), false);
  assert.equal(s.linkMatches(r.link.replace('seal-001', 'seal-002'), r), false);
  assert.throws(() => sealIdFromLink('https://sign.example.com/verify/x'), /not a verification link/);
  const other = await make({ sealKey: randomBytes(24).toString('hex') }).seal(input());
  assert.notEqual(other.link, r.link, 'another key gives another link');
});

test('an untouched document passes every check, with an independent timestamp', async () => {
  const { sealer } = stamped();
  const r = await sealer.seal(input());
  assert.equal(r.timestamp?.genTime, '2025-06-01T12:00:30.000Z');
  assert.equal(r.timestamp?.tsa, 'CN=Seal Test TSA');
  const rep = sealer.verify(doc, r);
  assert.equal(rep.ok, true);
  assert.equal(rep.dated, true);
  assert.equal(names(rep), 'document:ok manifest:ok seal:ok timestamp:ok');
  assert.match(rep.checks[3]!.detail, /timestamped 2025-06-01T12:00:30.000Z by CN=Seal Test TSA/);
});

test('a changed document is reported with where it first differs from the archived original', async () => {
  const { sealer } = stamped();
  const r = await sealer.seal(input());
  const bad = Buffer.from(doc);
  bad[20] = bad[20]! ^ 1;
  const rep = sealer.verify(bad, r, { original: doc });
  assert.equal(rep.ok, false);
  assert.equal(names(rep), 'document:FAIL manifest:ok seal:ok timestamp:ok');
  assert.match(rep.checks[0]!.detail, /has changed since it was sealed/);
  assert.deepEqual(rep.tamper, { firstDifference: 20, presentedBytes: doc.length, originalBytes: doc.length });
  const longer = Buffer.concat([doc, Buffer.from('extra page')]);
  const rep2 = sealer.verify(longer, r, { original: doc });
  assert.match(rep2.checks[0]!.detail, new RegExp(`${longer.length} bytes; ${doc.length} were sealed`));
  assert.equal(rep2.tamper?.firstDifference, doc.length);
  assert.equal(sealer.verify(doc, r, { original: doc }).tamper?.firstDifference, null);
});

test('a record whose signers or title were edited fails the manifest and the seal, even if the hash is recomputed', async () => {
  const { sealer } = stamped();
  const r = await sealer.seal(input());
  const edited: SealRecord = { ...r, manifest: { ...r.manifest, signers: r.manifest.signers.map((s, i) => (i ? { ...s, name: 'Eve Mallory' } : s)) } };
  assert.equal(names(sealer.verify(doc, edited)), 'document:ok manifest:FAIL seal:FAIL timestamp:ok');
  const rehash = createHash('sha256').update(JSON.stringify(edited.manifest)).digest('hex');
  const forged: SealRecord = { ...edited, manifestSha256: rehash };
  const rep = sealer.verify(doc, forged);
  assert.equal(rep.ok, false);
  assert.ok(rep.checks.find((c) => c.name === 'seal' && !c.ok), 'without the key the seal cannot be remade');
  assert.ok(rep.checks.find((c) => c.name === 'timestamp' && !c.ok), 'and the timestamp covers the old hash');
});

test('a record made under another key does not verify here', async () => {
  const { sealer } = stamped();
  const r = await sealer.seal(input());
  const stranger = make({ sealKey: randomBytes(24).toString('hex'), trustedRoots: [] });
  assert.match(stranger.verify(doc, r).checks[2]!.detail, /not made by this service/);
});

test('without a timestamp the seal is intact but undated, said plainly', async () => {
  const s = make();
  const r = await s.seal(input());
  const rep = s.verify(doc, r);
  assert.equal(rep.ok, true);
  assert.equal(rep.dated, false);
  assert.equal(rep.checks[3]!.optional, true);
  assert.match(rep.checks[3]!.detail, /rests on this service alone/);
});

test('a timestamp from an authority not trusted, or dated before completion, is refused', async () => {
  const t = tsa();
  const stranger = tsa();
  await assert.rejects(make({ timestamp: t.at('2025-06-01T12:00:30Z'), trustedRoots: [stranger.ca] }).seal(input()), /does not chain to a trusted root/);
  await assert.rejects(make({ timestamp: t.at('2025-06-01T11:00:00Z'), trustedRoots: [t.ca] }).seal(input()), SealRefused);
  const good = make({ timestamp: t.at('2025-06-01T12:00:30Z'), trustedRoots: [t.ca], nonce: () => 5n });
  const r = await good.seal(input());
  const verifier = make({ trustedRoots: [stranger.ca] });
  const rep = verifier.verify(doc, r);
  assert.equal(rep.ok, false);
  assert.match(rep.checks[3]!.detail, /does not chain/);
});

test('a timestamp lifted from another seal does not fit this one', async () => {
  const { sealer } = stamped();
  const a = await sealer.seal(input());
  const b = await sealer.seal(input({ id: 'seal-002', title: 'Another' }));
  const swapped: SealRecord = { ...b, timestamp: a.timestamp! };
  assert.equal(sealer.verify(doc, swapped).checks[3]!.ok, false);
});

test('signer evidence is checked against the hashes in the seal, using the signature-capture block', async () => {
  const clock = { d: T0 };
  const consent = new Consent(() => clock.d);
  consent.publish({ doc: 'esign', version: 1, effective: '2025-01-01', requiresAgreement: true, required: true, summary: 'e-sign' });
  consent.agree('u1', 'esign', 'page');
  const cap = new SignatureCapture({ consent, consentDoc: 'esign', sealKey: key, now: () => clock.d, newId: () => 'sig1' });
  const rec = cap.capture({ signerId: 'u1', signerName: 'Ana Silva', documentSha256: createHash('sha256').update(doc).digest('hex'), documentTitle: 'Lease agreement', intentShown: intentStatement('Ana Silva', 'Lease agreement'), body: { method: 'typed', name: 'Ana Silva', style: 'script-1' }, evidence: { ip: '203.0.113.7', userAgent: 'x' } });
  const s = make();
  const r = await s.seal(input({ signers: [{ id: 'u1', name: 'Ana Silva', method: 'typed', signedAt: rec.capturedAt, evidenceSha256: rec.bundleSha256 }], completedAt: new Date('2025-06-01T12:01:00Z') }));
  const good = s.verify(doc, r, { evidence: { u1: { bundleSha256: rec.bundleSha256, ok: cap.verify(rec).ok } } });
  assert.equal(good.checks.at(-1)!.detail, "every signer's evidence record is intact");
  assert.equal(good.ok, true);
  const tampered = s.verify(doc, r, { evidence: { u1: { bundleSha256: rec.bundleSha256, ok: cap.verify({ ...rec, signerName: 'Eve' }).ok } } });
  assert.equal(tampered.ok, false);
  assert.match(tampered.checks.at(-1)!.detail, /altered for: Ana Silva/);
  assert.match(s.verify(doc, r, { evidence: {} }).checks.at(-1)!.detail, /missing or altered for: Ana Silva/);
});

test('sealing refuses what it should', async () => {
  const s = make();
  await assert.rejects(s.seal(input({ id: 'bad id!' })), /seal id/);
  await assert.rejects(s.seal(input({ title: '  ' })), /title/);
  await assert.rejects(s.seal(input({ signers: [] })), /no signers/);
  await assert.rejects(s.seal(input({ document: new Uint8Array(0) })), /empty/);
  await assert.rejects(s.seal(input({ signers: [signers[0]!, signers[0]!] })), /appears twice/);
  await assert.rejects(s.seal(input({ signers: [{ ...signers[0]!, evidenceSha256: 'zz' }] })), /no evidence hash/);
  await assert.rejects(s.seal(input({ signers: [{ ...signers[0]!, signedAt: 'yesterday' }] })), /no valid signing time/);
  await assert.rejects(s.seal(input({ signers: [{ ...signers[0]!, signedAt: '2025-06-02T00:00:00Z' }] })), /signed after the document was completed/);
});

test('the sealer is refused a short key and an insecure link base', () => {
  assert.throws(() => make({ sealKey: 'short' }), /too short/);
  assert.throws(() => make({ baseUrl: 'http://sign.example.com' }), /must be https/);
  assert.throws(() => make({ baseUrl: 'https://sign.example.com/?x=1' }), /no query/);
  assert.doesNotThrow(() => make({ baseUrl: 'http://localhost:3000' }));
});

test('the certificate shows everything and escapes anything a signer typed', async () => {
  const evil = { ...signers[0]!, name: '<script>alert(1)</script> "Bo"', email: 'bo@example.org' };
  const r = await make().seal(input({ title: 'Lease <b>&</b>', signers: [evil, signers[1]!] }));
  const html = certificateHtml(r);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>'));
  assert.match(html, /&#60;script&#62;alert\(1\)&#60;\/script&#62; &#34;Bo&#34;/);
  assert.match(html, /Lease &#60;b&#62;&#38;&#60;\/b&#62;/);
  assert.match(html, new RegExp(`href="${r.link.replace(/[?]/g, '\\?')}"`));
  const lines = certificateLines(r);
  assert.equal(lines[0], 'CERTIFICATE OF COMPLETION');
  assert.ok(lines.includes(`SHA-256: ${r.manifest.documentSha256}`));
  assert.ok(lines.includes('Timestamp: none (the date rests on this service alone)'));
  assert.equal(lines.at(-1), r.link);
});

test('the verify page lists each check in plain words and escapes details', async () => {
  const { sealer } = stamped();
  const r = await sealer.seal(input());
  const bad = Buffer.from(doc);
  bad[3] = bad[3]! ^ 1;
  const html = verifyHtml(sealer.verify(bad, r, { original: doc }));
  assert.match(html, /could not be verified/);
  assert.match(html, /Failed: document/);
  assert.match(html, /Passed: seal/);
  assert.match(html, /first differs from the archived original at byte 3/);
  assert.match(verifyHtml(sealer.verify(doc, r)), /This document is intact/);
});

test('the certificate PDF is well formed: header, object offsets that match the xref table, and an end marker', async () => {
  const r = await make().seal(input({ title: 'Lease (with parens) \\ and non-ASCII é' }));
  const pdf = certificatePdf(r).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.endsWith('%%EOF\n'));
  const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)![1]);
  assert.equal(pdf.slice(xrefAt, xrefAt + 4), 'xref');
  const entries = [...pdf.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(entries.length, 5);
  entries.forEach((off, i) => assert.equal(pdf.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.match(pdf, /\(Document: Lease \\\(with parens\\\) \\\\ and non-ASCII \?\) Tj/);
  assert.match(pdf, /\/Count 1 /);
  const len = /\/Length (\d+) >>\nstream\n/.exec(pdf)!;
  const start = pdf.indexOf('stream\n', pdf.indexOf(len[0])) + 7;
  assert.equal(pdf.slice(start + Number(len[1]), start + Number(len[1]) + 10), '\nendstream');
});

test('a certificate with many signers runs over to more pages', async () => {
  const many: SignerEntry[] = Array.from({ length: 25 }, (_, i) => ({ id: `u${i}`, name: `Signer ${i}`, method: 'typed', signedAt: '2025-06-01T11:00:00Z', evidenceSha256: ev(String(i)) }));
  const r = await make().seal(input({ signers: many }));
  const pdf = certificatePdf(r).toString('latin1');
  assert.match(pdf, /\/Count 2 /);
  assert.equal([...pdf.matchAll(/\/Type \/Page /g)].length, 2);
});
