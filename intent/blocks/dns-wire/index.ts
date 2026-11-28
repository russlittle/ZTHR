/**
 * DNS message and zone-file codec. Standards: RFC 1035 (message format, name compression, master files), RFC 2181
 * (RRset rules, TTL range, CNAME exclusivity), RFC 2308 (negative caching TTL), RFC 1982 (serial number arithmetic),
 * RFC 3596 (AAAA), RFC 2782 (SRV), RFC 6891 (EDNS(0) and extended RCODE), RFC 8659 (CAA), RFC 3597 (unknown types
 * and the \# presentation form), RFC 5952 (IPv6 text form).
 *
 * What it holds: encode and decode of a whole message (header flags, questions, three record sections) with name
 * compression on the way out and compression-pointer checking on the way in; records of type A, AAAA, NS, CNAME,
 * PTR, MX, TXT, SOA, SRV and CAA, and any other type kept as opaque bytes; the OPT pseudo-record as `edns`
 * (UDP size, version, DO bit, extended RCODE, options); truncation to a size limit with the TC bit; a zone-file
 * parser ($ORIGIN, $TTL, inherited owners, @, multi-line parentheses, quoted strings, comments, TTL units, \#
 * generic data) and a writer that reads back to the same records; record and zone validation; TTL arithmetic
 * (units, ageing, clamping, negative-cache TTL, the RFC 2181 high-bit rule); serial arithmetic; a check that a
 * response answers the query that was sent.
 *
 * Security by default: a compression pointer must point to an earlier offset than the pointer itself, so no
 * message can loop; names are capped at 255 bytes and labels at 63; section counts are checked against the bytes
 * that are actually there before anything is allocated; record data must use exactly its declared length; a
 * message with bytes left over is refused; the zone parser has size and record limits and refuses $INCLUDE (it
 * would read files) and $GENERATE.
 *
 * Out of scope: DNSSEC record types (DS, RRSIG, NSEC and so on stay opaque bytes), IDNA/punycode conversion
 * (names are ASCII labels; escape other bytes as \DDD), $GENERATE and $INCLUDE, TSIG, transports, and resolving.
 */

export class DnsError extends Error {
  constructor(message: string) { super(message); this.name = new.target.name; }
}
/** The bytes of a message do not follow the format. */
export class WireError extends DnsError {}
/** A name is not a valid domain name. */
export class NameError extends DnsError {}
/** A record's fields are out of range. */
export class RecordError extends DnsError {}
/** A zone file cannot be read. */
export class ZoneError extends DnsError {
  readonly line: number;
  constructor(message: string, line: number) { super(`line ${line}: ${message}`); this.line = line; }
}

// ---------------------------------------------------------------------------------------------------------------
// Types and names
// ---------------------------------------------------------------------------------------------------------------

export const TYPES: Readonly<Record<string, number>> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, DS: 43, RRSIG: 46, NSEC: 47, DNSKEY: 48, AXFR: 252, ANY: 255, CAA: 257 };
const NAMES_BY_CODE = new Map(Object.entries(TYPES).map(([k, v]) => [v, k]));
export const RCODES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'] as const;

export function typeCode(name: string): number {
  const u = name.toUpperCase();
  const known = TYPES[u];
  if (known !== undefined) return known;
  const m = /^TYPE(\d{1,5})$/.exec(u);
  if (m && Number(m[1]) <= 65535) return Number(m[1]);
  throw new DnsError(`unknown record type ${name}`);
}
export function typeName(code: number): string { return NAMES_BY_CODE.get(code) ?? `TYPE${code}`; }

const BS = 92;
const DOT = 46;
const MAX_NAME = 255;

/** Labels of a presentation-form name. Understands the backslash-dot, backslash-backslash and backslash-DDD escapes. */
export function nameToLabels(name: string): Uint8Array[] {
  if (name === '') throw new NameError('empty name');
  if (name === '.') return [];
  const labels: Uint8Array[] = [];
  let cur: number[] = [];
  let i = 0;
  while (i < name.length) {
    const c = name.charCodeAt(i);
    if (c === BS) {
      const d = name.slice(i + 1, i + 4);
      if (/^[0-9]{3}$/.test(d)) {
        const v = Number(d);
        if (v > 255) throw new NameError(`escape \\${d} is not a byte`);
        cur.push(v);
        i += 4;
      } else if (i + 1 < name.length) {
        const e = name.charCodeAt(i + 1);
        if (e > 127) throw new NameError('names are ASCII; escape other bytes as \\DDD');
        cur.push(e);
        i += 2;
      } else throw new NameError('name ends in a lone backslash');
    } else if (c === DOT) {
      if (cur.length === 0) throw new NameError('empty label');
      labels.push(Uint8Array.from(cur));
      cur = [];
      i++;
    } else {
      if (c > 127) throw new NameError('names are ASCII; convert to punycode first');
      cur.push(c);
      i++;
    }
  }
  if (cur.length) labels.push(Uint8Array.from(cur));
  let total = 1;
  for (const l of labels) {
    if (l.length > 63) throw new NameError('a label is longer than 63 bytes');
    total += l.length + 1;
  }
  if (total > MAX_NAME) throw new NameError('a name is longer than 255 bytes on the wire');
  return labels;
}

/** The absolute presentation form of labels, with a trailing dot and escapes where needed. */
export function labelsToName(labels: readonly Uint8Array[]): string {
  if (labels.length === 0) return '.';
  let out = '';
  for (const l of labels) {
    for (const b of l) {
      if (b === DOT || b === BS) out += String.fromCharCode(BS, b);
      else if (b > 32 && b < 127) out += String.fromCharCode(b);
      else out += String.fromCharCode(BS) + String(b).padStart(3, '0');
    }
    out += '.';
  }
  return out;
}

