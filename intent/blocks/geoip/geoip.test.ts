import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coarsen } from '../geo/index.ts';
import { AddressError, DatabaseError, Geolocator, MmdbReader, RangeTable, anonymize, classify, decodeValue, formatIp, isPublic, parseCidr, parseIp } from './index.ts';
import type { MmdbValue } from './index.ts';

// ---- a small mmdb writer, only for building fixtures -------------------------------------------------------------

class Tag {
  readonly kind: string;
  readonly v: number | bigint;
  constructor(kind: string, v: number | bigint) { this.kind = kind; this.v = v; }
}
const u16 = (v: number) => new Tag('u16', v);
const u32 = (v: number) => new Tag('u32', v);
const u64 = (v: bigint) => new Tag('u64', v);
const i32 = (v: number) => new Tag('i32', v);
const dbl = (v: number) => new Tag('dbl', v);
class Ptr {
  readonly offset: number;
  constructor(offset: number) { this.offset = offset; }
}

const head = (type: number, size: number): number[] => {
  let sb: number; let extra: number[] = [];
  if (size < 29) sb = size;
  else if (size < 285) { sb = 29; extra = [size - 29]; }
  else if (size < 65821) { sb = 30; const x = size - 285; extra = [x >> 8, x & 255]; }
  else { sb = 31; const x = size - 65821; extra = [x >> 16, (x >> 8) & 255, x & 255]; }
  return type <= 7 ? [(type << 5) | sb, ...extra] : [sb, type - 7, ...extra];
};
const be = (n: bigint | number, len: number): number[] => { let v = BigInt(n); const out: number[] = []; for (let i = 0; i < len; i++) { out.unshift(Number(v & 255n)); v >>= 8n; } return out; };
const trim = (b: number[]): number[] => { let i = 0; while (i < b.length && b[i] === 0) i++; return b.slice(i); };
const ptr = (offset: number): number[] => {
  if (offset < 2048) return [0x20 | (offset >> 8), offset & 255];
  if (offset < 2048 + 524288) { const v = offset - 2048; return [0x28 | (v >> 16), (v >> 8) & 255, v & 255]; }
  if (offset < 526336 + 134217728) { const v = offset - 526336; return [0x30 | (v >> 24), (v >> 16) & 255, (v >> 8) & 255, v & 255]; }
  return [0x38, ...be(offset, 4)];
};
type V = string | boolean | Uint8Array | Tag | Ptr | V[] | { [k: string]: V };
function enc(v: V): number[] {
  if (v instanceof Ptr) return ptr(v.offset);
  if (typeof v === 'string') { const b = [...Buffer.from(v)]; return [...head(2, b.length), ...b]; }
  if (typeof v === 'boolean') return [v ? 1 : 0, 7];
  if (v instanceof Uint8Array) return [...head(4, v.length), ...v];
  if (v instanceof Tag) {
    switch (v.kind) {
      case 'u16': { const b = trim(be(v.v, 2)); return [...head(5, b.length), ...b]; }
      case 'u32': { const b = trim(be(v.v, 4)); return [...head(6, b.length), ...b]; }
      case 'u64': { const b = trim(be(v.v, 8)); return [...head(9, b.length), ...b]; }
      case 'i32': return [...head(8, 4), ...be(BigInt.asUintN(32, BigInt(v.v)), 4)];
      default: { const d = Buffer.alloc(8); d.writeDoubleBE(Number(v.v)); return [...head(3, 8), ...d]; }
    }
  }
  if (Array.isArray(v)) return [...head(11, v.length), ...v.flatMap(enc)];
  const keys = Object.keys(v);
  return [...head(7, keys.length), ...keys.flatMap((k) => [...enc(k), ...enc(v[k]!)])];
}

