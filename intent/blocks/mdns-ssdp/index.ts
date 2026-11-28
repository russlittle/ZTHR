/**
 * Finding things on the local network, two ways. Multicast DNS (RFC 6762) with DNS-based service discovery (RFC
 * 6763): a DNS message codec (names with compression and loop and bounds protection, A, AAAA, PTR, SRV, TXT and
 * NSEC records, the unicast-response bit on questions and the cache-flush bit on records), builders for browse,
 * resolve, announce and goodbye messages, answers to queries with known-answer suppression, TXT attribute
 * parsing, and a cache that expires records by their TTL, treats a goodbye (TTL 0) as "gone in one second",
 * replaces old records when a cache-flush record arrives, and says which records to re-ask about at 80, 85, 90
 * and 95 percent of their life. And SSDP (UPnP Device Architecture 1.1): M-SEARCH, NOTIFY (alive, update,
 * byebye) and search responses, written and read with limits on size, header count and line breaks, with a
 * LOCATION that must be an http(s) address on the host that sent it (so a device cannot point a hub at another
 * machine), and a cache keyed by USN that expires by max-age. Time and the sender's address are passed in.
 * Out of scope: sockets and multicast group membership, conflict probing and name uniqueness, and fetching the
 * device description a LOCATION points to.
 */

export class DiscoveryError extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ---------------------------------------------------------------- DNS names

/** A name as its labels; a label may contain dots (DNS-SD instance names do). */
export type Name = readonly string[];

export const nameToString = (n: Name): string => n.map((l) => l.replace(/[\\.]/g, '\\$&')).join('.');

export function parseName(s: string): Name {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') cur += s[++i] ?? '';
    else if (c === '.') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const keyOf = (n: Name) => n.map((l) => l.toLowerCase()).join('\0');
export const sameName = (a: Name, b: Name) => keyOf(a) === keyOf(b);
const endsWith = (n: Name, suffix: Name) => n.length >= suffix.length && sameName(n.slice(n.length - suffix.length), suffix);

// ---------------------------------------------------------------- DNS messages

export type RData =
  | { readonly type: 'A'; readonly address: string }
  | { readonly type: 'AAAA'; readonly address: string }
  | { readonly type: 'PTR'; readonly target: Name }
  | { readonly type: 'SRV'; readonly priority: number; readonly weight: number; readonly port: number; readonly target: Name }
  | { readonly type: 'TXT'; readonly strings: readonly Buffer[] }
  | { readonly type: 'NSEC'; readonly next: Name; readonly types: readonly number[] }
  | { readonly type: 'RAW'; readonly code: number; readonly data: Buffer };

export interface Record_ {
  readonly name: Name;
  readonly ttl: number;
  readonly data: RData;
  /** mDNS: this record replaces whatever else is cached for its name and type. */
  readonly flush?: boolean;
}

export interface Question {
  readonly name: Name;
  readonly type: 'A' | 'AAAA' | 'PTR' | 'SRV' | 'TXT' | 'ANY';
  /** mDNS: the asker would take a unicast answer. */
  readonly unicast?: boolean;
}

export interface Message {
  readonly id: number;
  readonly response: boolean;
  readonly authoritative?: boolean;
  readonly truncated?: boolean;
  readonly questions: readonly Question[];
  readonly answers: readonly Record_[];
  readonly authority?: readonly Record_[];
  readonly additional?: readonly Record_[];
}

const TYPE_CODE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, NSEC: 47, ANY: 255 } as const;
const CODE_TYPE = new Map<number, keyof typeof TYPE_CODE>(Object.entries(TYPE_CODE).map(([k, v]) => [v, k as keyof typeof TYPE_CODE]));
const MAX_MESSAGE = 9000;
const MAX_RECORDS = 500;

function ipv4(s: string): Buffer {
  const p = s.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) throw new DiscoveryError(`${s} is not an IPv4 address`);
  return Buffer.from(p.map(Number));
}
function ipv6(s: string): Buffer {
  let a = s.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(a) || (a.match(/::/g) ?? []).length > 1) throw new DiscoveryError(`${s} is not an IPv6 address`);
  const [h, t] = a.split('::');
  const head = h ? h.split(':') : [];
  const tail = t === undefined ? [] : t ? t.split(':') : [];
  const fill = a.includes('::') ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) throw new DiscoveryError(`${s} is not an IPv6 address`);
  a = '';
  return Buffer.from(groups.map((g) => g.padStart(4, '0')).join(''), 'hex');
}
const showV6 = (b: Buffer) => {
  const g = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16));
  let best = -1, bl = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > bl && j - i > 1) { best = i; bl = j - i; }
    i = j;
  }
  return best < 0 ? g.join(':') : `${g.slice(0, best).join(':')}::${g.slice(best + bl).join(':')}`;
};

