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
