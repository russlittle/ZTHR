import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, bucketStart, downsample, quantile, increase, rate, irate, rateBuckets, delta, rollup, mergeRollups, coarsen, fromRollup, increaseFromRollups, resample, fillGaps, findGaps, TieredStore, SeriesError, type Point } from './index.ts';

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const pts = (...vs: [number, number][]): Point[] => vs.map(([t, v]) => ({ t, v }));

test('clean sorts, resolves duplicates (last wins), and drops NaN and infinities, counting each', () => {
  const r = clean(pts([3, 3], [1, 1], [2, NaN], [1, 10], [4, Infinity], [5, 5]));
  assert.deepEqual(r.points, pts([1, 10], [3, 3], [5, 5]));
  assert.deepEqual(r.dropped, { invalid: 2, duplicates: 1 });
});

test('buckets align to the step and offset, and are not fooled by negatives', () => {
  assert.equal(bucketStart(1_700_000_123_456, { stepMs: M }), 1_700_000_100_000);
  assert.equal(bucketStart(-1, { stepMs: 10 }), -10);
  assert.equal(bucketStart(5 * H, { stepMs: D, offsetMs: 3 * H }), 3 * H);
  assert.equal(bucketStart(2 * H, { stepMs: D, offsetMs: 3 * H }), -21 * H);
  for (const bad of [0, -5, 1.5, NaN]) assert.throws(() => bucketStart(1, { stepMs: bad }), SeriesError);
});

test('downsample: every aggregate, ranges, empty buckets left out, unsorted input', () => {
  const p = pts([0, 1], [10, 3], [20, 5], [100, 10], [110, 20], [250, 7]);
  const ds = (agg: Parameters<typeof downsample>[1]['agg']) => downsample(p, { stepMs: 100, agg }).map((b) => b.v);
  assert.deepEqual(ds('avg'), [3, 15, 7]);
  assert.deepEqual(ds('sum'), [9, 30, 7]);
  assert.deepEqual(ds('min'), [1, 10, 7]);
  assert.deepEqual(ds('max'), [5, 20, 7]);
  assert.deepEqual(ds('count'), [3, 2, 1]);
  assert.deepEqual(ds('first'), [1, 10, 7]);
  assert.deepEqual(ds('last'), [5, 20, 7]);
  assert.deepEqual(ds('median'), [3, 15, 7]);
  assert.deepEqual(ds('p100'), [5, 20, 7]);
  assert.deepEqual(downsample(p, { stepMs: 100, agg: 'sum', from: 100, to: 200 }), [{ t: 100, v: 30, n: 2 }]);
  assert.deepEqual(downsample([...p].reverse(), { stepMs: 100, agg: 'count' }).map((b) => b.t), [0, 100, 200]);
  assert.throws(() => downsample(p, { stepMs: 100, agg: 'mode' as never }), /unknown aggregate/);
  assert.throws(() => downsample(p, { stepMs: 100, agg: 'p150' }), /0 to 100/);
});

test('quantiles interpolate and refuse bad input', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  assert.throws(() => quantile([1], 2), SeriesError);
});

test('counters: increase handles resets; rate, irate and per-bucket rate', () => {
  const c = pts([0, 100], [10 * S, 150], [20 * S, 200], [30 * S, 20], [40 * S, 70]);
  assert.equal(increase(c), 50 + 50 + 20 + 50);
  assert.equal(rate(c), 170 / 40);
  assert.equal(irate(c), 5);
  assert.equal(increase(c, { from: 20 * S, to: 41 * S }), 20 + 50);
  assert.equal(increase(c, { maxGapMs: 5 * S }), 0);
  assert.equal(increase(pts([0, 5])), 0);
  assert.equal(rate(pts([0, 5])), null);
  assert.equal(irate([]), null);
  assert.deepEqual(rateBuckets(c, { stepMs: 20 * S }), [{ t: 0, v: 2.5 }, { t: 20 * S, v: 3.5 }, { t: 40 * S, v: 2.5 }]);
  assert.equal(delta(pts([0, 5], [1, 2], [2, 9])), 4);
  assert.equal(delta([]), null);
});

