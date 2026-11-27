import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefData, check } from './index.ts';

const v1 = { name: 'plan', version: 1, codes: [{ code: 'basic', label: 'Basic', from: '2020-01-01', order: 1 }, { code: 'pro', label: 'Pro', from: '2020-01-01', order: 2 }] };

test('lookups are as of a day; retired codes still read and point to their replacement', () => {
  const r = new RefData();
  r.load(v1);
  r.load({ name: 'plan', version: 2, codes: [{ code: 'basic', label: 'Basic', from: '2020-01-01', until: '2026-07-01', replacedBy: 'starter', order: 1 }, { code: 'starter', label: 'Starter', from: '2026-07-01', order: 1 }, { code: 'pro', label: 'Pro', from: '2020-01-01', order: 2 }] });
  assert.deepEqual(r.options('plan', '2026-01-01').map((c) => c.code), ['basic', 'pro']);
  assert.deepEqual(r.options('plan', '2026-11-26').map((c) => c.code), ['starter', 'pro']);
  assert.equal(r.label('plan', 'basic', '2026-11-26'), 'Basic', 'an old record still shows its label');
  assert.equal(r.isValid('plan', 'basic', '2026-11-26'), false, 'but it is not offered for new records');
  assert.equal(r.current('plan', 'basic', '2026-11-26'), 'starter');
  assert.equal(r.current('plan', 'basic', '2026-01-01'), 'basic');
  assert.equal(r.label('plan', 'starter', '2026-01-01'), undefined, 'not yet in effect');
});

test('a new version that would orphan stored values is refused, with every reason', () => {
  const r = new RefData();
  r.load(v1);
  assert.throws(() => r.load({ name: 'plan', version: 2, codes: [{ code: 'pro', label: 'Pro', from: '2020-01-01' }] }), /basic was removed; retire it/);
  assert.deepEqual(check(v1, { name: 'plan', version: 1, codes: [...v1.codes, { code: 'pro', label: 'x', from: '2026-01-01', until: '2025-01-01', replacedBy: 'gone' }] }), ['pro appears twice', 'pro retires before it starts', 'pro is replaced by gone, which is not in the list', 'version must be above 1']);
});
