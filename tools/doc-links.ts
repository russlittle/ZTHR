import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './lib.js';

const walk = (dir: string, keep: (p: string) => boolean): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (n === 'node_modules' || n.startsWith('.')) return [];
        return statSync(p).isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
      })
    : [];

/** Tests and docs, linked both ways. */

export interface Links {
  testsToDocs: Map<string, string[]>;
  problems: string[];
}

export function links(root = ROOT): Links {
  const tests = walk(root, (p) => p.endsWith('.test.ts')).map((p) => relative(root, p));
  const testsToDocs = new Map<string, string[]>();
  const problems: string[] = [];
  for (const t of tests) {
    const head = readFileSync(join(root, t), 'utf8').split('\n').slice(0, 6);
    const docs = head.map((l) => l.match(/^\/\/ Verifies (docs\/\S+\.md)/)?.[1]).filter((x): x is string => !!x);
    if (!docs.length) problems.push(`${t} does not say which doc it verifies`);
    for (const d of docs) if (!existsSync(join(root, d))) problems.push(`${t} names ${d}, which does not exist`);
    testsToDocs.set(t, docs);
  }
  const docs = walk(join(root, 'docs'), (p) => p.endsWith('.md')).map((p) => relative(root, p));
  for (const d of docs) {
    const body = readFileSync(join(root, d), 'utf8');
    if (!body.includes('<!-- verified-by:start -->')) continue;
    if (![...testsToDocs.values()].some((ds) => ds.includes(d))) problems.push(`${d} has no test that verifies it`);
  }
  return { testsToDocs, problems };
}

