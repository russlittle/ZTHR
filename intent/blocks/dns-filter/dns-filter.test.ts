import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode, makeQuery } from '../dns-wire/index.ts';
import { DnsFilter, FilterError, QueryLog, RuleSet, normalizeName, parseList } from './index.ts';

const T0 = Date.UTC(2026, 10, 28, 12, 0, 0);

const hosts = `# a hosts file
127.0.0.1 localhost
::1 localhost ip6-localhost
0.0.0.0 ads.example.com tracker.example.net   # two names on a line
0.0.0.0 ADS2.Example.COM
192.168.1.5 nas.home
not-an-ip evil.example
0.0.0.0
`;

test('a hosts file gives exact names, skips local names, and reports bad lines by number', () => {
  const p = parseList(hosts, 'hosts');
  assert.deepEqual(p.entries.map((e) => `${e.kind}:${e.value}`), ['exact:ads.example.com', 'exact:tracker.example.net', 'exact:ads2.example.com']);
  assert.equal(p.skipped, 1, 'the line pointing nas.home at a real address is an override, not a block');
  assert.deepEqual(p.errors.map((e) => e.line), [7, 8]);
  assert.match(p.errors[0]!.message, /not an address/);
});

test('plain domain lists: suffix, *.subdomains, globs and regexes; bad ones are reported', () => {
  const p = parseList('example.com\n*.cdn.example.org\nads*.example.net\n/^track[0-9]+\\./\n/(a+)+/\n*\nbad..name\n', 'domains');
  assert.deepEqual(p.entries.map((e) => `${e.kind}:${e.value}`), ['suffix:example.com', 'subdomains:cdn.example.org', 'glob:ads*.example.net', 'regex:^track[0-9]+\\.']);
  assert.deepEqual(p.errors.map((e) => [e.line, e.message.slice(0, 18)]), [[5, 'a regex with a nes'], [6, 'a pattern of only '], [7, '"bad..name" is not']]);
});

test('adblock domain rules: ||domain^, exceptions, and cosmetic lines ignored', () => {
  const p = parseList('[Adblock Plus 2.0]\n! comment\n||ads.example.com^\n@@||ok.ads.example.com^\n||t.example.net^$third-party\nexample.com##.banner\n', 'adblock');
  assert.deepEqual(p.entries.map((e) => `${e.action}:${e.value}`), ['block:ads.example.com', 'allow:ok.ads.example.com', 'block:t.example.net']);
  assert.deepEqual(p.errors, []);
});

test('the suffix trie matches a domain and everything under it, never a look-alike', () => {
  const r = new RuleSet();
  r.add({ action: 'block', kind: 'suffix', value: 'example.com', list: 'l' });
  r.add({ action: 'block', kind: 'exact', value: 'exact.test', list: 'l' });
  r.add({ action: 'block', kind: 'subdomains', value: 'cdn.test', list: 'l' });
  assert.equal(r.matches('example.com').length, 1);
  assert.equal(r.matches('a.b.example.com').length, 1);
  assert.equal(r.matches('badexample.com').length, 0);
  assert.equal(r.matches('example.com.evil.net').length, 0);
  assert.equal(r.matches('exact.test').length, 1);
  assert.equal(r.matches('sub.exact.test').length, 0, 'an exact rule stops at the name');
  assert.equal(r.matches('cdn.test').length, 0, '*.cdn.test does not cover cdn.test itself');
  assert.equal(r.matches('x.cdn.test').length, 1);
  assert.equal(r.size, 3);
});

test('names are normalised: case, trailing dot, and names that cannot be DNS names are refused', () => {
  assert.equal(normalizeName('ADS.Example.COM.'), 'ads.example.com');
  assert.throws(() => normalizeName('a..b'), FilterError);
  assert.throws(() => normalizeName(`${'a'.repeat(64)}.com`), /not a DNS name/);
});

function filter(mode: 'null-ip' | 'nxdomain' | 'refused' = 'null-ip') {
  const f = new DnsFilter({ mode, ttl: 5 });
  f.loadList('ads', 'ads.example.com\n*.tracker.net\n/^cam[0-9]+\\.example\\.org$/\n', 'domains');
  f.loadList('adult', 'adult.example.org\n', 'domains');
  f.loadList('mine', 'ok.ads.example.com\n', 'domains', 'allow');
  f.defineGroup('default', { lists: ['ads', 'mine'] });
  f.defineGroup('kids', { lists: ['ads', 'adult', 'mine'] });
  f.defineGroup('lab', { lists: [], enabled: false });
  f.assignClients('10.0.5.0/24', ['kids']);
  f.assignClients('10.0.5.77', ['lab']);
  return f;
}

