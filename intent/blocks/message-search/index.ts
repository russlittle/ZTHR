/**
 * Message search for chat and forums: free text plus the operators people already know from Slack, Mattermost,
 * Discord and Zulip, with the permission check applied to every message before it is scored, counted or shown.
 *
 * Query language (`parseQuery`): words must all match (stemmed, accent and case folded; `word*` matches a prefix);
 * `"a phrase"` must appear in order; a leading `-` excludes (a word, a phrase or any operator). Operators:
 *   from:@alice   in:#general   before:2026-11-01   after:2026-11-01   on:2026-11-01   during:2026-11 (or 2026)
 *   has:link | file | image | reaction | pin | thread   is:pinned | thread | reply | edited   filename:report   ext:pdf
 * Several `from:` (or several `in:`) are alternatives; different operators all apply. `from:me` is the searcher.
 * Dates are UTC days unless the searcher's offset is given; `today`, `yesterday` and `7d` (seven days ago) work too.
 *
 * Permissions: a message is a candidate only if `canRead(viewer, channel, message)` allows it, so nothing a person
 * may not read changes a count, a rank or a snippet. A restriction naming something that does not exist or that the
 * person cannot see (`in:#secret`) is answered exactly as if it did not exist: no results and the same warning.
 *
 * Ranking is BM25 with a gentle preference for newer messages; `sort` can also be `newest` or `oldest`. Snippets
 * are escaped HTML with the matches marked. Pages are keyset cursors, so new messages do not shift later pages.
 *
 * Out of scope: attachments' contents (only names and types are searched), regular expressions, and storage.
 */
import { fold, snippet, stem, words } from '../search/index.ts';

export class MessageSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageSearchError';
  }
}

export interface FileInfo {
  readonly name: string;
  readonly mime: string;
}

export interface Message {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly text: string;
  /** Milliseconds since the epoch. */
  readonly ts: number;
  /** The id of the thread's first message when this is a reply. */
  readonly threadRoot?: string;
  readonly files?: readonly FileInfo[];
  readonly reactions?: readonly string[];
  readonly pinned?: boolean;
  readonly edited?: boolean;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
}

export interface Hooks {
  /** Channel by name (no `#`), or undefined. Must return only channels the viewer may know exist, or the check below hides them. */
  readonly channelByName: (name: string) => Channel | undefined;
  /** User id by handle (no `@`), or undefined. */
  readonly userByHandle: (handle: string) => string | undefined;
  /** May the viewer read this message? Called for every candidate. */
  readonly canRead: (viewer: string, channelId: string, m: Message) => boolean;
  /** May the viewer see that this channel exists? Used to answer `in:` the same for secret and missing channels. */
  readonly canSeeChannel: (viewer: string, channelId: string) => boolean;
  readonly now: () => number;
}

export type Has = 'link' | 'file' | 'image' | 'reaction' | 'pin' | 'thread';
export type Is = 'pinned' | 'thread' | 'reply' | 'edited';

export interface Clause<T> {
  readonly include: readonly T[];
  readonly exclude: readonly T[];
}

export interface Query {
  readonly terms: string[];
  readonly prefixes: string[];
  readonly phrases: string[][];
  readonly notTerms: string[];
  readonly notPhrases: string[][];
  readonly from: Clause<string>;
  readonly in: Clause<string>;
  readonly has: Clause<Has>;
  readonly is: Clause<Is>;
  readonly filename: Clause<string>;
  readonly ext: Clause<string>;
  /** Inclusive start and exclusive end, in ms, from after:, before:, on: and during:. */
  readonly range: { readonly from: number | undefined; readonly to: number | undefined };
  readonly warnings: string[];
  /** True when something named in the query cannot match anything (unknown date range, empty range). */
  readonly impossible: boolean;
}

const MAX_QUERY = 500;
const MAX_TOKENS = 24;

function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(?:-?(?:[A-Za-z]+:)?"[^"]*"|\S+)/g;
  for (const m of q.matchAll(re)) out.push(m[0]);
  return out;
}

