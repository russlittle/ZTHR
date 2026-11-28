/**
 * Experiments: A/B and multivariate tests with stable assignment, an exposure log, and results you can trust.
 *
 * Assignment is a hash of the experiment, a salt and the person, so the same person always lands in the same
 * variant on any server in any order; raising the traffic share only adds people; two experiments split people
 * independently. A feature flag (the flags block) can gate who may be in an experiment, and its kill switch ends it
 * at once. Only `expose` writes to the exposure log, once per person, and what a person was first shown is kept even
 * if the weights change later. Results count only exposed people, and an event from before exposure is ignored.
 *
 * Reading results: a fixed-horizon two-proportion z-test (rates) or Welch t-test (means), with confidence intervals
 * and a Bonferroni share of the error budget when there are several variants; a sequential test (the mixture
 * sequential probability ratio test of Johari and others, "Peeking at A/B tests", 2017) whose p-value may be looked
 * at as often as you like without inflating false alarms; a sample-ratio-mismatch check (chi-square) that says when
 * the split is not what was planned, so the data should not be trusted; and guardrail metrics that stop a variant
 * that makes something else worse by more than a stated amount. All statistics are written here (the Student-t,
 * normal and chi-square functions follow Numerical Recipes), and check against reference values in the tests.
 *
 * Out of scope: mutually exclusive layers, stored results between restarts, covariate adjustment, ratio metrics and
 * Bayesian reporting. The default sequential prior is set from the first look at the data, which makes its error
 * guarantee approximate; pass `tau` to fix it before the data arrives for the exact guarantee.
 */
import { bucket, type Flags, type Who } from '../flags/index.ts';

export class ExperimentError extends Error {}

// ---------------------------------------------------------------- special functions

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

/** The regularised lower incomplete gamma function P(a, x). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  return 1 - gammaQcf(a, x);
}

function gammaQcf(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

export const normCdf = (x: number): number => (x >= 0 ? 0.5 * (1 + gammaP(0.5, (x * x) / 2)) : 0.5 * (1 - gammaP(0.5, (x * x) / 2)));

function bisect(f: (x: number) => number, target: number, lo: number, hi: number): number {
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export const normQuantile = (p: number): number => {
  if (!(p > 0 && p < 1)) throw new ExperimentError('a quantile needs a probability between 0 and 1');
  return bisect(normCdf, p, -40, 40);
};

function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}

/** The regularised incomplete beta function I_x(a, b). */
function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** The two-sided p-value of a Student t statistic with `df` degrees of freedom (which need not be whole). */
export const studentTwoSided = (t: number, df: number): number => ibeta(df / (df + t * t), df / 2, 0.5);

/** The t value below which a share `p` (0.5 to 1) of the distribution lies. */
export const studentQuantile = (p: number, df: number): number => {
  if (!(p >= 0.5 && p < 1)) throw new ExperimentError('a t quantile needs a probability from 0.5 up to 1');
  return bisect((t) => 1 - studentTwoSided(t, df) / 2, p, 0, 1e6);
};

/** The chance of a chi-square value at least this large, with `df` degrees of freedom. */
export const chiSquareSf = (x: number, df: number): number => (x <= 0 ? 1 : 1 - gammaP(df / 2, x / 2));

// ---------------------------------------------------------------- sequential test

/**
 * The mixture sequential probability ratio test for a difference of means, with a normal prior of spread `tau` on
 * the true difference. Feed it the observed difference and the variance of that difference as data arrives; the
 * p-value it returns is always valid, and never rises.
 */
export class SequentialTest {
  private readonly t2: number;
  private best = 1;
  constructor(o: { tau: number }) {
    if (!(o.tau > 0) || !Number.isFinite(o.tau)) throw new ExperimentError('tau must be a positive number');
    this.t2 = o.tau * o.tau;
  }
  lambda(theta: number, variance: number): number {
    return Math.sqrt(variance / (variance + this.t2)) * Math.exp((this.t2 * theta * theta) / (2 * variance * (variance + this.t2)));
  }
  update(theta: number, variance: number): { lambda: number; p: number } {
    if (!(variance > 0) || !Number.isFinite(theta)) return { lambda: 1, p: this.best };
    const l = this.lambda(theta, variance);
    this.best = Math.min(this.best, Math.min(1, 1 / l));
    return { lambda: l, p: this.best };
  }
  get p(): number {
    return this.best;
  }
}

