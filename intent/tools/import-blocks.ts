/**
 * Derives a manifest for every block in a block library from the block itself: its declared purpose and
 * mutation floor, what it exports, which other blocks it imports, and the "Use it for", "Not for" and
 * "Verified by" sections of its page. Anything the block does not declare is recorded as unknown, never guessed.
 *
 *   node tools/import-blocks.ts reference/student-advocate catalog
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Three-valued: a declared list, or unknown because the source says nothing. Unknown never counts as "none". */
export type Declared<T> = { known: true; value: T } | { known: false };

export interface Manifest {
  readonly name: string;
  readonly purpose: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly externalRequires: readonly string[];
  readonly conflicts: Declared<string[]>;
  readonly companions: Declared<string[]>;
  readonly secrets: Declared<string[]>;
  readonly usedFor: string;
  readonly notFor: string;
  readonly verifiedBy: string;
  readonly mutationFloor: number | null;
  readonly tests: number;
  readonly source: { readonly path: string; readonly sha256: string };
}

const files = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).sort().map((f) => join(dir, f)) : [];

/** Names exported from a file: declarations and re-export lists. */
export function exportsOf(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1] ?? '');
  for (const m of code.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
      if (name) out.add(name);
    }
  }
  out.delete('');
  return [...out].sort();
}

/** Package names imported by a file, split into blocks of this library and everything else. */
export function importsOf(code: string, scope: string): { blocks: string[]; external: string[] } {
  const blocks = new Set<string>();
  const external = new Set<string>();
  for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1] ?? '';
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    if (spec.startsWith(`${scope}/`)) blocks.add(spec.slice(scope.length + 1).split('/')[0] ?? '');
    else external.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? ''));
  }
  return { blocks: [...blocks].sort(), external: [...external].sort() };
}

/** The text of one "## Heading" section of a markdown page, up to the next heading of the same level. */
export function section(md: string, title: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${title}`.toLowerCase());
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** Names a file exports, following `export * from './x.ts'` into the files it names. */
export function reexported(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const code = readFileSync(file, 'utf8');
  const out = new Set(exportsOf(code));
  for (const m of code.matchAll(/^export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gm)) {
    const target = join(file, '..', (m[1] ?? '').replace(/\.js$/, '.ts'));
    for (const n of reexported(existsSync(target) ? target : `${target}.ts`, seen)) out.add(n);
  }
  return [...out].sort();
}

export function manifestOf(root: string, name: string, scope = '@zthr'): Manifest {
  const dir = join(root, 'packages', name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    description?: string;
    zthr?: { purpose?: string; mutationFloor?: number; conflicts?: string[]; companions?: string[]; secrets?: string[] };
  };
  const src = files(join(dir, 'src'));
  const code = src.map((f) => readFileSync(f, 'utf8'));
  const entry = join(dir, 'src', 'index.ts');
  const provides = existsSync(entry) ? reexported(entry) : [];
  const requires = new Set<string>();
  const external = new Set<string>();
  for (const c of code) {
    const i = importsOf(c, scope);
    i.blocks.forEach((b) => b !== name && requires.add(b));
    i.external.forEach((e) => external.add(e));
  }
  const docPath = join(root, 'docs', 'blocks', `${name}.md`);
  const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
  const testFiles = files(join(dir, 'test'));
  const tests = testFiles.reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(/^\s*(?:it|test)(?:\.each\([^)]*\))?\s*\(/gm)].length, 0);
  const declared = (v: string[] | undefined): Declared<string[]> => (v === undefined ? { known: false } : { known: true, value: [...v].sort() });
  const hash = createHash('sha256');
  for (const f of [join(dir, 'package.json'), ...src]) hash.update(f.slice(dir.length)).update(readFileSync(f));
  return {
    name,
    purpose: pkg.zthr?.purpose ?? pkg.description ?? '',
    provides,
    requires: [...requires].sort(),
    externalRequires: [...external].sort(),
    conflicts: declared(pkg.zthr?.conflicts),
    companions: declared(pkg.zthr?.companions),
    secrets: declared(pkg.zthr?.secrets),
    usedFor: section(doc, 'Use it for'),
    notFor: section(doc, 'Not for'),
    verifiedBy: section(doc, 'Verified by'),
    mutationFloor: pkg.zthr?.mutationFloor ?? null,
    tests,
    source: { path: `packages/${name}`, sha256: hash.digest('hex') },
  };
}

/** Blocks in an order where every block comes after the blocks it requires; a cycle is an error, named. */
export function buildOrder(manifests: readonly Manifest[]): string[] {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  const done: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`blocks require each other in a cycle: ${[...path, name].join(' -> ')}`);
    const m = byName.get(name);
    if (!m) throw new Error(`a block requires ${name}, which is not in the library`);
    state.set(name, 'visiting');
    m.requires.forEach((r) => visit(r, [...path, name]));
    state.set(name, 'done');
    done.push(name);
  };
  [...byName.keys()].sort().forEach((n) => visit(n, []));
  return done;
}

if (import.meta.main) {
  const [root = 'library', out = 'catalog'] = process.argv.slice(2);
  const names = readdirSync(join(root, 'packages'))
    .filter((n) => existsSync(join(root, 'packages', n, 'package.json')))
    .sort();
  const manifests = names.map((n) => manifestOf(root, n));
  mkdirSync(join(out, 'blocks'), { recursive: true });
  for (const m of manifests) writeFileSync(join(out, 'blocks', `${m.name}.json`), `${JSON.stringify(m, null, 2)}\n`);
  const order = buildOrder(manifests);
  const source = existsSync(join(root, 'SOURCE.json')) ? JSON.parse(readFileSync(join(root, 'SOURCE.json'), 'utf8')) : null;
  writeFileSync(
    join(out, 'catalog.json'),
    `${JSON.stringify({ source, buildOrder: order, blocks: manifests.map((m) => ({ name: m.name, purpose: m.purpose, requires: m.requires, tests: m.tests, mutationFloor: m.mutationFloor, undeclared: (['conflicts', 'companions', 'secrets'] as const).filter((k) => !m[k].known) })) }, null, 2)}\n`,
  );
  console.log(`${manifests.length} blocks; build order: ${order.join(' -> ')}`);
  for (const m of manifests) console.log(`  ${m.name.padEnd(15)} ${String(m.tests).padStart(4)} tests  floor ${String(m.mutationFloor ?? '-').padStart(3)}  requires [${m.requires.join(', ')}]  provides ${m.provides.length}`);
}
