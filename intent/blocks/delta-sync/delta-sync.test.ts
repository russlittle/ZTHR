import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, buildIndex, chooseBlockSize, compare, conflictName, CorruptPlan, Ignore, InvalidInput, nameClashes, plan, Rolling, weakChecksum } from './index.ts';

/** A repeatable stream of bytes that does not repeat itself in blocks (xorshift32). */
function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const sync = (oldData: Uint8Array, newData: Uint8Array, bs = 256) => {
  const p = plan(buildIndex(oldData, bs), newData);
  const rebuilt = apply(oldData, p);
  assert.deepEqual(rebuilt, newData, 'the plan rebuilds the new file exactly');
  return p;
};

test('the weak checksum is the rsync one: a is the byte sum, b the weighted sum', () => {
  // "abc": a = 97+98+99 = 294; b = 3*97 + 2*98 + 1*99 = 586.
  const c = weakChecksum(new TextEncoder().encode('abc'));
  assert.equal(c & 0xffff, 294);
  assert.equal(c >>> 16, 586);
  assert.equal(c, 294 + 586 * 65536);
  assert.equal(weakChecksum(new Uint8Array(0)), 0);
  assert.equal(weakChecksum(Uint8Array.of(255, 255)), ((255 * 2 + 255) << 16 | (510 & 0xffff)) >>> 0);
});

test('rolling one byte gives exactly the checksum of the new window, all the way along a file', () => {
  const data = bytes(5000, 7);
  const w = 100;
  const r = new Rolling(data.subarray(0, w));
  for (let i = 0; i + w < data.length; i++) {
    assert.equal(r.value, weakChecksum(data.subarray(i, i + w)), `window at ${i}`);
    r.roll(data[i]!, data[i + w]!);
  }
  const ff = new Uint8Array(70_000).fill(255);
  const big = new Rolling(ff.subarray(0, 66_000));
  big.roll(255, 255);
  assert.equal(big.value, weakChecksum(ff.subarray(0, 66_000)), 'the 16-bit wrap-around stays consistent');
});

test('the index lists every block with its length and hashes; the last block may be short', () => {
  const data = bytes(1000, 3);
  const idx = buildIndex(data, 256);
  assert.deepEqual(idx.blocks.map((b) => [b.index, b.length]), [[0, 256], [1, 256], [2, 256], [3, 232]]);
  assert.equal(idx.size, 1000);
  assert.equal(idx.fileHash.length, 64);
  assert.equal(idx.blocks[0]!.strong.length, 32);
  assert.deepEqual(buildIndex(data, 256), idx, 'deterministic');
  assert.deepEqual(buildIndex(new Uint8Array(0), 256).blocks, []);
  assert.throws(() => buildIndex(data, 8), InvalidInput);
  assert.throws(() => buildIndex(data, 2 ** 21), InvalidInput);
  assert.throws(() => buildIndex(data, 100.5), InvalidInput);
  assert.equal(chooseBlockSize(0), 704);
  assert.equal(chooseBlockSize(10_000_000), 3168);
  assert.equal(chooseBlockSize(2 ** 40), 131_072);
});

test('an unchanged file is one copy and no data', () => {
  const data = bytes(2000, 5);
  const p = sync(data, data);
  assert.deepEqual(p.ops, [{ type: 'copy', index: 0, count: 8 }]);
  assert.deepEqual(p.stats, { copiedBytes: 2000, literalBytes: 0, copyOps: 1 });
});

test('a change in the middle sends only the changed block; the blocks around it are copied', () => {
  const old = bytes(256 * 10, 11);
  const next = old.slice();
  next[256 * 4 + 17] = next[256 * 4 + 17]! ^ 0xff;
  const p = sync(old, next);
  assert.deepEqual(p.ops.map((o) => (o.type === 'copy' ? `copy ${o.index}x${o.count}` : `data ${o.bytes.length}`)), ['copy 0x4', 'data 256', 'copy 5x5']);
  assert.equal(p.stats.literalBytes, 256);
});

test('an insertion shifts everything after it, and the rolling window still finds the blocks', () => {
  const old = bytes(256 * 20, 13);
  const insert = bytes(37, 99);
  const next = cat(old.subarray(0, 700), insert, old.subarray(700));
  const p = sync(old, next);
  assert.ok(p.stats.literalBytes <= 256 + 37 + 256, `only the blocks around the insertion travel, not the file (${p.stats.literalBytes})`);
  assert.ok(p.stats.copiedBytes >= 256 * 17);
  const atStart = sync(old, cat(insert, old));
  assert.ok(atStart.stats.literalBytes <= 37, `an insertion at the start sends just those bytes (${atStart.stats.literalBytes})`);
});

