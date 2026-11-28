import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ColumnStore, ColumnarError, Hll, OTHER, Rollup, bucketEnd, bucketStart } from './index.ts';
import type { Filter, InputRow } from './index.ts';

const schema = [{ name: 'ts', type: 'time' }, { name: 'country', type: 'string' }, { name: 'path', type: 'string' }, { name: 'user', type: 'string' }, { name: 'ms', type: 'float' }, { name: 'bytes', type: 'int' }, { name: 'ok', type: 'bool' }] as const;
const T0 = Date.UTC(2024, 4, 15, 10, 0, 0); // Wednesday
const ev = (dt: number, country: string, path: string, user: string, ms: number | null, bytes: number, ok = true): InputRow => ({ ts: T0 + dt, country, path, user, ms, bytes, ok });
const sample: InputRow[] = [
  ev(0, 'US', '/a', 'u1', 10, 100),
  ev(1_000, 'US', '/a', 'u2', 30, 200),
  ev(61_000, 'DE', '/b', 'u1', 20, 50, false),
  ev(3_700_000, 'US', '/b', 'u3', null, 400),
  ev(3_800_000, 'DE', '/a', 'u3', 40, 10),
];
const loaded = () => {
  const s = new ColumnStore(schema);
  assert.equal(s.append(sample).accepted, 5);
  return s;
};

test('group by a column with count, sum, average, min and max', () => {
  const rows = loaded().query({ by: ['country'], aggs: [{ op: 'count' }, { op: 'sum', col: 'bytes' }, { op: 'avg', col: 'ms' }, { op: 'min', col: 'ms' }, { op: 'max', col: 'ms' }], orderBy: { key: 'country' } });
  assert.deepEqual(rows, [
    { country: 'DE', count: 2, sum_bytes: 60, avg_ms: 30, min_ms: 20, max_ms: 40 },
    { country: 'US', count: 3, sum_bytes: 700, avg_ms: 20, min_ms: 10, max_ms: 30 },
  ]);
});

test('nulls: count of a column counts only what is there; empty aggregates are null, not zero', () => {
  const s = loaded();
  const [r] = s.query({ aggs: [{ op: 'count' }, { op: 'count', col: 'ms', as: 'with_ms' }, { op: 'avg', col: 'ms' }] });
  assert.deepEqual(r, { count: 5, with_ms: 4, avg_ms: 25 });
  const none = s.query({ where: [{ col: 'country', op: 'eq', value: 'FR' }], aggs: [{ op: 'count' }, { op: 'avg', col: 'ms' }, { op: 'min', col: 'ms' }, { op: 'sum', col: 'bytes' }] });
  assert.deepEqual(none, [], 'no rows, no groups');
  const empty = new ColumnStore(schema).query({ aggs: [{ op: 'count' }] });
  assert.deepEqual(empty, []);
  const s2 = new ColumnStore(schema);
  s2.append([ev(0, 'US', '/a', 'u', null, 1)]);
  assert.deepEqual(s2.query({ aggs: [{ op: 'avg', col: 'ms' }, { op: 'min', col: 'ms' }, { op: 'max', col: 'ms' }, { op: 'sum', col: 'ms' }] }), [{ avg_ms: null, min_ms: null, max_ms: null, sum_ms: 0 }]);
});

test('bad rows are rejected with their position and reason; the good ones are kept', () => {
  const s = new ColumnStore(schema);
  const r = s.append([ev(0, 'US', '/a', 'u', 1, 1), { ts: 'yesterday' }, { ts: T0, bytes: 1.5 }, { ts: T0, ms: Number.NaN }, { ts: -5 }, { ts: T0, country: 7 as never }, { ts: T0, ok: 'yes' as never }, { ts: T0, path: 'x'.repeat(1025) }, ev(5, 'DE', '/b', 'v', 2, 2)]);
  assert.equal(r.accepted, 2);
  assert.deepEqual(r.rejected.map((x) => [x.index, x.reason]), [
    [1, 'ts: expected a finite number'],
    [2, 'bytes: expected a whole number'],
    [3, 'ms: expected a finite number'],
    [4, 'ts: a time is milliseconds since 1970 and cannot be negative'],
    [5, 'country: expected a string'],
    [6, 'ok: expected true or false'],
    [7, 'path: a string value may be at most 1024 characters'],
  ]);
  assert.equal(s.length, 2);
});

