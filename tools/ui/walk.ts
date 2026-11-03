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
 * structure (accessibility checks, heading, no sideways scrolling, tap targets at least 44 pixels) and as
 * pixels (a screenshot). Any serious finding fails the walk. A manifest of every stop feeds the factory console.
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
}
const stops: Stop[] = [];

async function inspect(page: Page, walk: string, step: string, scheme: string, viewport: string, t0: number): Promise<void> {
  const file = `${walk}-${scheme}-${viewport}-${step}.png`.replace(/[^\w.-]+/g, '_');
  await page.screenshot({ path: `${out}/${file}`, fullPage: true });
  await page.addScriptTag({ content: axeSource });
  const r = (await page.evaluate(async () => (window as unknown as { axe: { run: (o: object) => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe.run({ resultTypes: ['violations'] }))) as { violations: { id: string; impact: string; nodes: unknown[] }[] };
  const problems = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
  const layout = await page.evaluate(() => {
    const p: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) p.push(`scrolls sideways by ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px`);
    if (document.querySelectorAll('h1').length !== 1) p.push(`${document.querySelectorAll('h1').length} h1 headings`);
    for (const el of Array.from(document.querySelectorAll('main button, main a.btn, nav.tabs a'))) {
      const b = (el as HTMLElement).getBoundingClientRect();
      if (b.width && b.height < 43.5) p.push(`tap target "${(el as HTMLElement).innerText.trim().slice(0, 30)}" is ${Math.round(b.height)}px tall`);
    }
    return p;
  });
  problems.push(...layout);
  stops.push({ walk, step, scheme, viewport, url: page.url().replace(base, ''), screenshot: file, problems, ms: Date.now() - t0 });
}

const browser = await chromium.launch();
const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 860 } } as const;

// ---- part one: intents, by accessible name, with video
for (const scheme of ['light', 'dark'] as const) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS.phone, colorScheme: scheme, recordVideo: { dir: `${out}/video`, size: VIEWPORTS.phone } });
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
const SCREENS = ['', '/money', '/help', '/you', '/week', '/dates', '/shifts', '/syllabus', '/drafts', '/ask', '/letter'];
for (const sid of ['maria', 'sam', 'ana']) {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: size, colorScheme: scheme });
      for (const s of SCREENS) {
        const t0 = Date.now();
        await page.goto(`${base}/s/${sid}${s}`);
        await inspect(page, sid, s.slice(1) || 'today', scheme, vp, t0);
      }
      await page.close();
    }
  }
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
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
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
console.log(`ui walk passed: ${stops.length} stops (intents with video, every screen for three students at two widths in two themes); no serious accessibility or layout problems`);
