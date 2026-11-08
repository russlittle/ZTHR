import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright is provided by the environment (CI installs it); resolved at runtime.
const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright') as typeof import('playwright');
type Page = import('playwright').Page;

/**
 * Walk like a user (Pattern 16), in a real browser.
 *
 * Part one follows intents by accessible name only, the way a person would, and records video. Part two sweeps
 * every screen for three students at phone and desktop widths, in light and dark. Every stop is read as
 * structure and as pixels (a screenshot). Structure means every WCAG 2.2 A and AA rule axe can test, and what a
 * screen reader is given: the accessibility tree (every control named, headings in order, page regions, the
 * page's language), focus never hidden behind a sticky bar, text that survives WCAG's spacing override, and
 * reflow at 320 pixels wide. Any violation fails the walk. A manifest of every stop feeds the factory console.
 */
const base = (process.argv[2] ?? 'http://localhost:8787/advocate').replace(/\/$/, '');
const out = process.argv[3] ?? 'evidence-out/ui';
mkdirSync(`${out}/video`, { recursive: true });
const axeSource = readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8');

interface Stop {
  walk: string;
  step: string;
  scheme: string;
  viewport: string;
  url: string;
  screenshot: string;
  problems: string[];
  ms: number;
  /** Checks axe could not decide automatically (such as contrast over a gradient), for the accessibility statement. */
  review?: number;
}
const stops: Stop[] = [];

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// A line of the accessibility tree: "- button "Send"" (a name with a colon is wrapped in quotes: "- 'link "a: b"'").
const NAMED = /^\s*- '?(link|button|textbox|combobox|checkbox|radio|img|searchbox|spinbutton|switch|tab|menuitem)(?=[\s:"']|$)(?: "((?:[^"\\]|\\.)*)")?/;

/** What a screen reader is handed: the accessibility tree, read for unnamed controls, heading order and regions. */
async function screenReader(page: Page): Promise<string[]> {
  const p: string[] = [];
  const tree: string = await page.locator('body').ariaSnapshot();
  const unnamed = tree.split('\n').map((l) => l.match(NAMED)).filter((m): m is RegExpMatchArray => !!m && !(m[2] ?? '').trim());
  if (unnamed.length) p.push(`screen reader: ${unnamed.length} unnamed ${[...new Set(unnamed.map((m) => m[1]))].join('/')}`);
  const levels = [...tree.matchAll(/heading "(?:[^"\\]|\\.)*" \[level=(\d)\]/g)].map((m) => Number(m[1]));
  if (levels.filter((l) => l === 1).length !== 1) p.push(`screen reader: ${levels.filter((l) => l === 1).length} level-1 headings`);
  levels.forEach((l, i) => i && l > levels[i - 1]! + 1 && p.push(`screen reader: heading jumps from level ${levels[i - 1]} to ${l}`));
  if (!/^\s*- main\b/m.test(tree)) p.push('screen reader: no main region');
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (!/^(en|es)\b/.test(lang)) p.push(`page language is "${lang}"`);
  return [...new Set(p)];
}

/** WCAG 2.4.11: tab through the page; a focused control may not be wholly hidden by a sticky header or tab bar. */
async function focusNotObscured(page: Page): Promise<string[]> {
  const hidden: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { done: true, covered: false, name: '' };
      const b = el.getBoundingClientRect();
      const pts = [[b.left + 2, b.top + 2], [b.right - 2, b.top + 2], [b.left + 2, b.bottom - 2], [b.right - 2, b.bottom - 2], [b.left + b.width / 2, b.top + b.height / 2]].filter(([x, y]) => x! >= 0 && y! >= 0 && x! < innerWidth && y! < innerHeight);
      const covered = !pts.length || pts.every(([x, y]) => { const top = document.elementFromPoint(x!, y!); return !!top && top !== el && !el.contains(top) && !top.contains(el); });
      return { done: false, covered, name: (el.getAttribute('aria-label') ?? el.innerText ?? '').trim().slice(0, 30) };
    });
    if (r.done) break;
    if (r.covered) hidden.push(r.name);
  }
  return hidden.length ? [`focus hidden behind a sticky bar: ${[...new Set(hidden)].slice(0, 3).join(', ')}`] : [];
}

/** WCAG 1.4.12: with the reader's spacing (line 1.5, letters .12em, words .16em, paragraphs 2em) nothing is cut off or scrolls sideways. */
async function textSpacing(page: Page): Promise<string[]> {
  const tag = await page.addStyleTag({ content: '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}' });
  const p = await page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) out.push(`with wider text spacing the page scrolls sideways by ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px`);
    for (const el of Array.from(document.querySelectorAll('main a, main button, main h1, main h2, main label, nav a'))) {
      const h = el as HTMLElement;
      if (h.clientWidth <= 1 || h.closest('.visually-hidden')) continue;
      const cs = getComputedStyle(h);
      if ((cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') && (h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1)) out.push(`with wider text spacing "${h.innerText.trim().slice(0, 24)}" is cut off`);
    }
    return out.slice(0, 3);
  });
  await tag.evaluate((n: Element) => n.remove());
  return p;
}

