import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadIndex, ThreadingError, addressOf, autoReplyHeaders, baseSubject, buildThreads, decodeWords, detectAuto, flatten, generateMessageId, hopCount, isReply, mayAutoReply, messageFromHeaders, parseHeaders, parseIdList, replyReferences, replySubject, subjectKey } from './index.ts';
import type { Message, ThreadNode } from './index.ts';

const m = (id: string, subject: string, date: number, refs: string[] = [], over: Partial<Message> = {}): Message => ({ id, messageId: `<${id}@x.example>`, subject, date, references: refs.map((r) => `<${r}@x.example>`), ...over });
const ids = (n: ThreadNode): unknown => (n.children.length ? [n.message?.id ?? `~${n.messageId}`, n.children.map(ids)] : n.message?.id ?? `~${n.messageId}`);

test('headers: folded lines are joined, names are case-insensitive to look up, and parsing stops at the blank line', () => {
  const raw = 'Subject: A long\r\n subject that\r\n\tcontinues\r\nFrom: Ana <ana@example.com>\r\nbroken line\r\nReceived: a\r\nReceived: b\r\n\r\nBody: not a header\r\n';
  const hs = parseHeaders(raw);
  assert.deepEqual(hs, [{ name: 'Subject', value: 'A long subject that continues' }, { name: 'From', value: 'Ana <ana@example.com>' }, { name: 'Received', value: 'a' }, { name: 'Received', value: 'b' }]);
  assert.equal(hopCount(hs), 2);
  assert.deepEqual(parseHeaders('Bad Name: x\nGood-Name: y'), [{ name: 'Good-Name', value: 'y' }]);
  assert.throws(() => parseHeaders('x'.repeat(300_000)), ThreadingError);
});

test('message ids: all of them in order, once each, ignoring comments and junk', () => {
  assert.deepEqual(parseIdList('<a@x> <b@y.example> (a comment) <c@z>'), ['<a@x>', '<b@y.example>', '<c@z>']);
  assert.deepEqual(parseIdList('<a@x>,\r\n <a@x> <b@y>'), ['<a@x>', '<b@y>']);
  assert.deepEqual(parseIdList('<no-at-sign> <> <a b@x> plain@text.example'), []);
  assert.deepEqual(parseIdList(undefined), []);
  assert.equal(parseIdList('x'.repeat(70_000)).length, 0, 'an absurd header is ignored');
  assert.equal(generateMessageId('Mail.Example.COM', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 255])), '<01020304050607ff@mail.example.com>');
  assert.throws(() => generateMessageId('bad domain', new Uint8Array(8)), /not a domain/);
  assert.throws(() => generateMessageId('a.example', new Uint8Array(4)), /at least 8/);
});

test('RFC 2047 encoded words: UTF-8 and Latin-1, B and Q, adjacent words joined, damage left alone', () => {
  assert.equal(decodeWords('=?UTF-8?B?w4RwZmVs?= und Birnen'), 'Äpfel und Birnen');
  assert.equal(decodeWords('=?utf-8?Q?Caf=C3=A9_au_lait?='), 'Café au lait');
  assert.equal(decodeWords('=?ISO-8859-1?Q?Andr=E9?='), 'André');
  assert.equal(decodeWords('=?UTF-8?B?SGVsbG8g?= =?UTF-8?B?V29ybGQ=?='), 'Hello World', 'whitespace between encoded words disappears');
  assert.equal(decodeWords('Re: =?UTF-8?Q?caf=C3=A9?= menu'), 'Re: café menu');
  assert.equal(decodeWords('=?no-such-charset?B?QQ==?='), '=?no-such-charset?B?QQ==?=');
  assert.equal(decodeWords('plain text'), 'plain text');
  assert.equal(decodeWords('=?UTF-8?Q?bad=ZZ?='), 'bad=ZZ', 'a broken escape stays as written');
});

