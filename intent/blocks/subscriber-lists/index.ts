/**
 * subscriber-lists: mailing lists done properly. Double opt-in with signed, expiring confirmation links, one-click
 * unsubscribe headers, a preference centre (topics and frequency) behind its own signed link, a global suppression
 * list that always wins, and bulk import that refuses to add anyone without consent evidence. Every subscriber keeps
 * the evidence of how they agreed (when, where, which wording, from what address) and an event history.
 *
 * Follows: RFC 8058 (one-click unsubscribe, List-Unsubscribe-Post), RFC 2369 (List-Unsubscribe), RFC 5321 and
 * RFC 5322 limits for addresses (254 octets, 64 for the local part, no line breaks), RFC 2142 role mailboxes,
 * RFC 4180 CSV, and the GDPR idea of demonstrable consent (Article 7) and erasure (Article 17), where only a keyed
 * hash of the address is kept so an erased person is never mailed again.
 *
 * It plugs into the consent and notify blocks by shape: every consent given or withdrawn is passed to `onConsent` as
 * a consent-block record, and mail goes out through `send` as a notify-block Message. Only types are imported.
 *
 * Out of scope: delivering mail, bounce parsing (the caller reports bounces), segmentation beyond topics, and
 * storage (state lives in memory; a persistence layer can replay `history`).
 *
 * Security: tokens are HMAC-SHA256 with domain separation per purpose, compared in constant time, size-bounded and
 * (for confirmation) expiring; a stale confirmation link cannot revive someone who has since unsubscribed;
 * the public subscribe call tells the caller what happened but `publicReply` gives one answer for every outcome so a
 * form cannot be used to discover who is on a list; confirmation mail is rate limited per address; exported CSV
 * neutralises spreadsheet formulas; header values are checked for line breaks.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { Record_ as ConsentRecord } from '../consent/index.ts';
import type { Message } from '../notify/index.ts';

export class ListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListError';
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------------------------
// Addresses

const ROLE_BOXES = new Set(['abuse', 'postmaster', 'hostmaster', 'webmaster', 'noc', 'security', 'root', 'mailer-daemon', 'no-reply', 'noreply', 'donotreply', 'do-not-reply', 'bounce', 'bounces', 'listserv', 'majordomo']);

/** Lower-cased, ASCII-domain form of an address, or undefined when it is not a plain deliverable mailbox. */
export function normalizeEmail(raw: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (s.length < 3 || s.length > 254 || /[\u0000- \u007f"(),:;<>[\\\]]/.test(s)) return undefined;
  const at = s.lastIndexOf('@');
  if (at < 1 || s.indexOf('@') !== at) return undefined;
  const local = s.slice(0, at);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !/^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u.test(local)) return undefined;
  const domain = domainToASCII(s.slice(at + 1).replace(/\.$/, '').toLowerCase());
  if (!domain || domain.length > 253 || !domain.includes('.') || /^[\d.]+$/.test(domain)) return undefined;
  if (!domain.split('.').every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return undefined;
  return `${local.toLowerCase()}@${domain}`;
}

export function isRoleAddress(email: string): boolean {
  const local = email.split('@')[0]!.replace(/\+.*/, '');
  return ROLE_BOXES.has(local);
}

// ---------------------------------------------------------------------------------------------------------------
// Types

export interface Topic {
  readonly id: string;
  readonly name: string;
  /** Whether new subscribers receive this topic until they choose otherwise. */
  readonly defaultOn: boolean;
}

export interface ListConfig {
  readonly id: string;
  readonly name: string;
  /** Default true. A list without it adds people the moment they ask. */
  readonly doubleOptIn?: boolean;
  readonly topics?: readonly Topic[];
  readonly frequencies?: readonly string[];
  /** What the sign-up form says, word for word. Stored with every consent so it can be shown later. */
  readonly consentText: string;
}

export interface Evidence {
  readonly method: 'form' | 'confirm-link' | 'import' | 'api' | 'preference-centre' | 'unsubscribe-link';
  readonly at: number;
  readonly source: string;
  readonly consentVersion: number;
  readonly consentText?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly batch?: string;
}

export type SubscriberState = 'pending' | 'subscribed' | 'unsubscribed';
export type SuppressionReason = 'hard-bounce' | 'complaint' | 'repeated-soft-bounce' | 'manual' | 'erasure';

export interface SubscriberEvent {
  readonly at: number;
  readonly type: string;
  readonly detail?: string;
}

export interface SubscriberView {
  readonly id: string;
  readonly email: string;
  readonly list: string;
  readonly state: SubscriberState;
  readonly topics: Readonly<Record<string, boolean>>;
  readonly frequency: string | undefined;
  readonly evidence: readonly Evidence[];
}

export interface Links {
  readonly confirmUrl: string;
  readonly unsubscribeUrl: string;
  readonly preferencesUrl: string;
}

export interface ListsOptions extends Links {
  /** At least 16 characters; signs every link and keys the suppression hashes. */
  readonly secret: string;
  readonly now: () => number;
  readonly send: (m: Message) => Promise<void>;
  readonly onConsent?: (r: ConsentRecord) => void;
  readonly confirmTtlMs?: number;
  readonly maxSubscribersPerList?: number;
  /** Confirmation mails allowed per address and list in 24 hours. Default 3. */
  readonly maxConfirmationsPerDay?: number;
  /** Least time between two confirmation mails to one address. Default 60 seconds. */
  readonly resendCooldownMs?: number;
  readonly allowInsecureLinks?: boolean;
}

export type SubscribeOutcome = 'confirmation-sent' | 'subscribed' | 'already-subscribed' | 'suppressed' | 'rate-limited' | 'invalid' | 'send-failed';

interface Sub {
  readonly id: string;
  readonly email: string;
  readonly list: string;
  state: SubscriberState;
  epoch: number;
  topics: Map<string, boolean>;
  frequency: string | undefined;
  evidence: Evidence[];
  events: SubscriberEvent[];
  sends: number[];
}

interface ListState {
  readonly cfg: ListConfig;
  consentVersion: number;
  consentText: string;
  readonly subs: Map<string, Sub>;
}

// ---------------------------------------------------------------------------------------------------------------
// CSV

/** Parse RFC 4180 CSV into rows. Quoted cells may hold commas, quotes and line breaks. Size and row count are bounded. */
export function parseCsv(text: string, o: { readonly maxRows?: number; readonly maxBytes?: number } = {}): string[][] {
  const maxRows = o.maxRows ?? 100_001;
  if (typeof text !== 'string' || text.length > (o.maxBytes ?? 20 * 1024 * 1024)) throw new ListError('the CSV is too large');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = (): void => {
    row.push(cell);
    cell = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    if (rows.length > maxRows) throw new ListError(`the CSV has more than ${maxRows} rows`);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else if (c === '"') throw new ListError('a quote in the middle of an unquoted CSV cell');
    else cell += c;
  }
  if (quoted) throw new ListError('the CSV ends inside a quoted cell');
  if (cell !== '' || row.length) endRow();
  return rows;
}

/** One CSV cell, quoted when needed. A leading = + - @ tab or CR is neutralised so spreadsheets do not run it as a formula. */
export function csvCell(v: string): string {
  let s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Import

export interface ImportRow {
  readonly email: string;
  /** When the person agreed, as ISO text or milliseconds. */
  readonly consentedAt?: string | number | undefined;
  /** Where they agreed: "spring 2025 competition form". */
  readonly consentSource?: string | undefined;
  readonly consentText?: string | undefined;
  readonly ip?: string | undefined;
  readonly topics?: readonly string[] | undefined;
}

export type RowVerdict = 'added' | 'confirmation-sent' | 'would-add' | 'invalid' | 'no-evidence' | 'stale-consent' | 'future-consent' | 'suppressed' | 'role-account' | 'duplicate' | 'exists' | 'previously-unsubscribed' | 'over-limit';

export interface ImportReport {
  readonly batch: string;
  readonly dryRun: boolean;
  readonly total: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly rows: readonly { readonly line: number; readonly email: string; readonly verdict: RowVerdict }[];
}

export interface ImportOptions {
  /** Check everything and change nothing. */
  readonly dryRun?: boolean;
  /** 'require' (default on a double opt-in list): imported people must still confirm. 'accept-evidence': trust the evidence and subscribe. */
  readonly confirm?: 'require' | 'accept-evidence';
  /** Oldest consent accepted. Default 2 years. */
  readonly maxConsentAgeMs?: number;
  readonly maxRows?: number;
  /** A label for this import, recorded with each person's evidence. */
  readonly batch?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// The service

type TokenKind = 'confirm' | 'unsub' | 'prefs';

function clean(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return t === '' ? undefined : t;
}

function checkUrl(name: string, u: string, allowInsecure: boolean): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new ListError(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) throw new ListError(`${name} must be an https URL`);
  if (url.hash) throw new ListError(`${name} must not have a fragment`);
  return u;
}

export class SubscriberLists {
  private readonly lists = new Map<string, ListState>();
  private readonly suppressions = new Map<string, { reason: SuppressionReason; at: number }>();
  private readonly softBounces = new Map<string, number[]>();
  private readonly o: Required<Omit<ListsOptions, 'onConsent'>> & { onConsent: ((r: ConsentRecord) => void) | undefined };
  private batchCounter = 0;

  constructor(o: ListsOptions) {
    if (typeof o.secret !== 'string' || o.secret.length < 16) throw new ListError('the secret must be at least 16 characters');
    const insecure = o.allowInsecureLinks ?? false;
    this.o = {
      confirmTtlMs: 3 * DAY, maxSubscribersPerList: 1_000_000, maxConfirmationsPerDay: 3, resendCooldownMs: 60_000, allowInsecureLinks: insecure, ...o,
      confirmUrl: checkUrl('confirmUrl', o.confirmUrl, insecure), unsubscribeUrl: checkUrl('unsubscribeUrl', o.unsubscribeUrl, insecure), preferencesUrl: checkUrl('preferencesUrl', o.preferencesUrl, insecure),
      onConsent: o.onConsent,
    };
  }

  // -- lists -----------------------------------------------------------------------------------------------

  createList(cfg: ListConfig): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cfg.id)) throw new ListError('a list id is 1 to 64 lower-case letters, digits, hyphens or underscores');
    if (this.lists.has(cfg.id)) throw new ListError(`list "${cfg.id}" already exists`);
    if (!cfg.name.trim() || !cfg.consentText.trim()) throw new ListError('a list needs a name and the consent wording shown on its form');
    const ids = new Set<string>();
    for (const t of cfg.topics ?? []) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(t.id) || ids.has(t.id)) throw new ListError(`bad or repeated topic id "${t.id}"`);
      ids.add(t.id);
    }
    this.lists.set(cfg.id, { cfg, consentVersion: 1, consentText: cfg.consentText, subs: new Map() });
  }

  /** Change the sign-up wording. Later consents are recorded against the new version; earlier ones keep theirs. */
  setConsentText(listId: string, text: string): number {
    const l = this.list(listId);
    if (!text.trim()) throw new ListError('the consent wording cannot be empty');
    l.consentText = text;
    return ++l.consentVersion;
  }

  private list(id: string): ListState {
    const l = this.lists.get(id);
    if (!l) throw new ListError(`no list called "${id}"`);
    return l;
  }

  // -- tokens ----------------------------------------------------------------------------------------------

  private mac(kind: TokenKind, payload: string): Buffer {
    return createHmac('sha256', this.o.secret).update(`zthr-subscriber-lists/v1/${kind}/`).update(payload).digest();
  }

  private makeToken(kind: TokenKind, list: string, email: string, epoch: number, exp: number): string {
    const p = Buffer.from(JSON.stringify([list, email, epoch, exp])).toString('base64url');
    return `${p}.${this.mac(kind, p).toString('base64url')}`;
  }

  private readToken(kind: TokenKind, token: string): { list: string; email: string; epoch: number; exp: number } | undefined {
    if (typeof token !== 'string' || token.length > 1024) return undefined;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    const got = Buffer.from(parts[1], 'base64url');
    const want = this.mac(kind, parts[0]);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    try {
      const v: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (!Array.isArray(v) || v.length !== 4 || typeof v[0] !== 'string' || typeof v[1] !== 'string' || typeof v[2] !== 'number' || typeof v[3] !== 'number') return undefined;
      return { list: v[0], email: v[1], epoch: v[2], exp: v[3] };
    } catch {
      return undefined;
    }
  }

  private link(base: string, token: string): string {
    return `${base}${base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'}t=${token}`;
  }

  /** Link that confirms a pending subscription. */
  confirmLink(listId: string, email: string): string {
    const s = this.sub(listId, email);
    return this.link(this.o.confirmUrl, this.makeToken('confirm', listId, s.email, s.epoch, this.o.now() + this.o.confirmTtlMs));
  }

  /** Headers for every marketing mail (RFC 8058): the link works with a single POST and needs no login. */
  unsubscribeHeaders(listId: string, email: string): Record<string, string> {
    const s = this.sub(listId, email);
    const url = this.link(this.o.unsubscribeUrl, this.makeToken('unsub', listId, s.email, 0, 0));
    return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  }

  preferencesLink(listId: string, email: string): string {
    const s = this.sub(listId, email);
    return this.link(this.o.preferencesUrl, this.makeToken('prefs', listId, s.email, 0, this.o.now() + 30 * DAY));
  }

  // -- suppression -----------------------------------------------------------------------------------------

  private hash(email: string): string {
    return createHmac('sha256', this.o.secret).update('zthr-subscriber-lists/v1/suppress/').update(email).digest('hex');
  }

  isSuppressed(email: string): boolean {
    const e = normalizeEmail(email);
    return e !== undefined && this.suppressions.has(this.hash(e));
  }

  suppressionReason(email: string): SuppressionReason | undefined {
    const e = normalizeEmail(email);
    return e === undefined ? undefined : this.suppressions.get(this.hash(e))?.reason;
  }

  /** Never mail this address again, on any list. Keeps only a keyed hash. Anyone subscribed on it is marked unsubscribed. */
  suppress(email: string, reason: SuppressionReason): boolean {
    const e = normalizeEmail(email);
    if (e === undefined) return false;
    const h = this.hash(e);
    if (!this.suppressions.has(h)) this.suppressions.set(h, { reason, at: this.o.now() });
    for (const l of this.lists.values()) {
      const s = l.subs.get(e);
      if (s && s.state !== 'unsubscribed') this.setState(l, s, 'unsubscribed', 'suppressed', reason);
    }
    return true;
  }

  /** Lift a suppression. Bounces and complaints can never be lifted; only a manual one can, and the person must have asked again. */
  liftSuppression(email: string): boolean {
    const e = normalizeEmail(email);
    if (e === undefined) return false;
    const h = this.hash(e);
    const s = this.suppressions.get(h);
    if (!s) return false;
    if (s.reason !== 'manual') throw new ListError(`a ${s.reason} suppression cannot be lifted`);
    return this.suppressions.delete(h);
  }

  /** Report from the mail provider. Hard bounces and complaints suppress at once; five soft bounces within a week do. */
  recordBounce(email: string, kind: 'hard' | 'soft' | 'complaint'): void {
    const e = normalizeEmail(email);
    if (e === undefined) return;
    if (kind === 'hard') this.suppress(e, 'hard-bounce');
    else if (kind === 'complaint') this.suppress(e, 'complaint');
    else {
      const now = this.o.now();
      const h = this.hash(e);
      const recent = [...(this.softBounces.get(h) ?? []).filter((t) => now - t < 7 * DAY), now];
      this.softBounces.set(h, recent);
      if (recent.length >= 5) this.suppress(e, 'repeated-soft-bounce');
    }
  }

  /** Right to erasure: remove the person from every list and keep only the keyed hash so they are never re-added. */
  erase(email: string): number {
    const e = normalizeEmail(email);
    if (e === undefined) return 0;
    let n = 0;
    for (const l of this.lists.values()) {
      if (l.subs.delete(e)) n++;
    }
    this.suppressions.set(this.hash(e), { reason: 'erasure', at: this.o.now() });
    this.softBounces.delete(this.hash(e));
    return n;
  }

  // -- subscribers -----------------------------------------------------------------------------------------

  private sub(listId: string, email: string): Sub {
    const e = normalizeEmail(email);
    const s = e === undefined ? undefined : this.list(listId).subs.get(e);
    if (!s) throw new ListError('no such subscriber');
    return s;
  }

  private note(s: Sub, type: string, detail?: string): void {
    s.events.push({ at: this.o.now(), type, ...(detail !== undefined ? { detail } : {}) });
    if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
  }

  private setState(l: ListState, s: Sub, state: SubscriberState, type: string, detail?: string): void {
    const was = s.state;
    s.state = state;
    this.note(s, type, detail);
    if (was !== 'subscribed' && state === 'subscribed') this.consent(l, s, true, s.evidence[s.evidence.length - 1]?.method ?? 'api');
    if (was === 'subscribed' && state !== 'subscribed') this.consent(l, s, false, detail ?? type);
  }

  private consent(l: ListState, s: Sub, given: boolean, how: string): void {
    this.o.onConsent?.({ who: s.id, doc: `list:${l.cfg.id}`, version: given ? (s.evidence[s.evidence.length - 1]?.consentVersion ?? l.consentVersion) : l.consentVersion, given, at: new Date(this.o.now()).toISOString(), how });
  }

  private evidence(l: ListState, method: Evidence['method'], source: string, extra: { ip?: string | undefined; userAgent?: string | undefined; consentText?: string | undefined; at?: number; batch?: string }): Evidence {
    const ip = clean(extra.ip, 45);
    const ua = clean(extra.userAgent, 300);
    const ct = clean(extra.consentText, 1000);
    const batch = extra.batch;
    return { method, at: extra.at ?? this.o.now(), source: clean(source, 200) ?? method, consentVersion: l.consentVersion, ...(ct !== undefined ? { consentText: ct } : { consentText: l.consentText }), ...(ip !== undefined ? { ip } : {}), ...(ua !== undefined ? { userAgent: ua } : {}), ...(batch !== undefined ? { batch } : {}) };
  }

  private newSub(l: ListState, email: string): Sub {
    if (l.subs.size >= this.o.maxSubscribersPerList) throw new ListError('the list is full');
    const id = `sub_${createHmac('sha256', this.o.secret).update('zthr-subscriber-lists/v1/id/').update(`${l.cfg.id}|${email}`).digest('hex').slice(0, 20)}`;
    const topics = new Map<string, boolean>((l.cfg.topics ?? []).map((t) => [t.id, t.defaultOn]));
    const s: Sub = { id, email, list: l.cfg.id, state: 'unsubscribed', epoch: 0, topics, frequency: l.cfg.frequencies?.[0], evidence: [], events: [], sends: [] };
    l.subs.set(email, s);
    return s;
  }

  private async sendConfirmation(l: ListState, s: Sub): Promise<boolean> {
    const now = this.o.now();
    s.sends = s.sends.filter((t) => now - t < DAY);
    if (s.sends.length >= this.o.maxConfirmationsPerDay || (s.sends.length && now - s.sends[s.sends.length - 1]! < this.o.resendCooldownMs)) return false;
    s.sends.push(now);
    const url = this.link(this.o.confirmUrl, this.makeToken('confirm', l.cfg.id, s.email, s.epoch, now + this.o.confirmTtlMs));
    const body = `Someone asked to add this address to "${l.cfg.name}".\n\n${l.consentText}\n\nTo confirm, open this link:\n${url}\n\nIf this was not you, ignore this message and nothing will happen. The link stops working in ${Math.round(this.o.confirmTtlMs / HOUR)} hours.`;
    try {
      await this.o.send({ to: s.email, channel: 'email', subject: `Confirm your subscription to ${l.cfg.name}`, body, headers: {} });
    } catch {
      this.note(s, 'send-failed');
      throw new SendFailed();
    }
    this.note(s, 'confirmation-sent');
    return true;
  }

  /** A person asks to join a list (a sign-up form). On a double opt-in list nothing happens until they confirm. */
  async subscribe(listId: string, rawEmail: string, ev: { readonly source: string; readonly ip?: string; readonly userAgent?: string }): Promise<SubscribeOutcome> {
    const l = this.list(listId);
    const email = normalizeEmail(rawEmail);
    if (email === undefined) return 'invalid';
    if (this.suppressions.has(this.hash(email))) return 'suppressed';
    const existing = l.subs.get(email);
    if (existing?.state === 'subscribed') return 'already-subscribed';
    const s = existing ?? this.newSub(l, email);
    const evidence = this.evidence(l, 'form', ev.source, { ip: ev.ip, userAgent: ev.userAgent });
    if (l.cfg.doubleOptIn === false) {
      s.evidence.push(evidence);
      s.epoch++;
      this.setState(l, s, 'subscribed', 'subscribed', 'single opt-in');
      return 'subscribed';
    }
    if (s.state === 'unsubscribed') s.epoch++;
    s.state = 'pending';
    s.evidence.push(evidence);
    try {
      return (await this.sendConfirmation(l, s)) ? 'confirmation-sent' : 'rate-limited';
    } catch (e) {
      if (e instanceof SendFailed) return 'send-failed';
      throw e;
    }
  }

  /** What a public form should show whatever happened, so it cannot be used to find out who is on a list. */
  publicReply(listId: string): string {
    const l = this.list(listId);
    return l.cfg.doubleOptIn === false ? 'Thanks. You are on the list.' : 'Thanks. If this address can be added, a confirmation message is on its way.';
  }

  /** The person opens the link in the confirmation mail. */
  confirm(token: string, ev: { readonly ip?: string; readonly userAgent?: string } = {}): { ok: true; list: string; email: string; alreadyConfirmed: boolean } | { ok: false; reason: 'invalid' | 'expired' | 'superseded' } {
    const t = this.readToken('confirm', token);
    if (!t) return { ok: false, reason: 'invalid' };
    if (this.o.now() > t.exp) return { ok: false, reason: 'expired' };
    const l = this.lists.get(t.list);
    const s = l?.subs.get(t.email);
    if (!l || !s || this.suppressions.has(this.hash(t.email))) return { ok: false, reason: 'invalid' };
    if (s.epoch !== t.epoch) return { ok: false, reason: 'superseded' };
    if (s.state === 'subscribed') return { ok: true, list: t.list, email: s.email, alreadyConfirmed: true };
    if (s.state !== 'pending') return { ok: false, reason: 'superseded' };
    s.evidence.push(this.evidence(l, 'confirm-link', 'confirmation link', ev));
    this.setState(l, s, 'subscribed', 'confirmed');
    return { ok: true, list: t.list, email: s.email, alreadyConfirmed: false };
  }

  /** One-click unsubscribe: the POST (or GET) from the link in List-Unsubscribe. Safe to repeat. */
  unsubscribe(token: string): { ok: boolean; list?: string } {
    const t = this.readToken('unsub', token);
    if (!t) return { ok: false };
    const l = this.lists.get(t.list);
    const s = l?.subs.get(t.email);
    if (!l || !s) return { ok: false };
    if (s.state !== 'unsubscribed') {
      s.evidence.push(this.evidence(l, 'unsubscribe-link', 'one-click unsubscribe', {}));
      s.epoch++;
      this.setState(l, s, 'unsubscribed', 'unsubscribed', 'by link');
    }
    return { ok: true, list: t.list };
  }

  // -- preference centre -----------------------------------------------------------------------------------

  private readPrefs(token: string): { l: ListState; s: Sub } | undefined {
    const t = this.readToken('prefs', token);
    if (!t || this.o.now() > t.exp) return undefined;
    const l = this.lists.get(t.list);
    const s = l?.subs.get(t.email);
    return l && s ? { l, s } : undefined;
  }

  preferences(token: string): { list: string; listName: string; state: SubscriberState; topics: { id: string; name: string; on: boolean }[]; frequency: string | undefined; frequencies: readonly string[] } | undefined {
    const r = this.readPrefs(token);
    if (!r) return undefined;
    return { list: r.l.cfg.id, listName: r.l.cfg.name, state: r.s.state, topics: (r.l.cfg.topics ?? []).map((t) => ({ id: t.id, name: t.name, on: r.s.topics.get(t.id) ?? false })), frequency: r.s.frequency, frequencies: r.l.cfg.frequencies ?? [] };
  }

  /** Change topics and frequency. Unknown topics or frequencies are an error, not silently ignored. Turning every topic off keeps the subscription. */
  setPreferences(token: string, change: { topics?: Readonly<Record<string, boolean>>; frequency?: string }): boolean {
    const r = this.readPrefs(token);
    if (!r) return false;
    const known = new Set((r.l.cfg.topics ?? []).map((t) => t.id));
    for (const k of Object.keys(change.topics ?? {})) if (!known.has(k)) throw new ListError(`unknown topic "${k}"`);
    if (change.frequency !== undefined && !(r.l.cfg.frequencies ?? []).includes(change.frequency)) throw new ListError(`unknown frequency "${change.frequency}"`);
    if (r.s.state !== 'subscribed') throw new ListError('preferences can only be changed by a confirmed subscriber');
    for (const [k, v] of Object.entries(change.topics ?? {})) r.s.topics.set(k, v === true);
    if (change.frequency !== undefined) r.s.frequency = change.frequency;
    r.s.evidence.push(this.evidence(r.l, 'preference-centre', 'preference centre', {}));
    this.note(r.s, 'preferences-changed', JSON.stringify(change));
    return true;
  }

  /** The preference centre's "unsubscribe from everything on this list". */
  unsubscribeViaPreferences(token: string): boolean {
    const r = this.readPrefs(token);
    if (!r) return false;
    if (r.s.state !== 'unsubscribed') {
      r.s.epoch++;
      this.setState(r.l, r.s, 'unsubscribed', 'unsubscribed', 'preference centre');
    }
    return true;
  }

  // -- sending side ----------------------------------------------------------------------------------------

  /** Who may be mailed now: confirmed, not suppressed, and (when given) opted in to the topic. */
  recipients(listId: string, o: { readonly topic?: string; readonly frequency?: string } = {}): string[] {
    const l = this.list(listId);
    if (o.topic !== undefined && !(l.cfg.topics ?? []).some((t) => t.id === o.topic)) throw new ListError(`unknown topic "${o.topic}"`);
    return [...l.subs.values()]
      .filter((s) => s.state === 'subscribed' && !this.suppressions.has(this.hash(s.email)) && (o.topic === undefined || s.topics.get(o.topic)) && (o.frequency === undefined || s.frequency === o.frequency))
      .map((s) => s.email)
      .sort();
  }

  get(listId: string, email: string): SubscriberView | undefined {
    const e = normalizeEmail(email);
    const l = this.list(listId);
    const s = e === undefined ? undefined : l.subs.get(e);
    return s && { id: s.id, email: s.email, list: s.list, state: s.state, topics: Object.fromEntries(s.topics), frequency: s.frequency, evidence: [...s.evidence] };
  }

  history(listId: string, email: string): readonly SubscriberEvent[] {
    return [...this.sub(listId, email).events];
  }

  stats(listId: string): { pending: number; subscribed: number; unsubscribed: number } {
    const c = { pending: 0, subscribed: 0, unsubscribed: 0 };
    for (const s of this.list(listId).subs.values()) c[s.state]++;
    return c;
  }

  /** Subscribers as CSV, formula-safe. Includes the evidence summary so the file is a consent register too. */
  exportCsv(listId: string): string {
    const l = this.list(listId);
    const rows = [['email', 'state', 'consented_at', 'source', 'consent_version', 'ip']];
    for (const s of [...l.subs.values()].sort((a, b) => a.email.localeCompare(b.email))) {
      const ev = [...s.evidence].reverse().find((e) => e.method !== 'preference-centre' && e.method !== 'unsubscribe-link');
      rows.push([s.email, s.state, ev ? new Date(ev.at).toISOString() : '', ev?.source ?? '', ev ? String(ev.consentVersion) : '', ev?.ip ?? '']);
    }
    return `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  // -- import ----------------------------------------------------------------------------------------------

  /** Parse a CSV with a header row (email, consented_at, consent_source, consent_text, ip, topics) into import rows. */
  static rowsFromCsv(text: string, maxRows = 100_000): ImportRow[] {
    const rows = parseCsv(text, { maxRows: maxRows + 1 });
    const head = rows.shift()?.map((h) => h.trim().toLowerCase());
    if (!head || !head.includes('email')) throw new ListError('the CSV needs a header row with an "email" column');
    const col = (r: string[], name: string): string | undefined => {
      const i = head.indexOf(name);
      const v = i < 0 ? undefined : r[i]?.trim();
      return v === '' ? undefined : v;
    };
    return rows.map((r) => ({ email: col(r, 'email') ?? '', consentedAt: col(r, 'consented_at'), consentSource: col(r, 'consent_source'), consentText: col(r, 'consent_text'), ip: col(r, 'ip'), topics: col(r, 'topics')?.split(/[;|]/).map((x) => x.trim()).filter(Boolean) }));
  }

  /**
   * Bulk import. A row is accepted only with evidence of consent (when and where). People who unsubscribed, are
   * suppressed or erased are never added back by an import, however old the evidence. On a double opt-in list the
   * default is to ask each imported person to confirm.
   */
  async importRows(listId: string, rows: readonly ImportRow[], o: ImportOptions = {}): Promise<ImportReport> {
    const l = this.list(listId);
    const maxRows = o.maxRows ?? 100_000;
    if (rows.length > maxRows) throw new ListError(`an import is limited to ${maxRows} rows`);
    const now = this.o.now();
    const maxAge = o.maxConsentAgeMs ?? 2 * 365 * DAY;
    const confirm = o.confirm ?? (l.cfg.doubleOptIn === false ? 'accept-evidence' : 'require');
    const batch = o.batch ?? `import-${now}-${++this.batchCounter}`;
    const seen = new Set<string>();
    const out: { line: number; email: string; verdict: RowVerdict }[] = [];
    const counts: Record<string, number> = {};
    const verdict = (line: number, email: string, v: RowVerdict): void => {
      out.push({ line, email, verdict: v });
      counts[v] = (counts[v] ?? 0) + 1;
    };
    let room = this.o.maxSubscribersPerList - l.subs.size;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const line = i + 1;
      const email = normalizeEmail(row.email);
      if (email === undefined) { verdict(line, String(row.email ?? '').slice(0, 100), 'invalid'); continue; }
      if (seen.has(email)) { verdict(line, email, 'duplicate'); continue; }
      seen.add(email);
      if (this.suppressions.has(this.hash(email))) { verdict(line, email, 'suppressed'); continue; }
      if (isRoleAddress(email)) { verdict(line, email, 'role-account'); continue; }
      const at = typeof row.consentedAt === 'number' ? row.consentedAt : row.consentedAt ? Date.parse(row.consentedAt) : NaN;
      const source = clean(row.consentSource, 200);
      if (!Number.isFinite(at) || source === undefined) { verdict(line, email, 'no-evidence'); continue; }
      if (at > now + HOUR) { verdict(line, email, 'future-consent'); continue; }
      if (now - at > maxAge) { verdict(line, email, 'stale-consent'); continue; }
      const existing = l.subs.get(email);
      if (existing?.state === 'unsubscribed') { verdict(line, email, 'previously-unsubscribed'); continue; }
      if (existing) { verdict(line, email, 'exists'); continue; }
      if (room <= 0) { verdict(line, email, 'over-limit'); continue; }
      if (o.dryRun) { verdict(line, email, 'would-add'); room--; continue; }
      room--;
      const s = this.newSub(l, email);
      for (const t of row.topics ? [...(l.cfg.topics ?? [])] : []) s.topics.set(t.id, row.topics!.includes(t.id));
      s.evidence.push(this.evidence(l, 'import', source, { at, ip: row.ip, consentText: row.consentText, batch }));
      s.epoch++;
      if (confirm === 'accept-evidence') {
        this.setState(l, s, 'subscribed', 'imported', batch);
        verdict(line, email, 'added');
      } else {
        s.state = 'pending';
        this.note(s, 'imported', batch);
        try {
          await this.sendConfirmation(l, s);
        } catch (e) {
          if (!(e instanceof SendFailed)) throw e;
        }
        verdict(line, email, 'confirmation-sent');
      }
    }
    return { batch, dryRun: o.dryRun === true, total: rows.length, counts, rows: out };
  }
}

class SendFailed extends Error {
  constructor() {
    super('the confirmation message could not be sent');
  }
}

/** Short stable fingerprint of an address for logs, so logs never carry the address itself. */
export function addressFingerprint(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12);
}