const DAY = 86_400_000;

/** A date word to a day start in UTC adjusted by the searcher's offset (minutes east of UTC). */
export function parseDay(s: string, now: number, offsetMin: number): { start: number; end: number } | undefined {
  const off = offsetMin * 60_000;
  const todayStart = Math.floor((now + off) / DAY) * DAY - off;
  if (s === 'today') return { start: todayStart, end: todayStart + DAY };
  if (s === 'yesterday') return { start: todayStart - DAY, end: todayStart };
  let m = /^(\d{1,4})d$/.exec(s);
  if (m) return { start: todayStart - Number(m[1]) * DAY, end: todayStart - (Number(m[1]) - 1) * DAY };
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
    const d = new Date(t);
    if (d.getUTCFullYear() !== +m[1]! || d.getUTCMonth() !== +m[2]! - 1 || d.getUTCDate() !== +m[3]!) return undefined;
    return { start: t - off, end: t + DAY - off };
  }
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m && +m[2]! >= 1 && +m[2]! <= 12) return { start: Date.UTC(+m[1]!, +m[2]! - 1, 1) - off, end: Date.UTC(+m[1]!, +m[2]!, 1) - off };
  m = /^(\d{4})$/.exec(s);
  if (m) return { start: Date.UTC(+m[1]!, 0, 1) - off, end: Date.UTC(+m[1]! + 1, 0, 1) - off };
  return undefined;
}

const HAS: readonly string[] = ['link', 'file', 'image', 'reaction', 'pin', 'thread'];
const IS: readonly string[] = ['pinned', 'thread', 'reply', 'edited'];

