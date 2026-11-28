/**
 * Where each person is in each thing they watch or listen to, and what plays next, kept consistent across their
 * devices.
 *
 *  - Progress reports from a player ("I am at 41:10 of 1:32:00") are checked (finite, not past the end, not from
 *    the future) and kept as last-writer-wins registers: a progress register and a watched-mark register, each
 *    stamped with the time and the device, ties broken by device name. Play counts are one counter per device
 *    and merge by the larger value, so a report sent twice counts once. Merging two stores is commutative,
 *    associative and idempotent (the tests check each law), so devices and servers can sync in any order.
 *  - Thresholds decide what a stop means, by kind (video, episode, music, audiobook, podcast): below the minimum
 *    nothing is kept; between minimum and maximum there is a resume point; past the maximum (or within the last
 *    seconds) the item is watched and the resume point is cleared. Items too short to resume (a trailer) are
 *    just watched or not; music keeps only a play count. Numbers follow the usual media-server defaults (resume
 *    from 5% to 90%, items under 5 minutes do not resume) and can be set.
 *  - Marking watched or unwatched by hand is a stamped register too, so the later of a mark and a new play wins on
 *    every device. Watching again after a mark makes a resume point again without losing the watched flag.
 *  - Everything is per user: one user's state is never visible through another's id.
 *  - Continue-watching lists the unfinished items by most recent play; next-up gives the first unwatched episode of
 *    a series after what has been watched.
 *  - The play queue: entries with their own ids (so removing or moving one does not change what is playing), a
 *    current entry, repeat off, all or one, and a shuffle whose order is a stable hash ranking of the seed and the
 *    entry id, so adding or removing entries never reshuffles the rest. Saving the queue from a device uses the
 *    conflicts block's three-way merge: edits to different fields (repeat on one phone, an added track on another)
 *    combine; the same field edited differently comes back as a conflict to choose.
 *
 * Not here: the player, transcoding, and scrobbling to outside services. Times are milliseconds since the epoch and
 * come from the caller's clock.
 */
import { save as saveVersioned, type Versioned } from '../conflicts/index.ts';
import { createHash } from 'node:crypto';

export class PlaybackError extends Error {}

export type Kind = 'video' | 'episode' | 'music' | 'audiobook' | 'podcast';

export interface Thresholds {
  /** Percent of the duration before a stop keeps a resume point. */
  readonly minResumePct: number;
  /** Percent from which a stop counts as watched. */
  readonly maxResumePct: number;
  /** Items shorter than this do not get resume points. */
  readonly minResumeDurationMs: number;
  /** A stop this close to the end counts as watched whatever the percentage. */
  readonly endWindowMs: number;
  /** Music and the like: only count plays. */
  readonly resume: boolean;
}

export const DEFAULTS: Readonly<Record<Kind, Thresholds>> = {
  video: { minResumePct: 5, maxResumePct: 90, minResumeDurationMs: 300_000, endWindowMs: 0, resume: true },
  episode: { minResumePct: 5, maxResumePct: 90, minResumeDurationMs: 300_000, endWindowMs: 0, resume: true },
  music: { minResumePct: 0, maxResumePct: 50, minResumeDurationMs: Infinity, endWindowMs: 0, resume: false },
  audiobook: { minResumePct: 0, maxResumePct: 99, minResumeDurationMs: 0, endWindowMs: 30_000, resume: true },
  podcast: { minResumePct: 0, maxResumePct: 95, minResumeDurationMs: 0, endWindowMs: 20_000, resume: true },
};

export interface Verdict {
  /** Position to resume from, or undefined for none. */
  readonly resumeMs: number | undefined;
  readonly watched: boolean;
}

