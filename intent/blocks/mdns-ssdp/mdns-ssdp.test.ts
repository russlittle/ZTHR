import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DiscoveryError, MdnsCache, SsdpCache, announce, answerQuery, browse, checkLocation, decodeMessage, decodeTxt, encodeMessage, encodeTxt, goodbye,
  matchesSearch, msearch, notify, parseName, parseSsdp, resolve, searchResponse, serviceRecords, sameName, nameToString,
  type Message, type Service,
} from './index.ts';

const svc: Service = { instance: 'Front Printer', type: '_ipp._tcp', host: 'printer', port: 631, addresses: ['192.168.1.20', 'fe80::1'], txt: { rp: 'ipp/print', color: 'T', duplex: true } };

let t = 1_000_000;
const clock = () => t;
test.beforeEach(() => { t = 1_000_000; });

test('a query for _http._tcp.local has the bytes RFC 6762 gives (compression of the repeated name)', () => {
  const b = encodeMessage({ id: 0, response: false, questions: [{ name: ['_http', '_tcp', 'local'], type: 'PTR' }], answers: [] });
  assert.equal(b.toString('hex'), '000000000001000000000000' + '055f68747470045f746370056c6f63616c00' + '000c0001');
});

test('the unicast-response bit is the top bit of a question class', () => {
  const b = encodeMessage({ id: 0, response: false, questions: [{ name: ['a', 'local'], type: 'A', unicast: true }], answers: [] });
  assert.equal(b.readUInt16BE(b.length - 2), 0x8001);
  assert.equal(decodeMessage(b).questions[0]!.unicast, true);
});

test('a message round-trips: A, AAAA, PTR, SRV, TXT and NSEC', () => {
  const m: Message = {
    id: 7, response: true, authoritative: true, questions: [],
    answers: [
      { name: ['h', 'local'], ttl: 120, flush: true, data: { type: 'A', address: '10.0.0.5' } },
      { name: ['h', 'local'], ttl: 120, flush: true, data: { type: 'AAAA', address: '2001:db8::1' } },
      { name: ['_x', '_tcp', 'local'], ttl: 4500, data: { type: 'PTR', target: ['Me', '_x', '_tcp', 'local'] } },
      { name: ['Me', '_x', '_tcp', 'local'], ttl: 120, data: { type: 'SRV', priority: 1, weight: 2, port: 80, target: ['h', 'local'] } },
      { name: ['Me', '_x', '_tcp', 'local'], ttl: 4500, data: { type: 'TXT', strings: [Buffer.from('a=b')] } },
      { name: ['h', 'local'], ttl: 120, data: { type: 'NSEC', next: ['h', 'local'], types: [1, 28] } },
    ],
  };
  assert.deepEqual(decodeMessage(encodeMessage(m)), m);
});

test('names compress and decode back; labels with dots survive', () => {
  const m: Message = { id: 0, response: true, questions: [], answers: [1, 2, 3].map((i) => ({ name: ['A.B', 'x', 'local'], ttl: i, data: { type: 'A' as const, address: '1.1.1.1' } })) };
  const b = encodeMessage(m);
  assert.ok(b.length < 12 + 3 * (14 + 10 + 4) - 20);
  assert.deepEqual(decodeMessage(b).answers[2]!.name, ['A.B', 'x', 'local']);
  assert.equal(nameToString(['A.B', 'x']), 'A\\.B.x');
  assert.deepEqual(parseName('A\\.B.x'), ['A.B', 'x']);
  assert.ok(sameName(['ABC', 'Local'], ['abc', 'local']));
});

test('a compression pointer that loops or points forward is refused', () => {
  const head = Buffer.from('000000000001000000000000', 'hex');
  const loop = Buffer.concat([head, Buffer.from([0xc0, 12, 0, 12, 0, 1])]);
  assert.throws(() => decodeMessage(loop), DiscoveryError);
  const fwd = Buffer.concat([head, Buffer.from([0xc0, 40, 0, 12, 0, 1])]);
  assert.throws(() => decodeMessage(fwd), /forward or loops/);
});

test('truncated, oversized and over-counted messages are refused', () => {
  assert.throws(() => decodeMessage(Buffer.alloc(5)), /at least 12/);
  const good = browse('_ipp._tcp');
  assert.throws(() => decodeMessage(good.subarray(0, good.length - 3)), DiscoveryError);
  assert.throws(() => decodeMessage(Buffer.concat([good, Buffer.from([0])])), /after its last record/);
  assert.throws(() => decodeMessage(Buffer.from('0000000000ff00ff00ff00ff', 'hex')), /too many records/);
  assert.throws(() => decodeMessage(Buffer.alloc(9001)), /9000/);
});

