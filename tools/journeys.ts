import { mkdirSync } from 'node:fs';
import { EvidenceStore, intentCompletion } from '@zthr/evidence';
import { loadCards, lockVerdict, runJourney, type JourneyRun } from '@zthr/intent';
import { JOURNEYS, makeApp } from '../apps/advocate/journeys/index.js';
import { JOURNEY_DIR, OUT, arg, readLock } from './lib.js';

/** Run every locked journey in every declared mode and channel, and record the results. */
export async function runAll(release = arg('release') ?? 'local', store?: EvidenceStore): Promise<{ runs: JourneyRun[]; store: EvidenceStore }> {
  const cards = loadCards(JOURNEY_DIR);
  const lock = readLock();
  const ev = store ?? (mkdirSync(OUT, { recursive: true }), new EvidenceStore(`${OUT}/evidence.db`));
  const lv = lockVerdict(cards, lock);
  ev.append('gate', 'journey-lock', { status: lv.status, reason: lv.reason, release });
  const runs: JourneyRun[] = [];
  for (const card of cards) {
    const variants: JourneyRun[] = [];
    for (const mode of card.modes) for (const channel of card.channels) variants.push(await runJourney(card, JOURNEYS[card.id], () => makeApp(), lock, mode, channel));
    runs.push(...variants);
    // A journey passes only if every mode and channel variant passes.
    const status = variants.some((v) => v.status === 'fail') ? 'fail' : variants.some((v) => v.status === 'unknown') ? 'unknown' : 'pass';
    ev.append('journey_run', card.id, { journey: card.id, persona: card.persona, delight: card.delight ?? null, phase: card.phase, status, release, variants: variants.length, reasons: variants.filter((v) => v.status !== 'pass').map((v) => `${v.mode}/${v.channel}: ${v.reason}`) });
  }
  return { runs, store: ev };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { runs, store } = await runAll();
  for (const r of runs) console.log(`${r.status.padEnd(7)} ${r.journey.padEnd(38)} ${r.mode}/${r.channel}  ${r.status === 'pass' ? '' : r.reason}`);
  const ic = intentCompletion(store);
  console.log(`\nintent completion: ${ic.numerator}/${ic.denominator} journeys`);
  process.exit(runs.some((r) => r.status === 'fail') ? 1 : runs.some((r) => r.status === 'unknown') ? 2 : 0);
}
