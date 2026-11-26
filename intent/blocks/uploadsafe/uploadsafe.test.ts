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
