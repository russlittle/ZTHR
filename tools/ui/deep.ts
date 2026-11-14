import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright') as typeof import('playwright');
type Page = import('playwright').Page;

/**
 * The deep click-through (Pattern 16, in a real browser, to depth). For each student, it opens Today and clicks
 * every link and every button it finds, then every link and button on each screen those lead to, down to eight
 * levels. Each control is clicked once, on the screen where it was found. After every click it checks the result:
 *
 *  - the screen loaded (no 4xx or 5xx), has one level-1 heading, and shows no programming artifacts;
 *  - the control did something: the address or the screen changed;
 *  - no button answered "not available", which is how the app says a control went nowhere;
 *  - the browser logged no errors.
 *
 *   tsx tools/ui/deep.ts <base> [out dir] [depth=8] [students=maria,destiny,tyler,linda,sam]
 */
const base = (process.argv[2] ?? 'http://localhost:8787/studentadvocate').replace(/\/$/, '');
const out = process.argv[3] ?? 'evidence-out/deep';
const DEPTH = Number(process.argv[4] ?? 8);
const STUDENTS = (process.argv[5] ?? 'maria,destiny,tyler,linda,sam').split(',');
const BUDGET = Number(process.env.DEEP_BUDGET ?? 500);
mkdirSync(out, { recursive: true });

const ARTIFACT = /\bundefined\b|\bNaN\b|\[object Object\]|TypeError|ReferenceError|Internal Server Error/;
const DEAD = /That button is not available right now|That checklist is not available right now/;
/** Controls that leave the app, end the session or destroy it; checked separately, never clicked in the crawl. */
const SKIP = /^(Yes, delete everything|Sign out|Call |Text |Talk to 2-1-1|Call or text 988)/;

type Control = { kind: 'link' | 'button'; name: string; href?: string; index: number };
type Visit = { student: string; depth: number; from: string; control: string; to: string; problems: string[] };

