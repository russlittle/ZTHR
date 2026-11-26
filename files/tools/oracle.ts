/**
 * The differential oracle for Files.
 *
 *   record:  node tools/oracle.ts record  <nextcloud url> <user> <app password> > oracle/nextcloud.json
 *   compare: node tools/oracle.ts compare <files url> <user> <app password> [oracle/nextcloud.json]
 *   live:    node tools/oracle.ts live    <nextcloud url> <user> <pw> <files url> <user> <pw>
 *
 * compare exits non-zero when anything a client could depend on differs, and prints every difference.
 */
import { readFileSync } from 'node:fs';
import { NEXTCLOUD_RULES, compare, record, type Corpus } from '../../intent/blocks/oracle/index.ts';
import { STEPS } from '../oracle/steps.ts';

const [mode, ...a] = process.argv.slice(2);
const target = (base: string, user: string, password: string) => ({ base: base.replace(/\/+$/, ''), user, password });
if (mode === 'record' && a.length >= 3) {
  process.stdout.write(`${JSON.stringify(await record(STEPS, target(a[0]!, a[1]!, a[2]!), NEXTCLOUD_RULES, a[0]!), null, 1)}\n`);
} else if ((mode === 'compare' && a.length >= 3) || (mode === 'live' && a.length >= 6)) {
  const ref = mode === 'live' ? target(a[0]!, a[1]!, a[2]!) : (JSON.parse(readFileSync(a[3] ?? new URL('../oracle/nextcloud.json', import.meta.url), 'utf8')) as Corpus);
  const cand = mode === 'live' ? target(a[3]!, a[4]!, a[5]!) : target(a[0]!, a[1]!, a[2]!);
  const r = await compare(STEPS, cand, NEXTCLOUD_RULES, ref);
  for (const d of r.differences) console.log(`${d.step} — ${d.where}\n    reference: ${JSON.stringify(d.reference)}\n    candidate: ${JSON.stringify(d.candidate)}`);
  console.log(`${r.steps} steps, ${r.differences.length} difference${r.differences.length === 1 ? '' : 's'}`);
  process.exit(r.differences.length ? 1 : 0);
} else {
  console.error('usage: record <url> <user> <pw> | compare <url> <user> <pw> [corpus] | live <ref url> <user> <pw> <files url> <user> <pw>');
  process.exit(2);
}
