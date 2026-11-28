/**
 * The outbound mail queue's decisions, kept apart from any sending: what to send now, to whom, how fast, what a
 * failure means, when to try again, and how a new sending address earns its reputation. Messages are split per
 * recipient domain (one SMTP session delivers all of a domain's recipients), and each domain has its own policy:
 * concurrent connections, starts per minute, recipients per session. Throttling answers (421/450/451 with 4.7.x or
 * "too many", "rate limited", "try again later") slow the whole domain with a halving of its concurrency and a
 * growing pause, then it creeps back up one connection per ten successes (additive increase, multiplicative
 * decrease); greylisting gets its own short, fixed retries; a full mailbox, a connection failure and a DNS failure
 * are told apart. Permanent answers bounce at once (an unknown mailbox also suppresses the address); a message that
 * has been deferred for too long gets one delay notice, and expires with its last error after the maximum age.
 * The retry curve doubles from five minutes to a cap with jitter. The warm-up plan gives a new IP a daily volume
 * ramp that advances only when yesterday was healthy, holds when bounces creep up, and steps back when they spike.
 * Reply semantics follow RFC 5321 and RFC 3463 (the classify helper comes from the smtp-protocol block). Clock and
 * randomness are arguments; there is no network, disk or DNS here, and a sender calls next() and report().
 */
import { classify } from '../smtp-protocol/index.ts';

export class QueueError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- classification

export type DeferralClass = 'throttle' | 'greylist' | 'mailbox-full' | 'connection' | 'dns' | 'tls' | 'temporary';
export type BounceClass = 'no-such-user' | 'mailbox-disabled' | 'policy' | 'content' | 'too-large' | 'relay-denied' | 'permanent';

export interface Verdict {
  readonly action: 'delivered' | 'defer' | 'bounce';
  readonly class?: DeferralClass | BounceClass;
  /** Whether this says something about the domain as a whole (slow down), not about the one message. */
  readonly scope: 'recipient' | 'domain';
  /** The address should not be mailed again. */
  readonly suppress: boolean;
}

const THROTTLE = /too many|rate.?limit|throttl|slow down|temporar(il)?y (deferred|rate)|try again later|exceed|limit(ed)? reached|connection (rate|limit)|volume|reputation/i;
const GREY = /greylist|graylist|grey-list|gray-list|try again in|come back later|deferred for greylisting/i;

/** What a receiving server's answer means for the queue. `enhanced` is the RFC 3463 code when the reply carried one. */
export function classifyReply(code: number, enhanced: string | undefined, text: string): Verdict {
  const cls = classify(code);
  const e = enhanced ?? '';
  const v = (action: Verdict['action'], c: Verdict['class'] | undefined, scope: Verdict['scope'] = 'recipient', suppress = false): Verdict => ({ action, ...(c ? { class: c } : {}), scope, suppress });
  if (cls === 'positive') return v('delivered', undefined);
  if (cls === 'intermediate') return v('defer', 'temporary');
  if (cls === 'transient') {
    if (e.startsWith('4.2.2') || /mailbox full|over quota|quota exceeded/i.test(text)) return v('defer', 'mailbox-full');
    if (GREY.test(text) || e === '4.7.1' && /later|grey|gray/i.test(text)) return v('defer', 'greylist');
    if (code === 421 || e.startsWith('4.7') || e.startsWith('4.4.5') || THROTTLE.test(text)) return v('defer', 'throttle', 'domain');
    if (e.startsWith('4.4.')) return v('defer', 'connection', 'domain');
    return v('defer', 'temporary');
  }
  if (e.startsWith('5.1.1') || e.startsWith('5.1.2') || e.startsWith('5.1.3') || e.startsWith('5.1.6') || (code === 550 && /no such user|user unknown|does not exist|unknown user|no mailbox|invalid recipient|recipient rejected/i.test(text) && !e.startsWith('5.7'))) return v('bounce', 'no-such-user', 'recipient', true);
  if (e.startsWith('5.2.1') || /disabled|suspended|deactivated/i.test(text) && e.startsWith('5.2')) return v('bounce', 'mailbox-disabled', 'recipient', true);
  if (e.startsWith('5.3.4') || code === 552 || /too large|message size|exceeds/i.test(text)) return v('bounce', 'too-large');
  if (e.startsWith('5.7.1') && /relay/i.test(text)) return v('bounce', 'relay-denied');
  if (e.startsWith('5.7') || e.startsWith('5.4.7') || /blocked|blacklist|blocklist|spamhaus|reputation|policy|dmarc|spf|dkim|unauthenticated|not authorized/i.test(text)) return v('bounce', 'policy', 'domain');
  if (e.startsWith('5.6') || /content|spam|virus|malware/i.test(text)) return v('bounce', 'content');
  return v('bounce', 'permanent');
}