class Writer {
  readonly parts: Buffer[] = [];
  length = 0;
  private readonly seen = new Map<string, number>();
  put(b: Buffer) {
    this.parts.push(b);
    this.length += b.length;
  }
  u16(n: number) {
    this.put(Buffer.from([(n >> 8) & 255, n & 255]));
  }
  u32(n: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    this.put(b);
  }
  name(n: Name, compress = true) {
    let total = 1;
    for (const l of n) {
      const lb = Buffer.byteLength(l);
      if (lb === 0 || lb > 63) throw new DiscoveryError('a name label is 1 to 63 bytes');
      total += lb + 1;
    }
    if (total > 255) throw new DiscoveryError('a name is at most 255 bytes');
    for (let i = 0; i < n.length; i++) {
      const k = keyOf(n.slice(i));
      const at = this.seen.get(k);
      if (compress && at !== undefined && at < 0x4000) {
        this.u16(0xc000 | at);
        return;
      }
      if (this.length < 0x4000) this.seen.set(k, this.length);
      const lb = Buffer.from(n[i]!, 'utf8');
      this.put(Buffer.concat([Buffer.from([lb.length]), lb]));
    }
    this.put(Buffer.from([0]));
  }
}

function writeRecord(w: Writer, r: Record_, mdns: boolean) {
  const code = r.data.type === 'RAW' ? r.data.code : TYPE_CODE[r.data.type];
  w.name(r.name);
  w.u16(code);
  w.u16(1 | (mdns && r.flush ? 0x8000 : 0));
  if (!Number.isInteger(r.ttl) || r.ttl < 0 || r.ttl > 0x7fffffff) throw new DiscoveryError('a TTL is 0 to 2147483647 seconds');
  w.u32(r.ttl);
  const d = new Writer();
  (d as unknown as { seen: Map<string, number> }).seen = (w as unknown as { seen: Map<string, number> }).seen;
  const body = rdata(r.data, w);
  w.u16(body.length);
  w.put(body);
}

/** RDATA bytes. Names inside are written uncompressed for SRV (RFC 6762 allows it) and compressed against the message for PTR. */
function rdata(d: RData, w: Writer): Buffer {
  switch (d.type) {
    case 'A': return ipv4(d.address);
    case 'AAAA': return ipv6(d.address);
    case 'PTR': { const t = new Writer(); t.name(d.target, false); return Buffer.concat(t.parts); }
    case 'SRV': {
      for (const x of [d.priority, d.weight, d.port]) if (!Number.isInteger(x) || x < 0 || x > 65535) throw new DiscoveryError('SRV numbers are 0 to 65535');
      const t = new Writer();
      t.name(d.target, false);
      return Buffer.concat([Buffer.from([d.priority >> 8, d.priority & 255, d.weight >> 8, d.weight & 255, d.port >> 8, d.port & 255]), ...t.parts]);
    }
    case 'TXT': {
      const strs = d.strings.length ? d.strings : [Buffer.alloc(0)];
      for (const s of strs) if (s.length > 255) throw new DiscoveryError('a TXT string is at most 255 bytes');
      return Buffer.concat(strs.map((s) => Buffer.concat([Buffer.from([s.length]), s])));
    }
    case 'NSEC': {
      const t = new Writer();
      t.name(d.next, false);
      const bytes = Buffer.alloc(Math.max(...d.types, 0) / 8 + 1 | 0);
      for (const ty of d.types) if (ty < 256) bytes[ty >> 3] = bytes[ty >> 3]! | (0x80 >> (ty & 7));
      let n = bytes.length;
      while (n > 0 && bytes[n - 1] === 0) n--;
      void w;
      return Buffer.concat([...t.parts, Buffer.from([0, n]), bytes.subarray(0, n)]);
    }
    case 'RAW': return d.data;
  }
}

export function encodeMessage(m: Message, o: { mdns?: boolean } = {}): Buffer {
  const mdns = o.mdns ?? true;
  const w = new Writer();
  w.u16(m.id);
  w.u16((m.response ? 0x8000 : 0) | (m.authoritative ? 0x0400 : 0) | (m.truncated ? 0x0200 : 0));
  const auth = m.authority ?? [];
  const add = m.additional ?? [];
  for (const n of [m.questions.length, m.answers.length, auth.length, add.length]) w.u16(n);
  for (const q of m.questions) {
    w.name(q.name);
    w.u16(TYPE_CODE[q.type]);
    w.u16(1 | (mdns && q.unicast ? 0x8000 : 0));
  }
  for (const r of [...m.answers, ...auth, ...add]) writeRecord(w, r, mdns);
  const out = Buffer.concat(w.parts);
  if (out.length > MAX_MESSAGE) throw new DiscoveryError('the message is larger than 9000 bytes');
  return out;
}

