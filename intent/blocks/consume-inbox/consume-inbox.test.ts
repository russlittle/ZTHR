import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Classifier } from '../doc-classify/index.ts';
import { Queue } from '../jobs/index.ts';
import { FolderSource, Inbox, MailSource, Rejected, checkHook, hookEnv, memorySeen, nodeRunner, runHooks, sha256, sniff, splitPages } from './index.ts';
import type { Hook, MailMessage, PageInfo, Runner, Stored } from './index.ts';

const pdf = (s = 'one') => Buffer.from(`%PDF-1.7\n${s}\n%%EOF`);
const pngBytes = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)]);
const clock = () => ({ t: Date.parse('2025-05-05T10:00:00Z') });

const classifier = new Classifier({
  correspondents: [{ id: 'c-bank', name: 'First Bank', rule: { algorithm: 'any', pattern: 'firstbank' } }],
  types: [{ id: 't-stmt', name: 'Statement', rule: { algorithm: 'any', pattern: 'statement' } }],
  storagePaths: [{ id: 'p', name: 'Money', rule: { algorithm: 'any', pattern: 'statement' }, template: '{correspondent}/{created_year}/{title}' }],
});

const make = (o: Partial<ConstructorParameters<typeof Inbox>[0]> = {}, sources: ConstructorParameters<typeof Inbox>[1] = []) => {
  const c = clock();
  const stored: Stored[] = [];
  let n = 0;
  const inbox = new Inbox({ classifier, seen: memorySeen(), store: async (d) => void stored.push(d), now: () => new Date(c.t), newId: () => `doc${++n}`, ...o }, sources);
  return { inbox, stored, c };
};
const mem = (name: string, bytes: Uint8Array, source = 'mem') => ({ source, name, size: bytes.length, modified: 1, read: async () => bytes });
const nullSource = { name: 'mem', list: async () => [], done: async () => {} };
const log: string[] = [];
const spySource = { name: 'mem', list: async () => [], done: async (i: { name: string }, o: string) => void log.push(`${i.name}:${o}`) };

test('files are recognised by their first bytes, not their names', () => {
  assert.equal(sniff(pdf()), 'pdf');
  assert.equal(sniff(pngBytes(10)), 'png');
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpeg');
  assert.equal(sniff(Buffer.from([0x49, 0x49, 0x2a, 0x00, 1])), 'tiff');
  assert.equal(sniff(Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 1])), 'tiff');
  assert.equal(sniff(Buffer.from([0x50, 0x4b, 3, 4, 0])), 'zip');
  assert.equal(sniff(Buffer.from('Dear Sir,\nthanks for the statement.\n')), 'text');
  assert.equal(sniff(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])), undefined, 'a Windows program is nothing');
  assert.equal(sniff(Buffer.from([0xc3, 0x28, 0x41])), undefined, 'invalid UTF-8 is not text');
  assert.equal(sniff(new Uint8Array(0)), undefined);
});

test('separator sheets split a scan; leading, trailing and double separators make no empty documents', () => {
  const P = (...b: string[]): PageInfo => ({ barcodes: b });
  const r = splitPages([P(), P(), P('PATCHT'), P(), P('PATCHT'), P('PATCHT'), P(), P('PATCHT')]);
  assert.deepEqual(r.segments.map((s) => s.pages), [[0, 1], [3], [6]]);
  assert.deepEqual(r.separators, [2, 4, 5, 7]);
  assert.deepEqual(splitPages([P('PATCHT'), P()]).segments.map((s) => s.pages), [[1]]);
  assert.deepEqual(splitPages([P(), P()]).segments.map((s) => s.pages), [[0, 1]]);
  assert.deepEqual(splitPages([P('PATCHT')]).segments, []);
  assert.deepEqual(splitPages([P('SPLIT'), P(), P('SPLIT'), P()], { separator: 'SPLIT' }).segments.map((s) => s.pages), [[1], [3]]);
  assert.deepEqual(splitPages([P(), { barcodes: [], blank: true }, P()], { blankSeparates: true }).segments.map((s) => s.pages), [[0], [2]]);
  assert.deepEqual(splitPages([P(), { barcodes: [], blank: true }, P()]).segments.map((s) => s.pages), [[0, 1, 2]]);
});

