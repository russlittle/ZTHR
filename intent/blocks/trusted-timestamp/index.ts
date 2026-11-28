/**
 * Proof that a document existed at a time, from a time-stamping authority, following RFC 3161. A request (TSQ)
 * carries only the hash of the document, never the document; the response (TSR) holds a signed CMS token (RFC
 * 5652) whose content says "this hash was seen at this moment". This block writes requests, reads responses with
 * a strict DER reader (definite lengths, minimal encodings, nothing left over, depth and size limits), and
 * verifies a token completely: the status, that the hash and nonce are the ones asked about, the signed
 * attributes and message digest, the signature (RSA PKCS#1 v1.5 or ECDSA over SHA-256/384/512; SHA-1 is refused),
 * the signing certificate (named by the token, checked against the signing-certificate attribute, valid at the
 * time stamped, marked for time stamping only and critical), and a chain of certificates to a trusted root that
 * the caller supplies. It can also issue tokens for an in-house authority, with a small certificate maker.
 * For many documents it builds a Merkle tree (RFC 6962 hashing) so one timestamp covers a whole batch and each
 * document keeps a short inclusion proof, plans when batches are due, and anchors the head of the audit block's
 * hash chain so a log can show it existed unchanged at a time.
 * Out of scope: certificate revocation checking (CRL and OCSP), long-term archive renewal (RFC 4998), and the
 * HTTP transport to a TSA, which is an injected function.
 */
import { X509Certificate, createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Audit } from '../audit/index.ts';

export class TimestampError extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ---------------------------------------------------------------- DER

export interface Node {
  readonly tag: number;
  /** The identifier octet: class, constructed bit and tag number (low tag numbers only). */
  readonly constructed: boolean;
  readonly cls: number;
  readonly value: Buffer;
  readonly children: readonly Node[];
  /** The element exactly as encoded, header included. */
  readonly raw: Buffer;
}

const MAX_DER = 4_000_000;
const MAX_DEPTH = 24;

export function parseDer(buf: Uint8Array, depth = 0): Node {
  const b = Buffer.from(buf);
  if (b.length > MAX_DER) throw new TimestampError('the DER data is larger than 4 MB');
  const { node, end } = readNode(b, 0, depth);
  if (end !== b.length) throw new TimestampError('there are bytes after the end of the DER element');
  return node;
}

function readNode(b: Buffer, at: number, depth: number): { node: Node; end: number } {
  if (depth > MAX_DEPTH) throw new TimestampError('DER nested too deeply');
  if (at + 2 > b.length) throw new TimestampError('DER ends inside an element');
  const id = b[at]!;
  if ((id & 0x1f) === 0x1f) throw new TimestampError('DER tags above 30 are not used here');
  let len = b[at + 1]!;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new TimestampError('DER does not allow indefinite lengths');
    if (n > 4 || p + n > b.length) throw new TimestampError('a DER length is out of range');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i]!;
    if (len < 128 || b[p] === 0) throw new TimestampError('a DER length is not in its shortest form');
    p += n;
  }
  if (p + len > b.length) throw new TimestampError('an element is longer than the data');
  const value = b.subarray(p, p + len);
  const constructed = (id & 0x20) !== 0;
  const children: Node[] = [];
  if (constructed) {
    let q = 0;
    while (q < value.length) {
      const r = readNode(value, q, depth + 1);
      children.push(r.node);
      q = r.end;
    }
  }
  return { node: { tag: id & 0x1f, cls: id >> 6, constructed, value, children, raw: b.subarray(at, p + len) }, end: p + len };
}

const lenBytes = (n: number) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x82, n >> 8, n & 255]) : Buffer.from([0x83, n >> 16, (n >> 8) & 255, n & 255]));
const tlv = (id: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([id]), lenBytes(body.length), body]);
};

