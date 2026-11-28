/**
 * Timeline assembly: home, local, federated, hashtag and list timelines built from the statuses of the
 * microblog block, with a choice of how the home timeline is filled, the filters a reader sets, and repair of the
 * holes a feed can get.
 *
 * Fan-out, the choice every social service makes (`mode`):
 *  - `write`: when someone posts, the status id is pushed into each follower's stored feed (a capped list per
 *    reader). Reading is one lookup; posting costs one write per follower.
 *  - `read`: nothing is stored per reader; reading merges the recent statuses of everyone the reader follows.
 *    Posting is one write; reading costs one lookup per followee.
 *  - `hybrid`: authors with at least `celebrityFollowers` followers are merged at read time and everyone else is
 *    pushed, which bounds both costs. All three give the reader the same timeline; `stats()` counts the writes so
 *    the trade can be seen.
 * A stored feed is capped (`maxFeed`); reading past its oldest entry falls back to merging, so a deep page is still right.
 *
 * What a reader sees: statuses that `canSee` allows (so blocks and visibility hold), minus muted accounts (with
 * optional expiry), muted threads, blocked domains, hidden boosts from chosen accounts, replies outside the reader's
 * circle (`replies: 'followed'`), and keyword filters per context that either hide or warn. The same original
 * boosted by several followed accounts shows once, at its newest appearance. Local and federated timelines hold
 * public statuses only and no boosts.
 *
 * Gap repair: `detectGaps` compares what a client has loaded with the full ordered timeline and names each hole
 * (with how many are missing) so `fillGap` can fetch exactly those; `mergeItems` joins pages without duplicates;
 * `rebuildHome` throws a reader's stored feed away and rebuilds it from the follow graph, which is how a lost or
 * corrupted feed, or a newly followed account, is repaired. Statuses that arrive late with old timestamps (a
 * remote server catching up) are placed where their time says, and show up as gaps on clients.
 *
 * Out of scope: persistence, streaming updates, ranking, and notifications.
 */
import { page, type ListSpec } from '../paging/index.ts';
import { type Microblog, type Status } from '../microblog/index.ts';

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

export type Mode = 'write' | 'read' | 'hybrid';
export type Context = 'home' | 'public' | 'tags' | 'lists' | 'thread';

export type TimelineKind =
  | { readonly kind: 'home' }
  | { readonly kind: 'local' }
  | { readonly kind: 'federated' }
  | { readonly kind: 'tag'; readonly tag: string }
  | { readonly kind: 'list'; readonly id: string };

export interface Graph {
  followersOf(author: string): readonly string[];
  followingOf(user: string): readonly string[];
}

export interface KeywordFilter {
  readonly id: string;
  readonly title: string;
  readonly keywords: readonly { readonly text: string; readonly wholeWord?: boolean }[];
  readonly contexts: readonly Context[];
  readonly action: 'hide' | 'warn';
  readonly expiresAt?: number;
}

export interface ViewerSettings {
  /** Muted accounts, with the time the mute ends (omit for ever). */
  readonly mutedAccounts?: Readonly<Record<string, number | null>>;
  readonly mutedThreads?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly hideBoostsFrom?: readonly string[];
  /** `followed`: show a reply only when it answers the reader or someone they follow, or is the author's own thread. Default `all`. */
  readonly replies?: 'all' | 'followed';
  readonly filters?: readonly KeywordFilter[];
}

export interface TimelineItem {
  readonly status: Status;
  /** For a boost, the original status. */
  readonly original: Status | undefined;
  /** Titles of `warn` filters that matched; the client collapses the status behind them. */
  readonly filtered: readonly string[];
}

export interface Page {
  readonly items: TimelineItem[];
  /** Pass as `after` for the next (older) page; null at the end. */
  readonly next: string | null;
}

export interface Gap {
  /** The loaded id just above the hole (newer), or undefined when the hole is at the top. */
  readonly above: string | undefined;
  /** The loaded id just below the hole (older). */
  readonly below: string;
  readonly missing: number;
}

export interface Options {
  readonly mb: Microblog;
  readonly graph: Graph;
  readonly isLocal: (actor: string) => boolean;
  readonly domainOf: (actor: string) => string;
  readonly now: () => number;
  readonly mode?: Mode;
  /** Hybrid: authors with at least this many followers are merged at read time. Default 1000. */
  readonly celebrityFollowers?: number;
  /** Most entries kept in a stored feed. Default 800. */
  readonly maxFeed?: number;
  readonly mergeWindow?: number;
}