// ---------------------------------------------------------------- definitions

export interface VariantDef {
  readonly id: string;
  readonly weight?: number;
}
export interface ExperimentDef {
  readonly key: string;
  /** The first variant is the control. */
  readonly variants: readonly VariantDef[];
  /** The share of people in the experiment at all, 0 to 100. */
  readonly traffic: number;
  readonly salt?: string;
  /** A feature flag that must be on for the person, for targeting and a kill switch. */
  readonly flag?: string;
}
export type MetricKind = 'binary' | 'count' | 'sum';

export interface Assignment {
  readonly variant: string | null;
  readonly reason: string;
}
export interface Exposure {
  readonly seq: number;
  readonly at: number;
  readonly experiment: string;
  readonly unit: string;
  readonly variant: string;
}
export interface Arm {
  readonly id: string;
  readonly units: number;
  readonly mean: number;
  readonly variance: number;
}
export interface Comparison {
  readonly variant: string;
  readonly test: 'z' | 'welch';
  readonly diff: number;
  readonly relative: number | null;
  readonly p: number;
  readonly ci: readonly [number, number];
  readonly enough: boolean;
  readonly significant: boolean;
  readonly sequential: { readonly p: number; readonly significant: boolean };
}
export interface Results {
  readonly metric: string;
  readonly kind: MetricKind;
  readonly arms: readonly Arm[];
  readonly comparisons: readonly Comparison[];
  readonly alphaEach: number;
}
export interface Guardrail {
  readonly metric: string;
  /** Which direction is good. */
  readonly better: 'lower' | 'higher';
  /** How much worse than control, as a share of control, is tolerated. */
  readonly maxRegression: number;
}

interface State {
  def: ExperimentDef;
  weights: VariantDef[];
  status: 'draft' | 'running' | 'stopped';
  winner?: string;
  reweighted: boolean;
  assigned: Map<string, string>;
  log: Exposure[];
  values: Map<string, Map<string, number>>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_UNIT = 256;

export interface ExperimentsOptions {
  readonly flags: Flags;
  readonly now: () => number;
  /** The most people one experiment will hold (default 1,000,000). */
  readonly maxUnits?: number;
}

export class Experiments {
  private readonly o: ExperimentsOptions;
  private readonly all = new Map<string, State>();
  private readonly metrics = new Map<string, MetricKind>();
  private readonly seq = new Map<string, SequentialTest>();
  private readonly taus = new Map<string, number>();
  private n = 0;
  constructor(o: ExperimentsOptions) {
    this.o = o;
  }

  private get(key: string): State {
    const s = this.all.get(key);
    if (!s) throw new ExperimentError(`no experiment "${key}"`);
    return s;
  }

  define(d: ExperimentDef): void {
    if (!KEY.test(d.key)) throw new ExperimentError('an experiment key is letters, digits, "_" and "-", up to 64');
    if (this.all.has(d.key)) throw new ExperimentError(`experiment "${d.key}" is already defined`);
    if (!(d.traffic >= 0 && d.traffic <= 100)) throw new ExperimentError('traffic must be from 0 to 100');
    this.checkVariants(d.variants);
    this.all.set(d.key, { def: d, weights: d.variants.map((v) => ({ id: v.id, weight: v.weight ?? 1 })), status: 'draft', reweighted: false, assigned: new Map(), log: [], values: new Map() });
  }

  private checkVariants(vs: readonly VariantDef[]): void {
    if (vs.length < 2 || vs.length > 10) throw new ExperimentError('use two to ten variants');
    const seen = new Set<string>();
    for (const v of vs) {
      if (!KEY.test(v.id)) throw new ExperimentError('a variant id is letters, digits, "_" and "-"');
      if (seen.has(v.id)) throw new ExperimentError(`variant "${v.id}" is listed twice`);
      seen.add(v.id);
      if (v.weight !== undefined && !(v.weight > 0 && Number.isFinite(v.weight))) throw new ExperimentError('a variant weight must be above zero');
    }
  }

