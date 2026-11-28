/**
 * Playlists of every kind a media server has, and what goes with them.
 *
 *  - Manual playlists: an ordered list of entries (each with its own id, so the same track may appear twice and a
 *    move or removal names the entry, not the track), add, insert, move, remove, de-duplicate, a version that
 *    refuses a stale edit, who owns it and who can see it (private, unlisted, public).
 *  - Smart playlists: a rule tree (`all`, `any`, `not`, and field tests) over the library, with sorting on several
 *    keys, a limit by count or by total duration, and a seeded random order. Every field has a type and each
 *    operator only fits some types, so a rule is checked before it runs; strings compare without case or accents;
 *    dates compare against an injected clock ("in the last 30 days"); `inPlaylist` pulls in another playlist, with
 *    a depth limit and cycle detection. There is no regular-expression operator, so a rule cannot hang the server.
 *  - Ordering: natural sort ("Track 2" before "Track 10"), accents and a leading article ignored, albums in disc and
 *    track order, equal keys kept in their original order.
 *  - Shuffle: a Fisher-Yates shuffle from a seed, with unbiased choices (rejection sampling on a counter-mode
 *    SHA-256 stream), so the same seed always gives the same order and every order is equally likely; a spread
 *    shuffle that keeps one artist's tracks apart; and a shuffle bag that plays everything once before it repeats,
 *    never starts the next round with the track it just played, and slips tracks added mid-round into the part not
 *    yet played instead of reshuffling what has been heard.
 *  - Share links: random tokens kept as hashes, view or collaborate, with an expiry, a use limit, an optional
 *    password (scrypt) and a lock after repeated wrong passwords; revoking ends it at once.
 *  - Extended M3U in and out, refusing control characters and bounded in size.
 *
 * Not here: the media library itself, playing, and syncing to outside services. Clock and randomness are arguments.
 */
import { createHash, randomBytes as nodeRandomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export class PlaylistError extends Error {}
export class StaleVersion extends PlaylistError {}
export class PlaylistCycle extends PlaylistError {}
export class BadRule extends PlaylistError {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the rule is not valid: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

// ---------------------------------------------------------------- text and order

/** Lower case, accents removed, punctuation made into spaces: how text is compared. */
export const fold = (s: string): string => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^\p{L}\p{Nd}]+/gu, ' ').trim();
const ARTICLE = /^(the|a|an|der|die|das|le|la|les|el|los|las|il)\s+/;

/** The text a sort sees: folded, and without a leading article if asked. */
export const sortKey = (s: string, articles = true): string => {
  const f = fold(s);
  return articles ? f.replace(ARTICLE, '') : f;
};

/** Compare with numbers inside the text as numbers: "track 2" before "track 10". */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) ?? [];
  const bx = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i]!;
    const y = bx[i]!;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = BigInt(x) - BigInt(y);
      if (d !== 0n) return d < 0n ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}

// ---------------------------------------------------------------- items and fields

export type Scalar = string | number | boolean | null | undefined;

export interface Item {
  readonly id: string;
  readonly [field: string]: Scalar | readonly string[];
}

export type FieldType = 'string' | 'number' | 'date' | 'boolean' | 'list';

export const MUSIC_FIELDS: Readonly<Record<string, FieldType>> = {
  title: 'string', artist: 'string', album: 'string', albumArtist: 'string', path: 'string', genre: 'list', year: 'number', durationMs: 'number', playCount: 'number', rating: 'number', bpm: 'number', trackNo: 'number', discNo: 'number',
  addedAt: 'date', lastPlayedAt: 'date', releasedAt: 'date', favourite: 'boolean',
};

const OPS: Readonly<Record<FieldType, readonly string[]>> = {
  string: ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'exists', 'missing'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'missing'],
  date: ['before', 'after', 'on', 'inLast', 'notInLast', 'exists', 'missing'],
  boolean: ['isTrue', 'isFalse'],
  list: ['has', 'hasNone', 'hasAny', 'exists', 'missing'],
};

