import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, ROOT } from './lib.js';

/**
 * Records what this factory run cost in compute: elapsed build-minutes times the dated list rate for the machine.
 * Writes evidence-out/ci-cost.json (one line) for this run and appends it to evidence-out/ci-costs.jsonl. The build
 * keeps one record per run in its evidence bucket (costs/<build>.json) and concatenates them into the history, so
 * concurrent runs never overwrite each other.
 */
export interface CiRun {
  buildId: string;
  commit: string;
  kind: 'push' | 'nightly' | 'manual';
  machine: string;
  ratePerMin: number;
  rateChecked: string;
  startedAt: string;
  finishedAt: string;
  minutes: number;
  costUsd: number;
}

export function measure(env: NodeJS.ProcessEnv, now = Date.now()): CiRun {
  const rates = JSON.parse(readFileSync(join(ROOT, 'control/ci-rates.json'), 'utf8')) as { checked: string; rates: Record<string, number> };
  const machine = env.CI_MACHINE ?? 'E2_STANDARD_2';
  const rate = rates.rates[machine];
  if (rate === undefined) throw new Error(`No dated rate for machine ${machine} in control/ci-rates.json`);
  const startSec = Number(env.CI_START ?? readFileSync(join(ROOT, '.ci-start'), 'utf8').trim());
  if (!Number.isFinite(startSec)) throw new Error('Build start time is missing; the first build step writes .ci-start');
  const minutes = Math.max(0, (now / 1000 - startSec) / 60);
  return {
    buildId: env.BUILD_ID || 'local',
    commit: env.COMMIT || 'manual',
    kind: env.CI_KIND === 'nightly' ? 'nightly' : env.BUILD_ID ? 'push' : 'manual',
    machine,
    ratePerMin: rate,
    rateChecked: rates.checked,
    startedAt: new Date(startSec * 1000).toISOString(),
    finishedAt: new Date(now).toISOString(),
    minutes: Math.round(minutes * 100) / 100,
    costUsd: Math.round(minutes * rate * 10000) / 10000,
  };
}

export function readHistory(path = join(OUT, 'ci-costs.jsonl')): CiRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CiRun);
}

if (process.argv[1]?.endsWith('ci-cost.ts')) {
  mkdirSync(OUT, { recursive: true });
  const run = measure(process.env);
  writeFileSync(join(OUT, 'ci-cost.json'), JSON.stringify(run) + '\n');
  appendFileSync(join(OUT, 'ci-costs.jsonl'), JSON.stringify(run) + '\n');
  console.log(`factory run ${run.buildId}: ${run.minutes} min on ${run.machine} at $${run.ratePerMin}/min = $${run.costUsd.toFixed(4)}`);
}
