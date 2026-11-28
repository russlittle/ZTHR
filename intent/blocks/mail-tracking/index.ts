/**
 * Mail tracking: the two things a sent email can report back, and how to do it without being a surveillance tool.
 * An open is a 1x1 image fetched from a signed address; a click is a signed redirect that carries its own
 * destination inside the token, so it cannot be bent into an open redirect and holds nothing in a database.
 * Three privacy modes: "full" (the recipient is named in the token), "aggregate" (only the campaign is, so nothing
 * can be tied to a person) and "off" (links stay direct and no pixel is added). A person can opt out with a signed
 * link, and a browser's Global Privacy Control or Do Not Track signal drops the person from the event. IP addresses
 * and browser strings are used to judge an event and are never stored.
 *
 * Not every fetch is a person. Apple Mail Privacy Protection and the Gmail image proxy fetch images for the reader
 * (so opens are marked "proxy" and kept apart), and security scanners follow every link the moment mail arrives
 * (so fast, scripted, HEAD and prefetch requests are marked "bot" and not counted).
 *
 * Follows RFC 3986 for addresses, RFC 9110 for redirects and the W3C Global Privacy Control proposal. Tokens are
 * the HMAC-signed tokens of the crypto block. Out of scope: delivering the mail, unsubscribe headers (RFC 8058),
 * IPv6 proxy ranges, and the web server that serves the three paths.
 */
import { BadToken, sign, verify } from '../crypto/index.ts';

export class TrackingError extends Error {}
/** The token or the destination cannot be trusted. */
export class BadLink extends TrackingError {}

export type Mode = 'full' | 'aggregate' | 'off';

/** The smallest transparent GIF (42 bytes). */
export const OPEN_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export const openResponse = () => ({
  status: 200,
  headers: { 'content-type': 'image/gif', 'content-length': String(OPEN_GIF.length), 'cache-control': 'no-store, max-age=0', 'x-content-type-options': 'nosniff' } as Record<string, string>,
  body: OPEN_GIF,
});

export const redirectResponse = (url: string) => ({
  status: 302,
  headers: { location: url, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as Record<string, string>,
});

// ---------------------------------------------------------------- addresses

const MAX_URL = 2048;

function parseDestination(raw: string, allowHosts: readonly string[] | undefined): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_URL) throw new BadLink('a tracked link needs an address of 1 to 2048 characters');
  if (/[\u0000- \u007f]/.test(raw)) throw new BadLink('a tracked address cannot hold spaces or control characters');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadLink('that is not a full web address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadLink(`only http and https addresses can be tracked, not ${u.protocol}`);
  if (u.username || u.password) throw new BadLink('an address with a name and password in it cannot be tracked');
  if (allowHosts && !allowHosts.some((h) => (h.startsWith('*.') ? u.hostname.endsWith(h.slice(1)) && u.hostname.length > h.length - 1 : u.hostname === h))) {
    throw new BadLink(`the host ${u.hostname} is not on the list of hosts that may be tracked`);
  }
  return u.href;
}

export function ipInRanges(ip: string | undefined, ranges: readonly string[]): boolean {
  const nets = ranges.map((r) => {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(r);
    const a = m && v4(m[1]!);
    if (!m || a === null || Number(m[2]) > 32) throw new TrackingError(`"${r}" is not a network like 17.0.0.0/8`);
    const bits = Number(m[2]);
    return { a: a!, mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 };
  });
  const x = ip === undefined ? null : v4(ip);
  return x !== null && nets.some((n) => ((x & n.mask) >>> 0) === ((n.a & n.mask) >>> 0));
}

function v4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return p.some((n) => n > 255) ? null : ((p[0] * 2 ** 24 + p[1] * 2 ** 16 + p[2] * 2 ** 8 + p[3]) >>> 0);
}

// ---------------------------------------------------------------- judging a fetch

export interface Hit {
  readonly at: number;
  readonly method: string;
  readonly userAgent: string;
  readonly ip?: string;
  /** Header names in lower case. */
  readonly headers?: Readonly<Record<string, string>>;
}
export interface Verdict {
  readonly kind: 'human' | 'proxy' | 'bot';
  readonly reason: string;
}

/** Apple Mail Privacy Protection fetches from addresses in 17.0.0.0/8. */
export const DEFAULT_PROXY_RANGES: readonly string[] = ['17.0.0.0/8'];
const BOT = /bot\b|crawl|spider|barracuda|proofpoint|mimecast|symantec|trendmicro|python-requests|curl\/|wget|headless|go-http-client|libwww|java\/|scanner|linkcheck|preview/i;

