/**
 * Fractional indexing: order keys for lists and board columns, so that putting an item between two others changes
 * only the item moved, never its neighbours. A key is a short string; keys compare with plain string comparison
 * (code units), and for any two keys a < b there is a key between them. This is the scheme David Greenspan
 * published and the fractional-indexing libraries use: an integer part whose first letter says how long it is
 * (a..z grow upward from "a0", A..Z downward from "Zz"), then a fractional part in base 62 digits that never ends in
 * the zero digit. The same inputs give the same keys as those libraries, so keys written by them still sort here.
 *
 * Also here: many keys at once, a check that a list of keys is in order and unique, a rebalance that gives a long
 * list fresh short keys when keys have grown, and safety for concurrent inserts: two clients who insert into the
 * same gap at the same moment get the same key from the plain function, so `jitteredBetween` lets each pick a
 * different point of the gap from its own random number, `orderItems` breaks any tie by id so every client shows the
 * same order, and `repairDuplicates` hands out new keys to a tied run once the server has seen both.
 *
 * Out of scope: storing the keys, and deciding who may reorder a list.
 */

export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = BASE62[0]!;
const LAST = BASE62[BASE62.length - 1]!;
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

export class BadKey extends Error {
  constructor(why: string) {
    super(why);
  }
}

export class NoRoom extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** The digits of a fractional part strictly between a and b (b may be null for "no upper bound"). */
function midpoint(a: string, b: string | null, digits: string): string {
  const zero = digits[0]!;
  if (b !== null && a >= b) throw new BadKey(`${a} >= ${b}`);
  if (a.endsWith(zero) || (b !== null && b.endsWith(zero))) throw new BadKey('a fractional part cannot end in the zero digit');
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
  }
  const digitA = a ? digits.indexOf(a[0]!) : 0;
  const digitB = b !== null ? digits.indexOf(b[0]!) : digits.length;
  if (digitB - digitA > 1) return digits[Math.round(0.5 * (digitA + digitB))]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return digits[digitA]! + midpoint(a.slice(1), null, digits);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new BadKey(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const n = integerLength(key[0] ?? '');
  if (n > key.length) throw new BadKey(`invalid order key: ${key}`);
  return key.slice(0, n);
}

function validate(key: string): void {
  if (key === SMALLEST_INTEGER) throw new BadKey(`invalid order key: ${key}`);
  const i = integerPart(key);
  for (const c of key) if (!BASE62.includes(c)) throw new BadKey(`invalid order key: ${key}`);
  if (key.slice(i.length).endsWith(ZERO)) throw new BadKey(`invalid order key: ${key}`);
}

function increment(x: string): string | null {
  validateInteger(x);
  const head = x[0]!;
  const digs = x.slice(1).split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = BASE62.indexOf(digs[i]!) + 1;
    if (d === BASE62.length) digs[i] = ZERO;
    else {
      digs[i] = BASE62[d]!;
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') return `a${ZERO}`;
    if (head === 'z') return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') digs.push(ZERO);
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}

function decrement(x: string): string | null {
  validateInteger(x);
  const head = x[0]!;
  const digs = x.slice(1).split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = BASE62.indexOf(digs[i]!) - 1;
    if (d === -1) digs[i] = LAST;
    else {
      digs[i] = BASE62[d]!;
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') return `Z${LAST}`;
    if (head === 'A') return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') digs.push(LAST);
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}

function validateInteger(i: string): void {
  if (i.length !== integerLength(i[0] ?? '')) throw new BadKey(`invalid integer part of order key: ${i}`);
}

/** Whether a string is a well-formed key. */
export function isKey(key: string): boolean {
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

/** A key strictly between a and b. Null means no bound on that side; null and null gives the first key, "a0". */
export function between(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new BadKey(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb, BASE62);
    if (ib < b) return ib;
    const res = decrement(ib);
    if (res === null) throw new NoRoom('cannot go lower than the smallest key');
    // The smallest integer is not itself a key; the room below the next one is its fractions.
    return res === SMALLEST_INTEGER ? res + midpoint('', null, BASE62) : res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = increment(ia);
    return i === null ? ia + midpoint(fa, null, BASE62) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb, BASE62);
  const i = increment(ia);
  if (i === null) throw new NoRoom('cannot go higher than the largest key');
  if (i < b) return i;
  return ia + midpoint(fa, null, BASE62);
}

/** n keys in order, all strictly between a and b, spread so that they do not grow long. */
export function betweenMany(a: string | null, b: string | null, n: number): string[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n must be a whole number of keys');
  if (n === 0) return [];
  if (n === 1) return [between(a, b)];
  if (b === null) {
    let c = between(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) out.push((c = between(c, b)));
    return out;
  }
  if (a === null) {
    let c = between(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) out.push((c = between(a, c)));
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = between(a, b);
  return [...betweenMany(a, c, mid), c, ...betweenMany(c, b, n - mid - 1)];
}

/**
 * A key in the gap (a, b) that two clients inserting at once are unlikely to share: it picks, by `random`, one of
 * three points of the gap (a third in from each side, or the middle). Still strictly between a and b.
 */
export function jitteredBetween(a: string | null, b: string | null, random: () => number): string {
  const m = between(a, b);
  const r = random();
  if (r < 1 / 3) return between(a, m);
  if (r < 2 / 3) return m;
  return between(m, b);
}

/** The key that puts an item at the position `index` of an ordered list of keys (0 is first, keys.length is last). */
export function keyAt(keys: readonly string[], index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > keys.length) throw new RangeError('position is outside the list');
  return between(keys[index - 1] ?? null, keys[index] ?? null);
}

export interface Item {
  readonly id: string;
  readonly key: string;
}

/** Items in display order: by key, and where two share a key, by id, so every client agrees. */
export function orderItems<T extends Item>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * New keys for items that share a key with another. In the display order of `orderItems`, the first of each tied
 * run keeps its key and the others get keys between it and the next distinct key. Returns only what changed.
 */
export function repairDuplicates(items: readonly Item[]): { id: string; key: string }[] {
  const sorted = orderItems(items);
  const fixes: { id: string; key: string }[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j]!.key === sorted[i]!.key) j++;
    if (j - i > 1) {
      const next = sorted[j]?.key ?? null;
      const fresh = betweenMany(sorted[i]!.key, next, j - i - 1);
      for (let k = i + 1; k < j; k++) fixes.push({ id: sorted[k]!.id, key: fresh[k - i - 1]! });
    }
    i = j;
  }
  return fixes;
}

/** Whether keys are well formed, in strictly increasing order, and unique. Returns the first problem, or null. */
export function checkOrder(keys: readonly string[]): string | null {
  for (let i = 0; i < keys.length; i++) {
    if (!isKey(keys[i]!)) return `${JSON.stringify(keys[i])} at ${i} is not a valid key`;
    if (i > 0 && keys[i - 1]! >= keys[i]!) return `${keys[i - 1]} is not before ${keys[i]} at ${i}`;
  }
  return null;
}

/** Whether any key is longer than `maxLength`, which is when a rebalance is worth doing. */
export function needsRebalance(keys: readonly string[], maxLength = 24): boolean {
  return keys.some((k) => k.length > maxLength);
}

/** Fresh short keys for items already in order: the same order, evenly spread, and no more than a few characters. */
export function rebalance<T extends Item>(ordered: readonly T[]): { id: string; key: string }[] {
  return betweenMany(null, null, ordered.length).map((key, i) => ({ id: ordered[i]!.id, key }));
}