test('per-client groups: kids get the extra list, an exact address beats its range, others get default', () => {
  const f = filter();
  assert.equal(f.decide('10.0.5.9', 'adult.example.org', T0).action, 'block');
  assert.equal(f.decide('10.0.9.9', 'adult.example.org', T0).action, 'pass');
  assert.equal(f.decide('10.0.5.77', 'ads.example.com', T0).action, 'pass', 'the lab host is not filtered');
  assert.deepEqual(f.groupsFor('10.0.5.77'), ['lab']);
  assert.deepEqual(f.groupsFor('192.0.2.1'), ['default']);
  assert.deepEqual(f.groupsFor('2001:db8::1'), ['default']);
  f.assignClients('2001:db8::/32', ['kids']);
  assert.deepEqual(f.groupsFor('2001:db8::1'), ['kids']);
  assert.deepEqual(f.groupsFor('2001:db9::1'), ['default']);
});

test('an allow-list entry beats a block entry, and says which rule', () => {
  const f = filter();
  assert.equal(f.decide('10.0.9.9', 'ads.example.com', T0).entry?.list, 'ads');
  const v = f.decide('10.0.9.9', 'ok.ads.example.com', T0);
  assert.equal(v.action, 'allow');
  assert.equal(v.entry?.list, 'mine');
  assert.equal(f.decide('10.0.9.9', 'regular.example.com', T0).action, 'pass');
  assert.equal(f.decide('10.0.9.9', 'cam12.example.org', T0).entry?.kind, 'regex');
  assert.equal(f.decide('10.0.9.9', 'cam.example.org', T0).action, 'pass');
});

test('block answers by mode: null address for A and AAAA, empty NOERROR for other types, NXDOMAIN, REFUSED', () => {
  const a = filter().answer(makeQuery('ads.example.com', 'A', { id: 7 }), '10.0.9.9', T0).response!;
  assert.equal(a.rcode, 0);
  assert.deepEqual(a.answers.map((r) => r.data), [{ type: 'A', address: '0.0.0.0' }]);
  assert.equal(a.answers[0]!.ttl, 5);
  assert.equal(a.id, 7);
  assert.equal(a.qr, true);
  const aaaa = filter().answer(makeQuery('ads.example.com', 'AAAA', { id: 8 }), '10.0.9.9', T0).response!;
  assert.deepEqual(aaaa.answers.map((r) => r.data), [{ type: 'AAAA', address: '::' }]);
  const mx = filter().answer(makeQuery('ads.example.com', 'MX', { id: 9 }), '10.0.9.9', T0).response!;
  assert.equal(mx.rcode, 0);
  assert.equal(mx.answers.length, 0);
  assert.equal(filter('nxdomain').answer(makeQuery('ads.example.com', 'A', { id: 1 }), '10.0.9.9', T0).response!.rcode, 3);
  assert.equal(filter('refused').answer(makeQuery('ads.example.com', 'A', { id: 1 }), '10.0.9.9', T0).response!.rcode, 5);
  assert.equal(filter().answer(makeQuery('fine.example.com', 'A', { id: 1 }), '10.0.9.9', T0).response, undefined, 'forward upstream');
});

test('answerBytes works on wire packets and the block answer decodes back', () => {
  const f = filter();
  const r = f.answerBytes(encode(makeQuery('x.tracker.net', 'A', { id: 4242 })), '10.0.9.9', T0);
  assert.equal(r.verdict.action, 'block');
  const back = decode(r.response!);
  assert.equal(back.id, 4242);
  assert.equal(back.answers[0]!.data.type, 'A');
  assert.throws(() => f.answerBytes(new Uint8Array([1, 2, 3]), '10.0.9.9', T0));
});

test('CNAME cloaking: a clean name that points at a blocked one is blocked', () => {
  const f = filter();
  const q = makeQuery('www.shop.example', 'A', { id: 3 });
  const up = { ...q, qr: true, answers: [
    { name: 'www.shop.example', ttl: 60, cls: 1, data: { type: 'CNAME' as const, target: 'edge.tracker.net' } },
    { name: 'edge.tracker.net', ttl: 60, cls: 1, data: { type: 'A' as const, address: '203.0.113.9' } },
  ] };
  const r = f.inspectResponse(q, up, '10.0.9.9', T0);
  assert.equal(r.verdict.action, 'block');
  assert.equal(r.response.answers[0]!.data.type, 'A');
  assert.equal(r.response.answers[0]!.name, 'www.shop.example');
  const clean = f.inspectResponse(q, { ...up, answers: [{ name: 'www.shop.example', ttl: 60, cls: 1, data: { type: 'CNAME' as const, target: 'edge.fine.net' } }] }, '10.0.9.9', T0);
  assert.equal(clean.verdict.action, 'pass');
});

