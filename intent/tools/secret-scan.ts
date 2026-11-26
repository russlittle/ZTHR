/**
 * Fails when any file, or any commit in the history, contains an API key, token or private key. Secrets live in
 * Google Cloud Secret Manager and are only ever named in code, never written.
 *
 *   node tools/secret-scan.ts            the working tree and the whole git history
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Shapes of real credentials. Each is specific enough that ordinary text does not match it. */
export const SHAPES: readonly { name: string; re: RegExp }[] = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google OAuth client secret', re: /GOCSPX-[0-9A-Za-z_-]{28}/ },
  { name: 'Google service account private key', re: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{40,}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Stripe key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  { name: 'OpenAI key', re: /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}\b/ },
  { name: 'JSON web token', re: /\beyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/ },
  { name: 'key assigned in code', re: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["'][0-9A-Za-z_\-+/=]{20,}["']/i },
];

export interface Finding {
  readonly where: string;
  readonly line: number;
  readonly shape: string;
}

/** Every credential-shaped value in a text, by line. The value itself is never returned or printed. */
export function scan(text: string, where: string): Finding[] {
  const out: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    for (const s of SHAPES) if (s.re.test(line)) out.push({ where, line: i + 1, shape: s.name });
  });
  return out;
}

const SKIP = new Set(['node_modules', '.git', '.stryker-tmp', 'reports']);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (statSync(p).size < 2_000_000) yield p;
  }
}

/** The working tree and every commit's changes. A secret removed in a later commit is still a finding. */
export function scanRepo(root: string): Finding[] {
  const out: Finding[] = [];
  for (const f of files(root)) out.push(...scan(readFileSync(f, 'utf8'), relative(root, f)));
  let history = '';
  try {
    history = execFileSync('git', ['-C', root, 'log', '--all', '-p', '--no-color', '--format=commit %H'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch {
    return [...out, { where: 'git history', line: 0, shape: 'history could not be read, so it was not checked' }];
  }
  let commit = '';
  history.split('\n').forEach((line) => {
    if (line.startsWith('commit ')) commit = line.slice(7, 19);
    else if (line.startsWith('+') && !line.startsWith('+++')) for (const f of scan(line.slice(1), `history ${commit}`)) out.push({ ...f, line: 0 });
  });
  return out;
}

if (import.meta.main) {
  const found = scanRepo(process.cwd());
  for (const f of found) console.error(`FAIL ${f.where}${f.line ? `:${f.line}` : ''}: ${f.shape}`);
  console.log(found.length ? `${found.length} secret-shaped values found; secrets belong in Secret Manager` : 'no secret-shaped values in the files or the history');
  process.exit(found.length ? 1 : 0);
}
