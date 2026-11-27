import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backup, digest, drill, memoryStore, retain, type Backup, type Data } from './index.ts';

const data: Data = { users: [{ id: 1, name: 'Ana' }, { id: 2, name: 'Ben' }], files: [{ id: 'f1', owner: 1, size: 3 }] };

test('a drill restores into scratch and proves every collection matches, within the target time', async () => {
  const b = await backup(memoryStore(data), new Date('2026-11-24T02:00:00Z'));
  assert.equal(b.id, 'b-20261124T020000');
  const d = await drill(b, memoryStore(), { targetMs: 60_000 });
  assert.equal(d.ok, true);
  assert.deepEqual(d.collections.map((c) => [c.name, c.got, c.match]), [['users', 2, true], ['files', 1, true]]);
  assert.deepEqual(digest({ x: [{ a: 1, b: 2 }, { a: 3 }] }), digest({ x: [{ a: 3 }, { b: 2, a: 1 }] }), 'order does not matter');
});

test('a drill fails loudly when rows are lost, contents differ, the restore breaks, or it is too slow', async () => {
  const b = await backup(memoryStore(data), new Date('2026-11-24T02:00:00Z'));
  const lossy = memoryStore();
  lossy.load = async (d) => void (lossy.data = { users: [...d.users!.slice(0, 1)], files: d.files!.map((f) => ({ ...f, size: 4 })) });
  assert.deepEqual((await drill(b, lossy, { targetMs: 60_000 })).problems, ['users restored 1 of 2 rows', 'files restored 1 of 1 rows but the contents differ']);
  const broken = memoryStore();
  broken.load = async () => {
    throw new Error('disk full');
  };
  const bd = await drill(b, broken, { targetMs: 60_000 });
  assert.equal(bd.ok, false);
  assert.match(bd.problems[0]!, /disk full/);
  let t = 0;
  const slow = await drill(b, memoryStore(), { targetMs: 1000, now: () => (t += 1500) });
  assert.deepEqual(slow.problems, ['the restore took 1500 ms, over the 1000 ms target']);
});

test('retention keeps daily, weekly and monthly backups and says why', () => {
  const list: Backup[] = Array.from({ length: 60 }, (_, i) => {
    const at = new Date(Date.UTC(2026, 10, 26) - i * 86_400_000).toISOString();
    return { id: at.slice(0, 10), at, blob: '', digest: {} };
  });
  const r = retain(list, { days: 7, weeks: 4, months: 3 });
  const ids = r.keep.map((k) => k.id);
  assert.equal(ids.slice(0, 7).join(), '2026-11-26,2026-11-25,2026-11-24,2026-11-23,2026-11-22,2026-11-21,2026-11-20');
  assert.ok(ids.includes('2026-10-31'), 'newest of October');
  assert.ok(ids.includes('2026-09-30'), 'newest of September');
  assert.deepEqual(r.keep[0]!.why, ['daily 2026-11-26', 'weekly 2026-W48', 'monthly 2026-11']);
  assert.equal(r.keep.length + r.drop.length, 60);
  assert.ok(r.keep.length < 14);
});
