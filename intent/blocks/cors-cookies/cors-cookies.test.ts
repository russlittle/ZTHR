import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CookieError, CookieJar, Cors, CorsError, defaultPath, domainMatch, normalizeOrigin, parseCookieHeader, parseSetCookie, pathMatch, sameSite, serializeSetCookie } from './index.ts';

const policy = { origins: ['https://app.example.com', 'https://*.example.org', 'http://localhost:3000'], methods: ['PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Token'], exposedHeaders: ['X-Total'], credentials: true, maxAgeSec: 120 };
const pre = (origin: string, m: string, h?: string, extra: Record<string, string> = {}) => ({ method: 'OPTIONS', headers: { origin, 'access-control-request-method': m, ...(h ? { 'access-control-request-headers': h } : {}), ...extra } });

test('cors: a listed origin is echoed exactly, with credentials, exposed headers and Vary: Origin', () => {
  const r = new Cors(policy).check({ method: 'GET', headers: { origin: 'https://app.example.com' } });
  assert.equal(r.action, 'allow');
  assert.equal(r.headers['access-control-allow-origin'], 'https://app.example.com');
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
  assert.equal(r.headers['access-control-expose-headers'], 'X-Total');
  assert.equal(r.headers['vary'], 'Origin');
});

test('cors: unlisted origins, lookalikes and a different port or scheme get nothing', () => {
  const c = new Cors(policy);
  for (const o of ['https://evil.com', 'https://app.example.com.evil.com', 'http://app.example.com', 'https://app.example.com:8443', 'https://evilexample.org', 'not an origin', 'https://app.example.com/path']) {
    const r = c.check({ method: 'GET', headers: { origin: o } });
    assert.equal(r.action, 'deny', o);
    assert.equal(r.headers['access-control-allow-origin'], undefined, o);
  }
});

test('cors: wildcard subdomains match subdomains only, never the bare domain, and keep scheme and port', () => {
  const c = new Cors(policy);
  assert.equal(c.allows('https://a.example.org'), true);
  assert.equal(c.allows('https://a.b.example.org'), true);
  assert.equal(c.allows('https://example.org'), false);
  assert.equal(c.allows('http://a.example.org'), false);
  assert.equal(c.allows('https://a.example.org:444'), false);
  assert.equal(c.allows('HTTPS://APP.EXAMPLE.COM'), true, 'origins are compared normalised');
});

test('cors: the null origin is refused unless it is named', () => {
  assert.equal(new Cors(policy).check({ method: 'GET', headers: { origin: 'null' } }).action, 'deny');
  const named = new Cors({ origins: ['null'] });
  assert.equal(named.check({ method: 'GET', headers: { origin: 'null' } }).headers['access-control-allow-origin'], 'null');
});

test('cors: a request without Origin is not cross-origin, but the answer still varies on it', () => {
  const r = new Cors(policy).check({ method: 'GET', headers: {} });
  assert.equal(r.action, 'skip');
  assert.equal(r.headers['vary'], 'Origin');
  assert.deepEqual(new Cors({ origins: '*' }).check({ method: 'GET', headers: {} }).headers, {});
});

