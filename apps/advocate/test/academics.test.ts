// Verifies docs/flows/stay-enrolled.md
import { describe, expect, it } from 'vitest';
import { currentGrade, gpa, letterFor, neededFor, pace, parseWeights, project, sap, standing, type Gradebook, type TranscriptCourse } from '../src/domain/academics.js';
import { HANDBOOK_CASE_2 as H, completed, r2t4, sixtyPercentDay } from '../src/domain/r2t4.js';
import { degreeProgress, nextTerms, programById, PROGRAMS } from '../src/domain/degree.js';
import { collegeById } from '../src/domain/colleges.js';

const tc = (rows: [string, number, TranscriptCourse['grade']?, string?][]): TranscriptCourse[] => rows.map(([course, credits, grade, term]) => ({ course, credits, term: term ?? 'Fall 2025', ...(grade ? { grade } : {}) }));
const WSU = collegeById('wright-state')!.academic!;
const SCC = collegeById('sinclair')!.academic!;

describe('grades from the syllabus weights', () => {
  const g: Gradebook = { course: 'CHM 1210', credits: 4, source: 'class-site', categories: [{ name: 'Exams', weight: 50 }, { name: 'Homework', weight: 20 }, { name: 'Final exam', weight: 30 }], items: [{ category: 'Exams', title: 'Exam 1', score: 80, outOf: 100 }, { category: 'Exams', title: 'Exam 2', score: 70, outOf: 100 }, { category: 'Homework', title: 'HW', score: 18, outOf: 20 }, { category: 'Final exam', title: 'Final exam', outOf: 100 }] };

  it('weights categories and renormalises over graded work', () => {
    // Exams 75% at weight 50, homework 90% at weight 20: (75*50 + 90*20) / 70 = 79.3
    expect(currentGrade(g)).toEqual({ percent: 79.3, letter: 'C', graded: 70 });
  });

  it('solves what the final needs, and says when a letter is out of reach', () => {
    // B needs 80 overall: 75*.5 + 90*.2 + x*.3 = 80  →  x = 81.67
    expect(neededFor(g, 'Final exam', 'B')).toEqual({ needed: 81.7, possible: true, already: false });
    expect(neededFor(g, 'Final exam', 'A')!.possible).toBe(false);
    expect(neededFor(g, 'Final exam', 'C')!.needed).toBeCloseTo(48.3, 1);
    expect(neededFor(g, 'no such', 'B')).toBeUndefined();
  });

  it('reads weights only when they add up to the whole grade', () => {
    expect(parseWeights('Exams 40%\nHomework: 25 %\nLabs - 15%\nFinal exam 20%')).toHaveLength(4);
    expect(parseWeights('Exams 40%\nHomework 25%')).toEqual([]);
  });

  it('uses the 90/80/70/60 scale unless the syllabus sets one', () => {
    expect([89.9, 90, 60, 59.9].map((x) => letterFor(x))).toEqual(['B', 'A', 'D', 'F']);
    expect(letterFor(85, { A: 85, B: 75, C: 65, D: 55 })).toBe('A');
  });
});

describe('GPA, pace and standing', () => {
  const t = tc([['ENG 1101', 3, 'B'], ['MAT 1450', 4, 'W'], ['SOC 1101', 3, 'F'], ['SOC 1101', 3, 'C', 'Spring 2026'], ['TRN 1000', 6, 'TR'], ['DEV 0950', 3, 'P']]);
  it('counts only graded credits, the latest attempt of a repeat, and no W, P or transfer', () => {
    expect(gpa(t)).toEqual({ gpa: 2.5, graded: 6, points: 15 });
  });
  it('counts W, F, repeats and transfer as attempted, and passes and transfer as earned', () => {
    expect(pace(t)).toEqual({ attempted: 22, earned: 15, rate: 68.18 });
  });
  it('Wright State: probation under 2.0 only after 12 attempted hours', () => {
    expect(standing(tc([['A', 3, 'D'], ['B', 3, 'C']]), WSU.standing).status).toBe('watch');
    expect(standing(tc([['A', 6, 'D'], ['B', 6, 'C']]), WSU.standing).status).toBe('probation');
    expect(standing(tc([['A', 6, 'B'], ['B', 6, 'C']]), WSU.standing).status).toBe('good');
  });
  it("Sinclair: intervention, probation, dismissal by consecutive terms under 2.0", () => {
    const bad = (term: string) => [['X' + term, 3, 'D', term]] as [string, number, 'D', string][];
    expect(standing(tc(bad('Fall 2025')), SCC.standing).label).toBe('Academic Intervention');
    expect(standing(tc([...bad('Fall 2025'), ...bad('Spring 2026')]), SCC.standing).label).toBe('Academic Probation');
    expect(standing(tc([...bad('Fall 2025'), ...bad('Spring 2026'), ...bad('Fall 2026')]), SCC.standing).label).toBe('Academic Dismissal');
    expect(standing(tc([...bad('Fall 2025'), ['Y', 3, 'A', 'Spring 2026']]), SCC.standing).status).toBe('good');
  });
});

