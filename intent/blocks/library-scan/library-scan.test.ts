import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Tree, memoryNodes } from '../tree/index.ts';
import { DEFAULT_IGNORES, IgnoreRules, ScanError, SuspiciousScan, WatchCoalescer, applyDiff, checkSafety, diffScan, loadCatalogue, type CatalogueEntry, type ScanEntry } from './index.ts';

const MB = 1_000_000;
const ce = (id: number, path: string, size: number, mtimeMs: number, extra: Partial<ScanEntry> = {}): CatalogueEntry => ({ id, path, size, mtimeMs, ...extra });
const se = (path: string, size: number, mtimeMs: number, extra: Partial<ScanEntry> = {}): ScanEntry => ({ path, size, mtimeMs, ...extra });

test('added, changed, unchanged and removed, with the modified-time tolerance of FAT', () => {
  const cat = [ce(1, 'a.mkv', 5 * MB, 1_000_000), ce(2, 'b.mkv', 6 * MB, 2_000_000), ce(3, 'c.mkv', 7 * MB, 3_000_000), ce(4, 'd.mkv', 8 * MB, 4_000_000), ce(5, 'e.mkv', 9 * MB, 5_000_000)];
  const scan = [se('a.mkv', 5 * MB, 1_001_999), se('b.mkv', 6 * MB, 2_002_001), se('c.mkv', 7 * MB + 1, 3_000_000), se('new.mkv', 1 * MB, 9_000_000), se('d.mkv', 8 * MB, 4_000_000)];
  const d = diffScan(cat, scan);
  assert.deepEqual(d.added.map((x) => x.path), ['new.mkv']);
  assert.deepEqual(d.removed.map((x) => [x.id, x.path]), [[5, 'e.mkv']]);
  assert.deepEqual(d.changed.map((x) => [x.path, ...x.why]), [['b.mkv', 'mtime'], ['c.mkv', 'size']]);
  assert.equal(d.unchanged, 2, 'a.mkv is within 2 seconds and d.mkv is identical');
  assert.deepEqual(d.moved, []);
});

test('with hashes, a touched file is unchanged and a different hash is a change', () => {
  const cat = [ce(1, 'a', 10, 1_000_000, { hash: 'sha256:aa' }), ce(2, 'b', 10, 1_000_000, { hash: 'sha256:bb' })];
  const d = diffScan(cat, [se('a', 10, 9_000_000, { hash: 'sha256:aa' }), se('b', 10, 1_000_000, { hash: 'sha256:cc' })]);
  assert.equal(d.unchanged, 1, 'same hash and size: touching does not change content');
  assert.deepEqual(d.changed.map((x) => [x.path, ...x.why]), [['b', 'hash']]);
});

test('a file the store gives the same id is the same file, even if its content changed', () => {
  const cat = [ce(7, 'Movies/old.mkv', 5 * MB, 1_000_000, { fileId: '64:1001' })];
  const d = diffScan(cat, [se('Movies/Sub/new name.mkv', 5 * MB + 10, 1_000_000, { fileId: '64:1001' })]);
  assert.deepEqual(d.moved.map((m) => [m.id, m.from, m.to, m.how, m.certain, m.alsoChanged]), [[7, 'Movies/old.mkv', 'Movies/Sub/new name.mkv', 'fileId', true, true]]);
  assert.deepEqual([d.added.length, d.removed.length], [0, 0]);
});

test('a moved file is found by hash, and a tie is broken only by the same file name', () => {
  const h = { hash: 'sha256:aa' };
  const one = diffScan([ce(1, 'x/a.mkv', 9, 1000, h)], [se('y/z/a-renamed.mkv', 9, 5000, h)]);
  assert.deepEqual(one.moved.map((m) => [m.id, m.to, m.how, m.certain]), [[1, 'y/z/a-renamed.mkv', 'hash', true]]);
  const copies = diffScan([ce(1, 'x/a.mkv', 9, 1000, h)], [se('y/a.mkv', 9, 5000, h), se('z/b.mkv', 9, 5000, h)]);
  assert.deepEqual(copies.moved.map((m) => m.to), ['y/a.mkv'], 'the copy with the same name is the move');
  assert.deepEqual(copies.added.map((a) => a.path), ['z/b.mkv'], 'the other is a new copy');
  const tie = diffScan([ce(1, 'x/a.mkv', 9, 1000, h)], [se('y/p.mkv', 9, 5000, h), se('z/q.mkv', 9, 5000, h)]);
  assert.deepEqual([tie.moved.length, tie.removed.length, tie.added.length], [0, 1, 2], 'no guessing between equals');
  const twoGone = diffScan([ce(1, 'x/a.mkv', 9, 1000, h), ce(2, 'x/b.mkv', 9, 1000, h)], [se('y/a.mkv', 9, 5000, h)]);
  assert.deepEqual(twoGone.moved.map((m) => [m.id, m.to]), [[1, 'y/a.mkv']]);
  assert.deepEqual(twoGone.removed.map((r) => r.id), [2]);
  const sizeDiffers = diffScan([ce(1, 'x/a.mkv', 9, 1000, h)], [se('y/a.mkv', 10, 1000, h)]);
  assert.equal(sizeDiffers.moved.length, 0, 'the same hash with another size is not trusted');
});

