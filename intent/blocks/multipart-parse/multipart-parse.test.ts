import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultipartParser, MultipartError, parse, parseStream, collect, build, parseContentType, parseHeaderValue, decodeExtValue, sanitizeFilename } from './index.ts';

const CT = 'multipart/form-data; boundary=AaB03x';
const enc = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const EXE = new Uint8Array([0x4d, 0x5a, ...new Array(30).fill(0x90)]);
const code = (f: () => unknown): string | undefined => { try { f(); return undefined; } catch (e) { return e instanceof MultipartError ? e.code : `other:${String(e)}`; } };
const file = (name: string, filename: string, bytes: Uint8Array, contentType?: string) => ({ name, filename, bytes, ...(contentType ? { contentType } : {}) });

// RFC 7578 section 4.3 style example
const RFC = enc('--AaB03x\r\nContent-Disposition: form-data; name="submit-name"\r\n\r\nLarry\r\n--AaB03x\r\nContent-Disposition: form-data; name="files"; filename="file1.txt"\r\nContent-Type: text/plain\r\n\r\n... contents of file1.txt ...\r\n--AaB03x--\r\n');

test('RFC 7578 example: a field and a file', () => {
  const r = parse(RFC, CT);
  assert.deepEqual(r.fields, [{ name: 'submit-name', value: 'Larry' }]);
  assert.equal(r.files.length, 1);
  const f = r.files[0]!;
  assert.equal(f.name, 'files');
  assert.equal(f.filename, 'file1.txt');
  assert.equal(f.contentType, 'text/plain');
  assert.equal(new TextDecoder().decode(f.bytes), '... contents of file1.txt ...');
  assert.equal(f.size, 29);
});

test('every way of splitting the body into two chunks gives the same result', () => {
  const body = build('AaB03x', [{ name: 'a', value: 'x\r\n--AaB03 not a boundary' }, file('f', 'p.png', PNG, 'image/png'), { name: 'b', value: '' }]);
  const whole = parse(body, CT);
  for (let i = 0; i <= body.length; i++) {
    const p = new MultipartParser('AaB03x');
    const events = [...p.write(body.subarray(0, i)), ...p.write(body.subarray(i)), ...p.end()];
    const kinds = events.filter((e) => e.kind !== 'data').map((e) => e.kind);
    assert.deepEqual(kinds, ['part', 'end', 'part', 'end', 'part', 'end'], `split at ${i}`);
    const data = Buffer.concat(events.filter((e) => e.kind === 'data').map((e) => (e as { chunk: Uint8Array }).chunk));
    assert.equal(data.length, whole.fields[0]!.value.length + PNG.length, `split at ${i}`);
  }
  assert.equal(whole.fields[0]!.value, 'x\r\n--AaB03 not a boundary');
  assert.deepEqual([...whole.files[0]!.bytes], [...PNG]);
});

test('one byte at a time, asynchronously', async () => {
  const body = build('AaB03x', [{ name: 'a', value: 'one' }, file('f', 'a.bin', new Uint8Array([1, 2, 3, 13, 10, 45, 45]))]);
  async function* bytes() { for (const b of body) yield new Uint8Array([b]); }
  const r = await collect(bytes(), CT);
  assert.deepEqual(r.fields, [{ name: 'a', value: 'one' }]);
  assert.deepEqual([...r.files[0]!.bytes], [1, 2, 3, 13, 10, 45, 45]);
});

test('parseStream yields events in order', async () => {
  const events: string[] = [];
  for await (const e of parseStream([RFC], CT)) events.push(e.kind === 'part' ? `part:${e.part.name}` : e.kind);
  assert.deepEqual(events, ['part:submit-name', 'data', 'end', 'part:files', 'data', 'end']);
});

test('preamble and epilogue are ignored, padding after a boundary is allowed', () => {
  const body = enc('this is the preamble\r\n--AaB03x \t\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--AaB03x--  trailing junk\r\nmore');
  assert.deepEqual(parse(body, CT).fields, [{ name: 'a', value: '1' }]);
});