const lowerByte = (b: number): number => (b >= 65 && b <= 90 ? b + 32 : b);
/** Absolute, ASCII-lowercased form: the key two names are equal under (RFC 4343). */
export function canonicalName(name: string): string {
  return labelsToName(nameToLabels(name).map((l) => l.map(lowerByte)));
}
export function sameName(a: string, b: string): boolean { return canonicalName(a) === canonicalName(b); }
/** True when `name` is `zone` or below it. */
export function isSubdomain(name: string, zone: string): boolean {
  const n = nameToLabels(name).map((l) => labelsToName([l.map(lowerByte)]));
  const z = nameToLabels(zone).map((l) => labelsToName([l.map(lowerByte)]));
  if (z.length > n.length) return false;
  for (let i = 1; i <= z.length; i++) if (n[n.length - i] !== z[z.length - i]) return false;
  return true;
}
/** Letters, digits and hyphens, no leading or trailing hyphen in a label (RFC 952, RFC 1123). */
export function isHostname(name: string): boolean {
  let labels: Uint8Array[];
  try { labels = nameToLabels(name); } catch { return false; }
  if (labels.length === 0) return false;
  return labels.every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(String.fromCharCode(...l)));
}

// ---------------------------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------------------------

export function parseIPv4(s: string): Uint8Array {
  const parts = s.split('.');
  if (parts.length !== 4) throw new RecordError(`${s} is not an IPv4 address`);
  const out = new Uint8Array(4);
  parts.forEach((p, i) => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) throw new RecordError(`${s} is not an IPv4 address`);
    out[i] = Number(p);
  });
  return out;
}
export function formatIPv4(b: Uint8Array): string { return Array.from(b).join('.'); }

