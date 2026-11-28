import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEXTCLOUD, Unsafe, checkName, checkSize, inspect, sniff } from './index.ts';

test('names a client on another system could not hold, or the server must never keep, are refused with a reason', () => {
  for (const bad of ['.htaccess', '.HTACCESS', 'report.docx.part', 'x.filepart', 'CON', 'con.txt', 'LPT1.log', 'notes.', 'notes ', 'a\u0001b'])
    assert.throws(() => checkName(bad), Unsafe, bad);
  for (const ok of ['report.docx', 'console.log', 'CONTRACT.pdf', 'résumé 2026.pdf', '.hidden', 'a.b.c'])
    assert.doesNotThrow(() => checkName(ok), ok);
});

test('a policy can relax the Windows rules for a server only Unix clients use', () => {
  assert.doesNotThrow(() => checkName('CON', { ...NEXTCLOUD, windowsReserved: false }));
  assert.doesNotThrow(() => checkName('dots.', { ...NEXTCLOUD, windowsTrailing: false }));
});

test('a size limit applies only when one is set', () => {
  assert.doesNotThrow(() => checkSize(10 ** 12));
  assert.throws(() => checkSize(11, { ...NEXTCLOUD, maxBytes: 10 }), Unsafe);
});

test('the first bytes say what a file is, and a disguised program is caught', () => {
  assert.equal(sniff(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), 'application/pdf');
  assert.equal(sniff(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
  assert.equal(sniff(Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70])), 'video/mp4');
  assert.equal(sniff(new TextEncoder().encode('just text')), null);
  const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0]);
  assert.deepEqual(inspect('invoice.pdf', exe), { actual: 'application/x-msdownload', mismatch: true, executable: true });
  assert.deepEqual(inspect('photo.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), { actual: 'image/jpeg', mismatch: false, executable: false });
  assert.deepEqual(inspect('budget.xlsx', Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), { actual: 'application/zip', mismatch: false, executable: false });
  assert.equal(inspect('notes.txt', new TextEncoder().encode('hello')).mismatch, false, 'unknown bytes are never a mismatch');
});

test('every refusal says why, naming the name or ending', () => {
  const why = (name: string, p = NEXTCLOUD) => {
    try {
      checkName(name, p);
    } catch (e) {
      return e instanceof Unsafe ? e.why : String(e);
    }
    return null;
  };
  assert.equal(why('.htaccess'), '".htaccess" is a name this server does not keep');
  assert.equal(why('a.part'), 'names ending in ".part" are kept for unfinished uploads');
  assert.equal(why('a/b'), '"a/b" contains a character a file system cannot hold');
  assert.equal(why('NUL.txt'), '"NUL.txt" is a name Windows reserves');
  assert.equal(why('end.'), '"end." ends in a dot or a space, which Windows removes');
});

test('the policy lists decide: any listed name or ending refuses, and the forbidden characters are the ones given', () => {
  const p = { ...NEXTCLOUD, names: ['.htaccess', 'web.config'], endings: ['.part', '.tmp'] };
  assert.throws(() => checkName('web.config', p), Unsafe);
  assert.throws(() => checkName('WEB.CONFIG', p), Unsafe);
  assert.throws(() => checkName('x.TMP', p), Unsafe);
  assert.doesNotThrow(() => checkName('web.config.bak', p));
  for (const bad of ['a/b', 'a\\b', 'a\0b']) assert.throws(() => checkName(bad), Unsafe, bad);
  assert.doesNotThrow(() => checkName('a:b*c', NEXTCLOUD));
  assert.throws(() => checkName('a:b', { ...NEXTCLOUD, characters: ':' }), Unsafe);
  assert.doesNotThrow(() => checkName('a/b', { ...NEXTCLOUD, characters: ':' }));
});

test('Windows reserved names are refused in full and only in full', () => {
  for (const bad of ['CON', 'prn', 'Aux.tar.gz', 'nul', 'COM1', 'com9.txt', 'LPT1', 'lpt9.log']) assert.throws(() => checkName(bad), Unsafe, bad);
  for (const ok of ['icon', 'xcon', 'recon.txt', 'xprn', 'COM0', 'com', 'LPT0', 'lpt', 'COM10', 'conx', 'aux1']) assert.doesNotThrow(() => checkName(ok), ok);
});

