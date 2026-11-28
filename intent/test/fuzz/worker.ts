/** Worker entry for harness.bounded: imports the job module and runs the named job, reporting each input first. */
import { parentPort, workerData } from 'node:worker_threads';
import { show } from './harness.ts';

const d = workerData as { module: string; fn: string; seed: number; cases: number; only: number | undefined };
const mod = (await import(d.module)) as Record<string, (seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void) => void>;
try {
  const job = mod[d.fn];
  if (typeof job !== 'function') throw new Error(`${d.module} has no job ${d.fn}`);
  job(d.seed, d.cases, d.only, (i, input) => parentPort!.postMessage({ kind: 'at', i, input: show(input, 2000) }));
  parentPort!.postMessage({ kind: 'done' });
} catch (e) {
  parentPort!.postMessage({ kind: 'fail', message: e instanceof Error ? e.message : String(e) });
}
