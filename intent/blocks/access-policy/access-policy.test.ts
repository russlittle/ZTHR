import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessPolicy, AccessPolicyError, DecisionLog, checkRegex, clientIp, inCidr, normalizeHost, normalizePath } from './index.ts';
import type { AccessRequest, Config, Subject } from './index.ts';

const cfg: Config = {
  networks: { office: ['203.0.113.0/24', '2001:db8:1::/48'] },
  rules: [
    { id: 'public', domain: 'www.example.com', path: '/public/*', policy: 'bypass' },
    { id: 'health', path: '/healthz', methods: ['GET'], policy: 'bypass' },
    { id: 'admin-from-office', domain: 'admin.example.com', networks: ['office'], subject: [['group:admins'], ['user:root']], policy: 'two_factor', maxAgeSec: 3600 },
    { id: 'admin-closed', domain: 'admin.example.com', policy: 'deny' },
    { id: 'app-read', domain: 'app.example.com', path: ['/api/*', '/static/*'], methods: ['GET', 'HEAD'], policy: 'one_factor' },
    { id: 'app-write', domain: 'app.example.com', path: '/api/*', methods: ['POST', 'PUT', 'DELETE'], policy: 'two_factor' },
    { id: 'reports', domain: '*.example.com', pathRegex: '/reports/[0-9]{4}/[a-z-]+', policy: 'one_factor' },
  ],
  domains: [{ domain: '*.example.com', policy: 'one_factor' }, { domain: 'locked.example.net', policy: 'deny' }],
  defaultPolicy: 'deny',
};
const engine = new AccessPolicy(cfg);
const NOW = 1_800_000_000_000;
const alice = (over: Partial<Subject> = {}): Subject => ({ user: 'alice', groups: ['staff'], level: 'one_factor', authenticatedAt: NOW - 60_000, ...over });
const req = (host: string, path: string, over: Partial<AccessRequest> = {}): AccessRequest => ({ host, path, method: 'GET', remoteIp: '198.51.100.9', subject: null, ...over });
const decide = (r: AccessRequest) => engine.decide(r, NOW);

test('a bypass rule lets an anonymous request through, and the decision names the rule and says why', () => {
  const d = decide(req('www.example.com', '/public/logo.png'));
  assert.equal(d.action, 'allow');
  assert.equal(d.policy, 'bypass');
  assert.equal(d.required, 'none');
  assert.equal(d.rule, 'public');
  assert.deepEqual(d.reasons, ['matched public', 'policy is bypass: no sign-in needed']);
  assert.equal(decide(req('www.example.com', '/public')).rule, 'public', '"/public/*" also covers "/public" itself');
  assert.equal(decide(req('www.example.com', '/publicity')).rule, 'domain-default');
});

test('paths are normalised before matching, so traversal cannot ride a bypass rule', () => {
  for (const path of ['/public/../admin', '/public/%2e%2e/admin', '/public/./../x', '/public//../private', '/%70ublic/../private']) {
    const d = decide(req('www.example.com', path));
    assert.notEqual(d.rule, 'public', path);
    assert.equal(d.action, 'authenticate', path);
  }
  assert.equal(decide(req('www.example.com', '/public/a/../b.png')).rule, 'public', 'a dot-dot that stays inside is fine');
  assert.equal(decide(req('www.example.com', '//public///x?token=1#f')).rule, 'public');
});

test('paths that cannot be matched safely are refused outright', () => {
  for (const path of ['/public/..%2fadmin', '/public/%2Fadmin', '/public\\..\\admin', '/public/%5cadmin', '/public/%00', '/public/\u0000', '/public/%zz', '/public/%2', '/public/%252fadmin', '/public/a\nb', 'public/x', `/${'a'.repeat(5000)}`]) {
    const d = decide(req('www.example.com', path));
    assert.equal(d.action, 'deny', JSON.stringify(path));
    assert.equal(d.rule, 'invalid-request');
  }
  assert.equal(decide(req('bad host', '/x')).rule, 'invalid-request');
  assert.equal(decide(req('a..b', '/x')).rule, 'invalid-request');
});

