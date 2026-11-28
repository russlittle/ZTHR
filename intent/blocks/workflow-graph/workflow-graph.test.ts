import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../jobs/index.ts';
import { GraphEngine, RUN_LIFECYCLE, NonRetryable, RetryAfter, evalCondition, attachToQueue, enqueueRun, memoryStore, type Graph, type Item, type RunState, type NodeHandler } from './index.ts';
import { check } from '../workflow/index.ts';

const mk = () => {
  let t = 1_000_000;
  const e = new GraphEngine({ now: () => t });
  return { e, adv: (ms: number) => { t += ms; }, now: () => t };
};
const it = (...xs: Record<string, unknown>[]): Item[] => xs.map((json) => ({ json }));
const roundtrip = (s: RunState): RunState => JSON.parse(JSON.stringify(s)) as RunState;
const vals = (items: Item[] | undefined, k: string) => (items ?? []).map((x) => x.json[k]);

const double: NodeHandler = { mode: 'each', run: (i) => ({ json: { ...(i as Item).json, n: Number((i as Item).json.n) * 2 } }) };

test('validation finds mistakes before a run does', () => {
  const { e } = mk();
  const bad: Graph = {
    nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'nope' }, { id: 'c', type: 'if', params: { condition: { field: 'x', op: 'exists' } } }, { id: 'm', type: 'merge' }, { id: 'orphan', type: 'noop' }, { id: 'a', type: 'noop' }, { id: 'w', type: 'wait' }],
    edges: [{ from: 'a', to: 'c' }, { from: 'c', to: 'm', port: 'maybe' }, { from: 'c', to: 'zz' }, { from: 'c', to: 'm', port: 'true' }],
  };
  const v = e.validate(bad);
  for (const re of [/defined twice/, /unknown type nope/, /needs ms or event/, /no port maybe/, /unknown node zz/]) assert.ok(v.errors.some((x) => re.test(x)), String(re));
  const ok = e.validate({ start: 'a', nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'noop' }, { id: 'c', type: 'noop' }, { id: 'd', type: 'noop' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }, { from: 'c', to: 'd' }] });
  assert.ok(ok.errors.some((x) => /cycle that does not go through a loop/.test(x)));
  assert.throws(() => e.start({ nodes: [{ id: 'a', type: 'zzz' }], edges: [] }), /not valid/);
});

test('validation: merge inputs, unreachable nodes, unconnected error and loop ports, implicit merges', () => {
  const { e } = mk();
  const v = e.validate({
    nodes: [{ id: 's', type: 'start' }, { id: 'm', type: 'merge' }, { id: 'f', type: 'noop', onError: 'route' }, { id: 'l', type: 'loop' }, { id: 'x', type: 'noop' }, { id: 'y', type: 'noop' }, { id: 'z', type: 'noop' }],
    edges: [{ from: 's', to: 'm' }, { from: 'm', to: 'f' }, { from: 'f', to: 'l' }, { from: 's', to: 'x' }, { from: 's', to: 'y' }, { from: 'x', to: 'z' }, { from: 'y', to: 'z' }],
  });
  assert.ok(v.errors.some((x) => /merge node m needs at least two/.test(x)));
  assert.ok(v.errors.some((x) => /loop node l has nothing connected to its loop port/.test(x)));
  assert.ok(v.warnings.some((x) => /routes errors but nothing is connected/.test(x)));
  assert.ok(v.warnings.some((x) => /node z has 2 incoming edges/.test(x)));
  assert.ok(e.validate({ nodes: [{ id: 's', type: 'start' }, { id: 'a', type: 'noop' }, { id: 'lost', type: 'noop' }], edges: [{ from: 's', to: 'a' }], start: 's' }).errors.some((x) => /node lost cannot be reached/.test(x)));
});

test('a linear run handles each item and records where it came from', async () => {
  const { e } = mk();
  e.register('double', double);
  const s = await e.advance(e.start({ nodes: [{ id: 'a', type: 'start' }, { id: 'd', type: 'double' }, { id: 'set', type: 'set', params: { values: { done: true } } }], edges: [{ from: 'a', to: 'd' }, { from: 'd', to: 'set' }] }, [{ n: 1 }, { n: 2 }, { n: 3 }]));
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(vals(s.final.set, 'n'), [2, 4, 6]);
  assert.deepEqual(vals(s.final.set, 'done'), [true, true, true]);
  assert.deepEqual(s.final.set!.map((x) => x.source), [{ node: 'set', item: 0 }, { node: 'set', item: 1 }, { node: 'set', item: 2 }]);
  assert.equal(s.steps, 3);
});

