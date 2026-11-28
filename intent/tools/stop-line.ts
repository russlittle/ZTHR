/**
 * Stop the line: fail a push when the branch's previous commit is red on a check the line stops on, unless a commit
 * in the push names the red check in a `Fixes-red: <check>` trailer.
 *
 *   GITHUB_TOKEN=… node tools/stop-line.ts --repo owner/name --branch b --before sha --after sha --expect file
 *
 * The checks are the branch's `stop_on` in the expectation file, or its required checks. Exits 1 when the line is
 * stopped, and when the previous commit's runs cannot be read.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { github, type Expectation, type Get } from '../src/governance/liverules.ts';
import { decide, runsOn } from '../src/governance/stopline.ts';

/** The messages of the commits in the push, read from git. */
export const messagesOf = (before: string, after: string, cwd = process.cwd()): string[] =>
  spawnSync('git', ['log', '--format=%B%x00', `${before}..${after}`], { cwd, encoding: 'utf8' }).stdout.split('\0').map((x) => x.trim()).filter(Boolean);

export async function main(argv: readonly string[], get: Get = github(process.env['GITHUB_TOKEN']), messages: (before: string, after: string) => string[] = messagesOf): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const [repo, branch, before, after, file] = ['repo', 'branch', 'before', 'after', 'expect'].map(flag);
  if (!repo || !branch || !after || !file) {
    console.error('--repo, --branch, --after and --expect are required');
    return 2;
  }
  const e = JSON.parse(readFileSync(file, 'utf8')) as Expectation;
  const b = e.branches[branch];
  const stopOn = (b?.stop_on ?? b?.required_checks ?? []).map((c) => c.replace(/ \(app \d+\)$/, ''));
  const previous = before && !/^0+$/.test(before) ? before : null;
  let runs: Awaited<ReturnType<typeof runsOn>> = [];
  try {
    runs = previous ? await runsOn(repo, previous, get) : [];
  } catch (err) {
    console.log(`STOPPED ${(err as Error).message}: an unread build is not a green one`);
    return 1;
  }
  const v = decide(previous, stopOn, runs, previous ? messages(previous, after) : []);
  console.log(`${v.ok ? 'ok' : 'STOPPED'} ${v.say}`);
  return v.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
