import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { BadSdp, BadToken, ERR, ForbiddenMunge, Signaling, attrOf, checkTurnCredential, formatCandidate, hasFingerprint, isPrivateAddress, munge, parseCandidate, parseSdp, rtpmaps, signJwt, turnCredentials, verifyJwt, writeSdp } from './index.ts';

// RFC 8866 section 5 example.
const RFC8866 = [
  'v=0',
  'o=jdoe 2890844526 2890842807 IN IP4 10.47.16.5',
  's=SDP Seminar',
  'i=A Seminar on the session description protocol',
  'u=http://www.example.com/seminars/sdp.pdf',
  'e=j.doe@example.com (Jane Doe)',
  'c=IN IP4 224.2.17.12/127',
  't=2873397496 2873404696',
  'a=recvonly',
  'm=audio 49170 RTP/AVP 0',
  'm=video 51372 RTP/AVP 99',
  'c=IN IP4 203.0.113.1',
  'a=rtpmap:99 h263-1998/90000',
  '',
].join('\r\n');

const offer = (o: { ufrag?: string; extra?: string[]; fingerprint?: boolean } = {}) => [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  ...(o.fingerprint === false ? [] : ['a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89']),
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=ice-ufrag:' + (o.ufrag ?? 'f5Ra'),
  'a=ice-pwd:asd88fgpdd777uzjYhagZg',
  'a=setup:actpass',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=candidate:1 1 udp 2113937151 192.168.1.20 54400 typ host',
  'a=candidate:2 1 udp 1677729535 203.0.113.9 54400 typ srflx raddr 192.168.1.20 rport 54400',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=ice-ufrag:' + (o.ufrag ?? 'f5Ra'),
  'a=ice-pwd:asd88fgpdd777uzjYhagZg',
  'a=setup:actpass',
  'a=rtcp-mux',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 H264/90000',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  ...(o.extra ?? []),
  '',
].join('\r\n');

test('the RFC 8866 example parses into the right fields and writes back exactly', () => {
  const s = parseSdp(RFC8866);
  assert.deepEqual(s.origin, { username: 'jdoe', sessId: '2890844526', sessVersion: '2890842807', netType: 'IN', addrType: 'IP4', address: '10.47.16.5' });
  assert.equal(s.name, 'SDP Seminar');
  assert.equal(s.uri, 'http://www.example.com/seminars/sdp.pdf');
  assert.deepEqual(s.emails, ['j.doe@example.com (Jane Doe)']);
  assert.deepEqual(s.connection, { netType: 'IN', addrType: 'IP4', address: '224.2.17.12/127' });
  assert.deepEqual(s.timings, [{ start: '2873397496', stop: '2873404696', repeats: [] }]);
  assert.deepEqual(s.attributes, [{ name: 'recvonly' }]);
  assert.deepEqual(s.media.map((m) => [m.type, m.port, m.proto, m.formats]), [['audio', 49170, 'RTP/AVP', ['0']], ['video', 51372, 'RTP/AVP', ['99']]]);
  assert.equal(s.media[1]!.connection!.address, '203.0.113.1');
  assert.deepEqual(rtpmaps(s.media[1]!), [{ payload: '99', codec: 'h263-1998', clockRate: 90000 }]);
  assert.equal(writeSdp(s), RFC8866);
});

test('a browser-style offer round-trips byte for byte and exposes its attributes', () => {
  const text = offer();
  const s = parseSdp(text);
  assert.equal(writeSdp(s), text);
  assert.equal(attrOf(s.media[0]!, 'mid'), '0');
  assert.deepEqual(rtpmaps(s.media[0]!).map((r) => [r.codec, r.channels]), [['opus', 2], ['red', 2]]);
  assert.equal(hasFingerprint(s), true);
  assert.equal(hasFingerprint(parseSdp(offer({ fingerprint: false }))), false);
});

test('LF-only line endings are accepted and written back as CRLF', () => {
  assert.equal(writeSdp(parseSdp(RFC8866.replace(/\r\n/g, '\n'))), RFC8866);
});

