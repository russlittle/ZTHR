import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DepthExceeded, HookFailed, Lifecycle, MemoryStore, NotFound, OperationRejected, POINTS } from './index.ts';
import type { AuditEntry } from './index.ts';

function setup(extra: { maxDepth?: number; protectedFields?: string[] } = {}) {
  const store = new MemoryStore();
  let clock = 1000;
  let n = 0;
  const lc = new Lifecycle({ store, now: () => clock++, newId: () => `r${++n}`, ...extra });
  return { store, lc, tick: (ms: number) => (clock += ms) };
}

test('create, update and delete work with no hooks, and stamp the ids and times', async () => {
  const { lc, store } = setup();
  const a = await lc.service.create('post', { title: 'Hi' });
  assert.equal(a['id'], 'r1');
  assert.equal(a['title'], 'Hi');
  assert.equal(typeof a['createdAt'], 'number');
  assert.deepEqual(store.get('post', 'r1'), a);
  const b = await lc.service.update('post', 'r1', { title: 'Hello', draft: true });
  assert.equal(b['title'], 'Hello');
  assert.equal(b['createdAt'], a['createdAt']);
  assert.ok((b['updatedAt'] as number) > (a['updatedAt'] as number));
  const gone = await lc.service.delete('post', 'r1');
  assert.equal(gone['title'], 'Hello');
  assert.equal(store.get('post', 'r1'), undefined);
  await assert.rejects(lc.service.update('post', 'r1', {}), NotFound);
  await assert.rejects(lc.service.delete('post', 'nope'), NotFound);
});

test('hooks run lowest priority first, ties in registration order, and * hooks interleave with collection hooks', async () => {
  const { lc } = setup();
  const seen: string[] = [];
  lc.on('beforeCreate', 'post', () => void seen.push('post-100'));
  lc.on('beforeCreate', '*', () => void seen.push('star-50'), { priority: 50 });
  lc.on('beforeCreate', '*', () => void seen.push('star-100'));
  lc.on('beforeCreate', 'post', () => void seen.push('post-10'), { priority: 10 });
  lc.on('beforeCreate', 'other', () => void seen.push('other'));
  await lc.service.create('post', {});
  assert.deepEqual(seen, ['post-10', 'star-50', 'post-100', 'star-100']);
  assert.deepEqual(lc.plan('beforeCreate', 'post').map((p) => p.id.length > 0 && p.priority), [10, 50, 100, 100]);
});

test('a before hook changes the data that is stored, and later hooks see the earlier one\'s change', async () => {
  const { lc, store } = setup();
  lc.on('beforeCreate', 'post', (ctx) => { ctx.data['slug'] = String(ctx.data['title']).toLowerCase().replace(/\s+/g, '-'); }, { priority: 1 });
  lc.on('beforeCreate', 'post', (ctx) => { ctx.data['slug'] = `${ctx.data['slug']}-x`; }, { priority: 2 });
  const r = await lc.service.create('post', { title: 'Hello World' });
  assert.equal(r['slug'], 'hello-world-x');
  assert.equal(store.get('post', r['id'] as string)!['slug'], 'hello-world-x');
});

test('a before hook can reject: nothing is written, the caller gets the reason and the hook id, and later hooks do not run', async () => {
  const { lc, store } = setup();
  let later = 0;
  lc.on('beforeCreate', 'post', (ctx) => { if (!ctx.data['title']) ctx.reject('a title is required'); }, { id: 'need-title', priority: 1 });
  lc.on('beforeCreate', 'post', () => void later++, { priority: 2 });
  await assert.rejects(lc.service.create('post', {}), (e: unknown) => e instanceof OperationRejected && e.hookId === 'need-title' && e.reason === 'a title is required' && e.message === 'rejected by need-title: a title is required');
  assert.equal(store.count('post'), 0);
  assert.equal(later, 0);
  assert.deepEqual(lc.audit.map((a) => [a.kind, a.outcome]), [['hook', 'rejected'], ['rolled-back', 'error']]);
});

test('beforeUpdate sees the stored record and the patch; the patch the hooks leave is what is merged', async () => {
  const { lc } = setup();
  const created = await lc.service.create('post', { title: 'A', views: 1 });
  let sawBefore: unknown;
  lc.on('beforeUpdate', 'post', (ctx) => {
    sawBefore = ctx.before;
    if (ctx.data['views'] !== undefined && (ctx.data['views'] as number) < (ctx.before!['views'] as number)) ctx.reject('views cannot go down');
    ctx.data['edited'] = true;
  });
  const r = await lc.service.update('post', created['id'] as string, { title: 'B' });
  assert.equal((sawBefore as { title: string }).title, 'A');
  assert.deepEqual({ title: r['title'], views: r['views'], edited: r['edited'] }, { title: 'B', views: 1, edited: true });
  await assert.rejects(lc.service.update('post', created['id'] as string, { views: 0 }), /views cannot go down/);
});