test('content that looks like a delimiter prefix is data, but a real delimiter followed by junk is refused', () => {
  const ok = enc('--AaB03x\r\nContent-Disposition: form-data; name="a"\r\n\r\nx\r\n--AaB03\r\n--AaB0\r\n--AaB03x--');
  assert.equal(parse(ok, CT).fields[0]!.value, 'x\r\n--AaB03\r\n--AaB0');
  const bad = enc('--AaB03x\r\nContent-Disposition: form-data; name="a"\r\n\r\nx\r\n--AaB03xQ\r\n\r\n--AaB03x--');
  assert.equal(code(() => parse(bad, CT)), 'malformed');
});

test('Content-Type parsing and boundary validation', () => {
  assert.equal(parseContentType('multipart/form-data; boundary="a b:c"').boundary, 'a b:c');
  assert.equal(parseContentType('MULTIPART/Form-Data;boundary=xyz; charset=UTF-8').charset, 'utf-8');
  assert.equal(code(() => parseContentType('multipart/mixed; boundary=x')), 'bad-content-type');
  assert.equal(code(() => parseContentType('application/json')), 'bad-content-type');
  assert.equal(code(() => parseContentType(undefined)), 'bad-content-type');
  assert.equal(code(() => parseContentType('multipart/form-data')), 'bad-boundary');
  assert.equal(code(() => parseContentType(`multipart/form-data; boundary=${'a'.repeat(71)}`)), 'bad-boundary');
  assert.equal(code(() => parseContentType('multipart/form-data; boundary="abc "')), 'bad-boundary');
  assert.equal(code(() => parseContentType('multipart/form-data; boundary="a\r\nb"')), 'bad-boundary');
  assert.equal(code(() => parseContentType('multipart/form-data; boundary=a; boundary=b')), 'bad-headers');
  assert.equal(code(() => parseContentType('multipart/form-data; boundary="abc')), 'bad-headers');
});

test('header value parsing handles quotes and escapes', () => {
  const h = parseHeaderValue('form-data; name="a;b"; filename="q\\"uote.txt"');
  assert.equal(h.params.get('name'), 'a;b');
  assert.equal(h.params.get('filename'), 'q"uote.txt');
});

test('filename* wins over filename and decodes RFC 5987 values', () => {
  assert.equal(decodeExtValue("UTF-8''%e2%82%ac%20rates"), '€ rates');
  assert.equal(decodeExtValue("iso-8859-1'en'%A3%20rates"), '£ rates');
  assert.equal(code(() => decodeExtValue("UTF-8''%ff")), 'bad-encoding');
  assert.equal(code(() => decodeExtValue("koi8-r''abc")), 'bad-headers');
  assert.equal(code(() => decodeExtValue("UTF-8''%zz")), 'bad-headers');
  const body = enc('--AaB03x\r\nContent-Disposition: form-data; name="f"; filename="fallback.txt"; filename*=UTF-8\'\'%e2%82%ac%20rates.txt\r\n\r\nx\r\n--AaB03x--');
  const f = parse(body, CT).files[0]!;
  assert.equal(f.rawFilename, '€ rates.txt');
  assert.equal(f.filename, '€ rates.txt');
});

test('browser escapes %22 and %0A in names are undone', () => {
  const body = build('AaB03x', [{ name: 'we"ird\nname', value: 'v' }, file('f', 'a"b.txt', enc('x'))]);
  const r = parse(body, CT);
  assert.equal(r.fields[0]!.name, 'we"ird\nname');
  assert.equal(r.files[0]!.rawFilename, 'a"b.txt');
  assert.equal(r.files[0]!.filename, 'a_b.txt');
});

