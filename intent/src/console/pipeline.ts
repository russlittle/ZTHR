/**
 * The platform as one system: intent in, software out. Every intent moves through the same five stages the factory
 * runs (intent, design, build, QA, release), and each stage reports only what was measured for it: the factory's own
 * feed for what it built, the studio's schematic and build manifest for what is still on the desk. Nothing is inferred
 * across stages; a stage with nothing measured says so.
 */
import { schemaOf } from '../schema.ts';
import { CLASSES, inventory, scopeOf } from '../compliance.ts';
import { blocksIn, manifest } from '../manifest.ts';
import topData from '../../catalog/top50.json' with { type: 'json' };
import delightData from '../../catalog/delight.json' with { type: 'json' };
import adminData from '../../catalog/admin.json' with { type: 'json' };
import intentData from '../../catalog/intent.json' with { type: 'json' };
import { prepare, type Given } from '../pipeline.ts';
import type { OwnJourney } from '../journeys.ts';
import { gauges } from '../release.ts';
import { statusOf, type Feed, type Status } from './feed.ts';
import catalogData from '../../catalog/catalog.json' with { type: 'json' };
import groupsData from '../../catalog/groups.json' with { type: 'json' };
import baselineData from '../../catalog/baseline.json' with { type: 'json' };

export type StageKey = 'intent' | 'design' | 'build' | 'qa' | 'release';
export type Light = Status | 'waiting';

export const STAGES: readonly { key: StageKey; label: string; asks: string }[] = [
  { key: 'intent', label: 'Intent studio', asks: 'What people mean, signed as the datum' },
  { key: 'design', label: 'Engineering', asks: 'The complete specification: outcomes, data, compliance, measures and tests, and the build manifest' },
  { key: 'build', label: 'Factory', asks: 'What the factory has made, feature by feature' },
  { key: 'qa', label: 'QA', asks: 'Journeys walked, gates proven, attacks held' },
  { key: 'release', label: 'Shipping', asks: 'Phases certified and shipped to the fleet' },
];

export interface Reading {
  readonly label: string;
  readonly value: number | null;
  readonly of: number | null;
  readonly light: Light;
  readonly href?: string;
  readonly note?: string;
}

export interface Stage {
  readonly key: StageKey;
  readonly light: Light;
  /** The one line that says where it stands. */
  readonly headline: string;
  readonly readings: readonly Reading[];
}

export interface Item {
  readonly id: string;
  readonly kind: 'journey' | 'line';
  readonly label: string;
  readonly persona?: string;
  readonly phase: number | null;
  readonly status: Status;
  /** Where this one item stands at each stage. */
  readonly trail: Record<StageKey, { light: Light; text: string }>;
}

/** One intended use of a standard assembly: which product and intent use it, for what. */
export interface Use {
  readonly assembly: string;
  readonly product: string;
  readonly intent: string;
  readonly use: string;
}

/** What one pass of the factory turns an intent into, all together. */
export type OutputKey = 'spec' | 'code' | 'tests' | 'evidence' | 'docs' | 'validated';
export const OUTPUTS: readonly { key: OutputKey; label: string }[] = [
  { key: 'spec', label: 'Schematic' },
  { key: 'code', label: 'Code' },
  { key: 'tests', label: 'Tests' },
  { key: 'evidence', label: 'Evidence' },
  { key: 'docs', label: 'Docs and training' },
  { key: 'validated', label: 'Validated' },
];

export interface Flow {
  readonly id: string;
  /** The product, or part family, this intent belongs to. */
  readonly product: string;
  /** Who holds the intent, when it is recorded. */
  readonly holder: string | null;
  /** The people who will use it. */
  readonly people: readonly string[];
  readonly uses: readonly Use[];
  readonly outputs: Record<OutputKey, { light: Light; text: string }>;
  readonly title: string;
  readonly end: string | null;
  readonly source: 'factory' | 'studio';
  readonly where: string;
  readonly stages: readonly Stage[];
  readonly items: readonly Item[];
  /** The measure: journeys walked and passing. */
  readonly measure: { pass: number; fail: number; unmeasured: number; total: number };
  /** Its sensitive data, as every app reports it: fields by class, and the frameworks in scope. Null until reported. */
  readonly sensitive?: { readonly classes: Readonly<Record<string, number>>; readonly frameworks: readonly string[]; readonly suggested: readonly string[] } | null;
}

