/**
 * The reports the factory writes about a running app, from evidence rather than by hand: a report for each
 * feature, an operations report, and the weekly improvement brief. Each is a document as data (sections with
 * text, a table and findings, and every finding carries the evidence it rests on), and each renders to Markdown.
 *
 * A feature report says who uses the feature, whether its journeys complete within their budgets, where people
 * stop, and what was refused or went wrong. No group smaller than the small-cell threshold is ever shown, so no
 * one can be picked out. The operations report covers availability against each objective, response times
 * against the feedback budget, errors by feature, incidents, every run, who read what, and what model calls cost.
 *
 * The improvement brief ranks what to change next by evidence: failed walks, incidents, complaints, journeys people
 * leave or that run over budget, cost over budget, walks nobody designed, and people who are not who the schematic
 * expected. Each entry says the change it suggests and why, with its points shown, so the order can be checked.
 *
 * Reports are delivered on a cron schedule through a sender interface, and every delivery is logged.
 */
import { cron } from '../jobs/index.ts';
import type { Job } from '../jobs/index.ts';
import type { Incident, Objective, Window } from '../slo/index.ts';
import { budget } from '../slo/index.ts';
import type { Pipeline } from '../pipeline/index.ts';
import type { Severity } from '../feedback/index.ts';

export const SMALL_CELL = 10;

export type Cell = string | number | null;
export interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
}
export interface Finding {
  readonly level: 'ok' | 'attention' | 'action';
  readonly text: string;
  readonly evidence: readonly string[];
}
export interface Section {
  readonly heading: string;
  readonly text: readonly string[];
  readonly table?: Table;
  readonly findings: readonly Finding[];
}
export interface Doc {
  readonly title: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly sections: readonly Section[];
}

/** One walk of a journey, as the app records it: under a session key that names no one. */
export interface Walk {
  readonly journey: string;
  readonly feature: string;
  readonly persona: string;
  readonly session: string;
  readonly at: string;
  readonly outcome: 'completed' | 'abandoned' | 'refused' | 'error';
  readonly actions: number;
  readonly ms: number;
  /** The step where the person stopped, for a walk that did not complete. */
  readonly stoppedAt?: string;
  readonly error?: string;
  readonly refusal?: string;
}

/** A journey as the package declares it: its goal and the budget it must finish within. */
export interface Journey {
  readonly id: string;
  readonly feature: string;
  readonly goal: string;
  readonly persona: string;
  readonly budget: { readonly actions: number; readonly ms: number };
}

