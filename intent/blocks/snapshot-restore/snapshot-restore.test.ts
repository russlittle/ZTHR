import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest, memoryStore } from '../backups/index.ts';
import type { Data } from '../backups/index.ts';
import { SnapshotError, SnapshotLog, applyPlan, deserialize, diff, matchesSnapshot, planRestore, serialize, snapshotOf, takeSnapshot, verifySnapshot } from './index.ts';

const T = (s: string) => new Date(`2026-11-${s}T10:00:00Z`);
const base = (): Record<string, Record<string, unknown>[]> => ({
  users: [{ id: 'u1', name: 'Ana', role: 'admin', updatedAt: '2026-11-01' }, { id: 'u2', name: 'Bo', role: 'user', updatedAt: '2026-11-01' }, { id: 'u3', name: 'Cy', role: 'user', updatedAt: '2026-11-01' }],
  posts: [{ id: 1, author: 'u1', title: 'Hello' }, { id: 2, author: 'u2', title: 'World' }],
  sessions: [{ id: 's1', token: 'secret' }],
});
const KEYS = {};

test('a snapshot keeps every row by key with its hash, and its collection hash is the backups block digest', () => {
  const s = snapshotOf(base(), { at: T('01'), id: 'a' });
  assert.deepEqual(Object.keys(s.collections).sort(), ['posts', 'sessions', 'users']);
  assert.deepEqual(Object.keys(s.collections.users!.rows), ['u1', 'u2', 'u3']);
  assert.deepEqual(Object.keys(s.collections.posts!.rows), ['1', '2'], 'numeric keys are kept as text');
  assert.deepEqual(s.collections.users!.digest, digest(base()).users);
  assert.match(s.root, /^[0-9a-f]{64}$/);
  assert.equal(s.at, '2026-11-01T10:00:00.000Z');
  assert.equal(snapshotOf(base(), { at: T('01'), id: 'a' }).root, s.root, 'the same data gives the same root');
  const reordered = base();
  reordered.users = [...reordered.users!].reverse();
  assert.equal(snapshotOf(reordered, { at: T('01'), id: 'a' }).root, s.root, 'row order does not matter');
});

test('exclusions and omitted fields keep secrets and noise out of a snapshot', () => {
  const s = snapshotOf(base(), { at: T('01'), exclude: ['sessions'], omitFields: ['users.role'] });
  assert.equal('sessions' in s.collections, false);
  assert.equal(JSON.stringify(s).includes('secret'), false);
  assert.equal('role' in s.collections.users!.rows.u1!, false);
  assert.equal(verifySnapshot(s).ok, true);
});

test('rows must have a unique usable key, and the key field can be named', () => {
  assert.throws(() => snapshotOf({ t: [{ name: 'x' }] }, { at: T('01') }), /no usable id/);
  assert.throws(() => snapshotOf({ t: [{ id: 1 }, { id: '1' }] }, { at: T('01') }), /two rows with id 1/);
  assert.throws(() => snapshotOf({ t: [{ id: { a: 1 } }] }, { at: T('01') }), SnapshotError);
  const s = snapshotOf({ t: [{ code: 'A', v: 1 }] }, { at: T('01'), keys: { t: 'code' } });
  assert.deepEqual(Object.keys(s.collections.t!.rows), ['A']);
});

test('verification finds an edited row, a changed hash and a changed root; deserialising refuses all of them', () => {
  const s = snapshotOf(base(), { at: T('01') });
  assert.deepEqual(verifySnapshot(s), { ok: true, problems: [] });
  const edited = JSON.parse(serialize(s));
  edited.collections.users.rows.u1.role = 'owner';
  assert.match(verifySnapshot(edited).problems[0]!, /users: row u1 does not match its hash/);
  assert.throws(() => deserialize(JSON.stringify(edited)), /damaged/);
  const rehashed = JSON.parse(serialize(s));
  rehashed.collections.users.rows.u1.role = 'owner';
  rehashed.collections.users.hashes.u1 = 'x';
  assert.equal(verifySnapshot(rehashed).ok, false);
  const dropped = JSON.parse(serialize(s));
  delete dropped.collections.users.rows.u3;
  delete dropped.collections.users.hashes.u3;
  assert.match(verifySnapshot(dropped).problems.join(), /collection hash does not match/);
  const root = JSON.parse(serialize(s));
  root.root = '0'.repeat(64);
  assert.match(verifySnapshot(root).problems.join(), /root hash/);
  assert.deepEqual(deserialize(serialize(s)).root, s.root);
  assert.throws(() => deserialize('not json'), /not a snapshot/);
  assert.throws(() => deserialize('{"id":1}'), /not a snapshot/);
});

