/**
 * Choosing which record from an outside metadata provider (a film database, a music catalogue, a book service)
 * belongs to a file in the library, and remembering the choice so a refresh never undoes a person's decision.
 *
 *  - A provider interface (`search` and `get`) and a twin that behaves like one (fixed catalogue, rate limits,
 *    outages, call counts), so every path runs without an account anywhere.
 *  - Scoring (0 to 1) of each candidate against what is known from the file: title (accents, case, punctuation and
 *    leading articles ignored; reordered words, a missing subtitle and aliases allowed; a different sequel number
 *    counts against it), year (exact, one off, two off, further off), creators (directors, artists, authors) and
 *    runtime. Only the parts both sides have are weighed. An outside id that matches is certain. Each score comes with
 *    the reasons, so a screen can say why.
 *  - A decision: `auto` only when the best candidate is clearly good and clearly ahead of the second (so two films
 *    with the same title and nearby years go to a person), `review` when it is plausible, `none` otherwise. A
 *    year more than two off never auto-matches.
 *  - The match book: per item, the chosen record and how (auto or manual), candidates a person rejected (never
 *    picked automatically again), and field locks. A manual choice or a hand edit locks fields; a refresh from the
 *    provider changes only unlocked fields, and a field that changed locally since the last refresh is kept, as the
 *    sync block does (it takes the provider's `Remote` shape). A manual match is never replaced by a re-match.
 *
 * Not here: reading names out of file names (media-name-parse), the network client for any particular provider,
 * and image downloads. Rate limits come back as an outcome with the wait, never as a sleep.
 */
import { normalise, similarity, tokenSet, tokenSort } from '../fuzzy-match/index.ts';
import type { Remote } from '../sync/index.ts';

export class MatchError extends Error {}
export class RateLimited extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`rate limited: retry in ${retryAfterMs} ms`);
    this.retryAfterMs = retryAfterMs;
  }
}
export class ProviderDown extends Error {}

export type Kind = 'movie' | 'series' | 'episode' | 'album' | 'track' | 'book' | 'audiobook';

export interface Query {
  readonly kind: Kind;
  readonly title: string;
  readonly year?: number;
  /** Directors, artists or authors named by the file or its tags. */
  readonly creators?: readonly string[];
  readonly runtimeMin?: number;
  /** Outside ids found in the file name or tags, by id space ("imdb": "tt0133093"). */
  readonly externalIds?: Readonly<Record<string, string>>;
}

export interface Candidate {
  readonly provider: string;
  readonly id: string;
  readonly kind: Kind;
  readonly title: string;
  readonly aliases?: readonly string[];
  readonly year?: number;
  readonly creators?: readonly string[];
  readonly runtimeMin?: number;
  /** 0 to 1, a small tie-break between otherwise equal candidates. */
  readonly popularity?: number;
  readonly externalIds?: Readonly<Record<string, string>>;
}

export interface MetadataProvider {
  readonly name: string;
  search(q: Query, limit: number): Promise<readonly Candidate[]>;
  /** The provider's record for an id, as the sync block's Remote: its fields and when it last changed. */
  get(id: string): Promise<Remote | undefined>;
}

// ---------------------------------------------------------------- scoring

export interface Scored {
  readonly candidate: Candidate;
  readonly score: number;
  readonly parts: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
}

const ARTICLES = /^(the|a|an|der|die|das|le|la|les|el|los|las|il)\s+/;
const ROMAN = new Set(['ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']);

/** Title text for comparing: folded, article dropped. */
export const comparable = (s: string): string => normalise(s).replace(ARTICLES, '');

/** "Alien: Resurrection" and "Alien - Resurrection" also answer to "Alien" alone, and to the part after the colon. */
const variants = (title: string): string[] => {
  const t = comparable(title);
  const parts = title.split(/\s*[:–—]\s+|\s+-\s+/);
  return [...new Set([t, ...(parts.length > 1 ? parts.map(comparable) : [])].filter(Boolean))];
};

const numbers = (s: string): string => normalise(s).split(' ').filter((w) => /^\d+$/.test(w) || ROMAN.has(w)).sort().join(',');

function titleScore(q: string, c: Candidate): { score: number; why: string } {
  let best = 0;
  let why = '';
  const qn = comparable(q);
  const qNums = numbers(q);
  for (const name of [c.title, ...(c.aliases ?? [])]) {
    const exact = comparable(name) === qn;
    let s: number;
    let w: string;
    if (exact) {
      s = 1;
      w = name === c.title ? 'title is the same' : `matches the alias "${name}"`;
    } else {
      // the whole title against whole title; a subtitle-less or subtitle-only form earns a little less
      const whole = Math.max(similarity(qn, comparable(name)), tokenSort(qn, comparable(name)), tokenSet(qn, comparable(name)) * 0.8);
      const sub = Math.max(0, ...variants(name).filter((v) => v !== comparable(name)).map((v) => (v === qn ? 0.9 : 0)));
      s = Math.max(whole, sub);
      w = sub > whole ? 'matches part of the title' : 'title is close';
      if (numbers(name) !== qNums) {
        s *= 0.75;
        w += ', but the number differs';
      }
    }
    if (s > best) {
      best = s;
      why = w;
    }
  }
  return { score: best, why };
}

