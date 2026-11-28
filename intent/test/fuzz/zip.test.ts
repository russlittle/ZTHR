/** Fuzz: zip (blocks/tabular zip writer + blocks/docparse unzip reader). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzip } from '../../blocks/docparse/index.ts';
import { zip } from '../../blocks/tabular/index.ts';
import { bounded, forAll } from './harness.ts';
import { fileSet, posixUnsafe } from './zip.jobs.ts';

const jobs = new URL('./zip.jobs.ts', import.meta.url);

test('unzip(zip(files)) round-trips random file sets (300 cases)', async () => {
  await forAll('zip round trip', {
    cases: 300,
    gen: (r) => fileSet(r, 8),
    shrink: (s) => s.files.map((_, i) => ({ files: s.files.filter((__, j) => j !== i) })),
    check: (s) => {
      const out = unzip(zip(s.files));
      assert.deepEqual([...out.keys()].sort(), s.files.map((f) => f.name).sort());
      for (const f of s.files) assert.ok(out.get(f.name)!.equals(f.data), `${f.name} differs`);
    },
  });
});

const HOSTILE = ['..', '../x', 'a/../../b', '/abs', '/', 'a/..', '..\\x', 'a\\..\\b', './../x', '//srv/share', '../', 'ok/../../../etc/passwd'];

test('names with .. segments or a leading / are refused, never returned (300 cases)', async () => {
  await forAll('zip hostile names', {
    cases: 300,
    gen: (r) => {
      const s = fileSet(r, 3);
      s.files.splice(r.int(0, s.files.length), 0, { name: r.pick(HOSTILE) + (r.bool() ? `/${r.pick(['x', 'y.txt'])}` : ''), data: Buffer.from('owned') });
      return s;
    },
    shrink: () => [],
    check: (s) => {
      let out: Map<string, Buffer>;
      try {
        out = unzip(zip(s.files));
      } catch {
        return;
      }
      for (const name of out.keys()) assert.ok(!posixUnsafe(name), `returned ${JSON.stringify(name)}`);
    },
  });
});

test('names that are absolute on Windows (leading backslash, drive letter) are refused (200 cases)', async () => {
  await forAll('zip windows-absolute names', {
    cases: 200,
    gen: (r) => ({ files: [{ name: r.pick(['\\evil', '\\\\srv\\share\\x', 'C:\\Windows\\x', 'C:/x', 'c:x']) + r.pick(['', '.txt', '\\y']), data: Buffer.from('x') }] }),
    shrink: () => [],
    check: (s) => {
      let out: Map<string, Buffer>;
      try {
        out = unzip(zip(s.files));
      } catch {
        return;
      }
      for (const name of out.keys()) assert.doesNotMatch(name, /^[\\/]|^[A-Za-z]:/, `returned ${JSON.stringify(name)}`);
    },
  });
});

test('mutated zips: unzip returns exactly the zipped data or throws, never an unsafe path or wrong size (3000 cases, 9 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'mutated', cases: 3000, ms: 9000 });
});

test('mutated zips: every refusal is a Refused error (3000 cases, 9 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'mutatedRefusedOnly', cases: 3000, ms: 9000 });
});

test('hostile length fields never allocate past maxTotalBytes (800 cases, 9 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'lengths', cases: 800, ms: 9000 });
});