test('normalisation of paths and hosts, in detail', () => {
  assert.equal(normalizePath('/a//b/./c/../d/?q=1#x'), '/a/b/d/');
  assert.equal(normalizePath('/a//b/./c/../d?q=1#x'), '/a/b/d');
  assert.equal(normalizePath('/a/b/'), '/a/b/', 'a trailing slash is kept');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('/../../x'), '/x', 'cannot climb above the root');
  assert.equal(normalizePath('/caf%C3%A9'), '/café');
  assert.equal(normalizePath('/a%20b'), '/a b');
  assert.equal(normalizePath('/100%25'), '/100%');
  assert.equal(normalizePath('/x%e0'), null, 'invalid UTF-8');
  assert.equal(normalizeHost('WWW.Example.COM:8443'), 'www.example.com');
  assert.equal(normalizeHost('www.example.com.'), 'www.example.com');
  assert.equal(normalizeHost('[2001:db8::1]:443'), '[2001:db8::1]');
  for (const bad of ['', 'a b', 'evil.com@good.com', 'x/y', '.example.com', 'ex ample.com', 'a?b']) assert.throws(() => normalizeHost(bad), AccessPolicyError, bad);
});

test('hosts: wildcards cover subdomains but never the bare domain, ports and case do not matter', () => {
  assert.equal(decide(req('WWW.EXAMPLE.COM:443', '/public/x')).rule, 'public');
  assert.equal(decide(req('a.b.example.com', '/other')).rule, 'domain-default');
  assert.equal(decide(req('example.com', '/other')).rule, 'default', 'the apex is not under *.example.com');
  assert.equal(decide(req('badexample.com', '/other')).rule, 'default');
  assert.equal(decide(req('locked.example.net', '/x', { subject: alice({ level: 'two_factor' }) })).action, 'deny');
});

test('rules are tried in order and the first match wins', () => {
  const e = new AccessPolicy({ rules: [{ id: 'first', path: '/x/*', policy: 'deny' }, { id: 'second', path: '/x/*', policy: 'bypass' }, { id: 'broad', policy: 'bypass' }] });
  assert.equal(e.decide(req('h.example', '/x/y'), NOW).rule, 'first');
  assert.equal(e.decide(req('h.example', '/x/y'), NOW).action, 'deny');
  assert.equal(e.decide(req('h.example', '/z'), NOW).rule, 'broad');
  assert.equal(new AccessPolicy({ rules: [] }).decide(req('h.example', '/z'), NOW).rule, 'default', 'with nothing configured, deny');
  assert.equal(new AccessPolicy({ rules: [], defaultPolicy: 'one_factor' }).decide(req('h.example', '/z'), NOW).action, 'authenticate');
});

test('authentication levels: sign in, step up, or allow', () => {
  const read = (s: Subject | null) => decide(req('app.example.com', '/api/items', { subject: s }));
  assert.deepEqual([read(null).action, read(null).required], ['authenticate', 'one_factor']);
  assert.equal(read({ user: 'x', level: 'none' }).action, 'authenticate');
  assert.equal(read(alice()).action, 'allow');
  assert.equal(read(alice({ level: 'two_factor' })).action, 'allow', 'a stronger sign-in satisfies a weaker rule');
  const write = (s: Subject | null) => decide(req('app.example.com', '/api/items', { method: 'POST', subject: s }));
  assert.equal(write(null).action, 'authenticate');
  const up = write(alice());
  assert.equal(up.action, 'step-up');
  assert.equal(up.rule, 'app-write');
  assert.match(up.reasons.join(' '), /signed in at one_factor but two_factor is needed/);
  assert.equal(write(alice({ level: 'two_factor' })).action, 'allow');
});

test('methods are matched case-insensitively on the request and exactly on the rule', () => {
  assert.equal(decide(req('app.example.com', '/api/x', { method: 'get', subject: alice() })).rule, 'app-read');
  assert.equal(decide(req('app.example.com', '/api/x', { method: 'PATCH', subject: alice() })).rule, 'domain-default', 'PATCH is in neither rule');
  assert.equal(decide(req('any.example.org', '/healthz')).rule, 'health');
  assert.equal(decide(req('any.example.org', '/healthz', { method: 'POST' })).rule, 'default');
  assert.throws(() => new AccessPolicy({ rules: [{ methods: ['get'], policy: 'deny' }] }), /not a method/);
});