const yearScore = (a: number, b: number): number => {
  const d = Math.abs(a - b);
  return d === 0 ? 1 : d === 1 ? 0.75 : d === 2 ? 0.3 : 0;
};

const WEIGHT = { title: 0.6, year: 0.25, creators: 0.12, runtime: 0.03 } as const;

/** One candidate scored against what is known. A candidate of another kind scores zero. */
export function score(q: Query, c: Candidate): Scored {
  const reasons: string[] = [];
  const parts: Record<string, number> = {};
  if (q.kind !== c.kind) return { candidate: c, score: 0, parts, reasons: [`it is a ${c.kind}, not a ${q.kind}`] };
  for (const [space, id] of Object.entries(q.externalIds ?? {})) {
    if (c.externalIds?.[space] !== undefined && c.externalIds[space]!.toLowerCase() === id.toLowerCase()) return { candidate: c, score: 1, parts: { id: 1 }, reasons: [`the ${space} id ${id} matches`] };
  }
  const t = titleScore(q.title, c);
  parts.title = t.score;
  reasons.push(t.why);
  let used = WEIGHT.title;
  let total = WEIGHT.title * t.score;
  if (q.year !== undefined && c.year !== undefined) {
    parts.year = yearScore(q.year, c.year);
    reasons.push(parts.year === 1 ? 'same year' : `${Math.abs(q.year - c.year)} year${Math.abs(q.year - c.year) === 1 ? '' : 's'} apart`);
    used += WEIGHT.year;
    total += WEIGHT.year * parts.year;
  }
  if (q.creators?.length && c.creators?.length) {
    parts.creators = Math.max(...q.creators.flatMap((a) => c.creators!.map((b) => Math.max(tokenSet(a, b), similarity(a, b)))));
    reasons.push(parts.creators >= 0.85 ? 'creator matches' : 'creator differs');
    used += WEIGHT.creators;
    total += WEIGHT.creators * parts.creators;
  }
  if (q.runtimeMin !== undefined && c.runtimeMin !== undefined && q.runtimeMin > 0 && c.runtimeMin > 0) {
    const rel = Math.abs(q.runtimeMin - c.runtimeMin) / Math.max(q.runtimeMin, c.runtimeMin);
    parts.runtime = rel <= 0.05 ? 1 : rel <= 0.15 ? 0.6 : 0;
    used += WEIGHT.runtime;
    total += WEIGHT.runtime * parts.runtime;
  }
  let s = total / used;
  s = Math.min(1, s + 0.03 * (c.popularity ?? 0) * (s >= 0.6 ? 1 : 0));
  if (parts.year === 0) s = Math.min(s, 0.7);
  return { candidate: c, score: Math.round(s * 1000) / 1000, parts, reasons };
}

export interface Thresholds {
  /** Best score needed to match without asking. */
  readonly auto: number;
  /** How far ahead of the runner-up the best must be to match without asking. */
  readonly margin: number;
  /** Lowest score worth showing to a person. */
  readonly review: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { auto: 0.85, margin: 0.1, review: 0.55 };

export type Decision = { readonly kind: 'auto'; readonly best: Scored } | { readonly kind: 'review'; readonly options: readonly Scored[] } | { readonly kind: 'none' };

/** Rank candidates (best first, ties by id so it is deterministic) and decide what to do. */
export function rank(q: Query, candidates: readonly Candidate[], rejected: ReadonlySet<string> = new Set(), t: Thresholds = DEFAULT_THRESHOLDS): { ranked: Scored[]; decision: Decision } {
  const ranked = candidates.filter((c) => !rejected.has(`${c.provider}:${c.id}`)).map((c) => score(q, c)).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  const best = ranked[0];
  if (!best || best.score < t.review) return { ranked, decision: { kind: 'none' } };
  const second = ranked[1];
  const clearYear = q.year === undefined || best.parts.year === undefined || best.parts.year >= 0.75;
  if (best.score >= t.auto && clearYear && (!second || best.score - second.score >= t.margin || best.parts.id === 1)) return { ranked, decision: { kind: 'auto', best } };
  return { ranked, decision: { kind: 'review', options: ranked.filter((r) => r.score >= t.review).slice(0, 5) } };
}

// ---------------------------------------------------------------- the match book

export type MatchState = 'auto' | 'manual' | 'review' | 'unmatched';

export interface Match {
  readonly item: string;
  readonly state: MatchState;
  readonly provider?: string;
  readonly id?: string;
  readonly score?: number;
  readonly by?: string;
  readonly at?: number;
  /** For `review`: the candidates a person should choose between. */
  readonly options?: readonly Scored[];
}

export type Outcome = { readonly status: 'matched' | 'kept' | 'review' | 'unmatched'; readonly match: Match } | { readonly status: 'retry'; readonly afterMs: number } | { readonly status: 'down'; readonly why: string };

interface Entry {
  match: Match;
  rejected: Set<string>;
  locked: Set<string>;
  allLocked: boolean;
  /** Current metadata fields and what the provider last said, for three-way refresh. */
  fields: Record<string, unknown>;
  base: Record<string, unknown>;
  history: { at: number; what: string }[];
}

export interface RefreshResult {
  readonly applied: readonly string[];
  readonly keptLocked: readonly string[];
  readonly keptLocal: readonly string[];
}

export class MatchBook {
  private readonly items = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly t: Thresholds;

