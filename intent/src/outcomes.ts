/**
 * The outcome framework: set before anything is built, the way a curriculum sets its outcomes before the first course
 * is approved.
 *
 * Each outcome on the schematic says what every person it serves can do when it works. Each is assessed in fixed
 * ways, against performance criteria, to a passing target, with links to the evidence anyone can review. The platform
 * outcomes (what every person can count on in every app, like a college's general education outcomes) are mapped
 * across the features: introduced by the team minimum everywhere, refined where a feature asks more, and mastered where
 * a feature carries the journey that proves them at full depth.
 *
 * The builder may build it any way it likes, as faculty may teach any way they like. The person it serves is assured
 * of being measured the same, pre-defined way.
 *
 * The framework is data first: records with ids and links, so it can be checked for integrity on its own and every
 * view of it (the documents, the map, the screen) can be rebuilt from it.
 */
import platformData from '../catalog/platform-outcomes.json' with { type: 'json' };
import { achievedText } from './gaps.ts';
import { apiOn, featureId, type Settled } from './interfaces.ts';
import { chosenJourneys, type JourneyKind } from './journeys.ts';
import type { Manifest } from './manifest.ts';
import type { Prepared } from './pipeline.ts';
import { msFrom, outcomeGauges } from './release.ts';

export type When = 'before release' | 'in use';
export interface Assessment {
  readonly id: string;
  readonly method: 'journey walk' | 'measure' | 'observed in use';
  readonly when: When;
  readonly instrument: string;
  readonly criteria: readonly string[];
  /** The passing metric, set before building. Null means it is not set yet, and the outcome is not ready. */
  readonly passing: string | null;
  readonly evidence: readonly string[];
}
export interface OutcomeRecord {
  readonly id: string;
  readonly balloon: number;
  readonly outcome: string;
  readonly who: readonly string[];
  readonly feature: string;
  readonly assessments: readonly Assessment[];
  readonly complete: boolean;
  readonly missing: readonly string[];
}

export type Level = 'I' | 'R' | 'M';
export const LEVEL_NAME: Record<Level, string> = { I: 'Introduced', R: 'Refined', M: 'Mastered' };
export const LEVEL_WHAT: Record<Level, string> = {
  I: 'Inherited from the team minimum, with its standard checks',
  R: 'This feature asks more of it, and its schematic says how',
  M: 'This feature carries a journey that proves it at full depth',
};
interface PlatformOutcome {
  readonly id: string;
  readonly outcome: string;
  readonly assessment: string;
  readonly criteria: readonly string[];
  readonly passing: string;
  readonly evidence: readonly string[];
  readonly refinedBy: readonly string[];
  readonly masteredBy: readonly JourneyKind[];
}
export const PLATFORM = (platformData as { name: string; what: string; outcomes: PlatformOutcome[] });

export interface MapCell {
  readonly feature: string;
  readonly platform: string;
  readonly level: Level;
  readonly because: string;
}

export interface Framework {
  readonly outcomes: readonly OutcomeRecord[];
  readonly platform: readonly { id: string; outcome: string; assessment: string; criteria: readonly string[]; passing: string; evidence: readonly string[]; highest: Level }[];
  readonly map: readonly MapCell[];
  readonly features: readonly { id: string; gives: string }[];
  readonly complete: boolean;
}