test('networks: named lists, CIDR blocks and IPv6; an unknown client address never matches a network rule', () => {
  const admin = (ip: string | undefined, s: Subject | null) => decide(req('admin.example.com', '/', { ...(ip ? { remoteIp: ip } : { remoteIp: undefined as never }), subject: s }));
  const boss = alice({ groups: ['admins'], level: 'two_factor' });
  assert.equal(admin('203.0.113.77', boss).action, 'allow');
  assert.equal(admin('203.0.113.77', boss).rule, 'admin-from-office');
  assert.equal(admin('2001:db8:1::5', boss).rule, 'admin-from-office');
  assert.equal(admin('198.51.100.1', boss).action, 'deny', 'right person, wrong place');
  assert.equal(admin('198.51.100.1', boss).rule, 'admin-closed');
  assert.equal(admin(undefined, boss).rule, 'admin-closed');
  assert.equal(inCidr('203.0.113.255', '203.0.113.0/24'), true);
  assert.equal(inCidr('203.0.114.0', '203.0.113.0/24'), false);
  assert.equal(inCidr('1.2.3.4', 'garbage'), false);
});

test('subject rules: anonymous callers are sent to sign in, then the rule is applied to who they are', () => {
  const at = (s: Subject | null) => decide(req('admin.example.com', '/x', { remoteIp: '203.0.113.5', subject: s }));
  const anon = at(null);
  assert.equal(anon.action, 'authenticate');
  assert.equal(anon.rule, 'admin-from-office');
  assert.match(anon.reasons[0]!, /depends on who the caller is/);
  assert.equal(at(alice({ groups: ['staff'] })).rule, 'admin-closed', 'not an admin: falls through to the next rule');
  assert.equal(at(alice({ groups: ['staff'] })).action, 'deny');
  assert.equal(at(alice({ user: 'root', groups: [], level: 'two_factor' })).action, 'allow', 'the other alternative: user root');
  assert.equal(at(alice({ groups: ['admins'] })).action, 'step-up', 'admins need a second factor');
  assert.equal(decide(req('admin.example.com', '/x', { remoteIp: '198.51.100.1' })).action, 'deny', 'anonymous but outside the network: no subject question is even asked');
});

test('a sign-in older than maxAgeSec must be repeated', () => {
  const boss = (age: number) => alice({ groups: ['admins'], level: 'two_factor', authenticatedAt: NOW - age });
  const at = (s: Subject) => decide(req('admin.example.com', '/x', { remoteIp: '203.0.113.5', subject: s }));
  assert.equal(at(boss(3_599_000)).action, 'allow');
  assert.equal(at(boss(3_601_000)).action, 'authenticate');
  assert.match(at(boss(3_601_000)).reasons.join(' '), /older than 3600 seconds/);
  const missing = at({ user: 'a', groups: ['admins'], level: 'two_factor' });
  assert.equal(missing.action, 'authenticate', 'no sign-in time recorded counts as stale');
});

test('domain defaults and the global default apply when no rule does', () => {
  const d = decide(req('wiki.example.com', '/anything', { subject: alice() }));
  assert.deepEqual([d.rule, d.action, d.policy], ['domain-default', 'allow', 'one_factor']);
  assert.equal(decide(req('wiki.example.com', '/anything')).action, 'authenticate');
  const g = decide(req('unknown.test', '/anything', { subject: alice({ level: 'two_factor' }) }));
  assert.deepEqual([g.rule, g.action], ['default', 'deny'], 'unlisted hosts are denied even to a strongly signed-in person');
});

test('regular expressions on paths match the whole path, and dangerous ones are refused when the policy is built', () => {
  assert.equal(decide(req('x.example.com', '/reports/2024/q-one', { subject: alice() })).rule, 'reports');
  assert.equal(decide(req('x.example.com', '/reports/2024/q-one/extra')).rule, 'domain-default', 'anchored at both ends');
  assert.equal(decide(req('x.example.com', '/reports/24/q')).rule, 'domain-default');
  for (const bad of ['(a+)+$', '(.*)*x', '(a+|b)*c', '(?=x)y', '(x)\\1', 'a'.repeat(201), '([a-z]+){2,}', '((a*))+']) assert.throws(() => checkRegex(bad), AccessPolicyError, bad);
  for (const ok of ['/user/[0-9]+/files', '/a(b|c)d', '/[a-z]+(-[a-z]+)?', '(\\+)x', '[(]+']) assert.doesNotThrow(() => checkRegex(ok), ok);
  assert.throws(() => checkRegex('(unclosed'), /not a valid regular expression/);
  const started = Date.now();
  const e = new AccessPolicy({ rules: [{ pathRegex: '/[a-z]+(/[a-z]+)?', policy: 'bypass' }] });
  e.decide(req('h.example', `/${'a'.repeat(2000)}!`), NOW);
  assert.ok(Date.now() - started < 1000);
});

