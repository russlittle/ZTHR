/**
 * Payments and billing behind a provider interface, with a twin that behaves like a card provider (declines, a
 * card that needs the customer to confirm, idempotency keys, partial refunds), so every path is tested without a
 * real account. Money is integer minor units with a currency, never floats. Billing on top: plans, subscriptions
 * with trials, plan changes prorated to the second, invoices with line items, retries on failed renewals that end
 * in cancellation, and cancel-at-period-end. Prices and totals are always worked out here, never trusted from a
 * client.
 */

export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export const money = (amount: number, currency: string): Money => {
  if (!Number.isInteger(amount)) throw new Error('money is whole minor units (cents), not a fraction');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${currency} is not a currency code`);
  return { amount, currency };
};

export type ChargeState = 'succeeded' | 'requires_action' | 'failed';

export interface Charge {
  readonly id: string;
  readonly customer: string;
  readonly amount: Money;
  state: ChargeState;
  refunded: number;
  readonly failure?: string;
}

export interface Provider {
  charge(customer: string, method: string, amount: Money, idempotencyKey: string): Promise<Charge>;
  confirm(chargeId: string): Promise<Charge>;
  refund(chargeId: string, amount: number, idempotencyKey: string): Promise<Charge>;
}

/** Test cards, by method id: the same ideas real providers use. */
export const TEST_METHODS = { ok: 'pm_card_ok', declined: 'pm_card_declined', insufficient: 'pm_card_insufficient', needsAction: 'pm_card_3ds' } as const;

export class TwinProvider implements Provider {
  readonly charges = new Map<string, Charge>();
  private readonly keys = new Map<string, { body: string; result: Charge }>();
  private n = 0;
  calls = 0;

  private once(key: string, body: unknown, f: () => Charge): Charge {
    const b = JSON.stringify(body);
    const seen = this.keys.get(key);
    if (seen) {
      if (seen.body !== b) throw new Error('this idempotency key was used with different details');
      return seen.result;
    }
    const result = f();
    this.keys.set(key, { body: b, result });
    return result;
  }

  async charge(customer: string, method: string, amount: Money, idempotencyKey: string): Promise<Charge> {
    this.calls++;
    return this.once(idempotencyKey, ['charge', customer, method, amount], () => {
      if (amount.amount <= 0) throw new Error('amount must be positive');
      const id = `ch_${++this.n}`;
      const c: Charge =
        method === TEST_METHODS.declined ? { id, customer, amount, state: 'failed', refunded: 0, failure: 'card_declined' }
        : method === TEST_METHODS.insufficient ? { id, customer, amount, state: 'failed', refunded: 0, failure: 'insufficient_funds' }
        : method === TEST_METHODS.needsAction ? { id, customer, amount, state: 'requires_action', refunded: 0 }
        : { id, customer, amount, state: 'succeeded', refunded: 0 };
      this.charges.set(id, c);
      return c;
    });
  }

  async confirm(chargeId: string): Promise<Charge> {
    const c = this.charges.get(chargeId);
    if (!c) throw new Error(`no charge ${chargeId}`);
    if (c.state === 'requires_action') c.state = 'succeeded';
    return c;
  }

  async refund(chargeId: string, amount: number, idempotencyKey: string): Promise<Charge> {
    return this.once(idempotencyKey, ['refund', chargeId, amount], () => {
      const c = this.charges.get(chargeId);
      if (!c || c.state !== 'succeeded') throw new Error('only a succeeded charge can be refunded');
      if (!Number.isInteger(amount) || amount <= 0 || c.refunded + amount > c.amount.amount) throw new Error(`at most ${c.amount.amount - c.refunded} can still be refunded`);
      c.refunded += amount;
      return { ...c };
    });
  }
}

export interface Plan {
  readonly id: string;
  readonly price: Money;
  readonly periodDays: number;
  readonly trialDays?: number;
}

export interface Line {
  readonly description: string;
  readonly amount: number;
}

export interface Invoice {
  readonly id: number;
  readonly customer: string;
  readonly currency: string;
  readonly lines: readonly Line[];
  readonly total: number;
  state: 'open' | 'paid' | 'void' | 'uncollectible';
  attempts: number;
  charge?: string;
}

export interface Subscription {
  readonly id: number;
  readonly customer: string;
  plan: string;
  method: string;
  state: 'trialing' | 'active' | 'past_due' | 'cancelled';
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
}

const DAY = 86_400_000;

export class Billing {
  readonly plans: Map<string, Plan>;
  readonly subs: Subscription[] = [];
  readonly invoices: Invoice[] = [];
  private readonly p: Provider;
  private readonly now: () => number;
  /** Days after a failed renewal to retry; after the last, the subscription is cancelled. */
  private readonly retryDays: readonly number[];

  constructor(p: Provider, plans: readonly Plan[], o: { now?: () => number; retryDays?: readonly number[] } = {}) {
    this.p = p;
    this.plans = new Map(plans.map((x) => [x.id, x]));
    this.now = o.now ?? Date.now;
    this.retryDays = o.retryDays ?? [1, 3, 7];
  }

  private plan(id: string): Plan {
    const p = this.plans.get(id);
    if (!p) throw new Error(`no plan ${id}`);
    return p;
  }

  private async collect(inv: Invoice, s: Subscription): Promise<boolean> {
    if (inv.total <= 0) {
      inv.state = 'paid';
      return true;
    }
    inv.attempts++;
    const c = await this.p.charge(inv.customer, s.method, money(inv.total, inv.currency), `inv-${inv.id}-try-${inv.attempts}`);
    inv.charge = c.id;
    if (c.state === 'succeeded') inv.state = 'paid';
    return c.state === 'succeeded';
  }

  private invoice(customer: string, currency: string, lines: Line[]): Invoice {
    const inv: Invoice = { id: this.invoices.length + 1, customer, currency, lines, total: lines.reduce((s, l) => s + l.amount, 0), state: 'open', attempts: 0 };
    this.invoices.push(inv);
    return inv;
  }

  async subscribe(customer: string, planId: string, method: string): Promise<Subscription> {
    const p = this.plan(planId);
    const t = this.now();
    const trial = (p.trialDays ?? 0) * DAY;
    const s: Subscription = { id: this.subs.length + 1, customer, plan: p.id, method, state: trial ? 'trialing' : 'active', periodStart: t, periodEnd: t + (trial || p.periodDays * DAY), cancelAtPeriodEnd: false };
    if (!trial) {
      const inv = this.invoice(customer, p.price.currency, [{ description: `${p.id}, first period`, amount: p.price.amount }]);
      if (!(await this.collect(inv, s))) {
        inv.state = 'void';
        throw new Error('the first payment did not go through');
      }
    }
    this.subs.push(s);
    return s;
  }

  /** Changes plan now, crediting the unused part of the old plan and charging the rest of the period on the new. */
  async change(subId: number, planId: string): Promise<Invoice> {
    const s = this.subs[subId - 1]!;
    const from = this.plan(s.plan);
    const to = this.plan(planId);
    if (from.price.currency !== to.price.currency) throw new Error('a plan change cannot switch currency');
    const t = this.now();
    const left = Math.max(0, s.periodEnd - t) / (s.periodEnd - s.periodStart);
    const lines: Line[] = s.state === 'trialing' ? [] : [{ description: `unused ${from.id}`, amount: -Math.round(from.price.amount * left) }, { description: `remaining ${to.id}`, amount: Math.round(to.price.amount * left) }];
    s.plan = to.id;
    const inv = this.invoice(s.customer, to.price.currency, lines);
    if (inv.total < 0) inv.state = 'paid';
    else await this.collect(inv, s);
    return inv;
  }

  cancel(subId: number, atPeriodEnd = true): void {
    const s = this.subs[subId - 1]!;
    if (atPeriodEnd) s.cancelAtPeriodEnd = true;
    else s.state = 'cancelled';
  }

  /** Renews what is due and retries what failed; run it often. */
  async tick(): Promise<void> {
    const t = this.now();
    for (const s of this.subs) {
      if (s.state === 'cancelled') continue;
      if (s.state === 'past_due') {
        const inv = [...this.invoices].reverse().find((i) => i.customer === s.customer && i.state === 'open')!;
        const due = s.periodStart + (this.retryDays[inv.attempts - 1] ?? Infinity) * DAY;
        if (t < due) continue;
        if (await this.collect(inv, s)) s.state = 'active';
        else if (inv.attempts > this.retryDays.length) {
          inv.state = 'uncollectible';
          s.state = 'cancelled';
        }
        continue;
      }
      if (t < s.periodEnd) continue;
      if (s.cancelAtPeriodEnd) {
        s.state = 'cancelled';
        continue;
      }
      const p = this.plan(s.plan);
      s.periodStart = s.periodEnd;
      s.periodEnd = s.periodStart + p.periodDays * DAY;
      const inv = this.invoice(s.customer, p.price.currency, [{ description: `${p.id} renewal`, amount: p.price.amount }]);
      s.state = (await this.collect(inv, s)) ? 'active' : 'past_due';
    }
  }
}
