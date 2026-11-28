import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../ledger/index.ts';
import { money } from '../money/index.ts';
import { Inventory, StockError } from './index.ts';

const usd = (n: number) => money(n, 'USD');
let clock = new Date('2026-03-10T10:00:00Z');
const make = (valuation: 'fifo' | 'average' = 'fifo', tracking: 'none' | 'lot' | 'serial' = 'none') => {
  clock = new Date('2026-03-10T10:00:00Z');
  const inv = new Inventory({ now: () => clock, currency: 'USD' });
  inv.addPlace({ id: 'supplier', kind: 'supplier' });
  inv.addPlace({ id: 'customer', kind: 'customer' });
  inv.addPlace({ id: 'loss', kind: 'loss' });
  inv.addPlace({ id: 'main', kind: 'internal' });
  inv.addPlace({ id: 'shop', kind: 'internal' });
  inv.addPlace({ id: 'van', kind: 'transit' });
  inv.addProduct({ sku: 'W', tracking, valuation });
  return inv;
};
const code = (f: () => unknown) => {
  try {
    f();
    return 'no error';
  } catch (e) {
    return e instanceof StockError ? e.code : `other: ${(e as Error).message}`;
  }
};

test('quantity is the sum of moves; every receipt and issue is on record', () => {
  const inv = make();
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(100) });
  inv.issue({ sku: 'W', qty: 3, from: 'main' });
  inv.transfer({ sku: 'W', qty: 2, from: 'main', to: 'shop' });
  assert.deepEqual([inv.onHand('W', 'main'), inv.onHand('W', 'shop'), inv.onHand('W'), inv.onHand('W', 'customer')], [5, 2, 7, 3]);
  assert.deepEqual(inv.history('W').map((m) => [m.id, m.kind, m.from, m.to, m.qty]), [[1, 'receipt', 'supplier', 'main', 10], [2, 'issue', 'main', 'customer', 3], [3, 'transfer', 'main', 'shop', 2]]);
  assert.throws(() => ((inv.history()[0] as { qty: number }).qty = 99), TypeError, 'a recorded move cannot be edited');
});

test('stock cannot go below zero, and a failed move changes nothing', () => {
  const inv = make();
  inv.receive({ sku: 'W', qty: 5, to: 'main', unitCost: usd(100) });
  assert.equal(code(() => inv.issue({ sku: 'W', qty: 6, from: 'main' })), 'insufficient');
  assert.equal(code(() => inv.transfer({ sku: 'W', qty: 6, from: 'main', to: 'shop' })), 'insufficient');
  assert.deepEqual([inv.onHand('W', 'main'), inv.history().length, inv.value('W').minor], [5, 1, 500n]);
});

test('first-in first-out takes the oldest cost first', () => {
  const inv = make('fifo');
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(100) });
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(120) });
  const [out] = inv.issue({ sku: 'W', qty: 15, from: 'main' });
  assert.equal(out!.value.minor, 1600n, '10 at 100 and 5 at 120');
  assert.equal(inv.value('W').minor, 600n);
  assert.equal(inv.unitCost('W').minor, 120n);
  assert.equal(inv.value('W').minor, BigInt(inv.onHand('W')) * inv.unitCost('W').minor);
});

test('weighted average keeps value and quantity whole, so rounding never loses a cent', () => {
  const inv = make('average');
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(100) });
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(120) });
  assert.equal(inv.unitCost('W').minor, 110n);
  assert.equal(inv.issue({ sku: 'W', qty: 5, from: 'main' })[0]!.value.minor, 550n);
  const odd = make('average');
  odd.receive({ sku: 'W', qty: 1, to: 'main', unitCost: usd(33) });
  odd.receive({ sku: 'W', qty: 2, to: 'main', unitCost: usd(34) });
  const first = odd.issue({ sku: 'W', qty: 1, from: 'main' })[0]!.value.minor;
  const rest = odd.issue({ sku: 'W', qty: 2, from: 'main' })[0]!.value.minor;
  assert.deepEqual([first, rest], [34n, 67n], '101 over 3 units: 33.67 rounds to 34, and the rest is exactly what is left');
  assert.equal(first + rest, 101n);
  assert.equal(odd.value('W').minor, 0n);
});