export const der = {
  seq: (...p: Buffer[]) => tlv(0x30, ...p),
  set: (...p: Buffer[]) => tlv(0x31, ...p),
  octets: (b: Uint8Array) => tlv(0x04, Buffer.from(b)),
  null: () => Buffer.from([0x05, 0x00]),
  bool: (v: boolean) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]),
  int: (v: bigint | number | Buffer): Buffer => {
    let b: Buffer;
    if (Buffer.isBuffer(v)) b = v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v;
    else {
      const n = BigInt(v);
      if (n < 0n) throw new TimestampError('negative integers are not used here');
      const hex = n.toString(16);
      b = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
      if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    }
    return tlv(0x02, b);
  },
  oid: (s: string): Buffer => {
    const a = s.split('.').map(Number);
    if (a.length < 2 || a.some((x) => !Number.isInteger(x) || x < 0)) throw new TimestampError(`${s} is not an object identifier`);
    const out = [a[0]! * 40 + a[1]!];
    for (const x of a.slice(2)) {
      const parts = [x & 0x7f];
      for (let v = Math.floor(x / 128); v > 0; v = Math.floor(v / 128)) parts.unshift((v & 0x7f) | 0x80);
      out.push(...parts);
    }
    return tlv(0x06, Buffer.from(out));
  },
  utf8: (s: string) => tlv(0x0c, Buffer.from(s, 'utf8')),
  printable: (s: string) => tlv(0x13, Buffer.from(s, 'latin1')),
  genTime: (d: Date) => tlv(0x18, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '')}Z`, 'latin1')),
  utcTime: (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2).replace(/\.\d{3}Z$/, '')}Z`, 'latin1')),
  bits: (b: Uint8Array, unused = 0) => tlv(0x03, Buffer.from([unused]), Buffer.from(b)),
  ctx: (n: number, ...p: Buffer[]) => tlv(0xa0 | n, ...p),
  implicit: (n: number, b: Uint8Array) => tlv(0x80 | n, Buffer.from(b)),
};

export function readOid(n: Node): string {
  if (n.tag !== 6 || n.cls !== 0 || !n.value.length) throw new TimestampError('expected an object identifier');
  const v = n.value;
  const out: number[] = [Math.floor(v[0]! / 40), v[0]! % 40];
  let acc = 0;
  for (const x of v.subarray(1)) {
    acc = acc * 128 + (x & 0x7f);
    if (!(x & 0x80)) {
      out.push(acc);
      acc = 0;
    }
  }
  return out.join('.');
}

const readInt = (n: Node): bigint => {
  if (n.tag !== 2 || n.cls !== 0 || !n.value.length) throw new TimestampError('expected an integer');
  if (n.value[0]! & 0x80) throw new TimestampError('negative integers are not used here');
  return BigInt(`0x${n.value.toString('hex')}`);
};

function readGenTime(n: Node): Date {
  const s = n.value.toString('latin1');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?Z$/.exec(s);
  if (n.tag !== 24 || !m) throw new TimestampError('the time is not a GeneralizedTime in UTC');
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== +m[2]! - 1) throw new TimestampError('the time is not a real date');
  return d;
}

// ---------------------------------------------------------------- identifiers