export function parseIPv6(s: string): Uint8Array {
  const bad = (): never => { throw new RecordError(`${s} is not an IPv6 address`); };
  if (s.includes('%') || s === '') bad();
  const halves = s.split('::');
  if (halves.length > 2) bad();
  const groups = (h: string): number[] => {
    if (h === '') return [];
    const out: number[] = [];
    const parts = h.split(':');
    parts.forEach((p, i) => {
      if (p.includes('.')) {
        if (i !== parts.length - 1) bad();
        const v4 = parseIPv4(p);
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) bad();
        out.push(parseInt(p, 16));
      }
    });
    return out;
  };
  const head = groups(halves[0]!);
  let all: number[];
  if (halves.length === 2) {
    const tail = groups(halves[1]!);
    const fill = 8 - head.length - tail.length;
    if (fill < 1) bad();
    all = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else all = head;
  if (all.length !== 8) bad();
  const out = new Uint8Array(16);
  all.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 255; });
  return out;
}
/** RFC 5952 form: lowercase, no leading zeros, the longest run of two or more zero groups (the first, on a tie) as `::`. */
export function formatIPv6(b: Uint8Array): string {
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i]! << 8) | b[i + 1]!);
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  if (bestLen < 2) return g.map((x) => x.toString(16)).join(':');
  const left = g.slice(0, best).map((x) => x.toString(16)).join(':');
  const right = g.slice(best + bestLen).map((x) => x.toString(16)).join(':');
  return `${left}::${right}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------

export type Rdata =
  | { readonly type: 'A' | 'AAAA'; readonly address: string }
  | { readonly type: 'NS' | 'CNAME' | 'PTR'; readonly target: string }
  | { readonly type: 'MX'; readonly preference: number; readonly exchange: string }
  /** Each string is one character-string of up to 255 bytes, one byte per character (code points 0 to 255). */
  | { readonly type: 'TXT'; readonly strings: readonly string[] }
  | { readonly type: 'SOA'; readonly mname: string; readonly rname: string; readonly serial: number; readonly refresh: number; readonly retry: number; readonly expire: number; readonly minimum: number }
  | { readonly type: 'SRV'; readonly priority: number; readonly weight: number; readonly port: number; readonly target: string }
  | { readonly type: 'CAA'; readonly flags: number; readonly tag: string; readonly value: string }
  | { readonly type: 'RAW'; readonly code: number; readonly data: Uint8Array };

export interface DnsRecord {
  readonly name: string;
  readonly ttl: number;
  /** The class code; 1 is IN. */
  readonly cls: number;
  readonly data: Rdata;
}
export interface Question { readonly name: string; readonly qtype: number; readonly qclass: number }
export interface EdnsOption { readonly code: number; readonly data: Uint8Array }
export interface Edns { readonly udpSize: number; readonly version: number; readonly dnssecOk: boolean; readonly options: readonly EdnsOption[] }
export interface Message {
  readonly id: number;
  readonly qr: boolean;
  readonly opcode: number;
  readonly aa: boolean;
  readonly tc: boolean;
  readonly rd: boolean;
  readonly ra: boolean;
  readonly ad: boolean;
  readonly cd: boolean;
  /** The full response code; values above 15 need `edns` (the high bits travel in the OPT record). */
  readonly rcode: number;
  readonly questions: readonly Question[];
  readonly answers: readonly DnsRecord[];
  readonly authority: readonly DnsRecord[];
  readonly additional: readonly DnsRecord[];
  readonly edns?: Edns;
}

export function recordType(d: Rdata): number { return d.type === 'RAW' ? d.code : TYPES[d.type]!; }
export const MAX_TTL = 2 ** 31 - 1;

const u16ok = (v: number, what: string): void => { if (!Number.isInteger(v) || v < 0 || v > 65535) throw new RecordError(`${what} must be 0 to 65535`); };
const u32ok = (v: number, what: string): void => { if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RecordError(`${what} must be 0 to 4294967295`); };
const bytesOf = (s: string, what: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) throw new RecordError(`${what} holds a character above 255; use one byte per character`);
    out[i] = c;
  }
  return out;
};
const CAA_TAG = /^[A-Za-z0-9]{1,15}$/;

/** Throws RecordError when a record's fields are out of range. Called on every encode. */
export function validateRecord(r: DnsRecord): void {
  if (!Number.isInteger(r.ttl) || r.ttl < 0 || r.ttl > MAX_TTL) throw new RecordError('ttl must be 0 to 2147483647 (RFC 2181)');
  u16ok(r.cls, 'class');
  try { nameToLabels(r.name); } catch (e) { throw new RecordError(`owner name: ${(e as Error).message}`); }
  const d = r.data;
  const nm = (n: string, what: string): void => { try { nameToLabels(n); } catch (e) { throw new RecordError(`${what}: ${(e as Error).message}`); } };
  switch (d.type) {
    case 'A': parseIPv4(d.address); break;
    case 'AAAA': parseIPv6(d.address); break;
    case 'NS': case 'CNAME': case 'PTR': nm(d.target, 'target'); break;
    case 'MX': u16ok(d.preference, 'preference'); nm(d.exchange, 'exchange'); break;
    case 'TXT':
      if (d.strings.length === 0) throw new RecordError('TXT needs at least one string');
      for (const s of d.strings) if (bytesOf(s, 'TXT').length > 255) throw new RecordError('a TXT string is longer than 255 bytes');
      break;
    case 'SOA':
      nm(d.mname, 'mname'); nm(d.rname, 'rname');
      for (const k of ['serial', 'refresh', 'retry', 'expire', 'minimum'] as const) u32ok(d[k], k);
      break;
    case 'SRV': u16ok(d.priority, 'priority'); u16ok(d.weight, 'weight'); u16ok(d.port, 'port'); nm(d.target, 'target'); break;
    case 'CAA':
      if (!Number.isInteger(d.flags) || d.flags < 0 || d.flags > 255) throw new RecordError('CAA flags must be 0 to 255');
      if (!CAA_TAG.test(d.tag)) throw new RecordError('CAA tag is 1 to 15 letters and digits');
      bytesOf(d.value, 'CAA value');
      break;
    case 'RAW': u16ok(d.code, 'type'); break;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------------------------

class Writer {
  buf = new Uint8Array(512);
  len = 0;
  readonly names = new Map<string, number>();
  readonly compress: boolean;
  constructor(compress: boolean) { this.compress = compress; }
  #room(n: number): void {
    if (this.len + n > 65535) throw new WireError('message is longer than 65535 bytes');
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number): void { this.#room(1); this.buf[this.len++] = v; }
  u16(v: number): void { this.#room(2); this.buf[this.len++] = v >> 8; this.buf[this.len++] = v & 255; }
  u32(v: number): void { this.u16(Math.floor(v / 65536)); this.u16(v % 65536); }
  bytes(b: Uint8Array): void { this.#room(b.length); this.buf.set(b, this.len); this.len += b.length; }
  patch16(at: number, v: number): void { this.buf[at] = v >> 8; this.buf[at + 1] = v & 255; }
  name(name: string, compress: boolean): void {
    const labels = nameToLabels(name);
    for (let i = 0; i < labels.length; i++) {
      const key = labels.slice(i).map((l) => Array.from(l, lowerByte).join(',')).join('|');
      if (compress && this.compress) {
        const at = this.names.get(key);
        if (at !== undefined) { this.u16(0xc000 | at); return; }
      }
      if (this.len < 0x4000 && !this.names.has(key)) this.names.set(key, this.len);
      const l = labels[i]!;
      this.u8(l.length);
      this.bytes(l);
    }
    this.u8(0);
  }
}

function writeRdata(w: Writer, d: Rdata): void {
  switch (d.type) {
    case 'A': w.bytes(parseIPv4(d.address)); break;
    case 'AAAA': w.bytes(parseIPv6(d.address)); break;
    case 'NS': case 'CNAME': case 'PTR': w.name(d.target, true); break;
    case 'MX': w.u16(d.preference); w.name(d.exchange, true); break;
    case 'TXT': for (const s of d.strings) { const b = bytesOf(s, 'TXT'); w.u8(b.length); w.bytes(b); } break;
    case 'SOA': w.name(d.mname, true); w.name(d.rname, true); w.u32(d.serial); w.u32(d.refresh); w.u32(d.retry); w.u32(d.expire); w.u32(d.minimum); break;
    case 'SRV': w.u16(d.priority); w.u16(d.weight); w.u16(d.port); w.name(d.target, false); break;
    case 'CAA': { w.u8(d.flags); w.u8(d.tag.length); w.bytes(bytesOf(d.tag, 'CAA tag')); w.bytes(bytesOf(d.value, 'CAA value')); break; }
    case 'RAW': w.bytes(d.data); break;
  }
}

function writeRecord(w: Writer, r: DnsRecord): void {
  validateRecord(r);
  w.name(r.name, true);
  w.u16(recordType(r.data));
  w.u16(r.cls);
  w.u32(r.ttl);
  const at = w.len;
  w.u16(0);
  writeRdata(w, r.data);
  const n = w.len - at - 2;
  if (n > 65535) throw new WireError('record data is longer than 65535 bytes');
  w.patch16(at, n);
}

function writeOpt(w: Writer, e: Edns, extRcode: number): void {
  u16ok(e.udpSize, 'udpSize');
  if (e.version < 0 || e.version > 255 || !Number.isInteger(e.version)) throw new RecordError('EDNS version must be 0 to 255');
  w.u8(0);
  w.u16(TYPES.OPT!);
  w.u16(e.udpSize);
  w.u32(extRcode * 0x1000000 + e.version * 0x10000 + (e.dnssecOk ? 0x8000 : 0));
  const at = w.len;
  w.u16(0);
  for (const o of e.options) { u16ok(o.code, 'option code'); w.u16(o.code); u16ok(o.data.length, 'option length'); w.u16(o.data.length); w.bytes(o.data); }
  w.patch16(at, w.len - at - 2);
}

export interface EncodeOptions {
  /** Compress names (default true). */
  readonly compress?: boolean;
  /** Fit in this many bytes: drop additional records, then authority and answers with the TC bit set. */
  readonly maxSize?: number;
}

function encodeFull(m: Message, o: EncodeOptions, tc: boolean): Uint8Array {
  const w = new Writer(o.compress ?? true);
  u16ok(m.id, 'id');
  if (m.opcode < 0 || m.opcode > 15 || !Number.isInteger(m.opcode)) throw new RecordError('opcode must be 0 to 15');
  if (m.rcode < 0 || m.rcode > 4095 || !Number.isInteger(m.rcode)) throw new RecordError('rcode must be 0 to 4095');
  if (m.rcode > 15 && !m.edns) throw new RecordError('a response code above 15 needs EDNS');
  const additionalCount = m.additional.length + (m.edns ? 1 : 0);
  for (const [n, what] of [[m.questions.length, 'questions'], [m.answers.length, 'answers'], [m.authority.length, 'authority records'], [additionalCount, 'additional records']] as const) if (n > 65535) throw new WireError(`too many ${what}`);
  w.u16(m.id);
  const flags = (m.qr ? 0x8000 : 0) | (m.opcode << 11) | (m.aa ? 0x400 : 0) | (tc || m.tc ? 0x200 : 0) | (m.rd ? 0x100 : 0) | (m.ra ? 0x80 : 0) | (m.ad ? 0x20 : 0) | (m.cd ? 0x10 : 0) | (m.rcode & 15);
  w.u16(flags);
  w.u16(m.questions.length); w.u16(m.answers.length); w.u16(m.authority.length); w.u16(additionalCount);
  for (const q of m.questions) { w.name(q.name, true); u16ok(q.qtype, 'qtype'); u16ok(q.qclass, 'qclass'); w.u16(q.qtype); w.u16(q.qclass); }
  for (const r of m.answers) writeRecord(w, r);
  for (const r of m.authority) writeRecord(w, r);
  for (const r of m.additional) writeRecord(w, r);
  if (m.edns) writeOpt(w, m.edns, m.rcode >> 4);
  return w.buf.slice(0, w.len);
}

export function encode(m: Message, o: EncodeOptions = {}): Uint8Array {
  let out = encodeFull(m, o, false);
  if (o.maxSize === undefined || out.length <= o.maxSize) return out;
  out = encodeFull({ ...m, additional: [] }, o, false);
  if (out.length <= o.maxSize) return out;
  const cut = { ...m, additional: [], authority: [] as DnsRecord[] };
  out = encodeFull(cut, o, true);
  if (out.length <= o.maxSize) return out;
  return encodeFull({ ...cut, answers: [] }, o, true);
}

// ---------------------------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------------------------

function readName(buf: Uint8Array, start: number): { labels: Uint8Array[]; next: number } {
  const labels: Uint8Array[] = [];
  let pos = start;
  let next = -1;
  let total = 1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new WireError('a name runs past the end of the message');
    const len = buf[pos]!;
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new WireError('a compression pointer is cut off');
      const target = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (next < 0) next = pos + 2;
      if (target >= pos) throw new WireError('a compression pointer must point to an earlier offset');
      if (++jumps > 127) throw new WireError('too many compression pointers in one name');
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new WireError('a label uses a reserved type');
    if (len === 0) { if (next < 0) next = pos + 1; break; }
    if (pos + 1 + len > buf.length) throw new WireError('a label runs past the end of the message');
    total += len + 1;
    if (total > MAX_NAME) throw new WireError('a name is longer than 255 bytes');
    labels.push(buf.slice(pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { labels, next };
}

class Reader {
  pos: number;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array, pos = 0) { this.buf = buf; this.pos = pos; }
  need(n: number): void { if (this.pos + n > this.buf.length) throw new WireError('the message is cut short'); }
  u8(): number { this.need(1); return this.buf[this.pos++]!; }
  u16(): number { this.need(2); const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!; this.pos += 2; return v; }
  u32(): number { return this.u16() * 65536 + this.u16(); }
  take(n: number): Uint8Array { this.need(n); const b = this.buf.slice(this.pos, this.pos + n); this.pos += n; return b; }
  name(): string { const r = readName(this.buf, this.pos); this.pos = r.next; return labelsToName(r.labels); }
}
const latin1 = (b: Uint8Array): string => { let s = ''; for (const x of b) s += String.fromCharCode(x); return s; };

function readRdata(r: Reader, type: number, len: number): Rdata {
  const end = r.pos + len;
  r.need(len);
  const done = (d: Rdata): Rdata => {
    if (r.pos !== end) throw new WireError(`${typeName(type)} data does not fill its declared length`);
    return d;
  };
  const sub = new Reader(r.buf.subarray(0, end), r.pos);
  // Names inside record data may point anywhere earlier in the whole message, so read from the full buffer.
  const rd = new Reader(r.buf, r.pos);
  const fit = (): void => { if (rd.pos > end) throw new WireError(`${typeName(type)} data runs past its declared length`); };
  void sub;
  let d: Rdata;
  switch (type) {
    case 1: if (len !== 4) throw new WireError('A data must be 4 bytes'); d = { type: 'A', address: formatIPv4(rd.take(4)) }; break;
    case 28: if (len !== 16) throw new WireError('AAAA data must be 16 bytes'); d = { type: 'AAAA', address: formatIPv6(rd.take(16)) }; break;
    case 2: case 5: case 12: { const target = rd.name(); fit(); d = { type: type === 2 ? 'NS' : type === 5 ? 'CNAME' : 'PTR', target }; break; }
    case 15: { const preference = rd.u16(); const exchange = rd.name(); fit(); d = { type: 'MX', preference, exchange }; break; }
    case 16: {
      const strings: string[] = [];
      while (rd.pos < end) { const n = rd.u8(); if (rd.pos + n > end) throw new WireError('a TXT string runs past its record'); strings.push(latin1(rd.take(n))); }
      if (strings.length === 0) throw new WireError('TXT data is empty');
      d = { type: 'TXT', strings };
      break;
    }
    case 6: { const mname = rd.name(); const rname = rd.name(); const serial = rd.u32(); const refresh = rd.u32(); const retry = rd.u32(); const expire = rd.u32(); const minimum = rd.u32(); fit(); d = { type: 'SOA', mname, rname, serial, refresh, retry, expire, minimum }; break; }
    case 33: { const priority = rd.u16(); const weight = rd.u16(); const port = rd.u16(); const target = rd.name(); fit(); d = { type: 'SRV', priority, weight, port, target }; break; }
    case 257: {
      const flags = rd.u8(); const tl = rd.u8();
      if (tl < 1 || rd.pos + tl > end) throw new WireError('CAA tag length is wrong');
      const tag = latin1(rd.take(tl));
      d = { type: 'CAA', flags, tag, value: latin1(rd.take(end - rd.pos)) };
      break;
    }
    default: d = { type: 'RAW', code: type, data: rd.take(len) };
  }
  r.pos = rd.pos;
  return done(d);
}

export interface DecodeOptions {
  /** Accept bytes after the last record (default false). */
  readonly allowTrailing?: boolean;
}

export function decode(buf: Uint8Array, o: DecodeOptions = {}): Message {
  if (buf.length < 12) throw new WireError('a message is at least 12 bytes');
  const r = new Reader(buf);
  const id = r.u16();
  const flags = r.u16();
  const qd = r.u16(); const an = r.u16(); const ns = r.u16(); const ar = r.u16();
  if (qd * 5 + (an + ns + ar) * 11 > buf.length - 12) throw new WireError('the section counts are larger than the message can hold');
  const questions: Question[] = [];
  for (let i = 0; i < qd; i++) { const name = r.name(); questions.push({ name, qtype: r.u16(), qclass: r.u16() }); }
  let opt: { cls: number; ttl: number; options: EdnsOption[] } | undefined;
  const section = (n: number, isAdditional: boolean): DnsRecord[] => {
    const out: DnsRecord[] = [];
    for (let i = 0; i < n; i++) {
      const name = r.name();
      const type = r.u16(); const cls = r.u16(); const rawTtl = r.u32(); const len = r.u16();
      if (type === TYPES.OPT) {
        if (!isAdditional) throw new WireError('an OPT record outside the additional section');
        if (opt) throw new WireError('more than one OPT record');
        if (name !== '.') throw new WireError('the OPT record name must be the root');
        const end = r.pos + len;
        r.need(len);
        const options: EdnsOption[] = [];
        while (r.pos < end) {
          const code = r.u16(); const n2 = r.u16();
          if (r.pos + n2 > end) throw new WireError('an EDNS option runs past its record');
          options.push({ code, data: r.take(n2) });
        }
        opt = { cls, ttl: rawTtl, options };
        continue;
      }
      // RFC 2181 section 8: a TTL with the top bit set is read as zero.
      const ttl = rawTtl > MAX_TTL ? 0 : rawTtl;
      out.push({ name, ttl, cls, data: readRdata(r, type, len) });
    }
    return out;
  };
  const answers = section(an, false);
  const authority = section(ns, false);
  const additional = section(ar, true);
  if (r.pos !== buf.length && !o.allowTrailing) throw new WireError('bytes left over after the last record');
  const base = {
    id, qr: (flags & 0x8000) !== 0, opcode: (flags >> 11) & 15, aa: (flags & 0x400) !== 0, tc: (flags & 0x200) !== 0, rd: (flags & 0x100) !== 0,
    ra: (flags & 0x80) !== 0, ad: (flags & 0x20) !== 0, cd: (flags & 0x10) !== 0, rcode: flags & 15, questions, answers, authority, additional,
  };
  if (!opt) return base;
  return { ...base, rcode: (flags & 15) | (Math.floor(opt.ttl / 0x1000000) << 4), edns: { udpSize: opt.cls, version: (opt.ttl >> 16) & 255, dnssecOk: (opt.ttl & 0x8000) !== 0, options: opt.options } };
}

// ---------------------------------------------------------------------------------------------------------------
// Queries and responses
// ---------------------------------------------------------------------------------------------------------------

export interface QueryOptions {
  /** The message id. Pass a random 16-bit value from your own source of randomness. */
  readonly id: number;
  readonly rd?: boolean;
  readonly edns?: Edns;
  readonly qclass?: number;
}
export function makeQuery(name: string, type: string | number, o: QueryOptions): Message {
  const qtype = typeof type === 'number' ? type : typeCode(type);
  const base = { id: o.id, qr: false, opcode: 0, aa: false, tc: false, rd: o.rd ?? true, ra: false, ad: false, cd: false, rcode: 0, questions: [{ name, qtype, qclass: o.qclass ?? 1 }], answers: [], authority: [], additional: [] };
  return o.edns ? { ...base, edns: o.edns } : base;
}

/**
 * Throws unless `response` answers `query`: it is a response, the id matches and the question is the same name (compared
 * without regard to case), type and class. A resolver should do this before trusting anything in the response.
 */
export function checkResponse(query: Message, response: Message): void {
  if (!response.qr) throw new DnsError('not a response');
  if (response.id !== query.id) throw new DnsError('response id does not match the query');
  if (response.opcode !== query.opcode) throw new DnsError('response opcode does not match the query');
  if (response.questions.length !== query.questions.length) throw new DnsError('response question count does not match the query');
  query.questions.forEach((q, i) => {
    const a = response.questions[i]!;
    if (a.qtype !== q.qtype || a.qclass !== q.qclass || !sameName(a.name, q.name)) throw new DnsError('response question does not match the query');
  });
}

// ---------------------------------------------------------------------------------------------------------------
// TTL and serial arithmetic
// ---------------------------------------------------------------------------------------------------------------

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
/** `3600`, `1h`, `1h30m`, `2w1d`. Digits alone are seconds. */
export function parseTtl(s: string): number {
  if (!/^([0-9]+[smhdwSMHDW]?)+$/.test(s)) throw new RecordError(`${s} is not a TTL`);
  let total = 0;
  for (const m of s.matchAll(/([0-9]+)([smhdwSMHDW]?)/g)) total += Number(m[1]) * UNIT[(m[2] || 's').toLowerCase()]!;
  if (!Number.isSafeInteger(total) || total > MAX_TTL) throw new RecordError('a TTL is at most 2147483647 seconds');
  return total;
}
export function formatTtl(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_TTL) throw new RecordError('ttl must be 0 to 2147483647');
  if (seconds === 0) return '0s';
  let left = seconds;
  let out = '';
  for (const [u, n] of [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    const q = Math.floor(left / n);
    if (q) { out += `${q}${u}`; left -= q * n; }
  }
  return out;
}
/** The TTL left on a cached record: the stored TTL less the seconds since it was stored, never below zero. */
export function ttlRemaining(ttl: number, storedAtMs: number, nowMs: number): number {
  const elapsed = Math.floor((nowMs - storedAtMs) / 1000);
  return Math.max(0, ttl - Math.max(0, elapsed));
}
export function clampTtl(ttl: number, bounds: { readonly min?: number; readonly max?: number }): number {
  let t = ttl;
  if (bounds.min !== undefined) t = Math.max(t, bounds.min);
  if (bounds.max !== undefined) t = Math.min(t, bounds.max);
  return t;
}
/** RFC 2308 section 5: a negative answer is cached for the smaller of the SOA record's TTL and its MINIMUM field. */
export function negativeTtl(soa: DnsRecord): number {
  if (soa.data.type !== 'SOA') throw new RecordError('negative caching needs the SOA record from the authority section');
  return Math.min(soa.ttl, soa.data.minimum);
}
/** A copy of the records with each TTL reduced by the time elapsed, dropping the ones that have run out. */
export function ageRecords(records: readonly DnsRecord[], storedAtMs: number, nowMs: number): DnsRecord[] {
  return records.map((r) => ({ ...r, ttl: ttlRemaining(r.ttl, storedAtMs, nowMs) })).filter((r) => r.ttl > 0);
}

/** RFC 1982: is serial `a` after `b`? Undefined comparisons (exactly 2^31 apart) return false both ways. */
export function serialGt(a: number, b: number): boolean {
  u32ok(a, 'serial'); u32ok(b, 'serial');
  return (a < b && b - a > 0x80000000) || (a > b && a - b < 0x80000000);
}
export function serialCompare(a: number, b: number): -1 | 0 | 1 | undefined {
  if (a === b) return 0;
  if (serialGt(a, b)) return 1;
  if (serialGt(b, a)) return -1;
  return undefined;
}
/** The usual YYYYMMDDnn serial for a date; if `current` is already at or past it, one more than `current`. */
export function nextSerial(current: number, today: Date): number {
  const base = today.getUTCFullYear() * 1000000 + (today.getUTCMonth() + 1) * 10000 + today.getUTCDate() * 100;
  if (base > current) return base;
  return (current + 1) % 0x100000000;
}

// ---------------------------------------------------------------------------------------------------------------
// Presentation form and zone files
// ---------------------------------------------------------------------------------------------------------------

function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === BS) out += String.fromCharCode(BS, c);
    else if (c < 32 || c > 126) out += String.fromCharCode(BS) + String(c).padStart(3, '0');
    else out += s[i];
  }
  return `${out}"`;
}
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function formatRdata(d: Rdata): string {
  switch (d.type) {
    case 'A': case 'AAAA': return d.address;
    case 'NS': case 'CNAME': case 'PTR': return d.target;
    case 'MX': return `${d.preference} ${d.exchange}`;
    case 'TXT': return d.strings.map(quote).join(' ');
    case 'SOA': return `${d.mname} ${d.rname} ${d.serial} ${d.refresh} ${d.retry} ${d.expire} ${d.minimum}`;
    case 'SRV': return `${d.priority} ${d.weight} ${d.port} ${d.target}`;
    case 'CAA': return `${d.flags} ${d.tag} ${quote(d.value)}`;
    case 'RAW': return `\\# ${d.data.length}${d.data.length ? ` ${hex(d.data)}` : ''}`;
  }
}
export function formatRecord(r: DnsRecord): string {
  validateRecord(r);
  const cls = r.cls === 1 ? 'IN' : r.cls === 3 ? 'CH' : r.cls === 4 ? 'HS' : `CLASS${r.cls}`;
  return `${r.name} ${r.ttl} ${cls} ${typeName(recordType(r.data))} ${formatRdata(r.data)}`;
}
export function formatZone(records: readonly DnsRecord[]): string {
  return `${records.map(formatRecord).join('\n')}\n`;
}

