import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { crawlAdvocate } from '../apps/advocate/test/harness/crawl.js';
import { PERSONA_NAMES } from '../apps/advocate/src/server/demo.js';
import { OUT } from './lib.js';

/**
 * Run the feature walk over the web app: one process per student, as many at once as there are CPUs.
 *   tsx tools/crawl.ts [Name,Name] [--settings] [--serial]
 */
type Report = Awaited<ReturnType<typeof crawlAdvocate>>;
const args = process.argv.slice(2);
const only = args[0] && !args[0].startsWith('--') ? args[0].split(',') : undefined;
const settingsOnly = args.includes('--settings');
const childOut = args.includes('--child') ? args[args.indexOf('--child') + 1] : undefined;
const t0 = Date.now();

if (childOut) {
  const r = await crawlAdvocate({ only, settingsOnly });
  writeFileSync(childOut, JSON.stringify(r));
  process.exit(0);
}

async function runParallel(names: string[]): Promise<Report> {
  mkdirSync(`${OUT}/crawl`, { recursive: true });
  const queue = [...names];
  const results: Report[] = [];
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, cpus().length), queue.length) }, async () => {
      while (queue.length) {
        const name = queue.shift()!;
        const file = `${OUT}/crawl/${name}${settingsOnly ? '-settings' : ''}.json`;
        await new Promise<void>((resolve, reject) => {
          const p = spawn(process.execPath, [...process.execArgv, process.argv[1]!, name, '--child', file, ...(settingsOnly ? ['--settings'] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} crawl exited ${code}`))));
        });
        results.push(JSON.parse(readFileSync(file, 'utf8')) as Report);
        console.log(`  ${name} done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    }),
  );
  const merged: Report = { seeds: [], states: 0, transitions: 0, actionsSeen: [], verbsSeen: {}, violations: [], exhausted: true, routes: [] };
  for (const r of results) {
    merged.seeds.push(...r.seeds);
    merged.states += r.states;
    merged.transitions += r.transitions;
    merged.violations.push(...r.violations);
    merged.exhausted &&= r.exhausted;
    merged.routes.push(...r.routes);
    for (const [k, v] of Object.entries(r.verbsSeen)) merged.verbsSeen[k] = (merged.verbsSeen[k] ?? 0) + v;
  }
  merged.routes = [...new Set(merged.routes)].sort();
  merged.seeds.sort((a, b) => a.name.localeCompare(b.name));
  return merged;
}

const names = only ?? PERSONA_NAMES;
const r = args.includes('--serial') || names.length === 1 ? await crawlAdvocate({ only: names, settingsOnly }) : await runParallel(names);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/crawl${settingsOnly ? '-settings' : ''}.json`, JSON.stringify({ ...r, ms: Date.now() - t0 }, null, 1));
for (const s of r.seeds) console.log(`${s.name.padEnd(22)} page-states ${String(s.states).padStart(5)}  links+forms ${String(s.transitions).padStart(6)}  depth ${s.maxDepth}  ${s.exhausted ? 'exhausted' : 'CUT SHORT'}`);
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
