import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadCommand, ClientSession, ProtocolError, ReplyParser, ServerSession, classify, endsGroup, formatReply, parseCommand, parsePath, parsePlain, parseXoauth2, pipelineGroups, plainInitial, prepareBody, xoauth2Initial, type ClientOptions, type ClientResult, type Envelope, type ServerOptions } from './index.ts';

const mkServer = (o: Partial<ServerOptions> = {}) => {
  const got: { env: Envelope; body: string }[] = [];
  const s = new ServerSession({ hostname: 'mx.example.org', onMessage: (env, body) => void got.push({ env, body: body.toString('latin1') }), ...o });
  return { s, got };
};
const talk = (s: ServerSession, ...lines: string[]) => s.feed(lines.join(''));
const replies = (text: string) => new ReplyParser().push(text);
const codes = (text: string) => replies(text).map((r) => r.code);

/** Runs a client against a server in memory, answering STARTTLS when asked. */
function run(server: ServerSession, opts: ClientOptions) {
  const client = new ClientSession(opts);
  const parser = new ReplyParser();
  const wire: string[] = [];
  let inbox = server.greeting();
  let result: ClientResult | undefined;
  for (let guard = 0; guard < 200 && !result; guard++) {
    wire.push(`S: ${inbox}`);
    let outgoing = '';
    let tls = false;
    for (const r of parser.push(inbox)) {
      const step = client.receive(r);
      outgoing += step.send;
      if (step.startTls) tls = true;
      if (step.done) result = step.done;
    }
    if (result) break;
    if (tls) {
      server.tlsStarted();
      const step = client.tlsStarted();
      outgoing = step.send;
    }
    wire.push(`C: ${outgoing}`);
    const out = server.feed(outgoing);
    inbox = out.write;
    if (out.close && !inbox) break;
  }
  return { result, wire };
}

test('replies are written with hyphens until the last line, and refuse injection', () => {
  assert.equal(formatReply(250, ['mx greets you', 'PIPELINING', 'SIZE 100']), '250-mx greets you\r\n250-PIPELINING\r\n250 SIZE 100\r\n');
  assert.equal(formatReply(550, 'no such user', '5.1.1'), '550 5.1.1 no such user\r\n');
  assert.throws(() => formatReply(250, ['ok\r\n500 injected']), /line breaks/);
  assert.throws(() => formatReply(99, 'x'), ProtocolError);
  assert.throws(() => formatReply(250, 'x', 'bad'), /enhanced/);
  assert.deepEqual([200, 354, 450, 550].map(classify), ['positive', 'intermediate', 'transient', 'permanent']);
});

test('the reply parser reads multi-line replies cut at any byte and pulls out enhanced codes', () => {
  const text = '250-mx.example.org hello\r\n250-SIZE 35882577\r\n250 8BITMIME\r\n550 5.7.1 Relay denied\r\n';
  for (let cut = 1; cut < text.length; cut += 7) {
    const p = new ReplyParser();
    const out = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))];
    assert.equal(out.length, 2, `cut at ${cut}`);
    assert.deepEqual(out[0]!.lines, ['mx.example.org hello', 'SIZE 35882577', '8BITMIME']);
    assert.deepEqual([out[1]!.code, out[1]!.enhanced, out[1]!.lines], [550, '5.7.1', ['Relay denied']]);
  }
  assert.deepEqual(replies('354\r\n'), [{ code: 354, lines: [''] }]);
});

test('malformed replies are refused', () => {
  assert.throws(() => replies('hello\r\n'), /not a reply line/);
  assert.throws(() => replies('250-a\r\n251 b\r\n'), /disagree on the code/);
  assert.throws(() => replies('1000 x\r\n'), ProtocolError);
  assert.throws(() => new ReplyParser().push('250 ' + 'x'.repeat(1100)), /longer than 1000/);
  assert.throws(() => new ReplyParser(3).push('250-a\r\n250-b\r\n250-c\r\n250-d\r\n'), /too many lines/);
});

