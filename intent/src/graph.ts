/**
 * The intent as a graph: every statement, every instrument that will check it, and how they connect. The
 * schematics in the studio (the intent map, the datum structure, the inspection plan) are all views of this one
 * graph, so a line on a picture is always a real relation in the package, never decoration.
 *
 * The intent map is laid out as a FAST diagram (value engineering's function analysis): read left to right it
 * answers why, right to left how. The end in mind is on the left; the instruments that prove it are on the right.
 */
import type { Ballooned, Question, Slot } from './frame.ts';
import type { Prepared } from './pipeline.ts';
import { chosenJourneys, type Suggestion } from './journeys.ts';
import { outcomeGauges, type Gauge } from './release.ts';
import { rangeOf, workingRanges, type Range } from './tolerance.ts';

export type Lane = 'why' | 'people' | 'outcome' | 'checks' | 'instruments';
export const LANES: readonly { key: Lane; label: string; question: string }[] = [
  { key: 'why', label: 'Why', question: 'The end in mind, and what goes wrong today' },
  { key: 'people', label: 'Who', question: 'Who is it for, and who else it reaches' },
  { key: 'outcome', label: 'When it works', question: 'What will be true?' },
  { key: 'checks', label: 'Held to', question: 'Measures, rules and limits' },
  { key: 'instruments', label: 'Checked by', question: 'Gauges, ratchets, scenarios and controls' },
];

export type Kind =
  | 'end'
  | 'statement'
  | 'gauge'
  | 'forbidden'
  | 'ratchet'
  | 'scenario'
  | 'control'
  | 'question';

export interface Node {
  readonly id: string;
  readonly kind: Kind;
  readonly lane: Lane;
  readonly label: string;
  readonly balloon?: number;
  readonly statement?: Ballooned;
  readonly gauge?: Gauge;
  /** For a journey the person added: the suggestion it came from. */
  readonly suggestion?: Suggestion | null;
  readonly range?: Range;
  /** The file in the released package that holds this, when one does. */
  readonly file?: string;
  /** Open questions about this node. */
  readonly open: readonly Question[];
  /** What it is, in a few words, for the legend and the drawer. */
  readonly sub: string;
}

export type Relation = 'serves' | 'solves' | 'for' | 'measures' | 'limits' | 'checks' | 'forbids' | 'floors' | 'proves' | 'controls' | 'follows from';

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly rel: Relation;
}

