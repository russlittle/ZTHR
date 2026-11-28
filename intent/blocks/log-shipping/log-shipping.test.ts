import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Batcher, LabelGuard, lokiPush, otlpLogs, otlpSpans, anyValue, severityNumber, ShipError } from './index.ts';
import type { LogEntry } from './index.ts';
import type { SpanRecord } from '../observe/index.ts';

const e = (time: number, message = 'm', extra: Partial<LogEntry> = {}): LogEntry => ({ time, severity: 'INFO', message, ...extra });
const ok = async () => {};

test('a batch is due by count, by bytes and by age, not before', () => {
  const b = new Batcher<number>({ maxBatchItems: 3, maxAgeMs: 1000, maxBatchBytes: 1000 }, () => 10);
  b.add(1, 0);
  assert.equal(b.due(500), false);
  assert.equal(b.due(1000), true);
  const c = new Batcher<number>({ maxBatchItems: 3, maxAgeMs: 99999 }, () => 1);
  c.add(1, 0), c.add(2, 0);
  assert.equal(c.due(1), false);
  c.add(3, 0);
  assert.equal(c.due(1), true);
  const d = new Batcher<number>({ maxBatchBytes: 25, maxAgeMs: 99999 }, () => 10);
  d.add(1, 0), d.add(2, 0);
  assert.equal(d.due(0), false);
  d.add(3, 0);
  assert.equal(d.due(0), true);
});

test('flush sends in order, respects batch size, and counts sent', async () => {
  const b = new Batcher<number>({ maxBatchItems: 2, maxAgeMs: 0 }, () => 1);
  [1, 2, 3, 4, 5].forEach((n) => b.add(n, 0));
  const got: number[][] = [];
  const send = async (x: readonly number[]) => void got.push([...x]);
  while ((await b.flush(send, 0)) === 'sent');
  assert.deepEqual(got, [[1, 2], [3, 4], [5]]);
  assert.equal(b.stats().sent, 5);
  assert.equal(await b.flush(send, 0), 'idle');
});

test('a full queue drops the oldest and counts it, never throwing', () => {
  const b = new Batcher<number>({ maxQueueItems: 3 }, () => 1);
  for (let i = 1; i <= 5; i++) assert.equal(b.add(i, 0), true);
  const s = b.stats();
  assert.equal(s.queued, 3);
  assert.equal(s.dropped['queue-full'], 2);
  assert.equal(s.accepted, 5);
  assert.equal(b.unaccounted(), 0);
});

test('drop policy newest refuses the new entry instead', async () => {
  const b = new Batcher<number>({ maxQueueItems: 2, dropPolicy: 'newest', maxAgeMs: 0 }, () => 1);
  assert.deepEqual([1, 2, 3, 4].map((n) => b.add(n, 0)), [true, true, false, false]);
  const got: number[] = [];
  await b.drain(async (x) => void got.push(...x), 0);
  assert.deepEqual(got, [1, 2]);
  assert.equal(b.unaccounted(), 0);
});

test('queue bytes bound and oversize entries are dropped as too-large', () => {
  const b = new Batcher<string>({ maxQueueBytes: 100, maxItemBytes: 60 }, (s) => s.length);
  assert.equal(b.add('x'.repeat(61), 0), false);
  b.add('a'.repeat(50), 0);
  b.add('b'.repeat(50), 0);
  b.add('c'.repeat(50), 0);
  const s = b.stats();
  assert.equal(s.dropped['too-large'], 1);
  assert.equal(s.queued, 2);
  assert.equal(s.queuedBytes, 100);
  assert.equal(s.dropped['queue-full'], 1);
});

test('a sizer that throws or lies is counted as invalid', () => {
  const b = new Batcher<number>({}, (n) => { if (n === 1) throw new Error('x'); return n === 2 ? Number.NaN : 1; });
  assert.deepEqual([1, 2, 3].map((n) => b.add(n, 0)), [false, false, true]);
  assert.equal(b.stats().dropped.invalid, 2);
});

test('a failed send is retried with backoff, in order, then succeeds', async () => {
  const b = new Batcher<number>({ maxAgeMs: 0, maxAttempts: 3, backoffMs: (n) => 100 * n }, () => 1);
  b.add(1, 0), b.add(2, 0);
  let fail = 2;
  const got: number[][] = [];
  const send = async (x: readonly number[]) => {
    if (fail-- > 0) throw new Error('503');
    got.push([...x]);
  };
  assert.equal(await b.flush(send, 0), 'retry');
  assert.equal(await b.flush(send, 50), 'idle');
  assert.equal(await b.flush(send, 100), 'retry');
  assert.equal(await b.flush(send, 250), 'idle');
  assert.equal(await b.flush(send, 300), 'sent');
  assert.deepEqual(got, [[1, 2]]);
  assert.equal(b.stats().retries, 2);
  assert.equal(b.unaccounted(), 0);
});

