import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignRange, instantQuery, parse, parseDuration, PromQLError, rangeQuery, SeriesStore } from './index.ts';
import type { Result } from './index.ts';

const S = 1000;
const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

/** A counter growing 1 per second: samples every 10 s from 0 to 120 s. */
function counters(): SeriesStore {
  const st = new SeriesStore();
  for (let i = 0; i <= 12; i++) {
    st.ingest('http_requests_total', { job: 'api', code: '200' }, i * 10 * S, i * 10);
    st.ingest('http_requests_total', { job: 'api', code: '500' }, i * 10 * S, i);
    st.ingest('http_requests_total', { job: 'web', code: '200' }, i * 10 * S, i * 20);
  }
  return st;
}
const vec = (r: Result) => {
  assert.equal(r.type, 'vector');
  return (r as Extract<Result, { type: 'vector' }>).samples.map((s) => ({ labels: { ...s.labels }, value: s.value }));
};
const scalar = (r: Result) => {
  assert.equal(r.type, 'scalar');
  return (r as Extract<Result, { type: 'scalar' }>).value;
};

// ------------------------------------------------------------ parsing

test('durations: units, compound forms, and refusal of nonsense', () => {
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('2w'), 1_209_600_000);
  assert.equal(parseDuration('1y'), 31_536_000_000);
  assert.throws(() => parseDuration('5x'), PromQLError);
  assert.throws(() => parseDuration(''), PromQLError);
});

test('operator precedence: * before +, ^ is right-associative, unary minus binds looser than ^', () => {
  const st = new SeriesStore();
  assert.equal(scalar(instantQuery(st, '1 + 2 * 3', 0)), 7);
  assert.equal(scalar(instantQuery(st, '(1 + 2) * 3', 0)), 9);
  assert.equal(scalar(instantQuery(st, '2 ^ 3 ^ 2', 0)), 512);
  assert.equal(scalar(instantQuery(st, '-2 ^ 2', 0)), -4);
  assert.equal(scalar(instantQuery(st, '10 - 4 - 3', 0)), 3);
  assert.equal(scalar(instantQuery(st, '7 % 4', 0)), 3);
  assert.equal(scalar(instantQuery(st, '1 / 0', 0)), Infinity);
  assert.ok(Number.isNaN(scalar(instantQuery(st, '0 / 0', 0))));
  assert.equal(scalar(instantQuery(st, '3 > bool 2', 0)), 1);
  assert.equal(scalar(instantQuery(st, '3 < bool 2', 0)), 0);
  assert.throws(() => instantQuery(st, '3 > 2', 0), /bool modifier/);
});

test('selectors parse with matchers, range and offset; bad syntax says where', () => {
  const n = parse('up{job="api", code!~"5.."}[5m] offset 1h');
  assert.equal(n.t, 'selector');
  if (n.t === 'selector') {
    assert.equal(n.name, 'up');
    assert.deepEqual(n.matchers.map((m) => [m.label, m.op, m.value]), [['job', '=', 'api'], ['code', '!~', '5..']]);
    assert.equal(n.rangeMs, 300_000);
    assert.equal(n.offsetMs, 3_600_000);
  }
  assert.throws(() => parse(''), /empty query/);
  assert.throws(() => parse('up{job=api}'), /quoted string/);
  assert.throws(() => parse('up +'), (e: unknown) => e instanceof PromQLError && e.position === 4);
  assert.throws(() => parse('foo('), PromQLError);
  assert.throws(() => parse('nosuchfn(up)'), /unknown function "nosuchfn"/);
  assert.throws(() => parse('{}'), /needs a name or a matcher/);
  assert.throws(() => parse('{job=~".*"}'), /something other than the empty string/);
  assert.throws(() => parse('up[0s]'), /longer than zero/);
  assert.throws(() => parse('rate(up)'), /needs a range vector/);
  assert.throws(() => parse('up @ 5'), PromQLError);
  assert.throws(() => parse('a / on(x) group_left b'), /not supported/);
  assert.throws(() => parse('up $'), /unexpected character/);
  assert.throws(() => parse('"s"'), /string is not a value/);
});

