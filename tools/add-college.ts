import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { CollegeDef } from '../apps/advocate/src/domain/colleges.js';
import { proposeCollege } from '../apps/advocate/src/builder/builder.js';
import { loadScouts } from '../apps/advocate/src/builder/scouts.js';
import { CONTROL, arg } from './lib.js';

/**
 * Add a college (PRD Phase 4). Writes its declaration to control/colleges and has the builder draft a basic-needs
 * scout for its county. Then `npm run certify` admits the scout when its checks pass, and the factory's journeys
 * prove students there are served or told plainly what is not verified yet.
 *
 *   npm run add-college -- --id clark-state --name "Clark State College" --short "Clark State" \
 *     --words "clark state,clark" --county Clark --website https://www.clarkstate.edu \
 *     --career-name "Clark State Career Services" --career-contact "clarkstate.edu, under Career Services"
 */
const def = CollegeDef.parse({
  college: arg('id'),
  name: arg('name'),
  short: arg('short') ?? arg('name'),
  words: (arg('words') ?? '').split(',').map((w) => w.trim()).filter(Boolean),
  county: arg('county'),
  state: arg('state') ?? 'OH',
  website: arg('website'),
  career: { name: arg('career-name') ?? `${arg('name')} career services`, contact: arg('career-contact') ?? arg('website'), source: arg('career-source') ?? arg('website') },
  admitted_by: 'factory',
});
const file = `${CONTROL}/colleges/${def.college}.yaml`;
if (existsSync(file)) {
  console.error(`refused: ${def.college} already exists; changing a college is a normal reviewed change`);
  process.exit(1);
}
writeFileSync(file, stringify(def));
console.log(`added ${file}`);
mkdirSync(`${CONTROL}/proposals`, { recursive: true });
for (const p of proposeCollege(def, loadScouts(`${CONTROL}/scouts`), arg('today') ?? new Date().toISOString().slice(0, 10))) {
  writeFileSync(`${CONTROL}/proposals/${p.id}.json`, `${JSON.stringify(p, null, 2)}\n`);
  console.log(`${p.status.padEnd(12)} ${p.id}  ${p.title}`);
}
