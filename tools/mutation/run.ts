/**
 * Find: run Stryker on each block and write intent/eval/mutation/<block>.json.
 *   node tools/mutation/run.ts <block...> [--incremental]
 * The headline per block is how many survivors REMAIN (not ruled equivalent). The goal is zero.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, blockSrc, loadRulings, remaining, resultPath, runStryker, writeJson, type BlockResult } from './lib.ts';

export function runBlock(block: string, o: { incremental?: boolean } = {}): BlockResult {
  if (!existsSync(blockSrc(block))) throw new Error(`no such block: ${block}`);
  const incrementalFile = o.incremental ? join(RESULTS, '.incremental', `${block}.json`) : undefined;
  const result = runStryker(block, { incrementalFile });
  writeJson(resultPath(block), result);
  return result;
}

export function headline(r: BlockResult): string {
  const rulings = loadRulings(r.block);
  const left = remaining(r, rulings).length;
  const eq = r.survivors.length - left;
  return `${r.block}: ${left} survivor${left === 1 ? '' : 's'} remaining${eq ? ` (+${eq} ruled equivalent)` : ''}  score ${r.score}%  [${r.killed} killed, ${r.timeout} timeout, ${r.survived} survived, ${r.noCoverage} no coverage, ${r.mutants} mutants]`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const incremental = args.includes('--incremental');
  const blocks = args.filter((a) => !a.startsWith('--'));
  if (!blocks.length) {
    console.error('usage: node tools/mutation/run.ts <block...> [--incremental]');
    process.exit(2);
  }
  let left = 0;
  for (const b of blocks) {
    const r = runBlock(b, { incremental });
    console.log(headline(r));
    left += remaining(r, loadRulings(b)).length;
  }
  if (blocks.length > 1) console.log(`TOTAL: ${left} survivors remaining`);
}
