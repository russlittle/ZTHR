import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { EvidenceStore } from '@zthr/evidence';
import { Advocate } from '../apps/advocate/src/agents/advocate.js';
import { propose } from '../apps/advocate/src/builder/builder.js';
import { loadScouts } from '../apps/advocate/src/builder/scouts.js';
import { CONTROL, OUT, arg } from './lib.js';

/**
 * Runs the builder over the evidence store and writes its proposals to
 * control/proposals. With --simulate it first generates synthetic demand
 * (clearly marked) so the loop can be shown end to end before real students.
 */
const today = arg('today') ?? '2026-11-02';
let ev: EvidenceStore;
if (process.argv.includes('--simulate')) {
  const a = new Advocate({ today: () => today });
  for (let i = 0; i < 4; i++) {
    const s = a.createStudent({ chosenName: `Synthetic ${i}`, zip: '45402', enrollment: { college: 'sinclair' } });
    a.findHelp(s.id, 'caregiving');
    a.connectSource(s.id, 'forwarding');
    a.forward(s.id, 'Your SNAP recertification is due. Your renewal packet is enclosed and your interview is scheduled.', { subject: 'SNAP renewal' });
  }
  ev = a.evidence;
} else {
  mkdirSync(OUT, { recursive: true });
  ev = new EvidenceStore(`${OUT}/evidence.db`);
}
const proposals = propose(ev, {
  today,
  existingScouts: loadScouts(`${CONTROL}/scouts`),
  existingPlaybooks: readdirSync(`${CONTROL}/playbooks`).map((f) => f.replace(/\.yaml$/, '').replace(/-2027-28$/, '')),
});
mkdirSync(`${CONTROL}/proposals`, { recursive: true });
for (const p of proposals) {
  writeFileSync(`${CONTROL}/proposals/${p.id}.json`, `${JSON.stringify({ ...p, simulated: process.argv.includes('--simulate') }, null, 2)}\n`);
  console.log(`${p.status.padEnd(18)} ${p.id}  ${p.title}`);
  for (const c of p.checks) console.log(`    ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
}
if (proposals.length === 0) console.log('no gaps over threshold; nothing proposed');
