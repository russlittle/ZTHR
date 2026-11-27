import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduled, checkPipeline, drift, listSource, memoryStore, runPipeline, tableSink, watch, type Pipeline, type Row } from './index.ts';

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
