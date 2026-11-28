/**
 * Slash commands, interactive messages and bot tokens, in the way chat platforms (Slack, Mattermost, Rocket.Chat)
 * make them work, so the same bot code serves each.
 *
 *  - A command registry: "/deploy" with a summary, argument limits, the channel kinds it may run in and a
 *    permission check. `parseCommandLine` reads the arguments with quotes and escapes.
 *  - Request signing in the Slack form: `v0=` + HMAC-SHA-256 of "v0:<timestamp>:<exact body>", checked in constant
 *    time, within a time window, and refusing a request already seen. The dispatcher answers an unsigned,
 *    stale, replayed or oversized request before reading any field.
 *  - The dispatcher: verifies, reads the form body, finds the command, checks the user is in the channel, runs the
 *    handler and shapes the answer (ephemeral or in-channel, with blocks). A handler that needs longer than the
 *    platform's three seconds returns `later(promise)`: the request is acknowledged at once and the result is posted
 *    to the response URL.
 *  - Response URLs: unguessable, tied to the user and channel, valid for 30 minutes and five uses, as on Slack;
 *    replies may replace or delete the original.
 *  - Signed callbacks: a button or menu carries a token that is a signed, expiring statement of what it is for (and
 *    optionally who may press it); a token for another user, past its time, altered, or already used is refused.
 *    Interactive payloads sent between services are verified by the webhooks block (timestamped HMAC, replay-safe).
 *  - Message blocks (section, actions, input, divider, context; buttons and selects) checked against the platform's
 *    limits, and the modals model: a view with inputs, opened only with a one-use trigger id that expires in three
 *    seconds, submitted only by the user it was opened for, validated field by field with errors by block id, and
 *    updated only when the caller's view hash is current.
 *  - Bot tokens: shown once, kept as hashes, with scopes, found by constant-time hash comparison, revoked or expired.
 *
 * Not here: delivery to the platform's own API, rich-text rendering, OAuth install flow (oauth2-server), and the
 * `channels` block (it does not exist in this library yet), so channel membership is a small interface
 * (`Directory`) with an in-memory version.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inbound } from '../webhooks/index.ts';

export class SlashError extends Error {}
export class BadSignature extends SlashError {}
export class BadToken extends SlashError {}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

// ---------------------------------------------------------------- reading a command line

const NAME = /^\/[a-z0-9][a-z0-9_-]{0,31}$/;

/** Words split on spaces, with "double quotes" (and curly quotes) keeping spaces and a backslash escaping a quote. */
export function tokenize(text: string, o: { maxArgs?: number; maxLength?: number } = {}): string[] {
  const maxArgs = o.maxArgs ?? 50;
  const maxLength = o.maxLength ?? 1000;
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (quoted) {
      if (c === '\\' && (chars[i + 1] === '"' || chars[i + 1] === '\\')) cur += chars[++i];
      else if (c === '"' || c === '”') quoted = false;
      else cur += c;
    } else if (c === '"' || c === '“') {
      quoted = true;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else cur += c;
    if (cur.length > maxLength) throw new SlashError(`an argument is longer than ${maxLength} characters`);
  }
  if (quoted) throw new SlashError('a quote was opened and never closed');
  if (started || cur) out.push(cur);
  if (out.length > maxArgs) throw new SlashError(`more than ${maxArgs} arguments`);
  return out;
}

/** "/deploy prod 'app one'" into the command name and its arguments. */
export function parseCommandLine(line: string): { name: string; args: string[] } {
  const [first, ...rest] = tokenize(line.trim());
  if (!first || !NAME.test(first)) throw new SlashError('a command starts with / and a lower-case name');
  return { name: first, args: rest };
}

