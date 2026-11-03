import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EvidenceStore } from '@zthr/evidence';
import { loadCards } from '@zthr/intent';
import { CONTROL, JOURNEY_DIR, OUT } from './lib.js';

/**
 * Phase certificates. A phase is certified at a commit when, in that build: every gate passed with a valid proof,
 * every journey card for the phase (and every earlier phase) passed in every mode and channel, both walks reached
 * their fixpoint with no violations, every campus contract probe passed, and mutation is at or above its floor.
 * Anything not measured in the build makes the phase "not certified", with the reason; it never counts as a pass.
 */
type Check = { check: string; status: 'pass' | 'fail' | 'not measured'; detail: string };
const read = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined);
let commit = 'uncommitted';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* not a checkout */
}

const ev = new EvidenceStore(`${OUT}/evidence.db`);
const latest = (kind: string) => {
  const m = new Map<string, Record<string, unknown>>();
  for (const e of ev.events(kind)) m.set(e.subject, e.data);
  return m;
};
const gates = latest('gate');
const proofs = (read<{ gate: string; valid: boolean }[]>(`${CONTROL}/proofs.json`) ?? []);
const journeys = latest('journey_run');
type Walk = { violations: unknown[]; exhausted: boolean; states: number; commit?: string; only?: string[] };
const explore = read<Walk>(`${OUT}/explore.json`);
const crawl = read<Walk>(`${OUT}/crawl.json`);
const contract = read<{ results: { ok: boolean }[] }>(`${OUT}/contract.json`);
const mutation = read<{ files: Record<string, { mutants: { status: string }[] }> }>('reports/mutation.json');
const floor = (read<{ id: string; floor: number }[]>(`${CONTROL}/ratchets.json`) ?? []).find((r) => r.id === 'mutation-score')?.floor;

const shared: Check[] = [];
const failingGates = [...gates].filter(([, d]) => d.status !== 'pass').map(([g]) => g);
shared.push(gates.size ? { check: 'gates', status: failingGates.length ? 'fail' : 'pass', detail: failingGates.length ? `failing: ${failingGates.join(', ')}` : `${gates.size} gates pass` } : { check: 'gates', status: 'not measured', detail: 'no gate run recorded' });
const invalid = proofs.filter((p) => !p.valid).map((p) => p.gate);
shared.push({ check: 'gate proofs', status: proofs.length && !invalid.length ? 'pass' : proofs.length ? 'fail' : 'not measured', detail: invalid.length ? `invalid: ${invalid.join(', ')}` : `${proofs.length} proofs valid` });
for (const [name, w] of [['button walk', explore], ['page walk', crawl]] as const) {
  if (!w) shared.push({ check: name, status: 'not measured', detail: 'not run in this build' });
  else if (w.commit !== commit) shared.push({ check: name, status: 'not measured', detail: `report is from ${w.commit ?? 'an unrecorded commit'}, not ${commit}` });
  else if (w.only && w.only.length < 12) shared.push({ check: name, status: 'not measured', detail: `walked ${w.only.length} of 12 students` });
  else shared.push({ check: name, status: w.violations.length || !w.exhausted ? 'fail' : 'pass', detail: `${w.states.toLocaleString('en-US')} states, ${w.violations.length} violations, ${w.exhausted ? 'every seed exhausted' : 'cut short'}` });
}
shared.push(contract ? { check: 'campus contracts', status: contract.results.every((r) => r.ok) ? 'pass' : 'fail', detail: `${contract.results.filter((r) => r.ok).length} of ${contract.results.length} probes` } : { check: 'campus contracts', status: 'not measured', detail: 'not run' });
if (mutation && floor !== undefined) {
  const all = Object.values(mutation.files).flatMap((f) => f.mutants);
  const killed = all.filter((m) => ['Killed', 'Timeout'].includes(m.status)).length;
  const valid = all.filter((m) => !['CompileError', 'RuntimeError', 'Ignored'].includes(m.status)).length;
  const score = (killed / valid) * 100;
  shared.push({ check: 'mutation', status: score >= floor ? 'pass' : 'fail', detail: `${score.toFixed(1)}% against a floor of ${floor}%` });
} else shared.push({ check: 'mutation', status: 'not measured', detail: 'mutation runs nightly' });

const cards = loadCards(JOURNEY_DIR);
const certificates = [1, 2, 3, 4].map((phase) => {
  const mine = cards.filter((c) => c.phase <= phase);
  const results = mine.map((c) => ({ id: c.id, status: (journeys.get(c.id)?.status as string | undefined) ?? 'not measured' }));
  const bad = results.filter((r) => r.status !== 'pass');
  const checks: Check[] = [...shared, { check: `journeys for phases 1 to ${phase}`, status: bad.some((r) => r.status === 'fail') ? 'fail' : bad.length ? 'not measured' : 'pass', detail: bad.length ? `${bad.length} not passing: ${bad.slice(0, 4).map((r) => r.id).join(', ')}` : `${results.length} journeys pass` }];
  return { phase, commit, at: new Date().toISOString(), certified: checks.every((c) => c.status === 'pass'), checks };
});
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/certificates.json`, JSON.stringify(certificates, null, 1));
for (const c of certificates) {
  console.log(`phase ${c.phase} at ${c.commit}: ${c.certified ? 'CERTIFIED' : 'not certified'}`);
  for (const k of c.checks) console.log(`   ${k.status.padEnd(13)} ${k.check}: ${k.detail}`);
}
