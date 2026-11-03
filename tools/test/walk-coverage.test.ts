// Verifies docs/testing/exploration.md
import { describe, expect, it } from 'vitest';
import { executedLines, hunks, walkNeeded, type Istanbul } from '../walk-coverage.js';
import { ROOT } from '../lib.js';

const file = `${ROOT}apps/advocate/src/server/api.ts`;
// Lines 1-3 set up; lines 4-8 register a route whose handler body (5-7) never ran; 9-12 a handler that did run.
const istanbul: Record<string, Istanbul> = {
  [file]: {
    statementMap: { 0: { start: { line: 1 }, end: { line: 3 } }, 1: { start: { line: 4 }, end: { line: 8 } }, 2: { start: { line: 6 }, end: { line: 6 } }, 3: { start: { line: 9 }, end: { line: 12 } }, 4: { start: { line: 10 }, end: { line: 11 } } },
    s: { 0: 1, 1: 1, 2: 0, 3: 1, 4: 3 },
    fnMap: { 0: { loc: { start: { line: 4 }, end: { line: 8 } } }, 1: { loc: { start: { line: 9 }, end: { line: 12 } } } },
    f: { 0: 0, 1: 3 },
  },
  '/elsewhere/node_modules/x.js': { statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } }, s: { 0: 1 }, fnMap: {}, f: {} },
};

describe('which lines a walk executed', () => {
  const lines = executedLines(istanbul);
  it('keeps repository files only', () => expect(Object.keys(lines)).toEqual(['apps/advocate/src/server/api.ts']));
  it('counts executed statements, minus the inside of a function that never ran (its first and last lines stay)', () => {
    expect(lines['apps/advocate/src/server/api.ts']).toEqual([[1, 4], [8, 12]]);
  });
});

describe('reading a diff', () => {
  it('finds each hunk\'s file and old range, including insertions and new files', () => {
    const d = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -5,2 +5,3 @@', '@@ -9 +10 @@', '@@ -12,0 +14,2 @@', 'diff --git a/n.ts b/n.ts', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,4 @@'].join('\n');
    expect(hunks(d)).toEqual([{ file: 'x.ts', start: 5, count: 2 }, { file: 'x.ts', start: 9, count: 1 }, { file: 'x.ts', start: 12, count: 0 }, { file: 'n.ts', start: 0, count: 0 }]);
  });
});

describe('whether to walk', () => {
  const cov = { commit: 'abc', files: executedLines(istanbul) };
  const at = (start: number, count = 1, f = 'apps/advocate/src/server/api.ts') => [{ file: f, start, count }];
  it('an API handler the walk never ran changes: no walk', () => expect(walkNeeded(cov, at(6))).toBeUndefined());
  it('a line the walk ran changes: walk', () => expect(walkNeeded(cov, at(10))).toMatch(/line 10, which the walk executed/));
  it('a change right beside an executed line counts, so an edited boundary is never missed', () => {
    expect(walkNeeded(cov, at(5))).toBeDefined();
    expect(walkNeeded(cov, at(7))).toBeDefined();
  });
  it('an insertion between executed lines walks; one inside a function that never ran does not', () => {
    expect(walkNeeded(cov, at(10, 0))).toBeDefined();
    expect(walkNeeded(cov, at(5, 0))).toBeUndefined();
  });
  it('a file the walk never executed, such as the docs or the console, needs no walk', () => expect(walkNeeded(cov, at(1, 1, 'tools/site.ts'))).toBeUndefined());
  it('data the app reads while running always walks', () => {
    expect(walkNeeded(cov, at(3, 1, 'control/playbooks/fafsa.yaml'))).toMatch(/data the app reads/);
    expect(walkNeeded(cov, at(3, 1, 'package-lock.json'))).toBeDefined();
  });
});
