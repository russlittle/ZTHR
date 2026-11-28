/**
 * Signing and verifying PDFs the way PAdES baseline (ETSI EN 319 142-1, level B-B) and ISO 32000 describe it.
 *
 * Signing appends an incremental update to the document: a signature dictionary (SubFilter ETSI.CAdES.detached)
 * with a fixed-size /Contents placeholder and a /ByteRange, a signature field and widget on a page (visible, with
 * an appearance stream, or invisible), and the page, catalog or AcroForm changes that connect them; earlier bytes
 * are never touched, so earlier signatures stay valid. The digest is taken over the byte ranges that surround the
 * placeholder and placed in a CMS SignedData (RFC 5652, DER) with the signed attributes PAdES needs: content type,
 * message digest, signing time and ESS signing-certificate-v2 (RFC 5035) binding the signature to one certificate.
 * RSA PKCS#1 v1.5 and ECDSA (P-256, P-384, P-521) with SHA-256, SHA-384 or SHA-512 are signed and verified. The
 * private key never has to be here: a Signer is anything that signs bytes (a key object, an HSM, a remote service),
 * and the prepare / finish pair splits the work so a service can sign the digest elsewhere.
 *
 * Verifying reads the signature fields from the AcroForm, checks that each /ByteRange is sound (starts at zero,
 * ascends without overlap, and the gap is exactly the /Contents hex string, so nothing can hide in it), recomputes
 * the digest, checks the CMS (one signer, detached, DER, signed attributes present, message digest equal, signature
 * valid under the certificate's key with an algorithm that fits the key type, signing certificate bound by ESS),
 * checks the certificate's validity at the claimed signing time and builds a chain to the trust anchors given.
 * The report says per signature what was proved: integrity, whether it covers the whole file or later bytes were
 * appended, who signed, and how far the certificate is trusted. SHA-1 and MD5 digests and RSA keys under 2048 bits
 * are refused, never "accepted with a warning".
 *
 * Out of scope: encrypted PDFs; PDFs whose catalog or page tree is only inside compressed object streams for the
 * part that must be rewritten (reading object streams and xref streams is supported); RSA-PSS and EdDSA; revocation
 * checking, time-stamps and long-term validation (PAdES B-T and above); certification signatures (DocMDP) and
 * checking which later changes are permitted. Cryptographic primitives and X.509 parsing come from node:crypto; the
 * PDF reader, DER codec and CMS are here. The clock is always an argument.
 */
import { X509Certificate, createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export class PdfSignError extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ================================================================ DER

export interface Der {
  /** The whole encoding, tag and length included. */
  readonly raw: Uint8Array;
  readonly tag: number;
  readonly content: Uint8Array;
  /** Parsed children when the tag is constructed. */
  readonly children: readonly Der[];
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const lengthBytes = (n: number): Uint8Array => {
  if (n < 0x80) return Uint8Array.of(n);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
  return Uint8Array.of(0x80 | b.length, ...b);
};

/** One DER element. */
export const tlv = (tag: number, ...content: readonly Uint8Array[]): Uint8Array => {
  const body = concat(content);
  return concat([Uint8Array.of(tag), lengthBytes(body.length), body]);
};

const cmp = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

export const seq = (...items: readonly Uint8Array[]) => tlv(0x30, ...items);
/** SET OF, with the members in the order DER requires (by their encodings). */
export const setOf = (...items: readonly Uint8Array[]) => tlv(0x31, ...[...items].sort(cmp));
export const octets = (b: Uint8Array) => tlv(0x04, b);
export const nul = () => Uint8Array.of(0x05, 0x00);
export const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
export const ctx = (n: number, ...content: readonly Uint8Array[]) => tlv(0xa0 | n, ...content);

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0) || parts[0]! > 2 || (parts[0]! < 2 && parts[1]! > 39)) throw new PdfSignError(`${dotted} is not an object identifier`);
  const body: number[] = [];
  const enc = (n: number) => {
    const chunk = [n % 128];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v % 128) | 0x80);
    body.push(...chunk);
  };
  enc(parts[0]! * 40 + parts[1]!);
  for (const p of parts.slice(2)) enc(p);
  return tlv(0x06, Uint8Array.from(body));
}

export function oidOf(d: Der): string {
  if (d.tag !== 0x06 || !d.content.length) throw new PdfSignError('expected an object identifier');
  const out: number[] = [];
  let v = 0;
  for (const [i, b] of d.content.entries()) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      if (out.length === 0) out.push(Math.min(2, Math.floor(v / 40)), v - Math.min(2, Math.floor(v / 40)) * 40);
      else out.push(v);
      v = 0;
    } else if (i === d.content.length - 1) throw new PdfSignError('object identifier is cut short');
  }
  return out.join('.');
}

/** A non-negative INTEGER from a number, bigint or big-endian bytes, with the minimal encoding DER requires. */
export function integer(v: number | bigint | Uint8Array): Uint8Array {
  let b: Uint8Array;
  if (typeof v === 'number' || typeof v === 'bigint') {
    let n = BigInt(v);
    if (n < 0n) throw new PdfSignError('only non-negative integers are written');
    const bytes: number[] = [];
    do {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    } while (n > 0n);
    b = Uint8Array.from(bytes);
  } else {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    b = v.subarray(i);
  }
  return tlv(0x02, b[0]! & 0x80 ? concat([Uint8Array.of(0), b]) : b);
}

const asciiTime = (d: Date): string => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
export const utcTime = (d: Date) => {
  const y = d.getUTCFullYear();
  if (y < 1950 || y > 2049) return tlv(0x18, new TextEncoder().encode(`${asciiTime(d)}Z`));
  return tlv(0x17, new TextEncoder().encode(`${asciiTime(d).slice(2)}Z`));
};

const MAX_DEPTH = 24;

/** Parses one DER element at the start of `buf`; returns it and the number of bytes used. Indefinite lengths, high tag numbers and non-minimal lengths are refused. */
export function parseDer(buf: Uint8Array, depth = 0): { node: Der; used: number } {
  if (depth > MAX_DEPTH) throw new PdfSignError('DER is nested too deeply');
  if (buf.length < 2) throw new PdfSignError('DER is cut short');
  const tag = buf[0]!;
  if ((tag & 0x1f) === 0x1f) throw new PdfSignError('DER tags above 30 are not used here');
  let len = buf[1]!;
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new PdfSignError('indefinite lengths are not DER');
    if (n > 4 || buf.length < 2 + n) throw new PdfSignError('DER length is not usable');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[2 + i]!;
    if (len < 0x80 || buf[2] === 0) throw new PdfSignError('DER length is not minimal');
    head = 2 + n;
  }
  if (head + len > buf.length) throw new PdfSignError('DER is cut short');
  const content = buf.subarray(head, head + len);
  const children: Der[] = [];
  if (tag & 0x20) {
    let p = 0;
    while (p < content.length) {
      const c = parseDer(content.subarray(p), depth + 1);
      children.push(c.node);
      p += c.used;
    }
  }
  return { node: { raw: buf.subarray(0, head + len), tag, content, children }, used: head + len };
}

/** A whole buffer that is one DER element, optionally followed by zero padding (as in a PDF /Contents placeholder). */
export function parseDerPadded(buf: Uint8Array): Der {
  const { node, used } = parseDer(buf);
  for (let i = used; i < buf.length; i++) if (buf[i] !== 0) throw new PdfSignError('there are bytes after the end of the signature');
  return node;
}

// ================================================================ PDF objects

export interface PdfName { readonly kind: 'name'; readonly value: string }
export interface PdfRef { readonly kind: 'ref'; readonly num: number; readonly gen: number }
export interface PdfString { readonly kind: 'string'; readonly bytes: Uint8Array }
export interface PdfDict { readonly kind: 'dict'; readonly entries: Map<string, PdfObj> }
export type PdfObj = null | boolean | number | PdfName | PdfRef | PdfString | PdfObj[] | PdfDict;

