import { readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, relative } from 'node:path';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright') as typeof import('playwright');
type Page = import('playwright').Page;

/**
 * Whole words, on every page (Pattern 16, for the published site). Every published page is opened at desktop and
 * phone widths, in light and dark, and every word in a heading, table cell, link, button, label or list item is
 * checked: a word drawn across two lines ("Elap / sed") fails. Long addresses and code may break; words do not.
 *
 *   tsx tools/ui/words.ts <site dir> [app base url, checked on each student's main screens]
 */
const dir = process.argv[2] ?? 'site-out';
const app = process.argv[3]?.replace(/\/$/, '');
const WIDTHS = [1280, 390];
const SCREENS = ['', '/week', '/school', '/money', '/you', '/help', '/drafts', '/dates'];
const STUDENTS = ['maria', 'destiny', 'tyler', 'linda', 'sam'];

const pages = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? pages(p) : f.endsWith('.html') ? [p] : [];
  });

const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.json': 'application/json' };
// Pages carry <base href="/reference/<dir>/">, so the site is served under /reference/ as it is in production.
const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/reference\/?/, '/');
  try {
    const body = await readFile(join(dir, path.endsWith('/') ? `${path}index.html` : path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

/** Words split across lines inside the elements people read as labels. */
async function broken(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const roots = document.querySelectorAll('h1,h2,h3,h4,th,td,a,button,label,li,summary,dt,dd,figcaption,.l,.v');
    const seen = new Set<Node>();
    roots.forEach((root) => {
      if (root.closest('pre,code,.mermaid,svg')) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (seen.has(n) || n.parentElement?.closest('pre,code,svg')) continue;
        seen.add(n);
        const text = n.textContent ?? '';
        for (const m of text.matchAll(/[A-Za-z][A-Za-z'’]{3,}/g)) {
          const word = m[0];
          // Addresses, file names and identifiers may break; a word of prose may not.
          const around = text.slice(Math.max(0, m.index! - 1), m.index! + word.length + 1);
          if (/[/@._:-]/.test(around.replace(/[.:]$/, '')) || word.length > 24) continue;
          const r = document.createRange();
          r.setStart(n, m.index!);
          r.setEnd(n, m.index! + word.length);
          const lines = new Set(Array.from(r.getClientRects()).filter((x) => x.width > 0).map((x) => Math.round(x.top)));
          if (lines.size > 1) out.push(word);
        }
      }
    });
    return [...new Set(out)];
  });
}

const browser = await chromium.launch();
const problems: string[] = [];
let checked = 0;
const targets: { name: string; url: string }[] = pages(dir).map((p) => ({ name: relative(dir, p), url: `http://localhost:${port}/reference/${relative(dir, p)}` }));
if (app) for (const s of STUDENTS) for (const sc of SCREENS) targets.push({ name: `app ${s}${sc || ' today'}`, url: `${app}/s/${s}${sc}` });
for (const width of WIDTHS) {
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
    const page = await ctx.newPage();
    for (const t of targets) {
      const r = await page.goto(t.url, { waitUntil: 'load' }).catch(() => null);
      if (!r || r.status() >= 400) continue;
      await page.evaluate(() => document.fonts.ready);
      checked++;
      const words = await broken(page);
      if (words.length) problems.push(`${t.name} at ${width}px ${scheme}: ${words.slice(0, 6).join(', ')} split across lines`);
    }
    await ctx.close();
  }
}
await browser.close();
server.close();
for (const p of problems) console.error(p);
console.log(`whole words: ${checked} page views (${targets.length} pages at ${WIDTHS.join(' and ')} pixels, light and dark); ${problems.length} with a word split across lines`);
process.exit(problems.length ? 1 : 0);
