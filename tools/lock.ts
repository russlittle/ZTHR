import { appendFileSync, writeFileSync } from 'node:fs';
import { cardHash, loadCards } from '@zthr/intent';
import { CONTROL, JOURNEY_DIR, LOCK_FILE, arg, readLock } from './lib.js';

/**
 * Lock journey cards (Pattern 18). Changing a locked card is a control-plane
 * change: it needs a named person, a reason and a stated direction, and is
 * appended to the change log.
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
writeFileSync(LOCK_FILE, `${JSON.stringify(after, null, 2)}\n`);
for (const id of [...changed, ...removed]) {
  appendFileSync(`${CONTROL}/journey-changes.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), id, from: before.cards[id] ?? null, to: after.cards[id] ?? null, direction, by, reason })}\n`);
}
console.log(`locked ${cards.length} cards; ${changed.length} changed, ${removed.length} removed`);
