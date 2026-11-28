import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { memoryObjects, readAll } from '../objects/index.ts';
import { encodeChunked, presign, sign } from '../sigv4/index.ts';
import { S3, S3Error, validBucketName, validKey } from './index.ts';
import type { S3Options, S3Response } from './index.ts';

const NOW = new Date('2026-03-01T12:00:00Z');
const ALICE = { accessKeyId: 'ALICEKEY', secretAccessKey: randomBytes(30).toString('base64') };
const BOB = { accessKeyId: 'BOBKEY', secretAccessKey: randomBytes(30).toString('base64') };
const secrets: Record<string, string> = { ALICEKEY: ALICE.secretAccessKey, BOBKEY: BOB.secretAccessKey };
const SCOPE = { region: 'us-east-1', service: 's3' };
const md5 = (b: string | Uint8Array) => createHash('md5').update(b).digest('hex');

function mk(o: Partial<S3Options> = {}) {
  const objects = memoryObjects();
  let n = 0;
  const s3 = new S3({ objects, secretFor: (id) => secrets[id], now: () => NOW, newId: () => `upload-${++n}`, minPartBytes: 5, ...o });
  return { s3, objects };
}

interface CallOpts { query?: string; headers?: Record<string, string>; body?: string | Uint8Array; creds?: typeof ALICE; signAs?: Date }
async function call(s3: S3, method: string, path: string, o: CallOpts = {}): Promise<S3Response> {
  const url = `https://s3.test${path}${o.query ? `?${o.query}` : ''}`;
  const s = sign({ method, url, headers: o.headers ?? {}, ...(o.body !== undefined ? { body: o.body } : {}) }, o.creds ?? ALICE, { now: o.signAs ?? NOW, ...SCOPE });
  return s3.handle({ method, url, headers: s.headers, body: typeof o.body === 'string' ? Buffer.from(o.body) : o.body });
}
const text = async (r: S3Response) => (r.stream ? (await readAll(r.stream)).toString('utf8') : (r.body?.toString('utf8') ?? ''));
const all = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1]!);
const code = (xml: string) => all(xml, 'Code')[0];
const enc = (key: string) => key.split('/').map(encodeURIComponent).join('/');

async function setup(o: Partial<S3Options> = {}) {
  const t = mk(o);
  assert.equal((await call(t.s3, 'PUT', '/photos')).status, 200);
  return t;
}
const put = (s3: S3, key: string, body: string | Uint8Array, headers: Record<string, string> = {}, bucket = 'photos') => call(s3, 'PUT', `/${bucket}/${enc(key)}`, { body, headers });

test('every request must be signed correctly; each failure has its S3 code and status', async () => {
  const { s3 } = await setup();
  const bare = await s3.handle({ method: 'GET', url: 'https://s3.test/photos', headers: {} });
  assert.deepEqual([bare.status, code(await text(bare))], [403, 'AccessDenied']);
  const unknown = await call(s3, 'GET', '/photos', { creds: { accessKeyId: 'NOPE', secretAccessKey: ALICE.secretAccessKey } });
  assert.deepEqual([unknown.status, code(await text(unknown))], [403, 'InvalidAccessKeyId']);
  const wrong = await call(s3, 'GET', '/photos', { creds: { accessKeyId: 'ALICEKEY', secretAccessKey: BOB.secretAccessKey } });
  assert.deepEqual([wrong.status, code(await text(wrong))], [403, 'SignatureDoesNotMatch']);
  const late = await call(s3, 'GET', '/photos', { signAs: new Date(NOW.getTime() - 20 * 60_000) });
  assert.deepEqual([late.status, code(await text(late))], [403, 'RequestTimeTooSkewed']);
  const url = 'https://s3.test/photos';
  const s = sign({ method: 'GET', url }, ALICE, { now: NOW, region: 'eu-west-1', service: 's3' });
  const region = await s3.handle({ method: 'GET', url, headers: s.headers });
  assert.equal(code(await text(region)), 'AuthorizationHeaderMalformed');
  const tampered = sign({ method: 'GET', url: 'https://s3.test/photos?prefix=a' }, ALICE, { now: NOW, ...SCOPE });
  assert.equal((await s3.handle({ method: 'GET', url: 'https://s3.test/photos?prefix=b', headers: tampered.headers })).status, 403, 'the query is part of what was signed');
  const err = await text(bare);
  assert.match(err, /^<\?xml[^>]*\?>\n<Error><Code>AccessDenied<\/Code><Message>[^<]+<\/Message><Resource>\/photos<\/Resource><RequestId>[0-9a-f]{8}<\/RequestId><\/Error>$/);
  assert.match(bare.headers['x-amz-request-id']!, /^[0-9a-f]{8}$/);
});

