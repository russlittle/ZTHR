import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bodyStructure, command, decodeMailbox, encodeMailbox, expunged, fetched, formatSet, idlePlan, ImapCommandError, ImapParseError, ImapStateError, mailboxInfo, parseInternalDate, parseResponse, parseSet, planSync, ResponseStream, searchArgs, searchDate, searchResult, Session, tagger, text,
  type Arg, type Response, type SearchKey,
} from './index.ts';

const b = (s: string) => Buffer.from(s.replace(/\n/g, '\r\n'), 'latin1');
const line = (s: string): Response => parseResponse(b(`${s}\n`));
const wire = (segs: { data: Buffer }[]) => segs.map((s) => s.data.toString('utf8')).join('|');

test('tagged, untagged and continuation responses are told apart', () => {
  assert.deepEqual(line('A001 OK LOGIN completed'), { kind: 'tagged', tag: 'A001', status: 'OK', text: 'LOGIN completed' });
  assert.deepEqual(line('a2 NO [AUTHENTICATIONFAILED] Invalid credentials'), { kind: 'tagged', tag: 'a2', status: 'NO', code: { name: 'AUTHENTICATIONFAILED', args: [] }, text: 'Invalid credentials' });
  assert.deepEqual(line('+ idling'), { kind: 'continuation', text: 'idling' });
  assert.deepEqual(line('* 23 EXISTS'), { kind: 'untagged', type: 'exists', number: 23, data: [] });
  assert.deepEqual(line('* 3 expunge'), { kind: 'untagged', type: 'expunge', number: 3, data: [] });
  assert.deepEqual(line('* BYE Server shutting down'), { kind: 'untagged', type: 'status', status: 'BYE', text: 'Server shutting down', data: [] });
  const cap = line('* CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN IDLE');
  assert.deepEqual(cap.kind === 'untagged' && cap.data.map(text), ['IMAP4rev1', 'STARTTLS', 'AUTH=PLAIN', 'IDLE']);
});

test('response codes carry their arguments', () => {
  const ok = (s: string) => {
    const r = line(s);
    return r.kind === 'untagged' ? r.code : undefined;
  };
  assert.deepEqual(ok('* OK [UIDVALIDITY 3857529045] UIDs valid'), { name: 'UIDVALIDITY', args: [{ kind: 'atom', value: '3857529045' }] });
  const perm = ok('* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)] Limited');
  assert.deepEqual(perm!.args[0], { kind: 'list', items: [{ kind: 'atom', value: '\\Deleted' }, { kind: 'atom', value: '\\Seen' }, { kind: 'atom', value: '\\*' }] });
  const copy = line('A5 OK [COPYUID 38505 304,319:320 3956:3958] Done');
  assert.deepEqual(copy.kind === 'tagged' && copy.code!.args.map(text), ['38505', '304,319:320', '3956:3958']);
  assert.equal(ok('* OK [CAPABILITY IMAP4rev1 IDLE] hi')!.args.length, 2);
  assert.throws(() => line('* OK [UIDNEXT 4392 broken'), ImapParseError);
});

test('the RFC 3501 FETCH example reads into a typed record', () => {
  const r = line(
    `* 12 FETCH (FLAGS (\\Seen) INTERNALDATE "17-Jul-1996 02:44:25 -0700" RFC822.SIZE 4286 ENVELOPE ("Wed, 17 Jul 1996 02:23:25 -0700 (PDT)" "IMAP4rev1 WG mtg summary and minutes" (("Terry Gray" NIL "gray" "cac.washington.edu")) (("Terry Gray" NIL "gray" "cac.washington.edu")) (("Terry Gray" NIL "gray" "cac.washington.edu")) ((NIL NIL "imap" "cac.washington.edu")) ((NIL NIL "minutes" "CNRI.Reston.VA.US") ("John Klensin" NIL "KLENSIN" "MIT.EDU")) NIL NIL "<B27397-0100000@cac.washington.edu>") BODY ("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 3028 92) UID 4827)`,
  );
  const f = fetched(r);
  assert.equal(f.seq, 12);
  assert.equal(f.uid, 4827);
  assert.deepEqual(f.flags, ['\\Seen']);
  assert.equal(f.size, 4286);
  assert.equal(f.internalDate, '17-Jul-1996 02:44:25 -0700');
  assert.equal(parseInternalDate(f.internalDate!).toISOString(), '1996-07-17T09:44:25.000Z');
  assert.equal(f.envelope!.subject, 'IMAP4rev1 WG mtg summary and minutes');
  assert.deepEqual(f.envelope!.from, [{ name: 'Terry Gray', mailbox: 'gray', host: 'cac.washington.edu', address: 'gray@cac.washington.edu' }]);
  assert.deepEqual(f.envelope!.cc.map((a) => a.address), ['minutes@CNRI.Reston.VA.US', 'KLENSIN@MIT.EDU']);
  assert.equal(f.envelope!.messageId, '<B27397-0100000@cac.washington.edu>');
  assert.equal(f.envelope!.inReplyTo, undefined);
  assert.deepEqual(f.structure, { multipart: false, section: '1', type: 'text', subtype: 'plain', params: { charset: 'US-ASCII' }, encoding: '7bit', size: 3028 });
});

