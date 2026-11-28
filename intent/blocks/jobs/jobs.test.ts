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

test('the delay before a retry is capped by maxMs, and by an hour when none is given', async () => {
  const q = new Queue({ now: () => t, baseMs: 100, maxMs: 150, random: () => 0.999 });
  let t = 0;
  q.handle('k', async () => {
    throw new Error('no');
  });
  const j = q.enqueue('k', 0, { maxAttempts: 9 });
  await q.tick();
  assert.equal(j.runAt, 99);
  t = j.runAt;
  await q.tick();
  assert.equal(j.runAt - t, 149, 'the second retry would wait up to 200, but the cap is 150');

  let u = 0;
  const q2 = new Queue({ now: () => u, random: () => 0.5 });
  q2.handle('k', async () => {
    throw new Error('no');
  });
  const k = q2.enqueue('k', 0, { maxAttempts: 20 });
  await q2.tick();
  assert.equal(k.runAt - u, 500, 'the default base is one second');
  for (let i = 2; i <= 13; i++) {
    u = k.runAt;
    await q2.tick();
  }
  assert.equal(k.attempts, 13);
  assert.equal(k.runAt - u, 1_800_000, 'by the thirteenth attempt the delay is capped at an hour, halved by the jitter');
});

test('the first tick forgets what finished long ago, and ticks sweep no more often than the interval', async () => {
  let t = 0;
  const q = new Queue({ now: () => t, retainMs: 1000 });
  const old = q.enqueue('k', 1, { runAt: 10_000 });
  q.cancel(old.id);
  t = 2000;
  assert.equal(await q.tick(), 0);
  assert.equal(q.jobs.size, 0, 'the very first tick sweeps');

  t = 0;
  const q2 = new Queue({ now: () => t, retainMs: 1000 });
  const c = q2.enqueue('k', 1, { runAt: 10_000 });
  q2.cancel(c.id);
  t = 500;
  await q2.tick();
  assert.ok(q2.jobs.has(c.id), 'only 500 old');
  t = 1000;
  await q2.tick();
  assert.ok(q2.jobs.has(c.id), 'old enough, but the last sweep was 500 ago and the interval is 1000');
  t = 1500;
  await q2.tick();
  assert.equal(q2.jobs.has(c.id), false, 'a full interval after the last sweep');
});

test('sweep counts what it forgets and forgets a job exactly when the retention period has passed since it finished', () => {
  let t = 500;
  const q = new Queue({ now: () => t, retainMs: 1000 });
  const a = q.enqueue('k', 1, { runAt: 99_999 });
  q.cancel(a.id);
  t = 600;
  const b = q.enqueue('k', 2, { runAt: 99_999 });
  q.cancel(b.id);
  t = 1499;
  assert.equal(q.sweep(), 0, 'one millisecond short for the first');
  t = 1500;
  assert.equal(q.sweep(), 1, 'exactly the retention period');
  assert.deepEqual([...q.jobs.keys()], [b.id]);
  t = 1600;
  assert.equal(q.sweep(), 1);
  assert.equal(q.jobs.size, 0);
});

test('a key is held by a waiting or running job of the same kind and released when the job finishes', async () => {
  const { q } = setup();
  const a = q.enqueue('thumb', 1, { key: 'k' });
  assert.equal(a.id, 'job-1');
  const other = q.enqueue('thumb', 1, { key: 'k2' });
  assert.notEqual(other, a, 'another key is another job');
  assert.equal(other.id, 'job-2');
  assert.notEqual(q.enqueue('resize', 1, { key: 'k' }), a, 'the same key under another kind is another job');
  assert.equal(q.enqueue('thumb', 2).state, 'waiting');
  assert.notEqual(q.enqueue('thumb', 2), q.enqueue('thumb', 2), 'without a key nothing is merged');

  const r = setup().q;
  let inside: unknown;
  let mine: unknown;
  r.handle('t', async (_p, ctx) => {
    mine = ctx.job;
    assert.equal(ctx.job.state, 'running');
    inside = r.enqueue('t', 0, { key: 'k' });
  });
  const first = r.enqueue('t', 0, { key: 'k' });
  await r.tick();
  assert.equal(inside, mine, 'asked for again while it runs: the running job');
  assert.equal(first.state, 'done');
  const again = r.enqueue('t', 0, { key: 'k' });
  assert.notEqual(again, first, 'a finished job no longer holds its key');
  assert.equal(again.state, 'waiting');

  const d = setup().q;
  d.handle('t', async () => {
    throw new Error('x');
  });
  const dead = d.enqueue('t', 0, { key: 'k', maxAttempts: 1 });
  await d.tick();
  assert.equal(dead.state, 'dead');
  assert.notEqual(d.enqueue('t', 0, { key: 'k' }), dead, 'a dead letter does not hold its key');

  const c = setup().q;
  const gone = c.enqueue('t', 0, { key: 'k' });
  c.cancel(gone.id);
  assert.notEqual(c.enqueue('t', 0, { key: 'k' }), gone, 'a cancelled job does not hold its key');
});

