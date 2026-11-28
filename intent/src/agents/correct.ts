/**
 * Correction without asking, until asking is the only honest thing left.
 *
 * Every failure opens a case: a check that fails, a review that blocks, a delivery stage that fails, a defect from
 * a report. The case is diagnosed, and the diagnosis decides who acts:
 *
 *   bug         the work misses a datum that is clear: the builder fixes it, test first. Nobody is asked.
 *   intent      the datum is unclear or silent where the work needs it: the steward writes a clarification as
 *               examples and notes, and the factory issues the next revision itself when the change is Class II.
 *   infeasible  the intent cannot be met as signed: the person who holds it decides.
 *   factory     the factory itself is wrong: a report into the factory's own loop, which is revised the same way.
 *
 * Builders diagnose. Anything but a bug is confirmed by a reviewer of another family first, because blaming the
 * spec is the easy way out of a hard fix.
 *
 * Class, as engineering change control has it: a Class II change leaves form, fit and function as signed, and is
 * made by the factory under a standing delegation the person signs once. A Class I change touches what they signed:
 * a balloon removed, reworded, loosened or re-marked, a new outcome or constraint, a breaking change to the
 * information, the end in mind or the spec sheet. Class I goes to the person, with the draft and the reasons.
 *
 * A case that does not converge, within the attempts the delegation allows, also goes to the person: a fix that
 * keeps failing is evidence the intent and the work disagree about something nobody has written down.
 */
import { sha256 } from '../hash.ts';
import type { Ballooned } from '../frame.ts';
import { changes as schemaChanges, type Schema as InformationSchema } from '../schema.ts';
import { rangeOf } from '../tolerance.ts';
import { budgetState } from './cost.ts';
import { append, changes, propose, readLines, validActs, type Ledger, type Session } from './ledger.ts';

// ------------------------------------------------------------------ Class I or Class II

export interface DatumLike {
  readonly end: string | null;
  readonly statements: readonly Ballooned[];
  readonly specSheet?: unknown;
  readonly information?: InformationSchema | null;
}

const SCOPE_FREE = new Set(['measures', 'assumptions', 'implications', 'prerequisites']);

function tighter(before: string | undefined, after: string | undefined): 'same' | 'tighter' | 'looser' {
  if ((before ?? '') === (after ?? '')) return 'same';
  if (!before) return 'tighter';
  if (!after) return 'looser';
  const a = rangeOf(before);
  const b = rangeOf(after);
  if (a.kind !== b.kind) return 'looser';
  if (a.kind === 'time' && b.kind === 'time') return b.maxMs <= a.maxMs ? 'tighter' : 'looser';
  if (a.kind === 'rate' && b.kind === 'rate') return b.min >= a.min ? 'tighter' : 'looser';
  if (a.kind === 'count' && b.kind === 'count') return b.max <= a.max ? 'tighter' : 'looser';
  return 'looser';
}

const RANK = { undefined: 0, significant: 1, critical: 2 } as const;

/** Whether going from one datum to the next leaves what the person signed as it was. */
export function classify(before: DatumLike, after: DatumLike, revision = 0): { klass: 'I' | 'II'; reasons: string[]; made: string[] } {
  const reasons: string[] = [];
  const made: string[] = [];
  if ((before.end ?? '') !== (after.end ?? '')) reasons.push('the end in mind changes');
  if (JSON.stringify(before.specSheet ?? null) !== JSON.stringify(after.specSheet ?? null)) reasons.push('the spec sheet changes');
  const next = new Map(after.statements.map((s) => [s.balloon, s]));
  const prev = new Map(before.statements.map((s) => [s.balloon, s]));
  for (const [b, s] of prev) {
    const t = next.get(b);
    if (!t) {
      reasons.push(`balloon ${b} is removed: ${s.text}`);
      continue;
    }
    if (t.text !== s.text || t.slot !== s.slot) reasons.push(`balloon ${b} is reworded`);
    if (t.state !== s.state) reasons.push(`balloon ${b} goes from ${s.state} to ${t.state}; only a person confirms`);
    const tol = tighter(s.tolerance, t.tolerance);
    if (tol === 'looser') reasons.push(`balloon ${b}'s tolerance loosens, from "${s.tolerance ?? 'none'}" to "${t.tolerance ?? 'none'}"`);
    else if (tol === 'tighter') made.push(`balloon ${b} tightens to "${t.tolerance}"`);
    const mr = RANK[String(s.mark) as keyof typeof RANK];
    const nr = RANK[String(t.mark) as keyof typeof RANK];
    if (nr < mr) reasons.push(`balloon ${b} loses its ${s.mark} mark`);
    else if (nr > mr) made.push(`balloon ${b} is marked ${t.mark}`);
  }
  for (const [b, t] of next) {
    if (prev.has(b)) continue;
    if (!SCOPE_FREE.has(t.slot)) reasons.push(`balloon ${b} adds to the ${t.slot}: ${t.text}`);
    else if (t.state === 'confirmed') reasons.push(`balloon ${b} is added as confirmed; the factory's additions are assumptions`);
    else made.push(`balloon ${b} added (${t.slot}, ${t.state}): ${t.text}`);
  }
  for (const c of after.information ? schemaChanges(before.information ?? null, after.information, revision) : []) {
    if (c.breaking) reasons.push(`the information changes in a way existing records feel: ${c.what}`);
    else made.push(`the information: ${c.what}`);
  }
  return { klass: reasons.length ? 'I' : 'II', reasons, made };
}