  constructor(o: { now: () => number; thresholds?: Thresholds }) {
    this.now = o.now;
    this.t = o.thresholds ?? DEFAULT_THRESHOLDS;
  }

  private entry(item: string): Entry {
    if (!item || item.length > 500) throw new MatchError('an item key is 1 to 500 characters');
    let e = this.items.get(item);
    if (!e) this.items.set(item, (e = { match: { item, state: 'unmatched' }, rejected: new Set(), locked: new Set(), allLocked: false, fields: {}, base: {}, history: [] }));
    return e;
  }

  get(item: string): Match | undefined {
    return this.items.get(item)?.match;
  }

  history(item: string): readonly { at: number; what: string }[] {
    return this.items.get(item)?.history ?? [];
  }

  fields(item: string): Readonly<Record<string, unknown>> {
    return { ...this.items.get(item)?.fields };
  }

  locks(item: string): { all: boolean; fields: string[] } {
    const e = this.items.get(item);
    return { all: e?.allLocked ?? false, fields: [...(e?.locked ?? [])].sort() };
  }

  private log(e: Entry, what: string): void {
    e.history.push({ at: this.now(), what });
  }

  /** Search the provider and record the outcome. A manual match is never searched again. */
  async match(item: string, q: Query, p: MetadataProvider, limit = 10): Promise<Outcome> {
    const e = this.entry(item);
    if (e.match.state === 'manual') return { status: 'kept', match: e.match };
    let found: readonly Candidate[];
    try {
      found = await p.search(q, limit);
    } catch (err) {
      if (err instanceof RateLimited) return { status: 'retry', afterMs: err.retryAfterMs };
      if (err instanceof ProviderDown) return { status: 'down', why: err.message };
      throw err;
    }
    const { decision } = rank(q, found, e.rejected, this.t);
    if (decision.kind === 'auto') {
      const c = decision.best.candidate;
      e.match = { item, state: 'auto', provider: c.provider, id: c.id, score: decision.best.score, at: this.now() };
      this.log(e, `auto matched ${c.provider}:${c.id} (${decision.best.score})`);
      return { status: 'matched', match: e.match };
    }
    if (decision.kind === 'review') {
      e.match = { item, state: 'review', options: decision.options, at: this.now() };
      this.log(e, `${decision.options.length} candidates need a person`);
      return { status: 'review', match: e.match };
    }
    e.match = { item, state: 'unmatched', at: this.now() };
    this.log(e, 'no plausible candidate');
    return { status: 'unmatched', match: e.match };
  }

  /** A person's choice. It locks every field against refresh, or only `lock` if given, and clears any rejection of it. */
  choose(item: string, c: Pick<Candidate, 'provider' | 'id'>, by: string, o: { lock?: readonly string[] } = {}): Match {
    const e = this.entry(item);
    e.rejected.delete(`${c.provider}:${c.id}`);
    e.match = { item, state: 'manual', provider: c.provider, id: c.id, by, at: this.now() };
    if (o.lock) o.lock.forEach((f) => e.locked.add(f));
    else e.allLocked = true;
    this.log(e, `${by} chose ${c.provider}:${c.id}`);
    return e.match;
  }

  /** "Not this one": it will not be picked automatically again, and an automatic match to it is withdrawn. */
  reject(item: string, c: Pick<Candidate, 'provider' | 'id'>, by: string): Match {
    const e = this.entry(item);
    e.rejected.add(`${c.provider}:${c.id}`);
    if (e.match.state === 'auto' && e.match.provider === c.provider && e.match.id === c.id) e.match = { item, state: 'unmatched', at: this.now() };
    else if (e.match.state === 'manual' && e.match.provider === c.provider && e.match.id === c.id) throw new MatchError('that is the match a person chose; choose another first');
    this.log(e, `${by} rejected ${c.provider}:${c.id}`);
    return e.match;
  }

