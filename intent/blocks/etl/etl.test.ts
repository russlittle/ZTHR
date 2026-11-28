import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduled, checkPipeline, drift, listSource, memoryStore, runPipeline, tableSink, watch, type Lineage, type Pipeline, type Row, type RunState, type Source, type Store } from './index.ts';

const people: Row[] = [
  { id: 'p1', name: ' Ana ', email: 'ana@x.org', active: true },
  { id: 'p2', name: 'Ben', email: 'ben@x.org', active: false },
  { id: 'p3', name: 'Chi', email: '', active: true },
  { id: 'p4', name: 'Dee ', email: 'dee@x.org', active: true },
  { id: 'p5', name: 'Eli', email: 'eli@x.org', active: true },
  { id: 'p6', name: 'Fay', email: 'fay@x.org', active: false },
  { id: 'p7', name: 'Gus', email: 'gus@x.org', active: true },
];

const setup = (rows: readonly Row[] = people, o: Partial<Pipeline> = {}) => {
  let t = Date.parse('2026-11-27T02:00:00Z');
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const source = listSource('crm', rows);
  const sink = tableSink('warehouse');
  const store = memoryStore();
  const p: Pipeline = {
    id: 'people',
    source,
    sink,
    key: (r) => String(r.id ?? ''),
    batch: 3,
    steps: [
      { name: 'clean', run: (r) => {
        clock.advance(5);
        if (!r.email) throw new Error('email is empty');
        return { id: r.id, name: String(r.name).trim(), email: r.email, active: r.active };
      } },
      { name: 'active only', run: (r) => (r.active ? { id: r.id, name: r.name, email: r.email } : null) },
    ],
    ...o,
  };
  return { p, source, sink, store, clock };
};

test('extracts in pages, transforms, loads by id, and records lineage with rows in and out of every step', async () => {
  const { p, sink, store, clock } = setup();
  const l = await runPipeline(p, store, { now: clock.now });
  assert.equal(l.status, 'done');
  assert.equal(l.runId, 'people@2026-11-27T02:00:00.000Z');
  assert.deepEqual(l.steps, [
    { name: 'extract', kind: 'extract', rowsIn: 7, rowsOut: 7, dropped: 0, failed: 0, ms: 0, resumed: false },
    { name: 'clean', kind: 'transform', rowsIn: 7, rowsOut: 6, dropped: 0, failed: 1, ms: 35, resumed: false },
    { name: 'active only', kind: 'transform', rowsIn: 6, rowsOut: 4, dropped: 2, failed: 0, ms: 0, resumed: false },
    { name: 'load', kind: 'load', rowsIn: 4, rowsOut: 4, dropped: 0, failed: 0, ms: 0, resumed: false },
  ]);
  assert.deepEqual(l.load, { inserted: 4, updated: 0, unchanged: 0, superseded: 0 });
  assert.deepEqual(l.errors, [{ step: 'clean', at: 3, id: 'p3', error: 'email is empty', row: people[2] }]);
  assert.deepEqual(l.unaccounted, []);
  assert.equal(l.message, 'Finished: 4 rows inserted, 0 rows updated, 0 unchanged; 1 row failed and is listed.');
  assert.deepEqual([...sink.rows.keys()], ['p1', 'p4', 'p5', 'p7']);
  assert.deepEqual(sink.rows.get('p1'), { id: 'p1', name: 'Ana', email: 'ana@x.org' });
  assert.equal(store.states.size, 0, 'a finished run leaves no checkpoint');
  assert.equal(store.pages.size, 0, 'and no staged pages');
  assert.equal(store.lineage.length, 1);
});

test('loads are idempotent: a second run writes nothing that has not changed, and updates what has', async () => {
  const rows = people.map((r) => ({ ...r }));
  const { p, sink, store, clock } = setup(rows);
  await runPipeline(p, store, { now: clock.now });
  const writes = sink.writes;
  const again = await runPipeline(p, store, { now: clock.now });
  assert.deepEqual(again.load, { inserted: 0, updated: 0, unchanged: 4, superseded: 0 });
  assert.equal(sink.writes, writes, 'nothing was written');
  rows[0] = { ...rows[0]!, name: 'Ana Okafor' };
  const third = await runPipeline(p, store, { now: clock.now });
  assert.deepEqual(third.load, { inserted: 0, updated: 1, unchanged: 3, superseded: 0 });
  assert.equal(sink.rows.get('p1')!.name, 'Ana Okafor');
  assert.equal(sink.rows.size, 4);
});

test('a failed load resumes at the page where it stopped, without extracting or transforming again', async () => {
  const { p, source, sink, store, clock } = setup();
  sink.failNextWrite = true;
  const first = await runPipeline(p, store, { now: clock.now });
  assert.equal(first.status, 'failed');
  assert.equal(first.message, 'The run failed at load: warehouse refused the connection. Run it again to resume at page 1 of load.');
  assert.equal(store.states.get('people')!.steps.find((s) => s.name === 'clean')!.status, 'done');
  const reads = source.reads;
  clock.advance(60_000);
  const second = await runPipeline(p, store, { now: clock.now });
  assert.equal(second.status, 'done');
  assert.equal(second.attempt, 2);
  assert.equal(second.runId, first.runId, 'the same run, resumed');
  assert.equal(source.reads, reads, 'the source was not read again');
  assert.deepEqual(second.steps.map((s) => [s.name, s.resumed]), [['extract', true], ['clean', true], ['active only', true], ['load', false]]);
  assert.deepEqual(second.load, { inserted: 4, updated: 0, unchanged: 0, superseded: 0 });
  assert.equal(second.steps[1]!.ms, 35, 'timings carry across attempts');
  assert.deepEqual(store.lineage.map((l) => [l.attempt, l.status]), [[1, 'failed'], [2, 'done']]);
});

