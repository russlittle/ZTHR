import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ChangeFeed, ResumeError, FeedError, compileFilter, parseFilter, coalesce, toCloudEvent, isGap } from './index.ts';
import type { Change, Gap } from './index.ts';

const key = randomBytes(32);
const mk = (o: { retain?: number; epoch?: string } = {}) => new ChangeFeed({ signingKey: key, now: () => 1_700_000_000_000, epoch: 'e1', ...o });
const changes = (items: ReturnType<ChangeFeed['subscribe']>['poll'] extends (...a: never[]) => infer R ? R : never) => items.filter((i): i is Change => !isGap(i));

test('captured changes get gapless, increasing sequence numbers and frozen rows', () => {
  const f = mk();
  const a = f.capture('orders', 'insert', '1', null, { id: 1, status: 'new' })!;
  const b = f.capture('orders', 'update', '1', { id: 1, status: 'new' }, { id: 1, status: 'paid' })!;
  const c = f.capture('orders', 'delete', '1', { id: 1, status: 'paid' }, null)!;
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  assert.deepEqual(b.changed, ['status']);
  assert.ok(Object.isFrozen(a.after));
  assert.equal(f.head, 3);
});

test('an update that changes nothing is not a change; malformed changes are refused', () => {
  const f = mk();
  assert.equal(f.capture('t', 'update', '1', { a: 1, b: { x: [1] } }, { a: 1, b: { x: [1] } }), undefined);
  assert.equal(f.head, 0);
  assert.throws(() => f.capture('t', 'insert', '1', { a: 1 }, { a: 1 }), FeedError);
  assert.throws(() => f.capture('t', 'delete', '1', null, null), FeedError);
  assert.throws(() => f.capture('', 'insert', '1', null, { a: 1 }), FeedError);
  assert.throws(() => f.capture('t', 'update', '1', null, { a: 1 }), FeedError);
});

test('a transaction publishes together on commit and not at all on error', async () => {
  const f = mk();
  const s = f.subscribe();
  await f.transaction((tx) => {
    tx.capture('a', 'insert', '1', null, { v: 1 });
    tx.capture('b', 'insert', '9', null, { v: 2 });
  });
  const got = changes(s.poll());
  assert.deepEqual(got.map((c) => c.seq), [1, 2]);
  assert.equal(got[0]!.tx, got[1]!.tx);
  await assert.rejects(f.transaction((tx) => { tx.capture('a', 'insert', '2', null, { v: 3 }); throw new Error('rolled back'); }));
  assert.equal(f.head, 2);
  assert.equal(s.poll().length, 0);
});

test('filters by table, operation, column values and changed columns', () => {
  const f = mk();
  const s = f.subscribe({ filter: { tables: ['orders'], ops: ['insert', 'update'], where: [{ column: 'status', cmp: 'in', value: ['paid', 'shipped'] }, { column: 'total', cmp: 'gte', value: 10 }] } });
  f.capture('orders', 'insert', '1', null, { status: 'paid', total: 50 });
  f.capture('orders', 'insert', '2', null, { status: 'new', total: 50 });
  f.capture('orders', 'insert', '3', null, { status: 'paid', total: 5 });
  f.capture('users', 'insert', '1', null, { status: 'paid', total: 50 });
  f.capture('orders', 'delete', '1', { status: 'paid', total: 50 }, null);
  assert.deepEqual(changes(s.poll()).map((c) => c.key), ['1']);
  const u = f.subscribe({ filter: { changedAny: ['email'] } });
  f.capture('u', 'update', '1', { name: 'a', email: 'x' }, { name: 'b', email: 'x' });
  f.capture('u', 'update', '1', { name: 'b', email: 'x' }, { name: 'b', email: 'y' });
  assert.equal(changes(u.poll()).length, 1);
});

test('delete is matched on the row as it was; isNull and notNull work', () => {
  const m = compileFilter({ where: [{ column: 'archived', cmp: 'isNull' }] });
  const base = { seq: 1, table: 't', key: '1', changed: [], tx: null, time: 0 };
  assert.equal(m({ ...base, op: 'delete', before: { archived: null }, after: null }), true);
  assert.equal(m({ ...base, op: 'delete', before: { archived: 'x' }, after: null }), false);
  assert.equal(compileFilter({ where: [{ column: 'archived', cmp: 'notNull' }] })({ ...base, op: 'insert', before: null, after: { archived: 'x' } }), true);
});

