/**
 * cert-store: a certificate inventory that knows what it holds. It reads X.509 certificates (PEM or DER) with a small
 * strict DER reader of its own, builds and checks chains to a set of trusted roots, says which host names a
 * certificate covers, raises expiry alerts as a feed with stable de-duplication keys, and plans OCSP stapling.
 *
 * Follows: RFC 5280 (certificate profile, name matching, path validation basics, basicConstraints, keyUsage,
 * pathLenConstraint, unknown critical extensions), ITU-T X.690 DER (definite lengths, minimal length encoding),
 * RFC 9525 (service identity: wildcard only as the whole left-most label, no partial wildcards, IP addresses match
 * only iPAddress entries, CN ignored when SANs exist), RFC 7633 (TLS Feature must-staple) and RFC 6960 (OCSP) for the
 * stapling plan's vocabulary.
 *
 * The block carries its own DER reader because the shared asn1-der block was not available when this was written.
 * Signature checks use node:crypto on the certificate's own public key; no other dependency, no network, no files.
 * The clock is always passed in.
 *
 * Out of scope: name constraints, policy mapping, CRL and OCSP response parsing and fetching (the caller passes the
 * decoded OCSP fields to recordOcsp), RSASSA-PSS signatures (refused with a typed error), and a platform trust store.
 *
 * Security: DER input is bounded (size, depth, element count), lengths must be minimal and inside the buffer, a
 * duplicate extension or an unknown critical extension is a problem, a certificate that is not a CA cannot issue,
 * and a wrong signature under a matching name never counts as a chain.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { domainToASCII } from 'node:url';

export class CertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertError';
  }
}

const MAX_CERT_BYTES = 256 * 1024;
const MAX_DEPTH = 12;
const MAX_ELEMENTS = 20_000;
const MAX_BUNDLE_CERTS = 200;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// DER reader

interface Tlv {
  readonly tag: number;
  readonly value: Uint8Array;
  readonly raw: Uint8Array;
}

function readOne(buf: Uint8Array, pos: number, counter: { n: number }): { tlv: Tlv; next: number } {
  if (++counter.n > MAX_ELEMENTS) throw new CertError('DER has too many elements');
  if (pos + 2 > buf.length) throw new CertError('DER is truncated');
  const tag = buf[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new CertError('DER high tag numbers are not supported');
  let len = buf[pos + 1]!;
  let p = pos + 2;
  if (len === 0x80) throw new CertError('DER must not use indefinite lengths');
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 3) throw new CertError('DER length is too large');
    if (p + n > buf.length) throw new CertError('DER is truncated');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i]!;
    if (buf[p] === 0 || len < 128) throw new CertError('DER length is not minimally encoded');
    p += n;
  }
  if (p + len > buf.length) throw new CertError('DER element runs past the end of its container');
  return { tlv: { tag, value: buf.subarray(p, p + len), raw: buf.subarray(pos, p + len) }, next: p + len };
}

function children(t: Tlv, counter: { n: number }, depth: number): Tlv[] {
  if (depth > MAX_DEPTH) throw new CertError('DER is nested too deeply');
  const out: Tlv[] = [];
  let pos = 0;
  while (pos < t.value.length) {
    const r = readOne(t.value, pos, counter);
    out.push(r.tlv);
    pos = r.next;
  }
  return out;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function oid(t: Tlv): string {
  if (t.tag !== 0x06 || t.value.length === 0) throw new CertError('expected an OBJECT IDENTIFIER');
  const parts: number[] = [];
  let n = 0;
  for (let i = 0; i < t.value.length; i++) {
    const b = t.value[i]!;
    n = n * 128 + (b & 0x7f);
    if (n > Number.MAX_SAFE_INTEGER / 256) throw new CertError('OID arc is too large');
    if (!(b & 0x80)) {
      if (parts.length === 0) {
        const first = n < 40 ? 0 : n < 80 ? 1 : 2;
        parts.push(first, n - first * 40);
      } else parts.push(n);
      n = 0;
    } else if (i === t.value.length - 1) throw new CertError('OBJECT IDENTIFIER is truncated');
  }
  return parts.join('.');
}

function text(t: Tlv): string {
  const v = t.value;
  switch (t.tag) {
    case 0x0c:
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(v);
      } catch {
        throw new CertError('a UTF8String is not valid UTF-8');
      }
    case 0x13:
    case 0x16:
    case 0x14:
      return Array.from(v, (b) => String.fromCharCode(b)).join('');
    case 0x1e: {
      if (v.length % 2) throw new CertError('BMPString has an odd length');
      let s = '';
      for (let i = 0; i < v.length; i += 2) s += String.fromCharCode(v[i]! * 256 + v[i + 1]!);
      return s;
    }
    case 0x1c: {
      if (v.length % 4) throw new CertError('UniversalString length is not a multiple of 4');
      let s = '';
      for (let i = 0; i < v.length; i += 4) s += String.fromCodePoint(((v[i]! << 24) | (v[i + 1]! << 16) | (v[i + 2]! << 8) | v[i + 3]!) >>> 0);
      return s;
    }
    default:
      throw new CertError(`unsupported string type 0x${t.tag.toString(16)}`);
  }
}

function time(t: Tlv): number {
  const s = Array.from(t.value, (b) => String.fromCharCode(b)).join('');
  let m: RegExpMatchArray | null;
  let y: number;
  if (t.tag === 0x17) {
    m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s);
    if (!m) throw new CertError('bad UTCTime');
    y = Number(m[1]) >= 50 ? 1900 + Number(m[1]) : 2000 + Number(m[1]);
  } else if (t.tag === 0x18) {
    m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(s);
    if (!m) throw new CertError('bad GeneralizedTime');
    y = Number(m[1]);
  } else throw new CertError('expected a time');
  const [mo, d, h, mi, se] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) throw new CertError('time field out of range');
  return Date.UTC(y, mo - 1, d, h, mi, se);
}

// ---------------------------------------------------------------------------------------------------------------
// Names

export interface NameAttribute {
  readonly type: string;
  readonly oid: string;
  readonly value: string;
}

const ATTR: Record<string, string> = {
  '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.5': 'serialNumber', '2.5.4.9': 'street',
  '0.9.2342.19200300.100.1.25': 'DC', '1.2.840.113549.1.9.1': 'emailAddress',
};

function parseName(t: Tlv, counter: { n: number }): NameAttribute[][] {
  if (t.tag !== 0x30) throw new CertError('a Name must be a SEQUENCE');
  return children(t, counter, 3).map((rdn) => {
    if (rdn.tag !== 0x31) throw new CertError('a RelativeDistinguishedName must be a SET');
    const attrs = children(rdn, counter, 4).map((av) => {
      const [o, v] = children(av, counter, 5);
      if (!o || !v) throw new CertError('bad AttributeTypeAndValue');
      const id = oid(o);
      return { type: ATTR[id] ?? id, oid: id, value: text(v) };
    });
    if (!attrs.length) throw new CertError('an RDN cannot be empty');
    return attrs;
  });
}

function escapeDn(v: string): string {
  let s = v.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`).replace(/[\u0000-\u001f]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  if (s.startsWith('#') || s.startsWith(' ')) s = `\\${s}`;
  if (s.endsWith(' ')) s = `${s.slice(0, -1)}\\ `;
  return s;
}

/** RFC 4514 string form: most specific RDN first. */
export function nameToString(name: readonly (readonly NameAttribute[])[]): string {
  return [...name].reverse().map((rdn) => rdn.map((a) => `${a.type}=${escapeDn(a.value)}`).join('+')).join(',');
}

