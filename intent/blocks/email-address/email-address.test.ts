import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadAddress, canonical, decodeWords, domainToAscii, domainToUnicode, flatten, formatList, formatMailbox, isGroup, isNoReply, isRoleAddress, parseAddress, parseAddressList, plusTag, punycodeDecode, punycodeEncode } from './index.ts';

test('RFC 3492 section 7.1 sample strings encode and decode to the published Punycode', () => {
  const v: [string, string][] = [
    ['ليهمابتكلموشعربي؟', 'egbpdaj6bu4bxfgehfvwxn'],
    ['他们为什么不说中文', 'ihqwcrb4cv8a8dqg056pqjye'],
    ['他們爲什麽不說中文', 'ihqwctvzc91f659drss3x8bo0yb'],
    ['Pročprostěnemluvíčesky', 'Proprostnemluvesky-uyb24dma41a'],
    ['למההםפשוטלאמדבריםעברית', '4dbcagdahymbxekheh6e0a7fei0b'],
  ];
  for (const [u, p] of v) {
    assert.equal(punycodeEncode(u), p);
    assert.equal(punycodeDecode(p), u);
  }
  assert.equal(punycodeEncode('bücher'), 'bcher-kva');
  assert.equal(punycodeEncode('mañana'), 'maana-pta');
  assert.equal(punycodeEncode('München'), 'Mnchen-3ya');
  assert.equal(punycodeDecode('maana-pta'), 'mañana');
});

test('domains: non-ASCII labels become xn-- labels and back; ASCII is lower-cased', () => {
  assert.equal(domainToAscii('Bücher.Example'), 'xn--bcher-kva.example');
  assert.equal(domainToAscii('EXAMPLE.com'), 'example.com');
  assert.equal(domainToUnicode('xn--bcher-kva.example'), 'bücher.example');
  assert.throws(() => punycodeDecode('éé-x'), /bad punycode/);
  assert.throws(() => punycodeDecode('a-!!'), /bad punycode/);
  assert.throws(() => domainToAscii('a​bü.com'), /invisible/);
});

test('a plain address, with its parts', () => {
  const m = parseAddress('Ann.Lee+news@Example.COM');
  assert.deepEqual([m.local, m.domain, m.address, m.name], ['Ann.Lee+news', 'example.com', 'Ann.Lee+news@example.com', undefined]);
});

test('display names: plain, quoted with specials and escapes, and old-style with dots', () => {
  assert.equal(parseAddress('Ann Lee <ann@example.com>').name, 'Ann Lee');
  assert.equal(parseAddress('"Lee, Ann \\"A\\"" <ann@example.com>').name, 'Lee, Ann "A"');
  assert.equal(parseAddress('Dr. A. Lee <ann@example.com>').name, 'Dr. A. Lee');
  assert.equal(parseAddress('<ann@example.com>').name, undefined);
  assert.equal(parseAddress('  ann@example.com  ').address, 'ann@example.com');
});

test('comments are skipped, nest, and are kept: a name in parentheses after a bare address', () => {
  const m = parseAddress('bob@example.org (Bob (the builder) Jones)');
  assert.equal(m.address, 'bob@example.org');
  assert.deepEqual(m.comments, ['Bob (the builder) Jones']);
  assert.equal(parseAddress('Bob (work) <bob@example.org>').name, 'Bob');
  assert.equal(parseAddress('bob(comment)@example.org').address, 'bob@example.org');
});

test('RFC 2047 encoded words in names: base64, Q, other character sets, and joined neighbours', () => {
  assert.equal(parseAddress('=?UTF-8?B?w4FuZ2VsYQ==?= <a@example.com>').name, 'Ángela');
  assert.equal(parseAddress('=?ISO-8859-1?Q?Andr=E9_Dupont?= <a@example.com>').name, 'André Dupont');
  assert.equal(decodeWords('=?UTF-8?Q?caf=C3=A9?= =?UTF-8?Q?_au_lait?='), 'café au lait');
  assert.equal(decodeWords('plain text'), 'plain text');
  assert.equal(decodeWords('=?x-nonsense?B?QQ==?='), '=?x-nonsense?B?QQ==?=');
});