test('base subject: replies, forwards, counters, localised prefixes, list tags, trailers and wrappers all come off', () => {
  const cases: [string, string][] = [
    ['Hello', 'Hello'],
    ['Re: Hello', 'Hello'],
    ['RE: re: Re: Hello', 'Hello'],
    ['Fw: Hello', 'Hello'],
    ['Fwd: Re: Hello', 'Hello'],
    ['Re[2]: Hello', 'Hello'],
    ['Re(3): Hello', 'Hello'],
    ['Re : Hello', 'Hello'],
    ['AW: Hello', 'Hello'],
    ['SV: VS: Hello', 'Hello'],
    ['回复: Hello', 'Hello'],
    ['RE： Hello', 'Hello'],
    ['[list] Re: Hello', 'Hello'],
    ['Re: [list] Hello', 'Hello'],
    ['[a][b] Fwd: Hello', 'Hello'],
    ['Hello (fwd)', 'Hello'],
    ['Re: Hello (fwd) (fwd)', 'Hello'],
    ['[Fwd: Hello]', 'Hello'],
    ['[FWD: Re: Hello]', 'Hello'],
    ['  Hello \t  world  ', 'Hello world'],
    ['=?UTF-8?Q?Re=3A_caf=C3=A9?=', 'café'],
    ['Review of the plan', 'Review of the plan'],
    ['Refund: request', 'Refund: request'],
    ['Reference: 12', 'Reference: 12'],
    ['[Quarterly] numbers', 'numbers'],
    ['[only a tag]', '[only a tag]'],
    ['Re:', ''],
    ['Re: Re:', ''],
    ['', ''],
  ];
  for (const [input, want] of cases) assert.equal(baseSubject(input), want, JSON.stringify(input));
  assert.equal(subjectKey('RE: HELLO World'), 'hello world');
  assert.equal(isReply('Re: x'), true);
  assert.equal(isReply('[list] Fwd: x'), true);
  assert.equal(isReply('[Fwd: x]'), true);
  assert.equal(isReply('Review'), false);
  assert.equal(isReply('x'), false);
});

test('a chain of replies threads by References, however the messages arrive', () => {
  const a = m('a', 'Plan', 1);
  const b = m('b', 'Re: Plan', 2, ['a']);
  const c = m('c', 'Re: Plan', 3, ['a', 'b']);
  const d = m('d', 'Re: Plan', 4, ['a', 'b']);
  for (const order of [[a, b, c, d], [d, c, b, a], [c, a, d, b], [b, d, c, a]]) {
    const t = buildThreads(order);
    assert.equal(t.length, 1);
    assert.deepEqual(ids(t[0]!.root), ['a', [['b', ['c', 'd']]]], 'shape a > b > (c, d)');
    assert.equal(t[0]!.count, 4);
    assert.equal(t[0]!.subject, 'Plan');
    assert.equal(t[0]!.first, 1);
    assert.equal(t[0]!.last, 4);
  }
});

test('In-Reply-To alone is enough when there is no References, and References wins when both exist', () => {
  const a = m('a', 'Topic', 1);
  const b = m('b', 'Re: Topic', 2, [], { inReplyTo: ['<a@x.example>'] });
  const c = m('c', 'Re: Topic', 3, ['a'], { inReplyTo: ['<b@x.example>'] });
  const t = buildThreads([c, b, a]);
  assert.equal(t.length, 1);
  assert.deepEqual(ids(t[0]!.root), ['a', ['b', 'c']], 'c claims a as its only reference, so it hangs from a, not from b');
});

test('a lost parent leaves a placeholder only when it ties two or more messages together', () => {
  const b = m('b', 'Re: Lost', 2, ['gone']);
  const c = m('c', 'Re: Lost', 3, ['gone']);
  const both = buildThreads([b, c]);
  assert.equal(both.length, 1);
  assert.equal(both[0]!.root.message, null, 'the missing message is kept as a placeholder');
  assert.equal(both[0]!.root.messageId, '<gone@x.example>');
  assert.deepEqual(both[0]!.root.children.map((x) => x.message?.id), ['b', 'c']);
  assert.equal(both[0]!.count, 2, 'a placeholder is not counted');
  const one = buildThreads([b]);
  assert.equal(one[0]!.root.message?.id, 'b', 'a single orphan is just the root');
  assert.deepEqual(flatten(both[0]!).map((x) => [x.depth, x.node.message?.id ?? null]), [[0, null], [1, 'b'], [1, 'c']]);
});