type Child = { t: 'empty' } | { t: 'node'; i: number } | { t: 'data'; off: number };
interface Built { readonly bytes: Uint8Array; readonly offsets: number[] }
function buildDb(o: { ipVersion: 4 | 6; recordSize: 24 | 28 | 32; entries: [string, V][]; data?: number[]; raw?: { node0?: [number, number] }; meta?: Record<string, V>; shared?: V[] }): Built {
  const data: number[] = [...(o.data ?? [])];
  const offsets: number[] = [];
  const nodes: [Child, Child][] = [[{ t: 'empty' }, { t: 'empty' }]];
  const insert = (bits: number[], off: number): void => {
    let n = 0;
    bits.forEach((b, i) => {
      if (i === bits.length - 1) { nodes[n]![b] = { t: 'data', off }; return; }
      const c = nodes[n]![b]!;
      if (c.t === 'node') { n = c.i; return; }
      const idx = nodes.push([c, c]) - 1;
      nodes[n]![b] = { t: 'node', i: idx };
      n = idx;
    });
  };
  const bitsOf = (cidr: string): number[] => {
    const c = parseCidr(cidr);
    const bits: number[] = [];
    for (let i = 0; i < c.prefix; i++) bits.push((c.ip.bytes[i >> 3]! >> (7 - (i & 7))) & 1);
    return c.ip.version === 4 && o.ipVersion === 6 ? [...new Array<number>(96).fill(0), ...bits] : bits;
  };
  const rows = o.entries.map(([cidr, v]) => { const at = data.length; data.push(...enc(v)); offsets.push(at); return { bits: bitsOf(cidr), at }; });
  rows.sort((a, b) => a.bits.length - b.bits.length);
  for (const r of rows) insert(r.bits, r.at);
  // Merge a node whose two sides are the same data (or both empty), as a real writer does, then number the rest.
  const final: [Child, Child][] = [];
  const same = (a: Child, b: Child): boolean => (a.t === 'empty' && b.t === 'empty') || (a.t === 'data' && b.t === 'data' && a.off === b.off);
  const collapse = (c: Child): Child => {
    if (c.t !== 'node') return c;
    const l = collapse(nodes[c.i]![0]); const r = collapse(nodes[c.i]![1]);
    if (same(l, r)) return l;
    const idx = final.push([l, r]) - 1;
    return { t: 'node', i: idx };
  };
  const rootIdx = final.push([{ t: 'empty' }, { t: 'empty' }]) - 1;
  final[rootIdx] = [collapse(nodes[0]![0]), collapse(nodes[0]![1])];
  nodes.length = 0; nodes.push(...final);
  const count = nodes.length;
  const val = (c: Child): number => (c.t === 'empty' ? count : c.t === 'node' ? c.i : count + 16 + c.off);
  const tree: number[] = [];
  nodes.forEach((n, idx) => {
    let [l, r] = [val(n[0]), val(n[1])];
    if (idx === 0 && o.raw?.node0) [l, r] = o.raw.node0;
    if (o.recordSize === 24) tree.push(...be(l, 3), ...be(r, 3));
    else if (o.recordSize === 28) tree.push(...be(l & 0xffffff, 3), ((l >> 24) << 4) | (r >> 24), ...be(r & 0xffffff, 3));
    else tree.push(...be(l, 4), ...be(r, 4));
  });
  const meta = enc({ node_count: u32(count), record_size: u16(o.recordSize), ip_version: u16(o.ipVersion), database_type: 'Test-City', languages: ['en', 'de'], binary_format_major_version: u16(2), binary_format_minor_version: u16(0), build_epoch: u64(1_700_000_000n), description: { en: 'a test database' }, ...(o.meta ?? {}) });
  return { bytes: Uint8Array.from([...tree, ...new Array<number>(16).fill(0), ...data, 0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com'), ...meta]), offsets };
}

const LONDON = { city: { names: { en: 'London', de: 'London' } }, continent: { code: 'EU' }, country: { iso_code: 'GB', names: { en: 'United Kingdom', de: 'Vereinigtes Königreich' } }, location: { accuracy_radius: u16(10), latitude: dbl(51.5142), longitude: dbl(-0.0931), time_zone: 'Europe/London' }, postal: { code: 'EC1' }, subdivisions: [{ iso_code: 'ENG', names: { en: 'England' } }] };
const PARIS = { city: { names: { en: 'Paris' } }, continent: { code: 'EU' }, country: { iso_code: 'FR', names: { en: 'France' } }, location: { accuracy_radius: u16(50), latitude: dbl(48.8566), longitude: dbl(2.3522), time_zone: 'Europe/Paris' } };
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x instanceof Tag ? Number(x.v) : x)));

