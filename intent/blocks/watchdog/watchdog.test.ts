import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquire, check, type CheckIn } from './index.ts';

const MIN = 60_000;
const job = { name: 'nightly', everyMin: 1440, graceMin: 30, maxMin: 60 };
const run = (id: string, start: number, end: number | null, ok = true): CheckIn[] => [{ job: 'nightly', run: id, at: start * MIN, kind: 'start' }, ...(end === null ? [] : [{ job: 'nightly', run: id, at: end * MIN, kind: 'end' as const, ok }])];

test('a healthy schedule raises nothing', () => {
  assert.deepEqual(check([job], [...run('a', 0, 20), ...run('b', 1440, 1470)], 1500 * MIN), []);
});

test('missed, overlong, failed, overlapping and never-run are each named', () => {
  assert.deepEqual(check([job], [], 0).map((f) => f.problem), ['never ran']);
  assert.deepEqual(check([job], run('a', 0, 20), 3000 * MIN).map((f) => f.problem), ['missed']);
  assert.deepEqual(check([job], run('a', 0, 90), 100 * MIN).map((f) => f.problem), ['overlong']);
  assert.deepEqual(check([job], run('a', 0, null), 70 * MIN).map((f) => f.problem), ['overlong'], 'a run that never ended is overlong once past its limit');
  assert.deepEqual(check([job], run('a', 0, 10, false), 20 * MIN).map((f) => f.problem), ['failed']);
  assert.deepEqual(check([{ ...job, maxMin: 999 }], [...run('a', 0, 50), ...run('b', 30, 60)], 70 * MIN).map((f) => f.problem), ['overlap']);
});

test('only one holder at a time, and a dead holder’s lease expires', () => {
  const a = acquire(null, 'pod-a', 0, 1000)!;
  assert.equal(acquire(a, 'pod-b', 500, 1000), null);
  assert.deepEqual(acquire(a, 'pod-a', 500, 1000), { holder: 'pod-a', until: 1500 }, 'the holder renews');
  assert.deepEqual(acquire(a, 'pod-b', 1000, 1000), { holder: 'pod-b', until: 2000 });
});