test('reference loops and self-references cannot hang or lose messages', () => {
  const a = m('a', 'Loop', 1, ['b']);
  const b = m('b', 'Re: Loop', 2, ['a']);
  const self = m('s', 'Self', 3, ['s']);
  const t = buildThreads([a, b, self]);
  assert.equal(t.reduce((n, x) => n + x.count, 0), 3);
  const flat = t.flatMap((x) => flatten(x)).map((x) => x.node.message?.id).filter(Boolean).sort();
  assert.deepEqual(flat, ['a', 'b', 's']);
});

test('a duplicate Message-ID does not overwrite the first message; a message without an id still threads by what it references', () => {
  const a = m('a', 'Dup', 1);
  const a2 = { ...m('a2', 'Dup', 5), messageId: '<a@x.example>' };
  const noId: Message = { id: 'n', subject: 'Re: Dup', date: 6, references: ['<a@x.example>'] };
  const t = buildThreads([a, a2, noId], { bySubject: false });
  const flat = t.flatMap(flatten).map((x) => x.node.message?.id);
  assert.ok(flat.includes('a') && flat.includes('a2') && flat.includes('n'));
  const first = t.find((x) => x.root.message?.id === 'a')!;
  assert.deepEqual(first.root.children.map((x) => x.message?.id), ['n']);
});

test('roots with the same base subject join when one is a reply; two originals or unrelated subjects do not', () => {
  const orig = m('o', 'Budget 2025', 1);
  const reply = m('r', 'Re: Budget 2025', 2, [], { messageId: '<r@x.example>' });
  const joined = buildThreads([reply, orig]);
  assert.equal(joined.length, 1);
  assert.deepEqual(ids(joined[0]!.root), ['o', ['r']]);
  assert.equal(buildThreads([reply, orig], { bySubject: false }).length, 2);
  assert.equal(buildThreads([m('o1', 'Same', 1), m('o2', 'Same', 2)]).length, 2, 'two originals stay apart');
  assert.equal(buildThreads([m('p', 'Alpha', 1), m('q', 'Re: Beta', 2)]).length, 2);
  const orphans = buildThreads([m('r1', 'Re: Orphan', 1), m('r2', 'Re: Orphan', 2)]);
  assert.equal(orphans.length, 1, 'two replies to something we never saw are grouped');
  assert.equal(orphans[0]!.root.message, null);
  assert.equal(orphans[0]!.count, 2);
  const twoGaps = buildThreads([m('b', 'Re: X', 1, ['g1']), m('c', 'Re: X', 2, ['g1']), m('d', 'Re: X', 3, ['g2']), m('e', 'Re: X', 4, ['g2'])]);
  assert.equal(twoGaps.length, 1, 'two placeholder threads on one subject become one');
  assert.equal(twoGaps[0]!.count, 4);
  assert.deepEqual(flatten(twoGaps[0]!).map((x) => x.node.message?.id ?? null), [null, 'b', 'c', 'd', 'e'], 'no message appears twice');
});

test('threads and siblings are ordered by date, and thread facts are summarised', () => {
  const t = buildThreads([m('late', 'Zeta', 50), m('early', 'Alpha', 10), m('reply2', 'Re: Alpha', 30, ['early']), m('reply1', 'Re: Alpha', 20, ['early'])]);
  assert.deepEqual(t.map((x) => x.subject), ['Alpha', 'Zeta']);
  assert.deepEqual(t[0]!.root.children.map((x) => x.message?.id), ['reply1', 'reply2']);
  assert.deepEqual([t[0]!.count, t[0]!.first, t[0]!.last], [3, 10, 30]);
  assert.deepEqual(buildThreads([]), []);
});

test('a message built from raw headers carries its ids, decoded subject and date', () => {
  const raw = 'Message-ID: <abc@mail.example>\nIn-Reply-To: <prev@mail.example>\nReferences: <root@mail.example>\n <prev@mail.example>\nSubject: =?UTF-8?Q?Re=3A_caf=C3=A9?=\nDate: Tue, 14 May 2024 10:00:00 +0000\n\nbody';
  const msg = messageFromHeaders('db-1', raw);
  assert.deepEqual(msg, { id: 'db-1', messageId: '<abc@mail.example>', inReplyTo: ['<prev@mail.example>'], references: ['<root@mail.example>', '<prev@mail.example>'], subject: 'Re: café', date: Date.UTC(2024, 4, 14, 10) });
  assert.equal(messageFromHeaders('x', 'Subject: s', 77).date, 77);
});

