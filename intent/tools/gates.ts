/**
 * The proven gates: every structural gate the intent factory relies on, run on this tree, with its proof. A gate
 * counts only while its planted defects still make it fail, so each gate names the tests that plant them, and how
 * many there must be at least: a proof that matches no test, or fewer than it did, fails the run instead of passing
 * quietly. Gates with a check of their own (the secret scan) run it on the tree as well.
 *
 *   npm run gates                    every gate, its check and its proof; exits 1 on any failure
 *   npm run gates -- --only ledger   one gate
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Gate {
  readonly id: string;
  readonly what: string;
  /** A command run on the tree from the intent folder; it must exit 0. */
  readonly check?: readonly string[];
  /** The tests that plant this gate's defects, by file and test-name pattern, and how many there must be at least. */
  readonly proof: { readonly file: string; readonly pattern: string; readonly min: number };
}

export const GATES: readonly Gate[] = [
  { id: 'secrets', what: 'No credential in the files or the history', check: ['node', 'tools/secret-scan.ts'], proof: { file: 'test/secret-scan.test.ts', pattern: 'caught', min: 2 } },
  { id: 'person-only', what: 'What only a person does has no agent tool', proof: { file: 'test/agents.test.ts', pattern: 'what only a person does has no tool', min: 1 } },
  { id: 'person-acts', what: 'A person’s act is that person’s SSH signature over the exact act; a name is not enough', proof: { file: 'test/person-acts.test.ts', pattern: '^planted', min: 5 } },
  { id: 'admission', what: 'Admission counts two families bound to the model calls their verdicts came from', proof: { file: 'test/admission-evidence.test.ts', pattern: '^planted', min: 4 } },
  { id: 'ledger', what: 'The ledger is keyed, and checked against its published anchors', proof: { file: 'test/ledger-anchors.test.ts', pattern: '^planted', min: 3 } },
  { id: 'goalposts', what: 'Locked intent, people and floors change only in a commit a person signed; fails closed', proof: { file: 'test/goalposts.test.ts', pattern: '^planted', min: 5 } },
  { id: 'live-rules', what: 'GitHub’s live branch rules match the committed expectation', proof: { file: 'test/live-rules.test.ts', pattern: '^planted', min: 3 } },
  { id: 'stop-the-line', what: 'A red required check stops new work on its branch until the fix names it', proof: { file: 'test/stop-line.test.ts', pattern: '^planted', min: 1 } },
];

export interface GateResult {
  readonly id: string;
  readonly ok: boolean;
  readonly passed: number;
  readonly why: string;
}

/** The proof's tests, by title, read from the file: what the pattern must still match. */
export const proofTitles = (root: string, g: Gate): string[] => {
  const p = join(root, g.proof.file);
  if (!existsSync(p)) return [];
  const re = new RegExp(g.proof.pattern);
  return [...readFileSync(p, 'utf8').matchAll(/^test\(\s*'((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1]!).filter((t) => re.test(t));
};

/** Run one gate: its check, then its proof. */
export function runGate(root: string, g: Gate): GateResult {
  if (g.check) {
    const c = spawnSync(g.check[0]!, g.check.slice(1), { cwd: root, encoding: 'utf8', timeout: 10 * 60_000 });
    if (c.status !== 0) return { id: g.id, ok: false, passed: 0, why: `its check failed: ${`${c.stdout}\n${c.stderr}`.trim().split('\n').slice(-3).join(' / ')}` };
  }
  const titles = proofTitles(root, g);
  if (titles.length < g.proof.min) return { id: g.id, ok: false, passed: 0, why: `its proof has ${titles.length} planted test(s) in ${g.proof.file}, fewer than the ${g.proof.min} it must keep` };
  // A runner started from inside another test run reports to its parent instead of printing; this one must print.
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${g.proof.pattern}`, g.proof.file], { cwd: root, encoding: 'utf8', timeout: 10 * 60_000, env });
  const count = (k: string) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(r.stdout)?.[1] ?? 'NaN');
  const [pass, fail] = [count('pass'), count('fail')];
  if (r.status !== 0 || fail !== 0) return { id: g.id, ok: false, passed: Number.isNaN(pass) ? 0 : pass, why: `its proof failed: ${Number.isNaN(fail) ? 'the test run did not report' : `${fail} planted test(s) failed`}` };
  if (!(pass >= g.proof.min)) return { id: g.id, ok: false, passed: Number.isNaN(pass) ? 0 : pass, why: `its proof ran ${Number.isNaN(pass) ? 'no' : pass} planted test(s), fewer than ${g.proof.min}` };
  return { id: g.id, ok: true, passed: pass, why: `${pass} planted defect test(s) refused` };
}

export function runGates(root: string, gates: readonly Gate[] = GATES, say: (s: string) => void = console.log): number {
  let failed = 0;
  for (const g of gates) {
    const r = runGate(root, g);
    if (!r.ok) failed++;
    say(`${r.ok ? 'proven ' : 'FAILED '} ${g.id.padEnd(14)} ${g.what}: ${r.why}`);
  }
  say(failed ? `${failed} of ${gates.length} gate(s) failed` : `all ${gates.length} gates proven`);
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? process.argv[i + 1] : undefined;
  const gates = only ? GATES.filter((g) => g.id === only) : GATES;
  if (!gates.length) {
    console.error(`no gate ${only ?? ''}; the gates are ${GATES.map((g) => g.id).join(', ')}`);
    process.exit(2);
  }
  process.exit(runGates(fileURLToPath(new URL('..', import.meta.url)), gates));
}
