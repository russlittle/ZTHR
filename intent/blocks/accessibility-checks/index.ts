/**
 * Automated accessibility checks on generated markup, so a page that a machine can prove is broken never ships.
 * The markup is read with the html-parse block and checked against rules taken from WCAG 2.2 (A and AA, and AAA
 * contrast on request) and the ARIA in HTML rules: text alternatives for images and input images; accessible names
 * for links, buttons, form controls, frames and landmarks (aria-labelledby, aria-label, native labels, text, alt,
 * value and title, in that order, with hidden content left out); heading order and empty headings; landmarks (one
 * main, labelled duplicates, no nested banners); unique ids and references that point at something; valid roles and
 * aria-* names; no aria-hidden on anything a keyboard can reach; no positive tabindex; the page language and title;
 * captions on video; data tables with header cells; a zoomable viewport; and contrast, computed with the WCAG
 * relative-luminance formula from colours given inline (hex, rgb, hsl and common names), composited over their
 * backgrounds, with the large-text allowance.
 *
 * Each finding carries the rule, its impact (critical, serious, moderate, minor), the WCAG criterion, a plain message
 * saying what to change, and where the element is. `focusOrder` gives the tab sequence a keyboard user would get.
 *
 * Not here: anything that needs rendering (computed styles from stylesheets, overlap, focus visibility, target size),
 * speech or screen-reader behaviour, and colour names beyond the common set (an unknown name is not judged, never
 * guessed). Content that only a person can judge, such as whether alt text is accurate, is outside any machine check.
 */
import { attr, elements, parse, query, serialize, text as textOf } from '../html-parse/index.ts';
import type { Document, Element, Node } from '../html-parse/index.ts';

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';

export interface Finding {
  readonly rule: string;
  readonly impact: Impact;
  readonly wcag: string;
  readonly message: string;
  /** Where: a short path such as main > form > input:nth-child(2). */
  readonly where: string;
  /** The element's opening tag, for the report. */
  readonly html: string;
}

export interface Report {
  readonly findings: readonly Finding[];
  readonly counts: Readonly<Record<Impact, number>>;
  readonly elementsChecked: number;
  /** True when nothing critical or serious was found. */
  readonly ok: boolean;
}

export interface Options {
  /** Judge the markup as a whole page (needs one main, a title and a language). Default false for fragments. */
  readonly fullPage?: boolean;
  /** Contrast level: AA (4.5, large 3) or AAA (7, large 4.5). Default AA. */
  readonly level?: 'AA' | 'AAA';
  /** Colour of text and page with nothing declared. */
  readonly defaultColor?: string;
  readonly defaultBackground?: string;
  /** Rules to skip, by name. */
  readonly skip?: readonly string[];
}

// ---------------------------------------------------------------- colour

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const NAMED: Readonly<Record<string, string>> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  maroon: '#800000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff', lime: '#00ff00', olive: '#808000', navy: '#000080', teal: '#008080', aqua: '#00ffff',
  cyan: '#00ffff', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  dimgray: '#696969', dimgrey: '#696969', darkblue: '#00008b', darkred: '#8b0000', darkgreen: '#006400', transparent: '#00000000',
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A CSS colour as red, green, blue (0-255) and alpha (0-1); null when it is not one this block knows. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s in NAMED) return parseColor(NAMED[s]!);
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
  if (m) {
    const ch = (v: string, pct: string) => clamp(pct ? (Number(v) / 100) * 255 : Number(v), 0, 255);
    const a = m[7] === undefined ? 1 : clamp(m[8] ? Number(m[7]) / 100 : Number(m[7]), 0, 1);
    return { r: Math.round(ch(m[1]!, m[2]!)), g: Math.round(ch(m[3]!, m[4]!)), b: Math.round(ch(m[5]!, m[6]!)), a };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
  if (m) {
    const h = (Number(m[1]) % 360) / 360;
    const sat = clamp(Number(m[2]) / 100, 0, 1);
    const l = clamp(Number(m[3]) / 100, 0, 1);
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const f = (t0: number) => {
      const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    const a = m[4] === undefined ? 1 : clamp(m[5] ? Number(m[4]) / 100 : Number(m[4]), 0, 1);
    return { r: Math.round(f(h + 1 / 3) * 255), g: Math.round(f(h) * 255), b: Math.round(f(h - 1 / 3) * 255), a };
  }
  return null;
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: { r: number; g: number; b: number }): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** The WCAG contrast ratio, 1 to 21, of two opaque colours. */
export function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `top` laid over the opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: Math.round(top.r * a + under.r * (1 - a)), g: Math.round(top.g * a + under.g * (1 - a)), b: Math.round(top.b * a + under.b * (1 - a)), a: 1 };
}

