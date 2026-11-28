/**
 * The recurrent loop: find -> tasks -> worker -> accept -> repeat, until no survivors remain (only recorded
 * equivalents), nothing new can be tried, or the round or token budget is hit.
 *
 *   node tools/mutation/loop.ts <block...> [--worker "<cmd>"] [--max-rounds 5] [--budget-tokens 2000000] [--incremental] [--worker-timeout-min 30]
 *   MUTATION_WORKER='claude -p "$(cat {task})" --allowedTools Edit,Read,Bash' node tools/mutation/loop.ts geo
 *
 * The worker is a shell command run from the repo root. `{task}` in it is replaced by the task file path; the task's
 * prompt is also on stdin and in $MUTATION_PROMPT; $MUTATION_TASK, $MUTATION_BLOCK, $MUTATION_KIND are set. The worker
 * edits files and does NOT commit (the loop gates and leaves the diff for a person). With no worker the loop is a dry
 * run: it finds, writes tasks, logs what it would hand out, and stops after round 1.
 *
 * Order inside a round: fix-bug, then kill-mutant, then simplify. A rejected attempt is rolled back to the file
 * contents from just before the worker ran (earlier accepted work is kept); a "bug-found" attempt keeps its failing
 * test because the fix-bug task that follows needs it.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from 'node:path';
import { QUEUE, RESULTS, ROOT, loadRulings, mutantKey, rel, remaining, snapshotDirty, taskFiles, writeJson, type Task } from './lib.ts';
import { accept } from './accept.ts';
import { headline, runBlock } from './run.ts';
import { emitTasks } from './tasks.ts';

export interface LoopOptions {
  blocks: string[];
  worker?: string;
  maxRounds: number;
  budgetTokens: number;
  incremental: boolean;
  workerTimeoutMin: number;
}

const LOG = join(RESULTS, 'loop.log.jsonl');

function log(event: Record<string, unknown>): void {
  const line = { at: new Date().toISOString(), ...event };
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify(line) + '\n');
  console.log(JSON.stringify(line));
}

export function runWorker(cmd: string, taskFile: string, t: Task, timeoutMin: number): { status: number | null } {
  const r = spawnSync(cmd.replaceAll('{task}', taskFile), {
    shell: true,
    cwd: ROOT,
    input: t.prompt,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: timeoutMin * 60_000,
    env: { ...process.env, MUTATION_TASK: taskFile, MUTATION_BLOCK: t.block, MUTATION_KIND: t.kind, MUTATION_PROMPT: t.prompt, MUTATION_COMMIT: '0' },
  });
  return { status: r.status };
}

export function loop(o: LoopOptions): { stopped: string; rounds: number; remaining: Record<string, number> } {
  const attempted = new Set<string>();
  let spent = 0;
  let stopped = 'max-rounds';
  let round = 0;
  const left: Record<string, number> = {};
  for (round = 1; round <= o.maxRounds; round++) {
    let actionable = 0;
    for (const b of o.blocks) {
      const r = runBlock(b, { incremental: o.incremental });
      left[b] = remaining(r, loadRulings(b)).length;
      const e = emitTasks(b);
      log({ round, block: b, event: 'found', headline: headline(r), tasks: { fixBug: e.fixBug, killMutant: e.killMutant, simplify: e.simplify } });
    }
    const total = Object.values(left).reduce((a, n) => a + n, 0);
    const fresh = (f: string) => !attempted.has(attemptKey(f));
    for (const b of o.blocks) actionable += taskFiles(b).filter(fresh).length;
    if (actionable === 0) {
      stopped = total === 0 ? 'clean: only recorded equivalents remain' : 'stuck: every remaining task was already tried';
      break;
    }
    if (!o.worker) {
      log({ round, event: 'dry-run', wouldHandOut: o.blocks.flatMap((b) => taskFiles(b).map(rel)), note: 'set MUTATION_WORKER or --worker to run workers' });
      stopped = 'dry-run';
      break;
    }
    for (const b of o.blocks) {
      let again = true;
      while (again) {
        again = false;
        const next = taskFiles(b).find(fresh);
        if (!next) break;
        const t = JSON.parse(readFileSync(next, 'utf8')) as Task;
        if (spent + t.budgetTokens > o.budgetTokens) {
          stopped = 'budget';
          log({ round, event: 'budget-hit', spent, next: rel(next) });
          return { stopped, rounds: round, remaining: left };
        }
        spent += t.budgetTokens;
        attempted.add(attemptKey(next));
        t.baseline = snapshotDirty(); // earlier accepted, uncommitted work is not this worker's
        writeJson(next, t);
        const before = new Map(t.mayEdit.map((f) => [f, existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8') : undefined]));
        const w = runWorker(o.worker, next, t, o.workerTimeoutMin);
        const { verdict, pass } = accept(next);
        log({ round, block: b, event: 'attempt', task: rel(next), kind: t.kind, workerExit: w.status, outcome: verdict.outcome, pass, reasons: verdict.reasons });
        if (pass) {
          const done = join(QUEUE, 'done');
          mkdirSync(done, { recursive: true });
          renameSync(next, join(done, next.split('/').pop()!));
          if (t.kind !== 'kill-mutant') again = false; // index.ts changed: line numbers moved, find again
          else again = true;
          if (t.kind !== 'kill-mutant') break;
        } else {
          if (verdict.outcome === 'bug-found') again = true; // the fix-bug task is next
          else {
            for (const [f, text] of before) if (text !== undefined) writeFileSync(join(ROOT, f), text); // roll back this attempt only
            again = true;
          }
        }
      }
    }
  }
  const final = Math.min(round, o.maxRounds);
  log({ event: 'stopped', stopped, rounds: final, remaining: left });
  return { stopped, rounds: final, remaining: left };
}

const attemptKey = (taskFile: string): string => {
  const t = JSON.parse(readFileSync(taskFile, 'utf8')) as Task;
  return `${t.block}|${t.kind}|${mutantKey(t.mutant)}`;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const valued = new Set(['worker', 'max-rounds', 'budget-tokens', 'worker-timeout-min']);
  const blocks = args.filter((a, i) => !a.startsWith('--') && !valued.has((args[i - 1] ?? '').slice(2)));
  if (!blocks.length) {
    console.error('usage: node tools/mutation/loop.ts <block...> [--worker "<cmd>"] [--max-rounds N] [--budget-tokens N] [--incremental]');
    process.exit(2);
  }
  const r = loop({
    blocks,
    worker: val('worker') ?? process.env.MUTATION_WORKER,
    maxRounds: Number(val('max-rounds') ?? 5),
    budgetTokens: Number(val('budget-tokens') ?? 2_000_000),
    incremental: args.includes('--incremental'),
    workerTimeoutMin: Number(val('worker-timeout-min') ?? 30),
  });
  const total = Object.values(r.remaining).reduce((a, n) => a + n, 0);
  console.log(`loop ${r.stopped} after ${r.rounds} round(s); ${total} survivors remaining`);
  process.exit(total === 0 ? 0 : 1);
}
