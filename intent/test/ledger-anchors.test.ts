/**
 * The ledger holds against someone who can write its file: a chain recomputed without the writer's key is caught by
 * the HMAC, and lines cut off the end are caught by the anchors published in release records and git tags.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentsCli } from '../src/agents/cli.ts';
import { head, ledgerOf, releaseAnchors, tagAnchor, tagAnchors, verifyLog, type LogEntry } from '../src/agents/ledger.ts';
import { call, type Context } from '../src/agents/tools.ts';
import { sha256 } from '../src/hash.ts';
import { init } from '../src/workspace.ts';

const fixture = (n: string) => new URL(`fixtures/${n}`, import.meta.url).pathname;
const KEY = Buffer.alloc(32, 0x5a);
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 27, 9, 0, tick++)).toISOString();

function world() {
  const ws = mkdtempSync(join(tmpdir(), 'zthr-ledger-'));
  init(ws, [fixture('rough.md')]);
  copyFileSync(fixture('reading-a.json'), join(ws, 'readings', 'gemini.json'));
  copyFileSync(fixture('reading-b.json'), join(ws, 'readings', 'claude.json'));
  const ledger = ledgerOf(ws, clock, KEY);
  const c: Context = { workspace: ws, ledger, session: { role: 'steward', family: 'google', agent: 'steward-1' } };
  const file = join(ledger.dir, 'log.jsonl');
  const lines = () => readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keep = (n: number) => writeFileSync(file, `${lines().slice(0, n).join('\n')}\n`);
  return { ws, ledger, c, file, lines, keep };
}

/** A chain recomputed by someone without the key: every hash right, every HMAC theirs. */
function recompute(rows: LogEntry[], forger: Buffer | null): string {
  let prev = 'genesis';
  return rows
    .map((e, i) => {
      const { hash: _h, mac: _m, ...body } = e;
      const b = { ...body, seq: i + 1, prev };
      const hash = sha256(prev + JSON.stringify(b));
      prev = hash;
      const mac = forger ? createHmac('sha256', forger).update(`zthr-ledger:${hash}`).digest('hex') : undefined;
      return JSON.stringify({ ...b, hash, ...(mac ? { mac } : {}) });
    })
    .join('\n');
}

test('a keyed chain verifies, and without the key there is no verdict', () => {
  const w = world();
  for (let i = 0; i < 3; i++) call(w.c, 'status');
  const v = verifyLog(w.ledger);
  assert.ok(v.ok && v.lines === 3, JSON.stringify(v));
  const noKey = verifyLog(ledgerOf(w.ws, clock, undefined));
  assert.ok(!noKey.ok && /no ledger key/.test(noKey.why), 'fails closed without the key');
});

test('planted: a chain edited and recomputed without the key is detected', () => {
  const w = world();
  for (let i = 0; i < 4; i++) call(w.c, 'status');
  call(w.c, 'no_such_tool');
  const rows = w.lines().map((x) => JSON.parse(x) as LogEntry);
  const edited = rows.map((r) => (r.outcome === 'refused' ? { ...r, outcome: 'ok' as const } : r));
  for (const forger of [null, Buffer.alloc(32, 1)]) {
    writeFileSync(w.file, `${recompute(edited, forger)}\n`);
    const v = verifyLog(w.ledger);
    assert.ok(!v.ok, `recomputed ${forger ? 'with another key' : 'with no HMAC'} must not verify`);
    assert.match(v.why, forger ? /not the ledger writer’s/ : /no HMAC/);
    assert.equal(v.at, 1, 'caught at the first line');
  }
  writeFileSync(w.file, `${recompute(rows.slice(0, 2), null)}\n`);
  assert.equal(verifyLog(w.ledger).ok, false, 'a shorter chain rebuilt from scratch fails too');
});

test('planted: lines cut off the end are detected against the anchor in the release record', () => {
  const w = world();
  for (let i = 0; i < 3; i++) call(w.c, 'status');
  const r = call(w.c, 'release_issue', {});
  assert.ok(r.ok, JSON.stringify(r));
  const anchors = releaseAnchors(w.ws);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0]!.seq, 3, 'the release record carries the head when it was issued');
  call(w.c, 'status');
  assert.ok(verifyLog(w.ledger, anchors).ok);
  w.keep(2);
  assert.equal(verifyLog(w.ledger).ok, true, 'without an anchor, a truncated chain still holds: this is the gap');
  const v = verifyLog(w.ledger, releaseAnchors(w.ws));
  assert.ok(!v.ok && /release 1 anchored entry 3, but the log has 2: lines were removed/.test(v.why), JSON.stringify(v));
});

test('planted: lines cut off the end are detected against a published git tag, and the CLI fails on it', () => {
  const w = world();
  const repo = mkdtempSync(join(tmpdir(), 'zthr-ledger-repo-'));
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'factory');
  for (let i = 0; i < 5; i++) call(w.c, 'status');
  const t = tagAnchor(w.ledger, repo);
  assert.equal(t.tag, 'zthr-ledger/5');
  assert.deepEqual(tagAnchors(repo).map((a) => [a.seq, a.hash]), [[5, head(w.ledger).hash]]);
  const quiet = [console.log, console.error] as const;
  let out = '';
  console.log = console.error = (...a: unknown[]) => void (out += a.join(' '));
  const before = process.env['ZTHR_LEDGER_KEY'];
  process.env['ZTHR_LEDGER_KEY'] = KEY.toString('hex');
  try {
    assert.equal(agentsCli(['verify', '--workspace', w.ws, '--factory', repo]), 0, out);
    call(w.c, 'status');
    assert.equal(agentsCli(['anchor', '--workspace', w.ws, '--factory', repo]), 0, out);
    assert.deepEqual(tagAnchors(repo).map((a) => a.seq).sort(), [5, 6], 'the CLI publishes the new head as zthr-ledger/6');
    w.keep(5);
    assert.equal(agentsCli(['anchor', '--workspace', w.ws, '--factory', repo]), 1, 'a log that no longer holds is not anchored again');
    assert.match(out, /tag zthr-ledger\/6 anchored entry 6, but the log has 5/);
    w.keep(4);
    assert.equal(agentsCli(['verify', '--workspace', w.ws, '--factory', repo]), 1);
    assert.match(out, /tag zthr-ledger\/5 anchored entry 5, but the log has 4/);
    delete process.env['ZTHR_LEDGER_KEY'];
    assert.equal(agentsCli(['verify', '--workspace', w.ws]), 1, 'and the CLI fails closed without the key');
  } finally {
    [console.log, console.error] = quiet;
    if (before === undefined) delete process.env['ZTHR_LEDGER_KEY'];
    else process.env['ZTHR_LEDGER_KEY'] = before;
  }
});