/** Read a query string. Never throws on odd input: problems become `warnings`, and a restriction that cannot be met makes the query `impossible`. */
export function parseQuery(src: string, now: number, offsetMin = 0): Query {
  const warnings: string[] = [];
  if (src.length > MAX_QUERY) throw new MessageSearchError(`a query over ${MAX_QUERY} characters`);
  const toks = tokenize(src);
  if (toks.length > MAX_TOKENS) throw new MessageSearchError(`a query of more than ${MAX_TOKENS} parts`);
  const terms: string[] = [];
  const prefixes: string[] = [];
  const phrases: string[][] = [];
  const notTerms: string[] = [];
  const notPhrases: string[][] = [];
  const mk = <T>(): { include: T[]; exclude: T[] } => ({ include: [], exclude: [] });
  const from = mk<string>(), inn = mk<string>(), has = mk<Has>(), is = mk<Is>(), filename = mk<string>(), ext = mk<string>();
  let lo: number | undefined;
  let hi: number | undefined;
  let impossible = false;
  const narrow = (a: number | undefined, b: number | undefined) => {
    if (a !== undefined) lo = lo === undefined ? a : Math.max(lo, a);
    if (b !== undefined) hi = hi === undefined ? b : Math.min(hi, b);
  };
  for (const raw of toks) {
    const neg = raw.startsWith('-') && raw.length > 1;
    const t = neg ? raw.slice(1) : raw;
    const op = /^([A-Za-z]+):(.*)$/s.exec(t);
    if (t.startsWith('"')) {
      const ws = words(t.replace(/^"|"$/g, ''));
      if (ws.length) (neg ? notPhrases : phrases).push(ws.map(stem));
      continue;
    }
    if (op && ['from', 'in', 'before', 'after', 'on', 'during', 'has', 'is', 'filename', 'ext'].includes(op[1]!.toLowerCase())) {
      const name = op[1]!.toLowerCase();
      const val = op[2]!.replace(/^"|"$/g, '').trim();
      const side = (c: { include: unknown[]; exclude: unknown[] }) => (neg ? c.exclude : c.include);
      if (val === '') {
        warnings.push(`${name}: needs a value`);
        continue;
      }
      switch (name) {
        case 'from':
          side(from).push(val.replace(/^@/, '').toLowerCase());
          break;
        case 'in':
          side(inn).push(val.replace(/^#/, '').toLowerCase());
          break;
        case 'has':
          if (HAS.includes(val.toLowerCase())) side(has).push(val.toLowerCase());
          else warnings.push(`has:${val} is not one of ${HAS.join(', ')}`);
          break;
        case 'is':
          if (IS.includes(val.toLowerCase())) side(is).push(val.toLowerCase());
          else warnings.push(`is:${val} is not one of ${IS.join(', ')}`);
          break;
        case 'filename':
          side(filename).push(fold(val));
          break;
        case 'ext':
          side(ext).push(val.replace(/^\./, '').toLowerCase());
          break;
        default: {
          const d = parseDay(val.toLowerCase(), now, offsetMin);
          if (!d) {
            warnings.push(`${name}:${val} is not a date`);
            impossible = true;
            break;
          }
          if (neg) {
            warnings.push(`${name}: cannot be negated`);
            break;
          }
          if (name === 'before') narrow(undefined, d.start);
          else if (name === 'after') narrow(d.end, undefined);
          else narrow(d.start, d.end);
        }
      }
      continue;
    }
    const star = t.endsWith('*') && t.length > 1;
    for (const w of words(star ? t.slice(0, -1) : t)) {
      if (neg) notTerms.push(stem(w));
      else if (star) prefixes.push(w);
      else terms.push(stem(w));
    }
  }
  if (lo !== undefined && hi !== undefined && lo >= hi) impossible = true;
  const c = <T>(x: { include: T[]; exclude: T[] }): Clause<T> => x;
  return { terms, prefixes, phrases, notTerms, notPhrases, from: c(from), in: c(inn), has: c(has), is: c(is), filename: c(filename), ext: c(ext), range: { from: lo, to: hi }, warnings, impossible };
}

export interface Hit {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly ts: number;
  readonly threadRoot: string | undefined;
  readonly score: number;
  /** HTML-escaped, matches in <mark>. */
  readonly snippet: string;
}

export interface Result {
  readonly hits: Hit[];
  /** Messages matching that the viewer may read. */
  readonly total: number;
  readonly next: string | null;
  readonly warnings: string[];
  readonly query: Query;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: 'relevance' | 'newest' | 'oldest';
  /** Minutes east of UTC for the searcher's dates. */
  readonly offsetMin?: number;
}

interface Doc {
  readonly m: Message;
  readonly toks: string[];
  readonly stems: Set<string>;
  readonly links: boolean;
}

const URL_RE = /\bhttps?:\/\/[^\s<>]+/i;

export class MessageSearch {
  readonly #docs = new Map<string, Doc>();
  readonly #post = new Map<string, Set<string>>();
  readonly #hooks: Hooks;
  #totalLen = 0;

  constructor(h: Hooks) {
    this.#hooks = h;
  }

  get size(): number {
    return this.#docs.size;
  }

  index(m: Message): void {
    this.remove(m.id);
    const toks = words([m.text, ...(m.files ?? []).map((f) => f.name)].join(' ')).map(stem);
    const stems = new Set(toks);
    this.#docs.set(m.id, { m, toks, stems, links: URL_RE.test(m.text) });
    for (const t of stems) {
      const s = this.#post.get(t) ?? new Set<string>();
      s.add(m.id);
      this.#post.set(t, s);
    }
    this.#totalLen += toks.length;
  }

  remove(id: string): boolean {
    const d = this.#docs.get(id);
    if (!d) return false;
    for (const t of d.stems) {
      const s = this.#post.get(t);
      s?.delete(id);
      if (s && s.size === 0) this.#post.delete(t);
    }
    this.#totalLen -= d.toks.length;
    this.#docs.delete(id);
    return true;
  }

  /** Search as `viewer`. */
  search(viewer: string, queryString: string, o: SearchOptions = {}): Result {
    const h = this.#hooks;
    const q = parseQuery(queryString, h.now(), o.offsetMin ?? 0);
    const warnings = [...q.warnings];
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100);
    const empty: Result = { hits: [], total: 0, next: null, warnings, query: q };
    if (q.impossible) return empty;

    // restrictions that name things: unknown or invisible means no match, never "ignore the restriction"
    const channelIds = (names: readonly string[], warn: boolean): Set<string> => {
      const ids = new Set<string>();
      for (const n of names) {
        const c = h.channelByName(n);
        if (c && h.canSeeChannel(viewer, c.id)) ids.add(c.id);
        else if (warn) warnings.push(`no channel #${n}`);
      }
      return ids;
    };
    const userIds = (handles: readonly string[], warn: boolean): Set<string> => {
      const ids = new Set<string>();
      for (const n of handles) {
        const id = n === 'me' ? viewer : h.userByHandle(n);
        if (id) ids.add(id);
        else if (warn) warnings.push(`no person @${n}`);
      }
      return ids;
    };
    const inSet = q.in.include.length ? channelIds(q.in.include, true) : undefined;
    const inNot = channelIds(q.in.exclude, false);
    const fromSet = q.from.include.length ? userIds(q.from.include, true) : undefined;
    const fromNot = userIds(q.from.exclude, false);
    // a named restriction that cannot be met matches nothing, rather than being dropped
    if ((inSet && inSet.size === 0) || (fromSet && fromSet.size === 0)) return empty;
    // candidates: posting lists for the positive words, otherwise everything
    let cand: Iterable<string>;
    const lists = q.terms.map((t) => this.#post.get(t));
    if (q.terms.length && lists.some((l) => !l)) return empty;
    if (lists.length) {
      const sorted = (lists as Set<string>[]).sort((a, b) => a.size - b.size);
      cand = [...sorted[0]!].filter((id) => sorted.every((s) => s.has(id)));
    } else cand = this.#docs.keys();

    const n = this.#docs.size || 1;
    const avg = this.#totalLen / n || 1;
    const idf = (t: string) => {
      const df = this.#post.get(t)?.size ?? 0;
      return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    };
    const now = h.now();
    const rows: { d: Doc; score: number }[] = [];
    for (const id of cand) {
      const d = this.#docs.get(id)!;
      const m = d.m;
      if (!h.canRead(viewer, m.channelId, m)) continue;
      if (inSet && !inSet.has(m.channelId)) continue;
      if (inNot.has(m.channelId)) continue;
      if (fromSet && !fromSet.has(m.authorId)) continue;
      if (fromNot.has(m.authorId)) continue;
      if (q.range.from !== undefined && m.ts < q.range.from) continue;
      if (q.range.to !== undefined && m.ts >= q.range.to) continue;
      if (!q.prefixes.every((p) => [...d.stems].some((s) => s.startsWith(fold(p)) || s.startsWith(stem(fold(p)))))) continue;
      if (q.notTerms.some((t) => d.stems.has(t))) continue;
      if (!this.#flags(d, q)) continue;
      if (!q.phrases.every((p) => hasPhrase(d.toks, p)) || q.notPhrases.some((p) => hasPhrase(d.toks, p))) continue;
      let score = 0;
      const len = d.toks.length;
      for (const t of q.terms) {
        const tf = d.toks.filter((x) => x === t).length;
        score += (idf(t) * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * len) / avg));
      }
      for (const p of q.phrases) score += p.length * 0.5;
      const ageDays = Math.max(0, (now - m.ts) / DAY);
      score *= 1 + 0.5 * Math.exp(-ageDays / 30);
      if (q.terms.length === 0 && q.prefixes.length === 0 && q.phrases.length === 0) score = Math.exp(-ageDays / 30);
      rows.push({ d, score });
    }
    const sort = o.sort ?? 'relevance';
    const cmp = (a: { d: Doc; score: number }, b: { d: Doc; score: number }): number => {
      if (sort === 'newest') return b.d.m.ts - a.d.m.ts || (a.d.m.id < b.d.m.id ? -1 : 1);
      if (sort === 'oldest') return a.d.m.ts - b.d.m.ts || (a.d.m.id < b.d.m.id ? -1 : 1);
      return b.score - a.score || b.d.m.ts - a.d.m.ts || (a.d.m.id < b.d.m.id ? -1 : 1);
    };
    rows.sort(cmp);
    let start = 0;
    if (o.cursor) {
      const c = decodeCursor(o.cursor, sort);
      const idx = rows.findIndex((r) => (sort === 'relevance' ? r.score < c.score || (r.score === c.score && (r.d.m.ts < c.ts || (r.d.m.ts === c.ts && r.d.m.id > c.id))) : sort === 'newest' ? r.d.m.ts < c.ts || (r.d.m.ts === c.ts && r.d.m.id > c.id) : r.d.m.ts > c.ts || (r.d.m.ts === c.ts && r.d.m.id > c.id)));
      start = idx < 0 ? rows.length : idx;
    }
    const page = rows.slice(start, start + limit);
    const marks = new Set([...q.terms, ...q.phrases.flat()]);
    const lastPrefix = q.prefixes.at(-1);
    const hits: Hit[] = page.map((r) => ({
      id: r.d.m.id,
      channelId: r.d.m.channelId,
      authorId: r.d.m.authorId,
      ts: r.d.m.ts,
      threadRoot: r.d.m.threadRoot,
      score: Math.round(r.score * 1e6) / 1e6,
      snippet: snippet(r.d.m.text, marks, lastPrefix),
    }));
    const last = page.at(-1);
    const next = start + limit < rows.length && last ? encodeCursor(sort, last.score, last.d.m.ts, last.d.m.id) : null;
    return { hits, total: rows.length, next, warnings, query: q };
  }

  #flags(d: Doc, q: Query): boolean {
    const m = d.m;
    const hasF: Record<Has, boolean> = {
      link: d.links,
      file: (m.files?.length ?? 0) > 0,
      image: (m.files ?? []).some((f) => f.mime.toLowerCase().startsWith('image/')),
      reaction: (m.reactions?.length ?? 0) > 0,
      pin: m.pinned === true,
      thread: m.threadRoot !== undefined || [...this.#docs.values()].some((x) => x.m.threadRoot === m.id),
    };
    const isF: Record<Is, boolean> = { pinned: m.pinned === true, thread: hasF.thread, reply: m.threadRoot !== undefined, edited: m.edited === true };
    if (!q.has.include.every((k) => hasF[k]) || q.has.exclude.some((k) => hasF[k])) return false;
    if (!q.is.include.every((k) => isF[k]) || q.is.exclude.some((k) => isF[k])) return false;
    const names = (m.files ?? []).map((f) => fold(f.name));
    if (!q.filename.include.every((f) => names.some((n) => n.includes(f))) || q.filename.exclude.some((f) => names.some((n) => n.includes(f)))) return false;
    const exts = names.map((n) => (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''));
    if (!q.ext.include.every((e) => exts.includes(e)) || q.ext.exclude.some((e) => exts.includes(e))) return false;
    return true;
  }
}

function hasPhrase(toks: readonly string[], p: readonly string[]): boolean {
  for (let i = 0; i + p.length <= toks.length; i++) if (p.every((w, j) => toks[i + j] === w)) return true;
  return false;
}

const encodeCursor = (sort: string, score: number, ts: number, id: string): string => Buffer.from(JSON.stringify([sort, score, ts, id])).toString('base64url');

function decodeCursor(c: string, sort: string): { score: number; ts: number; id: string } {
  try {
    const [s, score, ts, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as [string, number, number, string];
    if (s !== sort || typeof score !== 'number' || typeof ts !== 'number' || typeof id !== 'string') throw new Error('shape');
    return { score, ts, id };
  } catch {
    throw new MessageSearchError('the cursor is not one this search gave out, or the sort changed');
  }
}
