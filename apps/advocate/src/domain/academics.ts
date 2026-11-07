/**
 * Grades, standing and financial-aid progress (Phase 5: stay enrolled). Everything here is a published rule applied
 * to the student's own record: the syllabus's weights, the college's standing policy, and the federal Satisfactory
 * Academic Progress regulation (34 CFR 668.34) as each college sets its thresholds. No model decides any of it, and
 * anything a policy does not state is reported as not stated rather than guessed.
 */

export type Letter = 'A' | 'B' | 'C' | 'D' | 'F' | 'W' | 'I' | 'P' | 'TR';

/** One course on the record, finished or in progress. */
export interface TranscriptCourse {
  course: string;
  credits: number;
  grade?: Letter; // absent while in progress
  term: string; // "Fall 2025"
  repeat?: boolean;
  remedial?: boolean;
}

/** A graded category from the syllabus ("Exams 40%"), and the work in it. */
export interface GradeCategory {
  name: string;
  weight: number; // percent of the course grade
}
export interface GradeItem {
  category: string;
  title: string;
  score?: number; // absent until graded
  outOf: number;
}
export interface Gradebook {
  course: string;
  credits: number;
  categories: GradeCategory[];
  items: GradeItem[];
  /** Where the grades came from: the class site, or the student typing them. */
  source: 'class-site' | 'student';
  /** Lowest percent for each letter; the common 90/80/70/60 scale unless the syllabus says otherwise. */
  scale?: { A: number; B: number; C: number; D: number };
}

export const DEFAULT_SCALE = { A: 90, B: 80, C: 70, D: 60 } as const;
const POINTS: Partial<Record<Letter, number>> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
const round = (x: number, places = 2) => Math.round(x * 10 ** places) / 10 ** places;

