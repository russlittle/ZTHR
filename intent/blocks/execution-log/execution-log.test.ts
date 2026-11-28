import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Audit, memoryAudit } from '../audit/index.ts';
import { ExecutionLog, NotFound, NotReplayable, REDACTED, redact } from './index.ts';

const clock = (start = '2026-11-01T00:00:00Z') => {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
};
const ids = () => { let n = 0; return () => `r${++n}`; };

test('sensitive keys are redacted at any depth, other values are kept', () => {
  const r = redact({ user: 'ana', password: 'hunter2', nested: { Authorization: 'Bearer abc', list: [{ apiKey: 'k', ok: 1 }] }, 'X-Api-Key': 'z' });
  assert.deepEqual(r.value, { user: 'ana', password: REDACTED, nested: { Authorization: REDACTED, list: [{ apiKey: REDACTED, ok: 1 }] }, 'X-Api-Key': REDACTED });
  assert.equal(r.altered, true);
  assert.deepEqual(redact({ a: 1 }), { value: { a: 1 }, altered: false });
});

test('declared secret values are removed from inside strings, longest first', () => {
  const r = redact({ url: 'https://x/?k=supersecret123&z=1', note: 'supersecret123456 and supersecret123' }, { secrets: ['supersecret123', 'supersecret123456'] });
  assert.deepEqual(r.value, { url: `https://x/?k=${REDACTED}&z=1`, note: `${REDACTED} and ${REDACTED}` });
  assert.equal(redact('abc', { secrets: ['abc'] }).altered, false, 'a secret shorter than 4 characters is ignored, not scrubbed everywhere');
});

test('long strings, long arrays, deep nesting and cycles are cut with a marker', () => {
  const r = redact({ s: 'x'.repeat(30), a: [1, 2, 3, 4] }, { maxString: 10, maxItems: 2 });
  assert.deepEqual(r.value, { s: `${'x'.repeat(10)}…[cut 20 characters]`, a: [1, 2, '[cut 2 more items]'] });
  const cyc: Record<string, unknown> = { name: 'c' };
  cyc.self = cyc;
  assert.deepEqual(redact(cyc).value, { name: 'c', self: '[circular]' });
  assert.deepEqual(redact({ a: { b: { c: 1 } } }, { maxDepth: 2 }).value, { a: { b: '[too deep]' } });
});

test('the same object used twice is not mistaken for a cycle, and odd values are made safe', () => {
  const shared = { n: 1 };
  assert.deepEqual(redact({ a: shared, b: shared }).value, { a: { n: 1 }, b: { n: 1 } });
  const r = redact({ big: 10n, f: () => 1, d: new Date('2026-01-02T03:04:05Z') }).value as Record<string, unknown>;
  assert.equal(r.big, '10');
  assert.equal(r.f, undefined);
  assert.equal(r.d, '2026-01-02T03:04:05.000Z');
});

test('a run records its steps redacted as they are written, and finishes failed if a step failed', async () => {
  const c = clock();
  const log = new ExecutionLog({ now: c.now, id: ids(), redaction: { secrets: ['sk-live-12345'] } });
  const run = await log.start('invoice-sync', 'webhook');
  log.step(run.id, { name: 'fetch', input: { token: 'abc', id: 7 }, output: { body: 'key sk-live-12345 used' }, startedAt: c.now() });
  c.advance(500);
  log.step(run.id, { name: 'post', input: { id: 7 }, error: 'denied for sk-live-12345', startedAt: c.now() });
  const done = log.finish(run.id);
  assert.equal(done.status, 'failed');
  assert.deepEqual(done.steps.map((s) => [s.index, s.name, s.status, s.inputAltered, s.outputAltered]), [[0, 'fetch', 'success', true, true], [1, 'post', 'failed', false, false]]);
  assert.deepEqual(done.steps[0]!.input, { token: REDACTED, id: 7 });
  assert.equal(done.steps[1]!.error, `denied for ${REDACTED}`);
  assert.equal(done.finishedAt, '2026-11-01T00:00:00.500Z');
});