test('a source that fails part way resumes from its saved cursor', async () => {
  const { p, source, store, sink, clock } = setup();
  source.failAtPage = 1;
  const first = await runPipeline(p, store, { now: clock.now });
  assert.equal(first.message, 'The run failed at extract: crm timed out. Run it again to resume at page 2 of extract.');
  assert.equal(store.states.get('people')!.steps[0]!.cursor, '3');
  const second = await runPipeline(p, store, { now: clock.now });
  assert.equal(second.status, 'done');
  assert.equal(source.reads, 3, 'pages 1, 2 and 3, each read once');
  assert.equal(second.steps[0]!.rowsOut, 7);
  assert.equal(sink.rows.size, 4);
});

test('row errors are capped: past the limit the run stops, lists the rows, and resumes after a fix', async () => {
  const rows = people.map((r) => ({ ...r, email: r.id === 'p1' || r.id === 'p2' ? '' : r.email }));
  const { p, sink, store, clock } = setup(rows, { maxErrors: 2 });
  const first = await runPipeline(p, store, { now: clock.now });
  assert.equal(first.status, 'stopped');
  assert.equal(first.errorCount, 3);
  assert.deepEqual(first.errors.map((e) => [e.step, e.at, e.id]), [['clean', 1, 'p1'], ['clean', 2, 'p2'], ['clean', 3, 'p3']]);
  assert.equal(first.message, 'Stopped at clean: 3 rows failed, more than the limit of 2. Fix the rows listed and run again; it resumes at page 1 of clean.');
  assert.equal(sink.rows.size, 0, 'nothing was loaded');
  const fixed: Pipeline = { ...p, steps: [{ name: 'clean', run: (r) => ({ id: r.id, name: String(r.name).trim(), email: r.email || 'unknown@x.org', active: r.active }) }, p.steps[1]!] };
  const second = await runPipeline(fixed, store, { now: clock.now });
  assert.equal(second.status, 'done');
  assert.equal(second.errorCount, 0);
  assert.deepEqual([...sink.rows.keys()], ['p1', 'p3', 'p4', 'p5', 'p7']);
  const strict = setup(rows, { maxErrors: 0 });
  assert.equal((await runPipeline(strict.p, strict.store)).status, 'stopped', 'a limit of 0 stops on the first failed row');
});

test('a dry run reports what would change, writes nothing, and leaves the real checkpoints alone', async () => {
  const { p, sink, store, clock } = setup();
  sink.rows.set('p1', { id: 'p1', name: 'Old', email: 'ana@x.org' });
  sink.rows.set('p4', { id: 'p4', name: 'Dee', email: 'dee@x.org' });
  const dry = await runPipeline(p, store, { dryRun: true, now: clock.now });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.load, { inserted: 2, updated: 1, unchanged: 1, superseded: 0 });
  assert.equal(dry.message, 'Dry run finished, nothing was written: 2 rows would be inserted, 1 row would be updated, 1 unchanged; 1 row failed and is listed.');
  assert.equal(sink.writes, 0);
  assert.equal(sink.rows.get('p1')!.name, 'Old');
  assert.equal(store.states.size, 0);
  sink.failNextWrite = true;
  await runPipeline(p, store, { now: clock.now });
  const dry2 = await runPipeline(p, store, { dryRun: true, now: clock.now });
  assert.equal(dry2.attempt, 1, 'a dry run does not resume a real run');
  assert.equal(store.states.get('people')!.attempt, 1, 'and does not move it on');
});

test('fan-out, duplicate ids in a page, rows without an id, and a staged page that went missing are all accounted for', async () => {
  const rows: Row[] = [{ id: 'a', tags: ['x', 'y'] }, { id: 'b', tags: [] }, { id: 'c', tags: ['z'] }];
  const { p, sink, store } = setup(rows, {
    batch: 10,
    key: (r) => String(r.id ?? ''),
    steps: [{ name: 'one per tag', run: (r) => (r.tags as string[]).map((t) => ({ id: t === 'z' ? 'x' : t, tag: t, from: r.id })) }, { name: 'drop y ids', run: (r) => (r.tag === 'y' ? { tag: r.tag } : r) }],
  });
  const l = await runPipeline(p, store);
  assert.deepEqual(l.steps.map((s) => [s.name, s.rowsIn, s.rowsOut, s.dropped, s.failed]), [['extract', 3, 3, 0, 0], ['one per tag', 3, 3, 1, 0], ['drop y ids', 3, 3, 0, 0], ['load', 3, 1, 0, 1]]);
  assert.deepEqual(l.load, { inserted: 1, updated: 0, unchanged: 0, superseded: 1 });
  assert.deepEqual(l.errors.map((e) => [e.step, e.at, e.error, e.id]), [['load', 2, 'the row has no id to load it under', undefined]]);
  assert.deepEqual(sink.rows.get('x'), { id: 'x', tag: 'z', from: 'c' }, 'the later row with the same id wins');
  assert.deepEqual(l.unaccounted, []);

  const t = setup();
  t.sink.failNextWrite = true;
  const failed = await runPipeline(t.p, t.store);
  const key = [...t.store.pages.keys()].find((k) => k.includes('active only'))!;
  t.store.pages.set(key, t.store.pages.get(key)!.slice(1));
  const tampered = await runPipeline(t.p, t.store);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(tampered.unaccounted, ['active only put out 4 rows but load took in 3 rows.']);
  assert.match(tampered.message, /^The run finished but not every row is accounted for: active only put out 4 rows but load took in 3 rows\. Check the source/);
  t.store.pages.clear();
  t.sink.failNextWrite = true;
  await runPipeline(t.p, t.store);
  t.store.pages.clear();
  assert.match((await runPipeline(t.p, t.store)).message, /^The run failed at load: the staged page 1 of active only is missing\./);
});