test('bad names and TTLs are refused when writing', () => {
  assert.throws(() => encodeMessage({ id: 0, response: false, questions: [{ name: ['x'.repeat(64)], type: 'A' }], answers: [] }), /63 bytes/);
  assert.throws(() => encodeMessage({ id: 0, response: true, questions: [], answers: [{ name: ['a'], ttl: -1, data: { type: 'A', address: '1.1.1.1' } }] }), /TTL/);
  assert.throws(() => encodeMessage({ id: 0, response: true, questions: [], answers: [{ name: ['a'], ttl: 1, data: { type: 'A', address: '1.1.1' } }] }), /IPv4/);
});

test('TXT attributes: encode, decode, boolean keys, duplicates and prototype keys', () => {
  const strs = encodeTxt({ rp: 'ipp/print', duplex: true });
  assert.deepEqual(strs.map(String), ['rp=ipp/print', 'duplex']);
  const d = decodeTxt([Buffer.from('a=1'), Buffer.from('A=2'), Buffer.from('flag'), Buffer.from('__proto__=x'), Buffer.from('e=')]);
  assert.deepEqual({ ...d }, { a: '1', flag: true, e: '' });
  assert.throws(() => encodeTxt({ k: 'x'.repeat(300) }), /255/);
});

test('announce and goodbye carry the same records, goodbye with TTL 0', () => {
  const up = decodeMessage(announce(svc));
  const down = decodeMessage(goodbye(svc));
  assert.equal(up.answers.length, 5);
  assert.ok(up.answers.every((r) => r.ttl > 0));
  assert.ok(down.answers.every((r) => r.ttl === 0));
  assert.ok(up.answers.filter((r) => r.data.type !== 'PTR').every((r) => r.flush));
  assert.equal(up.authoritative, true);
});

test('a bad service type or port is refused', () => {
  assert.throws(() => browse('ipp.tcp'), /service type/);
  assert.throws(() => serviceRecords({ ...svc, port: 0 }), /port/);
});

test('answering a browse query gives the pointer plus the rest as additional records', () => {
  const q = decodeMessage(browse('_ipp._tcp', { unicast: true }));
  const r = answerQuery(q, [svc])!;
  assert.equal(r.unicast, true);
  const m = decodeMessage(r.message);
  assert.equal(m.answers.length, 1);
  assert.equal(m.answers[0]!.data.type, 'PTR');
  assert.deepEqual(m.additional!.map((x) => x.data.type).sort(), ['A', 'AAAA', 'SRV', 'TXT']);
});

test('known-answer suppression leaves out what the asker holds with half its life left', () => {
  const ptr = serviceRecords(svc)[0]!;
  const q = decodeMessage(browse('_ipp._tcp', { known: [{ ...ptr, ttl: 4000 }] }));
  assert.equal(answerQuery(q, [svc]), undefined);
  const stale = decodeMessage(browse('_ipp._tcp', { known: [{ ...ptr, ttl: 1000 }] }));
  assert.ok(answerQuery(stale, [svc]));
});

test('the service-type enumeration question lists types; unrelated and response messages get no answer', () => {
  const q = encodeMessage({ id: 0, response: false, questions: [{ name: ['_services', '_dns-sd', '_udp', 'local'], type: 'PTR' }], answers: [] });
  const m = decodeMessage(answerQuery(decodeMessage(q), [svc])!.message);
  assert.deepEqual((m.answers[0]!.data as unknown as { target: string[] }).target, ['_ipp', '_tcp', 'local']);
  assert.equal(answerQuery(decodeMessage(browse('_other._tcp')), [svc]), undefined);
  assert.equal(answerQuery(decodeMessage(announce(svc)), [svc]), undefined);
  const r = decodeMessage(resolve('Front Printer', '_ipp._tcp'));
  assert.equal(r.questions.length, 2);
  assert.equal(decodeMessage(answerQuery(r, [svc])!.message).answers.length, 2);
});