test('the index gives replies their conversation, keeps ids stable, and reports merges', () => {
  const ix = new ThreadIndex();
  const a = ix.ingest(m('a', 'Order 1', 1));
  assert.deepEqual([a.isNew, a.via, a.threadId], [true, 'new', '<a@x.example>']);
  const b = ix.ingest(m('b', 'Re: Order 1', 2, ['a']));
  assert.deepEqual([b.isNew, b.via, b.threadId], [false, 'references', '<a@x.example>']);
  const c = ix.ingest(m('c', 'Re: Order 1', 3, [], { inReplyTo: ['<b@x.example>'] }));
  assert.deepEqual([c.via, c.threadId], ['in-reply-to', '<a@x.example>']);
  const other = ix.ingest(m('z', 'Order 2', 4));
  assert.equal(other.threadId, '<z@x.example>');
  const bridge = ix.ingest(m('y', 'Re: both', 5, ['c', 'z']));
  assert.equal(bridge.threadId, '<a@x.example>', 'the older thread survives');
  assert.deepEqual(bridge.merged, ['<z@x.example>']);
  assert.equal(ix.threadOf('<z@x.example>'), '<a@x.example>');
  assert.equal(ix.ingest(m('w', 'Re: Order 2', 6, ['z'])).threadId, '<a@x.example>', 'later replies to the merged thread follow it');
  assert.equal(ix.threadOf('<nope@x>'), undefined);
});

test('the index joins by subject only for replies without references, inside the window', () => {
  const day = 86_400_000;
  const ix = new ThreadIndex({ subjectWindowMs: 30 * day });
  ix.ingest(m('a', 'Invoice 7', 0));
  const near = ix.ingest(m('b', 'Re: Invoice 7', 2 * day, [], { messageId: '<b@x.example>' }));
  assert.deepEqual([near.via, near.threadId], ['subject', '<a@x.example>']);
  const far = ix.ingest(m('c', 'Re: Invoice 7', 90 * day));
  assert.deepEqual([far.via, far.isNew], ['new', true], 'too long after');
  const notReply = ix.ingest(m('d', 'Invoice 7', 3 * day));
  assert.equal(notReply.via, 'new', 'an original with the same subject starts its own thread');
  assert.throws(() => new ThreadIndex({ maxMessages: 0 }).ingest(m('1', 'a', 1)), /full/);
  const small = new ThreadIndex({ maxMessages: 1 });
  small.ingest(m('1', 'a', 1));
  assert.throws(() => small.ingest(m('2', 'b', 2)), /full/);
  assert.equal(small.size, 1, 'a refused message is not counted');
});

const H = (s: string) => parseHeaders(s);

test('machine mail is recognised: Auto-Submitted, reports, bounces, bulk, lists and vendor headers', () => {
  assert.equal(detectAuto(H('From: a@x.example\nSubject: hi')).auto, false);
  assert.equal(detectAuto(H('Auto-Submitted: no')).auto, false);
  const k = (raw: string) => detectAuto(H(raw)).kind;
  assert.equal(k('Auto-Submitted: auto-replied'), 'auto-replied');
  assert.equal(k('Auto-Submitted: auto-generated; owner-email="x@y"'), 'auto-generated');
  assert.equal(k('Auto-Submitted: auto-notified'), 'auto-notified');
  assert.equal(k('Auto-Submitted: something-new'), 'auto-generated');
  assert.equal(k('Return-Path: <>'), 'bounce');
  assert.equal(k('From: Mail Delivery <MAILER-DAEMON@mx.example>'), 'bounce');
  assert.equal(k('Content-Type: multipart/report; report-type=delivery-status; boundary=x'), 'delivery-report');
  assert.equal(k('Precedence: bulk'), 'bulk');
  assert.equal(k('Precedence: list'), 'list');
  assert.equal(k('List-Id: <news.example.com>'), 'list');
  assert.equal(k('List-Unsubscribe: <mailto:u@x>'), 'list');
  assert.equal(k('X-Autoreply: yes'), 'vendor-autoreply');
  assert.equal(k('X-Failed-Recipients: a@b.example'), 'bounce');
  const many = detectAuto(H('Auto-Submitted: auto-replied\nPrecedence: bulk\nReturn-Path: <>'));
  assert.equal(many.reasons.length, 3);
  assert.equal(many.kind, 'auto-replied', 'the first and strongest sign names the kind');
  assert.equal(addressOf('Ana <ANA@Example.com>'), 'ana@example.com');
  assert.equal(addressOf(undefined), '');
});

