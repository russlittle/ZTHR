import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { cardHash, loadCards } from '@zthr/intent';
import { CONTROL, JOURNEY_DIR, LOCK_FILE, arg, readLock } from './lib.js';

/**
 * Lock journey cards (Pattern 18). Every change states who, why and which
 * direction, and is appended to the change log. Adding or tightening needs no
 * person; loosening or removing a card is destructive and needs a listed one.
 */
const by = arg('by');
const reason = arg('reason');
const direction = arg('direction');
if (!by || !reason || reason.length < 15 || !direction || !['new', 'tighten', 'loosen'].includes(direction)) {
  console.error('usage: npm run lock -- --by <person> --direction new|tighten|loosen --reason "<why, 15+ chars>"');
  process.exit(1);
}
const cards = loadCards(JOURNEY_DIR);
const before = readLock();
const after = { cards: Object.fromEntries(cards.map((c) => [c.id, cardHash(c)])) };
const changed = cards.filter((c) => before.cards[c.id] !== after.cards[c.id]).map((c) => c.id);
const removed = Object.keys(before.cards).filter((id) => !(id in after.cards));
const people = (JSON.parse(readFileSync(`${CONTROL}/people.json`, 'utf8')) as { people: string[] }).people;
if ((direction === 'loosen' || removed.length) && !people.includes(by)) {
  console.error(`refused: loosening or removing a locked card is destructive; "${by}" is not a listed person (docs/adr/0004-who-admits-what.md)`);
  process.exit(1);
}
writeFileSync(LOCK_FILE, `${JSON.stringify(after, null, 2)}\n`);
for (const id of [...changed, ...removed]) {
  appendFileSync(`${CONTROL}/journey-changes.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), id, from: before.cards[id] ?? null, to: after.cards[id] ?? null, direction, by, reason })}\n`);
}
console.log(`locked ${cards.length} cards; ${changed.length} changed, ${removed.length} removed`);
