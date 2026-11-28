/**
 * Person-only acts: no compromise of the factory can perform them. Naming a listed person is not enough; the act is
 * an SSH signature by one of that person's keys over the exact act, checked when it is made and again whenever it
 * is read. These tests act as the person with a generated key, and as an agent with a shell and no key.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentsCli } from '../src/agents/cli.ts';
import { budget } from '../src/agents/cost.ts';
import { delegation } from '../src/agents/correct.ts';
import { actTextOf, decisionOn, decisionText, ledgerOf, nextPrev, propose, proposals, readLines, type Act, type Session } from '../src/agents/ledger.ts';
import { commitSignature, parseKey, verify } from '../src/governance/sshsig.ts';
import { init } from '../src/workspace.ts';
import { testKey, type TestKey } from './governance-kit.ts';

const fixture = (n: string) => new URL(`fixtures/${n}`, import.meta.url).pathname;
const EMAIL = 'russ@example.com';
const operator: Session = { role: 'operator', family: 'deepseek', agent: 'op-1' };

function quietly<T>(f: () => T): { result: T; out: string; stdout: string } {
  const [log, err, write] = [console.log, console.error, process.stdout.write.bind(process.stdout)];
  let out = '';
  let stdout = '';
  console.log = (...a: unknown[]) => void (out += `${a.join(' ')}\n`);
  console.error = (...a: unknown[]) => void (out += `${a.join(' ')}\n`);
  process.stdout.write = ((chunk: string) => ((stdout += chunk), true)) as typeof process.stdout.write;
  try {
    const result = f();
    return { result, out, stdout };
  } finally {
    [console.log, console.error] = [log, err];
    process.stdout.write = write;
  }
}

const sshKeygen = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' }).error ? 'ssh-keygen is not installed' : false;

function setup(keys: TestKey[] = [testKey()]) {
  const ws = mkdtempSync(join(tmpdir(), 'zthr-acts-'));
  init(ws, [fixture('rough.md')]);
  const l = ledgerOf(ws);
  writeFileSync(join(l.dir, 'people.json'), JSON.stringify({ signers: [EMAIL], keys: { [EMAIL]: keys.map((k) => k.line) } }));
  const p = propose(l, operator, 'production', 'Release the bills page', 'canary held for two hours', { change: 'c-0000000001' });
  const sigFile = (text: string, k: TestKey, ns = 'zthr-intent') => {
    const f = join(mkdtempSync(join(tmpdir(), 'zthr-sig-')), 'act.txt.sig');
    writeFileSync(f, k.sign(text, ns));
    return f;
  };
  const sign = (k: TestKey, text = decisionText(p, 'signed', EMAIL), ns?: string) => quietly(() => agentsCli(['sign', p.id, '--workspace', ws, '--by', EMAIL, '--signature', sigFile(text, k, ns)]));
  return { ws, l, p, keys, sign, sigFile };
}

test('a person signs with their own key, over the hash of exactly what they decide', () => {
  const s = setup();
  const r = s.sign(s.keys[0]!);
  assert.equal(r.result, 0, r.out);
  const d = decisionOn(s.l, s.p.id);
  assert.equal(d?.decision, 'signed');
  assert.match(decisionText(s.p, 'signed', EMAIL), new RegExp(`hash: [0-9a-f]{64}`), 'the act names the proposal by hash');
});

test('planted: signing without the key is refused, and prints the act to sign instead', () => {
  const s = setup();
  const r = quietly(() => agentsCli(['sign', s.p.id, '--workspace', s.ws, '--by', EMAIL]));
  assert.equal(r.result, 1);
  assert.match(r.out, /unsigned/);
  assert.match(r.out, /ssh-keygen -Y sign -n zthr-intent/);
  assert.equal(r.stdout, decisionText(s.p, 'signed', EMAIL), 'standard output is exactly the act, ready to sign');
  assert.equal(decisionOn(s.l, s.p.id), undefined);
});

test('planted: a key that is not the person’s, a signature over another act, or another namespace, is refused', () => {
  const s = setup();
  const agentKey = testKey();
  assert.equal(s.sign(agentKey).result, 1, 'an agent’s own key');
  assert.equal(s.sign(s.keys[0]!, decisionText(s.p, 'declined', EMAIL)).result, 1, 'a signed decline used as a sign');
  assert.equal(s.sign(s.keys[0]!, decisionText({ ...s.p, body: { change: 'c-other' } }, 'signed', EMAIL)).result, 1, 'a signature over another proposal');
  assert.equal(s.sign(s.keys[0]!, undefined, 'git').result, 1, 'a git commit signature');
  assert.equal(decisionOn(s.l, s.p.id), undefined);
});

test('planted: a decision appended to the record by anyone else is no decision at all', () => {
  const s = setup();
  const forged = { proposal: s.p.id, decision: 'signed', by: EMAIL, at: '2026-11-27T00:00:00Z' };
  appendFileSync(join(s.l.dir, 'signatures.jsonl'), `${JSON.stringify(forged)}\n`);
  appendFileSync(join(s.l.dir, 'signatures.jsonl'), `${JSON.stringify({ ...forged, signature: testKey().sign(decisionText(s.p, 'signed', EMAIL), 'zthr-intent') })}\n`);
  assert.equal(decisionOn(s.l, s.p.id), undefined, 'unsigned, or signed by a key that is not listed');
  assert.equal(s.sign(s.keys[0]!).result, 0, 'and the person can still decide');
  assert.equal(decisionOn(s.l, s.p.id)?.decision, 'signed');
});

test('planted: a proposal edited after it was signed is no longer signed', () => {
  const s = setup();
  assert.equal(s.sign(s.keys[0]!).result, 0);
  const file = join(s.l.dir, 'proposals', `${s.p.id}.json`);
  writeFileSync(file, JSON.stringify({ ...s.p, body: { change: 'c-something-else' } }, null, 2));
  assert.equal(decisionOn(s.l, s.p.id), undefined);
});

test('planted: a signature by another listed signer’s key does not sign as the named person', () => {
  const s = setup();
  // Who may add a signer is itself a person's act: people.json is protected in the factory by the goalposts gate.
  const other = testKey();
  writeFileSync(join(s.l.dir, 'people.json'), JSON.stringify({ signers: [EMAIL, 'agent@example.com'], keys: { [EMAIL]: [s.keys[0]!.line], 'agent@example.com': [other.line] } }));
  const r = quietly(() => agentsCli(['sign', s.p.id, '--workspace', s.ws, '--by', EMAIL, '--signature', s.sigFile(decisionText(s.p, 'signed', EMAIL), other)]));
  assert.equal(r.result, 1, 'a signature by another listed signer’s key is not the named person’s');
});

test('standing acts are signed and chained: an unsigned file is not read, and an old act replayed does not count', () => {
  const s = setup();
  const k = s.keys[0]!;
  const act = (kind: Act['kind'], fields: Act['fields'], args: string[]) => quietly(() => agentsCli([kind, '--workspace', s.ws, '--by', EMAIL, ...args, '--signature', s.sigFile(actTextOf({ kind, fields, by: EMAIL, prev: nextPrev(s.l, kind) }), k)])).result;
  assert.equal(quietly(() => agentsCli(['budget', '--workspace', s.ws, '--by', EMAIL, '--daily', '50'])).result, 1, 'raising the ceiling without a signature is refused');
  writeFileSync(join(s.l.dir, 'budget.json'), JSON.stringify({ dailyUSD: 500, caseUSD: 100 }));
  assert.deepEqual(budget(s.l), { dailyUSD: 1, caseUSD: 0.25 }, 'planted: a file anyone writes cannot raise the ceiling');
  writeFileSync(join(s.l.dir, 'budget.json'), JSON.stringify({ dailyUSD: 0.5 }));
  assert.equal(budget(s.l).dailyUSD, 0.5, 'but it can always lower it');
  writeFileSync(join(s.l.dir, 'budget.json'), '{}');
  assert.equal(act('budget', { dailyUSD: 20, caseUSD: 5 }, ['--daily', '20', '--case', '5']), 0);
  assert.equal(budget(s.l).dailyUSD, 20);
  assert.equal(act('budget', { dailyUSD: 2, caseUSD: 0.5 }, ['--daily', '2', '--case', '0.5']), 0);
  assert.equal(budget(s.l).dailyUSD, 2);
  const rows = readLines<Act>(s.l, 'acts.jsonl');
  appendFileSync(join(s.l.dir, 'acts.jsonl'), `${JSON.stringify(rows[0])}\n`);
  assert.equal(budget(s.l).dailyUSD, 2, 'planted: the person’s earlier, higher ceiling appended again does not follow the chain');
  assert.equal(delegation(s.l).classII, false);
  assert.equal(act('delegate', { classII: true, attempts: 3 }, ['--class-ii', 'on', '--attempts', '3']), 0);
  assert.deepEqual([delegation(s.l).classII, delegation(s.l).attempts], [true, 3]);
});

test('a signature from ssh-keygen itself verifies, and so does a commit git signed with it', () => {
  const key = parseKey(readFileSync(fixture('sshsig/key.pub'), 'utf8'))!;
  assert.ok(verify(readFileSync(fixture('sshsig/act.txt')), readFileSync(fixture('sshsig/act.txt.sig'), 'utf8'), 'zthr-intent', [key]).ok);
  assert.equal(verify(`${readFileSync(fixture('sshsig/act.txt'), 'utf8')}x`, readFileSync(fixture('sshsig/act.txt.sig'), 'utf8'), 'zthr-intent', [key]).ok, false, 'one byte changed');
  const c = commitSignature(readFileSync(fixture('sshsig/commit.txt'), 'utf8'));
  assert.ok(c.signature);
  assert.ok(verify(c.payload, c.signature, 'git', [key]).ok);
  assert.equal(verify(c.payload.replace('signed by', 'signed  by'), c.signature, 'git', [key]).ok, false);
});

test('what this verifier signs in tests, ssh-keygen accepts: the format is the real one', { skip: sshKeygen }, () => {
  const k = testKey();
  const dir = mkdtempSync(join(tmpdir(), 'zthr-interop-'));
  writeFileSync(join(dir, 'act.txt'), 'zthr person act\ninterop\n');
  writeFileSync(join(dir, 'act.txt.sig'), k.sign('zthr person act\ninterop\n', 'zthr-intent'));
  writeFileSync(join(dir, 'allowed'), `p@zthr namespaces="zthr-intent" ${k.line}\n`);
  const r = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', join(dir, 'allowed'), '-I', 'p@zthr', '-n', 'zthr-intent', '-s', join(dir, 'act.txt.sig')], { input: readFileSync(join(dir, 'act.txt')), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('a security key counts only when it was touched', () => {
  const touched = testKey({ sk: true, flags: 0x01 });
  const untouched = testKey({ sk: true, flags: 0x00 });
  assert.ok(verify('act', touched.sign('act', 'zthr-intent'), 'zthr-intent', [touched.pub]).ok);
  const v = verify('act', untouched.sign('act', 'zthr-intent'), 'zthr-intent', [untouched.pub]);
  assert.ok(!v.ok && /not touched/.test(v.why));
  assert.equal(proposals(ledgerOf(mkdtempSync(join(tmpdir(), 'zthr-empty-')))).length, 0);
});

test('end to end with ssh-keygen: the act printed, signed by a person’s real key, and accepted', { skip: sshKeygen }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'zthr-e2e-'));
  const key = join(dir, 'zthr_signing');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'russ', '-f', key]).status, 0);
  const s = setup([]);
  writeFileSync(join(s.l.dir, 'people.json'), JSON.stringify({ signers: [EMAIL], keys: { [EMAIL]: [readFileSync(`${key}.pub`, 'utf8').trim()] } }));
  const printed = quietly(() => agentsCli(['sign', s.p.id, '--workspace', s.ws, '--by', EMAIL]));
  writeFileSync(join(dir, 'act.txt'), printed.stdout);
  const signed = spawnSync('ssh-keygen', ['-Y', 'sign', '-n', 'zthr-intent', '-f', key, join(dir, 'act.txt')], { encoding: 'utf8' });
  assert.equal(signed.status, 0, signed.stderr);
  const r = quietly(() => agentsCli(['sign', s.p.id, '--workspace', s.ws, '--by', EMAIL, '--signature', join(dir, 'act.txt.sig')]));
  assert.equal(r.result, 0, r.out);
  assert.equal(decisionOn(s.l, s.p.id)?.decision, 'signed');
});
