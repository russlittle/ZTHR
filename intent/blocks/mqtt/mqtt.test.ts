import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MqttError, PacketStream, RetainedStore, Session, SubscriptionTree, decode, decodeVarInt, encode, encodeVarInt, shared, topicMatches, validateTopicFilter, validateTopicName } from './index.ts';
import type { Packet } from './index.ts';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const h = (b: Buffer) => b.toString('hex');

test('MQTT 3.1.1 section 2.2.3: variable-length integers at every boundary', () => {
  const v: [number, string][] = [[0, '00'], [127, '7f'], [128, '8001'], [16383, 'ff7f'], [16384, '808001'], [2097151, 'ffff7f'], [2097152, '80808001'], [268435455, 'ffffff7f']];
  for (const [n, e] of v) {
    assert.equal(h(encodeVarInt(n)), e);
    assert.deepEqual(decodeVarInt(hex(e)), { value: n, length: e.length / 2 });
  }
  assert.throws(() => encodeVarInt(268435456), /0 to 268435455/);
  assert.throws(() => encodeVarInt(-1), MqttError);
  assert.throws(() => decodeVarInt(hex('ffffffff7f')), /longer than four bytes/);
  assert.throws(() => decodeVarInt(hex('8000')), /shortest form/);
  assert.equal(decodeVarInt(hex('80')), undefined, 'incomplete is not an error');
});

test('3.1.1 CONNECT, CONNACK, PINGREQ, DISCONNECT bytes', () => {
  const c: Packet = { type: 'connect', protocolLevel: 4, clean: true, keepAlive: 60, clientId: '' };
  assert.equal(h(encode(c, 4)), '100c00044d5154540402003c0000');
  assert.deepEqual(decode(encode(c, 4), 4), c);
  assert.equal(h(encode({ type: 'connack', sessionPresent: false, code: 0 }, 4)), '20020000');
  assert.equal(h(encode({ type: 'pingreq' }, 4)), 'c000');
  assert.equal(h(encode({ type: 'pingresp' }, 4)), 'd000');
  assert.equal(h(encode({ type: 'disconnect' }, 4)), 'e000');
});

test('CONNECT with a will, user name and password carries every field and flag', () => {
  const c: Packet = { type: 'connect', protocolLevel: 4, clean: false, keepAlive: 30, clientId: 'dev-1', will: { topic: 'status/dev-1', payload: Buffer.from('offline'), qos: 1, retain: true }, username: 'ana', password: Buffer.from('pw') };
  const b = encode(c, 4);
  assert.equal(b[9], 0b11101100, 'user, password, will retain, will QoS 1, will flag, not clean');
  assert.deepEqual(decode(b, 4), c);
});

test('PUBLISH bytes for every QoS, and retain and dup flags', () => {
  const p0: Packet = { type: 'publish', topic: 'a/b', payload: Buffer.from('hi'), qos: 0, retain: false, dup: false };
  assert.equal(h(encode(p0, 4)), '30070003612f626869');
  const p1: Packet = { type: 'publish', topic: 'a/b', payload: Buffer.from('hi'), qos: 1, retain: false, dup: false, packetId: 10 };
  assert.equal(h(encode(p1, 4)), '32090003612f62000a6869');
  const p2: Packet = { type: 'publish', topic: 'a/b', payload: Buffer.from('hi'), qos: 2, retain: true, dup: true, packetId: 65535 };
  assert.equal(encode(p2, 4)[0], 0x3d);
  for (const p of [p0, p1, p2]) assert.deepEqual(decode(encode(p, 4), 4), p);
  assert.throws(() => encode({ ...p1, packetId: undefined as never }, 4), /need a packet identifier/);
  assert.throws(() => encode({ ...p0, packetId: 1 }, 4), /no packet identifier/);
  assert.throws(() => encode({ ...p0, dup: true }, 4), /never a duplicate/);
  assert.throws(() => encode({ ...p1, packetId: 0 }, 4), /1 to 65535/);
});

