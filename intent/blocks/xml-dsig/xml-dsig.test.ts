import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, randomBytes, sign as nodeSign, type KeyObject } from 'node:crypto';
import { bitString, boolean, explicit, integer, octetString, oid, oidOf, sequence, set, time, toPem, utf8String } from '../asn1-der/index.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readXml, exclusiveC14n, sign, verifyDocument, verifyElement, childNamed, childEls, textOf, NS_DSIG, ALG, XmlDsigError } from './index.ts';

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
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SAML = 'urn:s';
const DOC = `<r:Response xmlns:r="urn:r" xmlns:s="urn:s" ID="_resp"><s:Issuer>idp</s:Issuer><s:Assertion ID="_a1"><s:Subject>alice</s:Subject></s:Assertion></r:Response>`;
const issuer = { ns: SAML, local: 'Issuer' };
const bad = (f: () => unknown, re: RegExp) => assert.throws(f, (e: unknown) => e instanceof XmlDsigError && re.test((e as Error).message), String(re));

const hasXmllint = spawnSync('xmllint', ['--version']).status !== null;
function xmllintC14n(xml: string): string {
  const d = mkdtempSync(join(tmpdir(), 'c14n-'));
  try {
    writeFileSync(join(d, 'in.xml'), xml);
    const r = spawnSync('xmllint', ['--exc-c14n', join(d, 'in.xml')], { encoding: 'utf8' });
    return r.stdout.replace(/\n$/, '');
  } finally {
    rmSync(d, { recursive: true });
  }
}

test('exclusive c14n: hand-checked cases', () => {
  const c = (xml: string, o = {}) => exclusiveC14n(readXml(xml).root, o);
  assert.equal(c('<a:x xmlns:a="u1" xmlns:b="u2"><b:y/></a:x>'), '<a:x xmlns:a="u1"><b:y xmlns:b="u2"></b:y></a:x>');
  assert.equal(c('<a xmlns="urn:d"><b xmlns=""><c/></b></a>'), '<a xmlns="urn:d"><b xmlns=""><c></c></b></a>');
  assert.equal(c('<a z="1" b="2" xmlns:q="urn:q" q:m="3"/>'), '<a xmlns:q="urn:q" b="2" z="1" q:m="3"></a>');
  assert.equal(c('<a x=\'a"b&#9;&#10;&lt;\'>1 &amp; 2 &gt; 0 &#13;</a>'), '<a x="a&quot;b&#x9;&#xA;&lt;">1 &amp; 2 &gt; 0 &#xD;</a>');
  assert.equal(c('<a><![CDATA[<x>&]]></a>'), '<a>&lt;x&gt;&amp;</a>');
});

test('exclusive c14n of a subtree takes visible namespaces from the ancestors, and honours PrefixList', () => {
  const d = readXml('<d xmlns="urn:d" xmlns:p="urn:p" xmlns:x="urn:x"><p:y a="1"><z/></p:y></d>');
  const y = childEls(d.root)[0]!;
  assert.equal(exclusiveC14n(y), '<p:y xmlns:p="urn:p" a="1"><z xmlns="urn:d"></z></p:y>');
  assert.equal(exclusiveC14n(y, { inclusivePrefixes: ['x'] }), '<p:y xmlns:p="urn:p" xmlns:x="urn:x" a="1"><z xmlns="urn:d"></z></p:y>');
  assert.equal(exclusiveC14n(y, { inclusivePrefixes: ['#default'] }), '<p:y xmlns="urn:d" xmlns:p="urn:p" a="1"><z></z></p:y>');
});

test('exclusive c14n agrees with xmllint --exc-c14n on varied documents', { skip: !hasXmllint }, () => {
  const docs = [
    '<a xmlns:z="urn:z" xmlns:b="urn:b"><b:c b:attr="1" z:attr="2" plain="3"/>text &amp; more<d xmlns="urn:d"><e/></d></a>',
    '<?xml version="1.0"?>\n<root>\n  <x   a = "1"   b=\'2\' />\n  <y>\t\n</y>\n</root>',
    '<a xmlns="urn:one"><b xmlns="urn:two"><c xmlns=""><d/></c></b></a>',
    '<p:a xmlns:p="urn:p" xmlns:q="urn:q"><q:b q:id="1"><p:c/></q:b>tail</p:a>',
    '<a>é &#x1F600; &lt;&gt;&quot;\'</a>',
    '<a v="&#9;&#10;&#13;x"/>',
    '<s:E xmlns:s="urn:s" xmlns:u="urn:unused"><s:Body xmlns:s="urn:other"><s:x/></s:Body></s:E>',
  ];
  for (const d of docs) assert.equal(exclusiveC14n(readXml(d).root), xmllintC14n(d), d);
});

