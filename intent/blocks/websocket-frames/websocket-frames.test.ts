import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameDecoder, OP, Session, WsHandshakeRefused, WsProtocolError, WsSendRefused, acceptKey, applyMask, checkUpgrade, decodeClosePayload, encodeClosePayload, encodeFrame, upgradeResponse, validCloseCode } from './index.ts';
import type { SessionEvent } from './index.ts';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const KEY = hex('37fa213d');

test('the accept key is the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('RFC 6455 5.7 examples encode byte for byte', () => {
  assert.deepEqual(encodeFrame({ opcode: OP.text, payload: Buffer.from('Hello') }), hex('81 05 48 65 6c 6c 6f'));
  assert.deepEqual(encodeFrame({ opcode: OP.text, payload: Buffer.from('Hello'), mask: KEY }), hex('81 85 37 fa 21 3d 7f 9f 4d 51 58'));
  assert.deepEqual(encodeFrame({ fin: false, opcode: OP.text, payload: Buffer.from('Hel') }), hex('01 03 48 65 6c'));
  assert.deepEqual(encodeFrame({ opcode: OP.continuation, payload: Buffer.from('lo') }), hex('80 02 6c 6f'));
  assert.deepEqual(encodeFrame({ opcode: OP.ping, payload: Buffer.from('Hello') }), hex('89 05 48 65 6c 6c 6f'));
  assert.deepEqual(encodeFrame({ opcode: OP.pong, payload: Buffer.from('Hello'), mask: KEY }), hex('8a 85 37 fa 21 3d 7f 9f 4d 51 58'));
  const b256 = encodeFrame({ opcode: OP.binary, payload: Buffer.alloc(256) });
  assert.deepEqual(b256.subarray(0, 4), hex('82 7e 01 00'));
  assert.equal(b256.length, 4 + 256);
  const b64k = encodeFrame({ opcode: OP.binary, payload: Buffer.alloc(65536) });
  assert.deepEqual(b64k.subarray(0, 10), hex('82 7f 00 00 00 00 00 01 00 00'));
});

test('the decoder reads the RFC examples, masked and not, and unmasks the payload', () => {
  const server = new FrameDecoder({ role: 'server' });
  const [f] = server.push(hex('81 85 37 fa 21 3d 7f 9f 4d 51 58'));
  assert.equal(f!.payload.toString(), 'Hello');
  assert.equal(f!.fin, true);
  assert.equal(f!.opcode, OP.text);
  assert.equal(f!.masked, true);
  const client = new FrameDecoder({ role: 'client' });
  const frames = client.push(hex('01 03 48 65 6c 80 02 6c 6f'));
  assert.deepEqual(frames.map((x) => [x.fin, x.opcode, x.payload.toString()]), [[false, 1, 'Hel'], [true, 0, 'lo']]);
});

test('bytes may arrive in any pieces, even one at a time, and the same frames come out', () => {
  const wire = Buffer.concat([encodeFrame({ opcode: OP.text, payload: Buffer.from('one'), mask: KEY }), encodeFrame({ opcode: OP.binary, payload: Buffer.alloc(300, 7), mask: KEY })]);
  const d = new FrameDecoder({ role: 'server' });
  const got = [];
  for (const byte of wire) got.push(...d.push(Buffer.from([byte])));
  assert.equal(got.length, 2);
  assert.equal(got[0]!.payload.toString(), 'one');
  assert.equal(got[1]!.payload.length, 300);
  assert.ok(got[1]!.payload.every((x) => x === 7));
  assert.equal(d.pending, 0);
});

test('masking is its own inverse and needs a 4-byte key', () => {
  const p = Buffer.from('some payload, longer than a key');
  assert.deepEqual(applyMask(applyMask(p, KEY), KEY), p);
  assert.notDeepEqual(applyMask(p, KEY), p);
  assert.throws(() => applyMask(p, Buffer.alloc(3)), RangeError);
});

