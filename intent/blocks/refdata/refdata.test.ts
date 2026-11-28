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

test('an old record still shows the label it had then when a later version renames it', () => {
  const r = new RefData();
  r.load(v1);
  r.load({ name: 'plan', version: 2, from: '2026-07-01', codes: [{ code: 'basic', label: 'Essentials', from: '2020-01-01', order: 1 }, v1.codes[1]!] });
  assert.equal(r.label('plan', 'basic', '2025-03-01'), 'Basic', 'the label in effect that day');
  assert.equal(r.label('plan', 'basic', '2026-07-01'), 'Essentials');
  assert.deepEqual(r.options('plan', '2025-03-01').map((c) => c.label), ['Basic', 'Pro']);
  assert.deepEqual(r.options('plan', '2026-08-01').map((c) => c.label), ['Essentials', 'Pro']);
  r.load({ name: 'plan', version: 3, codes: [{ code: 'basic', label: 'Essentials', from: '2020-01-01', order: 1 }, v1.codes[1]!, { code: 'team', label: 'Team', from: '2026-09-01', order: 3 }] });
  assert.equal(r.label('plan', 'basic', '2025-03-01'), 'Basic', 'a version with no from day takes effect when the one before did');
  assert.equal(r.label('plan', 'team', '2026-10-01'), 'Team');
  assert.throws(() => r.load({ name: 'plan', version: 4, codes: [{ code: 'basic', label: 'Lite', from: '2020-01-01' }, v1.codes[1]!, { code: 'team', label: 'Team', from: '2026-09-01' }] }), /basic is renamed from Essentials to Lite; give the version a from day/);
  assert.throws(() => r.load({ name: 'plan', version: 4, from: '2026-01-01', codes: [{ code: 'basic', label: 'Lite', from: '2020-01-01' }, v1.codes[1]!, { code: 'team', label: 'Team', from: '2026-09-01' }] }), /from must not be before 2026-07-01/);
});
