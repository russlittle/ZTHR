import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Index, fold, stem, words } from './index.ts';

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
