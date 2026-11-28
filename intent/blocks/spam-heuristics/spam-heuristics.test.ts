import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reputation, SpamConfigError, SpamScorer, entropy, explain, extractLinks, identities, mixedScriptWords, networkOf } from './index.ts';
import type { Config, Hit, Rule, Submission } from './index.ts';

const DAY = 86_400_000;
const make = (c: Config = {}) => {
  const clock = { now: 10 * DAY };
  const scorer = new SpamScorer({ honeypots: ['website_url'], words: { viagra: 50, 'free money': 30 }, now: () => clock.now, velocity: {}, ...c });
  return { scorer, clock };
};
const human: Submission = { kind: 'comment', content: 'Thanks for the clear write-up, the second example helped me fix my build.', renderedAt: 0, submittedAt: 45_000, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0' };
const rules = (r: { hits: readonly Hit[] }) => r.hits.map((h) => h.rule);
const points = (r: { hits: readonly Hit[] }, rule: string) => r.hits.filter((h) => h.rule === rule).reduce((n, h) => n + h.points, 0);

test('an ordinary comment scores nothing and is accepted', () => {
  const { scorer } = make();
  const r = scorer.score(human);
  assert.deepEqual({ score: r.score, verdict: r.verdict, hits: r.hits }, { score: 0, verdict: 'accept', hits: [] });
  assert.equal(explain(r), 'Accepted (score 0): nothing looked wrong.');
});

test('a filled honeypot is decisive: nothing, not even a long good record, outweighs it', () => {
  const { scorer } = make();
  for (let i = 0; i < 20; i++) scorer.feedback({ ...human, userId: 'ana' }, 'ham');
  const r = scorer.score({ ...human, userId: 'ana', signedIn: true, fields: { website_url: 'http://spam.example', other: 'x' } });
  assert.equal(r.decisive, true);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.hits[0]?.rule, 'honeypot');
  assert.equal(r.hits[0]?.detail, 'the hidden field "website_url" was filled in');
  assert.equal(scorer.score({ ...human, content: 'A different and entirely ordinary comment that nobody has sent before.', fields: { website_url: '   ' } }, { dryRun: true }).verdict, 'accept', 'blank is not filled');
});

test('forms come back too fast, before they were shown, stale, or with no record at all', () => {
  const { scorer } = make();
  const at = (renderedAt: number | undefined, submittedAt: number | undefined) => points(scorer.score({ ...human, ...(renderedAt !== undefined ? { renderedAt } : { renderedAt: undefined as never }), submittedAt: submittedAt as never }, { dryRun: true }), 'fill-time');
  assert.equal(at(1000, 1500), 45);
  assert.equal(at(1000, 3000), 30);
  assert.equal(at(1000, 4000), 0, 'exactly the minimum is a person');
  assert.equal(at(1000, 60_000), 0);
  assert.equal(at(5000, 1000), 25);
  assert.equal(at(0, 2 * DAY), 10);
  assert.equal(at(undefined, undefined), 10);
  assert.equal(points(scorer.score({ content: 'x' }), 'fill-time'), 0, 'no kind, no expectation');
});

test('links are counted, weighed against the words, and checked for tricks', () => {
  const { scorer } = make();
  const s = (content: string) => scorer.score({ ...human, content }, { dryRun: true });
  assert.equal(points(s('See https://a.example and https://b.example for details of the design.'), 'links'), 0);
  const five = s('buy http://a.example http://b.example http://c.example http://d.example http://e.example');
  assert.equal(points(five, 'links'), 24, 'three more than allowed, 8 each');
  assert.equal(points(five, 'link-share'), 15);
  assert.equal(points(s('Look at https://bit.ly/abc please, it explains the whole thing in full.'), 'link-shortener'), 15);
  assert.equal(points(s('Try http://192.168.4.4/login to see how the page looks when signed in.'), 'link-ip'), 20);
  assert.equal(points(s('Go to http://paypal.com@evil.example/pay to read the full terms of the deal.'), 'link-userinfo'), 25);
  assert.equal(points(s('Visit http://xn--pypal-4ve.com/x to read the full terms of the deal today.'), 'link-punycode'), 15);
  assert.equal(points(s('https://spam.example/buy'), 'link-only'), 25);
  assert.equal(points(s('www.spam.example'), 'link-only'), 25);
  assert.equal(points(s('Visit https://example.org. It is a good read, honestly, from start to end.'), 'link-only'), 0);
  assert.deepEqual(extractLinks('a http://x.example/a?b=1, and www.y.example.').map((l) => l.host), ['x.example', 'www.y.example']);
});