test('literals are read by length, even when they hold quotes, parentheses and line breaks', () => {
  const body = 'Subject: (hi) "there"\r\n\r\nline two\r\n';
  const r = parseResponse(Buffer.concat([Buffer.from(`* 1 FETCH (UID 7 BODY[HEADER] {${body.length}}\r\n`), Buffer.from(body), Buffer.from(')\r\n')]));
  const f = fetched(r);
  assert.equal(f.uid, 7);
  assert.equal(f.body['BODY[HEADER]']!.toString(), body);
  const sect = fetched(line('* 2 FETCH (BODY[HEADER.FIELDS (FROM TO)]<0> "From: a@b" UID 9)'));
  assert.deepEqual(Object.keys(sect.body), ['BODY[HEADER.FIELDS (FROM TO)]<0>']);
});

test('the stream waits for a literal split across chunks and yields responses as they complete', () => {
  const s = new ResponseStream();
  const whole = Buffer.concat([Buffer.from('* 1 FETCH (BODY[TEXT] {12}\r\nhello\r\nworld)\r\n* 2 EXISTS\r\nA1 OK done\r\n')]);
  const out: Response[] = [];
  for (let i = 0; i < whole.length; i += 7) out.push(...s.push(whole.subarray(i, i + 7)));
  assert.equal(out.length, 3);
  assert.equal(fetched(out[0]!).body['BODY[TEXT]']!.toString(), 'hello\r\nworld');
  assert.equal(out[1]!.kind === 'untagged' && out[1]!.number, 2);
  assert.equal(out[2]!.kind === 'tagged' && out[2]!.tag, 'A1');
  assert.equal(s.pending, 0);
  assert.deepEqual(new ResponseStream().push(Buffer.from('* 5 EXIS')), []);
});

test('hostile responses are refused, not buffered: huge literals, long lines, deep nesting, bad literals', () => {
  const s = new ResponseStream({ maxLine: 100, maxLiteral: 1000, maxResponse: 5000, maxDepth: 5 });
  assert.throws(() => s.push(Buffer.from('* 1 FETCH (BODY[1] {999999999}\r\n')), /over the limit/);
  assert.throws(() => new ResponseStream({ maxLine: 100, maxLiteral: 1000, maxResponse: 5000, maxDepth: 5 }).push(Buffer.from('x'.repeat(200))), /longer than the limit/);
  assert.throws(() => parseResponse(b(`* LIST ${'('.repeat(40)}${')'.repeat(40)}\n`)), /nested too deeply/);
  assert.throws(() => line('* 1 FETCH (BODY[1] {5}\r\nab)'), ImapParseError);
  assert.throws(() => line('* 1 FETCH (X "unterminated'), /line break/);
  assert.throws(() => line('* 1 FETCH (X "bad\\qescape")'), /bad escape/);
  assert.throws(() => line('A1 MAYBE what'), /OK, NO or BAD/);
  assert.throws(() => line('* 99999999999999999999 EXISTS'), /too large/);
  assert.throws(() => line('* LIST (\\HasNoChildren'), /not closed/);
});

test('SEARCH and ESEARCH results become id lists', () => {
  assert.deepEqual(searchResult(line('* SEARCH 2 84 882')), { ids: [2, 84, 882], uid: false });
  assert.deepEqual(searchResult(line('* SEARCH')), { ids: [], uid: false });
  assert.deepEqual(searchResult(line('* ESEARCH (TAG "A282") UID COUNT 5 ALL 4:7,9')), { ids: [4, 5, 6, 7, 9], uid: true, count: 5 });
  assert.throws(() => searchResult(line('* 1 EXISTS')), ImapParseError);
});

