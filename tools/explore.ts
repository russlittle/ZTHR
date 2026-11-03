import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ExploreReport } from '@zthr/explore';
import { exploreAdvocate } from '../apps/advocate/test/harness/world.js';
import { PERSONA_NAMES } from '../apps/advocate/src/server/demo.js';
import { OUT } from './lib.js';

/**
 * Run the button walk and write the report.
 *   tsx tools/explore.ts                 every student, one process per student, as many at once as there are CPUs
 *   tsx tools/explore.ts Maria,Sam       only these
 *   --no-typing  --max N  --serial
 */
const args = process.argv.slice(2);
const only = args[0] && !args[0].startsWith('--') ? args[0].split(',') : undefined;
const max = Number(args[args.indexOf('--max') + 1]) || undefined;
const typing = !args.includes('--no-typing');
const childOut = args.includes('--child') ? args[args.indexOf('--child') + 1] : undefined;
const t0 = Date.now();

async function runParallel(names: string[]): Promise<ExploreReport> {
  mkdirSync(`${OUT}/explore`, { recursive: true });
  const queue = [...names];
  const width = Math.max(1, cpus().length);
  const results: ExploreReport[] = [];
  await Promise.all(
    Array.from({ length: Math.min(width, queue.length) }, async () => {
      while (queue.length) {
        const name = queue.shift()!;
        const file = `${OUT}/explore/${name}.json`;
        await new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, [...process.execArgv, process.argv[1]!, name, '--child', file, ...(typing ? [] : ['--no-typing']), ...(max ? ['--max', String(max)] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
          p.on('exit', (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(`${name} walk exited ${code}`))));
        });
        results.push(JSON.parse(readFileSync(file, 'utf8')) as ExploreReport);
        console.log(`  ${name} done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    }),
  );
  const merged: ExploreReport = { seeds: [], states: 0, transitions: 0, actionsSeen: [], verbsSeen: {}, violations: [], exhausted: true };
  for (const r of results) {
    merged.seeds.push(...r.seeds);
    merged.states += r.states;
    merged.transitions += r.transitions;
    merged.violations.push(...r.violations);
    merged.exhausted &&= r.exhausted;
    merged.actionsSeen.push(...r.actionsSeen);
    for (const [k, v] of Object.entries(r.verbsSeen)) merged.verbsSeen[k] = (merged.verbsSeen[k] ?? 0) + v;
  }
  merged.actionsSeen = [...new Set(merged.actionsSeen)].sort();
  merged.seeds.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

if (childOut) {
  const r = exploreAdvocate({ only, maxNodes: max, withTyping: typing });
  writeFileSync(childOut, JSON.stringify(r));
  process.exit(r.violations.length || !r.exhausted ? 1 : 0);
}

const names = only ?? PERSONA_NAMES;
const r = args.includes('--serial') || names.length === 1 ? exploreAdvocate({ only: names, maxNodes: max, withTyping: typing }) : await runParallel(names);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/explore.json`, JSON.stringify({ ...r, ms: Date.now() - t0 }, null, 1));
for (const s of r.seeds) console.log(`${s.name.padEnd(22)} states ${String(s.states).padStart(6)}  transitions ${String(s.transitions).padStart(7)}  depth ${s.maxDepth}  ${s.exhausted ? 'exhausted' : 'CUT SHORT'}`);
const byProblem = new Map<string, { n: number; path: string[]; seed: string }>();
for (const v of r.violations) {
  const k = v.problem.replace(/[0-9a-f]{8}/g, '*').slice(0, 160);
  const e = byProblem.get(k);
  if (e) e.n++;
  else byProblem.set(k, { n: 1, path: v.path, seed: v.seed });
}
console.log(`\n${r.states} states, ${r.transitions} transitions, ${r.actionsSeen.length} distinct actions, ${Object.keys(r.verbsSeen).length} verbs, ${r.violations.length} violations (${byProblem.size} kinds), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [k, e] of [...byProblem].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) console.log(`${String(e.n).padStart(5)}  ${k}\n       ${e.seed}: ${e.path.join(' > ')}`);
process.exit(r.violations.length || !r.exhausted ? 1 : 0);
