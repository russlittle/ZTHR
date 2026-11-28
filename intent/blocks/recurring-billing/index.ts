/**
 * Recurring invoices and subscriptions on top of the invoices block and a payment provider (the payments block's
 * Provider interface, so its twin tests every path). A plan has a price and an interval (days, weeks, months or
 * years). Billing is in advance and follows an anniversary: the periods are the start date plus k intervals,
 * counted from the anchor (not from the last period), so a subscription begun on 31 January bills on 28 February
 * and then on 31 March, never drifting to the 28th. A trial moves the anchor to its end.
 *
 *  - Proration is by the second: a plan or quantity change in the middle of a period credits the unused part of the
 *    old price and charges the remaining part of the new one, either at once (a separate invoice when it is a net
 *    charge) or on the next renewal; a net credit is kept as customer credit and taken off later invoices. A change
 *    to a plan with a different interval starts a new period at once. A change may wait for the period end.
 *  - Pause stops billing. Resuming either extends the period by the time paused (the customer loses nothing) or
 *    keeps the anchor and bills the part of the period that is left.
 *  - Cancelling is at once or at period end. Nothing bills after.
 *  - Dunning: a failed charge leaves the invoice open and the subscription past due, retries on a schedule of days,
 *    and after the last retry cancels (or leaves the subscription unpaid, by policy). A charge the customer has to
 *    confirm waits for `confirm`. A provider error leaves the outcome unknown, and the retry reuses the same
 *    idempotency key, so a card is never charged twice for one invoice try.
 *  - `run(now)` is safe to call as often as you like: it bills what is due, retries what is due, and nothing twice.
 *    A subscription that is past due does not bill its next period.
 *
 * All dates are instants given by the caller; there is no clock in here. Not here: tax by customer location (the
 * plan names one tax code), usage-based charges, coupons, seats that change daily, and a payments webhook (the
 * caller reports an asynchronous result by calling `confirm`).
 */
import { divRound, money, type Money } from '../money/index.ts';
import { InvoiceBook, type Document, type LineInput, type Party } from '../invoices/index.ts';
import type { Provider, Money as ProviderMoney } from '../payments/index.ts';

export class BillingError extends Error {}

export type Unit = 'day' | 'week' | 'month' | 'year';

export interface Interval {
  readonly unit: Unit;
  readonly count: number;
}

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly price: Money;
  readonly interval: Interval;
  readonly trialDays?: number;
  readonly tax: string;
}

export interface Dunning {
  /** Days after the failed attempt for each retry. */
  readonly retryDays: readonly number[];
  /** What happens after the last retry fails. */
  readonly then: 'cancel' | 'unpaid';
}

export type State = 'trialing' | 'active' | 'paused' | 'past_due' | 'requires_action' | 'unpaid' | 'cancelled';

export interface Subscription {
  readonly id: string;
  readonly customer: string;
  readonly buyer: Party;
  method: string;
  planId: string;
  quantity: number;
  state: State;
  startedAt: Date;
  /** The first billing date; later periods are this plus k intervals. */
  anchor: Date;
  /** Number of periods billed from the anchor: the next one to bill is period k. */
  k: number;
  /** Customer credit, in minor units, taken off future invoices. */
  credit: bigint;
  /** Extra charge, in minor units, waiting for the next renewal (a proration chosen to wait). */
  pendingCharge: bigint;
  pausedAt?: Date;
  cancelAtPeriodEnd: boolean;
  pendingChange?: { readonly planId: string; readonly quantity: number };
  cancelledAt?: Date;
  cancelReason?: string;
  /** The open invoice a past-due or waiting subscription is trying to collect, with its retry bookkeeping. */
  dunning?: { invoice: string; attempt: number; nextTry: Date | undefined; charge?: string; unsure: boolean };
}

export interface BillingEvent {
  readonly type: 'subscription.started' | 'invoice.issued' | 'payment.succeeded' | 'payment.failed' | 'payment.requires_action' | 'subscription.past_due' | 'subscription.cancelled' | 'subscription.unpaid' | 'subscription.paused' | 'subscription.resumed' | 'plan.changed';
  readonly subscription: string;
  readonly at: Date;
  readonly invoice?: string;
}

export interface RunReport {
  readonly billed: readonly { readonly subscription: string; readonly invoice: string; readonly paid: boolean }[];
  readonly retried: readonly { readonly subscription: string; readonly invoice: string; readonly paid: boolean }[];
  readonly cancelled: readonly string[];
}

// ---------------------------------------------------------------- the calendar

