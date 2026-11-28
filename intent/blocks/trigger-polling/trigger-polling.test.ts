import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Queue } from '../jobs/index.ts';
import { signature } from '../webhooks/index.ts';
import { Inactive, TriggerHost, Unverified, UnknownTrigger } from './index.ts';
import type { PollTrigger } from './index.ts';

interface Item { id: number; title: string }

const setup = () => {
  let t = 1_800_000_000_000;
  const queue = new Queue({ now: () => t, random: () => 0 });
  const host = new TriggerHost({ queue, now: () => t });
  const advance = (ms: number) => void (t += ms);
  return { queue, host, advance, now: () => t };
};

const source = (batches: Item[][]) => {
  const calls: (string | undefined)[] = [];
  let i = 0;
  const fetch: PollTrigger<Item>['fetch'] = async (cursor) => {
    calls.push(cursor);
    const items = batches[Math.min(i, batches.length - 1)]!;
    i++;
    return { items, cursor: `c${i}` };
  };
  return { fetch, calls };
};

const def = (fetch: PollTrigger<Item>['fetch'], more: Partial<PollTrigger<Item>> = {}): PollTrigger<Item> => ({ id: 'tickets', flow: 'on-ticket', intervalMs: 60_000, key: (x) => String(x.id), fetch, sample: [{ id: 0, title: 'sample' }], ...more });

test('the first poll records a baseline and emits nothing; later polls emit only new items', async () => {
  const { host, queue, advance } = setup();
  const s = source([[{ id: 1, title: 'a' }, { id: 2, title: 'b' }], [{ id: 2, title: 'b' }, { id: 3, title: 'c' }]]);
  host.addPoll(def(s.fetch));
  const first = await host.poll<Item>('tickets');
  assert.equal(first.baseline, true);
  assert.equal(first.emitted.length, 0);
  assert.equal(queue.jobs.size, 0);
  advance(60_000);
  const second = await host.poll<Item>('tickets');
  assert.deepEqual(second.emitted.map((x) => x.id), [3]);
  assert.equal(second.duplicates, 1);
  assert.deepEqual([...queue.jobs.values()].map((j) => [j.kind, j.key, (j.payload as Item).title]), [['on-ticket', 'tickets:3', 'c']]);
  assert.deepEqual(s.calls, [undefined, 'c1'], 'the cursor from the last poll is passed to the next');
});

test('emitOnFirstPoll emits what is already there', async () => {
  const { host } = setup();
  host.addPoll(def(source([[{ id: 1, title: 'a' }]]).fetch, { emitOnFirstPoll: true }));
  const r = await host.poll<Item>('tickets');
  assert.deepEqual(r.emitted.map((x) => x.id), [1]);
  assert.equal(r.baseline, false);
});

test('a poll before its time does nothing; force polls anyway', async () => {
  const { host, advance } = setup();
  const s = source([[{ id: 1, title: 'a' }]]);
  host.addPoll(def(s.fetch));
  await host.poll('tickets');
  advance(10_000);
  const early = await host.poll('tickets');
  assert.equal(s.calls.length, 1);
  assert.deepEqual(early, { emitted: [], duplicates: 0, baseline: false });
  await host.poll('tickets', { force: true });
  assert.equal(s.calls.length, 2);
});

test('an item whose cursor was lost is still emitted once, because the dedupe set remembers it', async () => {
  const { host, advance, queue } = setup();
  const s = source([[{ id: 1, title: 'a' }], [{ id: 1, title: 'a' }, { id: 2, title: 'b' }], [{ id: 2, title: 'b' }]]);
  host.addPoll(def(s.fetch));
  await host.poll('tickets');
  advance(60_000);
  await host.poll('tickets');
  host.activate('tickets', { keepBaseline: true });
  const state = host.state('tickets');
  assert.ok(state.cursor);
  advance(60_000);
  const r = await host.poll<Item>('tickets');
  assert.equal(r.emitted.length, 0);
  assert.equal(queue.jobs.size, 1);
});

test('the dedupe set is bounded and entries expire', async () => {
  const { host, advance } = setup();
  const s = source([[{ id: 1, title: '' }, { id: 2, title: '' }, { id: 3, title: '' }], [], [{ id: 1, title: '' }]]);
  host.addPoll(def(s.fetch, { dedupeMax: 2, dedupeTtlMs: 120_000, emitOnFirstPoll: true }));
  await host.poll('tickets');
  assert.deepEqual(host.state('tickets').seen.map(([k]) => k), ['2', '3'], 'the oldest key was dropped');
  advance(200_000);
  await host.poll('tickets');
  assert.deepEqual(host.state('tickets').seen, [], 'expired keys are forgotten');
  advance(60_000);
  assert.equal((await host.poll<Item>('tickets')).emitted.length, 1);
});

