// The live walk: zthr.ai as visitors get it, after every deploy. Every published page is opened in a real browser
// at desktop and phone widths; every link on it is followed to where it finally lands; the security headers, the
// not-found answers and the way into the app are checked. Anything wrong fails the run and is listed in its summary.
//
//   node tools/livewalk.mjs [origin=https://zthr.ai]
import { readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium } from 'playwright';

const ORIGIN = (process.argv[2] ?? 'https://zthr.ai').replace(/\/$/, '');
const APP = 'https://advocate-fsy7whk33q-uc.a.run.app';
const problems = [];
const warnings = [];
const bad = (where, what) => problems.push(`${where}: ${what}`);

// Published pages, as Firebase serves them: clean URLs, no trailing slash, index.html as the folder.
const pages = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.html') && f !== '404.html') {
      const rel = `/${relative('docs', p)}`.replace(/\/index\.html$/, '').replace(/\.html$/, '');
      pages.push(rel || '/');
    }
  }
})('docs');
pages.sort();

async function land(url) {
  // Follow redirects by hand so each hop is seen; report where the link finally lands.
  let u = url;
  for (let hop = 0; hop < 8; hop++) {
    let r;
    try {
      r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': 'zthr-livewalk' } });
    } catch (e) {
      return { status: 0, url: u, error: String(e.cause?.code ?? e.message) };
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      u = new URL(r.headers.get('location'), u).href;
      continue;
    }
    return { status: r.status, url: u, type: r.headers.get('content-type') ?? '', headers: r.headers, body: r.status < 400 ? await r.text() : '' };
  }
  return { status: 0, url: u, error: 'redirect loop' };
}

// 1. Headers on the kinds of page there are.
const NEED = {
  'content-security-policy': /frame-ancestors 'self'/,
  'strict-transport-security': /max-age=\d{7,}/,
  'x-frame-options': /SAMEORIGIN/i,
  'x-content-type-options': /nosniff/,
  'referrer-policy': /./,
  'permissions-policy': /camera=\(\)/,
};
for (const p of ['/', '/advocate', '/reference', '/reference/factory', '/reference/docs/architecture']) {
  const r = await land(`${ORIGIN}${p}`);
  if (r.status !== 200) bad(p, `answered ${r.status}`);
  for (const [h, re] of Object.entries(NEED)) if (!re.test(r.headers?.get(h) ?? '')) bad(p, `header ${h} missing or wrong (${r.headers?.get(h) ?? 'absent'})`);
}

// 2. Not-found answers: a probe for a secret file must get a 404, not a page.
for (const p of ['/.env', '/.git/config', '/wp-login.php', '/no-such-page']) {
  const r = await land(`${ORIGIN}${p}`);
  if (r.status !== 404) bad(p, `answered ${r.status}; a missing page must answer 404`);
}
const sec = await land(`${ORIGIN}/.well-known/security.txt`);
if (sec.status !== 200 || !/^text\/plain/.test(sec.type) || !/^Contact: mailto:/m.test(sec.body)) bad('/.well-known/security.txt', `answered ${sec.status} ${sec.type}`);

// 3. The way into the app, and the app's own answer.
for (const p of ['/studentadvocate', '/studentadvocate/', '/studentadvocate/admin/', '/advocate']) {
  const r = await land(`${ORIGIN}${p}`);
  if (r.status !== 200) bad(p, `lands on ${r.url} with ${r.status}`);
}
const ver = await land(`${APP}/studentadvocate/version`);
let commit = '';
try {
  commit = JSON.parse(ver.body).commit ?? '';
} catch {
  bad('/studentadvocate/version', `not JSON (${ver.status})`);
}

// 4. Every page in a real browser, at two widths; collect its links.
const links = new Map(); // url -> first page it was seen on
const browser = await chromium.launch();
let views = 0;
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/google-analytics|googletagmanager|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  for (const p of pages) {
    errors = [];
    const resp = await page.goto(`${ORIGIN}${p}`, { waitUntil: 'load', timeout: 30000 }).catch((e) => (bad(p, `did not load: ${e.message.split('\n')[0]}`), null));
    if (!resp) continue;
    views++;
    if (resp.status() !== 200) bad(p, `answered ${resp.status()}`);
    if (await page.locator('.mermaid').count()) await page.waitForSelector('.mermaid svg', { timeout: 8000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      csp: window.__csp,
      overflow: document.documentElement.scrollWidth - innerWidth,
      h1: document.querySelectorAll('h1').length,
      diagrams: document.querySelectorAll('.mermaid').length,
      drawn: document.querySelectorAll('.mermaid svg').length,
      title: document.title,
      links: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)),
    }));
    const at = `${p} at ${width}px`;
    if (r.csp.length) bad(at, `blocked by the content security policy: ${r.csp.slice(0, 3).join('; ')}`);
    if (errors.length) bad(at, `browser errors: ${errors.slice(0, 2).join(' | ')}`);
    if (r.overflow > 1) bad(at, `page scrolls sideways by ${r.overflow}px`);
    if (r.drawn < r.diagrams) bad(at, `${r.diagrams - r.drawn} of ${r.diagrams} diagrams not drawn`);
    if (!r.title.trim()) bad(at, 'no page title');
    if (width === 1280) for (const h of r.links) if (!links.has(h.split('#')[0])) links.set(h.split('#')[0], p);
  }
  await ctx.close();
}
await browser.close();

// 5. Every link, followed to where it lands. Links into the site and the app must land on a 200; links out
// must not be broken (a site that refuses robots is a warning, not a failure).
const queue = [...links.entries()];
let followed = 0;
async function worker() {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const [url, from] = item;
    const ours = url.startsWith(ORIGIN) || url.startsWith(APP);
    const r = await land(url);
    followed++;
    if (r.status === 200) continue;
    if (ours) bad(from, `${url} lands on ${r.url} with ${r.status || r.error}`);
    else if ([401, 403, 429, 999].includes(r.status) || r.status === 0) warnings.push(`${from}: ${url} answered ${r.status || r.error} (external, may refuse robots)`);
    else if (r.status >= 400) bad(from, `${url} is broken (${r.status})`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const summary = [
  `## Live walk of ${ORIGIN}`,
  '',
  `- ${pages.length} pages, ${views} page views in a real browser (1280 and 390 pixels)`,
  `- ${followed} distinct links followed to where they land`,
  `- app serving commit \`${commit.slice(0, 12) || 'unknown'}\``,
  `- **${problems.length} problems**, ${warnings.length} warnings`,
  '',
  ...problems.map((p) => `- ❌ ${p}`),
  ...warnings.map((w) => `- ⚠️ ${w}`),
].join('\n');
console.log(summary);
writeFileSync('livewalk.json', JSON.stringify({ origin: ORIGIN, at: new Date().toISOString(), pages: pages.length, views, followed, commit, problems, warnings }, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
process.exit(problems.length ? 1 : 0);