test('filters: equals, not equals, in, prefix, ranges, booleans, and values the store has never seen', () => {
  const s = loaded();
  const count = (where: Filter[]) => (s.query({ where, aggs: [{ op: 'count' }] })[0]?.['count'] ?? 0) as number;
  assert.equal(count([{ col: 'country', op: 'eq', value: 'US' }]), 3);
  assert.equal(count([{ col: 'country', op: 'ne', value: 'US' }]), 2);
  assert.equal(count([{ col: 'country', op: 'ne', value: 'FR' }]), 5);
  assert.equal(count([{ col: 'country', op: 'eq', value: 'FR' }]), 0);
  assert.equal(count([{ col: 'country', op: 'in', values: ['DE', 'FR'] }]), 2);
  assert.equal(count([{ col: 'path', op: 'prefix', value: '/' }]), 5);
  assert.equal(count([{ col: 'path', op: 'prefix', value: '/b' }]), 2);
  assert.equal(count([{ col: 'ms', op: 'gt', value: 20 }]), 2);
  assert.equal(count([{ col: 'ms', op: 'gte', value: 20 }]), 3);
  assert.equal(count([{ col: 'bytes', op: 'lt', value: 100 }]), 2);
  assert.equal(count([{ col: 'bytes', op: 'lte', value: 100 }]), 3);
  assert.equal(count([{ col: 'ts', op: 'between', from: T0, to: T0 + 61_000 }]), 2, 'from is inclusive, to is exclusive');
  assert.equal(count([{ col: 'ok', op: 'eq', value: false }]), 1);
  assert.equal(count([{ col: 'country', op: 'eq', value: 'US' }, { col: 'path', op: 'eq', value: '/b' }]), 1, 'filters are ANDed');
  assert.equal(count([{ col: 'ms', op: 'gt', value: 0 }]), 4, 'a null never satisfies a comparison');
});

test('time buckets: minute, hour, day, week (Monday) and month in UTC', () => {
  const wed = Date.UTC(2024, 4, 15, 10, 30, 45);
  assert.equal(bucketStart(wed, 'minute'), Date.UTC(2024, 4, 15, 10, 30));
  assert.equal(bucketStart(wed, 'hour'), Date.UTC(2024, 4, 15, 10));
  assert.equal(bucketStart(wed, 'day'), Date.UTC(2024, 4, 15));
  assert.equal(bucketStart(wed, 'week'), Date.UTC(2024, 4, 13), 'Monday');
  assert.equal(bucketStart(Date.UTC(2024, 4, 19, 23, 59), 'week'), Date.UTC(2024, 4, 13), 'Sunday belongs to the week before');
  assert.equal(bucketStart(Date.UTC(2024, 4, 20), 'week'), Date.UTC(2024, 4, 20));
  assert.equal(bucketStart(0, 'week'), Date.UTC(1969, 11, 29), '1970-01-01 was a Thursday');
  assert.equal(bucketStart(wed, 'month'), Date.UTC(2024, 4, 1));
  assert.equal(bucketEnd(Date.UTC(2024, 11, 1), 'month'), Date.UTC(2025, 0, 1));
  assert.equal(bucketEnd(Date.UTC(2024, 1, 1), 'month'), Date.UTC(2024, 2, 1), 'February 2024 has 29 days');
  assert.equal(bucketEnd(Date.UTC(2024, 4, 13), 'week'), Date.UTC(2024, 4, 20));
  const rows = loaded().query({ time: { col: 'ts', every: 'hour' }, by: ['country'], aggs: [{ op: 'count' }], orderBy: { key: 'bucket' } });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter((r) => r['bucket'] === T0).map((r) => [r['country'], r['count']]).sort(), [['DE', 1], ['US', 2]]);
});