export const name = (value: string): PdfName => ({ kind: 'name', value });
export const ref = (num: number, gen = 0): PdfRef => ({ kind: 'ref', num, gen });
export const dict = (o: Record<string, PdfObj>): PdfDict => ({ kind: 'dict', entries: new Map(Object.entries(o)) });
const isDict = (o: PdfObj | undefined): o is PdfDict => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'dict';
const isRef = (o: PdfObj | undefined): o is PdfRef => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'ref';
const isName = (o: PdfObj | undefined): o is PdfName => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'name';
const isString = (o: PdfObj | undefined): o is PdfString => typeof o === 'object' && o !== null && !Array.isArray(o) && o.kind === 'string';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

class Lexer {
  pos: number;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array, pos = 0) {
    this.b = b;
    this.pos = pos;
  }
  skip(): void {
    for (;;) {
      while (this.pos < this.b.length && WS.has(this.b[this.pos]!)) this.pos++;
      if (this.b[this.pos] === 0x25) while (this.pos < this.b.length && this.b[this.pos] !== 10 && this.b[this.pos] !== 13) this.pos++;
      else return;
    }
  }
  word(): string {
    this.skip();
    const s = this.pos;
    while (this.pos < this.b.length && isRegular(this.b[this.pos]!)) this.pos++;
    return latin1(this.b.subarray(s, this.pos));
  }
  peekWord(): string {
    const p = this.pos;
    const w = this.word();
    this.pos = p;
    return w;
  }
  object(depth = 0): PdfObj {
    if (depth > 32) throw new PdfSignError('PDF objects are nested too deeply');
    this.skip();
    const c = this.b[this.pos];
    if (c === undefined) throw new PdfSignError('the PDF ends in the middle of an object');
    if (c === 0x2f) {
      this.pos++;
      const s = this.pos;
      while (this.pos < this.b.length && isRegular(this.b[this.pos]!)) this.pos++;
      return name(latin1(this.b.subarray(s, this.pos)).replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c && this.b[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const entries = new Map<string, PdfObj>();
      for (;;) {
        this.skip();
        if (this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { kind: 'dict', entries };
        }
        const k = this.object(depth + 1);
        if (!isName(k)) throw new PdfSignError('a PDF dictionary key is not a name');
        entries.set(k.value, this.object(depth + 1));
      }
    }
    if (c === 0x3c) {
      const end = this.b.indexOf(0x3e, this.pos);
      if (end < 0) throw new PdfSignError('a hex string is not closed');
      const hex = latin1(this.b.subarray(this.pos + 1, end)).replace(/\s+/g, '');
      if (!/^[0-9A-Fa-f]*$/.test(hex)) throw new PdfSignError('a hex string has other characters in it');
      this.pos = end + 1;
      return { kind: 'string', bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex') };
    }
    if (c === 0x5b) {
      this.pos++;
      const out: PdfObj[] = [];
      for (;;) {
        this.skip();
        if (this.b[this.pos] === 0x5d) {
          this.pos++;
          return out;
        }
        out.push(this.object(depth + 1));
      }
    }
    const w = this.word();
    if (!w) throw new PdfSignError(`unexpected "${String.fromCharCode(c)}" in a PDF object`);
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      if (/^\d+$/.test(w)) {
        const save = this.pos;
        const g = this.word();
        if (/^\d+$/.test(g) && this.word() === 'R') return ref(n, Number(g));
        this.pos = save;
      }
      return n;
    }
    throw new PdfSignError(`"${w.slice(0, 20)}" is not a PDF object`);
  }
  private literal(): PdfString {
    const out: number[] = [];
    let depthP = 0;
    this.pos++;
    for (;;) {
      const c = this.b[this.pos++];
      if (c === undefined) throw new PdfSignError('a string is not closed');
      if (c === 0x5c) {
        const n = this.b[this.pos++];
        if (n === undefined) throw new PdfSignError('a string is not closed');
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
        if (n in map) out.push(map[n]!);
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let i = 0; i < 2 && this.b[this.pos]! >= 0x30 && this.b[this.pos]! <= 0x37; i++) v = v * 8 + this.b[this.pos++]! - 0x30;
          out.push(v & 0xff);
        } else if (n === 13) {
          if (this.b[this.pos] === 10) this.pos++;
        } else if (n !== 10) out.push(n);
      } else if (c === 0x28) {
        depthP++;
        out.push(c);
      } else if (c === 0x29) {
        if (depthP === 0) return { kind: 'string', bytes: Uint8Array.from(out) };
        depthP--;
        out.push(c);
      } else out.push(c);
    }
  }
}

const escapeLiteral = (b: Uint8Array): string => latin1(b).replace(/[\\()\r]/g, (c) => (c === '\r' ? '\\r' : `\\${c}`));

/** PDF text string: plain ASCII as a literal, anything else as UTF-16BE with a byte order mark in hex. */
export function textString(s: string): PdfString {
  if (/^[\x20-\x7e]*$/.test(s)) return { kind: 'string', bytes: Buffer.from(s, 'latin1') };
  const u = Buffer.from(s, 'utf16le');
  u.swap16();
  return { kind: 'string', bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), u]) };
}

/** The text of a PDF text string (PDFDocEncoding is read as Latin-1). */
export function textOf(o: PdfObj | undefined): string | null {
  if (!isString(o)) return null;
  const b = Buffer.from(o.bytes);
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  return b.toString('latin1');
}