test('buckets: names are validated, duplicates told apart by owner, listing shows only your own, delete needs empty', async () => {
  const { s3 } = await setup();
  assert.equal(validBucketName('my-bucket.v2'), true);
  for (const bad of ['ab', 'A-bucket', 'a..b', '-ab', 'ab-', '192.168.0.1', 'xn--abc', 'a_b_c', 'a'.repeat(64), 'ab.-cd', 'name-s3alias'])
    assert.equal(validBucketName(bad), false, bad);
  const badPut = await call(s3, 'PUT', '/Bad_Name');
  assert.deepEqual([badPut.status, code(await text(badPut))], [400, 'InvalidBucketName']);
  const again = await call(s3, 'PUT', '/photos');
  assert.deepEqual([again.status, code(await text(again))], [409, 'BucketAlreadyOwnedByYou']);
  const theirs = await call(s3, 'PUT', '/photos', { creds: BOB });
  assert.deepEqual([theirs.status, code(await text(theirs))], [409, 'BucketAlreadyExists']);
  assert.equal((await call(s3, 'PUT', '/bobs', { creds: BOB })).status, 200);
  assert.deepEqual(all(await text(await call(s3, 'GET', '/')), 'Name'), ['photos']);
  assert.deepEqual(all(await text(await call(s3, 'GET', '/', { creds: BOB })), 'Name'), ['bobs']);
  assert.equal((await call(s3, 'HEAD', '/photos')).status, 200);
  const missing = await call(s3, 'GET', '/nothere');
  assert.deepEqual([missing.status, code(await text(missing))], [404, 'NoSuchBucket']);
  assert.equal((await call(s3, 'HEAD', '/nothere')).body, undefined, 'HEAD errors carry no body');
  await put(s3, 'a.txt', 'x');
  const full = await call(s3, 'DELETE', '/photos');
  assert.deepEqual([full.status, code(await text(full))], [409, 'BucketNotEmpty']);
  await call(s3, 'DELETE', '/photos/a.txt');
  assert.equal((await call(s3, 'DELETE', '/photos')).status, 204);
  const loc = (v: string) => call(s3, 'PUT', '/regional', { body: `<CreateBucketConfiguration><LocationConstraint>${v}</LocationConstraint></CreateBucketConfiguration>` });
  assert.equal((await loc('us-east-1')).status, 200);
  assert.equal(code(await text(await call(s3, 'PUT', '/other-region', { body: '<CreateBucketConfiguration><LocationConstraint>eu-west-1</LocationConstraint></CreateBucketConfiguration>' }))), 'IllegalLocationConstraintException');
  const small = mk({ maxBuckets: 1 });
  await call(small.s3, 'PUT', '/one-bucket');
  assert.equal(code(await text(await call(small.s3, 'PUT', '/two-bucket'))), 'TooManyBuckets');
});

