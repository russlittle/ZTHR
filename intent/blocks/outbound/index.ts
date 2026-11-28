/**
 * The one door to the network. App code never calls fetch itself: it asks the door, naming the purpose of the call
 * ("weather.forecast", "webhook.deliver"), and the door sends it only when the host is on the allow-list the app
 * declared, the purpose is one that host is declared for, and the address is public https. Every call, sent or
 * refused, leaves one record (purpose, host, path, status, bytes, how long) with query values, credentials and
 * auth headers left out, so what an app talks to can be listed and audited.
 *
 * Refused outright: plain http, user:password in the address, ports not declared, IP literals unless declared,
 * loopback/private/link-local/metadata addresses (checked on the name and again on every resolved address, so a
 * name that later points inside is refused), a redirect to anywhere the list does not allow (each hop is checked;
 * redirects are never followed blindly), responses larger than the cap, and calls that run past their deadline.
 * Clock, fetch and name resolution are arguments, so nothing here needs a network to be tested.
 *
 * Host patterns: "api.example.com" (exactly that name) or "*.example.com" (any name below it, not example.com itself).
 * Out of scope: retries and backoff (callers decide), model calls, inbound requests, proxies and certificate pinning.
 */
import { isIP } from 'node:net';
import { internalAddress } from '../webhooks/index.ts';

export class EgressRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`egress refused: ${reason}`);
    this.reason = reason;
  }
}

export type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

export interface HostRule {
  /** Purposes this host may be called for. "*" means any purpose. */
  readonly purposes: readonly string[];
  /** Ports allowed besides 443. */
  readonly ports?: readonly number[];
  /** Methods allowed; default GET, HEAD, POST, PUT, PATCH, DELETE. */
  readonly methods?: readonly string[];
  /** Allow this host although it is an internal address (a sidecar, a test receiver). Never for a wildcard. */
  readonly internal?: boolean;
}

export interface EgressRequest {
  readonly purpose: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface EgressResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly url: string;
  text(): string;
  json(): unknown;
}

export interface Record_ {
  readonly at: number;
  readonly purpose: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** Names of the query parameters, never their values. */
  readonly query: readonly string[];
  readonly outcome: 'sent' | 'refused' | 'failed';
  readonly status?: number;
  readonly bytes?: number;
  readonly ms: number;
  readonly reason?: string;
  readonly redirects: number;
}
export type { Record_ as EgressRecord };

export interface Egress {
  request(r: EgressRequest): Promise<EgressResponse>;
  readonly records: readonly Record_[];
}