interface Token { readonly text: string; readonly quoted: boolean }
interface Entry { readonly line: number; readonly blankOwner: boolean; readonly tokens: Token[] }

export interface ZoneOptions {
  /** The origin to start with, as if the file began with $ORIGIN. */
  readonly origin?: string;
  readonly defaultTtl?: number;
  readonly maxBytes?: number;
  readonly maxRecords?: number;
}
export interface Zone { readonly origin: string | undefined; readonly records: DnsRecord[] }

function tokenize(text: string): Entry[] {
  const entries: Entry[] = [];
  let tokens: Token[] = [];
  let depth = 0;
  let line = 1;
  let entryLine = 1;
  let blank = false;
  let atStart = true;
  let i = 0;
  const flush = (): void => {
    if (tokens.length) entries.push({ line: entryLine, blankOwner: blank, tokens });
    tokens = [];
    atStart = true;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (atStart && tokens.length === 0) { entryLine = line; blank = c === ' ' || c === '\t'; atStart = false; }
    if (c === '\n') { line++; i++; if (depth === 0) flush(); continue; }
    if (c === '\r') { i++; continue; }
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') { if (depth === 0) throw new ZoneError('a closing parenthesis with no opening one', line); depth--; i++; continue; }
    if (c === '"') {
      let s = '';
      i++;
      for (;;) {
        if (i >= text.length || text[i] === '\n') throw new ZoneError('a quoted string is not closed', line);
        const ch = text[i]!;
        if (ch === '"') { i++; break; }
        if (ch === '\\') {
          const d = text.slice(i + 1, i + 4);
          if (/^[0-9]{3}$/.test(d)) { if (Number(d) > 255) throw new ZoneError('an escape above 255', line); s += String.fromCharCode(Number(d)); i += 4; continue; }
          if (i + 1 >= text.length || text[i + 1] === '\n') throw new ZoneError('a quoted string is not closed', line);
          s += text[i + 1]; i += 2; continue;
        }
        s += ch; i++;
      }
      tokens.push({ text: s, quoted: true });
      continue;
    }
    let s = '';
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ';' || ch === '(' || ch === ')' || ch === '"') break;
      if (ch === '\\') { s += text.slice(i, i + 2); i += 2; continue; }
      s += ch; i++;
    }
    tokens.push({ text: s, quoted: false });
  }
  if (depth !== 0) throw new ZoneError('an opening parenthesis is never closed', entryLine);
  flush();
  return entries;
}

