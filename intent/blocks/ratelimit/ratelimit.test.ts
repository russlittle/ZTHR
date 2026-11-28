import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Failures, Limited, Limiter, SignInFailures } from './index.ts';

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

test('sign-in failures: a success clears only that address and login, never the address’s guesses at others', () => {
  let t = 0;
  const s = new SignInFailures({ perLogin: 3, perAddress: 7, windowMs: 60_000 }, { now: () => t });
  s.fail('ip', 'ben');
  s.fail('ip', 'ben');
  s.succeed('ip', 'ana');
  s.fail('ip', 'ben');
  assert.throws(() => s.check('ip', 'ben'), Limited, 'signing in as ana bought no more guesses at ben');
  s.check('ip', 'ana');
  s.check('other', 'ben');
  s.fail('ip', 'ana');
  s.fail('ip', 'ana');
  s.succeed('ip', 'ana');
  s.check('ip', 'ana');
  s.fail('ip', 'cy');
  s.fail('ip', 'dee');
  assert.throws(() => s.check('ip', 'eve'), Limited, 'guesses spread over many logins still count against the address');
  t += 60_001;
  s.check('ip', 'ben');
});

const sizeOf = (x: unknown, field: 'state' | 'seen'): number => ((x as Record<string, Map<string, unknown>>)[field] as Map<string, unknown>).size;

test('a refusal says in words how long to wait, rounded up to whole seconds, and names what was limited', () => {
  assert.equal(new Limited(1500, 'slow down').message, 'slow down: wait 2 s');
  assert.equal(new Limited(1000, 'x').message, 'x: wait 1 s');
  assert.equal(new Limited(60_000, 'x').message, 'x: wait 60 s');
  assert.equal(new Limited(1, 'x').message, 'x: wait 1 s');
  assert.equal(new Limited(2500, 'x').retryAfterMs, 2500);
});

test('refusals carry a default reason, or the one the caller gave', () => {
  const t = 0;
  const l = new Limiter({ burst: 1, perSecond: 1 }, { now: () => t });
  l.take('a');
  assert.throws(() => l.take('a'), (e: Limited) => e.message === 'too many requests: wait 1 s');
  const named = new Limiter({ burst: 1, perSecond: 1 }, { now: () => t, what: 'uploads' });
  named.take('a');
  assert.throws(() => named.take('a'), (e: Limited) => e.message === 'uploads: wait 1 s');

  const f = new Failures(1, 60_000, { now: () => t });
  f.fail('k');
  assert.throws(() => f.check('k'), (e: Limited) => e.message === 'too many failed attempts: wait 60 s');
  const fn = new Failures(1, 60_000, { now: () => t, what: 'bad codes' });
  fn.fail('k');
  assert.throws(() => fn.check('k'), (e: Limited) => e.message === 'bad codes: wait 60 s');

  const s = new SignInFailures({ perLogin: 1, perAddress: 5, windowMs: 60_000 }, { now: () => t });
  s.fail('ip', 'ana');
  assert.throws(() => s.check('ip', 'ana'), (e: Limited) => e.message === 'too many failed sign-ins: wait 60 s');
  const sn = new SignInFailures({ perLogin: 1, perAddress: 5, windowMs: 60_000 }, { now: () => t, what: 'locked out' });
  sn.fail('ip', 'ana');
  assert.throws(() => sn.check('ip', 'ana'), (e: Limited) => e.message === 'locked out: wait 60 s');
});

test('a bucket needs a burst of at least 1 and a rate above zero', () => {
  const msg = /a bucket needs a burst of at least 1 and a positive rate/;
  assert.throws(() => new Limiter({ burst: 0, perSecond: 1 }), msg);
  assert.throws(() => new Limiter({ burst: 0.5, perSecond: 1 }), msg);
  assert.throws(() => new Limiter({ burst: 1, perSecond: 0 }), msg);
  assert.throws(() => new Limiter({ burst: 1, perSecond: -1 }), msg);
  const t = 0;
  const one = new Limiter({ burst: 1, perSecond: 0.5 }, { now: () => t });
  one.take('a');
  assert.throws(() => one.take('a'), (e: Limited) => e.retryAfterMs === 2000);
});

test('prune drops exactly the buckets that have refilled to full, and keeps the others', () => {
  let t = 0;
  const l = new Limiter({ burst: 2, perSecond: 1 }, { now: () => t });
  l.take('exactly-full');
  t = 500;
  l.take('part-way');
  t = 1000;
  assert.equal(sizeOf(l, 'state'), 2);
  l.prune();
  assert.equal(sizeOf(l, 'state'), 1, 'one refilled exactly to its burst and was dropped; the other is still short');
  assert.equal(l.left('part-way'), 1);
  t = 1500;
  l.take('another', 2);
  t = 10_000;
  l.prune();
  assert.equal(sizeOf(l, 'state'), 0);
});

test('a limiter holding many keys forgets the idle ones, so memory stays bounded', () => {
  let t = 0;
  const l = new Limiter({ burst: 2, perSecond: 1 }, { now: () => t });
  for (let i = 0; i < 50_000; i++) {
    l.take(`k${i}`);
    t += 10_000;
  }
  assert.equal(sizeOf(l, 'state'), 50_000, 'up to 50 000 keys are kept as they are');
  l.take('one-more');
  assert.equal(sizeOf(l, 'state'), 1, 'past that, every key that has refilled is dropped, leaving the one in use');
  assert.equal(l.left('k0'), 2);
  assert.equal(l.left('one-more'), 1);
});

test('a failure counts for exactly the window, measured forward from when it happened', () => {
  let t = 40_000;
  const f = new Failures(1, 60_000, { now: () => t });
  f.fail('ip');
  t = 50_000;
  assert.throws(() => f.check('ip'), (e: Limited) => e.retryAfterMs === 50_000, 'wait for the rest of the window, from the oldest failure');
  t = 99_999;
  assert.throws(() => f.check('ip'), (e: Limited) => e.retryAfterMs === 1);
  t = 100_000;
  f.check('ip');
});

test('a failure counts again as the same key is checked before the limit; two keys do not share failures', () => {
  let t = 0;
  const f = new Failures(2, 60_000, { now: () => t });
  f.fail('a');
  t = 10_000;
  f.fail('a');
  f.check('b');
  assert.throws(() => f.check('a'), (e: Limited) => e.retryAfterMs === 50_000);
  t = 60_000;
  f.check('a');
});

test('a failure log holding many keys forgets the ones whose failures have all aged out', () => {
  let t = 0;
  const f = new Failures(3, 1000, { now: () => t });
  for (let i = 0; i < 50_000; i++) {
    f.fail(`k${i}`);
    t += 2000;
  }
  assert.equal(sizeOf(f, 'seen'), 50_000);
  f.fail('one-more');
  assert.equal(sizeOf(f, 'seen'), 1, 'only the key with a failure still in the window is kept');
  f.fail('one-more');
  f.fail('one-more');
  assert.throws(() => f.check('one-more'), Limited);
});
