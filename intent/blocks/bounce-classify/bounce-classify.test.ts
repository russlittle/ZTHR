import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Notify } from '../notify/index.ts';
import { NotAReport, SoftBounceTracker, classifyMessage, classifyRecipient, feedSuppression, isAutoReply, parseMime, parseStatus, statusFromReply } from './index.ts';

const dsn = (fields: string, extra = '') => [
  'From: MAILER-DAEMON@mx.example.org',
  'To: sender@example.com',
  'Subject: Undelivered Mail Returned to Sender',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="BND"',
  '',
  '--BND',
  'Content-Type: text/plain',
  '',
  'This is the mail system. Delivery failed.',
  '--BND',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mx.example.org',
  'Arrival-Date: Mon, 3 Mar 2025 10:00:00 +0000',
  '',
  fields,
  extra,
  '--BND',
  'Content-Type: text/rfc822-headers',
  '',
  'From: sender@example.com',
  'To: ana@example.net',
  '--BND--',
  '',
].join('\r\n');

test('RFC 3463 status codes parse into class, subject and detail', () => {
  const s = parseStatus('5.1.1');
  assert.deepEqual([s.cls, s.subject, s.detail, s.text], [5, 1, 1, 'the mailbox does not exist']);
  assert.equal(parseStatus('4.2.2').text, 'the mailbox is full');
  assert.match(parseStatus('5.4.9').text, /network and routing/);
  assert.equal(parseStatus('2.0.0').cls, 2);
});

test('malformed or out-of-range status codes are refused', () => {
  for (const bad of ['3.1.1', '5.1', '5.1.1.1', 'five', '', '5.1.1; DROP', '5.1.1234', '6.0.0']) assert.throws(() => parseStatus(bad), NotAReport, bad);
});

test('plain SMTP replies map to an enhanced code only where RFC 5321 defines it', () => {
  assert.equal(statusFromReply(550), '5.1.1');
  assert.equal(statusFromReply(452), '4.2.2');
  assert.equal(statusFromReply(999), undefined);
});

test('a hard bounce from an RFC 3464 report is read per recipient', () => {
  const c = classifyMessage(dsn(['Final-Recipient: rfc822; Ana@Example.NET', 'Original-Recipient: rfc822;ana@example.net', 'Action: failed', 'Status: 5.1.1', 'Remote-MTA: dns; mx.example.net', 'Diagnostic-Code: smtp; 550 5.1.1 <ana@example.net>: Recipient address rejected: User unknown'].join('\r\n')));
  assert.equal(c.kind, 'bounce');
  if (c.kind !== 'bounce') return;
  assert.equal(c.reportingMta, 'mx.example.org');
  assert.equal(c.recipients.length, 1);
  const r = c.recipients[0]!;
  assert.equal(r.address, 'ana@example.net');
  assert.equal(r.class, 'hard');
  assert.equal(r.status?.text, 'the mailbox does not exist');
  assert.match(r.diagnostic!, /^550 5\.1\.1 <ana@example\.net>/);
});

test('one report with several recipients is classed one by one', () => {
  const f = ['Final-Recipient: rfc822; a@example.net', 'Action: failed', 'Status: 5.1.1', '', 'Final-Recipient: rfc822; b@example.net', 'Action: failed', 'Status: 4.2.2', '', 'Final-Recipient: rfc822; c@example.net', 'Action: delivered', 'Status: 2.0.0'].join('\r\n');
  const c = classifyMessage(dsn(f));
  assert.equal(c.kind, 'bounce');
  if (c.kind !== 'bounce') return;
  assert.deepEqual(c.recipients.map((r) => [r.address, r.class]), [['a@example.net', 'hard'], ['b@example.net', 'soft'], ['c@example.net', 'delivered']]);
});

