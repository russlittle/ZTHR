/**
 * The plant: one model of the whole factory, from which every surface is drawn: the plant view, the area bar,
 * the docs and the evidence panels. Work flows office → engineering → the line → the field. Support crews each serve
 * a part of the plant rather than standing in the flow. Defects flow back for rework; the field reports back to the
 * office; updates go out to the field over the air.
 */


export type Group = 'office' | 'engineering' | 'line' | 'field' | 'support';
export type Who = 'person' | 'agent' | 'crew' | 'person and agent';
export type AreaKey = 'mission' | 'lines' | 'intent' | 'design' | 'process' | 'factory' | 'qa' | 'rework' | 'shipping' | 'fleet' | 'maintenance' | 'metrology' | 'deploy';
/** The station an area reports on in a product's flow: the lamp it shows in the bar and on mission control. */
export type Station = 'intent' | 'design' | 'process' | 'build' | 'qa' | 'rework' | 'release' | 'fleet';

export interface Area {
  readonly key: AreaKey;
  readonly label: string;
  readonly group: Group;
  /** The area this one sits inside, when it is part of a larger one. */
  readonly inside?: AreaKey;
  /** Support crews: the areas they keep working. */
  readonly serves?: readonly AreaKey[];
  /** What the crew does for the areas it serves, as a phrase that follows the name. */
  readonly serving?: string;
  /** The manufacturing discipline it is, and the standard that discipline works to. */
  readonly discipline: string;
  readonly standard: string;
  /** Who does the work. */
  readonly who: Who;
  /** What it takes in, and from where. */
  readonly takes: string;
  /** What it hands on, and to where. */
  readonly gives: string;
  /** What it does, in a sentence. */
  readonly does: string;
  /** What it must have for the plant to work: each need is checked against the repository, by the check in CHECKS. */
  readonly needs: readonly string[];
  /** The console page that shows its evidence, which is also the key of its doc under /line. */
  readonly page: string;
  /** The station it reports on in a product's flow, when it has one. */
  readonly station?: Station;
}

/** The blocks the design area needs in its library before products can be drawn from it freely. */
export const LIBRARY_TARGET = 300;

export const GROUPS: readonly { readonly key: Group; readonly label: string; readonly does: string }[] = [
  { key: 'office', label: 'Front office', does: 'Runs the plant: sets priorities, gives approvals, stops the line and holds the spend, and holds what waits on a person.' },
  { key: 'engineering', label: 'Engineering', does: 'Defines the product, then defines how to build it.' },
  { key: 'line', label: 'The line', does: 'Builds to the package, inspects, reworks what fails, and ships what passes.' },
  { key: 'field', label: 'The field', does: 'Runs what shipped, takes updates over the air, and reports back.' },
  { key: 'support', label: 'Support', does: 'Crews that keep each part of the plant working and improving.' },
];

