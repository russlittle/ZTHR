import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Queue, backfill, cron } from './index.ts';

const setup = () => {
  let t = 0;
  const q = new Queue({ now: () => t, baseMs: 100, maxMs: 1000, random: () => 0.999 });
  return { q, tick: (ms: number) => (t += ms) };
};

test('a failing job retries with backoff, then waits as a dead letter until replayed after a fix', async () => {
  const { q, tick } = setup();
  let broken = true;
  q.handle('send', async () => {
    if (broken) throw new Error('mail server refused');
    return 'sent';
  });
  const j = q.enqueue('send', { to: 'ana' }, { maxAttempts: 3 });
  await q.tick();
  assert.equal(j.state, 'waiting');
  assert.equal(j.runAt, 99, 'the first retry waits up to the base delay');
  assert.equal(await q.tick(), 0, 'not due yet');
  tick(100);
  await q.tick();
  assert.equal(j.runAt, 100 + 199);
  tick(300);
  await q.tick();
  assert.equal(j.state, 'dead');
  assert.equal(j.lastError, 'mail server refused');
  broken = false;
  assert.equal(q.replay(), 1);
  await q.tick();
  assert.equal(j.state, 'done');
  assert.equal(j.result, 'sent');
});

test('a job with a key is enqueued once while it is pending', () => {
  const { q } = setup();
  const a = q.enqueue('thumb', { id: 1 }, { key: 'thumb:1' });
  const b = q.enqueue('thumb', { id: 1 }, { key: 'thumb:1' });
  assert.equal(a, b);
  assert.equal(q.jobs.size, 1);
});

test('a long task reports progress and stops when cancelled', async () => {
  const { q } = setup();
  let seen = 0;
  q.handle('export', async (_p, ctx) => {
    for (let i = 1; i <= 100; i++) {
      if (ctx.signal.aborted) throw new Error('stopped');
      ctx.progress(i, 100, 'rows');
      seen = i;
      if (i === 40) q.cancel(ctx.job.id);
      await Promise.resolve();
    }
  });
  const j = q.enqueue('export', {});
  await q.tick();
  assert.equal(j.state, 'cancelled');
  assert.deepEqual(j.progress, { done: 40, total: 100, note: 'rows' });
  assert.equal(seen, 40);
  assert.equal(q.enqueue('nobody', {}).state, 'waiting');
  await q.tick();
  assert.equal(q.dead()[0]!.lastError, 'no handler for nobody');
});

test('a backfill runs dry first, resumes from its checkpoint, and records failures without stopping', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, email: i % 5 === 0 ? 'X@Example.org' : 'x@example.org', bad: i === 7 }));
  const changed: number[] = [];
  const b = {
    page: async (after: string | undefined, size: number) => {
      const start = after ? Number(after) : 0;
      const items = rows.slice(start, start + size);
      return { items, ...(start + size < rows.length ? { next: String(start + size) } : {}) };
    },
    plan: async (r: (typeof rows)[number]) => {
      if (r.bad) throw new Error('unreadable row');
      return r.email !== r.email.toLowerCase() ? r.email.toLowerCase() : null;
    },
    apply: async (r: (typeof rows)[number]) => void changed.push(r.id),
  };
  const dry = await backfill(b, { dryRun: true, size: 10 });
  assert.deepEqual({ seen: dry.seen, changed: dry.changed, finished: dry.finished }, { seen: 25, changed: 5, finished: true });
  assert.equal(changed.length, 0, 'a dry run applies nothing');
  const ac = new AbortController();
  let saves = 0;
  const part = await backfill(b, { dryRun: false, size: 10, signal: ac.signal, save: async () => void (++saves === 1 && ac.abort()), idOf: (r) => String(r.id) });
  assert.equal(part.checkpoint, '10');
  const done = await backfill(b, { dryRun: false, size: 10, resume: part, idOf: (r) => String(r.id) });
  assert.equal(done.finished, true);
  assert.deepEqual(changed, [0, 5, 10, 15, 20]);
  assert.deepEqual(done.failed, [{ item: '7', error: 'unreadable row' }]);
});

test('cron: next run times, steps, ranges and the day-of-month or weekday rule', () => {
  assert.equal(cron('*/15 * * * *').next(new Date('2026-11-26T10:07:30Z')).toISOString(), '2026-11-26T10:15:00.000Z');
  assert.equal(cron('30 2 * * *').next(new Date('2026-11-26T03:00:00Z')).toISOString(), '2026-11-27T02:30:00.000Z');
  assert.equal(cron('0 9 * * 1-5').next(new Date('2026-11-27T10:00:00Z')).toISOString(), '2026-11-30T09:00:00.000Z', 'Friday after nine: Monday');
  assert.equal(cron('0 0 1 * 0').next(new Date('2026-11-26T00:00:00Z')).toISOString(), '2026-11-29T00:00:00.000Z', 'the 1st or any Sunday');
  assert.throws(() => cron('61 * * * *'), /not a valid cron field/);
  assert.throws(() => cron('* * *'), /five fields/);
});