test('literal tab and newline in an attribute value normalise to a space, character references do not', () => {
  assert.equal(exclusiveC14n(readXml('<a x="1\t2\n3&#9;4"/>').root), '<a x="1 2 3&#x9;4"></a>');
});

test('the reader merges text around comments, so a comment cannot split a value', () => {
  const d = readXml('<a>user@evil.com<!-- -->.good</a>');
  assert.equal(textOf(d.root), 'user@evil.com.good');
  assert.equal(d.root.children.length, 1);
  assert.equal(exclusiveC14n(d.root), '<a>user@evil.com.good</a>');
});

test('the reader refuses what it should', () => {
  bad(() => readXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), /document type/);
  bad(() => readXml('<a>&x;</a>'), /not defined/);
  bad(() => readXml('<a>a & b</a>'), /bare &/);
  bad(() => readXml('<a>&#0;</a>'), /character/);
  bad(() => readXml('<a><?pi x?></a>'), /processing/);
  bad(() => readXml('<a ID="1"><b ID="1"/></a>'), /more than once/);
  bad(() => readXml('<a x:y="1"/>'), /undeclared prefix/);
  bad(() => readXml('<x:a/>'), /undeclared prefix/);
  bad(() => readXml('<a x="1" x="2"/>'), /twice/);
  bad(() => readXml('<a/><b/>'), /more than one root/);
  bad(() => readXml('<a><b></a>'), /unexpected/);
  bad(() => readXml('<a x="<"/>'), /"<"/);
  bad(() => readXml('<a>'.repeat(200)), /deeply/);
  bad(() => readXml('<a>' + 'x'.repeat(2_000_000) + '</a>'), /too large/);
  bad(() => readXml('<a>\u0001</a>'), /control/);
  bad(() => readXml('<a xmlns:p=""/>'), /namespace declaration/);
  bad(() => readXml('text<a/>'), /outside the root/);
  assert.equal(readXml('﻿<?xml version="1.0"?><a/>').root.local, 'a');
  assert.equal(readXml('<a ID="x" id="y"/>').ids.size, 2, 'different attribute names are different attributes');
});

test('sign and verify: RSA with a pinned key, signature after Issuer', () => {
  const signed = sign(DOC, { privateKey: rsa.privateKey, id: '_a1' });
  assert.match(signed, /<s:Assertion ID="_a1"><ds:Signature/);
  const doc = readXml(signed);
  const a = doc.ids.get('_a1')!;
  const v = verifyElement(doc, a, { keys: [rsa.publicKey] });
  assert.equal(v.signatureAlgorithm, ALG.rsaSha256);
  assert.equal(textOf(childNamed(v.element, SAML, 'Subject')!), 'alice');
  assert.equal(v.signed, a);
  const root = sign(DOC, { privateKey: rsa.privateKey, after: issuer });
  assert.match(root, /<s:Issuer>idp<\/s:Issuer><ds:Signature/);
  const r = verifyDocument(root, { keys: [rsa.publicKey], after: issuer });
  assert.equal(r.element.local, 'Response');
  assert.ok(!r.canonical.includes('Signature'), 'the digest is over the content without its signature');
});

test('sign and verify: ECDSA P-256 and the SHA-384 / SHA-512 RSA variants', () => {
  const e = sign(DOC, { privateKey: ec.privateKey });
  assert.equal(verifyDocument(e, { keys: [ec.publicKey] }).signatureAlgorithm, ALG.ecdsaSha256);
  const e5 = sign(DOC, { privateKey: ec.privateKey, algorithm: 'ecdsa-sha512' });
  assert.equal(verifyDocument(e5, { keys: [ec.publicKey] }).digestAlgorithm, ALG.sha512);
  for (const algorithm of ['rsa-sha384', 'rsa-sha512'] as const) assert.match(verifyDocument(sign(DOC, { privateKey: rsa.privateKey, algorithm }), { keys: [rsa.publicKey] }).signatureAlgorithm, new RegExp(algorithm));
});