/** What a stop at a position means for an item of this kind and length. */
export function classify(kind: Kind, positionMs: number, durationMs: number, t: Thresholds = DEFAULTS[kind]): Verdict {
  if (!(durationMs > 0)) return { resumeMs: positionMs > 0 && t.resume ? positionMs : undefined, watched: false };
  const pct = (positionMs / durationMs) * 100;
  const watched = pct >= t.maxResumePct || (t.endWindowMs > 0 && durationMs - positionMs <= t.endWindowMs && positionMs > 0);
  if (watched) return { resumeMs: undefined, watched: true };
  if (!t.resume || durationMs < t.minResumeDurationMs || pct < t.minResumePct) return { resumeMs: undefined, watched: false };
  return { resumeMs: Math.floor(positionMs), watched: false };
}

// ---------------------------------------------------------------- state

export interface Stamp {
  readonly at: number;
  readonly device: string;
}

export interface Progress extends Stamp {
  readonly positionMs: number;
  readonly durationMs: number;
}

export interface Mark extends Stamp {
  readonly watched: boolean;
}

export interface ItemState {
  readonly progress?: Progress;
  readonly mark?: Mark;
  /** Completed plays, one counter per device. */
  readonly plays: Readonly<Record<string, number>>;
  /** The time of the last report taken from each device: a repeated or older report is not taken twice. */
  readonly last: Readonly<Record<string, number>>;
  readonly kind: Kind;
}

const later = (a: Stamp, b: Stamp) => a.at > b.at || (a.at === b.at && a.device > b.device);
const pick = <T extends Stamp>(a: T | undefined, b: T | undefined): T | undefined => (!a ? b : !b ? a : later(b, a) ? b : a);

/** The join of two item states: later register wins, play counts take the larger per device. */
export function mergeItem(a: ItemState, b: ItemState): ItemState {
  const plays: Record<string, number> = { ...a.plays };
  for (const [d, n] of Object.entries(b.plays)) plays[d] = Math.max(plays[d] ?? 0, n);
  const last: Record<string, number> = { ...a.last };
  for (const [d, n] of Object.entries(b.last)) last[d] = Math.max(last[d] ?? -Infinity, n);
  const progress = pick(a.progress, b.progress);
  const mark = pick(a.mark, b.mark);
  return { kind: a.kind <= b.kind ? a.kind : b.kind, plays, last, ...(progress ? { progress } : {}), ...(mark ? { mark } : {}) };
}

export interface View {
  readonly watched: boolean;
  readonly resumeMs: number | undefined;
  readonly playCount: number;
  readonly lastPlayedAt: number | undefined;
  readonly durationMs: number | undefined;
}

export function view(s: ItemState, thresholds?: Partial<Record<Kind, Thresholds>>): View {
  const watched = s.mark?.watched ?? false;
  const fresh = s.progress && (!s.mark || s.progress.at > s.mark.at) ? s.progress : undefined;
  const v = fresh ? classify(s.kind, fresh.positionMs, fresh.durationMs, thresholds?.[s.kind]) : { resumeMs: undefined, watched: false };
  return {
    watched,
    resumeMs: v.resumeMs,
    playCount: Object.values(s.plays).reduce((a, n) => a + n, 0),
    lastPlayedAt: s.progress?.at,
    durationMs: s.progress?.durationMs,
  };
}

export interface Report {
  readonly user: string;
  readonly item: string;
  readonly kind: Kind;
  readonly device: string;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly at: number;
  /** `progress` while playing; `stop` when it stops; `finish` when the player reached the end. */
  readonly event: 'progress' | 'stop' | 'finish';
}

const ID = /^[^\u0000-\u001f]{1,200}$/;

export type Snapshot = Record<string, Record<string, ItemState>>;

export class PlaybackStore {
  private readonly users = new Map<string, Map<string, ItemState>>();
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly t: Partial<Record<Kind, Thresholds>>;

  constructor(o: { now: () => number; skewMs?: number; thresholds?: Partial<Record<Kind, Thresholds>> }) {
    this.now = o.now;
    this.skewMs = o.skewMs ?? 300_000;
    this.t = o.thresholds ?? {};
  }

