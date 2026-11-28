import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildFrom, cleanCopy, collect, compareDir, pack, planFromDockerfile, sha256, type Entry } from './repro.ts';

const e = (path: string, text: string, executable = false): Entry => ({ path, data: Buffer.from(text), executable });
const ENTRIES = [e('b/two.ts', 'two'), e('a/one.ts', 'one\n'), e('a/z/run.sh', '#!/bin/sh\n', true), e(`deep/${'d'.repeat(90)}/${'f'.repeat(60)}.ts`, 'long')];

test('packing depends only on paths, bytes and the executable bit: input order does not matter', () => {
  const a = pack(ENTRIES);
  const b = pack([...ENTRIES].reverse());
  assert.equal(sha256(a.tgz), sha256(b.tgz));
  assert.equal(sha256(a.tar), sha256(b.tar));
  assert.equal(sha256(pack(ENTRIES).tgz), sha256(a.tgz), 'the same input packs to the same bytes again');
});

test('any change to content, path or executable bit changes the digest', () => {
  const base = sha256(pack(ENTRIES).tgz);
  assert.notEqual(sha256(pack([...ENTRIES.slice(1), e('b/two.ts', 'two!')]).tgz), base);
  assert.notEqual(sha256(pack([...ENTRIES.slice(1), e('b/two.js', 'two')]).tgz), base);
  assert.notEqual(sha256(pack([...ENTRIES.slice(1), e('b/two.ts', 'two', true)]).tgz), base);
  assert.throws(() => pack([...ENTRIES, e('a/one.ts', 'again')]), /duplicate path/);
});

test('the gzip header carries no time, name or OS, and the archive is a valid tar that extracts to the entries', () => {
  const { tar, tgz } = pack(ENTRIES);
  assert.deepEqual([...tgz.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
  assert.ok(gunzipSync(tgz).equals(tar));
  const dir = mkdtempSync(join(tmpdir(), 'repro-test-'));
  try {
    writeFileSync(join(dir, 'x.tgz'), tgz);
    mkdirSync(join(dir, 'out'));
    const r = spawnSync('tar', ['-xzf', join(dir, 'x.tgz'), '-C', join(dir, 'out')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(compareDir(join(dir, 'out'), [...ENTRIES].sort((x, y) => (x.path < y.path ? -1 : 1))), []);
    const list = spawnSync('tar', ['-tvzf', join(dir, 'x.tgz')], { encoding: 'utf8' }).stdout;
    assert.match(list, /-rwxr-xr-x 0\/0 .* a\/z\/run\.sh/);
    assert.match(list, /-rw-r--r-- 0\/0 .* b\/two\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Dockerfile decides the artefact; an instruction whose effect is unknown fails rather than guessing', () => {
  const real = planFromDockerfile(readFileSync(fileURLToPath(new URL('../../files/Dockerfile', import.meta.url)), 'utf8'));
  assert.equal(real.workdir, '/app');
  assert.deepEqual(real.copies.map((c) => `${c.from} -> ${c.to}`), ['intent/blocks -> intent/blocks', 'files/package.json -> files/package.json', 'files/LICENSE -> files/LICENSE', 'files/src -> files/src']);
  assert.deepEqual(real.deletes, [{ dir: 'intent/blocks', glob: '*.test.ts' }]);
  assert.throws(() => planFromDockerfile('FROM x\nWORKDIR /app\nRUN npm install\n'), /RUN step not understood/);
  assert.throws(() => planFromDockerfile('FROM x\nADD https://example.com/x.tgz /app/\n'), /not understood/);
  assert.throws(() => planFromDockerfile('FROM x\nCOPY --from=build /out /app/\n'), /COPY form not understood/);
});

test('two clean copies made differently (order, mtimes, modes) build to the same digest; deleted tests are left out', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repro-repo-'));
  try {
    mkdirSync(join(repo, 'lib', 'x'), { recursive: true });
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'lib', 'x', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'lib', 'x', 'x.test.ts'), 'test\n');
    writeFileSync(join(repo, 'app', 'main.ts'), 'main\n');
    writeFileSync(join(repo, 'app', 'tool.sh'), '#!/bin/sh\n');
    chmodSync(join(repo, 'app', 'tool.sh'), 0o755);
    const plan = planFromDockerfile("FROM node:22-slim\nWORKDIR /srv\nCOPY lib/ lib/\nCOPY app/ app/\nRUN find lib -name '*.test.ts' -delete && chown -R node:node /srv\n");
    assert.deepEqual(collect(repo, plan).map((x) => x.path), ['app/main.ts', 'app/tool.sh', 'lib/x/x.ts']);
    const dirs = [cleanCopy(repo, plan, 0), cleanCopy(repo, plan, 1)];
    try {
      const [a, b] = dirs.map((d) => buildFrom(d, plan));
      assert.equal(a?.tgzSha256, b?.tgzSha256);
      assert.equal(a?.tarSha256, b?.tarSha256);
      assert.equal(a?.files, 3);
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
