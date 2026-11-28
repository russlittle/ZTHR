import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MimeError, attachments, bodies, buildMessage, contentIds, decodeQuotedPrintable, decodeWords, encodeBase64Lines, encodeQuotedPrintable, encodeWords, foldHeader, formatMailbox, formatParam, header, headerText, parseAddresses, parseMessage, parseParams, rewriteCids, safeFilename, textValue } from './index.ts';
import type { OutMessage } from './index.ts';

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

test('RFC 2047 section 8: the published encoded-word examples', () => {
  const cases: [string, string][] = [
    ['(=?ISO-8859-1?Q?a?=)', '(a)'],
    ['(=?ISO-8859-1?Q?a?= b)', '(a b)'],
    ['(=?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a?=  =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a?=\r\n    =?ISO-8859-1?Q?b?=)', '(ab)'],
    ['(=?ISO-8859-1?Q?a_b?=)', '(a b)'],
    ['(=?ISO-8859-1?Q?a?= =?ISO-8859-2?Q?_b?=)', '(a b)'],
    ['=?US-ASCII?Q?Keith_Moore?=', 'Keith Moore'],
    ['=?ISO-8859-1?Q?Keld_J=F8rn_Simonsen?=', 'Keld Jørn Simonsen'],
    ['=?ISO-8859-1?Q?Andr=E9?= Pirard', 'André Pirard'],
    ['=?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?= =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=', 'If you can read this you understand the example.'],
    ['=?ISO-8859-1?Q?Olle_J=E4rnefors?=', 'Olle Järnefors'],
  ];
  for (const [src, want] of cases) assert.equal(decodeWords(src), want, src);
});

test('encoded words: not decoded when malformed, charsets honoured, and a language tag allowed', () => {
  assert.equal(decodeWords('=?UTF-8?Q?caf=C3=A9?='), 'café');
  assert.equal(decodeWords('=?utf-8*en?B?Y2Fmw6k=?='), 'café');
  assert.equal(decodeWords('=?UTF-8?X?abc?='), '=?UTF-8?X?abc?=');
  assert.equal(decodeWords('plain text, no words'), 'plain text, no words');
  assert.equal(decodeWords('=?shift_jis?B?k/qWe4zq?='), '日本語');
  assert.equal(decodeWords('=?no-such-charset?Q?a?='), 'a', 'an unknown charset falls back to UTF-8');
});

test('encoding words: every word at most 75 characters, no character split, and decodes back', () => {
  const s = 'Grüße aus Köln — 日本語のタイトル '.repeat(6);
  const words = encodeWords(s);
  for (const w of words) assert.ok(w.length <= 75, `${w.length}`);
  assert.equal(decodeWords(words.join(' ')), s);
  assert.deepEqual(encodeWords('é'), ['=?UTF-8?B?w6k=?=']);
  assert.equal(textValue('Hello'), 'Hello');
  assert.equal(textValue('Café'), '=?UTF-8?B?Q2Fmw6k=?=');
});

test('RFC 2045 5.1: quoted-printable decodes, with soft breaks', () => {
  assert.equal(decodeQuotedPrintable('Now\'s the time =\r\nfor all folk to come=\r\n to the aid of their country.').toString('latin1'), "Now's the time for all folk to come to the aid of their country.");
  assert.equal(decodeQuotedPrintable('caf=C3=A9 =3D 1\r\nline two').toString('utf8'), 'café = 1\r\nline two');
  assert.equal(decodeQuotedPrintable('bad =ZZ escape =\n').toString('latin1'), 'bad =ZZ escape ', 'invalid escapes are kept as written');
  assert.equal(decodeQuotedPrintable('soft  \t=  \r\nbreak').toString('latin1'), 'soft  \t=  \r\nbreak'.replace('=  \r\n', ''), 'trailing blanks after = are tolerated');
});