test('without ids or hashes a unique size-and-time match is a probable move; ambiguity and empty files are not guessed', () => {
  const d = diffScan([ce(1, 'a/movie.mkv', 7 * MB, 5_000_000)], [se('b/movie.mkv', 7 * MB, 5_001_500)]);
  assert.deepEqual(d.moved.map((m) => [m.how, m.certain]), [['fingerprint', false]]);
  assert.equal(diffScan([ce(1, 'a/m.mkv', 7 * MB, 5_000_000)], [se('b/m.mkv', 7 * MB, 5_003_000)]).moved.length, 0, 'outside the time tolerance');
  assert.equal(diffScan([ce(1, 'a/m.mkv', 7 * MB, 5_000_000)], [se('b/m.mkv', 7 * MB, 5_000_000)], { fingerprint: false }).moved.length, 0, 'switched off');
  const amb = diffScan([ce(1, 'a/p.mkv', 7 * MB, 5_000_000)], [se('b/q.mkv', 7 * MB, 5_000_000), se('c/r.mkv', 7 * MB, 5_000_000)]);
  assert.deepEqual([amb.moved.length, amb.added.length, amb.removed.length], [0, 2, 1]);
  const named = diffScan([ce(1, 'a/p.mkv', 7 * MB, 5_000_000)], [se('b/p.mkv', 7 * MB, 5_000_000), se('c/r.mkv', 7 * MB, 5_000_000)]);
  assert.deepEqual(named.moved.map((m) => m.to), ['b/p.mkv']);
  assert.equal(diffScan([ce(1, 'a/empty', 0, 1000)], [se('b/empty', 0, 1000)]).moved.length, 0, 'empty files look alike');
  assert.equal(diffScan([ce(1, 'a/p.mkv', 7 * MB, 5_000_000, { hash: 'sha256:aa' })], [se('b/p.mkv', 7 * MB, 5_000_000)]).moved.length, 0, 'a file with a hash is not matched by guess');
});

test('a renamed folder is summarised from its files', () => {
  const cat = [1, 2, 3].map((i) => ce(i, `Movies/Old Name/f${i}.mkv`, i * MB, 1000 * i));
  const d = diffScan(cat, [1, 2, 3].map((i) => se(`Movies/New Name/f${i}.mkv`, i * MB, 1000 * i)));
  assert.equal(d.moved.length, 3);
  assert.deepEqual(d.dirMoves, [{ from: 'Movies/Old Name', to: 'Movies/New Name', count: 3 }]);
  const filed = diffScan([ce(1, 'Movies/a.mkv', MB, 1000), ce(2, 'Movies/b.mkv', 2 * MB, 2000)], [se('Movies/2020/a.mkv', MB, 1000), se('Movies/2020/b.mkv', 2 * MB, 2000)]);
  assert.deepEqual(filed.dirMoves, [{ from: 'Movies', to: 'Movies/2020', count: 2 }]);
  const single = diffScan([ce(1, 'a/x.mkv', MB, 1000)], [se('b/x.mkv', MB, 1000)]);
  assert.deepEqual(single.dirMoves, [], 'one file is not a folder move');
  const renamed = diffScan([ce(1, 'a/x.mkv', MB, 1000), ce(2, 'a/y.mkv', 2 * MB, 2000)], [se('a/x2.mkv', MB, 1000), se('a/y2.mkv', 2 * MB, 2000)]);
  assert.equal(renamed.moved.length, 2);
  assert.deepEqual(renamed.dirMoves, [], 'renaming files is not a folder move');
});