test('a hook cannot touch the id, the timestamps or a protected field, and a caller cannot supply them either', async () => {
  const { lc, store } = setup({ protectedFields: ['owner'] });
  lc.on('beforeCreate', 'post', (ctx) => { ctx.data['id'] = 'hijacked'; }, { id: 'evil' });
  await assert.rejects(lc.service.create('post', {}), (e: unknown) => e instanceof HookFailed && /tried to set protected field "id"/.test((e.original as Error).message));
  assert.equal(store.count('post'), 0);
  lc.off('evil');
  lc.on('beforeCreate', 'post', (ctx) => { ctx.data['owner'] = 'me'; });
  await assert.rejects(lc.service.create('post', {}), HookFailed);
  await assert.rejects(lc.service.create('post', { id: 'mine' }), /"id" is set by the system/);
  await assert.rejects(lc.service.create('post', { createdAt: 5 }), /"createdAt" is set by the system/);
  await assert.rejects(lc.service.create('post', { owner: 'x' }), /"owner" is set by the system/);
});

test('a failing before hook rolls everything back, including what an earlier hook wrote through the service', async () => {
  const { lc, store } = setup();
  lc.on('beforeCreate', 'post', async (ctx) => { await ctx.service.create('audit-note', { text: 'creating a post' }); }, { priority: 1 });
  lc.on('beforeCreate', 'post', () => { throw new Error('disk full'); }, { priority: 2, id: 'boom' });
  await assert.rejects(lc.service.create('post', {}), (e: unknown) => e instanceof HookFailed && e.hookId === 'boom' && /disk full/.test(e.message));
  assert.equal(store.count('post'), 0);
  assert.equal(store.count('audit-note'), 0);
});

test('an isolating before hook that fails is recorded and the operation goes on without its changes', async () => {
  const { lc } = setup();
  lc.on('beforeCreate', 'post', (ctx) => { ctx.data['half'] = true; throw new Error('flaky'); }, { onError: 'isolate', id: 'flaky', priority: 1 });
  lc.on('beforeCreate', 'post', (ctx) => { ctx.data['ok'] = true; }, { priority: 2 });
  const r = await lc.service.create('post', {});
  assert.deepEqual({ half: r['half'], ok: r['ok'] }, { half: undefined, ok: true });
  const e = lc.audit.find((a) => a.hookId === 'flaky')!;
  assert.equal(e.outcome, 'ok-after-failure');
  assert.equal(e.message, 'flaky');
});

test('after hooks run after the commit by default: they see the saved record, and a failure cannot undo it', async () => {
  const { lc, store } = setup();
  const seen: unknown[] = [];
  lc.on('afterCreate', 'post', (ctx) => { seen.push([ctx.phase, store.get('post', ctx.id!) !== undefined, (ctx.after as { title: string }).title]); }, { priority: 1 });
  lc.on('afterCreate', 'post', () => { throw new Error('mailer down'); }, { priority: 2, id: 'mail' });
  let third = 0;
  lc.on('afterCreate', 'post', () => void third++, { priority: 3 });
  const r = await lc.service.create('post', { title: 'T' });
  assert.deepEqual(seen, [['after-commit', true, 'T']]);
  assert.equal(third, 1); // the failing hook did not stop the next one
  assert.ok(store.get('post', r['id'] as string));
  assert.equal(lc.audit.find((a) => a.hookId === 'mail')!.outcome, 'ok-after-failure');
  assert.throws(() => lc.on('afterCreate', 'post', () => {}, { onError: 'abort' }), /cannot abort/);
});

test('an in-transaction after hook runs before the commit, and its failure rolls the whole operation back', async () => {
  const { lc, store } = setup();
  let sawCommitted: boolean | undefined;
  lc.on('afterCreate', 'post', (ctx) => { sawCommitted = store.get('post', ctx.id!) !== undefined; }, { phase: 'in-transaction', priority: 1 });
  const ok = await lc.service.create('post', {});
  assert.equal(sawCommitted, false); // not visible outside until the commit
  assert.ok(store.get('post', ok['id'] as string));
  lc.on('afterCreate', 'post', () => { throw new Error('cannot index'); }, { phase: 'in-transaction', priority: 2, id: 'index' });
  await assert.rejects(lc.service.create('post', { title: 'x' }), HookFailed);
  assert.equal(store.count('post'), 1);
  assert.equal(lc.audit.at(-1)!.kind, 'rolled-back');
});