// ---- tests -----------------------------------------------------------------------------------------------------

test('data types decode as the MaxMind DB spec lays them out', () => {
  const d = (hex: string): MmdbValue => decodeValue(Uint8Array.from(Buffer.from(hex.replace(/\s/g, ''), 'hex'))).value;
  assert.equal(d('45 68656c6c6f'), 'hello');
  assert.equal(d('a2 0102'), 258);
  assert.equal(d('c1 ff'), 255);
  assert.equal(d('68 400921fb54442d18'), Math.PI);
  assert.equal(d('04 08 3fc00000'), 1.5);
  assert.equal(d('04 01 ffffffff'), -1);
  assert.equal(d('02 02 0100'), 256n);
  assert.equal(d('01 03 ff'), 255n);
  assert.deepEqual([d('01 07'), d('00 07')], [true, false]);
  assert.deepEqual(d('02 04 4161 4162'), ['a', 'b']);
  assert.deepEqual(d('e1 4161 4162'), { a: 'b' });
  assert.deepEqual(d('83 010203'), Uint8Array.of(1, 2, 3));
  assert.deepEqual(d('00 04'), []);
});

test('long sizes use the 29, 30 and 31 forms', () => {
  const s = (n: number) => decodeValue(Uint8Array.from(enc('x'.repeat(n)))).value as string;
  assert.equal(enc('x'.repeat(28))[0], 0x5c);
  assert.equal(enc('x'.repeat(29))[0], 0x5d);
  assert.equal(enc('x'.repeat(285))[0], 0x5e);
  assert.equal(enc('x'.repeat(65821))[0], 0x5f);
  for (const n of [0, 28, 29, 284, 285, 65820, 65821, 70000]) assert.equal(s(n).length, n);
});

test('pointers of all four widths reach their value, and a pointer to a pointer is refused', () => {
  for (const at of [6, 2100, 600_000, 700_000]) {
    const buf = new Uint8Array(at + 20);
    buf.set(enc('hello'), at);
    const p = ptr(at);
    buf.set(p, 0);
    assert.equal(decodeValue(buf, 0).value, 'hello', `pointer to ${at} is ${p.length} bytes`);
    assert.equal(decodeValue(buf, 0).next, p.length);
  }
  assert.deepEqual([ptr(5).length, ptr(2100).length, ptr(600000).length, ptr(0x10000000).length], [2, 3, 4, 5]);
  assert.throws(() => decodeValue(Uint8Array.from([...ptr(2), ...ptr(4), ...enc('x')]), 0), /pointer may not point at a pointer/);
  assert.throws(() => decodeValue(Uint8Array.from(ptr(900)), 0), /past the end/);
});

test('a database opens: metadata, record sizes and a lookup that misses', () => {
  const db = buildDb({ ipVersion: 4, recordSize: 24, entries: [['81.2.69.0/24', LONDON]] });
  const r = MmdbReader.open(db.bytes);
  assert.deepEqual([r.metadata.recordSize, r.metadata.ipVersion, r.metadata.databaseType, r.metadata.languages, r.metadata.buildEpoch, r.metadata.binaryFormat], [24, 4, 'Test-City', ['en', 'de'], 1_700_000_000, '2.0']);
  assert.deepEqual(r.metadata.description, { en: 'a test database' });
  assert.equal(r.lookup('8.8.8.8'), null);
});

for (const recordSize of [24, 28, 32] as const) {
  test(`lookups with ${recordSize}-bit records return the most specific network`, () => {
    const db = buildDb({ ipVersion: 4, recordSize, entries: [['81.2.69.0/24', LONDON], ['81.2.69.128/25', PARIS], ['1.0.0.0/8', { x: u16(1) }], ['200.200.200.200/32', { host: true }]] });
    const r = MmdbReader.open(db.bytes);
    const a = r.lookup('81.2.69.10')!;
    // a tree cannot say "the /24 except its upper half", so the lower half is its own /25 node
    assert.deepEqual([a.network, a.prefixLength, (plain(a.record) as { country: { iso_code: string } }).country.iso_code], ['81.2.69.0/25', 25, 'GB']);
    const b = r.lookup('81.2.69.200')!;
    assert.deepEqual([b.network, b.prefixLength, (plain(b.record) as { country: { iso_code: string } }).country.iso_code], ['81.2.69.128/25', 25, 'FR']);
    assert.deepEqual(plain(r.lookup('1.2.3.4')!.record), { x: 1 });
    assert.deepEqual([r.lookup('200.200.200.200')!.network, r.lookup('200.200.200.201')], ['200.200.200.200/32', null]);
    assert.equal(r.lookup('81.2.70.1'), null);
  });
}

