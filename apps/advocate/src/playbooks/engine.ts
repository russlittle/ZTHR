import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * The playbook engine (PRD PB-1). A playbook is a declared, durable process in
 * the control plane. The engine moves a student through it one step at a time,
 * records every checkpoint, and pauses in an explicit unresolved state when a
 * step cannot proceed. A playbook reads only the grants it declares.
 */
export const PlaybookDef = z.object({
  playbook: z.string(),
  title: z.string(),
  purpose: z.string(),
  owner: z.string(),
  sign_off: z.literal('required'),
  sources: z.array(z.string().url()).min(1),
  student_grants: z.object({ sealed: z.array(z.string()), profile: z.array(z.string()) }),
  journeys: z.array(z.string()).min(1),
  steps: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['checklist', 'question', 'documents', 'draft', 'wait', 'info']),
        text: z.string(),
        branches: z.record(z.string()).optional(),
        next: z.string().optional(),
        documents: z.array(z.string()).optional(),
        requires_approval: z.boolean().optional(),
        to: z.string().optional(),
        timeout_days: z.number().optional(),
        on_timeout: z.string().optional(),
        done_when: z.string().optional(),
      }),
    )
    .min(1),
  recovery: z.array(z.string()).default([]),
});
export type PlaybookDef = z.infer<typeof PlaybookDef>;

export function loadPlaybooks(dir: string): Map<string, PlaybookDef> {
  const m = new Map<string, PlaybookDef>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
    const def = PlaybookDef.parse(parse(readFileSync(join(dir, f), 'utf8')));
    m.set(def.playbook, def);
  }
  return m;
}

export interface PlaybookRun {
  playbook: string;
  studentId: string;
  stepId: string;
  status: 'active' | 'waiting' | 'done' | 'unresolved';
  startedAt: string;
  history: { at: string; step: string; event: string }[];
  waitingSince?: string;
}

export type PlaybookEvent = { type: 'confirm' } | { type: 'answer'; value: string } | { type: 'approved' } | { type: 'tick'; today: string } | { type: 'arrived' };

export function startRun(def: PlaybookDef, studentId: string, today: string): PlaybookRun {
  return { playbook: def.playbook, studentId, stepId: def.steps[0]!.id, status: 'active', startedAt: today, history: [{ at: today, step: def.steps[0]!.id, event: 'started' }] };
}

const nextAfter = (def: PlaybookDef, id: string): string | undefined => {
  const step = def.steps.find((s) => s.id === id);
  if (step?.next) return step.next;
  const i = def.steps.findIndex((s) => s.id === id);
  // Skip steps that belong only to the other branch of a question.
  for (let j = i + 1; j < def.steps.length; j++) {
    const candidate = def.steps[j]!;
    const isBranchTarget = def.steps.some((s) => s.branches && Object.values(s.branches).includes(candidate.id));
    const isOwnBranchTarget = step?.branches && Object.values(step.branches).includes(candidate.id);
    if (!isBranchTarget || isOwnBranchTarget) return candidate.id;
  }
  return undefined;
};

export function advance(def: PlaybookDef, run: PlaybookRun, ev: PlaybookEvent, today: string): PlaybookRun {
  if (run.status === 'done') return run;
  const step = def.steps.find((s) => s.id === run.stepId);
  if (!step) return { ...run, status: 'unresolved', history: [...run.history, { at: today, step: run.stepId, event: 'unknown step' }] };
  const go = (to: string | undefined, event: string): PlaybookRun => {
    if (!to) return { ...run, status: 'done', history: [...run.history, { at: today, step: step.id, event }] };
    const nextStep = def.steps.find((s) => s.id === to)!;
    return {
      ...run,
      stepId: to,
      status: nextStep.kind === 'wait' ? 'waiting' : 'active',
      waitingSince: nextStep.kind === 'wait' ? today : undefined,
      history: [...run.history, { at: today, step: step.id, event }],
    };
  };
  switch (ev.type) {
    case 'answer': {
      if (step.kind !== 'question' || !step.branches) return run;
      const to = step.branches[ev.value.toLowerCase()];
      return to ? go(to, `answered ${ev.value}`) : run;
    }
    case 'approved':
      return step.kind === 'draft' ? go(nextAfter(def, step.id), 'student approved and sent') : run;
    case 'confirm':
      return step.kind === 'question' || (step.kind === 'draft' && step.requires_approval) ? run : go(nextAfter(def, step.id), 'confirmed');
    case 'arrived':
      return step.kind === 'wait' ? go(nextAfter(def, step.id), 'arrived') : run;
    case 'tick': {
      if (step.kind !== 'wait' || !step.timeout_days || !run.waitingSince) return run;
      const waited = (Date.parse(ev.today) - Date.parse(run.waitingSince)) / 86_400_000;
      return waited > step.timeout_days ? { ...run, status: 'unresolved', history: [...run.history, { at: ev.today, step: step.id, event: 'timed out' }] } : run;
    }
  }
}

export function currentStep(def: PlaybookDef, run: PlaybookRun) {
  return def.steps.find((s) => s.id === run.stepId)!;
}

/** Fill {field} placeholders from granted profile fields only. */
export function fillTemplate(def: PlaybookDef, text: string, profile: Record<string, string | number | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => (def.student_grants.profile.includes(k) && profile[k] !== undefined ? String(profile[k]) : `[${k}]`));
}
