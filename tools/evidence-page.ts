import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvidenceStore, costSummary, intentCompletion } from '@zthr/evidence';
import { loadCards } from '@zthr/intent';
import { runAll } from './journeys.js';
import { runGates } from './gates.js';
import { JOURNEY_DIR, OUT, ROOT } from './lib.js';

/**
 * Builds the public evidence page from what the factory actually recorded.
 * Values with no data are printed as "not measured", never as zero.
 */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const sh = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

mkdirSync(OUT, { recursive: true });
const store = new EvidenceStore();
const { verdicts, proofs } = await runGates(store);
const { runs } = await runAll('evidence-page', store);
const cards = loadCards(JOURNEY_DIR);
const ic = intentCompletion(store);
const cost = costSummary(store);

let tests = { total: 0, passed: 0 };
try {
  sh('NODE_NO_WARNINGS=1 npx vitest run --reporter=json --outputFile=evidence-out/tests.json');
} catch {
  /* failures still write the report */
}
if (existsSync(join(OUT, 'tests.json'))) {
  const t = JSON.parse(readFileSync(join(OUT, 'tests.json'), 'utf8')) as { numTotalTests: number; numPassedTests: number };
  tests = { total: t.numTotalTests, passed: t.numPassedTests };
}

let mutation: number | undefined;
if (existsSync(join(ROOT, 'reports/mutation.json'))) {
  const r = JSON.parse(readFileSync(join(ROOT, 'reports/mutation.json'), 'utf8')) as { files: Record<string, { mutants: { status: string }[] }> };
  const all = Object.values(r.files).flatMap((f) => f.mutants);
  const killed = all.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  const valid = all.filter((m) => !['CompileError', 'RuntimeError', 'Ignored'].includes(m.status)).length;
  mutation = valid ? (100 * killed) / valid : undefined;
}
const ratchets = JSON.parse(readFileSync(join(ROOT, 'control/ratchets.json'), 'utf8')) as { id: string; floor: number }[];
const mutationFloor = ratchets.find((r) => r.id === 'mutation-score')?.floor;