const ctx = { ourAddresses: ['support@us.example'], now: 1_000_000_000, lastReplyTo: new Map<string, number>() };

test('an automatic reply is sent only to a person, not to ourselves, not to systems, not twice in a day', () => {
  const person = H('From: Ana <ana@customer.example>\nSubject: help\nReceived: a');
  assert.deepEqual(mayAutoReply(person, ctx).send, true);
  const no = (raw: string, re: RegExp, c = ctx) => { const d = mayAutoReply(H(raw), c); assert.equal(d.send, false, raw); assert.match(d.reason, re, raw); };
  no('From: x@y.example\nAuto-Submitted: auto-replied', /automatic \(auto-replied\)/);
  no('From: x@y.example\nPrecedence: bulk', /automatic \(bulk\)/);
  no('From: Us <support@us.example>', /our own addresses/);
  no('From: x@y.example\nReturn-Path: <support@us.example>', /our own addresses/);
  no('From: noreply@bank.example', /no-reply or system/);
  no('From: Do Not Reply <do-not-reply@shop.example>', /no-reply or system/);
  no('From: <>', /no usable sender/);
  no('Subject: nobody', /no usable sender/);
  no(`From: ana@customer.example\n${'Received: hop\n'.repeat(26)}`, /26 hops/);
  no('From: ana@customer.example\nX-Loop: support@us.example', /X-Loop/);
  no('From: ana@customer.example', /already auto-replied/, { ...ctx, lastReplyTo: new Map([['ana@customer.example', ctx.now - 3_600_000]]) });
  assert.equal(mayAutoReply(H('From: ana@customer.example'), { ...ctx, lastReplyTo: new Map([['ana@customer.example', ctx.now - 25 * 3_600_000]]) }).send, true, 'the window has passed');
  assert.equal(mayAutoReply(H('From: ana@customer.example'), { ...ctx, lastReplyTo: { 'ana@customer.example': ctx.now - 1000 } }).send, false, 'a plain object works too');
  assert.equal(mayAutoReply(H('From: ana@customer.example\nReceived: a'), { ...ctx, maxHops: 0 }).send, false);
});

test('reply headers: In-Reply-To, References kept in order and trimmed, a single Re:, and the markers that stop other robots', () => {
  const parent = m('p', 'Re: Re: Status', 9, ['r1', 'r2'], { messageId: '<p@x.example>' });
  assert.deepEqual(replyReferences(parent), ['<r1@x.example>', '<r2@x.example>', '<p@x.example>']);
  const long = m('l', 'x', 1, Array.from({ length: 30 }, (_, i) => `r${i}`), { messageId: '<l@x.example>' });
  const refs = replyReferences(long, 5);
  assert.deepEqual(refs, ['<r0@x.example>', '<r27@x.example>', '<r28@x.example>', '<r29@x.example>', '<l@x.example>'], 'the first id and the newest ones');
  assert.deepEqual(replyReferences({ id: 'i', subject: 's', date: 1, inReplyTo: ['<q@x>'], messageId: '<i@x>' }), ['<q@x>', '<i@x>'], 'In-Reply-To stands in for a missing References');
  assert.equal(replySubject('RE: Fwd: Status'), 'Re: Status');
  assert.equal(replySubject(''), 'Re: (no subject)');
  const hs = autoReplyHeaders(parent, '<new@us.example>');
  const get = (n: string) => hs.find((h) => h.name === n)?.value;
  assert.equal(get('Auto-Submitted'), 'auto-replied');
  assert.equal(get('Precedence'), 'bulk');
  assert.equal(get('X-Auto-Response-Suppress'), 'All');
  assert.equal(get('In-Reply-To'), '<p@x.example>');
  assert.equal(get('References'), '<r1@x.example> <r2@x.example> <p@x.example>');
  assert.equal(get('Subject'), 'Re: Status');
  assert.equal(detectAuto(hs).kind, 'auto-replied', 'our own automatic mail is recognised as automatic by us and by anyone else');
});
