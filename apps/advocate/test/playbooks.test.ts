// Verifies docs/flows/playbooks.md
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { advance, currentStep, loadPlaybooks, startRun } from '../src/playbooks/engine.js';

const defs = [...loadPlaybooks(fileURLToPath(new URL('../../../control/playbooks', import.meta.url))).values()];

/** Every path through a playbook, by answering every question every way and confirming every step. */
function allPaths(def: (typeof defs)[number]): string[][] {
  const out: string[][] = [];
  const go = (run: ReturnType<typeof startRun>, path: string[], depth: number) => {
    if (depth > 40) throw new Error(`${def.playbook} does not end`);
    if (run.status === 'done') return void out.push(path);
    const step = currentStep(def, run);
    if (step.kind === 'question' && step.branches) for (const k of Object.keys(step.branches)) go(advance(def, run, { type: 'answer', value: k }, '2026-11-02'), [...path, `${step.id}=${k}`], depth + 1);
    else go(advance(def, run, step.kind === 'draft' ? { type: 'approved' } : step.kind === 'wait' ? { type: 'arrived' } : { type: 'confirm' }, '2026-11-02'), [...path, step.id], depth + 1);
  };
  go(startRun(def, 's', '2026-11-02'), [], 0);
  return out;
}

describe('every playbook', () => {
  for (const def of defs) {
    it(`${def.playbook}: every branch points at a real step`, () => {
      const ids = new Set(def.steps.map((s) => s.id));
      for (const s of def.steps) for (const to of Object.values(s.branches ?? {})) expect(ids, `${s.id} -> ${to}`).toContain(to);
      for (const s of def.steps) if (s.next) expect(ids).toContain(s.next);
    });
    it(`${def.playbook}: every path ends`, () => expect(allPaths(def).length).toBeGreaterThan(0));
    it(`${def.playbook}: every step is reachable on some path`, () => {
      const seen = new Set(allPaths(def).flat().map((x) => x.split('=')[0]));
      for (const s of def.steps) expect(seen, s.id).toContain(s.id);
    });
    it(`${def.playbook}: is admitted by the factory and cites a source`, () => {
      expect(def.admitted_by).toBe('factory');
      expect(def.sources.length).toBeGreaterThan(0);
    });
    it(`${def.playbook}: question steps offer at least two answers`, () => {
      for (const s of def.steps.filter((x) => x.kind === 'question')) expect(Object.keys(s.branches ?? {}).length).toBeGreaterThanOrEqual(2);
    });
  }
});