/** Parse an application/x-www-form-urlencoded body: bounded, the first value of a repeated field wins. */
export function parseForm(body: string, maxFields = 100): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!body) return out;
  const parts = body.split('&');
  if (parts.length > maxFields) throw new SlashError('too many fields');
  for (const p of parts) {
    const i = p.indexOf('=');
    let k: string;
    let v: string;
    try {
      k = decodeURIComponent((i < 0 ? p : p.slice(0, i)).replace(/\+/g, ' '));
      v = decodeURIComponent((i < 0 ? '' : p.slice(i + 1)).replace(/\+/g, ' '));
    } catch {
      throw new SlashError('the form body is not valid percent-encoding');
    }
    if (k === '__proto__') continue;
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Text that is safe to put in a chat message: the three characters Slack-style markup treats as control. */
export const escapeMarkup = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
export const mention = (userId: string) => `<@${userId.replace(/[^A-Za-z0-9_.-]/g, '')}>`;

// ---------------------------------------------------------------- signing

/** `v0=` and the hex HMAC-SHA-256 of "v0:<timestamp>:<body>". */
export function signRequest(secret: string, timestamp: number, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

export interface VerifyOptions {
  readonly now: () => number;
  /** Seconds either side of now. Default 300. */
  readonly toleranceSec?: number;
}

/** Check a request's signature and age. The two headers are `x-slack-request-timestamp` and `x-slack-signature`. */
export function verifyRequest(secrets: readonly string[], headers: Readonly<Record<string, string | undefined>>, body: string, o: VerifyOptions): void {
  const ts = headers['x-slack-request-timestamp'];
  const sig = headers['x-slack-signature'];
  if (!ts || !/^\d{1,12}$/.test(ts) || !sig || !/^v0=[0-9a-f]{64}$/.test(sig)) throw new BadSignature('the request is not signed in the expected form');
  if (Math.abs(Math.floor(o.now() / 1000) - Number(ts)) > (o.toleranceSec ?? 300)) throw new BadSignature('the request is too old or from the future');
  const got = Buffer.from(sig.slice(3), 'hex');
  const ok = secrets.map((s) => same(Buffer.from(signRequest(s, Number(ts), body).slice(3), 'hex'), got)).some(Boolean);
  if (!ok) throw new BadSignature('the signature does not match');
}

// ---------------------------------------------------------------- blocks

export interface Block {
  readonly type: 'section' | 'actions' | 'input' | 'divider' | 'context';
  readonly block_id?: string;
  readonly text?: { readonly type: 'mrkdwn' | 'plain_text'; readonly text: string };
  readonly label?: { readonly type: 'plain_text'; readonly text: string };
  readonly optional?: boolean;
  readonly element?: Element;
  readonly elements?: readonly Element[];
}

export interface Element {
  readonly type: 'button' | 'static_select' | 'plain_text_input' | 'datepicker' | 'checkboxes' | 'image' | 'mrkdwn' | 'plain_text';
  readonly action_id?: string;
  readonly text?: { readonly type: 'plain_text'; readonly text: string } | string;
  readonly value?: string;
  readonly options?: readonly { readonly text: { readonly type: 'plain_text'; readonly text: string }; readonly value: string }[];
  readonly min_length?: number;
  readonly max_length?: number;
}

/** Everything wrong with a list of blocks, by place; empty when the platform would accept it. */
export function blockProblems(blocks: readonly Block[], max = 50): string[] {
  const out: string[] = [];
  if (blocks.length > max) out.push(`at most ${max} blocks`);
  const ids = new Set<string>();
  blocks.forEach((b, i) => {
    const at = `block ${i + 1}`;
    if (!['section', 'actions', 'input', 'divider', 'context'].includes(b.type)) out.push(`${at}: unknown type ${String(b.type)}`);
    if (b.block_id !== undefined) {
      if (b.block_id.length === 0 || b.block_id.length > 255) out.push(`${at}: block_id is 1 to 255 characters`);
      if (ids.has(b.block_id)) out.push(`${at}: block_id ${b.block_id} is used twice`);
      ids.add(b.block_id);
    }
    if (b.type === 'section' && !b.text) out.push(`${at}: a section needs text`);
    if (b.text && (b.text.text.length === 0 || b.text.text.length > 3000)) out.push(`${at}: text is 1 to 3000 characters`);
    if (b.type === 'input') {
      if (!b.block_id) out.push(`${at}: an input needs a block_id`);
      if (!b.element?.action_id) out.push(`${at}: an input needs an element with an action_id`);
      if (!b.label || b.label.text.length === 0 || b.label.text.length > 2000) out.push(`${at}: an input needs a label of 1 to 2000 characters`);
    }
    if (b.type === 'actions') {
      const els = b.elements ?? [];
      if (els.length === 0 || els.length > 25) out.push(`${at}: actions hold 1 to 25 elements`);
      const aids = new Set<string>();
      for (const e of els) {
        if (!e.action_id || e.action_id.length > 255) out.push(`${at}: every element needs an action_id of at most 255 characters`);
        else if (aids.has(e.action_id)) out.push(`${at}: action_id ${e.action_id} is used twice`);
        else aids.add(e.action_id);
        if (e.type === 'button') {
          const t = typeof e.text === 'string' ? e.text : e.text?.text;
          if (!t || t.length > 75) out.push(`${at}: a button needs text of at most 75 characters`);
          if (e.value !== undefined && e.value.length > 2000) out.push(`${at}: a button value is at most 2000 characters`);
        }
        if (e.type === 'static_select' && (!e.options || e.options.length === 0 || e.options.length > 100)) out.push(`${at}: a select has 1 to 100 options`);
      }
    }
  });
  return out;
}

export function assertBlocks(blocks: readonly Block[], max = 50): void {
  const p = blockProblems(blocks, max);
  if (p.length) throw new SlashError(p.join('; '));
}

// ---------------------------------------------------------------- replies and response URLs

export interface Reply {
  readonly text: string;
  readonly visibility?: 'ephemeral' | 'in_channel';
  readonly blocks?: readonly Block[];
  readonly replaceOriginal?: boolean;
  readonly deleteOriginal?: boolean;
}

/** The wire form of a reply: what the platform expects in the JSON answer. */
export function replyJson(r: Reply): string {
  if (r.blocks) assertBlocks(r.blocks);
  if (r.text.length > 40_000) throw new SlashError('text is at most 40,000 characters');
  return JSON.stringify({ response_type: r.visibility ?? 'ephemeral', text: r.text, ...(r.blocks ? { blocks: r.blocks } : {}), ...(r.replaceOriginal !== undefined ? { replace_original: r.replaceOriginal } : {}), ...(r.deleteOriginal ? { delete_original: true } : {}) });
}

export interface ResponseUrl {
  readonly id: string;
  readonly url: string;
  readonly user: string;
  readonly channel: string;
  readonly expires: number;
  uses: number;
  readonly delivered: Reply[];
}

export interface Deps {
  /** Random bytes: injected so tests are deterministic. */
  readonly random: (n: number) => Uint8Array;
  readonly now: () => number;
}

/** Response URLs: 30 minutes and 5 uses by default, for one user in one channel. */
export class ResponseUrls {
  private readonly all = new Map<string, ResponseUrl>();
  private readonly d: Deps;
  private readonly base: string;
  private readonly ttlMs: number;
  private readonly maxUses: number;

  constructor(d: Deps, o: { base?: string; ttlMs?: number; maxUses?: number } = {}) {
    this.d = d;
    this.base = o.base ?? 'https://chat.example.test/respond/';
    this.ttlMs = o.ttlMs ?? 30 * 60_000;
    this.maxUses = o.maxUses ?? 5;
  }

  issue(user: string, channel: string): ResponseUrl {
    const id = hex(this.d.random(24));
    const r: ResponseUrl = { id, url: this.base + id, user, channel, expires: this.d.now() + this.ttlMs, uses: 0, delivered: [] };
    this.all.set(id, r);
    return r;
  }

  /** Deliver a reply to a response URL (`url` or its id). Refused when unknown, expired or used up. */
  post(url: string, reply: Reply): ResponseUrl {
    const id = url.startsWith(this.base) ? url.slice(this.base.length) : url;
    const r = this.all.get(id);
    if (!r) throw new SlashError('no such response URL');
    if (this.d.now() > r.expires) throw new SlashError('the response URL has expired');
    if (r.uses >= this.maxUses) throw new SlashError(`a response URL can be used ${this.maxUses} times`);
    replyJson(reply);
    r.uses += 1;
    r.delivered.push(reply);
    return r;
  }
}

// ---------------------------------------------------------------- signed callbacks

export interface ActionClaims {
  /** What the control does: the action id or a name for it. */
  readonly action: string;
  /** Who may press it; unset means anyone who can see the message. */
  readonly user?: string;
  readonly message?: string;
  readonly value?: string;
}

/** Tokens a button carries, so its meaning cannot be changed or reused by someone who can only see the message. */
export class ActionSigner {
  private readonly keys: readonly string[];
  private readonly d: Deps;
  private readonly spent = new Set<string>();

  /** More than one key while rotating: the first signs, all verify. */
  constructor(keys: readonly string[], d: Deps) {
    if (!keys.length || keys.some((k) => k.length < 16)) throw new SlashError('signing keys are at least 16 characters');
    this.keys = keys;
    this.d = d;
  }

  sign(c: ActionClaims, ttlSec = 3600): string {
    const payload = b64u(JSON.stringify({ ...c, exp: Math.floor(this.d.now() / 1000) + ttlSec, n: hex(this.d.random(8)) }));
    return `a1.${payload}.${b64u(createHmac('sha256', this.keys[0]!).update(`a1.${payload}`).digest())}`;
  }

  /** The claims, if the token is genuine, current and (when bound) pressed by the right user. `once` spends it. */
  verify(token: string, who: { user?: string; once?: boolean } = {}): ActionClaims {
    const m = /^a1\.([A-Za-z0-9_-]{1,8192})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) throw new BadToken('not an action token');
    const want = Buffer.from(m[2]!, 'base64url');
    if (!this.keys.some((k) => same(createHmac('sha256', k).update(`a1.${m[1]}`).digest(), want))) throw new BadToken('the token was not signed by us');
    const p = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as ActionClaims & { exp: number; n: string };
    if (Math.floor(this.d.now() / 1000) > p.exp) throw new BadToken('the token has expired');
    if (p.user !== undefined && p.user !== who.user) throw new BadToken('the token is for someone else');
    if (who.once) {
      if (this.spent.has(p.n)) throw new BadToken('the token was already used');
      this.spent.add(p.n);
    }
    const { exp: _e, n: _n, ...claims } = p;
    return claims;
  }
}

/** Interactive payloads between services: timestamped HMAC and replay protection come from the webhooks block. */
export class InteractiveReceiver {
  private readonly inbound: Inbound;

  constructor(secrets: readonly string[], o: { now?: () => number; toleranceSec?: number } = {}) {
    this.inbound = new Inbound(secrets, { ...(o.now ? { now: o.now } : {}), ...(o.toleranceSec !== undefined ? { toleranceSec: o.toleranceSec } : {}) });
  }

  /** Verify, then run the handler with the parsed payload; a failing handler leaves the delivery retryable. */
  receive<T>(body: string, signatureHeader: string | undefined, deliveryId: string | undefined, handler: (payload: Record<string, unknown>) => T | Promise<T>): Promise<T> {
    return this.inbound.receive(body, signatureHeader, deliveryId, () => {
      const payload: unknown = JSON.parse(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SlashError('an interactive payload is a JSON object');
      return handler(payload as Record<string, unknown>);
    });
  }
}

// ---------------------------------------------------------------- modals

export interface View {
  readonly type: 'modal';
  readonly title: string;
  readonly submit?: string;
  readonly close?: string;
  readonly callback_id: string;
  readonly blocks: readonly Block[];
  readonly private_metadata?: string;
}

export function viewProblems(v: View): string[] {
  const out = blockProblems(v.blocks, 100);
  if (v.type !== 'modal') out.push('only modals are supported');
  if (v.title.length === 0 || v.title.length > 24) out.push('the title is 1 to 24 characters');
  if (v.submit !== undefined && (v.submit.length === 0 || v.submit.length > 24)) out.push('the submit label is 1 to 24 characters');
  if (v.close !== undefined && v.close.length > 24) out.push('the close label is at most 24 characters');
  if (v.callback_id.length === 0 || v.callback_id.length > 255) out.push('callback_id is 1 to 255 characters');
  if ((v.private_metadata ?? '').length > 3000) out.push('private_metadata is at most 3000 characters');
  if (v.blocks.some((b) => b.type === 'input') && !v.submit) out.push('a modal with inputs needs a submit button');
  return out;
}

export type Values = Readonly<Record<string, Readonly<Record<string, string | readonly string[] | undefined>>>>;

export interface OpenView {
  readonly id: string;
  readonly user: string;
  readonly view: View;
  readonly hash: string;
}

export type SubmitResult = { readonly ok: true; readonly callback_id: string; readonly values: Values } | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** Modals: opened with a one-use trigger id, submitted by their user, validated by what their inputs declare. */
export class Modals {
  private readonly triggers = new Map<string, { user: string; expires: number }>();
  private readonly views = new Map<string, OpenView>();
  private readonly d: Deps;
  private readonly triggerMs: number;

  constructor(d: Deps, o: { triggerMs?: number } = {}) {
    this.d = d;
    this.triggerMs = o.triggerMs ?? 3000;
  }

  /** A trigger id for the user who just pressed something or ran a command. */
  trigger(user: string): string {
    const id = `${Math.floor(this.d.now())}.${hex(this.d.random(10))}`;
    this.triggers.set(id, { user, expires: this.d.now() + this.triggerMs });
    return id;
  }

  open(triggerId: string, user: string, view: View): OpenView {
    const t = this.triggers.get(triggerId);
    if (!t) throw new SlashError('unknown or already used trigger id');
    this.triggers.delete(triggerId);
    if (this.d.now() > t.expires) throw new SlashError('the trigger id has expired; a modal must open within three seconds');
    if (t.user !== user) throw new SlashError('the trigger id belongs to another user');
    const p = viewProblems(view);
    if (p.length) throw new SlashError(p.join('; '));
    const v: OpenView = { id: `V${hex(this.d.random(6)).toUpperCase()}`, user, view, hash: hex(sha256(JSON.stringify(view)).subarray(0, 8)) };
    this.views.set(v.id, v);
    return v;
  }

  /** Replace an open modal's content, only if the caller has the current hash (nobody's change is overwritten). */
  update(viewId: string, hash: string, view: View): OpenView {
    const v = this.views.get(viewId);
    if (!v) throw new SlashError('no such view');
    if (v.hash !== hash) throw new SlashError('the view changed since you read it');
    const p = viewProblems(view);
    if (p.length) throw new SlashError(p.join('; '));
    const n: OpenView = { ...v, view, hash: hex(sha256(JSON.stringify(view)).subarray(0, 8)) };
    this.views.set(viewId, n);
    return n;
  }

  /** Check a submission against the inputs. Unknown fields are refused; errors come back by block id. */
  submit(viewId: string, user: string, values: Values): SubmitResult {
    const v = this.views.get(viewId);
    if (!v) throw new SlashError('no such view');
    if (v.user !== user) throw new SlashError('this view was opened for someone else');
    const inputs = new Map(v.view.blocks.filter((b) => b.type === 'input').map((b) => [b.block_id!, b]));
    for (const [bid, fields] of Object.entries(values)) {
      const b = inputs.get(bid);
      if (!b) throw new SlashError(`unknown block ${bid}`);
      for (const aid of Object.keys(fields)) if (aid !== b.element!.action_id) throw new SlashError(`unknown field ${aid} in ${bid}`);
    }
    const errors: Record<string, string> = {};
    for (const [bid, b] of inputs) {
      const e = b.element!;
      const raw = values[bid]?.[e.action_id!];
      const empty = raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);
      if (empty) {
        if (!b.optional) errors[bid] = 'This field is required.';
        continue;
      }
      const list = Array.isArray(raw) ? (raw as readonly string[]) : [raw as string];
      if (e.type === 'plain_text_input') {
        const s = list[0]!;
        if (e.min_length !== undefined && s.length < e.min_length) errors[bid] = `Enter at least ${e.min_length} characters.`;
        else if (e.max_length !== undefined && s.length > e.max_length) errors[bid] = `Enter at most ${e.max_length} characters.`;
      } else if (e.type === 'static_select' || e.type === 'checkboxes') {
        const allowed = new Set((e.options ?? []).map((o) => o.value));
        if (list.some((x) => !allowed.has(x))) errors[bid] = 'Choose one of the options.';
        else if (e.type === 'static_select' && list.length > 1) errors[bid] = 'Choose one option.';
      } else if (e.type === 'datepicker') {
        const s = list[0]!;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) errors[bid] = 'Enter a real date.';
      }
    }
    if (Object.keys(errors).length) return { ok: false, errors };
    this.views.delete(viewId);
    return { ok: true, callback_id: v.view.callback_id, values };
  }
}

