/**
 * Link previews: the card a chat, a feed or an editor shows for a pasted address, built the safe way. Three jobs:
 *
 * 1. Fetching without being used as a proxy into your own network (SSRF). An address is accepted only as http or
 *    https on an allowed port, without credentials; its host is resolved by an injected resolver and refused if ANY
 *    answer is a loopback, private, link-local, shared (CGNAT), metadata, multicast, reserved or documentation
 *    address (IPv4, IPv6, IPv4-mapped, NAT64 and 6to4 forms included, and the odd spellings of IPv4 that URL
 *    parsing folds to dotted form); the request is made to the checked address, so a second DNS answer cannot move it;
 *    every redirect is checked again from the start; the body is read up to a byte limit and then dropped; only
 *    listed content types are read.
 * 2. Reading the page: Open Graph (https://ogp.me), Twitter card and ordinary head tags into one card model, in that
 *    order of preference, with structured image properties attached to the image they follow, relative addresses
 *    resolved, anything but http(s) addresses discarded, control characters removed and lengths capped.
 * 3. oEmbed 1.0 (https://oembed.com): discovery links, provider matching by URL scheme, the request address, and a
 *    strict check of the response by type. Embedded HTML is never passed through: only a single https iframe from an
 *    allowed host is accepted, and its address, not its markup, is what the page may use.
 *
 * Not here: the network itself (the resolver and the request function are arguments, so a real deployment supplies
 * ones that connect to the checked address), caching, image proxying and thumbnails. Pure otherwise: no clock.
 */
import { attr, parse, query, text as textOf } from '../html-parse/index.ts';

export class Blocked extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`that address was not fetched: ${reason}`);
    this.name = 'Blocked';
    this.reason = reason;
  }
}
export class FetchFailed extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'FetchFailed';
  }
}
export class InvalidOEmbed extends Error {
  constructor(why: string) {
    super(`not a valid oEmbed response: ${why}`);
    this.name = 'InvalidOEmbed';
  }
}

// ---------------------------------------------------------------- addresses

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Eight 16-bit groups of an IPv6 address, or null. Accepts :: and a trailing dotted IPv4. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.split('%')[0]!;
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (i === items.length - 1 && it.includes('.')) {
        const v4 = parseIPv4(it);
        if (!v4) return null;
        out.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(it)) out.push(parseInt(it, 16));
      else return null;
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