test('hostile queries: deep nesting, long regexes and nested quantifiers are refused', () => {
  assert.throws(() => parse('('.repeat(200) + '1' + ')'.repeat(200)), /nested too deeply/);
  assert.throws(() => parse(`up{a=~"${'x'.repeat(300)}"}`), /regex longer/);
  assert.throws(() => parse('up{a=~"(a+)+$"}'), /nested quantifier/);
  assert.throws(() => parse('up{a=~"(a|b)*"}'), /nested quantifier/);
  assert.throws(() => parse('up{a=~"("}'), /not a valid regex/);
  assert.ok(parse('up{a=~"a+|b+"}'));
});

// ------------------------------------------------------------ selectors and staleness

test('an instant selector takes the newest sample inside the lookback window and none outside', () => {
  const st = new SeriesStore();
  st.ingest('temp', { room: 'a' }, 1000, 20);
  st.ingest('temp', { room: 'a' }, 2000, 21);
  assert.deepEqual(vec(instantQuery(st, 'temp', 2500)).map((s) => s.value), [21]);
  assert.deepEqual(vec(instantQuery(st, 'temp', 1500)).map((s) => s.value), [20]);
  assert.deepEqual(vec(instantQuery(st, 'temp', 500)), []); // before the first sample
  assert.deepEqual(vec(instantQuery(st, 'temp', 2000 + 300_000)), []); // lookback is open at the far end
  assert.deepEqual(vec(instantQuery(st, 'temp', 2000 + 299_999)).map((s) => s.value), [21]);
  assert.deepEqual(vec(instantQuery(st, 'temp', 2500, { limits: { lookbackMs: 100 } })), []);
  assert.deepEqual(vec(instantQuery(st, 'temp offset 1s', 2500)).map((s) => s.value), [20]);
});

test('matchers: equality, inequality, anchored regex, negated regex, and an empty value matches an absent label', () => {
  const st = counters();
  const labelsOf = (q: string) => vec(instantQuery(st, q, 120 * S)).map((s) => `${s.labels['job']}/${s.labels['code']}`).sort();
  assert.deepEqual(labelsOf('http_requests_total{job="api"}'), ['api/200', 'api/500']);
  assert.deepEqual(labelsOf('http_requests_total{job!="api"}'), ['web/200']);
  assert.deepEqual(labelsOf('http_requests_total{code=~"5.."}'), ['api/500']);
  assert.deepEqual(labelsOf('http_requests_total{code=~"2"}'), []); // anchored: "2" is not "200"
  assert.deepEqual(labelsOf('http_requests_total{code!~"2.."}'), ['api/500']);
  assert.deepEqual(labelsOf('http_requests_total{nolabel=""}'), ['api/200', 'api/500', 'web/200']);
  assert.deepEqual(labelsOf('{__name__="http_requests_total", job="web"}'), ['web/200']);
  assert.throws(() => instantQuery(st, 'http_requests_total', 0, { limits: { maxSeries: 2 } }), /more than 2 series/);
});

// ------------------------------------------------------------ rate and friends

test('rate extrapolates to the window edges as Prometheus does: a steady 1 per second reads 1', () => {
  const st = counters();
  const r = vec(instantQuery(st, 'rate(http_requests_total{job="api",code="200"}[60s])', 100 * S));
  assert.equal(r.length, 1);
  approx(r[0]!.value, 1);
  assert.deepEqual(r[0]!.labels, { job: 'api', code: '200' }); // the name is dropped
  approx(vec(instantQuery(st, 'increase(http_requests_total{job="api",code="200"}[60s])', 100 * S))[0]!.value, 60);
});

test('increase near the start of a counter is not extrapolated below zero', () => {
  const st = counters();
  approx(vec(instantQuery(st, 'increase(http_requests_total{job="api",code="200"}[60s])', 30 * S))[0]!.value, 30);
});

test('a counter reset is added back: 0,10,20 then 5,15 increases by 35', () => {
  const st = new SeriesStore();
  [0, 10, 20, 5, 15].forEach((v, i) => st.ingest('c_total', {}, i * 10 * S, v));
  approx(vec(instantQuery(st, 'increase(c_total[60s])', 40 * S))[0]!.value, 35);
});

