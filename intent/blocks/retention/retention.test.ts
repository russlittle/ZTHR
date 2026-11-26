import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restore, sweep, trash, withDependents, type Item } from './index.ts';

const DAY = 86_400_000;
const items: Item[] = [
  { kind: 'student', id: 's1', createdAt: 0 },
  { kind: 'bill', id: 'b1', parents: [{ kind: 'student', id: 's1' }], createdAt: 0 },
  { kind: 'reminder', id: 'r1', parents: [{ kind: 'bill', id: 'b1' }], createdAt: 0 },
  { kind: 'bill', id: 'b2', createdAt: 0, closedAt: 0 },
];

test('a record goes to the trash with everything that depends on it, and comes back the same way', () => {
  assert.deepEqual(withDependents(items, { kind: 'student', id: 's1' }).map((x) => x.id).sort(), ['b1', 'r1', 's1']);
  const t = trash(items, { kind: 'student', id: 's1' }, 5);
  assert.deepEqual(t.filter((x) => x.trashedAt).map((x) => x.id).sort(), ['b1', 'r1', 's1']);
  const r = restore(t, { kind: 'student', id: 's1' });
  assert.equal(r.filter((x) => x.trashedAt).length, 0);
  assert.deepEqual(restore(items, { kind: 'bill', id: 'b2' }), items, 'restoring what is not in the trash changes nothing');
});

test('restore brings back only what went into the trash together', () => {
  const once = trash(items, { kind: 'reminder', id: 'r1' }, 1);
  const twice = trash(once, { kind: 'student', id: 's1' }, 2);
  const back = restore(twice, { kind: 'student', id: 's1' });
  assert.equal(back.find((x) => x.id === 'r1')!.trashedAt, 1, 'the reminder deleted on its own stays deleted');
});

test('the sweep says what to purge or archive, and why, and respects holds', () => {
  const policies = { bill: { keepDays: 365, then: 'archive' as const, trashDays: 30 }, reminder: { keepDays: 90, then: 'purge' as const, trashDays: 7 } };
  const now = 400 * DAY;
  const t = trash(items, { kind: 'reminder', id: 'r1' }, now - 8 * DAY);
  const plan = sweep([...t, { kind: 'bill', id: 'b3', createdAt: 0, closedAt: 0, hold: true }], policies, now);
  assert.deepEqual(plan.steps, [
    { kind: 'reminder', id: 'r1', action: 'purge', why: 'in the trash 7 days' },
    { kind: 'bill', id: 'b2', action: 'archive', why: 'closed more than 365 days' },
  ]);
  assert.equal(plan.held, 1);
  assert.deepEqual(plan.noPolicy, ['student'], 'a kind with no policy is named, never swept by default');
});
