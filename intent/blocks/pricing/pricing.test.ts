import assert from 'node:assert/strict';
import { test } from 'node:test';
import { money } from '../money/index.ts';
import type { Policy } from '../rbac/index.ts';
import { checkCoupon, NoPrice, NotAllowed, overrideUnit, priceOf, quote, redeem, RedemptionLog, type Catalog, type Customer, type Promotion } from './index.ts';

const usd = (n: number) => money(n, 'USD');
const NOW = new Date('2026-06-15T12:00:00Z');
const alice: Customer = { id: 'alice', groups: [] };
const vip: Customer = { id: 'vera', groups: ['vip'] };

const base: Catalog = {
  lists: [
    { id: 'retail', currency: 'USD', priority: 1, entries: { tee: [{ minQty: 1, unit: usd(2000) }, { minQty: 10, unit: usd(1800) }, { minQty: 50, unit: usd(1500) }], mug: [{ minQty: 1, unit: usd(1000) }] } },
    { id: 'vip', currency: 'USD', priority: 1, groups: ['vip'], entries: { tee: [{ minQty: 1, unit: usd(1700) }] } },
    { id: 'summer', currency: 'USD', priority: 5, from: '2026-06-01', to: '2026-06-30', entries: { mug: [{ minQty: 1, unit: usd(900) }] } },
    { id: 'euro', currency: 'EUR', priority: 1, entries: { tee: [{ minQty: 1, unit: money(1900, 'EUR') }] } },
  ],
  promotions: [],
  coupons: [],
};
const promo = (p: Partial<Promotion> & { id: string }): Promotion => ({ label: p.id, effect: { kind: 'percent', bps: 1000 }, stacking: 'stack', priority: 10, ...p });
const withPromos = (promotions: Promotion[], coupons: Catalog['coupons'] = []): Catalog => ({ ...base, promotions, coupons });
const req = (lines: { sku: string; qty: number }[], extra: { customer?: Customer; coupons?: string[] } = {}) => ({ customer: extra.customer ?? alice, currency: 'USD', lines, now: NOW, ...(extra.coupons ? { coupons: extra.coupons } : {}) });

test('quantity tiers set the unit price from the highest tier reached', () => {
  assert.equal(priceOf(base, 'tee', 1, alice, 'USD', NOW).tier.unit.minor, 2000n);
  assert.equal(priceOf(base, 'tee', 9, alice, 'USD', NOW).tier.unit.minor, 2000n);
  assert.equal(priceOf(base, 'tee', 10, alice, 'USD', NOW).tier.unit.minor, 1800n);
  assert.equal(priceOf(base, 'tee', 500, alice, 'USD', NOW).tier.unit.minor, 1500n);
  const q = quote(base, req([{ sku: 'tee', qty: 12 }]));
  assert.equal(q.total.minor, 21600n);
});

test('a customer group gets its own list; others do not', () => {
  assert.equal(priceOf(base, 'tee', 1, vip, 'USD', NOW).list.id, 'vip');
  assert.equal(priceOf(base, 'tee', 1, alice, 'USD', NOW).list.id, 'retail');
  assert.equal(priceOf(base, 'tee', 20, vip, 'USD', NOW).list.id, 'vip', 'same priority: the group list is more specific');
});

test('a dated list wins by priority only while it is live', () => {
  assert.equal(priceOf(base, 'mug', 1, alice, 'USD', NOW).tier.unit.minor, 900n);
  assert.equal(priceOf(base, 'mug', 1, alice, 'USD', new Date('2026-07-01T00:00:00Z')).tier.unit.minor, 1000n);
  assert.equal(priceOf(base, 'mug', 1, alice, 'USD', new Date('2026-06-30T23:59:00Z')).list.id, 'summer', 'the last day is included');
});

