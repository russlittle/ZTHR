import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { EvidenceStore } from '@zthr/evidence';
import { MeteredModel, OpenRouterClient } from '@zthr/models';
import { reviewPanel, reviewSeat, type Seat, type SeatRole } from '@zthr/review';
import { CONTROL, OUT, arg } from './lib.js';

/**
 * Runs the review panel on a change. Without a provider key every seat is
 * unknown and the change is not admitted; the job says so plainly.
 */
const base = arg('base') ?? 'HEAD~1';
const diff = execSync(`git diff ${base} -- . ':(exclude)package-lock.json'`, { encoding: 'utf8', maxBuffer: 50_000_000 }).slice(0, 120_000);
const intent = execSync('git log -1 --pretty=%B', { encoding: 'utf8' });
const changed = execSync(`git diff --name-only ${base}`, { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.yaml'));
const repoFiles = Object.fromEntries(changed.slice(0, 40).map((f) => { try { return [f, readFileSync(f, 'utf8').slice(0, 20_000)]; } catch { return [f, '(deleted)']; } }));
const ev = new EvidenceStore(`${OUT}/evidence.db`);
const client = new MeteredModel(new OpenRouterClient(), ev);
const cfg = parse(readFileSync(`${CONTROL}/review.yaml`, 'utf8')) as { seats: { role: SeatRole; family: string; model: string }[] };
const seats: Seat[] = cfg.seats.map((s) => ({ ...s, client }));
const pre = await reviewPanel(seats, { diff, intent, repoFiles, context: 'ZTHR reference implementation: Student Advocate. See CLEANROOM.md and the PRD.' });
const inPlace = seats.filter((s) => s.role === 'in-place');
const post = await Promise.all(inPlace.map((s) => reviewSeat(s, { diff, intent, repoFiles })));
ev.append('review', 'panel', { status: pre.verdict.status, reason: pre.verdict.reason, findings: pre.findings.length, inPlace: post.map((p) => p.verdict.status) });
console.log(`pre-commit panel: ${pre.verdict.status} - ${pre.verdict.reason}`);
for (const f of pre.findings) console.log(`  [${f.severity}] ${f.family}/${f.seat}: ${f.summary}`);
for (const p of post) console.log(`in-place: ${p.verdict.status} - ${p.verdict.reason}`);
process.exit(pre.verdict.status === 'pass' && post.every((p) => p.verdict.status !== 'fail') ? 0 : 1);
