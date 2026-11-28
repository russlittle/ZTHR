import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { unzip } from '../docparse/index.ts';
import { ArchiveError, SizeMismatch, UnsafePath, Zip64Required, collect, dosTime, listTar, listZip, readZipEntry, safePath, tarBuffer, tarStream, uniquePath, zipBuffer, zipStream, type Entry } from './index.ts';

const T = new Date('2026-03-05T14:07:09Z');
const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
const contents = (zip: Buffer) => {
  const { entries } = listZip(zip);
  return Object.fromEntries(entries.map((e) => [e.name, e.dir ? null : readZipEntry(zip, e).toString('utf8')]));
};
async function* gen<T>(...xs: T[]): AsyncGenerator<T> {
  for (const x of xs) yield x;
}

test('a zip round trips through our reader and through docparse, with the CRC and sizes right', async () => {
  const zip = await zipBuffer([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: text }, { name: 'empty.txt', data: '' }], { now: T });
  assert.deepEqual(contents(zip), { 'a.txt': 'hello', 'dir/b.txt': text, 'empty.txt': '' });
  const { entries } = listZip(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.uncompressedSize, e.crc32]), [['a.txt', 5, crc32('hello')], ['dir/b.txt', text.length, crc32(text)], ['empty.txt', 0, 0]]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const viaDocparse = unzip(zip);
  assert.equal(viaDocparse.get('dir/b.txt')!.toString(), text, 'a different reader agrees');
  assert.equal(zip.length < text.length, true, 'the repeated text was compressed');
});

test('compression is used when it helps, stored otherwise, and can be forced either way', async () => {
  const random = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7919 + (i >> 3) * 104729) % 251));
  const png = Buffer.from('\u0089PNG'.repeat(300), 'latin1');
  const zip = await zipBuffer([{ name: 'text.txt', data: text }, { name: 'tiny.txt', data: 'a' }, { name: 'photo.png', data: png }, { name: 'forced.bin', data: random, method: 'store' }, { name: 'forced.txt', data: 'abc', method: 'deflate' }], { now: T });
  const m = Object.fromEntries(listZip(zip).entries.map((e) => [e.name, e.method]));
  assert.deepEqual(m, { 'text.txt': 8, 'tiny.txt': 0, 'photo.png': 0, 'forced.bin': 0, 'forced.txt': 8 });
  assert.equal(readZipEntry(zip, listZip(zip).entries[3]!).equals(random), true);
});

test('names are UTF-8 (flag bit 11), folders end with a slash, and modes and times survive', async () => {
  const mtime = new Date('2025-12-31T23:59:58Z');
  const zip = await zipBuffer([{ name: 'r\u00e9sum\u00e9/\u65e5\u672c\u8a9e.txt', data: 'x', mtime, mode: 0o600 }, { name: 'r\u00e9sum\u00e9/', mtime }, { name: 'bin/run.sh', data: '#!/bin/sh', mode: 0o755, comment: 'runs it' }], { now: T, comment: 'made here' });
  const l = listZip(zip);
  assert.equal(l.comment, 'made here');
  const [a, d, r] = l.entries;
  assert.equal(a!.name, 'r\u00e9sum\u00e9/\u65e5\u672c\u8a9e.txt');
  assert.equal(a!.flags & 0x0800, 0x0800);
  assert.deepEqual([a!.mode.toString(8), d!.mode.toString(8), r!.mode.toString(8)], ['600', '755', '755']);
  assert.deepEqual([d!.dir, d!.name, d!.uncompressedSize], [true, 'r\u00e9sum\u00e9/', 0]);
  assert.equal(a!.mtime.toISOString(), '2025-12-31T23:59:58.000Z', 'the extended timestamp keeps the exact second');
  assert.deepEqual(dosTime(new Date('2026-03-05T14:07:09Z')), { date: ((2026 - 1980) << 9) | (3 << 5) | 5, time: (14 << 11) | (7 << 5) | 4 });
  assert.deepEqual(dosTime(new Date('1970-01-01T00:00:00Z')), { date: 33, time: 0 }, 'clamped to 1980');
  assert.equal(dosTime(new Date('2200-01-01T00:00:00Z')).date >> 9, 127, 'clamped to 2107');
});

