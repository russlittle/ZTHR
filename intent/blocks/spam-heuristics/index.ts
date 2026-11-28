/**
 * Scoring of what strangers submit (comments, sign-ups, contact forms) without a service and without secrets: every
 * rule adds or removes points with a plain reason, the points are summed, and the total picks one of three
 * outcomes: accept, hold for a person to review, or reject as spam. Because every point has a reason, a refusal can
 * be explained to the person who wrote to support, and a rule that is wrong can be found and weakened.
 *
 * Rules shipped: honeypot fields that a person never sees (decisive: nothing can outweigh them), a form filled in
 * faster than a person can read it (or from a stale or missing form), link density (count, share of the words,
 * address shorteners, raw IP addresses, user names inside addresses, look-alike punycode), weighted words matched
 * as whole words with accents folded, hidden characters and words that mix Latin with Cyrillic or Greek letters,
 * shouting and repeated characters, email addresses from throw-away domains or that look random, a missing or
 * script-like user agent, velocity per address, per network (/24 or /64) and per account using the token buckets of
 * the ratelimit block (a burst costs points, it does not block), the same text sent by different people, text
 * already marked as spam, and reputation: earlier outcomes for an account, address, network or email domain,
 * halving in weight over a half-life, so a long-standing member is trusted and a spammer's address is remembered
 * for a while and then forgiven. Custom rules can be added; thresholds and weights are configuration.
 *
 * Out of scope: machine learning, network lookups (blocklists, MX checks), and CAPTCHAs; the caller can supply
 * those as custom rules that return hits.
 */
import { createHash } from 'node:crypto';
import { Limited, Limiter } from '../ratelimit/index.ts';
import type { Bucket } from '../ratelimit/index.ts';

export class SpamConfigError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface Submission {
  readonly kind?: 'comment' | 'signup' | 'form';
  readonly ip?: string;
  readonly userId?: string;
  readonly email?: string;
  readonly name?: string;
  readonly content: string;
  /** Every field of the form as sent, including hidden honeypots. */
  readonly fields?: Readonly<Record<string, string>>;
  /** When the form was shown and when it came back, in milliseconds. */
  readonly renderedAt?: number;
  readonly submittedAt?: number;
  readonly userAgent?: string;
  /** Whether the person is signed in to an account with some history. */
  readonly signedIn?: boolean;
}

export interface Hit {
  readonly rule: string;
  readonly points: number;
  readonly detail: string;
  /** A hit that cannot be outweighed by good reputation or anything else. */
  readonly decisive?: boolean;
}

export type Verdict = 'accept' | 'review' | 'reject';

export interface Result {
  readonly score: number;
  readonly verdict: Verdict;
  readonly hits: readonly Hit[];
  readonly decisive: boolean;
}

export interface Context {
  readonly now: number;
  readonly config: Required<Pick<Config, 'minFillMs' | 'maxFormAgeMs' | 'maxLinks' | 'maxLinkShare' | 'duplicateWindowMs'>> & Config;
  readonly dryRun: boolean;
  /** Takes a velocity token for a key; returns the wait in ms when refused. */
  readonly spend: (limiter: string, key: string) => number | undefined;
  readonly seen: (hash: string, who: string) => string[];
  readonly reputation: Reputation;
}

export interface Rule {
  readonly id: string;
  check(s: Submission, ctx: Context): Hit | readonly Hit[] | undefined;
}

export interface Config {
  readonly honeypots?: readonly string[];
  /** Faster than this and a person did not read the form. Default 3000. */
  readonly minFillMs?: number;
  /** A form older than this is stale. Default 24 hours. */
  readonly maxFormAgeMs?: number;
  /** More links than this cost points. Default 2. */
  readonly maxLinks?: number;
  /** Links as a share of the words above this cost points. Default 0.15. */
  readonly maxLinkShare?: number;
  readonly shorteners?: readonly string[];
  readonly disposableDomains?: readonly string[];
  /** Words and the points each adds the first time it appears. */
  readonly words?: Readonly<Record<string, number>>;
  readonly thresholds?: { readonly review: number; readonly reject: number };
  readonly velocity?: { readonly ip?: Bucket; readonly network?: Bucket; readonly user?: Bucket };
  /** How long the same text from different people counts as copying. Default 1 hour. */
  readonly duplicateWindowMs?: number;
  readonly reputationHalfLifeMs?: number;
  readonly rules?: readonly Rule[];
  /** Replace the shipped rules instead of adding to them. */
  readonly onlyCustomRules?: boolean;
  readonly now?: () => number;
}