export interface Graph {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

const LANE_OF: Record<Slot, Lane> = {
  why: 'why',
  problem: 'why',
  people: 'people',
  outcome: 'outcome',
  measures: 'checks',
  constraints: 'checks',
  nonGoals: 'checks',
  prerequisites: 'checks',
  implications: 'checks',
  assumptions: 'checks',
};

const SUB: Record<Slot, string> = {
  why: 'why it matters',
  problem: 'problem',
  people: 'person',
  outcome: 'outcome',
  measures: 'measure',
  constraints: 'rule',
  nonGoals: 'left out on purpose',
  prerequisites: 'also needed',
  implications: 'also affects',
  assumptions: 'taken as given',
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
const isNever = (s: Ballooned) => s.slot === 'constraints' && /^never\b|must not|never /i.test(s.text);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const overlap = (a: string, b: string) => {
  const x = words(a);
  const y = words(b);
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.max(1, Math.min(x.size, y.size));
};

export function graph(p: Prepared): Graph {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const st = p.statements;
  const openFor = (s: Ballooned) =>
    p.questions.filter((q) => (q.sourceOrigin && s.supplied.kind === 'person' && s.supplied.origin?.line === q.sourceOrigin.line) || q.text.includes(`"${s.text}"`) || (s.words && q.text.includes(`"${s.words}"`)));
  const sid = (s: Ballooned) => `b${s.balloon}`;

  // The end in mind leads everything.
  const end = p.model.end;
  nodes.push({ id: 'end', kind: 'end', lane: 'why', label: end ?? 'Not stated yet', sub: 'the end in mind', open: p.questions.filter((q) => q.id === 'end' || q.slot === 'why'), file: 'knowledge/end.md' });

  for (const s of st) {
    const kindSub = s.supplied.kind === 'lexicon' ? `feel: "${s.supplied.term}"` : SUB[s.slot];
    nodes.push({ id: sid(s), kind: 'statement', lane: LANE_OF[s.slot], label: s.text, balloon: s.balloon, statement: s, sub: kindSub, open: openFor(s), file: `knowledge/balloons/${s.balloon}.md`, ...(s.slot === 'measures' ? { range: rangeOf(s.tolerance) } : {}) });
  }
  const of = (slot: Slot) => st.filter((s) => s.slot === slot);
  const whys = of('why');
  const problems = of('problem');
  const outcomes = of('outcome');
  const people = of('people');

  // Why: each why serves the end; each problem serves the whys (or the end directly).
  for (const w of whys) edges.push({ from: sid(w), to: 'end', rel: 'serves' });
  for (const pr of problems) for (const t of whys.length ? whys.map(sid) : ['end']) edges.push({ from: sid(pr), to: t, rel: 'serves' });
  // Outcomes solve the problem; people are who the outcomes are for.
  for (const o of outcomes) for (const t of problems.length ? problems.map(sid) : whys.length ? whys.map(sid) : ['end']) edges.push({ from: sid(o), to: t, rel: 'solves' });
  for (const pe of people) for (const o of outcomes) edges.push({ from: sid(pe), to: sid(o), rel: 'for' });
  if (!outcomes.length) for (const pe of people) for (const pr of problems) edges.push({ from: sid(pe), to: sid(pr), rel: 'for' });

  // Checks: measures and rules hold the outcomes. A measure ties to the outcome it shares the most words with,
  // or to every outcome when none stands out; a rule limits every outcome.
  const holds = (s: Ballooned, rel: Relation) => {
    if (!outcomes.length) {
      edges.push({ from: sid(s), to: problems[0] ? sid(problems[0]) : 'end', rel });
      return;
    }
    const scored = outcomes.map((o) => [o, overlap(o.text, s.text)] as const).sort((a, b) => b[1] - a[1]);
    const best = scored[0]!;
    const targets = best[1] >= 0.34 ? [best[0]] : outcomes;
    for (const o of targets) edges.push({ from: sid(s), to: sid(o), rel });
  };
  for (const s of st.filter((x) => x.slot === 'measures')) holds(s, 'measures');
  for (const s of st.filter((x) => x.slot === 'constraints' || x.slot === 'nonGoals' || x.slot === 'prerequisites' || x.slot === 'implications' || x.slot === 'assumptions')) holds(s, 'limits');

  // Derived statements follow from the person's words that triggered them.
  for (const s of st.filter((x) => x.supplied.kind === 'derived' || x.supplied.kind === 'lexicon')) {
    const src = st.find((x) => x !== s && x.supplied.kind === 'person' && s.words && x.text.toLowerCase().includes(s.words.toLowerCase()));
    if (src) edges.push({ from: sid(s), to: sid(src), rel: 'follows from' });
  }

  // Instruments: what the factory will run, each in its file in the package.
  const gs = outcomeGauges(p);
  for (const g of gs) {
    const o = outcomes.find((x) => slug(x.text) === g.id);
    nodes.push({ id: `gauge:${g.id}`, kind: 'gauge', lane: 'instruments', label: g.goal, gauge: g, sub: `journey, as the ${g.persona}`, open: [], file: `gauges/${g.id}.yaml` });
    if (o) edges.push({ from: `gauge:${g.id}`, to: sid(o), rel: 'checks' });
  }
  for (const j of chosenJourneys(p)) {
    const g = j.card;
    nodes.push({ id: `gauge:${g.id}`, kind: 'gauge', lane: 'instruments', label: g.goal, gauge: g, suggestion: j.from, sub: j.from ? `added journey: ${j.from.kind}` : 'your own journey', open: [], file: `gauges/${g.id}.yaml` });
    const to = (j.from?.balloons ?? []).map((b) => `b${b}`).filter((id) => nodes.some((n) => n.id === id));
    for (const t of to.length ? to : outcomes.slice(0, 1).map(sid)) edges.push({ from: `gauge:${g.id}`, to: t, rel: 'checks' });
  }
  const allGauges = [...gs, ...chosenJourneys(p).map((j) => j.card)];
  const nevers = st.filter(isNever);
  for (const n of nevers) {
    const id = `forbid:${n.balloon}`;
    nodes.push({ id, kind: 'forbidden', lane: 'instruments', label: n.text.replace(/^never:?\s*/i, 'Never: '), sub: 'forbidden outcome, checked on every journey', open: [], file: allGauges[0] ? `gauges/${allGauges[0].id}.yaml` : 'gauges/' });
    edges.push({ from: id, to: sid(n), rel: 'forbids' });
  }
  for (const w of workingRanges(st)) {
    const r = w.range;
    if (r.kind === 'time' || r.kind === 'rate' || r.kind === 'count') {
      const floor = r.kind === 'time' ? `at most ${r.maxMs} ms` : r.kind === 'rate' ? `at least ${Math.round(r.min * 1000) / 10}% of runs` : `at most ${r.max}`;
      nodes.push({ id: `ratchet:${w.balloon}`, kind: 'ratchet', lane: 'instruments', label: `${w.measure}: ${floor}`, sub: `ratchet, starts ${w.confidence}`, open: [], file: 'ratchets.json', range: r });
      edges.push({ from: `ratchet:${w.balloon}`, to: `b${w.balloon}`, rel: 'floors' });
    }
  }
  for (const s of st.filter((x) => x.slot === 'measures' && x.tolerance === 'exactly as stated')) {
    nodes.push({ id: `scenario:${s.balloon}`, kind: 'scenario', lane: 'instruments', label: s.text, sub: 'scenario test, pending until built', open: [], file: 'tests/scenarios.test.ts' });
    edges.push({ from: `scenario:${s.balloon}`, to: sid(s), rel: 'proves' });
  }
  for (const s of st.filter((x) => x.mark)) {
    nodes.push({ id: `control:${s.balloon}`, kind: 'control', lane: 'instruments', label: `${s.mark === 'critical' ? 'Critical' : 'Significant'}: ${s.text}`, sub: s.mark === 'critical' ? 'control: gate, gauge, red team, monitor' : 'control: gauge', open: [], file: 'control-plan.yaml' });
    edges.push({ from: `control:${s.balloon}`, to: sid(s), rel: 'controls' });
  }
  return { nodes, edges };
}

/** What the inspection plan counts: each kind of instrument, where it lives, and what it covers. */
export interface Instrument {
  readonly kind: Exclude<Kind, 'end' | 'statement' | 'question'>;
  readonly label: string;
  readonly file: string;
  readonly what: string;
  readonly count: number;
}

export function instruments(g: Graph): Instrument[] {
  const n = (k: Kind) => g.nodes.filter((x) => x.kind === k).length;
  return [
    { kind: 'gauge', label: 'Journey gauges', file: 'gauges/*.yaml, tests/journeys/*.ts', what: 'Walk each outcome as the person would, inside an action and time budget. The factory reports a gauge with no build as unknown, never passed.', count: n('gauge') },
    { kind: 'forbidden', label: 'Forbidden outcomes', file: 'gauges/*.yaml (forbidden)', what: 'Checked on every journey: if any happens, the journey fails, whatever else went right.', count: n('forbidden') },
    { kind: 'ratchet', label: 'Ratchets', file: 'ratchets.json', what: 'One per measure with a readable tolerance. The floor starts at the tolerance and only ever tightens.', count: n('ratchet') },
    { kind: 'scenario', label: 'Scenario tests', file: 'tests/scenarios.test.ts', what: 'Each confirmed given-when-then, pending until the factory builds and proves it.', count: n('scenario') },
    { kind: 'control', label: 'Controls on marked characteristics', file: 'control-plan.yaml', what: 'Every critical or significant statement must reach a control before it ships.', count: n('control') },
  ];
}

/** What is not yet covered: the gaps an inspector would write up. */
export function uncovered(g: Graph): { node: Node; why: string }[] {
  const into = (id: string, rel: Relation) => g.edges.some((e) => e.to === id && e.rel === rel);
  const out: { node: Node; why: string }[] = [];
  for (const x of g.nodes) {
    const s = x.statement;
    if (!s) continue;
    if (s.slot === 'outcome' && !into(x.id, 'checks')) out.push({ node: x, why: 'no gauge walks this outcome' });
    if (s.slot === 'measures' && !into(x.id, 'floors') && !into(x.id, 'proves')) out.push({ node: x, why: x.range?.kind === 'unread' ? x.range.why : 'nothing measures it yet' });
    if (s.mark && !into(x.id, 'controls')) out.push({ node: x, why: 'marked, with no control' });
  }
  if (!g.nodes.some((x) => x.statement?.slot === 'outcome')) out.push({ node: g.nodes[0]!, why: 'no outcome is stated, so there is nothing for a gauge to walk' });
  return out;
}

/** Everything one node touches, both ways: for the drawer and for highlighting. */
export function neighbours(g: Graph, id: string): { node: Node; rel: Relation; dir: 'to' | 'from' }[] {
  const by = new Map(g.nodes.map((n) => [n.id, n]));
  return [
    ...g.edges.filter((e) => e.from === id).map((e) => ({ node: by.get(e.to)!, rel: e.rel, dir: 'to' as const })),
    ...g.edges.filter((e) => e.to === id).map((e) => ({ node: by.get(e.from)!, rel: e.rel, dir: 'from' as const })),
  ].filter((x) => x.node);
}
