import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { EvidenceStore } from '@zthr/evidence';
import { loadCards, lockVerdict } from '@zthr/intent';
import { MeteredModel, OpenRouterClient } from '@zthr/models';
import { boundInput, datumIntent, reviewPanel, reviewSeat, type Seat, type SeatRole } from '@zthr/review';
import { CONTROL, JOURNEY_DIR, OUT, arg, readLock } from './lib.js';

/**
 * Runs the review panel on a change. Without a provider key every seat is
 * unknown and the change is not admitted; the job says so plainly.
 *
 * The intent every seat reviews against is the locked datum (the journey cards, checked against their lock), never
 * the author's commit message, which goes only to the context-aided seat as a claim to test. A change too large to
 * show whole is reported as unknown by every seat, never reviewed in part.
 */
const base = arg('base') ?? 'HEAD~1';
const fullDiff = execSync(`git diff ${base} -- . ':(exclude)package-lock.json'`, { encoding: 'utf8', maxBuffer: 50_000_000 });
const claim = execSync('git log -1 --pretty=%B', { encoding: 'utf8' });
const cards = loadCards(JOURNEY_DIR);
const locked = lockVerdict(cards, readLock());
if (locked.status !== 'pass') {
  console.error(`review cannot run against an unverified datum: ${locked.reason}`);
  process.exit(1);
}
const intent = datumIntent(cards);
const changed = execSync(`git diff --name-only ${base}`, { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.yaml'));
const allFiles = Object.fromEntries(changed.map((f) => { try { return [f, readFileSync(f, 'utf8')]; } catch { return [f, '(deleted)']; } }));
const { diff, repoFiles, omitted } = boundInput(fullDiff, allFiles, { diffChars: 120_000, fileChars: 20_000, files: 40 });
if (omitted.length) console.log(`not shown to the panel, so every seat is unknown; split the change: ${omitted.join('; ')}`);
const ev = new EvidenceStore(`${OUT}/evidence.db`);
const client = new MeteredModel(new OpenRouterClient(), ev);
const cfg = parse(readFileSync(`${CONTROL}/review.yaml`, 'utf8')) as { seats: { role: SeatRole; family: string; model: string }[] };
const seats: Seat[] = cfg.seats.map((s) => ({ ...s, client }));
const pre = await reviewPanel(seats, { diff, intent, claim, repoFiles, omitted, context: 'ZTHR reference implementation: Student Advocate. See CLEANROOM.md and the PRD.' });
const inPlace = seats.filter((s) => s.role === 'in-place');
const post = await Promise.all(inPlace.map((s) => reviewSeat(s, { diff, intent, repoFiles, omitted })));
ev.append('review', 'panel', { status: pre.verdict.status, reason: pre.verdict.reason, findings: pre.findings.length, omitted: omitted.length, inPlace: post.map((p) => p.verdict.status) });
console.log(`pre-commit panel: ${pre.verdict.status} - ${pre.verdict.reason}`);
for (const f of pre.findings) console.log(`  [${f.severity}] ${f.family}/${f.seat}: ${f.summary}`);
for (const p of post) console.log(`in-place: ${p.verdict.status} - ${p.verdict.reason}`);
process.exit(pre.verdict.status === 'pass' && post.every((p) => p.verdict.status !== 'fail') ? 0 : 1);
