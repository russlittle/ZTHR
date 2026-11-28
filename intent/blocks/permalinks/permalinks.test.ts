import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CannotBuild, InvalidPattern, Permalinks } from './index.ts';
import type { RouteDef } from './index.ts';

const routes: RouteDef[] = [
  { name: 'home', pattern: '/', query: { type: 'home' }, paginate: true },
  { name: 'post', pattern: '/:year<year>/:month<month>/:slug<slug>', query: { type: 'post', year: ':year', month: ':month', slug: ':slug' } },
  { name: 'archive', pattern: '/:year<year>/:month<month>', query: { type: 'archive', year: ':year', month: ':month' }, paginate: true },
  { name: 'category', pattern: '/category/:path<slug>*', query: { type: 'category', path: ':path' }, paginate: true },
  { name: 'page', pattern: '/:slug<slug>', query: { type: 'page', slug: ':slug' } },
  { name: 'user', pattern: '/u/:id<int>', query: { type: 'user', id: ':id' } },
  { name: 'search', pattern: '/search/:term?', query: { type: 'search', term: ':term' } },
];
const pl = (slash: 'always' | 'never' = 'always') => new Permalinks(routes, { trailingSlash: slash });

test('a path becomes a route, typed parameters and the content query', () => {
  const m = pl().match('/2026/11/hello-world/')!;
  assert.deepEqual({ route: m.route, params: m.params, query: m.query, page: m.page }, {
    route: 'post',
    params: { year: 2026, month: '11', slug: 'hello-world' },
    query: { type: 'post', year: 2026, month: '11', slug: 'hello-world' },
    page: 1,
  });
  assert.equal(m.canonical, '/2026/11/hello-world/');
  assert.equal(m.redirectTo, undefined, 'already canonical');
  const u = pl().match('/u/42/')!;
  assert.deepEqual(u.params, { id: 42 }, 'int constraints give numbers');
  assert.deepEqual(pl().match('/')!.query, { type: 'home', page: 1 });
});

test('the most specific route wins whatever the order they were declared in', () => {
  assert.equal(pl().match('/2026/11/')!.route, 'archive');
  assert.equal(pl().match('/about/')!.route, 'page');
  assert.equal(pl().match('/category/')!.route, 'page', 'no category given: the one-word page route takes it');
  assert.equal(pl().match('/category/news/')!.route, 'category');
  assert.equal(pl().match('/u/7/')!.route, 'user');
  assert.equal(new Permalinks([{ name: 'a', pattern: '/x/:v' }, { name: 'b', pattern: '/x/fixed' }], { trailingSlash: 'never' }).match('/x/fixed')!.route, 'b', 'a literal beats a parameter');
  assert.equal(new Permalinks([{ name: 'a', pattern: '/x/:v' }, { name: 'b', pattern: '/x/:v<int>' }], { trailingSlash: 'never' }).match('/x/12')!.route, 'b', 'a constrained parameter beats a plain one');
  assert.equal(new Permalinks([{ name: 'a', pattern: '/x/:v' }, { name: 'b', pattern: '/x/:v<int>' }], { trailingSlash: 'never' }).match('/x/ab')!.route, 'a');
});

test('constraints refuse what does not fit: no route takes it', () => {
  assert.equal(pl().match('/2026/13/hello/'), null, 'month 13');
  assert.equal(pl().match('/26/11/hello/'), null, 'two-digit year');
  assert.equal(pl().match('/2026/11/Hello_World/'), null, 'not a slug');
  assert.equal(pl().match('/u/abc/'), null);
  assert.equal(pl().match('/u/01/'), null, 'no leading zeros in ids');
  assert.equal(pl().match('/u/12345678901234567890/'), null, 'too many digits');
  assert.equal(pl().match('/no/such/route/here/'), null);
});

test('optional and wildcard parameters', () => {
  const s = pl().match('/search/')!;
  assert.deepEqual({ route: s.route, params: s.params }, { route: 'search', params: {} });
  assert.deepEqual(pl().match('/search/term/')!.params, { term: 'term' });
  const c = pl().match('/category/news/local/')!;
  assert.deepEqual(c.params, { path: 'news/local' });
  assert.deepEqual(c.query, { type: 'category', path: 'news/local', page: 1 });
});

test('trailing slash policy: one canonical form, and the other form is a redirect to it', () => {
  assert.equal(pl('always').match('/2026/11/hello')!.redirectTo, '/2026/11/hello/');
  assert.equal(pl('never').match('/2026/11/hello/')!.redirectTo, '/2026/11/hello');
  assert.equal(pl('never').match('/2026/11/hello')!.redirectTo, undefined);
  assert.equal(pl('never').match('/')!.canonical, '/', 'the root is always /');
  assert.equal(pl('always').match('//2026//11///hello//')!.redirectTo, '/2026/11/hello/', 'doubled slashes');
  assert.equal(pl('always').build('post', { year: 2026, month: '11', slug: 'a' }), '/2026/11/a/');
  assert.equal(pl('never').build('post', { year: 2026, month: '11', slug: 'a' }), '/2026/11/a');
});

