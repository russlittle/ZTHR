import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2]; const base = 'http://localhost:8790/advocate';
const b = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
  for (const [n, path] of [['today', '/s/maria'], ['money', '/s/maria/money'], ['help', '/s/maria/help'], ['week', '/s/maria/week'], ['you', '/s/maria/you'], ['start', '/']]) {
    await p.goto(base + path); await p.screenshot({ path: `${out}/${scheme}-${n}.png`, fullPage: true });
  }
  await p.close();
}
await b.close();
