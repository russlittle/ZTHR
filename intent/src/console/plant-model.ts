/**
 * The plant: one model of the whole factory, from which every surface is drawn: the plant view, the department bar,
 * the docs and the evidence panels. Work flows office → engineering → the line → the field. Support crews each serve
 * a part of the plant rather than standing in the flow. Defects flow back for rework; the field reports back to the
 * office; updates go out to the field over the air.
 */

export type Group = 'office' | 'engineering' | 'line' | 'field' | 'support';
export type Who = 'person' | 'agent' | 'crew' | 'person and agent';

export interface Area {
  readonly key: string;
  readonly label: string;
  readonly group: Group;
  /** The area this one sits inside, when it is part of a larger one. */
  readonly inside?: string;
  /** Support crews: the areas they keep working. */
  readonly serves?: readonly string[];
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
  /** What it must have for the plant to work: each need is checked against the repository. */
  readonly needs: readonly string[];
  /** The console page that shows its evidence. */
  readonly page: string;
}

export const GROUPS: readonly { readonly key: Group; readonly label: string; readonly does: string }[] = [
  { key: 'office', label: 'The front office', does: 'Runs the plant: decides what is made, for whom, and holds what waits on a person.' },
  { key: 'engineering', label: 'Engineering', does: 'Defines the product, then defines how to build it.' },
  { key: 'line', label: 'The line', does: 'Builds to the package, inspects, reworks what fails, and ships what passes.' },
  { key: 'field', label: 'The field', does: 'Runs what shipped, takes updates over the air, and reports back.' },
  { key: 'support', label: 'Support', does: 'Crews that keep each part of the plant working and improving.' },
];