test('quoted-printable encoding: 76-column lines, trailing blanks, equals signs, and a round trip', () => {
  const s = `${'é'.repeat(60)}\r\nEnds with space \r\nand = sign\r\n\r\nlast`;
  const enc = encodeQuotedPrintable(Buffer.from(s, 'utf8'));
  for (const line of enc.split('\r\n')) assert.ok(line.length <= 76, line);
  assert.ok(enc.includes('Ends with space=20\r\n'));
  assert.ok(enc.includes('and =3D sign'));
  assert.equal(decodeQuotedPrintable(enc).toString('utf8'), s);
  assert.equal(encodeQuotedPrintable(Buffer.from('plain')), 'plain');
  assert.equal(encodeQuotedPrintable(Buffer.from('a\r\nb'), true), 'a=0D=0Ab', 'binary mode encodes the breaks');
  assert.ok(!/=\r\n$/.test(encodeQuotedPrintable(Buffer.from('x'.repeat(75)))), 'an exact fit does not end on a soft break');
});

test('base64 in 76-column lines, and decoding that tolerates whitespace and missing padding but says when the data is dirty', () => {
  const data = Buffer.from(Array.from({ length: 200 }, (_, i) => i));
  const enc = encodeBase64Lines(data);
  assert.ok(enc.split('\r\n').every((l) => l.length <= 76));
  const msg = parseMessage(`Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${enc}\r\n`);
  assert.deepEqual(msg.body, data);
  const dirty = parseMessage('Content-Transfer-Encoding: base64\r\n\r\nSGVs!bG8');
  assert.equal(dirty.body.toString(), 'Hello');
  assert.deepEqual(dirty.problems, ['base64 with characters outside the alphabet']);
});

test('RFC 2231: the published parameter examples, extended values and continuations', () => {
  assert.equal(parseParams("application/x-stuff; title*=us-ascii'en-us'This%20is%20%2A%2A%2Afun%2A%2A%2A").params['title'], 'This is ***fun***');
  const cont = parseParams('message/external-body; access-type=URL;\r\n URL*0="ftp://";\r\n URL*1="cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar"');
  assert.equal(cont.value, 'message/external-body');
  assert.equal(cont.params['access-type'], 'URL');
  assert.equal(cont.params['url'], 'ftp://cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar');
  assert.equal(parseParams("message/external-body; title*0*=us-ascii'en'This%20is%20even%20more%20; title*1*=%2A%2A%2Afun%2A%2A%2A%20; title*2=\"isn't it!\"").params['title'], "This is even more ***fun*** isn't it!");
  assert.equal(parseParams("attachment; filename*=UTF-8''%E2%82%AC%20rates.txt").params['filename'], '€ rates.txt');
  assert.equal(parseParams("attachment; filename*=iso-8859-1'en'%A3%20rates").params['filename'], '£ rates');
  assert.equal(parseParams('text/plain; charset="utf-8"; (a comment) format=flowed').params['format'], 'flowed');
});

test('formatting parameters: plain, quoted, and extended with a fallback; and they read back', () => {
  assert.equal(formatParam('filename', 'report.pdf'), 'filename=report.pdf');
  assert.equal(formatParam('filename', 'my "report".pdf'), 'filename="my \\"report\\".pdf"');
  const ext = formatParam('filename', 'Übersicht €.pdf');
  assert.equal(ext, "filename*=UTF-8''%C3%9Cbersicht%20%E2%82%AC.pdf; filename=\"Ubersicht _.pdf\"");
  assert.equal(parseParams(`attachment; ${ext}`).params['filename'], 'Übersicht €.pdf');
  assert.throws(() => formatParam('filename', 'a\r\nBcc: x'), MimeError);
});