test('verification fails when the content, the SignedInfo, or the key is wrong', () => {
  const signed = sign(DOC, { privateKey: rsa.privateKey, id: '_a1' });
  bad(() => verifyDocument(signed.replace('>alice<', '>mallory<'), { keys: [rsa.publicKey] }), /./); // root has no signature
  const doc1 = readXml(signed.replace('>alice<', '>mallory<'));
  bad(() => verifyElement(doc1, doc1.ids.get('_a1')!, { keys: [rsa.publicKey] }), /digest does not match/);
  const doc2 = readXml(signed.replace(/(<ds:DigestValue>)(.)/, (_m, a: string, c: string) => `${a}${c === 'A' ? 'B' : 'A'}`));
  bad(() => verifyElement(doc2, doc2.ids.get('_a1')!, { keys: [rsa.publicKey] }), /digest does not match/);
  const doc3 = readXml(signed);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  bad(() => verifyElement(doc3, doc3.ids.get('_a1')!, { keys: [other.publicKey] }), /not valid for any trusted key/);
  bad(() => verifyElement(doc3, doc3.ids.get('_a1')!, {}), /no trusted key/);
});

test('algorithm and key-type confusion are refused', () => {
  const signed = sign(DOC, { privateKey: ec.privateKey, id: '_a1' });
  const doc = readXml(signed);
  const a = doc.ids.get('_a1')!;
  bad(() => verifyElement(doc, a, { keys: [rsa.publicKey] }), /no trusted key of the right type/);
  const hmac = readXml(signed.replace(ALG.ecdsaSha256, 'http://www.w3.org/2000/09/xmldsig#hmac-sha1'));
  bad(() => verifyElement(hmac, hmac.ids.get('_a1')!, { keys: [ec.publicKey] }), /signature algorithm .* not accepted/);
  const sha1 = readXml(signed.replace(ALG.ecdsaSha256, ALG.rsaSha1));
  bad(() => verifyElement(sha1, sha1.ids.get('_a1')!, { keys: [rsa.publicKey] }), /not accepted/);
  const dsha1 = readXml(signed.replace(ALG.sha256, ALG.sha1));
  bad(() => verifyElement(dsha1, dsha1.ids.get('_a1')!, { keys: [ec.publicKey] }), /digest algorithm/);
  const c14n = readXml(signed.replace(`<ds:CanonicalizationMethod Algorithm="${ALG.excC14n}">`, '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315">'));
  bad(() => verifyElement(c14n, c14n.ids.get('_a1')!, { keys: [ec.publicKey] }), /only exclusive c14n/);
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const s1k = sign(DOC, { privateKey: small.privateKey, id: '_a1' });
  const d1k = readXml(s1k);
  bad(() => verifyElement(d1k, d1k.ids.get('_a1')!, { keys: [small.publicKey] }), /not valid for any trusted key/);
  assert.doesNotThrow(() => verifyElement(d1k, d1k.ids.get('_a1')!, { keys: [small.publicKey], minRsaBits: 1024 }));
});

test('wrapping: a signature that covers a different element than the one it sits in is refused', () => {
  const signed = sign(DOC, { privateKey: rsa.privateKey, id: '_a1' });
  // lift the signature of _a1 into a forged assertion and point everything at the forged one
  const sigXml = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signed)![0];
  const forged = `<r:Response xmlns:r="urn:r" xmlns:s="urn:s" ID="_resp"><s:Issuer>idp</s:Issuer><s:Assertion ID="_evil">${sigXml}<s:Subject>mallory</s:Subject></s:Assertion><s:Assertion ID="_a1"><s:Subject>alice</s:Subject></s:Assertion></r:Response>`;
  const doc = readXml(forged);
  bad(() => verifyElement(doc, doc.ids.get('_evil')!, { keys: [rsa.publicKey] }), /does not point at the element/);
  // the genuine assertion has lost its signature, so it is not accepted either
  bad(() => verifyElement(doc, doc.ids.get('_a1')!, { keys: [rsa.publicKey] }), /is not signed/);
});

