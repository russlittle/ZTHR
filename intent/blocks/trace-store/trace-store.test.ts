import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemble, hashPercent, percentile, serviceGraph, TailSampler, TraceError, TraceStore, validateSpan } from './index.ts';
import type { Span } from './index.ts';

const T1 = 'a'.repeat(32);
const T2 = 'b'.repeat(32);
const tid = (i: number) => i.toString(16).padStart(8, '0') + 'a'.repeat(24);
const id = (n: number) => n.toString(16).padStart(16, '0');
function span(n: number, parent: number | undefined, over: Partial<Span> = {}): Span {
  return { traceId: T1, spanId: id(n), ...(parent !== undefined ? { parentSpanId: id(parent) } : {}), name: `op${n}`, service: 'web', startMs: 1000, durationMs: 100, ...over };
}

// web(1) 0..100 -> api(2) 10..90 -> db(3) 20..60 ; api -> cache(4) 65..85 ; web -> log(5) 5..15
const sample = (): Span[] => [
  span(1, undefined, { startMs: 1000, durationMs: 100, kind: 'server' }),
  span(2, 1, { service: 'api', startMs: 1010, durationMs: 80, kind: 'server' }),
  span(3, 2, { service: 'db', startMs: 1020, durationMs: 40, kind: 'server' }),
  span(4, 2, { service: 'cache', startMs: 1065, durationMs: 20, kind: 'server' }),
  span(5, 1, { service: 'web', startMs: 1005, durationMs: 10 }),
];

test('a trace is assembled into a tree, whatever order its spans arrived in', () => {
  const forward = assemble(T1, sample());
  const backward = assemble(T1, sample().reverse());
  assert.equal(forward.roots.length, 1);
  assert.equal(forward.roots[0]!.span.spanId, id(1));
  assert.deepEqual(forward.roots[0]!.children.map((c) => c.span.spanId), [id(5), id(2)]); // by start time
  assert.deepEqual(forward.roots[0]!.children[1]!.children.map((c) => c.span.spanId), [id(3), id(4)]);
  assert.deepEqual(backward.roots[0]!.children.map((c) => c.span.spanId), [id(5), id(2)]);
  assert.equal(forward.complete, true);
  assert.equal(forward.spanCount, 5);
  assert.deepEqual(forward.services, ['api', 'cache', 'db', 'web']);
  assert.equal(forward.durationMs, 100);
  assert.equal(forward.roots[0]!.children[1]!.children[0]!.depth, 2);
});

test('self time is the span duration minus the union of its children, and overlapping children are counted once', () => {
  const t = assemble(T1, sample());
  const root = t.roots[0]!;
  // web covers 0..100; children cover 5..15 and 10..90, a union of 5..90 = 85, so self time is 15
  assert.equal(root.selfMs, 15);
  const api = root.children[1]!;
  assert.equal(api.selfMs, 80 - 40 - 20); // db 20..60 and cache 65..85 inside api 10..90
  assert.equal(api.children[0]!.selfMs, 40);
  const overlap = assemble(T1, [span(1, undefined, { durationMs: 100 }), span(2, 1, { startMs: 1000, durationMs: 60 }), span(3, 1, { startMs: 1030, durationMs: 60 })]);
  assert.equal(overlap.roots[0]!.selfMs, 100 - 90);
});

test('the critical path follows the child that ends last at each level', () => {
  const t = assemble(T1, sample());
  assert.deepEqual(t.criticalPath.map((s) => s.spanId), [id(1), id(2), id(4)]); // cache ends at 85, after db at 60
});

test('a span whose parent never arrived is an orphan, and the trace is not complete', () => {
  const t = assemble(T1, [span(1, undefined), span(2, 1), span(7, 99)]);
  assert.deepEqual(t.orphans.map((o) => o.span.spanId), [id(7)]);
  assert.equal(t.complete, false);
  assert.equal(t.spanCount, 3);
  const noRoot = assemble(T1, [span(2, 1), span(3, 2)]);
  assert.equal(noRoot.roots.length, 0);
  assert.deepEqual(noRoot.orphans[0]!.children.map((c) => c.span.spanId), [id(3)]);
  assert.deepEqual(noRoot.criticalPath.map((s) => s.spanId), [id(2), id(3)]);
});

test('a cycle in parent links is cut instead of followed forever', () => {
  const t = assemble(T1, [span(1, 2), span(2, 1)]);
  assert.equal(t.spanCount, 2);
  assert.equal(t.roots.length, 0);
  assert.equal(t.orphans.length, 1);
  assert.equal(t.orphans[0]!.children.length, 1);
  assert.equal(t.orphans[0]!.children[0]!.children.length, 0);
});

