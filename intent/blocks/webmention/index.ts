/**
 * Webmention (W3C Recommendation, 2017) for both directions, with microformats2 reading.
 *
 * Sending: find the target's endpoint (an HTTP `Link` header with rel=webmention wins; else the first `<link>` or
 * `<a>` with rel=webmention in the HTML, in document order; a relative or empty href resolves against the final URL,
 * after up to five redirects), then POST `source` and `target` form-encoded. 200, 201 (with Location) and 202 are
 * success; anything else is a refusal with the endpoint's status.
 *
 * Receiving: validate the request (http or https, no credentials, source differs from target, target is ours, hosts
 * are not loopback or private unless allowed), fetch the source (redirects followed and re-checked each hop, size
 * capped, any of HTML, plain text or JSON), and require that it really links to the target (a, area, img, video,
 * audio, source, iframe, embed, or a string in JSON/text; fragments ignored). A source that is gone (404 or 410)
 * removes a stored mention. What the source says is read with a microformats2 parser (h-entry and h-card, p- u- dt- e-
 * properties, nested items, implied name, url and photo, rel and rel-urls, `<base>`) and classed as a reply, like,
 * repost, bookmark or plain mention from in-reply-to, like-of, repost-of and bookmark-of. Only text is kept (never
 * the source's HTML), with the author, a published date that parses, and a truncated excerpt. All fetching goes
 * through an injected `fetch`, and all time through an injected clock.
 *
 * Out of scope: DNS (a hostname that resolves to a private address is the injected fetch's job to refuse; only literal
 * and obvious private hosts are blocked here), the legacy microformats backcompat classes (hentry, vcard), the
 * Vouch extension, the legacy `http://webmention.org/` rel, retries, and rendering.
 */