export const AREAS: readonly Area[] = [
  { key: 'mission', label: 'Mission control', group: 'office', discipline: 'Plant management and production control', standard: 'ISA-95 level 4', who: 'person and agent', page: 'mission',
    takes: 'Every area’s evidence feed, and reports from the field', gives: 'Priorities, approvals and stop-the-line to every area',
    does: 'Runs the plant: sets priorities, gives approvals, stops the line when it must and holds the spend. It sees every product line and product, where each stands, and what waits on a person.',
    needs: ['A live feed from every area', 'Stop-the-line authority over the plant', 'The queue of decisions waiting on a person', 'A spend budget per crew and per product'] },
  { key: 'lines', label: 'Product lines', group: 'office', inside: 'mission', discipline: 'Product line management', standard: 'APQP planning', who: 'person', page: 'lines',
    takes: 'The plant’s priorities', gives: 'Products to define, each with its family’s defaults',
    does: 'Each product family: who it serves and the defaults every product in it starts from. A family holds many products, each built separately on the line, and each product line has its own Intent studio.',
    needs: ['A registry of families and their products, held centrally', 'Defaults per family', 'A reference system per product to measure against'] },
  { key: 'intent', label: 'Intent studio', group: 'office', inside: 'lines', discipline: 'Voice of the customer', standard: 'Quality function deployment', who: 'person and agent', page: 'intent', station: 'intent',
    takes: 'A person’s own words about what the product must do', gives: 'A signed intent package to product engineering',
    does: 'Defines the thing: rough words become a numbered schematic, the questions that change the build are settled, and the person signs it as what they mean.',
    needs: ['Parsing by two model families, compared field by field', 'Held-out phrasings, sealed', 'The person’s signature on the signed intent package'] },
  { key: 'design', label: 'Product engineering', group: 'engineering', discipline: 'Design engineering', standard: 'Design FMEA and design review', who: 'agent', page: 'engineering', station: 'design',
    takes: 'The signed intent package', gives: 'The product spec to manufacturing engineering',
    does: 'Designs the app and its blocks: outcomes, data, compliance, operations, measures, journeys and tests, drawn from the block library, and hands on the product spec.',
    needs: [`A library of ${LIBRARY_TARGET} or more tested blocks`, 'Journeys locked by hash', 'A spec every later area can check against'] },
  { key: 'process', label: 'Manufacturing engineering', group: 'engineering', serves: ['factory', 'qa', 'shipping'], serving: 'also improves the line: its routing, fixtures and gates', discipline: 'Manufacturing engineering', standard: 'Process FMEA, control plan, APQP', who: 'agent', page: 'process', station: 'process',
    takes: 'The product spec', gives: 'The build package to the line: routing, fixtures, gates and required checks',
    does: 'Defines how to build the thing, then sets up the line to build it, and keeps improving the line and the process from what the line measures.',
    needs: ['A routing for every product', 'Gates proven able to fail', 'Required checks enforced on the branch', 'Process capability measured from the line'] },
  { key: 'factory', label: 'Factory floor', group: 'line', discipline: 'Production', standard: 'Work instructions under a control plan', who: 'agent', page: 'factory', station: 'build',
    takes: 'The build package, driven along the line by its operator agent', gives: 'The built product, with its measurements, to QA',
    does: 'An operator agent drives each product down the line, station by station, building to the build package and measuring what was built.',
    needs: ['An operator agent per line, within its budget', 'The model router: the cheapest model that passes', 'Reproducible builds', 'A published build feed'] },
  { key: 'qa', label: 'QA', group: 'line', discipline: 'Quality control and inspection', standard: 'First article inspection, AS9102', who: 'agent', page: 'qa', station: 'qa',
    takes: 'The built product', gives: 'A pass to shipping, or a fail to rework with the failing evidence',
    does: 'Inspects every product as a person would use it: every journey walked, measured against its reference system, every gate proven able to fail.',
    needs: ['Only certified gauges', 'Journeys walked as a person would', 'A first article against the reference system', 'Review by a second model family'] },
  { key: 'rework', label: 'Rework', group: 'line', discipline: 'Nonconformance and rework', standard: 'ISO 9001 clause 8.7, corrective action', who: 'agent', page: 'rework', station: 'rework',
    takes: 'A failed product with its failing evidence', gives: 'The fixed product back to QA',
    does: 'Takes back what fails inspection. The fix starts from a failing test, and the whole product goes through QA again.',
    needs: ['The failing journey attached to every return', 'A failing test before every fix', 'Re-inspection of the whole product, not only the fix'] },
  { key: 'shipping', label: 'Shipping', group: 'line', discipline: 'Shipping, release and configuration management', standard: 'AS9100 configuration management', who: 'agent', page: 'shipping', station: 'release',
    takes: 'A product that passed QA', gives: 'A signed release in the repository, on the sites, and in production',
    does: 'Packages the code, the tests, the docs and the version history into a signed release, publishes it to the repository and the sites, and deploys it to production with a person approving.',
    needs: ['A release package: code, tests, docs, SBOM, licences', 'A signed version tag', 'Docs built and checked from the source', 'Staged deploys with a person approving production'] },
  { key: 'fleet', label: 'Fleet', group: 'field', discipline: 'Field service and the installed base', standard: 'Service bulletins and field updates', who: 'agent', page: 'fleet', station: 'fleet',
    takes: 'Releases, delivered over the air', gives: 'What the field shows, back to mission control',
    does: 'Everything in service: each app, the blocks it draws on and the data it keeps. Apps are updated over the air, with rollback, and the field reports back to Mission control.',
    needs: ['Updates over the air, with rollback', 'Live walks of every product in service', 'Telemetry back to mission control'] },
  { key: 'maintenance', label: 'Maintenance', group: 'support', serves: ['factory'], serving: 'keeps the factory floor running', discipline: 'Maintenance', standard: 'Total productive maintenance', who: 'crew', page: 'maintenance',
    takes: 'Work orders, from tags anyone raises', gives: 'A factory floor that keeps running and gets better',
    does: 'Keeps the factory floor running. The night shift works the backlog within its budget, through the same gates as day work, and reports each morning.',
    needs: ['A budget per shift', 'Work orders with their acceptance test', 'The same gates as day work'] },
  { key: 'metrology', label: 'Metrology', group: 'support', serves: ['qa'], serving: 'keeps QA’s gauges and process true', discipline: 'Metrology', standard: 'ISO/IEC 17025, AIAG MSA', who: 'crew', page: 'metrology',
    takes: 'Every gauge QA uses', gives: 'Certified gauges, and a better QA process',
    does: 'The lab behind QA: defines every measure, traces it to a reference, certifies every gauge before QA may use it, and fixes QA’s quality and process.',
    needs: ['Planted-defect calibration of every gauge', 'Repeatability and reproducibility measured', 'Every claim audited against its evidence'] },
  { key: 'deploy', label: 'Deployment engineering', group: 'support', serves: ['shipping', 'fleet'], serving: 'keeps shipping and the fleet deploying and updated', discipline: 'Installation and field engineering', standard: 'Commissioning and site acceptance', who: 'crew', page: 'deployment',
    takes: 'Releases from shipping', gives: 'Products running in production, updated over the air',
    does: 'The cloud and field engineers: stand up where products run, deploy them, send updates over the air, watch them in service and bring back what the field shows.',
    needs: ['Environments as code', 'Deploys a person approves', 'Over-the-air updates with rollback', 'Monitoring of everything in service'] },
];

