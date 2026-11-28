/**
 * npm run gates: every gate's proof is still there, and the runner fails on a gate whose proof fails, a proof that
 * matches no test, a proof that lost planted tests, and a gate whose own check fails.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GATES, proofTitles, runGate, runGates, type Gate } from '../tools/gates.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every gate names a proof that still holds at least the planted tests it must keep', () => {
  for (const g of GATES) assert.ok(proofTitles(ROOT, g).length >= g.proof.min, `${g.id}: ${proofTitles(ROOT, g).length} < ${g.proof.min}`);
  assert.deepEqual(new Set(GATES.map((g) => g.id)).size, GATES.length);
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'zthr-gates-'));
  mkdirSync(join(dir, 'test'));
  const t = (name: string, body: string) => writeFileSync(join(dir, 'test', name), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`);
  t('good.test.ts', "test('planted: the defect is refused', () => assert.ok(true));\ntest('planted: and so is this one', () => assert.ok(true));");
  t('bad.test.ts', "test('planted: the defect is refused', () => assert.ok(true));\ntest('planted: but this one gets through', () => assert.ok(false));");
  return dir;
}

const gate = (proof: Partial<Gate['proof']>, check?: string[]): Gate => ({ id: 'g', what: 'a gate', ...(check ? { check } : {}), proof: { file: 'test/good.test.ts', pattern: '^planted', min: 2, ...proof } });

test('planted: the runner fails a gate whose proof fails, or that proves less than it must', () => {
  const dir = sandbox();
  assert.ok(runGate(dir, gate({})).ok);
  assert.match(runGate(dir, gate({ file: 'test/bad.test.ts' })).why, /1 planted test\(s\) failed/);
  assert.match(runGate(dir, gate({ pattern: '^no such test' })).why, /0 planted test\(s\).*fewer than the 2/);
  assert.match(runGate(dir, gate({ min: 3 })).why, /fewer than the 3/);
  assert.match(runGate(dir, gate({ file: 'test/missing.test.ts' })).why, /0 planted test/);
  assert.match(runGate(dir, gate({}, [process.execPath, '-e', 'process.exit(3)'])).why, /its check failed/);
  const lines: string[] = [];
  assert.equal(runGates(dir, [gate({}), gate({ file: 'test/bad.test.ts' })], (s) => lines.push(s)), 1, 'one failing gate fails the run');
  assert.match(lines.at(-1)!, /1 of 2 gate\(s\) failed/);
});