export class WebmentionRejected extends Error {
  readonly code: 'bad_request' | 'bad_url' | 'blocked_host' | 'not_our_target' | 'fetch_failed' | 'too_large' | 'no_link' | 'source_gone' | 'too_many_redirects' | 'too_many_mentions';
  constructor(code: WebmentionRejected['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface FetchInit {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}
export interface FetchResult {
  readonly status: number;
  /** Lower-case names. A repeated header (Link) may be an array. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResult>;

// ==================================================================== URLs

/** Parses an http(s) URL without credentials, or throws. */
export function checkUrl(raw: string, allowPrivate = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebmentionRejected('bad_url', `not a URL: ${JSON.stringify(String(raw).slice(0, 80))}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebmentionRejected('bad_url', `only http and https are accepted, not ${u.protocol}`);
  if (u.username || u.password) throw new WebmentionRejected('bad_url', 'a URL with a user name or password is not accepted');
  if (!allowPrivate && isPrivateHost(u.hostname)) throw new WebmentionRejected('blocked_host', `${u.hostname} is not a public host`);
  return u;
}

/** True for loopback, private, link-local, carrier-grade, unspecified and obvious internal names (literals only). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain') || !h.includes('.') && !h.includes(':')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0 && Number(v4[3]) === 0);
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
    if (mapped) {
      if (mapped[1]) return isPrivateHost(mapped[1]);
      const hi = parseInt(mapped[2]!, 16);
      const lo = parseInt(mapped[3]!, 16);
      return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h);
  }
  return false;
}

/** The URL with its fragment removed, in the parser's normal form. */
export function normalize(raw: string, base?: string): string | undefined {
  try {
    const u = new URL(raw, base);
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

// ==================================================================== a small HTML tree

interface HEl {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly kids: (HEl | string)[];
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g, (m, d: string | undefined, h: string | undefined, n: string | undefined) => {
    if (n) return NAMED[n] ?? m;
    const cp = d ? Number(d) : parseInt(h!, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

const TAG = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function parseHtml(src: string, limits: { maxNodes?: number; maxDepth?: number } = {}): HEl {
  const maxNodes = limits.maxNodes ?? 100_000;
  const maxDepth = limits.maxDepth ?? 256;
  const root: HEl = { tag: '#root', attrs: {}, kids: [] };
  const stack: HEl[] = [root];
  let nodes = 0;
  let last = 0;
  const top = () => stack[stack.length - 1]!;
  const text = (t: string) => {
    if (t) top().kids.push(decodeEntities(t));
  };
  TAG.lastIndex = 0;
  for (let m = TAG.exec(src); m; m = TAG.exec(src)) {
    text(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === undefined) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (++nodes > maxNodes) break;
    const attrs: Record<string, string> = {};
    for (const a of m[3]!.matchAll(ATTR)) {
      const k = a[1]!.toLowerCase();
      if (!(k in attrs) && !['__proto__', 'constructor', 'prototype'].includes(k)) attrs[k] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    if (tag === 'li' || tag === 'dt' || tag === 'dd' || tag === 'option' || tag === 'p') {
      for (let i = stack.length - 1; i > 0; i--) {
        const t = stack[i]!.tag;
        if (t === tag) {
          stack.length = i;
          break;
        }
        if (t === 'ul' || t === 'ol' || t === 'dl' || t === 'select' || t === 'div' || t === 'td' || t === 'body') break;
      }
    }
    const el: HEl = { tag, attrs, kids: [] };
    top().kids.push(el);
    const selfClosed = m[0].endsWith('/>');
    if (VOID.has(tag) || selfClosed) continue;
    if (RAW.has(tag)) {
      const end = new RegExp(`</${tag}\\s*>`, 'ig');
      end.lastIndex = TAG.lastIndex;
      const e = end.exec(src);
      const stop = e ? e.index : src.length;
      if (tag === 'textarea' || tag === 'title') el.kids.push(decodeEntities(src.slice(TAG.lastIndex, stop)));
      TAG.lastIndex = last = e ? e.index + e[0].length : src.length;
      continue;
    }
    if (stack.length < maxDepth) stack.push(el);
  }
  text(src.slice(last));
  return root;
}

const walkEls = (el: HEl, f: (e: HEl) => void): void => {
  for (const k of el.kids) if (typeof k !== 'string') {
    f(k);
    walkEls(k, f);
  }
};

function textOf(el: HEl): string {
  const parts: string[] = [];
  const go = (e: HEl) => {
    for (const k of e.kids) {
      if (typeof k === 'string') parts.push(k);
      else if (k.tag === 'script' || k.tag === 'style' || k.tag === 'template') continue;
      else if (k.tag === 'br') parts.push('\n');
      else if (k.tag === 'img') parts.push(k.attrs['alt'] ?? k.attrs['src'] ?? '');
      else go(k);
    }
  };
  go(el);
  return parts.join('').replace(/[ \t\r\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');
function htmlOf(el: HEl): string {
  return el.kids
    .map((k) => {
      if (typeof k === 'string') return esc(k);
      const a = Object.entries(k.attrs).map(([n, v]) => ` ${n}="${escAttr(v)}"`).join('');
      return VOID.has(k.tag) ? `<${k.tag}${a}>` : `<${k.tag}${a}>${htmlOf(k)}</${k.tag}>`;
    })
    .join('');
}

// ==================================================================== microformats2

export interface Mf2Item {
  type: string[];
  properties: Record<string, (string | Mf2Item | { html: string; value: string })[]>;
  children?: Mf2Item[];
  value?: string;
}
export interface Mf2 {
  items: Mf2Item[];
  rels: Record<string, string[]>;
  'rel-urls': Record<string, { rels: string[]; text: string }>;
}

const H = /^h-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const P = /^(p|u|dt|e)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const classes = (e: HEl) => (e.attrs['class'] ?? '').split(/\s+/).filter(Boolean);

export function parseMf2(html: string, baseUrl: string): Mf2 {
  const doc = parseHtml(html);
  let base = baseUrl;
  walkEls(doc, (e) => {
    if (e.tag === 'base' && e.attrs['href'] !== undefined && base === baseUrl) base = normalizeBase(e.attrs['href'], baseUrl);
  });
  const abs = (v: string) => {
    try {
      return new URL(v.trim(), base).href;
    } catch {
      return v.trim();
    }
  };
  const urlValue = (e: HEl): string => {
    const a = e.attrs;
    if ((e.tag === 'a' || e.tag === 'area') && a['href'] !== undefined) return abs(a['href']);
    if (['img', 'audio', 'video', 'source', 'iframe', 'track', 'embed'].includes(e.tag) && a['src'] !== undefined) return abs(a['src']);
    if (e.tag === 'video' && a['poster'] !== undefined) return abs(a['poster']);
    if (e.tag === 'object' && a['data'] !== undefined) return abs(a['data']);
    if ((e.tag === 'data' || e.tag === 'input') && a['value'] !== undefined) return abs(a['value']);
    if (e.tag === 'abbr' && a['title'] !== undefined) return abs(a['title']);
    const t = textOf(e);
    return /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : abs(t);
  };
  const pValue = (e: HEl): string => {
    if (e.tag === 'abbr' && e.attrs['title'] !== undefined) return e.attrs['title'];
    if ((e.tag === 'data' || e.tag === 'input') && e.attrs['value'] !== undefined) return e.attrs['value'];
    if ((e.tag === 'img' || e.tag === 'area') && e.attrs['alt'] !== undefined) return e.attrs['alt'];
    return textOf(e);
  };
  const dtValue = (e: HEl): string => {
    if ((e.tag === 'time' || e.tag === 'ins' || e.tag === 'del') && e.attrs['datetime'] !== undefined) return e.attrs['datetime'];
    if (e.tag === 'abbr' && e.attrs['title'] !== undefined) return e.attrs['title'];
    if ((e.tag === 'data' || e.tag === 'input') && e.attrs['value'] !== undefined) return e.attrs['value'];
    return textOf(e);
  };
  const add = (props: Mf2Item['properties'], name: string, v: Mf2Item['properties'][string][number]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) return;
    (props[name] ??= []).push(v);
  };

  const items: Mf2Item[] = [];
  const parseItem = (el: HEl, roots: string[]): Mf2Item => {
    const item: Mf2Item = { type: roots, properties: Object.create(null) as Mf2Item['properties'] };
    const kids: Mf2Item[] = [];
    for (const k of el.kids) if (typeof k !== 'string') walk(k, kids, item.properties);
    if (kids.length) item.children = kids;
    const p = item.properties;
    const hasNested = kids.length > 0 || Object.values(p).some((vs) => vs.some((v) => typeof v === 'object' && 'type' in v));
    const hasE = Object.keys(p).length > 0 && Object.values(p).some((vs) => vs.some((v) => typeof v === 'object' && 'html' in v));
    if (!('name' in p) && !hasNested && !hasE) add(p, 'name', pValue(el));
    if (!('url' in p)) {
      if ((el.tag === 'a' || el.tag === 'area') && el.attrs['href'] !== undefined) add(p, 'url', abs(el.attrs['href']));
      else {
        const els = el.kids.filter((k): k is HEl => typeof k !== 'string');
        if (els.length === 1 && els[0]!.tag === 'a' && els[0]!.attrs['href'] !== undefined && !classes(els[0]!).some((c) => H.test(c))) add(p, 'url', abs(els[0]!.attrs['href']));
      }
    }
    if (!('photo' in p)) {
      if (el.tag === 'img' && el.attrs['src'] !== undefined) add(p, 'photo', abs(el.attrs['src']));
      else {
        const imgs = el.kids.filter((k): k is HEl => typeof k !== 'string' && k.tag === 'img');
        if (imgs.length === 1 && imgs[0]!.attrs['src'] !== undefined && el.kids.filter((k) => typeof k !== 'string').length === 1) add(p, 'photo', abs(imgs[0]!.attrs['src']));
      }
    }
    return item;
  };
  const walk = (el: HEl, out: Mf2Item[], props: Mf2Item['properties'] | null): void => {
    const cls = classes(el);
    const roots = cls.filter((c) => H.test(c));
    const pcls = cls.map((c) => P.exec(c)).filter((m): m is RegExpExecArray => m !== null);
    if (roots.length) {
      const item = parseItem(el, roots);
      if (pcls.length && props) {
        for (const m of pcls) {
          const prefix = m[1]!;
          const value = prefix === 'u' ? (item.properties['url']?.[0] as string | undefined) ?? urlValue(el) : prefix === 'dt' ? dtValue(el) : pValue(el);
          add(props, m[2]!, { ...item, value: typeof value === 'string' ? value : urlValue(el) });
        }
      } else out.push(item);
      return;
    }
    if (props) {
      for (const m of pcls) {
        const prefix = m[1]!;
        add(props, m[2]!, prefix === 'p' ? pValue(el) : prefix === 'u' ? urlValue(el) : prefix === 'dt' ? dtValue(el) : { html: htmlOf(el), value: textOf(el) });
      }
    }
    for (const k of el.kids) if (typeof k !== 'string') walk(k, out, props);
  };
  for (const k of doc.kids) if (typeof k !== 'string') walk(k, items, null);

  const rels: Mf2['rels'] = {};
  const relUrls: Mf2['rel-urls'] = {};
  walkEls(doc, (e) => {
    if ((e.tag === 'a' || e.tag === 'link' || e.tag === 'area') && e.attrs['href'] !== undefined && e.attrs['rel']) {
      const url = abs(e.attrs['href']);
      const rs = [...new Set(e.attrs['rel'].toLowerCase().split(/\s+/).filter(Boolean))];
      for (const r of rs) {
        if (['__proto__', 'constructor', 'prototype'].includes(r)) continue;
        const list = (rels[r] ??= []);
        if (!list.includes(url)) list.push(url);
      }
      if (!Object.hasOwn(relUrls, url)) relUrls[url] = { rels: [], text: textOf(e) };
      const ru = relUrls[url]!;
      for (const r of rs) if (!ru.rels.includes(r)) ru.rels.push(r);
    }
  });
  return { items, rels, 'rel-urls': relUrls };
}

function normalizeBase(href: string, doc: string): string {
  try {
    return new URL(href, doc).href;
  } catch {
    return doc;
  }
}

// ==================================================================== endpoint discovery

/** Splits a Link header into entries, honouring commas inside <> and quotes. */
export function parseLinkHeader(value: string): { url: string; rels: string[] }[] {
  const out: { url: string; rels: string[] }[] = [];
  const re = /<([^>]*)>((?:\s*;\s*[A-Za-z0-9*_-]+(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^\s;,]+))?)*)/g;
  for (const m of value.matchAll(re)) {
    let rels: string[] = [];
    for (const p of m[2]!.matchAll(/;\s*([A-Za-z0-9*_-]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;,]+)))?/g)) {
      if (p[1]!.toLowerCase() === 'rel' && rels.length === 0) rels = (p[2] ?? p[3] ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    }
    out.push({ url: m[1]!, rels });
  }
  return out;
}

/** The webmention endpoint a response advertises, as an absolute URL, or undefined. */
export function findEndpoint(res: Pick<FetchResult, 'headers' | 'body'>, finalUrl: string): string | undefined {
  const raw = res.headers['link'];
  const headers = raw === undefined ? [] : Array.isArray(raw) ? (raw as readonly string[]) : [raw as string];
  for (const h of headers) {
    for (const l of parseLinkHeader(h)) if (l.rels.includes('webmention')) return normalizeEndpoint(l.url, finalUrl);
  }
  let found: string | undefined;
  const doc = parseHtml(res.body);
  let base = finalUrl;
  let baseSet = false;
  walkEls(doc, (e) => {
    if (e.tag === 'base' && !baseSet && e.attrs['href'] !== undefined) {
      base = normalizeBase(e.attrs['href'], finalUrl);
      baseSet = true;
    }
    if (found === undefined && (e.tag === 'link' || e.tag === 'a') && e.attrs['href'] !== undefined && (e.attrs['rel'] ?? '').toLowerCase().split(/\s+/).includes('webmention')) {
      found = normalizeEndpoint(e.attrs['href'], base);
    }
  });
  return found;
}
const normalizeEndpoint = (href: string, base: string): string | undefined => {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
};

// ==================================================================== fetching

export interface Net {
  readonly fetch: Fetch;
  readonly allowPrivate?: boolean;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

const headerOne = (h: FetchResult['headers'], k: string): string | undefined => {
  const v = h[k];
  return Array.isArray(v) ? (v as string[])[0] : (v as string | undefined);
};

async function get(url: string, net: Net): Promise<FetchResult & { url: string }> {
  let cur = checkUrl(url, net.allowPrivate).href;
  for (let hop = 0; hop <= (net.maxRedirects ?? 5); hop++) {
    let res: FetchResult;
    try {
      res = await net.fetch(cur, { method: 'GET', headers: { accept: 'text/html, application/xhtml+xml, application/json;q=0.8, text/plain;q=0.5', 'user-agent': net.userAgent ?? 'webmention-block/1' }, timeoutMs: net.timeoutMs ?? 10_000 });
    } catch (e) {
      throw new WebmentionRejected('fetch_failed', `could not fetch ${cur}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (Buffer.byteLength(res.body) > (net.maxBytes ?? 1_000_000)) throw new WebmentionRejected('too_large', `${cur} is larger than the limit`);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = headerOne(res.headers, 'location');
      if (!loc) throw new WebmentionRejected('fetch_failed', `redirect from ${cur} with no Location`);
      cur = checkUrl(new URL(loc, cur).href, net.allowPrivate).href;
      continue;
    }
    return { ...res, url: cur };
  }
  throw new WebmentionRejected('too_many_redirects', `more than ${net.maxRedirects ?? 5} redirects from ${url}`);
}

// ==================================================================== sending

export type SendResult =
  | { readonly ok: true; readonly status: number; readonly endpoint: string; readonly location?: string }
  | { readonly ok: false; readonly reason: 'no_endpoint' | 'refused' | 'unreachable'; readonly endpoint?: string; readonly status?: number; readonly detail?: string };

/** Finds the target's endpoint without sending anything. */
export async function discover(target: string, net: Net): Promise<string | undefined> {
  const res = await get(target, net);
  if (res.status < 200 || res.status >= 300) return undefined;
  const ep = findEndpoint(res, res.url);
  if (ep === undefined) return undefined;
  checkUrl(ep, net.allowPrivate);
  return ep;
}

export async function send(source: string, target: string, net: Net): Promise<SendResult> {
  const s = checkUrl(source, true);
  const t = checkUrl(target, net.allowPrivate);
  if (normalize(s.href) === normalize(t.href)) throw new WebmentionRejected('bad_request', 'source and target are the same page');
  let endpoint: string | undefined;
  try {
    endpoint = await discover(t.href, net);
  } catch (e) {
    if (e instanceof WebmentionRejected && (e.code === 'fetch_failed' || e.code === 'too_large' || e.code === 'too_many_redirects')) return { ok: false, reason: 'unreachable', detail: e.message };
    throw e;
  }
  if (!endpoint) return { ok: false, reason: 'no_endpoint' };
  let res: FetchResult;
  try {
    res = await net.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: '*/*', 'user-agent': net.userAgent ?? 'webmention-block/1' },
      body: `source=${encodeURIComponent(s.href)}&target=${encodeURIComponent(t.href)}`,
      timeoutMs: net.timeoutMs ?? 10_000,
    });
  } catch (e) {
    return { ok: false, reason: 'unreachable', endpoint, detail: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 200 || res.status === 201 || res.status === 202) {
    const loc = headerOne(res.headers, 'location');
    return { ok: true, status: res.status, endpoint, ...(res.status === 201 && loc ? { location: new URL(loc, endpoint).href } : {}) };
  }
  return { ok: false, reason: 'refused', endpoint, status: res.status };
}

/** Every distinct http(s) link in a post's HTML, resolved against its URL: who to notify. */
export function outgoingTargets(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const self = normalize(pageUrl);
  walkEls(parseHtml(html), (e) => {
    const v = e.tag === 'a' || e.tag === 'area' ? e.attrs['href'] : undefined;
    if (v === undefined) return;
    const n = normalize(v, pageUrl);
    if (n && /^https?:/.test(n) && n !== self) out.add(n);
  });
  return [...out];
}

// ==================================================================== receiving

export type MentionType = 'reply' | 'like' | 'repost' | 'bookmark' | 'mention';

export interface Author {
  readonly name?: string;
  readonly url?: string;
  readonly photo?: string;
}
export interface Mention {
  readonly source: string;
  readonly target: string;
  readonly type: MentionType;
  readonly author?: Author;
  /** The title or name the source gives itself. */
  readonly name?: string;
  /** Plain text of the content, cut to the excerpt length. Never HTML. */
  readonly text?: string;
  readonly url?: string;
  readonly published?: string;
  readonly verifiedAt: string;
}

const LINK_ATTRS: Record<string, readonly string[]> = { a: ['href'], area: ['href'], img: ['src'], video: ['src', 'poster'], audio: ['src'], source: ['src'], iframe: ['src'], embed: ['src'] };

function sourceLinks(html: string, base: string): Set<string> {
  const doc = parseHtml(html);
  let b = base;
  let seen = false;
  const out = new Set<string>();
  walkEls(doc, (e) => {
    if (e.tag === 'base' && !seen && e.attrs['href'] !== undefined) {
      b = normalizeBase(e.attrs['href'], base);
      seen = true;
    }
    for (const a of LINK_ATTRS[e.tag] ?? []) {
      const v = e.attrs[a];
      if (v !== undefined) {
        const n = normalize(v, b);
        if (n) out.add(n);
      }
    }
  });
  return out;
}

function jsonStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 20 || out.length > 5000) return;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out, depth + 1);
  else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) jsonStrings(x, out, depth + 1);
}

