import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsvError, RedirectRuleError, RuleSet, exportCsv, importCsv, normalizePath, parseCsv, regexRisk, safeLocation, type Rule } from './index.ts';

const set = (rules: Rule[], o = {}) => new RuleSet(rules, o);
const loc = (s: RuleSet, path: string, q = '', method = 'GET') => s.match({ path, query: q, method }, { record: false })?.location;

test('exact rules: case-insensitive, trailing slash and repeated slashes ignored, dot segments resolved', () => {
  const s = set([{ from: '/Old-Page', to: '/new' }]);
  for (const p of ['/old-page', '/OLD-PAGE/', '//old-page', '/a/../old-page', '/./old-page', '/old%2Dpage']) assert.equal(loc(s, p), '/new', p);
  assert.equal(loc(s, '/old-page2'), undefined);
  assert.equal(loc(s, '/x/old-page'), undefined);
  const cs = set([{ from: '/Old', to: '/n', caseSensitive: true }]);
  assert.equal(loc(cs, '/Old'), '/n');
  assert.equal(loc(cs, '/old'), undefined);
});

test('paths that are malformed match nothing and never throw', () => {
  const s = set([{ from: '/a', to: '/b' }, { from: '^/.*$', to: '/c' }]);
  for (const p of ['', 'a', '/a\u0000', '/a%zz', '/a%', '/a\\b', '/' + 'x'.repeat(3000), '/a\nb']) assert.equal(s.match({ path: p }), undefined, JSON.stringify(p.slice(0, 20)));
  assert.equal(normalizePath('/a%41%2fb')?.path, '/aA%2Fb', 'only unreserved characters are decoded');
});

test('glob rules fill placeholders and a trailing splat', () => {
  const s = set([
    { from: '/blog/:year/:slug', to: '/posts/:year-:slug' },
    { from: '/docs/*', to: '/manual/:splat' },
    { from: '/shop/:cat', to: '/store/:cat/all' },
  ]);
  assert.equal(loc(s, '/blog/2020/hello'), '/posts/2020-hello');
  assert.equal(loc(s, '/blog/2020'), undefined);
  assert.equal(loc(s, '/blog/2020/hello/more'), undefined);
  assert.equal(loc(s, '/docs/a/b/c'), '/manual/a/b/c');
  assert.equal(loc(s, '/docs'), '/manual/');
  assert.equal(loc(s, '/DOCS/Intro'), '/manual/Intro');
  assert.equal(loc(s, '/shop/Hats'), '/store/Hats/all');
});

test('regex rules: captures, flags, and the input cap', () => {
  const s = set([{ from: '^/p/(\\d+)/(.*)$', to: '/posts/$1?slug=$2' }], { maxRegexInput: 40 });
  assert.equal(loc(s, '/p/42/hello'), '/posts/42?slug=hello');
  assert.equal(loc(s, '/P/42/hello'), '/posts/42?slug=hello');
  assert.equal(loc(s, '/p/42/' + 'x'.repeat(100)), undefined, 'over the cap, a regex rule is not run');
});

test('regex cost check rejects the classic catastrophic shapes and accepts ordinary ones', () => {
  for (const bad of ['^(a+)+$', '^(a*)*$', '^(a|a)*$', '^(a|aa)+$', '^(.*a){20}$', '^(\\w+\\s?)*$', '^([a-z]+)*x', '/no-anchor', '^(a)\\1$', '^(?<=a)b', '^a{1,500}$', '^' + 'a'.repeat(300), '^.*.*.*.*$', '^(a']) {
    assert.equal(regexRisk(bad).ok, false, bad);
  }
  for (const ok of ['^/p/(\\d+)$', '^/(en|fr|de)/(.*)$', '^/a/([^/]+)/b/([^/]+)$', '^/v(\\d{1,3})/(.+)$', '^/x(?:y)?z$', '^/blog/(\\d{4})/(\\d{2})/([a-z0-9-]+)/?$']) {
    const r = regexRisk(ok);
    assert.equal(r.ok, true, `${ok}: ${r.reasons.join(', ')}`);
  }
  assert.throws(() => set([{ from: '^(a+)+$', to: '/x' }]), (e: unknown) => e instanceof RedirectRuleError && /nested quantifiers/.test(e.message));
});

test('an accepted regex rule is fast on the worst input the cap allows', () => {
  const s = set([{ from: '^/a/(\\w+)/(\\w+)/(.*)$', to: '/b/$1' }]);
  const t = Date.now();
  for (let i = 0; i < 50; i++) s.match({ path: '/a/' + 'x'.repeat(400) + '/' + 'y'.repeat(60) + '!' }, { record: false });
  assert.ok(Date.now() - t < 1500);
});

