import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvoiceBook, type Party } from '../invoices/index.ts';
import { money } from '../money/index.ts';
import { TEST_METHODS, TwinProvider, type Charge, type Money as PMoney, type Provider } from '../payments/index.ts';
import { BillingError, Subscriptions, monthlyValue, periodAt, prorate, type Plan } from './index.ts';

const usd = (n: number) => money(n, 'USD');
const at = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date | undefined) => d?.toISOString().slice(0, 10);
const seller: Party = { name: 'SaaS Co' };
const buyer: Party = { name: 'Customer Ltd' };

const PLANS: Plan[] = [
  { id: 'basic', name: 'Basic', price: usd(3000), interval: { unit: 'month', count: 1 }, tax: 'NONE' },
  { id: 'basic30', name: 'Basic', price: usd(3000), interval: { unit: 'day', count: 30 }, tax: 'NONE' },
  { id: 'pro30', name: 'Pro', price: usd(6000), interval: { unit: 'day', count: 30 }, tax: 'NONE' },
  { id: 'yearly', name: 'Basic yearly', price: usd(30000), interval: { unit: 'year', count: 1 }, tax: 'NONE' },
  { id: 'trial', name: 'Trial plan', price: usd(3000), interval: { unit: 'month', count: 1 }, trialDays: 14, tax: 'NONE' },
  { id: 'taxed', name: 'Taxed', price: usd(1000), interval: { unit: 'month', count: 1 }, tax: 'VAT' },
];

function setup(o: { provider?: Provider; dunning?: { retryDays: number[]; then: 'cancel' | 'unpaid' } } = {}) {
  let n = 0;
  const book = new InvoiceBook({ rates: { NONE: { code: 'NONE', name: 'None', rateBp: 0 }, VAT: { code: 'VAT', name: 'VAT', rateBp: 2000 } }, newId: () => `d${++n}` });
  const twin = new TwinProvider();
  let m = 0;
  const subs = new Subscriptions({ plans: PLANS, book, provider: o.provider ?? twin, seller, newId: () => `sub${++m}`, ...(o.dunning ? { dunning: o.dunning } : {}) });
  const start = (planId: string, when: string, method: string = TEST_METHODS.ok, extra: { quantity?: number; key?: string } = {}) => subs.start({ customer: 'cus1', buyer, planId, method, at: at(when), key: extra.key ?? `k-${planId}-${when}`, ...(extra.quantity !== undefined ? { quantity: extra.quantity } : {}) });
  return { book, twin, subs, start };
}

test('periods follow the anchor, so a 31st never drifts to the 28th', () => {
  const a = new Date('2026-01-31T09:30:00Z');
  const month = { unit: 'month', count: 1 } as const;
  assert.deepEqual([1, 2, 3, 13].map((k) => iso(periodAt(a, month, k))), ['2026-02-28', '2026-03-31', '2026-04-30', '2027-02-28']);
  assert.equal(periodAt(a, month, 1).toISOString(), '2026-02-28T09:30:00.000Z', 'the time of day is kept');
  assert.equal(iso(periodAt(at('2028-01-31'), month, 1)), '2028-02-29');
  assert.equal(iso(periodAt(at('2024-02-29'), { unit: 'year', count: 1 }, 1)), '2025-02-28');
  assert.equal(iso(periodAt(at('2024-02-29'), { unit: 'year', count: 4 }, 1)), '2028-02-29');
  assert.equal(iso(periodAt(at('2026-01-01'), { unit: 'week', count: 2 }, 3)), '2026-02-12');
  assert.equal(iso(periodAt(at('2026-01-01'), { unit: 'day', count: 30 }, 1)), '2026-01-31');
  assert.equal(iso(periodAt(at('2026-01-31'), { unit: 'month', count: 3 }, 1)), '2026-04-30');
  assert.throws(() => periodAt(a, { unit: 'month', count: 0 }, 1), BillingError);
});

test('proration is by the second and rounds half-even once', () => {
  const s = at('2026-01-01');
  const e = at('2026-01-31');
  assert.equal(prorate(usd(3000), at('2026-01-11'), e, s, e).minor, 2000n);
  assert.equal(prorate(usd(1), at('2026-01-16'), e, s, e).minor, 0n, '0.5 goes to the even 0');
  assert.equal(prorate(usd(3), at('2026-01-16'), e, s, e).minor, 2n, '1.5 goes to the even 2');
  assert.equal(prorate(usd(3000), s, e, s, e).minor, 3000n);
  assert.equal(prorate(usd(3000), e, at('2026-02-10'), s, e).minor, 0n, 'nothing outside the period');
  assert.throws(() => prorate(usd(1), s, e, s, s), BillingError);
});

