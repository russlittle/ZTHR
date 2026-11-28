/**
 * Multi-step outreach sequences: a list of steps (email, task, call) with wait rules between them, that sends only
 * inside a sending window, and stops the moment the person replies, unsubscribes or bounces. The engine decides what
 * is due and hands back messages and tasks; it never sends anything itself and never reads a clock.
 *
 *  - Steps: `email` (subject and body with {{field}} / {{field|fallback}} merge fields), `task` (a to-do for a person)
 *    and `call` (a script). A step may carry a condition on the previous email: opened, not opened, clicked.
 *  - Wait rules before a step: a fixed delay, a number of business days (the window's days, Monday to Friday if none),
 *    or "until they open or click the last email, but no longer than N", after which it goes on anyway.
 *  - Windows: allowed days of the week and hours in the recipient's own UTC offset. Email and calls are held to the
 *    next opening; tasks are not. A per-sequence daily cap on emails pushes the rest to the next open day.
 *  - Stops: a reply (auto-replies and out-of-office notices do not count), an unsubscribe, a hard bounce. An
 *    unsubscribe or hard bounce suppresses the address for every sequence, forever; enrolling a suppressed address
 *    is refused. A contact is in a sequence once at a time.
 *  - Merge safety: a step whose merge field is missing (no fallback) is not sent with a hole in it; the enrolment is
 *    paused with the reason. Fields containing line breaks are refused in subjects (header injection). Every email
 *    carries an unsubscribe line and RFC 8058 List-Unsubscribe headers.
 *  - A small `Outbox` (the part of a mail queue this needs): idempotent by key, claimed in batches, retried with
 *    backoff, dead after five tries, so a retry after a crash never sends twice.
 *
 * Out of scope: transport (SMTP/API), open and click tracking pixels (events are fed in by the caller), A/B variants,
 * and time zones with daylight saving (the window uses a fixed UTC offset per contact; give the current offset).
 */