// ---------------------------------------------------------------- retry curve

export interface RetryCurve {
  readonly firstMs: number;
  readonly capMs: number;
  /** The age at which a message that has not been delivered expires. */
  readonly maxAgeMs: number;
  /** After this long deferred, the sender is told once. */
  readonly delayNoticeMs: number;
  readonly jitter: number;
}

const MIN = 60_000;
export const DEFAULT_CURVE: RetryCurve = { firstMs: 5 * MIN, capMs: 4 * 60 * MIN, maxAgeMs: 5 * 24 * 60 * MIN, delayNoticeMs: 4 * 60 * MIN, jitter: 0.1 };

/**
 * The wait before attempt number `attempt` (1 is the retry after the first failure): 5, 10, 20, 40 minutes, 1h20,
 * and so on up to the cap, with jitter so retries from one outage do not arrive together. Greylisting is a short
 * fixed ladder (5, 15, 30 minutes) because greylisters accept a retry after a few minutes and not before; a full
 * mailbox backs off slowly (starting at an hour) since it will not clear soon; a failed connection retries a bit
 * faster; a throttle uses the base curve (the domain pause handles the rest).
 */
export function retryDelay(attempt: number, klass: DeferralClass | undefined, curve: RetryCurve, random: () => number): number {
  const n = Math.max(1, Math.floor(attempt));
  let base: number;
  switch (klass) {
    case 'greylist':
      base = [5 * MIN, 15 * MIN, 30 * MIN][Math.min(n, 3) - 1]!;
      break;
    case 'mailbox-full':
      base = Math.min(curve.capMs, 60 * MIN * 2 ** (n - 1));
      break;
    case 'connection':
    case 'dns':
      base = Math.min(curve.capMs, (curve.firstMs / 2) * 2 ** (n - 1));
      break;
    default:
      base = Math.min(curve.capMs, curve.firstMs * 2 ** (n - 1));
  }
  const j = 1 + (random() * 2 - 1) * curve.jitter;
  return Math.round(base * j);
}

// ---------------------------------------------------------------- domains

export interface DomainPolicy {
  /** Most connections at once. */
  readonly maxConcurrent: number;
  /** Most session starts in any minute. */
  readonly perMinute: number;
  /** Most recipients in one session; more are split into further deliveries. */
  readonly maxRecipients: number;
}

export const DEFAULT_POLICY: DomainPolicy = { maxConcurrent: 5, perMinute: 60, maxRecipients: 50 };

interface DomainState {
  limit: number;
  inflight: number;
  starts: number[];
  pausedUntil: number;
  throttles: number;
  successes: number;
  lastClass: DeferralClass | BounceClass | undefined;
}

// ---------------------------------------------------------------- the queue

export interface Message {
  readonly id: string;
  readonly from: string;
  readonly recipients: readonly string[];
  /** Lower goes first: 0 for a password reset, 5 for a newsletter. */
  readonly priority?: number;
}

export type RecipientStatus = 'pending' | 'delivered' | 'bounced' | 'expired';

export interface RecipientResult {
  readonly to: string;
  status: RecipientStatus;
  code?: number;
  text?: string;
  class?: DeferralClass | BounceClass;
}

export interface Delivery {
  readonly id: string;
  readonly message: string;
  readonly from: string;
  readonly domain: string;
  readonly priority: number;
  readonly enqueuedAt: number;
  readonly recipients: RecipientResult[];
  state: 'queued' | 'sending' | 'done';
  attempts: number;
  nextAt: number;
  leaseUntil?: number;
  firstDeferredAt?: number;
  delayNoticeSent: boolean;
  lastClass?: DeferralClass | BounceClass;
  lastError?: string;
}

