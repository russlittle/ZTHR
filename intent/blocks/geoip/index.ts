/**
 * MaxMind DB (mmdb) reader, IP range tables, and privacy rules for turning an address into a place. Standard: the
 * MaxMind DB File Format Specification, version 2.0 (binary tree of 24, 28 or 32 bit records, a data section of
 * typed values with pointers, and a metadata map behind the marker "\xAB\xCD\xEFMaxMind.com"). Address forms follow
 * RFC 4291 and RFC 5952; the special-purpose ranges follow RFC 6890 and the IANA registries.
 *
 * What it holds: `MmdbReader` opens a database from bytes, checks it is consistent, and looks up an IPv4 or IPv6
 * address, giving the stored record and the network it covers (IPv4 in an IPv6 database is found through ::/96,
 * and ::ffff:a.b.c.d is looked up as the IPv4 address); `RangeTable` answers "which of my CIDR ranges is the most
 * specific one covering this address" for your own tables (office ranges, VPN ranges, allow and deny lists);
 * `classify` names the special-purpose ranges (private, loopback, link-local, shared, documentation, multicast and
 * so on); `anonymize` truncates an address for logs; `Geolocator` joins a database, your override ranges and a
 * privacy policy so that what leaves it is only as precise as the policy says.
 *
 * Security by default: a database is checked before use (marker, metadata, record size, tree and data bounds, the
 * zero separator); every pointer and record is bounds-checked; a pointer may not point at a pointer; nesting depth
 * and the number of values decoded in one lookup are capped so a crafted file cannot loop or blow up; map keys
 * that look like `__proto__` become plain own properties. Special-purpose addresses never go to the database.
 * Positions are coarsened through the geo block's geohash cells and never finer than precision 6 (about 1.2 km);
 * the postal code is left out unless asked for; a lower level (country, region) leaves out the finer fields.
 *
 * Out of scope: writing databases (the tests build their own), downloading or updating a database, GeoIP legacy
 * formats, memory-mapped files (the whole file is held as bytes), and ASN or anonymous-IP database record shapes
 * beyond returning the stored map as it is.
 */
import { coarsen } from '../geo/index.ts';

export class GeoIpError extends Error {
  constructor(message: string) { super(message); this.name = new.target.name; }
}
/** The database file is not a valid mmdb, or a lookup ran into damaged data. */
export class DatabaseError extends GeoIpError {}
/** An address or CIDR could not be read. */
export class AddressError extends GeoIpError {}

// ---------------------------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------------------------

export interface Ip { readonly version: 4 | 6; readonly bytes: Uint8Array }

function parseV4(s: string): Uint8Array {
  const parts = s.split('.');
  if (parts.length !== 4) throw new AddressError(`${s} is not an IPv4 address`);
  const out = new Uint8Array(4);
  parts.forEach((p, i) => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) throw new AddressError(`${s} is not an IPv4 address`);
    out[i] = Number(p);
  });
  return out;
}

function parseV6(s: string): Uint8Array {
  const bad = (): never => { throw new AddressError(`${s} is not an IPv6 address`); };
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
        const v4 = parseV4(p);
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

const isMapped = (b: Uint8Array): boolean => { for (let i = 0; i < 10; i++) if (b[i] !== 0) return false; return b[10] === 255 && b[11] === 255; };

/** Reads an address. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is returned as the IPv4 address it stands for. */
export function parseIp(s: string): Ip {
  if (typeof s !== 'string' || s.length > 45) throw new AddressError('not an IP address');
  if (s.includes(':')) {
    const b = parseV6(s);
    return isMapped(b) ? { version: 4, bytes: b.slice(12) } : { version: 6, bytes: b };
  }
  return { version: 4, bytes: parseV4(s) };
}

export function formatIp(ip: Ip): string {
  if (ip.version === 4) return Array.from(ip.bytes).join('.');
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((ip.bytes[i]! << 8) | ip.bytes[i + 1]!);
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  if (bestLen < 2) return g.map((x) => x.toString(16)).join(':');
  return `${g.slice(0, best).map((x) => x.toString(16)).join(':')}::${g.slice(best + bestLen).map((x) => x.toString(16)).join(':')}`;
}

const toBig = (b: Uint8Array): bigint => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const fromBig = (n: bigint, len: number): Uint8Array => { const out = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; } return out; };

