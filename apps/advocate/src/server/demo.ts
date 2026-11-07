import type { Advocate } from '../agents/advocate.js';
import type { Student } from '../domain/types.js';

/** Twelve synthetic students for the demonstration build. Each can be built alone, so tests stay fast. */
type Builder = (a: Advocate) => Student;

const ENG_SYLLABUS = `Use of AI: Generative AI may not be used to write graded work unless you disclose it.\nTue Nov 4 - Essay 2 draft due\nThursday, November 6: Essay 2 final due\n11/18 Quiz on rhetorical appeals`;
const withEnglish = (a: Advocate, s: Student): Student => {
  a.uploadSyllabus(s.id, 'ENG 1101', ENG_SYLLABUS, '2026-08-24');
  a.confirmDeadlines(s.id, 'all');
  return s;
};

export const PERSONAS: Record<string, Builder> = {
  Maria: (a) => {
    const s = a.createStudent({ id: 'maria', chosenName: 'Maria', zip: '45417', age: 27, household: { size: 3, monthlyGrossIncome: 2100, monthlyEarnedIncome: 2100, childrenUnder6: 1, childrenUnder12: 2, singleParent: true }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 30, workStudy: false } });
    a.addClasses(s.id, [{ course: 'BIO 1111', days: ['Mon', 'Wed'], start: '09:00', end: '10:50', building: 'Building 3', room: '212' }, { course: 'MAT 1130', days: ['Tue', 'Thu'], start: '12:30', end: '13:45', building: 'Building 7', room: '101' }]);
    a.addShifts(s.id, [{ date: '2026-11-02', start: '15:00', end: '23:00', employer: 'Care center' }, { date: '2026-11-03', start: '15:00', end: '23:00', employer: 'Care center' }, { date: '2026-11-05', start: '15:00', end: '23:00', employer: 'Care center' }]);
    a.addDeadline(s.id, { title: 'Lab report 5', course: 'BIO 1111', due: '2026-11-06', kind: 'assignment', effortHours: 4, source: { type: 'syllabus', line: 'Nov 6 Lab report 5 due' }, confirmed: true });
    a.setMoney(s.id, 300, [{ name: 'Rent', amount: 1050, dueDay: 1, kind: 'rent' }, { name: 'Electric', amount: 140, dueDay: 20, kind: 'utility' }], { amount: 400, next: '2026-11-05', everyDays: 14 });
    return s;
  },
  Jayden: (a) => {
    const s = withEnglish(a, a.createStudent({ id: 'jayden', chosenName: 'Jayden', zip: '45435', age: 19, household: { size: 1, monthlyGrossIncome: 900 }, enrollment: { college: 'wright-state', creditHours: 15, degreeSeeking: true, weeklyWorkHours: 12, workStudy: true } }));
    a.addClasses(s.id, [{ course: 'ENG 1101', days: ['Mon', 'Wed', 'Fri'], start: '10:10', end: '11:05', building: 'Millett Hall', room: '158' }, { course: 'CS 1180', days: ['Tue', 'Thu'], start: '09:30', end: '10:50', building: 'Russ Engineering', room: '154' }, { course: 'PSY 1010', days: ['Mon', 'Wed'], start: '13:25', end: '14:45', building: 'Fawcett Hall', room: '101' }]);
    a.addShifts(s.id, [{ date: '2026-11-02', start: '16:00', end: '19:00', employer: 'Library desk (work-study)' }, { date: '2026-11-04', start: '16:00', end: '19:00', employer: 'Library desk (work-study)' }, { date: '2026-11-06', start: '12:00', end: '18:00', employer: 'Library desk (work-study)' }]);
    return s;
  },
  Darnell: (a) => {
    const s = a.createStudent({ id: 'darnell', chosenName: 'Darnell', zip: '45402', age: 34, household: { size: 1, monthlyGrossIncome: 1600 }, enrollment: { college: 'sinclair', creditHours: 9, degreeSeeking: true, weeklyWorkHours: 40 } });
    a.seal(s.id, 'justice_involvement', 'synthetic sealed fact for the demonstration');
    return s;
  },
  Ana: (a) => a.createStudent({ id: 'ana', chosenName: 'Ana', zip: '45324', age: 31, dial: { depth: 'brief' } as Student['dial'], household: { size: 1, monthlyGrossIncome: 2400 }, enrollment: { college: 'wright-state', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 10 } }),
  Tyler: (a) => withEnglish(a, a.createStudent({ id: 'tyler', chosenName: 'Tyler', zip: '45385', age: 18, household: { size: 4, monthlyGrossIncome: 3400 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 22 } })),
  Priya: (a) => {
    const s = withEnglish(a, a.createStudent({ id: 'priya', chosenName: 'Priya', zip: '45435', age: 20, enrollment: { college: 'wright-state', creditHours: 17 } }));
    a.addClasses(s.id, [{ course: 'CHM 1210', days: ['Mon', 'Wed', 'Fri'], start: '08:00', end: '08:55', building: 'Oelman Hall', room: '109' }, { course: 'ENG 1101', days: ['Mon', 'Wed', 'Fri'], start: '10:10', end: '11:05', building: 'Millett Hall', room: '158' }, { course: 'BIO 1120', days: ['Mon', 'Wed'], start: '12:20', end: '13:15', building: 'Biological Sciences', room: '116' }, { course: 'MTH 2300', days: ['Tue', 'Thu'], start: '09:30', end: '10:50', building: 'Math and Microbiology', room: '025' }, { course: 'CHM 1210L', days: ['Tue'], start: '14:00', end: '16:50', building: 'Oelman Hall', room: '220' }]);
    return s;
  },
  Destiny: (a) => {
    const s = withEnglish(a, a.createStudent({ id: 'destiny', chosenName: 'Destiny', zip: '45435', age: 22, household: { size: 1, monthlyGrossIncome: 1500, monthlyEarnedIncome: 1500 }, enrollment: { college: 'wright-state', creditHours: 15, degreeSeeking: true, weeklyWorkHours: 24 } }));
    a.addClasses(s.id, [{ course: 'ENG 1101', days: ['Mon', 'Wed', 'Fri'], start: '10:10', end: '11:05', building: 'Millett Hall', room: '158' }, { course: 'SOC 2000', days: ['Mon', 'Wed'], start: '13:25', end: '14:45', building: 'Allyn Hall', room: '224' }, { course: 'ACC 2010', days: ['Tue', 'Thu'], start: '11:00', end: '12:20', building: 'Rike Hall', room: '161' }]);
    a.addShifts(s.id, [{ date: '2026-11-02', start: '06:00', end: '09:30', employer: 'Coffee shop' }, { date: '2026-11-02', start: '17:00', end: '21:00', employer: 'Grocery' }, { date: '2026-11-03', start: '15:00', end: '21:00', employer: 'Grocery' }, { date: '2026-11-04', start: '06:00', end: '09:30', employer: 'Coffee shop' }, { date: '2026-11-06', start: '06:00', end: '09:30', employer: 'Coffee shop' }, { date: '2026-11-07', start: '10:00', end: '18:00', employer: 'Grocery' }]);
    return s;
  },
  Sam: (a) => withEnglish(a, a.createStudent({ id: 'sam', chosenName: 'Sam', pronouns: 'they/them', zip: '45402', age: 21, dial: { depth: 'walk-me-through', readingGrade: 6 } as Student['dial'], enrollment: { college: 'sinclair', creditHours: 9 } })),
  Linda: (a) => a.createStudent({ id: 'linda', chosenName: 'Linda', zip: '45417', age: 46, dial: { channel: 'text', depth: 'walk-me-through' } as Student['dial'], household: { size: 2, monthlyGrossIncome: 1400 }, enrollment: { college: 'sinclair', creditHours: 6, degreeSeeking: true, weeklyWorkHours: 20 } }),
  Luis: (a) => a.createStudent({ id: 'luis', chosenName: 'Luis', zip: '45403', age: 19, household: { size: 5, monthlyGrossIncome: 3900 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 15 } }),
  Alex: (a) => a.createStudent({ id: 'alex', chosenName: 'Alex', pronouns: 'they/them', zip: '45387', age: 20, enrollment: { college: 'antioch', creditHours: 15 } }),
  Keisha: (a) => a.createStudent({ id: 'keisha', chosenName: 'Keisha', zip: '30310', county: 'Fulton', age: 25, enrollment: { college: 'wright-state', creditHours: 6 } }),
};

