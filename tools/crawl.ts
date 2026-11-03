import { mkdirSync, writeFileSync } from 'node:fs';
import { crawlAdvocate } from '../apps/advocate/test/harness/crawl.js';
import { OUT } from './lib.js';

/** Run the feature walk over the web app. Usage: tsx tools/crawl.ts [Name,Name] */
const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].split(',') : undefined;
const t0 = Date.now();
const r = await crawlAdvocate({ only, settingsOnly: process.argv.includes('--settings') });
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/crawl.json`, JSON.stringify({ ...r, ms: Date.now() - t0 }, null, 1));
for (const s of r.seeds) console.log(`${s.name.padEnd(8)} pages-in-states ${String(s.states).padStart(5)}  links+forms ${String(s.transitions).padStart(6)}  depth ${s.maxDepth}  ${s.exhausted ? 'exhausted' : 'CUT SHORT'}`);
const kinds = new Map<string, { n: number; path: string[]; seed: string }>();
for (const v of r.violations) {
  const k = v.problem.replace(/\/s\/[a-z]+/, '/s/:id').replace(/m=msg_[0-9a-f]+/, 'm=*');
  const e = kinds.get(k);
  if (e) e.n++;
  else kinds.set(k, { n: 1, path: v.path, seed: v.seed });
}
console.log(`\n${r.routes.length} routes: ${r.routes.join(' ')}\n${r.states} page-states, ${r.transitions} links and forms followed, ${r.violations.length} violations (${kinds.size} kinds), ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [k, e] of [...kinds].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) console.log(`${String(e.n).padStart(5)}  ${k}\n       ${e.seed}: ${e.path.slice(-3).join(' > ').slice(0, 300)}`);
process.exit(r.violations.length || !r.exhausted ? 1 : 0);
