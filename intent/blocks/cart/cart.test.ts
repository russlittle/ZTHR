import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Inventory } from '../inventory/index.ts';
import { money } from '../money/index.ts';
import { RedemptionLog, type Catalog } from '../pricing/index.ts';
import { CartError, Carts, type Options } from './index.ts';

const usd = (n: number) => money(n, 'USD');
const MIN = 60_000;
const HOUR = 60 * MIN;
let t = Date.parse('2026-06-15T12:00:00Z');

function shop(extra: Partial<Options> = {}, catalogRef: { cat: Catalog } = { cat: baseCatalog() }) {
  t = Date.parse('2026-06-15T12:00:00Z');
  const inv = new Inventory({ now: () => new Date(t), currency: 'USD' });
  inv.addPlace({ id: 'supplier', kind: 'supplier' });
  inv.addPlace({ id: 'customer', kind: 'customer' });
  inv.addPlace({ id: 'main', kind: 'internal' });
  for (const sku of ['tee', 'mug', 'hat']) inv.addProduct({ sku, tracking: 'none', valuation: 'average' });
  inv.receive({ sku: 'tee', qty: 10, to: 'main', unitCost: usd(500) });
  inv.receive({ sku: 'mug', qty: 5, to: 'main', unitCost: usd(300) });
  inv.receive({ sku: 'hat', qty: 2, to: 'main', unitCost: usd(300) });
  let n = 0;
  const log = new RedemptionLog();
  const carts = new Carts({ catalog: () => catalogRef.cat, now: () => t, newId: () => `c${++n}`, currency: 'USD', inventory: inv, place: 'main', redemptions: log, customers: (id) => ({ id, groups: id === 'vera' ? ['vip'] : [] }), ...extra });
  return { carts, inv, log, catalogRef };
}
function baseCatalog(): Catalog {
  return {
    lists: [
      { id: 'retail', currency: 'USD', priority: 1, entries: { tee: [{ minQty: 1, unit: usd(2000) }, { minQty: 10, unit: usd(1800) }], mug: [{ minQty: 1, unit: usd(1000) }], hat: [{ minQty: 1, unit: usd(2500) }] } },
      { id: 'vip', currency: 'USD', priority: 2, groups: ['vip'], entries: { tee: [{ minQty: 1, unit: usd(1500) }] } },
    ],
    promotions: [{ id: 'ten', label: '10 off', effect: { kind: 'percent', bps: 1000 }, stacking: 'stack', priority: 1, requiresCoupon: true }],
    coupons: [{ code: 'TEN', promotionId: 'ten', perCustomer: 1 }],
  };
}
const code = (f: () => unknown) => {
  try {
    f();
    return 'no error';
  } catch (e) {
    return e instanceof CartError ? e.code : `other: ${(e as Error).message}`;
  }
};

test('a cart has exactly one kind of owner and starts empty', () => {
  const { carts } = shop();
  assert.equal(code(() => carts.create({})), 'bad-owner');
  assert.equal(code(() => carts.create({ customer: 'a', anon: 'b' })), 'bad-owner');
  const c = carts.create({ anon: 'browser-1' });
  assert.deepEqual([c.status, c.lines, c.coupons, c.version, c.currency], ['open', [], [], 1, 'USD']);
  assert.equal(code(() => carts.cart('nope')), 'unknown-cart');
});

test('adding the same product adds to its line; quantities are whole and capped', () => {
  const { carts } = shop({ maxQty: 20, maxLines: 2 });
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'tee', 2);
  const c = carts.add(id, 'tee', 3);
  assert.deepEqual(c.lines, [{ sku: 'tee', qty: 5, reserved: false }]);
  for (const q of [0, -1, 1.5, Number.NaN]) assert.equal(code(() => carts.add(id, 'tee', q)), 'bad-quantity');
  assert.equal(code(() => carts.add(id, 'tee', 16)), 'too-many');
  assert.equal(code(() => carts.add(id, 'ghost', 1)), 'no-price', 'a product with no price cannot be added');
  carts.add(id, 'mug', 1);
  assert.equal(code(() => carts.add(id, 'hat', 1)), 'too-many-lines');
  assert.equal(carts.cart(id).lines.length, 2);
});