test('if branches items, the branch not taken is skipped, and merge waits for both', async () => {
  const { e } = mk();
  const g: Graph = {
    nodes: [{ id: 's', type: 'start' }, { id: 'if', type: 'if', params: { condition: { field: 'n', op: 'gt', value: 1 } } }, { id: 'big', type: 'set', params: { values: { size: 'big' } } }, { id: 'small', type: 'set', params: { values: { size: 'small' } } }, { id: 'm', type: 'merge' }, { id: 'tail', type: 'noop' }],
    edges: [{ from: 's', to: 'if' }, { from: 'if', to: 'big', port: 'true' }, { from: 'if', to: 'small', port: 'false' }, { from: 'big', to: 'm' }, { from: 'small', to: 'm' }, { from: 'm', to: 'tail' }],
  };
  const s = await e.advance(e.start(g, [{ n: 1 }, { n: 5 }, { n: 0 }]));
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(vals(s.final.tail, 'size').sort(), ['big', 'small', 'small']);
  // Only one side has data: the other is skipped, and the merge still runs.
  const only = await e.advance(e.start(g, [{ n: 9 }]));
  assert.deepEqual(vals(only.final.tail, 'size'), ['big']);
  assert.ok(only.history.some((h) => h.node === 'small' && h.what === 'skipped'));
});

test('a branch with nothing on it ends quietly and the run still succeeds', async () => {
  const { e } = mk();
  const s = await e.advance(e.start({ nodes: [{ id: 's', type: 'start' }, { id: 'f', type: 'filter', params: { condition: { field: 'n', op: 'gt', value: 100 } } }, { id: 'after', type: 'noop' }], edges: [{ from: 's', to: 'f' }, { from: 'f', to: 'after' }] }, [{ n: 1 }]));
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(s.final, {});
});

test('switch routes to named cases and default', async () => {
  const { e } = mk();
  const s = await e.advance(e.start({
    nodes: [{ id: 's', type: 'start' }, { id: 'sw', type: 'switch', params: { cases: { a: { field: 'k', op: 'eq', value: 'a' }, b: { field: 'k', op: 'in', value: ['b', 'bb'] } } } }, { id: 'A', type: 'noop' }, { id: 'B', type: 'noop' }, { id: 'D', type: 'noop' }],
    edges: [{ from: 's', to: 'sw' }, { from: 'sw', to: 'A', port: 'a' }, { from: 'sw', to: 'B', port: 'b' }, { from: 'sw', to: 'D', port: 'default' }],
  }, [{ k: 'a' }, { k: 'bb' }, { k: 'zzz' }, { k: 'a' }]));
  assert.deepEqual([vals(s.final.A, 'k'), vals(s.final.B, 'k'), vals(s.final.D, 'k')], [['a', 'a'], ['bb'], ['zzz']]);
});

test('merge modes: zip, first, by key', async () => {
  const { e } = mk();
  const run = async (params: Record<string, unknown>) => {
    const s = await e.advance(e.start({
      nodes: [{ id: 's', type: 'start' }, { id: 'a', type: 'set', params: { values: { from: 'a' } } }, { id: 'b', type: 'set', params: { values: { extra: 1 }, keepOthers: false } }, { id: 'm', type: 'merge', params }],
      edges: [{ from: 's', to: 'a' }, { from: 's', to: 'b' }, { from: 'a', to: 'm' }, { from: 'b', to: 'm' }],
    }, [{ id: 1 }, { id: 2 }]));
    return s.final.m!.map((x) => x.json);
  };
  assert.deepEqual(await run({ mode: 'zip' }), [{ id: 1, from: 'a', extra: 1 }, { id: 2, from: 'a', extra: 1 }]);
  assert.equal((await run({ mode: 'append' })).length, 4);
  assert.deepEqual(await run({ mode: 'first' }), [{ id: 1, from: 'a' }, { id: 2, from: 'a' }]);
  // Items without the key are passed through, not glued together.
  assert.deepEqual(await run({ mode: 'key', key: 'id' }), [{ id: 1, from: 'a' }, { id: 2, from: 'a' }, { extra: 1 }, { extra: 1 }]);
});

