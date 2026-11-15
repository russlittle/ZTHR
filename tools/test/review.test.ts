// Verifies docs/review.md
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT } from '../lib.js';

const doc = readFileSync(join(ROOT, 'docs/review.md'), 'utf8');

describe('the reviewer guide tells a reviewer only what is true', () => {
  it('every file, folder and doc it names exists', () => {
    const paths = [...doc.matchAll(/`((?:apps|packages|tools|control|test)\/[^`\s]+|stryker\.config\.json)`/g)].map((m) => m[1]!.replace(/^test\//, 'apps/advocate/test/'));
    expect(paths.length).toBeGreaterThan(8);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
    const links = [...doc.matchAll(/\]\(([\w/.-]+\.md)\)/g)].map((m) => join(ROOT, 'docs', m[1]!));
    expect(links.length).toBeGreaterThan(5);
    for (const l of links) expect(existsSync(l), l).toBe(true);
  });
  it('npm run verify runs every check a push runs that needs no cloud: type check, tests, gates against their proofs, journeys, docs, facts, dependencies', () => {
    const verify = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.verify!;
    for (const step of ['npm run typecheck', 'npm test', 'GATES_VERIFY=1 npm run gates', 'npm run journeys', 'npm run docs:check', 'tools/facts.ts --check', 'tools/deps.ts']) expect(verify, step).toContain(step);
    const build = parse(readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8')) as { steps: { id: string; env?: string[] }[] };
    const ids = build.steps.map((s) => s.id);
    for (const id of ['typecheck', 'test', 'gates', 'journeys', 'docs', 'dependencies']) expect(ids, id).toContain(id);
    expect(build.steps.find((s) => s.id === 'gates')!.env).toContain('GATES_VERIFY=1');
  });
  it('the scheduled scan it names exists', () => {
    expect(doc).toContain('Security scan of the live app');
  });
});
