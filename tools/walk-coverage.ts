import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WALK_DATA } from './closure.js';
import { OUT, ROOT, headCommit } from './lib.js';

/**
 * Walk only when the walk could see the change (regression test selection by coverage).
 *
 * A walk runs under coverage, which records every source line it executed. On a later commit, the change is
 * diffed against the walked commit: a walk is needed only if a hunk touches or borders a line the walk executed,
 * or changes a data file the app reads while running. Otherwise the earlier report is carried forward for this
 * commit, saying so. The nightly run walks everything regardless.
 *
 *   tsx tools/walk-coverage.ts record <walk> <c8 coverage-final.json>   keep the executed lines with the report
 *   tsx tools/walk-coverage.ts needed <walk> <dir with last report>     exit 0 if a walk is needed; else carry it
 *
 * <walk> is explore, crawl or crawl-settings.
 */
type Range = [number, number];
export interface WalkCoverage { commit: string; files: Record<string, Range[]> }

export interface Istanbul { statementMap: Record<string, { start: { line: number }; end: { line: number } }>; s: Record<string, number>; fnMap: Record<string, { loc: { start: { line: number }; end: { line: number } } }>; f: Record<string, number> }

/** Lines a walk executed, per file: executed statements, less the inside of functions that never ran. */
export function executedLines(cov: Record<string, Istanbul>): Record<string, Range[]> {
  const out: Record<string, Range[]> = {};
  for (const [abs, v] of Object.entries(cov)) {
    const file = relative(ROOT, abs);
    if (file.startsWith('..') || file.includes('node_modules')) continue;
    const lines = new Set<number>();
    for (const [k, n] of Object.entries(v.s)) if (n > 0) for (let l = v.statementMap[k]!.start.line; l <= v.statementMap[k]!.end.line; l++) lines.add(l);
    // A function that never ran: its body lines did not run either, though an enclosing statement spans them.
    for (const [k, n] of Object.entries(v.f)) if (n === 0) for (let l = v.fnMap[k]!.loc.start.line + 1; l < v.fnMap[k]!.loc.end.line; l++) lines.delete(l);
    if (lines.size) out[file] = toRanges([...lines].sort((a, b) => a - b));
  }
  return out;
}

const toRanges = (ls: number[]): Range[] => ls.reduce<Range[]>((r, l) => (r.length && r[r.length - 1]![1] === l - 1 ? (r[r.length - 1]![1] = l, r) : (r.push([l, l]), r)), []);
const hits = (ranges: Range[], a: number, b: number) => ranges.some(([x, y]) => x <= b && y >= a);

/** Hunks of a unified diff with no context: file, and the old line range each hunk replaces. */
export function hunks(diff: string): { file: string; start: number; count: number }[] {
  const out: { file: string; start: number; count: number }[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    const f = line.match(/^--- (?:a\/)?(.+)$/);
    if (f) file = f[1] === '/dev/null' ? '' : f[1]!;
    const n = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (n && !file) file = n[1]!;
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? /);
    if (h && file) out.push({ file, start: Number(h[1]), count: h[2] === undefined ? 1 : Number(h[2]) });
  }
  return out;
}

/** Why a walk is needed for these changes, or undefined when none of them can change what the walk saw. */
export function walkNeeded(cov: WalkCoverage, changes: { file: string; start: number; count: number }[]): string | undefined {
  for (const c of changes) {
    if (WALK_DATA.some((d) => c.file === d || c.file.startsWith(`${d}/`))) return `${c.file} is data the app reads while it runs`;
    const r = cov.files[c.file];
    if (!r) continue;
    // A replacement touches lines start..start+count-1; an insertion (count 0) sits between start and start+1.
    const [a, b] = c.count === 0 ? [c.start, c.start + 1] : [c.start - 1, c.start + c.count];
    if (hits(r, a, b)) return `${c.file} changed at line ${c.start}, which the walk executed`;
  }
  return undefined;
}

if (process.argv[1]?.endsWith('walk-coverage.ts')) {
  const [cmd, walk, arg] = process.argv.slice(2);
  mkdirSync(OUT, { recursive: true });
  if (cmd === 'record') {
    const cov: WalkCoverage = { commit: headCommit(), files: executedLines(JSON.parse(readFileSync(arg!, 'utf8')) as Record<string, Istanbul>) };
    writeFileSync(join(OUT, `${walk}-coverage.json`), JSON.stringify(cov));
    console.log(`${walk}: ${Object.keys(cov.files).length} files executed, recorded for ${cov.commit}`);
  } else if (cmd === 'needed') {
    const lastReport = join(arg!, `${walk}.json`);
    const lastCov = join(arg!, `${walk}-coverage.json`);
    if (!existsSync(lastReport) || !existsSync(lastCov)) {
      console.log(`${walk}: no earlier walk with coverage; walking`);
      process.exit(0);
    }
    const cov = JSON.parse(readFileSync(lastCov, 'utf8')) as WalkCoverage;
    const report = JSON.parse(readFileSync(lastReport, 'utf8')) as { commit?: string; carried?: { from: string } };
    let diff: string;
    try {
      // A build may hold only its own commit; fetch the walked one so the two can be compared.
      try {
        execFileSync('git', ['cat-file', '-e', `${cov.commit}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
      } catch {
        execFileSync('git', ['fetch', '-q', 'origin', cov.commit], { cwd: ROOT, stdio: 'ignore' });
      }
      diff = execFileSync('git', ['diff', '-U0', '--no-color', cov.commit, 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    } catch {
      console.log(`${walk}: cannot diff against ${cov.commit}; walking`);
      process.exit(0);
    }
    const why = walkNeeded(cov, hunks(diff));
    if (why) {
      console.log(`${walk}: walking, because ${why}`);
      process.exit(0);
    }
    const from = report.carried?.from ?? report.commit ?? cov.commit;
    writeFileSync(join(OUT, `${walk}.json`), JSON.stringify({ ...report, commit: headCommit(), carried: { from, reason: `no change since ${from.slice(0, 7)} touches a line the walk executed` } }, null, 1));
    copyFileSync(lastCov, join(OUT, `${walk}-coverage.json`));
    console.log(`${walk}: carried forward from ${from.slice(0, 7)}; nothing the walk executed has changed`);
    process.exit(10);
  }
}
