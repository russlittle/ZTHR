/**
 * Token counting for budgets and truncation, across model vendors, without shipping any vendor's tokenizer.
 *
 * Three honest levels:
 *  - `upperBound`: the UTF-8 byte length. No byte-level BPE tokenizer emits more tokens than bytes, so this is a
 *    ceiling that is never exceeded; use it when overrunning a context window is worse than wasting some of it.
 *  - `estimate`: a BPE-free estimate from a vendor table (`VENDORS`): words cost by length, digits by groups,
 *    punctuation and line breaks by run, CJK by character, other scripts and emoji by bytes. The tables are
 *    approximations written down in one place, and `safetyMargin` pads them; they are not a vendor's own count.
 *  - `BpeTokenizer`: the exact algorithm of byte-level BPE (the scheme behind tiktoken and GPT-2 style tokenizers)
 *    over a vocabulary you supply, in tiktoken's text format (`base64 rank` per line) through `parseTiktokenRanks`,
 *    with special tokens and a pre-tokenising pattern. With a vendor's real vocabulary its counts are that vendor's
 *    counts; this block bundles no vocabulary.
 *
 * Truncation (`truncate`) keeps the head, the tail or both ends of a text within a token budget, never splits a
 * character, and can snap to a word, sentence or paragraph. `fitMessages` drops the oldest turns of a conversation
 * first, keeps system messages and the latest message, and shortens that last message only when it must.
 *
 * Out of scope: image, audio and tool-schema token costs, which vendors change often; add them to `perMessage`.
 */

export class TokenCountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCountError';
  }
}

export type Counter = (text: string) => number;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

/** The most tokens a byte-level BPE tokenizer could emit for the text: one per UTF-8 byte. */
export const upperBound: Counter = (text) => enc.encode(text).length;

export interface VendorProfile {
  readonly id: string;
  /** Letters per token inside a word: a word of n letters costs ceil(n / wordChars). */
  readonly wordChars: number;
  /** Digits per token. */
  readonly digitGroup: number;
  /** Tokens per CJK character. */
  readonly cjk: number;
  /** UTF-8 bytes per token for everything else (other scripts, emoji, symbols). */
  readonly otherBytesPerToken: number;
  /** Tokens added around each chat message by the vendor's chat format. */
  readonly perMessage: number;
  /** Tokens added once to prime the reply. */
  readonly perReply: number;
  /** Largest context window of the vendor's flagship family, in tokens; a ceiling to check budgets against. */
  readonly contextWindow: number;
}

/** Approximate tables. Each vendor's exact numbers differ by model and change; verify against usage reports. */
export const VENDORS: Readonly<Record<string, VendorProfile>> = {
  'openai-o200k': { id: 'openai-o200k', wordChars: 5.5, digitGroup: 3, cjk: 0.8, otherBytesPerToken: 2.5, perMessage: 3, perReply: 3, contextWindow: 200_000 },
  'openai-cl100k': { id: 'openai-cl100k', wordChars: 5, digitGroup: 3, cjk: 1.2, otherBytesPerToken: 2, perMessage: 3, perReply: 3, contextWindow: 128_000 },
  anthropic: { id: 'anthropic', wordChars: 4.5, digitGroup: 2.5, cjk: 1.3, otherBytesPerToken: 2, perMessage: 4, perReply: 2, contextWindow: 200_000 },
  gemini: { id: 'gemini', wordChars: 5, digitGroup: 1, cjk: 0.9, otherBytesPerToken: 2.5, perMessage: 2, perReply: 0, contextWindow: 1_000_000 },
  llama3: { id: 'llama3', wordChars: 5, digitGroup: 3, cjk: 1, otherBytesPerToken: 2.5, perMessage: 4, perReply: 3, contextWindow: 128_000 },
  generic: { id: 'generic', wordChars: 4, digitGroup: 2, cjk: 1.5, otherBytesPerToken: 1.5, perMessage: 4, perReply: 3, contextWindow: 32_000 },
};