test('protocol violations in a frame carry the right close code', () => {
  const code = (role: 'server' | 'client', bytes: Buffer) => {
    try {
      new FrameDecoder({ role }).push(bytes);
    } catch (e) {
      assert.ok(e instanceof WsProtocolError);
      return e.code;
    }
    return undefined;
  };
  assert.equal(code('server', hex('81 05 48 65 6c 6c 6f')), 1002, 'a client frame that is not masked');
  assert.equal(code('client', hex('81 85 37 fa 21 3d 7f 9f 4d 51 58')), 1002, 'a server frame that is masked');
  assert.equal(code('client', hex('c1 01 41')), 1002, 'RSV1 with no extension');
  assert.equal(code('client', hex('83 00')), 1002, 'an undefined opcode');
  assert.equal(code('client', hex('09 00')), 1002, 'a fragmented ping');
  assert.equal(code('client', hex('89 7e 00 7e') ), 1002, 'a ping of 126 bytes');
  assert.equal(code('client', hex('81 7e 00 05 48 65 6c 6c 6f')), 1002, 'a length in 16 bits that fits in 7');
  assert.equal(code('client', hex('81 7f 00 00 00 00 00 00 00 05')), 1002, 'a length in 64 bits that fits in 7');
  assert.equal(code('client', hex('81 7f 80 00 00 00 00 00 00 00')), 1002, 'a 64-bit length with the top bit set');
});

test('a frame over the limit is refused from its length alone, before its payload arrives', () => {
  const d = new FrameDecoder({ role: 'client', maxFrameBytes: 1000 });
  assert.throws(() => d.push(hex('82 7e 04 00')), (e) => e instanceof WsProtocolError && e.code === 1009);
  const huge = new FrameDecoder({ role: 'client', maxFrameBytes: 1000 });
  assert.throws(() => huge.push(hex('82 7f 00 00 00 01 00 00 00 00')), (e) => e instanceof WsProtocolError && e.code === 1009);
});

test('close codes: only those the RFC lets onto the wire', () => {
  for (const c of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4999]) assert.equal(validCloseCode(c), true, String(c));
  for (const c of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000]) assert.equal(validCloseCode(c), false, String(c));
  assert.deepEqual(encodeClosePayload(1000, 'bye'), hex('03 e8 62 79 65'));
  assert.deepEqual(decodeClosePayload(hex('03 e8 62 79 65')), { code: 1000, reason: 'bye' });
  assert.deepEqual(decodeClosePayload(Buffer.alloc(0)), { code: 1005, reason: '' });
  assert.throws(() => encodeClosePayload(1006), RangeError);
  assert.throws(() => decodeClosePayload(hex('03')), (e) => e instanceof WsProtocolError && e.code === 1002);
  assert.throws(() => decodeClosePayload(hex('03 ed')), (e) => e instanceof WsProtocolError && e.code === 1002, '1005 on the wire');
  assert.throws(() => decodeClosePayload(hex('03 e8 ff fe')), (e) => e instanceof WsProtocolError && e.code === 1007);
});

test('a long close reason is cut to 123 bytes on a character boundary', () => {
  const p = encodeClosePayload(1000, 'é'.repeat(100));
  assert.equal(p.length, 2 + 122);
  assert.equal(decodeClosePayload(p).reason, 'é'.repeat(61));
});

interface Rig {
  s: Session;
  wire: Buffer[];
  t: { now: number };
  full: { value: boolean };
}
const rig = (role: 'server' | 'client', o: Partial<ConstructorParameters<typeof Session>[0]> = {}): Rig => {
  const wire: Buffer[] = [];
  const t = { now: 1000 };
  const full = { value: false };
  const s = new Session({ role, write: (b) => (wire.push(b), !full.value), now: () => t.now, maskKey: () => KEY, ...o });
  return { s, wire, t, full };
};
const fromClient = (opcode: number, payload: Buffer | string, fin = true) => encodeFrame({ fin, opcode, payload: Buffer.from(payload), mask: KEY });
const decodeAll = (wire: Buffer[], role: 'server' | 'client') => new FrameDecoder({ role }).push(Buffer.concat(wire));