export type Rule =
  | { readonly all: readonly Rule[] }
  | { readonly any: readonly Rule[] }
  | { readonly not: Rule }
  | { readonly field: string; readonly op: string; readonly value?: unknown; readonly value2?: unknown }
  | { readonly inPlaylist: string }
  | { readonly notInPlaylist: string };

const MAX_DEPTH = 8;
const MAX_NODES = 200;

/** Everything wrong with a rule, by place; empty when it can run. */
export function ruleProblems(rule: Rule, fields: Readonly<Record<string, FieldType>> = MUSIC_FIELDS): string[] {
  const out: string[] = [];
  let nodes = 0;
  const walk = (r: Rule, depth: number, at: string) => {
    if (++nodes > MAX_NODES) {
      if (nodes === MAX_NODES + 1) out.push(`more than ${MAX_NODES} tests`);
      return;
    }
    if (depth > MAX_DEPTH) {
      out.push(`${at}: nested deeper than ${MAX_DEPTH}`);
      return;
    }
    if (typeof r !== 'object' || r === null) return void out.push(`${at}: not a rule`);
    if ('all' in r || 'any' in r) {
      const list = 'all' in r ? r.all : r.any;
      if (!Array.isArray(list) || !list.length) out.push(`${at}: all/any need at least one rule`);
      else list.forEach((x, i) => walk(x as Rule, depth + 1, `${at}.${'all' in r ? 'all' : 'any'}[${i}]`));
    } else if ('not' in r) walk(r.not, depth + 1, `${at}.not`);
    else if ('inPlaylist' in r || 'notInPlaylist' in r) {
      const id = 'inPlaylist' in r ? r.inPlaylist : r.notInPlaylist;
      if (typeof id !== 'string' || !id) out.push(`${at}: a playlist id is needed`);
    } else if ('field' in r) {
      const t = fields[r.field];
      if (!t) return void out.push(`${at}: unknown field ${JSON.stringify(String(r.field).slice(0, 40))}`);
      if (!OPS[t].includes(r.op)) return void out.push(`${at}: ${r.field} is ${t}; ${JSON.stringify(String(r.op).slice(0, 40))} does not apply`);
      const needs = !['exists', 'missing', 'isTrue', 'isFalse'].includes(r.op);
      if (!needs) return;
      if (t === 'string' && typeof r.value !== 'string') out.push(`${at}: ${r.field} ${r.op} needs text`);
      else if (t === 'list' && (r.op === 'has' ? typeof r.value !== 'string' : !Array.isArray(r.value) || !r.value.every((v) => typeof v === 'string'))) out.push(`${at}: ${r.field} ${r.op} needs ${r.op === 'has' ? 'text' : 'a list of text'}`);
      else if (t === 'number') {
        if (typeof r.value !== 'number' || !Number.isFinite(r.value)) out.push(`${at}: ${r.field} ${r.op} needs a number`);
        if (r.op === 'between' && (typeof r.value2 !== 'number' || !Number.isFinite(r.value2))) out.push(`${at}: between needs two numbers`);
      } else if (t === 'date') {
        if (r.op === 'inLast' || r.op === 'notInLast') {
          if (typeof r.value !== 'number' || !(r.value > 0)) out.push(`${at}: ${r.op} needs a number of days`);
        } else if (typeof r.value !== 'string' || Number.isNaN(Date.parse(r.value))) out.push(`${at}: ${r.field} ${r.op} needs a date`);
      }
    } else out.push(`${at}: not a rule`);
  };
  walk(rule, 0, 'rule');
  return out;
}

export interface EvalContext {
  readonly now: () => number;
  readonly fields?: Readonly<Record<string, FieldType>>;
  /** Members of another playlist, for `inPlaylist`; a smart playlist's members come from running it. */
  readonly members?: (playlistId: string) => ReadonlySet<string> | undefined;
}

const asTime = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
};

const DAY = 86_400_000;