test('a loop runs the body once per batch and collects the results on done', async () => {
  const { e } = mk();
  e.register('double', double);
  const g: Graph = {
    nodes: [{ id: 's', type: 'start' }, { id: 'loop', type: 'loop', params: { batchSize: 2 } }, { id: 'd', type: 'double' }, { id: 'out', type: 'set', params: { values: { fin: 1 } } }],
    edges: [{ from: 's', to: 'loop' }, { from: 'loop', to: 'd', port: 'loop' }, { from: 'd', to: 'loop' }, { from: 'loop', to: 'out', port: 'done' }],
  };
  assert.deepEqual(e.validate(g).errors, []);
  const s = await e.advance(e.start(g, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]));
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(vals(s.final.out, 'n'), [2, 4, 6, 8, 10]);
  assert.equal(s.history.filter((h) => h.node === 'd' && h.what === 'ok').length, 3);
  // Nothing to loop over goes straight to done, which is empty.
  const empty = await e.advance(e.start(g, []));
  assert.equal(empty.status, 'succeeded');
  assert.deepEqual(empty.final, {});
});

test('a loop whose body drops items still finishes, and a runaway loop stops at its limit', async () => {
  const { e } = mk();
  const g = (maxRounds: number): Graph => ({
    nodes: [{ id: 's', type: 'start' }, { id: 'loop', type: 'loop', params: { batchSize: 1, maxRounds } }, { id: 'f', type: 'filter', params: { condition: { field: 'n', op: 'gt', value: 2 } } }, { id: 'out', type: 'noop' }],
    edges: [{ from: 's', to: 'loop' }, { from: 'loop', to: 'f', port: 'loop' }, { from: 'f', to: 'loop' }, { from: 'loop', to: 'out', port: 'done' }],
  });
  const s = await e.advance(e.start(g(100), [{ n: 1 }, { n: 3 }, { n: 2 }, { n: 4 }]));
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(vals(s.final.out, 'n'), [3, 4]);
  const r = await e.advance(e.start(g(2), [{ n: 1 }, { n: 3 }, { n: 2 }, { n: 4 }]));
  assert.equal(r.status, 'failed');
  assert.match(r.error!.message, /more than 2 rounds/);
});

test('retries per item with backoff; the run waits, survives a save and load, and does not redo finished items', async () => {
  const m = mk();
  const calls: string[] = [];
  let flaky = 2;
  m.e.register('api', { mode: 'each', run: (i) => {
    const id = String((i as Item).json.id);
    calls.push(id);
    if (id === '2' && flaky-- > 0) throw new Error('503');
    return { json: { ...(i as Item).json, ok: true } };
  } });
  const g: Graph = { nodes: [{ id: 's', type: 'start' }, { id: 'api', type: 'api', retry: { max: 3, delayMs: 1000, factor: 2 } }, { id: 'out', type: 'noop' }], edges: [{ from: 's', to: 'api' }, { from: 'api', to: 'out' }] };
  let s = await m.e.advance(m.e.start(g, [{ id: 1 }, { id: 2 }, { id: 3 }]));
  assert.equal(s.status, 'waiting');
  assert.equal(s.wakeAt, m.now() + 1000);
  assert.deepEqual(calls, ['1', '2']);
  s = roundtrip(s);
  m.adv(500);
  s = await m.e.advance(s);
  assert.equal(s.status, 'waiting');
  assert.equal(calls.length, 2);
  m.adv(600);
  s = await m.e.advance(s);
  assert.equal(s.status, 'waiting');
  assert.equal(s.wakeAt, m.now() + 2000);
  m.adv(2000);
  s = await m.e.advance(roundtrip(s));
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(calls, ['1', '2', '2', '2', '3']);
  assert.deepEqual(vals(s.final.out, 'id'), [1, 2, 3]);
  assert.equal(s.history.filter((h) => h.what === 'retry').length, 2);
});