test('an in-transaction after hook may isolate its failure and the operation commits', async () => {
  const { lc, store } = setup();
  lc.on('afterCreate', 'post', () => { throw new Error('meh'); }, { phase: 'in-transaction', onError: 'isolate' });
  await lc.service.create('post', {});
  assert.equal(store.count('post'), 1);
});

test('after hooks do not run when the operation failed, and do not run on a rolled-back write', async () => {
  const { lc } = setup();
  let ran = 0;
  lc.on('afterCreate', 'post', () => void ran++);
  lc.on('beforeCreate', 'post', (ctx) => ctx.reject('no'));
  await assert.rejects(lc.service.create('post', {}));
  assert.equal(ran, 0);
});

test('update after hooks get the record before and after; delete hooks get the record as it was; delete can be vetoed', async () => {
  const { lc, store } = setup();
  const r = await lc.service.create('post', { title: 'A', locked: false });
  const seen: unknown[] = [];
  lc.on('afterUpdate', 'post', (ctx) => void seen.push([(ctx.before as { title: string }).title, (ctx.after as { title: string }).title, ctx.data]));
  await lc.service.update('post', r['id'] as string, { title: 'B' });
  assert.deepEqual(seen, [['A', 'B', { title: 'B' }]]);
  lc.on('beforeDelete', 'post', (ctx) => { if (ctx.before!['locked']) ctx.reject('locked records cannot be deleted'); });
  await lc.service.update('post', r['id'] as string, { locked: true });
  await assert.rejects(lc.service.delete('post', r['id'] as string), /locked records cannot be deleted/);
  assert.ok(store.get('post', r['id'] as string));
  await lc.service.update('post', r['id'] as string, { locked: false });
  let deleted: unknown;
  lc.on('afterDelete', 'post', (ctx) => { deleted = [ctx.before!['title'], ctx.after]; });
  await lc.service.delete('post', r['id'] as string);
  assert.deepEqual(deleted, ['B', undefined]);
  assert.equal(store.count('post'), 0);
});

test('hooks removed by id or by owner do not run, even one removed while another hook of the same point is running', async () => {
  const { lc } = setup();
  const seen: string[] = [];
  lc.on('beforeCreate', 'post', () => void seen.push('a'), { owner: 'plugin-x', priority: 1 });
  lc.on('beforeCreate', 'post', () => { seen.push('b'); lc.off('c'); }, { priority: 2 });
  lc.on('beforeCreate', 'post', () => void seen.push('c'), { id: 'c', priority: 3 });
  lc.on('beforeCreate', 'post', () => void seen.push('d'), { owner: 'plugin-x', priority: 4 });
  await lc.service.create('post', {});
  assert.deepEqual(seen, ['a', 'b', 'd']);
  assert.equal(lc.offOwner('plugin-x'), 2);
  assert.equal(lc.off('c'), false);
  seen.length = 0;
  await lc.service.create('post', {});
  assert.deepEqual(seen, ['b']);
});

test('nested operations run their own hooks inside the same transaction, and after-commit hooks wait for the outer commit', async () => {
  const { lc, store } = setup();
  const order: string[] = [];
  lc.on('afterCreate', 'comment', (ctx) => { order.push(`comment-after-commit:${store.get('post', 'r1') !== undefined}`); void ctx; });
  lc.on('afterCreate', 'post', async (ctx) => { await ctx.service.create('comment', { text: 'first!' }); order.push('post-tx-hook'); }, { phase: 'in-transaction' });
  lc.on('beforeCreate', 'comment', () => void order.push('comment-before'));
  await lc.service.create('post', {});
  assert.deepEqual(order, ['comment-before', 'post-tx-hook', 'comment-after-commit:true']);
  assert.equal(store.count('comment'), 1);
});

test('an after-commit hook may start a new operation of its own, which commits separately', async () => {
  const { lc, store } = setup();
  lc.on('afterCreate', 'post', async (ctx) => { await ctx.service.create('log', { of: ctx.id }); });
  await lc.service.create('post', {});
  assert.equal(store.count('log'), 1);
  assert.equal(store.get('log', 'r2')!['of'], 'r1');
});

test('hooks that keep starting operations hit the depth limit', async () => {
  const { lc } = setup({ maxDepth: 3 });
  lc.on('beforeCreate', 'loop', async (ctx) => { await ctx.service.create('loop', {}); }, { id: 'again' });
  await assert.rejects(lc.service.create('loop', {}), DepthExceeded);
  const depths: number[] = [];
  const t = setup({ maxDepth: 3 });
  t.lc.on('beforeCreate', 'loop', async (ctx) => { depths.push(ctx.depth); await ctx.service.create('loop', {}); });
  await assert.rejects(t.lc.service.create('loop', {}), /3 levels deep/);
  assert.deepEqual(depths, [0, 1, 2, 3]);
});

