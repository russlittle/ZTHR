import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONA_NAMES } from '../apps/advocate/src/server/demo.js';
import { executedLines, hunks, walkNeeded, type Istanbul, type WalkCoverage } from './walk-coverage.js';
import { OUT, ROOT, headCommit } from './lib.js';

/**
 * The walk rotation. Each night a few students are walked to a fixpoint under coverage and each is saved on its own,
 * with the lines its walk executed. A student's walk stays valid for later commits until a change touches a line it
 * executed (or data the app reads); a phase certifies when every student has a valid full walk. Tonight's students
 * are the ones whose walks are no longer valid, then the ones walked longest ago.
 *
 *   tsx tools/walk-rotation.ts plan <walk> <saved dir> [n]   which students are valid, which stale; tonight's n
 *   tsx tools/walk-rotation.ts record <walk> <coverage-final.json>   split tonight's report into per-student walks
 *   tsx tools/walk-rotation.ts assemble <walk> <saved dir>   one report for this commit from every valid walk
 *
 * <walk> is explore or crawl. Saved walks live in <saved dir>/<walk>/<Student>.json with <Student>-coverage.json.
 */
type Seed = { name: string; states: number; transitions: number; maxDepth: number; exhausted: boolean };
type Report = { seeds: Seed[]; states: number; transitions: number; violations: { seed: string; path: string[]; problem: string }[]; verbsSeen: Record<string, number>; actionsSeen?: string[]; exhausted: boolean; commit?: string; only?: string[]; ms?: number; routes?: string[] };
export type StudentWalk = Report & { student: string; commit: string; walkedAt: string };

const owner = (seed: string) => seed.split('/')[0]!;

/** One night's report, split into a walk per student (seeds and violations are named for their student). */
export function splitByStudent(r: Report, commit: string, walkedAt: string): StudentWalk[] {
  const students = [...new Set(r.seeds.map((s) => owner(s.name)))];
  return students.map((student) => {
    const seeds = r.seeds.filter((s) => owner(s.name) === student);
    return { student, commit, walkedAt, seeds, states: seeds.reduce((n, s) => n + s.states, 0), transitions: seeds.reduce((n, s) => n + s.transitions, 0), violations: r.violations.filter((v) => owner(v.seed) === student), verbsSeen: r.verbsSeen, ...(r.actionsSeen ? { actionsSeen: r.actionsSeen } : {}), ...(r.routes ? { routes: r.routes } : {}), exhausted: seeds.every((s) => s.exhausted) };
  });
}

/** Valid: a clean full walk whose executed lines no change has touched since. Stale: everything else, oldest first. */
export function plan(saved: Map<string, { walk: StudentWalk; cov: WalkCoverage; changes: ReturnType<typeof hunks> | undefined }>, students: string[], n: number) {
  const valid: { student: string; from: string }[] = [];
  const stale: { student: string; why: string; walkedAt: string }[] = [];
  for (const s of students) {
    const e = saved.get(s);
    if (!e) stale.push({ student: s, why: 'never walked in full', walkedAt: '' });
    else if (!e.walk.exhausted || e.walk.violations.length) stale.push({ student: s, why: 'last full walk did not pass', walkedAt: e.walk.walkedAt });
    else if (!e.changes) stale.push({ student: s, why: `cannot compare with ${e.cov.commit.slice(0, 7)}`, walkedAt: e.walk.walkedAt });
    else {
      const why = walkNeeded(e.cov, e.changes);
      if (why) stale.push({ student: s, why, walkedAt: e.walk.walkedAt });
      else valid.push({ student: s, from: e.walk.commit });
    }
  }
  const byAge = (a: { walkedAt: string }, b: { walkedAt: string }) => a.walkedAt.localeCompare(b.walkedAt);
  stale.sort(byAge);
  const oldestValid = valid.map((v) => ({ ...v, walkedAt: saved.get(v.student)!.walk.walkedAt })).sort(byAge);
  const tonight = [...stale.map((s) => s.student), ...oldestValid.map((v) => v.student)].slice(0, n);
  return { valid, stale, tonight };
}

/** One report for this commit: every valid walk, carried, with the students it covers. */
export function assemble(walks: StudentWalk[], commit: string, carriedFrom: Record<string, string>): Report & { commit: string; only: string[]; students: Record<string, { walkedAt: string; commit: string; carried: boolean }> } {
  const verbs: Record<string, number> = {};
  for (const w of walks) for (const [k, v] of Object.entries(w.verbsSeen)) verbs[k] = Math.max(verbs[k] ?? 0, v);
  return {
    seeds: walks.flatMap((w) => w.seeds).sort((a, b) => a.name.localeCompare(b.name)),
    states: walks.reduce((n, w) => n + w.states, 0),
    transitions: walks.reduce((n, w) => n + w.transitions, 0),
    violations: walks.flatMap((w) => w.violations),
    verbsSeen: verbs,
    actionsSeen: [...new Set(walks.flatMap((w) => w.actionsSeen ?? []))].sort(),
    routes: [...new Set(walks.flatMap((w) => w.routes ?? []))].sort(),
    exhausted: walks.length > 0 && walks.every((w) => w.exhausted),
    commit,
    only: walks.map((w) => w.student),
    students: Object.fromEntries(walks.map((w) => [w.student, { walkedAt: w.walkedAt, commit: w.commit, carried: !!carriedFrom[w.student] }])),
  };
}

