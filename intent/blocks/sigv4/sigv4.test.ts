import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ChunkSigner, SigV4Error, awsEncode, canonicalPath, canonicalQuery, chunkedLength, decodeChunked, encodeChunked, hashPayload, presign, sign, signingKey, verify } from './index.ts';

// Keys are generated for each run. The published AWS signatures depend on AWS's documentation secret, so they are
// not asserted here; what the documentation publishes without a secret (canonical requests, their hashes, strings
// to sign) is asserted, and signatures are checked against a reference HMAC chain written out below from the AWS text.
const S3 = { accessKeyId: 'TESTKEYS3', secretAccessKey: randomBytes(30).toString('base64') };
const GENERAL = { accessKeyId: 'TESTKEYGEN', secretAccessKey: randomBytes(30).toString('base64') };
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
const refKey = (secret: string, day: string, region: string, service: string) => hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
const refSig = (secret: string, day: string, region: string, service: string, sts: string) => createHmac('sha256', refKey(secret, day, region, service)).update(sts).digest('hex');
const sha = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const D = new Date('2013-05-24T00:00:00Z');
const s3scope = { region: 'us-east-1', service: 's3' };
const lookup = (id: string) => (id === S3.accessKeyId ? S3.secretAccessKey : id === GENERAL.accessKeyId ? GENERAL.secretAccessKey : undefined);