test('a pipeline that could not run as declared is refused before anything is read', async () => {
  const { p, source, store } = setup();
  assert.deepEqual(checkPipeline({ ...p, id: ' ', batch: 0, maxErrors: -1, steps: [{ name: 'load', run: (r) => r }, { name: 'x', run: (r) => r }, { name: 'x', run: (r) => r }] }), [
    'The pipeline needs an id.',
    'A transform cannot be called "load"; that name is the pipeline\'s own step.',
    'Two transforms are called "x"; each step needs its own name.',
    'The batch size must be a whole number of at least 1.',
    'The error limit must be a whole number of 0 or more.',
  ]);
  await assert.rejects(runPipeline({ ...p, steps: [{ name: 'extract', run: (r) => r }] }, store), /cannot be called "extract"/);
  assert.equal(source.reads, 0);
  assert.deepEqual(checkPipeline(p), []);
});

test('a changed pipeline starts a fresh run instead of resuming one staged for different steps', async () => {
  const { p, sink, store, clock } = setup();
  sink.failNextWrite = true;
  const first = await runPipeline(p, store, { now: clock.now });
  clock.advance(1000);
  const changed = await runPipeline({ ...p, steps: [p.steps[0]!] }, store, { now: clock.now });
  assert.notEqual(changed.runId, first.runId);
  assert.equal(changed.attempt, 1);
  assert.equal(changed.load.inserted, 6);
  assert.equal(store.pages.size, 0, 'the old run\'s staged pages are dropped');
});

test('the schedule runs when due and never overlaps; the watch reports stale runs, failures and drift', async () => {
  const rows = people.map((r) => ({ ...r }));
  const { p, store, sink, clock } = setup(rows);
  const s = new Scheduled(p, store, '0 2 * * *', new Date('2026-11-26T12:00:00Z'), { now: clock.now });
  assert.equal(new Date(s.next).toISOString(), '2026-11-27T02:00:00.000Z');
  assert.equal(await s.tick(new Date('2026-11-27T01:59:00Z')), undefined, 'not due yet');
  s.running = true;
  assert.equal(await s.tick(new Date('2026-11-27T02:00:00Z')), undefined, 'already running');
  s.running = false;
  const l = await s.tick(new Date('2026-11-27T02:00:00Z'));
  assert.equal(l?.status, 'done');
  assert.equal(new Date(s.next).toISOString(), '2026-11-28T02:00:00.000Z');
  assert.equal(await s.tick(new Date('2026-11-27T03:00:00Z')), undefined, 'once a day');

  assert.deepEqual(watch([], new Date(), { maxAgeHours: 26 }), { ok: false, say: 'The pipeline has never run.' });
  const h1 = await store.history('people');
  assert.deepEqual(watch(h1, new Date('2026-11-27T08:00:00Z'), { maxAgeHours: 26 }), { ok: true, say: 'The last run finished at 2026-11-27T02:00:00.035Z: 4 rows inserted, 0 rows updated, 0 unchanged; 1 row failed and is listed.' });
  assert.deepEqual(watch(h1, new Date('2026-11-28T06:00:00Z'), { maxAgeHours: 26 }), { ok: false, say: 'The last good run finished at 2026-11-27T02:00:00.035Z, more than 26 hours ago. Check that the schedule is running.' });

  rows[0] = { ...rows[0]!, name: 'Ana Okafor' };
  sink.failNextWrite = true;
  await runPipeline(p, store, { now: clock.now });
  const h2 = await store.history('people');
  assert.equal(watch(h2, new Date('2026-11-27T09:00:00Z'), { maxAgeHours: 26 }).say, 'The last run did not finish. The run failed at load: warehouse refused the connection. Run it again to resume at page 1 of load.');
  await runPipeline(p, store, { now: clock.now });

  rows.splice(2);
  await runPipeline(p, store, { now: clock.now });
  const h3 = await store.history('people');
  assert.deepEqual(watch(h3, new Date('2026-11-27T09:00:00Z'), { maxAgeHours: 26 }), { ok: false, say: 'Extracted 2 rows, 71% fewer than the last run (7). Check the source before trusting this load.' });
  assert.equal(drift(h3.at(-1)!, h3.at(-1)!), undefined);
  assert.equal(drift(h3.at(-1)!, undefined), undefined);
  assert.equal(drift(h3.at(-1)!, { ...h3.at(-1)!, steps: [{ ...h3.at(-1)!.steps[0]!, rowsOut: 0 }] }), 'Extracted 2 rows where the last run extracted none.');
});

