import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BloomFilter, CountMin, HyperLogLog, SketchError, TDigest, hash64 } from './index.ts';

const within = (got: number, want: number, rel: number, what: string) => assert.ok(Math.abs(got - want) <= want * rel, `${what}: got ${got}, wanted ${want} within ${rel * 100}%`);

test('the hash is SHA-256 of the seed then the item, so it is the same everywhere', () => {
  // sha256(00000000 || "abc") = 0a834ab0 4b1628b0 b4ec20ca ..., computed independently with openssl.
  assert.deepEqual(hash64('abc'), { hi: 0x0a834ab0, lo: 0x4b1628b0 });
  assert.deepEqual(hash64('abc'), hash64(new TextEncoder().encode('abc')));
  assert.notDeepEqual(hash64('abc', 1), hash64('abc', 0));
  assert.deepEqual(hash64('abc', 5), hash64('abc', 5));
});

test('HyperLogLog: small sets are counted exactly, large ones within a few standard errors', () => {
  const h = new HyperLogLog(14);
  assert.equal(h.count(), 0);
  for (let i = 0; i < 10; i++) h.add(`user-${i}`);
  assert.equal(h.count(), 10);
  for (let i = 0; i < 10; i++) h.add(`user-${i}`);
  assert.equal(h.count(), 10, 'seeing the same ones again changes nothing');
  const big = new HyperLogLog(14);
  for (let i = 0; i < 200_000; i++) big.add(`id-${i}`);
  within(big.count(), 200_000, 3 * big.standardError, '200k distinct');
  assert.equal(big.registers, 16384);
  assert.ok(Math.abs(big.standardError - 0.0081) < 0.0001);
});

test('HyperLogLog: precision trades memory for error', () => {
  const lo = new HyperLogLog(6);
  const hi = new HyperLogLog(14);
  for (let i = 0; i < 50_000; i++) {
    lo.add(`k${i}`);
    hi.add(`k${i}`);
  }
  within(hi.count(), 50_000, 0.03, 'p=14');
  within(lo.count(), 50_000, 5 * lo.standardError, 'p=6');
  assert.ok(lo.standardError > hi.standardError * 10);
});

test('HyperLogLog: merge is the union, and merging overlapping days does not double count', () => {
  const a = new HyperLogLog(12);
  const b = new HyperLogLog(12);
  for (let i = 0; i < 30_000; i++) a.add(`u${i}`);
  for (let i = 20_000; i < 50_000; i++) b.add(`u${i}`);
  const union = new HyperLogLog(12).merge(a).merge(b);
  within(union.count(), 50_000, 3 * union.standardError, 'union of 0..30k and 20k..50k');
  const both = new HyperLogLog(12);
  for (let i = 0; i < 50_000; i++) both.add(`u${i}`);
  assert.equal(union.count(), both.count(), 'merging is exactly the sketch of the union');
  assert.throws(() => a.merge(new HyperLogLog(13)), SketchError);
  assert.throws(() => a.merge(new HyperLogLog(12, 9)), /same precision and seed/);
});

test('HyperLogLog: saved and loaded it is the same sketch; damaged copies are refused', () => {
  const h = new HyperLogLog(10, 3);
  for (let i = 0; i < 5000; i++) h.add(`x${i}`);
  const saved = h.serialize();
  assert.equal(saved.length, 10 + 1024);
  const back = HyperLogLog.load(saved);
  assert.equal(back.count(), h.count());
  assert.deepEqual(back.serialize(), saved);
  assert.throws(() => HyperLogLog.load(saved.subarray(0, 500)), /cut short/);
  assert.throws(() => HyperLogLog.load(Buffer.concat([saved, Buffer.from([0])])), /extra bytes/);
  assert.throws(() => HyperLogLog.load(Buffer.from('NOPE\u0001', 'latin1')), /not a saved HyperLogLog/);
  const badReg = Buffer.from(saved);
  badReg[100] = 200;
  assert.throws(() => HyperLogLog.load(badReg), /no hash could produce/);
  const badP = Buffer.from(saved);
  badP[5] = 30;
  assert.throws(() => HyperLogLog.load(badP), /impossible precision/);
  const badV = Buffer.from(saved);
  badV[4] = 9;
  assert.throws(() => HyperLogLog.load(badV), /version 9/);
  assert.throws(() => new HyperLogLog(3), /4 to 16/);
});