test('a session reassembles fragments, with a ping allowed between them', () => {
  const { s, wire } = rig('server');
  const ev = s.receive(Buffer.concat([fromClient(OP.text, 'Hel', false), fromClient(OP.ping, 'x'), fromClient(OP.continuation, 'lo')]));
  assert.deepEqual(ev.map((e) => e.type), ['text', 'ping']);
  assert.equal((ev[0] as { text: string }).text, 'Hello');
  const frames = decodeAll(wire, 'client');
  assert.deepEqual(frames.map((f) => [f.opcode, f.payload.toString()]), [[OP.pong, 'x']]);
});

test('a text message split in the middle of a character is still valid; bad UTF-8 closes with 1007', () => {
  const euro = Buffer.from('€');
  const a = rig('server');
  const ev = a.s.receive(Buffer.concat([fromClient(OP.text, euro.subarray(0, 1), false), fromClient(OP.continuation, euro.subarray(1))]));
  assert.deepEqual(ev, [{ type: 'text', text: '€' }]);
  const b = rig('server');
  const bad = b.s.receive(fromClient(OP.text, Buffer.from([0xc3, 0x28])));
  assert.equal(bad[0]!.type, 'close');
  assert.equal((bad[0] as { code: number }).code, 1007);
  assert.equal(b.s.state, 'closed');
  assert.deepEqual(decodeAll(b.wire, 'client')[0]!.payload.readUInt16BE(0), 1007);
  const c = rig('server');
  assert.equal((c.s.receive(fromClient(OP.text, Buffer.from([0xf0, 0x9f])))[0] as { code: number }).code, 1007, 'a character left unfinished');
});

test('fragmentation order is enforced', () => {
  const lone = rig('server').s.receive(fromClient(OP.continuation, 'x'));
  assert.equal((lone[0] as { code: number }).code, 1002);
  const interleaved = rig('server').s.receive(Buffer.concat([fromClient(OP.text, 'a', false), fromClient(OP.text, 'b')]));
  assert.equal((interleaved[0] as { code: number }).code, 1002);
});

test('the message limit counts all fragments together', () => {
  const { s } = rig('server', { maxMessageBytes: 10 });
  const ev = s.receive(Buffer.concat([fromClient(OP.binary, Buffer.alloc(6), false), fromClient(OP.continuation, Buffer.alloc(6))]));
  assert.equal((ev[0] as { code: number }).code, 1009);
  assert.equal(s.state, 'closed');
  assert.deepEqual(s.receive(fromClient(OP.text, 'later')), [], 'a closed session ignores input');
});

test('a close from the peer is answered with the same code, and the session ends cleanly', () => {
  const { s, wire } = rig('server');
  const ev = s.receive(fromClient(OP.close, encodeClosePayload(1001, 'leaving')));
  assert.deepEqual(ev, [{ type: 'close', code: 1001, reason: 'leaving', clean: true, byUs: false }]);
  assert.equal(s.state, 'closed');
  const f = decodeAll(wire, 'client');
  assert.equal(f.length, 1);
  assert.equal(f[0]!.opcode, OP.close);
  assert.equal(f[0]!.payload.readUInt16BE(0), 1001);
  assert.throws(() => s.sendText('x'), WsSendRefused);
});