test('malformed descriptions are refused with a reason, never guessed at', () => {
  const bad = (text: string, re: RegExp) => assert.throws(() => parseSdp(text), (e: unknown) => e instanceof BadSdp && re.test((e as Error).message), text.slice(0, 30));
  bad('', /empty/);
  bad('s=x\r\n', /first line must be v=0/);
  bad('v=0\r\ns=x\r\n', /second line must be o=/);
  bad('v=1\r\n', /only v=0/);
  bad('v=0\r\no=a b c\r\n', /bad o=/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\nt=0 0\r\n', /no s= line/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\ns=-\r\n', /no t= line/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\ns=-\r\nt=0 0\r\nm=audio 70000 RTP/AVP 0\r\n', /out of range/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\ns=-\r\nt=0 0\r\nm=audio x RTP/AVP 0\r\n', /bad m=/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\ns=-\r\nt=0 0\r\nq=what\r\n', /unknown line type q=/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\ns=-\r\nt=0 0\r\nc=IN IP4\r\n', /bad c=/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\ns=-\r\nt=0 0\r\nb=AS:fast\r\n', /bad b=/);
  bad('v=0\r\no=- 1 1 IN IP4 x\r\ns=-\r\nt=0 0\r\njunk\r\n', /not "<letter>=<value>"/);
  bad('v=0\u0000\r\n', /NUL/);
  bad(`${RFC8866}${'a=x\r\n'.repeat(3000)}`, /too many lines|longer than/);
  bad(`v=0\r\n${'a'.repeat(70_000)}`, /longer than 65536/);
});

test('candidates parse into fields, including the published RFC 8839 shapes, and format back', () => {
  const host = parseCandidate('a=candidate:1 1 UDP 2130706431 10.0.1.1 8998 typ host');
  assert.deepEqual([host.foundation, host.component, host.transport, host.priority, host.address, host.port, host.type], ['1', 1, 'udp', 2130706431, '10.0.1.1', 8998, 'host']);
  const srflx = parseCandidate('candidate:2 1 UDP 1694498815 192.0.2.3 45664 typ srflx raddr 10.0.1.1 rport 8998\r\n');
  assert.deepEqual([srflx.type, srflx.relatedAddress, srflx.relatedPort], ['srflx', '10.0.1.1', 8998]);
  assert.equal(formatCandidate(srflx), 'candidate:2 1 udp 1694498815 192.0.2.3 45664 typ srflx raddr 10.0.1.1 rport 8998');
  const tcp = parseCandidate('candidate:3 1 tcp 1518280447 192.0.2.4 9 typ host tcptype active generation 0 ufrag f5Ra network-cost 10');
  assert.equal(tcp.tcpType, 'active');
  assert.deepEqual(tcp.extensions, { generation: '0', ufrag: 'f5Ra', 'network-cost': '10' });
  assert.equal(formatCandidate(tcp), 'candidate:3 1 tcp 1518280447 192.0.2.4 9 typ host tcptype active generation 0 ufrag f5Ra network-cost 10');
  assert.equal(parseCandidate('candidate:4 1 udp 2113937151 3f2a5c1e-1111-4222-8333-444455556666.local 5000 typ host').address, '3f2a5c1e-1111-4222-8333-444455556666.local');
  assert.equal(parseCandidate('candidate:5 1 udp 100 2001:db8::1 5000 typ host').address, '2001:db8::1');
});

test('hostile or broken candidates are refused', () => {
  const bad = (l: string, re: RegExp) => assert.throws(() => parseCandidate(l), re, l);
  bad('candidate:1 1 udp 1 999.1.1.1 5 typ host', /bad address/);
  bad('candidate:1 1 udp 1 1.1.1.1 70000 typ host', /bad port/);
  bad('candidate:1 1 sctp 1 1.1.1.1 5 typ host', /unsupported transport/);
  bad('candidate:1 1 udp 1 1.1.1.1 5 typ weird', /bad candidate type/);
  bad('candidate:1 1 udp 1 1.1.1.1 5 typ srflx', /needs raddr/);
  bad('candidate:1 1 udp 1 1.1.1.1 5 typ host generation', /has no value/);
  bad('candidate:1 1 udp 99999999999 1.1.1.1 5 typ host', /bad priority/);
  bad('candidate:1 0 udp 1 1.1.1.1 5 typ host', /bad component/);
  bad('candidate:$$ 1 udp 1 1.1.1.1 5 typ host', /bad foundation/);
  bad('candidate:1 1 udp 1 1.1.1.1;rm 5 typ host', /bad address/);
  bad('not a candidate', /not a candidate/);
  bad(`candidate:${'1'.repeat(2000)}`, /too long/);
});

test('private addresses are recognised', () => {
  for (const a of ['10.1.2.3', '192.168.0.9', '172.16.0.1', '172.31.255.1', '127.0.0.1', '169.254.1.1', 'fe80::1', 'fd12::1', 'abc.local']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['203.0.113.9', '172.32.0.1', '8.8.8.8', '2001:db8::1']) assert.equal(isPrivateAddress(a), false, a);
});

test('munging prefers a codec with its retransmission payload, and leaves everything else in order', () => {
  const out = parseSdp(munge(offer(), [{ kind: 'prefer-codec', media: 'video', codec: 'h264' }]));
  assert.deepEqual(out.media[1]!.formats, ['98', '99', '96', '97']);
  assert.deepEqual(out.media[0]!.formats, ['111', '63']);
  assert.equal(munge(offer(), [{ kind: 'prefer-codec', media: 'video', codec: 'AV1' }]), offer(), 'a codec that is not offered changes nothing');
});

test('munging removes a codec with its rtpmap, fmtp and feedback lines, but never the last codec', () => {
  const out = parseSdp(munge(offer(), [{ kind: 'remove-codec', media: 'video', codec: 'VP8' }]));
  assert.deepEqual(out.media[1]!.formats, ['98', '99']);
  const lines = writeSdp(out);
  assert.doesNotMatch(lines, /rtpmap:96|rtpmap:97|fmtp:97|rtcp-fb:96/);
  assert.match(lines, /rtpmap:98 H264\/90000/);
  assert.throws(() => munge(munge(offer(), [{ kind: 'remove-codec', media: 'video', codec: 'VP8' }]), [{ kind: 'remove-codec', media: 'video', codec: 'H264' }]), ForbiddenMunge);
});

test('munging caps bitrate once, hides private host candidates, and drops harmless attributes', () => {
  let s = parseSdp(munge(offer(), [{ kind: 'max-bitrate', media: 'video', kbps: 800 }, { kind: 'max-bitrate', media: 'video', kbps: 500 }]));
  assert.deepEqual(s.media[1]!.bandwidth, [{ type: 'AS', kbps: 500 }]);
  assert.deepEqual(s.media[0]!.bandwidth, []);
  s = parseSdp(munge(offer(), [{ kind: 'hide-host-candidates' }]));
  assert.deepEqual(s.media[0]!.attributes.filter((a) => a.name === 'candidate').map((a) => a.value), ['2 1 udp 1677729535 203.0.113.9 54400 typ srflx raddr 192.168.1.20 rport 54400']);
  s = parseSdp(munge(offer({ extra: ['a=extmap-allow-mixed'] }), [{ kind: 'drop-attribute', name: 'extmap-allow-mixed' }]));
  assert.equal(s.media[1]!.attributes.some((a) => a.name === 'extmap-allow-mixed'), false);
});

test('munging refuses to touch what DTLS and ICE depend on, and out-of-range bitrates', () => {
  for (const name of ['fingerprint', 'ice-ufrag', 'ice-pwd', 'setup', 'mid', 'group', 'rtcp-mux']) assert.throws(() => munge(offer(), [{ kind: 'drop-attribute', name }]), ForbiddenMunge, name);
  assert.throws(() => munge(offer(), [{ kind: 'max-bitrate', media: 'video', kbps: 3 }]), /8 to 100000/);
  assert.throws(() => munge(offer(), [{ kind: 'max-bitrate', media: 'video', kbps: 1.5 }]), ForbiddenMunge);
});

test('TURN REST credentials follow the username "expiry:name" and base64 HMAC-SHA1 convention', () => {
  const c = turnCredentials('supersecret-0123', 'ana', { ttlSeconds: 3600, now: 1_800_000_000_000, urls: ['turn:turn.example.com:3478'] });
  assert.equal(c.username, '1800003600:ana');
  assert.equal(c.credential, createHmac('sha1', 'supersecret-0123').update('1800003600:ana').digest('base64'), 'matches an independently computed HMAC-SHA1');
  assert.equal(c.expiresAt, 1_800_003_600);
  assert.equal(checkTurnCredential(['other-secret-0000', 'supersecret-0123'], c.username, c.credential, 1_800_000_000_000), true);
});

test('TURN credentials are refused when expired, forged, or for a different name', () => {
  const secret = 'supersecret-0123';
  const c = turnCredentials(secret, 'ana', { ttlSeconds: 60, now: 1_800_000_000_000, urls: [] });
  assert.equal(checkTurnCredential([secret], c.username, c.credential, 1_800_000_060_000), false, 'at the expiry second it is over');
  assert.equal(checkTurnCredential([secret], c.username, c.credential, 1_800_000_059_000), true);
  assert.equal(checkTurnCredential([secret], `${c.expiresAt}:ben`, c.credential, 1_800_000_000_000), false);
  assert.equal(checkTurnCredential([secret], `${c.expiresAt + 9999}:ana`, c.credential, 1_800_000_000_000), false, 'extending the expiry breaks the signature');
  assert.equal(checkTurnCredential(['wrong-secret-0000000'], c.username, c.credential, 1_800_000_000_000), false);
  assert.equal(checkTurnCredential([secret], 'no-colon', c.credential, 0), false);
  assert.throws(() => turnCredentials('short', 'a', { ttlSeconds: 1, now: 0, urls: [] }), /16 characters/);
  assert.throws(() => turnCredentials(secret, 'a b', { ttlSeconds: 1, now: 0, urls: [] }), /letters, digits/);
  assert.throws(() => turnCredentials(secret, 'a', { ttlSeconds: 90_000, now: 0, urls: [] }), /1 to 86400/);
});

test('RFC 7515 appendix A.1 HS256 token verifies, and any change breaks it', () => {
  const key = Buffer.from('AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow', 'base64url');
  // RFC 7515 A.1: header and payload are built from the RFC's JSON texts and signed with the RFC key; the computed signature must equal the published segment.
  const b64j = (s: string) => Buffer.from(s).toString('base64url');
  const input = `${b64j('{"typ":"JWT",\r\n "alg":"HS256"}')}.${b64j('{"iss":"joe",\r\n "exp":1300819380,\r\n "http://example.com/is_root":true}')}`;
  const signature = createHmac('sha256', key).update(input).digest('base64url');
  assert.equal(signature, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  const token = `${input}.${signature}`;
  const c = verifyJwt(key, token, { now: 1_300_819_000_000 });
  assert.equal(c.iss, 'joe');
  assert.equal(c['http://example.com/is_root'], true);
  assert.throws(() => verifyJwt(key, token, { now: 1_300_819_500_000 }), /expired/);
  assert.throws(() => verifyJwt(key, token.replace('.eyJp', '.eyJq'), { now: 1_300_819_000_000 }), /signature/);
  assert.throws(() => verifyJwt(Buffer.from('another key entirely'), token, { now: 1_300_819_000_000 }), /signature/);
  assert.equal(signJwt(key, { iss: 'joe' }).split('.').length, 3);
});

test('tokens with the none algorithm, other algorithms, no expiry, wrong audience or the future are refused', () => {
  const h = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const p = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = 1_800_000_000_000;
  assert.throws(() => verifyJwt('k'.repeat(32), `${h({ alg: 'none' })}.${p({ exp: 9e9 })}.`, { now }), /not accepted; only HS256/);
  assert.throws(() => verifyJwt('k'.repeat(32), `${h({ alg: 'RS256' })}.${p({ exp: 9e9 })}.AAAA`, { now }), /RS256/);
  assert.throws(() => verifyJwt('k', 'a.b', { now }), /malformed/);
  assert.throws(() => verifyJwt('k', `${Buffer.from('x').toString('base64url')}.e30.AA`, { now }), /header is not JSON/);
  const k = 'k'.repeat(32);
  assert.throws(() => verifyJwt(k, signJwt(k, { sub: 'a' }), { now }), /no expiry/);
  assert.throws(() => verifyJwt(k, signJwt(k, { exp: 1_800_000_100, aud: 'x' }), { now, audience: 'y' }), /audience/);
  assert.throws(() => verifyJwt(k, signJwt(k, { exp: 1_800_000_100, nbf: 1_800_001_000 }), { now }), /not valid yet/);
  assert.throws(() => verifyJwt(k, signJwt(k, { exp: 1_800_000_100, iss: 'a' }), { now, issuer: 'b' }), /issuer/);
  assert.deepEqual(verifyJwt([Buffer.from('old'), k], signJwt(k, { exp: 1_800_000_100, aud: ['y', 'z'] }), { now, audience: 'z' }).aud, ['y', 'z']);
  assert.ok(new BadToken('x') instanceof Error);
});

// --- signalling -------------------------------------------------------------------------------------------------

const SECRET = 'room-secret-0123';
const NOW = 1_800_000_000_000;

const rig = (o: Partial<ConstructorParameters<typeof Signaling>[0]> = {}) => {
  let now = NOW;
  const sig = new Signaling({ secrets: [SECRET], now: () => now, turn: { secret: 'turn-secret-0123', urls: ['turn:t.example.com'] }, ...o });
  const peer = (name: string, room = 'r1') => {
    const log: Record<string, any>[] = [];
    const socket = { send: (t: string) => void log.push(JSON.parse(t)) };
    const send = (method: string, params: object, id = log.length + 100) => { sig.message(socket, JSON.stringify({ jsonrpc: '2.0', id, method, params })); return log.at(-1)!; };
    const token = signJwt(SECRET, { room, sub: name, exp: Math.floor(NOW / 1000) + 600, name: name.toUpperCase() });
    const raw = (text: string) => { sig.message(socket, text); return log.at(-1)!; };
    return { name, log, socket, send, raw, join: () => send('join', { token }), token, notes: (m: string) => log.filter((x) => x.method === m) };
  };
  return { sig, peer, tick: (ms: number) => void (now += ms) };
};

test('joining needs a valid token, tells the newcomer who is there and the others who arrived, and hands out TURN credentials', () => {
  const { sig, peer } = rig();
  const a = peer('ana'), b = peer('ben');
  const ja = a.join();
  assert.deepEqual(ja.result.peers, []);
  assert.equal(ja.result.iceServers[0].username, `${Math.floor(NOW / 1000) + 3600}:ana`);
  assert.equal(checkTurnCredential(['turn-secret-0123'], ja.result.iceServers[0].username, ja.result.iceServers[0].credential, NOW), true);
  const jb = b.join();
  assert.deepEqual(jb.result.peers, [{ id: 'ana', name: 'ANA' }]);
  assert.deepEqual(a.notes('peer-joined')[0]!.params, { id: 'ben', name: 'BEN' });
  assert.deepEqual(sig.members('r1'), ['ana', 'ben']);
  sig.disconnected(b.socket);
  assert.deepEqual(a.notes('peer-left')[0]!.params, { id: 'ben' });
  assert.deepEqual(sig.members('r1'), ['ana']);
});

test('bad tokens, wrong secrets, a second join and a full room are refused with codes', () => {
  const { peer, sig } = rig({ maxPeersPerRoom: 1 });
  const x = peer('x');
  assert.equal(x.send('join', { token: 'junk' }).error.code, ERR.auth);
  assert.equal(x.send('join', { token: signJwt('wrong-wrong-wrong-wrong', { room: 'r1', sub: 'x', exp: 9e9 }) }).error.code, ERR.auth);
  assert.match(x.send('join', { token: signJwt(SECRET, { room: 'r1', exp: 9e9 }) }).error.message, /room and a subject/);
  assert.match(x.send('join', { token: signJwt(SECRET, { room: '../x', sub: 'x', exp: 9e9 }) }).error.message, /room and a subject/);
  assert.equal(x.send('signal', { to: 'y', kind: 'offer', sdp: offer() }).error.message, 'join a room first');
  assert.equal(x.join().result.self, 'x');
  assert.equal(x.join().error.code, ERR.order, 'a second join');
  assert.equal(peer('y').join().error.code, ERR.full);
  void sig;
  const expired = peer('late');
  assert.match(expired.send('join', { token: signJwt(SECRET, { room: 'r1', sub: 'late', exp: Math.floor(NOW / 1000) - 600 }) }).error.message, /expired/);
});

test('the same person cannot join a room twice, but may leave and return', () => {
  const { peer } = rig();
  const a1 = peer('ana'), a2 = peer('ana');
  a1.join();
  assert.match(a2.join().error.message, /already in r1/);
  a1.send('leave', {});
  assert.equal(a2.join().result.self, 'ana');
});

test('offers and answers are relayed with the sender set by the server, and rooms are separate', () => {
  const { peer } = rig();
  const a = peer('ana'), b = peer('ben'), c = peer('cy', 'other');
  a.join(); b.join(); c.join();
  assert.deepEqual(a.send('signal', { to: 'ben', kind: 'offer', sdp: offer(), from: 'mallory' }).result, {});
  const got = b.notes('signal')[0]!;
  assert.equal(got.params.from, 'ana', 'a claimed sender is ignored');
  assert.equal(got.params.kind, 'offer');
  assert.equal(attrOf(parseSdp(got.params.sdp).media[1]!, 'mid'), '1');
  assert.deepEqual(b.send('signal', { to: 'ana', kind: 'answer', sdp: offer({ ufrag: 'zz99' }) }).result, {});
  assert.equal(a.notes('signal')[0]!.params.kind, 'answer');
  assert.equal(a.send('signal', { to: 'cy', kind: 'offer', sdp: offer() }).error.code, ERR.notFound, 'another room is not reachable');
  assert.equal(c.notes('signal').length, 0);
  assert.equal(a.send('signal', { to: 'ana', kind: 'offer', sdp: offer() }).error.code, ERR.notFound, 'not to yourself');
});

test('the order of messages is enforced: no answer without an offer, no second offer, no early candidates', () => {
  const { peer } = rig();
  const a = peer('ana'), b = peer('ben');
  a.join(); b.join();
  const cand = { to: 'ben', kind: 'candidate', candidate: 'candidate:2 1 udp 1677729535 203.0.113.9 54400 typ srflx raddr 0.0.0.0 rport 0' };
  assert.equal(a.send('signal', cand).error.code, ERR.order);
  assert.equal(a.send('signal', { to: 'ben', kind: 'answer', sdp: offer() }).error.code, ERR.order);
  a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() });
  assert.match(a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() }).error.message, /not been answered/);
  assert.equal(a.send('signal', { to: 'ben', kind: 'answer', sdp: offer() }).error.code, ERR.order, 'you cannot answer yourself');
  assert.deepEqual(a.send('signal', cand).result, {}, 'candidates may trickle once an offer exists');
  b.send('signal', { to: 'ana', kind: 'answer', sdp: offer() });
  assert.deepEqual(b.send('signal', { to: 'ana', kind: 'candidate', candidate: cand.candidate }).result, {}, 'and after the answer');
  assert.match(b.send('signal', { to: 'ana', kind: 'answer', sdp: offer() }).error.message, /no offer from ana/);
  assert.deepEqual(a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() }).result, {}, 'a fresh offer after the answer renegotiates');
});

