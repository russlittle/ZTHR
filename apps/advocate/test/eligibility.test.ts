// Verifies docs/flows/money.md
import { describe, expect, it } from 'vitest';
import { heap, lifeline, screenAll, sinclairEmergencyGrant, snap } from '../src/eligibility/engine.js';
import type { Student } from '../src/domain/types.js';
import { makeAdvocate, maria, TODAY } from './helpers.js';

describe('eligibility engine', () => {
  it('Maria likely qualifies for SNAP through the young-child and work exemptions, with an estimate', () => {
    const a = makeAdvocate();
    const r = snap(maria(a), TODAY);
    expect(r.status).toBe('likely');
    expect(r.estimatedMonthlyValue).toBeGreaterThan(0);
    expect(r.estimatedMonthlyValue).toBeLessThanOrEqual(808);
    expect(r.reasons.join(' ')).toMatch(/exemption/);
  });
  it('a full-time student with no exemption is unlikely, and is told why', () => {
    const a = makeAdvocate();
    const s = a.createStudent({ chosenName: 'P', zip: '45402', age: 20, household: { size: 1, monthlyGrossIncome: 600 }, enrollment: { college: 'sinclair', creditHours: 15, weeklyWorkHours: 5, workStudy: false } });
    const r = snap(s, TODAY);
    expect(r.status).toBe('unlikely');
    expect(r.reasons.join(' ')).toMatch(/exemption/);
  });
  it('missing facts produce needs-info, not a guess', () => {
    const a = makeAdvocate();
    const s = a.createStudent({ chosenName: 'Q', zip: '45402', household: { size: 1 }, enrollment: { college: 'sinclair' } });
    expect(snap(s, TODAY).status).toBe('needs-info');
    expect(lifeline(s, TODAY).status).toBe('needs-info');
  });
  it('a date outside every verified period is unconfirmed', () => {
    const a = makeAdvocate();
    expect(snap(maria(a), '2027-12-01').status).toBe('unconfirmed');
    expect(heap(maria(a), '2027-07-01').status).toBe('unconfirmed');
  });
  it('income limits follow the published tables', () => {
    const a = makeAdvocate();
    const over = a.createStudent({ chosenName: 'R', zip: '45402', household: { size: 1, monthlyGrossIncome: 1730 }, enrollment: { college: 'sinclair', creditHours: 3 } });
    expect(snap(over, TODAY).status).toBe('unlikely'); // limit $1,729 for one person
    const under = a.createStudent({ chosenName: 'S', zip: '45402', household: { size: 1, monthlyGrossIncome: 1729 }, enrollment: { college: 'sinclair', creditHours: 3 } });
    expect(snap(under, TODAY).status).toBe('likely');
    expect(heap(under, TODAY).status).toBe('likely'); // 1729*12 = 20,748 < 27,930
  });
  it('programs with status rules carry the note and never ask', () => {
    const a = makeAdvocate();
    expect(snap(maria(a), TODAY).statusRuleNote).toMatch(/never ask/);
  });
  it('Sinclair emergency grant follows its published criteria', () => {
    const a = makeAdvocate();
    expect(sinclairEmergencyGrant(maria(a)).status).toBe('likely');
    expect(sinclairEmergencyGrant(maria(a, { enrollment: { college: 'sinclair', creditHours: 4, degreeSeeking: true } })).status).toBe('unlikely');
    expect(sinclairEmergencyGrant(maria(a, { enrollment: { college: 'wright-state', creditHours: 12, degreeSeeking: true } })).status).toBe('unlikely');
  });
});

/**
 * SNAP, rule by rule, where a mutation run showed the tests above would not notice a change. Every expected value is
 * worked by hand from the FY2027 tables in params.ts and the student rule (7 CFR 273.5), never read from the engine.
 */
