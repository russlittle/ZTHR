/**
 * Multi-family review of a push (Pattern 21). Three reviewers from three model families each read the change their
 * own way and return a bounded verdict:
 *
 *   context-aided  (Claude, through the Messages API on Vertex)  the diff, the commit messages and the changed files;
 *                  told to break the claim that the change does what it says
 *   unaided        (Gemini, through Vertex)                       the diff and one short context page, nothing else
 *   independent    (an open model, Vertex MaaS)                   the changed files as they now stand, on their own terms
 *
 * Each verdict is recorded with provider, model id, the provider's response id and the tree hash of the exact code
 * reviewed, to intent/factory/reviews/<sha>.json. Exit 1 if fewer than three families returned a verdict or any
 * verdict blocks: a reviewer that did not run has approved nothing.
 *
 *   node tools/crew/review.ts --repo <checkout> --base <sha> --head <sha> [--project P] [--pinned true|false]
 *
 * The workflow runs this file from the base commit, so a change cannot ship the reviewer that approves it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { round, type Model, type Router } from '../../intent/blocks/router/index.ts';
import { ROOT, gcloudToken, git, openRouter } from './lib.ts';
import { firstJson, vertexComplete, type Complete } from './models.ts';

export const SEATS = [
  { role: 'context-aided', families: ['anthropic'] },
  { role: 'unaided', families: ['google'] },
  { role: 'independent', families: ['openai', 'deepseek', 'alibaba'] },
] as const;

export interface Finding {
  severity: 'blocker' | 'major' | 'minor';
  location: string;
  expectation: string;
  support: string;
}

export interface SeatVerdict {
  role: string;
  family: string;
  provider: string;
  model: string;
  vertexId: string;
  responseId: string;
  verdict: 'pass' | 'block' | 'none';
  findings: Finding[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

export interface ReviewRecord {
  sha: string;
  base: string;
  tree: string;
  at: string;
  reviewerPinnedToBase: boolean;
  rules: string;
  seats: SeatVerdict[];
  families: string[];
  costUsd: number;
  admitted: boolean;
  why: string[];
}

/** The rules every reviewer is held to: Pattern 21 and the review question, as committed at the reviewer's commit. */
export function rules(root = ROOT): string {
  const d = JSON.parse(readFileSync(join(root, 'zthr-patterns.json'), 'utf8')) as { reviewQuestion: string; patterns: { id: string; name: string; pattern: string }[] };
  const p = d.patterns.find((x) => x.id === 'ZTHR-P21');
  if (!p) throw new Error('Pattern ZTHR-P21 is missing from zthr-patterns.json');
  return `${p.name} (ZTHR-P21)\n${p.pattern}\n\nThe review question: ${d.reviewQuestion}`;
}

const FORMAT = [
  'Reply with one JSON object and nothing else:',
  '{"verdict": "pass" | "block", "findings": [{"severity": "blocker" | "major" | "minor", "location": "file:line or behaviour", "expectation": "the expectation violated", "support": "enough to investigate"}]}',
  'Block only for a blocker: a defect, a weakened check, a security or privacy hole, or a claim the change does not meet. Every finding names a location, the expectation it violates and its support. No finding without all three.',
].join('\n');

export function prompts(role: string, input: { diff: string; messages: string; contextPage: string; files: string; rules: string }): { system: string; user: string } {
  const system = `You are the ${role} reviewer on a panel of three model families. You review a change to a repository and may block it; you cannot approve it alone.\n\nThe rules:\n${input.rules}\n\n${FORMAT}`;
  if (role === 'context-aided') return { system, user: `Try to break the claim that this change does what its commit messages say, and fits the code around it.\n\nCommit messages:\n${input.messages}\n\nChanged files as they now stand:\n${input.files}\n\nDiff:\n${input.diff}` };
  if (role === 'unaided') return { system, user: `You get the diff and one short context page, nothing else.\n\nContext page:\n${input.contextPage}\n\nDiff:\n${input.diff}` };
  return { system, user: `Read the code on its own terms: correctness, edge cases, security, tests that would not notice a defect.\n\nChanged files as they now stand:\n${input.files}\n\nDiff (for orientation):\n${input.diff}` };
}

/** A reviewer's reply as a verdict; anything unreadable is no verdict, which never admits. */
export function parseVerdict(text: string): { verdict: 'pass' | 'block' | 'none'; findings: Finding[]; error?: string } {
  const j = firstJson(text);
  if (!j || (j.verdict !== 'pass' && j.verdict !== 'block')) return { verdict: 'none', findings: [], error: 'no readable verdict' };
  const findings = (Array.isArray(j.findings) ? j.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({ severity: (['blocker', 'major', 'minor'].includes(String(f.severity)) ? f.severity : 'major') as Finding['severity'], location: String(f.location ?? ''), expectation: String(f.expectation ?? ''), support: String(f.support ?? '') }));
  const blocks = j.verdict === 'block' || findings.some((f) => f.severity === 'blocker');
  return { verdict: blocks ? 'block' : 'pass', findings };
}

