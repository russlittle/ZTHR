import { describe, expect, it } from 'vitest';
import { heap, lifeline, snap } from '../src/eligibility/engine.js';
import { checkTone, readingGrade, syllables } from '../src/domain/tone.js';
import { makeAdvocate, maria, TODAY } from './helpers.js';

const mk = (a: ReturnType<typeof makeAdvocate>, household: object, enrollment: object = { college: 'sinclair', creditHours: 3 }, extra: object = {}) =>
  a.createStudent({ chosenName: 'T', zip: '45402', age: 30, household: { size: 1, ...household }, enrollment: { college: 'sinclair', ...enrollment }, ...extra });

describe('SNAP exactness', () => {
  it('estimates from the published table', () => {
    // net = 2100 - 20% of 2100 - 217 = 1463; 808 - 30% of 1463 = 369
    expect(snap(maria(makeAdvocate()), TODAY).estimatedMonthlyValue).toBe(369);
  });
  it('households larger than the table get no estimate rather than a guess', () => {
    const a = makeAdvocate();
    const r = snap(mk(a, { size: 9, monthlyGrossIncome: 2000 }), TODAY);
    expect(r.status).toBe('likely');
    expect(r.estimatedMonthlyValue).toBeUndefined();
  });
  it('limits beyond eight people add the published increment', () => {
    const a = makeAdvocate();
    expect(snap(mk(a, { size: 9, monthlyGrossIncome: 6037 + 616 }), TODAY).status).toBe('likely');
    expect(snap(mk(a, { size: 9, monthlyGrossIncome: 6037 + 617 }), TODAY).status).toBe('unlikely');
  });
  it.each([
    ['age 50 or older', { creditHours: 12, weeklyWorkHours: 0, workStudy: false }, { age: 50 }],
    ['work-study', { creditHours: 12, weeklyWorkHours: 0, workStudy: true }, {}],
    ['20 work hours', { creditHours: 12, weeklyWorkHours: 20, workStudy: false }, {}],
    ['TANF', { creditHours: 12, weeklyWorkHours: 0, workStudy: false }, { receives: { tanf: true } }],
  ])('student exemption: %s', (_n, enrollment, extra) => {
    const a = makeAdvocate();
    expect(snap(mk(a, { monthlyGrossIncome: 900 }, enrollment, { age: 20, ...extra }), TODAY).status).toBe('likely');
  });
  it('19 work hours is not an exemption; a single full-time parent of a child under 12 is', () => {
    const a = makeAdvocate();
    expect(snap(mk(a, { monthlyGrossIncome: 900 }, { creditHours: 12, weeklyWorkHours: 19, workStudy: false }, { age: 20 }), TODAY).status).toBe('unlikely');
    expect(snap(mk(a, { size: 2, monthlyGrossIncome: 900, singleParent: true, childrenUnder12: 1 }, { creditHours: 12, weeklyWorkHours: 0, workStudy: false }, { age: 22 }), TODAY).status).toBe('likely');
    expect(snap(mk(a, { size: 2, monthlyGrossIncome: 900, singleParent: true, childrenUnder12: 1 }, { creditHours: 11, weeklyWorkHours: 0, workStudy: false }, { age: 22 }), TODAY).status).toBe('unlikely');
  });
  it('under half-time skips the student rule; already receiving is likely', () => {
    const a = makeAdvocate();
    expect(snap(mk(a, { monthlyGrossIncome: 900 }, { creditHours: 5 }, { age: 20 }), TODAY).reasons[0]).toMatch(/half-time/);
    expect(snap(mk(a, {}, {}, { receives: { snap: true } }), TODAY)).toMatchObject({ status: 'likely', reasons: ['You already receive SNAP.'] });
  });
  it('asks for credit hours and work facts it lacks', () => {
    const a = makeAdvocate();
    const r = snap(mk(a, { monthlyGrossIncome: 900 }, { creditHours: undefined }), TODAY);
    expect(r.status).toBe('needs-info');
    expect(r.needs).toEqual(expect.arrayContaining(['How many credit hours you are taking']));
  });
});

describe('Lifeline and HEAP boundaries', () => {
  it('Lifeline at 135% of poverty for two people', () => {
    const a = makeAdvocate();
    expect(lifeline(mk(a, { size: 2, monthlyGrossIncome: 2434 }), TODAY).status).toBe('likely');
    expect(lifeline(mk(a, { size: 2, monthlyGrossIncome: 2435 }), TODAY).status).toBe('unlikely');
    expect(lifeline(mk(a, { size: 2, monthlyGrossIncome: 2434 }), TODAY).estimatedMonthlyValue).toBe(9.25);
  });
  it('Lifeline through SNAP, Medicaid or SSI', () => {
    const a = makeAdvocate();
    const r = lifeline(mk(a, { monthlyGrossIncome: 9000 }, {}, { receives: { medicaid: true } }), TODAY);
    expect(r.status).toBe('likely');
    expect(r.reasons[0]).toBe('You receive MEDICAID, which qualifies.');
  });
  it('HEAP at 175% of poverty for two people', () => {
    const a = makeAdvocate();
    expect(heap(mk(a, { size: 2, monthlyGrossIncome: 3155 }), TODAY).status).toBe('likely');
    expect(heap(mk(a, { size: 2, monthlyGrossIncome: 3156 }), TODAY).status).toBe('unlikely');
    expect(heap(mk(a, { size: 13, monthlyGrossIncome: 8000 }), TODAY).status).toBe('likely');
  });
});

describe('reading grade exactness', () => {
  it('counts syllables', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('ab')).toBe(1);
    expect(syllables('12')).toBe(0);
    expect(syllables('make')).toBe(1);
    expect(syllables('table')).toBe(2);
    expect(syllables('yellow')).toBe(2);
    expect(syllables('wanted')).toBe(1);
  });
  it('computes Flesch-Kincaid', () => {
    expect(readingGrade('The cat sat.')).toBeCloseTo(-2.62, 2);
    expect(readingGrade('')).toBe(0);
  });
  it('ignores links and proper names but not ordinary words', () => {
    expect(readingGrade('Go here http://example.com/a/very/long/path now.')).toBeCloseTo(readingGrade('Go here now.'), 5);
    expect(readingGrade('Call Miami Valley Community Action Partnership today.')).toBeCloseTo(readingGrade('Call Name today.'), 5);
    expect(readingGrade('Call the community action partnership today.')).toBeGreaterThan(readingGrade('Call Name today.'));
  });
  it('brief limit is 320 characters and safety messages skip grade and step checks', () => {
    const base = { nextSteps: [{ label: 'x', action: 'x' }], urgency: 'routine' as const };
    expect(checkTone({ ...base, text: 'a. '.repeat(106) + 'ab' }, 'brief', 8).ok).toBe(true); // 320 chars
    expect(checkTone({ ...base, text: 'a. '.repeat(107) }, 'brief', 8).ok).toBe(false);
    expect(checkTone({ text: 'Notwithstanding institutional verification requirements necessitate consideration.', nextSteps: [], urgency: 'safety' }, 'standard', 4).ok).toBe(true);
  });
});