test('when we close first the session waits for the answer, and gives up after the timeout', () => {
  const { s, wire, t } = rig('server', { closeTimeoutMs: 5000 });
  s.close(1000, 'done');
  assert.equal(s.state, 'closing');
  assert.throws(() => s.sendText('too late'), WsSendRefused);
  assert.deepEqual(s.tick(), []);
  t.now += 4999;
  assert.deepEqual(s.tick(), []);
  t.now += 1;
  assert.deepEqual(s.tick(), [{ type: 'close', code: 1006, reason: 'the peer did not answer our close', clean: false, byUs: true }]);
  assert.equal(decodeAll(wire, 'client').length, 1);
  const again = rig('server');
  again.s.close(1000);
  assert.deepEqual(again.s.receive(fromClient(OP.close, encodeClosePayload(1000))), [{ type: 'close', code: 1000, reason: '', clean: true, byUs: true }]);
  assert.equal(decodeAll(again.wire, 'client').length, 1, 'no second close is sent');
});

test('a burst of pings is answered once, with the last payload', () => {
  const { s, wire } = rig('server');
  s.receive(Buffer.concat([fromClient(OP.ping, 'a'), fromClient(OP.ping, 'b'), fromClient(OP.ping, 'c')]));
  const f = decodeAll(wire, 'client');
  assert.deepEqual(f.map((x) => x.payload.toString()), ['c']);
});

test('a quiet line is pinged, the pong is timed, and a missing pong ends the session', () => {
  const { s, wire, t } = rig('server', { pingIntervalMs: 1000, pongTimeoutMs: 500 });
  t.now += 999;
  assert.deepEqual(s.tick(), []);
  assert.equal(wire.length, 0);
  t.now += 1;
  s.tick();
  const ping = decodeAll(wire, 'client')[0]!;
  assert.equal(ping.opcode, OP.ping);
  t.now += 40;
  const ev = s.receive(fromClient(OP.pong, ping.payload));
  assert.deepEqual(ev, [{ type: 'pong', payload: ping.payload, rttMs: 40 }]);
  assert.deepEqual(s.tick(), [], 'any traffic resets the quiet timer');
  t.now += 1000;
  s.tick();
  t.now += 500;
  assert.deepEqual(s.tick(), [{ type: 'close', code: 1006, reason: 'no answer to ping', clean: false, byUs: true }]);
});

test('a client masks every frame with a fresh key per frame; a server never does', () => {
  const keys = [hex('01020304'), hex('0a0b0c0d')];
  let i = 0;
  const c = rig('client', { maskKey: () => keys[i++]! });
  c.s.sendText('a');
  c.s.sendText('a');
  assert.deepEqual(c.wire[0]!.subarray(2, 6), keys[0]);
  assert.deepEqual(c.wire[1]!.subarray(2, 6), keys[1]);
  assert.notDeepEqual(c.wire[0], c.wire[1]);
  const sv = rig('server');
  sv.s.sendText('a');
  assert.deepEqual(sv.wire[0], hex('81 01 61'));
});

test('large messages leave as fragments of the configured size and reassemble on the other side', () => {
  const a = rig('server', { fragmentBytes: 100 });
  const text = 'x'.repeat(250);
  a.s.sendText(text);
  const frames = decodeAll(a.wire, 'client');
  assert.deepEqual(frames.map((f) => [f.fin, f.opcode, f.payload.length]), [[false, 1, 100], [false, 0, 100], [true, 0, 50]]);
  const b = rig('client');
  assert.deepEqual(b.s.receive(Buffer.concat(a.wire)), [{ type: 'text', text }]);
});

test('backpressure: when the socket is full data queues up to a limit, control frames do not wait, and drain sends in order', () => {
  const { s, wire, full } = rig('server', { maxQueuedBytes: 20 });
  full.value = true;
  s.sendText('first');
  assert.equal(s.backpressured, true);
  s.sendText('second');
  s.sendText('third');
  assert.equal(wire.length, 1, 'only the first was written');
  assert.equal(s.queuedBytes, 15);
  assert.throws(() => s.sendText('this will not fit'), WsSendRefused);
  s.ping(Buffer.from('p'));
  assert.equal(wire.length, 2, 'a ping goes straight out');
  full.value = false;
  s.drain();
  assert.equal(s.backpressured, false);
  assert.equal(s.queuedBytes, 0);
  const texts = decodeAll(wire, 'client').filter((f) => f.opcode === OP.text).map((f) => f.payload.toString());
  assert.deepEqual(texts, ['first', 'second', 'third']);
});

