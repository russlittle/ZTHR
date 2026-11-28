import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoff, Breaker, BreakerOpen, DEFAULT_RETRY, retry, TimedOut, withTimeout } from './index.ts';

test('a call that does not answer in time is stopped, and told to stop', async () => {
  let aborted = false;
  await assert.rejects(withTimeout(20, (s) => new Promise((r) => { s.addEventListener('abort', () => { aborted = true; }); setTimeout(r, 200); })), TimedOut);
  assert.ok(aborted);
  assert.equal(await withTimeout(200, async () => 'fast'), 'fast');
});

test('retries are bounded, spread by jitter, and never retry what cannot succeed', async () => {
  const waits: number[] = [];
  let n = 0;
  const ok = await retry(async () => { if (++n < 3) throw new Error('flaky'); return 'done'; }, { ...DEFAULT_RETRY, attempts: 5 }, async (ms) => { waits.push(ms); }, () => 0.5);
  assert.equal(ok, 'done');
  assert.deepEqual(waits, [100, 200], 'half of 200, then half of 400');
  n = 0;
  await assert.rejects(retry(async () => { n++; throw new Error('down'); }, { ...DEFAULT_RETRY, attempts: 3 }, async () => {}, () => 0), /down/);
  assert.equal(n, 3, 'exactly the attempts allowed');
  n = 0;
  await assert.rejects(retry(async () => { n++; throw new TypeError('bad input'); }, { ...DEFAULT_RETRY, attempts: 4, retryable: (e) => !(e instanceof TypeError) }, async () => {}, () => 0), TypeError);
  assert.equal(n, 1, 'a caller error is not retried');
  assert.equal(backoff(10, DEFAULT_RETRY, () => 0.999), 4995, 'the step is capped');
  await assert.rejects(retry(async () => 1, { ...DEFAULT_RETRY, attempts: 0 }), RangeError);
});

test('the breaker opens after repeated failures, fails fast, and lets one trial through after the cool-down', async () => {
  let t = 0;
  const b = new Breaker(2, 1000, () => t);
  const fail = () => b.call(async () => { throw new Error('down'); });
  await assert.rejects(fail(), /down/);
  assert.equal(b.state, 'closed');
  await assert.rejects(fail(), /down/);
  assert.equal(b.state, 'open');
  let called = false;
  await assert.rejects(b.call(async () => { called = true; }), BreakerOpen);
  assert.equal(called, false, 'nothing is called while open');
  t = 1000;
  assert.equal(b.state, 'half-open');
  await assert.rejects(fail(), /down/);
  assert.equal(b.state, 'open', 'a failed trial opens it again');
  t = 2000;
  assert.equal(await b.call(async () => 'back'), 'back');
  assert.equal(b.state, 'closed', 'a good trial closes it');
  assert.throws(() => new Breaker(0, 1), RangeError);
});

test('only one trial goes through while half-open', async () => {
  let t = 0;
  const b = new Breaker(1, 10, () => t);
  await assert.rejects(b.call(async () => { throw new Error('x'); }));
  t = 10;
  let release!: () => void;
  const first = b.call(() => new Promise<string>((r) => { release = () => r('ok'); }));
  await assert.rejects(b.call(async () => 'second'), BreakerOpen);
  release();
  assert.equal(await first, 'ok');
});
