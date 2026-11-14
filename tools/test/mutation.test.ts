// Verifies docs/testing/mutation.md
import { describe, expect, it } from 'vitest';
import { judge, nextFloors, scores, survivors, type Report } from '../mutation-core.js';

const m = (status: string, line = 1, mutatorName = 'ConditionalExpression', replacement = 'true') => ({ status, mutatorName, replacement, location: { start: { line } } });
const report = (file: string, killed: number, survived: number, extra: ReturnType<typeof m>[] = []): Report => ({
  files: { [file]: { source: 'const a = 1;\nif (x > 2) y();', mutants: [...Array(killed).fill(m('Killed')), ...Array(survived).fill(m('Survived', 2)), ...extra] } },
});
const ledger = [{ ratchet: 'mutation:a.ts', from: 80, to: 70, reason: 'the module was split; the half that moved took its tests', by: 'russ', at: '2026-11-14' }];

describe('mutation floors, module by module', () => {
  it('scores count caught and timed-out mutants over the valid ones; errors do not count', () => {
    expect(scores(report('a.ts', 3, 1, [m('Timeout'), m('CompileError'), m('Ignored'), m('NoCoverage')]))).toEqual([{ file: 'a.ts', killed: 4, valid: 6, score: (4 / 6) * 100 }]);
    expect(scores({ files: { 'e.ts': { mutants: [m('CompileError')] } } })[0]!.score).toBe(100);
  });

  it('a module with no floor starts at what it measures, in whole percent', () => {
    const [r] = judge(scores(report('a.ts', 2, 1)), {}, {}, [], ['russ']);
    expect(r).toMatchObject({ floor: 66, next: 66, ok: true });
  });

  it('a module under its floor fails; at or over it passes and tightens to the whole percent', () => {
    expect(judge(scores(report('a.ts', 3, 1)), { 'a.ts': 76 }, {}, [], [])[0]).toMatchObject({ ok: false, floor: 76, next: 76 });
    expect(judge(scores(report('a.ts', 3, 1)), { 'a.ts': 75 }, {}, [], [])[0]).toMatchObject({ ok: true, next: 75 });
    expect(judge(scores(report('a.ts', 9, 1)), { 'a.ts': 75 }, {}, [], [])[0]).toMatchObject({ ok: true, next: 90 });
  });

  it('the higher of the stated and the last nightly floor holds, unless a person reset it', () => {
    const at = (last: number, ledgerIn = [] as typeof ledger, people = ['russ']) => judge(scores(report('a.ts', 3, 1)), { 'a.ts': 70 }, { 'a.ts': last }, ledgerIn, people)[0]!;
    expect(at(80)).toMatchObject({ floor: 80, ok: false });
    expect(at(80).detail).toMatch(/the floor stays at 80: floor loosened 80 -> 70 without a reset ledger entry/);
    expect(at(80, ledger)).toMatchObject({ floor: 70, ok: true, next: 75 });
    expect(at(80, ledger, ['someone-else'])).toMatchObject({ floor: 80, ok: false });
    expect(at(60)).toMatchObject({ floor: 70, ok: true });
    expect(judge(scores(report('a.ts', 3, 1)), {}, { 'a.ts': 74 }, [], [])[0]).toMatchObject({ floor: 74, ok: true, next: 75 });
  });

  it('every survivor is the next work, with the line it changed', () => {
    expect(survivors(report('b.ts', 1, 1, [m('NoCoverage', 1, 'StringLiteral', '""')]))).toEqual([
      { file: 'b.ts', line: 1, mutator: 'StringLiteral', replacement: '""', code: 'const a = 1;' },
      { file: 'b.ts', line: 2, mutator: 'ConditionalExpression', replacement: 'true', code: 'if (x > 2) y();' },
    ]);
  });

  it('next floors are written for every module judged', () => {
    const res = judge([...scores(report('a.ts', 9, 1)), ...scores(report('b.ts', 1, 1))], { 'a.ts': 80 }, {}, [], []);
    expect(nextFloors(res)).toEqual({ 'a.ts': 90, 'b.ts': 50 });
  });
});
