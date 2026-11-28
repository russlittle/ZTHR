/**
 * Time series for metrics and sensors: points of (time in ms, number). Holds: cleaning (sorted, duplicate
 * timestamps resolved, NaN and infinities refused or dropped, and said so); buckets aligned to a step and an offset
 * (so "days" can start at local midnight for a fixed zone offset), with a cap on how many a call may make;
 * downsampling with one aggregate (avg, sum, min, max, count, first, last, median, any quantile); rollups that
 * carry count, sum, min, max, first, last and the increase within the bucket, and merge exactly (an hourly rollup
 * made from minute rollups equals one made from the raw points, where an average of averages would not); counters
 * with resets handled (increase, rate, instantaneous rate); gauges (delta); resampling to a regular grid by
 * linear, previous, next or nearest, never reaching across a gap longer than the one you allow; gap filling with
 * null, zero, previous, linear or a value, with a limit on how long a run of fill may be so an outage stays an
 * outage; gap detection; and tiered retention: raw points, then rollups at coarser steps, each tier kept for its
 * age, compacted so every moment of time lives in exactly one tier, and queried at the finest resolution that still
 * has the data. Not here: calendar months and daylight saving (steps are fixed lengths from an offset), storage on
 * disk, and a query language.
 */

export interface Point {
  readonly t: number;
  readonly v: number;
}

export class SeriesError extends Error {}

const MAX_BUCKETS = 100_000;

export interface CleanResult {
  readonly points: Point[];
  readonly dropped: { readonly invalid: number; readonly duplicates: number };
}

/** Sorted by time, unusable values dropped, duplicate times resolved (the last one given wins). */
export function clean(input: readonly Point[]): CleanResult {
  let invalid = 0;
  const byTime = new Map<number, number>();
  let duplicates = 0;
  for (const p of input) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) {
      invalid++;
      continue;
    }
    if (byTime.has(p.t)) duplicates++;
    byTime.set(p.t, p.v);
  }
  const points = [...byTime].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  return { points, dropped: { invalid, duplicates } };
}

const sorted = (pts: readonly Point[]): readonly Point[] => {
  for (let i = 1; i < pts.length; i++) if (pts[i]!.t <= pts[i - 1]!.t || !Number.isFinite(pts[i]!.v)) return clean(pts).points;
  return pts.length && !Number.isFinite(pts[0]!.v) ? clean(pts).points : pts;
};

export interface Grid {
  readonly stepMs: number;
  /** Shifts the bucket edges: a step of one day with offset +3 hours starts days at 03:00 UTC (midnight in UTC-3). */
  readonly offsetMs?: number;
}

const checkGrid = (g: Grid) => {
  if (!(Number.isInteger(g.stepMs) && g.stepMs > 0)) throw new SeriesError('the step must be a whole number of milliseconds above zero');
};

/** The start of the bucket a time falls in. */
export function bucketStart(t: number, g: Grid): number {
  checkGrid(g);
  const o = g.offsetMs ?? 0;
  return Math.floor((t - o) / g.stepMs) * g.stepMs + o;
}

function* gridTimes(from: number, to: number, g: Grid): Generator<number> {
  checkGrid(g);
  const first = bucketStart(from, g);
  const n = Math.floor((bucketStart(to - 1, g) - first) / g.stepMs) + 1;
  if (n > MAX_BUCKETS) throw new SeriesError(`that would make ${n} buckets; the limit is ${MAX_BUCKETS}`);
  for (let i = 0; i < n; i++) yield first + i * g.stepMs;
}

// ---------------------------------------------------------------- aggregates

export type Agg = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'first' | 'last' | 'median' | `p${number}`;

export function quantile(sortedValues: readonly number[], q: number): number {
  if (!sortedValues.length) return NaN;
  if (!(q >= 0 && q <= 1)) throw new SeriesError('a quantile is between 0 and 1');
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedValues[lo]! + (sortedValues[hi]! - sortedValues[lo]!) * (pos - lo);
}

function aggregate(values: readonly number[], agg: Agg): number {
  switch (agg) {
    case 'count': return values.length;
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    case 'first': return values[0]!;
    case 'last': return values[values.length - 1]!;
    case 'median': return quantile([...values].sort((a, b) => a - b), 0.5);
    default: {
      const q = Number(agg.slice(1)) / 100;
      return quantile([...values].sort((a, b) => a - b), q);
    }
  }
}

const checkAgg = (a: string) => {
  if (!['avg', 'sum', 'min', 'max', 'count', 'first', 'last', 'median'].includes(a) && !/^p(\d+(\.\d+)?)$/.test(a)) throw new SeriesError(`unknown aggregate ${a}`);
  if (/^p/.test(a) && a !== 'p' && Number(a.slice(1)) > 100) throw new SeriesError('a percentile is 0 to 100');
};