test('rate needs two samples; one sample gives no result', () => {
  const st = new SeriesStore();
  st.ingest('c_total', {}, 10 * S, 5);
  assert.deepEqual(vec(instantQuery(st, 'rate(c_total[60s])', 20 * S)), []);
  assert.deepEqual(vec(instantQuery(st, 'rate(c_total[60s])', 500 * S)), []);
});

test('irate uses the last two samples and idelta and delta read a gauge', () => {
  const st = new SeriesStore();
  [[0, 10], [10, 30], [20, 70]].forEach(([t, v]) => st.ingest('g', {}, t! * S, v!));
  approx(vec(instantQuery(st, 'irate(g[60s])', 20 * S))[0]!.value, 4); // (70-30)/10
  assert.equal(vec(instantQuery(st, 'idelta(g[60s])', 20 * S))[0]!.value, 40);
  // delta: 60 over a sampled 20 s, window (-40,20]: edges extrapolated by half an interval at the start (too far), none at the end
  approx(vec(instantQuery(st, 'delta(g[60s])', 20 * S))[0]!.value, 60 * (20 + 5 + 0) / 20);
});

test('the window is open at its start and closed at its end', () => {
  const st = new SeriesStore();
  [0, 10, 20, 30].forEach((t, i) => st.ingest('x', {}, t * S, i));
  assert.equal(vec(instantQuery(st, 'count_over_time(x[20s])', 30 * S))[0]!.value, 2); // 20 and 30, not 10
  assert.equal(vec(instantQuery(st, 'count_over_time(x[30s])', 30 * S))[0]!.value, 3);
});

test('the _over_time functions fold the window', () => {
  const st = new SeriesStore();
  [3, 9, 6].forEach((v, i) => st.ingest('x', { a: '1' }, (i + 1) * 10 * S, v));
  const q = (f: string) => vec(instantQuery(st, `${f}(x[60s])`, 30 * S))[0]!.value;
  assert.equal(q('sum_over_time'), 18);
  assert.equal(q('avg_over_time'), 6);
  assert.equal(q('min_over_time'), 3);
  assert.equal(q('max_over_time'), 9);
  assert.equal(q('count_over_time'), 3);
  assert.equal(q('last_over_time'), 6);
});

// ------------------------------------------------------------ aggregations

test('sum by, sum without, count, avg, min, max group as asked, before or after the argument', () => {
  const st = counters();
  const at = 120 * S;
  const by = (q: string) => Object.fromEntries(vec(instantQuery(st, q, at)).map((s) => [s.labels['job'] ?? '-', s.value]));
  assert.deepEqual(by('sum by (job) (http_requests_total)'), { api: 132, web: 240 });
  assert.deepEqual(by('sum(http_requests_total) by (job)'), { api: 132, web: 240 });
  assert.deepEqual(by('sum(http_requests_total)'), { '-': 372 });
  assert.deepEqual(by('count by (job) (http_requests_total)'), { api: 2, web: 1 });
  assert.deepEqual(by('avg by (job) (http_requests_total)'), { api: 66, web: 240 });
  assert.deepEqual(by('min by (job) (http_requests_total)'), { api: 12, web: 240 });
  assert.deepEqual(by('max by (job) (http_requests_total)'), { api: 120, web: 240 });
  const wo = vec(instantQuery(st, 'sum without (code) (http_requests_total)', at));
  assert.deepEqual(wo.map((s) => [s.labels, s.value]).sort(), [[{ job: 'api' }, 132], [{ job: 'web' }, 240]]);
});

test('sum by (job) of rate, the everyday query, gives per-job rates', () => {
  const st = counters();
  const r = vec(instantQuery(st, 'sum by (job) (rate(http_requests_total[60s]))', 100 * S));
  const by = Object.fromEntries(r.map((s) => [s.labels['job'], s.value]));
  approx(by['api']!, 1 + 0.1);
  approx(by['web']!, 2);
});

test('topk and bottomk keep the largest or smallest, per group', () => {
  const st = counters();
  assert.deepEqual(vec(instantQuery(st, 'topk(1, http_requests_total)', 120 * S)).map((s) => s.labels['job']), ['web']);
  assert.deepEqual(vec(instantQuery(st, 'bottomk(2, http_requests_total)', 120 * S)).map((s) => s.value).sort((a, b) => a - b), [12, 120]);
  assert.deepEqual(vec(instantQuery(st, 'topk(1, http_requests_total) by (job)', 120 * S)).map((s) => s.value).sort((a, b) => a - b), [120, 240]);
});

