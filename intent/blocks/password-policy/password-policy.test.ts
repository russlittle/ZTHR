import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { estimate, rangeQuery, matchRange, History, baseOf, evaluate, mustChange, describePolicy, DEFAULT_POLICY, type Hasher } from './index.ts';

test('SHA-1 range split matches the published HIBP example for "password"', () => {
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const p = rangeQuery('password');
  assert.equal(p.prefix, '5BAA6');
  assert.equal(p.suffix, '1E4C9B93F3F0682250B6CF8331B7EE68FD8');
  assert.equal(p.prefix.length + p.suffix.length, 40);
});

test('matchRange finds the suffix, ignores padding rows and case, and misses otherwise', () => {
  const p = rangeQuery('password');
  const body = `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${p.suffix.toLowerCase()}:9545824\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n`;
  assert.equal(matchRange(p, body), 9545824);
  assert.equal(matchRange(p, '0018A45C4D1DEF81644B54AB7F969B88D65:1\n'), 0);
  assert.equal(matchRange(p, ''), 0);
  assert.equal(matchRange({ prefix: 'AAAAA', suffix: p.suffix }, `${p.suffix}:0`), 0);
  assert.throws(() => matchRange(p, 'x'.repeat(2 * 1024 * 1024 + 1)), RangeError);
});

test('the request never carries more than five hash characters', () => {
  const p = rangeQuery('correct horse battery staple');
  const full = createHash('sha1').update('correct horse battery staple').digest('hex').toUpperCase();
  assert.equal(p.prefix, full.slice(0, 5));
  assert.equal(p.prefix.length, 5);
});

test('common passwords score 0 with a warning', () => {
  const e = estimate('password');
  assert.equal(e.score, 0);
  assert.match(e.warning!, /most commonly used/);
  assert.equal(e.matches[0]!.kind, 'common');
});

test('l33t and capitalisation do not rescue a common word', () => {
  assert.ok(estimate('P@ssw0rd').score <= 1);
  assert.ok(estimate('Password1').score <= 1);
  assert.match(estimate('Dragon!').warning ?? '', /common/);
});

test('keyboard walks, sequences, repeats and dates are found', () => {
  assert.equal(estimate('qwertyui').matches[0]!.kind, 'keyboard');
  assert.equal(estimate('abcdefgh').matches[0]!.kind, 'sequence');
  assert.equal(estimate('aaaaaaaa').matches[0]!.kind, 'repeat');
  assert.equal(estimate('ababababab').matches[0]!.kind, 'repeat');
  assert.equal(estimate('19800101').matches[0]!.kind, 'date');
  for (const pw of ['qwertyui', 'abcdefgh', 'aaaaaaaa', '19800101']) assert.ok(estimate(pw).score <= 1, pw);
});

test('length wins: a long passphrase scores high, a short random one low', () => {
  assert.equal(estimate('lantern-orbit-velvet-quarry-ember').score, 4);
  assert.ok(estimate('xK9#m').log10 < estimate('zq7!Rt3$vN8').log10);
  assert.ok(estimate('zq7!Rt3$vN8').score >= 3);
});

test('context words are guessed first', () => {
  const plain = estimate('maria2024x', {});
  const ctx = estimate('maria2024x', { context: ['maria'] });
  assert.ok(ctx.guesses < plain.guesses);
  assert.ok(ctx.matches.some((m) => m.kind === 'context'));
  assert.match(ctx.warning ?? '', /information about you/);
});

test('empty and unicode input are handled', () => {
  assert.equal(estimate('').score, 0);
  assert.match(estimate('').warning!, /empty/);
  assert.ok(estimate('пароль-со-словами-длинный').score >= 3);
  assert.equal(estimate('ｐａｓｓｗｏｒｄ').score, 0, 'fullwidth letters fold to password');
});

test('guesses never decrease when characters are appended', () => {
  let prev = 0;
  for (const pw of ['t', 'tr', 'tr0', 'tr0u', 'tr0ub', 'tr0ub4', 'tr0ub4d', 'tr0ub4dor&3']) {
    const g = estimate(pw).guesses;
    assert.ok(g >= prev * 0.5, `${pw}: ${g} vs ${prev}`);
    prev = g;
  }
  assert.ok(estimate('correct horse battery staple').log10 > estimate('Tr0ub4dor&3').log10);
});

