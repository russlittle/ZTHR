import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksum, memoryLedger, migrate, plan, type Migration } from './index.ts';

type Db = { users: { id: number; name: string; display?: string }[] };
const m1: Migration<Db> = { id: '2026-11-01-add-display', description: 'display name from name', up: async (db) => db.users.forEach((u) => (u.display = u.name)), verify: async (db) => db.users.every((u) => u.display !== undefined) || 'some users have no display name' };
const m2: Migration<Db> = { id: '2026-11-15-trim', description: 'trim names', up: async (db) => db.users.forEach((u) => (u.name = u.name.trim())) };

test('runs pending migrations once, in order, verifies them, and records checksums', async () => {
  const db: Db = { users: [{ id: 1, name: ' Ana ' }] };
  const l = memoryLedger();
  const dry = await migrate(db, [m1, m2], l, { owner: 'a', dryRun: true });
  assert.deepEqual(dry, { ran: [], pending: ['2026-11-01-add-display', '2026-11-15-trim'], problems: [] });
  assert.equal(db.users[0]!.display, undefined, 'a dry run touches nothing');
  assert.deepEqual((await migrate(db, [m1, m2], l, { owner: 'a' })).ran, ['2026-11-01-add-display', '2026-11-15-trim']);
  assert.deepEqual(db.users[0], { id: 1, name: 'Ana', display: ' Ana ' });
  assert.equal(l.rows[0]!.checksum, checksum(m1 as Migration<unknown>));
  assert.deepEqual((await migrate(db, [m1, m2], l, { owner: 'b' })).ran, [], 'nothing runs twice');
});

test('an edited applied migration, a missing one, or one out of order is refused', async () => {
  const l = memoryLedger();
  await migrate({ users: [] }, [m1], l, { owner: 'a' });
  const edited: Migration<Db> = { ...m1, up: async (db) => db.users.forEach((u) => (u.display = u.name.toUpperCase())) };
  assert.deepEqual(plan([edited], l.rows).problems, ['2026-11-01-add-display was changed after it was applied; add a new migration instead']);
  assert.deepEqual(plan([], l.rows).problems, ['2026-11-01-add-display was applied but is no longer in the code']);
  const early: Migration<Db> = { id: '2026-10-01-late-arrival', description: '', up: async () => {} };
  assert.deepEqual(plan([early, m1], l.rows).problems, ['2026-10-01-late-arrival sorts before 2026-11-01-add-display, which is already applied']);
  assert.deepEqual(plan([m2, m1], []).problems, ['migrations must be listed in id order']);
});

test('a failed verify stops the run and is not recorded; two runners never migrate at once', async () => {
  const l = memoryLedger();
  const bad: Migration<Db> = { id: '2026-11-01-bad', description: '', up: async () => {}, verify: async () => 'row count fell from 10 to 9' };
  const r = await migrate({ users: [] }, [bad, m2], l, { owner: 'a' });
  assert.deepEqual(r.failed, { id: '2026-11-01-bad', error: 'row count fell from 10 to 9' });
  assert.deepEqual(r.pending, ['2026-11-01-bad', '2026-11-15-trim']);
  assert.equal(l.rows.length, 0);
  await l.lock('other', 60_000);
  assert.deepEqual((await migrate({ users: [] }, [m2], l, { owner: 'a' })).problems, ['another runner is migrating; this one waits']);
});

test('a runner that read the ledger before another runner finished does not apply the same migration again', async () => {
  const l = memoryLedger();
  let runs = 0;
  const once: Migration<Db> = { id: '2026-11-20-once', description: 'counts its runs', up: async () => void runs++ };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reads = 0;
  const late = { ...l, applied: async () => {
    const a = await l.applied();
    if (reads++ === 0) await gate;
    return a;
  } };
  const b = migrate({ users: [] }, [once], late, { owner: 'b' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((await migrate({ users: [] }, [once], l, { owner: 'a' })).ran, ['2026-11-20-once']);
  release();
  const rb = await b;
  assert.equal(runs, 1, 'applied once');
  assert.deepEqual(rb.ran, []);
  assert.equal(l.rows.length, 1);
});

test('the lease is released even when the ledger fails to record', async () => {
  const l = memoryLedger();
  const broken = { ...l, record: async () => { throw new Error('ledger offline'); } };
  await assert.rejects(migrate({ users: [] }, [m2], broken, { owner: 'a' }), /ledger offline/);
  assert.equal(await l.lock('b', 1000), true);
});

test('the lease is renewed between steps, so a second runner cannot take it while a slow run is still going', async () => {
  let clock = 0;
  const l = memoryLedger(() => clock);
  let stolen: boolean | undefined;
  const slow1: Migration<Db> = { id: '2026-11-21-a', description: '', up: async () => void (clock += 800) };
  const slow2: Migration<Db> = { id: '2026-11-22-b', description: '', up: async () => {
    clock += 400;
    stolen = await l.lock('b', 1000);
    clock += 400;
  } };
  const r = await migrate({ users: [] }, [slow1, slow2], l, { owner: 'a', lockMs: 1000, now: () => clock });
  assert.equal(stolen, false, 'the lease taken at 0 for 1000 ms was renewed at 800, so at 1200 it is still held');
  assert.deepEqual(r.ran, ['2026-11-21-a', '2026-11-22-b']);
});

test('a long step keeps the lease with renew; a runner whose lease was lost stops and records nothing more', async () => {
  let clock = 0;
  const l = memoryLedger(() => clock);
  let stolen: boolean | undefined;
  const long: Migration<Db> = { id: '2026-11-21-long', description: '', up: async (_db, lease) => {
    for (let i = 0; i < 5; i++) {
      clock += 800;
      await lease.renew();
    }
    stolen = await l.lock('b', 1000);
  } };
  assert.deepEqual((await migrate({ users: [] }, [long], l, { owner: 'a', lockMs: 1000, now: () => clock })).ran, ['2026-11-21-long']);
  assert.equal(stolen, false);

  clock = 0;
  const l2 = memoryLedger(() => clock);
  let after = 0;
  const lost: Migration<Db> = { id: '2026-11-21-lost', description: '', up: async () => {
    clock += 1500;
    assert.equal(await l2.lock('b', 60_000), true, 'the lease ran out and another runner took it');
  } };
  const next: Migration<Db> = { id: '2026-11-22-next', description: '', up: async () => void after++ };
  const r = await migrate({ users: [] }, [lost, next], l2, { owner: 'a', lockMs: 1000, now: () => clock });
  assert.equal(after, 0, 'the next step does not run without the lock');
  assert.deepEqual(r.ran, []);
  assert.deepEqual(r.pending, ['2026-11-21-lost', '2026-11-22-next']);
  assert.deepEqual(r.problems, ['the migration lock was lost to another runner while running 2026-11-21-lost; this one stopped']);
  assert.equal(l2.rows.length, 0, 'the runner that lost the lock records nothing');
  assert.equal(await l2.lock('a', 1000), false, 'and it did not release the other runner’s lock');

  clock = 0;
  const l3 = memoryLedger(() => clock);
  const renewsTooLate: Migration<Db> = { id: '2026-11-21-late', description: '', up: async (_db, lease) => {
    clock += 1500;
    await l3.lock('b', 60_000);
    await lease.renew();
    after++;
  } };
  const r3 = await migrate({ users: [] }, [renewsTooLate], l3, { owner: 'a', lockMs: 1000, now: () => clock });
  assert.deepEqual(r3.failed, { id: '2026-11-21-late', error: 'the migration lock was lost to another runner' });
  assert.equal(after, 0, 'a failed renew stops the step');
});