test('AWS get-vanilla test-suite vector (service "service"): published canonical request and string to sign', () => {
  const s = sign({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {} }, GENERAL, { now: new Date('2015-08-30T12:36:00Z'), region: 'us-east-1', service: 'service' });
  assert.equal(s.canonicalRequest, 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(s.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  assert.equal(s.signature, refSig(GENERAL.secretAccessKey, '20150830', 'us-east-1', 'service', s.stringToSign));
  assert.equal(s.authorization, `AWS4-HMAC-SHA256 Credential=TESTKEYGEN/20150830/us-east-1/service/aws4_request,SignedHeaders=host;x-amz-date,Signature=${s.signature}`);
});

test('AWS S3 example: GET Object with a Range header (published canonical-request hash)', () => {
  const s = sign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' } }, S3, { now: D, ...s3scope });
  assert.equal(s.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
  assert.equal(s.stringToSign.split('\n')[3], '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
  assert.equal(s.signature, refSig(S3.secretAccessKey, '20130524', 'us-east-1', 's3', s.stringToSign));
});

test('AWS S3 example: PUT Object with an encoded key and a storage class', () => {
  const body = 'Welcome to Amazon S3.';
  assert.equal(hashPayload(body), '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const s = sign({ method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, body }, S3, { now: D, ...s3scope });
  assert.equal(s.signedHeaders, 'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
  assert.match(s.canonicalRequest, /^PUT\n\/test%24file.text\n/);
  assert.equal(s.stringToSign.split('\n')[3], '9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d', 'the published canonical-request hash');
  assert.equal(s.signature, refSig(S3.secretAccessKey, '20130524', 'us-east-1', 's3', s.stringToSign));
});

test('AWS S3 example: presigned GET URL (published canonical request), and it verifies', () => {
  const url = presign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt' }, S3, { now: D, expiresSec: 86400, ...s3scope });
  const q = new URL(url).searchParams;
  assert.equal(q.get('X-Amz-Credential'), 'TESTKEYS3/20130524/us-east-1/s3/aws4_request');
  assert.equal(q.get('X-Amz-SignedHeaders'), 'host');
  const canonical = ['GET', '/test.txt', 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=TESTKEYS3%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host', 'host:examplebucket.s3.amazonaws.com', '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = `AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n${sha(canonical)}`;
  assert.equal(q.get('X-Amz-Signature'), refSig(S3.secretAccessKey, '20130524', 'us-east-1', 's3', sts), 'the canonical request is the one the AWS documentation shows');
  const who = verify({ method: 'GET', url, headers: {} }, { now: new Date('2013-05-24T10:00:00Z'), secretFor: lookup });
  assert.equal(who.presigned, true);
  assert.equal(who.accessKeyId, S3.accessKeyId);
});

test('AWS S3 example: chunked upload signature chain (seed, two chunks, final) against the documented formula', () => {
  const body = new Uint8Array(66_560).fill(97);
  const s = sign(
    { method: 'PUT', url: 'https://s3.amazonaws.com/examplebucket/chunkObject.txt', headers: { 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'Content-Encoding': 'aws-chunked', 'x-amz-decoded-content-length': '66560', 'Content-Length': '66824' }, body },
    S3,
    { now: D, ...s3scope, payloadHash: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' },
  );
  const chain = (prev: string, chunk: Uint8Array) => refSig(S3.secretAccessKey, '20130524', 'us-east-1', 's3', ['AWS4-HMAC-SHA256-PAYLOAD', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', prev, sha(''), sha(chunk)].join('\n'));
  const c = new ChunkSigner(s.signature, S3.secretAccessKey, '20130524T000000Z', s3scope);
  const s1 = c.next(body.subarray(0, 65_536));
  const s2 = c.next(body.subarray(65_536));
  const s3 = c.next(new Uint8Array(0));
  assert.equal(s1, chain(s.signature, body.subarray(0, 65_536)));
  assert.equal(s2, chain(s1, body.subarray(65_536)));
  assert.equal(s3, chain(s2, new Uint8Array(0)));
  assert.equal(chunkedLength(66_560), 66_824, 'the example Content-Length');
  const framed = encodeChunked(body, s.signature, S3.secretAccessKey, '20130524T000000Z', s3scope);
  assert.equal(framed.length, 66_824);
  assert.deepEqual(decodeChunked(framed, s.signature, S3.secretAccessKey, '20130524T000000Z', s3scope, { decodedLength: 66_560 }), Buffer.from(body));
});

test('signing key derivation follows the documented HMAC chain', () => {
  const secret = randomBytes(30).toString('base64');
  assert.equal(signingKey(secret, '20150830', { region: 'us-east-1', service: 'iam' }).toString('hex'), refKey(secret, '20150830', 'us-east-1', 'iam').toString('hex'));
  assert.notEqual(signingKey(secret, '20150831', { region: 'us-east-1', service: 'iam' }).toString('hex'), refKey(secret, '20150830', 'us-east-1', 'iam').toString('hex'));
});

test('encoding rules: unreserved kept, everything else upper-case percent of UTF-8 bytes', () => {
  assert.equal(awsEncode('a b/c~d_e-f.g'), 'a%20b%2Fc~d_e-f.g');
  assert.equal(awsEncode('é€'), '%C3%A9%E2%82%AC');
  assert.equal(awsEncode('a/b', true), 'a/b');
  assert.equal(canonicalQuery('?b=2&a=1&a=0&c'), 'a=0&a=1&b=2&c=');
  assert.equal(canonicalQuery('?q=a+b%20c&X-Amz-Signature=zz', ['X-Amz-Signature']), 'q=a%20b%20c');
  assert.equal(canonicalPath('/a//b/./c/../d/', 'service'), '/a/b/d/');
  assert.equal(canonicalPath('/a b/%C3%A9', 's3'), '/a%20b/%C3%A9');
  assert.equal(canonicalPath('/a%20b', 'service'), '/a%2520b', 'non-s3 services encode twice');
  assert.equal(canonicalPath('/a//b', 's3'), '/a//b', 's3 does not normalise');
});

test('a signed request verifies, and each tampering is refused with the right code', () => {
  const now = new Date('2013-05-24T00:03:00Z');
  const req = { method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/a/b.txt?versionId=3&x=1', headers: { 'content-type': 'text/plain' }, body: 'hello' };
  const s = sign(req, S3, { now: D, ...s3scope });
  const ok = verify({ ...req, headers: s.headers }, { now, secretFor: lookup, body: 'hello' });
  assert.equal(ok.accessKeyId, S3.accessKeyId);
  assert.equal(ok.region, 'us-east-1');
  assert.equal(ok.presigned, false);
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as SigV4Error).code; } return 'none'; };
  assert.equal(code(() => verify({ ...req, url: req.url.replace('b.txt', 'c.txt'), headers: s.headers }, { now, secretFor: lookup })), 'SignatureDoesNotMatch');
  assert.equal(code(() => verify({ ...req, url: `${req.url}&extra=1`, headers: s.headers }, { now, secretFor: lookup })), 'SignatureDoesNotMatch');
  assert.equal(code(() => verify({ ...req, method: 'DELETE', headers: s.headers }, { now, secretFor: lookup })), 'SignatureDoesNotMatch');
  assert.equal(code(() => verify({ ...req, headers: { ...s.headers, 'content-type': 'text/html' } }, { now, secretFor: lookup })), 'SignatureDoesNotMatch');
  assert.equal(code(() => verify({ ...req, headers: s.headers }, { now, secretFor: lookup, body: 'hellO' })), 'XAmzContentSHA256Mismatch');
  assert.equal(code(() => verify({ ...req, headers: s.headers }, { now, secretFor: () => randomBytes(30).toString('base64') })), 'SignatureDoesNotMatch');
  assert.equal(code(() => verify({ ...req, headers: s.headers }, { now, secretFor: () => undefined })), 'InvalidAccessKeyId');
  assert.equal(code(() => verify({ ...req, headers: {} }, { now, secretFor: lookup })), 'AccessDenied');
});

test('clock skew: 15 minutes either way, in the past or the future', () => {
  const s = sign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, S3, { now: D, ...s3scope });
  const at = (sec: number) => ({ now: new Date(D.getTime() + sec * 1000), secretFor: lookup });
  assert.equal(verify({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: s.headers }, at(900)).accessKeyId, S3.accessKeyId);
  assert.equal(verify({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: s.headers }, at(-900)).accessKeyId, S3.accessKeyId);
  assert.throws(() => verify({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: s.headers }, at(901)), (e: SigV4Error) => e.code === 'RequestTimeTooSkewed' && e.status === 403);
  assert.throws(() => verify({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: s.headers }, at(-901)), /RequestTimeTooSkewed|more than 900/);
});

test('credential scoping: region and service must be served here, and the date must match', () => {
  const s = sign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, S3, { now: D, region: 'eu-west-1', service: 's3' });
  const req = { method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: s.headers };
  assert.equal(verify(req, { now: D, secretFor: lookup, scopes: [{ region: 'eu-west-1', service: 's3' }] }).region, 'eu-west-1');
  assert.throws(() => verify(req, { now: D, secretFor: lookup, scopes: [{ region: 'us-east-1', service: 's3' }] }), /scope eu-west-1\/s3 is not served/);
  const forged = { ...s.headers, Authorization: s.authorization.replace('/20130524/', '/20130523/') };
  assert.throws(() => verify({ ...req, headers: forged }, { now: D, secretFor: lookup }), /credential date does not match/);
});

test('algorithm confusion and malformed headers are refused', () => {
  const s = sign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, S3, { now: D, ...s3scope });
  const mk = (a: string) => ({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: { ...s.headers, Authorization: a } });
  const o = { now: D, secretFor: lookup };
  assert.throws(() => verify(mk(s.authorization.replace('AWS4-HMAC-SHA256', 'AWS4-ECDSA-P256-SHA256')), o), /only AWS4-HMAC-SHA256/);
  assert.throws(() => verify(mk('AWS4-HMAC-SHA256 Credential=a/b'), o), /Credential, SignedHeaders and Signature|credential must be/);
  assert.throws(() => verify(mk('nonsense'), o), /not in the expected form|only AWS4/);
  assert.throws(() => verify(mk(s.authorization.replace(/SignedHeaders=[^,]*/, 'SignedHeaders=x-amz-date')), o), /host must be a signed header/);
  assert.throws(() => verify(mk(s.authorization.replace(/Signature=.*/, 'Signature=00')), o), /does not match/);
});

test('presigned URLs: expiry, future dating, bad lifetimes and a body-less method are enforced', () => {
  assert.throws(() => presign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, S3, { now: D, expiresSec: 604_801, ...s3scope }), /between 1 and 604800/);
  assert.throws(() => presign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, S3, { now: D, expiresSec: 0, ...s3scope }), /between 1 and 604800/);
  const url = presign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k?response-content-type=text%2Fplain' }, S3, { now: D, expiresSec: 60, ...s3scope });
  const req = { method: 'GET', url, headers: {} };
  assert.equal(verify(req, { now: new Date(D.getTime() + 60_000), secretFor: lookup }).presigned, true);
  assert.throws(() => verify(req, { now: new Date(D.getTime() + 61_000), secretFor: lookup }), (e: SigV4Error) => e.code === 'AccessDenied' && /expired/.test(e.message));
  assert.throws(() => verify(req, { now: new Date(D.getTime() - 901_000), secretFor: lookup }), /future/);
  assert.throws(() => verify({ ...req, method: 'PUT' }, { now: D, secretFor: lookup }), /does not match/);
  assert.throws(() => verify({ ...req, url: url.replace('X-Amz-Expires=60', 'X-Amz-Expires=99999') }, { now: D, secretFor: lookup }), /does not match/);
  assert.throws(() => verify({ ...req, url: url.replace('X-Amz-Expires=60', 'X-Amz-Expires=9999999') }, { now: D, secretFor: lookup }), /between 1 and 604800/);
  assert.throws(() => verify({ ...req, headers: { Authorization: 'x' } }, { now: D, secretFor: lookup }), /header or by query, not both/);
});

test('a session token is sent, signed and reported', () => {
  const creds = { ...S3, sessionToken: 'session-token-value' };
  const s = sign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, creds, { now: D, ...s3scope });
  assert.equal(s.headers['x-amz-security-token'], 'session-token-value');
  assert.match(s.signedHeaders, /x-amz-security-token/);
  const v = verify({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: s.headers }, { now: D, secretFor: lookup });
  assert.equal(v.sessionToken, 'session-token-value');
});

test('chunked bodies: a changed byte, a reordered chunk, a missing end and trailing data are all refused', () => {
  const seed = 'a'.repeat(64);
  const payload = Buffer.from('x'.repeat(100));
  const framed = encodeChunked(payload, seed, S3.secretAccessKey, '20130524T000000Z', s3scope, 40);
  assert.deepEqual(decodeChunked(framed, seed, S3.secretAccessKey, '20130524T000000Z', s3scope), payload);
  const bad = Buffer.from(framed);
  bad[bad.indexOf('\r\n') + 3] = bad[bad.indexOf('\r\n') + 3]! ^ 1;
  assert.throws(() => decodeChunked(bad, seed, S3.secretAccessKey, '20130524T000000Z', s3scope), /chunk signature does not match/);
  assert.throws(() => decodeChunked(framed.subarray(0, framed.length - 10), seed, S3.secretAccessKey, '20130524T000000Z', s3scope), SigV4Error);
  assert.throws(() => decodeChunked(Buffer.concat([framed, Buffer.from('zz')]), seed, S3.secretAccessKey, '20130524T000000Z', s3scope), /after the final chunk/);
  assert.throws(() => decodeChunked(framed, seed, S3.secretAccessKey, '20130524T000000Z', s3scope, { decodedLength: 99 }), /declared x-amz-decoded-content-length/);
  assert.throws(() => decodeChunked(framed, 'b'.repeat(64), S3.secretAccessKey, '20130524T000000Z', s3scope), /chunk signature/);
  assert.throws(() => decodeChunked(Buffer.from('ffffffff;chunk-signature=' + 'a'.repeat(64) + '\r\n'), seed, S3.secretAccessKey, '20130524T000000Z', s3scope, { maxChunk: 100 }), /too large/);
});

test('an s3 request without a content hash is refused, and a malformed hash too', () => {
  const s = sign({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, S3, { now: D, ...s3scope });
  const { 'x-amz-content-sha256': _drop, ...rest } = s.headers;
  assert.throws(() => verify({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: rest }, { now: D, secretFor: lookup }), /x-amz-content-sha256 is required/);
  assert.throws(() => verify({ method: 'GET', url: 'https://b.s3.amazonaws.com/k', headers: { ...s.headers, 'x-amz-content-sha256': 'nonsense' } }, { now: D, secretFor: lookup }), /must be a SHA-256/);
});
