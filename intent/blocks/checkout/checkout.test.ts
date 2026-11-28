import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Carts } from '../cart/index.ts';
import { Inventory } from '../inventory/index.ts';
import { money } from '../money/index.ts';
import { TEST_METHODS, TwinProvider, type Charge, type Provider } from '../payments/index.ts';
import { RedemptionLog, type Catalog } from '../pricing/index.ts';
import { CheckoutError, Checkouts, type Options, type Party } from './index.ts';

const usd = (n: number) => money(n, 'USD');
const MIN = 60_000;
let t = 0;

const home: Party = { name: 'Ada Lovelace', country: 'US', lines: ['1 Main St'], city: 'Dayton', region: 'OH', postcode: '45402' };

function setup(extra: Partial<Options> = {}, provider: Provider = new TwinProvider()) {
  t = Date.parse('2026-06-15T12:00:00Z');
  const cat: { c: Catalog } = {
    c: {
      lists: [{ id: 'retail', currency: 'USD', priority: 1, entries: { tee: [{ minQty: 1, unit: usd(2000) }], mug: [{ minQty: 1, unit: usd(999) }] } }],
      promotions: [],
      coupons: [],
    },
  };
  const inv = new Inventory({ now: () => new Date(t), currency: 'USD' });
  inv.addPlace({ id: 'supplier', kind: 'supplier' });
  inv.addPlace({ id: 'customer', kind: 'customer' });
  inv.addPlace({ id: 'main', kind: 'internal' });
  for (const sku of ['tee', 'mug']) inv.addProduct({ sku, tracking: 'none', valuation: 'fifo' });
  inv.receive({ sku: 'tee', qty: 5, to: 'main', unitCost: usd(500) });
  inv.receive({ sku: 'mug', qty: 5, to: 'main', unitCost: usd(300) });
  let n = 0;
  const carts = new Carts({ catalog: () => cat.c, now: () => t, newId: () => `cart${++n}`, currency: 'USD', inventory: inv, place: 'main', redemptions: new RedemptionLog() });
  let k = 0;
  let orderNo = 1000;
  const checkouts = new Checkouts({
    carts,
    provider,
    shippingOptions: (to, goods) => (to.country === 'ZZ' ? [] : [{ id: 'std', label: 'Standard', price: goods.minor >= 10_000n ? usd(0) : usd(500), etaDays: 5 }, ...(to.country === 'US' ? [{ id: 'exp', label: 'Express', price: usd(1500), etaDays: 2 }] : [])]),
    taxFor: (to) => (to.region === 'OH' ? { bps: 725, label: 'Ohio sales tax' } : { bps: 0, label: 'none' }),
    now: () => t,
    newId: () => `co${++k}`,
    newOrderNumber: () => `#${++orderNo}`,
    ...extra,
  });
  const basket = (lines: [string, number][] = [['tee', 2], ['mug', 1]], customer?: string) => {
    const c = customer ? carts.create({ customer }) : carts.create({ anon: `anon${n}` });
    for (const [sku, q] of lines) carts.add(c.id, sku, q);
    return c.id;
  };
  return { carts, checkouts, inv, provider: provider as TwinProvider, cat, basket, orders: () => orderNo - 1000 };
}
const code = async (p: unknown) => {
  try {
    await (typeof p === 'function' ? (p as () => unknown)() : p);
    return 'no error';
  } catch (e) {
    return e instanceof CheckoutError ? e.code : `other: ${(e as Error).message}`;
  }
};
async function toPayment(s: ReturnType<typeof setup>, cartId = s.basket(), opt = 'std') {
  const co = s.checkouts.start(cartId);
  s.checkouts.setAddress(co.id, { shippingTo: home, email: 'ada@example.com' });
  s.checkouts.chooseShipping(co.id, opt);
  return co.id;
}

test('checkout starts from a priced cart, holds its stock, and starting again resumes the same checkout', () => {
  const s = setup();
  const cartId = s.basket();
  const co = s.checkouts.start(cartId);
  assert.deepEqual([co.step, co.cartId, co.payment.status], ['address', cartId, 'none']);
  assert.equal(s.inv.reserved('tee', 'main'), 2);
  assert.equal(s.checkouts.start(cartId).id, co.id);
  assert.equal(co.trail[0]!.note, 'started');
});