test('an IPv6 database finds IPv4 addresses through ::/96 and takes ::ffff:a.b.c.d as IPv4', () => {
  const db = buildDb({ ipVersion: 6, recordSize: 28, entries: [['81.2.69.0/24', LONDON], ['2001:db8::/32', PARIS], ['2001:db8:1::/48', { deep: true }]] });
  const r = MmdbReader.open(db.bytes);
  const a = r.lookup('81.2.69.77')!;
  assert.deepEqual([a.network, a.prefixLength], ['81.2.69.0/24', 24], 'reported as the IPv4 network');
  assert.equal(r.lookup('::ffff:81.2.69.77')!.network, '81.2.69.0/24');
  const b = r.lookup('2001:db8:ffff::1')!;
  assert.deepEqual([b.network, b.prefixLength], ['2001:db8:8000::/33', 33]);
  assert.deepEqual([r.lookup('2001:db8:1::5')!.network, plain(r.lookup('2001:db8:1::5')!.record)], ['2001:db8:1::/48', { deep: true }]);
  assert.equal(r.lookup('2001:db9::1'), null);
  assert.equal(r.lookup('9.9.9.9'), null);
});

test('addresses: strict forms, mapped addresses and formatting', () => {
  assert.deepEqual(parseIp('::ffff:1.2.3.4'), { version: 4, bytes: Uint8Array.of(1, 2, 3, 4) });
  assert.equal(formatIp(parseIp('2001:DB8:0:0:1:0:0:1')), '2001:db8::1:0:0:1');
  for (const bad of ['', '1.2.3', '1.2.3.4.5', '01.2.3.4', '256.1.1.1', '1.2.3.4 ', 'fe80::1%eth0', ':::', 'abc', '1.2.3.4/24', '0x7f.0.0.1']) assert.throws(() => parseIp(bad), AddressError, bad);
  assert.throws(() => parseCidr('10.0.0.1/8'), /bits set after the prefix/);
  assert.throws(() => parseCidr('10.0.0.0/33'), /longer than the address/);
  assert.throws(() => parseCidr('10.0.0.0'), /prefix length/);
  assert.deepEqual(parseCidr('::ffff:10.0.0.0/104'), { ip: { version: 4, bytes: Uint8Array.of(10, 0, 0, 0) }, prefix: 8 });
  const v4Only = MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [['1.0.0.0/8', 'x']] }).bytes);
  assert.throws(() => v4Only.lookup('2001:db8::1'), /IPv4 addresses only/);
  assert.throws(() => v4Only.lookup('nonsense'), AddressError);
});

test('shared values are stored once and reached by pointer', () => {
  const shared = { iso_code: 'GB', names: { en: 'United Kingdom' } };
  const at = 0;
  const db = buildDb({ ipVersion: 4, recordSize: 24, data: enc(shared), entries: [['10.1.0.0/16', { country: new Ptr(at), city: 'A' }], ['10.2.0.0/16', { country: new Ptr(at), city: 'B' }]] });
  const r = MmdbReader.open(db.bytes);
  assert.deepEqual(plain(r.lookup('10.1.2.3')!.record), { country: shared, city: 'A' });
  assert.deepEqual(plain(r.lookup('10.2.2.3')!.record), { country: shared, city: 'B' });
});