test('a full mailbox, a too-big message and a policy block are soft even when permanent', () => {
  assert.equal(classifyRecipient('failed', parseStatus('5.2.2'), undefined).class, 'soft');
  assert.equal(classifyRecipient('failed', parseStatus('5.3.4'), undefined).class, 'soft');
  assert.equal(classifyRecipient('failed', parseStatus('5.7.1'), 'blocked by policy').class, 'soft');
  assert.equal(classifyRecipient('failed', undefined, '552 Mailbox is full').class, 'soft');
  assert.equal(classifyRecipient('delayed', undefined, undefined).class, 'soft');
  assert.equal(classifyRecipient('failed', parseStatus('4.4.1'), undefined).class, 'soft');
});

test('without a status, the diagnostic text and the plain reply code decide', () => {
  const c = classifyMessage(dsn(['Final-Recipient: rfc822; a@example.net', 'Action: failed', 'Diagnostic-Code: smtp; 550 No such user here'].join('\r\n')));
  assert.equal(c.kind, 'bounce');
  if (c.kind !== 'bounce') return;
  assert.equal(c.recipients[0]!.class, 'hard');
  assert.equal(c.recipients[0]!.status?.cls, 5);
  assert.equal(classifyRecipient('failed', undefined, 'we do not know why').class, 'hard');
  assert.equal(classifyRecipient('', undefined, undefined).class, 'unknown');
});

test('a message with a bad address in Final-Recipient is not trusted to name anyone', () => {
  const f = ['Final-Recipient: rfc822; <x@y.z>, victim@example.org', 'Action: failed', 'Status: 5.1.1', '', 'Final-Recipient: rfc822; ok@example.net', 'Action: failed', 'Status: 5.1.1'].join('\r\n');
  const c = classifyMessage(dsn(f));
  assert.equal(c.kind, 'bounce');
  if (c.kind !== 'bounce') return;
  assert.deepEqual(c.recipients.map((r) => r.address), ['ok@example.net']);
});

test('a delivery report that names no recipient is refused', () => {
  assert.throws(() => classifyMessage(dsn('Action: failed')), /names no recipient/);
});

const arf = (type: string, extra = '') => [
  'From: <feedback@isp.example>',
  'Subject: FW: Earn money',
  'Content-Type: multipart/report; report-type=feedback-report; boundary="FB"',
  '',
  '--FB',
  'Content-Type: text/plain',
  '',
  'This is an email abuse report.',
  '--FB',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: ' + type,
  'User-Agent: SomeISP/1.0',
  'Version: 1',
  'Source-IP: 192.0.2.1',
  extra,
  '',
  '--FB',
  'Content-Type: message/rfc822',
  '',
  'From: news@example.com',
  'To: <Reader@Example.Net>',
  'Subject: Earn money',
  '',
  'body',
  '--FB--',
  '',
].join('\r\n');

test('an RFC 5965 abuse report is a complaint, with the recipient taken from the original message', () => {
  const c = classifyMessage(arf('abuse'));
  assert.equal(c.kind, 'complaint');
  if (c.kind !== 'complaint') return;
  assert.equal(c.address, 'reader@example.net');
  assert.equal(c.complaint.feedbackType, 'abuse');
  assert.equal(c.complaint.sourceIp, '192.0.2.1');
  assert.equal(c.complaint.userAgent, 'SomeISP/1.0');
});

test('Original-Rcpt-To wins over the copy of the message, and opt-out (RFC 6650) counts as a complaint', () => {
  const c = classifyMessage(arf('opt-out', 'Original-Rcpt-To: <other@example.org>'));
  assert.equal(c.kind, 'complaint');
  if (c.kind !== 'complaint') return;
  assert.equal(c.address, 'other@example.org');
  assert.equal(c.complaint.feedbackType, 'opt-out');
});

test('"not-spam" feedback is not a complaint, and a report with no Feedback-Type is refused', () => {
  assert.deepEqual(classifyMessage(arf('not-spam')), { kind: 'other' });
  assert.throws(() => classifyMessage(arf('abuse').replace('Feedback-Type: abuse', 'X-Other: 1')), /no Feedback-Type/);
});