// ---------------------------------------------------------------- markup helpers

function styleOf(el: Element): Map<string, string> {
  const out = new Map<string, string>();
  const raw = attr(el, 'style');
  if (!raw || raw.length > 4000) return out;
  let depth = 0;
  let cur = '';
  const parts: string[] = [];
  for (const ch of raw) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i > 0) out.set(p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).replace(/!important/i, '').trim());
  }
  return out;
}

function isHidden(el: Element): boolean {
  for (let n: Element | Document | null = el; n && n.type === 'element'; n = n.parent) {
    if (attr(n, 'hidden') !== undefined) return true;
    if (attr(n, 'aria-hidden') === 'true') return true;
    const st = styleOf(n);
    if (st.get('display') === 'none' || st.get('visibility') === 'hidden') return true;
  }
  return false;
}

/** Hidden from everyone, not only from assistive technology: nothing can reach it. */
function isGone(el: Element): boolean {
  for (let n: Element | Document | null = el; n && n.type === 'element'; n = n.parent) {
    if (attr(n, 'hidden') !== undefined) return true;
    const st = styleOf(n);
    if (st.get('display') === 'none' || st.get('visibility') === 'hidden') return true;
  }
  return false;
}

const byId = (doc: Document, id: string): Element | undefined => elements(doc).find((e) => attr(e, 'id') === id);
const root = (el: Element): Document => {
  let n: Element | Document = el;
  while (n.type === 'element' && n.parent) n = n.parent;
  return n as Document;
};

function contentName(el: Element, seen: Set<Element>): string {
  let s = '';
  const visit = (n: Node) => {
    if (n.type === 'text') s += n.value;
    else if (n.type === 'element') {
      if (isHiddenHere(n)) return;
      const own = attr(n, 'aria-label')?.trim();
      if (n.tag === 'img') s += ` ${own || attr(n, 'alt') || ''} `;
      else if (own) s += ` ${own} `;
      else if (n.tag === 'svg') {
        const t = n.children.find((c): c is Element => c.type === 'element' && c.tag === 'title');
        s += t ? ` ${textOf(t)} ` : '';
      } else for (const c of n.children) visit(c);
    }
  };
  const isHiddenHere = (n: Element) => attr(n, 'hidden') !== undefined || attr(n, 'aria-hidden') === 'true' || styleOf(n).get('display') === 'none';
  seen.add(el);
  for (const c of el.children) visit(c);
  return s.replace(/\s+/g, ' ').trim();
}

const ROLE_NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'cell', 'columnheader', 'rowheader', 'treeitem']);
const TEXT_INPUT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week', 'color', 'file', 'range', 'checkbox', 'radio']);

