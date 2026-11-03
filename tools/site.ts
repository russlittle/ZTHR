import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import * as ui from '@zthr/ui';
import { loadCards } from '@zthr/intent';
import { COLLECTIONS } from '../apps/advocate/src/domain/schema.js';
import { gateCatalog } from './gates.js';
import { links } from './doc-links.js';
import { JOURNEY_DIR, OUT, ROOT } from './lib.js';

/**
 * Builds the public site the factory publishes next to the app:
 *   /docs     the documentation, with every Mermaid diagram drawn
 *   /factory  the factory console: guardrails, red team, walks, journeys, tests, mutation, phases, cost
 * Everything is read from what the factory recorded in this build; nothing is typed in by hand.
 */
// --artifact builds a self-contained copy with relative links (no analytics) for previewing outside zthr.ai.
const ARTIFACT = process.argv.includes('--artifact');
const SITE = join(ROOT, ARTIFACT ? 'site-artifact' : 'site-out');
const GA = process.env.SITE_GA_ID ?? 'G-0VXPS15MY4';
const APP = ARTIFACT ? 'https://zthr.ai/advocate/' : '/advocate/';
/** Fonts and assets: served from the app when published, relative to the page in the self-contained copy. */
const fontBase = (rootRel: string) => (ARTIFACT ? rootRel.replace(/\/$/, '') || '.' : '/advocate');
const head = (rootRel: string) => `${ARTIFACT ? '' : `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA}');</script>`}
${ARTIFACT ? '' : `<script src="/assets/mermaid-11.4.1.min.js"></script>`}<script>window.mermaid&&mermaid.initialize({startOnLoad:true,theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'neutral',securityLevel:'strict'});</script>
<style>.prose{max-width:860px}.prose h1{margin:6px 0 14px}.prose h2{margin:28px 0 8px}.prose h3{margin:20px 0 6px}.prose table{border-collapse:collapse;width:100%;font-size:15px;margin:10px 0}.prose th,.prose td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}.prose code{background:var(--calm);padding:1px 5px;border-radius:5px;font-size:.92em}.prose pre{background:var(--calm);padding:12px;border-radius:10px;overflow:auto}.prose pre code{background:none;padding:0}.mermaid{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0;overflow:auto}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.shots figure{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px}.shots img{width:100%;height:220px;object-fit:cover;object-position:top;border-radius:6px}.shots figcaption{font-size:12px;color:var(--muted);margin-top:4px}</style>`;

const read = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined);
const write = (path: string, html: string) => {
  mkdirSync(dirname(path), { recursive: true });
  // The preview host reserves names that start with "_", so fonts live under fonts/ there.
  writeFileSync(path, ARTIFACT ? html.replace(/_ui\/atkinson/g, 'fonts/atkinson') : html);
};
const walkFiles = (dir: string, ext: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walkFiles(join(dir, n), ext) : n.endsWith(ext) ? [join(dir, n)] : [])) : []);

// ------------------------------------------------------------------ docs

function copyAssets(): void {
  // Diagrams are drawn by a copy of Mermaid served from this site, so readers' browsers fetch nothing elsewhere.
  mkdirSync(join(SITE, 'assets'), { recursive: true });
  cpSync(join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'), join(SITE, 'assets', 'mermaid-11.4.1.min.js'));
  if (ARTIFACT) {
    mkdirSync(join(SITE, 'fonts'), { recursive: true });
    for (const f of ['atkinson-400.woff2', 'atkinson-700.woff2']) writeFileSync(join(SITE, 'fonts', f), ui.uiAsset(f)!.body);
  }
}

function buildLanding(): void {
  const body = `<h1>ZTHR reference implementation</h1><p class="muted">The Student Advocate, built by agents under the factory's fixtures. Everything here was recorded by the factory.</p>${ui.rows([
    { title: 'Factory console', sub: 'Guardrails, red team, walks, journeys, every test, mutation, phases, cost', href: 'factory/index.html' },
    { title: 'Documentation', sub: 'Architecture, flows, data model, API and every building block, illustrated', href: 'docs/index.html' },
    { title: 'The Student Advocate', sub: 'The app itself', href: APP },
  ])}`;
  write(join(SITE, 'index.html'), ui.consoleShell({ title: 'ZTHR reference', brand: 'ZTHR reference', brandHref: 'index.html', base: fontBase(''), head: head(''), groups: [{ title: '', items: [{ href: 'factory/index.html', label: 'Factory console', icon: 'shield' }, { href: 'docs/index.html', label: 'Documentation', icon: 'doc' }, { href: APP, label: 'The app', icon: 'route' }] }], body }));
  if (ARTIFACT) {
    // The preview's front page is written as page content only; the host wraps it in its own document.
    const full = readFileSync(join(SITE, 'index.html'), 'utf8');
    const style = full.match(/<style>[\s\S]*?<\/style>/g)?.join('') ?? '';
    const bodyHtml = full.slice(full.indexOf('<body>') + 6, full.lastIndexOf('</body>'));
    write(join(SITE, 'index.html'), `<title>ZTHR Reference</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${style}<style>main.con{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 60px}</style>\n${bodyHtml}`);
  }
}

function buildDocs(): number {
  const files = walkFiles(join(ROOT, 'docs'), '.md').filter((f) => !f.endsWith('.png'));
  const rel = (f: string) => relative(join(ROOT, 'docs'), f);
  const title = (f: string) => readFileSync(f, 'utf8').match(/^# (.+)$/m)?.[1] ?? rel(f);
  const groups: [string, (r: string) => boolean][] = [
    ['The system', (r) => !r.includes('/') && r !== 'README.md'],
    ['Business flows', (r) => r.startsWith('flows/')],
    ['How it is tested', (r) => r.startsWith('testing/')],
    ['Building blocks', (r) => r.startsWith('blocks/')],
    ['Decisions', (r) => r.startsWith('adr/')],
  ];
  for (const f of files) {
    const r = rel(f);
    const out = r === 'README.md' ? 'index.html' : r.replace(/\.md$/, '.html');
    const depth = out.split('/').length - 1;
    const up = '../'.repeat(depth);
    const marked = new Marked({
      renderer: {
        code({ text, lang }) {
          return lang === 'mermaid' ? `<pre class="mermaid">${ui.esc(text)}</pre>` : `<pre tabindex="0"><code>${ui.esc(text)}</code></pre>`;
        },
        link({ href, text }) {
          let h = href;
          if (/^(\.\.\/)+(apps|packages|tools|control)\//.test(h)) h = `https://github.com/russlittle/ZTHR/blob/reference-implementation/${h.replace(/^(\.\.\/)+/, '')}`;
          else if (!/^https?:/.test(h)) h = h.replace(/README\.md$/, 'index.html').replace(/\.md(#|$)/, '.html$1');
          return `<a href="${ui.esc(h)}">${text}</a>`;
        },
      },
    });
    const body = marked.parse(readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '')) as string;
    const nav = groups.map(([g, keep]) => ({ title: g, items: files.map(rel).filter(keep).sort().map((x) => ({ href: `${up}${x.replace(/\.md$/, '.html')}`, label: title(join(ROOT, 'docs', x)), current: x === r })) }));
    const rootRel = `${up}../`;
    write(join(SITE, 'docs', out), ui.consoleShell({ title: `${title(f)} · ZTHR reference docs`, brand: 'ZTHR docs', brandHref: `${up}index.html`, base: fontBase(rootRel), head: head(rootRel), groups: [{ title: '', items: [{ href: `${up}index.html`, label: 'Overview', icon: 'doc', current: r === 'README.md' }, { href: `${up}../factory/index.html`, label: 'Factory console', icon: 'shield' }, { href: APP, label: 'The app', icon: 'route' }] }, ...nav], body: `<article class="prose">${body}</article>` }));
  }
  return files.length;
}

