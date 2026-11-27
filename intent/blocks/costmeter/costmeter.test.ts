import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Meter } from './index.ts';

const rates = [
  { meter: 'tokens', unit: 'token', microCentsPerUnit: 300, free: 1000 },
  { meter: 'emails', unit: 'email', microCentsPerUnit: 10_000 },
];

test('a bill line per meter, feature and tenant, free units first, exact for tiny rates', () => {
  const m = new Meter(rates);
  m.record({ meter: 'tokens', units: 1000, feature: 'summaries', tenant: 'acme', at: '2026-11-01T00:00:00Z' });
  m.record({ meter: 'tokens', units: 2_000_000, feature: 'summaries', tenant: 'acme', at: '2026-11-02T00:00:00Z' });
  m.record({ meter: 'emails', units: 300, feature: 'digests', tenant: 'beta', at: '2026-11-02T00:00:00Z' });
  m.record({ meter: 'tokens', units: 5, feature: 'summaries', tenant: 'acme', at: '2026-10-31T00:00:00Z' });
  assert.deepEqual(m.bill('2026-11'), [{ meter: 'tokens', feature: 'summaries', tenant: 'acme', units: 2_001_000, cents: 600 }, { meter: 'emails', feature: 'digests', tenant: 'beta', units: 300, cents: 3 }]);
  assert.equal(m.spent('2026-11', { tenant: 'beta' }), 3);
  assert.throws(() => m.record({ meter: 'gpu', units: 1, feature: 'x', tenant: 'y', at: '2026-11-01' }), /no rate/);
  assert.throws(() => m.record({ meter: 'emails', units: -1, feature: 'x', tenant: 'y', at: '2026-11-01' }), /negative/);
});

test('budgets warn once at each step, a hard budget stops spending, and the forecast says early', () => {
  const warned: string[] = [];
  const m = new Meter(rates, [{ name: 'summaries', cents: 100, feature: 'summaries', hard: true }], (b, f) => void warned.push(`${b.name}@${f}`));
  const use = (units: number, day: string) => m.record({ meter: 'tokens', units, feature: 'summaries', tenant: 'acme', at: `2026-11-${day}T00:00:00Z` });
  use(1000 + 100_000, '01');
  assert.deepEqual(warned, []);
  use(100_000, '02');
  assert.deepEqual(warned, ['summaries@0.5']);
  use(100_000, '02');
  assert.deepEqual(warned, ['summaries@0.5', 'summaries@0.8']);
  assert.equal(m.forecast('2026-11', new Date('2026-11-03T00:00:00Z'), { feature: 'summaries' }).over.length, 1, '90 cents in two days runs far past 100 by month end');
  assert.equal(m.allowed('summaries', 'acme', '2026-11'), true);
  use(200_000, '03');
  assert.deepEqual(warned, ['summaries@0.5', 'summaries@0.8', 'summaries@1']);
  assert.equal(m.allowed('summaries', 'acme', '2026-11'), false);
  assert.equal(m.allowed('digests', 'acme', '2026-11'), true, 'other features carry on');
  assert.equal(m.allowed('summaries', 'acme', '2026-12'), true, 'a new month starts fresh');
});
