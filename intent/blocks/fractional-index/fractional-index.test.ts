import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadKey, NoRoom, between, betweenMany, checkOrder, isKey, jitteredBetween, keyAt, needsRebalance, orderItems, rebalance, repairDuplicates } from './index.ts';

test('published vectors of the fractional-indexing scheme: single keys', () => {
  const v: [string | null, string | null, string][] = [
    [null, null, 'a0'],
    ['a0', null, 'a1'],
    ['a1', null, 'a2'],
    ['a0', 'a1', 'a0V'],
    ['a1', 'a2', 'a1V'],
    ['a0V', 'a1', 'a0l'],
    ['Zz', 'a0', 'ZzV'],
    ['Zz', 'a1', 'a0'],
    [null, 'Y00', 'Xzzz'],
    ['bzz', null, 'c000'],
    ['a0', 'a0V', 'a0G'],
    ['a0', 'a0G', 'a08'],
    ['b125', 'b129', 'b127'],
    ['a0', 'a1V', 'a1'],
    ['Zz', 'a01', 'a0'],
    [null, 'a0V', 'a0'],
    [null, 'b999', 'b99'],
  ];
  for (const [a, b, want] of v) assert.equal(between(a, b), want, `between(${a}, ${b})`);
});

test('published vectors: many keys at once', () => {
  assert.deepEqual(betweenMany(null, null, 5), ['a0', 'a1', 'a2', 'a3', 'a4']);
  assert.deepEqual(betweenMany('a4', null, 10), ['a5', 'a6', 'a7', 'a8', 'a9', 'aA', 'aB', 'aC', 'aD', 'aE']);
  assert.deepEqual(betweenMany(null, 'a0', 5), ['Zv', 'Zw', 'Zx', 'Zy', 'Zz']);
  const twenty = betweenMany('a0', 'a2', 20);
  assert.deepEqual(twenty.slice(0, 10), ['a04', 'a08', 'a0G', 'a0K', 'a0O', 'a0V', 'a0Z', 'a0d', 'a0l', 'a0t']);
  assert.equal(checkOrder(twenty), null);
  assert.ok(twenty.every((k) => k > 'a0' && k < 'a2'));
  assert.deepEqual(betweenMany('a0', 'a1', 0), []);
});

test('refuses keys out of order, malformed keys and impossible gaps', () => {
  assert.throws(() => between('a1', 'a0'), BadKey);
  assert.throws(() => between('a0', 'a0'), BadKey);
  assert.throws(() => between('a00', null), BadKey, 'a fractional part may not end in zero');
  assert.throws(() => between('!', null), BadKey);
  assert.throws(() => between('a', null), BadKey, 'integer part too short');
  assert.throws(() => between(`A${'0'.repeat(26)}`, null), BadKey, 'the smallest integer is not a key');
  assert.throws(() => between('zzzzzzzzzzzzzzzzzzzzzzzzzzz', 'zzzzzzzzzzzzzzzzzzzzzzzzzzz1'.slice(0, 27) + '0'), BadKey);
  assert.throws(() => betweenMany('a0', 'a1', -1), RangeError);
  assert.throws(() => betweenMany('a0', 'a1', 1.5), RangeError);
  assert.equal(isKey('a0'), true);
  assert.equal(isKey('a00'), false);
  assert.equal(isKey(''), false);
});

test('the integer part grows and shrinks across its boundaries', () => {
  assert.equal(between('az', null), 'b00');
  assert.equal(between('Zz', null), 'a0');
  assert.equal(between(null, 'Zz'), 'Zy');
  const low = `A${'0'.repeat(25)}1`;
  const below = between(null, low);
  assert.equal(below, `A${'0'.repeat(26)}V`, 'the smallest integer is not a key, so it goes into the fractions');
  assert.ok(below < low && isKey(below));
  const top = `z${'z'.repeat(26)}`;
  assert.equal(between(top, null), `${top}V`, 'no room above the largest integer, so it extends the fraction');
  assert.throws(() => between(top, `${top}0`), BadKey, 'a key may not end in the zero digit');
});

test('1000 inserts at the front, at the back and in the same gap stay in strict order', () => {
  let front = 'a0';
  const f: string[] = [front];
  for (let i = 0; i < 1000; i++) f.unshift((front = between(null, front)));
  assert.equal(checkOrder(f), null);
  let back = 'a0';
  const b: string[] = [back];
  for (let i = 0; i < 1000; i++) b.push((back = between(back, null)));
  assert.equal(checkOrder(b), null);
  // Always inserting into the same gap (just after the first) grows the key by about a digit every few inserts.
  let lo = 'a0';
  const hi = 'a1';
  for (let i = 0; i < 200; i++) {
    const m = between(lo, hi);
    assert.ok(lo < m && m < hi);
    lo = m;
  }
  assert.ok(lo.length < 200, 'repeated insertion grows keys, but not one digit per insert');
});

