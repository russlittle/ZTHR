import type { Advocate } from '../agents/advocate.js';
import type { Student } from '../domain/types.js';
import type { Gradebook, TranscriptCourse } from '../domain/academics.js';

/** Synthetic school records, so grades, standing, aid progress and degree progress have something real to show. */
const tc = (term: string, rows: [string, number, TranscriptCourse['grade']?][]): TranscriptCourse[] => rows.map(([course, credits, grade]) => ({ course, credits, term, ...(grade ? { grade } : {}) }));
const book = (course: string, credits: number, source: Gradebook['source'], categories: [string, number][], items: [string, string, number | undefined, number][]): Gradebook => ({
  course,
  credits,
  source,
  categories: categories.map(([name, weight]) => ({ name, weight })),
  items: items.map(([category, title, score, outOf]) => ({ category, title, ...(score !== undefined ? { score } : {}), outOf })),
});

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
    a.setAcademic(s.id, {
      programCredits: 60,
      transcript: [
        ...tc('Fall 2025', [['ENG 1101', 3, 'B'], ['PSY 1100', 3, 'B'], ['SCC 1101', 1, 'A'], ['MAT 1450', 4, 'W']]),
        ...tc('Spring 2026', [['ENG 1201', 3, 'C'], ['SOC 1101', 3, 'C'], ['COM 2211', 3, 'D']]),
        ...tc('Fall 2026', [['BIO 1111', 4], ['MAT 1130', 3], ['THE 1101', 3], ['COM 2211', 3]]),
      ],
      aid: { pell: 3697.5 },
      charges: 1700,
    });
    a.setGradebook(s.id, book('BIO 1111', 4, 'student', [['Exams', 40], ['Lab reports', 25], ['Quizzes', 15], ['Final exam', 20]], [['Exams', 'Exam 1', 74, 100], ['Exams', 'Exam 2', 69, 100], ['Exams', 'Exam 3', undefined, 100], ['Lab reports', 'Lab report 1', 22, 25], ['Lab reports', 'Lab report 2', 20, 25], ['Lab reports', 'Lab report 3', 23, 25], ['Lab reports', 'Lab report 4', 18, 25], ['Lab reports', 'Lab report 5', undefined, 25], ['Quizzes', 'Quiz 1', 8, 10], ['Quizzes', 'Quiz 2', 7, 10], ['Quizzes', 'Quiz 3', 9, 10], ['Quizzes', 'Quiz 4', 6, 10], ['Final exam', 'Final exam', undefined, 100]]));
    a.setGradebook(s.id, book('MAT 1130', 3, 'student', [['Homework', 20], ['Tests', 50], ['Final exam', 30]], [['Homework', 'Homework', 88, 100], ['Tests', 'Test 1', 81, 100], ['Tests', 'Test 2', 77, 100], ['Final exam', 'Final exam', undefined, 100]]));
    a.setGradebook(s.id, book('COM 2211', 3, 'student', [['Speeches', 60], ['Outlines', 15], ['Final speech', 25]], [['Speeches', 'Speech 1', 82, 100], ['Speeches', 'Speech 2', undefined, 100], ['Outlines', 'Outline 1', 13, 15], ['Final speech', 'Final speech', undefined, 100]]));
    a.setMoney(s.id, 300, [{ name: 'Rent', amount: 1050, dueDay: 1, kind: 'rent' }, { name: 'Electric', amount: 140, dueDay: 20, kind: 'utility' }], { amount: 400, next: '2026-11-05', everyDays: 14 });
    return s;
  },
  Jayden: (a) => {
    const s = withEnglish(a, a.createStudent({ id: 'jayden', chosenName: 'Jayden', zip: '45435', age: 19, household: { size: 1, monthlyGrossIncome: 900 }, enrollment: { college: 'wright-state', creditHours: 15, degreeSeeking: true, weeklyWorkHours: 12, workStudy: true } }));
    a.addClasses(s.id, [{ course: 'ENG 1101', days: ['Mon', 'Wed', 'Fri'], start: '10:10', end: '11:05', building: 'Millett Hall', room: '158' }, { course: 'CS 1180', days: ['Tue', 'Thu'], start: '09:30', end: '10:50', building: 'Russ Engineering', room: '154' }, { course: 'PSY 1010', days: ['Mon', 'Wed'], start: '13:25', end: '14:45', building: 'Fawcett Hall', room: '101' }]);
    a.setAcademic(s.id, { programCredits: 120, transcript: tc('Fall 2026', [['ENG 1101', 3], ['CS 1180', 3], ['PSY 1010', 3], ['MTH 1280', 4], ['UVC 1010', 2]]) });
    a.setGradebook(s.id, book('CS 1180', 3, 'class-site', [['Programming labs', 30], ['Projects', 30], ['Midterm', 15], ['Final exam', 25]], [['Programming labs', 'Labs 1 to 8', 74, 80], ['Projects', 'Project 1', 41, 50], ['Projects', 'Project 2', undefined, 50], ['Midterm', 'Midterm', 71, 100], ['Final exam', 'Final exam', undefined, 100]]));
    a.setGradebook(s.id, book('MTH 1280', 4, 'class-site', [['Homework', 15], ['Quizzes', 15], ['Exams', 45], ['Final exam', 25]], [['Homework', 'Homework', 52, 70], ['Quizzes', 'Quizzes', 31, 50], ['Exams', 'Exam 1', 62, 100], ['Exams', 'Exam 2', 58, 100], ['Final exam', 'Final exam', undefined, 100]]));
    a.addShifts(s.id, [{ date: '2026-11-02', start: '16:00', end: '19:00', employer: 'Library desk (work-study)' }, { date: '2026-11-04', start: '16:00', end: '19:00', employer: 'Library desk (work-study)' }, { date: '2026-11-06', start: '12:00', end: '18:00', employer: 'Library desk (work-study)' }]);
    return s;
  },
  Darnell: (a) => {
    const s = a.createStudent({ id: 'darnell', chosenName: 'Darnell', zip: '45402', age: 34, household: { size: 1, monthlyGrossIncome: 1600 }, enrollment: { college: 'sinclair', creditHours: 9, degreeSeeking: true, weeklyWorkHours: 40 } });
    a.seal(s.id, 'justice_involvement', 'synthetic sealed fact for the demonstration');
    return s;
  },
  Ana: (a) => a.createStudent({ id: 'ana', chosenName: 'Ana', zip: '45324', age: 31, dial: { depth: 'brief' } as Student['dial'], household: { size: 1, monthlyGrossIncome: 2400 }, enrollment: { college: 'wright-state', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 10 } }),
  Tyler: (a) => {
    const s = withEnglish(a, a.createStudent({ id: 'tyler', chosenName: 'Tyler', zip: '45385', age: 18, household: { size: 4, monthlyGrossIncome: 3400 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 22 } }));
    a.setAcademic(s.id, {
      program: 'sinclair-aa-sociology',
      transcript: [...tc('Spring 2026', [['ENG 1101', 3, 'B'], ['SOC 1101', 3, 'A'], ['MAT 1450', 4, 'C'], ['SCC 1101', 1, 'A']]), ...tc('Summer 2026', [['PSY 1100', 3, 'B']]), ...tc('Fall 2026', [['COM 2211', 3], ['ENG 1201', 3], ['BIO 1111', 4], ['LIT 2230', 3]])],
    });
    a.setGradebook(s.id, book('BIO 1111', 4, 'student', [['Exams', 40], ['Lab reports', 25], ['Quizzes', 15], ['Final exam', 20]], [['Exams', 'Exam 1', 88, 100], ['Exams', 'Exam 2', 81, 100], ['Lab reports', 'Lab reports 1 to 4', 86, 100], ['Quizzes', 'Quizzes', 33, 40], ['Final exam', 'Final exam', undefined, 100]]));
    return s;
  },
  Priya: (a) => {
    const s = withEnglish(a, a.createStudent({ id: 'priya', chosenName: 'Priya', zip: '45435', age: 20, enrollment: { college: 'wright-state', creditHours: 17 } }));
    a.setAcademic(s.id, {
      programCredits: 120,
      transcript: [
        ...tc('Fall 2025', [['CHM 1150', 4, 'A'], ['MTH 2240', 4, 'A'], ['BIO 1150', 4, 'B'], ['UVC 1010', 2, 'A']]),
        ...tc('Spring 2026', [['CHM 1160', 4, 'B'], ['MTH 2250', 4, 'A'], ['BIO 1070', 4, 'A'], ['PSY 1010', 3, 'A']]),
        ...tc('Fall 2026', [['CHM 1210', 4], ['ENG 1101', 3], ['BIO 1120', 4], ['MTH 2300', 3], ['CHM 1210L', 1]]),
      ],
    });
    a.setGradebook(s.id, book('CHM 1210', 4, 'class-site', [['Exams', 45], ['Problem sets', 20], ['Quizzes', 10], ['Final exam', 25]], [['Exams', 'Exam 1', 84, 100], ['Exams', 'Exam 2', 79, 100], ['Exams', 'Exam 3', undefined, 100], ['Problem sets', 'Problem sets 1 to 9', 171, 180], ['Quizzes', 'Quizzes', 44, 50], ['Final exam', 'Final exam', undefined, 100]]));
    a.setGradebook(s.id, book('MTH 2300', 3, 'class-site', [['Homework', 20], ['Midterms', 50], ['Final exam', 30]], [['Homework', 'Homework', 94, 100], ['Midterms', 'Midterm 1', 91, 100], ['Midterms', 'Midterm 2', 88, 100], ['Final exam', 'Final exam', undefined, 100]]));
    a.addClasses(s.id, [{ course: 'CHM 1210', days: ['Mon', 'Wed', 'Fri'], start: '08:00', end: '08:55', building: 'Oelman Hall', room: '109' }, { course: 'ENG 1101', days: ['Mon', 'Wed', 'Fri'], start: '10:10', end: '11:05', building: 'Millett Hall', room: '158' }, { course: 'BIO 1120', days: ['Mon', 'Wed'], start: '12:20', end: '13:15', building: 'Biological Sciences', room: '116' }, { course: 'MTH 2300', days: ['Tue', 'Thu'], start: '09:30', end: '10:50', building: 'Math and Microbiology', room: '025' }, { course: 'CHM 1210L', days: ['Tue'], start: '14:00', end: '16:50', building: 'Oelman Hall', room: '220' }]);
    return s;
  },
  Destiny: (a) => {
    const s = withEnglish(a, a.createStudent({ id: 'destiny', chosenName: 'Destiny', zip: '45435', age: 22, household: { size: 1, monthlyGrossIncome: 1500, monthlyEarnedIncome: 1500 }, enrollment: { college: 'wright-state', creditHours: 15, degreeSeeking: true, weeklyWorkHours: 24 } }));
    a.setAcademic(s.id, {
      programCredits: 120,
      transcript: [
        ...tc('Fall 2025', [['SOC 2000', 3, 'W'], ['PSY 1010', 3, 'B'], ['MTH 1280', 4, 'W'], ['COM 1010', 3, 'C'], ['UVC 1010', 1, 'A']]),
        ...tc('Spring 2026', [['ECO 2030', 3, 'W'], ['BIO 1050', 4, 'C'], ['HST 1200', 3, 'W'], ['ART 2140', 3, 'B']]),
        ...tc('Fall 2026', [['ENG 1101', 3], ['SOC 2000', 3], ['ACC 2010', 3], ['MTH 1280', 4]]),
      ],
      aid: { pell: 3697.5, subsidized: 1750 },
      charges: 5100,
      aidProbation: { term: 'Fall 2026', termGpa: 2.0, termPace: 67, planDue: '2026-11-13' },
    });
    a.setGradebook(s.id, book('ACC 2010', 3, 'student', [['Exams', 50], ['Homework', 20], ['Final exam', 30]], [['Exams', 'Exam 1', 64, 100], ['Exams', 'Exam 2', 58, 100], ['Homework', 'Homework', 61, 100], ['Final exam', 'Final exam', undefined, 100]]));
    a.setGradebook(s.id, book('SOC 2000', 3, 'student', [['Papers', 40], ['Quizzes', 30], ['Final exam', 30]], [['Papers', 'Paper 1', 85, 100], ['Quizzes', 'Quizzes', 70, 90], ['Final exam', 'Final exam', undefined, 100]]));
    a.addClasses(s.id, [{ course: 'ENG 1101', days: ['Mon', 'Wed', 'Fri'], start: '10:10', end: '11:05', building: 'Millett Hall', room: '158' }, { course: 'SOC 2000', days: ['Mon', 'Wed'], start: '13:25', end: '14:45', building: 'Allyn Hall', room: '224' }, { course: 'ACC 2010', days: ['Tue', 'Thu'], start: '11:00', end: '12:20', building: 'Rike Hall', room: '161' }]);
    a.addShifts(s.id, [{ date: '2026-11-02', start: '06:00', end: '09:30', employer: 'Coffee shop' }, { date: '2026-11-02', start: '17:00', end: '21:00', employer: 'Grocery' }, { date: '2026-11-03', start: '15:00', end: '21:00', employer: 'Grocery' }, { date: '2026-11-04', start: '06:00', end: '09:30', employer: 'Coffee shop' }, { date: '2026-11-06', start: '06:00', end: '09:30', employer: 'Coffee shop' }, { date: '2026-11-07', start: '10:00', end: '18:00', employer: 'Grocery' }]);
    return s;
  },
  Sam: (a) => withEnglish(a, a.createStudent({ id: 'sam', chosenName: 'Sam', pronouns: 'they/them', zip: '45402', age: 21, dial: { depth: 'walk-me-through', readingGrade: 6 } as Student['dial'], enrollment: { college: 'sinclair', creditHours: 9 } })),
  Linda: (a) => {
    const s = a.createStudent({ id: 'linda', chosenName: 'Linda', zip: '45417', age: 46, dial: { channel: 'text', depth: 'walk-me-through' } as Student['dial'], household: { size: 2, monthlyGrossIncome: 1400 }, enrollment: { college: 'sinclair', creditHours: 6, degreeSeeking: true, weeklyWorkHours: 20 } });
    // Back after a hard year caring for her mother: two withdrawals put her aid progress under the line.
    a.setAcademic(s.id, { programCredits: 60, transcript: [...tc('Spring 2026', [['ENG 1101', 3, 'W'], ['BIS 1120', 3, 'W'], ['SCC 1101', 1, 'A']]), ...tc('Summer 2026', [['PSY 1100', 3, 'B']]), ...tc('Fall 2026', [['ENG 1101', 3], ['BIS 1120', 3]])] });
    return s;
  },
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
