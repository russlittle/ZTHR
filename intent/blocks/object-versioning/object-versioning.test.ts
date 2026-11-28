import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryObjects, readAll } from '../objects/index.ts';
import { VersionError, VersionedBucket } from './index.ts';
import type { Options } from './index.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function mk(o: Options = {}, state: 'enabled' | 'suspended' | 'unversioned' = 'enabled') {
  const objects = memoryObjects();
  let t = T0;
  const b = new VersionedBucket(objects, { now: () => t, ...o });
  if (state !== 'unversioned' && !o.objectLock) b.setVersioning(state);
  return { b, objects, tick: (ms: number) => void (t += ms), now: () => t };
}
const body = async (b: VersionedBucket, key: string, versionId?: string) => (await readAll((await b.get(key, versionId ? { versionId } : {})).stream)).toString();
const fails = async (f: () => Promise<unknown> | unknown, code: string, msg?: RegExp) => {
  try {
    await f();
  } catch (e) {
    assert.ok(e instanceof VersionError, `a VersionError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (msg) assert.match(e.message, msg);
    return e;
  }
  assert.fail(`expected ${code}`);
};

test('unversioned: a write replaces, a delete deletes, and the bytes go with them', async () => {
  const { b, objects } = mk({}, 'unversioned');
  assert.equal(b.versioning, 'unversioned');
  const v = await b.put('k', Buffer.from('one'));
  assert.equal(v.versionId, 'null');
  await b.put('k', Buffer.from('two'));
  assert.equal(objects.count(), 1);
  assert.equal(await body(b, 'k'), 'two');
  assert.deepEqual(await b.delete('k'), { versionId: undefined, deleteMarker: false });
  assert.equal(objects.count(), 0);
  await fails(() => b.get('k'), 'NoSuchKey');
  assert.deepEqual(await b.delete('k'), { versionId: undefined, deleteMarker: false }, 'deleting nothing is fine');
});

test('enabled: every write is a version, reads default to the newest and can name any', async () => {
  const { b, objects, tick } = mk();
  const ids: string[] = [];
  for (const s of ['one', 'two', 'three']) {
    ids.push((await b.put('k', Buffer.from(s), { contentType: 'text/plain', user: { n: s } })).versionId);
    tick(1000);
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal(objects.count(), 3);
  assert.equal(await body(b, 'k'), 'three');
  assert.equal(await body(b, 'k', ids[0]), 'one');
  assert.deepEqual([b.head('k', ids[1]).user, b.head('k').contentType], [{ n: 'two' }, 'text/plain']);
  await fails(() => b.get('k', { versionId: 'nope' }), 'NoSuchVersion');
  const l = b.listVersions();
  assert.deepEqual(l.entries.map((e) => [e.versionId, e.isLatest]), [[ids[2], true], [ids[1], false], [ids[0], false]]);
  assert.deepEqual(b.stats(), { keys: 1, versions: 3, deleteMarkers: 0, currentBytes: 5, noncurrentBytes: 6 });
});

test('delete without an id adds a marker and hides the key; deleting the marker brings the previous version back', async () => {
  const { b, objects } = mk();
  const v1 = await b.put('k', Buffer.from('one'));
  const d = await b.delete('k');
  assert.equal(d.deleteMarker, true);
  assert.equal(objects.count(), 1, 'nothing was removed');
  const e = await fails(() => b.get('k'), 'NoSuchKey');
  assert.equal((e as VersionError).deleteMarker, true);
  assert.equal(await body(b, 'k', v1.versionId), 'one', 'the old version is still readable by id');
  assert.deepEqual(b.list(), [], 'the plain listing hides it');
  assert.deepEqual(b.listVersions().entries.map((x) => [x.isDeleteMarker, x.isLatest]), [[true, true], [false, false]]);
  await fails(() => b.get('k', { versionId: d.versionId! }), 'MethodNotAllowed');
  assert.deepEqual(await b.delete('k', { versionId: d.versionId! }), { versionId: d.versionId, deleteMarker: true });
  assert.equal(await body(b, 'k'), 'one', 'removing the marker undeletes');
  assert.equal(b.list().length, 1);
  assert.deepEqual(await b.delete('k', { versionId: v1.versionId }), { versionId: v1.versionId, deleteMarker: false });
  assert.equal(objects.count(), 0);
  assert.equal(b.listVersions().entries.length, 0);
});

test('suspended: new writes take the null version and replace only it; older versions stay', async () => {
  const { b, objects } = mk();
  const v1 = await b.put('k', Buffer.from('versioned'));
  b.setVersioning('suspended');
  const n1 = await b.put('k', Buffer.from('null one'));
  const n2 = await b.put('k', Buffer.from('null two'));
  assert.deepEqual([n1.versionId, n2.versionId], ['null', 'null']);
  assert.equal(objects.count(), 2, 'the first null version\'s bytes were freed');
  assert.equal(await body(b, 'k'), 'null two');
  assert.equal(await body(b, 'k', v1.versionId), 'versioned');
  const d = await b.delete('k');
  assert.deepEqual([d.versionId, d.deleteMarker], ['null', true]);
  assert.equal(objects.count(), 1, 'the null object was replaced by the marker');
  assert.deepEqual(b.listVersions().entries.map((e) => [e.versionId, e.isDeleteMarker]), [['null', true], [v1.versionId, false]]);
  b.setVersioning('enabled');
  const v3 = await b.put('k', Buffer.from('again'));
  assert.notEqual(v3.versionId, 'null');
  assert.throws(() => b.setVersioning('unversioned' as 'enabled'), VersionError);
});

test('restore copies an old version forward as a new one and leaves history intact', async () => {
  const { b, objects } = mk();
  const v1 = await b.put('k', Buffer.from('good'));
  await b.put('k', Buffer.from('bad'));
  const r = await b.restore('k', v1.versionId);
  assert.notEqual(r.versionId, v1.versionId);
  assert.equal(await body(b, 'k'), 'good');
  assert.equal(b.listVersions().entries.length, 3);
  assert.equal(objects.count(), 3);
  await b.delete('k', { versionId: v1.versionId });
  assert.equal(await body(b, 'k'), 'good', 'the copy does not share bytes with the original');
  const m = await b.delete('k');
  await fails(() => b.restore('k', m.versionId!), 'MethodNotAllowed');
  await fails(() => b.restore('k', 'nope'), 'NoSuchVersion');
  await fails(() => mk({}, 'unversioned').b.restore('x', 'y'), 'NoSuchVersion');
});

test('ranges on a version: closed, suffix, unsatisfiable, and an empty object', async () => {
  const { b } = mk();
  const v = await b.put('k', Buffer.from('0123456789'));
  const r = async (h: string) => readAll((await b.get('k', { rangeHeader: h })).stream);
  assert.equal((await r('bytes=2-4')).toString(), '234');
  assert.equal((await r('bytes=-2')).toString(), '89');
  assert.deepEqual((await b.get('k', { rangeHeader: 'bytes=5-', versionId: v.versionId })).range, { start: 5, end: 9 });
  await fails(() => r('bytes=20-30'), 'InvalidRange');
  await b.put('empty', Buffer.alloc(0));
  assert.equal((await readAll((await b.get('empty')).stream)).length, 0);
});

test('listing: keys in UTF-8 byte order, newest version first, prefixes, delimiters and markers resume exactly', async () => {
  const { b, tick } = mk();
  const keys = ['b', 'a/1', 'a/2', 'c/x', 'c/y', '～', '\u{1f600}', 'd'];
  for (const k of keys) {
    await b.put(k, Buffer.from(k));
    tick(1);
    await b.put(k, Buffer.from(k + '2'));
    tick(1);
  }
  await b.delete('d');
  const flat = b.listVersions();
  assert.deepEqual([...new Set(flat.entries.map((e) => e.key))], ['a/1', 'a/2', 'b', 'c/x', 'c/y', 'd', '～', '\u{1f600}'], 'U+FF5E before U+1F600 by bytes');
  assert.equal(flat.entries.length, 17);
  assert.deepEqual(flat.entries.filter((e) => e.isLatest).length, 8);
  assert.deepEqual(flat.entries.filter((e) => e.key === 'd').map((e) => e.isDeleteMarker), [true, false, false]);
  const top = b.listVersions({ delimiter: '/' });
  assert.deepEqual(top.commonPrefixes, ['a/', 'c/']);
  assert.deepEqual([...new Set(top.entries.map((e) => e.key))], ['b', 'd', '～', '\u{1f600}']);
  assert.deepEqual([...new Set(b.listVersions({ prefix: 'c/' }).entries.map((e) => e.key))], ['c/x', 'c/y']);
  for (const size of [1, 2, 3, 7]) {
    const got: string[] = [];
    let km: string | undefined;
    let vm: string | undefined;
    for (let i = 0; i < 100; i++) {
      const p = b.listVersions({ maxKeys: size, ...(km !== undefined ? { keyMarker: km } : {}), ...(vm !== undefined ? { versionIdMarker: vm } : {}) });
      assert.ok(p.entries.length <= size);
      got.push(...p.entries.map((e) => `${e.key}|${e.versionId}`));
      if (!p.truncated) break;
      km = p.nextKeyMarker;
      vm = p.nextVersionIdMarker;
    }
    assert.deepEqual(got, flat.entries.map((e) => `${e.key}|${e.versionId}`), `page size ${size}`);
  }
  await fails(() => b.listVersions({ versionIdMarker: 'x' }), 'InvalidArgument');
  await fails(() => b.listVersions({ keyMarker: 'b', versionIdMarker: 'nope' }), 'NoSuchVersion');
  assert.equal(b.listVersions({ maxKeys: 0 }).entries.length, 0);
});

test('keys are validated', async () => {
  const { b } = mk();
  for (const bad of ['', 'a\u0000b', 'x'.repeat(1025), 'é'.repeat(513), '\ud800']) await fails(() => b.put(bad, Buffer.from('x')), 'InvalidArgument');
  await fails(() => b.delete(''), 'InvalidArgument');
  assert.throws(() => b.head('a\nb'), VersionError);
  await b.put('x'.repeat(1024), Buffer.from('ok'));
});

test('version count per key is capped', async () => {
  const { b } = mk({ maxVersionsPerKey: 3 });
  for (let i = 0; i < 3; i++) await b.put('k', Buffer.from(String(i)));
  await fails(() => b.put('k', Buffer.from('x')), 'TooManyVersions');
  await fails(() => b.delete('k'), 'TooManyVersions');
  const v = b.listVersions().entries[2]!;
  await b.delete('k', { versionId: v.versionId });
  await b.put('k', Buffer.from('fits again'));
});

test('compliance retention: nobody deletes, shortens or weakens it; it can be lengthened; it ends on its date', async () => {
  const { b, tick, now } = mk({ objectLock: true, canBypass: () => true });
  const until = now() + 10 * DAY;
  const v = await b.put('k', Buffer.from('record'), { retention: { mode: 'COMPLIANCE', until } });
  await fails(() => b.delete('k', { versionId: v.versionId }), 'ObjectLocked', /compliance retention until 2026-01-11/);
  await fails(() => b.delete('k', { versionId: v.versionId, bypassGovernance: true, who: 'admin' }), 'ObjectLocked');
  await fails(() => b.setRetention('k', v.versionId, undefined), 'ObjectLocked', /only be lengthened/);
  await fails(() => b.setRetention('k', v.versionId, { mode: 'COMPLIANCE', until: until - 1 }), 'ObjectLocked');
  await fails(() => b.setRetention('k', v.versionId, { mode: 'GOVERNANCE', until: until + DAY }), 'ObjectLocked');
  b.setRetention('k', v.versionId, { mode: 'COMPLIANCE', until: until + 5 * DAY });
  assert.equal(b.lockOf('k', v.versionId).retention!.until, until + 5 * DAY);
  const m = await b.delete('k');
  assert.equal(m.deleteMarker, true, 'a delete marker is allowed: nothing is removed');
  await b.put('k', Buffer.from('newer'));
  assert.equal(await body(b, 'k', v.versionId), 'record', 'the locked version survived every attempt');
  tick(16 * DAY);
  assert.equal(b.lockOf('k', v.versionId).lockedNow, false);
  await b.delete('k', { versionId: v.versionId });
  await fails(() => b.get('k', { versionId: v.versionId }), 'NoSuchVersion');
});

test('governance retention: deletable only by bypass from someone allowed; legal hold blocks everything until lifted', async () => {
  const { b, now } = mk({ objectLock: true, canBypass: (who) => who === 'admin' });
  const until = now() + 5 * DAY;
  const v = await b.put('k', Buffer.from('x'), { retention: { mode: 'GOVERNANCE', until } });
  await fails(() => b.delete('k', { versionId: v.versionId }), 'ObjectLocked', /governance/);
  await fails(() => b.delete('k', { versionId: v.versionId, bypassGovernance: true, who: 'intern' }), 'AccessDenied');
  await fails(() => b.delete('k', { versionId: v.versionId, bypassGovernance: true }), 'AccessDenied');
  await fails(() => b.setRetention('k', v.versionId, { mode: 'GOVERNANCE', until: until - DAY }), 'ObjectLocked', /needs bypass/);
  b.setRetention('k', v.versionId, { mode: 'GOVERNANCE', until: until + DAY });
  b.setRetention('k', v.versionId, { mode: 'COMPLIANCE', until: until + DAY }, {});
  const g = await b.put('g', Buffer.from('y'), { retention: { mode: 'GOVERNANCE', until } });
  b.setRetention('g', g.versionId, { mode: 'GOVERNANCE', until: until - DAY }, { bypassGovernance: true, who: 'admin' });
  b.setRetention('g', g.versionId, undefined, { bypassGovernance: true, who: 'admin' });
  assert.equal(b.lockOf('g', g.versionId).lockedNow, false);
  const h = await b.put('h', Buffer.from('z'), { legalHold: true });
  await fails(() => b.delete('h', { versionId: h.versionId, bypassGovernance: true, who: 'admin' }), 'ObjectLocked', /legal hold/);
  b.setLegalHold('h', h.versionId, false);
  await b.delete('h', { versionId: h.versionId });
  await fails(() => b.put('x', Buffer.from('1'), { retention: { mode: 'GOVERNANCE', until: now() - 1 } }), 'InvalidArgument', /future/);
  await fails(() => b.put('x', Buffer.from('1'), { retention: { mode: 'WEIRD' as 'GOVERNANCE', until: until } }), 'InvalidArgument');
});

test('a failed locked write leaves no stray bytes, and lock settings need an object-lock bucket', async () => {
  const { b, objects } = mk({}, 'suspended');
  await fails(() => b.put('k', Buffer.from('x'), { retention: { mode: 'GOVERNANCE', until: T0 + DAY } }), 'InvalidState', /not enabled/);
  await fails(() => b.put('k', Buffer.from('x'), { legalHold: true }), 'InvalidState');
  assert.throws(() => new VersionedBucket(memoryObjects(), { defaultRetention: { mode: 'GOVERNANCE', days: 1 } }), VersionError);
  const l = mk({ objectLock: true });
  assert.equal(l.b.versioning, 'enabled');
  assert.throws(() => l.b.setVersioning('suspended'), /object lock is on/);
  assert.throws(() => new VersionedBucket(memoryObjects(), { objectLock: true, defaultRetention: { mode: 'GOVERNANCE', days: 0 } }), VersionError);
  assert.equal(objects.count(), 0);
  const plain = mk();
  await plain.b.put('k', Buffer.from('x'));
  await fails(() => plain.b.setRetention('k', undefined, { mode: 'GOVERNANCE', until: T0 + DAY }), 'InvalidState');
  await fails(() => plain.b.setLegalHold('k', undefined, true), 'InvalidState');
});

test('a default retention stamps every new version, including restored ones', async () => {
  const { b, now, tick } = mk({ objectLock: true, defaultRetention: { mode: 'COMPLIANCE', days: 7 } });
  const v = await b.put('k', Buffer.from('a'));
  assert.deepEqual(v.retention, { mode: 'COMPLIANCE', until: now() + 7 * DAY });
  const explicit = await b.put('k2', Buffer.from('b'), { retention: { mode: 'GOVERNANCE', until: now() + DAY } });
  assert.equal(explicit.retention!.mode, 'GOVERNANCE');
  tick(8 * DAY);
  const r = await b.restore('k', v.versionId);
  assert.deepEqual(r.retention, { mode: 'COMPLIANCE', until: now() + 7 * DAY });
  await b.delete('k', { versionId: v.versionId });
});

test('lifecycle: current versions expire into delete markers, noncurrent ones go after N days keeping the newest K', async () => {
  const { b, objects, tick } = mk();
  b.setLifecycle([{ id: 'logs', prefix: 'logs/', enabled: true, expireDays: 30, noncurrentDays: 7, keepNoncurrent: 1 }, { id: 'off', prefix: '', enabled: false, expireDays: 1 }]);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    ids.push((await b.put('logs/a', Buffer.from(`v${i}`))).versionId);
    tick(2 * DAY);
  }
  await b.put('keep/a', Buffer.from('untouched'));
  // v0 stopped being current 6 days ago, v1 4 days ago, v2 2 days ago
  assert.deepEqual((await b.sweep()).purged, [], 'nothing is old enough yet');
  tick(2 * DAY);
  const r = await b.sweep();
  assert.deepEqual(r.purged.map((p) => p.versionId), [ids[0]], 'v0 has been noncurrent 8 days; v1 is the one kept (newest noncurrent)');
  assert.equal(objects.count(), 4);
  tick(10 * DAY);
  assert.deepEqual((await b.sweep()).purged.map((p) => p.versionId), [ids[1]], 'v2 is now the newest noncurrent version and is kept; v1 has been noncurrent 16 days');
  assert.equal(objects.count(), 3);
  tick(20 * DAY);
  const e = await b.sweep();
  assert.equal(e.expired.length, 1, 'the current version is now over 30 days old');
  assert.equal(e.expired[0]!.key, 'logs/a');
  await fails(() => b.get('logs/a'), 'NoSuchKey');
  assert.equal(await body(b, 'keep/a'), 'untouched');
  assert.equal(b.listVersions({ prefix: 'logs/' }).entries[0]!.isDeleteMarker, true);
});

test('lifecycle never removes locked versions and reports them; markers with nothing under them are cleaned', async () => {
  const { b, tick, now } = mk({ objectLock: true });
  b.setLifecycle([{ id: 'r', prefix: '', enabled: true, noncurrentDays: 1 }, { id: 'm', prefix: '', enabled: true, removeExpiredMarkers: true }]);
  const locked = await b.put('k', Buffer.from('locked'), { retention: { mode: 'COMPLIANCE', until: now() + 100 * DAY } });
  const held = await b.put('k', Buffer.from('held'), { legalHold: true });
  const free = await b.put('k', Buffer.from('free'));
  await b.put('k', Buffer.from('current'));
  tick(3 * DAY);
  const r = await b.sweep();
  assert.deepEqual(r.purged.map((p) => p.versionId), [free.versionId]);
  assert.deepEqual(r.skippedLocked.map((p) => p.versionId).sort(), [held.versionId, locked.versionId].sort());
  assert.equal(await body(b, 'k', locked.versionId), 'locked');
  assert.equal(await body(b, 'k', held.versionId), 'held');
  // a marker over nothing
  const only = mk();
  only.b.setLifecycle([{ id: 'm', prefix: '', enabled: true, removeExpiredMarkers: true }]);
  const v = await only.b.put('gone', Buffer.from('x'));
  const mk1 = await only.b.delete('gone');
  assert.equal((await only.b.sweep()).markersRemoved.length, 0, 'the marker still hides a version');
  await only.b.delete('gone', { versionId: v.versionId });
  const done = await only.b.sweep();
  assert.deepEqual(done.markersRemoved, [{ key: 'gone', versionId: mk1.versionId! }]);
  assert.equal(only.b.listVersions().entries.length, 0);
  assert.equal(only.b.stats().keys, 0);
});

test('lifecycle on an unversioned bucket deletes expired objects; rules are validated', async () => {
  const { b, tick, objects } = mk({}, 'unversioned');
  b.setLifecycle([{ id: 'old', prefix: 'tmp/', enabled: true, expireDays: 2 }]);
  await b.put('tmp/a', Buffer.from('x'));
  await b.put('other', Buffer.from('y'));
  tick(3 * DAY);
  const r = await b.sweep();
  assert.deepEqual(r.expired, [{ key: 'tmp/a', marker: '' }]);
  assert.equal(objects.count(), 1);
  const bad = (rules: Parameters<VersionedBucket['setLifecycle']>[0]) => assert.throws(() => b.setLifecycle(rules), VersionError);
  bad([{ id: '', prefix: '', enabled: true, expireDays: 1 }]);
  bad([{ id: 'a', prefix: '', enabled: true, expireDays: 1 }, { id: 'a', prefix: '', enabled: true, expireDays: 1 }]);
  bad([{ id: 'a', prefix: '', enabled: true, expireDays: 0 }]);
  bad([{ id: 'a', prefix: '', enabled: true, expireDays: 1.5 }]);
  bad([{ id: 'a', prefix: '', enabled: true }]);
  bad([{ id: 'a', prefix: '', enabled: true, noncurrentDays: 1, keepNoncurrent: -1 }]);
  bad([{ id: 'a', prefix: '', enabled: true, expireDays: 1, removeExpiredMarkers: true }]);
  bad(Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}`, prefix: '', enabled: true, expireDays: 1 })));
});
