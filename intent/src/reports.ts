/**
 * Reports, written from the datum: one for every feature, for the system as it runs, for use as a whole, and for the
 * journeys people really walk. Each is a saved query against the query console's views, a chart, a schedule and a
 * place to deliver it, so a report is never hand-built and never drifts from what the app does.
 *
 * The last step closes the loop. Walks nobody designed, journeys people abandon, measures out of tolerance and people
 * who are not the people the schematic was tuned for come back as proposals: a journey to add, a person to retune, a
 * balloon to redline. A person decides; the next revision of the intent carries it.
 *
 * What is tracked is set on the spec sheet, and every level keeps the same floor: no free text, no sensitive field,
 * and no group smaller than the small-cell threshold is ever shown.
 */
import { connector } from './connectors.ts';
import { features, type Settled } from './interfaces.ts';
import type { Manifest } from './manifest.ts';
import type { Prepared } from './pipeline.ts';
import type { Gauge } from './release.ts';

/** How much the app records about use. Counts is the default: enough to improve the product, naming no one. */
export type Usage = 'off' | 'counts' | 'consented';
export const USAGE: readonly Usage[] = ['counts', 'consented', 'off'];
export const SMALL_CELL = 10;

export const USAGE_WHAT: Record<Usage, string> = {
  off: 'No use is recorded. Operations reports still run from requests and errors, which name no one.',
  counts: 'Journeys and features are counted, with a session key that changes every day, so walks can be followed within a visit and no one can be followed across visits. Assistive technology is never recorded.',
  consented: 'People who agree are followed across visits under a key that does not name them, so returning use and change over time show. Assistive technology and language are recorded only for those who opt in. Everyone else is counted as at the counts level.',
};

type Scope = 'feature' | 'journeys' | 'measures' | 'operations' | 'usage' | 'improvement';
interface Report {
  readonly id: string;
  readonly title: string;
  readonly scope: Scope;
  readonly audience: string;
  readonly answers: string;
  readonly chart: 'funnel' | 'line' | 'bar' | 'table' | 'gauge';
  readonly schedule: 'daily' | 'weekly' | 'monthly';
  readonly needs: Usage | 'ops';
  readonly sql: string;
}