export interface EgressOptions {
  readonly allow: Readonly<Record<string, HostRule>>;
  readonly fetch: FetchHandler;
  readonly now?: () => number;
  /** Addresses a name resolves to, checked on each hop. Without it only the name itself is checked. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly maxRedirects?: number;
  readonly defaultMaxBytes?: number;
  readonly defaultTimeoutMs?: number;
  /** Most records kept in memory (oldest dropped). */
  readonly keepRecords?: number;
  readonly onRecord?: (r: Record_) => void;
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const INTERNAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$|^metadata\.google\.internal$|^[^.]+$/;

const bare = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** Whether a host name matches a pattern: exact, or "*.zone" for names below the zone. */
export function allowed(pattern: string, host: string): boolean {
  const p = bare(pattern);
  const h = bare(host);
  if (p.startsWith('*.')) {
    const zone = p.slice(1);
    return h.length > zone.length && h.endsWith(zone);
  }
  return p === h;
}

/** The rule that applies to a host: an exact entry wins over a wildcard, a longer wildcard over a shorter. */
function ruleFor(allow: Readonly<Record<string, HostRule>>, host: string): HostRule | undefined {
  let best: { rule: HostRule; score: number } | undefined;
  for (const [pat, rule] of Object.entries(allow)) {
    if (!allowed(pat, host)) continue;
    const score = pat.startsWith('*.') ? pat.length : 10_000;
    if (!best || score > best.score) best = { rule, score };
  }
  return best?.rule;
}

function secretish(name: string): boolean {
  return /auth|token|key|secret|password|cookie|signature/i.test(name);
}

function makeResponse(status: number, headers: Headers, body: Uint8Array, url: string): EgressResponse {
  const h: Record<string, string> = {};
  headers.forEach((v, k) => (h[k.toLowerCase()] = v));
  return {
    status,
    headers: h,
    body,
    url,
    text: () => new TextDecoder().decode(body),
    json: () => JSON.parse(new TextDecoder().decode(body)),
  };
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new EgressRefused(`response of ${declared} bytes is over the ${cap} byte limit`);
  }
  if (!res.body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) {
      await reader.cancel().catch(() => {});
      throw new EgressRefused(`response is over the ${cap} byte limit`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function door(o: EgressOptions): Egress {
  const now = o.now ?? Date.now;
  const records: Record_[] = [];
  const keep = o.keepRecords ?? 10_000;
  const maxRedirects = o.maxRedirects ?? 3;
  const note = (r: Record_) => {
    records.push(r);
    if (records.length > keep) records.shift();
    o.onRecord?.(r);
  };

  async function check(u: URL, purpose: string, method: string): Promise<void> {
    if (!purpose || !/^[a-z0-9][a-z0-9._-]*$/i.test(purpose)) throw new EgressRefused('a call must name its purpose');
    if (u.protocol !== 'https:') throw new EgressRefused(`only https is allowed, not ${u.protocol.replace(':', '')}`);
    if (u.username || u.password) throw new EgressRefused('credentials in the address are not allowed');
    const host = bare(u.hostname);
    const rule = ruleFor(o.allow, host);
    if (!rule) throw new EgressRefused(`${host} is not on the allow-list`);
    if (!rule.purposes.includes('*') && !rule.purposes.includes(purpose)) throw new EgressRefused(`${host} is not allowed for ${purpose}`);
    const port = u.port ? Number(u.port) : 443;
    if (port !== 443 && !(rule.ports ?? []).includes(port)) throw new EgressRefused(`port ${port} is not allowed for ${host}`);
    if (!(rule.methods ?? METHODS).includes(method)) throw new EgressRefused(`${method} is not allowed for ${host}`);
    const literal = isIP(host) !== 0;
    if (!rule.internal) {
      if (literal && internalAddress(host)) throw new EgressRefused(`${host} is an internal address`);
      if (!literal && INTERNAL_NAMES.test(host)) throw new EgressRefused(`${host} is an internal name`);
      if (!literal && o.resolve) {
        const addrs = await o.resolve(host);
        if (!addrs.length) throw new EgressRefused(`${host} did not resolve`);
        const bad = addrs.find((a) => internalAddress(a));
        if (bad) throw new EgressRefused(`${host} resolves to the internal address ${bad}`);
      }
    }
  }

  async function request(r: EgressRequest): Promise<EgressResponse> {
    const t0 = now();
    const method = (r.method ?? 'GET').toUpperCase();
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      const rec: Record_ = { at: t0, purpose: r.purpose, method, host: '', path: '', query: [], outcome: 'refused', ms: 0, reason: 'not a valid address', redirects: 0 };
      note(rec);
      throw new EgressRefused('not a valid address');
    }
    const logBase = (url: URL) => ({ host: bare(url.hostname), path: url.pathname, query: [...new Set([...url.searchParams.keys()])] });
    let redirects = 0;
    let cur = u;
    let curMethod = method;
    let curBody = r.body;
    const cap = r.maxBytes ?? o.defaultMaxBytes ?? 5_000_000;
    const deadline = r.timeoutMs ?? o.defaultTimeoutMs ?? 10_000;
    try {
      for (;;) {
        await check(cur, r.purpose, curMethod);
        const headers: Record<string, string> = { ...(r.headers ?? {}) };
        // Authorization must not follow a redirect to another host.
        if (redirects > 0 && bare(cur.hostname) !== bare(u.hostname)) for (const k of Object.keys(headers)) if (secretish(k)) delete headers[k];
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), deadline);
        let res: Response;
        try {
          const init: RequestInit = { method: curMethod, headers, redirect: 'manual', signal: ctl.signal };
          if (curBody !== undefined && curMethod !== 'GET' && curMethod !== 'HEAD') init.body = curBody as BodyInit;
          res = await o.fetch(cur.toString(), init);
          if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
            await res.body?.cancel().catch(() => {});
            if (++redirects > maxRedirects) throw new EgressRefused(`more than ${maxRedirects} redirects`);
            cur = new URL(res.headers.get('location')!, cur);
            if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST')) {
              curMethod = 'GET';
              curBody = undefined;
            }
            continue;
          }
          const body = await readCapped(res, cap);
          const out = makeResponse(res.status, res.headers, body, cur.toString());
          note({ at: t0, purpose: r.purpose, method, ...logBase(cur), outcome: 'sent', status: res.status, bytes: body.byteLength, ms: now() - t0, redirects });
          return out;
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      if (e instanceof EgressRefused) {
        note({ at: t0, purpose: r.purpose, method, ...logBase(cur), outcome: 'refused', ms: now() - t0, reason: e.reason, redirects });
        throw e;
      }
      const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
      const reason = aborted ? `no answer within ${deadline} ms` : e instanceof Error ? e.message : String(e);
      note({ at: t0, purpose: r.purpose, method, ...logBase(cur), outcome: 'failed', ms: now() - t0, reason, redirects });
      throw new Error(`egress failed: ${reason}`);
    }
  }