test('a batch that keeps failing is dropped after the attempts and counted', async () => {
  const b = new Batcher<number>({ maxAgeMs: 0, maxAttempts: 2, backoffMs: () => 0 }, () => 1);
  [1, 2, 3].forEach((n) => b.add(n, 0));
  const send = async () => { throw new Error('down'); };
  assert.equal(await b.flush(send, 0), 'retry');
  assert.equal(await b.flush(send, 0), 'dropped');
  const s = b.stats();
  assert.equal(s.dropped['send-failed'], 3);
  assert.equal(s.queued, 0);
  assert.equal(b.unaccounted(), 0);
});

test('drain sends everything even while backoff is pending', async () => {
  const b = new Batcher<number>({ maxBatchItems: 2, maxAttempts: 4, backoffMs: () => 10_000 }, () => 1);
  [1, 2, 3].forEach((n) => b.add(n, 0));
  let first = true;
  const got: number[] = [];
  await b.drain(async (x) => { if (first) { first = false; throw new Error('once'); } got.push(...x); }, 0);
  assert.deepEqual(got, [1, 2, 3]);
});

test('lossRecord reports new drops once, as a log entry', () => {
  const b = new Batcher<number>({ maxQueueItems: 1 }, () => 1);
  assert.equal(b.lossRecord(5), undefined);
  b.add(1, 0), b.add(2, 0), b.add(3, 0);
  const r = b.lossRecord(10, { app: 'web' })!;
  assert.match(r.message, /dropped 2 entries: queue-full=2/);
  assert.deepEqual(r.labels, { app: 'web', kind: 'log-loss' });
  assert.equal(b.lossRecord(11), undefined);
  b.add(4, 0);
  assert.match(b.lossRecord(12)!.message, /dropped 1 entry/);
});

test('label rules: allow list, names, length, count, control characters', () => {
  assert.throws(() => new LabelGuard({ allow: ['bad-name'] }), ShipError);
  assert.throws(() => new LabelGuard({ allow: ['__reserved'] }), ShipError);
  const g = new LabelGuard({ allow: ['app', 'env', 'host'], maxValueLength: 5 });
  const r = g.split({ app: 'web', env: '', host: 'toolong', request_id: 'abc', x: 'y' });
  assert.deepEqual(r.labels, { app: 'web' });
  assert.deepEqual(r.refused.map((x) => `${x.key}:${x.why}`).sort(), ['env:empty value', 'host:value too long', 'request_id:not an allowed label', 'x:not an allowed label']);
  assert.equal(g.split({ app: 'a\nb' }).refused[0]!.why, 'control characters');
});

test('label cardinality guard stops a high-cardinality value becoming a label', () => {
  const g = new LabelGuard({ allow: ['user'], maxDistinct: 3 });
  const kept = ['a', 'b', 'c', 'd', 'e', 'a'].map((u) => Object.keys(g.split({ user: u }).labels).length);
  assert.deepEqual(kept, [1, 1, 1, 0, 0, 1]);
  assert.equal(g.distinct('user'), 3);
});

test('lokiPush groups by label set, orders by time, uses ns strings and metadata', () => {
  const g = new LabelGuard({ allow: ['app', 'level'] });
  const body = lokiPush(
    [e(2000, 'second', { labels: { app: 'web' }, trace: 'a'.repeat(32) }), e(1000, 'first', { labels: { app: 'web' } }), e(1500, 'other', { labels: { app: 'worker' }, nanos: 7 }), e(1000, 'with fields', { labels: { app: 'web' }, fields: { n: 1 } })],
    g,
    { staticLabels: { env: 'prod' } },
  );
  assert.equal(body.streams.length, 2);
  const web = body.streams.find((s) => s.stream.app === 'web')!;
  assert.deepEqual(web.stream, { app: 'web', level: 'info' });
  assert.deepEqual(web.values.map((v) => v[0]), ['1000000000', '1000000000', '2000000000']);
  assert.deepEqual(web.values[2], ['2000000000', 'second', { env: 'prod', trace_id: 'a'.repeat(32) }]);
  const w = body.streams.find((s) => s.stream.app === 'worker')!;
  assert.equal(w.values[0]![0], '1500000007');
  assert.ok(web.values.some((v) => v[1] === 'with fields {"n":1}'));
});

