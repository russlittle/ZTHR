import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Failures, Limited, Limiter } from './index.ts';

test('a bucket allows a burst, then refills at its rate, and says how long to wait', () => {
  let t = 0;
  const l = new Limiter({ burst: 3, perSecond: 1 }, { now: () => t });
  l.take('a');
  l.take('a');
  l.take('a');
  assert.throws(() => l.take('a'), (e: Limited) => e instanceof Limited && e.retryAfterMs === 1000);
  l.take('b');
  t += 1000;
  l.take('a');
  assert.throws(() => l.take('a'), Limited);
  t += 10_000;
  assert.equal(l.left('a'), 3, 'never more than the burst');
});

test('a costly request takes more tokens', () => {
  let t = 0;
  const l = new Limiter({ burst: 10, perSecond: 2 }, { now: () => t });
  l.take('a', 8);
  assert.throws(() => l.take('a', 5), (e: Limited) => e.retryAfterMs === 1500);
  t += 1500;
  l.take('a', 5);
});

test('full buckets are pruned, and behave as if never seen', () => {
  let t = 0;
  const l = new Limiter({ burst: 2, perSecond: 1 }, { now: () => t });
  l.take('a', 2);
  t += 5000;
  l.prune();
  assert.equal(l.left('a'), 2);
  assert.throws(() => new Limiter({ burst: 0, perSecond: 1 }), RangeError);
});

test('failures slow a key down only after the limit, and a success clears them', () => {
  let t = 0;
  const f = new Failures(3, 60_000, { now: () => t });
  f.check('ip');
  f.fail('ip');
  f.fail('ip');
  f.check('ip');
  f.fail('ip');
  assert.throws(() => f.check('ip'), (e: Limited) => e.retryAfterMs === 60_000);
  t += 30_000;
  assert.throws(() => f.check('ip'), (e: Limited) => e.retryAfterMs === 30_000);
  t += 30_001;
  f.check('ip');
  f.fail('ip');
  f.succeed('ip');
  f.fail('ip');
  f.fail('ip');
  f.check('ip');
});