/** A key for comparing names the RFC 5280 way (case-insensitive, whitespace folded), good enough for chain building. */
export function nameKey(name: readonly (readonly NameAttribute[])[]): string {
  return name.map((rdn) => rdn.map((a) => `${a.oid}=${a.value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()}`).sort().join('+')).join('/');
}

// ---------------------------------------------------------------------------------------------------------------
// Certificates

export type KeyUsageName = 'digitalSignature' | 'contentCommitment' | 'keyEncipherment' | 'dataEncipherment' | 'keyAgreement' | 'keyCertSign' | 'cRLSign' | 'encipherOnly' | 'decipherOnly';
const KEY_USAGES: KeyUsageName[] = ['digitalSignature', 'contentCommitment', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];
const EKU: Record<string, string> = { '1.3.6.1.5.5.7.3.1': 'serverAuth', '1.3.6.1.5.5.7.3.2': 'clientAuth', '1.3.6.1.5.5.7.3.3': 'codeSigning', '1.3.6.1.5.5.7.3.4': 'emailProtection', '1.3.6.1.5.5.7.3.8': 'timeStamping', '1.3.6.1.5.5.7.3.9': 'ocspSigning', '2.5.29.37.0': 'anyExtendedKeyUsage' };
const KNOWN_EXT = new Set(['2.5.29.17', '2.5.29.19', '2.5.29.15', '2.5.29.37', '2.5.29.14', '2.5.29.35', '1.3.6.1.5.5.7.1.1', '1.3.6.1.5.5.7.1.24', '2.5.29.32', '2.5.29.31', '2.5.29.30', '2.5.29.18', '1.3.6.1.4.1.11129.2.4.2', '2.5.29.9']);

export interface Certificate {
  /** SHA-256 of the DER, lower-case hex. Used as the identity everywhere. */
  readonly id: string;
  readonly der: Uint8Array;
  readonly version: number;
  readonly serialHex: string;
  readonly subject: readonly (readonly NameAttribute[])[];
  readonly issuer: readonly (readonly NameAttribute[])[];
  readonly subjectText: string;
  readonly issuerText: string;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly signatureAlgorithm: string;
  readonly dnsNames: readonly string[];
  readonly ipAddresses: readonly string[];
  readonly emails: readonly string[];
  readonly uris: readonly string[];
  readonly isCa: boolean;
  readonly pathLen: number | undefined;
  readonly keyUsage: readonly KeyUsageName[] | undefined;
  readonly extendedKeyUsage: readonly string[] | undefined;
  readonly subjectKeyId: string | undefined;
  readonly authorityKeyId: string | undefined;
  readonly ocspUrls: readonly string[];
  readonly caIssuerUrls: readonly string[];
  readonly mustStaple: boolean;
  readonly unknownCriticalExtensions: readonly string[];
  readonly selfIssued: boolean;
  /** @internal parts needed to check signatures */
  readonly tbs: Uint8Array;
  readonly signature: Uint8Array;
  readonly spki: Uint8Array;
}