/** Unescape an unquoted token's backslash forms to one byte per character. */
function unescape(s: string, line: number): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const d = s.slice(i + 1, i + 4);
    if (/^[0-9]{3}$/.test(d)) { if (Number(d) > 255) throw new ZoneError('an escape above 255', line); out += String.fromCharCode(Number(d)); i += 3; continue; }
    if (i + 1 >= s.length) throw new ZoneError('a lone backslash', line);
    out += s[i + 1]; i++;
  }
  return out;
}

const CLASSES: Record<string, number> = { IN: 1, CH: 3, HS: 4 };
const TTL_WORD = /^[0-9]+[smhdwSMHDW]?([0-9]+[smhdwSMHDW]?)*$/;

export function parseZone(text: string, o: ZoneOptions = {}): Zone {
  const maxBytes = o.maxBytes ?? 5_000_000;
  const maxRecords = o.maxRecords ?? 100_000;
  if (text.length > maxBytes) throw new ZoneError(`the zone is larger than ${maxBytes} bytes`, 1);
  let origin = o.origin === undefined ? undefined : canonicalAbsolute(o.origin, 1);
  let defaultTtl = o.defaultTtl;
  let lastTtl: number | undefined;
  let lastOwner: string | undefined;
  const records: DnsRecord[] = [];

  const absolute = (tok: string, line: number): string => {
    try {
      if (tok === '@') { if (origin === undefined) throw new ZoneError('@ used with no origin', line); return origin; }
      const ends = tok.endsWith('.') && !tok.endsWith(`${String.fromCharCode(BS)}.`);
      if (ends || tok === '.') { nameToLabels(tok); return tok === '.' ? '.' : tok; }
      if (origin === undefined) throw new ZoneError(`relative name ${tok} with no origin`, line);
      const joined = origin === '.' ? `${tok}.` : `${tok}.${origin}`;
      nameToLabels(joined);
      return joined;
    } catch (e) {
      if (e instanceof ZoneError) throw e;
      throw new ZoneError((e as Error).message, line);
    }
  };

  for (const entry of tokenize(text)) {
    const { line } = entry;
    const toks = [...entry.tokens];
    const first = toks[0]!;
    if (!entry.blankOwner && !first.quoted && first.text.startsWith('$')) {
      const dir = first.text.toUpperCase();
      if (dir === '$ORIGIN') {
        if (toks.length !== 2) throw new ZoneError('$ORIGIN takes one name', line);
        origin = absolute(toks[1]!.text, line);
        if (!origin.endsWith('.')) origin = `${origin}.`;
      } else if (dir === '$TTL') {
        if (toks.length !== 2) throw new ZoneError('$TTL takes one value', line);
        try { defaultTtl = parseTtl(toks[1]!.text); } catch (e) { throw new ZoneError((e as Error).message, line); }
      } else if (dir === '$INCLUDE') throw new ZoneError('$INCLUDE is refused: it would read other files', line);
      else if (dir === '$GENERATE') throw new ZoneError('$GENERATE is not supported', line);
      else throw new ZoneError(`unknown directive ${first.text}`, line);
      continue;
    }
    let owner: string;
    if (entry.blankOwner) {
      if (lastOwner === undefined) throw new ZoneError('a record with no owner before any owner was given', line);
      owner = lastOwner;
    } else { owner = absolute(toks.shift()!.text, line); }
    lastOwner = owner;
    let ttl: number | undefined;
    let cls: number | undefined;
    while (toks.length) {
      const t = toks[0]!;
      if (t.quoted) break;
      const up = t.text.toUpperCase();
      if (cls === undefined && CLASSES[up] !== undefined) { cls = CLASSES[up]!; toks.shift(); continue; }
      if (cls === undefined && /^CLASS[0-9]+$/.test(up)) { cls = Number(up.slice(5)); toks.shift(); continue; }
      if (ttl === undefined && TTL_WORD.test(t.text)) {
        try { ttl = parseTtl(t.text); } catch (e) { throw new ZoneError((e as Error).message, line); }
        toks.shift();
        continue;
      }
      break;
    }
    const typeTok = toks.shift();
    if (!typeTok) throw new ZoneError('a record needs a type', line);
    let code: number;
    try { code = typeCode(typeTok.text); } catch (e) { throw new ZoneError((e as Error).message, line); }
    let data: Rdata;
    try { data = parseRdata(code, toks, absolute, line); } catch (e) { if (e instanceof ZoneError) throw e; throw new ZoneError((e as Error).message, line); }
    if (ttl === undefined) {
      ttl = defaultTtl ?? lastTtl ?? (data.type === 'SOA' ? data.minimum : undefined);
      if (ttl === undefined) throw new ZoneError('no TTL: give one, or set $TTL first', line);
    }
    lastTtl = ttl;
    if (records.length >= maxRecords) throw new ZoneError(`more than ${maxRecords} records`, line);
    const rec: DnsRecord = { name: owner, ttl, cls: cls ?? 1, data };
    try { validateRecord(rec); } catch (e) { throw new ZoneError((e as Error).message, line); }
    records.push(rec);
  }
  return { origin, records };
}

