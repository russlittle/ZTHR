/**
 * The evidence the plant model puts on each page, written in by the site build: the panel every console page ends
 * with (what the area needs, and which needs the repository shows met), and the repository's own evidence for the
 * areas whose pages are drawn from it (manufacturing engineering, rework, deployment engineering). Every figure is
 * counted from the repository at build time; where nothing exists the page says it is not measured yet.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CHECKS } from '../src/agents/duties.ts';
import { STAGES } from '../src/delivery.ts';
import { area, docHref, standingOf, type AreaKey, type Facts, type Standing } from '../src/console/plant-model.ts';
import { GATES } from './gates.ts';
import { packageTop, FACTS } from './docs.ts';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const code = (t: string) => `<code>${esc(t)}</code>`;
const table = (label: string, head: readonly string[], rows: readonly (readonly string[])[]) =>
  `<div class="tbl-wrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="swim"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
const sheet = (id: string, title: string, body: string) => `<section class="sheet" aria-labelledby="${id}"><h2 id="${id}">${esc(title)}</h2>\n${body}</section>`;

/** A cron expression, in words, for the few shapes the workflows use. */
export function cronWords(cron: string): string {
  const [m, h, dom, , dow] = cron.trim().split(/\s+/);
  const every = /^\*\/(\d+)$/.exec(h ?? '');
  if (every) return `every ${every[1] === '2' ? 'two' : every[1]} hours`;
  const at = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`;
  if (dow && /^\d$/.test(dow)) return `weekly, ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(dow)]} at ${at}`;
  return dom === '*' ? `daily at ${at}` : cron;
}

/** The workflows that run on a schedule, with their name and when, read from .github/workflows. */
export function workflows(): { file: string; name: string; when: string | null }[] {
  const dir = join(ROOT, '.github/workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8');
      const cron = /cron:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
      return { file: f, name: /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? f, when: cron ? cronWords(cron) : null };
    });
}

const lamp = (cls: 'pass' | 'unk', mark: string, word: string) => `<span class="lamp ${cls}" role="img" aria-label="${word}">${mark}</span>`;

/** The panel that closes a console page: the area's needs, which are met, and the figures behind them. */
export function standingPanel(key: AreaKey, st: Standing, facts: Facts): string {
  const a = area(key);
  const revision = facts.asOf.revision ? `revision ${esc(facts.asOf.revision)}${facts.asOf.date ? ` of ${esc(facts.asOf.date)}` : ''}` : 'the checkout (no history to name a revision)';
  const unmet = st.met.filter((m) => !m).length;
  return `<section class="sheet standing" aria-labelledby="h-needs"><h2 id="h-needs">What ${esc(a.label)} needs, and where it stands</h2>