test('a deletion, an append and a truncation, including the short last block', () => {
  const old = bytes(256 * 6 + 100, 21);
  const deleted = cat(old.subarray(0, 300), old.subarray(900));
  assert.ok(sync(old, deleted).stats.literalBytes <= 512);
  const appended = cat(old, bytes(500, 22));
  const pa = sync(old, appended);
  assert.deepEqual(pa.ops[0], { type: 'copy', index: 0, count: 6 }, 'the old short block is not a full block, so it is sent again with the new tail');
  assert.equal(pa.stats.literalBytes, 600);
  const truncated = old.subarray(0, 256 * 3);
  const pt = sync(old, truncated);
  assert.deepEqual(pt.ops, [{ type: 'copy', index: 0, count: 3 }]);
  const shortKept = cat(bytes(300, 23), old.subarray(256 * 6));
  const ps = sync(old, shortKept);
  assert.deepEqual(ps.ops[ps.ops.length - 1], { type: 'copy', index: 6, count: 1 }, 'the short block matches at the very end');
});

test('small, empty and unrelated files', () => {
  const small = bytes(100, 31);
  assert.deepEqual(sync(small, small).ops, [{ type: 'copy', index: 0, count: 1 }], 'a file shorter than a block has only a short block: matched at the end');
  const p = sync(new Uint8Array(0), bytes(500, 32));
  assert.deepEqual(p.ops.map((o) => o.type), ['data']);
  assert.deepEqual(sync(bytes(500, 33), new Uint8Array(0)).ops, []);
  assert.equal(sync(bytes(500, 34), new Uint8Array(0)).newSize, 0);
  const unrelated = sync(bytes(2048, 35), bytes(2048, 36));
  assert.equal(unrelated.stats.copiedBytes, 0);
  assert.equal(unrelated.stats.literalBytes, 2048);
  assert.equal(sync(bytes(10, 37), bytes(10, 37)).stats.literalBytes, 0);
});

test('a block with a weak checksum collision is not mistaken for the real one', () => {
  const real = bytes(64, 41);
  // Raise bytes 0 and 3 by one and lower 1 and 2 by one: the byte sum and the weighted sum do not change.
  const forged = real.slice();
  assert.ok(real[0]! < 255 && real[3]! < 255 && real[1]! > 0 && real[2]! > 0, 'room to move the bytes');
  forged[0] = real[0]! + 1;
  forged[1] = real[1]! - 1;
  forged[2] = real[2]! - 1;
  forged[3] = real[3]! + 1;
  assert.equal(weakChecksum(forged), weakChecksum(real), 'the two blocks collide on the weak checksum');
  assert.notDeepEqual(forged, real);
  const p = sync(real, forged, 64);
  assert.equal(p.stats.copiedBytes, 0, 'the strong hash refuses the forgery');
  assert.deepEqual(apply(real, p), forged);
});

test('repeated blocks are found; plans for big files stay small and quick', () => {
  const block = bytes(256, 51);
  const old = cat(block, block, block, bytes(256, 52));
  const next = cat(bytes(256, 53), block, block);
  const p = sync(old, next);
  assert.equal(p.stats.copiedBytes, 512);
  const big = bytes(1_000_000, 61);
  const edited = big.slice();
  for (let i = 0; i < 20; i++) edited[Math.floor(i * 49_999) + 5] = edited[Math.floor(i * 49_999) + 5]! ^ 1;
  const t0 = Date.now();
  const bp = plan(buildIndex(big), edited);
  const ms = Date.now() - t0;
  assert.deepEqual(apply(big, bp), edited);
  assert.ok(bp.stats.literalBytes <= 20 * 1024 * 2, `twenty one-byte edits send ${bp.stats.literalBytes} bytes of a million`);
  assert.ok(ms < 3000, `planning took ${ms} ms`);
});

test('a damaged or mismatched plan is refused, never applied', () => {
  const old = bytes(1024, 71);
  const next = cat(old.subarray(0, 500), bytes(10, 72), old.subarray(500));
  const p = plan(buildIndex(old, 256), next);
  assert.throws(() => apply(old.subarray(0, 1000), p), /old file of 1024 bytes/);
  const flipped = { ...p, ops: p.ops.map((o) => (o.type === 'data' ? { type: 'data' as const, bytes: o.bytes.map((b) => b ^ 1) } : o)) };
  assert.throws(() => apply(old, flipped), /does not match the hash/);
  assert.throws(() => apply(old, { ...p, ops: [{ type: 'copy', index: 99, count: 1 }] }), CorruptPlan);
  assert.throws(() => apply(old, { ...p, ops: [{ type: 'copy', index: 0, count: 0 }] }), /blocks that do not exist/);
  assert.throws(() => apply(old, { ...p, ops: [{ type: 'copy', index: -1, count: 1 }] }), CorruptPlan);
  assert.throws(() => apply(old, { ...p, ops: [{ type: 'copy', index: 0, count: 1000 }] }), /makes 1024 bytes, not 1034/);
  assert.throws(() => apply(old, { ...p, newSize: 100, ops: [{ type: 'copy', index: 0, count: 1000 }] }), /past the end of the new file/);
  assert.throws(() => apply(old, { ...p, ops: p.ops.slice(0, 1) }), /makes \d+ bytes/);
  assert.throws(() => apply(old, { ...p, newSize: 9e12 }), /over the limit/);
});

