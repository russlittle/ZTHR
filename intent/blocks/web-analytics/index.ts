/**
 * Website analytics that does not follow people. A pageview or event arrives with the address, referrer, browser
 * string and network address of the request. The address and browser string are mixed with a salt that is made
 * fresh each day and kept only for today and yesterday, then hashed into a visitor id: the same person is one
 * visitor for a day, the next day they are someone else, and nobody (including us) can turn the id back into an
 * address or link two days. The network address itself is never stored. Without consent that is the whole of it:
 * no cookie, no stored identifier. Only when the caller says consent was given is a client-supplied persistent id
 * honoured, so repeat visitors are recognised across days. Browsers that send Global Privacy Control or Do Not
 * Track are not counted at all (the default), and known bots and ignored addresses are filtered.
 *
 * Hits from one visitor join into a session while they arrive within a gap (30 minutes by default); a session
 * remembers where it began, how it was reached (referrer and the five UTM fields), how many pages and events it
 * held, and how long it lasted. A visit is a bounce when it had one pageview and no event. Sessions do not cross
 * midnight UTC, because the visitor id changes then. Goals are pages (with * wildcards) or named events, each
 * optionally matching properties, and report conversions and the conversion rate against all visitors.
 *
 * Because ids rotate daily, visitors over a range are the sum of each day's visitors, as other cookieless tools
 * do. Out of scope: geo lookup (the caller may pass a country), screen or browser parsing beyond bot detection,
 * storage beyond memory, and a tracking script.
 */
import { createHmac } from 'node:crypto';

export interface Site {
  readonly id: string;
  /** Hosts the site answers on; referrers from these are not counted as sources. */
  readonly domains: readonly string[];
}

export type GoalMatch =
  | { readonly kind: 'pageview'; readonly path: string }
  | { readonly kind: 'event'; readonly name: string; readonly props?: Readonly<Record<string, string | number | boolean>> };
export interface Goal {
  readonly id: string;
  readonly match: GoalMatch;
}

export interface Hit {
  readonly site: string;
  /** Full address of the page, as the browser has it. */
  readonly url: string;
  readonly referrer?: string;
  readonly userAgent: string;
  /** Used only to make the visitor hash; never stored. */
  readonly ip: string;
  /** Milliseconds since the epoch. */
  readonly at: number;
  /** "pageview" (default) or a declared event name. */
  readonly name?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly country?: string;
  /** A client-held id, honoured only when `consented` is true. */
  readonly persistentId?: string;
  readonly consented?: boolean;
  /** Request headers that matter: sec-gpc and dnt. */
  readonly signals?: { readonly gpc?: string; readonly dnt?: string };
}

export class UnknownSite extends Error {
  constructor(id: string) {
    super(`unknown site: ${id}`);
    this.name = 'UnknownSite';
  }
}

/** Daily salts: random, fresh each UTC day, kept for the day and the day before, then gone. */
export class SaltBook {
  private readonly salts = new Map<string, Buffer>();
  private readonly random: (n: number) => Uint8Array;
  constructor(random: (n: number) => Uint8Array) {
    this.random = random;
  }
  /** The salt for a UTC day (YYYY-MM-DD); older days than the previous one are forgotten at the same time. */
  forDay(day: string): Buffer {
    let s = this.salts.get(day);
    if (!s) {
      s = Buffer.from(this.random(32));
      this.salts.set(day, s);
      const keep = new Set([day, new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)]);
      for (const d of [...this.salts.keys()]) if (!keep.has(d)) this.salts.delete(d);
    }
    return s;
  }
  held(): string[] {
    return [...this.salts.keys()].sort();
  }
}

const BOTS = /bot\b|crawl|spider|slurp|headless|phantomjs|lighthouse|facebookexternalhit|curl\/|wget\/|python-requests|go-http-client|java\/|httpclient|monitor|uptime|preview|scrapy|libwww|axios|node-fetch/i;
export const isBot = (ua: string): boolean => ua.trim() === '' || BOTS.test(ua);

const SOURCES: readonly [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'Twitter'],
  [/(^|\.)(facebook\.com|fb\.com|l\.facebook\.com)$/, 'Facebook'],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, 'LinkedIn'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
  [/^news\.ycombinator\.com$/, 'Hacker News'],
];

export interface Landing {
  readonly path: string;
  readonly utm: Readonly<Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>>;
  readonly refParam: string | undefined;
}

const clean = (s: string | null, max = 100): string | undefined => {
  const t = (s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return t || undefined;
};

/** The page's path (no query, no fragment, no trailing slash except the root) and its campaign fields. */
export function parseLanding(url: string): Landing | undefined {
  if (url.length > 2000) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  let path = u.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  const utm: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content'] as const) {
    const v = clean(u.searchParams.get(`utm_${k}`));
    if (v) utm[k] = v.toLowerCase();
  }
  const ref = clean(u.searchParams.get('ref') ?? u.searchParams.get('source'));
  return { path, utm, refParam: ref?.toLowerCase() };
}

