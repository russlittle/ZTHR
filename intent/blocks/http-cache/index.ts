/**
 * The rules of HTTP caching and conditional requests, as pure functions over headers, for any resource a server
 * serves or a proxy or client stores. They follow RFC 9110 (semantics: entity tags, dates, preconditions, ranges) and
 * RFC 9111 (caching), and RFC 5861 for stale-while-revalidate and stale-if-error.
 *
 * - Validators: entity tags parsed and compared (strong and weak comparison), a tag made from content, HTTP dates in
 *   all three historic forms read and one form written.
 * - Preconditions in the order of RFC 9110 section 13.2.2 (If-Match, If-Unmodified-Since, If-None-Match,
 *   If-Modified-Since): the answer is 200 to go on, 304 for "not modified" or 412 "precondition failed", with the
 *   reason; unparsable dates are ignored as the RFC requires, and `*` means "any current representation". The 304
 *   carries the headers a 304 must carry.
 * - Cache-Control parsed (quoted values, duplicates take the strictest, invalid numbers make a response stale) and
 *   written; storability and freshness worked out with the RFC 9111 age calculation, heuristic freshness from
 *   Last-Modified (a tenth of its age, capped), and the stale-serving allowances.
 * - Vary: a key from the request headers the response varies on, `Vary: *` never matching, merging and adding.
 * - Ranges: `Range: bytes=` with first-last, open and suffix forms, unsatisfiable ranges (416 with its
 *   Content-Range), overlap coalescing, a limit on how many ranges are honoured, If-Range, and the multipart/byteranges
 *   body; ranges are ignored (the whole resource answers) when the header is not understood, as the RFC says.
 * - `respond` puts it together for one resource: given the request headers and the resource's validators and size, the
 *   status, the headers and the byte ranges to send.
 *
 * Not here: storing responses, content negotiation, compression (a `Range` applies to the bytes as sent), and the
 * network. Pure: the clock and the boundary string are arguments.
 */
import { createHash } from 'node:crypto';

export type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;

