/**
 * Shared pieces of the crew: paths, the price table and results log, the scrubbed environment model-written code
 * runs in, the acceptance gate, prompt adaptation, and the Vertex endpoint rules.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Router, staleness, type PriceTable, type Result } from '../../intent/blocks/router/index.ts';
import { mutantKey, type Mutant } from '../mutation/lib.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const FACTORY = join(ROOT, 'intent', 'factory');
export const PRICES = join(FACTORY, 'prices.json');
export const RESULTS = join(FACTORY, 'results.jsonl');
export const QUEUE = join(FACTORY, 'queue', 'mutation');
export const REPORTS = join(FACTORY, 'reports');
export const REVIEWS = join(FACTORY, 'reviews');

/** One line of results.jsonl: the router's Result plus what the morning report needs. */
export interface CrewResult extends Result {
  readonly task: string;
  /** The task file the attempt ran from. */
  readonly file?: string;
  readonly block?: string;
  readonly family: string;
  readonly runner: string;
  readonly outcome: string;
  readonly steps?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly durationMs?: number;
  readonly responseIds?: readonly string[];
  readonly reasons?: readonly string[];
  readonly why?: string;
  readonly dryRun?: boolean;
}

/** The identity of a work order across runs: mutant ids and task file names change, the mutant's content does not. */
export const taskKey = (t: { block: string; kind: string; mutant: unknown }) => `${t.block}:${t.kind}:${createHash('sha1').update(mutantKey(t.mutant as Mutant)).digest('hex').slice(0, 12)}`;

export function loadPrices(path = PRICES): PriceTable {
  return JSON.parse(readFileSync(path, 'utf8')) as PriceTable;
}

export function readResults(path = RESULTS): CrewResult[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CrewResult);
}

/** Review spending recorded in intent/factory/reviews, as neutral results, so the daily budget covers it too. */
export function reviewSpend(dir = REVIEWS): CrewResult[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { at?: string; sha?: string; seats?: { model: string; family: string; inputTokens: number; outputTokens: number; costUsd: number }[] };
      return (r.seats ?? []).filter((s) => s.model).map((s) => ({ at: r.at ?? '', task: `review:${r.sha ?? f}`, kind: 'review', model: s.model, family: s.family, runner: 'review', outcome: 'review', pass: null, inputTokens: s.inputTokens, outputTokens: s.outputTokens, costUsd: s.costUsd }));
    });
}

export function appendResult(r: CrewResult, path = RESULTS): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(r) + '\n');
}

/** A router over the committed price table and results log. Refuses a stale table unless told otherwise. */
export function openRouter(o: { now?: Date; random?: () => number; results?: readonly Result[]; prices?: PriceTable; allowStale?: boolean } = {}): Router {
  const now = o.now ?? new Date();
  const table = o.prices ?? loadPrices();
  const stale = staleness(table, now);
  if (stale.length && !o.allowStale) throw new Error(`price table unfit to route by:\n  ${stale.join('\n  ')}\nRe-read the prices from the sources in intent/factory/prices.json.`);
  return new Router(table, o.results ?? readResults(), { now, random: o.random ?? Math.random });
}

/** Variables model-written code must never see: cloud and GitHub credentials, and the crew's own settings. */
const SECRET = /^(GOOGLE_|CLOUDSDK_|GCLOUD_|GCP_|ACTIONS_|GITHUB_TOKEN$|GH_TOKEN$|ANTHROPIC_|CLAUDE_|CREW_|OPENAI_|AWS_|AZURE_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/;
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET.test(k)) out[k] = v;
  return out;
}

/** The only command a worker may run, for this task: the acceptance wrapper on the task file. */
export const acceptanceCommand = (taskFile: string) => `node tools/crew/accept.ts ${taskFile}`;

/**
 * Runs the mutation gate on a task with a scrubbed environment. CREW_ACCEPT_PREFIX, if set, is a command the gate
 * runs under (in CI: a network namespace with no network), so a test a model wrote cannot reach anything.
 */