export interface Bucket {
  readonly t: number;
  readonly v: number;
  /** How many points it was made from. */
  readonly n: number;
}

export interface RangeOptions {
  readonly from?: number;
  readonly to?: number;
}

const inRange = (pts: readonly Point[], o: RangeOptions) => pts.filter((p) => (o.from === undefined || p.t >= o.from) && (o.to === undefined || p.t < o.to));

/** One aggregate per bucket; buckets with no points are left out (use fillGaps to put them back). */
export function downsample(points: readonly Point[], g: Grid & RangeOptions & { agg: Agg }): Bucket[] {
  checkGrid(g);
  checkAgg(g.agg);
  const by = new Map<number, number[]>();
  for (const p of inRange(sorted(points), g)) {
    const k = bucketStart(p.t, g);
    const l = by.get(k);
    if (l) l.push(p.v);
    else by.set(k, [p.v]);
  }
  if (by.size > MAX_BUCKETS) throw new SeriesError(`that would make ${by.size} buckets; the limit is ${MAX_BUCKETS}`);
  return [...by].sort((a, b) => a[0] - b[0]).map(([t, vs]) => ({ t, v: aggregate(vs, g.agg), n: vs.length }));
}

// ---------------------------------------------------------------- counters

/** The increase from one counter reading to the next: a drop means the counter reset, so the new value is the increase. */
export const counterDelta = (prev: number, cur: number): number => (cur >= prev ? cur - prev : cur);

export interface CounterOptions extends RangeOptions {
  /** Pairs more than this apart are not counted (the counter was not being read). */
  readonly maxGapMs?: number;
}

/** Total increase of a counter, reset-safe. Fewer than two points have no increase to measure. */
export function increase(points: readonly Point[], o: CounterOptions = {}): number {
  const pts = inRange(sorted(points), o);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    if (o.maxGapMs !== undefined && pts[i]!.t - pts[i - 1]!.t > o.maxGapMs) continue;
    total += counterDelta(pts[i - 1]!.v, pts[i]!.v);
  }
  return total;
}

/** Average increase per second across the span of the points that were used. */
export function rate(points: readonly Point[], o: CounterOptions = {}): number | null {
  const pts = inRange(sorted(points), o);
  if (pts.length < 2) return null;
  const span = (pts[pts.length - 1]!.t - pts[0]!.t) / 1000;
  return span > 0 ? increase(pts, o) / span : null;
}

/** Rate between the last two points. */
export function irate(points: readonly Point[]): number | null {
  const pts = sorted(points);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2]!;
  const b = pts[pts.length - 1]!;
  return counterDelta(a.v, b.v) / ((b.t - a.t) / 1000);
}

/** Rate per bucket for a counter: the increase in each bucket (including from the previous bucket's last reading) per second. */
export function rateBuckets(points: readonly Point[], g: Grid & RangeOptions & CounterOptions): { t: number; v: number }[] {
  const pts = inRange(sorted(points), g);
  const by = new Map<number, number>();
  for (let i = 1; i < pts.length; i++) {
    if (g.maxGapMs !== undefined && pts[i]!.t - pts[i - 1]!.t > g.maxGapMs) continue;
    const k = bucketStart(pts[i]!.t, g);
    by.set(k, (by.get(k) ?? 0) + counterDelta(pts[i - 1]!.v, pts[i]!.v));
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([t, inc]) => ({ t, v: inc / (g.stepMs / 1000) }));
}

/** Change of a gauge across the points (last minus first). */
export function delta(points: readonly Point[], o: RangeOptions = {}): number | null {
  const pts = inRange(sorted(points), o);
  return pts.length < 2 ? null : pts[pts.length - 1]!.v - pts[0]!.v;
}

// ---------------------------------------------------------------- rollups

export interface Rollup {
  readonly t: number;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly first: number;
  readonly last: number;
  /** Counter increase within the bucket (resets handled), not counting the step in from the previous bucket. */
  readonly inc: number;
  readonly firstT: number;
  readonly lastT: number;
}

const rollOne = (t: number, pts: readonly Point[]): Rollup => {
  let inc = 0;
  for (let i = 1; i < pts.length; i++) inc += counterDelta(pts[i - 1]!.v, pts[i]!.v);
  return { t, count: pts.length, sum: pts.reduce((a, p) => a + p.v, 0), min: Math.min(...pts.map((p) => p.v)), max: Math.max(...pts.map((p) => p.v)), first: pts[0]!.v, last: pts[pts.length - 1]!.v, inc, firstT: pts[0]!.t, lastT: pts[pts.length - 1]!.t };
};