test('no price is a refusal that says why, never a zero', () => {
  assert.throws(() => priceOf(base, 'hat', 1, alice, 'USD', NOW), NoPrice);
  assert.throws(() => priceOf(base, 'tee', 1, alice, 'GBP', NOW), /no live GBP price list/);
  assert.throws(() => priceOf(base, 'tee', 0, alice, 'USD', NOW), /whole number above zero/);
  assert.throws(() => priceOf(base, 'tee', 1.5, alice, 'USD', NOW), NoPrice);
  assert.throws(() => priceOf({ ...base, lists: [{ id: 'x', currency: 'USD', priority: 1, entries: { tee: [{ minQty: 5, unit: usd(1) }] } }] }, 'tee', 2, alice, 'USD', NOW), /below the smallest tier/);
});

test('a percentage promotion rounds once, half-even, per line', () => {
  const cat = withPromos([promo({ id: 'ten', effect: { kind: 'percent', bps: 1000 } })]);
  const q = quote(cat, req([{ sku: 'tee', qty: 1 }, { sku: 'mug', qty: 1 }]));
  assert.deepEqual(q.lines.map((l) => l.total.minor), [1800n, 810n]);
  assert.equal(q.discount.minor, 290n);
  assert.equal(q.subtotal.minor - q.discount.minor, q.total.minor);
  assert.deepEqual(q.applied, ['ten']);
});

test('stacking promotions apply in priority order to the running price', () => {
  const cat = withPromos([promo({ id: 'b-five', priority: 2, effect: { kind: 'percent', bps: 500 } }), promo({ id: 'a-ten', priority: 1, effect: { kind: 'percent', bps: 1000 } })]);
  const q = quote(cat, req([{ sku: 'tee', qty: 1 }]));
  assert.deepEqual(q.lines[0]!.discounts.map((d) => [d.promotion, d.amount.minor]), [['a-ten', 200n], ['b-five', 90n]]);
  assert.equal(q.total.minor, 1710n, '2000 less 10% less 5% of the rest, not 15%');
});

test('an amount off an order is spread over lines and adds back exactly', () => {
  const cat = withPromos([promo({ id: 'five-off', effect: { kind: 'amount', off: usd(500) } })]);
  const q = quote(cat, req([{ sku: 'tee', qty: 1 }, { sku: 'mug', qty: 1 }]));
  const taken = q.lines.map((l) => l.discounts[0]!.amount.minor);
  assert.equal(taken[0]! + taken[1]!, 500n);
  assert.deepEqual(taken, [345n, 155n], 'in proportion to the lines (2000 and the summer mug at 900), the odd unit to the larger remainder');
  const big = quote(withPromos([promo({ id: 'huge', effect: { kind: 'amount', off: usd(999999) } })]), req([{ sku: 'mug', qty: 1 }]));
  assert.equal(big.total.minor, 0n, 'never below zero');
});

test('an exclusive promotion competes with the stack and the better one wins, with the reason', () => {
  const cat = withPromos([
    promo({ id: 'half', stacking: 'exclusive', effect: { kind: 'percent', bps: 5000 } }),
    promo({ id: 'ten', effect: { kind: 'percent', bps: 1000 } }),
    promo({ id: 'five', effect: { kind: 'percent', bps: 500 } }),
  ]);
  const q = quote(cat, req([{ sku: 'tee', qty: 1 }]));
  assert.deepEqual(q.applied, ['half']);
  assert.equal(q.total.minor, 1000n);
  assert.ok(q.explain.some((e) => e.startsWith('ten: not applied, exclusive half is better')));
  const weak = withPromos([promo({ id: 'tiny', stacking: 'exclusive', effect: { kind: 'percent', bps: 100 } }), promo({ id: 'ten', effect: { kind: 'percent', bps: 1000 } })]);
  const w = quote(weak, req([{ sku: 'tee', qty: 1 }]));
  assert.deepEqual(w.applied, ['ten']);
  assert.ok(w.explain.some((e) => e.startsWith('tiny: not applied, the stack is better')));
});

