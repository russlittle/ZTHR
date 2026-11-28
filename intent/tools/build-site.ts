/**
 * Builds zthr.ai's three surfaces from this package's source, into the site's public folder:
 *
 *   /intent    the studio: rough words to a released drawing and its package
 *   /factory   the factory console: the latest build's readings, journeys, phases, gates and ratchets
 *   /mission   mission control: intents on the left, the factory on the right, working software the measure
 *   /metrology    the lab: the measures QA uses, gauge certificates, control charts, the claims audit
 *   /maintenance  the night shift: the tags, the morning report, gauge scores and the crew, read from the records
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
import { DEPARTMENTS, lineBar, type Dept } from '../src/console/line.ts';
import { sitePages } from './docs.ts';
import { readNight } from './night.ts';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const OUT = resolve(HERE, i > 0 ? process.argv[i + 1]! : '../docs');
// Built for zthr.ai, the tools sit behind Google sign-in, by invitation. --open builds them without the door, for
// local checks and for anyone running their own copy.
const GATED = !process.argv.includes('--open');
const gate = (html: string) => {
  if (!GATED) return html;
  const out = html.replace('<html lang="en">', '<html lang="en" class="gated">').replace(/(<script src="\/(intent|mission|factory|lines|shipping|fleet|metrology|maintenance)\/app\.js"><\/script>)/, '<script src="/console/gate.js"></script>\n$1');
  if (!out.includes('class="gated"') || !out.includes('/console/gate.js')) throw new Error('a gated page did not take the gate');
  return out;
};

const withLine = (html: string, d: Dept) => {
  const out = html.replace(/<header class="zbar">[\s\S]*?<\/header>/, lineBar(d));
  if (!out.includes('class="zline"')) throw new Error(`the ${d} page did not take the line`);
  return out;
};

async function bundle(entry: string, out: string) {
  await build({ entryPoints: [join(HERE, entry)], bundle: true, format: 'iife', target: 'es2022', minify: true, outfile: join(OUT, out), logLevel: 'warning', legalComments: 'none' });
}

const PAGES = ['intent', 'engineering', 'mission', 'lines', 'factory', 'qa', 'shipping', 'fleet', 'metrology', 'maintenance'] as const;
for (const d of [...PAGES, 'console']) mkdirSync(join(OUT, d), { recursive: true });
await bundle('src/studio/app.ts', 'intent/app.js');
await bundle('src/console/mission.ts', 'mission/app.js');
await bundle('src/console/factory.ts', 'factory/app.js');
await bundle('src/gate.ts', 'console/gate.js');
await bundle('src/console/lines.ts', 'lines/app.js');
await bundle('src/console/shipping.ts', 'shipping/app.js');
await bundle('src/console/fleet.ts', 'fleet/app.js');
await bundle('src/console/metrology.ts', 'metrology/app.js');
await bundle('src/console/maintenance.ts', 'maintenance/app.js');
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
// Engineering is the studio's second department: the same schematic, opened on its specification.
const eng = page
  .replace('<body>', '<body data-dept="engineering">')
  .replace('<title>Intent studio</title>', '<title>Engineering · ZTHR</title>')
  .replace(/<h1>Intent studio<\/h1>\s*<p class="promise">[\s\S]*?<\/p>/, '<h1>Engineering</h1>\n    <p class="promise">The signed schematic, turned into a complete specification: the outcomes and how each is assessed, the information it keeps, the compliance it lives under, how it runs, every measure and test, and the package the factory builds to.</p>');
if (!eng.includes('data-dept="engineering"') || !eng.includes('<h1>Engineering</h1>')) throw new Error('the engineering page did not take its department');
writeFileSync(join(OUT, 'engineering/index.html'), gate(withLine(eng, 'engineering')));
const sitePage = (d: Dept, file: string) => writeFileSync(join(OUT, `${d}/index.html`), gate(withLine(readFileSync(join(HERE, `site/${file}.html`), 'utf8'), d)));
for (const d of ['mission', 'lines', 'factory', 'qa', 'shipping', 'fleet', 'metrology', 'maintenance'] as const) sitePage(d, d);
// How it works: the line's docs as pages, generated from the same sources as docs/line/*.md, with the depth ladder.
const head = readFileSync(join(HERE, 'site/factory.html'), 'utf8').split('<title>')[0]!.replace('<link rel="stylesheet" href="/console/bar.css">', '<link rel="stylesheet" href="/console/bar.css">\n<link rel="stylesheet" href="/console/docs.css">');
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
for (const p of sitePages()) {
  const dir = p.doc === 'index' ? 'line' : `line/${p.doc}`;
  mkdirSync(join(OUT, dir), { recursive: true });
  const open = p.dept ? DEPARTMENTS.find((d) => d.key === p.dept)! : null;
  const html = `${head}<title>${esc(p.doc === 'index' ? 'How the line works' : `How it works: ${p.title}`)} · ZTHR</title>
<meta name="description" content="${esc(p.lede)}">
</head>
<body data-docs="${p.doc}">
<a class="skip" href="#main">Skip to content</a>
${lineBar(p.dept, true)}
<div class="page-h"><div><p class="crumbs"><a href="/line/">How it works</a>${p.doc === 'index' ? '' : ` / ${esc(p.title)}`}</p><h1>${esc(p.title)}</h1><p>${esc(p.lede)}</p>${open ? `<p><a class="btn" href="${open.href}">Open ${esc(open.label)}</a></p>` : ''}</div></div>
<main id="main" class="docs">
${p.body}
</main>
<footer class="foot"><p>Generated from <a href="https://github.com/russlittle/ZTHR/tree/main/intent/docs/src/line">the docs' sources</a> by <code>tools/docs.ts</code>: every figure, table and diagram here is computed from the code, and a test fails when any of it is stale. The same pages, as markdown: <a href="https://github.com/russlittle/ZTHR/tree/main/intent/docs/line">docs/line</a>.</p></footer>
</body>
</html>
`;
  writeFileSync(join(OUT, dir, 'index.html'), html);
}
copyFileSync(join(HERE, 'site/docs.css'), join(OUT, 'console/docs.css'));
copyFileSync(join(HERE, 'site/console.css'), join(OUT, 'console/console.css'));
copyFileSync(join(HERE, 'site/bar.css'), join(OUT, 'console/bar.css'));
console.log(`built ${PAGES.map((x) => `/${x}`).join(', ')} and /line into ${OUT}${GATED ? ', behind Google sign-in by invitation' : ', open'}`);
