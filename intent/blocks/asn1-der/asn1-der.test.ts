import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DerError, UT, asBits, asBoolean, asInteger, asOid, asString, asTime, bitString, boolean, buildCsr, explicit, fromPem, generalNames, ia5String, implicit, integer, matchesHostname, nameToString, nullValue, octetString, oid, oidName, oidOf, parseAll, parseCertificate, parseCsr, parseDer, parseSpki, printableString, sanExtension, sequence, set, signedBy, time, tlv, toPem, utf8String, validAt } from './index.ts';
import type { Der } from './index.ts';

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
