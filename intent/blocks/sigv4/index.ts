/**
 * AWS Signature Version 4, both ways. Signing: the canonical request (method, path, sorted query, lower-cased and
 * trimmed headers, signed header list, payload hash), the string to sign, the date/region/service/"aws4_request"
 * key derivation, header authorisation, presigned URLs (X-Amz-* query parameters, 1 second to 7 days) and the
 * chunked upload signature chain (STREAMING-AWS4-HMAC-SHA256-PAYLOAD). Verifying: the same computation on what
 * arrived, compared in constant time, with the credential scope checked against what the service serves, clock
 * skew (default 15 minutes) and presign expiry enforced, "host" required among the signed headers, and any
 * algorithm but AWS4-HMAC-SHA256 refused. Matches the published AWS examples (see the tests).
 *
 * Path rules follow the service: for "s3" the path is encoded once and not normalised; for every other service it
 * is normalised and encoded twice. Clock is an argument.
 * Out of scope: SigV4a (ECDSA, multi-region), the trailing-checksum streaming variants, event-stream signing.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const STREAMING_PAYLOAD = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** An authorisation failure, with the S3-style error code and the HTTP status to answer with. */
export class SigV4Error extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface Scope {
  readonly region: string;
  readonly service: string;
}

export interface SignableRequest {
  readonly method: string;
  /** Absolute URL, as the client addressed it (the host in it is the one that was signed). */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

const sha256hex = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const hmac = (key: string | Uint8Array, data: string) => createHmac('sha256', key).update(data).digest();
const hmacHex = (key: Uint8Array, data: string) => createHmac('sha256', key).update(data).digest('hex');

export const hashPayload = sha256hex;

/** URI-encode as AWS wants: everything but A-Z a-z 0-9 - _ . ~ as upper-case %XX, UTF-8 bytes. */
export function awsEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new SigV4Error('InvalidURI', 400, 'the path or query is not valid percent-encoding');
  }
};

/** The canonical path for a service: s3 once and as given, others normalised and encoded twice. */
export function canonicalPath(pathname: string, service: string): string {
  const raw = pathname === '' ? '/' : pathname;
  if (service === 's3') return raw.split('/').map((seg) => awsEncode(decode(seg))).join('/');
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    const d = decode(seg);
    if (d === '' || d === '.') continue;
    if (d === '..') out.pop();
    else out.push(d);
  }
  const trailing = raw.endsWith('/') && out.length > 0 ? '/' : '';
  return `/${out.map((s) => awsEncode(awsEncode(s))).join('/')}${trailing}`;
}