export type FlowKind = 'work' | 'rework' | 'report' | 'air';
export const FLOWS: readonly { readonly from: AreaKey; readonly to: AreaKey; readonly kind: FlowKind; readonly carries: string }[] = [
  { from: 'intent', to: 'design', kind: 'work', carries: 'Signed intent package' },
  { from: 'design', to: 'process', kind: 'work', carries: 'Product spec' },
  { from: 'process', to: 'factory', kind: 'work', carries: 'Build package' },
  { from: 'factory', to: 'qa', kind: 'work', carries: 'Built product' },
  { from: 'qa', to: 'rework', kind: 'rework', carries: 'Failed product and its evidence' },
  { from: 'rework', to: 'qa', kind: 'work', carries: 'Fixed product' },
  { from: 'qa', to: 'shipping', kind: 'work', carries: 'Passed product' },
  { from: 'shipping', to: 'fleet', kind: 'air', carries: 'Signed release, over the air' },
  { from: 'fleet', to: 'mission', kind: 'report', carries: 'What the field shows' },
];

export const area = (k: string): Area => {
  const a = AREAS.find((x) => x.key === k);
  if (!a) throw new Error(`no area ${k}`);
  return a;
};

// ---------------------------------------------------------------- what the surfaces derive from the model

/** The areas work moves through, in order, from the Intent studio to the fleet. */
export const WORK_PATH: readonly AreaKey[] = (() => {
  const path: AreaKey[] = ['intent'];
  for (let k: AreaKey = 'intent'; k !== 'fleet'; ) {
    const next = FLOWS.find((f) => f.from === k && (f.kind === 'work' || f.kind === 'air'));
    if (!next || path.includes(next.to)) break;
    k = next.to;
    path.push(k);
  }
  return path;
})();

