/**
 * ASN.1 DER (ITU-T X.690) read strictly and written canonically, with the structures TLS tooling needs on top:
 * X.509 certificates (RFC 5280: names, validity, public key, the basic-constraints, key-usage, extended-key-usage,
 * subject-alternative-name and key-identifier extensions), hostname matching (RFC 6125), certificate signature checks
 * through node:crypto, PEM armour (RFC 7468), and PKCS#10 certification requests (RFC 2986) built with a subject and
 * SAN list and signed by an RSA, ECDSA P-256/P-384 or Ed25519 key, or read and checked back.
 *
 * The reader refuses what DER forbids: indefinite lengths, lengths and tag numbers not in their shortest form,
 * constructed/primitive mismatches on universal types, non-canonical booleans and integers, bit-string padding
 * errors, trailing bytes, and anything nested beyond a depth limit. A node's `raw` bytes are kept, so a signature
 * is checked over exactly the bytes that were signed. Writing is a set of small builders (sequence, set, integer,
 * object identifier, strings, times, explicit and implicit context tags) that always produce DER; a parsed
 * certificate, written back, gives its original bytes. Out of scope: BER, PKCS#7/CMS, PKCS#12, certificate path
 * validation and revocation, RSASSA-PSS signatures, and SHA-1 signatures (refused unless asked for).
 */
