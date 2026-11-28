import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { Audit, memoryAudit } from '../audit/index.ts';
import { AnchorPlan, TimestampError, anchorAuditHead, checkDocumentProof, createCertificate, der, issue, makeRequest, merkleProof, merkleRoot, parseDer, parseRequest, readOid, rootFromProof, sha, verifyDocumentTimestamp, verifyResponse } from './index.ts';

// Made by OpenSSL 3.0 ("openssl ts -reply"), an independent implementation. Public data only: a CA certificate,
// the request, and the response (which carries the time-stamping certificate). The private keys were thrown away.
const OPENSSL_CA = 'MIIBeTCCAR6gAwIBAgIUN4NxbbaHuBCiVH0AeFNKx157wEQwCgYIKoZIzj0EAwIwGjEYMBYGA1UEAwwPRml4dHVyZSBUZXN0IENBMB4XDTI2MTEyODA3NDUyMloXDTQ2MTEyMzA3NDUyMlowGjEYMBYGA1UEAwwPRml4dHVyZSBUZXN0IENBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ8ynZL/NboYCx7mMPSGI5RdE9310dHzOn7fO+64040E/r/taUS5FKwelKK1Bre937xWVI9Avxonf2Zx1Xd9Qq6NCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFLke7tEVSo4hyBaXk86UXj7mCpreMAoGCCqGSM49BAMCA0kAMEYCIQCEgs2EvNmnl4vD15Ipd8kD7BRe9fWEh4PosOMJ/PiK+QIhAILZ+euhi/hMl3ns+BNEb+uTrvB8pOIycwv8qlx9ctQG';
const OPENSSL_REQUEST = 'MEQCAQEwMTANBglghkgBZQMEAgEFAAQg9TCn651coLfZDpX6Vtc6iInx6+OQp1UV1ljcJvRP4DICCQCH3FxlKrsIyQEB/w==';
const OPENSSL_RESPONSE = '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';
const OPENSSL_DOC_SHA256 = 'f530a7eb9d5ca0b7d90e95fa56d73a8889f1ebe390a75515d658dc26f44fe032';
const AFTER = new Date('2026-11-28T07:46:00Z');

const b64 = (s: string) => Buffer.from(s, 'base64');
const hex = (s: string) => Buffer.from(s, 'hex');

interface World {
  ca: Buffer;
  tsaCert: Buffer;
  tsaKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  answer: (req: Buffer, at?: string) => Buffer;
}
const NB = new Date('2025-01-01T00:00:00Z');
const NA = new Date('2035-01-01T00:00:00Z');
function world(kind: 'rsa' | 'ec' = 'rsa'): World {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const tsa = kind === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caCert = createCertificate({ subject: { commonName: 'Test CA' }, publicKey: ca.publicKey, signingKey: ca.privateKey, serial: 1n, notBefore: NB, notAfter: NA, kind: 'ca' });
  const tsaCert = createCertificate({ subject: { commonName: 'Test TSA' }, issuer: { commonName: 'Test CA' }, publicKey: tsa.publicKey, signingKey: ca.privateKey, serial: 0x80n, notBefore: NB, notAfter: NA, kind: 'tsa' });
  let serial = 100n;
  return { ca: caCert, tsaCert, tsaKey: tsa.privateKey, answer: (req, at = '2025-06-01T12:00:00Z') => issue(req, { certificate: tsaCert, privateKey: tsa.privateKey, policy: '1.2.3.4.5', now: () => new Date(at), nextSerial: () => serial++ }) };
}
const DOC = sha('sha256', Buffer.from('the signed lease'));
const NOW = new Date('2025-06-01T12:00:10Z');

test('DER: object identifiers, integers and long lengths encode as the standard says', () => {
  assert.equal(der.oid('2.16.840.1.101.3.4.2.1').toString('hex'), '0609608648016503040201');
  assert.equal(der.oid('1.2.840.113549.1.7.2').toString('hex'), '06092a864886f70d010702');
  assert.equal(readOid(parseDer(der.oid('1.3.6.1.5.5.7.3.8'))), '1.3.6.1.5.5.7.3.8');
  assert.equal(der.int(127).toString('hex'), '02017f');
  assert.equal(der.int(128).toString('hex'), '02020080');
  assert.equal(der.int(0).toString('hex'), '020100');
  assert.equal(der.int(0x87dc5c652abb08c9n).toString('hex'), '020900' + '87dc5c652abb08c9');
  const long = der.octets(Buffer.alloc(300, 1));
  assert.equal(long.subarray(0, 4).toString('hex'), '0482012c');
  assert.equal(parseDer(long).value.length, 300);
  assert.equal(der.genTime(new Date('2025-06-01T12:00:00Z')).toString('latin1').slice(2), '20250601120000Z');
  assert.throws(() => der.oid('1'), TimestampError);
});