test('put and get: ETag is the MD5, metadata and content headers round-trip, overwrite frees the old bytes', async () => {
  const { s3, objects } = await setup();
  const r = await put(s3, 'dir/a b+c.txt', 'hello world', { 'content-type': 'text/plain', 'x-amz-meta-Author': 'Ana', 'cache-control': 'max-age=60', 'content-disposition': 'attachment' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['etag'], `"${md5('hello world')}"`);
  const g = await call(s3, 'GET', `/photos/${enc('dir/a b+c.txt')}`);
  assert.equal(await text(g), 'hello world');
  assert.deepEqual([g.status, g.headers['content-type'], g.headers['content-length'], g.headers['x-amz-meta-author'], g.headers['cache-control'], g.headers['content-disposition'], g.headers['accept-ranges']], [200, 'text/plain', '11', 'Ana', 'max-age=60', 'attachment', 'bytes']);
  assert.equal(g.headers['last-modified'], NOW.toUTCString());
  const h = await call(s3, 'HEAD', `/photos/${enc('dir/a b+c.txt')}`);
  assert.deepEqual([h.status, h.headers['content-length'], h.stream], [200, '11', undefined]);
  assert.equal(objects.count(), 1);
  await put(s3, 'dir/a b+c.txt', 'second');
  assert.equal(objects.count(), 1, 'the first version\'s bytes are gone');
  assert.equal(await text(await call(s3, 'GET', `/photos/${enc('dir/a b+c.txt')}`)), 'second');
  assert.equal((await put(s3, 'empty', '')).headers['etag'], `"${md5('')}"`);
  const e = await call(s3, 'GET', '/photos/empty');
  assert.deepEqual([e.status, e.headers['content-length'], await text(e)], [200, '0', '']);
  const nokey = await call(s3, 'GET', '/photos/nothing');
  assert.deepEqual([nokey.status, code(await text(nokey))], [404, 'NoSuchKey']);
  const meta = await put(s3, 'm', 'x', { 'x-amz-meta-big': 'x'.repeat(2100) });
  assert.equal(code(await text(meta)), 'MetadataTooLarge');
});

test('digests: a wrong Content-MD5 or content hash is refused and leaves nothing stored', async () => {
  const { s3, objects } = await setup();
  const bad = await put(s3, 'a', 'hello', { 'content-md5': Buffer.from(md5('other'), 'hex').toString('base64') });
  assert.deepEqual([bad.status, code(await text(bad))], [400, 'BadDigest']);
  assert.equal(objects.count(), 0);
  const good = await put(s3, 'a', 'hello', { 'content-md5': Buffer.from(md5('hello'), 'hex').toString('base64') });
  assert.equal(good.status, 200);
  // signed for one body, sent with another: the declared hash is part of the signature, the body is not
  const url = 'https://s3.test/photos/b';
  const s = sign({ method: 'PUT', url, headers: {}, body: 'signed body' }, ALICE, { now: NOW, ...SCOPE });
  const swapped = await s3.handle({ method: 'PUT', url, headers: s.headers, body: Buffer.from('another body') });
  assert.deepEqual([swapped.status, code(await text(swapped))], [400, 'XAmzContentSHA256Mismatch']);
  assert.equal(objects.count(), 1, 'only a');
});

test('ranges: closed, open-ended and suffix; unsatisfiable is 416; nonsense is ignored', async () => {
  const { s3 } = await setup();
  await put(s3, 'r', '0123456789');
  const r = async (range: string) => call(s3, 'GET', '/photos/r', { headers: { range } });
  const a = await r('bytes=2-5');
  assert.deepEqual([a.status, await text(a), a.headers['content-range'], a.headers['content-length']], [206, '2345', 'bytes 2-5/10', '4']);
  const b = await r('bytes=7-');
  assert.deepEqual([b.status, await text(b), b.headers['content-range']], [206, '789', 'bytes 7-9/10']);
  const c = await r('bytes=-3');
  assert.deepEqual([c.status, await text(c)], [206, '789']);
  const d = await r('bytes=0-999');
  assert.deepEqual([d.status, await text(d), d.headers['content-range']], [206, '0123456789', 'bytes 0-9/10']);
  const e = await r('bytes=50-60');
  assert.deepEqual([e.status, code(await text(e))], [416, 'InvalidRange']);
  const f = await r('lines=1-2');
  assert.deepEqual([f.status, await text(f)], [200, '0123456789']);
  const h = await call(s3, 'HEAD', '/photos/r', { headers: { range: 'bytes=0-1' } });
  assert.deepEqual([h.status, h.headers['content-length']], [206, '2']);
});

test('conditional requests follow RFC 9110: If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since', async () => {
  const { s3 } = await setup();
  const etag = (await put(s3, 'c', 'content')).headers['etag']!;
  const get = (headers: Record<string, string>) => call(s3, 'GET', '/photos/c', { headers });
  assert.equal((await get({ 'if-none-match': etag })).status, 304);
  assert.equal((await get({ 'if-none-match': `W/${etag}` })).status, 304, 'weak comparison for If-None-Match');
  assert.equal((await get({ 'if-none-match': `"other", ${etag}` })).status, 304);
  assert.equal((await get({ 'if-none-match': '"other"' })).status, 200);
  assert.equal((await get({ 'if-none-match': etag })).body, undefined);
  const m = await get({ 'if-match': '"other"' });
  assert.deepEqual([m.status, code(await text(m))], [412, 'PreconditionFailed']);
  assert.equal((await get({ 'if-match': etag })).status, 200);
  assert.equal((await get({ 'if-match': '*' })).status, 200);
  const later = new Date(NOW.getTime() + 3600_000).toUTCString();
  const earlier = new Date(NOW.getTime() - 3600_000).toUTCString();
  assert.equal((await get({ 'if-modified-since': later })).status, 304);
  assert.equal((await get({ 'if-modified-since': earlier })).status, 200);
  assert.equal((await get({ 'if-modified-since': 'not a date' })).status, 200, 'an unparseable date is ignored');
  assert.equal((await get({ 'if-unmodified-since': earlier })).status, 412);
  assert.equal((await get({ 'if-unmodified-since': later })).status, 200);
  assert.equal((await get({ 'if-match': etag, 'if-unmodified-since': earlier })).status, 200, 'If-Match present: If-Unmodified-Since is not evaluated');
  assert.equal((await get({ 'if-none-match': '"other"', 'if-modified-since': later })).status, 200, 'If-None-Match present: If-Modified-Since is not evaluated');
  const create = (key: string) => put(s3, key, 'x', { 'if-none-match': '*' });
  assert.equal((await create('fresh')).status, 200);
  const twice = await create('fresh');
  assert.deepEqual([twice.status, code(await text(twice))], [412, 'PreconditionFailed']);
  assert.equal((await put(s3, 'fresh', 'y', { 'if-match': '"nope"' })).status, 412);
  assert.equal((await put(s3, 'absent', 'y', { 'if-match': '*' })).status, 412, 'If-Match: * needs the object to exist');
  assert.equal(await text(await call(s3, 'GET', '/photos/fresh')), 'x', 'the failed writes changed nothing');
});

test('listing: prefix, delimiter and common prefixes, with the XML escaped', async () => {
  const { s3 } = await setup();
  for (const k of ['a.txt', 'docs/b.txt', 'docs/c.txt', 'docs/sub/d.txt', 'img/e.png', 'a&b<c>.txt']) await put(s3, k, k);
  const l = async (query: string) => text(await call(s3, 'GET', '/photos', { query }));
  const flat = await l('list-type=2');
  assert.deepEqual(all(flat, 'Key'), ['a&amp;b&lt;c&gt;.txt', 'a.txt', 'docs/b.txt', 'docs/c.txt', 'docs/sub/d.txt', 'img/e.png']);
  assert.deepEqual(all(flat, 'KeyCount'), ['6']);
  const top = await l('list-type=2&delimiter=/');
  assert.deepEqual(all(top, 'Key'), ['a&amp;b&lt;c&gt;.txt', 'a.txt']);
  assert.deepEqual(all(top, 'Prefix').filter((p) => p !== ''), ['docs/', 'img/']);
  assert.deepEqual(all(top, 'KeyCount'), ['4'], 'keys and common prefixes both count');
  const docs = await l('list-type=2&delimiter=/&prefix=docs/');
  assert.deepEqual(all(docs, 'Key'), ['docs/b.txt', 'docs/c.txt']);
  assert.deepEqual(all(docs, 'Prefix'), ['docs/', 'docs/sub/']);
  assert.deepEqual(all(await l('list-type=2&prefix=nothing'), 'Key'), []);
  assert.deepEqual(all(await l('list-type=2&start-after=docs/b.txt&prefix=docs/'), 'Key'), ['docs/c.txt', 'docs/sub/d.txt']);
  const url = await l('list-type=2&encoding-type=url&prefix=a%26');
  assert.deepEqual(all(url, 'Key'), ['a%26b%3Cc%3E.txt']);
  assert.equal(all(await l('list-type=2&max-keys=0'), 'IsTruncated')[0], 'false');
  for (const bad of ['max-keys=-1', 'max-keys=abc', 'encoding-type=base64', 'continuation-token=!!!', 'continuation-token='])
    assert.equal(code(await l(`list-type=2&${bad}`)), 'InvalidArgument', bad);
  assert.equal(code(await l('list-type=1')), 'InvalidArgument');
});

test('listing pagination returns every key and prefix exactly once, in UTF-8 byte order', async () => {
  const { s3 } = await setup({ maxMaxKeys: 1000 });
  const keys = ['b', 'a/1', 'a/2', 'a/3', 'c/x/1', 'c/x/2', 'c/y', 'd', 'e/1', '～-bmp', '\u{1f600}-astral', 'zz'];
  for (const k of keys) await put(s3, k, 'x');
  for (const size of [1, 2, 3, 5]) {
    const got: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < 50; i++) {
      const xml = await text(await call(s3, 'GET', '/photos', { query: `list-type=2&delimiter=/&max-keys=${size}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}` }));
      const page = [...xml.matchAll(/<(?:Key|Prefix)>([^<]+)<\/(?:Key|Prefix)>/g)].map((m) => m[1]!).filter((p) => p !== '');
      got.push(...page);
      assert.ok(page.length <= size);
      token = all(xml, 'NextContinuationToken')[0];
      if (!token) break;
    }
    const expected = [...new Set(keys.map((k) => (k.includes('/') ? k.slice(0, k.indexOf('/') + 1) : k)))].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    assert.equal(got.length, expected.length, `page size ${size}: nothing twice, nothing missing`);
    assert.deepEqual([...got].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))), expected, `page size ${size}`);
  }
  const order = all(await text(await call(s3, 'GET', '/photos', { query: 'list-type=2&prefix=%EF%BD%9E' })), 'Key');
  assert.deepEqual(order, ['～-bmp']);
  const flat = all(await text(await call(s3, 'GET', '/photos', { query: 'list-type=2' })), 'Key');
  assert.ok(flat.indexOf('～-bmp') < flat.indexOf('\u{1f600}-astral'), 'U+FF5E sorts before U+1F600 by UTF-8 bytes, unlike by UTF-16 units');
  const v1 = await text(await call(s3, 'GET', '/photos', { query: 'max-keys=2&delimiter=/' }));
  assert.deepEqual(all(v1, 'IsTruncated'), ['true']);
  assert.equal(all(v1, 'NextMarker').length, 1);
});

