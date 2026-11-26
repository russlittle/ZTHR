/**
 * The documentation, generated wherever it can be. Every figure, list, table and diagram a doc states about the
 * system is computed here from the code and the catalogues, and written into the docs between markers, so a doc
 * cannot drift from what it describes. A test fails when any doc is stale.
 *
 *   node tools/docs.ts --write    rewrite every generated doc and every marked region
 *   node tools/docs.ts --check    exit 1 if anything would change
 *
 * Three ways a doc takes generated content:
 *   <!-- fact:NAME -->value<!-- /fact -->          a figure or a short list, inline, in any doc
 *   <!-- gen:NAME -->...<!-- /gen -->               a table or a diagram, as a block, in any doc
 *   docs/src/line/*.md                              the line's own docs, written with {{NAME}}, {{table:NAME}} and
 *                                                   {{diagram:NAME}}, rendered to docs/line/*.md for the repository
 *                                                   and, by the site build, to /line pages with a depth ladder
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUTIES, PERSON_ONLY, REQUIRED_CHECKS, REVIEW_FAMILIES } from '../src/agents/duties.ts';
import { TOOLS } from '../src/agents/tools.ts';
import { PLAN } from '../src/agents/cost.ts';
import { CLASSES, FRAMEWORKS } from '../src/compliance.ts';
import { LINE_CHOICES } from '../src/console/products.ts';
import { CONNECTORS } from '../src/connectors.ts';
import { DEPARTMENTS, type Dept } from '../src/console/line.ts';
import { objectives, STAGES as DELIVERY } from '../src/delivery.ts';
import { RULES } from '../src/derive.ts';
import { loadLexicon } from '../src/lexicon.ts';
import { manifest } from '../src/manifest.ts';
import { prepare } from '../src/pipeline.ts';
import { gauges, release } from '../src/release.ts';
import { schemaOf } from '../src/schema.ts';
import { scopeOf } from '../src/compliance.ts';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p: string) => readFileSync(join(HERE, p), 'utf8');
const json = <T>(p: string): T => JSON.parse(read(p)) as T;
const n = (x: number) => x.toLocaleString('en-US');

// ---------------------------------------------------------------- the worked example every figure about an intent uses

const example = (() => {
  const fx = (f: string) => read(`test/fixtures/${f}`);
  const p = prepare({ files: [{ path: 'rough.md', text: fx('rough.md') }], readings: [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))] });
  const m = manifest(p);
  const r = release(p, { revision: 1 });
  const s = schemaOf(p);
  return { p, m, r, s, g: gauges(p), sc: scopeOf(p, s) };
})();

const catalog = {
  groups: json<{ groups: Record<string, string[]> }>('catalog/groups.json').groups,
  minimum: json<{ parts: unknown[] }>('catalog/baseline.json').parts.length,
  library: json<{ blocks: { name: string; tests?: number; home?: string; purpose: string }[] }>('catalog/catalog.json').blocks,
  housekeeping: json<{ parts: { name: string; minimum: boolean; studentAdvocate?: { from?: string } }[] }>('catalog/housekeeping.json').parts,
  patterns: json<{ patterns: unknown[] }>('catalog/patterns.json').patterns.length,
  outcomes: json<{ outcomes: unknown[] }>('catalog/platform-outcomes.json').outcomes.length,
};
const parts = Object.values(catalog.groups).reduce((a, g) => a + g.length, 0);
const ownBlocks = catalog.library.filter((b) => b.home?.startsWith('intent/blocks'));
const testsIn = (dir: string): number =>
  readdirSync(join(HERE, dir), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.test.ts'))
    .reduce((a, f) => a + (read(join(dir, f)).match(/^\s*(?:test|it)\(/gm)?.length ?? 0), 0);
const controls = FRAMEWORKS.frameworks.reduce((a, f) => a + f.controls.length, 0);
const kinds = [...new Set(CONNECTORS.map((c) => c.kind))];
const src = example.m.lines.reduce<Record<string, number>>((a, l) => ({ ...a, [l.source]: (a[l.source] ?? 0) + 1 }), {});
const already = (src['stock'] ?? 0) + (src['modify'] ?? 0) + (src['make: catalogued'] ?? 0);
const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;
const list = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Every figure a doc may state. Each is computed; none is typed. */
export const FACTS: Record<string, () => string> = {
  'dept.count': () => String(DEPARTMENTS.length),
  'dept.names': () => list(DEPARTMENTS.map((d) => d.label)),
  'catalog.parts': () => n(parts),
  'catalog.groups': () => String(Object.keys(catalog.groups).length),
  'catalog.minimum': () => String(catalog.minimum),
  'catalog.housekeeping': () => String(catalog.housekeeping.length),
  'catalog.housekeeping.minimum': () => String(catalog.housekeeping.filter((h) => h.minimum).length),
  'catalog.library': () => String(catalog.library.length),
  'blocks.count': () => String(ownBlocks.length),
  'blocks.tests': () => String(testsIn('blocks')),
  'tests.intent': () => n(testsIn('test') + testsIn('blocks')),
  'lexicon.terms': () => String(loadLexicon().terms.length),
  'derive.rules': () => String(RULES.length),
  'intake.forms': () => 'plain markdown, Spec Kit, Kiro, OpenSpec, Gherkin, HTML and Prisma',
  'schema.patterns': () => String(catalog.patterns),
  'outcomes.platform': () => String(catalog.outcomes),
  'frameworks.count': () => String(FRAMEWORKS.frameworks.length),
  'frameworks.controls': () => String(controls),
  'frameworks.names': () => list(FRAMEWORKS.frameworks.map((f) => f.name)),
  'connectors.count': () => String(CONNECTORS.length),
  'connectors.kinds': () => String(kinds.length),
  'agents.roles': () => String(DUTIES.length),
  'agents.tools': () => String(TOOLS.length),
  'agents.personOnly': () => String(PERSON_ONLY.length),
  'checks.required': () => String(REQUIRED_CHECKS.length),
  'review.families': () => String(REVIEW_FAMILIES + 1),
  'delivery.stages': () => String(DELIVERY.length),
  'delivery.names': () => list(DELIVERY.map((s) => s.name.toLowerCase())),
  'models.count': () => String(Object.keys(PLAN.models).length),
  'lines.choices': () => String(LINE_CHOICES.length),
  'fleet.classes': () => list([...CLASSES]),
  'shipping.levels': () => list(objectives(example.p).list.map((o) => `${(o.goal * 100).toFixed(1)}% ${o.what}`)),
  'example.statements': () => String(example.p.statements.length),
  'example.questions': () => String(example.p.questions.length),
  'example.records': () => String(example.s.entities.length),
  'example.lines': () => String(example.m.lines.length),
  'example.already': () => pct(already, example.m.lines.length),
  'example.new': () => String(src['make: new'] ?? 0),
  'example.built': () => String((src['stock'] ?? 0) + (src['modify'] ?? 0)),
  'example.files': () => String(Object.keys(example.r.files).length),
  'example.gauges': () => String(example.g.length),
  'example.suggested': () => list(example.sc.suggested.map((f) => FRAMEWORKS.frameworks.find((x) => x.id === f.id)?.name ?? f.id)),
};