describe('SNAP, exactly', () => {
  const SNAP = {
    program: 'snap',
    title: 'SNAP food benefits',
    source: 'https://www.fna.usda.gov/snap/students',
    howToApply: 'Apply online at benefits.ohio.gov, or with your county Job and Family Services office.',
    statusRuleNote: 'Some programs have citizenship or immigration rules. We never ask about that. The agency explains its rules, and you and your family decide whether to apply.',
  };
  const UNDER_HALF = 'Under half-time, the student rule does not apply.';
  const NEEDS_EXEMPTION = 'Students enrolled half-time or more usually need an exemption, such as working 20 hours a week, work-study, or caring for a young child.';
  const under = (limit: number) => `Household income is under the limit of $${limit} a month.`;
  const over = (limit: number) => `Household income is over the limit of $${limit} a month.`;
  type Over = { household?: Partial<Student['household']>; enrollment?: Partial<Student['enrollment']>; age?: number; receives?: Student['receives'] };
  // Thirty years old, one person, under half-time: no student rule, no exemption by age.
  const st = (o: Over = {}): Student =>
    makeAdvocate().createStudent({ chosenName: 'T', zip: '45402', age: 'age' in o ? o.age : 30, household: { size: 1, ...o.household }, enrollment: { college: 'sinclair', creditHours: 3, ...o.enrollment }, receives: o.receives });
  // Full-time, no work, no work-study: the student rule applies and nothing exempts.
  const fullTime = (o: Over = {}) => st({ ...o, enrollment: { creditHours: 12, weeklyWorkHours: 0, workStudy: false, ...o.enrollment }, household: { monthlyGrossIncome: 900, ...o.household } });

  it('says which program it is, where its rule is, how to apply, and what it is worth', () => {
    // net = 900 - 20% of 900 - 217 = 503; 306 - 30% of 503 = 155.1, rounded to 155
    expect(snap(st({ household: { monthlyGrossIncome: 900 } }), TODAY)).toEqual({ ...SNAP, status: 'likely', reasons: [UNDER_HALF, under(1729)], needs: [], estimatedMonthlyValue: 155, valueIsEstimate: true });
  });
  it('a date before the verified year is unconfirmed, and says so', () => {
    expect(snap(st({ household: { monthlyGrossIncome: 900 } }), '2026-09-30')).toEqual({ ...SNAP, status: 'unconfirmed', reasons: ['SNAP income limits for this date have not been verified yet.'], needs: [] });
  });
  it('already receiving SNAP is likely, with nothing more asked', () => {
    expect(snap(st({ receives: { snap: true } }), TODAY)).toEqual({ ...SNAP, status: 'likely', reasons: ['You already receive SNAP.'], needs: [] });
  });
  it('a stored record with no benefits listed is screened, not broken', () => {
    const s = { ...fullTime(), receives: undefined };
    expect(snap(s, TODAY)).toEqual({ ...SNAP, status: 'unlikely', reasons: [NEEDS_EXEMPTION, under(1729)], needs: [] });
  });
  it('six credits is half-time: the student rule applies at 6 and not at 5', () => {
    expect(snap(fullTime({ enrollment: { creditHours: 6 } }), TODAY).status).toBe('unlikely');
    expect(snap(fullTime({ enrollment: { creditHours: 5 } }), TODAY)).toMatchObject({ status: 'likely', reasons: [UNDER_HALF, under(1729)] });
  });
  it('the age exemption is under 18 or 50 and older: 17 and 50 are exempt, 18 and 49 are not, and no age is not', () => {
    const exempt = { status: 'likely', reasons: ['You meet a student exemption: your age.', under(1729)] };
    expect(snap(fullTime({ age: 17 }), TODAY)).toMatchObject(exempt);
    expect(snap(fullTime({ age: 50 }), TODAY)).toMatchObject(exempt);
    expect(snap(fullTime({ age: 18 }), TODAY)).toMatchObject({ status: 'unlikely', reasons: [NEEDS_EXEMPTION, under(1729)] });
    expect(snap(fullTime({ age: 49 }), TODAY).status).toBe('unlikely');
    expect(snap(fullTime({ age: undefined }), TODAY).status).toBe('unlikely');
  });
  it('names every exemption that applies, in order, in its own words', () => {
    const s = fullTime({ age: 17, receives: { tanf: true }, enrollment: { weeklyWorkHours: 20, workStudy: true }, household: { size: 3, childrenUnder6: 1, childrenUnder12: 1, singleParent: true } });
    expect(snap(s, TODAY).reasons).toEqual([
      'You meet a student exemption: your age; you work 20 or more hours a week; you have work-study; you care for a child under 6; you are a single parent in school full-time with a child under 12; you receive TANF.',
      under(2960),
    ]);
  });
  it('caring for a child under 6 is an exemption on its own', () => {
    expect(snap(fullTime({ household: { size: 2, childrenUnder6: 1 } }), TODAY)).toMatchObject({ status: 'likely', reasons: ['You meet a student exemption: you care for a child under 6.', under(2345)] });
  });
  it('the single-parent exemption needs a single parent, a child under 12 and full-time study, all three', () => {
    expect(snap(fullTime({ household: { size: 2, singleParent: true, childrenUnder12: 1 } }), TODAY).reasons[0]).toBe('You meet a student exemption: you are a single parent in school full-time with a child under 12.');
    expect(snap(fullTime({ household: { size: 2, singleParent: false, childrenUnder12: 1 } }), TODAY).status).toBe('unlikely');
    expect(snap(fullTime({ household: { size: 2, singleParent: true, childrenUnder12: 0 } }), TODAY).status).toBe('unlikely');
  });
  it('asks for work hours and work-study when either is missing, and asks nothing it already has', () => {
    const ask = { status: 'needs-info', reasons: [under(1729)], needs: ['Hours you work each week, and if you have work-study'] };
    expect(snap(fullTime({ enrollment: { weeklyWorkHours: 5, workStudy: undefined } }), TODAY)).toEqual({ ...SNAP, ...ask });
    expect(snap(fullTime({ enrollment: { weeklyWorkHours: undefined, workStudy: false } }), TODAY)).toEqual({ ...SNAP, ...ask });
  });
  it('a known student rule with income missing asks for income only', () => {
    expect(snap(st(), TODAY)).toEqual({ ...SNAP, status: 'needs-info', reasons: [UNDER_HALF], needs: ['Money your home gets each month'] });
  });
  it('over the limit is unlikely, says the limit, and gives no estimate', () => {
    expect(snap(st({ household: { monthlyGrossIncome: 1730 } }), TODAY)).toEqual({ ...SNAP, status: 'unlikely', reasons: [UNDER_HALF, over(1729)], needs: [] });
  });
  it('the estimate takes 20% of earned income, not of all income', () => {
    // three people: net = 2000 - 20% of 1000 earned - 217 = 1583; 808 - 30% of 1583 = 333.1, rounded to 333
    expect(snap(st({ household: { size: 3, monthlyGrossIncome: 2000, monthlyEarnedIncome: 1000 } }), TODAY).estimatedMonthlyValue).toBe(333);
  });
  it('the last row of the table still gets an estimate', () => {
    // eight people: net = 3000 - 20% of 3000 - 308 = 2092; 1841 - 30% of 2092 = 1213.4, rounded to 1213
    expect(snap(st({ household: { size: 8, monthlyGrossIncome: 3000 } }), TODAY).estimatedMonthlyValue).toBe(1213);
  });
  it('each person past eight adds $616 to the limit: ten people, $7,269', () => {
    expect(snap(st({ household: { size: 10, monthlyGrossIncome: 7269 } }), TODAY).reasons).toEqual([UNDER_HALF, under(7269)]);
    expect(snap(st({ household: { size: 10, monthlyGrossIncome: 7270 } }), TODAY).status).toBe('unlikely');
  });
});

describe('screening every program', () => {
  it('screens SNAP, Lifeline, HEAP and the Sinclair grant, in that order, each by its own rule', () => {
    const s = maria(makeAdvocate());
    expect(screenAll(s, TODAY)).toEqual([snap(s, TODAY), lifeline(s, TODAY), heap(s, TODAY), sinclairEmergencyGrant(s)]);
    expect(screenAll(s, TODAY).map((r) => r.program)).toEqual(['snap', 'lifeline', 'ohio-heap', 'sinclair-emergency-grant']);
  });
});
