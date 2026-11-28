import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addVary, contentRange, etagFor, evaluatePreconditions, formatCacheControl, formatETag, formatHttpDate, freshness, header, ifRangeHolds, mergeNotModified, multipartBody, multipartLength,
  notModifiedHeaders, parseCacheControl, parseETag, parseETagList, parseHttpDate, parseRange, parseVary, respond, revalidationHeaders, storable, strongMatch, varyKey, varyMatches, weakMatch,
} from './index.ts';

const T = Date.UTC(1994, 10, 6, 8, 49, 37);

test('the three HTTP date forms of RFC 9110 all read as the same instant; only one form is written', () => {
  assert.equal(parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT'), T);
  assert.equal(parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT', Date.UTC(2026, 0, 1)), T);
  assert.equal(parseHttpDate('Sun Nov  6 08:49:37 1994'), T);
  assert.equal(formatHttpDate(T), 'Sun, 06 Nov 1994 08:49:37 GMT');
  assert.equal(parseHttpDate(formatHttpDate(Date.UTC(2026, 10, 28, 1, 2, 3))), Date.UTC(2026, 10, 28, 1, 2, 3));
  for (const bad of ['', 'yesterday', 'Sun, 31 Feb 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 25:49:37 GMT', 'Sun, 06 Nov 1994 08:49:37 PST', '1994-11-06T08:49:37Z', 'Sun, 6 Nov 1994 08:49:37 GMT'])
    assert.equal(parseHttpDate(bad), null, bad);
});

test('a two-digit year is the century within fifty years of now', () => {
  const now = Date.UTC(2026, 5, 1);
  assert.equal(new Date(parseHttpDate('Monday, 01-Jan-70 00:00:00 GMT', now)!).getUTCFullYear(), 2070);
  assert.equal(new Date(parseHttpDate('Friday, 01-Jan-77 00:00:00 GMT', now)!).getUTCFullYear(), 1977);
  assert.equal(new Date(parseHttpDate('Tuesday, 01-Jan-30 00:00:00 GMT', now)!).getUTCFullYear(), 2030);
});

test('entity tag comparison follows the table in RFC 9110 section 8.8.3.2', () => {
  const t = (s: string) => parseETag(s)!;
  const rows: [string, string, boolean, boolean][] = [
    ['W/"1"', 'W/"1"', false, true],
    ['W/"1"', 'W/"2"', false, false],
    ['W/"1"', '"1"', false, true],
    ['"1"', '"1"', true, true],
  ];
  for (const [a, b, strong, weak] of rows) {
    assert.equal(strongMatch(t(a), t(b)), strong, `${a} ${b} strong`);
    assert.equal(weakMatch(t(a), t(b)), weak, `${a} ${b} weak`);
  }
});

test('entity tags and lists parse strictly', () => {
  assert.deepEqual(parseETag('W/"abc"'), { weak: true, value: 'abc' });
  assert.deepEqual(parseETag('""'), { weak: false, value: '' });
  for (const bad of ['abc', '"a"b"', 'w/"a"', '"a b"', "'a'", '', 'W/']) assert.equal(parseETag(bad), null, bad);
  assert.deepEqual(parseETagList('"a", W/"b,c" ,"d"'), [{ weak: false, value: 'a' }, { weak: true, value: 'b,c' }, { weak: false, value: 'd' }], 'a comma inside a tag is part of it');
  assert.equal(parseETagList('*'), '*');
  assert.equal(parseETagList('"a" "b"'), null);
  assert.equal(parseETagList('"a",'), null);
  assert.equal(parseETagList('a'), null);
  assert.equal(formatETag({ weak: true, value: 'x' }), 'W/"x"');
  assert.throws(() => formatETag({ weak: false, value: 'a"b' }), TypeError);
  const e = etagFor('hello');
  assert.match(e, /^"[A-Za-z0-9_-]{27}"$/);
  assert.equal(e, etagFor('hello'));
  assert.notEqual(e, etagFor('hellp'));
  assert.equal(etagFor(new TextEncoder().encode('hello')), e);
  assert.ok(etagFor('x', { weak: true }).startsWith('W/"'));
});

const res = { etag: '"v2"', lastModified: Date.UTC(2026, 0, 10, 12, 0, 0) };
const eq = (req: Record<string, string>, method = 'GET', cur: { etag?: string; lastModified?: number; exists?: boolean } = res) => evaluatePreconditions(method, req, cur, Date.UTC(2026, 5, 1));

test('If-None-Match: a match is 304 for a read and 412 for a write; weak comparison is used', () => {
  assert.deepEqual(eq({ 'if-none-match': '"v2"' }), { status: 304, decidedBy: 'if-none-match', ignored: [] });
  assert.equal(eq({ 'if-none-match': 'W/"v2"' }).status, 304, 'weak comparison for If-None-Match');
  assert.equal(eq({ 'if-none-match': '"v1", "v2"' }).status, 304);
  assert.equal(eq({ 'if-none-match': '"v1"' }).status, 200);
  assert.equal(eq({ 'if-none-match': '"v2"' }, 'PUT').status, 412);
  assert.equal(eq({ 'if-none-match': '*' }, 'PUT').status, 412, 'create-only: it exists, so refused');
  assert.equal(eq({ 'if-none-match': '*' }, 'PUT', { ...res, exists: false }).status, 200, 'create-only: it does not exist, so go ahead');
  assert.equal(eq({ 'if-none-match': '"v2"' }, 'HEAD').status, 304);
});

test('If-Match: strong comparison, star, and a missing resource', () => {
  assert.equal(eq({ 'if-match': '"v2"' }, 'PUT').status, 200);
  assert.deepEqual(eq({ 'if-match': '"v1"' }, 'PUT'), { status: 412, decidedBy: 'if-match', ignored: [] });
  assert.equal(eq({ 'if-match': 'W/"v2"' }, 'PUT').status, 412, 'a weak tag never matches strongly');
  assert.equal(eq({ 'if-match': '*' }, 'PUT').status, 200);
  assert.equal(eq({ 'if-match': '*' }, 'PUT', { ...res, exists: false }).status, 412);
  assert.equal(eq({ 'if-match': '"v2"' }, 'PUT', { lastModified: res.lastModified }).status, 412, 'a resource with no tag cannot satisfy If-Match');
  assert.equal(eq({ 'if-match': '"v2"', 'if-none-match': '"v2"' }).decidedBy, 'if-none-match', 'If-Match passes, then If-None-Match decides');
});

test('If-Modified-Since and If-Unmodified-Since compare whole seconds; bad dates are ignored', () => {
  const same = formatHttpDate(res.lastModified);
  assert.equal(eq({ 'if-modified-since': same }).status, 304);
  assert.equal(eq({ 'if-modified-since': formatHttpDate(res.lastModified - 1000) }).status, 200);
  assert.equal(eq({ 'if-modified-since': formatHttpDate(res.lastModified + 86_400_000) }).status, 304);
  assert.equal(evaluatePreconditions('GET', { 'if-modified-since': same }, { lastModified: res.lastModified + 999 }, 0).status, 304, 'sub-second differences do not count');
  assert.equal(eq({ 'if-modified-since': same }, 'POST').status, 200, 'only for GET and HEAD');
  assert.deepEqual(eq({ 'if-modified-since': 'last tuesday' }), { status: 200, ignored: ['if-modified-since'] });
  assert.equal(eq({ 'if-unmodified-since': formatHttpDate(res.lastModified - 1000) }, 'PUT').status, 412);
  assert.equal(eq({ 'if-unmodified-since': same }, 'PUT').status, 200);
  assert.equal(eq({ 'if-unmodified-since': 'nonsense' }, 'PUT').ignored[0], 'if-unmodified-since');
  assert.equal(eq({ 'if-modified-since': same, 'if-none-match': '"other"' }).status, 200, 'If-None-Match present: If-Modified-Since is not consulted');
  assert.equal(eq({ 'if-unmodified-since': formatHttpDate(res.lastModified - 1000), 'if-match': '"v2"' }, 'PUT').status, 200, 'If-Match present: If-Unmodified-Since is not consulted');
  assert.equal(eq({ 'if-none-match': 'garbage' }).ignored[0], 'if-none-match');
});

test('a 304 carries what a 304 must and nothing about the body; revalidation headers come from the stored response', () => {
  const full = { 'Content-Type': 'text/html', 'Content-Length': '999', ETag: '"v2"', 'Cache-Control': 'max-age=60', Vary: 'accept-encoding', Date: 'Sun, 06 Nov 1994 08:49:37 GMT', 'Content-Location': '/x', 'Set-Cookie': 'a=b' };
  assert.deepEqual(notModifiedHeaders(full), { 'cache-control': 'max-age=60', 'content-location': '/x', date: 'Sun, 06 Nov 1994 08:49:37 GMT', etag: '"v2"', vary: 'accept-encoding' });
  assert.deepEqual(revalidationHeaders({ ETag: '"v2"', 'Last-Modified': 'Sun, 06 Nov 1994 08:49:37 GMT' }), { 'if-none-match': '"v2"', 'if-modified-since': 'Sun, 06 Nov 1994 08:49:37 GMT' });
  assert.deepEqual(revalidationHeaders({ ETag: 'broken', 'Last-Modified': 'nope' }), {});
  const merged = mergeNotModified({ 'Content-Type': 'text/html', 'Content-Length': '10', 'Cache-Control': 'max-age=1', ETag: '"a"' }, { 'cache-control': 'max-age=600', 'content-length': '0', etag: '"a"' });
  assert.deepEqual(merged, { 'content-type': 'text/html', 'content-length': '10', 'cache-control': 'max-age=600', etag: '"a"' });
  assert.equal(header({ 'X-A': ['1', '2'] }, 'x-a'), '1, 2');
});

test('Cache-Control parses quoted values, duplicates, bad numbers and extensions', () => {
  const c = parseCacheControl('Max-Age=60, s-maxage="120", no-cache="set-cookie, x-a", private, must-revalidate, immutable, stale-while-revalidate=30, community="UCI", max-age=30');
  assert.equal(c.maxAge, 30, 'duplicates take the smaller');
  assert.equal(c.sMaxAge, 120);
  assert.deepEqual(c.noCache, ['set-cookie', 'x-a']);
  assert.equal(c.private, true);
  assert.equal(c.mustRevalidate, true);
  assert.equal(c.immutable, true);
  assert.equal(c.staleWhileRevalidate, 30);
  assert.deepEqual(c.extensions, { community: 'UCI' });
  assert.deepEqual(parseCacheControl('max-age=abc, s-maxage=-5, max-age=').invalid, ['max-age', 's-maxage', 'max-age']);
  assert.equal(parseCacheControl('max-age=99999999999999').maxAge, 2_147_483_648, 'huge values are capped');
  assert.deepEqual(parseCacheControl(undefined).invalid, []);
  assert.equal(parseCacheControl('no-store').noStore, true);
  assert.equal(parseCacheControl('x="a,b", public').public, true, 'a comma in quotes does not split');
});

test('Cache-Control is written in a fixed order and refuses bad numbers', () => {
  assert.equal(formatCacheControl({ public: true, maxAge: 3600, sMaxAge: 7200, mustRevalidate: true, immutable: true, staleWhileRevalidate: 60 }), 'public, max-age=3600, s-maxage=7200, must-revalidate, immutable, stale-while-revalidate=60');
  assert.equal(formatCacheControl({ noStore: true }), 'no-store');
  assert.throws(() => formatCacheControl({ maxAge: -1 }), TypeError);
  assert.throws(() => formatCacheControl({ maxAge: 1.5 }), TypeError);
});

const HOUR = 3_600_000;
const fresh = (response: Record<string, string>, o: Partial<Parameters<typeof freshness>[0]> = {}) =>
  freshness({ response, shared: false, requestTime: 0, responseTime: 0, now: 0, ...o });

test('freshness: max-age, s-maxage for shared caches, Expires, and the age header', () => {
  assert.deepEqual({ f: fresh({ 'cache-control': 'max-age=60' }, { now: 59_000 }).fresh, a: fresh({ 'cache-control': 'max-age=60' }, { now: 59_000 }).ageSeconds }, { f: true, a: 59 });
  assert.equal(fresh({ 'cache-control': 'max-age=60' }, { now: 60_000 }).fresh, false);
  assert.equal(fresh({ 'cache-control': 'max-age=60, s-maxage=600' }, { now: 120_000, shared: true }).fresh, true);
  assert.equal(fresh({ 'cache-control': 'max-age=60, s-maxage=600' }, { now: 120_000 }).fresh, false, 's-maxage is for shared caches only');
  assert.equal(fresh({ 'cache-control': 'max-age=60', age: '50' }, { now: 5_000 }).fresh, true);
  assert.equal(fresh({ 'cache-control': 'max-age=60', age: '50' }, { now: 11_000 }).fresh, false, 'the Age header counts');
  const date = 'Sun, 06 Nov 1994 08:49:37 GMT';
  const base = T;
  assert.equal(fresh({ date, expires: 'Sun, 06 Nov 1994 09:49:37 GMT' }, { requestTime: base, responseTime: base, now: base + 59 * 60_000 }).fresh, true);
  assert.equal(fresh({ date, expires: 'Sun, 06 Nov 1994 09:49:37 GMT' }, { requestTime: base, responseTime: base, now: base + HOUR }).fresh, false);
  assert.equal(fresh({ date, expires: '0' }, { requestTime: base, responseTime: base, now: base }).fresh, false, 'an unreadable Expires is already expired');
  assert.equal(fresh({ 'cache-control': 'max-age=60, expires', date, expires: 'Mon, 07 Nov 1994 00:00:00 GMT' }, { requestTime: base, responseTime: base, now: base + 120_000 }).fresh, false, 'max-age beats Expires');
});

test('freshness: the age calculation of RFC 9111 corrects for a slow response and a skewed Date', () => {
  const f = freshness({ response: { 'cache-control': 'max-age=100', date: formatHttpDate(1_000_000_000_000 - 40_000) }, shared: false, requestTime: 1_000_000_000_000 - 3_000, responseTime: 1_000_000_000_000, now: 1_000_000_000_000 + 10_000 });
  assert.equal(f.ageSeconds, 50, 'apparent age 40 s (Date is 40 s behind the arrival) plus 10 s resident');
  assert.equal(f.lifetimeSeconds, 100);
  assert.equal(f.fresh, true);
});

test('freshness: no-cache, bad numbers and missing information are stale; heuristic freshness is a tenth of the age, capped', () => {
  assert.equal(fresh({ 'cache-control': 'no-cache, max-age=600' }, { now: 1000 }).fresh, false);
  assert.match(fresh({ 'cache-control': 'no-cache' }).reason, /no-cache/);
  assert.equal(fresh({ 'cache-control': 'max-age=soon' }, { now: 1000 }).fresh, false);
  assert.equal(fresh({}, { now: 1000 }).fresh, false);
  const date = formatHttpDate(T);
  const lm = formatHttpDate(T - 10 * 86_400_000);
  const h = fresh({ date, 'last-modified': lm }, { requestTime: T, responseTime: T, now: T + 3 * HOUR });
  assert.deepEqual({ heuristic: h.heuristic, life: h.lifetimeSeconds, fresh: h.fresh }, { heuristic: true, life: 86_400, fresh: true }, 'ten days old: a tenth is a day, which is also the cap');
  const young = fresh({ date, 'last-modified': formatHttpDate(T - 1000_000) }, { requestTime: T, responseTime: T, now: T });
  assert.equal(young.lifetimeSeconds, 100);
  assert.equal(fresh({ date, 'last-modified': lm }, { requestTime: T, responseTime: T, now: T, heuristicCapSeconds: 600 }).lifetimeSeconds, 600);
});

test('stale-while-revalidate and stale-if-error allowances, and must-revalidate that forbids them', () => {
  const r = { 'cache-control': 'max-age=10, stale-while-revalidate=20, stale-if-error=100' };
  const a = fresh(r, { now: 25_000 });
  assert.deepEqual({ fresh: a.fresh, stale: a.staleBySeconds, swr: a.serveWhileRevalidating, sie: a.serveIfError }, { fresh: false, stale: 15, swr: true, sie: true });
  const b = fresh(r, { now: 45_000 });
  assert.deepEqual({ swr: b.serveWhileRevalidating, sie: b.serveIfError }, { swr: false, sie: true });
  const c = fresh({ 'cache-control': `${r['cache-control']}, must-revalidate` }, { now: 25_000 });
  assert.deepEqual({ swr: c.serveWhileRevalidating, sie: c.serveIfError, must: c.mustRevalidate }, { swr: false, sie: false, must: true });
  const d = fresh({ 'cache-control': `${r['cache-control']}, proxy-revalidate` }, { now: 25_000, shared: true });
  assert.equal(d.serveWhileRevalidating, false, 'proxy-revalidate binds shared caches');
  assert.equal(fresh({ 'cache-control': `${r['cache-control']}, proxy-revalidate` }, { now: 25_000 }).serveWhileRevalidating, true);
});

test('what may be stored: no-store, private in shared caches, authorised requests, status codes', () => {
  const ok = (status: number, headers: Record<string, string>, extra = {}) => storable({ method: 'GET', status, response: headers, shared: true, ...extra });
  assert.equal(ok(200, {}).ok, true);
  assert.match(ok(200, { 'cache-control': 'no-store' }).reason, /no-store/);
  assert.equal(ok(200, { 'cache-control': 'private' }).ok, false);
  assert.equal(storable({ method: 'GET', status: 200, response: { 'cache-control': 'private' }, shared: false }).ok, true);
  assert.equal(ok(200, {}, { requestHadAuthorization: true }).ok, false);
  assert.equal(ok(200, { 'cache-control': 'public' }, { requestHadAuthorization: true }).ok, true);
  assert.equal(ok(200, { 'cache-control': 's-maxage=60' }, { requestHadAuthorization: true }).ok, true);
  assert.equal(ok(500, {}).ok, false);
  assert.equal(ok(500, { 'cache-control': 'max-age=5' }).ok, true, 'explicit freshness allows an unusual status');
  assert.equal(ok(404, {}).ok, true);
  assert.equal(ok(206, { 'cache-control': 'max-age=5' }).ok, false);
  assert.equal(ok(200, { vary: '*' }).ok, false);
  assert.equal(storable({ method: 'POST', status: 200, response: {}, shared: false }).ok, false);
});

test('Vary: the key is made from the named request headers, normalised; star never matches', () => {
  assert.deepEqual(parseVary('Accept-Encoding, accept-language , ACCEPT-ENCODING'), ['accept-encoding', 'accept-language']);
  assert.equal(parseVary('X, *'), '*');
  assert.equal(varyKey('*', {}), null);
  assert.equal(varyKey('accept-encoding', { 'Accept-Encoding': 'gzip, br' }), varyKey('Accept-Encoding', { 'accept-encoding': 'br,gzip' }), 'order and spacing do not matter');
  assert.notEqual(varyKey('accept-encoding', { 'accept-encoding': 'gzip' }), varyKey('accept-encoding', { 'accept-encoding': 'br' }));
  assert.equal(varyKey('accept-encoding', { 'accept-encoding': 'gzip ; q=0.5' }), varyKey('accept-encoding', { 'accept-encoding': 'gzip;q=0.5' }));
  assert.equal(varyKey('x-tenant', {}), 'x-tenant=', 'a missing header is a value too');
  assert.equal(varyMatches('x-tenant', { 'x-tenant': 'a' }, { 'x-tenant': 'a' }), true);
  assert.equal(varyMatches('x-tenant', { 'x-tenant': 'a' }, { 'x-tenant': 'b' }), false);
  assert.equal(varyMatches('x-tenant', {}, {}), true, 'both lacking it match');
  assert.equal(varyMatches('*', {}, {}), false);
  assert.equal(varyKey('', { a: 'b' }), '', 'no Vary: one key for everyone');
  assert.equal(addVary(undefined, 'accept-encoding'), 'Accept-Encoding');
  assert.equal(addVary('Accept-Language', 'Accept-Encoding'), 'Accept-Encoding, Accept-Language');
  assert.equal(addVary('accept-encoding', 'Accept-Encoding'), 'Accept-Encoding');
  assert.equal(addVary('accept-encoding', '*'), '*');
});

test('byte ranges: the examples of RFC 9110 section 14.1.2 for a 10000-byte resource', () => {
  const r = (v: string) => parseRange(v, 10_000);
  assert.deepEqual(r('bytes=0-499'), { kind: 'ranges', ranges: [{ start: 0, end: 499 }] });
  assert.deepEqual(r('bytes=500-999'), { kind: 'ranges', ranges: [{ start: 500, end: 999 }] });
  assert.deepEqual(r('bytes=-500'), { kind: 'ranges', ranges: [{ start: 9500, end: 9999 }] });
  assert.deepEqual(r('bytes=9500-'), { kind: 'ranges', ranges: [{ start: 9500, end: 9999 }] });
  assert.deepEqual(r('bytes=0-0,-1'), { kind: 'ranges', ranges: [{ start: 0, end: 0 }, { start: 9999, end: 9999 }] });
  assert.deepEqual(r('bytes=500-600,601-999'), { kind: 'ranges', ranges: [{ start: 500, end: 999 }] }, 'adjacent ranges are joined');
  assert.deepEqual(r('bytes=500-700,601-999'), { kind: 'ranges', ranges: [{ start: 500, end: 999 }] }, 'overlapping ranges are joined');
  assert.deepEqual(r('bytes=9990-20000'), { kind: 'ranges', ranges: [{ start: 9990, end: 9999 }] }, 'an end past the size is cut to it');
  assert.deepEqual(r('bytes=-20000'), { kind: 'ranges', ranges: [{ start: 0, end: 9999 }] }, 'a suffix longer than the resource is all of it');
  assert.deepEqual(r('BYTES = 0-1'), { kind: 'ranges', ranges: [{ start: 0, end: 1 }] });
});

test('unsatisfiable and unusable Range headers', () => {
  assert.deepEqual(parseRange('bytes=10000-', 10_000), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-0', 10_000), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=0-5', 0), { kind: 'unsatisfiable' }, 'nothing to satisfy in an empty resource');
  assert.deepEqual(parseRange('bytes=0-5,20000-', 10_000), { kind: 'ranges', ranges: [{ start: 0, end: 5 }] }, 'the satisfiable ones are served');
  for (const bad of ['items=0-5', 'bytes=', 'bytes=5-1', 'bytes=a-b', 'bytes=-', 'bytes=1-2-3', 'bytes=0-5;x', 'bytes=1e3-2e3'])
    assert.equal(parseRange(bad, 10_000).kind, 'ignore', bad);
  assert.equal(parseRange(undefined, 1).kind, 'ignore');
  assert.equal(parseRange(`bytes=${Array.from({ length: 40 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',')}`, 10_000).kind, 'ignore', 'a great many ranges is not honoured');
  assert.equal(parseRange(`bytes=${Array.from({ length: 9 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',')}`, 10_000).kind, 'ignore', 'more than eight separate ranges is not honoured');
  const overlap = parseRange(`bytes=${Array.from({ length: 30 }, () => '0-9999').join(',')}`, 10_000);
  assert.deepEqual(overlap, { kind: 'ranges', ranges: [{ start: 0, end: 9999 }] }, 'a flood of overlapping ranges collapses to one');
});

test('If-Range applies the Range only to the representation the client has', () => {
  const cur = { etag: '"v2"', lastModified: Date.UTC(2026, 0, 10, 12) };
  assert.equal(ifRangeHolds(undefined, cur), true);
  assert.equal(ifRangeHolds('"v2"', cur), true);
  assert.equal(ifRangeHolds('"v1"', cur), false);
  assert.equal(ifRangeHolds('W/"v2"', cur), false, 'weak tags never');
  assert.equal(ifRangeHolds('W/"v2"', { ...cur, etag: 'W/"v2"' }), false);
  assert.equal(ifRangeHolds(formatHttpDate(cur.lastModified), cur), true);
  assert.equal(ifRangeHolds(formatHttpDate(cur.lastModified - 1000), cur), false, 'a date must be exactly the Last-Modified');
  assert.equal(ifRangeHolds('garbage', cur), false);
  assert.equal(ifRangeHolds('"v2"', { lastModified: 1 }), false);
});

const doc = { size: 10_000, contentType: 'video/mp4', etag: '"v2"', lastModified: Date.UTC(2026, 0, 10, 12), cacheControl: 'max-age=60', vary: 'Accept-Encoding' };

test('respond: a plain GET, a HEAD, a 304, a 412', () => {
  const full = respond('GET', {}, doc);
  assert.deepEqual({ s: full.status, r: full.ranges, len: full.contentLength }, { s: 200, r: null, len: 10_000 });
  assert.deepEqual(full.headers, { etag: '"v2"', 'last-modified': 'Sat, 10 Jan 2026 12:00:00 GMT', 'cache-control': 'max-age=60', vary: 'Accept-Encoding', 'accept-ranges': 'bytes', 'content-type': 'video/mp4', 'content-length': '10000' });
  const nm = respond('GET', { 'if-none-match': '"v2"' }, doc);
  assert.deepEqual({ s: nm.status, len: nm.contentLength }, { s: 304, len: null });
  assert.equal(nm.headers['content-type'], undefined);
  assert.equal(nm.headers['etag'], '"v2"');
  assert.equal(respond('PUT', { 'if-match': '"v1"' }, doc).status, 412);
  assert.equal(respond('PUT', {}, doc).status, 200);
  assert.equal(respond('POST', { range: 'bytes=0-1' }, doc).ranges, null, 'ranges are for reads');
});

test('respond: a single range is 206 with Content-Range; a range for the whole resource is just 200', () => {
  const r = respond('GET', { range: 'bytes=500-999' }, doc);
  assert.deepEqual({ s: r.status, ranges: r.ranges, len: r.contentLength }, { s: 206, ranges: [{ start: 500, end: 999 }], len: 500 });
  assert.equal(r.headers['content-range'], 'bytes 500-999/10000');
  assert.equal(r.headers['content-length'], '500');
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.equal(respond('GET', { range: 'bytes=0-' }, doc).status, 200);
  assert.equal(respond('GET', { range: 'bytes=0-9999' }, doc).status, 200);
  assert.equal(contentRange({ start: 0, end: 4 }, 10), 'bytes 0-4/10');
});

test('respond: unsatisfiable is 416 with bytes */size; a bad header and a stale If-Range send the whole thing', () => {
  const u = respond('GET', { range: 'bytes=20000-' }, doc);
  assert.deepEqual({ s: u.status, cr: u.headers['content-range'], len: u.contentLength }, { s: 416, cr: 'bytes */10000', len: null });
  assert.equal(respond('GET', { range: 'lines=1-2' }, doc).status, 200);
  assert.equal(respond('GET', { range: 'bytes=0-9', 'if-range': '"v1"' }, doc).status, 200, 'the client has an older version: send all of it');
  assert.equal(respond('GET', { range: 'bytes=0-9', 'if-range': '"v2"' }, doc).status, 206);
  assert.equal(respond('GET', { range: 'bytes=0-9', 'if-none-match': '"v2"' }, doc).status, 304, 'preconditions come before ranges');
});

test('respond: several ranges become multipart/byteranges whose length is exact', () => {
  const r = respond('GET', { range: 'bytes=0-4,10-14' }, { ...doc, size: 20, contentType: 'text/plain' }, { boundary: 'BB' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-type'], 'multipart/byteranges; boundary=BB');
  assert.equal(r.boundary, 'BB');
  const data = Uint8Array.from({ length: 20 }, (_, i) => 65 + i);
  const body = multipartBody(r.ranges!, 20, 'text/plain', 'BB', (s, e) => data.slice(s, e + 1));
  assert.equal(body.length, r.contentLength);
  assert.equal(multipartLength(r.ranges!, 20, 'text/plain', 'BB'), body.length);
  assert.equal(new TextDecoder().decode(body), '--BB\r\nContent-Type: text/plain\r\nContent-Range: bytes 0-4/20\r\n\r\nABCDE\r\n--BB\r\nContent-Type: text/plain\r\nContent-Range: bytes 10-14/20\r\n\r\nKLMNO\r\n--BB--\r\n');
});