test('failures back off by doubling, success resets, and enough in a row deactivate with a reason', async () => {
  const { host, advance, now } = setup();
  let fail = true;
  host.addPoll(def(async () => { if (fail) throw new Error('503 from upstream'); return { items: [] }; }, { maxFailures: 3 }));
  const t0 = now();
  const a = await host.poll('tickets');
  assert.equal(a.error, '503 from upstream');
  assert.equal(host.state('tickets').nextPollAt, t0 + 120_000);
  advance(120_000);
  await host.poll('tickets');
  assert.equal(host.state('tickets').nextPollAt, now() + 240_000);
  advance(240_000);
  const c = await host.poll('tickets');
  assert.equal(c.deactivated, true);
  assert.match(host.state('tickets').deactivatedReason!, /3 polls failed in a row; last error: 503 from upstream/);
  await assert.rejects(() => host.poll('tickets'), Inactive);
  fail = false;
  host.activate('tickets');
  assert.equal(host.state('tickets').failures, 0);
  assert.equal((await host.poll('tickets')).error, undefined);
});

test('a success between failures resets the count', async () => {
  const { host, advance } = setup();
  let n = 0;
  host.addPoll(def(async () => { n++; if (n % 2 === 1) throw new Error('x'); return { items: [] }; }, { maxFailures: 2 }));
  for (let i = 0; i < 6; i++) { await host.poll('tickets', { force: true }); advance(1000); }
  assert.equal(host.state('tickets').active, true);
});

test('a poll that hangs is abandoned as a failure', async () => {
  const { host } = setup();
  host.addPoll(def(() => new Promise(() => {}), { timeoutMs: 20 }));
  const r = await host.poll('tickets');
  assert.equal(r.error, 'the poll timed out');
  assert.equal(host.state('tickets').polling, false);
});

test('polls run as jobs on the queue and reschedule themselves while active', async () => {
  const { host, queue, advance } = setup();
  const s = source([[{ id: 1, title: 'a' }], [{ id: 1, title: 'a' }, { id: 2, title: 'b' }]]);
  host.addPoll(def(s.fetch));
  host.schedule('tickets');
  assert.equal(await queue.tick(), 1);
  assert.equal([...queue.jobs.values()].filter((j) => j.kind === 'poll:tickets' && j.state === 'waiting').length, 1, 'the next poll is queued');
  assert.equal(await queue.tick(), 0, 'not due yet');
  advance(60_000);
  await queue.tick();
  assert.equal([...queue.jobs.values()].filter((j) => j.kind === 'on-ticket').length, 1);
  host.deactivate('tickets', 'paused by ana');
  advance(60_000);
  await queue.tick();
  assert.equal([...queue.jobs.values()].filter((j) => j.kind === 'poll:tickets' && j.state === 'waiting').length, 0);
});

test('test mode returns live items without moving the cursor, the dedupe set or the queue', async () => {
  const { host, queue } = setup();
  const s = source([[{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }]]);
  host.addPoll(def(s.fetch));
  const t = await host.testPoll<Item>('tickets', 2);
  assert.equal(t.source, 'live');
  assert.deepEqual(t.items.map((x) => x.id), [1, 2]);
  assert.deepEqual(host.state('tickets').seen, []);
  assert.equal(host.state('tickets').cursor, undefined);
  assert.equal(queue.jobs.size, 0);
});

test('test mode falls back to the sample when the source is empty or failing', async () => {
  const { host } = setup();
  host.addPoll(def(async () => ({ items: [] })));
  assert.deepEqual(await host.testPoll('tickets'), { items: [{ id: 0, title: 'sample' }], source: 'sample', note: 'the source returned nothing' });
  host.addPoll(def(async () => { throw new Error('401'); }, { id: 'broken' }));
  assert.equal((await host.testPoll('broken')).note, 'the source failed: 401');
});

const hook = (host: TriggerHost) => host.addWebhook({ id: 'orders', flow: 'on-order', secrets: ['whsec'], sample: { order: 'sample' } });
const signed = (body: string, now: number, secret = 'whsec') => signature(secret, body, Math.floor(now / 1000));