const q = (s: string) => s.replace(/'/g, "''");

function featureReport(f: { id: string; line: { gives: string; journeys: readonly string[] } }, ms: number, api: boolean): Report {
  return {
    id: `feature-${f.id}`,
    title: `${f.line.gives}: use and health`,
    scope: 'feature',
    audience: 'The team that owns it, and the person who holds the intent',
    answers: 'Is it used, does it work for the people who use it, and where does it go wrong?',
    chart: 'line',
    schedule: 'weekly',
    needs: 'counts',
    sql: `-- ${f.line.gives}
with w as (
  select date_trunc('week', e.occurred) as week, e.* from events e where e.feature = '${f.id}'
), r as (
  select date_trunc('week', q.occurred) as week,
    count(*) filter (where q.status >= 500) as errors,
    count(*) filter (where q.channel = 'api') as api_calls
  from requests q where q.feature = '${f.id}' group by 1
)
select w.week,
  count(distinct w.session) as sessions,
  count(*) filter (where w.kind = 'journey.completed') as completed,
  round(100.0 * count(*) filter (where w.kind = 'journey.completed') / nullif(count(*) filter (where w.kind = 'journey.started'), 0), 1) as completion_pct,
  percentile_cont(0.5) within group (order by w.ms) filter (where w.kind = 'journey.completed') as median_ms,
  count(*) filter (where w.kind = 'journey.completed' and w.ms > ${ms}) as over_budget,
  count(*) filter (where w.kind = 'journey.refused') as refused,
  coalesce(max(r.errors), 0) as errors${api ? `,
  coalesce(max(r.api_calls), 0) as api_calls` : ''}
from w left join r on r.week = w.week
group by w.week
having count(distinct w.session) >= ${SMALL_CELL}
order by 1;`,
  };
}

function reports(p: Prepared, m: Manifest, s: Settled, cards: readonly Gauge[]): Report[] {
  const fs = features(m);
  const budget = (ids: readonly string[]) => Math.max(1000, ...cards.filter((g) => ids.includes(g.id)).map((g) => g.budget.ms));
  const feedback = /within\s+([\d.]+)\s*second/i.exec(p.title['feedback']?.value ?? '')?.[1];
  const feedbackMs = feedback ? Number(feedback) * 1000 : 1000;
  const out: Report[] = fs.map((f) => featureReport(f, budget(f.line.journeys), s.api.reach === 'all' || s.api.features.includes(f.id)));
  out.push(
    {
      id: 'journeys-observed', title: 'Journeys: designed and walked', scope: 'journeys', audience: 'Product and QA',
      answers: 'For every journey card, how many start it, where they stop, and whether it fits its budget of actions and time.',
      chart: 'funnel', schedule: 'weekly', needs: 'counts',
      sql: `select e.journey, count(*) filter (where e.kind = 'journey.started') as started,
  count(*) filter (where e.kind = 'journey.completed') as completed,
  (select a.step from events a where a.journey = e.journey and a.kind = 'journey.abandoned' group by a.step order by count(*) desc, a.step limit 1) as most_left_at,
  count(*) filter (where e.kind = 'journey.completed' and (e.ms > j.budget_ms or e.actions > j.budget_actions)) as over_budget,
  count(*) filter (where e.kind = 'journey.forbidden') as forbidden_outcomes
from events e join journeys j on j.id = e.journey
group by e.journey
having count(*) filter (where e.kind = 'journey.started') >= ${SMALL_CELL}
order by completed * 1.0 / nullif(started, 0);`,
    },
    {
      id: 'journeys-unmapped', title: 'Walks no journey card covers', scope: 'journeys', audience: 'Product',
      answers: 'Paths people take that nobody designed or tests. Each common one is proposed as a new journey card.',
      chart: 'table', schedule: 'weekly', needs: 'counts',
      sql: `select e.path, count(distinct e.session) as sessions, round(avg(e.ms)) as avg_ms
from walks e
where e.journey is null
group by e.path
having count(distinct e.session) >= ${SMALL_CELL}
order by sessions desc
limit 20;`,
    },
    {
      id: 'people-observed', title: 'Who uses it, against who it was tuned for', scope: 'journeys', audience: 'Product, and the person who holds the intent',
      answers: 'Devices, languages and how often people return, against the people on the schematic. A gap means a person to retune or a journey to add.',
      chart: 'bar', schedule: 'monthly', needs: 'counts',
      sql: `select e.persona, e.device_class, e.language, ${s.usage === 'consented' ? 'e.assistive, ' : ''}count(distinct e.session) as sessions
from events e
where e.kind = 'journey.started'
group by 1, 2, 3${s.usage === 'consented' ? ', 4' : ''}
having count(distinct e.session) >= ${SMALL_CELL};`,
    },
    {
      id: 'measures-live', title: 'Measures on the schematic, live', scope: 'measures', audience: 'Everyone, first',
      answers: 'Each measure the person signed, with its tolerance, its value now and its ratchet floor. Out of tolerance is a redline.',
      chart: 'gauge', schedule: 'daily', needs: 'counts',
      sql: `select m.balloon, m.text, m.tolerance, m.value, m.in_tolerance, m.floor
from measures m
order by m.in_tolerance, m.balloon;`,
    },
    {
      id: 'ops-health', title: 'Running: up, fast and correct', scope: 'operations', audience: 'Whoever runs it',
      answers: `Availability, response times against the title block's feedback budget (${feedbackMs} ms), and errors by feature.`,
      chart: 'line', schedule: 'daily', needs: 'ops',
      sql: `select date_trunc('hour', r.occurred) as hour, r.feature,
  count(*) as requests,
  percentile_cont(0.5) within group (order by r.ms) as p50_ms,
  percentile_cont(0.95) within group (order by r.ms) as p95_ms,
  count(*) filter (where r.ms > ${feedbackMs}) as over_feedback_budget,
  count(*) filter (where r.status >= 500) as errors
from requests r
group by 1, 2
order by 1 desc, errors desc;`,
    },
    {
      id: 'ops-runs', title: 'Jobs, imports and integrations', scope: 'operations', audience: 'Whoever runs it, and support',
      answers: 'Every recorded run: what came in, what it changed, what failed or was held in quarantine.',
      chart: 'table', schedule: 'daily', needs: 'ops',
      sql: `select r.kind, r.name, count(*) as runs, count(*) filter (where r.outcome = 'failed') as failed,
  sum(r.created) as created, sum(r.changed) as changed, sum(r.quarantined) as quarantined
from runs r
where r.occurred > now() - interval '1 day'
group by 1, 2
order by failed desc, quarantined desc;`,
    },
    {
      id: 'ops-access', title: 'Who read and changed what', scope: 'operations', audience: 'Security and privacy',
      answers: 'Reads of sensitive fields, refusals by reason, acting as a user, UAT overrides, and API clients with the scopes they used.',
      chart: 'table', schedule: 'weekly', needs: 'ops',
      sql: `select a.kind, a.feature, a.reason, count(*) as events, count(distinct a.actor) as actors
from audit a
where a.kind in ('sensitive.read', 'permission.refused', 'act_as', 'override', 'api.call')
  and a.occurred > now() - interval '7 days'
group by 1, 2, 3
order by events desc;`,
    },
    {
      id: 'ops-cost', title: 'Model calls and what they cost', scope: 'operations', audience: 'Engineering',
      answers: 'Calls answered by deterministic code, by a recording, or by a live model, by feature. A live call that a recording could answer is waste.',
      chart: 'bar', schedule: 'weekly', needs: 'ops',
      sql: `select c.feature, count(*) filter (where c.answered_by = 'code') as by_code,
  count(*) filter (where c.answered_by = 'recording') as by_recording,
  count(*) filter (where c.answered_by = 'model') as live,
  sum(c.tokens) as tokens, sum(c.cost) as cost
from costs c
where c.occurred > now() - interval '7 days'
group by 1
order by live desc;`,
    },
    {
      id: 'usage-overview', title: 'Use as a whole', scope: 'usage', audience: 'The person who holds the intent, and leadership',
      answers: `People active by day, week and month, by role, which features they use, and ${s.usage === 'consented' ? 'how many come back' : 'visits per day'}.`,
      chart: 'line', schedule: 'monthly', needs: 'counts',
      sql: `select date_trunc('day', e.occurred) as day, e.persona,
  count(distinct e.${s.usage === 'consented' ? 'person_key' : 'session'}) as active,
  count(distinct e.feature) as features_used
from events e
group by 1, 2
having count(distinct e.session) >= ${SMALL_CELL}
order by 1;`,
    },
    {
      id: 'usage-by-revision', title: 'What each release changed', scope: 'usage', audience: 'Product and engineering',
      answers: 'Completion and time for every journey, revision against revision, next to the change notice that explains it.',
      chart: 'bar', schedule: 'weekly', needs: 'counts',
      sql: `select e.revision, e.journey,
  round(100.0 * count(*) filter (where e.kind = 'journey.completed') / nullif(count(*) filter (where e.kind = 'journey.started'), 0), 1) as completion_pct,
  percentile_cont(0.5) within group (order by e.ms) filter (where e.kind = 'journey.completed') as median_ms
from events e
group by 1, 2
having count(*) filter (where e.kind = 'journey.started') >= ${SMALL_CELL}
order by 2, 1;`,
    },
    {
      id: 'improvement-brief', title: 'What to improve next', scope: 'improvement', audience: 'The person who holds the intent',
      answers: 'One page: the journeys people leave, the ones over budget, walks nobody designed, people unlike those on the schematic, measures out of tolerance. Each with the change it suggests.',
      chart: 'table', schedule: 'weekly', needs: 'counts',
      sql: `-- Every saved report is also a view, report_<id>. This one reads the reports it summarises.
select 'journey left' as finding, journey as about, cast(most_left_at as varchar) as detail from report_journeys_observed where completed * 1.0 / nullif(started, 0) < 0.8
union all select 'over budget', journey, cast(over_budget as varchar) from report_journeys_observed where over_budget > 0
union all select 'not designed', path, cast(sessions as varchar) from report_journeys_unmapped
union all select 'out of tolerance', cast(balloon as varchar), text from report_measures_live where not in_tolerance;`,
    },
  );
  return out;
}

/** How a finding comes back to the intent: always as a proposal a person decides on. */
const LOOP = [
  { finding: 'A journey most people leave at the same step', proposes: 'A redline on the balloon that step serves, and a journey card for the way they leave' },
  { finding: 'A journey over its budget of actions or time', proposes: 'A tighter tolerance or a simpler path, as a redline' },
  { finding: 'A common walk no card covers', proposes: 'A new journey card, to control/proposals, signed in by a person' },
  { finding: 'Many people on small phones, in another language, or returning daily', proposes: 'Retune that person, which adds the small phone, another language or returning journeys' },
  { finding: 'A measure out of tolerance', proposes: 'A redline: change the design, or change the tolerance with a reason' },
  { finding: 'A forbidden outcome observed once', proposes: 'A stop: an alert now, a failing test before the next release, and a ratchet' },
];

function trackingPlan(p: Prepared, s: Settled, cards: readonly Gauge[]): string {
  return `${JSON.stringify(
    {
      schema: 'zthr-tracking-plan/1',
      level: s.usage,
      what: USAGE_WHAT[s.usage],
      smallCell: SMALL_CELL,
      retentionDays: s.usage === 'consented' ? 395 : s.usage === 'counts' ? 180 : 0,
      neverRecorded: ['free text people type', 'any field the data dictionary marks sensitive', 'names, emails or account ids', 'precise location', 'anything at all when the person has opted out'],
      keys: s.usage === 'off' ? [] : s.usage === 'counts' ? ['session (changes daily)'] : ['session (changes daily)', 'person_key (a keyed hash, only with consent)'],
      events: s.usage === 'off' ? [] : [
        { name: 'journey.started', props: ['journey', 'feature', 'persona', 'device_class', 'language', 'revision'] },
        { name: 'journey.step', props: ['journey', 'step', 'ms_since_start'] },
        { name: 'journey.completed', props: ['journey', 'ms', 'actions'] },
        { name: 'journey.abandoned', props: ['journey', 'step', 'ms'] },
        { name: 'journey.refused', props: ['journey', 'reason (from the permission explainer, never free text)'] },
        { name: 'journey.forbidden', props: ['journey', 'which forbidden outcome'], alert: true },
        ...(s.usage === 'consented' ? [{ name: 'person.tuned', props: ['assistive (opt-in only)', 'language', 'device_class'] }] : []),
      ],
      journeys: cards.map((g) => ({ id: g.id, persona: g.persona, goal: g.goal, budget: g.budget, forbidden: g.forbidden.length })),
      consent: s.usage === 'consented' ? 'Asked once, in plain words, with what is recorded and why; changeable any time from personal settings; withdrawing it deletes the person key.' : 'No consent is asked, because nothing names or follows a person.',
      title: p.model.title,
    },
    null,
    1,
  )}\n`;
}

export function reportFiles(p: Prepared, m: Manifest, s: Settled, cards: readonly Gauge[]): Record<string, string> {
  const rs = reports(p, m, s, cards);
  const runs = (r: Report) => r.needs === 'ops' || s.usage !== 'off';
  const deliver = ['email to the audience', ...(s.connect.chat !== 'none' ? [`a note in ${connector(s.connect.chat)?.name}`] : []), ...(s.connect.wiki !== 'none' ? [`a page in ${connector(s.connect.wiki)?.name}, monthly`] : [])];
  const out: Record<string, string> = {
    'reports/catalogue.json': `${JSON.stringify({ schema: 'zthr-reports/1', usage: s.usage, smallCell: SMALL_CELL, deliver, reports: rs.map((r) => ({ id: r.id, title: r.title, scope: r.scope, audience: r.audience, answers: r.answers, chart: r.chart, schedule: r.schedule, runs: runs(r), query: `reports/${r.id}.sql` })), loop: LOOP }, null, 1)}\n`,
    'analytics/tracking-plan.json': trackingPlan(p, s, cards),
    'reports/README.md': `# Reports

${rs.length} reports, written from the datum: ${rs.filter((r) => r.scope === 'feature').length} for features, ${rs.filter((r) => r.scope === 'operations').length} for running it, and the rest for journeys, measures, use as a whole and what to improve next. Each is a saved query against the query console's views (\`reports/<id>.sql\`), with a chart, a schedule and an audience. People build their own in the report builder from the same views, through the same access rules.

**Use tracking:** ${s.usage}. ${USAGE_WHAT[s.usage]} No group smaller than ${SMALL_CELL} is ever shown. Delivered by ${deliver.join(', ')}.

\`\`\`mermaid
flowchart LR
  W[People walk journeys] --> E[events, counted]
  R[Requests, runs, audit, model calls] --> V[Query console views]
  E --> V
  V --> F[Feature reports]
  V --> O[Operations reports]
  V --> J[Journeys: designed and walked]
  V --> M[Measures, live]
  J --> B[What to improve next]
  M --> B
  B --> P[Proposals: a journey, a retune, a redline]
  P --> I[Next revision of the intent]
\`\`\`

| Report | For | Answers | Every |
| --- | --- | --- | --- |
${rs.map((r) => `| ${r.title.replace(/\|/g, '\\|')}${runs(r) ? '' : ' (needs use tracking)'} | ${r.audience} | ${r.answers.replace(/\|/g, '\\|')} | ${r.schedule.replace('ly', '').replace('dai', 'day')} |`).join('\n')}

## How findings come back to the intent

| Finding | Proposes |
| --- | --- |
${LOOP.map((l) => `| ${l.finding} | ${l.proposes} |`).join('\n')}

A proposal changes nothing by itself. The person who holds the intent decides, and the next revision carries the change, with a change notice that says why.
`,
  };
  for (const r of rs) out[`reports/${r.id}.sql`] = `-- ${q(r.title)}\n-- ${r.answers}\n-- For: ${r.audience}. Every ${r.schedule.replace('ly', '').replace('dai', 'day')}. Groups under ${SMALL_CELL} are never shown.\n${r.sql}\n`;
  return out;
}