/** The accessible name of an element, by a simplified accessible-name algorithm. Empty when it has none. */
export function accessibleName(el: Element, doc: Document = root(el)): string {
  const lb = attr(el, 'aria-labelledby');
  if (lb) {
    const t = lb.split(/\s+/).map((id) => byId(doc, id)).filter((e): e is Element => !!e).map((e) => contentName(e, new Set())).join(' ').trim();
    if (t) return t;
  }
  const al = attr(el, 'aria-label')?.trim();
  if (al) return al;
  const type = (attr(el, 'type') ?? 'text').toLowerCase();
  if (el.tag === 'img') return (attr(el, 'alt') ?? '').trim() || (attr(el, 'title') ?? '').trim();
  if (el.tag === 'input' && type === 'image') return (attr(el, 'alt') ?? attr(el, 'value') ?? '').trim() || (attr(el, 'title') ?? '').trim();
  if (el.tag === 'input' && (type === 'submit' || type === 'reset' || type === 'button')) return (attr(el, 'value') ?? '').trim() || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '') || (attr(el, 'title') ?? '').trim();
  if (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea' || el.tag === 'meter' || el.tag === 'progress') {
    const id = attr(el, 'id');
    const labels: Element[] = [];
    if (id) labels.push(...query(doc, 'label').filter((l) => attr(l, 'for') === id));
    for (let p = el.parent; p && p.type === 'element'; p = p.parent) if (p.tag === 'label') labels.push(p);
    const t = labels.map((l) => contentName(l, new Set())).join(' ').trim();
    return t || (attr(el, 'title') ?? '').trim();
  }
  if (el.tag === 'iframe' || el.tag === 'frame') return (attr(el, 'title') ?? '').trim();
  if (el.tag === 'table') {
    const cap = el.children.find((c): c is Element => c.type === 'element' && c.tag === 'caption');
    if (cap) return contentName(cap, new Set());
  }
  if (el.tag === 'svg') {
    const t = el.children.find((c): c is Element => c.type === 'element' && c.tag === 'title');
    if (t) return textOf(t).trim();
  }
  const role = attr(el, 'role') ?? '';
  if (['a', 'button', 'summary', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'option', 'label', 'legend', 'caption'].includes(el.tag) || ROLE_NAME_FROM_CONTENT.has(role)) {
    const c = contentName(el, new Set());
    if (c) return c;
  }
  return (attr(el, 'title') ?? '').trim();
}

const ARIA_ROLES = new Set(['alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem']);
const ARIA_ATTRS = new Set(['activedescendant', 'atomic', 'autocomplete', 'braillelabel', 'brailleroledescription', 'busy', 'checked', 'colcount', 'colindex', 'colindextext', 'colspan', 'controls', 'current', 'describedby', 'description', 'details', 'disabled', 'dropeffect', 'errormessage', 'expanded', 'flowto', 'grabbed', 'haspopup', 'hidden', 'invalid', 'keyshortcuts', 'label', 'labelledby', 'level', 'live', 'modal', 'multiline', 'multiselectable', 'orientation', 'owns', 'placeholder', 'posinset', 'pressed', 'readonly', 'relevant', 'required', 'roledescription', 'rowcount', 'rowindex', 'rowindextext', 'rowspan', 'selected', 'setsize', 'sort', 'valuemax', 'valuemin', 'valuenow', 'valuetext']);

function focusable(el: Element): boolean {
  if (attr(el, 'disabled') !== undefined && ['button', 'input', 'select', 'textarea', 'fieldset'].includes(el.tag)) return false;
  const ti = attr(el, 'tabindex');
  if (ti !== undefined && /^-?\d+$/.test(ti.trim())) return true;
  if (el.tag === 'a' || el.tag === 'area') return attr(el, 'href') !== undefined;
  if (el.tag === 'input') return (attr(el, 'type') ?? '').toLowerCase() !== 'hidden';
  if (el.tag === 'button' || el.tag === 'select' || el.tag === 'textarea' || el.tag === 'summary') return true;
  if (el.tag === 'iframe') return true;
  if (['audio', 'video'].includes(el.tag)) return attr(el, 'controls') !== undefined;
  return attr(el, 'contenteditable') !== undefined && attr(el, 'contenteditable') !== 'false';
}