test('sanitizeFilename', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\me\\report.docx'), 'report.docx');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('nul'), '_nul');
  assert.equal(sanitizeFilename('.htaccess'), 'htaccess');
  assert.equal(sanitizeFilename('a:b*c?.txt'), 'a_b_c_.txt');
  assert.equal(sanitizeFilename('bad\u0000name\u0007.txt'), 'badname.txt');
  assert.equal(sanitizeFilename('inv\u202eoice\u200b.txt'), 'invoice.txt');
  assert.equal(sanitizeFilename('...'), 'unnamed');
  assert.equal(sanitizeFilename('trailing. . '), 'trailing');
  assert.equal(sanitizeFilename('   '), 'unnamed');
  assert.equal(sanitizeFilename('a   b\t c.txt'), 'a b c.txt');
  assert.equal(sanitizeFilename('upload.part'), 'upload.part_');
  assert.equal(sanitizeFilename('e\u0301.txt'), '\u00e9.txt');
  assert.equal(sanitizeFilename('dir/'), 'unnamed');
});

test('sanitizeFilename cuts long names on a character boundary and keeps the extension', () => {
  const n = sanitizeFilename(`${'é'.repeat(300)}.pdf`);
  assert.ok(Buffer.byteLength(n) <= 255);
  assert.ok(n.endsWith('.pdf'));
  assert.ok(!n.includes('\ufffd'));
  const m = sanitizeFilename('x'.repeat(400));
  assert.equal(Buffer.byteLength(m), 255);
  assert.equal(sanitizeFilename('abcdef.txt', { maxBytes: 8 }), 'abcd.txt');
});