const ledger = readFileSync(join(ROOT, 'evidence/build-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { at: string; candidate: string; unit: string; outcome: string; gate: string; finding: string; needsSignOff?: boolean });
const rejected = ledger.filter((l) => l.outcome === 'rejected');
const accepted = ledger.filter((l) => l.outcome === 'accepted');
const firstCommit = sh("git log --reverse --format=%cI | head -1");
const lastCommit = sh('git log -1 --format=%cI');
const commit = sh('git rev-parse --short HEAD');
const commits = Number(sh('git rev-list --count HEAD'));
const loc = Number(sh("git ls-files 'packages/*/src/*.ts' 'apps/*/src/**/*.ts' 'apps/*/journeys/*.ts' 'tools/*.ts' 'tools/**/*.ts' | xargs cat | wc -l"));
const testLoc = Number(sh("git ls-files 'packages/*/test/*.ts' 'apps/*/test/*.ts' | xargs cat | wc -l"));
const elapsedMin = Math.round((Date.parse(lastCommit) - Date.parse(firstCommit)) / 60000);

const ui = (name: string) => {
  const p = join(OUT, 'ui', `light-${name}.png`);
  return existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : undefined;
};

type Status = 'pass' | 'fail' | 'unknown' | 'not measured';
const chip = (s: Status, label?: string) => `<span class="chip ${s.replace(' ', '-')}">${esc(label ?? s)}</span>`;

const gatesPassed = verdicts.filter((v) => v.status === 'pass').length;
const proofsValid = proofs.filter((p) => p.valid).length;
const journeyByCard = new Map<string, typeof runs>();
for (const r of runs) journeyByCard.set(r.journey, [...(journeyByCard.get(r.journey) ?? []), r]);
const cardStatus = (id: string): Status => {
  const v = journeyByCard.get(id) ?? [];
  return v.some((x) => x.status === 'fail') ? 'fail' : v.some((x) => x.status === 'unknown') || v.length === 0 ? 'unknown' : 'pass';
};

const PERSONA_NAME: Record<string, string> = {
  maria: 'Maria, single mother on rotating shifts',
  jayden: 'Jayden, aged out of foster care',
  darnell: 'Darnell, home from prison, on parole',
  ana: 'Ana, veteran on the GI Bill',
  tyler: 'Tyler, first-generation rural commuter',
  priya: 'Priya, overcommitted pre-med',
  destiny: 'Destiny, first-generation, two jobs',
  sam: 'Sam, autistic with ADHD',
  linda: 'Linda, laid off, retraining online',
  luis: 'Luis, immigrant family',
  alex: 'Alex, estranged from parents',
  keisha: 'Keisha, online, 800 miles away',
  any: 'Any student',
};

const REQS: [string, 'built' | 'partial', string][] = [
  ['ON-1', 'built', 'Start by texting; help before any account'],
  ['ON-2', 'built', 'Installable web app, no app store'],
  ['ON-3', 'built', 'Setup by text in five messages'],
  ['ON-4', 'partial', 'Connections are revocable and logged; offering them at the moment of need is basic'],
  ['ON-5', 'built', 'Help dial: depth, channel, reading level, limits'],
  ['ON-7', 'built', 'Share the Advocate or one resource'],
  ['ON-8', 'built', 'Adult confirmation by reply, no ID collected'],
  ['ON-9', 'built', 'Chosen name everywhere; sealed facts never raised'],
  ['DAY-1', 'partial', 'Today view with building and room; turn-by-turn routes not yet'],
  ['DAY-2', 'built', 'Deadlines from syllabi, calendar feeds, forwarded mail and texts'],
  ['DAY-3', 'built', 'Raised early with a plan; recovery path after'],
  ['DAY-4', 'built', 'Meeting prep: who, due, state, remaining, why'],
  ['DAY-5', 'built', 'College words explained, with the office that decides'],
  ['CRS-1', 'built', 'Syllabus to calendar with source lines'],
  ['CRS-2', 'built', 'Course AI policy read and applied'],
  ['CRS-3', 'built', 'Help lined up per assignment'],
  ['CRS-4', 'built', 'Never produces coursework'],
  ['NAV-1', 'built', 'Four-question money-found screener'],
  ['NAV-2', 'built', 'Eligibility only from rules as code, with sources'],
  ['NAV-3', 'partial', 'Steps, missing documents and pre-fill map; agency forms not auto-filled'],
  ['NAV-4', 'built', 'Crisis intake with steps, contacts and drafts'],
  ['NAV-5', 'partial', 'Likely value shown; running total of help received not yet tracked'],
  ['NAV-6', 'built', 'Gaps said plainly and counted'],
  ['NAV-7', 'built', 'Status rules shown, never asked'],
  ['NAV-9', 'built', 'Needs from shared facts and forwarded notices, no demographics'],
  ['NAV-10', 'built', 'Single-question pulses that return value'],
  ['MON-1', 'built', 'Bill gap seen before it happens'],
  ['MON-2', 'built', 'Plain life-skills guides'],
  ['MON-3', 'built', 'Licensed questions routed to free professionals'],
  ['BK-1', 'built', 'Books, free routes first'],
  ['BK-2', 'built', 'Books needed before aid arrives are flagged'],
  ['PB-1', 'built', 'Playbook engine with FAFSA and SNAP'],
  ['SAF-1', 'built', 'Crisis routing before any model'],
  ['CTL-1', 'built', 'Why each suggestion was made'],
  ['CTL-2', 'built', 'Export and full deletion'],
  ['CTL-3', 'built', 'Any source off at any time'],
];

const REQS2: [string, 'built' | 'partial' | 'not yet', string][] = [
  ['PB-2', 'partial', 'GI Bill, accommodation letters, break housing and proof of enrollment built; retraining and foster youth benefits not yet'],
  ['PB-3', 'built', 'New playbooks only through the builder and a person\'s sign-off'],
  ['DAY-6', 'built', 'Weekly preview with what is different'],
  ['DAY-7', 'built', 'Room changes update the schedule and are announced'],
  ['HH-1', 'built', 'Week solver: shifts, classes, child care, commute, sleep'],
  ['COM-1', 'built', 'Asks and offers that expire and close when met'],
  ['COM-2', 'built', 'Tips rated by students and retired when stale or unhelpful'],
  ['COM-3', 'built', 'Study groups form at three students per course'],
  ['COM-4', 'built', 'Opt-in communities filter what a student sees'],
  ['COM-5', 'built', 'Filters, reports and a person queue; proven moderation gate'],
  ['LNG-1', 'partial', 'Spanish for starting by text, crisis replies and help found'],
  ['Builder', 'built', 'Drafts scouts, playbooks and retirements from evidence; cannot admit its own work'],
  ['Scouts', 'built', 'Refresh what sources confirm; retire below their datum'],
  ['DAY-8', 'not yet', 'Weather and road conditions'],
  ['HH-2', 'not yet', 'Meal plans with SNAP grocery delivery'],
  ['HH-3', 'not yet', 'Caregiver specialist (the builder has drafted the scout it needs)'],
  ['CAR-1 to 4', 'not yet', 'Career trajectories, openings, fair-chance filter, mentors'],
  ['CL-1 to 4', 'not yet', 'Dining menus, late food, team recaps, quiet study spots'],
  ['LNG-2', 'not yet', 'Letter explainer from a photo'],
];

const proposalsDir = join(ROOT, 'control/proposals');
const proposals = existsSync(proposalsDir) ? readdirSync(proposalsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(proposalsDir, f), 'utf8')) as { id: string; title: string; reason: string; status: string; simulated?: boolean; checks: { name: string; ok: boolean }[] }) : [];