test('the store keeps the first copy of a repeated span, refuses past the trace cap, and counts errors', () => {
  const store = new TraceStore({ maxSpansPerTrace: 3 });
  assert.equal(store.ingest(span(1, undefined), 1), 'stored');
  assert.equal(store.ingest(span(1, undefined, { name: 'changed' }), 2), 'duplicate');
  assert.equal(store.trace(T1)!.roots[0]!.span.name, 'op1');
  assert.equal(store.ingest(span(2, 1, { status: 'error' }), 3), 'stored');
  assert.equal(store.ingest(span(3, 1), 4), 'stored');
  assert.equal(store.ingest(span(4, 1), 5), 'trace-full');
  assert.equal(store.trace(T1)!.spanCount, 3);
  assert.equal(store.trace(T1)!.errorCount, 1);
  assert.equal(store.trace(T2), undefined);
});

test('bad spans are refused with a plain message', () => {
  const bad = (over: Partial<Span>, re: RegExp) => assert.throws(() => validateSpan({ ...span(1, undefined), ...over }), (e: Error) => e instanceof TraceError && re.test(e.message));
  bad({ traceId: 'XYZ' }, /traceId/);
  bad({ traceId: '0'.repeat(32) }, /not all zero/);
  bad({ traceId: 'A'.repeat(32) }, /lowercase hex/);
  bad({ spanId: '12' }, /spanId/);
  bad({ parentSpanId: id(1) }, /own parent/);
  bad({ name: '' }, /span name/);
  bad({ service: 'x'.repeat(300) }, /service/);
  bad({ startMs: -1 }, /startMs/);
  bad({ durationMs: NaN }, /durationMs/);
  bad({ kind: 'weird' as never }, /kind/);
  bad({ status: 'maybe' as never }, /status/);
  bad({ attributes: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) }, /attributes/);
});

test('search filters by service, name, duration, errors, attribute and window, newest first', () => {
  const store = new TraceStore();
  const put = (trace: string, spans: Partial<Span>[]) => spans.forEach((s, i) => store.ingest({ ...span(i + 1, i === 0 ? undefined : 1), traceId: trace, ...s } as Span, 0));
  put(T1, [{ service: 'web', name: 'GET /', startMs: 1000, durationMs: 50 }, { service: 'api', name: 'query', startMs: 1010, durationMs: 20, attributes: { 'user.id': 7 } }]);
  put(T2, [{ service: 'web', name: 'POST /pay', startMs: 5000, durationMs: 900, status: 'error' }, { service: 'pay', name: 'charge', startMs: 5010, durationMs: 800 }]);
  assert.deepEqual(store.search().map((s) => s.traceId), [T2, T1]);
  assert.deepEqual(store.search({ service: 'pay' }).map((s) => s.traceId), [T2]);
  assert.deepEqual(store.search({ name: 'query' }).map((s) => s.traceId), [T1]);
  assert.deepEqual(store.search({ minDurationMs: 500 }).map((s) => s.traceId), [T2]);
  assert.deepEqual(store.search({ maxDurationMs: 100 }).map((s) => s.traceId), [T1]);
  assert.deepEqual(store.search({ errorsOnly: true }).map((s) => s.traceId), [T2]);
  assert.deepEqual(store.search({ attribute: { key: 'user.id', value: 7 } }).map((s) => s.traceId), [T1]);
  assert.deepEqual(store.search({ fromMs: 2000 }).map((s) => s.traceId), [T2]);
  assert.deepEqual(store.search({ toMs: 2000 }).map((s) => s.traceId), [T1]);
  assert.equal(store.search({ limit: 1 }).length, 1);
  const sum = store.search({ service: 'pay' })[0]!;
  assert.deepEqual({ n: sum.rootName, s: sum.rootService, c: sum.spanCount, e: sum.errorCount, d: sum.durationMs }, { n: 'POST /pay', s: 'web', c: 2, e: 1, d: 900 });
});

test('retention evicts traces not written to for the ttl, and keeps the live ones', () => {
  const store = new TraceStore();
  store.ingest(span(1, undefined), 1000);
  store.ingest({ ...span(1, undefined), traceId: T2 }, 5000);
  assert.deepEqual(store.evict(6000, 5000), [T1]);
  assert.equal(store.has(T1), false);
  assert.equal(store.has(T2), true);
  store.ingest({ ...span(2, undefined), traceId: T2 }, 9000);
  assert.deepEqual(store.evict(11_000, 5000), []);
  assert.equal(store.lastSeen(T2), 9000);
  assert.equal(store.delete(T2), true);
  assert.equal(store.size, 0);
});