class Reader {
  at = 0;
  readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  need(n: number) {
    if (this.at + n > this.b.length) throw new DiscoveryError('the message ends too soon');
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
  name(): Name {
    const labels: string[] = [];
    let p = this.at;
    let jumped = false;
    let hops = 0;
    let total = 1;
    for (;;) {
      if (p >= this.b.length) throw new DiscoveryError('a name runs off the end of the message');
      const len = this.b[p]!;
      if ((len & 0xc0) === 0xc0) {
        if (p + 1 >= this.b.length) throw new DiscoveryError('a name pointer is cut off');
        const target = ((len & 0x3f) << 8) | this.b[p + 1]!;
        if (!jumped) this.at = p + 2;
        jumped = true;
        if (target >= p || ++hops > 20) throw new DiscoveryError('a name pointer goes forward or loops');
        p = target;
        continue;
      }
      if (len & 0xc0) throw new DiscoveryError('a name label has a reserved length form');
      if (len === 0) {
        if (!jumped) this.at = p + 1;
        return labels;
      }
      if (p + 1 + len > this.b.length) throw new DiscoveryError('a name label runs off the end of the message');
      total += len + 1;
      if (total > 255) throw new DiscoveryError('a name is longer than 255 bytes');
      labels.push(this.b.subarray(p + 1, p + 1 + len).toString('utf8'));
      p += 1 + len;
    }
  }
}

function readRecord(r: Reader): Record_ {
  const name = r.name();
  const code = r.u16();
  const cls = r.u16();
  const ttl = r.u32();
  const len = r.u16();
  r.need(len);
  const end = r.at + len;
  const body = r.b.subarray(r.at, end);
  const type = CODE_TYPE.get(code);
  let data: RData;
  const sub = new Reader(r.b);
  sub.at = r.at;
  switch (type) {
    case 'A':
      if (len !== 4) throw new DiscoveryError('an A record is 4 bytes');
      data = { type: 'A', address: [...body].join('.') };
      break;
    case 'AAAA':
      if (len !== 16) throw new DiscoveryError('an AAAA record is 16 bytes');
      data = { type: 'AAAA', address: showV6(Buffer.from(body)) };
      break;
    case 'PTR':
      data = { type: 'PTR', target: sub.name() };
      if (sub.at !== end) throw new DiscoveryError('a PTR record has bytes left over');
      break;
    case 'SRV': {
      if (len < 7) throw new DiscoveryError('an SRV record is at least 7 bytes');
      const priority = sub.u16();
      const weight = sub.u16();
      const port = sub.u16();
      data = { type: 'SRV', priority, weight, port, target: sub.name() };
      if (sub.at !== end) throw new DiscoveryError('an SRV record has bytes left over');
      break;
    }
    case 'TXT': {
      const strings: Buffer[] = [];
      for (let i = 0; i < len; ) {
        const n = body[i]!;
        if (i + 1 + n > len) throw new DiscoveryError('a TXT string runs past its record');
        strings.push(Buffer.from(body.subarray(i + 1, i + 1 + n)));
        i += 1 + n;
      }
      data = { type: 'TXT', strings };
      break;
    }
    case 'NSEC': {
      const next = sub.name();
      const types: number[] = [];
      let i = sub.at;
      while (i < end) {
        const win = r.b[i]!;
        const bl = r.b[i + 1]!;
        if (bl < 1 || bl > 32 || i + 2 + bl > end) throw new DiscoveryError('an NSEC bitmap is not valid');
        for (let k = 0; k < bl; k++) for (let bit = 0; bit < 8; bit++) if (r.b[i + 2 + k]! & (0x80 >> bit)) types.push(win * 256 + k * 8 + bit);
        i += 2 + bl;
      }
      data = { type: 'NSEC', next, types };
      break;
    }
    default:
      data = { type: 'RAW', code, data: Buffer.from(body) };
  }
  r.at = end;
  return { name, ttl, data, ...(cls & 0x8000 ? { flush: true } : {}) };
}

export function decodeMessage(buf: Uint8Array): Message {
  const b = Buffer.from(buf);
  if (b.length > MAX_MESSAGE) throw new DiscoveryError('the message is larger than 9000 bytes');
  if (b.length < 12) throw new DiscoveryError('a DNS message is at least 12 bytes');
  const r = new Reader(b);
  const id = r.u16();
  const flags = r.u16();
  const [qd, an, ns, ar] = [r.u16(), r.u16(), r.u16(), r.u16()];
  if (qd + an + ns + ar > MAX_RECORDS) throw new DiscoveryError('the message claims too many records');
  if ((flags >> 11) & 15) throw new DiscoveryError('only standard queries are used');
  if (flags & 15) throw new DiscoveryError('the response code of an mDNS message is 0');
  const questions: Question[] = [];
  for (let i = 0; i < qd; i++) {
    const name = r.name();
    const code = r.u16();
    const cls = r.u16();
    const type = CODE_TYPE.get(code);
    if (!type || type === 'NSEC') continue;
    questions.push({ name, type, ...(cls & 0x8000 ? { unicast: true } : {}) });
  }
  const read = (n: number) => Array.from({ length: n }, () => readRecord(r));
  const answers = read(an);
  const authority = read(ns);
  const additional = read(ar);
  if (r.at !== b.length) throw new DiscoveryError('the message has bytes after its last record');
  return { id, response: !!(flags & 0x8000), ...(flags & 0x0400 ? { authoritative: true } : {}), ...(flags & 0x0200 ? { truncated: true } : {}), questions, answers, ...(authority.length ? { authority } : {}), ...(additional.length ? { additional } : {}) };
}

// ---------------------------------------------------------------- DNS-SD

export interface Service {
  /** "My Printer": one label, dots allowed. */
  readonly instance: string;
  /** "_ipp._tcp" */
  readonly type: string;
  readonly host: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly txt?: Readonly<Record<string, string | true>>;
}

const LOCAL: Name = ['local'];
const TYPE_RE = /^_[a-z0-9-]{1,15}\._(tcp|udp)$/i;
const typeName = (t: string): Name => {
  if (!TYPE_RE.test(t)) throw new DiscoveryError(`${t} is not a service type like _ipp._tcp`);
  return [...t.split('.'), ...LOCAL];
};
const instanceName = (s: Service): Name => [s.instance, ...typeName(s.type)];
const hostName = (h: string): Name => {
  const n = parseName(h.endsWith('.local') ? h : `${h}.local`);
  return n;
};

export const SERVICES_META: Name = ['_services', '_dns-sd', '_udp', 'local'];
export const TTL_HOST = 120;
export const TTL_OTHER = 4500;

/** TXT strings from attributes: "key=value", or just "key" for true. Keys are printable ASCII without "=". */
export function encodeTxt(attrs: Readonly<Record<string, string | true>> | undefined): Buffer[] {
  const out: Buffer[] = [];
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (!/^[\x20-\x3c\x3e-\x7e]{1,9}$/.test(k) && !/^[\x20-\x3c\x3e-\x7e]+$/.test(k)) throw new DiscoveryError(`${JSON.stringify(k)} is not a TXT key`);
    const b = Buffer.from(v === true ? k : `${k}=${v}`, 'utf8');
    if (b.length > 255) throw new DiscoveryError(`the TXT entry ${k} is longer than 255 bytes`);
    out.push(b);
  }
  return out;
}

