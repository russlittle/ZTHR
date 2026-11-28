/**
 * Shopping carts. A cart holds lines (a product and a whole quantity, one line per product), coupon codes and an
 * owner: a signed-in customer, or an anonymous browser. Adding the same product again adds to its line; caps on
 * quantity and line count stop runaway carts. Prices are never kept on a line: every change asks the pricing
 * block for a fresh quote, and `recalc` says what moved since the shopper last saw it (a price, a coupon that no
 * longer applies, a product with no price, stock that ran low, a reservation that lapsed) instead of silently
 * changing the total. When an inventory is given, a cart can hold its stock for a limited time, one reservation per
 * line, kept in step as quantities change and released when the cart is emptied, expires or becomes an order.
 * Signing in merges the anonymous cart into the customer's own (quantities summed up to the cap, or the larger of
 * the two, coupons joined, reservations moved) or simply hands it over when the customer has none; merging twice
 * is harmless. Abandoned carts are found in stages (an hour, a day) for identified owners only, each stage reported
 * once, and stale carts expire. A change that names the version it saw is refused if the cart moved on.
 *
 * Out of scope: shipping and tax (the checkout block), saved-for-later lists, and sending the reminders.
 */
import type { Inventory } from '../inventory/index.ts';
import { priceOf, quote, redeem as redeemCoupons, type Catalog, type Customer, type Quote, type RedemptionLog } from '../pricing/index.ts';
import type { Money } from '../money/index.ts';

export class CartError extends Error {
  readonly code: string;
  constructor(code: string, why: string) {
    super(why);
    this.name = 'CartError';
    this.code = code;
  }
}

export interface Owner {
  readonly customer?: string;
  readonly anon?: string;
}
export interface CartLine {
  readonly sku: string;
  readonly qty: number;
  readonly reserved: boolean;
}
export type CartStatus = 'open' | 'converted' | 'merged' | 'expired';
export interface Cart {
  readonly id: string;
  readonly owner: Owner;
  readonly currency: string;
  readonly lines: readonly CartLine[];
  readonly coupons: readonly string[];
  readonly status: CartStatus;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly quote?: Quote;
  readonly remindedStage: number;
  readonly reservedUntil?: number;
  readonly mergedInto?: string;
  readonly orderId?: string;
}

export interface Issue {
  readonly sku?: string;
  readonly code: 'no-price' | 'low-stock' | 'reservation-lapsed' | 'coupon-refused' | 'reservation-failed';
  readonly message: string;
}
export interface Change {
  readonly sku: string;
  readonly was: Money;
  readonly now: Money;
}
export interface Recalculated {
  readonly cart: Cart;
  readonly quote: Quote;
  readonly changes: readonly Change[];
  readonly issues: readonly Issue[];
}

export interface Options {
  readonly catalog: Catalog | (() => Catalog);
  readonly now: () => number;
  readonly newId: () => string;
  readonly currency: string;
  readonly customers?: (id: string) => Customer;
  readonly inventory?: Inventory;
  /** Where stock is held and taken from. */
  readonly place?: string;
  readonly redemptions?: RedemptionLog;
  readonly maxQty?: number;
  readonly maxLines?: number;
  readonly reserveTtlMs?: number;
  /** Idle times for reminder stages 1 and 2, and for expiry. */
  readonly stagesMs?: readonly [number, number];
  readonly expireAfterMs?: number;
}

type Mut = { -readonly [K in keyof Cart]: K extends 'lines' ? { sku: string; qty: number; reserved: boolean }[] : K extends 'coupons' ? string[] : Cart[K] };

export class Carts {
  private readonly carts = new Map<string, Mut>();
  private readonly o: Required<Pick<Options, 'now' | 'newId' | 'currency'>> & Options & { maxQty: number; maxLines: number; reserveTtlMs: number; stagesMs: readonly [number, number]; expireAfterMs: number };

  constructor(o: Options) {
    this.o = { maxQty: 99, maxLines: 100, reserveTtlMs: 15 * 60_000, stagesMs: [60 * 60_000, 24 * 60 * 60_000], expireAfterMs: 30 * 24 * 60 * 60_000, ...o };
  }

