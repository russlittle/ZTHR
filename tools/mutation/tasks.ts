/**
 * Task: turn every survivor (and every equivalence ruling) into a task spec in intent/factory/queue/mutation/.
 *   node tools/mutation/tasks.ts <block...>
 * Order per round: fix-bug first, then kill-mutant, then simplify. Every survivor gets a task every run, so the loop
 * does not stop until none remain. fix-bug tasks are made by accept.ts when a new test fails on real code; they are
 * kept here until they are done.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE, buildPrompt, isTaskOf, blockSrc, blockTest, excerpt, isEquivalent, loadResult, loadRulings, mutantKey, rel, rulingFor, snapshotDirty, taskFiles, testStyle, writeJson, KIND_RANK, type Mutant, type Task, type TaskKind } from './lib.ts';

const BUDGET: Record<TaskKind, number> = { 'fix-bug': 80_000, 'kill-mutant': 40_000, simplify: 40_000 };

export const taskName = (block: string, kind: TaskKind, id: string) => `${block}-${id}${kind === 'kill-mutant' ? '' : kind === 'fix-bug' ? '-fix' : '-simplify'}`;
export const taskPath = (block: string, kind: TaskKind, id: string) => join(QUEUE, `${taskName(block, kind, id)}.json`);

let dirtyAtStart: Record<string, string> | undefined;

export function makeTask(kind: TaskKind, block: string, mutant: Mutant, o: { evidence?: string } = {}): Task {
  const mayEdit = kind === 'kill-mutant' ? [`intent/blocks/${block}/${block}.test.ts`] : [`intent/blocks/${block}/index.ts`, `intent/blocks/${block}/${block}.test.ts`];
  const acceptance = `node tools/mutation/accept.ts ${rel(taskPath(block, kind, mutant.id))}`;
  const src = existsSync(blockSrc(block)) ? readFileSync(blockSrc(block), 'utf8') : '';
  const tst = existsSync(blockTest(block)) ? readFileSync(blockTest(block), 'utf8') : '';
  return {
    kind,
    block,
    mutant,
    mayEdit,
    acceptance,
    budgetTokens: BUDGET[kind],
    tier: 'worker',
    priority: KIND_RANK[kind],
    prompt: buildPrompt(kind, { block, mutant, sourceExcerpt: excerpt(src, mutant.line), testStyle: testStyle(tst), acceptance, mayEdit, evidence: o.evidence }),
    // One snapshot per run: asking git for every task took hours once the queue held thousands of orders.
    baseline: (dirtyAtStart ??= snapshotDirty()),
    createdAt: new Date().toISOString(),
    ...(o.evidence ? { evidence: o.evidence } : {}),
  };
}

export function writeTask(t: Task): string {
  const p = taskPath(t.block, t.kind, t.mutant.id);
  writeJson(p, t);
  return p;
}

/** Rebuilds the kill-mutant and simplify tasks for a block from its current result and rulings. */
export function emitTasks(block: string): { files: string[]; killMutant: number; simplify: number; fixBug: number; skippedEquivalent: number } {
  const result = loadResult(block);
  if (!result) throw new Error(`no result for ${block}: run node tools/mutation/run.ts ${block} first`);
  const rulings = loadRulings(block);
  mkdirSync(QUEUE, { recursive: true });
  for (const f of readdirSync(QUEUE)) if (isTaskOf(block, f) && !f.endsWith('-fix.json')) rmSync(join(QUEUE, f)); // stale ids
  // A fix-bug task is stale once the mutant it came from is no longer a survivor.
  const keys = new Set(result.survivors.map(mutantKey));
  for (const f of taskFiles(block)) {
    const t = JSON.parse(readFileSync(f, 'utf8')) as Task;
    if (t.kind === 'fix-bug' && !keys.has(mutantKey(t.mutant))) rmSync(f);
  }
  let killMutant = 0;
  let skippedEquivalent = 0;
  for (const m of result.survivors) {
    if (isEquivalent(m, rulings)) {
      skippedEquivalent++;
      continue;
    }
    if (existsSync(taskPath(block, 'fix-bug', m.id))) continue; // a bug was found for this one; fix it first
    writeTask(makeTask('kill-mutant', block, m));
    killMutant++;
  }
  let simplify = 0;
  for (const m of result.survivors) {
    const r = rulingFor(m, rulings);
    if (r && !r.simplify) {
      writeTask(makeTask('simplify', block, m, { evidence: `${r.argument} (by ${r.by}, judged by ${r.judge})` }));
      simplify++;
    }
  }
  const fixBug = taskFiles(block).filter((f) => f.endsWith('-fix.json')).length;
  return { files: taskFiles(block), killMutant, simplify, fixBug, skippedEquivalent };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--print') {
    console.log((JSON.parse(readFileSync(args[1]!, 'utf8')) as Task).prompt);
    process.exit(0);
  }
  const blocks = args.filter((a) => !a.startsWith('--'));
  if (!blocks.length) {
    console.error('usage: node tools/mutation/tasks.ts <block...> | --print <task.json>');
    process.exit(2);
  }
  for (const b of blocks) {
    const r = emitTasks(b);
    console.log(`${b}: ${r.fixBug} fix-bug, ${r.killMutant} kill-mutant, ${r.simplify} simplify tasks (${r.skippedEquivalent} survivors ruled equivalent) in ${rel(QUEUE)}`);
  }
}