test('diff lists added, removed and changed rows with the fields that changed', () => {
  const a = snapshotOf(base(), { at: T('01') });
  const next = base();
  next.users = [{ id: 'u1', name: 'Ana', role: 'owner', updatedAt: '2026-11-01', extra: 1 }, { id: 'u2', name: 'Bo', role: 'user', updatedAt: '2026-11-01' }, { id: 'u4', name: 'Di', role: 'user', updatedAt: '2026-11-02' }];
  next.posts = [];
  delete (next as Record<string, unknown>).sessions;
  (next as Record<string, unknown>).tags = [{ id: 't' }];
  const d = diff(a, snapshotOf(next, { at: T('02') }));
  assert.deepEqual(d.collections.users, { added: ['u4'], removed: ['u3'], changed: [{ key: 'u1', fields: [{ field: 'extra', from: undefined, to: 1 }, { field: 'role', from: 'admin', to: 'owner' }] }], unchanged: 1 });
  assert.deepEqual(d.collections.posts, { added: [], removed: ['1', '2'], changed: [], unchanged: 0 });
  assert.deepEqual([d.onlyInFrom, d.onlyInTo, d.totals, d.identical], [['sessions'], ['tags'], { added: 1, removed: 3, changed: 1 }, false]);
  assert.equal(diff(a, a).identical, true);
});

test('replace restore: inserts what is missing, reverts what changed, deletes what was added, and says how much is at risk', () => {
  const snap = snapshotOf(base(), { at: T('01') });
  const now = base();
  now.users = [{ id: 'u1', name: 'Ana', role: 'owner', updatedAt: '2026-11-05' }, { id: 'u2', name: 'Bo', role: 'user', updatedAt: '2026-11-01' }, { id: 'u9', name: 'New', role: 'user', updatedAt: '2026-11-05' }];
  const p = planRestore(snap, now, KEYS, { mode: 'replace', collections: ['users'] });
  assert.deepEqual(p.ops.map((o) => `${o.op}:${o.key}`), ['update:u1', 'insert:u3', 'delete:u9']);
  assert.deepEqual(p.ops.find((o) => o.op === 'update')!.fields, [{ field: 'role', from: 'owner', to: 'admin' }, { field: 'updatedAt', from: '2026-11-05', to: '2026-11-01' }]);
  assert.deepEqual([p.totals, p.rowsAtRisk, p.destructive], [{ insert: 1, update: 1, delete: 1 }, 2, true]);
  assert.deepEqual(digest({ users: p.result.users! }).users, snap.collections.users!.digest, 'the planned result is exactly the snapshot');
  assert.deepEqual(p.result.posts, now.posts, 'collections not chosen are untouched');
  assert.deepEqual(p.result.sessions, now.sessions);
  assert.match(p.warnings.join('|'), /users: 1 deleted and 1 overwritten of 3 current rows/);
});

test('merge keeps newer rows, missing-only brings back only deleted rows, and an untouched collection plans nothing', () => {
  const snap = snapshotOf(base(), { at: T('01') });
  const now = base();
  now.users = [{ id: 'u1', name: 'Ana Maria', role: 'admin', updatedAt: '2026-11-09' }, { id: 'u2', name: 'Bo', role: 'admin', updatedAt: '2026-10-01' }, { id: 'u9', name: 'New', role: 'user' }];
  const merge = planRestore(snap, now, KEYS, { mode: 'merge', collections: ['users'] });
  assert.deepEqual(merge.ops.map((o) => `${o.op}:${o.key}`), ['update:u2', 'insert:u3'], 'u1 is newer now and stays; u9 stays');
  assert.equal(merge.totals.delete, 0);
  const missing = planRestore(snap, now, KEYS, { mode: 'missing', collections: ['users'] });
  assert.deepEqual(missing.ops.map((o) => `${o.op}:${o.key}`), ['insert:u3']);
  assert.equal(missing.destructive, false);
  const same = planRestore(snap, base(), KEYS, { mode: 'replace' });
  assert.deepEqual([same.ops.length, same.destructive, same.rowsAtRisk], [0, false, 0]);
});

test('a plan warns about references the result would leave dangling, and fields a restore would drop', () => {
  const snap = snapshotOf(base(), { at: T('01') });
  const now = base();
  now.posts = [...now.posts!, { id: 3, author: 'u9', title: 'Orphan' }];
  now.users = [...now.users!, { id: 'u9', name: 'Zed', role: 'user', updatedAt: 'x', nickname: 'z' }];
  const p = planRestore(snap, now, KEYS, { mode: 'replace', collections: ['users'], references: { 'posts.author': 'users' } });
  assert.match(p.warnings.join('|'), /1 row\(s\) in posts would point at a missing users through author/);
  const q = planRestore(snapshotOf({ users: [{ id: 'u1', name: 'A' }] }, { at: T('01') }), { users: [{ id: 'u1', name: 'B', nick: 'b' }] }, KEYS, { mode: 'replace' });
  assert.match(q.warnings.join('|'), /drops the field\(s\) nick/);
});

