/**
 * An agent cannot move its own goalposts. Every commit that touches what only a person changes (locked journey cards
 * and their lock, the people file, ratchet floors, the required checks, and this rule itself) must carry an SSH
 * signature by a person's key. The keys come from outside the range being judged: the repository variable
 * ZTHR_PERSON_KEYS, which only an administrator sets, or else the people file as it stood at the base. A key added in
 * the same push that uses it signs nothing.
 *
 * It fails closed. With no base, no person's key, or a base that is not an ancestor of the head, nothing passes.
 * When the base predates this rule, nothing is passed by default either: every commit since the base must then be a
 * person's, so the first push that carries the rule is itself signed.
 *
 * A merge commit is judged by what it adds: a protected file that matches one of its parents was judged on that
 * parent's commits; one that matches none was changed by the merge, and the merge must be signed.
 */
import { spawnSync } from 'node:child_process';
import { TIERS } from '../agents/duties.ts';
import { commitSignature, parseKey, verify, type PublicKey } from './sshsig.ts';

/** This rule's own source: present at the base means the base was already judged by it. */
export const RULE_FILE = 'intent/src/governance/goalposts.ts';

/** What only a person changes: the locked and person tiers, and the governance that enforces them. */
export const PROTECTED: readonly string[] = [
  ...TIERS.filter((t) => t.tier === 'locked' || t.tier === 'person').flatMap((t) => t.paths),
  'control/live-rules.json',
  '.github/workflows/governance.yml',
  'intent/src/governance/',
  'intent/tools/goalposts.ts',
  // The tiers this list is built from: loosening them would shrink what the next push protects.
  'intent/src/agents/duties.ts',
];

export const isProtected = (path: string, list: readonly string[] = PROTECTED) => list.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

export interface CommitFacts {
  readonly sha: string;
  readonly subject: string;
  /** Protected paths this commit itself changes (for a merge, only what matches none of its parents). */
  readonly protectedPaths: readonly string[];
  /** The fingerprint of the person's key that signed it, or why it is not signed by one. */
  readonly signed: { readonly ok: true; readonly key: string } | { readonly ok: false; readonly why: string };
}

export interface Facts {
  readonly base: string | null;
  readonly head: string;
  readonly ruleAtBase: boolean;
  readonly ancestor: boolean;
  readonly keys: readonly PublicKey[];
  readonly keySource: string;
  readonly commits: readonly CommitFacts[];
}

export interface Judgement {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

/** The decision, from the facts alone. */
export function judge(f: Facts): Judgement {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!f.base) problems.push('no base to judge from: without one, nothing since it can be checked, so nothing passes');
  if (!f.keys.length) problems.push(`no person's signing key (${f.keySource}): set the repository variable ZTHR_PERSON_KEYS, or list keys in control/people.json`);
  if (f.base && !f.ancestor) problems.push(`the base ${f.base.slice(0, 12)} is not an ancestor of ${f.head.slice(0, 12)}: history was rewritten`);
  if (problems.length) return { ok: false, problems, notes };
  const needAll = !f.ruleAtBase;
  if (needAll) notes.push(`the base ${f.base!.slice(0, 12)} predates this rule, so nothing passes by default: every commit since it must be signed by a person`);
  for (const c of f.commits) {
    const judged = needAll || c.protectedPaths.length > 0;
    if (!judged) continue;
    const what = c.protectedPaths.length ? `changes ${c.protectedPaths.slice(0, 4).join(', ')}${c.protectedPaths.length > 4 ? ', …' : ''}` : 'lands while the base predates the rule';
    if (c.signed.ok) notes.push(`${c.sha.slice(0, 12)} ${what}: signed by ${c.signed.key}`);
    else problems.push(`${c.sha.slice(0, 12)} "${c.subject}" ${what}, and is not a person's: ${c.signed.why}`);
  }
  return { ok: problems.length === 0, problems, notes };
}

const run = (repo: string, args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const out = (repo: string, args: string[]) => {
  const r = run(repo, args);
  return r.status === 0 ? r.stdout : null;
};

/** Keys from text: one key per line, or the "keys" map of a people file. */
export function keysFrom(text: string): PublicKey[] {
  let lines: string[] = text.split('\n');
  try {
    const j = JSON.parse(text) as { keys?: Record<string, string[]> };
    if (j && typeof j === 'object') lines = Object.values(j.keys ?? {}).flat();
  } catch {
    /* plain lines */
  }
  return lines.map(parseKey).filter((k): k is PublicKey => k !== null);
}

/** Read the facts from git. `envKeys` is the out-of-band trust root; without it the base's people file is used. */
export function gather(repo: string, base: string | null, head: string, envKeys?: string, protectedList: readonly string[] = PROTECTED): Facts {
  const headSha = out(repo, ['rev-parse', '--verify', `${head}^{commit}`])?.trim() ?? head;
  const baseSha = base ? (out(repo, ['rev-parse', '--verify', `${base}^{commit}`])?.trim() ?? null) : null;
  const fromEnv = envKeys?.trim() ? keysFrom(envKeys) : [];
  const fromBase = baseSha ? keysFrom(out(repo, ['show', `${baseSha}:control/people.json`]) ?? '') : [];
  const keys = envKeys?.trim() ? fromEnv : fromBase;
  const keySource = fromEnv.length ? 'ZTHR_PERSON_KEYS' : envKeys?.trim() ? 'ZTHR_PERSON_KEYS holds no Ed25519 key' : baseSha ? 'control/people.json at the base' : 'no base';
  if (!baseSha) return { base: null, head: headSha, ruleAtBase: false, ancestor: false, keys, keySource, commits: [] };
  const ancestor = run(repo, ['merge-base', '--is-ancestor', baseSha, headSha]).status === 0;
  const ruleAtBase = run(repo, ['cat-file', '-e', `${baseSha}:${RULE_FILE}`]).status === 0;
  const shas = ancestor ? (out(repo, ['rev-list', '--reverse', `${baseSha}..${headSha}`]) ?? '').split('\n').filter(Boolean) : [];
  const commits = shas.map((sha): CommitFacts => {
    const parents = (out(repo, ['rev-list', '--parents', '-n', '1', sha]) ?? '').trim().split(' ').slice(1);
    const subject = (out(repo, ['log', '-1', '--format=%s', sha]) ?? '').trim();
    const changed = (parents.length ? out(repo, ['diff', '--name-only', '--no-renames', parents[0]!, sha]) : out(repo, ['diff-tree', '--root', '-r', '--name-only', '--no-commit-id', sha])) ?? '';
    let paths = changed.split('\n').filter(Boolean).filter((p) => isProtected(p, protectedList));
    if (parents.length > 1) {
      const blob = (rev: string, p: string) => out(repo, ['rev-parse', '-q', '--verify', `${rev}:${p}`])?.trim() ?? 'absent';
      paths = paths.filter((p) => !parents.slice(1).some((q) => blob(q, p) === blob(sha, p)));
    }
    const raw = out(repo, ['cat-file', 'commit', sha]) ?? '';
    const { payload, signature } = commitSignature(raw);
    const v = !signature ? { ok: false as const, why: 'unsigned' } : /-----BEGIN PGP SIGNATURE-----/.test(signature) ? { ok: false as const, why: 'signed with a GPG key (as GitHub signs web edits, squashes and rebases), not a person’s SSH key' } : verify(payload, signature, 'git', keys);
    return { sha, subject, protectedPaths: paths, signed: v.ok ? { ok: true, key: v.key.fingerprint } : { ok: false, why: v.why } };
  });
  return { base: baseSha, head: headSha, ruleAtBase, ancestor, keys, keySource, commits };
}
