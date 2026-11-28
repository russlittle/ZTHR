import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Matcher, MAX_LINE, RuleError, cosmeticSelectors, parseList, parseRule, registrableDomain, type NetworkRule } from './index.ts';

const net = (l: string) => parseRule(l) as NetworkRule;
const m = (...lines: string[]) => new Matcher(parseList(lines.join('\n')).rules);

test('comments, blank lines and the list header are not rules', () => {
  assert.equal(parseRule('! Title: Example'), undefined);
  assert.equal(parseRule('   '), undefined);
  assert.equal(parseRule('[Adblock Plus 2.0]'), undefined);
  const l = parseList('[Adblock Plus 2.0]\n! note\n||a.com^\n\n||b.com^');
  assert.equal(l.rules.length, 2);
  assert.equal(l.comments, 2);
  assert.deepEqual(l.errors, []);
});

test('||domain^ blocks the domain and its subdomains but not look-alikes', () => {
  const x = m('||ads.example.com^');
  assert.equal(x.match({ url: 'https://ads.example.com/banner.js' }).blocked, true);
  assert.equal(x.match({ url: 'https://eu.ads.example.com/x' }).blocked, true);
  assert.equal(x.match({ url: 'https://notads.example.com/x' }).blocked, false);
  assert.equal(x.match({ url: 'https://ads.example.com.evil.net/x' }).blocked, false, '^ needs a separator after the host');
  assert.equal(x.match({ url: 'https://example.com/ads.example.com/' }).blocked, false);
});

test('anchors and wildcards: |start, end|, * and the ^ separator', () => {
  const x = m('|https://track.', '/pixel.gif|', '/ad*/banner^');
  assert.equal(x.match({ url: 'https://track.site.org/a' }).blocked, true);
  assert.equal(x.match({ url: 'http://track.site.org/a' }).blocked, false);
  assert.equal(x.match({ url: 'https://s.org/img/pixel.gif' }).blocked, true);
  assert.equal(x.match({ url: 'https://s.org/img/pixel.gif?x=1' }).blocked, false);
  assert.equal(x.match({ url: 'https://s.org/ads/v2/banner?x' }).blocked, true);
  assert.equal(x.match({ url: 'https://s.org/ads/v2/banners' }).blocked, false);
});

test('an exception rule lets a blocked request through and says which rule did', () => {
  const x = m('||cdn.example.com^', '@@||cdn.example.com/safe/');
  const ok = x.match({ url: 'https://cdn.example.com/safe/lib.js' });
  assert.equal(ok.blocked, false);
  assert.equal(ok.excepted, true);
  assert.equal(ok.rule?.text, '@@||cdn.example.com/safe/');
  assert.equal(x.match({ url: 'https://cdn.example.com/other.js' }).blocked, true);
});

test('important beats an exception; badfilter switches a rule off', () => {
  const x = m('||t.example.com^$important', '@@||t.example.com^');
  assert.equal(x.match({ url: 'https://t.example.com/a' }).blocked, true);
  const y = m('||ads.example.net^$third-party', '||ads.example.net^$third-party,badfilter');
  assert.equal(y.match({ url: 'https://ads.example.net/x', page: 'https://other.org/' }).blocked, false);
  assert.equal(y.disabled.size, 1);
});

test('request type options include and exclude', () => {
  const x = m('||a.com^$script', '||b.com^$~image', '||c.com^$image,stylesheet');
  assert.equal(x.match({ url: 'https://a.com/x.js', type: 'script' }).blocked, true);
  assert.equal(x.match({ url: 'https://a.com/x.png', type: 'image' }).blocked, false);
  assert.equal(x.match({ url: 'https://b.com/x', type: 'image' }).blocked, false);
  assert.equal(x.match({ url: 'https://b.com/x', type: 'script' }).blocked, true);
  assert.equal(x.match({ url: 'https://c.com/x.css', type: 'stylesheet' }).blocked, true);
  assert.equal(x.match({ url: 'https://c.com/', type: 'document' }).blocked, false, 'document is never matched unless named');
});

test('third-party and first-party use the registrable domain', () => {
  const x = m('||metrics.example.com^$third-party');
  assert.equal(x.match({ url: 'https://metrics.example.com/p', page: 'https://news.org/' }).blocked, true);
  assert.equal(x.match({ url: 'https://metrics.example.com/p', page: 'https://www.example.com/' }).blocked, false);
  assert.equal(x.match({ url: 'https://metrics.example.com/p' }).blocked, false, 'no page means no third party');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('10.1.2.3'), '10.1.2.3');
  const first = m('||x.example.com^$~third-party');
  assert.equal(first.match({ url: 'https://x.example.com/a', page: 'https://example.com/' }).blocked, true);
  assert.equal(first.match({ url: 'https://x.example.com/a', page: 'https://other.org/' }).blocked, false);
});