export class SequenceError extends Error {
  constructor(why: string) {
    super(why);
  }
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type Wait =
  | { readonly kind: 'delay'; readonly minutes: number }
  | { readonly kind: 'business'; readonly days: number }
  | { readonly kind: 'until'; readonly event: 'opened' | 'clicked'; readonly timeoutMinutes: number };

export type Condition = 'previous-opened' | 'previous-not-opened' | 'previous-clicked';

interface Common {
  readonly id: string;
  readonly wait: Wait;
  readonly condition?: Condition;
}
export type Step =
  | (Common & { readonly kind: 'email'; readonly subject: string; readonly body: string })
  | (Common & { readonly kind: 'task'; readonly title: string })
  | (Common & { readonly kind: 'call'; readonly script: string });

export interface Window {
  /** 0 = Sunday .. 6 = Saturday */
  readonly days: readonly number[];
  readonly startHour: number;
  readonly endHour: number;
}

export interface Sequence {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly Step[];
  readonly window?: Window;
  readonly dailyEmailLimit?: number;
  readonly stopOnReply?: boolean;
  readonly sender: string;
}

export interface Contact {
  readonly id: string;
  readonly email: string;
  readonly fields: Readonly<Record<string, string>>;
  /** Minutes east of UTC. */
  readonly offsetMinutes?: number;
}

export type EnrolStatus = 'active' | 'paused' | 'replied' | 'completed' | 'unsubscribed' | 'bounced' | 'stopped';

export interface HistoryEntry {
  readonly at: number;
  readonly step: string;
  readonly what: 'queued' | 'task' | 'call' | 'skipped' | 'done' | 'blocked';
  readonly note?: string;
}

export interface Enrolment {
  readonly id: string;
  readonly sequence: string;
  readonly contact: Contact;
  status: EnrolStatus;
  /** Index of the step that is next. */
  index: number;
  /** When that step may happen (before the window is applied). */
  readyAt: number;
  /** Set while waiting for an open or click. */
  waitingFor: 'opened' | 'clicked' | null;
  /** What happened to the last email: events by type. */
  last: { opened: boolean; clicked: boolean };
  /** A task or call has been handed out and awaits `complete`. */
  pending: string | null;
  pausedBecause?: string;
  history: HistoryEntry[];
}

export interface Message {
  readonly key: string;
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type Action =
  | { readonly kind: 'email'; readonly enrolment: string; readonly step: string; readonly message: Message }
  | { readonly kind: 'task' | 'call'; readonly enrolment: string; readonly step: string; readonly contact: string; readonly text: string };

// ---------------------------------------------------------------- merge fields

const FIELD = /\{\{\s*([A-Za-z_][\w]*)\s*(?:\|([^{}]*))?\}\}/g;

/** Fills {{name}} and {{name|fallback}}; returns the names that had neither a value nor a fallback. */
export function merge(template: string, fields: Readonly<Record<string, string>>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(FIELD, (_m, name: string, fallback: string | undefined) => {
    const v = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (v !== undefined && v.trim() !== '') return v;
    if (fallback !== undefined) return fallback.trim();
    if (!missing.includes(name)) missing.push(name);
    return '';
  });
  return { text, missing };
}

export const fieldsIn = (template: string): string[] => [...new Set([...template.matchAll(FIELD)].map((m) => m[1]!))];

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// ---------------------------------------------------------------- validation

export function checkSequence(s: Sequence): string[] {
  const p: string[] = [];
  if (!s.id || !s.name.trim()) p.push('the sequence needs an id and a name');
  if (!EMAIL.test(s.sender)) p.push('the sender is not an email address');
  if (!s.steps.length) p.push('a sequence needs at least one step');
  if (s.steps.length > 50) p.push('a sequence has at most 50 steps');
  const ids = new Set<string>();
  s.steps.forEach((st, i) => {
    if (!st.id || ids.has(st.id)) p.push(`step ${i + 1} has a missing or repeated id`);
    ids.add(st.id);
    const w = st.wait;
    if (w.kind === 'delay' && !(Number.isInteger(w.minutes) && w.minutes >= 0 && w.minutes <= 90 * 1440)) p.push(`step ${st.id}: the delay is 0 to 90 days`);
    if (w.kind === 'business' && !(Number.isInteger(w.days) && w.days >= 0 && w.days <= 60)) p.push(`step ${st.id}: business days is 0 to 60`);
    if (w.kind === 'until' && !(Number.isInteger(w.timeoutMinutes) && w.timeoutMinutes >= 1 && w.timeoutMinutes <= 90 * 1440)) p.push(`step ${st.id}: the longest wait is 1 minute to 90 days`);
    if (i === 0 && st.condition) p.push(`step ${st.id}: the first step has no previous email to depend on`);
    if (st.kind === 'email') {
      if (!st.subject.trim() || !st.body.trim()) p.push(`step ${st.id}: an email needs a subject and a body`);
    }
    if (st.kind === 'task' && !st.title.trim()) p.push(`step ${st.id}: a task needs a title`);
    if (st.kind === 'call' && !st.script.trim()) p.push(`step ${st.id}: a call needs a script`);
  });
  if (s.window) {
    const w = s.window;
    if (!w.days.length || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) p.push('window days are 0 (Sunday) to 6 (Saturday), at least one');
    if (!(Number.isInteger(w.startHour) && Number.isInteger(w.endHour) && w.startHour >= 0 && w.endHour <= 24 && w.startHour < w.endHour)) p.push('the window hours need start before end, within 0 to 24');
  }
  if (s.dailyEmailLimit !== undefined && !(Number.isInteger(s.dailyEmailLimit) && s.dailyEmailLimit >= 1)) p.push('the daily limit is a whole number from 1');
  return p;
}

// ---------------------------------------------------------------- windows

const BUSINESS = [1, 2, 3, 4, 5];
const localOf = (t: number, c: Contact) => t + (c.offsetMinutes ?? 0) * MIN;

/** The first moment at or after `t` that is inside the window, in the contact's local time. */
export function nextOpen(t: number, w: Window | undefined, c: Contact): number {
  if (!w) return t;
  const off = (c.offsetMinutes ?? 0) * MIN;
  const local = t + off;
  for (let d = 0; d <= 8; d++) {
    const day0 = Math.floor(local / DAY) * DAY + d * DAY;
    if (!w.days.includes(new Date(day0).getUTCDay())) continue;
    const start = day0 + w.startHour * HOUR;
    const end = day0 + w.endHour * HOUR;
    if (d === 0) {
      if (local >= end) continue;
      if (local >= start) return t;
    }
    return start - off;
  }
  throw new SequenceError('the window never opens');
}

function addBusinessDays(t: number, days: number, w: Window | undefined, c: Contact): number {
  const allowed = w ? w.days : BUSINESS;
  let at = t;
  let left = days;
  while (left > 0) {
    at += DAY;
    if (allowed.includes(new Date(localOf(at, c)).getUTCDay())) left--;
  }
  return at;
}

// ---------------------------------------------------------------- outbox

export interface Outgoing {
  readonly id: string;
  readonly message: Message;
  state: 'queued' | 'sending' | 'sent' | 'dead';
  attempts: number;
  notBefore: number;
  lastError?: string;
}

export class Outbox {
  private items = new Map<string, Outgoing>();
  private byKey = new Map<string, string>();
  private n = 0;
  readonly backoffMinutes = [1, 5, 30, 120, 720];

