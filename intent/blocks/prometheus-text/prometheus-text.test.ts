import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CardinalityError, MetricsError, ParseError, Registry, checkHistogram, findSample, formatValue, histogramBuckets, histogramQuantile, parseExposition } from './index.ts';

const SPEC = `# HELP http_requests_total The total number of HTTP requests.
# TYPE http_requests_total counter
http_requests_total{method="post",code="200"} 1027 1395066363000
http_requests_total{method="post",code="400"}    3 1395066363000

# Escaping in label values:
msdos_file_access_time_seconds{path="C:\\\\DIR\\\\FILE.TXT",error="Cannot find file:\\n\\"FILE.TXT\\""} 1.458255915e9

# Minimalistic line:
metric_without_timestamp_and_labels 12.47

# A weird metric from before the epoch:
something_weird{problem="division by zero"} +Inf -3982045

# A histogram, which has a pretty complex representation in the text format:
# HELP http_request_duration_seconds A histogram of the request duration.
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.05"} 24054
http_request_duration_seconds_bucket{le="0.1"} 33444
http_request_duration_seconds_bucket{le="0.2"} 100392
http_request_duration_seconds_bucket{le="0.5"} 129389
http_request_duration_seconds_bucket{le="1"} 133988
http_request_duration_seconds_bucket{le="+Inf"} 144320
http_request_duration_seconds_sum 53423
http_request_duration_seconds_count 144320

# Finally a summary, which has a complex representation, too:
# HELP rpc_duration_seconds A summary of the RPC duration in seconds.
# TYPE rpc_duration_seconds summary
rpc_duration_seconds{quantile="0.01"} 3102
rpc_duration_seconds{quantile="0.05"} 3272
rpc_duration_seconds{quantile="0.5"} 4773
rpc_duration_seconds{quantile="0.9"} 9001
rpc_duration_seconds{quantile="0.99"} 76656
rpc_duration_seconds_sum 1.7560473e+07
rpc_duration_seconds_count 2693
`;

test('the format specification\'s own example parses: counters, escapes, timestamps, infinities, histogram and summary', () => {
  const r = parseExposition(SPEC);
  assert.equal(r.format, 'prometheus');
  const by = Object.fromEntries(r.families.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(by), ['http_requests_total', 'msdos_file_access_time_seconds', 'metric_without_timestamp_and_labels', 'something_weird', 'http_request_duration_seconds', 'rpc_duration_seconds']);
  assert.equal(by['http_requests_total']!.type, 'counter');
  assert.equal(by['http_requests_total']!.help, 'The total number of HTTP requests.');
  assert.deepEqual(by['http_requests_total']!.samples[1], { name: 'http_requests_total', labels: { method: 'post', code: '400' }, value: 3, timestampMs: 1395066363000 });
  assert.deepEqual(by['msdos_file_access_time_seconds']!.samples[0]!.labels, { path: 'C:\\DIR\\FILE.TXT', error: 'Cannot find file:\n"FILE.TXT"' });
  assert.equal(by['msdos_file_access_time_seconds']!.samples[0]!.value, 1.458255915e9);
  assert.equal(by['metric_without_timestamp_and_labels']!.samples[0]!.value, 12.47);
  assert.equal(by['metric_without_timestamp_and_labels']!.samples[0]!.timestampMs, undefined);
  assert.equal(by['something_weird']!.samples[0]!.value, Infinity);
  assert.equal(by['something_weird']!.samples[0]!.timestampMs, -3982045);
  assert.equal(by['http_request_duration_seconds']!.samples.length, 8);
  assert.equal(by['rpc_duration_seconds']!.samples.length, 7);
  assert.equal(r.samples, 20);
});

test('the specification histogram is sound, and its 0.9 quantile interpolates inside the 0.5 to 1 bucket', () => {
  const f = parseExposition(SPEC).families.find((x) => x.name === 'http_request_duration_seconds')!;
  assert.deepEqual(checkHistogram(f), []);
  const b = histogramBuckets(f);
  assert.equal(b.length, 6);
  assert.equal(b[5]!.le, Infinity);
  const expected = 0.5 + 0.5 * ((0.9 * 144320 - 129389) / (133988 - 129389));
  assert.ok(Math.abs(histogramQuantile(0.9, b) - expected) < 1e-12);
  assert.ok(Math.abs(histogramQuantile(0.9, b) - 0.554251) < 1e-6);
  assert.equal(histogramQuantile(0.99999, b), 1, 'a rank in the +Inf bucket answers with the highest finite bound');
  assert.equal(findSample(f, 'http_request_duration_seconds_sum')!.value, 53423);
});