const lin = (o: Partial<Lineage> & { out?: number } = {}): Lineage => {
  const { out = 10, ...rest } = o;
  return {
    runId: 'r',
    pipeline: 'people',
    attempt: 1,
    dryRun: false,
    status: 'done',
    startedAt: '2026-11-27T00:00:00.000Z',
    finishedAt: '2026-11-27T02:00:00.000Z',
    source: 'crm',
    sink: 'warehouse',
    steps: [{ name: 'extract', kind: 'extract', rowsIn: out, rowsOut: out, dropped: 0, failed: 0, ms: 0, resumed: false }],
    load: { inserted: 0, updated: 0, unchanged: 0, superseded: 0 },
    errorCount: 0,
    errors: [],
    unaccounted: [],
    message: 'Finished: ok.',
    ...rest,
  };
};

test('the memory store hands out copies, drops only one run\'s pages, and keeps each pipeline\'s history apart', async () => {
  const store = memoryStore();
  assert.equal(await store.state('x'), undefined);
  assert.equal(await store.getPage('r1', 's', 0), undefined);
  const st: RunState = { runId: 'r1', pipeline: 'x', startedAt: 't', attempt: 1, steps: [], errors: [] };
  await store.save(st);
  const got = (await store.state('x'))!;
  got.attempt = 9;
  assert.equal((await store.state('x'))!.attempt, 1, 'changing what was handed out does not change what is stored');
  assert.equal(st.attempt, 1);
  await store.putPage('r1', 's', 0, [{ a: 1 }]);
  const page = (await store.getPage('r1', 's', 0))! as Row[];
  page.push({ a: 2 });
  assert.deepEqual(await store.getPage('r1', 's', 0), [{ a: 1 }]);
  await store.putPage('r1', 't', 1, [{ a: 3 }]);
  await store.putPage('r2', 's', 0, [{ a: 4 }]);
  await store.putPage('r10', 's', 0, [{ a: 5 }]);
  await store.dropPages('r1');
  assert.equal(await store.getPage('r1', 's', 0), undefined);
  assert.equal(await store.getPage('r1', 't', 1), undefined);
  assert.deepEqual(await store.getPage('r2', 's', 0), [{ a: 4 }], 'another run keeps its pages');
  assert.deepEqual(await store.getPage('r10', 's', 0), [{ a: 5 }], 'so does a run whose name starts the same');
  await store.clear('x');
  assert.equal(await store.state('x'), undefined);

  await store.record(lin({ pipeline: 'a', runId: 'a1' }));
  await store.record(lin({ pipeline: 'b', runId: 'b1' }));
  await store.record(lin({ pipeline: 'a', runId: 'a2' }));
  assert.deepEqual((await store.history('a')).map((l) => l.runId), ['a1', 'a2']);
  assert.deepEqual((await store.history('b')).map((l) => l.runId), ['b1']);
  assert.deepEqual(await store.history('c'), []);
  (await store.history('b'))[0]!.errors;
  const h = (await store.history('b')) as Lineage[];
  h[0] = lin({ runId: 'changed' });
  assert.equal((await store.history('b'))[0]!.runId, 'b1');
});

test('a row is unchanged only when every field is the same: scalars, nesting, dates, arrays, nulls and missing fields', async () => {
  const d = (ms: number) => new Date(ms);
  const cases: [string, Row, Row, 'unchanged' | 'updated'][] = [
    ['equal scalars', { v: 1 }, { v: 1 }, 'unchanged'],
    ['different scalars', { v: 1 }, { v: 2 }, 'updated'],
    ['number then empty object', { v: 1 }, { v: {} }, 'updated'],
    ['empty object then number', { v: {} }, { v: 1 }, 'updated'],
    ['zero then empty object', { v: 0 }, { v: {} }, 'updated'],
    ['text then its character map', { v: 'ab' }, { v: { 0: 'a', 1: 'b' } }, 'updated'],
    ['character map then text', { v: { 0: 'a', 1: 'b' } }, { v: 'ab' }, 'updated'],
    ['null then empty object', { v: null }, { v: {} }, 'updated'],
    ['empty object then null', { v: {} }, { v: null }, 'updated'],
    ['null then number', { v: null }, { v: 0 }, 'updated'],
    ['number then null', { v: 0 }, { v: null }, 'updated'],
    ['null and null', { v: null }, { v: null }, 'unchanged'],
    ['the same instant in two Dates', { v: d(1000) }, { v: d(1000) }, 'unchanged'],
    ['different instants', { v: d(1000) }, { v: d(2000) }, 'updated'],
    ['a Date then an empty object', { v: d(1000) }, { v: {} }, 'updated'],
    ['an empty object then a Date', { v: {} }, { v: d(1000) }, 'updated'],
    ['a Date then text', { v: d(1000) }, { v: 'x' }, 'updated'],
    ['an empty array then an empty object', { v: [] }, { v: {} }, 'updated'],
    ['an empty object then an empty array', { v: {} }, { v: [] }, 'updated'],
    ['an array then its index map', { v: [1] }, { v: { 0: 1 } }, 'updated'],
    ['equal arrays', { v: [1, 2] }, { v: [1, 2] }, 'unchanged'],
    ['the same items in another order', { v: [1, 2] }, { v: [2, 1] }, 'updated'],
    ['a longer array', { v: [1] }, { v: [1, 2] }, 'updated'],
    ['a missing field and one set to undefined', { a: 1, b: undefined }, { a: 1 }, 'unchanged'],
    ['one set to undefined and a missing field', { a: 1 }, { a: 1, b: undefined }, 'unchanged'],
    ['different fields both undefined', { a: undefined }, { b: undefined }, 'unchanged'],
    ['a new field', { a: 1 }, { a: 1, b: 2 }, 'updated'],
    ['a dropped field', { a: 1, b: 2 }, { a: 1 }, 'updated'],
    ['a renamed field', { a: 1 }, { b: 1 }, 'updated'],
    ['nested objects in another key order', { n: { x: 1, y: { z: [1, { q: 'w' }] } } }, { n: { y: { z: [1, { q: 'w' }] }, x: 1 } }, 'unchanged'],
    ['nested difference', { n: { x: 1, y: { z: [1, { q: 'w' }] } } }, { n: { x: 1, y: { z: [1, { q: 'v' }] } } }, 'updated'],
  ];
  for (const [name, before, after, want] of cases) {
    const { p, sink, store } = setup([{ id: 'k', ...after }], { steps: [] });
    sink.rows.set('k', { id: 'k', ...before });
    const l = await runPipeline(p, store);
    assert.equal(l.status, 'done', name);
    assert.deepEqual(l.load, { inserted: 0, updated: want === 'updated' ? 1 : 0, unchanged: want === 'unchanged' ? 1 : 0, superseded: 0 }, name);
    assert.equal(sink.writes, want === 'updated' ? 1 : 0, name);
  }
});