test('a webhook trigger queues one keyed job per verified delivery and refuses replays', async () => {
  const { host, queue, now } = setup();
  hook(host);
  const body = '{"order":42}';
  const r = await host.receive('orders', body, signed(body, now()), 'd1');
  assert.equal(r.mode, 'production');
  assert.deepEqual([...queue.jobs.values()].map((j) => [j.kind, j.key, j.payload]), [['on-order', 'orders:d1', { order: 42 }]]);
  await assert.rejects(() => host.receive('orders', body, signed(body, now()), 'd1'), /already received/);
  await assert.rejects(() => host.receive('orders', body, signed(body, now(), 'bad'), 'd2'), Unverified);
  await assert.rejects(() => host.receive('orders', body, undefined, 'd3'), /no signature/);
  assert.equal(queue.jobs.size, 1);
  assert.equal(host.state('orders').emittedTotal, 1);
});

test('hostile webhook bodies are refused: oversized, not JSON, and a failed parse frees the id for a retry', async () => {
  const { host, now } = setup();
  host.addWebhook({ id: 'small', flow: 'f', secrets: ['whsec'], sample: {}, maxBytes: 20 });
  const big = '{"a":"' + 'x'.repeat(30) + '"}';
  await assert.rejects(() => host.receive('small', big, signed(big, now()), 'd1'), /larger than/);
  hook(host);
  await assert.rejects(() => host.receive('orders', 'not json', signed('not json', now()), 'd1'), /not JSON/);
  const ok = '{"ok":1}';
  await host.receive('orders', ok, signed(ok, now()), 'd1');
});

test('webhook test mode captures the first delivery, queues nothing, then production resumes', async () => {
  const { host, queue, now } = setup();
  hook(host);
  host.listenForTest('orders');
  assert.deepEqual(host.testResult('orders'), { waiting: true, sample: { order: 'sample' } });
  const body = '{"order":"t1"}';
  assert.equal((await host.receive('orders', body, signed(body, now()), 't1')).mode, 'test');
  assert.deepEqual(host.testResult('orders'), { waiting: false, payload: { order: 't1' }, sample: { order: 'sample' } });
  assert.equal(queue.jobs.size, 0);
  const b2 = '{"order":"p1"}';
  assert.equal((await host.receive('orders', b2, signed(b2, now()), 'p1')).mode, 'production');
  assert.equal(queue.jobs.size, 1);
});

test('an armed test that times out stops capturing', async () => {
  const { host, queue, advance, now } = setup();
  hook(host);
  host.listenForTest('orders', 1000);
  advance(2000);
  assert.equal(host.testResult('orders').waiting, false);
  const body = '{"a":1}';
  assert.equal((await host.receive('orders', body, signed(body, now()), 'd1')).mode, 'production');
  assert.equal(queue.jobs.size, 1);
});

test('flow failures reported back deactivate a webhook trigger, which then refuses deliveries until reactivated', async () => {
  const { host, now } = setup();
  host.addWebhook({ id: 'orders', flow: 'f', secrets: ['whsec'], sample: {}, maxFailures: 2 });
  host.recordRun('orders', false, 'boom');
  host.recordRun('orders', true);
  host.recordRun('orders', false, 'boom');
  assert.equal(host.state('orders').active, true);
  host.recordRun('orders', false, 'bang');
  assert.equal(host.state('orders').active, false);
  assert.match(host.state('orders').deactivatedReason!, /2 runs failed in a row; last error: bang/);
  const body = '{"a":1}';
  await assert.rejects(() => host.receive('orders', body, signed(body, now()), 'd1'), Inactive);
  host.activate('orders');
  await host.receive('orders', body, signed(body, now()), 'd2');
});

test('overview lists every trigger, and unknown or duplicate triggers are refused', async () => {
  const { host } = setup();
  host.addPoll(def(source([[]]).fetch));
  hook(host);
  host.deactivate('orders', 'maintenance');
  assert.deepEqual(host.overview().map((o) => [o.id, o.kind, o.active, o.note]), [['orders', 'webhook', false, 'maintenance'], ['tickets', 'poll', true, undefined]]);
  assert.throws(() => host.addWebhook({ id: 'tickets', flow: 'f', secrets: ['s'], sample: {} }), /already registered/);
  assert.throws(() => host.addPoll(def(source([[]]).fetch, { id: 'fast', intervalMs: 10 })), /at least one second/);
  assert.throws(() => host.state('zzz'), UnknownTrigger);
  await assert.rejects(() => host.poll('orders'), UnknownTrigger);
});