test('SUBSCRIBE, SUBACK, UNSUBSCRIBE, UNSUBACK and the QoS acknowledgements', () => {
  const sub: Packet = { type: 'subscribe', packetId: 1, subscriptions: [{ filter: 'a/b', qos: 1 }] };
  assert.equal(h(encode(sub, 4)), '820800010003612f6201');
  assert.deepEqual(decode(encode(sub, 4), 4), sub);
  assert.equal(h(encode({ type: 'suback', packetId: 1, codes: [1, 0x80] }, 4)), '9004000101' + '80');
  const unsub: Packet = { type: 'unsubscribe', packetId: 2, filters: ['a/b', 'c/#'] };
  assert.equal(h(encode(unsub, 4)).slice(0, 4), 'a20c');
  assert.deepEqual(decode(encode(unsub, 4), 4), unsub);
  assert.equal(h(encode({ type: 'unsuback', packetId: 2 }, 4)), 'b0020002');
  assert.equal(h(encode({ type: 'puback', packetId: 7 }, 4)), '40020007');
  assert.equal(h(encode({ type: 'pubrec', packetId: 7 }, 4)), '50020007');
  assert.equal(h(encode({ type: 'pubrel', packetId: 7 }, 4)), '62020007', 'PUBREL has the flag bits 0010');
  assert.equal(h(encode({ type: 'pubcomp', packetId: 7 }, 4)), '70020007');
});

test('MQTT 5: properties encode and decode, including repeated user properties and a variable integer', () => {
  const props = { sessionExpiryInterval: 3600, receiveMaximum: 20, userProperties: [['k', 'v'], ['k', 'w']] as [string, string][], authenticationData: Buffer.from([1, 2]) };
  const c: Packet = { type: 'connect', protocolLevel: 5, clean: true, keepAlive: 10, clientId: 'c', properties: props };
  const b = encode(c, 5);
  assert.deepEqual(decode(b, 5), c);
  assert.equal(h(encodeVarInt(0)) + h(Buffer.from([0x11, 0, 0, 0x0e, 0x10])), '00' + '110000 0e10'.replace(/ /g, ''));
  const noProps = encode({ type: 'connack', sessionPresent: true, code: 0 }, 5);
  assert.equal(h(noProps), '2003010000');
  const withProps = decode(encode({ type: 'connack', sessionPresent: false, code: 0, properties: { sessionExpiryInterval: 3600, maximumQoS: 1 } }, 5), 5) as Extract<Packet, { type: 'connack' }>;
  assert.deepEqual(withProps.properties, { sessionExpiryInterval: 3600, maximumQoS: 1 });
  const pub = encode({ type: 'publish', topic: 'a/b', payload: Buffer.from('hi'), qos: 0, retain: false, dup: false }, 5);
  assert.equal(h(pub), '300800' + '03612f62' + '00' + '6869'.replace(/^/, ''));
});

test('MQTT 5: subscription options, reason codes on acknowledgements and disconnect, and properties refused in 3.1.1', () => {
  const sub: Packet = { type: 'subscribe', packetId: 9, subscriptions: [{ filter: 'x/+', qos: 2, noLocal: true, retainAsPublished: true, retainHandling: 2 }] };
  const b = encode(sub, 5);
  assert.equal(b[b.length - 1], 0b00101110);
  assert.deepEqual(decode(b, 5), sub);
  assert.equal(h(encode({ type: 'puback', packetId: 5 }, 5)), '40020005', 'success is the short form');
  const rej: Packet = { type: 'puback', packetId: 5, code: 0x97 };
  assert.equal(h(encode(rej, 5)), '4003000597');
  assert.deepEqual(decode(encode(rej, 5), 5), rej);
  assert.equal(h(encode({ type: 'disconnect', code: 0x8e, properties: { reasonString: 'x' } }, 5)), 'e006' + '8e' + '04' + '1f0001' + '78');
  assert.equal(h(encode({ type: 'disconnect' }, 5)), 'e000');
  assert.deepEqual(decode(hex('e000'), 5), { type: 'disconnect' });
  assert.throws(() => encode({ type: 'connack', sessionPresent: false, code: 0, properties: { maximumQoS: 1 } }, 4), /only in MQTT 5/);
  assert.throws(() => encode({ type: 'auth', code: 0 }, 4), /only in MQTT 5/);
  assert.deepEqual(decode(encode({ type: 'auth', code: 0x18, properties: { authenticationMethod: 'SCRAM' } }, 5), 5), { type: 'auth', code: 0x18, properties: { authenticationMethod: 'SCRAM' } });
});

