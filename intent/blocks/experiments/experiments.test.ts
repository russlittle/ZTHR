import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Flags, type Who } from '../flags/index.ts';
import { chiSquareSf, ExperimentError, Experiments, normCdf, normQuantile, SequentialTest, studentTwoSided, studentQuantile, type ExperimentDef } from './index.ts';

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const T0 = Date.UTC(2026, 5, 1);
const def = (o: Partial<ExperimentDef> = {}): ExperimentDef => ({ key: 'checkout-button', variants: [{ id: 'control' }, { id: 'big' }], traffic: 100, ...o });
function rig(flagList: ConstructorParameters<typeof Flags>[0] = []) {
  const clock = { now: T0 };
  const flags = new Flags(flagList);
  const ex = new Experiments({ flags, now: () => clock.now });
  return { clock, flags, ex };
}
const who = (i: number | string): Who => ({ id: `u${i}` });
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the special functions agree with reference values', () => {
  near(normCdf(1.96), 0.9750021048517795);
  near(normCdf(0), 0.5);
  near(normCdf(-1.96), 1 - 0.9750021048517795);
  near(normQuantile(0.975), 1.959963984540054, 1e-6);
  near(studentTwoSided(2.0, 10), 0.07338803477074037);
  near(studentQuantile(0.975, 10), 2.228138851986274, 1e-6);
  near(studentQuantile(0.975, 24.988529290231416), 2.059586491365625, 1e-6);
  near(chiSquareSf(3.841458820694124, 1), 0.05, 1e-9);
  near(chiSquareSf(11.5, 2), 0.0031827807965096665, 1e-9);
  assert.equal(chiSquareSf(0, 3), 1);
});

test('assignment is stable: the same person gets the same variant, on any instance, in any order', () => {
  const a = rig().ex;
  a.define(def());
  a.start('checkout-button');
  const b = rig().ex;
  b.define(def());
  b.start('checkout-button');
  const ids = Array.from({ length: 200 }, (_, i) => i);
  const first = ids.map((i) => a.assignment('checkout-button', who(i)).variant);
  const reversed = [...ids].reverse().map((i) => b.assignment('checkout-button', who(i)).variant).reverse();
  assert.deepEqual(first, reversed);
  assert.equal(a.assignment('checkout-button', who(7)).variant, a.assignment('checkout-button', who(7)).variant);
  const c = rig().ex;
  c.define(def({ salt: 'second run' }));
  c.start('checkout-button');
  assert.notDeepEqual(ids.map((i) => c.assignment('checkout-button', who(i)).variant), first, 'a new salt reshuffles everyone');
});

test('variants get their share of the people, by weight', () => {
  const ex = rig().ex;
  ex.define(def({ variants: [{ id: 'a', weight: 9 }, { id: 'b', weight: 1 }] }));
  ex.start('checkout-button');
  const counts: Record<string, number> = { a: 0, b: 0 };
  for (let i = 0; i < 10_000; i++) counts[ex.assignment('checkout-button', who(i)).variant!]!++;
  assert.ok(counts['a']! > 8800 && counts['a']! < 9200, `a got ${counts['a']}`);
  assert.equal(counts['a']! + counts['b']!, 10_000);
});

