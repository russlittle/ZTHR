// Verifies docs/testing/exploration.md
import { describe, expect, it } from 'vitest';
import { assemble, plan, splitByStudent, type StudentWalk } from '../walk-rotation.js';

const seed = (name: string, exhausted = true) => ({ name, states: 10, transitions: 20, maxDepth: 3, exhausted });
const night = { seeds: [seed('Ana'), seed('Ana/brief'), seed('Sam'), seed('Sam/brief', false)], states: 40, transitions: 80, violations: [{ seed: 'Sam/brief', path: ['x'], problem: 'p' }], verbsSeen: { tap: 5 }, exhausted: false };

describe('splitting a night into per-student walks', () => {
  const ws = splitByStudent(night, 'c1', '2026-11-04T03:00:00Z');
  it('gives each student their own seeds, totals, violations and outcome', () => {
    expect(ws.map((w) => [w.student, w.seeds.length, w.states, w.violations.length, w.exhausted])).toEqual([['Ana', 2, 20, 0, true], ['Sam', 2, 20, 1, false]]);
    expect(ws[0]).toMatchObject({ commit: 'c1', walkedAt: '2026-11-04T03:00:00Z' });
  });
});

describe("choosing tonight's students", () => {
  const cov = (commit: string) => ({ commit, files: { 'apps/advocate/src/server/app.ts': [[10, 20]] as [number, number][] } });
  const walk = (student: string, walkedAt: string, ok = true): StudentWalk => ({ student, commit: 'c1', walkedAt, seeds: [seed(student)], states: 1, transitions: 1, violations: ok ? [] : [{ seed: student, path: [], problem: 'p' }], verbsSeen: {}, exhausted: true });
  const none: { file: string; start: number; count: number }[] = [];
  const touching = [{ file: 'apps/advocate/src/server/app.ts', start: 15, count: 1 }];
  const saved = new Map([
    ['Ana', { walk: walk('Ana', '2026-11-01'), cov: cov('c1'), changes: none }],
    ['Ben', { walk: walk('Ben', '2026-11-02'), cov: cov('c1'), changes: touching }],
    ['Cy', { walk: walk('Cy', '2026-11-03', false), cov: cov('c1'), changes: none }],
    ['Di', { walk: walk('Di', '2026-10-30'), cov: cov('c1'), changes: undefined }],
    ['Ed', { walk: walk('Ed', '2026-10-29'), cov: cov('c1'), changes: none }],
  ]);
  const p = plan(saved, ['Ana', 'Ben', 'Cy', 'Di', 'Ed', 'Fay'], 4);
  it('a clean walk no change has touched is valid; anything else is stale, with why', () => {
    expect(p.valid.map((v) => v.student)).toEqual(['Ana', 'Ed']);
    expect(Object.fromEntries(p.stale.map((s) => [s.student, s.why.split(',')[0]]))).toEqual({ Fay: 'never walked in full', Di: 'cannot compare with c1', Ben: 'apps/advocate/src/server/app.ts changed at line 15', Cy: 'last full walk did not pass' });
  });
  it('walks stale students first, oldest first, then the oldest valid ones', () => {
    expect(p.tonight).toEqual(['Fay', 'Di', 'Ben', 'Cy']);
    expect(plan(saved, ['Ana', 'Ed'], 4).tonight).toEqual(['Ed', 'Ana']);
    expect(plan(saved, ['Ana', 'Ed'], 1).tonight).toEqual(['Ed']);
  });
});

describe("assembling this commit's report", () => {
  const ws = splitByStudent({ ...night, violations: [] }, 'c1', 't');
  it('covers the students given, marks the carried ones, and is exhausted only if every walk is', () => {
    const r = assemble(ws, 'c9', { Ana: 'c1' });
    expect(r).toMatchObject({ commit: 'c9', only: ['Ana', 'Sam'], states: 40, exhausted: false });
    expect(r.students).toEqual({ Ana: { walkedAt: 't', commit: 'c1', carried: true }, Sam: { walkedAt: 't', commit: 'c1', carried: false } });
    expect(r.verbsSeen).toEqual({ tap: 5 });
    expect(assemble([ws[0]!], 'c9', {}).exhausted).toBe(true);
    expect(assemble([], 'c9', {}).exhausted).toBe(false);
  });
});
