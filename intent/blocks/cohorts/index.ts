/**
 * Cohorts, retention curves and churn over an event stream (the `Event` shape of the analytics block). People are
 * grouped by when they first did a defining event (or by a property of it, like plan), then followed through later
 * periods to see who came back.
 *
 *  - The events are loaded once into columns (an interned user column, a time column, a name column) and everything
 *    below works on those arrays: sorting by (user, time) and one pass per question. No row objects are re-walked.
 *  - Periods are days, weeks (Monday or Sunday start) or calendar months, in the reader's UTC offset, so "Tuesday"
 *    means Tuesday where the people are, and a month is a month.
 *  - Calendar alignment: cohort = the period a person first did the defining event; column k = activity k periods later.
 *    Relative alignment (day or week only): column k = activity in the k-th interval after that person's own first
 *    event, which is what "day-7 retention" means. Each cell is counted only over people whose k-th interval has
 *    fully elapsed by `asOf`, so a young cohort shows blanks (null), not a false drop to zero.
 *  - Two retention kinds: `period` (active in exactly period k) and `unbounded` (active in period k or later).
 *  - Cells with a base smaller than `minSize` are suppressed (null), so a handful of people cannot be picked out.
 *  - The curve is the pooled rate across cohorts that are old enough, not an average of rates, so a tiny cohort cannot
 *    swing it.
 *  - Churn: growth accounting by period (new, retained, resurrected, churned, with the quick ratio), inactivity churn
 *    (nobody seen for N days as of a date), and a Kaplan-Meier survival curve that treats still-active people as
 *    censored rather than as survivors.
 *
 * Bad data is counted, not trusted: events with a non-finite or negative time, or an empty user, are skipped and
 * reported. Out of scope: significance tests between cohorts, and identity stitching across devices.
 */
import type { Event } from '../analytics/index.ts';

export class CohortError extends Error {
  constructor(why: string) {
    super(why);
  }
}

const MIN = 60_000;
const DAY = 86_400_000;

export type Period = 'day' | 'week' | 'month';

// ---------------------------------------------------------------- columns

export class Columns {
  readonly users: string[] = [];
  readonly names: string[] = [];
  who: Int32Array;
  at: Float64Array;
  name: Int32Array;
  /** Index of the source event, to reach properties. */
  src: Int32Array;
  readonly skipped = { badTime: 0, noUser: 0 };
  private readonly events: readonly Event[];

  private constructor(events: readonly Event[]) {
    this.events = events;
    this.who = new Int32Array(0);
    this.at = new Float64Array(0);
    this.name = new Int32Array(0);
    this.src = new Int32Array(0);
  }

  static from(events: readonly Event[]): Columns {
    const c = new Columns(events);
    const userIx = new Map<string, number>();
    const nameIx = new Map<string, number>();
    const who: number[] = [];
    const at: number[] = [];
    const name: number[] = [];
    const src: number[] = [];
    events.forEach((e, i) => {
      if (typeof e.who !== 'string' || e.who === '') return void c.skipped.noUser++;
      if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at < 0) return void c.skipped.badTime++;
      let u = userIx.get(e.who);
      if (u === undefined) { u = c.users.length; c.users.push(e.who); userIx.set(e.who, u); }
      let n = nameIx.get(e.name);
      if (n === undefined) { n = c.names.length; c.names.push(e.name); nameIx.set(e.name, n); }
      who.push(u); at.push(e.at); name.push(n); src.push(i);
    });
    c.who = Int32Array.from(who);
    c.at = Float64Array.from(at);
    c.name = Int32Array.from(name);
    c.src = Int32Array.from(src);
    return c;
  }

  get length(): number {
    return this.at.length;
  }

  prop(row: number, key: string): string | number | boolean | undefined {
    const p = this.events[this.src[row]!]!.props;
    return Object.hasOwn(p, key) ? p[key] : undefined;
  }

  /** Row numbers sorted by (user, time), for the names given (or all). */
  order(names?: ReadonlySet<number>): Int32Array {
    const rows: number[] = [];
    for (let i = 0; i < this.length; i++) if (!names || names.has(this.name[i]!)) rows.push(i);
    rows.sort((a, b) => this.who[a]! - this.who[b]! || this.at[a]! - this.at[b]! || a - b);
    return Int32Array.from(rows);
  }

  nameIds(wanted: readonly string[] | undefined): Set<number> | undefined {
    if (!wanted) return undefined;
    return new Set(wanted.map((w) => this.names.indexOf(w)).filter((i) => i >= 0));
  }
}

