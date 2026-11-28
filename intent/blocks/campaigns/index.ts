/**
 * Broadcast campaigns: who gets a mail (a segment written as data), what they get (a template with escaped
 * placeholders and optional A/B variants), when and how fast it goes (a send time and a throttle with a bucket
 * that cannot bank an idle hour), and what came back (opens, clicks, bounces, per variant and overall).
 *
 * Safe by default: people who unsubscribed, bounced or complained are never mailed; addresses are checked and
 * de-duplicated; every template value is HTML-escaped and subjects cannot carry line breaks; a mail without an
 * unsubscribe link in its template is refused, and each message carries the List-Unsubscribe and one-click headers
 * of RFC 8058 and RFC 2369; the unsubscribe link must be https and is never turned into a tracked link; a
 * temporary failure is retried a few times with a growing wait and a permanent refusal is reported as a bounce;
 * two overlapping sends never send one message twice. An A/B test mails a share of the list first, waits, and
 * sends the rest the winning variant. Links and the open pixel come from the mail-tracking block.
 *
 * Out of scope: the SMTP delivery itself (an injected `send` function), storing campaigns between restarts (the
 * state is in memory and plain data), time-zone aware send windows, and significance testing of the winner (the
 * experiments block does that; here the better rate wins and a tie goes to the first variant).
 */
import { createHash } from 'node:crypto';
import { email as emailSchema } from '../validate/index.ts';
import type { Recorder, Tracker } from '../mail-tracking/index.ts';

export class CampaignError extends Error {}

/** What `send` throws: permanent means the address refused the mail for good (a bounce), else it is worth retrying. */
export class SendFailure extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

export type Value = string | number | boolean;

export interface Contact {
  readonly id: string;
  readonly email: string;
  readonly attrs?: Readonly<Record<string, Value>>;
  readonly tags?: readonly string[];
  readonly status?: 'subscribed' | 'unsubscribed' | 'bounced' | 'complained';
}

// ---------------------------------------------------------------- segments

export type Op = 'eq' | 'ne' | 'in' | 'contains' | 'startsWith' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
export type Segment =
  | { readonly everyone: true }
  | { readonly all: readonly Segment[] }
  | { readonly any: readonly Segment[] }
  | { readonly not: Segment }
  | { readonly tag: string }
  | { readonly field: string; readonly op: Op; readonly value?: Value | readonly Value[] };

const OPS = new Set<string>(['eq', 'ne', 'in', 'contains', 'startsWith', 'gt', 'gte', 'lt', 'lte', 'exists']);
const MAX_DEPTH = 8;
const MAX_NODES = 200;

function attr(c: Contact, field: string): Value | undefined {
  if (field === 'email') return c.email;
  if (field === 'id') return c.id;
  return c.attrs && Object.hasOwn(c.attrs, field) ? c.attrs[field] : undefined;
}

export function matches(seg: Segment, c: Contact): boolean {
  const budget = { nodes: 0 };
  return walk(seg, c, 0, budget);
}

function walk(s: unknown, c: Contact, depth: number, b: { nodes: number }): boolean {
  if (depth > MAX_DEPTH) throw new CampaignError('that segment is nested too deeply');
  if (++b.nodes > MAX_NODES) throw new CampaignError('that segment has too many parts');
  if (typeof s !== 'object' || s === null) throw new CampaignError('that is not a segment');
  const o = s as Record<string, unknown>;
  if (o['everyone'] === true) return true;
  if (Array.isArray(o['all'])) return o['all'].every((x) => walk(x, c, depth + 1, b));
  if (Array.isArray(o['any'])) return o['any'].some((x) => walk(x, c, depth + 1, b));
  if ('not' in o) return !walk(o['not'], c, depth + 1, b);
  if (typeof o['tag'] === 'string') return c.tags?.includes(o['tag']) ?? false;
  if (typeof o['field'] === 'string' && typeof o['op'] === 'string') {
    if (!OPS.has(o['op'])) throw new CampaignError(`"${o['op']}" is not a segment test`);
    const v = attr(c, o['field']);
    const want = o['value'];
    switch (o['op']) {
      case 'exists': return v !== undefined;
      case 'eq': return v !== undefined && v === want;
      case 'ne': return v === undefined || v !== want;
      case 'in': return v !== undefined && Array.isArray(want) && want.includes(v);
      case 'contains': return typeof v === 'string' && typeof want === 'string' && v.toLowerCase().includes(want.toLowerCase());
      case 'startsWith': return typeof v === 'string' && typeof want === 'string' && v.toLowerCase().startsWith(want.toLowerCase());
      default: {
        if (typeof v !== 'number' || typeof want !== 'number') return false;
        return o['op'] === 'gt' ? v > want : o['op'] === 'gte' ? v >= want : o['op'] === 'lt' ? v < want : v <= want;
      }
    }
  }
  throw new CampaignError('that is not a segment');
}