import { createHash, createPublicKey, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

export class DerError extends Error {
  constructor(why: string) {
    super(`bad DER: ${why}`);
  }
}

export const Cls = { Universal: 0, Application: 1, Context: 2, Private: 3 } as const;

export interface Der {
  readonly cls: 0 | 1 | 2 | 3;
  readonly constructed: boolean;
  readonly tag: number;
  readonly content: Buffer;
  /** The whole encoding: tag, length and content. */
  readonly raw: Buffer;
  /** For constructed nodes, the nodes inside. */
  readonly children: readonly Der[];
}

export const UT = { boolean: 1, integer: 2, bitString: 3, octetString: 4, null: 5, oid: 6, utf8: 12, sequence: 16, set: 17, printable: 19, t61: 20, ia5: 22, utcTime: 23, genTime: 24, bmp: 30 } as const;

// ---------------------------------------------------------------- reading

export interface ReadOptions {
  readonly maxDepth?: number;
  /** Allow bytes after the first value (to read a stream of values). */
  readonly trailing?: boolean;
}

/** Reads one DER value, checking that it is canonical. */
export function parseDer(input: Uint8Array, o: ReadOptions = {}): Der {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const { node, end } = readNode(b, 0, b.length, 0, o.maxDepth ?? 32);
  if (!o.trailing && end !== b.length) throw new DerError(`${b.length - end} bytes after the value`);
  return node;
}

/** Reads every value in a buffer (the content of a constructed value, say). */
export function parseAll(b: Buffer, o: ReadOptions = {}): Der[] {
  const out: Der[] = [];
  for (let at = 0; at < b.length; ) {
    const r = readNode(b, at, b.length, 0, o.maxDepth ?? 32);
    out.push(r.node);
    at = r.end;
  }
  return out;
}

function readNode(b: Buffer, at: number, limit: number, depth: number, maxDepth: number): { node: Der; end: number } {
  if (depth > maxDepth) throw new DerError('nested too deeply');
  if (at >= limit) throw new DerError('ran out of bytes');
  const first = b[at]!;
  const cls = (first >> 6) as 0 | 1 | 2 | 3;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  let p = at + 1;
  if (tag === 0x1f) {
    tag = 0;
    let n = 0;
    for (;;) {
      if (p >= limit) throw new DerError('ran out of bytes in a tag');
      const x = b[p++]!;
      if (n === 0 && x === 0x80) throw new DerError('a tag number not in its shortest form');
      tag = tag * 128 + (x & 0x7f);
      n++;
      if (n > 4 || tag > 0x7fffffff) throw new DerError('a tag number that is too large');
      if (!(x & 0x80)) break;
    }
    if (tag < 31) throw new DerError('a long-form tag for a small number');
  }
  if (p >= limit) throw new DerError('ran out of bytes before the length');
  const l0 = b[p++]!;
  let len: number;
  if (l0 < 0x80) len = l0;
  else if (l0 === 0x80) throw new DerError('an indefinite length (BER, not DER)');
  else {
    const n = l0 & 0x7f;
    if (n > 4) throw new DerError('a length of more than 4 bytes');
    if (p + n > limit) throw new DerError('ran out of bytes in a length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++]!;
    if (len < 0x80 || b[p - n]! === 0) throw new DerError('a length not in its shortest form');
  }
  if (p + len > limit) throw new DerError('a length longer than the data');
  const content = b.subarray(p, p + len);
  const end = p + len;
  const raw = b.subarray(at, end);
  if (cls === 0) checkUniversal(tag, constructed, content);
  let children: Der[] = [];
  if (constructed) {
    let q = p;
    while (q < end) {
      const r = readNode(b, q, end, depth + 1, maxDepth);
      children.push(r.node);
      q = r.end;
    }
  } else children = [];
  return { node: { cls, constructed, tag, content, raw, children }, end };
}

function checkUniversal(tag: number, constructed: boolean, c: Buffer): void {
  const primitiveOnly = [UT.boolean, UT.integer, UT.null, UT.oid, UT.utcTime, UT.genTime, UT.utf8, UT.printable, UT.ia5, UT.t61, UT.bmp];
  if (primitiveOnly.includes(tag as never) && constructed) throw new DerError(`type ${tag} must be primitive`);
  if ((tag === UT.sequence || tag === UT.set) && !constructed) throw new DerError('a sequence or set must be constructed');
  switch (tag) {
    case UT.boolean:
      if (c.length !== 1 || (c[0] !== 0 && c[0] !== 0xff)) throw new DerError('a boolean must be one byte, 00 or FF');
      break;
    case UT.integer:
      if (c.length === 0) throw new DerError('an empty integer');
      if (c.length > 1 && ((c[0] === 0 && !(c[1]! & 0x80)) || (c[0] === 0xff && !!(c[1]! & 0x80)))) throw new DerError('an integer with a redundant leading byte');
      break;
    case UT.null:
      if (c.length) throw new DerError('a null with content');
      break;
    case UT.bitString:
      if (c.length === 0) throw new DerError('an empty bit string');
      if (c[0]! > 7 || (c.length === 1 && c[0] !== 0)) throw new DerError('bad bit string padding');
      if (c.length > 1 && c[0]! > 0 && (c[c.length - 1]! & ((1 << c[0]!) - 1)) !== 0) throw new DerError('bit string padding bits are not zero');
      break;
    case UT.oid: {
      if (c.length === 0 || c[c.length - 1]! & 0x80) throw new DerError('a bad object identifier');
      let startOfArc = true;
      for (const x of c) {
        if (startOfArc && x === 0x80) throw new DerError('an object identifier arc not in its shortest form');
        startOfArc = !(x & 0x80);
      }
      break;
    }
  }
}

const isU = (n: Der, tag: number) => n.cls === 0 && n.tag === tag;
const expect = (n: Der, tag: number, what: string): Der => {
  if (!isU(n, tag)) throw new DerError(`expected ${what}`);
  return n;
};

export const asInteger = (n: Der): bigint => {
  expect(n, UT.integer, 'an INTEGER');
  let v = 0n;
  for (const x of n.content) v = (v << 8n) | BigInt(x);
  return n.content[0]! & 0x80 ? v - (1n << BigInt(8 * n.content.length)) : v;
};
export const asBoolean = (n: Der): boolean => expect(n, UT.boolean, 'a BOOLEAN').content[0] === 0xff;
export const asOctets = (n: Der): Buffer => expect(n, UT.octetString, 'an OCTET STRING').content;
/** Bit string content without the padding byte, and the number of unused bits. */
export const asBits = (n: Der): { bytes: Buffer; unused: number } => ({ bytes: expect(n, UT.bitString, 'a BIT STRING').content.subarray(1), unused: n.content[0]! });

export function asOid(n: Der): string {
  expect(n, UT.oid, 'an OBJECT IDENTIFIER');
  const arcs: bigint[] = [];
  let v = 0n;
  for (const x of n.content) {
    v = (v << 7n) | BigInt(x & 0x7f);
    if (!(x & 0x80)) {
      arcs.push(v);
      v = 0n;
    }
  }
  const f = arcs[0]!;
  const first = f < 40n ? [0n, f] : f < 80n ? [1n, f - 40n] : [2n, f - 80n];
  return [...first, ...arcs.slice(1)].join('.');
}

export function asString(n: Der): string {
  if (n.cls !== 0) throw new DerError('expected a string');
  switch (n.tag) {
    case UT.utf8:
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(n.content);
      } catch {
        throw new DerError('a UTF8String that is not UTF-8');
      }
    case UT.printable:
      if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(n.content.toString('latin1'))) throw new DerError('a PrintableString with characters outside its set');
      return n.content.toString('latin1');
    case UT.ia5:
      if (n.content.some((x) => x > 127)) throw new DerError('an IA5String with non-ASCII bytes');
      return n.content.toString('latin1');
    case UT.t61:
      return n.content.toString('latin1');
    case UT.bmp:
      if (n.content.length % 2) throw new DerError('a BMPString of odd length');
      return new TextDecoder('utf-16be').decode(n.content);
    default:
      throw new DerError('expected a string');
  }
}

