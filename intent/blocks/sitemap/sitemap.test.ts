import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, head, robots, sitemaps, type Page } from './index.ts';

const pages: Page[] = [
  { path: '/', title: 'Files you own', description: 'Store and share files on your own cloud.', public: true, image: '/og.png', jsonLd: { '@type': 'WebSite', name: 'Files </script>' } },
  { path: '/pricing', title: 'Pricing & plans', description: 'What it costs.', public: true, updated: '2026-11-20' },
  { path: '/admin', title: 'Admin', description: 'x', public: false },
  { path: '/draft', title: 'Files you own', description: '', public: true },
  { path: '/old', title: 'Old', description: 'x', public: true, noindex: true },
];

test('head tags are complete, absolute and escaped, and JSON-LD cannot close its script', () => {
  const h = head(pages[1]!, 'https://files.example.org', 'Files');
  assert.match(h, /<title>Pricing &#38; plans<\/title>/);
  assert.match(h, /<link rel="canonical" href="https:\/\/files\.example\.org\/pricing">/);
  assert.match(h, /twitter:card" content="summary"/);
  const home = head(pages[0]!, 'https://files.example.org', 'Files');
  assert.match(home, /og:image" content="https:\/\/files\.example\.org\/og\.png"/);
  assert.equal(home.includes('</script>"'), false);
  assert.match(home, /\\u003c\/script>/);
  assert.match(head(pages[2]!, 'https://x.org', 'F'), /noindex/);
});

test('the check finds what search engines would penalise; the sitemap lists only indexable public pages', () => {
  assert.deepEqual(check(pages), ['/draft: no description', '/draft: same title as /']);
  const [one] = sitemaps(pages, 'https://files.example.org');
  assert.equal((one!.xml.match(/<url>/g) ?? []).length, 3);
  assert.match(one!.xml, /<loc>https:\/\/files\.example\.org\/pricing<\/loc><lastmod>2026-11-20<\/lastmod>/);
  assert.equal(one!.xml.includes('/admin'), false);
  const many = sitemaps(Array.from({ length: 5 }, (_, i) => ({ path: `/p${i}`, title: `P${i}`, description: 'd', public: true })), 'https://x.org', 2);
  assert.deepEqual(many.map((m) => m.path), ['/sitemap.xml', '/sitemap-1.xml', '/sitemap-2.xml', '/sitemap-3.xml']);
  assert.match(many[0]!.xml, /<sitemapindex/);
  assert.equal(robots('https://x.org', ['/admin']), 'User-agent: *\nDisallow: /admin\nSitemap: https://x.org/sitemap.xml\n');
});

test('a path cannot point the canonical URL or the sitemap at another site', () => {
  const evil: Page = { path: '//evil.example/x', title: 'T', description: 'D', public: true };
  assert.throws(() => head(evil, 'https://x.org', 'F'), /another site/);
  assert.throws(() => sitemaps([evil], 'https://x.org'), /another site/);
  assert.deepEqual(check([evil]), ['//evil.example/x: the path must start with a single / and stay on this site']);
});

test('lastmod must be a W3C date and cannot inject XML', () => {
  const bad: Page = { path: '/a', title: 'A', description: 'd', public: true, updated: '2026-11-20</lastmod></url><url><loc>https://evil.example/</loc><lastmod>2026-11-20' };
  const [one] = sitemaps([bad], 'https://x.org');
  assert.equal(one!.xml.includes('evil.example'), false);
  assert.deepEqual(check([bad]), ['/a: updated is not a W3C date (YYYY-MM-DD or a full timestamp)']);
  const ok = sitemaps([{ ...bad, updated: '2026-11-20T10:00:00+01:00' }], 'https://x.org')[0]!.xml;
  assert.match(ok, /<lastmod>2026-11-20T10:00:00\+01:00<\/lastmod>/);
});

test('a sitemap also splits before 50 MB, refuses a non-positive split, and orders paths the same everywhere', () => {
  const long = Array.from({ length: 30_000 }, (_, i) => ({ path: `/${'p'.repeat(2000)}/${i}`, title: `${i}`, description: 'd', public: true }));
  const parts = sitemaps(long, 'https://x.org');
  assert.ok(parts.length > 2, 'split into an index');
  for (const p of parts) assert.ok(Buffer.byteLength(p.xml) <= 50 * 1024 * 1024, `${p.path} is ${Buffer.byteLength(p.xml)} bytes`);
  assert.equal(parts.slice(1).reduce((n, p) => n + (p.xml.match(/<url>/g) ?? []).length, 0), 30_000);
  assert.throws(() => sitemaps(pages, 'https://x.org', 0), /at least one/);
  const order = sitemaps([{ path: '/b', title: 'b', description: 'd', public: true }, { path: '/B', title: 'B', description: 'd', public: true }, { path: '/a', title: 'a', description: 'd', public: true }], 'https://x.org')[0]!.xml;
  assert.deepEqual([...order.matchAll(/<loc>https:\/\/x\.org(\/\w)<\/loc>/g)].map((m) => m[1]), ['/B', '/a', '/b']);
});

const O = 'https://files.example.org';

test('head writes every tag, in order, and nothing blank', () => {
  assert.equal(
    head(pages[1]!, O, 'Files'),
    [
      '<title>Pricing &#38; plans</title>',
      '<meta name="description" content="What it costs.">',
      '<link rel="canonical" href="https://files.example.org/pricing">',
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Files">',
      '<meta property="og:title" content="Pricing &#38; plans">',
      '<meta property="og:description" content="What it costs.">',
      '<meta property="og:url" content="https://files.example.org/pricing">',
      '<meta name="twitter:card" content="summary">',
    ].join('\n'),
  );
  assert.equal(
    head(pages[0]!, O, 'Files'),
    [
      '<title>Files you own</title>',
      '<meta name="description" content="Store and share files on your own cloud.">',
      '<link rel="canonical" href="https://files.example.org/">',
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Files">',
      '<meta property="og:title" content="Files you own">',
      '<meta property="og:description" content="Store and share files on your own cloud.">',
      '<meta property="og:url" content="https://files.example.org/">',
      '<meta property="og:image" content="https://files.example.org/og.png">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Files \\u003c/script>"}</script>',
    ].join('\n'),
  );
});

test('only a page that is not public, or is marked noindex, asks search engines to stay away', () => {
  const robotsTag = '<meta name="robots" content="noindex">';
  assert.equal(head(pages[1]!, O, 'F').includes('robots'), false, 'a public page is indexable');
  assert.ok(head(pages[2]!, O, 'F').includes(robotsTag), 'not public');
  assert.ok(head(pages[4]!, O, 'F').includes(robotsTag), 'noindex');
  assert.equal(head(pages[4]!, O, 'F').split('\n')[3], robotsTag, 'right after the canonical link');
});

test('a path is refused unless it is a root-relative path on the same site', () => {
  for (const path of ['relative', 'pricing/x', '//x.org/p', '//evil.example/x', '/\\evil.example/x', 'https://evil.example/x']) {
    assert.throws(() => head({ path, title: 'T', description: 'D', public: true }, 'https://x.org', 'F'), /another site/, path);
    assert.throws(() => sitemaps([{ path, title: 'T', description: 'D', public: true }], 'https://x.org'), /another site/, path);
  }
  assert.match(head({ path: '/a/b?c=1', title: 'T', description: 'D', public: true }, 'https://x.org', 'F'), /href="https:\/\/x\.org\/a\/b\?c=1"/);
});

test('urls are escaped for XML', () => {
  const [one] = sitemaps([{ path: "/it's?x=1&y=2", title: 'T', description: 'D', public: true }], 'https://x.org');
  assert.match(one!.xml, /<loc>https:\/\/x\.org\/it&apos;s\?x=1&amp;y=2<\/loc>/);
});

test('lastmod takes a year, a month, a day or a full timestamp, and nothing else', () => {
  const lastmod = (updated: string) => /<lastmod>/.test(sitemaps([{ path: '/a', title: 'A', description: 'd', public: true, updated }], 'https://x.org')[0]!.xml);
  const reported = (updated: string) => check([{ path: '/a', title: 'A', description: 'd', public: true, updated }]).length === 1;
  const valid = ['2026', '2026-11', '2026-01', '2026-12', '2026-11-20', '2026-11-01', '2026-11-09', '2026-11-10', '2026-11-29', '2026-11-30', '2026-12-31', '2026-11-20T10:00Z', '2026-11-20T00:00Z', '2026-11-20T19:59Z', '2026-11-20T20:00Z', '2026-11-20T23:59Z', '2026-11-20T10:00:30Z', '2026-11-20T10:00:59Z', '2026-11-20T10:00:30.5Z', '2026-11-20T10:00:30.123Z', '2026-11-20T10:00+01:00', '2026-11-20T10:00-05:30', '2026-11-20T10:00+23:59', '2026-11-20T10:00+09:00', '2026-11-20T10:00+19:00', '2026-11-20T10:00+20:00'];
  const invalid = ['', '202', '20261', 'x2026', '2026-', '2026-00', '2026-0a', '2026-13', '2026-1', '2026-11-', '2026-11-00', '2026-11-0a', '2026-11-32', '2026-11-3', '2026-11-40', '2026-11-20T', '2026-11-20T10:00', '2026-11-20T24:00Z', '2026-11-20T30:00Z', '2026-11-20T10:60Z', '2026-11-20T10:00:60Z', '2026-11-20T10:00:30.Z', '2026-11-20T10:00:30.xZ', '2026-11-20T10:00:30.5', '2026-11-20T10:00+24:00', '2026-11-20T10:00+30:00', '2026-11-20T10:00+1:00', '2026-11-20T10:00+01:60', '2026-11-20T10:00+01', '2026-11-20T10:00:30', '2026-11-20Z', '2026-11-20 10:00Z', '2026-11-20T10:00Zx'];
  for (const v of valid) {
    assert.equal(lastmod(v), true, `${v} is a W3C date`);
    assert.equal(reported(v), false, `${v} is not reported`);
  }
  for (const v of invalid) {
    assert.equal(lastmod(v), false, `${v} is not a W3C date`);
    assert.equal(reported(v), true, `${v} is reported`);
  }
});

test('check reports only pages that are public and indexable, with exact messages and limits', () => {
  const bad = { title: '', description: '', public: true } as const;
  assert.deepEqual(check([{ ...bad, path: '/private', public: false }, { ...bad, path: '/hidden', noindex: true }, { ...bad, path: '/hidden-private', public: false, noindex: true }]), [], 'pages that are not listed are not judged');
  assert.deepEqual(check([{ ...bad, path: 'relative', title: 'T', description: 'D' }]), ['relative: the path must start with a single / and stay on this site']);
  assert.deepEqual(check([{ ...bad, path: '/a' }]), ['/a: no title', '/a: no description']);
  assert.deepEqual(check([{ ...bad, path: '/a', title: '   ', description: ' \n ' }]), ['/a: no title', '/a: no description'], 'blank is empty');
  const t = (n: number) => check([{ path: '/a', title: 't'.repeat(n), description: 'd', public: true }]);
  assert.deepEqual(t(60), []);
  assert.deepEqual(t(61), ['/a: the title is 61 characters; search results cut it near 60']);
  const d = (n: number) => check([{ path: '/a', title: 't', description: 'd'.repeat(n), public: true }]);
  assert.deepEqual(d(160), []);
  assert.deepEqual(d(161), ['/a: the description is 161 characters; keep it under 160']);
});

test('a sitemap is written exactly as the protocol shows it, and holds one URL per split when asked', () => {
  const top = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  assert.deepEqual(sitemaps([], 'https://x.org'), [{ path: '/sitemap.xml', xml: `${top}\n</urlset>\n` }]);
  const [one, ...rest] = sitemaps(pages, O);
  assert.equal(rest.length, 0);
  assert.deepEqual(one, { path: '/sitemap.xml', xml: `${top}<url><loc>${O}/</loc></url>\n<url><loc>${O}/draft</loc></url>\n<url><loc>${O}/pricing</loc><lastmod>2026-11-20</lastmod></url>\n</urlset>\n` });
  const split = sitemaps(pages, O, 1);
  assert.deepEqual(split.map((s) => s.path), ['/sitemap.xml', '/sitemap-1.xml', '/sitemap-2.xml', '/sitemap-3.xml'], 'one URL per file');
  assert.equal(split[0]!.xml, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<sitemap><loc>${O}/sitemap-1.xml</loc></sitemap>\n<sitemap><loc>${O}/sitemap-2.xml</loc></sitemap>\n<sitemap><loc>${O}/sitemap-3.xml</loc></sitemap>\n</sitemapindex>\n`);
  assert.equal(split[1]!.xml, `${top}<url><loc>${O}/</loc></url>\n</urlset>\n`);
  assert.equal(split[3]!.xml, `${top}<url><loc>${O}/pricing</loc><lastmod>2026-11-20</lastmod></url>\n</urlset>\n`);
  const two = sitemaps(pages, O, 2);
  assert.equal(two[1]!.xml, `${top}<url><loc>${O}/</loc></url>\n<url><loc>${O}/draft</loc></url>\n</urlset>\n`, 'entries are on lines of their own');
  assert.throws(() => sitemaps(pages, O, -1), /at least one/);
  assert.throws(() => sitemaps(pages, O, Number.NaN), /at least one/);
});

test('robots.txt lists each disallowed path on its own line, and always points at the sitemap', () => {
  assert.equal(robots('https://x.org'), 'User-agent: *\nSitemap: https://x.org/sitemap.xml\n');
  assert.equal(robots('https://x.org', ['/admin', '/tmp']), 'User-agent: *\nDisallow: /admin\nDisallow: /tmp\nSitemap: https://x.org/sitemap.xml\n');
});

test('paths sort by code unit, and pages with the same path keep the order they were given in', () => {
  let s = 12345;
  const rand = (n: number) => ((s = (s * 48271) % 2147483647), s % n);
  const alphabet = ['a', 'b', 'B', 'ab', 'aB', '1', '10', '2'];
  const unique = new Set<string>();
  while (unique.size < 60) unique.add('/' + Array.from({ length: 1 + rand(3) }, () => alphabet[rand(alphabet.length)]).join(''));
  const same = ['/x', '/y', '/X', '/xx', '/', '/Y', '/a'];
  const mk = (paths: string[]): Page[] => paths.map((path, i) => ({ path, title: `t${i}`, description: 'd', public: true, updated: String(1000 + i) }));
  const run = (pages: Page[]) => [...sitemaps(pages, 'https://x.org')[0]!.xml.matchAll(/<loc>https:\/\/x\.org([^<]*)<\/loc><lastmod>(\d+)<\/lastmod>/g)].map((m) => `${m[1]}#${m[2]}`);
  const reference = (pages: Page[]) =>
    pages
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (a.p.path < b.p.path ? -1 : a.p.path > b.p.path ? 1 : a.i - b.i))
      .map(({ p }) => `${p.path}#${p.updated}`);
  const shuffled = mk([...unique].sort(() => rand(3) - 1));
  assert.deepEqual(run(shuffled), reference(shuffled));
  const dupes = mk(Array.from({ length: 400 }, () => same[rand(same.length)]!));
  assert.deepEqual(run(dupes), reference(dupes));
  const few = mk(['/b', '/a', '/b', '/a', '/b']);
  assert.deepEqual(run(few), reference(few));
});

test('a sitemap file never passes 50 MB, filling to exactly 50 MB, and every file after the first split obeys the same limit', () => {
  const MAX = 50 * 1024 * 1024;
  const B0 = Buffer.byteLength(sitemaps([], 'https://x.org')[0]!.xml);
  const base = Buffer.byteLength(sitemaps([{ path: '/a', title: 'a', description: 'd', public: true }], 'https://x.org')[0]!.xml) - B0 - 2;
  const L1 = 20_000_000;
  const L2 = MAX - B0 - 2 * base - 2 - L1;
  const two = (extra: number) => sitemaps([{ path: `/a${'p'.repeat(L1 - 2)}`, title: 'a', description: 'd', public: true }, { path: `/b${'p'.repeat(L2 - 2 + extra)}`, title: 'b', description: 'd', public: true }], 'https://x.org');
  const exact = two(0);
  assert.equal(exact.length, 1, 'two entries that together reach exactly the limit still fit in one file');
  assert.equal((exact[0]!.xml.match(/<url>/g) ?? []).length, 2);
  const over = two(1);
  assert.deepEqual(over.map((s) => s.path), ['/sitemap.xml', '/sitemap-1.xml', '/sitemap-2.xml'], 'one byte more and they split');

  const huge = Array.from({ length: 3 }, (_, i) => ({ path: `/${i}${'p'.repeat(26_500_000)}`, title: `${i}`, description: 'd', public: true }));
  const parts = sitemaps(huge, 'https://x.org');
  assert.deepEqual(parts.map((s) => s.path), ['/sitemap.xml', '/sitemap-1.xml', '/sitemap-2.xml', '/sitemap-3.xml']);
  for (const p of parts.slice(1)) {
    assert.ok(Buffer.byteLength(p.xml) <= MAX, `${p.path} is ${Buffer.byteLength(p.xml)} bytes`);
    assert.equal((p.xml.match(/<url>/g) ?? []).length, 1);
  }
});
