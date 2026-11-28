/**
 * Record an equivalence claim, or record that no simplification exists for a ruled-equivalent mutant.
 *   node tools/mutation/equivalent.ts <block> <mutantId> --argument "..." --by <model> --judge <model> --verdict equivalent|not-equivalent|unsure
 *   node tools/mutation/equivalent.ts --stands <block> <mutantId> --reason "..." --by <model>
 * Only an "equivalent" verdict from a judge of a different model family than the claimant counts (status "equivalent");
 * anything else leaves the status "disputed" and the survivor stays on the queue.
 */
import { loadResult, loadRulings, modelFamily, mutantKey, rule, rulingsPath, writeJson, type Mutant, type Ruling, type Verdict } from './lib.ts';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function upsert(rulings: Ruling[], r: Ruling): Ruling[] {
  return [...rulings.filter((x) => x.key !== r.key), r];
}

export function claim(block: string, mutant: Mutant, o: { argument: string; by: string; judge: string; verdict: Verdict; at?: string }, prior: Ruling[]): { rulings: Ruling[]; ruling: Ruling } {
  const key = mutantKey(mutant);
  const old = prior.find((x) => x.key === key);
  const ruling: Ruling = { block, mutant, key, argument: o.argument, by: o.by, judge: o.judge, verdict: o.verdict, status: rule(o.verdict, o.by, o.judge), at: o.at ?? new Date().toISOString(), ...(old?.simplify && rule(o.verdict, o.by, o.judge) === 'equivalent' ? { simplify: old.simplify } : {}) };
  return { rulings: upsert(prior, ruling), ruling };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const stands = args.includes('--stands');
  const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
  const [block, id] = pos;
  if (!block || !id) {
    console.error('usage: equivalent.ts <block> <mutantId> --argument ... --by <model> --judge <model> --verdict equivalent|not-equivalent|unsure\n       equivalent.ts --stands <block> <mutantId> --reason ... --by <model>');
    process.exit(2);
  }
  const result = loadResult(block);
  const prior = loadRulings(block);
  const mutant = result?.survivors.find((m) => m.id === id) ?? prior.find((r) => r.mutant.id === id)?.mutant;
  if (!mutant) {
    console.error(`mutant ${id} is not a survivor of ${block} in the last run`);
    process.exit(2);
  }
  if (stands) {
    const old = prior.find((r) => r.key === mutantKey(mutant));
    if (!old || old.status !== 'equivalent') {
      console.error('--stands needs an accepted equivalent ruling for this mutant first');
      process.exit(2);
    }
    old.simplify = { status: 'none-possible', reason: flag(args, 'reason') ?? '', by: flag(args, 'by') ?? 'unknown', at: new Date().toISOString() };
    writeJson(rulingsPath(block), { block, rulings: upsert(prior, old) });
    console.log(JSON.stringify({ block, mutant: id, simplify: old.simplify }, null, 2));
    process.exit(0);
  }
  const verdict = flag(args, 'verdict') as Verdict | undefined;
  const by = flag(args, 'by');
  const judge = flag(args, 'judge');
  const argument = flag(args, 'argument');
  if (!verdict || !['equivalent', 'not-equivalent', 'unsure'].includes(verdict) || !by || !judge || !argument) {
    console.error('need --argument, --by, --judge and --verdict (equivalent|not-equivalent|unsure)');
    process.exit(2);
  }
  const { rulings, ruling } = claim(block, mutant, { argument, by, judge, verdict }, prior);
  writeJson(rulingsPath(block), { block, rulings });
  console.log(JSON.stringify({ block, mutant: id, status: ruling.status, claimantFamily: modelFamily(by), judgeFamily: modelFamily(judge), reason: ruling.status === 'equivalent' ? 'verdict equivalent from a different model family' : 'needs an "equivalent" verdict from a judge of a different family' }, null, 2));
}