test('due lists only waiting jobs whose time has come, earliest first, ties by when they were added', () => {
  let t = 0;
  const q = new Queue({ now: () => t });
  const late = q.enqueue('k', 0, { runAt: 30 });
  t = 5;
  const early = q.enqueue('k', 0, { runAt: 10 });
  t = 7;
  const mid = q.enqueue('k', 0, { runAt: 20 });
  const future = q.enqueue('k', 0, { runAt: 1000 });
  const cancelled = q.enqueue('k', 0, { runAt: 5 });
  q.cancel(cancelled.id);
  t = 100;
  assert.deepEqual(q.due().map((j) => j.id), [early.id, mid.id, late.id]);
  assert.equal(q.due().includes(future), false);

  const q2 = new Queue({ now: () => t });
  t = 100;
  const x = q2.enqueue('k', 0, { runAt: 0 });
  t = 50;
  const y = q2.enqueue('k', 0, { runAt: 0 });
  assert.deepEqual(q2.due().map((j) => j.id), [y.id, x.id], 'same time: the one added first by the clock');
});

test('tick counts the jobs it ran, not those it skipped, and a skipped job stays as it was', async () => {
  const q = new Queue({ now: () => 0 });
  let second = '';
  q.handle('k', async (p) => {
    if (p === 'a') q.cancel(second);
  });
  q.enqueue('k', 'a');
  second = q.enqueue('k', 'b').id;
  assert.equal(await q.tick(), 1, 'b was cancelled before its turn');

  const q2 = new Queue({ now: () => 0 });
  q2.handle('k', async (p) => {
    if (p === 'a') q2.jobs.get(later)!.runAt = 5000;
  });
  q2.enqueue('k', 'a');
  const later = q2.enqueue('k', 'b').id;
  assert.equal(await q2.tick(), 1, 'b was put off before its turn');
  assert.equal(q2.jobs.get(later)!.state, 'waiting');
  assert.equal(q2.jobs.get(later)!.attempts, 0);

  const q3 = new Queue({ now: () => 0 });
  q3.enqueue('nobody', 1);
  q3.enqueue('nobody', 2);
  assert.equal(await q3.tick(), 2, 'a job with no handler is dealt with, so it counts');
  assert.equal(q3.dead().length, 2);
  assert.equal(await q3.tick(), 0);

  const q4 = new Queue({ now: () => 0 });
  q4.handle('k', async () => 1);
  q4.enqueue('k', 1);
  q4.enqueue('k', 2);
  q4.enqueue('k', 3);
  assert.equal(await q4.tick(), 3);
});

test('progress reports only what it was given', async () => {
  const q = new Queue({ now: () => 0 });
  const seen: unknown[] = [];
  q.handle('k', async (_p, ctx) => {
    ctx.progress(5);
    seen.push({ ...ctx.job.progress });
    ctx.progress(6, 10);
    seen.push({ ...ctx.job.progress });
    ctx.progress(7, undefined, 'rows');
    seen.push({ ...ctx.job.progress });
    ctx.progress(8, 10, '');
    seen.push({ ...ctx.job.progress });
  });
  q.enqueue('k', 0);
  await q.tick();
  assert.deepEqual(seen, [{ done: 5 }, { done: 6, total: 10 }, { done: 7, note: 'rows' }, { done: 8, total: 10 }]);
});

test('cancel: a waiting job is cancelled, a running one is asked to stop, and finished or unknown ones cannot be', async () => {
  const q = new Queue({ now: () => 0 });
  assert.equal(q.cancel('nope'), false);
  const w = q.enqueue('k', 0);
  assert.equal(q.cancel(w.id), true);
  assert.equal(w.state, 'cancelled');
  assert.equal(w.finished, 0);

  let t = 0;
  const q2 = new Queue({ now: () => t });
  let asked = false;
  q2.handle('k', async (p, ctx) => {
    if (p === 'stop') {
      asked = q2.cancel(ctx.job.id);
      t = 77;
      return 'finished anyway';
    }
    return 'ok';
  });
  const s = q2.enqueue('k', 'stop');
  const ok = q2.enqueue('k', 'go');
  await q2.tick();
  assert.equal(asked, true);
  assert.equal(s.state, 'cancelled', 'it was asked to stop, and it did not matter that it returned a result');
  assert.equal(s.finished, 77);
  assert.equal(ok.state, 'done');
  assert.equal(q2.cancel(ok.id), false, 'a done job is not running any more');
  assert.equal(q2.cancel(s.id), false);

  const q3 = new Queue({ now: () => 0 });
  const nb = q3.enqueue('nobody', 0);
  await q3.tick();
  assert.equal(nb.state, 'dead');
  assert.equal(q3.cancel(nb.id), false);
});