test('a pipeline declaration: several repeated names, no batch, a batch of one and an error limit of zero are judged right', async () => {
  const { p, store } = setup();
  const noop = (name: string) => ({ name, run: (r: Row) => r });
  assert.deepEqual(checkPipeline({ ...p, steps: [noop('a'), noop('b'), noop('a'), noop('b'), noop('c')] }), ['Two transforms are called "a", "b"; each step needs its own name.']);
  const { batch: _batch, ...noBatch } = p;
  assert.deepEqual(checkPipeline(noBatch), [], 'a pipeline without a batch size uses the default');
  assert.deepEqual(checkPipeline({ ...p, batch: 1 }), []);
  assert.deepEqual(checkPipeline({ ...p, batch: 1.5 }), ['The batch size must be a whole number of at least 1.']);
  assert.deepEqual(checkPipeline({ ...p, maxErrors: 0 }), []);
  assert.deepEqual(checkPipeline({ ...p, maxErrors: 0.5 }), ['The error limit must be a whole number of 0 or more.']);
  await assert.rejects(runPipeline({ ...p, id: '', batch: 0 }, store), { message: 'The pipeline needs an id. The batch size must be a whole number of at least 1.' });
  const one = setup(people, { batch: 1 });
  assert.equal((await runPipeline(one.p, one.store)).status, 'done');
  assert.equal(one.source.reads, 7);
  const dflt = setup(people, { batch: 1 });
  const { batch: _b2, ...rest } = dflt.p;
  assert.equal((await runPipeline(rest, dflt.store)).status, 'done');
  assert.equal(dflt.source.reads, 1, 'the whole source fits in one default page');
});

test('a checkpoint says what is done and what is pending, and a resume marks every step that had started', async () => {
  const { p, source, sink, store, clock } = setup();
  source.failAtPage = 1;
  const first = await runPipeline(p, store, { now: clock.now });
  assert.deepEqual(first.unaccounted, [], 'a run that did not finish claims no accounting');
  assert.deepEqual(first.steps.map((s) => s.resumed), [false, false, false, false]);
  const saved = store.states.get('people')!;
  assert.deepEqual(saved.steps.map((s) => [s.name, s.status, s.page]), [['extract', 'pending', 1], ['clean', 'pending', 0], ['active only', 'pending', 0], ['load', 'pending', 0]]);
  assert.deepEqual([saved.steps[0]!.pages, saved.steps[0]!.rowsIn, saved.steps[0]!.rowsOut, saved.steps[0]!.kept], [1, 3, 3, 3], 'the extract step counts the page it staged');
  const second = await runPipeline(p, store, { now: clock.now });
  assert.deepEqual(second.steps.map((s) => [s.name, s.resumed]), [['extract', true], ['clean', false], ['active only', false], ['load', false]], 'only a step that had started counts as resumed');
  assert.equal(sink.rows.size, 4);

  const l = await runPipeline(setup().p, memoryStore());
  assert.deepEqual(l.steps.map((s) => s.resumed), [false, false, false, false]);

  const failing = setup();
  failing.sink.failNextWrite = true;
  const f = await runPipeline(failing.p, failing.store);
  assert.deepEqual(f.unaccounted, []);
  assert.equal(f.status, 'failed');
  assert.deepEqual(failing.store.states.get('people')!.steps.map((s) => [s.name, s.status]), [['extract', 'done'], ['clean', 'done'], ['active only', 'done'], ['load', 'pending']]);
});

test('a step that is renamed, not added or removed, is a different pipeline and starts again', async () => {
  const { p, source, sink, store } = setup();
  sink.failNextWrite = true;
  const first = await runPipeline(p, store);
  const reads = source.reads;
  const renamed: Pipeline = { ...p, steps: [p.steps[0]!, { name: 'only active', run: p.steps[1]!.run }] };
  const second = await runPipeline(renamed, store, { now: () => Date.parse('2026-11-28T00:00:00Z') });
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.attempt, 1);
  assert.equal(second.status, 'done');
  assert.ok(source.reads > reads, 'the source is read again');
  assert.deepEqual(second.steps.map((s) => s.resumed), [false, false, false, false]);
});