test('DER reading is strict: no indefinite or padded lengths, no truncation, no leftovers, bounded depth and size', () => {
  assert.throws(() => parseDer(hex('3080020101' + '0000')), /indefinite/);
  assert.throws(() => parseDer(hex('3081050201010101'.slice(0, 6) + '0201010101')), /shortest form/);
  assert.throws(() => parseDer(hex('0481020000')), /shortest form/);
  assert.throws(() => parseDer(hex('3003020101ff')), /bytes after the end/);
  assert.throws(() => parseDer(hex('300502010100')), /longer than the data|ends inside/);
  assert.throws(() => parseDer(hex('30')), /ends inside/);
  assert.throws(() => parseDer(hex('1f8100')), /above 30/);
  let nested = Buffer.from([0x05, 0x00]);
  for (let i = 0; i < 30; i++) nested = der.seq(nested);
  assert.throws(() => parseDer(nested), /nested too deeply/);
  assert.throws(() => parseDer(Buffer.alloc(4_000_001)), /larger than 4 MB/);
});

test('a request is written exactly as OpenSSL writes it for the same hash and nonce', () => {
  const req = makeRequest({ imprint: hex(OPENSSL_DOC_SHA256), nonce: 0x87dc5c652abb08c9n, certReq: true });
  assert.equal(req.toString('base64'), OPENSSL_REQUEST);
  const p = parseRequest(b64(OPENSSL_REQUEST));
  assert.deepEqual([p.hashAlgorithm, p.imprint.toString('hex'), p.nonce, p.certReq, p.policy], ['sha256', OPENSSL_DOC_SHA256, 0x87dc5c652abb08c9n, true, undefined]);
});

test('requests: other hashes, a policy, no certificate request, and wrong sizes or algorithms refused', () => {
  for (const [alg, n] of [['sha384', 48], ['sha512', 64]] as const) assert.equal(parseRequest(makeRequest({ hashAlgorithm: alg, imprint: Buffer.alloc(n, 1) })).hashAlgorithm, alg);
  const r = parseRequest(makeRequest({ imprint: DOC, policy: '1.2.3.4', certReq: false }));
  assert.deepEqual([r.policy, r.certReq, r.nonce], ['1.2.3.4', false, undefined]);
  assert.throws(() => makeRequest({ imprint: Buffer.alloc(31) }), /32 bytes/);
  assert.throws(() => makeRequest({ imprint: DOC, nonce: 1n << 64n }), /64 bits/);
  const sha1 = der.seq(der.int(1), der.seq(der.seq(der.oid('1.3.14.3.2.26'), der.null()), der.octets(Buffer.alloc(20))));
  assert.throws(() => parseRequest(sha1), /not SHA-256, SHA-384 or SHA-512/);
  assert.throws(() => parseRequest(der.seq(der.int(2), der.seq(der.seq(der.oid('2.16.840.1.101.3.4.2.1')), der.octets(DOC)))), /only version 1/);
  assert.throws(() => parseRequest(hex('0500')), /sequence/);
});

test('a response made by OpenSSL verifies: hash, nonce, signature, certificate, chain to a trusted root', () => {
  const v = verifyResponse(b64(OPENSSL_RESPONSE), { request: b64(OPENSSL_REQUEST), trustedRoots: [b64(OPENSSL_CA)], now: AFTER });
  assert.equal(v.genTime.toISOString(), '2026-11-28T07:45:25.000Z');
  assert.equal(v.serial, '2');
  assert.equal(v.policy, '1.2.3.4.1');
  assert.equal(v.imprint, OPENSSL_DOC_SHA256);
  assert.equal(v.hashAlgorithm, 'sha256');
  assert.equal(v.tsa, 'CN=Fixture Test TSA');
  assert.equal(v.nonceChecked, true);
  assert.equal(v.status, 'granted');
});