/** Does the item satisfy the rule? The rule should have been checked with `ruleProblems`. */
export function matches(rule: Rule, item: Item, ctx: EvalContext): boolean {
  const fields = ctx.fields ?? MUSIC_FIELDS;
  if ('all' in rule) return rule.all.every((r) => matches(r, item, ctx));
  if ('any' in rule) return rule.any.some((r) => matches(r, item, ctx));
  if ('not' in rule) return !matches(rule.not, item, ctx);
  if ('inPlaylist' in rule || 'notInPlaylist' in rule) {
    const id = 'inPlaylist' in rule ? rule.inPlaylist : rule.notInPlaylist;
    const m = ctx.members?.(id);
    if (!m) throw new PlaylistError(`no playlist ${id}`);
    return m.has(item.id) === ('inPlaylist' in rule);
  }
  const t = fields[rule.field]!;
  const v = item[rule.field];
  const has = v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
  if (rule.op === 'exists') return has;
  if (rule.op === 'missing') return !has;
  if (t === 'boolean') return rule.op === 'isTrue' ? v === true : v !== true;
  if (t === 'string') {
    if (!has) return rule.op === 'isNot' || rule.op === 'notContains';
    const a = fold(String(v));
    const b = fold(rule.value as string);
    return rule.op === 'is' ? a === b : rule.op === 'isNot' ? a !== b : rule.op === 'contains' ? a.includes(b) : rule.op === 'notContains' ? !a.includes(b) : rule.op === 'startsWith' ? a.startsWith(b) : a.endsWith(b);
  }
  if (t === 'list') {
    const list = (has ? (Array.isArray(v) ? v : [String(v)]) : []).map((x) => fold(String(x)));
    if (rule.op === 'has') return list.includes(fold(rule.value as string));
    const want = (rule.value as string[]).map(fold);
    return rule.op === 'hasAny' ? want.some((w) => list.includes(w)) : !want.some((w) => list.includes(w));
  }
  if (t === 'number') {
    if (!has || typeof v !== 'number') return rule.op === 'ne';
    const x = rule.value as number;
    switch (rule.op) {
      case 'eq': return v === x;
      case 'ne': return v !== x;
      case 'gt': return v > x;
      case 'gte': return v >= x;
      case 'lt': return v < x;
      case 'lte': return v <= x;
      default: return v >= Math.min(x, rule.value2 as number) && v <= Math.max(x, rule.value2 as number);
    }
  }
  // dates
  const when = asTime(v);
  if (when === undefined) return rule.op === 'notInLast';
  if (rule.op === 'inLast') return when <= ctx.now() && when >= ctx.now() - (rule.value as number) * DAY;
  if (rule.op === 'notInLast') return !(when <= ctx.now() && when >= ctx.now() - (rule.value as number) * DAY);
  const day = (ms: number) => Math.floor(ms / DAY);
  const ref = asTime(rule.value)!;
  return rule.op === 'before' ? when < ref : rule.op === 'after' ? when > ref : day(when) === day(ref);
}

// ---------------------------------------------------------------- sorting

export interface SortKey {
  readonly field: string;
  readonly dir?: 'asc' | 'desc';
}

/** Items sorted on several keys. Equal items keep their order. Missing values go last whichever way it sorts. */
export function sortItems<T extends Item>(items: readonly T[], keys: readonly SortKey[], fields: Readonly<Record<string, FieldType>> = MUSIC_FIELDS): T[] {
  for (const k of keys) if (!fields[k.field]) throw new PlaylistError(`cannot sort by unknown field ${k.field}`);
  const cmp = (a: T, b: T): number => {
    for (const k of keys) {
      const t = fields[k.field]!;
      const x = a[k.field];
      const y = b[k.field];
      const xm = x === undefined || x === null || x === '';
      const ym = y === undefined || y === null || y === '';
      if (xm && ym) continue;
      if (xm) return 1;
      if (ym) return -1;
      let c: number;
      if (t === 'string') c = naturalCompare(sortKey(String(x)), sortKey(String(y)));
      else if (t === 'list') c = naturalCompare(sortKey(String((x as readonly string[])[0] ?? '')), sortKey(String((y as readonly string[])[0] ?? '')));
      else if (t === 'date') c = (asTime(x) ?? 0) - (asTime(y) ?? 0);
      else if (t === 'boolean') c = Number(x === true) - Number(y === true);
      else c = (x as number) - (y as number);
      if (c !== 0) return k.dir === 'desc' ? -Math.sign(c) : Math.sign(c);
    }
    return 0;
  };
  return items.map((x, i) => ({ x, i })).sort((p, q) => cmp(p.x, q.x) || p.i - q.i).map((p) => p.x);
}

