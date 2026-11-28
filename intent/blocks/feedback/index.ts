/**
 * From "something is wrong" to a defect a machine can fix. A problem report keeps the person's own words and
 * attaches context they would never think to give (the screen, the version, the trace id, the last errors),
 * redacted before it is stored. Similar reports are grouped so one cause gets one ticket with a count. The triage
 * board orders by severity and age against response targets. A triaged report becomes a defect with steps, expected
 * and actual, and a failing test skeleton, because in this factory a defect is fixed by first writing the test that
 * shows it.
 */

export interface Report {
  readonly id: number;
  readonly who: string;
  readonly said: string;
  readonly at: string;
  readonly context: { readonly surface?: string; readonly version?: string; readonly trace?: string; readonly errors?: readonly string[]; readonly agent?: string };
  group?: number;
}

export type Severity = 'blocker' | 'major' | 'minor' | 'cosmetic';

export interface Ticket {
  readonly id: number;
  title: string;
  severity?: Severity;
  column: 'new' | 'triaged' | 'in progress' | 'fixed' | 'wont fix';
  readonly reports: number[];
  readonly opened: string;
}

// Bounded parts keep the email pattern linear on long unbroken text (RFC 5321: local part 64, domain 255).
const scrub = (s: string) =>
  s
    .replace(/[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,63}/gi, '[email]')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[number]')
    .replace(/\b([\w-]*?(?:bearer|token|key|password|passwd|secret))\b[=: ]+(?:bearer\s+)?\S+/gi, '$1=[hidden]');

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n || 1);
};

export const TARGET_HOURS: Readonly<Record<Severity, number>> = { blocker: 4, major: 24, minor: 120, cosmetic: 720 };

export class Feedback {
  readonly reports: Report[] = [];
  readonly tickets: Ticket[] = [];
  private readonly now: () => Date;
  private readonly similarity: number;
  constructor(o: { now?: () => Date; similarity?: number } = {}) {
    this.now = o.now ?? (() => new Date());
    this.similarity = o.similarity ?? 0.45;
  }

  report(who: string, said: string, context: Report['context'] = {}): { report: Report; ticket: Ticket; isNew: boolean } {
    const text = scrub(said.trim());
    if (text.length < 3) throw new Error('say a few words about what went wrong');
    const r: Report = { id: this.reports.length + 1, who, said: text, at: this.now().toISOString(), context: { ...context, ...(context.errors ? { errors: context.errors.slice(-5).map(scrub) } : {}) } };
    this.reports.push(r);
    const w = words(text);
    let best: { t: Ticket; s: number } | undefined;
    for (const t of this.tickets) {
      if (t.column === 'fixed' || t.column === 'wont fix') continue;
      const first = this.reports[t.reports[0]! - 1]!;
      const sameErr = !!r.context.errors?.length && r.context.errors.at(-1) === first.context.errors?.at(-1);
      const s = Math.max(jaccard(w, words(first.said)), sameErr ? 1 : 0) * (first.context.surface && first.context.surface === r.context.surface ? 1.2 : 1);
      if (s >= this.similarity && (!best || s > best.s)) best = { t, s };
    }
    if (best) {
      best.t.reports.push(r.id);
      r.group = best.t.id;
      return { report: r, ticket: best.t, isNew: false };
    }
    const t: Ticket = { id: this.tickets.length + 1, title: text.slice(0, 80), column: 'new', reports: [r.id], opened: r.at };
    this.tickets.push(t);
    r.group = t.id;
    return { report: r, ticket: t, isNew: true };
  }

  triage(id: number, severity: Severity, title?: string): Ticket {
    const t = this.tickets[id - 1];
    if (!t) throw new Error(`no ticket ${id}`);
    t.severity = severity;
    if (title) t.title = title;
    if (t.column === 'new') t.column = 'triaged';
    return t;
  }

  move(id: number, column: Ticket['column']): void {
    const t = this.tickets[id - 1];
    if (!t) throw new Error(`no ticket ${id}`);
    if (column !== 'new' && column !== 'wont fix' && !t.severity) throw new Error('triage it first: give it a severity');
    t.column = column;
  }

  /** Open tickets, most urgent first: past-target first, then severity, then the most reports, then the oldest. */
  board(): (Ticket & { ageHours: number; overdue: boolean; count: number })[] {
    const now = this.now().getTime();
    const rank = (s?: Severity) => (s ? ['blocker', 'major', 'minor', 'cosmetic'].indexOf(s) : -1);
    return this.tickets
      .filter((t) => t.column !== 'fixed' && t.column !== 'wont fix')
      .map((t) => {
        const ageHours = (now - Date.parse(t.opened)) / 3_600_000;
        return { ...t, ageHours: Math.round(ageHours), overdue: !!t.severity && ageHours > TARGET_HOURS[t.severity], count: t.reports.length };
      })
      .sort((a, b) => Number(b.overdue) - Number(a.overdue) || rank(a.severity) - rank(b.severity) || b.count - a.count || a.opened.localeCompare(b.opened));
  }

  /** A defect for the factory: what happened, where, and the failing test to write first. */
  defect(id: number, o: { steps: readonly string[]; expected: string; actual: string }): { title: string; severity: Severity; steps: readonly string[]; expected: string; actual: string; evidence: string[]; test: string } {
    const t = this.tickets[id - 1];
    if (!t?.severity) throw new Error('triage it first: give it a severity');
    const reps = t.reports.map((r) => this.reports[r - 1]!);
    const evidence = reps.flatMap((r) => [r.context.trace && `trace ${r.context.trace}`, r.context.version && `version ${r.context.version}`, ...(r.context.errors ?? [])].filter((x): x is string => !!x));
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    // A comment is one line: any line break a person typed would turn the rest into live code.
    const line = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ');
    const test = [`import assert from 'node:assert/strict';`, `import { test } from 'node:test';`, '', `// Defect ${t.id}: ${line(t.title)} (${t.severity}, ${t.reports.length} report${t.reports.length === 1 ? '' : 's'})`, `test('${esc(o.expected)}', async () => {`, ...o.steps.map((s, i) => `  // ${i + 1}. ${line(s)}`), `  // Today: ${line(o.actual)}`, `  assert.fail('write the steps above against the real code; this test must fail before the fix and pass after');`, '});', ''].join('\n');
    return { title: t.title, severity: t.severity, steps: o.steps, expected: o.expected, actual: o.actual, evidence: [...new Set(evidence)], test };
  }
}