export function runAcceptance(taskFile: string, o: { prefix?: string; timeoutMs?: number } = {}): { ok: boolean; output: string; verdict?: Record<string, unknown> } {
  const prefix = (o.prefix ?? process.env.CREW_ACCEPT_PREFIX ?? '').split(/\s+/).filter(Boolean);
  const argv = [...prefix, process.execPath, join(ROOT, 'tools', 'mutation', 'accept.ts'), taskFile];
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: ROOT, encoding: 'utf8', env: scrubbedEnv(), timeout: o.timeoutMs ?? 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const output = (r.stdout ?? '') + (r.stderr ? `\n${r.stderr}` : '');
  const start = (r.stdout ?? '').indexOf('{');
  let verdict: Record<string, unknown> | undefined;
  try {
    if (start >= 0) verdict = JSON.parse((r.stdout ?? '').slice(start)) as Record<string, unknown>;
  } catch {
    verdict = undefined;
  }
  return { ok: r.status === 0, output, ...(verdict ? { verdict } : {}) };
}

/** The task's prompt as a crew worker reads it: the gate through the wrapper, no committing, and how to claim. */
export function adaptPrompt(prompt: string, taskFile: string, how: 'tool' | 'command'): string {
  const run = how === 'tool' ? 'call the run_acceptance tool' : `run: ${acceptanceCommand(taskFile)}`;
  const none = how === 'tool' ? 'call finish with no_simplification set to true and your reason.' : 'end your final message with a line "NO SIMPLIFICATION: <why>".';
  const equivalent = how === 'tool' ? 'write nothing and call finish with equivalent set to true and the argument.' : 'write nothing and end your final message with a line "EQUIVALENT: <the argument>".';
  return (
    prompt
      .replace(/Run when done: node tools\/mutation\/accept\.ts \S+/g, `When done, ${run}`)
      .replace(/node tools\/mutation\/accept\.ts \S+/g, how === 'tool' ? 'the run_acceptance tool' : acceptanceCommand(taskFile))
      .replace(/Commit only if it prints "pass": true\./g, 'Do not commit. The dispatcher runs the gate itself and keeps your change only if it passes.')
      .replace(/run: node tools\/mutation\/equivalent\.ts --stands .*$/m, none) +
    `\n\nIf you believe the mutant is equivalent (no input can tell it from the original), ${equivalent} A judge from another model family rules on it.`
  );
}

/** Hosts the crew may call: Vertex AI, global, multi-region or regional. Nothing else. */
export function vertexHostAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && (u.hostname === 'aiplatform.googleapis.com' || /^[a-z]+-[a-z]+\d+-aiplatform\.googleapis\.com$/.test(u.hostname) || /^aiplatform\.(us|eu)\.rep\.googleapis\.com$/.test(u.hostname));
}

/** The OpenAI-compatible base for open and Gemini models on Vertex. */
export function openapiBase(project: string, location = 'global'): string {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error(`not a project id: ${project}`);
  const host = location === 'global' ? 'aiplatform.googleapis.com' : location === 'us' || location === 'eu' ? `aiplatform.${location}.rep.googleapis.com` : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

/** Claude's Messages API on Vertex (rawPredict). */
export function anthropicUrl(project: string, model: string, location = 'global'): string {
  const base = openapiBase(project, location).replace(/\/endpoints\/openapi$/, '');
  return `${base}/publishers/anthropic/models/${model}:rawPredict`;
}

/**
 * A bearer token from the runner's application default credentials (in CI, the Workload Identity Federation
 * credentials google-github-actions/auth set up). Cached for 30 minutes; tokens last 60.
 */
export function gcloudToken(): () => Promise<string> {
  let token = '';
  let at = 0;
  return async () => {
    if (token && Date.now() - at < 30 * 60_000) return token;
    const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0 || !r.stdout.trim()) throw new Error(`gcloud auth print-access-token failed: ${(r.stderr ?? '').slice(0, 300)}`);
    token = r.stdout.trim();
    at = Date.now();
    return token;
  };
}

export function git(args: string[], cwd = ROOT): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