  return { request, records };
}

/** The real door: Node's fetch behind the allow-list, with names resolved by the system resolver and checked. */
export function realEgress(allow: Readonly<Record<string, HostRule>>, o: Partial<Omit<EgressOptions, 'allow'>> = {}): Egress {
  return door({
    allow,
    fetch: o.fetch ?? ((url, init) => fetch(url, init)),
    resolve: o.resolve ?? (async (h) => (await (await import('node:dns/promises')).lookup(h, { all: true })).map((a) => a.address)),
    ...o,
  });
}

/** Services run in-process behind the same door: a host name maps to a handler instead of the network. */
export function routedEgress(allow: Readonly<Record<string, HostRule>>, routes: Readonly<Record<string, (req: Request) => Promise<Response> | Response>>, o: Partial<Omit<EgressOptions, 'allow' | 'fetch'>> = {}): Egress {
  return door({
    allow,
    resolve: async () => ['93.184.216.34'],
    ...o,
    fetch: async (url, init) => {
      const u = new URL(url);
      const h = routes[bare(u.hostname)];
      if (!h) throw new Error(`no in-process service for ${u.hostname}`);
      return h(new Request(url, init));
    },
  });
}

export interface TwinCall {
  readonly purpose: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Records every call that passes the door and answers from canned responses, without leaving the machine. */
export class EgressTwin {
  readonly calls: TwinCall[] = [];
  readonly egress: Egress;
  private readonly canned = new Map<string, { status: number; body: string; headers: Record<string, string> }>();

  constructor(allow: Readonly<Record<string, HostRule>>, o: Partial<Omit<EgressOptions, 'allow' | 'fetch'>> = {}) {
    this.egress = door({
      allow,
      resolve: async () => ['93.184.216.34'],
      ...o,
      fetch: async (url, init) => {
        const h = (init.headers ?? {}) as Record<string, string>;
        this.calls.push({ purpose: '', method: String(init.method), url, headers: h, body: init.body === undefined ? '' : String(init.body) });
        const c = this.canned.get(`${init.method} ${url}`) ?? this.canned.get(`* ${new URL(url).host}`);
        return new Response(c?.body ?? '', { status: c?.status ?? 200, headers: c?.headers ?? {} });
      },
    });
  }

  /** Answers `method url` with this response; `reply('*', 'host', ...)` answers anything to a host. */
  reply(method: string, urlOrHost: string, status: number, body = '', headers: Record<string, string> = {}): this {
    this.canned.set(`${method.toUpperCase()} ${urlOrHost}`, { status, body, headers });
    return this;
  }
}