test('starting bills the first period at once, and a repeat of the request is the same subscription', async () => {
  const { book, twin, subs, start } = setup();
  const s = await start('basic', '2026-01-31');
  assert.equal(s.state, 'active');
  assert.equal(book.list().length, 1);
  const inv = book.get('INV-2026-00001');
  assert.equal(inv.totals.total.minor, 3000n);
  assert.equal(inv.status, 'paid');
  assert.ok(inv.totals.lines[0]!.description.startsWith('Basic (2026-01-31 to 2026-02-28)'));
  assert.equal(iso(subs.nextBill(s)), '2026-02-28');
  assert.equal(twin.charges.size, 1);
  const again = await start('basic', '2026-01-31');
  assert.equal(again.id, s.id);
  assert.equal(book.list().length, 1, 'nothing billed twice');
  await assert.rejects(() => subs.start({ customer: 'cus1', buyer, planId: 'basic', method: TEST_METHODS.ok, at: at('2026-01-31'), key: 'k-basic-2026-01-31', quantity: 5 }), /different details/);
  await assert.rejects(() => start('basic', '2026-02-01', TEST_METHODS.ok, { quantity: 0, key: 'q' }), /whole number/);
  await assert.rejects(() => start('nope', '2026-02-01'), /no plan/);
});

test('run bills what is due once, catches up in order, and keeps the anniversary', async () => {
  const { book, subs, start } = setup();
  const s = await start('basic', '2026-01-31');
  assert.deepEqual((await subs.run(at('2026-02-27'))).billed, []);
  const r1 = await subs.run(at('2026-02-28'));
  assert.equal(r1.billed.length, 1);
  assert.deepEqual((await subs.run(at('2026-02-28'))).billed, [], 'a second run bills nothing');
  assert.equal(iso(subs.nextBill(s)), '2026-03-31');
  const r2 = await subs.run(at('2026-05-31'));
  assert.equal(r2.billed.length, 3, 'March, April and May');
  assert.equal(iso(subs.nextBill(s)), '2026-06-30');
  assert.equal(book.list().length, 5);
  assert.equal(book.list().every((d) => d.status === 'paid'), true);
});

test('a trial bills nothing until it ends, then bills in full', async () => {
  const { book, subs, start } = setup();
  const s = await start('trial', '2026-03-01');
  assert.equal(s.state, 'trialing');
  assert.equal(book.list().length, 0);
  assert.equal(iso(subs.nextBill(s)), '2026-03-15');
  assert.equal((await subs.run(at('2026-03-14'))).billed.length, 0);
  const r = await subs.run(at('2026-03-15'));
  assert.equal(r.billed.length, 1);
  assert.equal(s.state, 'active');
  assert.equal(iso(subs.nextBill(s)), '2026-04-15', 'the anniversary is the trial end');
});

test('an upgrade in mid-period credits the unused old price and charges the rest of the new one', async () => {
  const { book, twin, subs, start } = setup();
  const s = await start('basic30', '2026-01-01');
  await subs.change(s.id, 'pro30', at('2026-01-11'));
  assert.equal(s.planId, 'pro30');
  const inv = book.get('INV-2026-00002');
  assert.equal(inv.totals.total.minor, 2000n, 'new 4000 for 20 days less old 2000 unused');
  assert.equal(inv.status, 'paid');
  assert.deepEqual([...twin.charges.values()].map((c) => c.amount.amount), [3000, 2000]);
  assert.equal(iso(subs.nextBill(s)), '2026-01-31', 'the period does not move');
  await subs.run(at('2026-01-31'));
  assert.equal(book.get('INV-2026-00003').totals.total.minor, 6000n);
});

test('a downgrade keeps the difference as credit and takes it off the next invoice', async () => {
  const { book, subs, start } = setup();
  const s = await start('pro30', '2026-01-01');
  await subs.change(s.id, 'basic30', at('2026-01-11'));
  assert.equal(s.credit, 2000n);
  assert.equal(book.list().length, 1, 'no invoice now');
  await subs.run(at('2026-01-31'));
  const inv = book.get('INV-2026-00002');
  assert.deepEqual([inv.totals.lineNet.minor, inv.totals.allowance.minor, inv.totals.total.minor], [3000n, 2000n, 1000n]);
  assert.equal(s.credit, 0n);
});

