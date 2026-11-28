/**
 * Prices, in the order a shopper would be told them. A price list says what a product costs, by quantity tier,
 * for everyone or for a customer group, between two dates; the most specific live list wins. Promotions and
 * coupons then take amounts off, under stacking rules declared once: promotions that stack are applied in
 * priority order to the running price, promotions that are exclusive compete with the stack (the better for the
 * customer wins), and promotions sharing an exclusion group compete with each other. A coupon is a code that
 * unlocks a promotion, with its own dates, limits (in total and per customer) and a refusal that says why.
 * Everything is whole minor units from the money block, rounded half-even once; amounts taken off an order are
 * spread over its lines so the parts add back exactly. Every quote carries an explanation in words: which list
 * and tier set each price, which promotions applied, which lost and to what, and why a coupon was refused.
 * A manual price override is a separate act that must be allowed by the rbac policy and gives a reason.
 *
 * Out of scope: tax (a tax block's job), currency conversion, and prices that depend on a clock inside the day.
 */
import { add, allocate, money, sub, times, type Money } from '../money/index.ts';
import { decide, type Policy, type Subject } from '../rbac/index.ts';

export class NoPrice extends Error {
  constructor(sku: string, why: string) {
    super(`no price for ${sku}: ${why}`);
    this.name = 'NoPrice';
  }
}
export class NotAllowed extends Error {
  constructor(why: string) {
    super(`price change refused: ${why}`);
    this.name = 'NotAllowed';
  }
}

export interface Tier {
  readonly minQty: number;
  readonly unit: Money;
}
export interface PriceList {
  readonly id: string;
  readonly currency: string;
  /** Higher wins when two lists are live for a customer and both price the product. */
  readonly priority: number;
  /** Customer groups the list is for; absent means everyone. */
  readonly groups?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly entries: Readonly<Record<string, readonly Tier[]>>;
}
export interface Customer {
  readonly id: string;
  readonly groups: readonly string[];
}

export type Effect =
  | { readonly kind: 'percent'; readonly bps: number }
  | { readonly kind: 'amount'; readonly off: Money }
  | { readonly kind: 'fixed'; readonly unit: Money }
  | { readonly kind: 'buy-get'; readonly buy: number; readonly get: number };

export interface Promotion {
  readonly id: string;
  readonly label: string;
  readonly effect: Effect;
  /** Products it applies to; absent means every line. */
  readonly skus?: readonly string[];
  /** Spend on the eligible lines (at list price) needed before it applies. */
  readonly minSubtotal?: Money;
  readonly groups?: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly stacking: 'stack' | 'exclusive';
  /** Promotions in one group never combine: only the best for the customer applies. */
  readonly exclusionGroup?: string;
  /** Lower numbers are applied first. */
  readonly priority: number;
  /** Applies only when a coupon unlocks it. */
  readonly requiresCoupon?: boolean;
}

export interface Coupon {
  readonly code: string;
  readonly promotionId: string;
  readonly from?: string;
  readonly to?: string;
  readonly maxRedemptions?: number;
  readonly perCustomer?: number;
}

export interface Catalog {
  readonly lists: readonly PriceList[];
  readonly promotions: readonly Promotion[];
  readonly coupons: readonly Coupon[];
}

/** How often each coupon has been used, in total and by customer. */
export class RedemptionLog {
  private readonly all = new Map<string, number>();
  private readonly by = new Map<string, number>();
  count(code: string): number {
    return this.all.get(code) ?? 0;
  }
  countBy(code: string, customer: string): number {
    return this.by.get(`${code}\u0000${customer}`) ?? 0;
  }
  record(code: string, customer: string): void {
    this.all.set(code, this.count(code) + 1);
    this.by.set(`${code}\u0000${customer}`, this.countBy(code, customer) + 1);
  }
}

export interface Request {
  readonly customer: Customer;
  readonly currency: string;
  readonly lines: readonly { readonly sku: string; readonly qty: number }[];
  readonly coupons?: readonly string[];
  readonly now: Date;
}