test('domain= limits a rule to pages, with ~ to exclude', () => {
  const x = m('/ads.js$domain=news.org|blog.org|~live.news.org');
  assert.equal(x.match({ url: 'https://cdn.net/ads.js', page: 'https://news.org/a' }).blocked, true);
  assert.equal(x.match({ url: 'https://cdn.net/ads.js', page: 'https://m.blog.org/a' }).blocked, true);
  assert.equal(x.match({ url: 'https://cdn.net/ads.js', page: 'https://live.news.org/' }).blocked, false);
  assert.equal(x.match({ url: 'https://cdn.net/ads.js', page: 'https://other.org/' }).blocked, false);
  assert.equal(x.match({ url: 'https://cdn.net/ads.js' }).blocked, false);
  assert.deepEqual(net('/ads.js$domain=a.com|~b.com').options.notDomains, ['b.com']);
});

test('regex rules match, honour match-case, and long or nested-repeat regexes are refused', () => {
  const x = m('/\\/ad[0-9]+\\.js/');
  assert.equal(x.match({ url: 'https://s.org/ad42.js' }).blocked, true);
  assert.equal(x.match({ url: 'https://s.org/adx.js' }).blocked, false);
  const c = m('/Banner/$match-case');
  assert.equal(c.match({ url: 'https://s.org/Banner' }).blocked, true);
  assert.equal(c.match({ url: 'https://s.org/banner' }).blocked, false);
  assert.throws(() => parseRule('/(a+)+$/'), (e: unknown) => e instanceof RuleError && /nested repeat/.test(e.message));
  assert.throws(() => parseRule(`/${'a'.repeat(600)}/`), /512/);
  assert.throws(() => parseRule('/(unclosed/'), /does not compile/);
});

test('matching is case-insensitive unless match-case is set', () => {
  assert.equal(m('/TRACK/').match({ url: 'https://s.org/track/x' }).blocked, true, 'slash-wrapped text is a regex, and regexes ignore case by default');
  assert.equal(m('||Ads.Example.COM^').match({ url: 'https://ads.example.com/' }).blocked, true);
  assert.equal(m('/banner.').match({ url: 'https://s.org/BANNER.png' }).blocked, true);
});

test('hostile input: unknown options, empty options, oversized lines and all-wildcard patterns', () => {
  assert.throws(() => parseRule('||a.com^$bogus'), /unknown option "bogus"/);
  assert.throws(() => parseRule('||a.com^$script,,image'), /empty option/);
  assert.throws(() => parseRule('||a.com^$domain=a..b'), RuleError);
  assert.throws(() => parseRule('a'.repeat(MAX_LINE + 1)), /over 2000/);
  assert.throws(() => parseRule('***'), /only wildcards/);
  assert.throws(() => parseRule('@@'), /no pattern/);
  const l = parseList('||ok.com^\n||x.com^$nope\n||fine.com^');
  assert.equal(l.rules.length, 2, 'the good lines still load');
  assert.deepEqual(l.errors, [{ line: 2, message: 'unknown option "nope"' }]);
});

test('cosmetic rules are recognised, kept apart, and exceptions remove them', () => {
  const r = parseRule('news.org,blog.org##.ad-banner');
  assert.equal(r?.kind, 'cosmetic');
  const list = parseList('##.sponsored\nnews.org##.ad-banner\nnews.org#@#.sponsored\nother.org##.only-other').rules;
  assert.deepEqual(cosmeticSelectors(list, 'news.org'), ['.ad-banner']);
  assert.deepEqual(cosmeticSelectors(list, 'x.org'), ['.sponsored']);
  assert.deepEqual(cosmeticSelectors(list, 'other.org'), ['.sponsored', '.only-other']);
  assert.equal(m('##.sponsored').match({ url: 'https://s.org/.sponsored' }).blocked, false, 'cosmetic rules never block requests');
});

test('a dollar sign inside a path is not mistaken for options, and ports and query strings match', () => {
  const r = net('/cost$5/page');
  assert.equal(r.pattern, '/cost$5/page');
  assert.equal(m('||example.org^').match({ url: 'https://example.org:8443/a?b=1' }).blocked, true);
  assert.equal(m('/ads?id=').match({ url: 'https://s.org/ads?id=7' }).blocked, true);
  assert.equal(m('||example.org^').match({ url: 'not a url' }).blocked, false);
});

test('many rules: host-anchored rules are found by suffix and the general list still applies', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `||h${i}.example.net^`);
  const x = m(...lines, '/analytics/');
  assert.equal(x.match({ url: 'https://h1999.example.net/' }).rule?.text, '||h1999.example.net^');
  assert.equal(x.match({ url: 'https://h2000.example.net/' }).blocked, false);
  assert.equal(x.match({ url: 'https://s.org/analytics/x' }).blocked, true);
});