export interface Cidr { readonly ip: Ip; readonly prefix: number }
export function parseCidr(s: string): Cidr {
  const slash = s.indexOf('/');
  if (slash < 0) throw new AddressError(`${s} needs a /prefix length`);
  const ipText = s.slice(0, slash);
  const lenText = s.slice(slash + 1);
  if (!/^[0-9]{1,3}$/.test(lenText)) throw new AddressError(`${s} has a bad prefix length`);
  const raw = ipText.includes(':') ? { version: 6 as const, bytes: parseV6(ipText) } : { version: 4 as const, bytes: parseV4(ipText) };
  let prefix = Number(lenText);
  // ::ffff:a.b.c.d/96+n is the IPv4 range a.b.c.d/n.
  const ip: Ip = raw.version === 6 && isMapped(raw.bytes) && prefix >= 96 ? { version: 4, bytes: raw.bytes.slice(12) } : raw;
  if (ip !== raw) prefix -= 96;
  if (prefix > (ip.version === 4 ? 32 : 128)) throw new AddressError(`${s} has a prefix longer than the address`);
  const total = ip.version === 4 ? 32 : 128;
  const n = toBig(ip.bytes);
  if (n & ((1n << BigInt(total - prefix)) - 1n)) throw new AddressError(`${s} has bits set after the prefix`);
  return { ip, prefix };
}

/** The address with everything after the first `keep` bits set to zero. */
function truncateBits(ip: Ip, keep: number): Ip {
  const total = ip.bytes.length * 8;
  const n = toBig(ip.bytes) >> BigInt(total - keep) << BigInt(total - keep);
  return { version: ip.version, bytes: fromBig(n, ip.bytes.length) };
}

export interface AnonymizeOptions { readonly v4Prefix?: number; readonly v6Prefix?: number }
/**
 * An address shortened for logs and counters: by default the last octet of an IPv4 address (keeping 24 bits) and
 * everything after the first 48 bits of an IPv6 address. The result is a network address, not a person.
 */
export function anonymize(address: string, o: AnonymizeOptions = {}): string {
  const ip = parseIp(address);
  const keep = ip.version === 4 ? o.v4Prefix ?? 24 : o.v6Prefix ?? 48;
  const max = ip.version === 4 ? 32 : 128;
  if (!Number.isInteger(keep) || keep < 0 || keep > max) throw new AddressError('the prefix to keep is out of range');
  return formatIp(truncateBits(ip, keep));
}

// ---------------------------------------------------------------------------------------------------------------
// Range tables
// ---------------------------------------------------------------------------------------------------------------

export interface RangeEntry<T> { readonly cidr: string; readonly value: T }
interface Segment<T> { readonly start: bigint; readonly end: bigint; readonly entry: RangeEntry<T>; readonly prefix: number }

/**
 * CIDR ranges with a value each. A lookup returns the most specific range that covers the address, whatever order
 * the ranges were given in. IPv4 and IPv6 ranges are kept apart; an IPv4-mapped IPv6 address is looked up as IPv4.
 */
export class RangeTable<T> {
  readonly #v4: Segment<T>[];
  readonly #v6: Segment<T>[];
  readonly size: number;

  constructor(entries: readonly RangeEntry<T>[]) {
    const four: Segment<T>[] = []; const six: Segment<T>[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const c = parseCidr(e.cidr);
      const total = c.ip.version === 4 ? 32 : 128;
      const start = toBig(c.ip.bytes);
      const key = `${c.ip.version}/${start}/${c.prefix}`;
      if (seen.has(key)) throw new AddressError(`${e.cidr} is listed twice`);
      seen.add(key);
      (c.ip.version === 4 ? four : six).push({ start, end: start + (1n << BigInt(total - c.prefix)) - 1n, entry: e, prefix: c.prefix });
    }
    this.#v4 = RangeTable.#flatten(four);
    this.#v6 = RangeTable.#flatten(six);
    this.size = entries.length;
  }