test('quantity changes, removal and clearing; unknown lines are refused', () => {
  const { carts } = shop();
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'tee', 2);
  carts.add(id, 'mug', 1);
  assert.equal(carts.setQty(id, 'tee', 7).lines[0]!.qty, 7);
  assert.deepEqual(carts.setQty(id, 'mug', 0).lines.map((l) => l.sku), ['tee'], 'zero removes');
  assert.equal(code(() => carts.setQty(id, 'hat', 1)), 'no-line');
  assert.equal(code(() => carts.remove(id, 'hat')), 'no-line');
  carts.applyCoupon(id, ' ten ');
  const cleared = carts.clear(id);
  assert.deepEqual([cleared.lines.length, cleared.coupons.length], [0, 0]);
});

test('every recalc prices from the pricing block: tiers, groups and coupons', () => {
  const { carts } = shop();
  const a = carts.create({ anon: 'a' }).id;
  carts.add(a, 'tee', 10);
  assert.equal(carts.recalc(a).quote.total.minor, 18_000n, 'the 10-unit tier');
  const v = carts.create({ customer: 'vera' }).id;
  carts.add(v, 'tee', 2);
  assert.equal(carts.recalc(v).quote.total.minor, 3000n, 'the vip list');
  carts.applyCoupon(v, 'TEN');
  const r = carts.recalc(v);
  assert.equal(r.quote.total.minor, 2700n);
  assert.deepEqual(r.issues, []);
});

test('a coupon that is refused is dropped and reported, not silently kept', () => {
  const { carts } = shop();
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'mug', 1);
  carts.applyCoupon(id, 'BOGUS');
  carts.applyCoupon(id, 'TEN');
  const r = carts.recalc(id);
  assert.deepEqual(r.issues.map((i) => [i.code, i.message]), [['coupon-refused', 'coupon BOGUS: unknown code']]);
  assert.deepEqual(r.cart.coupons, ['TEN']);
  assert.equal(r.quote.total.minor, 900n);
});

test('a price that moved since the shopper saw it is reported with both numbers', () => {
  const ref = { cat: baseCatalog() };
  const { carts } = shop({}, ref);
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'mug', 2);
  assert.deepEqual(carts.recalc(id).changes, [], 'the first quote has nothing to compare with');
  ref.cat = { ...ref.cat, lists: [{ ...ref.cat.lists[0]!, entries: { ...ref.cat.lists[0]!.entries, mug: [{ minQty: 1, unit: usd(1200) }] } }, ref.cat.lists[1]!] };
  const r = carts.recalc(id);
  assert.deepEqual(r.changes, [{ sku: 'mug', was: usd(1000), now: usd(1200) }]);
  assert.equal(r.quote.total.minor, 2400n);
  assert.deepEqual(carts.recalc(id).changes, [], 'told once');
});

test('a product that loses its price is left out of the quote and reported, the rest still priced', () => {
  const ref = { cat: baseCatalog() };
  const { carts } = shop({}, ref);
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'mug', 1);
  carts.add(id, 'hat', 1);
  const { hat, ...rest } = ref.cat.lists[0]!.entries;
  void hat;
  ref.cat = { ...ref.cat, lists: [{ ...ref.cat.lists[0]!, entries: rest }, ref.cat.lists[1]!] };
  const r = carts.recalc(id);
  assert.deepEqual(r.issues.map((i) => [i.sku, i.code]), [['hat', 'no-price']]);
  assert.equal(r.quote.total.minor, 1000n);
  assert.equal(r.cart.lines.length, 2, 'the line stays for the shopper to remove');
});

test('holding stock is all lines or none, and refuses what is not there', () => {
  const { carts, inv } = shop();
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'tee', 4);
  carts.add(id, 'hat', 3);
  assert.equal(code(() => carts.reserve(id)), 'insufficient-stock');
  assert.deepEqual([inv.reserved('tee', 'main'), inv.reserved('hat', 'main')], [0, 0], 'the tee hold taken first was given back');
  carts.setQty(id, 'hat', 2);
  const c = carts.reserve(id);
  assert.deepEqual(c.lines.map((l) => l.reserved), [true, true]);
  assert.equal(c.reservedUntil, t + 15 * MIN);
  assert.deepEqual([inv.reserved('tee', 'main'), inv.reserved('hat', 'main')], [4, 2]);
  const other = carts.create({ anon: 'b' }).id;
  carts.add(other, 'hat', 1);
  assert.equal(code(() => carts.reserve(other)), 'insufficient-stock', 'the first cart holds both hats');
});