test('weighted words match whole words, ignore case, accents and punctuation, and each counts once', () => {
  const { scorer } = make();
  const s = (content: string) => scorer.score({ ...human, content }, { dryRun: true });
  assert.equal(points(s('Cheap VIAGRA here, cheap viagra there'), 'word'), 50);
  assert.equal(points(s('Cheap Víágra!!!'), 'word'), 50);
  assert.equal(points(s('The Viagrarium opens at noon'), 'word'), 0, 'inside another word is not a match');
  assert.equal(points(s('earn FREE   money, now'), 'word'), 30);
  assert.equal(points(s('free, money is not the point'), 'word'), 30, 'punctuation between words does not hide a phrase');
  assert.equal(points(s('a free lunch and money talks'), 'word'), 0);
});

test('hidden characters, mixed alphabets, shouting, repetition and empty text are each noticed', () => {
  const { scorer } = make();
  const s = (content: string) => scorer.score({ ...human, content }, { dryRun: true });
  assert.equal(points(s('hel​lo wor‌ld'), 'hidden-characters'), 20);
  assert.equal(points(s('hello wor​ld'), 'hidden-characters'), 0, 'one is not enough to judge');
  assert.deepEqual(mixedScriptWords('Visit pаypal now, Привет and hello'), ['pаypal']);
  assert.equal(points(s('log in to pаypal today'), 'mixed-scripts'), 25);
  assert.equal(points(s('Привет, как дела у вас сегодня'), 'mixed-scripts'), 0, 'a whole Cyrillic text is fine');
  assert.equal(points(s('BUY NOW BEST PRICES GUARANTEED TODAY ONLY'), 'shouting'), 10);
  assert.equal(points(s('WOW!!!!!!!!!!!!! amazing'), 'repetition'), 10);
  assert.equal(points(s('   '), 'empty'), 10);
  assert.equal(points(s('x'.repeat(30_000)), 'oversized'), 15);
});

test('email addresses from throw-away domains, random names and links as names are scored', () => {
  const { scorer } = make();
  const s = (extra: Partial<Submission>) => scorer.score({ ...human, ...extra }, { dryRun: true });
  assert.equal(points(s({ email: 'a@Mailinator.com' }), 'email-disposable'), 30);
  assert.equal(points(s({ email: 'ana.lopez@example.com' }), 'email-random'), 0);
  assert.equal(points(s({ email: 'ana.lopez+news@example.com' }), 'email-random'), 0);
  assert.equal(points(s({ email: 'a8k3j9x2m5q7w1z4@example.com' }), 'email-random'), 15);
  assert.equal(points(s({ email: 'not-an-email' }), 'email'), 20);
  assert.equal(points(s({ email: 'a@b' }), 'email'), 20);
  assert.equal(points(s({ email: 'a@b.co', name: 'http://buy.example' }), 'name-link'), 25);
  assert.equal(s({}).hits.length, 0, 'no email, nothing to check');
  assert.ok(entropy('aaaa') === 0 && entropy('ab') === 1 && entropy('abcd') === 2 && entropy('') === 0);
});

test('a script is not a browser', () => {
  const { scorer } = make();
  const s = (userAgent: string) => points(scorer.score({ ...human, userAgent }, { dryRun: true }), 'user-agent');
  assert.equal(s('curl/8.4.0'), 20);
  assert.equal(s('python-requests/2.31'), 20);
  assert.equal(s('Go-http-client/1.1'), 20);
  assert.equal(s(''), 15);
  assert.equal(s('Mozilla/5.0 (Macintosh) Safari/605.1.15'), 0);
});

// ------------------------------------------------------------ velocity, copies, reputation

test('a burst from one address, one network or one account costs points, and the cost fades as time passes', () => {
  const { scorer, clock } = make({ velocity: { ip: { burst: 2, perSecond: 0.1 }, network: { burst: 3, perSecond: 0.1 }, user: { burst: 2, perSecond: 0.1 } } });
  const send = (ip: string, userId?: string) => scorer.score({ ...human, ip, ...(userId ? { userId } : {}) });
  assert.equal(points(send('203.0.113.7'), 'velocity'), 0);
  assert.equal(points(send('203.0.113.7'), 'velocity'), 0);
  const third = send('203.0.113.7');
  assert.equal(points(third, 'velocity'), 25, 'the address is over; the network has used its third token');
  assert.match(third.hits.find((h) => h.rule === 'velocity')?.detail ?? '', /this address is sending faster than usual \(wait \d+ s\)/);
  assert.equal(points(send('203.0.113.99'), 'velocity'), 20, 'another address on the same /24 trips only the network');
  assert.equal(points(send('198.51.100.1', 'u1'), 'velocity'), 0);
  assert.equal(points(send('198.51.100.2', 'u1'), 'velocity'), 0);
  assert.equal(points(send('198.51.100.3', 'u1'), 'velocity'), 30, 'the account is over');
  clock.now += 60_000;
  assert.equal(points(send('203.0.113.7'), 'velocity'), 0, 'six tokens came back');
});

