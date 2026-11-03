import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ROOT } from './lib.js';

/**
 * The walk's fingerprint: every file a walk can execute or read, hashed together. Starting from the walk's entry
 * points it follows every import (relative paths and @zthr/<block> packages, static and dynamic), then adds the
 * data the app reads while it runs and the dependency versions. If the fingerprint is unchanged, every file the walk
 * could reach is byte-for-byte the same, so an earlier walk is still evidence for this commit. The nightly run walks
 * everything regardless, which backstops a fingerprint that misses something.
 */
export const WALK_ENTRIES = ['tools/explore.ts', 'tools/crawl.ts'];
/** Read at run time rather than imported: the app loads these directories and files itself. */
export const WALK_DATA = ['control/playbooks', 'control/colleges', 'control/scouts', 'control/proposals', 'control/people.json', 'package.json', 'package-lock.json'];

const IMPORT = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(from: string, spec: string): string | undefined {
  if (spec.startsWith('@zthr/')) {
    const p = join(ROOT, 'packages', spec.slice(6).split('/')[0]!, 'src', 'index.ts');
    return existsSync(p) ? p : undefined;
  }
  if (!spec.startsWith('.')) return undefined; // node built-ins and npm packages: covered by package-lock.json
  const base = resolve(dirname(from), spec);
  for (const c of [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return undefined;
}

/** Every source file reachable from the entry points, as paths relative to the repository. */
export function walkClosure(entries = WALK_ENTRIES): string[] {
  const seen = new Set<string>();
  const queue = entries.map((e) => join(ROOT, e));
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const r = resolveImport(f, m[1]!);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  return [...seen].map((f) => relative(ROOT, f)).sort();
}

const listData = (p: string): string[] => {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [p];
  return readdirSync(abs, { recursive: true }).map(String).map((n) => join(p, n)).filter((n) => statSync(join(ROOT, n)).isFile()).sort();
};

/** The fingerprint, and the files it covers. */
export function walkFingerprint(): { hash: string; files: string[] } {
  const files = [...walkClosure(), ...WALK_DATA.flatMap(listData)];
  const h = createHash('sha256');
  for (const f of files) h.update(f).update('\0').update(createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex')).update('\n');
  return { hash: h.digest('hex').slice(0, 16), files };
}

if (process.argv[1]?.endsWith('closure.ts')) {
  const { hash, files } = walkFingerprint();
  if (process.argv.includes('--files')) for (const f of files) console.log(f);
  console.log(hash);
}