/** Album order: album, disc, track, then title. */
export const ALBUM_ORDER: readonly SortKey[] = [{ field: 'albumArtist' }, { field: 'album' }, { field: 'discNo' }, { field: 'trackNo' }, { field: 'title' }];

// ---------------------------------------------------------------- shuffle

/** A deterministic stream of random numbers from a seed: SHA-256 of the seed and a counter. */
export class Rng {
  private counter = 0;
  private pool = Buffer.alloc(0);
  private readonly seed: string;

  constructor(seed: string) {
    this.seed = seed;
  }

  private u32(): number {
    if (this.pool.length < 4) this.pool = createHash('sha256').update(`${this.seed}\u0000${this.counter++}`).digest();
    const v = this.pool.readUInt32BE(0);
    this.pool = this.pool.subarray(4);
    return v;
  }

  /** A whole number from 0 up to but not including n, every value equally likely. */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new PlaylistError('n is a whole number from 1 to 2^32');
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const v = this.u32();
      if (v < limit) return v % n;
    }
  }

  /** A number from 0 up to but not including 1. */
  float(): number {
    return (this.u32() * 2 ** 21 + (this.u32() >>> 11)) / 2 ** 53;
  }
}

/** Fisher-Yates: every order equally likely, the same seed the same order. */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const a = [...items];
  const rng = new Rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * A shuffle that keeps each artist (or any key) spread over the whole list. Each group is shuffled and its members
 * placed at even steps with a random start, then everything is merged by position, so groups of similar size never
 * play back to back and the order still changes with the seed.
 */
export function shuffleSpread<T>(items: readonly T[], key: (x: T) => string, seed: string): T[] {
  const rng = new Rng(seed);
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const placed: { x: T; at: number; tie: number }[] = [];
  for (const k of [...groups.keys()].sort()) {
    const g = shuffle(groups.get(k)!, `${seed}\u0000${k}`);
    const start = rng.float();
    g.forEach((x, i) => placed.push({ x, at: (i + start) / g.length, tie: rng.float() }));
  }
  return placed.sort((p, q) => p.at - q.at || p.tie - q.tie).map((p) => p.x);
}

export interface Bag<T> {
  readonly order: readonly T[];
  /** Index of the next item to play. */
  readonly cursor: number;
  readonly round: number;
  readonly seed: string;
}

const same = <T>(a: T, b: T, eq: (a: T, b: T) => boolean) => eq(a, b);

/** A shuffle bag: everything plays once per round. A new round never begins with the item that just ended the last. */
export function newBag<T>(items: readonly T[], seed: string): Bag<T> {
  return { order: shuffle(items, `${seed}\u0000r0`), cursor: 0, round: 0, seed };
}

/** Take the next item; the bag after it is a new value (the old one is unchanged). */
export function nextInBag<T>(bag: Bag<T>, eq: (a: T, b: T) => boolean = Object.is): { item: T | undefined; bag: Bag<T> } {
  if (!bag.order.length) return { item: undefined, bag };
  let b = bag;
  if (b.cursor >= b.order.length) {
    const last = b.order[b.order.length - 1]!;
    let order = shuffle(b.order, `${b.seed}\u0000r${b.round + 1}`);
    if (order.length > 1 && same(order[0]!, last, eq)) {
      const j = 1 + new Rng(`${b.seed}\u0000fix${b.round + 1}`).int(order.length - 1);
      [order[0], order[j]] = [order[j]!, order[0]!];
    }
    b = { order, cursor: 0, round: b.round + 1, seed: b.seed };
  }
  return { item: b.order[b.cursor]!, bag: { ...b, cursor: b.cursor + 1 } };
}

