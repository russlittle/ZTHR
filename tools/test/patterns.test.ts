// Verifies docs/testing/patterns.md
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkRegister } from '@zthr/gates';
import { screen } from '@zthr/runtime';
import { links } from '../doc-links.js';
import { CONTROL, ROOT } from '../lib.js';

const y = <T>(p: string) => parse(readFileSync(`${CONTROL}/${p}`, 'utf8')) as T;
const lines = (f: string) => readFileSync(`${CONTROL}/heldout/${f}`, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('the pattern map', () => {
  const map = y<{ patterns: { n: number; name: string; implemented_in: string[]; verified_by: string[] }[] }>('patterns.yaml');
  it('names all 33 patterns once, each with files that exist and a test that proves it', () => {
    expect(map.patterns.map((p) => p.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
    for (const p of map.patterns) for (const f of [...p.implemented_in, ...p.verified_by]) expect(existsSync(`${ROOT}${f}`), `${p.n} ${p.name}: ${f}`).toBe(true);
  });
});

describe('parts catalog with purpose notes (Pattern 2)', () => {
  it('every package has a block document that says what it is for and what it is not for', () => {
    for (const pkg of readdirSync(`${ROOT}packages`)) {
      const doc = `${ROOT}docs/blocks/${pkg}.md`;
      expect(existsSync(doc), pkg).toBe(true);
      const s = readFileSync(doc, 'utf8');
      expect(s, pkg).toMatch(/## Use it for\n\n.{20,}/);
      expect(s, pkg).toMatch(/## Not for\n\n.{20,}/);
    }
  });
});

describe('authorship tiers (Pattern 6)', () => {
  it('loosening a locked card is refused to anyone not listed, and the lock is unchanged', () => {
    const before = readFileSync(`${CONTROL}/lock.json`, 'utf8');
    const r = spawnSync('npx', ['tsx', 'tools/lock.ts', '--by', 'claude-agent', '--direction', 'loosen', '--reason', 'make the goal easier to pass'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/destructive/);
    expect(readFileSync(`${CONTROL}/lock.json`, 'utf8')).toBe(before);
  });
  it('every tier names a guard, and the open tier is last', () => {
    const t = y<{ tiers: { tier: string; guard: string; paths: string[] }[] }>('authorship.yaml').tiers;
    expect(t.at(-1)!.paths).toContain('');
    for (const x of t) expect(x.guard.length).toBeGreaterThan(2);
  });
});

describe('zero-bypass admission (Pattern 7) and done means serving (Pattern 23)', () => {
  const pipeline = parse(readFileSync(`${ROOT}cloudbuild.yaml`, 'utf8')) as { steps: { id: string; args?: string[] }[] };
  const ids = pipeline.steps.map((s) => s.id);
  it('every required check is a step in the live pipeline', () => {
    for (const r of y<{ required: { step: string }[] }>('required-checks.yaml').required) expect(ids, r.step).toContain(r.step);
  });
  it('after deploying, the pipeline checks that the public URL serves the commit that passed', () => {
    expect(ids.indexOf('verify-serving')).toBe(ids.indexOf('deploy') + 1);
    expect(pipeline.steps.find((s) => s.id === 'verify-serving')!.args!.join(' ')).toMatch(/studentadvocate\/version[\s\S]*COMMIT[\s\S]*exit 1/);
    expect(pipeline.steps.find((s) => s.id === 'deploy')!.args!.join(' ')).toMatch(/BUILD_COMMIT=\$\$COMMIT/);
    expect(readFileSync(`${ROOT}apps/advocate/src/server/main.ts`, 'utf8')).toMatch(/commit: process\.env\.BUILD_COMMIT/);
    expect(readFileSync(`${ROOT}apps/advocate/src/server/app.ts`, 'utf8')).toMatch(/app\.get\('\/version'[^\n]*commit: process\.env\.BUILD_COMMIT/);
  });
});

describe('register, don\'t suppress (Pattern 13)', () => {
  it('every accepted finding has a description, an owner, a reason and an expiry still ahead', () => {
    const r = y<{ findings: { id: string; gate: string; finding: string; reason: string; owner: string; expires: string }[] }>('register.yaml').findings;
    expect(checkRegister(r.map((f) => ({ ...f, expires: String(f.expires) }))).status).toBe('pass');
    for (const f of r) expect(f.finding.length, f.id).toBeGreaterThan(20);
  });
});

describe('documentation derived from the system (Pattern 14)', () => {
  it('every test names the documents it verifies, and every document is verified', () => {
    expect(links().problems).toEqual([]);
  });
});

describe('held out means held out (Pattern 32)', () => {
  it('the safety screen catches every held-out crisis line it was never tuned on', () => {
    for (const l of lines('crisis.txt')) expect(screen(l).crisis, l).toBe(true);
  });
  it('no held-out line appears in any rule', () => {
    const rules = ['packages/runtime/src/safety.ts', 'apps/advocate/src/domain/crisis.ts', 'apps/advocate/src/domain/community.ts', 'apps/advocate/src/domain/i18n.ts'].map((f) => readFileSync(`${ROOT}${f}`, 'utf8').toLowerCase());
    for (const l of [...lines('crisis.txt'), ...lines('community.txt')]) for (const r of rules) expect(r.includes(l.toLowerCase()), l).toBe(false);
  });
});
