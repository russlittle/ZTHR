import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright is provided by the environment (CI installs it); resolved at runtime.
const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright') as typeof import('playwright');
type Page = import('playwright').Page;

/**
 * Walk like a user (Pattern 16): drive the web app by accessible names only,
 * read each screen as structure (DOM, accessibility) and as pixels (screenshots),
 * and fail on any serious accessibility violation.
 */
const base = process.argv[2] ?? 'http://localhost:8787';
const out = process.argv[3] ?? 'evidence-out/ui';
mkdirSync(out, { recursive: true });
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function axe(page: Page, label: string): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  const r = (await page.evaluate(async () => (window as unknown as { axe: { run: (o: object) => Promise<{ violations: { id: string; impact: string; nodes: unknown[] }[] }> } }).axe.run({ resultTypes: ['violations'] }))) as { violations: { id: string; impact: string; nodes: unknown[] }[] };
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${label}: ${v.id} (${v.nodes.length})`);
}

const browser = await chromium.launch();
const failures: string[] = [];
for (const scheme of ['light', 'dark'] as const) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
  const step = async (name: string) => {
    await page.screenshot({ path: `${out}/${scheme}-${name}.png`, fullPage: true });
    failures.push(...(await axe(page, `${scheme}/${name}`)));
  };
  await page.goto(`${base}/demo`);
  await step('01-demo');
  await page.getByRole('link', { name: 'Maria' }).click();
  await page.getByText(/Rent on .* looks about \$\d+ short/).first().waitFor();
  await step('02-maria-today');
  await page.getByRole('button', { name: /Ask the landlord for more time/ }).first().click();
  await page.getByRole('heading', { name: 'To: landlord' }).waitFor();
  await step('03-draft');
  await page.getByRole('button', { name: 'Send it' }).first().click();
  await page.getByText('Sent. I will watch for a reply').waitFor();
  await step('04-sent');
  await page.getByRole('link', { name: 'Money' }).click();
  await page.getByRole('heading', { name: 'What I checked' }).waitFor();
  await step('05-money');
  await page.getByRole('link', { name: 'Help' }).click();
  await page.getByRole('button', { name: 'My power is getting shut off' }).click();
  await page.getByText(/payment plan/).first().waitFor();
  await step('06-shutoff');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Your record of consent' }).waitFor();
  await step('07-settings');
  await page.close();
}
await browser.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ui walk passed in light and dark: 7 screens each, no serious accessibility violations');
