import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DnsError, NameError, RecordError, WireError, ZoneError, ageRecords, canonicalName, checkResponse, clampTtl, decode, encode, formatIPv6, formatRecord, formatTtl, formatZone,
  isSubdomain, labelsToName, makeQuery, nameToLabels, negativeTtl, nextSerial, parseIPv6, parseTtl, parseZone, sameName, serialCompare, serialGt, ttlRemaining, validateZone,
} from './index.ts';
import type { DnsRecord, Message } from './index.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/\s+/g, ''), 'hex'));
const rec = (name: string, ttl: number, data: DnsRecord['data']): DnsRecord => ({ name, ttl, cls: 1, data });
const empty = { qr: true, opcode: 0, aa: false, tc: false, rd: true, ra: true, ad: false, cd: false, rcode: 0, questions: [], answers: [], authority: [], additional: [] };

test('a plain query encodes to the well-known bytes for example.com A', () => {
  const q = makeQuery('example.com.', 'A', { id: 1 });
  assert.equal(hex(encode(q)), '000101000001000000000000076578616d706c6503636f6d0000010001');
});

test('a response with a compression pointer decodes to its answer', () => {
  const m = decode(bytes('1234 8180 0001 0001 0000 0000 076578616d706c6503636f6d00 0001 0001 c00c 0001 0001 00000e10 0004 5db8d822'));
  assert.deepEqual([m.id, m.qr, m.rd, m.ra, m.rcode], [0x1234, true, true, true, 0]);
  assert.deepEqual(m.questions, [{ name: 'example.com.', qtype: 1, qclass: 1 }]);
  assert.deepEqual(m.answers, [{ name: 'example.com.', ttl: 3600, cls: 1, data: { type: 'A', address: '93.184.216.34' } }]);
});

test('names are compressed as in RFC 1035 section 4.1.4, matching without regard to case', () => {
  const m: Message = { ...empty, id: 5, questions: [{ name: 'F.ISI.ARPA.', qtype: 1, qclass: 1 }], answers: [rec('FOO.F.ISI.ARPA.', 60, { type: 'A', address: '1.2.3.4' }), rec('arpa.', 60, { type: 'NS', target: 'F.ISI.ARPA.' })] };
  const wire = encode(m);
  const h = hex(wire);
  assert.ok(h.includes('03464f4fc00c'), 'FOO then a pointer to F.ISI.ARPA at offset 12');
  assert.ok(h.includes('c012'), 'arpa. points at the ARPA label at offset 18');
  assert.ok(wire.length < encode(m, { compress: false }).length);
  // a pointer takes the spelling of the earlier occurrence; names are equal without regard to case
  assert.deepEqual(decode(wire).answers.map((r) => r.name), ['FOO.F.ISI.ARPA.', 'ARPA.']);
  assert.deepEqual(decode(encode(m, { compress: false })).answers.map((r) => r.name), ['FOO.F.ISI.ARPA.', 'arpa.']);
});

test('every record type survives encode then decode, and unknown types stay as bytes', () => {
  const answers: DnsRecord[] = [
    rec('a.example.', 10, { type: 'A', address: '192.0.2.1' }),
    rec('a.example.', 10, { type: 'AAAA', address: '2001:db8::1' }),
    rec('ns.example.', 20, { type: 'NS', target: 'ns1.example.' }),
    rec('w.example.', 20, { type: 'CNAME', target: 'a.example.' }),
    rec('1.2.0.192.in-addr.arpa.', 20, { type: 'PTR', target: 'a.example.' }),
    rec('example.', 30, { type: 'MX', preference: 10, exchange: 'mail.example.' }),
    rec('example.', 30, { type: 'TXT', strings: ['v=spf1 -all', '', 'x'.repeat(255), 'ÿ\u0000'] }),
    rec('example.', 30, { type: 'SOA', mname: 'ns.example.', rname: 'host.example.', serial: 4294967295, refresh: 1, retry: 2, expire: 3, minimum: 4 }),
    rec('_sip._tcp.example.', 30, { type: 'SRV', priority: 1, weight: 2, port: 5060, target: 'sip.example.' }),
    rec('example.', 30, { type: 'CAA', flags: 128, tag: 'issue', value: 'letsencrypt.org' }),
    rec('example.', 30, { type: 'RAW', code: 65, data: Uint8Array.of(1, 2, 3) }),
  ];
  const m: Message = { ...empty, id: 9, questions: [{ name: 'example.', qtype: 255, qclass: 1 }], answers };
  assert.deepEqual(decode(encode(m)), m);
});