test('drop and replay take every dead letter, or only those a filter chooses', async () => {
  const q = new Queue({ now: () => 0 });
  const a = q.enqueue('nobody', 'a');
  const b = q.enqueue('nobody', 'b');
  const c = q.enqueue('nobody', 'c');
  await q.tick();
  assert.equal(q.dead().length, 3);
  assert.equal(q.replay((j) => j.id === a.id), 1);
  assert.deepEqual([a.state, b.state, c.state], ['waiting', 'dead', 'dead']);
  assert.equal(a.attempts, 0);
  assert.equal('finished' in a, false);
  assert.equal(q.drop((j) => j.id === b.id), 1);
  assert.deepEqual([...q.jobs.keys()].sort(), [a.id, c.id].sort());
  assert.equal(q.drop(), 1, 'with no filter, every dead letter');
  assert.equal(q.jobs.size, 1);
  assert.equal(q.drop(), 0);
});

test('a finished backfill has no checkpoint left', async () => {
  const b = { page: async () => ({ items: [1, 2] }), plan: async () => 1, apply: async () => undefined };
  const done = await backfill(b, { dryRun: false });
  assert.deepEqual(done, { seen: 2, changed: 2, failed: [], finished: true });
  const paged = await backfill({ ...b, page: async (after: string | undefined) => (after === undefined ? { items: [1], next: 'p2' } : { items: [2] }) }, { dryRun: true });
  assert.deepEqual(paged, { seen: 2, changed: 2, failed: [], finished: true });
});

test('cron: fields are checked strictly, and spacing around them does not matter', () => {
  assert.throws(() => cron('1-2-3 * * * *'), /not a valid cron field/);
  assert.throws(() => cron('*/2/3 * * * *'), /not a valid cron field/);
  assert.throws(() => cron('1x * * * *'), /not a valid cron field/);
  assert.throws(() => cron('* * 0 * *'), /not a valid cron field/);
  assert.throws(() => cron('* * * 0 *'), /not a valid cron field/);
  assert.throws(() => cron('* 24 * * *'), /not a valid cron field/);
  assert.throws(() => cron('* * * * 8'), /not a valid cron field/);
  assert.throws(() => cron('5-3 * * * *'), /not a valid cron field/, 'a range runs upwards');
  assert.throws(() => cron(`*/${'9'.repeat(400)} * * * *`), /not a valid cron field/, 'a step too large to be a number');
  const from = new Date('2026-11-26T10:07:30Z');
  assert.equal(cron('10-20/5 * * * *').next(from).toISOString(), '2026-11-26T10:10:00.000Z');
  assert.equal(cron('10-20/5 * * * *').next(new Date('2026-11-26T10:10:00Z')).toISOString(), '2026-11-26T10:15:00.000Z');
  assert.equal(cron('  \t0   12 *\t* *  ').next(from).toISOString(), '2026-11-26T12:00:00.000Z');
  assert.equal(cron('50-59 * * * *').next(from).toISOString(), '2026-11-26T10:50:00.000Z', 'a range of two-digit numbers');
});

test('cron: next is strictly after the time given, to the minute', () => {
  const every = cron('*/15 * * * *');
  assert.equal(every.next(new Date('2026-11-26T10:15:00Z')).toISOString(), '2026-11-26T10:30:00.000Z');
  assert.equal(every.next(new Date('2026-11-26T10:15:30Z')).toISOString(), '2026-11-26T10:30:00.000Z');
  assert.equal(every.next(new Date('2026-11-26T10:14:59.999Z')).toISOString(), '2026-11-26T10:15:00.000Z');
});

test('cron: matches says whether one moment is a time the schedule fires', () => {
  const c = cron('30 14 15 6 *');
  assert.equal(c.matches(new Date('2026-06-15T14:30:00Z')), true);
  assert.equal(c.matches(new Date('2026-06-15T14:31:00Z')), false, 'wrong minute');
  assert.equal(c.matches(new Date('2026-06-15T15:30:00Z')), false, 'wrong hour');
  assert.equal(c.matches(new Date('2026-07-15T14:30:00Z')), false, 'wrong month');
  assert.equal(c.matches(new Date('2026-05-15T14:30:00Z')), false, 'the month before');
  assert.equal(c.matches(new Date('2026-06-16T14:30:00Z')), false, 'wrong day');
  assert.equal(c.matches(new Date('2026-06-16T15:31:00Z')), false);
  assert.equal(c.matches(new Date('2026-06-15T15:31:00Z')), false, 'only the day is right');
  assert.equal(cron('0 0 1 1 *').matches(new Date('2027-01-01T00:00:00Z')), true, 'January');
});

test('cron: a day-of-month field starting with * is unrestricted, so the weekday must also match', () => {
  // From 2 December 2026: Tuesdays that fall on the 1st, 11th, 21st or 31st; 11 May 2027 is the first.
  assert.equal(cron('0 0 */10 * 2').next(new Date('2026-12-02T00:00:00Z')).toISOString(), '2027-05-11T00:00:00.000Z');
  assert.equal(cron('0 0 1 * */2').next(new Date('2026-12-02T00:00:00Z')).toISOString(), '2027-04-01T00:00:00.000Z', 'the 1st, on an even weekday');
});