test('the cache assembles a service from an announcement and reports it once', () => {
  const c = new MdnsCache({ now: clock });
  const ev = c.ingest(decodeMessage(announce(svc)));
  assert.deepEqual(ev, [{ kind: 'added', instance: 'Front Printer', type: '_ipp._tcp' }]);
  const [s] = c.services('_ipp._tcp');
  assert.equal(s!.port, 631);
  assert.deepEqual(s!.addresses, ['192.168.1.20', 'fe80::1']);
  assert.deepEqual({ ...s!.txt }, { rp: 'ipp/print', color: 'T', duplex: true });
  assert.deepEqual(c.ingest(decodeMessage(announce(svc))), []);
  assert.equal(c.services('_http._tcp').length, 0);
});

test('records expire by TTL; the 120 second records go first and the service disappears', () => {
  const c = new MdnsCache({ now: clock });
  c.ingest(decodeMessage(announce(svc)));
  t += 119_000;
  assert.equal(c.services().length, 1);
  t += 2000;
  assert.equal(c.services().length, 0);
  assert.deepEqual(c.expire(), []);
});

test('a goodbye leaves the record for one second, then it is gone', () => {
  const c = new MdnsCache({ now: clock });
  c.ingest(decodeMessage(announce(svc)));
  t += 5000;
  c.ingest(decodeMessage(goodbye(svc)));
  assert.equal(c.services().length, 1);
  t += 1001;
  assert.equal(c.services().length, 0);
  assert.deepEqual(c.expire().length, 0);
});

test('a cache-flush record replaces older records of the same name and type', () => {
  const c = new MdnsCache({ now: clock });
  c.ingest(decodeMessage(announce(svc)));
  t += 5000;
  c.ingest(decodeMessage(announce({ ...svc, addresses: ['192.168.1.99'] })));
  t += 1500;
  assert.deepEqual(c.services()[0]!.addresses, ['192.168.1.99', 'fe80::1']);
});

test('refresh questions appear at 80 percent of a record life', () => {
  const c = new MdnsCache({ now: clock });
  c.ingest(decodeMessage(announce(svc)));
  assert.deepEqual(c.refreshDue(), []);
  t += 100_000;
  const due = c.refreshDue();
  assert.ok(due.length > 0);
  assert.ok(due.every((q) => q.type === 'A' || q.type === 'AAAA' || q.type === 'SRV'));
});

test('queries are not cached', () => {
  const c = new MdnsCache({ now: clock });
  assert.deepEqual(c.ingest(decodeMessage(browse('_ipp._tcp'))), []);
});

// ------------------------------------------------------------------ SSDP

const alive = { nts: 'ssdp:alive' as const, nt: 'urn:schemas-upnp-org:device:MediaServer:1', usn: 'uuid:abc::urn:schemas-upnp-org:device:MediaServer:1', location: 'http://192.168.1.5:8200/desc.xml', maxAge: 1800, server: 'Linux UPnP/1.1 X/1.0', bootId: 3 };

