import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Forbidden } from '../rbac/index.ts';
import type { Policy } from '../rbac/index.ts';
import { AssignmentError, Assigner, checkRules, matches, onShift } from './index.ts';
import type { Agent, Item, Rule } from './index.ts';

const MON_10 = Date.UTC(2026, 0, 5, 10, 0); // Monday 10:00 UTC
const item = (id: string, fields: Item['fields'] = {}, needs?: string[]): Item => ({ id, fields, ...(needs ? { needs } : {}) });
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, capacity: 3, teams: ['support'], ...over });
const rr: Rule = { id: 'all', pool: { team: 'support' }, strategy: 'round-robin' };
const policy: Policy = { roles: { lead: { label: 'Lead' }, agent: { label: 'Agent' } }, grants: [{ role: 'lead', kind: 'assignment', actions: ['override'] }] };

test('round robin goes in id order, wraps, and skips whoever cannot take it', () => {
  const a = new Assigner([rr]);
  const team = [agent('c'), agent('a'), agent('b', { available: false })];
  const got = ['1', '2', '3', '4'].map((i) => a.assign(item(i), team, MON_10).agent);
  assert.deepEqual(got, ['a', 'c', 'a', 'c']);
});

test('every person passed over is listed with the reason', () => {
  const a = new Assigner([rr]);
  const team = [agent('a', { available: false }), agent('b', { shifts: [{ days: [2], from: '09:00', to: '17:00' }] }), agent('c', { capacity: 0 }), agent('d')];
  const o = a.assign(item('x'), team, MON_10);
  assert.equal(o.agent, 'd');
  assert.deepEqual(o.passedOver, [{ agent: 'a', reason: 'marked unavailable' }, { agent: 'b', reason: 'off shift' }, { agent: 'c', reason: 'at capacity (0 of 0)' }]);
});

test('nobody can take it: no agent, and why', () => {
  const a = new Assigner([rr]);
  const o = a.assign(item('x'), [agent('a', { available: false })], MON_10);
  assert.equal(o.agent, null);
  assert.equal(o.because, 'everyone in the pool was passed over');
  assert.equal(a.assign(item('y'), [], MON_10).because, 'the pool is empty');
  assert.equal(new Assigner([{ ...rr, when: [{ field: 'vip', equals: true }] }]).assign(item('z'), [agent('a')], MON_10).because, 'no rule matches this item');
});

test('capacity is enforced from what is open, and completing an item frees its place', () => {
  const a = new Assigner([{ id: 'r', pool: { team: 'support' }, strategy: 'least-loaded' }]);
  const team = [agent('a', { capacity: 1 })];
  assert.equal(a.assign(item('1'), team, MON_10).agent, 'a');
  assert.equal(a.assign(item('2'), team, MON_10).agent, null);
  assert.equal(a.complete('1'), true);
  assert.equal(a.complete('1'), false);
  assert.equal(a.assign(item('2'), team, MON_10).agent, 'a');
  assert.throws(() => a.assign(item('2'), team, MON_10), /already assigned to a/);
});

test('least loaded goes by share of capacity, then least recently served, then id', () => {
  const a = new Assigner([{ id: 'r', pool: { team: 'support' }, strategy: 'least-loaded' }]);
  const team = [agent('big', { capacity: 10 }), agent('small', { capacity: 2 })];
  const got = ['1', '2', '3', '4', '5'].map((i, n) => a.assign(item(i), team, MON_10 + n).agent);
  assert.deepEqual(got, ['big', 'small', 'big', 'big', 'big']);
  assert.equal(a.open('big') + a.open('small'), 5);
  assert.ok(a.open('big') > a.open('small'), 'the bigger person carries more');
  const t = new Assigner([{ id: 'r', pool: { team: 'support' }, strategy: 'least-loaded' }]);
  assert.equal(t.assign(item('1'), [agent('x'), agent('y')], MON_10).agent, 'x');
  assert.equal(t.assign(item('2'), [agent('x'), agent('y')], MON_10).agent, 'y');
});