  private table(user: string): Map<string, ItemState> {
    let t = this.users.get(user);
    if (!t) this.users.set(user, (t = new Map()));
    return t;
  }

  get(user: string, item: string): ItemState | undefined {
    return this.users.get(user)?.get(item);
  }

  view(user: string, item: string): View {
    const s = this.get(user, item);
    return s ? view(s, this.t) : { watched: false, resumeMs: undefined, playCount: 0, lastPlayedAt: undefined, durationMs: undefined };
  }

  /** Take a player's report. Returns the item's state, or undefined for a stale repeat that changed nothing. */
  report(r: Report): ItemState | undefined {
    if (!ID.test(r.user) || !ID.test(r.item) || !ID.test(r.device)) throw new PlaybackError('user, item and device are 1 to 200 characters');
    if (!Number.isFinite(r.positionMs) || r.positionMs < 0) throw new PlaybackError('a position is zero or more');
    if (!Number.isFinite(r.durationMs) || r.durationMs < 0 || r.durationMs > 7 * 86_400_000) throw new PlaybackError('a duration is zero to seven days');
    if (r.durationMs > 0 && r.positionMs > r.durationMs * 1.01 + 5000) throw new PlaybackError('the position is past the end');
    if (!Number.isFinite(r.at) || r.at > this.now() + this.skewMs) throw new PlaybackError('the report is from the future');
    const th = this.t[r.kind] ?? DEFAULTS[r.kind];
    const tab = this.table(r.user);
    const cur = tab.get(r.item);
    if (cur && r.at <= (cur.last[r.device] ?? -Infinity)) return undefined;
    const pos = r.event === 'finish' && r.durationMs > 0 ? r.durationMs : Math.min(r.positionMs, r.durationMs || r.positionMs);
    const progress: Progress = { at: r.at, device: r.device, positionMs: Math.floor(pos), durationMs: Math.floor(r.durationMs) };
    let next: ItemState = { kind: r.kind, plays: cur?.plays ?? {}, last: { ...cur?.last, [r.device]: r.at }, ...(cur?.mark ? { mark: cur.mark } : {}), progress: pick(cur?.progress, progress)! };
    if (r.event !== 'progress' && (r.event === 'finish' || classify(r.kind, pos, r.durationMs, th).watched)) {
      next = { ...next, plays: { ...next.plays, [r.device]: (next.plays[r.device] ?? 0) + 1 }, mark: pick(cur?.mark, { watched: true, at: r.at, device: r.device })! };
    }
    tab.set(r.item, next);
    return next;
  }

  /** Mark by hand. The later of this and any play wins on every device. */
  mark(user: string, item: string, kind: Kind, watched: boolean, at: number, device: string): ItemState {
    if (!ID.test(user) || !ID.test(item) || !ID.test(device)) throw new PlaybackError('user, item and device are 1 to 200 characters');
    if (at > this.now() + this.skewMs) throw new PlaybackError('the mark is from the future');
    const tab = this.table(user);
    const cur = tab.get(item);
    const m: Mark = { watched, at, device };
    const next: ItemState = { kind, plays: cur?.plays ?? {}, last: cur?.last ?? {}, ...(cur?.progress ? { progress: cur.progress } : {}), mark: pick(cur?.mark, m)! };
    tab.set(item, next);
    return next;
  }

