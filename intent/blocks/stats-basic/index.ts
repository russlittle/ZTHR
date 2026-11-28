/**
 * stats-basic: the everyday statistics, done carefully. Descriptive statistics (mean, median, quantiles in the nine
 * Hyndman and Fan definitions that matter, variance, skewness, kurtosis, streaming and mergeable moments), the
 * distributions behind the tests (normal, Student t, chi-square, beta, gamma), hypothesis tests (one-sample, Welch,
 * pooled and paired t; chi-square goodness of fit and independence; Pearson correlation), confidence intervals (mean,
 * variance, proportion by Wilson and Clopper-Pearson), effect sizes (Cohen's d, Hedges' g, Cramer's V) and sample-size
 * planning for means and proportions.
 *
 * Follows: Hyndman and Fan (1996), "Sample quantiles in statistical packages", The American Statistician 50(4);
 * Wichura (1988) AS241 style accuracy for the normal quantile (Acklam's approximation refined by Halley steps);
 * Numerical Recipes style Lanczos log-gamma, incomplete gamma and incomplete beta; Welch-Satterthwaite degrees of
 * freedom; Wilson (1927) and Clopper and Pearson (1934) intervals; Chan, Golub and LeVeque pairwise moment merging.
 * Reference values in the tests were checked against SciPy.
 *
 * Out of scope: non-parametric tests, ANOVA, regression, multiple-comparison correction, power for tests other than
 * the normal approximation. Nothing here is random; no clock is used.
 *
 * Security: inputs are validated (finite numbers only, sizes bounded by maxSamples) so hostile arrays and NaN cannot
 * quietly produce a plausible-looking answer.
 */

export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsError';
  }
}

/** Largest sample any function here accepts. */
export const MAX_SAMPLES = 10_000_000;

function sample(xs: readonly number[], min = 1, name = 'sample'): void {
  if (!Array.isArray(xs)) throw new StatsError(`${name} must be an array of numbers`);
  if (xs.length < min) throw new StatsError(`${name} needs at least ${min} value${min === 1 ? '' : 's'}, got ${xs.length}`);
  if (xs.length > MAX_SAMPLES) throw new StatsError(`${name} has more than ${MAX_SAMPLES} values`);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new StatsError(`${name}[${i}] is not a finite number`);
  }
}

function prob(p: number, name = 'p'): void {
  if (typeof p !== 'number' || !(p > 0 && p < 1)) throw new StatsError(`${name} must be strictly between 0 and 1`);
}

// ---------------------------------------------------------------------------------------------------------------
// Descriptive statistics

/** Sum with Neumaier compensation, so long lists of mixed sizes do not lose digits. */
export function sum(xs: readonly number[]): number {
  sample(xs, 0);
  let s = 0;
  let c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return s + c;
}

export function mean(xs: readonly number[]): number {
  sample(xs);
  return sum(xs) / xs.length;
}

/** Variance. ddof 1 (default) is the sample variance; ddof 0 the population variance. Two-pass for accuracy. */
export function variance(xs: readonly number[], ddof = 1): number {
  sample(xs, ddof === 1 ? 2 : 1);
  if (ddof !== 0 && ddof !== 1) throw new StatsError('ddof must be 0 or 1');
  if (xs.length - ddof < 1) throw new StatsError('not enough values for this variance');
  const m = mean(xs);
  const devs = xs.map((x) => (x - m) ** 2);
  return sum(devs) / (xs.length - ddof);
}

export function stdev(xs: readonly number[], ddof = 1): number {
  return Math.sqrt(variance(xs, ddof));
}

export function standardError(xs: readonly number[]): number {
  return stdev(xs) / Math.sqrt(xs.length);
}

function sorted(xs: readonly number[]): number[] {
  sample(xs);
  return [...xs].sort((a, b) => a - b);
}

export type QuantileType = 1 | 4 | 5 | 6 | 7 | 8 | 9;

/** Quantile by Hyndman and Fan definition. Type 7 (the default) is what R, NumPy and spreadsheets use. */
export function quantile(xs: readonly number[], p: number, type: QuantileType = 7): number {
  if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new StatsError('p must be between 0 and 1');
  const s = sorted(xs);
  return quantileSorted(s, p, type);
}