export function framework(p: Prepared, m: Manifest): Framework {
  const st = p.statements;
  const s: Settled = p.options;
  const gaugesById = new Map(outcomeGauges(p).map((g) => [g.id, g]));
  const chosen = chosenJourneys(p);
  const people = st.filter((x) => x.slot === 'people').map((x) => x.text);
  const lines = m.lines.filter((l) => l.source === 'make: new');

  const outcomes: OutcomeRecord[] = st
    .filter((o) => o.slot === 'outcome')
    .map((o) => {
      const fid = featureId(o.text);
      const line = lines.find((l) => featureId(l.gives) === fid);
      const g = gaugesById.get(fid);
      const held = (line?.balloons ?? []).map((b) => st.find((x) => x.balloon === b)!).filter((x) => x && x.slot === 'measures' && !x.text.startsWith('Achieved in use: '));
      const target = st.find((x) => x.slot === 'measures' && x.text === achievedText(o.text));
      const assessments: Assessment[] = [
        {
          id: `${fid}:walk`,
          method: 'journey walk',
          when: 'before release',
          instrument: g ? `journey ${g.id}` : 'no journey yet',
          criteria: g ? [`Reaches: ${g.goal}`, ...g.forbidden.map((f) => `Never: ${f}`), `Within ${g.budget.actions} actions and ${g.budget.ms / 1000} seconds`, `In every mode: ${g.modes.join(', ')}`] : [],
          passing: g ? 'Passes on every walk, in every mode' : null,
          evidence: g ? [`gauges/${g.id}.yaml`, `tests/journeys/${g.id}.ts`] : [],
        },
        ...held.map((h): Assessment => ({
          id: `${fid}:measure:${h.balloon}`,
          method: 'measure',
          when: msFrom(h.tolerance) !== null ? 'before release' : 'in use',
          instrument: `balloon ${h.balloon}`,
          criteria: [h.text],
          passing: h.tolerance ?? null,
          evidence: ['control-plan.yaml', 'tolerances.json', 'ratchets.json', `knowledge/balloons/${h.balloon}.md`],
        })),
        {
          id: `${fid}:in-use`,
          method: 'observed in use',
          when: 'in use',
          instrument: `report feature-${fid}`,
          criteria: [`The people it serves achieve it: ${o.text}`, 'Counted from journeys completed in use, never from opinion'],
          passing: target?.tolerance ? `${target.tolerance} achieve it` : null,
          evidence: [`reports/feature-${fid}.sql`, 'reports/journeys-observed.sql', ...(target ? ['ratchets.json'] : [])],
        },
      ];
      const missing = assessments.filter((a) => !a.passing).map((a) => (a.method === 'observed in use' ? 'a target for how many of the people it serves must achieve it' : a.method === 'journey walk' ? 'a journey that walks to it' : `how close is close enough for "${a.criteria[0]}"`));
      return { id: fid, balloon: o.balloon, outcome: o.text, who: people, feature: line ? line.part : `Custom assembly: ${o.text}`, assessments, complete: missing.length === 0, missing };
    });

  // The platform outcomes, mapped across every feature: introduced, refined or mastered, and why.
  const featureLines = lines.map((l) => ({ id: featureId(l.gives), gives: l.gives, line: l }));
  const tuned = Object.values(p.people.tune ?? {});
  const signal = (token: string, f: (typeof featureLines)[number]): string | null => {
    const [kind, v] = token.split(':') as [string, string];
    const mine = f.line.balloons.map((b) => st.find((x) => x.balloon === b)).filter((x): x is NonNullable<typeof x> => !!x);
    if (kind === 'feel') return st.some((x) => x.supplied.kind === 'lexicon' && x.supplied.term === v) ? `you said ${v}` : null;
    if (kind === 'rule') return mine.some((x) => x.supplied.kind === 'derived' && x.supplied.rule === v) || st.some((x) => x.supplied.kind === 'derived' && x.supplied.rule === v && f.line.why.some((w) => w.balloons.includes(x.balloon))) ? `the ${v.replace('-', ' ')} rule applies` : null;
    if (kind === 'said') return mine.some((x) => new RegExp(`\\b${v}`, 'i').test(x.text)) ? `it says "${v}"` : null;
    if (kind === 'measure') return mine.some((x) => x.slot === 'measures' && msFrom(x.tolerance) !== null) ? 'a measure holds it to a time' : null;
    if (kind === 'slot') return st.some((x) => x.slot === v) ? `it depends on ${v}` : null;
    if (kind === 'sheet') return v === 'api' && apiOn(s, f.id) ? 'its API is switched on' : null;
    if (kind === 'tune') {
      const hit = tuned.some((t) => (v === 'assistive' ? !!t.assistive && t.assistive !== 'none' : v === 'language' ? !!t.language && !/^english$/i.test(t.language) : v === 'device' ? t.device === 'phone' : false));
      return hit ? `a person is tuned for ${v === 'assistive' ? 'assistive technology' : v}` : null;
    }
    return null;
  };
  const map: MapCell[] = featureLines.flatMap((f) =>
    PLATFORM.outcomes.map((po) => {
      const walk = chosen.find((j) => j.from && po.masteredBy.includes(j.from.kind) && f.line.journeys.includes(j.card.id));
      if (walk) return { feature: f.id, platform: po.id, level: 'M' as const, because: `the ${walk.from!.kind} journey proves it` };
      const why = po.refinedBy.map((t) => signal(t, f)).find((x): x is string => !!x);
      if (why) return { feature: f.id, platform: po.id, level: 'R' as const, because: why };
      return { feature: f.id, platform: po.id, level: 'I' as const, because: 'inherited from the team minimum' };
    }),
  );
  const rank: Record<Level, number> = { I: 0, R: 1, M: 2 };
  const platform = PLATFORM.outcomes.map((po) => {
    const cells = map.filter((c) => c.platform === po.id);
    const highest = cells.reduce<Level>((a, c) => (rank[c.level] > rank[a] ? c.level : a), 'I');
    return { id: po.id, outcome: po.outcome, assessment: po.assessment, criteria: po.criteria, passing: po.passing, evidence: po.evidence, highest };
  });
  return { outcomes, platform, map, features: featureLines.map((f) => ({ id: f.id, gives: f.gives })), complete: outcomes.length > 0 && outcomes.every((o) => o.complete) };
}