export function rollup(points: readonly Point[], g: Grid & RangeOptions): Rollup[] {
  checkGrid(g);
  const by = new Map<number, Point[]>();
  for (const p of inRange(sorted(points), g)) {
    const k = bucketStart(p.t, g);
    const l = by.get(k);
    if (l) l.push(p);
    else by.set(k, [p]);
  }
  if (by.size > MAX_BUCKETS) throw new SeriesError(`that would make ${by.size} buckets; the limit is ${MAX_BUCKETS}`);
  return [...by].sort((a, b) => a[0] - b[0]).map(([t, pts]) => rollOne(t, pts));
}

/** Combines rollups (in any order) into one with start time `t`. Exact for every field. */
export function mergeRollups(t: number, parts: readonly Rollup[]): Rollup {
  if (!parts.length) throw new SeriesError('nothing to merge');
  const p = [...parts].sort((a, b) => a.firstT - b.firstT);
  let inc = 0;
  for (let i = 0; i < p.length; i++) {
    inc += p[i]!.inc;
    if (i > 0) inc += counterDelta(p[i - 1]!.last, p[i]!.first);
  }
  return { t, count: p.reduce((a, x) => a + x.count, 0), sum: p.reduce((a, x) => a + x.sum, 0), min: Math.min(...p.map((x) => x.min)), max: Math.max(...p.map((x) => x.max)), first: p[0]!.first, last: p[p.length - 1]!.last, inc, firstT: p[0]!.firstT, lastT: p[p.length - 1]!.lastT };
}

/** Rollups at a coarser step made from finer ones. The coarse step must be a whole multiple of the fine one. */
export function coarsen(parts: readonly Rollup[], fine: Grid, coarse: Grid): Rollup[] {
  checkGrid(fine);
  checkGrid(coarse);
  if (coarse.stepMs % fine.stepMs !== 0 || ((coarse.offsetMs ?? 0) - (fine.offsetMs ?? 0)) % fine.stepMs !== 0) throw new SeriesError('the coarse step must be a whole multiple of the fine step, on the same edges');
  const by = new Map<number, Rollup[]>();
  for (const r of parts) {
    const k = bucketStart(r.t, coarse);
    const l = by.get(k);
    if (l) l.push(r);
    else by.set(k, [r]);
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([t, l]) => mergeRollups(t, l));
}

/** The value of an aggregate from a rollup, or an error for those a rollup cannot answer (median, quantiles). */
export function fromRollup(r: Rollup, agg: Agg): number {
  switch (agg) {
    case 'avg': return r.sum / r.count;
    case 'sum': return r.sum;
    case 'min': return r.min;
    case 'max': return r.max;
    case 'count': return r.count;
    case 'first': return r.first;
    case 'last': return r.last;
    default: throw new SeriesError(`${agg} cannot be computed from a rollup; it needs the raw points`);
  }
}

/** Counter increase across rollups in time order, including the steps between buckets. */
export function increaseFromRollups(rs: readonly Rollup[]): number {
  const p = [...rs].sort((a, b) => a.firstT - b.firstT);
  let total = 0;
  for (let i = 0; i < p.length; i++) {
    total += p[i]!.inc;
    if (i > 0) total += counterDelta(p[i - 1]!.last, p[i]!.first);
  }
  return total;
}

// ---------------------------------------------------------------- resampling and gaps

export type Method = 'linear' | 'previous' | 'next' | 'nearest';

export interface ResampleOptions extends Grid, RangeOptions {
  readonly method?: Method;
  /** Do not fill across more than this between two real points; the result there is null. Default: no limit. */
  readonly maxGapMs?: number;
}

export interface Sample {
  readonly t: number;
  readonly v: number | null;
}

/** Values on the grid's edges, taken from the points around each edge. Never extrapolates past the first or last point. */
export function resample(points: readonly Point[], o: ResampleOptions & { from: number; to: number }): Sample[] {
  const pts = sorted(points);
  const method = o.method ?? 'linear';
  const out: Sample[] = [];
  let j = 0;
  for (const t of gridTimes(o.from, o.to, o)) {
    if (t < o.from) continue;
    while (j < pts.length && pts[j]!.t <= t) j++;
    const prev = j > 0 ? pts[j - 1]! : undefined;
    const next = j < pts.length ? pts[j]! : undefined;
    if (prev && prev.t === t) {
      out.push({ t, v: prev.v });
      continue;
    }
    if (!prev || !next) {
      out.push({ t, v: null });
      continue;
    }
    if (o.maxGapMs !== undefined && next.t - prev.t > o.maxGapMs) {
      out.push({ t, v: null });
      continue;
    }
    let v: number;
    if (method === 'previous') v = prev.v;
    else if (method === 'next') v = next.v;
    else if (method === 'nearest') v = t - prev.t <= next.t - t ? prev.v : next.v;
    else v = prev.v + ((next.v - prev.v) * (t - prev.t)) / (next.t - prev.t);
    out.push({ t, v });
  }
  return out;
}