  /** Idempotent: the same key returns the same item and queues nothing new. */
  enqueue(m: Message, now: number): Outgoing {
    const have = this.byKey.get(m.key);
    if (have) return this.items.get(have)!;
    const it: Outgoing = { id: `m${++this.n}`, message: m, state: 'queued', attempts: 0, notBefore: now };
    this.items.set(it.id, it);
    this.byKey.set(m.key, it.id);
    return it;
  }

  /** Takes up to `limit` messages that are ready; a taken message is not handed out again until it fails. */
  claim(now: number, limit: number): Outgoing[] {
    const out: Outgoing[] = [];
    for (const it of this.items.values()) {
      if (out.length >= limit) break;
      if (it.state === 'queued' && it.notBefore <= now) {
        it.state = 'sending';
        it.attempts++;
        out.push(it);
      }
    }
    return out;
  }

  sent(id: string): void {
    const it = this.need(id);
    if (it.state !== 'sending') throw new SequenceError('that message is not being sent');
    it.state = 'sent';
  }

  failed(id: string, now: number, reason: string): Outgoing {
    const it = this.need(id);
    if (it.state !== 'sending') throw new SequenceError('that message is not being sent');
    it.lastError = reason;
    if (it.attempts >= this.backoffMinutes.length) it.state = 'dead';
    else { it.state = 'queued'; it.notBefore = now + this.backoffMinutes[it.attempts - 1]! * MIN; }
    return it;
  }

  get(id: string): Outgoing | undefined {
    return this.items.get(id);
  }

  count(state: Outgoing['state']): number {
    return [...this.items.values()].filter((i) => i.state === state).length;
  }

  private need(id: string): Outgoing {
    const it = this.items.get(id);
    if (!it) throw new SequenceError('there is no such message');
    return it;
  }
}

// ---------------------------------------------------------------- engine

export interface EngineOptions {
  /** Builds the unsubscribe link for an enrolment. */
  readonly unsubscribeUrl: (enrolmentId: string, email: string) => string;
}

export class Engine {
  private seqs = new Map<string, Sequence>();
  private enrolments = new Map<string, Enrolment>();
  private suppressed = new Map<string, 'unsubscribed' | 'bounced'>();
  private sentOn = new Map<string, number>();
  private n = 0;
  readonly outbox = new Outbox();
  private readonly opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  addSequence(s: Sequence): void {
    const problems = checkSequence(s);
    if (problems.length) throw new SequenceError(problems.join('; '));
    if (this.seqs.has(s.id)) throw new SequenceError(`sequence ${s.id} already exists`);
    this.seqs.set(s.id, s);
  }

  enrolment(id: string): Enrolment | undefined {
    return this.enrolments.get(id);
  }

  isSuppressed(email: string): boolean {
    return this.suppressed.has(email.trim().toLowerCase());
  }

  enrol(sequenceId: string, contact: Contact, now: number): Enrolment {
    const s = this.need(sequenceId);
    const email = contact.email.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) throw new SequenceError(`${contact.email} is not an email address`);
    const why = this.suppressed.get(email);
    if (why) throw new SequenceError(`${email} is suppressed (${why}) and cannot be enrolled`);
    for (const e of this.enrolments.values()) {
      if (e.contact.id === contact.id && (e.status === 'active' || e.status === 'paused')) throw new SequenceError(`${contact.id} is already in a sequence`);
    }
    const off = contact.offsetMinutes ?? 0;
    if (!Number.isInteger(off) || off < -14 * 60 || off > 14 * 60) throw new SequenceError('the UTC offset is within 14 hours');
    const e: Enrolment = { id: `e${++this.n}`, sequence: s.id, contact: { ...contact, email }, status: 'active', index: 0, readyAt: now, waitingFor: null, last: { opened: false, clicked: false }, pending: null, history: [] };
    this.arm(e, s, now, true);
    this.enrolments.set(e.id, e);
    return e;
  }