test('the OpenSSL response is refused for another document, another nonce, another root, or a later check of a time before it', () => {
  const ok = { request: b64(OPENSSL_REQUEST), trustedRoots: [b64(OPENSSL_CA)], now: AFTER };
  const other = makeRequest({ imprint: DOC, nonce: 0x87dc5c652abb08c9n });
  assert.throws(() => verifyResponse(b64(OPENSSL_RESPONSE), { ...ok, request: other }), /different document hash/);
  const nonce = makeRequest({ imprint: hex(OPENSSL_DOC_SHA256), nonce: 5n });
  assert.throws(() => verifyResponse(b64(OPENSSL_RESPONSE), { ...ok, request: nonce }), /nonce does not match/);
  const noNonce = makeRequest({ imprint: hex(OPENSSL_DOC_SHA256) });
  assert.equal(verifyResponse(b64(OPENSSL_RESPONSE), { ...ok, request: noNonce }).nonceChecked, false);
  const strangerCa = world().ca;
  assert.throws(() => verifyResponse(b64(OPENSSL_RESPONSE), { ...ok, trustedRoots: [strangerCa] }), /does not chain to a trusted root/);
  assert.throws(() => verifyResponse(b64(OPENSSL_RESPONSE), { ...ok, now: new Date('2026-11-28T07:00:00Z') }), /dated in the future/);
  assert.throws(() => verifyResponse(b64(OPENSSL_RESPONSE), { ...ok, request: makeRequest({ imprint: hex(OPENSSL_DOC_SHA256), nonce: 0x87dc5c652abb08c9n, policy: '1.9.9.9' }) }), /policy is not the one requested/);
});

test('any change to the OpenSSL response is caught: flip each part and it no longer verifies', () => {
  const good = b64(OPENSSL_RESPONSE);
  const opts = { request: b64(OPENSSL_REQUEST), trustedRoots: [b64(OPENSSL_CA)], now: AFTER };
  const at = (needle: Buffer, shift = 0) => good.indexOf(needle) + shift;
  const flip = (pos: number) => Buffer.concat([good.subarray(0, pos), Buffer.from([good[pos]! ^ 1]), good.subarray(pos + 1)]);
  assert.throws(() => verifyResponse(flip(at(hex(OPENSSL_DOC_SHA256), 3)), opts), TimestampError, 'the hash inside');
  assert.throws(() => verifyResponse(flip(at(Buffer.from('20261128074525Z'), 13)), opts), /message digest does not match/, 'the time inside');
  assert.throws(() => verifyResponse(flip(good.length - 5), opts), /signature is not valid/, 'the signature');
  assert.throws(() => verifyResponse(good.subarray(0, good.length - 1), opts), TimestampError, 'truncated');
  assert.throws(() => verifyResponse(Buffer.concat([good, Buffer.from([0])]), opts), /after the end/, 'extra bytes');
});

test('an authority made here issues tokens that verify, for RSA and ECDSA signing keys', () => {
  for (const kind of ['rsa', 'ec'] as const) {
    const w = world(kind);
    const req = makeRequest({ imprint: DOC, nonce: 424242n, policy: '1.2.3.4.5' });
    const v = verifyResponse(w.answer(req), { request: req, trustedRoots: [w.ca], now: NOW });
    assert.equal(v.genTime.toISOString(), '2025-06-01T12:00:00.000Z', kind);
    assert.equal(v.serial, '64', 'serial 100 in hex');
    assert.equal(v.tsa, 'CN=Test TSA');
    assert.equal(v.imprint, DOC.toString('hex'));
  }
});

test('a response for one request cannot be replayed for another (nonce) or another document (hash)', () => {
  const w = world();
  const req = makeRequest({ imprint: DOC, nonce: 1n });
  const resp = w.answer(req);
  const o = { trustedRoots: [w.ca], now: NOW };
  assert.throws(() => verifyResponse(resp, { ...o, request: makeRequest({ imprint: DOC, nonce: 2n }) }), /nonce does not match/);
  assert.throws(() => verifyResponse(resp, { ...o, request: makeRequest({ imprint: sha('sha256', Buffer.from('other')), nonce: 1n }) }), /different document hash/);
  assert.equal(verifyResponse(resp, { ...o, request: req }).nonceChecked, true);
});

