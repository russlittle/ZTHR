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
// What the build recorded for its deep click-through and whole-words check, as the app publishes it.
const walkPage = await land(`${APP}/factory/ui-walk.html`);
const buildChecks = (() => {
  const t = walkPage.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const deep = t.match(/([\d,]+) controls clicked[^.]*?([\d,]+) controls with problems/) ?? t.match(/([\d,]+) controls clicked/);
  const words = t.match(/([\d,]+) page views \(([\d,]+) pages at two widths in two themes\); ([\d,]+) with a word split/);
  const failing = (t.match(/Controls with problems(.{0,600})/) ?? [])[1] ?? '';
  return { deep: deep ? deep[0] : 'not recorded', words: words ? words[0] : 'not recorded', failing: failing.trim().slice(0, 600) };
})();
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
      // Nothing scrolls sideways inside the page either: no frame, menu or figure.
      scrollers: [...document.querySelectorAll('body *')].filter((e) => !e.closest('.fig-view') && e.offsetParent && /(auto|scroll)/.test(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 2).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`),
      figures: document.querySelectorAll('.fig').length,
      bars: document.querySelectorAll('.fig .fig-bar').length,
      h1: document.querySelectorAll('h1').length,
      diagrams: document.querySelectorAll('.mermaid').length,
      drawn: document.querySelectorAll('.mermaid svg:not([aria-roledescription="error"])').length,
      broken: document.querySelectorAll('.mermaid svg[aria-roledescription="error"]').length,
      title: document.title,
      links: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)),
    }));
    const at = `${p} at ${width}px`;
    if (r.csp.length) bad(at, `blocked by the content security policy: ${r.csp.slice(0, 3).join('; ')}`);
    if (errors.length) bad(at, `browser errors: ${errors.slice(0, 2).join(' | ')}`);
    if (r.overflow > 1) bad(at, `page scrolls sideways by ${r.overflow}px`);
    if (r.scrollers.length) bad(at, `scrolls sideways inside: ${[...new Set(r.scrollers)].join(', ')}`);
    if (r.bars < r.figures) bad(at, `${r.figures - r.bars} figure(s) without full screen, copy and print controls`);
    if (r.broken) bad(at, `${r.broken} diagram(s) drawn as a syntax error`);
    else if (r.drawn < r.diagrams) bad(at, `${r.diagrams - r.drawn} of ${r.diagrams} diagrams not drawn`);
    if (!r.title.trim()) bad(at, 'no page title');
    if (width === 1280) for (const h of r.links) if (!links.has(h.split('#')[0])) links.set(h.split('#')[0], p);
  }
  // One figure, opened full screen and closed again, per width: every control on screen, and focus comes back.
  await page.goto(`${ORIGIN}/reference/docs/architecture`, { waitUntil: 'load' });
  await page.waitForSelector('.fig .fig-bar', { timeout: 10000 }).catch(() => bad(`/reference/docs/architecture at ${width}px`, 'no figure controls'));
  const full = page.locator('.fig-bar').first().getByRole('button', { name: 'Full screen' });
  if (await full.count()) {
    await full.click();
    await page.waitForTimeout(400);
    const v = await page.evaluate(() => ({ open: document.querySelector('.fig-view')?.open, off: [...document.querySelectorAll('.fig-view header button')].filter((b) => { const x = b.getBoundingClientRect(); return x.right > innerWidth || x.left < 0; }).map((b) => b.getAttribute('aria-label')) }));
    if (!v.open) bad(`full screen at ${width}px`, 'did not open');
    if (v.off.length) bad(`full screen at ${width}px`, `controls off screen: ${v.off.join(', ')}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await page.evaluate(() => document.querySelector('.fig-view')?.open)) bad(`full screen at ${width}px`, 'Escape did not close it');
  }
  await ctx.close();
}
// The factory cost page on zthr.ai reads the latest build's cost records from the app; it must show them.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/reference/factory/cost.html`, { waitUntil: 'networkidle' });
  const text = (await page.locator('main').innerText().catch(() => '')) || '';
  // Until the app serves its cost records (a build that publishes them has deployed), this is a warning.
  const served = await fetch('https://advocate-fsy7whk33q-uc.a.run.app/factory/ci-costs.json').then((r) => r.ok).catch(() => false);
  if (!/factory runs recorded/.test(text) && !served) warnings.push('/reference/factory/cost.html: the app does not serve its cost records yet');
  else if (!/factory runs recorded/.test(text)) bad('/reference/factory/cost.html', `shows no cost records: "${text.replace(/\s+/g, ' ').slice(0, 140)}"`);
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
    let r = await land(url);
    // Someone else's site can be down for a minute; one retry before judging it.
    if (r.status !== 200 && !ours) r = await land(url);
    followed++;
    if (r.status === 200) continue;
    if (ours) bad(from, `${url} lands on ${r.url} with ${r.status || r.error}`);
    else if ([401, 403, 429, 999].includes(r.status) || r.status === 0) warnings.push(`${from}: ${url} answered ${r.status || r.error} (external, may refuse robots)`);
    else if (r.status >= 500) warnings.push(`${from}: ${url} answered ${r.status} twice (their server is failing; checked again tomorrow)`);
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
  `- the app's build recorded: ${buildChecks.deep}; ${buildChecks.words}${buildChecks.failing ? ` — failing: ${buildChecks.failing}` : ''}`,
  `- **${problems.length} problems**, ${warnings.length} warnings`,
  '',
  ...problems.map((p) => `- ❌ ${p}`),
  ...warnings.map((w) => `- ⚠️ ${w}`),
].join('\n');
console.log(summary);
writeFileSync('livewalk.json', JSON.stringify({ origin: ORIGIN, at: new Date().toISOString(), pages: pages.length, views, followed, commit, problems, warnings }, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
process.exit(problems.length ? 1 : 0);
