/**
 * Public status pages built from monitors. Components sit in groups; each component's state comes from its
 * monitors' recent beats (consecutive failures make it down, slow answers make it degraded), is raised by any open
 * incident that names it, and is overridden while a maintenance window is active. The page shows an uptime
 * percentage and a daily bar per component, an incident feed (Atom, RFC 4287, and JSON Feed 1.1; every value
 * escaped), subscribers who confirm by a signed single-purpose link and hear only about the components they chose,
 * and a status badge as an SVG (every value escaped, colour from the state).
 *
 * States are the health block's: ok, degraded, down. Time is always an argument. Out of scope: sending the
 * notifications (the caller delivers the messages this block composes) and drawing the page itself.
 */
import { equal, sign, verify, BadToken } from '../crypto/index.ts';
import type { Status } from '../health/index.ts';

export type { Status };

export class StatusPageError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface Beat {
  readonly at: number;
  readonly up: boolean;
  /** Milliseconds the check took, when it answered. */
  readonly ms?: number;
}

export interface Monitor {
  readonly id: string;
  readonly beats: readonly Beat[];
}

export interface Component {
  readonly id: string;
  readonly name: string;
  readonly monitors: readonly string[];
}

export interface Group {
  readonly name: string;
  readonly components: readonly Component[];
}

export interface Rules {
  /** Consecutive failed beats, newest first, that make a component down. */
  readonly downAfter: number;
  /** A newest beat slower than this many ms makes it degraded. */
  readonly slowMs: number;
}

export const DEFAULT_RULES: Rules = { downAfter: 3, slowMs: 2000 };

const rank: Record<Status, number> = { ok: 0, degraded: 1, down: 2 };
const worst = (a: Status, b: Status): Status => (rank[b] > rank[a] ? b : a);

/** One monitor's state from its beats, newest decides: failures in a row are down, one failure or a slow answer is degraded. */
export function monitorStatus(beats: readonly Beat[], rules: Rules = DEFAULT_RULES): Status {
  if (!beats.length) return 'ok';
  const newest = [...beats].sort((a, b) => b.at - a.at);
  let fails = 0;
  for (const b of newest) {
    if (b.up) break;
    fails++;
  }
  if (fails >= rules.downAfter) return 'down';
  if (fails > 0) return 'degraded';
  const last = newest[0]!;
  if (last.ms !== undefined && last.ms > rules.slowMs) return 'degraded';
  return 'ok';
}

export type IncidentState = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface IncidentUpdate {
  readonly at: number;
  readonly state: IncidentState;
  readonly text: string;
}

export interface Incident {
  readonly id: string;
  readonly title: string;
  readonly components: readonly string[];
  /** The state the incident forces on its components while open. */
  readonly impact: Status;
  readonly updates: readonly IncidentUpdate[];
}

export interface Maintenance {
  readonly id: string;
  readonly title: string;
  readonly components: readonly string[];
  readonly from: number;
  readonly to: number;
}

export const isOpen = (i: Incident) => i.updates.at(-1)?.state !== 'resolved';

export interface ComponentView {
  readonly id: string;
  readonly name: string;
  readonly status: Status;
  readonly because: string;
}

export interface PageView {
  readonly overall: Status;
  readonly headline: string;
  readonly groups: readonly { name: string; status: Status; components: readonly ComponentView[] }[];
  readonly incidents: readonly { id: string; title: string; state: IncidentState; latest: string }[];
  readonly maintenance: readonly { id: string; title: string; active: boolean; from: number; to: number }[];
}

const HEADLINES: Record<Status, string> = { ok: 'All systems operational', degraded: 'Some systems are degraded', down: 'Some systems are down' };