test('the store refuses new traces beyond its trace cap', () => {
  const store = new TraceStore({ maxTraces: 1 });
  store.ingest(span(1, undefined), 0);
  assert.throws(() => store.ingest({ ...span(1, undefined), traceId: T2 }, 0), /holds 1 traces/);
  assert.equal(store.ingest(span(2, 1), 0), 'stored'); // the existing trace still takes spans
});

test('the service graph has an edge for each cross-service call, with counts, errors and latency percentiles', () => {
  const spans: Span[] = [];
  for (let i = 0; i < 10; i++) {
    const trace = i.toString(16).padStart(32, '0').replace(/^0{32}$/, T1);
    spans.push({ ...span(1, undefined), traceId: trace, service: 'web' });
    spans.push({ ...span(2, 1), traceId: trace, service: 'api', durationMs: (i + 1) * 10, status: i === 9 ? 'error' : 'ok' });
    spans.push({ ...span(3, 2), traceId: trace, service: 'api', durationMs: 5 }); // same service: no edge
  }
  const g = serviceGraph(spans);
  assert.equal(g.length, 1);
  assert.deepEqual({ ...g[0]! }, { from: 'web', to: 'api', calls: 10, errors: 1, p50Ms: 50, p95Ms: 100, p99Ms: 100, inferred: false });
});

test('a client span naming peer.service with no callee span makes an inferred edge, and a real callee replaces it', () => {
  const lonely = serviceGraph([span(1, undefined, { service: 'web', kind: 'client', attributes: { 'peer.service': 'payments' }, durationMs: 30, status: 'error' })]);
  assert.deepEqual(lonely.map((e) => ({ ...e })), [{ from: 'web', to: 'payments', calls: 1, errors: 1, p50Ms: 30, p95Ms: 30, p99Ms: 30, inferred: true }]);
  const answered = serviceGraph([span(1, undefined, { service: 'web', kind: 'client', attributes: { 'peer.service': 'payments' } }), span(2, 1, { service: 'payments', kind: 'server' })]);
  assert.equal(answered.length, 1);
  assert.equal(answered[0]!.inferred, false);
  assert.equal(answered[0]!.calls, 1);
});

test('the store builds the graph over a time window', () => {
  const store = new TraceStore();
  store.ingest(span(1, undefined, { startMs: 1000 }), 0);
  store.ingest(span(2, 1, { service: 'api', startMs: 1010 }), 0);
  store.ingest({ ...span(1, undefined, { startMs: 9000 }), traceId: T2 }, 0);
  store.ingest({ ...span(2, 1, { service: 'db', startMs: 9010 }), traceId: T2 }, 0);
  assert.deepEqual(store.graph().map((e) => `${e.from}>${e.to}`), ['web>api', 'web>db']);
  assert.deepEqual(store.graph({ fromMs: 5000 }).map((e) => `${e.from}>${e.to}`), ['web>db']);
  assert.deepEqual(store.graph({ toMs: 5000 }).map((e) => `${e.from}>${e.to}`), ['web>api']);
});

test('percentile uses nearest rank', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 99), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([4, 1, 3, 2], 75), 3);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
});

// ------------------------------------------------------------ tail sampling

const trace = (traceId: string, over: Partial<Span>[] = [{}]): Span[] => over.map((o, i) => ({ ...span(i + 1, i === 0 ? undefined : 1), traceId, ...o }));

test('a trace is held until it has been quiet for the decision wait', () => {
  const s = new TailSampler({ policies: [{ type: 'errors' }], decisionWaitMs: 1000 });
  s.add(trace(T1, [{}])[0]!, 0);
  s.add(span(2, 1), 600);
  assert.equal(s.flush(1500).length, 0); // last span at 600, only 900 ms of quiet
  assert.equal(s.pendingCount, 1);
  const d = s.flush(1600);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.spans.length, 2);
  assert.equal(s.pendingCount, 0);
});

test('errors, slow traces, attributes and services are kept with their reason; the rest are dropped', () => {
  const s = new TailSampler({ policies: [{ type: 'errors' }, { type: 'latency', thresholdMs: 500 }, { type: 'attribute', key: 'vip', value: true }, { type: 'service', service: 'pay' }], decisionWaitMs: 10 });
  s.add(...[trace(T1, [{ status: 'error' }])[0]!, 0] as [Span, number]);
  s.add({ ...span(1, undefined), traceId: T2, durationMs: 800 }, 0);
  s.add({ ...span(1, undefined), traceId: 'c'.repeat(32), attributes: { vip: true } }, 0);
  s.add({ ...span(1, undefined), traceId: 'd'.repeat(32), service: 'pay' }, 0);
  s.add({ ...span(1, undefined), traceId: 'e'.repeat(32) }, 0);
  const by = new Map(s.flush(100).map((d) => [d.traceId[0], d]));
  assert.deepEqual(by.get('a')!.reasons, ['errors']);
  assert.deepEqual(by.get('b')!.reasons, ['latency>=500ms']);
  assert.deepEqual(by.get('c')!.reasons, ['attribute:vip']);
  assert.deepEqual(by.get('d')!.reasons, ['service:pay']);
  assert.equal(by.get('e')!.keep, false);
  assert.deepEqual(by.get('e')!.reasons, []);
});