const cell = (t: string) => t.replace(/\|/g, '\\|');

export function frameworkFiles(fw: Framework): Record<string, string> {
  const json = { schema: 'zthr-outcome-framework/1', complete: fw.complete, outcomes: fw.outcomes, platform: fw.platform, levels: LEVEL_WHAT, map: fw.map };
  const md = `# The outcome framework

Set before anything is built. Each outcome says what every person it serves can do when it works, how that is assessed, the criteria a performance is judged on, the target that counts as passing, and the evidence anyone can review. The factory may build it any way it likes; the people it serves are measured the same, pre-defined way.

**Status:** ${fw.complete ? 'complete: every outcome has its assessments, criteria, targets and evidence.' : `not complete: ${fw.outcomes.filter((o) => !o.complete).length} of ${fw.outcomes.length} outcomes still need something set before release.`}

\`\`\`mermaid
erDiagram
  OUTCOME ||--|{ ASSESSMENT : "is assessed by"
  ASSESSMENT ||--|{ CRITERION : "judged on"
  ASSESSMENT ||--|| TARGET : "passes at"
  ASSESSMENT ||--|{ EVIDENCE : "documented by"
  FEATURE ||--|{ OUTCOME : "delivers"
  PLATFORM_OUTCOME ||--|{ MAP_CELL : "is mapped by"
  FEATURE ||--|{ MAP_CELL : "introduces, refines or masters"
  OUTCOME { string id PK  int balloon  string outcome }
  ASSESSMENT { string id PK  string method  string when  string instrument }
  TARGET { string passing }
  EVIDENCE { string path }
  PLATFORM_OUTCOME { string id PK  string outcome  string passing }
  MAP_CELL { string feature FK  string platform FK  string level }
\`\`\`

${fw.outcomes.map((o) => `## [${o.balloon}] ${o.outcome}

For: ${o.who.join('; ') || 'the people on the schematic'}.${o.missing.length ? ` **Still to set:** ${o.missing.join('; ')}.` : ''}

| Assessment | When | Instrument | Performance criteria | Passing | Evidence |
| --- | --- | --- | --- | --- | --- |
${o.assessments.map((a) => `| ${a.method} | ${a.when} | ${cell(a.instrument)} | ${a.criteria.map(cell).join('<br>') || '–'} | ${a.passing ? cell(a.passing) : '**not set**'} | ${a.evidence.map((e) => `\`${e}\``).join('<br>') || '–'} |`).join('\n')}
`).join('\n')}
## Platform outcomes

What every person can count on in every app, whatever the feature. Each is mapped across the features in \`outcomes/map.md\`.

| Outcome | Assessed by | Criteria | Passing | Highest level here |
| --- | --- | --- | --- | --- |
${fw.platform.map((po) => `| ${cell(po.outcome)} | ${cell(po.assessment)} | ${po.criteria.map(cell).join('<br>')} | ${cell(po.passing)} | ${LEVEL_NAME[po.highest]} |`).join('\n')}
`;
  const name = (id: string) => fw.platform.find((x) => x.id === id)!.outcome.split(/,| when /)[0]!;
  const map = `# Platform outcomes, mapped across the features

**I**, introduced: ${LEVEL_WHAT.I.toLowerCase()}. **R**, refined: ${LEVEL_WHAT.R.toLowerCase()}. **M**, mastered: ${LEVEL_WHAT.M.toLowerCase()}.

| Feature | ${fw.platform.map((po) => po.id).join(' | ')} |
| --- | ${fw.platform.map(() => ':-:').join(' | ')} |
${fw.features.map((f) => `| ${cell(f.gives)} | ${fw.platform.map((po) => fw.map.find((c) => c.feature === f.id && c.platform === po.id)!.level).join(' | ')} |`).join('\n')}
| **Highest** | ${fw.platform.map((po) => `**${po.highest}**`).join(' | ')} |

${fw.platform.filter((po) => po.highest !== 'M').length ? `**Not yet mastered anywhere:** ${fw.platform.filter((po) => po.highest !== 'M').map((po) => `${po.id} (${name(po.id)})`).join('; ')}. Each is proved at full depth by adding the journey that masters it to a feature.` : 'Every platform outcome is mastered by at least one feature.'}

## Why each cell is what it is

${fw.features.map((f) => `- **${cell(f.gives)}:** ${fw.map.filter((c) => c.feature === f.id && c.level !== 'I').map((c) => `${c.platform} ${c.level}, ${c.because}`).join('; ') || 'every platform outcome introduced, from the team minimum'}`).join('\n')}
`;
  return { 'outcomes/framework.json': `${JSON.stringify(json, null, 1)}\n`, 'outcomes/framework.md': md, 'outcomes/map.md': map };
}