export function serialize(o: PdfObj): string {
  if (o === null) return 'null';
  if (typeof o === 'boolean') return String(o);
  if (typeof o === 'number') {
    if (!Number.isFinite(o)) throw new PdfSignError('a PDF number must be finite');
    return Number.isInteger(o) ? String(o) : String(Math.round(o * 1e4) / 1e4);
  }
  if (Array.isArray(o)) return `[${o.map(serialize).join(' ')}]`;
  switch (o.kind) {
    case 'name':
      return `/${o.value.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
    case 'ref':
      return `${o.num} ${o.gen} R`;
    case 'string':
      return o.bytes.some((c) => c < 0x20 || c > 0x7e) ? `<${Buffer.from(o.bytes).toString('hex').toUpperCase()}>` : `(${escapeLiteral(o.bytes)})`;
    case 'dict':
      return `<<${[...o.entries].map(([k, v]) => `${serialize(name(k))} ${serialize(v)}`).join(' ')}>>`;
  }
}

// ================================================================ document structure

interface XrefEntry {
  readonly type: 1 | 2;
  /** Offset (type 1) or the number of the object stream (type 2). */
  readonly a: number;
  /** Generation (type 1) or the index within the object stream (type 2). */
  readonly b: number;
}

export interface Doc {
  readonly bytes: Uint8Array;
  readonly entries: ReadonlyMap<number, XrefEntry>;
  readonly trailer: PdfDict;
  readonly lastXref: number;
  readonly usesXrefStream: boolean;
  get(num: number): PdfObj;
  resolve(o: PdfObj | undefined): PdfObj;
}

const MAX_INFLATE = 64 * 1024 * 1024;

function unpredict(data: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  const predictor = Number(parms?.entries.get('Predictor') ?? 1);
  if (predictor < 10) {
    if (predictor !== 1) throw new PdfSignError('this stream uses a predictor that is not supported');
    return data;
  }
  const columns = Number(parms?.entries.get('Columns') ?? 1);
  const colors = Number(parms?.entries.get('Colors') ?? 1);
  const bpc = Number(parms?.entries.get('BitsPerComponent') ?? 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  if (!(rowLen > 0) || !Number.isFinite(rowLen)) throw new PdfSignError('a stream predictor has impossible parameters');
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (rowLen + 1)]!;
    for (let i = 0; i < rowLen; i++) {
      const x = data[r * (rowLen + 1) + 1 + i]!;
      const a = i >= bpp ? out[r * rowLen + i - bpp]! : 0;
      const b = r > 0 ? out[(r - 1) * rowLen + i]! : 0;
      const c = r > 0 && i >= bpp ? out[(r - 1) * rowLen + i - bpp]! : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new PdfSignError('a stream row has an unknown predictor');
      out[r * rowLen + i] = v & 0xff;
    }
  }
  return out;
}

function streamData(bytes: Uint8Array, d: PdfDict, start: number, doc?: { resolve(o: PdfObj | undefined): PdfObj }): Uint8Array {
  let len = d.entries.get('Length');
  if (doc) len = doc.resolve(len);
  let raw: Uint8Array;
  if (typeof len === 'number' && len >= 0 && start + len <= bytes.length && /^\s*endstream/.test(latin1(bytes.subarray(start + len, start + len + 16)))) raw = bytes.subarray(start, start + len);
  else {
    const end = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf('endstream', start, 'latin1');
    if (end < 0) throw new PdfSignError('a stream has no end');
    raw = bytes.subarray(start, end);
  }
  let filter = d.entries.get('Filter');
  if (Array.isArray(filter)) {
    if (filter.length > 1) throw new PdfSignError('stacked stream filters are not supported');
    filter = filter[0];
  }
  if (filter === undefined) return raw;
  if (!isName(filter) || (filter.value !== 'FlateDecode' && filter.value !== 'Fl')) throw new PdfSignError('only Flate-compressed streams are read');
  let parms = d.entries.get('DecodeParms');
  if (Array.isArray(parms)) parms = parms[0];
  try {
    return unpredict(inflateSync(raw, { maxOutputLength: MAX_INFLATE }), isDict(parms) ? parms : undefined);
  } catch (e) {
    if (e instanceof PdfSignError) throw e;
    throw new PdfSignError('a compressed stream is damaged or too large');
  }
}

function indirectAt(bytes: Uint8Array, offset: number): { num: number; gen: number; lex: Lexer } {
  if (!(offset >= 0 && offset < bytes.length)) throw new PdfSignError('an offset points outside the file');
  const lex = new Lexer(bytes, offset);
  const n = lex.word();
  const g = lex.word();
  if (!/^\d+$/.test(n) || !/^\d+$/.test(g) || lex.word() !== 'obj') throw new PdfSignError(`no object where the cross-reference says at ${offset}`);
  return { num: Number(n), gen: Number(g), lex };
}

export function readDoc(bytes: Uint8Array): Doc {
  if (bytes.length < 20 || latin1(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new PdfSignError('that is not a PDF');
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const sx = tail.lastIndexOf('startxref');
  const m = sx < 0 ? null : /^startxref\s+(\d{1,12})/.exec(tail.slice(sx));
  if (!m) throw new PdfSignError('the PDF has no startxref');
  const lastXref = Number(m[1]);
  const entries = new Map<number, XrefEntry>();
  let trailer: PdfDict | null = null;
  let usesXrefStream = false;
  const seen = new Set<number>();
  const load = (offset: number, first: boolean): number | null => {
    if (seen.has(offset) || seen.size > 1000) throw new PdfSignError('the cross-reference sections loop');
    seen.add(offset);
    const lex = new Lexer(bytes, offset);
    let t: PdfDict;
    if (lex.peekWord() === 'xref') {
      lex.word();
      for (;;) {
        if (lex.peekWord() === 'trailer') break;
        const s = Number(lex.word());
        const c = Number(lex.word());
        if (!Number.isInteger(s) || !Number.isInteger(c) || c < 0 || c > 10_000_000) throw new PdfSignError('a cross-reference subsection is not valid');
        for (let i = 0; i < c; i++) {
          const off = lex.word();
          const gen = lex.word();
          const kind = lex.word();
          if (!/^\d{10}$/.test(off) || !/^\d{5}$/.test(gen) || (kind !== 'n' && kind !== 'f')) throw new PdfSignError('a cross-reference entry is not valid');
          if (kind === 'n' && !entries.has(s + i)) entries.set(s + i, { type: 1, a: Number(off), b: Number(gen) });
          else if (kind === 'f' && !entries.has(s + i)) entries.set(s + i, { type: 1, a: -1, b: Number(gen) });
        }
      }
      lex.word();
      const o = lex.object();
      if (!isDict(o)) throw new PdfSignError('the trailer is not a dictionary');
      t = o;
      const hybrid = t.entries.get('XRefStm');
      if (typeof hybrid === 'number' && !seen.has(hybrid)) load(hybrid, false);
    } else {
      const { lex: l2 } = indirectAt(bytes, offset);
      const o = l2.object();
      if (!isDict(o) || !isName(o.entries.get('Type')) || (o.entries.get('Type') as PdfName).value !== 'XRef') throw new PdfSignError('the cross-reference is neither a table nor a stream');
      if (first) usesXrefStream = true;
      if (l2.word() !== 'stream') throw new PdfSignError('a cross-reference stream has no data');
      let p = l2.pos;
      if (bytes[p] === 13) p++;
      if (bytes[p] === 10) p++;
      const data = streamData(bytes, o, p);
      const w = (o.entries.get('W') as PdfObj[] | undefined) ?? [];
      if (w.length !== 3 || w.some((x) => typeof x !== 'number' || x < 0 || x > 8)) throw new PdfSignError('a cross-reference stream has bad field widths');
      const [w0, w1, w2] = w as [number, number, number];
      const size = Number(o.entries.get('Size'));
      const index = (o.entries.get('Index') as number[] | undefined) ?? [0, size];
      const rec = w0 + w1 + w2;
      let q = 0;
      const num = (n: number) => {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + data[q++]!;
        return v;
      };
      for (let i = 0; i + 1 < index.length; i += 2) {
        for (let k = 0; k < index[i + 1]!; k++) {
          if (q + rec > data.length) throw new PdfSignError('a cross-reference stream is cut short');
          const type = w0 === 0 ? 1 : num(w0);
          const a = num(w1);
          const b = num(w2);
          const n = index[i]! + k;
          if (entries.has(n)) continue;
          if (type === 1) entries.set(n, { type: 1, a, b });
          else if (type === 2) entries.set(n, { type: 2, a, b });
          else entries.set(n, { type: 1, a: -1, b });
        }
      }
      t = o;
    }
    if (first) trailer = t;
    const prev = t.entries.get('Prev');
    return typeof prev === 'number' ? prev : null;
  };
  let next: number | null = lastXref;
  let first = true;
  while (next !== null) {
    next = load(next, first);
    first = false;
  }
  if (!trailer) throw new PdfSignError('the PDF has no trailer');
  const tr: PdfDict = trailer;
  if (tr.entries.has('Encrypt')) throw new PdfSignError('encrypted PDFs are not supported');
  if (!isRef(tr.entries.get('Root'))) throw new PdfSignError('the PDF has no document catalog');

  const cache = new Map<number, PdfObj>();
  const objstm = new Map<number, { objs: Map<number, PdfObj> }>();
  const doc: Doc = {
    bytes,
    entries,
    trailer: tr,
    lastXref,
    usesXrefStream,
    get(num: number): PdfObj {
      if (cache.has(num)) return cache.get(num)!;
      const e = entries.get(num);
      let v: PdfObj = null;
      if (e && e.type === 1 && e.a >= 0) {
        const at = indirectAt(bytes, e.a);
        if (at.num !== num) throw new PdfSignError(`object ${num} is not where the cross-reference says`);
        v = at.lex.object();
      } else if (e && e.type === 2) {
        if (!objstm.has(e.a)) {
          const holder = doc.get(e.a);
          const pos = entries.get(e.a);
          if (!isDict(holder) || !pos || pos.type !== 1) throw new PdfSignError(`object stream ${e.a} is missing`);
          const lex = indirectAt(bytes, pos.a).lex;
          lex.object();
          if (lex.word() !== 'stream') throw new PdfSignError('an object stream has no data');
          let p = lex.pos;
          if (bytes[p] === 13) p++;
          if (bytes[p] === 10) p++;
          const data = streamData(bytes, holder, p, doc);
          const n = Number(doc.resolve(holder.entries.get('N')));
          const firstOff = Number(doc.resolve(holder.entries.get('First')));
          if (!(n >= 0 && n <= 1_000_000) || !(firstOff >= 0)) throw new PdfSignError('an object stream header is not valid');
          const hl = new Lexer(data, 0);
          const pairs: [number, number][] = [];
          for (let i = 0; i < n; i++) pairs.push([Number(hl.word()), Number(hl.word())]);
          const objs = new Map<number, PdfObj>();
          for (const [on, off] of pairs) objs.set(on, new Lexer(data, firstOff + off).object());
          objstm.set(e.a, { objs });
        }
        v = objstm.get(e.a)!.objs.get(num) ?? null;
      }
      cache.set(num, v);
      return v;
    },
    resolve(o: PdfObj | undefined): PdfObj {
      let cur: PdfObj = o ?? null;
      for (let i = 0; i < 16 && isRef(cur); i++) cur = doc.get(cur.num);
      return cur;
    },
  };
  return doc;
}

/** The page objects in order, from the page tree (cycles and absurd depth refused). */
export function pageRefs(doc: Doc): PdfRef[] {
  const root = doc.resolve(doc.trailer.entries.get('Root'));
  if (!isDict(root)) throw new PdfSignError('the document catalog is not a dictionary');
  const out: PdfRef[] = [];
  const seen = new Set<number>();
  const walk = (r: PdfObj | undefined, depth: number) => {
    if (!isRef(r) || seen.has(r.num) || depth > 32 || out.length > 100_000) return;
    seen.add(r.num);
    const d = doc.get(r.num);
    if (!isDict(d)) return;
    const kids = doc.resolve(d.entries.get('Kids'));
    if (Array.isArray(kids)) kids.forEach((k) => walk(k, depth + 1));
    else out.push(r);
  };
  walk(root.entries.get('Pages'), 0);
  return out;
}

// ================================================================ signing

export type HashName = 'sha256' | 'sha384' | 'sha512';

const HASH_OID: Readonly<Record<HashName, string>> = { sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3' };
const OID_HASH: Readonly<Record<string, HashName | 'sha1' | 'md5'>> = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1', '1.2.840.113549.2.5': 'md5' };
const RSA_SIG_OID: Readonly<Record<HashName, string>> = { sha256: '1.2.840.113549.1.1.11', sha384: '1.2.840.113549.1.1.12', sha512: '1.2.840.113549.1.1.13' };
const EC_SIG_OID: Readonly<Record<HashName, string>> = { sha256: '1.2.840.10045.4.3.2', sha384: '1.2.840.10045.4.3.3', sha512: '1.2.840.10045.4.3.4' };
const OID = { data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5', signingCertV1: '1.2.840.113549.1.9.16.2.12', signingCertV2: '1.2.840.113549.1.9.16.2.47', rsaEncryption: '1.2.840.113549.1.1.1' };

/** Anything that can sign: a key in memory, a hardware module, a remote service. */
export interface Signer {
  /** The signer's certificate, DER. */
  readonly certificate: Uint8Array;
  /** Intermediate certificates to embed, DER. */
  readonly chain?: readonly Uint8Array[];
  readonly algorithm: 'rsa' | 'ecdsa';
  /** Signs `data` with the key; RSA PKCS#1 v1.5 or DER-encoded ECDSA, over the hash named. */
  sign(data: Uint8Array, hash: HashName): Uint8Array;
}

export function keySigner(privateKey: KeyObject, certificate: Uint8Array, chain: readonly Uint8Array[] = []): Signer {
  const t = privateKey.asymmetricKeyType;
  if (t !== 'rsa' && t !== 'ec') throw new PdfSignError('only RSA and ECDSA keys sign PDFs here');
  return { certificate, chain, algorithm: t === 'rsa' ? 'rsa' : 'ecdsa', sign: (data, hash) => cryptoSign(hash, data, privateKey) };
}

const digestOf = (hash: HashName | 'sha1', ...parts: Uint8Array[]): Buffer => {
  const h = createHash(hash);
  for (const p of parts) h.update(p);
  return h.digest();
};

const algId = (o: string) => seq(oid(o), nul());
const attr = (o: string, ...values: Uint8Array[]) => seq(oid(o), setOf(...values));

export interface CmsParts {
  readonly signedAttributes: Uint8Array;
  /** Builds the final CMS once the signature over `signedAttributes` is known. */
  finish(signature: Uint8Array): Uint8Array;
}

/** The signed attributes (what the signature covers, DER, tagged as a SET) and the means to complete the CMS. */
export function cmsParts(signer: Pick<Signer, 'certificate' | 'chain' | 'algorithm'>, messageDigest: Uint8Array, hash: HashName, signingTime: Date): CmsParts {
  const cert = new X509Certificate(Buffer.from(signer.certificate));
  const certDer = parseDer(signer.certificate).node;
  // TBSCertificate: [0] version (optional), serialNumber, signature, issuer, ...
  const tbs = certDer.children[0]!;
  const t = tbs.children[0]!.tag === 0xa0 ? 1 : 0;
  const serial = tbs.children[t]!.raw;
  const issuer = tbs.children[t + 2]!.raw;
  const attrs = [
    attr(OID.contentType, oid(OID.data)),
    attr(OID.signingTime, utcTime(signingTime)),
    attr(OID.messageDigest, octets(messageDigest)),
    attr(OID.signingCertV2, seq(seq(seq(octets(digestOf('sha256', cert.raw)))))),
  ];
  const signedSet = setOf(...attrs);
  const sigOid = signer.algorithm === 'rsa' ? RSA_SIG_OID[hash] : EC_SIG_OID[hash];
  return {
    signedAttributes: signedSet,
    finish(signature: Uint8Array): Uint8Array {
      const signerInfo = seq(
        integer(1),
        seq(issuer, serial),
        algId(HASH_OID[hash]),
        concat([Uint8Array.of(0xa0), signedSet.subarray(1)]),
        signer.algorithm === 'rsa' ? algId(sigOid) : seq(oid(sigOid)),
        octets(signature),
      );
      const certs = [signer.certificate, ...(signer.chain ?? [])];
      const signedData = seq(integer(1), setOf(algId(HASH_OID[hash])), seq(oid(OID.data)), ctx(0, ...certs), setOf(signerInfo));
      return seq(oid(OID.signedData), ctx(0, signedData));
    },
  };
}

const BYTERANGE_PLACEHOLDER = '0000000000';

export interface Appearance {
  /** Zero-based page; the first by default. */
  readonly page?: number;
  /** Lower-left and upper-right corners in points. */
  readonly rect: readonly [number, number, number, number];
  /** Text lines; by default who signed, when, and why. */
  readonly lines?: readonly string[];
}

export interface SignOptions {
  readonly signer: Signer;
  readonly signingTime: Date;
  readonly hash?: HashName;
  readonly fieldName?: string;
  readonly reason?: string;
  readonly location?: string;
  readonly contactInfo?: string;
  readonly name?: string;
  /** Without an appearance the signature is invisible. */
  readonly appearance?: Appearance;
  /** Bytes reserved for the CMS; the default fits a certificate chain of a few certificates. */
  readonly reserve?: number;
}

export interface Prepared {
  /** The document with the update appended and the signature still zeros. */
  readonly pdf: Uint8Array;
  readonly byteRange: readonly [number, number, number, number];
  readonly contentsStart: number;
  readonly contentsEnd: number;
  readonly reserve: number;
  readonly fieldName: string;
}

const pdfDate = (d: Date) => `D:${asciiTime(d)}Z`;
const hexOf = (n: number, width: number) => String(n).padStart(width, '0');

function appearanceStream(a: Appearance, lines: readonly string[]): { dict: PdfDict; body: string } {
  const [x1, y1, x2, y2] = a.rect;
  const w = x2 - x1;
  const h = y2 - y1;
  const size = Math.max(5, Math.min(10, (h - 6) / Math.max(1, lines.length) / 1.25));
  const ops = [`q 0.96 0.97 1 rg 0 0 ${w} ${h} re f Q`, `q 0.2 0.3 0.6 RG 0.75 w 0.375 0.375 ${w - 0.75} ${h - 0.75} re S Q`];
  lines.forEach((l, i) => {
    const t = Buffer.from(l.normalize('NFC').replace(/[^\x20-\x7e]/g, '?'), 'latin1');
    ops.push(`BT /F1 ${size.toFixed(2)} Tf 0.1 0.1 0.3 rg 4 ${(h - 4 - size * (i + 1) * 1.2).toFixed(2)} Td (${escapeLiteral(t)}) Tj ET`);
  });
  const body = ops.join('\n');
  return {
    body,
    dict: dict({ Type: name('XObject'), Subtype: name('Form'), BBox: [0, 0, w, h], Resources: dict({ Font: dict({ F1: dict({ Type: name('Font'), Subtype: name('Type1'), BaseFont: name('Helvetica'), Encoding: name('WinAnsiEncoding') }) }) }), Length: Buffer.byteLength(body, 'latin1') }),
  };
}

/** The common name in a certificate's subject, read from the DER itself (node's text form escapes backslashes). */
function nameOf(c: X509Certificate): string {
  const tbs = parseDer(c.raw).node.children[0]!;
  const i = tbs.children[0]!.tag === 0xa0 ? 1 : 0;
  for (const rdn of tbs.children[i + 4]!.children) {
    for (const atv of rdn.children) {
      if (atv.children.length === 2 && oidOf(atv.children[0]!) === '2.5.4.3') {
        const v = atv.children[1]!;
        return v.tag === 0x1e ? Buffer.from(v.content).swap16().toString('utf16le') : Buffer.from(v.content).toString(v.tag === 0x0c ? 'utf8' : 'latin1');
      }
    }
  }
  return c.subject.replace(/\n/g, ', ');
}

/** Appends the signature update with an empty signature. Nothing earlier in the file changes. */
export function prepareSignature(input: Uint8Array, o: SignOptions): Prepared {
  const doc = readDoc(input);
  const reserve = o.reserve ?? 12_288;
  if (!Number.isInteger(reserve) || reserve < 512 || reserve > 1_000_000) throw new PdfSignError('reserve is from 512 to 1000000 bytes');
  const rootRef = doc.trailer.entries.get('Root') as PdfRef;
  const catalog = doc.get(rootRef.num);
  if (!isDict(catalog)) throw new PdfSignError('the document catalog is not a dictionary');
  const pages = pageRefs(doc);
  const pageIndex = o.appearance?.page ?? 0;
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) throw new PdfSignError(`the document has ${pages.length} page(s); there is no page ${pageIndex + 1}`);
  const pageRef = pages[pageIndex]!;
  const page = doc.get(pageRef.num) as PdfDict;

  const size = Number(doc.trailer.entries.get('Size'));
  const maxNum = Math.max(size, ...doc.entries.keys()) + 1;
  const sigNum = maxNum;
  const widgetNum = maxNum + 1;
  const apNum = maxNum + 2;
  const visible = o.appearance !== undefined;

  // The AcroForm and its existing field names.
  const acroRaw = catalog.entries.get('AcroForm');
  const acro = doc.resolve(acroRaw);
  const acroDict = isDict(acro) ? new Map(acro.entries) : new Map<string, PdfObj>();
  const fieldsRaw = doc.resolve(acroDict.get('Fields'));
  const fields: PdfObj[] = Array.isArray(fieldsRaw) ? [...fieldsRaw] : [];
  const taken = new Set<string>();
  for (const f of fields) {
    const fd = doc.resolve(f);
    const t = isDict(fd) ? textOf(fd.entries.get('T')) : null;
    if (t !== null) taken.add(t);
  }
  let fieldName = o.fieldName;
  if (fieldName === undefined) {
    let n = 1;
    while (taken.has(`Signature${n}`)) n++;
    fieldName = `Signature${n}`;
  } else if (taken.has(fieldName)) throw new PdfSignError(`a field named ${fieldName} already exists`);
  if (!fieldName || /[.\0]/.test(fieldName)) throw new PdfSignError('a field name is not empty and has no dots');

  const cert = new X509Certificate(Buffer.from(o.signer.certificate));
  const lines = o.appearance?.lines ?? [`Digitally signed by ${nameOf(cert)}`, `Date: ${o.signingTime.toISOString().replace('T', ' ').slice(0, 19)} UTC`, ...(o.reason ? [`Reason: ${o.reason}`] : [])];

  const sig: Record<string, PdfObj> = {
    Type: name('Sig'),
    Filter: name('Adobe.PPKLite'),
    SubFilter: name('ETSI.CAdES.detached'),
    ByteRange: [0, 0, 0, 0],
    Contents: { kind: 'string', bytes: new Uint8Array(0) },
    M: { kind: 'string', bytes: Buffer.from(pdfDate(o.signingTime), 'latin1') },
  };
  if (o.name) sig.Name = textString(o.name);
  if (o.reason) sig.Reason = textString(o.reason);
  if (o.location) sig.Location = textString(o.location);
  if (o.contactInfo) sig.ContactInfo = textString(o.contactInfo);

  const widget: Record<string, PdfObj> = {
    Type: name('Annot'), Subtype: name('Widget'), FT: name('Sig'), T: textString(fieldName), V: ref(sigNum), F: 132, P: ref(pageRef.num, pageRef.gen),
    Rect: visible ? [...o.appearance!.rect] : [0, 0, 0, 0],
  };
  const ap = visible ? appearanceStream(o.appearance!, lines) : null;
  if (ap) widget.AP = dict({ N: ref(apNum) });

  const annots = doc.resolve(page.entries.get('Annots'));
  const newPage = new Map(page.entries);
  newPage.set('Annots', [...(Array.isArray(annots) ? annots : []), ref(widgetNum)]);

  acroDict.set('Fields', [...fields, ref(widgetNum)]);
  const flags = Number(doc.resolve(acroDict.get('SigFlags')) ?? 0);
  acroDict.set('SigFlags', (Number.isFinite(flags) ? flags : 0) | 3);
  const newAcro: PdfDict = { kind: 'dict', entries: acroDict };

  const rewritten = new Map<number, PdfDict>();
  rewritten.set(pageRef.num, { kind: 'dict', entries: newPage });
  if (isRef(acroRaw)) rewritten.set(acroRaw.num, newAcro);
  else {
    const c = new Map(catalog.entries);
    c.set('AcroForm', newAcro);
    rewritten.set(rootRef.num, { kind: 'dict', entries: c });
  }

  // Assemble the update.
  const need = input[input.length - 1] === 10 || input[input.length - 1] === 13 ? '' : '\n';
  const parts: string[] = [need];
  let at = input.length + need.length;
  const offsets = new Map<number, number>();
  const emit = (num: number, gen: number, body: string) => {
    offsets.set(num, at);
    const s = `${num} ${gen} obj\n${body}\nendobj\n`;
    parts.push(s);
    at += Buffer.byteLength(s, 'latin1');
  };
  const sigBody = serialize({ kind: 'dict', entries: new Map(Object.entries(sig)) })
    .replace('/ByteRange [0 0 0 0]', `/ByteRange [0 ${BYTERANGE_PLACEHOLDER} ${BYTERANGE_PLACEHOLDER} ${BYTERANGE_PLACEHOLDER}]`)
    .replace('/Contents ()', `/Contents <${'0'.repeat(reserve * 2)}>`);
  if (!sigBody.includes('/Contents <0')) throw new PdfSignError('internal: the signature placeholder was not written');
  emit(sigNum, 0, sigBody);
  emit(widgetNum, 0, serialize({ kind: 'dict', entries: new Map(Object.entries(widget)) }));
  if (ap) emit(apNum, 0, `${serialize(ap.dict)}\nstream\n${ap.body}\nendstream`);
  for (const [num, d] of rewritten) emit(num, Number((doc.entries.get(num)?.type === 1 ? doc.entries.get(num)!.b : 0)), serialize(d));

  const total = Math.max(maxNum + (ap ? 3 : 2), size);
  const tr = doc.trailer.entries;
  const common: Record<string, PdfObj> = { Root: rootRef };
  for (const k of ['Info', 'ID']) if (tr.has(k)) common[k] = tr.get(k)!;
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  if (doc.usesXrefStream) {
    const xnum = total;
    const xoff = at;
    const all = [...nums, xnum];
    const rows: number[] = [];
    for (const n of all) rows.push(1, ...u32(n === xnum ? xoff : offsets.get(n)!), 0, 0);
    // Consecutive runs for /Index.
    const index: number[] = [];
    for (let i = 0; i < all.length; ) {
      let j = i;
      while (j + 1 < all.length && all[j + 1] === all[j]! + 1) j++;
      index.push(all[i]!, j - i + 1);
      i = j + 1;
    }
    const xd = dict({ Type: name('XRef'), Size: xnum + 1, W: [1, 4, 2], Index: index, Prev: doc.lastXref, Length: rows.length, ...common });
    parts.push(`${xnum} 0 obj\n${serialize(xd)}\nstream\n`);
    parts.push(Buffer.from(rows).toString('latin1'));
    parts.push(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`);
  } else {
    const xoff = at;
    let x = 'xref\n';
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
      x += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) x += `${hexOf(offsets.get(nums[k]!)!, 10)} ${hexOf(rewritten.has(nums[k]!) ? Number(doc.entries.get(nums[k]!)?.b ?? 0) : 0, 5)} n \n`;
      i = j + 1;
    }
    x += `trailer\n${serialize(dict({ Size: total, Prev: doc.lastXref, ...common }))}\nstartxref\n${xoff}\n%%EOF\n`;
    parts.push(x);
  }
  const out = concat([input, Buffer.from(parts.join(''), 'latin1')]);
  // Find the placeholder in the new bytes and fix the byte range.
  const base = input.length;
  const buf = Buffer.from(out.buffer, out.byteOffset, out.length);
  const sigAt = buf.indexOf(`${sigNum} 0 obj`, base, 'latin1');
  const open = buf.indexOf('/Contents <', sigAt, 'latin1') + '/Contents '.length;
  const close = open + 1 + reserve * 2 + 1;
  if (buf[close - 1] !== 0x3e) throw new PdfSignError('internal: the placeholder is not where it should be');
  const br: [number, number, number, number] = [0, open, close, out.length - close];
  const brAt = buf.indexOf('/ByteRange [', sigAt, 'latin1');
  const brText = `/ByteRange [0 ${hexOf(br[1], 10)} ${hexOf(br[2], 10)} ${hexOf(br[3], 10)}]`;
  buf.write(brText, brAt, 'latin1');
  return { pdf: out, byteRange: br, contentsStart: open, contentsEnd: close, reserve, fieldName };
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** The bytes the signature covers: everything but the /Contents value. */
export const signedBytes = (p: Pick<Prepared, 'pdf' | 'byteRange'>): Uint8Array => concat([p.pdf.subarray(p.byteRange[0], p.byteRange[0] + p.byteRange[1]), p.pdf.subarray(p.byteRange[2], p.byteRange[2] + p.byteRange[3])]);