function canonicalAbsolute(name: string, line: number): string {
  try { nameToLabels(name); } catch (e) { throw new ZoneError((e as Error).message, line); }
  if (!name.endsWith('.')) throw new ZoneError('the origin must end with a dot', line);
  return name;
}

function parseRdata(code: number, toks: Token[], abs: (t: string, line: number) => string, line: number): Rdata {
  const text = (): string => { const t = toks.shift(); if (!t) throw new ZoneError('the record data is incomplete', line); return t.text; };
  const num = (what: string, max: number): number => {
    const s = text();
    if (!/^[0-9]+$/.test(s) || Number(s) > max) throw new ZoneError(`${what} must be a whole number up to ${max}`, line);
    return Number(s);
  };
  const end = (): void => { if (toks.length) throw new ZoneError('extra data at the end of the record', line); };
  if (toks.length && toks[0]!.text === '\\#' && !toks[0]!.quoted) {
    toks.shift();
    const n = num('the data length', 65535);
    const h = toks.map((t) => t.text).join('');
    if (!/^([0-9a-fA-F]{2})*$/.test(h) || h.length !== n * 2) throw new ZoneError('the \\# data does not match its length', line);
    toks.length = 0;
    const data = Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    return fromRaw(code, data, line);
  }
  switch (code) {
    case 1: { const a = text(); parseIPv4(a); end(); return { type: 'A', address: a }; }
    case 28: { const a = text(); parseIPv6(a); end(); return { type: 'AAAA', address: formatIPv6(parseIPv6(a)) }; }
    case 2: case 5: case 12: { const target = abs(text(), line); end(); return { type: code === 2 ? 'NS' : code === 5 ? 'CNAME' : 'PTR', target }; }
    case 15: { const preference = num('the preference', 65535); const exchange = abs(text(), line); end(); return { type: 'MX', preference, exchange }; }
    case 16: {
      if (toks.length === 0) throw new ZoneError('TXT needs at least one string', line);
      const strings = toks.map((t) => (t.quoted ? t.text : unescape(t.text, line)));
      toks.length = 0;
      return { type: 'TXT', strings };
    }
    case 6: {
      const mname = abs(text(), line); const rname = abs(text(), line);
      const nums: number[] = [];
      for (let i = 0; i < 5; i++) { const s = text(); try { nums.push(i === 0 ? Number(/^[0-9]+$/.test(s) ? s : NaN) : parseTtl(s)); } catch { throw new ZoneError(`${s} is not a number`, line); } }
      end();
      if (nums.some((n) => !Number.isInteger(n))) throw new ZoneError('the SOA serial must be a whole number', line);
      return { type: 'SOA', mname, rname, serial: nums[0]!, refresh: nums[1]!, retry: nums[2]!, expire: nums[3]!, minimum: nums[4]! };
    }
    case 33: { const priority = num('the priority', 65535); const weight = num('the weight', 65535); const port = num('the port', 65535); const target = abs(text(), line); end(); return { type: 'SRV', priority, weight, port, target }; }
    case 257: { const flags = num('the flags', 255); const tag = text(); const t = toks.shift(); if (!t) throw new ZoneError('CAA needs a value', line); end(); return { type: 'CAA', flags, tag, value: t.quoted ? t.text : unescape(t.text, line) }; }
    default: throw new ZoneError(`${typeName(code)} data must be written in the \\# form`, line);
  }
}