/** The canonical query: names and values decoded and encoded again, sorted by name then value. */
export function canonicalQuery(search: string, drop: readonly string[] = []): string {
  const q = search.startsWith('?') ? search.slice(1) : search;
  if (!q) return '';
  const pairs: [string, string][] = [];
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decode((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decode(part.slice(i + 1).replace(/\+/g, ' '));
    if (drop.includes(k)) continue;
    pairs.push([awsEncode(k), awsEncode(v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

const lower = (h: Readonly<Record<string, string>> | undefined) => {
  const o = new Map<string, string>();
  for (const [k, v] of Object.entries(h ?? {})) {
    const n = k.toLowerCase();
    const val = String(v).trim().replace(/\s+/g, ' ');
    o.set(n, o.has(n) ? `${o.get(n)},${val}` : val);
  }
  return o;
};

/** The canonical request text. `signed` are lower-case header names; each must be present in `headers`. */
export function canonicalRequest(req: SignableRequest, signed: readonly string[], payloadHash: string, service: string, dropQuery: readonly string[] = []): string {
  const u = new URL(req.url);
  const h = lower(req.headers);
  if (!h.has('host')) h.set('host', u.host);
  const names = [...signed].map((s) => s.toLowerCase()).sort();
  const lines = names.map((n) => {
    const v = h.get(n);
    if (v === undefined) throw new SigV4Error('AuthorizationHeaderMalformed', 400, `signed header ${n} is not in the request`);
    return `${n}:${v}\n`;
  });
  return [req.method.toUpperCase(), canonicalPath(u.pathname, service), canonicalQuery(u.search, dropQuery), lines.join(''), names.join(';'), payloadHash].join('\n');
}

const amzDateOf = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The signing key for a day, region and service. */
export function signingKey(secret: string, day: string, scope: Scope): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), scope.region), scope.service), 'aws4_request');
}

const scopeString = (day: string, s: Scope) => `${day}/${s.region}/${s.service}/aws4_request`;

export function stringToSign(amzDate: string, scope: Scope, canonical: string): string {
  return [ALGORITHM, amzDate, scopeString(amzDate.slice(0, 8), scope), sha256hex(canonical)].join('\n');
}

export interface SignOptions extends Scope {
  readonly now: Date;
  /** Header names to sign; default every header given, plus host and x-amz-date. */
  readonly signHeaders?: readonly string[];
  /** Send and sign x-amz-content-sha256 (default true for s3). */
  readonly contentSha256Header?: boolean;
  /** Use this as the payload hash (UNSIGNED-PAYLOAD, or STREAMING-AWS4-HMAC-SHA256-PAYLOAD) instead of hashing the body. */
  readonly payloadHash?: string;
}

export interface Signed {
  /** Headers to send: those given, plus host, x-amz-date, x-amz-content-sha256 and x-amz-security-token as needed, plus Authorization. */
  readonly headers: Record<string, string>;
  readonly authorization: string;
  /** The signature, and the signed header list. For a chunked upload this is the seed signature. */
  readonly signature: string;
  readonly signedHeaders: string;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly amzDate: string;
  readonly payloadHash: string;
}

export function sign(req: SignableRequest, creds: Credentials, o: SignOptions): Signed {
  const u = new URL(req.url);
  const amzDate = amzDateOf(o.now);
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  const have = (n: string) => Object.keys(headers).some((k) => k.toLowerCase() === n);
  if (!have('host')) headers['host'] = u.host;
  if (!have('x-amz-date')) headers['x-amz-date'] = amzDate;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const body = req.body ?? '';
  const payloadHash = o.payloadHash ?? (have('x-amz-content-sha256') ? lower(headers).get('x-amz-content-sha256')! : sha256hex(body));
  if (o.contentSha256Header ?? o.service === 's3') headers['x-amz-content-sha256'] = payloadHash;
  const signed = (o.signHeaders ?? Object.keys(headers)).map((s) => s.toLowerCase());
  for (const need of ['host', 'x-amz-date']) if (!signed.includes(need)) signed.push(need);
  const names = [...new Set(signed)].sort();
  const cr = canonicalRequest({ ...req, headers }, names, payloadHash, o.service);
  const sts = stringToSign(amzDate, o, cr);
  const signature = hmacHex(signingKey(creds.secretAccessKey, amzDate.slice(0, 8), o), sts);
  const signedHeaders = names.join(';');
  const authorization = `${ALGORITHM} Credential=${creds.accessKeyId}/${scopeString(amzDate.slice(0, 8), o)},SignedHeaders=${signedHeaders},Signature=${signature}`;
  headers['Authorization'] = authorization;
  return { headers, authorization, signature, signedHeaders, canonicalRequest: cr, stringToSign: sts, amzDate, payloadHash };
}

export interface PresignOptions extends Scope {
  readonly now: Date;
  readonly expiresSec: number;
  /** Headers that must be sent unchanged with the URL (always includes host). */
  readonly signHeaders?: Readonly<Record<string, string>>;
}

/** A presigned URL: the signature in the query, the payload unsigned. Expires 1 second to 7 days after `now`. */
export function presign(req: Omit<SignableRequest, 'body'>, creds: Credentials, o: PresignOptions): string {
  if (!Number.isInteger(o.expiresSec) || o.expiresSec < 1 || o.expiresSec > 604_800) throw new SigV4Error('AuthorizationQueryParametersError', 400, 'X-Amz-Expires must be between 1 and 604800 seconds');
  const u = new URL(req.url);
  const amzDate = amzDateOf(o.now);
  const hdrs: Record<string, string> = { ...(o.signHeaders ?? {}), host: u.host };
  const signed = [...lower(hdrs).keys()].sort();
  const params = new URLSearchParams(u.search);
  params.set('X-Amz-Algorithm', ALGORITHM);
  params.set('X-Amz-Credential', `${creds.accessKeyId}/${scopeString(amzDate.slice(0, 8), o)}`);
  params.set('X-Amz-Date', amzDate);
  params.set('X-Amz-Expires', String(o.expiresSec));
  params.set('X-Amz-SignedHeaders', signed.join(';'));
  if (creds.sessionToken) params.set('X-Amz-Security-Token', creds.sessionToken);
  u.search = params.toString().replace(/\+/g, '%20');
  const payload = o.service === 's3' ? UNSIGNED_PAYLOAD : EMPTY_SHA256;
  const cr = canonicalRequest({ method: req.method, url: u.toString(), headers: hdrs }, signed, payload, o.service);
  const signature = hmacHex(signingKey(creds.secretAccessKey, amzDate.slice(0, 8), o), stringToSign(amzDate, o, cr));
  u.search = `${u.search}&X-Amz-Signature=${signature}`;
  return u.toString();
}

export interface Verified {
  readonly accessKeyId: string;
  readonly region: string;
  readonly service: string;
  readonly signedHeaders: readonly string[];
  readonly signature: string;
  readonly payloadHash: string;
  readonly presigned: boolean;
  /** True when the body is a signed chunk chain: read it with `decodeChunked`, seeded by `signature`. */
  readonly streaming: boolean;
  readonly amzDate: string;
  readonly sessionToken?: string;
}

export interface VerifyOptions {
  readonly now: Date;
  /** The secret for an access key, or undefined when it is unknown. */
  readonly secretFor: (accessKeyId: string) => string | undefined;
  /** Scopes this endpoint serves; the credential's region and service must be one of them. Default: any. */
  readonly scopes?: readonly Scope[];
  readonly maxSkewSec?: number;
  /** The body as received, to compare with a declared x-amz-content-sha256. */
  readonly body?: string | Uint8Array;
}

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

function parseAuthorization(h: string): { accessKeyId: string; day: string; scope: Scope; signed: string[]; signature: string } {
  const m = /^(\S+)\s+(.*)$/.exec(h.trim());
  if (!m) throw new SigV4Error('AuthorizationHeaderMalformed', 400, 'the Authorization header is not in the expected form');
  if (m[1] !== ALGORITHM) throw new SigV4Error('AuthorizationHeaderMalformed', 400, `only ${ALGORITHM} is accepted`);
  const parts: Record<string, string> = {};
  for (const p of m[2]!.split(',')) {
    const i = p.indexOf('=');
    if (i < 0) throw new SigV4Error('AuthorizationHeaderMalformed', 400, 'the Authorization header is not in the expected form');
    parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const { Credential, SignedHeaders, Signature } = parts;
  if (!Credential || !SignedHeaders || !Signature) throw new SigV4Error('AuthorizationHeaderMalformed', 400, 'Credential, SignedHeaders and Signature are all required');
  return { ...parseCredential(Credential), signed: SignedHeaders.split(';'), signature: Signature };
}

function parseCredential(c: string): { accessKeyId: string; day: string; scope: Scope } {
  const p = c.split('/');
  if (p.length !== 5 || p[4] !== 'aws4_request' || !p[0] || !/^\d{8}$/.test(p[1]!) || !p[2] || !p[3]) throw new SigV4Error('AuthorizationHeaderMalformed', 400, 'the credential must be KEY/YYYYMMDD/region/service/aws4_request');
  return { accessKeyId: p[0], day: p[1]!, scope: { region: p[2], service: p[3] } };
}

const parseAmzDate = (s: string): Date => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new SigV4Error('AuthorizationHeaderMalformed', 400, 'the date must be in the form YYYYMMDDTHHMMSSZ');
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
};

/**
 * Verifies a request signed by header or by presigned URL. Throws SigV4Error (with the S3 code and status) when
 * it is not believable; returns who signed it, and under what scope, when it is.
 */
export function verify(req: SignableRequest, o: VerifyOptions): Verified {
  const u = new URL(req.url);
  const h = lower(req.headers);
  const skew = (o.maxSkewSec ?? 900) * 1000;
  const auth = h.get('authorization');
  const q = new URLSearchParams(u.search);
  const presigned = q.has('X-Amz-Signature');
  if (presigned && auth) throw new SigV4Error('InvalidArgument', 400, 'a request may be signed by header or by query, not both');
  let id: ReturnType<typeof parseAuthorization>;
  let amzDate: string;
  let signed: string[];
  let signature: string;
  let sessionToken: string | undefined;
  if (presigned) {
    if (q.get('X-Amz-Algorithm') !== ALGORITHM) throw new SigV4Error('AuthorizationQueryParametersError', 400, `only ${ALGORITHM} is accepted`);
    const cred = q.get('X-Amz-Credential');
    const date = q.get('X-Amz-Date');
    const exp = q.get('X-Amz-Expires');
    const sh = q.get('X-Amz-SignedHeaders');
    signature = q.get('X-Amz-Signature')!;
    if (!cred || !date || !exp || !sh) throw new SigV4Error('AuthorizationQueryParametersError', 400, 'X-Amz-Credential, X-Amz-Date, X-Amz-Expires and X-Amz-SignedHeaders are all required');
    if (!/^\d+$/.test(exp) || +exp < 1 || +exp > 604_800) throw new SigV4Error('AuthorizationQueryParametersError', 400, 'X-Amz-Expires must be between 1 and 604800 seconds');
    id = { ...parseCredential(cred), signed: sh.split(';'), signature };
    amzDate = date;
    signed = sh.split(';');
    sessionToken = q.get('X-Amz-Security-Token') ?? undefined;
    const at = parseAmzDate(date).getTime();
    if (o.now.getTime() < at - skew) throw new SigV4Error('RequestTimeTooSkewed', 403, 'the request is dated in the future');
    if (o.now.getTime() > at + +exp * 1000) throw new SigV4Error('AccessDenied', 403, 'the presigned request has expired');
  } else {
    if (!auth) throw new SigV4Error('AccessDenied', 403, 'the request is not signed');
    id = parseAuthorization(auth);
    signed = id.signed;
    signature = id.signature;
    sessionToken = h.get('x-amz-security-token');
    const d = h.get('x-amz-date') ?? (h.has('date') ? amzDateOf(new Date(h.get('date')!)) : undefined);
    if (!d || d.includes('NaN')) throw new SigV4Error('AccessDenied', 403, 'the request has no date');
    if (h.has('x-amz-date') ? !signed.includes('x-amz-date') : !signed.includes('date')) throw new SigV4Error('AccessDenied', 403, 'the date header must be signed');
    amzDate = d;
    const at = parseAmzDate(amzDate).getTime();
    if (Math.abs(o.now.getTime() - at) > skew) throw new SigV4Error('RequestTimeTooSkewed', 403, `the request time is more than ${skew / 1000} seconds from the server's`);
  }
  if (id.day !== amzDate.slice(0, 8)) throw new SigV4Error('AuthorizationHeaderMalformed', 400, 'the credential date does not match the request date');
  if (!signed.map((s) => s.toLowerCase()).includes('host')) throw new SigV4Error('AccessDenied', 403, 'host must be a signed header');
  if (o.scopes && !o.scopes.some((s) => s.region === id.scope.region && s.service === id.scope.service)) throw new SigV4Error('AuthorizationHeaderMalformed', 400, `the credential scope ${id.scope.region}/${id.scope.service} is not served here`);
  const secret = o.secretFor(id.accessKeyId);
  if (secret === undefined) throw new SigV4Error('InvalidAccessKeyId', 403, 'the access key is not known');
  let payloadHash: string;
  if (presigned) payloadHash = id.scope.service === 's3' ? (h.get('x-amz-content-sha256') ?? UNSIGNED_PAYLOAD) : EMPTY_SHA256;
  else {
    const declared = h.get('x-amz-content-sha256');
    if (declared === undefined && id.scope.service === 's3') throw new SigV4Error('InvalidRequest', 400, 'x-amz-content-sha256 is required');
    payloadHash = declared ?? sha256hex(o.body ?? '');
  }
  if (!presigned && /^[0-9a-f]{64}$/.test(payloadHash) && o.body !== undefined && sha256hex(o.body) !== payloadHash) throw new SigV4Error('XAmzContentSHA256Mismatch', 400, 'the body does not match x-amz-content-sha256');
  if (!presigned && !/^[0-9a-f]{64}$/.test(payloadHash) && payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== STREAMING_PAYLOAD) throw new SigV4Error('InvalidArgument', 400, 'x-amz-content-sha256 must be a SHA-256 hex digest, UNSIGNED-PAYLOAD or the streaming marker');
  const cr = canonicalRequest(req, signed, payloadHash, id.scope.service, presigned ? ['X-Amz-Signature'] : []);
  const expected = hmacHex(signingKey(secret, id.day, id.scope), stringToSign(amzDate, id.scope, cr));
  if (!safeEqualHex(expected, signature.toLowerCase())) throw new SigV4Error('SignatureDoesNotMatch', 403, 'the signature does not match');
  return { accessKeyId: id.accessKeyId, region: id.scope.region, service: id.scope.service, signedHeaders: signed, signature: expected, payloadHash, presigned, streaming: payloadHash === STREAMING_PAYLOAD, amzDate, ...(sessionToken ? { sessionToken } : {}) };
}

/** The chain of chunk signatures for a streamed upload. Each chunk's signature covers the one before it. */
export class ChunkSigner {
  private prev: string;
  private readonly key: Buffer;
  private readonly amzDate: string;
  private readonly scope: Scope;

  constructor(seedSignature: string, secret: string, amzDate: string, scope: Scope) {
    this.prev = seedSignature;
    this.key = signingKey(secret, amzDate.slice(0, 8), scope);
    this.amzDate = amzDate;
    this.scope = scope;
  }

  /** The signature for the next chunk (an empty chunk ends the stream). */
  next(chunk: Uint8Array): string {
    const sts = ['AWS4-HMAC-SHA256-PAYLOAD', this.amzDate, scopeString(this.amzDate.slice(0, 8), this.scope), this.prev, EMPTY_SHA256, sha256hex(chunk)].join('\n');
    this.prev = hmacHex(this.key, sts);
    return this.prev;
  }
}

/** Frames a payload as signed chunks of `chunkSize` bytes, ending with the empty chunk. */
export function encodeChunked(payload: Uint8Array, seedSignature: string, secret: string, amzDate: string, scope: Scope, chunkSize = 65_536): Buffer {
  const signer = new ChunkSigner(seedSignature, secret, amzDate, scope);
  const out: Buffer[] = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    const c = payload.subarray(i, i + chunkSize);
    out.push(Buffer.from(`${c.length.toString(16)};chunk-signature=${signer.next(c)}\r\n`), Buffer.from(c), Buffer.from('\r\n'));
  }
  out.push(Buffer.from(`0;chunk-signature=${signer.next(new Uint8Array(0))}\r\n\r\n`));
  return Buffer.concat(out);
}

