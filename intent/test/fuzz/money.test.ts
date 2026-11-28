/** Fuzz: money arithmetic (blocks/money) and billing with proration (blocks/payments Billing). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPONENT, allocate, divRound, format, money, parse, times } from '../../blocks/money/index.ts';
import { Billing, TEST_METHODS, TwinProvider, type Charge, type Money as PayMoney, type Plan, type Provider } from '../../blocks/payments/index.ts';
import { Rand, forAll } from './harness.ts';

const CURRENCIES = Object.keys(EXPONENT);
const big = (r: Rand): bigint => {
  const digits = r.int(1, 25);
  let s = String(r.int(1, 9));
  for (let i = 1; i < digits; i++) s += String(r.int(0, 9));
  return (r.bool(0.3) ? -1n : 1n) * BigInt(s);
};

/** Half-even rounding of n/d by exact comparison of twice the remainder, written independently. */
const refRound = (n: bigint, d: bigint): bigint => {
  if (d < 0n) (n = -n), (d = -d);
  const floor = n >= 0n ? n / d : -((-n + d - 1n) / d);
  const rem2 = 2n * (n - floor * d); // in [0, 2d)
  if (rem2 < d) return floor;
  if (rem2 > d) return floor + 1n;
  return floor % 2n === 0n ? floor : floor + 1n;
};

test('divRound is half-even, exact for any size, and agrees with an independent reference (5000 cases)', async () => {
  await forAll('money divRound', {
    cases: 5000,
    gen: (r) => ({ n: r.bool(0.3) ? BigInt(r.int(-50, 50)) : big(r), d: r.bool(0.5) ? BigInt(r.pick([1, 2, 3, 4, 10, 100, -2, -4, 7])) : big(r) || 1n }),
    shrink: () => [],
    check: ({ n, d }) => {
      if (d === 0n) return;
      const q = divRound(n, d);
      assert.equal(q, refRound(n, d));
    },
  });
});

test('allocate splits into integer parts that add back to the total exactly, each within one unit of its share (3000 cases)', async () => {
  await forAll('money allocate', {
    cases: 3000,
    gen: (r) => ({ total: r.bool(0.5) ? BigInt(r.int(-1000, 1000)) : big(r), weights: r.array(1, 8, () => (r.bool(0.2) ? 0 : r.int(0, r.pick([3, 100, 1_000_000])))), currency: r.pick(CURRENCIES) }),
    valid: (c) => c.weights.length > 0 && c.weights.some((w) => w > 0),
    check: ({ total, weights, currency }) => {
      if (!weights.some((w) => w > 0)) return assert.throws(() => allocate(money(total, currency), weights), RangeError);
      const parts = allocate(money(total, currency), weights);
      assert.equal(parts.length, weights.length);
      assert.equal(parts.reduce((a, p) => a + p.minor, 0n), total, 'parts do not add back');
      const W = BigInt(weights.reduce((a, b) => a + b, 0));
      parts.forEach((p, i) => {
        assert.equal(p.currency, currency);
        const exact = total * BigInt(weights[i]!); // the exact share, times W
        const diff = p.minor * W - exact;
        assert.ok((diff < 0n ? -diff : diff) < W, `part ${i} is ${p.minor}, more than one unit from its share`);
        if (weights[i] === 0) assert.equal(p.minor, 0n, 'a zero weight got money');
      });
    },
  });
});

test('format and parse round-trip any amount in every currency; parse rounds half-even once (3000 cases)', async () => {
  await forAll('money format/parse', {
    cases: 3000,
    gen: (r) => ({ minor: big(r), currency: r.pick(CURRENCIES), extra: r.int(0, 4), tail: String(r.int(0, 9999)).padStart(4, '0') }),
    shrink: () => [],
    check: ({ minor, currency, extra, tail }) => {
      const m = money(minor, currency);
      const s = format(m);
      assert.match(s, EXPONENT[currency] ? new RegExp(`^-?\\d+\\.\\d{${EXPONENT[currency]}}$`) : /^-?\d+$/);
      assert.deepEqual(parse(s, currency), m);
      // More decimals than the currency has: one half-even rounding of the exact value.
      const e = EXPONENT[currency]!;
      const longer = extra === 0 ? s : `${s}${e ? '' : '.'}${tail.slice(0, extra)}`;
      const scaled = BigInt(longer.replace(/[-.]/g, '')) * (longer.startsWith('-') ? -1n : 1n);
      const fracLen = (longer.split('.')[1] ?? '').length;
      const want = fracLen <= e ? scaled * 10n ** BigInt(e - fracLen) : refRound(scaled, 10n ** BigInt(fracLen - e));
      assert.equal(parse(longer, currency).minor, want, `${longer} ${currency}`);
    },
  });
});