test('writing: counters, gauges and their help text come out exactly, sorted and escaped', () => {
  const r = new Registry();
  r.gauge('temp_celsius', 'Room "temp"\nin C', ['room']).set(21.5, { room: 'a\\b' });
  const c = r.counter('http_requests_total', 'Requests.', ['code']);
  c.inc({ code: '500' });
  c.inc({ code: '200' }, 2);
  c.inc({ code: '200' });
  assert.equal(
    r.expose(),
    ['# HELP http_requests_total Requests.', '# TYPE http_requests_total counter', 'http_requests_total{code="200"} 3', 'http_requests_total{code="500"} 1', '# HELP temp_celsius Room "temp"\\nin C', '# TYPE temp_celsius gauge', 'temp_celsius{room="a\\\\b"} 21.5', ''].join('\n'),
  );
});

test('writing: a histogram has cumulative buckets with inclusive bounds, +Inf, sum and count', () => {
  const r = new Registry();
  const h = r.histogram('job_seconds', 'Job time.', [], [0.1, 1]);
  for (const v of [0.05, 0.1, 0.5, 1, 7]) h.observe(v);
  assert.equal(r.expose(), ['# HELP job_seconds Job time.', '# TYPE job_seconds histogram', 'job_seconds_bucket{le="0.1"} 2', 'job_seconds_bucket{le="1"} 4', 'job_seconds_bucket{le="+Inf"} 5', 'job_seconds_sum 8.65', 'job_seconds_count 5', ''].join('\n'));
  assert.throws(() => h.observe(Number.NaN), /NaN/);
});

test('writing: OpenMetrics names the counter family without _total, ends with # EOF, and parses back', () => {
  const r = new Registry();
  r.counter('jobs_total', 'Jobs.', ['kind']).inc({ kind: 'x' }, 5);
  r.gauge('queue_depth', 'Depth.').set(Number.NaN);
  const text = r.expose('openmetrics');
  assert.equal(text, ['# HELP jobs Jobs.', '# TYPE jobs counter', 'jobs_total{kind="x"} 5', '# HELP queue_depth Depth.', '# TYPE queue_depth gauge', 'queue_depth NaN', '# EOF', ''].join('\n'));
  const p = parseExposition(text);
  assert.equal(p.format, 'openmetrics');
  const jobs = p.families.find((f) => f.name === 'jobs')!;
  assert.equal(jobs.type, 'counter');
  assert.equal(findSample(jobs, 'jobs_total', { kind: 'x' })!.value, 5);
  assert.ok(Number.isNaN(p.families.find((f) => f.name === 'queue_depth')!.samples[0]!.value));
});

test('writing then reading gives back the same numbers, including hostile label values', () => {
  const r = new Registry();
  const nasty = 'a"b\\c\nd}{=,';
  r.counter('x_total', 'x', ['v']).inc({ v: nasty }, 2.5);
  const p = parseExposition(r.expose());
  assert.equal(p.families[0]!.samples[0]!.labels['v'], nasty);
  assert.equal(p.families[0]!.samples[0]!.value, 2.5);
  assert.equal(formatValue(Infinity), '+Inf');
  assert.equal(formatValue(-Infinity), '-Inf');
  assert.equal(formatValue(3), '3');
});

test('cardinality: a series beyond the cap is refused and counted, or folded into one overflow series', () => {
  const strict = new Registry({ maxSeriesPerMetric: 3 });
  const c = strict.counter('hits_total', 'h', ['user']);
  for (const u of ['a', 'b', 'c']) c.inc({ user: u });
  assert.throws(() => c.inc({ user: 'd' }), CardinalityError);
  c.inc({ user: 'a' });
  assert.equal(c.value({ user: 'a' }), 2, 'existing series still work');
  assert.deepEqual(strict.overflow(), { hits: 1 });
  const fold = new Registry({ maxSeriesPerMetric: 2, onOverflow: 'fold' });
  const f = fold.counter('hits_total', 'h', ['user']);
  f.inc({ user: 'a' });
  f.inc({ user: 'b' });
  for (const u of ['c', 'd', 'e']) f.inc({ user: u });
  assert.match(fold.expose(), /hits_total\{user="__overflow__"\} 3/);
  assert.deepEqual(fold.overflow(), { hits: 3 });
  assert.equal(parseExposition(fold.expose()).families[0]!.samples.length, 3);
});

