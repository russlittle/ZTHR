import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CertError, CertStore, buildChain, certificateCoversHost, nameKey, nameToString, normalizeHost, parseCertificate, parseIp, parsePem, verifySignature } from './index.ts';

// Generated once with OpenSSL; every certificate here is a throwaway test certificate.
export const PEM = {
  ca: `-----BEGIN CERTIFICATE-----
MIIB0DCCAXagAwIBAgIBATAKBggqhkjOPQQDAjA/MQswCQYDVQQGEwJVUzEWMBQG
A1UECgwNRXhhbXBsZSBUcnVzdDEYMBYGA1UEAwwPRXhhbXBsZSBSb290IENBMB4X
DTI2MTEyODA2NDk1MVoXDTM2MTEyNTA2NDk1MVowPzELMAkGA1UEBhMCVVMxFjAU
BgNVBAoMDUV4YW1wbGUgVHJ1c3QxGDAWBgNVBAMMD0V4YW1wbGUgUm9vdCBDQTBZ
MBMGByqGSM49AgEGCCqGSM49AwEHA0IABI0DXcPRwMXxQ14obQw2VTgc71tyUpKZ
kWsxvl37gBZDRrPWdMvS9qHG7Tv6swo/FavGVyXgVrP3IXYznUfTBnqjYzBhMB8G
A1UdIwQYMBaAFC0eqNIFuEyCZivxF89crzoMURK+MA8GA1UdEwEB/wQFMAMBAf8w
DgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBQtHqjSBbhMgmYr8RfPXK86DFESvjAK
BggqhkjOPQQDAgNIADBFAiAIxfD/UaF7JwZgXA/OuL4p7QcFswvJNZZujGgMJRbl
CgIhAKYqbBRoECqFt+cejmpIZo3FhQ/4D5fkXrryTVxMKBsN
-----END CERTIFICATE-----
`,
  int: `-----BEGIN CERTIFICATE-----
MIIB1zCCAX6gAwIBAgIBAjAKBggqhkjOPQQDAjA/MQswCQYDVQQGEwJVUzEWMBQG
A1UECgwNRXhhbXBsZSBUcnVzdDEYMBYGA1UEAwwPRXhhbXBsZSBSb290IENBMB4X
DTI2MTEyODA2NDk1MloXDTMxMTEwMjA2NDk1MlowRDELMAkGA1UEBhMCVVMxFjAU
BgNVBAoMDUV4YW1wbGUgVHJ1c3QxHTAbBgNVBAMMFEV4YW1wbGUgSXNzdWluZyBD
QSAxMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECCw1w08ZW+Q7jklDizWvL7Ut
Iod1FXhLqbyVKCzyOUOs9ylOEkjQ+2AWSd4513Ovp5BrGyUPLS65A9uxpOMAWKNm
MGQwEgYDVR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYE
FKnVKnfH4aiQX73M/n3XRZmsYIi7MB8GA1UdIwQYMBaAFC0eqNIFuEyCZivxF89c
rzoMURK+MAoGCCqGSM49BAMCA0cAMEQCID4bUnIr1n3w+4SVEpCKp0z+Fl8LcCdO
C5awI5xAnxbkAiARsrV9NQi8LUyczo/vCqpw5W0Aubur0ATR48OwK0Ge6A==
-----END CERTIFICATE-----
`,
  leaf: `-----BEGIN CERTIFICATE-----
MIIDjDCCAzKgAwIBAgIBAzAKBggqhkjOPQQDAjBEMQswCQYDVQQGEwJVUzEWMBQG
A1UECgwNRXhhbXBsZSBUcnVzdDEdMBsGA1UEAwwURXhhbXBsZSBJc3N1aW5nIENB
IDEwHhcNMjYxMTI4MDY0OTUyWhcNMjcwMjI2MDY0OTUyWjAaMRgwFgYDVQQDDA93
d3cuZXhhbXBsZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCt
8NJMKrD6gwN4pZVBkk+LS+oy25/x4nMCtYGtAlnMFCWRyWd1YYSx0rKc6gDr9ldk
9oczjNWyUFGE6Y9Gtm9oZt+OMvjNwXTLoEc+MD7G8LFqV0e++rg1Ak19EGOc24Q6
GxjHOWvMiNZ1ZnaVaMGJzFUB8wVr5cdquc9+TiXne0mMEZJEj6/2dm0V5kywYeq2
GBPrism5cCXoAUGE0wMGJ0CaJYWWuUXQuVs4iZjiZkWkPJYeuvjGTnRrJqVsJWJD
O/0NpMC7kBghLLvHWuXLISCcUysZ0XrGcOrhXgTDL4IGpyIQIC28UoMkeZbwNW+6
7KM/O5kOSb7H6wbLEASNAgMBAAGjggFyMIIBbjAMBgNVHRMBAf8EAjAAMA4GA1Ud
DwEB/wQEAwIFoDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIweQYDVR0R
BHIwcIIPd3d3LmV4YW1wbGUuY29tggtleGFtcGxlLmNvbYIRKi5hcGkuZXhhbXBs
ZS5jb22HBMAAAgqHECABDbgAAAAAAAAAAAAAAAGBD29wc0BleGFtcGxlLmNvbYYU
aHR0cHM6Ly9leGFtcGxlLmNvbS8wHQYDVR0OBBYEFFE0RPotfGK+FkGMQN/1RaYL
xEy2MB8GA1UdIwQYMBaAFKnVKnfH4aiQX73M/n3XRZmsYIi7MGEGCCsGAQUFBwEB
BFUwUzAjBggrBgEFBQcwAYYXaHR0cDovL29jc3AuZXhhbXBsZS5jb20wLAYIKwYB
BQUHMAKGIGh0dHA6Ly9jZXJ0cy5leGFtcGxlLmNvbS9pbnQuY3J0MBEGCCsGAQUF
BwEYBAUwAwIBBTAKBggqhkjOPQQDAgNIADBFAiEApUkJZnUTjN8aVi6Ifo5BMKDJ
wkl47wgFonOMWkfNlKUCICWgA0rKhXIYyO1CajJbYpY9IddQeuJdJsYa3nfQgYEI
-----END CERTIFICATE-----
`,
  other: `-----BEGIN CERTIFICATE-----
MIIBjDCCATOgAwIBAgIUTL/SHpvb8P5tbgjcCojQlAgxYUswCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRT3RoZXIgU2VsZiBTaWduZWQwHhcNMjYxMTI4MDY0OTUyWhcN
MjYxMjI4MDY0OTUyWjAcMRowGAYDVQQDDBFPdGhlciBTZWxmIFNpZ25lZDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABOEKgSjHGn8+No+65ff60BzzslJDlXwZ0w6l
8kc5P/+vzDgxy3Ncj6MAqUr0b+cftwAVFQy/FsQe8PWv2O5rb8qjUzBRMB0GA1Ud
DgQWBBRpBMxbT5vtS+KFJEMXCVSh31xPcTAfBgNVHSMEGDAWgBRpBMxbT5vtS+KF
JEMXCVSh31xPcTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCICja
lgRv0ZutKtgvIlhM9HSM9GW0HzoL3euNOUhq/1t2AiANtf8EjDB5hxFtNXQuUeYN
ioxoS8rWpNXT0DQdPoAOiw==
-----END CERTIFICATE-----
`,
  fakeint: `-----BEGIN CERTIFICATE-----
MIIB2zCCAYCgAwIBAgIBCTAKBggqhkjOPQQDAjBEMQswCQYDVQQGEwJVUzEWMBQG
A1UECgwNRXhhbXBsZSBUcnVzdDEdMBsGA1UEAwwURXhhbXBsZSBJc3N1aW5nIENB
IDEwHhcNMjYxMTI4MDY1MDAxWhcNMzExMTAyMDY1MDAxWjBEMQswCQYDVQQGEwJV
UzEWMBQGA1UECgwNRXhhbXBsZSBUcnVzdDEdMBsGA1UEAwwURXhhbXBsZSBJc3N1
aW5nIENBIDEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAThCoEoxxp/PjaPuuX3
+tAc87JSQ5V8GdMOpfJHOT//r8w4MctzXI+jAKlK9G/nH7cAFRUMvxbEHvD1r9ju
a2/Ko2MwYTAdBgNVHQ4EFgQUaQTMW0+b7UvihSRDFwlUod9cT3EwHwYDVR0jBBgw
FoAUaQTMW0+b7UvihSRDFwlUod9cT3EwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8B
Af8EBAMCAgQwCgYIKoZIzj0EAwIDSQAwRgIhAIaGoGTJm5W1MyqK77SHhZWxILi1
UI96zgK8vAbYcwIPAiEAgaPz0iRFvIMoaTf9JIExkOdNE5j4VlPNFG5Zssl/JfU=
-----END CERTIFICATE-----
`,
  rsaroot: `-----BEGIN CERTIFICATE-----
MIIDKjCCAhKgAwIBAgIBBTANBgkqhkiG9w0BAQsFADAmMREwDwYDVQQKDAhSU0Eg
VGVzdDERMA8GA1UEAwwIUlNBIFJvb3QwHhcNMjYxMTI4MDY1MDAxWhcNMjcxMTI4
MDY1MDAxWjAmMREwDwYDVQQKDAhSU0EgVGVzdDERMA8GA1UEAwwIUlNBIFJvb3Qw
ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5e/aXvkiaUjS6rh+NVmdg
Q9hiCXNyMjijqhlT1BquRsi88wuPgYRdek2Knf39bahqQB8UMfOh411Fww2zw4lN
1qC+csIDEi0g1nqKP1RxsqB7PWH48zlawzgK96HYypT3ZrEl8gSW29lUjht1ycyI
F9rcNgqMrWYFrScueOLgSmza/PBkkSL8N49ZGSWy8IOdLhYIz0cv3eddqyJyNQKc
c/FTil7tcVJy8iSm5cBh0GHk2MMkNW7XSebMBcn/ShqXhU1fPKc0CEVlY4496KiP
RAyGlYzjfbr0q2imnFsZsJ2O07bur08xhwU5EEH04BkIydQIq+Y406Wt6aJ38mB1
AgMBAAGjYzBhMB0GA1UdDgQWBBQpiYvlx6Pdflvq009wi5b0HEY2+TAfBgNVHSME
GDAWgBQpiYvlx6Pdflvq009wi5b0HEY2+TAPBgNVHRMBAf8EBTADAQH/MA4GA1Ud
DwEB/wQEAwICBDANBgkqhkiG9w0BAQsFAAOCAQEABrVNKBs00O85FJ+hwUUQIJ94
DW6eP6sKJy4rHI0dRWq1zXDfy24Y0SAX+5EALZUUlcdIWMWgVLVcgRc/gmCRnHGA
rfvb6ZL3PQmozawjJVkpwkt1dFr+cs1mqoKwaSpjFzPlLn5kOmJTGFrws7wNLH75
C9DMC0IRlEBEDQfqIpdNAKOOtlljg5OwHgbM9UnFU9iWKiu+8CtcTZCNeB+mgq44
byW6lvqOB+Jh17yCZSvnvlVR2P1KxQsCRUc+GsY0B2GnF2YyOugzmbw83GMYNaUE
87BBrQftsR6js+oOIoHolNku9dOK3zRACQOb6IFEqRaeETgjmg4vsoT+x0fHGw==
-----END CERTIFICATE-----
`,
  forged: `-----BEGIN CERTIFICATE-----
MIIChjCCAi2gAwIBAgIBBzAKBggqhkjOPQQDAjBEMQswCQYDVQQGEwJVUzEWMBQG
A1UECgwNRXhhbXBsZSBUcnVzdDEdMBsGA1UEAwwURXhhbXBsZSBJc3N1aW5nIENB
IDEwHhcNMjYxMTI4MDY1MDAxWhcNMjYxMjI4MDY1MDAxWjAaMRgwFgYDVQQDDA93
d3cuZXhhbXBsZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCt
8NJMKrD6gwN4pZVBkk+LS+oy25/x4nMCtYGtAlnMFCWRyWd1YYSx0rKc6gDr9ldk
9oczjNWyUFGE6Y9Gtm9oZt+OMvjNwXTLoEc+MD7G8LFqV0e++rg1Ak19EGOc24Q6
GxjHOWvMiNZ1ZnaVaMGJzFUB8wVr5cdquc9+TiXne0mMEZJEj6/2dm0V5kywYeq2
GBPrism5cCXoAUGE0wMGJ0CaJYWWuUXQuVs4iZjiZkWkPJYeuvjGTnRrJqVsJWJD
O/0NpMC7kBghLLvHWuXLISCcUysZ0XrGcOrhXgTDL4IGpyIQIC28UoMkeZbwNW+6
7KM/O5kOSb7H6wbLEASNAgMBAAGjbzBtMAwGA1UdEwEB/wQCMAAwHQYDVR0RBBYw
FIISZm9yZ2VkLmV4YW1wbGUuY29tMB0GA1UdDgQWBBRRNET6LXxivhZBjEDf9UWm
C8RMtjAfBgNVHSMEGDAWgBRpBMxbT5vtS+KFJEMXCVSh31xPcTAKBggqhkjOPQQD
AgNHADBEAiBR+FHFCr48y6PrlnbSOKmbYISBMB6x/tdyb2gD1GZnsQIgVKE8oTQx
kfKJUw9gY4pF9mPtzdxaAWjrmkhOjs0Ycwo=
-----END CERTIFICATE-----
`,
  child: `-----BEGIN CERTIFICATE-----
MIIB2jCBwwIBCDANBgkqhkiG9w0BAQsFADAaMRgwFgYDVQQDDA93d3cuZXhhbXBs
ZS5jb20wHhcNMjYxMTI4MDY1MDAyWhcNMjYxMjI4MDY1MDAyWjAYMRYwFAYDVQQD
DA1DaGlsZCBPZiBMZWFmMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4QqBKMca
fz42j7rl9/rQHPOyUkOVfBnTDqXyRzk//6/MODHLc1yPowCpSvRv5x+3ABUVDL8W
xB7w9a/Y7mtvyjANBgkqhkiG9w0BAQsFAAOCAQEAIuoyLMLLweAuozg2uArJNjcv
F7Uc/85zlbLF3F6iXcWWxZH80IqNDUTgEByyy1zh1l5OSiON7A85rvLsVbMBF2WG
E4OdXVZEb63QRQTgzsF/PP5HOM083DyYzgY/Dtd7ipsoWt1RGxNJ0AUh0W1UEYP3
NpbNj28OuX9cyPqxOYYviFYqPEFae8Bs5G/x2iI49XA3UYVMc3MqqONoPAQJjNQq
FGxktLz61EsayVmKuvHgQfifasyjMQ/xayxebH4O5frLxm8uBIySsk+ko+xJBBv9
wdK6V3kI1Kea9Q6+HhPq0Yot1bZWSHNfes9PVoU9p3FON8ZG6clDTrLYWw9Tag==
-----END CERTIFICATE-----
`,
  int2: `-----BEGIN CERTIFICATE-----
MIIB0DCCAXegAwIBAgIBCzAKBggqhkjOPQQDAjBEMQswCQYDVQQGEwJVUzEWMBQG
A1UECgwNRXhhbXBsZSBUcnVzdDEdMBsGA1UEAwwURXhhbXBsZSBJc3N1aW5nIENB
IDEwHhcNMjYxMTI4MDY1NTI5WhcNMjcwMzA4MDY1NTI5WjA7MQswCQYDVQQGEwJV
UzEWMBQGA1UECgwNRXhhbXBsZSBUcnVzdDEUMBIGA1UEAwwLVG9vIERlZXAgQ0Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT4ylYZT9Tfn9pAPAh87C4txEqM1awt
Qew+vwAiSh/geEO2BiidBZAsoHazot4XnV5YuQ+H8aYvfuWWe2IACA7mo2MwYTAP
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDAdBgNVHQ4EFgQUdnCI7TKy
8VemVrDsVA+x/RXrx7EwHwYDVR0jBBgwFoAUqdUqd8fhqJBfvcz+fddFmaxgiLsw
CgYIKoZIzj0EAwIDRwAwRAIgG2JqwFld2r1K9XLIteP7H06fssYkNfqhZsd9wx1m
T0sCIDn1dcvoGTZ4d1cuNn352CTdOriqsDPn28tNN8yTMv2F
-----END CERTIFICATE-----
`,
  deep: `-----BEGIN CERTIFICATE-----
MIIBsjCCAVigAwIBAgIBDDAKBggqhkjOPQQDAjA7MQswCQYDVQQGEwJVUzEWMBQG
A1UECgwNRXhhbXBsZSBUcnVzdDEUMBIGA1UEAwwLVG9vIERlZXAgQ0EwHhcNMjYx
MTI4MDY1NTI5WhcNMjYxMjI4MDY1NTI5WjAbMRkwFwYDVQQDDBBkZWVwLmV4YW1w
bGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4QqBKMcafz42j7rl9/rQ
HPOyUkOVfBnTDqXyRzk//6/MODHLc1yPowCpSvRv5x+3ABUVDL8WxB7w9a/Y7mtv
yqNtMGswDAYDVR0TAQH/BAIwADAbBgNVHREEFDASghBkZWVwLmV4YW1wbGUuY29t
MB8GA1UdIwQYMBaAFHZwiO0ysvFXplaw7FQPsf0V68exMB0GA1UdDgQWBBRpBMxb
T5vtS+KFJEMXCVSh31xPcTAKBggqhkjOPQQDAgNIADBFAiEAhENR0toFg/c9jNL4
a0BrDZ09rhDAItCRMUslVW2AtuQCIEfZGM9yB1A64NGFs1ZStL+kfJhY9mRBhc1E
CLE70TkE
-----END CERTIFICATE-----
`,
} as const;