test('the error limit is a limit: exactly that many failed rows finish, more stop, and the count carries across pages', async () => {
  const blank = (ids: string[]) => people.map((r) => ({ ...r, email: ids.includes(String(r.id)) ? '' : r.id === 'p3' ? 'chi@x.org' : r.email }));
  const exact = setup(blank(['p1', 'p2']), { maxErrors: 2 });
  const done = await runPipeline(exact.p, exact.store);
  assert.equal(done.status, 'done');
  assert.equal(done.errorCount, 2);
  assert.equal(done.message, 'Finished: 4 rows inserted, 0 rows updated, 0 unchanged; 2 rows failed and are listed.');
  assert.deepEqual(exact.sink.rows.size, 4);

  const across = setup(blank(['p1', 'p4', 'p5']), { maxErrors: 2 });
  const stopped = await runPipeline(across.p, across.store);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.errorCount, 3);
  assert.equal(stopped.message, 'Stopped at clean: 3 rows failed, more than the limit of 2. Fix the rows listed and run again; it resumes at page 2 of clean.');
  assert.equal(across.sink.rows.size, 0);

  const many = setup(Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, name: 'x', email: '', active: true })), { maxErrors: 200, batch: 500 });
  const l = await runPipeline(many.p, many.store);
  assert.equal(l.errorCount, 150);
  assert.equal(l.errors.length, 100, 'the lineage lists the first 100');
  assert.equal(l.errors[0]!.at, 1);
  assert.equal(l.errors[99]!.at, 100);
});

test('a row that cannot be loaded is recorded without an id it does not have, and counts toward the limit', async () => {
  const blank: Row = { id: '', name: 'Zed', email: 'z@x.org', active: true };
  const fine: Row = { id: 'ok', name: 'Amy', email: 'a@x.org', active: true };

  const strict = setup([blank, fine], { steps: [], maxErrors: 0 });
  const stopped = await runPipeline(strict.p, strict.store);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.message, 'Stopped at load: 1 row failed, more than the limit of 0. Fix the rows listed and run again; it resumes at page 1 of load.');
  assert.deepEqual(stopped.errors, [{ step: 'load', at: 1, error: 'the row has no id to load it under', row: blank }]);
  assert.equal(strict.sink.rows.size, 0, 'nothing was loaded');
  assert.equal(strict.sink.writes, 0);

  const lenient = setup([blank, fine], { steps: [], maxErrors: 1 });
  const l = await runPipeline(lenient.p, lenient.store);
  assert.equal(l.status, 'done');
  assert.deepEqual(l.errors, [{ step: 'load', at: 1, error: 'the row has no id to load it under', row: blank }]);
  assert.deepEqual([...lenient.sink.rows.keys()], ['ok']);

  const numeric = setup([{ id: 7, name: 'Num' } as Row, fine], { steps: [], key: (r) => r.id as string });
  const n = await runPipeline(numeric.p, numeric.store);
  assert.deepEqual(n.errors, [{ step: 'load', at: 1, error: 'the row has no id to load it under', row: { id: 7, name: 'Num' } }], 'an id that is not text is not an id');
  assert.deepEqual([...numeric.sink.rows.keys()], ['ok']);

  const tr = setup([{ name: 'no id field', email: 'x' }, { id: '', name: 'blank id', email: 'y' }, { id: 4, name: 'number id', email: 'z' }, fine], {
    key: (r) => (r.id as string).toString().trim() === '4' ? (r.id as string) : (r.id as string).toLowerCase(),
    steps: [{ name: 'check', run: (r) => { if (r.email !== 'a@x.org') throw new Error('bad row'); return r; } }],
    maxErrors: 5,
  });
  const t = await runPipeline(tr.p, tr.store);
  assert.deepEqual(t.errors, [
    { step: 'check', at: 1, error: 'bad row', row: { name: 'no id field', email: 'x' } },
    { step: 'check', at: 2, error: 'bad row', row: { id: '', name: 'blank id', email: 'y' } },
    { step: 'check', at: 3, error: 'bad row', row: { id: 4, name: 'number id', email: 'z' } },
  ], 'a key that throws, is empty or is not text leaves the id out');
});

test('a run that fails after every step is done says it failed at the end, and resumes by finishing', async () => {
  const store = memoryStore();
  let thrown = false;
  const flaky: Store = { ...store, save: async (s) => { if (!thrown && s.steps.every((x) => x.status === 'done')) { thrown = true; throw new Error('disk full'); } return store.save(s); } };
  const { p, sink } = setup();
  const first = await runPipeline(p, flaky);
  assert.equal(first.status, 'failed');
  assert.equal(first.message, 'The run failed at the end: disk full. Run it again to resume at page 1 of that step.');
  const second = await runPipeline(p, flaky);
  assert.equal(second.status, 'done');
  assert.equal(second.attempt, 2);
  assert.equal(sink.rows.size, 4);
});

