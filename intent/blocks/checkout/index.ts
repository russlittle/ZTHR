/**
 * Checkout: the walk from a cart to a placed order, as a state machine that cannot be talked out of its order.
 * Address (checked per country by the contact block, a name and an email) leads to shipping (options offered for
 * that address; the choice must be one of them), which fixes the tax and the total, which leads to payment, which
 * ends in review and then a placed order. Going back is allowed until the payment is taken; changing the address
 * or the cart afterwards sends the shopper back to shipping or payment with the new numbers rather than charging
 * a total they did not see. Every amount is worked out here from the cart's fresh quote (the pricing block),
 * never read from the client. Payment goes through the payments provider with a key made from the checkout, the
 * attempt and the amount, so a retry cannot charge twice, a card that needs confirmation waits for it, and a
 * decline leaves the shopper on the payment step with the reason. Placing the order is idempotent: the same
 * checkout, or the same key, returns the same order, two calls at once place one order, and if anything fails after
 * money was taken the charge is refunded. The stock hold made at the start (the cart block's reservation) is
 * refreshed before charging and handed to the order, which keeps the hold references for the warehouse.
 *
 * Out of scope: how shipping options and tax rates are found (they are functions given in), digital delivery,
 * and the order's life after placing (fulfilment, returns).
 */
import { checkAddress, type Address } from '../contact/index.ts';
import { add, money, times, type Money } from '../money/index.ts';
import type { Cart, Carts, Issue } from '../cart/index.ts';
import type { Provider } from '../payments/index.ts';
import type { Quote } from '../pricing/index.ts';

export class CheckoutError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, why: string, details?: unknown) {
    super(why);
    this.name = 'CheckoutError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface Party extends Address {
  readonly name: string;
}
export interface ShippingOption {
  readonly id: string;
  readonly label: string;
  readonly price: Money;
  readonly etaDays?: number;
}
export interface Totals {
  readonly currency: string;
  readonly goods: Money;
  readonly discount: Money;
  readonly shipping: Money;
  readonly tax: Money;
  readonly taxRateBps: number;
  readonly taxLabel: string;
  readonly total: Money;
}
export type Step = 'address' | 'shipping' | 'payment' | 'review' | 'placed' | 'cancelled' | 'expired';
export interface Payment {
  readonly attempt: number;
  readonly status: 'none' | 'requires_action' | 'succeeded' | 'failed';
  readonly chargeId?: string;
  readonly amount?: Money;
  readonly failure?: string;
}
export interface Checkout {
  readonly id: string;
  readonly cartId: string;
  readonly step: Step;
  readonly email?: string;
  readonly shippingTo?: Party;
  readonly billingTo?: Party;
  readonly options: readonly ShippingOption[];
  readonly shipping?: ShippingOption;
  readonly totals?: Totals;
  readonly payment: Payment;
  readonly notices: readonly string[];
  readonly orderId?: string;
  readonly expiresAt: number;
  readonly trail: readonly { at: number; step: Step; note: string }[];
}
export interface OrderLine {
  readonly sku: string;
  readonly qty: number;
  readonly unit: Money;
  readonly total: Money;
}
export interface Order {
  readonly id: string;
  readonly number: string;
  readonly checkoutId: string;
  readonly cartId: string;
  readonly customer?: string;
  readonly email: string;
  readonly lines: readonly OrderLine[];
  readonly totals: Totals;
  readonly shippingTo: Party;
  readonly billingTo: Party;
  readonly shipping: ShippingOption;
  readonly chargeId: string;
  readonly placedAt: number;
  /** The stock holds the warehouse turns into moves when it ships. */
  readonly holds: readonly string[];
}

export interface Options {
  readonly carts: Carts;
  readonly provider: Provider;
  readonly shippingOptions: (to: Address, goods: Money) => readonly ShippingOption[];
  readonly taxFor: (to: Address) => { bps: number; label: string };
  readonly now: () => number;
  readonly newId: () => string;
  readonly newOrderNumber: () => string;
  readonly ttlMs?: number;
  /** Whether shipping is taxed too. Default false. */
  readonly taxShipping?: boolean;
}

type Rec = { -readonly [K in keyof Checkout]: K extends 'trail' | 'notices' | 'options' ? Checkout[K][number][] : K extends 'payment' ? { -readonly [P in keyof Payment]: Payment[P] } : Checkout[K] } & { fingerprint?: string; key?: string };

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const BLOCKING: readonly Issue['code'][] = ['no-price', 'low-stock', 'reservation-failed'];

export class Checkouts {
  private readonly all = new Map<string, Rec>();
  private readonly orders = new Map<string, Order>();
  private readonly byKey = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<Order>>();
  private readonly o: Options & { ttlMs: number };

  constructor(o: Options) {
    this.o = { ttlMs: 30 * 60_000, ...o };
  }