/** Reads a signed chunk stream, refusing the first chunk whose signature, framing or order is wrong. */
export function decodeChunked(body: Uint8Array, seedSignature: string, secret: string, amzDate: string, scope: Scope, o: { maxChunk?: number; decodedLength?: number } = {}): Buffer {
  const signer = new ChunkSigner(seedSignature, secret, amzDate, scope);
  const b = Buffer.from(body);
  const maxChunk = o.maxChunk ?? 16 * 1024 * 1024;
  const out: Buffer[] = [];
  let pos = 0;
  let total = 0;
  for (;;) {
    const eol = b.indexOf('\r\n', pos, 'latin1');
    if (eol < 0 || eol - pos > 200) throw new SigV4Error('IncompleteBody', 400, 'a chunk header is missing or too long');
    const m = /^([0-9a-f]{1,8});chunk-signature=([0-9a-f]{64})$/.exec(b.toString('latin1', pos, eol));
    if (!m) throw new SigV4Error('InvalidRequest', 400, 'a chunk header is malformed');
    const size = parseInt(m[1]!, 16);
    if (size > maxChunk) throw new SigV4Error('EntityTooLarge', 400, 'a chunk is too large');
    const start = eol + 2;
    if (start + size + 2 > b.length) throw new SigV4Error('IncompleteBody', 400, 'the body ends inside a chunk');
    const data = b.subarray(start, start + size);
    if (b[start + size] !== 13 || b[start + size + 1] !== 10) throw new SigV4Error('InvalidRequest', 400, 'a chunk is not followed by CRLF');
    if (!safeEqualHex(signer.next(data), m[2]!)) throw new SigV4Error('SignatureDoesNotMatch', 403, 'a chunk signature does not match');
    pos = start + size + 2;
    if (size === 0) break;
    out.push(data);
    total += size;
  }
  if (pos !== b.length) throw new SigV4Error('InvalidRequest', 400, 'there is data after the final chunk');
  if (o.decodedLength !== undefined && o.decodedLength !== total) throw new SigV4Error('IncompleteBody', 400, 'the body is not the declared x-amz-decoded-content-length');
  return Buffer.concat(out);
}

/** Size of the framed body for a payload (for the Content-Length header of a chunked upload). */
export const chunkedLength = (payloadLength: number, chunkSize = 65_536): number => {
  const hdr = (n: number) => n.toString(16).length + ';chunk-signature='.length + 64 + 2;
  let total = 0;
  let left = payloadLength;
  while (left > 0) {
    const n = Math.min(left, chunkSize);
    total += hdr(n) + n + 2;
    left -= n;
  }
  return total + hdr(0) + 2;
};
