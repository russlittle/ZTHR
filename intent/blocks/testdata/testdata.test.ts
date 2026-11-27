import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fake, TEST_CARDS, factory, looksFake } from './index.ts';

test('the same seed gives the same data; a different seed differs', () => {
  const a = new Fake(42);
  const b = new Fake(42);
  const run = (f: Fake) => [f.name().full, f.email(), f.phone(), f.int(1, 100), f.filename()];
  assert.deepEqual(run(a), run(b));
  assert.notDeepEqual(run(new Fake(42)), run(new Fake(43)));
});

test('everything produced is in ranges reserved for fiction, and the guard spots real-looking values', () => {
  const f = new Fake(7);
  for (let i = 0; i < 500; i++) {
    const n = f.name();
    const v = { email: f.email(n.full), phone: f.phone(f.bool() ? 'US' : 'GB'), card: f.pick(Object.values(TEST_CARDS)) };
    assert.ok(looksFake(v), JSON.stringify(v));
    assert.match(v.email, /^[a-z0-9.]+@example\.(com|org|net)$/);
  }
  assert.equal(looksFake({ email: 'ana@gmail.com' }), false);
  assert.equal(looksFake({ phone: '+19375551234' }), false);
  assert.equal(looksFake({ card: '4111111111111112' }), false);
  const d = f.date('2026-01-01', '2026-02-01');
  assert.ok(d >= new Date('2026-01-01') && d < new Date('2026-02-01'));
});

test('factories take overrides and build datasets to a shape', () => {
  const f = new Fake(1);
  const account = factory((fk, i) => ({ id: fk.id('acct'), n: i, name: fk.name().full, plan: fk.pick(['free', 'pro']) }));
  const file = factory((fk) => ({ id: fk.id('file'), name: fk.filename(), size: fk.int(1, 5_000_000) }));
  const data = Array.from({ length: 3 }, () => ({ ...account(f), files: Array.from({ length: 4 }, () => file(f)) }));
  assert.deepEqual(data.map((d) => d.n), [1, 2, 3]);
  assert.equal(new Set(data.flatMap((d) => d.files.map((x) => x.id))).size, 12);
  assert.equal(account(f, { plan: 'enterprise' }).plan, 'enterprise');
});