  private cat(): Catalog {
    return typeof this.o.catalog === 'function' ? this.o.catalog() : this.o.catalog;
  }
  private get(id: string): Mut {
    const c = this.carts.get(id);
    if (!c) throw new CartError('unknown-cart', `no cart ${id}`);
    return c;
  }
  private open(id: string, expected?: number): Mut {
    const c = this.get(id);
    if (c.status !== 'open') throw new CartError('not-open', `cart ${id} is ${c.status}`);
    if (expected !== undefined && c.version !== expected) throw new CartError('stale', `cart ${id} is at version ${c.version}, not ${expected}`);
    return c;
  }
  /** A change by the shopper: new version, idle time starts again, and reminders may be sent again. A recalculation only moves the version. */
  private touch(c: Mut, shopper = true): void {
    c.version++;
    if (shopper) {
      c.updatedAt = this.o.now();
      c.remindedStage = 0;
    }
  }
  private snap(c: Mut): Cart {
    return structuredClone(c);
  }
  private customerOf(c: Mut): Customer {
    return c.owner.customer && this.o.customers ? this.o.customers(c.owner.customer) : { id: c.owner.customer ?? c.owner.anon ?? c.id, groups: [] };
  }
  private ref(c: Mut, sku: string): string {
    return `${c.id}#${sku}`;
  }

  // -------------------------------------------------------------------------------------------- basic operations

  create(owner: Owner): Cart {
    if ((owner.customer === undefined) === (owner.anon === undefined)) throw new CartError('bad-owner', 'a cart has a customer or an anonymous id, not both and not neither');
    const now = this.o.now();
    const c: Mut = { id: this.o.newId(), owner: { ...owner }, currency: this.o.currency, lines: [], coupons: [], status: 'open', version: 1, createdAt: now, updatedAt: now, remindedStage: 0 };
    this.carts.set(c.id, c);
    return this.snap(c);
  }
  cart(id: string): Cart {
    return this.snap(this.get(id));
  }
  /** The customer's open cart, if they have one. */
  openCartOf(customer: string): Cart | undefined {
    const c = [...this.carts.values()].find((x) => x.status === 'open' && x.owner.customer === customer);
    return c ? this.snap(c) : undefined;
  }

  /** Add units of a product; the same product adds to its line. Quantity and line count are capped, and the product must have a price. */
  add(id: string, sku: string, qty: number, o: { expectedVersion?: number } = {}): Cart {
    const c = this.open(id, o.expectedVersion);
    this.checkQty(qty);
    const line = c.lines.find((l) => l.sku === sku);
    const total = (line?.qty ?? 0) + qty;
    if (total > this.o.maxQty) throw new CartError('too-many', `at most ${this.o.maxQty} of one product (this would make ${total})`);
    if (!line && c.lines.length >= this.o.maxLines) throw new CartError('too-many-lines', `at most ${this.o.maxLines} products in a cart`);
    this.needPrice(c, sku, total);
    this.changeQty(c, sku, total);
    this.touch(c);
    return this.snap(c);
  }
  setQty(id: string, sku: string, qty: number, o: { expectedVersion?: number } = {}): Cart {
    const c = this.open(id, o.expectedVersion);
    if (!c.lines.some((l) => l.sku === sku)) throw new CartError('no-line', `${sku} is not in the cart`);
    if (qty === 0) return this.remove(id, sku, o);
    this.checkQty(qty);
    if (qty > this.o.maxQty) throw new CartError('too-many', `at most ${this.o.maxQty} of one product`);
    this.needPrice(c, sku, qty);
    this.changeQty(c, sku, qty);
    this.touch(c);
    return this.snap(c);
  }
  remove(id: string, sku: string, o: { expectedVersion?: number } = {}): Cart {
    const c = this.open(id, o.expectedVersion);
    const i = c.lines.findIndex((l) => l.sku === sku);
    if (i < 0) throw new CartError('no-line', `${sku} is not in the cart`);
    this.o.inventory?.release(this.ref(c, sku));
    c.lines.splice(i, 1);
    this.touch(c);
    return this.snap(c);
  }
  clear(id: string): Cart {
    const c = this.open(id);
    for (const l of c.lines) this.o.inventory?.release(this.ref(c, l.sku));
    c.lines.length = 0;
    c.coupons.length = 0;
    delete c.quote;
    delete c.reservedUntil;
    this.touch(c);
    return this.snap(c);
  }
  applyCoupon(id: string, code: string): Cart {
    const c = this.open(id);
    const k = code.trim().toUpperCase();
    if (!k) throw new CartError('bad-coupon', 'a coupon code is needed');
    if (!c.coupons.includes(k)) c.coupons.push(k);
    this.touch(c);
    return this.snap(c);
  }
  removeCoupon(id: string, code: string): Cart {
    const c = this.open(id);
    c.coupons = c.coupons.filter((x) => x !== code.trim().toUpperCase());
    this.touch(c);
    return this.snap(c);
  }