test('hostile packets are refused: bad flags, reserved bits, bad strings, left-over bytes, unknown properties, QoS 3', () => {
  const s = (b: string, v: 4 | 5 = 4) => () => new PacketStream({ version: v }).push(hex(b));
  assert.throws(s('6002000'+'1'.slice(0, 0) + '10'.slice(0, 0) + '01'), /flags of pubrel must be 2/);
  assert.throws(s('00 00'), /type 0 is reserved/);
  assert.throws(s('c1 00'), /flags of pingreq/);
  assert.throws(s('36 05 0003 612f62'.replace(/ /g, '')), /QoS 3/);
  assert.throws(s('30 06 0003 612f2b 68'), /no wildcards/);
  assert.throws(s('30 05 0003 612f00'), /NUL/);
  assert.throws(s('30 05 0003 612fff'), /not valid UTF-8/);
  assert.throws(s('d0 01 00'), /bytes left over/);
  assert.throws(s('40 02 0000'), /not 0/);
  assert.throws(s('20 02 0200'), /reserved connack flags/);
  assert.throws(s('20 03 0000 05'.replace(/ /g, ''), 5), MqttError);
  assert.throws(s('20 04 0000 01 ff', 5), /not known|ends/);
  assert.throws(s('82 08 0001 0003 612f62 03'.replace(/ /g, '')), /reserved subscription bits|QoS cannot be 3/);
  assert.throws(s('82 02 0001'), /no topic filters/);
  assert.throws(() => new PacketStream().push(hex('3000')), /first packet must be CONNECT/);
});

test('CONNECT rules: protocol name, unsupported levels, reserved flag, will flags, password without user, empty id', () => {
  const body = (level: number, flags: number, id = '0000') => `00044d515454${level.toString(16).padStart(2, '0')}${flags.toString(16).padStart(2, '0')}003c${id}`;
  const pkt = (b: string) => () => new PacketStream().push(hex(`10${(b.length / 2).toString(16).padStart(2, '0')}${b}`));
  assert.throws(pkt(body(3, 2)), /protocol level 3/);
  assert.throws(pkt(body(4, 3)), /reserved connect flag/);
  assert.throws(pkt(body(4, 0x28)), /need the will flag/);
  assert.throws(pkt(body(4, 0x40, '00016100' + '00')), /without a user name/);
  assert.throws(pkt(body(4, 0)), /empty client id needs a clean session/);
  assert.throws(() => new PacketStream().push(hex('100c00044d5151540402003c0000')), /not MQTT/);
  assert.equal((new PacketStream().push(hex(`10${(body(4, 2).length / 2).toString(16).padStart(2, '0')}${body(4, 2)}`))[0] as { keepAlive: number }).keepAlive, 60);
});

test('the stream finds packets across arbitrary chunks, and holds back a partial one', () => {
  const stream = new PacketStream();
  const bytes = Buffer.concat([encode({ type: 'connect', protocolLevel: 4, clean: true, keepAlive: 5, clientId: 'abc' }, 4), encode({ type: 'publish', topic: 't', payload: Buffer.alloc(300, 7), qos: 0, retain: false, dup: false }, 4), encode({ type: 'pingreq' }, 4)]);
  const got: Packet[] = [];
  for (let i = 0; i < bytes.length; i += 7) got.push(...stream.push(bytes.subarray(i, i + 7)));
  assert.deepEqual(got.map((p) => p.type), ['connect', 'publish', 'pingreq']);
  assert.equal((got[1] as unknown as { payload: Buffer }).payload.length, 300);
  assert.equal(stream.buffered, 0);
  assert.equal(stream.version, 4);
  const one = new PacketStream({ version: 4 });
  assert.deepEqual(one.push(hex('c0')), []);
  assert.equal(one.buffered, 1);
  assert.deepEqual(one.push(hex('00')), [{ type: 'pingreq' }]);
});