test('steps cannot be added to a finished run, and unknown runs are refused', async () => {
  const log = new ExecutionLog({ id: ids() });
  const run = await log.start('f', 't');
  log.finish(run.id);
  assert.throws(() => log.step(run.id, { name: 's', input: 1, startedAt: new Date() }), /already success/);
  assert.throws(() => log.get('nope'), NotFound);
  assert.equal(log.finish((await log.start('f', 't')).id, 'cancelled').status, 'cancelled');
});

test('listing is newest first and can be narrowed by flow and status', async () => {
  const c = clock();
  const log = new ExecutionLog({ now: c.now, id: ids() });
  for (const [flow, fail] of [['a', false], ['b', true], ['a', true]] as const) {
    const r = await log.start(flow, 't');
    if (fail) log.step(r.id, { name: 's', input: 0, error: 'x', startedAt: c.now() });
    log.finish(r.id);
    c.advance(1000);
  }
  assert.deepEqual(log.list().map((r) => r.id), ['r3', 'r2', 'r1']);
  assert.deepEqual(log.list({ flow: 'a' }).map((r) => r.id), ['r3', 'r1']);
  assert.deepEqual(log.list({ status: 'failed' }).map((r) => r.id), ['r3', 'r2']);
  assert.equal(log.list({ limit: 1 }).length, 1);
});

test('pruning by age keeps failed runs longer and pinned runs always, and says why', async () => {
  const c = clock();
  const log = new ExecutionLog({ now: c.now, id: ids() });
  const mk = async (fail: boolean) => { const r = await log.start('f', 't'); if (fail) log.step(r.id, { name: 's', input: 0, error: 'e', startedAt: c.now() }); log.finish(r.id); c.advance(1000); return r.id; };
  const ok = await mk(false);
  const failed = await mk(true);
  const pinned = await mk(false);
  log.pin(pinned);
  c.advance(10 * 3_600_000);
  const recent = await mk(false);
  const plan = log.prunePlan({ maxAgeMs: 5 * 3_600_000, keepFailedMs: 20 * 3_600_000 });
  assert.deepEqual(plan.map((p) => p.id), [ok]);
  assert.match(plan[0]!.reason, /success run older than 5 hours/);
  c.advance(11 * 3_600_000);
  assert.deepEqual(log.prunePlan({ maxAgeMs: 5 * 3_600_000, keepFailedMs: 20 * 3_600_000 }).map((p) => p.id).sort(), [failed, ok, recent].sort());
  assert.equal(log.get(pinned).pinned, true);
});

test('pruning by count per flow keeps the newest and leaves running runs and other flows alone', async () => {
  const c = clock();
  const log = new ExecutionLog({ now: c.now, id: ids() });
  const done: string[] = [];
  for (let i = 0; i < 4; i++) { const r = await log.start('f', 't'); log.finish(r.id); done.push(r.id); c.advance(1000); }
  const other = await log.start('g', 't'); log.finish(other.id);
  const running = await log.start('f', 't');
  const removed = await log.prune({ maxAgeMs: 1e12, maxPerFlow: 2 });
  assert.deepEqual(removed.map((r) => r.id).sort(), [done[0]!, done[1]!].sort());
  assert.ok(log.store.get(other.id) && log.store.get(running.id));
  assert.equal(log.list().length, 4);
});

test('starts, replays and prunes are written to the audit chain, which still verifies', async () => {
  const store = memoryAudit();
  const audit = new Audit(store);
  const log = new ExecutionLog({ audit, id: ids() });
  const r = await log.start('f', 'manual', 'ana');
  log.step(r.id, { name: 'a', input: 1, output: 2, startedAt: new Date() });
  log.finish(r.id);
  await log.replay(r.id, 0, async () => 3, { actor: 'ben' });
  await log.prune({ maxAgeMs: -1 }, 'ana');
  assert.deepEqual(store.entries.map((e) => [e.actor, e.action]), [['ana', 'run.start'], ['ben', 'run.start'], ['ben', 'run.replay'], ['ana', 'run.prune']]);
  assert.equal(await audit.verify(), null);
});