export type Outcome =
  | { readonly kind: 'session'; readonly results: readonly { readonly to: string; readonly code: number; readonly enhanced?: string; readonly text: string }[] }
  | { readonly kind: 'failed'; readonly stage: 'dns' | 'connect' | 'tls' | 'greeting' | 'timeout'; readonly error: string }
  | { readonly kind: 'reply'; readonly code: number; readonly enhanced?: string; readonly text: string };

export type QueueEvent =
  | { readonly type: 'delivered' | 'bounced' | 'expired'; readonly delivery: string; readonly message: string; readonly to: string; readonly code?: number; readonly text?: string; readonly class?: string }
  | { readonly type: 'deferred'; readonly delivery: string; readonly message: string; readonly class: DeferralClass; readonly retryAt: number; readonly text: string }
  | { readonly type: 'delay-notice'; readonly delivery: string; readonly message: string; readonly from: string; readonly recipients: readonly string[] }
  | { readonly type: 'suppressed'; readonly address: string; readonly reason: string }
  | { readonly type: 'domain-slowed'; readonly domain: string; readonly limit: number; readonly pausedUntil: number };

export interface QueueOptions {
  readonly now: () => number;
  readonly random: () => number;
  readonly defaultPolicy?: DomainPolicy;
  /** Exact domains ("gmail.com") or suffixes (".mail.protection.outlook.com"). The longest match wins. */
  readonly policies?: Readonly<Record<string, DomainPolicy>>;
  readonly curve?: RetryCurve;
  /** How long a claimed delivery may be out before it counts as lost. */
  readonly leaseMs?: number;
}

const domainOf = (addr: string) => addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();

export class MailQueue {
  readonly deliveries = new Map<string, Delivery>();
  readonly suppressed = new Map<string, string>();
  private readonly domains = new Map<string, DomainState>();
  private readonly o: Required<Omit<QueueOptions, 'policies'>> & { policies: Readonly<Record<string, DomainPolicy>> };

  constructor(o: QueueOptions) {
    this.o = { defaultPolicy: DEFAULT_POLICY, policies: {}, curve: DEFAULT_CURVE, leaseMs: 10 * MIN, ...o };
  }

  policy(domain: string): DomainPolicy {
    const d = domain.toLowerCase();
    const exact = Object.hasOwn(this.o.policies, d) ? this.o.policies[d] : undefined;
    if (exact) return exact;
    let best = '';
    for (const k of Object.keys(this.o.policies)) if (k.startsWith('.') && d.endsWith(k) && k.length > best.length) best = k;
    return best ? this.o.policies[best]! : this.o.defaultPolicy;
  }

  private dom(domain: string): DomainState {
    let s = this.domains.get(domain);
    if (!s) {
      s = { limit: this.policy(domain).maxConcurrent, inflight: 0, starts: [], pausedUntil: 0, throttles: 0, successes: 0, lastClass: undefined };
      this.domains.set(domain, s);
    }
    return s;
  }

  /** Never mail this address again (a hard bounce, a complaint, an unsubscribe). */
  suppress(address: string, reason: string): void {
    this.suppressed.set(address.toLowerCase(), reason);
  }