export async function review(o: { repo: string; base: string; head: string; complete: Complete; router: Router; pinned: boolean; rulesText: string; at?: string }): Promise<ReviewRecord> {
  const range = `${o.base}..${o.head}`;
  const diff = git(['diff', '--unified=3', range, '--', '.', ':(exclude)package-lock.json', ':(exclude)**/package-lock.json', ':(exclude)intent/factory/reviews/**', ':(exclude)intent/factory/results.jsonl', ':(exclude)intent/factory/reports/**', ':(exclude)intent/factory/queue/**'], o.repo).out;
  const capped = diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n[diff truncated at 40,000 characters of ${diff.length}]` : diff;
  const names = git(['diff', '--name-only', '--diff-filter=AM', range], o.repo).out.split('\n').filter(Boolean);
  let budget = 40_000;
  const files = names
    .filter((n) => !n.endsWith('package-lock.json') && !/^intent\/factory\/(reviews|reports|queue)\/|^intent\/factory\/results\.jsonl$/.test(n))
    .map((n) => {
      const text = git(['show', `${o.head}:${n}`], o.repo).out;
      const take = text.slice(0, Math.min(8_000, Math.max(0, budget)));
      budget -= take.length;
      return take ? `--- ${n}\n${take}${take.length < text.length ? '\n[truncated]' : ''}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  const messages = git(['log', '--format=%h %s%n%b', range], o.repo).out.slice(0, 6_000);
  const readme = existsSync(join(o.repo, 'README.md')) ? readFileSync(join(o.repo, 'README.md'), 'utf8') : '';
  const contextPage = readme.slice(0, 2_500);
  const tree = git(['rev-parse', `${o.head}^{tree}`], o.repo).out.trim();
  const input = { diff: capped, messages, contextPage, files, rules: o.rulesText };
  const est = Math.round((capped.length + files.length + messages.length + o.rulesText.length) / 3.5) + 3_000;
  const panel = o.router.panel('review', { inputTokens: est, outputTokens: 3_000, largestRequest: est }, SEATS.map((s) => ({ role: s.role, families: [...s.families] })));
  const seats = await Promise.all(
    panel.map(async ({ role, choice }): Promise<SeatVerdict> => {
      if (choice.stop) return { role, family: '', provider: '', model: '', vertexId: '', responseId: '', verdict: 'none', findings: [], inputTokens: 0, outputTokens: 0, costUsd: 0, error: choice.detail };
      const m: Model = choice.model;
      const p = prompts(role, input);
      const base = { role, family: m.family, model: m.id, vertexId: m.vertexId };
      try {
        const c = await o.complete(m, p.system, p.user, 4_000);
        const v = parseVerdict(c.text);
        return { ...base, provider: c.provider, responseId: c.responseId, ...v, inputTokens: c.inputTokens + c.cacheReadTokens, outputTokens: c.outputTokens, costUsd: o.router.cost(m.id, { inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens }), ...(c.responseId ? {} : { error: 'no provider response id' }) };
      } catch (e) {
        return { ...base, provider: m.runner === 'claude-code' ? 'vertex-anthropic' : 'vertex-openapi', responseId: '', verdict: 'none', findings: [], inputTokens: 0, outputTokens: 0, costUsd: 0, error: (e as Error).message.slice(0, 400) };
      }
    }),
  );
  const returned = seats.filter((s) => s.verdict !== 'none' && s.responseId);
  const families = [...new Set(returned.map((s) => s.family))];
  const why: string[] = [];
  if (families.length < 3) why.push(`only ${families.length} model families returned a verdict; three are required`);
  for (const s of seats) if (s.verdict === 'block') why.push(`${s.role} (${s.model}) blocks: ${s.findings.filter((f) => f.severity === 'blocker').map((f) => `${f.location}: ${f.expectation}`).join('; ') || 'verdict block'}`);
  for (const s of seats) if (s.verdict === 'none') why.push(`${s.role}${s.model ? ` (${s.model})` : ''} returned no verdict: ${s.error ?? 'unknown'}`);
  return { sha: o.head, base: o.base, tree, at: o.at ?? new Date().toISOString(), reviewerPinnedToBase: o.pinned, rules: 'ZTHR-P21', seats, families, costUsd: round(seats.reduce((a, s) => a + s.costUsd, 0)), admitted: why.length === 0, why };
}

export function summary(r: ReviewRecord): string {
  return [
    `## Review of ${r.sha.slice(0, 12)} (tree ${r.tree.slice(0, 12)})`,
    '',
    `**${r.admitted ? 'Admitted' : 'Not admitted'}.** ${r.families.length} families returned verdicts. Cost **$${r.costUsd.toFixed(4)}**.${r.reviewerPinnedToBase ? '' : ' The reviewer ran from this commit, not its base: the first run of the reviewer.'}`,
    '',
    '| Seat | Family | Model | Provider | Response id | Verdict | Findings | Tokens in / out | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.seats.map((s) => `| ${s.role} | ${s.family || '-'} | ${s.vertexId || '-'} | ${s.provider || '-'} | \`${s.responseId || '-'}\` | ${s.verdict} | ${s.findings.length} | ${s.inputTokens} / ${s.outputTokens} | $${s.costUsd.toFixed(4)} |`),
    '',
    ...(r.why.length ? ['Why not admitted:', '', ...r.why.map((w) => `- ${w}`), ''] : []),
    ...r.seats.flatMap((s) => s.findings.map((f) => `- **${f.severity}** (${s.role}) \`${f.location}\`: ${f.expectation}. ${f.support}`)),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const repo = val('repo') ?? ROOT;
  const base = val('base');
  const head = val('head');
  const project = val('project') ?? process.env.GCP_PROJECT;
  if (!base || !head || !project) {
    console.error('usage: node tools/crew/review.ts --repo <dir> --base <sha> --head <sha> [--project P]');
    process.exit(2);
  }
  const router = openRouter({ allowStale: true, results: [] });
  const r = await review({ repo, base, head, complete: vertexComplete(project, gcloudToken()), router, pinned: val('pinned') !== 'false', rulesText: rules() });
  const dir = join(repo, 'intent', 'factory', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${head}.json`), JSON.stringify(r, null, 2) + '\n');
  const md = summary(r);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(r.admitted ? 0 : 1);
}