test('distinct counts: exact for small sets, close for large ones, and merging two sketches is a union', () => {
  const small = new ColumnStore(schema);
  small.append(Array.from({ length: 50 }, (_, i) => ev(i, 'US', '/a', `u${i % 5}`, 1, 1)));
  assert.equal(small.query({ aggs: [{ op: 'distinct', col: 'user' }] })[0]!['distinct_user'], 5);
  const big = new ColumnStore(schema);
  big.append(Array.from({ length: 20_000 }, (_, i) => ev(i, 'US', '/a', `user-${i % 10_000}`, 1, 1)));
  const est = big.query({ aggs: [{ op: 'distinct', col: 'user' }] })[0]!['distinct_user'] as number;
  assert.ok(Math.abs(est - 10_000) / 10_000 < 0.1, `estimated ${est} for 10000`);
  const a = new Hll();
  const b = new Hll();
  for (let i = 0; i < 3000; i++) a.add(`k${i}`);
  for (let i = 1500; i < 4500; i++) b.add(`k${i}`);
  a.merge(b);
  assert.ok(Math.abs(a.estimate() - 4500) / 4500 < 0.1, `union ${a.estimate()}`);
  const e = new Hll();
  assert.equal(e.estimate(), 0);
});

test('bounded memory: oldest chunks are dropped past maxRows, and the bytes held stop growing', () => {
  const s = new ColumnStore(schema, { maxRows: 1000, chunkRows: 100 });
  let ceiling = 0;
  for (let r = 0; r < 50; r++) {
    s.append(Array.from({ length: 100 }, (_, i) => ev(r * 100 + i, 'US', '/a', 'u', 1, 1)));
    if (r === 20) ceiling = s.bytes();
  }
  assert.ok(s.length <= 1000 && s.length >= 900, `${s.length} rows held`);
  assert.equal(s.evicted, 5000 - s.length);
  assert.ok(s.bytes() <= ceiling * 1.05, 'memory is flat once full');
  const oldest = s.query({ aggs: [{ op: 'min', col: 'ts' }] })[0]!['min_ts'] as number;
  assert.ok(oldest >= T0 + 3900, 'the earliest events are the ones that went');
  assert.throws(() => new ColumnStore([]), /at least one column/);
});

test('a string column with too many distinct values folds the rest into "__other__" and counts them', () => {
  const s = new ColumnStore(schema, { maxDistinct: 3 });
  s.append(['a', 'b', 'c', 'd', 'e', 'a'].map((u, i) => ev(i, 'US', '/p', u, 1, 1)));
  assert.equal(s.overflowed, 2, 'd and e');
  const rows = s.query({ by: ['user'], aggs: [{ op: 'count' }], orderBy: { key: 'user' } });
  assert.deepEqual(rows.map((r) => [r['user'], r['count']]), [['__other__', 2], ['a', 2], ['b', 1], ['c', 1]]);
});

test('too many groups fold into one "__other__" group, and the totals still add up', () => {
  const s = new ColumnStore(schema);
  s.append(Array.from({ length: 100 }, (_, i) => ev(i, 'US', `/p${i % 40}`, 'u', 1, 10)));
  const rows = s.query({ by: ['path'], aggs: [{ op: 'count' }, { op: 'sum', col: 'bytes' }], maxGroups: 10 });
  assert.equal(rows.length, 11);
  const other = rows.find((r) => r['path'] === OTHER)!;
  assert.ok((other['count'] as number) > 0);
  assert.equal(rows.reduce((a, r) => a + (r['count'] as number), 0), 100);
  assert.equal(rows.reduce((a, r) => a + (r['sum_bytes'] as number), 0), 1000);
});

test('ordering and limits give a top-N, with nulls last', () => {
  const rows = loaded().query({ by: ['path'], aggs: [{ op: 'sum', col: 'bytes', as: 'total' }], orderBy: { key: 'total', desc: true }, limit: 1 });
  assert.deepEqual(rows, [{ path: '/b', total: 450 }]);
  const users = loaded().query({ by: ['user'], aggs: [{ op: 'count' }], orderBy: { key: 'count', desc: true } });
  assert.deepEqual(users.map((u) => u['user']).slice(0, 2).sort(), ['u1', 'u3']);
});