test('retries run out, NonRetryable skips them, RetryAfter sets the delay', async () => {
  const m = mk();
  m.e.register('boom', { mode: 'all', run: () => { throw new Error('always'); } });
  m.e.register('hard', { mode: 'all', run: () => { throw new NonRetryable('bad input'); } });
  let first = true;
  m.e.register('slow', { mode: 'all', run: (i) => { if (first) { first = false; throw new RetryAfter(90_000, 'rate limited'); } return i as Item[]; } });
  const one = (type: string, retry = { max: 1, delayMs: 10 }): Graph => ({ nodes: [{ id: 's', type: 'start' }, { id: 'x', type: m.e.validate({ nodes: [], edges: [] }) && type, retry }], edges: [{ from: 's', to: 'x' }] });
  let s = await m.e.advance(m.e.start(one('boom')));
  m.adv(20);
  s = await m.e.advance(s);
  assert.equal(s.status, 'failed');
  assert.deepEqual(s.error, { node: 'x', message: 'always' });
  const h = await m.e.advance(m.e.start(one('hard', { max: 5, delayMs: 10 })));
  assert.equal(h.status, 'failed');
  assert.equal(h.history.filter((x) => x.what === 'retry').length, 0);
  const r = await m.e.advance(m.e.start(one('slow', { max: 2, delayMs: 10 })));
  assert.equal(r.wakeAt, m.now() + 90_000);
});

test('error handling per node: stop, continue with the error on the item, route to an error edge', async () => {
  const { e } = mk();
  e.register('picky', { mode: 'each', run: (i) => { if ((i as Item).json.bad) throw new Error('bad item'); return { json: { ...(i as Item).json, ok: true } }; } });
  const g = (onError?: 'stop' | 'continue' | 'route'): Graph => ({
    start: 's',
    nodes: [{ id: 's', type: 'start' }, { id: 'p', type: 'picky', ...(onError ? { onError } : {}) }, { id: 'good', type: 'noop' }, ...(onError === 'route' ? [{ id: 'oops', type: 'noop' }] : [])],
    edges: [{ from: 's', to: 'p' }, { from: 'p', to: 'good' }, ...(onError === 'route' ? [{ from: 'p', to: 'oops', port: 'error' }] : [])],
  });
  const input = [{ n: 1 }, { n: 2, bad: true }, { n: 3 }];
  const stop = await e.advance(e.start(g(), input));
  assert.equal(stop.status, 'failed');
  assert.equal(stop.error!.message, 'bad item');
  const cont = await e.advance(e.start(g('continue'), input));
  assert.equal(cont.status, 'succeeded');
  assert.deepEqual(cont.final.good!.map((x) => [x.json.n, x.error?.message]), [[1, undefined], [2, 'bad item'], [3, undefined]]);
  const route = await e.advance(e.start(g('route'), input));
  assert.equal(route.status, 'succeeded');
  assert.deepEqual(vals(route.final.good, 'n'), [1, 3]);
  assert.deepEqual(route.final.oops!.map((x) => [x.json.n, x.error!.node]), [[2, 'p']]);
});

test('a failure branch runs with the error, and the run is still failed', async () => {
  const { e } = mk();
  e.register('boom', { mode: 'all', run: () => { throw new Error('kaput'); } });
  const s = await e.advance(e.start({ nodes: [{ id: 's', type: 'start' }, { id: 'b', type: 'boom' }, { id: 'alert', type: 'set', params: { values: { alerted: true } } }], edges: [{ from: 's', to: 'b' }], onFailure: 'alert' }, [{ x: 1 }], 'r-9'));
  assert.equal(s.status, 'failed');
  assert.equal(s.final.alert![0]!.json.error, 'kaput');
  assert.equal(s.final.alert![0]!.json.node, 'b');
  assert.equal(s.final.alert![0]!.json.run, 'r-9');
  assert.equal(s.final.alert![0]!.json.alerted, true);
});

test('wait for a time and for an event; resume delivers data; state survives a save', async () => {
  const m = mk();
  const g: Graph = { nodes: [{ id: 's', type: 'start' }, { id: 'pause', type: 'wait', params: { ms: 60_000 } }, { id: 'approve', type: 'wait', params: { event: 'approved' } }, { id: 'end', type: 'noop' }], edges: [{ from: 's', to: 'pause' }, { from: 'pause', to: 'approve' }, { from: 'approve', to: 'end' }] };
  let s = await m.e.advance(m.e.start(g, [{ doc: 7 }]));
  assert.equal(s.status, 'waiting');
  assert.equal(s.wakeAt, m.now() + 60_000);
  s = roundtrip(s);
  m.adv(30_000);
  assert.equal((await m.e.advance(s)).status, 'waiting');
  m.adv(30_000);
  s = await m.e.advance(roundtrip(s));
  assert.equal(s.status, 'waiting');
  assert.equal(s.wakeAt, undefined);
  assert.equal(m.e.resume(s, 'rejected'), false);
  assert.equal(m.e.resume(s, 'approved', { by: 'ana' }), true);
  s = await m.e.advance(roundtrip(s));
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(s.final.end![0]!.json, { doc: 7, resume: { by: 'ana' } });
});