// ---------------------------------------------------------------- bot tokens

export interface BotRecord {
  readonly id: string;
  readonly bot: string;
  readonly scopes: readonly string[];
  readonly expires?: number;
  revoked: boolean;
}

/** Bot tokens: "zbot_" and random hex, shown once; only a hash is kept. */
export class BotTokens {
  private readonly byHash = new Map<string, BotRecord>();
  private readonly d: Deps;

  constructor(d: Deps) {
    this.d = d;
  }

  issue(bot: string, scopes: readonly string[], ttlMs?: number): { token: string; record: BotRecord } {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(bot)) throw new SlashError('a bot name is lower-case letters, digits, dash and underscore');
    if (scopes.some((s) => !/^[a-z]+(?::[a-z]+)*$/.test(s))) throw new SlashError('scopes look like chat:write');
    const token = `zbot_${hex(this.d.random(24))}`;
    const record: BotRecord = { id: hex(this.d.random(6)), bot, scopes: [...scopes], ...(ttlMs !== undefined ? { expires: this.d.now() + ttlMs } : {}), revoked: false };
    this.byHash.set(hex(sha256(token)), record);
    return { token, record };
  }

  /** The record behind a token, if it is genuine, not revoked, not expired and (when asked) holds the scope. */
  verify(token: string, scope?: string): BotRecord {
    if (!/^zbot_[0-9a-f]{48}$/.test(token)) throw new BadToken('not a bot token');
    const r = this.byHash.get(hex(sha256(token)));
    if (!r) throw new BadToken('unknown token');
    if (r.revoked) throw new BadToken('the token was revoked');
    if (r.expires !== undefined && this.d.now() > r.expires) throw new BadToken('the token has expired');
    if (scope !== undefined && !r.scopes.includes(scope)) throw new BadToken(`the token lacks the ${scope} scope`);
    return r;
  }

  revoke(id: string): void {
    for (const r of this.byHash.values()) if (r.id === id) r.revoked = true;
  }
}