/** Does this fetched source document link to the target? */
export function linksTo(res: Pick<FetchResult, 'headers' | 'body'>, finalUrl: string, target: string): boolean {
  const want = normalize(target);
  if (want === undefined) return false;
  const ct = (headerOne(res.headers, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct === 'application/json' || ct.endsWith('+json')) {
    try {
      const strings: string[] = [];
      jsonStrings(JSON.parse(res.body), strings);
      return strings.some((s) => normalize(s) === want);
    } catch {
      return false;
    }
  }
  if (ct === 'text/plain') return res.body.split(/\s+/).some((w) => normalize(w.replace(/^[<(\[]+|[>)\].,;:!?]+$/g, '')) === want);
  return sourceLinks(res.body, finalUrl).has(want);
}

const PROP_TYPE: readonly (readonly [string, MentionType])[] = [['in-reply-to', 'reply'], ['like-of', 'like'], ['repost-of', 'repost'], ['bookmark-of', 'bookmark']];

const urlsIn = (vs: Mf2Item['properties'][string] | undefined): string[] =>
  (vs ?? []).flatMap((v) => (typeof v === 'string' ? [normalize(v)] : 'type' in v ? [normalize(String(v.properties['url']?.[0] ?? v.value ?? ''))] : [])).filter((x): x is string => !!x);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'object' && v !== null && 'value' in v && typeof (v as { value: unknown }).value === 'string' ? (v as { value: string }).value : undefined);