// ------------------------------------------------------------------ cases

export type Cause = 'bug' | 'intent' | 'infeasible' | 'factory';

export interface CaseEvent {
  readonly case: string;
  readonly event: 'opened' | 'attempt' | 'diagnosed' | 'confirmed' | 'disputed' | 'clarified' | 'escalated' | 'upstream' | 'closed';
  readonly at: string;
  readonly by: Session | 'the factory';
  readonly source?: { readonly kind: 'check' | 'review' | 'stage' | 'ticket'; readonly ref: string; readonly change?: string };
  readonly summary?: string;
  readonly revision?: number;
  readonly failing?: number;
  readonly cause?: Cause;
  readonly balloons?: readonly number[];
  readonly evidence?: string;
  readonly why?: string;
  readonly proposal?: string;
}

export type Waiting = 'builder: diagnose' | 'builder: fix' | 'reviewer: confirm' | 'steward: clarify' | 'a person' | 'the factory upstream' | 'nobody';

export interface Case {
  readonly id: string;
  readonly opened: CaseEvent;
  readonly status: 'open' | 'escalated' | 'closed';
  readonly cause: Cause | null;
  readonly diagnosedBy: Session | null;
  readonly waiting: Waiting;
  readonly attempts: number;
  readonly clarifications: number;
  /** Failing items on each attempt, oldest first: the measure of whether the loop is converging. */
  readonly trend: readonly number[];
  readonly events: readonly CaseEvent[];
}

export interface Delegation {
  /** Whether the factory may issue Class II revisions without asking. */
  readonly classII: boolean;
  /** Fixes and clarifications on one case before it goes to a person. */
  readonly attempts: number;
  readonly by: string;
  readonly at: string;
}

/**
 * The person's standing delegation: the last one they signed (agents/acts.jsonl). Without one, every revision the
 * factory would make is asked for instead. A delegation written any other way is not read at all.
 */
export function delegation(l: Ledger): Delegation {
  const a = validActs(l, 'delegate').at(-1);
  return a ? { classII: a.fields['classII'] === true, attempts: Math.max(1, Math.floor(Number(a.fields['attempts']) || 5)), by: a.by, at: a.at } : { classII: false, attempts: 5, by: 'nobody', at: '' };
}

