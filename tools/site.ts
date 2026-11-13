import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import * as ui from '@zthr/ui';
import { loadCards } from '@zthr/intent';
import { COLLECTIONS } from '../apps/advocate/src/domain/schema.js';
import { gateCatalog } from './gates.js';
import { parse as parseYaml } from 'yaml';
import { SERVICES, SERVICE_IDS } from '../apps/campus-services/src/index.js';
import { links } from './doc-links.js';
import { JOURNEY_DIR, OUT, ROOT, headCommit } from './lib.js';
import { loadFeatures } from './features.js';
import { sources } from './sources.js';
import { erd } from '@zthr/store';
import { EvidenceStore } from '@zthr/evidence';
import { NOT_AFFILIATED, productPage } from '../apps/advocate/src/server/product.js';
import { createApp } from '../apps/advocate/src/server/app.js';
import { Advocate } from '../apps/advocate/src/agents/advocate.js';

/**
 * Builds the public site the factory publishes next to the app:
 *   /docs     the documentation, with every Mermaid diagram drawn
 *   /factory  the factory console: guardrails, red team, walks, journeys, tests, mutation, phases, cost
 * Everything is read from what the factory recorded in this build; nothing is typed in by hand.
 */
// --artifact builds a self-contained copy with relative links (no analytics) for previewing outside zthr.ai.
// --static builds the same relative-link copy with analytics, for zthr.ai/reference on the static site host.
const ARTIFACT = process.argv.includes('--artifact');
const STATIC = process.argv.includes('--static');
const RELATIVE = ARTIFACT || STATIC;
const SITE = join(ROOT, ARTIFACT ? 'site-artifact' : STATIC ? 'site-static' : 'site-out');
const GA = process.env.SITE_GA_ID ?? 'G-12ENZ47TSG';
const APP = ARTIFACT ? 'https://zthr.ai/studentadvocate/' : '/studentadvocate/';
/** Fonts and assets: served from the app when published, relative to the page in the self-contained copies. */
const fontBase = (rootRel: string) => (RELATIVE ? rootRel.replace(/\/$/, '') || '.' : '/advocate');
const head = (rootRel: string) => `${ARTIFACT ? '' : `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA}');</script>`}
${ARTIFACT ? '' : `<script src="${STATIC ? rootRel : '/'}assets/mermaid.min.js"></script>`}${ARTIFACT ? '' : `<script src="${STATIC ? rootRel : '/'}assets/figures.js" defer></script>`}
<style>.prose{max-width:860px}.prose h1{margin:6px 0 14px}.prose h2{margin:28px 0 8px}.prose h3{margin:20px 0 6px}.prose table{border-collapse:collapse;width:100%;font-size:15px;margin:10px 0}.prose th,.prose td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}.prose code{background:var(--calm);padding:1px 5px;border-radius:5px;font-size:.92em}.prose pre{background:var(--calm);padding:12px;border-radius:10px;overflow:auto}.prose pre code{background:none;padding:0}.mermaid{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0;overflow:auto}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.shots figure{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px}.shots img{width:100%;height:220px;object-fit:cover;object-position:top;border-radius:6px}.shots figcaption{font-size:12px;color:var(--muted);margin-top:4px}</style>`;

const read = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined);
/**
 * zthr.ai strips trailing slashes, so a folder's page is served at /reference/factory, not /reference/factory/, and
 * a browser would resolve its relative links one folder too high. Each published page therefore names its own
 * folder, and its in-page links name the page's own address.
 */
export function anchorToPublished(html: string, rel: string): string {
  const dir = dirname(rel) === '.' ? '' : dirname(rel).split(sep).join('/');
  const name = basename(rel, '.html');
  const page = `/reference${dir ? `/${dir}` : ''}${name === 'index' ? '' : `/${name}`}`;
  return html.replace('<head>', `<head><base href="/reference/${dir ? `${dir}/` : ''}">`).replace(/href="#([^"]+)"/g, `href="${page}#$1"`);
}
const write = (path: string, html: string) => {
  mkdirSync(dirname(path), { recursive: true });
  // The preview host reserves names that start with "_", so fonts live under fonts/ there.
  let out = RELATIVE ? html.replace(/_ui\/(atkinson|bricolage)/g, 'fonts/$1') : html;
  if (STATIC && path.startsWith(SITE) && path.endsWith('.html')) out = anchorToPublished(out, relative(SITE, path));
  writeFileSync(path, out);
};
const walkFiles = (dir: string, ext: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walkFiles(join(dir, n), ext) : n.endsWith(ext) ? [join(dir, n)] : [])) : []);

// ------------------------------------------------------------------ docs

function copyAssets(): void {
  // Diagrams are drawn by a copy of Mermaid served from this site, so readers' browsers fetch nothing elsewhere.
  mkdirSync(join(SITE, 'assets'), { recursive: true });
  cpSync(join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'), join(SITE, 'assets', 'mermaid.min.js'));
  // Diagrams and tables: fit the column, restack on phones, and carry full screen, copy and print controls.
  cpSync(join(ROOT, 'tools/site-assets/figures.js'), join(SITE, 'assets', 'figures.js'));
  // The paths the app serves, read from its own router, so every link into the app from the published site can be
  // checked against the real route table rather than a copy of it. Middleware wildcards are not pages.
  const appRoutes = [...new Set(createApp(new Advocate(), { base: '/studentadvocate' }).routes.filter((r) => ['GET', 'ALL'].includes(r.method) && !r.path.endsWith('*')).map((r) => r.path))].sort();
  writeFileSync(join(SITE, 'app-routes.json'), `${JSON.stringify({ base: '/studentadvocate', routes: appRoutes, prefixes: ['/twins'] }, null, 1)}\n`);
  if (RELATIVE) {
    mkdirSync(join(SITE, 'fonts'), { recursive: true });
    for (const f of ['atkinson-400.woff2', 'atkinson-700.woff2', 'bricolage.woff2']) writeFileSync(join(SITE, 'fonts', f), ui.uiAsset(f)!.body);
  }
}

function buildLanding(): void {
  const gaHead = ARTIFACT ? '' : `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA}');</script>`;
  // zthr.ai/advocate: the product page, with links that work from the site root.
  if (STATIC) writeFileSync(join(ROOT, 'site-static.advocate.html'), productPage({ app: '/studentadvocate', docs: '/reference/docs/index.html', factory: '/reference/factory/index.html', factoryPage: (p) => `/reference/factory/${p}.html`, admin: '/studentadvocate/admin/', fontBase: '/reference', head: gaHead, live: false }).replace(/_ui\/(atkinson|bricolage)/g, 'fonts/$1'));
  // zthr.ai/reference: the map. One page that shows every surface, what each is for, and how they link.
  const card = (title: string, sub: string, href: string) => ({ title, sub, href });
  const Z = (p: string) => `https://zthr.ai${p}`;
  const diagram = `flowchart LR
  subgraph app[Student Advocate]
    product[About the app] --> use[Use the app]
    use --- admin[App admin]
  end
  subgraph factory[Factory]
    evidence[Evidence] --- docs[Docs]
    docs --- case[The case]
  end
  zthr[ZTHR: the pattern language] -- built with --> factory
  factory -- builds and checks every change to --> app
  classDef a fill:#eeedfd,stroke:#5145e8,color:#14152b
  classDef d fill:#e9e8fc,stroke:#2e2a72,color:#14152b
  classDef f fill:#e2f0f4,stroke:#0b6680,color:#12202a
  class product,use a
  class admin d
  class evidence,docs,case f`;
  const body = `<h1>Map: how it fits together</h1><p class="muted">The Student Advocate is the reference application for ZTHR. Two kinds of surface sit side by side, each with its own color: the app itself, which students and staff use, and the factory, which built it and checks every change. The bar at the top of every page links all of them.</p>
<pre class="mermaid">${ui.esc(diagram)}</pre>
${ui.section('Student Advocate: the app', ui.rows([card('About the app', 'What it does, who it is for, why it can be trusted, what it is worth', Z('/advocate')), card('Use the app', 'Sign in as any of twelve sample students; each visitor gets a private copy for two hours', Z('/studentadvocate/')), card('Use the app by text', 'The whole Advocate as a text conversation', Z('/studentadvocate/text')), card('App admin', 'Catalog, moderation, scouts, admissions and outcome measures; never a student\'s record', Z('/studentadvocate/admin/')), card('Campus twins', 'The synthetic dining, transit, rooms, jobs and class-site services the app talks to', Z('/twins'))]))}
${ui.section('Factory: how it was built and checked', ui.rows([card('The case', 'What an AI factory can build, and what it is worth: the business and technical write-up', 'case.html'), card('Evidence', 'Every gate, walk, test, mutation score and trace from the latest build', 'factory/index.html'), card('Phases', 'What each phase delivers and whether it is certified', 'factory/phases.html'), card('Features', 'Everything the app does, with the journey that proves it', 'factory/features.html'), card('Sensitive data trace', 'Where each personal fact may go, and where it went', 'factory/sensitive.html'), card('Block library', 'The reusable parts, each with its own tests and mutation score', 'factory/blocks.html'), card('Docs', 'Architecture, flows, data model, data sources, security, API and glossary', 'docs/index.html')]))}
${ui.section('Source and discussion', ui.rows([card('The full source', 'The app, the blocks, the gates, the pipeline and every journey card, on GitHub', 'https://github.com/russlittle/ZTHR/tree/reference-implementation'), card('Discussion', 'Questions, experience reports and objections, in the open', 'https://github.com/russlittle/ZTHR/discussions'), card('ZTHR', 'The pattern language this was built with', Z('/'))]))}
<p class="small muted" style="margin-top:32px">${ui.esc(NOT_AFFILIATED.body)}</p>`;
  write(join(SITE, 'index.html'), ui.consoleShell({ title: 'Map · Student Advocate and ZTHR', brand: 'Map', brandHref: 'index.html', base: fontBase(''), head: head(''), theme: 'factory', surface: 'map', groups: [{ title: 'Start with', items: [{ href: 'case.html', label: 'The case', icon: 'doc' }, { href: Z('/studentadvocate/'), label: 'Use the app', icon: 'route' }, { href: 'factory/index.html', label: 'Evidence', icon: 'shield' }] }], body }));
  if (STATIC) {
    // The host strips trailing slashes, so /reference is served from a file of that name beside the folder; its links resolve inside /reference/.
    writeFileSync(join(ROOT, 'site-static.entry.html'), readFileSync(join(SITE, 'index.html'), 'utf8'));
  }
  if (ARTIFACT) {
    // The preview's front page is written as page content only; the host wraps it in its own document.
    const full = readFileSync(join(SITE, 'index.html'), 'utf8');
    const style = full.match(/<style>[\s\S]*?<\/style>/g)?.join('') ?? '';
    const bodyHtml = full.slice(full.indexOf('<body>') + 6, full.lastIndexOf('</body>'));
    write(join(SITE, 'index.html'), `<title>ZTHR Reference</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${style}<style>main.con{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 60px}</style>\n${bodyHtml}`);
  }
}