export const AREAS: readonly Area[] = [
  { key: 'mission', label: 'Mission control', group: 'office', discipline: 'Plant management and production control', standard: 'ISA-95 level 4', who: 'person and agent', page: 'mission',
    takes: 'Every area’s evidence feed, and reports from the field', gives: 'Priorities, approvals and stop-the-line to every area',
    does: 'Runs the whole plant: sees every product line and product, where each stands, the spend, and what waits on a person.',
    needs: ['A live feed from every area', 'Stop-the-line authority over the plant', 'The queue of decisions waiting on a person', 'A spend budget per crew and per product'] },
  { key: 'lines', label: 'Product lines', group: 'office', inside: 'mission', discipline: 'Product line management', standard: 'APQP planning', who: 'person', page: 'lines',
    takes: 'The plant’s priorities', gives: 'Products to define, each with its family’s defaults',
    does: 'Each product family: who it serves and the defaults every product in it starts from. A family holds many products, each built separately on the line.',
    needs: ['A registry of families and their products, held centrally', 'Defaults per family', 'A reference system per product to measure against'] },
  { key: 'intent', label: 'Intent studio', group: 'office', inside: 'lines', discipline: 'Voice of the customer', standard: 'Quality function deployment', who: 'person and agent', page: 'intent',
    takes: 'A person’s own words about what the product must do', gives: 'A signed intent package to product engineering',
    does: 'Defines the thing: rough words become a numbered schematic, the questions that change the build are settled, and the person signs it as what they mean.',
    needs: ['Parsing by two model families, compared field by field', 'Held-out phrasings, sealed', 'The person’s signature on the released package'] },
  { key: 'design', label: 'Product engineering', group: 'engineering', discipline: 'Design engineering', standard: 'Design FMEA and design review', who: 'agent', page: 'engineering',
    takes: 'The signed intent package', gives: 'The product spec to manufacturing engineering',
    does: 'Designs the app and its blocks: outcomes, data, compliance, operations, measures, journeys and tests, drawn from the block library.',
    needs: ['A library of 300 or more tested blocks', 'Journeys locked by hash', 'A spec every later area can check against'] },
  { key: 'process', label: 'Manufacturing engineering', group: 'engineering', serves: ['factory', 'qa', 'shipping'], discipline: 'Manufacturing engineering', standard: 'Process FMEA, control plan, APQP', who: 'agent', page: 'engineering',
    takes: 'The product spec', gives: 'The build package to the line: routing, fixtures, gates and required checks',
    does: 'Defines how to build the thing, then sets up the line to build it, and keeps improving the lines and the process from what the line measures.',
    needs: ['A routing for every product', 'Gates proven able to fail', 'Required checks enforced on the branch', 'Process capability measured from the line'] },
  { key: 'factory', label: 'Factory floor', group: 'line', discipline: 'Production', standard: 'Work instructions under a control plan', who: 'agent', page: 'factory',
    takes: 'The build package, driven along the line by its operator agent', gives: 'The built product, with its measurements, to QA',
    does: 'An operator agent drives each product down the line, station by station, building to the package and measuring what was built.',
    needs: ['An operator agent per line, within its budget', 'The model router: the cheapest model that passes', 'Reproducible builds', 'A published build feed'] },
  { key: 'qa', label: 'QA', group: 'line', discipline: 'Quality control and inspection', standard: 'First article inspection, AS9102', who: 'agent', page: 'qa',
    takes: 'The built product', gives: 'A pass to shipping, or a fail back to the floor with the failing evidence',
    does: 'Inspects every product as a person would use it: every journey walked, measured against its reference system, every gate proven able to fail.',
    needs: ['Only certified gauges', 'Journeys walked as a person would', 'A first article against the reference system', 'Review by a second model family'] },
  { key: 'rework', label: 'Rework', group: 'line', discipline: 'Nonconformance and rework', standard: 'ISO 9001 clause 8.7, corrective action', who: 'agent', page: 'qa',
    takes: 'A failed product with its failing evidence', gives: 'The fixed product back to QA',
    does: 'Sends what fails back to the floor. The fix starts from a failing test, and the product goes through QA again.',
    needs: ['The failing journey attached to every return', 'A failing test before every fix', 'Re-inspection of the whole product, not only the fix'] },
  { key: 'shipping', label: 'Shipping', group: 'line', discipline: 'Shipping, release and configuration management', standard: 'AS9100 configuration management', who: 'agent', page: 'shipping',
    takes: 'A product that passed QA', gives: 'A signed release in the repository, on the sites, and in production',
    does: 'Packages the code, the tests, the docs and the version history into a signed release, publishes it to the repository and the sites, and deploys it to production with a person approving.',
    needs: ['A release package: code, tests, docs, SBOM, licences', 'A signed version tag', 'Docs built and checked from the source', 'Staged deploys with a person approving production'] },
  { key: 'fleet', label: 'Fleet', group: 'field', discipline: 'Field service and the installed base', standard: 'Service bulletins and field updates', who: 'agent', page: 'fleet',
    takes: 'Releases, delivered over the air', gives: 'What the field shows, back to mission control',
    does: 'Everything in service: each app, the blocks it draws on and the data it keeps. Updates arrive over the air; what the field teaches goes back to the office.',
    needs: ['Updates over the air, with rollback', 'Live walks of every product in service', 'Telemetry back to mission control'] },
  { key: 'maintenance', label: 'Maintenance', group: 'support', serves: ['factory'], discipline: 'Maintenance', standard: 'Total productive maintenance', who: 'crew', page: 'maintenance',
    takes: 'Work orders every area tags', gives: 'A factory that keeps running and gets better',
    does: 'Keeps the factory running. The night shift works the backlog within its budget, through the same gates as day work, and reports each morning.',
    needs: ['A budget per shift', 'Work orders with their acceptance test', 'The same gates as day work'] },
  { key: 'metrology', label: 'Metrology', group: 'support', serves: ['qa'], discipline: 'Metrology', standard: 'ISO/IEC 17025, AIAG MSA', who: 'crew', page: 'metrology',
    takes: 'Every gauge QA uses', gives: 'Certified gauges, and a better QA process',
    does: 'The lab behind QA: defines every measure, traces it to a reference, certifies every gauge before QA may use it, and fixes QA’s quality and process.',
    needs: ['Planted-defect calibration of every gauge', 'Repeatability and reproducibility measured', 'Every claim audited against its evidence'] },
  { key: 'deploy', label: 'Deployment engineering', group: 'support', serves: ['shipping', 'fleet'], discipline: 'Installation and field engineering', standard: 'Commissioning and site acceptance', who: 'crew', page: 'shipping',
    takes: 'Releases from shipping', gives: 'Products running in production, updated over the air',
    does: 'The cloud and field engineers: stand up where products run, deploy them, send updates over the air, watch them in service and bring back what the field shows.',
    needs: ['Environments as code', 'Deploys a person approves', 'Over-the-air updates with rollback', 'Monitoring of everything in service'] },
];

