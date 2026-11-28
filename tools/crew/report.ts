/**
 * The morning report: what the crew fixed, what climbed a level, what was parked for a person, what it cost, and
 * each model's measured pass rate per kind of task. Written to intent/factory/reports/<date>.md and, in CI, to the
 * job summary.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { round, type Router } from '../../intent/blocks/router/index.ts';
import type { Summary } from './dispatch.ts';
import { REPORTS, type CrewResult } from './lib.ts';

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function morningReport(s: Summary, router: Router, results: readonly CrewResult[]): string {
  const todays = results.filter((r) => r.at.slice(0, 10) === s.date);
  const byModel = new Map<string, { attempts: number; passes: number; costUsd: number; tokens: number }>();
  for (const a of s.attempts) {
    const m = byModel.get(a.model) ?? { attempts: 0, passes: 0, costUsd: 0, tokens: 0 };
    byModel.set(a.model, { attempts: m.attempts + 1, passes: m.passes + (a.pass === true ? 1 : 0), costUsd: round(m.costUsd + a.costUsd), tokens: m.tokens });
  }
  for (const r of todays) {
    const m = byModel.get(r.model);
    if (m) m.tokens += r.inputTokens + r.outputTokens + (r.cacheReadTokens ?? 0);
  }
  const escalated = s.attempts.filter((a) => a.level !== 'worker');
  const failed = s.attempts.filter((a) => a.pass === false);
  const lines = [
    `# Crew report, ${s.date}`,
    '',
    `Fixed **${s.fixed.length}** of ${new Set(s.attempts.map((a) => a.file)).size} work orders tried, in ${s.attempts.length} attempts. Spent **${usd(s.spentUsd)}** this run; ${usd(router.budgetLeft(s.budgetUsd, results))} of the ${usd(s.budgetUsd)} daily budget is left. Stopped: ${s.stopped}.`,
    '',
    ...(s.attempts.length ? ['```mermaid', 'pie showData title Attempts by outcome', ...Object.entries(s.attempts.reduce<Record<string, number>>((a, x) => ({ ...a, [x.outcome]: (a[x.outcome] ?? 0) + 1 }), {})).map(([k, v]) => `  "${k}" : ${v}`), '```', ''] : []),
    '## Fixed',
    '',
    ...(s.fixed.length ? s.fixed.map((f) => { const a = s.attempts.filter((x) => x.file === f && x.pass === true).at(-1); return `- \`${f}\` by ${a?.model ?? '?'} (${a?.level ?? '?'}, ${usd(a?.costUsd ?? 0)})`; }) : ['None.']),
    '',
    '## Escalated',
    '',
    ...(escalated.length ? escalated.map((a) => `- \`${a.file}\` at ${a.level} on ${a.model}: ${a.outcome}`) : ['None.']),
    '',
    '## Parked for a person',
    '',
    ...(s.parked.length ? s.parked.map((f) => `- \`${f}\`: failed at worker, escalation and judgment`) : ['None.']),
    '',
    ...(failed.length ? ['## Not passed', '', ...failed.map((a) => `- \`${a.file}\` on ${a.model} (${a.level}): ${a.outcome}`), ''] : []),
    ...(s.skipped.length ? ['## Skipped', '', ...s.skipped.map((x) => `- \`${x.file}\`: ${x.why}`), ''] : []),
    '## Cost by model, this run',
    '',
    '| Model | Attempts | Passed | Tokens | Cost |',
    '| --- | --- | --- | --- | --- |',
    ...[...byModel].map(([m, v]) => `| ${m} | ${v.attempts} | ${v.passes} | ${v.tokens} | ${usd(v.costUsd)} |`),
    '',
    '## Pass rates, all runs',
    '',
    `Trusted means at least ${router.policy.minAttempts} scored attempts and a Wilson lower bound of at least ${router.policy.bar}.`,
    '',
    '| Kind | Model | Attempts | Passed | Lower bound | Standing | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...router.rates().map((r) => `| ${r.kind} | ${r.model} | ${r.attempts} | ${r.passes} | ${r.lower} | ${r.standing} | ${usd(r.costUsd)} |`),
    '',
  ];
  return lines.join('\n');
}

/** Writes the report for the day (a later run the same day is added below) and to the job summary in CI. */
export function writeReport(date: string, md: string, dir = REPORTS, summaryFile = process.env.GITHUB_STEP_SUMMARY): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  const at = new Date().toISOString().slice(11, 16);
  if (existsSync(path)) writeFileSync(path, `${readFileSync(path, 'utf8').trimEnd()}\n\n---\n\nRun at ${at} UTC\n\n${md.replace(/^# .*\n\n/, '')}`);
  else writeFileSync(path, md);
  if (summaryFile) appendFileSync(summaryFile, md);
  return path;
}
