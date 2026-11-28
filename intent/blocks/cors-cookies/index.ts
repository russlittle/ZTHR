/**
 * Cross-origin answers and cookies, the two browser rules that quietly decide whether a web app works. CORS:
 * a policy of allowed origins (exact, or one wildcard subdomain such as https://*.example.com), methods, request
 * headers, exposed headers, credentials and preflight lifetime is evaluated against a request to say what to send
 * back, following the Fetch standard: the origin is echoed only when listed (never reflected blindly, and "null" is
 * refused unless named), "*" with credentials is refused when the policy is built, "*" for request headers never
 * covers Authorization, a preflight is an OPTIONS with Access-Control-Request-Method, Private Network Access
 * preflights need an explicit yes, and Vary: Origin is set whenever the answer depends on the origin. Cookies:
 * Set-Cookie parsing and Cookie serialisation to RFC 6265bis (names and values checked so a header cannot be
 * injected into, Max-Age beating Expires, lifetimes capped at 400 days, SameSite including Lax by default, Secure
 * required with SameSite=None, the __Secure- and __Host- prefix rules, Secure cookies not set or overwritten from
 * plain http, size limits) and a cookie jar that applies domain, path, expiry, secure and same-site rules when
 * deciding what to send, with a bound on how many it keeps.
 * Out of scope: the public suffix list (pass `registrable` / `isPublicSuffix`; the defaults treat the last two
 * labels as the registrable domain and refuse single-label domains), the two-minute Lax-plus-POST allowance, and
 * cookie partitioning beyond parsing the Partitioned attribute.
 */

export class CorsError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class CookieError extends Error {
  constructor(message: string) {
    super(message);
  }
}

type Headers = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------------------------------------------
// CORS