test('RFC 5322 appendix A: the example address lists', () => {
  assert.deepEqual(parseAddresses('"Joe Q. Public" <john.q.public@example.com>'), [{ name: 'Joe Q. Public', address: 'john.q.public@example.com' }]);
  assert.deepEqual(parseAddresses('Mary Smith <mary@x.test>, jdoe@example.org, Who? <one@y.test>'), [{ name: 'Mary Smith', address: 'mary@x.test' }, { address: 'jdoe@example.org' }, { name: 'Who?', address: 'one@y.test' }]);
  assert.deepEqual(parseAddresses('<boss@nil.test>, "Giant; \\"Big\\" Box" <sysservices@example.net>'), [{ address: 'boss@nil.test' }, { name: 'Giant; "Big" Box', address: 'sysservices@example.net' }]);
  assert.deepEqual(parseAddresses('Pete(A nice \\) chap) <pete@silly.test>'), [{ name: 'Pete', address: 'pete@silly.test' }], 'comments are dropped');
  assert.deepEqual(parseAddresses('A Group:Ed Jones <c@a.test>,joe@where.test,John <jdoe@one.test>;'), [
    { name: 'Ed Jones', address: 'c@a.test', group: 'A Group' },
    { address: 'joe@where.test', group: 'A Group' },
    { name: 'John', address: 'jdoe@one.test', group: 'A Group' },
  ]);
});

test('addresses: encoded names, commas inside quotes, and junk skipped', () => {
  assert.deepEqual(parseAddresses('=?UTF-8?B?Sm9zw6k=?= <jose@example.org>'), [{ name: 'José', address: 'jose@example.org' }]);
  assert.deepEqual(parseAddresses('"Doe, Jane" <jane@example.org>, not an address, <bad@>, ok@example.org'), [{ name: 'Doe, Jane', address: 'jane@example.org' }, { address: 'ok@example.org' }]);
  assert.deepEqual(parseAddresses(''), []);
});

test('formatting addresses: quoting, encoded names, punycode domains, and injection refused', () => {
  assert.equal(formatMailbox({ address: 'a@example.org' }), 'a@example.org');
  assert.equal(formatMailbox({ name: 'Ana Lopez', address: 'a@example.org' }), 'Ana Lopez <a@example.org>');
  assert.equal(formatMailbox({ name: 'Lopez, Ana', address: 'a@example.org' }), '"Lopez, Ana" <a@example.org>');
  assert.equal(formatMailbox({ name: 'José', address: 'j@example.org' }), '=?UTF-8?B?Sm9zw6k=?= <j@example.org>');
  assert.equal(formatMailbox({ address: 'x@münchen.example' }), 'x@xn--mnchen-3ya.example');
  for (const bad of ['a@b.c\r\nBcc: evil@x.test', 'no-at-sign', 'ü@example.org', 'a b@example.org']) assert.throws(() => formatMailbox({ address: bad }), MimeError, bad);
  assert.throws(() => formatMailbox({ name: 'x\nBcc: a@b.c', address: 'a@example.org' }), /inject/);
});

test('header folding at 78 columns', () => {
  const v = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const folded = foldHeader('Subject', v);
  assert.ok(folded.split('\r\n').every((l) => l.length <= 78));
  assert.ok(folded.split('\r\n').slice(1).every((l) => l.startsWith(' ')));
  assert.equal(folded.replace(/\r\n /g, ' '), `Subject: ${v}`);
  assert.equal(foldHeader('X', 'short'), 'X: short');
});

test('filenames are made safe: paths, control and bidi characters, reserved names, length', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('C:\\Users\\x\\evil.exe'), 'evil.exe');
  assert.equal(safeFilename('report\u202Egpj.exe'), 'reportgpj.exe', 'a right-to-left override cannot disguise the extension');
  assert.equal(safeFilename('a\u0000b\nc.txt'), 'abc.txt');
  assert.equal(safeFilename('...hidden'), 'hidden');
  assert.equal(safeFilename('NUL.txt'), '_NUL.txt');
  assert.equal(safeFilename(''), 'attachment');
  assert.equal(safeFilename('x'.repeat(400) + '.pdf').length, 255);
  assert.equal(safeFilename('what?*.txt'), 'what__.txt');
});