test('a packet over the size limit is refused before it is buffered', () => {
  const s = new PacketStream({ version: 4, maxPacketBytes: 1000 });
  assert.throws(() => s.push(hex('30') .length ? Buffer.concat([hex('30'), encodeVarInt(5000)]) : hex('')), /over the 1000 byte limit/);
});

test('topic names and filters: valid and invalid forms', () => {
  for (const f of ['a', 'a/b', '+', '#', 'a/+/c', 'a/#', '/', '+/+', '$SYS/#', '$share/g/a/+']) assert.doesNotThrow(() => validateTopicFilter(f), f);
  for (const f of ['', 'a#', '#/a', 'a/#/b', 'a+', '+a', 'a/b+/c', '$share//a', '$share/g+/a', 'a\0']) assert.throws(() => validateTopicFilter(f), MqttError, f);
  for (const t of ['a', 'a/b', '/', '$SYS/x', 'a b/ü']) assert.doesNotThrow(() => validateTopicName(t));
  for (const t of ['', 'a/+', 'a/#', 'a\0']) assert.throws(() => validateTopicName(t), MqttError, t);
  assert.deepEqual(shared('$share/g1/a/b'), { group: 'g1', filter: 'a/b' });
  assert.equal(shared('a/b'), undefined);
});

test('wildcard matching: the examples of the specification (section 4.7)', () => {
  const yes: [string, string][] = [['sport/tennis/player1/#', 'sport/tennis/player1'], ['sport/tennis/player1/#', 'sport/tennis/player1/ranking'], ['sport/tennis/player1/#', 'sport/tennis/player1/score/wimbledon'], ['sport/#', 'sport'], ['#', 'a/b/c'], ['sport/tennis/+', 'sport/tennis/player1'], ['+/+', '/finance'], ['/+', '/finance'], ['+', 'x'], ['sport/+/player1', 'sport/tennis/player1'], ['a/b', 'a/b'], ['$SYS/#', '$SYS/broker/load'], ['$SYS/+/x', '$SYS/a/x']];
  const no: [string, string][] = [['sport/tennis/+', 'sport/tennis/player1/ranking'], ['sport/tennis/+', 'sport/tennis'], ['+', '/finance'], ['sport/+', 'sport'], ['a/b', 'a/b/c'], ['a/b/c', 'a/b'], ['#', '$SYS/broker'], ['+/broker', '$SYS/broker'], ['a/+/c', 'a/b/d']];
  for (const [f, t] of yes) assert.equal(topicMatches(f, t), true, `${f} ~ ${t}`);
  for (const [f, t] of no) assert.equal(topicMatches(f, t), false, `${f} !~ ${t}`);
  assert.equal(topicMatches('$share/g/a/+', 'a/b'), true);
});

test('the subscription tree finds each client once at the highest QoS, and respects $ topics', () => {
  const t = new SubscriptionTree();
  t.subscribe('c1', 'a/+', { qos: 0 });
  t.subscribe('c1', 'a/b', { qos: 2 });
  t.subscribe('c1', '#', { qos: 1 });
  t.subscribe('c2', 'a/#', { qos: 1, noLocal: true });
  t.subscribe('c3', '$SYS/#', { qos: 1 });
  t.subscribe('c4', '+/b', { qos: 0 });
  const m = t.match('a/b');
  assert.deepEqual(m.map((d) => [d.clientId, d.qos]).sort(), [['c1', 2], ['c2', 1], ['c4', 0]]);
  assert.equal(m.find((d) => d.clientId === 'c2')!.noLocal, true);
  assert.deepEqual(t.match('$SYS/x').map((d) => d.clientId), ['c3'], 'a wildcard first level does not reach $ topics');
  assert.deepEqual(t.match('z/z').map((d) => d.clientId), ['c1']);
  assert.equal(t.unsubscribe('c1', 'a/b'), true);
  assert.equal(t.unsubscribe('c1', 'a/b'), false);
  assert.equal(t.match('a/b').find((d) => d.clientId === 'c1')!.qos, 1);
  t.removeClient('c1');
  assert.deepEqual(t.match('a/b').map((d) => d.clientId).sort(), ['c2', 'c4']);
  assert.throws(() => t.match('a/+'), /no wildcards/);
});