const lightOf = (value: number | null, of: number | null): Light => (value === null || of === null ? 'not measured' : of > 0 && value >= of ? 'pass' : value === 0 && of === 0 ? 'waiting' : 'fail');
const worst = (ls: Light[]): Light => (ls.includes('fail') ? 'fail' : ls.includes('not measured') ? 'not measured' : ls.includes('waiting') ? 'waiting' : 'pass');

interface CatEntry {
  name: string;
  studentAdvocate?: { coverage: string; from?: string };
}

export function factoryFlow(f: Feed): Flow {
  const features = f.phases.flatMap((p) => p.features.map((x) => ({ ...x, phase: p.n })));
  const built = features.filter((x) => x.status === 'built').length;
  const certified = f.phases.filter((p) => p.certified === true).length;
  const anyCert = f.phases.some((p) => p.certified !== null);
  const j = f.journeys.map((x) => ({ ...x, s: statusOf(x.status) }));
  const pass = j.filter((x) => x.s === 'pass').length;
  const fail = j.filter((x) => x.s === 'fail').length;
  const reading = (id: string) => f.readings.find((r) => r.id === id);
  const r = (id: string, label: string): Reading => {
    const x = reading(id);
    if (!x) return { label, value: null, of: null, light: 'not measured' };
    const held = x.value !== null && (x.floor != null ? x.value >= x.floor : x.of !== null && x.value >= x.of);
    return { label, value: x.value, of: x.of, light: x.value === null ? 'not measured' : held ? 'pass' : 'fail', href: `/reference/factory/${x.href}`, ...(x.unit ? { note: x.unit } : {}) };
  };
  const qa: Reading[] = [
    { label: 'Journeys walked and passing', value: j.some((x) => x.s !== 'not measured') ? pass : null, of: j.length, light: fail ? 'fail' : pass === j.length && j.length ? 'pass' : 'not measured', href: '/reference/factory/intent.html' },
    r('gates', 'Gates proven able to fail'),
    r('tests', 'Tests passing'),
    r('redteam', 'Red-team attacks held'),
    r('mutation', 'Mutation score against its floor'),
    r('browser', 'Browser stops with no problems'),
  ];
  const featureOf = (id: string) => features.find((x) => x.journeys.includes(id));
  const parts = [
    ...(topData as { blocks: CatEntry[] }).blocks,
    ...(delightData as { delighters: CatEntry[] }).delighters,
    ...(adminData as { blocks: CatEntry[] }).blocks,
    ...(intentData as { parts: CatEntry[] }).parts,
  ];
  const uses: Use[] = parts.flatMap((x) => (x.studentAdvocate && x.studentAdvocate.coverage !== 'none' ? blocksIn(x.studentAdvocate.from ?? null).map((b) => ({ assembly: b, product: f.app.name, intent: f.app.name, use: x.name })) : []));
  const cert = f.phases.every((p) => p.certified === true) ? 'pass' : f.phases.some((p) => p.certified === false) ? 'fail' : 'not measured';
  return {
    id: 'factory',
    product: f.app.name,
    holder: null,
    people: [...new Set(f.journeys.map((x) => x.persona))],
    uses,
    outputs: {
      spec: { light: 'pass', text: `${j.length} journeys locked` },
      code: { light: lightOf(built, features.length), text: `${built} of ${features.length} features built` },
      tests: { light: qa[2]!.light, text: qa[2]!.value === null ? 'Tests not measured in this build' : `${qa[2]!.value} of ${qa[2]!.of} tests pass` },
      evidence: { light: qa[1]!.light, text: qa[1]!.value === null ? 'Gate proofs not measured' : `${qa[1]!.value} of ${qa[1]!.of} gates proven able to fail` },
      docs: { light: 'not measured', text: 'Not reported in the feed yet' },
      validated: { light: (cert === 'pass' && pass === j.length ? 'pass' : fail ? 'fail' : 'not measured') as Light, text: pass === j.length && j.length ? 'Every journey passes' : `${pass} of ${j.length} journeys pass` },
    },
    title: f.app.name,
    end: null,
    source: 'factory',
    where: f.app.href,
    measure: { pass, fail, unmeasured: j.length - pass - fail, total: j.length },
    stages: [
      { key: 'intent', light: 'pass', headline: `${j.length} journeys locked in ${f.phases.length} phases`, readings: [{ label: 'Journeys locked by a person', value: j.length, of: j.length, light: 'pass', href: '/reference/factory/intent.html' }, { label: 'Phases', value: f.phases.length, of: f.phases.length, light: 'pass' }] },
      { key: 'design', light: 'pass', headline: `${features.length} features, each proved by named journeys`, readings: [{ label: 'Features designed', value: features.length, of: features.length, light: 'pass', href: '/reference/factory/features.html' }, { label: 'Features with at least one journey', value: features.filter((x) => x.journeys.length).length, of: features.length, light: lightOf(features.filter((x) => x.journeys.length).length, features.length) }] },
      { key: 'build', light: lightOf(built, features.length), headline: `${built} of ${features.length} features built`, readings: [{ label: 'Features built', value: built, of: features.length, light: lightOf(built, features.length), href: '/reference/factory/features.html' }] },
      { key: 'qa', light: worst(qa.map((x) => x.light)), headline: qa[0]!.value === null ? 'Journeys not measured in this build' : `${pass} of ${j.length} journeys pass`, readings: qa },
      { key: 'release', light: anyCert ? lightOf(certified, f.phases.length) : 'not measured', headline: anyCert ? `${certified} of ${f.phases.length} phases certified` : 'No certificates in this build', readings: [{ label: 'Phases certified', value: anyCert ? certified : null, of: f.phases.length, light: anyCert ? lightOf(certified, f.phases.length) : 'not measured', href: '/reference/factory/index.html' }, { label: 'Build', value: null, of: null, light: 'pass', note: f.commit.slice(0, 7) }] },
    ],
    items: j.map((x) => {
      const feat = featureOf(x.id);
      const cert = f.phases.find((p) => p.n === x.phase)?.certified ?? null;
      return {
        id: x.id,
        kind: 'journey' as const,
        label: x.goal,
        persona: x.persona,
        phase: x.phase,
        status: x.s,
        trail: {
          intent: { light: 'pass' as Light, text: `Locked: ${x.goal}` },
          design: feat ? { light: 'pass' as Light, text: `Proves the feature "${feat.name}"` } : { light: 'waiting' as Light, text: 'Not yet tied to a feature' },
          build: feat ? { light: (feat.status === 'built' ? 'pass' : 'waiting') as Light, text: `Feature ${feat.status}` } : { light: 'waiting' as Light, text: 'Nothing to build yet' },
          qa: { light: x.s as Light, text: x.s === 'pass' ? 'Walked and passing' : x.s === 'fail' ? 'Walked and failing' : 'Not walked in this build' },
          release: { light: (cert === true ? 'pass' : cert === false ? 'fail' : 'not measured') as Light, text: cert === true ? `Phase ${x.phase} certified` : cert === false ? `Phase ${x.phase} not certified` : `Phase ${x.phase}: no certificate in this build` },
        },
      };
    }),
  };
}