export type HashName = 'sha256' | 'sha384' | 'sha512';
const HASH_OID: Readonly<Record<HashName, string>> = { sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3' };
const HASH_BY_OID = new Map(Object.entries(HASH_OID).map(([k, v]) => [v, k as HashName] as const));
const HASH_LEN: Readonly<Record<HashName, number>> = { sha256: 32, sha384: 48, sha512: 64 };
const OID = { signedData: '1.2.840.113549.1.7.2', tstInfo: '1.2.840.113549.1.9.16.1.4', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingCertV2: '1.2.840.113549.1.9.16.2.47', rsaSha256: '1.2.840.113549.1.1.11', rsaSha384: '1.2.840.113549.1.1.12', rsaSha512: '1.2.840.113549.1.1.13', rsa: '1.2.840.113549.1.1.1', ecdsaSha256: '1.2.840.10045.4.3.2', ecdsaSha384: '1.2.840.10045.4.3.3', ecdsaSha512: '1.2.840.10045.4.3.4', timeStamping: '1.3.6.1.5.5.7.3.8', eku: '2.5.29.37', cn: '2.5.4.3', basic: '2.5.29.19', keyUsage: '2.5.29.15' } as const;

const algId = (oid: string, params = false) => der.seq(der.oid(oid), ...(params ? [der.null()] : []));

export const sha = (alg: HashName, data: Uint8Array) => createHash(alg).update(data).digest();

// ---------------------------------------------------------------- request

export interface Request {
  readonly hashAlgorithm: HashName;
  /** The hash of the document. */
  readonly imprint: Buffer;
  readonly nonce?: bigint;
  readonly policy?: string;
  readonly certReq: boolean;
}

/** Writes a TimeStampReq (RFC 3161 section 2.4.1) for a document hash. The nonce is passed in. */
export function makeRequest(r: { hashAlgorithm?: HashName; imprint: Uint8Array; nonce?: bigint; policy?: string; certReq?: boolean }): Buffer {
  const alg = r.hashAlgorithm ?? 'sha256';
  if (r.imprint.length !== HASH_LEN[alg]) throw new TimestampError(`a ${alg} hash is ${HASH_LEN[alg]} bytes`);
  if (r.nonce !== undefined && (r.nonce < 0n || r.nonce >= 1n << 64n)) throw new TimestampError('a nonce is a number up to 64 bits');
  return der.seq(der.int(1), der.seq(algId(HASH_OID[alg], true), der.octets(r.imprint)), ...(r.policy ? [der.oid(r.policy)] : []), ...(r.nonce !== undefined ? [der.int(r.nonce)] : []), ...((r.certReq ?? true) ? [der.bool(true)] : []));
}

export function parseRequest(b: Uint8Array): Request {
  const n = parseDer(b);
  if (n.tag !== 16 || n.children.length < 2) throw new TimestampError('a timestamp request is a sequence');
  if (readInt(n.children[0]!) !== 1n) throw new TimestampError('only version 1 requests exist');
  const imp = n.children[1]!;
  const alg = HASH_BY_OID.get(readOid(imp.children[0]?.children[0] ?? imp));
  if (!alg) throw new TimestampError('the hash algorithm is not SHA-256, SHA-384 or SHA-512');
  const h = imp.children[1];
  if (!h || h.tag !== 4 || h.value.length !== HASH_LEN[alg]) throw new TimestampError(`the hash is not ${HASH_LEN[alg]} bytes`);
  let nonce: bigint | undefined;
  let policy: string | undefined;
  let certReq = false;
  for (const c of n.children.slice(2)) {
    if (c.tag === 6) policy = readOid(c);
    else if (c.tag === 2) nonce = readInt(c);
    else if (c.tag === 1) certReq = c.value[0] !== 0;
  }
  return { hashAlgorithm: alg, imprint: Buffer.from(h.value), ...(nonce !== undefined ? { nonce } : {}), ...(policy ? { policy } : {}), certReq };
}

const trimInt = (b: Buffer): Buffer => (b[0] === 0 && b.length > 1 ? b.subarray(1) : b);

// ---------------------------------------------------------------- certificates (for in-house authorities)

export interface Identity {
  readonly commonName: string;
}

const name = (cn: string) => der.seq(der.set(der.seq(der.oid(OID.cn), der.utf8(cn))));

function sigAlgFor(key: KeyObject): { oid: string; params: boolean; hash: HashName | null; kind: 'rsa' | 'ec' } {
  if (key.asymmetricKeyType === 'rsa') return { oid: OID.rsaSha256, params: true, hash: 'sha256', kind: 'rsa' };
  if (key.asymmetricKeyType === 'ec') return { oid: OID.ecdsaSha256, params: false, hash: 'sha256', kind: 'ec' };
  throw new TimestampError('only RSA and ECDSA (P-256) keys are used for time stamping here');
}

const signWith = (key: KeyObject, data: Buffer): Buffer => nodeSign('sha256', data, key);

export interface CertSpec {
  readonly subject: Identity;
  readonly issuer?: Identity;
  readonly publicKey: KeyObject;
  readonly signingKey: KeyObject | string;
  readonly serial: bigint;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** A certificate authority (can sign other certificates) or a time-stamping authority. */
  readonly kind: 'ca' | 'tsa';
}

/** A minimal X.509 v3 certificate. Time-stamping ones carry the critical timeStamping-only extended key usage. */
export function createCertificate(c: CertSpec): Buffer {
  const signing = typeof c.signingKey === 'string' ? createPrivateKey(c.signingKey) : c.signingKey;
  const alg = sigAlgFor(signing);
  const spki = (c.publicKey.type === 'private' ? createPublicKey(c.publicKey) : c.publicKey).export({ type: 'spki', format: 'der' });
  const ext = (oid: string, critical: boolean, value: Buffer) => der.seq(der.oid(oid), ...(critical ? [der.bool(true)] : []), der.octets(value));
  const exts = c.kind === 'ca' ? [ext(OID.basic, true, der.seq(der.bool(true))), ext(OID.keyUsage, true, der.bits(Buffer.from([0x06]), 1))] : [ext(OID.eku, true, der.seq(der.oid(OID.timeStamping))), ext(OID.keyUsage, true, der.bits(Buffer.from([0x80]), 7))];
  const tbs = der.seq(der.ctx(0, der.int(2)), der.int(c.serial), algId(alg.oid, alg.params), name((c.issuer ?? c.subject).commonName), der.seq(der.utcTime(c.notBefore), der.utcTime(c.notAfter)), name(c.subject.commonName), Buffer.from(spki), der.ctx(3, der.seq(...exts)));
  const sig = signWith(signing, tbs);
  return der.seq(tbs, algId(alg.oid, alg.params), der.bits(sig));
}

// ---------------------------------------------------------------- issuing (an in-house authority)

export interface Authority {
  readonly certificate: Buffer;
  readonly chain?: readonly Buffer[];
  readonly privateKey: KeyObject | string;
  readonly policy: string;
  readonly now: () => Date;
  /** Returns the next serial number; never repeated. */
  readonly nextSerial: () => bigint;
}

/** Answers a TimeStampReq with a TimeStampResp holding a signed token. */
export function issue(requestBytes: Uint8Array, a: Authority): Buffer {
  let req: Request;
  try {
    req = parseRequest(requestBytes);
  } catch {
    return der.seq(der.seq(der.int(2), der.bits(Buffer.from([0x02]), 1)));
  }
  const key = typeof a.privateKey === 'string' ? createPrivateKey(a.privateKey) : a.privateKey;
  const alg = sigAlgFor(key);
  const tst = der.seq(der.int(1), der.oid(a.policy), der.seq(algId(HASH_OID[req.hashAlgorithm], true), der.octets(req.imprint)), der.int(a.nextSerial()), der.genTime(a.now()), ...(req.nonce !== undefined ? [der.int(req.nonce)] : []));
  const certHash = sha('sha256', a.certificate);
  const issuerSerial = der.seq(der.seq(der.ctx(4, nameFromCert(a.certificate))), der.int(serialOf(a.certificate)));
  const attrs = [
    der.seq(der.oid(OID.contentType), der.set(der.oid(OID.tstInfo))),
    der.seq(der.oid(OID.messageDigest), der.set(der.octets(sha('sha256', tst)))),
    der.seq(der.oid(OID.signingCertV2), der.set(der.seq(der.seq(der.seq(der.octets(certHash), issuerSerial))))),
  ];
  const setOfAttrs = der.set(...attrs.sort(Buffer.compare));
  const signature = signWith(key, setOfAttrs);
  const signerInfo = der.seq(der.int(1), der.seq(nameFromCert(a.certificate), der.int(serialOf(a.certificate))), algId(HASH_OID.sha256, false), Buffer.concat([Buffer.from([0xa0]), setOfAttrs.subarray(1)]), algId(alg.oid, alg.params), der.octets(signature));
  const certs = [a.certificate, ...(a.chain ?? [])];
  const signedData = der.seq(der.int(3), der.set(algId(HASH_OID.sha256, false)), der.seq(der.oid(OID.tstInfo), der.ctx(0, der.octets(tst))), tlv(0xa0, ...certs), der.set(signerInfo));
  const token = der.seq(der.oid(OID.signedData), der.ctx(0, signedData));
  return der.seq(der.seq(der.int(0)), token);
}

function tbsOf(certDer: Buffer): Node[] {
  const c = parseDer(certDer);
  const tbs = c.children[0];
  if (!tbs) throw new TimestampError('not a certificate');
  const i = tbs.children[0]!.cls === 2 ? 1 : 0;
  return tbs.children.slice(i);
}
const serialOf = (certDer: Buffer): Buffer => trimInt(tbsOf(certDer)[0]!.value);
const nameFromCert = (certDer: Buffer): Buffer => tbsOf(certDer)[2]!.raw;

// ---------------------------------------------------------------- verifying

export interface Verified {
  readonly genTime: Date;
  readonly serial: string;
  readonly policy: string;
  readonly hashAlgorithm: HashName;
  readonly imprint: string;
  readonly tsa: string;
  readonly nonceChecked: boolean;
  readonly status: 'granted' | 'grantedWithMods';
}

const FAIL_BITS = ['badAlg', 'unknown(1)', 'unknown(2)', 'badRequest', 'unknown(4)', 'unknown(5)', 'badDataFormat', 'unknown(7)', 'unknown(8)', 'timeNotAvailable', 'unacceptedPolicy', 'unacceptedExtension', 'addInfoNotAvailable', 'unknown(13)', 'unknown(14)', 'systemFailure'];

export interface VerifyOptions {
  /** The request that was sent: its hash, nonce and policy must come back. */
  readonly request: Request | Uint8Array;
  /** Certificates the caller trusts as roots (DER or PEM). */
  readonly trustedRoots: readonly (Uint8Array | string)[];
  /** The time now, to refuse a token from the future; default tokens up to five minutes ahead are accepted. */
  readonly now: Date;
  readonly maxFutureMs?: number;
}

/** Fully verifies a TimeStampResp against the request and the trusted roots. Throws a TimestampError saying why not. */
export function verifyResponse(response: Uint8Array, o: VerifyOptions): Verified {
  const req = o.request instanceof Uint8Array ? parseRequest(o.request) : o.request;
  const resp = parseDer(response);
  if (resp.tag !== 16 || !resp.children[0]) throw new TimestampError('a timestamp response is a sequence');
  const st = resp.children[0];
  const status = Number(readInt(st.children[0] ?? st));
  if (status !== 0 && status !== 1) {
    const fi = st.children.find((c) => c.tag === 3);
    const bits: string[] = [];
    if (fi && fi.value.length > 1) fi.value.subarray(1).forEach((byte, i) => { for (let k = 0; k < 8; k++) if (byte & (0x80 >> k)) bits.push(FAIL_BITS[i * 8 + k] ?? 'unknown'); });
    throw new TimestampError(`the authority refused (status ${['granted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification'][status] ?? status}${bits.length ? `: ${bits.join(', ')}` : ''})`);
  }
  const token = resp.children[1];
  if (!token) throw new TimestampError('the response is granted but has no token');
  const v = verifyToken(token, req, o);
  return { ...v, status: status === 0 ? 'granted' : 'grantedWithMods' };
}

function verifyToken(ci: Node, req: Request, o: VerifyOptions): Omit<Verified, 'status'> {
  if (ci.tag !== 16 || readOid(ci.children[0]!) !== OID.signedData) throw new TimestampError('the token is not CMS signed data');
  const sd = ci.children[1]?.children[0];
  if (!sd || sd.tag !== 16) throw new TimestampError('the token has no signed data');
  const parts = sd.children;
  let i = 0;
  if (readInt(parts[i++]!) < 1n) throw new TimestampError('the signed data version is not valid');
  i++; // digest algorithms
  const eci = parts[i++]!;
  if (readOid(eci.children[0]!) !== OID.tstInfo) throw new TimestampError('the token does not carry timestamp information');
  const tstBytes = eci.children[1]?.children[0]?.value;
  if (!tstBytes) throw new TimestampError('the token has no timestamp information');
  const certsNode = parts[i]?.cls === 2 && parts[i]!.tag === 0 ? parts[i++]! : undefined;
  const signers = parts[i];
  if (!signers || signers.tag !== 17 || signers.children.length !== 1) throw new TimestampError('a timestamp token has exactly one signer');
  const certs = (certsNode?.children ?? []).map((c) => c.raw);

  // The timestamp information
  const tst = parseDer(tstBytes);
  const t = tst.children;
  if (readInt(t[0]!) !== 1n) throw new TimestampError('the timestamp information version is not 1');
  const policy = readOid(t[1]!);
  const mi = t[2]!;
  const alg = HASH_BY_OID.get(readOid(mi.children[0]!.children[0]!));
  if (!alg) throw new TimestampError('the timestamped hash algorithm is not supported');
  if (alg !== req.hashAlgorithm || !mi.children[1]!.value.equals(req.imprint)) throw new TimestampError('the token is for a different document hash than the one sent');
  const serial = readInt(t[3]!);
  const genTime = readGenTime(t[4]!);
  let nonce: bigint | undefined;
  for (const x of t.slice(5)) if (x.tag === 2 && x.cls === 0) nonce = readInt(x);
  if (req.nonce !== undefined && nonce !== req.nonce) throw new TimestampError('the nonce does not match the request: this may be a replayed response');
  if (req.policy && req.policy !== policy) throw new TimestampError('the policy is not the one requested');
  if (genTime.getTime() > o.now.getTime() + (o.maxFutureMs ?? 300_000)) throw new TimestampError('the token is dated in the future');

  // The signer
  const si = signers.children[0]!.children;
  let k = 0;
  if (readInt(si[k++]!) !== 1n) throw new TimestampError('the signer version is not 1');
  const sid = si[k++]!;
  if (sid.tag !== 16) throw new TimestampError('the signer is not named by issuer and serial number');
  const digestAlg = HASH_BY_OID.get(readOid(si[k++]!.children[0]!));
  if (!digestAlg) throw new TimestampError('the signer digest algorithm is not supported (SHA-1 is refused)');
  const attrsNode = si[k]!;
  if (attrsNode.cls !== 2 || attrsNode.tag !== 0) throw new TimestampError('the token has no signed attributes');
  k++;
  const sigAlgOid = readOid(si[k++]!.children[0]!);
  const signature = si[k++]!.value;
  const attrs = new Map<string, Node>();
  for (const a of attrsNode.children) attrs.set(readOid(a.children[0]!), a.children[1]!.children[0]!);
  if (readOid(attrs.get(OID.contentType) ?? (() => { throw new TimestampError('the signed attributes have no content type'); })()) !== OID.tstInfo) throw new TimestampError('the signed content type is not timestamp information');
  const md = attrs.get(OID.messageDigest);
  if (!md || !md.value.equals(sha(digestAlg, tstBytes))) throw new TimestampError('the message digest does not match the timestamp information: it was changed');
  const signerCert = certs.map((c) => new X509Certificate(c)).find((c) => {
    const dn = nameFromCert(c.raw);
    const ser = serialOf(c.raw);
    return dn.equals(sid.children[0]!.raw) && ser.equals(trimInt(sid.children[1]!.value));
  });
  if (!signerCert) throw new TimestampError('the signing certificate is not in the token');
  const ess = attrs.get(OID.signingCertV2);
  if (ess) {
    const certId = ess.children[0]?.children[0];
    const hashAlg = certId && certId.children[0]?.tag === 4 ? 'sha256' : HASH_BY_OID.get(readOid(certId!.children[0]!.children[0]!));
    const ch = certId?.children.find((c) => c.tag === 4);
    if (!hashAlg || !ch || !ch.value.equals(sha(hashAlg, signerCert.raw))) throw new TimestampError('the signing-certificate attribute names a different certificate');
  }
  const signedBytes = Buffer.concat([Buffer.from([0x31]), attrsNode.raw.subarray(1)]);
  const sigHash = sigAlgOid.endsWith('.13') || sigAlgOid === OID.ecdsaSha512 ? 'sha512' : sigAlgOid === OID.rsaSha384 || sigAlgOid === OID.ecdsaSha384 ? 'sha384' : sigAlgOid === OID.rsaSha256 || sigAlgOid === OID.ecdsaSha256 ? 'sha256' : sigAlgOid === OID.rsa ? digestAlg : undefined;
  if (!sigHash) throw new TimestampError('the signature algorithm is not supported');
  if (signerCert.publicKey.asymmetricKeyType === 'rsa' && (signerCert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new TimestampError('the signing key is an RSA key under 2048 bits');
  if (!nodeVerify(sigHash, signedBytes, signerCert.publicKey, signature)) throw new TimestampError('the signature is not valid: the token was changed or is forged');

  // The certificate
  checkSignerCert(signerCert, genTime);
  checkChain(signerCert, certs.map((c) => new X509Certificate(c)), o.trustedRoots.map((r) => new X509Certificate(r as string | Buffer)), genTime);
  return { genTime, serial: serial.toString(16), policy, hashAlgorithm: alg, imprint: req.imprint.toString('hex'), tsa: signerCert.subject.replace(/\n/g, ', '), nonceChecked: req.nonce !== undefined };
}


function checkSignerCert(c: X509Certificate, at: Date): void {
  if (at < new Date(c.validFrom) || at > new Date(c.validTo)) throw new TimestampError('the signing certificate was not valid at the time stamped');
  // The extended key usage must be present, critical and only timeStamping (RFC 3161 section 2.3).
  const exts = tbsOf(c.raw).find((n) => n.cls === 2 && n.tag === 3)?.children[0]?.children ?? [];
  const e = exts.find((x) => readOid(x.children[0]!) === OID.eku);
  if (!e) throw new TimestampError('the signing certificate is not marked for time stamping');
  const critical = e.children.length === 3 && e.children[1]!.tag === 1 && e.children[1]!.value[0] !== 0;
  const usages = parseDer(e.children[e.children.length - 1]!.value).children.map(readOid);
  if (usages.length !== 1 || usages[0] !== OID.timeStamping) throw new TimestampError('the signing certificate must be for time stamping only');
  if (!critical) throw new TimestampError('the time-stamping key usage must be marked critical');
}

function checkChain(leaf: X509Certificate, pool: X509Certificate[], roots: X509Certificate[], at: Date): void {
  let cur = leaf;
  for (let depth = 0; depth < 6; depth++) {
    const root = roots.find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) {
      if (at < new Date(root.validFrom) || at > new Date(root.validTo)) throw new TimestampError('a certificate in the chain was not valid at the time stamped');
      if (!root.ca && !root.raw.equals(leaf.raw)) throw new TimestampError('the trusted issuer is not a certificate authority');
      return;
    }
    if (at < new Date(cur.validFrom) || at > new Date(cur.validTo)) throw new TimestampError('a certificate in the chain was not valid at the time stamped');
    const up = pool.find((p) => p !== cur && !p.raw.equals(cur.raw) && cur.checkIssued(p) && cur.verify(p.publicKey));
    if (!up || !up.ca) throw new TimestampError('the signing certificate does not chain to a trusted root');
    cur = up;
  }
  throw new TimestampError('the certificate chain is too long');
}

// ---------------------------------------------------------------- Merkle batches (RFC 6962 hashing)

const leafHash = (data: Buffer) => createHash('sha256').update(Buffer.concat([Buffer.from([0]), data])).digest();
const nodeHash = (l: Buffer, r: Buffer) => createHash('sha256').update(Buffer.concat([Buffer.from([1]), l, r])).digest();

/** The largest power of two below n. */
const split = (n: number) => 1 << (31 - Math.clz32(n - 1));

export function merkleRoot(leaves: readonly Buffer[]): Buffer {
  if (!leaves.length) return createHash('sha256').update('').digest();
  if (leaves.length === 1) return leafHash(leaves[0]!);
  const k = split(leaves.length);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** The hashes a verifier needs, from the leaf up (RFC 6962 audit path). */
export function merkleProof(leaves: readonly Buffer[], index: number): Buffer[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new TimestampError('that leaf is not in the batch');
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k ? [...merkleProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))] : [...merkleProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

export function rootFromProof(leaf: Buffer, index: number, size: number, proof: readonly Buffer[]): Buffer {
  if (index < 0 || index >= size) throw new TimestampError('that leaf is not in the batch');
  let fn = index;
  let sn = size - 1;
  let r = leafHash(leaf);
  for (const p of proof) {
    if (sn === 0) throw new TimestampError('the proof is longer than the tree');
    if (fn & 1 || fn === sn) {
      r = nodeHash(p, r);
      if (!(fn & 1)) while (!(fn & 1) && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else r = nodeHash(r, p);
    fn >>= 1;
    sn >>= 1;
  }
  if (sn !== 0) throw new TimestampError('the proof is shorter than the tree');
  return r;
}

export interface Batch {
  readonly id: number;
  readonly leaves: readonly string[];
  readonly root: string;
  readonly sealedAt: number;
}

export interface DocumentProof {
  readonly batch: number;
  readonly index: number;
  readonly size: number;
  readonly path: readonly string[];
  readonly root: string;
}

/** Collects document hashes and says when to timestamp them: when enough have gathered, or the oldest has waited long enough. */
export class AnchorPlan {
  private pending: { hash: string; at: number }[] = [];
  private readonly batches = new Map<number, Batch>();
  private seq = 0;
  private readonly o: { maxLeaves: number; maxWaitMs: number; now: () => number };
  constructor(o: { maxLeaves: number; maxWaitMs: number; now: () => number }) {
    if (!(o.maxLeaves >= 1 && o.maxWaitMs >= 0)) throw new TimestampError('a batch holds at least one document');
    this.o = o;
  }

  add(hashHex: string): void {
    if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new TimestampError('a document hash is 64 lower-case hex characters');
    if (this.pending.some((p) => p.hash === hashHex)) return;
    this.pending.push({ hash: hashHex, at: this.o.now() });
  }

  get waiting(): number {
    return this.pending.length;
  }

  /** Whether a batch should be sealed and timestamped now, and why. */
  due(): { due: boolean; why: string } {
    if (!this.pending.length) return { due: false, why: 'nothing is waiting' };
    if (this.pending.length >= this.o.maxLeaves) return { due: true, why: `${this.pending.length} documents are waiting` };
    const age = this.o.now() - this.pending[0]!.at;
    if (age >= this.o.maxWaitMs) return { due: true, why: `the oldest has waited ${Math.round(age / 1000)} seconds` };
    return { due: false, why: `${this.pending.length} waiting, the oldest for ${Math.round(age / 1000)} seconds` };
  }

  /** Seals the waiting hashes (at most maxLeaves) into a batch whose root is what to timestamp. */
  seal(): Batch {
    if (!this.pending.length) throw new TimestampError('nothing is waiting');
    const take = this.pending.splice(0, this.o.maxLeaves);
    const leaves = take.map((t) => t.hash);
    const b: Batch = { id: ++this.seq, leaves, root: merkleRoot(leaves.map((l) => Buffer.from(l, 'hex'))).toString('hex'), sealedAt: this.o.now() };
    this.batches.set(b.id, b);
    return b;
  }

  proofFor(batchId: number, hashHex: string): DocumentProof {
    const b = this.batches.get(batchId);
    if (!b) throw new TimestampError(`no batch ${batchId}`);
    const index = b.leaves.indexOf(hashHex);
    if (index < 0) throw new TimestampError('that document is not in the batch');
    const leaves = b.leaves.map((l) => Buffer.from(l, 'hex'));
    return { batch: b.id, index, size: leaves.length, path: merkleProof(leaves, index).map((x) => x.toString('hex')), root: b.root };
  }
}

/** The document's hash is in the batch the proof names (the batch's root is what the timestamp covers). */
export function checkDocumentProof(hashHex: string, p: DocumentProof): boolean {
  try {
    return rootFromProof(Buffer.from(hashHex, 'hex'), p.index, p.size, p.path.map((x) => Buffer.from(x, 'hex'))).toString('hex') === p.root;
  } catch {
    return false;
  }
}

/**
 * A document timestamped through a batch: the proof ties the document to the root, and the token ties the root
 * to a time. Returns when the document is proven to have existed by.
 */
export function verifyDocumentTimestamp(hashHex: string, p: DocumentProof, response: Uint8Array, o: Omit<VerifyOptions, 'request'>): Verified {
  if (!checkDocumentProof(hashHex, p)) throw new TimestampError('the proof does not connect the document to the batch root');
  const req: Request = { hashAlgorithm: 'sha256', imprint: Buffer.from(p.root, 'hex'), certReq: true };
  return verifyResponse(response, { ...o, request: req });
}

// ---------------------------------------------------------------- anchoring an audit log

/**
 * Timestamps the head of the audit chain, verifies the answer, and writes the anchor into the log itself. The
 * `timestamp` function sends the request bytes to an authority and returns its response bytes.
 */
export async function anchorAuditHead(audit: Audit, timestamp: (request: Buffer) => Promise<Uint8Array>, o: { trustedRoots: readonly (Uint8Array | string)[]; now: () => Date; nonce: bigint; actor?: string }): Promise<{ head: { n: number; hash: string }; verified: Verified }> {
  const head = await audit.head();
  const imprint = Buffer.from(head.hash, 'hex');
  const request = makeRequest({ imprint, nonce: o.nonce, certReq: true });
  const response = await timestamp(request);
  const verified = verifyResponse(response, { request: parseRequest(request), trustedRoots: o.trustedRoots, now: o.now() });
  await audit.record({ actor: o.actor ?? 'system', action: 'timestamp.anchored', target: `audit:${head.n}`, detail: { n: head.n, hash: head.hash, genTime: verified.genTime.toISOString(), serial: verified.serial, tsa: verified.tsa, response: Buffer.from(response).toString('base64') } });
  return { head, verified };
}