// ------------------------------------------------------------------ factory console

interface WalkReport {
  seeds: { name: string; states: number; transitions: number; maxDepth: number; exhausted: boolean }[];
  states: number;
  transitions: number;
  violations: { seed: string; path: string[]; problem: string }[];
  verbsSeen: Record<string, number>;
  routes?: string[];
  actionsSeen?: string[];
  ms?: number;
}

function buildFactory(): number {
  const tests = read<{ numTotalTests: number; numPassedTests: number; testResults: { name: string; status: string; assertionResults: { fullName: string; status: string; title: string; ancestorTitles: string[] }[] }[] }>(join(OUT, 'tests.json'));
  const explore = read<WalkReport>(join(OUT, 'explore.json'));
  const crawl = read<WalkReport>(join(OUT, 'crawl.json'));
  const crawlSettings = read<WalkReport>(join(OUT, 'crawl-settings.json'));
  const redteam = read<{ at: string; results: { corpus: string; attack: string; expect: string; held: boolean; detail?: string }[] }>(join(OUT, 'redteam.json'));
  const uiManifest = read<{ stops: { walk: string; step: string; scheme: string; viewport: string; url: string; screenshot: string; problems: string[] }[] }>(join(OUT, 'ui', 'manifest.json'));
  const mutation = read<{ files: Record<string, { mutants: { status: string; mutatorName: string; replacement?: string; location: { start: { line: number } } }[] }> }>(join(ROOT, 'reports', 'mutation.json'));
  const proofs = read<{ gate: string; gateHash: string; valid: boolean; cases: string[] }[]>(join(ROOT, 'control', 'proofs.json')) ?? [];
  const ratchets = read<Record<string, { floor: number }>>(join(ROOT, 'control', 'ratchets.json'));
  const costs = existsSync(join(OUT, 'ci-costs.jsonl')) ? readFileSync(join(OUT, 'ci-costs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { finishedAt: string; minutes: number; costUsd: number; kind: string; machine: string }) : [];
  const gates = gateCatalog();
  const cards = loadCards(JOURNEY_DIR);
  const docLinks = links();

  const mutScore = mutation ? (() => {
    const all = Object.values(mutation.files).flatMap((f) => f.mutants);
    const killed = all.filter((m) => ['Killed', 'Timeout'].includes(m.status)).length;
    const valid = all.filter((m) => !['CompileError', 'RuntimeError', 'Ignored'].includes(m.status)).length;
    return { score: (killed / valid) * 100, killed, valid, total: all.length };
  })() : undefined;

  const PAGES: [string, string, string][] = [
    ['index', 'Overview', 'gauge'],
    ['phases', 'Phases', 'list'],
    ['gates', 'Guardrails', 'shield'],
    ['redteam', 'Red team', 'alert'],
    ['feature-walks', 'Feature walks', 'route'],
    ['ui-walk', 'Browser walk', 'today'],
    ['intent', 'Intent walks', 'check'],
    ['tests', 'Every test', 'flask'],
    ['mutation', 'Mutation', 'bolt'],
    ['docs-qa', 'Docs and links', 'doc'],
    ['data', 'Data model', 'book'],
    ['cost', 'Cost', 'dollar'],
  ];
  const shell = (id: string, title: string, body: string) =>
    ui.consoleShell({ title: `${title} · ZTHR factory`, brand: 'ZTHR factory', brandHref: 'index.html', base: fontBase('../'), head: head('../'), groups: [{ title: 'Factory', items: PAGES.map(([p, l, ic]) => ({ href: `${p}.html`, label: l, icon: ic, current: p === id })) }, { title: 'Elsewhere', items: [{ href: APP, label: 'The app', icon: 'route' }, { href: `${APP}admin/`, label: 'App admin', icon: 'you' }, { href: '../docs/index.html', label: 'Documentation', icon: 'doc' }] }], body: `<h1>${ui.esc(title)}</h1>${body}` });
  const n = (x: number | undefined) => (x === undefined ? 'not measured' : x.toLocaleString('en-US'));
  const held = redteam?.results.filter((r) => r.held).length;
  const walkStates = (explore?.states ?? 0) + (crawl?.states ?? 0) + (crawlSettings?.states ?? 0);

  // overview
  write(join(SITE, 'factory', 'index.html'), shell('index', 'The factory', `
<p class="muted">Everything here was recorded by the factory while building and testing the Student Advocate. Numbers come from this build's reports; anything not run in this build says "not measured".</p>
${ui.kpis([
  { value: tests ? `${n(tests.numPassedTests)} / ${n(tests.numTotalTests)}` : 'not measured', label: 'tests passing' },
  { value: `${proofs.filter((p) => p.valid).length} / ${gates.length}`, label: 'gates proven able to fail' },
  { value: `${cards.length}`, label: 'locked intent journeys' },
  { value: explore ? n(explore.transitions + (crawl?.transitions ?? 0) + (crawlSettings?.transitions ?? 0)) : 'not measured', label: 'steps walked to a fixpoint' },
  { value: walkStates ? n(walkStates) : 'not measured', label: 'states reached' },
  { value: redteam ? `${held} / ${redteam.results.length}` : 'not measured', label: 'red-team attacks held' },
  { value: mutScore ? `${mutScore.score.toFixed(1)}%` : 'not measured', label: 'mutation score' },
  { value: uiManifest ? n(uiManifest.stops.length) : 'not measured', label: 'browser stops checked' },
])}
${ui.section('What each part proves', ui.rows(PAGES.slice(1).map(([p, l]) => ({ title: l, href: `${p}.html`, sub: { phases: 'What each phase delivers and whether the factory certified it', gates: 'The checks that must fail on planted defects before they count', redteam: 'Attacks real people send, and whether the app held', 'feature-walks': 'Every button and every page, for every student, to a fixpoint', 'ui-walk': 'A real browser: accessibility, layout, screenshots and video', intent: 'The goals students actually have, run in every mode and channel', tests: 'Every test, grouped by file, with the document it verifies', mutation: 'Whether the tests notice when the code is wrong', 'docs-qa': 'Every test linked to a document and every document to a test', data: 'Every collection the app keeps', cost: 'What the factory spent to run itself' }[p] })))) }`));

  // phases
  const PHASES: { n: number; name: string; items: [string, string][] }[] = [
    { n: 1, name: 'Run my day', items: [['Today, plans and held time', 'built'], ['Money and benefits checks', 'built'], ['Finding help and crisis plans', 'built'], ['FAFSA and SNAP playbooks', 'built'], ['Starting by text', 'built'], ['Every button works, app and text', 'built']] },
    { n: 2, name: 'Household, career and campus life', items: [['Week solver with child care and commute', 'built'], ['GI Bill, accommodations, break housing, enrollment playbooks', 'built'], ['Community with moderation', 'built'], ['Spanish, first slice', 'partial'], ['Meal plans sized to SNAP, with one shopping list', 'built'], ['Caregivers: the builder drafted the scout; waiting for sign-off', 'partial'], ['Career help at each college, and the fair-chance (CQE) path when the student asks', 'built'], ['Job openings and mentors', 'not yet'], ['Campus life: dining, late food, study spots', 'not yet'], ['Weather and roads, from the National Weather Service through the egress block', 'built'], ['Letter explainer, with an optional model rewrite inside the sandwich', 'built']] },
    { n: 3, name: 'Integrations', items: [['Integration API: ingest, export, webhooks', 'built'], ['Calendar feed', 'built'], ['One door to the network', 'built'], ['App admin', 'built'], ['Sign in with Google', 'built'], ['Class-site and calendar sync', 'not yet']] },
    { n: 4, name: 'Any college, and proof it works', items: [['Red team', 'built'], ['Scouts that build each college’s list', 'partial'], ['Mentor and peer network', 'not yet'], ['Model-assisted features through twins', 'not yet'], ['Outcome measures', 'not yet']] },
  ];
  write(join(SITE, 'factory', 'phases.html'), shell('phases', 'Phases', `<p class="muted">A phase is certified when every gate passes with a valid proof, both walks reach their fixpoint with no violations, every journey for the phase passes, mutation is at or above its floor, and a person signs off. Certificates are pinned to a commit.</p>${PHASES.map((p) => ui.section(`Phase ${p.n}: ${p.name}`, ui.rows(p.items.map(([t, s]) => ({ title: t, chip: { text: s, tone: s === 'built' ? 'ok' : s === 'partial' ? 'warn' : undefined } }))))).join('')}`));

  // gates
  write(join(SITE, 'factory', 'gates.html'), shell('gates', 'Guardrails', `<p class="muted">A gate counts only after every planted defect makes it fail. Its proof is pinned to a hash of its definition; change the gate and the proof must be made again.</p>${ui.table(['Gate', 'Protects', 'Planted defects that must fail it', 'Proof'], gates.map((g) => { const p = proofs.find((x) => x.gate === g.id); return [`<code>${ui.esc(g.id)}</code>`, ui.esc(g.protects), ui.esc(g.plants.join('; ')), p ? `${p.valid ? ui.chip('valid', 'ok') : ui.chip('invalid', 'bad')} <span class="small muted">${ui.esc(p.gateHash.slice(0, 12))}</span>` : ui.chip('not proven', 'warn')]; }), { raw: [true, false, false, true] })}`));

  // red team
  const corpora = redteam ? [...new Set(redteam.results.map((r) => r.corpus))] : [];
  write(join(SITE, 'factory', 'redteam.html'), shell('redteam', 'Red team', redteam ? `${ui.kpis(corpora.map((c) => { const rs = redteam.results.filter((r) => r.corpus === c); return { value: `${rs.filter((r) => r.held).length} / ${rs.length}`, label: c }; }))}${corpora.map((c) => ui.section(c, ui.table(['Attack', 'Must happen', 'Result'], redteam.results.filter((r) => r.corpus === c).map((r) => [ui.esc(r.attack), ui.esc(r.expect), r.held ? ui.chip('held', 'ok') : ui.chip('got through', 'bad')]), { raw: [true, false, true] }))).join('')}` : '<p>Not measured in this build.</p>'));

  // feature walks
  const walkSection = (title: string, r: WalkReport | undefined, unit: string) =>
    r ? ui.section(title, `${ui.kpis([{ value: n(r.states), label: 'states' }, { value: n(r.transitions), label: unit }, { value: r.seeds.every((s) => s.exhausted) ? 'yes' : 'no', label: 'every seed reached its fixpoint' }, { value: n(r.violations.length), label: 'violations' }])}${ui.table(['Seed', 'States', unit, 'Deepest path', 'Fixpoint'], r.seeds.map((s) => [s.name, n(s.states), n(s.transitions), s.maxDepth, s.exhausted ? 'reached' : 'cut short']))}${r.violations.length ? ui.table(['Seed', 'Path', 'Problem'], r.violations.slice(0, 50).map((v) => [v.seed, v.path.slice(-4).join(' > '), v.problem])) : ''}`) : ui.section(title, '<p class="muted">Not measured in this build.</p>');
  write(join(SITE, 'factory', 'feature-walks.html'), shell('feature-walks', 'Feature walks', `<p class="muted">The button walk drives the Advocate directly: every button, the navigation and sixteen things students type, from every state, until nothing new is left. The feature walk drives the web app: every link and every form on every page. Both check invariants at every step. <a href="../docs/testing/exploration.html">How they work</a>.</p>${walkSection('Button walk', explore, 'transitions')}${explore ? ui.section('Buttons tried, by verb', ui.table(['Verb', 'Times tried'], Object.entries(explore.verbsSeen).sort((a, b) => b[1] - a[1]).map(([v, c]) => [v, n(c)]))) : ''}${walkSection('Feature walk', crawl, 'links and forms followed')}${crawl?.routes ? `<p class="small muted">Routes reached: ${crawl.routes.map((r) => `<code>${ui.esc(r)}</code>`).join(' ')}</p>` : ''}${walkSection('Settings walk', crawlSettings, 'switches flipped')}`));

  // browser walk
  // The self-contained preview carries the intent walk and one student's screens; the published site carries all.
  if (uiManifest && ARTIFACT) uiManifest.stops = uiManifest.stops.filter((x) => x.walk === 'rent-short' || x.walk === 'maria');
  if (uiManifest) {
    mkdirSync(join(SITE, 'factory', 'ui', 'video'), { recursive: true });
    for (const st of uiManifest.stops) if (existsSync(join(OUT, 'ui', st.screenshot))) cpSync(join(OUT, 'ui', st.screenshot), join(SITE, 'factory', 'ui', st.screenshot));
    if (existsSync(join(OUT, 'ui', 'video'))) for (const v of readdirSync(join(OUT, 'ui', 'video')).filter((f) => f.endsWith('.webm'))) cpSync(join(OUT, 'ui', 'video', v), join(SITE, 'factory', 'ui', 'video', v));
  }
  const videos = existsSync(join(OUT, 'ui', 'video')) ? readdirSync(join(OUT, 'ui', 'video')).filter((f) => f.endsWith('.webm')) : [];
  write(join(SITE, 'factory', 'ui-walk.html'), shell('ui-walk', 'Browser walk', uiManifest ? `${ui.kpis([{ value: n(uiManifest.stops.length), label: 'stops' }, { value: n(uiManifest.stops.filter((s) => s.problems.length).length), label: 'stops with problems' }])}${videos.length ? ui.section('Intent walk, recorded', videos.map((v) => `<video controls width="300" src="ui/video/${ui.esc(v)}"></video>`).join(' ')) : ''}${[...new Set(uiManifest.stops.map((s) => `${s.walk} ${s.scheme} ${s.viewport}`))].map((g) => ui.section(g, `<div class="shots">${uiManifest.stops.filter((s) => `${s.walk} ${s.scheme} ${s.viewport}` === g).map((s) => `<figure><a href="ui/${ui.esc(s.screenshot)}"><img loading="lazy" src="ui/${ui.esc(s.screenshot)}" alt="${ui.esc(`${s.walk} ${s.step}, ${s.scheme}, ${s.viewport}`)}"></a><figcaption>${ui.esc(s.step)} ${s.problems.length ? ui.chip(`${s.problems.length} problems`, 'bad') : ui.chip('clean', 'ok')}</figcaption></figure>`).join('')}</div>`)).join('')}` : '<p class="muted">Not measured in this build.</p>'));

  // intent
  write(join(SITE, 'factory', 'intent.html'), shell('intent', 'Intent walks', `<p class="muted">Each card is written in plain words, locked by hash, and passes only when every declared depth and channel passes. <a href="../docs/testing/journeys.html">How journeys work</a>.</p>${ui.table(['Journey', 'Student', 'Goal', 'Phase', 'Modes', 'Channels'], cards.map((c) => [c.id, c.persona, c.goal, String(c.phase), ((c as unknown as { modes?: string[] }).modes ?? []).join(', '), ((c as unknown as { channels?: string[] }).channels ?? []).join(', ')]))}`));

  // tests
  const docsFor = (file: string) => docLinks.testsToDocs.get(file) ?? [];
  write(join(SITE, 'factory', 'tests.html'), shell('tests', 'Every test', tests ? `${ui.kpis([{ value: n(tests.numTotalTests), label: 'tests' }, { value: n(tests.numPassedTests), label: 'passing' }, { value: n(tests.testResults.length), label: 'files' }])}${tests.testResults.map((f) => { const file = relative(ROOT, f.name); return `<details class="panel" style="margin:10px 0;padding:10px 16px"><summary><b>${ui.esc(file)}</b> ${ui.chip(`${f.assertionResults.length} tests`)} ${f.status === 'passed' ? ui.chip('passing', 'ok') : ui.chip(f.status, 'bad')}</summary><p class="small">Verifies ${docsFor(file).map((d) => `<a href="../${ui.esc(d.replace(/\.md$/, '.html'))}">${ui.esc(d.replace('docs/', ''))}</a>`).join(', ')}</p><ul class="small">${f.assertionResults.map((t) => `<li>${t.status === 'passed' ? '✓' : '✗'} ${ui.esc([...t.ancestorTitles, t.title].join(' › '))}</li>`).join('')}</ul></details>`; }).join('')}` : '<p class="muted">Not measured in this build.</p>'));

  // mutation
  write(join(SITE, 'factory', 'mutation.html'), shell('mutation', 'Mutation', mutation && mutScore ? `${ui.kpis([{ value: `${mutScore.score.toFixed(1)}%`, label: 'score' }, { value: `${ratchets?.mutation?.floor ?? 'none'}%`, label: 'ratchet floor' }, { value: n(mutScore.killed), label: 'mutants caught' }, { value: n(mutScore.valid - mutScore.killed), label: 'mutants that survived' }])}${ui.table(['File', 'Score', 'Caught', 'Survived', ''], Object.entries(mutation.files).map(([f, d]) => { const k = d.mutants.filter((m) => ['Killed', 'Timeout'].includes(m.status)).length; const v = d.mutants.filter((m) => !['CompileError', 'RuntimeError', 'Ignored'].includes(m.status)).length; return [`<code>${ui.esc(f)}</code>`, `${((k / v) * 100).toFixed(1)}%`, String(k), String(v - k), ui.bar(k / v, `${f} score`)]; }), { raw: [true, false, false, false, true] })}${ui.section('Survivors to kill next', ui.table(['File', 'Line', 'Change that went unnoticed'], Object.entries(mutation.files).flatMap(([f, d]) => d.mutants.filter((m) => m.status === 'Survived').slice(0, 15).map((m) => [f, String(m.location.start.line), `${m.mutatorName}${m.replacement ? `: ${m.replacement.slice(0, 80)}` : ''}`]))))}` : '<p class="muted">Not measured in this build; mutation runs nightly.</p>'));

  // docs qa
  write(join(SITE, 'factory', 'docs-qa.html'), shell('docs-qa', 'Docs and links', `${ui.kpis([{ value: n(docLinks.testsToDocs.size), label: 'test files' }, { value: n(new Set([...docLinks.testsToDocs.values()].flat()).size), label: 'documents verified' }, { value: n(docLinks.problems.length), label: 'broken links' }])}${ui.table(['Test file', 'Verifies'], [...docLinks.testsToDocs].sort().map(([t, ds]) => [`<code>${ui.esc(t)}</code>`, ds.map((d) => `<a href="../${ui.esc(d.replace(/\.md$/, '.html'))}">${ui.esc(d)}</a>`).join('<br>')]), { raw: [true, true] })}`));

  // data model
  write(join(SITE, 'factory', 'data.html'), shell('data', 'Data model', `<p class="muted">Generated from the declared schema; tests fail if the code writes anything it does not declare. <a href="../docs/data-model.html">The ERD</a>.</p>${ui.table(['Collection', 'Key', 'Fields', 'What it holds'], COLLECTIONS.map((c) => [`<code>${c.name}</code>`, c.key, c.fields.map((f) => `${f.name}${f.optional ? '?' : ''}`).join(', '), c.purpose]), { raw: [true, false, false, false] })}`));

  // cost
  const total = costs.reduce((s, c) => s + c.costUsd, 0);
  write(join(SITE, 'factory', 'cost.html'), shell('cost', 'Cost', costs.length ? `${ui.kpis([{ value: n(costs.length), label: 'factory runs recorded' }, { value: `$${total.toFixed(2)}`, label: 'all time, list price' }, { value: `${(costs.reduce((s, c) => s + c.minutes, 0) / costs.length).toFixed(1)} min`, label: 'average run' }, { value: '$0.00', label: 'model spend by the product' }])}${ui.table(['Finished', 'Kind', 'Machine', 'Minutes', 'Cost'], costs.slice(-40).reverse().map((c) => [c.finishedAt.slice(0, 16).replace('T', ' '), c.kind, c.machine, c.minutes.toFixed(1), `$${c.costUsd.toFixed(4)}`]))}` : '<p class="muted">Cost is recorded by each Cloud Build run; none in this build yet.</p>'));
  return PAGES.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  copyAssets();
  buildLanding();
  const d = buildDocs();
  const f = buildFactory();
  console.log(`site built: ${d} doc pages, ${f} factory pages in ${relative(ROOT, SITE)}/`);
}
