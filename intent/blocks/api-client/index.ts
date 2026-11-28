/**
 * A generic client for other people's HTTP APIs, with the habits that make integrations dependable. Auth styles:
 * bearer token (static or supplied by a function), HTTP Basic, an API key in a header or in the query, and OAuth 2.0
 * client credentials (RFC 6749 section 4.4) with the token cached until shortly before it expires and fetched
 * again after a 401. Pagination styles: offset, page number, opaque cursor, RFC 8288 Link header, and a "next" URL
 * in the body; a checkpoint lets a long listing resume, a repeated cursor or URL is refused as a loop, and a next
 * URL on another host is never followed. Rate limits: Retry-After (seconds or a date), X-RateLimit-* and the IETF
 * RateLimit-* headers are read, the client waits for a window to reopen when the budget is spent (up to a limit)
 * and honours 429 and 503 answers. Retries: safe methods on network errors, 408, 429 and 5xx with full-jitter
 * backoff; POST and PATCH only with an idempotency key (sent as Idempotency-Key). Egress: https only (unless told),
 * an allow-list of hosts, no loopback, private, link-local or metadata addresses, redirects followed by hand,
 * re-checked on each hop, and stripped of credentials when they leave the host; response bodies are capped.
 * A circuit breaker per host (the resilience block's) stops hammering a service that is down. Secrets are
 * redacted from every error. MockApi is a twin that serves any pagination style, checks the auth, and enforces a
 * rate limit, so integrations are tested without the network. The transport, clock, sleep and randomness are
 * arguments. Not here: OAuth authorization-code flows, request signing schemes (AWS SigV4), multipart bodies.
 */
import { Breaker, BreakerOpen, TimedOut, withTimeout } from '../resilience/index.ts';
import { internalAddress } from '../webhooks/index.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(message: string, status: number, url: string, body = '') {
    super(message);
    this.status = status;
    this.url = url;
    this.body = body.slice(0, 500);
  }
}
export class EgressDenied extends Error {}
export class RateLimited extends Error {
  readonly retryAt: number;
  constructor(message: string, retryAt: number) {
    super(message);
    this.retryAt = retryAt;
  }
}
export class ResponseTooLarge extends Error {}
export class PaginationLoop extends Error {}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- auth

export type Auth =
  | { readonly type: 'none' }
  | { readonly type: 'bearer'; readonly token: string | (() => string | Promise<string>) }
  | { readonly type: 'basic'; readonly user: string; readonly pass: string }
  | { readonly type: 'header'; readonly name: string; readonly value: string }
  | { readonly type: 'query'; readonly name: string; readonly value: string }
  | { readonly type: 'oauth2'; readonly tokenUrl: string; readonly clientId: string; readonly clientSecret: string; readonly scope?: string };

// ---------------------------------------------------------------- rate limit headers

export interface RateLimitInfo {
  readonly limit?: number;
  readonly remaining?: number;
  /** When the window reopens, in epoch milliseconds. */
  readonly resetAt?: number;
  /** A direct instruction to wait, from Retry-After. */
  readonly retryAfterMs?: number;
}

const num = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || !/^\s*\d+(\.\d+)?\s*$/.test(v)) return undefined;
  return Number(v);
};