function ipText(b: Uint8Array): string {
  if (b.length === 4) return Array.from(b).join('.');
  if (b.length !== 16) throw new CertError('an iPAddress must be 4 or 16 bytes');
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push(b[i]! * 256 + b[i + 1]!);
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const h = (x: number): string => x.toString(16);
  if (best < 0) return g.map(h).join(':');
  return `${g.slice(0, best).map(h).join(':')}::${g.slice(best + bestLen).map(h).join(':')}`;
}

/** Parse an IPv4 or IPv6 literal to bytes, or undefined. */
export function parseIp(s: string): Uint8Array | undefined {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const o = v4.slice(1).map(Number);
    return o.every((x) => x <= 255) && v4.slice(1).every((x) => x === String(Number(x))) ? Uint8Array.from(o) : undefined;
  }
  if (!/^[0-9a-f:.]+$/i.test(s) || !s.includes(':')) return undefined;
  let head = s;
  let tail: string | undefined;
  if (s.includes('::')) {
    const parts = s.split('::');
    if (parts.length !== 2) return undefined;
    head = parts[0]!;
    tail = parts[1]!;
  }
  const groups = (x: string): number[] | undefined => {
    if (x === '') return [];
    const out: number[] = [];
    const ps = x.split(':');
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p.includes('.')) {
        const b = i === ps.length - 1 ? parseIp(p) : undefined;
        if (!b || b.length !== 4) return undefined;
        out.push(b[0]! * 256 + b[1]!, b[2]! * 256 + b[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(p)) out.push(parseInt(p, 16));
      else return undefined;
    }
    return out;
  };
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  if (!h || !t) return undefined;
  const total = h.length + t.length;
  if (tail === undefined ? total !== 8 : total > 7) return undefined;
  const all = [...h, ...Array(8 - total).fill(0), ...t];
  const out = new Uint8Array(16);
  all.forEach((g, i) => { out[2 * i] = g >> 8; out[2 * i + 1] = g & 255; });
  return out;
}

const strHex = (t: Tlv): string => hex(t.value);

