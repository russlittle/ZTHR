/**
 * Writes catalog/README.md from the catalog's data files, grouped by the foundation each block leans on, so the
 * page can never say something the data does not. Fails if any block is in no group, or in more than one.
 *
 *   node tools/catalog-page.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Coverage {
  coverage: 'yes' | 'partial' | 'none';
  from?: string;
}
interface Entry {
  name: string;
  gives: string;
  studentAdvocate?: Coverage;
}
type Kind = 'common' | 'delighter' | 'visual' | 'admin' | 'intent';

const read = <T,>(f: string): T => JSON.parse(readFileSync(new URL(`../catalog/${f}`, import.meta.url), 'utf8')) as T;
const library = read<{ blocks: { name: string; purpose: string; tests: number }[] }>('catalog.json');
const common = read<{ blocks: Entry[] }>('top50.json');
const delight = read<{ delighters: Entry[]; visual: Entry[]; visualTests: string[] }>('delight.json');
const admin = read<{ blocks: Entry[]; rules: string[]; reportTemplates?: { operational: string[]; business: string[] } }>('admin.json');
const intent = read<{ parts: Entry[] }>('intent.json');
const { foundations, groups } = read<{ foundations: Record<string, string>; groups: Record<string, string[]> }>('groups.json');

const all = new Map<string, Entry & { kind: Kind }>();
const add = (kind: Kind) => (e: Entry) => {
  if (all.has(e.name)) throw new Error(`two parts are named "${e.name}"`);
  all.set(e.name, { ...e, kind });
};
common.blocks.forEach(add('common'));
delight.delighters.forEach(add('delighter'));
delight.visual.forEach(add('visual'));
admin.blocks.forEach(add('admin'));
intent.parts.forEach(add('intent'));

// Every block has exactly one home, and every name in a group is a real block.
const placed = new Map<string, string>();
const problems: string[] = [];
for (const [group, names] of Object.entries(groups)) {
  for (const n of names) {
    if (!all.has(n)) problems.push(`"${n}" is in group ${group} but is not a part`);
    const before = placed.get(n);
    if (before) problems.push(`"${n}" is in both ${before} and ${group}`);
    placed.set(n, group);
  }
}
for (const n of all.keys()) if (!placed.has(n)) problems.push(`"${n}" is in no group`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const kindLabel: Record<Kind, string> = { common: '', delighter: ' *(delighter)*', visual: '', admin: '', intent: '' };
const mark = (c?: Coverage): string => (c?.coverage === 'yes' ? ' ✓' : c?.coverage === 'partial' ? ' ◐' : '');
const counts = Object.fromEntries(Object.entries(groups).map(([g, n]) => [g, n.length]));

const page = `# Parts catalog

${all.size} parts to build, grouped by the shared foundation each one leans on, on top of the ${library.blocks.length} parts already in the library. ✓ means a library part covers it today; ◐ means one covers part of it. Every part carries a manifest, purpose notes, tests and planted-defect proofs, and every part is in exactly one group.

\`\`\`mermaid
flowchart TB
${Object.keys(groups)
  .map((g, i) => `    G${i}["${g}: ${counts[g]}"]`)
  .join('\n')}
    LIB["Library: ${library.blocks.length} parts"] --> G1 & G2 & G3 & G4
    G0 -. "measures every part against the datum" .-> G1 & G2 & G3 & G4 & G5 & G6 & G7 & G8
    G5 --> G6 & G7
    G1 -. "who may" .-> G2 & G3 & G4 & G5 & G6
    G4 -. "records" .-> G2 & G3
\`\`\`

## Foundations

| Group | Parts | The one thing every part in it shares |
| --- | --- | --- |
${Object.keys(groups)
  .map((g) => `| ${g} | ${counts[g]} | ${foundations[g] ?? ''} |`)
  .join('\n')}

${Object.entries(groups)
  .map(
    ([g, names]) => `## ${g}

${foundations[g] ?? ''}.

${names
  .map((n) => {
    const e = all.get(n)!;
    return `- **${e.name}**${mark(e.studentAdvocate)}${kindLabel[e.kind]}: ${e.gives}`;
  })
  .join('\n')}`,
  )
  .join('\n\n')}

## Report templates

Operational:

${(admin.reportTemplates?.operational ?? []).map((t) => `- ${t}`).join('\n')}

Business:

${(admin.reportTemplates?.business ?? []).map((t) => `- ${t}`).join('\n')}

## Rules

${admin.rules.map((r) => `- ${r}`).join('\n')}
${delight.visualTests.map((t) => `- ${t.charAt(0).toUpperCase()}${t.slice(1)}.`).join('\n')}

## The library today

${library.blocks.map((b) => `- **${b.name}**: ${b.purpose} (${b.tests} tests)`).join('\n')}
`;

writeFileSync(new URL('../catalog/README.md', import.meta.url), page);
console.log(`catalog/README.md: ${all.size} parts in ${Object.keys(groups).length} groups, ${library.blocks.length} in the library`);