/** Add items to the part of the round not yet played, at random places; what was heard is not reshuffled. */
export function addToBag<T>(bag: Bag<T>, added: readonly T[], salt: string): Bag<T> {
  const rng = new Rng(`${bag.seed}\u0000add\u0000${bag.round}\u0000${salt}`);
  const order = [...bag.order];
  for (const x of added) order.splice(bag.cursor + rng.int(order.length - bag.cursor + 1), 0, x);
  return { ...bag, order };
}

export function removeFromBag<T>(bag: Bag<T>, gone: (x: T) => boolean): Bag<T> {
  const heard = bag.order.slice(0, bag.cursor).filter((x) => !gone(x)).length;
  return { ...bag, order: bag.order.filter((x) => !gone(x)), cursor: heard };
}

// ---------------------------------------------------------------- manual playlists

export type Visibility = 'private' | 'unlisted' | 'public';

export interface Entry {
  readonly id: string;
  readonly item: string;
}

export interface Playlist {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: Visibility;
  readonly collaborators: readonly string[];
  readonly entries: readonly Entry[];
  readonly version: number;
}

export interface Smart {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: Visibility;
  readonly rule: Rule;
  readonly sort?: readonly SortKey[];
  /** Random order from this seed, instead of `sort`. */
  readonly shuffleSeed?: string;
  readonly limit?: { readonly count?: number; readonly durationMs?: number };
}

const MAX_ENTRIES = 20_000;

export function createPlaylist(id: string, owner: string, name: string, visibility: Visibility = 'private'): Playlist {
  if (!name.trim() || name.length > 200) throw new PlaylistError('a name is 1 to 200 characters');
  return { id, owner, name: name.trim(), visibility, collaborators: [], entries: [], version: 1 };
}

const guard = (p: Playlist, version: number) => {
  if (version !== p.version) throw new StaleVersion(`the playlist is at version ${p.version}; you edited ${version}`);
};
const bump = (p: Playlist, entries: readonly Entry[]): Playlist => ({ ...p, entries, version: p.version + 1 });

export function canEdit(p: Playlist, user: string): boolean {
  return p.owner === user || p.collaborators.includes(user);
}

export function addEntries(p: Playlist, version: number, items: readonly string[], newId: () => string, at?: number): Playlist {
  guard(p, version);
  if (p.entries.length + items.length > MAX_ENTRIES) throw new PlaylistError(`a playlist holds at most ${MAX_ENTRIES} entries`);
  if (at !== undefined && (!Number.isInteger(at) || at < 0 || at > p.entries.length)) throw new PlaylistError('no such position');
  for (const i of items) if (!i || i.length > 200) throw new PlaylistError('an item id is 1 to 200 characters');
  const added = items.map((item) => ({ id: newId(), item }));
  const entries = [...p.entries];
  entries.splice(at ?? entries.length, 0, ...added);
  return bump(p, entries);
}

export function removeEntries(p: Playlist, version: number, entryIds: readonly string[]): Playlist {
  guard(p, version);
  const gone = new Set(entryIds);
  if (entryIds.some((id) => !p.entries.some((e) => e.id === id))) throw new PlaylistError('no such entry');
  return bump(p, p.entries.filter((e) => !gone.has(e.id)));
}

export function moveEntry(p: Playlist, version: number, entryId: string, to: number): Playlist {
  guard(p, version);
  const from = p.entries.findIndex((e) => e.id === entryId);
  if (from < 0) throw new PlaylistError('no such entry');
  if (!Number.isInteger(to) || to < 0 || to >= p.entries.length) throw new PlaylistError('no such position');
  const entries = [...p.entries];
  entries.splice(to, 0, ...entries.splice(from, 1));
  return bump(p, entries);
}

/** Keep the first of each track. */
export function dedupe(p: Playlist, version: number): Playlist {
  guard(p, version);
  const seen = new Set<string>();
  return bump(p, p.entries.filter((e) => (seen.has(e.item) ? false : (seen.add(e.item), true))));
}