  /**
   * Accepts a message, split into one delivery per domain (and per `maxRecipients` of a domain). Suppressed and
   * malformed recipients are returned as refused, not queued.
   */
  enqueue(m: Message): { queued: string[]; refused: { to: string; reason: string }[] } {
    if (!m.id || !m.from) throw new QueueError('a message needs an id and a sender');
    const refused: { to: string; reason: string }[] = [];
    const byDomain = new Map<string, string[]>();
    for (const to of new Set(m.recipients)) {
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to) && !/^[^\s@<>]+@\[[^\]]+\]$/.test(to)) {
        refused.push({ to, reason: 'not an address' });
        continue;
      }
      const why = this.suppressed.get(to.toLowerCase());
      if (why) {
        refused.push({ to, reason: `suppressed: ${why}` });
        continue;
      }
      const d = domainOf(to);
      byDomain.set(d, [...(byDomain.get(d) ?? []), to]);
    }
    const queued: string[] = [];
    const now = this.o.now();
    for (const [domain, list] of byDomain) {
      const per = Math.max(1, this.policy(domain).maxRecipients);
      for (let i = 0; i < list.length; i += per) {
        const id = `${m.id}@${domain}${i ? `#${i / per + 1}` : ''}`;
        if (this.deliveries.has(id)) throw new QueueError(`${id} is already queued`);
        this.deliveries.set(id, { id, message: m.id, from: m.from, domain, priority: m.priority ?? 5, enqueuedAt: now, recipients: list.slice(i, i + per).map((to) => ({ to, status: 'pending' as const })), state: 'queued', attempts: 0, nextAt: now, delayNoticeSent: false });
        queued.push(id);
      }
    }
    return { queued, refused };
  }

  /**
   * Claims the deliveries that may start now: due, in priority then due order, within each domain's concurrency,
   * pause and start rate. Claimed deliveries must be reported (or they are reclaimed when their lease ends).
   */
  next(limit = Infinity): Delivery[] {
    const now = this.o.now();
    const due = [...this.deliveries.values()].filter((d) => d.state === 'queued' && d.nextAt <= now).sort((a, b) => a.priority - b.priority || a.nextAt - b.nextAt || a.enqueuedAt - b.enqueuedAt);
    const out: Delivery[] = [];
    for (const d of due) {
      if (out.length >= limit) break;
      const s = this.dom(d.domain);
      s.starts = s.starts.filter((t) => t > now - MIN);
      if (now < s.pausedUntil || s.inflight >= s.limit || s.starts.length >= this.policy(d.domain).perMinute) continue;
      d.state = 'sending';
      d.leaseUntil = now + this.o.leaseMs;
      s.inflight++;
      s.starts.push(now);
      out.push(d);
    }
    return out;
  }

  /** The earliest time something could be sent, for a sleeping worker; null when nothing waits. */
  nextWake(): number | null {
    let t: number | null = null;
    for (const d of this.deliveries.values()) {
      if (d.state !== 'queued') continue;
      const s = this.domains.get(d.domain);
      const at = Math.max(d.nextAt, s?.pausedUntil ?? 0);
      t = t === null ? at : Math.min(t, at);
    }
    return t;
  }

  /** Deliveries claimed and never reported are treated as timed out. */
  sweep(): QueueEvent[] {
    const now = this.o.now();
    const ev: QueueEvent[] = [];
    for (const d of this.deliveries.values()) if (d.state === 'sending' && (d.leaseUntil ?? 0) <= now) ev.push(...this.report(d.id, { kind: 'failed', stage: 'timeout', error: 'no result was reported before the lease ended' }));
    return ev;
  }

  private slow(domain: string, ev: QueueEvent[]): void {
    const now = this.o.now();
    const s = this.dom(domain);
    s.throttles++;
    s.successes = 0;
    s.limit = Math.max(1, Math.floor(s.limit / 2));
    s.pausedUntil = now + Math.min(60 * MIN, 5 * MIN * 2 ** (s.throttles - 1));
    ev.push({ type: 'domain-slowed', domain, limit: s.limit, pausedUntil: s.pausedUntil });
  }

  /** Records what happened to a claimed delivery, and returns what the app should act on (bounce mails, notices). */
  report(id: string, outcome: Outcome): QueueEvent[] {
    const d = this.deliveries.get(id);
    if (!d || d.state !== 'sending') throw new QueueError(`${id} is not out for delivery`);
    const now = this.o.now();
    const s = this.dom(d.domain);
    s.inflight = Math.max(0, s.inflight - 1);
    d.attempts++;
    delete d.leaseUntil;
    const ev: QueueEvent[] = [];
    let worst: { klass: DeferralClass; text: string } | undefined;
    let domainSlow = false;
    let anyDelivered = false;
    const apply = (r: RecipientResult, code: number, enhanced: string | undefined, text: string) => {
      const v = classifyReply(code, enhanced, text);
      r.code = code;
      r.text = text;
      if (v.action === 'delivered') {
        r.status = 'delivered';
        anyDelivered = true;
        ev.push({ type: 'delivered', delivery: d.id, message: d.message, to: r.to, code, text });
      } else if (v.action === 'bounce') {
        r.status = 'bounced';
        r.class = v.class as BounceClass;
        ev.push({ type: 'bounced', delivery: d.id, message: d.message, to: r.to, code, text, class: v.class! });
        if (v.suppress) {
          this.suppress(r.to, `${code} ${text}`.slice(0, 200));
          ev.push({ type: 'suppressed', address: r.to, reason: `${code} ${text}`.slice(0, 200) });
        }
        d.lastClass = v.class as BounceClass;
      } else {
        r.class = v.class as DeferralClass;
        worst = { klass: v.class as DeferralClass, text: `${code} ${text}` };
        if (v.scope === 'domain') domainSlow = true;
      }
    };
    const pending = d.recipients.filter((r) => r.status === 'pending');
    if (outcome.kind === 'session') {
      for (const r of pending) {
        const res = outcome.results.find((x) => x.to === r.to);
        if (res) apply(r, res.code, res.enhanced, res.text);
        else {
          worst = { klass: 'temporary', text: 'the session ended before this recipient was answered' };
        }
      }
    } else if (outcome.kind === 'reply') {
      for (const r of pending) apply(r, outcome.code, outcome.enhanced, outcome.text);
    } else {
      const klass: DeferralClass = outcome.stage === 'dns' ? 'dns' : outcome.stage === 'tls' ? 'tls' : 'connection';
      for (const r of pending) r.class = klass;
      worst = { klass, text: `${outcome.stage}: ${outcome.error}` };
    }
    if (anyDelivered && !domainSlow) {
      s.successes++;
      s.throttles = 0;
      if (s.successes % 10 === 0 && s.limit < this.policy(d.domain).maxConcurrent) s.limit++;
    }
    if (domainSlow) this.slow(d.domain, ev);
    const left = d.recipients.filter((r) => r.status === 'pending');
    if (!left.length) {
      d.state = 'done';
      return ev;
    }
    const w = worst ?? { klass: 'temporary' as DeferralClass, text: 'deferred' };
    d.lastClass = w.klass;
    d.lastError = w.text;
    d.firstDeferredAt ??= now;
    const age = now - d.enqueuedAt;
    const retryAt = now + retryDelay(d.attempts, w.klass, this.o.curve, this.o.random);
    if (age >= this.o.curve.maxAgeMs || retryAt - d.enqueuedAt > this.o.curve.maxAgeMs) {
      for (const r of left) {
        r.status = 'expired';
        ev.push({ type: 'expired', delivery: d.id, message: d.message, to: r.to, text: `still undelivered after ${Math.round(age / 3_600_000)} hours; last answer: ${w.text}`, ...(r.class ? { class: r.class } : {}) });
      }
      d.state = 'done';
      return ev;
    }
    d.state = 'queued';
    d.nextAt = retryAt;
    ev.push({ type: 'deferred', delivery: d.id, message: d.message, class: w.klass, retryAt, text: w.text });
    if (!d.delayNoticeSent && now - d.firstDeferredAt >= this.o.curve.delayNoticeMs) {
      d.delayNoticeSent = true;
      ev.push({ type: 'delay-notice', delivery: d.id, message: d.message, from: d.from, recipients: left.map((r) => r.to) });
    }
    return ev;
  }

  /** The state of a domain: connections out, the current limit, any pause, and the last problem. */
  domainStatus(domain: string): { inflight: number; limit: number; maxConcurrent: number; pausedUntil: number | null; startsLastMinute: number; lastClass?: string } {
    const d = domain.toLowerCase();
    const s = this.dom(d);
    const now = this.o.now();
    return { inflight: s.inflight, limit: s.limit, maxConcurrent: this.policy(d).maxConcurrent, pausedUntil: s.pausedUntil > now ? s.pausedUntil : null, startsLastMinute: s.starts.filter((t) => t > now - MIN).length, ...(s.lastClass ? { lastClass: s.lastClass } : {}) };
  }

  /** Counts by state, and the oldest waiting age, for a dashboard and an alert. */
  stats(): { queued: number; sending: number; done: number; oldestQueuedMs: number; byDomain: Record<string, number> } {
    const now = this.o.now();
    let oldest = 0;
    const by: Record<string, number> = {};
    const c = { queued: 0, sending: 0, done: 0 };
    for (const d of this.deliveries.values()) {
      c[d.state]++;
      if (d.state === 'queued') {
        oldest = Math.max(oldest, now - d.enqueuedAt);
        by[d.domain] = (by[d.domain] ?? 0) + 1;
      }
    }
    return { ...c, oldestQueuedMs: oldest, byDomain: by };
  }
}