test('a held line follows quantity changes; a change that cannot be held changes nothing', () => {
  const { carts, inv } = shop();
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'tee', 4);
  carts.reserve(id);
  carts.setQty(id, 'tee', 6);
  assert.equal(inv.reserved('tee', 'main'), 6);
  assert.equal(code(() => carts.setQty(id, 'tee', 11)), 'insufficient-stock');
  assert.deepEqual([carts.cart(id).lines[0]!.qty, inv.reserved('tee', 'main')], [6, 6], 'the cart and the hold are as they were');
  carts.remove(id, 'tee');
  assert.equal(inv.reserved('tee', 'main'), 0);
  carts.add(id, 'mug', 1);
  assert.equal(carts.releaseStock(id).reservedUntil, undefined);
});

test('a hold that runs out is reported, and low stock is reported before checkout', () => {
  const { carts, inv } = shop();
  const { id } = carts.create({ anon: 'a' });
  carts.add(id, 'mug', 3);
  carts.reserve(id);
  t += 14 * MIN;
  assert.deepEqual(carts.recalc(id).issues, []);
  t += 2 * MIN;
  inv.sweep();
  inv.issue({ sku: 'mug', qty: 4, from: 'main', ref: 'walk-in' });
  const r = carts.recalc(id);
  assert.deepEqual(r.issues.map((i) => [i.sku, i.code, i.message]), [['mug', 'reservation-lapsed', 'the hold on mug ran out'], ['mug', 'low-stock', 'only 1 of mug left, 3 in the cart']]);
  assert.equal(r.cart.lines[0]!.reserved, false);
  assert.equal(r.cart.reservedUntil, undefined);
});

test('signing in with no cart of your own takes the anonymous cart over', () => {
  const { carts, inv } = shop();
  const a = carts.create({ anon: 'browser' }).id;
  carts.add(a, 'tee', 2);
  carts.reserve(a);
  const { cart, issues } = carts.mergeOnLogin(a, 'cy');
  assert.deepEqual([cart.id, cart.owner, cart.lines[0]!.reserved, issues], [a, { customer: 'cy' }, true, []]);
  assert.equal(inv.reserved('tee', 'main'), 2);
  assert.equal(carts.openCartOf('cy')!.id, a);
});

test('merging sums quantities up to the cap, joins coupons and moves the hold; merging twice changes nothing', () => {
  const { carts, inv } = shop({ maxQty: 8 });
  const mine = carts.create({ customer: 'cy' }).id;
  carts.add(mine, 'tee', 5);
  carts.add(mine, 'mug', 1);
  carts.applyCoupon(mine, 'TEN');
  const anon = carts.create({ anon: 'browser' }).id;
  carts.add(anon, 'tee', 4);
  carts.add(anon, 'hat', 1);
  carts.applyCoupon(anon, 'TEN');
  carts.applyCoupon(anon, 'SUMMER');
  carts.reserve(anon);
  const { cart, issues } = carts.mergeOnLogin(anon, 'cy');
  assert.deepEqual(cart.lines.map((l) => [l.sku, l.qty, l.reserved]), [['tee', 8, true], ['mug', 1, false], ['hat', 1, true]], 'tee 5 + 4 is capped at 8');
  assert.deepEqual(cart.coupons, ['TEN', 'SUMMER']);
  assert.deepEqual(issues, []);
  assert.deepEqual([inv.reserved('tee', 'main'), inv.reserved('hat', 'main')], [8, 1], 'one hold per line, none left on the anonymous cart');
  const old = carts.cart(anon);
  assert.deepEqual([old.status, old.mergedInto, old.lines.length], ['merged', mine, 0]);
  assert.equal(code(() => carts.add(anon, 'tee', 1)), 'not-open');
  const again = carts.mergeOnLogin(anon, 'cy');
  assert.deepEqual(again.cart.lines.map((l) => l.qty), [8, 1, 1]);
  const max = shop();
  const m1 = max.carts.create({ customer: 'cy' }).id;
  max.carts.add(m1, 'tee', 3);
  const m2 = max.carts.create({ anon: 'x' }).id;
  max.carts.add(m2, 'tee', 5);
  assert.equal(max.carts.mergeOnLogin(m2, 'cy', { policy: 'max' }).cart.lines[0]!.qty, 5);
  assert.equal(code(() => max.carts.mergeOnLogin(m1, 'cy')), 'bad-owner');
});