test('unsafe names are refused whatever their disguise', () => {
  const bad = ['/etc/passwd', '../x', 'a/../../x', 'a/..', '..', 'C:\\Windows\\x', 'c:/x', 'a\\b', 'a//b', './', 'a/./b', '', 'a\0b', 'a\nb', 'a/\u0007', 'CON', 'dir/nul.txt', 'trailing.', 'space ', 'a:b', 'what?', 'x'.repeat(256), `${'d/'.repeat(70)}f`, 'a'.repeat(1100)];
  for (const n of bad) assert.throws(() => safePath(n), UnsafePath, JSON.stringify(n.slice(0, 30)));
  assert.equal(safePath('./a/b.txt'), 'a/b.txt');
  assert.equal(safePath('a/b/'), 'a/b/');
  assert.equal(safePath('caf\u0065\u0301.txt'), 'caf\u00e9.txt', 'names are normalised to NFC');
  assert.equal(safePath('..hidden'), '..hidden', 'a name that merely starts with dots is fine');
  assert.equal(safePath('v1.2.3/notes.md'), 'v1.2.3/notes.md');
});

test('a duplicate name (even differing only in case) and a folder with content are refused', async () => {
  await assert.rejects(zipBuffer([{ name: 'a.txt', data: '1' }, { name: 'A.TXT', data: '2' }]), (e: Error) => e instanceof UnsafePath && /already in the archive/.test(e.message));
  await assert.rejects(zipBuffer([{ name: 'dir/', data: 'oops' }]), ArchiveError);
  await assert.rejects(zipBuffer([{ name: '../escape', data: 'x' }]), UnsafePath);
  await assert.rejects(tarBuffer([{ name: 'a', data: '1' }, { name: 'A', data: '2' }]), UnsafePath);
  assert.equal(uniquePath('report.pdf', new Set()), 'report.pdf');
  assert.equal(uniquePath('report.pdf', new Set(['Report.PDF'])), 'report (1).pdf');
  assert.equal(uniquePath('d/report.tar.gz', new Set(['d/report.tar.gz', 'd/report (1).tar.gz'])), 'd/report (2).tar.gz');
  assert.equal(uniquePath('README', new Set(['readme'])), 'README (1)');
});

test('streamed entries are written with a data descriptor, and the CRC and sizes are right', async () => {
  const chunks = [Buffer.from('chunk one, '), Buffer.from('chunk two, '), 'and three'];
  const zip = await zipBuffer([{ name: 's.txt', data: gen(...chunks), size: 31 }, { name: 'after.txt', data: 'next' }], { now: T });
  const l = listZip(zip);
  const s = l.entries[0]!;
  assert.equal(s.flags & 0x0008, 0x0008);
  assert.equal(s.crc32, crc32('chunk one, chunk two, and three'));
  assert.equal(readZipEntry(zip, s).toString(), 'chunk one, chunk two, and three');
  assert.equal(readZipEntry(zip, l.entries[1]!).toString(), 'next');
  assert.equal(zip.readUInt16LE(4), 20, 'with a small size hint, no ZIP64 header is needed');
  assert.equal(l.zip64, false);
  assert.equal(unzip(zip).get('s.txt')!.toString(), 'chunk one, chunk two, and three');
});

test('a streamed entry of unknown size gets a ZIP64-ready header and a 64-bit descriptor', async () => {
  const zip = await zipBuffer([{ name: 's.bin', data: gen(Buffer.alloc(1000, 7)) }], { now: T });
  assert.equal(zip.readUInt16LE(4), 45);
  const l = listZip(zip);
  assert.equal(l.entries[0]!.uncompressedSize, 1000);
  assert.equal(readZipEntry(zip, l.entries[0]!).equals(Buffer.alloc(1000, 7)), true);
  const stored = await zipBuffer([{ name: 's.bin', data: gen(Buffer.from('abc')), method: 'store' }], { now: T });
  assert.equal(readZipEntry(stored, listZip(stored).entries[0]!).toString(), 'abc');
});

test('streaming is lazy: bytes come out before later entries are asked for, and a wrong size hint or a failing source stops the archive', async () => {
  const log: string[] = [];
  async function* entries(): AsyncGenerator<Entry> {
    log.push('make 1');
    yield { name: 'one.txt', data: 'first entry' };
    log.push('make 2');
    yield { name: 'two.txt', data: 'second entry' };
  }
  const it = zipStream(entries(), { now: T });
  const first = await it.next();
  const firstLen = (first.value as Buffer).length;
  log.push(`got ${firstLen} bytes`);
  assert.deepEqual(log, ['make 1', `got ${firstLen} bytes`], 'the first entry\'s bytes came before the second was made');
  await it.next();
  await it.next();
  assert.ok(log.includes('make 2'));
  await assert.rejects(zipBuffer([{ name: 'x', data: gen(Buffer.from('abc')), size: 5 }]), SizeMismatch);
  async function* failing() {
    yield Buffer.from('some bytes');
    throw new Error('disk gone');
  }
  await assert.rejects(zipBuffer([{ name: 'x', data: failing() }]), /disk gone/);
});