export interface FillOptions extends Grid {
  readonly from: number;
  readonly to: number;
  readonly fill: 'null' | 'zero' | 'previous' | 'linear' | { readonly value: number };
  /** Longest run of empty buckets to fill; longer runs stay null. Default: no limit. */
  readonly maxRun?: number;
}

/** Puts the missing buckets back into a downsampled series, filled as asked. */
export function fillGaps(buckets: readonly { t: number; v: number }[], o: FillOptions): Sample[] {
  const have = new Map(buckets.map((b) => [b.t, b.v]));
  const times = [...gridTimes(o.from, o.to, o)];
  const out: Sample[] = times.map((t) => ({ t, v: have.get(t) ?? null }));
  let i = 0;
  while (i < out.length) {
    if (out[i]!.v !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j]!.v === null) j++;
    const run = j - i;
    const before = i > 0 ? out[i - 1]!.v : null;
    const after = j < out.length ? out[j]!.v : null;
    if (o.maxRun === undefined || run <= o.maxRun) {
      for (let k = i; k < j; k++) {
        if (o.fill === 'zero') out[k] = { t: out[k]!.t, v: 0 };
        else if (typeof o.fill === 'object') out[k] = { t: out[k]!.t, v: o.fill.value };
        else if (o.fill === 'previous' && before !== null) out[k] = { t: out[k]!.t, v: before };
        else if (o.fill === 'linear' && before !== null && after !== null) out[k] = { t: out[k]!.t, v: before + ((after - before) * (k - i + 1)) / (run + 1) };
      }
    }
    i = j;
  }
  return out;
}

/** Stretches where readings are missing: longer than `expectedMs` times `tolerance` between neighbours. */
export function findGaps(points: readonly Point[], expectedMs: number, tolerance = 1.5): { from: number; to: number; missing: number }[] {
  const pts = sorted(points);
  const out: { from: number; to: number; missing: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i]!.t - pts[i - 1]!.t;
    if (d > expectedMs * tolerance) out.push({ from: pts[i - 1]!.t, to: pts[i]!.t, missing: Math.round(d / expectedMs) - 1 });
  }
  return out;
}

// ---------------------------------------------------------------- tiered retention

export interface Tier {
  readonly name: string;
  /** Bucket length of this tier; 0 for the raw tier. Each step must be a multiple of the one before. */
  readonly stepMs: number;
  /** How old (from now) data may be before it moves to the next tier, or is deleted for the last. */
  readonly keepMs: number;
}

export interface Resolved {
  readonly t: number;
  readonly tier: string;
  readonly stepMs: number;
  readonly rollup: Rollup;
}

export class TieredStore {
  private raw: Point[] = [];
  private readonly rolls: Rollup[][];
  readonly tiers: readonly Tier[];
  private readonly offsetMs: number;
  /** Everything before this time has been rolled up; points older than it are late. */
  private watermark = -Infinity;

  constructor(tiers: readonly Tier[], o: { offsetMs?: number } = {}) {
    if (!tiers.length || tiers[0]!.stepMs !== 0) throw new SeriesError('the first tier must be raw (step 0)');
    for (let i = 1; i < tiers.length; i++) {
      const a = tiers[i - 1]!;
      const b = tiers[i]!;
      if (b.stepMs <= 0 || (a.stepMs > 0 && b.stepMs % a.stepMs !== 0)) throw new SeriesError(`tier ${b.name}: its step must be above zero and a multiple of the one before`);
      if (b.keepMs <= a.keepMs) throw new SeriesError(`tier ${b.name} must be kept longer than ${a.name}`);
    }
    if (tiers.length < 2) throw new SeriesError('at least one rollup tier is needed');
    this.tiers = tiers;
    this.rolls = tiers.slice(1).map(() => []);
    this.offsetMs = o.offsetMs ?? 0;
  }

  get counts(): Record<string, number> {
    return Object.fromEntries(this.tiers.map((t, i) => [t.name, i === 0 ? this.raw.length : this.rolls[i - 1]!.length]));
  }

