import { COLLEGES } from './colleges.js';

/**
 * College explained (PRD DAY-5). Plain meanings of the words colleges use,
 * plus where to ask. Exact rules differ by college, so every answer points to
 * the office that decides.
 */
export interface Term {
  term: string;
  match: RegExp;
  meaning: string;
  ask: string;
}

export const TERMS: Term[] = [
  { term: 'registrar', match: /\bregistrar\b/i, meaning: 'The registrar is the office that keeps your class schedule, grades and transcript. They handle adding and dropping classes.', ask: 'the Registrar' },
  { term: 'bursar', match: /\b(bursar|student accounts?|tuition bill)\b/i, meaning: 'The bursar, or student accounts, is the office that bills you and takes payments. They can set up a payment plan.', ask: 'Student Accounts' },
  { term: 'drop', match: /\b(drop (a )?class|dropping)\b/i, meaning: 'Dropping a class early in the term usually removes it from your record. There is a last day to drop, and after that it becomes a withdrawal.', ask: 'the Registrar or your advisor' },
  { term: 'withdraw', match: /\bwithdraw(al)?\b/i, meaning: 'Withdrawing means leaving a class after the drop deadline. It usually shows as a W, does not change your GPA, and can affect financial aid. Talk to financial aid first.', ask: 'Financial Aid and your advisor' },
  { term: 'credit hour', match: /\bcredit hours?\b/i, meaning: 'A credit hour is how colleges count class time. A 3-credit class usually meets about three hours a week. Twelve credits is full-time.', ask: 'your advisor' },
  { term: 'prerequisite', match: /\bprereq(uisite)?s?\b/i, meaning: 'A prerequisite is a class you must pass before you can take another one.', ask: 'your advisor' },
  { term: 'office hours', match: /\boffice hours\b/i, meaning: 'Office hours are times your instructor sets aside to help students. You do not need to be in trouble to go. It is one of the best ways to get help.', ask: 'your instructor' },
  { term: 'SAP', match: /\b(SAP|satisfactory academic progress)\b/, meaning: 'Satisfactory Academic Progress is the grade and class-completion standard for keeping financial aid. If you fall below it, you can usually appeal.', ask: 'Financial Aid' },
  { term: 'FAFSA', match: /\bwhat is (the )?fafsa\b/i, meaning: 'The FAFSA is the free form for federal financial aid, like Pell Grants. You fill it out every year. I can walk you through it.', ask: 'Financial Aid' },
  { term: 'Pell Grant', match: /\bpell\b/i, meaning: 'A Pell Grant is federal money for college that you do not pay back. Your FAFSA decides if you qualify.', ask: 'Financial Aid' },
  { term: 'transcript', match: /\btranscript\b/i, meaning: 'A transcript is the official record of your classes and grades.', ask: 'the Registrar' },
  { term: 'GPA', match: /\b(gpa|grade point)\b/i, meaning: 'GPA is your grade point average: your grades turned into numbers and averaged, on a 4.0 scale.', ask: 'your advisor' },
  { term: 'advisor', match: /\badvis(o|e)r\b/i, meaning: 'An advisor helps you pick classes and plan your path to finishing. Meeting each term helps you avoid surprises.', ask: 'Advising' },
];

/** Each college's website, from control/colleges. */
export const COLLEGE_SITES: Record<string, string> = Object.fromEntries(COLLEGES.map((c) => [c.college, c.website]));

export function explain(question: string): Term | undefined {
  return TERMS.find((t) => t.match.test(question));
}