export function classify(kind: 'open' | 'click', hit: Hit, o: { sentAt: number; scannerWindowMs?: number; proxyRanges?: readonly string[] }): Verdict {
  const ua = (hit.userAgent ?? '').trim();
  const h = hit.headers ?? {};
  if (!ua) return { kind: 'bot', reason: 'no user agent' };
  if (hit.method.toUpperCase() === 'HEAD') return { kind: 'bot', reason: 'a HEAD request is a link checker' };
  if (/prefetch|prerender/i.test(`${h['purpose'] ?? ''};${h['sec-purpose'] ?? ''};${h['x-moz'] ?? ''}`)) return { kind: 'bot', reason: 'a prefetch, not a visit' };
  if (BOT.test(ua)) return { kind: 'bot', reason: 'a known scanner or robot' };
  if (kind === 'open') {
    if (/GoogleImageProxy/i.test(ua)) return { kind: 'proxy', reason: 'Gmail image proxy: the open is real but the time and place are not' };
    if (ipInRanges(hit.ip, o.proxyRanges ?? DEFAULT_PROXY_RANGES)) return { kind: 'proxy', reason: 'Apple Mail Privacy Protection fetches every image on delivery' };
  }
  const win = o.scannerWindowMs ?? 2000;
  if (hit.at - o.sentAt < win) return { kind: 'bot', reason: `arrived within ${win} ms of sending, faster than a person` };
  return { kind: 'human', reason: 'looks like a person' };
}

// ---------------------------------------------------------------- the tracker