export interface Taken {
  readonly promotion: string;
  readonly label: string;
  readonly amount: Money;
}
export interface QuoteLine {
  readonly sku: string;
  readonly qty: number;
  readonly list: string;
  readonly unit: Money;
  readonly base: Money;
  readonly discounts: readonly Taken[];
  readonly total: Money;
}
export interface CouponResult {
  readonly code: string;
  readonly ok: boolean;
  readonly reason?: string;
}
export interface Quote {
  readonly currency: string;
  readonly lines: readonly QuoteLine[];
  readonly subtotal: Money;
  readonly discount: Money;
  readonly total: Money;
  readonly applied: readonly string[];
  readonly coupons: readonly CouponResult[];
  readonly explain: readonly string[];
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const live = (x: { from?: string; to?: string }, now: Date) => (x.from === undefined || day(now) >= x.from) && (x.to === undefined || day(now) <= x.to);
const inGroups = (need: readonly string[] | undefined, have: readonly string[]) => need === undefined || need.some((g) => have.includes(g));
const times_ = (a: Money, n: number): Money => ({ minor: a.minor * BigInt(n), currency: a.currency });
const zero = (c: string) => money(0, c);
const min = (a: Money, b: Money) => (a.minor <= b.minor ? a : b);

function checkQty(qty: number, sku: string) {
  if (!Number.isInteger(qty) || qty <= 0) throw new NoPrice(sku, `quantity ${qty} is not a whole number above zero`);
}

/** The list and tier that price a product for this customer now: most specific, then highest priority. */
export function priceOf(cat: Catalog, sku: string, qty: number, customer: Customer, currency: string, now: Date): { list: PriceList; tier: Tier } {
  checkQty(qty, sku);
  const cands = cat.lists
    .filter((l) => l.currency === currency && live(l, now) && inGroups(l.groups, customer.groups) && Object.hasOwn(l.entries, sku))
    .sort((a, b) => b.priority - a.priority || Number(b.groups !== undefined) - Number(a.groups !== undefined) || a.id.localeCompare(b.id));
  for (const list of cands) {
    const tier = [...list.entries[sku]!].filter((t) => t.minQty <= qty).sort((a, b) => b.minQty - a.minQty)[0];
    if (tier) return { list, tier };
  }
  throw new NoPrice(sku, cands.length ? `quantity ${qty} is below the smallest tier` : `no live ${currency} price list for this customer`);
}

interface Work {
  readonly sku: string;
  readonly qty: number;
  readonly unit: Money;
  readonly base: Money;
  running: Money;
  readonly taken: Taken[];
}

/** What a promotion would take off the given lines, per line, without changing them. */
function amountsFor(p: Promotion, ws: readonly Work[], useRunning: boolean): { amounts: Money[]; eligible: boolean; why?: string } {
  const cur = ws[0]?.base.currency ?? 'USD';
  const out = ws.map(() => zero(cur));
  const idx = ws.map((w, i) => (p.skus === undefined || p.skus.includes(w.sku) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return { amounts: out, eligible: false, why: 'no line is one it covers' };
  const spend = idx.reduce((a, i) => add(a, ws[i]!.base), zero(cur));
  if (p.minSubtotal && spend.minor < p.minSubtotal.minor) return { amounts: out, eligible: false, why: 'spend is below its minimum' };
  const basis = (i: number) => (useRunning ? ws[i]!.running : ws[i]!.base);
  const e = p.effect;
  if (e.kind === 'percent') for (const i of idx) out[i] = times(basis(i), BigInt(e.bps), 10000n);
  else if (e.kind === 'fixed') for (const i of idx) out[i] = min(basis(i), { minor: basis(i).minor > times_(e.unit, ws[i]!.qty).minor ? basis(i).minor - times_(e.unit, ws[i]!.qty).minor : 0n, currency: cur });
  else if (e.kind === 'buy-get') for (const i of idx) out[i] = min(basis(i), times_(ws[i]!.unit, Math.floor(ws[i]!.qty / (e.buy + e.get)) * e.get));
  else {
    const total = min(e.off, idx.reduce((a, i) => add(a, basis(i)), zero(cur)));
    if (total.minor > 0n) allocate(total, idx.map((i) => Number(basis(i).minor))).forEach((m, k) => (out[idx[k]!] = m));
  }
  const sum = out.reduce((a, m) => add(a, m), zero(cur));
  return { amounts: out, eligible: sum.minor > 0n, ...(sum.minor > 0n ? {} : { why: 'it would take nothing off' }) };
}

const worth = (amounts: readonly Money[], cur: string) => amounts.reduce((a, m) => add(a, m), zero(cur));

/** Check a coupon for a customer now; a refusal says why in plain words. */
export function checkCoupon(cat: Catalog, code: string, customer: Customer, now: Date, log: RedemptionLog): CouponResult & { coupon?: Coupon } {
  const c = cat.coupons.find((x) => x.code.toUpperCase() === code.trim().toUpperCase());
  if (!c) return { code, ok: false, reason: 'unknown code' };
  if (c.from !== undefined && day(now) < c.from) return { code, ok: false, reason: `not valid until ${c.from}` };
  if (c.to !== undefined && day(now) > c.to) return { code, ok: false, reason: `expired on ${c.to}` };
  if (c.maxRedemptions !== undefined && log.count(c.code) >= c.maxRedemptions) return { code, ok: false, reason: 'fully redeemed' };
  if (c.perCustomer !== undefined && log.countBy(c.code, customer.id) >= c.perCustomer) return { code, ok: false, reason: 'already used the allowed number of times by this customer' };
  const p = cat.promotions.find((x) => x.id === c.promotionId);
  if (!p) return { code, ok: false, reason: 'its promotion no longer exists' };
  if (!live(p, now)) return { code, ok: false, reason: 'its promotion is not running today' };
  if (!inGroups(p.groups, customer.groups)) return { code, ok: false, reason: 'not available to this customer group' };
  return { code: c.code, ok: true, coupon: c };
}

/** Price a basket: list prices, then promotions under the stacking rules, with the reasons. */
export function quote(cat: Catalog, req: Request, log: RedemptionLog = new RedemptionLog()): Quote {
  const cur = req.currency;
  const explain: string[] = [];
  const ws: Work[] = [];
  const listOf: string[] = [];
  for (const l of req.lines) {
    const { list, tier } = priceOf(cat, l.sku, l.qty, req.customer, cur, req.now);
    ws.push({ sku: l.sku, qty: l.qty, unit: tier.unit, base: times_(tier.unit, l.qty), running: times_(tier.unit, l.qty), taken: [] });
    listOf.push(list.id);
    explain.push(`${l.sku} x${l.qty}: list ${list.id}, tier from ${tier.minQty}, unit ${tier.unit.minor}`);
  }
  const subtotal = ws.reduce((a, w) => add(a, w.base), zero(cur));

  const couponResults: CouponResult[] = [];
  const unlocked = new Set<string>();
  for (const code of req.coupons ?? []) {
    const r = checkCoupon(cat, code, req.customer, req.now, log);
    couponResults.push({ code: r.code, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}) });
    if (r.ok) unlocked.add(r.coupon!.promotionId);
    else explain.push(`coupon ${code}: refused, ${r.reason}`);
  }

  let cands = cat.promotions.filter((p) => live(p, req.now) && inGroups(p.groups, req.customer.groups) && (!p.requiresCoupon || unlocked.has(p.id)));
  const scored = new Map<string, Money>();
  cands = cands.filter((p) => {
    const a = amountsFor(p, ws, false);
    if (!a.eligible) {
      explain.push(`${p.id}: not applied, ${a.why}`);
      return false;
    }
    scored.set(p.id, worth(a.amounts, cur));
    return true;
  });
  const better = (a: Promotion, b: Promotion) => {
    const x = scored.get(a.id)!.minor;
    const y = scored.get(b.id)!.minor;
    return (y > x ? 1 : y < x ? -1 : 0) || a.priority - b.priority || a.id.localeCompare(b.id);
  };
  // One winner per exclusion group.
  const byGroup = new Map<string, Promotion[]>();
  for (const p of cands) if (p.exclusionGroup !== undefined) byGroup.set(p.exclusionGroup, [...(byGroup.get(p.exclusionGroup) ?? []), p]);
  const dropped = new Set<string>();
  for (const [g, ps] of byGroup) {
    const [win, ...lose] = ps.sort(better);
    for (const l of lose) {
      dropped.add(l.id);
      explain.push(`${l.id}: not applied, ${win!.id} is better in exclusion group ${g}`);
    }
  }
  cands = cands.filter((p) => !dropped.has(p.id));
  const exclusive = cands.filter((p) => p.stacking === 'exclusive').sort(better);
  let chosen = cands.filter((p) => p.stacking === 'stack').sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (exclusive.length) {
    const top = exclusive[0]!;
    const dry = ws.map((w) => ({ ...w, running: w.base, taken: [] as Taken[] }));
    let stackValue = zero(cur);
    for (const p of chosen) {
      const a = amountsFor(p, dry, true);
      a.amounts.forEach((m, i) => (dry[i]!.running = sub(dry[i]!.running, m)));
      stackValue = add(stackValue, worth(a.amounts, cur));
    }
    if (scored.get(top.id)!.minor > stackValue.minor) {
      explain.push(`${top.id}: exclusive, takes ${scored.get(top.id)!.minor} which beats the stack's ${stackValue.minor}`);
      for (const p of chosen) explain.push(`${p.id}: not applied, exclusive ${top.id} is better`);
      for (const p of exclusive.slice(1)) explain.push(`${p.id}: not applied, exclusive ${top.id} is better`);
      chosen = [top];
    } else {
      explain.push(`stack beats exclusive ${top.id}: ${stackValue.minor} against ${scored.get(top.id)!.minor}`);
      for (const p of exclusive) explain.push(`${p.id}: not applied, the stack is better`);
    }
  }
  const applied: string[] = [];
  for (const p of chosen) {
    const a = amountsFor(p, ws, true);
    if (!a.eligible) {
      explain.push(`${p.id}: not applied, ${a.why} once earlier promotions were taken`);
      continue;
    }
    a.amounts.forEach((m, i) => {
      if (m.minor === 0n) return;
      ws[i]!.running = sub(ws[i]!.running, m);
      ws[i]!.taken.push({ promotion: p.id, label: p.label, amount: m });
    });
    applied.push(p.id);
    explain.push(`${p.id}: applied, took ${worth(a.amounts, cur).minor}`);
  }
  const lines = ws.map((w, i): QuoteLine => ({ sku: w.sku, qty: w.qty, list: listOf[i]!, unit: w.unit, base: w.base, discounts: w.taken, total: w.running }));
  const total = lines.reduce((a, l) => add(a, l.total), zero(cur));
  return { currency: cur, lines, subtotal, discount: sub(subtotal, total), total, applied, coupons: couponResults, explain };
}

/** Count the coupons a placed order used, so limits hold for the next quote. */
export function redeem(q: Quote, cat: Catalog, customer: Customer, log: RedemptionLog): string[] {
  const used: string[] = [];
  for (const r of q.coupons) {
    const c = cat.coupons.find((x) => x.code === r.code);
    if (r.ok && c && q.applied.includes(c.promotionId)) {
      log.record(c.code, customer.id);
      used.push(c.code);
    }
  }
  return used;
}

/** A staff member sets one line's unit price by hand: allowed only by policy, always with a reason. */
export function overrideUnit(policy: Policy, who: Subject, q: Quote, sku: string, unit: Money, reason: string): Quote {
  if (!reason.trim()) throw new NotAllowed('a reason is required');
  const d = decide(policy, who, 'override', 'price', {});
  if (!d.allowed) throw new NotAllowed(d.because);
  const line = q.lines.find((l) => l.sku === sku);
  if (!line) throw new NoPrice(sku, 'not in the quote');
  if (unit.currency !== q.currency || unit.minor < 0n) throw new NotAllowed('the price must be zero or more, in the quote currency');
  const base = times_(unit, line.qty);
  const lines = q.lines.map((l) => (l === line ? { ...l, unit, base, discounts: [], total: base } : l));
  const subtotal = lines.reduce((a, l) => add(a, l.base), zero(q.currency));
  const total = lines.reduce((a, l) => add(a, l.total), zero(q.currency));
  return { ...q, lines, subtotal, total, discount: sub(subtotal, total), explain: [...q.explain, `${sku}: unit set by ${who.id} to ${unit.minor}, reason: ${reason.trim()}; its promotions were removed`] };
}
