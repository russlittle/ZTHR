/**
 * What two browsers need to say to each other before a call can start, and nothing about the media itself.
 * Four parts that work together:
 *
 * 1. SDP (RFC 8866) parse and write, exact on a round trip, with ICE candidate lines (RFC 8839) parsed into fields.
 *    Oversized or malformed text is refused, never guessed at.
 * 2. SDP munging as named rules (prefer or remove a codec, cap bitrate, drop an attribute, hide host addresses)
 *    that refuse to touch what DTLS and ICE depend on (fingerprint, ice-ufrag, ice-pwd, setup, mid) or to leave a
 *    media section with no codec.
 * 3. Ephemeral TURN credentials by the TURN REST API convention (username "expiry:name", password the base64 HMAC-
 *    SHA1 of the username under a shared secret), with a checker, so a relay can be offered without a stored
 *    password per person.
 * 4. The room join protocol on a socket you pass in: a JWT (HS256 only, RFC 7519/7515; "none" and other algorithms
 *    are refused) names the room and the person, the server tells each person who is there, relays offer, answer
 *    and candidate messages with the sender's identity set by the server, and enforces order: an answer only to an
 *    offer, candidates only after an offer, one offer in flight per pair with the glare rule saying who yields.
 *    Offers must carry a DTLS fingerprint.
 *
 * Out of scope: the media path, the WebSocket framing itself (a socket is anything with `send(text)`), and
 * simulcast or SVC attribute rewriting.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

// --- SDP -------------------------------------------------------------------------------------------------------

export class BadSdp extends Error {}

export interface Attribute { readonly name: string; readonly value?: string }
export interface Connection { readonly netType: string; readonly addrType: string; readonly address: string }
export interface Bandwidth { readonly type: string; readonly kbps: number }
export interface Origin { readonly username: string; readonly sessId: string; readonly sessVersion: string; readonly netType: string; readonly addrType: string; readonly address: string }

export interface MediaSection {
  type: string;
  port: number;
  portCount?: number;
  proto: string;
  formats: string[];
  info?: string;
  connection?: Connection;
  bandwidth: Bandwidth[];
  attributes: Attribute[];
}

export interface Session {
  version: 0;
  origin: Origin;
  name: string;
  info?: string;
  uri?: string;
  emails: string[];
  phones: string[];
  connection?: Connection;
  bandwidth: Bandwidth[];
  timings: { start: string; stop: string; repeats: string[] }[];
  zones?: string;
  attributes: Attribute[];
  media: MediaSection[];
}

const MAX_SDP = 65_536;
const MAX_LINES = 2000;

const conn = (v: string): Connection => {
  const p = v.split(' ');
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) throw new BadSdp(`bad c= line: ${v}`);
  return { netType: p[0], addrType: p[1], address: p[2] };
};
const bw = (v: string): Bandwidth => {
  const m = /^([A-Za-z-]+):(\d+)$/.exec(v);
  if (!m) throw new BadSdp(`bad b= line: ${v}`);
  return { type: m[1]!, kbps: Number(m[2]) };
};
const attr = (v: string): Attribute => {
  const i = v.indexOf(':');
  return i < 0 ? { name: v } : { name: v.slice(0, i), value: v.slice(i + 1) };
};

export function parseSdp(text: string): Session {
  if (typeof text !== 'string' || text.length === 0) throw new BadSdp('the description is empty');
  if (text.length > MAX_SDP) throw new BadSdp(`the description is longer than ${MAX_SDP} characters`);
  if (/[\u0000]/.test(text)) throw new BadSdp('the description has a NUL character');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_LINES) throw new BadSdp('the description has too many lines');
  const s: Session = { version: 0, origin: undefined as unknown as Origin, name: '', emails: [], phones: [], bandwidth: [], timings: [], attributes: [], media: [] };
  let cur: MediaSection | undefined;
  let sawS = false;
  lines.forEach((line, n) => {
    const m = /^([a-z])=(.*)$/.exec(line);
    if (!m) throw new BadSdp(`line ${n + 1} is not "<letter>=<value>": ${line.slice(0, 40)}`);
    const [t, v] = [m[1]!, m[2]!];
    if (n === 0 && t !== 'v') throw new BadSdp('the first line must be v=0');
    if (n === 1 && t !== 'o') throw new BadSdp('the second line must be o=');
    switch (t) {
      case 'v': if (n !== 0 || v !== '0') throw new BadSdp('only v=0 is supported'); break;
      case 'o': {
        const p = v.split(' ');
        if (p.length !== 6 || !/^\d+$/.test(p[1]!) || !/^\d+$/.test(p[2]!)) throw new BadSdp(`bad o= line: ${v}`);
        s.origin = { username: p[0]!, sessId: p[1]!, sessVersion: p[2]!, netType: p[3]!, addrType: p[4]!, address: p[5]! };
        break;
      }
      case 's': s.name = v; sawS = true; break;
      case 'i': if (cur) cur.info = v; else s.info = v; break;
      case 'u': s.uri = v; break;
      case 'e': s.emails.push(v); break;
      case 'p': s.phones.push(v); break;
      case 'c': if (cur) cur.connection = conn(v); else s.connection = conn(v); break;
      case 'b': (cur ?? s).bandwidth.push(bw(v)); break;
      case 't': {
        const p = v.split(' ');
        if (p.length !== 2 || !/^\d+$/.test(p[0]!) || !/^\d+$/.test(p[1]!)) throw new BadSdp(`bad t= line: ${v}`);
        s.timings.push({ start: p[0]!, stop: p[1]!, repeats: [] });
        break;
      }
      case 'r': if (!s.timings.length) throw new BadSdp('r= before t='); s.timings.at(-1)!.repeats.push(v); break;
      case 'z': s.zones = v; break;
      case 'a': (cur ?? s).attributes.push(attr(v)); break;
      case 'm': {
        const p = /^([a-z]+) (\d+)(?:\/(\d+))? (\S+)((?: \S+)+)$/.exec(v);
        if (!p) throw new BadSdp(`bad m= line: ${v}`);
        const port = Number(p[2]);
        if (port > 65535) throw new BadSdp(`port ${port} is out of range`);
        cur = { type: p[1]!, port, ...(p[3] ? { portCount: Number(p[3]) } : {}), proto: p[4]!, formats: p[5]!.trim().split(' '), bandwidth: [], attributes: [] };
        s.media.push(cur);
        break;
      }
      default: throw new BadSdp(`line ${n + 1}: unknown line type ${t}=`);
    }
  });
  if (!s.origin) throw new BadSdp('there is no o= line');
  if (!sawS) throw new BadSdp('there is no s= line');
  if (!s.timings.length) throw new BadSdp('there is no t= line');
  return s;
}

const a2 = (a: Attribute) => `a=${a.name}${a.value === undefined ? '' : `:${a.value}`}`;

export function writeSdp(s: Session): string {
  const L: string[] = ['v=0', `o=${s.origin.username} ${s.origin.sessId} ${s.origin.sessVersion} ${s.origin.netType} ${s.origin.addrType} ${s.origin.address}`, `s=${s.name}`];
  if (s.info !== undefined) L.push(`i=${s.info}`);
  if (s.uri !== undefined) L.push(`u=${s.uri}`);
  for (const e of s.emails) L.push(`e=${e}`);
  for (const p of s.phones) L.push(`p=${p}`);
  const c = (x: Connection) => `c=${x.netType} ${x.addrType} ${x.address}`;
  if (s.connection) L.push(c(s.connection));
  for (const b of s.bandwidth) L.push(`b=${b.type}:${b.kbps}`);
  for (const t of s.timings) { L.push(`t=${t.start} ${t.stop}`); for (const r of t.repeats) L.push(`r=${r}`); }
  if (s.zones !== undefined) L.push(`z=${s.zones}`);
  for (const a of s.attributes) L.push(a2(a));
  for (const m of s.media) {
    L.push(`m=${m.type} ${m.port}${m.portCount ? `/${m.portCount}` : ''} ${m.proto} ${m.formats.join(' ')}`);
    if (m.info !== undefined) L.push(`i=${m.info}`);
    if (m.connection) L.push(c(m.connection));
    for (const b of m.bandwidth) L.push(`b=${b.type}:${b.kbps}`);
    for (const a of m.attributes) L.push(a2(a));
  }
  return `${L.join('\r\n')}\r\n`;
}

export const attrOf = (x: { attributes: readonly Attribute[] }, name: string): string | undefined => x.attributes.find((a) => a.name === name)?.value;
/** Session-level or media-level value (media wins), for the attributes that may appear at either level. */
export const attrAt = (s: Session, m: MediaSection, name: string): string | undefined => attrOf(m, name) ?? attrOf(s, name);

