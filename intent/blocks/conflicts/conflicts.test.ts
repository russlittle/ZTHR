import assert from 'node:assert/strict';
import { test } from 'node:test';
import { save } from './index.ts';

const base = { name: 'Rent', amount: 900, due: '2026-12-01', note: '' };

test('a save from the current version goes straight through', () => {
  const r = save({ version: 3, data: base }, 3, base, { ...base, amount: 950 });
  assert.ok(r.ok);
  assert.equal(r.record.version, 4);
  assert.equal(r.record.data.amount, 950);
});

test('edits to different fields merge, and nothing anyone changed is lost', () => {
  const theirs = { ...base, due: '2026-12-05' };
  const r = save({ version: 4, data: theirs }, 3, base, { ...base, amount: 950 });
  assert.ok(r.ok);
  assert.deepEqual(r.record.data, { name: 'Rent', amount: 950, due: '2026-12-05', note: '' });
  assert.deepEqual(r.merged, ['amount']);
});

test('the same change on both sides is not a conflict', () => {
  const r = save({ version: 4, data: { ...base, amount: 950 } }, 3, base, { ...base, amount: 950 });
  assert.ok(r.ok);
});

test('different changes to the same field are shown, field by field, and nothing is saved', () => {
  const r = save({ version: 4, data: { ...base, amount: 925, note: 'paid half' } }, 3, base, { ...base, amount: 950, note: 'paid half' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.conflicts, [{ field: 'amount', base: 900, theirs: 925, yours: 950 }]);
});

test('a field removed on one side stays removed unless the other side changed it', () => {
  const { note: _n, ...withoutNote } = base;
  const r = save({ version: 4, data: withoutNote as typeof base }, 3, base, { ...base, amount: 1 });
  assert.ok(r.ok);
  assert.equal('note' in r.record.data, false);
  assert.throws(() => save({ version: 2, data: base }, 3, base, base), RangeError);
});
