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
  assert.equal(satisfied(unit, s.statements), false, 'completed but not passed');
  const again = new Session(unit, actor, 'reg-1', () => new Date(t));
  again.initialized();
  const passed = again.judged(0.85);
  assert.deepEqual(passed.context.contextActivities.category.map((c) => c.id), [CMI5_CATEGORY, MOVEON_CATEGORY]);
  again.terminated();
  assert.equal(satisfied(unit, [...s.statements, ...again.statements]), true);
  assert.throws(() => again.judged(2), /ended/);
  assert.equal(new Session(unit, actor, 'r', () => new Date(t)).abandoned().verb.id, VERBS.abandoned);
});