test('cors: a preflight answers 204 with methods, the asked headers, max-age and the Vary trio', () => {
  const r = new Cors(policy).check(pre('https://app.example.com', 'PUT', 'content-type, X-Token'));
  assert.equal(r.action, 'preflight');
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-methods'], 'GET, HEAD, POST, PUT, DELETE');
  assert.equal(r.headers['access-control-allow-headers'], 'content-type, x-token');
  assert.equal(r.headers['access-control-max-age'], '120');
  assert.equal(r.headers['vary'], 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
});

test('cors: a preflight is refused for a method or header the policy does not name', () => {
  const c = new Cors(policy);
  const bad = c.check(pre('https://app.example.com', 'PATCH'));
  assert.equal(bad.action, 'deny');
  assert.equal(bad.status, 403);
  assert.match(bad.reason, /PATCH/);
  assert.match(c.check(pre('https://app.example.com', 'PUT', 'x-secret')).reason, /x-secret/);
  assert.equal(c.check(pre('https://app.example.com', 'PUT', 'bad header!')).action, 'deny');
  assert.equal(c.check(pre('https://evil.com', 'PUT')).status, 403);
  const plain = c.check({ method: 'OPTIONS', headers: { origin: 'https://app.example.com' } });
  assert.equal(plain.action, 'deny', 'an OPTIONS without a requested method is an ordinary request, and OPTIONS is not allowed');
  assert.match(plain.reason, /OPTIONS/);
});

test("cors: '*' answers '*', cannot carry credentials, and never covers Authorization", () => {
  assert.throws(() => new Cors({ origins: '*', credentials: true }), /list the origins/);
  assert.throws(() => new Cors({ origins: ['https://a.com'], allowedHeaders: '*', credentials: true }), /cannot be combined/);
  const c = new Cors({ origins: '*', allowedHeaders: '*' });
  const r = c.check(pre('https://anywhere.dev', 'GET', 'x-anything'));
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal(r.headers['access-control-allow-credentials'], undefined);
  assert.equal(c.check(pre('https://anywhere.dev', 'GET', 'authorization')).action, 'deny');
});

test('cors: Private Network Access preflights need an explicit yes', () => {
  const asked = pre('https://app.example.com', 'GET', undefined, { 'access-control-request-private-network': 'true' });
  assert.equal(new Cors(policy).check(asked).action, 'deny');
  const r = new Cors({ ...policy, allowPrivateNetwork: true }).check(asked);
  assert.equal(r.headers['access-control-allow-private-network'], 'true');
});

test('cors: bad policies are refused when built', () => {
  assert.throws(() => new Cors({ origins: ['https://*'] }), CorsError);
  assert.throws(() => new Cors({ origins: ['https://a.*.com'] }), /first label/);
  assert.throws(() => new Cors({ origins: ['https://a.com/path'] }), /more than scheme/);
  assert.throws(() => new Cors({ origins: ['ftp://a.com'] }), /http or https/);
  assert.throws(() => new Cors({ origins: ['https://a.com'], methods: ['BAD METHOD'] }), /not a method/);
  assert.equal(normalizeOrigin('https://A.com:443'), 'https://a.com');
});

const NOW = Date.UTC(2026, 0, 1);

test('cookies: a full Set-Cookie parses to every attribute, Max-Age beating Expires', () => {
  const c = parseSetCookie('sid=abc123; Path=/app; Domain=.Example.COM; Max-Age=3600; Expires=Wed, 01 Jan 2020 00:00:00 GMT; Secure; HttpOnly; SameSite=lax; Partitioned', NOW, true);
  assert.deepEqual(c, { name: 'sid', value: 'abc123', domain: 'example.com', path: '/app', expires: NOW + 3_600_000, secure: true, httpOnly: true, sameSite: 'Lax', partitioned: true });
});

test('cookies: lifetimes are capped at 400 days and unknown attributes are ignored', () => {
  const c = parseSetCookie(`a=b; Max-Age=${10 * 365 * 86400}; Whatever=1; SameSite=bogus`, NOW);
  assert.equal(c.expires, NOW + 400 * 86_400_000);
  assert.equal(c.sameSite, undefined);
});

test('cookies: hostile names, values and headers are refused', () => {
  assert.throws(() => parseSetCookie('a b=c', NOW), /not a valid cookie name/);
  assert.throws(() => parseSetCookie('a=b c', NOW), /spaces/);
  assert.throws(() => parseSetCookie('=b', NOW), /needs a name/);
  assert.throws(() => parseSetCookie('novalue', NOW), /joined by/);
  assert.throws(() => parseSetCookie('a=b\r\nSet-Cookie: x=y', NOW), /control characters/);
  assert.throws(() => parseSetCookie(`a=${'x'.repeat(5000)}`, NOW), /at most 4096/);
  assert.throws(() => serializeSetCookie({ name: 'a', value: 'b;c', secure: false, httpOnly: false, partitioned: false }, NOW), CookieError);
  assert.throws(() => serializeSetCookie({ name: 'a', value: 'b', path: '/x; Domain=evil', secure: false, httpOnly: false, partitioned: false }, NOW), /Path/);
});

test('cookies: SameSite=None needs Secure; __Secure- and __Host- prefixes carry their conditions', () => {
  assert.throws(() => parseSetCookie('a=b; SameSite=None', NOW), /requires Secure/);
  assert.equal(parseSetCookie('a=b; SameSite=None; Secure', NOW).sameSite, 'None');
  assert.throws(() => parseSetCookie('__Secure-a=b', NOW), /__Secure-/);
  assert.throws(() => parseSetCookie('__Secure-a=b; Secure', NOW, false), /over https/);
  assert.equal(parseSetCookie('__Secure-a=b; Secure', NOW, true).name, '__Secure-a');
  assert.throws(() => parseSetCookie('__Host-a=b; Secure; Path=/; Domain=example.com', NOW), /cannot have a Domain/);
  assert.throws(() => parseSetCookie('__Host-a=b; Secure; Path=/x', NOW), /Path=\//);
  assert.throws(() => parseSetCookie('__host-a=b; Secure', NOW), /Path=\//, 'prefixes match without regard to case');
  assert.equal(parseSetCookie('__Host-a=b; Secure; Path=/', NOW, true).path, '/');
});

test('cookies: serialising round-trips through parsing, and the Cookie header parses in order', () => {
  const c = { name: 'sid', value: 'x', path: '/', expires: NOW + 60_000, secure: true, httpOnly: true, sameSite: 'Strict' as const, partitioned: false };
  const text = serializeSetCookie(c, NOW);
  assert.equal(text, 'sid=x; Expires=Thu, 01 Jan 2026 00:01:00 GMT; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Strict');
  assert.deepEqual(parseSetCookie(text, NOW, true), c);
  assert.deepEqual(parseCookieHeader('a=1; b="two"; junk; =x; c d=3; e='), [{ name: 'a', value: '1' }, { name: 'b', value: 'two' }, { name: 'e', value: '' }]);
});

test('cookies: domain-match, path-match and default path follow RFC 6265', () => {
  assert.equal(domainMatch('a.example.com', 'example.com'), true);
  assert.equal(domainMatch('badexample.com', 'example.com'), false);
  assert.equal(domainMatch('10.0.0.1', '0.0.1'), false, 'an IP address matches only itself');
  assert.equal(pathMatch('/a/b', '/a'), true);
  assert.equal(pathMatch('/ab', '/a'), false);
  assert.equal(pathMatch('/a/b', '/a/'), true);
  assert.equal(defaultPath('/a/b/c'), '/a/b');
  assert.equal(defaultPath('/a'), '/');
  assert.equal(defaultPath('x'), '/');
});

const jar = (t = { now: NOW }) => ({ t, j: new CookieJar({ now: () => t.now }) });
const at = (url: string, same = true, nav = false) => ({ url, sameSite: same, topLevelNavigation: nav });

test('jar: host-only versus domain cookies, paths, and Secure only over https', () => {
  const { j } = jar();
  assert.equal(j.setFromHeader('h=1', at('https://www.example.com/x/y')).stored, true);
  assert.equal(j.setFromHeader('d=2; Domain=example.com; Path=/', at('https://www.example.com/')).stored, true);
  assert.equal(j.setFromHeader('s=3; Secure; Path=/', at('https://www.example.com/')).stored, true);
  assert.equal(j.cookieHeader(at('https://www.example.com/x/y/z')), 'h=1; d=2; s=3', 'longer path first, then oldest');
  assert.equal(j.cookieHeader(at('https://api.example.com/')), 'd=2', 'host-only stays home, domain cookies travel');
  assert.equal(j.cookieHeader(at('http://www.example.com/')), 'd=2', 'Secure is not sent over http');
  assert.equal(j.cookieHeader(at('https://www.example.com/other')), 'd=2; s=3');
});

test('jar: domain rules refuse other sites, public suffixes and Secure from plain http', () => {
  const { j } = jar();
  assert.match((j.setFromHeader('a=1; Domain=evil.com', at('https://www.example.com/')) as { reason: string }).reason, /does not cover/);
  assert.match((j.setFromHeader('a=1; Domain=com', at('https://example.com/')) as { reason: string }).reason, /public suffix/);
  assert.match((j.setFromHeader('a=1; Secure', at('http://example.com/')) as { reason: string }).reason, /plain http/);
  assert.equal(j.size, 0);
  assert.equal(new CookieJar({ now: () => NOW, isPublicSuffix: (d) => d === 'co.uk' || !d.includes('.') }).setFromHeader('a=1; Domain=co.uk', at('https://x.co.uk/')).stored, false);
});

test('jar: plain http cannot overwrite a Secure cookie; https can', () => {
  const { j } = jar();
  j.setFromHeader('t=good; Secure; Path=/', at('https://example.com/'));
  assert.equal(j.setFromHeader('t=bad; Path=/', at('http://example.com/')).stored, false);
  assert.equal(j.cookieHeader(at('https://example.com/')), 't=good');
  j.setFromHeader('t=better; Secure; Path=/', at('https://example.com/'));
  assert.equal(j.cookieHeader(at('https://example.com/')), 't=better');
});

test('jar: expiry and deletion by Max-Age=0 or a past Expires', () => {
  const { t, j } = jar();
  j.setFromHeader('a=1; Max-Age=60', at('https://example.com/'));
  j.setFromHeader('b=2', at('https://example.com/'));
  assert.equal(j.cookieHeader(at('https://example.com/')), 'a=1; b=2');
  t.now += 61_000;
  assert.equal(j.cookieHeader(at('https://example.com/')), 'b=2');
  assert.equal(j.size, 1, 'the expired cookie is dropped');
  j.setFromHeader('b=gone; Max-Age=0', at('https://example.com/'));
  assert.equal(j.cookieHeader(at('https://example.com/')), undefined);
  j.setFromHeader('c=3', at('https://example.com/'));
  j.setFromHeader('c=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', at('https://example.com/'));
  assert.equal(j.size, 0);
});

test('jar: SameSite decides what cross-site requests carry, and Lax is the default', () => {
  const { j } = jar();
  for (const [n, a] of [['strict', 'SameSite=Strict'], ['lax', 'SameSite=Lax'], ['default', ''], ['none', 'SameSite=None; Secure']] as const) j.setFromHeader(`${n}=1; ${a}`, at('https://example.com/'));
  assert.equal(j.cookieHeader(at('https://example.com/', true)), 'strict=1; lax=1; default=1; none=1');
  assert.equal(j.cookieHeader(at('https://example.com/', false)), 'none=1', 'a cross-site subrequest carries only SameSite=None');
  assert.equal(j.cookieHeader(at('https://example.com/', false, true)), 'lax=1; default=1; none=1', 'a top-level navigation also carries Lax');
});

test('jar: a cross-site response may only set SameSite=None cookies', () => {
  const { j } = jar();
  assert.equal(j.setFromHeader('a=1; SameSite=Lax', at('https://tracker.example/', false)).stored, false);
  assert.equal(j.setFromHeader('a=1', at('https://tracker.example/', false)).stored, false, 'Lax by default');
  assert.equal(j.setFromHeader('a=1; SameSite=None; Secure', at('https://tracker.example/', false)).stored, true);
});

test('jar: bounded per domain and in total, dropping the least recently used', () => {
  const small = new CookieJar({ now: () => NOW, maxPerDomain: 2, maxTotal: 3 });
  for (const n of ['a', 'b']) small.setFromHeader(`${n}=1`, at('https://one.test/'));
  small.cookieHeader(at('https://one.test/'));
  small.setFromHeader('c=1', at('https://one.test/'));
  assert.equal(small.size, 2);
  assert.equal(small.cookieHeader(at('https://one.test/')), 'b=1; c=1', 'a, the least recently used, was dropped');
  for (const d of ['two', 'three', 'four']) small.setFromHeader('x=1', at(`https://${d}.test/`));
  assert.equal(small.size, 3);
});

test('same-site: scheme and registrable domain, with an injectable suffix rule', () => {
  assert.equal(sameSite('https://a.example.com/', 'https://b.example.com/x'), true);
  assert.equal(sameSite('https://a.example.com/', 'http://a.example.com/'), false);
  assert.equal(sameSite('https://example.com/', 'https://example.org/'), false);
  assert.equal(sameSite('https://a.github.io/', 'https://b.github.io/'), true, 'the default has no suffix list');
  assert.equal(sameSite('https://a.github.io/', 'https://b.github.io/', (h) => h), false, 'with one, each is its own site');
});