test('an empty cart, an unpriced product and short stock stop checkout at the start', async () => {
  const s = setup();
  const empty = s.carts.create({ anon: 'x' }).id;
  assert.equal(await code(() => s.checkouts.start(empty)), 'empty-cart');
  const low = s.basket([['tee', 5]]);
  s.inv.issue({ sku: 'tee', qty: 4, from: 'main' });
  assert.equal(await code(() => s.checkouts.start(low)), 'cart-problems');
  const gone = s.basket([['mug', 1]]);
  const fine = s.basket([['mug', 1]]);
  s.cat.c = { ...s.cat.c, lists: [{ ...s.cat.c.lists[0]!, entries: { tee: s.cat.c.lists[0]!.entries.tee! } }] };
  try {
    s.checkouts.start(gone);
    assert.fail('should refuse');
  } catch (e) {
    assert.equal((e as CheckoutError).code, 'cart-problems');
    assert.match((e as Error).message, /no price for mug/);
  }
  assert.equal(await code(() => s.checkouts.start(fine, { email: 'nope' })), 'bad-email');
  assert.equal(s.inv.reserved('mug', 'main'), 0, 'a refused start holds nothing');
});

test('the address is checked per country, with every problem named', async () => {
  const s = setup();
  const co = s.checkouts.start(s.basket());
  const bad = async (to: Partial<Party>, email = 'ada@example.com') => {
    try {
      s.checkouts.setAddress(co.id, { shippingTo: { ...home, ...to }, email });
      return 'ok';
    } catch (e) {
      return `${(e as CheckoutError).code}: ${(e as Error).message}`;
    }
  };
  assert.equal(await bad({ name: ' ' }), 'bad-address: shipping address: a name is needed');
  assert.equal(await bad({ postcode: 'ABCDE' }), 'bad-address: shipping address: ABCDE is not a United States postcode');
  assert.equal(await bad({ postcode: '' }), 'bad-address: shipping address: United States addresses need a postcode');
  assert.equal(await bad({ lines: [' '] }), 'bad-address: shipping address: add a street address');
  assert.equal(await bad({ city: ' ' }), 'bad-address: shipping address: add a city');
  assert.equal(await bad({ country: 'usa' }), 'bad-address: shipping address: the country is a two-letter code');
  assert.equal((await bad({}, 'not-an-email')).split(':')[0], 'bad-email');
  assert.equal(await bad({ country: 'ZZ', postcode: '1' }), 'no-shipping: we cannot ship to that address');
  assert.equal(await bad({}), 'ok');
  assert.equal(s.checkouts.checkout(co.id).step, 'shipping');
});

test('steps cannot be skipped', async () => {
  const s = setup();
  const co = s.checkouts.start(s.basket());
  assert.equal(await code(() => s.checkouts.chooseShipping(co.id, 'std')), 'out-of-order');
  assert.equal(await code(s.checkouts.pay(co.id, TEST_METHODS.ok)), 'out-of-order');
  assert.equal(await code(s.checkouts.place(co.id)), 'not-paid');
  s.checkouts.setAddress(co.id, { shippingTo: home, email: 'ada@example.com' });
  assert.equal(await code(s.checkouts.pay(co.id, TEST_METHODS.ok)), 'out-of-order');
  assert.equal(await code(() => s.checkouts.chooseShipping(co.id, 'overnight')), 'bad-option');
  assert.equal(await code(() => s.checkouts.checkout('nope')), 'unknown-checkout');
});

test('totals are goods, shipping and tax worked out here, rounded half-even once', () => {
  const s = setup();
  const co = s.checkouts.start(s.basket([['tee', 2], ['mug', 1]]));
  s.checkouts.setAddress(co.id, { shippingTo: home, email: 'ada@example.com' });
  const c = s.checkouts.chooseShipping(co.id, 'std');
  assert.deepEqual([c.totals!.goods.minor, c.totals!.shipping.minor, c.totals!.tax.minor, c.totals!.total.minor], [4999n, 500n, 362n, 5861n], '7.25% of 49.99 is 3.6243, rounded to 3.62; shipping untaxed');
  assert.deepEqual([c.totals!.taxRateBps, c.totals!.taxLabel, c.step], [725, 'Ohio sales tax', 'payment']);
  const t2 = setup({ taxShipping: true });
  const co2 = t2.checkouts.start(t2.basket([['tee', 2], ['mug', 1]]));
  t2.checkouts.setAddress(co2.id, { shippingTo: home, email: 'ada@example.com' });
  assert.equal(t2.checkouts.chooseShipping(co2.id, 'std').totals!.tax.minor, 399n, '7.25% of 54.99 is 3.9868');
  const free = setup();
  const co3 = free.checkouts.start(free.basket([['tee', 5]]));
  free.checkouts.setAddress(co3.id, { shippingTo: { ...home, region: 'IN' }, email: 'ada@example.com' });
  const f = free.checkouts.chooseShipping(co3.id, 'std');
  assert.deepEqual([f.totals!.shipping.minor, f.totals!.tax.minor, f.totals!.total.minor], [0n, 0n, 10_000n], 'free shipping over 100.00, no tax outside Ohio');
});