test('skills: must hold every needed skill, specialists before generalists', () => {
  const a = new Assigner([{ id: 's', pool: { team: 'support' }, strategy: 'skills' }]);
  const team = [agent('gen', { skills: ['billing', 'tech', 'legal'] }), agent('spec', { skills: ['billing'] }), agent('none')];
  const o = a.assign(item('1', {}, ['billing']), team, MON_10);
  assert.equal(o.agent, 'spec');
  assert.deepEqual(o.passedOver, [{ agent: 'none', reason: 'lacks billing' }]);
  assert.equal(a.assign(item('2', {}, ['legal', 'billing']), team, MON_10).agent, 'gen');
  const none = a.assign(item('3', {}, ['legal', 'french']), team, MON_10);
  assert.equal(none.agent, null);
  assert.ok(none.passedOver.some((p) => p.reason === 'lacks legal, french'));
});

test('rules are tried in order and the first match decides the pool and strategy', () => {
  const rules: Rule[] = [
    { id: 'vip', when: [{ field: 'tier', in: ['gold', 'platinum'] }], pool: { agents: ['a1'] }, strategy: 'least-loaded' },
    { id: 'billing', when: [{ field: 'topic', equals: 'billing' }, { field: 'region', exists: false }], pool: { team: 'finance' }, strategy: 'round-robin' },
    rr,
  ];
  const team = [agent('a1'), agent('f1', { teams: ['finance'] }), agent('s1')];
  const a = new Assigner(rules);
  assert.deepEqual([a.assign(item('1', { tier: 'gold', topic: 'billing' }), team, MON_10).rule, a.assign(item('2', { topic: 'billing' }), team, MON_10).agent, a.assign(item('3', { topic: 'billing', region: 'eu' }), team, MON_10).rule], ['vip', 'f1', 'all']);
  assert.equal(matches(rules[0]!, item('x', { tier: 'bronze' })), false);
});

test('rule sets are checked: unknown agents, empty teams, shadowed rules, duplicate ids', () => {
  const problems = checkRules([{ id: 'a', pool: { agents: ['ghost'] }, strategy: 'round-robin' }, { id: 'a', pool: { team: 'none' }, strategy: 'round-robin' }, { id: 'c', pool: {}, strategy: 'weighted', when: [{ field: 'x', exists: true }] }], [agent('real')]);
  assert.deepEqual(problems, [
    'rule a names ghost, who does not exist',
    'rule a matches everything, so the rules after it never run',
    'rule id "a" is used twice',
    'rule a: nobody is in team none',
    'rule a matches everything, so the rules after it never run',
    'rule c has no pool',
  ]);
  assert.deepEqual(checkRules([rr], [agent('a', { capacity: 1.5 })]), ['a has a capacity that is not a whole number']);
});

test('shifts are read in the person\'s own offset, including overnight shifts and days off', () => {
  const dayShift = agent('d', { shifts: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }], utcOffsetMin: -300 });
  assert.equal(onShift(dayShift, Date.UTC(2026, 0, 5, 14, 0)), true, '09:00 in Dayton on Monday');
  assert.equal(onShift(dayShift, Date.UTC(2026, 0, 5, 13, 59)), false, '08:59');
  assert.equal(onShift(dayShift, Date.UTC(2026, 0, 5, 22, 0)), false, '17:00 is the end');
  assert.equal(onShift(dayShift, Date.UTC(2026, 0, 10, 15, 0)), false, 'Saturday');
  const night = agent('n', { shifts: [{ days: [5], from: '22:00', to: '06:00' }] });
  assert.equal(onShift(night, Date.UTC(2026, 0, 9, 23, 0)), true, 'Friday 23:00');
  assert.equal(onShift(night, Date.UTC(2026, 0, 10, 5, 59)), true, 'Saturday 05:59 still belongs to the Friday shift');
  assert.equal(onShift(night, Date.UTC(2026, 0, 10, 6, 0)), false);
  assert.equal(onShift(night, Date.UTC(2026, 0, 10, 23, 0)), false, 'Saturday night is not a shift');
  assert.equal(onShift(agent('o', { daysOff: ['2026-01-05'] }), MON_10), false);
  assert.equal(onShift(agent('o2', { daysOff: ['2026-01-05'], utcOffsetMin: 600 }), Date.UTC(2026, 0, 5, 20, 0)), true, 'already Tuesday there');
  assert.throws(() => onShift(agent('bad', { shifts: [{ days: [1], from: '9am', to: '17:00' }] }), MON_10), AssignmentError);
  assert.throws(() => onShift(agent('bad', { shifts: [{ days: [1], from: '09:00', to: '09:00' }] }), MON_10), /same time/);
});

