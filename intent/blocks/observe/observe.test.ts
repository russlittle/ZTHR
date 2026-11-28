import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Errors, Logger, Metrics, keepDays, redact, span, traceparent, withTrace } from './index.ts';

test('sensitive keys and secret-shaped values never reach a log line', () => {
  const lines: string[] = [];
  const log = new Logger({ write: (l) => lines.push(l), build: 'abc123', extraSensitive: ['diagnosis'] });
  log.info('charged card 4242 4242 4242 4242 for ana', { password: 'hunter2', user: { name: 'Ana', token: 'x', diagnosis: 'flu' }, header: 'Bearer eyJhbGciOi.eyJzdWIiOjF9.c2ln', note: 'ssn 123-45-6789' });
  const l = JSON.parse(lines[0]!);
  assert.equal(l.password, '[redacted]');
  assert.equal(l.user.token, '[redacted]');
  assert.equal(l.user.diagnosis, '[redacted]');
  assert.equal(l.user.name, 'Ana');
  assert.match(l.message, /\[card\]/);
  assert.equal(l.header, 'Bearer [redacted]');
  assert.equal(l.note, 'ssn [ssn]');
  assert.equal(l.build, 'abc123');
  assert.equal(JSON.stringify(redact({ a: [{ secret: 1 }] })), '{"a":[{"secret":"[redacted]"}]}');
});