test('rollups carry what an average cannot, and merge exactly', () => {
  const raw: Point[] = [];
  for (let i = 0; i < 120; i++) raw.push({ t: i * M, v: (i * 7) % 13 });
  const perMinute = rollup(raw, { stepMs: M });
  const hourlyDirect = rollup(raw, { stepMs: H });
  const hourlyMerged = coarsen(perMinute, { stepMs: M }, { stepMs: H });
  assert.deepEqual(hourlyMerged, hourlyDirect);
  const m = mergeRollups(0, hourlyDirect);
  assert.equal(m.count, 120);
  assert.equal(fromRollup(m, 'avg'), raw.reduce((a, p) => a + p.v, 0) / 120);
  assert.equal(fromRollup(m, 'max'), 12);
  assert.equal(fromRollup(m, 'first'), 0);
  assert.throws(() => fromRollup(m, 'median'), /needs the raw points/);
  // An average of hourly averages is wrong when hours have different counts; the rollup is not.
  const uneven = pts([0, 10], [1, 20], [2, 30], [H, 100]);
  const hrs = rollup(uneven, { stepMs: H });
  assert.equal(fromRollup(mergeRollups(0, hrs), 'avg'), 40);
  assert.throws(() => coarsen(perMinute, { stepMs: M }, { stepMs: 90 * S }), /whole multiple/);
  assert.throws(() => mergeRollups(0, []), /nothing/);
});

test('counter increase across rollups includes the steps between buckets and resets', () => {
  const c: Point[] = [];
  let v = 0;
  for (let i = 0; i < 100; i++) {
    v = i === 60 ? 3 : v + 5;
    c.push({ t: i * M, v });
  }
  const direct = increase(c);
  assert.equal(increaseFromRollups(rollup(c, { stepMs: 10 * M })), direct);
  assert.equal(increaseFromRollups(rollup(c, { stepMs: H })), direct);
  assert.equal(increaseFromRollups(coarsen(rollup(c, { stepMs: M }), { stepMs: M }, { stepMs: 30 * M }).reverse()), direct);
});

test('resample: linear, previous, next, nearest, no extrapolation, no crossing long gaps', () => {
  const p = pts([0, 0], [10, 100], [50, 500]);
  const at = (method: 'linear' | 'previous' | 'next' | 'nearest', maxGapMs?: number) => resample(p, { stepMs: 5, from: 0, to: 55, method, ...(maxGapMs ? { maxGapMs } : {}) }).map((s) => s.v);
  assert.deepEqual(at('linear').slice(0, 4), [0, 50, 100, 150]);
  assert.equal(at('linear')[10], 500);
  assert.equal(at('linear').length, 11);
  assert.deepEqual(at('previous').slice(0, 5), [0, 0, 100, 100, 100]);
  assert.deepEqual(at('next').slice(1, 4), [100, 100, 500]);
  assert.deepEqual(at('nearest').slice(2, 6), [100, 100, 100, 100]);
  assert.deepEqual(at('linear', 20).slice(2, 5), [100, null, null]);
  assert.deepEqual(resample(p, { stepMs: 10, from: -20, to: 20 }).map((s) => s.v), [null, null, 0, 100]);
  assert.deepEqual(resample(p, { stepMs: 10, from: 40, to: 80 }).map((s) => s.v), [400, 500, null, null]);
  assert.throws(() => resample(p, { stepMs: 1, from: 0, to: 1_000_000 }), /limit/);
});

test('gap filling: null, zero, previous, linear, value, and the run limit', () => {
  const b = [{ t: 0, v: 10 }, { t: 40, v: 50 }, { t: 90, v: 7 }];
  const f = (fill: Parameters<typeof fillGaps>[1]['fill'], maxRun?: number) => fillGaps(b, { stepMs: 10, from: 0, to: 100, fill, ...(maxRun !== undefined ? { maxRun } : {}) }).map((s) => s.v);
  assert.deepEqual(f('null'), [10, null, null, null, 50, null, null, null, null, 7]);
  assert.deepEqual(f('zero').slice(0, 5), [10, 0, 0, 0, 50]);
  assert.deepEqual(f('previous').slice(0, 6), [10, 10, 10, 10, 50, 50]);
  assert.deepEqual(f('linear').slice(0, 5), [10, 20, 30, 40, 50]);
  assert.deepEqual(f({ value: -1 }).slice(4, 7), [50, -1, -1]);
  // A run longer than the limit is left alone, shorter ones are filled.
  assert.deepEqual(f('previous', 3), [10, 10, 10, 10, 50, null, null, null, null, 7]);
  assert.deepEqual(fillGaps([], { stepMs: 10, from: 0, to: 30, fill: 'linear' }).map((s) => s.v), [null, null, null]);
  assert.deepEqual(f('linear', 3).slice(5, 9), [null, null, null, null]);
});

test('gap detection reports where readings are missing and how many', () => {
  const p = pts([0, 1], [60 * S, 1], [120 * S, 1], [420 * S, 1], [480 * S, 1]);
  assert.deepEqual(findGaps(p, 60 * S), [{ from: 120 * S, to: 420 * S, missing: 4 }]);
  assert.deepEqual(findGaps(p, 60 * S, 6), []);
  assert.deepEqual(findGaps([], 60 * S), []);
});