/** Parse one DER certificate. */
export function parseCertificateDer(input: Uint8Array): Certificate {
  if (!(input instanceof Uint8Array)) throw new CertError('certificate must be bytes');
  if (input.length > MAX_CERT_BYTES) throw new CertError('certificate is too large');
  const der = Uint8Array.from(input);
  const counter = { n: 0 };
  const top = readOne(der, 0, counter);
  if (top.next !== der.length) throw new CertError('trailing bytes after the certificate');
  if (top.tlv.tag !== 0x30) throw new CertError('a certificate is a SEQUENCE');
  const [tbsT, sigAlgT, sigT] = children(top.tlv, counter, 1);
  if (!tbsT || !sigAlgT || !sigT || tbsT.tag !== 0x30) throw new CertError('certificate structure is wrong');
  if (sigT.tag !== 0x03 || sigT.value.length < 1 || sigT.value[0] !== 0) throw new CertError('bad signature BIT STRING');
  const sigAlg = oid(children(sigAlgT, counter, 2)[0]!);
  const f = children(tbsT, counter, 2);
  let i = 0;
  let version = 1;
  if (f[i]?.tag === 0xa0) {
    const v = children(f[i]!, counter, 3)[0];
    if (!v || v.tag !== 0x02 || v.value.length !== 1) throw new CertError('bad version');
    version = v.value[0]! + 1;
    if (version > 3) throw new CertError('unsupported certificate version');
    i++;
  }
  const serial = f[i++];
  if (!serial || serial.tag !== 0x02 || serial.value.length === 0 || serial.value.length > 21) throw new CertError('bad serial number');
  const tbsAlg = f[i++];
  if (!tbsAlg || oid(children(tbsAlg, counter, 3)[0]!) !== sigAlg) throw new CertError('the two signature algorithm fields disagree');
  const issuerT = f[i++];
  const validity = f[i++];
  const subjectT = f[i++];
  const spkiT = f[i++];
  if (!issuerT || !validity || !subjectT || !spkiT || spkiT.tag !== 0x30) throw new CertError('certificate body is incomplete');
  const issuer = parseName(issuerT, counter);
  const subject = parseName(subjectT, counter);
  const [nb, na] = children(validity, counter, 3);
  if (!nb || !na) throw new CertError('bad validity');
  const notBefore = time(nb);
  const notAfter = time(na);
  if (notAfter < notBefore) throw new CertError('certificate expires before it starts');

  const dns: string[] = [];
  const ips: string[] = [];
  const emails: string[] = [];
  const uris: string[] = [];
  let isCa = false;
  let pathLen: number | undefined;
  let keyUsage: KeyUsageName[] | undefined;
  let eku: string[] | undefined;
  let ski: string | undefined;
  let aki: string | undefined;
  const ocsp: string[] = [];
  const caIss: string[] = [];
  let mustStaple = false;
  const unknownCritical: string[] = [];
  const seen = new Set<string>();
  for (; i < f.length; i++) {
    const item = f[i]!;
    if (item.tag === 0xa1 || item.tag === 0xa2) continue;
    if (item.tag !== 0xa3) throw new CertError('unexpected field in the certificate body');
    const list = children(children(item, counter, 3)[0]!, counter, 3);
    for (const ext of list) {
      const parts = children(ext, counter, 4);
      const id = oid(parts[0]!);
      if (seen.has(id)) throw new CertError(`duplicate extension ${id}`);
      seen.add(id);
      let critical = false;
      let p = 1;
      if (parts[p]?.tag === 0x01) {
        critical = parts[p]!.value[0] !== 0;
        p++;
      }
      const wrap = parts[p];
      if (!wrap || wrap.tag !== 0x04 || parts.length !== p + 1) throw new CertError('bad extension');
      const body = readOne(wrap.value, 0, counter);
      if (body.next !== wrap.value.length) throw new CertError('trailing bytes in an extension');
      const b = body.tlv;
      if (critical && !KNOWN_EXT.has(id)) unknownCritical.push(id);
      switch (id) {
        case '2.5.29.17':
          for (const gn of children(b, counter, 5)) {
            const s = Array.from(gn.value, (c) => String.fromCharCode(c)).join('');
            if (gn.tag === 0x82) dns.push(s);
            else if (gn.tag === 0x81) emails.push(s);
            else if (gn.tag === 0x86) uris.push(s);
            else if (gn.tag === 0x87) ips.push(ipText(gn.value));
          }
          break;
        case '2.5.29.19': {
          const bc = children(b, counter, 5);
          let k = 0;
          if (bc[k]?.tag === 0x01) isCa = bc[k++]!.value[0] !== 0;
          if (bc[k]?.tag === 0x02) {
            const v = bc[k]!.value;
            if (v.length > 4 || (v[0]! & 0x80)) throw new CertError('bad pathLenConstraint');
            pathLen = v.reduce((a, c) => a * 256 + c, 0);
          }
          break;
        }
        case '2.5.29.15': {
          if (b.tag !== 0x03 || b.value.length < 2) throw new CertError('bad keyUsage');
          keyUsage = [];
          for (let bit = 0; bit < 9; bit++) {
            const byte = b.value[1 + (bit >> 3)];
            if (byte !== undefined && byte & (0x80 >> (bit & 7))) keyUsage.push(KEY_USAGES[bit]!);
          }
          break;
        }
        case '2.5.29.37':
          eku = children(b, counter, 5).map((o) => {
            const n = oid(o);
            return EKU[n] ?? n;
          });
          break;
        case '2.5.29.14':
          if (b.tag !== 0x04) throw new CertError('bad subjectKeyIdentifier');
          ski = strHex(b);
          break;
        case '2.5.29.35': {
          const k = children(b, counter, 5).find((x) => x.tag === 0x80);
          if (k) aki = strHex(k);
          break;
        }
        case '1.3.6.1.5.5.7.1.1':
          for (const ad of children(b, counter, 5)) {
            const [m, loc] = children(ad, counter, 6);
            if (!m || !loc || loc.tag !== 0x86) continue;
            const method = oid(m);
            const url = Array.from(loc.value, (c) => String.fromCharCode(c)).join('');
            if (method === '1.3.6.1.5.5.7.48.1') ocsp.push(url);
            else if (method === '1.3.6.1.5.5.7.48.2') caIss.push(url);
          }
          break;
        case '1.3.6.1.5.5.7.1.24':
          mustStaple = children(b, counter, 5).some((x) => x.tag === 0x02 && x.value.length === 1 && (x.value[0] === 5 || x.value[0] === 17));
          break;
      }
    }
  }
  const sk = nameKey(subject);
  return {
    id: createHash('sha256').update(der).digest('hex'),
    der, version, serialHex: hex(serial.value).replace(/^00(?=.)/, ''),
    subject, issuer, subjectText: nameToString(subject), issuerText: nameToString(issuer),
    notBefore, notAfter, signatureAlgorithm: sigAlg,
    dnsNames: dns, ipAddresses: ips, emails, uris,
    isCa, pathLen, keyUsage, extendedKeyUsage: eku, subjectKeyId: ski, authorityKeyId: aki,
    ocspUrls: ocsp, caIssuerUrls: caIss, mustStaple, unknownCriticalExtensions: unknownCritical,
    selfIssued: sk === nameKey(issuer),
    tbs: tbsT.raw, signature: sigT.value.subarray(1), spki: spkiT.raw,
  };
}