export type FlowKind = 'work' | 'rework' | 'report' | 'air';
export const FLOWS: readonly { readonly from: string; readonly to: string; readonly kind: FlowKind; readonly carries: string }[] = [
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

// ---------------------------------------------------------------- where each area stands

export type Lamp = 'go' | 'part' | 'stop' | 'off';
export interface Standing {
  readonly lamp: Lamp;
  /** Where it stands, in a sentence. */
  readonly state: string;
  readonly facts: readonly (readonly [string, string])[];
  /** One entry per need, in order: met or not. */
  readonly met: readonly boolean[];
}

/** Read from the repository and its CI at the revision named; each figure is the factory's own. */
export const AS_OF = { revision: 'f257fc2', date: '2026-11-28' };

export const STANDING: Readonly<Record<string, Standing>> = {
  mission: { lamp: 'part', state: 'The office is open, but results reach it only from a published build feed, and none is published yet.',
    facts: [['Product lines', '1'], ['Products in work', '1, Files'], ['Waiting on a person', 'Nothing']], met: [false, true, true, false] },
  lines: { lamp: 'part', state: 'One family runs: file services compatible with Nextcloud, with one product, Files.',
    facts: [['Families', '1, file services'], ['Products', '1, Files'], ['Reference system', 'Nextcloud 32.0.15']], met: [false, true, true] },
  intent: { lamp: 'go', state: 'Works end to end in the browser, from rough words to a released package.',
    facts: [['Steps', 'Rough intent, read, questions, review, signed, released'], ['Runs', 'In the browser; nothing is sent anywhere']], met: [true, false, true] },
  design: { lamp: 'part', state: 'Designs from a library of 85 tested blocks; the plan calls for 300 or more.',
    facts: [['Blocks built', '85, plus 15 that run the plant'], ['Block tests', '1,063 passing'], ['Top 50 app needs', '38 covered, 12 partly']], met: [false, true, true] },
  process: { lamp: 'part', state: 'Gates and required checks are defined and run on every change; not every routing stage has run, and capability is not yet measured.',
    facts: [['Gates', '8, run on every change'], ['Routing stages run', 'Build, QA, release'], ['Defined, never run', 'Data, signing, canary, operate']], met: [false, true, false, false] },
  factory: { lamp: 'part', state: 'Files is built and passes its own suite, and builds are reproducible byte for byte. The operator agent and its feed are not live.',
    facts: [['Files suite', '76 of 76 passing'], ['Builds', 'Reproducible byte for byte'], ['Model router', 'Built and tested; not yet driving a line']], met: [false, false, true, false] },
  qa: { lamp: 'stop', state: 'Files is inspected against stock Nextcloud with the real desktop sync client; two sync steps failed where Nextcloud passed.',
    facts: [['WebDAV conformance (litmus)', '100%, level with Nextcloud'], ['Sync journey', '2 steps failed; fix back in QA'], ['Recorded differences', '101, each explained, none closed']], met: [false, true, true, false] },
  rework: { lamp: 'part', state: 'Files went back to the floor for its two sync failures; both were fixed from a failing test and are back in QA.',
    facts: [['Returned today', 'Files: chunked upload, and rename after it'], ['Defects fixed test-first to date', 'About 300']], met: [true, true, true] },
  shipping: { lamp: 'part', state: 'Ships the plant’s own site: zthr.ai is packaged, checked and deployed from main. No product of the line has shipped.',
    facts: [['Last release', 'zthr.ai, 2026-11-28'], ['Packaging', 'SBOM, licence check, reproducible build, docs checked fresh'], ['Products shipped', 'None']], met: [true, false, true, false] },
  fleet: { lamp: 'off', state: 'Nothing from the line is in service yet.',
    facts: [['In service', 'None']], met: [false, false, false] },
  maintenance: { lamp: 'part', state: 'Works the queue a little each night without holding up the day line.',
    facts: [['Queue', '5,659 work orders'], ['Closed so far', 'About 1,260 weak gauge points, and about 300 defects'], ['Crew', 'Runs as sub-agents until the Vertex crew is live']], met: [true, true, true] },
  metrology: { lamp: 'stop', state: 'Every block is calibrated by planting defects in it. None is certified yet: certification needs every planted defect caught.',
    facts: [['Gauges certified', '0 of 85'], ['Median mutation score', '75.2%'], ['Surviving planted defects', '5,659'], ['Claims audited', '10 proven, 43 partial, 20 unproven']], met: [true, false, true] },
  deploy: { lamp: 'part', state: 'Runs the live site: zthr.ai deploys and is walked and security-scanned every two hours. No product of the line is deployed.',
    facts: [['Live today', 'zthr.ai, walked and scanned every two hours'], ['Products deployed', 'None']], met: [true, false, false, true] },
};
