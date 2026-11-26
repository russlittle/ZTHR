import { describe, expect, it } from 'vitest';
import { carelessness, phraseProblems, readingGrade, sentence, syllables } from '../src/index.js';

// Verifies docs/blocks/plain-language.md
describe('syllables', () => {
  it('counts vowel groups (a heuristic: beautiful reads as four), with short words as one and empty as none', () => {
    expect(['', '1', 'a', 'cat', 'the', 'water', 'beautiful', 'education', 'cake', 'played', 'boxes', 'yellow', 'queue'].map(syllables)).toEqual([0, 0, 1, 1, 1, 2, 4, 4, 1, 1, 1, 2, 2]);
  });
  it('never counts fewer than one for a real word', () => {
    expect(syllables('rhythm')).toBe(1);
  });
});

describe('reading grade', () => {
  it('plain sentences read low and dense ones read high', () => {
    expect(readingGrade('The bus comes at nine. Bring your card.')).toBeLessThan(3);
    expect(readingGrade('Institutional documentation requirements necessitate comprehensive verification of eligibility.')).toBeGreaterThan(14);
  });
  it('is zero with no words', () => {
    expect(readingGrade('')).toBe(0);
    expect(readingGrade('$12.50 (937) 555-0100')).toBe(0);
  });
  it('ignores web addresses, numbers and proper names', () => {
    const base = readingGrade('Call them today.');
    expect(readingGrade('Call them today at https://benefits.ohio.gov/apply/now.')).toBeCloseTo(readingGrade('Call them today at.'), 5);
    expect(readingGrade('Call Montgomery County Job and Family Services today.')).toBeLessThan(base + 4);
    expect(readingGrade('Go to benefits.ohio.gov today.')).toBeCloseTo(readingGrade('Go to site today.'), 5);
  });
  it('counts each line of a list as its own sentence', () => {
    const one = readingGrade('bring your card bring your lease bring your pay stub bring your id');
    const lines = readingGrade('bring your card\nbring your lease\nbring your pay stub\nbring your id');
    expect(lines).toBeLessThan(one);
  });
  it('matches the Flesch-Kincaid formula on a known sentence', () => {
    // 6 words, 1 sentence, 7 syllables
    expect(readingGrade('The cat sat on the water.')).toBeCloseTo(0.39 * 6 + 11.8 * (7 / 6) - 15.59, 5);
  });
});

describe('sentence', () => {
  it('adds one period only when there is no closing mark', () => {
    expect(sentence('Open until 5 p.m.')).toBe('Open until 5 p.m.');
    expect(sentence('Open now')).toBe('Open now.');
    expect(sentence('Open?')).toBe('Open?');
    expect(sentence('Open!')).toBe('Open!');
  });
});

describe('phrase rules and carelessness', () => {
  it('returns what each matching rule does, in rule order', () => {
    const rules: [RegExp, string][] = [[/\boverdue\b/i, 'scolds'], [/\bmust\b/i, 'commands'], [/\bnever-here\b/, 'unused']];
    expect(phraseProblems('You must pay. It is OVERDUE.', rules)).toEqual(['scolds', 'commands']);
    expect(phraseProblems('All set.', rules)).toEqual([]);
  });
  it('finds doubled periods but not an ellipsis', () => {
    expect(carelessness('Done..')).toEqual(['has a doubled period']);
    expect(carelessness('Wait...')).toEqual([]);
    expect(carelessness('Done.')).toEqual([]);
  });
  it('finds template holes and empty values', () => {
    for (const t of ['Meet ( ) today', 'Hi undefined', 'null dollars', 'NaN days', 'Hi ${name}']) expect(carelessness(t)).toEqual(['has a template hole or empty value']);
    expect(carelessness('Nullify nothing')).toEqual([]);
  });
});
