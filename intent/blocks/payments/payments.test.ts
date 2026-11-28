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

/** A provider whose next charge goes through but the answer is lost, like a timeout after the card was charged. */
class LostAnswer extends TwinProvider {
  lose = false;
  readonly keysSeen: string[] = [];
  override async charge(customer: string, method: string, amount: ReturnType<typeof money>, key: string) {
    this.keysSeen.push(key);
    const c = await super.charge(customer, method, amount, key);
    if (this.lose) {
      this.lose = false;
      throw new Error('socket hang up');
    }
    return c;
  }
}

test('a renewal whose answer is lost is retried with the same key: never free, never charged twice', async () => {
  let t = 0;
  const p = new LostAnswer();
  const b = new Billing(p, [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }], { now: () => t });
  const s = await b.subscribe('cy', 'pro', M.ok);
  t = 30 * DAY;
  p.lose = true;
  await b.tick().catch(() => {});
  assert.notEqual(s.state, 'active', 'not active on an unknown outcome');
  await b.tick();
  assert.equal(s.state, 'active');
  assert.equal(b.invoices[1]!.state, 'paid');
  assert.equal(p.keysSeen[1], p.keysSeen[2], 'the retry reuses the key');
  assert.equal([...p.charges.values()].filter((c) => c.state === 'succeeded').length, 2, 'one charge per period');
});

test('a past-due subscription retries its own invoice, not another one of the same customer', async () => {
  let t = 0;
  const b = new Billing(new TwinProvider(), [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }], { now: () => t, retryDays: [1, 3] });
  const a = await b.subscribe('dee', 'pro', M.ok);
  t = 10 * DAY;
  const other = await b.subscribe('dee', 'pro', M.ok);
  a.method = M.insufficient;
  other.method = M.insufficient;
  t = 30 * DAY;
  await b.tick();
  const own = b.invoices.at(-1)!;
  t = 40 * DAY;
  await b.tick();
  assert.deepEqual([a.state, other.state], ['past_due', 'past_due']);
  a.method = M.ok;
  t = 41 * DAY;
  await b.tick();
  assert.equal(own.state, 'paid', 'the renewal of a was paid with a’s card');
  assert.equal(a.state, 'active');
  assert.equal(b.invoices.at(-1)!.state, 'open', 'the other subscription’s invoice is still owed');
});

test('a plan change whose payment fails is undone rather than given away', async () => {
  let t = 0;
  const b = new Billing(new TwinProvider(), [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }, { id: 'max', price: money(9000, 'USD'), periodDays: 30 }], { now: () => t });
  const s = await b.subscribe('fay', 'pro', M.ok);
  s.method = M.declined;
  t = 15 * DAY;
  await assert.rejects(b.change(s.id, 'max'), /did not go through/);
  assert.equal(s.plan, 'pro');
  assert.equal(b.invoices.at(-1)!.state, 'void');
});

test('a cancelled subscription cannot change plan, and a downgrade credit is used on the next invoice', async () => {
  let t = 0;
  const b = new Billing(new TwinProvider(), [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }, { id: 'basic', price: money(1000, 'USD'), periodDays: 30 }], { now: () => t });
  const s = await b.subscribe('eve', 'pro', M.ok);
  t = 15 * DAY;
  const down = await b.change(s.id, 'basic');
  assert.equal(down.total, -1000, 'half of 3000 back, half of 1000 owed');
  t = 30 * DAY;
  await b.tick();
  const renewal = b.invoices.at(-1)!;
  assert.deepEqual(renewal.lines.map((l) => l.amount), [1000, -1000]);
  assert.equal(renewal.total, 0);
  b.cancel(s.id, false);
  await assert.rejects(b.change(s.id, 'pro'), /cancelled/);
  await assert.rejects(b.change(99, 'pro'), /no subscription/);
});

test('a first payment the customer must confirm leaves the subscription waiting, and confirming it pays the invoice and starts it', async () => {
  let t = 0;
  const p = new TwinProvider();
  const b = new Billing(p, [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }], { now: () => t, retryDays: [1, 3] });
  const s = await b.subscribe('gil', 'pro', M.needsAction);
  assert.equal(s.state, 'requires_action', 'not refused, not past due');
  const inv = b.invoices[0]!;
  assert.equal(inv.state, 'open', 'the invoice is not voided');
  assert.equal(p.charges.get(inv.charge!)!.state, 'requires_action', 'the invoice holds the charge to confirm');
  t = DAY;
  await b.tick();
  assert.equal(p.charges.size, 1, 'waiting on the customer is not a reason to charge again');
  const settled = await b.confirm(inv.charge!);
  assert.equal(settled, inv);
  assert.equal(inv.state, 'paid');
  assert.equal(s.state, 'active');
  await assert.rejects(b.confirm(inv.charge!), /no open invoice is waiting on charge/);
  const late = await b.subscribe('hal', 'pro', M.needsAction);
  t = 4 * DAY;
  await b.tick();
  assert.equal(late.state, 'cancelled', 'never confirmed by the last retry day');
  assert.equal(b.invoices.at(-1)!.state, 'void');
});

