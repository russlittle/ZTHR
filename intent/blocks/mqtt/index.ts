/**
 * MQTT 3.1.1 and 5.0 on the wire and in memory. A packet codec for every control packet (CONNECT through AUTH),
 * with the variable-length integers, length-prefixed UTF-8 strings that refuse NUL and unpaired surrogates, the
 * fixed-header flag rules, and the version 5 property table; a streaming decoder that takes bytes as they arrive,
 * finds packet boundaries, and refuses packets over a size limit before buffering them. Topic names and filters
 * are validated and matched with the "+" and "#" wildcards (topics starting with "$" never match a wildcard
 * first level), shared subscriptions ("$share/group/filter") are understood, a subscription tree finds every
 * subscriber of a topic with one delivery per client at the highest QoS, and a retained-message store keeps the
 * last message per topic and clears on an empty payload. The QoS state machines run both directions: QoS 1
 * (PUBLISH, PUBACK) and QoS 2 (PUBLISH, PUBREC, PUBREL, PUBCOMP), with packet identifiers handed out and reused
 * safely, a receive-maximum window with a queue behind it, duplicate flags on resend after a reconnect, and
 * exactly-once delivery to the application even when a PUBLISH arrives twice.
 * Out of scope: sockets, keep-alive timers, authentication, and persistence; a broker or client wraps these.
 */

export class MqttError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Version = 4 | 5;
export type Props = Readonly<Record<string, number | string | Uint8Array | readonly (readonly [string, string])[] | readonly number[]>>;

// ---------------------------------------------------------------- primitives

export function encodeVarInt(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 268_435_455) throw new MqttError('a variable-length integer is 0 to 268435455');
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

/** Reads a variable-length integer; undefined when the bytes run out, an error when it is longer than four bytes. */
export function decodeVarInt(b: Uint8Array, at = 0): { value: number; length: number } | undefined {
  let value = 0;
  let mult = 1;
  for (let i = 0; i < 4; i++) {
    const x = b[at + i];
    if (x === undefined) return undefined;
    value += (x & 0x7f) * mult;
    if (!(x & 0x80)) {
      if (i > 0 && x === 0) throw new MqttError('a variable-length integer is not in its shortest form');
      return { value, length: i + 1 };
    }
    mult *= 128;
  }
  throw new MqttError('a variable-length integer is longer than four bytes');
}

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkText(s: string): void {
  if (s.includes('\0')) throw new MqttError('MQTT strings cannot contain NUL');
  if (LONE.test(s)) throw new MqttError('MQTT strings must be well-formed UTF-8 (no lone surrogates)');
}

function str(s: string): Buffer {
  checkText(s);
  const b = Buffer.from(s, 'utf8');
  if (b.length > 65535) throw new MqttError('an MQTT string is at most 65535 bytes');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
}
const u16 = (n: number) => Buffer.from([(n >> 8) & 255, n & 255]);
const bin = (b: Uint8Array) => {
  if (b.length > 65535) throw new MqttError('binary data is at most 65535 bytes');
  return Buffer.concat([u16(b.length), Buffer.from(b)]);
};

class Reader {
  at = 0;
  readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  get left() {
    return this.b.length - this.at;
  }
  need(n: number) {
    if (this.left < n) throw new MqttError('the packet ends too soon');
  }
  u8() {
    this.need(1);
    return this.b[this.at++]!;
  }
  u16() {
    this.need(2);
    const v = this.b.readUInt16BE(this.at);
    this.at += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.b.readUInt32BE(this.at);
    this.at += 4;
    return v;
  }
  varint() {
    const v = decodeVarInt(this.b, this.at);
    if (!v) throw new MqttError('the packet ends inside a number');
    this.at += v.length;
    return v.value;
  }
  bytes(n: number) {
    this.need(n);
    const v = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  str() {
    const n = this.u16();
    const raw = this.bytes(n);
    let s: string;
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new MqttError('a string is not valid UTF-8');
    }
    checkText(s);
    return s;
  }
  bin() {
    return Buffer.from(this.bytes(this.u16()));
  }
  rest() {
    return this.bytes(this.left);
  }
}

// ---------------------------------------------------------------- v5 properties

