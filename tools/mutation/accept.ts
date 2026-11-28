/**
 * The gate. Prints a JSON verdict; exit 0 only if every check holds.
 *   node tools/mutation/accept.ts <task-file>
 *
 * kill-mutant: (a) only mayEdit files changed, (b) test diff only adds / never weakens, (c) the block's whole test file
 *   passes on real code, (d) Stryker re-run on just that mutant's range reports it Killed or Timeout, (e) the block's
 *   score did not go down. If (c) fails but the unmodified tests pass, the new test has found a real bug: outcome
 *   "bug-found", the test is NOT judged a bad test, and a fix-bug task is written.
 * fix-bug: (a) (b) (c), the mutant is no longer a survivor, (e).
 * simplify: (a) (b) (c), index.ts diff is a net removal, the equivalent mutant is gone or the mutant count fell, (e).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { INTENT, ROOT, blockSrc, blockTest, diffLines, git, guardNetRemoval, guardNoDisable, guardScope, guardTestDiff, loadResult, mutantKey, occurrenceKeys, rangeSpec, rel, runStryker, runTests, touchedSince, type BlockResult, type Mutant, type Task } from './lib.ts';
import { makeTask, writeTask } from './tasks.ts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const hashOf = (m: Mutant) => occurrenceKeys([m])[0]!.split('#')[0]!;
export const survives = (r: BlockResult, m: Mutant) => r.survivors.some((s) => mutantKey(s) === mutantKey(m));
export const detected = (r: BlockResult, m: Mutant) => (r.killedKeys ?? []).some((k) => k.startsWith(`${hashOf(m)}#`));

export function accept(taskFile: string): { verdict: Record<string, unknown>; pass: boolean } {
  const file = isAbsolute(taskFile) ? taskFile : join(ROOT, taskFile);
  const task = JSON.parse(readFileSync(file, 'utf8')) as Task;
  const { block, mutant, kind } = task;
  const checks: Check[] = [];
  let followUp: string | undefined;
  let outcome = 'rejected';
  const done = (): { verdict: Record<string, unknown>; pass: boolean } => {
    const pass = checks.length > 0 && checks.every((c) => c.ok) && outcome === 'pass';
    return { pass, verdict: { task: rel(file), kind, block, pass, outcome, reasons: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), checks, ...(followUp ? { followUp } : {}) } };
  };
  const add = (name: string, ok: boolean, detail = ''): boolean => (checks.push({ name, ok, detail: detail || (ok ? 'ok' : 'failed') }), ok);

  // (a) scope
  const changed = touchedSince(task.baseline);
  const scope = guardScope(changed, task.mayEdit);
  if (!add('a-scope', scope.length === 0 && changed.length > 0, scope.join('; ') || (changed.length ? `changed: ${changed.join(', ')}` : 'nothing changed'))) return done();

  // (b) diff guards
  const testRel = `intent/blocks/${block}/${block}.test.ts`;
  const srcRel = `intent/blocks/${block}/index.ts`;
  const testDiff = git(['diff', 'HEAD', '--', testRel]).out;
  const srcDiff = git(['diff', 'HEAD', '--', srcRel]).out;
  const why = [...guardTestDiff(testDiff), ...guardNoDisable(srcDiff)];
  if (kind === 'simplify') why.push(...guardNetRemoval(srcDiff));
  if (kind === 'kill-mutant' && diffLines(testDiff).added.length === 0) why.push('no lines were added to the test file');
  if (kind === 'fix-bug' && diffLines(testDiff).added.length === 0) why.push('the new test is missing from the test file');
  if (!add('b-diff-guard', why.length === 0, why.join('; '))) return done();

  // (c) the whole test file on real code
  const t = runTests(block);
  if (!add('c-tests-pass-on-real-code', t.ok, t.ok ? '' : t.output.slice(-1800))) {
    if (kind === 'kill-mutant') {
      // Did the code pass before the worker's change? Then the new test has found a real bug.
      const base = join(INTENT, 'blocks', block, `.mutation-baseline-${process.pid}.test.ts`);
      writeFileSync(base, git(['show', `HEAD:${testRel}`]).out);
      const b = runTests(block, `blocks/${block}/${base.split('/').pop()}`);
      rmSync(base, { force: true });
      if (b.ok) {
        outcome = 'bug-found';
        const fix = makeTask('fix-bug', block, mutant, { evidence: t.output.slice(-3000) });
        followUp = rel(writeTask(fix));
        checks[checks.length - 1]!.detail = `NEW test fails on real code while the existing tests pass: a real bug (or a wrong expectation). Not rejected as a bad test; fix-bug task written. ${checks[checks.length - 1]!.detail}`;
      }
    }
    return done();
  }

  const prev = loadResult(block);
  if (!prev) {
    add('e-score-baseline', false, `no intent/eval/mutation/${block}.json; run node tools/mutation/run.ts ${block}`);
    return done();
  }

  // (d) the mutant
  if (kind === 'kill-mutant') {
    const r = runStryker(block, { mutate: rangeSpec(block, mutant) });
    const ok = detected(r, mutant) && !survives(r, mutant);
    if (!add('d-mutant-killed', ok, ok ? 'Killed or Timeout on the mutant range' : `mutant still survives (range run: ${r.killed} killed, ${r.timeout} timeout, ${r.survived} survived)`)) return done();
  }

  // (e) whole-block score
  const cur = runStryker(block);
  if (kind === 'fix-bug') add('d-mutant-killed', !survives(cur, mutant), survives(cur, mutant) ? 'mutant still survives' : 'mutant is no longer a survivor');
  if (kind === 'simplify') {
    const gone = !survives(cur, mutant);
    const fewer = cur.mutants < prev.mutants;
    add('d-equivalent-gone-or-fewer-mutants', gone || fewer, `equivalent mutant gone: ${gone}; mutants ${prev.mutants} -> ${cur.mutants}`);
  }
  add('e-score-not-lower', cur.score >= prev.score, `${prev.score} -> ${cur.score}`);
  if (checks.every((c) => c.ok)) outcome = 'pass';
  return done();
}

if (import.meta.main) {
  const f = process.argv[2];
  if (!f) {
    console.error('usage: node tools/mutation/accept.ts <task-file>');
    process.exit(2);
  }
  const { verdict, pass } = accept(f);
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(pass ? 0 : 1);
}