test('glare: when both offer, the earlier joiner stands and the later one is told to answer or roll back', () => {
  const { peer, tick } = rig();
  const a = peer('ana'), b = peer('ben');
  a.join(); tick(1000); b.join();
  b.send('signal', { to: 'ana', kind: 'offer', sdp: offer() });
  const r = a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() });
  assert.deepEqual(r.result, {}, 'ana joined first, so her offer stands');
  assert.deepEqual(b.notes('signal').map((x) => x.params.kind), ['rollback-request', 'offer'], 'ben is told to roll back, then receives the winning offer');
  const { peer: peer2, tick: tick2 } = rig();
  const c = peer2('cy'), d = peer2('di');
  c.join(); tick2(1000); d.join();
  c.send('signal', { to: 'di', kind: 'offer', sdp: offer() });
  const g = d.send('signal', { to: 'cy', kind: 'offer', sdp: offer() });
  assert.equal(g.error.code, ERR.glare);
  assert.equal(d.send('signal', { to: 'cy', kind: 'rollback' }).error.code, ERR.order, 'di has nothing to roll back');
  assert.deepEqual(c.send('signal', { to: 'di', kind: 'rollback' }).result, {});
  assert.deepEqual(d.send('signal', { to: 'cy', kind: 'offer', sdp: offer() }).result, {}, 'after the rollback di may offer');
});