test('random insertions into a list always leave it ordered and unique', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const keys: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const at = Math.floor(rnd() * (keys.length + 1));
    keys.splice(at, 0, keyAt(keys, at));
  }
  assert.equal(checkOrder(keys), null);
  assert.equal(new Set(keys).size, 2000);
});

test('keyAt places an item by position and refuses a position outside the list', () => {
  const keys = betweenMany(null, null, 3);
  assert.equal(keyAt(keys, 0) < keys[0]!, true);
  assert.equal(keyAt(keys, 3) > keys[2]!, true);
  const m = keyAt(keys, 1);
  assert.ok(keys[0]! < m && m < keys[1]!);
  assert.throws(() => keyAt(keys, 4), RangeError);
  assert.throws(() => keyAt(keys, -1), RangeError);
  assert.equal(keyAt([], 0), 'a0');
});

test('betweenMany spreads keys evenly instead of growing one long chain', () => {
  const ks = betweenMany('a0', 'a1', 100);
  assert.equal(ks.length, 100);
  assert.equal(checkOrder(ks), null);
  assert.ok(ks.every((k) => k > 'a0' && k < 'a1'));
  assert.ok(Math.max(...ks.map((k) => k.length)) <= 5, 'a hundred keys fit in four digits');
});

test('two clients inserting in the same gap at once: plain keys tie, jittered ones mostly do not, and ties resolve the same everywhere', () => {
  const a = 'a0';
  const b = 'a1';
  assert.equal(between(a, b), between(a, b), 'the plain function gives the same key to both clients');
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const k = jitteredBetween(a, b, rnd);
    assert.ok(a < k && k < b);
    seen.add(k);
  }
  assert.ok(seen.size >= 3, 'three different points of the gap are used');
  assert.equal(jitteredBetween(a, b, () => 0.5), 'a0V');
  const items = [
    { id: 'z', key: 'a0V' },
    { id: 'm', key: 'a0V' },
    { id: 'q', key: 'a0' },
  ];
  assert.deepEqual(orderItems(items).map((i) => i.id), ['q', 'm', 'z'], 'ties break by id');
  assert.deepEqual(orderItems([...items].reverse()).map((i) => i.id), ['q', 'm', 'z'], 'whatever order they arrived in');
});

test('repairDuplicates gives tied items new keys that keep the display order', () => {
  const items = [
    { id: 'a', key: 'a0' },
    { id: 'c', key: 'a1' },
    { id: 'b', key: 'a1' },
    { id: 'd', key: 'a1' },
    { id: 'e', key: 'a2' },
  ];
  const fixes = repairDuplicates(items);
  assert.deepEqual(fixes.map((f) => f.id), ['c', 'd'], 'the first of the tied run keeps its key');
  const after = orderItems(items.map((i) => ({ id: i.id, key: fixes.find((f) => f.id === i.id)?.key ?? i.key })));
  assert.deepEqual(after.map((i) => i.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(checkOrder(after.map((i) => i.key)), null);
  assert.deepEqual(repairDuplicates([{ id: 'x', key: 'a0' }, { id: 'y', key: 'a1' }]), []);
});

test('rebalance gives long keys fresh short ones in the same order', () => {
  let lo = 'a0';
  const list = [lo, 'a1'];
  for (let i = 0; i < 40; i++) {
    lo = between(lo, 'a1');
    list.splice(list.length - 1, 0, lo);
  }
  assert.equal(needsRebalance(list, 8), true);
  assert.equal(needsRebalance(['a0', 'a1'], 8), false);
  const items = list.map((key, i) => ({ id: `i${i}`, key }));
  const fresh = rebalance(items);
  assert.equal(fresh.length, items.length);
  assert.equal(checkOrder(fresh.map((f) => f.key)), null);
  assert.deepEqual(fresh.map((f) => f.id), items.map((i) => i.id));
  assert.equal(needsRebalance(fresh.map((f) => f.key), 8), false);
});

test('checkOrder names the first problem', () => {
  assert.equal(checkOrder(['a0', 'a1', 'a2']), null);
  assert.match(checkOrder(['a1', 'a0'])!, /a1 is not before a0 at 1/);
  assert.match(checkOrder(['a0', 'a0'])!, /not before/);
  assert.match(checkOrder(['a0', 'a10'])!, /not a valid key/);
  assert.equal(checkOrder([]), null);
});

test('the very top and bottom of the range extend the fraction instead of failing or returning a wrong key', () => {
  const top = `z${'z'.repeat(26)}`;
  assert.ok(between(top, null) > top);
  assert.ok(isKey(between(top, null)));
  assert.equal(between('Zz', null), 'a0');
  assert.ok(NoRoom.prototype instanceof Error);
});