const inPeriod = (at: string, from: string, to: string) => at >= from && at < to;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const hours = (x: number | null) => (x === null ? 'not measured' : `${x} hours`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** Nearest-rank percentile. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
const withinBudget = (w: Walk, j: Journey) => w.outcome === 'completed' && w.actions <= j.budget.actions && w.ms <= j.budget.ms;
const countBy = <T>(xs: readonly T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
};

// ---------------------------------------------------------------- feature report

export function featureReport(feature: { readonly id: string; readonly name: string }, journeys: readonly Journey[], walks: readonly Walk[], o: { readonly from: string; readonly to: string; readonly minGroup?: number; readonly target?: number }): Doc {
  const min = o.minGroup ?? SMALL_CELL;
  const target = o.target ?? 0.9;
  const mine = journeys.filter((j) => j.feature === feature.id);
  const ws = walks.filter((w) => w.feature === feature.id && inPeriod(w.at, o.from, o.to));
  const goal = (id: string) => mine.find((j) => j.id === id)?.goal ?? id;

  // Who uses it: distinct sessions per persona, small groups hidden.
  const people = new Map<string, Set<string>>();
  for (const w of ws) people.set(w.persona, (people.get(w.persona) ?? new Set()).add(w.session));
  const shown = [...people].filter(([, s]) => s.size >= min).sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  const hidden = people.size - shown.length;
  const everyone = new Set(ws.map((w) => w.session)).size;
  const who: Section = {
    heading: 'Who uses it',
    text: [everyone < min ? `Fewer than ${min} people used it in this period, so no breakdown is shown.` : `${everyone} people used it in this period.`, ...(hidden && everyone >= min ? [`${plural(hidden, 'smaller group is', 'smaller groups are')} not shown, so no one can be picked out.`] : [])],
    ...(everyone >= min ? { table: { columns: ['Who', 'People', 'Walks'], rows: shown.map(([p, s]) => [p, s.size, ws.filter((w) => w.persona === p).length]) } } : {}),
    findings: [],
  };

  // Journeys against their budgets.
  const jf: Finding[] = [];
  const jrows = mine.map((j) => {
    const mw = ws.filter((w) => w.journey === j.id);
    const done = mw.filter((w) => w.outcome === 'completed');
    const within = mw.filter((w) => withinBudget(w, j)).length;
    const share = pct(within, mw.length);
    if (!mw.length) jf.push({ level: 'attention', text: `Nobody walked "${j.goal}" in this period.`, evidence: [] });
    else if (within / mw.length < target) jf.push({ level: 'attention', text: `Only ${share}% of walks of "${j.goal}" finished within its budget of ${j.budget.actions} actions and ${j.budget.ms} ms.`, evidence: [`${plural(mw.length, 'walk')}, ${done.length} completed, ${within} within budget`] });
    return [j.goal, mw.length, done.length, within, share, median(done.map((w) => w.ms)), median(done.map((w) => w.actions))] as Cell[];
  });
  const journeysSec: Section = { heading: 'Whether its journeys complete within budget', text: [`A walk counts when it completes within its journey’s action and time budget; the target is ${Math.round(target * 100)}%.`], table: { columns: ['Journey', 'Walks', 'Completed', 'Within budget', 'Within budget (%)', 'Median ms', 'Median actions'], rows: jrows }, findings: jf };

  // Where people stop.
  const left = ws.filter((w) => w.outcome === 'abandoned');
  const stops = [...countBy(left, (w) => `${w.journey}\n${w.stoppedAt ?? 'unknown step'}`)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = stops[0];
  const stop: Section = {
    heading: 'Where people stop',
    text: [left.length ? `${plural(left.length, 'walk')} ended before the goal.` : 'Nobody left a journey before the goal.'],
    ...(stops.length ? { table: { columns: ['Journey', 'Step', 'Stopped'], rows: stops.map(([k, n]) => { const [j, s] = k.split('\n'); return [goal(j!), s!, n]; }) } } : {}),
    findings: top ? [{ level: 'attention', text: `Most people who leave "${goal(top[0].split('\n')[0]!)}" stop at ${top[0].split('\n')[1]}.`, evidence: [`${top[1]} of ${left.length} abandoned walks`] }] : [],
  };

  // Refusals and errors.
  const rf: Finding[] = [];
  const rrows = mine.map((j) => {
    const mw = ws.filter((w) => w.journey === j.id);
    const ref = mw.filter((w) => w.outcome === 'refused');
    const err = mw.filter((w) => w.outcome === 'error');
    if (err.length) rf.push({ level: 'action', text: `${plural(err.length, 'walk')} of "${j.goal}" ended in an error.`, evidence: [...new Set(err.map((w) => w.error ?? 'no message recorded'))].slice(0, 3) });
    return [j.goal, ref.length, err.length] as Cell[];
  });
  const refusals: Section = { heading: 'Refusals and errors', text: ['A refusal is the app saying no as designed; an error is the app failing.'], table: { columns: ['Journey', 'Refused', 'Errors'], rows: rrows }, findings: rf };

  return { title: `${feature.name}: use and health`, period: { from: o.from, to: o.to }, sections: [who, journeysSec, stop, refusals] };
}

// ---------------------------------------------------------------- operations report

export interface Request {
  readonly feature: string;
  readonly ms: number;
  readonly status: number;
  readonly at: string;
}

export interface CostLine {
  readonly meter: string;
  readonly feature: string;
  readonly units: number;
  readonly cents: number;
}

export interface Operations {
  readonly from: string;
  readonly to: string;
  readonly objectives?: readonly { readonly objective: Objective; readonly window: Window }[];
  readonly requests?: readonly Request[];
  /** The time within which a person must see a response. */
  readonly feedbackMs?: number;
  readonly incidents?: readonly Incident[];
  readonly delivery?: ReturnType<Pipeline['measures']>;
  readonly jobs?: readonly Job[];
  readonly reads?: readonly { readonly who: string; readonly what: string; readonly at: string }[];
  /** Bill lines (from the cost meter) and the meters that are model calls. */
  readonly costs?: { readonly lines: readonly CostLine[]; readonly modelMeters?: RegExp; readonly budgetCents?: number };
}

export function operationsReport(o: Operations): Doc {
  const out: Section[] = [];
  if (o.objectives) {
    const f: Finding[] = [];
    const rows = o.objectives.map(({ objective: ob, window: w }) => {
      const b = budget(ob, w);
      if (b.remaining < 0) f.push({ level: 'action', text: `${ob.name} spent its error budget.`, evidence: [`${b.bad} failures against ${Math.floor(b.allowedBad)} allowed over ${ob.windowDays} days`] });
      return [ob.name, ob.target * 100, pct(w.good, w.total), b.allowedBad ? Math.max(0, Math.round((b.remaining / b.allowedBad) * 100)) : null] as Cell[];
    });
    out.push({ heading: 'Availability', text: [], table: { columns: ['Objective', 'Target (%)', 'Achieved (%)', 'Budget left (%)'], rows }, findings: f });
  }
  const reqs = (o.requests ?? []).filter((r) => inPeriod(r.at, o.from, o.to));
  if (o.requests) {
    const fb = o.feedbackMs ?? 1000;
    const feats = [...new Set(reqs.map((r) => r.feature))].sort();
    const f: Finding[] = [];
    const rows = feats.map((ft) => {
      const ms = reqs.filter((r) => r.feature === ft).map((r) => r.ms);
      const p95 = percentile(ms, 95)!;
      if (p95 > fb) f.push({ level: 'attention', text: `${ft} is slower than the feedback budget for one request in twenty.`, evidence: [`95th percentile ${p95} ms against ${fb} ms`] });
      return [ft, ms.length, percentile(ms, 50), p95, pct(ms.filter((x) => x <= fb).length, ms.length)] as Cell[];
    });
    out.push({ heading: 'Response times', text: [`The feedback budget is ${fb} ms.`], table: { columns: ['Feature', 'Requests', 'Median ms', '95th percentile ms', 'Within budget (%)'], rows }, findings: f });
    const ef: Finding[] = [];
    const erows = feats.map((ft) => {
      const mine = reqs.filter((r) => r.feature === ft);
      const bad = mine.filter((r) => r.status >= 500).length;
      if (bad) ef.push({ level: 'action', text: `${ft} failed ${plural(bad, 'request')}.`, evidence: [`${pct(bad, mine.length)}% of ${mine.length} requests answered 500 or above`] });
      return [ft, mine.length, bad, pct(bad, mine.length)] as Cell[];
    }).sort((a, b) => (b[2] as number) - (a[2] as number) || String(a[0]).localeCompare(String(b[0])));
    out.push({ heading: 'Errors by feature', text: [], table: { columns: ['Feature', 'Requests', 'Errors', 'Error rate (%)'], rows: erows }, findings: ef });
  }
  if (o.incidents) {
    const mine = o.incidents.filter((i) => inPeriod(i.started, o.from, o.to) || i.status !== 'resolved');
    const f: Finding[] = [];
    for (const i of mine) {
      if (i.status !== 'resolved') f.push({ level: 'action', text: `Incident ${i.id}, "${i.title}", is still ${i.status}.`, evidence: [`opened ${i.started}`] });
      else if (i.severity <= 2 && !i.postmortem) f.push({ level: 'attention', text: `Incident ${i.id}, "${i.title}", owes a postmortem.`, evidence: [`severity ${i.severity}, resolved ${i.resolved}`] });
    }
    out.push({ heading: 'Incidents', text: [mine.length ? `${plural(mine.length, 'incident')} in this period or still open.` : 'No incidents.'], table: { columns: ['Incident', 'Title', 'Severity', 'Status', 'Minutes to resolve'], rows: mine.map((i) => [i.id, i.title, i.severity, i.status, i.resolved ? Math.round((Date.parse(i.resolved) - Date.parse(i.started)) / 60_000) : null]) }, findings: f });
  }
  if (o.delivery || o.jobs) {
    const text: string[] = [];
    const f: Finding[] = [];
    if (o.delivery) {
      const d = o.delivery;
      text.push(`${plural(d.deploys, 'deploy')} (${d.perDay} a day); median lead time ${hours(d.leadTimeHoursMedian)}; change failure rate ${d.changeFailureRate === null ? 'not measured' : `${pct(d.changeFailureRate, 1)}%`}; median time to restore ${hours(d.restoreHoursMedian)}.`);
    }
    const jobs = (o.jobs ?? []).filter((j) => inPeriod(new Date(j.created).toISOString(), o.from, o.to));
    const kinds = [...new Set(jobs.map((j) => j.kind))].sort();
    const rows = kinds.map((k) => {
      const mine = jobs.filter((j) => j.kind === k);
      const dead = mine.filter((j) => j.state === 'dead');
      if (dead.length) f.push({ level: 'action', text: `${plural(dead.length, `${k} job`)} gave up.`, evidence: [...new Set(dead.map((j) => j.lastError ?? 'no message recorded'))] });
      return [k, mine.length, mine.filter((j) => j.state === 'done').length, dead.length, mine.filter((j) => j.state === 'waiting' || j.state === 'running').length] as Cell[];
    });
    out.push({ heading: 'Every run', text, ...(o.jobs ? { table: { columns: ['Job', 'Runs', 'Done', 'Gave up', 'Waiting'], rows } } : {}), findings: f });
  }
  if (o.reads) {
    const mine = o.reads.filter((r) => inPeriod(r.at, o.from, o.to));
    const rows = [...countBy(mine, (r) => `${r.who}\n${r.what}`)].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => [...k.split('\n'), n] as Cell[]);
    out.push({ heading: 'Who read what', text: [mine.length ? `${plural(mine.length, 'sensitive read')} recorded.` : 'No sensitive reads were recorded.'], table: { columns: ['Who', 'What', 'Reads'], rows }, findings: [] });
  }
  if (o.costs) {
    const re = o.costs.modelMeters ?? /model|token/i;
    const lines = o.costs.lines.filter((l) => re.test(l.meter));
    const total = Math.round(lines.reduce((s, l) => s + l.cents, 0) * 100) / 100;
    const f: Finding[] = o.costs.budgetCents !== undefined && total > o.costs.budgetCents ? [{ level: 'attention', text: 'Model calls cost more than their budget.', evidence: [`${total} cents against ${o.costs.budgetCents}`] }] : [];
    out.push({ heading: 'What model calls cost', text: [`${total} cents in this period.`], table: { columns: ['Feature', 'Meter', 'Units', 'Cents'], rows: [...lines].sort((a, b) => b.cents - a.cents || a.feature.localeCompare(b.feature)).map((l) => [l.feature, l.meter, l.units, l.cents]) }, findings: f });
  }
  return { title: 'Operations', period: { from: o.from, to: o.to }, sections: out };
}

// ---------------------------------------------------------------- improvement brief

export type Change = 'fix' | 'simplify' | 'cut cost' | 'add journey' | 'retune people';

export interface Suggestion {
  readonly rank: number;
  readonly feature: string | null;
  readonly change: Change;
  readonly suggestion: string;
  readonly points: number;
  /** The evidence, one sentence each, with the points it adds. */
  readonly why: readonly string[];
}

export interface BriefInput {
  readonly from: string;
  readonly to: string;
  readonly journeys: readonly Journey[];
  readonly walks: readonly Walk[];
  readonly incidents?: readonly { readonly feature: string; readonly incident: Incident }[];
  readonly complaints?: readonly { readonly feature: string; readonly title: string; readonly severity?: Severity; readonly count: number }[];
  readonly costs?: readonly { readonly feature: string; readonly cents: number; readonly budgetCents: number }[];
  /** Walks people took that no journey describes. */
  readonly undesigned?: readonly { readonly feature?: string; readonly steps: readonly string[]; readonly count: number }[];
  /** Who the schematic expected, and who came. */
  readonly personas?: { readonly expected: readonly string[]; readonly seen: readonly { readonly persona: string; readonly people: number }[] };
  readonly minGroup?: number;
  readonly limit?: number;
}

/** What each piece of evidence weighs; the brief prints these beside every reason. */
export const POINTS = {
  error: 5,
  abandoned: 2,
  overBudget: 1,
  incident: { 1: 40, 2: 20, 3: 8 } as Readonly<Record<1 | 2 | 3, number>>,
  complaint: { blocker: 10, major: 5, minor: 2, cosmetic: 1, untriaged: 3 } as Readonly<Record<Severity | 'untriaged', number>>,
  /** Per percent over budget. */
  costPercent: 1,
  /** Per two walks nobody designed. */
  undesignedPair: 1,
  /** Per percent of people who are not who the schematic expected. */
  personaPercent: 1,
} as const;

export function improvementBrief(b: BriefInput): { ranked: Suggestion[]; omitted: number; doc: Doc } {
  const min = b.minGroup ?? SMALL_CELL;
  const items = new Map<string, { feature: string | null; change: Change; points: number; why: string[]; headline: string[] }>();
  const add = (feature: string | null, change: Change, points: number, why: string, headline: string) => {
    if (points <= 0) return;
    const k = `${feature ?? ''}\n${change}`;
    const it = items.get(k) ?? { feature, change, points: 0, why: [], headline: [] };
    it.points += points;
    it.why.push(`${why} (${points} points)`);
    it.headline.push(headline);
    items.set(k, it);
  };
  const ws = b.walks.filter((w) => inPeriod(w.at, b.from, b.to));
  for (const j of b.journeys) {
    const mw = ws.filter((w) => w.journey === j.id);
    const err = mw.filter((w) => w.outcome === 'error');
    if (err.length) add(j.feature, 'fix', err.length * POINTS.error, `${plural(err.length, 'walk')} of "${j.goal}" ended in an error${err[0]!.error ? `: ${err[0]!.error}` : ''}.`, `the error in "${j.goal}"`);
    const left = mw.filter((w) => w.outcome === 'abandoned');
    const over = mw.filter((w) => w.outcome === 'completed' && !withinBudget(w, j));
    if (left.length) {
      const top = [...countBy(left, (w) => w.stoppedAt ?? 'an unknown step')].sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))[0]!;
      add(j.feature, 'simplify', left.length * POINTS.abandoned, `${plural(left.length, 'person', 'people')} left "${j.goal}"; ${top[1]} stopped at ${top[0]}.`, `the step ${top[0]} in "${j.goal}"`);
    }
    if (over.length) add(j.feature, 'simplify', over.length * POINTS.overBudget, `${plural(over.length, 'walk')} of "${j.goal}" finished over its budget of ${j.budget.actions} actions and ${j.budget.ms} ms.`, `"${j.goal}" so it fits its budget`);
  }
  for (const { feature, incident: i } of b.incidents ?? []) if (inPeriod(i.started, b.from, b.to)) add(feature, 'fix', POINTS.incident[i.severity], `Incident ${i.id}, "${i.title}", severity ${i.severity}.`, `the cause of "${i.title}"`);
  for (const c of b.complaints ?? []) add(c.feature, 'fix', c.count * POINTS.complaint[c.severity ?? 'untriaged'], `${plural(c.count, 'person', 'people')} reported "${c.title}"${c.severity ? ` (${c.severity})` : ', not yet triaged'}.`, `"${c.title}"`);
  for (const c of b.costs ?? []) {
    const over = c.budgetCents ? Math.round(((c.cents - c.budgetCents) / c.budgetCents) * 100) : 0;
    if (c.cents > c.budgetCents) add(c.feature, 'cut cost', Math.max(1, over) * POINTS.costPercent, `It cost ${c.cents} cents against a budget of ${c.budgetCents}, ${over}% over.`, 'what it spends');
  }
  for (const u of b.undesigned ?? []) if (u.count >= min) add(u.feature ?? null, 'add journey', Math.floor(u.count / 2) * POINTS.undesignedPair, `${u.count} walks went ${u.steps.join(' → ')}, and no journey describes it.`, u.steps.join(' → '));
  if (b.personas) {
    const total = b.personas.seen.reduce((s, p) => s + p.people, 0);
    for (const p of b.personas.seen) if (!b.personas.expected.includes(p.persona) && p.people >= min && total) {
      const share = Math.round((p.people / total) * 100);
      add(null, 'retune people', share * POINTS.personaPercent, `${p.people} of ${total} people (${share}%) are ${p.persona}, whom the schematic does not expect.`, p.persona);
    }
  }
  const say = (c: Change, h: readonly string[]) => {
    const list = [...new Set(h)].join('; ');
    switch (c) {
      case 'fix': return `Write the failing test that shows it, then fix it: ${list}.`;
      case 'simplify': return `Take steps out of ${list}.`;
      case 'cut cost': return `Cut ${list}, or raise its budget on purpose.`;
      case 'add journey': return `Add a journey for what people already do: ${list}.`;
      case 'retune people': return `Retune the people the schematic is tuned for to include ${list}, or find out why they come.`;
    }
  };
  const all = [...items.values()].sort((a, c) => c.points - a.points || (a.feature ?? '').localeCompare(c.feature ?? '') || a.change.localeCompare(c.change));
  const limit = b.limit ?? 10;
  const ranked: Suggestion[] = all.slice(0, limit).map((it, i) => ({ rank: i + 1, feature: it.feature, change: it.change, suggestion: say(it.change, it.headline), points: it.points, why: it.why }));
  const omitted = Math.max(0, all.length - limit);
  const doc: Doc = {
    title: 'Improvement brief',
    period: { from: b.from, to: b.to },
    sections: [
      {
        heading: 'What to change next',
        text: [ranked.length ? `Ranked by evidence: failed walks, incidents, complaints, people leaving, budgets and cost, walks nobody designed, and people the schematic did not expect.${omitted ? ` ${plural(omitted, 'smaller item is', 'smaller items are')} not shown.` : ''}` : 'The evidence this week suggests no change.'],
        table: { columns: ['Rank', 'Feature', 'Change', 'Points'], rows: ranked.map((r) => [r.rank, r.feature ?? 'Whole app', r.change, r.points]) },
        findings: ranked.map((r) => ({ level: r.change === 'fix' ? 'action' : 'attention', text: `${r.rank}. ${r.feature ? `${r.feature}: ` : ''}${r.suggestion}`, evidence: r.why })),
      },
    ],
  };
  return { ranked, omitted, doc };
}