<p><strong>${esc(st.state)}</strong></p>
<ul class="needs">${a.needs.map((n, i) => `<li>${st.met[i] ? lamp('pass', '✓', 'met') : lamp('unk', '○', 'not met yet')}<span>${esc(n)}<span class="small muted"> (${st.met[i] ? 'met' : 'not met yet'})</span></span></li>`).join('')}</ul>
<dl class="facts-dl">${st.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<p class="small muted">${a.needs.length - unmet} of ${a.needs.length} needs met, read from the repository at ${revision}. A need is met only while the evidence for it exists. <a href="/plant/#${a.key}">See it on the plant</a> · <a href="${docHref(a)}">How it works</a></p></section>`;
}

const none = (what: string) => `<p class="muted">${esc(what)}</p>`;

// ---------------------------------------------------------------- manufacturing engineering

function processEvidence(f: Facts): string {
  const pack = packageTop();
  const gates = GATES.map((g) => [code(g.id), esc(g.what), code(g.proof.file), `${g.proof.min} or more`, existsSync(join(ROOT, 'intent', g.proof.file)) ? 'Proof present' : 'Proof missing']);
  const rules = f.has('control/live-rules.json');
  return [
    sheet('h-bp', 'The build package', `<p>Product engineering hands on the product spec; manufacturing engineering turns it into the build package the factory floor builds to. The package a release carries today, counted from the worked example:</p>${table('What the package holds', ['In the package', 'Files'], pack.map(([k, v]) => [code(k), String(v)]))}<p class="small muted">The control plan, the gauges, the starting ratchets and the agent brief are manufacturing engineering's own parts of it.</p>`),
    sheet('h-rt', 'The routing', `<p>Every product follows the same routing: ${STAGES.length} stages, each proving something and each with the gate that lets the next begin. The routing is defined in ${code('src/delivery.ts')}; the stages a product has run are recorded by its pipeline, not by this repository.</p>${table('The routing', ['Stage', 'What it proves', 'Gate'], STAGES.map((s) => [esc(s.name), esc(`${s.proves.join('; ')}.`), esc(s.gate)]))}`),
    sheet('h-gt', 'Gates proven able to fail', `<p>A gate counts only while its planted defects still make it fail. ${GATES.length} gates are defined, each with the test that plants its defects:</p>${table('Gates', ['Gate', 'What it holds', 'Proof', 'Planted defects', 'Evidence'], gates)}`),
    sheet('h-rc', 'Required checks', `<p>${REQUIRED_CHECKS.length} checks run on every change, cheapest first; the first failure stops the run.</p>${table('Required checks', ['#', 'Required check', 'Run as'], REQUIRED_CHECKS.map((c, i) => [String(i + 1), esc(c.check), code(`npm run ${c.step}`)]))}<p>${rules ? 'The live branch rules are recorded and compared with GitHub on every run.' : `<strong>Enforcement on the branch is not recorded.</strong> ${code('npm run live-rules')} compares GitHub's live branch rules with ${code('control/live-rules.json')}, which this repository does not hold yet.`}</p>`),
    sheet('h-pc', 'Process capability', f.has('intent/factory/capability.json') ? none('Recorded.') : `<p><strong>Not measured yet.</strong> Capability is how well the line holds its own measures over many runs: build time, flake rate, cost per change. No run history is recorded in the repository, so nothing is charted. Metrology owns the control charts it will appear on.</p>`),
  ].join('\n');
}

// ---------------------------------------------------------------- rework

function reworkEvidence(f: Facts): string {
  const recorded = f.has('intent/factory/returns.json');
  return [
    sheet('h-lp', 'The loop', `<ol><li>QA fails a product and sends it back with the failing journey and the evidence of the failure.</li><li>Rework writes a failing test first, so the defect cannot come back unseen.</li><li>The fix makes the test pass, through the same gates as any other change.</li><li>QA inspects the whole product again, not only the fix, and either passes it on to shipping or returns it.</li></ol>`),
    sheet('h-rf', 'What a return carries', table('A return', ['Part of a return', 'What it is'], [['The failing journey', 'The journey that failed, by its id and the goal a person could not reach.'], ['The evidence', 'What QA saw: the step that failed and what it was compared with.'], ['The failing test', 'Written before the fix, and kept as a ratchet afterwards.'], ['The fix', 'The change that makes the test pass, admitted through the required checks.'], ['The re-inspection', 'QA’s verdict on the whole product after the fix.']])),
    sheet('h-ev', 'Evidence in the repository', table('Rework evidence', ['Measure', 'Where it stands'], [
      ['Returns recorded', recorded ? 'Recorded in intent/factory/returns.json' : '<strong>Not measured yet.</strong> No record of returns is kept in the repository; the live returns below come from the latest build.'],
      ['Test-first gate for repairs', f.has('tools/mutation') ? `Enforced for work orders by ${code('tools/mutation')}` : 'Not built'],
      ['Work orders waiting', String(f.queue.workOrders.toLocaleString('en-US'))],
      ['Work orders accepted', f.queue.done ? String(f.queue.done) : 'None yet'],
      ['Whole-product re-inspection', 'Not measured yet: no returned product has been re-inspected on record'],
    ])),
  ].join('\n');
}

// ---------------------------------------------------------------- deployment engineering