export const PERSONA_NAMES = Object.keys(PERSONAS);

/** One line about each demonstration student, for the product page and the start page. */
export const PERSONA_LINES: Record<string, { line: string; college: string; tries: string }> = {
  Maria: { line: 'Single parent studying nursing, works nights. Rent is short this month.', college: 'Sinclair', tries: 'the rent plan, the bus to class, a room booking' },
  Jayden: { line: 'First year, work-study, first time living alone.', college: 'Wright State', tries: 'class-site sync, an essay plan, jobs that fit' },
  Darnell: { line: 'Back in school at 34 and working full time.', college: 'Sinclair', tries: 'the fair-chance career path, money he is missing' },
  Ana: { line: 'Wants short answers and nothing extra.', college: 'Wright State', tries: 'brief mode: the same help in fewer words' },
  Tyler: { line: 'First in his family at college.', college: 'Sinclair', tries: 'FAFSA step by step, what a registrar is' },
  Priya: { line: 'Seventeen credits and a packed calendar.', college: 'Wright State', tries: 'the week solver and held study time' },
  Destiny: { line: 'Juggling two jobs and a full load.', college: 'Wright State', tries: 'shift conflicts and jobs that fit' },
  Sam: { line: 'Wants things one step at a time.', college: 'Sinclair', tries: 'walk-me-through mode at a sixth-grade reading level' },
  Linda: { line: 'Back to school at 46; prefers texting.', college: 'Sinclair', tries: 'the whole app by text message' },
  Luis: { line: 'Family of five; Spanish at home.', college: 'Sinclair', tries: 'SNAP and meal plans for a big household' },
  Alex: { line: 'At Antioch; wants privacy above all.', college: 'Antioch', tries: 'export everything, then delete everything' },
  Keisha: { line: 'Moved to Atlanta mid-degree.', college: 'Wright State', tries: 'help found where she lives now, not where she started' },
};

export function seedDemo(a: Advocate): Student[] {
  const all = PERSONA_NAMES.map((n) => PERSONAS[n]!(a));
  // In the demonstration, Maria rides the bus and Jayden's class site is connected, so those features are live.
  a.setCommute('maria', { mode: 'bus', homeStop: 'salem-catalpa' });
  a.connectClassSite('jayden', 'lms-jayden');
  return all;
}