/** An area's step in the bar: only areas outside the front office that work passes through are numbered. */
export const stepOf = (k: AreaKey): number | null => {
  const steps = WORK_PATH.filter((x) => area(x).group !== 'office');
  const i = steps.indexOf(k);
  return i < 0 ? null : i + 1;
};

/** How deep an area sits inside others: Mission control 0, Product lines 1, the Intent studio 2. */
export const depthOf = (k: AreaKey): number => {
  const a = area(k);
  return a.inside ? 1 + depthOf(a.inside) : 0;
};

/** The support crews that serve an area. */
export const crewsFor = (k: AreaKey): readonly Area[] => AREAS.filter((a) => a.group === 'support' && a.serves?.includes(k));

/** The area that takes this one's work next, along the flow that carries work or an update; the loops and reports are not next steps. */
export const nextOf = (k: AreaKey): Area | null => {
  const f = FLOWS.find((x) => x.from === k && (x.kind === 'work' || x.kind === 'air'));
  return f ? area(f.to) : null;
};

export const areasIn = (g: Group): readonly Area[] => AREAS.filter((a) => a.group === g);

/** The url of an area's console page, and of its doc. */
export const pageHref = (a: Area): string => `/${a.page}`;
export const docHref = (a: Area): string => `/line/${a.page}/`;

/** One word per idea, everywhere: the docs and the pages use these names and no others. */
export const GLOSSARY: readonly { readonly term: string; readonly means: string; readonly never: readonly string[] }[] = [
  { term: 'area', means: 'One part of the plant, with its own discipline, its own page and its own doc.', never: ['department'] },
  { term: 'station', means: 'The place in a product’s flow where an area reports a lamp, and one of the inspection stations maintenance works.', never: [] },
  { term: 'stage', means: 'One of the eight stages of a delivery, from build to operate.', never: [] },
  { term: 'product line', means: 'A family of products that share defaults. Never "a line" on its own; "the line" is the production line.', never: [] },
  { term: 'signed intent package', means: 'What the Intent studio hands to product engineering once the holder has signed.', never: ['signed schematic'] },
  { term: 'product spec', means: 'What product engineering hands to manufacturing engineering: the complete specification.', never: [] },
  { term: 'build package', means: 'What manufacturing engineering hands to the factory floor: routing, fixtures, gates and required checks.', never: ['released package'] },
  { term: 'return', means: 'A failed product sent from QA to rework, with its failing evidence. The agent API records one as a case.', never: [] },
  { term: 'tag', means: 'Something wrong noticed anywhere, with its evidence and the test that will prove it fixed.', never: [] },
  { term: 'work order', means: 'A tag accepted for maintenance to work.', never: [] },
  { term: 'release', means: 'The signed package shipping publishes and deploys.', never: [] },
];

// ---------------------------------------------------------------- where each area stands, computed from the repository

export type Lamp = 'go' | 'part' | 'stop' | 'off';
export interface Standing {
  readonly lamp: Lamp;
  /** Where it stands, in a sentence. */
  readonly state: string;
  readonly facts: readonly (readonly [string, string])[];
  /** One entry per need, in order: met or not. */
  readonly met: readonly boolean[];
}

/**
 * What the repository shows, gathered once by tools/plant-facts.ts and handed to the model. Nothing here is typed in
 * by hand: each figure is counted from a file, and a need is met only while the evidence for it exists.
 */
