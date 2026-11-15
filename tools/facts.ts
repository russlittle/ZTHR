/**
 * The facts public material states, from their one source (tools/facts-core.ts explains the markers).
 *
 *   npx tsx tools/facts.ts            list every fact and where its markers are
 *   npx tsx tools/facts.ts --check    exit 1 when a marked repository fact is stale or a claim is unmarked
 *   npx tsx tools/facts.ts --write    rewrite every marked repository fact to its current value
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { FOUND_DAYTON } from '../apps/advocate/src/catalog/found/dayton.js';
import { DAYTON_CATALOG } from '../apps/advocate/src/catalog/dayton.js';
import { apply, check, unmarked, type Facts } from './facts-core.js';
import { CONTROL, OUT, ROOT } from './lib.js';

/** Public material: what a reader of the repository or zthr.ai sees stated as true. */
export const PUBLIC = ['README.md', 'writeups', 'docs'];

function files(p: string, ext = '.md'): string[] {
  const full = join(ROOT, p);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((f) => (f === 'node_modules' ? [] : statSync(join(full, f)).isDirectory() ? files(join(p, f), ext) : f.endsWith(ext) ? [join(full, f)] : []));
}
const lineCount = (fs: string[]) => fs.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
const json = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined);

export function repoFacts(): Facts {
  const ts = ['apps', 'packages', 'tools'].flatMap((d) => files(d, '.ts')).filter((f) => !f.includes('/catalog/found/'));
  const scope = JSON.parse(readFileSync(join(CONTROL, 'mutation-scope.json'), 'utf8')) as { dirs: string[]; files: string[]; except: Record<string, string> };
  const inScope = new Set([...scope.dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.ts')).map((f) => `${d}/${f}`)), ...scope.files].filter((f) => !(f in scope.except)));
  const features = parse(readFileSync(join(CONTROL, 'features.yaml'), 'utf8')) as { phases: { n: number }[] };
  const patterns = parse(readFileSync(join(CONTROL, 'patterns.yaml'), 'utf8')) as { patterns: unknown[] };
  const infra = new Set(['common.ts', 'contracts.ts', 'index.ts', 'main.ts']);
  const heldout = readFileSync(join(CONTROL, 'heldout', 'crisis.txt'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  return {
    guide_entries: { kind: 'repo', value: DAYTON_CATALOG.length },
    found_entries: { kind: 'repo', value: FOUND_DAYTON.length },
    found_systems: { kind: 'repo', value: new Set(FOUND_DAYTON.flatMap((r) => r.tags ?? []).filter((t) => t.startsWith('found:'))).size, style: 'word' },
    blocks: { kind: 'repo', value: readdirSync(join(ROOT, 'packages')).filter((d) => statSync(join(ROOT, 'packages', d)).isDirectory()).length, style: 'word' },
    campus_services: { kind: 'repo', value: readdirSync(join(ROOT, 'apps/campus-services/src')).filter((f) => f.endsWith('.ts') && !infra.has(f)).length, style: 'word' },
    phases: { kind: 'repo', value: features.phases.length, style: 'word' },
    gates: { kind: 'repo', value: (JSON.parse(readFileSync(join(CONTROL, 'proofs.json'), 'utf8')) as unknown[]).length },
    journeys: { kind: 'repo', value: readdirSync(join(CONTROL, 'journeys')).filter((f) => f.endsWith('.yaml')).length },
    patterns: { kind: 'repo', value: patterns.patterns.length },
    ts_lines: { kind: 'repo', value: lineCount(ts), style: 'hundred' },
    doc_lines: { kind: 'repo', value: lineCount(files('docs')), style: 'hundred' },
    mutation_modules: { kind: 'repo', value: inScope.size },
    heldout_crisis: { kind: 'repo', value: heldout.length },
  };
}

/** Facts measured by a run, from this build's evidence; absent evidence is "not measured". */
export function runFacts(out = OUT): Facts {
  const tests = json<{ numTotalTests: number; success: boolean }>(join(out, 'tests.json'));
  const red = json<{ results: { held: boolean }[] }>(join(out, 'redteam.json'));
  const deep = json<{ controls: number; maxDepth: number }>(join(out, 'deep', 'deep.json'));
  const ui = json<{ stops: unknown[] }>(join(out, 'ui', 'manifest.json'));
  const plan = json<{ valid: unknown[]; stale: unknown[] }>(join(out, 'explore-plan.json'));
  const walked = plan ? plan.valid.length : undefined;
  const students = plan ? plan.valid.length + plan.stale.length : undefined;
  return {
    tests_run: { kind: 'run', value: tests?.success ? tests.numTotalTests : undefined },
    redteam_held: { kind: 'run', value: red ? `${red.results.filter((r) => r.held).length.toLocaleString('en-US')} of ${red.results.length.toLocaleString('en-US')}` : undefined },
    controls_clicked: { kind: 'run', value: deep?.controls },
    deep_screens: { kind: 'run', value: deep?.maxDepth, style: 'word' },
    browser_stops: { kind: 'run', value: ui?.stops.length },
    walk_claim: {
      kind: 'run',
      value: walked === undefined ? undefined : walked === students ? 'every button walked for every student' : `every button walked to a fixpoint for ${walked} of ${students} students so far`,
    },
  };
}

export const allFacts = (out = OUT): Facts => ({ ...repoFacts(), ...runFacts(out) });

export function publicFiles(): string[] {
  return PUBLIC.flatMap((p) => files(p));
}

const isMain = process.argv[1] && import.meta.url.endsWith(relative(ROOT, process.argv[1]).replace(/\\/g, '/'));
if (isMain) {
  const mode = process.argv[2];
  const facts = allFacts();
  let bad = 0;
  for (const f of publicFiles()) {
    const text = readFileSync(f, 'utf8');
    if (mode === '--write') {
      const next = apply(text, facts, ['repo']);
      if (next !== text) {
        writeFileSync(f, next);
        console.log(`updated ${relative(ROOT, f)}`);
      }
      continue;
    }
    for (const m of check(text, facts)) {
      bad++;
      console.log(`STALE ${relative(ROOT, f)}: ${m.fact} is written "${m.written}", now "${m.current}"`);
    }
    for (const u of unmarked(text)) {
      bad++;
      console.log(`UNMARKED ${relative(ROOT, f)}: "${u}" states a number with no source; mark it as a fact or drop the number`);
    }
  }
  if (!mode) for (const [k, v] of Object.entries(facts)) console.log(`${k.padEnd(18)} ${v.kind}  ${v.value ?? 'not measured'}`);
  if (mode === '--check' && bad) process.exit(1);
}
