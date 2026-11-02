import { Advocate } from '../src/agents/advocate.js';
import type { Student } from '../src/domain/types.js';

export const TODAY = '2026-11-02';
export const makeAdvocate = (today = TODAY) => new Advocate({ today: () => today, now: () => new Date(`${today}T15:00:00Z`) });

export const maria = (a: Advocate, over: Partial<Student> = {}) =>
  a.createStudent({
    chosenName: 'Maria',
    zip: '45402',
    age: 27,
    phone: '+19375551001',
    household: { size: 3, monthlyGrossIncome: 2100, monthlyEarnedIncome: 2100, childrenUnder6: 1, childrenUnder12: 2, singleParent: true },
    enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 30, workStudy: false },
    ...over,
  });