test('a charge from a change can wait for the renewal, and a change can wait for the period end', async () => {
  const { book, subs, start } = setup();
  const s = await start('basic30', '2026-01-01');
  await subs.change(s.id, 'pro30', at('2026-01-11'), { proration: 'renewal' });
  assert.equal(book.list().length, 1);
  assert.equal(s.pendingCharge, 2000n);
  await subs.run(at('2026-01-31'));
  const inv = book.get('INV-2026-00002');
  assert.deepEqual(inv.totals.lines.map((l) => l.net.minor), [6000n, 2000n]);
  assert.equal(s.pendingCharge, 0n);
  const t = setup();
  const u = await t.start('pro30', '2026-01-01');
  await t.subs.change(u.id, 'basic30', at('2026-01-05'), { when: 'period-end' });
  assert.equal(u.planId, 'pro30');
  await t.subs.run(at('2026-01-31'));
  assert.equal(u.planId, 'basic30');
  assert.equal(t.book.get('INV-2026-00002').totals.total.minor, 3000n);
});

test('a plan with another interval starts a new period at once, credited for what is unused', async () => {
  const { book, twin, subs, start } = setup();
  const s = await start('basic', '2026-01-01');
  await subs.change(s.id, 'yearly', at('2026-01-16'));
  const inv = book.get('INV-2026-00002');
  assert.deepEqual([inv.totals.lineNet.minor, inv.totals.allowance.minor, inv.totals.total.minor], [30000n, 1548n, 28452n], '16 of 31 days of 3000 is 1548.4');
  assert.equal([...twin.charges.values()].at(-1)!.amount.amount, 28452);
  assert.equal(iso(subs.nextBill(s)), '2027-01-16');
  await assert.rejects(() => subs.change(s.id, 'basic', at('2026-01-17'), { quantity: 0 }), /whole number/);
});

test('quantity changes are prorated like plan changes, and tax is carried through', async () => {
  const { book, subs, start } = setup();
  const s = await start('basic30', '2026-01-01', TEST_METHODS.ok, { quantity: 2 });
  assert.equal(book.get('INV-2026-00001').totals.total.minor, 6000n);
  await subs.change(s.id, 'basic30', at('2026-01-16'), { quantity: 4 });
  assert.equal(s.quantity, 4);
  const inv = book.get('INV-2026-00002');
  assert.equal(inv.totals.total.minor, 3000n, 'half a period of two more seats');
  const t = setup();
  await t.start('taxed', '2026-01-01');
  const d = t.book.get('INV-2026-00001');
  assert.deepEqual([d.totals.net.minor, d.totals.tax.minor, d.totals.total.minor], [1000n, 200n, 1200n]);
  assert.equal([...t.twin.charges.values()][0]!.amount.amount, 1200, 'the card is charged the invoice total');
});

test('pause stops billing; resuming can extend the period by the pause or keep the billing day', async () => {
  const a = setup();
  const s = await a.start('basic30', '2026-01-01');
  a.subs.pause(s.id, at('2026-01-11'));
  assert.equal(a.subs.nextBill(s), undefined);
  assert.equal((await a.subs.run(at('2026-02-20'))).billed.length, 0, 'nothing bills while paused');
  assert.throws(() => a.subs.pause(s.id, at('2026-02-21')), /paused subscription/);
  await a.subs.resume(s.id, at('2026-01-26'));
  assert.equal(iso(a.subs.nextBill(s)), '2026-02-15', '15 days later than the original end');
  assert.equal(a.book.list().length, 1);
  assert.equal((await a.subs.run(at('2026-02-14'))).billed.length, 0);
  assert.equal((await a.subs.run(at('2026-02-15'))).billed.length, 1);

  const b = setup();
  const m = await b.start('basic', '2026-01-01');
  b.subs.pause(m.id, at('2026-01-10'));
  await b.subs.resume(m.id, at('2026-02-10'), 'keep-anchor');
  const inv = b.book.get('INV-2026-00002');
  assert.equal(inv.totals.total.minor, 2036n, '19 of 28 days of 3000 is 2035.7');
  assert.equal(iso(b.subs.nextBill(m)), '2026-03-01');
  await assert.rejects(() => b.subs.resume(m.id, at('2026-02-11')), /not paused/);
});

test('a declined card is retried on the schedule and the subscription is cancelled after the last retry', async () => {
  const { book, subs, start } = setup();
  const s = await start('basic', '2026-01-01', TEST_METHODS.declined);
  assert.equal(s.state, 'past_due');
  assert.equal(book.get('INV-2026-00001').status, 'issued');
  assert.equal(iso(s.dunning!.nextTry), '2026-01-02');
  assert.equal((await subs.run(at('2026-01-01'))).retried.length, 0);
  assert.equal((await subs.run(at('2026-01-02'))).retried.length, 1);
  assert.equal(iso(s.dunning!.nextTry), '2026-01-05', 'three days after the second failure');
  await subs.run(at('2026-01-05'));
  assert.equal(iso(s.dunning!.nextTry), '2026-01-12');
  assert.equal((await subs.run(at('2026-02-20'))).billed.length, 0, 'a past-due subscription does not bill its next period');
  assert.equal(s.state, 'cancelled', 'the last retry failed');
  assert.equal(s.cancelReason, 'payment failed after the last retry');
  assert.equal(subs.events.filter((e) => e.type === 'payment.failed').length, 4);
  assert.equal(subs.events.filter((e) => e.type === 'subscription.past_due').length, 1);
  assert.equal(book.get('INV-2026-00001').status, 'issued', 'the invoice stays open for the books');
});

