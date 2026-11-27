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