test('the client address comes from X-Forwarded-For only through proxies you trust', () => {
  const trusted = ['10.0.0.0/8', 'fd00::/8'];
  assert.equal(clientIp('198.51.100.7', '10.0.0.5', trusted), '198.51.100.7');
  assert.equal(clientIp('1.1.1.1, 198.51.100.7, 10.0.0.9', '10.0.0.5', trusted), '198.51.100.7', 'what the client wrote on the left is ignored');
  assert.equal(clientIp('10.0.0.1, 198.51.100.7', '10.0.0.5', trusted), '198.51.100.7', 'a spoofed internal address is behind the real one');
  assert.equal(clientIp('1.1.1.1', '198.51.100.99', trusted), '198.51.100.99', 'an untrusted connection cannot set the header at all');
  assert.equal(clientIp('not-an-ip, 10.0.0.1', '10.0.0.5', trusted), '10.0.0.5', 'garbage falls back to the connecting address');
  assert.equal(clientIp(undefined, '10.0.0.5', trusted), '10.0.0.5');
  assert.equal(clientIp('2001:db8::9, fd00::2', 'fd00::1', trusted), '2001:db8::9');
});

test('explain lists every rule with the first reason it did not match', () => {
  const t = engine.explain(req('app.example.com', '/api/x', { method: 'POST', subject: alice() }));
  assert.deepEqual(t.map((x) => [x.rule, x.matched, x.why]), [
    ['public', false, 'domain did not match'],
    ['health', false, 'path did not match'],
    ['admin-from-office', false, 'domain did not match'],
    ['admin-closed', false, 'domain did not match'],
    ['app-read', false, 'method did not match'],
    ['app-write', true, 'matched'],
    ['reports', false, 'path did not match'],
  ]);
  assert.deepEqual(engine.explain(req('bad host', '/')), []);
});

test('the decision log is bounded, newest first, filterable, and never records a query string', () => {
  const log = new DecisionLog(3);
  for (const [path, subject] of [['/public/a?token=SECRET', null], ['/api/b?x=1', alice()], ['/nope', null], ['/api/c', alice()]] as const) log.record(decide(req(path.startsWith('/public') ? 'www.example.com' : 'app.example.com', path, { subject })));
  assert.equal(log.size, 3);
  const all = log.recent();
  assert.deepEqual(all.map((e) => e.path), ['/api/c', '/nope', '/api/b']);
  assert.ok(!JSON.stringify(all).includes('SECRET') && !JSON.stringify(all).includes('x=1'));
  assert.deepEqual(log.recent(10, { user: 'alice' }).map((e) => e.path), ['/api/c', '/api/b']);
  assert.deepEqual(log.recent(10, { action: 'authenticate' }).map((e) => e.path), ['/nope']);
  assert.equal(log.recent(1)[0]!.at, NOW);
  assert.deepEqual(Object.keys(all[0]!).sort(), ['action', 'at', 'host', 'method', 'path', 'reasons', 'remoteIp', 'rule', 'user']);
  assert.throws(() => new DecisionLog(0), /at least one/);
});

test('bad configurations are refused when the policy is built', () => {
  const bad = (rules: Config['rules'], re: RegExp, networks?: Config['networks']) => assert.throws(() => new AccessPolicy({ rules, ...(networks ? { networks } : {}) }), re);
  bad([{ id: 'a', policy: 'deny' }, { id: 'a', policy: 'deny' }], /two rules are called "a"/);
  bad([{ policy: 'allow' as never }], /not a policy/);
  bad([{ policy: 'bypass', subject: [['user:x']] }], /cannot depend on who/);
  bad([{ policy: 'deny', maxAgeSec: 5 }], /only applies to one_factor and two_factor/);
  bad([{ policy: 'one_factor', maxAgeSec: 0 }], /must be positive/);
  bad([{ path: 'relative', policy: 'deny' }], /must start with "\/"/);
  bad([{ domain: 'a b', policy: 'deny' }], /not a domain pattern/);
  bad([{ networks: ['nowhere'], policy: 'deny' }], /not a network/);
  bad([{ subject: [['everyone']], policy: 'one_factor' }], /must be "user:name" or "group:name"/);
  bad([{ policy: 'deny' }], /not an address/, { office: ['not-an-ip'] });
});
