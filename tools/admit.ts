import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { cardHash, JourneyCard } from '@zthr/intent';
import type { Proposal } from '../apps/advocate/src/builder/builder.js';
import { CONTROL, LOCK_FILE, readLock } from './lib.js';

/**
 * Admission of a builder proposal into the control plane: write the declaration, write and lock its journey card,
 * mark the proposal admitted, and record who admitted it and why. Shared by the factory (npm run certify) and by a
 * listed person (npm run signoff).
 */
export function admit(file: string, p: Proposal, by: string, reason: string): void {
  if (p.kind === 'scout') writeFileSync(`${CONTROL}/scouts/${String(p.declaration.scout)}.yaml`, stringify(p.declaration));
  if (p.kind === 'playbook') writeFileSync(`${CONTROL}/playbooks/${String(p.declaration.playbook)}.yaml`, stringify(p.declaration));
  if (p.journey) {
    const card = JourneyCard.parse(p.journey);
    writeFileSync(`${CONTROL}/journeys/${card.id}.yaml`, stringify(p.journey));
    const lock = readLock();
    lock.cards[card.id] = cardHash(card);
    writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
    appendFileSync(`${CONTROL}/journey-changes.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), id: card.id, from: null, to: lock.cards[card.id], direction: 'new', by, reason: `admitted with builder proposal ${p.id}` })}\n`);
  }
  writeFileSync(file, `${JSON.stringify({ ...p, status: 'admitted' }, null, 2)}\n`);
  appendFileSync(`${CONTROL}/admissions.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), proposal: p.id, decision: 'admitted', kind: p.kind, by, reason })}\n`);
}

export function readProposal(file: string): Proposal & { simulated?: boolean } {
  return JSON.parse(readFileSync(file, 'utf8')) as Proposal & { simulated?: boolean };
}