type Entry = {
  id: string;
  ts: number;
  author: string;
};

const SPEC: ListSpec<Entry> = { sortable: ['ts'], filterable: {}, idField: 'id', maxPage: 40 };
const byNewest = (a: Entry, b: Entry) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function insertSorted(list: Entry[], e: Entry): boolean {
  if (list.some((x) => x.id === e.id)) return false;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byNewest(list[mid]!, e) <= 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, e);
  return true;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Timelines {
  readonly #o: Options;
  readonly mode: Mode;
  readonly #byAuthor = new Map<string, Entry[]>();
  readonly #feeds = new Map<string, { entries: Entry[]; oldestKept: number | undefined }>();
  readonly #settings = new Map<string, ViewerSettings>();
  readonly #publicAll: Entry[] = [];
  #writes = 0;

  constructor(o: Options) {
    this.#o = o;
    this.mode = o.mode ?? 'hybrid';
  }

  /** Number of feed writes done by fan-out so far. */
  stats(): { fanoutWrites: number } {
    return { fanoutWrites: this.#writes };
  }

  setSettings(viewer: string, s: ViewerSettings): void {
    if ((s.filters?.length ?? 0) > 50) throw new TimelineError('at most 50 filters');
    for (const f of s.filters ?? []) if (f.keywords.length > 100 || f.keywords.some((k) => k.text.trim() === '' || k.text.length > 200)) throw new TimelineError('a filter has up to 100 keywords of 1 to 200 characters');
    this.#settings.set(viewer, s);
  }

  #isCelebrity(author: string): boolean {
    return this.mode === 'read' || (this.mode === 'hybrid' && this.#o.graph.followersOf(author).length >= (this.#o.celebrityFollowers ?? 1000));
  }

  #feed(user: string) {
    let f = this.#feeds.get(user);
    if (!f) this.#feeds.set(user, (f = { entries: [], oldestKept: undefined }));
    return f;
  }

  #push(user: string, e: Entry, counted = true): boolean {
    const f = this.#feed(user);
    if (!insertSorted(f.entries, { ...e })) return false;
    if (counted) this.#writes++;
    const cap = this.#o.maxFeed ?? 800;
    while (f.entries.length > cap) {
      f.entries.pop();
      f.oldestKept = f.entries[f.entries.length - 1]!.ts;
    }
    return true;
  }

  /** Record a new status (or a boost) and fan it out as the mode says. Late or repeated calls are safe. */
  publish(s: Status): void {
    const e: Entry = { id: s.id, ts: s.createdAt, author: s.author };
    const mine = this.#byAuthor.get(s.author) ?? [];
    insertSorted(mine, e);
    this.#byAuthor.set(s.author, mine);
    if (s.visibility === 'public' && !s.boostOf) insertSorted(this.#publicAll, e);
    if (s.visibility === 'direct') return;
    this.#push(s.author, e, false);
    if (this.#isCelebrity(s.author)) return;
    for (const f of this.#o.graph.followersOf(s.author)) if (f !== s.author) this.#push(f, e);
  }

  /** Stored feeds get no entry when read mode is on; the author's own feed gets theirs so they see their posts. */
  #candidates(viewer: string): Entry[] {
    const f = this.#feeds.get(viewer);
    const out = new Map<string, Entry>((f?.entries ?? []).map((e) => [e.id, e]));
    const follows = new Set([...this.#o.graph.followingOf(viewer)]);
    const pulled = new Set<string>();
    for (const a of follows) if (this.mode === 'read' || (this.mode === 'hybrid' && this.#isCelebrity(a))) pulled.add(a);
    if (this.mode === 'write' || this.mode === 'hybrid') if (f?.oldestKept !== undefined) for (const a of follows) pulled.add(a);
    for (const a of pulled) for (const e of this.#byAuthor.get(a) ?? []) out.set(e.id, e);
    if (this.mode === 'read') for (const e of this.#byAuthor.get(viewer) ?? []) out.set(e.id, e);
    return [...out.values()].filter((e) => e.author === viewer || follows.has(e.author)).sort(byNewest);
  }

  #muted(viewer: string, actor: string): boolean {
    const until = this.#settings.get(viewer)?.mutedAccounts?.[actor];
    return until !== undefined && (until === null || this.#o.now() < until);
  }

  #root(s: Status): string {
    let cur = s;
    for (let i = 0; i < 100 && cur.inReplyTo; i++) {
      const p = this.#o.mb.get(cur.inReplyTo);
      if (!p) break;
      cur = p;
    }
    return cur.id;
  }

  #filterText(s: Status): string {
    return [s.text, s.spoilerText, ...s.media.map((m) => m.description), ...(s.poll?.options.map((o) => o.title) ?? [])].join('\n');
  }

  /** The keyword filters of a viewer that match a status in a context. */
  matchingFilters(viewer: string, s: Status, ctx: Context): KeywordFilter[] {
    const out: KeywordFilter[] = [];
    const text = this.#filterText(s);
    for (const f of this.#settings.get(viewer)?.filters ?? []) {
      if (!f.contexts.includes(ctx)) continue;
      if (f.expiresAt !== undefined && this.#o.now() >= f.expiresAt) continue;
      const hit = f.keywords.some((k) => (k.wholeWord ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(k.text)}(?![\\p{L}\\p{N}_])`, 'iu') : new RegExp(escapeRe(k.text), 'iu')).test(text));
      if (hit) out.push(f);
    }
    return out;
  }

  #hydrate(viewer: string, e: Entry, ctx: Context): TimelineItem | undefined {
    const mb = this.#o.mb;
    const s = mb.get(e.id);
    if (!s || !mb.canSee(viewer, s)) return undefined;
    const original = s.boostOf ? mb.get(s.boostOf) : undefined;
    if (s.boostOf && (!original || !mb.canSee(viewer, original))) return undefined;
    const set = this.#settings.get(viewer);
    const shown = original ?? s;
    if (viewer !== s.author) {
      if (this.#muted(viewer, s.author) || this.#muted(viewer, shown.author)) return undefined;
      if (set?.blockedDomains?.includes(this.#o.domainOf(shown.author)) || set?.blockedDomains?.includes(this.#o.domainOf(s.author))) return undefined;
    }
    if (s.boostOf && set?.hideBoostsFrom?.includes(s.author)) return undefined;
    if (set?.mutedThreads?.includes(this.#root(shown))) return undefined;
    if (ctx === 'home' && shown.inReplyTo && set?.replies === 'followed' && shown.author !== viewer) {
      const parent = mb.get(shown.inReplyTo);
      const to = parent?.author;
      const follows = this.#o.graph.followingOf(viewer);
      if (!(to !== undefined && (to === viewer || to === shown.author || follows.includes(to)))) return undefined;
    }
    const matched = this.matchingFilters(viewer, shown, ctx);
    if (matched.some((f) => f.action === 'hide')) return undefined;
    return { status: s, original, filtered: matched.map((f) => f.title) };
  }

  /** Every item of a timeline for a viewer, newest first, filtered and with repeated boosts folded. */
  #all(viewer: string | undefined, t: TimelineKind): { entry: Entry; item: TimelineItem }[] {
    let ctx: Context;
    let entries: Entry[];
    const v = viewer ?? '';
    switch (t.kind) {
      case 'home':
        if (viewer === undefined) throw new TimelineError('the home timeline needs a signed-in reader');
        ctx = 'home';
        entries = this.#candidates(viewer);
        break;
      case 'local':
      case 'federated':
        ctx = 'public';
        entries = this.#publicAll.filter((e) => t.kind === 'federated' || this.#o.isLocal(e.author));
        break;
      case 'tag':
        ctx = 'tags';
        entries = this.#publicAll.filter((e) => this.#o.mb.get(e.id)?.tags.includes(t.tag.toLowerCase().replace(/^#/, '')));
        break;
      case 'list': {
        if (viewer === undefined) throw new TimelineError('a list timeline needs its owner');
        ctx = 'lists';
        const ids = new Set(this.#o.mb.listStatuses(viewer, t.id).map((s) => s.id));
        entries = [...this.#byAuthor.values()].flat().filter((e) => ids.has(e.id)).sort(byNewest);
        break;
      }
    }
    const seenOriginal = new Set<string>();
    const out: { entry: Entry; item: TimelineItem }[] = [];
    for (const e of entries) {
      const item = this.#hydrate(v, e, ctx);
      if (!item) continue;
      const key = (item.original ?? item.status).id;
      if (t.kind === 'home') {
        if (seenOriginal.has(key)) continue;
        seenOriginal.add(key);
      }
      out.push({ entry: e, item });
    }
    return out;
  }

  /** One page of a timeline, newest first. `after` is the cursor from the previous page. */
  view(viewer: string | undefined, t: TimelineKind, q: { limit?: number; after?: string } = {}): Page {
    const all = this.#all(viewer, t);
    const rows = all.map((x) => x.entry);
    const p = page(SPEC, rows, { sort: { field: 'ts', dir: 'desc' }, limit: Math.min(q.limit ?? 20, 40), ...(q.after ? { after: q.after } : {}) });
    const byId = new Map(all.map((x) => [x.entry.id, x.item]));
    return { items: p.rows.map((r) => byId.get(r.id)!), next: p.next };
  }

  /** Ids of a whole timeline, newest first (for comparing with what a client holds). */
  ids(viewer: string | undefined, t: TimelineKind): string[] {
    return this.#all(viewer, t).map((x) => x.entry.id);
  }

  /** Name the holes between what a client has loaded (newest first) and the timeline as it is now. */
  detectGaps(viewer: string | undefined, t: TimelineKind, loaded: readonly string[]): Gap[] {
    const full = this.ids(viewer, t);
    const pos = new Map(full.map((id, i) => [id, i]));
    const known = loaded.filter((id) => pos.has(id)).sort((a, b) => pos.get(a)! - pos.get(b)!);
    const gaps: Gap[] = [];
    if (known.length === 0) return [];
    if (pos.get(known[0]!)! > 0) gaps.push({ above: undefined, below: known[0]!, missing: pos.get(known[0]!)! });
    for (let i = 0; i + 1 < known.length; i++) {
      const d = pos.get(known[i + 1]!)! - pos.get(known[i]!)! - 1;
      if (d > 0) gaps.push({ above: known[i]!, below: known[i + 1]!, missing: d });
    }
    return gaps;
  }

  /** The items inside a gap (strictly between its ends), newest first, at most `limit`. */
  fillGap(viewer: string | undefined, t: TimelineKind, gap: Gap, limit = 40): TimelineItem[] {
    const all = this.#all(viewer, t);
    const top = gap.above === undefined ? 0 : all.findIndex((x) => x.entry.id === gap.above) + 1;
    const bottom = all.findIndex((x) => x.entry.id === gap.below);
    if (bottom < 0 || (gap.above !== undefined && top === 0)) return [];
    // fill from the newer end so a client can keep calling until the gap closes
    return all.slice(top, bottom).slice(0, limit).map((x) => x.item);
  }

  /** Throw a reader's stored feed away and rebuild it from the people they follow. Returns the entries now held. */
  rebuildHome(viewer: string): number {
    this.#feeds.delete(viewer);
    const f = this.#feed(viewer);
    const sources = [viewer, ...this.#o.graph.followingOf(viewer)];
    for (const a of sources) {
      if (this.mode === 'read' || this.#isCelebrity(a)) continue;
      for (const e of this.#byAuthor.get(a) ?? []) insertSorted(f.entries, { ...e });
    }
    this.#writes += f.entries.length;
    const cap = this.#o.maxFeed ?? 800;
    if (f.entries.length > cap) {
      f.entries.length = cap;
      f.oldestKept = f.entries[cap - 1]!.ts;
    }
    return f.entries.length;
  }

  /** After a new follow: bring that account's recent statuses into the reader's stored feed. */
  backfill(viewer: string, author: string, limit = 40): number {
    if (this.mode === 'read' || this.#isCelebrity(author)) return 0;
    let n = 0;
    for (const e of (this.#byAuthor.get(author) ?? []).slice(0, limit)) if (this.#push(viewer, e)) n++;
    return n;
  }

  /** After an unfollow, a block or a mute: drop that author's entries from the reader's stored feed. */
  forget(viewer: string, author: string): number {
    const f = this.#feeds.get(viewer);
    if (!f) return 0;
    const before = f.entries.length;
    f.entries = f.entries.filter((e) => e.author !== author);
    return before - f.entries.length;
  }
}

/** Join two newest-first lists of items by status id, newest first, without repeats. */
export function mergeItems(a: readonly TimelineItem[], b: readonly TimelineItem[]): TimelineItem[] {
  const seen = new Map<string, TimelineItem>();
  for (const i of [...a, ...b]) if (!seen.has(i.status.id)) seen.set(i.status.id, i);
  return [...seen.values()].sort((x, y) => y.status.createdAt - x.status.createdAt || (x.status.id < y.status.id ? 1 : -1));
}