function quantileSorted(s: readonly number[], p: number, type: QuantileType): number {
  const n = s.length;
  const at = (j: number): number => s[Math.min(n, Math.max(1, j)) - 1]!;
  if (type === 1) return at(Math.ceil(n * p - 1e-12) || 1);
  const m: Record<number, number> = { 4: 0, 5: 0.5, 6: p, 7: 1 - p, 8: (p + 1) / 3, 9: p / 4 + 3 / 8 };
  const mm = m[type];
  if (mm === undefined) throw new StatsError('quantile type must be one of 1, 4, 5, 6, 7, 8, 9');
  const x = n * p + mm;
  const j = Math.floor(x + 1e-12);
  const g = x - j < 1e-12 ? 0 : x - j;
  return g === 0 ? at(j) : (1 - g) * at(j) + g * at(j + 1);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5, 7);
}

/** Median absolute deviation from the median (unscaled). */
export function medianAbsoluteDeviation(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Most common values, ascending. Several are returned on a tie. */
export function modes(xs: readonly number[]): number[] {
  sample(xs);
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x === 0 ? 0 : x, (counts.get(x === 0 ? 0 : x) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return [...counts].filter(([, c]) => c === top).map(([x]) => x).sort((a, b) => a - b);
}

/** Adjusted Fisher-Pearson skewness (G1), as SciPy's bias=False. Needs 3 values. */
export function skewness(xs: readonly number[]): number {
  sample(xs, 3);
  const n = xs.length;
  const m = mean(xs);
  const m2 = sum(xs.map((x) => (x - m) ** 2)) / n;
  const m3 = sum(xs.map((x) => (x - m) ** 3)) / n;
  if (m2 === 0) return NaN;
  const g1 = m3 / m2 ** 1.5;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * g1;
}

/** Adjusted excess kurtosis (G2), as SciPy's bias=False. Needs 4 values. */
export function kurtosis(xs: readonly number[]): number {
  sample(xs, 4);
  const n = xs.length;
  const m = mean(xs);
  const m2 = sum(xs.map((x) => (x - m) ** 2)) / n;
  const m4 = sum(xs.map((x) => (x - m) ** 4)) / n;
  if (m2 === 0) return NaN;
  const g2 = m4 / m2 ** 2 - 3;
  return ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6);
}

export interface Summary {
  readonly n: number;
  readonly mean: number;
  readonly variance: number;
  readonly stdev: number;
  readonly sem: number;
  readonly min: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly max: number;
  readonly iqr: number;
}

export function describe(xs: readonly number[]): Summary {
  const s = sorted(xs);
  const n = s.length;
  const v = n > 1 ? variance(s) : NaN;
  const q1 = quantileSorted(s, 0.25, 7);
  const q3 = quantileSorted(s, 0.75, 7);
  return { n, mean: mean(s), variance: v, stdev: Math.sqrt(v), sem: Math.sqrt(v / n), min: s[0]!, q1, median: quantileSorted(s, 0.5, 7), q3, max: s[n - 1]!, iqr: q3 - q1 };
}

/** Values outside the Tukey fences (k times the IQR beyond the quartiles; 1.5 by default). */
export function outliers(xs: readonly number[], k = 1.5): number[] {
  const d = describe(xs);
  const lo = d.q1 - k * d.iqr;
  const hi = d.q3 + k * d.iqr;
  return xs.filter((x) => x < lo || x > hi);
}

/** One-pass mean and variance (Welford) that can be merged (Chan et al.), for data that arrives in pieces. */
export class RunningStats {
  n = 0;
  private m = 0;
  private m2 = 0;
  private lo = Infinity;
  private hi = -Infinity;

  push(x: number): void {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new StatsError('value is not a finite number');
    this.n++;
    const d = x - this.m;
    this.m += d / this.n;
    this.m2 += d * (x - this.m);
    if (x < this.lo) this.lo = x;
    if (x > this.hi) this.hi = x;
  }

  get mean(): number {
    return this.n ? this.m : NaN;
  }

  get variance(): number {
    return this.n > 1 ? this.m2 / (this.n - 1) : NaN;
  }

  get min(): number {
    return this.lo;
  }

  get max(): number {
    return this.hi;
  }

  merge(o: RunningStats): RunningStats {
    const r = new RunningStats();
    r.n = this.n + o.n;
    if (r.n === 0) return r;
    const d = o.m - this.m;
    r.m = this.m + (d * o.n) / r.n;
    r.m2 = this.m2 + o.m2 + (d * d * this.n * o.n) / r.n;
    r.lo = Math.min(this.lo, o.lo);
    r.hi = Math.max(this.hi, o.hi);
    return r;
  }
}

/** Pearson correlation coefficient. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  sample(xs, 2, 'xs');
  sample(ys, 2, 'ys');
  if (xs.length !== ys.length) throw new StatsError('the two samples must be the same length');
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) throw new StatsError('correlation is undefined when one sample is constant');
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

// ---------------------------------------------------------------------------------------------------------------
// Special functions and distributions

const LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

/** Natural log of the gamma function, for x greater than 0. */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new StatsError('logGamma needs x > 0');
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i]! / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (!(a > 0) || !(x >= 0)) throw new StatsError('gammaP needs a > 0 and x >= 0');
  if (x === 0) return 0;
  if (!Number.isFinite(x)) return 1;
  const lg = logGamma(a);
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let s = del;
    for (let i = 0; i < 10_000; i++) {
      ap++;
      del *= x / ap;
      s += del;
      if (Math.abs(del) < Math.abs(s) * 1e-16) break;
    }
    return s * Math.exp(-x + a * Math.log(x) - lg);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10_000; i++) {
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
  return 1 - Math.exp(-x + a * Math.log(x) - lg) * h;
}