/** Puts a finished CMS into the placeholder. */
export function embedSignature(p: Prepared, cms: Uint8Array): Uint8Array {
  if (cms.length > p.reserve) throw new PdfSignError(`the signature needs ${cms.length} bytes but ${p.reserve} were reserved; prepare again with a larger reserve`);
  const out = Uint8Array.from(p.pdf);
  Buffer.from(out.buffer, out.byteOffset, out.length).write(Buffer.from(cms).toString('hex').toUpperCase().padEnd(p.reserve * 2, '0'), p.contentsStart + 1, 'latin1');
  return out;
}

/** Signs a PDF in one step. */
export function signPdf(input: Uint8Array, o: SignOptions): Uint8Array {
  const hash = o.hash ?? 'sha256';
  const prepared = prepareSignature(input, o);
  const digest = digestOf(hash, signedBytes(prepared));
  const parts = cmsParts(o.signer, digest, hash, o.signingTime);
  return embedSignature(prepared, parts.finish(o.signer.sign(parts.signedAttributes, hash)));
}

// ================================================================ verification

export interface Signature {
  readonly field: string;
  readonly valid: boolean;
  /** The digest and signature check out, over a sound byte range. */
  readonly integrity: boolean;
  readonly coversWholeDocument: boolean;
  readonly bytesAfter: number;
  readonly signer: { readonly subject: string; readonly issuer: string; readonly serial: string; readonly fingerprint: string } | null;
  readonly signingTime: string | null;
  readonly reason: string | null;
  readonly location: string | null;
  readonly profile: 'PAdES-B-B' | 'CMS' | null;
  readonly trust: 'trusted' | 'self-signed' | 'untrusted' | 'unknown';
  readonly byteRange: readonly number[];
  readonly problems: readonly string[];
}

