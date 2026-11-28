/**
 * Uptime probes: the checks a monitor runs against a service and how it decides what they mean.
 *
 * Six probe types, all described as data: an HTTP probe (status, response time), a keyword probe (text that must,
 * or must not, be in the page), a JSON probe (a value found by a safe path in the answer), a TCP probe (a port
 * answers), a DNS probe (records are what they should be) and a certificate probe (days left, the name it covers,
 * an optional pinned fingerprint). Each runs behind a `Transport` interface; the twin in this file plays scripted
 * answers so every path can be tested without a network. A failed check is retried with jittered backoff (the
 * resilience block) before it counts, and each check ends within its timeout.
 *
 * What the checks mean is decided by the Monitor, not by one bad answer: a probe goes down only after several
 * failures in a row and comes back only after several successes, one that keeps flipping is called "flapping" and
 * its state is held instead of announced each time, and a maintenance window (the health block's windows) records
 * checks but never counts, announces or holds them against uptime. The monitor reports uptime, response-time
 * percentiles and incidents, and its confirmed states feed the health block's status page.
 *
 * Safe by default: a probe may not point at loopback, private, link-local, cloud-metadata or other non-public
 * addresses, or at names that are plainly internal, in any spelling (decimal, hex, IPv6-mapped), unless the
 * monitor is told it may; a transport must check again the address it actually connects to, since a name can
 * change its answer between the check and the connection. Keyword and JSON checks never use patterns, so a hostile
 * page cannot make them slow, and JSON paths cannot reach the prototype. Response bodies are size-limited.
 *
 * Out of scope: the transport that opens real sockets (HTTP, TCP, UDP DNS, TLS), alert delivery (the monitor calls
 * `onEvent`), and recurring maintenance schedules (give it dated windows).
 */
import { createHash } from 'node:crypto';
import { equal } from '../crypto/index.ts';
import { maintenance as maintenanceState, type Component, type Maintenance } from '../health/index.ts';
import { retry, TimedOut, withTimeout, type RetryPolicy } from '../resilience/index.ts';

export class ProbeError extends Error {}

export type Status = 'up' | 'degraded' | 'down';
const DAY = 86_400_000;

// ---------------------------------------------------------------- addresses

function v4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return p.every((n) => n <= 255) ? p : null;
}

function v6(s: string): number[] | null {
  let t = s.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = t.indexOf('%');
  if (zone >= 0) t = t.slice(0, zone);
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (tail) {
    const q = v4(tail[1]!);
    if (!q) return null;
    t = t.slice(0, t.length - tail[1]!.length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(t) || (t.match(/::/g) ?? []).length > 1) return null;
  const [head, rest] = t.includes('::') ? t.split('::') as [string, string] : [t, null];
  const a = head === '' ? [] : head.split(':');
  const b = rest === null || rest === '' ? [] : rest.split(':');
  const fill = rest === null ? 0 : 8 - a.length - b.length;
  if (fill < 0 || (rest === null && a.length !== 8)) return null;
  const parts = [...a, ...Array<string>(fill).fill('0'), ...b];
  if (parts.length !== 8 || parts.some((x) => x.length < 1 || x.length > 4)) return null;
  return parts.map((x) => parseInt(x, 16));
}

function privateV4([a, b]: [number, number, number, number]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** True for any address that is not an ordinary public one, and for anything that cannot be read as an address. */
export function isPrivateAddress(ip: string): boolean {
  const four = v4(ip);
  if (four) return privateV4(four);
  const h = v6(ip);
  if (!h) return true;
  const embedded = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    if (h.slice(0, 7).every((x) => x === 0) && h[7]! <= 1) return true;
    return privateV4(embedded(h[6]!, h[7]!));
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return privateV4(embedded(h[6]!, h[7]!));
  if (h[0] === 0x2002) return privateV4(embedded(h[1]!, h[2]!));
  if ((h[0]! & 0xfe00) === 0xfc00 || (h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xff00) === 0xff00) return true;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  return false;
}

function assertPublicHost(host: string, what: string): string {
  let u: URL;
  try {
    u = new URL(`http://${host}/`);
  } catch {
    throw new ProbeError(`"${host}" is not a valid host for ${what}`);
  }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || !u.hostname) throw new ProbeError(`"${host}" is not a valid host for ${what}`);
  const name = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isIp = v4(name) !== null || name.includes(':');
  if (isIp ? isPrivateAddress(name) : !name.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home|lan|intranet|corp)$/.test(name)) {
    throw new ProbeError(`${host} is a private or internal address, which a probe may not reach`);
  }
  return name;
}