  /** Works out when step `e.index` is ready, from the wait rule on that step. */
  private arm(e: Enrolment, s: Sequence, from: number, first = false): void {
    const st = s.steps[e.index];
    if (!st) { e.status = 'completed'; return; }
    e.waitingFor = null;
    const w = st.wait;
    if (w.kind === 'delay') e.readyAt = from + w.minutes * MIN;
    else if (w.kind === 'business') e.readyAt = addBusinessDays(from, w.days, s.window, e.contact);
    else if (first) e.readyAt = from;
    else { e.readyAt = from + w.timeoutMinutes * MIN; e.waitingFor = w.event; }
  }

  /** A tracking event the caller observed for the last email. */
  event(enrolmentId: string, kind: 'opened' | 'clicked', now: number): void {
    const e = this.enrolments.get(enrolmentId);
    if (!e || e.status !== 'active') return;
    e.last.opened = true;
    if (kind === 'clicked') e.last.clicked = true;
    if (e.waitingFor && (e.waitingFor === kind || (e.waitingFor === 'opened' && kind === 'clicked'))) {
      e.readyAt = Math.min(e.readyAt, now);
      e.waitingFor = null;
    }
  }

  /** A reply. Auto-replies and out-of-office notices do not stop anything. */
  reply(email: string, now: number, o: { auto?: boolean } = {}): number {
    if (o.auto) return 0;
    let n = 0;
    for (const e of this.enrolments.values()) {
      if (e.contact.email !== email.trim().toLowerCase() || (e.status !== 'active' && e.status !== 'paused')) continue;
      if (this.seqs.get(e.sequence)?.stopOnReply === false) continue;
      e.status = 'replied';
      e.history.push({ at: now, step: e.index < (this.seqs.get(e.sequence)?.steps.length ?? 0) ? this.seqs.get(e.sequence)!.steps[e.index]!.id : '-', what: 'done', note: 'replied' });
      n++;
    }
    return n;
  }

  unsubscribe(email: string, now: number): void {
    this.stopAll(email, 'unsubscribed', now);
  }

  bounce(email: string, now: number, hard = true): void {
    if (hard) this.stopAll(email, 'bounced', now);
  }

  private stopAll(email: string, why: 'unsubscribed' | 'bounced', now: number): void {
    const em = email.trim().toLowerCase();
    this.suppressed.set(em, why);
    for (const e of this.enrolments.values()) {
      if (e.contact.email === em && (e.status === 'active' || e.status === 'paused')) { e.status = why; e.history.push({ at: now, step: '-', what: 'done', note: why }); }
    }
  }

  /** Stops one enrolment by hand. */
  stop(enrolmentId: string, now: number): void {
    const e = this.enrolments.get(enrolmentId);
    if (!e || (e.status !== 'active' && e.status !== 'paused')) throw new SequenceError('that enrolment is not running');
    e.status = 'stopped';
    e.history.push({ at: now, step: '-', what: 'done', note: 'stopped' });
  }

  /** Resumes a paused enrolment after the missing data is fixed. */
  resume(enrolmentId: string, fields: Readonly<Record<string, string>>, now: number): void {
    const e = this.enrolments.get(enrolmentId);
    if (!e || e.status !== 'paused') throw new SequenceError('that enrolment is not paused');
    (e.contact as { fields: Readonly<Record<string, string>> }).fields = { ...e.contact.fields, ...fields };
    e.status = 'active';
    delete e.pausedBecause;
    e.readyAt = Math.max(e.readyAt, now);
  }

  /** A person finished a task or call step. */
  complete(enrolmentId: string, now: number, note?: string): void {
    const e = this.enrolments.get(enrolmentId);
    if (!e || e.status !== 'active' || e.pending === null) throw new SequenceError('nothing is waiting to be completed');
    const s = this.need(e.sequence);
    e.history.push({ at: now, step: e.pending, what: 'done', ...(note ? { note } : {}) });
    e.pending = null;
    e.index++;
    this.arm(e, s, now);
  }