test('lists with commas inside quotes, groups, and empty entries', () => {
  const l = parseAddressList('"Lee, Ann" <ann@x.org>, bob@y.org,, Team: carol@z.org, Dave <dave@z.org>;, eve@w.org');
  assert.equal(l.length, 4);
  assert.equal((l[0] as { name: string }).name, 'Lee, Ann');
  const g = l[2]!;
  assert.ok(isGroup(g));
  if (isGroup(g)) assert.deepEqual([g.group, g.members.map((m) => m.address)], ['Team', ['carol@z.org', 'dave@z.org']]);
  assert.deepEqual(flatten(l).map((m) => m.address), ['ann@x.org', 'bob@y.org', 'carol@z.org', 'dave@z.org', 'eve@w.org']);
  assert.deepEqual(parseAddressList('Undisclosed recipients:;'), [{ group: 'Undisclosed recipients', members: [] }]);
});

test('quoted local parts and unicode local parts and domains', () => {
  const q = parseAddress('"john doe"@example.com');
  assert.equal(q.local, 'john doe');
  assert.equal(formatMailbox(q), '"john doe"@example.com');
  assert.equal(parseAddress('"a@b"@example.com').local, 'a@b');
  const u = parseAddress('Jörg <jörg@bücher.example>');
  assert.equal(u.local, 'jörg');
  assert.equal(u.domain, 'xn--bcher-kva.example');
  assert.equal(u.domainUnicode, 'bücher.example');
  assert.throws(() => parseAddress('jörg@example.com', { smtputf8: false }), BadAddress);
});

test('what is not an address is refused with a reason and a position', () => {
  const bad: [string, RegExp][] = [
    ['', /no address/],
    ['plain', /needs @|expected/],
    ['a@b', /needs a dot/],
    ['@example.com', /expected|empty/],
    ['a@', /needs a domain/],
    ['a..b@example.com', /dot must be followed/],
    ['.a@example.com', /expected a word|name/],
    ['a.@example.com', /dot must be followed/],
    ['a b@example.com', /needs @|name must be followed|expected/],
    ['a@-bad.com', /not a valid domain label/],
    ['a@bad-.com', /not a valid domain label/],
    ['a@exa_mple.com', /not a valid domain label|unexpected/],
    ['a@example.123', /all digits/],
    ['a@' + 'x'.repeat(64) + '.com', /longer than 63/],
    ['a'.repeat(65) + '@example.com', /longer than 64/],
    ['<@relay.com:a@example.com>', /source routes/],
    ['Ann <a@example.com', /not closed/],
    ['"abc@example.com', /not closed/],
    ['a@example.com b@example.com', /unexpected|must be followed/],
    ['a@xn--zz-.com', /not valid Punycode|not a valid domain label/],
    ['Team: a@example.com', /not closed/],
  ];
  for (const [s, re] of bad) assert.throws(() => parseAddressList(s), (e: unknown) => e instanceof BadAddress && re.test(e.message), s);
  assert.throws(() => parseAddress('a@example.com, b@example.com'), /exactly one/);
  assert.throws(() => parseAddress('Team: a@example.com;'), /exactly one/);
  try {
    parseAddress('ann@');
  } catch (e) {
    assert.ok(e instanceof BadAddress && e.at === 4);
  }
});

test('address literals are refused unless asked for', () => {
  assert.throws(() => parseAddress('a@[192.0.2.1]'), /IP number/);
  assert.equal(parseAddress('a@[192.0.2.1]', { allowLiteral: true }).domain, '[192.0.2.1]');
  assert.equal(parseAddress('a@[IPv6:2001:db8::1]', { allowLiteral: true }).domain, '[IPv6:2001:db8::1]');
  assert.throws(() => parseAddress('a@[not an ip]', { allowLiteral: true }), /address literal/);
});