test('pagination: /page/N is read for paginated routes; page 1 has no suffix and redirects there', () => {
  const m = pl().match('/2026/11/page/3/')!;
  assert.deepEqual({ route: m.route, page: m.page, q: m.query }, { route: 'archive', page: 3, q: { type: 'archive', year: 2026, month: '11', page: 3 } });
  assert.equal(m.canonical, '/2026/11/page/3/');
  assert.equal(pl().match('/2026/11/page/1/')!.redirectTo, '/2026/11/', 'page 1 is the plain address');
  assert.equal(pl().match('/page/2/')!.route, 'home');
  assert.equal(pl().match('/category/news/page/2/')!.page, 2);
  assert.equal(pl().match('/2026/11/hello/page/2/'), null, 'posts are not paginated');
  assert.equal(pl().match('/2026/11/page/0/'), null);
  assert.equal(pl().match('/2026/11/page/x/'), null);
  assert.equal(pl().match('/2026/11/page/02/'), null, 'no leading zero');
});

test('reverse routing: every built address routes back to the same route with the same parameters', () => {
  const p = pl();
  const cases: [string, Record<string, string | number>, number | undefined][] = [
    ['post', { year: 2026, month: '11', slug: 'hello-world' }, undefined],
    ['archive', { year: 2026, month: '01' }, 4],
    ['category', { path: 'news/local' }, 2],
    ['user', { id: 42 }, undefined],
    ['search', {}, undefined],
    ['search', { term: 'cats' }, undefined],
    ['home', {}, 9],
  ];
  for (const [name, params, page] of cases) {
    const url = p.build(name, params, page ? { page } : {});
    const back = p.match(url)!;
    assert.equal(back.route, name, url);
    assert.equal(back.redirectTo, undefined, `${url} is canonical`);
    assert.equal(back.page, page ?? 1);
    for (const [k, v] of Object.entries(params)) assert.equal(String(back.params[k]), String(v));
  }
  assert.equal(p.build('archive', { year: 2026, month: '01' }, { page: 4 }), '/2026/01/page/4/');
});

test('building refuses missing, extra and ill-fitting parameters, unknown routes and bad pages', () => {
  const p = pl();
  assert.throws(() => p.build('nope'), /no such route/);
  assert.throws(() => p.build('post', { year: 2026, month: '11' }), /"slug" is missing/);
  assert.throws(() => p.build('post', { year: 2026, month: '11', slug: 'Bad Slug' }), /does not fit slug<slug>/);
  assert.throws(() => p.build('post', { year: 20260, month: '11', slug: 'a' }), /does not fit year<year>/);
  assert.throws(() => p.build('post', { year: 2026, month: '11', slug: 'a', extra: 1 }), /"extra" is not a parameter/);
  assert.throws(() => p.build('post', { year: 2026, month: '11', slug: 'a/b' }), CannotBuild);
  assert.throws(() => p.build('user', { id: -1 }), CannotBuild);
  assert.throws(() => p.build('post', { year: 2026, month: '11', slug: 'a' }, { page: 2 }), /not paginated/);
  assert.throws(() => p.build('home', {}, { page: 0 }), /whole number/);
  assert.throws(() => p.build('home', {}, { page: 1.5 }), /whole number/);
  assert.throws(() => p.build('category', { path: 'a//b' }), CannotBuild);
});

test('an address that would be taken by a more specific route is refused at build time', () => {
  const p = new Permalinks([{ name: 'tag', pattern: '/:name' }, { name: 'about', pattern: '/about' }], { trailingSlash: 'never' });
  assert.equal(p.build('about'), '/about');
  assert.throws(() => p.build('tag', { name: 'about' }), /would be routed to about/);
  assert.equal(p.build('tag', { name: 'other' }), '/other');
});

test('hostile paths are never routed', () => {
  const p = pl();
  for (const bad of ['', 'no-slash', '/a/../b', '/%2e%2e/etc', '/2026/11/%2e%2e/', '/./x', '/u/%2F', '/a%2fb', '/a\\b', '/a%5Cb', '/x\u0000y', '/x%00y', '/%zz', '/%E0%A4%A', '/a/' + 'b/'.repeat(40), '/' + 'x'.repeat(3000), '/\n'])
    assert.equal(p.match(bad), null, JSON.stringify(bad.slice(0, 30)));
});