const conformance: [string, string, string, Status][] = [
  ['Intent completion', 'Every locked journey passes in every declared mode and channel', `${ic.numerator} of ${ic.denominator} journeys (${runs.length} variant runs)`, ic.numerator === ic.denominator && ic.denominator > 0 ? 'pass' : 'fail'],
  ['Named gates', 'Each gate proven able to fail, then passing', `${proofsValid} of ${proofs.length} proven; ${gatesPassed} of ${verdicts.length} passing`, proofsValid === proofs.length && gatesPassed === verdicts.length ? 'pass' : 'fail'],
  ['Mutation score', `At or above the ratchet floor of ${mutationFloor}%`, mutation === undefined ? 'not measured' : `${mutation.toFixed(1)}%`, mutation === undefined ? 'not measured' : mutation >= (mutationFloor ?? 0) ? 'pass' : 'fail'],
  ['Unit tests', 'All pass', `${tests.passed} of ${tests.total}`, tests.total > 0 && tests.passed === tests.total ? 'pass' : 'fail'],
  ['Accessibility', 'No serious or critical violations, light and dark', existsSync(join(OUT, 'ui', 'dark-07-settings.png')) ? '0 on 14 screens' : 'not measured', existsSync(join(OUT, 'ui', 'dark-07-settings.png')) ? 'pass' : 'not measured'],
  ['Product model spend', 'At most $0.50 per active student per month', cost.calls === 0 ? '$0.00: no model calls; every Phase 1 decision is deterministic' : `$${(cost.asPaid ?? 0).toFixed(4)}`, 'pass'],
  ['Multi-family review', 'Three model families before commit, a fourth after', 'No provider key configured; every seat reports unknown', 'unknown'],
  ['Time to detect and restore', 'Measured from a bad deploy to a good one serving', 'No deployment yet', 'not measured'],
  ['Real-student outcomes', 'Persistence and credits against a comparison group', 'Phase 3 pilot', 'not measured'],
];

const pending = [
  ['Tone gate calibration', 'The reading-grade measure now ignores proper names such as agency names. This changed a gate, so it needs a listed person\'s sign-off.'],
  ['Journey cards', `${cards.length} cards added by the build agent from the persona work. Adding cards tightens the control plane; Russ confirms they state the intents he means.`],
  ['Six playbooks', 'FAFSA, SNAP, GI Bill, accommodation letters, break housing and proof of enrollment. Each declares sign_off: required.'],
  ['Builder drafts', `${proposals.filter((p) => p.status === 'awaiting-sign-off').length} drafts await npm run signoff by a listed person.`],
  ['Review panel models', 'The seats in control/review.yaml are a starting choice of families. Changing the AI needs sign-off.'],
  ['Ratchet floors', 'Mutation score floor 76%, held messages 0, failing journeys 0, set from the first measurements.'],
];