const sample = crlf(`From: =?UTF-8?B?Sm9zw6k=?= <jose@example.org>
To: Ana <ana@example.org>,
 Bo <bo@example.org>
Subject: =?UTF-8?Q?Caf=C3=A9?= menu
 for =?UTF-8?Q?Friday?=
Date: Sat, 28 Nov 2026 12:00:00 +0000
Message-ID: <abc@example.org>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

preamble text
--outer
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Caf=E9 menu
--alt
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

PHA+PGltZyBzcmM9ImNpZDpsb2dvQGV4YW1wbGUiPiBjYWbDqTwvcD4=
--alt--
--rel
Content-Type: image/png; name="logo.png"
Content-Transfer-Encoding: base64
Content-ID: <logo@example>
Content-Disposition: inline

iVBORw0KGgo=
--rel--
--outer
Content-Type: application/pdf
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename*=UTF-8''men%C3%BC.pdf

JVBERi0xLjQK
--outer
Content-Type: application/pdf
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="menü.pdf"

JVBERi0xLjQK
--outer--
epilogue
`);

test('a real nested message: headers, bodies in their charsets, inline image by Content-ID, attachments by name', () => {
  const m = parseMessage(sample);
  assert.equal(m.type, 'multipart/mixed');
  assert.equal(headerText(m, 'subject'), 'Café menu for Friday');
  assert.deepEqual(parseAddresses(header(m, 'from')!), [{ name: 'José', address: 'jose@example.org' }]);
  assert.deepEqual(parseAddresses(header(m, 'to')!).map((a) => a.address), ['ana@example.org', 'bo@example.org']);
  const b = bodies(m);
  assert.equal(b.text, 'Café menu');
  assert.equal(b.html, '<p><img src="cid:logo@example"> café</p>');
  const files = attachments(m);
  assert.deepEqual(files.map((a) => [a.filename, a.type, a.inline, a.contentId]), [['logo.png', 'image/png', true, 'logo@example'], ['menü.pdf', 'application/pdf', false, undefined], ['menü (2).pdf', 'application/pdf', false, undefined]]);
  assert.deepEqual(files[1]!.data, Buffer.from('%PDF-1.4\n'));
  assert.deepEqual([...contentIds(m).keys()], ['logo@example']);
  const html = rewriteCids(b.html!, m, (p) => `data:${p.type};base64,${p.body.toString('base64')}`);
  assert.equal(html, '<p><img src="data:image/png;base64,iVBORw0KGgo="> café</p>');
  assert.equal(rewriteCids('<img src="cid:unknown">', m, () => undefined), '<img src="cid:unknown">');
});

test('bare line feeds, a missing closing boundary and a missing boundary parameter are survived and reported', () => {
  const lf = parseMessage('Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nhello\n--b\nContent-Type: text/plain\n\nunfinished\n');
  assert.deepEqual(lf.parts.map((p) => p.text), ['hello', 'unfinished\r\n']);
  assert.deepEqual(lf.problems, ['the closing boundary is missing']);
  const nob = parseMessage('Content-Type: multipart/mixed\r\n\r\nbody');
  assert.deepEqual([nob.parts.length, nob.problems], [0, ['multipart without a usable boundary']]);
  const odd = parseMessage('Content-Type: text/plain; charset=made-up\r\nContent-Transfer-Encoding: weird\r\n\r\nabc');
  assert.equal(odd.text, 'abc');
  assert.equal(odd.problems.length, 2);
});

test('attached messages are parsed as messages, and not walked into unless asked', () => {
  const inner = 'From: a@example.org\r\nSubject: inner\r\nContent-Type: text/plain\r\n\r\ninner body';
  const outer = `Content-Type: multipart/mixed; boundary=o\r\n\r\n--o\r\nContent-Type: text/plain\r\n\r\nouter body\r\n--o\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename=fwd.eml\r\n\r\n${inner}\r\n--o--\r\n`;
  const m = parseMessage(outer);
  assert.equal(bodies(m).text, 'outer body');
  const msg = m.parts[1]!;
  assert.equal(msg.parts[0]!.text, 'inner body');
  assert.equal(headerText(msg.parts[0]!, 'subject'), 'inner');
  assert.deepEqual(attachments(m).map((a) => a.filename), ['fwd.eml']);
});