test('raising traffic only adds people: nobody who was in is moved out or to another variant', () => {
  const low = rig().ex;
  low.define(def({ traffic: 10, variants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
  low.start('checkout-button');
  const high = rig().ex;
  high.define(def({ traffic: 40, variants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
  high.start('checkout-button');
  let inLow = 0;
  let inHigh = 0;
  for (let i = 0; i < 5000; i++) {
    const l = low.assignment('checkout-button', who(i));
    const h = high.assignment('checkout-button', who(i));
    if (l.variant) {
      inLow++;
      assert.equal(h.variant, l.variant);
    }
    if (h.variant) inHigh++;
    else assert.equal(l.variant, null);
  }
  assert.ok(inLow > 400 && inLow < 600, `${inLow}`);
  assert.ok(inHigh > 1850 && inHigh < 2150, `${inHigh}`);
});

test('two experiments split people independently of each other', () => {
  const ex = rig().ex;
  ex.define(def({ key: 'one' }));
  ex.start('one');
  ex.define(def({ key: 'two' }));
  ex.start('two');
  let same = 0;
  for (let i = 0; i < 4000; i++) if (ex.assignment('one', who(i)).variant === ex.assignment('two', who(i)).variant) same++;
  assert.ok(same > 1800 && same < 2200, `${same} of 4000 matched; independent splits agree about half the time`);
});

test('a feature flag gates who may be in the experiment, and its kill switch ends it at once', () => {
  const { ex, flags } = rig([{ key: 'exp-gate', description: 'gate', owner: 'growth', on: true, rules: [{ groups: ['beta'] }] }]);
  ex.define(def({ flag: 'exp-gate' }));
  ex.start('checkout-button');
  assert.deepEqual(ex.assignment('checkout-button', { id: 'a' }), { variant: null, reason: 'the flag exp-gate does not reach this person (no rule reaches them)' });
  assert.ok(ex.assignment('checkout-button', { id: 'a', groups: ['beta'] }).variant);
  flags.kill('exp-gate');
  assert.equal(ex.assignment('checkout-button', { id: 'a', groups: ['beta'] }).variant, null);
  assert.equal(ex.expose('checkout-button', { id: 'a', groups: ['beta'] }).exposed, false);
  const unknown = rig();
  unknown.ex.define(def({ flag: 'nope' }));
  unknown.ex.start('checkout-button');
  assert.match(unknown.ex.assignment('checkout-button', who(1)).reason, /no such flag/);
});

test('only a running experiment assigns, and a stopped one rolls out its winner without logging', () => {
  const { ex } = rig();
  ex.define(def());
  assert.deepEqual(ex.assignment('checkout-button', who(1)), { variant: null, reason: 'the experiment is draft' });
  ex.start('checkout-button');
  assert.ok(ex.assignment('checkout-button', who(1)).variant);
  ex.stop('checkout-button', 'big');
  assert.deepEqual(ex.assignment('checkout-button', who(1)), { variant: 'big', reason: 'the experiment ended and big was rolled out' });
  assert.equal(ex.expose('checkout-button', who(2)).exposed, false);
  assert.equal(ex.exposures('checkout-button').length, 0);
  assert.throws(() => ex.stop('checkout-button', 'nope'), /not a variant/);
  assert.throws(() => ex.start('checkout-button'), /cannot be started again/);
});

test('an exposure is logged once per person, with its time, and stays with the variant first shown', () => {
  const { ex, clock } = rig();
  ex.define(def());
  ex.start('checkout-button');
  const first = ex.expose('checkout-button', who(1));
  assert.equal(first.exposed, true);
  clock.now += 5000;
  const again = ex.expose('checkout-button', who(1));
  assert.deepEqual([again.variant, again.exposed], [first.variant, true]);
  assert.deepEqual(ex.exposures('checkout-button'), [{ seq: 1, at: T0, experiment: 'checkout-button', unit: 'u1', variant: first.variant }]);
  ex.assignment('checkout-button', who(2));
  assert.equal(ex.exposures('checkout-button').length, 1, 'only expose logs; assignment does not');
  ex.define(def({ key: 'x', variants: [{ id: 'a' }, { id: 'b' }] }));
  ex.start('x');
  const v = ex.expose('x', who(9)).variant;
  ex.reweight('x', [{ id: 'a', weight: v === 'a' ? 1 : 1000 }, { id: 'b', weight: v === 'b' ? 1 : 1000 }]);
  assert.equal(ex.expose('x', who(9)).variant, v, 'reweighting does not move someone already shown a variant');
});

test('hostile or malformed input is refused with plain messages', () => {
  const { ex } = rig();
  assert.throws(() => ex.define(def({ key: '__proto__' })), ExperimentError);
  assert.throws(() => ex.define(def({ key: 'a b' })), /key/);
  assert.throws(() => ex.define(def({ variants: [{ id: 'a' }] })), /two to ten variants/);
  assert.throws(() => ex.define(def({ variants: [{ id: 'a' }, { id: 'a' }] })), /twice/);
  assert.throws(() => ex.define(def({ variants: [{ id: 'a', weight: 0 }, { id: 'b' }] })), /weight/);
  assert.throws(() => ex.define(def({ traffic: 101 })), /traffic/);
  assert.throws(() => ex.define(def({ traffic: Number.NaN })), /traffic/);
  ex.define(def());
  assert.throws(() => ex.define(def()), /already defined/);
  ex.start('checkout-button');
  assert.throws(() => ex.expose('checkout-button', { id: '' }), /person id/);
  assert.throws(() => ex.expose('checkout-button', { id: 'x'.repeat(300) }), /person id/);
  assert.throws(() => ex.expose('nope', who(1)), /no experiment/);
  assert.throws(() => ex.defineMetric('__proto__', 'binary'), ExperimentError);
  assert.throws(() => ex.defineMetric('ok', 'median' as never), /kind/);
});

test('results count only exposed people, ignore events from before exposure, and reject bad numbers', () => {
  const { ex, clock } = rig();
  ex.define(def());
  ex.start('checkout-button');
  ex.defineMetric('buy', 'binary');
  ex.defineMetric('revenue', 'sum');
  ex.defineMetric('views', 'count');
  assert.equal(ex.track('checkout-button', 'u1', 'buy'), 'ignored: not exposed');
  const v = ex.expose('checkout-button', who(1)).variant!;
  clock.now += 1;
  assert.equal(ex.track('checkout-button', 'u1', 'buy'), 'counted');
  ex.track('checkout-button', 'u1', 'buy');
  ex.track('checkout-button', 'u1', 'revenue', 20);
  ex.track('checkout-button', 'u1', 'revenue', 5.5);
  ex.track('checkout-button', 'u1', 'views');
  ex.track('checkout-button', 'u1', 'views');
  ex.track('checkout-button', 'u1', 'views');
  assert.throws(() => ex.track('checkout-button', 'u1', 'revenue', Number.NaN), /finite/);
  assert.throws(() => ex.track('checkout-button', 'u1', 'revenue', Infinity), /finite/);
  assert.throws(() => ex.track('checkout-button', 'u1', 'nope'), /no metric/);
  const raw = (m: string) => ex.results('checkout-button', m).arms.find((a) => a.id === v)!;
  assert.deepEqual([raw('buy').units, raw('buy').mean, raw('revenue').mean, raw('views').mean], [1, 1, 25.5, 3], 'a binary metric is once per person; sums and counts add up');
  const other = ex.results('checkout-button', 'buy').arms.find((a) => a.id !== v)!;
  assert.deepEqual([other.units, other.mean], [0, 0]);
});

test('a fixed-horizon comparison of two rates matches the reference z-test', () => {
  const { ex } = rig();
  ex.define(def({ variants: [{ id: 'control' }, { id: 'big' }] }));
  ex.start('checkout-button');
  ex.defineMetric('buy', 'binary');
  feed(ex, 'control', 1000, 200);
  feed(ex, 'big', 1000, 240);
  const r = ex.results('checkout-button', 'buy', { minPerVariant: 100 });
  const c = r.comparisons[0]!;
  assert.deepEqual([c.variant, c.test], ['big', 'z']);
  near(c.diff, 0.04, 1e-12);
  near(c.relative!, 0.2, 1e-12);
  near(c.p, 0.030837167828904312, 1e-6);
  near(c.ci[0], 0.0037320549244928766, 1e-6);
  near(c.ci[1], 0.07626794507550708, 1e-6);
  assert.deepEqual([c.significant, c.enough], [true, true]);
  assert.equal(ex.results('checkout-button', 'buy', { minPerVariant: 5000 }).comparisons[0]!.significant, false, 'too few people to call');
});

test('a comparison of means matches the reference Welch test', () => {
  const { ex } = rig();
  ex.define(def());
  ex.start('checkout-button');
  ex.defineMetric('time', 'sum');
  const A = [27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4];
  const B = [27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4];
  values(ex, 'control', A);
  values(ex, 'big', B);
  const c = ex.results('checkout-button', 'time', { minPerVariant: 10 }).comparisons[0]!;
  assert.equal(c.test, 'welch');
  near(c.diff, 2.166666666666668, 1e-9);
  near(c.p, 0.021378001462866992, 1e-6);
  near(c.ci[0], 2.166666666666668 - 2.059586491365625 * 0.8824245100137552, 1e-6);
  near(c.ci[1], 2.166666666666668 + 2.059586491365625 * 0.8824245100137552, 1e-6);
});

test('the sequential test can be looked at as often as you like: its p-value only falls, and it keeps its error rate', () => {
  near(1 / new SequentialTest({ tau: 1 }).lambda(3, 1), 0.14906, 1e-4);
  const s = new SequentialTest({ tau: 1 });
  const ps = [s.update(0.1, 1), s.update(3, 1), s.update(0.2, 1), s.update(4, 1), s.update(0, 1)].map((x) => x.p);
  assert.ok(ps.every((p, i) => i === 0 || p <= ps[i - 1]!), 'a p-value never rises once it has fallen');
  assert.ok(ps[3]! < 0.05 && ps[4] === ps[3]);
  // 300 experiments with no real difference, looked at every 100 people up to 4000 per arm.
  const rnd = mulberry32(42);
  let seq = 0;
  let naive = 0;
  for (let run = 0; run < 300; run++) {
    const st = new SequentialTest({ tau: 0.02 });
    let a = 0;
    let b = 0;
    let hitSeq = false;
    let hitNaive = false;
    for (let n = 1; n <= 4000; n++) {
      a += rnd() < 0.1 ? 1 : 0;
      b += rnd() < 0.1 ? 1 : 0;
      if (n % 100 === 0) {
        const pa = a / n;
        const pb = b / n;
        const v = (pa * (1 - pa) + pb * (1 - pb)) / n;
        if (v > 0) {
          if (st.update(pb - pa, v).p < 0.05) hitSeq = true;
          if (2 * (1 - normCdf(Math.abs(pb - pa) / Math.sqrt(v))) < 0.05) hitNaive = true;
        }
      }
    }
    if (hitSeq) seq++;
    if (hitNaive) naive++;
  }
  assert.ok(seq / 300 <= 0.05, `the sequential test made ${seq} false alarms in 300`);
  assert.ok(naive / 300 > 0.15, `a plain test checked repeatedly made ${naive} false alarms in 300, which is why it is not used`);
});

test('results report the sequential verdict beside the fixed one, and correct for several variants', () => {
  const { ex } = rig();
  ex.define(def({ variants: [{ id: 'control' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }));
  ex.start('checkout-button');
  ex.defineMetric('buy', 'binary');
  feed(ex, 'control', 2000, 200);
  feed(ex, 'b', 2000, 300);
  feed(ex, 'c', 2000, 215);
  feed(ex, 'd', 2000, 205);
  const r = ex.results('checkout-button', 'buy', { minPerVariant: 100, tau: 0.02 });
  assert.equal(r.alphaEach, 0.05 / 3, 'the three comparisons share the error budget');
  const by = Object.fromEntries(r.comparisons.map((c) => [c.variant, c]));
  assert.deepEqual([by['b']!.significant, by['b']!.sequential.significant], [true, true]);
  assert.deepEqual([by['d']!.significant, by['d']!.sequential.significant], [false, false]);
  assert.ok(by['b']!.sequential.p < 1e-3);
  const again = ex.results('checkout-button', 'buy', { minPerVariant: 100, tau: 0.02 });
  assert.equal(again.comparisons[0]!.sequential.p, by['b']!.sequential.p, 'looking again at the same data changes nothing');
});

test('a split that does not match the plan is flagged before any result is trusted', () => {
  const { ex } = rig();
  ex.define(def());
  ex.start('checkout-button');
  for (let i = 0; i < 1000; i++) ex.expose('checkout-button', who(i));
  const ok = ex.srm('checkout-button');
  assert.equal(ok.mismatch, false);
  const bad = rig();
  bad.ex.define(def());
  bad.ex.start('checkout-button');
  const want: Record<string, number> = { control: 560, big: 440 };
  const got: Record<string, number> = { control: 0, big: 0 };
  for (let i = 0; got['control']! < 560 || got['big']! < 440; i++) {
    const w = who(`z${i}`);
    const v = bad.ex.assignment('checkout-button', w).variant!;
    if (got[v]! < want[v]!) {
      bad.ex.expose('checkout-button', w);
      got[v]!++;
    }
  }
  const s = bad.ex.srm('checkout-button');
  assert.deepEqual([s.counts['control'], s.counts['big'], s.mismatch], [560, 440, true]);
  near(s.p, 0.00014780231033445398, 1e-9);
});

test('guardrails stop a variant that hurts something we care about, and say so', () => {
  const { ex } = rig();
  ex.define(def());
  ex.start('checkout-button');
  ex.defineMetric('buy', 'binary');
  ex.defineMetric('latency', 'sum');
  feed(ex, 'control', 1000, 100);
  feed(ex, 'big', 1000, 200);
  values(ex, 'control', Array.from({ length: 1000 }, (_, i) => 200 + (i % 20)), 'latency');
  values(ex, 'big', Array.from({ length: 1000 }, (_, i) => 260 + (i % 20)), 'latency');
  const c = ex.check('checkout-button', { primary: 'buy', guardrails: [{ metric: 'latency', better: 'lower', maxRegression: 0.1 }], minPerVariant: 100 });
  assert.deepEqual(c.guardrails.map((g) => [g.metric, g.variant, g.status]), [['latency', 'big', 'breached']]);
  assert.equal(c.verdict, 'stop: big breached the guardrail on latency');
  const lax = ex.check('checkout-button', { primary: 'buy', guardrails: [{ metric: 'latency', better: 'lower', maxRegression: 0.5 }], minPerVariant: 100 });
  assert.equal(lax.guardrails[0]!.status, 'ok');
  assert.equal(lax.verdict, 'ship big: it won on buy with no guardrail breached');
  const few = ex.check('checkout-button', { primary: 'buy', guardrails: [{ metric: 'latency', better: 'lower', maxRegression: 0.1 }], minPerVariant: 5000 });
  assert.equal(few.guardrails[0]!.status, 'not enough data');
  assert.equal(few.verdict, 'keep running: not enough people yet');
});

test('a check also refuses to call a winner when the split was wrong, and reports a loser', () => {
  const { ex } = rig();
  ex.define(def());
  ex.start('checkout-button');
  ex.defineMetric('buy', 'binary');
  feed(ex, 'control', 1000, 300);
  feed(ex, 'big', 1000, 200);
  assert.equal(ex.check('checkout-button', { primary: 'buy', guardrails: [], minPerVariant: 100 }).verdict, 'stop: big lost on buy');
  const skew = rig();
  skew.ex.define(def({ variants: [{ id: 'control', weight: 1 }, { id: 'big', weight: 1 }] }));
  skew.ex.start('checkout-button');
  skew.ex.defineMetric('buy', 'binary');
  feed(skew.ex, 'control', 1500, 450);
  feed(skew.ex, 'big', 800, 400);
  assert.equal(skew.ex.check('checkout-button', { primary: 'buy', guardrails: [], minPerVariant: 100 }).verdict, 'invalid: the split between variants does not match the plan');
});

// ---- helpers: put people into a variant and give them an outcome

function exposeInto(ex: Experiments, variant: string, n: number, tag: string): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const w = who(`${tag}-${i}`);
    if (ex.assignment('checkout-button', w).variant === variant) {
      ex.expose('checkout-button', w);
      out.push(w.id);
    }
  }
  return out;
}
function feed(ex: Experiments, variant: string, n: number, converted: number): void {
  const ids = exposeInto(ex, variant, n, variant);
  for (let i = 0; i < converted; i++) ex.track('checkout-button', ids[i]!, 'buy');
}
function values(ex: Experiments, variant: string, vs: number[], metric = 'time'): void {
  const ids = exposeInto(ex, variant, vs.length, variant);
  vs.forEach((v, i) => ex.track('checkout-button', ids[i]!, metric, v));
}