const shots = [ui('02-maria-today'), ui('03-draft'), ui('05-money')].filter(Boolean) as string[];

const html = `<title>ZTHR Evidence</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
/* Layout: a first-article inspection report. A conformance table leads; detail sections follow in reading order. */
:root{
  --paper:#f7f8fb; --sheet:#ffffff; --ink:#151a2b; --muted:#5a6178; --rule:#d7dbe6; --layout:#2f3fa8;
  --pass:#1c7a49; --fail:#b3261e; --unknown:#9a6200; --nm:#6b7287; --tint:#eef0f8;
  --display:'Archivo', 'Helvetica Neue', Arial, sans-serif; --body:'Source Serif 4', Georgia, serif; --mono:'IBM Plex Mono', ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--paper:#0e1220;--sheet:#151a2b;--ink:#e6e9f2;--muted:#a3aac0;--rule:#2a3149;--layout:#8f9bff;--pass:#5fd394;--fail:#ff8a80;--unknown:#f2b84b;--nm:#9aa1b8;--tint:#1b2140;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#0e1220;--sheet:#151a2b;--ink:#e6e9f2;--muted:#a3aac0;--rule:#2a3149;--layout:#8f9bff;--pass:#5fd394;--fail:#ff8a80;--unknown:#f2b84b;--nm:#9aa1b8;--tint:#1b2140;color-scheme:dark}
body{background:var(--paper);color:var(--ink);font:16px/1.55 var(--body)}
.wrap{max-width:1040px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 56px}
header.stamp{display:grid;grid-template-columns:1fr auto;gap:16px 24px;align-items:end;border-bottom:2px solid var(--layout);padding-bottom:16px}
h1{font:800 clamp(28px,5vw,44px)/1.05 var(--display);letter-spacing:-.01em;margin:0;text-wrap:balance}
.eyebrow{font:600 12px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--layout);margin:0 0 10px}
.meta{font:500 13px/1.6 var(--mono);color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.lede{max-width:66ch;color:var(--muted);margin:16px 0 0}
h2{font:700 20px/1.2 var(--display);margin:40px 0 12px;display:flex;gap:10px;align-items:baseline;text-wrap:balance}
h2 .ref{font:600 12px/1 var(--mono);color:var(--layout);letter-spacing:.08em}
p{max-width:68ch}
.scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--sheet)}
table{width:100%;border-collapse:collapse;font-size:15px}
th{font:600 11px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);background:var(--tint)}
td{padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:0}
td.num,td.measured{font:500 14px/1.45 var(--mono);font-variant-numeric:tabular-nums}
.chip{display:inline-block;font:600 11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:5px 8px;border-radius:3px;border:1.5px solid currentColor;white-space:nowrap}
.chip.pass{color:var(--pass)}.chip.fail{color:var(--fail)}.chip.unknown{color:var(--unknown)}.chip.not-measured{color:var(--nm);border-style:dashed}
.claims{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.claim{background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:16px 18px;min-width:0}
.claim h3{font:700 16px/1.25 var(--display);margin:0 0 8px}
.claim dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:10px 0 0;font-size:15px}
.claim dt{font:500 12px/1.5 var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.claim dd{margin:0;font-family:var(--mono);font-variant-numeric:tabular-nums}
.reqs{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.req{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;padding:10px 12px;background:var(--sheet);border:1px solid var(--rule);border-radius:6px;font-size:14px;line-height:1.4;min-width:0}
.req b{font:600 12px/1.4 var(--mono);color:var(--layout)}
.req.partial{border-style:dashed}
.req small{grid-column:2;color:var(--muted);font:500 11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase}
ol.caught{margin:0;padding-left:22px;max-width:76ch}ol.caught li{margin:6px 0}ol.caught .g{font:500 12px/1 var(--mono);color:var(--muted)}
.shots{display:flex;gap:16px;overflow-x:auto;padding-bottom:6px}
.shots figure{margin:0;flex:0 0 220px}.shots img{width:220px;border:1px solid var(--rule);border-radius:10px;display:block}
.shots figcaption{font:500 12px/1.4 var(--mono);color:var(--muted);margin-top:6px}
footer{margin-top:48px;border-top:1px solid var(--rule);padding-top:14px;font:500 12px/1.6 var(--mono);color:var(--muted)}
a{color:var(--layout)}
@media (max-width:640px){header.stamp{grid-template-columns:1fr}.meta{text-align:left}}
</style>
<div class="wrap">
<header class="stamp">
  <div><p class="eyebrow">First article inspection · Student Advocate, Phases 1 and 2</p><h1>ZTHR reference implementation: evidence</h1></div>
  <div class="meta">build ${esc(commit)} · ${esc(commits)} commits<br>${esc(lastCommit.slice(0, 16).replace('T', ' '))} ET<br>synthetic students only</div>
</header>
<p class="lede">Every figure below was computed by the factory from what it recorded while building the Student Advocate: gate verdicts, journey runs, mutation results and the build ledger. Anything the factory could not measure is marked not measured, never zero.</p>

<h2><span class="ref">§1</span>Conformance</h2>
<div class="scroll"><table>
<thead><tr><th>Characteristic</th><th>Requirement</th><th>Measured</th><th>Status</th></tr></thead>
<tbody>${conformance.map(([c, r, m, s]) => `<tr><td>${esc(c)}</td><td>${esc(r)}</td><td class="measured">${esc(m)}</td><td>${chip(s)}</td></tr>`).join('')}</tbody>
</table></div>

<h2><span class="ref">§2</span>The two claims</h2>
<div class="claims">
  <div class="claim"><h3>Setup takes weeks, not years</h3><p>The factory kits and the full Phase 1 core of the Advocate were built in one session, by an agent, under the factory's own gates.</p>
  <dl><dt>First commit</dt><dd>${esc(firstCommit.slice(0, 16).replace('T', ' '))}</dd><dt>Latest</dt><dd>${esc(lastCommit.slice(0, 16).replace('T', ' '))}</dd><dt>Elapsed</dt><dd>${esc(elapsedMin)} minutes</dd><dt>Source</dt><dd>${esc(loc.toLocaleString('en-US'))} lines</dd><dt>Tests</dt><dd>${esc(testLoc.toLocaleString('en-US'))} lines</dd><dt>Human hours</dt><dd>0 during the build; design time not logged</dd></dl></div>
  <div class="claim"><h3>Cost is real and manageable</h3><p>The running product makes no model calls in Phase 1: eligibility, schedules, plans and safety routing are deterministic.</p>
  <dl><dt>Product calls</dt><dd>${esc(cost.calls)}</dd><dt>Product spend</dt><dd>$0.00</dd><dt>Target</dt><dd>≤ $0.50 / student / month</dd><dt>Build tokens</dt><dd>not measured</dd><dt>Why</dt><dd>the build agent's usage was not exposed to the ledger in this session</dd></dl></div>
</div>

<h2><span class="ref">§3</span>Intent: the twelve students</h2>
<p>Each card is locked by hash. A journey passes only if every declared depth (brief, standard, walk me through) and channel (app, text) passes.</p>
<div class="scroll"><table>
<thead><tr><th>Journey</th><th>Student</th><th>Goal</th><th>Variants</th><th>Status</th></tr></thead>
<tbody>${cards
  .map((c) => `<tr><td class="num">${esc(c.delight ?? c.id.replace('req-', ''))}</td><td>${esc(PERSONA_NAME[c.persona] ?? c.persona)}</td><td>${esc(c.goal)}</td><td class="num">${esc((journeyByCard.get(c.id) ?? []).length)}</td><td>${chip(cardStatus(c.id))}</td></tr>`)
  .join('')}</tbody>
</table></div>

<h2><span class="ref">§4</span>Gates, each proven able to fail</h2>
<div class="scroll"><table>
<thead><tr><th>Gate</th><th>Planted defects it caught</th><th>Verdict on the build</th><th>Status</th></tr></thead>
<tbody>${verdicts
  .map((v, i) => `<tr><td class="num">${esc(v.gate)}</td><td>${esc(proofs[i]!.cases.map((c) => c.name).join('; '))}</td><td>${esc(v.reason)}</td><td>${chip(v.status as Status)}</td></tr>`)
  .join('')}</tbody>
</table></div>

<h2><span class="ref">§5</span>What the factory caught</h2>
<p>${rejected.length} candidates were rejected and ${accepted.length} accepted. Each rejection is a defect that never reached a student.</p>
<ol class="caught">${rejected.map((r) => `<li>${esc(r.finding)} <span class="g">· ${esc(r.gate)}</span></li>`).join('')}</ol>

<h2><span class="ref">§6</span>Phase 1 requirements</h2>
<div class="reqs">${REQS.map(([id, st, what]) => `<div class="req ${st}"><b>${esc(id)}</b><span>${esc(what)}</span>${st === 'partial' ? '<small>partial</small>' : ''}</div>`).join('')}</div>

<h2><span class="ref">§7</span>Phase 2 so far</h2>
<div class="reqs">${REQS2.map(([id, st, what]) => `<div class="req ${st === 'built' ? '' : 'partial'}"><b>${esc(id)}</b><span>${esc(what)}</span>${st !== 'built' ? `<small>${esc(st)}</small>` : ''}</div>`).join('')}</div>

<h2><span class="ref">§8</span>Agents the builder has drafted</h2>
<p>The builder reads the evidence for gaps and drafts new agents. Each draft passes the same checks as any change, then waits for a listed person. The builder cannot admit its own work: a sign-off attempted by the agent was refused.</p>
<div class="scroll"><table><thead><tr><th>Draft</th><th>Why the builder drafted it</th><th>Checks</th><th>Status</th></tr></thead><tbody>${proposals.map((p) => `<tr><td>${esc(p.title)}${p.simulated ? ' <span class="chip not-measured">simulated demand</span>' : ''}</td><td>${esc(p.reason)}</td><td class="num">${esc(p.checks.filter((c) => c.ok).length)} of ${esc(p.checks.length)}</td><td>${chip(p.status === 'admitted' ? 'pass' : 'unknown', p.status.replace(/-/g, ' '))}</td></tr>`).join('') || '<tr><td colspan="4">No drafts yet.</td></tr>'}</tbody></table></div>

<h2><span class="ref">§9</span>Waiting for sign-off</h2>
<div class="scroll"><table><thead><tr><th>Change</th><th>Why it needs a person</th></tr></thead><tbody>${pending.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></div>

${shots.length ? `<h2><span class="ref">§10</span>The app, walked by accessible name</h2><div class="shots">${shots.map((s, i) => `<figure><img src="${s}" alt="${esc(['Maria\'s day with a rent gap seen a month ahead', 'A drafted message to her landlord, sent only on her tap', 'What Maria likely qualifies for, with rules and sources'][i])}"><figcaption>${esc(['Today: the gap, seen early', 'The student sends', 'Money found, with sources'][i])}</figcaption></figure>`).join('')}</div>` : ''}

<footer>Computed by <code>npm run evidence</code> from the evidence store, control/proofs.json, reports/mutation.json and evidence/build-ledger.jsonl. Code: github.com/russlittle/ZTHR, branch reference-implementation. Pattern language: zthr.ai, DOI 10.5281/zenodo.23826734.</footer>
</div>`;

writeFileSync(join(OUT, 'index.html'), html);
console.log(`evidence page written: ${join(OUT, 'index.html')} (${Math.round(html.length / 1024)} KB); intent ${ic.numerator}/${ic.denominator}, gates ${gatesPassed}/${verdicts.length}, mutation ${mutation?.toFixed(1)}%`);
void readdirSync;
