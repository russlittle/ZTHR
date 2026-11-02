import type { Advocate } from '../agents/advocate.js';
import type { Student } from '../domain/types.js';

/** Twelve synthetic students for the demonstration build. None is a real person. */
export function seedDemo(a: Advocate): Student[] {
  const add = (p: Parameters<Advocate['createStudent']>[0]) => a.createStudent(p);
  const maria = add({ chosenName: 'Maria', zip: '45417', age: 27, household: { size: 3, monthlyGrossIncome: 2100, monthlyEarnedIncome: 2100, childrenUnder6: 1, childrenUnder12: 2, singleParent: true }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 30, workStudy: false } });
  a.addClasses(maria.id, [{ course: 'BIO 1111', days: ['Mon', 'Wed'], start: '09:00', end: '10:50', building: 'Building 3', room: '212' }, { course: 'MAT 1130', days: ['Tue', 'Thu'], start: '12:30', end: '13:45', building: 'Building 7', room: '101' }]);
  a.addShifts(maria.id, [{ date: '2026-11-03', start: '15:00', end: '23:00', employer: 'Care center' }, { date: '2026-11-05', start: '15:00', end: '23:00', employer: 'Care center' }]);
  a.addDeadline(maria.id, { title: 'Lab report 5', course: 'BIO 1111', due: '2026-11-06', kind: 'assignment', effortHours: 4, source: { type: 'syllabus', line: 'Nov 6 Lab report 5 due' }, confirmed: true });
  a.setMoney(maria.id, 300, [{ name: 'Rent', amount: 1050, dueDay: 1, kind: 'rent' }, { name: 'Electric', amount: 140, dueDay: 20, kind: 'utility' }], { amount: 400, next: '2026-11-05', everyDays: 14 });

  const jayden = add({ chosenName: 'Jayden', zip: '45435', age: 19, household: { size: 1, monthlyGrossIncome: 900 }, enrollment: { college: 'wright-state', creditHours: 15, degreeSeeking: true, weeklyWorkHours: 12, workStudy: true } });
  const darnell = add({ chosenName: 'Darnell', zip: '45402', age: 34, household: { size: 1, monthlyGrossIncome: 1600 }, enrollment: { college: 'sinclair', creditHours: 9, degreeSeeking: true, weeklyWorkHours: 40 } });
  a.seal(darnell.id, 'justice_involvement', 'synthetic sealed fact for the demonstration');
  const ana = add({ chosenName: 'Ana', zip: '45324', age: 31, dial: { depth: 'brief' } as Student['dial'], household: { size: 1, monthlyGrossIncome: 2400 }, enrollment: { college: 'wright-state', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 10 } });
  const tyler = add({ chosenName: 'Tyler', zip: '45385', age: 18, household: { size: 4, monthlyGrossIncome: 3400 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 22 } });
  const priya = add({ chosenName: 'Priya', zip: '45435', age: 20, enrollment: { college: 'wright-state', creditHours: 17 } });
  const destiny = add({ chosenName: 'Destiny', zip: '45435', age: 22, household: { size: 1, monthlyGrossIncome: 1500, monthlyEarnedIncome: 1500 }, enrollment: { college: 'wright-state', creditHours: 15, degreeSeeking: true, weeklyWorkHours: 24 } });
  const sam = add({ chosenName: 'Sam', pronouns: 'they/them', zip: '45402', age: 21, dial: { depth: 'walk-me-through', readingGrade: 6 } as Student['dial'], enrollment: { college: 'sinclair', creditHours: 9 } });
  const linda = add({ chosenName: 'Linda', zip: '45417', age: 46, dial: { channel: 'text', depth: 'walk-me-through' } as Student['dial'], household: { size: 2, monthlyGrossIncome: 1400 }, enrollment: { college: 'sinclair', creditHours: 6, degreeSeeking: true, weeklyWorkHours: 20 } });
  const luis = add({ chosenName: 'Luis', zip: '45403', age: 19, household: { size: 5, monthlyGrossIncome: 3900 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 15 } });
  const alex = add({ chosenName: 'Alex', pronouns: 'they/them', zip: '45387', age: 20, enrollment: { college: 'antioch', creditHours: 15 } });
  const keisha = add({ chosenName: 'Keisha', zip: '30310', county: 'Fulton', age: 25, enrollment: { college: 'wright-state', creditHours: 6 } });
  for (const s of [priya, sam, jayden, tyler, destiny]) {
    a.uploadSyllabus(s.id, 'ENG 1101', `Use of AI: Generative AI may not be used to write graded work unless you disclose it.\nTue Nov 4 - Essay 2 draft due\nThursday, November 6: Essay 2 final due\n11/18 Quiz on rhetorical appeals`, '2026-08-24');
    a.confirmDeadlines(s.id, 'all');
  }
  return [maria, jayden, darnell, ana, tyler, priya, destiny, sam, linda, luis, alex, keisha];
}