test('case-only renames and decomposed accents are the same path where the store says so', () => {
  const cat = [ce(1, 'Movies/Café.mkv', MB, 1000), ce(2, 'Movie.MKV', MB, 1000)];
  const decomposed = 'Movies/Café.mkv';
  const d = diffScan(cat, [se(decomposed, MB, 1000), se('movie.mkv', MB, 1000)], { caseInsensitive: true });
  assert.equal(d.unchanged, 1, 'composed and decomposed are one path');
  assert.deepEqual(d.moved.map((m) => [m.from, m.to, m.how]), [['Movie.MKV', 'movie.mkv', 'case']]);
  const sensitive = diffScan([ce(2, 'Movie.MKV', MB, 1000)], [se('movie.mkv', MB, 1000)]);
  assert.deepEqual(sensitive.moved.map((m) => m.how), ['fingerprint'], 'on a case-sensitive store they are two paths, and the same size and time make it a probable move');
  assert.deepEqual([sensitive.removed.length, sensitive.added.length], [0, 0]);
});

test('ignore rules follow gitignore: globs, anchors, directories, negation and hidden parents', () => {
  const r = new IgnoreRules([...DEFAULT_IGNORES, '# comment', '', '/root-only.txt', '**/cache/', 'docs/**/*.bak', '!keep.tmp', 'Season [0-9]?/', 'trailing\\ ']);
  for (const p of ['.DS_Store', 'a/b/.DS_Store', '._hidden', 'Movies/x.part', 'a/@eaDir/thumb.jpg', 'root-only.txt', 'x/cache/y/z.bin', 'docs/a/b/old.bak', 'Season 01/ep.mkv', 'Thumbs.db']) assert.equal(r.ignores(p), true, p);
  for (const p of ['sub/root-only.txt', 'movie.mkv', 'keep.tmp', 'docs/old.mkv', 'cache.txt', 'my.partial']) assert.equal(r.ignores(p), false, p);
  assert.equal(r.ignores('cache', true), true, 'a trailing slash matches directories');
  assert.equal(r.ignores('cache', false), false, 'but not a file of that name');
  assert.equal(r.ignores('x/keep.tmp'), false);
  const reinclude = new IgnoreRules(['logs/', '!logs/important.txt']);
  assert.equal(reinclude.ignores('logs/important.txt'), true, 'a file cannot be re-included inside an ignored folder');
  assert.equal(new IgnoreRules(['*.tmp', '!keep.tmp']).ignores('keep.tmp'), false);
  assert.equal(new IgnoreRules(['a/*/c']).ignores('a/b/x/c'), false, '* does not cross a slash');
  assert.equal(new IgnoreRules(['a/**/c']).ignores('a/c'), true, '** matches no folders too');
  assert.throws(() => new IgnoreRules(['x'.repeat(501)]), /at most 500/);
  assert.throws(() => new IgnoreRules(['**/**/**/**/**/x']), /four/);
  assert.equal(new IgnoreRules(['(a+)+$']).ignores('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab'), false, 'regex syntax is plain text');
});

test('ignored files are left out of the diff, and a catalogued file that is now ignored is left alone', () => {
  const ignore = new IgnoreRules(DEFAULT_IGNORES);
  const d = diffScan([ce(1, 'a.mkv', MB, 1000), ce(2, 'junk.part', MB, 1000)], [se('a.mkv', MB, 1000), se('.DS_Store', 6, 1), se('x/._y', 6, 1), se('new.mkv', MB, 5000)], { ignore });
  assert.deepEqual([d.added.map((a) => a.path), d.removed.length, d.unchanged, d.ignored], [['new.mkv'], 0, 1, 2]);
});

test('hostile listings are refused', () => {
  const bad = (path: string, m: RegExp) => assert.throws(() => diffScan([], [se(path, 1, 1)]), m, path);
  bad('/etc/passwd', /relative/);
  bad('a/../b', /\.\./);
  bad('a//b', /empty/);
  bad('./a', /\./);
  bad('a\\b', /backslash/);
  bad('a\u0000b', /control/);
  bad('', /1 to 4096/);
  bad('x'.repeat(4097), /1 to 4096/);
  assert.throws(() => diffScan([], [se('a', -1, 1)]), /bad size/);
  assert.throws(() => diffScan([], [se('a', 1, Number.NaN)]), /bad modified time/);
  assert.throws(() => diffScan([], [se('a', 1, 1), se('a', 2, 2)]), /twice/);
  assert.throws(() => diffScan([ce(1, 'a', 1, 1), ce(2, 'a', 1, 1)], []), /twice/);
  assert.throws(() => diffScan([], [se('a', 1, 1), se('b', 1, 1)], { maxEntries: 1 }), /more than 1 entries/);
  assert.throws(() => diffScan([], [se('A', 1, 1), se('a', 1, 1)], { caseInsensitive: true }), /twice/);
});