test('cancel, abort signal, and finished runs stay finished', async () => {
  const m = mk();
  const g: Graph = { nodes: [{ id: 's', type: 'start' }, { id: 'w', type: 'wait', params: { ms: 1000 } }, { id: 'e', type: 'noop' }], edges: [{ from: 's', to: 'w' }, { from: 'w', to: 'e' }] };
  const s = await m.e.advance(m.e.start(g));
  m.e.cancel(s);
  assert.equal(s.status, 'cancelled');
  m.adv(5000);
  assert.equal((await m.e.advance(s)).status, 'cancelled');
  assert.deepEqual(s.final, {});
  const ac = new AbortController();
  ac.abort();
  assert.equal((await m.e.advance(m.e.start(g), { signal: ac.signal })).status, 'cancelled');
  const done = await m.e.advance(m.e.start({ nodes: [{ id: 's', type: 'start' }], edges: [] }));
  assert.equal(done.status, 'succeeded');
  m.e.cancel(done);
  assert.equal(done.status, 'succeeded');
});

test('step and item limits stop a runaway run', async () => {
  const { e } = mk();
  e.register('explode', { mode: 'all', run: (i) => (i as Item[]).flatMap((x) => [x, x, x]) });
  const nodes = [{ id: 's', type: 'start' }, { id: 'a', type: 'explode' }, { id: 'b', type: 'explode' }, { id: 'c', type: 'explode' }];
  const edges = [{ from: 's', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
  const items = await e.advance(e.start({ nodes, edges, limits: { maxItems: 20 } }, [{ n: 1 }, { n: 2 }]));
  assert.equal(items.status, 'failed');
  assert.match(items.error!.message, /produced 54 items.*limit of 20/);
  const steps = await e.advance(e.start({ nodes, edges, limits: { maxSteps: 2 } }));
  assert.match(steps.error!.message, /more than 2 steps/);
});

test('conditions evaluate without code and tolerate odd data', () => {
  const i: Item = { json: { a: { b: 5 }, s: 'hello world', l: ['x', 'y'], n: null } };
  const c = (field: string, op: Parameters<typeof evalCondition>[0]['op'], value?: unknown) => evalCondition({ field, op, ...(value !== undefined ? { value } : {}) }, i);
  assert.ok(c('a.b', 'gte', 5) && c('a.b', 'lt', 6) && !c('a.b', 'gt', 5) && c('a.b', 'ne', 4));
  assert.ok(c('s', 'contains', 'lo w') && c('l', 'contains', 'y') && c('s', 'matches', '^hel+o'));
  assert.ok(!c('n', 'exists') && !c('zz.yy', 'exists') && c('a', 'exists'));
  assert.ok(!c('a.b', 'gt', '1') && !c('s', 'matches', '(') && !c('__proto__.x', 'exists') && !c('s', 'matches', 'a'.repeat(300)));
});

test('the run lifecycle is a checked state machine and illegal moves are refused', async () => {
  assert.deepEqual(check(RUN_LIFECYCLE), []);
  const { e } = mk();
  const s = await e.advance(e.start({ nodes: [{ id: 's', type: 'start' }], edges: [] }));
  assert.throws(() => (e as unknown as { setStatus: (s: RunState, to: string) => void }).setStatus(s, 'running'), /cannot go from succeeded to running/);
});

test('as jobs: the run advances on the queue and a timer wakes it later', async () => {
  let t = 5_000_000;
  const queue = new Queue({ now: () => t });
  const e = new GraphEngine({ now: () => t });
  const store = memoryStore();
  attachToQueue(queue, e, store, () => t);
  const g: Graph = { nodes: [{ id: 's', type: 'start' }, { id: 'w', type: 'wait', params: { ms: 10_000 } }, { id: 'out', type: 'set', params: { values: { ok: 1 } } }], edges: [{ from: 's', to: 'w' }, { from: 'w', to: 'out' }] };
  const s = e.start(g, [{ a: 1 }], 'job-run');
  enqueueRun(queue, store, s);
  await queue.tick();
  assert.equal(store.get('job-run')!.status, 'waiting');
  assert.equal(queue.due().length, 0);
  t += 10_000;
  assert.equal(queue.due().length, 1);
  await queue.tick();
  const done = store.get('job-run')!;
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.final.out![0]!.json, { a: 1, ok: 1 });
});