function authorOf(entry: Mf2Item | undefined, mf: Mf2, base: string): Author | undefined {
  const fromCard = (c: Mf2Item): Author | undefined => {
    const name = str(c.properties['name']?.[0]);
    const url = str(c.properties['url']?.[0]);
    const photo = str(c.properties['photo']?.[0]);
    return name || url || photo ? { ...(name ? { name } : {}), ...(url ? { url } : {}), ...(photo ? { photo } : {}) } : undefined;
  };
  const a = entry?.properties['author']?.[0];
  if (a && typeof a === 'object' && 'type' in a && a.type.includes('h-card')) return fromCard(a);
  if (typeof a === 'string') {
    const maybe = normalize(a, base);
    return /^https?:\/\//.test(a) && maybe ? { url: maybe } : { name: a };
  }
  const card = mf.items.find((i) => i.type.includes('h-card'));
  if (card) return fromCard(card);
  const rel = mf.rels['author']?.[0];
  return rel ? { url: rel } : undefined;
}

/** What a source says about a target, read from its HTML; non-HTML sources are a plain mention. */
export function interpret(res: Pick<FetchResult, 'headers' | 'body'>, finalUrl: string, target: string, now: number, excerpt = 280): Omit<Mention, 'source' | 'target' | 'verifiedAt'> {
  const ct = (headerOne(res.headers, 'content-type') ?? 'text/html').split(';')[0]!.trim().toLowerCase();
  if (ct !== 'text/html' && ct !== 'application/xhtml+xml') return { type: 'mention' };
  const mf = parseMf2(res.body, finalUrl);
  const want = normalize(target)!;
  const entries = mf.items.filter((i) => i.type.includes('h-entry'));
  const entry = entries.find((e) => PROP_TYPE.some(([p]) => urlsIn(e.properties[p]).includes(want))) ?? entries.find((e) => normalize(str(e.properties['url']?.[0]) ?? '') === normalize(finalUrl)) ?? entries[0];
  let type: MentionType = 'mention';
  if (entry) for (const [p, t] of PROP_TYPE) if (urlsIn(entry.properties[p]).includes(want)) {
    type = t;
    break;
  }
  const author = authorOf(entry, mf, finalUrl);
  const name = str(entry?.properties['name']?.[0]);
  const content = str(entry?.properties['content']?.[0]) ?? str(entry?.properties['summary']?.[0]);
  const pub = str(entry?.properties['published']?.[0]);
  const t = pub ? Date.parse(pub) : Number.NaN;
  const url = str(entry?.properties['url']?.[0]);
  const text = content ? (content.length > excerpt ? `${content.slice(0, excerpt - 1).trimEnd()}…` : content) : undefined;
  return {
    type,
    ...(author ? { author } : {}),
    ...(name && name !== content ? { name: name.slice(0, 200) } : {}),
    ...(text ? { text } : {}),
    ...(url && normalize(url) ? { url } : {}),
    ...(Number.isFinite(t) && t <= now + 86_400_000 && t > 0 ? { published: new Date(t).toISOString() } : {}),
  };
}

