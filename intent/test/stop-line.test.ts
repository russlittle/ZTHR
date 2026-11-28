/**
 * Stop the line. Planted: the branch's previous commit is red on a check the line stops on, and a push that is not
 * the fix must fail; the push that names the red check in a Fixes-red trailer goes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Get } from '../src/governance/liverules.ts';
import { decide, redChecks, unfixed, type Run } from '../src/governance/stopline.ts';
import { main } from '../tools/stop-line.ts';

const EXPECT = new URL('fixtures/live-rules/expected.json', import.meta.url).pathname;
const PREV = 'a'.repeat(40);
const run = (name: string, conclusion: string | null, at = '2026-11-14T10:00:00Z', status = 'completed'): Run => ({ name, conclusion, at, status });

test('planted: the previous commit is red on a required check, and new work is refused', () => {
  const v = decide(PREV, ['Intent', 'Files', 'Supply chain'], [run('Intent', 'success'), run('Files', 'failure'), run('Supply chain', 'success')], ['Add the bus page']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.unfixed, ['Files']);
  assert.match(v.say, /the line is stopped: a{12} is red on Files.*"Fixes-red: Files"/);
});

test('the push that fixes it says so, and goes; naming another check does not count', () => {
  const runs = [run('Intent', 'failure'), run('Supply chain', 'timed_out')];
  assert.equal(decide(PREV, ['Intent', 'Supply chain'], runs, ['Fix the walk\n\nFixes-red: Intent\nFixes-red: Supply chain']).ok, true);
  assert.deepEqual(unfixed(['Intent', 'Supply chain'], ['Fix the walk\n\nFixes-red: Intent']), ['Supply chain'], 'every red check is named');
  assert.deepEqual(unfixed(['Intent'], ['We should fix red Intent soon', 'Fixes-red: Intentional']), ['Intent'], 'a passing mention is not a trailer');
});

test('only a finished failure is red: cancelled, skipped, pending and older runs are not', () => {
  assert.deepEqual(redChecks(['Intent'], [run('Intent', 'cancelled')]), []);
  assert.deepEqual(redChecks(['Intent'], [run('Intent', null, '2026-11-14T10:00:00Z', 'in_progress')]), []);
  assert.deepEqual(redChecks(['Intent'], [run('Intent', 'failure', '2026-11-14T09:00:00Z'), run('Intent', 'success', '2026-11-14T10:00:00Z')]), [], 'a re-run that passed clears it');
  assert.deepEqual(redChecks(['Intent'], [run('Intent', 'success', '2026-11-14T09:00:00Z'), run('Intent', 'failure', '2026-11-14T10:00:00Z')]), ['Intent']);
  assert.deepEqual(redChecks(['Intent'], [run('intent', 'startup_failure')]), ['Intent'], 'a workflow that could not start is red');
  assert.deepEqual(redChecks(['Files'], [run('Intent', 'failure')]), [], 'a check the line does not stop on does not stop it');
  assert.equal(decide(null, ['Intent'], [run('Intent', 'failure')], []).ok, true, 'a new branch has no previous commit');
});

/** GitHub's answers for the previous commit's runs: workflow runs by workflow name, check runs by job name. */
const github = (workflows: { name: string; conclusion: string | null }[], status = 200): Get => async (path) => {
  if (status !== 200) return { status, body: {} };
  if (path.includes('/actions/runs')) return { status: 200, body: { workflow_runs: workflows.map((w) => ({ ...w, status: 'completed', updated_at: '2026-11-14T10:00:00Z' })) } };
  return { status: 200, body: { check_runs: [{ name: 'verify', status: 'completed', conclusion: 'failure', completed_at: '2026-11-14T10:00:00Z', started_at: '2026-11-14T09:58:00Z' }] } };
};

test('the command stops a push on main after a red Intent, and lets the fix through', async () => {
  const quiet = console.log;
  console.log = () => {};
  try {
    const args = ['--repo', 'russlittle/zthr', '--branch', 'main', '--before', PREV, '--after', 'b'.repeat(40), '--expect', EXPECT];
    const red = github([{ name: 'Intent', conclusion: 'failure' }, { name: 'Files', conclusion: 'success' }]);
    assert.equal(await main(args, red, () => ['Add more work']), 1);
    assert.equal(await main(args, red, () => ['Repair the failing test\n\nFixes-red: Intent']), 0);
    assert.equal(await main(args, github([{ name: 'Intent', conclusion: 'success' }])), 0, 'a green previous commit lets work through');
    assert.equal(await main(args, github([], 403)), 1, 'runs that cannot be read are not green');
    assert.equal(await main([...args.slice(0, 5), '0'.repeat(40), ...args.slice(6)], red), 0, 'the first push of a branch');
    const surface = ['--repo', 'russlittle/zthr', '--branch', 'intent-surface', '--before', PREV, '--after', 'b'.repeat(40), '--expect', EXPECT];
    assert.equal(await main(surface, github([{ name: 'Supply chain', conclusion: 'failure' }]), () => ['More']), 1, 'intent-surface stops on Supply chain');
  } finally {
    console.log = quiet;
  }
});