test('rules are validated, with every problem listed at once', () => {
  const s = set([]);
  const p = s.problems({ from: 'no-slash', to: '', status: 299, methods: ['G ET'], hosts: ['bad host'] });
  assert.ok(p.length >= 4, p.join(' | '));
  assert.ok(p.some((x) => /from must start/.test(x)));
  assert.ok(p.some((x) => /status 299/.test(x)));
  assert.deepEqual(s.problems({ from: '/gone', status: 410 }), []);
  assert.ok(s.problems({ from: '/gone', status: 410, to: '/x' }).some((x) => /no destination/.test(x)));
  assert.ok(s.problems({ from: '/a/:x', to: '/b/:y' }).some((x) => /does not define/.test(x)));
  assert.ok(s.problems({ from: '/a/b*', to: '/b' }).some((x) => /last segment/.test(x)));
  assert.ok(s.problems({ from: '/a/:x/:x', to: '/b' }).some((x) => /repeated/.test(x)));
  assert.ok(s.problems({ from: '^/a/(.*)$', to: '/b/$2' }).some((x) => /uses \$2/.test(x)));
  assert.ok(s.problems({ from: '/a?x=1', to: '/b' }).some((x) => /query strings/.test(x)));
  assert.throws(() => s.add({ from: '/a', to: '/b', id: 'x' }) && s.add({ from: '/c', to: '/d', id: 'x' }), /already used/);
});