export interface InboxOptions extends Net {
  readonly now: () => number;
  /** Is this URL a page of ours? Mentions of anything else are refused. */
  readonly isTarget: (url: URL) => boolean;
  readonly maxPerTarget?: number;
  readonly excerpt?: number;
}

export type ReceiveResult =
  | { readonly status: 'verified'; readonly mention: Mention; readonly updated: boolean }
  | { readonly status: 'removed'; readonly mention: Mention };

export class Inbox {
  readonly #o: InboxOptions;
  readonly #byKey = new Map<string, Mention>();

  constructor(o: InboxOptions) {
    this.#o = o;
  }

  static #key = (s: string, t: string) => `${s}\u0000${t}`;

  /** Handles one webmention request: checks it, fetches the source, verifies the link, stores what it says. */
  async receive(source: string, target: string): Promise<ReceiveResult> {
    const s = checkUrl(source, this.#o.allowPrivate);
    const t = checkUrl(target, true);
    if (normalize(s.href) === normalize(t.href)) throw new WebmentionRejected('bad_request', 'source and target are the same page');
    if (!this.#o.isTarget(t)) throw new WebmentionRejected('not_our_target', `${t.href} is not a page here`);
    const key = Inbox.#key(s.href, normalize(t.href)!);
    const res = await get(s.href, this.#o);
    if (res.status === 404 || res.status === 410) {
      const old = this.#byKey.get(key);
      if (old) {
        this.#byKey.delete(key);
        return { status: 'removed', mention: old };
      }
      throw new WebmentionRejected('source_gone', `${s.href} is gone and nothing was stored for it`);
    }
    if (res.status < 200 || res.status >= 300) throw new WebmentionRejected('fetch_failed', `${s.href} answered ${res.status}`);
    if (!linksTo(res, res.url, t.href)) {
      const old = this.#byKey.get(key);
      if (old) {
        this.#byKey.delete(key);
        return { status: 'removed', mention: old };
      }
      throw new WebmentionRejected('no_link', `${s.href} does not link to ${t.href}`);
    }
    const existing = this.#byKey.get(key);
    if (!existing && this.countFor(t.href) >= (this.#o.maxPerTarget ?? 1000)) throw new WebmentionRejected('too_many_mentions', 'this page has all the mentions it will keep');
    const now = this.#o.now();
    const mention: Mention = { source: s.href, target: normalize(t.href)!, ...interpret(res, res.url, t.href, now, this.#o.excerpt), verifiedAt: new Date(now).toISOString() };
    this.#byKey.set(key, mention);
    return { status: 'verified', mention, updated: existing !== undefined };
  }

  get(source: string, target: string): Mention | undefined {
    return this.#byKey.get(Inbox.#key(normalize(source) ?? source, normalize(target) ?? target)) ?? this.#byKey.get(Inbox.#key(source, normalize(target) ?? target));
  }

  remove(source: string, target: string): boolean {
    return this.#byKey.delete(Inbox.#key(source, normalize(target) ?? target));
  }

  countFor(target: string): number {
    const t = normalize(target);
    let n = 0;
    for (const m of this.#byKey.values()) if (m.target === t) n++;
    return n;
  }

  /** Mentions of a target (or all), newest verification first. */
  list(target?: string): Mention[] {
    const t = target === undefined ? undefined : normalize(target);
    return [...this.#byKey.values()].filter((m) => t === undefined || m.target === t).sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : a.source < b.source ? -1 : 1));
  }

  /** Counts by type for a target: what a "12 likes, 3 replies" line is made from. */
  summary(target: string): Record<MentionType, number> {
    const out: Record<MentionType, number> = { reply: 0, like: 0, repost: 0, bookmark: 0, mention: 0 };
    for (const m of this.list(target)) out[m.type]++;
    return out;
  }

  /** Verify every stored mention for a target again (a source may have dropped the link). Returns what was removed. */
  async recheck(target: string): Promise<Mention[]> {
    const gone: Mention[] = [];
    for (const m of this.list(target)) {
      try {
        const r = await this.receive(m.source, m.target);
        if (r.status === 'removed') gone.push(r.mention);
      } catch (e) {
        if (e instanceof WebmentionRejected && (e.code === 'no_link' || e.code === 'source_gone')) {
          if (this.remove(m.source, m.target)) gone.push(m);
        }
      }
    }
    return gone;
  }

  snapshot(): Mention[] {
    return this.list();
  }
  restore(list: readonly Mention[]): void {
    this.#byKey.clear();
    for (const m of list) this.#byKey.set(Inbox.#key(m.source, m.target), m);
  }
}