const pathOf = (u: string) => {
  const x = new URL(u);
  return `${x.pathname.replace(base.replace(/^https?:\/\/[^/]+/, ''), '')}${[...x.searchParams.keys()].filter((k) => k !== 'm').map((k) => `?${k}=${x.searchParams.get(k)}`).join('')}`;
};
/** A screen's identity for the crawl: its path with student ids and one-off ids folded, so each screen is explored once. */
// The guide's entry and barrier pages are one screen each, filled from the catalog: one of each is explored in depth
// (hundreds more would only show the same controls on other entries). The feature walk opens every one of them.
const screenKey = (p: string) =>
  p.replace(/\/s\/[^/]+/, '/s/:id').replace(/\/(dr|hd|dl|r)_[a-z0-9]+/g, '/:x').replace(/\/guide\/service\/[^/?#]+/, '/guide/service/:rid').replace(/\/guide\/(?!service|coverage)[a-z-]+(?=$|[?#])/, '/guide/:need');

async function controls(page: Page): Promise<Control[]> {
  return page.evaluate((origin: string) => {
    const seen = new Set<string>();
    const out: { kind: 'link' | 'button'; name: string; href?: string; index: number }[] = [];
    const roots = Array.from(document.querySelectorAll('main, nav.tabs'));
    roots.forEach((root) => {
      Array.from(root.querySelectorAll('a[href], button')).forEach((el, index) => {
        const h = el as HTMLElement;
        if (!h.offsetParent && getComputedStyle(h).position !== 'fixed') return;
        const name = (h.getAttribute('aria-label') ?? h.innerText ?? '').replace(/\s+/g, ' ').trim();
        if (!name) return;
        if (el.tagName === 'A') {
          const href = (el as HTMLAnchorElement).href;
          if (!href.startsWith(origin) || /\/(export|calendar\.ics|export\/)/.test(href) || href.includes('#')) return;
          // The tab for the screen you are on links to itself; that is where you are, not a control to test.
          if (el.getAttribute('aria-current') === 'page' || href.replace(/\?.*$/, '') === location.href.replace(/\?.*$/, '')) return;
          const k = `a|${href.replace(/\?m=[^&]+/, '')}`;
          if (seen.has(k)) return;
          seen.add(k);
          out.push({ kind: 'link', name, href, index });
        } else {
          const form = (el as HTMLButtonElement).form;
          const k = `b|${name}|${form?.action ?? ''}|${Array.from(form?.querySelectorAll('input[type=hidden]') ?? []).map((i) => (i as HTMLInputElement).value).join(',')}`;
          if (seen.has(k)) return;
          seen.add(k);
          out.push({ kind: 'button', name, index });
        }
      });
    });
    return out;
  }, new URL(base).origin + new URL(base).pathname);
}

async function check(page: Page, status: number | undefined, errors: string[]): Promise<string[]> {
  const p: string[] = [];
  if (status && status >= 400) p.push(`answered ${status}`);
  const body = await page.locator('body').innerText().catch(() => '');
  if (ARTIFACT.test(body)) p.push(`shows "${body.match(ARTIFACT)![0]}"`);
  if (DEAD.test(body)) p.push('a button went nowhere ("not available")');
  const h1 = await page.locator('h1').count();
  if (h1 !== 1) p.push(`${h1} level-1 headings`);
  if (errors.length) p.push(`browser errors: ${errors.slice(0, 2).join(' | ')}`);
  errors.length = 0;
  return p;
}

const browser = await chromium.launch();
const visits: Visit[] = [];
for (const student of STUDENTS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: { type: () => string; text: () => string }) => m.type() === 'error' && !/favicon|Content Security Policy|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const start = `${base}/s/${student}`;
  await page.goto(start);
  const explored = new Set<string>();
  const clicked = new Set<string>();
  let queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  let budget = BUDGET;
  while (queue.length && budget > 0) {
    const next: typeof queue = [];
    for (const { url, depth } of queue) {
      const key = screenKey(pathOf(url));
      if (explored.has(key) || depth >= DEPTH) continue;
      explored.add(key);
      await page.goto(url);
      const found = await controls(page);
      for (const ctl of found) {
        if (budget-- <= 0) break;
        if (SKIP.test(ctl.name)) continue;
        const id = `${key}|${ctl.kind}|${ctl.name}|${ctl.href ? screenKey(pathOf(ctl.href)) : ''}`;
        if (clicked.has(id)) continue;
        clicked.add(id);
        await page.goto(url);
        const before = { url: page.url(), text: await page.locator('main').innerText().catch(() => '') };
        let status: number | undefined;
        const target = page.locator('main, nav.tabs').getByRole(ctl.kind === 'link' ? 'link' : 'button', { name: ctl.name, exact: true }).first();
        // An earlier click can change what a screen offers (a dismissed note takes its buttons with it); a control
        // that is no longer there was not broken, so it is not clicked.
        if (!(await target.count())) continue;
        try {
          // A form that chooses something (a class, a length of time) is tried with a different choice than the one shown.
          await target.evaluate((el: Element) => {
            const sel = (el as HTMLButtonElement).form?.querySelector('select');
            if (sel && sel.options.length > 1) sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length;
            // A form that needs an answer gets a valid one, as a student would give, so the submit itself is tested
            // rather than the browser's own "please fill in this field".
            for (const i of Array.from((el as HTMLButtonElement).form?.querySelectorAll('input[required], textarea[required]') ?? []) as HTMLInputElement[]) {
              if (i.value) continue;
              if (i.type === 'number') {
                const lo = i.min === '' ? 0 : Number(i.min);
                const hi = i.max === '' ? lo + 100 : Number(i.max);
                i.value = String(Math.round(lo + (hi - lo) * 0.85));
              } else if (i.type === 'date') i.value = '2026-11-02';
              else i.value = 'Quiz 3';
            }
          });
          const [resp] = await Promise.all([page.waitForNavigation({ timeout: 8000 }).catch(() => null), target.click({ timeout: 4000 })]);
          status = resp?.status();
        } catch (e) {
          visits.push({ student, depth: depth + 1, from: key, control: `${ctl.kind} "${ctl.name}"`, to: '', problems: [`could not be clicked: ${(e as Error).message.split('\n')[0]}`] });
          continue;
        }
        await page.waitForLoadState('load');
        const problems = await check(page, status, errors);
        const after = { url: page.url(), text: await page.locator('main').innerText().catch(() => '') };
        if (after.url === before.url && after.text === before.text) problems.push('did nothing: same address and same screen');
        visits.push({ student, depth: depth + 1, from: key, control: `${ctl.kind} "${ctl.name}"`, to: pathOf(after.url), problems });
        next.push({ url: after.url, depth: depth + 1 });
      }
    }
    queue = next;
  }
  // Downloads and the end of the account: checked directly.
  for (const p of ['/export', '/calendar.ics']) {
    const r = await page.request.get(`${base}/s/${student}${p}`);
    visits.push({ student, depth: 1, from: '/s/:id/you', control: `download ${p}`, to: p, problems: r.status() === 200 ? [] : [`answered ${r.status()}`] });
  }
  await ctx.close();
}
await browser.close();

const failing = visits.filter((v) => v.problems.length);
const byDepth = visits.reduce<Record<number, number>>((m, v) => ((m[v.depth] = (m[v.depth] ?? 0) + 1), m), {});
writeFileSync(`${out}/deep.json`, JSON.stringify({ base, at: new Date().toISOString(), depth: DEPTH, students: STUDENTS, controls: visits.length, byDepth, maxDepth: Math.max(...visits.map((v) => v.depth)), screens: new Set(visits.map((v) => screenKey(v.to))).size, visits }, null, 1));
for (const f of failing) console.error(`${f.student} d${f.depth} ${f.from} > ${f.control} > ${f.to}: ${f.problems.join('; ')}`);
console.log(`deep click-through: ${visits.length} controls clicked across ${STUDENTS.length} students, down to depth ${Math.max(...visits.map((v) => v.depth))} (${Object.entries(byDepth).map(([d, n]) => `d${d} ${n}`).join(', ')}); ${failing.length} problems`);
process.exit(failing.length ? 1 : 0);
