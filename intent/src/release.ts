/**
 * The release: the datum issued as a package a factory can build to, the way a drawing is released to a shop.
 *
 *   datum.json         every statement by balloon, with its state, source, mark and tolerance
 *   drawing.md         the read-back: the print a person signs
 *   notes.md           engineering notes: how it is to be made for now, never what it must do
 *   control-plan.yaml  every critical or significant balloon and the controls it needs
 *   gauges/*.yaml      journey cards in the factory's format, proposed for a person to sign
 *   features.yaml      the features, each with the gauges that prove it
 *   knowledge/         the Open Knowledge Format bundle
 *   context.md         what every model call and agent reads first: the end in mind, then the datum
 *   tolerances.json    each measure's working range, and how firmly it was established
 *   ratchets.json      the starting ratchets, in the factory's shape: each floor starts at its tolerance
 *   tests/             the confirmed scenarios as pending tests, and a skeleton for each gauge; none passes until built
 *   balloons.json      the balloon register, so numbers survive the next revision
 *   change-notice.md   what changed from the previous revision, balloon by balloon, and why
 *   manifest.json      revision, effectivity, source hashes, and the hash of every file above
 *
 * The same input always gives the same bytes. Nothing here reads the clock.
 */
import { sha256 } from './hash.ts';
import { chosenJourneys } from './journeys.ts';
import type { Ballooned } from './frame.ts';
import { same } from './diff.ts';
import { balloonKey, modelContext, type Prepared } from './pipeline.ts';
import { readBack } from './readback.ts';
import { startingRatchets, workingRanges } from './tolerance.ts';

const sha = sha256;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'gauge';

/** YAML for flat records and lists: every string quoted as JSON, which YAML reads exactly. */
function yaml(value: unknown, pad = ''): string {
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === 'object' && v !== null ? `${pad}- ${yaml(v, `${pad}  `).trimStart()}` : `${pad}- ${JSON.stringify(v)}`)).join('\n') : `${pad}[]`;
  if (typeof value === 'object' && value !== null)
    return Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (Array.isArray(v)) return v.length ? `${pad}${k}:\n${yaml(v, `${pad}  `)}` : `${pad}${k}: []`;
        if (typeof v === 'object' && v !== null) return `${pad}${k}:\n${yaml(v, `${pad}  `)}`;
        return `${pad}${k}: ${JSON.stringify(v)}`;
      })
      .join('\n');
  return `${pad}${JSON.stringify(value)}`;
}

export interface Gauge {
  readonly id: string;
  readonly persona: string;
  readonly delight?: string;
  readonly phase: number;
  readonly goal: string;
  readonly forbidden: readonly string[];
  readonly budget: { readonly actions: number; readonly ms: number };
  readonly requirements: readonly string[];
  readonly modes: readonly string[];
  readonly channels: readonly string[];
}