test('t-digest: quantiles of a uniform stream are close, and the tails are tight', () => {
  const d = new TDigest(100);
  const n = 100_000;
  for (let i = 0; i < n; i++) d.add(i);
  for (const q of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9]) within(d.quantile(q), q * n, 0.01, `p${q * 100}`);
  within(d.quantile(0.99), 0.99 * n, 0.002, 'p99');
  within(d.quantile(0.999), 0.999 * n, 0.0005, 'p99.9');
  assert.equal(d.quantile(0), 0);
  assert.equal(d.quantile(1), n - 1);
  assert.equal(d.min, 0);
  assert.equal(d.max, n - 1);
  assert.equal(d.count, n);
  assert.ok(d.size < 200, `${d.size} centroids for ${n} numbers`);
});

test('t-digest: a skewed, shuffled stream (latencies) keeps its tail', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  const xs = Array.from({ length: 50_000 }, () => -Math.log(1 - rnd()) * 100);
  const d = new TDigest(200);
  xs.forEach((x) => d.add(x));
  const sorted = [...xs].sort((a, b) => a - b);
  for (const q of [0.5, 0.9, 0.99, 0.999]) within(d.quantile(q), sorted[Math.floor(q * (sorted.length - 1))]!, 0.05, `exp p${q * 100}`);
});

test('t-digest: tiny and odd inputs', () => {
  const d = new TDigest();
  assert.ok(Number.isNaN(d.quantile(0.5)));
  assert.ok(Number.isNaN(d.cdf(1)));
  d.add(7);
  assert.equal(d.quantile(0.5), 7);
  d.add(7);
  d.add(7);
  assert.equal(d.quantile(0.9), 7, 'all the same value');
  const e = new TDigest();
  [5, 1, 3].forEach((x) => e.add(x));
  assert.equal(e.quantile(0), 1);
  assert.equal(e.quantile(1), 5);
  assert.equal(e.quantile(0.5), 3);
  assert.throws(() => e.add(NaN), SketchError);
  assert.throws(() => e.add(Infinity), SketchError);
  assert.throws(() => e.add(1, 0), /positive/);
  assert.throws(() => e.quantile(1.5), /0 to 1/);
  assert.throws(() => new TDigest(2), /10 to 10000/);
});

test('t-digest: weights count as repeats, and the cdf runs the other way from the quantile', () => {
  const w = new TDigest();
  w.add(1, 90);
  w.add(100, 10);
  assert.equal(w.count, 100);
  assert.equal(w.quantile(0.1), 1);
  assert.ok(w.quantile(0.5) < 15, 'the median sits with the heavy point, interpolated toward the next');
  assert.ok(w.quantile(0.99) > 50);
  const d = new TDigest(100);
  for (let i = 0; i < 10_000; i++) d.add(i);
  within(d.cdf(5000), 0.5, 0.02, 'cdf at the median');
  assert.equal(d.cdf(-1), 0);
  assert.equal(d.cdf(10_000), 1);
  assert.ok(d.cdf(100) < d.cdf(200) && d.cdf(200) < d.cdf(9000));
  for (const q of [0.1, 0.5, 0.9]) assert.ok(Math.abs(d.cdf(d.quantile(q)) - q) < 0.01, `cdf(quantile(${q}))`);
});

test('t-digest: merging shards gives nearly the digest of everything, with exact min and max', () => {
  const a = new TDigest(100);
  const b = new TDigest(100);
  for (let i = 0; i < 50_000; i++) a.add(i * 2);
  for (let i = 0; i < 50_000; i++) b.add(i * 2 + 1);
  a.merge(b);
  assert.equal(a.count, 100_000);
  assert.equal(a.min, 0);
  assert.equal(a.max, 99_999);
  within(a.quantile(0.5), 50_000, 0.01, 'merged median');
  within(a.quantile(0.99), 99_000, 0.002, 'merged p99');
  assert.equal(new TDigest().merge(new TDigest()).count, 0);
});