const T = (iso: string): number => Date.parse(iso);
const NOW = T('2026-11-28T12:00:00Z');
const DAY = 86_400_000;
const root = parseCertificate(PEM.ca);
const inter = parseCertificate(PEM.int);
const leaf = parseCertificate(PEM.leaf);
const pemBytes = (pem: string): Uint8Array => Uint8Array.from(Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64'));

test('a leaf certificate is read field by field', () => {
  assert.equal(leaf.version, 3);
  assert.equal(leaf.serialHex, '03');
  assert.equal(leaf.subjectText, 'CN=www.example.com');
  assert.equal(leaf.issuerText, 'CN=Example Issuing CA 1,O=Example Trust,C=US');
  assert.equal(leaf.notBefore, T('2026-11-28T06:49:52Z'));
  assert.equal(leaf.notAfter, T('2027-02-26T06:49:52Z'));
  assert.deepEqual(leaf.dnsNames, ['www.example.com', 'example.com', '*.api.example.com']);
  assert.deepEqual(leaf.ipAddresses, ['192.0.2.10', '2001:db8::1']);
  assert.deepEqual(leaf.emails, ['ops@example.com']);
  assert.deepEqual(leaf.uris, ['https://example.com/']);
  assert.deepEqual(leaf.extendedKeyUsage, ['serverAuth', 'clientAuth']);
  assert.deepEqual(leaf.keyUsage, ['digitalSignature', 'keyEncipherment']);
  assert.equal(leaf.isCa, false);
  assert.equal(leaf.signatureAlgorithm, '1.2.840.10045.4.3.2');
  assert.deepEqual(leaf.ocspUrls, ['http://ocsp.example.com']);
  assert.deepEqual(leaf.caIssuerUrls, ['http://certs.example.com/int.crt']);
  assert.equal(leaf.mustStaple, true);
  assert.equal(leaf.authorityKeyId, inter.subjectKeyId);
  assert.match(leaf.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(leaf.unknownCriticalExtensions, []);
});

test('CA fields: basicConstraints, path length, key usage, self-issued roots', () => {
  assert.deepEqual([root.isCa, root.pathLen, root.selfIssued], [true, undefined, true]);
  assert.deepEqual([inter.isCa, inter.pathLen, inter.selfIssued], [true, 0, false]);
  assert.deepEqual(inter.keyUsage, ['keyCertSign', 'cRLSign']);
  assert.equal(root.subjectText, 'CN=Example Root CA,O=Example Trust,C=US');
  assert.equal(root.notAfter, T('2036-11-25T06:49:51Z'));
});

test('PEM and DER give the same certificate; bundles keep their order; stray text is ignored', () => {
  const der = parseCertificate(pemBytes(PEM.leaf));
  assert.equal(der.id, leaf.id);
  const bundle = parsePem(`# my chain\n${PEM.leaf}\nsome notes\n${PEM.int}${PEM.ca}`);
  assert.deepEqual(bundle.map((c) => c.subjectText.split(',')[0]), ['CN=www.example.com', 'CN=Example Issuing CA 1', 'CN=Example Root CA']);
  assert.equal(parsePem('nothing here').length, 0);
  assert.throws(() => parseCertificate(`${PEM.leaf}${PEM.int}`), /exactly one certificate, found 2/);
  assert.throws(() => parseCertificate('no certificate'), /found 0/);
});

test('malformed DER is refused with a typed error, never a crash', () => {
  const good = pemBytes(PEM.leaf);
  const cases: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['truncated', good.subarray(0, 100)],
    ['trailing bytes', Uint8Array.from([...good, 0])],
    ['indefinite length', Uint8Array.from([0x30, 0x80, 0x00, 0x00])],
    ['non-minimal length', Uint8Array.from([0x30, 0x81, 0x05, 1, 2, 3, 4, 5])],
    ['length past the end', Uint8Array.from([0x30, 0x84, 0x7f, 0xff, 0xff, 0xff])],
    ['not a sequence', Uint8Array.from([0x04, 0x01, 0x00])],
    ['empty sequence', Uint8Array.from([0x30, 0x00])],
    ['high tag number', Uint8Array.from([0x1f, 0x80, 0x01, 0x00])],
  ];
  for (const [name, bytes] of cases) assert.throws(() => parseCertificate(bytes), CertError, name);
  const flipped = Uint8Array.from(good);
  flipped[4] = 0x31;
  assert.throws(() => parseCertificate(flipped), CertError);
  assert.throws(() => parseCertificate(new Uint8Array(300 * 1024)), /too large/);
  assert.throws(() => parsePem('-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----'), CertError);
  assert.throws(() => parsePem('-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----'), CertError);
  assert.throws(() => parsePem(PEM.ca.repeat(201)), /more than 200/);
  assert.throws(() => parseCertificate(5 as unknown as string), CertError);
});

test('every single-byte corruption of a certificate fails cleanly or still parses; none throws anything else', () => {
  const good = pemBytes(PEM.int);
  for (let i = 0; i < good.length; i += 3) {
    const b = Uint8Array.from(good);
    b[i] = b[i]! ^ 0xff;
    try {
      parseCertificate(b);
    } catch (e) {
      assert.ok(e instanceof CertError, `byte ${i}: ${String(e)}`);
    }
  }
});

test('signatures: the right issuer verifies, the wrong one does not, RSA self-signature verifies', () => {
  assert.equal(verifySignature(leaf, inter), true);
  assert.equal(verifySignature(inter, root), true);
  assert.equal(verifySignature(root, root), true);
  assert.equal(verifySignature(leaf, root), false);
  assert.equal(verifySignature(inter, parseCertificate(PEM.other)), false);
  const rsa = parseCertificate(PEM.rsaroot);
  assert.equal(rsa.signatureAlgorithm, '1.2.840.113549.1.1.11');
  assert.equal(verifySignature(rsa, rsa), true);
  assert.equal(verifySignature(rsa, root), false);
  const tampered = { ...leaf, tbs: Uint8Array.from(leaf.tbs, (b, i) => (i === 40 ? b ^ 1 : b)) };
  assert.equal(verifySignature(tampered, inter), false);
  assert.throws(() => verifySignature({ ...leaf, signatureAlgorithm: '1.2.840.113549.1.1.5' }, inter), /not supported/);
});

test('a chain builds from leaf through the intermediate to the root, and the order of the pool does not matter', () => {
  const c = buildChain(leaf, { now: NOW, roots: [root], intermediates: [inter] });
  assert.equal(c.trusted, true);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.certificates.map((x) => x.id), [leaf.id, inter.id, root.id]);
  const c2 = buildChain(leaf, { now: NOW, roots: [root], intermediates: [parseCertificate(PEM.fakeint), inter, parseCertificate(PEM.other)] });
  assert.equal(c2.trusted, true, 'a look-alike with the same name but another key is tried and rejected');
  assert.deepEqual(c2.certificates.map((x) => x.id), [leaf.id, inter.id, root.id]);
  assert.equal(buildChain(root, { now: NOW, roots: [root] }).trusted, true, 'a root is its own chain');
});