test('damaged or hostile databases are refused, not followed', () => {
  const good = buildDb({ ipVersion: 4, recordSize: 24, entries: [['10.0.0.0/8', { a: 'b' }]] });
  const marker = Buffer.from(good.bytes).lastIndexOf(Buffer.from([0xab, 0xcd, 0xef]));
  assert.throws(() => MmdbReader.open(good.bytes.slice(0, marker)), /no MaxMind metadata marker/);
  assert.throws(() => MmdbReader.open(Uint8Array.of(1, 2, 3)), DatabaseError);
  assert.throws(() => MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [], meta: { record_size: u16(20) } }).bytes), /record_size/);
  assert.throws(() => MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [], meta: { ip_version: u16(5) } }).bytes), /ip_version/);
  assert.throws(() => MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [], meta: { binary_format_major_version: u16(3) } }).bytes), /version 3/);
  assert.throws(() => MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [], meta: { node_count: u32(1_000_000) } }).bytes), /does not fit/);
  const loop = MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [['10.0.0.0/8', 'x']], raw: { node0: [0, 0] } }).bytes);
  assert.throws(() => loop.lookup('10.0.0.1'), /deeper than the address/);
  const outside = MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [['10.0.0.0/8', 'x']], raw: { node0: [1_000_000, 0] } }).bytes);
  assert.throws(() => outside.lookup('10.0.0.1'), /outside the data section/);
});

test('hostile data is stopped: deep nesting, pointer amplification, bad keys, bad text, long sizes', () => {
  let deep: V = 'x';
  for (let i = 0; i < 40; i++) deep = [deep];
  const t = (v: V, re: RegExp) => assert.throws(() => MmdbReader.open(buildDb({ ipVersion: 4, recordSize: 24, entries: [['10.0.0.0/8', v]] }).bytes).lookup('10.0.0.1'), re);
  t(deep, /nested too deeply/);
  const level0 = enc(Array.from({ length: 100 }, () => 'a'));
  const ampData = [...level0, ...enc(Array.from({ length: 100 }, () => new Ptr(0))), ...enc(Array.from({ length: 100 }, () => new Ptr(level0.length)))];
  const amp = buildDb({ ipVersion: 4, recordSize: 24, data: ampData, entries: [['10.0.0.0/8', Array.from({ length: 100 }, () => new Ptr(level0.length + enc(Array.from({ length: 100 }, () => new Ptr(0))).length))]] });
  assert.throws(() => MmdbReader.open(amp.bytes).lookup('10.0.0.1'), /too many values/);
  assert.throws(() => decodeValue(Uint8Array.from([0xe1, 0xa1, 0x01, 0x41, 0x62])), /key is not a string/);
  assert.throws(() => decodeValue(Uint8Array.from([0x42, 0xff, 0xfe])), /UTF-8/);
  assert.throws(() => decodeValue(Uint8Array.from([0x5f, 0xff, 0xff, 0xff, 0x41])), /past the end/);
  assert.throws(() => decodeValue(Uint8Array.from([0xe9, 0x41, 0x61])), /more entries than there are bytes/);
  assert.throws(() => decodeValue(Uint8Array.from([0x00, 0xf9])), /unsupported data type/, 'extended type 7 + 249 does not exist');
});