test('t-digest: saved and loaded it answers the same; damaged copies are refused', () => {
  const d = new TDigest(50);
  for (let i = 0; i < 20_000; i++) d.add(Math.sin(i) * 1000);
  const saved = d.serialize();
  const back = TDigest.load(saved);
  for (const q of [0, 0.01, 0.5, 0.99, 1]) assert.equal(back.quantile(q), d.quantile(q));
  assert.equal(back.count, d.count);
  assert.deepEqual(back.serialize(), saved);
  assert.throws(() => TDigest.load(saved.subarray(0, saved.length - 3)), /cut short/);
  assert.throws(() => TDigest.load(Buffer.concat([saved, Buffer.alloc(1)])), /extra bytes/);
  const nan = Buffer.from(saved);
  nan.writeDoubleBE(NaN, 33);
  assert.throws(() => TDigest.load(nan), /impossible centroid/);
  const neg = Buffer.from(saved);
  neg.writeDoubleBE(-1, 41);
  assert.throws(() => TDigest.load(neg), /impossible centroid/);
  const swapped = Buffer.from(saved);
  swapped.writeDoubleBE(1e9, 33);
  assert.throws(() => TDigest.load(swapped), /out of order/);
  const huge = Buffer.from(saved);
  huge.writeUInt32BE(4_000_000_000, 13);
  assert.throws(() => TDigest.load(huge), /more centroids/);
  const badMin = Buffer.from(saved);
  badMin.writeDoubleBE(1e9, 17);
  assert.throws(() => TDigest.load(badMin), /contradict/);
});

test('count-min: never too low, and within eps * total for nearly everything', () => {
  const cm = CountMin.forError(0.001, 0.01);
  assert.equal(cm.width, Math.ceil(Math.E / 0.001));
  assert.equal(cm.depth, 5);
  const truth = new Map<string, number>();
  for (let i = 0; i < 20_000; i++) {
    const key = `page-${Math.floor(Math.sqrt(i * 7919 % 4000))}`;
    cm.add(key);
    truth.set(key, (truth.get(key) ?? 0) + 1);
  }
  let over = 0;
  for (const [k, v] of truth) {
    const e = cm.estimate(k);
    assert.ok(e >= v, `${k}: ${e} < ${v}`);
    if (e > v + 0.001 * cm.total) over++;
  }
  assert.ok(over <= Math.ceil(truth.size * 0.01), `${over} of ${truth.size} beyond the bound`);
  assert.equal(cm.total, 20_000);
  assert.equal(cm.estimate('never-seen') <= 0.001 * cm.total + 1, true);
});

test('count-min: counts add up, exact when nothing collides, and weights are whole numbers', () => {
  const cm = new CountMin(2000, 4);
  cm.add('a', 5);
  cm.add('a');
  cm.add('b', 2);
  assert.equal(cm.estimate('a'), 6);
  assert.equal(cm.estimate('b'), 2);
  assert.equal(cm.estimate('c'), 0);
  assert.throws(() => cm.add('a', 0), /positive whole/);
  assert.throws(() => cm.add('a', 1.5), /positive whole/);
  assert.throws(() => new CountMin(0, 1), SketchError);
  assert.throws(() => new CountMin(1 << 24, 32), /larger than/);
  assert.throws(() => CountMin.forError(0, 0.5), /between 0 and 1/);
});

test('count-min: conservative update is never worse and still never low', () => {
  const plain = new CountMin(50, 3);
  const cons = new CountMin(50, 3, 0, true);
  const truth = new Map<string, number>();
  for (let i = 0; i < 3000; i++) {
    const k = `k${i % 200}`;
    plain.add(k);
    cons.add(k);
    truth.set(k, (truth.get(k) ?? 0) + 1);
  }
  let better = 0;
  for (const [k, v] of truth) {
    assert.ok(cons.estimate(k) >= v);
    assert.ok(cons.estimate(k) <= plain.estimate(k));
    if (cons.estimate(k) < plain.estimate(k)) better++;
  }
  assert.ok(better > 0, 'it did better somewhere');
});

test('count-min: merging shards adds their counts; shapes must match; saved copies round-trip', () => {
  const a = new CountMin(500, 4, 7);
  const b = new CountMin(500, 4, 7);
  a.add('x', 3);
  b.add('x', 4);
  b.add('y', 1);
  a.merge(b);
  assert.equal(a.estimate('x'), 7);
  assert.equal(a.estimate('y'), 1);
  assert.equal(a.total, 8);
  assert.throws(() => a.merge(new CountMin(500, 4, 8)), SketchError);
  assert.throws(() => a.merge(new CountMin(501, 4, 7)), SketchError);
  const saved = a.serialize();
  const back = CountMin.load(saved);
  assert.equal(back.estimate('x'), 7);
  assert.equal(back.total, 8);
  assert.deepEqual(back.serialize(), saved);
  assert.throws(() => CountMin.load(saved.subarray(0, 100)), /cut short/);
  const flag = Buffer.from(saved);
  flag[17] = 2;
  assert.throws(() => CountMin.load(flag), /unknown flag/);
  const shape = Buffer.from(saved);
  shape.writeUInt32BE(0, 5);
  assert.throws(() => CountMin.load(shape), /impossible shape/);
  const huge = Buffer.from(saved);
  huge.writeUInt32BE(1 << 24, 5);
  huge.writeUInt32BE(32, 9);
  assert.throws(() => CountMin.load(huge), /impossible shape/);
});