// ---------------------------------------------------------------- tables

const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]) =>
  `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`).join('\n')}`;

/** What each department adds that every later product inherits, counted from the code. */
export const COMPOUND: readonly { dept: Dept; adds: string; count: number }[] = [
  { dept: 'mission', adds: 'one view of every product, and what waits on a person', count: 0 },
  { dept: 'lines', adds: 'spec-sheet defaults a line hands every product in it', count: LINE_CHOICES.length },
  { dept: 'intent', adds: 'intake forms, design-lexicon terms and derivation rules', count: 7 + loadLexicon().terms.length + RULES.length },
  { dept: 'engineering', adds: 'catalogued parts, information patterns, compliance controls and platform outcomes', count: parts + catalog.patterns + controls + catalog.outcomes },
  { dept: 'factory', adds: 'library blocks, agent tools and required checks', count: catalog.library.length + TOOLS.length + REQUIRED_CHECKS.length },
  { dept: 'qa', adds: 'gauges generated from every intent, and the review families', count: example.g.length + REVIEW_FAMILIES + 1 },
  { dept: 'shipping', adds: 'delivery stages, each with its gate, and the service levels the example is held to', count: DELIVERY.length + objectives(example.p).list.length },
  { dept: 'fleet', adds: 'connectors and the sensitive-data classes every app is governed by', count: CONNECTORS.length + CLASSES.length },
];
const cumulative = COMPOUND.reduce<number[]>((a, c) => [...a, (a.at(-1) ?? 0) + c.count], []);

export const TABLES: Record<string, () => string> = {
  departments: () => table(['#', 'Department', 'What it does', 'Open it', 'How it works'], DEPARTMENTS.map((d, i) => [i + 1, d.label, d.does, `[${d.href}](https://zthr.ai${d.href})`, `[${d.label}](${d.key}.md)`])),
  'departments-root': () => table(['#', 'Department', 'What it does', 'Open it', 'How it works'], DEPARTMENTS.map((d, i) => [i + 1, d.label, d.does, `[${d.href}](https://zthr.ai${d.href})`, `[${d.label}](docs/line/${d.key}.md)`])),
  'blocks-here': () => table(['Block', 'What it holds', 'Tests'], ownBlocks.map((b) => [`[${b.name}](${b.name}/index.ts)`, b.purpose, b.tests ?? 0])),
  compounding: () => table(['Department', 'What it adds that every later product inherits', 'Fixtures', 'In all, so far'], COMPOUND.map((c, i) => [DEPARTMENTS.find((d) => d.key === c.dept)!.label, c.adds, c.count || 'none', n(cumulative[i]!)])),
  'catalog-groups': () => table(['Group', 'Parts'], Object.entries(catalog.groups).map(([g, ps]) => [g, ps.length])),
  blocks: () => table(['Block', 'What it holds', 'Tests'], ownBlocks.map((b) => [`[${b.name}](../../blocks/${b.name}/index.ts)`, b.purpose, b.tests ?? 0])),
  frameworks: () => table(['Framework', 'Controls mapped'], FRAMEWORKS.frameworks.map((f) => [f.name, f.controls.length])),
  connectors: () => table(['Kind', 'Tools'], kinds.map((k) => [k, CONNECTORS.filter((c) => c.kind === k).map((c) => c.name).join(', ')])),
  stages: () => table(['Stage', 'What it proves', 'Gate'], DELIVERY.map((s) => [s.name, s.proves.join('; '), s.gate])),
  roles: () => table(['Role', 'Does', 'Tools'], DUTIES.map((d) => [d.role, d.does, TOOLS.filter((t) => t.roles === 'all' || t.roles.includes(d.role)).length])),
  models: () => table(['Seat', 'Models, cheapest that fits first'], Object.entries(PLAN.seats).filter(([, m]) => m.length).map(([s, m]) => [s, m.map((k) => `${k} (${PLAN.models[k]!.family})`).join(', ')])),
  checks: () => table(['#', 'Required check', 'Step'], REQUIRED_CHECKS.map((c, i) => [i + 1, c.check, `npm run ${c.step}`])),
  package: () => {
    const top = Object.keys(example.r.files).reduce<Record<string, number>>((a, f) => {
      const k = f.includes('/') ? `${f.split('/')[0]}/` : f;
      return { ...a, [k]: (a[k] ?? 0) + 1 };
    }, {});
    return table(['In the package', 'Files'], Object.entries(top).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [`\`${k}\``, v]));
  },
  'example-sources': () => table(['Where a line of the example’s manifest comes from', 'Lines'], [['Standard assembly, used as is', src['stock'] ?? 0], ['Standard assembly, extended', src['modify'] ?? 0], ['Catalogued part, still to make', src['make: catalogued'] ?? 0], ['Custom, designed new', src['make: new'] ?? 0]]),
};