/** A time a measure names ("within 1 second", "within 100 milliseconds"), in milliseconds. */
export function msFrom(tolerance: string | undefined): number | null {
  const m = /within\s+([\d.]+)\s*(milliseconds?|ms|seconds?|s)\b/i.exec(tolerance ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return /^m/i.test(m[2] ?? '') ? n : n * 1000;
}

const singular = (p: string) => p.replace(/\s*\(.*\)$/, '').replace(/ies$/, 'y').replace(/s$/, '');

/** Gauges from the datum: one per outcome, checking every forbidden outcome, within the tightest time a measure names. */
/** Every gauge in the package: one per outcome, then the journeys the person added. */
export function gauges(p: Prepared): Gauge[] {
  return [...outcomeGauges(p), ...chosenJourneys(p).map((j) => j.card)];
}

export function outcomeGauges(p: Prepared): Gauge[] {
  const st = p.statements;
  const primary = st.find((s) => s.slot === 'people' && /who it is for/.test(s.text));
  const persona = slug(singular(primary?.text ?? 'person'));
  const who = singular(primary?.text ?? 'person');
  // Each thing that must never happen, once: two phrasings of the same outcome are one forbidden outcome.
  const forbidden: string[] = [];
  const nevers = st.filter((x) => x.slot === 'constraints' && /^never\b|must not|never /i.test(x.text));
  // Rule-derived outcomes come first: they are already phrased as something that happens, which a gauge checks.
  nevers.sort((a, b) => Number(b.supplied.kind === 'derived') - Number(a.supplied.kind === 'derived'));
  for (const s of nevers) {
    const t = s.text.replace(/^never:\s*/i, '').replace(/^never\s+/i, '').replaceAll('the person', `the ${who}`);
    if (!forbidden.some((f) => same(f, t, 0.5))) forbidden.push(t);
  }
  const times = st.filter((s) => s.slot === 'measures').map((s) => msFrom(s.tolerance)).filter((n): n is number => n !== null);
  const requirements = [...new Set(st.filter((s) => s.supplied.kind === 'person' && /^(?:F\d+:)?(?:FR|NFR|R)-?\d/.test(s.id)).map((s) => s.id))];
  const texting = st.some((s) => s.supplied.kind === 'derived' && s.supplied.rule === 'contacts-people') && /\b(text|sms)\b/i.test(JSON.stringify(p.model));
  const feel = st.find((s) => s.supplied.kind === 'lexicon' && s.slot === 'constraints');
  const delight = feel && feel.supplied.kind === 'lexicon' ? `feels ${feel.supplied.term}: ${feel.text.replace(/^"[^"]*", read as /, '')}` : undefined;
  return st
    .filter((s) => s.slot === 'outcome')
    .map((o) => ({
      id: slug(o.text),
      persona,
      ...(delight ? { delight } : {}),
      phase: 1,
      goal: o.text,
      forbidden,
      budget: { actions: 5, ms: times.length ? Math.max(...times) : 10_000 },
      requirements,
      modes: ['standard'],
      channels: texting ? ['app', 'text'] : ['app'],
    }));
}

/** What the gauges need before a person can sign them, stated plainly; empty when they are ready. */
export function gaugeProblems(g: readonly Gauge[]): string[] {
  const out: string[] = [];
  if (!g.length) out.push('no outcomes yet, so there is nothing to gauge');
  for (const x of g) {
    if (!x.forbidden.length) out.push(`${x.id}: nothing it must never do is stated yet`);
    if (x.goal.length < 10) out.push(`${x.id}: the goal is too short to judge`);
  }
  return out;
}

function controlPlan(st: readonly Ballooned[]): string {
  const rows = st
    .filter((s) => s.mark)
    .map((s) => ({
      balloon: s.balloon,
      mark: s.mark,
      characteristic: s.text,
      controls: s.mark === 'critical' ? ['gate', 'gauge forbidden outcome', 'red-team corpus', 'production monitor'] : ['gauge'],
      traced: 'not yet',
    }));
  return `# Control plan: every critical or significant characteristic and the controls it needs before it ships.\n# The factory traces each one; a characteristic with no control fails the build.\n${yaml({ characteristics: rows })}\n`;
}

function knowledge(p: Prepared): Record<string, string> {
  const files: Record<string, string> = {};
  const trust = (s: Ballooned) =>
    s.state === 'confirmed' ? `verified:\n  - by: "human:intent-holder"` : s.state === 'default' ? `verified:\n  - by: "process:${s.supplied.kind === 'derived' ? s.supplied.rule : s.supplied.kind}"` : `generated:\n  by: "process:intent"`;
  for (const s of p.statements)
    files[`knowledge/balloons/${s.balloon}.md`] = `---\ntype: intent-statement\ntitle: ${JSON.stringify(`[${s.balloon}] ${s.text.slice(0, 80)}`)}\nstatus: ${s.state === 'open' ? 'draft' : 'stable'}\n${trust(s)}\ntags: [${JSON.stringify(s.slot)}${s.mark ? `, ${JSON.stringify(s.mark)}` : ''}]\n---\n\n${s.text}\n${s.words && s.words !== s.text ? `\nIn the person's words: "${s.words}"\n` : ''}`;
  files['knowledge/end.md'] = `---\ntype: end-in-mind\ntitle: "The end in mind"\n${p.model.end ? 'status: stable' : 'status: draft'}\n---\n\n${p.model.end ?? 'Not stated yet.'}\n`;
  files['knowledge/index.md'] = `---\nokf_version: "0.2"\n---\n\n# ${p.model.title}\n\n- [The end in mind](end.md)\n${p.statements.map((s) => `- [[${s.balloon}] ${s.text.slice(0, 60)}](balloons/${s.balloon}.md)`).join('\n')}\n`;
  return files;
}

/** Each confirmed scenario as a pending test: listed, counted, and never passing until someone builds it. */
function scenarios(st: readonly Ballooned[]): string {
  const rows = st.filter((s) => s.slot === 'measures' && s.tolerance === 'exactly as stated');
  return `// The confirmed scenarios, by balloon. Each is pending until the factory builds and proves it.
import { describe, it } from 'vitest';

describe('confirmed scenarios', () => {
${rows.map((s) => `  it.todo(${JSON.stringify(`[${s.balloon}] ${s.text}`)});`).join('\n') || "  it.todo('no confirmed scenarios yet');"}
});
`;
}

/** A gauge's skeleton: every forbidden outcome named, nothing exported, so the factory reports it unknown, not passed. */
function skeleton(g: Gauge): string {
  return `// Skeleton for the gauge "${g.id}". It exports nothing on purpose: a gauge with no implementation is
// reported unknown by the factory, never passed. Build it, then export it from the journeys index.
//
// import type { JourneyContext } from '@zthr/intent';
//
// export async function ${g.id.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase()).replace(/^[0-9]/, '_$&')}(app: App, ctx: JourneyContext) {
//   // Goal: ${g.goal}
//   // Walk it as the ${g.persona} would, calling ctx.act() for every visible step (budget ${g.budget.actions} actions, ${g.budget.ms} ms).
${g.forbidden.map((f) => `//   ctx.forbid(${JSON.stringify(f)}, /* did it happen? */);`).join('\n')}
// }
`;
}

export interface Release {
  readonly files: Readonly<Record<string, string>>;
  readonly problems: readonly string[];
}

export interface ReleaseInput {
  readonly revision: number;
  /** The previous revision's datum.json, for the change notice. */
  readonly prior?: { readonly revision: number; readonly datum: { readonly statements: readonly Ballooned[] } };
  /** Why this revision exists. Required whenever there is a previous one: a record that names no reason is refused. */
  readonly reason?: string;
  /** Which intents this revision serves; defaults to the end in mind. */
  readonly effectivity?: string;
}

export function release(p: Prepared, r: ReleaseInput): Release {
  const problems: string[] = [];
  if (r.prior && !r.reason?.trim()) problems.push('a revision after the first must say why it was made');
  if (r.prior && r.revision <= r.prior.revision) problems.push(`revision ${r.revision} must come after ${r.prior.revision}`);
  const open = p.questions.length;
  const g = gauges(p);
  problems.push(...gaugeProblems(g));

  const datum = {
    title: p.model.title,
    revision: r.revision,
    end: p.model.end,
    titleBlock: p.title,
    statements: p.statements,
    notes: p.model.notes,
    variants: p.model.variants,
    openQuestions: p.questions.map((q) => ({ id: q.id, text: q.text, protects: q.protects })),
  };
  const files: Record<string, string> = {
    'datum.json': `${JSON.stringify(datum, null, 2)}\n`,
    'drawing.md': readBack(p),
    'notes.md': `# Engineering notes\n\nHow it is to be made for now. These never change what it must do.\n\n${p.model.notes.map((n) => `- ${n.text} _(${n.stance === 'ideal' ? 'the ideal' : 'the practical choice now'}${n.reason ? `; because ${n.reason}` : ''})_`).join('\n') || '_None._'}\n`,
    'control-plan.yaml': controlPlan(p.statements),
    'features.yaml': `# Proposed features, each with the gauges that prove it. Status starts as not measured.\n${yaml({ features: g.map((x) => ({ name: x.goal, what: x.goal, status: 'not measured', screens: [], journeys: [x.id] })) })}\n`,
    'context.md': `${modelContext(p)}\n`,
    'tolerances.json': `${JSON.stringify(workingRanges(p.statements), null, 2)}\n`,
    'ratchets.json': `${JSON.stringify(startingRatchets(workingRanges(p.statements)), null, 2)}\n`,
    'tests/scenarios.test.ts': scenarios(p.statements),
    ...Object.fromEntries(g.map((x) => [`tests/journeys/${x.id}.ts`, skeleton(x)])),
    'balloons.json': `${JSON.stringify(Object.fromEntries(p.statements.map((s) => [balloonKey(s), s.balloon])), null, 2)}\n`,
    ...Object.fromEntries(g.map((x) => [`gauges/${x.id}.yaml`, `# Proposed gauge. A person signs it into control/journeys; until then it judges nothing.\n${yaml(x)}\n`])),
    ...knowledge(p),
  };

  if (r.prior) {
    const before = new Map(r.prior.datum.statements.map((s) => [s.balloon, s]));
    const after = new Map(p.statements.map((s) => [s.balloon, s]));
    const lines: string[] = [];
    for (const [b, s] of after) {
      const was = before.get(b);
      if (!was) lines.push(`- **[${b}] added**: ${s.text}`);
      else if (was.text !== s.text || was.state !== s.state || was.tolerance !== s.tolerance || was.mark !== s.mark)
        lines.push(`- **[${b}] changed**: ${was.text !== s.text ? `"${was.text}" to "${s.text}"` : s.text}${was.state !== s.state ? ` (${was.state} to ${s.state})` : ''}${was.tolerance !== s.tolerance ? ` (tolerance ${was.tolerance ?? 'none'} to ${s.tolerance ?? 'none'})` : ''}`);
    }
    for (const [b, s] of before) if (!after.has(b)) lines.push(`- **[${b}] removed**: ${s.text}`);
    files['change-notice.md'] = `# Change notice: revision ${r.prior.revision} to ${r.revision}\n\n**Why:** ${r.reason ?? ''}\n\n**Serves:** ${r.effectivity ?? p.model.end ?? 'the end in mind, not yet stated'}\n\n${lines.join('\n') || '_No statement changed._'}\n`;
  }

  const hashes = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sha(v)]));
  const manifest = {
    title: p.model.title,
    revision: r.revision,
    effectivity: r.effectivity ?? p.model.end ?? null,
    sources: p.model.sources,
    instruments: p.instruments,
    openQuestions: open,
    ready: problems.length === 0 && open === 0,
    files: hashes,
    package: sha(JSON.stringify(hashes)),
  };
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { files, problems };
}