test('ZIP64: forced everywhere, and triggered by a low size threshold, the archive reads back and passes the CRC check', async () => {
  const entries: Entry[] = [{ name: 'a.txt', data: text }, { name: 'b.bin', data: Buffer.alloc(500, 1) }, { name: 'c.txt', data: gen(Buffer.from(text)) }, { name: 'd/', mtime: T }];
  const forced = await zipBuffer(entries, { now: T, zip64: 'always' });
  const lf = listZip(forced);
  assert.equal(lf.zip64, true);
  assert.deepEqual(Object.keys(contents(forced)), ['a.txt', 'b.bin', 'c.txt', 'd/']);
  assert.equal(readZipEntry(forced, lf.entries[2]!).toString(), text);
  assert.ok(forced.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'a ZIP64 end record');
  assert.ok(forced.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'and its locator');
  const low = await zipBuffer([{ name: 'small.txt', data: 'tiny' }, { name: 'big.bin', data: Buffer.alloc(600, 9), method: 'store' }, { name: 'after.txt', data: 'after the big one' }], { now: T, zip64Threshold: 300 });
  const ll = listZip(low);
  assert.equal(ll.zip64, true, 'one entry past the threshold makes the end records ZIP64');
  assert.deepEqual(ll.entries.map((e) => e.uncompressedSize), [4, 600, 17]);
  assert.equal(readZipEntry(low, ll.entries[2]!).toString(), 'after the big one', 'an entry whose offset is past the threshold is found through its ZIP64 extra field');
  assert.ok(ll.entries[2]!.offset >= 300);
});

test('ZIP64 is required, and refused when turned off or when a streamed entry outgrows its header', async () => {
  await assert.rejects(zipBuffer([{ name: 'big', data: Buffer.alloc(600), method: 'store' }], { zip64: 'never', zip64Threshold: 300 }), Zip64Required);
  await assert.rejects(zipBuffer([{ name: 'a', data: 'x' }], { zip64: 'never', zip64Threshold: 0 }), Zip64Required);
  await assert.rejects(zipBuffer([{ name: 's', data: gen(Buffer.alloc(600)), method: 'store' }], { zip64: 'never', zip64Threshold: 300 }), Zip64Required);
  await assert.rejects(zipBuffer([{ name: 'big', data: gen(Buffer.alloc(1200)), size: 100, method: 'store' }], { zip64Threshold: 1000 }), (e: Error) => e instanceof Zip64Required && /grew past 4 GiB/.test(e.message));
  const ok = await zipBuffer([{ name: 'big', data: gen(Buffer.alloc(1200)), size: 1200, method: 'store' }], { zip64Threshold: 1000, now: T });
  assert.equal(listZip(ok).entries[0]!.uncompressedSize, 1200, 'told it is big, the header is ready for it');
});

test('65,535 entries or more switch the end records to ZIP64 on their own', async () => {
  async function* many(n: number): AsyncGenerator<Entry> {
    for (let i = 0; i < n; i++) yield { name: `f/${i}`, data: '', mtime: T };
  }
  const small = await zipBuffer(many(100), { now: T });
  assert.equal(listZip(small).zip64, false);
  const big = await zipBuffer(many(65_540), { now: T });
  const l = listZip(big);
  assert.equal(l.zip64, true);
  assert.equal(l.entries.length, 65_540);
  assert.equal(l.entries[65_539]!.name, 'f/65539');
  assert.equal(big.readUInt16LE(big.length - 22 + 10), 0xffff, 'the classic record says "see ZIP64"');
});

test('limits: entry count, total bytes and the zip comment', async () => {
  await assert.rejects(zipBuffer([{ name: 'a', data: '1' }, { name: 'b', data: '2' }, { name: 'c', data: '3' }], { maxEntries: 2 }), /more than 2 entries/);
  await assert.rejects(zipBuffer([{ name: 'a', data: 'x'.repeat(100) }, { name: 'b', data: gen(Buffer.alloc(100)), size: 100 }], { maxTotalBytes: 150 }), /more than 150 bytes/);
  await assert.rejects(zipBuffer([], { comment: 'x'.repeat(70_000) }), /comment/);
  const empty = await zipBuffer([], { now: T });
  assert.equal(empty.length, 22, 'an empty archive is just the end record');
  assert.deepEqual(listZip(empty).entries, []);
});