/** Weights read from syllabus lines like "Exams 40%", "Homework: 25 %", "Final exam - 20%". */
export function parseWeights(text: string): GradeCategory[] {
  const out: GradeCategory[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*•]?\s*([A-Za-z][A-Za-z /&'-]{1,40}?)\s*[:\-–]?\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/);
    if (m && !/\b(attendance policy|late|penalty|ai)\b/i.test(m[1]!)) out.push({ name: m[1]!.trim(), weight: Number(m[2]) });
  }
  const total = out.reduce((n, c) => n + c.weight, 0);
  return total >= 99 && total <= 101 ? out : [];
}

export function letterFor(percent: number, scale: Gradebook['scale'] = DEFAULT_SCALE): Letter {
  const s = scale ?? DEFAULT_SCALE;
  return percent >= s.A ? 'A' : percent >= s.B ? 'B' : percent >= s.C ? 'C' : percent >= s.D ? 'D' : 'F';
}

/**
 * The course grade so far: each category's percent on the graded work, weighted by the syllabus and renormalised
 * over the categories that have any graded work. Undefined until something is graded.
 */
export function currentGrade(g: Gradebook): { percent: number; letter: Letter; graded: number } | undefined {
  let w = 0;
  let sum = 0;
  for (const c of g.categories) {
    const items = g.items.filter((i) => i.category === c.name && i.score !== undefined);
    if (!items.length) continue;
    const pct = (items.reduce((n, i) => n + i.score!, 0) / items.reduce((n, i) => n + i.outOf, 0)) * 100;
    sum += pct * c.weight;
    w += c.weight;
  }
  if (!w) return undefined;
  const percent = round(sum / w, 1);
  return { percent, letter: letterFor(percent, g.scale), graded: w };
}

/**
 * What the student needs on the remaining work in one category (usually the final) to finish with a letter,
 * assuming every other category ends where it is now. Impossible above 100% and guaranteed at or below 0%.
 */
export function neededFor(g: Gradebook, category: string, target: Exclude<Letter, 'W' | 'I' | 'P' | 'TR' | 'F'>): { needed: number; possible: boolean; already: boolean } | undefined {
  const cat = g.categories.find((c) => c.name.toLowerCase() === category.toLowerCase());
  if (!cat) return undefined;
  const scale = g.scale ?? DEFAULT_SCALE;
  const goal = scale[target];
  let fixed = 0;
  let fixedW = 0;
  for (const c of g.categories) {
    if (c.name === cat.name) continue;
    const items = g.items.filter((i) => i.category === c.name && i.score !== undefined);
    if (!items.length) continue;
    fixed += ((items.reduce((n, i) => n + i.score!, 0) / items.reduce((n, i) => n + i.outOf, 0)) * 100) * c.weight;
    fixedW += c.weight;
  }
  // Graded work already in the category counts at its share of the category's points.
  const inCat = g.items.filter((i) => i.category === cat.name);
  const done = inCat.filter((i) => i.score !== undefined);
  const left = inCat.filter((i) => i.score === undefined);
  const totalPts = inCat.reduce((n, i) => n + i.outOf, 0) || 100;
  const leftPts = left.reduce((n, i) => n + i.outOf, 0) || (done.length ? 0 : totalPts);
  if (!leftPts) return undefined;
  const W = fixedW + cat.weight;
  // goal = (fixed + cat.weight * (donePts + x*leftPts)/totalPts*100) / W   → solve for x (fraction of the remaining points)
  const donePts = done.reduce((n, i) => n + i.score!, 0);
  const x = ((goal * W - fixed) / cat.weight / 100) * totalPts - donePts;
  const needed = round((x / leftPts) * 100, 1);
  return { needed: Math.max(0, needed), possible: needed <= 100, already: needed <= 0 };
}

/** Grade point average over graded credits; W, I, P and transfer credit carry no points. Repeats: the latest counts. */
export function gpa(courses: TranscriptCourse[]): { gpa: number | undefined; graded: number; points: number } {
  const latest = new Map<string, TranscriptCourse>();
  for (const c of courses) if (c.grade && POINTS[c.grade] !== undefined && !c.remedial) latest.set(c.course, c);
  let graded = 0;
  let points = 0;
  for (const c of latest.values()) {
    graded += c.credits;
    points += POINTS[c.grade!]! * c.credits;
  }
  return { gpa: graded ? round(points / graded, 2) : undefined, graded, points };
}

/** Credits attempted and earned for pace. Attempted counts W, F, I, repeats and transfer; earned counts passes and transfer. */
export function pace(courses: TranscriptCourse[]): { attempted: number; earned: number; rate: number | undefined } {
  const done = courses.filter((c) => c.grade);
  const attempted = done.reduce((n, c) => n + c.credits, 0);
  const earned = done.filter((c) => ['A', 'B', 'C', 'D', 'P', 'TR'].includes(c.grade!)).reduce((n, c) => n + c.credits, 0);
  return { attempted, earned, rate: attempted ? round((earned / attempted) * 100, 2) : undefined };
}

/** A college's standing and aid-progress rules, as it publishes them. */
export interface AcademicPolicy {
  standing: {
    kind: 'consecutive-term' | 'cumulative-after-hours';
    goodGpa: number;
    /** cumulative-after-hours: probation when the cumulative GPA is under goodGpa after this many attempted hours. */
    afterHours?: number;
    /** consecutive-term: the names of the first, second and third consecutive terms under goodGpa. */
    ladder?: string[];
    source: string;
  };
  sap: {
    gpa: number;
    pace: number; // percent
    maxTimeframe: number; // multiple of program length
    evaluated: string; // as the policy says it
    appeal?: { opens: string; closes: string; term: string }[];
    statuses: string;
    source: string;
  };
}

export type Standing = { status: 'good' | 'watch' | 'probation' | 'action' | 'not-enough-record'; label: string; why: string };

/** Academic standing under the college's own rule. */
export function standing(courses: TranscriptCourse[], p: AcademicPolicy['standing']): Standing {
  const g = gpa(courses);
  if (g.gpa === undefined) return { status: 'not-enough-record', label: 'No grades yet', why: 'Standing starts once a term has grades.' };
  if (p.kind === 'cumulative-after-hours') {
    const att = pace(courses).attempted;
    if (g.gpa >= p.goodGpa) return { status: 'good', label: 'Good standing', why: `Your GPA is ${g.gpa.toFixed(2)}; the line is ${p.goodGpa.toFixed(1)}.` };
    if (att < (p.afterHours ?? 0)) return { status: 'watch', label: 'Below the line, not yet counted', why: `Your GPA is ${g.gpa.toFixed(2)}. Probation starts once you have ${p.afterHours} attempted hours; you have ${att}.` };
    return { status: 'probation', label: 'Academic probation', why: `Your GPA is ${g.gpa.toFixed(2)}, under ${p.goodGpa.toFixed(1)} after ${att} attempted hours. Raising it to ${p.goodGpa.toFixed(1)} ends probation.` };
  }
  // consecutive-term: count terms in a row (most recent first) whose term GPA is under the line.
  const terms = [...new Set(courses.filter((c) => c.grade).map((c) => c.term))];
  const order = (t: string) => {
    const [season, year] = t.split(' ');
    return Number(year) * 10 + ({ Spring: 1, Summer: 2, Fall: 3 }[season as 'Spring'] ?? 0);
  };
  terms.sort((x, y) => order(y) - order(x));
  let run = 0;
  for (const t of terms) {
    const tg = gpa(courses.filter((c) => c.term === t)).gpa;
    if (tg !== undefined && tg < p.goodGpa) run++;
    else break;
  }
  const ladder = p.ladder ?? [];
  if (!run) return { status: 'good', label: 'Good standing', why: `Your cumulative GPA is ${g.gpa.toFixed(2)}; the line is ${p.goodGpa.toFixed(1)}.` };
  const step = ladder[Math.min(run, ladder.length) - 1] ?? 'Below the line';
  return { status: run >= 3 ? 'action' : run === 2 ? 'probation' : 'watch', label: step, why: `${run} term${run === 1 ? '' : 's'} in a row under a ${p.goodGpa.toFixed(1)} term GPA, and a cumulative GPA of ${g.gpa.toFixed(2)}. ${g.gpa >= p.goodGpa ? 'Another term at a 2.0 or better keeps this from going further.' : `A cumulative ${p.goodGpa.toFixed(1)} returns you to good standing.`}` };
}

export interface SapResult {
  meets: boolean;
  checks: { rule: 'gpa' | 'pace' | 'max-timeframe'; label: string; value: number | undefined; need: number; meets: boolean | undefined; unit: string }[];
  attempted: number;
  earned: number;
  maxAttempted: number | undefined;
}

/** Satisfactory Academic Progress: every federal measure, at the college's thresholds. */
export function sap(courses: TranscriptCourse[], policy: AcademicPolicy['sap'], programCredits?: number): SapResult {
  const g = gpa(courses);
  const p = pace(courses);
  const max = programCredits ? Math.floor(programCredits * policy.maxTimeframe) : undefined;
  const checks: SapResult['checks'] = [
    { rule: 'gpa', label: 'Cumulative GPA', value: g.gpa, need: policy.gpa, meets: g.gpa === undefined ? undefined : g.gpa >= policy.gpa, unit: '' },
    { rule: 'pace', label: 'Credits completed of credits attempted', value: p.rate, need: policy.pace, meets: p.rate === undefined ? undefined : p.rate >= policy.pace, unit: '%' },
    { rule: 'max-timeframe', label: 'Credits attempted, of the most aid will cover', value: p.attempted, need: max ?? 0, meets: max === undefined ? undefined : p.attempted <= max, unit: '' },
  ];
  return { meets: checks.every((c) => c.meets !== false), checks, attempted: p.attempted, earned: p.earned, maxAttempted: max };
}

/** What the record would look like if the in-progress courses ended as given (grade, or W for a withdrawal). */
export function project(courses: TranscriptCourse[], outcome: Record<string, Letter>): TranscriptCourse[] {
  return courses.map((c) => (!c.grade && outcome[c.course] ? { ...c, grade: outcome[c.course] } : c));
}

/** In-progress courses' current letters from their gradebooks, for "if the term ended today". */
export function asOfToday(courses: TranscriptCourse[], books: Gradebook[]): Record<string, Letter> {
  const out: Record<string, Letter> = {};
  for (const c of courses.filter((x) => !x.grade)) {
    const b = books.find((x) => x.course === c.course);
    const cg = b ? currentGrade(b) : undefined;
    if (cg) out[c.course] = cg.letter;
  }
  return out;
}