export function cases(l: Ledger): Case[] {
  const by = new Map<string, CaseEvent[]>();
  for (const e of readLines<CaseEvent>(l, 'cases.jsonl')) by.set(e.case, [...(by.get(e.case) ?? []), e]);
  return [...by.entries()].map(([id, es]) => {
    const last = (k: CaseEvent['event']) => es.filter((e) => e.event === k).at(-1);
    const diag = last('diagnosed');
    const afterDiag = diag ? es.slice(es.lastIndexOf(diag) + 1) : [];
    const confirmed = afterDiag.some((e) => e.event === 'confirmed');
    const disputed = afterDiag.some((e) => e.event === 'disputed');
    const attempts = es.filter((e) => e.event === 'attempt');
    const clar = es.filter((e) => e.event === 'clarified').length;
    const closed = es.some((e) => e.event === 'closed');
    const escalated = !closed && es.at(-1)!.event === 'escalated';
    const upstream = afterDiag.some((e) => e.event === 'upstream');
    const lastClar = last('clarified');
    const fixAfterClar = lastClar && afterDiag.includes(lastClar);
    const cause = diag?.cause ?? null;
    const waiting: Waiting = closed
      ? 'nobody'
      : escalated
        ? 'a person'
        : !diag || disputed
          ? disputed ? 'builder: fix' : 'builder: diagnose'
          : cause === 'bug' || fixAfterClar
            ? 'builder: fix'
            : !confirmed
              ? 'reviewer: confirm'
              : cause === 'intent'
                ? 'steward: clarify'
                : cause === 'factory'
                  ? upstream ? 'the factory upstream' : 'reviewer: confirm'
                  : 'a person';
    return {
      id,
      opened: es[0]!,
      status: closed ? 'closed' : escalated ? 'escalated' : 'open',
      cause: disputed ? 'bug' : cause,
      diagnosedBy: diag && diag.by !== 'the factory' ? diag.by : null,
      waiting,
      attempts: attempts.length,
      clarifications: clar,
      trend: attempts.map((a) => a.failing ?? 0),
      events: es,
    };
  });
}

export const caseOf = (l: Ledger, id: string) => cases(l).find((c) => c.id === id);

export function event(l: Ledger, e: Omit<CaseEvent, 'at'>): void {
  append(l, 'cases.jsonl', { ...e, at: l.now() });
}

/** A failure the factory saw. Opens a case, or counts as one more attempt on the case the change was made for. */
export function failure(l: Ledger, source: NonNullable<CaseEvent['source']>, summary: string, failing: number, revision: number, linked?: string, by: Session | 'the factory' = 'the factory'): string {
  const existing = linked ? caseOf(l, linked) : undefined;
  if (existing && existing.status !== 'closed') {
    event(l, { case: existing.id, event: 'attempt', by, source, summary, failing });
    converge(l, existing.id);
    return existing.id;
  }
  const id = `k-${sha256(`${source.kind}:${source.ref}:${summary}:${l.now()}`).slice(0, 10)}`;
  event(l, { case: id, event: 'opened', by, source, summary, revision });
  event(l, { case: id, event: 'attempt', by, source, summary, failing });
  return id;
}

/**
 * Whether the case is still getting somewhere. It goes to a person when the attempts run out, or when three
 * attempts in a row fail on as much as or more than before: a loop that is not converging is a question nobody
 * has asked yet.
 */
export function converge(l: Ledger, id: string): 'going' | 'escalated' {
  const c = caseOf(l, id)!;
  const d = delegation(l);
  const t = c.trend;
  const stuck = t.length >= 3 && t[t.length - 1]! >= t[t.length - 2]! && t[t.length - 2]! >= t[t.length - 3]!;
  if (c.status !== 'open') return 'going';
  const spend = budgetState(l, id);
  if (c.attempts > d.attempts || stuck || spend.caseOver) {
    const why = stuck ? `not converging: failing ${t.slice(-3).join(', ')} on the last three attempts` : spend.caseOver ? `spent $${spend.spentCase} on this case, the ceiling for one case` : `${c.attempts} attempts, past the ${d.attempts} the delegation allows`;
    const p = propose(l, { role: 'steward', family: 'factory', agent: 'the factory' }, 'intent', `Not converging: ${c.opened.summary ?? id}`.slice(0, 120), why, { case: id, trend: t, attempts: c.attempts });
    event(l, { case: id, event: 'escalated', by: 'the factory', why, proposal: p.id });
    return 'escalated';
  }
  return 'going';
}

/** Close every open case whose change has since been admitted. Called whenever admission might have changed. */
export function closeFixed(l: Ledger, admitted: (change: string) => boolean): string[] {
  const done: string[] = [];
  for (const c of cases(l).filter((x) => x.status === 'open')) {
    const fix = changes(l).find((ch) => ch.case === c.id && admitted(ch.id));
    if (fix) {
      event(l, { case: c.id, event: 'closed', by: 'the factory', evidence: `change ${fix.id} admitted on commit ${fix.commit}` });
      done.push(c.id);
    }
  }
  return done;
}