export function asTime(n: Der): Date {
  const s = n.content.toString('latin1');
  let m: RegExpExecArray | null;
  let y: number;
  if (isU(n, UT.utcTime)) {
    m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s);
    if (!m) throw new DerError('a UTCTime must be YYMMDDHHMMSSZ');
    y = Number(m[1]) >= 50 ? 1900 + Number(m[1]) : 2000 + Number(m[1]);
  } else if (isU(n, UT.genTime)) {
    m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s);
    if (!m) throw new DerError('a GeneralizedTime must be YYYYMMDDHHMMSSZ');
    y = Number(m[1]);
  } else throw new DerError('expected a time');
  const [mo, d, h, mi, se] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) throw new DerError('a time that is not a real date');
  return date;
}

// ---------------------------------------------------------------- writing

const lenBytes = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return Buffer.from([0x80 | out.length, ...out]);
};

/** One encoded value: tag byte(s), shortest length, content. */
export function tlv(cls: number, constructed: boolean, tag: number, content: Uint8Array): Buffer {
  const head: number[] = [];
  const f = (cls << 6) | (constructed ? 0x20 : 0);
  if (tag < 31) head.push(f | tag);
  else {
    head.push(f | 0x1f);
    const t: number[] = [];
    for (let v = tag; v > 0; v = Math.floor(v / 128)) t.unshift((v & 0x7f) | (t.length ? 0x80 : 0));
    head.push(...t.map((x, i) => (i < t.length - 1 ? x | 0x80 : x & 0x7f)));
  }
  return Buffer.concat([Buffer.from(head), lenBytes(content.length), content]);
}

const univ = (tag: number, constructed: boolean, content: Uint8Array) => tlv(0, constructed, tag, content);

export const sequence = (...items: Uint8Array[]): Buffer => univ(UT.sequence, true, Buffer.concat(items));
/** A SET; its elements are put in order of their encodings, as DER requires of SET OF. */
export const set = (...items: Uint8Array[]): Buffer => univ(UT.set, true, Buffer.concat(items.map((i) => Buffer.from(i)).sort(Buffer.compare)));
export const nullValue = (): Buffer => univ(UT.null, false, Buffer.alloc(0));
export const boolean = (v: boolean): Buffer => univ(UT.boolean, false, Buffer.from([v ? 0xff : 0]));
export const octetString = (b: Uint8Array): Buffer => univ(UT.octetString, false, b);
export const bitString = (b: Uint8Array, unused = 0): Buffer => univ(UT.bitString, false, Buffer.concat([Buffer.from([unused]), b]));
export const utf8String = (s: string): Buffer => univ(UT.utf8, false, Buffer.from(s, 'utf8'));
export const printableString = (s: string): Buffer => {
  if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(s)) throw new DerError('not a PrintableString');
  return univ(UT.printable, false, Buffer.from(s, 'latin1'));
};
export const ia5String = (s: string): Buffer => {
  if (!/^[\x00-\x7f]*$/.test(s)) throw new DerError('not an IA5String');
  return univ(UT.ia5, false, Buffer.from(s, 'latin1'));
};

