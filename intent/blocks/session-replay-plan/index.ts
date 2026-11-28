/**
 * Session replay plan: what a browser recorder may capture, what it must mask before anything leaves the page, how
 * much it samples, and where recordings live as they age.
 *
 * The event model follows the rrweb convention most replay tools share: a Meta event (page address and size), a
 * FullSnapshot (the page as a tree of nodes with ids), and Incremental events (DOM mutations by node id, mouse
 * moves and clicks, scrolls, resizes, and input). Custom events carry app markers.
 *
 * Masking happens in the recorder, before upload, in `Redactor`, which keeps the state of every node it has seen so
 * later events about a node id are masked as the node was:
 *  - text is masked (every character but white space becomes `*`, length kept) inside elements that match `maskSelectors`, and
 *    everywhere when `maskAllText` is set, except inside `unmaskSelectors`;
 *  - inputs are masked by default: password, email, tel, number, search and card fields (`autocomplete="cc-*"`), any
 *    input when `maskAllInputs` is set, and anything in `maskSelectors`; `ignoreSelectors` inputs record nothing at all;
 *  - `blockSelectors` elements keep their place but lose their content and attributes, as a grey box;
 *  - event handler attributes, `srcdoc`, large `data:` URLs and tokens in URL queries (`scrubParams`) are always removed;
 *  - unmasked text is also scrubbed for e-mail addresses, card numbers (checked with Luhn), US social security
 *    numbers and long digit runs that look like phone numbers;
 *  - page rules can pause recording on a page (login, checkout) or mask all text on it (account, billing).
 * Selectors are a small subset: tag, `.class`, `#id`, `[attr]`, `[attr=value]`, `[attr^=value]`, compound, with
 * descendant (space) and child (`>`) combinators, and commas. Anything else is refused when the plan is built.
 *
 * Sampling is deterministic by session id so a session is wholly in or out, and honours consent, Do Not Track and
 * Global Privacy Control. A rolling buffer lets a session that was not sampled be kept after an error. Storage
 * moves a recording through hot, warm and cold tiers by age and then deletes it, unless starred, linked to a ticket
 * or under a legal hold; `projectStorage` turns rates into bytes.
 *
 * Out of scope: the browser-side recorder code itself, playback, and compression (chunks are planned, not encoded).
 */
import { createHash } from 'node:crypto';

export class ReplayPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayPlanError';
  }
}

export const EventType = { FullSnapshot: 2, Incremental: 3, Meta: 4, Custom: 5 } as const;
export const Source = { Mutation: 0, MouseMove: 1, MouseInteraction: 2, Scroll: 3, ViewportResize: 4, Input: 5 } as const;

export interface SNode {
  readonly id: number;
  readonly type: 'document' | 'element' | 'text';
  readonly tag?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly children?: readonly SNode[];
}

export type Incremental =
  | { readonly source: 0; readonly texts?: readonly { id: number; value: string }[]; readonly attributes?: readonly { id: number; attributes: Readonly<Record<string, string | null>> }[]; readonly removes?: readonly { parentId: number; id: number }[]; readonly adds?: readonly { parentId: number; node: SNode }[] }
  | { readonly source: 1; readonly positions: readonly { x: number; y: number; id: number; timeOffset: number }[] }
  | { readonly source: 2; readonly type: number; readonly id: number; readonly x?: number; readonly y?: number }
  | { readonly source: 3; readonly id: number; readonly x: number; readonly y: number }
  | { readonly source: 4; readonly width: number; readonly height: number }
  | { readonly source: 5; readonly id: number; readonly text: string; readonly isChecked?: boolean };

export type ReplayEvent =
  | { readonly type: 4; readonly ts: number; readonly data: { readonly href: string; readonly width: number; readonly height: number } }
  | { readonly type: 2; readonly ts: number; readonly data: { readonly node: SNode } }
  | { readonly type: 3; readonly ts: number; readonly data: Incremental }
  | { readonly type: 5; readonly ts: number; readonly data: { readonly tag: string; readonly payload?: unknown } };

