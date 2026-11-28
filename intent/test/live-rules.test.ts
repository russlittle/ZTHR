/**
 * The live rules check: what GitHub enforces on main and intent-surface, against the committed expectation. Planted:
 * a required check missing from the live ruleset, an unprotected branch, and an API that will not answer.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { check, compare, normalize, type BranchInfo, type Expectation, type Get, type Rule } from '../src/governance/liverules.ts';
import { main } from '../tools/live-rules.ts';

const fx = <T>(n: string): T => JSON.parse(readFileSync(new URL(`fixtures/live-rules/${n}`, import.meta.url), 'utf8')) as T;
const proposal = <T>(n: string): T => JSON.parse(readFileSync(new URL(`../../control/proposals/live-rules/${n}`, import.meta.url), 'utf8')) as T;
const expected = fx<Expectation>('expected.json');

/** A GitHub that answers from fixtures: path to file, or a status. */
const fake = (answers: Record<string, string | number>): Get => async (path) => {
  const a = answers[path];
  if (a === undefined || typeof a === 'number') return { status: typeof a === 'number' ? a : 404, body: { message: 'Not Found' } };
  return { status: 200, body: fx(a) };
};
const protectedRepo = {
  '/repos/russlittle/zthr/branches/main': 'branch-main.json',
  '/repos/russlittle/zthr/rules/branches/main': 'rules-main.json',
  '/repos/russlittle/zthr/branches/intent-surface': 'branch-unprotected.json',
  '/repos/russlittle/zthr/rules/branches/intent-surface': 'rules-intent-surface.json',
};

test('the rules applied as proposed match the expectation exactly', async () => {
  const r = await check(expected, fake(protectedRepo));
  assert.deepEqual(r.differences, []);
  assert.ok(r.ok);
  assert.deepEqual(r.live['main']!.required_checks, ['Files (app 15368)', 'Intent (app 15368)', 'Supply chain (app 15368)']);
});

test('the proposed rulesets, applied, would give exactly the expected rules', () => {
  const main = proposal<{ rules: Rule[] }>('ruleset-main.json');
  const surface = proposal<{ rules: Rule[] }>('ruleset-intent-surface.json');
  assert.deepEqual(proposal<Expectation>('expected.json'), expected, 'the test fixture is the proposal');
  assert.deepEqual(compare('main', expected.branches['main']!, normalize({}, main.rules)), []);
  assert.deepEqual(compare('intent-surface', expected.branches['intent-surface']!, normalize({}, surface.rules)), []);
});

test('planted: a required check missing from the live ruleset is a difference', async () => {
  const r = await check(expected, fake({ ...protectedRepo, '/repos/russlittle/zthr/rules/branches/main': 'rules-main-missing-check.json' }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.differences, ['main: required check "Supply chain (app 15368)" is missing']);
});

test('planted: a check required by name but not pinned to GitHub Actions is a difference', () => {
  const rules = fx<Rule[]>('rules-main.json').map((x) => (x.type === 'required_status_checks' ? { ...x, parameters: { required_status_checks: [{ context: 'Intent' }, { context: 'Files', integration_id: 15368 }, { context: 'Supply chain', integration_id: 15368 }] } } : x));
  const d = compare('main', expected.branches['main']!, normalize({}, rules));
  assert.deepEqual(d, ['main: required check "Intent (app 15368)" is missing', 'main: required check "Intent" is enforced but not in the expectation'], 'any app could post a status named Intent');
});

test('planted: today’s repository, with no protection at all, differs on every rule', async () => {
  const unprotected: Get = async (path) => ({ status: 200, body: path.includes('/rules/') ? [] : fx('branch-unprotected.json') });
  const r = await check(expected, unprotected);
  assert.equal(r.ok, false);
  const d = r.differences.filter((x) => x.startsWith('main:'));
  assert.equal(d.length, 6, d.join('\n'));
  assert.ok(d.includes('main: requiring a pull request is expected but not enforced'));
  assert.ok(d.includes('main: blocking force-pushes is expected but not enforced'));
  assert.ok(d.includes('main: required check "Intent (app 15368)" is missing'));
  const unread = await check(expected, fake({}));
  assert.match(unread.differences.join('\n'), /main: could not read the live rules \(branch 404, rules 404\)/, 'an unreadable answer is not a pass');
});

test('a rule enforced live but not expected is a difference too: the expectation is the whole truth', () => {
  const live = normalize(fx<BranchInfo>('branch-main.json'), [...fx<Rule[]>('rules-intent-surface.json'), { type: 'pull_request' }]);
  assert.deepEqual(compare('intent-surface', expected.branches['intent-surface']!, live), ['intent-surface: requiring a pull request is enforced but not in the expectation']);
});

test('classic branch protection’s required checks are read as well as rulesets', () => {
  const b: BranchInfo = { protection: { enabled: true, required_status_checks: { contexts: ['Intent'], checks: [{ context: 'Intent', app_id: 15368 }] } } };
  assert.deepEqual(normalize(b, []).required_checks, ['Intent (app 15368)']);
});

test('the command exits 1 on a difference and 0 when they match', async () => {
  const quiet = console.log;
  console.log = () => {};
  try {
    const file = new URL('fixtures/live-rules/expected.json', import.meta.url).pathname;
    assert.equal(await main(['--expect', file], fake(protectedRepo)), 0);
    assert.equal(await main(['--expect', file], fake({ ...protectedRepo, '/repos/russlittle/zthr/rules/branches/main': 'rules-main-missing-check.json' })), 1);
    assert.equal(await main(['--expect', file], fake({})), 1, 'no answer from GitHub is a failure');
  } finally {
    console.log = quiet;
  }
});