/** Every certificate in a PEM bundle, in order. Text outside the armour is ignored; a bad block is an error. */
export function parsePem(textIn: string): Certificate[] {
  if (typeof textIn !== 'string') throw new CertError('PEM must be text');
  if (textIn.length > MAX_CERT_BYTES * 8) throw new CertError('PEM bundle is too large');
  const out: Certificate[] = [];
  const re = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]*?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textIn))) {
    if (out.length >= MAX_BUNDLE_CERTS) throw new CertError(`more than ${MAX_BUNDLE_CERTS} certificates in one bundle`);
    const b64 = m[1]!.replace(/\s+/g, '');
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new CertError('bad base64 in a PEM block');
    out.push(parseCertificateDer(Uint8Array.from(Buffer.from(b64, 'base64'))));
  }
  if (out.length !== (textIn.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length) throw new CertError('a CERTIFICATE block is malformed or not closed');
  return out;
}

/** One certificate from PEM text or DER bytes. */
export function parseCertificate(input: string | Uint8Array): Certificate {
  if (typeof input === 'string') {
    const all = parsePem(input);
    if (all.length !== 1) throw new CertError(`expected exactly one certificate, found ${all.length}`);
    return all[0]!;
  }
  return parseCertificateDer(input);
}

const SIG_ALGS: Record<string, string | null> = {
  '1.2.840.113549.1.1.11': 'sha256', '1.2.840.113549.1.1.12': 'sha384', '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.3.2': 'sha256', '1.2.840.10045.4.3.3': 'sha384', '1.2.840.10045.4.3.4': 'sha512',
  '1.3.101.112': null,
};