test('sequence and UID sets parse, count, compress and refuse nonsense', () => {
  assert.deepEqual(parseSet('1:3,7,10:*', 12), [1, 2, 3, 7, 10, 11, 12]);
  assert.deepEqual(parseSet('5:3', 9), [3, 4, 5]);
  assert.deepEqual(parseSet('*', 42), [42]);
  assert.deepEqual(parseSet('2,2,1:2', 9), [1, 2]);
  assert.equal(formatSet([1, 2, 3, 7, 10, 11, 12, 3]), '1:3,7,10:12');
  assert.equal(formatSet([]), '');
  for (const bad of ['', '0', '1:', ':3', '1,,2', 'a', '1:2:3', '-1', '1 2']) assert.throws(() => parseSet(bad, 10), ImapParseError, bad);
  assert.throws(() => parseSet('1:5000000', 9, 1000), /more than 1000 ids/);
  assert.throws(() => formatSet([0]), RangeError);
});

test('mailbox names use modified UTF-7, including the RFC 3501 example', () => {
  const rfc = '~peter/mail/&U,BTFw-/&ZeVnLIqe-';
  assert.equal(decodeMailbox(rfc), '~peter/mail/台北/日本語');
  assert.equal(encodeMailbox('~peter/mail/台北/日本語'), rfc);
  assert.equal(encodeMailbox('Tom & Jerry'), 'Tom &- Jerry');
  assert.equal(decodeMailbox('Tom &- Jerry'), 'Tom & Jerry');
  assert.equal(encodeMailbox('Entwürfe'), 'Entw&APw-rfe');
  assert.equal(decodeMailbox('Entw&APw-rfe'), 'Entwürfe');
  assert.equal(decodeMailbox(encodeMailbox('\u{1f600} café')), '\u{1f600} café');
  assert.throws(() => decodeMailbox('bad&AAA'), ImapParseError);
  assert.throws(() => decodeMailbox('bad&!!-'), ImapParseError);
});

test('commands are quoted, escaped and sent as literals when they must be; injection is refused', () => {
  assert.equal(wire(command('A1', 'LOGIN', [{ text: 'me@example.com' }, { text: 'pa"ss\\word' }])), 'A1 LOGIN "me@example.com" "pa\\"ss\\\\word"\r\n');
  assert.equal(wire(command('A2', 'SELECT', [{ mailbox: 'Entwürfe' }])), 'A2 SELECT "Entw&APw-rfe"\r\n');
  const lit = command('A3', 'LOGIN', [{ text: 'user' }, { text: 'two\r\nlines' }]);
  assert.deepEqual(lit.map((s) => s.waitForContinuation), [true, false]);
  assert.equal(wire(lit), 'A3 LOGIN "user" {10}\r\n|two\r\nlines\r\n');
  const non = command('A4', 'APPEND', [{ mailbox: 'INBOX' }, { bytes: Buffer.from('Subject: x\r\n\r\nbody') }], { nonSync: true });
  assert.equal(non.length, 1);
  assert.equal(wire(non), 'A4 APPEND "INBOX" {18+}\r\nSubject: x\r\n\r\nbody\r\n');
  assert.equal(wire(command('A5', 'UID FETCH', [{ set: '1:*' }, { list: [{ atom: 'FLAGS' }, { atom: 'BODY.PEEK[HEADER]' }] }])), 'A5 UID FETCH 1:* (FLAGS BODY.PEEK[HEADER])\r\n');
  for (const bad of [{ text: 'a\0b' }, { atom: 'x y' }, { raw: 'a\r\nA9 DELETE INBOX' }, { number: -1 }, { set: '1;2' }] as Arg[]) assert.throws(() => command('A6', 'NOOP', [bad]), ImapCommandError);
  assert.throws(() => command('A 7', 'NOOP'), ImapCommandError);
  assert.throws(() => command('A8', 'noop'), ImapCommandError);
  assert.throws(() => command('A8', 'NOOP\r\nA9 LOGOUT'), ImapCommandError);
  assert.equal(wire(command('A9', 'NOOP', [{ text: 'x'.repeat(1001) }])).startsWith('A9 NOOP {1001}'), true);
  const tag = tagger('T');
  assert.deepEqual([tag(), tag()], ['T0001', 'T0002']);
});