// ------------------------------------------------------------ histograms

function histogram(): SeriesStore {
  const st = new SeriesStore();
  const at = 60 * S;
  for (const [job, counts] of [['a', [10, 30, 40]], ['b', [0, 0, 8]]] as const) {
    ['0.1', '0.5', '+Inf'].forEach((le, i) => {
      st.ingest('lat_bucket', { job, le }, 0, 0);
      st.ingest('lat_bucket', { job, le }, at, counts[i]!);
    });
  }
  return st;
}

test('histogram_quantile interpolates inside the bucket, per group, from rate of the buckets', () => {
  const st = histogram();
  const r = vec(instantQuery(st, 'histogram_quantile(0.5, sum by (job, le) (rate(lat_bucket[90s])))', 60 * S));
  const by = Object.fromEntries(r.map((s) => [s.labels['job'], s.value]));
  approx(by['a']!, 0.3); // rank 20 falls in (0.1, 0.5]: 0.1 + 0.4 * (10 / 20)
  approx(by['b']!, 0.5); // everything is above the last finite bucket: its upper bound
  const direct = vec(instantQuery(st, 'histogram_quantile(0.9, lat_bucket{job="a"})', 60 * S));
  assert.deepEqual(direct, [{ labels: { job: 'a' }, value: 0.5 }]); // rank 36 is in +Inf: the last finite bound
  assert.ok(Number.isNaN(vec(instantQuery(st, 'histogram_quantile(0.5, lat_bucket{job="zzz"})', 60 * S))[0]?.value ?? NaN));
});

// ------------------------------------------------------------ binary operators

test('vector with scalar, scalar with vector, and comparison filters that keep the name', () => {
  const st = counters();
  const at = 120 * S;
  assert.deepEqual(vec(instantQuery(st, 'http_requests_total{job="web"} / 2', at)).map((s) => s.value), [120]);
  assert.deepEqual(vec(instantQuery(st, '100 - http_requests_total{job="web"}', at)).map((s) => s.value), [-140]);
  const big = vec(instantQuery(st, 'http_requests_total > 100', at));
  assert.deepEqual(big.map((s) => s.value).sort((a, b) => a - b), [120, 240]);
  assert.equal(big[0]!.labels['__name__'], 'http_requests_total'); // a filter keeps the name
  const flags = vec(instantQuery(st, 'http_requests_total > bool 100', at));
  assert.deepEqual(flags.map((s) => s.value).sort(), [0, 1, 1]);
  assert.equal(flags[0]!.labels['__name__'], undefined);
  assert.deepEqual(vec(instantQuery(st, '100 < http_requests_total', at)).map((s) => s.value).sort((a, b) => a - b), [120, 240]);
});

test('vector with vector matches one to one on all labels but the name, and on() or ignoring() change that', () => {
  const st = new SeriesStore();
  st.ingest('errors_total', { job: 'api', code: '500' }, 0, 5);
  st.ingest('errors_total', { job: 'web', code: '500' }, 0, 1);
  st.ingest('requests_total', { job: 'api', code: '500' }, 0, 50);
  st.ingest('requests_total', { job: 'web', code: '500' }, 0, 10);
  st.ingest('requests_total', { job: 'db', code: '500' }, 0, 99);
  const ratio = vec(instantQuery(st, 'errors_total / requests_total', 0)).map((s) => [s.labels['job'], s.value]).sort();
  assert.deepEqual(ratio, [['api', 0.1], ['web', 0.1]]); // db has no errors_total to match
  st.ingest('limit', { job: 'api' }, 0, 100);
  const on = vec(instantQuery(st, 'errors_total{job="api"} / on (job) limit', 0));
  assert.deepEqual(on, [{ labels: { job: 'api' }, value: 0.05 }]);
  const ign = vec(instantQuery(st, 'errors_total{job="api"} / ignoring (code) limit', 0));
  assert.deepEqual(ign, [{ labels: { job: 'api' }, value: 0.05 }]);
  assert.deepEqual(vec(instantQuery(st, 'errors_total / limit', 0)), []); // code label differs: no match
});