const CJK = /[⺀-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯\u{20000}-\u{2FA1F}]/u;
const TOKEN_RE = /(\p{L}[\p{L}\p{M}'’]*)|(\p{N}+)|(\r?\n[\r\n\s]*)|([ \t]+)|(\p{P}+|[$+<=>^`|~]+)|(\S)/gu;

export interface EstimateOptions {
  /** Extra fraction added on top, e.g. 0.1 for ten per cent. */
  readonly safetyMargin?: number;
}

function profileOf(v: string | VendorProfile): VendorProfile {
  if (typeof v !== 'string') return v;
  const p = VENDORS[v];
  if (!p) throw new TokenCountError(`no vendor table for ${JSON.stringify(v)}; known: ${Object.keys(VENDORS).join(', ')}`);
  return p;
}

/** A BPE-free estimate of the tokens in a text, never more than the byte bound and never less than 1 for non-empty text. */
export function estimate(text: string, vendor: string | VendorProfile = 'generic', o: EstimateOptions = {}): number {
  if (text === '') return 0;
  const p = profileOf(vendor);
  let total = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const s = m[0];
    if (m[1] !== undefined) {
      let latin = 0;
      let other = 0;
      let cjk = 0;
      for (const ch of s) {
        if (CJK.test(ch)) cjk++;
        else if (/\p{Script=Latin}|['’]/u.test(ch)) latin++;
        else other += enc.encode(ch).length;
      }
      total += (latin > 0 ? Math.ceil(latin / p.wordChars) : 0) + cjk * p.cjk + other / p.otherBytesPerToken;
    } else if (m[2] !== undefined) total += Math.ceil(s.length / p.digitGroup);
    else if (m[3] !== undefined) total += 1;
    else if (m[4] !== undefined) total += s.length > 1 ? 0.5 : 0;
    else if (m[5] !== undefined) total += Math.ceil(s.length / 2);
    else total += enc.encode(s).length / p.otherBytesPerToken;
  }
  const padded = Math.ceil(total * (1 + (o.safetyMargin ?? 0)));
  return Math.min(Math.max(padded, 1), upperBound(text));
}

/** A counter bound to a vendor table. */
export const estimator = (vendor: string | VendorProfile = 'generic', o: EstimateOptions = {}): Counter => {
  const p = profileOf(vendor);
  return (t) => estimate(t, p, o);
};

// ---------------------------------------------------------------------------------------------------------------
// Exact byte-level BPE over a vocabulary you supply
// ---------------------------------------------------------------------------------------------------------------

const keyOf = (b: Uint8Array): string => String.fromCharCode(...b);

/** tiktoken's vocabulary text format: one `base64-of-bytes rank` per line. */
export function parseTiktokenRanks(text: string): Map<string, number> {
  const ranks = new Map<string, number>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    const m = /^([A-Za-z0-9+/]+={0,2}) (\d+)$/.exec(line.trim());
    if (!m) throw new TokenCountError(`line ${i + 1} is not "base64 rank"`);
    const key = keyOf(Buffer.from(m[1]!, 'base64'));
    if (key === '' || ranks.has(key)) throw new TokenCountError(`line ${i + 1} repeats or empties a token`);
    ranks.set(key, Number(m[2]));
  });
  return ranks;
}

/** GPT-2 style pre-tokenising pattern: contractions, words, numbers, punctuation, and whitespace runs. */
export const DEFAULT_SPLIT = /'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export interface BpeOptions {
  /** Special tokens such as an end-of-text marker, by text. They must not collide with ordinary ranks. */
  readonly special?: Readonly<Record<string, number>>;
  readonly split?: RegExp;
}

export class BpeTokenizer {
  readonly #ranks: Map<string, number>;
  readonly #byRank = new Map<number, Uint8Array>();
  readonly #special: Map<string, number>;
  readonly #split: RegExp;

