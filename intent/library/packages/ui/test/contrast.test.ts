// Verifies docs/accessibility.md
import { describe, expect, it } from 'vitest';
import { THEMES, styles } from '../src/index.js';

/**
 * Contrast over the student app's gradient, computed rather than sampled. The soft color fields behind the panels
 * are the one place an automated checker cannot decide contrast, so this test composites every text color over the
 * strongest point of every field, in both themes, and holds each to WCAG 1.4.3 (4.5:1 for text).
 */
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const over = (top: number[], a: number, bottom: number[]) => top.map((t, i) => a * t + (1 - a) * bottom[i]!);
const lum = (c: number[]) => { const f = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); const [r, g, b] = c.map(f) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };

function fields(css: string, dark: boolean) {
  const block = dark ? css.slice(css.indexOf('@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--l-class')) : css.slice(css.indexOf(':root{--l-class'));
  const v = (name: string) => block.match(new RegExp(`--${name}:([^;}]+)`))![1]!.trim();
  const rgba = (x: string) => { const m = x.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)!; return { c: [m[1], m[2], m[3]].map((n) => Number(n) / 255), a: Number(m[4]) }; };
  return { g: ['g1', 'g2', 'g3', 'g4'].map((k) => rgba(v(k))), glass: rgba(v('glass')), paper: rgb(v('paper')) };
}

describe('text stays readable over the student app\'s gradient', () => {
  const css = styles('', 'student');
  for (const scheme of ['light', 'dark'] as const) {
    const t = THEMES.student[scheme];
    const f = fields(css, scheme === 'dark');
    const grounds = f.g.map((g) => over(g.c, g.a, f.paper));
    it(`${scheme}: text, muted text and links on the bare background meet 4.5:1 at the strongest point of every color field`, () => {
      for (const ground of grounds) for (const fg of [t.ink, t.muted, t.action]) expect(ratio(rgb(fg), ground)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${scheme}: the same colors inside a frosted panel meet 4.5:1`, () => {
      for (const ground of grounds) for (const fg of [t.ink, t.muted, t.action]) expect(ratio(rgb(fg), over(f.glass.c, f.glass.a, ground))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