/** The case: what the factory built and what it is worth, as one readable page beside the evidence it cites. */
function buildCase(): void {
  const src = join(ROOT, 'writeups', 'the-case.md');
  if (!existsSync(src)) return;
  const marked = new Marked({
    renderer: {
      code({ text, lang }) {
        return lang === 'mermaid' ? `<pre class="mermaid">${ui.esc(text)}</pre>` : `<pre tabindex="0"><code>${ui.esc(text)}</code></pre>`;
      },
    },
  });
  const body = marked.parse(readFileSync(src, 'utf8')) as string;
  const title = readFileSync(src, 'utf8').match(/^# (.+)$/m)![1]!;
  const css = `article.case{max-width:860px;margin:0 auto;padding:8px max(16px,env(safe-area-inset-right,0px)) 80px max(16px,env(safe-area-inset-left,0px))}
article.case h1{font-size:clamp(30px,4.4vw,46px);line-height:1.08;letter-spacing:-.02em;text-wrap:balance;margin:18px 0 14px}
article.case h1+p{font-size:19px;color:var(--muted)}
article.case h2{font-size:26px;margin:44px 0 10px;text-wrap:balance}
article.case p,article.case li{max-width:70ch}
article.case table{border-collapse:collapse;width:100%;font-size:15.5px;margin:14px 0;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow)}
article.case th,article.case td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
article.case th{font-size:13px;color:var(--muted);background:var(--calm)}
article.case thead:has(th:empty){display:none}
article.case .mermaid{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;margin:16px 0;overflow:auto;box-shadow:var(--shadow)}
article.case code{background:var(--calm);padding:1px 5px;border-radius:5px}
`;
  write(join(SITE, 'case.html'), ui.bareShell({ theme: 'factory', surface: 'case', title: `${title} · ZTHR`, description: 'The Student Advocate, built entirely by AI agents under ZTHR fixtures: what it does, why it can be trusted, how the factory works, what it costs and what it could mean.', base: fontBase(''), head: `${head('')}<style>${css}</style>`, body: `<main id="main"><article class="case">${body}</article></main>` }));
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
    write(join(SITE, 'docs', out), ui.consoleShell({ title: `${title(f)} · Docs · ZTHR factory`, brand: 'Docs', brandHref: `${up}index.html`, base: fontBase(rootRel), head: head(rootRel), theme: 'factory', surface: 'docs', groups: [{ title: '', items: [{ href: `${up}index.html`, label: 'Docs home', icon: 'doc', current: r === 'README.md' }] }, ...nav], body: `<article class="prose">${body}</article>` }));
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

let HEAD_ = '';
function buildFactory(): number {
  const tests = read<{ numTotalTests: number; numPassedTests: number; testResults: { name: string; status: string; assertionResults: { fullName: string; status: string; title: string; ancestorTitles: string[] }[] }[] }>(join(OUT, 'tests.json'));
  const explore = read<WalkReport>(join(OUT, 'explore.json'));
  const crawl = read<WalkReport>(join(OUT, 'crawl.json'));
  const crawlSettings = read<WalkReport>(join(OUT, 'crawl-settings.json'));
  const redteam = read<{ at: string; results: { corpus: string; attack: string; expect: string; held: boolean; detail?: string }[] }>(join(OUT, 'redteam.json'));
  const uiManifest = read<{ stops: { walk: string; step: string; scheme: string; viewport: string; url: string; screenshot: string; problems: string[]; review?: number }[] }>(join(OUT, 'ui', 'manifest.json'));
  const deep = read<{ controls: number; maxDepth: number; screens: number; byDepth: Record<string, number>; visits: { student: string; depth: number; from: string; control: string; to: string; problems: string[] }[] }>(join(OUT, 'deep', 'deep.json'));
  const words = read<{ views: number; pages: number; problems: string[] }>(join(OUT, 'words', 'words.json'));
  const load = read<{ at: string; visitors: number; seconds: number; requests: number; perSecond: number; p50: number; p95: number; p99: number; max: number; errors: number; budgetP95: number; byPath: Record<string, { requests: number; p50: number; p95: number }> }>(join(OUT, 'load.json'));
  const mutation = read<{ files: Record<string, { mutants: { status: string; mutatorName: string; replacement?: string; location: { start: { line: number } } }[] }> }>(join(ROOT, 'reports', 'mutation.json'));
  const proofs = read<{ gate: string; gateHash: string; valid: boolean; cases: string[] }[]>(join(ROOT, 'control', 'proofs.json')) ?? [];
  const ratchetList = read<{ id: string; floor: number }[]>(join(ROOT, 'control', 'ratchets.json')) ?? [];
  const ratchets = { mutation: ratchetList.find((r) => r.id === 'mutation-score') };
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

  // The console's menu, in buckets: what was built, how it is kept safe, how it is verified, what it is made of.
  const NAV: { title: string; pages: [string, string, string][] }[] = [
    { title: 'The build', pages: [['index', 'Summary', 'gauge'], ['phases', 'Phases', 'list'], ['features', 'Features', 'check'], ['patterns', 'The 33 patterns', 'list']] },
    { title: 'Safety', pages: [['gates', 'Guardrails', 'shield'], ['redteam', 'Red team', 'alert'], ['sensitive', 'Sensitive data trace', 'you']] },
    { title: 'QA verification', pages: [['feature-walks', 'Feature walks', 'route'], ['ui-walk', 'Browser walk', 'today'], ['intent', 'Intent walks', 'check'], ['accessibility', 'Accessibility', 'you'], ['robustness', 'Robustness and load', 'bolt'], ['tests', 'Every test', 'flask'], ['mutation', 'Mutation', 'bolt'], ['docs-qa', 'Docs and links', 'doc']] },
    { title: 'Parts and data', pages: [['blocks', 'Block library', 'list'], ['data', 'Data model', 'book'], ['sources', 'Data sources', 'book'], ['twins', 'Campus twins', 'bus']] },
    { title: 'Operations', pages: [['cost', 'Cost', 'dollar']] },
  ];
  const PAGES = NAV.flatMap((g) => g.pages);
  const shell = (id: string, title: string, body: string) =>
    ui.consoleShell({ title: `${title} · Evidence · ZTHR factory`, brand: 'Evidence', brandHref: 'index.html', base: fontBase('../'), head: head('../'), theme: 'factory', surface: 'evidence', groups: NAV.map((g) => ({ title: g.title, items: g.pages.map(([p, l, ic]) => ({ href: `${p}.html`, label: l, icon: ic, current: p === id })) })), body: `<h1>${ui.esc(title)}</h1>${body}` });
  const n = (x: number | undefined) => (x === undefined ? 'not measured' : x.toLocaleString('en-US'));
  const held = redteam?.results.filter((r) => r.held).length;
  const walkStates = (explore?.states ?? 0) + (crawl?.states ?? 0) + (crawlSettings?.states ?? 0);

  // accessibility: the statement and its evidence
  {
    const app = uiManifest?.stops.filter((x) => x.walk !== 'site') ?? [];
    const site = uiManifest?.stops.filter((x) => x.walk === 'site') ?? [];
    const clean = (xs: typeof app) => xs.filter((x) => !x.problems.length).length;
    write(join(SITE, 'factory', 'accessibility.html'), shell('accessibility', 'Accessibility', `<p class="muted">The Student Advocate is built to meet WCAG 2.2 at level AA and to work with screen readers. This page is the conformance statement, and the evidence from this build behind it. <a href="../docs/accessibility.html">How it is built and tested</a>.</p>
${ui.readings([
  { label: 'App screens with no WCAG 2.2 A or AA violation', value: uiManifest ? clean(app) : undefined, of: app.length || undefined, floor: app.length || undefined, note: 'Five students, every screen, phone and desktop, light and dark, reflow at 320 px, and a shared link', words: { pass: 'Conforms', fail: 'Fails' } },
  { label: 'Docs and evidence pages with no violation', value: uiManifest && site.length ? clean(site) : undefined, of: site.length || undefined, floor: site.length || undefined, words: { pass: 'Conforms', fail: 'Fails' } },
  { label: 'Checks left for a person to review', value: uiManifest ? app.reduce((n, x) => n + (x.review ?? 0), 0) : undefined, note: 'What axe cannot decide by itself, mostly contrast over the soft gradient. That case is computed instead: every text color is held to 4.5:1 over the strongest point of every color field, in both themes (packages/ui/test/contrast.test.ts)' },
])}
${ui.section('What is checked at every stop', ui.table(['WCAG 2.2', 'How'], [
  ['1.1.1, 4.1.2 Names, roles and values', 'axe, and the accessibility tree: every link, button, field, checkbox and image has a name'],
  ['1.3.1, 2.4.6 Structure, headings and labels', 'One level-1 heading, no skipped levels, a main region, every field labelled'],
  ['1.4.3, 1.4.11 Contrast', 'axe, in light and dark themes'],
  ['1.4.10 Reflow', 'Every screen at 320 CSS pixels, with no sideways scroll'],
  ['1.4.12 Text spacing', 'The spacing override applied; nothing cut off'],
  ['2.1.1, 2.4.7 Keyboard and focus', 'Every control reached by Tab, with a visible focus ring'],
  ['2.4.11 Focus not obscured', 'At each tab stop, nothing drawn over the focused control'],
  ['2.5.8 Target size', 'axe, and 44 px for buttons and tabs'],
  ['3.1.1 Language', 'Each page states its language'],
]))}
${ui.section('Known limits', '<ul><li>Automated checks cover what a machine can decide. Manual testing with NVDA, JAWS, VoiceOver and TalkBack by people who use them every day is the next step and is not yet done.</li><li>Spanish covers starting by text, finding help and crisis replies; other screens are in English (on the register).</li><li>Diagrams on the docs pages have text equivalents in the tables beside them.</li></ul>')}
${uiManifest ? ui.section('Every stop', ui.table(['Where', 'Theme and width', 'Result'], [...app, ...site].map((x) => [`${x.walk} ${x.step}`, `${x.scheme}, ${x.viewport}`, x.problems.length ? ui.chip(x.problems.join('; ').slice(0, 120), 'bad') : ui.chip('conforms', 'ok')]), { raw: [false, false, true] })) : '<p class="muted">Not measured in this build.</p>'}`));
    write(join(SITE, 'factory', 'robustness.html'), shell('robustness', 'Robustness and load', `<p class="muted">Generated input, campus services failing on purpose, a restore of the whole app, and many visitors at once. <a href="../docs/testing/robustness.html">How it works and what it found</a>.</p>
${load ? ui.readings([
  { label: 'Requests answered under 500', value: load.requests - load.errors, of: load.requests, floor: load.requests, note: `${load.visitors} visitors for ${load.seconds} seconds, ${load.perSecond} requests a second`, words: { pass: 'Held', fail: 'Errors' } },
  { label: 'Median response', value: load.p50, note: 'milliseconds' },
  { label: '95th percentile', value: load.p95, of: load.budgetP95, ceiling: load.budgetP95, note: `milliseconds; the budget is ${load.budgetP95}`, words: { pass: 'Within budget', fail: 'Over budget' } },
  { label: '99th percentile', value: load.p99, note: 'milliseconds' },
]) : '<p class="muted">The load test runs in the pipeline after the browser walk; not measured in this build.</p>'}
${load ? ui.section('By screen', ui.table(['Screen', 'Requests', 'Median ms', '95th percentile ms'], Object.entries(load.byPath).map(([k, v]) => [k, n(v.requests), String(v.p50), String(v.p95)]))) : ''}
${ui.section('Generated input and failing services', ui.table(['Check', 'Result'], (tests?.testResults.find((f) => f.name.endsWith('robustness.test.ts'))?.assertionResults ?? []).map((t) => [[...t.ancestorTitles.slice(-1), t.title].join(': '), t.status === 'passed' ? ui.chip('passed', 'ok') : ui.chip(t.status, 'bad')]), { raw: [false, true] }))}`));
  }

  // overview
  write(join(SITE, 'factory', 'index.html'), shell('index', 'Evidence: summary', `
<p class="muted">Everything here was recorded by the factory while building and testing the Student Advocate. Numbers come from this build's reports; anything not run in this build says "not measured".</p>
${ui.readings([
  { label: 'Tests passing', href: 'tests.html', value: tests?.numPassedTests, of: tests?.numTotalTests, floor: tests?.numTotalTests },
  { label: 'Gates proven able to fail', href: 'gates.html', value: proofs.filter((p) => p.valid).length, of: gates.length, floor: gates.length },
  { label: 'Red-team attacks held', href: 'redteam.html', value: held, of: redteam?.results.length, floor: redteam?.results.length },
  { label: 'Mutation score', href: 'mutation.html', value: mutScore ? Number(mutScore.score.toFixed(1)) : undefined, of: 100, floor: ratchets?.mutation?.floor, unit: '%', note: ratchets?.mutation?.floor ? `floor ${ratchets.mutation.floor}%, only rises` : undefined },
  { label: 'Browser stops with no problems', href: 'ui-walk.html', value: uiManifest ? uiManifest.stops.filter((x) => !x.problems.length).length : undefined, of: uiManifest?.stops.length, floor: uiManifest?.stops.length },
  { label: 'Controls clicked, to depth', href: 'ui-walk.html#deep', value: deep ? deep.visits.filter((v) => !v.problems.length).length : undefined, of: deep?.controls, floor: deep?.controls },
  { label: 'Locked intent journeys', href: 'intent.html', value: cards.length },
  { label: 'Steps walked', href: 'feature-walks.html', value: explore ? explore.transitions + (crawl?.transitions ?? 0) + (crawlSettings?.transitions ?? 0) : undefined, note: 'across every student, to a fixpoint where noted' },
  { label: 'States reached', href: 'feature-walks.html', value: walkStates || undefined },
])}
${NAV.map((g) => ui.section(g.title, ui.rows(g.pages.filter(([p]) => p !== 'index').map(([p, l]) => ({ title: l, href: `${p}.html`, sub: ({ features: 'Everything the app does, by phase, with the journey that proves it', sensitive: 'Every personal and sensitive field, where it may go, and where a planted canary actually went', blocks: 'The reusable parts this app is built from, each with its own tests and mutation score', sources: 'Every outside source the app reads, with an ERD of what each returns', phases: 'What each phase delivers and whether the factory certified it', gates: 'The checks that must fail on planted defects before they count', redteam: 'Attacks real people send, and whether the app held', 'feature-walks': 'Every button and every page, for every student, to a fixpoint', 'ui-walk': 'A real browser: accessibility, layout, screenshots and video', intent: 'The goals students actually have, run in every mode and channel', tests: 'Every test, grouped by file, with the document it verifies', mutation: 'Whether the tests notice when the code is wrong', 'docs-qa': 'Every test linked to a document and every document to a test', data: 'Every collection the app keeps', cost: 'What the factory spent to run itself', twins: 'The campus services the Advocate talks to, and their contracts', patterns: 'All 33 patterns, where each lives and what proves it' } as Record<string, string>)[p] }))))).join('')}`));

  // phases
  const PHASES = loadFeatures().map((p) => ({ n: p.n, name: p.name, items: p.features.map((f) => [f.name, f.status] as [string, string]) }));
  const certs = read<{ phase: number; commit: string; at: string; certified: boolean; checks: { check: string; status: string; detail: string }[] }[]>(join(OUT, 'certificates.json')) ?? [];
  const certFor = (n: number) => {
    const c = certs.find((x) => x.phase === n);
    if (!c) return '<p class="small muted">No certificate in this build.</p>';
    return `<p>${c.certified ? ui.chip(`certified at ${c.commit}`, 'ok') : ui.chip(`not certified at ${c.commit}`, 'warn')}</p>${ui.table(['Check', 'Result', 'Detail'], c.checks.map((k) => [ui.esc(k.check), k.status === 'pass' ? ui.chip('pass', 'ok') : k.status === 'fail' ? ui.chip('fail', 'bad') : ui.chip('not measured', 'warn'), ui.esc(k.detail)]), { raw: [false, true, false] })}`;
  };
  write(join(SITE, 'factory', 'phases.html'), shell('phases', 'Phases', `<p class="muted">A phase is certified when every gate passes with a valid proof, both walks reach their fixpoint with no violations, every journey for the phase passes, and mutation is at or above its floor. No person signs a feature; people govern the gates themselves. Certificates are pinned to a commit.</p>${PHASES.map((p) => ui.section(`Phase ${p.n}: ${p.name}`, `${certFor(p.n)}${ui.rows(p.items.map(([t, s]) => ({ title: t, chip: { text: s, tone: s === 'built' ? 'ok' : s === 'partial' ? 'warn' : undefined } })))}`)).join('')}`));

  // gates
  write(join(SITE, 'factory', 'gates.html'), shell('gates', 'Guardrails', `<p class="muted">A gate counts only after every planted defect makes it fail. Its proof is pinned to a hash of its definition; change the gate and the proof must be made again.</p>${ui.table(['Gate', 'Protects', 'Planted defects that must fail it', 'Proof'], gates.map((g) => { const p = proofs.find((x) => x.gate === g.id); return [`<code>${ui.esc(g.id)}</code>`, ui.esc(g.protects), ui.esc(g.plants.join('; ')), p ? `${p.valid ? ui.chip('valid', 'ok') : ui.chip('invalid', 'bad')} <span class="small muted">${ui.esc(p.gateHash.slice(0, 12))}</span>` : ui.chip('not proven', 'warn')]; }), { raw: [true, false, false, true] })}`));

  // red team
  const corpora = redteam ? [...new Set(redteam.results.map((r) => r.corpus))] : [];
  write(join(SITE, 'factory', 'redteam.html'), shell('redteam', 'Red team', redteam ? `${ui.kpis(corpora.map((c) => { const rs = redteam.results.filter((r) => r.corpus === c); return { value: `${rs.filter((r) => r.held).length} / ${rs.length}`, label: c }; }))}${corpora.map((c) => ui.section(c, ui.table(['Attack', 'Must happen', 'Result'], redteam.results.filter((r) => r.corpus === c).map((r) => [ui.esc(r.attack), ui.esc(r.expect), r.held ? ui.chip('held', 'ok') : ui.chip('got through', 'bad')]), { raw: [true, false, true] }))).join('')}` : '<p>Not measured in this build.</p>'));

  // feature walks
  const HEAD = headCommit();
  HEAD_ = HEAD;
  const measuredAt = (r: WalkReport & { commit?: string; carried?: { from: string; reason: string }; students?: Record<string, { commit: string; carried: boolean }> }) => (r.commit === HEAD && r.students ? `<p class="small">${ui.chip(`${Object.keys(r.students).length} of 12 students covered at ${HEAD}`, Object.keys(r.students).length === 12 ? 'ok' : 'warn')} ${Object.values(r.students).filter((x) => x.carried).length} carried forward from earlier full walks that still hold; ${Object.values(r.students).filter((x) => !x.carried).length} walked at this commit.</p>` : r.commit === HEAD && r.carried ? `<p class="small">${ui.chip(`carried forward to ${HEAD}`, 'ok')} Walked at ${ui.esc(r.carried.from.slice(0, 7))}; ${ui.esc(r.carried.reason)}.</p>` : r.commit === HEAD ? `<p class="small">${ui.chip(`measured at ${HEAD}`, 'ok')}</p>` : `<p class="small">${ui.chip(r.commit ? `measured at ${r.commit}, an earlier commit` : 'measured at an earlier commit', 'warn')} The walk for this commit has not finished.</p>`);
  const walkSection = (title: string, r: WalkReport | undefined, unit: string) =>
    r ? ui.section(title, `${measuredAt(r)}${ui.kpis([{ value: n(r.states), label: 'states' }, { value: n(r.transitions), label: unit }, { value: r.seeds.every((s) => s.exhausted) ? 'yes' : 'no', label: 'every seed reached its fixpoint' }, { value: n(r.violations.length), label: 'violations' }])}${ui.table(['Seed', 'States', unit, 'Deepest path', 'Fixpoint'], r.seeds.map((s) => [s.name, n(s.states), n(s.transitions), s.maxDepth, s.exhausted ? 'reached' : 'cut short']))}${r.violations.length ? ui.table(['Seed', 'Path', 'Problem'], r.violations.slice(0, 50).map((v) => [v.seed, v.path.slice(-4).join(' > '), v.problem])) : ''}`) : ui.section(title, '<p class="muted">Not measured in this build.</p>');
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
  const deepSection = () =>
    `<section id="deep">${ui.section(
      'Every control, clicked, to depth',
      deep
        ? `<p>Each student's Today screen, then every link and button on it, then every one on each screen those lead to, down to ${deep.maxDepth} levels. After each click: the screen loaded, has one heading, shows no programming artifacts, logged no browser errors, and the control did something.</p>${ui.kpis([{ value: n(deep.controls), label: 'controls clicked' }, { value: n(deep.maxDepth), label: 'deepest level' }, { value: n(deep.visits.filter((v) => v.problems.length).length), label: 'controls with problems' }])}${ui.table(['Level', 'Controls clicked'], Object.entries(deep.byDepth).map(([d, c]) => [d, n(c)]), { caption: 'Controls clicked at each level' })}`
        : '<p class="muted">Not measured in this build.</p>',
    )}${deep && deep.visits.some((v) => v.problems.length) ? ui.section('Controls with problems', ui.table(['Student', 'Level', 'From', 'Control', 'Problem'], deep.visits.filter((v) => v.problems.length).map((v) => [v.student, String(v.depth), v.from, v.control, v.problems.join('; ')]))) : ''}${ui.section('Whole words', words ? `<p>${n(words.views)} page views (${n(words.pages)} pages at two widths in two themes); ${n(words.problems.length)} with a word split across lines.</p>${words.problems.length ? `<ul>${words.problems.map((p) => `<li>${ui.esc(p)}</li>`).join('')}</ul>` : ''}` : '<p class="muted">Not measured in this build.</p>')}</section>`;
  write(join(SITE, 'factory', 'ui-walk.html'), shell('ui-walk', 'Browser walk', `${uiManifest ? `${ui.kpis([{ value: n(uiManifest.stops.length), label: 'stops' }, { value: n(uiManifest.stops.filter((s) => s.problems.length).length), label: 'stops with problems' }])}${videos.length ? ui.section('Intent walk, recorded', videos.map((v) => `<video controls width="300" src="ui/video/${ui.esc(v)}"></video>`).join(' ')) : ''}${[...new Set(uiManifest.stops.map((s) => `${s.walk} ${s.scheme} ${s.viewport}`))].map((g) => ui.section(g, `<div class="shots">${uiManifest.stops.filter((s) => `${s.walk} ${s.scheme} ${s.viewport}` === g).map((s) => `<figure><a href="ui/${ui.esc(s.screenshot)}"><img loading="lazy" src="ui/${ui.esc(s.screenshot)}" alt="${ui.esc(`${s.walk} ${s.step}, ${s.scheme}, ${s.viewport}`)}"></a><figcaption>${ui.esc(s.step)} ${s.problems.length ? ui.chip(`${s.problems.length} problems`, 'bad') : ui.chip('clean', 'ok')}</figcaption></figure>`).join('')}</div>`)).join('')}` : '<p class="muted">Not measured in this build.</p>'}${deepSection()}`));

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
  // twins
  const contract = read<{ at: string; results: { service: string; probe: string; path: string; ok: boolean; problems: string[] }[] }>(join(OUT, 'contract.json'));
  write(
    join(SITE, 'factory', 'twins.html'),
    shell(
      'twins',
      'Campus twins',
      `<p class="muted">Synthetic services shaped like a college's vendors. The Advocate reaches them only through its egress door, and each is held to a contract: ${contract ? `${contract.results.filter((r) => r.ok).length} of ${contract.results.length} probes pass` : 'not measured in this build'}. <a href="../docs/blocks/campus-services.html">How they work</a>. Try them: <a href="https://zthr.ai/twins">zthr.ai/twins</a>.</p>
${SERVICE_IDS.map((id) => { const sv = SERVICES[id]; const probes = (contract?.results ?? []).filter((r) => r.service === id); return ui.section(`${sv.info.title}`, `<p class="small muted"><code>${ui.esc(sv.host)}</code> · ${ui.esc(sv.info.description)}</p>${ui.table(['Endpoint', 'What it answers'], sv.info.endpoints.map((e) => [`<code>${ui.esc(e.method)} ${ui.esc(e.path)}</code>`, ui.esc(e.summary)]), { raw: [true, false] })}${Object.keys(sv.info.scenarios).length ? `<p class="small">Bad-day scenarios: ${Object.entries(sv.info.scenarios).map(([k, v]) => `<code>${ui.esc(k)}</code> ${ui.esc(v)}`).join('; ')}</p>` : ''}${probes.length ? ui.table(['Contract probe', 'Request', 'Result'], probes.map((r) => [ui.esc(r.probe), `<code>${ui.esc(r.path)}</code>`, r.ok ? ui.chip('meets contract', 'ok') : ui.chip(r.problems.join('; '), 'bad')]), { raw: [false, true, true] }) : ''}`); }).join('')}`,
    ),
  );

  // patterns
  const pmap = parseYaml(readFileSync(join(ROOT, 'control', 'patterns.yaml'), 'utf8')) as { patterns: { n: number; name: string; implemented_in: string[]; verified_by: string[]; gate?: string }[] };
  const GH = 'https://github.com/russlittle/ZTHR/blob/reference-implementation/';
  write(
    join(SITE, 'factory', 'patterns.html'),
    shell(
      'patterns',
      'The 33 patterns',
      `<p class="muted">Every pattern in the ZTHR pattern language, where this build implements it, and what proves it. The <code>pattern-coverage</code> gate fails if any is missing. <a href="../docs/testing/patterns.html">The map, explained</a>.</p>${ui.table(['#', 'Pattern', 'Implemented in', 'Proven by', 'Gate'], pmap.patterns.map((p) => [String(p.n), ui.esc(p.name), p.implemented_in.map((f) => `<a href="${GH}${ui.esc(f)}"><code>${ui.esc(f)}</code></a>`).join('<br>'), p.verified_by.map((f) => `<a href="${GH}${ui.esc(f)}"><code>${ui.esc(f.split('/').pop()!)}</code></a>`).join('<br>'), p.gate ? (proofs.find((x) => x.gate === p.gate)?.valid ? ui.chip(p.gate, 'ok') : ui.chip(p.gate, 'warn')) : '']), { raw: [false, false, true, true, true] })}`,
    ),
  );

  // features
  const journeyRuns: { journey: string; status: string }[] = existsSync(join(OUT, 'evidence.db')) ? new EvidenceStore(join(OUT, 'evidence.db')).events('journey_run').map((e) => ({ journey: e.subject, status: String(e.data.status) })) : [];
  const jStatus = (id: string) => journeyRuns.filter((r) => r.journey === id).pop()?.status ?? 'not measured';
  const phasesF = loadFeatures();
  write(join(SITE, 'factory', 'features.html'), shell('features', 'Features', `<p class="muted">Everything the Student Advocate does, declared once in <code>control/features.yaml</code>, with the locked journeys that prove each feature. <a href="../docs/features.html">The features document</a>.</p>${ui.kpis([{ value: String(phasesF.flatMap((p) => p.features).length), label: 'features' }, { value: String(phasesF.flatMap((p) => p.features).filter((f) => f.status === 'built').length), label: 'built' }, { value: String(phasesF.flatMap((p) => p.features).filter((f) => f.status !== 'built').length), label: 'partial or not measured' }, { value: String(cards.length), label: 'journeys proving them' }])}${phasesF.map((p) => ui.section(`Phase ${p.n}: ${p.name}`, ui.table(['Feature', 'What it does', 'Status', 'Proven by'], p.features.map((f) => [`<b>${ui.esc(f.name)}</b>`, ui.esc(f.what), ui.chip(f.status, f.status === 'built' ? 'ok' : 'warn'), f.journeys.map((j) => `${ui.esc(j)} ${journeyRuns.length ? ui.chip(jStatus(j), jStatus(j) === 'pass' ? 'ok' : jStatus(j) === 'fail' ? 'bad' : 'warn') : ''}`).join('<br>') || '<span class="muted">tests and gates</span>']), { raw: [true, false, true, true] }))).join('')}`));

  // sensitive data trace
  const tr = read<{ at: string; commit?: string; canaries: { field: string; cls: string }[]; findings: { field: string; sink: string; allowed: boolean }[]; leaks: { field: string; sink: string }[]; unexercised: string[]; sealedNowhere: string[]; sinks: string[]; policy: Record<string, string[]> }>(join(OUT, 'sensitive-trace.json'));
  write(join(SITE, 'factory', 'sensitive.html'), shell('sensitive', 'Sensitive data trace', tr ? `<p class="muted">A unique marker was planted in every personal, sensitive and secret field. A student then used the app by text, on the web and through the API, sent a mentor introduction and registered a webhook. Every place data can land was searched for every marker. <a href="../docs/flows/sensitive-data.html">How it works, and every field's class</a>.</p>${tr.commit ? `<p class="small">${ui.chip(`measured at ${tr.commit}`, tr.commit === HEAD_ ? 'ok' : 'warn')}</p>` : ''}${ui.kpis([{ value: String(tr.canaries.length), label: 'markers planted' }, { value: String(tr.findings.length), label: 'sightings, all checked' }, { value: String(tr.leaks.length), label: 'leaks' }, { value: String(tr.sealedNowhere.length), label: 'sealed facts and secrets seen nowhere' }])}${ui.section('Where each marker turned up', `<div style="overflow-x:auto" tabindex="0" role="region" aria-label="Where each marker turned up, by field and place">${ui.table(['Field', 'Class', ...tr.sinks], tr.canaries.map((c) => [`<code>${ui.esc(c.field)}</code>`, ui.chip(c.cls, c.cls === 'secret' ? 'bad' : c.cls === 'sensitive' ? 'warn' : undefined), ...tr.sinks.map((k) => { const f = tr.findings.find((x) => x.field === c.field && x.sink === k); return f ? (f.allowed ? '<span title="allowed">✓</span>' : ui.chip('leak', 'bad')) : '<span class="muted">·</span>'; })]), { raw: [true, true, ...tr.sinks.map(() => true)] })}</div><p class="small muted">✓ the marker was found there and its class may go there. · not found. A leak fails the <code>sensitive-data</code> gate.</p>`)}${ui.section('Where each class may go', ui.table(['Place', 'Personal', 'Sensitive', 'Secret'], tr.sinks.map((k) => [ui.esc(k), tr.policy.personal!.includes(k) ? 'yes' : 'no', tr.policy.sensitive!.includes(k) ? 'yes' : 'no', 'no'])))}` : '<p class="muted">Not measured in this build.</p>'));

  // block library
  const bl = read<{ at: string; commit: string; blocks: { name: string; purpose: string; floor: number; tests: number; srcLines: number; consumers: string[]; doc?: string; mutation?: { score: number; killed: number; survived: number; noCoverage: number; valid: number; commit?: string } }[] }>(join(OUT, 'blocks.json'));
  write(join(SITE, 'factory', 'blocks.html'), shell('blocks', 'Block library', bl ? `<p class="muted">The reusable parts the Student Advocate is built from. Each block has one purpose, its own tests, its own mutation run against only those tests, a floor it may not fall below, and a page saying what to use it for and what not. The app inherits blocks by importing them; the <code>block-library</code> gate fails if an app copies a block's code.</p>${ui.kpis([{ value: String(bl.blocks.length), label: 'blocks' }, { value: String(bl.blocks.reduce((n, b) => n + b.tests, 0)), label: 'block tests' }, { value: String(bl.blocks.filter((b) => b.mutation && b.mutation.score >= b.floor).length), label: 'at or above their floor' }, { value: `${(bl.blocks.filter((b) => b.mutation).reduce((n, b) => n + b.mutation!.score, 0) / Math.max(1, bl.blocks.filter((b) => b.mutation).length)).toFixed(1)}%`, label: 'average mutation score' }])}${ui.table(['Block', 'What it is for', 'Tests', 'Mutation', 'Floor', 'Used by'], bl.blocks.map((b) => [b.doc ? `<a href="../${ui.esc(b.doc.replace(/\.md$/, '.html'))}"><code>@zthr/${ui.esc(b.name)}</code></a>` : `<code>@zthr/${ui.esc(b.name)}</code>`, ui.esc(b.purpose), String(b.tests), b.mutation ? `${b.mutation.score.toFixed(1)}% ${ui.bar(b.mutation.score / 100, `${b.name} mutation`)}` : ui.chip('not measured', 'warn'), b.mutation ? (b.mutation.score >= b.floor ? ui.chip(`${b.floor}%`, 'ok') : ui.chip(`${b.floor}%`, 'bad')) : `${b.floor}%`, b.consumers.map((c) => ui.esc(c)).join('<br>')]), { raw: [true, false, false, true, true, true] })}<p class="small muted">Floors are ratchets: they start at the score each block measured on its own tests and only rise. Mutation for a block runs only that block's own tests, so a block cannot lean on the app's tests to look strong.</p>` : '<p class="muted">Not measured in this build.</p>'));

  // data sources
  write(join(SITE, 'factory', 'sources.html'), shell('sources', 'Data sources', `<p class="muted">Everything the Advocate reads that it does not own, with an ERD of what each returns, drawn from the same schemas the contract tests enforce. Each field shows its sensitivity class. <a href="../docs/data-sources.html">The data sources document</a>.</p>${sources().map((src) => ui.section(src.name, `<p class="small muted">${ui.esc(src.kind)} · ${ui.esc(src.how)} Lands in: ${ui.esc(src.lands)}.</p><pre class="mermaid">${ui.esc(erd(src.entities, { showClass: true }))}</pre>`)).join('')}`));

  return PAGES.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  copyAssets();
  buildLanding();
  buildCase();
  const d = buildDocs();
  const f = buildFactory();
  console.log(`site built: ${d} doc pages, ${f} factory pages in ${relative(ROOT, SITE)}/`);
}