/** Where a visit came from: a known source name, else the referring host; nothing for the site's own pages. */
export function sourceOf(referrer: string | undefined, own: readonly string[]): string | undefined {
  if (!referrer) return undefined;
  let host: string;
  try {
    const u = new URL(referrer);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
  if (own.some((d) => host === d.toLowerCase().replace(/^www\./, ''))) return undefined;
  for (const [re, name] of SOURCES) if (re.test(host)) return name;
  return host;
}

export interface Session {
  readonly id: string;
  readonly site: string;
  readonly visitor: string;
  readonly day: string;
  startedAt: number;
  lastAt: number;
  entry: string;
  exit: string;
  pageviews: number;
  events: number;
  readonly source: string | undefined;
  readonly utm: Landing['utm'];
  readonly country: string | undefined;
}
export interface Recorded {
  readonly site: string;
  readonly visitor: string;
  readonly session: string;
  readonly name: string;
  readonly path: string;
  readonly at: number;
  readonly props: Readonly<Record<string, string | number | boolean>>;
}
export type Ingested = { readonly accepted: true; readonly visitor: string; readonly session: string; readonly newSession: boolean } | { readonly accepted: false; readonly reason: string };

export interface Options {
  readonly sites: readonly Site[];
  readonly salts: SaltBook;
  readonly goals?: readonly Goal[];
  readonly sessionGapMs?: number;
  /** Count nobody who sends Global Privacy Control or Do Not Track. Default true. */
  readonly respectSignals?: boolean;
  readonly ignoreIps?: readonly string[];
  /** Event names that may be recorded besides "pageview"; others are refused. */
  readonly events?: readonly string[];
}

const wildcard = (pattern: string, s: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(s);
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

function cleanProps(p: Readonly<Record<string, unknown>> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(p ?? {})) {
    if (n >= 10 || !/^[A-Za-z][\w-]{0,39}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else continue;
    n++;
  }
  return out;
}

export interface Row {
  readonly key: string;
  readonly visitors: number;
  readonly visits?: number;
  readonly pageviews?: number;
}
export interface GoalReport {
  readonly goal: string;
  readonly conversions: number;
  readonly converted: number;
  readonly rate: number;
}
export interface Stats {
  readonly visitors: number;
  readonly visits: number;
  readonly pageviews: number;
  readonly events: number;
  /** Percent of visits that were a bounce, one decimal. */
  readonly bounceRate: number;
  /** Mean seconds from a visit's first hit to its last. */
  readonly avgVisitSeconds: number;
  readonly pages: readonly Row[];
  readonly entryPages: readonly Row[];
  readonly sources: readonly Row[];
  readonly campaigns: readonly Row[];
  readonly goals: readonly GoalReport[];
  readonly byDay: readonly { day: string; visitors: number; pageviews: number }[];
}

export class WebAnalytics {
  readonly sessions: Session[] = [];
  readonly records: Recorded[] = [];
  readonly refused: Record<string, number> = {};
  private readonly o: Options & { sessionGapMs: number; respectSignals: boolean };
  private readonly sites: ReadonlyMap<string, Site>;
  private readonly open = new Map<string, Session>();

  constructor(o: Options) {
    this.o = { sessionGapMs: 30 * 60_000, respectSignals: true, ...o };
    this.sites = new Map(o.sites.map((s) => [s.id, s]));
  }

  /** The visitor id for a request: a keyed hash of site, address and browser under today's salt. */
  visitorId(site: string, ip: string, ua: string, at: number): string {
    return createHmac('sha256', this.o.salts.forDay(day(at))).update(`${site}\u0000${ip}\u0000${ua}`).digest('base64url').slice(0, 22);
  }

  private refuse(reason: string): Ingested {
    this.refused[reason] = (this.refused[reason] ?? 0) + 1;
    return { accepted: false, reason };
  }

  ingest(h: Hit): Ingested {
    const site = this.sites.get(h.site);
    if (!site) throw new UnknownSite(h.site);
    if (this.o.respectSignals && (h.signals?.gpc === '1' || h.signals?.dnt === '1')) return this.refuse('privacy signal');
    if (isBot(h.userAgent)) return this.refuse('bot');
    if (this.o.ignoreIps?.includes(h.ip)) return this.refuse('ignored address');
    const land = parseLanding(h.url);
    if (!land) return this.refuse('bad address');
    let host = '';
    try {
      host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      /* parseLanding has already checked */
    }
    if (!site.domains.some((d) => d.toLowerCase().replace(/^www\./, '') === host)) return this.refuse('host not on this site');
    const name = h.name ?? 'pageview';
    if (name !== 'pageview' && !(this.o.events ?? []).includes(name)) return this.refuse('undeclared event');
    if (!Number.isFinite(h.at)) return this.refuse('bad time');

    const visitor = h.consented === true && h.persistentId ? `p:${createHmac('sha256', 'persistent').update(`${h.site}\u0000${h.persistentId}`).digest('base64url').slice(0, 22)}` : this.visitorId(h.site, h.ip, h.userAgent, h.at);
    const d = day(h.at);
    const key = `${h.site}\u0000${visitor}`;
    let s = this.open.get(key);
    let isNew = false;
    if (!s || h.at - s.lastAt > this.o.sessionGapMs || (s.day !== d && !visitor.startsWith('p:')) || h.at < s.startedAt - this.o.sessionGapMs) {
      const src = land.utm.source ?? land.refParam ?? sourceOf(h.referrer, site.domains);
      s = { id: `${visitor}.${h.at}`, site: h.site, visitor, day: d, startedAt: h.at, lastAt: h.at, entry: land.path, exit: land.path, pageviews: 0, events: 0, source: src, utm: land.utm, country: h.country?.toUpperCase().slice(0, 2), };
      this.open.set(key, s);
      this.sessions.push(s);
      isNew = true;
    }
    if (h.at >= s.lastAt) {
      s.lastAt = h.at;
      s.exit = land.path;
    }
    s.startedAt = Math.min(s.startedAt, h.at);
    if (name === 'pageview') s.pageviews++;
    else s.events++;
    this.records.push({ site: h.site, visitor, session: s.id, name, path: land.path, at: h.at, props: cleanProps(h.props) });
    return { accepted: true, visitor, session: s.id, newSession: isNew };
  }

  private goalHit(g: Goal, r: Recorded): boolean {
    const m = g.match;
    if (m.kind === 'pageview') return r.name === 'pageview' && wildcard(m.path, r.path);
    return r.name === m.name && Object.entries(m.props ?? {}).every(([k, v]) => r.props[k] === v);
  }

  /** Numbers for a site between two instants (the start included, the end excluded). */
  stats(site: string, from: number, to: number, top = 10): Stats {
    if (!this.sites.has(site)) throw new UnknownSite(site);
    const ss = this.sessions.filter((s) => s.site === site && s.startedAt >= from && s.startedAt < to);
    const ids = new Set(ss.map((s) => s.id));
    const rs = this.records.filter((r) => ids.has(r.session));
    const visitors = new Set(ss.map((s) => `${s.day}|${s.visitor}`)).size;
    const bounces = ss.filter((s) => s.pageviews <= 1 && s.events === 0).length;
    const dur = ss.reduce((a, s) => a + (s.lastAt - s.startedAt), 0);
    const rows = (pick: (s: Session) => string | undefined): Row[] => {
      const m = new Map<string, { v: Set<string>; n: number }>();
      for (const s of ss) {
        const k = pick(s);
        if (k === undefined) continue;
        const e = m.get(k) ?? { v: new Set(), n: 0 };
        e.v.add(`${s.day}|${s.visitor}`);
        e.n++;
        m.set(k, e);
      }
      return [...m].map(([key, e]) => ({ key, visitors: e.v.size, visits: e.n })).sort((a, b) => b.visitors - a.visitors || b.visits! - a.visits! || a.key.localeCompare(b.key)).slice(0, top);
    };
    const pageMap = new Map<string, { v: Set<string>; n: number }>();
    for (const r of rs) {
      if (r.name !== 'pageview') continue;
      const e = pageMap.get(r.path) ?? { v: new Set(), n: 0 };
      e.v.add(`${day(r.at)}|${r.visitor}`);
      e.n++;
      pageMap.set(r.path, e);
    }
    const pages = [...pageMap].map(([key, e]) => ({ key, visitors: e.v.size, pageviews: e.n })).sort((a, b) => b.pageviews - a.pageviews || a.key.localeCompare(b.key)).slice(0, top);
    const goals = (this.o.goals ?? []).map((g): GoalReport => {
      const hits = rs.filter((r) => this.goalHit(g, r));
      const converted = new Set(hits.map((r) => `${day(r.at)}|${r.visitor}`)).size;
      return { goal: g.id, conversions: hits.length, converted, rate: visitors ? Math.round((converted / visitors) * 1000) / 10 : 0 };
    });
    const days = new Map<string, { v: Set<string>; p: number }>();
    for (const s of ss) {
      const e = days.get(s.day) ?? { v: new Set(), p: 0 };
      e.v.add(s.visitor);
      e.p += s.pageviews;
      days.set(s.day, e);
    }
    return {
      visitors,
      visits: ss.length,
      pageviews: ss.reduce((a, s) => a + s.pageviews, 0),
      events: ss.reduce((a, s) => a + s.events, 0),
      bounceRate: ss.length ? Math.round((bounces / ss.length) * 1000) / 10 : 0,
      avgVisitSeconds: ss.length ? Math.round(dur / ss.length / 100) / 10 : 0,
      pages,
      entryPages: rows((s) => s.entry),
      sources: rows((s) => s.source),
      campaigns: rows((s) => s.utm.campaign),
      goals,
      byDay: [...days].map(([d, e]) => ({ day: d, visitors: e.v.size, pageviews: e.p })).sort((a, b) => a.day.localeCompare(b.day)),
    };
  }
}