test('paths: null sender, quoted local parts, literals, obsolete routes and limits', () => {
  assert.equal(parsePath('<>', { allowNull: true }), null);
  assert.throws(() => parsePath('<>'), /only as the sender/);
  assert.deepEqual(parsePath('<ana@example.org>'), { local: 'ana', domain: 'example.org', address: 'ana@example.org' });
  assert.equal(parsePath('<"a b"@example.org>')!.local, '"a b"');
  assert.equal(parsePath('<"a\\"b@c"@example.org>')!.domain, 'example.org');
  assert.equal(parsePath('<@relay1,@relay2:ana@example.org>')!.address, 'ana@example.org', 'the route is dropped');
  assert.equal(parsePath('<ana@[192.0.2.1]>')!.domain, '[192.0.2.1]');
  assert.equal(parsePath('<ana@[IPv6:2001:db8::1]>')!.domain, '[IPv6:2001:db8::1]');
  for (const bad of ['ana@example.org', '<ana>', '<@example.org>', '<ana@>', '<ana@-bad.org>', '<a b@example.org>', '<ana@exa mple.org>', '<ana@example..org>', '<ana@[999]>', '<a..b@example.org>', '<ana@example.org\x00>', `<${'a'.repeat(65)}@example.org>`, `<a@${'b'.repeat(64)}.org>`, `<a@${'b'.repeat(250)}.org>`, '<ana@example.org>>', '<<ana@example.org>']) assert.throws(() => parsePath(bad), ProtocolError, bad);
  assert.throws(() => parsePath('<josé@example.org>'), /needs SMTPUTF8/);
  assert.equal(parsePath('<josé@example.org>', { utf8: true })!.local, 'josé');
});

test('commands parse with parameters, and bad ones say which reply to give', () => {
  assert.deepEqual(parseCommand('EHLO client.example.org'), { verb: 'EHLO', domain: 'client.example.org' });
  assert.deepEqual(parseCommand('ehlo [192.0.2.7]'), { verb: 'EHLO', domain: '[192.0.2.7]' });
  const m = parseCommand('MAIL FROM:<a@example.org> SIZE=1000 BODY=8BITMIME SMTPUTF8');
  assert.deepEqual(m.verb === 'MAIL' && m.params, { SIZE: '1000', BODY: '8BITMIME', SMTPUTF8: '' });
  assert.equal(parseCommand('MAIL FROM:<>').verb === 'MAIL' && (parseCommand('MAIL FROM:<>') as { from: unknown }).from, null);
  assert.equal(parseCommand('RCPT TO: <b@example.org>').verb, 'RCPT', 'a space after the colon is tolerated');
  assert.deepEqual(parseCommand('AUTH plain AGEAYg=='), { verb: 'AUTH', mechanism: 'PLAIN', initial: 'AGEAYg==' });
  assert.equal(parseCommand('quit').verb, 'QUIT');
  const code = (l: string) => {
    try {
      parseCommand(l);
    } catch (e) {
      return e instanceof BadCommand ? e.code : -1;
    }
    return 0;
  };
  assert.equal(code('FROB'), 500);
  assert.equal(code('FROBNICATE x'), 500);
  assert.equal(code('QUIT now'), 501);
  assert.equal(code('EHLO'), 501);
  assert.equal(code('EHLO a b'), 501);
  assert.equal(code('MAIL FROM:ana@example.org'), 501);
  assert.equal(code('MAIL TO:<a@example.org>'), 501);
  assert.equal(code('RCPT TO:<>'), 501);
  assert.equal(code('MAIL FROM:<a@example.org> SIZE=1 SIZE=2'), 501);
  assert.equal(code('MAIL FROM:<a@example.org> bad!param'), 501);
  assert.equal(code('NOOP\x00'), 501);
  assert.equal(code('EHLO ' + 'a'.repeat(600)), 500);
});

test('a server runs a whole transaction and removes the dot-stuffing', () => {
  const { s, got } = mkServer();
  assert.equal(s.greeting(), '220 mx.example.org ESMTP ready\r\n');
  const hello = s.feed('EHLO client.example.org\r\n').write;
  assert.deepEqual(replies(hello)[0]!.lines.slice(1), ['PIPELINING', 'SIZE 10485760', '8BITMIME', 'SMTPUTF8', 'ENHANCEDSTATUSCODES']);
  assert.deepEqual(codes(talk(s, 'MAIL FROM:<a@example.org> SIZE=50\r\n', 'RCPT TO:<b@example.org>\r\n', 'RCPT TO:<c@example.org>\r\n', 'DATA\r\n').write), [250, 250, 250, 354]);
  assert.deepEqual(codes(s.feed('Subject: hi\r\n\r\n..leading dot\r\nmiddle\r\n.\r\n').write), [250]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.body, 'Subject: hi\r\n\r\n.leading dot\r\nmiddle\r\n');
  assert.deepEqual([got[0]!.env.from, got[0]!.env.to, got[0]!.env.client, got[0]!.env.size, got[0]!.env.tls], ['a@example.org', ['b@example.org', 'c@example.org'], 'client.example.org', 50, false]);
  assert.deepEqual(codes(s.feed('QUIT\r\n').write), [221]);
});