/** The elements a keyboard user reaches with Tab, in order: positive tabindex first (lowest first), then the rest in document order. */
export function focusOrder(doc: Document): Element[] {
  const all = elements(doc).filter((e) => focusable(e) && !isGone(e) && !(Number.parseInt(attr(e, 'tabindex') ?? '0', 10) < 0));
  const idx = (e: Element) => Number.parseInt(attr(e, 'tabindex') ?? '0', 10) || 0;
  const pos = all.filter((e) => idx(e) > 0).map((e, i) => ({ e, i })).sort((a, b) => idx(a.e) - idx(b.e) || a.i - b.i).map((x) => x.e);
  return [...pos, ...all.filter((e) => idx(e) <= 0)];
}

function where(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | Document | null = el; n && n.type === 'element' && parts.length < 6; n = n.parent) {
    const id = attr(n, 'id');
    if (id && /^[\w-]+$/.test(id)) {
      parts.unshift(`${n.tag}#${id}`);
      break;
    }
    const sibs = (n.parent?.children ?? []).filter((c): c is Element => c.type === 'element' && c.tag === n!.tag);
    parts.unshift(sibs.length > 1 ? `${n.tag}:nth-of-type(${sibs.indexOf(n) + 1})` : n.tag);
  }
  return parts.join(' > ');
}

function openTag(el: Element): string {
  const full = serialize({ ...el, children: [] } as Element);
  const tag = full.slice(0, full.indexOf('>') + 1);
  return tag.length > 160 ? tag.slice(0, 157) + '...' : tag;
}

// ---------------------------------------------------------------- rules

type Report1 = (el: Element, rule: string, impact: Impact, wcag: string, message: string) => void;

const IMPACT_ORDER: Impact[] = ['critical', 'serious', 'moderate', 'minor'];
const VAGUE_LINK = /^(click here|here|read more|more|link|this|learn more|details|continue)$/i;
const FILE_ALT = /^(?:img|image|photo|picture|dsc|screenshot)?[_-]?\d*\.(?:jpe?g|png|gif|webp|svg|avif|bmp)$|^(?:image|photo|picture|graphic|img)$/i;
const LANG = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