// ---------------------------------------------------------------- diagrams: one source, Mermaid for the repository, SVG for the site

interface FlowNode {
  readonly id: string;
  readonly label: string;
  readonly sub?: string;
}
interface FlowEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  /** Drawn dashed: a loop back, not the main flow. */
  readonly back?: boolean;
}
type Diagram = { kind: 'flow'; caption: string; nodes: readonly FlowNode[]; edges: readonly FlowEdge[] } | { kind: 'bars'; caption: string; unit: string; bars: readonly { label: string; value: number }[] } | { kind: 'erd'; caption: string; mermaid: string; relations: readonly string[] };

const chain = (ids: readonly string[]): FlowEdge[] => ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }));

export const DIAGRAMS: Record<string, () => Diagram> = {
  line: () => ({
    kind: 'flow',
    caption: 'The line: work moves left to right, and what is learned in service comes back to the start.',
    nodes: DEPARTMENTS.map((d, i) => ({ id: d.key, label: `${i + 1} ${d.label}` })),
    edges: [...chain(DEPARTMENTS.map((d) => d.key)), { from: 'qa', to: 'factory', label: 'failing journeys become cases', back: true }, { from: 'engineering', to: 'intent', label: 'Class I clarifications', back: true }, { from: 'fleet', to: 'mission', label: 'reports and alerts', back: true }],
  }),
  compounding: () => ({ kind: 'bars', caption: 'Fixtures every later product inherits, in all, as each department joins the line.', unit: 'fixtures', bars: COMPOUND.map((c, i) => ({ label: DEPARTMENTS.find((d) => d.key === c.dept)!.label, value: cumulative[i]! })) }),
  mission: () => ({ kind: 'flow', caption: 'Mission control reads every department, and sends a person where they are needed.', nodes: [{ id: 'f', label: 'Feed and studio', sub: 'what each department measured' }, { id: 'a', label: 'Products along the line', sub: 'a lamp per department' }, { id: 'w', label: 'Waiting on you', sub: 'questions, signatures, releases' }, { id: 'd', label: 'The department', sub: 'with the product in focus' }], edges: chain(['f', 'a', 'w', 'd']) }),
  lines: () => ({ kind: 'flow', caption: 'A line is defined once; every product in it starts from its choices.', nodes: [{ id: 'l', label: 'Product line', sub: 'who it serves, its end' }, { id: 'd', label: 'Defaults', sub: 'compliance, sign-in, reports, API' }, { id: 'p', label: 'New product', sub: 'starts from them' }, { id: 's', label: 'Intent studio', sub: 'only the delta is said' }], edges: chain(['l', 'd', 'p', 's']) }),
  intent: () => ({ kind: 'flow', caption: 'The intent studio: rough words in, a signed schematic out.', nodes: [{ id: 'w', label: 'The expert’s words', sub: 'any form' }, { id: 'r', label: 'Two readings', sub: 'two families, apart' }, { id: 's', label: 'Schematic', sub: 'balloons, sources, tolerances' }, { id: 'q', label: 'Questions', sub: 'only what changes the build' }, { id: 'g', label: 'Signed', sub: 'by the holder' }], edges: [...chain(['w', 'r', 's', 'q', 'g']), { from: 'q', to: 's', label: 'answers', back: true }] }),
  engineering: () => ({ kind: 'flow', caption: 'Engineering: the signed schematic completed into a specification, then released.', nodes: [{ id: 's', label: 'Signed schematic' }, { id: 'o', label: 'Outcomes', sub: 'assessment, criteria, target' }, { id: 'i', label: 'Information', sub: 'records, rules, migrations' }, { id: 'c', label: 'Compliance', sub: 'controls and evidence' }, { id: 'm', label: 'Measures and tests', sub: 'gauges, ranges, ratchets' }, { id: 'p', label: 'Released package', sub: 'the datum' }], edges: chain(['s', 'o', 'i', 'c', 'm', 'p']) }),
  factory: () => ({ kind: 'flow', caption: 'The factory: every change tested before it is pushed, admitted only on evidence.', nodes: [{ id: 'p', label: 'Package', sub: 'and its brief' }, { id: 'b', label: 'Builder', sub: 'a change on a commit' }, { id: 't', label: 'Tests', sub: 'on the base, then the commit' }, { id: 'c', label: 'Required checks', sub: 'run by the API' }, { id: 'r', label: 'Reviews', sub: 'two other families' }, { id: 'a', label: 'Admitted', sub: 'computed' }], edges: [...chain(['p', 'b', 't', 'c', 'r', 'a']), { from: 'c', to: 'b', label: 'a failure opens a case', back: true }] }),
  qa: () => ({ kind: 'flow', caption: 'QA: judged as a person would judge it, by gauges that have been shown to fail.', nodes: [{ id: 'b', label: 'Build' }, { id: 'j', label: 'Journeys walked', sub: 'as a person, every mode' }, { id: 'g', label: 'Gates', sub: 'proven able to fail' }, { id: 'r', label: 'Ratchets', sub: 'only tighten' }, { id: 'c', label: 'Certified phase' }], edges: [...chain(['b', 'j', 'g', 'r', 'c']), { from: 'j', to: 'b', label: 'a failing journey is a case', back: true }] }),
  shipping: () => ({ kind: 'flow', caption: 'Shipping: stage by stage, a person approving production, one step back always.', nodes: DELIVERY.map((s) => ({ id: s.id, label: s.name })), edges: [...chain(DELIVERY.map((s) => s.id)), { from: DELIVERY.at(-1)!.id, to: DELIVERY[0]!.id, label: 'roll back, then start again', back: true }] }),
  fleet: () => ({ kind: 'flow', caption: 'The fleet: one library, one governance, and everything learned in service sent back.', nodes: [{ id: 's', label: 'In service', sub: 'watched against its levels' }, { id: 'l', label: 'Shared library', sub: 'a fix reaches every app' }, { id: 'd', label: 'Sensitive data', sub: 'gated the same way' }, { id: 'r', label: 'Reports and alerts' }, { id: 'c', label: 'Cases', sub: 'bugs, ideas, incidents' }], edges: [...chain(['s', 'l', 'd', 'r', 'c']), { from: 'c', to: 's', label: 'fixed and shipped again', back: true }] }),
  architecture: () => ({
    kind: 'flow',
    caption: 'The system: one deterministic engine, the surfaces that use it, and the agent API that runs the factory.',
    nodes: [{ id: 'i', label: 'Intake', sub: 'every form, by rule' }, { id: 'p', label: 'Prepare', sub: 'schematic, questions' }, { id: 'e', label: 'Specify', sub: 'manifest, schema, controls' }, { id: 'r', label: 'Release', sub: 'hashed package' }, { id: 'a', label: 'Agent API', sub: 'roles, ledger, cases' }, { id: 'o', label: 'Deliver and run', sub: 'stages, levels, fleet' }],
    edges: [...chain(['i', 'p', 'e', 'r', 'a', 'o']), { from: 'o', to: 'p', label: 'cases and clarifications', back: true }],
  }),
  'package-erd': () => ({
    kind: 'erd',
    caption: 'What a released package holds, and how its parts refer to each other.',
    mermaid: `erDiagram
  DATUM ||--o{ STATEMENT : "balloons"
  STATEMENT ||--o{ GAUGE : "measured by"
  STATEMENT ||--o{ MANIFEST_LINE : "built by"
  STATEMENT ||--o{ CONTROL : "held by (when marked)"
  DATUM ||--|| INFORMATION : "keeps"
  INFORMATION ||--o{ RECORD : "has"
  RECORD ||--o{ FIELD : "has"
  DATUM ||--o{ OUTCOME : "commits to"
  OUTCOME ||--o{ ASSESSMENT : "assessed by"
  DATUM ||--|| SPEC_SHEET : "chooses"
  DATUM ||--o{ COMPLIANCE_CONTROL : "lives under"
  MANIFEST ||--o{ MANIFEST_LINE : "lists"`,
    relations: ['Every statement on the datum has a balloon, and is measured by gauges, built by manifest lines and, when marked, held by a control.', 'The datum keeps one information schema: records, each with fields and a sensitivity class.', 'The datum commits to outcomes, each assessed by journeys before release and by targets in use.', 'The datum chooses its spec sheet and lives under the compliance controls in scope.'],
  }),
};

