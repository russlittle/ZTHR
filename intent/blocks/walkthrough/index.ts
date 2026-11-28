/**
 * The confidence walkthrough: a guided, ordered walk through a feature's journeys, one step at a time. Each step
 * shows what the app does on the test records, what it claims, the balloon it proves, why the app decided what it
 * did, and the evidence that proves it (a test, a run or a screenshot). Evidence is current only when it passed and
 * is newer than the last change to every file the step covers; evidence that failed, is older than the code, is
 * missing, or belongs to a step that names no code or code with no change record is not current.
 *
 * A person signs off the steps in order, and only on current evidence: every other sign-off is refused, and the
 * refusal is kept in the record with its reason. When covered code changes after a sign-off, that sign-off no
 * longer counts until newer evidence arrives and the step is signed again. The record carries a digest of its
 * contents, so a copy can be checked against the original.
 */
import { createHash } from 'node:crypto';

export interface Step {
  readonly id: string;
  /** What the app does at this step, on the test records. */
  readonly does: string;
  /** What this step shows to be true. */
  readonly claim: string;
  /** The balloon on the schematic it proves. */
  readonly balloon?: number;
  /** Why the app decided what it did: the rule or record that made it so. */
  readonly because?: string;
  /** The source files the claim depends on. */
  readonly covers: readonly string[];
}

export interface Journey {
  readonly id: string;
  readonly goal: string;
  readonly persona: string;
  readonly steps: readonly Step[];
}

export interface Evidence {
  readonly id: string;
  /** The step it proves, as journey id / step id. */
  readonly proves: string;
  readonly kind: 'test' | 'run' | 'screenshot';
  /** Where it is kept: a test name, a run id, a screenshot path. */
  readonly ref: string;
  readonly at: string;
  readonly passed: boolean;
}

export interface CodeChange {
  readonly path: string;
  readonly at: string;
}

export type EvidenceStatus = 'current' | 'stale' | 'failed' | 'missing' | 'uncovered' | 'untracked';

export interface Signature {
  readonly who: string;
  readonly at: string;
  readonly note?: string;
  /** The evidence the person relied on. */
  readonly evidence: string;
  readonly evidenceAt: string;
}

export interface StepView {
  readonly key: string;
  readonly journey: string;
  readonly goal: string;
  readonly persona: string;
  /** Position in the walk, from 1. */
  readonly n: number;
  readonly does: string;
  readonly claim: string;
  readonly balloon: number | null;
  readonly because: string | null;
  readonly evidence: Evidence | null;
  readonly lastChange: string | null;
  readonly status: EvidenceStatus;
  readonly reason: string;
  readonly signed: Signature | null;
  /** Signed, but the code it covers changed after the evidence the person relied on. */
  readonly void: boolean;
}

export interface Refusal {
  readonly key: string;
  readonly who: string;
  readonly at: string;
  readonly why: string;
}

export class Walkthrough {
  readonly feature: { readonly id: string; readonly name: string };
  private readonly journeys: readonly Journey[];
  private readonly evidence: Evidence[] = [];
  private readonly changes = new Map<string, string>();
  private readonly signatures = new Map<string, Signature>();
  private readonly refusals: Refusal[] = [];

  constructor(feature: { readonly id: string; readonly name: string }, journeys: readonly Journey[], evidence: readonly Evidence[], changes: readonly CodeChange[]) {
    const keys = new Set<string>();
    for (const j of journeys) {
      if (!j.steps.length) throw new Error(`journey ${j.id} has no steps to walk`);
      for (const s of j.steps) {
        const k = `${j.id}/${s.id}`;
        if (keys.has(k)) throw new Error(`step ${k} appears twice`);
        keys.add(k);
      }
    }
    if (!keys.size) throw new Error(`${feature.name} has no journeys to walk`);
    this.feature = feature;
    this.journeys = journeys;
    for (const e of evidence) this.addEvidence(e);
    for (const c of changes) this.codeChanged(c.path, c.at);
  }

  addEvidence(e: Evidence): void {
    if (!this.steps().some((s) => s.key === e.proves)) throw new Error(`evidence ${e.id} proves ${e.proves}, which is not a step of ${this.feature.name}`);
    this.evidence.push(e);
  }

  /** Records that a file changed; keeps the latest time per file. */
  codeChanged(path: string, at: string): void {
    const was = this.changes.get(path);
    if (!was || at > was) this.changes.set(path, at);
  }