// ---------------------------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------------------------

interface Simple {
  readonly tag: string | undefined;
  readonly id: string | undefined;
  readonly classes: string[];
  readonly attrs: { name: string; op: '' | '=' | '^=' | '$=' | '*='; value: string }[];
}
interface Compound {
  readonly parts: { simple: Simple; combinator: ' ' | '>' | '' }[];
}

function parseSimple(src: string): Simple {
  const re = /^(?:([A-Za-z][A-Za-z0-9-]*|\*))?((?:[.#][A-Za-z0-9_-]+|\[[^\]]+\])*)$/;
  const m = re.exec(src);
  if (!m) throw new ReplayPlanError(`unsupported selector ${JSON.stringify(src)}`);
  const classes: string[] = [];
  const attrs: Simple['attrs'] = [];
  let id: string | undefined;
  for (const t of (m[2] ?? '').matchAll(/([.#])([A-Za-z0-9_-]+)|\[([A-Za-z_:][A-Za-z0-9_:.-]*)(?:([\^$*]?=)"?([^\]"]*)"?)?\]/g)) {
    if (t[1] === '.') classes.push(t[2]!);
    else if (t[1] === '#') id = t[2]!;
    else attrs.push({ name: t[3]!.toLowerCase(), op: (t[4] ?? '') as Simple['attrs'][number]['op'], value: t[5] ?? '' });
  }
  const tag = m[1] && m[1] !== '*' ? m[1].toLowerCase() : undefined;
  if (tag === undefined && id === undefined && classes.length === 0 && attrs.length === 0 && src !== '*') throw new ReplayPlanError(`unsupported selector ${JSON.stringify(src)}`);
  return { tag, id, classes, attrs };
}

/** Parse a comma-separated selector list into matchers; throws ReplayPlanError for syntax outside the subset. */
export function parseSelectors(list: readonly string[]): Compound[] {
  const out: Compound[] = [];
  for (const s of list) {
    for (const one of s.split(',')) {
      const t = one.trim();
      if (t === '') throw new ReplayPlanError('an empty selector');
      if (t.length > 200) throw new ReplayPlanError('a selector over 200 characters');
      const tokens = t.replace(/\s*>\s*/g, ' > ').split(/\s+/);
      const parts: Compound['parts'] = [];
      let comb: ' ' | '>' | '' = '';
      for (const tok of tokens) {
        if (tok === '>') {
          comb = '>';
          continue;
        }
        parts.push({ simple: parseSimple(tok), combinator: parts.length === 0 ? '' : comb === '>' ? '>' : ' ' });
        comb = ' ';
      }
      out.push({ parts });
    }
  }
  return out;
}

interface NodeInfo {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly parent: number | undefined;
}

function simpleMatches(s: Simple, n: NodeInfo): boolean {
  if (s.tag !== undefined && s.tag !== n.tag) return false;
  if (s.id !== undefined && n.attrs['id'] !== s.id) return false;
  if (s.classes.length) {
    const have = (n.attrs['class'] ?? '').split(/\s+/);
    if (!s.classes.every((c) => have.includes(c))) return false;
  }
  for (const a of s.attrs) {
    const v = n.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
  }
  return true;
}

function matchAt(c: Compound, i: number, id: number, info: Map<number, NodeInfo>): boolean {
  const n = info.get(id);
  if (!n || !simpleMatches(c.parts[i]!.simple, n)) return false;
  if (i === 0) return true;
  const comb = c.parts[i]!.combinator;
  let p = n.parent;
  if (comb === '>') return p !== undefined && matchAt(c, i - 1, p, info);
  while (p !== undefined) {
    if (matchAt(c, i - 1, p, info)) return true;
    p = info.get(p)?.parent;
  }
  return false;
}

const matchesAny = (list: readonly Compound[], id: number, info: Map<number, NodeInfo>): boolean => list.some((c) => matchAt(c, c.parts.length - 1, id, info));

// ---------------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------------

export interface PageRule {
  /** Glob on the URL path (`*` within a segment, `**` across segments), or `re:` followed by a regular expression. */
  readonly match: string;
  readonly action: 'record' | 'pause' | 'mask-all';
}

export interface MaskPlan {
  readonly maskSelectors?: readonly string[];
  readonly unmaskSelectors?: readonly string[];
  readonly blockSelectors?: readonly string[];
  readonly ignoreSelectors?: readonly string[];
  readonly maskAllText?: boolean;
  readonly maskAllInputs?: boolean;
  /** Query parameter names whose values are replaced in URLs. */
  readonly scrubParams?: readonly string[];
  readonly pages?: readonly PageRule[];
  /** Scrub e-mail, card, SSN and phone shapes from unmasked text. Default true. */
  readonly scrubPatterns?: boolean;
}

const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel', 'number', 'search']);
export const DEFAULT_SCRUB_PARAMS = ['token', 'access_token', 'id_token', 'auth', 'key', 'api_key', 'apikey', 'password', 'secret', 'session', 'sid', 'code', 'signature', 'sig'];

const maskString = (s: string): string => s.replace(/[^\s]/gu, '*');

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Remove personal data shapes from free text: e-mail, card numbers that pass Luhn, US SSNs, phone-like digit runs. */
export function scrubText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[card]' : m))
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]')
    .replace(/(?<![\w-])\+?\d[\d ().-]{8,}\d(?![\w-])/g, (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 10 && n <= 15 ? '[phone]' : m;
    });
}

/** A URL with the values of sensitive query parameters (and any fragment secrets) replaced. */
export function scrubUrl(url: string, params: readonly string[] = DEFAULT_SCRUB_PARAMS): string {
  let u: URL;
  try {
    u = new URL(url, 'https://placeholder.invalid');
  } catch {
    return '[url]';
  }
  const rel = !/^[a-z][a-z0-9+.-]*:/i.test(url);
  if (u.username || u.password) {
    u.username = '';
    u.password = '';
  }
  const names = new Set(params.map((p) => p.toLowerCase()));
  for (const k of [...u.searchParams.keys()]) if (names.has(k.toLowerCase())) u.searchParams.set(k, '[redacted]');
  if (u.hash && /(?:^|[#&?])(?:access_token|id_token|token|code)=/i.test(u.hash)) u.hash = '#[redacted]';
  return rel ? `${u.pathname}${u.search}${u.hash}` : u.href;
}

const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);

function compileRules(rules: readonly PageRule[]): { re: RegExp; action: PageRule['action'] }[] {
  return rules.map((r) => {
    if (r.match.startsWith('re:')) {
      const src = r.match.slice(3);
      if (src.length > 200 || /\([^()]*[+*][^()]*\)[+*{]/.test(src)) throw new ReplayPlanError('a page rule regex that is too long or could run for ever');
      try {
        return { re: new RegExp(src), action: r.action };
      } catch {
        throw new ReplayPlanError('a page rule regex that does not compile');
      }
    }
    return { re: globRe(r.match), action: r.action };
  });
}

export interface RedactStats {
  masked: number;
  blocked: number;
  dropped: number;
  scrubbed: number;
}

export class Redactor {
  readonly #plan: MaskPlan;
  readonly #mask: Compound[];
  readonly #unmask: Compound[];
  readonly #block: Compound[];
  readonly #ignore: Compound[];
  readonly #rules: { re: RegExp; action: PageRule['action'] }[];
  readonly #info = new Map<number, NodeInfo>();
  readonly #state = new Map<number, { mask: boolean; block: boolean; ignore: boolean; input: boolean; unmask: boolean }>();
  #page: PageRule['action'] = 'record';
  readonly stats: RedactStats = { masked: 0, blocked: 0, dropped: 0, scrubbed: 0 };

  constructor(plan: MaskPlan) {
    this.#plan = plan;
    this.#mask = parseSelectors(plan.maskSelectors ?? []);
    this.#unmask = parseSelectors(plan.unmaskSelectors ?? []);
    this.#block = parseSelectors(plan.blockSelectors ?? []);
    this.#ignore = parseSelectors(plan.ignoreSelectors ?? []);
    this.#rules = compileRules(plan.pages ?? []);
  }

  get paused(): boolean {
    return this.#page === 'pause';
  }

  #scrub(text: string): string {
    if (this.#plan.scrubPatterns === false) return text;
    const out = scrubText(text);
    if (out !== text) this.stats.scrubbed++;
    return out;
  }

  #inherit(parent: number | undefined) {
    return parent === undefined ? { mask: false, block: false, ignore: false, input: false, unmask: false } : (this.#state.get(parent) ?? { mask: false, block: false, ignore: false, input: false, unmask: false });
  }

  #isSensitiveInput(tag: string, attrs: Readonly<Record<string, string>>): boolean {
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    const type = (attrs['type'] ?? 'text').toLowerCase();
    if (SENSITIVE_INPUT_TYPES.has(type)) return true;
    if ((attrs['autocomplete'] ?? '').toLowerCase().startsWith('cc-')) return true;
    return this.#plan.maskAllInputs === true;
  }

  /** Descendants of a blocked element are never sent, but events that name them must still be recognised and dropped. */
  #registerBlocked(n: SNode): void {
    for (const c of n.children ?? []) {
      this.#info.set(c.id, { tag: (c.tag ?? '#text').toLowerCase(), attrs: {}, parent: n.id });
      this.#state.set(c.id, { mask: true, block: true, ignore: true, input: false, unmask: false });
      this.#registerBlocked(c);
    }
  }

  #node(n: SNode, parent: number | undefined): SNode {
    if (n.type === 'text') {
      const st = this.#inherit(parent);
      this.#state.set(n.id, st);
      this.#info.set(n.id, { tag: '#text', attrs: {}, parent });
      if (st.block) return { id: n.id, type: 'text', text: '' };
      const t = n.text ?? '';
      const parentTag = parent === undefined ? '' : (this.#info.get(parent)?.tag ?? '');
      if (parentTag === 'script' || parentTag === 'style') return { id: n.id, type: 'text', text: '' };
      if (st.mask) {
        this.stats.masked++;
        return { id: n.id, type: 'text', text: maskString(t) };
      }
      return { id: n.id, type: 'text', text: this.#scrub(t) };
    }
    const tag = (n.tag ?? '').toLowerCase();
    const attrs = n.attrs ?? {};
    this.#info.set(n.id, { tag, attrs, parent });
    const inherited = this.#inherit(parent);
    const unmask = inherited.unmask || (this.#unmask.length > 0 && matchesAny(this.#unmask, n.id, this.#info));
    const explicitMask = matchesAny(this.#mask, n.id, this.#info);
    const maskAll = this.#plan.maskAllText === true || this.#page === 'mask-all';
    const st = {
      mask: explicitMask || (!unmask && (inherited.mask || maskAll)),
      block: inherited.block || matchesAny(this.#block, n.id, this.#info),
      ignore: inherited.ignore || matchesAny(this.#ignore, n.id, this.#info),
      input: this.#isSensitiveInput(tag, attrs),
      unmask: unmask && !explicitMask,
    };
    this.#state.set(n.id, st);
    if (st.block) {
      this.stats.blocked++;
      this.#registerBlocked(n);
      const keep: Record<string, string> = { 'data-replay-blocked': 'true' };
      for (const k of ['width', 'height']) if (attrs[k] !== undefined) keep[k] = attrs[k]!;
      const stub: SNode = { id: n.id, type: 'element', tag, attrs: keep, children: [] };
      return stub;
    }
    const out: Record<string, string> = {};
    for (const [k0, v] of Object.entries(attrs)) {
      const k = k0.toLowerCase();
      if (k.startsWith('on') || k === 'srcdoc') continue;
      if ((k === 'href' || k === 'src' || k === 'action' || k === 'poster') && typeof v === 'string') {
        if (/^data:/i.test(v) && v.length > 2048) continue;
        if (/^javascript:/i.test(v)) continue;
        out[k] = /^data:/i.test(v) ? v : scrubUrl(v, this.#plan.scrubParams ?? DEFAULT_SCRUB_PARAMS);
        continue;
      }
      if (k === 'value' || (k === 'placeholder' && st.mask)) {
        out[k] = st.input || st.mask || st.ignore ? maskString(v) : this.#scrub(v);
        if (out[k] !== v) this.stats.masked++;
        continue;
      }
      if ((k === 'alt' || k === 'title' || k === 'aria-label') && st.mask) {
        out[k] = maskString(v);
        this.stats.masked++;
        continue;
      }
      out[k] = v;
    }
    const children = (n.children ?? []).map((c) => this.#node(c, n.id));
    return { id: n.id, type: n.type, ...(n.tag !== undefined ? { tag: n.tag } : {}), attrs: out, children };
  }

  /** Redact one event. Returns undefined when the event must not leave the page. */
  event(e: ReplayEvent): ReplayEvent | undefined {
    if (e.type === 4) {
      const path = (() => {
        try {
          return new URL(e.data.href, 'https://placeholder.invalid').pathname;
        } catch {
          return '/';
        }
      })();
      this.#page = this.#rules.find((r) => r.re.test(path))?.action ?? 'record';
      return { type: 4, ts: e.ts, data: { ...e.data, href: scrubUrl(e.data.href, this.#plan.scrubParams ?? DEFAULT_SCRUB_PARAMS) } };
    }
    if (this.#page === 'pause') {
      this.stats.dropped++;
      return undefined;
    }
    if (e.type === 5) return e;
    if (e.type === 2) {
      this.#info.clear();
      this.#state.clear();
      return { type: 2, ts: e.ts, data: { node: this.#node(e.data.node, undefined) } };
    }
    const d = e.data;
    switch (d.source) {
      case 0: {
        const texts = (d.texts ?? []).map((t) => {
          const st = this.#state.get(t.id);
          if (st?.block) return { id: t.id, value: '' };
          if (st?.mask) {
            this.stats.masked++;
            return { id: t.id, value: maskString(t.value) };
          }
          return { id: t.id, value: this.#scrub(t.value) };
        });
        const attributes = (d.attributes ?? []).map((a) => {
          const st = this.#state.get(a.id);
          const out: Record<string, string | null> = {};
          for (const [k0, v] of Object.entries(a.attributes)) {
            const k = k0.toLowerCase();
            if (k.startsWith('on') || k === 'srcdoc' || st?.block) continue;
            if (v === null) out[k] = null;
            else if (k === 'value') out[k] = st?.input || st?.mask || st?.ignore ? maskString(v) : this.#scrub(v);
            else if (k === 'href' || k === 'src') out[k] = /^javascript:/i.test(v) ? '' : scrubUrl(v, this.#plan.scrubParams ?? DEFAULT_SCRUB_PARAMS);
            else out[k] = v;
          }
          return { id: a.id, attributes: out };
        });
        for (const r of d.removes ?? []) {
          this.#state.delete(r.id);
          this.#info.delete(r.id);
        }
        const adds = (d.adds ?? []).map((a) => ({ parentId: a.parentId, node: this.#node(a.node, a.parentId) }));
        return { type: 3, ts: e.ts, data: { source: 0, texts, attributes, removes: d.removes ?? [], adds } };
      }
      case 5: {
        const st = this.#state.get(d.id);
        if (st?.ignore) {
          this.stats.dropped++;
          return undefined;
        }
        if (st?.block) {
          this.stats.dropped++;
          return undefined;
        }
        if (st?.input || st?.mask) {
          this.stats.masked++;
          return { type: 3, ts: e.ts, data: { ...d, text: maskString(d.text) } };
        }
        return { type: 3, ts: e.ts, data: { ...d, text: this.#scrub(d.text) } };
      }
      default:
        return e;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sampling and consent
// ---------------------------------------------------------------------------------------------------------------

export interface SamplingPlan {
  /** Share of sessions recorded, 0 to 1. */
  readonly rate: number;
  /** Always record sessions whose user id is listed. */
  readonly forceUsers?: readonly string[];
  /** Never record sessions from these regions (country codes). */
  readonly excludeRegions?: readonly string[];
  /** Record only when the user has given consent. Default true. */
  readonly requireConsent?: boolean;
  /** Respect Do Not Track and Global Privacy Control. Default true. */
  readonly respectSignals?: boolean;
  /** Keep a rolling window of this many ms of a session that was not sampled, for an error to rescue. 0 turns it off. */
  readonly errorWindowMs?: number;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly userId?: string;
  readonly consent: 'granted' | 'denied' | 'unknown';
  readonly doNotTrack?: boolean;
  readonly globalPrivacyControl?: boolean;
  readonly region?: string;
}

export interface RecordDecision {
  readonly record: boolean;
  /** True when not recording now but the error buffer may keep a window if an error follows. */
  readonly buffer: boolean;
  readonly reason: string;
}

/** A stable number in [0, 1) for a session id, so the same session always gets the same answer. */
export function sessionBucket(sessionId: string): number {
  const h = createHash('sha256').update(sessionId).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

export function decideRecording(plan: SamplingPlan, ctx: SessionContext): RecordDecision {
  if (!(plan.rate >= 0 && plan.rate <= 1)) throw new ReplayPlanError('the sampling rate is from 0 to 1');
  if ((plan.requireConsent ?? true) && ctx.consent !== 'granted') return { record: false, buffer: false, reason: ctx.consent === 'denied' ? 'consent denied' : 'no consent given' };
  if ((plan.respectSignals ?? true) && (ctx.doNotTrack || ctx.globalPrivacyControl)) return { record: false, buffer: false, reason: ctx.globalPrivacyControl ? 'Global Privacy Control' : 'Do Not Track' };
  if (ctx.region && plan.excludeRegions?.includes(ctx.region)) return { record: false, buffer: false, reason: `region ${ctx.region} excluded` };
  if (ctx.userId && plan.forceUsers?.includes(ctx.userId)) return { record: true, buffer: false, reason: 'user always recorded' };
  if (sessionBucket(ctx.sessionId) < plan.rate) return { record: true, buffer: false, reason: 'sampled in' };
  return { record: false, buffer: (plan.errorWindowMs ?? 0) > 0, reason: 'sampled out' };
}

/**
 * The last `windowMs` of events, held in memory until an error says to keep them. Events are kept in segments that
 * each begin at a full snapshot (the recorder takes one every so often), and a segment is dropped only when the next
 * one already covers the window, so what `flush` returns always starts at a snapshot and plays back correctly.
 */
export class RollingBuffer {
  readonly windowMs: number;
  readonly maxEvents: number;
  readonly #segments: ReplayEvent[][] = [[]];
  #meta: ReplayEvent | undefined;
  #count = 0;
  constructor(windowMs: number, maxEvents = 5000) {
    if (!(windowMs > 0)) throw new ReplayPlanError('the window must be more than 0 ms');
    this.windowMs = windowMs;
    this.maxEvents = maxEvents;
  }
  push(e: ReplayEvent): void {
    if (e.type === 4) this.#meta = e;
    if (e.type === 2 && this.#segments[this.#segments.length - 1]!.length > 0) this.#segments.push([]);
    this.#segments[this.#segments.length - 1]!.push(e);
    this.#count++;
    const cutoff = e.ts - this.windowMs;
    while (this.#segments.length > 1 && (this.#segments[1]![0]!.ts <= cutoff || this.#count > this.maxEvents)) this.#count -= this.#segments.shift()!.length;
  }
  /** The window to keep, from a snapshot on, with the latest page address first if it fell outside. */
  flush(): ReplayEvent[] {
    const all = this.#segments.flat();
    return this.#meta && !all.includes(this.#meta) ? [this.#meta, ...all] : all;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Session limits and chunking
// ---------------------------------------------------------------------------------------------------------------

export const eventBytes = (e: ReplayEvent): number => Buffer.byteLength(JSON.stringify(e));

export interface SessionLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  /** A session shorter than this is thrown away at the end. */
  readonly minDurationMs: number;
}

export interface Chunk {
  readonly index: number;
  readonly events: ReplayEvent[];
  readonly bytes: number;
  readonly startTs: number;
  readonly endTs: number;
  /** True when the chunk begins with a full snapshot, so playback can start from it. */
  readonly seekable: boolean;
}

/**
 * Split a session into upload chunks of at most `maxEvents` events and `maxBytes`. A chunk is cut early at each
 * full snapshot (a checkpoint) so every chunk that follows one starts with it and can be played on its own.
 */
export function chunkSession(events: readonly ReplayEvent[], o: { maxEvents: number; maxBytes: number }): Chunk[] {
  if (o.maxEvents < 1 || o.maxBytes < 1) throw new ReplayPlanError('chunks need room for at least one event');
  const chunks: Chunk[] = [];
  let cur: ReplayEvent[] = [];
  let bytes = 0;
  const close = () => {
    if (cur.length === 0) return;
    chunks.push({ index: chunks.length, events: cur, bytes, startTs: cur[0]!.ts, endTs: cur[cur.length - 1]!.ts, seekable: cur[0]!.type === 2 || cur.some((e) => e.type === 2) });
    cur = [];
    bytes = 0;
  };
  for (const e of events) {
    const b = eventBytes(e);
    if (e.type === 2) close();
    else if (cur.length >= o.maxEvents || (bytes + b > o.maxBytes && cur.length > 0)) close();
    cur.push(e);
    bytes += b;
  }
  close();
  return chunks;
}

export type Accepted = { readonly ok: true; readonly event: ReplayEvent } | { readonly ok: false; readonly reason: 'paused' | 'dropped' | 'limit-events' | 'limit-bytes' | 'limit-duration' | 'stopped' };

/** One session's recording: redact, enforce the limits, keep the events, and decide at the end whether to keep them. */
export class SessionRecorder {
  readonly redactor: Redactor;
  readonly #events: ReplayEvent[] = [];
  readonly #limits: SessionLimits;
  #bytes = 0;
  #first: number | undefined;
  #stopped: string | undefined;

  constructor(mask: MaskPlan, limits: SessionLimits) {
    this.redactor = new Redactor(mask);
    this.#limits = limits;
  }

  accept(e: ReplayEvent): Accepted {
    if (this.#stopped) return { ok: false, reason: 'stopped' };
    const r = this.redactor.event(e);
    if (!r) return { ok: false, reason: this.redactor.paused ? 'paused' : 'dropped' };
    this.#first ??= r.ts;
    const b = eventBytes(r);
    const stop = (reason: 'limit-events' | 'limit-bytes' | 'limit-duration'): Accepted => {
      this.#stopped = reason;
      return { ok: false, reason };
    };
    if (r.ts - this.#first > this.#limits.maxDurationMs) return stop('limit-duration');
    if (this.#events.length + 1 > this.#limits.maxEvents) return stop('limit-events');
    if (this.#bytes + b > this.#limits.maxBytes) return stop('limit-bytes');
    this.#events.push(r);
    this.#bytes += b;
    return { ok: true, event: r };
  }

  get bytes(): number {
    return this.#bytes;
  }

  get stoppedBecause(): string | undefined {
    return this.#stopped;
  }

  /** End the session: too short means discard; otherwise the events come back for upload. */
  close(hadError = false): { keep: boolean; reason: string; events: ReplayEvent[]; durationMs: number } {
    const dur = this.#events.length ? this.#events[this.#events.length - 1]!.ts - this.#events[0]!.ts : 0;
    if (this.#events.length === 0) return { keep: false, reason: 'no events', events: [], durationMs: 0 };
    if (dur < this.#limits.minDurationMs && !hadError) return { keep: false, reason: 'shorter than the minimum', events: [], durationMs: dur };
    return { keep: true, reason: this.#stopped ? `kept up to the ${this.#stopped}` : 'kept', events: this.#events, durationMs: dur };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Storage tiers
// ---------------------------------------------------------------------------------------------------------------

export type Tier = 'hot' | 'warm' | 'cold' | 'deleted';

export interface TierPlan {
  /** Days a recording stays in each tier; after `coldDays` in total it is deleted. */
  readonly hotDays: number;
  readonly warmDays: number;
  readonly coldDays: number;
  /** Starred and error sessions live this many times longer. Default 3. */
  readonly keepFactor?: number;
}

export interface StoredSession {
  readonly id: string;
  readonly createdAt: number;
  readonly bytes: number;
  readonly starred?: boolean;
  readonly hadError?: boolean;
  readonly ticket?: string;
  readonly legalHold?: boolean;
  readonly tier: Tier;
}

export interface TierAction {
  readonly id: string;
  readonly from: Tier;
  readonly to: Tier;
  readonly reason: string;
}

const DAY = 86_400_000;

export function tierFor(s: StoredSession, p: TierPlan, now: number): { tier: Tier; reason: string } {
  if (!(p.hotDays > 0 && p.warmDays >= p.hotDays && p.coldDays >= p.warmDays)) throw new ReplayPlanError('tier days must grow: 0 < hot <= warm <= cold');
  const age = (now - s.createdAt) / DAY;
  const factor = s.starred || s.hadError ? (p.keepFactor ?? 3) : 1;
  const pin = s.legalHold ? 'legal hold' : s.ticket ? `linked to ${s.ticket}` : undefined;
  if (age < p.hotDays * factor) return { tier: 'hot', reason: 'young' };
  if (age < p.warmDays * factor) return { tier: 'warm', reason: 'aged past hot' };
  if (age < p.coldDays * factor || pin) return { tier: 'cold', reason: pin ? `kept: ${pin}` : 'aged past warm' };
  return { tier: 'deleted', reason: 'past retention' };
}

/** What to do with a set of recordings now. Recordings never move to a warmer tier, and a legal hold is never deleted. */
export function sweep(sessions: readonly StoredSession[], p: TierPlan, now: number): TierAction[] {
  const order: Tier[] = ['hot', 'warm', 'cold', 'deleted'];
  const out: TierAction[] = [];
  for (const s of sessions) {
    const t = tierFor(s, p, now);
    if (s.legalHold && t.tier === 'deleted') continue;
    if (order.indexOf(t.tier) > order.indexOf(s.tier)) out.push({ id: s.id, from: s.tier, to: t.tier, reason: t.reason });
  }
  return out;
}

export interface Projection {
  readonly hotBytes: number;
  readonly warmBytes: number;
  readonly coldBytes: number;
  readonly totalBytes: number;
}

/** Steady-state storage for a recording rate: sessions a day, share sampled, mean bytes, and the days in each tier. */
export function projectStorage(o: { sessionsPerDay: number; sampleRate: number; meanBytes: number; plan: TierPlan }): Projection {
  const perDay = o.sessionsPerDay * o.sampleRate * o.meanBytes;
  const hot = perDay * o.plan.hotDays;
  const warm = perDay * (o.plan.warmDays - o.plan.hotDays);
  const cold = perDay * (o.plan.coldDays - o.plan.warmDays);
  return { hotBytes: Math.round(hot), warmBytes: Math.round(warm), coldBytes: Math.round(cold), totalBytes: Math.round(hot + warm + cold) };
}
