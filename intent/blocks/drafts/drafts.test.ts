import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Drafts } from './index.ts';

test('typing is kept, with snapshots no closer than the gap, and an earlier one can come back', () => {
  let t = 0;
  const d = new Drafts({ now: () => t, minGapMs: 30_000, keepVersions: 3 });
  d.save('ana', 'doc:1', 4, { body: 'H' });
  t = 5_000;
  d.save('ana', 'doc:1', 4, { body: 'Hello' });
  assert.equal(d.mine('ana')[0]!.history.length, 1, 'still the same snapshot');
  for (const [i, body] of ['Hello w', 'Hello wo', 'Hello wor', 'Hello world'].entries()) {
    t = 40_000 * (i + 1);
    d.save('ana', 'doc:1', 4, { body });
  }
  const draft = d.mine('ana')[0]!;
  assert.deepEqual(draft.history.map((h) => h.fields.body), ['Hello wo', 'Hello wor', 'Hello world']);
  d.restore('ana', 'doc:1', 0);
  assert.equal(draft.fields.body, 'Hello wo');
  assert.throws(() => d.restore('ana', 'doc:1', 9), /no such draft/);
});

test('resuming says when someone else saved in the meantime, and what changed', () => {
  let t = 0;
  const d = new Drafts({ now: () => t });
  d.save('ana', 'doc:1', 4, { title: 'Plan', body: 'mine' });
  assert.equal(d.resume('ana', 'doc:1', { version: 4, fields: {} }).state, 'clean');
  const r = d.resume('ana', 'doc:1', { version: 5, fields: { title: 'Plan v2', body: 'theirs' } }, { title: 'Plan', body: 'theirs' });
  assert.equal(r.state, 'conflict');
  assert.deepEqual(r.state === 'conflict' && r.changed, ['title']);
  assert.equal(d.resume('ben', 'doc:1', { version: 5, fields: {} }).state, 'none', 'drafts are per person');
  d.save('ana', 'doc:2', 1, {});
  t = 10_000;
  d.save('ana', 'doc:1', 4, { body: 'newer' });
  assert.deepEqual(d.mine('ana').map((x) => x.what), ['doc:1', 'doc:2']);
  d.done('ana', 'doc:1');
  t = 100_000;
  assert.equal(d.sweep(60_000), 1);
  assert.deepEqual(d.mine('ana'), []);
});