export interface Report {
  readonly signatures: readonly Signature[];
  readonly unsignedFields: readonly string[];
}

export interface VerifyOptions {
  /** Certificates (DER) trusted as roots. */
  readonly trustAnchors?: readonly Uint8Array[];
  readonly now: Date;
}

const toHashName = (h: string | undefined): HashName | null => (h === 'sha256' || h === 'sha384' || h === 'sha512' ? h : null);

interface FieldInfo {
  readonly name: string;
  readonly ft: string | null;
  readonly value: PdfObj;
}

/** The terminal fields of the AcroForm with their full names, their type and value inherited from parents as the standard says. */
function fieldsOf(doc: Doc): FieldInfo[] {
  const root = doc.resolve(doc.trailer.entries.get('Root'));
  const acro = isDict(root) ? doc.resolve(root.entries.get('AcroForm')) : null;
  if (!isDict(acro)) return [];
  const out: FieldInfo[] = [];
  const seen = new Set<number>();
  const walk = (o: PdfObj, prefix: string, ft: string | null, value: PdfObj, depth: number) => {
    if (depth > 16 || out.length > 10_000) return;
    if (isRef(o)) {
      if (seen.has(o.num)) return;
      seen.add(o.num);
    }
    const d = doc.resolve(o);
    if (!isDict(d)) return;
    const t = textOf(d.entries.get('T'));
    const full = t === null ? prefix : prefix ? `${prefix}.${t}` : t;
    const myFt = doc.resolve(d.entries.get('FT'));
    const nextFt = isName(myFt) ? myFt.value : ft;
    const myV = d.entries.has('V') ? doc.resolve(d.entries.get('V')) : value;
    const kids = doc.resolve(d.entries.get('Kids'));
    if (Array.isArray(kids) && kids.length) kids.forEach((k) => walk(k, full, nextFt, myV, depth + 1));
    else out.push({ name: full, ft: nextFt, value: myV });
  };
  const fields = doc.resolve(acro.entries.get('Fields'));
  if (Array.isArray(fields)) fields.forEach((f) => walk(f, '', null, null, 0));
  return out;
}