test('closing drops what was queued, and a socket that ends without a close is 1006', () => {
  const { s, full } = rig('server');
  full.value = true;
  s.sendText('a');
  s.sendText('b');
  s.close(1001);
  assert.equal(s.queuedBytes, 0);
  const t = rig('client');
  assert.deepEqual(t.s.socketClosed(), [{ type: 'close', code: 1006, reason: 'the connection ended without a close frame', clean: false, byUs: false }]);
  assert.deepEqual(t.s.socketClosed(), []);
});

test('the opening handshake: accepted request, version, key and origin checks', () => {
  const good = { 'connection': 'keep-alive, Upgrade', 'upgrade': 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'origin': 'https://app.example.org', 'sec-websocket-protocol': 'chat, superchat' };
  const c = checkUpgrade({ method: 'GET', headers: good }, { origins: ['https://app.example.org'] });
  assert.deepEqual(c.protocols, ['chat', 'superchat']);
  const res = upgradeResponse(c, 'chat');
  assert.match(res, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(res, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
  assert.match(res, /Sec-WebSocket-Protocol: chat\r\n\r\n$/);
  assert.throws(() => upgradeResponse(c, 'other'), WsHandshakeRefused);
  const status = (h: Record<string, string>, method = 'GET', o = {}) => {
    try {
      checkUpgrade({ method, headers: { ...good, ...h } }, o);
    } catch (e) {
      return (e as WsHandshakeRefused).status;
    }
    return 101;
  };
  assert.equal(status({}, 'POST'), 405);
  assert.equal(status({ 'sec-websocket-version': '8' }), 426);
  assert.equal(status({ 'sec-websocket-key': 'short' }), 400);
  assert.equal(status({ upgrade: 'h2c' }), 400);
  assert.equal(status({ connection: 'close' }), 400);
  assert.equal(status({ origin: 'https://evil.example' }, 'GET', { origins: ['https://app.example.org'] }), 403, 'a page on another site cannot open a socket');
  assert.equal(status({}, 'GET', {}), 101, 'with no origin list the check is the caller\'s');
});

test('a missing Origin is refused when origins are enforced, unless the caller allows non-browser clients', () => {
  const { origin: _o, ...h } = { 'connection': 'upgrade', 'upgrade': 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'origin': '' };
  assert.throws(() => checkUpgrade({ method: 'GET', headers: h }, { origins: ['https://a.example'] }), (e) => (e as WsHandshakeRefused).status === 403);
  assert.equal(checkUpgrade({ method: 'GET', headers: h }, { origins: ['https://a.example'], allowMissingOrigin: true }).origin, undefined);
});

test('a client session round trips a server session over both directions', () => {
  const toServer: Buffer[] = [];
  const toClient: Buffer[] = [];
  const client = new Session({ role: 'client', write: (b) => (toServer.push(b), true), maskKey: () => KEY });
  const server = new Session({ role: 'server', write: (b) => (toClient.push(b), true) });
  client.sendText('ping?');
  client.sendBinary(Buffer.from([1, 2, 3]));
  const got: SessionEvent[] = server.receive(Buffer.concat(toServer));
  assert.deepEqual(got, [{ type: 'text', text: 'ping?' }, { type: 'binary', data: Buffer.from([1, 2, 3]) }]);
  server.close(1000, 'ok');
  const back = client.receive(Buffer.concat(toClient));
  assert.deepEqual(back, [{ type: 'close', code: 1000, reason: 'ok', clean: true, byUs: false }]);
  assert.deepEqual(server.receive(Buffer.concat(toServer.slice(2))), [{ type: 'close', code: 1000, reason: '', clean: true, byUs: true }]);
});