test('a compression pointer that points to itself, forward, or round in a ring is refused', () => {
  const head = '0001 0100 0001 0000 0000 0000';
  assert.throws(() => decode(bytes(`${head} c00c 0001 0001`)), /earlier offset/);
  assert.throws(() => decode(bytes(`${head} c020 0001 0001`)), /earlier offset/);
  assert.throws(() => decode(bytes(`${head} 0161 c00c 0001 0001`)), (e: unknown) => e instanceof WireError && /longer than 255|too many/.test((e as Error).message), 'a ring of a label and a pointer back to it ends in an error, not a hang');
});

test('malformed messages are refused: short, cut, reserved labels, huge counts, wrong lengths, leftovers', () => {
  const ok = hex(encode(makeQuery('example.com.', 'A', { id: 1 })));
  assert.throws(() => decode(bytes('0001 0100')), /at least 12/);
  assert.throws(() => decode(bytes(ok.slice(0, -4))), WireError);
  assert.throws(() => decode(bytes(`${ok}00`)), /left over/);
  assert.equal(decode(bytes(`${ok}00`), { allowTrailing: true }).id, 1);
  assert.throws(() => decode(bytes('0001 0100 0000 ffff 0000 0000')), /counts are larger/);
  assert.throws(() => decode(bytes('0001 0100 0001 0000 0000 0000 40 0001 0001')), /reserved/);
  const rr = (type: string, len: string, data: string) => bytes(`0001 8000 0000 0001 0000 0000 00 ${type} 0001 0000003c ${len} ${data}`);
  assert.throws(() => decode(rr('0001', '0005', '0102030405')), /A data must be 4/);
  assert.throws(() => decode(rr('0010', '0003', '05616263')), /TXT/);
  assert.throws(() => decode(rr('000f', '0003', '000a05')), WireError);
  assert.throws(() => decode(rr('0001', '0004', '01020304 05')), /left over/);
  assert.throws(() => decode(bytes('0001 8000 0000 0001 0000 0000 00 0001 0001 0000003c 0004 01')), /cut short/);
});

test('EDNS: the OPT record carries size, DO and options, and the extended response code', () => {
  const q = makeQuery('example.com.', 'A', { id: 7, edns: { udpSize: 4096, version: 0, dnssecOk: true, options: [] } });
  assert.ok(hex(encode(q)).endsWith('0000291000000080000000'), 'RFC 6891: root name, type 41, size 4096, DO bit set');
  const back = decode(encode(q));
  assert.deepEqual(back.edns, { udpSize: 4096, version: 0, dnssecOk: true, options: [] });
  assert.equal(back.additional.length, 0, 'OPT is not listed as an ordinary record');
  const bad: Message = { ...empty, id: 1, rcode: 16, edns: { udpSize: 1232, version: 0, dnssecOk: false, options: [{ code: 10, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }] } };
  const r = decode(encode(bad));
  assert.equal(r.rcode, 16, 'BADVERS needs the high bits from the OPT record');
  assert.deepEqual(r.edns!.options[0], { code: 10, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) });
  assert.throws(() => encode({ ...empty, id: 1, rcode: 16 }), /needs EDNS/);
  const opt = '00 0029 1000 00000000 0000';
  assert.throws(() => decode(bytes(`0001 0000 0000 0000 0000 0002 ${opt} ${opt}`)), /more than one OPT/);
  assert.throws(() => decode(bytes(`0001 0000 0000 0001 0000 0000 ${opt}`)), /outside the additional/);
});