/** Checks markup and returns every finding. */
export function check(html: string, o: Options = {}): Report {
  const doc = parse(html);
  const skip = new Set(o.skip ?? []);
  const findings: Finding[] = [];
  const add: Report1 = (el, rule, impact, wcag, message) => {
    if (!skip.has(rule)) findings.push({ rule, impact, wcag, message, where: where(el), html: openTag(el) });
  };
  const all = elements(doc);
  const role = (e: Element) => (attr(e, 'role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';

  // Text alternatives
  for (const el of all) {
    if (el.tag === 'img' && !isGone(el)) {
      const alt = attr(el, 'alt');
      const r = role(el);
      if (alt === undefined && r !== 'presentation' && r !== 'none' && !accessibleName(el, doc)) add(el, 'image-alt', 'critical', '1.1.1', 'Give the image an alt attribute describing it, or alt="" if it is decorative.');
      else if (alt !== undefined && alt.trim() !== '' && FILE_ALT.test(alt.trim())) add(el, 'image-alt-filename', 'moderate', '1.1.1', `The alt text "${alt.trim()}" reads like a file name; say what the image shows.`);
      else if (alt === '' && (attr(el, 'aria-label') || attr(el, 'aria-labelledby'))) add(el, 'image-alt-conflict', 'minor', '1.1.1', 'An empty alt marks the image as decorative, but it also has a label.');
    }
    if (el.tag === 'input' && (attr(el, 'type') ?? '').toLowerCase() === 'image' && !accessibleName(el, doc)) add(el, 'input-image-alt', 'critical', '1.1.1', 'Give the image button an alt attribute naming what it does.');
    if (el.tag === 'svg' && role(el) === 'img' && !accessibleName(el, doc)) add(el, 'svg-img-alt', 'serious', '1.1.1', 'An svg with role="img" needs a title or aria-label.');
    if (el.tag === 'area' && attr(el, 'href') !== undefined && !(attr(el, 'alt') ?? '').trim()) add(el, 'area-alt', 'critical', '1.1.1', 'Give the image map area an alt attribute.');
  }

  // Names
  for (const el of all) {
    if (isGone(el)) continue;
    if (el.tag === 'a' && attr(el, 'href') !== undefined) {
      const n = accessibleName(el, doc);
      if (!n) add(el, 'link-name', 'serious', '2.4.4', 'This link has no text, image alt or label; say where it goes.');
      else if (VAGUE_LINK.test(n)) add(el, 'link-purpose', 'minor', '2.4.4', `The link text "${n}" does not say where it goes.`);
    }
    if ((el.tag === 'button' || role(el) === 'button') && !accessibleName(el, doc)) add(el, 'button-name', 'critical', '4.1.2', 'This button has no text or label; say what it does.');
    if (el.tag === 'iframe' && !accessibleName(el, doc)) add(el, 'frame-title', 'serious', '4.1.2', 'Give the iframe a title.');
    if (el.tag === 'select' || el.tag === 'textarea' || (el.tag === 'input' && !['hidden', 'submit', 'reset', 'button', 'image'].includes((attr(el, 'type') ?? 'text').toLowerCase()) && TEXT_INPUT_TYPES.has((attr(el, 'type') ?? 'text').toLowerCase()))) {
      if (!accessibleName(el, doc)) add(el, 'label', 'critical', '1.3.1', attr(el, 'placeholder') ? 'A placeholder disappears when typing and is not a label; add a visible label.' : 'This form field has no label; connect a label with for/id, wrap it, or add aria-label.');
    }
    if (role(el) && ['checkbox', 'radio', 'switch', 'textbox', 'combobox', 'slider', 'spinbutton', 'searchbox', 'tab', 'menuitem'].includes(role(el)) && !['input', 'select', 'textarea', 'button', 'a'].includes(el.tag) && !accessibleName(el, doc))
      add(el, 'aria-name', 'serious', '4.1.2', `An element with role="${role(el)}" needs an accessible name.`);
  }

  // References and ids
  const ids = new Map<string, Element[]>();
  for (const el of all) {
    const id = attr(el, 'id');
    if (id) ids.set(id, [...(ids.get(id) ?? []), el]);
  }
  for (const [id, list] of ids) if (list.length > 1) for (const el of list.slice(1)) add(el, 'duplicate-id', 'moderate', '4.1.1', `The id "${id}" is used more than once; ids must be unique.`);
  for (const el of all) {
    for (const a of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant']) {
      const v = attr(el, a);
      if (v === undefined) continue;
      const missing = v.split(/\s+/).filter((id) => id && !ids.has(id));
      if (missing.length) add(el, 'aria-reference', 'serious', '1.3.1', `${a} points at ${missing.map((m) => `"${m}"`).join(', ')}, which ${missing.length > 1 ? 'do' : 'does'} not exist.`);
    }
    if (el.tag === 'label' && attr(el, 'for') && !ids.has(attr(el, 'for')!)) add(el, 'label-for', 'serious', '1.3.1', `The label's for="${attr(el, 'for')}" matches no element.`);
  }

  // ARIA validity
  for (const el of all) {
    for (const a of el.attrs) {
      if (a.name.startsWith('aria-') && !ARIA_ATTRS.has(a.name.slice(5))) add(el, 'aria-attr', 'serious', '4.1.2', `${a.name} is not an ARIA attribute.`);
    }
    const r = attr(el, 'role');
    if (r !== undefined) {
      const first = r.trim().toLowerCase().split(/\s+/);
      if (!first.some((x) => ARIA_ROLES.has(x))) add(el, 'aria-role', 'serious', '4.1.2', `role="${r}" is not a valid role.`);
    }
    if (attr(el, 'aria-hidden') === 'true' && (focusable(el) || query(el, 'a[href], button, input, select, textarea, [tabindex]').some((d) => focusable(d) && !(Number.parseInt(attr(d, 'tabindex') ?? '0', 10) < 0))) && !isGone(el))
      add(el, 'aria-hidden-focus', 'serious', '4.1.2', 'aria-hidden hides this from screen readers but a keyboard can still reach something inside; remove it or add tabindex="-1".');
    if (['presentation', 'none'].includes(role(el)) && focusable(el)) add(el, 'presentation-focusable', 'serious', '4.1.2', 'A focusable element cannot be presentational; remove the role.');
    const ti = Number.parseInt(attr(el, 'tabindex') ?? '', 10);
    if (ti > 0) add(el, 'tabindex-positive', 'serious', '2.4.3', 'A tabindex above 0 changes the tab order away from the reading order; use 0 or -1.');
    if (el.tag === 'a' && query(el, 'a, button, input, select, textarea').length) add(el, 'nested-interactive', 'serious', '4.1.2', 'Interactive controls must not be nested inside a link.');
    if (el.tag === 'button' && query(el, 'a[href], button, input, select, textarea').length) add(el, 'nested-interactive', 'serious', '4.1.2', 'Interactive controls must not be nested inside a button.');
  }
  const autofocus = all.filter((e) => attr(e, 'autofocus') !== undefined);
  for (const el of autofocus.slice(1)) add(el, 'autofocus-many', 'minor', '3.2.1', 'Only one element should take focus on load.');

  // Headings
  let prev = 0;
  const h1s = all.filter((e) => e.tag === 'h1');
  for (const el of all) {
    const m = /^h([1-6])$/.exec(el.tag);
    const lvl = m ? Number(m[1]) : role(el) === 'heading' ? Number(attr(el, 'aria-level') ?? 2) : 0;
    if (!lvl || isGone(el)) continue;
    if (!accessibleName(el, doc)) add(el, 'empty-heading', 'serious', '2.4.6', 'This heading is empty; give it text or remove it.');
    if (prev && lvl > prev + 1) add(el, 'heading-order', 'moderate', '1.3.1', `The heading level jumps from h${prev} to h${lvl}; do not skip levels.`);
    prev = lvl;
  }
  if (h1s.length > 1) for (const el of h1s.slice(1)) add(el, 'multiple-h1', 'minor', '1.3.1', 'There is more than one h1; a page has one main heading.');

  // Landmarks
  const banner = (e: Element) => e.tag === 'header' ? !isInside(e, ['article', 'aside', 'main', 'nav', 'section']) : role(e) === 'banner';
  const mains = all.filter((e) => e.tag === 'main' || role(e) === 'main');
  const navs = all.filter((e) => e.tag === 'nav' || role(e) === 'navigation');
  if (navs.length > 1) for (const n of navs) if (!accessibleName(n, doc) || !(attr(n, 'aria-label') || attr(n, 'aria-labelledby'))) add(n, 'landmark-unique', 'moderate', '1.3.1', 'There is more than one navigation landmark; give each its own aria-label.');
  if (mains.length > 1) for (const m of mains.slice(1)) add(m, 'landmark-one-main', 'moderate', '1.3.1', 'A page has one main landmark.');
  if (o.fullPage && mains.length === 0 && !skip.has('landmark-one-main')) findings.push({ rule: 'landmark-one-main', impact: 'moderate', wcag: '1.3.1', message: 'The page has no main landmark.', where: '(page)', html: '' });
  const banners = all.filter(banner);
  if (banners.length > 1) for (const b of banners.slice(1)) add(b, 'landmark-banner', 'moderate', '1.3.1', 'There is more than one top-level banner (header).');
  const forms = all.filter((e) => e.tag === 'form' && role(e) === '');
  if (forms.length > 1) for (const f of forms) if (!accessibleName(f, doc)) add(f, 'landmark-unique', 'moderate', '1.3.1', 'There is more than one form; give each an aria-label.');

  // Page
  const htmlEl = all.find((e) => e.tag === 'html');
  if (htmlEl || o.fullPage) {
    const lang = htmlEl ? attr(htmlEl, 'lang') ?? attr(htmlEl, 'xml:lang') : undefined;
    if (lang === undefined || lang.trim() === '') {
      if (!skip.has('html-lang')) findings.push({ rule: 'html-lang', impact: 'serious', wcag: '3.1.1', message: 'The html element needs a lang attribute.', where: 'html', html: htmlEl ? openTag(htmlEl) : '' });
    } else if (!LANG.test(lang.trim())) add(htmlEl!, 'html-lang-valid', 'serious', '3.1.1', `lang="${lang}" is not a language tag.`);
    const title = query(doc, 'title')[0];
    if ((!title || !textOf(title).trim()) && !skip.has('document-title')) findings.push({ rule: 'document-title', impact: 'serious', wcag: '2.4.2', message: 'The page needs a non-empty title.', where: 'head', html: '' });
  }
  for (const m of query(doc, 'meta')) {
    const name = (attr(m, 'name') ?? '').toLowerCase();
    const content = (attr(m, 'content') ?? '').toLowerCase();
    if (name === 'viewport') {
      const scale = /(?:^|[,;\s])maximum-scale\s*=\s*([\d.]+)/.exec(content);
      if (/user-scalable\s*=\s*(no|0)/.test(content) || (scale && Number(scale[1]) < 2)) add(m, 'viewport-zoom', 'critical', '1.4.4', 'The viewport stops people zooming; remove user-scalable=no and keep maximum-scale at 2 or more.');
    }
    if ((attr(m, 'http-equiv') ?? '').toLowerCase() === 'refresh' && /^\s*[1-9]/.test(content)) add(m, 'meta-refresh', 'critical', '2.2.1', 'A timed refresh or redirect takes control from the reader.');
  }

  // Media and tables
  for (const v of all.filter((e) => e.tag === 'video')) if (!query(v, 'track').some((t) => ['captions', 'subtitles'].includes((attr(t, 'kind') ?? '').toLowerCase())) && attr(v, 'muted') === undefined) add(v, 'video-captions', 'critical', '1.2.2', 'Add a captions track to this video.');
  for (const a of all.filter((e) => e.tag === 'audio' || e.tag === 'video')) if (attr(a, 'autoplay') !== undefined && attr(a, 'muted') === undefined && attr(a, 'controls') === undefined) add(a, 'media-autoplay', 'serious', '1.4.2', 'Media that plays by itself for more than three seconds needs a way to pause it.');
  for (const t of all.filter((e) => e.tag === 'table' && !['presentation', 'none'].includes(role(e)))) {
    const cells = query(t, 'td').length;
    if (cells && !query(t, 'th').length) add(t, 'table-headers', 'serious', '1.3.1', 'A data table needs header cells (th); use role="presentation" if it is only layout.');
    for (const th of query(t, 'th')) if (!accessibleName(th, doc) && !th.children.length) add(th, 'empty-th', 'moderate', '1.3.1', 'This header cell is empty.');
  }
  for (const l of all.filter((e) => e.tag === 'ul' || e.tag === 'ol')) if (l.children.some((c) => c.type === 'element' && !['li', 'script', 'template'].includes(c.tag))) add(l, 'list-children', 'minor', '1.3.1', 'A list may contain only li elements directly.');
  for (const li of all.filter((e) => e.tag === 'li')) if (li.parent?.type === 'element' && !['ul', 'ol', 'menu'].includes(li.parent.tag) && role(li.parent) !== 'list') add(li, 'li-parent', 'minor', '1.3.1', 'A list item belongs inside a ul or ol.');

  // Contrast
  const level = o.level ?? 'AA';
  const defFg = parseColor(o.defaultColor ?? '#000000') ?? { r: 0, g: 0, b: 0, a: 1 };
  const defBg = parseColor(o.defaultBackground ?? '#ffffff') ?? { r: 255, g: 255, b: 255, a: 1 };
  for (const el of all) {
    if (isHidden(el) || !el.children.some((c) => c.type === 'text' && c.value.trim() !== '')) continue;
    if (['script', 'style', 'title'].includes(el.tag)) continue;
    const verdict = textContrast(el, defFg, defBg);
    if (!verdict) continue;
    const need = verdict.large ? (level === 'AAA' ? 4.5 : 3) : level === 'AAA' ? 7 : 4.5;
    if (verdict.ratio + 1e-9 < need) add(el, 'color-contrast', level === 'AAA' ? 'moderate' : 'serious', level === 'AAA' ? '1.4.6' : '1.4.3', `The contrast ratio is ${verdict.ratio.toFixed(2)}:1; ${need}:1 is needed for ${verdict.large ? 'large ' : ''}text.`);
  }

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) counts[f.impact]++;
  findings.sort((a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact));
  return { findings, counts, elementsChecked: all.length, ok: counts.critical + counts.serious === 0 };
}

function isInside(e: Element, tags: string[]): boolean {
  for (let p = e.parent; p && p.type === 'element'; p = p.parent) if (tags.includes(p.tag)) return true;
  return false;
}

const DEFAULT_SIZE: Record<string, number> = { h1: 32, h2: 24, h3: 18.72, h4: 16, h5: 13.28, h6: 10.72, small: 13.33 };

/** The contrast of the text in one element from inline colours; null when it cannot be judged. */
function textContrast(el: Element, defFg: Rgba, defBg: Rgba): { ratio: number; large: boolean } | null {
  let fg: Rgba | null | undefined;
  let size: number | undefined;
  let bold = false;
  let anyColor = false;
  const layers: Rgba[] = [];
  for (let n: Element | Document | null = el; n && n.type === 'element'; n = n.parent) {
    const st = styleOf(n);
    if (fg === undefined && st.has('color')) {
      fg = parseColor(st.get('color')!);
      if (!fg) return null;
      anyColor = true;
    }
    const bgImage = st.get('background-image') ?? (/gradient|url\(/i.test(st.get('background') ?? '') ? 'x' : undefined);
    if (bgImage && bgImage !== 'none') return null;
    const bgv = st.get('background-color') ?? (st.has('background') ? st.get('background')!.split(/\s+(?![^(]*\))/)[0] : undefined);
    if (bgv !== undefined) {
      const c = parseColor(bgv);
      if (!c) return null;
      anyColor = true;
      layers.push(c);
      if (c.a >= 1) break;
    }
    if (size === undefined && st.has('font-size')) {
      const m = /^([\d.]+)(px|pt)$/.exec(st.get('font-size')!);
      if (m) size = Number(m[1]) * (m[2] === 'pt' ? 4 / 3 : 1);
    }
    const fw = st.get('font-weight');
    if (!bold && fw && (fw === 'bold' || fw === 'bolder' || Number(fw) >= 700)) bold = true;
    if (!bold && (n.tag === 'b' || n.tag === 'strong' || /^h[1-6]$/.test(n.tag)) && el === n) bold = true;
  }
  if (!anyColor) return null;
  let bg = defBg;
  for (let i = layers.length - 1; i >= 0; i--) bg = composite(layers[i]!, bg);
  const top = composite(fg ?? defFg, bg);
  const px = size ?? DEFAULT_SIZE[el.tag] ?? 16;
  return { ratio: contrastRatio(top, bg), large: px >= 24 || (bold && px >= 18.66) };
}

/** One line per finding, most serious first, for a log or a pull request comment. */
export function formatReport(r: Report): string {
  if (!r.findings.length) return `No accessibility problems found in ${r.elementsChecked} elements.`;
  const head = `${r.findings.length} problem${r.findings.length === 1 ? '' : 's'}: ${IMPACT_ORDER.filter((i) => r.counts[i]).map((i) => `${r.counts[i]} ${i}`).join(', ')}`;
  return [head, ...r.findings.map((f) => `[${f.impact}] ${f.rule} (WCAG ${f.wcag}) ${f.where}: ${f.message}`)].join('\n');
}

