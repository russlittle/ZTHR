/**
 * AGENTS.md, in every released package. Pure, so the studio can issue a package in the browser.
 */
import type { Gauge } from '../release.ts';
import type { Manifest } from '../manifest.ts';
import type { Prepared } from '../pipeline.ts';
import { objectives, STAGES } from '../delivery.ts';
import { REQUIRED_CHECKS, REVIEW_FAMILIES, TIERS } from './duties.ts';

/** AGENTS.md for a released package: what this revision asks for, and how it is judged. Deterministic: it is hashed. */
export function brief(p: Prepared, m: Manifest, g: readonly Gauge[], revision: number): string {
  const outcomes = p.statements.filter((s) => s.slot === 'outcome');
  const never = p.statements.filter((s) => s.slot === 'constraints');
  const o = objectives(p);
  const s = p.options;
  return `# ${p.model.title}, revision ${revision}: brief for the factory's agents

This package is the datum: what a person signed as what they mean. Build to it, and be judged by it. The guide for your role, and the tools, come from the factory's agent API (\`intent agents serve\`); this brief says what this revision asks for.

**The end in mind:** ${p.model.end ?? 'not stated yet; ask the steward before building anything it would decide.'}

## What counts as done

${outcomes.length ? outcomes.map((x) => `- [${x.balloon}] ${x.text}${x.tolerance ? ` (${x.tolerance})` : ''}`).join('\n') : '- No outcome is stated yet.'}

Each outcome is assessed as \`outcomes/framework.json\` sets out, before release by a journey walk and in use by its target. The service levels in use:

${o.list.map((x) => `- ${x.what}: ${(x.goal * 100).toFixed(1)}% (${x.from})`).join('\n')}

## What must never happen

${never.length ? never.map((x) => `- [${x.balloon}] ${x.text}${x.mark ? ` (${x.mark})` : ''}`).join('\n') : '- Nothing is stated beyond the team minimum.'}

## The gauges that judge it

${g.length ? g.map((x) => `- \`${x.id}\`: ${x.goal} Never: ${x.forbidden.join('; ') || 'nothing named'}. Budget ${x.budget.actions} actions, ${x.budget.ms} ms.`).join('\n') : '- None yet.'}

The gauges are proposed in \`gauges/\` until a person signs them into the locked journeys. The starting ratchets are in \`ratchets.json\`: each holds or tightens, never loosens.

## What to build, in order

${m.lines.length} lines in \`build-manifest.json\`, by find number. Standard assemblies are used as they are; the fleet maintains them, so change them upstream, never in this app.

| Find | Part | Source | Balloons |
| --- | --- | --- | --- |
${m.lines.map((l) => `| ${l.find} | ${l.part.replace(/\|/g, '\\|')} | ${l.source} | ${l.balloons.join(', ') || 'team minimum'} |`).join('\n')}

## Choices on the spec sheet

- API: ${s.api.reach}${s.api.reach === 'some' ? ` (${s.api.features.join(', ')})` : ''}; events ${s.api.events ? 'on' : 'off'}; agent tools ${s.api.agents ? 'on' : 'off'}. A closed contract answers 403; never open one the sheet keeps closed.
- Sign-in: ${s.connect.identity}. Query console: ${s.admin.query}. Use tracking: ${s.usage}. Report a problem: ${s.feedback}.
- Compliance in scope: ${s.compliance.length ? s.compliance.join(', ') : 'none named'}. The controls and their evidence are in \`compliance/\`; the sensitive-data inventory decides what is masked, logged and gated.

## The information it keeps

\`information/\` holds the signed schema, its DDL and its migrations. The data outlives every screen built on it: a migration never drops a record, and the rehearsal proves it before anything ships.

## How it ships

${STAGES.map((x, i) => `${i + 1}. **${x.name}**: ${x.gate}.`).join('\n')}

A change is admitted when every required check passes (${REQUIRED_CHECKS.map((x) => x.check).join(', ')}) and ${REVIEW_FAMILIES} families other than its author's have passed it.

## Paths no agent writes

${TIERS.filter((t) => t.tier === 'locked' || t.tier === 'person' || t.tier === 'generated').map((t) => `- **${t.tier}**: ${t.paths.map((x) => `\`${x}\``).join(', ')}. ${t.meaning}`).join('\n')}
`;
}
