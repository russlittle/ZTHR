import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, load, percentile, soak } from './index.ts';

test('percentiles and thresholds', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual([percentile(s, 50), percentile(s, 95), percentile(s, 99)], [50, 95, 99]);
  const r = judge(s, 3, 10, { p95Ms: 90, maxErrorRate: 0.01, minRps: 20 });
  assert.equal(r.pass, false);
  assert.deepEqual(r.failures, ['p95 95 ms is over 90 ms', '2.91% errors is over 1.00%', '10.3 requests a second is under 20']);
  assert.equal(judge(s, 0, 1, { p99Ms: 100 }).pass, true);
});

test('load keeps the arrival rate even when the target is slow (open model)', async () => {
  let clock = 0;
  const starts: number[] = [];
  const target = () => {
    starts.push(clock);
    return new Promise<void>((r) => setTimeout(r, 1));
  };
  const r = await load(target, { rps: 10, seconds: 1, limits: { maxErrorRate: 0 }, now: () => clock, sleep: async (ms) => void (clock += ms) });
  assert.equal(r.sent, 10);
  assert.deepEqual(starts, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  let n = 0;
  const flaky = await load(() => (++n % 5 ? Promise.resolve() : Promise.reject(new Error('503'))), { rps: 20, seconds: 1, limits: { maxErrorRate: 0.1 }, now: () => clock, sleep: async (ms) => void (clock += ms) });
  assert.equal(flaky.errors, 4);
  assert.equal(flaky.pass, false);
});

test('a soak finds a steady climb that no single sample would flag, and ignores noise', () => {
  const hour = 3_600_000;
  const leak = Array.from({ length: 48 }, (_, i) => ({ at: i * hour * 0.25, value: 200 + i * 0.25 * 3 + (i % 3) }));
  const v = soak(leak, 1);
  assert.ok(v.leak && Math.abs(v.perHour - 3) < 0.5, JSON.stringify(v));
  const flat = Array.from({ length: 48 }, (_, i) => ({ at: i * hour * 0.25, value: 200 + ((i * 7) % 11) }));
  assert.equal(soak(flat, 1).leak, false);
});

test('throughput is measured over the time the run really took, so a service that cannot keep up fails minRps', async () => {
  let clock = 0;
  const slow = async () => {
    await null;
    clock += 1000;
  };
  const r = await load(slow, { rps: 10, seconds: 1, limits: { minRps: 9 }, now: () => clock, sleep: async (ms) => void (clock += ms) });
  assert.equal(r.sent, 10);
  assert.equal(r.pass, false, JSON.stringify(r));
  assert.match(r.failures[0]!, /requests a second is under 9/);
});

test('a target that throws before returning a promise counts as an error, not a crashed run', async () => {
  let clock = 0;
  const r = await load(() => { throw new Error('bad config'); }, { rps: 5, seconds: 1, limits: {}, now: () => clock, sleep: async (ms) => void (clock += ms) });
  assert.deepEqual([r.sent, r.errors], [5, 5]);
});

test('a target that never answers times out as an error instead of hanging the run', async () => {
  let n = 0;
  const hangsSometimes = () => (++n % 2 ? new Promise<void>(() => {}) : Promise.resolve());
  const guard = new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2000).unref());
  const run = load(hangsSometimes, { rps: 100, seconds: 0.04, timeoutMs: 50, limits: { maxErrorRate: 0.1 } });
  const r = await Promise.race([run, guard]);
  assert.notEqual(r, 'hung', 'the run finished');
  if (r === 'hung') return;
  assert.deepEqual([r.sent, r.ok, r.errors, r.timeouts], [4, 2, 2, 2]);
  assert.equal(r.pass, false);
  assert.match(r.failures[0]!, /50\.00% errors/);
  await assert.rejects(load(() => Promise.resolve(), { rps: 1, seconds: 1, timeoutMs: 0, limits: {} }), /time limit/);
});

test('a call that answers after its time limit is not counted twice', async () => {
  const late = () => new Promise<void>((r) => setTimeout(r, 60));
  const r = await load(late, { rps: 100, seconds: 0.01, timeoutMs: 20, limits: {} });
  await new Promise((res) => setTimeout(res, 80));
  assert.deepEqual([r.sent, r.ok, r.errors, r.timeouts], [1, 0, 1, 1]);
});