test('an unknown issuer, a missing intermediate and an untrusted root all leave the chain untrusted', () => {
  const noInter = buildChain(leaf, { now: NOW, roots: [root] });
  assert.equal(noInter.trusted, false);
  assert.deepEqual(noInter.problems.map((p) => p.code), ['unknown-issuer']);
  assert.deepEqual(noInter.certificates.map((x) => x.id), [leaf.id]);
  const noRoot = buildChain(leaf, { now: NOW, roots: [], intermediates: [inter, root] });
  assert.equal(noRoot.trusted, false, 'a root handed over as an intermediate is not trusted');
  assert.equal(noRoot.problems[0]?.code, 'unknown-issuer');
  const selfSigned = parseCertificate(PEM.other);
  assert.equal(buildChain(selfSigned, { now: NOW, roots: [root] }).trusted, false);
  assert.equal(buildChain(selfSigned, { now: NOW, roots: [selfSigned] }).trusted, true, 'trusted only because the caller said so');
});

test('a forged certificate under a look-alike issuer name fails on its signature', () => {
  const forged = parseCertificate(PEM.forged);
  const fake = parseCertificate(PEM.fakeint);
  assert.equal(buildChain(forged, { now: NOW, roots: [root], intermediates: [inter] }).problems[0]?.code, 'unknown-issuer', 'its authority key id does not match the real issuer');
  const noAki = { ...forged, authorityKeyId: undefined };
  const c = buildChain(noAki, { now: NOW, roots: [root], intermediates: [inter] });
  assert.equal(c.trusted, false);
  assert.ok(c.problems.some((p) => p.code === 'bad-signature' && p.certificate === forged.id), JSON.stringify(c.problems));
  const c2 = buildChain(forged, { now: NOW, roots: [root], intermediates: [fake] });
  assert.equal(c2.problems.some((p) => p.code === 'unknown-issuer'), true);
  assert.equal(c2.trusted, false, 'the fake issues it correctly, but nothing trusted vouches for the fake');
  assert.equal(c2.problems.some((p) => p.code === 'bad-signature'), false);
  assert.equal(buildChain(forged, { now: NOW, roots: [fake] }).trusted, true, 'unless the caller trusts the fake');
});

