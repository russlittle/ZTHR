import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, parseSpdx, satisfies, table } from './licences.ts';
import { readProject } from './sbom.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/demo/', import.meta.url));
const ok = (expr: string): boolean => satisfies(parseSpdx(expr));

test('SPDX expressions: OR needs one allowed branch, AND needs all, WITH is judged by its licence', () => {
  assert.equal(ok('MIT'), true);
  assert.equal(ok('(MIT OR GPL-3.0-only)'), true);
  assert.equal(ok('GPL-3.0-only OR LGPL-2.1-only'), false);
  assert.equal(ok('MIT AND BSD-3-Clause'), true);
  assert.equal(ok('MIT AND GPL-2.0-only'), false);
  assert.equal(ok('Apache-2.0 WITH LLVM-exception'), true);
  assert.equal(ok('(MIT AND (ISC OR GPL-2.0-only))'), true);
  assert.equal(ok('mit'), true);
  assert.equal(ok('BlueOak-1.0.0'), true);
  assert.equal(ok('CC-BY-4.0'), false);
  assert.equal(ok('UNLICENSED'), false);
  assert.throws(() => parseSpdx('SEE LICENSE IN LICENSE.md'));
  assert.throws(() => parseSpdx('(MIT'));
});

test('the fixture: production packages checked, dev packages left out, failures named with their reason', () => {
  const rows = check(readProject(FIXTURE), 'demo');
  const by = Object.fromEntries(rows.map((r) => [`${r.name}@${r.version}`, r]));
  assert.equal(by['demo (this project)@1.2.3']?.ok, true);
  assert.equal(by['@scope/a@1.0.0']?.ok, true);
  assert.equal(by['b@1.5.0']?.ok, true, 'MIT OR GPL: the MIT branch is allowed');
  assert.equal(by['b@2.0.0']?.ok, true);
  assert.equal(by['c@1.0.0']?.ok, false, 'an optional production dependency is still shipped');
  assert.equal(by['c@1.0.0']?.reason, 'not on the allow list');
  assert.equal(by['nolic@1.0.0']?.ok, false);
  assert.equal(by['nolic@1.0.0']?.reason, 'no licence');
  assert.equal(by['devtool@3.0.0'], undefined, 'dev dependencies are not shipped and not checked');
  const t = table(rows);
  assert.match(t, /c\s+1\.0\.0\s+GPL-3\.0-only\s+lockfile\s+FAIL: not on the allow list/);
  assert.match(t, /nolic\s+1\.0\.0\s+-\s+none\s+FAIL: no licence/);
});

test('the command exits non-zero and names each failing package', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./licences.ts', import.meta.url)), FIXTURE], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL .*: c@1\.0\.0 licence GPL-3\.0-only/);
  assert.match(r.stderr, /FAIL .*: nolic@1\.0\.0 licence -: no licence/);
  assert.match(r.stdout, /5 production dependencies checked .* 2 failing/);
});