test('shared subscriptions deliver to one member of the group, not all', () => {
  const t = new SubscriptionTree();
  for (const c of ['w1', 'w2', 'w3']) t.subscribe(c, '$share/workers/jobs/#', { qos: 1 });
  t.subscribe('audit', 'jobs/#', { qos: 0 });
  const m = t.match('jobs/42', { pick: (ms) => ms[1]! });
  assert.deepEqual(m.map((d) => d.clientId).sort(), ['audit', 'w2']);
  assert.equal(t.match('jobs/42').filter((d) => d.clientId.startsWith('w')).length, 1);
  assert.deepEqual(t.subscribe('w1', '$share/workers/jobs/#', { qos: 2 }), { existed: true });
});

test('retained messages: last one wins, an empty payload clears, new subscribers get the matching ones', () => {
  const r = new RetainedStore();
  r.set({ topic: 'home/temp', payload: Buffer.from('20'), qos: 1 });
  r.set({ topic: 'home/temp', payload: Buffer.from('21'), qos: 1 });
  r.set({ topic: 'home/door', payload: Buffer.from('open'), qos: 0 });
  r.set({ topic: '$SYS/up', payload: Buffer.from('1'), qos: 0 });
  assert.equal(r.size, 3);
  assert.deepEqual(r.match('home/#').map((m) => [m.topic, Buffer.from(m.payload).toString()]), [['home/door', 'open'], ['home/temp', '21']]);
  assert.deepEqual(r.match('#').map((m) => m.topic), ['home/door', 'home/temp'], '# does not return $ topics');
  r.set({ topic: 'home/door', payload: Buffer.alloc(0), qos: 0 });
  assert.deepEqual(r.match('home/+').map((m) => m.topic), ['home/temp']);
  assert.throws(() => r.set({ topic: 'home/+', payload: Buffer.from('x'), qos: 0 }), /no wildcards/);
});

test('QoS 1 sending: an identifier, an acknowledgement frees it, identifiers are reused safely', () => {
  const s = new Session();
  const [p] = s.send({ topic: 't', payload: Buffer.from('x'), qos: 1, retain: false }) as [Extract<Packet, { type: 'publish' }>];
  assert.equal(p.packetId, 1);
  assert.equal(s.inflight, 1);
  const [q] = s.send({ topic: 't', payload: Buffer.from('y'), qos: 1, retain: false }) as [Extract<Packet, { type: 'publish' }>];
  assert.equal(q.packetId, 2);
  s.onPuback(1);
  assert.equal(s.inflight, 1);
  assert.throws(() => s.onPuback(1), /not waiting/);
  assert.throws(() => s.onPubrec(2), /not waiting for one/, 'a QoS 1 message gets no PUBREC');
  assert.deepEqual(s.send({ topic: 't', payload: Buffer.alloc(0), qos: 0, retain: false }).map((x) => x.type), ['publish'], 'QoS 0 is never tracked');
  assert.equal(s.inflight, 1);
});

test('QoS 2 sending: PUBLISH, PUBREC, PUBREL, PUBCOMP, and a repeated PUBREC just repeats PUBREL', () => {
  const s = new Session();
  const [p] = s.send({ topic: 't', payload: Buffer.from('x'), qos: 2, retain: false }) as [Extract<Packet, { type: 'publish' }>];
  assert.deepEqual(s.onPubrec(p.packetId!), [{ type: 'pubrel', packetId: p.packetId }]);
  assert.deepEqual(s.onPubrec(p.packetId!), [{ type: 'pubrel', packetId: p.packetId }]);
  assert.throws(() => s.onPuback(p.packetId!), /not waiting/);
  assert.equal(s.inflight, 1, 'still held until PUBCOMP');
  s.onPubcomp(p.packetId!);
  assert.equal(s.inflight, 0);
  assert.throws(() => s.onPubcomp(p.packetId!), /not waiting/);
});