test('keys: Unicode, spaces, plus, percent and dot segments are stored as written; control characters and long keys refused', async () => {
  const { s3 } = await setup();
  const keys = ['café/日本語.txt', 'a b', 'a+b', '100%', '..dots', 'a/./b-not-a-segment'.replace('/./', '/.-/'), '/leading', 'trailing/', 'emoji-\u{1f600}'];
  for (const k of keys) {
    const r = await put(s3, k, `body of ${k}`);
    assert.equal(r.status, 200, k);
  }
  for (const k of keys) assert.equal(await text(await call(s3, 'GET', `/photos/${enc(k)}`)), `body of ${k}`, k);
  assert.equal(all(await text(await call(s3, 'GET', '/photos', { query: 'list-type=2' })), 'Key').length, keys.length);
  assert.equal(validKey('x'.repeat(1024)), true);
  assert.equal(validKey('x'.repeat(1025)), false);
  assert.equal(validKey('é'.repeat(513)), false, 'the limit is in bytes');
  assert.equal(validKey('a\u0000b'), false);
  assert.equal(validKey('\ud800'), false, 'a lone surrogate cannot be sent as UTF-8');
  const ctrl = await call(s3, 'PUT', '/photos/a%0Ab', { body: 'x' });
  assert.deepEqual([ctrl.status, code(await text(ctrl))], [400, 'KeyTooLongError']);
  assert.equal((await call(s3, 'PUT', `/photos/${'x'.repeat(1025)}`, { body: 'x' })).status, 400);
  const badPercent = await s3.handle({ method: 'PUT', url: 'https://s3.test/photos/%ZZ', headers: {} });
  assert.deepEqual([badPercent.status, code(await text(badPercent))], [400, 'InvalidURI'], 'bad percent-encoding');
  for (const path of ['/photos/../escape', '/photos/./x', '/photos/%2e%2e/escape', '/photos/a/%2E/b', '/photos/a\\..\\b', '/photos/..']) {
    const r = await s3.handle({ method: 'PUT', url: `https://s3.test${path}`, headers: sign({ method: 'PUT', url: `https://s3.test${path}`, headers: {}, body: 'x' }, ALICE, { now: NOW, ...SCOPE }).headers, body: Buffer.from('x') });
    assert.deepEqual([r.status, code(await text(r))], [400, 'InvalidURI'], path);
  }
  assert.equal((await call(s3, 'HEAD', '/escape')).status, 404, 'no bucket was made by a dot-segment path');
});