test('a store that lists nothing, or would lose most of the catalogue, is flagged as probably not mounted', () => {
  const cat = Array.from({ length: 40 }, (_, i) => ce(i + 1, `f${i}.mkv`, MB, 1000));
  const empty = diffScan(cat, []);
  assert.deepEqual(checkSafety(empty, 40, 0), { ok: false, reason: 'the store listed no files at all' });
  const most = diffScan(cat, cat.slice(0, 10).map((c) => se(c.path, c.size, c.mtimeMs)));
  assert.deepEqual(checkSafety(most, 40, 10), { ok: false, reason: '30 of 40 catalogued files (75%) would be removed' });
  const some = diffScan(cat, cat.slice(0, 30).map((c) => se(c.path, c.size, c.mtimeMs)));
  assert.deepEqual(checkSafety(some, 40, 30), { ok: true });
  assert.deepEqual(checkSafety(diffScan(cat.slice(0, 5), []), 5, 3), { ok: true }, 'a small catalogue may really lose most of its files');
  assert.deepEqual(checkSafety(diffScan([], []), 0, 0), { ok: true });
});

function newTree() {
  let n = 0;
  return new Tree(memoryNodes(), { now: () => 1000, etag: () => `t${++n}` });
}

test('the diff is written into the tree: ids survive moves, removals and changes land, and a second scan is empty', async () => {
  const tree = newTree();
  const first = [se('Movies/A (2001)/a.mkv', 5 * MB, 1_700_000_000_000, { fileId: '1:1', hash: 'sha256:ABCD' }), se('Movies/B/b.mkv', 6 * MB, 1_700_000_001_000, { fileId: '1:2' }), se('Music/x.flac', 3 * MB, 1_700_000_002_000)];
  const applied1 = await applyDiff(tree, 'lib', diffScan([], first));
  assert.deepEqual(applied1, { added: 3, changed: 0, moved: 0, removed: 0, rejected: [] });
  const cat1 = await loadCatalogue(tree, 'lib');
  assert.deepEqual(cat1.map((c) => c.path).sort(), ['Movies/A (2001)/a.mkv', 'Movies/B/b.mkv', 'Music/x.flac']);
  const a = cat1.find((c) => c.path.endsWith('a.mkv'))!;
  assert.deepEqual([a.hash, a.fileId, a.mtimeMs, a.size], ['sha256:abcd', '1:1', 1_700_000_000_000, 5 * MB]);
  assert.deepEqual(diffScan(cat1, first).unchanged, 3);
  assert.equal(diffScan(cat1, first).added.length + diffScan(cat1, first).changed.length + diffScan(cat1, first).removed.length, 0, 'applying then scanning again finds nothing');

  const second = [se('Movies/A/a.mkv', 5 * MB, 1_700_000_000_000, { fileId: '1:1', hash: 'sha256:ABCD' }), se('Movies/B/b.mkv', 7 * MB, 1_700_000_005_000, { fileId: '1:2' }), se('Movies/C/c.mkv', MB, 1_700_000_006_000)];
  const d = diffScan(cat1, second);
  assert.deepEqual([d.moved.length, d.changed.length, d.removed.length, d.added.length], [1, 1, 1, 1]);
  const applied2 = await applyDiff(tree, 'lib', d);
  assert.deepEqual(applied2, { added: 1, changed: 1, moved: 1, removed: 1, rejected: [] });
  const cat2 = await loadCatalogue(tree, 'lib');
  assert.equal(cat2.find((c) => c.path === 'Movies/A/a.mkv')!.id, a.id, 'the moved file keeps its id');
  assert.equal(cat2.find((c) => c.path === 'Movies/B/b.mkv')!.size, 7 * MB);
  assert.equal(cat2.some((c) => c.path.startsWith('Music')), false);
  assert.equal(cat2.length, 3);
});