export function decodeTxt(strings: readonly Buffer[]): Record<string, string | true> {
  const out: Record<string, string | true> = Object.create(null);
  const seen = new Set<string>();
  for (const s of strings) {
    if (!s.length) continue;
    const eq = s.indexOf(0x3d);
    const key = (eq < 0 ? s : s.subarray(0, eq)).toString('latin1');
    if (!key || /[^\x20-\x7e]/.test(key) || key === '__proto__') continue;
    const lc = key.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out[key] = eq < 0 ? true : s.subarray(eq + 1).toString('utf8');
  }
  return out;
}

/** The records that announce (or, with ttl 0, withdraw) a service. */
export function serviceRecords(s: Service, goodbye = false): Record_[] {
  if (!(s.port >= 1 && s.port <= 65535)) throw new DiscoveryError('a service port is 1 to 65535');
  if (!s.instance || Buffer.byteLength(s.instance) > 63) throw new DiscoveryError('an instance name is 1 to 63 bytes');
  const inst = instanceName(s);
  const host = hostName(s.host);
  const t = (n: number) => (goodbye ? 0 : n);
  return [
    { name: typeName(s.type), ttl: t(TTL_OTHER), data: { type: 'PTR', target: inst } },
    { name: inst, ttl: t(TTL_HOST), flush: true, data: { type: 'SRV', priority: 0, weight: 0, port: s.port, target: host } },
    { name: inst, ttl: t(TTL_OTHER), flush: true, data: { type: 'TXT', strings: encodeTxt(s.txt) } },
    ...s.addresses.map((a): Record_ => ({ name: host, ttl: t(TTL_HOST), flush: true, data: a.includes(':') ? { type: 'AAAA', address: a } : { type: 'A', address: a } })),
  ];
}

