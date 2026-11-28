import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Index, fold, stem, typedToward, words } from './index.ts';

const idx = () => {
  const i = new Index({ weights: { title: 3, body: 1 } });
  i.add({ id: 'd1', fields: { title: 'Quarterly budget', body: 'The budget for the café renovation, approved by finance.' }, facets: { kind: 'doc', team: 'ops' } });
  i.add({ id: 'd2', fields: { title: 'Renovation photos', body: 'Photos of the cafe. Budget mentioned once.' }, facets: { kind: 'image', team: 'ops' } });
  i.add({ id: 'd3', fields: { title: 'Secret plans', body: 'budget budget budget' }, facets: { kind: 'doc', team: 'board' } });
  i.add({ id: 'd4', fields: { title: 'Holiday rota', body: 'Who is on call over the holidays.' }, facets: { kind: 'doc', team: 'ops' } });
  return i;
};
const all = () => true;

test('folding and stemming', () => {
  assert.equal(fold('Café ÉCOLE'), 'cafe ecole');
  assert.deepEqual(words('The cats, and the dogs!').map(stem), ['cat', 'dog']);
  assert.equal(stem('policies'), 'policy');
});

test('title matches outrank body matches; accents and plurals match; nothing the person cannot see comes back', () => {
  const i = idx();
  const r = i.search('budgets cafe ', { canSee: (id) => id !== 'd3', facets: ['kind'] });
  assert.deepEqual(r.hits.map((h) => h.id), ['d1', 'd2']);
  assert.deepEqual(r.facets, { kind: { doc: 1, image: 1 } });
  assert.match(r.hits[0]!.snippet, /<mark>budget<\/mark>/);
  assert.match(r.hits[0]!.snippet, /<mark>café<\/mark>/);
});

test('the last word matches as a prefix while typing; phrases match in order; filters narrow', () => {
  const i = idx();
  assert.deepEqual(i.search('holi', { canSee: all }).hits.map((h) => h.id), ['d4']);
  assert.deepEqual(i.search('holi ', { canSee: all }).hits.map((h) => h.id), [], 'a finished word is matched whole');
  assert.deepEqual(i.search('"budget for the cafe"', { canSee: all }).hits.map((h) => h.id), ['d1']);
  assert.deepEqual(i.search('"cafe budget"', { canSee: all }).hits.map((h) => h.id), ['d2']);
  assert.deepEqual(i.search('budget ', { canSee: all, filters: { kind: 'doc', team: 'ops' } }).hits.map((h) => h.id), ['d1']);
  i.remove('d1');
  assert.equal(i.size, 3);
  assert.deepEqual(i.search('quarterly ', { canSee: all }).hits, []);
  i.add({ id: 'd5', fields: { title: 'Pasted', body: '<script>alert(1)</script> invoice' } });
  const sn = i.search('invoice ', { canSee: all }).hits[0]!.snippet;
  assert.equal(sn.includes('<script>'), false);
  assert.match(sn, /&#60;script&#62;/);
});

test('the word being typed still matches as a prefix when an earlier word repeats', () => {
  const once = idx().search('budget quart', { canSee: all }).hits[0]!;
  const twice = idx().search('budget budgets quart', { canSee: all }).hits[0]!;
  assert.equal(twice.id, 'd1');
  assert.equal(twice.score, once.score, 'the same words, the same score');
});

test('the word being typed narrows the results like every other word', () => {
  assert.deepEqual(idx().search('budget holi', { canSee: all }).hits.map((h) => h.id), [], 'no document has budget and a word starting holi');
  assert.deepEqual(idx().search('budget quart', { canSee: all }).hits.map((h) => h.id), ['d1']);
});

test('a phrase must sit inside one field, not run from the end of the title into the body', () => {
  const i = new Index();
  i.add({ id: 'x', fields: { title: 'Annual budget', body: 'Review notes' } });
  assert.deepEqual(i.search('"budget review"', { canSee: all }).hits, []);
});

test('fields named like object properties are indexed with weight 1', () => {
  const i = new Index({ weights: { title: 2 } });
  i.add({ id: 'x', fields: { constructor: 'scaffold hire' } });
  const [h] = i.search('scaffold ', { canSee: all }).hits;
  assert.ok(h && Number.isFinite(h.score) && h.score > 0, String(h?.score));
});

test('a word typed past its stem keeps matching until it is finished ("budgete" on the way to "budgeted")', () => {
  const ids = (q: string) => idx().search(q, { canSee: all }).hits.map((h) => h.id).sort();
  const want = ['d1', 'd2', 'd3'];
  for (const q of ['budg', 'budget', 'budgete', 'budgeted']) assert.deepEqual(ids(q), want, q);
  assert.deepEqual(ids('budgetx'), [], 'not a way any ending starts');
  assert.match(idx().search('budgete', { canSee: all }).hits[0]!.snippet, /<mark>budget<\/mark>/i);
  const i = new Index();
  i.add({ id: 's', fields: { body: 'Case studies and classes' } });
  for (const q of ['studi', 'studie', 'classe']) assert.deepEqual(i.search(q, { canSee: all }).hits.map((h) => h.id), ['s'], q);
  assert.equal(typedToward('budgete', 'budget'), true);
  assert.equal(typedToward('budgetes', 'budget'), false, 'a whole ending typed is a finished word, stemmed as one');
});