test('M-SEARCH has the documented shape and round-trips', () => {
  const b = msearch('ssdp:all', 3, 'zthr/1');
  assert.equal(b.toString(), 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ssdp:all\r\nUSER-AGENT: zthr/1\r\n\r\n');
  assert.deepEqual(parseSsdp(b), { kind: 'm-search', st: 'ssdp:all', mx: 3, userAgent: 'zthr/1' });
  assert.throws(() => msearch('x', 9), /MX/);
  assert.throws(() => msearch('x\r\nHOST: evil'), /line break/);
});

test('MX above 5 is capped when parsing', () => {
  const raw = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 120\r\nST: ssdp:all\r\n\r\n';
  assert.equal((parseSsdp(Buffer.from(raw)) as { mx: number }).mx, 5);
});

test('NOTIFY alive and byebye round-trip', () => {
  assert.deepEqual(parseSsdp(notify(alive)), { kind: 'notify', ...alive });
  const bye = parseSsdp(notify({ nts: 'ssdp:byebye', nt: alive.nt, usn: alive.usn }));
  assert.equal(bye.kind === 'notify' && bye.nts, 'ssdp:byebye');
  assert.throws(() => notify({ nts: 'ssdp:alive', nt: 'x', usn: 'y' }), /LOCATION/);
});

test('search responses round-trip and need a max-age', () => {
  const r = { st: alive.nt, usn: alive.usn, location: alive.location, maxAge: 900, server: 'S' };
  assert.deepEqual(parseSsdp(searchResponse(r)), { kind: 'response', ...r });
  const bad = searchResponse(r).toString().replace('CACHE-CONTROL: max-age=900\r\n', '');
  assert.throws(() => parseSsdp(Buffer.from(bad)), /max-age/);
});

test('malformed SSDP is refused: duplicates, odd lines, wrong MAN, too many headers, too big', () => {
  const base = 'NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nNT: a\r\nNTS: ssdp:byebye\r\nUSN: u\r\n';
  assert.throws(() => parseSsdp(Buffer.from(base + 'NT: b\r\n\r\n')), /twice/);
  assert.throws(() => parseSsdp(Buffer.from(base + 'garbage\r\n\r\n')), /not valid/);
  assert.throws(() => parseSsdp(Buffer.from(base.replace('ssdp:byebye', 'ssdp:wat') + '\r\n')), /not known/);
  assert.throws(() => parseSsdp(Buffer.from('M-SEARCH * HTTP/1.1\r\nMAN: "x"\r\nMX: 1\r\nST: a\r\n\r\n')), /MAN/);
  assert.throws(() => parseSsdp(Buffer.from(base + Array.from({ length: 50 }, (_, i) => `X${i}: 1\r\n`).join('') + '\r\n')), /too many/);
  assert.throws(() => parseSsdp(Buffer.alloc(1501, 65)), /1500/);
  assert.throws(() => parseSsdp(Buffer.from('GET / HTTP/1.1\r\n\r\n')), DiscoveryError);
});

test('LOCATION must be http(s), without credentials, on the sender', () => {
  assert.equal(checkLocation('http://192.168.1.5:8200/d.xml', '192.168.1.5').port, '8200');
  assert.equal(checkLocation('http://[fe80::1]/d.xml', 'fe80::1').hostname, '[fe80::1]');
  assert.throws(() => checkLocation('http://10.9.9.9/d.xml', '192.168.1.5'), /different machine/);
  assert.throws(() => checkLocation('file:///etc/passwd', '192.168.1.5'), /http/);
  assert.throws(() => checkLocation('http://u:p@192.168.1.5/', '192.168.1.5'), /credentials/);
  assert.throws(() => checkLocation('nonsense', '1.1.1.1'), /not a URL/);
});

test('the SSDP cache adds, updates, expires by max-age and removes on byebye', () => {
  const c = new SsdpCache({ now: clock });
  assert.deepEqual(c.ingest(parseSsdp(notify(alive)), '192.168.1.5'), { kind: 'added', usn: alive.usn });
  assert.deepEqual(c.ingest(parseSsdp(notify(alive)), '192.168.1.5'), { kind: 'updated', usn: alive.usn });
  assert.equal(c.find().length, 1);
  assert.equal(c.find(alive.nt).length, 1);
  assert.equal(c.find('urn:other').length, 0);
  t += 1_799_000;
  assert.equal(c.find().length, 1);
  t += 2000;
  assert.equal(c.find().length, 0);
  assert.deepEqual(c.expire(), [alive.usn]);
  c.ingest(parseSsdp(notify(alive)), '192.168.1.5');
  assert.deepEqual(c.ingest(parseSsdp(notify({ nts: 'ssdp:byebye', nt: alive.nt, usn: alive.usn })), '192.168.1.5'), { kind: 'removed', usn: alive.usn });
  assert.equal(c.find().length, 0);
});

test('the SSDP cache refuses a notice whose LOCATION points elsewhere, and ignores searches', () => {
  const c = new SsdpCache({ now: clock });
  assert.throws(() => c.ingest(parseSsdp(notify(alive)), '192.168.1.77'), /different machine/);
  assert.equal(c.find().length, 0);
  assert.equal(c.ingest(parseSsdp(msearch('ssdp:all')), '1.1.1.1').kind, 'ignored');
});

test('search targets: ssdp:all, rootdevice, uuid and types', () => {
  const types = ['urn:schemas-upnp-org:device:MediaServer:1', 'urn:schemas-upnp-org:service:ContentDirectory:1'];
  assert.equal(matchesSearch('ssdp:all', 'abc', types).length, 4);
  assert.deepEqual(matchesSearch('upnp:rootdevice', 'abc', types), ['upnp:rootdevice']);
  assert.deepEqual(matchesSearch('uuid:abc', 'abc', types), ['uuid:abc']);
  assert.deepEqual(matchesSearch(types[1]!, 'abc', types), [types[1]]);
  assert.deepEqual(matchesSearch('urn:nope', 'abc', types), []);
});
