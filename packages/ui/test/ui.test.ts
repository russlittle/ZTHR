// Verifies docs/blocks/ui.md (escaping, accessible names, shells).
import { describe, expect, it } from 'vitest';
import * as ui from '../src/index.js';

const EVIL = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "' onmouseover='x", '&lt;already&gt;', '</style><script>x</script>'];
// Raw markup from the input would show up as a real tag or as an attribute inside a real tag.
// Quoted attribute values are dropped first, so escaped text inside a value cannot look like an attribute.
const raw = (h: string) => /<script|<img|<[^>]*\s(onerror|onmouseover)=/.test(h.replace(/="[^"]*"/g, '=""'));

describe('every component escapes everything it interpolates', () => {
  for (const e of EVIL) {
    it(`note escapes ${JSON.stringify(e)}`, () => expect(raw(ui.note({ title: e, from: e, body: e, why: e, id: e, actions: [{ label: e, href: e }, { label: e, post: { url: e, fields: { [e]: e } } }] }))).toBe(false));
    it(`dayLine escapes ${JSON.stringify(e)}`, () => expect(raw(ui.dayLine([{ time: e, title: e, sub: e, kind: 'class' }], e))).toBe(false));
    it(`rows escapes ${JSON.stringify(e)}`, () => expect(raw(ui.rows([{ title: e, sub: e, href: e, chip: { text: e }, actions: [{ label: e, href: e }] }], e))).toBe(false));
    it(`tiles escapes ${JSON.stringify(e)}`, () => expect(raw(ui.tiles([{ label: e, href: e }, { label: e, post: { url: e, fields: { a: e } } }], e))).toBe(false));
    it(`form escapes ${JSON.stringify(e)}`, () => expect(raw(ui.form({ url: e, submit: e, hidden: { a: e }, fields: [{ name: e, label: e, value: e, placeholder: e, hint: e }, { name: 'b', label: e, value: e, multiline: 3 }] }))).toBe(false));
    it(`weekGrid escapes ${JSON.stringify(e)}`, () => expect(raw(ui.weekGrid([{ label: e, problem: e, blocks: [{ time: e, title: e, kind: e }] }]))).toBe(false));
    it(`table escapes ${JSON.stringify(e)}`, () => expect(raw(ui.table([e], [[e]], { caption: e }))).toBe(false));
    it(`kpis, chip, bar, figure, section escape ${JSON.stringify(e)}`, () => expect(raw(ui.kpis([{ value: e, label: e }]) + ui.chip(e) + ui.bar(0.5, e) + ui.figure(e, e) + ui.section(e, ''))).toBe(false));
    it(`shells escape ${JSON.stringify(e)}`, () => {
      expect(raw(ui.appShell({ title: e, body: '', brand: e, brandHref: e, nav: [{ href: e, label: e }], description: e }))).toBe(false);
      expect(raw(ui.consoleShell({ title: e, body: '', groups: [{ title: e, items: [{ href: e, label: e }] }] }))).toBe(false);
    });
  }
});

describe('accessibility basics', () => {
  it('marks the current tab', () => expect(ui.appShell({ title: 't', body: '', nav: [{ href: '/a', label: 'A', current: true }] })).toContain('aria-current="page"'));
  it('every form control has a label', () => {
    const h = ui.form({ url: '/x', submit: 'Go', fields: [{ name: 'a', label: 'A' }, { name: 'b', label: 'B', multiline: 2 }] });
    for (const id of h.match(/id="(f-[^"]+)"/g)!.map((m) => m.slice(4, -1))) expect(h).toContain(`for="${id}"`);
  });
  it('icons are hidden from assistive tech', () => expect(ui.icon('today')).toContain('aria-hidden="true"'));
  it('has a skip link and a main landmark', () => {
    const h = ui.appShell({ title: 't', body: 'x' });
    expect(h).toContain('href="#main"');
    expect(h).toContain('<main id="main"');
  });
  it('defines dark tokens for both the media query and the explicit theme', () => {
    const css = ui.styles();
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toContain(':root[data-theme="dark"]');
  });
  it('serves only its own font files', () => {
    expect(ui.uiAsset('atkinson-400.woff2')?.type).toBe('font/woff2');
    expect(ui.uiAsset('../package.json')).toBeUndefined();
  });
  it('renders nothing for an empty day', () => expect(ui.dayLine([])).toBe(''));
});