test('a dry run looks without counting', () => {
  const { scorer } = make({ velocity: { ip: { burst: 1, perSecond: 0.01 } } });
  const s: Submission = { ...human, ip: '203.0.113.7', content: 'The same sentence long enough to be compared with itself later on.' };
  for (let i = 0; i < 5; i++) assert.equal(points(scorer.score(s, { dryRun: true }), 'velocity'), 0);
  assert.equal(points(scorer.score(s), 'velocity'), 0);
  assert.equal(points(scorer.score(s, { dryRun: true }), 'velocity'), 25, 'the real one used the only token');
  assert.equal(points(scorer.score(s, { dryRun: true }), 'duplicate-self'), 15);
});

test('the same text from different senders is copying, within a window; from the same sender, a repeat', () => {
  const { scorer, clock } = make();
  const text = 'Hello friend, I found a great opportunity that you should really look at today.';
  const a = scorer.score({ ...human, content: text, ip: '203.0.113.1' });
  assert.equal(points(a, 'duplicate'), 0);
  const b = scorer.score({ ...human, content: text.toUpperCase().replace(/,/g, ' '), ip: '203.0.113.2' });
  assert.equal(points(b, 'duplicate'), 35, 'case and punctuation do not hide it');
  const c = scorer.score({ ...human, content: text, ip: '203.0.113.3' });
  assert.equal(points(c, 'duplicate'), 45, 'two other senders');
  const again = scorer.score({ ...human, content: text, ip: '203.0.113.3' });
  assert.equal(points(again, 'duplicate-self'), 0, 'others also sent it, so it counts as copying');
  assert.ok(points(again, 'duplicate') > 0);
  clock.now += 2 * 3_600_000;
  assert.equal(points(scorer.score({ ...human, content: text, ip: '203.0.113.9' }), 'duplicate'), 0, 'forgotten after the window');
  assert.equal(points(scorer.score({ ...human, content: 'short', ip: '203.0.113.1' }), 'duplicate'), 0, 'short texts are not compared');
});

test('reputation: a spam history adds points, a clean one removes them, and both fade with time', () => {
  const { scorer, clock } = make();
  const bad: Submission = { ...human, ip: '198.51.100.20' };
  const good: Submission = { ...human, userId: 'ana', ip: '203.0.113.5' };
  assert.equal(points(scorer.score(bad, { dryRun: true }), 'reputation'), 0);
  scorer.feedback(bad, 'spam');
  const one = points(scorer.score(bad, { dryRun: true }), 'reputation');
  assert.ok(one >= 25, `one spam gives ${one}`);
  scorer.feedback(bad, 'spam');
  assert.ok(points(scorer.score(bad, { dryRun: true }), 'reputation') > one);
  for (let i = 0; i < 10; i++) scorer.feedback(good, 'ham');
  const trusted = points(scorer.score(good, { dryRun: true }), 'reputation');
  assert.ok(trusted < 0 && trusted >= -30, `trusted gives ${trusted}`);
  const lone: Submission = { ...human, userId: 'mallory' };
  scorer.feedback(lone, 'spam');
  const before = points(scorer.score(lone, { dryRun: true }), 'reputation');
  assert.equal(before, 25);
  clock.now += 14 * DAY;
  assert.ok(Math.abs(points(scorer.score(lone, { dryRun: true }), 'reputation') - 12.5) < 1, 'one half-life halves it');
  clock.now += 200 * DAY;
  assert.equal(points(scorer.score(bad, { dryRun: true }), 'reputation'), 0, 'a spammer is eventually forgiven');
});

test('someone else on the same network or email domain shares part of the record', () => {
  const { scorer } = make();
  scorer.feedback({ ...human, ip: '198.51.100.20', email: 'x@spamdomain.example', content: 'x' }, 'spam');
  const neighbour = scorer.score({ ...human, ip: '198.51.100.77', email: 'y@spamdomain.example' }, { dryRun: true });
  assert.ok(points(neighbour, 'reputation') > 0);
  assert.match(neighbour.hits.find((h) => h.rule === 'reputation')?.detail ?? '', /net:198\.51\.100\.0\/24/);
  assert.deepEqual(identities({ content: '', userId: 'u', ip: '2001:db8::1', email: 'a@B.co' }), ['user:u', 'ip:2001:db8::1', 'net:2001:0db8:0000:0000::/64', 'domain:b.co']);
});

