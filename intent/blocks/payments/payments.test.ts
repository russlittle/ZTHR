import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Billing, TEST_METHODS as M, TwinProvider, money } from './index.ts';

const DAY = 86_400_000;

test('the twin: declines, confirmation, idempotency and partial refunds', async () => {
  const p = new TwinProvider();
  assert.throws(() => money(10.5, 'USD'), /whole minor units/);
  const a = await p.charge('c1', M.ok, money(1000, 'USD'), 'k1');
  const again = await p.charge('c1', M.ok, money(1000, 'USD'), 'k1');
  assert.equal(again.id, a.id, 'a retried request does not charge twice');
  await assert.rejects(p.charge('c1', M.ok, money(999, 'USD'), 'k1'), /different details/);
  assert.equal((await p.charge('c1', M.declined, money(1000, 'USD'), 'k2')).failure, 'card_declined');
  const s = await p.charge('c1', M.needsAction, money(500, 'USD'), 'k3');
  assert.equal(s.state, 'requires_action');
  assert.equal((await p.confirm(s.id)).state, 'succeeded');
  await p.refund(a.id, 400, 'r1');
  await p.refund(a.id, 400, 'r1');
  assert.equal(p.charges.get(a.id)!.refunded, 400);
  await assert.rejects(p.refund(a.id, 700, 'r2'), /at most 600/);
});

test('trials, renewals, prorated plan changes and cancel at period end', async () => {
  let t = Date.parse('2026-11-01T00:00:00Z');
  const b = new Billing(new TwinProvider(), [{ id: 'basic', price: money(1000, 'USD'), periodDays: 30, trialDays: 14 }, { id: 'pro', price: money(3000, 'USD'), periodDays: 30 }], { now: () => t });
  const s = await b.subscribe('ana', 'basic', M.ok);
  assert.equal(s.state, 'trialing');
  assert.equal(b.invoices.length, 0, 'nothing is charged during a trial');
  t += 14 * DAY;
  await b.tick();
  assert.equal(s.state, 'active');
  assert.deepEqual(b.invoices.map((i) => [i.total, i.state]), [[1000, 'paid']]);
  t += 15 * DAY;
  const inv = await b.change(s.id, 'pro');
  assert.deepEqual(inv.lines.map((l) => l.amount), [-500, 1500], 'half the period left');
  assert.equal(inv.total, 1000);
  assert.equal(inv.state, 'paid');
  b.cancel(s.id);
  t += 15 * DAY;
  await b.tick();
  assert.equal(s.state, 'cancelled');
  assert.equal(b.invoices.length, 2, 'no renewal after cancelling');
  await assert.rejects(b.subscribe('ben', 'pro', M.declined), /did not go through/);
});

test('a failed renewal is retried on schedule, recovers, or ends uncollectible and cancelled', async () => {
  let t = 0;
  const b = new Billing(new TwinProvider(), [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }], { now: () => t, retryDays: [1, 3] });
  const s = await b.subscribe('cy', 'pro', M.ok);
  s.method = M.insufficient;
  t = 30 * DAY;
  await b.tick();
  assert.equal(s.state, 'past_due');
  t += DAY / 2;
  await b.tick();
  assert.equal(b.invoices[1]!.attempts, 1, 'not retried before a day has passed');
  t = 31 * DAY;
  await b.tick();
  assert.equal(b.invoices[1]!.attempts, 2);
  t = 33 * DAY;
  await b.tick();
  assert.equal(b.invoices[1]!.state, 'uncollectible');
  assert.equal(s.state, 'cancelled');
});