export interface Context {
  readonly campaign: string;
  readonly message?: string;
  readonly recipient?: string;
}
export interface Opened {
  readonly campaign: string;
  readonly message?: string;
  readonly recipient?: string;
  readonly sentAt: number;
}
export interface Clicked extends Opened {
  readonly url: string;
  readonly link: string;
}
export interface TrackerOptions {
  /** The signing secret: at least 16 characters, kept out of source code. */
  readonly secret: string;
  /** Where the tracking paths are served: https only. */
  readonly baseUrl: string;
  readonly now: () => number;
  readonly mode?: Mode;
  /** If given, only these hosts ("shop.example.org", "*.partner.example") can be the destination of a tracked link. */
  readonly allowHosts?: readonly string[];
  readonly ttlMs?: number;
  readonly proxyRanges?: readonly string[];
  readonly scannerWindowMs?: number;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&lt;': '<', '&gt;': '>' };
const decode = (s: string) => s.replace(/&(?:amp|quot|#39|#x27|lt|gt);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MAX_HTML = 5_000_000;

export class Tracker {
  readonly mode: Mode;
  private readonly o: TrackerOptions;
  private readonly base: string;
  private readonly ttl: number;
  constructor(o: TrackerOptions) {
    if (typeof o.secret !== 'string' || o.secret.length < 16) throw new TrackingError('the signing secret must be at least 16 characters');
    let u: URL;
    try {
      u = new URL(o.baseUrl);
    } catch {
      throw new TrackingError('the base address is not a web address');
    }
    if (u.protocol !== 'https:') throw new TrackingError('the tracking address must be https');
    this.base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    this.o = o;
    this.mode = o.mode ?? 'full';
    this.ttl = o.ttlMs ?? 365 * 86_400_000;
  }

  private data(ctx: Context, extra: Record<string, unknown>): Record<string, unknown> {
    if (!ctx.campaign) throw new TrackingError('a campaign name is needed');
    const d: Record<string, unknown> = { c: ctx.campaign, s: this.o.now(), ...extra };
    if (ctx.message !== undefined) d['m'] = ctx.message;
    if (ctx.recipient !== undefined && this.mode === 'full') d['r'] = ctx.recipient;
    return d;
  }

  /** The address of the open pixel, or null when tracking is off. */
  pixelUrl(ctx: Context): string | null {
    if (this.mode === 'off') return null;
    return `${this.base}/t/o/${sign(this.o.secret, 'mail-open', this.data(ctx, {}), this.ttl, this.o.now())}.gif`;
  }

  /** The tracked form of a link; with tracking off, the link itself. */
  clickUrl(ctx: Context, url: string, link: string): string {
    if (this.mode === 'off') return url;
    const dest = parseDestination(url, this.o.allowHosts);
    return `${this.base}/t/c/${sign(this.o.secret, 'mail-click', this.data(ctx, { u: dest, l: link }), this.ttl, this.o.now())}`;
  }

  optOutUrl(o: { recipient: string }): string {
    if (!o.recipient) throw new TrackingError('an opt-out link needs a recipient');
    return `${this.base}/t/x/${sign(this.o.secret, 'mail-optout', { r: o.recipient }, this.ttl, this.o.now())}`;
  }

  private open(purpose: string, token: string): Record<string, unknown> {
    try {
      return verify(this.o.secret, purpose, token, this.o.now());
    } catch (e) {
      throw new BadLink(e instanceof BadToken ? e.message : 'that link is not in the expected form');
    }
  }

  private who(d: Record<string, unknown>): Opened {
    if (typeof d['c'] !== 'string' || typeof d['s'] !== 'number') throw new BadLink('that link is missing its campaign');
    return { campaign: d['c'], sentAt: d['s'], ...(typeof d['m'] === 'string' ? { message: d['m'] } : {}), ...(typeof d['r'] === 'string' ? { recipient: d['r'] } : {}) };
  }

  resolveOpen(token: string): Opened {
    return this.who(this.open('mail-open', token));
  }

  resolveClick(token: string): Clicked {
    const d = this.open('mail-click', token);
    const w = this.who(d);
    if (typeof d['u'] !== 'string' || typeof d['l'] !== 'string') throw new BadLink('that link is missing its destination');
    return { ...w, url: parseDestination(d['u'], undefined), link: d['l'] };
  }

  resolveOptOut(token: string): string {
    const r = this.open('mail-optout', token)['r'];
    if (typeof r !== 'string' || !r) throw new BadLink('that link names nobody');
    return r;
  }

  classify(kind: 'open' | 'click', hit: Hit, sentAt: number): Verdict {
    return classify(kind, hit, { sentAt, ...(this.o.scannerWindowMs !== undefined ? { scannerWindowMs: this.o.scannerWindowMs } : {}), ...(this.o.proxyRanges ? { proxyRanges: this.o.proxyRanges } : {}) });
  }

  /** Replace each web link in an html mail with its tracked form and add the pixel; other links are left alone. */
  rewriteHtml(html: string, ctx: Context): { html: string; links: { id: string; url: string }[]; skipped: { url: string; why: string }[] } {
    if (html.length > MAX_HTML) throw new TrackingError('that mail is too large to rewrite');
    if (this.mode === 'off') return { html, links: [], skipped: [] };
    const links: { id: string; url: string }[] = [];
    const skipped: { url: string; why: string }[] = [];
    const out = html.replace(/<a\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>/gi, (whole, pre: string, dq: string | undefined, sq: string | undefined, post: string) => {
      const raw = decode(dq ?? sq ?? '').trim();
      if (!/^https?:\/\//i.test(raw) || raw.startsWith(`${this.base}/t/`) || /data-track\s*=\s*["']?off/i.test(pre + post)) return whole;
      const id = `l${links.length + 1}`;
      let tracked: string;
      try {
        tracked = this.clickUrl(ctx, raw, id);
      } catch (e) {
        skipped.push({ url: raw, why: e instanceof Error ? e.message : String(e) });
        return whole;
      }
      links.push({ id, url: new URL(raw).href });
      return `<a${pre}href="${escapeAttr(tracked)}"${post}>`;
    });
    const px = this.pixelUrl(ctx)!;
    const img = `<img src="${escapeAttr(px)}" width="1" height="1" alt="" style="display:none">`;
    const at = out.search(/<\/body\s*>/i);
    return { html: at === -1 ? out + img : out.slice(0, at) + img + out.slice(at), links, skipped };
  }
}

// ---------------------------------------------------------------- recording

export interface TrackEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: 'open' | 'click';
  readonly campaign: string;
  readonly message?: string;
  readonly recipient?: string;
  readonly link?: string;
  readonly class: Verdict['kind'];
  readonly reason: string;
}

export interface Stats {
  readonly sent: number;
  /** People who opened as far as anyone can tell: a human open, or a human click (which proves an open). */
  readonly opens: number;
  /** Opens through a mail proxy: they say the mail arrived, not that it was read. */
  readonly proxyOpens: number;
  readonly bots: number;
  readonly clicks: number;
  readonly uniqueClicks: number;
  readonly links: Record<string, { clicks: number; unique: number }>;
  readonly openRate: number | null;
  readonly clickRate: number | null;
  readonly clickToOpen: number | null;
  /** Events that arrived after the store was full. */
  readonly dropped: number;
}

export class Recorder {
  private readonly o: { tracker: Tracker; now: () => number; maxEvents: number };
  private readonly list: TrackEvent[] = [];
  private readonly out = new Set<string>();
  private seq = 0;
  private lost = 0;
  constructor(o: { tracker: Tracker; now: () => number; maxEvents?: number }) {
    this.o = { tracker: o.tracker, now: o.now, maxEvents: o.maxEvents ?? 100_000 };
  }

  isOptedOut(recipient: string): boolean {
    return this.out.has(recipient);
  }

  /** Follow a signed opt-out link: from now on nothing is recorded about this person. */
  optOut(token: string): string {
    const r = this.o.tracker.resolveOptOut(token);
    this.out.add(r);
    return r;
  }

  events(): readonly TrackEvent[] {
    return this.list;
  }

  private add(kind: 'open' | 'click', w: Opened, hit: Hit, link?: string): TrackEvent | null {
    let recipient = w.recipient;
    if (recipient !== undefined && this.out.has(recipient)) return null;
    const h = hit.headers ?? {};
    if (h['sec-gpc'] === '1' || h['dnt'] === '1') recipient = undefined;
    const v = this.o.tracker.classify(kind, hit, w.sentAt);
    if (this.list.length >= this.o.maxEvents) {
      this.lost++;
      return null;
    }
    const ev: TrackEvent = {
      seq: ++this.seq,
      at: this.o.now(),
      kind,
      campaign: w.campaign,
      ...(w.message !== undefined ? { message: w.message } : {}),
      ...(recipient !== undefined ? { recipient } : {}),
      ...(link !== undefined ? { link } : {}),
      class: v.kind,
      reason: v.reason,
    };
    this.list.push(ev);
    return ev;
  }

  /** Record a fetch of the pixel. Throws BadLink for a token that is not ours; the caller still answers with the gif. */
  open(token: string, hit: Hit): TrackEvent | null {
    return this.add('open', this.o.tracker.resolveOpen(token), hit);
  }

  /** Record a click and say where to send the person; opting out stops the recording, never the redirect. */
  click(token: string, hit: Hit): { url: string; event: TrackEvent | null } {
    const c = this.o.tracker.resolveClick(token);
    return { url: c.url, event: this.add('click', c, hit, c.link) };
  }

  stats(campaign: string, sent: number): Stats {
    const opened = new Set<string>();
    const proxy = new Set<string>();
    const clickers = new Set<string>();
    const links: Record<string, { clicks: number; unique: number; who: Set<string> }> = {};
    let anon = 0;
    let anonProxy = 0;
    let anonClicks = 0;
    let bots = 0;
    let clicks = 0;
    for (const e of this.list) {
      if (e.campaign !== campaign) continue;
      if (e.class === 'bot') {
        bots++;
        continue;
      }
      const key = e.recipient;
      if (e.kind === 'open') {
        if (e.class === 'proxy') key === undefined ? anonProxy++ : proxy.add(key);
        else key === undefined ? anon++ : opened.add(key);
      } else {
        clicks++;
        if (key === undefined) anonClicks++;
        else {
          clickers.add(key);
          opened.add(key);
        }
        const l = (links[e.link ?? '?'] ??= { clicks: 0, unique: 0, who: new Set() });
        l.clicks++;
        if (key === undefined) l.unique++;
        else if (!l.who.has(key)) {
          l.who.add(key);
          l.unique++;
        }
      }
    }
    const opens = opened.size + anon;
    const uniqueClicks = clickers.size + anonClicks;
    const rate = (n: number, d: number) => (d > 0 ? n / d : null);
    return {
      sent,
      opens,
      proxyOpens: proxy.size + anonProxy,
      bots,
      clicks,
      uniqueClicks,
      links: Object.fromEntries(Object.entries(links).map(([k, v]) => [k, { clicks: v.clicks, unique: v.unique }])),
      openRate: rate(opens, sent),
      clickRate: rate(uniqueClicks, sent),
      clickToOpen: rate(uniqueClicks, opens),
      dropped: this.lost,
    };
  }
}