  /** `ranks` maps a byte string (one char per byte, as `keyOf`) to its rank; every single byte must be present. */
  constructor(ranks: ReadonlyMap<string, number>, o: BpeOptions = {}) {
    this.#ranks = new Map(ranks);
    for (let b = 0; b < 256; b++) if (!this.#ranks.has(String.fromCharCode(b))) throw new TokenCountError(`the vocabulary lacks the single byte ${b}, so some text could not be encoded`);
    for (const [k, r] of this.#ranks) this.#byRank.set(r, Uint8Array.from(k, (c) => c.charCodeAt(0)));
    this.#special = new Map(Object.entries(o.special ?? {}));
    for (const [s, r] of this.#special) if (this.#byRank.has(r)) throw new TokenCountError(`special token ${JSON.stringify(s)} reuses rank ${r}`);
    this.#split = o.split ?? DEFAULT_SPLIT;
    if (!this.#split.global) throw new TokenCountError('the split pattern must have the g flag');
  }

  #piece(bytes: Uint8Array, out: number[]): void {
    let parts = Array.from(bytes, (b) => String.fromCharCode(b));
    if (parts.length === 1) return void out.push(this.#ranks.get(parts[0]!)!);
    for (;;) {
      let best = Infinity;
      let at = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.#ranks.get(parts[i]! + parts[i + 1]!);
        if (r !== undefined && r < best) {
          best = r;
          at = i;
        }
      }
      if (at < 0) break;
      parts = [...parts.slice(0, at), parts[at]! + parts[at + 1]!, ...parts.slice(at + 2)];
    }
    for (const p of parts) out.push(this.#ranks.get(p)!);
  }

  /**
   * Token ids for a text. Special tokens in the text are refused unless `allowSpecial` lists them, so user input
   * cannot smuggle in control tokens.
   */
  encode(text: string, o: { allowSpecial?: readonly string[] } = {}): number[] {
    const out: number[] = [];
    const allowed = new Set(o.allowSpecial ?? []);
    for (const s of this.#special.keys()) if (text.includes(s) && !allowed.has(s)) throw new TokenCountError(`the text contains the special token ${JSON.stringify(s)}, which is not allowed here`);
    const specials = [...allowed].filter((s) => this.#special.has(s));
    const chunks: (string | number)[] = [];
    if (specials.length === 0) chunks.push(text);
    else {
      const re = new RegExp(specials.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
      let last = 0;
      for (const m of text.matchAll(re)) {
        chunks.push(text.slice(last, m.index), this.#special.get(m[0])!);
        last = m.index + m[0].length;
      }
      chunks.push(text.slice(last));
    }
    for (const c of chunks) {
      if (typeof c === 'number') out.push(c);
      else for (const m of c.matchAll(this.#split)) this.#piece(enc.encode(m[0]), out);
    }
    return out;
  }

  decode(ids: readonly number[]): string {
    const names = new Map([...this.#special].map(([s, r]) => [r, s]));
    let res = '';
    let buf: number[] = [];
    const flush = () => {
      res += dec.decode(Uint8Array.from(buf));
      buf = [];
    };
    for (const id of ids) {
      const sp = names.get(id);
      if (sp !== undefined) {
        flush();
        res += sp;
        continue;
      }
      const b = this.#byRank.get(id);
      if (!b) throw new TokenCountError(`${id} is not a token of this vocabulary`);
      buf.push(...b);
    }
    flush();
    return res;
  }

  readonly count: Counter = (text) => this.encode(text, { allowSpecial: [...this.#special.keys()] }).length;
}

// ---------------------------------------------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------------------------------------------

export type Strategy = 'head' | 'tail' | 'middle';
export type Boundary = 'char' | 'word' | 'sentence' | 'paragraph';

export interface TruncateOptions {
  readonly strategy?: Strategy;
  readonly boundary?: Boundary;
  /** Inserted where text was cut; its tokens count against the budget. */
  readonly marker?: string;
  readonly count: Counter;
}

export interface Truncated {
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
}

const snap = (s: string, boundary: Boundary, fromEnd: boolean): string => {
  if (boundary === 'char') return s;
  const cut = snapTo(s, boundary, fromEnd);
  if (cut !== s || boundary === 'word') return cut;
  return snapTo(s, 'word', fromEnd);
};

const snapTo = (s: string, boundary: Boundary, fromEnd: boolean): string => {
  const re = boundary === 'word' ? /\s+/g : boundary === 'sentence' ? /[.!?。！？]["'”’)]*(?:\s+|$)|\n{2,}/g : /\n\s*\n/g;
  const cuts: number[] = [];
  for (const m of s.matchAll(re)) cuts.push(m.index + (boundary === 'word' ? 0 : m[0].length));
  if (fromEnd) {
    // keep from the first boundary on: drop the partial piece at the front
    const c = cuts.find((x) => x > 0 && x < s.length);
    if (c === undefined) return s;
    const rest = boundary === 'word' ? s.slice(c).replace(/^\s+/, '') : s.slice(c);
    return rest.length >= s.length / 2 ? rest : s;
  }
  const c = [...cuts].reverse().find((x) => x > 0 && x <= s.length);
  if (c === undefined) return s;
  const head = s.slice(0, c).replace(/\s+$/, '');
  return head.length >= s.length / 2 ? head : s;
};

const cpSafe = (s: string, i: number): number => (i > 0 && i < s.length && /[\uDC00-\uDFFF]/.test(s[i]!) && /[\uD800-\uDBFF]/.test(s[i - 1]!) ? i - 1 : i);

/** The longest prefix (or suffix) of s within the budget, found by bisection; counts are assumed to grow with length. */
function fit(s: string, budget: number, count: Counter, fromEnd: boolean): string {
  if (budget <= 0) return '';
  const view = (n: number) => (fromEnd ? s.slice(s.length - n) : s.slice(0, n));
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const n = fromEnd ? s.length - cpSafe(s, s.length - mid) : cpSafe(s, mid);
    if (count(view(n)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const n = fromEnd ? s.length - cpSafe(s, s.length - lo) : cpSafe(s, lo);
  return view(n);
}

/** Cut a text to a token budget, keeping its head, its tail, or both ends. The result, marker included, fits. */
export function truncate(text: string, maxTokens: number, o: TruncateOptions): Truncated {
  if (!Number.isFinite(maxTokens) || maxTokens < 0) throw new TokenCountError('the budget must be zero or more tokens');
  const total = o.count(text);
  if (total <= maxTokens) return { text, tokens: total, truncated: false };
  const strategy = o.strategy ?? 'head';
  const boundary = o.boundary ?? 'char';
  const marker = o.marker ?? '';
  const markerCost = marker === '' ? 0 : o.count(marker);
  if (markerCost > maxTokens) return { text: '', tokens: 0, truncated: true };
  const room = maxTokens - markerCost;
  let out: string;
  if (strategy === 'head') out = snap(fit(text, room, o.count, false), boundary, false) + marker;
  else if (strategy === 'tail') out = marker + snap(fit(text, room, o.count, true), boundary, true);
  else {
    const headRoom = Math.ceil(room / 2);
    const head = snap(fit(text, headRoom, o.count, false), boundary, false);
    const tail = snap(fit(text, room - o.count(head), o.count, true), boundary, true);
    out = head + marker + tail;
  }
  // snapping only shortens and counts are monotone, but a marker next to a cut can merge tokens; verify and trim.
  let tokens = o.count(out);
  while (tokens > maxTokens && out.length > 0) {
    out = strategy === 'tail' ? out.slice(cpSafe(out, 1) || 1) : out.slice(0, cpSafe(out, out.length - 1));
    tokens = o.count(out);
  }
  return { text: out, tokens, truncated: true };
}

export interface ChatMessage {
  readonly role: string;
  readonly content: string;
}

export interface FitResult {
  readonly messages: ChatMessage[];
  readonly tokens: number;
  /** How many messages were dropped, oldest first. */
  readonly dropped: number;
  /** True when the last message had to be shortened. */
  readonly shortened: boolean;
}

export interface FitOptions {
  readonly count: Counter;
  /** Tokens added per message by the chat format. */
  readonly perMessage?: number;
  /** Tokens added once for the reply. */
  readonly perReply?: number;
  readonly marker?: string;
}

/** Total tokens of a conversation, the chat-format overhead included. */
export function countMessages(messages: readonly ChatMessage[], o: FitOptions): number {
  return messages.reduce((n, m) => n + o.count(m.content) + (o.perMessage ?? 0), o.perReply ?? 0);
}

/**
 * Fit a conversation to a budget: system messages and the latest message are kept; the oldest other messages go
 * first; if the latest message alone is still too big its content is cut from the middle. Order is preserved.
 */
export function fitMessages(messages: readonly ChatMessage[], budget: number, o: FitOptions): FitResult {
  if (messages.length === 0) return { messages: [], tokens: o.perReply ?? 0, dropped: 0, shortened: false };
  const lastIdx = messages.length - 1;
  const kept = messages.map((m, i) => ({ m, i, pinned: m.role === 'system' || i === lastIdx }));
  let dropped = 0;
  const total = () => countMessages(kept.map((k) => k.m), o);
  while (total() > budget) {
    const k = kept.findIndex((x) => !x.pinned);
    if (k < 0) break;
    kept.splice(k, 1);
    dropped++;
  }
  let shortened = false;
  if (total() > budget) {
    const li = kept.findIndex((x) => x.i === lastIdx);
    const others = countMessages(kept.filter((x) => x.i !== lastIdx).map((x) => x.m), o) + (o.perMessage ?? 0);
    const room = Math.max(0, budget - others);
    const cut = truncate(kept[li]!.m.content, room, { count: o.count, strategy: 'middle', boundary: 'word', marker: o.marker ?? ' [...] ' });
    kept[li] = { ...kept[li]!, m: { role: kept[li]!.m.role, content: cut.text } };
    shortened = true;
  }
  return { messages: kept.map((k) => k.m), tokens: total(), dropped, shortened };
}

/** Tokens left for a prompt once room is kept for the answer. */
export function promptBudget(contextWindow: number, reserveForAnswer: number): number {
  if (!Number.isInteger(contextWindow) || !Number.isInteger(reserveForAnswer) || contextWindow < 1 || reserveForAnswer < 0) throw new TokenCountError('window and reserve must be whole numbers, the window at least 1');
  if (reserveForAnswer >= contextWindow) throw new TokenCountError('the answer reserve leaves no room for a prompt');
  return contextWindow - reserveForAnswer;
}