test('writing: names, labels, buckets and values are checked', () => {
  const r = new Registry();
  assert.throws(() => r.gauge('bad name', 'x'), /not a valid metric name/);
  assert.throws(() => r.gauge('ok', 'x', ['bad-label']), /not a usable label/);
  assert.throws(() => r.gauge('ok', 'x', ['__reserved']), /not a usable label/);
  assert.throws(() => r.histogram('h', 'x', ['le']), /reserved/);
  assert.throws(() => r.gauge('ok', 'x', ['a', 'a']), /distinct/);
  assert.throws(() => r.histogram('h', 'x', [], [1, 1]), /strictly increasing/);
  assert.throws(() => r.histogram('h', 'x', [], [1, Infinity]), /finite/);
  assert.throws(() => r.histogram('h', 'x', [], []), /between 1 and 200/);
  const c = r.counter('c_total', 'x', ['a']);
  assert.throws(() => c.inc({ a: 'x' }, -1), /only goes up/);
  assert.throws(() => c.inc({}), /exactly the labels a/);
  assert.throws(() => c.inc({ a: 'x', b: 'y' }), MetricsError);
  assert.throws(() => c.inc({ a: 'x'.repeat(1025) }), /at most 1024/);
});

test('writing: a name that collides with another family is refused', () => {
  const r = new Registry();
  r.histogram('lat', 'x');
  assert.throws(() => r.gauge('lat_count', 'x'), /collides/);
    r.counter('reqs_total', 'x');
  assert.throws(() => r.counter('reqs', 'x'), /collides/, 'reqs and reqs_total are one counter family');
  assert.throws(() => r.gauge('reqs_total', 'x'), /collides/);
});

test('reading: errors name the line and the problem', () => {
  const bad = (text: string, line: number, re: RegExp) => assert.throws(() => parseExposition(text), (e: unknown) => e instanceof ParseError && e.line === line && re.test(e.message), `${text} -> expected ${re}`);
  bad('ok 1\nmetric{a=b} 1\n', 2, /double quotes/);
  bad('m{a="x"\n', 1, /not closed|expected/);
  bad('m{a="x\\q"} 1\n', 1, /valid escape/);
  bad('m 1x\n', 1, /not a number/);
  bad('m{a="1",a="2"} 1\n', 1, /twice/);
  bad('m 1\nm 2\n', 2, /appears twice/);
  bad('m 1 2 3\n', 1, /name, labels, a value/);
  bad('# TYPE m counter\nm_total 1\n# TYPE m gauge\n', 3, /comes after its samples or twice/);
  bad('# TYPE m wibble\n', 1, /not a metric type/);
  bad('1abc 3\n', 1, /start with a metric name/);
  bad('m 1 notatime\n', 1, /not a timestamp/);
  bad('m{="x"} 1\n', 1, /label name/);
});

test('reading: tolerant where the format is, such as CRLF, extra spaces, trailing commas and NaN', () => {
  const p = parseExposition('# TYPE m gauge\r\nm{a="1", b="2",}   3   \r\nn NaN\r\nz -Inf\r\n');
  assert.deepEqual(p.families[0]!.samples[0]!.labels, { a: '1', b: '2' });
  assert.equal(p.families[0]!.samples[0]!.value, 3);
  assert.ok(Number.isNaN(p.families[1]!.samples[0]!.value));
  assert.equal(p.families[2]!.samples[0]!.value, -Infinity);
});