// ---------------------------------------------------------------- warm-up

/**
 * Daily send limits for a new IP: `start` on day 1, growing by `growth` each day (rounded to a friendly number),
 * ending at `target`. 50, 100, 200, ... for the default growth of 2.
 */
export function warmupSchedule(o: { start?: number; target: number; growth?: number }): number[] {
  const start = o.start ?? 50;
  const growth = o.growth ?? 2;
  if (start < 1 || o.target < start || growth <= 1) throw new QueueError('warm-up needs a start of at least 1, a target at least the start, and growth above 1');
  const out: number[] = [];
  let v = start;
  while (v < o.target) {
    out.push(Math.round(v));
    v = Math.max(v + 1, Math.round(v * growth));
  }
  out.push(o.target);
  return out;
}

export interface DayReport {
  readonly sent: number;
  readonly bounced: number;
  readonly complaints: number;
}

export type Advice = 'advance' | 'hold' | 'back-off';

/** Judges a day: advance when it was healthy and the limit was nearly used, hold when bounces rise, back off on a spike. */
export function judgeDay(limit: number, r: DayReport): Advice {
  if (r.sent === 0) return 'hold';
  const bounce = r.bounced / r.sent;
  const complaint = r.complaints / r.sent;
  if (bounce > 0.05 || complaint > 0.003) return 'back-off';
  if (bounce > 0.03 || complaint > 0.001) return 'hold';
  return r.sent >= limit * 0.8 ? 'advance' : 'hold';
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export class Warmup {
  private readonly schedule: readonly number[];
  private readonly ips = new Map<string, { level: number; day: string; sent: number; bounced: number; complaints: number }>();
  private readonly now: () => number;

  constructor(schedule: readonly number[], ips: readonly string[], now: () => number) {
    if (!schedule.length) throw new QueueError('a warm-up schedule needs at least one day');
    this.schedule = schedule;
    this.now = now;
    for (const ip of ips) this.ips.set(ip, { level: 0, day: day(now()), sent: 0, bounced: 0, complaints: 0 });
  }

  private roll(ip: string) {
    const s = this.ips.get(ip);
    if (!s) throw new QueueError(`${ip} is not in the warm-up`);
    const today = day(this.now());
    if (s.day !== today) {
      const a = judgeDay(this.schedule[s.level]!, s);
      // Days with no sending between do not count against the ramp.
      if (a === 'advance') s.level = Math.min(this.schedule.length - 1, s.level + 1);
      else if (a === 'back-off') s.level = Math.max(0, s.level - 1);
      Object.assign(s, { day: today, sent: 0, bounced: 0, complaints: 0 });
    }
    return s;
  }

  /** Today's limit for an IP, what it has sent, what is left, and whether it has finished warming up. */
  allowance(ip: string): { day: number; limit: number; used: number; remaining: number; warm: boolean } {
    const s = this.roll(ip);
    const limit = this.schedule[s.level]!;
    return { day: s.level + 1, limit, used: s.sent, remaining: Math.max(0, limit - s.sent), warm: s.level === this.schedule.length - 1 };
  }

  /** Takes `n` sends from an IP's day; refuses (false) when they do not fit. */
  take(ip: string, n = 1): boolean {
    const s = this.roll(ip);
    if (s.sent + n > this.schedule[s.level]!) return false;
    s.sent += n;
    return true;
  }

  /** The IP with the most room today, or undefined when every IP is used up: the rest waits for tomorrow. */
  pick(): string | undefined {
    let best: string | undefined;
    let room = 0;
    for (const ip of this.ips.keys()) {
      const a = this.allowance(ip);
      if (a.remaining > room) {
        room = a.remaining;
        best = ip;
      }
    }
    return best;
  }

  /** Counts a bounce or a complaint against today's judgement of an IP. */
  note(ip: string, what: 'bounce' | 'complaint'): void {
    const s = this.roll(ip);
    if (what === 'bounce') s.bounced++;
    else s.complaints++;
  }

  /** What tomorrow's judgement would be, from today's numbers so far. */
  advice(ip: string): Advice {
    const s = this.roll(ip);
    return judgeDay(this.schedule[s.level]!, s);
  }
}