test('rules that ignore shifts still respect availability and capacity', () => {
  const a = new Assigner([{ ...rr, ignoreShifts: true }]);
  const team = [agent('a', { shifts: [{ days: [2], from: '09:00', to: '10:00' }] }), agent('b', { available: false })];
  const o = a.assign(item('1'), team, MON_10);
  assert.equal(o.agent, 'a');
  assert.deepEqual(o.passedOver, [{ agent: 'b', reason: 'marked unavailable' }]);
});

test('weighted draws follow the injected random source, by weight times free capacity', () => {
  const a = new Assigner([{ id: 'w', pool: { team: 'support' }, strategy: 'weighted' }]);
  const team = [agent('a', { weight: 1, capacity: 4 }), agent('b', { weight: 3, capacity: 4 })];
  assert.equal(a.assign(item('1'), team, MON_10, () => 0).agent, 'a');
  assert.equal(a.assign(item('2'), team, MON_10, () => 0.99).agent, 'b');
  const w = new Assigner([{ id: 'w', pool: { team: 'support' }, strategy: 'weighted' }]);
  const wins = { a: 0, b: 0 };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 400; i++) {
    const o = w.assign(item(`i${i}`), [agent('a', { weight: 1, capacity: 1000 }), agent('b', { weight: 3, capacity: 1000 })], MON_10, rnd);
    wins[o.agent as 'a' | 'b']++;
    w.complete(`i${i}`);
  }
  assert.ok(wins.b > wins.a * 2 && wins.b < wins.a * 4, `${wins.a}:${wins.b} should be about 1:3`);
});

test('overrides need permission and a reason, move the load, and are logged', () => {
  const a = new Assigner([rr]);
  const team = [agent('a'), agent('b', { capacity: 1 })];
  a.assign(item('1'), team, MON_10);
  assert.equal(a.holder('1'), 'a');
  assert.throws(() => a.override(policy, { id: 'p', roles: ['agent'] }, '1', team[1]!, 'because', MON_10), Forbidden);
  assert.throws(() => a.override(policy, { id: 'l', roles: ['lead'] }, '1', team[1]!, '  ', MON_10), /needs a reason/);
  assert.equal(a.overrides.length, 0);
  const e = a.override(policy, { id: 'l', roles: ['lead'] }, '1', team[1]!, ' customer asked for Bea ', MON_10 + 5);
  assert.deepEqual(e, { at: MON_10 + 5, item: '1', by: 'l', from: 'a', to: 'b', reason: 'customer asked for Bea', overCapacity: false });
  assert.equal(a.holder('1'), 'b');
  assert.equal(a.open('a'), 0);
  a.assign(item('2'), [agent('a', { available: false }), team[1]!], MON_10);
  const over = a.override(policy, { id: 'l', roles: ['lead'] }, '3', team[1]!, 'urgent', MON_10);
  assert.equal(over.overCapacity, true);
  assert.equal(over.from, null);
  assert.equal(a.overrides.length, 2);
});

test('releasing a person returns everything they held so it can be assigned again', () => {
  const a = new Assigner([rr]);
  const team = [agent('a'), agent('b')];
  a.assign(item('1'), team, MON_10);
  a.assign(item('2'), team, MON_10);
  a.assign(item('3'), team, MON_10);
  assert.deepEqual(a.release('a').sort(), ['1', '3']);
  assert.equal(a.open('a'), 0);
  assert.equal(a.holder('1'), null);
  assert.equal(a.assign(item('1'), [agent('b')], MON_10).agent, 'b');
});

test('fairness reports each person\'s share and the gap between most and least', () => {
  const a = new Assigner([rr]);
  const team = [agent('a', { capacity: 99 }), agent('b', { capacity: 99 }), agent('c', { capacity: 99 })];
  for (let i = 0; i < 9; i++) a.assign(item(`i${i}`), team, MON_10);
  assert.deepEqual(a.fairness(team), { shares: { a: 0.333, b: 0.333, c: 0.333 }, spread: 0, total: 9 });
  a.assign(item('x'), team, MON_10);
  assert.equal(a.fairness(team).spread, 0.1, 'four, three and three of ten');
  assert.deepEqual(new Assigner([rr]).fairness(team).shares, { a: 0, b: 0, c: 0 });
});