test('a leaf cannot issue certificates, and a CA without keyCertSign cannot either', () => {
  const child = parseCertificate(PEM.child);
  const c = buildChain(child, { now: NOW, roots: [root], intermediates: [leaf, inter] });
  assert.equal(c.trusted, false);
  assert.ok(c.problems.some((p) => p.code === 'not-a-ca' && p.certificate === leaf.id));
  const noSign = { ...inter, keyUsage: ['digitalSignature' as const] };
  assert.ok(buildChain(leaf, { now: NOW, roots: [root], intermediates: [noSign] }).problems.some((p) => p.code === 'cannot-sign-certificates'));
});

test('pathLenConstraint 0 forbids a second intermediate', () => {
  const int2 = parseCertificate(PEM.int2);
  const deep = parseCertificate(PEM.deep);
  assert.equal(verifySignature(int2, inter), true, 'the signatures are all genuine');
  assert.equal(verifySignature(deep, int2), true);
  const c = buildChain(deep, { now: NOW, roots: [root], intermediates: [inter, int2] });
  assert.equal(c.trusted, false);
  assert.deepEqual(c.problems.map((p) => [p.code, p.certificate]), [['path-length-exceeded', inter.id]]);
  assert.deepEqual(c.certificates.map((x) => x.id), [deep.id, int2.id, inter.id, root.id]);
  const ok = buildChain(int2, { now: NOW, roots: [root], intermediates: [inter] });
  assert.equal(ok.trusted, true, 'one intermediate under pathlen 0 is exactly what it allows');
});