test('transfers between your own places and transit do not change value; two outside places never meet', () => {
  const inv = make();
  inv.receive({ sku: 'W', qty: 4, to: 'main', unitCost: usd(50) });
  const [t] = inv.transfer({ sku: 'W', qty: 4, from: 'main', to: 'van' });
  assert.equal(t!.value.minor, 0n);
  assert.equal(inv.value('W').minor, 200n);
  assert.equal(inv.onHand('W'), 4, 'transit counts as yours');
  assert.equal(code(() => inv.transfer({ sku: 'W', qty: 1, from: 'van', to: 'van' })), 'same-place');
  assert.equal(code(() => inv.transfer({ sku: 'W', qty: 1, from: 'van', to: 'customer' })), 'not-owned');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'main', from: 'shop', unitCost: usd(1) })), 'not-outside');
  assert.equal(code(() => inv.issue({ sku: 'W', qty: 1, from: 'van', to: 'shop' })), 'not-outside');
});

test('a reversal puts quantity and cost back exactly; a receipt already used cannot be reversed', () => {
  const inv = make('fifo');
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(100) });
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(120) });
  const [out] = inv.issue({ sku: 'W', qty: 15, from: 'main' });
  const back = inv.reverse(out!.id, 'wrong order');
  assert.deepEqual([back.kind, back.reverses, back.value.minor], ['reversal', out!.id, 1600n]);
  assert.deepEqual([inv.onHand('W', 'main'), inv.value('W').minor], [20, 2200n]);
  assert.equal(inv.issue({ sku: 'W', qty: 10, from: 'main' })[0]!.value.minor, 1000n, 'the oldest layer is whole again');
  assert.equal(code(() => inv.reverse(1, 'oops')), 'already-used');
  assert.equal(code(() => inv.reverse(out!.id, 'again')), 'already-reversed');
  assert.equal(code(() => inv.reverse(back.id, 'undo')), 'not-reversible');
  assert.equal(code(() => inv.reverse(2, ' ')), 'reason-required');
  assert.equal(code(() => inv.reverse(99, 'x')), 'unknown-move');
  assert.deepEqual([inv.onHand('W', 'main'), inv.value('W').minor], [10, 1200n], 'a refused reversal changed nothing');
  const fresh = make('fifo');
  const [r] = fresh.receive({ sku: 'W', qty: 5, to: 'main', unitCost: usd(10) });
  fresh.reverse(r!.id, 'duplicate delivery note');
  assert.deepEqual([fresh.onHand('W'), fresh.value('W').minor], [0, 0n]);
});

test('a reversal under average cost puts back the exact value that left', () => {
  const inv = make('average');
  inv.receive({ sku: 'W', qty: 1, to: 'main', unitCost: usd(33) });
  inv.receive({ sku: 'W', qty: 2, to: 'main', unitCost: usd(34) });
  const [out] = inv.issue({ sku: 'W', qty: 1, from: 'main' });
  assert.equal(out!.value.minor, 34n);
  inv.reverse(out!.id, 'returned to shelf');
  assert.deepEqual([inv.value('W').minor, inv.onHand('W')], [101n, 3]);
});

test('lots carry an expiry; reservations take first-expiring or first-in, and never an expired lot', () => {
  const inv = make('fifo', 'lot');
  inv.receive({ sku: 'W', qty: 5, to: 'main', unitCost: usd(10), lot: 'A', expiry: '2026-06-30' });
  inv.receive({ sku: 'W', qty: 5, to: 'main', unitCost: usd(10), lot: 'B', expiry: '2026-04-30' });
  inv.receive({ sku: 'W', qty: 5, to: 'main', unitCost: usd(10), lot: 'OLD', expiry: '2026-03-01' });
  inv.receive({ sku: 'W', qty: 5, to: 'main', unitCost: usd(10), lot: 'C' });
  assert.deepEqual(inv.reserve({ ref: 'o1', sku: 'W', qty: 7, place: 'main', strategy: 'fefo' }).allocations, [{ lot: 'B', qty: 5 }, { lot: 'A', qty: 2 }]);
  assert.deepEqual(inv.reserve({ ref: 'o2', sku: 'W', qty: 6, place: 'main', strategy: 'fifo' }).allocations, [{ lot: 'A', qty: 3 }, { lot: 'C', qty: 3 }], 'first received, skipping what o1 holds and the expired lot');
  assert.equal(code(() => inv.reserve({ ref: 'o3', sku: 'W', qty: 3, place: 'main' })), 'insufficient', 'only 2 usable units are left; the expired lot does not count');
  assert.equal(inv.onHand('W', 'main', 'OLD'), 5);
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'main', unitCost: usd(1), lot: 'A', expiry: '2027-01-01' })), 'lot-conflict');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'main', unitCost: usd(1) })), 'lot-required');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'main', unitCost: usd(1), lot: 'Z', expiry: 'soon' })), 'bad-date');
});