const wrap = (s: string, max: number): string[] => {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max && line) {
      out.push(line);
      line = w;
    } else line = `${line} ${w}`.trim();
  }
  if (line) out.push(line);
  return out;
};
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function mermaid(d: Diagram): string {
  if (d.kind === 'erd') return `\`\`\`mermaid\n${d.mermaid}\n\`\`\``;
  if (d.kind === 'bars') return `\`\`\`mermaid\nxychart-beta\n  title "${d.caption.replace(/"/g, "'")}"\n  x-axis [${d.bars.map((b) => `"${b.label}"`).join(', ')}]\n  y-axis "${d.unit}" 0 --> ${Math.ceil(Math.max(...d.bars.map((b) => b.value)) / 50) * 50}\n  bar [${d.bars.map((b) => b.value).join(', ')}]\n\`\`\``;
  const node = (f: FlowNode) => `  ${f.id.replace(/[^a-z0-9]/gi, '_')}["${f.label.replace(/"/g, "'")}${f.sub ? `<br><small>${f.sub.replace(/"/g, "'")}</small>` : ''}"]`;
  const id = (s: string) => s.replace(/[^a-z0-9]/gi, '_');
  return `\`\`\`mermaid\nflowchart LR\n${d.nodes.map(node).join('\n')}\n${d.edges.map((e) => `  ${id(e.from)} ${e.back ? '-.->' : '-->'}${e.label ? `|${e.label}|` : ''} ${id(e.to)}`).join('\n')}\n\`\`\``;
}

/** The same diagram as an SVG the site can show without a script: nodes in rows, loops drawn dashed underneath. */
export function svg(d: Diagram, title: string): string {
  if (d.kind === 'erd') return `<ul class="erd">${d.relations.map((r) => `<li>${x(r)}</li>`).join('')}</ul>`;
  if (d.kind === 'bars') {
    const W = 760, H = 300, L = 150, max = Math.max(...d.bars.map((b) => b.value)), bh = (H - 30) / d.bars.length;
    return `<figure class="fig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${title}-t"><title id="${title}-t">${x(d.caption)}</title>${d.bars.map((b, i) => { const w = ((W - L - 70) * b.value) / max; const y = 10 + i * bh; return `<text x="${L - 8}" y="${y + bh / 2 + 4}" text-anchor="end" font-size="13" fill="var(--ink)">${x(b.label)}</text><rect x="${L}" y="${y + 4}" width="${Math.max(2, w)}" height="${bh - 8}" fill="var(--ink)" opacity="${0.35 + (0.65 * (i + 1)) / d.bars.length}"/><text x="${L + w + 6}" y="${y + bh / 2 + 4}" font-size="13" fill="var(--ink)">${n(b.value)}</text>`; }).join('')}</svg><figcaption>${x(d.caption)}</figcaption></figure>`;
  }
  // Up to six boxes sit in one row; more wrap into rows of four. Loops run in the gap under their own row; a loop
  // back to an earlier row goes round the left margin, so no line ever crosses a box.
  const per = d.nodes.length <= 6 ? d.nodes.length : 4, NW = 168, NH = 64, GX = 26, PAD = 12;
  const rows = Math.ceil(d.nodes.length / per);
  const rowOf = (id: string) => Math.floor(d.nodes.findIndex((nd) => nd.id === id) / per);
  const backs = d.edges.filter((e) => e.back);
  const same = backs.filter((e) => rowOf(e.from) === rowOf(e.to));
  const cross = backs.filter((e) => rowOf(e.from) !== rowOf(e.to));
  const lanesIn = (r: number) => same.filter((e) => rowOf(e.from) === r).length;
  const gapBelow = (r: number) => (r < rows - 1 ? 34 : 6) + lanesIn(r) * 26 + (r === rows - 1 ? cross.length * 26 : 0);
  const LM = cross.length ? 18 + cross.length * 14 : 0;
  const rowTop: number[] = [];
  for (let r = 0, y = PAD; r < rows; r++) {
    rowTop.push(y);
    y += NH + gapBelow(r);
  }
  const W = LM + PAD * 2 + per * NW + (per - 1) * GX, H = rowTop[rows - 1]! + NH + gapBelow(rows - 1) + PAD;
  const pos = new Map(d.nodes.map((nd, i) => [nd.id, { x: LM + PAD + (i % per) * (NW + GX), y: rowTop[Math.floor(i / per)]! }]));
  const box = (nd: FlowNode) => {
    const p = pos.get(nd.id)!;
    const lines = [...wrap(nd.label, 20).map((t) => ({ t, b: true })), ...(nd.sub ? wrap(nd.sub, 24).map((t) => ({ t, b: false })) : [])].slice(0, 4);
    const top = p.y + NH / 2 - (lines.length * 15) / 2 + 11;
    return `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="4" fill="var(--sheet)" stroke="var(--ink)" stroke-width="1.5"/>${lines.map((l, i) => `<text x="${p.x + NW / 2}" y="${top + i * 15}" text-anchor="middle" font-size="${l.b ? 13 : 11.5}" font-weight="${l.b ? 600 : 400}" fill="var(--ink)">${x(l.t)}</text>`).join('')}`;
  };
  const fwd = d.edges.filter((e) => !e.back).map((e) => {
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    if (b.y === a.y) return `<path d="M${a.x + NW} ${a.y + NH / 2} H${b.x - 4}" stroke="var(--ink)" stroke-width="1.5" fill="none" marker-end="url(#${title}-a)"/>`;
    const midY = b.y - 16;
    return `<path d="M${a.x + NW / 2} ${a.y + NH} V${midY} H${b.x + NW / 2} V${b.y - 4}" stroke="var(--ink)" stroke-width="1.5" fill="none" marker-end="url(#${title}-a)"/>`;
  });
  const dash = 'stroke="var(--ink-2, #555)" stroke-width="1.3" stroke-dasharray="5 4" fill="none"';
  const label = (lx: number, ly: number, t?: string) => (t ? `<text x="${lx}" y="${ly}" font-size="11.5" fill="var(--ink-2, #555)">${x(t)}</text>` : '');
  const back = [
    ...same.map((e) => {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      const k = same.filter((o) => rowOf(o.from) === rowOf(e.from)).indexOf(e);
      const y = a.y + NH + 16 + k * 26;
      return `<path d="M${a.x + NW / 2 + 10} ${a.y + NH} V${y} H${b.x + NW / 2 - 10} V${b.y + NH + 4}" ${dash} marker-end="url(#${title}-a)"/>${label(Math.min(a.x, b.x) + NW / 2 + 16, y - 4, e.label)}`;
    }),
    ...cross.map((e, k) => {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      const y = a.y + NH + 16 + (lanesIn(rowOf(e.from)) + k) * 26;
      const lx = 8 + k * 14;
      return `<path d="M${a.x + NW / 2} ${a.y + NH} V${y} H${lx} V${b.y + NH / 2} H${b.x - 4}" ${dash} marker-end="url(#${title}-a)"/>${label(lx + 10, y - 4, e.label)}`;
    }),
  ];
  return `<figure class="fig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${title}-t"><title id="${title}-t">${x(d.caption)}</title><defs><marker id="${title}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink)"/></marker></defs>${fwd.join('')}${back.join('')}${d.nodes.map(box).join('')}</svg><figcaption>${x(d.caption)}</figcaption></figure>`;
}

// ---------------------------------------------------------------- markers in any doc

// A marker quoted in inline code (`<!-- fact:... -->`) is an example, not a marker.
const FACT = /(?<!`)<!-- fact:([\w.-]+) -->[\s\S]*?<!-- \/fact -->/g;
const GEN = /(?<!`)<!-- gen:([\w:.-]+) -->[\s\S]*?<!-- \/gen -->/g;

function genBlock(name: string): string {
  const [kind, key] = name.includes(':') ? (name.split(':') as [string, string]) : ['table', name];
  const out = kind === 'diagram' ? DIAGRAMS[key] && mermaid(DIAGRAMS[key]!()) : TABLES[key]?.();
  if (out === undefined) throw new Error(`no generated ${kind} called ${key}`);
  return out;
}

export function fill(text: string, where: string): string {
  return text
    .replace(FACT, (_, k: string) => {
      const f = FACTS[k];
      if (!f) throw new Error(`${where}: no fact called ${k}`);
      return `<!-- fact:${k} -->${f()}<!-- /fact -->`;
    })
    .replace(GEN, (_, k: string) => `<!-- gen:${k} -->\n${genBlock(k)}\n<!-- /gen -->`);
}

// ---------------------------------------------------------------- the line's own docs

export const LINE_DOCS = ['index', ...DEPARTMENTS.map((d) => d.key), 'architecture'] as const;
export type LineDoc = (typeof LINE_DOCS)[number];
const SRC = 'docs/src/line';
const OUT = 'docs/line';
const outName = (k: LineDoc) => (k === 'index' ? 'README.md' : `${k}.md`);

/** A source with its placeholders resolved, for a given target: Mermaid for the repository, SVG for the site. */
export function resolve(k: LineDoc, target: 'md' | 'html'): string {
  const raw = read(`${SRC}/${k}.md`);
  return raw
    .replace(/^\{\{table:([\w-]+)\}\}$/gm, (_, t: string) => {
      const f = TABLES[t];
      if (!f) throw new Error(`${k}: no table ${t}`);
      return f();
    })
    .replace(/^\{\{diagram:([\w-]+)\}\}$/gm, (_, t: string) => {
      const f = DIAGRAMS[t];
      if (!f) throw new Error(`${k}: no diagram ${t}`);
      return target === 'md' ? mermaid(f()) : `<!--html-->${svg(f(), `d-${k}-${t}`)}`;
    })
    .replace(/\{\{([\w.-]+)\}\}/g, (_, f: string) => {
      const v = FACTS[f];
      if (!v) throw new Error(`${k}: no fact ${f}`);
      return v();
    });
}

const HEAD = (k: LineDoc) => `<!-- Generated by tools/docs.ts from ${SRC}/${k}.md. Edit the source, then run: node tools/docs.ts --write -->\n\n`;

/** Every file the generator owns or rewrites, with what it should contain now. */
export function plan(): { path: string; want: string }[] {
  const out: { path: string; want: string }[] = LINE_DOCS.map((k) => ({ path: `${OUT}/${outName(k)}`, want: HEAD(k) + resolve(k, 'md') }));
  const marked = ['README.md', 'PAPER.md', 'blocks/README.md', ...readdirSync(join(HERE, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), '../README.md'];
  for (const p of marked) {
    if (!existsSync(join(HERE, p))) continue;
    const text = read(p);
    if (!FACT.test(text) && !GEN.test(text)) continue;
    FACT.lastIndex = 0;
    GEN.lastIndex = 0;
    out.push({ path: p, want: fill(text, p) });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const stale: string[] = [];
  for (const { path, want } of plan()) {
    const full = join(HERE, path);
    const have = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (have === want) continue;
    stale.push(path);
    if (mode === '--write') {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, want);
    }
  }
  if (mode === '--write') console.log(stale.length ? `rewrote ${stale.join(', ')}` : 'every doc is fresh');
  else if (stale.length) {
    console.error(`stale: ${stale.join(', ')}\nrun: node tools/docs.ts --write`);
    process.exit(1);
  } else console.log('every doc is fresh');
}

// ---------------------------------------------------------------- the site: the same docs as pages, with the depth ladder

const DEPTHS = [
  { key: 'TL;DR', id: 'tldr', blurb: 'One paragraph, and the picture.' },
  { key: 'Explain it simply', id: 'simply', blurb: 'No software knowledge needed.' },
  { key: 'Engineer', id: 'engineer', blurb: 'What it does, what it holds, and the figures.' },
  { key: 'Architect', id: 'architect', blurb: 'Why it is built this way, and how it relates to the rest.' },
] as const;

const inline = (s: string, link: (href: string) => string) =>
  x(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, h: string) => `<a href="${x(link(h.replace(/&amp;/g, '&')))}">${t}</a>`);

/** A small markdown renderer for what these docs use: headings, paragraphs, lists, tables, quotes, code and raw figures. */
export function html(md: string, link: (href: string) => string, slug: (t: string) => string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!;
    if (l.startsWith('<!--html-->')) {
      out.push(l.slice('<!--html-->'.length));
      i++;
    } else if (/^```/.test(l)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      out.push(l.includes('mermaid') ? '' : `<pre><code>${x(body.join('\n'))}</code></pre>`);
    } else if (/^#{1,4} /.test(l)) {
      const lvl = l.match(/^#+/)![0].length;
      const t = l.replace(/^#+ /, '');
      out.push(`<h${lvl} id="${slug(t)}">${inline(t, link)}</h${lvl}>`);
      i++;
    } else if (/^\|/.test(l)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|/.test(lines[i]!); i++) rows.push(lines[i]!.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')));
      const [head, , ...body] = rows;
      out.push(`<div class="tbl-wrap" tabindex="0" role="region" aria-label="${x(head!.join(', '))}"><table><thead><tr>${head!.map((h) => `<th scope="col">${inline(h, link)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^- /.test(l)) {
      const items: string[] = [];
      for (; i < lines.length && /^- /.test(lines[i]!); i++) items.push(lines[i]!.slice(2));
      out.push(`<ul>${items.map((t) => `<li>${inline(t, link)}</li>`).join('')}</ul>`);
    } else if (/^\d+\. /.test(l)) {
      const items: string[] = [];
      for (; i < lines.length && /^\d+\. /.test(lines[i]!); i++) items.push(lines[i]!.replace(/^\d+\. /, ''));
      out.push(`<ol>${items.map((t) => `<li>${inline(t, link)}</li>`).join('')}</ol>`);
    } else if (/^> /.test(l)) {
      out.push(`<p class="lede">${inline(l.slice(2), link)}</p>`);
      i++;
    } else if (!l.trim()) i++;
    else {
      const para: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && !/^(#|\||- |\d+\. |> |```|<!--html-->)/.test(lines[i]!); i++) para.push(lines[i]!);
      out.push(`<p>${inline(para.join(' '), link)}</p>`);
    }
  }
  return out.join('\n');
}

const REPO = 'https://github.com/russlittle/ZTHR/blob/main/intent';

/** Where a link in a line doc goes on the site. */
const siteLink = (h: string): string => {
  if (/^https?:|^#|^\//.test(h)) return h;
  const doc = /^([\w-]+)\.md(#.*)?$/.exec(h);
  if (doc) return `${doc[1] === 'README' ? '/line/' : `/line/${doc[1]}/`}${doc[2] ?? ''}`;
  return `${REPO}/docs/line/${h}`.replace('/docs/line/../../', '/').replace('/docs/line/../', '/docs/');
};

export interface SitePage {
  readonly doc: LineDoc;
  readonly dept: Dept | null;
  readonly title: string;
  readonly lede: string;
  readonly body: string;
}

/** Each line doc as a page body: the title, the depth ladder, and the four depths. */
export function sitePages(): SitePage[] {
  return LINE_DOCS.map((k) => {
    const md = resolve(k, 'html');
    const title = /^# (.+)$/m.exec(md)![1]!;
    const lede = /^> (.+)$/m.exec(md)?.[1] ?? '';
    const used = new Set<string>();
    const slug = (t: string) => {
      const base = (DEPTHS.find((d) => d.key === t)?.id ?? t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'section';
      let s = base;
      for (let j = 2; used.has(s); j++) s = `${base}-${j}`;
      used.add(s);
      return s;
    };
    const sections = md.split(/^(?=## )/m);
    const words = (s: string) => s.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    let minutes = 0;
    const ladder = DEPTHS.map((d, i) => {
      const sec = sections.find((s) => s.startsWith(`## ${d.key}\n`)) ?? '';
      minutes += Math.max(1, Math.round(words(sec) / 200));
      return `<a class="rung" href="#${d.id}"><span class="depth"><span>Depth ${i + 1}</span><span>${minutes} min</span></span><span class="rung-t">${x(d.key)}</span><span class="rung-b">${x(d.blurb)}</span><span class="gauge"><span style="width:${[12, 32, 64, 100][i]}%"></span></span></a>`;
    }).join('');
    const content = html(md.replace(/^# .+$/m, '').replace(/^> .+$/m, ''), siteLink, slug);
    const dept = (DEPARTMENTS.find((d) => d.key === k)?.key ?? null) as Dept | null;
    return { doc: k, dept, title, lede, body: `<nav class="ladder" aria-label="Choose your depth">${ladder}</nav>\n<article class="prose">${content}</article>` };
  });
}
