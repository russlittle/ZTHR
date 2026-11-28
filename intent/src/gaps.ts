/**
 * Gap checks: what is missing, found by mechanism. Decision tables are checked for completeness and overlap,
 * flows for states with no way in or out, and the frame for the pairings every intent needs. Each gap is a
 * question that names what it protects.
 */
import type { Question, Statement } from './frame.ts';

// ---------------------------------------------------------------- Decision tables

/** A test on one condition: a value, a comparison on a number, a range, or any. */
export type Test = string;

export interface DecisionTable {
  readonly id: string;
  readonly conditions: readonly { readonly name: string; readonly values?: readonly string[]; readonly numeric?: true }[];
  readonly rows: readonly { readonly when: Readonly<Record<string, Test>>; readonly then: string }[];
}

const num = (s: string) => Number(s.replace(/[$,]/g, ''));

/** Whether a value satisfies a test. Numbers: "<700", "<=700", ">700", ">=700", "700..899", "700"; text: exact; "*" or absent: any. */
export function satisfies(test: Test | undefined, value: string | number): boolean {
  if (test === undefined || test === '*') return true;
  if (typeof value === 'string') return test === value;
  let m: RegExpExecArray | null;
  if ((m = /^(<=|>=|<|>)\s*(.+)$/.exec(test))) {
    const b = num(m[2] ?? '');
    return m[1] === '<' ? value < b : m[1] === '<=' ? value <= b : m[1] === '>' ? value > b : value >= b;
  }
  if ((m = /^(.+?)\.\.(.+)$/.exec(test))) return value >= num(m[1] ?? '') && value <= num(m[2] ?? '');
  return value === num(test);
}

/** The points that decide every numeric test in a column: each boundary, just below and just above it. */
function probes(table: DecisionTable, name: string): number[] {
  const bounds = new Set<number>();
  for (const r of table.rows) {
    const t = r.when[name];
    if (!t || t === '*') continue;
    for (const n of t.match(/-?\$?[\d,]+(?:\.\d+)?/g) ?? []) bounds.add(num(n));
  }
  const pts = new Set<number>();
  for (const b of bounds) [b - 0.01, b, b + 0.01].forEach((p) => pts.add(Math.round(p * 100) / 100));
  if (bounds.size === 0) pts.add(0);
  return [...pts].sort((a, b) => a - b);
}

const show = (v: string | number) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v);

/** Every case no row covers, and every case two rows cover with different results. */
export function checkTable(table: DecisionTable, limit = 100_000): Question[] {
  const axes = table.conditions.map((c) => (c.numeric ? probes(table, c.name) : [...(c.values ?? [])]));
  const size = axes.reduce((n, a) => n * Math.max(a.length, 1), 1);
  if (size > limit)
    return [{ id: `${table.id}:too-large`, origin: 'completeness', text: `The rules for ${table.id} have too many cases to check one by one (${size}). Can they be split?`, protects: 'that every case has an answer', consequence: 'high' }];
  const out: Question[] = [];
  const known = [...new Set(table.rows.map((r) => r.then))];
  const seenGap = new Set<string>();
  const seenOverlap = new Set<string>();
  const walk = (i: number, picked: (string | number)[]) => {
    if (i === axes.length) {
      const matches = table.rows.filter((r) => table.conditions.every((c, k) => satisfies(r.when[c.name], picked[k]!)));
      const desc = table.conditions.map((c, k) => `${c.name} is ${show(picked[k]!)}`).join(' and ');
      if (matches.length === 0 && !seenGap.has(desc)) {
        seenGap.add(desc);
        out.push({ id: `${table.id}:gap${seenGap.size}`, origin: 'completeness', text: `What should happen when ${desc}? No rule covers it.`, answer: { kind: 'single', options: known, other: true }, protects: 'that every case has an answer', consequence: 'high' });
      }
      const results = [...new Set(matches.map((r) => r.then))];
      if (results.length > 1) {
        const key = results.join('|');
        if (!seenOverlap.has(key)) {
          seenOverlap.add(key);
          out.push({ id: `${table.id}:overlap${seenOverlap.size}`, origin: 'overlap', text: `When ${desc}, two rules disagree. Which should apply?`, choices: results, answer: { kind: 'single', options: results, other: true }, protects: 'that every case has one answer', consequence: 'high' });
        }
      }
      return;
    }
    for (const v of axes[i]!) walk(i + 1, [...picked, v]);
  };
  walk(0, []);
  return out;
}

// ---------------------------------------------------------------- State machines

export interface Flow {
  readonly id: string;
  readonly initial: string;
  readonly states: readonly string[];
  readonly final: readonly string[];
  readonly transitions: readonly { readonly from: string; readonly to: string; readonly on: string; readonly by?: string }[];
}

