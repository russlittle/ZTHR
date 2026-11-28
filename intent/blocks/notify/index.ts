/**
 * Notifications that respect the person. Templates fill named values (HTML-escaped) and refuse to send with one
 * missing. Each person chooses, per category, which channels reach them, instantly or in a digest; quiet hours in
 * their own time zone hold anything not urgent until morning. A hard bounce or complaint suppresses the address,
 * and every marketing or digest email carries one-click unsubscribe (RFC 8058) with a signed link. Reminders stop
 * as soon as the thing they nag about is done; every send leaves a receipt the person can see.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type Channel = 'email' | 'push' | 'sms' | 'inbox';

export interface Template {
  readonly key: string;
  readonly category: string;
  readonly subject: string;
  readonly body: string;
  /** Account and security mail cannot be turned off and ignores quiet hours. */
  readonly essential?: boolean;
}

export interface Prefs {
  readonly tz: string;
  /** Local hours, e.g. [22, 7]. */
  readonly quiet?: readonly [number, number];
  readonly categories?: Readonly<Record<string, { channels: readonly Channel[]; digest?: boolean }>>;
}

export interface Message {
  readonly to: string;
  readonly channel: Channel;
  readonly subject: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface Receipt {
  readonly id: number;
  readonly to: string;
  readonly template: string;
  readonly channel: Channel;
  readonly outcome: 'sent' | 'held' | 'digest' | 'suppressed' | 'off';
  readonly at: string;
  readonly why?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function render(t: string, values: Readonly<Record<string, string | number>>, html = true): string {
  const missing: string[] = [];
  const out = t.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k: string) => {
    if (!Object.hasOwn(values, k)) {
      missing.push(k);
      return '';
    }
    return html ? esc(String(values[k])) : String(values[k]);
  });
  if (missing.length) throw new Error(`the template needs ${missing.join(', ')}`);
  return out;
}

/** The hour of day in a time zone. */
export function localHour(d: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(d));
}

/** One key per person and category, whatever characters either holds. */
const key = (who: string, category: string) => JSON.stringify([who, category]);

/** The person and category a token carries: a JSON pair of strings, or the earlier two-line form. */
function readPair(text: string): [string, string] | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    // Not JSON: the earlier two-line form, below.
  }
  const lines = text.split('\n');
  return lines.length === 2 ? [lines[0]!, lines[1]!] : undefined;
}

const inQuiet = (h: number, [from, to]: readonly [number, number]) => (from <= to ? h >= from && h < to : h >= from || h < to);

export interface NotifyOptions {
  readonly send: (m: Message) => Promise<void>;
  readonly secret: string;
  readonly unsubscribeUrl: string;
  readonly now?: () => Date;
}

export class Notify {
  private readonly prefs = new Map<string, Prefs>();
  private readonly suppressed = new Map<string, string>();
  private readonly unsubscribed = new Set<string>();
  private readonly held: { to: string; m: Message; template: string; category: string }[] = [];
  private readonly digests = new Map<string, { template: string; subject: string }[]>();
  readonly receipts: Receipt[] = [];
  private readonly o: Required<NotifyOptions>;

  constructor(o: NotifyOptions) {
    this.o = { now: () => new Date(), ...o };
  }

  setPrefs(who: string, p: Prefs): void {
    this.prefs.set(who, p);
  }

  private receipt(r: Omit<Receipt, 'id' | 'at'>): Receipt {
    const full = { ...r, id: this.receipts.length + 1, at: this.o.now().toISOString() };
    this.receipts.push(full);
    return full;
  }

  /**
   * A signed token for one person and category, for the unsubscribe link. The pair is carried as a JSON array, so
   * any character in either (a line break included) reads back as the same pair.
   */
  token(who: string, category: string): string {
    const p = Buffer.from(JSON.stringify([who, category])).toString('base64url');
    return `${p}.${createHmac('sha256', this.o.secret).update(p).digest('base64url')}`;
  }