describe('Satisfactory Academic Progress (34 CFR 668.34) at each college\'s thresholds', () => {
  it('fails pace at 66.66% at Sinclair and passes at 66.67%', () => {
    expect(sap(tc([['A', 2, 'A'], ['B', 1, 'W']]), SCC.sap, 60).checks.find((c) => c.rule === 'pace')!.meets).toBe(true); // 66.67
    const under = tc([['A', 6666, 'A'], ['B', 3334, 'W']]);
    expect(sap(under, SCC.sap, 1e5).checks.find((c) => c.rule === 'pace')).toMatchObject({ value: 66.66, meets: false });
  });
  it('Wright State needs 67%', () => {
    expect(sap(tc([['A', 2, 'A'], ['B', 1, 'W']]), WSU.sap, 120).checks.find((c) => c.rule === 'pace')!.meets).toBe(false);
  });
  it('the maximum timeframe is 150% of the program: 90 for an associate, 180 for a bachelor\'s', () => {
    expect(sap(tc([['A', 90, 'C']]), SCC.sap, 60)).toMatchObject({ maxAttempted: 90, meets: true });
    expect(sap(tc([['A', 91, 'C']]), SCC.sap, 60).checks.find((c) => c.rule === 'max-timeframe')!.meets).toBe(false);
    expect(sap(tc([['A', 180, 'C']]), WSU.sap, 120).maxAttempted).toBe(180);
  });
  it('a GPA under 2.0 fails, and with no record nothing is claimed', () => {
    expect(sap(tc([['A', 3, 'D'], ['B', 3, 'C']]), WSU.sap, 120).checks[0]).toMatchObject({ value: 1.5, meets: false });
    expect(sap([], WSU.sap, 120).checks.map((c) => c.meets)).toEqual([undefined, undefined, true]);
  });
  it('projects an in-progress class as a W', () => {
    const t = [...tc([['A', 6, 'B']]), { course: 'ACC 2010', credits: 3, term: 'Fall 2026' }];
    expect(pace(project(t, { 'ACC 2010': 'W' })).rate).toBe(66.67);
  });
});

describe('Return of Title IV funds (Handbook Volume 5)', () => {
  it('reproduces the Handbook\'s Case 2 to the cent', () => {
    const r = r2t4(H.period, H.lastDay, H.aid, H.charges);
    expect(r).toMatchObject(H.expect);
  });
  it('earns everything after 60% and nothing to return', () => {
    const r = r2t4(H.period, '2026-04-20', H.aid, H.charges);
    expect(r).toMatchObject({ allEarned: true, unearned: 0, schoolReturns: 0, studentGrantReturn: 0 });
  });
  it('leaves breaks of five days or more out of the count, and not shorter ones', () => {
    const p = { start: '2026-08-24', end: '2026-12-12', breaks: [{ from: '2026-11-25', to: '2026-11-29' }, { from: '2026-09-07', to: '2026-09-07' }] };
    expect(completed(p, '2026-12-12')).toMatchObject({ totalDays: 106, daysCompleted: 106, percent: 1 });
    expect(sixtyPercentDay(p)).toBe('2026-10-26');
  });
  it('waives a grant overpayment of $50 or less', () => {
    const r = r2t4(H.period, H.lastDay, { pell: 1000 }, 0);
    // all unearned grant is the student's to return, less 50% protection: 900 - 500 = 400 > 50
    expect(r.studentGrantReturn).toBe(400);
    const small = r2t4({ ...H.period }, '2026-03-30', { pell: 1000 }, 0);
    expect(small.studentGrantReturn === 0 || small.studentGrantReturn > 50).toBe(true);
  });
  it('sends loans back before grants, and the student repays loans on the note\'s terms', () => {
    const r = r2t4(H.period, H.lastDay, { pell: 1000, subsidized: 2000 }, 500);
    expect(r.schoolReturns).toBe(450);
    expect(r.studentLoanRepay).toBe(1550);
  });
});

describe('degree progress on the published pathway', () => {
  const p = programById('sinclair-aa-sociology')!;
  it('every declared program parses and names a source', () => {
    expect(PROGRAMS.length).toBeGreaterThan(0);
    for (const x of PROGRAMS) expect(x.source).toMatch(/^https:\/\//);
  });
  it('counts passed courses once, in their area, and in-progress ones separately', () => {
    const d = degreeProgress(p, [...tc([['ENG 1101', 3, 'B'], ['SOC 1101', 3, 'A'], ['PSY 1100', 3, 'F']]), { course: 'COM 2211', credits: 3, term: 'Fall 2026' }], 'Fall 2026', 12);
    expect(d.areas.find((a) => a.area === 'English composition')!.done).toBe(3);
    expect(d.areas.find((a) => a.area === 'Social and behavioral sciences')!.done).toBe(3);
    expect(d.areas.find((a) => a.area === 'Oral communication')!.inProgress).toBe(3);
    expect(d.earned).toBe(6);
    expect(d.ot36!.complete).toBe(false);
  });
  it('estimates the finish term at the student\'s load, skipping summers', () => {
    expect(nextTerms('Fall 2026', 1)).toBe('Spring 2027');
    expect(nextTerms('Fall 2026', 2)).toBe('Fall 2027');
    expect(degreeProgress(p, [], 'Fall 2026', 12).termsLeft).toBe(6);
  });
});
