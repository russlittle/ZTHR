import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
for (const [n, u] of [['factory', '/factory/'], ['redteam', '/factory/redteam.html'], ['docs-arch', '/docs/architecture.html'], ['docs-data', '/docs/data-model.html'], ['admin', '/advocate/admin/'], ['admin-catalog', '/advocate/admin/catalog']]) {
  await p.goto('http://localhost:8790' + u, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}/${n}.png`, fullPage: false });
}
await b.close();
