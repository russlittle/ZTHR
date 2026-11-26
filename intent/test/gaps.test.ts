import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derive } from '../src/derive.ts';
import type { Statement } from '../src/frame.ts';
import { checkFlow, checkPairings, checkTable, satisfies, type DecisionTable } from '../src/gaps.ts';

test('tests on numbers, ranges, values and any behave at their boundaries', () => {
  assert.equal(satisfies('<700', 699.99), true);
  assert.equal(satisfies('<700', 700), false);
  assert.equal(satisfies('<=700', 700), true);
  assert.equal(satisfies('>=900', 900), true);
  assert.equal(satisfies('>900', 900), false);
  assert.equal(satisfies('700..899', 899), true);
  assert.equal(satisfies('700..899', 899.01), false);
  assert.equal(satisfies('$1,000', 1000), true);
  assert.equal(satisfies('*', 5), true);
  assert.equal(satisfies(undefined, 'x'), true);
  assert.equal(satisfies('yes', 'no'), false);
});

const warn: DecisionTable = {
  id: 'warn',
  conditions: [{ name: 'gap', numeric: true }, { name: 'due', values: ['this month', 'later'] }],
  rows: [
    { when: { gap: '>0', due: 'this month' }, then: 'warn with ways to cover it' },
    { when: { gap: '<0', due: '*' }, then: 'no warning' },
    { when: { due: 'later' }, then: 'no warning' },
  ],
};

test('a case no rule covers is found exactly at the boundary the rules leave open', () => {
  const q = checkTable(warn);
  assert.deepEqual(q.map((x) => x.text), ['What should happen when gap is 0 and due is this month? No rule covers it.']);
  assert.equal(q[0]!.origin, 'completeness');
});

test('two rules that answer the same case differently are found, with both answers as choices', () => {
  const q = checkTable({ ...warn, rows: [...warn.rows, { when: { gap: '>=0', due: 'this month' }, then: 'warn quietly' }] });
  const overlap = q.find((x) => x.origin === 'overlap');
  assert.deepEqual(overlap?.choices, ['warn with ways to cover it', 'warn quietly']);
  assert.ok(!q.some((x) => x.origin === 'completeness'), 'the new rule closes the gap at zero');
});

test('a complete table with no overlaps raises nothing, and one too large to check is a question, never a pass', () => {
  assert.deepEqual(checkTable({ ...warn, rows: [...warn.rows, { when: { gap: '0', due: 'this month' }, then: 'no warning' }] }), []);
  const big = checkTable({ id: 'big', conditions: Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, values: Array.from({ length: 10 }, (_, j) => String(j)) })), rows: [] });
  assert.equal(big.length, 1);
  assert.match(big[0]!.text, /too many cases/);
});

test('a flow with a state nothing reaches, a dead end, and a step nobody owns raises each', () => {
  const q = checkFlow({
    id: 'bill',
    initial: 'due',
    states: ['due', 'reminded', 'paid', 'disputed', 'archived'],
    final: ['paid'],
    transitions: [
      { from: 'due', to: 'reminded', on: 'three days before', by: 'system' },
      { from: 'reminded', to: 'paid', on: 'the student pays', by: 'student' },
      { from: 'reminded', to: 'disputed', on: 'the student disputes it' },
    ],
  });
  assert.deepEqual(q.map((x) => x.id), ['bill:dead-end:disputed', 'bill:unreachable:archived', 'bill:dead-end:archived', 'bill:owner:reminded->disputed']);
});

test('every intent needs a problem and an outcome; outcomes need measures; measures need tolerances', () => {
  const st = (slot: Statement['slot'], text: string, tolerance?: string): Statement => ({ id: text, slot, text, state: 'assumed', supplied: { kind: 'person' }, ...(tolerance ? { tolerance } : {}) });
  assert.deepEqual(checkPairings([]).map((q) => q.id), ['pair:problem', 'pair:outcome']);
  assert.deepEqual(checkPairings([st('problem', 'p'), st('outcome', 'o')]).map((q) => q.id), ['pair:measure']);
  assert.deepEqual(checkPairings([st('problem', 'p'), st('outcome', 'o'), st('measures', 'm')]).map((q) => q.id), ['pair:tolerance:m']);
  assert.deepEqual(checkPairings([st('problem', 'p'), st('outcome', 'o'), st('measures', 'm', 'all')]), []);
});

test('rules derive prerequisites, implications and the other side, naming the rule and the words that fired it', () => {
  const d = derive(['Remind students before bills are due', 'Staff should see who is struggling']);
  const rules = [...new Set(d.map((s) => (s.supplied.kind === 'derived' ? s.supplied.rule : '')))];
  assert.deepEqual(rules, ['contacts-people', 'money', 'staff-view']);
  assert.ok(d.every((s) => s.state === 'default'));
  assert.ok(d.some((s) => s.slot === 'people' && /staff/.test(s.text)));
  assert.equal(d.find((s) => s.id === 'contacts-people.p1')?.words, 'Remind');
  assert.deepEqual(derive(['Show a list of plants']), []);
});

test('an irreversible action derives a question about who confirms it', () => {
  const q = checkPairings([...derive(['Let students delete old bills']), { id: 'p', slot: 'problem', text: 'p', state: 'confirmed', supplied: { kind: 'person' } }, { id: 'o', slot: 'outcome', text: 'o', state: 'confirmed', supplied: { kind: 'person' } }, { id: 'm', slot: 'measures', text: 'm', tolerance: 't', state: 'confirmed', supplied: { kind: 'person' } }]);
  assert.deepEqual(q.map((x) => x.text), ['Before "delete" happens, who confirms it?']);
});