test('reserved stock stays on the shelf but is not free; it lapses on its own and fulfils into moves', () => {
  const inv = make();
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(100) });
  inv.reserve({ ref: 'cart-1', sku: 'W', qty: 6, place: 'main', ttlMs: 15 * 60_000 });
  assert.deepEqual([inv.onHand('W', 'main'), inv.reserved('W', 'main'), inv.available('W', 'main')], [10, 6, 4]);
  assert.equal(code(() => inv.reserve({ ref: 'cart-2', sku: 'W', qty: 5, place: 'main' })), 'insufficient');
  assert.equal(code(() => inv.issue({ sku: 'W', qty: 5, from: 'main' })), 'insufficient', 'free stock only');
  assert.equal(code(() => inv.reserve({ ref: 'cart-1', sku: 'W', qty: 1, place: 'main' })), 'duplicate');
  clock = new Date(clock.getTime() + 14 * 60_000);
  assert.deepEqual(inv.sweep(), []);
  clock = new Date(clock.getTime() + 60_000);
  assert.deepEqual(inv.sweep(), ['cart-1']);
  assert.equal(inv.available('W', 'main'), 10);
  inv.reserve({ ref: 'order-9', sku: 'W', qty: 4, place: 'main' });
  const moves = inv.fulfil('order-9', 'customer');
  assert.deepEqual(moves.map((m) => [m.kind, m.qty, m.ref]), [['issue', 4, 'order-9']]);
  assert.deepEqual([inv.onHand('W', 'main'), inv.reserved('W', 'main'), inv.reservation('order-9')], [6, 0, undefined]);
  assert.equal(code(() => inv.fulfil('order-9', 'customer')), 'unknown-reservation');
  assert.equal(inv.release('nothing'), false);
});

test('serial numbers exist in one place at a time and move together or not at all', () => {
  const inv = make('fifo', 'serial');
  inv.receive({ sku: 'W', qty: 3, to: 'main', unitCost: usd(500), serials: ['S1', 'S2', 'S3'] });
  assert.equal(inv.onHand('W', 'main', 'S2'), 1);
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 2, to: 'main', unitCost: usd(500), serials: ['S4', 'S1'] })), 'serial-exists');
  assert.equal(inv.onHand('W', 'main', 'S4'), 0, 'the whole receipt was refused, S4 included');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 2, to: 'main', unitCost: usd(500), serials: ['S9', 'S9'] })), 'serial-required');
  assert.equal(code(() => inv.issue({ sku: 'W', qty: 2, from: 'main', serials: ['S1', 'NOPE'] })), 'serial-not-here');
  assert.equal(inv.onHand('W', 'main', 'S1'), 1, 'S1 did not leave when NOPE failed');
  assert.equal(inv.history().length, 3);
  inv.issue({ sku: 'W', qty: 1, from: 'main', serials: ['S2'] });
  assert.equal(code(() => inv.transfer({ sku: 'W', qty: 1, from: 'main', to: 'shop', serials: ['S2'] })), 'serial-not-here');
  inv.receive({ sku: 'W', qty: 1, to: 'shop', unitCost: usd(0), serials: ['S2'], from: 'customer' });
  assert.equal(inv.onHand('W', 'shop', 'S2'), 1, 'a returned serial can come back');
  assert.deepEqual(inv.reserve({ ref: 'r', sku: 'W', qty: 1, place: 'main', serials: ['S3'] }).allocations, [{ serial: 'S3', qty: 1 }]);
  assert.equal(code(() => inv.reserve({ ref: 'r2', sku: 'W', qty: 1, place: 'main', serials: ['S3'] })), 'insufficient');
});