test('loki lines are redacted and invalid times refused', () => {
  const g = new LabelGuard({ allow: ['app'] });
  const b = lokiPush([e(1, 'auth Bearer abcdefghijklmnop', { labels: { app: 'a' }, fields: { password: 'hunter2' } })], g);
  const line = b.streams[0]!.values[0]![1];
  assert.ok(!line.includes('abcdefghijklmnop') && !line.includes('hunter2'));
  assert.throws(() => lokiPush([e(Number.NaN)], g), ShipError);
  assert.throws(() => lokiPush([e(1, 'x', { nanos: 2_000_000 })], g), ShipError);
});

test('otlpLogs has the OTLP JSON shape with string nanos, typed attributes and severity numbers', () => {
  const trace = 'ab'.repeat(16);
  const body = otlpLogs([e(1700000000123, 'hello', { severity: 'ERROR', labels: { app: 'web' }, fields: { n: 3, ok: true, ratio: 0.5, token: 'secret-value-here' }, trace, span: 'cd'.repeat(8) })], { attributes: { 'service.name': 'api' } });
  const r = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  assert.equal(r.timeUnixNano, '1700000000123000000');
  assert.equal(r.severityNumber, 17);
  assert.equal(r.severityText, 'ERROR');
  assert.deepEqual(r.body, { stringValue: 'hello' });
  assert.equal(r.traceId, trace);
  assert.equal(r.spanId, 'cd'.repeat(8));
  const a = Object.fromEntries(r.attributes.map((x) => [x.key, x.value]));
  assert.deepEqual(a.n, { intValue: '3' });
  assert.deepEqual(a.ok, { boolValue: true });
  assert.deepEqual(a.ratio, { doubleValue: 0.5 });
  assert.deepEqual(a.token, { stringValue: '[redacted]' });
  assert.deepEqual(body.resourceLogs[0]!.resource.attributes, [{ key: 'service.name', value: { stringValue: 'api' } }]);
});

test('otlp omits malformed trace ids rather than sending them', () => {
  const r = otlpLogs([e(1, 'x', { trace: 'short', span: 'cd'.repeat(8) }), e(1, 'y', { trace: '0'.repeat(32) })], { attributes: {} }).resourceLogs[0]!.scopeLogs[0]!.logRecords;
  assert.ok(r.every((x) => !('traceId' in x) && !('spanId' in x)));
});

test('otlpSpans maps observe spans to epoch nanos, parent ids and status', () => {
  const t = '1f'.repeat(16);
  const spans: SpanRecord[] = [
    { trace: t, span: 'aa'.repeat(8), name: 'root', start: 10, end: 35.5, status: 'ok', attrs: { route: '/x', password: 'p' } },
    { trace: t, span: 'bb'.repeat(8), parent: 'aa'.repeat(8), name: 'db', start: 12, end: 20, status: 'error', attrs: {} },
    { trace: t, span: 'cc'.repeat(8), name: 'unfinished', start: 1, attrs: {} },
    { trace: 'bad', span: 'dd'.repeat(8), name: 'bad', start: 1, end: 2, attrs: {} },
  ];
  const out = otlpSpans(spans, { attributes: { 'service.name': 'api' } }, 1_700_000_000_000).resourceSpans[0]!.scopeSpans[0]!.spans;
  assert.equal(out.length, 2);
  assert.equal(out[0]!.startTimeUnixNano, '1700000000010000000');
  assert.equal(out[0]!.endTimeUnixNano, '1700000000035500000');
  assert.equal(out[1]!.parentSpanId, 'aa'.repeat(8));
  assert.deepEqual(out[1]!.status, { code: 2 });
  assert.ok(out[0]!.attributes.some((a) => a.key === 'password' && 'stringValue' in a.value && a.value.stringValue === '[redacted]'));
});

test('anyValue handles nesting, big integers and non-finite numbers', () => {
  assert.deepEqual(anyValue([1, 'a']), { arrayValue: { values: [{ intValue: '1' }, { stringValue: 'a' }] } });
  assert.deepEqual(anyValue({ a: { b: 1 } }), { kvlistValue: { values: [{ key: 'a', value: { kvlistValue: { values: [{ key: 'b', value: { intValue: '1' } }] } } }] } });
  assert.deepEqual(anyValue(2n ** 62n), { intValue: '4611686018427387904' });
  assert.deepEqual(anyValue(Number.NaN), { doubleValue: 0 });
  assert.equal(severityNumber('DEBUG'), 5);
  assert.equal(severityNumber('CRITICAL'), 21);
});