test('the size limit is inclusive of the limit itself, and says both numbers', () => {
  const p = { ...NEXTCLOUD, maxBytes: 10 };
  assert.doesNotThrow(() => checkSize(0, p));
  assert.doesNotThrow(() => checkSize(9, p));
  assert.doesNotThrow(() => checkSize(10, p));
  assert.throws(() => checkSize(11, p), { why: '11 bytes is over the limit of 10 for one file' });
  assert.throws(() => checkSize(1, { ...NEXTCLOUD, maxBytes: 0 }), Unsafe);
  assert.doesNotThrow(() => checkSize(0, { ...NEXTCLOUD, maxBytes: 0 }));
});

test('each known type is recognised by its bytes and each honest extension is no mismatch', () => {
  const bytes = (...b: number[]) => Uint8Array.from(b);
  const cases: [string, Uint8Array, string[]][] = [
    ['application/pdf', bytes(0x25, 0x50, 0x44, 0x46, 0x2d), ['pdf']],
    ['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), ['png']],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff), ['jpg', 'jpeg', 'jpe', 'jfif']],
    ['image/gif', bytes(0x47, 0x49, 0x46, 0x38), ['gif']],
    ['image/webp', bytes(0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50), ['webp']],
    ['application/zip', bytes(0x50, 0x4b, 0x03, 0x04), ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'jar', 'apk']],
    ['application/gzip', bytes(0x1f, 0x8b), ['gz', 'tgz']],
    ['video/mp4', bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70), ['mp4', 'm4a', 'm4v', 'mov', 'heic', 'heif', '3gp']],
    ['application/x-msdownload', bytes(0x4d, 0x5a), ['exe', 'dll', 'msi', 'scr', 'sys', 'com']],
    ['application/x-executable', bytes(0x7f, 0x45, 0x4c, 0x46), ['so', 'bin', 'elf', 'o']],
  ];
  for (const [type, head, exts] of cases) {
    assert.equal(sniff(head), type);
    for (const ext of exts) {
      const f = inspect(`file.${ext.toUpperCase()}`, head);
      assert.equal(f.actual, type, ext);
      assert.equal(f.mismatch, false, `${type} called .${ext}`);
    }
    assert.equal(inspect('file.txt', head).mismatch, true, `${type} called .txt`);
  }
});

test('a program is flagged executable whether it is a Windows or a Linux one, and only then', () => {
  const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  assert.deepEqual(inspect('tool.so', elf), { actual: 'application/x-executable', mismatch: false, executable: true });
  assert.deepEqual(inspect('holiday.jpg', elf), { actual: 'application/x-executable', mismatch: true, executable: true });
  assert.equal(inspect('a.zip', Uint8Array.from([0x50, 0x4b, 0x03, 0x04])).executable, false);
  assert.equal(inspect('a.txt', new TextEncoder().encode('plain')).executable, false);
});

test('a name with no extension, or only a leading dot, has an empty extension', () => {
  const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]);
  assert.equal(inspect('program', elf).mismatch, false);
  assert.equal(inspect('.hidden', elf).mismatch, false);
  assert.equal(inspect('program.exe', elf).mismatch, true);
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.equal(inspect('pdf', pdf).mismatch, true);
  assert.equal(inspect('.pdf', pdf).mismatch, true);
  assert.equal(inspect('x.pdf', pdf).mismatch, false);
});

test('bytes too short to hold a signature match nothing', () => {
  assert.equal(sniff(new Uint8Array(0)), null);
  assert.equal(sniff(Uint8Array.from([0x25, 0x50])), null);
  assert.equal(sniff(Uint8Array.from([0x52, 0x49, 0x46, 0x46])), null);
  assert.equal(sniff(Uint8Array.from([0x66, 0x74, 0x79, 0x70])), null);
});