/** The factory's product, intent by intent: each phase is one intent of the product, with its own journeys. */
export function factoryFlows(f: Feed): Flow[] {
  return f.phases.map((ph) => {
    const sub: Feed = { ...f, journeys: f.journeys.filter((x) => x.phase === ph.n), phases: [ph] };
    const fl = factoryFlow(sub);
    return { ...fl, id: `phase-${ph.n}`, title: `Phase ${ph.n}: ${ph.name}`, uses: fl.uses.map((u) => ({ ...u, intent: `Phase ${ph.n}: ${ph.name}` })) };
  });
}

interface Saved {
  path?: string;
  words?: string;
  readings?: unknown[];
  answers?: Record<string, Given>;
  journeys?: { accepted: string[]; own: OwnJourney[] };
  releases?: { revision: number; ready: boolean; reason: string | null }[];
  signed?: { by?: string } | null;
  holder?: { name: string; role: string };
  product?: string;
  tune?: Record<string, Record<string, string>>;
  options?: Record<string, unknown>;
  provided?: { path: string; text: string } | null;
}

/** The studio's saved work, prepared exactly as the studio prepares it. Null when there is nothing written yet. */
export function preparedFrom(raw: string | null): { s: Saved; p: ReturnType<typeof prepare> } | null {
  if (!raw) return null;
  let s: Saved;
  try {
    s = JSON.parse(raw) as Saved;
  } catch {
    return null;
  }
  if (!s.words?.trim()) return null;
  const p = prepare({ files: [{ path: s.path ?? 'intent.md', text: s.words }, ...(s.provided ? [s.provided] : [])], readings: s.readings ?? [], answers: s.answers ?? {}, ...(s.journeys ? { journeys: s.journeys } : {}), ...(s.options ? { options: s.options as never } : {}), people: { ...(s.holder?.name ? { holder: s.holder } : {}), tune: (s.tune ?? {}) as never } });
  return { s, p };
}

