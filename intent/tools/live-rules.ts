/**
 * Compare GitHub's live branch protection and rulesets with the committed expectation. Read-only.
 *
 *   GITHUB_TOKEN=… node tools/live-rules.ts --expect ../control/live-rules.json [--repo owner/name]
 *
 * Exits 1 on any difference, and when the live rules cannot be read.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, github, type Expectation, type Get } from '../src/governance/liverules.ts';

export async function main(argv: readonly string[], get: Get = github(process.env['GITHUB_TOKEN'])): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = flag('expect');
  if (!file) {
    console.error('--expect <file> is required');
    return 2;
  }
  const e = JSON.parse(readFileSync(file, 'utf8')) as Expectation;
  const repo = flag('repo') ?? e.repo;
  const r = await check({ ...e, repo }, get);
  for (const [b, l] of Object.entries(r.live)) console.log(`${b}: pull request ${l.pull_request ? 'required' : 'not required'}; force-push ${l.non_fast_forward ? 'blocked' : 'allowed'}; deletion ${l.deletion ? 'blocked' : 'allowed'}; required checks: ${l.required_checks.join(', ') || 'none'}`);
  for (const d of r.differences) console.log(`DIFFERS ${d}`);
  console.log(r.ok ? `the live rules on ${repo} match ${file}` : `the live rules on ${repo} differ from ${file} in ${r.differences.length} way(s)`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