type PType = 'u8' | 'u16' | 'u32' | 'var' | 'str' | 'bin' | 'pair';
const PROPS: readonly [number, string, PType][] = [
  [0x01, 'payloadFormatIndicator', 'u8'], [0x02, 'messageExpiryInterval', 'u32'], [0x03, 'contentType', 'str'], [0x08, 'responseTopic', 'str'], [0x09, 'correlationData', 'bin'],
  [0x0b, 'subscriptionIdentifier', 'var'], [0x11, 'sessionExpiryInterval', 'u32'], [0x12, 'assignedClientIdentifier', 'str'], [0x13, 'serverKeepAlive', 'u16'], [0x15, 'authenticationMethod', 'str'],
  [0x16, 'authenticationData', 'bin'], [0x17, 'requestProblemInformation', 'u8'], [0x18, 'willDelayInterval', 'u32'], [0x19, 'requestResponseInformation', 'u8'], [0x1a, 'responseInformation', 'str'],
  [0x1c, 'serverReference', 'str'], [0x1f, 'reasonString', 'str'], [0x21, 'receiveMaximum', 'u16'], [0x22, 'topicAliasMaximum', 'u16'], [0x23, 'topicAlias', 'u16'], [0x24, 'maximumQoS', 'u8'],
  [0x25, 'retainAvailable', 'u8'], [0x26, 'userProperties', 'pair'], [0x27, 'maximumPacketSize', 'u32'], [0x28, 'wildcardSubscriptionAvailable', 'u8'], [0x29, 'subscriptionIdentifierAvailable', 'u8'], [0x2a, 'sharedSubscriptionAvailable', 'u8'],
];
const BY_ID = new Map(PROPS.map((p) => [p[0], p] as const));
const BY_NAME = new Map(PROPS.map((p) => [p[1], p] as const));
const REPEATABLE = new Set(['userProperties', 'subscriptionIdentifier']);

export function encodeProps(p: Props | undefined): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(p ?? {})) {
    const d = BY_NAME.get(k);
    if (!d) throw new MqttError(`${k} is not an MQTT property`);
    const [id, , t] = d;
    const one = (x: unknown): Buffer => {
      switch (t) {
        case 'u8': if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > 255) throw new MqttError(`${k} is a byte`); return Buffer.from([id, x as number]);
        case 'u16': if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > 65535) throw new MqttError(`${k} is 0 to 65535`); return Buffer.concat([Buffer.from([id]), u16(x as number)]);
        case 'u32': { if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > 0xffffffff) throw new MqttError(`${k} is a 32-bit number`); const b = Buffer.alloc(5); b[0] = id; b.writeUInt32BE(x as number, 1); return b; }
        case 'var': return Buffer.concat([Buffer.from([id]), encodeVarInt(x as number)]);
        case 'str': return Buffer.concat([Buffer.from([id]), str(x as string)]);
        case 'bin': return Buffer.concat([Buffer.from([id]), bin(x as Uint8Array)]);
        case 'pair': return Buffer.concat([Buffer.from([id]), str((x as [string, string])[0]), str((x as [string, string])[1])]);
      }
    };
    if (REPEATABLE.has(k)) {
      for (const x of Array.isArray(v) ? v : [v]) parts.push(one(x));
    } else parts.push(one(v));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

export function decodeProps(r: Reader): Props | undefined {
  const len = r.varint();
  if (len === 0) return undefined;
  const sub = new Reader(Buffer.from(r.bytes(len)));
  const out: Record<string, unknown> = {};
  while (sub.left > 0) {
    const id = sub.varint();
    const d = BY_ID.get(id);
    if (!d) throw new MqttError(`property 0x${id.toString(16)} is not known`);
    const [, name, t] = d;
    const v: unknown = t === 'u8' ? sub.u8() : t === 'u16' ? sub.u16() : t === 'u32' ? sub.u32() : t === 'var' ? sub.varint() : t === 'str' ? sub.str() : t === 'bin' ? sub.bin() : ([sub.str(), sub.str()] as [string, string]);
    if (REPEATABLE.has(name)) ((out[name] ??= []) as unknown[]).push(v);
    else if (name in out) throw new MqttError(`${name} appears twice`);
    else out[name] = v;
  }
  return out as Props;
}

// ---------------------------------------------------------------- topics

