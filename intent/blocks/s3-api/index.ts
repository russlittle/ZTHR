/**
 * An S3-compatible HTTP API over any object store (the objects block) and Signature Version 4 (the sigv4 block).
 * `S3.handle` takes a request (method, absolute URL, headers, body) and returns a response (status, headers, body),
 * so it sits behind any HTTP server. Path-style addressing only.
 *
 * Supported: ListBuckets, CreateBucket, HeadBucket, DeleteBucket (not while it holds objects or open uploads);
 * PutObject (Content-MD5 and x-amz-content-sha256 checked, user metadata, standard content headers, If-Match and
 * If-None-Match for conditional writes, signed aws-chunked bodies, a size ceiling), CopyObject (COPY or REPLACE
 * metadata), GetObject and HeadObject (byte ranges, If-Match, If-None-Match, If-Modified-Since,
 * If-Unmodified-Since in RFC 9110 order, response-* overrides), DeleteObject, multi-object Delete;
 * ListObjectsV2 and the older ListObjects (prefix, delimiter and common prefixes, max-keys, continuation, start-after,
 * url encoding, UTF-8 byte ordering); and multipart upload (create, upload part, complete with ETag and order
 * and minimum-size checks, abort, list parts, list uploads). A multipart object's ETag is the MD5 of its parts' MD5s
 * followed by -N, as S3 makes it. Errors are S3's XML with S3's codes and statuses. Every request is signed (header
 * or presigned URL) unless the caller's `anonymous` rule allows it; what a signed key may do is decided by
 * `authorize` (default: only the bucket's creator). Keys are 1 to 1024 UTF-8 bytes without control characters, so
 * listings are always valid XML. XML request bodies go through the dav block's parser, which refuses DTDs and entities.
 * Bytes live in the object store under random keys; this block holds only the index.
 *
 * Out of scope: virtual-hosted addressing, versioning (see object-versioning), ACLs, bucket policies, CORS,
 * lifecycle, tagging, server-side encryption, UploadPartCopy, conditional headers on the copy source, SelectObject,
 * checksums other than MD5 and SHA-256, and persistence of the index (it is in memory; the store keeps the bytes).
 */
import { createHash, randomUUID } from 'node:crypto';
import { escapeXml, parseXml } from '../dav/index.ts';
import type { El } from '../dav/index.ts';
import { Missing, TooLarge, parseRange } from '../objects/index.ts';
import type { ObjectStore } from '../objects/index.ts';
import { SigV4Error, decodeChunked, verify } from '../sigv4/index.ts';
import type { Verified } from '../sigv4/index.ts';

