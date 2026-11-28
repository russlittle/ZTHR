/**
 * The plant page with the plant model written in: the areas, their flows, and where each stands, from
 * src/console/plant-model.ts and the repository's own facts (tools/plant-facts.ts). Used by the site build; run
 * directly to write a standalone page:
 *   node tools/plant-page.ts --out <file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineBar } from '../src/console/line.ts';
import { AREAS, FLOWS, GROUPS, docHref, pageHref, standingOf } from '../src/console/plant-model.ts';
import { plantFacts } from './plant-facts.ts';

const GH = 'https://github.com/russlittle/ZTHR/blob/main';
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

export function plantPage(): string {
  const html = readFileSync(join(HERE, 'site/plant.html'), 'utf8');
  const facts = plantFacts();
  const standing = standingOf(facts);
  const model = {
    asOf: facts.asOf,
    groups: GROUPS,
    flows: FLOWS,
    // One table for where each area opens and where its doc is: the page never builds a link of its own.
    areas: AREAS.map((a) => ({ ...a, ...standing[a.key], open: pageHref(a), how: docHref(a), srcOpen: ['intent', 'engineering'].includes(a.page) ? `${GH}/intent/studio/index.html` : `${GH}/intent/site/${a.page}.html`, srcHow: `${GH}/intent/docs/line/${a.page}.md`, srcIndex: `${GH}/intent/docs/line/README.md` })),
    queue: facts.queue,
    survivors: facts.blocks.survivors,
    shifts: facts.shifts,
  };
  // Escaped for a script element: no "</" can close it early.
  const json = JSON.stringify(model).replace(/</g, '\\u003c');
  const out = html.replace('/*MODEL*/null/*END*/', json).replace(/<header class="zbar"><\/header>/, lineBar('plant'));
  if (out === html || !out.includes('class="zgroups"')) throw new Error('the plant page has no place for the model or the bar');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const to = i >= 0 ? process.argv[i + 1] : undefined;
  if (!to) throw new Error('--out <file> is needed');
  writeFileSync(to, plantPage());
  console.log(`wrote ${to}`);
}