/** A topic name (used when publishing): no wildcards, not empty, at most 65535 bytes. */
export function validateTopicName(t: string): void {
  if (!t.length) throw new MqttError('a topic name is not empty');
  checkText(t);
  if (Buffer.byteLength(t) > 65535) throw new MqttError('a topic is at most 65535 bytes');
  if (/[+#]/.test(t)) throw new MqttError('a topic name has no wildcards');
}

/** A topic filter (used when subscribing): "+" is a whole level, "#" is the whole last level. */
export function validateTopicFilter(f: string): void {
  if (!f.length) throw new MqttError('a topic filter is not empty');
  checkText(f);
  if (Buffer.byteLength(f) > 65535) throw new MqttError('a topic is at most 65535 bytes');
  const levels = shared(f)?.filter ?? f;
  if (shared(f) && (!levels.length || !shared(f)!.group.length || /[+#]/.test(shared(f)!.group))) throw new MqttError('a shared subscription is $share/<group>/<filter>');
  const ls = levels.split('/');
  ls.forEach((l, i) => {
    if (l.includes('#') && (l !== '#' || i !== ls.length - 1)) throw new MqttError('# is only valid as the whole last level');
    if (l.includes('+') && l !== '+') throw new MqttError('+ is only valid as a whole level');
  });
}

/** "$share/group/filter" split into its group and filter. */
export function shared(f: string): { group: string; filter: string } | undefined {
  const m = /^\$share\/([^/]*)\/(.*)$/.exec(f);
  return m ? { group: m[1]!, filter: m[2]! } : undefined;
}

/** Whether a filter matches a topic name. Topics starting with "$" do not match a leading wildcard. */
export function topicMatches(filter: string, topic: string): boolean {
  validateTopicFilter(filter);
  validateTopicName(topic);
  const f = (shared(filter)?.filter ?? filter).split('/');
  const t = topic.split('/');
  if (topic.startsWith('$') && (f[0] === '+' || f[0] === '#')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export interface SubOptions {
  readonly qos: 0 | 1 | 2;
  readonly noLocal?: boolean;
  readonly retainAsPublished?: boolean;
  readonly retainHandling?: 0 | 1 | 2;
}

export interface Delivery {
  readonly clientId: string;
  readonly qos: 0 | 1 | 2;
  readonly filter: string;
  readonly noLocal: boolean;
  readonly retainAsPublished: boolean;
}

/** Who is subscribed to what, found by walking the levels of the topic. */
export class SubscriptionTree {
  private readonly root: Level = { children: new Map(), subs: new Map() };

  subscribe(clientId: string, filter: string, o: SubOptions): { existed: boolean } {
    validateTopicFilter(filter);
    const sh = shared(filter);
    let n = this.root;
    for (const l of (sh?.filter ?? filter).split('/')) {
      let c = n.children.get(l);
      if (!c) n.children.set(l, (c = { children: new Map(), subs: new Map() }));
      n = c;
    }
    const key = `${clientId}\0${sh?.group ?? ''}`;
    const existed = n.subs.has(key);
    n.subs.set(key, { clientId, filter, group: sh?.group, o });
    return { existed };
  }

  unsubscribe(clientId: string, filter: string): boolean {
    const sh = shared(filter);
    const path: Level[] = [this.root];
    const names = (sh?.filter ?? filter).split('/');
    for (const l of names) {
      const c = path.at(-1)!.children.get(l);
      if (!c) return false;
      path.push(c);
    }
    const had = path.at(-1)!.subs.delete(`${clientId}\0${sh?.group ?? ''}`);
    for (let i = path.length - 1; i > 0; i--) if (!path[i]!.subs.size && !path[i]!.children.size) path[i - 1]!.children.delete(names[i - 1]!);
    return had;
  }

  removeClient(clientId: string): void {
    const walk = (n: Level) => {
      for (const [k, s] of [...n.subs]) if (s.clientId === clientId) n.subs.delete(k);
      for (const c of n.children.values()) walk(c);
    };
    walk(this.root);
  }

  /** Every client to deliver to: once each, at the highest QoS of the matching subscriptions; one member per shared group. */
  match(topic: string, o: { pick?: (members: readonly string[]) => string } = {}): Delivery[] {
    validateTopicName(topic);
    const levels = topic.split('/');
    const hits: Sub[] = [];
    const walk = (n: Level, i: number) => {
      const dollar = i === 0 && topic.startsWith('$');
      const hash = n.children.get('#');
      if (hash && !dollar) hits.push(...hash.subs.values());
      if (i === levels.length) {
        hits.push(...n.subs.values());
        return;
      }
      const exact = n.children.get(levels[i]!);
      if (exact) walk(exact, i + 1);
      const plus = n.children.get('+');
      if (plus && !dollar) walk(plus, i + 1);
    };
    walk(this.root, 0);
    const out = new Map<string, Delivery>();
    const groups = new Map<string, Sub[]>();
    for (const s of hits) {
      if (s.group !== undefined) {
        const g = `${s.group}\0${s.filter}`;
        groups.set(g, [...(groups.get(g) ?? []), s]);
        continue;
      }
      add(out, s);
    }
    for (const members of groups.values()) {
      const chosen = o.pick ? members.find((m) => m.clientId === o.pick!(members.map((x) => x.clientId))) ?? members[0]! : members[0]!;
      add(out, chosen);
    }
    return [...out.values()];
  }
}
interface Sub {
  clientId: string;
  filter: string;
  group: string | undefined;
  o: SubOptions;
}
interface Level {
  children: Map<string, Level>;
  subs: Map<string, Sub>;
}
function add(out: Map<string, Delivery>, s: Sub) {
  const prev = out.get(s.clientId);
  if (!prev || s.o.qos > prev.qos) out.set(s.clientId, { clientId: s.clientId, qos: s.o.qos, filter: s.filter, noLocal: s.o.noLocal ?? false, retainAsPublished: s.o.retainAsPublished ?? false });
}

export interface Retained {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly qos: 0 | 1 | 2;
  readonly properties?: Props;
}

/** The last retained message per topic. An empty payload clears it. */
export class RetainedStore {
  private readonly m = new Map<string, Retained>();
  set(r: Retained): void {
    validateTopicName(r.topic);
    if (r.payload.length === 0) this.m.delete(r.topic);
    else this.m.set(r.topic, r);
  }
  get size() {
    return this.m.size;
  }
  /** Retained messages a new subscription receives. */
  match(filter: string): Retained[] {
    return [...this.m.values()].filter((r) => topicMatches(filter, r.topic)).sort((a, b) => a.topic.localeCompare(b.topic));
  }
}

// ---------------------------------------------------------------- packets

export type Packet =
  | { type: 'connect'; protocolLevel: Version; clean: boolean; keepAlive: number; clientId: string; will?: { topic: string; payload: Uint8Array; qos: 0 | 1 | 2; retain: boolean; properties?: Props }; username?: string; password?: Uint8Array; properties?: Props }
  | { type: 'connack'; sessionPresent: boolean; code: number; properties?: Props }
  | { type: 'publish'; topic: string; payload: Uint8Array; qos: 0 | 1 | 2; retain: boolean; dup: boolean; packetId?: number; properties?: Props }
  | { type: 'puback' | 'pubrec' | 'pubrel' | 'pubcomp'; packetId: number; code?: number; properties?: Props }
  | { type: 'subscribe'; packetId: number; subscriptions: readonly ({ filter: string } & SubOptions)[]; properties?: Props }
  | { type: 'suback'; packetId: number; codes: readonly number[]; properties?: Props }
  | { type: 'unsubscribe'; packetId: number; filters: readonly string[]; properties?: Props }
  | { type: 'unsuback'; packetId: number; codes?: readonly number[]; properties?: Props }
  | { type: 'pingreq' | 'pingresp' }
  | { type: 'disconnect'; code?: number; properties?: Props }
  | { type: 'auth'; code: number; properties?: Props };

const TYPES = ['', 'connect', 'connack', 'publish', 'puback', 'pubrec', 'pubrel', 'pubcomp', 'subscribe', 'suback', 'unsubscribe', 'unsuback', 'pingreq', 'pingresp', 'disconnect', 'auth'] as const;
const FIXED_FLAGS: Readonly<Record<string, number>> = { connect: 0, connack: 0, puback: 0, pubrec: 0, pubrel: 2, pubcomp: 0, subscribe: 2, suback: 0, unsubscribe: 2, unsuback: 0, pingreq: 0, pingresp: 0, disconnect: 0, auth: 0 };

const fixed = (type: string, flags: number, body: Buffer) => Buffer.concat([Buffer.from([(TYPES.indexOf(type as never) << 4) | flags]), encodeVarInt(body.length), body]);
const pid = (n: number) => {
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new MqttError('a packet identifier is 1 to 65535');
  return u16(n);
};

export function encode(p: Packet, v: Version = 4): Buffer {
  const props = (x: Props | undefined) => (v === 5 ? encodeProps(x) : Buffer.alloc(0));
  if (v === 4 && 'properties' in p && p.properties && Object.keys(p.properties).length) throw new MqttError('properties exist only in MQTT 5');
  switch (p.type) {
    case 'connect': {
      if (p.protocolLevel !== v) throw new MqttError('the packet version differs from the connection version');
      validateClientFields(p);
      const flags = (p.clean ? 2 : 0) | (p.will ? 4 | (p.will.qos << 3) | (p.will.retain ? 32 : 0) : 0) | (p.username !== undefined ? 128 : 0) | (p.password !== undefined ? 64 : 0);
      if (p.password !== undefined && p.username === undefined && v === 4) throw new MqttError('MQTT 3.1.1 does not allow a password without a user name');
      const parts = [str('MQTT'), Buffer.from([v, flags]), u16(p.keepAlive), props(p.properties), str(p.clientId)];
      if (p.will) {
        validateTopicName(p.will.topic);
        parts.push(props(p.will.properties), str(p.will.topic), bin(p.will.payload));
      }
      if (p.username !== undefined) parts.push(str(p.username));
      if (p.password !== undefined) parts.push(bin(p.password));
      return fixed('connect', 0, Buffer.concat(parts));
    }
    case 'connack':
      return fixed('connack', 0, Buffer.concat([Buffer.from([p.sessionPresent ? 1 : 0, p.code]), props(p.properties)]));
    case 'publish': {
      validateTopicName(p.topic);
      if (p.qos > 0 && p.packetId === undefined) throw new MqttError('QoS 1 and 2 publishes need a packet identifier');
      if (p.qos === 0 && p.packetId !== undefined) throw new MqttError('QoS 0 publishes have no packet identifier');
      if (p.qos === 0 && p.dup) throw new MqttError('a QoS 0 publish is never a duplicate');
      return fixed('publish', (p.dup ? 8 : 0) | (p.qos << 1) | (p.retain ? 1 : 0), Buffer.concat([str(p.topic), p.qos > 0 ? pid(p.packetId!) : Buffer.alloc(0), props(p.properties), Buffer.from(p.payload)]));
    }
    case 'puback': case 'pubrec': case 'pubrel': case 'pubcomp': {
      const withReason = v === 5 && ((p.code !== undefined && p.code !== 0) || p.properties !== undefined);
      return fixed(p.type, FIXED_FLAGS[p.type]!, Buffer.concat([pid(p.packetId), ...(withReason ? [Buffer.from([p.code ?? 0]), ...(p.properties ? [props(p.properties)] : [])] : [])]));
    }
    case 'subscribe': {
      if (!p.subscriptions.length) throw new MqttError('a subscribe has at least one topic filter');
      const subs = p.subscriptions.map((s) => {
        validateTopicFilter(s.filter);
        const o = s.qos | (v === 5 ? (s.noLocal ? 4 : 0) | (s.retainAsPublished ? 8 : 0) | ((s.retainHandling ?? 0) << 4) : 0);
        if (![0, 1, 2].includes(s.qos)) throw new MqttError('QoS is 0, 1 or 2');
        return Buffer.concat([str(s.filter), Buffer.from([o])]);
      });
      return fixed('subscribe', 2, Buffer.concat([pid(p.packetId), props(p.properties), ...subs]));
    }
    case 'suback':
      return fixed('suback', 0, Buffer.concat([pid(p.packetId), props(p.properties), Buffer.from(p.codes)]));
    case 'unsubscribe': {
      if (!p.filters.length) throw new MqttError('an unsubscribe has at least one topic filter');
      p.filters.forEach(validateTopicFilter);
      return fixed('unsubscribe', 2, Buffer.concat([pid(p.packetId), props(p.properties), ...p.filters.map(str)]));
    }
    case 'unsuback':
      return fixed('unsuback', 0, Buffer.concat([pid(p.packetId), ...(v === 5 ? [props(p.properties), Buffer.from(p.codes ?? [])] : [])]));
    case 'pingreq': case 'pingresp':
      return fixed(p.type, 0, Buffer.alloc(0));
    case 'disconnect': {
      const body = v === 5 && ((p.code ?? 0) !== 0 || p.properties) ? Buffer.concat([Buffer.from([p.code ?? 0]), ...(p.properties ? [props(p.properties)] : [])]) : Buffer.alloc(0);
      return fixed('disconnect', 0, body);
    }
    case 'auth':
      if (v !== 5) throw new MqttError('AUTH exists only in MQTT 5');
      return fixed('auth', 0, p.code === 0 && !p.properties ? Buffer.alloc(0) : Buffer.concat([Buffer.from([p.code]), props(p.properties)]));
  }
}

function validateClientFields(p: Extract<Packet, { type: 'connect' }>) {
  if (![0, 1, 2].includes(p.will?.qos ?? 0)) throw new MqttError('the will QoS is 0, 1 or 2');
  if (!Number.isInteger(p.keepAlive) || p.keepAlive < 0 || p.keepAlive > 65535) throw new MqttError('the keep-alive is 0 to 65535 seconds');
  if (p.protocolLevel === 4 && p.clientId === '' && !p.clean) throw new MqttError('an empty client id needs a clean session in MQTT 3.1.1');
}

/** Decodes one packet from a body whose fixed header has been read. */
function decodeBody(type: (typeof TYPES)[number], flags: number, body: Buffer, v: Version): Packet {
  const r = new Reader(body);
  const props = () => (v === 5 ? decodeProps(r) : undefined);
  const withProps = <T extends object>(o: T, p: Props | undefined): T => (p ? { ...o, properties: p } : o);
  const done = () => {
    if (r.left) throw new MqttError('the packet has bytes left over');
  };
  switch (type) {
    case 'connect': {
      if (r.str() !== 'MQTT') throw new MqttError('the protocol name is not MQTT');
      const level = r.u8();
      if (level !== 4 && level !== 5) throw new MqttError(`protocol level ${level} is not supported`);
      const cf = r.u8();
      if (cf & 1) throw new MqttError('the reserved connect flag must be 0');
      const keepAlive = r.u16();
      const pr = level === 5 ? decodeProps(r) : undefined;
      const clientId = r.str();
      const willFlag = !!(cf & 4);
      const willQos = (cf >> 3) & 3;
      if (!willFlag && (willQos !== 0 || cf & 32)) throw new MqttError('will QoS and retain need the will flag');
      if (willQos === 3) throw new MqttError('the will QoS cannot be 3');
      let will: Extract<Packet, { type: 'connect' }>['will'];
      if (willFlag) {
        const wp = level === 5 ? decodeProps(r) : undefined;
        const topic = r.str();
        validateTopicName(topic);
        will = { topic, payload: r.bin(), qos: willQos as 0 | 1 | 2, retain: !!(cf & 32), ...(wp ? { properties: wp } : {}) };
      }
      const username = cf & 128 ? r.str() : undefined;
      const password = cf & 64 ? r.bin() : undefined;
      if (level === 4 && password !== undefined && username === undefined) throw new MqttError('a password without a user name is not allowed in MQTT 3.1.1');
      if (level === 4 && clientId === '' && !(cf & 2)) throw new MqttError('an empty client id needs a clean session in MQTT 3.1.1');
      done();
      return withProps({ type: 'connect', protocolLevel: level as Version, clean: !!(cf & 2), keepAlive, clientId, ...(will ? { will } : {}), ...(username !== undefined ? { username } : {}), ...(password ? { password } : {}) } as Packet, pr);
    }
    case 'connack': {
      const f = r.u8();
      if (f & 0xfe) throw new MqttError('the reserved connack flags must be 0');
      const code = r.u8();
      const p = props();
      done();
      return withProps({ type: 'connack', sessionPresent: !!(f & 1), code } as Packet, p);
    }
    case 'publish': {
      const qos = (flags >> 1) & 3;
      if (qos === 3) throw new MqttError('a publish cannot have QoS 3');
      const dup = !!(flags & 8);
      if (qos === 0 && dup) throw new MqttError('a QoS 0 publish is never a duplicate');
      const topic = r.str();
      validateTopicName(topic);
      const packetId = qos > 0 ? r.u16() : undefined;
      if (packetId === 0) throw new MqttError('a packet identifier is not 0');
      const p = props();
      return withProps({ type: 'publish', topic, payload: Buffer.from(r.rest()), qos: qos as 0 | 1 | 2, retain: !!(flags & 1), dup, ...(packetId !== undefined ? { packetId } : {}) } as Packet, p);
    }
    case 'puback': case 'pubrec': case 'pubrel': case 'pubcomp': {
      const packetId = r.u16();
      if (!packetId) throw new MqttError('a packet identifier is not 0');
      let code: number | undefined;
      let p: Props | undefined;
      if (v === 5 && r.left) {
        code = r.u8();
        if (r.left) p = decodeProps(r);
      }
      done();
      return withProps({ type, packetId, ...(code !== undefined ? { code } : {}) } as Packet, p);
    }
    case 'subscribe': {
      const packetId = r.u16();
      if (!packetId) throw new MqttError('a packet identifier is not 0');
      const p = props();
      const subscriptions: ({ filter: string } & SubOptions)[] = [];
      while (r.left) {
        const filter = r.str();
        validateTopicFilter(filter);
        const o = r.u8();
        const qos = o & 3;
        if (qos === 3) throw new MqttError('the subscription QoS cannot be 3');
        if (v === 4 && o & 0xfc) throw new MqttError('the reserved subscription bits must be 0');
        if (v === 5 && o & 0xc0) throw new MqttError('the reserved subscription bits must be 0');
        const rh = (o >> 4) & 3;
        if (rh === 3) throw new MqttError('retain handling cannot be 3');
        subscriptions.push({ filter, qos: qos as 0 | 1 | 2, ...(v === 5 ? { noLocal: !!(o & 4), retainAsPublished: !!(o & 8), retainHandling: rh as 0 | 1 | 2 } : {}) });
      }
      if (!subscriptions.length) throw new MqttError('a subscribe has no topic filters');
      return withProps({ type: 'subscribe', packetId, subscriptions } as Packet, p);
    }
    case 'suback': {
      const packetId = r.u16();
      const p = props();
      return withProps({ type: 'suback', packetId, codes: [...r.rest()] } as Packet, p);
    }
    case 'unsubscribe': {
      const packetId = r.u16();
      if (!packetId) throw new MqttError('a packet identifier is not 0');
      const p = props();
      const filters: string[] = [];
      while (r.left) {
        const f = r.str();
        validateTopicFilter(f);
        filters.push(f);
      }
      if (!filters.length) throw new MqttError('an unsubscribe has no topic filters');
      return withProps({ type: 'unsubscribe', packetId, filters } as Packet, p);
    }
    case 'unsuback': {
      const packetId = r.u16();
      const p = props();
      return withProps({ type: 'unsuback', packetId, ...(v === 5 ? { codes: [...r.rest()] } : {}) } as Packet, p);
    }
    case 'pingreq': case 'pingresp':
      done();
      return { type };
    case 'disconnect': {
      let code: number | undefined;
      let p: Props | undefined;
      if (v === 5 && r.left) {
        code = r.u8();
        if (r.left) p = decodeProps(r);
      }
      done();
      return withProps({ type: 'disconnect', ...(code !== undefined ? { code } : {}) } as Packet, p);
    }
    case 'auth': {
      if (v !== 5) throw new MqttError('AUTH exists only in MQTT 5');
      const code = r.left ? r.u8() : 0;
      const p = r.left ? decodeProps(r) : undefined;
      done();
      return withProps({ type: 'auth', code } as Packet, p);
    }
    default:
      throw new MqttError('unknown packet type');
  }
}

/** Takes bytes as they arrive and returns whole packets; keeps what is left for the next chunk. */
export class PacketStream {
  private buf: Buffer = Buffer.alloc(0);
  version: Version | undefined;
  private readonly max: number;
  constructor(o: { maxPacketBytes?: number; version?: Version } = {}) {
    this.max = o.maxPacketBytes ?? 1_048_576;
    this.version = o.version;
  }
  get buffered(): number {
    return this.buf.length;
  }
  push(chunk: Uint8Array): Packet[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out: Packet[] = [];
    for (;;) {
      if (this.buf.length < 2) return out;
      const first = this.buf[0]!;
      const type = TYPES[first >> 4];
      if (!type) throw new MqttError('packet type 0 is reserved');
      const len = decodeVarInt(this.buf, 1);
      if (!len) return out;
      if (len.value > this.max) throw new MqttError(`a packet of ${len.value} bytes is over the ${this.max} byte limit`);
      const total = 1 + len.length + len.value;
      if (this.buf.length < total) return out;
      const flags = first & 15;
      if (type !== 'publish' && flags !== FIXED_FLAGS[type]) throw new MqttError(`the fixed-header flags of ${type} must be ${FIXED_FLAGS[type]}`);
      const body = this.buf.subarray(1 + len.length, total);
      if (type === 'connect') {
        const lvl = body[2 + 4];
        if (lvl === 4 || lvl === 5) this.version = lvl;
      }
      if (!this.version && type !== 'connect') throw new MqttError('the first packet must be CONNECT');
      const p = decodeBody(type, flags, Buffer.from(body), this.version ?? 4);
      this.buf = this.buf.subarray(total);
      out.push(p);
    }
  }
}

export function decode(bytes: Uint8Array, v: Version): Packet {
  const s = new PacketStream({ version: v });
  const ps = s.push(bytes);
  if (ps.length !== 1 || s.buffered) throw new MqttError('expected exactly one packet');
  return ps[0]!;
}

// ---------------------------------------------------------------- QoS state

export interface Message {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly qos: 0 | 1 | 2;
  readonly retain: boolean;
  readonly properties?: Props;
}

type OutState = 'await-puback' | 'await-pubrec' | 'await-pubcomp';

/** One side of a session: what it has sent and not yet seen acknowledged, and what it has received. */
export class Session {
  private readonly out = new Map<number, { msg: Message; state: OutState }>();
  private readonly queue: Message[] = [];
  private readonly incoming = new Set<number>();
  private next = 1;
  private readonly window: number;
  constructor(o: { receiveMaximum?: number } = {}) {
    this.window = o.receiveMaximum ?? 65535;
    if (!(this.window >= 1 && this.window <= 65535)) throw new MqttError('the receive maximum is 1 to 65535');
  }

  get inflight(): number {
    return this.out.size;
  }
  get queued(): number {
    return this.queue.length;
  }

  private allocate(): number {
    for (let i = 0; i < 65535; i++) {
      const id = this.next;
      this.next = this.next === 65535 ? 1 : this.next + 1;
      if (!this.out.has(id)) return id;
    }
    throw new MqttError('all packet identifiers are in use');
  }

  /** Sends a message: QoS 0 goes at once; QoS 1 and 2 get an identifier unless the window is full, when they wait. */
  send(m: Message): Packet[] {
    if (m.qos === 0) return [{ type: 'publish', topic: m.topic, payload: m.payload, qos: 0, retain: m.retain, dup: false, ...(m.properties ? { properties: m.properties } : {}) }];
    if (this.out.size >= this.window) {
      this.queue.push(m);
      return [];
    }
    const id = this.allocate();
    this.out.set(id, { msg: m, state: m.qos === 1 ? 'await-puback' : 'await-pubrec' });
    return [{ type: 'publish', topic: m.topic, payload: m.payload, qos: m.qos, retain: m.retain, dup: false, packetId: id, ...(m.properties ? { properties: m.properties } : {}) }];
  }

  private drain(): Packet[] {
    const out: Packet[] = [];
    while (this.queue.length && this.out.size < this.window) out.push(...this.send(this.queue.shift()!));
    return out;
  }

  /** PUBACK for a QoS 1 message we sent. Returns packets now free to send. */
  onPuback(id: number): Packet[] {
    const e = this.out.get(id);
    if (!e || e.state !== 'await-puback') throw new MqttError(`PUBACK for ${id}, which is not waiting for one`);
    this.out.delete(id);
    return this.drain();
  }

  /** PUBREC for a QoS 2 message we sent: answer with PUBREL. A repeated PUBREC gets PUBREL again. */
  onPubrec(id: number): Packet[] {
    const e = this.out.get(id);
    if (!e || (e.state !== 'await-pubrec' && e.state !== 'await-pubcomp')) throw new MqttError(`PUBREC for ${id}, which is not waiting for one`);
    e.state = 'await-pubcomp';
    return [{ type: 'pubrel', packetId: id }];
  }

  onPubcomp(id: number): Packet[] {
    const e = this.out.get(id);
    if (!e || e.state !== 'await-pubcomp') throw new MqttError(`PUBCOMP for ${id}, which is not waiting for one`);
    this.out.delete(id);
    return this.drain();
  }

  /**
   * A PUBLISH from the other side. `deliver` is what to hand to the application and acknowledgements to send back.
   * A QoS 2 message is delivered once: a duplicate before PUBREL only gets PUBREC again.
   */
  receive(p: Extract<Packet, { type: 'publish' }>): { deliver: boolean; reply: Packet[] } {
    if (p.qos === 0) return { deliver: true, reply: [] };
    if (p.qos === 1) return { deliver: true, reply: [{ type: 'puback', packetId: p.packetId! }] };
    const seen = this.incoming.has(p.packetId!);
    this.incoming.add(p.packetId!);
    return { deliver: !seen, reply: [{ type: 'pubrec', packetId: p.packetId! }] };
  }

  /** PUBREL from the other side: release the identifier and answer PUBCOMP (also when it is unknown, as a lost PUBCOMP needs it). */
  onPubrel(id: number): Packet[] {
    const known = this.incoming.delete(id);
    return [{ type: 'pubcomp', packetId: id, ...(known ? {} : { code: 0x92 }) }];
  }

  /** After a reconnect with the session kept: everything unacknowledged, in identifier order, publishes marked as duplicates. */
  resume(): Packet[] {
    const out: Packet[] = [];
    for (const [id, e] of [...this.out].sort((a, b) => a[0] - b[0])) {
      if (e.state === 'await-pubcomp') out.push({ type: 'pubrel', packetId: id });
      else out.push({ type: 'publish', topic: e.msg.topic, payload: e.msg.payload, qos: e.msg.qos, retain: e.msg.retain, dup: true, packetId: id, ...(e.msg.properties ? { properties: e.msg.properties } : {}) });
    }
    return out;
  }
}