// ---------------------------------------------------------------- the registry and dispatcher

export type ChannelKind = 'public' | 'private' | 'dm';

/** Who is in which channel: the small slice of a channels block this one needs. */
export interface Directory {
  kind(channel: string): ChannelKind | undefined;
  isMember(user: string, channel: string): boolean;
}

export class MemoryDirectory implements Directory {
  private readonly ch = new Map<string, { kind: ChannelKind; members: Set<string> }>();

  add(channel: string, kind: ChannelKind, members: readonly string[]): this {
    this.ch.set(channel, { kind, members: new Set(members) });
    return this;
  }

  kind(channel: string) {
    return this.ch.get(channel)?.kind;
  }

  isMember(user: string, channel: string) {
    return this.ch.get(channel)?.members.has(user) ?? false;
  }
}

export interface Context {
  readonly command: string;
  readonly args: readonly string[];
  readonly user: string;
  readonly channel: string;
  readonly team?: string;
  readonly responseUrl: string;
  readonly triggerId: string;
}

const LATER = Symbol('later');
export interface Later {
  readonly [LATER]: true;
  readonly work: Promise<Reply>;
}
/** Answer "working on it" now and the real reply later, by response URL. */
export const later = (work: Promise<Reply>): Later => ({ [LATER]: true, work });

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage?: string;
  readonly minArgs?: number;
  readonly maxArgs?: number;
  /** Channel kinds it may run in; default all. */
  readonly kinds?: readonly ChannelKind[];
  readonly allow?: (ctx: Context) => boolean;
  readonly run: (ctx: Context) => Reply | Later | void | Promise<Reply | Later | void>;
}

