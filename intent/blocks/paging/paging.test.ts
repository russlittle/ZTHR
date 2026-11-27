import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadQuery, ListPrefs, page, type ListSpec } from './index.ts';

type Bill = { id: string; name: string; due: string; amount: number };
const spec: ListSpec<Bill> = { sortable: ['due', 'amount', 'name'], filterable: { amount: ['gte', 'lt'], name: ['contains'] }, idField: 'id', maxPage: 2 };
const rows: Bill[] = [
  { id: 'a', name: 'Rent', due: '2026-12-01', amount: 900 },
  { id: 'b', name: 'Power', due: '2026-12-01', amount: 80 },
  { id: 'c', name: 'Phone', due: '2026-11-20', amount: 45 },
  { id: 'd', name: 'Water', due: '2026-12-10', amount: 30 },
  { id: 'e', name: 'Car', due: '2026-12-01', amount: 300 },
];

test('pages walk every row once, in a stable order, ties broken by id', () => {
  const seen: string[] = [];
  let after: string | null = null;
  do {
    const p: { rows: Bill[]; next: string | null } = page(spec, rows, { sort: { field: 'due', dir: 'asc' }, ...(after ? { after } : {}) });
    seen.push(...p.rows.map((r) => r.id));
    after = p.next;
  } while (after);
  assert.deepEqual(seen, ['c', 'a', 'b', 'e', 'd']);
});

test('a row added before the cursor does not shift the next page', () => {
  const first = page(spec, rows, { sort: { field: 'amount', dir: 'desc' } });
  assert.deepEqual(first.rows.map((r) => r.id), ['a', 'e']);
  const more = [...rows, { id: 'f', name: 'Tuition', due: '2027-01-01', amount: 2000 }];
  assert.deepEqual(page(spec, more, { sort: { field: 'amount', dir: 'desc' }, after: first.next! }).rows.map((r) => r.id), ['b', 'c']);
});

test('filters apply, and only what the list declares is allowed', () => {
  assert.deepEqual(page(spec, rows, { filters: [{ field: 'amount', op: 'gte', value: 80 }, { field: 'name', op: 'contains', value: 'r' }] }).rows.map((r) => r.id), ['a', 'b'], 'Rent and Power: Car is on the next page');
  assert.throws(() => page(spec, rows, { sort: { field: 'id', dir: 'asc' } }), BadQuery);
  assert.throws(() => page(spec, rows, { filters: [{ field: 'due', op: 'eq', value: 'x' }] }), /cannot filter due by eq/);
  assert.throws(() => page(spec, rows, { after: 'not-a-cursor!' }), BadQuery);
  const p = page(spec, rows, { sort: { field: 'due', dir: 'asc' } });
  assert.throws(() => page(spec, rows, { sort: { field: 'amount', dir: 'asc' }, after: p.next! }), /another sort/);
  assert.equal(page(spec, rows, { limit: 50 }).rows.length, 2, 'never more than the largest page');
  assert.throws(() => page(spec, rows, { limit: 0 }), BadQuery);
});

test('each person gets their last sort and filters back; a view the list no longer allows is dropped', () => {
  const prefs = new ListPrefs();
  prefs.remember('ana', 'bills', { sort: { field: 'amount', dir: 'desc' }, filters: [{ field: 'amount', op: 'gte', value: 50 }], after: 'x' });
  assert.deepEqual(prefs.recall('ana', 'bills', spec), { sort: { field: 'amount', dir: 'desc' }, filters: [{ field: 'amount', op: 'gte', value: 50 }] }, 'the cursor is not kept');
  assert.equal(prefs.recall('ben', 'bills', spec), undefined);
  const narrower: ListSpec<Bill> = { ...spec, sortable: ['due'] };
  assert.equal(prefs.recall('ana', 'bills', narrower), undefined);
  assert.equal(prefs.recall('ana', 'bills', spec), undefined, 'and it is forgotten');
});