test('the reader refuses damage: a changed byte fails the CRC, a cut file has no directory', async () => {
  const zip = await zipBuffer([{ name: 'a.txt', data: 'hello world', method: 'store' }], { now: T });
  const e = listZip(zip).entries[0]!;
  const dmg = Buffer.from(zip);
  dmg[e.offset + 30 + 5 + 9 + 2] = dmg[e.offset + 30 + 5 + 9 + 2]! ^ 1;
  assert.throws(() => readZipEntry(dmg, listZip(dmg).entries[0]!), /CRC-32 does not match/);
  assert.throws(() => listZip(zip.subarray(0, zip.length - 10)), ArchiveError);
  assert.throws(() => listZip(Buffer.from('not a zip at all, not even close')), /no end-of-central-directory/);
  const lie = Buffer.from(zip);
  lie.writeUInt32LE(0xffffffff, lie.length - 22 + 16);
  assert.throws(() => listZip(lie), /ZIP64 is signalled but the locator is missing/);
});

const tools = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });

test('independent readers agree: Python\'s zipfile verifies every CRC, including streamed and ZIP64 archives', async (t) => {
  if (tools('python3', ['--version']).error) return t.skip('python3 is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'zipw-'));
  try {
    const cases: [string, Buffer][] = [
      ['plain', await zipBuffer([{ name: 'a.txt', data: text }, { name: 'd/', mtime: T }, { name: 'd/\u00e9.bin', data: Buffer.alloc(3000, 5), method: 'store' }, { name: 'e.txt', data: '' }], { now: T })],
      ['streamed', await zipBuffer([{ name: 's.txt', data: gen(Buffer.from(text), Buffer.from(text)) }, { name: 't.txt', data: gen(Buffer.from('x')), size: 1 }], { now: T })],
      ['zip64', await zipBuffer([{ name: 'a.txt', data: text }, { name: 's.txt', data: gen(Buffer.from(text)) }], { now: T, zip64: 'always' })],
      ['zip64-low', await zipBuffer([{ name: 'a', data: Buffer.alloc(500, 3), method: 'store' }, { name: 'b', data: 'after' }], { now: T, zip64Threshold: 300 })],
    ];
    for (const [label, zip] of cases) {
      const f = join(dir, `${label}.zip`);
      writeFileSync(f, zip);
      const r = tools('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); print(bad is None, len(z.namelist()))', f]);
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.match(r.stdout, /^True \d+/, `${label}: ${r.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- tar

test('tar: headers have the right checksum and layout, data is padded to 512, and the end is two zero blocks', async () => {
  const tar = await tarBuffer([{ name: 'a.txt', data: 'hello', mtime: T, mode: 0o640 }, { name: 'dir/', mtime: T }, { name: 'dir/b.bin', data: Buffer.alloc(600, 2), mtime: T }], { now: T, uname: 'ana', gname: 'staff', uid: 1000, gid: 100 });
  assert.equal(tar.length, 512 + 512 + 512 + 512 + 1024 + 1024);
  assert.equal(tar.subarray(257, 263).toString('latin1'), 'ustar\0');
  assert.equal(tar.subarray(0, 5).toString(), 'a.txt');
  assert.equal(tar.subarray(100, 107).toString(), '0000640');
  assert.equal(tar.subarray(124, 135).toString(), '00000000005');
  assert.equal(tar.subarray(136, 147).toString(), (Math.floor(T.getTime() / 1000)).toString(8).padStart(11, '0'));
  assert.equal(tar.subarray(265, 268).toString(), 'ana');
  assert.ok(tar.subarray(tar.length - 1024).every((b) => b === 0));
  const l = listTar(tar);
  assert.deepEqual(l.map((e) => [e.name, e.type, e.size]), [['a.txt', '0', 5], ['dir/', '5', 0], ['dir/b.bin', '0', 600]]);
  assert.equal(l[0]!.data.toString(), 'hello');
  assert.equal(l[0]!.mode.toString(8), '640');
  const bad = Buffer.from(tar);
  bad[10] = bad[10]! ^ 1;
  assert.throws(() => listTar(bad), /checksum/);
});

test('tar: long paths use the prefix field when they can and a pax header when they cannot; non-ASCII names use pax', async () => {
  const mid = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}/file.txt`;
  const long = `${'x'.repeat(120)}/${'y'.repeat(120)}/z.txt`;
  const unicode = 'caf\u00e9/\u65e5\u672c\u8a9e.txt';
  const tar = await tarBuffer([{ name: mid, data: '1' }, { name: long, data: '2' }, { name: unicode, data: '3' }], { now: T });
  const l = listTar(tar);
  assert.deepEqual(l.map((e) => e.name), [mid, long, unicode]);
  assert.deepEqual(l.map((e) => e.data.toString()), ['1', '2', '3']);
  const types: string[] = [];
  for (let p = 0; p < tar.length - 1024; ) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    types.push(String.fromCharCode(h[156]!));
    p += 512 + Math.ceil(parseInt(h.subarray(124, 135).toString(), 8) / 512) * 512;
  }
  assert.deepEqual(types, ['0', 'x', '0', 'x', '0'], 'only the second and third needed pax headers');
  assert.equal(tar.subarray(345, 345 + 121).toString().startsWith('d'.repeat(60)), true, 'the first used the prefix field');
});

test('tar: sizes are checked, streamed entries need a size or are buffered, and huge sizes and fractional times go in pax records', async () => {
  await assert.rejects(tarBuffer([{ name: 'a', data: gen(Buffer.from('abc')), size: 5 }]), SizeMismatch);
  await assert.rejects(tarBuffer([{ name: 'a', data: gen(Buffer.from('abcdef')), size: 3 }]), SizeMismatch);
  const buffered = await tarBuffer([{ name: 'a', data: gen(Buffer.from('ab'), Buffer.from('cd')) }]);
  assert.equal(listTar(buffered)[0]!.data.toString(), 'abcd');
  await assert.rejects(tarBuffer([{ name: 'a', data: gen(Buffer.alloc(100)) }], { maxBuffer: 50 }), /has no size to stream by/);
  const streamed = await tarBuffer([{ name: 's', data: gen(Buffer.from('12'), Buffer.from('345')), size: 5 }]);
  assert.equal(listTar(streamed)[0]!.data.toString(), '12345');
  // A size over 8 GiB cannot be written in the 11 octal digits: it goes in a pax record (the data then fails the check, as it should).
  const it = tarStream([{ name: 'huge', data: gen(Buffer.from('x')), size: 0o77777777777 + 10, mtime: T }]);
  const first = (await it.next()).value as Buffer;
  const body = (await it.next()).value as Buffer;
  assert.equal(String.fromCharCode(first[156]!), 'x');
  assert.match(body.toString(), /^\d+ size=8589934601\n$/);
  const frac = await tarBuffer([{ name: 'f', data: 'x', mtime: new Date(1_700_000_000_250) }]);
  assert.equal(listTar(frac)[0]!.mtime, 1_700_000_000.25);
});

test('tar: unsafe names are refused the same way', async () => {
  for (const n of ['../x', '/abs', 'a\\b', 'C:/x', 'a/../b']) await assert.rejects(tarBuffer([{ name: n, data: 'x' }]), UnsafePath, n);
  await assert.rejects(tarBuffer([{ name: 'd/', data: 'x' }]), ArchiveError);
});

test('GNU tar reads what was written (when tar is installed)', async (t) => {
  if (tools('tar', ['--version']).error) return t.skip('tar is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'tarw-'));
  try {
    const tar = await tarBuffer([{ name: 'a.txt', data: 'hello' }, { name: 'dir/', mode: 0o755 }, { name: `${'x'.repeat(120)}/${'y'.repeat(120)}/z.txt`, data: 'deep' }, { name: 'caf\u00e9.txt', data: 'accent' }], { now: T });
    const f = join(dir, 'a.tar');
    writeFileSync(f, tar);
    const r = tools('tar', ['-tf', f, '--quoting-style=literal']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), ['a.txt', 'dir/', `${'x'.repeat(120)}/${'y'.repeat(120)}/z.txt`, 'caf\u00e9.txt']);
    const out = join(dir, 'out');
    spawnSync('mkdir', [out]);
    assert.equal(tools('tar', ['-xf', f, '-C', out]).status, 0);
    assert.equal(tools('cat', [join(out, 'a.txt')]).stdout, 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collect gathers a stream, and inflate of a written entry matches what went in', async () => {
  const zip = await collect(zipStream([{ name: 'a.txt', data: text }], { now: T }));
  const e = listZip(zip).entries[0]!;
  const raw = zip.subarray(e.offset + 30 + 5 + 9, e.offset + 30 + 5 + 9 + e.compressedSize);
  assert.equal(inflateRawSync(raw).toString(), text, 'a raw deflate stream any reader can inflate');
  assert.equal(e.mtime.toISOString(), T.toISOString().replace('.000Z', '.000Z'));
});