const fail = (field: string, byteRange: readonly number[], problems: string[], extra: Partial<Signature> = {}): Signature => ({
  field, valid: false, integrity: false, coversWholeDocument: false, bytesAfter: 0, signer: null, signingTime: null, reason: null, location: null, profile: null, trust: 'unknown', byteRange, problems, ...extra,
});

export function verifyPdf(input: Uint8Array, o: VerifyOptions): Report {
  const doc = readDoc(input);
  const signatures: Signature[] = [];
  const unsigned: string[] = [];
  const seenSig = new Set<string>();
  for (const f of fieldsOf(doc)) {
    if (f.ft !== 'Sig') continue;
    const v = doc.resolve(f.value);
    if (!isDict(v)) {
      if (!unsigned.includes(f.name)) unsigned.push(f.name);
      continue;
    }
    const key = `${f.name}`;
    if (seenSig.has(key)) continue;
    seenSig.add(key);
    signatures.push(verifyOne(input, f.name, v, o));
  }
  return { signatures, unsignedFields: unsigned };
}

function verifyOne(file: Uint8Array, field: string, v: PdfDict, o: VerifyOptions): Signature {
  const problems: string[] = [];
  const br = v.entries.get('ByteRange');
  const contents = v.entries.get('Contents');
  const reason = textOf(v.entries.get('Reason'));
  const location = textOf(v.entries.get('Location'));
  const sub = v.entries.get('SubFilter');
  const subName = isName(sub) ? sub.value : null;
  if (!Array.isArray(br) || br.length !== 4 || br.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > file.length)) return fail(field, [], ['the byte range is missing or not four whole numbers inside the file']);
  const range = br as number[];
  const [a, b, c, d] = range as [number, number, number, number];
  if (!isString(contents)) return fail(field, range, ['the signature has no contents']);
  if (a !== 0) problems.push('the byte range does not start at the start of the file');
  if (b < a || c < b + 2 || c + d > file.length) problems.push('the byte range overlaps itself or runs past the file');
  if (problems.length) return fail(field, range, problems);
  // The gap must be exactly the hex string that holds the signature, so nothing else can hide in it.
  const gap = latin1(file.subarray(b, c));
  if (!/^<[0-9A-Fa-f\s]*>$/.test(gap)) problems.push('the part left out of the signed bytes is more than the signature value');
  else if (Buffer.from(contents.bytes).toString('hex') !== gap.slice(1, -1).replace(/\s+/g, '').toLowerCase()) problems.push('the signature value is not the one in the gap');
  if (problems.length) return fail(field, range, problems);
  const bytesAfter = file.length - (c + d);
  const covered = concat([file.subarray(a, a + b), file.subarray(c, c + d)]);

  let cms: Der;
  try {
    cms = parseDerPadded(contents.bytes);
  } catch (e) {
    return fail(field, range, [`the signature is not readable: ${(e as Error).message}`], { bytesAfter, reason, location });
  }

  const info = readCms(cms, problems);
  if (!info) return fail(field, range, problems, { bytesAfter, reason, location });
  const cert = info.cert;
  const signer = { subject: cert.subject.replace(/\n/g, ', '), issuer: cert.issuer.replace(/\n/g, ', '), serial: cert.serialNumber, fingerprint: cert.fingerprint256 };

  // 1. algorithms
  const hashName = OID_HASH[info.digestOid];
  if (!hashName) problems.push(`digest algorithm ${info.digestOid} is not known`);
  else if (hashName === 'sha1' || hashName === 'md5') problems.push(`${hashName.toUpperCase()} is not accepted as a signature digest`);
  const hash = toHashName(hashName);
  const keyType = cert.publicKey.asymmetricKeyType;
  if (keyType === 'rsa') {
    const bits = cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < 2048) problems.push(`the RSA key is ${bits} bits; 2048 is the least accepted`);
    const ok = info.sigOid === OID.rsaEncryption || (hash !== null && info.sigOid === RSA_SIG_OID[hash]);
    if (!ok) problems.push(`signature algorithm ${info.sigOid} does not fit an RSA key and ${hashName ?? 'this digest'}`);
  } else if (keyType === 'ec') {
    if (!hash || info.sigOid !== EC_SIG_OID[hash]) problems.push(`signature algorithm ${info.sigOid} does not fit an ECDSA key and ${hashName ?? 'this digest'}`);
  } else problems.push(`a ${keyType ?? 'unknown'} key is not supported`);

  // 2. the digest over the byte ranges, and the signed attributes
  let integrity = false;
  let digestOk = false;
  let sigOk = false;
  if (hash) {
    digestOk = Buffer.compare(digestOf(hash, covered), Buffer.from(info.messageDigest)) === 0;
    if (!digestOk) problems.push('the document was changed after it was signed: the digest does not match');
    try {
      const algOk = !problems.some((p) => p.startsWith('signature algorithm') || p.includes('RSA key') || p.includes('is not supported'));
      if (algOk) {
        sigOk = cryptoVerify(hash, info.signedAttrsForSigning, cert.publicKey, info.signature);
        if (!sigOk) problems.push('the signature does not verify under the signer\'s certificate');
      }
    } catch {
      problems.push('the signature value is not valid for this key');
    }
    integrity = digestOk && sigOk && !problems.length;
  }

  // 3. the certificate is the one that was meant
  let bound = false;
  if (info.essCertHash) {
    const h = digestOf(info.essHashAlg, cert.raw);
    if (Buffer.compare(h, Buffer.from(info.essCertHash)) !== 0) problems.push('the signing-certificate attribute names a different certificate');
    else bound = true;
  } else problems.push('the signed attributes do not bind the signing certificate (signing-certificate-v2 is missing)');
  if (!info.signingTime) problems.push('there is no signing time');
  const profile: Signature['profile'] = bound && info.signingTime ? (info.essV2 && subName === 'ETSI.CAdES.detached' ? 'PAdES-B-B' : 'CMS') : null;

  // 4. validity at the signing time
  const claimed = info.signingTime;
  if (claimed) {
    if (claimed.getTime() > o.now.getTime() + 5 * 60_000) problems.push('the signing time is in the future');
    const from = new Date(cert.validFrom).getTime();
    const to = new Date(cert.validTo).getTime();
    if (claimed.getTime() < from) problems.push('the certificate was not yet valid when the document was signed');
    else if (claimed.getTime() > to) problems.push('the certificate had expired when the document was signed');
  }

  // 5. trust
  const trust = chainTrust(cert, info.certs, o.trustAnchors ?? [], claimed ?? o.now);
  return {
    field, valid: problems.length === 0, integrity, coversWholeDocument: bytesAfter === 0, bytesAfter, signer, signingTime: claimed ? claimed.toISOString() : null, reason, location,
    profile, trust, byteRange: range, problems,
  };
}