test('delete is idempotent; multi-object delete handles quiet mode, bad keys, limits and hostile XML', async () => {
  const { s3, objects } = await setup();
  assert.equal((await call(s3, 'DELETE', '/photos/never-existed')).status, 204);
  for (const k of ['a', 'b', 'c']) await put(s3, k, k);
  const del = (body: string, headers: Record<string, string> = {}) => call(s3, 'POST', '/photos', { query: 'delete', body, headers });
  const r = await del('<Delete><Object><Key>a</Key></Object><Object><Key>missing</Key></Object><Object><Key>bad&#9;key</Key></Object></Delete>');
  assert.equal(r.status, 200);
  const xml = await text(r);
  assert.deepEqual(all(xml, 'Key'), ['a', 'missing', 'bad\tkey']);
  assert.deepEqual(all(xml, 'Code'), ['InvalidArgument']);
  assert.equal(objects.count(), 2);
  const quiet = await text(await del('<Delete><Quiet>true</Quiet><Object><Key>b</Key></Object></Delete>'));
  assert.deepEqual(all(quiet, 'Deleted'), []);
  assert.equal(objects.count(), 1);
  const keys = Array.from({ length: 1001 }, (_, i) => `<Object><Key>k${i}</Key></Object>`).join('');
  assert.equal(code(await text(await del(`<Delete>${keys}</Delete>`))), 'MalformedXML');
  assert.equal(code(await text(await del('<Delete></Delete>'))), 'MalformedXML');
  assert.equal(code(await text(await del('<Wrong/>'))), 'MalformedXML');
  assert.equal(code(await text(await del('<Delete><Object><Key>a</Key></Object>'))), 'MalformedXML');
  assert.equal(code(await text(await del('<!DOCTYPE d [<!ENTITY x "y">]><Delete><Object><Key>&x;</Key></Object></Delete>'))), 'MalformedXML', 'entities are refused');
  const wrongMd5 = await del('<Delete><Object><Key>c</Key></Object></Delete>', { 'content-md5': Buffer.from(md5('x'), 'hex').toString('base64') });
  assert.equal(code(await text(wrongMd5)), 'BadDigest');
  assert.equal(objects.count(), 1);
});

test('copy: metadata COPY keeps the source\'s, REPLACE takes the request\'s; copying onto itself needs REPLACE; sources are authorised', async () => {
  const { s3, objects } = await setup();
  await put(s3, 'src dir/o.txt', 'original', { 'content-type': 'text/plain', 'x-amz-meta-k': 'v1' });
  const cp = (src: string, dst: string, headers: Record<string, string> = {}) => call(s3, 'PUT', `/photos/${enc(dst)}`, { headers: { 'x-amz-copy-source': `/photos/${enc(src)}`, ...headers } });
  const r = await cp('src dir/o.txt', 'copy.txt');
  assert.equal(r.status, 200);
  assert.deepEqual(all(await text(r), 'ETag'), [`&quot;${md5('original')}&quot;`]);
  const g = await call(s3, 'GET', '/photos/copy.txt');
  assert.deepEqual([await text(g), g.headers['content-type'], g.headers['x-amz-meta-k']], ['original', 'text/plain', 'v1']);
  assert.equal(objects.count(), 2);
  await cp('src dir/o.txt', 'rep.txt', { 'x-amz-metadata-directive': 'REPLACE', 'content-type': 'image/png', 'x-amz-meta-k': 'v2' });
  const h = await call(s3, 'HEAD', '/photos/rep.txt');
  assert.deepEqual([h.headers['content-type'], h.headers['x-amz-meta-k']], ['image/png', 'v2']);
  const self = await cp('copy.txt', 'copy.txt');
  assert.deepEqual([self.status, code(await text(self))], [400, 'InvalidRequest']);
  assert.equal((await cp('copy.txt', 'copy.txt', { 'x-amz-metadata-directive': 'REPLACE', 'x-amz-meta-k': 'v3' })).status, 200);
  assert.equal(code(await text(await cp('nope', 'x'))), 'NoSuchKey');
  assert.equal(code(await text(await cp('copy.txt', 'x', { 'x-amz-metadata-directive': 'MERGE' }))), 'InvalidArgument');
  assert.equal((await call(s3, 'PUT', '/photos/x', { headers: { 'x-amz-copy-source': 'photos' } })).status, 400);
  await call(s3, 'PUT', '/bobs', { creds: BOB });
  await call(s3, 'PUT', '/bobs/secret', { creds: BOB, body: 'bob only' });
  const steal = await call(s3, 'PUT', '/photos/stolen', { headers: { 'x-amz-copy-source': '/bobs/secret' } });
  assert.deepEqual([steal.status, code(await text(steal))], [403, 'AccessDenied']);
  assert.equal((await call(s3, 'GET', '/photos/stolen')).status, 404);
});