test('serial number barcodes name documents, can start them, and conflicts are reported', () => {
  const P = (...b: string[]): PageInfo => ({ barcodes: b });
  const r = splitPages([P('ASN00042'), P(), P('PATCHT'), P('ASN7')], { separator: 'PATCHT' });
  assert.deepEqual(r.segments, [{ pages: [0, 1], asn: 42 }, { pages: [3], asn: 7 }]);
  assert.deepEqual(r.problems, []);
  const starts = splitPages([P('ASN1'), P(), P('ASN2'), P()], { asnStartsDocument: true });
  assert.deepEqual(starts.segments.map((s) => [s.pages, s.asn]), [[[0, 1], 1], [[2, 3], 2]]);
  assert.deepEqual(splitPages([P('ASN1'), P('ASN2')]).problems, ['page 2 has serial number 2 but its document already has 1']);
  assert.deepEqual(splitPages([P('ASN9'), P('PATCHT'), P('ASN9')]).problems, ['serial number 9 is on documents 1 and 2']);
  assert.deepEqual(splitPages([P('ASN1234567890')]).segments[0]!.asn, undefined, 'ten digits is not a serial number');
  assert.deepEqual(splitPages([P('XASN5')]).segments[0]!.asn, undefined);
  assert.deepEqual(splitPages([P('NUM5')], { asnPrefix: 'NUM' }).segments[0]!.asn, 5);
});