/** True when `issuer`'s key made `cert`'s signature. Throws CertError for algorithms this block will not check (SHA-1, MD5, PSS). */
export function verifySignature(cert: Certificate, issuer: Certificate): boolean {
  const alg = SIG_ALGS[cert.signatureAlgorithm];
  if (alg === undefined) throw new CertError(`signature algorithm ${cert.signatureAlgorithm} is not supported`);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(issuer.spki), format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  try {
    return cryptoVerify(alg, Buffer.from(cert.tbs), key, Buffer.from(cert.signature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Host matching (RFC 9525)

/** Lower-case A-label form of a host name with any trailing dot removed, or undefined when it cannot be a host name. */
export function normalizeHost(host: string): string | undefined {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253 * 2) return undefined;
  let h = host.endsWith('.') ? host.slice(0, -1) : host;
  if (parseIp(h)) return h.toLowerCase();
  if (/[\s/@:?#\\\u0000-\u001f]/.test(h) || h.includes('..') || h.startsWith('.')) return undefined;
  h = /^[\x00-\x7f]*$/.test(h) ? h.toLowerCase() : domainToASCII(h);
  if (!h || h.length > 253 || h.split('.').some((l) => l.length === 0 || l.length > 63)) return undefined;
  return h;
}

function dnsMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, '');
  if (!p.includes('*')) return p === host;
  const labels = p.split('.');
  // RFC 9525: the wildcard is the whole left-most label, and at least two labels follow it ("*.com" is refused).
  if (labels[0] !== '*' || labels.length < 3 || labels.slice(1).some((l) => l.includes('*') || l === '')) return false;
  const hl = host.split('.');
  if (hl.length !== labels.length || hl[0] === '') return false;
  return labels.slice(1).join('.') === hl.slice(1).join('.');
}

function ipEqual(a: string, b: Uint8Array): boolean {
  const pa = parseIp(a);
  return !!pa && pa.length === b.length && pa.every((x, i) => x === b[i]);
}

/** Does this certificate vouch for `host` (a DNS name or an IP literal)? The Common Name is not consulted. */
export function certificateCoversHost(cert: Certificate, host: string): boolean {
  const h = normalizeHost(host);
  if (h === undefined) return false;
  const ip = parseIp(h);
  if (ip) return cert.ipAddresses.some((a) => ipEqual(a, ip));
  return cert.dnsNames.some((d) => dnsMatches(d, h));
}

// ---------------------------------------------------------------------------------------------------------------
// Chains

export type ChainProblemCode =
  | 'unknown-issuer' | 'bad-signature' | 'expired' | 'not-yet-valid' | 'not-a-ca' | 'cannot-sign-certificates' | 'path-length-exceeded'
  | 'unknown-critical-extension' | 'host-mismatch' | 'wrong-purpose' | 'too-deep' | 'unsupported-algorithm';

export interface ChainProblem {
  readonly code: ChainProblemCode;
  readonly certificate: string;
  readonly message: string;
}

export interface Chain {
  /** Leaf first. When trusted, the last certificate is a trust anchor. */
  readonly certificates: readonly Certificate[];
  readonly trusted: boolean;
  readonly problems: readonly ChainProblem[];
}

export interface ChainOptions {
  readonly now: number;
  readonly roots: readonly Certificate[];
  readonly intermediates?: readonly Certificate[];
  readonly host?: string;
  readonly purpose?: 'server' | 'client';
  readonly maxDepth?: number;
}

function validityProblems(c: Certificate, now: number): ChainProblem[] {
  const out: ChainProblem[] = [];
  if (now < c.notBefore) out.push({ code: 'not-yet-valid', certificate: c.id, message: `${c.subjectText} is not valid until ${new Date(c.notBefore).toISOString()}` });
  if (now > c.notAfter) out.push({ code: 'expired', certificate: c.id, message: `${c.subjectText} expired at ${new Date(c.notAfter).toISOString()}` });
  if (c.unknownCriticalExtensions.length) out.push({ code: 'unknown-critical-extension', certificate: c.id, message: `${c.subjectText} has critical extension(s) ${c.unknownCriticalExtensions.join(', ')} this block does not understand` });
  return out;
}

/** Build a path from `leaf` to one of `roots` through `intermediates` and check it. A root is trusted by being in `roots`, never by its own say-so. */
export function buildChain(leaf: Certificate, o: ChainOptions): Chain {
  const maxDepth = Math.min(o.maxDepth ?? 8, MAX_DEPTH);
  const anchors = new Map(o.roots.map((r) => [r.id, r]));
  const pool = [...o.roots, ...(o.intermediates ?? [])];
  const byName = new Map<string, Certificate[]>();
  for (const c of pool) {
    const k = nameKey(c.subject);
    const l = byName.get(k);
    if (l) l.push(c);
    else byName.set(k, [c]);
  }
  let best: Chain | undefined;
  const consider = (c: Chain): void => {
    // Prefer a trusted chain, then the one with the fewest problems, then the longest (it got furthest).
    const better = !best || (c.trusted !== best.trusted ? c.trusted : c.problems.length !== best.problems.length ? c.problems.length < best.problems.length : c.certificates.length > best.certificates.length);
    if (better) best = c;
  };
  const leafProblems: ChainProblem[] = [...validityProblems(leaf, o.now)];
  if (o.host !== undefined && !certificateCoversHost(leaf, o.host)) leafProblems.push({ code: 'host-mismatch', certificate: leaf.id, message: `${leaf.subjectText} does not cover ${o.host}` });
  if (o.purpose && leaf.extendedKeyUsage && !leaf.extendedKeyUsage.includes(o.purpose === 'server' ? 'serverAuth' : 'clientAuth') && !leaf.extendedKeyUsage.includes('anyExtendedKeyUsage'))
    leafProblems.push({ code: 'wrong-purpose', certificate: leaf.id, message: `${leaf.subjectText} is not marked for ${o.purpose} use` });

  const walk = (path: Certificate[], problems: ChainProblem[], seen: Set<string>): void => {
    const cur = path[path.length - 1]!;
    if (anchors.has(cur.id)) {
      consider({ certificates: path, trusted: !problems.length, problems });
      return;
    }
    if (path.length > maxDepth) {
      consider({ certificates: path, trusted: false, problems: [...problems, { code: 'too-deep', certificate: cur.id, message: 'the chain is longer than allowed' }] });
      return;
    }
    const cands = (byName.get(nameKey(cur.issuer)) ?? []).filter((c) => !seen.has(c.id) && (!cur.authorityKeyId || !c.subjectKeyId || cur.authorityKeyId === c.subjectKeyId));
    if (!cands.length) {
      consider({ certificates: path, trusted: false, problems: [...problems, { code: 'unknown-issuer', certificate: cur.id, message: `no certificate for the issuer of ${cur.subjectText} (${cur.issuerText})` }] });
      return;
    }
    for (const cand of cands) {
      const ps = [...problems];
      let sigOk = false;
      try {
        sigOk = verifySignature(cur, cand);
      } catch (e) {
        ps.push({ code: 'unsupported-algorithm', certificate: cur.id, message: (e as Error).message });
        sigOk = true;
      }
      if (!sigOk) ps.push({ code: 'bad-signature', certificate: cur.id, message: `the signature on ${cur.subjectText} does not verify under ${cand.subjectText}` });
      if (!cand.isCa) ps.push({ code: 'not-a-ca', certificate: cand.id, message: `${cand.subjectText} is not a CA and cannot issue certificates` });
      if (cand.keyUsage && !cand.keyUsage.includes('keyCertSign')) ps.push({ code: 'cannot-sign-certificates', certificate: cand.id, message: `${cand.subjectText} has no keyCertSign usage` });
      if (cand.pathLen !== undefined) {
        const below = path.slice(1).filter((c) => !c.selfIssued).length;
        if (below > cand.pathLen) ps.push({ code: 'path-length-exceeded', certificate: cand.id, message: `${cand.subjectText} allows ${cand.pathLen} intermediate(s) below it, found ${below}` });
      }
      ps.push(...validityProblems(cand, o.now));
      walk([...path, cand], ps, new Set([...seen, cand.id]));
    }
  };
  walk([leaf], leafProblems, new Set([leaf.id]));
  return best!;
}

// ---------------------------------------------------------------------------------------------------------------
// The store

export interface StoreEntryMeta {
  /** Names this certificate must serve; a missing name raises a san-missing alert. */
  readonly hosts?: readonly string[];
  readonly label?: string;
}

export type OcspStatus = 'good' | 'revoked' | 'unknown';
export interface OcspRecord {
  readonly status: OcspStatus;
  readonly thisUpdate: number;
  readonly nextUpdate: number;
}

export type AlertKind = 'expired' | 'expiring' | 'not-yet-valid' | 'chain-broken' | 'san-missing' | 'must-staple-unavailable';
export type Severity = 'critical' | 'high' | 'warning' | 'notice';

export interface ExpiryAlert {
  readonly kind: AlertKind;
  readonly severity: Severity;
  readonly certificate: string;
  readonly subject: string;
  readonly label: string | undefined;
  readonly daysLeft: number | undefined;
  readonly message: string;
  /** Stable while the situation is the same, so a consumer can send each alert once. */
  readonly dedupeKey: string;
}

export interface StaplingEntry {
  readonly certificate: string;
  readonly subject: string;
  readonly ocspUrl: string | undefined;
  readonly mustStaple: boolean;
  readonly state: 'not-available' | 'no-response' | 'fresh' | 'refresh-due' | 'stale' | 'revoked';
  readonly refreshAt: number | undefined;
  readonly risk: Severity | 'none';
  readonly advice: string;
}

export interface StoreOptions {
  readonly roots?: readonly Certificate[];
  readonly maxEntries?: number;
  /** Alert when this many days or fewer remain. Default 30, 14, 7, 3, 1. */
  readonly thresholdsDays?: readonly number[];
}

interface Entry {
  readonly cert: Certificate;
  meta: StoreEntryMeta;
}

export class CertStore {
  private readonly entries = new Map<string, Entry>();
  private readonly roots = new Map<string, Certificate>();
  private readonly ocsp = new Map<string, OcspRecord>();
  private readonly max: number;
  private readonly thresholds: number[];

  constructor(o: StoreOptions = {}) {
    this.max = o.maxEntries ?? 10_000;
    this.thresholds = [...(o.thresholdsDays ?? [30, 14, 7, 3, 1])].sort((a, b) => b - a);
    if (this.thresholds.some((t) => !(t >= 0))) throw new CertError('thresholds must be non-negative numbers of days');
    for (const r of o.roots ?? []) this.roots.set(r.id, r);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Mark a certificate as a trust anchor. Only do this for certificates you have chosen to trust. */
  trust(cert: Certificate): void {
    this.roots.set(cert.id, cert);
  }

  add(input: string | Uint8Array | Certificate, meta: StoreEntryMeta = {}): Certificate {
    const cert = typeof input === 'string' || input instanceof Uint8Array ? parseCertificate(input) : input;
    const existing = this.entries.get(cert.id);
    if (existing) {
      existing.meta = { ...existing.meta, ...meta };
      return existing.cert;
    }
    if (this.entries.size >= this.max) throw new CertError(`the store is full (${this.max} certificates)`);
    this.entries.set(cert.id, { cert, meta });
    return cert;
  }

  addBundle(pem: string, meta: StoreEntryMeta = {}): Certificate[] {
    return parsePem(pem).map((c) => this.add(c, meta));
  }

  remove(id: string): boolean {
    this.ocsp.delete(id);
    return this.entries.delete(id);
  }

  get(id: string): Certificate | undefined {
    return this.entries.get(id)?.cert;
  }

  list(): Certificate[] {
    return [...this.entries.values()].map((e) => e.cert).sort((a, b) => a.notAfter - b.notAfter || a.id.localeCompare(b.id));
  }

  /** Chain for a stored certificate, using every stored CA certificate as a possible intermediate. */
  chain(id: string, now: number, o: { host?: string; purpose?: 'server' | 'client' } = {}): Chain {
    const e = this.entries.get(id);
    if (!e) throw new CertError('no such certificate in the store');
    const inter = [...this.entries.values()].map((x) => x.cert).filter((c) => c.id !== id && c.isCa);
    return buildChain(e.cert, { now, roots: [...this.roots.values()], intermediates: inter, ...(o.host !== undefined ? { host: o.host } : {}), ...(o.purpose ? { purpose: o.purpose } : {}) });
  }

  /** Valid, trusted certificates that cover `host` now, the one that lasts longest first. */
  covering(host: string, now: number): Certificate[] {
    return this.list()
      .filter((c) => !c.isCa && certificateCoversHost(c, host) && now >= c.notBefore && now <= c.notAfter && this.chain(c.id, now, { host }).trusted)
      .sort((a, b) => b.notAfter - a.notAfter);
  }

  /** The alert feed for `now`, most severe first. Leaf certificates only (CA expiry is reported through the chains that need them). */
  alerts(now: number): ExpiryAlert[] {
    const out: ExpiryAlert[] = [];
    const sev = (d: number): Severity => (d <= 1 ? 'critical' : d <= 7 ? 'high' : d <= 14 ? 'warning' : 'notice');
    for (const { cert: c, meta } of this.entries.values()) {
      const base = { certificate: c.id, subject: c.subjectText, label: meta.label };
      const days = (c.notAfter - now) / DAY;
      if (now < c.notBefore) out.push({ ...base, kind: 'not-yet-valid', severity: 'warning', daysLeft: undefined, message: `${c.subjectText} is not valid until ${new Date(c.notBefore).toISOString()}`, dedupeKey: `${c.id}:not-yet-valid` });
      else if (now > c.notAfter) out.push({ ...base, kind: 'expired', severity: 'critical', daysLeft: Math.floor(days), message: `${c.subjectText} expired ${Math.ceil(-days)} day(s) ago`, dedupeKey: `${c.id}:expired` });
      else {
        const bucket = this.thresholds.filter((t) => days <= t).pop();
        if (bucket !== undefined) out.push({ ...base, kind: 'expiring', severity: sev(bucket), daysLeft: Math.floor(days), message: `${c.subjectText} expires in ${Math.floor(days)} day(s)`, dedupeKey: `${c.id}:expiring:${bucket}` });
      }
      if (c.isCa) continue;
      if (now >= c.notBefore && now <= c.notAfter) {
        const ch = this.chain(c.id, now);
        if (!ch.trusted) {
          const first = ch.problems.find((p) => p.certificate !== c.id) ?? ch.problems[0];
          out.push({ ...base, kind: 'chain-broken', severity: 'high', daysLeft: undefined, message: first?.message ?? 'the chain does not reach a trusted root', dedupeKey: `${c.id}:chain-broken:${first?.code ?? 'unknown'}:${first?.certificate ?? ''}` });
        }
      }
      for (const h of meta.hosts ?? []) {
        if (!certificateCoversHost(c, h)) out.push({ ...base, kind: 'san-missing', severity: 'high', daysLeft: undefined, message: `${c.subjectText} does not cover ${h}`, dedupeKey: `${c.id}:san-missing:${h}` });
      }
      if (c.mustStaple && c.ocspUrls.length === 0) out.push({ ...base, kind: 'must-staple-unavailable', severity: 'critical', daysLeft: undefined, message: `${c.subjectText} demands a stapled OCSP response but names no OCSP responder`, dedupeKey: `${c.id}:must-staple-unavailable` });
    }
    const rank: Record<Severity, number> = { critical: 0, high: 1, warning: 2, notice: 3 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.dedupeKey.localeCompare(b.dedupeKey));
  }

  /** Remember the decoded fields of an OCSP response fetched for a stored certificate. */
  recordOcsp(id: string, r: OcspRecord): void {
    if (!this.entries.has(id)) throw new CertError('no such certificate in the store');
    if (!(r.nextUpdate > r.thisUpdate)) throw new CertError('an OCSP response must expire after it was produced');
    this.ocsp.set(id, r);
  }

  /** What to staple, what to refresh and when, for every non-CA certificate that has or needs OCSP. */
  staplingPlan(now: number): StaplingEntry[] {
    const out: StaplingEntry[] = [];
    for (const { cert: c } of this.entries.values()) {
      if (c.isCa) continue;
      const url = c.ocspUrls[0];
      const base = { certificate: c.id, subject: c.subjectText, ocspUrl: url, mustStaple: c.mustStaple };
      if (!url) {
        out.push({ ...base, state: 'not-available', refreshAt: undefined, risk: c.mustStaple ? 'critical' : 'none', advice: c.mustStaple ? 'the certificate requires stapling but names no OCSP responder; reissue it' : 'no OCSP responder named; nothing to staple' });
        continue;
      }
      const r = this.ocsp.get(c.id);
      if (!r) {
        out.push({ ...base, state: 'no-response', refreshAt: now, risk: c.mustStaple ? 'critical' : 'warning', advice: `fetch an OCSP response from ${url} now` });
      } else if (r.status === 'revoked') {
        out.push({ ...base, state: 'revoked', refreshAt: undefined, risk: 'critical', advice: 'the certificate is revoked; replace it' });
      } else if (now >= r.nextUpdate) {
        out.push({ ...base, state: 'stale', refreshAt: now, risk: c.mustStaple ? 'critical' : 'high', advice: 'the stapled response has expired; fetch a new one now' });
      } else {
        const refreshAt = r.thisUpdate + (r.nextUpdate - r.thisUpdate) / 2;
        if (now >= refreshAt) out.push({ ...base, state: 'refresh-due', refreshAt, risk: c.mustStaple ? 'high' : 'warning', advice: 'more than half of the response lifetime has passed; refresh it' });
        else out.push({ ...base, state: 'fresh', refreshAt, risk: 'none', advice: r.status === 'unknown' ? 'the responder says unknown; staple but investigate' : 'staple the current response' });
      }
    }
    const rank: Record<string, number> = { critical: 0, high: 1, warning: 2, notice: 3, none: 4 };
    return out.sort((a, b) => rank[a.risk]! - rank[b.risk]! || a.subject.localeCompare(b.subject));
  }
}