async function inspect(page: Page, walk: string, step: string, scheme: string, viewport: string, t0: number, deep = true): Promise<void> {
  const file = `${walk}-${scheme}-${viewport}-${step}.png`.replace(/[^\w.-]+/g, '_');
  await page.screenshot({ path: `${out}/${file}`, fullPage: true });
  await page.addScriptTag({ content: axeSource });
  type AxeOut = { violations: { id: string; impact: string; nodes: unknown[] }[]; incomplete: { id: string; nodes: unknown[] }[] };
  const r = (await page.evaluate(async (tags: unknown) => (window as unknown as { axe: { run: (o: object) => Promise<AxeOut> } }).axe.run({ runOnly: { type: 'tag', values: tags as string[] }, resultTypes: ['violations', 'incomplete'] }), WCAG)) as AxeOut;
  // Every WCAG A and AA violation fails, whatever axe rates its impact.
  const problems = r.violations.map((v) => `${v.id} (${v.nodes.length})`);
  const layout = await page.evaluate(() => {
    const p: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) p.push(`scrolls sideways by ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px`);
    if (document.querySelectorAll('h1').length !== 1) p.push(`${document.querySelectorAll('h1').length} h1 headings`);
    // On a phone the tab bar sits at the bottom edge, where a thumb reaches it, and nowhere else.
    const tabs = document.querySelector('nav.tabs');
    if (tabs && innerWidth <= 640 && Math.abs(tabs.getBoundingClientRect().bottom - innerHeight) > 2) p.push(`the tab bar is not at the bottom of the screen (bottom at ${Math.round(tabs.getBoundingClientRect().bottom)} of ${innerHeight})`);
    // Anything pinned to the screen (a sticky header, a tab bar) must hide what scrolls under it: a see-through bar
    // lets text from the page show through its own text.
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      const b = (el as HTMLElement).getBoundingClientRect();
      if (b.width < 40 || b.height < 20 || el.classList.contains('skip')) continue;
      // Computed colors come as rgb(r, g, b), rgba(r, g, b, a) or color(srgb r g b / a).
      const bg = cs.backgroundColor;
      const slash = bg.match(/\/\s*([\d.]+)\s*\)/);
      const rgba = bg.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
      const alpha = bg === 'transparent' ? 0 : slash ? Number(slash[1]) : rgba ? Number(rgba[1]) : 1;
      const blurred = cs.backdropFilter && cs.backdropFilter !== 'none';
      if (!(alpha >= 0.95 || (alpha >= 0.75 && blurred))) p.push(`a pinned ${el.tagName.toLowerCase()}.${(el as HTMLElement).className.split(' ')[0]} lets the page show through (background alpha ${alpha}${blurred ? ', blurred' : ''})`);
    }
    for (const el of Array.from(document.querySelectorAll('main button, main a.btn, nav.tabs a, main input[type=checkbox], main select'))) {
      const b = (el as HTMLElement).getBoundingClientRect();
      const min = (el as HTMLInputElement).type === 'checkbox' ? 24 : 43.5;
      if (b.width && b.height < min) p.push(`tap target "${(el as HTMLElement).innerText.trim().slice(0, 30)}" is ${Math.round(b.height)}px tall`);
    }
    return p;
  });
  problems.push(...layout, ...(await screenReader(page)));
  if (deep) problems.push(...(await focusNotObscured(page)), ...(await textSpacing(page)));
  stops.push({ walk, step, scheme, viewport, url: page.url().replace(base, ''), screenshot: file, problems, ms: Date.now() - t0, review: r.incomplete.reduce((n, x) => n + x.nodes.length, 0) });
}

const browser = await chromium.launch();
const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } } as const;
// WCAG 1.4.10: content reflows at 320 CSS pixels, the width of a 1280-pixel screen at 400% zoom.
const REFLOW = { width: 320, height: 640 } as const;