test('offers without a DTLS fingerprint, with broken SDP, or too large are refused', () => {
  const { peer } = rig();
  const a = peer('ana'), b = peer('ben');
  a.join(); b.join();
  assert.match(a.send('signal', { to: 'ben', kind: 'offer', sdp: offer({ fingerprint: false }) }).error.message, /no DTLS fingerprint/);
  assert.equal(a.send('signal', { to: 'ben', kind: 'offer', sdp: 'v=0\r\nnonsense' }).error.code, ERR.sdp);
  assert.equal(a.send('signal', { to: 'ben', kind: 'offer' }).error.code, ERR.params);
  a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() });
  assert.equal(b.notes('signal').length, 1, 'nothing refused was relayed');
  const big = JSON.stringify({ method: 'signal', params: { to: 'ben', kind: 'offer', sdp: 'x'.repeat(200_000) } });
  assert.match(a.raw(big).error.message, /at most 131072 bytes/);
});

test('private host addresses are removed from relayed descriptions and dropped as candidates', () => {
  const { peer } = rig();
  const a = peer('ana'), b = peer('ben');
  a.join(); b.join();
  a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() });
  const relayed = b.notes('signal')[0]!.params.sdp as string;
  assert.doesNotMatch(relayed, /192\.168\.1\.20 54400 typ host/);
  assert.match(relayed, /203\.0\.113\.9 54400 typ srflx/);
  const host = a.send('signal', { to: 'ben', kind: 'candidate', candidate: 'candidate:1 1 udp 2113937151 10.0.0.5 5000 typ host' });
  assert.deepEqual(host.result, { dropped: 'private host address' });
  assert.equal(b.notes('signal').length, 1);
  const pub = a.send('signal', { to: 'ben', kind: 'candidate', candidate: 'candidate:9 1 udp 2113937151 198.51.100.7 5000 typ host' });
  assert.deepEqual(pub.result, {});
  assert.equal(a.send('signal', { to: 'ben', kind: 'candidate', candidate: 'candidate:9 1 udp 1 999.0.0.1 5 typ host' }).error.code, ERR.sdp);
});