test('a merge that cannot hold the stock says so and keeps the lines', () => {
  const { carts } = shop();
  const mine = carts.create({ customer: 'cy' }).id;
  carts.add(mine, 'hat', 1);
  carts.reserve(mine);
  const anon = carts.create({ anon: 'browser' }).id;
  carts.add(anon, 'hat', 2);
  const { cart, issues } = carts.mergeOnLogin(anon, 'cy');
  assert.deepEqual(cart.lines, [{ sku: 'hat', qty: 3, reserved: false }]);
  assert.deepEqual(issues.map((i) => [i.sku, i.code]), [['hat', 'reservation-failed']]);
});

test('abandoned carts are found by stage for known owners, once per stage, and activity starts them over', () => {
  const { carts } = shop();
  const known = carts.create({ customer: 'cy' }).id;
  const anon = carts.create({ anon: 'b' }).id;
  const empty = carts.create({ customer: 'di' }).id;
  carts.add(known, 'mug', 1);
  carts.add(anon, 'mug', 1);
  t += 30 * MIN;
  assert.deepEqual(carts.abandoned(), []);
  t += 40 * MIN;
  assert.deepEqual(carts.abandoned().map((a) => [a.cart, a.stage, a.customer]), [[known, 1, 'cy']], 'the anonymous cart and the empty one are not listed');
  assert.deepEqual(carts.abandoned({ anonymousToo: true }).map((a) => a.cart).sort(), [anon, known].sort());
  carts.markReminded(known, 1);
  assert.deepEqual(carts.abandoned(), []);
  t += 24 * HOUR;
  assert.deepEqual(carts.abandoned().map((a) => [a.cart, a.stage]), [[known, 2]]);
  carts.markReminded(known, 2);
  assert.deepEqual(carts.abandoned(), []);
  carts.add(known, 'mug', 1);
  t += 2 * HOUR;
  assert.equal(carts.abandoned()[0]!.stage, 1, 'a change starts the idle time again');
  void empty;
});

test('stale carts expire and give their stock back', () => {
  const { carts, inv } = shop({ expireAfterMs: 7 * 24 * HOUR });
  const a = carts.create({ customer: 'cy' }).id;
  carts.add(a, 'tee', 3);
  carts.reserve(a);
  const b = carts.create({ customer: 'di' }).id;
  carts.add(b, 'mug', 1);
  t += 6 * 24 * HOUR;
  carts.add(b, 'mug', 1);
  t += 2 * 24 * HOUR;
  assert.deepEqual(carts.expireStale(), [a]);
  assert.equal(carts.cart(a).status, 'expired');
  assert.equal(inv.reserved('tee', 'main'), 0);
  assert.equal(carts.cart(b).status, 'open');
});

test('an order closes the cart, counts the coupon, and the cart takes no more changes', () => {
  const { carts, inv, log } = shop();
  const { id } = carts.create({ customer: 'cy' });
  carts.add(id, 'tee', 1);
  carts.applyCoupon(id, 'TEN');
  assert.equal(code(() => carts.markConverted(id, 'o1')), 'not-priced');
  carts.reserve(id);
  carts.recalc(id);
  const done = carts.markConverted(id, 'order-1');
  assert.deepEqual([done.status, done.orderId], ['converted', 'order-1']);
  assert.equal(log.countBy('TEN', 'cy'), 1);
  assert.equal(inv.reserved('tee', 'main'), 0);
  assert.equal(code(() => carts.add(id, 'tee', 1)), 'not-open');
  assert.equal(carts.openCartOf('cy'), undefined);
  const again = carts.create({ customer: 'cy' }).id;
  carts.add(again, 'tee', 1);
  carts.applyCoupon(again, 'TEN');
  assert.equal(carts.recalc(again).issues[0]!.message, 'coupon TEN: already used the allowed number of times by this customer');
});

test('a change that names an old version is refused', () => {
  const { carts } = shop();
  const { id, version } = carts.create({ anon: 'a' });
  const v2 = carts.add(id, 'mug', 1, { expectedVersion: version });
  assert.equal(v2.version, version + 1);
  assert.equal(code(() => carts.add(id, 'mug', 1, { expectedVersion: version })), 'stale');
  assert.equal(code(() => carts.setQty(id, 'mug', 3, { expectedVersion: version })), 'stale');
  assert.equal(carts.cart(id).lines[0]!.qty, 1);
});

test('snapshots are copies: changing one does not change the cart', () => {
  const { carts } = shop();
  const { id } = carts.create({ anon: 'a' });
  const c = carts.add(id, 'mug', 1) as unknown as { lines: { qty: number }[] };
  c.lines[0]!.qty = 99;
  assert.equal(carts.cart(id).lines[0]!.qty, 1);
});