test('multipart: parts upload in any order, the ETag is the MD5 of the part MD5s with -N, and the bytes are joined', async () => {
  const { s3, objects } = await setup();
  const init = await call(s3, 'POST', '/photos/big.bin', { query: 'uploads', headers: { 'content-type': 'application/zip', 'x-amz-meta-k': 'v' } });
  const id = all(await text(init), 'UploadId')[0]!;
  assert.equal(id, 'upload-1');
  const parts = ['AAAAAA', 'BBBBBB', 'CC'];
  const etags: string[] = [];
  for (const n of [3, 1, 2]) {
    const r = await call(s3, 'PUT', '/photos/big.bin', { query: `partNumber=${n}&uploadId=${id}`, body: parts[n - 1]! });
    assert.equal(r.status, 200);
    etags[n - 1] = r.headers['etag']!;
    assert.equal(etags[n - 1], `"${md5(parts[n - 1]!)}"`);
  }
  const listed = await text(await call(s3, 'GET', '/photos/big.bin', { query: `uploadId=${id}` }));
  assert.deepEqual(all(listed, 'PartNumber'), ['1', '2', '3']);
  assert.deepEqual(all(listed, 'Size'), ['6', '6', '2']);
  const pg = await text(await call(s3, 'GET', '/photos/big.bin', { query: `uploadId=${id}&max-parts=1&part-number-marker=1` }));
  assert.deepEqual([all(pg, 'PartNumber'), all(pg, 'NextPartNumberMarker'), all(pg, 'IsTruncated')], [['2'], ['2'], ['true']]);
  assert.deepEqual(all(await text(await call(s3, 'GET', '/photos', { query: 'uploads' })), 'UploadId'), [id]);
  const body = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  const done = await call(s3, 'POST', '/photos/big.bin', { query: `uploadId=${id}`, body });
  assert.equal(done.status, 200);
  const expected = createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(md5(p), 'hex')))).digest('hex') + '-3';
  assert.deepEqual(all(await text(done), 'ETag'), [`&quot;${expected}&quot;`]);
  const g = await call(s3, 'GET', '/photos/big.bin');
  assert.deepEqual([await text(g), g.headers['etag'], g.headers['content-type'], g.headers['x-amz-meta-k']], ['AAAAAABBBBBBCC', `"${expected}"`, 'application/zip', 'v']);
  assert.equal(objects.count(), 1, 'the parts were removed');
  assert.deepEqual(all(await text(await call(s3, 'GET', '/photos', { query: 'uploads' })), 'UploadId'), []);
  assert.equal(code(await text(await call(s3, 'POST', '/photos/big.bin', { query: `uploadId=${id}`, body }))), 'NoSuchUpload', 'completing twice');
});