test('text marked as spam is recognised when it comes back, and cleared when marked as fine', () => {
  const { scorer } = make();
  const s: Submission = { ...human, content: 'Win a free holiday today, simply reply to this message with your details.' };
  scorer.feedback(s, 'spam');
  const r = scorer.score({ ...s, content: s.content.toUpperCase() }, { dryRun: true });
  assert.equal(points(r, 'known-spam'), 80);
  assert.equal(r.verdict, 'reject');
  scorer.feedback(s, 'ham');
  assert.equal(points(scorer.score(s, { dryRun: true }), 'known-spam'), 0);
});

// ------------------------------------------------------------ verdicts and configuration

const fixed = (n: number): Rule => ({ id: 'fixed', check: () => ({ rule: 'fixed', points: n, detail: `fixed ${n}` }) });

test('the thresholds decide accept, review and reject at exactly their boundaries', () => {
  for (const [n, want] of [[0, 'accept'], [29, 'accept'], [30, 'review'], [69, 'review'], [70, 'reject'], [500, 'reject'], [-50, 'accept']] as const) {
    const { scorer } = make({ onlyCustomRules: true, rules: [fixed(n)] });
    const r = scorer.score(human);
    assert.equal(r.verdict, want, `${n}`);
    assert.equal(r.score, Math.max(0, n));
  }
  const strict = make({ onlyCustomRules: true, rules: [fixed(10)], thresholds: { review: 5, reject: 10 } }).scorer.score(human);
  assert.equal(strict.verdict, 'reject');
});

test('configuration is checked, and a custom rule that fails is recorded without stopping the rest', () => {
  assert.throws(() => new SpamScorer({ thresholds: { review: 0, reject: 10 } }), SpamConfigError);
  assert.throws(() => new SpamScorer({ thresholds: { review: 50, reject: 50 } }), SpamConfigError);
  assert.throws(() => new SpamScorer({ rules: [{ id: 'honeypot', check: () => undefined }] }), /listed twice/);
  assert.throws(() => new Reputation(0), SpamConfigError);
  const broken: Rule = { id: 'broken', check: () => { throw new Error('lookup failed'); } };
  const { scorer } = make({ rules: [broken, fixed(40)] });
  const r = scorer.score(human);
  assert.equal(r.verdict, 'review');
  assert.deepEqual(r.hits.map((h) => [h.rule, h.points]), [['fixed', 40], ['broken-error', 0]]);
  assert.match(explain(r), /^Held for review \(score 40\): fixed 40 \(\+40, fixed\)\.$/);
});

test('a spam message is explained in one readable sentence, biggest reason first', () => {
  const { scorer } = make();
  const r = scorer.score({ kind: 'comment', content: 'FREE MONEY!!! buy viagra at https://bit.ly/x now', userAgent: 'curl/8', renderedAt: 0, submittedAt: 500 });
  assert.equal(r.verdict, 'reject');
  assert.deepEqual(rules(r).slice(0, 2), ['word', 'fill-time']);
  assert.match(explain(r), /^Rejected as spam \(score \d+\): contains "viagra" \(\+50, word\); the form came back after 500 ms/);
  assert.match(explain(r), /contains "viagra" \(\+50, word\)/);
});

// ------------------------------------------------------------ helpers and hostile input

test('networks are the /24 of an IPv4 and the /64 of an IPv6, and junk has none', () => {
  assert.equal(networkOf('203.0.113.77'), '203.0.113.0/24');
  assert.equal(networkOf('2001:db8::1'), '2001:0db8:0000:0000::/64');
  assert.equal(networkOf('2001:DB8:1:2:3:4:5:6'), '2001:0db8:0001:0002::/64');
  assert.equal(networkOf('::1'), '0000:0000:0000:0000::/64');
  for (const bad of ['999.1.1.1', '1.2.3', 'zz::1', '1::2::3', '', 'localhost', '1:2:3:4:5:6:7:8:9', '12345::1']) assert.equal(networkOf(bad), undefined, bad);
});

test('huge and hostile texts are handled in bounded time', () => {
  const { scorer } = make();
  const t0 = Date.now();
  const nasty = ['a'.repeat(200_000), 'http://' + 'a.'.repeat(50_000), ('x'.repeat(8) + ' ').repeat(30_000), '​'.repeat(100_000), 'pа'.repeat(50_000), '<a href="' + 'x'.repeat(100_000)];
  for (const content of nasty) {
    const r = scorer.score({ ...human, content }, { dryRun: true });
    assert.ok(['accept', 'review', 'reject'].includes(r.verdict));
  }
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  const r = scorer.score({ ...human, content: 'a'.repeat(200_000) }, { dryRun: true });
  assert.equal(points(r, 'oversized'), 15);
  assert.equal(scorer.score({ ...human, content: 'ok\u0000text with a null', ip: 'not an ip', email: '\u0000@\u0000' }, { dryRun: true }).verdict !== undefined, true);
});
