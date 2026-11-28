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

test('money is added up in whole micro-cents and rounded half up, with no float drift', () => {
  const m = new Meter([{ meter: 'calls', unit: 'call', microCentsPerUnit: 1000 }, { meter: 'tiny', unit: 'call', microCentsPerUnit: 100_000 }]);
  m.record({ meter: 'calls', units: 1005, feature: 'f', tenant: 't', at: '2026-11-01T00:00:00Z' });
  assert.equal(m.spent('2026-11'), 1.01, '1.005 cents is 1.01, not 1.00');
  for (let i = 0; i < 3; i++) m.record({ meter: 'tiny', units: 1, feature: 'g', tenant: 't', at: '2026-11-02T00:00:00Z' });
  assert.equal(m.bill('2026-11', { feature: 'g' })[0]!.cents, 0.3);
});

test('usage must be a finite number', () => {
  const m = new Meter(rates);
  assert.throws(() => m.record({ meter: 'emails', units: Infinity, feature: 'x', tenant: 'y', at: '2026-11-01' }), /finite/);
});

test('recording a use costs the same work however many came before it, and the running totals match the bill', () => {
  let reads = 0;
  /** A use that counts every read of its fields, so work per record can be measured without a clock. */
  const counted = (u: { meter: string; units: number; feature: string; tenant: string; at: string }) => {
    const o = {};
    for (const [k, v] of Object.entries(u)) Object.defineProperty(o, k, { enumerable: true, get: () => (reads++, v) });
    return o as typeof u;
  };
  const budgets = [{ name: 'all', cents: 1e9 }, { name: 'acme', cents: 1e9, tenant: 'acme' }, { name: 'f1', cents: 50, feature: 'f1', hard: true }];
  const m = new Meter(rates, budgets);
  const n = 2000;
  for (let i = 0; i < n; i++) m.record(counted({ meter: i % 3 ? 'tokens' : 'emails', units: 700 + i, feature: `f${i % 4}`, tenant: i % 2 ? 'acme' : 'beta', at: `2026-11-${String(1 + Math.floor(i / 100)).padStart(2, '0')}T00:00:00Z` }));
  assert.ok(reads < 40 * n, `${reads} field reads for ${n} uses: work grows with the uses already recorded`);
  for (const t of [{}, { tenant: 'acme' }, { feature: 'f1' }]) {
    const b = budgets.find((x) => (x.tenant ?? undefined) === t.tenant && (x.feature ?? undefined) === (t as { feature?: string }).feature)!;
    assert.equal(m.allowed(b.feature ?? 'f0', b.tenant ?? 'beta', '2026-11'), !b.hard || m.spent('2026-11', t) < b.cents);
  }
  assert.equal(m.allowed('f1', 'beta', '2026-11'), false, 'the hard budget for f1 is spent');
});

test('a use dated before ones already recorded takes the free units it is owed, and budgets see the same cents as the bill', () => {
  const warned: [string, number, number][] = [];
  const m = new Meter(rates, [{ name: 'acme', cents: 100, tenant: 'acme', warnAt: [0.001] }, { name: 'beta', cents: 100, tenant: 'beta', warnAt: [0.001] }], (b, f, c) => void warned.push([b.name, f, c]));
  m.record({ meter: 'tokens', units: 1000, feature: 'x', tenant: 'acme', at: '2026-11-10T00:00:00Z' });
  assert.equal(m.spent('2026-11', { tenant: 'acme' }), 0, 'acme used the free units');
  m.record({ meter: 'tokens', units: 1000, feature: 'x', tenant: 'beta', at: '2026-11-01T00:00:00Z' });
  assert.equal(m.spent('2026-11', { tenant: 'beta' }), 0, 'beta came first, so the free units were its');
  assert.equal(m.spent('2026-11', { tenant: 'acme' }), 0.3);
  assert.deepEqual(warned, [['acme', 0.001, 0.3]], 'the budget saw acme lose the free units');
});
