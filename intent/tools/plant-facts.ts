/**
 * What the repository shows, gathered for the plant model: every figure here is counted from a file, from the docs'
 * own facts, or read from git at the moment of the build. Nothing is typed in. The model turns these facts into
 * where each area stands (src/console/plant-model.ts, standingOf).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAIMS_AUDIT, BLOCKS, certificates } from '../src/console/lab.ts';
import type { Facts } from '../src/console/plant-model.ts';
import { readNight } from './night.ts';
import { FACTS } from './docs.ts';
import { GATES } from './gates.ts';

const INTENT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(INTENT);

const git = (...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

const json = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;
  } catch {
    return null;
  }
};

/** The .json files under a folder, not counting those in a done/ folder, and those in done/ separately. */
const records = (dir: string): { open: number; done: number } => {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return { open: 0, done: 0 };
  const all = readdirSync(full, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
  const done = all.filter((f) => f.split('/').includes('done')).length;
  return { open: all.length - done, done };
};

const testsIn = (dir: string): number => {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return 0;
  return readdirSync(full, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.test.ts'))
    .reduce((a, f) => a + (readFileSync(join(full, f), 'utf8').match(/^\s*(?:test|it)\(/gm)?.length ?? 0), 0);
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function plantFacts(): Facts {
  const night = readNight();
  const certs = certificates(night, BLOCKS);
  const top = json<{ blocks: { studentAdvocate?: { coverage?: string } }[] }>('intent/catalog/top50.json');
  const oracle = json<{ reference?: string; steps?: unknown[] }>('files/oracle/nextcloud.json');
  const queue = records('intent/factory/queue');
  const num = (k: string) => Number(FACTS[k]!());
  const own = num('blocks.count');
  const signed = git('for-each-ref', 'refs/tags', '--format=%(contents:signature)');
  return {
    asOf: { revision: git('rev-parse', '--short', 'HEAD'), date: git('log', '-1', '--format=%cs') },
    has: (p) => existsSync(join(ROOT, p)),
    blocks: {
      own,
      plant: num('catalog.library') - own,
      tests: num('blocks.tests'),
      calibrated: certs.filter((c) => c.state !== 'not measured').length,
      certified: certs.filter((c) => c.state === 'certified').length,
      medianScore: median(night.scores.map((s) => s.score).filter((x): x is number => x !== null)),
      survivors: certs.reduce((a, c) => a + c.survivors, 0),
      repeatabilityMeasured: certs.some((c) => c.repeatability !== null),
    },
    top50: { covered: top?.blocks.filter((b) => b.studentAdvocate?.coverage === 'yes').length ?? 0, partly: top?.blocks.filter((b) => b.studentAdvocate?.coverage === 'partial').length ?? 0, total: top?.blocks.length ?? 0 },
    queue: { workOrders: queue.open, done: queue.done },
    shifts: night.shifts.length,
    gates: GATES.length,
    requiredChecks: num('checks.required'),
    deliveryStages: num('delivery.stages'),
    reviewFamilies: num('review.families'),
    personOnly: num('agents.personOnly'),
    lineChoices: num('lines.choices'),
    claims: { claims: CLAIMS_AUDIT.claims, proven: CLAIMS_AUDIT.proven, partial: CLAIMS_AUDIT.partial, unproven: CLAIMS_AUDIT.unproven },
    files: { tests: testsIn('files/test'), oracleSteps: oracle?.steps?.length ?? 0, reference: oracle?.reference ?? null },
    inService: records('intent/factory/fleet/in-service').open,
    releases: records('intent/factory/releases').open,
    signedTags: signed ? signed.split('\n').filter((l) => l.trim()).length : 0,
  };
}

