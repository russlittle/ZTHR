import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SHAPES, scan, scanRepo } from '../tools/secret-scan.ts';

// Fake keys are assembled at run time, so this file never contains one and the scanner never flags its own test.
const fake = (...parts: string[]) => parts.join('');
const PLANTED: Record<string, string> = {
  'Google API key': fake('AIza', 'Sy', 'A'.repeat(33)),
  'Google OAuth client secret': fake('GOCSPX-', 'b'.repeat(28)),
  'Google service account private key': fake('{"private_key": "', '-----BEGIN', ' PRIVATE KEY-----"}'),
  'private key': fake('-----BEGIN', ' RSA PRIVATE KEY-----'),
  'AWS access key': fake('AKIA', 'ABCDEFGHIJKLMNOP'),
  'GitHub token': fake('ghp_', 'c'.repeat(36)),
  'Slack token': fake('xoxb-', '1234567890-abcdef'),
  'Stripe key': fake('sk_live_', 'd'.repeat(24)),
  'Anthropic key': fake('sk-ant-', 'api03-', 'e'.repeat(30)),
  'OpenAI key': fake('sk-proj-', 'f'.repeat(40)),
  'JSON web token': fake('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.', 'g'.repeat(20)),
  'key assigned in code': fake('const apiKey = "', 'h'.repeat(24), '";'),
};

test('every credential shape the scanner knows is caught when planted', () => {
  for (const s of SHAPES) {
    const planted = PLANTED[s.name];
    assert.ok(planted, `no planted example for ${s.name}`);
    assert.ok(scan(`x\n${planted}\n`, 'f').some((f) => f.shape === s.name && f.line === 2), `a planted ${s.name} was not caught`);
  }
});

test('ordinary code and text that names a secret is not flagged', () => {
  const clean = [
    "const key = await secrets.get('calendar-api-key');",
    'apiKey: process.env.CALENDAR_KEY_NAME',
    'The token expires after ten minutes.',
    "password: z.string().min(12)",
    'sha256: 0f5e5b9b6c2a4e1d8f3a7c6b5a4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e',
  ].join('\n');
  assert.deepEqual(scan(clean, 'f'), []);
});

test('the scanner never reports the value it found', () => {
  const findings = scan(PLANTED['Stripe key'] ?? '', 'f');
  assert.equal(JSON.stringify(findings).includes(PLANTED['Stripe key'] ?? '?'), false);
});

test('a key committed and then removed is still caught in the history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(dir, 'config.ts'), `export const k = '${PLANTED['Google API key']}';\n`);
  git('add', '.');
  git('commit', '-qm', 'add key');
  writeFileSync(join(dir, 'config.ts'), "export const k = secrets.get('maps-key');\n");
  git('commit', '-qam', 'remove key');
  const found = scanRepo(dir);
  assert.equal(found.filter((f) => f.where.startsWith('config.ts')).length, 0, 'the working tree is clean');
  assert.ok(found.some((f) => f.where.startsWith('history') && f.shape === 'Google API key'), 'the removed key in history was missed');
});