export const announce = (s: Service): Buffer => encodeMessage({ id: 0, response: true, authoritative: true, questions: [], answers: serviceRecords(s) });
export const goodbye = (s: Service): Buffer => encodeMessage({ id: 0, response: true, authoritative: true, questions: [], answers: serviceRecords(s, true) });
export const browse = (type: string, o: { unicast?: boolean; known?: readonly Record_[] } = {}): Buffer => encodeMessage({ id: 0, response: false, questions: [{ name: typeName(type), type: 'PTR', ...(o.unicast ? { unicast: true } : {}) }], answers: o.known ?? [] });
export const resolve = (instance: string, type: string): Buffer => encodeMessage({ id: 0, response: false, questions: [{ name: [instance, ...typeName(type)], type: 'SRV' }, { name: [instance, ...typeName(type)], type: 'TXT' }], answers: [] });

/**
 * What to answer to a query from the services this host offers. Records the asker already holds with more than
 * half their life left are left out (known-answer suppression); a question for a service type gets the service's
 * other records alongside as "additional". Returns undefined when there is nothing to say.
 */
export function answerQuery(query: Message, services: readonly Service[]): { message: Buffer; unicast: boolean } | undefined {
  if (query.response) return undefined;
  const answers: Record_[] = [];
  const additional: Record_[] = [];
  let unicast = false;
  const known = query.answers;
  const suppressed = (r: Record_) => known.some((k) => sameName(k.name, r.name) && k.data.type === r.data.type && JSON.stringify(k.data) === JSON.stringify(r.data) && k.ttl * 2 >= r.ttl);
  for (const q of query.questions) {
    for (const s of services) {
      const recs = serviceRecords(s);
      const mine = (r: Record_) => sameName(r.name, q.name) && (q.type === 'ANY' || r.data.type === q.type);
      if (sameName(q.name, SERVICES_META) && (q.type === 'PTR' || q.type === 'ANY')) {
        const r: Record_ = { name: SERVICES_META, ttl: TTL_OTHER, data: { type: 'PTR', target: typeName(s.type) } };
        if (!suppressed(r) && !answers.some((a) => JSON.stringify(a) === JSON.stringify(r))) answers.push(r);
        if (q.unicast) unicast = true;
        continue;
      }
      const hit = recs.filter(mine);
      if (!hit.length) continue;
      if (q.unicast) unicast = true;
      for (const r of hit) if (!suppressed(r) && !answers.some((a) => JSON.stringify(a) === JSON.stringify(r))) answers.push(r);
      if (hit.some((h) => h.data.type === 'PTR')) for (const r of recs) if (r.data.type !== 'PTR' && !additional.some((a) => JSON.stringify(a) === JSON.stringify(r))) additional.push(r);
    }
  }
  if (!answers.length) return undefined;
  return { message: encodeMessage({ id: 0, response: true, authoritative: true, questions: [], answers, ...(additional.length ? { additional } : {}) }), unicast };
}

// ---------------------------------------------------------------- the mDNS cache

export interface CacheEvent {
  readonly kind: 'added' | 'updated' | 'removed';
  readonly instance: string;
  readonly type: string;
}

interface Entry {
  rec: Record_;
  learned: number;
  expires: number;
  flushedAt?: number;
}

const rkey = (r: Record_) => `${keyOf(r.name)}\u0001${r.data.type}\u0001${JSON.stringify(r.data, (_k, v) => (typeof v === 'object' && v !== null && (v as { type?: string }).type === 'Buffer' ? Buffer.from((v as { data: number[] }).data).toString('hex') : v))}`;

export class MdnsCache {
  private readonly entries = new Map<string, Entry>();
  private readonly o: { now: () => number };
  constructor(o: { now: () => number }) {
    this.o = o;
  }