// ---- part one: intents, by accessible name, with video
for (const scheme of ['light', 'dark'] as const) {
  // The accessibility checker is injected as an inline script, which the app's content security policy rightly
  // refuses; the test browser may bypass the policy for the checker. The app itself still runs under it.
  const ctx = await browser.newContext({ viewport: VIEWPORTS.phone, colorScheme: scheme, bypassCSP: true, recordVideo: { dir: `${out}/video`, size: VIEWPORTS.phone } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const at = (step: string) => inspect(page, 'rent-short', step, scheme, 'phone', t0);
  await page.goto(`${base}/`);
  await at('01-start');
  await page.getByRole('link', { name: 'Maria' }).click();
  await page.getByText(/Rent on .* looks about \$\d+ short/).first().waitFor();
  await at('02-today');
  await page.getByRole('button', { name: /Ask the landlord for more time/ }).first().click();
  await page.getByRole('heading', { name: 'To landlord' }).first().waitFor();
  await at('03-draft');
  await page.getByRole('button', { name: 'Send it' }).first().click();
  await page.getByText(/Sent to landlord/).first().waitFor();
  await at('04-sent');
  await page.getByRole('link', { name: 'Money' }).click();
  await page.getByRole('heading', { name: 'What I checked' }).waitFor();
  await at('05-money');
  await page.getByRole('link', { name: 'Help' }).click();
  await page.getByRole('button', { name: 'My power is getting shut off' }).click();
  await page.getByText(/payment plan/).first().waitFor();
  await at('06-shutoff');
  await page.getByRole('link', { name: 'You' }).click();
  await page.getByRole('heading', { name: 'Your record of consent' }).waitFor();
  await at('07-you');
  await page.getByRole('link', { name: 'Your week' }).click();
  await page.getByRole('heading', { name: 'Your week', level: 1 }).waitFor();
  await at('08-week');
  const video = page.video();
  await ctx.close();
  if (video) writeFileSync(`${out}/video/rent-short-${scheme}.txt`, await video.path());
}

// ---- part two: every screen, three students, two widths, two themes
const SCREENS = ['', '/money', '/school', '/school/drop', '/school/degree', '/advisor', '/help', '/you', '/delete', '/week', '/dates', '/shifts', '/syllabus', '/drafts', '/ask', '/letter', '/meals'];
for (const sid of ['maria', 'sam', 'ana', 'destiny', 'tyler']) {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: size, colorScheme: scheme, bypassCSP: true });
      for (const s of SCREENS) {
        const t0 = Date.now();
        await page.goto(`${base}/s/${sid}${s}`);
        await inspect(page, sid, s.slice(1) || 'today', scheme, vp, t0);
      }
      await page.close();
    }
  }
}
// ---- reflow at 400% zoom, for one student on every screen
{
  const page = await browser.newPage({ viewport: REFLOW, bypassCSP: true });
  for (const s of SCREENS) {
    const t0 = Date.now();
    await page.goto(`${base}/s/destiny${s}`);
    await inspect(page, 'destiny', s.slice(1) || 'today', 'light', 'reflow-320', t0, false);
  }
  await page.close();
}
// ---- a shared link, as the advisor sees it
{
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop, bypassCSP: true });
  await page.goto(`${base}/s/tyler/advisor`);
  await page.getByRole('checkbox', { name: /degree progress/ }).check();
  await page.getByRole('button', { name: 'Make the link' }).click();
  const link = await page.getByRole('textbox', { name: 'The link' }).inputValue();
  await inspect(page, 'tyler', 'advisor-made', 'light', 'desktop', Date.now());
  const t0 = Date.now();
  await page.goto(link);
  await inspect(page, 'advisor', 'shared-link', 'light', 'desktop', t0);
  await page.close();
}
// ---- part three: the published docs and factory console, if this build made them
const origin = new URL(base).origin;
const sitePages = await (async () => {
  const r = await fetch(`${origin}/docs/`).catch(() => undefined);
  if (!r || r.status !== 200) return [] as string[];
  const { readdirSync, statSync } = await import('node:fs');
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(`${d}/${n}`).isDirectory() ? files(`${d}/${n}`) : n.endsWith('.html') ? [`${d}/${n}`] : []));
  return ['docs', 'factory'].flatMap((p) => files(`site-out/${p}`).map((f) => f.replace(/^site-out/, '')));
})();
if (sitePages.length) {
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop, bypassCSP: true });
  for (const path of sitePages) {
    const t0 = Date.now();
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    const diagrams = await page.evaluate(async () => {
      for (let i = 0; i < 40 && document.querySelectorAll('pre.mermaid:not([data-processed])').length; i++) await new Promise((r) => setTimeout(r, 100));
      const pending = document.querySelectorAll('pre.mermaid:not([data-processed])').length;
      const broken = Array.from(document.querySelectorAll('pre.mermaid')).filter((el) => /Syntax error|Parse error/i.test(el.textContent ?? '') || el.querySelector('.error-icon')).length;
      return { pending, broken };
    });
    await inspect(page, 'site', path.replace(/\//g, '_').replace(/^_/, ''), 'light', 'desktop', t0);
    const last = stops[stops.length - 1]!;
    // Console pages have no sideways-scroll requirement for wide tables; diagrams must all draw.
    last.problems = last.problems.filter((p) => !p.startsWith('scrolls sideways') && !p.startsWith('tap target'));
    if (diagrams.pending) last.problems.push(`${diagrams.pending} diagrams did not draw`);
    if (diagrams.broken) last.problems.push(`${diagrams.broken} diagrams have errors`);
  }
  await page.close();
}

await browser.close();

writeFileSync(`${out}/manifest.json`, JSON.stringify({ base, at: new Date().toISOString(), stops }, null, 1));
const failing = stops.filter((s) => s.problems.length);
if (failing.length) {
  for (const s of failing) console.error(`${s.walk} ${s.step} ${s.scheme}/${s.viewport}: ${s.problems.join('; ')}`);
  process.exit(1);
}
console.log(`ui walk passed: ${stops.length} stops (intents with video; every screen for five students at two widths in two themes; reflow at 320 pixels; a shared link); no WCAG 2.2 A or AA violation, every control named for screen readers, focus never hidden, text spacing and reflow hold`);
