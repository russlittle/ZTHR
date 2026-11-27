/**
 * Backstop: compare current results with the last committed ones. Fails if a block's score dropped or a previously
 * killed mutant survives again. Also writes a floors proposal for a person to sign (never into control/).
 *   node tools/mutation/ratchet.ts [block...]     (default: every block with a result file)
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, ROOT, compareResults, floorsProposal, git, loadResult, loadRulings, rel, remaining, rulingsPath, type BlockResult } from './lib.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

export function committed(block: string): BlockResult | undefined {
  const r = git(['show', `HEAD:intent/eval/mutation/${block}.json`]);
  return r.ok ? (JSON.parse(r.out) as BlockResult) : undefined;
}

if (import.meta.main) {
  let blocks = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!blocks.length) blocks = readdirSync(RESULTS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  const regressions = blocks.flatMap((b) => {
    const cur = loadResult(b);
    return cur ? compareResults(committed(b), cur) : [];
  });
  const rows = blocks.flatMap((b) => {
    const cur = loadResult(b);
    if (!cur) return [];
    const left = remaining(cur, loadRulings(b)).length;
    return [{ block: b, score: cur.score, survivors: cur.survivors.length, equivalents: cur.survivors.length - left }];
  });
  const date = new Date().toISOString().slice(0, 10);
  const dir = join(ROOT, 'tools', 'mutation', 'proposals');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `mutation-floors-${date}.md`);
  writeFileSync(path, floorsProposal(date, rows));
  console.log(JSON.stringify({ ok: regressions.length === 0, checked: blocks.length, regressions, proposal: rel(path), note: 'control/ is person-only; a person moves and signs the proposal' }, null, 2));
  process.exit(regressions.length ? 1 : 0);
}