test('multipart errors: order, ETags, missing and too-small parts, part numbers, wrong key or owner, abort frees the bytes', async () => {
  const { s3, objects } = await setup({ minPartBytes: 5 });
  const start = async (key = 'm.bin', creds = ALICE) => all(await text(await call(s3, 'POST', `/photos/${key}`, { query: 'uploads', creds })), 'UploadId')[0]!;
  const id = await start();
  const up = async (n: number | string, body: string, uid = id) => call(s3, 'PUT', '/photos/m.bin', { query: `partNumber=${n}&uploadId=${uid}`, body });
  const e1 = (await up(1, 'AAAAAA')).headers['etag']!;
  const e2 = (await up(2, 'BBBBBB')).headers['etag']!;
  const e3 = (await up(3, 'C')).headers['etag']!;
  const finish = async (parts: [number | string, string][], uid = id, key = 'm.bin', creds = ALICE) => call(s3, 'POST', `/photos/${key}`, { query: `uploadId=${uid}`, creds, body: `<CompleteMultipartUpload>${parts.map(([n, e]) => `<Part><PartNumber>${n}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>` });
  const c = async (r: Promise<S3Response>) => code(await text(await r));
  assert.equal(await c(finish([[2, e2], [1, e1]])), 'InvalidPartOrder');
  assert.equal(await c(finish([[1, e1], [1, e1]])), 'InvalidPartOrder');
  assert.equal(await c(finish([[1, '"deadbeef"'], [2, e2]])), 'InvalidPart');
  assert.equal(await c(finish([[1, e1], [9, e2]])), 'InvalidPart');
  assert.equal(await c(finish([])), 'MalformedXML');
  assert.equal(await c(finish([['x', e1]])), 'MalformedXML');
  const small = await finish([[3, e3], ]);
  assert.equal(small.status, 200, 'a single small last part is fine');
  const id2 = await start('m.bin');
  await up(1, 'AB', id2);
  await up(2, 'CDEFGH', id2);
  const tooSmall = await finish([[1, `"${md5('AB')}"`], [2, `"${md5('CDEFGH')}"`]], id2);
  assert.deepEqual([tooSmall.status, code(await text(tooSmall))], [400, 'EntityTooSmall']);
  for (const bad of [0, 10_001, 'x', -1, '']) assert.equal(await c(up(bad, 'zzzzzz', id2)), 'InvalidArgument', String(bad));
  assert.equal(await c(call(s3, 'PUT', '/photos/m.bin', { query: 'partNumber=1', body: 'x' })), 'InvalidArgument');
  assert.equal(await c(up(1, 'x', 'no-such-id')), 'NoSuchUpload');
  assert.equal(await c(call(s3, 'PUT', '/photos/other.bin', { query: `partNumber=1&uploadId=${id2}`, body: 'x' })), 'NoSuchUpload', 'an upload belongs to its key');
  await call(s3, 'PUT', '/photos/m.bin', { query: `partNumber=1&uploadId=${id2}`, body: 'x', creds: BOB });
  assert.equal(await c(finish([[1, '"x"']], id2, 'm.bin', BOB)), 'AccessDenied', 'Bob cannot touch Alice\'s bucket');
  const before = objects.count();
  await up(1, 'replacement', id2);
  assert.equal(objects.count(), before, 'a re-uploaded part replaces the old one');
  assert.equal((await call(s3, 'DELETE', '/photos/m.bin', { query: `uploadId=${id2}` })).status, 204);
  assert.equal(objects.count(), 1, 'only the completed object remains');
  assert.equal(await c(up(1, 'x', id2)), 'NoSuchUpload');
  const limited = mk({ maxOpenUploads: 1 });
  await call(limited.s3, 'PUT', '/photos');
  await call(limited.s3, 'POST', '/photos/a', { query: 'uploads' });
  assert.equal((await call(limited.s3, 'POST', '/photos/b', { query: 'uploads' })).status, 503);
  const nodel = await call(s3, 'DELETE', '/photos');
  assert.equal(code(await text(nodel)), 'BucketNotEmpty');
});

test('authorisation: other users are refused, a custom rule is honoured, anonymous access only where allowed', async () => {
  const { s3 } = await setup();
  await put(s3, 'private.txt', 'mine');
  const denied = await call(s3, 'GET', '/photos/private.txt', { creds: BOB });
  assert.deepEqual([denied.status, code(await text(denied))], [403, 'AccessDenied']);
  assert.equal((await call(s3, 'PUT', '/photos/x', { creds: BOB, body: 'x' })).status, 403);
  assert.equal((await call(s3, 'DELETE', '/photos/private.txt', { creds: BOB })).status, 403);
  const calls: string[] = [];
  const t = mk({
    authorize: (who, action, bucket) => {
      calls.push(`${who} ${action} ${bucket ?? '-'}`);
      return who === 'ALICEKEY' || (who === 'BOBKEY' && action === 's3:GetObject') || action === 's3:CreateBucket';
    },
    anonymous: (action, bucket, key) => action === 's3:GetObject' && bucket === 'pub' && key === 'readme.txt',
  });
  await call(t.s3, 'PUT', '/pub');
  await put(t.s3, 'readme.txt', 'hello', {}, 'pub');
  await put(t.s3, 'other.txt', 'hidden', {}, 'pub');
  assert.equal(await text(await call(t.s3, 'GET', '/pub/readme.txt', { creds: BOB })), 'hello');
  assert.equal((await call(t.s3, 'PUT', '/pub/b', { creds: BOB, body: 'x' })).status, 403);
  assert.ok(calls.includes('BOBKEY s3:PutObject pub'));
  const anon = (method: string, path: string) => t.s3.handle({ method, url: `https://s3.test${path}`, headers: {} });
  assert.equal(await text(await anon('GET', '/pub/readme.txt')), 'hello');
  assert.equal((await anon('GET', '/pub/other.txt')).status, 403);
  assert.equal((await anon('PUT', '/pub/readme.txt')).status, 403);
  assert.equal((await anon('PUT', '/newbucket')).status, 403, 'an anonymous caller cannot create buckets');
  assert.equal((await anon('GET', '/')).status, 403);
});

test('presigned URLs work for reads, expire, and refuse a changed path or method', async () => {
  const { s3 } = await setup();
  await put(s3, 'shared.txt', 'for you');
  const url = presign({ method: 'GET', url: 'https://s3.test/photos/shared.txt' }, ALICE, { now: NOW, expiresSec: 300, ...SCOPE });
  const get = (u: string, method = 'GET', now = NOW) => new S3({ objects: memoryObjects(), secretFor: (id) => secrets[id], now: () => now }).handle({ method, url: u, headers: {} });
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature')!.length, 64);
  assert.equal(await text(await s3.handle({ method: 'GET', url, headers: {} })), 'for you');
  const expired = await get(url, 'GET', new Date(NOW.getTime() + 301_000));
  assert.deepEqual([expired.status, code(await text(expired))], [403, 'AccessDenied']);
  assert.equal((await s3.handle({ method: 'GET', url: url.replace('shared.txt', 'other.txt'), headers: {} })).status, 403);
  assert.equal((await s3.handle({ method: 'DELETE', url, headers: {} })).status, 403, 'a GET URL cannot delete');
  const override = presign({ method: 'GET', url: 'https://s3.test/photos/shared.txt?response-content-type=text%2Fhtml&response-content-disposition=attachment%3B%20filename%3D%22a.txt%22' }, ALICE, { now: NOW, expiresSec: 300, ...SCOPE });
  const o = await s3.handle({ method: 'GET', url: override, headers: {} });
  assert.deepEqual([o.headers['content-type'], o.headers['content-disposition']], ['text/html', 'attachment; filename="a.txt"']);
  const inject = presign({ method: 'GET', url: 'https://s3.test/photos/shared.txt?response-content-type=text%2Fhtml%0D%0Aset-cookie%3A%20x%3Dy' }, ALICE, { now: NOW, expiresSec: 300, ...SCOPE });
  const bad = await s3.handle({ method: 'GET', url: inject, headers: {} });
  assert.deepEqual([bad.status, code(await text(bad))], [400, 'InvalidArgument']);
  assert.equal(bad.headers['set-cookie'], undefined);
});

test('signed aws-chunked uploads are verified chunk by chunk and stored decoded', async () => {
  const { s3, objects } = await setup();
  const payload = Buffer.from('chunked payload '.repeat(100));
  const url = 'https://s3.test/photos/streamed.bin';
  const headers = { 'content-encoding': 'aws-chunked', 'x-amz-decoded-content-length': String(payload.length) };
  const s = sign({ method: 'PUT', url, headers, body: payload }, ALICE, { now: NOW, ...SCOPE, payloadHash: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' });
  const framed = encodeChunked(payload, s.signature, ALICE.secretAccessKey, s.amzDate, SCOPE, 400);
  const ok = await s3.handle({ method: 'PUT', url, headers: s.headers, body: framed });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['etag'], `"${md5(payload)}"`);
  assert.equal(await text(await call(s3, 'GET', '/photos/streamed.bin')), payload.toString());
  const bad = Buffer.from(framed);
  bad[framed.indexOf('\r\n') + 5] = bad[framed.indexOf('\r\n') + 5]! ^ 1;
  const r = await s3.handle({ method: 'PUT', url: 'https://s3.test/photos/streamed2.bin', headers: sign({ method: 'PUT', url: 'https://s3.test/photos/streamed2.bin', headers, body: payload }, ALICE, { now: NOW, ...SCOPE, payloadHash: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' }).headers, body: bad });
  assert.ok(r.status >= 400, 'a chunk with a changed byte is refused');
  assert.equal(objects.count(), 1);
  const lie = await s3.handle({ method: 'PUT', url, headers: { ...s.headers, 'x-amz-decoded-content-length': '5' }, body: framed });
  assert.equal(lie.status, 403, 'the declared length is signed');
});

test('size ceilings: a declared length over the limit, a streamed body over it, and an oversized XML body are refused', async () => {
  const { s3, objects } = await setup({ maxObjectBytes: 10 });
  const big = await put(s3, 'big', '12345678901');
  assert.deepEqual([big.status, code(await text(big))], [400, 'EntityTooLarge']);
  assert.equal(objects.count(), 0);
  const url = 'https://s3.test/photos/streamed';
  const body = (async function* () { yield Buffer.from('123456'); yield Buffer.from('78901'); })();
  const s = sign({ method: 'PUT', url, headers: {} }, ALICE, { now: NOW, ...SCOPE, payloadHash: 'UNSIGNED-PAYLOAD' });
  const r = await s3.handle({ method: 'PUT', url, headers: s.headers, body });
  assert.equal(code(await text(r)), 'EntityTooLarge');
  assert.equal(objects.count(), 0, 'nothing is kept');
  assert.equal((await put(s3, 'ok', '1234567890')).status, 200);
  const huge = await call(s3, 'POST', '/photos', { query: 'delete', body: '<Delete>' + ' '.repeat(2 * 1024 * 1024) + '</Delete>' });
  assert.equal(code(await text(huge)), 'EntityTooLarge');
});

test('subresources this server does not implement are 501, and unknown methods are 405', async () => {
  const { s3 } = await setup();
  await put(s3, 'a', 'x');
  for (const sub of ['acl', 'tagging', 'versioning', 'policy', 'cors', 'lifecycle', 'versionId=abc']) {
    const r = await call(s3, 'GET', '/photos/a', { query: sub });
    assert.deepEqual([r.status, code(await text(r))], [501, 'NotImplemented'], sub);
  }
  assert.equal((await call(s3, 'PATCH', '/photos/a')).status, 405);
  assert.equal((await call(s3, 'POST', '/photos/a')).status, 400);
  assert.equal((await call(s3, 'PUT', '/')).status, 405);
  assert.ok(new S3Error('X', 400, 'm') instanceof Error);
});