  /** Items with a resume point, most recently played first. */
  continueWatching(user: string, limit = 20): { item: string; resumeMs: number; lastPlayedAt: number; durationMs: number }[] {
    const out: { item: string; resumeMs: number; lastPlayedAt: number; durationMs: number }[] = [];
    for (const [item, s] of this.users.get(user) ?? []) {
      const v = view(s, this.t);
      if (v.resumeMs !== undefined) out.push({ item, resumeMs: v.resumeMs, lastPlayedAt: v.lastPlayedAt!, durationMs: v.durationMs! });
    }
    return out.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt || a.item.localeCompare(b.item)).slice(0, limit);
  }

  /** The first episode after the last watched one that is not watched itself; the first episode if none is watched. */
  nextUp(user: string, series: readonly string[]): string | undefined {
    let last = -1;
    series.forEach((id, i) => {
      if (this.view(user, id).watched) last = i;
    });
    for (let i = last + 1; i < series.length; i++) if (!this.view(user, series[i]!).watched) return series[i];
    return undefined;
  }

  snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const [u, t] of this.users) out[u] = Object.fromEntries(t);
    return out;
  }

  /** Merge another store's snapshot in: the order and the number of times do not matter. */
  merge(s: Snapshot): void {
    for (const [u, items] of Object.entries(s)) {
      if (!ID.test(u)) throw new PlaybackError('bad user id in snapshot');
      const tab = this.table(u);
      for (const [id, st] of Object.entries(items)) {
        if (!ID.test(id) || !st || typeof st.kind !== 'string' || !(st.kind in DEFAULTS)) throw new PlaybackError('bad item in snapshot');
        for (const n of Object.values(st.plays ?? {})) if (!Number.isSafeInteger(n) || n < 0) throw new PlaybackError('bad play count in snapshot');
        if (!st.plays || !st.last) throw new PlaybackError('bad item in snapshot');
        const cur = tab.get(id);
        tab.set(id, cur ? mergeItem(cur, st) : { ...st, plays: { ...st.plays }, last: { ...st.last } });
      }
    }
  }
}

// ---------------------------------------------------------------- the play queue

export interface Entry {
  readonly id: string;
  readonly item: string;
}

export type Repeat = 'off' | 'all' | 'one';

export interface QueueState {
  readonly entries: readonly Entry[];
  readonly currentId: string | undefined;
  readonly repeat: Repeat;
  /** A seed for a stable shuffle, or undefined for the order as listed. */
  readonly shuffleSeed: string | undefined;
}

export const emptyQueue = (): QueueState => ({ entries: [], currentId: undefined, repeat: 'off', shuffleSeed: undefined });

const rank = (seed: string, id: string) => createHash('sha256').update(`${seed}\u0000${id}`).digest('hex');

/** The order entries will play in: as listed, or by a hash of the seed and each entry's id (so it is stable). */
export function playOrder(q: QueueState): Entry[] {
  if (q.shuffleSeed === undefined) return [...q.entries];
  const seed = q.shuffleSeed;
  return [...q.entries].sort((a, b) => (rank(seed, a.id) < rank(seed, b.id) ? -1 : 1));
}

export const current = (q: QueueState): Entry | undefined => q.entries.find((e) => e.id === q.currentId);

export function addToQueue(q: QueueState, items: readonly string[], newId: () => string, where: 'end' | 'next' = 'end'): QueueState {
  if (!items.length) return q;
  if (items.length > 1000 || q.entries.length + items.length > 5000) throw new PlaybackError('a queue holds at most 5000 entries');
  for (const i of items) if (!ID.test(i)) throw new PlaybackError('bad item id');
  const added: Entry[] = items.map((item) => ({ id: newId(), item }));
  let entries: Entry[];
  if (where === 'next' && q.currentId !== undefined && q.shuffleSeed === undefined) {
    const at = q.entries.findIndex((e) => e.id === q.currentId) + 1;
    entries = [...q.entries.slice(0, at), ...added, ...q.entries.slice(at)];
  } else entries = [...q.entries, ...added];
  return { ...q, entries, currentId: q.currentId ?? added[0]!.id };
}