interface CmsInfo {
  readonly cert: X509Certificate;
  readonly certs: X509Certificate[];
  readonly digestOid: string;
  readonly sigOid: string;
  readonly signature: Uint8Array;
  readonly messageDigest: Uint8Array;
  readonly signedAttrsForSigning: Uint8Array;
  readonly signingTime: Date | null;
  readonly essCertHash: Uint8Array | null;
  readonly essHashAlg: HashName | 'sha1';
  readonly essV2: boolean;
}

function readCms(cms: Der, problems: string[]): CmsInfo | null {
  try {
    if (cms.tag !== 0x30 || cms.children.length !== 2 || oidOf(cms.children[0]!) !== OID.signedData) throw new PdfSignError('the signature is not CMS SignedData');
    const sdWrap = cms.children[1]!;
    if (sdWrap.tag !== 0xa0 || sdWrap.children.length !== 1) throw new PdfSignError('the SignedData wrapper is malformed');
    const sd = sdWrap.children[0]!;
    const kids = sd.children;
    if (sd.tag !== 0x30 || kids.length < 4) throw new PdfSignError('the SignedData is malformed');
    const encap = kids[2]!;
    if (encap.tag !== 0x30 || encap.children.length !== 1) throw new PdfSignError('the signature carries its own content; PDF signatures are detached');
    const certNode = kids.find((k) => k.tag === 0xa0);
    if (!certNode) throw new PdfSignError('the signature carries no certificates');
    const certs = certNode.children.map((c) => new X509Certificate(Buffer.from(c.raw)));
    const sis = kids[kids.length - 1]!;
    if (sis.tag !== 0x31 || sis.children.length !== 1) throw new PdfSignError(sis.children.length > 1 ? 'more than one signer' : 'there is no signer');
    const si = sis.children[0]!.children;
    if (si.length < 6) throw new PdfSignError('the signer information is malformed');
    const [, sid, dig, attrsNode, sigAlg, sigNode] = si as [Der, Der, Der, Der, Der, Der];
    if (sid.tag !== 0x30 || sid.children.length !== 2) throw new PdfSignError('the signer is identified in a way that is not supported (issuer and serial number only)');
    if (attrsNode.tag !== 0xa0) throw new PdfSignError('the signature has no signed attributes');
    if (sigNode.tag !== 0x04) throw new PdfSignError('the signature value is malformed');
    const digestOid = oidOf(dig.children[0]!);
    const sigOid = oidOf(sigAlg.children[0]!);
    const cert = certs.find((c) => {
      const t = parseDer(c.raw).node.children[0]!;
      const i = t.children[0]!.tag === 0xa0 ? 1 : 0;
      return Buffer.compare(Buffer.from(t.children[i]!.raw), Buffer.from(sid.children[1]!.raw)) === 0 && Buffer.compare(Buffer.from(t.children[i + 2]!.raw), Buffer.from(sid.children[0]!.raw)) === 0;
    });
    if (!cert) throw new PdfSignError('the signer\'s certificate is not in the signature');
    const byOid = new Map<string, Der>();
    for (const a of attrsNode.children) {
      const id = oidOf(a.children[0]!);
      if (byOid.has(id)) throw new PdfSignError(`attribute ${id} appears twice`);
      byOid.set(id, a.children[1]!);
    }
    const ct = byOid.get(OID.contentType)?.children[0];
    if (!ct || oidOf(ct) !== OID.data) throw new PdfSignError('the content type attribute is missing or is not data');
    const md = byOid.get(OID.messageDigest)?.children[0];
    if (!md || md.tag !== 0x04) throw new PdfSignError('the message digest attribute is missing');
    const st = byOid.get(OID.signingTime)?.children[0];
    let signingTime: Date | null = null;
    if (st) {
      const s = Buffer.from(st.content).toString('latin1');
      const m = st.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : st.tag === 0x18 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : null;
      if (!m) throw new PdfSignError('the signing time is not a time');
      const yy = Number(m[1]);
      const year = st.tag === 0x17 ? (yy >= 50 ? 1900 + yy : 2000 + yy) : yy;
      signingTime = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
    }
    let essCertHash: Uint8Array | null = null;
    let essHashAlg: HashName | 'sha1' = 'sha256';
    let essV2 = false;
    const v2 = byOid.get(OID.signingCertV2)?.children[0];
    const v1 = byOid.get(OID.signingCertV1)?.children[0];
    const idNode = (v2 ?? v1)?.children[0]?.children[0];
    if (idNode) {
      const parts = idNode.children;
      if (v2) {
        essV2 = true;
        if (parts[0]?.tag === 0x30) {
          const h = OID_HASH[oidOf(parts[0].children[0]!)];
          const hn = toHashName(h);
          if (!hn) throw new PdfSignError('the signing-certificate attribute uses a digest that is not accepted');
          essHashAlg = hn;
          essCertHash = parts[1]!.content;
        } else essCertHash = parts[0]!.content;
      } else {
        essHashAlg = 'sha1';
        essCertHash = parts[0]!.content;
      }
    }
    return {
      cert, certs, digestOid, sigOid, signature: sigNode.content, messageDigest: md.content,
      signedAttrsForSigning: concat([Uint8Array.of(0x31), attrsNode.raw.subarray(1)]), signingTime, essCertHash, essHashAlg, essV2,
    };
  } catch (e) {
    problems.push(`the signature is not usable: ${(e as Error).message}`);
    return null;
  }
}