test('SEARCH criteria are written as arguments, with dates in IMAP form and groups parenthesised', () => {
  const w = (k: SearchKey) => wire(command('S1', 'SEARCH', searchArgs(k)));
  assert.equal(w('UNSEEN'), 'S1 SEARCH UNSEEN\r\n');
  assert.equal(w({ and: ['UNSEEN', { from: 'a"b' }, { since: new Date('2026-02-01T00:00:00Z') }] }), 'S1 SEARCH UNSEEN FROM "a\\"b" SINCE 1-Feb-2026\r\n');
  assert.equal(w({ or: [{ subject: 'x' }, { and: ['SEEN', { larger: 500 }] }] }), 'S1 SEARCH OR SUBJECT "x" (SEEN LARGER 500)\r\n');
  assert.equal(w({ not: { header: ['List-Id', 'dev'] } }), 'S1 SEARCH NOT HEADER "List-Id" "dev"\r\n');
  assert.equal(w({ uid: '100:*' }), 'S1 SEARCH UID 100:*\r\n');
  assert.equal(searchDate(new Date('1994-02-01T23:59:00Z')), '1-Feb-1994');
  assert.throws(() => w({ keyword: 'bad keyword' }), ImapCommandError);
});

test('the session follows the server and refuses commands the state does not allow', () => {
  const s = new Session();
  assert.throws(() => s.send('A1', 'SELECT', 'INBOX'), ImapStateError);
  s.send('A1', 'LOGIN');
  s.receive(line('A1 NO bad password'));
  assert.equal(s.state, 'not-authenticated');
  s.send('A2', 'LOGIN');
  s.receive(line('A2 OK ok'));
  assert.equal(s.state, 'authenticated');
  assert.throws(() => s.send('A3', 'FETCH'), /not allowed when authenticated/);
  s.send('A3', 'SELECT', 'INBOX');
  s.receive(line('A3 OK [READ-WRITE] done'));
  assert.deepEqual([s.state, s.mailbox], ['selected', 'INBOX']);
  s.send('A4', 'SELECT', 'Nope');
  assert.equal(s.state, 'authenticated', 'a SELECT closes the old mailbox even if it then fails');
  s.receive(line('A4 NO no such mailbox'));
  assert.deepEqual([s.state, s.mailbox], ['authenticated', undefined]);
  assert.throws(() => s.receive(line('A99 OK unknown')), /never sent/);
  assert.equal(new Session().receive(line('* PREAUTH hello')).length, 0);
});

test('IDLE: the continuation starts it, events arrive, DONE ends it, and nothing else may be sent meanwhile', () => {
  const s = new Session();
  s.send('A1', 'LOGIN');
  s.receive(line('A1 OK'));
  s.send('A2', 'SELECT', 'INBOX');
  s.receive(line('A2 OK'));
  s.send('A3', 'IDLE');
  assert.throws(() => s.doneBytes(), /not running/);
  s.receive(line('+ idling'));
  assert.equal(s.idling, true);
  assert.throws(() => s.send('A4', 'NOOP'), /send DONE first/);
  assert.deepEqual(s.receive(line('* 24 EXISTS')), [{ type: 'exists', number: 24 }]);
  assert.deepEqual(s.receive(line('* 3 EXPUNGE')), [{ type: 'expunge', number: 3 }]);
  assert.deepEqual(s.receive(line('* 5 FETCH (FLAGS (\\Seen))')), [{ type: 'flags', number: 5 }]);
  assert.equal(s.doneBytes().toString(), 'DONE\r\n');
  s.receive(line('A3 OK IDLE terminated'));
  assert.equal(s.idling, false);
  s.send('A5', 'FETCH');
  s.receive(line('A5 OK'));
  assert.deepEqual(s.receive(line('* BYE going away')), [{ type: 'bye', text: 'going away' }]);
  assert.equal(s.state, 'logout');
  assert.throws(() => s.send('A6', 'NOOP'), /closing/);
});