  private steps(): { key: string; j: Journey; s: Step }[] {
    return this.journeys.flatMap((j) => j.steps.map((s) => ({ key: `${j.id}/${s.id}`, j, s })));
  }

  /** Every step in walking order, with its evidence judged against the code as it is now. */
  walk(): StepView[] {
    return this.steps().map(({ key, j, s }, i) => {
      const mine = this.evidence.filter((e) => e.proves === key).sort((a, b) => b.at.localeCompare(a.at));
      const passing = mine.find((e) => e.passed);
      const untracked = s.covers.filter((p) => !this.changes.has(p));
      const lastChange = s.covers.length && !untracked.length ? s.covers.map((p) => this.changes.get(p)!).sort().at(-1)! : null;
      let status: EvidenceStatus;
      let reason: string;
      let evidence: Evidence | null = passing ?? mine[0] ?? null;
      if (!s.covers.length) [status, reason] = ['uncovered', 'The step does not say which code it covers, so no evidence can be shown to be current.'];
      else if (untracked.length) [status, reason] = ['untracked', `There is no record of when ${untracked.join(', ')} last changed, so no evidence can be shown to be current.`];
      else if (!mine.length) [status, reason] = ['missing', 'Nothing proves this step yet.'];
      else if (!passing) [status, reason] = ['failed', `The latest evidence, ${mine[0]!.id}, failed.`];
      else if (!mine[0]!.passed) [status, reason, evidence] = ['failed', `The latest evidence, ${mine[0]!.id}, failed after ${passing.id} passed.`, mine[0]!];
      else if (passing.at <= lastChange!) [status, reason] = ['stale', `${passing.id} is from ${passing.at}, and the code it covers changed at ${lastChange}.`];
      else [status, reason] = ['current', `${passing.id} passed at ${passing.at}, after the last change to the code it covers at ${lastChange}.`];
      const signed = this.signatures.get(key) ?? null;
      const isVoid = !!signed && (lastChange === null || signed.evidenceAt <= lastChange);
      return { key, journey: j.id, goal: j.goal, persona: j.persona, n: i + 1, does: s.does, claim: s.claim, balloon: s.balloon ?? null, because: s.because ?? null, evidence, lastChange, status, reason, signed, void: isVoid };
    });
  }

  /** The first step not yet validly signed off, or undefined when the walk is complete. */
  next(): StepView | undefined {
    return this.walk().find((s) => !s.signed || s.void);
  }

  /** Signs off one step: only the next step, and only on current evidence. A refusal is recorded with its reason. */
  signOff(key: string, who: string, at: string, note?: string): { ok: true; step: StepView } | { ok: false; why: string } {
    const all = this.walk();
    const step = all.find((s) => s.key === key);
    const next = all.find((s) => !s.signed || s.void);
    const why = !who.trim()
      ? 'A sign-off needs the name of the person giving it.'
      : !step
        ? `There is no step ${key} in ${this.feature.name}.`
        : step.signed && !step.void
          ? `Step ${step.n} is already signed off by ${step.signed.who}.`
          : next && next.key !== key
            ? `Sign off the steps in order: step ${next.n}, "${next.claim}", comes first.`
            : step.status !== 'current'
              ? `Step ${step.n} cannot be signed off. ${step.reason}`
              : null;
    if (why || !step) {
      this.refusals.push({ key, who, at, why: why! });
      return { ok: false, why: why! };
    }
    this.signatures.set(key, { who, at, ...(note ? { note } : {}), evidence: step.evidence!.id, evidenceAt: step.evidence!.at });
    return { ok: true, step: this.walk().find((s) => s.key === key)! };
  }

  record(): { feature: string; complete: boolean; summary: string; steps: StepView[]; refusals: readonly Refusal[]; digest: string } {
    const steps = this.walk();
    const good = steps.filter((s) => s.signed && !s.void).length;
    const voided = steps.filter((s) => s.void).length;
    const next = steps.find((s) => !s.signed || s.void);
    const summary = !next ? `Every step of ${this.feature.name} is signed off on current evidence.` : `${good} of ${steps.length} steps signed off on current evidence${voided ? `; ${voided} no longer count because the code changed` : ''}. Next is step ${next.n}: "${next.claim}".`;
    const body = { feature: this.feature.id, complete: !next, summary, steps, refusals: [...this.refusals] };
    return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  }
}