test('snoozing a client pauses filtering until the time, then it resumes', () => {
  const f = filter();
  f.snooze('10.0.9.9', T0 + 60_000);
  assert.equal(f.decide('10.0.9.9', 'ads.example.com', T0 + 59_999).action, 'pass');
  assert.equal(f.decide('10.0.9.9', 'ads.example.com', T0 + 60_000).action, 'block');
  f.snooze('10.0.9.9', T0 + 1e9);
  f.snooze('10.0.9.9', undefined);
  assert.equal(f.decide('10.0.9.9', 'ads.example.com', T0).action, 'block');
});

test('reloading a list replaces its rules; unknown groups and lists are refused', () => {
  const f = filter();
  assert.equal(f.rules.size, 5);
  f.loadList('ads', 'new.example.com\n', 'domains');
  assert.equal(f.decide('10.0.9.9', 'ads.example.com', T0).action, 'pass');
  assert.equal(f.decide('10.0.9.9', 'new.example.com', T0).action, 'block');
  assert.equal(f.rules.size, 3);
  assert.throws(() => f.defineGroup('g', { lists: ['nope'] }), /not loaded/);
  assert.throws(() => f.assignClients('10.0.0.0/8', ['nope']), /no group nope/);
  assert.throws(() => f.assignClients('10.0.0.0/33', ['kids']), /valid range/);
  assert.throws(() => f.decide('not-an-ip', 'a.com', T0), /not an address/);
});

test('the query log sums up: totals, tops, per-client blocks, types and an hourly timeline', () => {
  const f = filter();
  const q = (name: string, type: string, client: string, at: number) => f.answer(makeQuery(name, type, { id: 1 }), client, at);
  q('ads.example.com', 'A', '10.0.9.9', T0);
  q('ads.example.com', 'AAAA', '10.0.9.9', T0 + 1000);
  q('x.tracker.net', 'A', '10.0.9.8', T0 + 2000);
  q('fine.example.com', 'A', '10.0.9.9', T0 + 3000);
  q('ok.ads.example.com', 'A', '10.0.9.9', T0 + 3_700_000);
  const s = f.log.summarize({ bucketMs: 3_600_000 });
  assert.equal(s.total, 5);
  assert.equal(s.blocked, 3);
  assert.equal(s.allowed, 1);
  assert.equal(s.passed, 1);
  assert.equal(s.blockedRatio, 0.6);
  assert.deepEqual(s.topBlocked, [{ name: 'ads.example.com', count: 2 }, { name: 'x.tracker.net', count: 1 }]);
  assert.deepEqual(s.topClients[0], { client: '10.0.9.9', count: 4, blocked: 2 });
  assert.deepEqual(s.byType, { A: 4, AAAA: 1 });
  assert.deepEqual(s.timeline.map((t) => [t.total, t.blocked]), [[4, 3], [1, 0]]);
  assert.equal(f.log.summarize({ from: T0 + 3_600_000 }).total, 1);
  assert.equal(new QueryLog().summarize().blockedRatio, 0);
});

test('the log is bounded, and a malformed query is refused', () => {
  const log = new QueryLog(3);
  for (let i = 0; i < 5; i++) log.add({ time: i, client: 'c', name: `n${i}`, type: 'A', action: 'pass', rule: undefined, list: undefined });
  assert.deepEqual(log.rows().map((r) => r.name), ['n2', 'n3', 'n4']);
  assert.throws(() => new QueryLog(0), FilterError);
  const f = filter();
  assert.throws(() => f.answer({ ...makeQuery('a.com', 'A', { id: 1 }), questions: [] }, '10.0.9.9', T0), /one question/);
  assert.throws(() => f.answer({ ...makeQuery('a.com', 'A', { id: 1 }), qr: true }, '10.0.9.9', T0), /one question/);
});

test('a hundred thousand rules still match in one walk', () => {
  const f = new DnsFilter();
  const text = Array.from({ length: 100_000 }, (_, i) => `0.0.0.0 h${i}.bulk.example`).join('\n');
  const p = f.loadList('bulk', text, 'hosts');
  assert.equal(p.entries.length, 100_000);
  f.defineGroup('default', { lists: ['bulk'] });
  assert.equal(f.decide('10.0.0.1', 'h99999.bulk.example', T0).action, 'block');
  assert.equal(f.decide('10.0.0.1', 'h100000.bulk.example', T0).action, 'pass');
});