/** Reorder by a sort over the library (entries whose track is gone go last, in order). */
export function sortPlaylist(p: Playlist, version: number, library: ReadonlyMap<string, Item>, keys: readonly SortKey[]): Playlist {
  guard(p, version);
  const rows = p.entries.map((e) => ({ e, it: library.get(e.item) }));
  const known = sortItems(rows.filter((r) => r.it).map((r) => ({ ...r.it!, id: r.e.id, __entry: r.e.id }) as unknown as Item), keys);
  const order = new Map(known.map((x, i) => [(x as unknown as { __entry: string }).__entry, i]));
  const byId = new Map(p.entries.map((e) => [e.id, e]));
  return bump(p, [...known.map((x) => byId.get((x as unknown as { __entry: string }).__entry)!), ...p.entries.filter((e) => !order.has(e.id))]);
}

/** Who can see it: the owner and collaborators always; anyone when public; others only by a link when unlisted. */
export function canView(p: Playlist | Smart, user: string | undefined, viaLink = false): boolean {
  const owner = p.owner === user;
  const collab = 'collaborators' in p && user !== undefined && p.collaborators.includes(user);
  return owner || collab || p.visibility === 'public' || (p.visibility === 'unlisted' && viaLink);
}

// ---------------------------------------------------------------- running smart playlists

export interface Library {
  readonly items: readonly Item[];
  /** Another playlist by id, manual or smart. */
  readonly playlist?: (id: string) => Playlist | Smart | undefined;
  readonly fields?: Readonly<Record<string, FieldType>>;
}

/** The ids of a smart playlist's members, in order. */
export function runSmart(s: Smart, lib: Library, now: () => number, trail: readonly string[] = []): string[] {
  const fields = lib.fields ?? MUSIC_FIELDS;
  const problems = ruleProblems(s.rule, fields);
  if (problems.length) throw new BadRule(problems);
  if (trail.includes(s.id)) throw new PlaylistCycle(`playlists refer to each other: ${[...trail, s.id].join(' -> ')}`);
  if (trail.length >= 5) throw new PlaylistError('playlists refer to each other more than five deep');
  const members = (id: string): ReadonlySet<string> | undefined => {
    const p = lib.playlist?.(id);
    if (!p) return undefined;
    if ('entries' in p) return new Set(p.entries.map((e) => e.item));
    return new Set(runSmart(p, lib, now, [...trail, s.id]));
  };
  const ctx: EvalContext = { now, fields, members };
  let hit = lib.items.filter((it) => matches(s.rule, it, ctx));
  hit = s.shuffleSeed !== undefined ? shuffle(hit, s.shuffleSeed) : s.sort?.length ? sortItems(hit, s.sort, fields) : hit;
  if (s.limit?.count !== undefined) hit = hit.slice(0, Math.max(0, s.limit.count));
  if (s.limit?.durationMs !== undefined) {
    let total = 0;
    const kept: Item[] = [];
    for (const it of hit) {
      const d = typeof it.durationMs === 'number' ? it.durationMs : 0;
      if (total + d > s.limit.durationMs) break;
      total += d;
      kept.push(it);
    }
    hit = kept;
  }
  return hit.map((i) => i.id);
}

// ---------------------------------------------------------------- share links

export type Permission = 'view' | 'collaborate';

export interface Link {
  readonly id: string;
  readonly playlist: string;
  readonly by: string;
  readonly permission: Permission;
  readonly expires?: number;
  readonly maxUses?: number;
  uses: number;
  revoked: boolean;
  failures: number;
  readonly salt?: Buffer;
  readonly passwordHash?: Buffer;
}

export interface LinkDeps {
  readonly now: () => number;
  readonly random: (n: number) => Uint8Array;
  /** Wrong passwords before the link locks. Default 5. */
  readonly maxFailures?: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const scrypt = (pw: string, salt: Buffer) => scryptSync(pw.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 });

/** Links to a playlist: the token is shown once and only its hash is kept. */
export class ShareLinks {
  private readonly links = new Map<string, Link>();
  private readonly d: LinkDeps;

  constructor(d: LinkDeps) {
    this.d = d;
  }