  private checkQty(q: number): void {
    if (!Number.isSafeInteger(q) || q <= 0) throw new CartError('bad-quantity', 'a quantity is a whole number above zero');
  }
  private needPrice(c: Mut, sku: string, qty: number): void {
    try {
      priceOf(this.cat(), sku, qty, this.customerOf(c), c.currency, new Date(this.o.now()));
    } catch (e) {
      throw new CartError('no-price', (e as Error).message);
    }
  }
  /** Set a line's quantity, keeping its reservation in step: the new hold is made before the old one is let go. */
  private changeQty(c: Mut, sku: string, qty: number): void {
    const line = c.lines.find((l) => l.sku === sku);
    const inv = this.o.inventory;
    const wasReserved = line?.reserved ?? false;
    if (inv && this.o.place && wasReserved) {
      const old = inv.reservation(this.ref(c, sku));
      inv.release(this.ref(c, sku));
      try {
        inv.reserve({ ref: this.ref(c, sku), sku, qty, place: this.o.place, ttlMs: this.remainingTtl(c) });
      } catch (e) {
        if (old) inv.reserve({ ref: old.ref, sku, qty: old.allocations.reduce((a, x) => a + x.qty, 0), place: old.place, ...(old.expiresAt !== undefined ? { ttlMs: Math.max(1, old.expiresAt - this.o.now()) } : {}) });
        throw new CartError('insufficient-stock', (e as Error).message);
      }
    }
    if (line) line.qty = qty;
    else c.lines.push({ sku, qty, reserved: false });
  }
  private remainingTtl(c: Mut): number {
    return c.reservedUntil !== undefined ? Math.max(1, c.reservedUntil - this.o.now()) : this.o.reserveTtlMs;
  }

  // ---------------------------------------------------------------------------------------------- reservation

  /** Hold stock for every line for a limited time. All lines or none: a shortage on one releases what was taken. */
  reserve(id: string): Cart {
    const c = this.open(id);
    const inv = this.o.inventory;
    if (!inv || !this.o.place) throw new CartError('no-inventory', 'this shop does not hold stock for carts');
    const taken: string[] = [];
    try {
      for (const l of c.lines) {
        inv.release(this.ref(c, l.sku));
        inv.reserve({ ref: this.ref(c, l.sku), sku: l.sku, qty: l.qty, place: this.o.place, ttlMs: this.o.reserveTtlMs });
        taken.push(l.sku);
      }
    } catch (e) {
      for (const s of taken) inv.release(this.ref(c, s));
      throw new CartError('insufficient-stock', (e as Error).message);
    }
    for (const l of c.lines) l.reserved = true;
    c.reservedUntil = this.o.now() + this.o.reserveTtlMs;
    this.touch(c);
    return this.snap(c);
  }
  releaseStock(id: string): Cart {
    const c = this.open(id);
    for (const l of c.lines) {
      this.o.inventory?.release(this.ref(c, l.sku));
      l.reserved = false;
    }
    delete c.reservedUntil;
    this.touch(c);
    return this.snap(c);
  }

  // -------------------------------------------------------------------------------------------------- pricing

