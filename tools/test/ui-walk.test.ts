// Verifies docs/testing/ui-walk.md
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../../apps/advocate/src/server/app.ts', import.meta.url)), 'utf8');
const walk = readFileSync(fileURLToPath(new URL('../ui/walk.ts', import.meta.url)), 'utf8');
const screens = JSON.parse(walk.match(/const SCREENS = (\[[^\]]*\])/)![1]!.replace(/'/g, '"')) as string[];

describe('the browser walk covers every screen', () => {
  const routes = [...app.matchAll(/app\.get\('\/s\/:id([^']*)'/g)].map((m) => m[1]!).filter((r) => !/export|calendar|resource|share|settings/.test(r));
  for (const r of routes) it(`walks ${r || '(today)'}`, () => expect(screens).toContain(r));
  it('checks accessibility, headings, tap targets and sideways scroll', () => {
    for (const needle of ['axe.run', "querySelectorAll('h1')", '43.5', 'scrollWidth']) expect(walk).toContain(needle);
  });
  it('checks every WCAG 2.2 A and AA rule, and fails on any violation whatever its impact', () => {
    expect(walk).toContain("['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']");
    expect(walk).toContain("runOnly: { type: 'tag'");
    expect(walk).not.toMatch(/impact === 'serious'/);
  });
  it('reads what a screen reader is given, and checks focus, text spacing and reflow', () => {
    for (const needle of ['ariaSnapshot()', 'focusNotObscured', 'textSpacing', 'width: 320', 'documentElement.lang']) expect(walk).toContain(needle);
  });
  it('walks phone and desktop, light and dark', () => {
    expect(walk).toMatch(/phone: \{ width: 390/);
    expect(walk).toMatch(/desktop: \{ width: 1280/);
    expect(walk).toContain("['light', 'dark']");
  });
});