/** States nothing reaches, states with no way on, and steps nobody owns. */
export function checkFlow(flow: Flow): Question[] {
  const out: Question[] = [];
  const actors = [...new Set(flow.transitions.flatMap((t) => (t.by ? [t.by] : [])))];
  const reach = new Set([flow.initial]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of flow.transitions)
      if (reach.has(t.from) && !reach.has(t.to)) {
        reach.add(t.to);
        grew = true;
      }
  }
  for (const s of flow.states) {
    if (!reach.has(s)) out.push({ id: `${flow.id}:unreachable:${s}`, origin: 'state', text: `How does someone get to "${s}"? Nothing leads there.`, answer: { kind: 'single', options: [...flow.states.filter((x) => x !== s).map((x) => `from "${x}"`), 'it is not needed'], other: true }, protects: 'that every step can be reached', consequence: 'medium' });
    if (!flow.final.includes(s) && !flow.transitions.some((t) => t.from === s))
      out.push({ id: `${flow.id}:dead-end:${s}`, origin: 'state', text: `What happens after "${s}"? There is no way on from it.`, answer: { kind: 'single', options: [...flow.states.filter((x) => x !== s).map((x) => `it goes on to "${x}"`), 'it is a final step'], other: true }, protects: 'that nobody is left stuck', consequence: 'high' });
  }
  for (const t of flow.transitions)
    if (!t.by) out.push({ id: `${flow.id}:owner:${t.from}->${t.to}`, origin: 'state', text: `Who moves things from "${t.from}" to "${t.to}" when ${t.on}?`, ...(actors.length ? { answer: { kind: 'single' as const, options: actors, other: true as const } } : {}), protects: 'that every step has someone responsible for it', consequence: 'medium' });
  return out;
}

// ---------------------------------------------------------------- Pairings

/** The measure an outcome's target becomes: achieved in use, by the people it serves. */
export const achievedText = (outcome: string): string => `Achieved in use: ${outcome}`;

/** The pairings every intent needs: a problem, an outcome, a measure for each outcome, a tolerance for each measure. */
export function checkPairings(statements: readonly Statement[]): Question[] {
  const has = (slot: Statement['slot']) => statements.some((s) => s.slot === slot);
  const out: Question[] = [];
  if (!has('problem')) out.push({ id: 'pair:problem', origin: 'missing', slot: 'problem', text: 'What is going wrong today that this should fix, and for whom?', protects: 'building the right thing at all', consequence: 'high' });
  if (!has('outcome')) out.push({ id: 'pair:outcome', origin: 'missing', slot: 'outcome', text: 'When this works, what will be true that is not true now?', protects: 'what counts as done', consequence: 'high' });
  if (has('outcome') && !has('measures')) out.push({ id: 'pair:measure', origin: 'missing', slot: 'measures', text: 'How will you know it worked?', protects: 'how anyone will know it worked', consequence: 'high' });
  for (const m of statements.filter((s) => s.slot === 'measures' && !s.tolerance))
    out.push({ id: `pair:tolerance:${m.id}`, origin: 'pairing', slot: 'measures', text: `How close is close enough for "${m.text}"?`, tolerates: m.text, answer: { kind: 'single', options: ['every time', 'nine times in ten', 'most of the time'], other: true, recommended: 'nine times in ten' }, protects: 'that the measure can pass or fail', consequence: 'medium' });
  // Every outcome is judged in use against a target set now, before anything is built: what share of the people it
  // serves must achieve it for it to count. Set after the fact, a target bends to fit what happened.
  for (const o of statements.filter((s) => s.slot === 'outcome'))
    if (!statements.some((s) => s.slot === 'measures' && s.text === achievedText(o.text)))
      out.push({ id: `pair:achieved:${o.id}`, origin: 'pairing', slot: 'measures', text: `For "${o.text}": what share of the people it serves must achieve it, for it to count as working?`, tolerates: achievedText(o.text), answer: { kind: 'single', options: ['every one', 'nine in ten people', 'eight in ten people'], other: true, recommended: 'nine in ten people' }, protects: 'that the outcome is judged against a target set before it is built, not after', consequence: 'high' });
  for (const i of statements.filter((s) => s.slot === 'implications' && s.supplied.kind === 'derived' && s.supplied.rule === 'irreversible'))
    out.push({ id: `pair:confirm:${i.id}`, origin: 'pairing', slot: 'constraints', text: `Before "${i.words ?? 'this'}" happens, who confirms it?`, protects: 'that nothing irreversible happens by accident', consequence: 'high' });
  return out;
}