test('percent-encoding: non-ASCII parameters round-trip with upper-case escapes; lower-case escapes redirect', () => {
  const p = new Permalinks([{ name: 'tag', pattern: '/tag/:name' }], { trailingSlash: 'never' });
  const url = p.build('tag', { name: 'café au lait' });
  assert.equal(url, '/tag/caf%C3%A9%20au%20lait');
  assert.deepEqual(p.match(url)!.params, { name: 'café au lait' });
  assert.equal(p.match('/tag/caf%c3%a9%20au%20lait')!.redirectTo, url, 'lower-case escapes are not canonical');
  assert.equal(p.build('tag', { name: "a'b(c)*" }), '/tag/a%27b%28c%29%2A', 'characters that confuse some proxies are escaped');
  assert.equal(p.build('tag', { name: 'a?b#c&d' }), '/tag/a%3Fb%23c%26d');
});

test('canonical URLs are absolute against the site base; pagination gives its links', () => {
  const p = pl();
  assert.equal(p.canonicalUrl('https://example.com/ignored/path?x=1', 'post', { year: 2026, month: '11', slug: 'a' }), 'https://example.com/2026/11/a/');
  assert.equal(p.canonicalUrl('https://example.com', 'archive', { year: 2026, month: '11' }, { page: 2 }), 'https://example.com/2026/11/page/2/');
  assert.throws(() => p.canonicalUrl('ftp://example.com', 'home'), CannotBuild);
  assert.equal(p.canonicalFor('/2026/11/a'), '/2026/11/a/');
  assert.equal(p.canonicalFor('/nothing/here/at/all/'), null);
  const mid = p.pagination('archive', { year: 2026, month: '11' }, { page: 3, totalPages: 5 });
  assert.deepEqual(mid, {
    canonical: '/2026/11/page/3/',
    first: '/2026/11/',
    prev: '/2026/11/page/2/',
    next: '/2026/11/page/4/',
    last: '/2026/11/page/5/',
    links: [{ rel: 'prev', href: '/2026/11/page/2/' }, { rel: 'next', href: '/2026/11/page/4/' }],
  });
  const one = p.pagination('archive', { year: 2026, month: '11' }, { page: 1, totalPages: 1 });
  assert.deepEqual({ first: one.first, prev: one.prev, next: one.next, last: one.last, links: one.links }, { first: null, prev: null, next: null, last: null, links: [] });
  assert.equal(p.pagination('home', {}, { page: 2, totalPages: 2 }).prev, '/', 'the previous of page 2 is page 1 without a suffix');
  assert.throws(() => p.pagination('home', {}, { page: 3, totalPages: 2 }), /outside 1 to 2/);
  assert.throws(() => p.pagination('home', {}, { page: 1, totalPages: 0 }), CannotBuild);
});

test('bad patterns are refused when the table is built', () => {
  const bad = (pattern: string, why: RegExp, extra: RouteDef[] = []) => assert.throws(() => new Permalinks([{ name: 'x', pattern }, ...extra], { trailingSlash: 'always' }), (e: Error) => e instanceof InvalidPattern && why.test(e.message), pattern);
  bad('no-slash', /start with/);
  bad('/a//b', /empty segment/);
  bad('/:a/:a', /twice/);
  bad('/:a?/b', /last segment/);
  bad('/:a*/b', /last segment/);
  bad('/:a<regex>', /not a constraint/);
  bad('/a:b', /not a literal or a parameter/);
  bad('/a*', /not a literal or a parameter/);
  bad('/%2e', /cannot be a literal/);
  bad('/..', /cannot be a literal/);
  bad('/:a<int>', /same paths/, [{ name: 'y', pattern: '/:b<int>' }]);
  assert.throws(() => new Permalinks([{ name: 'x', pattern: '/a' }, { name: 'x', pattern: '/b' }], { trailingSlash: 'never' }), /used twice/);
  assert.throws(() => new Permalinks([], { trailingSlash: 'never', pageSegment: 'Page/1' }), InvalidPattern);
  assert.deepEqual(pl().names, ['home', 'post', 'archive', 'category', 'page', 'user', 'search']);
});

test('a different page segment, and a route that is not paginated keeps /page/2 as ordinary segments', () => {
  const p = new Permalinks([{ name: 'list', pattern: '/items', paginate: true }, { name: 'doc', pattern: '/docs/:a/:b' }], { trailingSlash: 'never', pageSegment: 'p' });
  assert.equal(p.match('/items/p/3')!.page, 3);
  assert.equal(p.build('list', {}, { page: 2 }), '/items/p/2');
  assert.equal(p.match('/items/page/3'), null);
  assert.deepEqual(p.match('/docs/p/3')!.params, { a: 'p', b: '3' });
});