// ---------------------------------------------------------------- transport

export interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'HEAD' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
}
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly ms: number;
  readonly finalUrl: string;
  readonly redirects: number;
  /** The body was cut at `maxBytes`. */
  readonly truncated: boolean;
}
export interface CertInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly validFrom: number;
  readonly validTo: number;
  readonly altNames: readonly string[];
  readonly fingerprint256: string;
}
export type DnsType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';

/** What a probe needs from the outside world. A real transport must check the address it connects to against `isPrivateAddress`. */
export interface Transport {
  http(r: HttpRequest, signal: AbortSignal): Promise<HttpResponse>;
  tcp(host: string, port: number, signal: AbortSignal): Promise<{ ms: number }>;
  dns(host: string, type: DnsType, signal: AbortSignal): Promise<{ records: readonly string[]; ms: number }>;
  cert(host: string, port: number, signal: AbortSignal): Promise<{ cert: CertInfo; ms: number }>;
}

type Kind = 'http' | 'tcp' | 'dns' | 'cert';
export type TwinOutcome = object | Error | 'hang' | ((call: { kind: Kind; target: string }) => object | Error | Promise<object | Error>);

/** A scripted transport: each call takes the next scripted outcome for its target, and the last one repeats. */
export class TwinTransport implements Transport {
  readonly calls: { kind: Kind; target: string }[] = [];
  private readonly scripts = new Map<string, { outs: TwinOutcome[]; i: number }>();
  /** Replace what a target answers. Targets: an http url, "host:port", "host/TYPE" for dns. */
  script(kind: Kind, target: string, ...outs: TwinOutcome[]): void {
    this.scripts.set(`${kind}\0${target}`, { outs, i: 0 });
  }
  private async next(kind: Kind, target: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.calls.push({ kind, target });
    const s = this.scripts.get(`${kind}\0${target}`);
    if (!s || s.outs.length === 0) throw new Error(`the twin has nothing scripted for ${target}`);
    const o = s.outs[Math.min(s.i++, s.outs.length - 1)]!;
    const v = typeof o === 'function' ? await o({ kind, target }) : o;
    if (v === 'hang') return new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('aborted'))));
    if (v instanceof Error) throw v;
    return v as Record<string, unknown>;
  }
  async http(r: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    const o = await this.next('http', r.url, signal);
    return { status: 200, headers: {}, body: '', ms: 50, finalUrl: r.url, redirects: 0, truncated: false, ...o };
  }
  async tcp(host: string, port: number, signal: AbortSignal) {
    return { ms: 10, ...(await this.next('tcp', `${host}:${port}`, signal)) };
  }
  async dns(host: string, type: DnsType, signal: AbortSignal) {
    return { records: [] as string[], ms: 10, ...(await this.next('dns', `${host}/${type}`, signal)) };
  }
  async cert(host: string, port: number, signal: AbortSignal) {
    const o = await this.next('cert', `${host}:${port}`, signal);
    if (!o['cert']) throw new Error(`the twin has no certificate scripted for ${host}:${port}`);
    return { ms: 10, ...o } as { cert: CertInfo; ms: number };
  }
}

// ---------------------------------------------------------------- definitions

export type JsonExpect = { readonly equals: string | number | boolean | null } | { readonly exists: boolean } | { readonly gt: number } | { readonly lt: number } | { readonly contains: string };