function fromRaw(code: number, data: Uint8Array, line: number): Rdata {
  // Reuse the wire reader so a \# form of a known type gives the same record the wire would.
  if (code === 1 || code === 28 || code === 16 || code === 257 || code === 33 || code === 15 || code === 6 || code === 2 || code === 5 || code === 12) {
    try { return readRdata(new Reader(data), code, data.length); } catch (e) { throw new ZoneError((e as Error).message, line); }
  }
  return { type: 'RAW', code, data };
}

// ---------------------------------------------------------------------------------------------------------------
// Zone validation
// ---------------------------------------------------------------------------------------------------------------

export interface Issue { readonly severity: 'error' | 'warning'; readonly name: string; readonly message: string }

/** Checks a zone as a whole: one SOA at the apex, NS at the apex, names inside the zone, CNAME rules, RRset TTLs. */
export function validateZone(records: readonly DnsRecord[], origin: string): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue['severity'], name: string, message: string): void => { issues.push({ severity, name, message }); };
  const apex = canonicalName(origin);
  const byName = new Map<string, DnsRecord[]>();
  for (const r of records) {
    const k = canonicalName(r.name);
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
    if (!isSubdomain(r.name, origin)) add('error', r.name, `is outside the zone ${origin}`);
  }
  const soas = records.filter((r) => r.data.type === 'SOA');
  if (soas.length === 0) add('error', origin, 'the zone has no SOA record');
  if (soas.length > 1) add('error', origin, 'the zone has more than one SOA record');
  for (const s of soas) if (canonicalName(s.name) !== apex) add('error', s.name, 'the SOA record must be at the zone apex');
  if (!(byName.get(apex) ?? []).some((r) => r.data.type === 'NS')) add('error', origin, 'the apex has no NS record');
  const cnames = new Set(records.filter((r) => r.data.type === 'CNAME').map((r) => canonicalName(r.name)));
  for (const [name, rs] of byName) {
    const cn = rs.filter((r) => r.data.type === 'CNAME');
    if (cn.length > 1) add('error', name, 'has more than one CNAME');
    if (cn.length && rs.length > cn.length) add('error', name, 'has a CNAME and other data (RFC 2181 section 10.1)');
    if (cn.length && name === apex) add('error', name, 'a CNAME cannot be at the zone apex');
    const sets = new Map<number, DnsRecord[]>();
    for (const r of rs) (sets.get(recordType(r.data)) ?? sets.set(recordType(r.data), []).get(recordType(r.data))!).push(r);
    for (const [t, set] of sets) {
      if (new Set(set.map((r) => r.ttl)).size > 1) add('warning', name, `${typeName(t)} records have different TTLs (RFC 2181 section 5.2)`);
      const seen = new Set<string>();
      for (const r of set) { const k = `${r.cls} ${formatRdata(r.data).toLowerCase()}`; if (seen.has(k)) add('warning', name, `${typeName(t)} is listed twice with the same data`); seen.add(k); }
    }
  }
  for (const r of records) {
    const d = r.data;
    const target = d.type === 'MX' ? d.exchange : d.type === 'NS' || d.type === 'SRV' ? d.target : undefined;
    if (target === undefined) continue;
    if (cnames.has(canonicalName(target))) add('error', r.name, `${d.type} target ${target} is a CNAME (RFC 2181 sections 10.3 and 10.2)`);
    if (d.type === 'NS' && !isHostname(target)) add('warning', r.name, `NS target ${target} is not a valid host name`);
  }
  return issues;
}
