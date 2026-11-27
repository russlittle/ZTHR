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