const e = (path: string, hash: string) => ({ path, hash });
const day = new Date('2026-11-28T10:00:00Z');

test('without a base list: new files go across, equal files are left, differing files conflict', () => {
  const acts = compare([e('a', '1'), e('b', '2'), e('c', '3')], [e('b', '2'), e('c', '9'), e('d', '4')], { device: 'laptop', date: day });
  assert.deepEqual(acts.map((a) => `${a.type}:${a.path}`), ['upload:a', 'conflict:c', 'download:d']);
  assert.equal(acts[1]!.localCopyAs, 'c (conflicted copy from laptop 2026-11-28)');
});

test('with a base list: a change on one side travels; a deletion travels only if the other side is untouched', () => {
  const base = [e('keep', '1'), e('edit-here', '1'), e('edit-there', '1'), e('del-here', '1'), e('del-there', '1'), e('del-here-edit-there', '1'), e('del-there-edit-here', '1')];
  const local = [e('keep', '1'), e('edit-here', '2'), e('edit-there', '1'), e('del-there', '1'), e('del-there-edit-here', '2')];
  const remote = [e('keep', '1'), e('edit-here', '1'), e('edit-there', '2'), e('del-here', '1'), e('del-here-edit-there', '2')];
  const acts = compare(local, remote, { base });
  const got = Object.fromEntries(acts.map((a) => [a.path, a.type]));
  assert.deepEqual(got, {
    'del-here': 'delete-remote',
    'del-here-edit-there': 'download',
    'del-there': 'delete-local',
    'del-there-edit-here': 'upload',
    'edit-here': 'upload',
    'edit-there': 'download',
  });
  assert.match(acts.find((a) => a.path === 'del-here-edit-there')!.reason, /change is kept/);
});

test('both sides changed the same file: a conflict, with a copy name that cannot collide', () => {
  const base = [e('docs/report.txt', '1'), e('docs/other.txt', '1')];
  const acts = compare([e('docs/report.txt', '2'), e('docs/other.txt', '2')], [e('docs/report.txt', '3'), e('docs/other.txt', '3'), e('docs/report (conflicted copy from pc 2026-11-28).txt', 'x')], { base, device: 'pc', date: day });
  const c = acts.filter((a) => a.type === 'conflict');
  assert.equal(c.length, 2);
  assert.equal(c[1]!.localCopyAs, 'docs/report (conflicted copy from pc 2026-11-28) 2.txt', 'a name already on the other side is not reused');
  assert.equal(c[0]!.localCopyAs, 'docs/other (conflicted copy from pc 2026-11-28).txt');
  assert.deepEqual(acts.filter((a) => a.type !== 'conflict').map((a) => a.path), ['docs/report (conflicted copy from pc 2026-11-28).txt']);
});

test('ignored paths are not compared at all', () => {
  const ignore = new Ignore(['*.tmp', 'node_modules/']);
  const acts = compare([e('a.txt', '1'), e('x.tmp', '1'), e('node_modules/m/i.js', '1')], [], { ignore });
  assert.deepEqual(acts.map((a) => a.path), ['a.txt']);
});

test('conflict names: extension kept, odd names, long names, taken names, unsafe device names', () => {
  const d = (device: string, existing?: Set<string>) => conflictName('Notes/plan.final.docx', { device, date: day, ...(existing ? { existing } : {}) });
  assert.equal(d('laptop'), 'Notes/plan.final (conflicted copy from laptop 2026-11-28).docx');
  assert.equal(conflictName('Makefile', { device: 'x', date: day }), 'Makefile (conflicted copy from x 2026-11-28)');
  assert.equal(conflictName('.env', { device: 'x', date: day }), '.env (conflicted copy from x 2026-11-28)', 'a dotfile has no extension');
  assert.equal(conflictName('a/backup.tar.gz', { device: 'x', date: day }), 'a/backup (conflicted copy from x 2026-11-28).tar.gz');
  assert.equal(d('../../etc/pass:wd*'), 'Notes/plan.final (conflicted copy from ....etcpasswd 2026-11-28).docx', 'path characters are stripped from the device name');
  assert.equal(d('///'), 'Notes/plan.final (conflicted copy from device 2026-11-28).docx');
  const first = d('laptop');
  assert.equal(d('laptop', new Set([first])), 'Notes/plan.final (conflicted copy from laptop 2026-11-28) 2.docx');
  assert.equal(d('laptop', new Set([first, d('laptop', new Set([first]))])), 'Notes/plan.final (conflicted copy from laptop 2026-11-28) 3.docx');
  const long = conflictName('é'.repeat(200) + '.txt', { device: 'laptop', date: day });
  assert.ok(new TextEncoder().encode(long).length <= 255, 'fits a file name limit in bytes');
  assert.ok(long.endsWith('(conflicted copy from laptop 2026-11-28).txt'));
  assert.doesNotMatch(long, /�/);
  assert.throws(() => conflictName('dir/', { device: 'x', date: day }), InvalidInput);
});