  start(key: string): void {
    const s = this.get(key);
    if (s.status !== 'draft') throw new ExperimentError(`experiment "${key}" is ${s.status} and cannot be started again`);
    s.status = 'running';
  }

  /** End an experiment. With a winner, everyone then gets that variant (and nothing more is logged). */
  stop(key: string, winner?: string): void {
    const s = this.get(key);
    if (winner !== undefined && !s.weights.some((v) => v.id === winner)) throw new ExperimentError(`"${winner}" is not a variant of "${key}"`);
    s.status = 'stopped';
    if (winner !== undefined) s.winner = winner;
  }

  /** Change the weights. People already shown a variant keep it. */
  reweight(key: string, vs: readonly VariantDef[]): void {
    const s = this.get(key);
    this.checkVariants(vs);
    if (vs.length !== s.weights.length || !vs.every((v, i) => v.id === s.weights[i]!.id)) throw new ExperimentError('the variants must be the same ones, in the same order');
    s.weights = vs.map((v) => ({ id: v.id, weight: v.weight ?? 1 }));
    s.reweighted = true;
  }

  defineMetric(name: string, kind: MetricKind): void {
    if (!NAME.test(name)) throw new ExperimentError('a metric name is a letter then letters, digits and "_"');
    if (kind !== 'binary' && kind !== 'count' && kind !== 'sum') throw new ExperimentError('a metric kind is binary, count or sum');
    const have = this.metrics.get(name);
    if (have && have !== kind) throw new ExperimentError(`metric "${name}" is already a ${have} metric`);
    this.metrics.set(name, kind);
  }

  private unit(who: Who): string {
    if (typeof who.id !== 'string' || who.id.length < 1 || who.id.length > MAX_UNIT) throw new ExperimentError(`a person id is 1 to ${MAX_UNIT} characters`);
    return who.id;
  }

  private decide(s: State, who: Who): Assignment {
    if (s.status === 'stopped') return s.winner !== undefined ? { variant: s.winner, reason: `the experiment ended and ${s.winner} was rolled out` } : { variant: null, reason: 'the experiment ended' };
    if (s.status !== 'running') return { variant: null, reason: `the experiment is ${s.status}` };
    if (s.def.flag !== undefined) {
      const r = this.o.flags.explain(s.def.flag, who);
      if (!r.on) return { variant: null, reason: `the flag ${s.def.flag} does not reach this person (${r.because})` };
    }
    const have = s.assigned.get(who.id);
    if (have !== undefined) return { variant: have, reason: 'shown this variant before' };
    const salt = s.def.salt ?? '';
    if (!(bucket(`${s.def.key}:${salt}:in`, who.id) < s.def.traffic)) return { variant: null, reason: 'not in the share of people taking part' };
    const total = s.weights.reduce((a, v) => a + v.weight!, 0);
    let x = (bucket(`${s.def.key}:${salt}:pick`, who.id) / 100) * total;
    for (const v of s.weights) {
      x -= v.weight!;
      if (x < 0) return { variant: v.id, reason: 'assigned by hash' };
    }
    return { variant: s.weights[s.weights.length - 1]!.id, reason: 'assigned by hash' };
  }

  /** The variant this person would see, without recording anything. */
  assignment(key: string, who: Who): Assignment {
    this.unit(who);
    return this.decide(this.get(key), who);
  }

  /** Record that this person was shown the experiment, once, and say which variant. */
  expose(key: string, who: Who): Assignment & { exposed: boolean } {
    this.unit(who);
    const s = this.get(key);
    const a = this.decide(s, who);
    if (a.variant === null || s.status !== 'running') return { ...a, exposed: false };
    if (!s.assigned.has(who.id)) {
      if (s.assigned.size >= (this.o.maxUnits ?? 1_000_000)) throw new ExperimentError('too many people in this experiment');
      s.assigned.set(who.id, a.variant);
      s.log.push({ seq: ++this.n, at: this.o.now(), experiment: key, unit: who.id, variant: a.variant });
    }
    return { ...a, exposed: true };
  }