  /**
   * Price the cart afresh. Compared with the quote the shopper last saw: price changes per product; a product with
   * no price is left out of the quote and reported; a refused coupon is dropped and reported; low stock and a lapsed
   * reservation are reported. Nothing is changed silently: the caller shows `changes` and `issues`.
   */
  recalc(id: string): Recalculated {
    const c = this.open(id);
    const issues: Issue[] = [];
    const cat = this.cat();
    const customer = this.customerOf(c);
    const now = new Date(this.o.now());
    const inv = this.o.inventory;
    if (inv) inv.sweep();
    const pricable: { sku: string; qty: number }[] = [];
    for (const l of c.lines) {
      try {
        priceOf(cat, l.sku, l.qty, customer, c.currency, now);
        pricable.push({ sku: l.sku, qty: l.qty });
      } catch (e) {
        issues.push({ sku: l.sku, code: 'no-price', message: (e as Error).message });
      }
      if (inv && this.o.place) {
        const mine = l.reserved && inv.reservation(this.ref(c, l.sku)) ? l.qty : 0;
        if (l.reserved && !mine) {
          l.reserved = false;
          issues.push({ sku: l.sku, code: 'reservation-lapsed', message: `the hold on ${l.sku} ran out` });
        }
        if (inv.available(l.sku, this.o.place) + mine < l.qty) issues.push({ sku: l.sku, code: 'low-stock', message: `only ${Math.max(0, inv.available(l.sku, this.o.place) + mine)} of ${l.sku} left, ${l.qty} in the cart` });
      }
    }
    if (c.reservedUntil !== undefined && !c.lines.some((l) => l.reserved)) delete c.reservedUntil;
    const log = this.o.redemptions;
    const q = quote(cat, { customer, currency: c.currency, lines: pricable, coupons: c.coupons, now }, log);
    for (const r of q.coupons) if (!r.ok) issues.push({ code: 'coupon-refused', message: `coupon ${r.code}: ${r.reason}` });
    c.coupons = c.coupons.filter((k) => q.coupons.find((r) => r.code.toUpperCase() === k)?.ok !== false);
    const changes: Change[] = [];
    for (const l of q.lines) {
      const was = c.quote?.lines.find((x) => x.sku === l.sku);
      if (was && was.unit.minor !== l.unit.minor) changes.push({ sku: l.sku, was: was.unit, now: l.unit });
    }
    c.quote = q;
    this.touch(c, false);
    return { cart: this.snap(c), quote: q, changes, issues };
  }

  // ------------------------------------------------------------------------------------------ merge on sign-in