test('wrapping: moving the signed assertion elsewhere leaves the checked position unsigned', () => {
  const signed = sign(DOC, { privateKey: rsa.privateKey, id: '_a1' });
  const asn = /<s:Assertion ID="_a1">[\s\S]*<\/s:Assertion>/.exec(signed)![0];
  const wrapped = `<r:Response xmlns:r="urn:r" xmlns:s="urn:s" ID="_resp"><s:Issuer>idp</s:Issuer><s:Assertion ID="_new"><s:Subject>mallory</s:Subject></s:Assertion><r:Extensions>${asn}</r:Extensions></r:Response>`;
  const doc = readXml(wrapped);
  bad(() => verifyElement(doc, doc.ids.get('_new')!, { keys: [rsa.publicKey] }), /is not signed/);
  const ok = verifyElement(doc, doc.ids.get('_a1')!, { keys: [rsa.publicKey] });
  assert.equal(ok.signed.parent?.local, 'Extensions', 'verification names exactly what was signed: callers check its position');
  assert.equal(textOf(childNamed(ok.element, SAML, 'Subject')!), 'alice');
});

test('wrapping: duplicate IDs, two signatures, extra parts and bad URIs', () => {
  bad(() => readXml('<a ID="x"><b ID="x"/></a>'), /more than once/);
  const signed = sign(DOC, { privateKey: rsa.privateKey, id: '_a1' });
  const sigXml = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signed)![0];
  const two = readXml(signed.replace(sigXml, sigXml + sigXml));
  bad(() => verifyElement(two, two.ids.get('_a1')!, { keys: [rsa.publicKey] }), /more than one Signature/);
  const obj = readXml(signed.replace('</ds:Signature>', '<ds:Object><x/></ds:Object></ds:Signature>'));
  bad(() => verifyElement(obj, obj.ids.get('_a1')!, { keys: [rsa.publicKey] }), /unexpected <Object>/);
  const swapped = readXml(signed.replace(/(<ds:SignedInfo>[\s\S]*<\/ds:SignedInfo>)(<ds:SignatureValue>[^<]*<\/ds:SignatureValue>)/, '$2$1'));
  bad(() => verifyElement(swapped, swapped.ids.get('_a1')!, { keys: [rsa.publicKey] }), /SignedInfo, SignatureValue/);
  for (const uri of ['http://evil.example/x', '#xpointer(/)', '#', 'file:///etc/passwd']) {
    const d = readXml(signed.replace('URI="#_a1"', `URI="${uri}"`));
    bad(() => verifyElement(d, d.ids.get('_a1')!, { keys: [rsa.publicKey] }), /URI|xpointer/);
  }
  const missing = readXml(signed.replace('URI="#_a1"', 'URI="#nope"'));
  bad(() => verifyElement(missing, missing.ids.get('_a1')!, { keys: [rsa.publicKey] }), /not in the document/);
  const noEnv = readXml(signed.replace(`<ds:Transform Algorithm="${ALG.enveloped}"/>`, ''));
  bad(() => verifyElement(noEnv, noEnv.ids.get('_a1')!, { keys: [rsa.publicKey] }), /enveloped-signature transform is missing/);
  const xslt = readXml(signed.replace(`<ds:Transform Algorithm="${ALG.enveloped}"/>`, '<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xslt-19991116"/>'));
  bad(() => verifyElement(xslt, xslt.ids.get('_a1')!, { keys: [rsa.publicKey] }), /transform .* not accepted/);
});

test('allowTarget permits a signature over another element of the same document, on request only', () => {
  const signed = sign(DOC, { privateKey: rsa.privateKey, id: '_a1' });
  const sigXml = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signed)![0];
  const moved = readXml(`<r:Response xmlns:r="urn:r" xmlns:s="urn:s" ID="_resp"><s:Issuer>idp</s:Issuer>${sigXml}<s:Assertion ID="_a1"><s:Subject>alice</s:Subject></s:Assertion></r:Response>`);
  bad(() => verifyElement(moved, moved.root, { keys: [rsa.publicKey] }), /does not point/);
  const v = verifyElement(moved, moved.root, { keys: [rsa.publicKey], allowTarget: (t) => t.local === 'Assertion' });
  assert.equal(v.signed.local, 'Assertion');
});