/** Reads Retry-After, X-RateLimit-*, RateLimit-* and the structured RateLimit header. `now` is epoch ms. */
export function parseRateLimit(h: Headers, now: number): RateLimitInfo {
  const out: { limit?: number; remaining?: number; resetAt?: number; retryAfterMs?: number } = {};
  const ra = h.get('retry-after');
  if (ra !== null) {
    const s = num(ra);
    if (s !== undefined) out.retryAfterMs = Math.round(s * 1000);
    else {
      const t = Date.parse(ra);
      if (!Number.isNaN(t)) out.retryAfterMs = Math.max(0, t - now);
    }
  }
  const structured = h.get('ratelimit');
  let limit = num(h.get('x-ratelimit-limit') ?? h.get('ratelimit-limit') ?? h.get('x-rate-limit-limit'));
  let remaining = num(h.get('x-ratelimit-remaining') ?? h.get('ratelimit-remaining') ?? h.get('x-rate-limit-remaining'));
  let reset = num(h.get('x-ratelimit-reset') ?? h.get('ratelimit-reset') ?? h.get('x-rate-limit-reset'));
  if (structured && (limit === undefined || remaining === undefined)) {
    const m = (k: string) => num(new RegExp(`(?:^|[,;\\s])${k}=(\\d+)`).exec(structured)?.[1]);
    limit ??= m('limit');
    remaining ??= m('remaining');
    reset ??= m('reset');
  }
  if (limit !== undefined) out.limit = limit;
  if (remaining !== undefined) out.remaining = remaining;
  // A reset above a billion is a Unix time in seconds; anything smaller is seconds from now.
  if (reset !== undefined) out.resetAt = reset > 1e9 ? reset * 1000 : now + reset * 1000;
  return out;
}

/** Link header (RFC 8288) as relation to URL: `<https://x/?p=2>; rel="next", <https://x/?p=9>; rel="last"`. */
export function parseLinkHeader(h: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const m of h.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]+)*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(m[2]!);
    const names = (rel?.[1] ?? rel?.[2] ?? '').split(/\s+/).filter(Boolean);
    for (const n of names) if (!Object.hasOwn(out, n.toLowerCase())) out[n.toLowerCase()] = m[1]!;
  }
  return out;
}

// ---------------------------------------------------------------- the client

