/**
 * Prove a release is in the shape the ZTHR factory consumes, using the factory's own loader rather than our
 * reading of its format. Run from a ZTHR checkout (branch reference-implementation) with its dependencies:
 *
 *   npx tsx /path/to/zthr-spec/tools/check-factory.ts <release dir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error resolved from the factory checkout this runs in
import { cardHash, loadCards } from '@zthr/intent';

const dir = process.argv[2];
if (!dir) throw new Error('usage: check-factory.ts <release dir>');
const cards = loadCards(join(dir, 'gauges')) as { id: string }[];
for (const c of cards) console.log(`gauge accepted by the factory's loader: ${c.id} (${String(cardHash(c)).slice(0, 12)})`);
const ratchets = JSON.parse(readFileSync(join(dir, 'ratchets.json'), 'utf8')) as Record<string, unknown>[];
const ok = ratchets.every((r) => typeof r['id'] === 'string' && typeof r['metric'] === 'string' && (r['direction'] === 'up' || r['direction'] === 'down') && typeof r['floor'] === 'number');
if (!ok) throw new Error('ratchets.json is not in the factory shape');
console.log(`${ratchets.length} starting ratchet(s) in the factory's shape`);
