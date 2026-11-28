import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RunningStats, StatsError, chiSquareCdf, chiSquareGof, chiSquareIndependence, chiSquareQuantile, clopperPearsonInterval, cohensD, correlation, correlationTest, cramersV,
  describe, hedgesG, kurtosis, logGamma, mean, meanInterval, median, medianAbsoluteDeviation, modes, normalCdf, normalQuantile, outliers, powerForTwoMeans, quantile,
  sampleSizeForMean, sampleSizeForProportion, sampleSizeForTwoMeans, skewness, stdev, sum, tCdf, tQuantile, tTestOneSample, tTestPaired, tTestTwoSample, variance,
  varianceInterval, wilsonInterval, betaI, gammaP,
} from './index.ts';

const near = (a: number, b: number, tol = 1e-6, msg?: string): void => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} is not within ${tol} of ${b}`);
const A = [27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4];
const B = [27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4];
const ONE_TO_TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('mean, variance and standard deviation on the textbook example', () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.equal(mean(xs), 5);
  assert.equal(variance(xs, 0), 4);
  assert.equal(stdev(xs, 0), 2);
  near(variance(xs), 32 / 7, 1e-12);
  near(variance(A), 7.867428571428571, 1e-12);
  near(mean(A), 20.82, 1e-12);
});

test('compensated sum survives values that cancel; variance survives a large offset', () => {
  assert.equal(sum([1e16, 1, -1e16]), 1);
  assert.equal(sum([]), 0);
  near(variance([1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16]), 30, 1e-6);
});

test('median handles odd, even, single and unsorted input without changing the input', () => {
  const xs = [9, 1, 5];
  assert.equal(median(xs), 5);
  assert.deepEqual(xs, [9, 1, 5]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median(A), 21);
});

test('quantiles agree with NumPy for each Hyndman and Fan definition', () => {
  const want: Record<number, [number, number]> = { 1: [3, 9], 4: [3, 9], 5: [3.5, 9.5], 6: [3.3, 9.9], 7: [3.7, 9.1], 8: [3.4333333333333336, 9.633333333333333], 9: [3.45, 9.6] };
  for (const [t, [p30, p90]] of Object.entries(want)) {
    near(quantile(ONE_TO_TEN, 0.3, Number(t) as 1), p30, 1e-9, `type ${t} p=.3`);
    near(quantile(ONE_TO_TEN, 0.9, Number(t) as 1), p90, 1e-9, `type ${t} p=.9`);
  }
  near(quantile(A, 0.1), 17.36, 1e-9);
  near(quantile(A, 0.9), 23.4, 1e-9);
  assert.equal(quantile(ONE_TO_TEN, 0, 7), 1);
  assert.equal(quantile(ONE_TO_TEN, 1, 7), 10);
  assert.equal(quantile(ONE_TO_TEN, 1, 6), 10);
});

test('mode, median absolute deviation, outliers by the Tukey fences', () => {
  assert.deepEqual(modes([3, 1, 3, 2, 1]), [1, 3]);
  assert.deepEqual(modes([-0, 0, 5]), [0]);
  assert.equal(medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9]), 1);
  assert.deepEqual(outliers([10, 11, 12, 11, 10, 12, 11, 90]), [90]);
  assert.deepEqual(outliers([1, 2, 3, 4, 5]), []);
});

test('skewness and kurtosis match SciPy (bias corrected)', () => {
  near(skewness(A), 0.6874857080551465, 1e-10);
  near(kurtosis(A), 0.9110709628676168, 1e-10);
  assert.ok(Number.isNaN(skewness([2, 2, 2])), 'no spread, no skew');
  assert.throws(() => skewness([1, 2]), StatsError);
  assert.throws(() => kurtosis([1, 2, 3]), /at least 4/);
});

test('describe gives the five-number summary and spread', () => {
  const d = describe(ONE_TO_TEN);
  assert.deepEqual([d.n, d.min, d.q1, d.median, d.q3, d.max, d.iqr], [10, 1, 3.25, 5.5, 7.75, 10, 4.5]);
  near(d.stdev, 3.0276503540974917, 1e-12);
  near(d.sem, 3.0276503540974917 / Math.sqrt(10), 1e-12);
  const one = describe([5]);
  assert.ok(Number.isNaN(one.variance) && one.mean === 5);
});

test('running statistics match the batch result, and merging two halves matches the whole', () => {
  const r = new RunningStats();
  A.forEach((x) => r.push(x));
  near(r.mean, mean(A), 1e-12);
  near(r.variance, variance(A), 1e-12);
  assert.deepEqual([r.min, r.max, r.n], [16.9, 27.5, 15]);
  const a = new RunningStats();
  const b = new RunningStats();
  A.slice(0, 6).forEach((x) => a.push(x));
  A.slice(6).forEach((x) => b.push(x));
  const m = a.merge(b);
  near(m.mean, mean(A), 1e-12);
  near(m.variance, variance(A), 1e-12);
  assert.equal(new RunningStats().merge(new RunningStats()).n, 0);
  assert.ok(Number.isNaN(new RunningStats().mean));
  assert.throws(() => r.push(NaN), StatsError);
});

test('the normal distribution: known values and a round trip', () => {
  near(normalCdf(0), 0.5, 1e-15);
  near(normalCdf(-1.2), 0.11506967022170822, 1e-12);
  near(normalCdf(1.96), 0.9750021048517795, 1e-12);
  assert.equal(normalCdf(Infinity), 1);
  assert.equal(normalCdf(-Infinity), 0);
  near(normalQuantile(0.975), 1.959963984540054, 1e-9);
  near(normalQuantile(1e-10), -6.361340902404056, 1e-7);
  near(normalQuantile(0.5), 0, 1e-12);
  for (const p of [0.001, 0.02, 0.3, 0.77, 0.999]) near(normalCdf(normalQuantile(p)), p, 1e-12);
  assert.throws(() => normalQuantile(0), StatsError);
  assert.throws(() => normalQuantile(1), StatsError);
  assert.throws(() => normalCdf(NaN), StatsError);
});

test('Student t and chi-square distributions against SciPy', () => {
  near(tQuantile(0.975, 10), 2.228138851986274, 1e-9);
  near(tQuantile(0.995, 3), 5.840909309733355, 1e-8);
  near(tQuantile(0.025, 10), -2.228138851986274, 1e-9);
  near(tCdf(1.5, 7), 0.911350756505015, 1e-12);
  near(tCdf(-0.3, 1.5), 0.40023609840179253, 1e-12);
  near(2 * tCdf(-2.5, 2), 0.12961172022151082, 1e-12);
  near(tCdf(0, 4), 0.5, 1e-15);
  near(chiSquareQuantile(0.95, 5), 11.070497693516351, 1e-8);
  near(chiSquareQuantile(0.95, 1), 3.841458820694124, 1e-8);
  near(1 - chiSquareCdf(7, 3), 0.07189777249646509, 1e-12);
  near(chiSquareCdf(0.5, 1), 0.5204998778130466, 1e-12);
  assert.equal(chiSquareCdf(-1, 3), 0);
  near(betaI(0.3, 2, 5), 0.579825, 1e-9);
  near(gammaP(2, 3), 1 - 4 * Math.exp(-3), 1e-12);
  near(logGamma(5), Math.log(24), 1e-12);
  near(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12);
});

test('t-tests: Welch, pooled, one-sample, paired and one-sided agree with SciPy', () => {
  const w = tTestTwoSample(A, B);
  near(w.statistic, -2.455356398286006, 1e-9);
  near(w.df, 24.988529290231416, 1e-6);
  near(w.p, 0.021378001462866992, 1e-8);
  const p = tTestTwoSample(A, B, { equalVariance: true });
  near(p.statistic, -2.455356398286006, 1e-9);
  assert.equal(p.df, 28);
  near(p.p, 0.020544522734125926, 1e-8);
  const o = tTestOneSample(A, 20);
  near(o.statistic, 1.132251950739545, 1e-9);
  near(o.p, 0.2765491746502415, 1e-8);
  assert.equal(o.df, 14);
  near(o.ci[0], 19.26670165245124, 1e-8);
  near(o.ci[1], 22.373298347548754, 1e-8);
  const r = tTestPaired(A, B);
  near(r.statistic, -2.685714574824638, 1e-9);
  near(r.p, 0.017746021669480767, 1e-8);
  const less = tTestOneSample(A, 20, { alternative: 'less' });
  near(less.p, 1 - 0.2765491746502415 / 2, 1e-8);
  const greater = tTestOneSample(A, 20, { alternative: 'greater' });
  near(greater.p, 0.2765491746502415 / 2, 1e-8);
  assert.equal(greater.ci[1], Infinity);
  assert.equal(less.ci[0], -Infinity);
});

test('t-tests refuse input they cannot answer honestly', () => {
  assert.throws(() => tTestOneSample([5], 0), /at least 2/);
  assert.throws(() => tTestOneSample([4, 4, 4], 4), /no spread/);
  assert.throws(() => tTestTwoSample([1, 1], [1, 1]), /any spread/);
  assert.throws(() => tTestPaired([1, 2, 3], [1, 2]), /same length/);
  assert.throws(() => tTestOneSample([1, 2, NaN], 0), /xs\[2\]|sample\[2\]/);
  assert.throws(() => mean([1, Infinity]), StatsError);
  assert.throws(() => mean([]), /at least 1/);
  assert.throws(() => mean('abc' as unknown as number[]), /array/);
  assert.throws(() => mean([1, '2' as unknown as number]), /not a finite number/);
});

test('chi-square goodness of fit: uniform, given proportions, given counts', () => {
  const r = chiSquareGof([18, 22, 20, 40]);
  near(r.statistic, 12.32, 1e-12);
  assert.equal(r.df, 3);
  near(r.p, 0.006363629995195269, 1e-9);
  assert.equal(r.warning, undefined);
  const q = chiSquareGof([18, 22, 20, 40], [0.25, 0.25, 0.25, 0.25]);
  near(q.statistic, 12.32, 1e-12);
  const c = chiSquareGof([18, 22, 20, 40], [1, 1, 1, 1]);
  near(c.statistic, 12.32, 1e-12);
  assert.ok(chiSquareGof([3, 1, 2]).warning?.includes('below 5'));
  assert.throws(() => chiSquareGof([1, -2]), /negative/);
  assert.throws(() => chiSquareGof([5, 5], [1, 0]), /positive/);
  assert.throws(() => chiSquareGof([5, 5, 5], [1, 2]), /same length/);
  assert.throws(() => chiSquareGof([0, 0]), /no observations/);
});

test('chi-square independence: 2x2 with and without Yates, and a 2x3 table', () => {
  const t = [[12, 5], [7, 16]];
  const raw = chiSquareIndependence(t);
  near(raw.statistic, 6.319891801114041, 1e-9);
  near(raw.p, 0.011939091377912247, 1e-9);
  assert.equal(raw.df, 1);
  const y = chiSquareIndependence(t, { yates: true });
  near(y.statistic, 4.812286470652336, 1e-9);
  near(y.p, 0.02825752852636125, 1e-9);
  const big = chiSquareIndependence([[10, 20, 30], [20, 15, 5]]);
  near(big.statistic, 18.650793650793652, 1e-9);
  near(big.p, 8.913158246593224e-05, 1e-10);
  assert.equal(big.df, 2);
  assert.throws(() => chiSquareIndependence([[1, 2]]), /2 rows/);
  assert.throws(() => chiSquareIndependence([[1, 2], [3]]), StatsError);
  assert.throws(() => chiSquareIndependence([[0, 0], [3, 4]]), /no observations/);
});

test('correlation and its test', () => {
  near(correlation(A, B), 0.17507457660801365, 1e-12);
  const r = correlationTest(A, B);
  near(r.p, 0.5325707930930029, 1e-8);
  assert.equal(r.df, 13);
  assert.ok(r.ci[0] < r.r && r.r < r.ci[1]);
  assert.equal(correlation([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(correlation([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(correlationTest([1, 2, 3, 4], [2, 4, 6, 8]).p, 0);
  assert.throws(() => correlation([1, 1, 1], [1, 2, 3]), /constant/);
  assert.throws(() => correlation([1, 2], [1, 2, 3]), /same length/);
});

test('confidence intervals for a mean and a variance', () => {
  const [lo, hi] = meanInterval(A);
  near(lo, 19.26670165245124, 1e-8);
  near(hi, 22.373298347548754, 1e-8);
  const [vl, vh] = varianceInterval(A);
  near(vl, (14 * 7.867428571428571) / 26.11894804503737, 1e-7);
  near(vh, (14 * 7.867428571428571) / 5.628726103039734, 1e-7);
  const [l99, h99] = meanInterval(A, 0.99);
  assert.ok(l99 < lo && h99 > hi, 'more confidence, wider interval');
  assert.throws(() => meanInterval(A, 1), StatsError);
});

test('proportion intervals: Wilson and Clopper-Pearson, including the edges', () => {
  const [wl, wh] = wilsonInterval(81, 263);
  near(wl, 0.2552885198782742, 1e-9);
  near(wh, 0.36620957698280004, 1e-9);
  const [cl, ch] = clopperPearsonInterval(81, 263);
  near(cl, 0.2527367455852712, 1e-9);
  near(ch, 0.3676219226013514, 1e-9);
  const zero = wilsonInterval(0, 20);
  near(zero[0], 0, 1e-15);
  assert.ok(zero[1] > 0.1 && zero[1] < 0.2);
  assert.equal(clopperPearsonInterval(0, 10)[0], 0);
  near(clopperPearsonInterval(0, 10)[1], 1 - 0.025 ** (1 / 10), 1e-9);
  assert.equal(clopperPearsonInterval(10, 10)[1], 1);
  assert.throws(() => wilsonInterval(11, 10), StatsError);
  assert.throws(() => wilsonInterval(1.5, 10), StatsError);
  assert.throws(() => wilsonInterval(0, 0), StatsError);
});

test('effect sizes: Cohen d, Hedges g, Cramer V', () => {
  const d = cohensD(A, B);
  const sp = Math.sqrt((14 * variance(A) + 14 * variance(B)) / 28);
  near(d, (mean(A) - mean(B)) / sp, 1e-12);
  near(d, -0.8966, 1e-3);
  near(hedgesG(A, B), d * (1 - 3 / (4 * 28 - 1)), 1e-12);
  assert.ok(Math.abs(hedgesG(A, B)) < Math.abs(d));
  near(cramersV([[12, 5], [7, 16]]), Math.sqrt(6.319891801114041 / 40), 1e-9);
  assert.equal(cramersV([[10, 0], [0, 10]]), 1);
  assert.throws(() => cohensD([1, 1], [1, 1]), /any spread/);
});

test('sample size planning: classic worked answers', () => {
  assert.equal(sampleSizeForProportion(0.05), 385);
  assert.equal(sampleSizeForProportion(0.03), 1068);
  assert.equal(sampleSizeForProportion(0.05, { population: 1000 }), 278);
  assert.equal(sampleSizeForProportion(0.05, { p: 0.1 }), 139);
  assert.equal(sampleSizeForMean(15, 5), 35);
  assert.equal(sampleSizeForTwoMeans(0.5, 1), 63);
  assert.equal(sampleSizeForTwoMeans(0.5, 1, { power: 0.9 }), 85);
  near(powerForTwoMeans(0.5, 1, 63), 0.8, 0.01);
  assert.ok(powerForTwoMeans(0.5, 1, 200) > 0.99);
  assert.throws(() => sampleSizeForMean(0, 1), StatsError);
  assert.throws(() => sampleSizeForProportion(0), StatsError);
  assert.throws(() => sampleSizeForProportion(0.05, { population: 0 }), StatsError);
  assert.throws(() => sampleSizeForTwoMeans(1, 1, { alpha: 1.5 }), StatsError);
});

test('hostile inputs: sparse arrays, a huge sample, a bad quantile type and bad probabilities are refused', () => {
  assert.throws(() => mean(new Array(3)), /not a finite number/);
  assert.throws(() => quantile(A, 1.5), /between 0 and 1/);
  assert.throws(() => quantile(A, 0.5, 3 as 7), /quantile type/);
  assert.throws(() => tQuantile(0.5, 0), StatsError);
  assert.throws(() => chiSquareQuantile(1.2, 3), StatsError);
  assert.throws(() => variance([1, 2], 2 as 1), /ddof/);
  assert.throws(() => variance([1], 1), /at least 2/);
  assert.equal(variance([1], 0), 0);
});