test('reading OpenMetrics: needs # EOF, nothing after it, no blank lines; timestamps are seconds; exemplars are ignored', () => {
  assert.throws(() => parseExposition('# TYPE m gauge\nm 1\n', { format: 'openmetrics' }), /must end with "# EOF"/);
  assert.throws(() => parseExposition('m 1\n# EOF\nm 2\n'), /after "# EOF"/);
  assert.throws(() => parseExposition('m 1\n\n# EOF\n'), /blank lines/);
  assert.throws(() => parseExposition('m 1\n# EOF\n', { format: 'prometheus' }), /not detected as OpenMetrics/);
  const p = parseExposition('# TYPE m histogram\nm_bucket{le="1"} 2 1395066363.5 # {trace_id="abc"} 0.5 1395066363.1\nm_bucket{le="+Inf"} 2\nm_count 2\nm_sum 1\n# EOF\n');
  assert.equal(p.families[0]!.samples[0]!.timestampMs, 1395066363500);
  assert.equal(p.families[0]!.samples[0]!.value, 2);
  assert.throws(() => parseExposition('m 1 # {a="b"} 1\n', { format: 'prometheus' }), /only allowed in OpenMetrics/);
});

test('limits: body size, line length, sample count and label count are hard stops', () => {
  assert.throws(() => parseExposition('m 1\n', { maxBytes: 2 }), /larger than 2 bytes/);
  assert.throws(() => parseExposition(`m{a="${'x'.repeat(100)}"} 1\n`, { maxLineLength: 50 }), /longer than 50/);
  assert.throws(() => parseExposition('a 1\nb 1\nc 1\n', { maxSamples: 2 }), (e: unknown) => e instanceof ParseError && e.line === 3 && /more than 2 samples/.test(e.message));
  assert.throws(() => parseExposition('m{a="1",b="2",c="3"} 1\n', { maxLabelsPerSample: 2 }), /more than 2 labels/);
});

test('cardinality on the reading side: fail by default, or drop the excess series and count them; a histogram series is one series', () => {
  const body = ['# TYPE m gauge', ...Array.from({ length: 5 }, (_, i) => `m{id="${i}"} ${i}`)].join('\n') + '\n';
  assert.throws(() => parseExposition(body, { maxSeriesPerFamily: 3 }), (e: unknown) => e instanceof ParseError && e.line === 5 && /more than 3 series/.test(e.message));
  const p = parseExposition(body, { maxSeriesPerFamily: 3, onSeriesLimit: 'drop' });
  assert.equal(p.families[0]!.samples.length, 3);
  assert.deepEqual(p.dropped, { m: 2 });
  const h = '# TYPE h histogram\nh_bucket{le="1"} 1\nh_bucket{le="+Inf"} 1\nh_sum 1\nh_count 1\n';
  assert.equal(parseExposition(h, { maxSeriesPerFamily: 1 }).families[0]!.samples.length, 4);
});

test('histogram checks find buckets that fall, a missing +Inf, and a count that disagrees', () => {
  const f = (body: string) => checkHistogram(parseExposition(`# TYPE h histogram\n${body}`).families[0]!);
  assert.deepEqual(f('h_bucket{le="1"} 1\nh_bucket{le="+Inf"} 3\nh_count 3\nh_sum 4\n'), []);
  assert.match(f('h_bucket{le="1"} 5\nh_bucket{le="2"} 3\nh_bucket{le="+Inf"} 6\n')[0]!, /smaller count/);
  assert.match(f('h_bucket{le="1"} 1\n')[0]!, /no le="\+Inf"/);
  assert.match(f('h_bucket{le="1"} 1\nh_bucket{le="+Inf"} 2\nh_count 9\n')[0]!, /_count differs/);
  assert.match(f('h_bucket{le="x"} 1\nh_bucket{le="+Inf"} 2\n')[0]!, /not a number/);
});

test('quantiles: empty, out of range, first bucket, exact boundaries', () => {
  const b = [{ le: 1, count: 10 }, { le: 2, count: 20 }, { le: Infinity, count: 20 }];
  assert.equal(histogramQuantile(0.5, b), 1);
  assert.equal(histogramQuantile(0.25, b), 0.5, 'half-way into the first bucket, whose lower bound is 0');
  assert.equal(histogramQuantile(0.75, b), 1.5);
  assert.equal(histogramQuantile(1, b), 2);
  assert.ok(Number.isNaN(histogramQuantile(0.5, [{ le: 1, count: 0 }, { le: Infinity, count: 0 }])));
  assert.equal(histogramQuantile(-1, b), -Infinity);
  assert.equal(histogramQuantile(2, b), Infinity);
  assert.ok(Number.isNaN(histogramQuantile(0.5, [{ le: 1, count: 1 }])), 'no +Inf bucket: no answer');
});