test('hostile text: line breaks, NUL, control characters, huge lists and very long input', () => {
  assert.throws(() => parseAddress('a@example.com\r\nBcc: evil@example.org'), BadAddress);
  assert.throws(() => parseAddress('a\0@example.com'), /NUL/);
  assert.throws(() => parseAddress('"a\u0001b"@example.com'), /control characters/);
  assert.throws(() => parseAddressList('a@example.com,'.repeat(1001)), /more than 1000/);
  assert.throws(() => parseAddressList('x'.repeat(20_001)), /too long/);
  assert.equal(parseAddressList('a@example.com,\r\n b@example.com').length, 2, 'a folded header line is fine');
  assert.throws(() => parseAddress('(' .repeat(5000)), BadAddress);
});

test('canonical form: domain lower case, plus tag and case dropped, Gmail dots and googlemail', () => {
  assert.equal(canonical('Ann.Lee+news@EXAMPLE.com'), 'ann.lee@example.com');
  assert.equal(canonical('A.n.n+x@gmail.com'), 'ann@gmail.com');
  assert.equal(canonical('a.n.n@googlemail.com'), 'ann@gmail.com');
  assert.equal(canonical('a.b+c@example.com', { plus: false, lowercase: false }), 'a.b+c@example.com');
  assert.equal(canonical('A.b@gmail.com', { gmail: false }), 'a.b@gmail.com');
  assert.equal(canonical('+x@example.com'), '+x@example.com', 'a leading plus is part of the name');
  assert.equal(canonical('jörg@BÜCHER.example'), 'jörg@xn--bcher-kva.example');
  assert.equal(plusTag(parseAddress('a+news@example.com')), 'news');
  assert.equal(plusTag(parseAddress('a@example.com')), undefined);
});

test('role addresses and no-reply addresses are recognised', () => {
  for (const a of ['postmaster@example.com', 'ABUSE@example.com', 'info+x@example.com', 'noreply@example.com', 'Support@example.com']) assert.equal(isRoleAddress(a), true, a);
  for (const a of ['ann@example.com', 'infosec-ann@example.com', 'administrator.ann@example.com']) assert.equal(isRoleAddress(a), false, a);
  assert.equal(isNoReply('no-reply@example.com'), true);
  assert.equal(isNoReply('DoNotReply@example.com'), true);
  assert.equal(isNoReply('info@example.com'), false);
});

test('formatting: quoting, RFC 2047 for non-ASCII names, ASCII domains, and no header injection', () => {
  assert.equal(formatMailbox({ name: 'Ann Lee', local: 'ann', domain: 'example.com' }), 'Ann Lee <ann@example.com>');
  assert.equal(formatMailbox({ name: 'Lee, Ann "A"', local: 'ann', domain: 'example.com' }), '"Lee, Ann \\"A\\"" <ann@example.com>');
  assert.equal(formatMailbox({ name: 'Ángela', local: 'a', domain: 'bücher.example' }), '=?UTF-8?B?w4FuZ2VsYQ==?= <a@xn--bcher-kva.example>');
  assert.equal(formatMailbox({ local: 'a b', domain: 'example.com' }), '"a b"@example.com');
  assert.throws(() => formatMailbox({ name: 'x\r\nBcc: evil@example.org', local: 'a', domain: 'example.com' }), /line break/);
  assert.throws(() => formatMailbox({ local: 'a\n', domain: 'example.com' }), /line break/);
  const l = parseAddressList('"Lee, Ann" <ann@x.org>, Team: c@z.org;');
  assert.equal(formatList(l), '"Lee, Ann" <ann@x.org>, Team: c@z.org;');
});

test('what is formatted parses back to the same mailbox', () => {
  for (const s of ['"Lee, Ann" <ann@x.org>', '=?UTF-8?B?w4FuZ2VsYQ==?= <a@xn--bcher-kva.example>', 'plain@example.com', '"a b"@example.com']) {
    const m = parseAddress(s);
    const again = parseAddress(formatMailbox(m));
    assert.deepEqual([again.name, again.address], [m.name, m.address], s);
  }
});