test('expiry and not-yet-valid are caught for every certificate in the chain', () => {
  const late = buildChain(leaf, { now: T('2027-03-01T00:00:00Z'), roots: [root], intermediates: [inter] });
  assert.equal(late.trusted, false);
  assert.deepEqual(late.problems.map((p) => p.code), ['expired']);
  assert.equal(late.problems[0]?.certificate, leaf.id);
  const early = buildChain(leaf, { now: T('2026-01-01T00:00:00Z'), roots: [root], intermediates: [inter] });
  assert.deepEqual(new Set(early.problems.map((p) => p.code)), new Set(['not-yet-valid']));
  assert.equal(early.problems.length, 3, 'leaf, intermediate and root are all not yet valid');
  const edge = buildChain(leaf, { now: leaf.notAfter, roots: [root], intermediates: [inter] });
  assert.equal(edge.trusted, true, 'valid through the last second');
  assert.equal(buildChain(leaf, { now: leaf.notAfter + 1, roots: [root], intermediates: [inter] }).trusted, false);
});

test('unknown critical extensions, wrong purpose and wrong host are chain problems', () => {
  const crit = { ...leaf, unknownCriticalExtensions: ['1.2.3.4'] };
  assert.ok(buildChain(crit, { now: NOW, roots: [root], intermediates: [inter] }).problems.some((p) => p.code === 'unknown-critical-extension'));
  const codeOnly = { ...leaf, extendedKeyUsage: ['codeSigning'] };
  assert.ok(buildChain(codeOnly, { now: NOW, roots: [root], intermediates: [inter], purpose: 'server' }).problems.some((p) => p.code === 'wrong-purpose'));
  assert.equal(buildChain(leaf, { now: NOW, roots: [root], intermediates: [inter], purpose: 'client' }).trusted, true);
  const wrongHost = buildChain(leaf, { now: NOW, roots: [root], intermediates: [inter], host: 'evil.example.org' });
  assert.deepEqual(wrongHost.problems.map((p) => p.code), ['host-mismatch']);
  assert.equal(buildChain(leaf, { now: NOW, roots: [root], intermediates: [inter], host: 'WWW.Example.com.' }).trusted, true);
});