test('count-min: counters stop at the top instead of wrapping to zero', () => {
  const cm = new CountMin(10, 2);
  cm.add('z', 0xffff_fff0);
  cm.add('z', 100);
  assert.equal(cm.estimate('z'), 0xffff_ffff);
});

test('Bloom: nothing added is ever missed, and the false positive rate is near what was asked', () => {
  const f = BloomFilter.forCapacity(10_000, 0.01);
  for (let i = 0; i < 10_000; i++) f.add(`in-${i}`);
  for (let i = 0; i < 10_000; i++) assert.ok(f.has(`in-${i}`), `in-${i}`);
  let fp = 0;
  for (let i = 0; i < 20_000; i++) if (f.has(`out-${i}`)) fp++;
  assert.ok(fp / 20_000 < 0.02, `false positive rate ${fp / 20_000}`);
  assert.ok(fp > 0, 'a 1% filter does have false positives');
  within(f.falsePositiveRate(), 0.01, 0.4, 'reported rate');
  within(f.estimatedCount(), 10_000, 0.03, 'estimated count');
});

test('Bloom: sizing follows the textbook formulas', () => {
  const f = BloomFilter.forCapacity(1000, 0.001);
  assert.equal(f.bits, Math.ceil((-1000 * Math.log(0.001)) / Math.LN2 ** 2));
  assert.equal(f.hashes, 10);
  assert.throws(() => BloomFilter.forCapacity(0, 0.1), SketchError);
  assert.throws(() => BloomFilter.forCapacity(10, 1), /between 0 and 1/);
  assert.throws(() => new BloomFilter(4, 1), SketchError);
  assert.throws(() => new BloomFilter(100, 0), SketchError);
});

test('Bloom: an empty filter says no to everything, and bytes and strings are the same item', () => {
  const f = new BloomFilter(256, 3);
  assert.equal(f.has('anything'), false);
  assert.equal(f.bitsSet, 0);
  f.add('hello');
  assert.equal(f.has(new TextEncoder().encode('hello')), true);
  assert.equal(f.has('hellO'), false);
});

test('Bloom: merge is union; saved copies round-trip; damaged copies are refused', () => {
  const a = BloomFilter.forCapacity(500, 0.01, 4);
  const b = BloomFilter.forCapacity(500, 0.01, 4);
  a.add('only-a');
  b.add('only-b');
  a.merge(b);
  assert.ok(a.has('only-a') && a.has('only-b'));
  assert.throws(() => a.merge(BloomFilter.forCapacity(500, 0.01, 5)), SketchError);
  assert.throws(() => a.merge(BloomFilter.forCapacity(600, 0.01, 4)), /same size/);
  const saved = a.serialize();
  const back = BloomFilter.load(saved);
  assert.ok(back.has('only-a') && back.has('only-b') && !back.has('neither'));
  assert.deepEqual(back.serialize(), saved);
  assert.throws(() => BloomFilter.load(saved.subarray(0, 20)), /cut short/);
  assert.throws(() => BloomFilter.load(Buffer.concat([saved, Buffer.alloc(4)])), /extra bytes/);
  const odd = new BloomFilter(40, 2).serialize();
  const spare = Buffer.from(odd);
  spare.writeUInt32BE(0xffff_ffff, 14 + 4);
  assert.throws(() => BloomFilter.load(spare), /past its end/);
  const none = Buffer.from(saved);
  none[9] = 0;
  assert.throws(() => BloomFilter.load(none), /impossible shape/);
});

test('every sketch refuses another sketch\'s bytes', () => {
  const h = new HyperLogLog(4).serialize();
  assert.throws(() => TDigest.load(h), /not a saved t-digest/);
  assert.throws(() => CountMin.load(h), /not a saved count-min/);
  assert.throws(() => BloomFilter.load(h), /not a saved Bloom/);
  assert.throws(() => HyperLogLog.load(new Uint8Array(0)), /not a saved HyperLogLog/);
});