test('names that differ only in case or accent encoding are reported', () => {
  assert.deepEqual(nameClashes(['a/Readme.md', 'a/README.md', 'b/x', 'café', 'café']), [['a/README.md', 'a/Readme.md'], ['café', 'café'].sort()]);
  assert.deepEqual(nameClashes(['a', 'b']), []);
});

const ig = (patterns: string[], path: string) => new Ignore(patterns).ignores(path);

test('ignore patterns: names at any depth, anchoring, folders only, and comments', () => {
  assert.equal(ig(['*.tmp'], 'a/b/c.tmp'), true);
  assert.equal(ig(['*.tmp'], 'c.tmp'), true);
  assert.equal(ig(['*.tmp'], 'c.tmp.keep'), false);
  assert.equal(ig(['/build'], 'build'), true);
  assert.equal(ig(['/build'], 'src/build'), false, 'a leading slash anchors to the root');
  assert.equal(ig(['doc/*.txt'], 'doc/a.txt'), true);
  assert.equal(ig(['doc/*.txt'], 'x/doc/a.txt'), false, 'a slash in the middle anchors');
  assert.equal(ig(['doc/*.txt'], 'doc/sub/a.txt'), false, '* does not cross a slash');
  assert.equal(ig(['logs/'], 'logs'), false, 'a trailing slash is for folders');
  assert.equal(ig(['logs/'], 'logs/'), true);
  assert.equal(ig(['logs/'], 'logs/a.txt'), true, 'a file inside an ignored folder');
  assert.equal(ig(['logs/'], 'a/logs/b/c'), true);
  assert.equal(ig(['# comment', '', '   ', '*.o'], 'x.o'), true);
  assert.equal(ig(['# comment'], '# comment'), false);
  assert.equal(ig(['\\#file'], '#file'), true);
});

test('ignore patterns: ?, character classes, **, negation and the folder rule', () => {
  assert.equal(ig(['file?.txt'], 'file1.txt'), true);
  assert.equal(ig(['file?.txt'], 'file12.txt'), false);
  assert.equal(ig(['[abc].log'], 'b.log'), true);
  assert.equal(ig(['[abc].log'], 'd.log'), false);
  assert.equal(ig(['[a-c]x'], 'bx'), true);
  assert.equal(ig(['[!a-c]x'], 'bx'), false);
  assert.equal(ig(['[!a-c]x'], 'zx'), true);
  assert.equal(ig(['a/**/z'], 'a/z'), true);
  assert.equal(ig(['a/**/z'], 'a/b/c/z'), true);
  assert.equal(ig(['a/**/z'], 'b/a/z'), false);
  assert.equal(ig(['**/cache'], 'x/y/cache'), true);
  assert.equal(ig(['logs/**'], 'logs/a/b'), true);
  assert.equal(ig(['*.log', '!keep.log'], 'keep.log'), false, 'a later negation wins');
  assert.equal(ig(['*.log', '!keep.log'], 'other.log'), true);
  assert.equal(ig(['!keep.log', '*.log'], 'keep.log'), true, 'order matters');
  assert.equal(ig(['build/', '!build/keep.txt'], 'build/keep.txt'), true, 'a file in an ignored folder cannot be re-included');
  assert.equal(ig(['build/*', '!build/keep.txt'], 'build/keep.txt'), false, 'unless only the contents were ignored');
  assert.equal(ig(['a*b*c'], 'aXXbYYc'), true);
  assert.equal(ig(['a*b*c'], 'aXXbYY'), false);
});

test('hostile ignore patterns and paths finish quickly', () => {
  const t0 = Date.now();
  const evil = new Ignore(['*'.repeat(50) + 'x', '**/'.repeat(30) + 'z', 'a*a*a*a*a*a*a*a*a*b']);
  evil.ignores('a'.repeat(5000));
  evil.ignores('a/'.repeat(300) + 'q');
  assert.ok(Date.now() - t0 < 3000);
});