test('promotions in one exclusion group never combine', () => {
  const cat = withPromos([promo({ id: 'seasonal', exclusionGroup: 'season', effect: { kind: 'percent', bps: 1500 } }), promo({ id: 'loyalty', exclusionGroup: 'season', effect: { kind: 'percent', bps: 1000 } }), promo({ id: 'ship', effect: { kind: 'percent', bps: 100 } })]);
  const q = quote(cat, req([{ sku: 'tee', qty: 1 }]));
  assert.deepEqual(q.applied, ['seasonal', 'ship']);
  assert.ok(q.explain.includes('loyalty: not applied, seasonal is better in exclusion group season'));
});

test('buy-get gives whole free units, fixed price caps the unit, scope and minimum spend are respected', () => {
  const bg = quote(withPromos([promo({ id: 'b2g1', effect: { kind: 'buy-get', buy: 2, get: 1 }, skus: ['mug'] })]), req([{ sku: 'mug', qty: 7 }, { sku: 'tee', qty: 1 }]));
  assert.equal(bg.lines[0]!.discounts[0]!.amount.minor, 1800n, '7 mugs make two sets of three: two free at 900');
  assert.equal(bg.lines[1]!.discounts.length, 0);
  const fx = quote(withPromos([promo({ id: 'fix', effect: { kind: 'fixed', unit: usd(1200) }, skus: ['tee'] })]), req([{ sku: 'tee', qty: 3 }]));
  assert.equal(fx.total.minor, 3600n);
  const noRaise = quote(withPromos([promo({ id: 'fix', effect: { kind: 'fixed', unit: usd(5000) } })]), req([{ sku: 'tee', qty: 1 }]));
  assert.equal(noRaise.total.minor, 2000n, 'a fixed price never raises the price');
  const mn = withPromos([promo({ id: 'big', minSubtotal: usd(5000) })]);
  assert.deepEqual(quote(mn, req([{ sku: 'tee', qty: 2 }])).applied, []);
  assert.ok(quote(mn, req([{ sku: 'tee', qty: 2 }])).explain.includes('big: not applied, spend is below its minimum'));
  assert.deepEqual(quote(mn, req([{ sku: 'tee', qty: 3 }])).applied, ['big']);
});

test('a group promotion and a dated promotion apply only to who and when they say', () => {
  const cat = withPromos([promo({ id: 'vip-only', groups: ['vip'] }), promo({ id: 'july', from: '2026-07-01' })]);
  assert.deepEqual(quote(cat, req([{ sku: 'tee', qty: 1 }])).applied, []);
  assert.deepEqual(quote(cat, req([{ sku: 'tee', qty: 1 }], { customer: vip })).applied, ['vip-only']);
});

test('coupons unlock a promotion; each refusal says why', () => {
  const cat = withPromos([promo({ id: 'welcome', requiresCoupon: true, effect: { kind: 'percent', bps: 2000 } }), promo({ id: 'vipc', requiresCoupon: true, groups: ['vip'] }), promo({ id: 'old', requiresCoupon: true, to: '2026-01-01' })], [
    { code: 'WELCOME20', promotionId: 'welcome', maxRedemptions: 2, perCustomer: 1 },
    { code: 'VIPONLY', promotionId: 'vipc' },
    { code: 'EXPIRED', promotionId: 'welcome', to: '2026-05-31' },
    { code: 'LATER', promotionId: 'welcome', from: '2026-07-01' },
    { code: 'OLDPROMO', promotionId: 'old' },
    { code: 'GONE', promotionId: 'missing' },
  ]);
  const log = new RedemptionLog();
  const ok = quote(cat, req([{ sku: 'tee', qty: 1 }], { coupons: [' welcome20 '] }), log);
  assert.equal(ok.total.minor, 1600n);
  assert.deepEqual(ok.coupons, [{ code: 'WELCOME20', ok: true }]);
  const why = (code: string) => checkCoupon(cat, code, alice, NOW, log).reason;
  assert.equal(why('nope'), 'unknown code');
  assert.equal(why('EXPIRED'), 'expired on 2026-05-31');
  assert.equal(why('LATER'), 'not valid until 2026-07-01');
  assert.equal(why('VIPONLY'), 'not available to this customer group');
  assert.equal(why('OLDPROMO'), 'its promotion is not running today');
  assert.equal(why('GONE'), 'its promotion no longer exists');
  const bad = quote(cat, req([{ sku: 'tee', qty: 1 }], { coupons: ['EXPIRED'] }));
  assert.equal(bad.total.minor, 2000n);
  assert.ok(bad.explain.includes('coupon EXPIRED: refused, expired on 2026-05-31'));
});