test('a response too big for the limit loses its additional records first, then answers with the TC bit', () => {
  const txt = (i: number): DnsRecord => rec(`h${i}.example.`, 60, { type: 'TXT', strings: ['x'.repeat(100)] });
  const extra = Array.from({ length: 6 }, (_, i) => rec(`g${i}.example.`, 60, { type: 'A', address: '192.0.2.1' }));
  const small: Message = { ...empty, id: 1, questions: [{ name: 'example.', qtype: 16, qclass: 1 }], answers: [txt(1), txt(2)], additional: Array.from({ length: 30 }, (_, i) => rec(`g${i}.example.`, 60, { type: 'TXT', strings: ['y'.repeat(30)] })) };
  const a = decode(encode(small, { maxSize: 512 }));
  assert.deepEqual([a.answers.length, a.additional.length, a.tc], [2, 0, false]);
  const big: Message = { ...small, answers: Array.from({ length: 40 }, (_, i) => txt(i)), additional: extra };
  const wire = encode(big, { maxSize: 512 });
  assert.ok(wire.length <= 512);
  const b = decode(wire);
  assert.deepEqual([b.tc, b.answers.length, b.questions.length], [true, 0, 1]);
});

test('IPv6 text follows RFC 5952 and bad forms are refused', () => {
  const same = (s: string, want: string) => assert.equal(formatIPv6(parseIPv6(s)), want, s);
  same('2001:DB8:0:0:1:0:0:1', '2001:db8::1:0:0:1');
  same('2001:db8:0:0:0:0:0:1', '2001:db8::1');
  same('2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1');
  same('0:0:0:0:0:0:0:0', '::');
  same('::1', '::1');
  same('::ffff:192.0.2.1', '::ffff:c000:201');
  same('1:0:0:2:0:0:0:3', '1:0:0:2::3');
  for (const bad of ['', ':::', '1::2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', 'g::1', 'fe80::1%eth0', '12345::', '::1.2.3', '1:2:3:4:5:6:7::8']) assert.throws(() => parseIPv6(bad), RecordError, bad);
});

test('names: escapes, limits, case and subdomains', () => {
  const l = nameToLabels(String.raw`a\.b.Example.COM.`);
  assert.deepEqual(l.map((x) => Buffer.from(x).toString()), ['a.b', 'Example', 'COM']);
  assert.equal(labelsToName(l), String.raw`a\.b.Example.COM.`);
  assert.equal(labelsToName(nameToLabels(String.raw`x\065\032y.example.`)), String.raw`xA\032y.example.`);
  assert.equal(canonicalName('WWW.Example.COM'), 'www.example.com.');
  assert.ok(sameName('EXAMPLE.com.', 'example.COM'));
  assert.ok(isSubdomain('a.b.example.com.', 'Example.com.') && isSubdomain('example.com.', 'example.com.') && isSubdomain('x.', '.'));
  assert.ok(!isSubdomain('notexample.com.', 'example.com.') && !isSubdomain('com.', 'example.com.'));
  assert.equal(nameToLabels('.').length, 0);
  assert.throws(() => nameToLabels('a..b.'), /empty label/);
  assert.throws(() => nameToLabels(''), NameError);
  assert.throws(() => nameToLabels(`${'a'.repeat(64)}.example.`), /63/);
  assert.throws(() => nameToLabels(`${'abcdefghi.'.repeat(26)}`), /255/);
  assert.throws(() => nameToLabels('münchen.de.'), /punycode/);
  assert.throws(() => nameToLabels(String.raw`a\999.b.`), NameError);
});

test('records out of range are refused on encode', () => {
  const m = (r: DnsRecord): Message => ({ ...empty, id: 1, answers: [r] });
  assert.throws(() => encode(m(rec('a.', 2 ** 31, { type: 'A', address: '1.2.3.4' }))), /ttl/);
  assert.throws(() => encode(m(rec('a.', 1, { type: 'A', address: '1.2.3' }))), RecordError);
  assert.throws(() => encode(m(rec('a.', 1, { type: 'A', address: '01.2.3.4' }))), RecordError);
  assert.throws(() => encode(m(rec('a.', 1, { type: 'MX', preference: 70000, exchange: 'm.' }))), /preference/);
  assert.throws(() => encode(m(rec('a.', 1, { type: 'TXT', strings: ['x'.repeat(256)] }))), /255/);
  assert.throws(() => encode(m(rec('a.', 1, { type: 'TXT', strings: [] }))), /at least one/);
  assert.throws(() => encode(m(rec('a.', 1, { type: 'CAA', flags: 0, tag: 'bad tag', value: 'x' }))), /tag/);
  assert.throws(() => encode(m(rec('a.', 1, { type: 'TXT', strings: ['Ā'] }))), /above 255/);
});