test('position rule: the Signature must follow Issuer', () => {
  const after = sign(DOC, { privateKey: rsa.privateKey, after: issuer });
  assert.doesNotThrow(() => verifyDocument(after, { keys: [rsa.publicKey], after: issuer }));
  const first = sign(DOC, { privateKey: rsa.privateKey });
  assert.match(first, /<r:Response[^>]*><ds:Signature/);
  bad(() => verifyDocument(first, { keys: [rsa.publicKey], after: issuer }), /required position/);
  const noIssuer = sign('<r:R xmlns:r="urn:r" ID="x"><r:A/></r:R>', { privateKey: rsa.privateKey });
  assert.doesNotThrow(() => verifyDocument(noIssuer, { keys: [rsa.publicKey], after: issuer }), 'first child when there is no Issuer');
});

test('certificates: KeyInfo is trusted only when it matches a pinned certificate; validity is checked', () => {
  const signed = sign(DOC, { privateKey: KEY, certificate: CERT });
  assert.match(signed, /<ds:X509Certificate>/);
  assert.equal(verifyDocument(signed, { certificates: [CERT] }).keyFingerprint.length, 64);
  bad(() => verifyDocument(signed, {}), /no trusted key/);
  const foreign = createPublicKey(CERT);
  bad(() => verifyDocument(signed, { keys: [ec.publicKey] }), /not valid for any trusted key/);
  assert.doesNotThrow(() => verifyDocument(signed, { keys: [foreign] }));
  bad(() => verifyDocument(signed, { certificates: [CERT], now: () => Date.parse('2200-01-01') }), /no trusted key/);
  assert.doesNotThrow(() => verifyDocument(signed, { certificates: [CERT], now: () => Date.parse('2200-01-01'), checkValidity: false }));
  // a different certificate smuggled into KeyInfo is ignored: only the pinned key counts, and it does not verify
  const swapped = readXml(signed.replace(/(<ds:X509Certificate>)[^<]*/, `$1${Buffer.from('not a cert').toString('base64')}`));
  assert.doesNotThrow(() => verifyElement(swapped, swapped.root, { certificates: [CERT] }), 'falls back to the pinned certificate');
  bad(() => verifyElement(swapped, swapped.root, { keys: [ec.publicKey] }), /not valid/);
});

test('InclusiveNamespaces PrefixList round-trips through sign and verify', () => {
  const doc = '<r:R xmlns:r="urn:r" xmlns:q="urn:q" ID="x"><r:A q:t="1">v</r:A></r:R>';
  const signed = sign(doc, { privateKey: ec.privateKey, inclusivePrefixes: ['q'] });
  assert.match(signed, /PrefixList="q"/);
  assert.doesNotThrow(() => verifyDocument(signed, { keys: [ec.publicKey] }));
  const v = verifyDocument(signed, { keys: [ec.publicKey] });
  assert.match(v.canonical, /xmlns:q="urn:q"/);
});

test('whitespace and entity forms that do not change the infoset do not break the signature', () => {
  const signed = sign('<r:R xmlns:r="urn:r" ID="x"><r:A b="1" a="2">x &amp; y</r:A></r:R>', { privateKey: rsa.privateKey });
  const rewritten = signed.replace('<r:A b="1" a="2">', "<r:A   a='2'   b=\"1\" >").replace('x &amp; y', 'x <![CDATA[&]]> y').replace(/\n/g, '\r\n');
  assert.doesNotThrow(() => verifyDocument(rewritten, { keys: [rsa.publicKey] }));
});

test('sign refuses unusable targets', () => {
  bad(() => sign(DOC, { privateKey: rsa.privateKey, id: 'nope' }), /not in the document/);
  bad(() => sign(sign(DOC, { privateKey: rsa.privateKey }), { privateKey: rsa.privateKey }), /already has a Signature/);
  bad(() => sign('<a xmlns="urn:a"/>', { privateKey: rsa.privateKey }), /no ID|empty element/);
});

void NS_DSIG;
