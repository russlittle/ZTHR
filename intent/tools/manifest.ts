/**
 * Prints the build manifest for an intent in a folder (rough.md plus any reading-*.json), with where each line
 * comes from: the quickest way to see how much of a new product the library already covers.
 *
 *   node tools/manifest.ts eval/nextcloud [--all]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { manifest } from '../src/manifest.ts';
import { prepare } from '../src/pipeline.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/manifest.ts <folder with rough.md and reading-*.json> [--all]');
  process.exit(2);
}
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const readings = readdirSync(dir)
  .filter((f) => /^reading-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(read(f)));
const m = manifest(prepare({ files: [{ path: 'rough.md', text: read('rough.md') }], readings }));
const all = process.argv.includes('--all');
const share = (n: number) => `${Math.round((100 * n) / m.lines.length)}%`;
console.log(`${m.lines.length} lines: ${m.counts.stock} standard as is (${share(m.counts.stock)}), ${m.counts.modify} standard extended (${share(m.counts.modify)}), ${m.counts['make: catalogued']} catalogued to make (${share(m.counts['make: catalogued'])}), ${m.counts['make: new']} custom (${share(m.counts['make: new'])})`);
for (const l of m.lines.filter((x) => all || !x.floor || x.source === 'make: new')) console.log(`  ${l.source.padEnd(16)} ${l.part}${l.library.length ? `  [${l.library.map((b) => b.name).join(', ')}]` : ''}${l.uses.length ? `  uses ${l.uses.length} parts` : ''}`);