function chainTrust(leaf: X509Certificate, embedded: readonly X509Certificate[], anchors: readonly Uint8Array[], at: Date): Signature['trust'] {
  const roots = anchors.map((a) => new X509Certificate(Buffer.from(a)));
  const pool = [...embedded, ...roots];
  const isRoot = (c: X509Certificate) => roots.some((r) => r.fingerprint256 === c.fingerprint256);
  const within = (c: X509Certificate) => new Date(c.validFrom).getTime() <= at.getTime() && at.getTime() <= new Date(c.validTo).getTime();
  let cur = leaf;
  for (let depth = 0; depth < 6; depth++) {
    if (isRoot(cur)) return within(cur) ? 'trusted' : 'untrusted';
    const issuer = pool.find((c) => c.fingerprint256 !== cur.fingerprint256 && cur.checkIssued(c) && c.ca && cur.verify(c.publicKey) && within(c));
    if (!issuer) return depth === 0 && cur.subject === cur.issuer && cur.verify(cur.publicKey) ? 'self-signed' : 'untrusted';
    cur = issuer;
  }
  return 'untrusted';
}

// ================================================================ certificates for tests and development

export interface CertificateRequest {
  readonly commonName: string;
  readonly publicKey: KeyObject;
  /** The issuer's name and key; omit both for a self-signed certificate. */
  readonly issuer?: { readonly commonName: string; readonly privateKey: KeyObject };
  readonly privateKey?: KeyObject;
  readonly serial: number | bigint;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly ca?: boolean;
}

const nameOfCn = (cn: string) => seq(setOf(seq(oid('2.5.4.3'), utf8(cn))));

/** A DER X.509 v3 certificate with digital-signature and non-repudiation key usage; for development, tests and private signing set-ups, not for the public web. */
export function issueCertificate(r: CertificateRequest): Uint8Array {
  const signKey = r.issuer ? r.issuer.privateKey : r.privateKey;
  if (!signKey) throw new PdfSignError('a certificate needs a private key to sign it');
  const rsa = signKey.asymmetricKeyType === 'rsa';
  const sigAlg = rsa ? algId(RSA_SIG_OID.sha256) : seq(oid(EC_SIG_OID.sha256));
  const keyUsage = r.ca ? Uint8Array.of(0x03, 0x02, 0x01, 0x06) : Uint8Array.of(0x03, 0x02, 0x06, 0xc0);
  const ext = (id: string, critical: boolean, value: Uint8Array) => seq(oid(id), ...(critical ? [Uint8Array.of(0x01, 0x01, 0xff)] : []), octets(value));
  const tbs = seq(
    ctx(0, integer(2)),
    integer(r.serial),
    sigAlg,
    nameOfCn(r.issuer ? r.issuer.commonName : r.commonName),
    seq(utcTime(r.notBefore), utcTime(r.notAfter)),
    nameOfCn(r.commonName),
    Uint8Array.from(r.publicKey.export({ type: 'spki', format: 'der' })),
    ctx(3, seq(ext('2.5.29.19', true, r.ca ? seq(Uint8Array.of(0x01, 0x01, 0xff)) : seq()), ext('2.5.29.15', true, keyUsage))),
  );
  const sig = cryptoSign('sha256', tbs, signKey);
  return seq(tbs, sigAlg, tlv(0x03, Uint8Array.of(0), sig));
}