test('a trace follows a request through every step, and every line written inside carries it', async () => {
  const lines: string[] = [];
  const log = new Logger({ write: (l) => lines.push(l), project: 'p' });
  const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const { spans } = await withTrace({ traceparent: incoming, feature: 'upload', name: 'PUT /file' }, async () => {
    await span('store', async () => {
      log.info('stored');
      assert.match(traceparent()!, /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    });
    await span('index', async () => undefined, { rows: 3 });
  });
  assert.equal(spans.length, 3);
  assert.ok(spans.every((s) => s.trace === '4bf92f3577b34da6a3ce929d0e0e4736' && s.end !== undefined));
  assert.equal(spans[1]!.parent, spans[0]!.span);
  const l = JSON.parse(lines[0]!);
  assert.equal(l['logging.googleapis.com/trace'], 'projects/p/traces/4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(l['logging.googleapis.com/spanId'], spans[1]!.span);
  assert.equal(l.feature, 'upload');
});

test('errors group by kind and place, with ids stripped, linked to builds, features and traces', async () => {
  const seen: string[] = [];
  const errs = new Errors({ onNew: (g) => seen.push(g.fingerprint) });
  const boom = (id: number) => {
    throw new Error(`order ${id} not found`);
  };
  for (const id of [1, 22, 333])
    await withTrace({ name: 'x', feature: 'orders' }, async () => {
      try {
        boom(id);
      } catch (e) {
        errs.capture(e, { build: 'b1' });
      }
    });
  assert.equal(errs.groups.size, 1, 'three occurrences, one group');
  const g = [...errs.groups.values()][0]!;
  assert.equal(g.count, 3);
  assert.equal(g.message, 'order # not found');
  assert.deepEqual([...g.features], ['orders']);
  assert.equal(g.traces.length, 3);
  assert.equal(seen.length, 1, 'alerted once, on the first');
  errs.capture(new TypeError('different'));
  assert.equal(errs.groups.size, 2);
});

test('metrics: counters, latency percentiles and the Prometheus text format', () => {
  const m = new Metrics();
  m.count('requests', { route: 'dav' });
  m.count('requests', { route: 'dav' });
  for (let i = 1; i <= 100; i++) m.observe('latency_ms', i, { route: 'dav' });
  assert.equal(m.value('requests', { route: 'dav' }), 2);
  assert.equal(m.percentile('latency_ms', 95, { route: 'dav' }), 95);
  const t = m.text();
  assert.match(t, /requests\{route="dav"\} 2/);
  assert.match(t, /latency_ms_bucket\{route="dav",le="50"\} 50/);
  assert.match(t, /latency_ms_count\{route="dav"\} 100/);
  assert.equal(keepDays({ severity: 'INFO', kind: 'audit' }, [{ match: { kind: 'audit' }, days: 400 }, { match: { severity: 'INFO' }, days: 30 }]), 400);
});

test('Prometheus text: label values are escaped, each family is typed and grouped, histograms carry _sum and ordered buckets', () => {
  const m = new Metrics();
  m.count('requests', { route: 'a"b\\c\nd' });
  m.count('requests', { route: 'x', code: '200' });
  m.observe('latency_ms', 7, { route: 'x' });
  m.observe('latency_ms', 20_000, { route: 'x' });
  const t = m.text();
  assert.ok(t.includes('requests{route="a\\"b\\\\c\\nd"} 1'), t);
  assert.equal(t.split('\n').filter((l) => l.startsWith('requests')).length, 2, 'a value cannot start a line of its own');
  assert.match(t, /# TYPE requests counter\n/);
  assert.match(t, /# TYPE latency_ms histogram\n/);
  assert.match(t, /latency_ms_sum\{route="x"\} 20007\n/);
  const les = [...t.matchAll(/latency_ms_bucket\{route="x",le="([^"]+)"\}/g)].map((x) => x[1]);
  assert.deepEqual(les, ['5', '10', '25', '50', '100', '250', '500', '1000', '2500', '5000', '10000', '+Inf'], 'buckets in increasing order, +Inf last');
  assert.notEqual(m.value('requests', { route: 'x",code="200' }), 1, 'a crafted value is not another series');
  assert.throws(() => m.count('bad name', {}), /metric name/);
  assert.throws(() => m.count('ok', { 'bad-label': 'x' }), /label name/);
});

test('the 0th percentile is the smallest observation', () => {
  const m = new Metrics();
  for (const v of [3, 1, 2]) m.observe('x', v);
  assert.equal(m.percentile('x', 0), 1);
  assert.equal(m.percentile('x', 100), 3);
});

test('fields cannot overwrite a line’s severity, message or time', () => {
  const lines: string[] = [];
  new Logger({ write: (l) => lines.push(l) }).error('disk full', { severity: 'DEBUG', message: 'all fine', time: 'never' });
  const l = JSON.parse(lines[0]!);
  assert.equal(l.severity, 'ERROR');
  assert.equal(l.message, 'disk full');
  assert.notEqual(l.time, 'never');
});

test('secret-bearing keys are redacted in their common spellings', () => {
  const r = redact({ client_secret: 'a', 'x-api-key': 'b', 'api-key': 'c', 'proxy-authorization': 'd', id_token: 'e', newPassword: 'f', aws_secret_access_key: 'g', privateKey: 'h', user: 'ana' }) as Record<string, unknown>;
  for (const k of ['client_secret', 'x-api-key', 'api-key', 'proxy-authorization', 'id_token', 'newPassword', 'aws_secret_access_key', 'privateKey']) assert.equal(r[k], '[redacted]', k);
  assert.equal(r['user'], 'ana');
});

test('an all-zero trace or parent id in traceparent is invalid (W3C Trace Context) and starts a new trace', async () => {
  const zeroTrace = '00-00000000000000000000000000000000-00f067aa0ba902b7-01';
  const zeroParent = '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01';
  for (const tp of [zeroTrace, zeroParent]) {
    const { spans } = await withTrace({ traceparent: tp, name: 'x' }, async () => undefined);
    assert.notEqual(spans[0]!.trace, '00000000000000000000000000000000');
    assert.equal(spans[0]!.parent, undefined);
  }
});

test('error groups are capped: the least recently seen is evicted, and evictions are counted', () => {
  const errs = new Errors({ maxGroups: 3 });
  const fail = (name: string) => errs.capture(new Error(`no user named ${name}`));
  for (const k of ['alpha', 'bravo', 'charlie', 'alpha', 'delta']) fail(k);
  assert.equal(errs.groups.size, 3);
  assert.deepEqual([...errs.groups.values()].map((g) => g.message), ['no user named charlie', 'no user named alpha', 'no user named delta'], 'bravo, seen least recently, went');
  assert.equal(errs.evicted, 1);
  assert.equal([...errs.groups.values()][1]!.count, 2, 'a group kept keeps its count');
  const many = new Errors();
  // Base 20 written in letters that are not hex digits, so the message stripping leaves every one distinct.
  const word = (i: number) => [...i.toString(20)].map((c) => 'ghijklmnopqrstuvwxyz'[parseInt(c, 20)]!).join('');
  for (let i = 0; i < 1500; i++) many.capture(new Error(`no user named ${word(i)}`));
  assert.equal(many.groups.size, 1000, 'the default cap holds');
  assert.equal(many.evicted, 500);
});