const DAY = 86_400_000;

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The anchor plus `n` intervals, in UTC, keeping the anchor's day of month where the month is long enough. */
export function periodAt(anchor: Date, i: Interval, n: number): Date {
  if (!Number.isInteger(i.count) || i.count < 1) throw new BillingError('an interval counts at least one unit');
  if (i.unit === 'day') return new Date(anchor.getTime() + n * i.count * DAY);
  if (i.unit === 'week') return new Date(anchor.getTime() + n * i.count * 7 * DAY);
  const months = n * i.count * (i.unit === 'year' ? 12 : 1);
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const day = Math.min(anchor.getUTCDate(), daysIn(y, m));
  return new Date(Date.UTC(y, m, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

/** Part of an amount for the seconds between `from` and `to` out of the whole period, rounded half-even once. */
export function prorate(amount: Money, from: Date, to: Date, periodStart: Date, periodEnd: Date): Money {
  const whole = Math.round((periodEnd.getTime() - periodStart.getTime()) / 1000);
  const part = Math.round((Math.min(to.getTime(), periodEnd.getTime()) - Math.max(from.getTime(), periodStart.getTime())) / 1000);
  if (whole <= 0) throw new BillingError('a period has a length');
  if (part <= 0) return money(0, amount.currency);
  return { minor: divRound(amount.minor * BigInt(part), BigInt(whole)), currency: amount.currency };
}

const dateStr = (d: Date) => d.toISOString().slice(0, 10);
const toProviderMoney = (m: Money): ProviderMoney => {
  if (m.minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new BillingError('amount too large for the provider');
  return { amount: Number(m.minor), currency: m.currency };
};

// ---------------------------------------------------------------- the engine

export interface Options {
  readonly plans: readonly Plan[];
  readonly book: InvoiceBook;
  readonly provider: Provider;
  readonly seller: Party;
  readonly dunning?: Dunning;
  readonly newId: () => string;
  readonly onEvent?: (e: BillingEvent) => void;
}

export interface StartInput {
  readonly customer: string;
  readonly buyer: Party;
  readonly planId: string;
  readonly quantity?: number;
  readonly method: string;
  readonly at: Date;
  /** The caller's key for this request: a repeat returns the same subscription and bills nothing again. */
  readonly key: string;
}

export class Subscriptions {
  readonly subs = new Map<string, Subscription>();
  readonly events: BillingEvent[] = [];
  private readonly plans: Map<string, Plan>;
  private readonly o: Options;
  private readonly dunning: Dunning;
  private readonly keys = new Map<string, { body: string; id: string }>();

  constructor(o: Options) {
    this.o = o;
    this.plans = new Map(o.plans.map((p) => [p.id, p]));
    this.dunning = o.dunning ?? { retryDays: [1, 3, 7], then: 'cancel' };
  }

  plan(id: string): Plan {
    const p = this.plans.get(id);
    if (!p) throw new BillingError(`no plan ${id}`);
    return p;
  }

  get(id: string): Subscription {
    const s = this.subs.get(id);
    if (!s) throw new BillingError(`no subscription ${id}`);
    return s;
  }

  private emit(type: BillingEvent['type'], s: Subscription, at: Date, invoice?: string): void {
    const e: BillingEvent = { type, subscription: s.id, at, ...(invoice !== undefined ? { invoice } : {}) };
    this.events.push(e);
    this.o.onEvent?.(e);
  }

  private unit(s: Subscription): Money {
    const p = this.plan(s.planId);
    return { minor: p.price.minor * BigInt(s.quantity), currency: p.price.currency };
  }

  /** The current period: from the start (or the last billed boundary) to the next billing date. */
  period(s: Subscription): { start: Date; end: Date } {
    const i = this.plan(s.planId).interval;
    return { start: s.k === 0 ? s.startedAt : periodAt(s.anchor, i, s.k - 1), end: periodAt(s.anchor, i, s.k) };
  }

  /** The next date a renewal will be billed, or undefined when nothing will be (paused, cancelled, unpaid). */
  nextBill(s: Subscription): Date | undefined {
    if (s.state === 'cancelled' || s.state === 'paused' || s.state === 'unpaid') return undefined;
    return this.period(s).end;
  }

  // ------------------------------------------------------------ billing one invoice

  private async makeInvoice(s: Subscription, lines: LineInput[], at: Date, credit: boolean): Promise<Document> {
    const p = this.plan(s.planId);
    const cur = p.price.currency;
    let discount: { amount: Money } | undefined;
    if (credit && s.credit > 0n) {
      const subtotal = lines.reduce((a, l) => a + l.unitPrice.minor, 0n);
      const use = s.credit < subtotal ? s.credit : subtotal;
      if (use > 0n) {
        discount = { amount: money(use, cur) };
        s.credit -= use;
      }
    }
    const d = this.o.book.draft({ seller: this.o.seller, buyer: s.buyer, currency: cur, lines, terms: 'due on receipt', ...(discount ? { discount } : {}) });
    const inv = this.o.book.issue(d.id, dateStr(at));
    this.emit('invoice.issued', s, at, inv.number);
    return inv;
  }

  /** Try to collect an invoice. Returns whether it is now paid; sets the subscription's state to match. */
  private async collect(s: Subscription, inv: Document, at: Date, attempt: number): Promise<boolean> {
    const owed = this.o.book.balance(inv.number!);
    if (owed.minor === 0n) return true;
    const key = `${s.id}:${inv.number}:try${attempt}`;
    let charge;
    try {
      charge = await this.o.provider.charge(s.customer, s.method, toProviderMoney(owed), key);
    } catch {
      s.dunning = { invoice: inv.number!, attempt, nextTry: at, unsure: true };
      s.state = 'past_due';
      return false;
    }
    if (charge.state === 'succeeded') {
      this.o.book.pay(inv.number!, owed, dateStr(at), charge.id);
      delete s.dunning;
      if (s.state === 'past_due' || s.state === 'requires_action' || s.state === 'trialing') s.state = 'active';
      this.emit('payment.succeeded', s, at, inv.number);
      return true;
    }
    if (charge.state === 'requires_action') {
      s.state = 'requires_action';
      s.dunning = { invoice: inv.number!, attempt, nextTry: undefined, charge: charge.id, unsure: false };
      this.emit('payment.requires_action', s, at, inv.number);
      return false;
    }
    const next = this.dunning.retryDays[attempt - 1];
    s.state = 'past_due';
    s.dunning = { invoice: inv.number!, attempt, nextTry: next === undefined ? undefined : new Date(at.getTime() + next * DAY), unsure: false };
    this.emit('payment.failed', s, at, inv.number);
    if (attempt === 1) this.emit('subscription.past_due', s, at, inv.number);
    if (next === undefined) {
      if (this.dunning.then === 'cancel') this.cancelNow(s, at, 'payment failed after the last retry');
      else {
        s.state = 'unpaid';
        this.emit('subscription.unpaid', s, at, inv.number);
      }
    }
    return false;
  }

  private periodLine(s: Subscription, from: Date, to: Date, amount?: Money, label?: string): LineInput {
    const p = this.plan(s.planId);
    return { description: `${label ?? p.name}${s.quantity > 1 && !label ? ` x ${s.quantity}` : ''} (${dateStr(from)} to ${dateStr(to)})`, quantity: 1, unitPrice: amount ?? this.unit(s), tax: p.tax };
  }

  // ------------------------------------------------------------ life cycle

  /** Start a subscription. With a trial the first invoice waits for its end; without, the first period bills now. */
  async start(i: StartInput): Promise<Subscription> {
    const body = JSON.stringify([i.customer, i.planId, i.quantity ?? 1, i.method, i.at.getTime()]);
    const seen = this.keys.get(i.key);
    if (seen) {
      if (seen.body !== body) throw new BillingError('this key was used with different details');
      return this.get(seen.id);
    }
    const p = this.plan(i.planId);
    const quantity = i.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) throw new BillingError('quantity is a whole number of at least one');
    const trialEnd = p.trialDays ? new Date(i.at.getTime() + p.trialDays * DAY) : undefined;
    const s: Subscription = { id: this.o.newId(), customer: i.customer, buyer: i.buyer, method: i.method, planId: i.planId, quantity, state: trialEnd ? 'trialing' : 'active', startedAt: i.at, anchor: trialEnd ?? i.at, k: 0, credit: 0n, pendingCharge: 0n, cancelAtPeriodEnd: false };
    this.subs.set(s.id, s);
    this.keys.set(i.key, { body, id: s.id });
    this.emit('subscription.started', s, i.at);
    if (!trialEnd) await this.billPeriod(s, i.at);
    return s;
  }

  /** Bill period k (the one starting at the next billing date) and move on to it. */
  private async billPeriod(s: Subscription, at: Date): Promise<{ invoice: string; paid: boolean }> {
    const p = this.plan(s.planId);
    const from = periodAt(s.anchor, p.interval, s.k);
    const to = periodAt(s.anchor, p.interval, s.k + 1);
    const lines = [this.periodLine(s, from, to)];
    if (s.pendingCharge > 0n) {
      lines.push({ description: 'Plan change adjustments', quantity: 1, unitPrice: money(s.pendingCharge, p.price.currency), tax: p.tax });
      s.pendingCharge = 0n;
    }
    s.k += 1;
    const inv = await this.makeInvoice(s, lines, at, true);
    const paid = await this.collect(s, inv, at, 1);
    return { invoice: inv.number!, paid };
  }

  async run(now: Date): Promise<RunReport> {
    const billed: { subscription: string; invoice: string; paid: boolean }[] = [];
    const retried: { subscription: string; invoice: string; paid: boolean }[] = [];
    const before = new Set([...this.subs.values()].filter((x) => x.state === 'cancelled').map((x) => x.id));
    const all = [...this.subs.values()].sort((a, b) => (this.period(a).end.getTime() - this.period(b).end.getTime()) || a.id.localeCompare(b.id));
    for (const s of all) {
      // retries first, so an invoice that settles lets the next period bill in the same run
      const dn = s.dunning;
      if (dn && s.state === 'past_due' && dn.nextTry && dn.nextTry.getTime() <= now.getTime()) {
        const inv = this.o.book.get(dn.invoice);
        const attempt = dn.unsure ? dn.attempt : dn.attempt + 1;
        const paid = await this.collect(s, inv, now, attempt);
        retried.push({ subscription: s.id, invoice: dn.invoice, paid });
      }
      let guard = 0;
      while (guard++ < 24 && (s.state === 'active' || s.state === 'trialing') && this.period(s).end.getTime() <= now.getTime()) {
        if (s.cancelAtPeriodEnd) {
          this.cancelNow(s, this.period(s).end, 'cancelled at period end');
          break;
        }
        if (s.pendingChange) {
          this.applyChange(s, s.pendingChange.planId, s.pendingChange.quantity, this.period(s).end);
          delete s.pendingChange;
        }
        const r = await this.billPeriod(s, now);
        billed.push({ subscription: s.id, ...r });
      }
    }
    return { billed, retried, cancelled: [...this.subs.values()].filter((x) => x.state === 'cancelled' && !before.has(x.id)).map((x) => x.id) };
  }

  /** A new card or method for the next attempt. */
  setMethod(id: string, method: string): void {
    this.get(id).method = method;
  }

  /** The customer has confirmed the payment the provider asked them to; settle the invoice if the charge went through. */
  async confirm(id: string, at: Date): Promise<Subscription> {
    const s = this.get(id);
    if (s.state !== 'requires_action' || !s.dunning?.charge) throw new BillingError('nothing is waiting for confirmation');
    const c = await this.o.provider.confirm(s.dunning.charge);
    const inv = this.o.book.get(s.dunning.invoice);
    if (c.state === 'succeeded') {
      this.o.book.pay(inv.number!, this.o.book.balance(inv.number!), dateStr(at), c.id);
      delete s.dunning;
      s.state = 'active';
      this.emit('payment.succeeded', s, at, inv.number);
    } else {
      s.state = 'past_due';
      s.dunning = { invoice: inv.number!, attempt: s.dunning.attempt, nextTry: new Date(at.getTime() + (this.dunning.retryDays[s.dunning.attempt - 1] ?? 0) * DAY), unsure: false };
      this.emit('payment.failed', s, at, inv.number);
    }
    return s;
  }

  private cancelNow(s: Subscription, at: Date, reason: string): void {
    s.state = 'cancelled';
    s.cancelledAt = at;
    s.cancelReason = reason;
    delete s.pendingChange;
    this.emit('subscription.cancelled', s, at);
  }

  /** Cancel at once, or at the end of the paid period. */
  cancel(id: string, at: Date, o: { atPeriodEnd?: boolean; reason?: string } = {}): Subscription {
    const s = this.get(id);
    if (s.state === 'cancelled') throw new BillingError('already cancelled');
    if (o.atPeriodEnd) s.cancelAtPeriodEnd = true;
    else this.cancelNow(s, at, o.reason ?? 'cancelled');
    return s;
  }

  // ------------------------------------------------------------ plan changes

  private applyChange(s: Subscription, planId: string, quantity: number, at: Date): void {
    const was = this.plan(s.planId);
    const to = this.plan(planId);
    if (to.price.currency !== was.price.currency) throw new BillingError('a plan change keeps the currency');
    s.planId = planId;
    s.quantity = quantity;
    this.emit('plan.changed', s, at);
  }

  /**
   * Move to another plan or quantity. `when: now` prorates by the second (the default); `period-end` waits.
   * `proration: now` bills a net charge at once; `renewal` adds it to the next invoice. A net credit is kept.
   */
  async change(id: string, planId: string, at: Date, o: { quantity?: number; when?: 'now' | 'period-end'; proration?: 'now' | 'renewal' } = {}): Promise<Subscription> {
    const s = this.get(id);
    if (s.state === 'cancelled' || s.state === 'unpaid') throw new BillingError(`a ${s.state} subscription cannot change plan`);
    if (s.state === 'paused') throw new BillingError('resume before changing the plan');
    const quantity = o.quantity ?? s.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) throw new BillingError('quantity is a whole number of at least one');
    const to = this.plan(planId);
    if (o.when === 'period-end') {
      s.pendingChange = { planId, quantity };
      return s;
    }
    const was = this.plan(s.planId);
    const { start, end } = this.period(s);
    if (s.state === 'trialing') {
      this.applyChange(s, planId, quantity, at);
      return s;
    }
    const oldUnused = prorate({ minor: was.price.minor * BigInt(s.quantity), currency: was.price.currency }, at, end, start, end);
    if (was.interval.unit !== to.interval.unit || was.interval.count !== to.interval.count) {
      // a different interval cannot share the period: start a new one now, crediting what is unused
      s.credit += oldUnused.minor;
      this.applyChange(s, planId, quantity, at);
      s.anchor = at;
      s.k = 0;
      s.startedAt = at;
      const r = await this.billPeriod(s, at);
      void r;
      return s;
    }
    const newRest = prorate({ minor: to.price.minor * BigInt(quantity), currency: to.price.currency }, at, end, start, end);
    const net = newRest.minor - oldUnused.minor;
    this.applyChange(s, planId, quantity, at);
    if (net <= 0n) s.credit += -net;
    else if (o.proration === 'renewal') s.pendingCharge += net;
    else {
      const inv = await this.makeInvoice(s, [{ description: `${to.name} change (${dateStr(at)} to ${dateStr(end)})`, quantity: 1, unitPrice: money(net, to.price.currency), tax: to.tax }], at, false);
      await this.collect(s, inv, at, 1);
    }
    return s;
  }

  // ------------------------------------------------------------ pause

  pause(id: string, at: Date): Subscription {
    const s = this.get(id);
    if (s.state !== 'active' && s.state !== 'trialing') throw new BillingError(`a ${s.state} subscription cannot be paused`);
    s.pausedAt = at;
    s.state = 'paused';
    this.emit('subscription.paused', s, at);
    return s;
  }

  /**
   * `extend`: the period moves later by the time paused, so what was paid for is not lost.
   * `keep-anchor`: periods that passed while paused are skipped and the part of the current period that is left is
   * billed now, so the billing day does not change.
   */
  async resume(id: string, at: Date, mode: 'extend' | 'keep-anchor' = 'extend'): Promise<Subscription> {
    const s = this.get(id);
    if (s.state !== 'paused' || !s.pausedAt) throw new BillingError('not paused');
    if (at.getTime() < s.pausedAt.getTime()) throw new BillingError('cannot resume before the pause began');
    const was = s.pausedAt.getTime();
    delete s.pausedAt;
    s.state = 'active';
    if (mode === 'extend') {
      s.anchor = new Date(s.anchor.getTime() + (at.getTime() - was));
    } else {
      const i = this.plan(s.planId).interval;
      let k = s.k;
      while (periodAt(s.anchor, i, k).getTime() <= at.getTime()) k++;
      const start = periodAt(s.anchor, i, k - 1);
      const end = periodAt(s.anchor, i, k);
      const part = prorate(this.unit(s), at, end, start, end);
      s.k = k;
      if (part.minor > 0n) {
        const inv = await this.makeInvoice(s, [this.periodLine(s, at, end, part)], at, true);
        await this.collect(s, inv, at, 1);
      }
    }
    this.emit('subscription.resumed', s, at);
    return s;
  }
}

/** For dashboards: monthly recurring revenue in minor units of a subscription, whatever its interval. */
export function monthlyValue(p: Plan, quantity = 1): Money {
  const months = p.interval.unit === 'year' ? 12 * p.interval.count : p.interval.unit === 'month' ? p.interval.count : p.interval.unit === 'week' ? (p.interval.count * 7) / (365 / 12) : p.interval.count / (365 / 12);
  const total = p.price.minor * BigInt(quantity);
  if (Number.isInteger(months)) return { minor: divRound(total, BigInt(months)), currency: p.price.currency };
  return { minor: divRound(total * 1_000_000n, BigInt(Math.round(months * 1_000_000))), currency: p.price.currency };
}