test('chain depth is bounded and a loop of issuers cannot hang the builder', () => {
  const a = { ...inter, id: 'a'.repeat(64), subject: [[{ type: 'CN', oid: '2.5.4.3', value: 'A' }]], issuer: [[{ type: 'CN', oid: '2.5.4.3', value: 'B' }]], pathLen: undefined, authorityKeyId: undefined, subjectKeyId: undefined };
  const b = { ...a, id: 'b'.repeat(64), subject: a.issuer, issuer: a.subject };
  const l = { ...leaf, issuer: a.subject, authorityKeyId: undefined };
  const c = buildChain(l, { now: NOW, roots: [root], intermediates: [a, b] });
  assert.equal(c.trusted, false);
  assert.ok(c.certificates.length <= 3);
});

test('host matching follows RFC 9525: wildcards cover one label only, never partial, never a bare TLD', () => {
  const yes = ['www.example.com', 'WWW.EXAMPLE.COM', 'example.com', 'www.example.com.', 'x.api.example.com', 'X-1.api.example.com'];
  const no = ['api.example.com', 'a.b.api.example.com', 'mail.example.com', 'example.org', 'wwwXexample.com', '', '.example.com', 'www..example.com', 'www.example.com\u0000.evil.net', ' www.example.com'];
  for (const h of yes) assert.equal(certificateCoversHost(leaf, h), true, h);
  for (const h of no) assert.equal(certificateCoversHost(leaf, h), false, JSON.stringify(h));
  const mk = (...dns: string[]): typeof leaf => ({ ...leaf, dnsNames: dns, ipAddresses: [] });
  assert.equal(certificateCoversHost(mk('*.com'), 'example.com'), false, 'a wildcard over a whole TLD is refused');
  assert.equal(certificateCoversHost(mk('f*.example.com'), 'foo.example.com'), false, 'partial wildcard');
  assert.equal(certificateCoversHost(mk('*o.example.com'), 'foo.example.com'), false);
  assert.equal(certificateCoversHost(mk('www.*.example.com'), 'www.x.example.com'), false, 'wildcard not in the left-most label');
  assert.equal(certificateCoversHost(mk('*.*.example.com'), 'a.b.example.com'), false);
  assert.equal(certificateCoversHost(mk('*.example.com'), '.example.com'), false);
  assert.equal(certificateCoversHost(mk('*.example.com'), 'a.example.com'), true);
  assert.equal(certificateCoversHost(mk('*.example.com'), 'example.com'), false, 'the wildcard needs a label to stand for');
});