test('times applies a rate with one half-even rounding (2000 cases)', async () => {
  await forAll('money times', {
    cases: 2000,
    gen: (r) => ({ minor: big(r), num: BigInt(r.int(0, 100_000)), den: BigInt(r.pick([100, 10_000, 3, 7, 1])) }),
    shrink: () => [],
    check: ({ minor, num, den }) => assert.equal(times(money(minor, 'USD'), num, den).minor, refRound(minor * num, den)),
  });
});

/** A provider that sometimes loses the answer, before or after the charge was made, as networks do. */
class Flaky implements Provider {
  readonly twin = new TwinProvider();
  readonly seen: { key: string; charge: Charge }[] = [];
  private readonly r: Rand;
  constructor(r: Rand) {
    this.r = r;
  }
  async charge(customer: string, method: string, amount: PayMoney, key: string): Promise<Charge> {
    if (this.r.bool(0.1)) throw new Error('timeout before the charge');
    const c = await this.twin.charge(customer, method, amount, key);
    this.seen.push({ key, charge: c });
    if (this.r.bool(0.1)) throw new Error('timeout after the charge');
    return c;
  }
  confirm(id: string) {
    return this.twin.confirm(id);
  }
  refund(id: string, amount: number, key: string) {
    return this.twin.refund(id, amount, key);
  }
}

const METHODS = [TEST_METHODS.ok, TEST_METHODS.ok, TEST_METHODS.ok, TEST_METHODS.declined, TEST_METHODS.insufficient, TEST_METHODS.needsAction];

test('billing: every invoice total is an integer equal to the sum of its integer lines, and no invoice is charged twice (400 cases)', async () => {
  await forAll('billing invoices', {
    cases: 400,
    gen: (r) => ({
      seed: r.int(0, 2 ** 31),
      plans: r.array(2, 4, (i): Plan => ({ id: `p${i}`, price: { amount: r.pick([0, 1, 99, 999, 1000, 4999, 123_457, 99_999_999]), currency: 'USD' }, periodDays: r.pick([1, 7, 30, 31, 365, r.int(1, 400)]), ...(r.bool(0.3) ? { trialDays: r.int(1, 14) } : {}) })),
      ops: r.array(5, 40, () => r.pick(['subscribe', 'subscribe', 'change', 'change', 'tick', 'tick', 'tick', 'cancel', 'advance', 'advance'] as const)),
    }),
    shrink: () => [],
    check: async ({ seed, plans, ops }) => {
      const r = new Rand(seed);
      let now = Date.UTC(2026, 0, 1);
      const p = new Flaky(r);
      const b = new Billing(p, plans, { now: () => now });
      const expected = /^(the first payment did not go through|the payment for the change did not go through|a cancelled subscription cannot change plan|no subscription \d+)$/;
      for (const op of ops) {
        try {
          if (op === 'subscribe') await b.subscribe(r.pick(['ana', 'ben', 'chioma']), r.pick(plans).id, r.pick(METHODS));
          else if (op === 'change') await b.change(r.int(1, b.subs.length + 1), r.pick(plans).id);
          else if (op === 'cancel') b.cancel(r.int(1, Math.max(1, b.subs.length)), r.bool());
          else if (op === 'tick') await b.tick();
          else now += r.pick([1, 60_000, 3_600_000, 86_400_000, 3 * 86_400_000, 30 * 86_400_000, r.int(0, 400 * 86_400_000)]);
        } catch (e) {
          assert.ok(e instanceof Error && expected.test(e.message), `${op} threw ${e instanceof Error ? e.message : String(e)}`);
        }
        for (const inv of b.invoices) {
          for (const l of inv.lines) assert.ok(Number.isSafeInteger(l.amount), `invoice ${inv.id} line ${l.description} is ${l.amount}`);
          assert.ok(Number.isSafeInteger(inv.total), `invoice ${inv.id} total ${inv.total}`);
          assert.equal(inv.total, inv.lines.reduce((a, l) => a + l.amount, 0), `invoice ${inv.id} total is not the sum of its lines`);
        }
      }
      // At most one succeeded charge per invoice, however many retries and lost answers.
      const paid = new Map<string, Set<string>>();
      for (const { key, charge } of p.seen) {
        const inv = /^inv-(\d+)-/.exec(key)![1]!;
        if (p.twin.charges.get(charge.id)?.state === 'succeeded') paid.set(inv, (paid.get(inv) ?? new Set()).add(charge.id));
      }
      for (const [inv, ids] of paid) assert.ok(ids.size <= 1, `invoice ${inv} was charged ${ids.size} times: ${[...ids].join(', ')}`);
      for (const inv of b.invoices) if (inv.state === 'paid' && inv.total > 0) assert.ok(paid.has(String(inv.id)) || p.seen.some((s) => s.key.startsWith(`inv-${inv.id}-`)), `invoice ${inv.id} is paid with no charge`);
    },
  });
});