  /** Adds points. A point older than everything already moved to a rollup is refused (its time is no longer raw). */
  append(points: readonly Point[]): { accepted: number; late: number } {
    let late = 0;
    const ok = clean(points).points.filter((p) => {
      if (p.t < this.watermark) {
        late++;
        return false;
      }
      return true;
    });
    const merged = new Map(this.raw.map((p) => [p.t, p.v]));
    for (const p of ok) merged.set(p.t, p.v);
    this.raw = [...merged].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
    return { accepted: ok.length, late };
  }

  private rawCut(now: number): number {
    return bucketStart(now - this.tiers[0]!.keepMs, { stepMs: this.tiers[1]!.stepMs, offsetMs: this.offsetMs });
  }

  /**
   * Moves what has aged out: raw into the first rollup tier, each rollup tier into the next, the oldest dropped.
   * Cutoffs are on bucket edges, so a bucket is moved whole and no moment is held in two tiers. Safe to repeat.
   */
  compact(now: number): { rolled: number; dropped: number } {
    let rolled = 0;
    let dropped = 0;
    const cut1 = this.rawCut(now);
    this.watermark = Math.max(this.watermark, cut1);
    const old = this.raw.filter((p) => p.t < cut1);
    if (old.length) {
      const g = { stepMs: this.tiers[1]!.stepMs, offsetMs: this.offsetMs };
      const fresh = rollup(old, g);
      const have = new Map(this.rolls[0]!.map((r) => [r.t, r]));
      for (const r of fresh) have.set(r.t, have.has(r.t) ? mergeRollups(r.t, [have.get(r.t)!, r]) : r);
      this.rolls[0] = [...have.values()].sort((a, b) => a.t - b.t);
      this.raw = this.raw.filter((p) => p.t >= cut1);
      rolled += old.length;
    }
    for (let i = 1; i < this.tiers.length; i++) {
      const t = this.tiers[i]!;
      const cut = bucketStart(now - t.keepMs, { stepMs: i + 1 < this.tiers.length ? this.tiers[i + 1]!.stepMs : t.stepMs, offsetMs: this.offsetMs });
      const list = this.rolls[i - 1]!;
      const aged = list.filter((r) => r.t + t.stepMs <= cut);
      if (!aged.length) continue;
      this.rolls[i - 1] = list.filter((r) => r.t + t.stepMs > cut);
      if (i + 1 < this.tiers.length) {
        const next = this.tiers[i + 1]!;
        const moved = coarsen(aged, { stepMs: t.stepMs, offsetMs: this.offsetMs }, { stepMs: next.stepMs, offsetMs: this.offsetMs });
        const have = new Map(this.rolls[i]!.map((r) => [r.t, r]));
        for (const r of moved) have.set(r.t, have.has(r.t) ? mergeRollups(r.t, [have.get(r.t)!, r]) : r);
        this.rolls[i] = [...have.values()].sort((a, b) => a.t - b.t);
        rolled += aged.length;
      } else dropped += aged.length;
    }
    return { rolled, dropped };
  }

  /**
   * Buckets for a time range at the finest resolution each part of it still has: raw points are rolled up at `stepMs`,
   * older parts come from the rollup tiers at their own (coarser) step when that is coarser than asked.
   */
  query(from: number, to: number, stepMs: number): Resolved[] {
    checkGrid({ stepMs });
    const out: Resolved[] = [];
    const g = { stepMs, offsetMs: this.offsetMs };
    for (const r of rollup(this.raw, { ...g, from, to })) out.push({ t: r.t, tier: this.tiers[0]!.name, stepMs, rollup: r });
    this.rolls.forEach((list, i) => {
      const tier = this.tiers[i + 1]!;
      const inside = list.filter((r) => r.t >= from && r.t < to);
      if (!inside.length) return;
      if (stepMs >= tier.stepMs && stepMs % tier.stepMs === 0) for (const r of coarsen(inside, { stepMs: tier.stepMs, offsetMs: this.offsetMs }, g)) out.push({ t: r.t, tier: tier.name, stepMs, rollup: r });
      else for (const r of inside) out.push({ t: r.t, tier: tier.name, stepMs: tier.stepMs, rollup: r });
    });
    out.sort((a, b) => a.t - b.t || b.stepMs - a.stepMs);
    // A query bucket that straddles a tier boundary arrives in two parts; they are one bucket.
    const merged: Resolved[] = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && last.t === r.t && last.stepMs === r.stepMs) merged[merged.length - 1] = { t: r.t, tier: `${last.tier}+${r.tier}`, stepMs: r.stepMs, rollup: mergeRollups(r.t, [last.rollup, r.rollup]) };
      else merged.push(r);
    }
    return merged;
  }
}