test('changing the address drops a shipping choice that is no longer offered, and says so', () => {
  const s = setup();
  const co = s.checkouts.start(s.basket());
  s.checkouts.setAddress(co.id, { shippingTo: home, email: 'ada@example.com' });
  s.checkouts.chooseShipping(co.id, 'exp');
  const c = s.checkouts.setAddress(co.id, { shippingTo: { name: 'Bo', country: 'CA', lines: ['5 Rue'], city: 'Ottawa', region: 'ON', postcode: 'K1A 0B1' }, email: 'ada@example.com' });
  assert.deepEqual([c.step, c.shipping, c.totals, c.options.map((o) => o.id)], ['shipping', undefined, undefined, ['std']]);
  assert.deepEqual(c.notices, ['the Express option is not available for this address']);
});

test('paying charges the server-side total once; paying again is a no-op', async () => {
  const s = setup();
  const id = await toPayment(s);
  const c = await s.checkouts.pay(id, TEST_METHODS.ok);
  assert.deepEqual([c.step, c.payment.status, c.payment.amount!.minor], ['review', 'succeeded', 5861n]);
  assert.equal(s.provider.charges.get(c.payment.chargeId!)!.amount.amount, 5861);
  await s.checkouts.pay(id, TEST_METHODS.ok);
  assert.equal(s.provider.calls, 1, 'no second charge');
  assert.equal(await code(() => s.checkouts.setAddress(id, { shippingTo: home })), 'payment-started');
});

test('a decline keeps the shopper on payment with the reason; another card works, as a new attempt', async () => {
  const s = setup();
  const id = await toPayment(s);
  const d = await s.checkouts.pay(id, TEST_METHODS.declined);
  assert.deepEqual([d.step, d.payment.status, d.payment.failure, d.payment.attempt], ['payment', 'failed', 'card_declined', 1]);
  const ok = await s.checkouts.pay(id, TEST_METHODS.ok);
  assert.deepEqual([ok.step, ok.payment.status, ok.payment.attempt], ['review', 'succeeded', 2]);
  assert.equal(s.provider.charges.size, 2);
});

test('a card that needs confirmation waits, and nothing else moves meanwhile', async () => {
  const s = setup();
  const id = await toPayment(s);
  const p = await s.checkouts.pay(id, TEST_METHODS.needsAction);
  assert.deepEqual([p.step, p.payment.status], ['payment', 'requires_action']);
  assert.equal(await code(s.checkouts.pay(id, TEST_METHODS.ok)), 'needs-confirmation');
  assert.equal(await code(s.checkouts.place(id)), 'not-paid');
  assert.equal(await code(() => s.checkouts.chooseShipping(id, 'exp')), 'payment-started');
  const c = await s.checkouts.confirmPayment(id);
  assert.deepEqual([c.step, c.payment.status], ['review', 'succeeded']);
  assert.equal(await code(s.checkouts.confirmPayment(id)), 'out-of-order');
});

test('if the cart changes before payment, nothing is charged and the new total is shown first', async () => {
  const s = setup();
  const cartId = s.basket();
  const id = await toPayment(s, cartId);
  s.carts.add(cartId, 'mug', 1);
  const c = await s.checkouts.pay(id, TEST_METHODS.ok);
  assert.equal(s.provider.calls, 0);
  assert.equal(c.payment.status, 'none');
  assert.equal(c.totals!.total.minor, 6933n, '4999 + 999 goods, 500 shipping, 7.25% of 5998 is 435');
  assert.ok(c.notices.some((n) => n.startsWith('the total changed from 5861 to 6933')));
  const ok = await s.checkouts.pay(id, TEST_METHODS.ok);
  assert.equal(ok.payment.amount!.minor, 6933n);
  assert.equal(s.provider.calls, 1);
});

