/**
 * Stop the line: a red build stops new work on its branch until it is fixed. A push fails when the branch's previous
 * commit is red on a check the line stops on, unless the push is the fix: a commit in it names the red check in a
 * trailer, `Fixes-red: <check>`.
 *
 * Red is a finished run that failed: failure, timed out, or failed to start. Cancelled, skipped and still-running
 * runs are not red. The check's name is matched against both the workflow's name (Intent, Files, Supply chain) and
 * the check run's name, so it holds whatever the jobs are called.
 */
import type { Get } from './liverules.ts';

export const RED = new Set(['failure', 'timed_out', 'startup_failure']);

export interface Run {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  /** When it finished or started; the latest run of a name decides. */
  readonly at: string;
}

/** The checks among `stopOn` whose latest finished run on the commit is red. */
export function redChecks(stopOn: readonly string[], runs: readonly Run[]): string[] {
  return stopOn.filter((name) => {
    const latest = runs
      .filter((r) => r.name.toLowerCase() === name.toLowerCase())
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1);
    return Boolean(latest && latest.status === 'completed' && latest.conclusion && RED.has(latest.conclusion));
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The red checks no commit message names as fixed. */
export function unfixed(red: readonly string[], messages: readonly string[]): string[] {
  return red.filter((name) => !messages.some((m) => new RegExp(`^\\s*fixes-red:\\s*${escape(name)}\\s*$`, 'im').test(m)));
}

export interface StopVerdict {
  readonly ok: boolean;
  readonly red: readonly string[];
  readonly unfixed: readonly string[];
  readonly say: string;
}

export function decide(previous: string | null, stopOn: readonly string[], runs: readonly Run[], messages: readonly string[]): StopVerdict {
  if (!previous) return { ok: true, red: [], unfixed: [], say: 'a new branch: no previous commit to be red' };
  const red = redChecks(stopOn, runs);
  const left = unfixed(red, messages);
  if (!red.length) return { ok: true, red, unfixed: left, say: `${previous.slice(0, 12)} is not red on ${stopOn.join(', ') || 'any check the line stops on'}` };
  if (!left.length) return { ok: true, red, unfixed: left, say: `${previous.slice(0, 12)} is red on ${red.join(', ')}, and this push says it is the fix` };
  return {
    ok: false,
    red,
    unfixed: left,
    say: `the line is stopped: ${previous.slice(0, 12)} is red on ${left.join(', ')}. Fix it first; the push that fixes it says so with a trailer line ${left.map((n) => `"Fixes-red: ${n}"`).join(' and ')} in a commit message.`,
  };
}

/** Every workflow run and check run on a commit, as runs. Fails rather than reading a partial answer as green. */
export async function runsOn(repo: string, sha: string, get: Get): Promise<Run[]> {
  const w = await get(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`);
  const c = await get(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  if (w.status !== 200 || c.status !== 200) throw new Error(`could not read the runs on ${sha.slice(0, 12)} (workflow runs ${w.status}, check runs ${c.status})`);
  const wr = ((w.body as { workflow_runs?: { name: string; status: string; conclusion: string | null; updated_at: string }[] }).workflow_runs ?? []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, at: r.updated_at }));
  const cr = ((c.body as { check_runs?: { name: string; status: string; conclusion: string | null; completed_at: string | null; started_at: string }[] }).check_runs ?? []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, at: r.completed_at ?? r.started_at }));
  return [...wr, ...cr];
}