test('hostile messages are refused: too big, too deep, too many parts, too many headers', () => {
  assert.throws(() => parseMessage(Buffer.alloc(101), { maxBytes: 100 }), /over 100 bytes/);
  let deep = 'Content-Type: text/plain\r\n\r\nx';
  for (let i = 0; i < 30; i++) deep = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${deep}\r\n--b${i}--\r\n`;
  assert.throws(() => parseMessage(deep), /nested too deeply/);
  const many = `Content-Type: multipart/mixed; boundary=b\r\n\r\n${'--b\r\nContent-Type: text/plain\r\n\r\nx\r\n'.repeat(20)}--b--\r\n`;
  assert.throws(() => parseMessage(many, { maxParts: 10 }), /too many parts/);
  assert.throws(() => parseMessage(`${'X: 1\r\n'.repeat(600)}\r\nbody`), /too many headers/);
  assert.equal(parseMessage(many, { maxParts: 100 }).parts.length, 20);
});

const out: OutMessage = {
  from: { name: 'Ana Lopez', address: 'ana@example.org' },
  to: [{ name: 'José Álvarez', address: 'jose@example.org' }, { address: 'bo@münchen.example' }],
  cc: [{ address: 'cc@example.org' }],
  bcc: [{ address: 'secret@example.org' }],
  subject: 'Menú für Freitag — please confirm',
  text: 'Hola José,\nCafé at noon.\n',
  html: '<p>Hola <b>José</b>, <img src="cid:logo@example.org"></p>',
  attachments: [{ filename: 'logo.png', data: Buffer.from([137, 80, 78, 71]), type: 'image/png', contentId: 'logo@example.org' }, { filename: 'Übersicht.pdf', data: Buffer.from('%PDF-1.4\n'), type: 'application/pdf' }],
  date: new Date('2026-11-28T12:00:00Z'),
  messageId: '<id1@example.org>',
};
const mk = (patch: Record<string, unknown>): OutMessage => ({ ...out, ...patch }) as unknown as OutMessage;
let seed = 0;
const rnd = (n: number) => Buffer.from(Array.from({ length: n }, () => (seed = (seed * 31 + 7) & 255)));

test('a built message has the right structure: mixed > related > alternative, ASCII only on the wire, bcc never written', () => {
  const raw = buildMessage(out, { random: rnd });
  const s = raw.toString('latin1');
  assert.ok(/^[\x00-\x7f]*$/.test(s), 'every byte is ASCII');
  assert.ok(s.includes('\r\n\r\n') && !/[^\r]\n/.test(s), 'CRLF only');
  assert.ok(!s.includes('secret@example.org') && !/^bcc:/im.test(s));
  const m = parseMessage(raw);
  assert.deepEqual([m.type, m.parts[0]!.type, m.parts[0]!.parts[0]!.type, m.parts[0]!.parts[1]!.type, m.parts[1]!.type], ['multipart/mixed', 'multipart/related', 'multipart/alternative', 'image/png', 'application/pdf']);
  assert.equal(headerText(m, 'subject'), 'Menú für Freitag — please confirm');
  assert.deepEqual(parseAddresses(header(m, 'to')!), [{ name: 'José Álvarez', address: 'jose@example.org' }, { address: 'bo@xn--mnchen-3ya.example' }]);
  assert.equal(header(m, 'date'), 'Sat, 28 Nov 2026 12:00:00 +0000');
  assert.equal(header(m, 'mime-version'), '1.0');
  const b = bodies(m);
  assert.equal(b.text?.replace(/\r\n/g, '\n'), 'Hola José,\nCafé at noon.\n');
  assert.equal(b.html, out.html);
  const files = attachments(m);
  assert.deepEqual(files.map((a) => [a.filename, a.inline, a.contentId]), [['logo.png', true, 'logo@example.org'], ['Übersicht.pdf', false, undefined]]);
  assert.deepEqual(files[0]!.data, Buffer.from([137, 80, 78, 71]));
  assert.ok(s.split('\r\n').every((l) => l.length <= 998 && !/^[^=]{79,}$/.test(l) || /^[A-Za-z0-9+/=]*$/.test(l)));
});

test('simple messages are simple: text only is 7bit with no multipart; html only is quoted-printable', () => {
  const base = { ...out, attachments: [] };
  const plain = buildMessage(mk({ ...base, subject: 'Hi', html: undefined }), { random: rnd }).toString('latin1');
  assert.ok(plain.includes('Content-Type: text/plain; charset=utf-8'), 'non-ASCII text is quoted-printable utf-8');
  const ascii = buildMessage(mk({ ...base, subject: 'Hi', text: 'Hello\nthere', html: undefined }), { random: rnd }).toString('latin1');
  assert.ok(ascii.includes('Content-Type: text/plain; charset=us-ascii\r\nContent-Transfer-Encoding: 7bit\r\n\r\nHello\r\nthere'));
  assert.ok(!ascii.includes('multipart'));
  const html = buildMessage(mk({ ...base, text: undefined }), { random: rnd }).toString('latin1');
  assert.ok(html.includes('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable'));
});

test('building refuses what would break or inject: line breaks in headers, bad ids, no recipient, no body, bad types', () => {
  const t = (patch: Record<string, unknown>) => () => buildMessage(mk(patch), { random: rnd });
  assert.throws(t({ subject: 'Hi\r\nBcc: evil@example.org' }), /inject/);
  assert.throws(t({ headers: { 'X-Note': 'a\nBcc: x' } }), /inject/);
  assert.throws(t({ headers: { 'Bad Name': 'x' } }), /not a header name/);
  assert.throws(t({ headers: { Subject: 'x' } }), /set by the message itself/);
  assert.throws(t({ messageId: 'no-brackets' }), /Message-ID/);
  assert.throws(t({ inReplyTo: 'x' }), /In-Reply-To/);
  assert.throws(t({ to: [], cc: [], bcc: [] }), /recipient/);
  assert.throws(t({ text: undefined, html: undefined }), /body/);
  assert.throws(t({ attachments: [{ filename: 'x', data: Buffer.alloc(1), type: 'text/plain\r\nX: y' }] }), /not a media type/);
  assert.throws(t({ attachments: [{ filename: 'x', data: Buffer.alloc(1), contentId: 'a b' }] }), /Content-ID/);
});

test('a boundary is chosen that does not occur in the content', () => {
  const calls: Buffer[] = [];
  const first = Buffer.alloc(15, 1);
  const clash = `=_${first.toString('base64url')}0`;
  const raw = buildMessage({ ...out, attachments: [], text: `before\n--${clash}\nafter`, html: '<p>x</p>' }, { random: (n) => (calls.push(Buffer.alloc(n)), calls.length === 1 ? first : Buffer.alloc(n, 2)) }).toString('latin1');
  const m = parseMessage(raw);
  assert.equal(m.parts.length, 2);
  assert.ok(bodies(m).text!.includes(`--${clash}`));
});

test('threading headers and extra headers are written folded and checked', () => {
  const raw = buildMessage({ ...out, attachments: [], inReplyTo: '<p@example.org>', references: ['<a@example.org>', '<b@example.org>'], headers: { 'List-Unsubscribe': '<https://example.org/u/1>', 'X-Tag': 'Café' }, replyTo: { address: 'help@example.org' } }, { random: rnd });
  const m = parseMessage(raw);
  assert.equal(header(m, 'in-reply-to'), '<p@example.org>');
  assert.equal(header(m, 'references'), '<a@example.org> <b@example.org>');
  assert.equal(header(m, 'list-unsubscribe'), '<https://example.org/u/1>');
  assert.equal(headerText(m, 'x-tag'), 'Café');
  assert.equal(header(m, 'reply-to'), 'help@example.org');
});

test('a long subject folds, and still reads back the same', () => {
  const subject = 'Ünïcode '.repeat(30) + 'end';
  const raw = buildMessage({ ...out, attachments: [], subject }, { random: rnd });
  assert.ok(raw.toString('latin1').split('\r\n').every((l) => l.length <= 998));
  assert.ok(raw.toString('latin1').split('\r\n\r\n')[0]!.split('\r\n').every((l) => l.length <= 78));
  assert.equal(headerText(parseMessage(raw), 'subject'), subject.trim());
});