// ---------------------------------------------------------------- templates

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Fill {{name}} and {{name|fallback}}. Values are escaped for HTML when asked, and are never expanded a second time. */
export function render(template: string, vars: Readonly<Record<string, Value>>, o: { html?: boolean }): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|([^{}]*))?\}\}/g, (_m, name: string, fallback: string | undefined) => {
    const v = Object.hasOwn(vars, name) ? vars[name] : undefined;
    const text = v === undefined ? fallback : String(v);
    if (text === undefined) throw new CampaignError(`no value for "${name}"`);
    return o.html ? escapeHtml(text) : text;
  });
}

function textOf(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// ---------------------------------------------------------------- definitions

export interface Variant {
  readonly id: string;
  readonly subject?: string;
  readonly html?: string;
  readonly weight?: number;
}
export interface AbTest {
  /** The share of the list (1 to 50) that is mailed before a winner is chosen. */
  readonly testPercent: number;
  readonly metric: 'opens' | 'clicks';
  /** How long after the test mail is all out before the winner is chosen. */
  readonly waitMs: number;
  /** Each variant needs this many sent before the test can pick a winner (default 1). */
  readonly minPerVariant?: number;
}
export interface CampaignDef {
  readonly id: string;
  readonly name: string;
  readonly from: { readonly email: string; readonly name?: string };
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly segment: Segment;
  readonly sendAt: number;
  /** Messages per minute, 1 to 100000. */
  readonly perMinute: number;
  /** Most that go out in one burst (default 10). */
  readonly batch?: number;
  readonly maxAttempts?: number;
  readonly variants?: readonly Variant[];
  readonly ab?: AbTest;
}

export interface Message {
  readonly messageId: string;
  readonly campaign: string;
  readonly variant: string;
  readonly contact: string;
  readonly to: { readonly email: string; readonly name?: string };
  readonly from: { readonly email: string; readonly name?: string };
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}

type Status = 'queued' | 'held' | 'sent' | 'failed' | 'bounced' | 'skipped' | 'cancelled';
interface Item {
  readonly contact: Contact;
  variant: string;
  status: Status;
  sending: boolean;
  attempts: number;
  due: number;
  why?: string;
  finalAt?: number;
  test: boolean;
}
interface Entry {
  readonly def: CampaignDef;
  readonly variants: readonly Variant[];
  items: Item[];
  planned: boolean;
  paused: boolean;
  cancelled: boolean;
  tokens: number | null;
  refilled: number;
  winner?: { variant: string; reason: string };
}

export interface TickResult {
  sent: number;
  failed: number;
  bounced: number;
  skipped: number;
  retrying: number;
  waiting: number;
}

export interface Report {
  readonly state: 'scheduled' | 'sending' | 'waiting' | 'paused' | 'done' | 'cancelled';
  readonly counts: Record<Status, number>;
  readonly variants: Record<string, { sent: number; opens: number; proxyOpens: number; uniqueClicks: number; openRate: number | null; clickRate: number | null }>;
  readonly overall: { sent: number; opens: number; proxyOpens: number; bots: number; clicks: number; uniqueClicks: number; openRate: number | null; clickRate: number | null };
  readonly winner?: { variant: string; reason: string };
  readonly failed: { id: string; why: string }[];
  readonly skipped: { id: string; why: string }[];
}

const hash = (s: string) => createHash('sha256').update(s).digest();
const unit = (s: string) => hash(s).readUInt32BE(0) / 2 ** 32;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

export interface CampaignsOptions {
  readonly tracker: Tracker;
  readonly recorder: Recorder;
  readonly now: () => number;
  /** The domain of the Message-ID header. */
  readonly domain: string;
  /** The https address that unsubscribes this contact, one click, no sign-in. */
  readonly unsubscribeUrl: (c: Contact) => string;
  readonly send: (m: Message) => Promise<void>;
}

export class Campaigns {
  private readonly o: CampaignsOptions;
  private readonly all = new Map<string, Entry>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(o: CampaignsOptions) {
    this.o = o;
  }

  private entry(id: string): Entry {
    const e = this.all.get(id);
    if (!e) throw new CampaignError(`no campaign "${id}"`);
    return e;
  }

  create(def: CampaignDef): void {
    if (!ID.test(def.id)) throw new CampaignError('a campaign id is letters, digits, "_" and "-", up to 64');
    if (this.all.has(def.id)) throw new CampaignError(`campaign "${def.id}" already exists`);
    if (!emailSchema().check(def.from.email, 'from').ok) throw new CampaignError('the sender is not a valid email address');
    if (!def.subject.trim()) throw new CampaignError('a campaign needs a subject');
    if (!Number.isInteger(def.perMinute) || def.perMinute < 1 || def.perMinute > 100_000) throw new CampaignError('perMinute must be a whole number from 1 to 100000');
    const unsub = /\{\{\s*unsubscribe_url\s*(?:\|[^{}]*)?\}\}/;
    const variants = def.variants && def.variants.length ? def.variants : [{ id: 'main' }];
    if (def.variants) {
      if (def.variants.length < 2 || def.variants.length > 5) throw new CampaignError('use two to five variants, or none');
      const seen = new Set<string>();
      for (const v of def.variants) {
        if (!ID.test(v.id)) throw new CampaignError('a variant id is letters, digits, "_" and "-"');
        if (seen.has(v.id)) throw new CampaignError(`variant "${v.id}" is listed twice`);
        seen.add(v.id);
        if (v.weight !== undefined && !(v.weight > 0)) throw new CampaignError('a variant weight must be above zero');
      }
    }
    for (const v of variants) if (!unsub.test((v as Variant).html ?? def.html)) throw new CampaignError('the html must contain {{unsubscribe_url}}');
    if (def.ab) {
      if (!def.variants) throw new CampaignError('an A/B test needs variants');
      if (!(def.ab.testPercent >= 1 && def.ab.testPercent <= 50)) throw new CampaignError('testPercent must be from 1 to 50');
    }
    this.all.set(def.id, { def, variants, items: [], planned: false, paused: false, cancelled: false, tokens: null, refilled: 0 });
  }

  /** Choose who is mailed. Everyone who must not be mailed is left out, and the reasons are returned. */
  plan(id: string, contacts: readonly Contact[]): { planned: number; notInSegment: number; excluded: { id: string; why: string }[] } {
    const e = this.entry(id);
    if (e.planned) throw new CampaignError(`campaign "${id}" is already planned`);
    e.planned = true;
    const excluded: { id: string; why: string }[] = [];
    const ids = new Set<string>();
    const addrs = new Set<string>();
    let notIn = 0;
    const chosen: Contact[] = [];
    for (const c of contacts) {
      if (!matches(e.def.segment, c)) {
        notIn++;
        continue;
      }
      const no = (why: string) => void excluded.push({ id: c.id, why });
      if (c.status && c.status !== 'subscribed') no(c.status);
      else if (!emailSchema().check(c.email, 'email').ok) no('not a valid email address');
      else if (ids.has(c.id)) no('same contact id as an earlier contact');
      else if (addrs.has(c.email.toLowerCase())) no('same address as an earlier contact');
      else {
        ids.add(c.id);
        addrs.add(c.email.toLowerCase());
        chosen.push(c);
      }
    }
    const order = [...chosen].sort((a, b) => hash(`${id}:order:${a.id}`).compare(hash(`${id}:order:${b.id}`)));
    const testCount = e.def.ab ? Math.max(e.variants.length, Math.round((chosen.length * e.def.ab.testPercent) / 100)) : 0;
    const testIds = new Map(order.slice(0, testCount).map((c, i) => [c.id, e.variants[i % e.variants.length]!.id]));
    const total = e.variants.reduce((a, v) => a + (v.weight ?? 1), 0);
    const byWeight = (c: Contact) => {
      let x = unit(`${id}:variant:${c.id}`) * total;
      for (const v of e.variants) {
        x -= v.weight ?? 1;
        if (x < 0) return v.id;
      }
      return e.variants[e.variants.length - 1]!.id;
    };
    e.items = chosen.map((c) => {
      const t = testIds.get(c.id);
      const held = e.def.ab !== undefined && t === undefined;
      return { contact: c, variant: t ?? (held ? '' : byWeight(c)), status: held ? 'held' : 'queued', sending: false, attempts: 0, due: e.def.sendAt, test: t !== undefined };
    });
    return { planned: chosen.length, notInSegment: notIn, excluded };
  }

  pause(id: string): void {
    this.entry(id).paused = true;
  }
  resume(id: string): void {
    const e = this.entry(id);
    if (e.cancelled) throw new CampaignError(`campaign "${id}" was cancelled`);
    e.paused = false;
  }
  cancel(id: string): void {
    const e = this.entry(id);
    e.cancelled = true;
    for (const i of e.items) if ((i.status === 'queued' || i.status === 'held') && !i.sending) i.status = 'cancelled';
  }

  /** Send what is due, within the throttle. Calls are queued one behind another, so none overlaps. */
  tick(): Promise<TickResult> {
    const run = this.chain.then(() => this.runTick());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runTick(): Promise<TickResult> {
    const res: TickResult = { sent: 0, failed: 0, bounced: 0, skipped: 0, retrying: 0, waiting: 0 };
    const now = this.o.now();
    for (const e of this.all.values()) {
      if (e.paused || e.cancelled || !e.planned) continue;
      res.waiting += e.items.filter((i) => i.status === 'held' || (i.status === 'queued' && i.due > now)).length;
      this.decide(e, now);
      await this.dispatch(e, now, res);
    }
    return res;
  }

  private decide(e: Entry, now: number): void {
    const ab = e.def.ab;
    if (!ab || e.winner) return;
    const tests = e.items.filter((i) => i.test);
    if (!tests.length || !tests.every((i) => i.finalAt !== undefined)) return;
    const done = Math.max(...tests.map((i) => i.finalAt!));
    if (now < done + ab.waitMs) return;
    const min = ab.minPerVariant ?? 1;
    const rows = e.variants.map((v) => {
      const sent = e.items.filter((i) => i.variant === v.id && i.status === 'sent').length;
      const s = this.o.recorder.stats(`${e.def.id}/${v.id}`, sent);
      const num = ab.metric === 'opens' ? s.opens : s.uniqueClicks;
      return { id: v.id, sent, rate: sent ? num / sent : 0 };
    });
    let win: { variant: string; reason: string };
    if (rows.some((r) => r.sent < min)) win = { variant: e.variants[0]!.id, reason: `fewer than ${min} sent to a variant, not enough to choose between them, so the first is used` };
    else {
      const best = rows.reduce((a, r) => (r.rate > a.rate ? r : a));
      const rest = rows.filter((r) => r !== best);
      const second = Math.max(...rest.map((r) => r.rate));
      win = best.rate === second ? { variant: e.variants[0]!.id, reason: 'no difference between the variants, so the first is used' } : { variant: best.id, reason: `${best.id} had the higher ${ab.metric === 'opens' ? 'open' : 'click'} rate (${pct(best.rate)} against ${pct(second)})` };
    }
    e.winner = win;
    for (const i of e.items) if (i.status === 'held') Object.assign(i, { status: 'queued', variant: win.variant, due: Math.max(now, e.def.sendAt) });
  }

  private async dispatch(e: Entry, now: number, res: TickResult): Promise<void> {
    const rate = e.def.perMinute;
    const cap = e.def.batch ?? 10;
    e.tokens = e.tokens === null ? cap : Math.min(cap, e.tokens + ((now - e.refilled) * rate) / 60_000);
    e.refilled = now;
    for (const item of e.items) {
      if (item.status !== 'queued' || item.sending || item.due > now) continue;
      if (e.tokens < 1) break;
      const variant = e.variants.find((v) => v.id === item.variant) ?? e.variants[0]!;
      let msg: Message;
      try {
        msg = this.compose(e, variant, item.contact);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const bad = /^no value for/.test(why);
        Object.assign(item, { status: bad ? 'skipped' : 'failed', why, finalAt: now });
        bad ? res.skipped++ : res.failed++;
        continue;
      }
      e.tokens -= 1;
      item.sending = true;
      item.attempts++;
      try {
        await this.o.send(msg);
        Object.assign(item, { status: 'sent', finalAt: now });
        res.sent++;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        const permanent = err instanceof SendFailure && err.permanent;
        if (permanent) {
          Object.assign(item, { status: 'bounced', why, finalAt: now });
          res.bounced++;
        } else if (item.attempts >= (e.def.maxAttempts ?? 3)) {
          Object.assign(item, { status: 'failed', why, finalAt: now });
          res.failed++;
        } else {
          item.due = now + Math.min(3_600_000, 60_000 * 2 ** (item.attempts - 1));
          item.why = why;
          res.retrying++;
        }
      } finally {
        item.sending = false;
      }
    }
  }

  private compose(e: Entry, v: Variant, c: Contact): Message {
    const d = e.def;
    const unsub = this.o.unsubscribeUrl(c);
    if (!/^https:\/\//i.test(unsub) || /[\s<>"]/.test(unsub)) throw new CampaignError('the unsubscribe link must be https');
    const vars: Record<string, Value> = {};
    for (const [k, val] of Object.entries(c.attrs ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) vars[k] = val;
    vars['email'] = c.email;
    vars['id'] = c.id;
    vars['unsubscribe_url'] = unsub;
    const subject = render(v.subject ?? d.subject, vars, {}).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    let html = render(v.html ?? d.html, vars, { html: true });
    const href = `href="${escapeHtml(unsub)}"`;
    html = html.split(`<a href="${escapeHtml(unsub)}"`).join(`<a data-track="off" ${href}`);
    const text = d.text !== undefined ? render(d.text, vars, {}) : textOf(html);
    const messageId = `<${hash(`${d.id}:${c.id}`).toString('hex').slice(0, 24)}@${this.o.domain}>`;
    const tracked = this.o.tracker.rewriteHtml(html, { campaign: `${d.id}/${v.id}`, recipient: c.id }).html;
    const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return {
      messageId,
      campaign: d.id,
      variant: v.id,
      contact: c.id,
      to: { email: c.email },
      from: { email: d.from.email, ...(d.from.name !== undefined ? { name: clean(d.from.name) } : {}) },
      subject,
      html: tracked,
      text,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', Precedence: 'bulk' },
    };
  }

  bounces(id: string): { id: string; email: string; why: string }[] {
    return this.entry(id).items.filter((i) => i.status === 'bounced').map((i) => ({ id: i.contact.id, email: i.contact.email, why: i.why ?? '' }));
  }

  report(id: string): Report {
    const e = this.entry(id);
    const counts: Record<Status, number> = { queued: 0, held: 0, sent: 0, failed: 0, bounced: 0, skipped: 0, cancelled: 0 };
    for (const i of e.items) counts[i.status]++;
    const variants: Report['variants'] = {};
    const sum = { sent: 0, opens: 0, proxyOpens: 0, bots: 0, clicks: 0, uniqueClicks: 0 };
    for (const v of e.variants) {
      const sent = e.items.filter((i) => i.variant === v.id && i.status === 'sent').length;
      const s = this.o.recorder.stats(`${e.def.id}/${v.id}`, sent);
      variants[v.id] = { sent, opens: s.opens, proxyOpens: s.proxyOpens, uniqueClicks: s.uniqueClicks, openRate: s.openRate, clickRate: s.clickRate };
      sum.sent += sent;
      sum.opens += s.opens;
      sum.proxyOpens += s.proxyOpens;
      sum.bots += s.bots;
      sum.clicks += s.clicks;
      sum.uniqueClicks += s.uniqueClicks;
    }
    const final = (s: Status) => s === 'sent' || s === 'failed' || s === 'bounced' || s === 'skipped' || s === 'cancelled';
    let state: Report['state'];
    if (e.cancelled) state = 'cancelled';
    else if (e.paused) state = 'paused';
    else if (e.items.every((i) => final(i.status))) state = 'done';
    else if (e.def.ab && !e.winner && counts.held > 0 && e.items.filter((i) => i.test).every((i) => final(i.status))) state = 'waiting';
    else state = counts.sent > 0 || counts.failed > 0 ? 'sending' : 'scheduled';
    return {
      state,
      counts,
      variants,
      overall: { ...sum, openRate: sum.sent ? sum.opens / sum.sent : null, clickRate: sum.sent ? sum.uniqueClicks / sum.sent : null },
      ...(e.winner ? { winner: e.winner } : {}),
      failed: e.items.filter((i) => i.status === 'failed').map((i) => ({ id: i.contact.id, why: i.why ?? '' })),
      skipped: e.items.filter((i) => i.status === 'skipped').map((i) => ({ id: i.contact.id, why: i.why ?? '' })),
    };
  }
}