export interface Facts {
  /** The revision the figures were read at, from git; null when the checkout has no history. */
  readonly asOf: { readonly revision: string | null; readonly date: string | null };
  /** Whether a path, from the repository root, exists. */
  readonly has: (path: string) => boolean;
  readonly blocks: { readonly own: number; readonly plant: number; readonly tests: number; readonly calibrated: number; readonly certified: number; readonly medianScore: number | null; readonly survivors: number; readonly repeatabilityMeasured: boolean };
  readonly top50: { readonly covered: number; readonly partly: number; readonly total: number };
  readonly queue: { readonly workOrders: number; readonly done: number };
  readonly shifts: number;
  readonly gates: number;
  readonly requiredChecks: number;
  readonly deliveryStages: number;
  readonly reviewFamilies: number;
  readonly personOnly: number;
  readonly lineChoices: number;
  readonly claims: { readonly claims: number; readonly proven: number; readonly partial: number; readonly unproven: number };
  readonly files: { readonly tests: number; readonly oracleSteps: number; readonly reference: string | null };
  /** Products in service, read from the records the over-the-air step writes under intent/factory/fleet; none until it does. */
  readonly inService: number;
  /** Releases the line has published, read from intent/factory/releases. */
  readonly releases: number;
  readonly signedTags: number;
}

type Check = (f: Facts) => boolean;
/** One check per need, in the order the area lists them. Each reads the evidence the need would leave behind. */
export const CHECKS: Readonly<Record<AreaKey, readonly Check[]>> = {
  mission: [(f) => f.has('docs/reference/factory/factory.json'), (f) => f.has('intent/tools/stop-line.ts') && f.has('intent/src/governance/stopline.ts'), (f) => f.personOnly > 0 && f.has('intent/src/console/mission.ts'), (f) => f.has('intent/factory/budgets.json')],
  lines: [(f) => f.has('intent/factory/lines.json'), (f) => f.lineChoices > 0, (f) => f.files.reference !== null],
  intent: [(f) => f.has('intent/test/fixtures/reading-a.json') && f.has('intent/test/fixtures/reading-b.json'), (f) => f.has('intent/eval/heldout.json'), (f) => f.has('intent/src/release.ts')],
  design: [(f) => f.blocks.own >= LIBRARY_TARGET, (f) => f.has('intent/src/journeys.ts'), (f) => f.has('intent/src/manifest.ts')],
  process: [(f) => f.deliveryStages > 0, (f) => f.gates > 0 && f.has('intent/tools/gates.ts'), (f) => f.has('control/live-rules.json'), (f) => f.has('intent/factory/capability.json')],
  factory: [(f) => f.has('intent/factory/operators.json'), (f) => f.has('intent/src/agents/cost.ts'), (f) => f.has('intent/tools/same-bytes.ts'), (f) => f.has('docs/reference/factory/factory.json')],
  qa: [(f) => f.blocks.certified > 0 && f.blocks.certified === f.blocks.own, (f) => f.has('tools/livewalk.mjs'), (f) => f.files.oracleSteps > 0, (f) => f.reviewFamilies >= 2],
  rework: [(f) => f.has('intent/src/agents/correct.ts'), (f) => f.has('tools/mutation'), (f) => f.has('intent/factory/returns.json')],
  shipping: [(f) => f.has('tools/supply'), (f) => f.signedTags > 0, (f) => f.has('intent/tools/docs.ts'), (f) => f.releases > 0],
  fleet: [(f) => f.has('intent/factory/fleet/ota.json'), (f) => f.inService > 0 && f.has('.github/workflows/livewalk.yml'), (f) => f.has('intent/factory/fleet/telemetry.json')],
  maintenance: [(f) => f.has('intent/src/agents/cost.ts'), (f) => f.queue.workOrders > 0, (f) => f.has('tools/mutation')],
  metrology: [(f) => f.blocks.calibrated >= f.blocks.own && f.blocks.own > 0, (f) => f.blocks.repeatabilityMeasured, (f) => f.claims.claims > 0],
  deploy: [(f) => f.has('intent/src/delivery.ts'), (f) => f.releases > 0, (f) => f.has('intent/factory/fleet/ota.json'), (f) => f.has('.github/workflows/livewalk.yml') && f.has('.github/workflows/security-scan.yml')],
};