test('bad filters are refused; the text form parses', () => {
  assert.throws(() => compileFilter({ where: [{ column: 'a b', cmp: 'eq', value: 1 }] }), FeedError);
  assert.throws(() => compileFilter({ where: [{ column: 'a', cmp: 'like' as never, value: 1 }] }), FeedError);
  assert.throws(() => compileFilter({ where: [{ column: 'a', cmp: 'in', value: [] }] }), FeedError);
  assert.throws(() => compileFilter({ ops: ['upsert' as never] }), FeedError);
  assert.deepEqual(parseFilter('status=eq.open&id=in.(1,2,3)&deleted_at=is.null&age=gte.18'), [
    { column: 'status', cmp: 'eq', value: 'open' },
    { column: 'id', cmp: 'in', value: [1, 2, 3] },
    { column: 'deleted_at', cmp: 'isNull' },
    { column: 'age', cmp: 'gte', value: 18 },
  ]);
  assert.throws(() => parseFilter('status;DROP=eq.1'), FeedError);
  assert.throws(() => parseFilter('a=is.5'), FeedError);
});

test('permissions and hidden columns keep rows and columns away from a subscriber', () => {
  const f = mk();
  const s = f.subscribe({ canSee: (c) => c.after?.['owner'] === 'me', hide: ['salary'] });
  f.capture('p', 'insert', '1', null, { owner: 'me', salary: 100, name: 'a' });
  f.capture('p', 'insert', '2', null, { owner: 'you', salary: 100, name: 'b' });
  f.capture('p', 'update', '1', { owner: 'me', salary: 100, name: 'a' }, { owner: 'me', salary: 200, name: 'a' });
  const got = changes(s.poll());
  assert.equal(got.length, 2);
  assert.deepEqual(got[0]!.after, { owner: 'me', name: 'a' });
  assert.deepEqual(got[1]!.changed, []);
  assert.ok(!JSON.stringify(got).includes('200'));
});

test('resume replays exactly what was missed, in order, filtered', () => {
  const f = mk();
  const s = f.subscribe();
  f.capture('t', 'insert', '1', null, { v: 1 });
  f.capture('t', 'insert', '2', null, { v: 2 });
  assert.equal(changes(s.poll(1)).length, 1);
  const token = s.token();
  s.close();
  f.capture('t', 'insert', '3', null, { v: 3 });
  const r = f.subscribe({ from: token });
  assert.deepEqual(changes(r.poll()).map((c) => c.key), ['2', '3']);
  f.capture('t', 'insert', '4', null, { v: 4 });
  assert.deepEqual(changes(r.poll()).map((c) => c.key), ['4']);
});

test('token with nothing missed replays nothing; new subscription starts at the head', () => {
  const f = mk();
  f.capture('t', 'insert', '1', null, { v: 1 });
  const s = f.subscribe();
  assert.equal(s.poll().length, 0);
  assert.equal(f.subscribe({ from: f.tokenFor(f.head) }).poll().length, 0);
});

test('resume refuses forged, edited, other-epoch, expired and future tokens', () => {
  const f = mk({ retain: 3 });
  for (let i = 1; i <= 6; i++) f.capture('t', 'insert', String(i), null, { v: i });
  const reason = (t: string) => { try { f.subscribe({ from: t }); return 'ok'; } catch (e) { return e instanceof ResumeError ? e.reason : 'other'; } };
  assert.equal(reason('garbage'), 'invalid');
  const good = f.tokenFor(4);
  assert.equal(reason(good), 'ok');
  assert.equal(reason(good.replace('.4.', '.2.')), 'invalid');
  assert.equal(reason(`${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`), 'invalid');
  assert.equal(reason(f.tokenFor(1)), 'expired');
  assert.equal(reason(f.tokenFor(99)), 'ahead');
  assert.equal(reason(new ChangeFeed({ signingKey: key, epoch: 'e2' }).tokenFor(0)), 'epoch');
  assert.equal(reason(new ChangeFeed({ signingKey: randomBytes(32), epoch: 'e1' }).tokenFor(4)), 'invalid');
});