test('the tree refuses a scan that looks like an unmounted store unless told to go ahead, and reports names it cannot hold', async () => {
  const tree = newTree();
  const files = Array.from({ length: 30 }, (_, i) => se(`f${i}.mkv`, MB, 1_700_000_000_000 + i * 10_000));
  await applyDiff(tree, 'lib', diffScan([], files));
  const cat = await loadCatalogue(tree, 'lib');
  const nothing = diffScan(cat, []);
  await assert.rejects(() => applyDiff(tree, 'lib', nothing, { catalogueSize: 30, scannedSize: 0 }), SuspiciousScan);
  assert.equal((await loadCatalogue(tree, 'lib')).length, 30, 'nothing was removed');
  const done = await applyDiff(tree, 'lib', nothing, { confirm: true });
  assert.equal(done.removed, 30);
  const odd = await applyDiff(tree, 'lib', diffScan([], [se('ok.mkv', 1, 1000), se('trailing.mkv ', 1, 1000), se('dir /a.mkv', 1, 1000)]));
  assert.equal(odd.added, 1);
  assert.deepEqual(odd.rejected.map((r) => r.path), ['dir /a.mkv', 'trailing.mkv ']);
  assert.ok(odd.rejected[0]!.why.includes('space') && odd.rejected[1]!.why.includes('space'));
});

test('watch events settle before they are reported, and cancel, pair and collapse sensibly', () => {
  let now = 0;
  const w = new WatchCoalescer({ now: () => now, settleMs: 2000, ignore: new IgnoreRules(DEFAULT_IGNORES) });
  w.push({ type: 'create', path: 'new.mkv', at: 0 });
  for (let t = 100; t <= 1500; t += 100) w.push({ type: 'modify', path: 'new.mkv', at: t });
  now = 3000;
  assert.deepEqual(w.flush(), [], 'still being written: the last write was 1.5 seconds ago');
  now = 3500;
  assert.deepEqual(w.flush(), [{ type: 'added', path: 'new.mkv' }]);
  assert.deepEqual(w.flush(), [], 'reported once');
  w.push({ type: 'create', path: 'tmp.mkv', at: 4000 });
  w.push({ type: 'delete', path: 'tmp.mkv', at: 4100 });
  w.push({ type: 'modify', path: 'old.mkv', at: 4000 });
  w.push({ type: 'delete', path: 'gone.mkv', at: 4000 });
  w.push({ type: 'create', path: 'file.part', at: 4000 });
  w.push({ type: 'delete', path: 'swap.mkv', at: 4000 });
  w.push({ type: 'create', path: 'swap.mkv', at: 4200 });
  now = 7000;
  assert.deepEqual(w.flush(), [{ type: 'removed', path: 'gone.mkv' }, { type: 'changed', path: 'old.mkv' }, { type: 'changed', path: 'swap.mkv' }]);
  assert.equal(w.size, 0);
});

test('a moved-from with its moved-to is one move; unpaired halves become a removal or an addition', () => {
  let now = 0;
  const w = new WatchCoalescer({ now: () => now, settleMs: 1000 });
  w.push({ type: 'moved_from', path: 'a/x.mkv', cookie: 'c1', at: 0 });
  w.push({ type: 'moved_to', path: 'b/x.mkv', cookie: 'c1', at: 5 });
  w.push({ type: 'moved_from', path: 'lost.mkv', cookie: 'c2', at: 0 });
  w.push({ type: 'moved_to', path: 'arrived.mkv', cookie: 'c9', at: 0 });
  now = 2000;
  assert.deepEqual(w.flush(), [{ type: 'added', path: 'arrived.mkv' }, { type: 'moved', from: 'a/x.mkv', path: 'b/x.mkv' }, { type: 'removed', path: 'lost.mkv' }]);
  w.push({ type: 'create', path: 'n.mkv', at: 2000 });
  w.push({ type: 'moved_from', path: 'n.mkv', cookie: 'c3', at: 2100 });
  w.push({ type: 'moved_to', path: 'n2.mkv', cookie: 'c3', at: 2100 });
  now = 4000;
  assert.deepEqual(w.flush(), [{ type: 'added', path: 'n2.mkv' }], 'a file created and renamed before it settled is just added at its new name');
  const small = new WatchCoalescer({ now: () => now, maxPending: 2 });
  small.push({ type: 'modify', path: 'a', at: 0 });
  small.push({ type: 'modify', path: 'b', at: 0 });
  assert.throws(() => small.push({ type: 'modify', path: 'c', at: 0 }), /too many changes/);
  assert.throws(() => small.push({ type: 'modify', path: '../x', at: 0 }), ScanError);
});