  private rec(id: string): Rec {
    const c = this.all.get(id);
    if (!c) throw new CheckoutError('unknown-checkout', `no checkout ${id}`);
    if (c.step !== 'placed' && c.step !== 'cancelled' && c.step !== 'expired' && this.o.now() > c.expiresAt) this.lapse(c);
    return c;
  }
  private live(id: string): Rec {
    const c = this.rec(id);
    if (c.step === 'placed' || c.step === 'cancelled' || c.step === 'expired') throw new CheckoutError('closed', `this checkout is ${c.step}`);
    return c;
  }
  private log(c: Rec, note: string): void {
    c.trail.push({ at: this.o.now(), step: c.step, note });
    c.expiresAt = this.o.now() + this.o.ttlMs;
  }
  private snap(c: Rec): Checkout {
    const { fingerprint: _f, key: _k, ...rest } = c;
    return structuredClone(rest);
  }
  private lapse(c: Rec): void {
    c.step = 'expired';
    try {
      this.o.carts.releaseStock(c.cartId);
    } catch {
      /* the cart may be closed already */
    }
    c.trail.push({ at: this.o.now(), step: 'expired', note: 'idle too long' });
  }
  private leftOf(m: Money, cur: string): Money {
    return m.currency === cur ? m : money(0, cur);
  }
  private payMoney(m: Money): { amount: number; currency: string } {
    if (m.minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new CheckoutError('too-large', 'the amount is too large to charge');
    return { amount: Number(m.minor), currency: m.currency };
  }

  // -------------------------------------------------------------------------------------------------- steps

  /** Begin (or resume) checkout for a cart. The cart is priced afresh and its stock held; problems stop it here, with the list. */
  start(cartId: string, o: { email?: string } = {}): Checkout {
    for (const c of this.all.values()) if (c.cartId === cartId && (c.step === 'address' || c.step === 'shipping' || c.step === 'payment' || c.step === 'review') && this.o.now() <= c.expiresAt) return this.snap(c);
    if (o.email !== undefined && !EMAIL.test(o.email)) throw new CheckoutError('bad-email', 'that does not look like an email address');
    const r = this.o.carts.recalc(cartId);
    if (!r.cart.lines.length) throw new CheckoutError('empty-cart', 'the cart is empty');
    const blocking = r.issues.filter((i) => BLOCKING.includes(i.code));
    if (blocking.length) throw new CheckoutError('cart-problems', blocking.map((b) => b.message).join('; '), blocking);
    try {
      this.o.carts.reserve(cartId);
    } catch (e) {
      throw new CheckoutError('out-of-stock', (e as Error).message);
    }
    const now = this.o.now();
    const c: Rec = { id: this.o.newId(), cartId, step: 'address', ...(o.email ? { email: o.email } : {}), options: [], payment: { attempt: 0, status: 'none' }, notices: [], expiresAt: now + this.o.ttlMs, trail: [], fingerprint: this.fingerprint(r.quote) };
    this.log(c, 'started');
    this.all.set(c.id, c);
    return this.snap(c);
  }

  checkout(id: string): Checkout {
    return this.snap(this.rec(id));
  }

  private fingerprint(q: Quote): string {
    return JSON.stringify([q.lines.map((l) => [l.sku, l.qty, String(l.unit.minor), String(l.total.minor)]), String(q.total.minor)]);
  }
  private checkParty(p: Party, what: string): void {
    if (!p.name.trim()) throw new CheckoutError('bad-address', `${what}: a name is needed`, ['a name is needed']);
    if (!/^[A-Z]{2}$/.test(p.country)) throw new CheckoutError('bad-address', `${what}: the country is a two-letter code`, ['country']);
    const problems = checkAddress(p);
    if (!p.city?.trim()) problems.push('add a city');
    if (problems.length) throw new CheckoutError('bad-address', `${what}: ${problems.join('; ')}`, problems);
  }
  private locked(c: Rec): void {
    if (c.payment.status === 'succeeded' || c.payment.status === 'requires_action') throw new CheckoutError('payment-started', 'payment is under way: cancel the checkout to change the order');
  }

  /** Set where to ship and bill. The shipping options are offered for this address; a chosen option that is no longer offered is dropped. */
  setAddress(id: string, a: { shippingTo: Party; billingTo?: Party; email?: string }): Checkout {
    const c = this.live(id);
    this.locked(c);
    this.checkParty(a.shippingTo, 'shipping address');
    const billing = a.billingTo ?? a.shippingTo;
    this.checkParty(billing, 'billing address');
    const email = a.email ?? c.email;
    if (!email || !EMAIL.test(email)) throw new CheckoutError('bad-email', 'an email address is needed for the receipt');
    const q = this.fresh(c);
    c.email = email;
    c.shippingTo = structuredClone(a.shippingTo);
    c.billingTo = structuredClone(billing);
    c.options = [...this.o.shippingOptions(a.shippingTo, q.total)].map((x) => ({ ...x }));
    if (!c.options.length) throw new CheckoutError('no-shipping', 'we cannot ship to that address');
    if (c.shipping && !c.options.some((x) => x.id === c.shipping!.id && x.price.minor === c.shipping!.price.minor)) {
      c.notices.push(`the ${c.shipping.label} option is not available for this address`);
      delete c.shipping;
    }
    delete c.totals;
    c.step = 'shipping';
    this.log(c, 'address set');
    if (c.shipping) this.price(c, q);
    return this.snap(c);
  }

  /** Choose one of the offered shipping options. Tax and the total are fixed here. */
  chooseShipping(id: string, optionId: string): Checkout {
    const c = this.live(id);
    this.locked(c);
    if (!c.shippingTo) throw new CheckoutError('out-of-order', 'give the address first');
    const opt = c.options.find((x) => x.id === optionId);
    if (!opt) throw new CheckoutError('bad-option', `${optionId} is not offered for this address`);
    const q = this.fresh(c);
    c.shipping = { ...opt };
    this.price(c, q);
    c.step = 'payment';
    this.log(c, `shipping ${opt.id}`);
    return this.snap(c);
  }

  /** The cart priced afresh; if it differs from what the shopper saw, they are told and the checkout moves back to payment totals. */
  private fresh(c: Rec): Quote {
    const r = this.o.carts.recalc(c.cartId);
    const blocking = r.issues.filter((i) => BLOCKING.includes(i.code));
    if (blocking.length) throw new CheckoutError('cart-problems', blocking.map((b) => b.message).join('; '), blocking);
    if (!r.cart.lines.length) throw new CheckoutError('empty-cart', 'the cart is empty');
    const fp = this.fingerprint(r.quote);
    if (c.fingerprint !== undefined && fp !== c.fingerprint) {
      c.notices.push('the prices or items in your cart changed');
      if (c.step === 'payment' || c.step === 'review') c.step = 'payment';
    }
    c.fingerprint = fp;
    return r.quote;
  }

  private price(c: Rec, q: Quote): void {
    const cur = q.currency;
    const goods = q.total;
    const ship = c.shipping ? this.leftOf(c.shipping.price, cur) : money(0, cur);
    const rate = this.o.taxFor(c.shippingTo!);
    if (!Number.isInteger(rate.bps) || rate.bps < 0 || rate.bps > 10000) throw new CheckoutError('bad-tax', 'a tax rate is whole basis points from 0 to 10000');
    const base = this.o.taxShipping ? add(goods, ship) : goods;
    const tax = times(base, BigInt(rate.bps), 10000n);
    c.totals = { currency: cur, goods, discount: q.discount, shipping: ship, tax, taxRateBps: rate.bps, taxLabel: rate.label, total: add(add(goods, ship), tax) };
  }

  // --------------------------------------------------------------------------------------------------- payment

  /**
   * Take payment for the total as it stands now. The cart is checked again first; if it changed, nothing is charged
   * and the new total is returned for the shopper to accept. The same attempt with the same amount is the same charge.
   */
  async pay(id: string, method: string): Promise<Checkout> {
    const c = this.live(id);
    if (c.step !== 'payment' && c.step !== 'review') throw new CheckoutError('out-of-order', `choose shipping before paying (now at ${c.step})`);
    if (c.payment.status === 'succeeded') return this.snap(c);
    if (c.payment.status === 'requires_action') throw new CheckoutError('needs-confirmation', 'the last payment is waiting to be confirmed');
    const before = c.totals!.total.minor;
    const q = this.fresh(c);
    this.price(c, q);
    if (c.totals!.total.minor !== before) {
      c.notices.push(`the total changed from ${before} to ${c.totals!.total.minor}: nothing was charged`);
      this.log(c, 'total changed before payment');
      return this.snap(c);
    }
    try {
      this.o.carts.reserve(c.cartId);
    } catch (e) {
      throw new CheckoutError('out-of-stock', (e as Error).message);
    }
    const amount = c.totals!.total;
    const attempt = c.payment.attempt + 1;
    c.payment.attempt = attempt;
    const key = `checkout:${c.id}:${attempt}:${amount.minor}:${method}`;
    const customer = this.o.carts.cart(c.cartId).owner.customer ?? c.email!;
    const ch = await this.o.provider.charge(customer, method, this.payMoney(amount), key);
    c.payment.chargeId = ch.id;
    c.payment.amount = amount;
    if (ch.state === 'succeeded') {
      c.payment.status = 'succeeded';
      delete c.payment.failure;
      c.step = 'review';
    } else if (ch.state === 'requires_action') c.payment.status = 'requires_action';
    else {
      c.payment.status = 'failed';
      c.payment.failure = ch.failure ?? 'declined';
    }
    this.log(c, `payment ${c.payment.status}`);
    return this.snap(c);
  }

  /** The shopper completed the extra confirmation (3-D Secure and the like). */
  async confirmPayment(id: string): Promise<Checkout> {
    const c = this.live(id);
    if (c.payment.status !== 'requires_action' || !c.payment.chargeId) throw new CheckoutError('out-of-order', 'no payment is waiting for confirmation');
    const ch = await this.o.provider.confirm(c.payment.chargeId);
    if (ch.state === 'succeeded') {
      c.payment.status = 'succeeded';
      c.step = 'review';
    } else {
      c.payment.status = 'failed';
      c.payment.failure = ch.failure ?? 'declined';
    }
    this.log(c, `payment ${c.payment.status} after confirmation`);
    return this.snap(c);
  }

  // ----------------------------------------------------------------------------------------------------- place

  /** Make the order. The same checkout or key always returns the same order, even when called at the same moment. */
  place(id: string, key?: string): Promise<Order> {
    const c = this.rec(id);
    if (key !== undefined) {
      const prior = this.byKey.get(key);
      if (prior !== undefined && prior !== id) return Promise.reject(new CheckoutError('key-conflict', `key ${key} belongs to another checkout`));
    }
    if (c.orderId) return Promise.resolve(this.orders.get(c.orderId)!);
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.doPlace(c, key).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async doPlace(c: Rec, key?: string): Promise<Order> {
    if (c.step === 'cancelled' || c.step === 'expired') throw new CheckoutError('closed', `this checkout is ${c.step}`);
    if (c.step !== 'review' || c.payment.status !== 'succeeded' || !c.payment.chargeId) throw new CheckoutError('not-paid', 'the order is placed once payment has succeeded');
    try {
      const q = this.fresh(c);
      const before = c.totals!;
      this.price(c, q);
      if (c.totals!.total.minor !== before.total.minor || c.totals!.total.minor !== c.payment.amount!.minor) throw new CheckoutError('total-changed', `the total is ${c.totals!.total.minor} but ${c.payment.amount!.minor} was paid`);
      const cart: Cart = this.o.carts.cart(c.cartId);
      const order: Order = {
        id: `ord_${c.id}`,
        number: this.o.newOrderNumber(),
        checkoutId: c.id,
        cartId: c.cartId,
        ...(cart.owner.customer ? { customer: cart.owner.customer } : {}),
        email: c.email!,
        lines: q.lines.map((l) => ({ sku: l.sku, qty: l.qty, unit: l.unit, total: l.total })),
        totals: c.totals!,
        shippingTo: c.shippingTo!,
        billingTo: c.billingTo!,
        shipping: c.shipping!,
        chargeId: c.payment.chargeId,
        placedAt: this.o.now(),
        holds: cart.lines.filter((l) => l.reserved).map((l) => `${cart.id}#${l.sku}`),
      };
      if (order.holds.length !== cart.lines.length) throw new CheckoutError('out-of-stock', 'the stock hold lapsed before the order could be placed');
      this.o.carts.markConverted(c.cartId, order.id, { keepHold: true });
      this.orders.set(order.id, order);
      c.orderId = order.id;
      c.step = 'placed';
      if (key !== undefined) this.byKey.set(key, c.id);
      this.log(c, `order ${order.number}`);
      return order;
    } catch (e) {
      // money was taken but no order exists: give it back
      let refunded = false;
      try {
        await this.o.provider.refund(c.payment.chargeId, Number(c.payment.amount!.minor), `refund:${c.id}`);
        refunded = true;
      } catch {
        /* reported below */
      }
      if (refunded) {
        c.payment = { attempt: c.payment.attempt, status: 'none' };
        c.step = 'payment';
        c.notices.push('the order could not be placed and the payment was refunded');
        this.log(c, 'placement failed, refunded');
      } else this.log(c, 'placement failed, REFUND FAILED: needs a person');
      if (e instanceof CheckoutError) throw new CheckoutError(e.code, `${e.message}${refunded ? ' (the payment was refunded)' : ' (the refund failed: needs a person)'}`, e.details);
      throw e;
    }
  }

  /** Give up. Stock is released, and a payment already taken is refunded in full. */
  async cancel(id: string): Promise<Checkout> {
    const c = this.live(id);
    if (c.payment.chargeId && c.payment.status === 'succeeded') await this.o.provider.refund(c.payment.chargeId, Number(c.payment.amount!.minor), `cancel:${c.id}`);
    this.o.carts.releaseStock(c.cartId);
    c.step = 'cancelled';
    c.payment = { attempt: c.payment.attempt, status: 'none' };
    this.log(c, 'cancelled');
    return this.snap(c);
  }

  order(id: string): Order | undefined {
    return this.orders.get(id);
  }
}