export function removeFromQueue(q: QueueState, entryId: string): QueueState {
  if (!q.entries.some((e) => e.id === entryId)) throw new PlaybackError('no such entry');
  let currentId = q.currentId;
  if (currentId === entryId) {
    const order = playOrder(q);
    const i = order.findIndex((e) => e.id === entryId);
    currentId = (order[i + 1] ?? (q.repeat === 'all' ? order.find((e) => e.id !== entryId) : undefined))?.id;
  }
  return { ...q, entries: q.entries.filter((e) => e.id !== entryId), currentId };
}

export function moveInQueue(q: QueueState, entryId: string, toIndex: number): QueueState {
  const from = q.entries.findIndex((e) => e.id === entryId);
  if (from < 0) throw new PlaybackError('no such entry');
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= q.entries.length) throw new PlaybackError('no such position');
  const entries = [...q.entries];
  const [e] = entries.splice(from, 1);
  entries.splice(toIndex, 0, e!);
  return { ...q, entries };
}

export function jumpTo(q: QueueState, entryId: string): QueueState {
  if (!q.entries.some((e) => e.id === entryId)) throw new PlaybackError('no such entry');
  return { ...q, currentId: entryId };
}

/** Move on. `auto` is the item ending by itself: repeat-one then plays it again; a skip always moves on (repeat-one wraps like repeat-all). */
export function advance(q: QueueState, auto: boolean): QueueState {
  const order = playOrder(q);
  const i = order.findIndex((e) => e.id === q.currentId);
  if (i < 0) return q;
  if (auto && q.repeat === 'one') return q;
  const n = order[i + 1] ?? (q.repeat !== 'off' ? order[0] : undefined);
  return { ...q, currentId: n?.id };
}

export function previous(q: QueueState): QueueState {
  const order = playOrder(q);
  const i = order.findIndex((e) => e.id === q.currentId);
  if (i < 0) return q;
  const p = order[i - 1] ?? (q.repeat !== 'off' ? order[order.length - 1] : order[0]);
  return { ...q, currentId: p?.id };
}

export const withRepeat = (q: QueueState, repeat: Repeat): QueueState => ({ ...q, repeat });
export const withShuffle = (q: QueueState, seed: string | undefined): QueueState => ({ ...q, shuffleSeed: seed });

const toRecord = (q: QueueState): Record<string, unknown> => ({ entries: q.entries, currentId: q.currentId ?? null, repeat: q.repeat, shuffleSeed: q.shuffleSeed ?? null });
const fromRecord = (r: Record<string, unknown>): QueueState => ({ entries: r.entries as Entry[], currentId: (r.currentId as string | null) ?? undefined, repeat: r.repeat as Repeat, shuffleSeed: (r.shuffleSeed as string | null) ?? undefined });

export type QueueSave = { readonly ok: true; readonly version: number; readonly state: QueueState; readonly merged: readonly string[] } | { readonly ok: false; readonly conflicts: readonly { readonly field: string; readonly base: unknown; readonly theirs: unknown; readonly yours: unknown }[] };

/** One queue per user, versioned; devices save what they edited from a base and non-clashing edits merge. */
export class QueueStore {
  private readonly q = new Map<string, Versioned<Record<string, unknown>>>();

  get(user: string): { version: number; state: QueueState } {
    const v = this.q.get(user);
    return v ? { version: v.version, state: fromRecord(v.data) } : { version: 0, state: emptyQueue() };
  }

  /** `from` is the version the device edited; `base` that version's state; `yours` the device's new state. */
  save(user: string, from: number, base: QueueState, yours: QueueState): QueueSave {
    const cur = this.q.get(user) ?? { version: 0, data: toRecord(emptyQueue()) };
    const r = saveVersioned(cur, from, toRecord(base), toRecord(yours));
    if (!r.ok) return { ok: false, conflicts: r.conflicts.map((c) => ({ field: String(c.field), base: c.base, theirs: c.theirs, yours: c.yours })) };
    this.q.set(user, r.record);
    return { ok: true, version: r.record.version, state: fromRecord(r.record.data), merged: r.merged.map(String) };
  }
}
