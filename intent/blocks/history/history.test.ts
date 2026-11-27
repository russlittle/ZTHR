import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conflict, History } from './index.ts';

test('every version can be rebuilt and compared; only changed fields are kept', () => {
  const h = new History(() => new Date('2026-11-26T00:00:00Z'));
  h.change('r1', 'ana', { title: 'Plan', status: 'draft' });
  h.change('r1', 'ben', { title: 'Plan', status: 'review' });
  h.change('r1', 'ana', { owner: 'ben', status: 'approved' });
  assert.deepEqual(h.log('r1')[1]!.after, { status: 'review' }, 'the unchanged title is not recorded');
  assert.deepEqual(h.at('r1', 2), { title: 'Plan', status: 'review' });
  assert.deepEqual(h.diff('r1', 1, 3), [{ field: 'owner', from: undefined, to: 'ben' }, { field: 'status', from: 'draft', to: 'approved' }]);
  assert.throws(() => h.change('r1', 'cy', { status: 'x' }, { expected: 2 }), Conflict);
});

test('undo is a new change, and refuses to lose a newer edit', () => {
  const h = new History();
  h.change('r', 'ana', { a: 1, b: 1 });
  h.change('r', 'ana', { a: 2 });
  h.change('r', 'ben', { b: 2 });
  const u = h.undo('r', 2, 'ana');
  assert.equal(u.undoes, 2);
  assert.deepEqual(h.get('r'), { a: 1, b: 2 }, 'ben’s edit to b survives');
  assert.equal(h.version('r'), 4);
  h.change('r', 'ben', { a: 5 });
  assert.throws(() => h.undo('r', 1, 'ana'), (e: unknown) => e instanceof Conflict && e.fields.join() === 'a,b');
  h.change('r', 'cy', { extra: true });
  h.restore('r', 1, 'ana');
  assert.deepEqual(h.get('r'), { a: 1, b: 1 }, 'restore removes fields added later');
  assert.deepEqual(h.at('r', 5), { a: 5, b: 2 }, 'and every version before it is still there');
});
