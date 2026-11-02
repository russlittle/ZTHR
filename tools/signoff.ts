import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { cardHash, JourneyCard } from '@zthr/intent';
import type { Proposal } from '../apps/advocate/src/builder/builder.js';
import { CONTROL, LOCK_FILE, arg, readLock } from './lib.js';

/**
 * Admits a builder proposal. Only a listed person can sign, with a reason;
 * only a proposal whose checks all passed can be admitted. Admission writes
 * the declaration and its journey card into the control plane, locks the
 * card, and records the sign-off.
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
const p = JSON.parse(readFileSync(file, 'utf8')) as Proposal & { simulated?: boolean };
if (reject) {
  writeFileSync(file, `${JSON.stringify({ ...p, status: 'rejected' }, null, 2)}\n`);
  appendFileSync(`${CONTROL}/signoffs.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), proposal: pid, decision: 'rejected', by, reason })}\n`);
  console.log(`rejected ${pid}`);
  process.exit(0);
}
if (p.status !== 'awaiting-sign-off') {
  console.error(`refused: proposal is ${p.status}; failing checks: ${p.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
  process.exit(1);
}
if (p.kind === 'scout') writeFileSync(`${CONTROL}/scouts/${String(p.declaration.scout)}.yaml`, stringify(p.declaration));
if (p.kind === 'playbook') writeFileSync(`${CONTROL}/playbooks/${String(p.declaration.playbook)}.yaml`, stringify(p.declaration));
if (p.journey) {
  const card = JourneyCard.parse(p.journey);
  writeFileSync(`${CONTROL}/journeys/${card.id}.yaml`, stringify(p.journey));
  const lock = readLock();
  lock.cards[card.id] = cardHash(card);
  writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  appendFileSync(`${CONTROL}/journey-changes.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), id: card.id, from: null, to: lock.cards[card.id], direction: 'new', by, reason: `admitted with builder proposal ${pid}` })}\n`);
}
writeFileSync(file, `${JSON.stringify({ ...p, status: 'admitted' }, null, 2)}\n`);
appendFileSync(`${CONTROL}/signoffs.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), proposal: pid, decision: 'admitted', kind: p.kind, by, reason })}\n`);
console.log(`admitted ${pid}: ${p.title}`);