test('a map key __proto__ stays a plain property and pollutes nothing', () => {
  const buf = Uint8Array.from([...head(7, 1), ...enc('__proto__'), ...enc({ polluted: 'yes' })]);
  const v = decodeValue(buf).value as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ['__proto__']);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('range tables answer with the most specific range whatever the order, and adjacent ranges stay apart', () => {
  const entries = [['10.0.0.0/8', 'corp'], ['10.1.0.0/16', 'lab'], ['10.1.2.0/24', 'rack'], ['10.2.0.0/16', 'guest'], ['2001:db8::/32', 'v6'], ['2001:db8:1::/48', 'v6-lab']].map(([cidr, value]) => ({ cidr: cidr!, value: value! }));
  for (const list of [entries, [...entries].reverse(), [entries[3]!, entries[5]!, entries[0]!, entries[2]!, entries[4]!, entries[1]!]]) {
    const t = new RangeTable(list);
    const at = (ip: string) => t.lookup(ip)?.value;
    assert.deepEqual(['10.0.0.1', '10.1.0.1', '10.1.2.200', '10.1.3.1', '10.2.9.9', '10.255.255.255', '11.0.0.0', '9.255.255.255'].map(at), ['corp', 'lab', 'rack', 'lab', 'guest', 'corp', undefined, undefined]);
    assert.deepEqual(['2001:db8::1', '2001:db8:1::1', '2001:db8:2::1', '2001:db9::1'].map(at), ['v6', 'v6-lab', 'v6', undefined]);
    assert.equal(at('::ffff:10.1.2.3'), 'rack', 'mapped addresses are looked up as IPv4');
    assert.equal(t.size, 6);
  }
  assert.throws(() => new RangeTable([{ cidr: '10.0.0.0/8', value: 1 }, { cidr: '10.0.0.0/8', value: 2 }]), /listed twice/);
  assert.throws(() => new RangeTable([{ cidr: '10.0.0.1/8', value: 1 }]), AddressError);
  assert.equal(new RangeTable([]).lookup('1.1.1.1'), undefined);
  const edge = new RangeTable([{ cidr: '0.0.0.0/0', value: 'all' }, { cidr: '255.255.255.255/32', value: 'last' }]);
  assert.deepEqual([edge.lookup('255.255.255.255')!.value, edge.lookup('255.255.255.254')!.value, edge.lookup('0.0.0.0')!.value], ['last', 'all', 'all']);
});

test('special-purpose addresses are named, and only public ones are treated as public', () => {
  const want: Record<string, string> = {
    '10.1.2.3': 'private', '172.16.0.1': 'private', '172.32.0.1': 'public', '192.168.1.1': 'private', '127.0.0.1': 'loopback', '169.254.1.1': 'link-local', '100.64.0.1': 'shared',
    '0.1.2.3': 'this-network', '192.0.2.5': 'documentation', '198.51.100.1': 'documentation', '224.0.0.1': 'multicast', '255.255.255.255': 'reserved', '8.8.8.8': 'public', '1.1.1.1': 'public',
    '::1': 'loopback', '::': 'unspecified', 'fe80::1': 'link-local', 'fd12:3456::1': 'private', 'ff02::1': 'multicast', '2001:db8::1': 'documentation', '2606:4700::1111': 'public', '::ffff:10.0.0.1': 'private', '::ffff:8.8.8.8': 'public',
  };
  for (const [ip, kind] of Object.entries(want)) assert.equal(classify(ip), kind, ip);
  assert.ok(isPublic('9.9.9.9') && !isPublic('10.0.0.1'));
});

test('anonymize keeps a network, never a host', () => {
  assert.equal(anonymize('203.0.113.77'), '203.0.113.0');
  assert.equal(anonymize('203.0.113.77', { v4Prefix: 16 }), '203.0.0.0');
  assert.equal(anonymize('2001:db8:abcd:1234:5678::9'), '2001:db8:abcd::');
  assert.equal(anonymize('::ffff:203.0.113.77'), '203.0.113.0');
  assert.equal(anonymize('2001:db8:abcd:1234::1', { v6Prefix: 64 }), '2001:db8:abcd:1234::');
  assert.throws(() => anonymize('1.2.3.4', { v4Prefix: 33 }), /out of range/);
  assert.throws(() => anonymize('nope'), AddressError);
});

const cityDb = (): MmdbReader => MmdbReader.open(buildDb({ ipVersion: 6, recordSize: 24, entries: [['81.2.69.0/24', LONDON], ['81.2.70.0/24', PARIS], ['2001:db8:5::/48', LONDON], ['203.0.114.0/24', { continent: { code: 'AS' } }]] }).bytes);
const NOW = Date.UTC(2023, 11, 1);

test('the policy level decides how much of a record comes out', () => {
  const at = (level: 'country' | 'region' | 'city' | 'point', extra = {}) => new Geolocator({ db: cityDb(), now: () => NOW, policy: { level, ...extra } }).locate('81.2.69.50');
  assert.deepEqual(at('country'), { status: 'found', network: '81.2.69.0/24', level: 'country', continent: 'EU', country: { code: 'GB', name: 'United Kingdom' } });
  assert.deepEqual(at('region'), { status: 'found', network: '81.2.69.0/24', level: 'region', continent: 'EU', country: { code: 'GB', name: 'United Kingdom' }, region: { code: 'ENG', name: 'England' }, timeZone: 'Europe/London' });
  const city = at('city');
  assert.deepEqual(city.status === 'found' ? [city.city, 'postal' in city] : [], ['London', false]);
  const exact = { lat: 51.5142, lng: -0.0931 };
  const c = city.status === 'found' ? city.point! : exact;
  assert.deepEqual(c, coarsen(exact, 4), 'the city level uses geohash cells of precision 4');
  assert.notDeepEqual(c, exact);
  const p = at('point');
  assert.deepEqual(p.status === 'found' && p.point, coarsen(exact, 5));
  assert.equal(p.status === 'found' && p.accuracyKm, 10, 'the database radius is wider than the 5 km cell');
  const withPostal = at('city', { includePostal: true });
  assert.equal(withPostal.status === 'found' && withPostal.postal, 'EC1');
  assert.equal(at('region').status === 'found' && 'city' in (at('region') as object), false);
  assert.equal(JSON.stringify(at('country')).includes('51.5'), false, 'no coordinates at the country level');
});

test('names follow the language list and fall back to English', () => {
  const g = (languages: string[]) => new Geolocator({ db: cityDb(), now: () => NOW, policy: { level: 'country', languages } }).locate('81.2.69.50');
  assert.equal(g(['de']).status === 'found' && (g(['de']) as { country: { name: string } }).country.name, 'Vereinigtes Königreich');
  assert.equal((g(['fr', 'ja']) as { country: { name: string } }).country.name, 'United Kingdom');
});

test('reserved, unknown, hidden and overridden addresses never reach the database result', () => {
  const overrides = new RangeTable([{ cidr: '81.2.70.0/24', value: { label: 'office-vpn' } }, { cidr: '81.2.69.128/25', value: { label: 'branch', country: 'DE' } }]);
  const g = new Geolocator({ db: cityDb(), now: () => NOW, overrides, policy: { level: 'point' } });
  assert.deepEqual(g.locate('192.168.1.1'), { status: 'reserved', kind: 'private' });
  assert.deepEqual(g.locate('::1'), { status: 'reserved', kind: 'loopback' });
  assert.deepEqual(g.locate('8.8.8.8'), { status: 'unknown' });
  assert.deepEqual(g.locate('81.2.70.9'), { status: 'hidden', label: 'office-vpn' });
  assert.deepEqual(g.locate('81.2.69.200'), { status: 'found', network: '81.2.69.128/25', level: 'country', country: { code: 'DE' }, label: 'branch' });
  assert.equal(g.locate('81.2.69.5').status, 'found');
  assert.deepEqual(g.locate('203.0.114.5'), { status: 'found', network: '203.0.114.0/24', level: 'point', continent: 'AS' }, 'a record with little in it gives little out');
  assert.throws(() => g.locate('not an ip'), AddressError);
});

test('positions are never finer than precision 6, and the database age is judged by the injected clock', () => {
  assert.throws(() => new Geolocator({ db: cityDb(), now: () => NOW, policy: { level: 'point', precision: 7 } }), /never returned/);
  assert.throws(() => new Geolocator({ db: cityDb(), now: () => NOW, policy: { precision: 2 } }), /3 to 6/);
  assert.throws(() => new Geolocator({ db: cityDb(), now: () => NOW, policy: { level: 'street' as never } }), /not one of/);
  const fine = new Geolocator({ db: cityDb(), now: () => NOW, policy: { level: 'point', precision: 6 } }).locate('81.2.69.1');
  assert.deepEqual(fine.status === 'found' && fine.point, coarsen({ lat: 51.5142, lng: -0.0931 }, 6));
  const built = 1_700_000_000_000;
  const age = (days: number, limit?: number) => new Geolocator({ db: cityDb(), now: () => built + days * 86_400_000, ...(limit === undefined ? {} : { staleAfterDays: limit }) }).stale();
  assert.deepEqual([age(10).stale, age(61).stale, age(61, 90).stale, age(10).ageDays], [false, true, false, 10]);
  assert.equal(age(0).builtAt.toISOString(), '2023-11-14T22:13:20.000Z');
});
