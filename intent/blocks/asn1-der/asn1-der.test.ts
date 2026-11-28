import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DerError, UT, asBits, asBoolean, asInteger, asOid, asString, asTime, bitString, boolean, buildCsr, explicit, fromPem, generalNames, ia5String, implicit, integer, matchesHostname, nameToString, nullValue, octetString, oid, oidName, oidOf, parseAll, parseCertificate, parseCsr, parseDer, parseSpki, printableString, sanExtension, sequence, set, signedBy, time, tlv, toPem, utf8String, validAt } from './index.ts';
import type { Der } from './index.ts';
import { OID, asOctets, checkSignature } from './index.ts';
import { sign as cryptoSign } from 'node:crypto';

// Made with OpenSSL for these tests: a root, a server certificate it signed (SAN, key usage, EKU), and a self-signed Ed25519 certificate.
const ROOT = `-----BEGIN CERTIFICATE-----
MIIBvDCCAWGgAwIBAgIUZ+gke9PhlRiiEM92FYa3KyKtMNcwCgYIKoZIzj0EAwIw
MjEeMBwGA1UEAwwVVGVzdCBBdHRlc3RhdGlvbiBSb290MRAwDgYDVQQKDAdFeGFt
cGxlMCAXDTI2MTEyODA1NTMyOVoYDzIxMjYxMTA0MDU1MzI5WjAyMR4wHAYDVQQD
DBVUZXN0IEF0dGVzdGF0aW9uIFJvb3QxEDAOBgNVBAoMB0V4YW1wbGUwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAARUZQDumQ7QAf1EvzzU8RPnLx1et7vmCeDCAcv3
Xv13VLK9ZQZX9vKZEZzqIZtJac1JJNomZF5oEumt6GdRQLzuo1MwUTAdBgNVHQ4E
FgQUaEjkGdoZ/KvUZcsBsihfJX7qq1kwHwYDVR0jBBgwFoAUaEjkGdoZ/KvUZcsB
sihfJX7qq1kwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA7FDz
bLwiEfFSQE167DkcHmHARg1UKLttn+Q3OcwAlfsCIQDPCyLcFSmaplhuBfn5CoXq
DGahgBWU86o3N97hxpsTCw==
-----END CERTIFICATE-----
`;
const SERVER = `-----BEGIN CERTIFICATE-----
MIICejCCAiCgAwIBAgIURvhxSDLWZiKYHY7EHgT92yUR7JkwCgYIKoZIzj0EAwIw
MjEeMBwGA1UEAwwVVGVzdCBBdHRlc3RhdGlvbiBSb290MRAwDgYDVQQKDAdFeGFt
cGxlMCAXDTI2MTEyODA2MjEyOVoYDzIxMjYxMTA0MDYyMTI5WjBbMQswCQYDVQQG
EwJVUzENMAsGA1UECAwET2hpbzEPMA0GA1UEBwwGRGF5dG9uMRYwFAYDVQQKDA1F
eGFtcGxlLCBJbmMuMRQwEgYDVQQDDAtleGFtcGxlLm9yZzBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABNE5Ju8ULg4OnViobT3/S1aViqOYFJ8tnpHnFKcAntE/y8DE
8c/lMP0Rd1Oxpym1BpgTAXN1xB6neFEaT8xf2jWjgegwgeUwDAYDVR0TAQH/BAIw
ADAOBgNVHQ8BAf8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMC
MGYGA1UdEQRfMF2CC2V4YW1wbGUub3Jngg0qLmV4YW1wbGUub3JnhwTAAAIHhxAg
AQ24AAAAAAAAAAAAAAABgQ9vcHNAZXhhbXBsZS5vcmeGFmh0dHBzOi8vZXhhbXBs
ZS5vcmcvaWQwHQYDVR0OBBYEFIuFDdiZrWDu13dc3ey90d7I1KXsMB8GA1UdIwQY
MBaAFGhI5BnaGfyr1GXLAbIoXyV+6qtZMAoGCCqGSM49BAMCA0gAMEUCIHWXvRtM
0/rf0lK32w/Kr1AJt80rKL0JwzlLgg7/s2+OAiEA0Xy9uT5UlT0/o3DTbpP5SUA1
7kuIaUqDkn6vxPhAkuI=
-----END CERTIFICATE-----
`;
const ED = `-----BEGIN CERTIFICATE-----
MIIBSDCB+6ADAgECAhQOkwGp0RMdgMMK3nJvexfbXrf0CzAFBgMrZXAwGTEXMBUG
A1UEAwwOZWQuZXhhbXBsZS5vcmcwIBcNMjYxMTI4MDYyMTMwWhgPMjEyNjExMDQw
NjIxMzBaMBkxFzAVBgNVBAMMDmVkLmV4YW1wbGUub3JnMCowBQYDK2VwAyEAeAVb
yRvHADrGvhU/QK02j4ylTNlLPaHLiiQXkMaS1jajUzBRMB0GA1UdDgQWBBTVUbX6
ovkon+zjsJ2qQf7mB8aZ1DAfBgNVHSMEGDAWgBTVUbX6ovkon+zjsJ2qQf7mB8aZ
1DAPBgNVHRMBAf8EBTADAQH/MAUGAytlcANBAB86huTekEIbiMyHnuD2eWFvqZX1
Muk93h+jmG+rzUAPgpSaC1TsG2/Dgd10YKOqDp7OZMi1ns2bqtOIv5+mbAA=
-----END CERTIFICATE-----
`;
const RSA_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICrzCCAZcCAQAwKDEYMBYGA1UEAwwPcnNhLmV4YW1wbGUub3JnMQwwCgYDVQQK
DANaZWQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5DWKPLSu9y372
3MrBk0sp/3SaV6AtTJEEABGwXERwpsbD6yYKB7gGubAYWHNjPtogipjc0NScwzN7
2AmzGlTaSJCHSTu/t0x074kTo5idrL/iYIVlXkBygpXVqyd7z8K5xrMvaC57FLpS
hoCnWJGZJrywe+2gXU9oIAJXW4017PVYwRPVilhsvJ6BlXz3X0CNlXO6J9V6LfHe
q4VotMfSo+QR6iijFaEMTuLw+dCEzTLh2NK7QTozIITJD836wjL/RG8vlybKyr1N
zZ03HDAD18k9XpQWyrJOMZfwMPebG9m4AvGyaCJE1BOccPIqWwy12GiUxP8ciHvz
kCaEcxatAgMBAAGgQjBABgkqhkiG9w0BCQ4xMzAxMC8GA1UdEQQoMCaCD3JzYS5l
eGFtcGxlLm9yZ4ITd3d3LnJzYS5leGFtcGxlLm9yZzANBgkqhkiG9w0BAQsFAAOC
AQEAtuDGMvk3aiC8o8Bk1G3JAT2AWXa51LjoP0mm+Ty4PEzBL5YMtDzeLeNJBKP8
PwKl/36dg9gkRO8o63AaQTBzZxHjswIzbAt8XcnGA6OAfXEVXfBAOLmUSHpItTgh
sCz22IzR/tbQFzlvTxlSmyI2v/luqXYLLXIBt0BHstnnUL1LEQsUxfUytXXFeH2h
XI6d2cGgEZvjojJNUc2IaNCPGfGRg2F2KlEwAOPMEVAc6zB9JC7uYDm4v5UxAUsa
xKFu97/ZU6e6SrOkeO0J4HV550KoLqkD6PIdBeOeKh9sHywsR+oQrOB4q2cDNbIl
24OBirfUzrWKtZ4LvvjlIdlLWg==
-----END CERTIFICATE REQUEST-----
`;

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const der = (pem: string) => fromPem(pem)[0]!.der;
const rewrite = (n: Der): Buffer => tlv(n.cls, n.constructed, n.tag, n.constructed ? Buffer.concat(n.children.map(rewrite)) : n.content);
const bad = (h: string, why: RegExp) => assert.throws(() => parseDer(hex(h)), (e: Error) => e instanceof DerError && why.test(e.message), h);

test('integers: the X.690 encodings, both ways, including negatives and numbers past 64 bits', () => {
  const cases: [bigint, string][] = [[0n, '020100'], [127n, '02017f'], [128n, '02020080'], [255n, '020200ff'], [256n, '02020100'], [-1n, '0201ff'], [-128n, '020180'], [-129n, '0202ff7f'], [65535n, '02030 0ffff'.replace(' ', '')], [2n ** 64n, '0209010000000000000000'], [-(2n ** 64n), '0209ff0000000000000000'.replace('0209ff', '0209ff')]];
  for (const [v, h] of cases) {
    assert.equal(integer(v).toString('hex'), h, String(v));
    assert.equal(asInteger(parseDer(hex(h))), v, h);
  }
  assert.equal(integer(5).toString('hex'), '020105');
});

test('object identifiers: X.690 examples, large arcs, and refusal of nonsense', () => {
  assert.equal(oid('1.2.840.113549').toString('hex'), '06062a864886f70d');
  assert.equal(oid('2.100.3').toString('hex'), '0603813403', 'X.690 8.19.5: the first two arcs share a byte, and 2.x may exceed 39');
  assert.equal(asOid(parseDer(hex('0603813403'))), '2.100.3');
  assert.equal(asOid(parseDer(oid('1.3.6.1.4.1.311.21.7'))), '1.3.6.1.4.1.311.21.7');
  assert.equal(asOid(parseDer(oid('2.25.329800735698586629295641978511506172918'))), '2.25.329800735698586629295641978511506172918');
  for (const b of ['1', '3.1', '1.40', '1.2.', '1.02', 'a.b', '']) assert.throws(() => oid(b), DerError, b);
  assert.equal(oidName('2.5.4.3'), 'CN');
  assert.equal(oidOf('serverAuth'), '1.3.6.1.5.5.7.3.1');
  assert.equal(oidOf('1.2.3'), '1.2.3');
  assert.throws(() => oidOf('nope'), /unknown object identifier name/);
});

test('lengths and tags: short, long form in the fewest bytes, and tag numbers past 30', () => {
  assert.deepEqual(octetString(Buffer.alloc(127)).subarray(0, 2), hex('04 7f'));
  assert.deepEqual(octetString(Buffer.alloc(128)).subarray(0, 3), hex('04 81 80'));
  assert.deepEqual(octetString(Buffer.alloc(256)).subarray(0, 4), hex('04 82 01 00'));
  assert.deepEqual(octetString(Buffer.alloc(70000)).subarray(0, 5), hex('04 83 01 11 70'));
  for (const n of [0, 127, 128, 255, 256, 65535, 70000]) assert.equal(parseDer(octetString(Buffer.alloc(n))).content.length, n);
  assert.deepEqual(tlv(2, false, 31, Buffer.from([1])), hex('9f 1f 01 01'));
  assert.deepEqual(tlv(2, true, 200, Buffer.alloc(0)), hex('bf 81 48 00'));
  const n = parseDer(hex('bf 81 48 00'));
  assert.deepEqual([n.cls, n.constructed, n.tag], [2, true, 200]);
  assert.deepEqual(explicit(0, integer(2)), hex('a0 03 02 01 02'));
  assert.deepEqual(implicit(2, Buffer.from('a.b')), hex('82 03 61 2e 62'));
});

test('what DER forbids is refused: indefinite and padded lengths, bad tags, booleans, integers, bit strings, nulls, trailing bytes', () => {
  bad('30 80 00 00', /indefinite/);
  bad('04 81 05 00 00 00 00 00', /shortest/);
  bad('04 82 00 80 ' + '00'.repeat(128), /shortest/);
  bad('04 85 00 00 00 00 01 00', /more than 4 bytes/);
  bad('04 05 00', /longer than the data/);
  bad('1f 05 00', /long-form tag/);
  bad('9f 80 01 00', /shortest/);
  bad('01 01 01', /00 or FF/);
  bad('01 02 00 00', /00 or FF/);
  bad('02 00', /empty integer/);
  bad('02 02 00 7f', /redundant/);
  bad('02 02 ff 80', /redundant/);
  bad('03 00', /empty bit string/);
  bad('03 02 08 00', /padding/);
  bad('03 01 03', /padding/);
  bad('03 02 03 ff', /not zero/);
  bad('05 01 00', /null with content/);
  bad('06 00', /bad object identifier/);
  bad('06 03 2a 86 c8', /bad object identifier/);
  bad('06 03 2a 80 01', /shortest/);
  bad('22 03 02 01 01', /primitive/);
  bad('10 00', /must be constructed/);
  bad('02 01 05 00', /bytes after the value/);
  bad('', /ran out/);
  bad('30', /before the length/);
  bad('30 03 02 01', /longer than the data/);
  assert.throws(() => parseDer(Buffer.from('30 80'.replace(/ /g, '').repeat(1), 'hex')), DerError);
  let nested: Buffer = Buffer.from(hex('05 00'));
  for (let i = 0; i < 40; i++) nested = sequence(nested);
  assert.throws(() => parseDer(nested), /nested too deeply/);
  assert.equal(parseDer(nested, { maxDepth: 50 }).children.length, 1);
});

test('booleans, bit strings, nulls and sets are written canonically', () => {
  assert.deepEqual(boolean(true), hex('01 01 ff'));
  assert.deepEqual(boolean(false), hex('01 01 00'));
  assert.equal(asBoolean(parseDer(boolean(true))), true);
  assert.deepEqual(bitString(Buffer.from([0xa0]), 5), hex('03 02 05 a0'));
  assert.deepEqual(asBits(parseDer(bitString(Buffer.from([0xa0]), 5))), { bytes: Buffer.from([0xa0]), unused: 5 });
  assert.deepEqual(nullValue(), hex('05 00'));
  assert.deepEqual(set(integer(3), integer(1), integer(2)), hex('31 09 02 01 01 02 01 02 02 01 03'), 'SET OF elements sorted by encoding');
  assert.deepEqual(parseAll(Buffer.concat([integer(1), nullValue()])).map((n) => n.tag), [2, 5]);
});

test('times: UTCTime for 1950 to 2049, GeneralizedTime outside, and impossible dates refused', () => {
  assert.equal(time(new Date('2026-11-28T12:34:56Z')).toString('latin1'), '\x17\x0d261128123456Z');
  assert.equal(time(new Date('2049-12-31T23:59:59Z')).toString('latin1').slice(2), '491231235959Z');
  assert.equal(time(new Date('2050-01-01T00:00:00Z')).toString('latin1'), '\x18\x0f20500101000000Z');
  assert.equal(time(new Date('1949-12-31T23:59:59Z')).toString('latin1'), '\x18\x0f19491231235959Z');
  assert.equal(asTime(parseDer(time(new Date('2026-11-28T12:34:56Z')))).toISOString(), '2026-11-28T12:34:56.000Z');
  assert.equal(asTime(parseDer(Buffer.from('\x17\x0d500101000000Z', 'latin1'))).getUTCFullYear(), 1950, 'YY of 50 or more is 19YY');
  assert.equal(asTime(parseDer(Buffer.from('\x17\x0d490101000000Z', 'latin1'))).getUTCFullYear(), 2049);
  for (const t of ['\x17\x0d261301000000Z', '\x17\x0d260230000000Z', '\x17\x0d2611281234Z', '\x17\x0c261128123456', '\x17\x0d261128246000Z', '\x18\x0f20260230000000Z']) assert.throws(() => asTime(parseDer(Buffer.from(t, 'latin1'))), DerError, JSON.stringify(t));
});

test('strings: the character sets are enforced both ways', () => {
  assert.equal(asString(parseDer(utf8String('Zoë €'))), 'Zoë €');
  assert.equal(asString(parseDer(printableString("Ab 1'()+,-./:=?"))), "Ab 1'()+,-./:=?");
  assert.throws(() => printableString('a@b'), DerError);
  assert.throws(() => printableString('é'), DerError);
  assert.throws(() => ia5String('é'), DerError);
  assert.throws(() => asString(parseDer(hex('0c 02 c3 28'))), /not UTF-8/);
  assert.throws(() => asString(parseDer(hex('13 01 40'))), /outside its set/);
  assert.throws(() => asString(parseDer(hex('16 01 80'))), /non-ASCII/);
  assert.equal(asString(parseDer(hex('1e 04 00 41 20 ac'))), 'A€', 'BMPString');
  assert.throws(() => asString(parseDer(integer(1))), /expected a string/);
});

test('PEM armour is read strictly and written in 64-column lines', () => {
  const d = Buffer.alloc(100, 7);
  const pem = toPem('TEST DATA', d);
  assert.ok(pem.split('\n').slice(1, -2).every((l) => l.length <= 64));
  assert.deepEqual(fromPem(pem), [{ label: 'TEST DATA', der: d }]);
  assert.equal(fromPem(`${pem}${toPem('OTHER', d)}`).length, 2);
  assert.equal(fromPem(`${pem}${toPem('OTHER', d)}`, 'OTHER').length, 1);
  assert.deepEqual(fromPem('no armour here'), []);
  assert.throws(() => fromPem('-----BEGIN X-----\nAAA*\n-----END X-----'), /bad base64/);
  assert.throws(() => fromPem('-----BEGIN X-----\nAAAAA\n-----END X-----'), /bad base64/);
  assert.deepEqual(fromPem('-----BEGIN X-----\nAAAA\n-----END Y-----'), [], 'mismatched labels are not a block');
});

test('an OpenSSL server certificate: version, serial, names, validity, key, extensions', () => {
  const c = parseCertificate(der(SERVER));
  assert.equal(c.version, 3);
  assert.equal(c.serial > 0n, true);
  assert.equal(c.signatureAlgorithm, 'ecdsa-with-SHA256');
  assert.equal(c.subject, 'CN=example.org,O=Example\\, Inc.,L=Dayton,ST=Ohio,C=US');
  assert.equal(c.issuer, 'O=Example,CN=Test Attestation Root');
  assert.equal(c.notAfter.getUTCFullYear(), 2126);
  assert.deepEqual([c.publicKey.algorithm, c.publicKey.curve, c.publicKey.bits], ['ecPublicKey', 'prime256v1', 256]);
  assert.match(c.publicKey.sha256, /^[0-9a-f]{64}$/);
  assert.match(c.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([c.isCA, c.keyUsage, c.extKeyUsage], [false, ['digitalSignature', 'keyEncipherment'], ['serverAuth', 'clientAuth']]);
  assert.deepEqual(c.san, [
    { type: 'dns', value: 'example.org' },
    { type: 'dns', value: '*.example.org' },
    { type: 'ip', value: '192.0.2.7' },
    { type: 'ip', value: '2001:db8::1' },
    { type: 'email', value: 'ops@example.org' },
    { type: 'uri', value: 'https://example.org/id' },
  ]);
  assert.deepEqual(c.extensions.map((e) => [e.name, e.critical]), [['basicConstraints', true], ['keyUsage', true], ['extKeyUsage', false], ['subjectAltName', false], ['subjectKeyIdentifier', false], ['authorityKeyIdentifier', false]]);
  const root = parseCertificate(der(ROOT));
  assert.equal(root.isCA, true);
  assert.equal(c.authorityKeyId, root.subjectKeyId, 'the key identifiers chain');
  assert.match(c.subjectKeyId!, /^([0-9a-f]{2}:){19}[0-9a-f]{2}$/);
});

test('every certificate written back from its parsed tree is byte for byte what was read', () => {
  for (const pem of [ROOT, SERVER, ED]) {
    const d = der(pem);
    assert.deepEqual(rewrite(parseDer(d)), d);
  }
  assert.deepEqual(rewrite(parseDer(der(SERVER))).length, der(SERVER).length);
});

test('signatures: a certificate is checked against its issuer, the wrong issuer and a changed byte fail, Ed25519 works', () => {
  const root = parseCertificate(der(ROOT));
  const srv = parseCertificate(der(SERVER));
  assert.equal(signedBy(srv, root), true);
  assert.equal(signedBy(root, root), true, 'a self-signed root');
  assert.equal(signedBy(root, srv), false);
  const ed = parseCertificate(der(ED));
  assert.equal(ed.signatureAlgorithm, 'Ed25519');
  assert.equal(signedBy(ed, ed), true);
  assert.equal(signedBy(srv, ed), false, 'names do not line up');
  const tampered = Buffer.from(der(SERVER));
  const at = tampered.indexOf(Buffer.from('Dayton')) + 1;
  tampered[at] = tampered[at]! ^ 1;
  assert.equal(signedBy(parseCertificate(tampered), root), false, 'one changed byte in the signed part');
  assert.throws(() => parseCertificate(Buffer.concat([der(SERVER), Buffer.from([0])])), /after the value/);
});

test('hostname matching: exact, wildcard of one whole left-most label, IP addresses, and no common-name fallback', () => {
  const c = parseCertificate(der(SERVER));
  for (const h of ['example.org', 'EXAMPLE.org.', 'www.example.org', 'api.example.org']) assert.equal(matchesHostname(c, h), true, h);
  for (const h of ['a.b.example.org', 'example.com', 'xexample.org', '.example.org', 'example.org.evil.example']) assert.equal(matchesHostname(c, h), false, h);
  assert.equal(matchesHostname(c, '192.0.2.7'), true);
  assert.equal(matchesHostname(c, '2001:0db8:0:0:0:0:0:1'), true);
  assert.equal(matchesHostname(c, '192.0.2.8'), false);
  const ed = parseCertificate(der(ED));
  assert.equal(matchesHostname(ed, 'ed.example.org'), false, 'the CN names it but there is no SAN');
  const mk = (...dns: string[]) => ({ ...c, san: dns.map((value) => ({ type: 'dns' as const, value })) });
  assert.equal(matchesHostname(mk('*.com'), 'example.com'), false, 'a wildcard needs at least two labels after it');
  assert.equal(matchesHostname(mk('f*.example.org'), 'foo.example.org'), false, 'a partial-label wildcard');
  assert.equal(matchesHostname(mk('*.*.example.org'), 'a.b.example.org'), false);
  assert.equal(matchesHostname(mk('*.example.org'), 'example.org'), false);
});

test('validity windows', () => {
  const c = parseCertificate(der(SERVER));
  assert.deepEqual(validAt(c, new Date('2030-01-01T00:00:00Z')), { valid: true });
  assert.deepEqual(validAt(c, new Date('2020-01-01T00:00:00Z')), { valid: false, reason: 'not yet valid' });
  assert.deepEqual(validAt(c, new Date('2127-01-01T00:00:00Z')), { valid: false, reason: 'expired' });
});

test('names: escaping, multi-valued RDNs, unknown types as dotted OIDs, binary values as hex', () => {
  const name = sequence(
    set(sequence(oid('2.5.4.6'), printableString('US'))),
    set(sequence(oid('2.5.4.10'), utf8String(' lead, "quote" + plus; <x>')), sequence(oid('2.5.4.11'), utf8String('Unit'))),
    set(sequence(oid('1.2.3.4.5'), utf8String('custom'))),
    set(sequence(oid('2.5.4.3'), octetString(Buffer.from([1, 2])))),
  );
  assert.equal(nameToString(parseDer(name)), 'CN=#04020102,1.2.3.4.5=custom,OU=Unit+O=\\ lead\\, \\"quote\\" \\+ plus\\; \\<x\\>,C=US');
});

test('general names: every kind, and a bad IP length is refused', () => {
  const gn = sequence(implicit(2, Buffer.from('a.example')), implicit(7, Buffer.from([10, 0, 0, 1])), implicit(1, Buffer.from('x@y.z')), implicit(6, Buffer.from('http://q')), implicit(8, oid('1.2.3').subarray(2)), explicit(4, sequence(set(sequence(oid('2.5.4.3'), utf8String('dn'))))), tlv(2, true, 0, integer(1)));
  assert.deepEqual(generalNames(parseDer(gn)).map((g) => [g.type, g.value]), [['dns', 'a.example'], ['ip', '10.0.0.1'], ['email', 'x@y.z'], ['uri', 'http://q'], ['registeredId', '1.2.3'], ['dirName', 'CN=dn'], ['other', 'a003020101']]);
  assert.throws(() => generalNames(parseDer(sequence(implicit(7, Buffer.from([1, 2, 3]))))), /wrong length/);
  assert.equal(generalNames(parseDer(sequence(implicit(7, Buffer.from('20010db8000000000000000000000001', 'hex')), implicit(7, Buffer.from('20010db800000000000100000000 0001'.replace(' ', ''), 'hex')))))[1]!.value, '2001:db8::1:0:0:1');
});

test('a CSR built for ECDSA P-256, with a subject and a SAN list, parses back and proves possession', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const csr = buildCsr({ subject: [['C', 'US'], ['O', 'Example, Inc.'], ['CN', 'www.example.org']], san: [{ dns: 'www.example.org' }, { dns: 'example.org' }, { ip: '192.0.2.1' }, { ip: '2001:db8::2' }, { email: 'a@example.org' }, { uri: 'https://example.org/' }], privateKey });
  const p = parseCsr(csr);
  assert.equal(p.subject, 'CN=www.example.org,O=Example\\, Inc.,C=US');
  assert.deepEqual(p.san.map((s) => s.value), ['www.example.org', 'example.org', '192.0.2.1', '2001:db8::2', 'a@example.org', 'https://example.org/']);
  assert.deepEqual([p.signatureAlgorithm, p.publicKey.curve, p.selfSignatureValid], ['ecdsa-with-SHA256', 'prime256v1', true]);
  assert.deepEqual(rewrite(parseDer(csr)), csr, 'canonical DER');
  const t = Buffer.from(csr);
  const at = t.indexOf(Buffer.from('example.org')) + 1;
  t[at] = t[at]! ^ 1;
  assert.equal(parseCsr(t).selfSignatureValid, false, 'a changed request does not verify');
});

test('CSRs for RSA, P-384 and Ed25519 keys use the right algorithms, and the RSA size is read', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  const ed = generateKeyPairSync('ed25519').privateKey;
  const subject = [['CN', 'k.example.org']] as const;
  const a = parseCsr(buildCsr({ subject, privateKey: rsa }));
  assert.deepEqual([a.signatureAlgorithm, a.publicKey.algorithm, a.publicKey.bits, a.selfSignatureValid, a.san], ['sha256WithRSAEncryption', 'rsaEncryption', 2048, true, []]);
  const b = parseCsr(buildCsr({ subject, privateKey: p384 }));
  assert.deepEqual([b.signatureAlgorithm, b.publicKey.curve, b.selfSignatureValid], ['ecdsa-with-SHA384', 'secp384r1', true]);
  const c = parseCsr(buildCsr({ subject, privateKey: ed }));
  assert.deepEqual([c.signatureAlgorithm, c.publicKey.algorithm, c.selfSignatureValid], ['Ed25519', 'Ed25519', true]);
  const p521 = generateKeyPairSync('ec', { namedCurve: 'secp521r1' }).privateKey;
  assert.throws(() => buildCsr({ subject, privateKey: p521 }), /only RSA/);
});

test('an OpenSSL-made CSR with a SAN extension is read, and its signature checks', () => {
  const p = parseCsr(der(RSA_CSR));
  assert.equal(p.subject, 'O=Zed,CN=rsa.example.org');
  assert.deepEqual(p.san, [{ type: 'dns', value: 'rsa.example.org' }, { type: 'dns', value: 'www.rsa.example.org' }]);
  assert.deepEqual([p.publicKey.bits, p.signatureAlgorithm, p.selfSignatureValid], [2048, 'sha256WithRSAEncryption', true]);
});

test('OpenSSL accepts the CSR we build, and reads the same subject and SAN', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const csr = buildCsr({ subject: [['C', 'US'], ['O', 'Example'], ['CN', 'interop.example.org']], san: [{ dns: 'interop.example.org' }, { ip: '192.0.2.9' }, { email: 'x@example.org' }], privateKey });
  const dir = mkdtempSync(join(tmpdir(), 'asn1-'));
  try {
    const f = join(dir, 'r.csr');
    writeFileSync(f, toPem('CERTIFICATE REQUEST', csr));
    const v = spawnSync('openssl', ['req', '-in', f, '-verify', '-noout'], { encoding: 'utf8' });
    if (v.error) return;
    assert.equal(v.status, 0, v.stderr);
    assert.match(v.stderr + v.stdout, /verify OK/);
    const t = spawnSync('openssl', ['req', '-in', f, '-noout', '-text'], { encoding: 'utf8' }).stdout;
    assert.match(t, /Subject: C ?= ?US, O ?= ?Example, CN ?= ?interop\.example\.org/);
    assert.match(t, /DNS:interop\.example\.org, IP Address:192\.0\.2\.9, email:x@example\.org/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CSR inputs are checked: country length, non-ASCII SAN, bad IPs, empty requests, and a non-CSR is refused', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const base = { subject: [['CN', 'x']] as [string, string][], privateKey };
  assert.throws(() => buildCsr({ ...base, subject: [['C', 'USA']] }), /two letters/);
  assert.throws(() => buildCsr({ ...base, san: [{ dns: 'münchen.example' }] }), /ASCII/);
  assert.throws(() => buildCsr({ ...base, san: [{ ip: '300.1.1.1' }] }), /not an IP/);
  assert.throws(() => buildCsr({ ...base, subject: [['bogus', 'x']] }), /unknown object identifier name/);
  assert.throws(() => buildCsr({ subject: [], privateKey }), /subject or a SAN/);
  assert.throws(() => parseCsr(der(SERVER)), DerError);
  assert.equal(parseCsr(buildCsr({ subject: [['CN', 'ünïcode.example']], privateKey })).subject, 'CN=ünïcode.example');
  assert.equal(parseSpki(parseCertificate(der(ED)).publicKey.spki).algorithm, 'Ed25519');
});

test('UT constants and SAN extension are what the standard says', () => {
  assert.deepEqual([UT.sequence, UT.set, UT.oid, UT.utcTime], [16, 17, 6, 23]);
  assert.deepEqual(sanExtension([{ dns: 'a.b' }]), hex('30 05 82 03 61 2e 62'));
  assert.deepEqual(sanExtension([{ ip: '10.0.0.1' }, { email: 'a@b.c' }]), hex('30 0d 87 04 0a 00 00 01 81 05 61 40 62 2e 63'));
});

// ---------------------------------------------------------------- hostile inputs and boundaries

const derFails = (fn: () => unknown, why: RegExp, label?: string) => assert.throws(fn, (e: Error) => e instanceof DerError && why.test(e.message), label);
const nest = (k: number): Buffer => {
  let n: Buffer = nullValue();
  for (let i = 0; i < k; i++) n = sequence(n);
  return n;
};

test('depth limit: exactly 32 levels below the top are read, one more is refused, in parseDer and parseAll, with the caller limit honoured', () => {
  assert.equal(parseDer(nest(32)).raw.length, nest(32).length);
  derFails(() => parseDer(nest(33)), /^bad DER: nested too deeply$/);
  assert.equal(parseAll(nest(32)).length, 1);
  derFails(() => parseAll(nest(33)), /nested too deeply/);
  derFails(() => parseAll(nest(40)), /nested too deeply/, 'parseAll has the same default limit');
  assert.equal(parseAll(nest(40), { maxDepth: 50 }).length, 1);
  derFails(() => parseAll(nest(3), { maxDepth: 1 }), /nested too deeply/, 'a caller limit is used by parseAll');
  assert.equal(parseDer(nest(0), { maxDepth: 0 }).tag, 5);
  derFails(() => parseDer(nest(1), { maxDepth: 0 }), /nested too deeply/);
  assert.equal(parseDer(nest(2), { maxDepth: 2 }).children.length, 1);
  derFails(() => parseDer(nest(3), { maxDepth: 2 }), /nested too deeply/);
});

test('truncated and padded headers are refused with the reason, at the buffer end and at a constructed value end', () => {
  const why = (h: string) => {
    try {
      parseDer(hex(h));
    } catch (e) {
      return (e as Error).message;
    }
    return 'accepted';
  };
  assert.equal(why(''), 'bad DER: ran out of bytes');
  assert.equal(why('1f'), 'bad DER: ran out of bytes in a tag');
  assert.equal(why('1f 81'), 'bad DER: ran out of bytes in a tag');
  assert.equal(why('30 02 1f 81 05'), 'bad DER: ran out of bytes in a tag', 'the parent ends inside the tag although more bytes follow');
  assert.equal(why('30'), 'bad DER: ran out of bytes before the length');
  assert.equal(why('9f 81 80 80 80 00 00'), 'bad DER: a tag number that is too large');
  assert.equal(why('04 82 01'), 'bad DER: ran out of bytes in a length');
  assert.equal(why('04 81'), 'bad DER: ran out of bytes in a length');
  assert.equal(why('30 03 04 82 01'), 'bad DER: ran out of bytes in a length');
  assert.equal(why('04 81 80'), 'bad DER: a length longer than the data', 'a one byte length that ends exactly at the buffer end is fine until the value');
  assert.equal(why('04 84 01 00 00 00'), 'bad DER: a length longer than the data', 'four length bytes are allowed');
  assert.equal(why('04 85 01 00 00 00 00'), 'bad DER: a length of more than 4 bytes');
  assert.equal(why('02 01 05 00'), 'bad DER: 1 bytes after the value');
  assert.equal(why('02 01 05 00 00 00'), 'bad DER: 3 bytes after the value');
  assert.equal(why('30 02 04 05 00 00 00 00 00'), 'bad DER: a length longer than the data', 'a child that overruns its parent is an error');
});

test('long-form tags: 31 is the smallest, 4 tag bytes are the most, and a 0x80 continuation byte inside a tag is just a zero digit', () => {
  assert.equal(parseDer(hex('9f 1f 01 01')).tag, 31);
  derFails(() => parseDer(hex('9f 1e 00')), /long-form tag for a small number/);
  assert.equal(parseDer(hex('9f 81 80 01 00')).tag, 16385);
  assert.equal(parseDer(hex('9f 81 80 80 00 00')).tag, 2097152, 'four tag bytes');
  derFails(() => parseDer(hex('9f 81 80 80 80 00 00')), /tag number that is too large/, 'five tag bytes');
  derFails(() => parseDer(hex('9f 80 01 00')), /shortest/);
  const t = parseDer(tlv(2, true, 2097152, Buffer.alloc(0)));
  assert.equal(t.tag, 2097152);
});

test('primitives that are valid at their edges: booleans, bit strings, sets, OID first bytes, children of primitives', () => {
  assert.equal(asBoolean(parseDer(hex('01 01 00'))), false);
  assert.equal(asBoolean(parseDer(hex('01 01 ff'))), true);
  assert.deepEqual(asBits(parseDer(hex('03 02 07 80'))), { bytes: Buffer.from([0x80]), unused: 7 });
  assert.deepEqual(asBits(parseDer(hex('03 01 00'))), { bytes: Buffer.alloc(0), unused: 0 }, 'an empty bit string');
  assert.deepEqual(asBits(parseDer(hex('03 02 00 ff'))).unused, 0);
  derFails(() => parseDer(hex('03 02 08 00')), /padding/);
  derFails(() => parseDer(hex('03 03 04 ff f1')), /not zero/);
  assert.equal(parseDer(hex('03 03 04 ff f0')).content.length, 3);
  derFails(() => parseDer(hex('11 00')), /must be constructed/, 'a primitive SET');
  derFails(() => parseDer(hex('06 02 80 01')), /shortest/, 'an OID that begins with a padded arc');
  assert.deepEqual(parseDer(integer(1)).children, []);
  assert.deepEqual(parseDer(octetString(Buffer.from('ab'))).children, []);
  assert.equal(parseDer(sequence(integer(1))).children.length, 1);
});

test('the typed readers refuse a context-tagged node that carries a universal tag number', () => {
  derFails(() => asInteger(parseDer(hex('82 01 05'))), /expected an INTEGER/);
  derFails(() => asInteger(parseDer(nullValue())), /expected an INTEGER/);
  derFails(() => asBoolean(parseDer(hex('81 01 ff'))), /expected a BOOLEAN/);
  derFails(() => asOctets(parseDer(hex('84 00'))), /expected an OCTET STRING/);
  derFails(() => asBits(parseDer(hex('83 02 00 ff'))), /expected a BIT STRING/);
  derFails(() => asOid(parseDer(hex('86 01 2a'))), /expected an OBJECT IDENTIFIER/);
  derFails(() => asTime(parseDer(Buffer.concat([hex('97 0d'), Buffer.from('261128123456Z', 'latin1')]))), /^bad DER: expected a time$/, 'a context [23] is not a UTCTime');
  derFails(() => asTime(parseDer(integer(1))), /^bad DER: expected a time$/);
  derFails(() => asString(parseDer(hex('8c 01 41'))), /^bad DER: expected a string$/, 'a context [12] is not a UTF8String');
  derFails(() => asString(parseDer(hex('0a 01 41'))), /^bad DER: expected a string$/);
});

test('object identifiers: first-arc split at 40 and 80, two-arc values, and every refusal says so', () => {
  for (const d of ['0.0', '0.39', '1.0', '1.39', '2.0', '2.47', '2.999', '1.2', '0.1.2']) assert.equal(asOid(parseDer(oid(d))), d, d);
  assert.equal(oid('1.2').toString('hex'), '06012a');
  assert.equal(oid('1.39').toString('hex'), '06014f');
  assert.equal(oid('0.39').toString('hex'), '060127');
  assert.equal(oid('2.0').toString('hex'), '060150');
  assert.equal(oid('1.0').toString('hex'), '060128');
  assert.equal(asOid(parseDer(hex('06 01 27'))), '0.39');
  assert.equal(asOid(parseDer(hex('06 01 28'))), '1.0');
  assert.equal(asOid(parseDer(hex('06 01 4f'))), '1.39');
  assert.equal(asOid(parseDer(hex('06 01 50'))), '2.0');
  for (const b of ['1.40', '3.1', '1', 'a.b', '1.02']) derFails(() => oid(b), /is not an object identifier/, b);
  derFails(() => oid('1'), /"1" is not an object identifier/);
  derFails(() => oid('1.x'), /"1.x" is not an object identifier/);
});

test('names of object identifiers: the whole table, and the dotted-or-name lookup is anchored', () => {
  assert.deepEqual(OID, {
    '1.2.840.113549.1.1.1': 'rsaEncryption',
    '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
    '1.2.840.113549.1.1.10': 'rsassaPss',
    '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
    '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
    '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
    '1.2.840.10045.2.1': 'ecPublicKey',
    '1.2.840.10045.3.1.7': 'prime256v1',
    '1.3.132.0.34': 'secp384r1',
    '1.3.132.0.35': 'secp521r1',
    '1.2.840.10045.4.1': 'ecdsa-with-SHA1',
    '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256',
    '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
    '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
    '1.3.101.110': 'X25519',
    '1.3.101.112': 'Ed25519',
    '1.3.101.113': 'Ed448',
    '2.5.4.3': 'CN',
    '2.5.4.4': 'SN',
    '2.5.4.5': 'serialNumber',
    '2.5.4.6': 'C',
    '2.5.4.7': 'L',
    '2.5.4.8': 'ST',
    '2.5.4.9': 'street',
    '2.5.4.10': 'O',
    '2.5.4.11': 'OU',
    '2.5.4.12': 'title',
    '2.5.4.42': 'GN',
    '1.2.840.113549.1.9.1': 'emailAddress',
    '0.9.2342.19200300.100.1.25': 'DC',
    '2.5.29.14': 'subjectKeyIdentifier',
    '2.5.29.15': 'keyUsage',
    '2.5.29.17': 'subjectAltName',
    '2.5.29.19': 'basicConstraints',
    '2.5.29.31': 'cRLDistributionPoints',
    '2.5.29.32': 'certificatePolicies',
    '2.5.29.35': 'authorityKeyIdentifier',
    '2.5.29.37': 'extKeyUsage',
    '1.3.6.1.5.5.7.1.1': 'authorityInfoAccess',
    '1.3.6.1.5.5.7.3.1': 'serverAuth',
    '1.3.6.1.5.5.7.3.2': 'clientAuth',
    '1.3.6.1.5.5.7.3.3': 'codeSigning',
    '1.3.6.1.5.5.7.3.4': 'emailProtection',
    '1.3.6.1.5.5.7.3.8': 'timeStamping',
    '1.3.6.1.5.5.7.3.9': 'OCSPSigning',
    '1.2.840.113549.1.9.14': 'extensionRequest',
    '1.2.840.113549.1.9.7': 'challengePassword',
  });
  for (const [dotted, name] of Object.entries(OID)) assert.equal(oidOf(name), dotted, name);
  assert.equal(oidName('9.9.9'), '9.9.9');
  assert.equal(oidOf('10.2'), '10.2');
  for (const x of ['x1.2', '1.2x', ' 1.2', '1.2 ', '1', '1.', '.1.2', 'a.b']) derFails(() => oidOf(x), /unknown object identifier name/, JSON.stringify(x));
  derFails(() => oidOf('nope'), /unknown object identifier name "nope"/);
});

test('strings at their edges: IA5 and printable limits, T.61 as Latin-1, BMP parity, and the messages', () => {
  assert.equal(asString(parseDer(hex('16 02 41 7f'))), 'A\x7f');
  assert.equal(asString(parseDer(hex('16 00'))), '');
  derFails(() => asString(parseDer(hex('16 02 41 80'))), /non-ASCII/, 'one high byte after an ASCII one');
  assert.equal(asString(parseDer(hex('14 02 c3 a9'))), 'Ã©', 'T.61 is read as Latin-1');
  derFails(() => asString(parseDer(hex('1e 03 00 41 00'))), /BMPString of odd length/);
  assert.equal(asString(parseDer(hex('1e 00'))), '');
  assert.deepEqual(ia5String('ab'), hex('16 02 61 62'));
  assert.deepEqual(ia5String(''), hex('16 00'));
  assert.deepEqual(ia5String('a\x7f'), hex('16 02 61 7f'));
  derFails(() => ia5String('é'), /not an IA5String/);
  derFails(() => ia5String('a\u0080'), /not an IA5String/);
  derFails(() => printableString('a@b'), /not a PrintableString/);
  assert.deepEqual(printableString(''), hex('13 00'));
  assert.deepEqual(utf8String('é'), hex('0c 02 c3 a9'));
});

test('times: the two forms refuse padding and suffixes, and every field boundary is exact', () => {
  const u = (s: string) => Buffer.concat([Buffer.from([0x17, s.length]), Buffer.from(s, 'latin1')]);
  const g = (s: string) => Buffer.concat([Buffer.from([0x18, s.length]), Buffer.from(s, 'latin1')]);
  derFails(() => asTime(parseDer(u('x261128123456Z'))), /UTCTime must be/, 'a prefix');
  derFails(() => asTime(parseDer(u('261128123456Zx'))), /UTCTime must be/, 'a suffix');
  derFails(() => asTime(parseDer(g('x20261128123456Z'))), /GeneralizedTime must be/, 'a prefix');
  derFails(() => asTime(parseDer(g('20261128123456Zx'))), /GeneralizedTime must be/, 'a suffix');
  derFails(() => asTime(parseDer(g('202611281234Z'))), /GeneralizedTime must be/);
  assert.equal(asTime(parseDer(g('20261128123456Z'))).toISOString(), '2026-11-28T12:34:56.000Z');
  assert.equal(asTime(parseDer(u('991231235959Z'))).toISOString(), '1999-12-31T23:59:59.000Z');
  assert.equal(asTime(parseDer(u('260101000000Z'))).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(asTime(parseDer(u('240229000000Z'))).toISOString(), '2024-02-29T00:00:00.000Z');
  assert.equal(asTime(parseDer(u('261128235959Z'))).getUTCHours(), 23, 'hour 23, minute 59, second 59 are the largest');
  const refused = ['250229000000Z', '260431000000Z', '260100000000Z', '260132000000Z', '261128240000Z', '261128126000Z', '261128125960Z', '261128125961Z', '260001000000Z'];
  for (const t of refused) derFails(() => asTime(parseDer(u(t))), /not a real date/, t);
  derFails(() => asTime(parseDer(g('00500101000000Z'))), /not a real date/, 'year 0050 is not read as 1950');
  derFails(() => asTime(parseDer(g('20261128126000Z'))), /not a real date/);
  assert.equal(asTime(parseDer(g('09990101000000Z'))).getUTCFullYear(), 999);
});

test('writing: the 1950 boundary, years before 1000, IA5 and negative integers across every byte width', () => {
  assert.equal(time(new Date('1950-01-01T00:00:00Z')).toString('latin1'), '\x17\x0d500101000000Z');
  const d = new Date(0);
  d.setUTCFullYear(999);
  assert.equal(time(d).toString('latin1'), '\x18\x0f09990101000000Z');
  assert.equal(asTime(parseDer(time(d))).getUTCFullYear(), 999);
  const vals: bigint[] = [];
  for (let v = -600n; v <= 600n; v++) vals.push(v);
  for (const k of [15n, 16n, 23n, 24n, 31n, 32n, 63n, 64n]) for (const dv of [-2n, -1n, 0n, 1n, 2n]) vals.push(2n ** k + dv, -(2n ** k) + dv);
  for (const v of vals) assert.equal(asInteger(parseDer(integer(v))), v, String(v));
  assert.equal(integer(-300).toString('hex'), '0202fed4');
  assert.equal(integer(-32769).toString('hex'), '0203ff7fff');
  assert.equal(integer(-65536).toString('hex'), '0203ff0000');
  assert.equal(integer(-256).toString('hex'), '0202ff00');
});

test('PEM: exact framing, padding-free bodies, empty bodies, and the label filter returns the right blocks', () => {
  const d = Buffer.alloc(100, 7);
  const pem = toPem('X', d);
  const lines = pem.split('\n');
  assert.deepEqual(lines.map((l) => l.length), ['-----BEGIN X-----'.length, 64, 64, 8, '-----END X-----'.length, 0]);
  assert.equal(toPem('X', Buffer.alloc(0)), '-----BEGIN X-----\n\n-----END X-----\n');
  assert.equal(toPem('X', Buffer.alloc(48, 1)).split('\n').length, 4, '48 bytes are exactly one 64-column line');
  for (const n of [3, 6, 99, 102]) assert.deepEqual(fromPem(toPem('X', Buffer.alloc(n, 9))), [{ label: 'X', der: Buffer.alloc(n, 9) }], `${n} bytes, no padding`);
  assert.deepEqual(fromPem('-----BEGIN X-----\n-----END X-----'), [{ label: 'X', der: Buffer.alloc(0) }]);
  const two = `${toPem('ONE', Buffer.from([1]))}${toPem('TWO', Buffer.from([2]))}`;
  assert.deepEqual(fromPem(two, 'TWO').map((b) => b.label), ['TWO']);
  assert.deepEqual(fromPem(two, 'ONE').map((b) => b.der.toString('hex')), ['01']);
  assert.deepEqual(fromPem(two, 'THREE'), []);
});

test('names: a trailing space is escaped, a universal tag in a general name is refused, and the messages say what was expected', () => {
  assert.equal(nameToString(parseDer(sequence(set(sequence(oid('2.5.4.3'), utf8String('a ')))))), 'CN=a\\ ');
  assert.equal(nameToString(parseDer(sequence(set(sequence(oid('2.5.4.3'), utf8String('#a')))))), 'CN=\\#a');
  derFails(() => generalNames(parseDer(sequence(integer(1)))), /a general name without a context tag/);
  derFails(() => generalNames(parseDer(sequence(tlv(1, false, 2, Buffer.from('x'))))), /without a context tag/, 'an APPLICATION tag is not context');
  derFails(() => generalNames(parseDer(integer(1))), /expected a GeneralNames/);
  derFails(() => nameToString(parseDer(integer(1))), /expected a Name/);
  derFails(() => nameToString(parseDer(sequence(integer(1)))), /expected an RDN/);
});

// Compare with what RFC 5952 prints, through the SAN reader (print) and the hostname matcher (parse).
test('IPv6: addresses are printed and matched the RFC 5952 way, for every placement of the zero run', () => {
  const cases: [string, string][] = [
    ['20010db8000100020003000400050006', '2001:db8:1:2:3:4:5:6'],
    ['00000000000000000000000000000001', '::1'],
    ['00000000000000000000000000000000', '::'],
    ['00010000000000000000000000000000', '1::'],
    ['00010000000200030004000500060007', '1:0:2:3:4:5:6:7'],
    ['00010002000000000000000000030004', '1:2::3:4'],
    ['00010002000300040005000600000000', '1:2:3:4:5:6::'],
    ['00000000000000010000000000000002', '::1:0:0:0:2'],
    ['00000000000000010000000000020003', '::1:0:0:2:3'],
    ['00010000000000020000000000000003', '1:0:0:2::3'],
    ['00000000000000000000ffffc0000201', '::ffff:c000:201'],
  ];
  const c = parseCertificate(der(SERVER));
  for (const [h, text] of cases) {
    const g = generalNames(parseDer(sequence(implicit(7, hex(h)))))[0]!;
    assert.equal(g.value, text, h);
    assert.equal(matchesHostname({ ...c, san: [g] }, text), true, `host ${text}`);
  }
  const all = cases.map(([h]) => generalNames(parseDer(sequence(implicit(7, hex(h)))))[0]!);
  for (const [, text] of cases) assert.equal(matchesHostname({ ...c, san: all.filter((g) => g.value !== text) }, text), false, `${text} matches only itself`);
});

test('IPv6 literals with an embedded IPv4 tail are the address they say, not a garbled one', () => {
  const c = parseCertificate(der(SERVER));
  const ip = (h: string) => ({ ...c, san: generalNames(parseDer(sequence(implicit(7, hex(h))))) });
  assert.equal(matchesHostname(ip('00000000000000000000ffffc0000201'), '::ffff:192.0.2.1'), true);
  assert.equal(matchesHostname(ip('00000000000000000000ffffc0000202'), '::ffff:192.0.2.1'), false);
  assert.equal(matchesHostname(ip('00000000000000000000ffff00000001'), '::ffff:1.2.3.4'), false, 'a dotted tail must not be read as its first number');
  assert.equal(matchesHostname(ip('00000000000000000000ffff01020304'), '::ffff:1.2.3.4'), true);
  assert.equal(matchesHostname(ip('20010db8000000000000000000000001'), '2001:db8::1.2.3.4'), false);
});

test('hostnames: only dNSName entries match a name, only iPAddress entries match an address, and wildcards stay in their label', () => {
  const c = parseCertificate(der(SERVER));
  const mk = (...san: { type: 'dns' | 'ip' | 'email' | 'uri'; value: string }[]) => ({ ...c, san });
  assert.equal(matchesHostname(mk({ type: 'dns', value: '192.0.2.7' }), '192.0.2.7'), false, 'an IP address is not matched by a DNS entry');
  assert.equal(matchesHostname(mk({ type: 'email', value: 'example.org' }), 'example.org'), false);
  assert.equal(matchesHostname(mk({ type: 'uri', value: 'example.org' }), 'example.org'), false);
  assert.equal(matchesHostname(mk({ type: 'ip', value: 'example.org' }), 'example.org'), false);
  assert.equal(matchesHostname(mk({ type: 'dns', value: 'example.org.' }), 'example.org'), true, 'a trailing dot on the entry is ignored');
  assert.equal(matchesHostname(mk({ type: 'dns', value: 'example.org' }), 'example.org.'), true);
  assert.equal(matchesHostname(mk({ type: 'dns', value: '*.example.org' }), 'zzzzzzzzzzzzzzzz'), false, 'a long dotless name is not a wildcard match');
  assert.equal(matchesHostname(mk({ type: 'dns', value: '*.example.org' }), 'zzzzzzzzzzzzzzzz.org'), false);
  assert.equal(matchesHostname(mk({ type: 'dns', value: '*.*.example.org' }), 'a.*.example.org'), false);
  assert.equal(matchesHostname(mk({ type: 'dns', value: '*.a*.example.org' }), 'x.a*.example.org'), false);
  assert.equal(matchesHostname(mk({ type: 'dns', value: '*.example.org' }), 'a.example.org'), true);
  assert.equal(matchesHostname(mk({ type: 'dns', value: '*.example.org' }), '.example.org'), false);
});

test('validity: both ends of the window are inside it', () => {
  const c = parseCertificate(der(SERVER));
  assert.deepEqual(validAt(c, c.notBefore), { valid: true });
  assert.deepEqual(validAt(c, c.notAfter), { valid: true });
  assert.deepEqual(validAt(c, new Date(c.notBefore.getTime() - 1)), { valid: false, reason: 'not yet valid' });
  assert.deepEqual(validAt(c, new Date(c.notAfter.getTime() + 1)), { valid: false, reason: 'expired' });
});

// ---------------------------------------------------------------- certificates built by hand

const ecPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecSpki = Buffer.from(ecPair.publicKey.export({ type: 'spki', format: 'der' }));
const ECDSA256 = sequence(oid('1.2.840.10045.4.3.2'));
const cn = (v: string) => sequence(set(sequence(oid('2.5.4.3'), utf8String(v))));
const ext = (id: string, value: Buffer, critical = false) => sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
interface Parts {
  version?: Buffer[];
  fields?: Buffer[];
  between?: Buffer[];
  exts?: Buffer[];
  outerAlg?: Buffer;
  top?: Buffer[];
}
const goodFields = (): Buffer[] => [integer(7), ECDSA256, cn('the issuer'), sequence(time(new Date('2020-01-01T00:00:00Z')), time(new Date('2030-01-01T00:00:00Z'))), cn('the subject'), ecSpki];
function mkTbs(p: Parts = {}): Buffer {
  return sequence(...(p.version ?? [explicit(0, integer(2))]), ...(p.fields ?? goodFields()), ...(p.between ?? []), ...(p.exts ? [explicit(3, sequence(...p.exts))] : []));
}
const mkCert = (p: Parts = {}): Buffer => sequence(...(p.top ?? [mkTbs(p), p.outerAlg ?? ECDSA256, bitString(Buffer.alloc(8, 1))]));
const withExt = (...exts: Buffer[]) => parseCertificate(mkCert({ exts }));

test('a version 1 certificate has no extensions and no version field, and parses with empty lists', () => {
  const c = parseCertificate(mkCert({ version: [] }));
  assert.equal(c.version, 1);
  assert.equal(c.serial, 7n);
  assert.equal(c.subject, 'CN=the subject');
  assert.equal(c.issuer, 'CN=the issuer');
  assert.deepEqual([c.extensions, c.keyUsage, c.extKeyUsage, c.san], [[], [], [], []]);
  assert.deepEqual([c.isCA, c.pathLen, c.subjectKeyId, c.authorityKeyId], [undefined, undefined, undefined, undefined]);
  assert.equal(parseCertificate(mkCert()).version, 3);
  assert.deepEqual(parseCertificate(mkCert()).extensions, []);
  const ed = parseCertificate(der(ED));
  assert.deepEqual([ed.keyUsage, ed.extKeyUsage, ed.san], [[], [], []]);
});

test('the version field is only a context [0]; anything else in first place is not a version', () => {
  derFails(() => parseCertificate(mkCert({ version: [tlv(1, true, 0, integer(2))] })), /./, 'an APPLICATION [0] is not a version');
  derFails(() => parseCertificate(mkCert({ version: [tlv(2, true, 1, integer(2))] })), /./, 'a context [1] is not a version');
  derFails(() => parseCertificate(mkCert({ version: [tlv(0, true, 0, integer(2))] })), /./, 'a universal 0 is not a version');
  assert.equal(parseCertificate(mkCert({ version: [explicit(0, integer(1))] })).version, 2);
  assert.equal(parseCertificate(mkCert({ version: [explicit(0, integer(0))] })).version, 1);
  derFails(() => parseCertificate(mkCert({ version: [explicit(0, integer(3))] })), /unknown certificate version/);
  derFails(() => parseCertificate(mkCert({ version: [explicit(0, integer(-1))] })), /unknown certificate version/);
  derFails(() => parseCertificate(mkCert({ version: [explicit(0, integer(99))] })), /unknown certificate version/);
});

test('a certificate with missing or surplus parts is refused with a DerError, not a crash', () => {
  const fields = goodFields();
  for (let k = 0; k < 6; k++) derFails(() => parseCertificate(mkCert({ fields: fields.slice(0, k) })), /TBSCertificate is missing fields/, `${k} fields`);
  const tbs = mkTbs();
  derFails(() => parseCertificate(mkCert({ top: [] })), /Certificate has three parts/);
  derFails(() => parseCertificate(mkCert({ top: [tbs] })), /Certificate has three parts/);
  derFails(() => parseCertificate(mkCert({ top: [tbs, ECDSA256] })), /Certificate has three parts/);
  derFails(() => parseCertificate(mkCert({ top: [tbs, ECDSA256, bitString(Buffer.alloc(1)), nullValue()] })), /Certificate has three parts/, 'four parts');
  derFails(() => parseCertificate(mkCert({ top: [integer(1), ECDSA256, bitString(Buffer.alloc(1))] })), /expected TBSCertificate/);
  derFails(() => parseCertificate(mkCert({ top: [tbs, integer(1), bitString(Buffer.alloc(1))] })), /expected an AlgorithmIdentifier/);
  derFails(() => parseCertificate(mkCert({ outerAlg: sequence(oid('1.2.840.10045.4.3.3')) })), /two signature algorithm fields differ/);
  derFails(() => parseCertificate(mkCert({ fields: [integer(7), sequence(oid('1.2.840.10045.4.3.3')), ...goodFields().slice(2)] })), /two signature algorithm fields differ/);
});

test('the extensions are found at [3] among other trailing fields, once each', () => {
  const kuSig = ext('2.5.29.15', bitString(Buffer.from([0x80]), 7), true);
  const between = [implicit(1, Buffer.from([0, 0xaa])), implicit(2, Buffer.from([0, 0xbb])), bitString(Buffer.from([1])), tlv(1, true, 3, sequence()), tlv(2, true, 5, sequence())];
  const c = parseCertificate(mkCert({ between, exts: [kuSig] }));
  assert.deepEqual(c.keyUsage, ['digitalSignature']);
  assert.deepEqual(c.extensions.map((e) => [e.name, e.critical]), [['keyUsage', true]]);
  derFails(() => withExt(ext('2.5.29.17', sanExtension([{ dns: 'a' }])), ext('2.5.29.17', sanExtension([{ dns: 'b' }]))), /the extension 2\.5\.29\.17 appears twice/);
  derFails(() => withExt(kuSig, ext('2.5.29.17', sanExtension([{ dns: 'a' }])), kuSig), /appears twice/);
  assert.deepEqual(parseCertificate(mkCert({ exts: [] })).extensions, []);
  assert.deepEqual(parseCertificate(mkCert({ between: [tlv(2, true, 3, Buffer.alloc(0))] })).extensions, [], 'an empty [3] carries no extensions');
});

test('basic constraints: the CA flag and the path length each come only from what is there', () => {
  const bc = (...items: Buffer[]) => withExt(ext('2.5.29.19', sequence(...items), true));
  const a = bc(boolean(true), integer(3));
  assert.deepEqual([a.isCA, a.pathLen], [true, 3]);
  const b = bc(integer(0));
  assert.deepEqual([b.isCA, b.pathLen], [false, 0]);
  const c = bc();
  assert.deepEqual([c.isCA, c.pathLen], [false, undefined]);
  const d = bc(boolean(true));
  assert.deepEqual([d.isCA, d.pathLen], [true, undefined]);
  const e = bc(boolean(false), integer(12));
  assert.deepEqual([e.isCA, e.pathLen], [false, 12]);
});

test('key usage names, every bit in order, and no name for a bit past the list', () => {
  const names = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];
  const ku = (bytes: number[], unused: number) => withExt(ext('2.5.29.15', bitString(Buffer.from(bytes), unused))).keyUsage;
  assert.deepEqual(ku([0xff, 0x80], 7), names);
  assert.deepEqual(ku([0xff, 0xc0], 6), names, 'bit 9 has no name');
  assert.deepEqual(ku([0xff, 0xff], 0), names, 'bits 9 to 15 have no name');
  assert.deepEqual(ku([0xff, 0x80, 0xff], 0), names, 'bits past the second byte have no name');
  assert.deepEqual(ku([0x06], 1), ['keyCertSign', 'cRLSign']);
  assert.deepEqual(ku([0x80], 7), ['digitalSignature']);
  assert.deepEqual(ku([0x00, 0x80], 7), ['decipherOnly']);
  assert.deepEqual(ku([0x00, 0x80], 0), ['decipherOnly']);
  assert.deepEqual(ku([], 0).length, 0);
  assert.deepEqual(ku([0xa0], 5), ['digitalSignature', 'keyEncipherment']);
});

test('extended key usage and key identifiers: the names, and the right element of the authority key identifier', () => {
  const eku = withExt(ext('2.5.29.37', sequence(...['1.3.6.1.5.5.7.3.3', '1.3.6.1.5.5.7.3.4', '1.3.6.1.5.5.7.3.8', '1.3.6.1.5.5.7.3.9', '1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2', '1.2.3'].map(oid)))).extKeyUsage;
  assert.deepEqual(eku, ['codeSigning', 'emailProtection', 'timeStamping', 'OCSPSigning', 'serverAuth', 'clientAuth', '1.2.3']);
  assert.equal(withExt(ext('2.5.29.14', octetString(Buffer.alloc(0)))).subjectKeyId, '');
  assert.equal(withExt(ext('2.5.29.14', octetString(Buffer.from([1, 0xab])))).subjectKeyId, '01:ab');
  const aki = (...items: Buffer[]) => withExt(ext('2.5.29.35', sequence(...items))).authorityKeyId;
  assert.equal(aki(implicit(0, Buffer.from([0xab, 0xcd]))), 'ab:cd');
  assert.equal(aki(tlv(2, true, 1, Buffer.alloc(0)), implicit(2, Buffer.from([5])), implicit(0, Buffer.from([0xab, 0xcd]))), 'ab:cd', 'the key identifier is [0], wherever it is');
  assert.equal(aki(tlv(1, false, 0, Buffer.from([1])), implicit(0, Buffer.from([0xab, 0xcd]))), 'ab:cd', 'an APPLICATION [0] is not the key identifier');
  assert.equal(aki(implicit(2, Buffer.from([5]))), undefined, 'no key identifier, no value');
  assert.equal(aki(), undefined);
});

test('the public key reader: sizes by algorithm, the curve only for EC keys with an OID parameter', () => {
  assert.equal(parseCertificate(der(ED)).publicKey.bits, 256);
  assert.equal(parseCertificate(der(ED)).publicKey.curve, undefined);
  const x = parseSpki(sequence(sequence(oid('1.3.101.110')), bitString(Buffer.alloc(32, 1))));
  assert.deepEqual([x.algorithm, x.curve, x.bits], ['X25519', undefined, undefined]);
  const odd = parseSpki(sequence(sequence(oid('1.3.101.110'), oid('1.2.840.10045.3.1.7')), bitString(Buffer.alloc(32, 1))));
  assert.deepEqual([odd.curve, odd.bits], [undefined, undefined], 'an OID parameter on a non-EC key is not a curve');
  const rsaOdd = parseSpki(sequence(sequence(oid('1.2.840.10045.2.1'), nullValue()), bitString(Buffer.alloc(4, 1))));
  assert.deepEqual([rsaOdd.algorithm, rsaOdd.curve, rsaOdd.bits], ['ecPublicKey', undefined, undefined], 'a NULL parameter on an EC key is not a curve');
  const ec = parseSpki(ecSpki);
  assert.deepEqual([ec.algorithm, ec.curve, ec.bits], ['ecPublicKey', 'prime256v1', 256]);
  const rsa = (modulus: bigint) => parseSpki(sequence(sequence(oid('1.2.840.113549.1.1.1'), nullValue()), bitString(sequence(integer(modulus), integer(65537)))));
  assert.equal(rsa((1n << 2047n) | 1n).bits, 2048, 'a modulus with its top bit set has a leading zero byte');
  assert.equal(rsa((1n << 2047n) - 1n).bits, 2048, 'a modulus without the zero byte counts all its bytes');
  derFails(() => parseSpki(sequence(sequence(oid('1.2.840.113549.1.1.1'), nullValue()), bitString(sequence(nullValue())))), /expected the modulus/);
});

// ---------------------------------------------------------------- signatures and requests

test('signature checks: each hash is the one the algorithm names, and SHA-1 and unknown algorithms are refused unless SHA-1 is asked for', () => {
  const data = Buffer.from('the signed bytes');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaSpki = rsa.publicKey.export({ type: 'spki', format: 'der' });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const ecDer = ec.publicKey.export({ type: 'spki', format: 'der' });
  const check = (alg: string, hash: string, key: typeof rsa.privateKey, spki: Uint8Array) => {
    const sig = cryptoSign(hash, data, key);
    assert.equal(checkSignature(alg, data, sig, spki), true, alg);
    assert.equal(checkSignature(alg, Buffer.from('other bytes'), sig, spki), false, `${alg} over other bytes`);
  };
  check('sha256WithRSAEncryption', 'sha256', rsa.privateKey, rsaSpki);
  check('sha384WithRSAEncryption', 'sha384', rsa.privateKey, rsaSpki);
  check('sha512WithRSAEncryption', 'sha512', rsa.privateKey, rsaSpki);
  check('ecdsa-with-SHA256', 'sha256', ec.privateKey, ecDer);
  check('ecdsa-with-SHA384', 'sha384', ec.privateKey, ecDer);
  check('ecdsa-with-SHA512', 'sha512', ec.privateKey, ecDer);
  assert.equal(checkSignature('sha384WithRSAEncryption', data, cryptoSign('sha256', data, rsa.privateKey), rsaSpki), false, 'the wrong hash does not verify');
  const sha1Rsa = cryptoSign('sha1', data, rsa.privateKey);
  const sha1Ec = cryptoSign('sha1', data, ec.privateKey);
  derFails(() => checkSignature('sha1WithRSAEncryption', data, sha1Rsa, rsaSpki), /^bad DER: the signature algorithm sha1WithRSAEncryption is not accepted$/);
  derFails(() => checkSignature('sha1WithRSAEncryption', data, sha1Rsa, rsaSpki, {}), /not accepted/);
  derFails(() => checkSignature('sha1WithRSAEncryption', data, sha1Rsa, rsaSpki, { allowSha1: false }), /not accepted/);
  derFails(() => checkSignature('ecdsa-with-SHA1', data, sha1Ec, ecDer), /^bad DER: the signature algorithm ecdsa-with-SHA1 is not accepted$/);
  assert.equal(checkSignature('sha1WithRSAEncryption', data, sha1Rsa, rsaSpki, { allowSha1: true }), true);
  assert.equal(checkSignature('sha1WithRSAEncryption', Buffer.from('x'), sha1Rsa, rsaSpki, { allowSha1: true }), false);
  assert.equal(checkSignature('ecdsa-with-SHA1', data, sha1Ec, ecDer, { allowSha1: true }), true);
  assert.equal(checkSignature('ecdsa-with-SHA1', Buffer.from('x'), sha1Ec, ecDer, { allowSha1: true }), false);
  for (const alg of ['rsassaPss', '1.2.3.4', 'ecdsa-with-SHA224', '', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    derFails(() => checkSignature(alg, data, sha1Rsa, rsaSpki, { allowSha1: true }), /is not accepted/, `${JSON.stringify(alg)} with SHA-1 allowed`);
    derFails(() => checkSignature(alg, data, sha1Rsa, rsaSpki), /is not accepted/, JSON.stringify(alg));
  }
});

const attr = (type: string, ...values: Buffer[]) => sequence(oid(type), set(...values));
/** A CertificationRequest assembled by hand and signed properly, so only what the test varies is unusual. */
function rawCsr(o: { attrs?: Buffer[] | null; algId?: Buffer; version?: bigint; top?: (info: Buffer, algId: Buffer, sig: Buffer) => Buffer[] } = {}): Buffer {
  const attrs = o.attrs === undefined ? [] : o.attrs;
  const info = sequence(integer(o.version ?? 0n), cn('csr subject'), ecSpki, ...(attrs === null ? [] : [tlv(2, true, 0, Buffer.concat(attrs))]));
  const algId = o.algId ?? ECDSA256;
  const sig = bitString(cryptoSign('sha256', info, ecPair.privateKey));
  return sequence(...(o.top ? o.top(info, algId, sig) : [info, algId, sig]));
}
const extReq = (...exts: Buffer[]) => attr('1.2.840.113549.1.9.14', sequence(...exts));
const san = (...names: Parameters<typeof sanExtension>[0]) => sequence(oid('2.5.29.17'), octetString(sanExtension(names)));

test('a request reads what is there: no attributes, empty attributes, other attributes, other extensions', () => {
  const plain = parseCsr(rawCsr({ attrs: null }));
  assert.deepEqual([plain.san, plain.selfSignatureValid, plain.subject], [[], true, 'CN=csr subject'], 'no [0] at all');
  assert.deepEqual(parseCsr(rawCsr({ attrs: [] })).san, []);
  assert.deepEqual(parseCsr(rawCsr({ attrs: [attr('1.2.840.113549.1.9.14')] })).san, [], 'an extensionRequest with no value');
  assert.deepEqual(parseCsr(rawCsr({ attrs: [attr('1.2.840.113549.1.9.14', sequence())] })).san, [], 'an extensionRequest with an empty value');
  assert.deepEqual(parseCsr(rawCsr({ attrs: [attr('1.2.3.4', sequence(san({ dns: 'evil.example' })))] })).san, [], 'a SAN inside some other attribute is not a SAN');
  assert.deepEqual(parseCsr(rawCsr({ attrs: [attr('1.2.840.113549.1.9.7', sequence(san({ dns: 'evil.example' })))] })).san, [], 'nor inside a challengePassword');
  const both = parseCsr(rawCsr({ attrs: [extReq(ext('2.5.29.19', sequence(boolean(true)), true), san({ dns: 'a.example' }, { ip: '192.0.2.1' }))] }));
  assert.deepEqual(both.san, [{ type: 'dns', value: 'a.example' }, { type: 'ip', value: '192.0.2.1' }]);
  const crit = parseCsr(rawCsr({ attrs: [extReq(sequence(oid('2.5.29.17'), boolean(true), octetString(sanExtension([{ dns: 'c.example' }]))))] }));
  assert.deepEqual(crit.san, [{ type: 'dns', value: 'c.example' }], 'a critical SAN is still the last element, the value');
  const two = parseCsr(rawCsr({ attrs: [extReq(san({ dns: 'one.example' })), extReq(san({ dns: 'two.example' }))] }));
  assert.deepEqual(two.san.map((s) => s.value), ['one.example', 'two.example']);
});

test('a request with an unusable signature algorithm is reported as unverified, never as valid', () => {
  for (const alg of ['1.2.3.4', '1.2.840.113549.1.1.5', '1.2.840.10045.4.1', '1.2.840.113549.1.1.10']) {
    const p = parseCsr(rawCsr({ algId: sequence(oid(alg)) }));
    assert.equal(p.selfSignatureValid, false, alg);
  }
  assert.equal(parseCsr(rawCsr({})).selfSignatureValid, true);
  const mismatch = parseCsr(rawCsr({ algId: sequence(oid('1.2.840.10045.4.3.3')) }));
  assert.equal(mismatch.selfSignatureValid, false, 'a signature made with SHA-256 is not valid as SHA-384');
});

test('request structure: version, part count and the messages', () => {
  derFails(() => parseCsr(rawCsr({ version: 1n })), /an unknown request version/);
  derFails(() => parseCsr(rawCsr({ version: 2n })), /an unknown request version/);
  derFails(() => parseCsr(rawCsr({ top: () => [] })), /CertificationRequest has three parts/);
  derFails(() => parseCsr(rawCsr({ top: (info) => [info] })), /CertificationRequest has three parts/);
  derFails(() => parseCsr(rawCsr({ top: (info, a) => [info, a] })), /CertificationRequest has three parts/);
  derFails(() => parseCsr(rawCsr({ top: (info, a, s) => [info, a, s, nullValue()] })), /CertificationRequest has three parts/, 'four parts');
  derFails(() => parseCsr(sequence(integer(1), ECDSA256, bitString(Buffer.alloc(1)))), /expected CertificationRequestInfo/);
});

test('request building: the algorithm identifier carries NULL parameters only for RSA, and string types follow the attribute', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const ed = generateKeyPairSync('ed25519').privateKey;
  const subject = [['CN', 'k.example.org']] as const;
  assert.deepEqual(parseDer(buildCsr({ subject, privateKey: rsa })).children[1]!.children.map((c) => c.tag), [6, 5]);
  assert.deepEqual(parseDer(buildCsr({ subject, privateKey: ec })).children[1]!.children.map((c) => c.tag), [6]);
  assert.deepEqual(parseDer(buildCsr({ subject, privateKey: ed })).children[1]!.children.map((c) => c.tag), [6]);
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey;
  assert.deepEqual(parseDer(buildCsr({ subject, privateKey: p384 })).children[1]!.children.map((c) => c.tag), [6]);
  const tags = (attrs: [string, string][]) => {
    const name = parseDer(buildCsr({ subject: attrs, privateKey: ec })).children[0]!.children[1]!;
    return name.children.map((rdn) => rdn.children[0]!.children[1]!.tag);
  };
  assert.deepEqual(tags([['C', 'US'], ['CN', 'abc'], ['O', 'a@b'], ['OU', 'é'], ['emailAddress', 'a@b.c'], ['L', ''], ['ST', "Ab 1'()+,-./:=?"]]), [19, 19, 12, 12, 22, 12, 19]);
  derFails(() => buildCsr({ subject: [['C', 'é1']], privateKey: ec }), /not a PrintableString/, 'a two-character country that is not printable');
  derFails(() => buildCsr({ subject: [['emailAddress', 'é@b.c']], privateKey: ec }), /not an IA5String/);
});

test('request building: a key that reports its curve by the NIST name is still P-256 or P-384', () => {
  const alias = (k: typeof ecPair.privateKey, name: string) =>
    new Proxy(k, {
      get(t, p) {
        if (p === 'asymmetricKeyDetails') return { namedCurve: name };
        const v = Reflect.get(t, p, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey;
  const a = parseCsr(buildCsr({ subject: [['CN', 'x']], privateKey: alias(ecPair.privateKey, 'P-256') }));
  assert.deepEqual([a.signatureAlgorithm, a.selfSignatureValid], ['ecdsa-with-SHA256', true]);
  const b = parseCsr(buildCsr({ subject: [['CN', 'x']], privateKey: alias(p384, 'P-384') }));
  assert.deepEqual([b.signatureAlgorithm, b.selfSignatureValid], ['ecdsa-with-SHA384', true]);
  assert.throws(() => buildCsr({ subject: [['CN', 'x']], privateKey: alias(ecPair.privateKey, 'P-521') }), /only RSA/);
});

test('well-formed DER of the wrong shape is a DerError, never a TypeError, in certificates, names, keys and requests', () => {
  const f = goodFields();
  const cases: [string, () => unknown][] = [
    ['validity with one time', () => parseCertificate(mkCert({ fields: [f[0]!, f[1]!, f[2]!, sequence(time(new Date(0))), f[4]!, f[5]!] }))],
    ['validity empty', () => parseCertificate(mkCert({ fields: [f[0]!, f[1]!, f[2]!, sequence(), f[4]!, f[5]!] }))],
    ['serial not an integer', () => parseCertificate(mkCert({ fields: [nullValue(), ...f.slice(1)] }))],
    ['algorithm identifier empty', () => parseCertificate(mkCert({ fields: [f[0]!, sequence(), ...f.slice(2)], outerAlg: sequence() }))],
    ['name with an attribute of one part', () => parseCertificate(mkCert({ fields: [f[0]!, f[1]!, sequence(set(sequence(oid('2.5.4.3')))), ...f.slice(3)] }))],
    ['name with an empty attribute', () => parseCertificate(mkCert({ fields: [f[0]!, f[1]!, sequence(set(sequence())), ...f.slice(3)] }))],
    ['key info empty', () => parseCertificate(mkCert({ fields: [...f.slice(0, 5), sequence()] }))],
    ['key info without the bits', () => parseCertificate(mkCert({ fields: [...f.slice(0, 5), sequence(sequence(oid('1.3.101.112')))] }))],
    ['key algorithm empty', () => parseCertificate(mkCert({ fields: [...f.slice(0, 5), sequence(sequence(), bitString(Buffer.alloc(1)))] }))],
    ['signature not a bit string', () => parseCertificate(mkCert({ top: [mkTbs(), ECDSA256, nullValue()] }))],
    ['extension empty', () => withExt(sequence())],
    ['extension without a value', () => withExt(sequence(oid('2.5.29.17')))],
    ['basic constraints value empty', () => parseCertificate(mkCert({ exts: [sequence(oid('2.5.29.19'), octetString(Buffer.alloc(0)))] }))],
    ['key identifier value not octets', () => withExt(ext('2.5.29.14', nullValue()))],
    ['request attribute empty', () => parseCsr(rawCsr({ attrs: [sequence()] }))],
    ['request attribute without values', () => parseCsr(rawCsr({ attrs: [sequence(oid('1.2.840.113549.1.9.14'))] }))],
    ['request extension empty', () => parseCsr(rawCsr({ attrs: [extReq(sequence())] }))],
    ['request extension without a value', () => parseCsr(rawCsr({ attrs: [extReq(sequence(oid('2.5.29.17')))] }))],
    ['request algorithm empty', () => parseCsr(rawCsr({ algId: sequence() }))],
    ['request without a key', () => parseCsr(sequence(sequence(integer(0), cn('x')), ECDSA256, bitString(Buffer.alloc(1))))],
  ];
  for (const [name, fn] of cases) assert.throws(fn, (e: Error) => e instanceof DerError, name);
  assert.equal(parseCsr(rawCsr({ top: (info, a) => [info, a, nullValue()] })).selfSignatureValid, false, 'a signature that is not a bit string does not verify');
});

test('malformed shapes are reported with what was missing', () => {
  derFails(() => nameToString(parseDer(sequence(set(sequence(oid('2.5.4.3')))))), /^bad DER: an AttributeTypeAndValue has a type and a value$/);
  derFails(() => nameToString(parseDer(sequence(set(sequence())))), /^bad DER: an AttributeTypeAndValue has a type and a value$/);
  derFails(() => parseCsr(sequence(sequence(integer(0), cn('x')), ECDSA256, bitString(Buffer.alloc(1)))), /^bad DER: a CertificationRequestInfo is missing fields$/);
  derFails(() => parseCsr(sequence(sequence(integer(0), cn('x'), ecSpki), ECDSA256)), /CertificationRequest has three parts/);
  derFails(() => parseCsr(rawCsr({ attrs: [sequence()] })), /^bad DER: an Attribute has a type and values$/);
  derFails(() => parseCsr(rawCsr({ attrs: [sequence(oid('1.2.840.113549.1.9.14'))] })), /^bad DER: an Attribute has a type and values$/);
  derFails(() => asTime(undefined as unknown as Der), /^bad DER: expected a time$/);
});