test('a job cancelled while a tick is working through the list does not run, and overlapping ticks run each job once', async () => {
  const q = new Queue({ now: () => 0 });
  const ran: string[] = [];
  let second = '';
  q.handle('k', async (p) => {
    ran.push(String(p));
    if (p === 'a') q.cancel(second);
  });
  q.enqueue('k', 'a');
  second = q.enqueue('k', 'b').id;
  await q.tick();
  assert.deepEqual(ran, ['a'], 'b was cancelled before its turn');
  assert.equal(q.jobs.get(second)!.state, 'cancelled');
  const q2 = new Queue({ now: () => 0 });
  let n = 0;
  q2.handle('k', async () => {
    n++;
    await new Promise((r) => setTimeout(r, 5));
  });
  q2.enqueue('k', 1);
  q2.enqueue('k', 2);
  await Promise.all([q2.tick(), q2.tick()]);
  assert.equal(n, 2);
  assert.ok([...q2.jobs.values()].every((j) => j.attempts === 1));
});

test('cron: a 29 February schedule finds its next leap year, an impossible date is reported, and Sunday may be 7', () => {
  assert.equal(cron('0 0 29 2 *').next(new Date('2026-11-26T00:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z');
  assert.throws(() => cron('0 0 31 2 *').next(new Date('2026-11-26T00:00:00Z')), /never fires/);
  assert.equal(cron('0 9 * * 7').next(new Date('2026-11-26T00:00:00Z')).toISOString(), '2026-11-29T09:00:00.000Z');
  assert.throws(() => cron('-5 * * * *'), /not a valid cron field/);
  assert.throws(() => cron('1,,2 * * * *'), /not a valid cron field/);
  assert.throws(() => cron('*/0 * * * *'), /not a valid cron field/);
});

test('resuming a backfill that already finished does not walk everything again', async () => {
  let pages = 0;
  const b = { page: async () => (pages++, { items: [1, 2] }), plan: async () => 1, apply: async () => undefined };
  const done = await backfill(b, { dryRun: false });
  assert.equal(done.finished, true);
  const again = await backfill(b, { dryRun: false, resume: done });
  assert.equal(pages, 1);
  assert.equal(again.changed, 2);
});

test('cron: a day field written as */N counts as unrestricted for the either-day rule, as in Vixie cron', () => {
  // 2026-11-26 is a Thursday; 1 December 2026 is a Tuesday.
  assert.equal(cron('0 0 1 * */2').next(new Date('2026-11-26T00:00:00Z')).toISOString(), '2026-12-01T00:00:00.000Z', 'the 1st, on an even weekday');
  assert.equal(cron('0 0 */10 * 2').next(new Date('2026-11-26T00:00:00Z')).toISOString(), '2026-12-01T00:00:00.000Z', 'a Tuesday that is the 1st, 11th, 21st or 31st');
  assert.equal(cron('0 0 1 * 0').next(new Date('2026-11-26T00:00:00Z')).toISOString(), '2026-11-29T00:00:00.000Z', 'both restricted: either');
  assert.equal(cron('0 0 1-31 * 0').next(new Date('2026-11-26T00:00:00Z')).toISOString(), '2026-11-27T00:00:00.000Z', 'every day listed is still restricted, so either');
});

test('finished jobs are forgotten after the retention period; dead letters stay until replayed or dropped', async () => {
  let t = 0;
  const q = new Queue({ now: () => t, retainMs: 1000 });
  q.handle('ok', async () => 'fine');
  q.handle('bad', async () => {
    throw new Error('no');
  });
  const done = q.enqueue('ok', 1);
  const cancelled = q.enqueue('ok', 2, { runAt: 500 });
  q.cancel(cancelled.id);
  const dead = q.enqueue('bad', 3, { maxAttempts: 1 });
  const dead2 = q.enqueue('bad', 4, { maxAttempts: 1 });
  await q.tick();
  assert.equal(done.state, 'done');
  t = 999;
  assert.equal(q.sweep(), 0, 'still within the retention period');
  assert.equal(q.jobs.get(done.id)?.result, 'fine');
  t = 2000;
  await q.tick();
  assert.deepEqual([...q.jobs.keys()].sort(), [dead.id, dead2.id].sort(), 'a tick forgot the done and cancelled jobs');
  t = 1_000_000;
  assert.equal(q.sweep(), 0, 'dead letters are not forgotten by age');
  assert.equal(q.drop((j) => j.id === dead2.id), 1);
  assert.deepEqual(q.dead().map((j) => j.id), [dead.id]);
  assert.equal(q.replay(), 1);
  assert.equal(new Queue().sweep(), 0);
});