test('coupon limits hold in total and per customer once an order is placed', () => {
  const cat = withPromos([promo({ id: 'welcome', requiresCoupon: true })], [{ code: 'WELCOME', promotionId: 'welcome', maxRedemptions: 2, perCustomer: 1 }]);
  const log = new RedemptionLog();
  const lines = [{ sku: 'tee', qty: 1 }];
  const q1 = quote(cat, req(lines, { coupons: ['WELCOME'] }), log);
  assert.deepEqual(redeem(q1, cat, alice, log), ['WELCOME']);
  assert.equal(checkCoupon(cat, 'WELCOME', alice, NOW, log).reason, 'already used the allowed number of times by this customer');
  const bob: Customer = { id: 'bob', groups: [] };
  redeem(quote(cat, { ...req(lines, { coupons: ['WELCOME'] }), customer: bob }, log), cat, bob, log);
  assert.equal(checkCoupon(cat, 'WELCOME', vip, NOW, log).reason, 'fully redeemed');
  assert.equal(log.count('WELCOME'), 2);
  const refused = quote(cat, req(lines, { coupons: ['WELCOME'] }), log);
  assert.deepEqual(redeem(refused, cat, alice, log), [], 'a refused coupon is not counted');
});

test('a manual override needs permission and a reason, and removes the line promotions', () => {
  const policy: Policy = { roles: { staff: { label: 'Staff' }, manager: { label: 'Manager' } }, grants: [{ role: 'manager', actions: ['override'], kind: 'price' }] };
  const q = quote(withPromos([promo({ id: 'ten' })]), req([{ sku: 'tee', qty: 2 }]));
  assert.throws(() => overrideUnit(policy, { id: 's1', roles: ['staff'] }, q, 'tee', usd(1000), 'price match'), NotAllowed);
  assert.throws(() => overrideUnit(policy, { id: 'm1', roles: ['manager'] }, q, 'tee', usd(1000), '  '), /reason is required/);
  assert.throws(() => overrideUnit(policy, { id: 'm1', roles: ['manager'] }, q, 'tee', money(1000, 'EUR'), 'x'), NotAllowed);
  const o = overrideUnit(policy, { id: 'm1', roles: ['manager'] }, q, 'tee', usd(1000), 'price match');
  assert.equal(o.total.minor, 2000n);
  assert.equal(o.discount.minor, 0n);
  assert.ok(o.explain.at(-1)!.includes('set by m1'));
});

test('quotes are deterministic and never mix currencies', () => {
  const cat = withPromos([promo({ id: 'ten' })]);
  const a = quote(cat, req([{ sku: 'tee', qty: 3 }]));
  const b = quote(cat, req([{ sku: 'tee', qty: 3 }]));
  assert.deepEqual(JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  assert.equal(quote(cat, { ...req([{ sku: 'tee', qty: 1 }]), currency: 'EUR' }).total.minor, 1710n);
  assert.equal(quote(cat, { ...req([{ sku: 'tee', qty: 1 }]), currency: 'EUR' }).total.currency, 'EUR');
});
