/**
 * The structural diff: two independent readings of the same intent, compared field by field. What both say is
 * kept; every difference becomes one question showing both readings. No model judges whether they agree.
 */
import type { Consequence, Question, Reading, Slot, Statement } from './frame.ts';

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'is', 'are', 'be', 'it', 'that', 'their', 'they', 'with', 'so', 'not', 'get', 'getting']);

/** The words that carry meaning, for comparing two phrasings deterministically. */
export function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/(\w)-(\w)/g, '$1$2')
      .replace(/[^a-z0-9$%\s]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
      .filter((w) => w && !STOP.has(w)),
  );
}

/** Two phrasings agree when most of their meaning-carrying words are shared. */
export function same(a: string, b: string, threshold = 0.6): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 && y.size === 0) return true;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.max(x.size, y.size) >= threshold;
}

const WEIGHT: Record<Slot, Consequence> = {
  problem: 'high',
  why: 'high',
  outcome: 'high',
  measures: 'high',
  constraints: 'high',
  people: 'medium',
  nonGoals: 'medium',
  prerequisites: 'medium',
  implications: 'medium',
  assumptions: 'low',
};

const PROTECTS: Record<Slot, string> = {
  problem: 'building the right thing at all',
  why: 'choosing between ways of meeting it',
  outcome: 'what counts as done',
  measures: 'how anyone will know it worked',
  constraints: 'what must always or never happen',
  people: 'who it is built for, and who else it reaches',
  nonGoals: 'what is left out on purpose',
  prerequisites: 'what must exist first',
  implications: 'who and what else it affects',
  assumptions: 'what is taken as given',
};

export interface DiffResult {
  readonly agreed: Statement[];
  readonly questions: Question[];
}

/** Compare two readings from different families. Families must differ, or there is nothing independent to compare. */
export function diffReadings(a: Reading, b: Reading): DiffResult {
  if (a.family === b.family) throw new Error(`both readings are from ${a.family}; two families are required`);
  const families = [a.family, b.family];
  const agreed: Statement[] = [];
  const questions: Question[] = [];
  let n = 0;
  const ask = (slot: Slot, text: string, choices: string[]) => questions.push({ id: `D${++n}`, origin: 'diff', slot, text, choices, protects: PROTECTS[slot], consequence: WEIGHT[slot] });
  const keep = (slot: Slot, text: string, tolerance?: string) =>
    agreed.push({ id: `P${agreed.length + 1}`, slot, text, state: 'assumed', supplied: { kind: 'parse', families }, ...(tolerance === undefined ? {} : { tolerance }) });

  const single = (slot: Slot, x: string, y: string, ask_: string) => {
    if (!x.trim() && !y.trim()) return;
    if (same(x, y)) keep(slot, x.trim() ? x : y);
    else ask(slot, ask_, [x, y].filter((s) => s.trim()));
  };
  single('problem', a.problem, b.problem, 'Which of these is the problem you want solved?');
  single('why', a.why, b.why, 'What are you ultimately trying to achieve?');

  // Items only one reading found are asked together, one tap each, rather than one question per item.
  const lists = (slot: Slot, xs: readonly string[], ys: readonly string[], noun: string) => {
    const used = new Set<number>();
    const only: string[] = [];
    for (const x of xs) {
      const j = ys.findIndex((y, k) => !used.has(k) && same(x, y));
      if (j >= 0) {
        used.add(j);
        keep(slot, x);
      } else only.push(x);
    }
    ys.forEach((y, k) => {
      if (!used.has(k)) only.push(y);
    });
    if (only.length)
      questions.push({ id: `D${++n}`, origin: 'diff', slot, text: `Which of these are ${noun}? Pick any that apply.`, choices: only, answer: { kind: 'multi', options: only, other: true }, protects: PROTECTS[slot], consequence: WEIGHT[slot] });
  };
  lists('outcome', a.outcomes, b.outcomes, 'outcomes');
  lists('constraints', a.constraints, b.constraints, 'things that must always or never happen');
  lists('nonGoals', a.nonGoals, b.nonGoals, 'things deliberately left out');
  lists(
    'people',
    a.people.map((p) => `${p.name} (${p.side === 'primary' ? 'who it is for' : 'on the other side'})`),
    b.people.map((p) => `${p.name} (${p.side === 'primary' ? 'who it is for' : 'on the other side'})`),
    'people involved',
  );

  // Measures agree when they measure the same thing; a differing tolerance is its own question.
  const used = new Set<number>();
  const onlyMeasures: string[] = [];
  for (const m of a.measures) {
    const j = b.measures.findIndex((y, k) => !used.has(k) && same(m.text, y.text));
    if (j < 0) {
      onlyMeasures.push(`${m.text} (${m.tolerance})`);
      continue;
    }
    used.add(j);
    const other = b.measures[j]!;
    if (same(m.tolerance, other.tolerance, 0.99)) keep('measures', m.text, m.tolerance);
    else questions.push({ id: `D${++n}`, origin: 'diff', slot: 'measures', text: `How strict should "${m.text}" be?`, choices: [m.tolerance, other.tolerance], tolerates: m.text, protects: PROTECTS.measures, consequence: WEIGHT.measures });
  }
  b.measures.forEach((m, k) => {
    if (!used.has(k)) onlyMeasures.push(`${m.text} (${m.tolerance})`);
  });
  if (onlyMeasures.length)
    questions.push({ id: `D${++n}`, origin: 'diff', slot: 'measures', text: 'Which of these should measure success? Pick any that apply.', choices: onlyMeasures, answer: { kind: 'multi', options: onlyMeasures, other: true }, protects: PROTECTS.measures, consequence: WEIGHT.measures });

  return { agreed, questions };
}