test('the receive-maximum window queues the rest and sends them as acknowledgements free slots', () => {
  const s = new Session({ receiveMaximum: 2 });
  const sent = [1, 2, 3, 4].flatMap((i) => s.send({ topic: 't', payload: Buffer.from(String(i)), qos: 1, retain: false }));
  assert.equal(sent.length, 2);
  assert.equal(s.queued, 2);
  const freed = s.onPuback(1);
  assert.equal(freed.length, 1);
  assert.equal(Buffer.from((freed[0] as unknown as { payload: Buffer }).payload).toString(), '3');
  assert.deepEqual([s.inflight, s.queued], [2, 1]);
  assert.equal((freed[0] as { packetId: number }).packetId, 3, 'the freed identifier is not reused while later ones are in flight');
  assert.throws(() => new Session({ receiveMaximum: 0 }), /1 to 65535/);
});

test('receiving: QoS 1 is delivered and acknowledged; QoS 2 is delivered once even if sent twice', () => {
  const s = new Session();
  const pub = (qos: 1 | 2, id: number, dup = false): Extract<Packet, { type: 'publish' }> => ({ type: 'publish', topic: 't', payload: Buffer.from('x'), qos, retain: false, dup, packetId: id });
  assert.deepEqual(s.receive(pub(1, 5)), { deliver: true, reply: [{ type: 'puback', packetId: 5 }] });
  const first = s.receive(pub(2, 6));
  assert.deepEqual(first, { deliver: true, reply: [{ type: 'pubrec', packetId: 6 }] });
  const again = s.receive(pub(2, 6, true));
  assert.deepEqual(again, { deliver: false, reply: [{ type: 'pubrec', packetId: 6 }] });
  assert.deepEqual(s.onPubrel(6), [{ type: 'pubcomp', packetId: 6 }]);
  assert.deepEqual(s.onPubrel(6), [{ type: 'pubcomp', packetId: 6, code: 0x92 }], 'a repeated PUBREL still gets its PUBCOMP');
  assert.equal(s.receive(pub(2, 6)).deliver, true, 'the identifier can be used again after PUBCOMP');
  assert.deepEqual(s.receive({ ...pub(1, 1), qos: 0 } as never), { deliver: true, reply: [] });
});

test('resuming a session resends what was not acknowledged: publishes marked as duplicates, and PUBREL for QoS 2 past PUBREC', () => {
  const s = new Session();
  s.send({ topic: 'a', payload: Buffer.from('1'), qos: 1, retain: false });
  s.send({ topic: 'b', payload: Buffer.from('2'), qos: 2, retain: true });
  s.send({ topic: 'c', payload: Buffer.from('3'), qos: 2, retain: false });
  s.onPubrec(3);
  s.onPuback(1);
  const again = s.resume();
  assert.deepEqual(again.map((p) => [p.type, (p as { packetId: number }).packetId, (p as { dup?: boolean }).dup]), [['publish', 2, true], ['pubrel', 3, undefined]]);
  assert.equal((again[0] as { retain: boolean }).retain, true);
  assert.deepEqual(new Session().resume(), []);
});

test('a packet identifier in use is skipped on wrap-around, and exhaustion is reported', () => {
  const s = new Session();
  const first = s.send({ topic: 't', payload: Buffer.alloc(0), qos: 1, retain: false })[0] as { packetId: number };
  for (let i = 0; i < 65533; i++) s.send({ topic: 't', payload: Buffer.alloc(0), qos: 1, retain: false });
  assert.equal(s.inflight, 65534);
  const wrap = s.send({ topic: 't', payload: Buffer.alloc(0), qos: 1, retain: false })[0] as { packetId: number };
  assert.equal(wrap.packetId, 65535);
  assert.equal(s.inflight, 65535);
  assert.deepEqual(s.send({ topic: 't', payload: Buffer.alloc(0), qos: 1, retain: false }), [], 'the window is full, so it waits');
  assert.equal(s.queued, 1);
  const freed = s.onPuback(first.packetId);
  assert.equal((freed[0] as { packetId: number }).packetId, first.packetId, 'the identifier that was freed is the one reused');
  assert.equal(s.queued, 0);
});
