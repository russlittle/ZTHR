/**
 * Builds zthr.ai's three surfaces from this package's source, into the site's public folder:
 *
 *   /intent    the studio: rough words to a released drawing and its package
 *   /factory   the factory console: the latest build's readings, journeys, phases, gates and ratchets
 *   /mission   mission control: intents on the left, the factory on the right, working software the measure
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

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const OUT = resolve(HERE, i > 0 ? process.argv[i + 1]! : '../docs');
// Built for zthr.ai, the tools sit behind Google sign-in, by invitation. --open builds them without the door, for
// local checks and for anyone running their own copy.
const GATED = !process.argv.includes('--open');
const gate = (html: string) => {
  if (!GATED) return html;
  const out = html.replace('<html lang="en">', '<html lang="en" class="gated">').replace(/(<script src="\/(intent|mission|factory)\/app\.js"><\/script>)/, '<script src="/console/gate.js"></script>\n$1');
  if (!out.includes('class="gated"') || !out.includes('/console/gate.js')) throw new Error('a gated page did not take the gate');
  return out;
};

const BAR = (current: 'intent' | 'factory' | 'mission') =>
  `<header class="zbar"><a class="brand" href="/">ZTHR</a><nav aria-label="Surfaces">${(
    [
      ['intent', '/intent', 'Intent'],
      ['factory', '/factory', 'Factory'],
      ['mission', '/mission', 'Mission control'],
    ] as const
  )
    .map(([k, href, label]) => `<a href="${href}"${k === current ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('')}<a href="/reference/factory">Evidence</a></nav></header>`;

async function bundle(entry: string, out: string) {
  await build({ entryPoints: [join(HERE, entry)], bundle: true, format: 'iife', target: 'es2022', minify: true, outfile: join(OUT, out), logLevel: 'warning', legalComments: 'none' });
}

for (const d of ['intent', 'factory', 'mission', 'console']) mkdirSync(join(OUT, d), { recursive: true });
await bundle('src/studio/app.ts', 'intent/app.js');
await bundle('src/console/mission.ts', 'mission/app.js');
await bundle('src/console/factory.ts', 'factory/app.js');
await bundle('src/gate.ts', 'console/gate.js');

const studio = readFileSync(join(HERE, 'studio/index.html'), 'utf8');
const page = studio
  .replace('<script src="app.js"></script>', '<script src="/intent/app.js"></script>')
  .replace('</head>', '<link rel="stylesheet" href="/console/bar.css">\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n</head>')
  .replace(/<body>\n?/, `<body>\n${BAR('intent')}\n`);
if (page === studio || !page.includes('/intent/app.js')) throw new Error('the studio page did not take the site paths');
writeFileSync(join(OUT, 'intent/index.html'), gate(page));
writeFileSync(join(OUT, 'mission/index.html'), gate(readFileSync(join(HERE, 'site/mission.html'), 'utf8')));
writeFileSync(join(OUT, 'factory/index.html'), gate(readFileSync(join(HERE, 'site/factory.html'), 'utf8')));
copyFileSync(join(HERE, 'site/console.css'), join(OUT, 'console/console.css'));
copyFileSync(join(HERE, 'site/bar.css'), join(OUT, 'console/bar.css'));
console.log(`built /intent, /factory and /mission into ${OUT}${GATED ? ', behind Google sign-in by invitation' : ', open'}`);