  /**
   * Handles the one-click POST (or the link). Returns who and what, or undefined for a bad token. A signed token
   * whose pair is two lines ("who", line break, "category", the earlier form) is read too, so links already sent
   * keep working.
   */
  unsubscribe(token: string): { who: string; category: string } | undefined {
    const [p, s, extra] = token.split('.');
    if (!p || !s || extra !== undefined) return undefined;
    const want = createHmac('sha256', this.o.secret).update(p).digest();
    const got = Buffer.from(s, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    const pair = readPair(Buffer.from(p, 'base64url').toString());
    if (!pair) return undefined;
    const [who, category] = pair;
    this.unsubscribed.add(key(who, category));
    return { who, category };
  }

  /** The unsubscribe link for a token: `t` is added to the configured URL's query, before any fragment. */
  private link(token: string): string {
    const u = this.o.unsubscribeUrl;
    const hash = u.indexOf('#');
    const base = hash < 0 ? u : u.slice(0, hash);
    const sep = !base.includes('?') ? '?' : /[?&]$/.test(base) ? '' : '&';
    return `${base}${sep}t=${token}${hash < 0 ? '' : u.slice(hash)}`;
  }

  /** From the mail provider: a hard bounce or a complaint stops mail to the address. */
  bounce(address: string, kind: 'hard' | 'soft' | 'complaint'): void {
    if (kind !== 'soft') this.suppressed.set(address.toLowerCase(), kind);
  }

  async notify(who: string, address: string, t: Template, values: Readonly<Record<string, string | number>>, o: { urgent?: boolean } = {}): Promise<Receipt[]> {
    const p = this.prefs.get(who) ?? { tz: 'UTC' };
    const cat = p.categories?.[t.category];
    const channels: readonly Channel[] = t.essential ? ['email'] : (cat?.channels ?? ['email', 'inbox']);
    // A subject becomes a mail header: a line break in a value must not start a new header.
    const subject = render(t.subject, values, false).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ');
    const body = render(t.body, values);
    const out: Receipt[] = [];
    let collected = false;
    if (!t.essential && this.unsubscribed.has(key(who, t.category))) return [this.receipt({ to: who, template: t.key, channel: 'email', outcome: 'off', why: 'unsubscribed' })];
    for (const channel of channels) {
      if (channel === 'email' && this.suppressed.has(address.toLowerCase())) {
        out.push(this.receipt({ to: who, template: t.key, channel, outcome: 'suppressed', why: `address ${this.suppressed.get(address.toLowerCase())} bounced` }));
        continue;
      }
      if (!t.essential && cat?.digest) {
        if (!collected) {
          const list = this.digests.get(who) ?? [];
          list.push({ template: t.key, subject });
          this.digests.set(who, list);
          collected = true;
        }
        out.push(this.receipt({ to: who, template: t.key, channel, outcome: 'digest' }));
        continue;
      }
      const headers: Record<string, string> = {};
      if (channel === 'email' && !t.essential) {
        headers['List-Unsubscribe'] = `<${this.link(this.token(who, t.category))}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      const m: Message = { to: channel === 'email' ? address : who, channel, subject, body, headers };
      if (!t.essential && !o.urgent && p.quiet && inQuiet(localHour(this.o.now(), p.tz), p.quiet)) {
        this.held.push({ to: who, m, template: t.key, category: t.category });
        out.push(this.receipt({ to: who, template: t.key, channel, outcome: 'held', why: 'quiet hours' }));
        continue;
      }
      await this.o.send(m);
      out.push(this.receipt({ to: who, template: t.key, channel, outcome: 'sent' }));
    }
    return out;
  }

  /**
   * Sends what quiet hours held, oldest first, for people whose quiet hours have ended. A bounce or an unsubscribe
   * that arrived while it was held still applies.
   */
  async release(): Promise<number> {
    let n = 0;
    const due = this.held.filter((h) => {
      const p = this.prefs.get(h.to);
      return !(p?.quiet && inQuiet(localHour(this.o.now(), p.tz), p.quiet));
    });
    for (const h of due) {
      this.held.splice(this.held.indexOf(h), 1);
      const address = h.m.to.toLowerCase();
      if (h.m.channel === 'email' && this.suppressed.has(address)) {
        this.receipt({ to: h.to, template: h.template, channel: h.m.channel, outcome: 'suppressed', why: `address ${this.suppressed.get(address)} bounced` });
        continue;
      }
      if (this.unsubscribed.has(key(h.to, h.category))) {
        this.receipt({ to: h.to, template: h.template, channel: h.m.channel, outcome: 'off', why: 'unsubscribed' });
        continue;
      }
      await this.o.send(h.m);
      this.receipt({ to: h.to, template: h.template, channel: h.m.channel, outcome: 'sent', why: 'after quiet hours' });
      n++;
    }
    return n;
  }

  /**
   * One message per person with everything collected since the last digest. Nothing goes to an address that
   * bounced or to someone who used the digest's unsubscribe link; what was collected is dropped with a receipt.
   */
  async digest(who: string, address: string): Promise<boolean> {
    const items = this.digests.get(who);
    if (!items?.length) return false;
    this.digests.delete(who);
    if (this.suppressed.has(address.toLowerCase())) {
      this.receipt({ to: who, template: 'digest', channel: 'email', outcome: 'suppressed', why: `address ${this.suppressed.get(address.toLowerCase())} bounced` });
      return false;
    }
    if (this.unsubscribed.has(key(who, 'digest'))) {
      this.receipt({ to: who, template: 'digest', channel: 'email', outcome: 'off', why: 'unsubscribed' });
      return false;
    }
    const body = `<ul>${items.map((i) => `<li>${esc(i.subject)}</li>`).join('')}</ul>`;
    await this.o.send({ to: address, channel: 'email', subject: `${items.length} update${items.length === 1 ? '' : 's'}`, body, headers: { 'List-Unsubscribe': `<${this.link(this.token(who, 'digest'))}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
    this.receipt({ to: who, template: 'digest', channel: 'email', outcome: 'sent' });
    return true;
  }

  /** What this person has been sent and why: the receipts page. */
  sentTo(who: string): readonly Receipt[] {
    return this.receipts.filter((r) => r.to === who);
  }
}

/** A reminder that repeats on a schedule and stops by itself as soon as `done()` is true, or after `max` sends. */
export class Reminder {
  sent = 0;
  stopped?: string;
  private readonly done: () => Promise<boolean> | boolean;
  private readonly fire: () => Promise<void>;
  private readonly max: number;
  constructor(done: () => Promise<boolean> | boolean, fire: () => Promise<void>, max = 3) {
    this.done = done;
    this.fire = fire;
    this.max = max;
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (await this.done()) {
      this.stopped = 'done';
      return;
    }
    if (this.sent >= this.max) {
      this.stopped = 'gave up';
      return;
    }
    await this.fire();
    this.sent++;
  }
}