export interface HttpAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface DispatcherOptions extends Deps {
  readonly secrets: readonly string[];
  readonly directory: Directory;
  readonly responseUrls: ResponseUrls;
  readonly modals?: Modals;
  readonly toleranceSec?: number;
  readonly maxBody?: number;
}

export class Dispatcher {
  private readonly cmds = new Map<string, Command>();
  private readonly seen = new Map<string, number>();
  private readonly o: DispatcherOptions;
  /** Work started by `later`, so a caller (or a test) can wait for it. */
  readonly background: Promise<void>[] = [];

  constructor(o: DispatcherOptions) {
    this.o = o;
  }

  register(c: Command): this {
    if (!NAME.test(c.name)) throw new SlashError(`bad command name ${c.name}`);
    if (this.cmds.has(c.name)) throw new SlashError(`${c.name} is already registered`);
    if (c.summary.length === 0 || c.summary.length > 200) throw new SlashError('a summary is 1 to 200 characters');
    this.cmds.set(c.name, c);
    return this;
  }

  /** The commands a user in a channel may run, for a help command. */
  help(user: string, channel: string): { name: string; summary: string; usage?: string }[] {
    const kind = this.o.directory.kind(channel);
    return [...this.cmds.values()]
      .filter((c) => kind !== undefined && (!c.kinds || c.kinds.includes(kind)) && this.o.directory.isMember(user, channel))
      .map((c) => ({ name: c.name, summary: c.summary, ...(c.usage ? { usage: c.usage } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private answer(status: number, r: Reply | string): HttpAnswer {
    return typeof r === 'string' ? { status, contentType: 'text/plain', body: r } : { status, contentType: 'application/json', body: replyJson(r) };
  }

  async handle(req: { headers: Readonly<Record<string, string | undefined>>; body: string }): Promise<HttpAnswer> {
    if (req.body.length > (this.o.maxBody ?? 65_536)) return this.answer(413, 'request too large');
    try {
      verifyRequest(this.o.secrets, req.headers, req.body, { now: this.o.now, ...(this.o.toleranceSec !== undefined ? { toleranceSec: this.o.toleranceSec } : {}) });
    } catch (e) {
      return this.answer(401, (e as Error).message);
    }
    const nowSec = Math.floor(this.o.now() / 1000);
    for (const [k, t] of this.seen) if (nowSec - t > (this.o.toleranceSec ?? 300) * 2) this.seen.delete(k);
    const sig = req.headers['x-slack-signature']!;
    if (this.seen.has(sig)) return this.answer(401, 'this request was already received');
    this.seen.set(sig, nowSec);

    let f: Record<string, string>;
    try {
      f = parseForm(req.body);
    } catch (e) {
      return this.answer(400, (e as Error).message);
    }
    const user = f.user_id;
    const channel = f.channel_id;
    if (!f.command || !user || !channel) return this.answer(400, 'command, user_id and channel_id are required');
    const cmd = this.cmds.get(f.command);
    if (!cmd) return this.answer(200, { text: `Unknown command ${escapeMarkup(f.command.slice(0, 40))}. Try /help.` });
    const kind = this.o.directory.kind(channel);
    if (!kind || !this.o.directory.isMember(user, channel)) return this.answer(200, { text: `You need to be in this channel to use ${cmd.name}.` });
    if (cmd.kinds && !cmd.kinds.includes(kind)) return this.answer(200, { text: `${cmd.name} cannot be used in ${kind === 'dm' ? 'direct messages' : `${kind} channels`}.` });
    let args: string[];
    try {
      args = tokenize(f.text ?? '');
    } catch (e) {
      return this.answer(200, { text: `Could not read the arguments: ${escapeMarkup((e as Error).message)}` });
    }
    if (args.length < (cmd.minArgs ?? 0) || args.length > (cmd.maxArgs ?? 50)) return this.answer(200, { text: `Usage: ${cmd.usage ?? cmd.name}` });
    const url = this.o.responseUrls.issue(user, channel);
    const ctx: Context = { command: cmd.name, args, user, channel, ...(f.team_id ? { team: f.team_id } : {}), responseUrl: url.url, triggerId: this.o.modals ? this.o.modals.trigger(user) : '' };
    if (cmd.allow && !cmd.allow(ctx)) return this.answer(200, { text: `You are not allowed to use ${cmd.name}.` });
    let out: Reply | Later | void;
    try {
      out = await cmd.run(ctx);
    } catch {
      return this.answer(200, { text: `${cmd.name} failed. Nothing was changed by this request.` });
    }
    if (out && LATER in out) {
      this.background.push(out.work.then((r) => void this.o.responseUrls.post(url.url, r)).catch(() => void this.o.responseUrls.post(url.url, { text: `${cmd.name} failed.` })));
      return { status: 200, contentType: 'text/plain', body: '' };
    }
    return out ? this.answer(200, out) : { status: 200, contentType: 'text/plain', body: '' };
  }
}
