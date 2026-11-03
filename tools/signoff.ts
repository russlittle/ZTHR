import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { admit, readProposal } from './admit.js';
import { CONTROL, arg } from './lib.js';

/**
 * A listed person's decision on a builder proposal: reject any proposal, or admit one the factory certified.
 * Most proposals never come here; npm run certify admits every certified feature. This is the person tier
 * (docs/adr/0004-who-admits-what.md).
 */
const pid = arg('proposal');
const by = arg('by');
const reason = arg('reason');
const reject = process.argv.includes('--reject');
const people = (JSON.parse(readFileSync(`${CONTROL}/people.json`, 'utf8')) as { people: string[] }).people;
if (!pid || !by || !reason || reason.length < 15) {
  console.error('usage: npm run signoff -- --proposal <id> --by <person> --reason "<why, 15+ chars>" [--reject]');
  process.exit(1);
}
if (!people.includes(by)) {
  console.error(`refused: "${by}" is not a listed person in control/people.json`);
  process.exit(1);
}
const file = `${CONTROL}/proposals/${pid}.json`;
const p = readProposal(file);
if (reject) {
  writeFileSync(file, `${JSON.stringify({ ...p, status: 'rejected' }, null, 2)}\n`);
  appendFileSync(`${CONTROL}/admissions.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), proposal: pid, decision: 'rejected', by, reason })}\n`);
  console.log(`rejected ${pid}`);
  process.exit(0);
}
if (p.status !== 'certified') {
  console.error(`refused: proposal is ${p.status}; failing checks: ${p.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
  process.exit(1);
}
admit(file, p, by, reason);
console.log(`admitted ${pid}: ${p.title}`);