  /** Takes in a response. Returns what changed. */
  ingest(m: Message): CacheEvent[] {
    if (!m.response) return [];
    const now = this.o.now();
    const before = this.snapshot();
    for (const r of [...m.answers, ...(m.additional ?? [])]) {
      if (r.data.type === 'RAW' || r.data.type === 'NSEC') continue;
      if (r.ttl === 0) {
        const e = this.entries.get(rkey(r));
        if (e) e.expires = Math.min(e.expires, now + 1000);
        continue;
      }
      if (r.flush) {
        for (const [k, e] of this.entries) if (e.rec.data.type === r.data.type && sameName(e.rec.name, r.name) && e.rec.data.type !== 'PTR' && k !== rkey(r) && now - e.learned > 1000) e.expires = Math.min(e.expires, now + 1000);
      }
      this.entries.set(rkey(r), { rec: r, learned: now, expires: now + r.ttl * 1000 });
    }
    return diff(before, this.snapshot());
  }

  /** Drops expired records; returns what disappeared. */
  expire(): CacheEvent[] {
    const before = this.snapshot();
    const now = this.o.now();
    for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
    return diff(before, this.snapshot());
  }

  private live(): Entry[] {
    const now = this.o.now();
    return [...this.entries.values()].filter((e) => e.expires > now);
  }

  private snapshot(): Map<string, string> {
    return new Map(this.services().map((s) => [`${s.type}|${s.instance}`, JSON.stringify(s)]));
  }

  /** Complete services (a pointer, an SRV and its addresses), optionally of one type. */
  services(type?: string): Service[] {
    const live = this.live().map((e) => e.rec);
    const out: Service[] = [];
    for (const ptr of live.filter((r) => r.data.type === 'PTR')) {
      const t = (ptr.data as { target: Name }).target;
      const typeLabels = ptr.name;
      if (!endsWith(typeLabels, LOCAL) || typeLabels.length !== 3) continue;
      const tstr = typeLabels.slice(0, 2).join('.');
      if (type && tstr.toLowerCase() !== type.toLowerCase()) continue;
      if (t.length !== 4 || !sameName(t.slice(1), typeLabels)) continue;
      const srv = live.find((r) => r.data.type === 'SRV' && sameName(r.name, t));
      if (!srv) continue;
      const sd = srv.data as Extract<RData, { type: 'SRV' }>;
      const txt = live.find((r) => r.data.type === 'TXT' && sameName(r.name, t));
      const addresses = live.filter((r) => (r.data.type === 'A' || r.data.type === 'AAAA') && sameName(r.name, sd.target)).map((r) => (r.data as { address: string }).address).sort();
      const attrs = txt ? decodeTxt((txt.data as Extract<RData, { type: 'TXT' }>).strings) : {};
      out.push({ instance: t[0]!, type: tstr, host: nameToString(sd.target), port: sd.port, addresses, ...(Object.keys(attrs).length ? { txt: attrs } : {}) });
    }
    return out.sort((a, b) => a.instance.localeCompare(b.instance));
  }

  /** Questions to send now to refresh records past 80, 85, 90 or 95 percent of their life. */
  refreshDue(): Question[] {
    const now = this.o.now();
    const out = new Map<string, Question>();
    for (const e of this.live()) {
      const life = e.expires - e.learned;
      const age = now - e.learned;
      if (life <= 0 || age < life * 0.8) continue;
      const t = e.rec.data.type;
      if (t === 'A' || t === 'AAAA' || t === 'PTR' || t === 'SRV' || t === 'TXT') out.set(`${keyOf(e.rec.name)}|${t}`, { name: e.rec.name, type: t });
    }
    return [...out.values()];
  }
}

function diff(before: Map<string, string>, after: Map<string, string>): CacheEvent[] {
  const ev: CacheEvent[] = [];
  for (const [k, v] of after) {
    const [type, instance] = k.split('|') as [string, string];
    if (!before.has(k)) ev.push({ kind: 'added', instance, type });
    else if (before.get(k) !== v) ev.push({ kind: 'updated', instance, type });
  }
  for (const k of before.keys()) if (!after.has(k)) { const [type, instance] = k.split('|') as [string, string]; ev.push({ kind: 'removed', instance, type }); }
  return ev;
}

// ---------------------------------------------------------------- SSDP

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
const MAX_SSDP = 1500;
const MAX_HEADERS = 40;

export type SsdpMessage =
  | { readonly kind: 'm-search'; readonly st: string; readonly mx: number; readonly userAgent?: string }
  | { readonly kind: 'notify'; readonly nts: 'ssdp:alive' | 'ssdp:byebye' | 'ssdp:update'; readonly nt: string; readonly usn: string; readonly location?: string; readonly maxAge?: number; readonly server?: string; readonly bootId?: number }
  | { readonly kind: 'response'; readonly st: string; readonly usn: string; readonly location: string; readonly maxAge: number; readonly server?: string };