const tiers = [{ name: 'raw', stepMs: 0, keepMs: 2 * H }, { name: '5m', stepMs: 5 * M, keepMs: 1 * D }, { name: '1h', stepMs: H, keepMs: 7 * D }];

test('tiered store: compaction moves whole buckets and every moment lives in one tier', () => {
  const st = new TieredStore(tiers);
  const now = 10 * D;
  const raw: Point[] = [];
  for (let t = now - 3 * D; t <= now; t += M) raw.push({ t, v: 1 });
  st.append(raw);
  assert.equal(st.counts.raw, raw.length);
  const r = st.compact(now);
  assert.ok(r.rolled > 0);
  const c = st.counts;
  assert.ok(c.raw! < raw.length / 10 && c['5m']! > 0 && c['1h']! > 0);
  assert.equal(st.compact(now).rolled, 0);
  // Total count over everything is the same as what went in (nothing lost, nothing double counted).
  const all = st.query(now - 3 * D, now + M, H);
  assert.equal(all.reduce((n, x) => n + x.rollup.count, 0), raw.length);
  assert.ok(all.every((x) => x.rollup.sum === x.rollup.count));
});

test('tiered store: query uses the finest resolution available; coarser data comes back at its own step', () => {
  const st = new TieredStore(tiers);
  const now = 10 * D;
  const raw: Point[] = [];
  for (let t = now - 3 * D; t < now; t += M) raw.push({ t, v: (t / M) % 10 });
  st.append(raw);
  st.compact(now);
  const recent = st.query(now - H, now, M);
  assert.ok(recent.every((x) => x.tier === 'raw' && x.stepMs === M));
  assert.equal(recent.length, 60);
  const old = st.query(now - 3 * D, now - 2 * D, M);
  assert.ok(old.every((x) => x.stepMs >= 5 * M));
  assert.ok(old.some((x) => x.tier === '1h' && x.stepMs === H));
  const hourly = st.query(now - 3 * D, now - 2 * D, H);
  assert.ok(hourly.every((x) => x.stepMs === H));
  assert.equal(hourly.reduce((n, x) => n + x.rollup.count, 0), D / M);
});

test('tiered store: old tiers are dropped after their keep time; late points are refused; same answers after repeats', () => {
  const st = new TieredStore(tiers);
  const now = 20 * D;
  st.append([{ t: now - 12 * D, v: 1 }, { t: now - 3 * D, v: 2 }, { t: now - 10 * M, v: 3 }]);
  const r = st.compact(now);
  assert.ok(r.dropped >= 1);
  assert.deepEqual(st.query(now - 13 * D, now - 8 * D, H), []);
  const late = st.append([{ t: now - 3 * D, v: 9 }, { t: now - 5 * M, v: 4 }]);
  assert.deepEqual(late, { accepted: 1, late: 1 });
  const before = JSON.stringify(st.query(now - 4 * D, now, H));
  st.compact(now);
  assert.equal(JSON.stringify(st.query(now - 4 * D, now, H)), before);
});

test('tiered store: a query bucket across a tier boundary is one bucket; configuration is checked', () => {
  const st = new TieredStore(tiers);
  const now = 10 * D;
  const raw: Point[] = [];
  for (let t = now - 5 * H; t < now; t += M) raw.push({ t, v: 1 });
  st.append(raw);
  st.compact(now);
  const q = st.query(now - 5 * H, now, H);
  assert.equal(new Set(q.map((x) => x.t)).size, q.length);
  assert.equal(q.reduce((n, x) => n + x.rollup.count, 0), 300);
  assert.ok(q.some((x) => x.tier.includes('+')) || q.every((x) => x.tier === 'raw' || x.tier === '5m'));
  assert.throws(() => new TieredStore([{ name: 'a', stepMs: M, keepMs: 1 }]), /first tier must be raw/);
  assert.throws(() => new TieredStore([tiers[0]!]), /at least one rollup/);
  assert.throws(() => new TieredStore([tiers[0]!, { name: 'x', stepMs: 5 * M, keepMs: H }]), /kept longer/);
  assert.throws(() => new TieredStore([tiers[0]!, tiers[1]!, { name: 'x', stepMs: 7 * M, keepMs: 9 * D }]), /multiple/);
});

test('too many buckets is refused rather than allocated', () => {
  const p = pts([0, 1], [1e12, 1]);
  // Sparse data makes only the buckets it touches; the dense forms (grid, fill) are capped.
  assert.equal(downsample(p, { stepMs: 1, agg: 'sum' }).length, 2);
  assert.equal(rollup(p, { stepMs: 1e11 }).length, 2);
  assert.throws(() => fillGaps([], { stepMs: 1, from: 0, to: 1e12, fill: 'zero' }), /limit/);
  assert.throws(() => resample(p, { stepMs: 1, from: 0, to: 1e12 }), /limit/);
});