// ---------------------------------------------------------------- Markdown

const cell = (c: Cell) => (c === null ? '—' : String(c).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
const LEVEL: Readonly<Record<Finding['level'], string>> = { ok: 'Fine', attention: 'Attention', action: 'Action' };

export function markdown(d: Doc): string {
  const out = [`# ${d.title}`, '', `${d.period.from} to ${d.period.to}`];
  if (!d.sections.length) out.push('', 'Nothing was measured for this period.');
  for (const s of d.sections) {
    out.push('', `## ${s.heading}`);
    for (const t of s.text) out.push('', t);
    if (s.table) {
      out.push('', `| ${s.table.columns.map(cell).join(' | ')} |`, `| ${s.table.columns.map(() => '---').join(' | ')} |`);
      if (!s.table.rows.length) out.push(`| ${s.table.columns.map((_, i) => (i ? '' : 'None')).join(' | ')} |`);
      for (const r of s.table.rows) out.push(`| ${r.map(cell).join(' | ')} |`);
    }
    if (s.findings.length) {
      out.push('');
      for (const f of s.findings) out.push(`- **${LEVEL[f.level]}:** ${f.text}${f.evidence.length ? ` Evidence: ${f.evidence.join('; ')}.` : ''}`.replace(/\.\./g, '.'));
    }
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- delivery

export interface Sender {
  send(to: readonly string[], title: string, markdown: string): Promise<void>;
}

export interface Scheduled {
  readonly id: string;
  readonly cron: string;
  readonly to: readonly string[];
  readonly build: (now: Date) => Doc;
  next: number;
}

/** Runs each report on its schedule and sends it; a failure is logged and does not stop the rest. */
export class Publisher {
  readonly log: { id: string; at: string; ok: boolean; sections: number; error?: string }[] = [];
  readonly scheduled: Scheduled[] = [];
  private readonly sender: Sender;
  constructor(sender: Sender) {
    this.sender = sender;
  }
  add(id: string, expr: string, to: readonly string[], build: (now: Date) => Doc, now: Date): Scheduled {
    if (this.scheduled.some((s) => s.id === id)) throw new Error(`${id} is already scheduled`);
    if (!to.length) throw new Error(`${id} needs someone to send it to`);
    const s: Scheduled = { id, cron: expr, to, build, next: cron(expr).next(now).getTime() };
    this.scheduled.push(s);
    return s;
  }
  async tick(now: Date): Promise<number> {
    let n = 0;
    for (const s of this.scheduled) {
      if (s.next > now.getTime()) continue;
      try {
        const d = s.build(now);
        await this.sender.send(s.to, d.title, markdown(d));
        this.log.push({ id: s.id, at: now.toISOString(), ok: true, sections: d.sections.length });
      } catch (e) {
        this.log.push({ id: s.id, at: now.toISOString(), ok: false, sections: 0, error: e instanceof Error ? e.message : String(e) });
      }
      s.next = cron(s.cron).next(now).getTime();
      n++;
    }
    return n;
  }
}
