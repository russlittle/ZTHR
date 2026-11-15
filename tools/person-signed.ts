/**
 * What only a person changes is changed only by a person (CLAUDE.md). A commit that touches a protected path must be
 * authored by a listed person's GitHub account and verified by GitHub: signed with the person's own key, or made in
 * GitHub's web editor, which GitHub signs. An agent commits as claude-agent and holds no person's key, so it cannot
 * produce such a commit.
 *
 *   npx tsx tools/person-signed.ts <commit>
 *
 * Every commit between the commit the app now serves and <commit> is checked through GitHub's public API. A commit
 * touching a protected path that is not verified, or not by a listed person, fails the build by name.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROL } from './lib.js';

/** This file and the list of required checks are protected too, so the rule cannot be loosened by the change it judges. */
export const PROTECTED = ['control/journeys/', 'control/lock.json', 'control/people.json', 'control/ratchet-resets.jsonl', 'control/mutation-floors.json', 'control/required-checks.yaml', 'control/heldout/', 'tools/person-signed.ts'];

/** Each listed person's GitHub account. Kept here, in a protected file, so only a person can add one. */
export const GITHUB: Record<string, string> = { russ: 'russlittle' };

export interface CommitInfo {
  sha: string;
  login: string | undefined;
  verified: boolean;
  reason: string;
  files: string[];
}

export const touchesProtected = (files: string[]) => files.filter((f) => PROTECTED.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));

/** Each commit that touches a protected path without a verified signature from a listed person, with why. */
export function unsigned(commits: CommitInfo[], people: Record<string, string>): string[] {
  const logins = new Set(Object.values(people).map((l) => l.toLowerCase()));
  return commits.flatMap((c) => {
    const hit = touchesProtected(c.files);
    if (!hit.length) return [];
    const why = !c.login || !logins.has(c.login.toLowerCase()) ? `authored by ${c.login ?? 'no GitHub account'}, not a listed person` : !c.verified ? `not verified by GitHub (${c.reason})` : undefined;
    return why ? [`${c.sha.slice(0, 7)} changes ${hit.slice(0, 3).join(', ')}: ${why}`] : [];
  });
}

const API = 'https://api.github.com/repos/russlittle/ZTHR';
const APP = 'https://advocate-fsy7whk33q-uc.a.run.app';

async function json<T>(url: string): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zthr-factory', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (r.ok) return (await r.json()) as T;
    if (r.status !== 403 && r.status !== 429 && r.status < 500) throw new Error(`${url} answered ${r.status}`);
    await new Promise((res) => setTimeout(res, 5000 * (i + 1)));
  }
  throw new Error(`${url} did not answer`);
}

if (process.argv[1]?.endsWith('person-signed.ts')) {
  const head = process.argv[2];
  if (!head) {
    console.error('usage: tools/person-signed.ts <commit>');
    process.exit(2);
  }
  const listed = (JSON.parse(readFileSync(join(CONTROL, 'people.json'), 'utf8')) as { people: string[] }).people;
  const people = Object.fromEntries(listed.filter((p) => GITHUB[p]).map((p) => [p, GITHUB[p]!]));
  const served: { commit?: string } = await fetch(`${APP}/studentadvocate/version`).then((r) => (r.ok ? (r.json() as Promise<{ commit?: string }>) : {})).catch(() => ({}));
  const base = served.commit;
  // Fails closed: without a base to compare against, or without GitHub's answer, the build does not pass this step.
  if (!base) {
    console.error('The app does not report the commit it serves; the change cannot be checked against it.');
    process.exit(1);
  }
  // The rule holds from the first deployed commit that carries it; before that there is nothing to enforce it with.
  const atBase = await fetch(`${API}/contents/tools/person-signed.ts?ref=${base}`, { headers: { 'User-Agent': 'zthr-factory' } });
  if (atBase.status === 404) {
    console.log(`The commit the app serves (${base.slice(0, 7)}) predates this rule; it applies from the next deploy.`);
    process.exit(0);
  }
  const cmp = await json<{ commits: { sha: string }[]; status: string }>(`${API}/compare/${base}...${head}`);
  const commits: CommitInfo[] = [];
  for (const { sha } of cmp.commits) {
    const c = await json<{ sha: string; author: { login: string } | null; commit: { verification: { verified: boolean; reason: string } }; files: { filename: string }[] }>(`${API}/commits/${sha}`);
    commits.push({ sha: c.sha, login: c.author?.login, verified: c.commit.verification.verified, reason: c.commit.verification.reason, files: c.files.map((f) => f.filename) });
  }
  const bad = unsigned(commits, people);
  console.log(`${commits.length} commits since ${base.slice(0, 7)}; ${commits.filter((c) => touchesProtected(c.files).length).length} touch what only a person changes`);
  for (const b of bad) console.log(`NOT SIGNED ${b}`);
  if (bad.length) process.exit(1);
}