test('SELECT data becomes mailbox info', () => {
  const rs = ['* 172 EXISTS', '* 1 RECENT', '* OK [UIDVALIDITY 3857529045] UIDs valid', '* OK [UIDNEXT 4392] Predicted next UID', '* OK [HIGHESTMODSEQ 715194045007] x', '* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)', '* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)] Limited', 'A142 OK [READ-WRITE] SELECT completed'].map(line);
  assert.deepEqual(mailboxInfo(rs), { exists: 172, recent: 1, uidValidity: 3857529045, uidNext: 4392, highestModSeq: 715194045007, flags: ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'], permanentFlags: ['\\Deleted', '\\Seen', '\\*'], readOnly: false });
  assert.equal(mailboxInfo([line('A1 OK [READ-ONLY] examine')]).readOnly, true);
});

test('a changed UIDVALIDITY discards the cache; otherwise only new UIDs are fetched', () => {
  const cached = { uidValidity: 3857529045, lastUid: 4390, uids: [4388, 4389, 4390] };
  assert.deepEqual(planSync(cached, { uidValidity: 3857529045, uidNext: 4395, exists: 8 }), { action: 'catch-up', fetch: '4391:*', check: '4388:4390', expectNew: 4 });
  assert.deepEqual(planSync(cached, { uidValidity: 3857529045, uidNext: 4391, exists: 3 }), { action: 'catch-up', fetch: '', check: '4388:4390', expectNew: 0 });
  const changed = planSync(cached, { uidValidity: 7, uidNext: 5, exists: 4 });
  assert.deepEqual(changed, { action: 'start-over', reason: 'UIDVALIDITY changed from 3857529045 to 7', fetch: '1:*' });
  assert.equal(planSync(undefined, { uidValidity: 7, uidNext: 1, exists: 0 }).action, 'start-over');
  assert.equal(planSync(undefined, { uidValidity: 7, uidNext: 1, exists: 0 }).fetch, '');
  assert.throws(() => planSync(cached, { uidValidity: 0, uidNext: 1, exists: 0 }), ImapParseError);
  assert.deepEqual(expunged([1, 2, 3, 4], [1, 3]), [2, 4]);
});

test('the IDLE loop re-issues before the 29-minute limit and polls where IDLE is missing', () => {
  const T = 1_000_000_000;
  const MIN = 60_000;
  assert.deepEqual(idlePlan({ supportsIdle: true, now: T }), { do: 'idle' });
  assert.deepEqual(idlePlan({ supportsIdle: true, idleSince: T, now: T + 10 * MIN }), { do: 'wait', until: T + 29 * MIN });
  const r = idlePlan({ supportsIdle: true, idleSince: T, now: T + 29 * MIN });
  assert.equal(r.do, 'restart-idle');
  assert.equal(idlePlan({ supportsIdle: true, idleSince: T, now: T + 20 * MIN }, { maxIdleMs: 20 * MIN }).do, 'restart-idle');
  assert.equal(idlePlan({ supportsIdle: true, idleSince: T, now: T + 40 * MIN }, { maxIdleMs: 3 * 60 * MIN }).do, 'restart-idle', 'a longer setting is capped at 29 minutes');
  assert.deepEqual(idlePlan({ supportsIdle: false, now: T }), { do: 'poll' });
  assert.deepEqual(idlePlan({ supportsIdle: false, lastPollAt: T, now: T + 10_000 }), { do: 'wait', until: T + 60_000 });
  assert.deepEqual(idlePlan({ supportsIdle: false, lastPollAt: T, now: T + 60_000 }), { do: 'poll' });
});

test('a multipart body structure gets section numbers, and a malformed one is refused', () => {
  const r = line('* 1 FETCH (BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 120 4)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "BASE64" 800 20) "ALTERNATIVE"))');
  const f = fetched(r);
  assert.equal(f.structure!.multipart, true);
  const m = f.structure as Extract<typeof f.structure, { multipart: true }>;
  assert.equal(m.subtype, 'alternative');
  assert.deepEqual(m.parts.map((p) => (p.multipart ? '' : `${p.section} ${p.type}/${p.subtype} ${p.encoding} ${p.size}`)), ['1 text/plain quoted-printable 120', '2 text/html base64 800']);
  assert.throws(() => bodyStructure({ kind: 'list', items: [] }), ImapParseError);
  assert.throws(() => fetched(line('* 1 EXISTS')), ImapParseError);
  assert.throws(() => parseInternalDate('yesterday'), ImapParseError);
});