test('destinations: no protocol-relative, javascript:, credentials or host placeholders', () => {
  const s = set([]);
  for (const to of ['//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'https://u:p@evil.example/', 'ftp://x.example/', 'data:text/html,hi', '/a b', '/a\r\nSet-Cookie: x=1', 'mailto:a@b.c']) {
    assert.ok(s.problems({ from: '/a', to }).length > 0, JSON.stringify(to));
  }
  assert.ok(s.problems({ from: '/a/:h', to: 'https://:h.example/' }).some((x) => /host part/.test(x)));
  assert.ok(s.problems({ from: '^/a/(.*)$', to: 'https://$1.example/' }).some((x) => /host part/.test(x)));
  assert.deepEqual(s.problems({ from: '/a', to: 'https://other.example:8443/x?y=1' }), []);
  assert.equal(safeLocation('//x'), '/x');
  assert.equal(safeLocation('/\\x'), '/x');
  assert.equal(safeLocation('/a\\b'), '/a%5Cb');
});

test('a captured value cannot turn a path redirect into an open redirect', () => {
  const s = set([{ from: '/go/*', to: '/:splat' }, { from: '^/jump/(.*)$', to: '/$1' }]);
  assert.equal(loc(s, '/go//evil.example/x'), '/evil.example/x');
  assert.equal(loc(s, '/go/%2F%2Fevil.example'), '/%2F%2Fevil.example', 'an encoded slash stays encoded, so it is just a path');
  assert.equal(loc(s, '/jump//evil.example'), '/evil.example');
  assert.equal(loc(s, '/jump/http://evil.example'), '/http:/evil.example', 'the repeated slash collapsed in the request, so this is a path too');
  assert.ok(!/^\/[/\\]/.test(loc(s, '/jump/%5Cevil.example') ?? ''));
});

test('query strings are kept, merged or dropped as the rule says', () => {
  const s = set([{ from: '/a', to: '/b' }, { from: '/c', to: '/d?x=1' }, { from: '/e', to: '/f', query: 'drop' }]);
  assert.equal(loc(s, '/a', '?utm=1&b=2'), '/b?utm=1&b=2');
  assert.equal(loc(s, '/a', 'utm=1'), '/b?utm=1');
  assert.equal(loc(s, '/c', 'y=2'), '/d?x=1&y=2');
  assert.equal(loc(s, '/e', 'y=2'), '/f');
  assert.equal(loc(s, '/a', 'bad value'), '/b', 'a query with spaces or control characters is not copied');
  assert.equal(loc(s, '/a', 'x\r\nSet-Cookie: a=b'), '/b');
});

test('status is chosen for the method; 410 has no location', () => {
  const s = set([{ from: '/a', to: '/b' }, { from: '/t', to: '/u', status: 302 }, { from: '/s', to: '/u', status: 303 }, { from: '/g', status: 410 }, { from: '/p', to: '/q', status: 308 }]);
  const st = (p: string, m: string) => s.match({ path: p, method: m }, { record: false })?.status;
  assert.equal(st('/a', 'GET'), 301);
  assert.equal(st('/a', 'HEAD'), 301);
  assert.equal(st('/a', 'POST'), 308);
  assert.equal(st('/t', 'put'), 307);
  assert.equal(st('/t', 'GET'), 302);
  assert.equal(st('/s', 'POST'), 303);
  assert.equal(st('/p', 'POST'), 308);
  const gone = s.match({ path: '/g' }, { record: false })!;
  assert.equal(gone.status, 410);
  assert.equal(gone.location, undefined);
});

test('priority, order, host and method conditions, and disabling', () => {
  const s = set([
    { id: 'late', from: '/x', to: '/late' },
    { id: 'early', from: '/x', to: '/early', priority: 10, hosts: ['Old.Example'] },
    { id: 'post', from: '/y', to: '/post', methods: ['post'] },
    { id: 'dis', from: '/z', to: '/z2', enabled: false },
  ]);
  assert.equal(s.match({ path: '/x', host: 'old.example' })?.rule.id, 'early');
  assert.equal(s.match({ path: '/x', host: 'other.example' })?.rule.id, 'late');
  assert.equal(s.match({ path: '/x' })?.rule.id, 'late');
  assert.equal(s.match({ path: '/y', method: 'GET' }), undefined);
  assert.equal(s.match({ path: '/y', method: 'POST' })?.rule.id, 'post');
  assert.equal(s.match({ path: '/z' }), undefined);
  s.setEnabled('dis', true);
  assert.equal(s.match({ path: '/z' })?.location, '/z2');
  assert.equal(s.remove('late'), true);
  assert.equal(s.match({ path: '/x', host: 'other.example' }), undefined);
});

test('loops, chains, self-redirects and shadowed rules are found', () => {
  const s = set([
    { id: 'a', from: '/a', to: '/b' },
    { id: 'b', from: '/b', to: '/a' },
    { id: 'c', from: '/c', to: '/d' },
    { id: 'd', from: '/d', to: '/e' },
    { id: 'e', from: '/e', to: '/final' },
    { id: 'self', from: '/self', to: '/SELF/' },
    { id: 'one', from: '/dup', to: '/1' },
    { id: 'two', from: '/dup', to: '/2' },
    { id: 'rx', from: '^/rx/(\\d+)$', to: '/n/$1' },
  ]);
  const r = s.check();
  assert.equal(r.loops.length, 2, 'the a-b cycle is reported once, and the self-redirect is a loop of one');
  assert.deepEqual([...r.loops.find((l) => l.id === 'a')!.cycle].sort(), ['/a', '/b']);
  assert.deepEqual(r.loops.find((l) => l.id === 'self')!.cycle, ['/self']);
  assert.deepEqual(r.selfRedirects, ['self']);
  assert.deepEqual(r.shadowed, [{ id: 'two', by: 'one' }]);
  const c = r.chains.find((x) => x.id === 'c')!;
  assert.deepEqual(c.hops, ['/c', '/d', '/e', '/final']);
  assert.equal(c.final, '/final');
  assert.deepEqual(r.skipped, ['rx'], 'a regex rule with no sample is skipped, not guessed');
  assert.equal(s.follow('/a').loop, true);
  assert.equal(s.follow('/a').status, 301);
});

test('a regex rule with a sample takes part in loop checks, and follow stops on long chains', () => {
  const s = set([{ id: 'x', from: '^/x/(\\d+)$', to: '/y/$1', sample: '/x/1' }, { id: 'y', from: '^/y/(\\d+)$', to: '/x/$1', sample: '/y/1' }]);
  assert.equal(s.check().loops.length, 1);
  const long = set(Array.from({ length: 30 }, (_, i) => ({ from: `/h${i}`, to: `/h${i + 1}` })), { maxHops: 5 });
  const f = long.follow('/h0');
  assert.equal(f.tooLong, true);
  assert.equal(f.hops.length, 6);
});

test('flatten rewrites static chains to their end and leaves loops alone', () => {
  const s = set([{ id: 'c', from: '/c', to: '/d' }, { id: 'd', from: '/d', to: '/final' }, { id: 'a', from: '/a', to: '/b' }, { id: 'b', from: '/b', to: '/a' }, { id: 'g', from: '/old', to: '/dead' }, { id: 'dead', from: '/dead', status: 410 }]);
  const flat = new Map(s.flatten().map((r) => [r.id, r]));
  assert.equal(flat.get('c')!.to, '/final');
  assert.equal(flat.get('d')!.to, '/final');
  assert.equal(flat.get('a')!.to, '/b');
  assert.equal(flat.get('g')!.status, 410);
  assert.equal(new RuleSet([...flat.values()]).check().chains.length, 0);
});

test('absolute destinations on our own hosts are followed in chains; others end the chain', () => {
  const s = set([{ from: '/a', to: 'https://www.me.example/b' }, { from: '/b', to: '/c' }, { from: '/ext', to: 'https://other.example/x' }], { ownHosts: ['www.me.example'] });
  assert.deepEqual(s.follow('/a').hops, ['/a', '/b', '/c'], 'an absolute URL on our own host is followed as a path');
  assert.equal(s.follow('/ext').final, 'https://other.example/x');
});

test('hits are counted per rule with the injected clock, and unused rules are found', () => {
  let t = 1_000_000;
  const s = set([{ id: 'a', from: '/a', to: '/x' }, { id: 'b', from: '/b', to: '/y' }, { id: 'c', from: '/c', to: '/z' }], { now: () => t });
  s.match({ path: '/a' });
  t += 5000;
  s.match({ path: '/a' });
  s.match({ path: '/b' });
  s.match({ path: '/nope' });
  s.match({ path: '/c' }, { record: false });
  assert.deepEqual(s.hits('a'), { count: 2, last: 1_005_000 });
  assert.equal(s.hits('c'), undefined);
  assert.deepEqual(s.stats().map((x) => [x.id, x.count]), [['a', 2], ['b', 1], ['c', 0]]);
  t += 10_000;
  s.match({ path: '/a' });
  assert.deepEqual(s.unused(8000), ['b', 'c'], 'b was last hit 10 s ago and c never; a was hit just now');
  assert.deepEqual(s.unused(60_000), ['c']);
  s.resetHits();
  assert.equal(s.hits('a'), undefined);
});

test('CSV parsing follows RFC 4180: quotes, doubled quotes, embedded newlines, CRLF, BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n"two\nlines",z\n'), [['a', 'b'], ['x,1', 'he said "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(parseCsv('a,,c\n,\n'), [['a', '', 'c'], ['', '']]);
  assert.deepEqual(parseCsv(''), []);
  assert.throws(() => parseCsv('a,"open'), CsvError);
  assert.throws(() => parseCsv('a,b"c'), CsvError);
  assert.throws(() => parseCsv('x\n'.repeat(10), { maxRows: 5 }), /rows/);
  assert.throws(() => parseCsv('x'.repeat(50), { maxField: 10 }), /longer/);
});

test('CSV import: header or none, defaults, kinds, and each bad row reported with its line', () => {
  const csv = ['from,to,status', '/a,/b', '/c,/d,302', '/gone,,', '/docs/*,/manual/:splat,', '^/p/(\\d+)$,/posts/$1,301', 'nope,/x', '/e,//evil.example', '/f,/g,abc', '/a,/again,301', '/h,javascript:alert(1)'].join('\n');
  const r = importCsv(csv);
  assert.deepEqual(r.rules.map((x) => [x.from, x.to, x.status]), [['/a', '/b', 301], ['/c', '/d', 302], ['/gone', undefined, 410], ['/docs/*', '/manual/:splat', 301], ['^/p/(\\d+)$', '/posts/$1', 301]]);
  assert.deepEqual(r.errors.map((e) => e.line), [7, 8, 9, 10, 11]);
  assert.match(r.errors[3]!.message, /appeared earlier/);
  const set2 = new RuleSet(r.rules);
  assert.equal(loc(set2, '/docs/x'), '/manual/x');
  const headless = importCsv('/a,/b\n/c,/d');
  assert.equal(headless.rules.length, 2);
  const cols = importCsv('status,destination,source\n308,/n,/o');
  assert.deepEqual(cols.rules, [{ from: '/o', to: '/n', status: 308 }]);
  assert.throws(() => importCsv('to,status\n/a,301'), /no from column/);
});

test('CSV export quotes properly and neutralises spreadsheet formulas', () => {
  const out = exportCsv([{ from: '/a,b', to: '/x"y', status: 301, kind: 'exact' }, { from: '=cmd|calc', to: '+1', status: 302, kind: 'exact' }]);
  assert.equal(out, 'from,to,status,kind\r\n"/a,b","/x""y",301,exact\r\n\'=cmd|calc,\'+1,302,exact\r\n');
  const back = parseCsv(out);
  assert.equal(back[1]![1], '/x"y');
});