export class S3Error extends Error {
  readonly code: string;
  readonly status: number;
  readonly extra: Readonly<Record<string, string>>;
  constructor(code: string, status: number, message: string, extra: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export interface S3Request {
  readonly method: string;
  /** Absolute URL as the client sent it (scheme, host, path, query); the signature covers it. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: Uint8Array | AsyncIterable<Uint8Array> | undefined;
}

export interface S3Response {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer | undefined;
  /** For GET: the object bytes, streamed from the store. */
  readonly stream?: AsyncIterable<Uint8Array>;
}

export type Action = 's3:ListAllMyBuckets' | 's3:CreateBucket' | 's3:DeleteBucket' | 's3:ListBucket' | 's3:GetObject' | 's3:PutObject' | 's3:DeleteObject' | 's3:AbortMultipartUpload' | 's3:ListMultipartUploadParts' | 's3:ListBucketMultipartUploads';

export interface S3Options {
  readonly objects: ObjectStore;
  readonly secretFor: (accessKeyId: string) => string | undefined;
  readonly now?: () => Date;
  readonly region?: string;
  /** Who may do what. Default: a bucket's creator, and anyone for CreateBucket and ListAllMyBuckets. */
  readonly authorize?: (who: string, action: Action, bucket: string | undefined, key: string | undefined) => boolean;
  /** Allow an unsigned request (public reads). Default: none. */
  readonly anonymous?: (action: Action, bucket: string, key: string | undefined) => boolean;
  readonly newId?: () => string;
  readonly maxObjectBytes?: number;
  readonly minPartBytes?: number;
  readonly maxParts?: number;
  readonly maxOpenUploads?: number;
  readonly maxBuckets?: number;
  readonly maxMaxKeys?: number;
}

interface Meta {
  readonly key: string;
  readonly blob: string;
  readonly size: number;
  readonly etag: string;
  readonly modified: number;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly user: Readonly<Record<string, string>>;
}

interface Part {
  readonly blob: string;
  readonly size: number;
  readonly md5: string;
  readonly modified: number;
}

interface Upload {
  readonly id: string;
  readonly key: string;
  readonly owner: string;
  readonly initiated: number;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly user: Readonly<Record<string, string>>;
  readonly parts: Map<number, Part>;
}

interface Bucket {
  readonly name: string;
  readonly owner: string;
  readonly created: number;
  readonly objects: Map<string, Meta>;
  readonly uploads: Map<string, Upload>;
}

const NS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const STORED_HEADERS = ['cache-control', 'content-disposition', 'content-encoding', 'content-language', 'expires'] as const;
const OVERRIDES: Readonly<Record<string, string>> = { 'response-content-type': 'content-type', 'response-content-disposition': 'content-disposition', 'response-cache-control': 'cache-control', 'response-content-language': 'content-language', 'response-content-encoding': 'content-encoding', 'response-expires': 'expires' };
const UNSUPPORTED = ['acl', 'tagging', 'versioning', 'versions', 'policy', 'cors', 'lifecycle', 'encryption', 'location', 'website', 'logging', 'notification', 'replication', 'accelerate', 'object-lock', 'retention', 'legal-hold', 'restore', 'select', 'torrent', 'attributes', 'versionId', 'analytics', 'inventory', 'metrics', 'ownershipControls', 'publicAccessBlock', 'requestPayment', 'intelligent-tiering'];

const xml = (root: string, inner: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NS}">${inner}</${root}>`, 'utf8');
const tag = (name: string, v: string | number | boolean | undefined) => (v === undefined ? '' : `<${name}>${escapeXml(String(v))}</${name}>`);
const iso = (ms: number) => new Date(ms).toISOString();
const quoted = (etag: string) => `"${etag}"`;
const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const md5hex = (b: Uint8Array) => createHash('md5').update(b).digest('hex');

export function validBucketName(n: string): boolean {
  if (n.length < 3 || n.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(n)) return false;
  if (n.includes('..') || n.includes('.-') || n.includes('-.')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(n)) return false;
  return !n.startsWith('xn--') && !n.startsWith('sthree-') && !n.endsWith('-s3alias') && !n.endsWith('--ol-s3');
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function validKey(k: string): boolean {
  if (k.length === 0 || Buffer.byteLength(k, 'utf8') > 1024 || LONE_SURROGATE.test(k)) return false;
  return !/[\u0000-\u001f\u007f]/.test(k);
}

const normEtag = (s: string) => s.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
const etagList = (h: string) => h.split(',').map(normEtag).filter((x) => x !== '');

export class S3 {
  private readonly buckets = new Map<string, Bucket>();
  private readonly o: S3Options & { region: string; maxObjectBytes: number; minPartBytes: number; maxParts: number; maxOpenUploads: number; maxBuckets: number; maxMaxKeys: number };
  private readonly now: () => Date;
  private readonly newId: () => string;
  private reqSeq = 0;

  constructor(o: S3Options) {
    this.o = { region: 'us-east-1', maxObjectBytes: 5 * 1024 ** 3, minPartBytes: 5 * 1024 * 1024, maxParts: 10_000, maxOpenUploads: 1000, maxBuckets: 100, maxMaxKeys: 1000, ...o };
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? randomUUID;
  }

  /** Buckets and object counts, for the operator. */
  stats(): { buckets: number; objects: number; bytes: number } {
    let objects = 0;
    let bytes = 0;
    for (const b of this.buckets.values()) for (const m of b.objects.values()) (objects++, (bytes += m.size));
    return { buckets: this.buckets.size, objects, bytes };
  }

  async handle(req: S3Request): Promise<S3Response> {
    const requestId = `${(++this.reqSeq).toString(16).padStart(8, '0')}`;
    const common = { 'x-amz-request-id': requestId, server: 'zthr-s3' };
    let resource = '/';
    try {
      const url = new URL(req.url);
      resource = url.pathname;
      const res = await this.route(req, url);
      return { ...res, headers: { ...common, ...res.headers } };
    } catch (e) {
      const err = e instanceof S3Error ? e : e instanceof SigV4Error ? new S3Error(e.code, e.status, e.message) : e instanceof TooLarge ? new S3Error('EntityTooLarge', 400, `the object is larger than ${e.limit} bytes`, { MaxSizeAllowed: String(e.limit) }) : undefined;
      if (!err) throw e;
      const head = req.method.toUpperCase() === 'HEAD';
      const body = head || err.status === 304 ? undefined : Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<Error>${tag('Code', err.code)}${tag('Message', err.message)}${Object.entries(err.extra).map(([k, v]) => tag(k, v)).join('')}${tag('Resource', resource)}${tag('RequestId', requestId)}</Error>`, 'utf8');
      return { status: err.status, headers: { ...common, ...(body ? { 'content-type': 'application/xml', 'content-length': String(body.length) } : {}) }, body };
    }
  }

  // --- routing --------------------------------------------------------------------------------------------

  private async route(req: S3Request, url: URL): Promise<S3Response> {
    const method = req.method.toUpperCase();
    const h = new Map<string, string>();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) h.set(k.toLowerCase(), v);
    const query = url.searchParams;
    // The URL parser resolves dot segments and turns backslashes into slashes, so a request could name another
    // bucket than the one it appears to; look at the path as it was sent.
    const raw = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(req.url)?.[1] ?? '';
    if (raw.includes('\\')) throw new S3Error('InvalidURI', 400, 'the path contains a backslash');
    for (const seg of raw.split('/')) {
      let d: string;
      try {
        d = decodeURIComponent(seg);
      } catch {
        throw new S3Error('InvalidURI', 400, 'the path is not valid percent-encoding');
      }
      if (d === '.' || d === '..') throw new S3Error('InvalidURI', 400, 'dot segments are not allowed in a path');
    }
    if (!/^\/[^?#]*$/.test(url.pathname)) throw new S3Error('InvalidURI', 400, 'the path is not valid');
    let bucket: string | undefined;
    let key: string | undefined;
    const rest = url.pathname.slice(1);
    if (rest !== '') {
      const slash = rest.indexOf('/');
      try {
        bucket = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
        const k = slash < 0 ? '' : rest.slice(slash + 1);
        key = k === '' ? undefined : decodeURIComponent(k);
      } catch {
        throw new S3Error('InvalidURI', 400, 'the path is not valid percent-encoding');
      }
    }
    for (const u of UNSUPPORTED) if (query.has(u)) throw new S3Error('NotImplemented', 501, `${u} is not supported`);
    const action = this.actionOf(method, bucket, key, query);
    const v = this.authenticate(req, url, h, action, bucket, key);
    const who = v?.accessKeyId;
    if (bucket !== undefined && !validBucketName(bucket) && !(method === 'GET' || method === 'HEAD' || method === 'DELETE')) throw new S3Error('InvalidBucketName', 400, 'the bucket name is not valid');
    if (!this.allowed(who, action, bucket, key)) throw new S3Error('AccessDenied', 403, 'access denied');

    if (bucket === undefined) {
      if (method !== 'GET') throw new S3Error('MethodNotAllowed', 405, 'the method is not allowed on the service');
      return this.listBuckets(who!);
    }
    if (key === undefined) return this.bucketOp(method, bucket, who, query, req, h);
    if (key !== undefined && !validKey(key)) throw new S3Error('KeyTooLongError', 400, 'a key is 1 to 1024 UTF-8 bytes without control characters');
    return this.objectOp(method, bucket, key, v, query, req, h);
  }

  private actionOf(method: string, bucket: string | undefined, key: string | undefined, q: URLSearchParams): Action {
    if (bucket === undefined) return 's3:ListAllMyBuckets';
    if (key === undefined) {
      if (method === 'PUT') return 's3:CreateBucket';
      if (method === 'DELETE') return 's3:DeleteBucket';
      if (method === 'GET' && q.has('uploads')) return 's3:ListBucketMultipartUploads';
      if (method === 'POST' && q.has('delete')) return 's3:DeleteObject';
      return 's3:ListBucket';
    }
    if (q.has('uploadId')) return method === 'DELETE' ? 's3:AbortMultipartUpload' : method === 'GET' ? 's3:ListMultipartUploadParts' : 's3:PutObject';
    if (method === 'GET' || method === 'HEAD') return 's3:GetObject';
    if (method === 'DELETE') return 's3:DeleteObject';
    return 's3:PutObject';
  }

  private allowed(who: string | undefined, action: Action, bucket: string | undefined, key: string | undefined): boolean {
    if (who === undefined) return bucket !== undefined && (this.o.anonymous?.(action, bucket, key) ?? false);
    if (this.o.authorize) return this.o.authorize(who, action, bucket, key);
    if (action === 's3:ListAllMyBuckets' || action === 's3:CreateBucket') return true;
    const b = bucket === undefined ? undefined : this.buckets.get(bucket);
    return b === undefined || b.owner === who;
  }

  private authenticate(req: S3Request, url: URL, h: Map<string, string>, action: Action, bucket: string | undefined, key: string | undefined): Verified | undefined {
    const signed = h.has('authorization') || url.searchParams.has('X-Amz-Signature');
    if (!signed) {
      if (bucket !== undefined && this.o.anonymous?.(action, bucket, key)) return undefined;
      throw new S3Error('AccessDenied', 403, 'the request is not signed');
    }
    return verify({ method: req.method, url: req.url, headers: Object.fromEntries(h) }, { now: this.now(), secretFor: this.o.secretFor, scopes: [{ region: this.o.region, service: 's3' }] });
  }

  // --- buckets --------------------------------------------------------------------------------------------

  private listBuckets(who: string): S3Response {
    const mine = [...this.buckets.values()].filter((b) => this.o.authorize === undefined ? b.owner === who : this.o.authorize(who, 's3:ListBucket', b.name, undefined)).sort((a, b) => (a.name < b.name ? -1 : 1));
    const body = xml('ListAllMyBucketsResult', `<Owner>${tag('ID', who)}${tag('DisplayName', who)}</Owner><Buckets>${mine.map((b) => `<Bucket>${tag('Name', b.name)}${tag('CreationDate', iso(b.created))}</Bucket>`).join('')}</Buckets>`);
    return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
  }

  private bucketOf(name: string): Bucket {
    const b = this.buckets.get(name);
    if (!b) throw new S3Error('NoSuchBucket', 404, 'the specified bucket does not exist', { BucketName: name });
    return b;
  }

  private async bucketOp(method: string, name: string, who: string | undefined, q: URLSearchParams, req: S3Request, h: Map<string, string>): Promise<S3Response> {
    switch (method) {
      case 'PUT': {
        if (!validBucketName(name)) throw new S3Error('InvalidBucketName', 400, 'the bucket name is not valid');
        const have = this.buckets.get(name);
        if (have) throw new S3Error(have.owner === who ? 'BucketAlreadyOwnedByYou' : 'BucketAlreadyExists', 409, 'the bucket already exists', { BucketName: name });
        if (this.buckets.size >= this.o.maxBuckets) throw new S3Error('TooManyBuckets', 400, `at most ${this.o.maxBuckets} buckets`);
        const body = req.body === undefined ? Buffer.alloc(0) : await collect(req.body, 64 * 1024);
        if (body.length) {
          const loc = locationOf(body);
          if (loc !== undefined && loc !== '' && loc !== this.o.region) throw new S3Error('IllegalLocationConstraintException', 400, `this server's region is ${this.o.region}`);
        }
        if (who === undefined) throw new S3Error('AccessDenied', 403, 'creating a bucket needs a signed request');
        this.buckets.set(name, { name, owner: who, created: this.now().getTime(), objects: new Map(), uploads: new Map() });
        return { status: 200, headers: { location: `/${name}`, 'content-length': '0' }, body: undefined };
      }
      case 'HEAD':
        this.bucketOf(name);
        return { status: 200, headers: { 'x-amz-bucket-region': this.o.region, 'content-length': '0' }, body: undefined };
      case 'DELETE': {
        const b = this.bucketOf(name);
        if (b.objects.size > 0 || b.uploads.size > 0) throw new S3Error('BucketNotEmpty', 409, 'the bucket you tried to delete is not empty');
        this.buckets.delete(name);
        return { status: 204, headers: {}, body: undefined };
      }
      case 'GET': {
        const b = this.bucketOf(name);
        if (q.has('uploads')) return this.listUploads(b, q);
        return this.listObjects(b, q);
      }
      case 'POST': {
        if (!q.has('delete')) throw new S3Error('MethodNotAllowed', 405, 'the method is not allowed on a bucket');
        return this.multiDelete(this.bucketOf(name), req, h);
      }
      default:
        throw new S3Error('MethodNotAllowed', 405, 'the method is not allowed on a bucket');
    }
  }

  // --- listing --------------------------------------------------------------------------------------------

  private listObjects(b: Bucket, q: URLSearchParams): S3Response {
    const v2 = q.get('list-type') === '2';
    if (q.has('list-type') && !v2) throw new S3Error('InvalidArgument', 400, 'list-type must be 2');
    const prefix = q.get('prefix') ?? '';
    const delimiter = q.get('delimiter') ?? '';
    const mkRaw = q.get('max-keys');
    let maxKeys = this.o.maxMaxKeys;
    if (mkRaw !== null) {
      if (!/^\d{1,9}$/.test(mkRaw)) throw new S3Error('InvalidArgument', 400, 'max-keys must be a non-negative integer');
      maxKeys = Math.min(Number(mkRaw), this.o.maxMaxKeys);
    }
    const enc = q.get('encoding-type');
    if (enc !== null && enc !== 'url') throw new S3Error('InvalidArgument', 400, 'encoding-type must be url');
    let marker = '';
    const token = q.get('continuation-token');
    if (v2) {
      if (token !== null) {
        const k = Buffer.from(token, 'base64url').toString('utf8');
        if (token === '' || Buffer.from(k, 'utf8').toString('base64url') !== token) throw new S3Error('InvalidArgument', 400, 'the continuation token is not valid');
        marker = k;
      } else marker = q.get('start-after') ?? '';
    } else marker = q.get('marker') ?? '';
    const keys = [...b.objects.keys()].sort(byteCompare);
    const contents: Meta[] = [];
    const prefixes: string[] = [];
    let truncated = false;
    let last = '';
    let count = 0;
    for (const k of keys) {
      if (byteCompare(k, marker) <= 0) continue;
      if (!k.startsWith(prefix)) continue;
      if (delimiter && marker.endsWith(delimiter) && marker.length > prefix.length && k.startsWith(marker)) continue;
      let entry: string | undefined;
      if (delimiter) {
        const i = k.slice(prefix.length).indexOf(delimiter);
        if (i >= 0) entry = k.slice(0, prefix.length + i + delimiter.length);
      }
      if (entry !== undefined && prefixes[prefixes.length - 1] === entry) continue;
      if (count >= maxKeys) {
        truncated = true;
        break;
      }
      count++;
      if (entry !== undefined) (prefixes.push(entry), (last = entry));
      else (contents.push(b.objects.get(k)!), (last = k));
    }
    if (maxKeys === 0) truncated = false;
    const e = (s: string) => (enc === 'url' ? encodeURIComponent(s).replace(/%2F/g, '/') : s);
    const items = contents.map((m) => `<Contents>${tag('Key', e(m.key))}${tag('LastModified', iso(m.modified))}${tag('ETag', quoted(m.etag))}${tag('Size', m.size)}${tag('StorageClass', 'STANDARD')}</Contents>`).join('');
    const cps = prefixes.map((p) => `<CommonPrefixes>${tag('Prefix', e(p))}</CommonPrefixes>`).join('');
    const head = `${tag('Name', b.name)}${tag('Prefix', e(prefix))}`;
    const inner = v2
      ? `${head}${tag('KeyCount', count)}${tag('MaxKeys', maxKeys)}${delimiter ? tag('Delimiter', e(delimiter)) : ''}${tag('IsTruncated', truncated)}${token !== null ? tag('ContinuationToken', token) : ''}${truncated ? tag('NextContinuationToken', Buffer.from(last, 'utf8').toString('base64url')) : ''}${q.get('start-after') ? tag('StartAfter', e(q.get('start-after')!)) : ''}${enc ? tag('EncodingType', enc) : ''}${items}${cps}`
      : `${head}${tag('Marker', e(marker))}${tag('MaxKeys', maxKeys)}${delimiter ? tag('Delimiter', e(delimiter)) : ''}${tag('IsTruncated', truncated)}${truncated && delimiter ? tag('NextMarker', e(last)) : ''}${enc ? tag('EncodingType', enc) : ''}${items}${cps}`;
    const body = xml('ListBucketResult', inner);
    return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
  }

  private listUploads(b: Bucket, q: URLSearchParams): S3Response {
    const prefix = q.get('prefix') ?? '';
    const ups = [...b.uploads.values()].filter((u) => u.key.startsWith(prefix)).sort((a, c) => byteCompare(a.key, c.key) || a.initiated - c.initiated);
    const body = xml('ListMultipartUploadsResult', `${tag('Bucket', b.name)}${tag('Prefix', prefix)}${tag('MaxUploads', 1000)}${tag('IsTruncated', false)}${ups.map((u) => `<Upload>${tag('Key', u.key)}${tag('UploadId', u.id)}${tag('Initiated', iso(u.initiated))}${tag('StorageClass', 'STANDARD')}</Upload>`).join('')}`);
    return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
  }

  private async multiDelete(b: Bucket, req: S3Request, h: Map<string, string>): Promise<S3Response> {
    const raw = await collect(req.body ?? Buffer.alloc(0), 1024 * 1024);
    const md5 = h.get('content-md5');
    if (md5 !== undefined && Buffer.from(md5, 'base64').toString('hex') !== md5hex(raw)) throw new S3Error('BadDigest', 400, 'the Content-MD5 does not match the body');
    const root = xmlBody(raw);
    if (root.name !== 'Delete') throw new S3Error('MalformedXML', 400, 'expected a Delete document');
    const objs = root.children.filter((c) => c.name === 'Object');
    if (objs.length === 0 || objs.length > 1000) throw new S3Error('MalformedXML', 400, 'a Delete lists 1 to 1000 objects');
    const quiet = root.children.find((c) => c.name === 'Quiet')?.text.trim() === 'true';
    let out = '';
    for (const o of objs) {
      const k = o.children.find((c) => c.name === 'Key')?.text;
      if (k === undefined || !validKey(k)) {
        out += `<Error>${tag('Key', k ?? '')}${tag('Code', 'InvalidArgument')}${tag('Message', 'the key is not valid')}</Error>`;
        continue;
      }
      await this.removeObject(b, k);
      if (!quiet) out += `<Deleted>${tag('Key', k)}</Deleted>`;
    }
    const body = xml('DeleteResult', out);
    return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
  }

  // --- objects --------------------------------------------------------------------------------------------

  private async removeObject(b: Bucket, key: string): Promise<void> {
    const m = b.objects.get(key);
    if (!m) return;
    b.objects.delete(key);
    await this.o.objects.delete(m.blob);
  }

  private userMeta(h: Map<string, string>): { user: Record<string, string>; headers: Record<string, string>; contentType: string } {
    const user: Record<string, string> = Object.create(null);
    let size = 0;
    for (const [k, v] of h) {
      if (!k.startsWith('x-amz-meta-')) continue;
      if (!/^[\x20-\x7e]*$/.test(v)) throw new S3Error('InvalidArgument', 400, `the value of ${k} must be printable ASCII`);
      size += k.length - 11 + v.length;
      user[k.slice(11)] = v;
    }
    if (size > 2048) throw new S3Error('MetadataTooLarge', 400, 'user metadata is limited to 2 KB');
    const headers: Record<string, string> = {};
    for (const k of STORED_HEADERS) {
      const v = h.get(k);
      if (v === undefined) continue;
      if (!/^[\x20-\x7e]{0,1024}$/.test(v)) throw new S3Error('InvalidArgument', 400, `${k} must be printable ASCII of at most 1024 characters`);
      headers[k] = v;
    }
    const ct = h.get('content-type') ?? 'binary/octet-stream';
    if (!/^[\x20-\x7e]{1,255}$/.test(ct)) throw new S3Error('InvalidArgument', 400, 'content-type must be printable ASCII');
    return { user, headers, contentType: ct };
  }

  private metaHeaders(m: Meta): Record<string, string> {
    const out: Record<string, string> = { etag: quoted(m.etag), 'last-modified': new Date(m.modified).toUTCString(), 'content-type': m.contentType, 'accept-ranges': 'bytes', ...m.headers };
    for (const [k, v] of Object.entries(m.user)) out[`x-amz-meta-${k}`] = v;
    return out;
  }

  private preconditions(m: Meta | undefined, h: Map<string, string>, write: boolean): S3Response | undefined {
    const exists = m !== undefined;
    const ifMatch = h.get('if-match');
    const ifNone = h.get('if-none-match');
    const ims = h.get('if-modified-since');
    const ius = h.get('if-unmodified-since');
    const match = (list: string) => etagList(list).some((t) => t === '*' ? exists : exists && t === m!.etag);
    const date = (s: string | undefined) => { const t = s === undefined ? NaN : Date.parse(s); return Number.isNaN(t) ? undefined : t; };
    if (ifMatch !== undefined) {
      if (!match(ifMatch)) throw new S3Error('PreconditionFailed', 412, 'at least one of the preconditions you specified did not hold', { Condition: 'If-Match' });
    } else if (ius !== undefined && exists && date(ius) !== undefined && m!.modified > date(ius)!) throw new S3Error('PreconditionFailed', 412, 'at least one of the preconditions you specified did not hold', { Condition: 'If-Unmodified-Since' });
    if (ifNone !== undefined && match(ifNone)) {
      if (write) throw new S3Error('PreconditionFailed', 412, 'at least one of the preconditions you specified did not hold', { Condition: 'If-None-Match' });
      return { status: 304, headers: { etag: quoted(m!.etag), 'last-modified': new Date(m!.modified).toUTCString() }, body: undefined };
    }
    if (!write && ifNone === undefined && ims !== undefined && exists && date(ims) !== undefined && m!.modified <= date(ims)!) return { status: 304, headers: { etag: quoted(m!.etag), 'last-modified': new Date(m!.modified).toUTCString() }, body: undefined };
    return undefined;
  }

  private async objectOp(method: string, bname: string, key: string, v: Verified | undefined, q: URLSearchParams, req: S3Request, h: Map<string, string>): Promise<S3Response> {
    const b = this.bucketOf(bname);
    if (q.has('uploads') && method === 'POST') return this.createUpload(b, key, v?.accessKeyId ?? '', h);
    if (q.has('uploadId')) return this.uploadOp(method, b, key, v, q, req, h);
    switch (method) {
      case 'PUT': {
        if (q.has('partNumber')) throw new S3Error('InvalidArgument', 400, 'partNumber needs an uploadId');
        if (h.has('x-amz-copy-source')) return this.copy(b, key, h, v);
        return this.put(b, key, h, req, v);
      }
      case 'GET':
      case 'HEAD': {
        const m = b.objects.get(key);
        if (!m) throw new S3Error('NoSuchKey', 404, 'the specified key does not exist', { Key: key });
        const cond = this.preconditions(m, h, false);
        if (cond) return cond;
        const headers = this.metaHeaders(m);
        for (const [param, header] of Object.entries(OVERRIDES)) {
          const v = q.get(param);
          if (v === null) continue;
          if (!/^[\x20-\x7e]{0,1024}$/.test(v)) throw new S3Error('InvalidArgument', 400, `${param} must be printable ASCII`);
          headers[header] = v;
        }
        const range = parseRange(h.get('range'), m.size);
        if (range === 'unsatisfiable') throw new S3Error('InvalidRange', 416, 'the requested range is not satisfiable', { ActualObjectSize: String(m.size), RangeRequested: h.get('range')! });
        const part = range ?? { start: 0, end: m.size - 1 };
        const len = m.size === 0 ? 0 : part.end - part.start + 1;
        headers['content-length'] = String(len);
        if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${m.size}`;
        if (method === 'HEAD' || len === 0) return { status: range ? 206 : 200, headers, body: undefined };
        let stream: AsyncIterable<Uint8Array>;
        try {
          stream = await this.o.objects.get(m.blob, range ? { start: range.start, end: range.end } : undefined);
        } catch (e) {
          if (e instanceof Missing) throw new S3Error('InternalError', 500, 'the stored bytes are missing');
          throw e;
        }
        return { status: range ? 206 : 200, headers, body: undefined, stream };
      }
      case 'DELETE':
        await this.removeObject(b, key);
        return { status: 204, headers: {}, body: undefined };
      case 'POST':
        throw new S3Error('InvalidRequest', 400, 'POST on an object needs ?uploads or ?uploadId');
      default:
        throw new S3Error('MethodNotAllowed', 405, 'the method is not allowed on an object');
    }
  }

  /** Reads a request body into the store, checking sizes and digests; returns the stored blob's facts. */
  private async store(req: S3Request, h: Map<string, string>, limit: number, vr: Verified | undefined): Promise<{ blob: string; size: number; md5: string }> {
    const lenHeader = h.get('content-length') ?? h.get('x-amz-decoded-content-length');
    if (lenHeader !== undefined && /^\d+$/.test(lenHeader) && Number(lenHeader) > limit) throw new S3Error('EntityTooLarge', 400, `the object is larger than ${limit} bytes`, { MaxSizeAllowed: String(limit) });
    let data: Uint8Array | AsyncIterable<Uint8Array> = req.body ?? new Uint8Array(0);
    const v = vr;
    if (v?.streaming) {
      const raw = await collect(data, limit + Math.ceil(limit / 65_536) * 200 + 1024);
      const declared = h.get('x-amz-decoded-content-length');
      data = decodeChunked(raw, v.signature, this.o.secretFor(v.accessKeyId)!, v.amzDate, { region: v.region, service: v.service }, { maxChunk: 16 * 1024 * 1024, ...(declared !== undefined && /^\d+$/.test(declared) ? { decodedLength: Number(declared) } : {}) });
    }
    const w = await this.o.objects.put(data, { algos: ['MD5', 'SHA256'], maxBytes: limit });
    const md5 = w.checksums.find((c) => c.startsWith('MD5:'))!.slice(4);
    const sha = w.checksums.find((c) => c.startsWith('SHA256:'))!.slice(7);
    const bad = async (code: string, msg: string): Promise<never> => {
      await this.o.objects.delete(w.key);
      throw new S3Error(code, 400, msg);
    };
    const cmd5 = h.get('content-md5');
    if (cmd5 !== undefined && Buffer.from(cmd5, 'base64').toString('hex') !== md5) await bad('BadDigest', 'the Content-MD5 you specified did not match what was received');
    const declaredSha = h.get('x-amz-content-sha256');
    if (declaredSha !== undefined && /^[0-9a-f]{64}$/.test(declaredSha) && declaredSha !== sha) await bad('XAmzContentSHA256Mismatch', 'the provided x-amz-content-sha256 does not match what was computed');
    return { blob: w.key, size: w.size, md5 };
  }

  private async put(b: Bucket, key: string, h: Map<string, string>, req: S3Request, v: Verified | undefined): Promise<S3Response> {
    const before = b.objects.get(key);
    this.preconditions(before, h, true);
    const meta = this.userMeta(h);
    const w = await this.store(req, h, this.o.maxObjectBytes, v);
    const m: Meta = { key, blob: w.blob, size: w.size, etag: w.md5, modified: Math.floor(this.now().getTime() / 1000) * 1000, contentType: meta.contentType, headers: meta.headers, user: meta.user };
    const old = b.objects.get(key);
    b.objects.set(key, m);
    if (old) await this.o.objects.delete(old.blob);
    return { status: 200, headers: { etag: quoted(m.etag), 'content-length': '0' }, body: undefined };
  }

  private async copy(b: Bucket, key: string, h: Map<string, string>, v: Verified | undefined): Promise<S3Response> {
    const raw = h.get('x-amz-copy-source')!;
    let src: string;
    try {
      src = decodeURIComponent(raw.replace(/^\//, ''));
    } catch {
      throw new S3Error('InvalidArgument', 400, 'x-amz-copy-source is not valid');
    }
    if (src.includes('?versionId=')) throw new S3Error('NotImplemented', 501, 'versions are not supported');
    const slash = src.indexOf('/');
    if (slash < 1) throw new S3Error('InvalidArgument', 400, 'x-amz-copy-source must be bucket/key');
    const sb = this.bucketOf(src.slice(0, slash));
    const sk = src.slice(slash + 1);
    const sm = sb.objects.get(sk);
    if (!sm) throw new S3Error('NoSuchKey', 404, 'the specified source key does not exist', { Key: sk });
    if (!this.allowed(v?.accessKeyId, 's3:GetObject', sb.name, sk)) throw new S3Error('AccessDenied', 403, 'access denied to the copy source');
    const replace = (h.get('x-amz-metadata-directive') ?? 'COPY').toUpperCase();
    if (replace !== 'COPY' && replace !== 'REPLACE') throw new S3Error('InvalidArgument', 400, 'x-amz-metadata-directive is COPY or REPLACE');
    if (sb === b && sk === key && replace === 'COPY') throw new S3Error('InvalidRequest', 400, 'this copy request is illegal because it is trying to copy an object to itself without changing the object\'s metadata');
    this.preconditions(b.objects.get(key), h, true);
    const meta = replace === 'REPLACE' ? this.userMeta(h) : { user: sm.user, headers: sm.headers, contentType: sm.contentType };
    const w = await this.o.objects.compose([sm.blob]);
    const m: Meta = { key, blob: w.key, size: sm.size, etag: sm.etag, modified: Math.floor(this.now().getTime() / 1000) * 1000, contentType: meta.contentType, headers: meta.headers, user: meta.user };
    const old = b.objects.get(key);
    b.objects.set(key, m);
    if (old) await this.o.objects.delete(old.blob);
    const body = xml('CopyObjectResult', `${tag('LastModified', iso(m.modified))}${tag('ETag', quoted(m.etag))}`);
    return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
  }

  // --- multipart ------------------------------------------------------------------------------------------

  private async createUpload(b: Bucket, key: string, owner: string, h: Map<string, string>): Promise<S3Response> {
    if (b.uploads.size >= this.o.maxOpenUploads) throw new S3Error('SlowDown', 503, 'too many open multipart uploads');
    const meta = this.userMeta(h);
    const id = this.newId();
    b.uploads.set(id, { id, key, owner, initiated: this.now().getTime(), contentType: meta.contentType, headers: meta.headers, user: meta.user, parts: new Map() });
    const body = xml('InitiateMultipartUploadResult', `${tag('Bucket', b.name)}${tag('Key', key)}${tag('UploadId', id)}`);
    return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
  }

  private upload(b: Bucket, key: string, id: string, who: string | undefined): Upload {
    const u = b.uploads.get(id);
    if (!u || u.key !== key || (who !== undefined && u.owner !== who)) throw new S3Error('NoSuchUpload', 404, 'the specified multipart upload does not exist', { UploadId: id });
    return u;
  }

  private async uploadOp(method: string, b: Bucket, key: string, v: Verified | undefined, q: URLSearchParams, req: S3Request, h: Map<string, string>): Promise<S3Response> {
    const id = q.get('uploadId')!;
    const u = this.upload(b, key, id, v?.accessKeyId);
    switch (method) {
      case 'PUT': {
        const n = q.get('partNumber');
        if (n === null || !/^\d{1,5}$/.test(n) || Number(n) < 1 || Number(n) > this.o.maxParts) throw new S3Error('InvalidArgument', 400, `partNumber must be between 1 and ${this.o.maxParts}`);
        if (h.has('x-amz-copy-source')) throw new S3Error('NotImplemented', 501, 'UploadPartCopy is not supported');
        const w = await this.store(req, h, this.o.maxObjectBytes, v);
        if (!b.uploads.has(id)) {
          await this.o.objects.delete(w.blob);
          throw new S3Error('NoSuchUpload', 404, 'the specified multipart upload does not exist', { UploadId: id });
        }
        const old = u.parts.get(Number(n));
        u.parts.set(Number(n), { blob: w.blob, size: w.size, md5: w.md5, modified: this.now().getTime() });
        if (old) await this.o.objects.delete(old.blob);
        return { status: 200, headers: { etag: quoted(w.md5), 'content-length': '0' }, body: undefined };
      }
      case 'GET': {
        const marker = Number(q.get('part-number-marker') ?? 0);
        const maxRaw = q.get('max-parts');
        if (!Number.isInteger(marker) || marker < 0 || (maxRaw !== null && !/^\d{1,5}$/.test(maxRaw))) throw new S3Error('InvalidArgument', 400, 'part-number-marker and max-parts must be non-negative integers');
        const max = Math.min(maxRaw === null ? 1000 : Number(maxRaw), 1000);
        const all = [...u.parts.entries()].filter(([n]) => n > marker).sort((a, c) => a[0] - c[0]);
        const page = all.slice(0, max);
        const truncated = all.length > page.length;
        const body = xml('ListPartsResult', `${tag('Bucket', b.name)}${tag('Key', key)}${tag('UploadId', id)}${tag('PartNumberMarker', marker)}${truncated ? tag('NextPartNumberMarker', page[page.length - 1]![0]) : ''}${tag('MaxParts', max)}${tag('IsTruncated', truncated)}${page.map(([n, p]) => `<Part>${tag('PartNumber', n)}${tag('LastModified', iso(p.modified))}${tag('ETag', quoted(p.md5))}${tag('Size', p.size)}</Part>`).join('')}`);
        return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
      }
      case 'DELETE': {
        b.uploads.delete(id);
        for (const p of u.parts.values()) await this.o.objects.delete(p.blob);
        return { status: 204, headers: {}, body: undefined };
      }
      case 'POST':
        return this.complete(b, u, h, req);
      default:
        throw new S3Error('MethodNotAllowed', 405, 'the method is not allowed here');
    }
  }

  private async complete(b: Bucket, u: Upload, h: Map<string, string>, req: S3Request): Promise<S3Response> {
    const root = xmlBody(await collect(req.body ?? Buffer.alloc(0), 4 * 1024 * 1024));
    if (root.name !== 'CompleteMultipartUpload') throw new S3Error('MalformedXML', 400, 'expected a CompleteMultipartUpload document');
    const listed = root.children.filter((c) => c.name === 'Part').map((p) => ({ n: p.children.find((c) => c.name === 'PartNumber')?.text.trim() ?? '', etag: normEtag(p.children.find((c) => c.name === 'ETag')?.text ?? '') }));
    if (listed.length === 0) throw new S3Error('MalformedXML', 400, 'at least one part is required');
    if (listed.length > this.o.maxParts) throw new S3Error('InvalidRequest', 400, `at most ${this.o.maxParts} parts`);
    let prev = 0;
    const chosen: { n: number; p: Part }[] = [];
    for (const [i, l] of listed.entries()) {
      if (!/^\d{1,5}$/.test(l.n) || Number(l.n) < 1) throw new S3Error('MalformedXML', 400, 'a part number is a positive integer');
      const n = Number(l.n);
      if (n <= prev) throw new S3Error('InvalidPartOrder', 400, 'the list of parts was not in ascending order');
      prev = n;
      const p = u.parts.get(n);
      if (!p || p.md5 !== l.etag) throw new S3Error('InvalidPart', 400, `part ${n} was not found or its ETag does not match`, { PartNumber: String(n) });
      if (i < listed.length - 1 && p.size < this.o.minPartBytes) throw new S3Error('EntityTooSmall', 400, 'your proposed upload is smaller than the minimum allowed size', { ProposedSize: String(p.size), MinSizeAllowed: String(this.o.minPartBytes), PartNumber: String(n) });
      chosen.push({ n, p });
    }
    const total = chosen.reduce((s, c) => s + c.p.size, 0);
    if (total > this.o.maxObjectBytes) throw new S3Error('EntityTooLarge', 400, `the object would be larger than ${this.o.maxObjectBytes} bytes`);
    this.preconditions(b.objects.get(u.key), h, true);
    const joined = await this.o.objects.compose(chosen.map((c) => c.p.blob));
    const etag = `${createHash('md5').update(Buffer.concat(chosen.map((c) => Buffer.from(c.p.md5, 'hex')))).digest('hex')}-${chosen.length}`;
    const m: Meta = { key: u.key, blob: joined.key, size: joined.size, etag, modified: Math.floor(this.now().getTime() / 1000) * 1000, contentType: u.contentType, headers: u.headers, user: u.user };
    const old = b.objects.get(u.key);
    b.objects.set(u.key, m);
    b.uploads.delete(u.id);
    if (old) await this.o.objects.delete(old.blob);
    for (const p of u.parts.values()) await this.o.objects.delete(p.blob);
    const body = xml('CompleteMultipartUploadResult', `${tag('Location', `/${b.name}/${u.key}`)}${tag('Bucket', b.name)}${tag('Key', u.key)}${tag('ETag', quoted(etag))}`);
    return { status: 200, headers: { 'content-type': 'application/xml', 'content-length': String(body.length) }, body };
  }
}

function xmlBody(raw: Buffer): El {
  try {
    return parseXml(raw.toString('utf8'), { maxBytes: 4 * 1024 * 1024 });
  } catch {
    throw new S3Error('MalformedXML', 400, 'the XML you provided was not well-formed or did not validate');
  }
}

function locationOf(body: Buffer): string | undefined {
  const root = xmlBody(body);
  if (root.name !== 'CreateBucketConfiguration') throw new S3Error('MalformedXML', 400, 'expected a CreateBucketConfiguration document');
  return root.children.find((c) => c.name === 'LocationConstraint')?.text.trim();
}

async function collect(src: Uint8Array | AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  if (src instanceof Uint8Array) {
    if (src.length > limit) throw new S3Error('EntityTooLarge', 400, `the request body is larger than ${limit} bytes`);
    return Buffer.from(src);
  }
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of src) {
    n += c.length;
    if (n > limit) throw new S3Error('EntityTooLarge', 400, `the request body is larger than ${limit} bytes`);
    parts.push(Buffer.from(c));
  }
  return Buffer.concat(parts);
}

export { collect as readBody };