test('limits: total, parts, files, fields', () => {
  const two = build('AaB03x', [{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
  assert.equal(code(() => parse(two, CT, { maxTotalBytes: 50 })), 'limit-total');
  assert.equal(code(() => parse(two, CT, { maxParts: 1 })), 'limit-parts');
  assert.equal(code(() => parse(two, CT, { maxFields: 1 })), 'limit-fields');
  const files = build('AaB03x', [file('a', 'a.txt', enc('1')), file('b', 'b.txt', enc('2'))]);
  assert.equal(code(() => parse(files, CT, { maxFiles: 1 })), 'limit-files');
  assert.equal(parse(files, CT, { maxFiles: 2 }).files.length, 2);
  assert.equal(new MultipartError('limit-total', 'x').status, 413);
  assert.equal(new MultipartError('malformed', 'x').status, 400);
  assert.equal(new MultipartError('type-not-allowed', 'x').status, 415);
});

test('limits: a too-large file is refused as soon as it passes the limit, not after the whole body', () => {
  const head = enc('--AaB03x\r\nContent-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n');
  const p = new MultipartParser('AaB03x', { maxFileBytes: 1000 });
  p.write(head);
  p.write(new Uint8Array(900).fill(65));
  assert.throws(() => p.write(new Uint8Array(200).fill(65)), (e) => e instanceof MultipartError && e.code === 'limit-file-size');
  assert.throws(() => p.write(enc('more')), MultipartError);
});

test('limits: field size, header bytes and header count', () => {
  const big = build('AaB03x', [{ name: 'a', value: 'x'.repeat(100) }]);
  assert.equal(code(() => parse(big, CT, { maxFieldBytes: 99 })), 'limit-field-size');
  assert.equal(parse(big, CT, { maxFieldBytes: 100 }).fields[0]!.value.length, 100);
  const hdr = enc(`--AaB03x\r\nContent-Disposition: form-data; name="a"\r\nX-Pad: ${'x'.repeat(9000)}\r\n\r\n1\r\n--AaB03x--`);
  assert.equal(code(() => parse(hdr, CT)), 'limit-headers');
  const never = new MultipartParser('AaB03x', { maxHeaderBytes: 100 });
  assert.throws(() => never.write(enc(`--AaB03x\r\n${'a'.repeat(500)}`)), (e) => e instanceof MultipartError && e.code === 'limit-headers');
  const many = enc(`--AaB03x\r\nContent-Disposition: form-data; name="a"\r\n${Array.from({ length: 20 }, (_, i) => `X-${i}: 1`).join('\r\n')}\r\n\r\n1\r\n--AaB03x--`);
  assert.equal(code(() => parse(many, CT)), 'limit-headers');
  const longName = build('AaB03x', [{ name: 'n'.repeat(300), value: '1' }]);
  assert.equal(code(() => parse(longName, CT)), 'bad-headers');
});

test('type checks use the declared type and the first bytes', () => {
  const o = { allowedTypes: ['image/png', 'image/jpeg'] };
  assert.equal(parse(build('AaB03x', [file('f', 'a.png', PNG, 'image/png')]), CT, o).files[0]!.sniffed, 'image/png');
  assert.equal(code(() => parse(build('AaB03x', [file('f', 'a.txt', enc('hi'), 'text/plain')]), CT, o)), 'type-not-allowed');
  assert.equal(code(() => parse(build('AaB03x', [file('f', 'a.png', EXE, 'image/png')]), CT, o)), 'executable');
  assert.equal(code(() => parse(build('AaB03x', [file('f', 'a.png', EXE, 'image/png')]), CT, { allowExecutables: true, allowedTypes: ['image/*'] })), 'type-mismatch');
  assert.equal(code(() => parse(build('AaB03x', [file('f', 'a.exe', PNG, 'image/png')]), CT, o)), 'type-mismatch');
  assert.equal(parse(build('AaB03x', [file('f', 'a.exe', PNG, 'image/png')]), CT, { rejectMismatch: false }).files.length, 1);
  assert.equal(parse(build('AaB03x', [file('f', 'a.gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'image/gif')]), CT, { allowedTypes: ['image/*'] }).files.length, 1);
  assert.equal(code(() => parse(build('AaB03x', [file('f', 'p.bin', EXE)]), CT)), 'executable');
});

test('short files are checked when they end', () => {
  assert.equal(code(() => parse(build('AaB03x', [file('f', 'a.png', new Uint8Array([0x4d, 0x5a]))]), CT)), 'executable');
  assert.equal(parse(build('AaB03x', [file('f', 'a.txt', enc('hi'))]), CT).files[0]!.size, 2);
});

test('an empty file input (no file chosen) is dropped; forbidFiles and allowedNames', () => {
  const body = build('AaB03x', [file('f', '', new Uint8Array(0)), { name: 'a', value: '1' }]);
  const r = parse(body, CT);
  assert.equal(r.files.length, 0);
  assert.equal(r.fields.length, 1);
  assert.equal(code(() => parse(build('AaB03x', [file('f', 'a.txt', enc('x'))]), CT, { forbidFiles: true })), 'unexpected-file');
  assert.equal(code(() => parse(build('AaB03x', [{ name: 'surprise', value: '1' }]), CT, { allowedNames: ['a'] })), 'bad-headers');
});

test('hostile framing is refused', () => {
  const part = (h: string) => enc(`--AaB03x\r\n${h}\r\n\r\nv\r\n--AaB03x--`);
  assert.equal(code(() => parse(part('Content-Type: text/plain'), CT)), 'bad-headers');
  assert.equal(code(() => parse(part('Content-Disposition: attachment; name="a"'), CT)), 'bad-headers');
  assert.equal(code(() => parse(part('Content-Disposition: form-data'), CT)), 'bad-headers');
  assert.equal(code(() => parse(part('Content-Disposition: form-data; name="a"\r\n folded'), CT)), 'bad-headers');
  assert.equal(code(() => parse(part('Content-Disposition: form-data; name="a"\r\nContent-Disposition: form-data; name="b"'), CT)), 'bad-headers');
  assert.equal(code(() => parse(part('Content-Disposition: form-data; name="a"; name="b"'), CT)), 'bad-headers');
  assert.equal(code(() => parse(part('Content-Disposition: form-data; name="a"\r\nContent-Type: multipart/mixed; boundary=z'), CT)), 'bad-headers');
  assert.equal(code(() => parse(part('Content-Disposition: form-data; name="a"\r\nContent-Transfer-Encoding: base64'), CT)), 'unsupported-encoding');
  assert.equal(code(() => parse(part('no colon here'), CT)), 'bad-headers');
  assert.equal(code(() => parse(enc('--AaB03x\nContent-Disposition: form-data; name="a"\n\nv\n--AaB03x--'), CT)), 'malformed');
});

test('truncated bodies are errors', () => {
  const cut = RFC.subarray(0, RFC.length - 12);
  assert.equal(code(() => parse(cut, CT)), 'truncated');
  assert.equal(code(() => parse(new Uint8Array(0), CT)), 'truncated');
  assert.equal(code(() => parse(enc('no boundary at all'), CT)), 'truncated');
  assert.deepEqual(parse(enc('--AaB03x--'), CT).fields, []);
});

test('fields: charsets, invalid UTF-8 and null-prototype values', () => {
  const l1 = Buffer.concat([Buffer.from('--AaB03x\r\nContent-Disposition: form-data; name="a"\r\nContent-Type: text/plain; charset=ISO-8859-1\r\n\r\n'), Buffer.from([0xe9]), Buffer.from('\r\n--AaB03x--')]);
  assert.equal(parse(l1, CT).fields[0]!.value, 'é');
  const bad = Buffer.concat([Buffer.from('--AaB03x\r\nContent-Disposition: form-data; name="a"\r\n\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\r\n--AaB03x--')]);
  assert.equal(code(() => parse(bad, CT)), 'bad-encoding');
  const cs = enc('--AaB03x\r\nContent-Disposition: form-data; name="a"\r\nContent-Type: text/plain; charset=shift_jis\r\n\r\nx\r\n--AaB03x--');
  assert.equal(code(() => parse(cs, CT)), 'bad-encoding');
  const r = parse(build('AaB03x', [{ name: '__proto__', value: 'p' }, { name: 'tag', value: '1' }, { name: 'tag', value: '2' }, { name: 'constructor', value: 'c' }]), CT);
  assert.equal(Object.getPrototypeOf(r.values), null);
  assert.equal(r.values['__proto__'], 'p');
  assert.deepEqual(r.values.tag, ['1', '2']);
  assert.equal(r.values.constructor, 'c');
  assert.equal(({} as Record<string, unknown>).p, undefined);
});

test('binary data containing CRLF and dashes passes through unchanged', () => {
  const data = new Uint8Array(5000).map((_, i) => [13, 10, 45, 45, 65, 97, 66, 0, 255][i % 9]!);
  const r = parse(build('AaB03x', [file('f', 'data.bin', data)]), CT);
  assert.deepEqual([...r.files[0]!.bytes], [...data]);
});

test('a parser that failed stays failed, and data after the close counts toward the total', () => {
  const p = new MultipartParser('AaB03x', { maxTotalBytes: 200 });
  p.write(enc('--AaB03x--'));
  assert.throws(() => p.write(new Uint8Array(500)), (e) => e instanceof MultipartError && e.code === 'limit-total');
  const q = new MultipartParser('AaB03x');
  assert.throws(() => q.write(enc('--AaB03x\r\nbroken\r\n\r\n')), MultipartError);
  assert.throws(() => q.write(enc('x')), MultipartError);
  assert.throws(() => q.end(), MultipartError);
});

test('build refuses a bad boundary and round-trips binary names', () => {
  assert.throws(() => build('bad boundary ', []), MultipartError);
  const r = parse(build('xyz', [file('up', 'naïve résumé.pdf', enc('%PDF-1.4 hello world'), 'application/pdf')]), 'multipart/form-data; boundary=xyz');
  assert.equal(r.files[0]!.filename, 'naïve résumé.pdf');
  assert.equal(r.files[0]!.sniffed, 'application/pdf');
});