interface Common {
  readonly id: string;
  readonly name?: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  /** Extra tries after a failed check before it counts (default 1). */
  readonly retries?: number;
  /** Slower than this is "degraded". */
  readonly degradedMs?: number;
  /** Consecutive failures before the probe is called down (default 3). */
  readonly failuresToDown?: number;
  /** Consecutive successes before it is called up again (default 2). */
  readonly successesToUp?: number;
  readonly degradedAfter?: number;
  /** A probe that changes this many times in the last `flapWindow` checks is flapping (defaults 8 in 10). */
  readonly flapWindow?: number;
  readonly flapTransitions?: number;
}
interface WebCommon extends Common {
  readonly url: string;
  readonly method?: 'GET' | 'HEAD' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Accepted statuses: 200, or "2xx" (default 2xx and 3xx). */
  readonly expectStatus?: readonly (number | string)[];
  readonly maxRedirects?: number;
}
export type ProbeDef =
  | ({ readonly type: 'http' } & WebCommon)
  | ({ readonly type: 'keyword'; readonly keyword: string; readonly invert?: boolean; readonly caseSensitive?: boolean } & WebCommon)
  | ({ readonly type: 'json'; readonly query: string; readonly expect: JsonExpect } & WebCommon)
  | ({ readonly type: 'tcp'; readonly host: string; readonly port: number } & Common)
  | ({ readonly type: 'dns'; readonly host: string; readonly record: DnsType; readonly expect?: readonly string[]; readonly exact?: boolean } & Common)
  | ({ readonly type: 'cert'; readonly host: string; readonly port?: number; readonly warnDays?: number; readonly failDays?: number; readonly pin?: string } & Common);

export interface ProbeResult {
  readonly probe: string;
  readonly at: number;
  readonly status: Status;
  readonly ms: number;
  readonly message: string;
  readonly attempts: number;
  /** The check fell in a maintenance window and counts for nothing. */
  readonly maintenance: boolean;
}

// ---------------------------------------------------------------- json paths

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const safeKey = (k: string) => {
  if (UNSAFE.has(k)) throw new ProbeError(`the path may not use "${k}"`);
  return k;
};

function parsePath(p: string): (string | number)[] {
  const bad = () => new ProbeError(`"${p}" is not a valid path`);
  if (typeof p !== 'string' || p === '' || p.length > 200) throw bad();
  const segs: (string | number)[] = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === '[') {
      const close = p.indexOf(']', i);
      if (close < 0) throw bad();
      const inner = p.slice(i + 1, close);
      if (/^\d{1,9}$/.test(inner)) segs.push(Number(inner));
      else {
        const m = /^(["'])([^"']+)\1$/.exec(inner);
        if (!m) throw bad();
        segs.push(safeKey(m[2]!));
      }
      i = close + 1;
    } else {
      if (p[i] === '.') {
        if (segs.length === 0) throw bad();
        i++;
      } else if (segs.length > 0) throw bad();
      const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(p.slice(i));
      if (!m) throw bad();
      segs.push(safeKey(m[0]));
      i += m[0].length;
    }
  }
  if (segs.length > 20) throw new ProbeError('that path is too deep');
  return segs;
}

