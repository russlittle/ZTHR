/**
 * The gate: every commit since the base that touches what only a person changes is signed by a person's key.
 *
 *   node tools/goalposts.ts [--repo dir] [--base rev] [--head rev]
 *
 * The base is --base, else ZTHR_BASE, else the tag zthr-anchor. The keys are ZTHR_PERSON_KEYS (one public key per
 * line, or a people file), else control/people.json at the base. Exits 1 on any problem, and when it cannot judge.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gather, judge } from '../src/governance/goalposts.ts';

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = flag('repo') ?? spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const anchor = spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/zthr-anchor^{commit}'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const base = flag('base') || env['ZTHR_BASE'] || anchor || null;
  const facts = gather(repo, base && !/^0+$/.test(base) ? base : null, flag('head') ?? 'HEAD', env['ZTHR_PERSON_KEYS']);
  const j = judge(facts);
  console.log(`goalposts: ${facts.commits.length} commit(s) from ${facts.base?.slice(0, 12) ?? 'no base'} to ${facts.head.slice(0, 12)}; keys from ${facts.keySource} (${facts.keys.length})`);
  for (const n of j.notes) console.log(`  ${n}`);
  for (const p of j.problems) console.log(`NOT A PERSON'S ${p}`);
  return j.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