test('the Common Name is ignored; IP addresses match only iPAddress entries; IPv6 is compared as bytes', () => {
  const cnOnly = { ...leaf, dnsNames: [], subject: [[{ type: 'CN', oid: '2.5.4.3', value: 'legacy.example.net' }]] };
  assert.equal(certificateCoversHost(cnOnly, 'legacy.example.net'), false);
  assert.equal(certificateCoversHost(leaf, '192.0.2.10'), true);
  assert.equal(certificateCoversHost(leaf, '192.0.2.11'), false);
  assert.equal(certificateCoversHost(leaf, '2001:db8::1'), true);
  assert.equal(certificateCoversHost(leaf, '2001:0db8:0:0:0:0:0:1'), true);
  assert.equal(certificateCoversHost(leaf, '2001:db8::2'), false);
  const dnsIp = { ...leaf, dnsNames: ['192.0.2.10'], ipAddresses: [] };
  assert.equal(certificateCoversHost(dnsIp, '192.0.2.10'), false, 'a dNSName that looks like an address is not an address');
  assert.deepEqual([...parseIp('::1')!], [...Array(15).fill(0), 1]);
  assert.deepEqual([...parseIp('::ffff:1.2.3.4')!].slice(10), [255, 255, 1, 2, 3, 4]);
  assert.equal(parseIp('1.2.3'), undefined);
  assert.equal(parseIp('01.2.3.4'), undefined);
  assert.equal(parseIp('1::2::3'), undefined);
  assert.equal(parseIp('12345::1'), undefined);
  assert.equal(normalizeHost('Bücher.example'), 'xn--bcher-kva.example');
});

test('names compare the RFC 5280 way, and print as RFC 4514', () => {
  const a = [[{ type: 'CN', oid: '2.5.4.3', value: '  Example   Root  CA ' }]];
  const b = [[{ type: 'CN', oid: '2.5.4.3', value: 'example root ca' }]];
  assert.equal(nameKey(a), nameKey(b));
  assert.notEqual(nameKey(a), nameKey([[{ type: 'CN', oid: '2.5.4.3', value: 'other' }]]));
  assert.equal(nameToString([[{ type: 'O', oid: '2.5.4.10', value: 'A, B + "C"' }], [{ type: 'CN', oid: '2.5.4.3', value: 'x' }]]), 'CN=x,O=A\\, B \\+ \\"C\\"');
  assert.equal(nameToString([[{ type: 'CN', oid: '2.5.4.3', value: '#hash' }]]), 'CN=\\#hash');
});

function store(): CertStore {
  const s = new CertStore({ roots: [root] });
  s.add(PEM.int);
  return s;
}

test('the store de-duplicates, bounds its size and lists soonest-expiring first', () => {
  const s = store();
  s.add(PEM.leaf, { hosts: ['www.example.com'] });
  s.add(PEM.leaf, { label: 'web' });
  s.add(parseCertificate(PEM.other));
  assert.equal(s.size, 3);
  assert.deepEqual(s.list().map((c) => c.subjectText.split(',')[0]), ['CN=Other Self Signed', 'CN=www.example.com', 'CN=Example Issuing CA 1']);
  assert.equal(s.get(leaf.id)?.id, leaf.id);
  assert.equal(s.remove(leaf.id), true);
  assert.equal(s.remove(leaf.id), false);
  assert.equal(s.size, 2);
  const tiny = new CertStore({ maxEntries: 1 });
  tiny.add(PEM.ca);
  assert.throws(() => tiny.add(PEM.int), /store is full/);
  tiny.add(PEM.ca);
  assert.equal(new CertStore().addBundle(`${PEM.ca}${PEM.int}`).length, 2);
  assert.throws(() => new CertStore({ thresholdsDays: [-1] }), CertError);
  assert.throws(() => store().chain('nope', NOW), /no such certificate/);
});

test('the store builds chains from what it holds, and finds the certificate that covers a host', () => {
  const s = store();
  s.add(PEM.leaf);
  s.add(PEM.forged);
  assert.equal(s.chain(leaf.id, NOW).trusted, true);
  assert.deepEqual(s.covering('www.example.com', NOW).map((c) => c.id), [leaf.id]);
  assert.deepEqual(s.covering('forged.example.com', NOW), [], 'a forged certificate never covers anything');
  assert.deepEqual(s.covering('www.example.com', T('2027-06-01T00:00:00Z')), [], 'expired');
  assert.deepEqual(s.covering('nothing.example.org', NOW), []);
});