  /** Turn nested and disjoint ranges into disjoint segments, the innermost range winning where they overlap. */
  static #flatten<U>(list: Segment<U>[]): Segment<U>[] {
    list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.prefix - b.prefix));
    const out: Segment<U>[] = [];
    const stack: Segment<U>[] = [];
    let cursor = 0n;
    const emit = (s: Segment<U>, upTo: bigint): void => { if (cursor <= upTo) { out.push({ ...s, start: cursor, end: upTo }); } cursor = upTo + 1n; };
    for (const e of list) {
      while (stack.length && stack[stack.length - 1]!.end < e.start) { const top = stack.pop()!; emit(top, top.end); }
      const top = stack[stack.length - 1];
      if (top) emit(top, e.start - 1n);
      cursor = e.start;
      stack.push(e);
    }
    while (stack.length) { const top = stack.pop()!; emit(top, top.end); }
    return out;
  }

  lookup(address: string): RangeEntry<T> | undefined {
    const ip = parseIp(address);
    const segs = ip.version === 4 ? this.#v4 : this.#v6;
    const n = toBig(ip.bytes);
    let lo = 0; let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid]!;
      if (n < s.start) hi = mid - 1;
      else if (n > s.end) lo = mid + 1;
      else return s.entry;
    }
    return undefined;
  }
  has(address: string): boolean { return this.lookup(address) !== undefined; }
}

const SPECIAL = new RangeTable<string>([
  ['0.0.0.0/8', 'this-network'], ['10.0.0.0/8', 'private'], ['100.64.0.0/10', 'shared'], ['127.0.0.0/8', 'loopback'], ['169.254.0.0/16', 'link-local'],
  ['172.16.0.0/12', 'private'], ['192.0.0.0/24', 'protocol'], ['192.0.2.0/24', 'documentation'], ['192.168.0.0/16', 'private'], ['198.18.0.0/15', 'benchmarking'],
  ['198.51.100.0/24', 'documentation'], ['203.0.113.0/24', 'documentation'], ['224.0.0.0/4', 'multicast'], ['240.0.0.0/4', 'reserved'],
  ['::/128', 'unspecified'], ['::1/128', 'loopback'], ['100::/64', 'discard'], ['2001:db8::/32', 'documentation'], ['fc00::/7', 'private'], ['fe80::/10', 'link-local'], ['ff00::/8', 'multicast'],
].map(([cidr, value]) => ({ cidr: cidr!, value: value! })));

/** 'public' for an address that can be on the open internet, otherwise the kind of special-purpose range it is in. */
export function classify(address: string): string { return SPECIAL.lookup(address)?.value ?? 'public'; }
export function isPublic(address: string): boolean { return classify(address) === 'public'; }

// ---------------------------------------------------------------------------------------------------------------
// The data section
// ---------------------------------------------------------------------------------------------------------------

export type MmdbValue = string | number | bigint | boolean | Uint8Array | MmdbValue[] | { [key: string]: MmdbValue };

export interface DecodeLimits { readonly maxDepth?: number; readonly maxValues?: number }

class Decoder {
  readonly #buf: Uint8Array;
  readonly #start: number;
  readonly #end: number;
  readonly #maxDepth: number;
  #budget: number;
  constructor(buf: Uint8Array, start: number, end: number, limits: DecodeLimits) {
    this.#buf = buf; this.#start = start; this.#end = end;
    this.#maxDepth = limits.maxDepth ?? 32;
    this.#budget = limits.maxValues ?? 20_000;
  }
  #fail(message: string): never { throw new DatabaseError(message); }
  #need(pos: number, n: number): void { if (pos < this.#start || n < 0 || pos + n > this.#end) this.#fail('the data runs past the end of its section'); }
  #uint(pos: number, n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this.#buf[pos + i]!; return v; }

