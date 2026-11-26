import { describe, expect, it } from 'vitest';
import { MIN_CELL, canary, leaks, matrix, safeCount, safeRate, tooSmall, trace, unexercised, type FlowPolicy } from '../src/index.js';

// Verifies docs/blocks/privacy.md
const policy: FlowPolicy = { public: ['store', 'log', 'screen'], internal: ['store', 'log'], personal: ['store', 'screen'], sensitive: ['store'], secret: [] };

describe('canaries', () => {
  it('are stable per field, distinct across fields, and shaped as asked', () => {
    const a = canary('students.chosenName', 'personal');
    expect(a).toEqual(canary('students.chosenName', 'personal'));
    expect(a.value).toMatch(/^Qz[a-j]{0}[a-z]{8}$/);
    expect(canary('students.zip', 'personal').value).not.toBe(a.value);
    expect(canary('students.phone', 'personal', 'digits').value).toMatch(/^\d{10}$/);
    expect(canary('x', 'personal', 'word', ['egress']).also).toEqual(['egress']);
    expect('also' in canary('x', 'personal')).toBe(false);
  });
});

describe('trace', () => {
  const name = canary('students.chosenName', 'personal', 'word', ['egress']);
  const fact = canary('sealed.income', 'sensitive');
  const token = canary('api_tokens.token', 'secret');
  const sinks = { store: `{"chosenName":"${name.value}","income":"${fact.value}"}`, screen: `Hi ${name.value.toUpperCase()}`, log: `GET /x?q=${encodeURIComponent(fact.value)}`, egress: `firstName=${name.value}` };
  const fs = trace([name, fact, token], sinks, policy);

  it('finds each marker in each sink, ignoring case and URL escaping', () => {
    expect(fs.map((f) => `${f.field}@${f.sink}`)).toEqual(['students.chosenName@store', 'students.chosenName@screen', 'students.chosenName@egress', 'sealed.income@store', 'sealed.income@log']);
  });
  it('judges each finding by class and by the field\'s declared extras', () => {
    expect(fs.find((f) => f.sink === 'egress')!.allowed).toBe(true);
    expect(leaks(fs)).toEqual([{ field: 'sealed.income', cls: 'sensitive', sink: 'log', allowed: false }]);
  });
  it('names fields the run never exercised', () => {
    expect(unexercised([name, fact, token], fs)).toEqual(['api_tokens.token']);
  });
  it('draws a field-by-sink matrix', () => {
    const m = matrix([name, fact], fs, ['store', 'log', 'egress']);
    expect(m).toEqual([
      { field: 'students.chosenName', cls: 'personal', cells: { store: 'allowed', log: '', egress: 'allowed' } },
      { field: 'sealed.income', cls: 'sensitive', cells: { store: 'allowed', log: 'leak', egress: '' } },
    ]);
  });
});

describe('small cells', () => {
  it('suppresses groups under five, and shows five and over', () => {
    expect(MIN_CELL).toBe(5);
    expect([0, 4, 5, 6].map((n) => tooSmall(n))).toEqual([true, true, false, false]);
    expect(tooSmall(9, 10)).toBe(true);
    expect(safeRate(1, 4)).toBe('suppressed');
    expect(safeRate(1, 3, 3)).toBe(33.3);
    expect(safeRate(2, 3, 2)).toBe(66.7);
    expect(safeRate(5, 5)).toBe(100);
    expect(safeCount(3, 4)).toBe('suppressed');
    expect(safeCount(3, 5)).toBe(3);
    expect(safeCount(3, 2, 2)).toBe(3);
  });
});