// ---------------------------------------------------------------- periods

export interface Clock {
  readonly period: Period;
  /** Minutes east of UTC. */
  readonly offsetMinutes?: number;
  readonly weekStart?: 'monday' | 'sunday';
}

/** The ordinal of the period `t` falls in. */
export function periodIndex(t: number, c: Clock): number {
  const local = t + (c.offsetMinutes ?? 0) * MIN;
  if (c.period === 'day') return Math.floor(local / DAY);
  if (c.period === 'week') return Math.floor((Math.floor(local / DAY) - (c.weekStart === 'sunday' ? 3 : 4)) / 7);
  const d = new Date(local);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** The UTC time at which period `index` starts. */
export function periodStart(index: number, c: Clock): number {
  const off = (c.offsetMinutes ?? 0) * MIN;
  if (c.period === 'day') return index * DAY - off;
  if (c.period === 'week') return (index * 7 + (c.weekStart === 'sunday' ? 3 : 4)) * DAY - off;
  return Date.UTC(Math.floor(index / 12), index % 12, 1) - off;
}

const checkClock = (c: Clock) => {
  if (!['day', 'week', 'month'].includes(c.period)) throw new CohortError('the period is day, week or month');
  const o = c.offsetMinutes ?? 0;
  if (!Number.isInteger(o) || o < -14 * 60 || o > 14 * 60) throw new CohortError('the UTC offset is within 14 hours');
};

// ---------------------------------------------------------------- cohorts

export interface CohortOptions extends Clock {
  /** The event that puts someone in a cohort (their first one counts). Omit to use their first event of any kind. */
  readonly cohortEvent?: string;
  /** What counts as coming back; omit for any event. */
  readonly returnEvents?: readonly string[];
  readonly periods?: number;
  readonly asOf: number;
  readonly align?: 'calendar' | 'relative';
  readonly kind?: 'period' | 'unbounded';
  /** Split cohorts by this property of the defining event. */
  readonly groupBy?: string;
  readonly minSize?: number;
  /** Count the period that is still going (calendar alignment). */
  readonly includePartial?: boolean;
}

export interface CohortRow {
  /** "2026-03" style label, plus "|value" when grouped. */
  readonly key: string;
  readonly start: number;
  readonly size: number;
  readonly group: string | null;
  /** Retained people per column; null where the column is not yet complete or the base is too small. */
  readonly retained: (number | null)[];
  /** Who could have been counted per column (people old enough). */
  readonly base: number[];
  readonly rate: (number | null)[];
}

export interface CohortTable {
  readonly rows: CohortRow[];
  /** Pooled retention per column across cohorts old enough. */
  readonly curve: (number | null)[];
  readonly curveBase: number[];
  readonly people: number;
  readonly skipped: { readonly badTime: number; readonly noUser: number };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function label(index: number, c: Clock): string {
  const d = new Date(periodStart(index, c) + (c.offsetMinutes ?? 0) * MIN);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return c.period === 'month' ? day.slice(0, 7) : day;
}

export function buildCohorts(events: readonly Event[] | Columns, o: CohortOptions): CohortTable {
  checkClock(o);
  const periods = o.periods ?? 8;
  if (!Number.isInteger(periods) || periods < 1 || periods > 366) throw new CohortError('periods is a whole number from 1 to 366');
  if (!Number.isFinite(o.asOf)) throw new CohortError('asOf must be a time');
  const align = o.align ?? 'calendar';
  if (align === 'relative' && o.period === 'month') throw new CohortError('relative alignment needs fixed-length periods: day or week');
  const minSize = o.minSize ?? 1;
  const cols = events instanceof Columns ? events : Columns.from(events);
  const cohortNames = cols.nameIds(o.cohortEvent ? [o.cohortEvent] : undefined);
  const returnNames = cols.nameIds(o.returnEvents);
  const rows = cols.order();
  const intervalMs = o.period === 'day' ? DAY : 7 * DAY;
  const asIndex = periodIndex(o.asOf, o);
  const lastComplete = o.includePartial ? asIndex : asIndex - 1;

  interface Person { first: number; firstRow: number; periodsActive: Set<number>; offsets: Set<number>; lastOffset: number; lastPeriod: number }
  const people = new Map<number, Person>();
  // Pass 1: defining event per user (rows are sorted, so the first matching row is the earliest).
  for (const r of rows) {
    const u = cols.who[r]!;
    if (cols.at[r]! > o.asOf) continue;
    if (people.has(u)) continue;
    if (cohortNames && !cohortNames.has(cols.name[r]!)) continue;
    people.set(u, { first: cols.at[r]!, firstRow: r, periodsActive: new Set(), offsets: new Set(), lastOffset: -1, lastPeriod: -1 });
  }
  // Pass 2: activity at or after the defining event.
  for (const r of rows) {
    const p = people.get(cols.who[r]!);
    if (!p || cols.at[r]! < p.first || cols.at[r]! > o.asOf) continue;
    if (returnNames && !returnNames.has(cols.name[r]!)) continue;
    const t = cols.at[r]!;
    const per = periodIndex(t, o);
    p.periodsActive.add(per);
    p.lastPeriod = Math.max(p.lastPeriod, per);
    const off = Math.floor((t - p.first) / intervalMs);
    p.offsets.add(off);
    p.lastOffset = Math.max(p.lastOffset, off);
  }

  const groups = new Map<string, { index: number; group: string | null; members: Person[] }>();
  for (const p of people.values()) {
    const idx = periodIndex(p.first, o);
    const g = o.groupBy ? String(cols.prop(p.firstRow, o.groupBy) ?? '(none)') : null;
    const key = `${label(idx, o)}${g === null ? '' : `|${g}`}`;
    let e = groups.get(key);
    if (!e) { e = { index: idx, group: g, members: [] }; groups.set(key, e); }
    e.members.push(p);
  }

  const out: CohortRow[] = [];
  const pooledRet = new Array<number>(periods).fill(0);
  const pooledBase = new Array<number>(periods).fill(0);
  for (const [key, g] of [...groups].sort((a, b) => a[1].index - b[1].index || (a[0] < b[0] ? -1 : 1))) {
    const retained: (number | null)[] = [];
    const base: number[] = [];
    const rate: (number | null)[] = [];
    for (let k = 0; k < periods; k++) {
      let b = 0;
      let r = 0;
      for (const p of g.members) {
        if (align === 'calendar') {
          if (g.index + k > lastComplete) continue;
          b++;
          const target = g.index + k;
          if (o.kind === 'unbounded' ? p.lastPeriod >= target : p.periodsActive.has(target)) r++;
        } else {
          if (p.first + (k + 1) * intervalMs > o.asOf && !o.includePartial) continue;
          b++;
          if (o.kind === 'unbounded' ? p.lastOffset >= k : p.offsets.has(k)) r++;
        }
      }
      base.push(b);
      if (b === 0 || b < minSize) { retained.push(null); rate.push(null); continue; }
      retained.push(r);
      rate.push(r / b);
      pooledRet[k]! += r;
      pooledBase[k]! += b;
    }
    out.push({ key, start: periodStart(g.index, o), size: g.members.length, group: g.group, retained, base, rate });
  }
  return {
    rows: out,
    curve: pooledBase.map((b, k) => (b === 0 || b < minSize ? null : pooledRet[k]! / b)),
    curveBase: pooledBase,
    people: people.size,
    skipped: cols.skipped,
  };
}

// ---------------------------------------------------------------- churn

export interface GrowthRow {
  readonly period: number;
  readonly start: number;
  readonly active: number;
  readonly new: number;
  readonly retained: number;
  readonly resurrected: number;
  readonly churned: number;
  /** churned / active in the previous period; null for the first period. */
  readonly churnRate: number | null;
  /** (new + resurrected) / churned; null when nobody churned. */
  readonly quickRatio: number | null;
}

/** Growth accounting: who was new, kept, came back, or went quiet, per period, over complete periods only. */
export function growthAccounting(events: readonly Event[] | Columns, o: Clock & { asOf: number; activeEvents?: readonly string[]; includePartial?: boolean }): GrowthRow[] {
  checkClock(o);
  const cols = events instanceof Columns ? events : Columns.from(events);
  const names = cols.nameIds(o.activeEvents);
  const asIndex = periodIndex(o.asOf, o);
  const last = o.includePartial ? asIndex : asIndex - 1;
  const perUser = new Map<number, Set<number>>();
  let minP = Infinity;
  for (const r of cols.order(names)) {
    if (cols.at[r]! > o.asOf) continue;
    const p = periodIndex(cols.at[r]!, o);
    if (p > last) continue;
    let s = perUser.get(cols.who[r]!);
    if (!s) { s = new Set(); perUser.set(cols.who[r]!, s); }
    s.add(p);
    minP = Math.min(minP, p);
  }
  if (!perUser.size) return [];
  const rows: GrowthRow[] = [];
  for (let p = minP; p <= last; p++) {
    let active = 0, nw = 0, kept = 0, back = 0, gone = 0, prevActive = 0;
    for (const s of perUser.values()) {
      const now = s.has(p);
      const before = s.has(p - 1);
      const everBefore = [...s].some((x) => x < p);
      if (before) prevActive++;
      if (now) {
        active++;
        if (before) kept++;
        else if (everBefore) back++;
        else nw++;
      } else if (before) gone++;
    }
    rows.push({ period: p, start: periodStart(p, o), active, new: nw, retained: kept, resurrected: back, churned: gone, churnRate: p === minP ? null : prevActive ? gone / prevActive : null, quickRatio: gone ? (nw + back) / gone : null });
  }
  return rows;
}

export interface Inactivity {
  readonly asOf: number;
  readonly inactiveDays: number;
  readonly everSeen: number;
  readonly churned: string[];
  /** churned / everSeen who had been around at least inactiveDays. */
  readonly rate: number;
  readonly eligible: number;
}

/** Who has gone quiet: nobody seen for `inactiveDays` as of `asOf`. People who joined more recently than that are not yet judged. */
export function inactivityChurn(events: readonly Event[] | Columns, o: { asOf: number; inactiveDays: number; activeEvents?: readonly string[] }): Inactivity {
  if (!(o.inactiveDays >= 1)) throw new CohortError('the inactivity limit is at least 1 day');
  const cols = events instanceof Columns ? events : Columns.from(events);
  const names = cols.nameIds(o.activeEvents);
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  for (const r of cols.order(names)) {
    const t = cols.at[r]!;
    if (t > o.asOf) continue;
    const u = cols.who[r]!;
    if (!first.has(u)) first.set(u, t);
    last.set(u, t);
  }
  const cutoff = o.asOf - o.inactiveDays * DAY;
  const churned: string[] = [];
  let eligible = 0;
  for (const [u, f] of first) {
    if (f > cutoff) continue;
    eligible++;
    if (last.get(u)! <= cutoff) churned.push(cols.users[u]!);
  }
  churned.sort();
  return { asOf: o.asOf, inactiveDays: o.inactiveDays, everSeen: first.size, churned, rate: eligible ? churned.length / eligible : 0, eligible };
}

export interface SurvivalPoint {
  readonly day: number;
  readonly atRisk: number;
  readonly churned: number;
  readonly survival: number;
}

/**
 * Kaplan-Meier survival from each person's first event. A person has "churned" at the time of their last event
 * if nothing followed for `inactiveDays`; anyone still within that gap is censored at `asOf`, not counted as a survivor.
 */
export function survival(events: readonly Event[] | Columns, o: { asOf: number; inactiveDays: number; days: number; activeEvents?: readonly string[] }): SurvivalPoint[] {
  if (!(o.inactiveDays >= 1)) throw new CohortError('the inactivity limit is at least 1 day');
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 730) throw new CohortError('days is a whole number from 1 to 730');
  const cols = events instanceof Columns ? events : Columns.from(events);
  const names = cols.nameIds(o.activeEvents);
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  for (const r of cols.order(names)) {
    const t = cols.at[r]!;
    if (t > o.asOf) continue;
    const u = cols.who[r]!;
    if (!first.has(u)) first.set(u, t);
    last.set(u, t);
  }
  const cutoff = o.asOf - o.inactiveDays * DAY;
  // Each person: duration (whole days) and whether it ended in churn.
  const obs: { d: number; churn: boolean }[] = [];
  for (const [u, f] of first) {
    const l = last.get(u)!;
    const churn = l <= cutoff;
    obs.push({ d: Math.floor(((churn ? l : o.asOf) - f) / DAY), churn });
  }
  const out: SurvivalPoint[] = [];
  let s = 1;
  for (let day = 0; day <= o.days; day++) {
    const atRisk = obs.filter((x) => x.d >= day).length;
    const died = obs.filter((x) => x.d === day && x.churn).length;
    if (atRisk > 0) s *= 1 - died / atRisk;
    out.push({ day, atRisk, churned: died, survival: s });
  }
  return out;
}

/** Renders a table as plain text rows (percentages), for a report or a test log. */
export function formatTable(t: CohortTable): string[] {
  return t.rows.map((r) => `${r.key.padEnd(14)} ${String(r.size).padStart(5)}  ` + r.rate.map((x) => (x === null ? '   . ' : `${(x * 100).toFixed(0).padStart(3)}% `)).join(''));
}