test('plans refuse damaged snapshots, unknown collections and a changed key field', () => {
  const snap = snapshotOf(base(), { at: T('01') });
  const bad = JSON.parse(serialize(snap));
  bad.collections.users.rows.u1.name = 'X';
  assert.throws(() => planRestore(bad, base(), KEYS, { mode: 'replace' }), /damaged/);
  assert.throws(() => planRestore(snap, base(), KEYS, { mode: 'replace', collections: ['nope'] }), /no collection nope/);
  assert.throws(() => planRestore(snap, base(), { users: 'email' }, { mode: 'replace' }), /keyed by email now/);
  const created = planRestore(snap, {}, KEYS, { mode: 'replace', collections: ['posts'] });
  assert.match(created.warnings[0]!, /posts does not exist in the current data/);
  assert.equal(created.totals.insert, 2);
});

test('applying: a destructive plan needs its own confirmation, a safety snapshot is taken, and the store is verified after', async () => {
  const store = memoryStore(base());
  const snap = snapshotOf(base(), { at: T('01') });
  store.data.users = [{ id: 'u1', name: 'Hacked', role: 'owner', updatedAt: 'z' }, { id: 'u5', name: 'Five', role: 'user' }];
  const current = await store.dump();
  const plan = planRestore(snap, current, KEYS, { mode: 'replace', collections: ['users'] });
  assert.equal(plan.destructive, true);
  await assert.rejects(applyPlan(plan, store, KEYS, { at: T('03'), basedOn: current }), /pass its confirmation code/);
  await assert.rejects(applyPlan(plan, store, KEYS, { at: T('03'), confirm: 'wrong', basedOn: current }), /confirmation code/);
  assert.deepEqual((await store.dump()).users, current.users, 'nothing was written');
  const done = await applyPlan(plan, store, KEYS, { at: T('03'), confirm: plan.confirmation, basedOn: current });
  assert.deepEqual([done.verified, done.mismatches], [true, []]);
  assert.equal(matchesSnapshot(snap, await store.dump(), ['users']).ok, true);
  assert.equal(done.undo.label, 'before restoring ' + snap.id);
  assert.deepEqual(Object.keys(done.undo.collections.users!.rows), ['u1', 'u5'], 'the undo holds what was there before');
  const back = planRestore(done.undo, await store.dump(), KEYS, { mode: 'replace', collections: ['users'] });
  await applyPlan(back, store, KEYS, { at: T('04'), confirm: back.confirmation, basedOn: await store.dump() });
  assert.deepEqual((await store.dump()).users, current.users, 'restoring the undo snapshot puts it back');
});

test('applying refuses when the data moved on after the plan, and reports a store that did not keep what it was given', async () => {
  const store = memoryStore(base());
  const snap = snapshotOf(base(), { at: T('01') });
  store.data.users = [];
  const current = await store.dump();
  const plan = planRestore(snap, current, KEYS, { mode: 'replace', collections: ['users'] });
  assert.equal(plan.destructive, false, 'only inserts');
  store.data.users = [{ id: 'late', name: 'Late' }];
  await assert.rejects(applyPlan(plan, store, KEYS, { at: T('03'), basedOn: current }), /changed after the plan/);
  store.data.users = [];
  const lossy = { async dump() { return store.dump(); }, async load(d: Data) { await store.load({ ...d, users: d.users!.slice(0, 1) }); } };
  const r = await applyPlan(plan, lossy, KEYS, { at: T('03'), basedOn: current });
  assert.deepEqual([r.verified, r.mismatches], [false, ['users: expected 3 rows, found 1']]);
});

test('as-of lookup and parent checks', () => {
  const log = new SnapshotLog();
  const a = snapshotOf(base(), { at: T('01'), id: 'a' });
  const b = snapshotOf(base(), { at: T('05'), id: 'b', parent: 'a' });
  assert.throws(() => log.add(b), /parent a is not in the log/);
  log.add(a);
  log.add(b);
  assert.throws(() => log.add(a), /already exists/);
  assert.equal(log.asOf(new Date('2026-11-03T00:00:00Z'))!.id, 'a');
  assert.equal(log.asOf(new Date('2026-11-05T10:00:00Z'))!.id, 'b');
  assert.equal(log.asOf(new Date('2026-10-01T00:00:00Z')), undefined);
  const tampered = JSON.parse(serialize(snapshotOf(base(), { at: T('07'), id: 'x' })));
  tampered.collections.users.rows.u1.name = 'Z';
  assert.throws(() => log.add(tampered), /damaged/);
});

test('takeSnapshot reads from a store, and matchesSnapshot reports what differs', async () => {
  const store = memoryStore(base());
  const s = await takeSnapshot(store, { at: T('01') });
  assert.equal(matchesSnapshot(s, await store.dump()).ok, true);
  store.data.posts = store.data.posts!.slice(1);
  const m = matchesSnapshot(s, await store.dump(), ['posts', 'ghost']);
  assert.deepEqual(m.mismatches, ['posts: 1 rows now against 2 in the snapshot, with different content', 'ghost: not in the snapshot']);
});