test('probabilistic sampling is a function of the trace id, so two samplers agree, and the share is about right', () => {
  const a = new TailSampler({ policies: [{ type: 'probabilistic', percent: 25 }], decisionWaitMs: 0 });
  const b = new TailSampler({ policies: [{ type: 'probabilistic', percent: 25 }], decisionWaitMs: 0 });
  const ids = Array.from({ length: 2000 }, (_, i) => tid(i));
  for (const t of ids) {
    a.add({ ...span(1, undefined), traceId: t }, 0);
    b.add({ ...span(1, undefined), traceId: t }, 0);
  }
  const ka = a.flush(1).filter((d) => d.keep).map((d) => d.traceId);
  const kb = b.flush(1).filter((d) => d.keep).map((d) => d.traceId);
  assert.deepEqual(ka, kb);
  assert.ok(ka.length > 400 && ka.length < 600, `kept ${ka.length} of 2000`);
  assert.equal(hashPercent(T1) < 25, ka.includes(T1));
  assert.notEqual(hashPercent(T1, 'one'), hashPercent(T1, 'two'));
  assert.equal(hashPercent(T1), hashPercent(T1));
});

test('0 percent keeps nothing and 100 percent keeps everything', () => {
  for (const [percent, expected] of [[0, 0], [100, 50]] as const) {
    const s = new TailSampler({ policies: [{ type: 'probabilistic', percent }], decisionWaitMs: 0 });
    for (let i = 0; i < 50; i++) s.add({ ...span(1, undefined), traceId: tid(i) }, 0);
    assert.equal(s.flush(0).filter((d) => d.keep).length, expected);
  }
});

test('the rate baseline keeps a few per second of what no other policy kept, and does not spend its budget on errors', () => {
  const s = new TailSampler({ policies: [{ type: 'rate', perSecond: 2 }, { type: 'errors' }], decisionWaitMs: 0 });
  for (let i = 0; i < 5; i++) s.add({ ...span(1, undefined), traceId: tid(i), ...(i === 0 ? { status: 'error' as const } : {}) }, 0);
  const d = s.flush(0);
  const kept = d.filter((x) => x.keep);
  assert.equal(kept.length, 3); // the error, plus two from the baseline
  assert.equal(kept.filter((x) => x.reasons.includes('errors')).length, 1);
  assert.equal(kept.filter((x) => x.reasons.includes('rate:2/s')).length, 2);
  s.add({ ...span(1, undefined), traceId: 'f'.repeat(32) }, 1000);
  assert.equal(s.flush(1000).filter((x) => x.keep).length, 1); // a new second, a new budget
});

test('a trace that reaches the span cap is decided at once, and a full pending set decides its oldest', () => {
  const s = new TailSampler({ policies: [{ type: 'errors' }], maxSpansPerTrace: 3, decisionWaitMs: 60_000, maxPending: 2 });
  assert.equal(s.add(span(1, undefined), 0).length, 0);
  assert.equal(s.add(span(2, 1), 1).length, 0);
  const early = s.add(span(3, 1, { status: 'error' }), 2);
  assert.equal(early.length, 1);
  assert.equal(early[0]!.keep, true);
  assert.equal(s.pendingCount, 0);
  s.add({ ...span(1, undefined), traceId: 'a1'.repeat(16) }, 10);
  s.add({ ...span(1, undefined), traceId: 'a2'.repeat(16) }, 11);
  const forced = s.add({ ...span(1, undefined), traceId: 'a3'.repeat(16) }, 12);
  assert.deepEqual(forced.map((d) => d.traceId), ['a1'.repeat(16)]);
  assert.equal(s.drain(20).length, 2);
});

test('a sampler refuses nonsense policies', () => {
  assert.throws(() => new TailSampler({ policies: [] }), /at least one policy/);
  assert.throws(() => new TailSampler({ policies: [{ type: 'probabilistic', percent: 101 }] }), /between 0 and 100/);
  assert.throws(() => new TailSampler({ policies: [{ type: 'rate', perSecond: 0 }] }), /above zero/);
  assert.throws(() => new TailSampler({ policies: [{ type: 'latency', thresholdMs: -1 }] }), /zero or more/);
  assert.throws(() => new TailSampler({ policies: [{ type: 'errors' }] }).add({ ...span(1, undefined), traceId: 'zz' }, 0), /traceId/);
});
