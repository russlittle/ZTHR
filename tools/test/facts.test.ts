// Verifies docs/testing/facts.md
import { describe, expect, it } from 'vitest';
import { apply, check, render, unmarked, type Facts } from '../facts-core.js';

const facts: Facts = {
  gates: { kind: 'repo', value: 28 },
  blocks: { kind: 'repo', value: 15, style: 'word' },
  lines: { kind: 'repo', value: 28544, style: 'hundred' },
  tests: { kind: 'run', value: 2061 },
  walk: { kind: 'run', value: undefined },
};
const m = (name: string, v: string) => `<!--fact:${name}-->${v}<!--/fact-->`;

describe('facts: one source for every number public material states', () => {
  it('renders counts with commas, small counts as words, rounded figures to the hundred, and absence as not measured', () => {
    expect([render(facts.gates!), render(facts.blocks!), render(facts.lines!), render(facts.tests!), render(facts.walk!)]).toEqual(['28', 'fifteen', '28,500', '2,061', 'not measured']);
    expect(render({ kind: 'repo', value: 25, style: 'word' })).toBe('25');
  });
  it('a stale or unknown repository fact is a mismatch; a run fact is left to the build that measured it', () => {
    expect(check(`${m('gates', '27')} gates and ${m('blocks', 'Fifteen')} blocks`, facts)).toEqual([{ fact: 'gates', written: '27', current: '28' }]);
    expect(check(m('nope', '1'), facts)).toEqual([{ fact: 'nope', written: '1', current: 'no such fact' }]);
    expect(check(m('tests', '1'), facts)).toEqual([]);
    expect(check(m('tests', '1'), facts, ['run'])).toEqual([{ fact: 'tests', written: '1', current: '2,061' }]);
  });
  it('a rounded figure holds within five percent; outside it, it is stale', () => {
    expect(check(m('lines', '27,200'), facts)).toEqual([]);
    expect(check(m('lines', '27,000'), facts)).toEqual([{ fact: 'lines', written: '27,000', current: '28,500' }]);
  });
  it('rewrites each marked fact of the given kinds, keeping a capital at the start of a sentence', () => {
    expect(apply(`${m('blocks', 'Twelve')} parts; ${m('gates', '1')}; ${m('tests', '9')}`, facts, ['repo'])).toBe(`${m('blocks', 'Fifteen')} parts; ${m('gates', '28')}; ${m('tests', '9')}`);
    expect(apply(m('walk', 'every student'), facts)).toBe(m('walk', 'not measured'));
  });
  it('finds counts stated with no source, but not in code, quoted examples or generated test lists', () => {
    expect(unmarked('It has 4,000 tests and 12 of 12 students; 3 tests.')).toEqual(['4,000 tests', '12 of 12 students']);
    expect(unmarked('```\n99 tests\n```\n"Helped 14 of 19 students who tried it." <!-- verified-by:start -->- x (12 tests)<!-- verified-by:end -->')).toEqual([]);
    expect(unmarked(`${m('gates', '28')} gates`)).toEqual([]);
  });
});