const noBreaks = (s: string, what: string) => {
  if (/[\r\n\0]/.test(s)) throw new DiscoveryError(`${what} has a line break`);
  return s;
};

export function msearch(st: string, mx = 2, userAgent?: string): Buffer {
  if (!Number.isInteger(mx) || mx < 1 || mx > 5) throw new DiscoveryError('MX is 1 to 5 seconds');
  return Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', `MX: ${mx}`, `ST: ${noBreaks(st, 'ST')}`, ...(userAgent ? [`USER-AGENT: ${noBreaks(userAgent, 'USER-AGENT')}`] : []), '', ''].join('\r\n'));
}

export function notify(n: { nts: 'ssdp:alive' | 'ssdp:byebye' | 'ssdp:update'; nt: string; usn: string; location?: string; maxAge?: number; server?: string; bootId?: number }): Buffer {
  if (n.nts !== 'ssdp:byebye' && (!n.location || !n.maxAge)) throw new DiscoveryError('an alive or update notice needs LOCATION and a max-age');
  return Buffer.from([
    'NOTIFY * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, ...(n.maxAge ? [`CACHE-CONTROL: max-age=${n.maxAge}`] : []), ...(n.location ? [`LOCATION: ${noBreaks(n.location, 'LOCATION')}`] : []),
    `NT: ${noBreaks(n.nt, 'NT')}`, `NTS: ${n.nts}`, ...(n.server ? [`SERVER: ${noBreaks(n.server, 'SERVER')}`] : []), `USN: ${noBreaks(n.usn, 'USN')}`, ...(n.bootId !== undefined ? [`BOOTID.UPNP.ORG: ${n.bootId}`] : []), '', '',
  ].join('\r\n'));
}

export function searchResponse(r: { st: string; usn: string; location: string; maxAge: number; server?: string }): Buffer {
  return Buffer.from(['HTTP/1.1 200 OK', `CACHE-CONTROL: max-age=${r.maxAge}`, 'EXT:', `LOCATION: ${noBreaks(r.location, 'LOCATION')}`, ...(r.server ? [`SERVER: ${noBreaks(r.server, 'SERVER')}`] : []), `ST: ${noBreaks(r.st, 'ST')}`, `USN: ${noBreaks(r.usn, 'USN')}`, '', ''].join('\r\n'));
}

function parseMaxAge(v: string | undefined): number | undefined {
  const m = v && /(?:^|[,\s])max-age\s*=\s*(\d{1,9})(?:$|[,\s])/i.exec(v);
  return m ? Number(m[1]) : undefined;
}

export function parseSsdp(buf: Uint8Array): SsdpMessage {
  if (buf.length > MAX_SSDP) throw new DiscoveryError('an SSDP packet is at most 1500 bytes');
  const text = Buffer.from(buf).toString('utf8');
  const end = text.indexOf('\r\n\r\n');
  const lines = (end < 0 ? text : text.slice(0, end)).split('\r\n');
  const start = lines.shift() ?? '';
  if (lines.length > MAX_HEADERS) throw new DiscoveryError('too many SSDP headers');
  const h = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 1 || /[\x00-\x1f]/.test(l)) throw new DiscoveryError('an SSDP header line is not valid');
    const k = l.slice(0, i).trim().toLowerCase();
    if (h.has(k)) throw new DiscoveryError(`the header ${k} appears twice`);
    h.set(k, l.slice(i + 1).trim());
  }
  const need = (k: string) => {
    const v = h.get(k);
    if (!v) throw new DiscoveryError(`the ${k.toUpperCase()} header is missing`);
    return v;
  };
  if (/^M-SEARCH \* HTTP\/1\.1$/i.test(start)) {
    if (need('man') !== '"ssdp:discover"') throw new DiscoveryError('MAN must be "ssdp:discover"');
    const mx = Number(need('mx'));
    if (!Number.isInteger(mx) || mx < 1) throw new DiscoveryError('MX is a whole number of seconds');
    return { kind: 'm-search', st: need('st'), mx: Math.min(mx, 5), ...(h.get('user-agent') ? { userAgent: h.get('user-agent')! } : {}) };
  }
  if (/^NOTIFY \* HTTP\/1\.1$/i.test(start)) {
    const nts = need('nts');
    if (nts !== 'ssdp:alive' && nts !== 'ssdp:byebye' && nts !== 'ssdp:update') throw new DiscoveryError(`NTS ${nts.slice(0, 20)} is not known`);
    const maxAge = parseMaxAge(h.get('cache-control'));
    if (nts !== 'ssdp:byebye' && (maxAge === undefined || !h.get('location'))) throw new DiscoveryError('an alive notice needs CACHE-CONTROL max-age and LOCATION');
    const boot = h.get('bootid.upnp.org');
    return { kind: 'notify', nts, nt: need('nt'), usn: need('usn'), ...(h.get('location') ? { location: h.get('location')! } : {}), ...(maxAge !== undefined ? { maxAge } : {}), ...(h.get('server') ? { server: h.get('server')! } : {}), ...(boot && /^\d+$/.test(boot) ? { bootId: Number(boot) } : {}) };
  }
  if (/^HTTP\/1\.1 200 OK$/i.test(start)) {
    const maxAge = parseMaxAge(h.get('cache-control'));
    if (maxAge === undefined) throw new DiscoveryError('a search response needs CACHE-CONTROL max-age');
    return { kind: 'response', st: need('st'), usn: need('usn'), location: need('location'), maxAge, ...(h.get('server') ? { server: h.get('server')! } : {}) };
  }
  throw new DiscoveryError('that is not an M-SEARCH, NOTIFY or search response');
}