test('queries naming a missing column, the wrong kind of column, or two aggregates with one name are refused', () => {
  const s = loaded();
  assert.throws(() => s.query({ by: ['nope'], aggs: [{ op: 'count' }] }), /no column "nope"/);
  assert.throws(() => s.query({ aggs: [{ op: 'sum', col: 'country' }] }), /column "country" is string/);
  assert.throws(() => s.query({ aggs: [{ op: 'sum' }] }), /sum needs a column/);
  assert.throws(() => s.query({ aggs: [] }), /at least one aggregate/);
  assert.throws(() => s.query({ aggs: [{ op: 'count' }, { op: 'count' }] }), /two aggregates are called "count"/);
  assert.throws(() => s.query({ time: { col: 'bytes', every: 'day' }, aggs: [{ op: 'count' }] }), /needs time/);
  assert.throws(() => s.query({ where: [{ col: 'country', op: 'eq', value: 5 }], aggs: [{ op: 'count' }] }), /is a string/);
  assert.throws(() => new ColumnStore([{ name: 'a', type: 'int' }, { name: 'a', type: 'int' }]), /declared twice/);
  assert.throws(() => new ColumnStore([{ name: 'bad name', type: 'int' }]), /not a usable column name/);
});

const rollupDef = { time: 'ts', every: 'hour', dims: ['country'], aggs: [{ op: 'count' }, { op: 'sum', col: 'bytes' }, { op: 'avg', col: 'ms' }, { op: 'distinct', col: 'user' }], allowedLatenessMs: 10 * 60_000 } as const;
const H = 3_600_000;

test('a rollup keeps hourly buckets by country and reports each only once it has ended', () => {
  const r = new Rollup(rollupDef);
  r.ingest(sample.slice(0, 3));
  assert.deepEqual(r.report(), [], 'the hour is still open');
  r.ingest(sample.slice(3));
  const rep = r.report();
  assert.equal(rep.length, 1);
  assert.equal(rep[0]!.bucket, T0);
  assert.equal(rep[0]!.revision, 3);
  assert.equal(rep[0]!.correction, false);
  assert.deepEqual([...rep[0]!.rows].sort((a, b) => String(a['country']).localeCompare(String(b['country']))), [
    { bucket: T0, country: 'DE', count: 1, sum_bytes: 50, avg_ms: 20, distinct_user: 1 },
    { bucket: T0, country: 'US', count: 2, sum_bytes: 300, avg_ms: 20, distinct_user: 2 },
  ]);
  assert.deepEqual(r.report(), [], 'reported once');
});

test('late data inside the allowance revises a reported bucket as a correction; beyond it, the row is refused and counted', () => {
  const late: InputRow[] = [];
  const r = new Rollup({ ...rollupDef, onTooLate: (row) => late.push(row) });
  r.ingest(sample);
  const first = r.report();
  assert.equal(first.length, 1, 'the 10:00 hour has ended by the watermark, the 11:00 hour has not');
  assert.equal(first[0]!.revision, 3);
  r.ingest([ev(30_000, 'US', '/late', 'u9', 5, 1000)]);
  const rep = r.report();
  assert.equal(rep.length, 1);
  assert.equal(rep[0]!.bucket, T0);
  assert.equal(rep[0]!.correction, true);
  assert.equal(rep[0]!.revision, 4);
  assert.equal(rep[0]!.rows.find((x) => x['country'] === 'US')!['sum_bytes'], 1300);
  assert.deepEqual(r.report(), [], 'a correction is reported once');
  r.ingest([ev(H + 11 * 60_000, 'US', '/now', 'u9', 1, 1)]);
  r.ingest([ev(40_000, 'US', '/too-late', 'u9', 5, 1)]);
  assert.equal(r.stats.tooLate, 1);
  assert.equal(late.length, 1);
  assert.equal(late[0]!['path'], '/too-late');
  assert.equal(r.query({ from: T0, to: T0 + H })[0]!['sum_bytes'], 100 + 200 + 50 + 1000, 'the refused row is not in the numbers');
  r.ingest([ev(3 * H, 'US', '/next', 'u9', 1, 1)]);
  r.ingest([ev(H + 5_000, 'US', '/old-hour', 'u9', 1, 1)]);
  assert.equal(r.stats.tooLate, 2, 'the 11:00 hour closed once the watermark was ten minutes past its end');
  r.ingest([ev(-H, 'US', '/ancient', 'u9', 1, 1)]);
  assert.equal(r.stats.tooLate, 3, 'a bucket nobody has seen is closed as well, so history cannot be rewritten');
});

