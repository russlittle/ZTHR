import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, ROOT, headCommit } from './lib.js';

/**
 * The block library. Every package under packages/ is a block: a part with one purpose, its own tests, its own
 * mutation run and floor, and a page saying what to use it for and what not to. Apps inherit blocks by importing
 * them; they never copy a block's code.
 *
 *   npx tsx tools/blocks.ts                 summarize: tests, consumers, docs, last mutation score per block
 *   npx tsx tools/blocks.ts --mutate        run every block's mutation testing, against only its own tests
 *   npx tsx tools/blocks.ts --mutate store  one block
 */
export interface BlockMeta {
  name: string;
  purpose: string;
  /** Mutation score the block may not fall below. */
  floor: number;
}
export interface BlockReport extends BlockMeta {
  tests: number;
  testFiles: string[];
  srcLines: number;
  consumers: string[];
  doc: string | undefined;
  docHasUseFor: boolean;
  mutation?: { score: number; killed: number; survived: number; noCoverage: number; valid: number; commit?: string; at: string };
}

const PKG = join(ROOT, 'packages');
const DEFAULT_FLOOR = 70;
export const blockNames = (): string[] => readdirSync(PKG).filter((n) => existsSync(join(PKG, n, 'package.json'))).sort();

export function meta(name: string): BlockMeta {
  const pkg = JSON.parse(readFileSync(join(PKG, name, 'package.json'), 'utf8')) as { zthr?: { purpose?: string; mutationFloor?: number }; description?: string };
  return { name, purpose: pkg.zthr?.purpose ?? pkg.description ?? '', floor: pkg.zthr?.mutationFloor ?? DEFAULT_FLOOR };
}

const files = (dir: string, ext: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).filter((f) => f.endsWith(ext)).map((f) => join(dir, f)) : []);

/** Who imports the block: apps and other blocks, by package name. */
export function consumers(name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`from '@zthr/${name}'`);
  for (const area of ['apps', 'packages']) {
    for (const p of readdirSync(join(ROOT, area))) {
      if (area === 'packages' && p === name) continue;
      if (files(join(ROOT, area, p, 'src'), '.ts').some((f) => re.test(readFileSync(f, 'utf8')))) out.push(`${area === 'apps' ? 'app' : 'block'}:${p}`);
    }
  }
  if (files(join(ROOT, 'tools'), '.ts').some((f) => re.test(readFileSync(f, 'utf8')))) out.push('factory:tools');
  return out;
}

const mutationFile = (name: string) => join(ROOT, 'reports', 'blocks', `${name}.json`);

export function mutationOf(name: string): BlockReport['mutation'] {
  const f = mutationFile(name);
  if (!existsSync(f)) return undefined;
  const r = JSON.parse(readFileSync(f, 'utf8')) as { files: Record<string, { mutants: { status: string }[] }>; zthr?: { commit: string; at: string } };
  const all = Object.values(r.files).flatMap((x) => x.mutants);
  const killed = all.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  const survived = all.filter((m) => m.status === 'Survived').length;
  const noCoverage = all.filter((m) => m.status === 'NoCoverage').length;
  const valid = all.filter((m) => !['CompileError', 'RuntimeError', 'Ignored'].includes(m.status)).length;
  return { score: valid ? (killed / valid) * 100 : 0, killed, survived, noCoverage, valid, ...(r.zthr ? { commit: r.zthr.commit, at: r.zthr.at } : { at: '' }) };
}

export function report(name: string): BlockReport {
  const testFiles = files(join(PKG, name, 'test'), '.test.ts');
  const tests = testFiles.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^\s*it\(/gm)?.length ?? 0), 0);
  const doc = existsSync(join(ROOT, 'docs', 'blocks', `${name}.md`)) ? `docs/blocks/${name}.md` : undefined;
  const docText = doc ? readFileSync(join(ROOT, doc), 'utf8') : '';
  const srcLines = files(join(PKG, name, 'src'), '.ts').reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
  const m = mutationOf(name);
  return { ...meta(name), tests, testFiles: testFiles.map((f) => f.slice(ROOT.length + 1)), srcLines, consumers: consumers(name), doc, docHasUseFor: /## Use it for/.test(docText) && /## Not for/.test(docText), ...(m ? { mutation: m } : {}) };
}

function mutate(name: string): void {
  mkdirSync(join(ROOT, 'reports', 'blocks'), { recursive: true });
  const cfg = join(ROOT, 'reports', 'blocks', `${name}.stryker.json`);
  writeFileSync(cfg, JSON.stringify({ testRunner: 'vitest', vitest: { configFile: 'vitest.block.config.ts' }, mutate: [`packages/${name}/src/**/*.ts`], reporters: ['json', 'clear-text'], jsonReporter: { fileName: `reports/blocks/${name}.json` }, coverageAnalysis: 'perTest', concurrency: 2, timeoutMS: 20000, tempDirName: `.stryker-tmp-${name}`, cleanTempDir: 'always', thresholds: { high: 90, low: 70, break: null } }, null, 1));
  execFileSync('npx', ['stryker', 'run', cfg], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BLOCK: name } });
  const out = JSON.parse(readFileSync(mutationFile(name), 'utf8')) as Record<string, unknown>;
  out.zthr = { commit: headCommit(), at: new Date().toISOString() };
  writeFileSync(mutationFile(name), JSON.stringify(out));
}

if (process.argv[1]?.endsWith('blocks.ts')) {
  const i = process.argv.indexOf('--mutate');
  if (i >= 0) {
    const only = process.argv[i + 1];
    for (const b of only ? [only] : blockNames()) mutate(b);
  }
  const all = blockNames().map(report);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'blocks.json'), JSON.stringify({ at: new Date().toISOString(), commit: headCommit(), blocks: all }, null, 1));
  for (const b of all) console.log(`${b.name.padEnd(15)} ${String(b.tests).padStart(4)} tests  ${b.mutation ? `${b.mutation.score.toFixed(1)}% (floor ${b.floor})` : 'mutation not measured'}  used by ${b.consumers.join(', ') || 'NOTHING'}`);
}
