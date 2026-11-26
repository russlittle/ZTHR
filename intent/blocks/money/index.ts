/**
 * Money and rounding. Amounts are whole minor units (cents) in their currency, never floating point. Rounding is
 * half-even, once, where an amount is made. A split always adds back to the total, the leftover minor units going
 * to the largest shares first.
 */

/** Minor units per currency, by ISO 4217. A currency not listed is refused rather than guessed. */
export const EXPONENT: Readonly<Record<string, number>> = { USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, MXN: 2, INR: 2, CNY: 2, CHF: 2, JPY: 0, KRW: 0, CLP: 0, KWD: 3, BHD: 3, JOD: 3 };

export interface Money {
  readonly minor: bigint;
  readonly currency: string;
}

const exp = (currency: string): number => {
  const e = EXPONENT[currency];
  if (e === undefined) throw new RangeError(`unknown currency ${currency}`);
  return e;
};

export const money = (minor: bigint | number, currency: string): Money => {
  exp(currency);
  if (typeof minor === 'number' && !Number.isInteger(minor)) throw new RangeError('minor units are whole numbers');
  return { minor: BigInt(minor), currency };
};

/** Half-even division of a whole number: ties go to the even neighbour, so rounding does not drift one way. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  if (d < 0n) return divRound(-n, -d);
  const q = n / d;
  const r = n % d;
  const twice = 2n * (r < 0n ? -r : r);
  if (twice < d) return q;
  if (twice > d) return q + (n < 0n ? -1n : 1n);
  return q % 2n === 0n ? q : q + (n < 0n ? -1n : 1n);
}

/** Read a decimal string such as "12.345" into minor units, rounding half-even once. */
export function parse(text: string, currency: string): Money {
  const m = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (!m) throw new SyntaxError(`not an amount: ${text}`);
  const e = exp(currency);
  const frac = m[3] ?? '';
  const scaled = BigInt(`${m[2]}${frac}`);
  const shift = frac.length - e;
  const minor = shift <= 0 ? scaled * 10n ** BigInt(-shift) : divRound(scaled, 10n ** BigInt(shift));
  return { minor: m[1] ? -minor : minor, currency };
}

export function format(a: Money): string {
  const e = exp(a.currency);
  const neg = a.minor < 0n;
  const s = (neg ? -a.minor : a.minor).toString().padStart(e + 1, '0');
  return `${neg ? '-' : ''}${e ? `${s.slice(0, -e)}.${s.slice(-e)}` : s}`;
}

const same = (a: Money, b: Money) => {
  if (a.currency !== b.currency) throw new TypeError(`cannot mix ${a.currency} and ${b.currency}`);
};

export const add = (a: Money, b: Money): Money => (same(a, b), { minor: a.minor + b.minor, currency: a.currency });
export const sub = (a: Money, b: Money): Money => (same(a, b), { minor: a.minor - b.minor, currency: a.currency });
export const sum = (xs: readonly Money[], currency: string): Money => xs.reduce(add, money(0, currency));

/** A rate given as a whole-number ratio (a percentage as 825/10000), applied with one half-even rounding. */
export const times = (a: Money, num: bigint, den: bigint): Money => ({ minor: divRound(a.minor * num, den), currency: a.currency });

/** Split by weights so the parts add back to the total exactly: largest remainders get the leftover units. */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (!weights.length || weights.some((w) => !Number.isInteger(w) || w < 0) || weights.every((w) => w === 0)) throw new RangeError('weights are whole, not negative, and not all zero');
  const W = BigInt(weights.reduce((a, b) => a + b, 0));
  const sign = total.minor < 0n ? -1n : 1n;
  const abs = total.minor * sign;
  const base = weights.map((w) => (abs * BigInt(w)) / W);
  const rem = weights.map((w, i) => ({ i, r: (abs * BigInt(w)) % W }));
  let left = abs - base.reduce((a, b) => a + b, 0n);
  for (const { i } of rem.sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i))) {
    if (left === 0n) break;
    base[i] = base[i]! + 1n;
    left--;
  }
  return base.map((m) => ({ minor: m * sign, currency: total.currency }));
}