/** The origin of a URL or origin string as a browser writes it, or "null". Anything with a path or userinfo is refused. */
export function normalizeOrigin(text: string): string {
  if (text === 'null') return 'null';
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new CorsError(`"${text}" is not an origin`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CorsError(`"${text}" is not an http or https origin`);
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || /^[a-z]+:\/\/[^/]*[/?#]./i.test(text)) throw new CorsError(`"${text}" is not an origin: it has more than scheme, host and port`);
  return u.origin;
}

export interface CorsPolicy {
  /** "*" for anyone (no credentials), or origins; one leading wildcard label is allowed: https://*.example.com. */
  readonly origins: '*' | readonly string[];
  /** Methods allowed beyond the always-safe GET, HEAD, POST. */
  readonly methods?: readonly string[];
  /** "*" or the request header names a page may send. */
  readonly allowedHeaders?: '*' | readonly string[];
  readonly exposedHeaders?: readonly string[];
  readonly credentials?: boolean;
  /** How long a browser may cache a preflight answer. Default 600; browsers cap it themselves. */
  readonly maxAgeSec?: number;
  /** Answer Private Network Access preflights with yes. */
  readonly allowPrivateNetwork?: boolean;
}

export interface CorsRequest {
  readonly method: string;
  /** Header names in lower case. */
  readonly headers: Headers;
}

export interface CorsResult {
  /** skip: not a cross-origin request. preflight: answer it with `status` and `headers`, no body. allow: add `headers` to the real response. deny: send no CORS headers. */
  readonly action: 'skip' | 'preflight' | 'allow' | 'deny';
  /** For a preflight: 204 when allowed, 403 when not. */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly reason: string;
}

const SAFE_METHODS = ['GET', 'HEAD', 'POST'];
/** Methods compared case-insensitively by the browser, so normalised; any other method is compared as written. */
const NORMALISED = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);
const FORBIDDEN_WILDCARD = new Set(['authorization']);
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const method = (m: string) => (NORMALISED.has(m.toUpperCase()) ? m.toUpperCase() : m);

export class Cors {
  private readonly exact = new Set<string>();
  private readonly suffixes: { scheme: string; suffix: string; port: string }[] = [];
  private readonly any: boolean;
  private readonly methods: Set<string>;
  private readonly headers: '*' | Set<string>;
  private readonly p: CorsPolicy;

  constructor(policy: CorsPolicy) {
    this.p = policy;
    this.any = policy.origins === '*';
    if (this.any && policy.credentials) throw new CorsError('a policy for every origin cannot allow credentials: list the origins');
    if (policy.allowedHeaders === '*' && policy.credentials) throw new CorsError('"*" for request headers cannot be combined with credentials: list the headers');
    if (!this.any)
      for (const o of policy.origins as readonly string[]) {
        const w = /^(https?):\/\/\*\.([^/*:]+(?:\.[^/*:]+)+)(?::(\d+))?$/.exec(o);
        if (w) this.suffixes.push({ scheme: w[1]!, suffix: `.${w[2]!.toLowerCase()}`, port: w[3] ?? '' });
        else if (o.includes('*')) throw new CorsError(`"${o}": a wildcard may only be the first label of a host, as in https://*.example.com`);
        else this.exact.add(normalizeOrigin(o));
      }
    this.methods = new Set([...SAFE_METHODS, ...(policy.methods ?? []).map(method)]);
    for (const m of this.methods) if (!TOKEN.test(m)) throw new CorsError(`"${m}" is not a method`);
    this.headers = policy.allowedHeaders === '*' ? '*' : new Set((policy.allowedHeaders ?? []).map((h) => h.toLowerCase()));
    for (const h of [...(this.headers === '*' ? [] : this.headers), ...(policy.exposedHeaders ?? [])]) if (!TOKEN.test(h)) throw new CorsError(`"${h}" is not a header name`);
  }

  /** Whether a request's Origin header value is allowed by the policy. */
  allows(origin: string): boolean {
    if (this.any) return origin !== '';
    let o: string;
    try {
      o = normalizeOrigin(origin);
    } catch {
      return false;
    }
    if (this.exact.has(o)) return true;
    if (o === 'null') return false;
    const u = new URL(o);
    return this.suffixes.some((s) => `${u.protocol}`.slice(0, -1) === s.scheme && u.port === s.port && u.hostname.endsWith(s.suffix) && u.hostname.length > s.suffix.length);
  }

  check(req: CorsRequest): CorsResult {
    const vary = this.any ? {} : { vary: 'Origin' };
    const origin = req.headers['origin'];
    if (origin === undefined) return { action: 'skip', status: 200, headers: vary, reason: 'no Origin header: not a cross-origin request' };
    const preflight = req.method.toUpperCase() === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined;
    const deny = (reason: string): CorsResult => ({ action: 'deny', status: preflight ? 403 : 200, headers: preflight ? { vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' } : vary, reason });
    if (!this.allows(origin)) return deny(`origin ${origin} is not allowed`);
    const base: Record<string, string> = { 'access-control-allow-origin': this.any ? '*' : origin === 'null' ? 'null' : normalizeOrigin(origin) };
    if (this.p.credentials) base['access-control-allow-credentials'] = 'true';
    if (!preflight) {
      if (!this.methods.has(method(req.method)) && !SAFE_METHODS.includes(req.method.toUpperCase())) return deny(`method ${req.method} is not allowed`);
      if (this.p.exposedHeaders?.length) base['access-control-expose-headers'] = this.p.exposedHeaders.join(', ');
      return { action: 'allow', status: 200, headers: { ...base, ...vary }, reason: 'origin allowed' };
    }
    const wanted = method(req.headers['access-control-request-method']!);
    if (!TOKEN.test(wanted) || !this.methods.has(wanted)) return deny(`method ${wanted} is not allowed`);
    const asked = (req.headers['access-control-request-headers'] ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    for (const h of asked) {
      if (!TOKEN.test(h)) return deny(`"${h}" is not a header name`);
      const ok = this.headers === '*' ? !FORBIDDEN_WILDCARD.has(h) : this.headers.has(h);
      if (!ok) return deny(`request header ${h} is not allowed`);
    }
    if (req.headers['access-control-request-private-network'] === 'true') {
      if (!this.p.allowPrivateNetwork) return deny('private network access is not allowed');
      base['access-control-allow-private-network'] = 'true';
    }
    base['access-control-allow-methods'] = [...this.methods].join(', ');
    if (asked.length) base['access-control-allow-headers'] = asked.join(', ');
    base['access-control-max-age'] = String(this.p.maxAgeSec ?? 600);
    return { action: 'preflight', status: 204, headers: { ...base, vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' }, reason: 'preflight allowed' };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cookies

export type SameSite = 'Strict' | 'Lax' | 'None';

export interface Cookie {
  readonly name: string;
  readonly value: string;
  /** Lower case, no leading dot; absent for a host-only cookie. */
  readonly domain?: string;
  readonly path?: string;
  /** Absolute expiry in ms since the epoch; absent for a session cookie. */
  readonly expires?: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: SameSite;
  readonly partitioned: boolean;
}

const MAX_COOKIE = 4096;
const MAX_ATTR = 1024;
const MAX_LIFETIME_MS = 400 * 86_400_000;
const NAME_OK = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** cookie-octet from RFC 6265: no controls, space, double quote, comma, semicolon or backslash. */
const VALUE_OK = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const PATH_OK = /^[\x20-\x3a\x3c-\x7e]*$/;

/** Throws a CookieError when a name or value would break out of its header. */
export function checkNameValue(name: string, value: string): void {
  if (!NAME_OK.test(name)) throw new CookieError(`"${name}" is not a valid cookie name`);
  const v = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (!VALUE_OK.test(v)) throw new CookieError('a cookie value may not contain controls, spaces, quotes, commas, semicolons or backslashes: encode it');
}

function prefixRule(c: Cookie, secureOrigin: boolean | undefined): void {
  const n = c.name.toLowerCase();
  if (n.startsWith('__secure-') && (!c.secure || secureOrigin === false)) throw new CookieError('a __Secure- cookie must be Secure and set over https');
  if (n.startsWith('__host-')) {
    if (!c.secure || secureOrigin === false) throw new CookieError('a __Host- cookie must be Secure and set over https');
    if (c.domain !== undefined) throw new CookieError('a __Host- cookie cannot have a Domain');
    if (c.path !== '/') throw new CookieError('a __Host- cookie must have Path=/');
  }
}

function checked(c: Cookie, secureOrigin?: boolean): Cookie {
  checkNameValue(c.name, c.value);
  if (c.sameSite === 'None' && !c.secure) throw new CookieError('SameSite=None requires Secure');
  if (c.partitioned && !c.secure) throw new CookieError('a Partitioned cookie requires Secure');
  prefixRule(c, secureOrigin);
  return c;
}

/** Parses one Set-Cookie header value. `now` fixes Max-Age; the result is checked against the prefix and SameSite rules. */
export function parseSetCookie(header: string, now: number, secureOrigin?: boolean): Cookie {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(header)) throw new CookieError('a cookie header may not contain control characters');
  if (header.length > MAX_COOKIE) throw new CookieError(`a cookie may be at most ${MAX_COOKIE} bytes`);
  const parts = header.split(';');
  const first = parts.shift()!;
  const eq = first.indexOf('=');
  if (eq < 0) throw new CookieError('a cookie needs a name and a value joined by "="');
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) throw new CookieError('a cookie needs a name');
  let domain: string | undefined;
  let path: string | undefined;
  let expires: number | undefined;
  let maxAge: number | undefined;
  let secure = false;
  let httpOnly = false;
  let partitioned = false;
  let sameSite: SameSite | undefined;
  for (const raw of parts) {
    const i = raw.indexOf('=');
    const k = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : raw.slice(i + 1).trim();
    if (v.length > MAX_ATTR) continue;
    if (k === 'domain') {
      const d = v.replace(/^\./, '').toLowerCase();
      domain = d || undefined;
    } else if (k === 'path') path = v.startsWith('/') ? v : undefined;
    else if (k === 'expires') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) expires = t;
    } else if (k === 'max-age') {
      if (/^-?\d+$/.test(v)) maxAge = Number(v);
    } else if (k === 'secure') secure = true;
    else if (k === 'httponly') httpOnly = true;
    else if (k === 'partitioned') partitioned = true;
    else if (k === 'samesite') {
      const s = v.toLowerCase();
      sameSite = s === 'strict' ? 'Strict' : s === 'lax' ? 'Lax' : s === 'none' ? 'None' : undefined;
    }
  }
  const lifetime = maxAge !== undefined ? now + maxAge * 1000 : expires;
  if (path !== undefined && !PATH_OK.test(path)) path = undefined;
  const c: Cookie = {
    name,
    value,
    ...(domain !== undefined ? { domain } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(lifetime !== undefined ? { expires: Math.min(lifetime, now + MAX_LIFETIME_MS) } : {}),
    secure,
    httpOnly,
    ...(sameSite ? { sameSite } : {}),
    partitioned,
  };
  return checked(c, secureOrigin);
}

/** A Set-Cookie header value for a cookie, refusing anything that would not survive a browser or would inject. */
export function serializeSetCookie(c: Cookie, now: number): string {
  checked(c);
  if (c.domain !== undefined && !/^[a-z0-9.-]+$/i.test(c.domain)) throw new CookieError('the Domain is not a host name');
  if (c.path !== undefined && (!c.path.startsWith('/') || !PATH_OK.test(c.path))) throw new CookieError('the Path must start with "/" and have no semicolons or controls');
  const out = [`${c.name}=${c.value}`];
  if (c.expires !== undefined) {
    out.push(`Expires=${new Date(c.expires).toUTCString()}`);
    out.push(`Max-Age=${Math.max(0, Math.round((c.expires - now) / 1000))}`);
  }
  if (c.domain !== undefined) out.push(`Domain=${c.domain}`);
  if (c.path !== undefined) out.push(`Path=${c.path}`);
  if (c.secure) out.push('Secure');
  if (c.httpOnly) out.push('HttpOnly');
  if (c.sameSite) out.push(`SameSite=${c.sameSite}`);
  if (c.partitioned) out.push('Partitioned');
  const s = out.join('; ');
  if (s.length > MAX_COOKIE) throw new CookieError(`a cookie may be at most ${MAX_COOKIE} bytes`);
  return s;
}

/** The pairs in a request Cookie header, in order. Malformed pieces are skipped. */
export function parseCookieHeader(header: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const piece of header.split(';')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    const name = piece.slice(0, i).trim();
    let value = piece.slice(i + 1).trim();
    if (!name || !NAME_OK.test(name)) continue;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out.push({ name, value });
  }
  return out;
}

const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

/** RFC 6265 domain-match: equal, or the host ends with "." plus the domain and is not an IP address. */
export function domainMatch(host: string, domain: string): boolean {
  return host === domain || (!isIp(host) && host.endsWith(`.${domain}`));
}

/** RFC 6265 path-match. */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** The default cookie path for a request path: up to, not including, the last "/". */
export function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/';
  const i = requestPath.lastIndexOf('/');
  return i <= 0 ? '/' : requestPath.slice(0, i);
}

/** Last two labels, or the host itself: a stand-in for the registrable domain when no public suffix list is given. */
export const defaultRegistrable = (host: string): string => (isIp(host) ? host : host.split('.').slice(-2).join('.'));

/** Whether two URLs are same-site: same scheme and same registrable domain. */
export function sameSite(a: string, b: string, registrable: (host: string) => string = defaultRegistrable): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.protocol === ub.protocol && registrable(ua.hostname) === registrable(ub.hostname);
}

export interface JarContext {
  readonly url: string;
  /** Whether the request is same-site with the page that caused it. */
  readonly sameSite: boolean;
  /** A top-level navigation with a safe method: Lax cookies are sent. */
  readonly topLevelNavigation?: boolean;
}

export interface JarOptions {
  readonly now: () => number;
  /** Domains a cookie may not be set for (the public suffix list). Default: any single label. */
  readonly isPublicSuffix?: (domain: string) => boolean;
  readonly maxPerDomain?: number;
  readonly maxTotal?: number;
}

interface Stored {
  cookie: Cookie;
  host: string;
  hostOnly: boolean;
  path: string;
  created: number;
  accessed: number;
}

export type SetResult = { readonly stored: true; readonly cookie: Cookie } | { readonly stored: false; readonly reason: string };

export class CookieJar {
  private readonly jar = new Map<string, Stored>();
  private readonly o: Required<Omit<JarOptions, 'isPublicSuffix'>> & { isPublicSuffix: (d: string) => boolean };
  private tick = 0;

  constructor(o: JarOptions) {
    this.o = { now: o.now, maxPerDomain: o.maxPerDomain ?? 50, maxTotal: o.maxTotal ?? 3000, isPublicSuffix: o.isPublicSuffix ?? ((d) => !d.includes('.')) };
  }

  get size(): number {
    return this.jar.size;
  }

  /** Applies a Set-Cookie header received for a URL. A cookie that is refused says why; an expired one deletes. */
  setFromHeader(header: string, ctx: JarContext): SetResult {
    const url = new URL(ctx.url);
    const host = url.hostname.toLowerCase();
    const secureUrl = url.protocol === 'https:' || host === 'localhost';
    const now = this.o.now();
    let c: Cookie;
    try {
      c = parseSetCookie(header, now, secureUrl);
    } catch (e) {
      return { stored: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!ctx.sameSite && c.sameSite !== 'None') return { stored: false, reason: 'a cross-site response may only set SameSite=None cookies' };
    if (c.secure && !secureUrl) return { stored: false, reason: 'a Secure cookie cannot be set over plain http' };
    let hostOnly = true;
    let domainOf = host;
    if (c.domain !== undefined) {
      if (this.o.isPublicSuffix(c.domain)) {
        if (c.domain !== host) return { stored: false, reason: `${c.domain} is a public suffix` };
      } else {
        if (!domainMatch(host, c.domain)) return { stored: false, reason: `the Domain ${c.domain} does not cover ${host}` };
        hostOnly = false;
        domainOf = c.domain;
      }
    }
    const path = c.path ?? defaultPath(url.pathname);
    const key = `${domainOf}|${path}|${c.name}`;
    const old = this.jar.get(key);
    if (old?.cookie.secure && !secureUrl) return { stored: false, reason: 'plain http may not overwrite a Secure cookie' };
    if (c.expires !== undefined && c.expires <= now) {
      this.jar.delete(key);
      return { stored: true, cookie: c };
    }
    // A cookie sent over http that shadows a Secure one of the same name on a longer-lived path is also refused above; here the host/path is the same.
    this.jar.set(key, { cookie: c, host: domainOf, hostOnly, path, created: old?.created ?? ++this.tick, accessed: ++this.tick });
    this.evict(domainOf);
    return { stored: true, cookie: c };
  }

  /** The Cookie header to send for a request, or undefined when none apply. */
  cookieHeader(ctx: JarContext): string | undefined {
    const url = new URL(ctx.url);
    const host = url.hostname.toLowerCase();
    const secureUrl = url.protocol === 'https:' || host === 'localhost';
    const now = this.o.now();
    const send: Stored[] = [];
    for (const [key, s] of this.jar) {
      if (s.cookie.expires !== undefined && s.cookie.expires <= now) {
        this.jar.delete(key);
        continue;
      }
      if (s.hostOnly ? host !== s.host : !domainMatch(host, s.host)) continue;
      if (!pathMatch(url.pathname || '/', s.path)) continue;
      if (s.cookie.secure && !secureUrl) continue;
      const ss = s.cookie.sameSite ?? 'Lax';
      if (!ctx.sameSite && ss !== 'None' && !(ss === 'Lax' && ctx.topLevelNavigation)) continue;
      send.push(s);
    }
    if (!send.length) return undefined;
    send.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    for (const s of send) s.accessed = ++this.tick;
    return send.map((s) => `${s.cookie.name}=${s.cookie.value}`).join('; ');
  }

  private evict(domain: string): void {
    const drop = (list: [string, Stored][], keep: number) => {
      list.sort((a, b) => a[1].accessed - b[1].accessed);
      for (const [k] of list.slice(0, Math.max(0, list.length - keep))) this.jar.delete(k);
    };
    drop([...this.jar].filter(([, s]) => s.host === domain), this.o.maxPerDomain);
    drop([...this.jar], this.o.maxTotal);
  }
}