  create(playlist: string, by: string, o: { permission?: Permission; ttlMs?: number; maxUses?: number; password?: string } = {}): { token: string; link: Link } {
    if (o.password !== undefined && o.password.length < 4) throw new PlaylistError('a link password is at least 4 characters');
    if (o.maxUses !== undefined && (!Number.isInteger(o.maxUses) || o.maxUses < 1)) throw new PlaylistError('maxUses is a whole number of at least one');
    const token = Buffer.from(this.d.random(24)).toString('base64url');
    const salt = o.password !== undefined ? Buffer.from(this.d.random(16)) : undefined;
    const link: Link = {
      id: sha(token).slice(0, 12), playlist, by, permission: o.permission ?? 'view', uses: 0, revoked: false, failures: 0,
      ...(o.ttlMs !== undefined ? { expires: this.d.now() + o.ttlMs } : {}), ...(o.maxUses !== undefined ? { maxUses: o.maxUses } : {}),
      ...(salt ? { salt, passwordHash: scrypt(o.password!, salt) } : {}),
    };
    this.links.set(sha(token), link);
    return { token, link };
  }

  /** Open a link: the playlist and what it allows. Counts as a use. */
  open(token: string, password?: string): { playlist: string; permission: Permission } {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new PlaylistError('not a share link');
    const l = this.links.get(sha(token));
    if (!l || l.revoked) throw new PlaylistError('this link is not valid');
    if (l.expires !== undefined && this.d.now() > l.expires) throw new PlaylistError('this link has expired');
    if (l.maxUses !== undefined && l.uses >= l.maxUses) throw new PlaylistError('this link has been used up');
    if (l.passwordHash) {
      if (l.failures >= (this.d.maxFailures ?? 5)) throw new PlaylistError('this link is locked after too many wrong passwords');
      if (password === undefined || !timingSafeEqual(scrypt(password, l.salt!), l.passwordHash)) {
        l.failures++;
        throw new PlaylistError('wrong password');
      }
      l.failures = 0;
    }
    l.uses++;
    return { playlist: l.playlist, permission: l.permission };
  }

  revoke(linkId: string): boolean {
    for (const l of this.links.values()) if (l.id === linkId) return (l.revoked = true);
    return false;
  }

  forPlaylist(playlist: string): Link[] {
    return [...this.links.values()].filter((l) => l.playlist === playlist && !l.revoked);
  }
}

// ---------------------------------------------------------------- M3U

export interface M3uEntry {
  readonly path: string;
  readonly title?: string;
  readonly durationSec?: number;
}

export function toM3u(entries: readonly M3uEntry[]): string {
  const clean = (s: string) => {
    if (/[\u0000-\u001f]/.test(s)) throw new PlaylistError('a path or title has a control character');
    return s;
  };
  return ['#EXTM3U', ...entries.flatMap((e) => [`#EXTINF:${e.durationSec !== undefined ? Math.round(e.durationSec) : -1},${clean(e.title ?? '')}`, clean(e.path)])].join('\n') + '\n';
}

export function fromM3u(text: string, o: { maxEntries?: number } = {}): M3uEntry[] {
  if (text.length > 20_000_000) throw new PlaylistError('the playlist file is larger than 20 MB');
  const out: M3uEntry[] = [];
  let pending: { title?: string; durationSec?: number } = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line)) throw new PlaylistError('the file has control characters');
    const m = /^#EXTINF:(-?\d+(?:\.\d+)?)\s*,(.*)$/.exec(line);
    if (m) {
      pending = { durationSec: Number(m[1]) >= 0 ? Number(m[1]) : undefined as never, ...(m[2] ? { title: m[2]!.trim() } : {}) };
      if (pending.durationSec === undefined) delete pending.durationSec;
    } else if (!line.startsWith('#')) {
      out.push({ path: line, ...pending });
      pending = {};
      if (out.length > (o.maxEntries ?? 100_000)) throw new PlaylistError('too many entries');
    }
  }
  return out;
}

export const randomBytes = (n: number): Uint8Array => nodeRandomBytes(n);