test('when the counts do not add up the run says where, in one sentence, whether real or dry', async () => {
  const t = setup();
  t.sink.failNextWrite = true;
  await runPipeline(t.p, t.store);
  const saved = t.store.states.get('people')!;
  saved.steps.find((s) => s.name === 'clean')!.kept = 5;
  saved.steps.find((s) => s.name === 'load')!.superseded = 1;
  t.store.states.set('people', saved);
  const l = await runPipeline(t.p, t.store);
  assert.equal(l.status, 'done');
  assert.deepEqual(l.unaccounted, ['clean took in 7 rows but kept 5, dropped 0 and failed 1.', 'load took in 4 rows but inserted 4, updated 0, left 0 unchanged, superseded 1 and failed 0.']);
  assert.equal(l.message, 'The run finished but not every row is accounted for: clean took in 7 rows but kept 5, dropped 0 and failed 1. load took in 4 rows but inserted 4, updated 0, left 0 unchanged, superseded 1 and failed 0. Check the source and the staged pages before trusting this load.');

  const liar = (inner: Source): Source => ({
    name: 'liar',
    async read(after, size) {
      const r = await inner.read(after, size);
      let reads = 0;
      return { get rows() { return reads++ === 0 ? r.rows : [...r.rows, { id: 'ghost' }]; }, next: r.next };
    },
  });
  const base = setup(people, { batch: 10 });
  const p: Pipeline = { ...base.p, source: liar(base.source) };
  const real = await runPipeline(p, base.store);
  assert.deepEqual(real.unaccounted, ['extract put out 8 rows but clean took in 7 rows.']);
  assert.equal(real.message, 'The run finished but not every row is accounted for: extract put out 8 rows but clean took in 7 rows. Check the source and the staged pages before trusting this load.');
  const dry = await runPipeline(p, base.store, { dryRun: true });
  assert.equal(dry.message, 'The dry run finished but not every row is accounted for: extract put out 8 rows but clean took in 7 rows. Check the source and the staged pages before trusting this load.');
});

test('a quiet rerun and a dry run say exactly what they did, and the load step counts every row it settled', async () => {
  const { p, sink, store } = setup();
  const fixed = { now: () => 0 };
  await runPipeline(p, store, fixed);
  const again = await runPipeline(p, store, fixed);
  assert.equal(again.message, 'Finished: 0 rows inserted, 0 rows updated, 4 unchanged; 1 row failed and is listed.');
  assert.deepEqual(again.steps.at(-1), { name: 'load', kind: 'load', rowsIn: 4, rowsOut: 4, dropped: 0, failed: 0, ms: 0, resumed: false });

  const d = setup();
  d.sink.rows.set('p1', { id: 'p1', name: 'Old', email: 'ana@x.org' });
  d.sink.rows.set('p4', { id: 'p4', name: 'Dee', email: 'dee@x.org' });
  const dry = await runPipeline(d.p, d.store, { dryRun: true, ...fixed });
  assert.deepEqual(dry.steps.at(-1), { name: 'load', kind: 'load', rowsIn: 4, rowsOut: 4, dropped: 0, failed: 0, ms: 0, resumed: false });
  const real = await runPipeline(d.p, d.store);
  assert.deepEqual(real.load, { inserted: 2, updated: 1, unchanged: 1, superseded: 0 });
  assert.equal(real.steps.at(-1)!.rowsOut, 4);
  assert.equal(sink.writes, 3, 'one write for each page that had something to load');
  const many = setup(people.map((r) => ({ ...r, email: r.id === 'p5' || r.id === 'p6' ? '' : r.email })), { maxErrors: 5 });
  const l = await runPipeline(many.p, many.store);
  assert.equal(l.message, 'Finished: 3 rows inserted, 0 rows updated, 0 unchanged; 3 rows failed and are listed.');
});

test('drift compares extracted rows with the last run, to the exact tolerance', () => {
  assert.equal(drift(lin({ out: 5 }), lin({ out: 4 })), undefined, 'a quarter is within the default tolerance');
  assert.equal(drift(lin({ out: 3 }), lin({ out: 4 })), undefined);
  assert.equal(drift(lin({ out: 6 }), lin({ out: 4 })), 'Extracted 6 rows, 50% more than the last run (4). Check the source before trusting this load.');
  assert.equal(drift(lin({ out: 2 }), lin({ out: 4 })), 'Extracted 2 rows, 50% fewer than the last run (4). Check the source before trusting this load.');
  assert.equal(drift(lin({ out: 5 }), lin({ out: 4 }), 0.1), 'Extracted 5 rows, 25% more than the last run (4). Check the source before trusting this load.');
  assert.equal(drift(lin({ out: 1500 }), lin({ out: 1000 })), 'Extracted 1,500 rows, 50% more than the last run (1,000). Check the source before trusting this load.');
  assert.equal(drift(lin({ out: 0 }), lin({ out: 0 })), undefined, 'none and none is no change');
  assert.equal(drift(lin({ out: 3 }), lin({ out: 0 })), 'Extracted 3 rows where the last run extracted none.');
  assert.equal(drift(lin({ out: 1 }), lin({ steps: [] })), 'Extracted 1 row where the last run extracted none.');
  assert.equal(drift(lin({ steps: [] }), lin({ out: 4 })), 'Extracted 0 rows, 100% fewer than the last run (4). Check the source before trusting this load.');
  assert.equal(drift(lin({ steps: [] }), lin({ steps: [] })), undefined);
});