  exposures(key: string): readonly Exposure[] {
    return [...this.get(key).log];
  }

  /** Record an outcome for a person. Outcomes from people never shown the experiment are ignored. */
  track(key: string, unit: string, metric: string, value = 1): 'counted' | 'ignored: not exposed' | 'ignored: not running' {
    const s = this.get(key);
    const kind = this.metrics.get(metric);
    if (kind === undefined) throw new ExperimentError(`no metric "${metric}"`);
    if (kind === 'sum' && !Number.isFinite(value)) throw new ExperimentError('a value must be a finite number');
    if (s.status !== 'running') return 'ignored: not running';
    if (!s.assigned.has(unit)) return 'ignored: not exposed';
    let m = s.values.get(metric);
    if (!m) s.values.set(metric, (m = new Map()));
    const was = m.get(unit) ?? 0;
    m.set(unit, kind === 'binary' ? 1 : kind === 'count' ? was + 1 : was + value);
    return 'counted';
  }

  private arms(s: State, metric: string): { arms: Arm[]; kind: MetricKind } {
    const kind = this.metrics.get(metric);
    if (kind === undefined) throw new ExperimentError(`no metric "${metric}"`);
    const m = s.values.get(metric);
    const acc = new Map(s.weights.map((v) => [v.id, { n: 0, mean: 0, m2: 0 }]));
    for (const [unit, variant] of s.assigned) {
      const a = acc.get(variant);
      if (!a) continue;
      const x = m?.get(unit) ?? 0;
      a.n++;
      const d = x - a.mean;
      a.mean += d / a.n;
      a.m2 += d * (x - a.mean);
    }
    return { kind, arms: s.weights.map((v) => { const a = acc.get(v.id)!; return { id: v.id, units: a.n, mean: a.mean, variance: a.n > 1 ? a.m2 / (a.n - 1) : 0 }; }) };
  }