function deploymentEvidence(f: Facts): string {
  const wf = workflows().filter((w) => ['deploy.yml', 'livewalk.yml', 'security-scan.yml'].includes(w.file));
  const envs = [
    ['zthr.ai, on Firebase Hosting', `${code('firebase.json')} and ${code('.github/workflows/deploy.yml')}`, 'Live. Built from main by the deploy workflow and checked link by link before it goes out.'],
    ['The reference app, on Cloud Run', code('.github/workflows/deploy.yml'), 'Live. zthr.ai takes the copy its own build made and verifies every part against that build’s checksums.'],
    ['Products of the line', `${code('src/delivery.ts')} writes each product’s pipeline`, f.releases ? `${f.releases} released` : 'None deployed: no product of the line has shipped.'],
  ];
  return [
    sheet('h-env', 'Environments as code', `<p>Where products run is written down, never clicked together. Anything that grants access or creates cloud resources is written as commands for a person to run in Cloud Shell, with the least access each identity needs.</p>${table('Environments', ['Environment', 'Defined in', 'State'], envs.map(([a, b, c]) => [esc(a!), b!, esc(c!)]))}`),
    sheet('h-dp', 'Deploys a person approves', `<p>A signed image goes out in stages: deployed with no traffic, tried by a few, then released to everyone. A named person approves production at the canary, and the error budget must not be burning. ${f.releases ? '' : '<strong>No approval is recorded yet</strong>, because no product of the line has reached production.'}</p><p class="small muted">The stages and their gates are on <a href="/shipping/">Shipping</a>.</p>`),
    sheet('h-ota', 'Over-the-air updates, with rollback', f.has('intent/factory/fleet/ota.json') ? none('Recorded.') : `<p><strong>Not built yet.</strong> Every product's pipeline keeps the previous revision ready to take traffic back in one step, so rollback is defined. Updates reaching products already in service over the air are not recorded: ${f.inService ? `${f.inService} in service` : 'nothing is in service yet'}.</p>`),
    sheet('h-mon', 'Monitoring of everything in service', `<p>Service levels come from each product's schematic and are watched from the first canary: a fast burn of any budget rolls it back. What is watched today:</p>${table('Monitoring that runs', ['Workflow', 'Runs', 'File'], wf.map((w) => [esc(w.name), esc(w.when ?? 'on change'), code(`.github/workflows/${w.file}`)]))}<p class="small muted">The service levels the worked example is held to: ${esc(FACTS['shipping.levels']!())}.</p>`),
  ].join('\n');
}

// ---------------------------------------------------------------- shipping: the release

function shippingEvidence(f: Facts): string {
  const pack = packageTop();
  const wf = workflows();
  const ran = (file: string) => wf.find((w) => w.file === file);
  return sheet('h-rel', 'The release', `<p>Before anything is deployed it is packaged: the code, the tests, the docs and the version history become one signed release, which is published to the repository and the sites. Deploying it to production, with a person approving, is the second step, below.</p>${table('The release', ['Part of the release', 'Where it stands'], [
    ['The package', `A product's release holds ${pack.length} top-level parts: ${esc(pack.map(([k]) => k).join(' '))}`],
    ['SBOM and licences', f.has('tools/supply') ? `Checked by ${code('tools/supply')}${ran('supply-chain.yml') ? `, run by ${code('supply-chain.yml')}` : ''}` : 'Not built'],
    ['The docs', `Built from the source and checked fresh as a required check (${code('npm run docs')})`],
    ['The version history', 'Every release carries the revision it was made from'],
    ['A signed version tag', f.signedTags ? `${f.signedTags} signed` : '<strong>None yet.</strong> No signed version tag exists in the repository.'],
    ['Published to the repository and the sites', `The repository: ${code('main')}. The sites: zthr.ai, by ${code('deploy.yml')}${ran('deploy.yml')?.when ? `, ${esc(ran('deploy.yml')!.when!)} and on every push to main` : ''}.`],
    ['Products shipped by the line', f.releases ? String(f.releases) : 'None'],
  ])}`);
}

export function evidenceFor(page: string, f: Facts): string {
  if (page === 'process') return processEvidence(f);
  if (page === 'rework') return reworkEvidence(f);
  if (page === 'deployment') return deploymentEvidence(f);
  if (page === 'shipping') return shippingEvidence(f);
  throw new Error(`no evidence panels for ${page}`);
}

export const standings = (f: Facts) => standingOf(f);