test('skipHooks runs none, and still writes', async () => {
  const { lc, store } = setup();
  lc.on('beforeCreate', 'post', (ctx) => ctx.reject('never'));
  lc.on('afterCreate', 'post', () => { throw new Error('never'); }, { phase: 'in-transaction' });
  const r = await lc.service.create('post', { a: 1 }, { skipHooks: true });
  assert.equal(store.get('post', r['id'] as string)!['a'], 1);
});

test('the audit trail records each hook with the actor, timing, changed fields, and the commit', async () => {
  const { lc, tick } = setup();
  lc.on('beforeCreate', 'post', (ctx) => { tick(7); ctx.data['slug'] = 's'; }, { id: 'slugger', owner: 'seo' });
  lc.on('afterCreate', 'post', () => {}, { id: 'notify' });
  await lc.service.create('post', { title: 't' }, { actor: 'ada' });
  const [hook, commit, after] = lc.audit as readonly AuditEntry[];
  assert.equal(hook!.hookId, 'slugger');
  assert.equal(hook!.owner, 'seo');
  assert.equal(hook!.actor, 'ada');
  assert.deepEqual(hook!.changed, ['slug']);
  assert.ok(hook!.durationMs! >= 7);
  assert.equal(commit!.kind, 'committed');
  assert.equal(commit!.recordId, 'r1');
  assert.equal(after!.hookId, 'notify');
  assert.deepEqual(lc.audit.map((a) => a.seq), [1, 2, 3]);
  assert.ok(lc.audit.every((a) => a.opId === 1));
});

test('onAudit is called as entries are written', async () => {
  const store = new MemoryStore();
  const seen: string[] = [];
  const lc = new Lifecycle({ store, now: () => 1, newId: () => 'x', onAudit: (e) => void seen.push(e.kind) });
  lc.on('beforeCreate', '*', () => {});
  await lc.service.create('a', {});
  assert.deepEqual(seen, ['hook', 'committed']);
});

test('registration is checked: unknown points, duplicate ids, phase on a before hook, empty collection', () => {
  const { lc } = setup();
  assert.throws(() => lc.on('beforeSave' as never, 'x', () => {}), /unknown hook point/);
  lc.on('beforeCreate', 'x', () => {}, { id: 'dup' });
  assert.throws(() => lc.on('beforeCreate', 'x', () => {}, { id: 'dup' }), /already registered/);
  assert.throws(() => lc.on('beforeCreate', 'x', () => {}, { phase: 'in-transaction' }), /always runs inside the transaction/);
  assert.throws(() => lc.on('afterCreate', '', () => {}), /collection name/);
  assert.throws(() => lc.on('afterCreate', 'x', () => {}, { phase: 'later' as never }), /unknown phase/);
});

test('operations are checked: bad collection, non-object data', async () => {
  const { lc } = setup();
  await assert.rejects(lc.service.create('*', {}), /real collection/);
  await assert.rejects(lc.service.create('', {}), /real collection/);
  await assert.rejects(lc.service.create('x', [] as never), /must be an object/);
  await assert.rejects(lc.service.update('x', 'id', null as never), /must be an object/);
});

test('the hook point catalogue says what each point can do', () => {
  assert.deepEqual(POINTS.map((p) => p.point), ['beforeCreate', 'afterCreate', 'beforeUpdate', 'afterUpdate', 'beforeDelete', 'afterDelete']);
  assert.deepEqual(POINTS.filter((p) => p.canReject).map((p) => p.point), ['beforeCreate', 'beforeUpdate', 'beforeDelete']);
  assert.deepEqual(POINTS.filter((p) => p.canChangeData).map((p) => p.point), ['beforeCreate', 'beforeUpdate']);
});

test('the memory store rolls back for real and refuses a second open transaction', async () => {
  const store = new MemoryStore();
  await store.transaction(async (tx) => { await tx.insert('t', { id: 'a', v: 1 }); });
  await assert.rejects(store.transaction(async (tx) => { await tx.replace('t', 'a', { id: 'a', v: 2 }); throw new Error('abort'); }), /abort/);
  assert.equal(store.get('t', 'a')!['v'], 1);
  await assert.rejects(store.transaction(async (tx) => { await tx.insert('t', { id: 'a' }); }), /already exists/);
  await assert.rejects(store.transaction(async () => { await store.transaction(async () => {}); }), /already open/);
  const copy = store.get('t', 'a')!;
  copy['v'] = 99;
  assert.equal(store.get('t', 'a')!['v'], 1); // reads are copies
});