const DEFAULT_SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'tiny.cc'];
const DEFAULT_DISPOSABLE = ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com', 'throwawaymail.com', 'maildrop.cc'];
const MAX_SCAN = 20_000;

// ================================================================== text tools

const strip = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿­]/g;

/** The web addresses in a text, however written: bare, in an anchor, in Markdown, or starting "www.". */
export function extractLinks(text: string): { raw: string; host: string; userinfo: boolean; ipHost: boolean; punycode: boolean }[] {
  const found: string[] = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"'\])}]+/gi;
  for (const m of text.slice(0, MAX_SCAN).matchAll(re)) found.push(m[0].replace(/[.,;:!?]+$/, ''));
  const out: { raw: string; host: string; userinfo: boolean; ipHost: boolean; punycode: boolean }[] = [];
  for (const raw of found) {
    try {
      const u = new URL(/^www\./i.test(raw) ? `http://${raw}` : raw);
      const host = u.hostname.toLowerCase();
      out.push({ raw, host, userinfo: u.username !== '' || u.password !== '', ipHost: /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('['), punycode: host.split('.').some((l) => l.startsWith('xn--')) });
    } catch {
      out.push({ raw, host: '', userinfo: false, ipHost: false, punycode: false });
    }
  }
  return out;
}

const SCRIPTS = ['Latin', 'Cyrillic', 'Greek'] as const;
const scriptRe = { Latin: /\p{Script=Latin}/u, Cyrillic: /\p{Script=Cyrillic}/u, Greek: /\p{Script=Greek}/u };

/** Words that mix Latin letters with Cyrillic or Greek, as in a "pаypal" whose "а" is Cyrillic. */
export function mixedScriptWords(text: string): string[] {
  const out: string[] = [];
  for (const w of text.slice(0, MAX_SCAN).split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3) continue;
    const present = SCRIPTS.filter((s) => scriptRe[s].test(w));
    if (present.length > 1) out.push(w);
  }
  return out;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0;
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const v of n.values()) h -= (v / s.length) * Math.log2(v / s.length);
  return h;
}