test('a rollup built from events in any order within the allowance equals the same events scanned in the column store', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const events: InputRow[] = Array.from({ length: 600 }, (_, i) => ev(i * 20_000 + Math.floor(rnd() * 5000), ['US', 'DE', 'FR'][Math.floor(rnd() * 3)]!, '/a', `u${Math.floor(rnd() * 40)}`, Math.floor(rnd() * 100), Math.floor(rnd() * 1000)));
  const shuffled = events.map((e, i) => ({ e, k: (i - (i % 8)) + rnd() * 8 })).sort((a, b) => a.k - b.k).map((x) => x.e);
  const r = new Rollup({ ...rollupDef, allowedLatenessMs: 20 * 60_000 });
  r.ingest(shuffled);
  const store = new ColumnStore(schema);
  store.append(events);
  const norm = (rows: Record<string, unknown>[]) => rows.map((x) => JSON.stringify(Object.entries(x).sort())).sort();
  const want = store.query({ time: { col: 'ts', every: 'hour' }, by: ['country'], aggs: [{ op: 'count' }, { op: 'sum', col: 'bytes' }, { op: 'avg', col: 'ms' }, { op: 'distinct', col: 'user' }] });
  assert.deepEqual(norm(r.query({ by: ['country'] })), norm(want));
  assert.equal(r.stats.tooLate, 0);
  assert.equal(r.stats.accepted, 600);
});

test('rolling up to a coarser grain merges partial states: weighted averages and unions of distinct users', () => {
  const r = new Rollup({ ...rollupDef, allowedLatenessMs: 24 * H });
  r.ingest([ev(0, 'US', '/a', 'u1', 10, 1), ev(1000, 'US', '/a', 'u2', 10, 1), ev(2000, 'US', '/a', 'u3', 10, 1), ev(H, 'US', '/a', 'u1', 70, 1), ev(2 * H, 'DE', '/a', 'u1', 5, 1)]);
  const [us] = r.query({ every: 'day', by: ['country'], where: { country: 'US' } });
  assert.equal(us!['count'], 4);
  assert.equal(us!['avg_ms'], 25, '(10+10+10+70)/4, not the average of hourly averages (10+70)/2');
  assert.equal(us!['distinct_user'], 3, 'u1 in two hours is one person');
  assert.equal(us!['bucket'], Date.UTC(2024, 4, 15));
  const all = r.query({ every: 'day' });
  assert.equal(all.length, 1);
  assert.equal(all[0]!['count'], 5);
  assert.equal(all[0]!['distinct_user'], 3);
  assert.deepEqual(r.query({ from: T0 + H, to: T0 + 2 * H }).map((x) => x['count']), [1]);
  assert.throws(() => r.query({ every: 'minute' }), /kept by hour/);
  assert.throws(() => r.query({ by: ['path'] }), /not a dimension/);
  assert.throws(() => r.query({ where: { nope: 'x' } }), /not a dimension/);
});

test('rollup limits: old buckets are dropped past retention, big bucket fan-out folds, bad events are counted', () => {
  const r = new Rollup({ ...rollupDef, retentionMs: 3 * H, maxGroupsPerBucket: 2, allowedLatenessMs: 100 * H });
  r.ingest([ev(0, 'US', '/a', 'u', 1, 1), ev(0, 'DE', '/a', 'u', 1, 1), ev(0, 'FR', '/a', 'u', 1, 1), ev(0, 'ES', '/a', 'u', 1, 1)]);
  assert.equal(r.stats.folded, 2);
  assert.deepEqual(r.query({ by: ['country'] }).map((x) => [x['country'], x['count']]).sort(), [['DE', 1], ['US', 1], ['__other__', 2]]);
  r.ingest([ev(10 * H, 'US', '/a', 'u', 1, 1)]);
  assert.equal(r.size, 1, 'the first bucket is past retention');
  assert.equal(r.stats.dropped, 1);
  r.ingest([{ ts: 'soon' }, { country: 'US' }, { ts: Number.NaN }, { ts: -1 }]);
  assert.equal(r.stats.invalid, 4);
  assert.throws(() => new Rollup({ ...rollupDef, dims: ['a', 'a'] }), /distinct/);
  assert.throws(() => new Rollup({ ...rollupDef, aggs: [] }), /at least one aggregate/);
});