test('a cycle count turns each difference into a move to or from loss at the current cost', () => {
  const inv = make('fifo', 'lot');
  inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(100), lot: 'A' });
  inv.receive({ sku: 'W', qty: 5, to: 'main', unitCost: usd(120), lot: 'B' });
  inv.reserve({ ref: 'hold', sku: 'W', qty: 9, place: 'main', lot: 'A' });
  const r = inv.count({ sku: 'W', place: 'main', found: [{ id: 'A', qty: 7 }, { id: 'B', qty: 5 }, { id: 'C', qty: 2 }], fallbackCost: usd(100) });
  assert.deepEqual(r.variances.map((v) => [v.lot, v.expected, v.counted, v.difference]), [['A', 10, 7, -3], ['C', 0, 2, 2]]);
  assert.deepEqual(r.moves.map((m) => [m.kind, m.from, m.to, m.qty, m.value.minor]), [['count', 'main', 'loss', 3, 300n], ['count', 'loss', 'main', 2, 200n]]);
  assert.equal(inv.onHand('W', 'main', 'A'), 7);
  assert.deepEqual(r.shortReserved, ['hold'], 'a reservation larger than what is on the shelf is reported, not silently cut');
  assert.equal(inv.count({ sku: 'W', place: 'main', found: [{ id: 'A', qty: 7 }, { id: 'B', qty: 5 }, { id: 'C', qty: 2 }] }).moves.length, 0, 'a matching count changes nothing');
  assert.equal(code(() => inv.count({ sku: 'W', place: 'main', found: [{ qty: 1 }] })), 'lot-required');
  assert.equal(code(() => inv.count({ sku: 'W', place: 'main', found: [{ id: 'A', qty: -1 }] })), 'bad-quantity');
  const empty = make('fifo');
  assert.equal(code(() => empty.count({ sku: 'W', place: 'main', found: [{ qty: 3 }] })), 'bad-cost', 'a gain with no cost on record needs a fallback');
  assert.equal(empty.history().length, 0);
});

test('valued moves become balanced journal entries, posted once, matching the stock value', async () => {
  const inv = make('fifo');
  const ledger = new Ledger({ now: () => clock });
  for (const [c, n, t] of [['1400', 'Inventory', 'asset'], ['2100', 'Goods received not invoiced', 'liability'], ['5100', 'Cost of goods sold', 'expense'], ['5900', 'Stock adjustments', 'expense']] as const) ledger.openAccount({ code: c, name: n, type: t, currency: 'USD' });
  const A = { inventory: '1400', clearing: '2100', cogs: '5100', adjustments: '5900' };
  const rec = inv.receive({ sku: 'W', qty: 10, to: 'main', unitCost: usd(100) });
  const tr = inv.transfer({ sku: 'W', qty: 2, from: 'main', to: 'shop' });
  const iss = inv.issue({ sku: 'W', qty: 4, from: 'main' });
  const cnt = inv.count({ sku: 'W', place: 'main', found: [{ qty: 3 }] });
  const all = [...rec, ...tr, ...iss, ...cnt.moves];
  const js = inv.journal(all, A);
  assert.deepEqual(js.map((j) => [j.key, j.lines[0]!.account, j.lines[1]!.account, j.lines[0]!.amount.minor]), [['inv-move-1', '1400', '2100', 1000n], ['inv-move-3', '5100', '1400', 400n], ['inv-move-4', '5900', '1400', 100n]], 'the transfer makes none');
  await inv.postToLedger(ledger, all, A, 'stock');
  await inv.postToLedger(ledger, all, A, 'stock');
  assert.equal(ledger.entries().length, 3, 'posting twice posts once');
  assert.equal(ledger.balance('1400').minor, inv.value('W').minor);
  assert.equal(ledger.balance('1400').minor, 500n);
  assert.equal(ledger.verify(), null);
  const back = inv.reverse(iss[0]!.id, 'customer cancelled');
  assert.deepEqual(inv.journal([back], A).map((j) => [j.lines[0]!.account, j.lines[1]!.account]), [['1400', '5100']]);
});

test('inputs are checked: whole quantities, known products and places, tracking, cost and currency', () => {
  const inv = make();
  for (const qty of [0, -1, 1.5, Number.NaN]) assert.equal(code(() => inv.receive({ sku: 'W', qty, to: 'main', unitCost: usd(1) })), 'bad-quantity');
  assert.equal(code(() => inv.receive({ sku: 'NOPE', qty: 1, to: 'main', unitCost: usd(1) })), 'unknown-product');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'nowhere', unitCost: usd(1) })), 'unknown-place');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'main', unitCost: usd(1), lot: 'A' })), 'not-tracked');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'main', unitCost: usd(-1) })), 'bad-cost');
  assert.equal(code(() => inv.receive({ sku: 'W', qty: 1, to: 'main', unitCost: money(1, 'EUR') })), 'bad-cost');
  assert.equal(code(() => inv.addPlace({ id: 'main', kind: 'internal' })), 'duplicate');
  assert.equal(code(() => inv.addProduct({ sku: 'W', tracking: 'none', valuation: 'fifo' })), 'duplicate');
  assert.equal(inv.history().length, 0);
});