export function studioFlow(raw: string | null, f: Feed | null): Flow | null {
  const got = preparedFrom(raw);
  if (!got) return null;
  const { s, p } = got;
  const info = schemaOf(p);
  const sc = scopeOf(p, info);
  const inv = inventory(p, info, sc);
  const sensitive = { classes: Object.fromEntries(CLASSES.map((c) => [c, inv.filter((i) => i.class === c).length])), frameworks: sc.inScope.map((x) => x.id), suggested: sc.suggested.map((x) => x.id) };
  const m = manifest(p);
  const gs = gauges(p);
  const built = new Map((f?.journeys ?? []).map((x) => [x.id, statusOf(x.status)]));
  const last = s.releases?.at(-1);
  const released = !!last?.ready;
  const q = p.questions.length;
  const statusFor = (id: string): Status => built.get(id) ?? 'not measured';
  const pass = gs.filter((g) => statusFor(g.id) === 'pass').length;
  const fail = gs.filter((g) => statusFor(g.id) === 'fail').length;
  const custom = m.lines.filter((l) => l.source === 'make: new');
  const toMake = m.counts['make: catalogued'];
  const title = p.model.title && p.model.title !== s.path ? p.model.title : 'Your intent';
  const product = s.product?.trim() || title;
  return {
    id: 'studio',
    sensitive,
    product,
    holder: s.holder?.name || null,
    people: p.statements.filter((x) => x.slot === 'people').map((x) => x.text.replace(/\s*\(.*\)$/, '')),
    uses: m.lines.flatMap((l) => l.library.map((b) => ({ assembly: b.name, product, intent: title, use: `${l.part}: ${l.why[0]?.text ?? ''}` }))),
    outputs: {
      spec: { light: released ? 'pass' : 'waiting', text: released ? `Revision ${last!.revision} released` : 'Not released yet' },
      code: { light: 'waiting', text: `${custom.length} custom assemblies to write; ${m.lines.length - custom.length} lines from the library or catalogue` },
      tests: { light: released ? 'waiting' : 'waiting', text: `${gs.length} journey test${gs.length === 1 ? '' : 's'}, with scenario, gate and ratchet checks, in the package and pending` },
      evidence: { light: 'waiting', text: 'Recorded by the factory as it builds' },
      docs: { light: released ? 'pass' : 'waiting', text: released ? 'Knowledge bundle in the package; the factory adds the rest' : 'Generated with the package' },
      validated: { light: pass + fail ? (fail ? 'fail' : pass === gs.length ? 'pass' : 'not measured') : 'waiting', text: pass + fail ? `${pass} of ${gs.length} journeys pass` : 'Validated only when every journey passes' },
    },
    title,
    end: p.model.end,
    source: 'studio',
    where: '/intent',
    measure: { pass, fail, unmeasured: gs.length - pass - fail, total: gs.length },
    stages: [
      { key: 'intent', light: released ? 'pass' : q ? 'fail' : 'waiting', headline: released ? `Revision ${last!.revision} released` : q ? `${q} redline${q === 1 ? '' : 's'} open` : 'Ready to sign and release', readings: [{ label: 'Statements on the schematic', value: p.statements.length, of: p.statements.length, light: 'pass', href: '/intent' }, { label: 'Redlines settled', value: q ? 0 : 1, of: 1, light: q ? 'fail' : 'pass', note: q ? `${q} open` : 'none open' }, { label: 'Journeys that will judge it', value: gs.length, of: gs.length, light: gs.length ? 'pass' : 'fail' }] },
      { key: 'design', light: released ? 'pass' : s.signed && m.gaps.length ? 'fail' : 'waiting', headline: `${m.lines.length} lines: ${m.counts.stock + m.counts.modify} standard assemblies, ${toMake} parts to make, ${custom.length} custom`, readings: [{ label: 'Standard assemblies from the library', value: m.counts.stock + m.counts.modify, of: m.lines.length, light: 'pass' }, { label: 'Catalogued parts the library lacks', value: toMake, of: m.lines.length, light: 'waiting' }, { label: 'Custom assemblies, maintained by your team', value: custom.length, of: m.lines.length, light: 'waiting' }, { label: 'Balloons nothing builds', value: m.gaps.length, of: 0, light: m.gaps.length ? 'fail' : 'pass' }] },
      { key: 'build', light: 'waiting', headline: released ? 'Waiting for the factory to take the package' : 'Waiting for a release', readings: [{ label: 'Custom assemblies built', value: null, of: custom.length, light: 'waiting', note: 'the factory has not reported on this intent' }] },
      { key: 'qa', light: pass + fail ? (fail ? 'fail' : pass === gs.length ? 'pass' : 'not measured') : 'waiting', headline: pass + fail ? `${pass} of ${gs.length} journeys pass` : `${gs.length} journey${gs.length === 1 ? '' : 's'} waiting to be walked`, readings: [{ label: 'Journeys walked and passing', value: pass + fail ? pass : null, of: gs.length, light: pass + fail ? (fail ? 'fail' : 'pass') : 'waiting' }] },
      { key: 'release', light: 'waiting', headline: 'Not built yet', readings: [] },
    ],
    items: gs.map((g) => {
      const st = statusFor(g.id);
      return {
        id: g.id,
        kind: 'journey' as const,
        label: g.goal,
        persona: g.persona,
        phase: g.phase,
        status: st,
        trail: {
          intent: { light: (released ? 'pass' : 'waiting') as Light, text: released ? `In revision ${last!.revision}` : 'On the schematic, not released yet' },
          design: { light: 'pass' as Light, text: 'On the build manifest' },
          build: { light: 'waiting' as Light, text: 'Waiting for the factory' },
          qa: { light: (st === 'not measured' ? 'waiting' : st) as Light, text: st === 'pass' ? 'Walked and passing' : st === 'fail' ? 'Walked and failing' : 'Not walked yet' },
          release: { light: 'waiting' as Light, text: 'Not released by the factory yet' },
        },
      };
    }),
  };
}

/** What every app draws on: the standard assemblies, the parts catalogue and the team minimum, maintained by the fleet. */
export function library() {
  const blocks = (catalogData as { blocks: { name: string; purpose: string; tests: number; mutationFloor?: number }[] }).blocks;
  const groups = (groupsData as { groups: Record<string, string[]> }).groups;
  const parts = Object.values(groups).reduce((a, g) => a + g.length, 0);
  return { assemblies: blocks, parts, groups: Object.keys(groups).length, minimum: (baselineData as { name: string; parts: unknown[] }).parts.length, minimumName: (baselineData as { name: string }).name };
}