const ZONE = `
$ORIGIN example.com.
$TTL 1h
@   IN  SOA ns1 hostmaster (
        2024010101 ; serial
        7200       ; refresh
        1h         ; retry
        2w         ; expire
        300 )      ; minimum
    IN  NS  ns1
    IN  NS  ns2.example.net.
    MX  10 mail
ns1 A 192.0.2.1
www 5m IN CNAME @
mail IN 2h A 192.0.2.25
txt TXT "v=spf1 ; include:x" "two words" plain\\032one
_sip._tcp SRV 10 60 5060 sip
@ CAA 0 issue "letsencrypt.org"
v6 AAAA 2001:DB8:0:0:0:0:0:1
`;

test('a zone file reads: origin, TTL, inherited owners, parentheses, comments, units, quotes', () => {
  const z = parseZone(ZONE);
  assert.equal(z.origin, 'example.com.');
  assert.equal(z.records.length, 11);
  const by = (n: string, t: string) => z.records.filter((r) => r.name === n && r.data.type === t);
  const soa = by('example.com.', 'SOA')[0]!;
  assert.deepEqual([soa.ttl, soa.data], [3600, { type: 'SOA', mname: 'ns1.example.com.', rname: 'hostmaster.example.com.', serial: 2024010101, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300 }]);
  assert.deepEqual(by('example.com.', 'NS').map((r) => (r.data as { target: string }).target), ['ns1.example.com.', 'ns2.example.net.']);
  assert.deepEqual(by('example.com.', 'MX')[0]!.data, { type: 'MX', preference: 10, exchange: 'mail.example.com.' });
  assert.deepEqual([by('www.example.com.', 'CNAME')[0]!.ttl, (by('www.example.com.', 'CNAME')[0]!.data as { target: string }).target], [300, 'example.com.']);
  assert.equal(by('mail.example.com.', 'A')[0]!.ttl, 7200);
  assert.deepEqual(by('txt.example.com.', 'TXT')[0]!.data, { type: 'TXT', strings: ['v=spf1 ; include:x', 'two words', 'plain one'] });
  assert.deepEqual(by('_sip._tcp.example.com.', 'SRV')[0]!.data, { type: 'SRV', priority: 10, weight: 60, port: 5060, target: 'sip.example.com.' });
  assert.deepEqual(by('example.com.', 'CAA')[0]!.data, { type: 'CAA', flags: 0, tag: 'issue', value: 'letsencrypt.org' });
  assert.equal((by('v6.example.com.', 'AAAA')[0]!.data as { address: string }).address, '2001:db8::1');
});

test('written zone text reads back as the same records, and zone records survive the wire', () => {
  const z = parseZone(ZONE);
  const text = formatZone(z.records);
  assert.deepEqual(parseZone(text).records, z.records);
  assert.equal(formatRecord(z.records[4]!), 'ns1.example.com. 3600 IN A 192.0.2.1');
  const m: Message = { ...empty, id: 3, answers: z.records };
  assert.deepEqual(decode(encode(m)).answers, z.records);
});

test('generic data, other classes and TTL defaults in zone files', () => {
  const z = parseZone(`$ORIGIN example.org.
a 100 TYPE65 \\# 4 0a0b0c0d
b CLASS1 200 A 192.0.2.7
c A \\# 4 c0000201
d TXT hello
`);
  assert.deepEqual(z.records[0]!.data, { type: 'RAW', code: 65, data: Uint8Array.of(10, 11, 12, 13) });
  assert.deepEqual([z.records[1]!.ttl, z.records[1]!.cls], [200, 1]);
  assert.deepEqual(z.records[2]!.data, { type: 'A', address: '192.0.2.1' }, 'the \\# form of a known type gives the ordinary record');
  assert.equal(z.records[3]!.ttl, 200, 'an omitted TTL takes the one before it');
  assert.equal(parseZone('$ORIGIN x.\n@ SOA a b 1 2 3 4 99\n').records[0]!.ttl, 99, 'a first SOA with no TTL uses its minimum');
  assert.throws(() => parseZone('$ORIGIN x.\na A 1.2.3.4\n'), /no TTL/);
});