/** Read a value by a path like `data.items[0]["name"]`. Only own fields of objects and indexes of arrays are followed. */
export function queryJson(root: unknown, path: string): { found: true; value: unknown } | { found: false } {
  let cur = root;
  for (const s of parsePath(path)) {
    if (typeof s === 'number') {
      if (!Array.isArray(cur) || s >= cur.length) return { found: false };
      cur = cur[s];
    } else {
      if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !Object.hasOwn(cur, s)) return { found: false };
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return { found: true, value: cur };
}

// ---------------------------------------------------------------- certificates

/** Does a certificate name cover the host? A wildcard covers exactly one whole left-most label (RFC 6125). */
export function matchesHost(host: string, names: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return names.some((raw) => {
    const n = raw.toLowerCase().replace(/\.$/, '');
    if (!n.startsWith('*.')) return n === h;
    const base = n.slice(2);
    if (!base.includes('.')) return false;
    const dot = h.indexOf('.');
    return dot > 0 && h.slice(dot + 1) === base;
  });
}

// ---------------------------------------------------------------- running one probe

const MAX_BODY = 1_048_576;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

class Down extends Error {
  readonly result: Omit<ProbeResult, 'attempts'>;
  constructor(result: Omit<ProbeResult, 'attempts'>) {
    super(result.message);
    this.result = result;
  }
}

function statusOk(def: WebCommon, code: number): boolean {
  const want = def.expectStatus ?? ['2xx', '3xx'];
  return want.some((w) => (typeof w === 'number' ? w === code : Math.floor(code / 100) === Number(w[0])));
}

function judgeHttp(def: ProbeDef & WebCommon, r: HttpResponse): { status: Status; message: string } {
  if (!statusOk(def, r.status)) return { status: 'down', message: `got ${r.status}, expected ${(def.expectStatus ?? ['2xx', '3xx']).join(', ')}` };
  let said = `${r.status} in ${r.ms} ms`;
  if (def.type === 'keyword') {
    const hay = def.caseSensitive ? r.body : r.body.toLowerCase();
    const needle = def.caseSensitive ? def.keyword : def.keyword.toLowerCase();
    const has = hay.includes(needle);
    if (def.invert && has) return { status: 'down', message: `the page contains "${def.keyword}", which it must not` };
    if (!def.invert && !has) return { status: 'down', message: `the page does not contain "${def.keyword}"` };
  } else if (def.type === 'json') {
    if (r.truncated) return { status: 'down', message: 'the answer was too large to check' };
    let doc: unknown;
    try {
      doc = JSON.parse(r.body);
    } catch {
      return { status: 'down', message: 'the answer is not valid JSON' };
    }
    const q = queryJson(doc, def.query);
    const e = def.expect;
    if ('exists' in e) {
      if (q.found !== e.exists) return { status: 'down', message: `${def.query} ${q.found ? 'exists' : 'was not found'}, expected ${e.exists ? 'it to exist' : 'it to be missing'}` };
    } else if (!q.found) return { status: 'down', message: `${def.query} was not found` };
    else {
      const v = q.value;
      const shown = JSON.stringify(v);
      if ('equals' in e && v !== e.equals) return { status: 'down', message: `${def.query} is ${shown}, expected ${JSON.stringify(e.equals)}` };
      if ('gt' in e && !(typeof v === 'number' && v > e.gt)) return { status: 'down', message: `${def.query} is ${shown}, expected more than ${e.gt}` };
      if ('lt' in e && !(typeof v === 'number' && v < e.lt)) return { status: 'down', message: `${def.query} is ${shown}, expected less than ${e.lt}` };
      if ('contains' in e && !((typeof v === 'string' && v.includes(e.contains)) || (Array.isArray(v) && v.includes(e.contains)))) return { status: 'down', message: `${def.query} is ${shown}, expected it to contain ${JSON.stringify(e.contains)}` };
    }
    said = `${def.query} checked, ${said}`;
  }
  if (def.degradedMs !== undefined && r.ms >= def.degradedMs) return { status: 'degraded', message: `${said}, slower than the ${def.degradedMs} ms limit` };
  return { status: 'up', message: said };
}

const normRecord = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

async function once(def: ProbeDef, t: Transport, now: number, signal: AbortSignal): Promise<{ status: Status; ms: number; message: string }> {
  switch (def.type) {
    case 'http':
    case 'keyword':
    case 'json': {
      const r = await t.http({ url: def.url, method: def.method ?? 'GET', headers: { 'user-agent': 'uptime-probe/1', ...(def.headers ?? {}) }, ...(def.body !== undefined ? { body: def.body } : {}), timeoutMs: def.timeoutMs, maxBytes: MAX_BODY, maxRedirects: def.maxRedirects ?? 5 }, signal);
      return { ...judgeHttp(def, r), ms: r.ms };
    }
    case 'tcp': {
      let r: { ms: number };
      try {
        r = await t.tcp(def.host, def.port, signal);
      } catch (e) {
        if (e instanceof TimedOut) throw e;
        return { status: 'down', ms: 0, message: `could not connect: ${msg(e)}` };
      }
      if (def.degradedMs !== undefined && r.ms >= def.degradedMs) return { status: 'degraded', ms: r.ms, message: `connected in ${r.ms} ms, slower than the ${def.degradedMs} ms limit` };
      return { status: 'up', ms: r.ms, message: `connected in ${r.ms} ms` };
    }
    case 'dns': {
      let r: { records: readonly string[]; ms: number };
      try {
        r = await t.dns(def.host, def.record, signal);
      } catch (e) {
        if (e instanceof TimedOut) throw e;
        return { status: 'down', ms: 0, message: `lookup failed: ${msg(e)}` };
      }
      const got = r.records.map(normRecord);
      if (got.length === 0) return { status: 'down', ms: r.ms, message: 'no records came back' };
      const want = (def.expect ?? []).map(normRecord);
      const missing = want.filter((w) => !got.includes(w));
      if (missing.length) return { status: 'down', ms: r.ms, message: `missing ${missing.join(', ')} (got ${got.join(', ')})` };
      const extra = def.exact ? got.filter((g) => !want.includes(g)) : [];
      if (extra.length) return { status: 'down', ms: r.ms, message: `unexpected ${extra.join(', ')} (wanted exactly ${want.join(', ')})` };
      return { status: def.degradedMs !== undefined && r.ms >= def.degradedMs ? 'degraded' : 'up', ms: r.ms, message: `${def.record} ${r.records.join(', ')}` };
    }
    case 'cert': {
      let r: { cert: CertInfo; ms: number };
      try {
        r = await t.cert(def.host, def.port ?? 443, signal);
      } catch (e) {
        if (e instanceof TimedOut) throw e;
        return { status: 'down', ms: 0, message: `could not read the certificate: ${msg(e)}` };
      }
      const c = r.cert;
      const down = (message: string) => ({ status: 'down' as const, ms: r.ms, message });
      if (c.validFrom > now) return down('the certificate is not valid yet');
      if (c.validTo < now) return down(`expired ${plural(Math.floor((now - c.validTo) / DAY), 'day')} ago`);
      if (!matchesHost(def.host, c.altNames)) return down(`the certificate does not cover ${def.host}`);
      if (def.pin !== undefined && !equal(c.fingerprint256.replace(/:/g, '').toUpperCase(), def.pin.replace(/:/g, '').toUpperCase())) return down('the certificate is not the pinned one');
      const days = Math.floor((c.validTo - now) / DAY);
      if (days < (def.failDays ?? 7)) return down(`expires in ${plural(days, 'day')}`);
      if (days < (def.warnDays ?? 21)) return { status: 'degraded', ms: r.ms, message: `expires in ${plural(days, 'day')}` };
      return { status: 'up', ms: r.ms, message: `valid for ${days} more days` };
    }
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run one probe: with the timeout, and retries before a failure counts. */
export async function runProbe(def: ProbeDef, t: Transport, o: { now: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number }): Promise<Omit<ProbeResult, 'maintenance'>> {
  const at = o.now();
  const policy: RetryPolicy = { attempts: (def.retries ?? 1) + 1, baseMs: 200, maxMs: 5000, retryable: (e) => e instanceof Down };
  let attempts = 0;
  const attempt = async (): Promise<Omit<ProbeResult, 'maintenance' | 'attempts'>> => {
    attempts++;
    let r: { status: Status; ms: number; message: string };
    try {
      r = await withTimeout(def.timeoutMs, (signal) => once(def, t, at, signal));
    } catch (e) {
      r = { status: 'down', ms: 0, message: msg(e) };
    }
    const res = { probe: def.id, at, ...r };
    if (res.status === 'down') throw new Down({ ...res, maintenance: false });
    return res;
  };
  try {
    const r = await retry(attempt, policy, o.sleep, o.random);
    return { ...r, attempts };
  } catch (e) {
    if (e instanceof Down) {
      const { maintenance: _m, ...rest } = e.result;
      return { ...rest, attempts };
    }
    throw e;
  }
}

// ---------------------------------------------------------------- validation

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;

function validate(def: ProbeDef, allowPrivate: boolean): void {
  if (!ID.test(def.id)) throw new ProbeError('a probe id is letters, digits, ".", "_" and "-", up to 64');
  if (!(def.intervalMs >= 10_000 && def.intervalMs <= DAY)) throw new ProbeError('the interval must be from 10 seconds to 24 hours');
  if (!(def.timeoutMs >= 50 && def.timeoutMs <= 60_000)) throw new ProbeError('the timeout must be from 50 ms to 60 s');
  if (def.timeoutMs >= def.intervalMs) throw new ProbeError('the timeout must be shorter than the interval');
  if (def.retries !== undefined && !(Number.isInteger(def.retries) && def.retries >= 0 && def.retries <= 5)) throw new ProbeError('retries must be a whole number from 0 to 5');
  for (const [k, v] of [['failuresToDown', def.failuresToDown], ['successesToUp', def.successesToUp], ['degradedAfter', def.degradedAfter], ['flapWindow', def.flapWindow], ['flapTransitions', def.flapTransitions]] as const) {
    if (v !== undefined && !(Number.isInteger(v) && v >= 1 && v <= 100)) throw new ProbeError(`${k} must be a whole number from 1 to 100`);
  }
  if (def.degradedMs !== undefined && !(def.degradedMs > 0)) throw new ProbeError('degradedMs must be above zero');
  const host = (h: string, what: string) => {
    if (!allowPrivate) assertPublicHost(h, what);
  };
  if (def.type === 'http' || def.type === 'keyword' || def.type === 'json') {
    let u: URL;
    try {
      u = new URL(def.url);
    } catch {
      throw new ProbeError('that is not a web address');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProbeError('a probe address must be http or https');
    if (u.username || u.password) throw new ProbeError('an address with a name and password in it is not allowed');
    host(u.host, 'a probe');
    if (def.method !== undefined && !['GET', 'HEAD', 'POST'].includes(def.method)) throw new ProbeError('the method must be GET, HEAD or POST');
    for (const s of def.expectStatus ?? []) if (!(typeof s === 'number' ? Number.isInteger(s) && s >= 100 && s <= 599 : /^[1-5]xx$/.test(s))) throw new ProbeError(`the status ${JSON.stringify(s)} is not a code like 200 or a class like 2xx`);
    for (const [k, v] of Object.entries(def.headers ?? {})) if (!HEADER.test(k) || /[\r\n\u0000]/.test(v) || v.length > 1000) throw new ProbeError(`the header "${k}" is not allowed`);
    if (def.body !== undefined && def.body.length > 10_000) throw new ProbeError('the body is too large');
    if (def.maxRedirects !== undefined && !(Number.isInteger(def.maxRedirects) && def.maxRedirects >= 0 && def.maxRedirects <= 10)) throw new ProbeError('maxRedirects must be from 0 to 10');
  }
  if (def.type === 'keyword' && (def.keyword === '' || def.keyword.length > 500)) throw new ProbeError('the keyword must be 1 to 500 characters');
  if (def.type === 'json') {
    parsePath(def.query);
    if (typeof def.expect !== 'object' || def.expect === null || Object.keys(def.expect).length !== 1 || !['equals', 'exists', 'gt', 'lt', 'contains'].includes(Object.keys(def.expect)[0]!)) throw new ProbeError('a JSON probe expects exactly one of equals, exists, gt, lt or contains');
  }
  if (def.type === 'tcp' || def.type === 'cert') {
    host(def.host, 'a probe');
    const port = def.type === 'tcp' ? def.port : (def.port ?? 443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProbeError('the port must be from 1 to 65535');
  }
  if (def.type === 'dns') {
    host(def.host, 'a probe');
    if (!['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].includes(def.record)) throw new ProbeError('the record must be A, AAAA, CNAME, MX, TXT or NS');
  }
  if (def.type === 'cert' && (def.failDays ?? 7) >= (def.warnDays ?? 21)) throw new ProbeError('failDays must be less than warnDays');
}

// ---------------------------------------------------------------- the monitor

export type Display = 'unknown' | Status | 'maintenance';
export interface ProbeState {
  readonly state: Display;
  /** The state the damping settled on, even during maintenance. */
  readonly confirmed: 'unknown' | Status;
  readonly since: number | null;
  readonly flapping: boolean;
  readonly maintenance: 'none' | 'notice' | 'active';
  readonly last: ProbeResult | null;
}
export interface Transition {
  readonly at: number;
  readonly probe: string;
  readonly kind: 'state' | 'flapping-started' | 'flapping-ended';
  readonly from: 'unknown' | Status;
  readonly to: 'unknown' | Status;
  readonly reason: string;
}
export interface MaintenanceWindow extends Maintenance {
  /** Probe ids it covers; all probes when left out. */
  readonly probes?: readonly string[];
}
export interface Uptime {
  readonly from: number;
  readonly to: number;
  readonly checks: number;
  readonly up: number;
  readonly degraded: number;
  readonly down: number;
  readonly maintenance: number;
  /** Share of counted checks that were not down, or null with no checks. */
  readonly availability: number | null;
  readonly avgMs: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly incidents: { from: number; to: number | null }[];
}

interface P {
  def: ProbeDef;
  addedAt: number;
  results: ProbeResult[];
  confirmed: 'unknown' | Status;
  since: number | null;
  streak: { status: Status; n: number } | null;
  recent: Status[];
  flapping: boolean;
  inflight: boolean;
  events: Transition[];
}

export interface MonitorOptions {
  readonly transport: Transport;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onEvent?: (e: Transition) => void;
  readonly maintenance?: readonly MaintenanceWindow[];
  /** Let probes reach private addresses (a monitor inside the network it watches). */
  readonly allowPrivate?: boolean;
  /** Results kept per probe (default 10,000). */
  readonly historySize?: number;
  /** Probes checked at the same time by `tick` (default 4). */
  readonly concurrency?: number;
}

export class Monitor {
  private readonly o: MonitorOptions;
  private readonly probes = new Map<string, P>();
  constructor(o: MonitorOptions) {
    this.o = o;
  }

  private get(id: string): P {
    const p = this.probes.get(id);
    if (!p) throw new ProbeError(`no probe "${id}"`);
    return p;
  }

  add(def: ProbeDef): void {
    validate(def, this.o.allowPrivate ?? false);
    if (this.probes.has(def.id)) throw new ProbeError(`probe "${def.id}" already exists`);
    this.probes.set(def.id, { def, addedAt: this.o.now(), results: [], confirmed: 'unknown', since: null, streak: null, recent: [], flapping: false, inflight: false, events: [] });
  }

  remove(id: string): void {
    this.get(id);
    this.probes.delete(id);
  }

  ids(): string[] {
    return [...this.probes.keys()];
  }

  private phase(p: P, now: number): 'none' | 'notice' | 'active' {
    const mine = (this.o.maintenance ?? []).filter((w) => !w.probes || w.probes.includes(p.def.id));
    return maintenanceState(mine, now).phase;
  }

  state(id: string): ProbeState {
    const p = this.get(id);
    const m = this.phase(p, this.o.now());
    return { state: m === 'active' ? 'maintenance' : p.confirmed, confirmed: p.confirmed, since: p.since, flapping: p.flapping, maintenance: m, last: p.results.at(-1) ?? null };
  }

  history(id: string): readonly ProbeResult[] {
    return [...this.get(id).results];
  }

  /** When this probe next wants a check: its interval after the last one; the first is staggered across the interval. */
  nextDue(id: string): number {
    const p = this.get(id);
    const last = p.results.at(-1);
    if (last) return last.at + p.def.intervalMs;
    return p.addedAt + (createHash('sha256').update(id).digest().readUInt32BE(0) % p.def.intervalMs);
  }

  private emit(p: P, e: Transition): void {
    p.events.push(e);
    if (p.events.length > 1000) p.events.shift();
    this.o.onEvent?.(e);
  }

  /** Run one check now and fold it into the probe's state. */
  async check(id: string): Promise<{ result: ProbeResult; state: ProbeState }> {
    const p = this.get(id);
    if (p.inflight) throw new ProbeError(`probe "${id}" is already being checked`);
    p.inflight = true;
    try {
      const raw = await runProbe(p.def, this.o.transport, { now: this.o.now, ...(this.o.sleep ? { sleep: this.o.sleep } : {}), ...(this.o.random ? { random: this.o.random } : {}) });
      const phase = this.phase(p, raw.at);
      const result: ProbeResult = { ...raw, maintenance: phase === 'active' };
      p.results.push(result);
      if (p.results.length > (this.o.historySize ?? 10_000)) p.results.shift();
      if (phase === 'active') p.streak = null;
      else this.fold(p, result);
      return { result, state: this.state(id) };
    } finally {
      p.inflight = false;
    }
  }

  private fold(p: P, r: ProbeResult): void {
    const d = p.def;
    p.recent.push(r.status);
    const window = d.flapWindow ?? 10;
    while (p.recent.length > window) p.recent.shift();
    p.streak = p.streak && p.streak.status === r.status ? { status: r.status, n: p.streak.n + 1 } : { status: r.status, n: 1 };
    const flips = p.recent.reduce((n, s, i) => n + (i > 0 && s !== p.recent[i - 1] ? 1 : 0), 0);
    const limit = d.flapTransitions ?? 8;
    if (!p.flapping && flips >= limit) {
      p.flapping = true;
      this.emit(p, { at: r.at, probe: d.id, kind: 'flapping-started', from: p.confirmed, to: p.confirmed, reason: `${flips} changes in the last ${p.recent.length} checks` });
    } else if (p.flapping && flips < Math.ceil(limit / 2)) {
      p.flapping = false;
      this.emit(p, { at: r.at, probe: d.id, kind: 'flapping-ended', from: p.confirmed, to: p.confirmed, reason: `${flips} changes in the last ${p.recent.length} checks` });
    }
    if (p.flapping) return;
    const need = r.status === 'down' ? (d.failuresToDown ?? 3) : r.status === 'up' ? (d.successesToUp ?? 2) : (d.degradedAfter ?? 2);
    if (p.confirmed === r.status) return;
    if (p.confirmed === 'unknown' || p.streak.n >= need) {
      const from = p.confirmed;
      p.confirmed = r.status;
      p.since = r.at;
      this.emit(p, { at: r.at, probe: d.id, kind: 'state', from, to: r.status, reason: r.message });
    }
  }

  /** Check every probe that is due, a few at a time. A probe already being checked is skipped. */
  async tick(): Promise<{ result: ProbeResult; state: ProbeState }[]> {
    const now = this.o.now();
    const due = [...this.probes.values()].filter((p) => !p.inflight && this.nextDue(p.def.id) <= now).map((p) => p.def.id);
    const out: { result: ProbeResult; state: ProbeState }[] = new Array(due.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= due.length) return;
        out[i] = await this.check(due[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency ?? 4, due.length) }, worker));
    return out;
  }

  uptime(id: string, from: number, to: number): Uptime {
    const p = this.get(id);
    const rs = p.results.filter((r) => r.at >= from && r.at < to);
    const count = (s: Status) => rs.filter((r) => !r.maintenance && r.status === s).length;
    const up = count('up');
    const degraded = count('degraded');
    const down = count('down');
    const counted = up + degraded + down;
    const ms = rs.filter((r) => !r.maintenance && r.status !== 'down').map((r) => r.ms).sort((a, b) => a - b);
    const rank = (q: number) => (ms.length ? ms[Math.max(0, Math.ceil(q * ms.length) - 1)]! : null);
    const incidents: { from: number; to: number | null }[] = [];
    let open: number | null = null;
    for (const e of p.events) {
      if (e.kind !== 'state') continue;
      if (e.to === 'down') open = e.at;
      else if (open !== null) {
        incidents.push({ from: open, to: e.at });
        open = null;
      }
    }
    if (open !== null) incidents.push({ from: open, to: null });
    return {
      from,
      to,
      checks: rs.length,
      up,
      degraded,
      down,
      maintenance: rs.filter((r) => r.maintenance).length,
      availability: counted ? (up + degraded) / counted : null,
      avgMs: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null,
      p50: rank(0.5),
      p95: rank(0.95),
      incidents: incidents.filter((i) => i.from < to && (i.to === null || i.to > from)),
    };
  }

  /** The probes' confirmed states in the shape the health block's status page takes. */
  components(): Component[] {
    return [...this.probes.values()]
      .filter((p) => p.confirmed !== 'unknown')
      .map((p) => ({ name: p.def.name ?? p.def.id, status: p.confirmed === 'up' ? ('ok' as const) : (p.confirmed as 'degraded' | 'down') }));
  }
}