/** A header's value with multiple lines joined by commas; the name is matched without regard to case. */
export function header(h: Headers, name: string): string | undefined {
  const lc = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lc) {
      const v = h[k];
      return v === undefined ? undefined : typeof v === 'string' ? v : v.join(', ');
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- dates

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function utc(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const t = Date.UTC(y, mo, d, h, mi, Math.min(s, 59));
  const dt = new Date(t);
  return dt.getUTCMonth() === mo && dt.getUTCDate() === d ? t : null;
}

/** An HTTP-date (IMF-fixdate, RFC 850 or asctime form) as milliseconds since 1970, or null if it is not one. */
export function parseHttpDate(s: string, now: number = Date.now()): number | null {
  const v = s.trim();
  let m = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(v);
  if (m) return utc(Number(m[3]), MONTHS.indexOf(m[2]!), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  m = /^(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(v);
  if (m) {
    // Two-digit years: the century that puts the date within 50 years of now, as RFC 9110 requires.
    const nowYear = new Date(now).getUTCFullYear();
    let y = Math.floor(nowYear / 100) * 100 + Number(m[3]);
    if (y > nowYear + 50) y -= 100;
    return utc(y, MONTHS.indexOf(m[2]!), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  m = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(v);
  if (m) return utc(Number(m[6]), MONTHS.indexOf(m[1]!), Number(m[2]!.trim()), Number(m[3]), Number(m[4]), Number(m[5]));
  return null;
}

/** The IMF-fixdate form, the only one to send. */
export function formatHttpDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`;
}

const sec = (ms: number) => Math.floor(ms / 1000);

// ---------------------------------------------------------------- entity tags

export interface ETag {
  readonly weak: boolean;
  /** The text between the quotes. */
  readonly value: string;
}

/** One entity tag: "abc" or W/"abc". Null if it is not one. */
export function parseETag(s: string): ETag | null {
  const m = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(s.trim());
  return m ? { weak: m[1] !== undefined, value: m[2]! } : null;
}

export function formatETag(t: ETag): string {
  if (!/^[\x21\x23-\x7e\x80-\xff]*$/.test(t.value)) throw new TypeError('an entity tag cannot hold a quote, space or control character');
  return `${t.weak ? 'W/' : ''}"${t.value}"`;
}

/** The tags of an If-Match or If-None-Match value; '*' for any; null when the value is malformed. */
export function parseETagList(s: string): ETag[] | '*' | null {
  const v = s.trim();
  if (v === '*') return '*';
  const out: ETag[] = [];
  let i = 0;
  const re = /(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"/y;
  while (i < v.length) {
    re.lastIndex = i;
    const m = re.exec(v);
    if (!m) return null;
    out.push({ weak: m[1] !== undefined, value: m[2]! });
    i = re.lastIndex;
    while (v[i] === ' ' || v[i] === '\t') i++;
    if (i >= v.length) break;
    if (v[i] !== ',') return null;
    i++;
    while (v[i] === ' ' || v[i] === '\t') i++;
    if (i >= v.length) return null;
  }
  return out.length ? out : null;
}

/** Strong comparison: both strong and equal. Weak comparison: equal, weakness ignored. RFC 9110 section 8.8.3.2. */
export const strongMatch = (a: ETag, b: ETag): boolean => !a.weak && !b.weak && a.value === b.value;
export const weakMatch = (a: ETag, b: ETag): boolean => a.value === b.value;

/** A strong tag from content, or a weak one with `weak: true` (for content that may differ in bytes but not meaning). */
export function etagFor(content: string | Uint8Array, o: { weak?: boolean } = {}): string {
  const h = createHash('sha256').update(content).digest('base64url').slice(0, 27);
  return formatETag({ weak: o.weak === true, value: h });
}

// ---------------------------------------------------------------- preconditions

export interface Validators {
  /** False when there is no current representation at all (a PUT that would create). Default true. */
  readonly exists?: boolean;
  readonly etag?: string;
  /** Last modification, in ms since 1970. */
  readonly lastModified?: number;
}
export interface Evaluation {
  readonly status: 200 | 304 | 412;
  /** Which header decided, when it is not 200. */
  readonly decidedBy?: 'if-match' | 'if-unmodified-since' | 'if-none-match' | 'if-modified-since';
  /** Headers that were present but could not be read, and so were ignored. */
  readonly ignored: readonly string[];
}

/** RFC 9110 section 13.2.2: the first precondition that fails decides. */
export function evaluatePreconditions(method: string, req: Headers, current: Validators, now: number = Date.now()): Evaluation {
  const m = method.toUpperCase();
  const safe = m === 'GET' || m === 'HEAD';
  const exists = current.exists !== false;
  const cur = current.etag ? parseETag(current.etag) : null;
  const ignored: string[] = [];
  const lm = current.lastModified === undefined ? null : sec(current.lastModified);

  const ifMatch = header(req, 'if-match');
  const ifUnmod = header(req, 'if-unmodified-since');
  const ifNone = header(req, 'if-none-match');
  const ifMod = header(req, 'if-modified-since');

  let matchList: ETag[] | '*' | null = null;
  if (ifMatch !== undefined) {
    matchList = parseETagList(ifMatch);
    if (matchList === null) ignored.push('if-match');
  }
  if (matchList !== null) {
    const ok = matchList === '*' ? exists : cur !== null && exists && matchList.some((t) => strongMatch(t, cur));
    if (!ok) return { status: 412, decidedBy: 'if-match', ignored };
  } else if (ifUnmod !== undefined) {
    const d = parseHttpDate(ifUnmod, now);
    if (d === null) ignored.push('if-unmodified-since');
    else if (lm !== null && lm > sec(d)) return { status: 412, decidedBy: 'if-unmodified-since', ignored };
  }

  let noneList: ETag[] | '*' | null = null;
  if (ifNone !== undefined) {
    noneList = parseETagList(ifNone);
    if (noneList === null) ignored.push('if-none-match');
  }
  if (noneList !== null) {
    const hit = noneList === '*' ? exists : cur !== null && exists && noneList.some((t) => weakMatch(t, cur));
    if (hit) return { status: safe ? 304 : 412, decidedBy: 'if-none-match', ignored };
  } else if (safe && ifMod !== undefined) {
    const d = parseHttpDate(ifMod, now);
    if (d === null) ignored.push('if-modified-since');
    else if (lm !== null && lm <= sec(d)) return { status: 304, decidedBy: 'if-modified-since', ignored };
  }
  return { status: 200, ignored };
}

const NOT_MODIFIED_KEEPS = ['cache-control', 'content-location', 'date', 'etag', 'expires', 'last-modified', 'vary'];

/** The headers of a 304: only those a 304 must or may repeat, never the body's length or type. */
export function notModifiedHeaders(full: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of NOT_MODIFIED_KEEPS) {
    const v = header(full, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** What a cache sends to check a stored response with the server. */
export function revalidationHeaders(stored: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const e = header(stored, 'etag');
  const lm = header(stored, 'last-modified');
  if (e && parseETag(e)) out['if-none-match'] = e;
  if (lm && parseHttpDate(lm) !== null) out['if-modified-since'] = lm;
  return out;
}

const NOT_UPDATED_BY_304 = new Set(['content-length', 'content-encoding', 'content-range', 'content-type', 'transfer-encoding', 'connection', 'keep-alive']);

/** The stored response's headers after a 304: its fields replaced by the ones the 304 carried (RFC 9111 section 3.2). */
export function mergeNotModified(stored: Headers, fresh: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(stored)) {
    const v = header(stored, k);
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  for (const k of Object.keys(fresh)) {
    const lc = k.toLowerCase();
    const v = header(fresh, k);
    if (v !== undefined && !NOT_UPDATED_BY_304.has(lc)) out[lc] = v;
  }
  return out;
}

// ---------------------------------------------------------------- Cache-Control

export interface CacheControl {
  readonly maxAge: number | null;
  readonly sMaxAge: number | null;
  readonly noCache: boolean | readonly string[];
  readonly noStore: boolean;
  readonly private: boolean | readonly string[];
  readonly public: boolean;
  readonly mustRevalidate: boolean;
  readonly proxyRevalidate: boolean;
  readonly noTransform: boolean;
  readonly immutable: boolean;
  readonly staleWhileRevalidate: number | null;
  readonly staleIfError: number | null;
  /** Directives whose number could not be read: the response is to be treated as stale. */
  readonly invalid: readonly string[];
  /** Everything else, by name. */
  readonly extensions: Readonly<Record<string, string | true>>;
}

const MAX_DELTA = 2_147_483_648;

function splitDirectives(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q && c === '\\') {
      cur += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') q = !q;
    if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export function parseCacheControl(value: string | undefined): CacheControl {
  const nums = { 'max-age': [] as number[], 's-maxage': [] as number[], 'stale-while-revalidate': [] as number[], 'stale-if-error': [] as number[] };
  const invalid: string[] = [];
  const flags = new Set<string>();
  const lists: Record<string, string[]> = {};
  const extensions: Record<string, string | true> = {};
  for (const d of splitDirectives(value ?? '')) {
    const eq = d.indexOf('=');
    const name = (eq < 0 ? d : d.slice(0, eq)).trim().toLowerCase();
    let arg = eq < 0 ? undefined : d.slice(eq + 1).trim();
    if (arg !== undefined && arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) arg = arg.slice(1, -1).replace(/\\(.)/g, '$1');
    if (name in nums) {
      if (arg !== undefined && /^\d+$/.test(arg)) nums[name as keyof typeof nums].push(Math.min(Number(arg), MAX_DELTA));
      else invalid.push(name);
    } else if (name === 'no-cache' || name === 'private') {
      flags.add(name);
      if (arg) lists[name] = arg.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    } else if (['no-store', 'public', 'must-revalidate', 'proxy-revalidate', 'no-transform', 'immutable'].includes(name)) flags.add(name);
    else if (name) extensions[name] = arg ?? true;
  }
  const least = (a: number[]) => (a.length ? Math.min(...a) : null);
  return {
    maxAge: least(nums['max-age']),
    sMaxAge: least(nums['s-maxage']),
    noCache: lists['no-cache'] ?? flags.has('no-cache'),
    noStore: flags.has('no-store'),
    private: lists['private'] ?? flags.has('private'),
    public: flags.has('public'),
    mustRevalidate: flags.has('must-revalidate'),
    proxyRevalidate: flags.has('proxy-revalidate'),
    noTransform: flags.has('no-transform'),
    immutable: flags.has('immutable'),
    staleWhileRevalidate: least(nums['stale-while-revalidate']),
    staleIfError: least(nums['stale-if-error']),
    invalid,
    extensions,
  };
}

/** A Cache-Control value from a plain description; directives are written in a fixed order. */
export function formatCacheControl(c: Partial<Record<'maxAge' | 'sMaxAge' | 'staleWhileRevalidate' | 'staleIfError', number>> & Partial<Record<'public' | 'private' | 'noCache' | 'noStore' | 'mustRevalidate' | 'proxyRevalidate' | 'noTransform' | 'immutable', boolean>>): string {
  const out: string[] = [];
  if (c.public) out.push('public');
  if (c.private) out.push('private');
  if (c.noCache) out.push('no-cache');
  if (c.noStore) out.push('no-store');
  const n = (name: string, v: number | undefined) => {
    if (v === undefined) return;
    if (!Number.isInteger(v) || v < 0) throw new TypeError(`${name} must be a whole number of seconds, zero or more`);
    out.push(`${name}=${v}`);
  };
  n('max-age', c.maxAge);
  n('s-maxage', c.sMaxAge);
  if (c.mustRevalidate) out.push('must-revalidate');
  if (c.proxyRevalidate) out.push('proxy-revalidate');
  if (c.noTransform) out.push('no-transform');
  if (c.immutable) out.push('immutable');
  n('stale-while-revalidate', c.staleWhileRevalidate);
  n('stale-if-error', c.staleIfError);
  return out.join(', ');
}

// ---------------------------------------------------------------- storing and freshness

const HEURISTIC_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501]);

export interface StoreInput {
  readonly method: string;
  readonly status: number;
  readonly response: Headers;
  /** A shared cache (proxy, CDN) rather than a private one (a browser). */
  readonly shared: boolean;
  readonly requestHadAuthorization?: boolean;
}

/** Whether a response may be stored, and if not, why (RFC 9111 section 3). */
export function storable(i: StoreInput): { ok: boolean; reason: string } {
  const cc = parseCacheControl(header(i.response, 'cache-control'));
  const m = i.method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return { ok: false, reason: `${m} responses are not stored here` };
  if (i.status === 206) return { ok: false, reason: 'a partial response is not stored on its own' };
  if (cc.noStore) return { ok: false, reason: 'no-store' };
  if (i.shared && cc.private) return { ok: false, reason: 'private, and this is a shared cache' };
  const explicit = cc.maxAge !== null || (i.shared && cc.sMaxAge !== null) || header(i.response, 'expires') !== undefined || cc.public;
  if (i.shared && i.requestHadAuthorization && !(cc.public || cc.sMaxAge !== null || cc.mustRevalidate)) return { ok: false, reason: 'the request was authorised and the response does not allow a shared cache to keep it' };
  if (!HEURISTIC_STATUS.has(i.status) && !explicit) return { ok: false, reason: `status ${i.status} is stored only with explicit freshness` };
  if (header(i.response, 'vary')?.trim() === '*') return { ok: false, reason: 'Vary: *' };
  return { ok: true, reason: 'storable' };
}

export interface FreshnessInput {
  readonly response: Headers;
  readonly shared: boolean;
  /** When the request that got this response was sent, and when its response arrived, in ms. */
  readonly requestTime: number;
  readonly responseTime: number;
  readonly now: number;
  /** The most heuristic freshness allowed, in seconds. Default one day. */
  readonly heuristicCapSeconds?: number;
}
export interface Freshness {
  readonly fresh: boolean;
  readonly ageSeconds: number;
  readonly lifetimeSeconds: number;
  readonly heuristic: boolean;
  /** Seconds past its lifetime; 0 while fresh. */
  readonly staleBySeconds: number;
  /** A stale response may be served while a refresh runs (stale-while-revalidate). */
  readonly serveWhileRevalidating: boolean;
  /** A stale response may be served if the origin fails (stale-if-error). */
  readonly serveIfError: boolean;
  readonly mustRevalidate: boolean;
  readonly reason: string;
}

/** RFC 9111 section 4.2: the current age against the freshness lifetime. */
export function freshness(i: FreshnessInput): Freshness {
  const cc = parseCacheControl(header(i.response, 'cache-control'));
  const dateH = header(i.response, 'date');
  const date = dateH === undefined ? null : parseHttpDate(dateH, i.now);
  const dateValue = date ?? i.responseTime;
  const ageH = header(i.response, 'age');
  const ageValue = ageH !== undefined && /^\d+$/.test(ageH.trim()) ? Math.min(Number(ageH), MAX_DELTA) : 0;
  const apparent = Math.max(0, (i.responseTime - dateValue) / 1000);
  const corrected = ageValue + Math.max(0, (i.responseTime - i.requestTime) / 1000);
  const initial = Math.max(apparent, corrected);
  const age = Math.floor(initial + Math.max(0, (i.now - i.responseTime) / 1000));

  let lifetime = 0;
  let heuristic = false;
  let reason = '';
  const noCache = cc.noCache !== false;
  const mustRev = cc.mustRevalidate || (i.shared && cc.proxyRevalidate);
  if (noCache) reason = 'no-cache: it must be checked every time';
  else if (cc.invalid.length) reason = `unreadable ${cc.invalid.join(', ')}: treated as stale`;
  else if (i.shared && cc.sMaxAge !== null) {
    lifetime = cc.sMaxAge;
    reason = 's-maxage';
  } else if (cc.maxAge !== null) {
    lifetime = cc.maxAge;
    reason = 'max-age';
  } else if (header(i.response, 'expires') !== undefined) {
    const exp = parseHttpDate(header(i.response, 'expires')!, i.now);
    lifetime = exp === null ? 0 : Math.max(0, Math.floor((exp - dateValue) / 1000));
    reason = exp === null ? 'an unreadable Expires means already expired' : 'Expires';
  } else {
    const lmH = header(i.response, 'last-modified');
    const lm = lmH === undefined ? null : parseHttpDate(lmH, i.now);
    if (lm !== null && lm < dateValue) {
      lifetime = Math.min(Math.floor((dateValue - lm) / 10_000), i.heuristicCapSeconds ?? 86_400);
      heuristic = true;
      reason = 'heuristic: a tenth of the time since it last changed';
    } else reason = 'no freshness information';
  }
  const fresh = !noCache && !cc.invalid.length && age < lifetime;
  const stale = fresh ? 0 : Math.max(0, age - lifetime);
  const allowStale = !mustRev && !noCache;
  return {
    fresh,
    ageSeconds: age,
    lifetimeSeconds: lifetime,
    heuristic,
    staleBySeconds: stale,
    serveWhileRevalidating: allowStale && !fresh && cc.staleWhileRevalidate !== null && stale <= cc.staleWhileRevalidate,
    serveIfError: allowStale && !fresh && cc.staleIfError !== null && stale <= cc.staleIfError,
    mustRevalidate: mustRev,
    reason,
  };
}

// ---------------------------------------------------------------- Vary

/** The header names a response varies on, lower case; '*' when it varies on everything. */
export function parseVary(value: string | undefined): '*' | string[] {
  const names = (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return names.includes('*') ? '*' : [...new Set(names)].sort();
}

function normalise(name: string, value: string | undefined): string {
  if (value === undefined) return '';
  const v = value.replace(/\s+/g, ' ').trim();
  if (name === 'accept-encoding' || name === 'accept-language' || name === 'accept') {
    return v.split(',').map((x) => x.trim().toLowerCase().replace(/\s*;\s*/g, ';')).filter(Boolean).sort().join(',');
  }
  return v;
}

/**
 * A key for the part of a request a response depends on: stored responses are found by URL and this key. Null when
 * the response varies on everything (`Vary: *`), which never matches and is not to be reused.
 */
export function varyKey(vary: string | undefined, req: Headers): string | null {
  const names = parseVary(vary);
  if (names === '*') return null;
  return names.map((n) => `${n}=${normalise(n, header(req, n))}`).join('\n');
}

/** Whether a new request may be answered by a stored response: the same values for every field it varied on. */
export function varyMatches(vary: string | undefined, storedRequest: Headers, newRequest: Headers): boolean {
  const a = varyKey(vary, storedRequest);
  const b = varyKey(vary, newRequest);
  return a !== null && b !== null && a === b;
}

/** A Vary value with a field added, without duplicates; `*` absorbs everything. */
export function addVary(existing: string | undefined, field: string): string {
  const cur = parseVary(existing);
  if (cur === '*' || field.trim() === '*') return '*';
  const f = field.trim().toLowerCase();
  return [...new Set([...cur, f])].sort().map((n) => n.replace(/(^|-)([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())).join(', ');
}

// ---------------------------------------------------------------- ranges

export interface ByteRange {
  /** First byte, inclusive. */
  readonly start: number;
  /** Last byte, inclusive. */
  readonly end: number;
}
export type RangeResult =
  | { readonly kind: 'ignore'; readonly why: string }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'ranges'; readonly ranges: readonly ByteRange[] };

export interface RangeLimits {
  /** Most range specs read from the header; past this the header is ignored. Default 32. */
  readonly maxSpecs?: number;
  /** Most ranges sent after overlaps are joined; past this the whole resource is sent. Default 8. */
  readonly maxRanges?: number;
}

/** The byte ranges a Range header asks for in a resource of `size` bytes. RFC 9110 section 14. */
export function parseRange(value: string | undefined, size: number, lim: RangeLimits = {}): RangeResult {
  if (value === undefined) return { kind: 'ignore', why: 'no Range header' };
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(value);
  if (!m) return { kind: 'ignore', why: 'a unit other than bytes' };
  const specs = m[1]!.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (!specs.length) return { kind: 'ignore', why: 'no ranges' };
  if (specs.length > (lim.maxSpecs ?? 32)) return { kind: 'ignore', why: 'too many ranges' };
  const found: ByteRange[] = [];
  for (const s of specs) {
    const r = /^(\d{1,15})?\s*-\s*(\d{1,15})?$/.exec(s);
    if (!r || (r[1] === undefined && r[2] === undefined)) return { kind: 'ignore', why: `"${s}" is not a byte range` };
    if (r[1] === undefined) {
      const n = Number(r[2]);
      if (n === 0 || size === 0) continue;
      found.push({ start: Math.max(0, size - n), end: size - 1 });
    } else {
      const a = Number(r[1]);
      const b = r[2] === undefined ? Infinity : Number(r[2]);
      if (b < a) return { kind: 'ignore', why: `"${s}" ends before it starts` };
      if (a >= size) continue;
      found.push({ start: a, end: Math.min(b, size - 1) });
    }
  }
  if (!found.length) return { kind: 'unsatisfiable' };
  found.sort((x, y) => x.start - y.start);
  const joined: ByteRange[] = [];
  for (const r of found) {
    const last = joined[joined.length - 1];
    if (last && r.start <= last.end + 1) joined[joined.length - 1] = { start: last.start, end: Math.max(last.end, r.end) };
    else joined.push(r);
  }
  if (joined.length > (lim.maxRanges ?? 8)) return { kind: 'ignore', why: 'too many separate ranges' };
  return { kind: 'ranges', ranges: joined };
}

/** Whether If-Range lets the Range header apply: a strong tag that matches, or a date that equals Last-Modified exactly. */
export function ifRangeHolds(ifRange: string | undefined, current: Validators, now: number = Date.now()): boolean {
  if (ifRange === undefined) return true;
  const v = ifRange.trim();
  const tag = parseETag(v);
  if (tag) {
    const cur = current.etag ? parseETag(current.etag) : null;
    return cur !== null && strongMatch(tag, cur);
  }
  const d = parseHttpDate(v, now);
  return d !== null && current.lastModified !== undefined && sec(current.lastModified) === sec(d);
}

export const contentRange = (r: ByteRange, size: number): string => `bytes ${r.start}-${r.end}/${size}`;

export interface Resource extends Validators {
  readonly size: number;
  readonly contentType: string;
  readonly cacheControl?: string;
  readonly vary?: string;
}
export interface Response {
  readonly status: 200 | 206 | 304 | 412 | 416;
  readonly headers: Record<string, string>;
  /** The byte ranges to send; null when the body is the whole resource or there is none. */
  readonly ranges: readonly ByteRange[] | null;
  /** The multipart boundary when several ranges are sent. */
  readonly boundary?: string;
  /** Number of body bytes, or null for no body. */
  readonly contentLength: number | null;
}

const partHead = (boundary: string, type: string, r: ByteRange, size: number) => `--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: ${contentRange(r, size)}\r\n\r\n`;

/** The exact length of a multipart/byteranges body. */
export function multipartLength(ranges: readonly ByteRange[], size: number, type: string, boundary: string): number {
  let n = 0;
  for (const r of ranges) n += partHead(boundary, type, r, size).length + (r.end - r.start + 1) + 2;
  return n + `--${boundary}--\r\n`.length;
}

/** The multipart/byteranges body, read from the resource with `read(start, end)` (end inclusive). */
export function multipartBody(ranges: readonly ByteRange[], size: number, type: string, boundary: string, read: (start: number, end: number) => Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const r of ranges) parts.push(enc.encode(partHead(boundary, type, r, size)), read(r.start, r.end), enc.encode('\r\n'));
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The whole decision for a GET or HEAD (or a write with preconditions) of one resource: preconditions first, then
 * Range and If-Range. `boundary` is used only if several ranges are sent.
 */
export function respond(method: string, req: Headers, res: Resource, o: { now?: number; boundary?: string } & RangeLimits = {}): Response {
  const now = o.now ?? Date.now();
  const base: Record<string, string> = {};
  if (res.etag) base['etag'] = res.etag;
  if (res.lastModified !== undefined) base['last-modified'] = formatHttpDate(res.lastModified);
  if (res.cacheControl) base['cache-control'] = res.cacheControl;
  if (res.vary) base['vary'] = res.vary;
  const ev = evaluatePreconditions(method, req, res, now);
  if (ev.status === 304) return { status: 304, headers: notModifiedHeaders(base), ranges: null, contentLength: null };
  if (ev.status === 412) return { status: 412, headers: {}, ranges: null, contentLength: null };
  const full: Response = { status: 200, headers: { ...base, 'accept-ranges': 'bytes', 'content-type': res.contentType, 'content-length': String(res.size) }, ranges: null, contentLength: res.size };
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return full;
  const rangeHeader = header(req, 'range');
  if (rangeHeader === undefined || !ifRangeHolds(header(req, 'if-range'), res, now)) return full;
  const r = parseRange(rangeHeader, res.size, o);
  if (r.kind === 'ignore') return full;
  if (r.kind === 'unsatisfiable') return { status: 416, headers: { ...base, 'content-range': `bytes */${res.size}`, 'accept-ranges': 'bytes' }, ranges: null, contentLength: null };
  const rs = r.ranges;
  if (rs.length === 1 && rs[0]!.start === 0 && rs[0]!.end === res.size - 1) return full;
  if (rs.length === 1) {
    const x = rs[0]!;
    return { status: 206, headers: { ...base, 'accept-ranges': 'bytes', 'content-type': res.contentType, 'content-range': contentRange(x, res.size), 'content-length': String(x.end - x.start + 1) }, ranges: rs, contentLength: x.end - x.start + 1 };
  }
  const boundary = o.boundary ?? 'byteranges';
  const len = multipartLength(rs, res.size, res.contentType, boundary);
  return { status: 206, headers: { ...base, 'accept-ranges': 'bytes', 'content-type': `multipart/byteranges; boundary=${boundary}`, 'content-length': String(len) }, ranges: rs, boundary, contentLength: len };
}