test('a renewal or a plan change that needs confirmation waits for it, and the confirmation settles that invoice', async () => {
  let t = 0;
  const p = new TwinProvider();
  const b = new Billing(p, [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }, { id: 'max', price: money(9000, 'USD'), periodDays: 30 }], { now: () => t });
  const s = await b.subscribe('ivy', 'pro', M.ok);
  s.method = M.needsAction;
  t = 15 * DAY;
  const change = await b.change(s.id, 'max');
  assert.equal(change.state, 'open');
  assert.equal(s.plan, 'pro', 'the new plan waits for the payment');
  assert.equal(s.state, 'active');
  await b.confirm(change.charge!);
  assert.equal(change.state, 'paid');
  assert.equal(s.plan, 'max', 'confirmed: the change takes effect');
  t = 30 * DAY;
  await b.tick();
  const renewal = b.invoices.at(-1)!;
  assert.equal(s.state, 'requires_action', 'not past due: the customer has a charge to confirm');
  assert.equal(renewal.state, 'open');
  await b.confirm(renewal.charge!);
  assert.equal(renewal.state, 'paid');
  assert.equal(s.state, 'active');
  assert.equal([...p.charges.values()].filter((c) => c.state === 'succeeded').length, 3, 'one charge per invoice');
});

test('subscribe with an idempotency key: a retry gets the same subscription and creates no second invoice', async () => {
  const p = new TwinProvider();
  const b = new Billing(p, [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }], { now: () => 0 });
  const [a, again] = await Promise.all([b.subscribe('jo', 'pro', M.ok, { idempotencyKey: 'k1' }), b.subscribe('jo', 'pro', M.ok, { idempotencyKey: 'k1' })]);
  assert.equal(a, again);
  assert.equal(await b.subscribe('jo', 'pro', M.ok, { idempotencyKey: 'k1' }), a);
  assert.equal(b.subs.length, 1);
  assert.equal(b.invoices.length, 1);
  assert.equal(p.calls, 1);
  await assert.rejects(b.subscribe('jo', 'pro', M.declined, { idempotencyKey: 'k1' }), /used with different details/);
  await assert.rejects(b.subscribe('kim', 'pro', M.declined, { idempotencyKey: 'k2' }), /did not go through/);
  await assert.rejects(b.subscribe('kim', 'pro', M.declined, { idempotencyKey: 'k2' }), /did not go through/);
  assert.equal(b.invoices.length, 2, 'the refused retry did not invoice again');
  assert.notEqual(await b.subscribe('jo', 'pro', M.ok), a, 'without a key, each call is a new subscription');
});

test('a confirmation that fails ends a first invoice, drops a plan change, and sends a renewal to the retry schedule', async () => {
  class Refuses extends TwinProvider {
    override async confirm(id: string) {
      const c = this.charges.get(id)!;
      c.state = 'failed';
      return c;
    }
  }
  let t = 0;
  const b = new Billing(new Refuses(), [{ id: 'pro', price: money(3000, 'USD'), periodDays: 30 }, { id: 'max', price: money(9000, 'USD'), periodDays: 30 }], { now: () => t });
  const first = await b.subscribe('lu', 'pro', M.needsAction);
  await b.confirm(b.invoices[0]!.charge!);
  assert.deepEqual([b.invoices[0]!.state, first.state], ['void', 'cancelled']);
  const s = await b.subscribe('mo', 'pro', M.ok);
  s.method = M.needsAction;
  t = 10 * DAY;
  const change = await b.change(s.id, 'max');
  await b.confirm(change.charge!);
  assert.deepEqual([change.state, s.plan, s.state], ['void', 'pro', 'active']);
  t = 30 * DAY;
  await b.tick();
  await b.confirm(b.invoices.at(-1)!.charge!);
  assert.deepEqual([b.invoices.at(-1)!.state, s.state], ['open', 'past_due']);
});