test('message data may arrive in any pieces, and an empty message is allowed', () => {
  const { s, got } = mkServer();
  s.greeting();
  talk(s, 'EHLO c.example.org\r\n', 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n');
  let out = '';
  for (const ch of `line one\r\nline two\r\n.\r\n`) out += s.feed(ch).write;
  assert.deepEqual(codes(out), [250]);
  assert.equal(got[0]!.body, 'line one\r\nline two\r\n');
  talk(s, 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n');
  assert.deepEqual(codes(s.feed('.\r\n').write), [250]);
  assert.equal(got[1]!.body, '', 'a message of nothing but the end marker is empty');
  talk(s, 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n');
  assert.deepEqual(codes(s.feed('\r\n.\r\n').write), [250]);
  assert.equal(got[2]!.body, '\r\n', 'a blank first line is kept');
});

test('commands out of order are refused with 503 and nothing is half-done', () => {
  const { s } = mkServer();
  s.greeting();
  assert.deepEqual(codes(s.feed('MAIL FROM:<a@example.org>\r\n').write), [503]);
  talk(s, 'EHLO c.example.org\r\n');
  assert.deepEqual(codes(s.feed('RCPT TO:<b@example.org>\r\n').write), [503]);
  assert.deepEqual(codes(s.feed('DATA\r\n').write), [503]);
  s.feed('MAIL FROM:<a@example.org>\r\n');
  assert.deepEqual(codes(s.feed('MAIL FROM:<a@example.org>\r\n').write), [503], 'a second MAIL inside a transaction');
  assert.deepEqual(codes(s.feed('DATA\r\n').write), [554], 'no recipients');
  s.feed('RCPT TO:<b@example.org>\r\n');
  assert.deepEqual(codes(s.feed('RSET\r\n').write), [250]);
  assert.deepEqual(codes(s.feed('DATA\r\n').write), [503], 'RSET forgot the sender and recipients');
});

test('size limits: refused at MAIL by the declared size, and at the end by the real size', () => {
  const { s, got } = mkServer({ maxSize: 100 });
  s.greeting();
  s.feed('EHLO c.example.org\r\n');
  const r = replies(s.feed('MAIL FROM:<a@example.org> SIZE=101\r\n').write)[0]!;
  assert.deepEqual([r.code, r.enhanced], [552, '5.3.4']);
  talk(s, 'MAIL FROM:<a@example.org> SIZE=10\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n');
  // The declared size lied: the real message is far bigger, and it is not kept.
  let out = s.feed('x'.repeat(60) + '\r\n').write;
  out += s.feed('y'.repeat(60) + '\r\n.\r\n').write;
  assert.deepEqual(codes(out), [552]);
  assert.equal(got.length, 0);
  assert.deepEqual(codes(talk(s, 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n', 'ok\r\n.\r\n').write), [250, 250, 354, 250], 'the session carries on');
  assert.equal(got.length, 1);
  assert.deepEqual(codes(s.feed('MAIL FROM:<a@example.org> SIZE=abc\r\n').write), [501]);
});

test('SMTP smuggling: a bare line feed in the data is refused, and what follows is never run as commands', () => {
  const { s, got } = mkServer();
  s.greeting();
  talk(s, 'EHLO c.example.org\r\n', 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n');
  const out = s.feed('innocent\n.\r\nMAIL FROM:<boss@example.org>\r\nRCPT TO:<victim@example.org>\r\nDATA\r\nforged\r\n.\r\n').write;
  assert.deepEqual(codes(out), [554]);
  assert.equal(got.length, 0, 'nothing was delivered, forged or otherwise');
  const lenient = mkServer({ allowBareNewlines: true });
  lenient.s.greeting();
  talk(lenient.s, 'EHLO c.example.org\r\n', 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n');
  assert.deepEqual(codes(lenient.s.feed('a\nb\r\n.\r\n').write), [250], 'unless the operator allows it');
  talk(s, 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'DATA\r\n');
  assert.deepEqual(codes(s.feed('cr\rhere\r\n.\r\n').write), [554], 'a bare carriage return too');
});

test('pipelined commands in one packet are answered in order', () => {
  const { s, got } = mkServer();
  s.greeting();
  s.feed('EHLO c.example.org\r\n');
  const out = s.feed('MAIL FROM:<a@example.org>\r\nRCPT TO:<b@example.org>\r\nRCPT TO:<bad address>\r\nRCPT TO:<c@example.org>\r\nDATA\r\nbody\r\n.\r\nQUIT\r\n');
  assert.deepEqual(codes(out.write), [250, 250, 501, 250, 354, 250, 221]);
  assert.equal(out.close, true);
  assert.deepEqual(got[0]!.env.to, ['b@example.org', 'c@example.org']);
  assert.equal(s.feed('NOOP\r\n').close, true, 'nothing is read after the session closes');
});

test('STARTTLS: offered once, upgrades, forgets the hello, and commands pushed behind it are refused', () => {
  const { s } = mkServer({ tls: true, auth: { mechanisms: ['PLAIN'], verify: () => true } });
  s.greeting();
  const before = replies(s.feed('EHLO c.example.org\r\n').write)[0]!.lines;
  assert.ok(before.includes('STARTTLS'));
  assert.ok(!before.some((l) => l.startsWith('AUTH')), 'AUTH is not offered in the clear');
  const st = s.feed('STARTTLS\r\n');
  assert.deepEqual([codes(st.write), st.startTls], [[220], true]);
  s.tlsStarted();
  assert.deepEqual(codes(s.feed('MAIL FROM:<a@example.org>\r\n').write), [503], 'a new EHLO is needed after TLS');
  const after = replies(s.feed('EHLO c.example.org\r\n').write)[0]!.lines;
  assert.ok(!after.includes('STARTTLS'));
  assert.ok(after.includes('AUTH PLAIN'));
  assert.deepEqual(codes(s.feed('STARTTLS\r\n').write), [503]);

  const t2 = mkServer({ tls: true });
  t2.s.greeting();
  t2.s.feed('EHLO c.example.org\r\n');
  const inj = t2.s.feed('STARTTLS\r\nMAIL FROM:<evil@example.org>\r\n');
  assert.deepEqual([codes(inj.write), inj.close, inj.startTls], [[554], true, false], 'plaintext after STARTTLS is never carried into the encrypted session');
  assert.deepEqual(codes(mkServer().s.feed('STARTTLS\r\n').write), [502]);
});

test('AUTH PLAIN, LOGIN and XOAUTH2 succeed with good credentials', () => {
  const verify = (m: string, u: string, secret: string) => (m === 'XOAUTH2' ? u === 'ana@example.org' && secret === 'ya29.token' : u === 'ana' && secret === 'pw');
  const mk = () => {
    const { s } = mkServer({ auth: { mechanisms: ['PLAIN', 'LOGIN', 'XOAUTH2'], verify, allowInsecure: true } });
    s.greeting();
    s.feed('EHLO c.example.org\r\n');
    return s;
  };
  let s = mk();
  assert.deepEqual(codes(s.feed(`AUTH PLAIN ${plainInitial('ana', 'pw')}\r\n`).write), [235]);
  assert.equal(s.authenticatedAs, 'ana');
  assert.deepEqual(codes(s.feed(`AUTH PLAIN ${plainInitial('ana', 'pw')}\r\n`).write), [503], 'once is enough');
  s = mk();
  assert.deepEqual(replies(s.feed('AUTH PLAIN\r\n').write)[0]!.code, 334);
  assert.deepEqual(codes(s.feed(`${plainInitial('ana', 'pw')}\r\n`).write), [235]);
  s = mk();
  const u = replies(s.feed('AUTH LOGIN\r\n').write)[0]!;
  assert.equal(Buffer.from(u.lines[0]!, 'base64').toString(), 'Username:');
  const p = replies(s.feed(`${Buffer.from('ana').toString('base64')}\r\n`).write)[0]!;
  assert.equal(Buffer.from(p.lines[0]!, 'base64').toString(), 'Password:');
  assert.deepEqual(codes(s.feed(`${Buffer.from('pw').toString('base64')}\r\n`).write), [235]);
  s = mk();
  assert.deepEqual(codes(s.feed(`AUTH XOAUTH2 ${xoauth2Initial('ana@example.org', 'ya29.token')}\r\n`).write), [235]);
  s = mk();
  assert.deepEqual(codes(s.feed(`AUTH PLAIN =\r\n`).write), [501], 'an empty PLAIN response is not a login');
});

test('failed AUTH: wrong password, bad base64, cancel, XOAUTH2 error round trip, lockout after repeated failures', () => {
  const mk = () => {
    const { s } = mkServer({ auth: { mechanisms: ['PLAIN', 'LOGIN', 'XOAUTH2'], verify: (m, u, p) => u === 'ana' && p === 'pw', allowInsecure: true } });
    s.greeting();
    s.feed('EHLO c.example.org\r\n');
    return s;
  };
  let s = mk();
  const f = replies(s.feed(`AUTH PLAIN ${plainInitial('ana', 'nope')}\r\n`).write)[0]!;
  assert.deepEqual([f.code, f.enhanced], [535, '5.7.8']);
  assert.equal(s.authenticatedAs, undefined);
  assert.deepEqual(codes(s.feed('AUTH PLAIN !!!notbase64\r\n').write), [501]);
  s.feed('AUTH PLAIN\r\n');
  assert.deepEqual(codes(s.feed('*\r\n').write), [501], 'cancelled');
  assert.deepEqual(codes(s.feed('AUTH CRAM-MD5\r\n').write), [504]);
  assert.deepEqual(codes(s.feed(`AUTH PLAIN ${plainInitial('ana', 'pw', 'root')}\r\n`).write), [535], 'acting as someone else is refused');
  s = mk();
  const x = replies(s.feed(`AUTH XOAUTH2 ${xoauth2Initial('ana', 'bad')}\r\n`).write)[0]!;
  assert.equal(x.code, 334);
  assert.deepEqual(JSON.parse(Buffer.from(x.lines[0]!, 'base64').toString()), { status: '401', schemes: 'Bearer', scope: 'mail' });
  assert.deepEqual(codes(s.feed('\r\n').write), [535]);
  s = mk();
  const out = [1, 2, 3].map(() => s.feed(`AUTH PLAIN ${plainInitial('ana', 'guess')}\r\n`));
  assert.deepEqual([out[0]!.close, out[1]!.close, out[2]!.close, codes(out[2]!.write)], [false, false, true, [421]]);
});

test('AUTH needs encryption by default; mail can require TLS or a login', () => {
  const { s } = mkServer({ tls: true, requireTls: true, auth: { mechanisms: ['PLAIN'], verify: () => true } });
  s.greeting();
  s.feed('EHLO c.example.org\r\n');
  const r = replies(s.feed(`AUTH PLAIN ${plainInitial('a', 'b')}\r\n`).write)[0]!;
  assert.deepEqual([r.code, r.enhanced], [538, '5.7.11']);
  const m = replies(s.feed('MAIL FROM:<a@example.org>\r\n').write)[0]!;
  assert.deepEqual([m.code, m.enhanced], [530, '5.7.0']);
  s.feed('STARTTLS\r\n');
  s.tlsStarted();
  s.feed('EHLO c.example.org\r\n');
  assert.deepEqual(codes(s.feed('MAIL FROM:<a@example.org>\r\n').write), [250]);
  const need = mkServer({ requireAuth: true });
  need.s.greeting();
  need.s.feed('EHLO c.example.org\r\n');
  assert.deepEqual(codes(need.s.feed('MAIL FROM:<a@example.org>\r\n').write), [530]);
});

test('hostile input: too many errors, overlong lines, NUL bytes and recipient floods', () => {
  const { s } = mkServer({ maxErrors: 3, maxRecipients: 2 });
  s.greeting();
  s.feed('EHLO c.example.org\r\n');
  assert.deepEqual(codes(talk(s, 'MAIL FROM:<a@example.org>\r\n', 'RCPT TO:<b@example.org>\r\n', 'RCPT TO:<c@example.org>\r\n', 'RCPT TO:<d@example.org>\r\n').write), [250, 250, 250, 452]);
  const out = s.feed('BOGUS\r\nBOGUS\r\nBOGUS\r\nBOGUS\r\nNOOP\r\n');
  assert.deepEqual([codes(out.write), out.close], [[500, 500, 421], true], 'it hangs up on a client that keeps sending nonsense');
  const t = mkServer();
  t.s.greeting();
  const long = t.s.feed('A'.repeat(5000));
  assert.deepEqual([codes(long.write), long.close], [[500], true]);
  const n = mkServer();
  n.s.greeting();
  assert.deepEqual(codes(n.s.feed('NOOP\x00x\r\n').write), [501]);
});

test('callbacks can refuse a sender, a recipient or a message with their own reply', () => {
  const { s, got } = mkServer({
    onSender: (f) => (f === 'spam@bad.example' ? { code: 550, text: 'sender blocked', enhanced: '5.7.1' } : undefined),
    onRecipient: (t) => (t.startsWith('nobody@') ? { code: 550, text: 'no such user', enhanced: '5.1.1' } : t.startsWith('full@') ? { code: 452, text: 'mailbox full', enhanced: '4.2.2' } : undefined),
    onMessage: (env, body) => (body.toString().includes('VIRUS') ? { code: 554, text: 'content rejected', enhanced: '5.7.1' } : undefined),
  });
  s.greeting();
  s.feed('EHLO c.example.org\r\n');
  const a = replies(s.feed('MAIL FROM:<spam@bad.example>\r\n').write)[0]!;
  assert.deepEqual([a.code, a.enhanced, a.lines], [550, '5.7.1', ['sender blocked']]);
  s.feed('MAIL FROM:<ok@example.org>\r\n');
  assert.deepEqual(replies(s.feed('RCPT TO:<nobody@example.org>\r\n').write)[0]!.enhanced, '5.1.1');
  assert.deepEqual(codes(s.feed('RCPT TO:<full@example.org>\r\n').write), [452]);
  assert.deepEqual(codes(talk(s, 'RCPT TO:<real@example.org>\r\n', 'DATA\r\n', 'a VIRUS\r\n.\r\n').write), [250, 354, 554]);
  void got;
});

test('the pipelining rules: which commands must end a group', () => {
  assert.deepEqual(['MAIL', 'RCPT', 'RSET'].map(endsGroup), [false, false, false]);
  assert.deepEqual(['EHLO', 'DATA', 'QUIT', 'NOOP', 'VRFY', 'STARTTLS', 'AUTH', 'ehlo'].map(endsGroup), [true, true, true, true, true, true, true, true]);
  const cmds = ['EHLO x', 'MAIL FROM:<a@b.c>', 'RCPT TO:<d@e.f>', 'RCPT TO:<g@h.i>', 'DATA', 'QUIT'];
  assert.deepEqual(pipelineGroups(cmds, true), [['EHLO x'], ['MAIL FROM:<a@b.c>', 'RCPT TO:<d@e.f>', 'RCPT TO:<g@h.i>', 'DATA'], ['QUIT']]);
  assert.deepEqual(pipelineGroups(cmds, false).length, 6);
  assert.deepEqual(pipelineGroups(['MAIL FROM:<a@b.c>', 'RCPT TO:<d@e.f>'], true), [['MAIL FROM:<a@b.c>', 'RCPT TO:<d@e.f>']]);
});

test('SASL strings: PLAIN and XOAUTH2 round trip, and damage is refused', () => {
  assert.deepEqual(parsePlain(plainInitial('ana', 'päss', 'zed')), { authzid: 'zed', user: 'ana', pass: 'päss' });
  assert.equal(plainInitial('tim', 'tanstaaftanstaaf'), Buffer.from('\0tim\0tanstaaftanstaaf').toString('base64'), 'RFC 4616 example');
  assert.deepEqual(parseXoauth2(xoauth2Initial('someuser@example.com', 'ya29.vF9')), { user: 'someuser@example.com', token: 'ya29.vF9' });
  assert.equal(xoauth2Initial('someuser@example.com', 'ya29.vF9'), Buffer.from('user=someuser@example.com\x01auth=Bearer ya29.vF9\x01\x01').toString('base64'));
  assert.throws(() => parsePlain(Buffer.from('only\0two').toString('base64')), /NUL/);
  assert.throws(() => parsePlain('@@@'), /base64/);
  assert.throws(() => parseXoauth2(Buffer.from('user=a').toString('base64')), /XOAUTH2/);
});

test('prepareBody: CRLF everywhere, dots protected, end marker added', () => {
  assert.equal(prepareBody('a\nb\r\n.c\n.\n').toString(), 'a\r\nb\r\n..c\r\n..\r\n.\r\n');
  assert.equal(prepareBody('no newline at end').toString(), 'no newline at end\r\n.\r\n');
  assert.equal(prepareBody('.start').toString(), '..start\r\n.\r\n');
  assert.equal(prepareBody('').toString(), '.\r\n');
  assert.deepEqual([...prepareBody(Buffer.from([0x68, 0xe9, 0x0a]))], [0x68, 0xe9, 0x0d, 0x0a, 0x2e, 0x0d, 0x0a], 'bytes above 127 pass through unchanged');
});

const MSG = { from: 'ana@example.org', to: ['ben@example.net', 'cy@example.net'], body: 'Subject: Hi\r\n\r\n.dot first\r\nBye\r\n' };

test('client and server together: STARTTLS, PLAIN login, pipelined send, and the message arrives intact', () => {
  const { s, got } = mkServer({ tls: true, auth: { mechanisms: ['PLAIN', 'LOGIN'], verify: (m, u, p) => u === 'ana' && p === 'pw' } });
  const { result, wire } = run(s, { ehlo: 'client.example.org', message: MSG, auth: { user: 'ana', pass: 'pw' } });
  assert.equal(result?.ok, true);
  assert.deepEqual(result!.ok && result.accepted, ['ben@example.net', 'cy@example.net']);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.body, MSG.body);
  assert.deepEqual([got[0]!.env.tls, got[0]!.env.authenticatedAs, got[0]!.env.from], [true, 'ana', 'ana@example.org']);
  const sent = wire.filter((w) => w.startsWith('C:')).join('');
  assert.match(sent, /MAIL FROM:<ana@example.org> SIZE=\d+\r\nRCPT TO:<ben@example.net>\r\nRCPT TO:<cy@example.net>\r\n/, 'MAIL and the RCPTs went in one packet');
  assert.ok(sent.indexOf('STARTTLS') < sent.indexOf('AUTH PLAIN'), 'the password is sent only after TLS');
});

test('client: without pipelining, with LOGIN, and with XOAUTH2 chosen when a token is given', () => {
  const verify = (m: string, u: string, p: string) => (m === 'XOAUTH2' ? p === 'tok' : p === 'pw');
  let a = mkServer({ tls: true, auth: { mechanisms: ['LOGIN'], verify } });
  let r = run(a.s, { ehlo: 'c.example.org', message: MSG, auth: { user: 'ana', pass: 'pw' }, pipelining: false });
  assert.equal(r.result?.ok, true);
  assert.equal(r.wire.filter((w) => w.startsWith('C:') && /MAIL FROM/.test(w) && /RCPT/.test(w)).length, 0, 'one command at a time');
  assert.equal(a.got.length, 1);
  a = mkServer({ tls: true, auth: { mechanisms: ['PLAIN', 'XOAUTH2'], verify } });
  r = run(a.s, { ehlo: 'c.example.org', message: MSG, auth: { user: 'ana', pass: 'pw', token: 'tok' } });
  assert.equal(r.result?.ok, true);
  assert.match(r.wire.join(''), /AUTH XOAUTH2 /);
});

test('client: a bad token ends in a failure after the error round trip; a bad password too', () => {
  const a = mkServer({ tls: true, auth: { mechanisms: ['XOAUTH2'], verify: () => false } });
  const r = run(a.s, { ehlo: 'c.example.org', message: MSG, auth: { user: 'ana', token: 'expired' } });
  assert.deepEqual(r.result, { ok: false, stage: 'auth', code: 535, text: 'authentication failed', temporary: false });
  assert.equal(a.got.length, 0);
  const b = mkServer({ tls: true, auth: { mechanisms: ['PLAIN'], verify: () => false } });
  assert.equal((run(b.s, { ehlo: 'c.example.org', message: MSG, auth: { user: 'ana', pass: 'x' } }).result as { code: number }).code, 535);
});

test('client: encryption is required by default, and credentials never go out in the clear', () => {
  const plain = mkServer({ auth: { mechanisms: ['PLAIN'], verify: () => true, allowInsecure: true } });
  const r = run(plain.s, { ehlo: 'c.example.org', message: MSG });
  assert.deepEqual(r.result, { ok: false, stage: 'starttls', code: 0, text: 'the server does not offer STARTTLS and encryption is required', temporary: false });
  const o = run(mkServer({ auth: { mechanisms: ['PLAIN'], verify: () => true, allowInsecure: true } }).s, { ehlo: 'c.example.org', message: MSG, tls: 'opportunistic', auth: { user: 'a', pass: 'b' } });
  assert.equal((o.result as { stage: string }).stage, 'auth');
  assert.match((o.result as { text: string }).text, /not sent over an unencrypted/);
  assert.ok(!o.wire.filter((w) => w.startsWith('C:')).join('').includes('AUTH'), 'no AUTH command was sent');
  const ok = mkServer();
  assert.equal(run(ok.s, { ehlo: 'c.example.org', message: MSG, tls: 'none' }).result?.ok, true);
  assert.equal(ok.got.length, 1);
  const implicit = mkServer({ auth: { mechanisms: ['PLAIN'], verify: () => true, allowInsecure: true } });
  implicit.s.tlsStarted();
  assert.equal(run(implicit.s, { ehlo: 'c.example.org', message: MSG, alreadyTls: true, auth: { user: 'a', pass: 'b' } }).result?.ok, true);
});

test('client: some recipients refused, all refused, sender refused, and message refused after DATA', () => {
  const partial = mkServer({ tls: false, onRecipient: (t) => (t.startsWith('ben@') ? { code: 550, text: 'no such user', enhanced: '5.1.1' } : undefined) });
  const r = run(partial.s, { ehlo: 'c.example.org', message: MSG, tls: 'none' });
  assert.deepEqual(r.result?.ok && [r.result.accepted, r.result.rejected], [['cy@example.net'], [{ to: 'ben@example.net', code: 550, text: 'no such user' }]]);
  assert.deepEqual(partial.got[0]!.env.to, ['cy@example.net']);
  const none = mkServer({ onRecipient: () => ({ code: 550, text: 'no', enhanced: '5.1.1' }) });
  assert.deepEqual(run(none.s, { ehlo: 'c.example.org', message: MSG, tls: 'none', pipelining: false }).result, { ok: false, stage: 'rcpt', code: 550, text: 'no', temporary: false });
  assert.deepEqual(run(mkServer({ onRecipient: () => ({ code: 550, text: 'no', enhanced: '5.1.1' }) }).s, { ehlo: 'c.example.org', message: MSG, tls: 'none' }).result, { ok: false, stage: 'rcpt', code: 550, text: 'no', temporary: false });
  const sender = mkServer({ onSender: () => ({ code: 451, text: 'try later', enhanced: '4.3.0' }) });
  assert.deepEqual(run(sender.s, { ehlo: 'c.example.org', message: MSG, tls: 'none' }).result, { ok: false, stage: 'mail', code: 451, text: 'try later', temporary: true });
  const content = mkServer({ onMessage: () => ({ code: 554, text: 'rejected', enhanced: '5.7.1' }) });
  assert.deepEqual(run(content.s, { ehlo: 'c.example.org', message: MSG, tls: 'none' }).result, { ok: false, stage: 'body', code: 554, text: 'rejected', temporary: false });
});

test('client checks the server\'s limits before sending: SIZE, 8BITMIME, SMTPUTF8, and bad addresses', () => {
  const small = run(mkServer({ maxSize: 20 }).s, { ehlo: 'c.example.org', message: MSG, tls: 'none' });
  assert.match((small.result as { text: string }).text, /the message is \d+ bytes; the server accepts 20/);
  const eight = { ...MSG, body: Buffer.from([0x68, 0xe9, 0x0a]) };
  const srv = mkServer();
  const ok = run(srv.s, { ehlo: 'c.example.org', message: eight, tls: 'none' });
  assert.equal(ok.result?.ok, true);
  assert.match(ok.wire.join(''), /BODY=8BITMIME/);
  assert.deepEqual([...Buffer.from(srv.got[0]!.body, 'latin1')], [0x68, 0xe9, 0x0d, 0x0a]);
  assert.equal(srv.got[0]!.env.body7bit, false);
  const bad = run(mkServer().s, { ehlo: 'c.example.org', message: { ...MSG, to: ['a@b.c>\r\nRCPT TO:<evil@x.y'] }, tls: 'none' });
  assert.match((bad.result as { text: string }).text, /cannot be sent/);
  assert.match((run(mkServer().s, { ehlo: 'c.example.org', message: { ...MSG, to: [] }, tls: 'none' }).result as { text: string }).text, /no recipient/);
  const utf8 = mkServer();
  const u = run(utf8.s, { ehlo: 'c.example.org', message: { ...MSG, to: ['josé@example.net'] }, tls: 'none' });
  assert.equal(u.result?.ok, true);
  assert.match(u.wire.join(''), /SMTPUTF8/);
  assert.equal(utf8.got[0]!.env.smtputf8, true);
});

test('client: a server that refuses the greeting ends the session with its reply', () => {
  const c = new ClientSession({ ehlo: 'c.example.org', message: MSG });
  const step = c.receive({ code: 554, lines: ['no service here'] });
  assert.deepEqual(step.done, { ok: false, stage: 'greeting', code: 554, text: 'no service here', temporary: false });
  const busy = new ClientSession({ ehlo: 'c.example.org', message: MSG });
  assert.equal(busy.receive({ code: 421, lines: ['busy'] }).done?.ok === false && busy.final?.ok === false ? 'temporary' : '', 'temporary');
  assert.equal((busy.final as { temporary: boolean }).temporary, true);
});
