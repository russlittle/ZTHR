/**
 * The plant page with the plant model written in: the areas, their flows, and where each stands, from
 * src/console/plant-model.ts. Used by the site build; run directly to write a standalone page:
 *   node tools/plant-page.ts --out <file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, AS_OF, FLOWS, GROUPS, STANDING } from '../src/console/plant-model.ts';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

export function plantPage(): string {
  const html = readFileSync(join(HERE, 'site/plant.html'), 'utf8');
  const model = { asOf: AS_OF, groups: GROUPS, flows: FLOWS, areas: AREAS.map((a) => ({ ...a, ...STANDING[a.key] })) };
  // Escaped for a script element: no "</" can close it early.
  const json = JSON.stringify(model).replace(/</g, '\\u003c');
  const out = html.replace('/*MODEL*/null/*END*/', json);
  if (out === html) throw new Error('the plant page has no place for the model');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const to = i >= 0 ? process.argv[i + 1] : undefined;
  if (!to) throw new Error('--out <file> is needed');
  writeFileSync(to, plantPage());
  console.log(`wrote ${to}`);
}