test('many-to-many matching is refused on either side', () => {
  const st = new SeriesStore();
  st.ingest('a', { job: 'x', i: '1' }, 0, 1);
  st.ingest('a', { job: 'x', i: '2' }, 0, 2);
  st.ingest('b', { job: 'x' }, 0, 3);
  assert.throws(() => instantQuery(st, 'a / on (job) b', 0), /unique on the left/);
  assert.throws(() => instantQuery(st, 'b / on (job) a', 0), /unique on the right/);
});

test('and, or and unless are set operations on the matching labels', () => {
  const st = new SeriesStore();
  st.ingest('up', { job: 'a' }, 0, 1);
  st.ingest('up', { job: 'b' }, 0, 1);
  st.ingest('maint', { job: 'b' }, 0, 1);
  st.ingest('other', { job: 'c' }, 0, 7);
  const jobs = (q: string) => vec(instantQuery(st, q, 0)).map((s) => s.labels['job']).sort();
  assert.deepEqual(jobs('up and maint'), ['b']);
  assert.deepEqual(jobs('up unless maint'), ['a']);
  assert.deepEqual(jobs('up or other'), ['a', 'b', 'c']);
  assert.deepEqual(jobs('up or maint'), ['a', 'b']);
  assert.throws(() => instantQuery(st, 'up and 1', 0), /needs vectors/);
});

// ------------------------------------------------------------ functions

test('math functions work on vectors and scalars, and clamp, round, absent, scalar, vector, time behave', () => {
  const st = new SeriesStore();
  st.ingest('v', { a: '1' }, 0, -2.5);
  st.ingest('v', { a: '2' }, 0, 7.4);
  const vals = (q: string) => vec(instantQuery(st, q, 0)).map((s) => s.value).sort((a, b) => a - b);
  assert.deepEqual(vals('abs(v)'), [2.5, 7.4]);
  assert.deepEqual(vals('floor(v)'), [-3, 7]);
  assert.deepEqual(vals('ceil(v)'), [-2, 8]);
  assert.deepEqual(vals('round(v)'), [-2, 7]);
  assert.deepEqual(vals('round(v, 5)'), [0, 5]);
  assert.deepEqual(vals('clamp_min(v, 0)'), [0, 7.4]);
  assert.deepEqual(vals('clamp_max(v, 0)'), [-2.5, 0]);
  assert.deepEqual(vals('clamp(v, -1, 1)'), [-1, 1]);
  assert.equal(scalar(instantQuery(st, 'sqrt(16)', 0)), 4);
  assert.equal(scalar(instantQuery(st, 'log2(8)', 0)), 3);
  assert.equal(scalar(instantQuery(st, 'time()', 90_000)), 90);
  assert.deepEqual(vec(instantQuery(st, 'vector(3)', 0)), [{ labels: {}, value: 3 }]);
  assert.equal(scalar(instantQuery(st, 'scalar(v{a="2"})', 0)), 7.4);
  assert.ok(Number.isNaN(scalar(instantQuery(st, 'scalar(v)', 0)))); // two series: not a single value
  assert.deepEqual(vec(instantQuery(st, 'absent(nothing_here{job="x"})', 0)), [{ labels: { job: 'x' }, value: 1 }]);
  assert.deepEqual(vec(instantQuery(st, 'absent(v)', 0)), []);
  assert.deepEqual(vec(instantQuery(st, 'sort_desc(v)', 0)).map((s) => s.value), [7.4, -2.5]);
  assert.deepEqual(vec(instantQuery(st, 'sort(v)', 0)).map((s) => s.value), [-2.5, 7.4]);
  assert.throws(() => instantQuery(st, 'abs(v[5m])', 0), PromQLError);
  assert.throws(() => instantQuery(st, 'v[5m]', 0), /range vector cannot be the result/);
  assert.throws(() => parse('abs()'), /takes 1 argument/);
});

