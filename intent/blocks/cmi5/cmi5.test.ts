import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CMI5_CATEGORY, MOVEON_CATEGORY, Session, VERBS, launchUrl, satisfied, type Unit } from './index.ts';

const unit: Unit = { id: 'https://learn.example.org/au/sharing-101', title: 'Sharing files safely', url: 'https://learn.example.org/sharing-101/index.html', moveOn: 'CompletedAndPassed', masteryScore: 0.8 };
const actor = { objectType: 'Agent' as const, account: { homePage: 'https://files.example.org', name: 'u-42' } };

test('the launch URL carries the cmi5 parameters', () => {
  const u = new URL(launchUrl(unit, { endpoint: 'https://lrs.example.org/xapi/', fetch: 'https://lms.example.org/fetch/abc', actor, registration: 'reg-1' }));
  assert.deepEqual([...u.searchParams.keys()].sort(), ['activityId', 'actor', 'endpoint', 'fetch', 'registration']);
  assert.deepEqual(JSON.parse(u.searchParams.get('actor')!), actor);
});

test('a session follows the cmi5 rules and the unit is satisfied only per its moveOn', () => {
  let t = Date.parse('2026-11-26T10:00:00Z');
  const s = new Session(unit, actor, 'reg-1', () => new Date(t));
  assert.throws(() => s.completed(), /initialized first/);
  s.initialized();
  assert.throws(() => s.initialized(), /once per session/);
  t += 90_000;
  const failed = s.judged(0.6);
  assert.equal(failed.verb.id, VERBS.failed);
  assert.deepEqual(failed.result, { score: { scaled: 0.6 }, success: false, duration: 'PT90S' });
  assert.throws(() => s.judged(0.9), /sent once/);
  s.completed();
  s.terminated();
  assert.throws(() => s.completed(), /ended/);
  assert.equal(satisfied(unit, s.statements, { actor, registration: 'reg-1' }), false, 'completed but not passed');
  const again = new Session(unit, actor, 'reg-1', () => new Date(t));
  again.initialized();
  const passed = again.judged(0.85);
  assert.deepEqual(passed.context.contextActivities.category.map((c) => c.id), [CMI5_CATEGORY, MOVEON_CATEGORY]);
  again.terminated();
  assert.equal(satisfied(unit, [...s.statements, ...again.statements], { actor, registration: 'reg-1' }), true);
  assert.throws(() => again.judged(2), /ended/);
  assert.equal(new Session(unit, actor, 'r', () => new Date(t)).abandoned().verb.id, VERBS.abandoned);
});

test('every statement with success or completion carries the moveOn category, whatever the unit’s moveOn (cmi5 9.6.2.2)', () => {
  const t = Date.parse('2026-11-26T10:00:00Z');
  const passedOnly: Unit = { ...unit, moveOn: 'Passed' };
  const s = new Session(passedOnly, actor, 'reg-2', () => new Date(t));
  s.initialized();
  const cats = (x: { context: { contextActivities: { category: readonly { id: string }[] } } }) => x.context.contextActivities.category.map((c) => c.id);
  assert.deepEqual(cats(s.judged(0.2)), [CMI5_CATEGORY, MOVEON_CATEGORY], 'failed has success: false');
  assert.deepEqual(cats(s.completed()), [CMI5_CATEGORY, MOVEON_CATEGORY]);
  assert.deepEqual(cats(s.terminated()), [CMI5_CATEGORY], 'other statements must not');
});

test('passed and completed are sent at most once per registration, and failed never follows passed (cmi5 9.3)', () => {
  const t = Date.parse('2026-11-26T10:00:00Z');
  const first = new Session(unit, actor, 'reg-3', () => new Date(t));
  first.initialized();
  first.judged(0.9);
  first.completed();
  first.terminated();
  const second = new Session(unit, actor, 'reg-3', () => new Date(t), first.statements);
  second.initialized();
  assert.throws(() => second.judged(0.95), /once per registration/);
  assert.throws(() => second.judged(0.1), /after passed/);
  assert.throws(() => second.completed(), /once per registration/);
  const other = new Session(unit, actor, 'reg-4', () => new Date(t), first.statements);
  other.initialized();
  assert.equal(other.judged(0.9).verb.id, VERBS.passed, 'another registration starts afresh');
});

test('only this learner’s statements in this registration satisfy a unit, whatever else the record store returns', () => {
  const t = Date.parse('2026-11-26T10:00:00Z');
  const other = { objectType: 'Agent' as const, account: { homePage: 'https://files.example.org', name: 'u-99' } };
  const elsewhere = { objectType: 'Agent' as const, account: { homePage: 'https://other.example.org', name: 'u-42' } };
  const run = (who: typeof actor, reg: string) => {
    const s = new Session(unit, who, reg, () => new Date(t));
    s.initialized();
    s.judged(0.9);
    s.completed();
    s.terminated();
    return s.statements;
  };
  const mine = { actor, registration: 'reg-5' };
  assert.equal(satisfied(unit, run(other, 'reg-5'), mine), false, 'another learner’s results never count');
  assert.equal(satisfied(unit, run(elsewhere, 'reg-5'), mine), false, 'the same name on another home page is another learner');
  assert.equal(satisfied(unit, run(actor, 'reg-6'), mine), false, 'another registration’s results never count');
  const passedOnly = new Session(unit, actor, 'reg-5', () => new Date(t));
  passedOnly.initialized();
  passedOnly.judged(0.9);
  const completedByOther = run(other, 'reg-5').filter((s) => s.verb.id === VERBS.completed);
  assert.equal(satisfied(unit, [...passedOnly.statements, ...completedByOther], mine), false, 'a mixed set cannot borrow another learner’s completion');
  assert.equal(satisfied(unit, [...run(other, 'reg-5'), ...run(actor, 'reg-5')], mine), true);
  const relabelled = run(actor, 'reg-5').map((s) => (s.verb.id === VERBS.failed || s.verb.id === VERBS.completed ? s : { ...s, verb: { id: VERBS.failed, display: { 'en-US': 'passed' as const } } }));
  assert.equal(satisfied(unit, relabelled, mine), false, 'a verb is its id, not its display text');
});