  /** Decode the value at `offset` (relative to the start of the section). Returns the value and the offset after it. */
  decode(offset: number): { value: MmdbValue; next: number } { return this.#value(this.#start + offset, 0, true); }

  #value(pos: number, depth: number, allowPointer: boolean): { value: MmdbValue; next: number } {
    if (depth > this.#maxDepth) this.#fail('the data is nested too deeply');
    if (--this.#budget < 0) this.#fail('a record holds too many values');
    this.#need(pos, 1);
    const ctrl = this.#buf[pos++]!;
    let type = ctrl >> 5;
    if (type === 1) {
      if (!allowPointer) this.#fail('a pointer may not point at a pointer');
      const ss = (ctrl >> 3) & 3;
      const vvv = ctrl & 7;
      const n = ss === 3 ? 4 : ss + 1;
      this.#need(pos, n);
      let target: number;
      if (ss === 0) target = (vvv << 8) | this.#buf[pos]!;
      else if (ss === 1) target = ((vvv << 16) | this.#uint(pos, 2)) + 2048;
      else if (ss === 2) target = ((vvv << 24) | this.#uint(pos, 3)) + 526336;
      else target = this.#uint(pos, 4);
      const got = this.#value(this.#start + target, depth, false);
      return { value: got.value, next: pos + n };
    }
    if (type === 0) {
      this.#need(pos, 1);
      type = 7 + this.#buf[pos++]!;
      if (type < 8) this.#fail('an extended type that cannot exist');
    }
    let size = ctrl & 31;
    if (size === 29) { this.#need(pos, 1); size = 29 + this.#buf[pos]!; pos += 1; }
    else if (size === 30) { this.#need(pos, 2); size = 285 + this.#uint(pos, 2); pos += 2; }
    else if (size === 31) { this.#need(pos, 3); size = 65821 + this.#uint(pos, 3); pos += 3; }
    switch (type) {
      case 2: { this.#need(pos, size); let s: string; try { s = new TextDecoder('utf-8', { fatal: true }).decode(this.#buf.subarray(pos, pos + size)); } catch { this.#fail('a string is not valid UTF-8'); } return { value: s, next: pos + size }; }
      case 3: if (size !== 8) this.#fail('a double must be 8 bytes'); this.#need(pos, 8); return { value: new DataView(this.#buf.buffer, this.#buf.byteOffset + pos, 8).getFloat64(0), next: pos + 8 };
      case 15: if (size !== 4) this.#fail('a float must be 4 bytes'); this.#need(pos, 4); return { value: new DataView(this.#buf.buffer, this.#buf.byteOffset + pos, 4).getFloat32(0), next: pos + 4 };
      case 4: this.#need(pos, size); return { value: this.#buf.slice(pos, pos + size), next: pos + size };
      case 5: case 6: { const max = type === 5 ? 2 : 4; if (size > max) this.#fail('an unsigned integer is wider than its type'); this.#need(pos, size); return { value: this.#uint(pos, size), next: pos + size }; }
      case 8: {
        if (size > 4) this.#fail('an int32 is wider than 4 bytes');
        this.#need(pos, size);
        const u = this.#uint(pos, size);
        return { value: size === 4 ? u | 0 : u, next: pos + size };
      }
      case 9: case 10: {
        if (size > (type === 9 ? 8 : 16)) this.#fail('an unsigned integer is wider than its type');
        this.#need(pos, size);
        let v = 0n;
        for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(this.#buf[pos + i]!);
        return { value: v, next: pos + size };
      }
      case 14: if (size > 1) this.#fail('a boolean is 0 or 1'); return { value: size === 1, next: pos };
      case 11: {
        const out: MmdbValue[] = [];
        for (let i = 0; i < size; i++) { const el = this.#value(pos, depth + 1, true); out.push(el.value); pos = el.next; }
        return { value: out, next: pos };
      }
      case 7: {
        if (size * 2 > this.#end - pos) this.#fail('a map claims more entries than there are bytes');
        const out: { [key: string]: MmdbValue } = {};
        for (let i = 0; i < size; i++) {
          const k = this.#value(pos, depth + 1, true);
          if (typeof k.value !== 'string') this.#fail('a map key is not a string');
          const v = this.#value(k.next, depth + 1, true);
          Object.defineProperty(out, k.value, { value: v.value, enumerable: true, writable: true, configurable: true });
          pos = v.next;
        }
        return { value: out, next: pos };
      }
      default: return this.#fail(`unsupported data type ${type}`);
    }
  }
}

/** Decode one value from a buffer that starts at a data section (used for the metadata map and in tests). */
export function decodeValue(buf: Uint8Array, offset = 0, limits: DecodeLimits = {}): { value: MmdbValue; next: number } {
  const d = new Decoder(buf, 0, buf.length, limits);
  return d.decode(offset);
}

// ---------------------------------------------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------------------------------------------

export interface Metadata {
  readonly nodeCount: number;
  readonly recordSize: 24 | 28 | 32;
  readonly ipVersion: 4 | 6;
  readonly databaseType: string;
  readonly languages: readonly string[];
  readonly buildEpoch: number;
  readonly description: Readonly<Record<string, string>>;
  readonly binaryFormat: string;
}
export interface Lookup {
  readonly record: MmdbValue;
  /** The network the record applies to, in the family of the address asked for. */
  readonly network: string;
  readonly prefixLength: number;
}

const MARKER = Uint8Array.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);
const MAX_METADATA = 128 * 1024;

export class MmdbReader {
  readonly metadata: Metadata;
  readonly #buf: Uint8Array;
  readonly #treeSize: number;
  readonly #dataEnd: number;
  readonly #limits: DecodeLimits;

  private constructor(buf: Uint8Array, metadata: Metadata, treeSize: number, dataEnd: number, limits: DecodeLimits) {
    this.#buf = buf; this.metadata = metadata; this.#treeSize = treeSize; this.#dataEnd = dataEnd; this.#limits = limits;
  }

  static open(bytes: Uint8Array, limits: DecodeLimits = {}): MmdbReader {
    const fail = (m: string): never => { throw new DatabaseError(m); };
    const buf = bytes;
    const from = Math.max(0, buf.length - MAX_METADATA - MARKER.length);
    const found = Buffer.from(buf.buffer, buf.byteOffset, buf.length).lastIndexOf(MARKER, buf.length, 'binary');
    if (found < from) fail('the file has no MaxMind metadata marker');
    const metaStart = found + MARKER.length;
    const meta = decodeValue(buf.subarray(metaStart), 0, limits).value;
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || meta instanceof Uint8Array) return fail('the metadata is not a map');
    const m = meta as { [k: string]: MmdbValue };
    const num = (k: string): number => { const v = m[k]; if (typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v); if (typeof v !== 'number') return fail(`metadata ${k} is missing`); return v; };
    const nodeCount = num('node_count');
    const recordSize = num('record_size');
    const ipVersion = num('ip_version');
    const major = num('binary_format_major_version');
    if (major !== 2) fail(`binary format version ${major} is not supported`);
    if (recordSize !== 24 && recordSize !== 28 && recordSize !== 32) fail('record_size must be 24, 28 or 32');
    if (ipVersion !== 4 && ipVersion !== 6) fail('ip_version must be 4 or 6');
    if (typeof m.database_type !== 'string') fail('metadata database_type is missing');
    const buildEpoch = typeof m.build_epoch === 'bigint' ? Number(m.build_epoch) : typeof m.build_epoch === 'number' ? m.build_epoch : 0;
    const languages = Array.isArray(m.languages) ? m.languages.filter((x): x is string => typeof x === 'string') : [];
    const description: Record<string, string> = {};
    if (m.description && typeof m.description === 'object' && !Array.isArray(m.description) && !(m.description instanceof Uint8Array)) for (const [k, v] of Object.entries(m.description)) if (typeof v === 'string') Object.defineProperty(description, k, { value: v, enumerable: true, writable: true, configurable: true });
    const treeSize = nodeCount * (recordSize / 4);
    if (!Number.isSafeInteger(treeSize) || nodeCount < 1 || treeSize + 16 > found) fail('the search tree does not fit in the file');
    for (let i = 0; i < 16; i++) if (buf[treeSize + i] !== 0) fail('the data section separator is not zero');
    const metadata: Metadata = { nodeCount, recordSize: recordSize as 24 | 28 | 32, ipVersion: ipVersion as 4 | 6, databaseType: m.database_type as string, languages, buildEpoch, description, binaryFormat: `${major}.${typeof m.binary_format_minor_version === 'number' ? m.binary_format_minor_version : 0}` };
    return new MmdbReader(buf, metadata, treeSize, found, limits);
  }

  #record(node: number, bit: number): number {
    const b = this.#buf;
    const off = node * (this.metadata.recordSize / 4);
    switch (this.metadata.recordSize) {
      case 24: { const p = off + bit * 3; return (b[p]! << 16) | (b[p + 1]! << 8) | b[p + 2]!; }
      case 28: {
        const mid = b[off + 3]!;
        if (bit === 0) return ((mid >> 4) << 24) | (b[off]! << 16) | (b[off + 1]! << 8) | b[off + 2]!;
        return ((mid & 15) << 24) | (b[off + 4]! << 16) | (b[off + 5]! << 8) | b[off + 6]!;
      }
      default: { const p = off + bit * 4; return b[p]! * 0x1000000 + ((b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!); }
    }
  }

  /** The record for an address, or null when the database has none. Throws AddressError for text that is not an address. */
  lookup(address: string): Lookup | null {
    const ip = parseIp(address);
    if (ip.version === 6 && this.metadata.ipVersion === 4) throw new AddressError('this database holds IPv4 addresses only');
    const lead = ip.version === 4 && this.metadata.ipVersion === 6 ? 96 : 0;
    const bits = lead + ip.bytes.length * 8;
    const nodeCount = this.metadata.nodeCount;
    let node = 0;
    let used = 0;
    while (used < bits && node < nodeCount) {
      const bit = used < lead ? 0 : (ip.bytes[(used - lead) >> 3]! >> (7 - ((used - lead) & 7))) & 1;
      node = this.#record(node, bit);
      used++;
    }
    if (node === nodeCount) return null;
    if (node < nodeCount) throw new DatabaseError('the search tree is deeper than the address');
    const rel = node - nodeCount - 16;
    const dataLen = this.#dataEnd - (this.#treeSize + 16);
    if (rel < 0 || rel >= dataLen) throw new DatabaseError('a record points outside the data section');
    const d = new Decoder(this.#buf, this.#treeSize + 16, this.#dataEnd, this.#limits);
    const record = d.decode(rel).value;
    const prefixLength = Math.max(0, used - lead);
    const network = `${formatIp(truncateBits(ip, prefixLength))}/${prefixLength}`;
    return { record, network, prefixLength };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// From an address to a place
// ---------------------------------------------------------------------------------------------------------------

export type Level = 'country' | 'region' | 'city' | 'point';
export interface Policy {
  /** The most detail ever returned. Default 'region'. */
  readonly level?: Level;
  /** Geohash precision for coordinates at the 'point' level, 3 to 6. Default 5 (about 5 km cells). */
  readonly precision?: number;
  /** Include the postal code at the 'city' and 'point' levels. Default false. */
  readonly includePostal?: boolean;
  /** Language codes to take names in, best first. English is always tried last. */
  readonly languages?: readonly string[];
}
export interface Override { readonly label: string; readonly country?: string }

export interface Place {
  readonly status: 'found';
  readonly network: string;
  readonly level: Level;
  readonly continent?: string;
  readonly country?: { readonly code: string; readonly name?: string };
  readonly region?: { readonly code?: string; readonly name?: string };
  readonly city?: string;
  readonly postal?: string;
  readonly timeZone?: string;
  readonly point?: { readonly lat: number; readonly lng: number };
  /** The size in kilometres that the position is good to: the larger of the database's radius and the cell. */
  readonly accuracyKm?: number;
  readonly label?: string;
}
export type Located = Place | { readonly status: 'reserved'; readonly kind: string } | { readonly status: 'unknown' } | { readonly status: 'hidden'; readonly label: string };

const CELL_KM: Record<number, number> = { 3: 156, 4: 39, 5: 4.9, 6: 1.2 };
const LEVELS: readonly Level[] = ['country', 'region', 'city', 'point'];
export const MIN_COARSE_PRECISION = 3;
export const MAX_PRECISION = 6;

export interface GeolocatorOptions {
  readonly db: MmdbReader;
  readonly policy?: Policy;
  /** Your own ranges, checked first: a range with no country is hidden, one with a country returns only that country. */
  readonly overrides?: RangeTable<Override>;
  readonly now: () => number;
  /** How many days old the database may get before `stale()` says so. Default 60. */
  readonly staleAfterDays?: number;
}

type Obj = { [k: string]: MmdbValue };
const isObj = (v: MmdbValue | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
const str = (v: MmdbValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const numOf = (v: MmdbValue | undefined): number | undefined => (typeof v === 'number' ? v : undefined);

export class Geolocator {
  readonly #o: GeolocatorOptions;
  readonly #level: Level;
  readonly #precision: number;

  constructor(o: GeolocatorOptions) {
    this.#o = o;
    this.#level = o.policy?.level ?? 'region';
    if (!LEVELS.includes(this.#level)) throw new GeoIpError(`level ${String(this.#level)} is not one of ${LEVELS.join(', ')}`);
    this.#precision = o.policy?.precision ?? 5;
    if (!Number.isInteger(this.#precision) || this.#precision < MIN_COARSE_PRECISION || this.#precision > MAX_PRECISION) throw new GeoIpError(`precision must be ${MIN_COARSE_PRECISION} to ${MAX_PRECISION}: finer positions are never returned`);
  }

  /** The database's age against the limit. */
  stale(): { builtAt: Date; ageDays: number; stale: boolean } {
    const builtAt = new Date(this.#o.db.metadata.buildEpoch * 1000);
    const ageDays = Math.floor((this.#o.now() - builtAt.getTime()) / 86_400_000);
    return { builtAt, ageDays, stale: ageDays > (this.#o.staleAfterDays ?? 60) };
  }

  #name(v: MmdbValue | undefined): string | undefined {
    if (!isObj(v)) return undefined;
    const names = v.names;
    if (!isObj(names)) return undefined;
    for (const lang of [...(this.#o.policy?.languages ?? []), 'en']) { const n = str(names[lang]); if (n !== undefined) return n; }
    return undefined;
  }

  locate(address: string): Located {
    const kind = classify(address);
    if (kind !== 'public') return { status: 'reserved', kind };
    const ov = this.#o.overrides?.lookup(address);
    if (ov) {
      if (ov.value.country === undefined) return { status: 'hidden', label: ov.value.label };
      return { status: 'found', network: ov.cidr, level: 'country', country: { code: ov.value.country }, label: ov.value.label };
    }
    const hit = this.#o.db.lookup(address);
    if (!hit || !isObj(hit.record)) return { status: 'unknown' };
    const r = hit.record;
    const rank = LEVELS.indexOf(this.#level);
    const out: { -readonly [K in keyof Place]: Place[K] } = { status: 'found', network: hit.network, level: this.#level };
    const continent = isObj(r.continent) ? str(r.continent.code) : undefined;
    if (continent !== undefined) out.continent = continent;
    const country = isObj(r.country) ? r.country : isObj(r.registered_country) ? r.registered_country : undefined;
    const code = country ? str(country.iso_code) : undefined;
    if (code !== undefined) { const name = this.#name(country); out.country = name === undefined ? { code } : { code, name }; }
    if (rank >= 1) {
      const sub = Array.isArray(r.subdivisions) && isObj(r.subdivisions[0]) ? r.subdivisions[0] : undefined;
      if (sub) {
        const rc = str(sub.iso_code); const rn = this.#name(sub);
        if (rc !== undefined || rn !== undefined) out.region = { ...(rc !== undefined ? { code: rc } : {}), ...(rn !== undefined ? { name: rn } : {}) };
      }
      const loc = isObj(r.location) ? r.location : undefined;
      const tz = loc ? str(loc.time_zone) : undefined;
      if (tz !== undefined) out.timeZone = tz;
    }
    if (rank >= 2) {
      const city = this.#name(r.city);
      if (city !== undefined) out.city = city;
      const postal = isObj(r.postal) ? str(r.postal.code) : undefined;
      if (postal !== undefined && this.#o.policy?.includePostal === true) out.postal = postal;
    }
    if (rank >= 2) {
      const loc = isObj(r.location) ? r.location : undefined;
      const lat = loc ? numOf(loc.latitude) : undefined; const lng = loc ? numOf(loc.longitude) : undefined;
      if (lat !== undefined && lng !== undefined) {
        const precision = rank === 3 ? this.#precision : 4;
        const p = coarsen({ lat, lng }, precision);
        out.point = { lat: p.lat, lng: p.lng };
        out.accuracyKm = Math.max(CELL_KM[precision]!, numOf(loc!.accuracy_radius) ?? 0);
      }
    }
    return out;
  }
}