/** Regularised incomplete beta I_x(a, b). */
export function betaI(x: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) throw new StatsError('betaI needs a > 0 and b > 0');
  if (!(x >= 0 && x <= 1)) throw new StatsError('betaI needs 0 <= x <= 1');
  if (x === 0) return 0;
  if (x === 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (xx: number, aa: number, bb: number): number => {
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m < 10_000; m++) {
      const m2 = 2 * m;
      let num = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + num * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + num / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      num = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + num * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + num / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-16) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? (front * cf(x, a, b)) / a : 1 - (front * cf(1 - x, b, a)) / b;
}

export function normalCdf(z: number): number {
  if (Number.isNaN(z)) throw new StatsError('z is not a number');
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  const p = gammaP(0.5, (z * z) / 2) / 2;
  return z >= 0 ? 0.5 + p : 0.5 - p;
}

function normalSf(z: number): number {
  return z > 0 ? 0.5 * (1 - gammaP(0.5, (z * z) / 2)) : normalCdf(-z);
}

export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Inverse of the normal CDF: Acklam's rational approximation, then two Halley steps. */
export function normalQuantile(p: number): number {
  prob(p);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  let x: number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  for (let i = 0; i < 2; i++) {
    const e = (p < 0.5 ? normalCdf(x) - p : -(normalSf(x) - (1 - p)));
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

export function tCdf(t: number, df: number): number {
  if (!(df > 0)) throw new StatsError('degrees of freedom must be positive');
  if (Number.isNaN(t)) throw new StatsError('t is not a number');
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  const x = df / (df + t * t);
  const tail = 0.5 * betaI(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

function bisectQuantile(cdf: (x: number) => number, p: number, lo: number, hi: number): number {
  while (cdf(hi) < p && hi < 1e300) hi = hi > 0 ? hi * 2 : 1;
  while (cdf(lo) > p && lo > -1e300) lo = lo < 0 ? lo * 2 : -1;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-15 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}

export function tQuantile(p: number, df: number): number {
  prob(p);
  if (!(df > 0)) throw new StatsError('degrees of freedom must be positive');
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  return bisectQuantile((x) => tCdf(x, df), p, 0, 10);
}

export function chiSquareCdf(x: number, df: number): number {
  if (!(df > 0)) throw new StatsError('degrees of freedom must be positive');
  return x <= 0 ? 0 : gammaP(df / 2, x / 2);
}

export function chiSquareQuantile(p: number, df: number): number {
  prob(p);
  if (!(df > 0)) throw new StatsError('degrees of freedom must be positive');
  return bisectQuantile((x) => chiSquareCdf(x, df), p, 0, Math.max(10, df * 3));
}

// ---------------------------------------------------------------------------------------------------------------
// Hypothesis tests

export type Alternative = 'two-sided' | 'less' | 'greater';

export interface TestResult {
  readonly statistic: number;
  readonly df: number;
  readonly p: number;
  readonly alternative: Alternative;
  readonly estimate: number;
  readonly ci: readonly [number, number];
}

function tPValue(t: number, df: number, alt: Alternative): number {
  if (alt === 'less') return tCdf(t, df);
  if (alt === 'greater') return tCdf(-t, df);
  return Math.min(1, 2 * tCdf(-Math.abs(t), df));
}

function tInterval(est: number, se: number, df: number, conf: number, alt: Alternative): [number, number] {
  prob(conf, 'confidence');
  if (alt === 'two-sided') {
    const q = tQuantile(1 - (1 - conf) / 2, df);
    return [est - q * se, est + q * se];
  }
  const q = tQuantile(conf, df);
  return alt === 'less' ? [-Infinity, est + q * se] : [est - q * se, Infinity];
}

export interface TOptions {
  readonly alternative?: Alternative;
  readonly confidence?: number;
}

/** One-sample t-test of the mean against mu. */
export function tTestOneSample(xs: readonly number[], mu: number, o: TOptions = {}): TestResult {
  sample(xs, 2);
  const alt = o.alternative ?? 'two-sided';
  const n = xs.length;
  const m = mean(xs);
  const se = standardError(xs);
  if (se === 0) throw new StatsError('the sample has no spread, so the t statistic is undefined');
  const t = (m - mu) / se;
  const ci = tInterval(m, se, n - 1, o.confidence ?? 0.95, alt);
  return { statistic: t, df: n - 1, p: tPValue(t, n - 1, alt), alternative: alt, estimate: m, ci: [ci[0], ci[1]] };
}

/** Two-sample t-test of the difference in means (first minus second). Welch unless equalVariance is set. */
export function tTestTwoSample(xs: readonly number[], ys: readonly number[], o: TOptions & { readonly equalVariance?: boolean } = {}): TestResult {
  sample(xs, 2, 'xs');
  sample(ys, 2, 'ys');
  const alt = o.alternative ?? 'two-sided';
  const n1 = xs.length;
  const n2 = ys.length;
  const v1 = variance(xs);
  const v2 = variance(ys);
  const diff = mean(xs) - mean(ys);
  let se: number;
  let df: number;
  if (o.equalVariance) {
    df = n1 + n2 - 2;
    const sp = ((n1 - 1) * v1 + (n2 - 1) * v2) / df;
    se = Math.sqrt(sp * (1 / n1 + 1 / n2));
  } else {
    const a = v1 / n1;
    const b = v2 / n2;
    se = Math.sqrt(a + b);
    df = (a + b) ** 2 / ((a * a) / (n1 - 1) + (b * b) / (n2 - 1));
  }
  if (se === 0) throw new StatsError('neither sample has any spread, so the t statistic is undefined');
  const t = diff / se;
  const ci = tInterval(diff, se, df, o.confidence ?? 0.95, alt);
  return { statistic: t, df, p: tPValue(t, df, alt), alternative: alt, estimate: diff, ci: [ci[0], ci[1]] };
}

/** Paired t-test on the differences xs minus ys. */
export function tTestPaired(xs: readonly number[], ys: readonly number[], o: TOptions = {}): TestResult {
  sample(xs, 2, 'xs');
  sample(ys, 2, 'ys');
  if (xs.length !== ys.length) throw new StatsError('paired samples must be the same length');
  return tTestOneSample(xs.map((x, i) => x - ys[i]!), 0, o);
}

export interface ChiSquareResult {
  readonly statistic: number;
  readonly df: number;
  readonly p: number;
  readonly expected: readonly (readonly number[])[] | readonly number[];
  /** Smallest expected count; below 5 the approximation is poor and `warning` says so. */
  readonly minExpected: number;
  readonly warning?: string;
}

function chiResult(stat: number, df: number, expected: readonly number[] | readonly (readonly number[])[], minE: number): ChiSquareResult {
  const p = 1 - chiSquareCdf(stat, df);
  const base = { statistic: stat, df, p: Math.max(0, p), expected, minExpected: minE };
  return minE < 5 ? { ...base, warning: 'some expected counts are below 5, so the chi-square approximation may be poor' } : base;
}

/** Chi-square goodness of fit. Expected may be proportions (summing to 1) or counts; omitted means uniform. */
export function chiSquareGof(observed: readonly number[], expected?: readonly number[]): ChiSquareResult {
  sample(observed, 2, 'observed');
  if (observed.some((o) => o < 0)) throw new StatsError('counts cannot be negative');
  const total = sum(observed);
  if (total <= 0) throw new StatsError('there are no observations');
  let e: number[];
  if (!expected) e = observed.map(() => total / observed.length);
  else {
    sample(expected, 2, 'expected');
    if (expected.length !== observed.length) throw new StatsError('observed and expected must be the same length');
    if (expected.some((x) => x <= 0)) throw new StatsError('expected values must be positive');
    const es = sum(expected);
    e = expected.map((x) => (x * total) / es);
  }
  let stat = 0;
  for (let i = 0; i < observed.length; i++) stat += (observed[i]! - e[i]!) ** 2 / e[i]!;
  return chiResult(stat, observed.length - 1, e, Math.min(...e));
}

/** Chi-square test of independence on a table of counts. Yates' correction applies to 2x2 tables only, when asked. */
export function chiSquareIndependence(table: readonly (readonly number[])[], o: { readonly yates?: boolean } = {}): ChiSquareResult {
  if (!Array.isArray(table) || table.length < 2) throw new StatsError('the table needs at least 2 rows');
  const cols = table[0]?.length ?? 0;
  if (cols < 2) throw new StatsError('the table needs at least 2 columns');
  for (const row of table) {
    sample(row, cols, 'row');
    if (row.length !== cols) throw new StatsError('every row must have the same number of columns');
    if (row.some((x: number) => x < 0)) throw new StatsError('counts cannot be negative');
  }
  const rows = table.map((r) => sum(r));
  const colSums = Array.from({ length: cols }, (_, j) => sum(table.map((r) => r[j]!)));
  const total = sum(rows);
  if (rows.some((r) => r === 0) || colSums.some((c) => c === 0)) throw new StatsError('a row or column with no observations makes the test undefined');
  const expected = table.map((_, i) => colSums.map((c) => (rows[i]! * c) / total));
  const yates = !!o.yates && table.length === 2 && cols === 2;
  let stat = 0;
  let minE = Infinity;
  for (let i = 0; i < table.length; i++)
    for (let j = 0; j < cols; j++) {
      const e = expected[i]![j]!;
      minE = Math.min(minE, e);
      const dev = Math.abs(table[i]![j]! - e);
      stat += (yates ? Math.max(0, dev - 0.5) : dev) ** 2 / e;
    }
  return chiResult(stat, (table.length - 1) * (cols - 1), expected, minE);
}

/** Pearson correlation with a t-test of zero correlation and a Fisher-z interval. */
export function correlationTest(xs: readonly number[], ys: readonly number[], confidence = 0.95): { r: number; df: number; statistic: number; p: number; ci: readonly [number, number] } {
  sample(xs, 3, 'xs');
  const r = correlation(xs, ys);
  const n = xs.length;
  const df = n - 2;
  const t = Math.abs(r) === 1 ? Infinity : (r * Math.sqrt(df)) / Math.sqrt(1 - r * r);
  const p = Math.abs(r) === 1 ? 0 : tPValue(t, df, 'two-sided');
  prob(confidence, 'confidence');
  let ci: [number, number] = [r, r];
  if (n > 3 && Math.abs(r) < 1) {
    const z = Math.atanh(r);
    const h = normalQuantile(1 - (1 - confidence) / 2) / Math.sqrt(n - 3);
    ci = [Math.tanh(z - h), Math.tanh(z + h)];
  }
  return { r, df, statistic: t, p, ci };
}

// ---------------------------------------------------------------------------------------------------------------
// Confidence intervals

export function meanInterval(xs: readonly number[], confidence = 0.95): [number, number] {
  const r = tTestOneSample(xs, 0, { confidence });
  return [r.ci[0], r.ci[1]];
}

/** Interval for the variance of a normal population. */
export function varianceInterval(xs: readonly number[], confidence = 0.95): [number, number] {
  sample(xs, 2);
  prob(confidence, 'confidence');
  const df = xs.length - 1;
  const v = variance(xs);
  const a = (1 - confidence) / 2;
  return [(df * v) / chiSquareQuantile(1 - a, df), (df * v) / chiSquareQuantile(a, df)];
}

function counts(successes: number, n: number): void {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n < 1 || successes < 0 || successes > n) throw new StatsError('need whole numbers with 0 <= successes <= n and n >= 1');
}

/** Wilson score interval for a proportion; behaves at 0 and n successes and for small n, unlike the Wald interval. */
export function wilsonInterval(successes: number, n: number, confidence = 0.95): [number, number] {
  counts(successes, n);
  prob(confidence, 'confidence');
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Clopper-Pearson "exact" interval (guaranteed coverage, so conservative). */
export function clopperPearsonInterval(successes: number, n: number, confidence = 0.95): [number, number] {
  counts(successes, n);
  prob(confidence, 'confidence');
  const a = (1 - confidence) / 2;
  const search = (target: number, f: (p: number) => number): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  // P(X >= k | p) increases with p; P(X <= k | p) decreases with p.
  const lower = successes === 0 ? 0 : search(1 - a, (p) => 1 - betaI(p, successes, n - successes + 1));
  const upper = successes === n ? 1 : search(a, (p) => betaI(1 - p, n - successes, successes + 1));
  return [lower, upper];
}

// ---------------------------------------------------------------------------------------------------------------
// Effect sizes

/** Cohen's d with the pooled standard deviation. */
export function cohensD(xs: readonly number[], ys: readonly number[]): number {
  sample(xs, 2, 'xs');
  sample(ys, 2, 'ys');
  const n1 = xs.length;
  const n2 = ys.length;
  const sp = Math.sqrt(((n1 - 1) * variance(xs) + (n2 - 1) * variance(ys)) / (n1 + n2 - 2));
  if (sp === 0) throw new StatsError('neither sample has any spread, so d is undefined');
  return (mean(xs) - mean(ys)) / sp;
}

/** Hedges' g: Cohen's d with the small-sample correction. */
export function hedgesG(xs: readonly number[], ys: readonly number[]): number {
  const df = xs.length + ys.length - 2;
  return cohensD(xs, ys) * (1 - 3 / (4 * df - 1));
}

/** Cramer's V for a table of counts, from the uncorrected chi-square. */
export function cramersV(table: readonly (readonly number[])[]): number {
  const r = chiSquareIndependence(table);
  const n = sum(table.map((row) => sum(row)));
  const k = Math.min(table.length, table[0]!.length) - 1;
  return Math.sqrt(r.statistic / (n * k));
}

// ---------------------------------------------------------------------------------------------------------------
// Sample size

/** Sample size to estimate a mean to within +/- margin, given the standard deviation (normal approximation). */
export function sampleSizeForMean(sd: number, margin: number, confidence = 0.95): number {
  if (!(sd > 0) || !(margin > 0)) throw new StatsError('sd and margin must be positive');
  prob(confidence, 'confidence');
  const z = normalQuantile(1 - (1 - confidence) / 2);
  return Math.ceil((z * sd / margin) ** 2 - 1e-9);
}

/** Sample size to estimate a proportion to within +/- margin. p defaults to 0.5, the worst case. A population size applies the finite correction. */
export function sampleSizeForProportion(margin: number, o: { readonly p?: number; readonly confidence?: number; readonly population?: number } = {}): number {
  const p = o.p ?? 0.5;
  if (!(p >= 0 && p <= 1)) throw new StatsError('p must be between 0 and 1');
  if (!(margin > 0 && margin < 1)) throw new StatsError('margin must be between 0 and 1');
  const z = normalQuantile(1 - (1 - (o.confidence ?? 0.95)) / 2);
  const n0 = (z * z * p * (1 - p)) / (margin * margin);
  if (o.population === undefined) return Math.ceil(n0 - 1e-9);
  if (!Number.isInteger(o.population) || o.population < 1) throw new StatsError('population must be a positive whole number');
  return Math.ceil(n0 / (1 + (n0 - 1) / o.population) - 1e-9);
}

/** Per-group sample size to detect a difference in means of delta with a two-sided test (normal approximation). */
export function sampleSizeForTwoMeans(delta: number, sd: number, o: { readonly alpha?: number; readonly power?: number } = {}): number {
  if (!(delta > 0) || !(sd > 0)) throw new StatsError('delta and sd must be positive');
  const alpha = o.alpha ?? 0.05;
  const power = o.power ?? 0.8;
  prob(alpha, 'alpha');
  prob(power, 'power');
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  return Math.ceil((2 * ((za + zb) * sd) ** 2) / delta ** 2 - 1e-9);
}

/** Approximate power of a two-sided two-sample comparison with n per group. */
export function powerForTwoMeans(delta: number, sd: number, nPerGroup: number, alpha = 0.05): number {
  if (!(delta > 0) || !(sd > 0) || !(nPerGroup >= 2)) throw new StatsError('delta and sd must be positive and n at least 2');
  prob(alpha, 'alpha');
  const za = normalQuantile(1 - alpha / 2);
  const shift = delta / (sd * Math.sqrt(2 / nPerGroup));
  return normalCdf(shift - za) + normalCdf(-shift - za);
}
