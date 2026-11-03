import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { admit, readProposal } from './admit.js';
import { CONTROL } from './lib.js';

/**
 * The factory admits features. Every builder proposal whose checks all passed is admitted, recorded as admitted by
 * "factory" with the checks it passed and the commit it was certified at. A proposal that failed a check, or that asks
 * for sealed facts, stays where it is for a listed person (docs/adr/0004-who-admits-what.md).
 */
const dir = `${CONTROL}/proposals`;
let commit = 'uncommitted';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
let admitted = 0;
for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
  const file = `${dir}/${f}`;
  const p = readProposal(file);
  if (p.status !== 'certified' || !p.checks.every((c) => c.ok)) continue;
  admit(file, p, 'factory', `certified at ${commit}: ${p.checks.map((c) => c.name).join(', ')}`);
  console.log(`admitted ${p.id}: ${p.title}`);
  admitted++;
}
console.log(`${admitted} proposals admitted by the factory`);
