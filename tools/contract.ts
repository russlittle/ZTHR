import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realEgress, routedEgress, type Egress } from '@zthr/egress';
import { PROBES } from '../apps/campus-services/src/contracts.js';
import { SERVICES, startAll, type ServiceId } from '../apps/campus-services/src/index.js';
import { ROOT } from './lib.js';

/**
 * Contract check for campus services (Pattern 33).
 *
 *   npm run contract                     every probe against the synthetic services: schema, and the recorded fixture
 *   npm run contract -- --record         re-record the fixtures from the synthetic services
 *   npm run contract -- --base transit=https://gtfs.example.org
 *                                        the transit probes against a real vendor: schema only
 *
 * A fixture is what the synthetic service answered when it was recorded. A synthetic service that stops matching
 * its fixtures has drifted; that fails here, before a test or walk can trust it.
 */
const FIX = join(ROOT, 'apps/campus-services/fixtures');
const record = process.argv.includes('--record');
const bases: Partial<Record<ServiceId, string>> = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--base') {
    const [id, url] = process.argv[i + 1]!.split('=');
    bases[id as ServiceId] = url!.replace(/\/$/, '');
  }
}
const external = Object.keys(bases).length > 0;
const local = routedEgress(startAll());
const egressFor = (id: ServiceId): Egress => (bases[id] ? realEgress([new URL(bases[id]!).hostname]) : local);

let failed = 0;
let checked = 0;
for (const p of PROBES) {
  if (external && !bases[p.service]) continue;
  const base = bases[p.service] ?? `https://${SERVICES[p.service].host}`;
  const r = await egressFor(p.service).send({ purpose: `contract:${p.service}:${p.name}`, method: 'GET', url: `${base}${p.path}`, headers: p.headers });
  checked++;
  const file = join(FIX, p.service, `${p.name}.json`);
  const body = JSON.parse(r.body) as unknown;
  const parsed = p.schema.safeParse(body);
  const problems: string[] = [];
  if (r.status !== 200) problems.push(`status ${r.status}`);
  if (!parsed.success) problems.push(parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  if (!external) {
    if (record) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ request: { path: p.path, headers: p.headers ?? {} }, status: r.status, body }, null, 2)}\n`);
    } else if (!existsSync(file)) problems.push('no recorded fixture; run npm run contract -- --record');
    else if (JSON.stringify((JSON.parse(readFileSync(file, 'utf8')) as { body: unknown }).body) !== JSON.stringify(body)) problems.push('drifted from its recorded fixture');
  }
  console.log(`${problems.length ? 'FAIL' : 'pass'}  ${p.service.padEnd(8)} ${p.name.padEnd(14)} ${problems.join(' | ')}`);
  if (problems.length) failed++;
}
console.log(`\n${checked - failed}/${checked} probes meet the contract${record ? ' (fixtures recorded)' : ''}`);
process.exit(failed ? 1 : 0);