/** A LOCATION that is safe to fetch: http or https, no credentials, and on the machine that sent the message. */
export function checkLocation(location: string, senderIp: string): URL {
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    throw new DiscoveryError('LOCATION is not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DiscoveryError('LOCATION must be http or https');
  if (u.username || u.password) throw new DiscoveryError('LOCATION has no credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== senderIp.toLowerCase()) throw new DiscoveryError('LOCATION points at a different machine than the one that sent it');
  return u;
}

export interface Device {
  readonly usn: string;
  readonly nt: string;
  readonly location: string;
  readonly server?: string;
  readonly seenAt: number;
  readonly expiresAt: number;
  readonly bootId?: number;
}

export class SsdpCache {
  private readonly devices = new Map<string, Device>();
  private readonly o: { now: () => number; allowOtherHosts?: boolean };
  constructor(o: { now: () => number; allowOtherHosts?: boolean }) {
    this.o = o;
  }

  /** Takes in a notice or response from a sender; returns what happened. */
  ingest(msg: SsdpMessage, senderIp: string): { kind: 'added' | 'updated' | 'removed' | 'ignored'; usn?: string } {
    const now = this.o.now();
    if (msg.kind === 'm-search') return { kind: 'ignored' };
    const usn = msg.usn;
    if (msg.kind === 'notify' && msg.nts === 'ssdp:byebye') return this.devices.delete(usn) ? { kind: 'removed', usn } : { kind: 'ignored', usn };
    const location = msg.location;
    if (!location || msg.maxAge === undefined) return { kind: 'ignored' };
    if (!this.o.allowOtherHosts) checkLocation(location, senderIp);
    else checkLocation(new URL(location).href.replace(/^(https?:\/\/)[^/]+/, `$1${senderIp.includes(':') ? `[${senderIp}]` : senderIp}`), senderIp);
    const had = this.devices.get(usn);
    const nt = msg.kind === 'notify' ? msg.nt : msg.st;
    const d: Device = { usn, nt, location, seenAt: now, expiresAt: now + Math.min(msg.maxAge, 86_400) * 1000, ...(msg.server ? { server: msg.server } : {}), ...(msg.kind === 'notify' && msg.bootId !== undefined ? { bootId: msg.bootId } : {}) };
    this.devices.set(usn, d);
    return { kind: had ? 'updated' : 'added', usn };
  }

  expire(): string[] {
    const now = this.o.now();
    const gone: string[] = [];
    for (const [k, d] of this.devices) if (d.expiresAt <= now) { this.devices.delete(k); gone.push(k); }
    return gone;
  }

  /** Live devices, optionally those matching a search target ("ssdp:all" is everything). */
  find(st = 'ssdp:all'): Device[] {
    const now = this.o.now();
    return [...this.devices.values()].filter((d) => d.expiresAt > now && (st === 'ssdp:all' || d.nt === st || (st === 'upnp:rootdevice' && d.nt === st))).sort((a, b) => a.usn.localeCompare(b.usn));
  }
}

/** Whether a device answers a search target (ssdp:all, rootdevice, a device or service type, or its own uuid). */
export function matchesSearch(st: string, deviceUuid: string, types: readonly string[]): string[] {
  if (st === 'ssdp:all') return [`uuid:${deviceUuid}`, 'upnp:rootdevice', ...types];
  if (st === 'upnp:rootdevice') return ['upnp:rootdevice'];
  if (st === `uuid:${deviceUuid}`) return [st];
  return types.includes(st) ? [st] : [];
}