test('the watch judges only real runs, skips unfinished ones when comparing, and keeps to the hour', () => {
  const at = new Date('2026-11-27T08:00:00Z');
  const o = { maxAgeHours: 26 };
  assert.deepEqual(watch([], at, o), { ok: false, say: 'The pipeline has never run.' });
  assert.deepEqual(watch([lin({ dryRun: true })], at, o), { ok: false, say: 'The pipeline has never run.' }, 'a dry run is not a run');
  assert.deepEqual(watch([lin(), lin({ status: 'failed', message: 'It broke.' })], at, o), { ok: false, say: 'The last run did not finish. It broke.' });
  assert.deepEqual(watch([lin({ status: 'stopped', message: 'Stopped.' })], at, o), { ok: false, say: 'The last run did not finish. Stopped.' });
  assert.deepEqual(watch([lin(), lin({ unaccounted: ['a row went missing'], message: 'Not every row is accounted for.' })], at, o), { ok: false, say: 'Not every row is accounted for.' });

  const history = [lin({ out: 10 }), lin({ status: 'failed', out: 3, finishedAt: '2026-11-27T03:00:00.000Z' }), lin({ out: 3, unaccounted: ['x'], finishedAt: '2026-11-27T04:00:00.000Z' }), lin({ out: 10, finishedAt: '2026-11-27T05:00:00.000Z', message: 'Finished: ok.' }), lin({ dryRun: true, out: 99, finishedAt: '2026-11-27T06:00:00.000Z' })];
  assert.deepEqual(watch(history, at, o), { ok: true, say: 'The last run finished at 2026-11-27T05:00:00.000Z: ok.' }, 'failed, unaccounted and dry runs are not what it is compared with');
  assert.equal(watch([...history.slice(0, 4)].map((l, i) => (i === 3 ? lin({ out: 30, finishedAt: l.finishedAt }) : l)), at, o).say, 'Extracted 30 rows, 200% more than the last run (10). Check the source before trusting this load.');
  assert.equal(watch([lin({ out: 10 }), lin({ out: 30 })], at, { ...o, tolerance: 5 }).ok, true, 'the tolerance is passed on');

  assert.equal(watch([lin()], new Date('2026-11-28T04:00:00Z'), o).ok, true, 'exactly the age allowed is not too old');
  assert.deepEqual(watch([lin()], new Date('2026-11-28T04:00:01Z'), o), { ok: false, say: 'The last good run finished at 2026-11-27T02:00:00.000Z, more than 26 hours ago. Check that the schedule is running.' });
  assert.deepEqual(watch([lin({ message: 'Nightly Finished: ok.' })], at, o), { ok: true, say: 'The last run finished at 2026-11-27T02:00:00.000Z: Nightly Finished: ok.' }, 'only the leading word is dropped');
});

test('a schedule that has just been made is ready to run, refuses a second run while one is under way, and is ready again after', async () => {
  const { p, source, store, clock } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow: Source = { name: 'slow', read: async (a, n) => { await gate; return source.read(a, n); } };
  const s = new Scheduled({ ...p, source: slow }, store, '0 2 * * *', new Date('2026-11-26T12:00:00Z'), { now: clock.now });
  assert.equal(s.running, false, 'nothing is running to begin with');
  const first = s.tick(new Date('2026-11-27T02:00:00Z'));
  assert.equal(s.running, true);
  assert.equal(await s.tick(new Date('2026-11-27T02:00:30Z')), undefined, 'a second tick while one is running does nothing');
  release();
  assert.equal((await first)?.status, 'done');
  assert.equal(s.running, false, 'and when it ends it can run again');
  const next = await s.tick(new Date('2026-11-28T02:00:00Z'));
  assert.equal(next?.status, 'done');
  assert.equal(s.running, false);
  assert.equal(new Date(s.next).toISOString(), '2026-11-29T02:00:00.000Z');

  const failing = setup();
  failing.sink.failNextWrite = true;
  const sf = new Scheduled(failing.p, failing.store, '0 2 * * *', new Date('2026-11-26T12:00:00Z'), { now: failing.clock.now });
  assert.equal((await sf.tick(new Date('2026-11-27T02:00:00Z')))?.status, 'failed');
  assert.equal(sf.running, false, 'a run that failed does not leave the schedule stuck');
});

test('the source and sink twins page, count and answer as they say', async () => {
  const six = listSource('s', people.slice(0, 6));
  const a = await six.read(undefined, 3);
  assert.equal(a.next, '3');
  const b = await six.read('3', 3);
  assert.equal(b.rows.length, 3);
  assert.equal(b.next, undefined, 'a page that ends exactly at the last row has no next page');
  assert.equal(six.reads, 2);
  const run = setup(people.slice(0, 6));
  await runPipeline(run.p, run.store);
  assert.equal(run.source.reads, 2, 'two pages of three, with no empty third read');

  const sink = tableSink('t');
  await sink.write([{ id: 'a', row: { v: 1 } }, { id: 'b', row: { v: 2 } }]);
  await sink.write([{ id: 'c', row: { v: 3 } }]);
  assert.equal(sink.writes, 2);
  assert.deepEqual([...(await sink.existing(['a', 'zz', 'c'])).keys()], ['a', 'c'], 'only the ids it holds come back');
  sink.failNextWrite = true;
  await assert.rejects(sink.write([{ id: 'd', row: {} }]), /t refused the connection/);
  assert.equal(sink.writes, 2);
  assert.equal(sink.rows.has('d'), false);
});

test('a run with no failed rows says nothing about failures', async () => {
  const { p, sink, store } = setup(people.filter((r) => r.email), { steps: [] });
  const l = await runPipeline(p, store);
  assert.equal(l.message, 'Finished: 6 rows inserted, 0 rows updated, 0 unchanged.');
  assert.equal(sink.rows.size, 6);
  const dry = setup(people.filter((r) => r.email), { steps: [] });
  assert.equal((await runPipeline(dry.p, dry.store, { dryRun: true })).message, 'Dry run finished, nothing was written: 6 rows would be inserted, 0 rows would be updated, 0 unchanged.');
});
