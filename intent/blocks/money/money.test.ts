import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, allocate, divRound, format, money, parse, sub, sum, times } from './index.ts';

test('amounts are whole minor units, read and written exactly', () => {
  assert.equal(parse('19.99', 'USD').minor, 1999n);
  assert.equal(parse('5', 'USD').minor, 500n);
  assert.equal(parse('-0.5', 'USD').minor, -50n);
  assert.equal(parse('1234', 'JPY').minor, 1234n);
  assert.equal(parse('1.2345', 'KWD').minor, 1234n, 'half-even: 1234.5 rounds to the even 1234');
  assert.equal(format(money(1999, 'USD')), '19.99');
  assert.equal(format(money(-5, 'USD')), '-0.05');
  assert.equal(format(money(1234, 'JPY')), '1234');
  assert.throws(() => parse('12.3.4', 'USD'), SyntaxError);
  assert.throws(() => money(1.5, 'USD'), RangeError);
  assert.throws(() => money(1, 'XYZ'), RangeError, 'an unknown currency is refused, not guessed');
});

test('half-even rounding does not drift', () => {
  assert.deepEqual([divRound(5n, 2n), divRound(7n, 2n), divRound(-5n, 2n), divRound(-7n, 2n), divRound(10n, 3n), divRound(11n, 3n), divRound(5n, -2n)], [2n, 4n, -2n, -4n, 3n, 4n, -2n]);
  assert.throws(() => divRound(1n, 0n), RangeError);
  assert.equal(times(money(1000, 'USD'), 825n, 10000n).minor, 82n, 'tax of 8.25% on 10.00 is 0.82');
});

test('currencies never mix', () => {
  assert.equal(add(money(100, 'USD'), money(1, 'USD')).minor, 101n);
  assert.equal(sub(money(100, 'USD'), money(1, 'USD')).minor, 99n);
  assert.equal(sum([money(1, 'EUR'), money(2, 'EUR')], 'EUR').minor, 3n);
  assert.throws(() => add(money(1, 'USD'), money(1, 'EUR')), TypeError);
});

test('a split always adds back to the total', () => {
  const parts = allocate(money(100, 'USD'), [1, 1, 1]);
  assert.deepEqual(parts.map((p) => p.minor), [34n, 33n, 33n]);
  assert.equal(sum(parts, 'USD').minor, 100n);
  assert.deepEqual(allocate(money(-100, 'USD'), [1, 1, 1]).map((p) => p.minor), [-34n, -33n, -33n]);
  assert.deepEqual(allocate(money(5, 'USD'), [3, 7]).map((p) => p.minor), [2n, 3n], '1.5 and 3.5: the leftover unit goes to the first of equal remainders');
  for (let total = 0; total < 200; total += 7) for (const w of [[1, 2, 3], [5, 0, 5], [1], [9, 1, 1, 1]]) assert.equal(sum(allocate(money(total, 'USD'), w), 'USD').minor, BigInt(total));
  assert.throws(() => allocate(money(1, 'USD'), [0, 0]), RangeError);
  assert.throws(() => allocate(money(1, 'USD'), [1.5]), RangeError);
});