test('a new card between retries settles the invoice and the subscription is active again', async () => {
  const { book, subs, start } = setup({ dunning: { retryDays: [1, 3], then: 'unpaid' } });
  const s = await start('basic', '2026-01-01', TEST_METHODS.insufficient);
  subs.setMethod(s.id, TEST_METHODS.ok);
  const r = await subs.run(at('2026-01-02'));
  assert.deepEqual(r.retried.map((x) => x.paid), [true]);
  assert.equal(s.state, 'active');
  assert.equal(s.dunning, undefined);
  assert.equal(book.get('INV-2026-00001').status, 'paid');
  assert.equal(iso(subs.nextBill(s)), '2026-02-01');
  const u = setup({ dunning: { retryDays: [1], then: 'unpaid' } });
  const x = await u.start('basic', '2026-01-01', TEST_METHODS.declined);
  await u.subs.run(at('2026-01-02'));
  assert.equal(x.state, 'unpaid');
  assert.equal(u.subs.nextBill(x), undefined);
  assert.equal(u.subs.events.at(-1)!.type, 'subscription.unpaid');
});

test('a charge the customer must confirm waits, and confirming settles the invoice', async () => {
  const { book, subs, start } = setup();
  const s = await start('basic', '2026-01-01', TEST_METHODS.needsAction);
  assert.equal(s.state, 'requires_action');
  const r = await subs.run(at('2026-01-20'));
  assert.deepEqual([r.retried.length, r.billed.length], [0, 0]);
  await subs.confirm(s.id, at('2026-01-20'));
  assert.equal(s.state, 'active');
  assert.equal(book.get('INV-2026-00001').status, 'paid');
  await assert.rejects(() => subs.confirm(s.id, at('2026-01-21')), /nothing is waiting/);
});

test('an answer lost on the way never charges a card twice', async () => {
  const twin = new TwinProvider();
  let lost = true;
  const lossy: Provider = {
    async charge(c, m, a: PMoney, k): Promise<Charge> {
      const r = await twin.charge(c, m, a, k);
      if (lost) {
        lost = false;
        throw new Error('connection reset');
      }
      return r;
    },
    confirm: (id) => twin.confirm(id),
    refund: (id, a, k) => twin.refund(id, a, k),
  };
  const { book, subs, start } = setup({ provider: lossy });
  const s = await start('basic', '2026-01-01');
  assert.equal(s.state, 'past_due');
  assert.equal(s.dunning!.unsure, true);
  await subs.run(at('2026-01-01'));
  assert.equal(s.state, 'active');
  assert.equal(twin.charges.size, 1, 'the retry reused the idempotency key');
  assert.equal(book.get('INV-2026-00001').status, 'paid');
});

test('cancelling at once or at period end, and nothing bills after', async () => {
  const a = setup();
  const s = await a.start('basic', '2026-01-01');
  a.subs.cancel(s.id, at('2026-01-10'), { atPeriodEnd: true });
  assert.equal(s.state, 'active');
  const r = await a.subs.run(at('2026-03-01'));
  assert.deepEqual([r.billed.length, r.cancelled], [0, [s.id]]);
  assert.equal(iso(s.cancelledAt), '2026-02-01');
  assert.equal(a.book.list().length, 1);
  assert.throws(() => a.subs.cancel(s.id, at('2026-03-02')), /already/);
  const b = setup();
  const t = await b.start('basic', '2026-01-01');
  b.subs.cancel(t.id, at('2026-01-10'), { reason: 'asked to' });
  assert.deepEqual([t.state, t.cancelReason, b.subs.nextBill(t)], ['cancelled', 'asked to', undefined]);
  await assert.rejects(() => b.subs.change(t.id, 'pro30', at('2026-01-11')), /cancelled/);
  assert.equal((await b.subs.run(at('2026-06-01'))).billed.length, 0);
});

test('monthly value normalises any interval for dashboards', () => {
  assert.equal(monthlyValue(PLANS.find((p) => p.id === 'yearly')!).minor, 2500n);
  assert.equal(monthlyValue(PLANS.find((p) => p.id === 'basic')!, 3).minor, 9000n);
  assert.equal(monthlyValue({ id: 'w', name: 'w', price: usd(100), interval: { unit: 'week', count: 1 }, tax: 'NONE' }).minor, 435n, '100 a week is 434.8 a month');
});