test('candidates are capped per pair, messages are rate limited, and junk gets an error not a crash', () => {
  const { peer, tick } = rig({ maxCandidates: 2, rateLimit: 8 });
  const a = peer('ana'), b = peer('ben');
  a.join(); b.join();
  a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() });
  const c = (n: number) => ({ to: 'ben', kind: 'candidate', candidate: `candidate:${n} 1 udp 100 198.51.100.${n} 5000 typ host` });
  assert.deepEqual(a.send('signal', c(1)).result, {});
  assert.deepEqual(a.send('signal', c(2)).result, {});
  assert.equal(a.send('signal', c(3)).error.code, ERR.rate);
  assert.deepEqual(a.send('signal', { to: 'ben', kind: 'end-of-candidates' }).result, {});
  assert.equal(a.send('signal', { to: 'ben', kind: 'banana' }).error.code, ERR.params);
  assert.equal(a.send('signal', {}).error.code, ERR.params);
  assert.equal(a.send('nonsense', {}).error.code, ERR.method, 'the eighth message is still within the limit');
  assert.equal(a.send('nonsense', {}).error.code, ERR.rate, 'the ninth is not');
  tick(11_000);
  assert.equal(a.send('nonsense', {}).error.code, ERR.method, 'the window has passed');
  assert.equal(a.raw('not json').error.code, ERR.malformed);
  assert.equal(a.raw('[1,2]').error.code, ERR.malformed);
  assert.equal(a.raw('{"id":1}').error.code, ERR.malformed);
});

test('closing a socket tells the room and forgets its negotiations', () => {
  const { peer, sig } = rig();
  const a = peer('ana'), b = peer('ben');
  a.join(); b.join();
  a.send('signal', { to: 'ben', kind: 'offer', sdp: offer() });
  sig.disconnected(a.socket);
  assert.equal(b.notes('peer-left').length, 1);
  const a2 = peer('ana');
  a2.join();
  assert.equal(a2.send('signal', { to: 'ben', kind: 'candidate', candidate: 'candidate:1 1 udp 1 198.51.100.1 5 typ host' }).error.code, ERR.order, 'the old negotiation is gone');
  sig.disconnected(a2.socket); sig.disconnected(b.socket);
  assert.deepEqual(sig.members('r1'), []);
});