  results(key: string, metric: string, o: { alpha?: number; minPerVariant?: number; tau?: number } = {}): Results {
    const s = this.get(key);
    const alpha = o.alpha ?? 0.05;
    if (!(alpha > 0 && alpha < 1)) throw new ExperimentError('alpha must be between 0 and 1');
    const min = o.minPerVariant ?? 100;
    const { arms, kind } = this.arms(s, metric);
    const control = arms[0]!;
    const alphaEach = alpha / (arms.length - 1);
    const comparisons = arms.slice(1).map((a): Comparison => {
      const diff = a.mean - control.mean;
      const enough = a.units >= Math.max(2, min) && control.units >= Math.max(2, min);
      let p = 1;
      let half = Infinity;
      let v = 0;
      if (a.units >= 2 && control.units >= 2) {
        if (kind === 'binary') {
          const pooled = (a.mean * a.units + control.mean * control.units) / (a.units + control.units);
          const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / a.units + 1 / control.units));
          p = sePooled > 0 ? 2 * (1 - normCdf(Math.abs(diff) / sePooled)) : 1;
          v = (a.mean * (1 - a.mean)) / a.units + (control.mean * (1 - control.mean)) / control.units;
          half = normQuantile(1 - alphaEach / 2) * Math.sqrt(v);
        } else {
          const va = a.variance / a.units;
          const vc = control.variance / control.units;
          v = va + vc;
          if (v > 0) {
            const df = (v * v) / ((va * va) / (a.units - 1) + (vc * vc) / (control.units - 1));
            p = studentTwoSided(diff / Math.sqrt(v), df);
            half = studentQuantile(1 - alphaEach / 2, df) * Math.sqrt(v);
          } else half = 0;
        }
      }
      const test = kind === 'binary' ? 'z' : 'welch';
      let sp = 1;
      if (enough && v > 0) {
        const tauKey = `${key}\0${metric}`;
        let tau = o.tau;
        if (tau === undefined) {
          if (!this.taus.has(tauKey)) this.taus.set(tauKey, Math.max(1e-9, 0.1 * Math.sqrt((a.variance + control.variance) / 2 || (v * Math.min(a.units, control.units)))));
          tau = this.taus.get(tauKey)!;
        }
        const sk = `${tauKey}\0${a.id}\0${tau}`;
        let st = this.seq.get(sk);
        if (!st) this.seq.set(sk, (st = new SequentialTest({ tau })));
        sp = st.update(diff, v).p;
      }
      return {
        variant: a.id,
        test,
        diff,
        relative: control.mean !== 0 ? diff / Math.abs(control.mean) : null,
        p,
        ci: [diff - half, diff + half],
        enough,
        significant: enough && p < alphaEach,
        sequential: { p: sp, significant: enough && sp <= alphaEach },
      };
    });
    return { metric, kind, arms, comparisons, alphaEach };
  }

  /** The sample-ratio check: did people land in the variants in the planned proportions? */
  srm(key: string): { counts: Record<string, number>; expected: Record<string, number>; chi2: number; p: number; mismatch: boolean; reweighted: boolean } {
    const s = this.get(key);
    const counts: Record<string, number> = Object.fromEntries(s.weights.map((v) => [v.id, 0]));
    for (const v of s.assigned.values()) counts[v] = (counts[v] ?? 0) + 1;
    const total = s.assigned.size;
    const wsum = s.weights.reduce((a, v) => a + v.weight!, 0);
    const expected = Object.fromEntries(s.weights.map((v) => [v.id, (total * v.weight!) / wsum]));
    const chi2 = s.weights.reduce((a, v) => a + (counts[v.id]! - expected[v.id]!) ** 2 / expected[v.id]!, 0);
    const p = total > 0 ? chiSquareSf(chi2, s.weights.length - 1) : 1;
    return { counts, expected, chi2, p, mismatch: p < 0.001 && !s.reweighted, reweighted: s.reweighted };
  }

  /** Put it all together: is the data sound, did anything break, and is there a winner? */
  check(key: string, o: { primary: string; guardrails: readonly Guardrail[]; minPerVariant?: number; alpha?: number; better?: 'higher' | 'lower' }) {
    const ropts = { ...(o.minPerVariant !== undefined ? { minPerVariant: o.minPerVariant } : {}), ...(o.alpha !== undefined ? { alpha: o.alpha } : {}) };
    const srm = this.srm(key);
    const primary = this.results(key, o.primary, ropts);
    const guardrails: { metric: string; variant: string; status: 'ok' | 'breached' | 'not enough data'; relative: number | null }[] = [];
    for (const g of o.guardrails) {
      const r = this.results(key, g.metric, ropts);
      const cm = r.arms[0]!.mean;
      for (const c of r.comparisons) {
        if (!c.enough || cm === 0) {
          guardrails.push({ metric: g.metric, variant: c.variant, status: 'not enough data', relative: c.relative });
          continue;
        }
        const worstLow = g.better === 'lower' ? c.ci[0] / Math.abs(cm) : -c.ci[1] / Math.abs(cm);
        guardrails.push({ metric: g.metric, variant: c.variant, status: worstLow > g.maxRegression ? 'breached' : 'ok', relative: c.relative });
      }
    }
    const sign = o.better === 'lower' ? -1 : 1;
    let verdict: string;
    const breached = guardrails.find((g) => g.status === 'breached');
    if (srm.mismatch) verdict = 'invalid: the split between variants does not match the plan';
    else if (breached) verdict = `stop: ${breached.variant} breached the guardrail on ${breached.metric}`;
    else if (primary.comparisons.some((c) => !c.enough)) verdict = 'keep running: not enough people yet';
    else {
      const wins = primary.comparisons.filter((c) => c.sequential.significant && sign * c.diff > 0).sort((a, b) => sign * (b.diff - a.diff));
      const loses = primary.comparisons.filter((c) => c.sequential.significant && sign * c.diff < 0);
      if (wins.length) verdict = guardrails.some((g) => g.status === 'not enough data') ? 'keep running: a guardrail has not enough data yet' : `ship ${wins[0]!.variant}: it won on ${o.primary} with no guardrail breached`;
      else if (loses.length) verdict = `stop: ${loses[0]!.variant} lost on ${o.primary}`;
      else verdict = 'keep running: no clear difference yet';
    }
    return { verdict, srm, primary, guardrails };
  }
}