function loadSaved(dir: string, walk: string) {
  const d = join(dir, walk);
  const out = new Map<string, { walk: StudentWalk; cov: WalkCoverage; changes: ReturnType<typeof hunks> | undefined }>();
  if (!existsSync(d)) return out;
  const diffs = new Map<string, ReturnType<typeof hunks> | undefined>();
  for (const f of readdirSync(d).filter((x) => x.endsWith('.json') && !x.endsWith('-coverage.json'))) {
    const walkFile = JSON.parse(readFileSync(join(d, f), 'utf8')) as StudentWalk;
    const covFile = join(d, f.replace(/\.json$/, '-coverage.json'));
    if (!existsSync(covFile)) continue;
    const cov = JSON.parse(readFileSync(covFile, 'utf8')) as WalkCoverage;
    if (!diffs.has(cov.commit)) diffs.set(cov.commit, diffSince(cov.commit));
    out.set(walkFile.student, { walk: walkFile, cov, changes: diffs.get(cov.commit) });
  }
  return out;
}

function diffSince(commit: string): ReturnType<typeof hunks> | undefined {
  try {
    try {
      execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    } catch {
      execFileSync('git', ['fetch', '-q', 'origin', commit], { cwd: ROOT, stdio: 'ignore' });
    }
    return hunks(execFileSync('git', ['diff', '-U0', '--no-color', commit, 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    return undefined;
  }
}

if (process.argv[1]?.endsWith('walk-rotation.ts')) {
  const [cmd, walk, arg, nArg] = process.argv.slice(2) as [string, string, string, string?];
  mkdirSync(OUT, { recursive: true });
  if (cmd === 'plan') {
    const p = plan(loadSaved(arg, walk), PERSONA_NAMES, Number(nArg ?? 4));
    writeFileSync(join(OUT, `${walk}-plan.json`), JSON.stringify(p, null, 1));
    writeFileSync(join(OUT, `${walk}-tonight.txt`), p.tonight.join(','));
    console.log(`${walk}: ${p.valid.length} of ${PERSONA_NAMES.length} students have a valid full walk; tonight: ${p.tonight.join(', ') || 'none'}`);
    for (const s of p.stale) console.log(`  stale ${s.student}: ${s.why}`);
    // Exit 10 when every student's walk is still valid: nothing to walk.
    process.exit(p.stale.length ? 0 : 10);
  } else if (cmd === 'record') {
    const report = JSON.parse(readFileSync(join(OUT, `${walk}.json`), 'utf8')) as Report;
    const cov: WalkCoverage = { commit: headCommit(), files: executedLines(JSON.parse(readFileSync(arg, 'utf8')) as Record<string, Istanbul>) };
    const dir = join(OUT, 'walks', walk);
    mkdirSync(dir, { recursive: true });
    // Tonight's coverage is the union over tonight's students: a little wider than each one's, so it errs toward walking.
    for (const w of splitByStudent(report, headCommit(), new Date().toISOString())) {
      writeFileSync(join(dir, `${w.student}.json`), JSON.stringify(w));
      writeFileSync(join(dir, `${w.student}-coverage.json`), JSON.stringify(cov));
    }
    console.log(`${walk}: saved full walks for ${splitByStudent(report, '', '').map((w) => w.student).join(', ')}`);
  } else if (cmd === 'assemble') {
    // Fresh walks from tonight (evidence-out/walks) take precedence over saved ones.
    const fresh = loadSaved(join(OUT, 'walks'), walk);
    const saved = loadSaved(arg, walk);
    const p = plan(saved, PERSONA_NAMES, 0);
    const walks: StudentWalk[] = [];
    const carried: Record<string, string> = {};
    for (const s of PERSONA_NAMES) {
      const f = fresh.get(s);
      if (f) walks.push(f.walk);
      else if (p.valid.some((v) => v.student === s)) {
        walks.push(saved.get(s)!.walk);
        carried[s] = saved.get(s)!.walk.commit;
      }
    }
    const r = assemble(walks, headCommit(), carried);
    writeFileSync(join(OUT, `${walk}.json`), JSON.stringify(r, null, 1));
    console.log(`${walk}: ${r.only.length} of ${PERSONA_NAMES.length} students covered for ${r.commit} (${Object.keys(carried).length} carried forward, ${r.only.length - Object.keys(carried).length} walked tonight)`);
  }
}
