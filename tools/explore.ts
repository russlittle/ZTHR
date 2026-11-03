import { mkdirSync, writeFileSync } from 'node:fs';
import { exploreAdvocate } from '../apps/advocate/test/harness/world.js';
import { OUT } from './lib.js';

/** Run the exhaustive walk and write the report. Usage: tsx tools/explore.ts [Name,Name] [--no-typing] [--max N] */
const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',') : undefined;
const max = Number(process.argv[process.argv.indexOf('--max') + 1]) || undefined;
const t0 = Date.now();
const r = exploreAdvocate({ only, maxNodes: max, withTyping: !process.argv.includes('--no-typing') });
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/explore.json`, JSON.stringify({ ...r, ms: Date.now() - t0 }, null, 1));
for (const s of r.seeds) console.log(`${s.name.padEnd(8)} states ${String(s.states).padStart(6)}  transitions ${String(s.transitions).padStart(7)}  depth ${s.maxDepth}  ${s.exhausted ? 'exhausted' : 'CUT SHORT'}`);
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