export function pageView(groups: readonly Group[], monitors: readonly Monitor[], incidents: readonly Incident[], maintenance: readonly Maintenance[], now: number, rules: Rules = DEFAULT_RULES): PageView {
  const byMonitor = new Map(monitors.map((m) => [m.id, m]));
  const open = incidents.filter(isOpen);
  const activeMaint = maintenance.filter((m) => m.from <= now && now < m.to);
  const gv = groups.map((g) => {
    const comps = g.components.map((c): ComponentView => {
      if (activeMaint.some((m) => m.components.includes(c.id))) return { id: c.id, name: c.name, status: 'degraded', because: 'scheduled maintenance' };
      let st: Status = 'ok';
      let because = 'monitors are passing';
      for (const mid of c.monitors) {
        const m = byMonitor.get(mid);
        const s = m ? monitorStatus(m.beats, rules) : 'ok';
        if (rank[s] > rank[st]) {
          st = s;
          because = `monitor ${mid} is ${s}`;
        }
      }
      for (const i of open) {
        if (i.components.includes(c.id) && rank[i.impact] > rank[st]) {
          st = i.impact;
          because = `incident: ${i.title}`;
        }
      }
      return { id: c.id, name: c.name, status: st, because };
    });
    return { name: g.name, status: comps.reduce<Status>((w, c) => worst(w, c.status), 'ok'), components: comps };
  });
  const overall = gv.reduce<Status>((w, g) => worst(w, g.status), 'ok');
  return {
    overall,
    headline: HEADLINES[overall],
    groups: gv,
    incidents: open.map((i) => ({ id: i.id, title: i.title, state: i.updates.at(-1)!.state, latest: i.updates.at(-1)!.text })),
    maintenance: maintenance.filter((m) => m.to > now).map((m) => ({ id: m.id, title: m.title, active: m.from <= now, from: m.from, to: m.to })),
  };
}

// ---------------------------------------------------------------- uptime

const DAY = 86_400_000;

/** Share of beats that were up in the window ending at `now`, as a percentage with two decimals; null when no beats. */
export function uptime(beats: readonly Beat[], now: number, windowMs: number): number | null {
  const inside = beats.filter((b) => b.at > now - windowMs && b.at <= now);
  if (!inside.length) return null;
  return Math.round((inside.filter((b) => b.up).length / inside.length) * 10_000) / 100;
}

/** One cell per day, oldest first, ending with the day that holds `now`: the status of that day's beats, or null where there are none. */
export function dailyBars(beats: readonly Beat[], now: number, days: number, rules: Rules = DEFAULT_RULES): (Status | null)[] {
  const endDay = Math.floor(now / DAY);
  const out: (Status | null)[] = [];
  for (let d = endDay - days + 1; d <= endDay; d++) {
    const day = beats.filter((b) => Math.floor(b.at / DAY) === d && b.at <= now);
    if (!day.length) {
      out.push(null);
      continue;
    }
    const downs = day.filter((b) => !b.up).length;
    out.push(downs === 0 ? (day.some((b) => b.ms !== undefined && b.ms > rules.slowMs) ? 'degraded' : 'ok') : downs / day.length >= 0.5 ? 'down' : 'degraded');
  }
  return out;
}

// ---------------------------------------------------------------- escaping and feeds

export const escapeXml = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

const iso = (ms: number) => new Date(ms).toISOString();

/** An Atom 1.0 feed (RFC 4287) of incidents, newest first, one entry per incident, updated at its last update. */
export function atomFeed(o: { title: string; baseUrl: string; id: string }, incidents: readonly Incident[]): string {
  const sorted = [...incidents].filter((i) => i.updates.length).sort((a, b) => b.updates.at(-1)!.at - a.updates.at(-1)!.at);
  const updated = sorted[0] ? iso(sorted[0].updates.at(-1)!.at) : iso(0);
  const entries = sorted.map((i) => {
    const body = [...i.updates].reverse().map((u) => `<p><strong>${escapeXml(u.state)}</strong> - ${escapeXml(iso(u.at))}<br/>${escapeXml(u.text)}</p>`).join('');
    return `<entry><id>${escapeXml(`${o.id}/incidents/${i.id}`)}</id><title>${escapeXml(i.title)}</title><link href="${escapeXml(`${o.baseUrl}/incidents/${i.id}`)}"/><published>${iso(i.updates[0]!.at)}</published><updated>${iso(i.updates.at(-1)!.at)}</updated><content type="html">${escapeXml(body)}</content></entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${escapeXml(o.id)}</id><title>${escapeXml(o.title)}</title><link rel="self" href="${escapeXml(`${o.baseUrl}/feed.atom`)}"/><updated>${updated}</updated>${entries.join('')}</feed>`;
}

/** A JSON Feed 1.1 document of the same incidents. */
export function jsonFeed(o: { title: string; baseUrl: string }, incidents: readonly Incident[]): string {
  const sorted = [...incidents].filter((i) => i.updates.length).sort((a, b) => b.updates.at(-1)!.at - a.updates.at(-1)!.at);
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: o.title,
    home_page_url: o.baseUrl,
    items: sorted.map((i) => ({ id: i.id, url: `${o.baseUrl}/incidents/${i.id}`, title: i.title, content_text: [...i.updates].reverse().map((u) => `${u.state}: ${u.text}`).join('\n'), date_published: iso(i.updates[0]!.at), date_modified: iso(i.updates.at(-1)!.at) })),
  });
}

