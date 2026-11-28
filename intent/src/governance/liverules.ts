/**
 * The rules GitHub actually enforces, compared with the rules the repository says it has. Branch protection and
 * rulesets live in GitHub's settings, outside every commit, so nothing in the repository proves them; this reads them
 * live (read-only) and fails on any difference from the committed expectation, in either direction.
 *
 * Read with a plain GITHUB_TOKEN: GET /repos/{repo}/branches/{branch} (classic protection's required checks) and
 * GET /repos/{repo}/rules/branches/{branch} (every active ruleset rule that applies to the branch).
 */

/** What a branch must be held to. Required checks are named as `Context` or `Context (app N)` when pinned to an app. */
export interface BranchRules {
  readonly pull_request: boolean;
  readonly required_checks: readonly string[];
  readonly non_fast_forward: boolean;
  readonly deletion: boolean;
}

export interface Expectation {
  readonly repo: string;
  readonly branches: Readonly<Record<string, BranchRules & { readonly stop_on?: readonly string[] }>>;
}

/** GitHub's branch object, as much of it as is read. */
export interface BranchInfo {
  readonly name?: string;
  readonly protected?: boolean;
  readonly protection?: { readonly enabled?: boolean; readonly required_status_checks?: { readonly contexts?: readonly string[]; readonly checks?: readonly { readonly context: string; readonly app_id?: number | null }[] } };
}

/** One active rule from GET /rules/branches/{branch}. */
export interface Rule {
  readonly type: string;
  readonly parameters?: { readonly required_status_checks?: readonly { readonly context: string; readonly integration_id?: number | null }[] } & Record<string, unknown>;
}

const named = (context: string, app?: number | null) => (app ? `${context} (app ${app})` : context);

/** The rules in force on a branch, from what GitHub answered. */
export function normalize(branch: BranchInfo, rules: readonly Rule[]): BranchRules {
  const classic = branch.protection?.enabled ? branch.protection.required_status_checks : undefined;
  const fromClassic = classic?.checks?.length ? classic.checks.map((c) => named(c.context, c.app_id)) : (classic?.contexts ?? []);
  const fromRules = rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => named(c.context, c.integration_id)));
  return {
    pull_request: rules.some((r) => r.type === 'pull_request'),
    required_checks: [...new Set([...fromClassic, ...fromRules])].sort(),
    non_fast_forward: rules.some((r) => r.type === 'non_fast_forward'),
    deletion: rules.some((r) => r.type === 'deletion'),
  };
}

/** Every difference between what is expected and what is live, said plainly. Empty means they match. */
export function compare(branch: string, expected: BranchRules, live: BranchRules): string[] {
  const out: string[] = [];
  const flag = (k: 'pull_request' | 'non_fast_forward' | 'deletion', what: string) => {
    if (expected[k] && !live[k]) out.push(`${branch}: ${what} is expected but not enforced`);
    if (!expected[k] && live[k]) out.push(`${branch}: ${what} is enforced but not in the expectation`);
  };
  flag('pull_request', 'requiring a pull request');
  flag('non_fast_forward', 'blocking force-pushes');
  flag('deletion', 'blocking deletion');
  for (const c of expected.required_checks) if (!live.required_checks.includes(c)) out.push(`${branch}: required check "${c}" is missing`);
  for (const c of live.required_checks) if (!expected.required_checks.includes(c)) out.push(`${branch}: required check "${c}" is enforced but not in the expectation`);
  return out;
}

export type Get = (path: string) => Promise<{ status: number; body: unknown }>;

/** Read every expected branch live and compare. Any answer but 200 is a difference: nothing passes unread. */
export async function check(e: Expectation, get: Get): Promise<{ ok: boolean; differences: string[]; live: Record<string, BranchRules> }> {
  const differences: string[] = [];
  const live: Record<string, BranchRules> = {};
  for (const [branch, want] of Object.entries(e.branches)) {
    const b = await get(`/repos/${e.repo}/branches/${encodeURIComponent(branch)}`);
    const r = await get(`/repos/${e.repo}/rules/branches/${encodeURIComponent(branch)}`);
    if (b.status !== 200 || r.status !== 200 || !Array.isArray(r.body)) {
      differences.push(`${branch}: could not read the live rules (branch ${b.status}, rules ${r.status}), so they are not proven`);
      continue;
    }
    live[branch] = normalize(b.body as BranchInfo, r.body as Rule[]);
    differences.push(...compare(branch, want, live[branch]));
  }
  return { ok: differences.length === 0, differences, live };
}

/** A GitHub API reader for the tool and the workflow: read-only, with the token it is given. */
export const github = (token: string | undefined, base = 'https://api.github.com'): Get => async (path) => {
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'zthr-governance', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
