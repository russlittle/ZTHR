/**
 * After the nightly mutation run: every module in scope against its own floor, the next floors, and the survivors as
 * the next work (docs/testing/mutation.md).
 *
 *   npx tsx tools/mutation.ts [report] [last-floors]
 *
 * report       the Stryker JSON report (default reports/mutation.json)
 * last-floors  the floors the last nightly run wrote (default reports/last-floors.json; absent on the first run)
 *
 * Writes reports/mutation-floors.json and reports/mutation-survivors.json. Exits 1 when any module is under its floor.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResetEntry } from '@zthr/gates';
import { CONTROL, ROOT } from './lib.js';
import { judge, nextFloors, scores, survivors, type Floors, type Report } from './mutation-core.js';

const [reportPath = join(ROOT, 'reports/mutation.json'), lastPath = join(ROOT, 'reports/last-floors.json')] = process.argv.slice(2);
const read = <T>(p: string, d: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : d);
const report = read<Report | undefined>(reportPath, undefined);
if (!report) {
  console.error(`No mutation report at ${reportPath}.`);
  process.exit(1);
}
const repo = read<{ floors: Floors }>(join(CONTROL, 'mutation-floors.json'), { floors: {} }).floors;
const last = read<{ floors: Floors }>(lastPath, { floors: {} }).floors;
const ledgerPath = join(CONTROL, 'ratchet-resets.jsonl');
const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ResetEntry) : [];
const people = read<{ people: string[] }>(join(CONTROL, 'people.json'), { people: [] }).people;

const results = judge(scores(report), repo, last, ledger, people);
const left = survivors(report);
writeFileSync(join(ROOT, 'reports/mutation-floors.json'), JSON.stringify({ floors: nextFloors(results) }, null, 1));
writeFileSync(join(ROOT, 'reports/mutation-survivors.json'), JSON.stringify(left, null, 1));
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.file}: ${r.detail}${r.next > r.floor ? `; tightened to ${r.next}%` : ''}`);
console.log(`${left.length} surviving mutants, the next work: reports/mutation-survivors.json`);
if (results.some((r) => !r.ok)) process.exit(1);