export function integer(v: bigint | number): Buffer {
  let n = BigInt(v);
  const out: number[] = [];
  if (n >= 0n) {
    do {
      out.unshift(Number(n & 0xffn));
      n >>= 8n;
    } while (n > 0n);
    if (out[0]! & 0x80) out.unshift(0);
  } else {
    do {
      out.unshift(Number(n & 0xffn));
      n >>= 8n;
    } while (n < -1n || (out[0]! & 0x80) === 0);
  }
  return univ(UT.integer, false, Buffer.from(out));
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((x) => {
    if (!/^(0|[1-9]\d*)$/.test(x)) throw new DerError(`${JSON.stringify(dotted)} is not an object identifier`);
    return BigInt(x);
  });
  if (arcs.length < 2 || arcs[0]! > 2n || (arcs[0]! < 2n && arcs[1]! > 39n)) throw new DerError(`${JSON.stringify(dotted)} is not an object identifier`);
  const out: number[] = [];
  const push = (v: bigint) => {
    const t: number[] = [Number(v & 0x7fn)];
    for (v >>= 7n; v > 0n; v >>= 7n) t.unshift(Number(v & 0x7fn) | 0x80);
    out.push(...t);
  };
  push(arcs[0]! * 40n + arcs[1]!);
  for (const a of arcs.slice(2)) push(a);
  return univ(UT.oid, false, Buffer.from(out));
}