test('automatic replies are recognised by header and subject and are never bounces', () => {
  const ooo = ['From: ana@example.net', 'To: news@example.com', 'Subject: Out of Office: back Monday', 'Auto-Submitted: auto-replied', '', 'I am away.'].join('\r\n');
  const c = classifyMessage(ooo);
  assert.deepEqual(c, { kind: 'auto-reply', why: 'Auto-Submitted: auto-replied' });
  assert.equal(isAutoReply(new Map([['auto-submitted', 'no']])), false);
  assert.equal(isAutoReply(new Map([['x-autoreply', 'yes']])), true);
  assert.equal(isAutoReply(new Map([['subject', 'Automatic reply: hello']])), true);
  assert.equal(isAutoReply(new Map([['subject', 'Re: lunch']])), false);
  assert.deepEqual(classifyMessage('From: a@b.c\r\nSubject: hi\r\n\r\nhello'), { kind: 'other' });
});

test('hostile input: no boundary, too deep, too many parts, too large', () => {
  assert.throws(() => parseMime('Content-Type: multipart/report\r\n\r\nx'), /no boundary/);
  const nest = (n: number): string => (n === 0 ? 'Content-Type: text/plain\r\n\r\nx' : `Content-Type: multipart/mixed; boundary="b${n}"\r\n\r\n--b${n}\r\n${nest(n - 1)}\r\n--b${n}--\r\n`);
  assert.throws(() => parseMime(nest(10)), /nested too deeply/);
  const many = `Content-Type: multipart/mixed; boundary="b"\r\n\r\n` + Array.from({ length: 80 }, () => '--b\r\nContent-Type: text/plain\r\n\r\nx\r\n').join('') + '--b--\r\n';
  assert.throws(() => parseMime(many), /too many parts/);
  assert.throws(() => parseMime('x'.repeat(5_000_001)), /larger than 5 MB/);
  assert.equal(parseMime(nest(3)).parts.length, 1);
});

test('folded headers are unfolded and parameters read', () => {
  const p = parseMime('Subject: a\r\n b\r\n\tc\r\nContent-Type: text/plain;\r\n charset="utf-8"\r\n\r\nbody');
  assert.equal(p.headers.get('subject'), 'a b c');
  assert.equal(p.body, 'body');
});

test('feeding suppression: hard bounces and complaints reach the notify block and stop mail', async () => {
  const sent: string[] = [];
  const n = new Notify({ send: async (_c: unknown, to: string) => void sent.push(to) } as never);
  const c = classifyMessage(dsn(['Final-Recipient: rfc822; gone@example.net', 'Action: failed', 'Status: 5.1.1'].join('\r\n')));
  assert.deepEqual(feedSuppression(n, c), ['gone@example.net']);
  const r = await n.notify('p1', 'gone@example.net', { key: 't', category: 'c', subject: 's', body: 'b' }, {});
  assert.equal(r[0]!.outcome, 'suppressed');
  const comp = classifyMessage(arf('abuse'));
  assert.deepEqual(feedSuppression(n, comp), ['reader@example.net']);
  const r2 = await n.notify('p2', 'Reader@example.net', { key: 't', category: 'c', subject: 's', body: 'b' }, {});
  assert.equal(r2[0]!.outcome, 'suppressed');
});

test('soft bounces repeat into a hard one inside the window, and a delivery clears the count', () => {
  const calls: [string, string][] = [];
  const t = { now: 0 };
  const tracker = new SoftBounceTracker({ threshold: 3, windowMs: 1000, now: () => t.now });
  const target = { bounce: (a: string, k: 'hard' | 'soft' | 'complaint') => void calls.push([a, k]) };
  const soft = classifyMessage(dsn(['Final-Recipient: rfc822; full@example.net', 'Action: failed', 'Status: 4.2.2'].join('\r\n')));
  assert.deepEqual(feedSuppression(target, soft, tracker), []);
  t.now = 500;
  assert.deepEqual(feedSuppression(target, soft, tracker), []);
  t.now = 900;
  assert.deepEqual(feedSuppression(target, soft, tracker), ['full@example.net']);
  assert.deepEqual(calls.map((x) => x[1]), ['soft', 'soft', 'hard']);
  t.now = 5000;
  assert.deepEqual(feedSuppression(target, soft, tracker), [], 'old ones fell out of the window');
});