const n = (x: number) => x.toLocaleString('en-US');
const pct = (x: number | null) => (x === null ? 'not measured' : `${x.toFixed(1)}%`);
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** What each area says about itself, from the facts and from how many of its needs are met. */
const SAY: Readonly<Record<AreaKey, (f: Facts, met: readonly boolean[]) => { state: string; facts: readonly (readonly [string, string])[]; lamp?: Lamp }>> = {
  mission: (f) => ({
    state: f.has('docs/reference/factory/factory.json') ? 'The office reads every area’s feed.' : 'The office is open, but results reach it only from a published build feed, and none is published yet.',
    facts: [['Stop-the-line', f.has('intent/tools/stop-line.ts') ? 'Built: tools/stop-line.ts' : 'Not built'], ['Acts only a person may do', String(f.personOnly)], ['Spend budget per crew and product', f.has('intent/factory/budgets.json') ? 'Recorded' : 'Not recorded']],
  }),
  lines: (f) => ({
    state: f.files.reference ? `One family runs: file services, with one product, Files, measured against ${f.files.reference}.` : 'No family has a reference system to measure against.',
    facts: [['Defaults a family sets', String(f.lineChoices)], ['Registry', f.has('intent/factory/lines.json') ? 'Held centrally' : 'Kept in each browser; none held centrally'], ['Reference system', f.files.reference ?? 'None']],
  }),
  intent: (f) => ({
    state: 'Works end to end in the browser, from rough words to a signed intent package.',
    facts: [['Steps', 'Rough intent, read, questions, review, signed, released'], ['Held-out phrasings', f.has('intent/eval/heldout.json') ? 'Sealed' : 'None sealed yet']],
  }),
  design: (f) => ({
    state: `Designs from a library of ${n(f.blocks.own)} tested blocks; the plan calls for ${n(LIBRARY_TARGET)} or more.`,
    facts: [['Blocks built', `${n(f.blocks.own)}, plus ${n(f.blocks.plant)} that run the plant`], ['Block tests', `${n(f.blocks.tests)} written`], ['Top 50 app needs', `${f.top50.covered} of ${f.top50.total} covered, ${f.top50.partly} partly`]],
  }),
  process: (f) => ({
    state: `The routing has ${f.deliveryStages} stages and ${f.requiredChecks} required checks run on every change; branch rules are not recorded here and process capability is not yet measured.`,
    facts: [['Routing stages defined', String(f.deliveryStages)], ['Gates proven able to fail', String(f.gates)], ['Required checks', String(f.requiredChecks)], ['Branch rules recorded', f.has('control/live-rules.json') ? 'Yes' : 'No: control holds proposals'], ['Process capability', f.has('intent/factory/capability.json') ? 'Recorded' : 'Not measured']],
  }),
  factory: (f) => ({
    state: `Files is built, with ${plural(f.files.tests, 'test')} of its own, and builds are checked for byte-for-byte reproduction. No operator agent is recorded and no build feed is published.`,
    facts: [['Files tests', n(f.files.tests)], ['Reproducible builds', f.has('intent/tools/same-bytes.ts') ? 'Checked by tools/same-bytes.ts' : 'Not checked'], ['Model router', f.has('intent/src/agents/cost.ts') ? 'Built and tested; not yet driving a line' : 'Not built'], ['Build feed', f.has('docs/reference/factory/factory.json') ? 'Published' : 'Not published']],
  }),
  qa: (f) => ({
    state: `Files has a recorded reference to be inspected against (${f.files.reference ?? 'none'}, ${plural(f.files.oracleSteps, 'scripted step')}); ${n(f.blocks.certified)} of ${n(f.blocks.own)} gauges are certified, so QA cannot yet certify a product.`,
    facts: [['Gauges certified', `${n(f.blocks.certified)} of ${n(f.blocks.own)}`], ['First article reference', f.files.reference ?? 'None'], ['Review families', String(f.reviewFamilies)]],
  }),
  rework: (f) => ({
    state: f.has('intent/factory/returns.json') ? 'Returns are recorded.' : 'No return is recorded in the repository: the first article runs in CI, and its failures are read from there.',
    facts: [['Returns recorded', f.has('intent/factory/returns.json') ? 'See the record' : 'None'], ['Fix test-first gate', f.has('tools/mutation') ? 'Built for mutation work orders' : 'Not built']],
  }),
  shipping: (f) => ({
    state: f.releases ? `${plural(f.releases, 'release')} published by the line.` : 'Ships the plant’s own site: zthr.ai is packaged, checked and deployed from main. No product of the line has shipped.',
    facts: [['Products shipped', String(f.releases)], ['Signed version tags', String(f.signedTags)], ['Packaging checks', f.has('tools/supply') ? 'SBOM and licence check in tools/supply' : 'None']],
  }),
  fleet: (f) => ({
    state: f.inService ? `${plural(f.inService, 'product')} in service.` : 'Nothing from the line is in service yet.',
    facts: [['In service', String(f.inService)], ['Over-the-air updates', f.has('intent/factory/fleet/ota.json') ? 'Recorded' : 'None recorded']],
    ...(f.inService ? {} : { lamp: 'off' as Lamp }),
  }),
  maintenance: (f) => ({
    state: f.shifts ? `${plural(f.shifts, 'shift')} logged; ${plural(f.queue.workOrders, 'work order')} waiting.` : `No shift has run yet; ${plural(f.queue.workOrders, 'work order')} wait for the night shift.`,
    facts: [['Work orders waiting', n(f.queue.workOrders)], ['Work orders accepted', n(f.queue.done)], ['Shifts logged', n(f.shifts)], ['Crew', f.has('intent/factory/runner.json') ? 'Runner live' : 'Runs as sub-agents until the Vertex crew is live']],
  }),
  metrology: (f) => ({
    state: `${n(f.blocks.calibrated)} of ${n(f.blocks.own)} blocks are calibrated by planting defects in them; ${n(f.blocks.certified)} are certified, because certification needs every planted defect caught.`,
    facts: [['Gauges certified', `${n(f.blocks.certified)} of ${n(f.blocks.own)}`], ['Median mutation score', pct(f.blocks.medianScore)], ['Surviving planted defects', n(f.blocks.survivors)], ['Claims audited', `${f.claims.proven} proven, ${f.claims.partial} partial, ${f.claims.unproven} unproven`]],
    ...(f.blocks.certified === 0 && f.blocks.survivors > 0 ? { lamp: 'stop' as Lamp } : {}),
  }),
  deploy: (f) => ({
    state: 'Runs the live site: zthr.ai deploys from main and is walked and security-scanned on a schedule. No product of the line is deployed.',
    facts: [['Products deployed', String(f.releases)], ['Live-walk workflow', f.has('.github/workflows/livewalk.yml') ? 'Present' : 'None'], ['Delivery stages defined', String(f.deliveryStages)]],
  }),
};

/** Where every area stands, from the facts. The lamp follows the needs met, unless the area says a defect holds it. */
export function standingOf(f: Facts): Readonly<Record<AreaKey, Standing>> {
  const out = {} as Record<AreaKey, Standing>;
  for (const a of AREAS) {
    const met = CHECKS[a.key].map((c) => c(f));
    const say = SAY[a.key](f, met);
    const lamp: Lamp = say.lamp ?? (met.every(Boolean) ? 'go' : met.some(Boolean) ? 'part' : 'off');
    out[a.key] = { lamp, state: say.state, facts: say.facts, met };
  }
  return out;
}