test('placing the order is idempotent, by checkout and by key, even when called twice at once', async () => {
  const s = setup();
  const id = await toPayment(s, s.basket([['tee', 2], ['mug', 1]], 'ada'));
  await s.checkouts.pay(id, TEST_METHODS.ok);
  const [a, b] = await Promise.all([s.checkouts.place(id, 'k1'), s.checkouts.place(id, 'k1')]);
  assert.equal(a, b);
  assert.equal(s.orders(), 1, 'one order number was used');
  assert.deepEqual([a.number, a.email, a.customer, a.totals.total.minor, a.lines.map((l) => [l.sku, l.qty, l.total.minor])], ['#1001', 'ada@example.com', 'ada', 5861n, [['tee', 2, 4000n], ['mug', 1, 999n]]]);
  assert.deepEqual(a.holds, ['cart1#tee', 'cart1#mug']);
  assert.equal(await s.checkouts.place(id), a);
  assert.equal(await s.checkouts.place(id, 'k1'), a);
  assert.equal(s.checkouts.checkout(id).step, 'placed');
  assert.equal(s.carts.cart(a.cartId).status, 'converted');
  assert.equal(s.inv.reserved('tee', 'main'), 2, 'the stock stays held for the warehouse');
  const moves = s.inv.fulfil(a.holds[0]!, 'customer');
  assert.equal(moves[0]!.qty, 2);
  assert.equal(s.provider.charges.size, 1);
  const other = await toPayment(s, s.basket([['mug', 1]]));
  await s.checkouts.pay(other, TEST_METHODS.ok);
  assert.equal(await code(s.checkouts.place(other, 'k1')), 'key-conflict');
});

test('if the order cannot be placed after the money was taken, the money is returned', async () => {
  const s = setup();
  const id = await toPayment(s, s.basket([['tee', 5]]));
  const paid = await s.checkouts.pay(id, TEST_METHODS.ok);
  t += 20 * MIN;
  s.inv.sweep();
  s.inv.issue({ sku: 'tee', qty: 4, from: 'main' });
  const err = await s.checkouts.place(id).catch((e: unknown) => e as CheckoutError);
  assert.equal((err as CheckoutError).code, 'cart-problems');
  assert.match((err as Error).message, /only 1 of tee left/);
  assert.match((err as Error).message, /\(the payment was refunded\)/);
  const ch = s.provider.charges.get(paid.payment.chargeId!)!;
  assert.equal(ch.refunded, ch.amount.amount);
  const c = s.checkouts.checkout(id);
  assert.deepEqual([c.step, c.payment.status, c.orderId], ['payment', 'none', undefined]);
  assert.ok(c.notices.includes('the order could not be placed and the payment was refunded'));
});

test('cancelling releases the stock and refunds a payment already taken', async () => {
  const s = setup();
  const unpaid = await toPayment(s, s.basket([['mug', 2]]));
  assert.equal(s.inv.reserved('mug', 'main'), 2);
  const c1 = await s.checkouts.cancel(unpaid);
  assert.deepEqual([c1.step, s.inv.reserved('mug', 'main')], ['cancelled', 0]);
  assert.equal(await code(() => s.checkouts.chooseShipping(unpaid, 'std')), 'closed');
  assert.equal(await code(s.checkouts.place(unpaid)), 'closed');
  const paid = await toPayment(s, s.basket([['tee', 1]]));
  const p = await s.checkouts.pay(paid, TEST_METHODS.ok);
  await s.checkouts.cancel(paid);
  const ch = s.provider.charges.get(p.payment.chargeId!)!;
  assert.equal(ch.refunded, ch.amount.amount);
  assert.equal(s.inv.reserved('tee', 'main'), 0);
});

test('an idle checkout expires and gives the stock back', async () => {
  const s = setup({ ttlMs: 10 * MIN });
  const id = await toPayment(s);
  t += 9 * MIN;
  assert.equal(s.checkouts.checkout(id).step, 'payment');
  t += 2 * MIN;
  assert.equal(s.checkouts.checkout(id).step, 'expired');
  assert.equal(s.inv.reserved('tee', 'main'), 0);
  assert.equal(await code(s.checkouts.pay(id, TEST_METHODS.ok)), 'closed');
  assert.equal(s.checkouts.start(s.carts.cart('cart1').id).step, 'address', 'a new checkout can begin on the same cart');
});

test('a provider that is down leaves the checkout as it was', async () => {
  const flaky: Provider = {
    charge: async (): Promise<Charge> => {
      throw new Error('provider down');
    },
    confirm: async () => {
      throw new Error('provider down');
    },
    refund: async () => {
      throw new Error('provider down');
    },
  };
  const s = setup({}, flaky);
  const id = await toPayment(s);
  assert.equal(await code(s.checkouts.pay(id, TEST_METHODS.ok)), 'other: provider down');
  const c = s.checkouts.checkout(id);
  assert.deepEqual([c.step, c.payment.status], ['payment', 'none']);
});