test('a document is read, filed with a reason, stored with its checksum, and acknowledged', async () => {
  log.length = 0;
  const { inbox, stored } = make({}, [spySource]);
  const bytes = Buffer.from('FirstBank statement for April\n');
  const r = await inbox.consume(mem('apr.txt', bytes));
  assert.equal(r.status, 'consumed');
  assert.equal(r.documents.length, 1);
  assert.equal(r.documents[0]!.path, 'First Bank/2025/apr');
  assert.equal(stored[0]!.checksum, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(stored[0]!.decision.correspondent, 'c-bank');
  assert.equal(stored[0]!.decision.type, 't-stmt');
  assert.deepEqual(log, ['apr.txt:consumed']);
});

test('the same content again is a duplicate, whatever it is called, with a pointer to the first', async () => {
  log.length = 0;
  const { inbox, stored } = make({}, [spySource]);
  await inbox.consume(mem('a.pdf', pdf()));
  const r = await inbox.consume(mem('copy of a (1).pdf', pdf()));
  assert.equal(r.status, 'duplicate');
  assert.equal(r.of, 'doc1');
  assert.equal(stored.length, 1);
  assert.equal((await inbox.consume(mem('b.pdf', pdf('two')))).status, 'consumed');
  assert.deepEqual(log, ['a.pdf:consumed', 'copy of a (1).pdf:duplicate', 'b.pdf:consumed']);
});

test('what the inbox does not accept is rejected and sent to the errors place: wrong kind, empty, too big', async () => {
  log.length = 0;
  const { inbox, stored } = make({ maxBytes: 100 }, [spySource]);
  assert.match((await inbox.consume(mem('x.pdf', Buffer.from([0x4d, 0x5a, 0, 0])))).why!, /not a kind of file/);
  assert.match((await inbox.consume(mem('x.zip', Buffer.from([0x50, 0x4b, 3, 4, 0])))).why!, /zip files are not accepted/);
  assert.match((await inbox.consume(mem('e.pdf', new Uint8Array(0)))).why!, /empty/);
  assert.match((await inbox.consume(mem('big.txt', Buffer.alloc(101, 65)))).why!, /larger than the limit/);
  assert.equal(stored.length, 0);
  assert.deepEqual(log.map((l) => l.split(':')[1]), ['rejected', 'rejected', 'rejected', 'rejected']);
});

test('a scan with separator sheets becomes several documents, each filed and numbered', async () => {
  const { inbox, stored } = make({
    pageInfo: async () => [{ barcodes: ['ASN100'] }, { barcodes: [] }, { barcodes: ['PATCHT'] }, { barcodes: ['ASN101'] }],
    cut: async (b, pages) => Buffer.from(`${Buffer.from(b).toString('latin1')}|${pages.join(',')}`, 'latin1'),
    extractText: async (b) => (Buffer.from(b).toString('latin1').endsWith('|0,1') ? 'FirstBank statement' : 'other'),
  }, [nullSource]);
  const r = await inbox.consume(mem('batch.pdf', pdf('scan')));
  assert.equal(r.status, 'consumed');
  assert.deepEqual(r.documents.map((d) => [d.name, d.asn]), [['batch-1.pdf', 100], ['batch-2.pdf', 101]]);
  assert.equal(stored[0]!.decision.correspondent, 'c-bank');
  assert.equal(stored[1]!.decision.correspondent, undefined);
  assert.equal((await inbox.consume(mem('batch-again.pdf', pdf('scan')))).status, 'duplicate', 'the whole scan is remembered too');
});

test('a scan that cannot be split cleanly is failed with the reason, and nothing is stored', async () => {
  const { inbox, stored } = make({ pageInfo: async () => [{ barcodes: ['ASN1'] }, { barcodes: ['ASN2'] }], cut: async (b) => b }, [nullSource]);
  const r = await inbox.consume(mem('bad.pdf', pdf()));
  assert.equal(r.status, 'failed');
  assert.match(r.why!, /could not be split: page 2 has serial number 2/);
  assert.equal(stored.length, 0);
  const all = make({ pageInfo: async () => [{ barcodes: ['PATCHT'] }], cut: async (b) => b }, [nullSource]);
  assert.match((await all.inbox.consume(mem('sep.pdf', pdf('s')))).why!, /every page was a separator/);
});

test('hooks: arguments not a shell line, a clean environment, and abort or continue on failure', async () => {
  const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
  const run: Runner = async (argv, env) => {
    seen.push({ argv, env });
    return { code: argv[0] === 'bad' ? 3 : 0, stdout: '', stderr: argv[0] === 'bad' ? 'no way' : '' };
  };
  const hooks: Hook[] = [
    { name: 'scan-virus', stage: 'pre', argv: ['av', '--file'], timeoutMs: 1000, onFailure: 'abort' },
    { name: 'notify', stage: 'post', argv: ['bad'], timeoutMs: 1000, onFailure: 'continue' },
  ];
  const { inbox } = make({ hooks, run }, [nullSource]);
  const r = await inbox.consume(mem('line\nbreak.txt', Buffer.from('hello')));
  assert.equal(r.status, 'consumed');
  assert.deepEqual(r.hooks, [{ hook: 'scan-virus', ok: true }, { hook: 'notify', ok: false, why: 'exited with 3: no way' }]);
  assert.equal(seen[0]!.env['DOCUMENT_FILE_NAME'], 'line break.txt', 'control characters are removed from values');
  assert.equal(seen[1]!.env['DOCUMENT_ID'], 'doc1');
  assert.ok(Object.keys(seen[0]!.env).every((k) => k.startsWith('DOCUMENT_')));
  const stopper = make({ hooks: [{ name: 'gate', stage: 'pre', argv: ['bad'], timeoutMs: 1000, onFailure: 'abort' }], run }, [nullSource]);
  const f = await stopper.inbox.consume(mem('a.txt', Buffer.from('hi')));
  assert.equal(f.status, 'failed');
  assert.equal(stopper.stored.length, 0);
  assert.deepEqual(f.hooks, [{ hook: 'gate', ok: false, why: 'exited with 3: no way' }]);
});

test('hook checks and the time limit', async () => {
  assert.throws(() => checkHook({ name: 'x', stage: 'pre', argv: [], timeoutMs: 10, onFailure: 'abort' }), /list of arguments/);
  assert.throws(() => checkHook({ name: 'x', stage: 'pre', argv: ['rm -rf /'], timeoutMs: 10, onFailure: 'abort' }), /spaces/);
  assert.throws(() => checkHook({ name: 'x', stage: 'pre', argv: ['a\0b'], timeoutMs: 10, onFailure: 'abort' }), /list of arguments/);
  assert.throws(() => checkHook({ name: 'x', stage: 'pre', argv: ['a'], timeoutMs: 0, onFailure: 'abort' }), /10 minutes/);
  assert.throws(() => hookEnv({ 'bad name': 'x' }), Rejected);
  const hang: Runner = () => new Promise(() => {});
  const r = await runHooks([{ name: 'slow', stage: 'pre', argv: ['x'], timeoutMs: 20, onFailure: 'abort' }], 'pre', hang, {});
  assert.equal(r.stop, true);
  assert.match(r.results[0]!.why!, /took longer than 20 ms/);
});

test('the real runner starts a program without a shell and reports its exit code', async () => {
  const ok = await nodeRunner([process.execPath, '-e', 'process.stdout.write(process.env.DOCUMENT_X)'], { DOCUMENT_X: '$(echo pwned); `id`' }, 5000);
  assert.deepEqual([ok.code, ok.stdout], [0, '$(echo pwned); `id`']);
  const bad = await nodeRunner([process.execPath, '-e', 'process.exit(7)'], {}, 5000);
  assert.equal(bad.code, 7);
  const slow = await nodeRunner([process.execPath, '-e', 'setTimeout(()=>{},10000)'], {}, 200);
  assert.notEqual(slow.code, 0);
});

test('a watched folder offers only settled, ordinary files and moves them aside afterwards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  try {
    const c = clock();
    const old = new Date(c.t - 60_000);
    for (const [n, body] of [['scan1.pdf', pdf()], ['.hidden.pdf', pdf('h')], ['half.pdf.part', pdf('p')], ['~$lock.txt', Buffer.from('x')], ['empty.pdf', Buffer.alloc(0)], ['fresh.pdf', pdf('f')], ['b.txt', Buffer.from('hello')]] as const) {
      await writeFile(join(dir, n), body);
      if (n !== 'fresh.pdf') await utimes(dir + '/' + n, old, old);
    }
    await utimes(join(dir, 'fresh.pdf'), new Date(c.t - 500), new Date(c.t - 500));
    await mkdir(join(dir, 'subdir'));
    await symlink('/etc/hostname', join(dir, 'link.txt'));
    const src = new FolderSource({ name: 'scanner', dir, now: () => c.t, keep: true });
    assert.deepEqual((await src.list()).map((i) => i.name), ['b.txt', 'scan1.pdf']);
    const { inbox } = make({}, [src]);
    const items = await src.list();
    assert.equal((await inbox.consume(items[1]!)).status, 'consumed');
    assert.equal((await inbox.consume({ ...items[0]!, read: async () => Buffer.from([0x4d, 0x5a, 0, 0]) })).status, 'rejected');
    assert.deepEqual(await readdir(join(dir, '.consume', 'processed')), ['scan1.pdf']);
    assert.deepEqual(await readdir(join(dir, '.consume', 'errors')), ['b.txt']);
    assert.ok(!(await readdir(dir)).includes('scan1.pdf'));
    await writeFile(join(dir, 'b.txt'), 'again');
    await utimes(join(dir, 'b.txt'), old, old);
    const again = (await src.list()).find((i) => i.name === 'b.txt')!;
    await src.done(again, 'failed');
    assert.deepEqual((await readdir(join(dir, '.consume', 'errors'))).sort(), ['1-b.txt', 'b.txt'], 'names never overwrite');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a folder without keep deletes what it consumed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  try {
    const c = clock();
    await writeFile(join(dir, 'a.pdf'), pdf());
    await utimes(join(dir, 'a.pdf'), new Date(c.t - 99_000), new Date(c.t - 99_000));
    const src = new FolderSource({ name: 'drop', dir, now: () => c.t });
    const { inbox } = make({}, [src]);
    await inbox.consume((await src.list())[0]!);
    assert.deepEqual((await readdir(dir)).filter((n) => !n.startsWith('.')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mail attachments are taken; small images (logos) and hostile file names are not trusted', async () => {
  const msg: MailMessage = { id: 'm1', from: 'bank@example.com', subject: 'Statement', attachments: [{ filename: '../../etc/statement.pdf', bytes: pdf('mail') }, { filename: 'logo.png', bytes: pngBytes(100) }, { filename: 'scan.png', bytes: pngBytes(9000) }, { filename: '', bytes: Buffer.from('plain') }] };
  const src = new MailSource({ name: 'mail', fetch: async () => [msg] });
  const items = await src.list();
  assert.deepEqual(items.map((i) => i.name), ['m1-1-_.._etc_statement.pdf', 'm1-3-scan.png', 'm1-4-attachment-4']);
  assert.ok(!items[0]!.name.includes('/'));
  const { inbox } = make({}, [src]);
  assert.equal((await inbox.consume(items[0]!)).status, 'consumed');
  assert.deepEqual(src.handled, [items[0]!.name]);
});

test('the jobs queue runs one consume job per item, once, with retries on failure', async () => {
  let n = 0;
  const items = [mem('a.pdf', pdf('a')), mem('b.pdf', pdf('b'))];
  const flaky = { name: 'mem', list: async () => items, done: async () => {} };
  const c = clock();
  const q = new Queue({ now: () => c.t, baseMs: 10, random: () => 0 });
  let fails = 1;
  const { inbox, stored } = make({ store: async (d) => { if (d.name === 'b.pdf' && fails-- > 0) throw new Error('disk full'); n++; stored.push(d); } }, [flaky]);
  inbox.attach(q);
  assert.equal(await inbox.poll(q), 2);
  assert.equal(await inbox.poll(q), 0, 'already queued');
  await q.tick();
  assert.equal(n, 1);
  assert.deepEqual([...q.jobs.values()].map((j) => j.state), ['done', 'waiting']);
  c.t += 100_000;
  await q.tick();
  assert.equal(n, 2);
  assert.deepEqual([...q.jobs.values()].map((j) => j.state), ['done', 'done']);
});

test('sha256 is the standard hash', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