test('a token signed by a stranger, by an untrusted authority, or by a certificate not meant for time stamping is refused', () => {
  const w = world();
  const req = makeRequest({ imprint: DOC, nonce: 9n });
  assert.throws(() => verifyResponse(w.answer(req), { request: req, trustedRoots: [world().ca], now: NOW }), /does not chain to a trusted root/);
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const notTsa = createCertificate({ subject: { commonName: 'Plain CA' }, publicKey: ca.publicKey, signingKey: ca.privateKey, serial: 5n, notBefore: NB, notAfter: NA, kind: 'ca' });
  const resp = issue(req, { certificate: notTsa, privateKey: ca.privateKey, policy: '1.2.3.4.5', now: () => new Date('2025-06-01T12:00:00Z'), nextSerial: () => 1n });
  assert.throws(() => verifyResponse(resp, { request: req, trustedRoots: [notTsa], now: NOW }), /not marked for time stamping/);
});

test('certificate validity is judged at the time stamped, not today', () => {
  const w = world();
  const req = makeRequest({ imprint: DOC, nonce: 3n });
  const before = w.answer(req, '2024-06-01T00:00:00Z');
  assert.throws(() => verifyResponse(before, { request: req, trustedRoots: [w.ca], now: NOW }), /not valid at the time stamped/);
  const inside = w.answer(req, '2034-06-01T00:00:00Z');
  assert.equal(verifyResponse(inside, { request: req, trustedRoots: [w.ca], now: new Date('2040-01-01T00:00:00Z') }).genTime.getUTCFullYear(), 2034, 'a token stays good after the certificate later expires');
});

test('a refused request gives a rejection that says why; a garbled request gets badDataFormat', () => {
  const w = world();
  const resp = w.answer(Buffer.from('not a request'));
  assert.throws(() => verifyResponse(resp, { request: makeRequest({ imprint: DOC }), trustedRoots: [w.ca], now: NOW }), /refused \(status rejection: badDataFormat\)/);
  assert.throws(() => verifyResponse(der.seq(der.seq(der.int(0))), { request: makeRequest({ imprint: DOC }), trustedRoots: [], now: NOW }), /granted but has no token/);
  assert.throws(() => verifyResponse(der.seq(der.seq(der.int(2), der.bits(Buffer.from([0x80]), 7))), { request: makeRequest({ imprint: DOC }), trustedRoots: [], now: NOW }), /badAlg/);
});

// --- Merkle batches

const leavesOf = (n: number) => Array.from({ length: n }, (_, i) => Buffer.from(sha('sha256', Buffer.from(String(i)))));