test('hostile or broken zone files are refused with the line number', () => {
  const bad = (text: string, re: RegExp, o = {}) => assert.throws(() => parseZone(text, o), (e: unknown) => e instanceof ZoneError && re.test((e as Error).message), text);
  bad('$INCLUDE /etc/passwd\n', /\$INCLUDE is refused/);
  bad('$GENERATE 1-10 a$ A 1.2.3.4\n', /GENERATE/);
  bad('$FOO x\n', /unknown directive/);
  bad('a 60 A 1.2.3.4\n', /relative name a with no origin/);
  bad('$ORIGIN x.\n@ 60 TXT "open\n', /not closed/);
  bad('$ORIGIN x.\n@ 60 SOA a b ( 1 2 3\n', /never closed/);
  bad('$ORIGIN x.\n@ 60 A 1.2.3.4 )\n', /closing parenthesis/);
  bad('$ORIGIN x.\n@ 99999999999 A 1.2.3.4\n', /TTL/);
  bad('$ORIGIN x.\n@ 60 A 999.1.1.1\n', /not an IPv4/);
  bad('$ORIGIN x.\n@ 60 A 1.2.3.4 5\n', /extra data/);
  bad('$ORIGIN x.\n@ 60 MX 70000 m\n', /up to 65535/);
  bad('$ORIGIN x.\n@ 60 NOSUCH 1\n', /unknown record type/);
  bad('$ORIGIN x.\n@ 60 TYPE99 abc\n', /\\# form/);
  bad(`$ORIGIN x.\n${'a'.repeat(64)} 60 A 1.2.3.4\n`, /63/);
  bad('$ORIGIN x.\n$TTL 60\n@ A 1.2.3.4\n@ A 1.2.3.5\n@ A 1.2.3.6\n', /more than 2 records/, { maxRecords: 2 });
  bad('x'.repeat(200), /larger than 100 bytes/, { maxBytes: 100 });
  bad('  A 1.2.3.4\n', /no owner/);
  try { parseZone('$ORIGIN x.\n$TTL 60\n\n\n@ A nope\n'); assert.fail('should throw'); } catch (e) { assert.equal((e as ZoneError).line, 5); }
});

test('zone validation reports the rules a server would refuse', () => {
  const z = parseZone(ZONE);
  assert.deepEqual(validateZone(z.records, 'example.com.'), []);
  const flat = (rs: DnsRecord[]) => validateZone(rs, 'example.com.').map((i) => `${i.severity}: ${i.message}`);
  const soa = z.records[0]!;
  const ns = z.records[1]!;
  const issues = flat([
    soa, ns, soa,
    rec('www.example.com.', 60, { type: 'CNAME', target: 'example.com.' }),
    rec('www.example.com.', 60, { type: 'A', address: '192.0.2.9' }),
    rec('alias.example.com.', 60, { type: 'CNAME', target: 'example.com.' }),
    rec('example.com.', 60, { type: 'MX', preference: 5, exchange: 'alias.example.com.' }),
    rec('stranger.example.org.', 60, { type: 'A', address: '192.0.2.9' }),
    rec('t.example.com.', 60, { type: 'A', address: '192.0.2.1' }),
    rec('t.example.com.', 120, { type: 'A', address: '192.0.2.2' }),
    rec('t.example.com.', 120, { type: 'A', address: '192.0.2.2' }),
  ]);
  for (const want of ['more than one SOA', 'has a CNAME and other data', 'is a CNAME', 'is outside the zone', 'different TTLs', 'listed twice']) assert.ok(issues.some((i) => i.includes(want)), want);
  assert.ok(flat([ns]).some((i) => i.includes('no SOA')));
  assert.ok(flat([soa]).some((i) => i.includes('no NS')));
  assert.ok(flat([soa, ns, rec('example.com.', 60, { type: 'CNAME', target: 'x.example.com.' })]).some((i) => i.includes('apex')));
});

test('TTL text, ageing, clamping and negative caching', () => {
  assert.deepEqual(['90', '1h', '1h30m', '2w1d', '1D'].map(parseTtl), [90, 3600, 5400, 1296000, 86400]);
  assert.deepEqual([0, 5400, 86400, 8 * 86400, 90061].map(formatTtl), ['0s', '1h30m', '1d', '1w1d', '1d1h1m1s']);
  for (const n of [0, 1, 59, 3600, 123456, 2 ** 31 - 1]) assert.equal(parseTtl(formatTtl(n)), n);
  for (const bad of ['', '1x', 'h', '2147483648', '-5', '1.5']) assert.throws(() => parseTtl(bad), RecordError, bad);
  assert.equal(ttlRemaining(300, 0, 100_999), 200, 'whole seconds are counted down, not rounded up');
  assert.deepEqual([ttlRemaining(300, 0, 299_000), ttlRemaining(300, 0, 301_000), ttlRemaining(300, 5000, 0)], [1, 0, 300]);
  assert.deepEqual(ageRecords([rec('a.', 100, { type: 'A', address: '1.1.1.1' }), rec('b.', 10, { type: 'A', address: '1.1.1.2' })], 0, 20_000).map((r) => [r.name, r.ttl]), [['a.', 80]]);
  assert.deepEqual([clampTtl(5, { min: 30, max: 3600 }), clampTtl(99999, { min: 30, max: 3600 }), clampTtl(60, {})], [30, 3600, 60]);
  const soa = (ttl: number, minimum: number) => rec('example.', ttl, { type: 'SOA', mname: 'a.', rname: 'b.', serial: 1, refresh: 1, retry: 1, expire: 1, minimum });
  assert.deepEqual([negativeTtl(soa(3600, 300)), negativeTtl(soa(60, 300))], [300, 60]);
  assert.throws(() => negativeTtl(rec('a.', 1, { type: 'A', address: '1.1.1.1' })), RecordError);
  const wire = bytes('0001 8000 0000 0001 0000 0000 00 0001 0001 ffffffff 0004 01010101');
  assert.equal(decode(wire).answers[0]!.ttl, 0, 'RFC 2181: a TTL with the high bit set is read as zero');
});

test('serial numbers compare as RFC 1982 and the next serial follows the date', () => {
  assert.ok(serialGt(1, 0) && !serialGt(0, 1));
  assert.ok(serialGt(0, 0xffffffff), 'wraps round');
  assert.ok(!serialGt(0xffffffff, 0));
  assert.equal(serialCompare(0, 0x80000000), undefined, 'exactly half the space apart is undefined');
  assert.deepEqual([serialCompare(5, 5), serialCompare(6, 5), serialCompare(5, 6)], [0, 1, -1]);
  assert.equal(nextSerial(2024010101, new Date('2024-01-01T10:00:00Z')), 2024010102);
  assert.equal(nextSerial(2024010101, new Date('2024-01-02T00:00:00Z')), 2024010200);
  assert.equal(nextSerial(0xffffffff, new Date('2020-01-01T00:00:00Z')), 0);
  assert.throws(() => serialGt(-1, 0), RecordError);
});

test('a response must answer the query that was sent', () => {
  const q = makeQuery('Example.COM.', 'A', { id: 99 });
  const r = (o: Partial<Message>): Message => ({ ...decode(encode(q)), qr: true, ...o });
  checkResponse(q, r({}));
  checkResponse(q, r({ questions: [{ name: 'example.com.', qtype: 1, qclass: 1 }] }));
  assert.throws(() => checkResponse(q, r({ qr: false })), /not a response/);
  assert.throws(() => checkResponse(q, r({ id: 98 })), /id/);
  assert.throws(() => checkResponse(q, r({ questions: [{ name: 'other.com.', qtype: 1, qclass: 1 }] })), /question/);
  assert.throws(() => checkResponse(q, r({ questions: [{ name: 'example.com.', qtype: 28, qclass: 1 }] })), DnsError);
  assert.throws(() => checkResponse(q, r({ questions: [] })), /count/);
});