  /** Everything that should happen at `now`: emails (also queued in the outbox), tasks and calls. */
  due(now: number): Action[] {
    const actions: Action[] = [];
    for (const e of this.enrolments.values()) {
      if (e.status !== 'active' || e.pending !== null) continue;
      const s = this.need(e.sequence);
      // A skipped step can lead straight to the next, so loop.
      for (let guard = 0; guard < s.steps.length + 1; guard++) {
        const st = s.steps[e.index];
        if (!st) { e.status = 'completed'; break; }
        if (e.readyAt > now) break;
        if (st.condition && !this.holds(st.condition, e)) {
          e.history.push({ at: now, step: st.id, what: 'skipped', note: st.condition });
          e.index++;
          this.arm(e, s, now);
          continue;
        }
        const at = st.kind === 'task' ? e.readyAt : nextOpen(e.readyAt, s.window, e.contact);
        if (at > now) break;
        if (st.kind === 'email') {
          const day = `${s.id}:${Math.floor(localOf(now, e.contact) / DAY)}`;
          if (s.dailyEmailLimit !== undefined && (this.sentOn.get(day) ?? 0) >= s.dailyEmailLimit) {
            e.readyAt = nextOpen(Math.floor(localOf(now, e.contact) / DAY) * DAY + DAY - (e.contact.offsetMinutes ?? 0) * MIN, s.window, e.contact);
            break;
          }
          const m = this.render(e, s, st);
          if (typeof m === 'string') {
            e.status = 'paused';
            e.pausedBecause = m;
            e.history.push({ at: now, step: st.id, what: 'blocked', note: m });
            break;
          }
          this.sentOn.set(day, (this.sentOn.get(day) ?? 0) + 1);
          this.outbox.enqueue(m, now);
          e.history.push({ at: now, step: st.id, what: 'queued' });
          e.last = { opened: false, clicked: false };
          actions.push({ kind: 'email', enrolment: e.id, step: st.id, message: m });
          e.index++;
          this.arm(e, s, now);
        } else {
          const text = merge(st.kind === 'task' ? st.title : st.script, e.contact.fields).text;
          e.history.push({ at: now, step: st.id, what: st.kind });
          e.pending = st.id;
          actions.push({ kind: st.kind, enrolment: e.id, step: st.id, contact: e.contact.id, text });
          break;
        }
      }
    }
    return actions;
  }

  /** The time the next thing could happen for anything still running, so a scheduler can sleep until then. */
  nextWake(): number | null {
    let best: number | null = null;
    for (const e of this.enrolments.values()) {
      if (e.status !== 'active' || e.pending !== null) continue;
      const s = this.need(e.sequence);
      const st = s.steps[e.index];
      if (!st) continue;
      const t = st.kind === 'task' ? e.readyAt : nextOpen(e.readyAt, s.window, e.contact);
      if (best === null || t < best) best = t;
    }
    return best;
  }

  private holds(c: Condition, e: Enrolment): boolean {
    return c === 'previous-opened' ? e.last.opened : c === 'previous-clicked' ? e.last.clicked : !e.last.opened;
  }

  private render(e: Enrolment, s: Sequence, st: Extract<Step, { kind: 'email' }>): Message | string {
    const sub = merge(st.subject, e.contact.fields);
    const body = merge(st.body, e.contact.fields);
    const missing = [...new Set([...sub.missing, ...body.missing])];
    if (missing.length) return `missing ${missing.join(', ')}`;
    if (/[\r\n]/.test(sub.text)) return 'a merged value puts a line break in the subject';
    if (sub.text.length > 200) return 'the subject is too long';
    const url = this.opts.unsubscribeUrl(e.id, e.contact.email);
    return {
      key: `${e.id}:${st.id}`, to: e.contact.email, from: s.sender, subject: sub.text.trim(),
      text: `${body.text.trim()}\n\n--\nTo stop getting these emails: ${url}\n`,
      headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Auto-Submitted': 'no' },
    };
  }

  private need(id: string): Sequence {
    const s = this.seqs.get(id);
    if (!s) throw new SequenceError(`there is no sequence ${id}`);
    return s;
  }

  /** Counts for a dashboard. */
  summary(sequenceId: string): Record<EnrolStatus, number> {
    const out: Record<EnrolStatus, number> = { active: 0, paused: 0, replied: 0, completed: 0, unsubscribed: 0, bounced: 0, stopped: 0 };
    for (const e of this.enrolments.values()) if (e.sequence === sequenceId) out[e.status]++;
    return out;
  }
}