const two = (n: number) => String(n).padStart(2, '0');
/** UTCTime for 1950 to 2049, GeneralizedTime outside it, as RFC 5280 requires. */
export function time(d: Date): Buffer {
  const y = d.getUTCFullYear();
  const rest = `${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y <= 2049) return univ(UT.utcTime, false, Buffer.from(`${two(y % 100)}${rest}`, 'latin1'));
  return univ(UT.genTime, false, Buffer.from(`${String(y).padStart(4, '0')}${rest}`, 'latin1'));
}

/** [n] EXPLICIT: the value wrapped in a context tag. */
export const explicit = (n: number, inner: Uint8Array): Buffer => tlv(2, true, n, inner);
/** [n] IMPLICIT primitive: the tag replaced, the content kept. */
export const implicit = (n: number, content: Uint8Array): Buffer => tlv(2, false, n, content);

// ---------------------------------------------------------------- object identifiers

export const OID: Readonly<Record<string, string>> = {
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
};
const byName = new Map(Object.entries(OID).map(([k, v]) => [v, k]));
export const oidName = (dotted: string): string => OID[dotted] ?? dotted;
/** The dotted form of a name from the table (or of a dotted string, as is). */
export const oidOf = (name: string): string => {
  const d = byName.get(name) ?? name;
  if (!/^\d+(\.\d+)+$/.test(d)) throw new DerError(`unknown object identifier name ${JSON.stringify(name)}`);
  return d;
};

// ---------------------------------------------------------------- PEM

/** PEM armour (RFC 7468): the label, and the DER inside. Strict about the framing and the base64. */
export function fromPem(pem: string, label?: string): { label: string; der: Buffer }[] {
  const out: { label: string; der: Buffer }[] = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([^-]*?)-----END \1-----/g;
  for (let m = re.exec(pem); m; m = re.exec(pem)) {
    const b64 = m[2]!.replace(/\r?\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new DerError('bad base64 in PEM');
    if (label === undefined || m[1] === label) out.push({ label: m[1]!, der: Buffer.from(b64, 'base64') });
  }
  return out;
}

export const toPem = (label: string, der: Uint8Array): string => `-----BEGIN ${label}-----\n${(Buffer.from(der).toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

// ---------------------------------------------------------------- X.509

export type GeneralName = { type: 'dns' | 'email' | 'uri' | 'ip' | 'dirName' | 'registeredId' | 'other'; value: string };

export interface Certificate {
  readonly der: Buffer;
  readonly tbs: Buffer;
  readonly version: number;
  readonly serial: bigint;
  readonly signatureAlgorithm: string;
  readonly issuer: string;
  readonly subject: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly publicKey: { readonly algorithm: string; readonly curve?: string; readonly bits?: number; readonly spki: Buffer; readonly sha256: string };
  readonly isCA: boolean | undefined;
  readonly pathLen: number | undefined;
  readonly keyUsage: readonly string[];
  readonly extKeyUsage: readonly string[];
  readonly san: readonly GeneralName[];
  readonly subjectKeyId: string | undefined;
  readonly authorityKeyId: string | undefined;
  readonly extensions: readonly { readonly oid: string; readonly name: string; readonly critical: boolean; readonly value: Buffer }[];
  readonly sha256: string;
  readonly signature: Buffer;
}

const KU = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const colon = (b: Uint8Array) => (hex(b).match(/../g) ?? []).join(':');

/** A distinguished name as RFC 4514 writes it: most specific first, special characters escaped. */
export function nameToString(n: Der): string {
  expect(n, UT.sequence, 'a Name');
  const rdns = n.children.map((rdn) => {
    expect(rdn, UT.set, 'an RDN');
    return rdn.children
      .map((atv) => {
        const [t, v] = expect(atv, UT.sequence, 'an AttributeTypeAndValue').children as [Der, Der];
        const key = oidName(asOid(t));
        let val: string;
        try {
          val = asString(v);
        } catch {
          val = `#${hex(v.raw)}`;
        }
        if (!val.startsWith('#')) val = val.replace(/[,+"\\<>;=]/g, (c) => `\\${c}`).replace(/^([ #])/, '\\$1').replace(/ $/, '\\ ');
        return `${key}=${val}`;
      })
      .join('+');
  });
  return rdns.reverse().join(',');
}

const ipString = (b: Buffer): string => {
  if (b.length === 4) return [...b].join('.');
  if (b.length === 16) {
    const g = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16));
    // compress the longest run of zero groups, as RFC 5952 does
    let best = [-1, 0];
    for (let i = 0; i < 8; ) {
      if (g[i] !== '0') {
        i++;
        continue;
      }
      let j = i;
      while (j < 8 && g[j] === '0') j++;
      if (j - i > best[1]! && j - i > 1) best = [i, j - i];
      i = j;
    }
    return best[0]! < 0 ? g.join(':') : `${g.slice(0, best[0]!).join(':')}::${g.slice(best[0]! + best[1]!).join(':')}`;
  }
  throw new DerError('an iPAddress of the wrong length');
};

export function generalNames(seq: Der): GeneralName[] {
  expect(seq, UT.sequence, 'a GeneralNames');
  return seq.children.map((n): GeneralName => {
    if (n.cls !== 2) throw new DerError('a general name without a context tag');
    switch (n.tag) {
      case 1: return { type: 'email', value: n.content.toString('latin1') };
      case 2: return { type: 'dns', value: n.content.toString('latin1') };
      case 6: return { type: 'uri', value: n.content.toString('latin1') };
      case 7: return { type: 'ip', value: ipString(n.content) };
      case 4: return { type: 'dirName', value: nameToString(n.children[0]!) };
      case 8: return { type: 'registeredId', value: asOid({ ...n, cls: 0, tag: UT.oid } as Der) };
      default: return { type: 'other', value: hex(n.raw) };
    }
  });
}

export function parseSpki(der: Buffer): Certificate['publicKey'] {
  const n = parseDer(der);
  const [alg, bits] = expect(n, UT.sequence, 'SubjectPublicKeyInfo').children as [Der, Der];
  const [a, params] = expect(alg, UT.sequence, 'AlgorithmIdentifier').children as [Der, Der | undefined];
  const algorithm = oidName(asOid(a));
  const key = asBits(bits).bytes;
  let curve: string | undefined;
  let size: number | undefined;
  if (algorithm === 'ecPublicKey' && params && isU(params, UT.oid)) {
    curve = oidName(asOid(params));
    size = { prime256v1: 256, secp384r1: 384, secp521r1: 521 }[curve];
  } else if (algorithm === 'rsaEncryption') {
    const rsa = parseDer(key);
    const modulus = expect(rsa.children[0]!, UT.integer, 'the modulus').content;
    size = (modulus[0] === 0 ? modulus.length - 1 : modulus.length) * 8;
  } else if (algorithm === 'Ed25519') size = 256;
  return { algorithm, ...(curve ? { curve } : {}), ...(size ? { bits: size } : {}), spki: der, sha256: createHash('sha256').update(der).digest('hex') };
}

export function parseCertificate(der: Uint8Array): Certificate {
  const buf = Buffer.from(der);
  const top = parseDer(buf);
  const [tbs, sigAlg, sig] = expect(top, UT.sequence, 'a Certificate').children as [Der, Der, Der];
  if (!tbs || !sigAlg || !sig || top.children.length !== 3) throw new DerError('a Certificate has three parts');
  const f = [...expect(tbs, UT.sequence, 'TBSCertificate').children];
  let version = 1;
  if (f[0] && f[0].cls === 2 && f[0].tag === 0) {
    version = Number(asInteger(f[0].children[0]!)) + 1;
    f.shift();
  }
  if (version < 1 || version > 3) throw new DerError('an unknown certificate version');
  const [serial, tbsAlg, issuer, validity, subject, spki] = f.splice(0, 6) as [Der, Der, Der, Der, Der, Der];
  if (!serial || !tbsAlg || !issuer || !validity || !subject || !spki) throw new DerError('a TBSCertificate is missing fields');
  const algOf = (n: Der) => oidName(asOid(expect(n, UT.sequence, 'an AlgorithmIdentifier').children[0]!));
  const signatureAlgorithm = algOf(sigAlg);
  if (!tbsAlg.raw.equals(sigAlg.raw)) throw new DerError('the two signature algorithm fields differ');
  const [nb, na] = expect(validity, UT.sequence, 'Validity').children as [Der, Der];
  const extNode = f.find((x) => x.cls === 2 && x.tag === 3);
  const extensions: Certificate['extensions'][number][] = [];
  const out: {
    isCA?: boolean;
    pathLen?: number;
    keyUsage: string[];
    extKeyUsage: string[];
    san: GeneralName[];
    ski?: string;
    aki?: string;
  } = { keyUsage: [], extKeyUsage: [], san: [] };
  const seen = new Set<string>();
  for (const e of extNode?.children[0]?.children ?? []) {
    const [o, ...rest] = expect(e, UT.sequence, 'an Extension').children as [Der, ...Der[]];
    const id = asOid(o);
    if (seen.has(id)) throw new DerError(`the extension ${id} appears twice`);
    seen.add(id);
    const critical = rest.length === 2 ? asBoolean(rest[0]!) : false;
    const value = asOctets(rest.at(-1)!);
    extensions.push({ oid: id, name: oidName(id), critical, value });
    const v = parseDer(value);
    switch (id) {
      case '2.5.29.19': {
        out.isCA = v.children[0] && isU(v.children[0], UT.boolean) ? asBoolean(v.children[0]) : false;
        const pl = v.children.find((c) => isU(c, UT.integer));
        if (pl) out.pathLen = Number(asInteger(pl));
        break;
      }
      case '2.5.29.15': {
        const { bytes, unused } = asBits(v);
        for (let i = 0; i < bytes.length * 8 - unused && i < KU.length; i++) if (bytes[i >> 3]! & (0x80 >> (i & 7))) out.keyUsage.push(KU[i]!);
        break;
      }
      case '2.5.29.37':
        out.extKeyUsage = v.children.map((c) => oidName(asOid(c)));
        break;
      case '2.5.29.17':
        out.san = generalNames(v);
        break;
      case '2.5.29.14':
        out.ski = colon(asOctets(v));
        break;
      case '2.5.29.35': {
        const k = v.children.find((c) => c.cls === 2 && c.tag === 0);
        if (k) out.aki = colon(k.content);
        break;
      }
    }
  }
  return {
    der: buf,
    tbs: tbs.raw,
    version,
    serial: asInteger(serial),
    signatureAlgorithm,
    issuer: nameToString(issuer),
    subject: nameToString(subject),
    notBefore: asTime(nb),
    notAfter: asTime(na),
    publicKey: parseSpki(Buffer.from(spki.raw)),
    isCA: out.isCA,
    pathLen: out.pathLen,
    keyUsage: out.keyUsage,
    extKeyUsage: out.extKeyUsage,
    san: out.san,
    subjectKeyId: out.ski,
    authorityKeyId: out.aki,
    extensions,
    sha256: createHash('sha256').update(buf).digest('hex'),
    signature: asBits(sig).bytes,
  };
}

/** Whether the certificate may be presented now, and when it stops being valid. */
export function validAt(c: Certificate, at: Date): { valid: boolean; reason?: 'not yet valid' | 'expired' } {
  if (at < c.notBefore) return { valid: false, reason: 'not yet valid' };
  if (at > c.notAfter) return { valid: false, reason: 'expired' };
  return { valid: true };
}

/**
 * RFC 6125 hostname matching against the SAN list: exact (case-insensitive) or a wildcard in the whole left-most
 * label that stands for exactly one label ("*.example.org" matches "www.example.org", not "example.org" or
 * "a.b.example.org"). An IP address matches only an iPAddress entry. The common name is not consulted.
 */
export function matchesHostname(c: Certificate, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isIP(h)) return c.san.some((n) => n.type === 'ip' && sameIp(n.value, h));
  return c.san
    .filter((n) => n.type === 'dns')
    .some((n) => {
      const p = n.value.toLowerCase().replace(/\.$/, '');
      if (!p.includes('*')) return p === h;
      const labels = p.split('.');
      if (labels[0] !== '*' || labels.length < 3 || labels.slice(1).some((l) => l.includes('*'))) return false;
      const rest = labels.slice(1).join('.');
      return h.endsWith(`.${rest}`) && h.length > rest.length + 1 && !h.slice(0, h.length - rest.length - 1).includes('.');
    });
}

const sameIp = (a: string, b: string) => {
  const norm = (s: string) => (isIP(s) === 6 ? ipString(parseIp6(s)) : s);
  return norm(a) === norm(b);
};
function parseIp6(s: string): Buffer {
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const mid = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  const g = [...h, ...mid, ...t].map((x) => parseInt(x, 16));
  const b = Buffer.alloc(16);
  g.forEach((x, i) => b.writeUInt16BE(x, i * 2));
  return b;
}

// ---------------------------------------------------------------- signatures

const SIG_HASH: Readonly<Record<string, string | null>> = {
  sha256WithRSAEncryption: 'sha256',
  sha384WithRSAEncryption: 'sha384',
  sha512WithRSAEncryption: 'sha512',
  'ecdsa-with-SHA256': 'sha256',
  'ecdsa-with-SHA384': 'sha384',
  'ecdsa-with-SHA512': 'sha512',
  Ed25519: null,
};

/** Checks the signature on `data` with a public key; SHA-1 and unknown algorithms are refused. */
export function checkSignature(alg: string, data: Uint8Array, signature: Uint8Array, spki: Uint8Array, o: { allowSha1?: boolean } = {}): boolean {
  if (!(alg in SIG_HASH)) {
    if (o.allowSha1 && (alg === 'sha1WithRSAEncryption' || alg === 'ecdsa-with-SHA1')) return cryptoVerify('sha1', data, createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' }), signature);
    throw new DerError(`the signature algorithm ${alg} is not accepted`);
  }
  const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
  return cryptoVerify(SIG_HASH[alg]!, data, key, signature);
}

/** Whether `issuer`'s key made `cert`'s signature, and the names line up. */
export function signedBy(cert: Certificate, issuer: Certificate, o: { allowSha1?: boolean } = {}): boolean {
  if (cert.issuer !== issuer.subject) return false;
  return checkSignature(cert.signatureAlgorithm, cert.tbs, cert.signature, issuer.publicKey.spki, o);
}

// ---------------------------------------------------------------- CSR

export type SanEntry = { dns: string } | { ip: string } | { email: string } | { uri: string };

export interface CsrRequest {
  /** Attributes in order, most significant first: [["C","US"],["O","Example"],["CN","example.org"]]. */
  readonly subject: readonly (readonly [string, string])[];
  readonly san?: readonly SanEntry[];
  readonly privateKey: KeyObject;
}

const nameDer = (attrs: readonly (readonly [string, string])[]): Buffer =>
  sequence(
    ...attrs.map(([k, v]) => {
      const id = oidOf(k);
      const str = k === 'C' ? printableString(v) : k === 'emailAddress' ? ia5String(v) : /^[A-Za-z0-9 '()+,\-./:=?]*$/.test(v) && v ? printableString(v) : utf8String(v);
      if (k === 'C' && v.length !== 2) throw new DerError('a country is two letters');
      return set(sequence(oid(id), str));
    }),
  );

function ipBytes(s: string): Buffer {
  const v = isIP(s);
  if (v === 4) return Buffer.from(s.split('.').map(Number));
  if (v === 6) return parseIp6(s);
  throw new DerError(`${JSON.stringify(s)} is not an IP address`);
}

export function sanExtension(san: readonly SanEntry[]): Buffer {
  return sequence(
    ...san.map((e) => {
      if ('dns' in e) return implicit(2, ia5Checked(e.dns));
      if ('email' in e) return implicit(1, ia5Checked(e.email));
      if ('uri' in e) return implicit(6, ia5Checked(e.uri));
      return implicit(7, ipBytes(e.ip));
    }),
  );
}
const ia5Checked = (s: string): Buffer => {
  if (!s || /[^\x20-\x7e]/.test(s)) throw new DerError('a SAN entry must be non-empty ASCII (use punycode for international names)');
  return Buffer.from(s, 'latin1');
};

function sigFor(key: KeyObject): { oid: string; hash: string | null; params: boolean } {
  const t = key.asymmetricKeyType;
  if (t === 'rsa') return { oid: oidOf('sha256WithRSAEncryption'), hash: 'sha256', params: true };
  if (t === 'ed25519') return { oid: oidOf('Ed25519'), hash: null, params: false };
  if (t === 'ec') {
    const c = key.asymmetricKeyDetails?.namedCurve;
    if (c === 'prime256v1' || c === 'P-256') return { oid: oidOf('ecdsa-with-SHA256'), hash: 'sha256', params: false };
    if (c === 'secp384r1' || c === 'P-384') return { oid: oidOf('ecdsa-with-SHA384'), hash: 'sha384', params: false };
  }
  throw new DerError('only RSA, ECDSA P-256 and P-384, and Ed25519 keys sign requests here');
}

/** A PKCS#10 certification request (RFC 2986) with the SAN list as an extensionRequest attribute. */
export function buildCsr(r: CsrRequest): Buffer {
  if (!r.subject.length && !r.san?.length) throw new DerError('a request needs a subject or a SAN list');
  const sig = sigFor(r.privateKey);
  const spki = createPublicKey(r.privateKey).export({ type: 'spki', format: 'der' });
  const attrs = r.san?.length ? [sequence(oid(oidOf('extensionRequest')), set(sequence(sequence(oid(oidOf('subjectAltName')), octetString(sanExtension(r.san))))))] : [];
  // [0] IMPLICIT SET OF Attribute: present even when there are none.
  const info = sequence(integer(0), nameDer(r.subject), Buffer.from(spki), tlv(2, true, 0, Buffer.concat(attrs)));
  const signature = cryptoSign(sig.hash, info, r.privateKey);
  const algId = sig.params ? sequence(oid(sig.oid), nullValue()) : sequence(oid(sig.oid));
  return sequence(info, algId, bitString(signature));
}

export interface Csr {
  readonly der: Buffer;
  readonly subject: string;
  readonly san: readonly GeneralName[];
  readonly publicKey: Certificate['publicKey'];
  readonly signatureAlgorithm: string;
  /** Whether the request is signed by the key it carries (proof of possession). */
  readonly selfSignatureValid: boolean;
}

export function parseCsr(der: Uint8Array): Csr {
  const buf = Buffer.from(der);
  const top = parseDer(buf);
  const [info, algId, sig] = expect(top, UT.sequence, 'a CertificationRequest').children as [Der, Der, Der];
  if (!info || !algId || !sig || top.children.length !== 3) throw new DerError('a CertificationRequest has three parts');
  const [ver, subject, spki, attrs] = expect(info, UT.sequence, 'CertificationRequestInfo').children as [Der, Der, Der, Der | undefined];
  if (asInteger(ver) !== 0n) throw new DerError('an unknown request version');
  const san: GeneralName[] = [];
  for (const a of attrs?.children ?? []) {
    const [type, values] = a.children as [Der, Der];
    if (asOid(type) !== '1.2.840.113549.1.9.14') continue;
    for (const ext of values.children[0]?.children ?? []) {
      const [o, ...rest] = ext.children as [Der, ...Der[]];
      if (asOid(o) === '2.5.29.17') san.push(...generalNames(parseDer(asOctets(rest.at(-1)!))));
    }
  }
  const signatureAlgorithm = oidName(asOid(algId.children[0]!));
  const publicKey = parseSpki(Buffer.from(spki.raw));
  let valid = false;
  try {
    valid = checkSignature(signatureAlgorithm, info.raw, asBits(sig).bytes, publicKey.spki);
  } catch {
    valid = false;
  }
  return { der: buf, subject: nameToString(subject), san, publicKey, signatureAlgorithm, selfSignatureValid: valid };
}