test('label_replace builds a label from a regex capture', () => {
  const st = new SeriesStore();
  st.ingest('v', { instance: 'host-1:9100' }, 0, 1);
  const r = vec(instantQuery(st, 'label_replace(v, "host", "$1", "instance", "(.*):.*")', 0));
  assert.equal(r[0]!.labels['host'], 'host-1');
  const none = vec(instantQuery(st, 'label_replace(v, "host", "$1", "instance", "nomatch(.*)")', 0));
  assert.equal(none[0]!.labels['host'], undefined);
});

// ------------------------------------------------------------ range queries

test('a range query evaluates at start, start+step, ... and returns one series per label set', () => {
  const st = counters();
  const m = rangeQuery(st, 'sum by (job) (rate(http_requests_total[30s]))', 60 * S, 100 * S, 20 * S);
  assert.equal(m.length, 2);
  const api = m.find((s) => s.labels['job'] === 'api')!;
  assert.deepEqual(api.points.map((p) => p.t), [60 * S, 80 * S, 100 * S]);
  for (const p of api.points) approx(p.v, 1.1);
  const web = m.find((s) => s.labels['job'] === 'web')!;
  for (const p of web.points) approx(p.v, 2);
});

test('a scalar range query is one series; a series absent at some steps has only the steps it exists', () => {
  const st = new SeriesStore();
  st.ingest('x', {}, 40 * S, 1);
  const m = rangeQuery(st, '2 * 3', 0, 20 * S, 10 * S);
  assert.deepEqual(m[0]!.points, [{ t: 0, v: 6 }, { t: 10 * S, v: 6 }, { t: 20 * S, v: 6 }]);
  const x = rangeQuery(st, 'x', 0, 60 * S, 20 * S, { limits: { lookbackMs: 30 * S } });
  assert.deepEqual(x[0]!.points, [{ t: 40 * S, v: 1 }, { t: 60 * S, v: 1 }]);
});

test('step alignment snaps start down and end up to multiples of the step, and steps are capped', () => {
  assert.deepEqual(alignRange(1_234_567, 2_000_001, 15_000), { startMs: 1_230_000, endMs: 2_010_000 });
  assert.deepEqual(alignRange(30_000, 60_000, 15_000), { startMs: 30_000, endMs: 60_000 });
  assert.throws(() => alignRange(0, 10, 0), /step must be above zero/);
  const st = new SeriesStore();
  assert.throws(() => rangeQuery(st, '1', 0, 100_000 * S, S), /more than the limit/);
  assert.throws(() => rangeQuery(st, '1', 10, 5, 1), /end is before start/);
  assert.throws(() => rangeQuery(st, 'x[5m]', 0, 10, 5), /range vector/);
  assert.equal(rangeQuery(st, '1', 0, 10_999, 1, { limits: { maxSteps: 11_000 } })[0]!.points.length, 11_000);
});

// ------------------------------------------------------------ store

test('the store takes out-of-order samples, replaces the same timestamp, and refuses bad names', () => {
  const st = new SeriesStore();
  st.ingest('m', {}, 2000, 2);
  st.ingest('m', {}, 1000, 1);
  st.ingest('m', {}, 2000, 22);
  assert.equal(st.size, 1);
  assert.equal(vec(instantQuery(st, 'count_over_time(m[10s])', 3000))[0]!.value, 2);
  assert.equal(vec(instantQuery(st, 'sum_over_time(m[10s])', 3000))[0]!.value, 23);
  assert.throws(() => st.ingest('bad name', {}, 0, 1), /not a metric name/);
  assert.throws(() => st.ingest('m', { 'bad-label': 'x' }, 0, 1), /not a label name/);
  assert.throws(() => st.ingest('m', {}, NaN, 1), /finite/);
});

test('a scrape in Prometheus text is stored at the scrape time, and queried like any series', () => {
  const st = new SeriesStore();
  const page = (n: number) => `# TYPE jobs_total counter\njobs_total{queue="mail"} ${n}\njobs_total{queue="sms"} ${n * 2}\n`;
  assert.equal(st.ingestText(page(10), 0), 2);
  st.ingestText(page(70), 60 * S);
  const r = vec(instantQuery(st, 'rate(jobs_total{queue="mail"}[61s])', 60 * S));
  approx(r[0]!.value, 1);
  assert.deepEqual(vec(instantQuery(st, 'sum(jobs_total)', 60 * S)).map((s) => s.value), [210]);
});