export interface ClientOptions {
  readonly baseUrl: string;
  readonly auth?: Auth;
  readonly transport?: Transport;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Hosts the client may call besides the base URL's own (a CDN, a token server). Exact names. */
  readonly allowHosts?: readonly string[];
  /** Allow plain http and internal addresses; for the mock and for local development only. */
  readonly allowInsecure?: boolean;
  readonly retry?: { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  /** The longest to wait for a rate-limit window or a Retry-After; longer throws RateLimited. */
  readonly maxWaitMs?: number;
  readonly breaker?: { readonly threshold: number; readonly coolDownMs: number } | false;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Req {
  readonly method?: string;
  /** A path under the base URL, or an absolute URL on an allowed host. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly body?: string;
  /** Makes a POST or PATCH safe to retry; sent as the Idempotency-Key header. */
  readonly idempotencyKey?: string;
}

export interface Res {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
  readonly rateLimit: RateLimitInfo;
  readonly attempts: number;
  /** The final URL, with any secret query parameter removed. */
  readonly url: string;
}

const SAFE = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const INTERNAL_NAME = /^(?:localhost|.+\.localhost|.+\.local|.+\.internal|metadata|metadata\.goog|instance-data)$/i;

const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

export class ApiClient {
  private readonly o: ClientOptions;
  private readonly base: URL;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly allow: Set<string>;
  private readonly breakers = new Map<string, Breaker>();
  private readonly limits = new Map<string, RateLimitInfo>();
  private token: { value: string; expiresAt: number } | undefined;

  constructor(o: ClientOptions) {
    this.o = o;
    this.base = new URL(o.baseUrl);
    this.transport = o.transport ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
    this.allow = new Set([hostOf(this.base), ...(o.allowHosts ?? []).map((h) => h.toLowerCase())]);
    this.checkEgress(this.base);
  }

  private checkEgress(u: URL): void {
    if (u.username || u.password) throw new EgressDenied('credentials in a URL are not allowed; use the auth option');
    if (!this.o.allowInsecure) {
      if (u.protocol !== 'https:') throw new EgressDenied(`${u.protocol}// is not allowed; use https`);
      const h = hostOf(u);
      if (INTERNAL_NAME.test(h) || internalAddress(h)) throw new EgressDenied(`${h} is an internal address`);
    } else if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new EgressDenied(`${u.protocol}// is not allowed`);
    if (!this.allow.has(hostOf(u))) throw new EgressDenied(`${hostOf(u)} is not an allowed host`);
  }

  /** The URL a request goes to, with the query applied; checked against the egress rules. */
  private build(r: Req, extraQuery: [string, string][]): URL {
    const u = /^[a-z][a-z0-9+.-]*:/i.test(r.path) ? new URL(r.path) : new URL(r.path.replace(/^\/+/, ''), this.base.href.endsWith('/') ? this.base.href : `${this.base.href}/`);
    for (const [k, v] of Object.entries(r.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    for (const [k, v] of extraQuery) u.searchParams.set(k, v);
    this.checkEgress(u);
    return u;
  }

  private secretQuery(): string | undefined {
    return this.o.auth?.type === 'query' ? this.o.auth.name : undefined;
  }

  /** A URL as it may appear in an error or a log: the secret query parameter is hidden. */
  private safeUrl(u: URL): string {
    const c = new URL(u.href);
    const s = this.secretQuery();
    if (s && c.searchParams.has(s)) c.searchParams.set(s, '[redacted]');
    return c.href;
  }

  private async accessToken(force = false): Promise<string> {
    const a = this.o.auth;
    if (a?.type !== 'oauth2') throw new Error('not an oauth2 client');
    if (!force && this.token && this.token.expiresAt - 30_000 > this.now()) return this.token.value;
    const tu = new URL(a.tokenUrl);
    this.checkEgress(tu);
    const body = new URLSearchParams({ grant_type: 'client_credentials', ...(a.scope ? { scope: a.scope } : {}) }).toString();
    const res = await this.transport(tu.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Basic ${Buffer.from(`${encodeURIComponent(a.clientId)}:${encodeURIComponent(a.clientSecret)}`).toString('base64')}` }, body, redirect: 'manual' });
    const text = await this.readBody(res, tu);
    if (res.status !== 200) throw new ApiError(`the token server answered ${res.status}`, res.status, this.safeUrl(tu), text.replaceAll(a.clientSecret, '[redacted]'));
    let j: { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
    try {
      j = JSON.parse(text);
    } catch {
      throw new ApiError('the token server did not answer with JSON', res.status, this.safeUrl(tu));
    }
    if (typeof j.access_token !== 'string' || !j.access_token) throw new ApiError('the token server gave no access_token', res.status, this.safeUrl(tu));
    if (typeof j.token_type === 'string' && j.token_type.toLowerCase() !== 'bearer') throw new ApiError(`unsupported token type ${j.token_type}`, res.status, this.safeUrl(tu));
    const ttl = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in * 1000 : 3600_000;
    this.token = { value: j.access_token, expiresAt: this.now() + ttl };
    return j.access_token;
  }

  private async authHeaders(): Promise<{ headers: Record<string, string>; query: [string, string][] }> {
    const a = this.o.auth ?? { type: 'none' as const };
    switch (a.type) {
      case 'none':
        return { headers: {}, query: [] };
      case 'bearer':
        return { headers: { authorization: `Bearer ${typeof a.token === 'function' ? await a.token() : a.token}` }, query: [] };
      case 'basic':
        return { headers: { authorization: `Basic ${Buffer.from(`${a.user}:${a.pass}`).toString('base64')}` }, query: [] };
      case 'header':
        return { headers: { [a.name.toLowerCase()]: a.value }, query: [] };
      case 'query':
        return { headers: {}, query: [[a.name, a.value]] };
      case 'oauth2':
        return { headers: { authorization: `Bearer ${await this.accessToken()}` }, query: [] };
    }
  }

  private redact(text: string): string {
    const a = this.o.auth;
    let t = text;
    const secrets: string[] = [];
    if (a?.type === 'bearer' && typeof a.token === 'string') secrets.push(a.token);
    if (a?.type === 'basic') secrets.push(a.pass);
    if (a?.type === 'header' || a?.type === 'query') secrets.push(a.value);
    if (a?.type === 'oauth2') secrets.push(a.clientSecret, this.token?.value ?? '');
    for (const s of secrets) if (s.length >= 4) t = t.replaceAll(s, '[redacted]');
    return t;
  }

  private async readBody(res: Response, u: URL): Promise<string> {
    const max = this.o.maxResponseBytes ?? 10 * 1024 * 1024;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel();
      throw new ResponseTooLarge(`${this.safeUrl(u)} announced ${declared} bytes; the limit is ${max}`);
    }
    if (!res.body) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new ResponseTooLarge(`${this.safeUrl(u)} sent more than the limit of ${max} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private breaker(host: string): Breaker | undefined {
    if (this.o.breaker === false) return undefined;
    let b = this.breakers.get(host);
    if (!b) {
      b = new Breaker(this.o.breaker?.threshold ?? 5, this.o.breaker?.coolDownMs ?? 30_000, this.now);
      this.breakers.set(host, b);
    }
    return b;
  }

  /** Waits for a rate-limit window the last answer said was spent; throws when the wait would be too long. */
  private async respectLimit(host: string): Promise<void> {
    const s = this.limits.get(host);
    if (!s || s.remaining === undefined || s.remaining > 0 || s.resetAt === undefined) return;
    const wait = s.resetAt - this.now();
    if (wait <= 0) {
      this.limits.delete(host);
      return;
    }
    if (wait > (this.o.maxWaitMs ?? 60_000)) throw new RateLimited(`the rate limit of ${host} is spent until ${new Date(s.resetAt).toISOString()}`, s.resetAt);
    await this.sleep(wait);
    this.limits.delete(host);
  }

  /** One round trip, following redirects by hand under the egress rules. */
  private async once(r: Req, method: string, refreshed: boolean): Promise<{ res: Response; text: string; url: URL; rl: RateLimitInfo }> {
    const auth = await this.authHeaders();
    let url = this.build(r, auth.query);
    let headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'zthr-api-client/1', ...Object.fromEntries(Object.entries(this.o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), ...Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), ...auth.headers };
    let body: string | undefined = r.json !== undefined ? JSON.stringify(r.json) : r.body;
    if (r.json !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    if (r.idempotencyKey) headers['idempotency-key'] = r.idempotencyKey;
    let m = method;
    for (let hop = 0; ; hop++) {
      const ms = this.o.timeoutMs ?? 30_000;
      const res = await withTimeout(ms, async (signal) => {
        try {
          return await this.transport(url.href, { method: m, headers, ...(body !== undefined ? { body } : {}), signal, redirect: 'manual' });
        } catch (e) {
          // An aborted transport rejects before the deadline does; report what really happened.
          if (signal.aborted) throw new TimedOut(ms);
          throw e;
        }
      });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        await res.body?.cancel();
        if (hop >= (this.o.maxRedirects ?? 5)) throw new ApiError('too many redirects', res.status, this.safeUrl(url));
        const next = new URL(res.headers.get('location')!, url);
        this.checkEgress(next);
        const sameOrigin = next.origin === url.origin;
        if (!sameOrigin) {
          // Credentials belong to the host they were meant for: nothing of them goes along.
          const { authorization: _a, cookie: _c, ...rest } = headers;
          headers = rest;
          for (const k of Object.keys(auth.headers)) delete headers[k];
          const sq = this.secretQuery();
          if (sq) next.searchParams.delete(sq);
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) {
          m = m === 'HEAD' ? 'HEAD' : 'GET';
          body = undefined;
          delete headers['content-type'];
        }
        url = next;
        continue;
      }
      const text = await this.readBody(res, url);
      const rl = parseRateLimit(res.headers, this.now());
      if (res.status === 401 && this.o.auth?.type === 'oauth2' && !refreshed) {
        this.token = undefined;
        return this.once(r, method, true);
      }
      return { res, text, url, rl };
    }
  }

  /** Sends a request: rate-limit aware, retried where that is safe, and returned only when it succeeded (2xx). */
  async request(r: Req): Promise<Res> {
    const method = (r.method ?? 'GET').toUpperCase();
    const retryOk = SAFE.has(method) || !!r.idempotencyKey;
    const cfg = this.o.retry ?? { attempts: 4, baseMs: 500, maxMs: 15_000 };
    const maxWait = this.o.maxWaitMs ?? 60_000;
    const host = hostOf(this.build(r, []));
    let last: unknown;
    for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
      await this.respectLimit(host);
      let wait: number | undefined;
      try {
        const b = this.breaker(host);
        const run = async () => {
          const out = await this.once(r, method, false);
          if (RETRY_STATUS.has(out.res.status) && out.res.status >= 500) throw new RetryableStatus(out);
          return out;
        };
        const out = b ? await b.call(run) : await run();
        this.limits.set(host, out.rl);
        const status = out.res.status;
        if (status === 429 && attempt < cfg.attempts) {
          wait = out.rl.retryAfterMs ?? (out.rl.resetAt !== undefined ? out.rl.resetAt - this.now() : undefined);
          if (wait !== undefined && wait > maxWait) throw new RateLimited(`${host} asked us to wait ${Math.ceil(wait / 1000)}s`, this.now() + wait);
          last = new ApiError('rate limited (429)', 429, this.safeUrl(out.url), this.redact(out.text));
        } else if (status >= 200 && status < 300) {
          return this.finish(out, attempt);
        } else if (RETRY_STATUS.has(status) && retryOk && attempt < cfg.attempts) {
          wait = out.rl.retryAfterMs;
          last = new ApiError(`the server answered ${status}`, status, this.safeUrl(out.url), this.redact(out.text));
        } else if (status === 429) {
          throw new RateLimited(`${host} is rate limiting us and retries are used up`, this.now() + (out.rl.retryAfterMs ?? 60_000));
        } else {
          throw new ApiError(`the server answered ${status}`, status, this.safeUrl(out.url), this.redact(out.text));
        }
      } catch (e) {
        if (e instanceof RetryableStatus) {
          const status = e.out.res.status;
          const err = new ApiError(`the server answered ${status}`, status, this.safeUrl(e.out.url), this.redact(e.out.text));
          this.limits.set(host, e.out.rl);
          if (!retryOk || attempt >= cfg.attempts) throw err;
          last = err;
          wait = e.out.rl.retryAfterMs;
        } else if (e instanceof TimedOut || (e instanceof TypeError && !(e instanceof EgressDenied))) {
          if (!retryOk || attempt >= cfg.attempts) throw e instanceof TimedOut ? e : new ApiError(`could not reach ${host}: ${this.redact(e.message)}`, 0, host);
          last = e;
        } else throw e;
      }
      const delay = wait !== undefined ? Math.max(0, wait) : Math.floor(this.random() * Math.min(cfg.maxMs, cfg.baseMs * 2 ** (attempt - 1)));
      if (wait !== undefined && wait > maxWait) throw new RateLimited(`${host} asked us to wait ${Math.ceil(wait / 1000)}s`, this.now() + wait);
      await this.sleep(delay);
    }
    throw last instanceof Error ? last : new ApiError('the request failed', 0, host);
  }

  private finish(out: { res: Response; text: string; url: URL; rl: RateLimitInfo }, attempts: number): Res {
    let json: unknown = undefined;
    if (out.text && /json/i.test(out.res.headers.get('content-type') ?? '')) {
      try {
        json = JSON.parse(out.text);
      } catch {
        throw new ApiError('the answer is not valid JSON', out.res.status, this.safeUrl(out.url), this.redact(out.text));
      }
    }
    return { status: out.res.status, headers: out.res.headers, text: out.text, json, rateLimit: out.rl, attempts, url: this.safeUrl(out.url) };
  }

  get(path: string, query?: Req['query']): Promise<Res> {
    return this.request({ path, ...(query ? { query } : {}) });
  }
  post(path: string, json: unknown, idempotencyKey?: string): Promise<Res> {
    return this.request({ method: 'POST', path, json, ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  /** Reads a whole listing page by page as a stream of items. See PageSpec. */
  async *paginate(spec: PageSpec, req: Req, o: { resume?: PageState; maxPages?: number; maxItems?: number; onPage?: (s: PageState) => void } = {}): AsyncGenerator<unknown, PageState> {
    const state: { -readonly [K in keyof PageState]: PageState[K] } = { pages: 0, items: 0, done: false, ...(o.resume ?? {}) };
    const seen = new Set<string>();
    const maxPages = o.maxPages ?? 1000;
    while (!state.done) {
      if (state.pages >= maxPages) throw new ApiError(`stopped after ${maxPages} pages`, 0, req.path);
      const q: Record<string, string | number | boolean | undefined> = { ...(req.query ?? {}) };
      let r: Req = req;
      switch (spec.style) {
        case 'offset': {
          const size = spec.pageSize;
          q[spec.limitParam ?? 'limit'] = size;
          q[spec.offsetParam ?? 'offset'] = state.offset ?? 0;
          break;
        }
        case 'page':
          q[spec.pageParam ?? 'page'] = state.page ?? spec.start ?? 1;
          q[spec.sizeParam ?? 'per_page'] = spec.pageSize;
          break;
        case 'cursor':
          if (spec.pageSize !== undefined) q[spec.sizeParam ?? 'limit'] = spec.pageSize;
          if (state.cursor) q[spec.cursorParam ?? 'cursor'] = state.cursor;
          break;
        case 'link':
        case 'next-url':
          if (state.url) r = { ...req, path: state.url };
          break;
      }
      const res = await this.request(state.url ? { ...r, query: {} } : { ...r, query: q });
      const items = pick(res.json, spec.itemsPath);
      if (!Array.isArray(items)) throw new ApiError(`expected a list${spec.itemsPath ? ` at ${spec.itemsPath}` : ''} in the answer`, res.status, res.url);
      state.pages++;
      let stop = false;
      for (const it of items) {
        if (o.maxItems !== undefined && state.items >= o.maxItems) {
          stop = true;
          break;
        }
        state.items++;
        yield it;
      }
      switch (spec.style) {
        case 'offset': {
          state.offset = (state.offset ?? 0) + items.length;
          const total = spec.totalPath ? pick(res.json, spec.totalPath) : undefined;
          if (items.length < spec.pageSize || items.length === 0 || (typeof total === 'number' && state.offset >= total)) state.done = true;
          break;
        }
        case 'page': {
          const totalPages = spec.totalPagesPath ? pick(res.json, spec.totalPagesPath) : undefined;
          const cur = state.page ?? spec.start ?? 1;
          state.page = cur + 1;
          if (items.length < spec.pageSize || items.length === 0 || (typeof totalPages === 'number' && cur >= totalPages)) state.done = true;
          break;
        }
        case 'cursor': {
          const next = pick(res.json, spec.nextPath ?? 'next_cursor');
          if (typeof next !== 'string' || !next) state.done = true;
          else {
            if (seen.has(next) || next === state.cursor) throw new PaginationLoop(`the cursor ${next.slice(0, 40)} came back`);
            seen.add(next);
            state.cursor = next;
          }
          break;
        }
        case 'link':
        case 'next-url': {
          const raw = spec.style === 'link' ? parseLinkHeader(res.headers.get('link')).next : pick(res.json, spec.nextPath ?? 'next');
          if (typeof raw !== 'string' || !raw) state.done = true;
          else {
            const abs = new URL(raw, state.url ?? this.build(req, []).href);
            // A next link to another host would carry our credentials there.
            if (hostOf(abs) !== hostOf(this.base)) throw new EgressDenied(`the next page is on ${hostOf(abs)}, not ${hostOf(this.base)}`);
            if (seen.has(abs.href)) throw new PaginationLoop(`the page ${abs.href} came back`);
            seen.add(abs.href);
            state.url = abs.href;
          }
          break;
        }
      }
      o.onPage?.({ ...state });
      if (stop) {
        break;
      }
    }
    return { ...state };
  }
}

class RetryableStatus extends Error {
  readonly out: { res: Response; text: string; url: URL; rl: RateLimitInfo };
  constructor(out: { res: Response; text: string; url: URL; rl: RateLimitInfo }) {
    super(`status ${out.res.status}`);
    this.out = out;
  }
}

export { BreakerOpen };

// ---------------------------------------------------------------- pagination

export type PageSpec =
  | { readonly style: 'offset'; readonly pageSize: number; readonly limitParam?: string; readonly offsetParam?: string; readonly itemsPath?: string; readonly totalPath?: string }
  | { readonly style: 'page'; readonly pageSize: number; readonly pageParam?: string; readonly sizeParam?: string; readonly start?: number; readonly itemsPath?: string; readonly totalPagesPath?: string }
  | { readonly style: 'cursor'; readonly cursorParam?: string; readonly nextPath?: string; readonly sizeParam?: string; readonly pageSize?: number; readonly itemsPath?: string }
  | { readonly style: 'link'; readonly itemsPath?: string }
  | { readonly style: 'next-url'; readonly nextPath?: string; readonly itemsPath?: string };

/** Where a listing stands, to save and resume from after a failure or a restart. */
export interface PageState {
  readonly pages: number;
  readonly items: number;
  readonly done: boolean;
  readonly offset?: number;
  readonly page?: number;
  readonly cursor?: string;
  readonly url?: string;
}

/** A value at a dotted path ("data.items"); the whole value when the path is empty. Prototype names are never read. */
export function pick(v: unknown, path?: string): unknown {
  if (!path) return v;
  let cur: unknown = v;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || k === '__proto__' || k === 'constructor' || k === 'prototype' || !Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// ---------------------------------------------------------------- the mock twin

export interface MockOptions {
  readonly items: readonly unknown[];
  readonly style: 'offset' | 'page' | 'cursor' | 'link' | 'next-url';
  readonly pageSize?: number;
  /** The path that lists, matched at the end of the request path; default "/items". */
  readonly path?: string;
  /** Requests carrying this Authorization or header must match, or the answer is 401. */
  readonly bearer?: string;
  readonly apiKeyHeader?: { readonly name: string; readonly value: string };
  readonly apiKeyQuery?: { readonly name: string; readonly value: string };
  readonly basic?: { readonly user: string; readonly pass: string };
  /** Allow this many requests per window, then answer 429 with Retry-After and X-RateLimit-* headers. */
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  /** The first N answers fail with this status before the service recovers. */
  readonly failFirst?: { readonly count: number; readonly status: number; readonly retryAfter?: number };
  /** OAuth token endpoint: issues tokens that expire. */
  readonly oauth?: { readonly path: string; readonly clientId: string; readonly clientSecret: string; readonly expiresIn: number };
  readonly now?: () => number;
  readonly origin?: string;
}

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

/**
 * A stand-in for an API: serves `items` in the chosen pagination style, checks the declared auth, enforces a rate
 * limit with the standard headers, can fail for a while and then recover, and records every request it saw.
 */
export class MockApi {
  readonly seen: Seen[] = [];
  readonly issued: string[] = [];
  private readonly o: MockOptions;
  private hits: number[] = [];
  private fails = 0;
  private readonly now: () => number;
  constructor(o: MockOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** Use as the client's transport. */
  readonly transport: Transport = async (url, init) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    this.seen.push({ method: init.method ?? 'GET', url, headers, body: typeof init.body === 'string' ? init.body : undefined });
    const json = (status: number, body: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...h } });
    const o = this.o;
    if (o.oauth && u.pathname === o.oauth.path) {
      const want = `Basic ${Buffer.from(`${o.oauth.clientId}:${o.oauth.clientSecret}`).toString('base64')}`;
      if (headers.authorization !== want) return json(401, { error: 'invalid_client' });
      const tok = `tok-${this.issued.length + 1}`;
      this.issued.push(tok);
      return json(200, { access_token: tok, token_type: 'Bearer', expires_in: o.oauth.expiresIn });
    }
    if (o.failFirst && this.fails < o.failFirst.count) {
      this.fails++;
      return json(o.failFirst.status, { error: 'unavailable' }, o.failFirst.retryAfter !== undefined ? { 'retry-after': String(o.failFirst.retryAfter) } : {});
    }
    const rl: Record<string, string> = {};
    if (o.rateLimit) {
      const t = this.now();
      this.hits = this.hits.filter((h) => h > t - o.rateLimit!.windowMs);
      const resetSec = Math.ceil(((this.hits[0] ?? t) + o.rateLimit.windowMs) / 1000);
      if (this.hits.length >= o.rateLimit.limit) return json(429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, resetSec - Math.floor(t / 1000))), 'x-ratelimit-limit': String(o.rateLimit.limit), 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) });
      this.hits.push(t);
      Object.assign(rl, { 'x-ratelimit-limit': String(o.rateLimit.limit), 'x-ratelimit-remaining': String(o.rateLimit.limit - this.hits.length), 'x-ratelimit-reset': String(resetSec) });
    }
    const authed = o.bearer ? headers.authorization === `Bearer ${o.bearer}` : true;
    const keyOk = o.apiKeyHeader ? headers[o.apiKeyHeader.name.toLowerCase()] === o.apiKeyHeader.value : true;
    const qOk = o.apiKeyQuery ? u.searchParams.get(o.apiKeyQuery.name) === o.apiKeyQuery.value : true;
    const basicOk = o.basic ? headers.authorization === `Basic ${Buffer.from(`${o.basic.user}:${o.basic.pass}`).toString('base64')}` : true;
    const oauthOk = o.oauth ? this.issued.length > 0 && headers.authorization === `Bearer ${this.issued[this.issued.length - 1]}` : true;
    if (!authed || !keyOk || !qOk || !basicOk || !oauthOk) return json(401, { error: 'unauthorized' }, rl);
    if (!u.pathname.endsWith(o.path ?? '/items')) return json(404, { error: 'not found' }, rl);
    const size = o.pageSize ?? 10;
    const all = o.items;
    const sp = u.searchParams;
    const body = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, ...extra });
    switch (o.style) {
      case 'offset': {
        const lim = Number(sp.get('limit') ?? size);
        const off = Number(sp.get('offset') ?? 0);
        return json(200, body(all.slice(off, off + lim) as unknown[], { total: all.length }), rl);
      }
      case 'page': {
        const per = Number(sp.get('per_page') ?? size);
        const p = Number(sp.get('page') ?? 1);
        return json(200, body(all.slice((p - 1) * per, p * per) as unknown[], { total_pages: Math.ceil(all.length / per) }), rl);
      }
      case 'cursor': {
        const start = sp.get('cursor') ? Number(Buffer.from(sp.get('cursor')!, 'base64url').toString()) : 0;
        const end = start + size;
        return json(200, body(all.slice(start, end) as unknown[], { next_cursor: end < all.length ? Buffer.from(String(end)).toString('base64url') : null }), rl);
      }
      case 'link': {
        const p = Number(sp.get('page') ?? 1);
        const end = p * size;
        const next = new URL(u.href);
        next.searchParams.set('page', String(p + 1));
        return json(200, body(all.slice((p - 1) * size, end) as unknown[]), { ...rl, ...(end < all.length ? { link: `<${next.href}>; rel="next", <${u.origin}${u.pathname}?page=${Math.ceil(all.length / size)}>; rel="last"` } : {}) });
      }
      case 'next-url': {
        const p = Number(sp.get('page') ?? 1);
        const end = p * size;
        const next = new URL(u.href);
        next.searchParams.set('page', String(p + 1));
        return json(200, body(all.slice((p - 1) * size, end) as unknown[], { next: end < all.length ? next.href : null }), rl);
      }
    }
  };
}