  /**
   * The anonymous cart meets the customer's. With no cart of their own, the customer takes the anonymous one
   * over. With one, lines are merged (`sum`, capped, or `max`), coupons joined, and held stock moved to the
   * surviving cart; the anonymous cart is marked merged and points at it. Calling again changes nothing.
   */
  mergeOnLogin(anonId: string, customerId: string, o: { policy?: 'sum' | 'max' } = {}): { cart: Cart; issues: readonly Issue[] } {
    const anon = this.get(anonId);
    if (anon.owner.anon === undefined) throw new CartError('bad-owner', 'only an anonymous cart is merged on sign-in');
    if (anon.status === 'merged') return { cart: this.snap(this.get(anon.mergedInto!)), issues: [] };
    if (anon.status !== 'open') throw new CartError('not-open', `cart ${anonId} is ${anon.status}`);
    const mine = [...this.carts.values()].find((x) => x.status === 'open' && x.owner.customer === customerId);
    if (!mine) {
      anon.owner = { customer: customerId };
      for (const l of anon.lines) l.reserved = l.reserved && !!this.o.inventory?.reservation(this.ref(anon, l.sku));
      this.touch(anon);
      return { cart: this.snap(anon), issues: [] };
    }
    const issues: Issue[] = [];
    const policy = o.policy ?? 'sum';
    const inv = this.o.inventory;
    for (const l of anon.lines) {
      const wasReserved = l.reserved || (mine.lines.find((x) => x.sku === l.sku)?.reserved ?? false);
      if (inv) inv.release(this.ref(anon, l.sku));
      const into = mine.lines.find((x) => x.sku === l.sku);
      const qty = Math.min(this.o.maxQty, policy === 'sum' ? (into?.qty ?? 0) + l.qty : Math.max(into?.qty ?? 0, l.qty));
      if (!into && mine.lines.length >= this.o.maxLines) {
        issues.push({ sku: l.sku, code: 'no-price', message: `${l.sku} was left out: the cart is full` });
        continue;
      }
      try {
        this.needPrice(mine, l.sku, qty);
      } catch (e) {
        issues.push({ sku: l.sku, code: 'no-price', message: (e as Error).message });
        continue;
      }
      if (into) into.qty = qty;
      else mine.lines.push({ sku: l.sku, qty, reserved: false });
      if (wasReserved && inv && this.o.place) {
        const line = mine.lines.find((x) => x.sku === l.sku)!;
        inv.release(this.ref(mine, l.sku));
        try {
          inv.reserve({ ref: this.ref(mine, l.sku), sku: l.sku, qty, place: this.o.place, ttlMs: this.remainingTtl(mine) });
          line.reserved = true;
        } catch (e) {
          line.reserved = false;
          issues.push({ sku: l.sku, code: 'reservation-failed', message: (e as Error).message });
        }
      }
    }
    for (const k of anon.coupons) if (!mine.coupons.includes(k)) mine.coupons.push(k);
    anon.status = 'merged';
    anon.mergedInto = mine.id;
    anon.lines = [];
    this.touch(anon);
    this.touch(mine);
    return { cart: this.snap(mine), issues };
  }

  // -------------------------------------------------------------------------------------------------- lifecycle

  /** The cart became an order: its stock hold is taken over by the caller (released here unless `keepHold`), coupons are counted, and the cart is closed. */
  markConverted(id: string, orderId: string, o: { keepHold?: boolean } = {}): Cart {
    const c = this.open(id);
    if (!c.quote) throw new CartError('not-priced', 'price the cart before it becomes an order');
    if (!o.keepHold) for (const l of c.lines) this.o.inventory?.release(this.ref(c, l.sku));
    if (this.o.redemptions && c.owner.customer) redeemCoupons(c.quote, this.cat(), this.customerOf(c), this.o.redemptions);
    c.status = 'converted';
    c.orderId = orderId;
    this.touch(c);
    return this.snap(c);
  }

  /** Open carts with items that have sat idle past a reminder stage not yet sent. Only carts whose owner is known are listed unless asked. */
  abandoned(o: { anonymousToo?: boolean } = {}): { cart: string; stage: 1 | 2; idleMs: number; customer?: string }[] {
    const now = this.o.now();
    const out: { cart: string; stage: 1 | 2; idleMs: number; customer?: string }[] = [];
    for (const c of this.carts.values()) {
      if (c.status !== 'open' || !c.lines.length) continue;
      if (c.owner.customer === undefined && !o.anonymousToo) continue;
      const idle = now - c.updatedAt;
      const stage = idle >= this.o.stagesMs[1] ? 2 : idle >= this.o.stagesMs[0] ? 1 : 0;
      if (stage > c.remindedStage) out.push({ cart: c.id, stage: stage as 1 | 2, idleMs: idle, ...(c.owner.customer ? { customer: c.owner.customer } : {}) });
    }
    return out.sort((a, b) => b.idleMs - a.idleMs || a.cart.localeCompare(b.cart));
  }
  markReminded(id: string, stage: 1 | 2): void {
    const c = this.get(id);
    c.remindedStage = Math.max(c.remindedStage, stage);
  }
  /** Close carts idle longer than the expiry, releasing their stock. */
  expireStale(): string[] {
    const now = this.o.now();
    const out: string[] = [];
    for (const c of this.carts.values()) {
      if (c.status !== 'open' || now - c.updatedAt < this.o.expireAfterMs) continue;
      for (const l of c.lines) this.o.inventory?.release(this.ref(c, l.sku));
      c.status = 'expired';
      out.push(c.id);
    }
    return out;
  }
}