  /** Forget a manual choice so the item can be matched again. Locks stay unless `locks` is set. */
  clear(item: string, o: { locks?: boolean } = {}): void {
    const e = this.entry(item);
    e.match = { item, state: 'unmatched' };
    if (o.locks) {
      e.locked.clear();
      e.allLocked = false;
    }
    this.log(e, 'match cleared');
  }

  /** A person edits one field by hand. It is locked, so no refresh will change it back. */
  edit(item: string, field: string, value: unknown): void {
    if (field === '__proto__') throw new MatchError('"__proto__" is not a field');
    const e = this.entry(item);
    e.fields[field] = value;
    e.locked.add(field);
    this.log(e, `edited ${field}`);
  }

  unlock(item: string, field?: string): void {
    const e = this.entry(item);
    if (field === undefined) {
      e.locked.clear();
      e.allLocked = false;
    } else {
      e.locked.delete(field);
      if (e.allLocked) throw new MatchError('everything is locked by a manual choice; unlock all');
    }
  }

  /**
   * Bring the provider's record in. A locked field is left alone. An unlocked field that was changed here since the
   * last refresh is left alone too (the provider did not say anything new about it). Others take the provider's value.
   */
  refresh(item: string, remote: Remote): RefreshResult {
    const e = this.entry(item);
    if (e.match.id !== undefined && remote.id !== e.match.id) throw new MatchError(`this record is ${remote.id}, but the item is matched to ${e.match.id}`);
    const applied: string[] = [];
    const keptLocked: string[] = [];
    const keptLocal: string[] = [];
    for (const [k, v] of Object.entries(remote.fields)) {
      if (k === '__proto__') continue;
      const same = JSON.stringify(e.fields[k]) === JSON.stringify(v);
      if (e.allLocked || e.locked.has(k)) {
        if (!same) keptLocked.push(k);
      } else if (k in e.fields && JSON.stringify(e.fields[k]) !== JSON.stringify(e.base[k])) {
        if (!same) keptLocal.push(k);
      } else if (!same) {
        e.fields[k] = v;
        applied.push(k);
      }
      e.base[k] = v;
    }
    if (applied.length) this.log(e, `refreshed ${applied.join(', ')}`);
    return { applied: applied.sort(), keptLocked: keptLocked.sort(), keptLocal: keptLocal.sort() };
  }

  /** Fetch the matched record from the provider and refresh from it. */
  async refreshFrom(item: string, p: MetadataProvider): Promise<RefreshResult | undefined> {
    const m = this.get(item);
    if (!m || m.provider !== p.name || !m.id) return undefined;
    const r = await p.get(m.id);
    return r ? this.refresh(item, r) : undefined;
  }
}

// ---------------------------------------------------------------- the twin

export interface TwinRecord extends Candidate {
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly updated?: string;
}

/** A provider with a fixed catalogue that answers loosely (any shared word), like a real search box. */
export class TwinProvider implements MetadataProvider {
  readonly name: string;
  readonly searches: Query[] = [];
  readonly gets: string[] = [];
  private readonly catalogue: TwinRecord[];
  private readonly outages: (RateLimited | ProviderDown)[] = [];
  private readonly updates = new Map<string, Readonly<Record<string, unknown>>>();

  constructor(name: string, catalogue: readonly TwinRecord[]) {
    this.name = name;
    this.catalogue = catalogue.map((c) => ({ ...c, provider: name }));
  }

  /** The next calls fail in this order (then calls work again). */
  failNext(...errors: (RateLimited | ProviderDown)[]): void {
    this.outages.push(...errors);
  }

  /** Change what the provider says about a record, as it does when someone corrects it. */
  correct(id: string, fields: Readonly<Record<string, unknown>>): void {
    this.updates.set(id, { ...this.updates.get(id), ...fields });
  }

  async search(q: Query, limit: number): Promise<readonly Candidate[]> {
    this.searches.push(q);
    const err = this.outages.shift();
    if (err) throw err;
    const words = new Set(comparable(q.title).split(' ').filter((w) => w.length > 1));
    return this.catalogue
      .filter((c) => c.kind === q.kind && [c.title, ...(c.aliases ?? [])].some((n) => comparable(n).split(' ').some((w) => words.has(w))))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ fields: _f, updated: _u, ...c }) => c);
  }

  async get(id: string): Promise<Remote | undefined> {
    this.gets.push(id);
    const err = this.outages.shift();
    if (err) throw err;
    const c = this.catalogue.find((x) => x.id === id);
    if (!c) return undefined;
    return { id, updated: c.updated ?? '2026-01-01T00:00:00Z', fields: { title: c.title, year: c.year, ...c.fields, ...this.updates.get(id) } };
  }
}
