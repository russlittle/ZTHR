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