test('replay from a step reuses earlier outputs, re-executes the rest, and links back to the original', async () => {
  const c = clock();
  const log = new ExecutionLog({ now: c.now, id: ids() });
  const run = await log.start('f', 'webhook');
  log.step(run.id, { name: 'load', input: { id: 1 }, output: { n: 10 }, startedAt: c.now() });
  log.step(run.id, { name: 'double', input: { n: 10 }, output: { n: 21 }, startedAt: c.now() });
  log.step(run.id, { name: 'save', input: { n: 21 }, error: 'db down', startedAt: c.now() });
  log.finish(run.id);
  const calls: unknown[] = [];
  const again = await log.replay(run.id, 1, async (s) => { calls.push([s.name, s.input]); return { n: (s.input as { n: number }).n * 2 }; });
  assert.deepEqual(calls, [['double', { n: 10 }], ['save', { n: 20 }]]);
  assert.equal(again.status, 'success');
  assert.deepEqual(again.steps.map((s) => s.status), ['reused', 'success', 'success']);
  assert.deepEqual(again.replayOf, { run: run.id, fromStep: 1 });
  assert.equal(log.get(run.id).status, 'failed', 'the original is untouched');
});

test('replay stops at a failing step and the new run is failed', async () => {
  const log = new ExecutionLog({ id: ids() });
  const run = await log.start('f', 't');
  for (const n of ['a', 'b', 'c']) log.step(run.id, { name: n, input: 1, output: 1, startedAt: new Date() });
  log.finish(run.id);
  const again = await log.replay(run.id, 0, async (s) => { if (s.name === 'b') throw new Error('still broken'); return 1; });
  assert.equal(again.status, 'failed');
  assert.deepEqual(again.steps.map((s) => [s.name, s.status, s.error]), [['a', 'success', undefined], ['b', 'failed', 'still broken']]);
});

test('replay is refused from a step whose input was redacted, unless the input is supplied', async () => {
  const log = new ExecutionLog({ id: ids() });
  const run = await log.start('f', 't');
  log.step(run.id, { name: 'login', input: { password: 'p', user: 'u' }, output: 1, startedAt: new Date() });
  log.step(run.id, { name: 'next', input: 1, output: 2, startedAt: new Date() });
  log.finish(run.id);
  await assert.rejects(() => log.replay(run.id, 0, async () => 1), (e: unknown) => e instanceof NotReplayable && /redacted or cut/.test((e as Error).message));
  const ok = await log.replay(run.id, 0, async (s) => (s.index === 0 ? (s.input as { user: string }).user : 2), { input: { user: 'u', password: 'fresh' } });
  assert.equal(ok.steps[0]!.output, 'u');
  assert.deepEqual(ok.steps[0]!.input, { user: 'u', password: REDACTED }, 'the supplied secret is redacted in the new record too');
  const fine = await log.replay(run.id, 1, async () => 5);
  assert.equal(fine.status, 'success');
});

test('replay refuses unknown steps and runs that are still running', async () => {
  const log = new ExecutionLog({ id: ids() });
  const run = await log.start('f', 't');
  log.step(run.id, { name: 'a', input: 1, output: 1, startedAt: new Date() });
  await assert.rejects(() => log.replay(run.id, 0, async () => 1), /still running/);
  log.finish(run.id);
  await assert.rejects(() => log.replay(run.id, 5, async () => 1), /no step 5/);
  await assert.rejects(() => log.replay(run.id, -1, async () => 1), /no step -1/);
});

test('stored runs are copies: changing what you were handed does not change the record', async () => {
  const log = new ExecutionLog({ id: ids() });
  const run = await log.start('f', 't');
  log.step(run.id, { name: 'a', input: { x: 1 }, output: { y: 1 }, startedAt: new Date() });
  const got = log.get(run.id);
  (got.steps[0]!.input as { x: number }).x = 99;
  assert.deepEqual(log.get(run.id).steps[0]!.input, { x: 1 });
});