test('evaluate: length, breach, score, control characters, no echo of the password', () => {
  const pw = 'hunter2hunter2';
  const v = evaluate('short');
  assert.equal(v.ok, false);
  assert.match(v.problems[0]!, /at least 12/);
  const ok = evaluate('lantern-orbit-velvet-quarry', { breachCount: 0 });
  assert.equal(ok.ok, true);
  const breached = evaluate('lantern-orbit-velvet-quarry', { breachCount: 42 });
  assert.equal(breached.ok, false);
  assert.match(breached.problems.join(' '), /data breach/);
  assert.ok(!evaluate(pw).problems.join(' ').includes(pw));
  assert.match(evaluate('a\u0000b-long-enough-xyz').problems.join(' '), /control/);
  assert.match(evaluate('x'.repeat(200)).problems.join(' '), /at most 128/);
  assert.equal(evaluate('Kj7!vQ2#pL9@wZ', { policy: { ...DEFAULT_POLICY, requireClasses: 4 } }).ok, true);
  assert.match(evaluate('lanternorbitvelvetquarry', { policy: { ...DEFAULT_POLICY, requireClasses: 3 } }).problems.join(' '), /3 kinds/);
});

test('evaluate: context blocks a name inside an otherwise long password', () => {
  const v = evaluate('maria-maria-maria-x9', { context: ['maria'] });
  assert.equal(v.ok, false);
});

test('mustChange: never on a schedule by default, but on compromise or a set age', () => {
  const day = 86_400_000;
  assert.equal(mustChange(DEFAULT_POLICY, 0, 1000 * day), false);
  assert.equal(mustChange(DEFAULT_POLICY, 0, 1, true), true);
  assert.equal(mustChange({ ...DEFAULT_POLICY, maxAgeDays: 90 }, 0, 91 * day), true);
  assert.equal(mustChange({ ...DEFAULT_POLICY, maxAgeDays: 90 }, 0, 89 * day), false);
});

// a test hasher: the hash is salted but trivially reversible-free for the purpose of the test
const hasher: Hasher = {
  async hash(pw) {
    const salt = Math.random().toString(36).slice(2);
    return `${salt}$${createHash('sha256').update(salt + pw).digest('hex')}`;
  },
  async verify(pw, h) {
    const [salt, d] = h.split('$');
    return createHash('sha256').update(salt + pw).digest('hex') === d;
  },
};

test('History refuses reuse and near-reuse, and keeps only the newest N', async () => {
  const hist = new History(hasher, 3);
  let e = await hist.record([], 'Winter2024!', 1);
  assert.equal(await hist.check(e, 'Winter2024!'), 'reused');
  assert.equal(await hist.check(e, 'Winter2025!'), 'near');
  assert.equal(await hist.check(e, 'lantern-orbit-velvet'), 'ok');
  for (const [i, p] of ['aaaa-one-1', 'bbbb-two-2', 'cccc-three-3'].entries()) e = await hist.record(e, p, 2 + i);
  assert.equal(e.length, 3);
  assert.equal(await hist.check(e, 'Winter2024!'), 'ok', 'fell out of the window');
  assert.equal(e[0]!.pw.at, 4);
});

test('baseOf strips trailing counters and symbols but not the middle', () => {
  assert.equal(baseOf('Winter2024!'), 'winter');
  assert.equal(baseOf('my-2nd-pass99'), 'my-2nd-pass');
});

test('describePolicy follows the policy', () => {
  const d = describePolicy();
  assert.match(d[0]!, /At least 12 characters; up to 128/);
  assert.ok(d.some((l) => /last 5 passwords/.test(l)));
  assert.ok(d.some((l) => /not be asked to change it on a schedule/.test(l)));
  const d2 = describePolicy({ ...DEFAULT_POLICY, maxAgeDays: 90, historySize: 0, blockBreached: false, requireClasses: 3 });
  assert.ok(d2.some((l) => /every 90 days/.test(l)));
  assert.ok(!d2.some((l) => /last/.test(l)));
  assert.ok(!d2.some((l) => /breach/.test(l)));
  assert.ok(d2.some((l) => /3 kinds/.test(l)));
});