export interface RtpMap { readonly payload: string; readonly codec: string; readonly clockRate: number; readonly channels?: number }
export function rtpmaps(m: MediaSection): RtpMap[] {
  return m.attributes.filter((a) => a.name === 'rtpmap').flatMap((a) => {
    const r = /^(\d+) ([^/\s]+)\/(\d+)(?:\/(\d+))?$/.exec(a.value ?? '');
    return r ? [{ payload: r[1]!, codec: r[2]!, clockRate: Number(r[3]), ...(r[4] ? { channels: Number(r[4]) } : {}) }] : [];
  });
}

export const hasFingerprint = (s: Session): boolean => attrOf(s, 'fingerprint') !== undefined || (s.media.length > 0 && s.media.every((m) => attrOf(m, 'fingerprint') !== undefined));

// --- ICE candidates ---------------------------------------------------------------------------------------------

export interface Candidate {
  readonly foundation: string;
  readonly component: number;
  readonly transport: 'udp' | 'tcp';
  readonly priority: number;
  readonly address: string;
  readonly port: number;
  readonly type: 'host' | 'srflx' | 'prflx' | 'relay';
  readonly relatedAddress?: string;
  readonly relatedPort?: number;
  readonly tcpType?: 'active' | 'passive' | 'so';
  readonly extensions: Readonly<Record<string, string>>;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validAddress = (a: string): boolean => {
  const m = IPV4.exec(a);
  if (m) return m.slice(1).every((x) => Number(x) <= 255);
  if (/^[0-9a-fA-F:.]+$/.test(a) && a.includes(':')) return a.length <= 45 && a.split('::').length <= 2;
  return /^[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.local$|^[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/.test(a);
};

/** Parse "candidate:…" (with or without a leading "a=" and trailing line break). */
export function parseCandidate(line: string): Candidate {
  const t = line.trim().replace(/^a=/, '');
  if (t.length > 1024) throw new BadSdp('candidate is too long');
  const p = t.replace(/^candidate:/, '').split(/\s+/);
  if (!t.startsWith('candidate:') || p.length < 8) throw new BadSdp(`not a candidate line: ${t.slice(0, 40)}`);
  const [foundation, comp, transport, prio, address, port, typ, type] = p as [string, string, string, string, string, string, string, string];
  if (!/^[A-Za-z0-9+/]{1,32}$/.test(foundation)) throw new BadSdp('bad foundation');
  if (!/^\d+$/.test(comp) || Number(comp) < 1 || Number(comp) > 256) throw new BadSdp('bad component');
  const tr = transport.toLowerCase();
  if (tr !== 'udp' && tr !== 'tcp') throw new BadSdp(`unsupported transport ${transport}`);
  if (!/^\d+$/.test(prio) || Number(prio) > 2 ** 31 - 1) throw new BadSdp('bad priority');
  if (!validAddress(address)) throw new BadSdp(`bad address ${address}`);
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new BadSdp('bad port');
  if (typ !== 'typ' || !['host', 'srflx', 'prflx', 'relay'].includes(type)) throw new BadSdp('bad candidate type');
  const ext: Record<string, string> = {};
  let raddr: string | undefined, rport: number | undefined, tcpType: Candidate['tcpType'];
  for (let i = 8; i < p.length; i += 2) {
    const k = p[i]!, v = p[i + 1];
    if (v === undefined) throw new BadSdp(`extension ${k} has no value`);
    if (k === 'raddr') { if (!validAddress(v)) throw new BadSdp('bad raddr'); raddr = v; }
    else if (k === 'rport') { if (!/^\d+$/.test(v) || Number(v) > 65535) throw new BadSdp('bad rport'); rport = Number(v); }
    else if (k === 'tcptype') { if (!['active', 'passive', 'so'].includes(v)) throw new BadSdp('bad tcptype'); tcpType = v as 'active'; }
    else if (/^[A-Za-z0-9-]+$/.test(k)) ext[k] = v;
    else throw new BadSdp(`bad extension name ${k}`);
  }
  if (type !== 'host' && raddr === undefined) throw new BadSdp(`a ${type} candidate needs raddr and rport`);
  return { foundation, component: Number(comp), transport: tr, priority: Number(prio), address, port: Number(port), type: type as Candidate['type'], ...(raddr !== undefined ? { relatedAddress: raddr } : {}), ...(rport !== undefined ? { relatedPort: rport } : {}), ...(tcpType ? { tcpType } : {}), extensions: ext };
}

export function formatCandidate(c: Candidate): string {
  const parts = [`candidate:${c.foundation}`, String(c.component), c.transport, String(c.priority), c.address, String(c.port), 'typ', c.type];
  if (c.relatedAddress !== undefined) parts.push('raddr', c.relatedAddress, 'rport', String(c.relatedPort ?? 0));
  if (c.tcpType) parts.push('tcptype', c.tcpType);
  for (const [k, v] of Object.entries(c.extensions)) parts.push(k, v);
  return parts.join(' ');
}

/** True for addresses on a private network, loopback or link-local: what a host candidate leaks. */
export function isPrivateAddress(a: string): boolean {
  const m = IPV4.exec(a);
  if (m) { const [x, y] = [Number(m[1]), Number(m[2])]; return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254); }
  return /^(fe80|fc|fd|::1)/i.test(a) || a.endsWith('.local');
}

// --- SDP munging ------------------------------------------------------------------------------------------------

export type MungeRule =
  | { readonly kind: 'prefer-codec'; readonly media: string; readonly codec: string }
  | { readonly kind: 'remove-codec'; readonly media: string; readonly codec: string }
  | { readonly kind: 'max-bitrate'; readonly media: string; readonly kbps: number }
  | { readonly kind: 'drop-attribute'; readonly name: string }
  | { readonly kind: 'hide-host-candidates' };

export class ForbiddenMunge extends Error {}

/** Attributes the connection's security and identity depend on; rules may not remove or change them. */
export const PROTECTED_ATTRIBUTES: readonly string[] = ['fingerprint', 'ice-ufrag', 'ice-pwd', 'setup', 'mid', 'rtcp-mux', 'group', 'ice-options'];

/** Apply rules to a description, returning new text. The input is not changed. */
export function munge(sdp: string, rules: readonly MungeRule[]): string {
  const s = parseSdp(sdp);
  for (const r of rules) {
    if (r.kind === 'drop-attribute') {
      if (PROTECTED_ATTRIBUTES.includes(r.name)) throw new ForbiddenMunge(`${r.name} is part of the connection's security and cannot be removed`);
      s.attributes = s.attributes.filter((a) => a.name !== r.name);
      for (const m of s.media) m.attributes = m.attributes.filter((a) => a.name !== r.name);
    } else if (r.kind === 'max-bitrate') {
      if (!Number.isInteger(r.kbps) || r.kbps < 8 || r.kbps > 100_000) throw new ForbiddenMunge('bitrate must be a whole number from 8 to 100000 kbps');
      for (const m of s.media.filter((x) => x.type === r.media)) m.bandwidth = [...m.bandwidth.filter((b) => b.type !== 'AS'), { type: 'AS', kbps: r.kbps }];
    } else if (r.kind === 'hide-host-candidates') {
      const keep = (a: Attribute) => { if (a.name !== 'candidate') return true; try { const c = parseCandidate(`candidate:${a.value}`); return !(c.type === 'host' && isPrivateAddress(c.address)); } catch { return false; } };
      for (const m of s.media) m.attributes = m.attributes.filter(keep);
    } else {
      for (const m of s.media.filter((x) => x.type === r.media)) {
        const maps = rtpmaps(m);
        const want = maps.filter((x) => x.codec.toLowerCase() === r.codec.toLowerCase()).map((x) => x.payload);
        // A payload type can also be named by an rtx/red fmtp "apt=" pointing at it; keep those with it.
        const tied = m.attributes.filter((a) => a.name === 'fmtp' && want.includes(/apt=(\d+)/.exec(a.value ?? '')?.[1] ?? '')).map((a) => a.value!.split(' ')[0]!);
        const group = new Set([...want, ...tied]);
        if (r.kind === 'prefer-codec') {
          if (want.length === 0) continue;
          m.formats = [...m.formats.filter((f) => group.has(f)), ...m.formats.filter((f) => !group.has(f))];
        } else {
          const left = m.formats.filter((f) => !group.has(f));
          if (group.size && left.length === 0) throw new ForbiddenMunge(`removing ${r.codec} would leave the ${m.type} section with no codec`);
          m.formats = left;
          m.attributes = m.attributes.filter((a) => !['rtpmap', 'fmtp', 'rtcp-fb'].includes(a.name) || !group.has((a.value ?? '').split(' ')[0]!));
        }
      }
    }
  }
  return writeSdp(s);
}

// --- TURN REST credentials -------------------------------------------------------------------------------------

export interface TurnCredentials { readonly username: string; readonly credential: string; readonly urls: readonly string[]; readonly expiresAt: number }

/** Username "<unix expiry>:<name>", credential base64(HMAC-SHA1(secret, username)). */
export function turnCredentials(secret: string, name: string, o: { ttlSeconds: number; now: number; urls: readonly string[] }): TurnCredentials {
  if (secret.length < 16) throw new Error('the TURN secret must be at least 16 characters');
  if (!/^[\w.@-]{1,128}$/.test(name)) throw new Error('the TURN name may hold letters, digits, . _ - @ only');
  if (!(o.ttlSeconds > 0) || o.ttlSeconds > 86_400) throw new Error('TURN credentials may last 1 to 86400 seconds');
  const expiresAt = Math.floor(o.now / 1000) + Math.floor(o.ttlSeconds);
  const username = `${expiresAt}:${name}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64'), urls: o.urls, expiresAt };
}

/** What a TURN server does: accept a username/credential pair only if unexpired and signed by a known secret. */
export function checkTurnCredential(secrets: readonly string[], username: string, credential: string, now: number): boolean {
  const m = /^(\d{1,12}):([\w.@-]{1,128})$/.exec(username);
  if (!m || Number(m[1]) * 1000 <= now) return false;
  return secrets.some((s) => {
    const want = createHmac('sha1', s).update(username).digest();
    const got = Buffer.from(credential, 'base64');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

// --- JWT (HS256 only) -------------------------------------------------------------------------------------------

export class BadToken extends Error {}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(secret: string | Buffer, claims: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
}

/** Verify HS256 only: other algorithms, including "none", are refused before any signature work. */
export function verifyJwt(secrets: string | Buffer | readonly (string | Buffer)[], token: string, o: { now: number; audience?: string; issuer?: string; skewSeconds?: number }): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 8192) throw new BadToken('the token is malformed');
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: unknown };
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: unknown }; } catch { throw new BadToken('the token header is not JSON'); }
  if (header.alg !== 'HS256') throw new BadToken(`the token algorithm ${String(header.alg)} is not accepted; only HS256 is`);
  const keys = Array.isArray(secrets) ? secrets : [secrets as string | Buffer];
  const got = Buffer.from(sig, 'base64url');
  const ok = keys.some((k) => { const w = createHmac('sha256', k).update(`${h}.${p}`).digest(); return got.length === w.length && timingSafeEqual(w, got); });
  if (!ok) throw new BadToken('the token signature does not match');
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw new BadToken('the token body is not JSON'); }
  if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new BadToken('the token body is not an object');
  const skew = o.skewSeconds ?? 30;
  const t = Math.floor(o.now / 1000);
  if (typeof c.exp !== 'number') throw new BadToken('the token has no expiry');
  if (t > c.exp + skew) throw new BadToken('the token has expired');
  if (typeof c.nbf === 'number' && t < c.nbf - skew) throw new BadToken('the token is not valid yet');
  if (o.audience !== undefined) { const aud = Array.isArray(c.aud) ? c.aud : [c.aud]; if (!aud.includes(o.audience)) throw new BadToken('the token is for a different audience'); }
  if (o.issuer !== undefined && c.iss !== o.issuer) throw new BadToken('the token is from a different issuer');
  return c;
}

// --- Signalling ------------------------------------------------------------------------------------------------

export interface Socket { send(text: string): void; close?(code: number, reason: string): void }

export interface SignalingOptions {
  readonly secrets: readonly string[];
  readonly audience?: string;
  readonly now: () => number;
  readonly turn?: { readonly secret: string; readonly urls: readonly string[]; readonly ttlSeconds?: number };
  readonly maxPeersPerRoom?: number;
  readonly maxMessageBytes?: number;
  /** Messages allowed per peer in any 10 seconds (default 200). */
  readonly rateLimit?: number;
  /** Candidates allowed per peer pair (default 120). */
  readonly maxCandidates?: number;
  /** Hide host candidates that carry private addresses (default true). */
  readonly hidePrivateHosts?: boolean;
}

interface Peer { readonly id: string; readonly name: string; readonly room: string; readonly socket: Socket; readonly joinedAt: number; readonly hits: number[] }
type PairState = { offerFrom: string | null; stable: boolean; candidates: number };

export const ERR = { malformed: -32700, method: -32601, params: -32602, auth: 4001, order: 4002, glare: 4003, notFound: 4004, full: 4005, rate: 4006, sdp: 4007 } as const;

const bad = (id: unknown, code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
const note = (method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', method, params });

export class Signaling {
  readonly #o: SignalingOptions;
  readonly #rooms = new Map<string, Map<string, Peer>>();
  readonly #bySocket = new Map<Socket, Peer>();
  readonly #pairs = new Map<string, PairState>();
  readonly #seenOffer = new Set<string>();

  constructor(o: SignalingOptions) {
    this.#o = o;
  }

  /** Who is in a room, oldest first. */
  members(room: string): string[] {
    return [...(this.#rooms.get(room)?.values() ?? [])].sort((a, b) => a.joinedAt - b.joinedAt).map((p) => p.id);
  }

  #pair(a: string, b: string): { key: string; state: PairState } {
    const key = [a, b].sort().join('\u0000');
    let state = this.#pairs.get(key);
    if (!state) { state = { offerFrom: null, stable: true, candidates: 0 }; this.#pairs.set(key, state); }
    return { key, state };
  }

  /** A socket closed. */
  disconnected(socket: Socket): void {
    const p = this.#bySocket.get(socket);
    if (p) this.#leave(p);
  }

  #leave(p: Peer): void {
    this.#bySocket.delete(p.socket);
    const room = this.#rooms.get(p.room);
    room?.delete(p.id);
    for (const k of [...this.#pairs.keys()]) if (k.split('\u0000').includes(p.id)) { this.#pairs.delete(k); this.#seenOffer.delete(k); }
    for (const o of room?.values() ?? []) o.socket.send(note('peer-left', { id: p.id }));
    if (room && room.size === 0) this.#rooms.delete(p.room);
  }

  /** One text message from a socket. Never throws; every failure is answered on the socket. */
  message(socket: Socket, text: string): void {
    const max = this.#o.maxMessageBytes ?? 131_072;
    if (Buffer.byteLength(text) > max) { socket.send(bad(null, ERR.malformed, `messages may be at most ${max} bytes`)); return; }
    let m: { id?: unknown; method?: unknown; params?: unknown };
    try { m = JSON.parse(text) as typeof m; } catch { socket.send(bad(null, ERR.malformed, 'the message is not JSON')); return; }
    if (m === null || typeof m !== 'object' || Array.isArray(m) || typeof m.method !== 'string') { socket.send(bad((m as { id?: unknown } | null)?.id, ERR.malformed, 'the message needs a method')); return; }
    const params = (m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? m.params : {}) as Record<string, unknown>;
    const peer = this.#bySocket.get(socket);
    if (peer) {
      const t = this.#o.now();
      peer.hits.push(t);
      while (peer.hits.length && peer.hits[0]! < t - 10_000) peer.hits.shift();
      if (peer.hits.length > (this.#o.rateLimit ?? 200)) { socket.send(bad(m.id, ERR.rate, 'slow down')); return; }
    }
    try {
      if (m.method === 'join') return this.#join(socket, m.id, params, peer);
      if (!peer) { socket.send(bad(m.id, ERR.auth, 'join a room first')); return; }
      if (m.method === 'signal') return this.#signal(peer, m.id, params);
      if (m.method === 'leave') { this.#leave(peer); socket.send(ok(m.id, {})); return; }
      socket.send(bad(m.id, ERR.method, `unknown method ${m.method}`));
    } catch (e) {
      socket.send(bad(m.id, ERR.params, (e as Error).message));
    }
  }

  #join(socket: Socket, id: unknown, params: Record<string, unknown>, existing: Peer | undefined): void {
    if (existing) { socket.send(bad(id, ERR.order, 'already joined')); return; }
    let claims: Record<string, unknown>;
    try { claims = verifyJwt(this.#o.secrets, String(params.token ?? ''), { now: this.#o.now(), ...(this.#o.audience ? { audience: this.#o.audience } : {}) }); } catch (e) { socket.send(bad(id, ERR.auth, (e as Error).message)); return; }
    const room = claims.room, sub = claims.sub;
    if (typeof room !== 'string' || !/^[\w.-]{1,128}$/.test(room) || typeof sub !== 'string' || !/^[\w.@-]{1,128}$/.test(sub)) { socket.send(bad(id, ERR.auth, 'the token needs a room and a subject')); return; }
    const members = this.#rooms.get(room) ?? new Map<string, Peer>();
    if (members.has(sub)) { socket.send(bad(id, ERR.order, `${sub} is already in ${room}`)); return; }
    if (members.size >= (this.#o.maxPeersPerRoom ?? 50)) { socket.send(bad(id, ERR.full, 'the room is full')); return; }
    const peer: Peer = { id: sub, name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : sub, room, socket, joinedAt: this.#o.now(), hits: [] };
    const others = [...members.values()];
    members.set(sub, peer);
    this.#rooms.set(room, members);
    this.#bySocket.set(socket, peer);
    const turn = this.#o.turn ? turnCredentials(this.#o.turn.secret, sub, { ttlSeconds: this.#o.turn.ttlSeconds ?? 3600, now: this.#o.now(), urls: this.#o.turn.urls }) : undefined;
    socket.send(ok(id, { self: sub, room, peers: others.map((p) => ({ id: p.id, name: p.name })), ...(turn ? { iceServers: [{ urls: turn.urls, username: turn.username, credential: turn.credential }] } : {}) }));
    for (const o of others) o.socket.send(note('peer-joined', { id: sub, name: peer.name }));
  }

  #signal(peer: Peer, id: unknown, p: Record<string, unknown>): void {
    const to = p.to, kind = p.kind;
    if (typeof to !== 'string') throw new Error('signal needs "to"');
    const target = this.#rooms.get(peer.room)?.get(to);
    if (!target || to === peer.id) { peer.socket.send(bad(id, ERR.notFound, `${to} is not in the room`)); return; }
    const { key: pairKey, state } = this.#pair(peer.id, to);
    const relay = (extra: Record<string, unknown>) => { target.socket.send(note('signal', { from: peer.id, kind, ...extra })); peer.socket.send(ok(id, {})); };
    if (kind === 'offer' || kind === 'answer') {
      if (typeof p.sdp !== 'string') throw new Error(`${kind} needs sdp`);
      let s: Session;
      try { s = parseSdp(p.sdp); } catch (e) { peer.socket.send(bad(id, ERR.sdp, (e as Error).message)); return; }
      if (!hasFingerprint(s)) { peer.socket.send(bad(id, ERR.sdp, 'the description has no DTLS fingerprint; unencrypted media is refused')); return; }
      let sdp = p.sdp;
      if (this.#o.hidePrivateHosts ?? true) sdp = munge(sdp, [{ kind: 'hide-host-candidates' }]);
      if (kind === 'offer') {
        if (state.offerFrom === peer.id) { peer.socket.send(bad(id, ERR.order, 'your earlier offer has not been answered')); return; }
        if (state.offerFrom === to) {
          // Glare: both offered. The peer who joined earlier is impolite and its offer stands; the later one yields.
          const impolite = peer.joinedAt < target.joinedAt || (peer.joinedAt === target.joinedAt && peer.id < to);
          if (!impolite) { peer.socket.send(bad(id, ERR.glare, `${to} has already offered; answer it, or roll back and wait`)); return; }
          target.socket.send(note('signal', { from: peer.id, kind: 'rollback-request' }));
        }
        state.offerFrom = peer.id; state.stable = false;
        this.#seenOffer.add(pairKey);
      } else {
        if (state.offerFrom !== to) { peer.socket.send(bad(id, ERR.order, `there is no offer from ${to} to answer`)); return; }
        state.offerFrom = null; state.stable = true;
      }
      relay({ sdp });
    } else if (kind === 'candidate' || kind === 'end-of-candidates') {
      if (!this.#seenOffer.has(pairKey)) { peer.socket.send(bad(id, ERR.order, 'candidates may be sent only after an offer')); return; }
      if (kind === 'end-of-candidates') { relay({}); return; }
      if (typeof p.candidate !== 'string') throw new Error('candidate needs a candidate string');
      let c: Candidate;
      try { c = parseCandidate(p.candidate); } catch (e) { peer.socket.send(bad(id, ERR.sdp, (e as Error).message)); return; }
      if ((this.#o.hidePrivateHosts ?? true) && c.type === 'host' && isPrivateAddress(c.address)) { peer.socket.send(ok(id, { dropped: 'private host address' })); return; }
      if (++state.candidates > (this.#o.maxCandidates ?? 120)) { peer.socket.send(bad(id, ERR.rate, 'too many candidates for this pair')); return; }
      relay({ candidate: formatCandidate(c), ...(typeof p.mid === 'string' ? { mid: p.mid.slice(0, 64) } : {}) });
    } else if (kind === 'rollback') {
      if (state.offerFrom !== peer.id) { peer.socket.send(bad(id, ERR.order, 'you have no offer to roll back')); return; }
      state.offerFrom = null; state.stable = true;
      relay({});
    } else {
      throw new Error(`unknown signal kind ${String(kind)}`);
    }
  }

}