test('expiry alerts step up through the thresholds with a stable key per step', () => {
  const s = store();
  s.add(PEM.leaf, { label: 'web' });
  const at = (days: number) => s.alerts(leaf.notAfter - days * DAY).filter((a) => a.certificate === leaf.id && a.kind === 'expiring');
  assert.deepEqual(at(60), []);
  assert.deepEqual(at(29.5).map((a) => [a.severity, a.dedupeKey.split(':').pop(), a.daysLeft]), [['notice', '30', 29]]);
  assert.equal(at(29.5)[0]?.dedupeKey, at(20)[0]?.dedupeKey, 'same threshold, same key: send once');
  assert.deepEqual(at(10).map((a) => [a.severity, a.dedupeKey.split(':').pop()]), [['warning', '14']]);
  assert.deepEqual(at(5).map((a) => [a.severity, a.dedupeKey.split(':').pop()]), [['high', '7']]);
  assert.deepEqual(at(0.5).map((a) => [a.severity, a.dedupeKey.split(':').pop()]), [['critical', '1']]);
  assert.equal(at(0.5)[0]?.label, 'web');
  assert.match(at(10)[0]!.message, /expires in 10 day/);
});

test('expired and not-yet-valid certificates are alerts of their own; CA expiry is not reported as a leaf alert', () => {
  const s = store();
  s.add(PEM.leaf);
  const after = s.alerts(leaf.notAfter + 3 * DAY);
  const exp = after.find((a) => a.kind === 'expired');
  assert.deepEqual([exp?.severity, exp?.certificate, exp?.dedupeKey], ['critical', leaf.id, `${leaf.id}:expired`]);
  assert.match(exp!.message, /expired 3 day/);
  const before = s.alerts(T('2026-11-28T06:00:00Z'));
  assert.ok(before.some((a) => a.kind === 'not-yet-valid' && a.certificate === leaf.id));
  assert.equal(after.filter((a) => a.certificate === inter.id && a.kind === 'expired').length, 0);
  assert.equal(s.alerts(NOW).filter((a) => a.certificate === leaf.id).length, 0, 'a healthy certificate raises nothing');
});

test('chain-broken, missing names and must-staple without a responder are reported, most severe first', () => {
  const s = new CertStore({ roots: [root] });
  s.add(PEM.leaf, { hosts: ['www.example.com', 'shop.example.com'] });
  const a = s.alerts(NOW);
  assert.deepEqual(a.map((x) => x.kind), ['chain-broken', 'san-missing']);
  assert.equal(a[1]?.message, 'CN=www.example.com does not cover shop.example.com');
  assert.equal(a[1]?.dedupeKey, `${leaf.id}:san-missing:shop.example.com`);
  assert.match(a[0]!.message, /no certificate for the issuer/);
  const noResponder = { ...leaf, id: 'z'.repeat(64), ocspUrls: [] };
  const s2 = new CertStore({ roots: [root] });
  s2.add(inter);
  s2.add(noResponder);
  const b = s2.alerts(NOW);
  assert.equal(b[0]?.kind, 'must-staple-unavailable');
  assert.equal(b[0]?.severity, 'critical');
});

test('OCSP stapling plan: nothing yet, fresh, refresh due, stale, revoked, and no responder', () => {
  const s = store();
  s.add(PEM.leaf);
  const plan = (now: number) => s.staplingPlan(now).find((p) => p.certificate === leaf.id)!;
  const none = plan(NOW);
  assert.deepEqual([none.state, none.risk, none.refreshAt, none.ocspUrl], ['no-response', 'critical', NOW, 'http://ocsp.example.com']);
  s.recordOcsp(leaf.id, { status: 'good', thisUpdate: NOW, nextUpdate: NOW + 4 * DAY });
  const fresh = plan(NOW + DAY);
  assert.deepEqual([fresh.state, fresh.risk, fresh.refreshAt], ['fresh', 'none', NOW + 2 * DAY]);
  assert.equal(plan(NOW + 2 * DAY).state, 'refresh-due');
  assert.equal(plan(NOW + 2 * DAY).risk, 'high');
  const stale = plan(NOW + 4 * DAY);
  assert.deepEqual([stale.state, stale.risk], ['stale', 'critical']);
  s.recordOcsp(leaf.id, { status: 'revoked', thisUpdate: NOW, nextUpdate: NOW + DAY });
  assert.deepEqual([plan(NOW).state, plan(NOW).risk], ['revoked', 'critical']);
  const plain = { ...leaf, id: 'p'.repeat(64), mustStaple: false, ocspUrls: [] as string[] };
  s.add(plain);
  const p = s.staplingPlan(NOW).find((e) => e.certificate === plain.id)!;
  assert.deepEqual([p.state, p.risk], ['not-available', 'none']);
  const optional = { ...leaf, id: 'q'.repeat(64), mustStaple: false };
  s.add(optional);
  assert.deepEqual([s.staplingPlan(NOW).find((e) => e.certificate === optional.id)!.state, s.staplingPlan(NOW).find((e) => e.certificate === optional.id)!.risk], ['no-response', 'warning']);
  assert.equal(s.staplingPlan(NOW).every((e) => e.certificate !== inter.id), true, 'CA certificates are not stapled');
  assert.throws(() => s.recordOcsp(leaf.id, { status: 'good', thisUpdate: NOW, nextUpdate: NOW }), /expire after/);
  assert.throws(() => s.recordOcsp('nope', { status: 'good', thisUpdate: NOW, nextUpdate: NOW + 1 }), /no such certificate/);
});
