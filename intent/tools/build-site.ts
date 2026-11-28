/**
 * Builds zthr.ai's pages from this package's source, into the site's public folder. Every page, and the bar they
 * share, is drawn from the plant model (src/console/plant-model.ts): one page for each area that has one.
 *
 *   /intent        the studio: rough words to a signed intent package
 *   /engineering   product engineering: the same schematic, opened on its specification
 *   /process       manufacturing engineering: the build package, the routing, the gates and the required checks
 *   /factory       the factory floor: the latest build's readings, phases and features
 *   /qa            QA: journeys, gates and ratchets
 *   /rework        rework: what QA sent back, and its evidence
 *   /shipping      the release, and the staged deploy
 *   /fleet         everything in service
 *   /deployment    deployment engineering: environments, deploys, over-the-air updates and monitoring
 *   /mission       mission control: the front office, which runs the plant
 *   /lines         product lines
 *   /metrology     the lab: the measures QA uses, gauge certificates, control charts, the claims audit
 *   /maintenance   the night shift: the tags, the morning report, gauge scores and the crew
 *   /plant         the plant itself, open to anyone, with each area's standing
 *   /line          how it works: one doc for each area, and the standards map
 *
 * The deploy workflow runs it before the link check, so what is served is always built from the source in this
 * repository, never a copy. Assets are referenced by absolute path, because zthr.ai serves /intent without a slash.
 *
 *   node tools/build-site.ts [--out ../docs]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { lineBar, type Dept } from '../src/console/line.ts';
import { AREAS, area, standingOf, type AreaKey } from '../src/console/plant-model.ts';
import { evidenceFor, standingPanel } from './area-pages.ts';
import { plantFacts } from './plant-facts.ts';
import { plantPage } from './plant-page.ts';
import { sitePages } from './docs.ts';
import { readNight } from './night.ts';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const OUT = resolve(HERE, i > 0 ? process.argv[i + 1]! : '../docs');
// Built for zthr.ai, the tools sit behind Google sign-in, by invitation. --open builds them without the door, for
// local checks and for anyone running their own copy.
const GATED = !process.argv.includes('--open');
const PAGES = [...new Set(AREAS.map((a) => a.page))];
const gate = (html: string) => {
  if (!GATED) return html;
  const out = html.replace('<html lang="en">', '<html lang="en" class="gated">').replace(new RegExp(`(<script src="/(${PAGES.join('|')})/app\\.js"></script>)`), '<script src="/console/gate.js"></script>\n$1');
  if (!out.includes('class="gated"') || !out.includes('/console/gate.js')) throw new Error('a gated page did not take the gate');
  return out;
};

const withLine = (html: string, d: Dept) => {
  const out = html.replace(/<header class="zbar">[\s\S]*?<\/header>/, lineBar(d));
  if (!out.includes('class="zgroups"')) throw new Error(`the ${d} page did not take the bar`);
  return out;
};

// What the repository shows, once: the panels every page ends with and the plant page are drawn from it.
const facts = plantFacts();
const standing = standingOf(facts);

async function bundle(entry: string, out: string) {
  await build({ entryPoints: [join(HERE, entry)], bundle: true, format: 'iife', target: 'es2022', minify: true, outfile: join(OUT, out), logLevel: 'warning', legalComments: 'none' });
}

for (const d of [...PAGES, 'console']) mkdirSync(join(OUT, d), { recursive: true });
await bundle('src/studio/app.ts', 'intent/app.js');
await bundle('src/gate.ts', 'console/gate.js');
for (const [src, dir] of [['mission', 'mission'], ['factory', 'factory'], ['lines', 'lines'], ['shipping', 'shipping'], ['fleet', 'fleet'], ['metrology', 'metrology'], ['maintenance', 'maintenance'], ['process', 'process'], ['rework', 'rework'], ['deployment', 'deployment']] as const) await bundle(`src/console/${src}.ts`, `${dir}/app.js`);
// The calibration certificates and the night shift's records, as this commit holds them: metrology and maintenance
// read them, and say so when there are none.
writeFileSync(join(OUT, 'maintenance/night.json'), JSON.stringify(readNight()));

const studio = readFileSync(join(HERE, 'studio/index.html'), 'utf8');
const page = studio
  .replace('<script src="app.js"></script>', '<script src="/intent/app.js"></script>')
  .replace('</head>', '<link rel="stylesheet" href="/console/bar.css">\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n</head>')
  .replace(/<body>\n?/, `<body>\n<header class="zbar"></header>\n`);
if (page === studio || !page.includes('/intent/app.js')) throw new Error('the studio page did not take the site paths');
writeFileSync(join(OUT, 'intent/index.html'), gate(withLine(page, 'intent')));
// Product engineering is the studio's second area: the same schematic, opened on its specification.
const eng = page
  .replace('<body>', '<body data-dept="engineering">')
  .replace('<title>Intent studio</title>', '<title>Product engineering · ZTHR</title>')
  .replace(/<h1>Intent studio<\/h1>\s*<p class="promise">[\s\S]*?<\/p>/, '<h1>Product engineering</h1>\n    <p class="promise">The signed intent package, turned into the product spec: the outcomes and how each is assessed, the information it keeps, the compliance it lives under, how it runs, every measure and test, and the checklist that releases it to manufacturing engineering.</p>');
if (!eng.includes('data-dept="engineering"') || !eng.includes('<h1>Product engineering</h1>')) throw new Error('the engineering page did not take its area');
writeFileSync(join(OUT, 'engineering/index.html'), gate(withLine(eng, 'design')));

// Every other page is a template under site/, with the bar, the repository's evidence and the area's standing written in.
const withEvidence = (html: string, key: AreaKey, pageName: string) => {
  let out = html.replace('<!--standing-->', standingPanel(key, standing[key], facts));
  if (out.includes('<!--evidence-->')) out = out.replace('<!--evidence-->', evidenceFor(pageName, facts));
  if (out.includes('<!--standing-->') || out.includes('<!--evidence-->')) throw new Error(`the ${pageName} page left a marker unfilled`);
  if (!out.includes('id="h-needs"')) throw new Error(`the ${pageName} page has no place for what its area needs`);
  return out;
};
for (const a of AREAS) {
  if (['intent', 'engineering'].includes(a.page)) continue;
  const html = withEvidence(readFileSync(join(HERE, `site/${a.page}.html`), 'utf8'), a.key, a.page);
  writeFileSync(join(OUT, `${a.page}/index.html`), gate(withLine(html, a.key)));
}

// How it works: the plant's docs as pages, generated from the same sources as docs/line/*.md, with the depth ladder.
const head = readFileSync(join(HERE, 'site/factory.html'), 'utf8').split('<title>')[0]!.replace('<link rel="stylesheet" href="/console/bar.css">', '<link rel="stylesheet" href="/console/bar.css">\n<link rel="stylesheet" href="/console/docs.css">');
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
for (const p of sitePages()) {
  const dir = p.doc === 'index' ? 'line' : `line/${p.doc}`;
  mkdirSync(join(OUT, dir), { recursive: true });
  const open = p.dept ? area(p.dept) : null;
  const html = `${head}<title>${esc(p.doc === 'index' ? 'How the plant works' : `How it works: ${p.title}`)} · ZTHR</title>
<meta name="description" content="${esc(p.lede)}">
</head>
<body data-docs="${p.doc}">
<a class="skip" href="#main">Skip to content</a>
${lineBar(p.dept, true)}
<div class="page-h"><div><p class="crumbs"><a href="/line/">How it works</a>${p.doc === 'index' ? '' : ` / ${esc(p.title)}`}</p><h1>${esc(p.title)}</h1><p>${esc(p.lede)}</p>${open ? `<p><a class="btn" href="/${open.page}">Open ${esc(open.label)}</a></p>` : ''}</div></div>
<main id="main" class="docs">
${p.body}
</main>
<footer class="foot"><p>Generated from <a href="https://github.com/russlittle/ZTHR/tree/main/intent/docs/src/line">the docs' sources</a> by <code>tools/docs.ts</code>: every figure, table and diagram here is computed from the code and the plant model, and a test fails when any of it is stale. The same pages, as markdown: <a href="https://github.com/russlittle/ZTHR/tree/main/intent/docs/line">docs/line</a>.</p></footer>
</body>
</html>
`;
  writeFileSync(join(OUT, dir, 'index.html'), html);
}
// The front door: the plant laid out, open to anyone, with each area's standing. It links into the console.
mkdirSync(join(OUT, 'plant'), { recursive: true });
// Its script ships as its own file: zthr.ai's content security policy allows no unlisted inline script.
const plant = plantPage();
const plantScript = /<script>\n([\s\S]*?)<\/script>/.exec(plant);
if (!plantScript) throw new Error('the plant page has no script to ship');
writeFileSync(join(OUT, 'plant/app.js'), plantScript[1] ?? '');
writeFileSync(join(OUT, 'plant/index.html'), plant.replace(plantScript[0], '<script src="/plant/app.js"></script>'));
copyFileSync(join(HERE, 'site/docs.css'), join(OUT, 'console/docs.css'));
copyFileSync(join(HERE, 'site/console.css'), join(OUT, 'console/console.css'));
copyFileSync(join(HERE, 'site/bar.css'), join(OUT, 'console/bar.css'));
console.log(`built ${PAGES.map((x) => `/${x}`).join(', ')}, /line and /plant into ${OUT}${GATED ? ', behind Google sign-in by invitation' : ', open'}`);