/** The network an address belongs to for velocity: the /24 of an IPv4, the /64 of an IPv6. */
export function networkOf(ip: string): string | undefined {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4.slice(1).every((x) => Number(x) <= 255) ? `${v4[1]}.${v4[2]}.${v4[3]}.0/24` : undefined;
  if (!ip.includes(':') || !/^[0-9a-f:.]+$/i.test(ip) || ip.split('::').length > 2) return undefined;
  const [head = '', tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b] : a;
  if (full.length !== 8 || full.some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return undefined;
  return `${full.slice(0, 4).map((x) => x.toLowerCase().padStart(4, '0')).join(':')}::/64`;
}

const hashOf = (text: string) => createHash('sha256').update(strip(text.replace(HIDDEN, '')).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).digest('hex').slice(0, 24);

// ================================================================== reputation

export type Outcome = 'ham' | 'spam';

/** What is remembered about accounts, addresses, networks and email domains, fading with a half-life. */
export class Reputation {
  private readonly rows = new Map<string, { ham: number; spam: number; at: number }>();
  private readonly halfLife: number;

  constructor(halfLifeMs = 14 * 86_400_000) {
    if (!(halfLifeMs > 0)) throw new SpamConfigError('a half-life must be more than zero');
    this.halfLife = halfLifeMs;
  }

  private decayed(key: string, now: number): { ham: number; spam: number } {
    const r = this.rows.get(key);
    if (!r) return { ham: 0, spam: 0 };
    const f = 0.5 ** (Math.max(0, now - r.at) / this.halfLife);
    return { ham: r.ham * f, spam: r.spam * f };
  }

  record(keys: readonly string[], outcome: Outcome, now: number): void {
    for (const k of keys) {
      const d = this.decayed(k, now);
      this.rows.set(k, { ham: d.ham + (outcome === 'ham' ? 1 : 0), spam: d.spam + (outcome === 'spam' ? 1 : 0), at: now });
    }
    if (this.rows.size > 100_000) this.prune(now);
  }

  /** Points for one identity: positive for a history of spam, negative for a clean record. */
  points(key: string, now: number): number {
    const d = this.decayed(key, now);
    return Math.max(-30, Math.min(60, d.spam * 25 - Math.min(d.ham, 10) * 3));
  }

  /** Forgets identities whose record has faded to nothing. */
  prune(now: number): number {
    let n = 0;
    for (const k of [...this.rows.keys()]) {
      const d = this.decayed(k, now);
      if (d.ham + d.spam < 0.05) (this.rows.delete(k), n++);
    }
    return n;
  }

  get size() {
    return this.rows.size;
  }
}

/** The identities a submission is known by, strongest first. */
export function identities(s: Submission): string[] {
  const out: string[] = [];
  if (s.userId) out.push(`user:${s.userId}`);
  if (s.ip) out.push(`ip:${s.ip}`);
  const net = s.ip ? networkOf(s.ip) : undefined;
  if (net) out.push(`net:${net}`);
  const dom = s.email?.split('@')[1]?.toLowerCase();
  if (dom) out.push(`domain:${dom}`);
  return out;
}

// ================================================================== shipped rules

const hit = (rule: string, points: number, detail: string, decisive = false): Hit => ({ rule, points, detail, ...(decisive ? { decisive: true } : {}) });

function shippedRules(): Rule[] {
  return [
    {
      id: 'honeypot',
      check: (s, c) => {
        const filled = (c.config.honeypots ?? []).filter((f) => (s.fields?.[f] ?? '').trim() !== '');
        return filled.length ? hit('honeypot', 100, `the hidden field${filled.length > 1 ? 's' : ''} ${filled.map((f) => `"${f}"`).join(', ')} ${filled.length > 1 ? 'were' : 'was'} filled in`, true) : undefined;
      },
    },
    {
      id: 'fill-time',
      check: (s, c) => {
        if (s.renderedAt === undefined || s.submittedAt === undefined) return s.kind === 'form' || s.kind === 'signup' || s.kind === 'comment' ? hit('fill-time', 10, 'there is no record of when the form was shown') : undefined;
        const took = s.submittedAt - s.renderedAt;
        if (took < 0) return hit('fill-time', 25, 'the form came back before it was shown');
        if (took < c.config.minFillMs) return hit('fill-time', took < c.config.minFillMs / 3 ? 45 : 30, `the form came back after ${took} ms; a person needs at least ${c.config.minFillMs} ms`);
        if (took > c.config.maxFormAgeMs) return hit('fill-time', 10, 'the form is more than a day old');
        return undefined;
      },
    },
    {
      id: 'links',
      check: (s, c) => {
        const out: Hit[] = [];
        const links = extractLinks(s.content);
        const words = Math.max(1, s.content.slice(0, MAX_SCAN).split(/\s+/).filter(Boolean).length);
        if (links.length > c.config.maxLinks) out.push(hit('links', Math.min(40, (links.length - c.config.maxLinks) * 8), `${links.length} links; more than ${c.config.maxLinks} is a lot`));
        if (links.length >= 2 && links.length / words > c.config.maxLinkShare) out.push(hit('link-share', 15, `${Math.round((links.length / words) * 100)}% of the words are links`));
        const shorteners = new Set((c.config.shorteners ?? DEFAULT_SHORTENERS).map((x) => x.toLowerCase()));
        for (const l of links) {
          if (shorteners.has(l.host)) out.push(hit('link-shortener', 15, `${l.host} hides where a link goes`));
          if (l.ipHost) out.push(hit('link-ip', 20, 'a link to a bare IP address'));
          if (l.userinfo) out.push(hit('link-userinfo', 25, 'a link with a name in front of the address, a way to imitate another site'));
          if (l.punycode) out.push(hit('link-punycode', 15, `${l.host} is written with look-alike letters`));
        }
        const bare = s.content.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '').replace(/[\s\p{P}]+/gu, '');
        if (links.length && bare.length < 4) out.push(hit('link-only', 25, 'it is nothing but a link'));
        return out.length ? out : undefined;
      },
    },
    {
      id: 'words',
      check: (s, c) => {
        const out: Hit[] = [];
        const text = ` ${strip(s.content.replace(HIDDEN, '').slice(0, MAX_SCAN)).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
        for (const [w, pts] of Object.entries(c.config.words ?? {})) {
          const key = ` ${strip(w).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
          if (key.trim() && text.includes(key)) out.push(hit('word', pts, `contains "${w}"`));
        }
        return out.length ? out : undefined;
      },
    },
    {
      id: 'text-shape',
      check: (s) => {
        const out: Hit[] = [];
        const t = s.content.slice(0, MAX_SCAN);
        const hidden = (t.match(HIDDEN) ?? []).length;
        if (hidden >= 2) out.push(hit('hidden-characters', 20, `${hidden} invisible characters`));
        const mixed = mixedScriptWords(t);
        if (mixed.length) out.push(hit('mixed-scripts', 25, `${mixed.slice(0, 3).map((w) => `"${w}"`).join(', ')} mixes alphabets`));
        const letters = [...t].filter((ch) => /\p{L}/u.test(ch));
        const upper = letters.filter((ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase()).length;
        if (letters.length >= 20 && upper / letters.length > 0.7) out.push(hit('shouting', 10, 'almost all capital letters'));
        if (/(.)\1{9,}/su.test(t)) out.push(hit('repetition', 10, 'a character repeated ten times or more'));
        if (s.content.length > MAX_SCAN) out.push(hit('oversized', 15, `${s.content.length} characters; only the first ${MAX_SCAN} were read`));
        if (!s.content.trim()) out.push(hit('empty', 10, 'there is no text'));
        return out.length ? out : undefined;
      },
    },
    {
      id: 'email',
      check: (s, c) => {
        if (s.email === undefined) return undefined;
        const m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(s.email.trim());
        if (!m) return hit('email', 20, 'the email address is not an address');
        const out: Hit[] = [];
        const dom = m[2]!.toLowerCase();
        if (new Set((c.config.disposableDomains ?? DEFAULT_DISPOSABLE).map((d) => d.toLowerCase())).has(dom)) out.push(hit('email-disposable', 30, `${dom} gives out throw-away addresses`));
        const local = m[1]!.split('+')[0]!.toLowerCase();
        if (local.length >= 10 && entropy(local) > 3.4 && /\d/.test(local) && /[a-z]/.test(local)) out.push(hit('email-random', 15, 'the name before @ looks randomly made'));
        if (s.name && /https?:\/\/|www\./i.test(s.name)) out.push(hit('name-link', 25, 'the name is a web address'));
        return out.length ? out : undefined;
      },
    },
    {
      id: 'user-agent',
      check: (s) => {
        if (s.userAgent === undefined) return undefined;
        if (!s.userAgent.trim()) return hit('user-agent', 15, 'the browser did not say what it is');
        if (/\b(?:curl|wget|python-requests|python-urllib|go-http-client|libwww|java\/|okhttp|scrapy|httpclient|php\/)/i.test(s.userAgent)) return hit('user-agent', 20, 'the sender is a script, not a browser');
        return undefined;
      },
    },
    {
      id: 'velocity',
      check: (s, c) => {
        const out: Hit[] = [];
        const ask = (limiter: string, key: string | undefined, what: string, pts: number) => {
          if (!key) return;
          const wait = c.spend(limiter, key);
          if (wait !== undefined) out.push(hit('velocity', pts, `${what} is sending faster than usual (wait ${Math.ceil(wait / 1000)} s)`));
        };
        ask('user', s.userId, 'this account', 30);
        ask('ip', s.ip, 'this address', 25);
        ask('network', s.ip ? networkOf(s.ip) : undefined, 'this network', 20);
        return out.length ? out : undefined;
      },
    },
    {
      id: 'duplicate',
      check: (s, c) => {
        if (s.content.trim().length < 20) return undefined;
        const h = hashOf(s.content);
        const who = s.userId ?? s.ip ?? s.email ?? 'anonymous';
        const known = c.seen(h, who);
        const out: Hit[] = [];
        const others = known.filter((k) => k !== who);
        if (others.length) out.push(hit('duplicate', Math.min(60, 25 + 10 * others.length), `the same text came from ${others.length} other sender${others.length > 1 ? 's' : ''}`));
        else if (known.includes(who)) out.push(hit('duplicate-self', 15, 'the same text was sent before by this sender'));
        return out.length ? out : undefined;
      },
    },
    {
      id: 'reputation',
      check: (s, c) => {
        const ids = identities(s);
        let total = 0;
        const parts: string[] = [];
        for (const k of ids) {
          const p = c.reputation.points(k, c.now);
          if (Math.abs(p) >= 1) (total += p, parts.push(`${k} ${p > 0 ? '+' : ''}${Math.round(p)}`));
        }
        total = Math.max(-30, Math.min(60, total));
        if (s.signedIn && total > -10) return undefined;
        return Math.abs(total) >= 1 ? hit('reputation', Math.round(total), `earlier submissions: ${parts.join(', ')}`) : undefined;
      },
    },
  ];
}

// ================================================================== the analyzer

export class SpamScorer {
  private readonly cfg: Context['config'];
  private readonly rules: Rule[];
  private readonly limiters = new Map<string, Limiter>();
  private readonly texts = new Map<string, { who: string; at: number }[]>();
  private readonly spamTexts = new Set<string>();
  readonly reputation: Reputation;
  private readonly clock: () => number;

  constructor(c: Config = {}) {
    const t = c.thresholds ?? { review: 30, reject: 70 };
    if (!(t.review > 0) || !(t.reject > t.review)) throw new SpamConfigError('the review threshold must be above zero and the reject threshold above it');
    this.cfg = { ...c, minFillMs: c.minFillMs ?? 3000, maxFormAgeMs: c.maxFormAgeMs ?? 86_400_000, maxLinks: c.maxLinks ?? 2, maxLinkShare: c.maxLinkShare ?? 0.15, duplicateWindowMs: c.duplicateWindowMs ?? 3_600_000, thresholds: t };
    const ids = new Set<string>();
    this.rules = [...(c.onlyCustomRules ? [] : shippedRules()), ...(c.rules ?? [])];
    for (const r of this.rules) {
      if (ids.has(r.id)) throw new SpamConfigError(`rule ${r.id} is listed twice`);
      ids.add(r.id);
    }
    this.clock = c.now ?? (() => Date.now());
    this.reputation = new Reputation(c.reputationHalfLifeMs);
    const v = c.velocity ?? { ip: { burst: 5, perSecond: 1 / 20 }, network: { burst: 15, perSecond: 1 / 10 }, user: { burst: 5, perSecond: 1 / 30 } };
    for (const [name, b] of Object.entries(v)) if (b) this.limiters.set(name, new Limiter(b, { now: this.clock, what: name }));
  }

  /**
   * Scores a submission. Unless `dryRun`, it also counts toward velocity and is remembered for duplicate checks.
   * Reputation is only changed by `feedback`, once a person or a rule has decided what the submission was.
   */
  score(s: Submission, o: { dryRun?: boolean } = {}): Result {
    const now = this.clock();
    const dry = o.dryRun === true;
    const ctx: Context = {
      now,
      config: this.cfg,
      dryRun: dry,
      reputation: this.reputation,
      spend: (name, key) => {
        const l = this.limiters.get(name);
        if (!l) return undefined;
        if (dry) return l.left(key) < 1 ? 1000 : undefined;
        try {
          l.take(key);
          return undefined;
        } catch (e) {
          return e instanceof Limited ? e.retryAfterMs : 1000;
        }
      },
      seen: (hash, who) => {
        const list = (this.texts.get(hash) ?? []).filter((x) => now - x.at <= this.cfg.duplicateWindowMs);
        const names = [...new Set(list.map((x) => x.who))];
        if (!dry) {
          list.push({ who, at: now });
          this.texts.set(hash, list.slice(-50));
          if (this.texts.size > 20_000) for (const k of [...this.texts.keys()].slice(0, 5000)) this.texts.delete(k);
        }
        return names;
      },
    };
    const hits: Hit[] = [];
    for (const r of this.rules) {
      let got: Hit | readonly Hit[] | undefined;
      try {
        got = r.check(s, ctx);
      } catch (e) {
        got = hit(`${r.id}-error`, 0, `the rule failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (got) hits.push(...(Array.isArray(got) ? (got as readonly Hit[]) : [got as Hit]));
    }
    if (this.spamTexts.has(hashOf(s.content)) && s.content.trim().length >= 20) hits.push(hit('known-spam', 80, 'this text was marked as spam before'));
    const decisive = hits.some((h) => h.decisive);
    const raw = hits.reduce((n, h) => n + h.points, 0);
    const score = decisive ? Math.max(raw, this.cfg.thresholds!.reject) : Math.max(0, raw);
    const t = this.cfg.thresholds!;
    const verdict: Verdict = score >= t.reject ? 'reject' : score >= t.review ? 'review' : 'accept';
    return { score, verdict, hits: [...hits].sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.rule.localeCompare(b.rule)), decisive };
  }

  /** Teaches the scorer what a submission really was: its sender's reputation changes and spam text is remembered. */
  feedback(s: Submission, outcome: Outcome): void {
    this.reputation.record(identities(s), outcome, this.clock());
    const h = hashOf(s.content);
    if (s.content.trim().length >= 20) {
      if (outcome === 'spam') this.spamTexts.add(h);
      else this.spamTexts.delete(h);
    }
  }
}

/** The result as a sentence a person can read: the outcome, then each reason with its points. */
export function explain(r: Result): string {
  const head = r.verdict === 'accept' ? 'Accepted' : r.verdict === 'review' ? 'Held for review' : 'Rejected as spam';
  if (!r.hits.length) return `${head} (score ${r.score}): nothing looked wrong.`;
  return `${head} (score ${r.score}): ${r.hits.filter((h) => h.points !== 0).map((h) => `${h.detail} (${h.points > 0 ? '+' : ''}${h.points}, ${h.rule})`).join('; ')}.`;
}