const inV4 = (a: number[], base: number[], bits: number): boolean => {
  const x = ((a[0]! << 24) | (a[1]! << 16) | (a[2]! << 8) | a[3]!) >>> 0;
  const y = ((base[0]! << 24) | (base[1]! << 16) | (base[2]! << 8) | base[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (x & mask) === (y & mask);
};
const NOT_PUBLIC_V4: readonly [number[], number][] = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

function publicV4(a: number[]): boolean {
  return !NOT_PUBLIC_V4.some(([b, bits]) => inV4(a, b, bits));
}

/** True only for an address on the public internet. Anything that cannot be read as an address is not public. */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return publicV4(v4);
  const g = parseIPv6(address);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return publicV4(embedded(g[6]!, g[7]!)) && !(g[5] === 0 && g[6] === 0 && g[7]! <= 1); // ::ffff:a.b.c.d, ::a.b.c.d, ::, ::1
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(embedded(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return publicV4(embedded(g[1]!, g[2]!)); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link local
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // site local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if ((g[0]! & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3 is public
  return true;
}

// ---------------------------------------------------------------- fetching

export interface FetchPolicy {
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly ports?: readonly number[];
  /** Media types that are read; anything else is refused before its body is. */
  readonly allowedTypes?: readonly string[];
  readonly userAgent?: string;
}
export interface Response {
  readonly status: number;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}
export interface Deps {
  /** The addresses a name resolves to. Called once per hop. */
  resolve(hostname: string): Promise<readonly string[]>;
  /** Makes the request to this exact address, with the URL's host as Host and SNI. */
  request(req: { address: string; url: URL; headers: Readonly<Record<string, string>> }): Promise<Response>;
}
export interface Fetched {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly redirects: readonly string[];
}

const DENIED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|metadata)$/;
const DEFAULT_TYPES = ['text/html', 'application/xhtml+xml', 'application/json', 'text/xml', 'application/xml', 'application/json+oembed', 'text/xml+oembed'];

/** The address as a URL, or a Blocked error saying why it may not be fetched. Checks the text only, not the network. */
export function checkUrl(input: string, ports: readonly number[] = [80, 443]): URL {
  if (typeof input !== 'string' || input.length > 2048) throw new Blocked('not an address, or longer than 2048 characters');
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Blocked('not a valid address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Blocked(`${u.protocol.replace(':', '')} addresses are not fetched`);
  if (u.username || u.password) throw new Blocked('addresses with a user name or password are not fetched');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!ports.includes(port)) throw new Blocked(`port ${port} is not allowed`);
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host) throw new Blocked('no host');
  if (DENIED_NAMES.test(host)) throw new Blocked(`${host} is an internal name`);
  if (host.startsWith('[')) {
    if (!isPublicAddress(host)) throw new Blocked(`${host} is not a public address`);
  } else if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    // WHATWG parsing has folded every numeric spelling to dotted form; anything still odd is refused.
    if (!parseIPv4(host)) throw new Blocked(`${host} is not a usable address`);
    if (!isPublicAddress(host)) throw new Blocked(`${host} is not a public address`);
  } else if (!host.includes('.')) throw new Blocked(`${host} is a single-label name`);
  return u;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Fetches a page under the policy. Every hop is checked; the request goes to the address that was checked. */
export async function safeFetch(url: string, deps: Deps, policy: FetchPolicy = {}): Promise<Fetched> {
  const maxBytes = policy.maxBytes ?? 1_000_000;
  const maxRedirects = policy.maxRedirects ?? 3;
  const ports = policy.ports ?? [80, 443];
  const types = policy.allowedTypes ?? DEFAULT_TYPES;
  const trail: string[] = [];
  let current = checkUrl(url, ports);
  for (let hop = 0; ; hop++) {
    const host = current.hostname.replace(/\.$/, '');
    let address: string;
    if (host.startsWith('[') || parseIPv4(host)) address = host.replace(/^\[|\]$/g, '');
    else {
      const answers = await deps.resolve(host);
      if (!answers.length) throw new Blocked(`${host} did not resolve`);
      const bad = answers.find((a) => !isPublicAddress(a));
      if (bad !== undefined) throw new Blocked(`${host} resolves to ${bad}, which is not a public address`);
      address = answers[0]!;
    }
    const res = await deps.request({
      address,
      url: current,
      headers: { 'user-agent': policy.userAgent ?? 'link-preview', accept: 'text/html,application/xhtml+xml,application/json;q=0.9', 'accept-encoding': 'identity' },
    });
    if (REDIRECTS.has(res.status)) {
      const loc = res.headers['location'];
      if (!loc) throw new FetchFailed(`a ${res.status} redirect with no Location`);
      if (hop >= maxRedirects) throw new FetchFailed(`more than ${maxRedirects} redirects`);
      let next: string;
      try {
        next = new URL(loc, current).href;
      } catch {
        throw new Blocked('a redirect to something that is not an address');
      }
      trail.push(current.href);
      current = checkUrl(next, ports);
      continue;
    }
    const contentType = (res.headers['content-type'] ?? '').toLowerCase();
    const media = contentType.split(';')[0]!.trim();
    if (!types.includes(media)) throw new FetchFailed(`content type ${media || '(none)'} is not read`);
    const declared = Number(res.headers['content-length']);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = Number.isFinite(declared) && declared > maxBytes;
    for await (const c of res.body) {
      const room = maxBytes - total;
      if (c.length > room) {
        if (room > 0) chunks.push(c.subarray(0, room));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(c);
      total += c.length;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const charset = /charset=["']?([\w.:-]+)/.exec(contentType)?.[1] ?? 'utf-8';
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset);
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    return { url: current.href, status: res.status, contentType: media, body: decoder.decode(bytes), truncated, redirects: trail };
  }
}

// ---------------------------------------------------------------- the card

export interface Media {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
  readonly type?: string;
}
export interface Card {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly siteName: string;
  readonly type: string;
  readonly images: readonly Media[];
  readonly videos: readonly Media[];
  readonly author?: string;
  readonly publishedTime?: string;
  readonly locale?: string;
  readonly twitterCard?: string;
  readonly icon?: string;
  readonly oembedUrl?: string;
  readonly oembedFormat?: 'json' | 'xml';
}

const LIMITS = { title: 300, description: 1000, name: 200 };

/** Printable text from page content: controls removed, whitespace collapsed, cut at a code point. */
export function clean(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return [...t].slice(0, max).join('');
}

/** An http(s) address resolved against a base, or undefined for anything else. */
export function cleanUrl(value: string | undefined, base: string): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const u = new URL(value.trim(), base);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined;
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

const dim = (s: string | undefined): number | undefined => {
  if (!s || !/^\d{1,5}$/.test(s.trim())) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 20000 ? n : undefined;
};

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/.test(t)) return undefined;
  return Number.isNaN(Date.parse(t.replace(' ', 'T'))) ? undefined : t;
}

/** Reads the page's own markup into the card. `pageUrl` is the final address after redirects. */
export function readCard(html: string, pageUrl: string): Card {
  const doc = parse(html);
  const og = new Map<string, string>();
  const tw = new Map<string, string>();
  const named = new Map<string, string>();
  const images: { url?: string; secure?: string; width?: string; height?: string; alt?: string; type?: string }[] = [];
  const videos: { url?: string; secure?: string; width?: string; height?: string; type?: string }[] = [];
  const twImages: string[] = [];
  for (const m of query(doc, 'meta')) {
    const key = (attr(m, 'property') ?? attr(m, 'name') ?? '').trim().toLowerCase();
    const val = attr(m, 'content');
    if (!key || val === undefined) continue;
    if (key.startsWith('og:') || key.startsWith('article:')) {
      if (key === 'og:image' || key === 'og:image:url') images.push({ url: val });
      else if (key.startsWith('og:image:')) {
        const cur = images[images.length - 1];
        const prop = key.slice(9);
        if (cur) {
          if (prop === 'secure_url') cur.secure = val;
          else if (prop === 'width') cur.width = val;
          else if (prop === 'height') cur.height = val;
          else if (prop === 'alt') cur.alt = val;
          else if (prop === 'type') cur.type = val;
        }
      } else if (key === 'og:video' || key === 'og:video:url') videos.push({ url: val });
      else if (key.startsWith('og:video:')) {
        const cur = videos[videos.length - 1];
        const prop = key.slice(9);
        if (cur) {
          if (prop === 'secure_url') cur.secure = val;
          else if (prop === 'width') cur.width = val;
          else if (prop === 'height') cur.height = val;
          else if (prop === 'type') cur.type = val;
        }
      } else if (!og.has(key)) og.set(key, val);
    } else if (key.startsWith('twitter:')) {
      if (key === 'twitter:image' || key === 'twitter:image:src') twImages.push(val);
      else if (!tw.has(key)) tw.set(key, val);
    } else if (!named.has(key)) named.set(key, val);
  }
  const links = query(doc, 'link');
  const rel = (name: string) => links.filter((l) => (attr(l, 'rel') ?? '').toLowerCase().split(/\s+/).includes(name));
  const canonLink = rel('canonical')[0];
  const canonical = canonLink ? cleanUrl(attr(canonLink, 'href'), pageUrl) : undefined;
  const iconLink = [...rel('icon'), ...rel('apple-touch-icon')][0];
  const alt = links.filter((l) => (attr(l, 'rel') ?? '').toLowerCase().split(/\s+/).includes('alternate'));
  const json = alt.find((l) => (attr(l, 'type') ?? '').toLowerCase() === 'application/json+oembed');
  const xml = alt.find((l) => (attr(l, 'type') ?? '').toLowerCase() === 'text/xml+oembed');
  const oembedLink = json ?? xml;
  const titleEl = query(doc, 'title')[0];

  const media = (list: typeof images): Media[] => {
    const out: Media[] = [];
    for (const i of list) {
      const url = cleanUrl(i.secure ?? i.url, pageUrl) ?? cleanUrl(i.url, pageUrl);
      if (!url) continue;
      const w = dim(i.width);
      const h = dim(i.height);
      const a = clean((i as { alt?: string }).alt, LIMITS.description);
      out.push({ url, ...(w ? { width: w } : {}), ...(h ? { height: h } : {}), ...(a ? { alt: a } : {}), ...(i.type ? { type: clean(i.type, 100)! } : {}) });
    }
    return out;
  };
  let imgs = media(images);
  if (!imgs.length) imgs = twImages.map((u) => cleanUrl(u, pageUrl)).filter((u): u is string => !!u).map((url) => ({ url }));
  const vids = media(videos as typeof images);

  const url = cleanUrl(og.get('og:url'), pageUrl) ?? canonical ?? cleanUrl(pageUrl, pageUrl) ?? pageUrl;
  const title = clean(og.get('og:title') ?? tw.get('twitter:title') ?? (titleEl ? textOf(titleEl) : undefined), LIMITS.title);
  const description = clean(og.get('og:description') ?? tw.get('twitter:description') ?? named.get('description'), LIMITS.description);
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const author = clean(og.get('article:author') && !/^https?:/i.test(og.get('article:author')!) ? og.get('article:author') : (named.get('author') ?? tw.get('twitter:creator')), LIMITS.name);
  const published = isoDate(og.get('article:published_time'));
  const locale = clean(og.get('og:locale'), 35);
  const card = clean(tw.get('twitter:card'), 40);
  const icon = cleanUrl(iconLink ? attr(iconLink, 'href') : undefined, pageUrl);
  const oe = oembedLink ? cleanUrl(attr(oembedLink, 'href'), pageUrl) : undefined;
  return {
    url,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    siteName: clean(og.get('og:site_name'), LIMITS.name) ?? host,
    type: clean(og.get('og:type'), 60) ?? 'website',
    images: imgs.slice(0, 10),
    videos: vids.slice(0, 5),
    ...(author ? { author } : {}),
    ...(published ? { publishedTime: published } : {}),
    ...(locale ? { locale } : {}),
    ...(card ? { twitterCard: card } : {}),
    ...(icon ? { icon } : {}),
    ...(oe ? { oembedUrl: oe, oembedFormat: json ? ('json' as const) : ('xml' as const) } : {}),
  };
}

// ---------------------------------------------------------------- oEmbed

export interface Provider {
  /** URL schemes with * wildcards, such as https://*.example.com/watch*. */
  readonly schemes: readonly string[];
  readonly endpoint: string;
}

function schemeRe(scheme: string): RegExp {
  // Escape everything, then let * match a run without spaces; in the host part it may not cross a slash, so a
  // wildcard cannot swallow a path. Linear: no nested quantifiers.
  const at = scheme.indexOf('://');
  const hostEnd = at < 0 ? -1 : scheme.indexOf('/', at + 3);
  const esc = (p: string) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const part = (p: string, any: string) => p.split('*').map(esc).join(any);
  const re = hostEnd < 0 ? part(scheme, '[^\\s/]*') : part(scheme.slice(0, hostEnd), '[^\\s/]*') + part(scheme.slice(hostEnd), '[^\\s]*');
  return new RegExp(`^${re}$`, 'i');
}

/** The provider whose scheme matches the address, if any. */
export function matchProvider(url: string, providers: readonly Provider[]): Provider | undefined {
  return providers.find((p) => p.schemes.some((s) => schemeRe(s).test(url)));
}

export function oembedRequestUrl(endpoint: string, url: string, o: { maxwidth?: number; maxheight?: number; format?: 'json' | 'xml' } = {}): string {
  const u = new URL(endpoint.replace('{format}', o.format ?? 'json'));
  u.searchParams.set('url', url);
  u.searchParams.set('format', o.format ?? 'json');
  if (o.maxwidth !== undefined) u.searchParams.set('maxwidth', String(Math.trunc(o.maxwidth)));
  if (o.maxheight !== undefined) u.searchParams.set('maxheight', String(Math.trunc(o.maxheight)));
  return u.href;
}

export interface OEmbed {
  readonly type: 'photo' | 'video' | 'link' | 'rich';
  readonly title?: string;
  readonly authorName?: string;
  readonly authorUrl?: string;
  readonly providerName?: string;
  readonly providerUrl?: string;
  readonly thumbnailUrl?: string;
  readonly thumbnailWidth?: number;
  readonly thumbnailHeight?: number;
  /** photo only */
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  /** video and rich only; untrusted markup: use embedIframe, never insert this as it is. */
  readonly html?: string;
}

/** Checks a JSON oEmbed response by the rules of its type. Throws InvalidOEmbed with the first thing wrong. */
export function parseOEmbed(input: string | unknown, base: string): OEmbed {
  let o: unknown = input;
  if (typeof input === 'string') {
    if (input.length > 200_000) throw new InvalidOEmbed('too large');
    try {
      o = JSON.parse(input);
    } catch {
      throw new InvalidOEmbed('not JSON');
    }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new InvalidOEmbed('not an object');
  const r = o as Record<string, unknown>;
  if (String(r['version']) !== '1.0') throw new InvalidOEmbed('version must be 1.0');
  const type = r['type'];
  if (type !== 'photo' && type !== 'video' && type !== 'link' && type !== 'rich') throw new InvalidOEmbed('type must be photo, video, link or rich');
  const str = (k: string, max: number) => (typeof r[k] === 'string' ? clean(r[k] as string, max) : undefined);
  const num = (k: string) => {
    const v = r[k];
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 20000) throw new InvalidOEmbed(`${k} must be a whole number of pixels`);
    return n;
  };
  const out: Record<string, unknown> = { type };
  const set = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  set('title', str('title', LIMITS.title));
  set('authorName', str('author_name', LIMITS.name));
  set('authorUrl', cleanUrl(str('author_url', 2048), base));
  set('providerName', str('provider_name', LIMITS.name));
  set('providerUrl', cleanUrl(str('provider_url', 2048), base));
  set('thumbnailUrl', cleanUrl(str('thumbnail_url', 2048), base));
  const tw = num('thumbnail_width');
  const th = num('thumbnail_height');
  if (out['thumbnailUrl']) {
    set('thumbnailWidth', tw);
    set('thumbnailHeight', th);
  }
  if (type === 'photo') {
    const url = cleanUrl(typeof r['url'] === 'string' ? (r['url'] as string) : undefined, base);
    if (!url) throw new InvalidOEmbed('a photo needs an http(s) url');
    const w = num('width');
    const h = num('height');
    if (!w || !h) throw new InvalidOEmbed('a photo needs width and height');
    set('url', url);
    set('width', w);
    set('height', h);
  } else if (type === 'video' || type === 'rich') {
    const html = r['html'];
    if (typeof html !== 'string' || !html.trim()) throw new InvalidOEmbed(`a ${type} needs html`);
    if (html.length > 20_000) throw new InvalidOEmbed('html is longer than 20000 characters');
    const w = num('width');
    const h = num('height');
    if (!w || !h) throw new InvalidOEmbed(`a ${type} needs width and height`);
    set('html', html);
    set('width', w);
    set('height', h);
  }
  return out as unknown as OEmbed;
}

export interface Embed {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The one thing an embed may be: a single https iframe whose host is allowed. Returns its address and size so the
 * page builds its own iframe (sandboxed); returns null for scripts, several elements, other hosts or other schemes.
 */
export function embedIframe(html: string, allowedHosts: readonly string[], fallback: { width: number; height: number }): Embed | null {
  const doc = parse(html);
  const significant = doc.children.filter((c) => c.type === 'element' || (c.type === 'text' && c.value.trim() !== ''));
  const only = significant[0];
  if (significant.length !== 1 || !only || only.type !== 'element' || only.tag !== 'iframe') return null;
  if (only.children.some((c) => c.type !== 'text' || c.value.trim() !== '')) return null;
  const src = attr(only, 'src');
  if (!src) return null;
  let u: URL;
  try {
    u = new URL(src.startsWith('//') ? `https:${src}` : src);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) return null;
  return { src: u.href, width: dim(attr(only, 'width')) ?? fallback.width, height: dim(attr(only, 'height')) ?? fallback.height };
}

/** The card with what an oEmbed answer adds: a better title or image when the page gave none, and a safe embed. */
export function withOEmbed(card: Card, oembed: OEmbed, allowedEmbedHosts: readonly string[]): Card & { readonly embed?: Embed } {
  const embed = oembed.html && oembed.width && oembed.height ? embedIframe(oembed.html, allowedEmbedHosts, { width: oembed.width, height: oembed.height }) : null;
  const image = oembed.type === 'photo' ? oembed.url : oembed.thumbnailUrl;
  return {
    ...card,
    ...(!card.title && oembed.title ? { title: oembed.title } : {}),
    ...(!card.author && oembed.authorName ? { author: oembed.authorName } : {}),
    ...(!card.images.length && image ? { images: [{ url: image, ...(oembed.thumbnailWidth && oembed.type !== 'photo' ? { width: oembed.thumbnailWidth } : {}), ...(oembed.thumbnailHeight && oembed.type !== 'photo' ? { height: oembed.thumbnailHeight } : {}) }] } : {}),
    ...(embed ? { embed } : {}),
  };
}