test('a short signing key is refused', () => {
  assert.throws(() => new ChangeFeed({ signingKey: 'short' }), FeedError);
});

test('retention keeps the last N records', () => {
  const f = mk({ retain: 2 });
  for (let i = 1; i <= 5; i++) f.capture('t', 'insert', String(i), null, { v: i });
  assert.equal(f.oldest, 4);
  assert.deepEqual(f.since(0).map((c) => c.seq), [4, 5]);
});

test('a slow subscriber with onFull gap gets one gap marker with a resume token, then the newest', () => {
  const f = mk();
  const s = f.subscribe({ buffer: 3 });
  for (let i = 1; i <= 7; i++) f.capture('t', 'insert', String(i), null, { v: i });
  const items = s.poll();
  const gap = items.find(isGap) as Gap;
  assert.ok(gap);
  assert.equal(items.filter(isGap).length, 1);
  assert.equal(gap.count, 4);
  assert.deepEqual([gap.from, gap.to], [1, 4]);
  assert.deepEqual(changes(items).map((c) => c.seq), [5, 6, 7]);
  const lost = f.subscribe({ from: gap.resume, filter: {} });
  assert.deepEqual(changes(lost.poll()).slice(0, 4).map((c) => c.seq), [1, 2, 3, 4]);
});

test('onFull close ends the subscription as slow and the feed carries on', () => {
  const f = mk();
  const s = f.subscribe({ buffer: 2, onFull: 'close' });
  const other = f.subscribe();
  for (let i = 1; i <= 3; i++) f.capture('t', 'insert', String(i), null, { v: i });
  assert.equal(s.endedBecause, 'slow');
  assert.equal(s.poll().length, 0);
  assert.equal(changes(other.poll()).length, 3);
  assert.equal(f.subscribers, 1);
});

test('a consumer that keeps up never sees a gap, and onReady fires', () => {
  const f = mk();
  let ready = 0;
  const s = f.subscribe({ buffer: 2, onReady: () => void ready++ });
  for (let i = 1; i <= 10; i++) {
    f.capture('t', 'insert', String(i), null, { v: i });
    assert.equal(changes(s.poll()).length, 1);
  }
  assert.equal(ready, 10);
});

test('bad buffer sizes are refused', () => {
  assert.throws(() => mk().subscribe({ buffer: 0 }), FeedError);
});

test('coalesce folds to the net change per row', () => {
  const f = mk();
  const out = [
    f.capture('t', 'insert', '1', null, { v: 1 })!,
    f.capture('t', 'update', '1', { v: 1 }, { v: 2 })!,
    f.capture('t', 'insert', '2', null, { v: 1 })!,
    f.capture('t', 'delete', '2', { v: 1 }, null)!,
    f.capture('t', 'update', '3', { v: 1, w: 1 }, { v: 2, w: 1 })!,
    f.capture('t', 'update', '3', { v: 2, w: 1 }, { v: 1, w: 5 })!,
    f.capture('t', 'update', '4', { v: 1 }, { v: 2 })!,
    f.capture('t', 'update', '4', { v: 2 }, { v: 1 })!,
    f.capture('t', 'delete', '5', { v: 1 }, null)!,
    f.capture('t', 'insert', '5', null, { v: 2 })!,
  ];
  const net = coalesce(out);
  assert.deepEqual(net.map((c) => `${c.key}:${c.op}`), ['1:insert', '3:update', '5:update']);
  assert.deepEqual(net[0]!.after, { v: 2 });
  assert.deepEqual(net[1]!.changed, ['w']);
  assert.deepEqual(net[2]!.before, { v: 1 });
});

test('toCloudEvent gives a CloudEvents 1.0 record', () => {
  const f = mk();
  const c = f.capture('orders', 'insert', '7', null, { id: 7 })!;
  const e = toCloudEvent(c, '/db/main');
  assert.equal(e.specversion, '1.0');
  assert.equal(e.type, 'row.inserted');
  assert.equal(e.subject, 'orders/7');
  assert.equal(e.time, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(e.data['after'], { id: 7 });
});