test('RFC 6962 Merkle hashing: the empty tree and one empty leaf have the well-known roots', () => {
  assert.equal(merkleRoot([]).toString('hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(merkleRoot([Buffer.alloc(0)]).toString('hex'), '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
  const two = createHash('sha256').update(Buffer.concat([Buffer.from([1]), hex('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d'), hex('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d')])).digest('hex');
  assert.equal(merkleRoot([Buffer.alloc(0), Buffer.alloc(0)]).toString('hex'), two);
});

test('the Certificate Transparency test tree roots (RFC 6962 reference data)', () => {
  const inputs = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map(hex);
  const roots = ['6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d', 'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125', 'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77', 'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7', '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4', '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef', 'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c', '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328'];
  roots.forEach((r, i) => assert.equal(merkleRoot(inputs.slice(0, i + 1)).toString('hex'), r, `${i + 1} leaves`));
});

test('inclusion proofs verify for every leaf of trees of every size up to 33, and for nothing else', () => {
  for (let n = 1; n <= 33; n++) {
    const leaves = leavesOf(n);
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const p = merkleProof(leaves, i);
      assert.equal(rootFromProof(leaves[i]!, i, n, p).toString('hex'), root.toString('hex'), `size ${n} leaf ${i}`);
    }
  }
  const leaves = leavesOf(9);
  const root = merkleRoot(leaves).toString('hex');
  const p = merkleProof(leaves, 4);
  assert.notEqual(rootFromProof(leaves[5]!, 4, 9, p).toString('hex'), root, 'wrong leaf');
  assert.notEqual(rootFromProof(leaves[4]!, 5, 9, p).toString('hex'), root, 'wrong index');
  assert.throws(() => rootFromProof(leaves[4]!, 4, 9, p.slice(1)), /shorter than the tree/);
  assert.throws(() => rootFromProof(leaves[4]!, 4, 9, [...p, p[0]!]), /longer than the tree/);
  assert.throws(() => merkleProof(leaves, 9), /not in the batch/);
});

test('the plan batches documents: due by count or by waiting, sealed into a root, and every document gets a proof', () => {
  const t = { now: 0 };
  const plan = new AnchorPlan({ maxLeaves: 4, maxWaitMs: 60_000, now: () => t.now });
  assert.deepEqual(plan.due(), { due: false, why: 'nothing is waiting' });
  const docs = ['a', 'b', 'c', 'd', 'e'].map((x) => sha('sha256', Buffer.from(x)).toString('hex'));
  plan.add(docs[0]!);
  plan.add(docs[0]!);
  assert.equal(plan.waiting, 1, 'the same hash is not added twice');
  assert.match(plan.due().why, /1 waiting, the oldest for 0 seconds/);
  t.now = 61_000;
  assert.deepEqual(plan.due(), { due: true, why: 'the oldest has waited 61 seconds' });
  for (const d of docs.slice(1)) plan.add(d);
  assert.deepEqual(plan.due(), { due: true, why: '5 documents are waiting' });
  const b = plan.seal();
  assert.equal(b.leaves.length, 4);
  assert.equal(plan.waiting, 1, 'the fifth waits for the next batch');
  for (const d of b.leaves) assert.equal(checkDocumentProof(d, plan.proofFor(b.id, d)), true);
  assert.equal(checkDocumentProof(docs[4]!, plan.proofFor(b.id, docs[0]!)), false);
  assert.throws(() => plan.proofFor(b.id, docs[4]!), /not in the batch/);
  assert.throws(() => plan.proofFor(99, docs[0]!), /no batch 99/);
  assert.throws(() => plan.add('xyz'), /64 lower-case hex/);
});

test('a document timestamped through a batch verifies from its proof and the one timestamp over the root', () => {
  const w = world();
  const plan = new AnchorPlan({ maxLeaves: 8, maxWaitMs: 0, now: () => 0 });
  const docs = ['lease', 'invoice', 'nda', 'receipt', 'memo'].map((x) => sha('sha256', Buffer.from(x)).toString('hex'));
  docs.forEach((d) => plan.add(d));
  const batch = plan.seal();
  const req = makeRequest({ imprint: hex(batch.root), nonce: 77n });
  const resp = w.answer(req);
  const proof = plan.proofFor(batch.id, docs[2]!);
  const o = { trustedRoots: [w.ca], now: NOW };
  const v = verifyDocumentTimestamp(docs[2]!, proof, resp, o);
  assert.equal(v.genTime.toISOString(), '2025-06-01T12:00:00.000Z');
  assert.equal(v.nonceChecked, false, 'the document check does not know the nonce the batch used');
  const plain = w.answer(makeRequest({ imprint: hex(batch.root) }));
  assert.equal(verifyDocumentTimestamp(docs[2]!, proof, plain, o).imprint, batch.root);
  assert.throws(() => verifyDocumentTimestamp(sha('sha256', Buffer.from('forged')).toString('hex'), proof, plain, o), /does not connect the document/);
});

test('the head of the audit log is timestamped and the anchor is written into the log itself', async () => {
  const w = world('ec');
  const audit = new Audit(memoryAudit(), { now: () => new Date('2025-06-01T12:00:00Z') });
  await audit.record({ actor: 'ana', action: 'sign', target: 'doc:1' });
  await audit.record({ actor: 'bo', action: 'sign', target: 'doc:2' });
  const seen: Buffer[] = [];
  const r = await anchorAuditHead(audit, async (req) => { seen.push(req); return w.answer(req); }, { trustedRoots: [w.ca], now: () => NOW, nonce: 31337n });
  assert.equal(r.head.n, 2);
  assert.equal(parseRequest(seen[0]!).imprint.toString('hex'), r.head.hash, 'the request carries the chain head, nothing else');
  assert.equal(r.verified.imprint, r.head.hash);
  const entries = await audit.about({ target: 'audit:2' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.action, 'timestamp.anchored');
  assert.equal(entries[0]!.detail?.['genTime'], '2025-06-01T12:00:00.000Z');
  assert.equal(await audit.verify(), null, 'the log still verifies with the anchor in it');
  await assert.rejects(anchorAuditHead(audit, async (req) => w.answer(makeRequest({ imprint: DOC, nonce: 1n })), { trustedRoots: [w.ca], now: () => NOW, nonce: 5n }), /different document hash|nonce/);
});