// ---------------------------------------------------------------- subscribers

export interface Subscriber {
  readonly email: string;
  /** Component ids; empty means every component. */
  readonly components: readonly string[];
  readonly confirmed: boolean;
}

export interface Message {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** One-click unsubscribe link for this person. */
  readonly unsubscribe: string;
}

const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export class Subscribers {
  private readonly subs = new Map<string, Subscriber>();
  private readonly sent = new Set<string>();
  private readonly secret: string;
  private readonly baseUrl: string;
  constructor(secret: string, baseUrl: string) {
    this.secret = secret;
    this.baseUrl = baseUrl;
  }
  /** Starts a subscription; it is not live until the emailed link is followed. Returns the confirmation link. */
  subscribe(email: string, components: readonly string[], now: number): string {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) throw new StatusPageError('that is not an email address');
    const existing = this.subs.get(e);
    this.subs.set(e, { email: e, components: [...components], confirmed: existing?.confirmed ?? false });
    return `${this.baseUrl}/confirm?t=${sign(this.secret, 'status-confirm', { email: e }, 48 * 3_600_000, now)}`;
  }
  confirm(token: string, now: number): Subscriber {
    const d = this.read('status-confirm', token, now);
    const s = this.subs.get(String(d.email));
    if (!s) throw new StatusPageError('that subscription no longer exists');
    const c = { ...s, confirmed: true };
    this.subs.set(c.email, c);
    return c;
  }
  /** One-click removal; the link never expires, so an old email can always be used. */
  unsubscribeLink(email: string, now: number): string {
    return `${this.baseUrl}/unsubscribe?t=${sign(this.secret, 'status-unsubscribe', { email }, 10 * 365 * DAY, now)}`;
  }
  unsubscribe(token: string, now: number): boolean {
    return this.subs.delete(String(this.read('status-unsubscribe', token, now).email));
  }
  private read(purpose: string, token: string, now: number): Record<string, unknown> {
    try {
      return verify(this.secret, purpose, token, now);
    } catch (e) {
      throw new StatusPageError(e instanceof BadToken ? `that link is not valid: ${e.message}` : 'that link is not valid');
    }
  }
  get(email: string): Subscriber | undefined {
    return this.subs.get(email.trim().toLowerCase());
  }
  /**
   * The messages for one incident update: only confirmed subscribers whose chosen components overlap the
   * incident's, and each person at most once per update, however many times this is called.
   */
  messagesFor(i: Incident, now: number): Message[] {
    const u = i.updates.at(-1);
    if (!u) return [];
    const out: Message[] = [];
    for (const s of this.subs.values()) {
      if (!s.confirmed) continue;
      if (s.components.length && !s.components.some((c) => i.components.includes(c))) continue;
      const key = `${s.email}|${i.id}|${i.updates.length}`;
      if (this.sent.has(key)) continue;
      this.sent.add(key);
      out.push({ to: s.email, subject: `[${u.state}] ${i.title}`, text: `${u.text}\n\n${iso(u.at)}`, unsubscribe: this.unsubscribeLink(s.email, now) });
    }
    return out;
  }
  count(): { confirmed: number; pending: number } {
    const all = [...this.subs.values()];
    return { confirmed: all.filter((s) => s.confirmed).length, pending: all.filter((s) => !s.confirmed).length };
  }
}

// ---------------------------------------------------------------- badge

const COLOURS: Record<Status | 'unknown', string> = { ok: '#2e7d32', degraded: '#b26a00', down: '#c62828', unknown: '#5f6368' };
const WORDS: Record<Status | 'unknown', string> = { ok: 'operational', degraded: 'degraded', down: 'down', unknown: 'unknown' };

/** A flat two-part badge: the label on grey, the state on its colour. Text is escaped; width follows the text. */
export function badge(label: string, status: Status | 'unknown'): string {
  const value = WORDS[status];
  const w = (s: string) => Math.ceil(s.length * 6.4) + 12;
  const lw = w(label);
  const vw = w(value);
  const l = escapeXml(label);
  const v = escapeXml(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${l}: ${v}"><title>${l}: ${v}</title><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${COLOURS[status]}"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${l}</text><text x="${lw + vw / 2}" y="14">${v}</text></g></svg>`;
}

/** Whether a presented badge key matches the configured one, in constant time (for private-page badges). */
export const badgeKeyOk = (given: string, expected: string): boolean => expected.length > 0 && equal(given, expected);
