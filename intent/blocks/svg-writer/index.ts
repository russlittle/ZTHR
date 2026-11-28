/**
 * Clean SVG 1.1 / SVG 2 output written by code, with accessibility text built in and nothing unsafe expressible. A
 * document needs a title (and says so when it does not) or is marked decorative; its title and description are
 * written as <title> and <desc> with ids tied together by aria-labelledby, so assistive technology reads them, and
 * the document carries role="img". Elements come from a closed list (no script, foreignObject, animation or
 * external images), attribute names are checked, event-handler attributes and external references are refused
 * (only "#id" links), paints must be a colour, a keyword or a "url(#id)" to something in the document, style
 * values may not fetch anything, text and attribute values are escaped, characters XML cannot hold are removed, and
 * ids are unique per document and can carry a prefix so several SVGs on one page cannot capture each other's
 * gradients. Numbers are written with bounded precision and never as NaN, Infinity or "-0". The path writer builds
 * every path command (M L H V C S Q T A Z, absolute or relative) and its parser reads path data back, including the
 * compact forms browsers accept (implicit repeats, arc flags without separators), so paths can be validated,
 * normalised and tested. Gradients return the paint to use. Output is deterministic, optionally indented.
 * Out of scope: filters, masks, patterns, animation, CSS stylesheets, text layout beyond a rough width estimate,
 * path boolean operations and arc flattening, and rasterising (see the pdf and imagemeta blocks).
 */

export class SvgError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Numbers and escaping

/** A number as written in SVG: rounded to `precision` decimals, no trailing zeros, no "-0". Refuses NaN and infinities. */
export function num(n: number, precision = 3): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new SvgError(`${String(n)} is not a finite number`);
  const f = 10 ** precision;
  let r = Math.round(n * f) / f;
  if (Object.is(r, -0)) r = 0;
  let s = r.toFixed(precision);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const cleanXml = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

export const escapeText = (s: string): string => cleanXml(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

const PAINT = /^(?:none|currentColor|transparent|inherit|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/-]+\)|[a-zA-Z]{3,25}|url\(#[A-Za-z_][\w.:-]*\)(?:\s+(?:none|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,25}))?)$/;

/** Returns the paint if it is a colour, a keyword or a local url(#id); throws otherwise. */
export function paint(value: string): string {
  if (!PAINT.test(value.trim())) throw new SvgError(`"${value}" is not a colour, a keyword or a local url(#id)`);
  return value.trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Elements

const TAGS = new Set(['svg', 'g', 'defs', 'title', 'desc', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'marker', 'symbol', 'use']);
const ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9]*(?:[:-][a-zA-Z0-9]+)*$/;
const PAINT_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'color', 'flood-color']);
const UNSAFE_STYLE = /url\s*\(\s*(?!['"]?#)|@import|expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding/i;

export type AttrValue = string | number | boolean | undefined;
export type Attrs = Readonly<Record<string, AttrValue>>;

export interface SvgNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly (SvgNode | string)[];
}

function attrString(tag: string, name: string, v: string | number | boolean): string {
  if (!ATTR_NAME.test(name)) throw new SvgError(`"${name}" is not an attribute name`);
  if (/^on/i.test(name)) throw new SvgError(`the event-handler attribute "${name}" is not allowed`);
  if (typeof v === 'number') return num(v, 4);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (name === 'href' || name === 'xlink:href') {
    if (!/^#[A-Za-z_][\w.:-]*$/.test(v)) throw new SvgError(`${name} may only point to an element in this document ("#id"), not "${v}"`);
    return v;
  }
  if (PAINT_ATTRS.has(name)) return paint(v);
  if (name === 'style' && UNSAFE_STYLE.test(v)) throw new SvgError('a style value may not load anything or run anything');
  if (/^\s*(?:javascript|data|vbscript):/i.test(v)) throw new SvgError(`the value of ${name} may not be a script or data URL`);
  if (tag === 'svg' && name === 'xmlns') throw new SvgError('xmlns is written for you');
  return cleanXml(v);
}

/** Builds an element from the closed tag list; undefined attributes are dropped. */
export function el(tag: string, attrs: Attrs = {}, ...children: (SvgNode | string | undefined)[]): SvgNode {
  if (!TAGS.has(tag)) throw new SvgError(`<${tag}> is not an element this writer can produce`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = attrString(tag, k, v);
  return { tag, attrs: out, children: children.filter((c): c is SvgNode | string => c !== undefined) };
}

export const rect = (x: number, y: number, width: number, height: number, attrs: Attrs = {}): SvgNode => {
  if (width < 0 || height < 0) throw new SvgError('a rectangle cannot have a negative width or height');
  return el('rect', { x, y, width, height, ...attrs });
};
export const circle = (cx: number, cy: number, r: number, attrs: Attrs = {}): SvgNode => {
  if (r < 0) throw new SvgError('a circle cannot have a negative radius');
  return el('circle', { cx, cy, r, ...attrs });
};
export const ellipse = (cx: number, cy: number, rx: number, ry: number, attrs: Attrs = {}): SvgNode => el('ellipse', { cx, cy, rx, ry, ...attrs });
export const line = (x1: number, y1: number, x2: number, y2: number, attrs: Attrs = {}): SvgNode => el('line', { x1, y1, x2, y2, ...attrs });
const pts = (points: readonly (readonly [number, number])[]) => points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
export const polyline = (points: readonly (readonly [number, number])[], attrs: Attrs = {}): SvgNode => el('polyline', { points: pts(points), fill: 'none', ...attrs });
export const polygon = (points: readonly (readonly [number, number])[], attrs: Attrs = {}): SvgNode => el('polygon', { points: pts(points), ...attrs });
export const group = (attrs: Attrs = {}, ...children: (SvgNode | string | undefined)[]): SvgNode => el('g', attrs, ...children);
export const pathEl = (d: Path | string, attrs: Attrs = {}): SvgNode => el('path', { d: typeof d === 'string' ? serializePath(parsePath(d)) : d.toString(), ...attrs });

/** Text, escaped. A string with line breaks becomes tspans stacked by `lineHeight` (in em, default 1.2). */
export function text(content: string, x: number, y: number, attrs: Attrs = {}, lineHeight = 1.2): SvgNode {
  const lines = cleanXml(content).split(/\r\n|\r|\n/);
  if (lines.length === 1) return el('text', { x, y, ...attrs }, lines[0]);
  return el('text', { x, y, ...attrs }, ...lines.map((l, i) => el('tspan', { x, dy: i === 0 ? '0' : `${num(lineHeight, 3)}em` }, l)));
}

/** A group (or any element) made readable to assistive technology: a title and optional description as its first children. */
export function labelled(node: SvgNode, title: string, desc?: string): SvgNode {
  return { ...node, attrs: { ...node.attrs, role: node.attrs['role'] ?? 'img' }, children: [el('title', {}, title), ...(desc ? [el('desc', {}, desc)] : []), ...node.children] };
}

/** A rough text width in the same units as the font size, for laying out axes. Proportional sans-serif: narrow letters 0.28 em, capitals 0.68 em, others 0.54 em, wide ones 0.85 em. */
export function estimateTextWidth(content: string, fontSize: number): number {
  let em = 0;
  for (const ch of content) {
    if ('il.,:;|!\'` '.includes(ch)) em += 0.28;
    else if ('mwMW@%'.includes(ch)) em += 0.85;
    else if (/[A-Z0-9]/.test(ch)) em += 0.68;
    else if (/[　-鿿＀-￯]/.test(ch)) em += 1;
    else em += 0.54;
  }
  return em * fontSize;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

export type PathCommand = 'M' | 'L' | 'H' | 'V' | 'C' | 'S' | 'Q' | 'T' | 'A' | 'Z' | 'm' | 'l' | 'h' | 'v' | 'c' | 's' | 'q' | 't' | 'a' | 'z';

export interface PathSegment {
  readonly command: PathCommand;
  readonly args: readonly number[];
}

const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Path data as segments, from the grammar browsers accept. Throws with the offset of the first thing wrong. */
export function parsePath(d: string): PathSegment[] {
  const out: PathSegment[] = [];
  let i = 0;
  const ws = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const number = (): number => {
    ws();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
    if (!m) throw new SvgError(`path data: expected a number at offset ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number => {
    ws();
    const c = d[i];
    if (c !== '0' && c !== '1') throw new SvgError(`path data: an arc flag must be 0 or 1 at offset ${i}`);
    i++;
    return Number(c);
  };
  ws();
  if (i >= d.length) return out;
  if (!/[Mm]/.test(d[i]!)) throw new SvgError('path data must begin with a moveto (M or m)');
  let current: string | undefined;
  while (true) {
    ws();
    if (i >= d.length) break;
    const c = d[i]!;
    if (/[A-Za-z]/.test(c)) {
      if (!(c.toLowerCase() in ARITY)) throw new SvgError(`path data: "${c}" is not a path command at offset ${i}`);
      current = c;
      i++;
      if (c === 'z' || c === 'Z') {
        out.push({ command: c, args: [] });
        continue;
      }
    } else if (current === undefined || current === 'z' || current === 'Z') throw new SvgError(`path data: unexpected "${c}" at offset ${i}`);
    const lower = current!.toLowerCase();
    const args: number[] = [];
    for (let k = 0; k < ARITY[lower]!; k++) args.push(lower === 'a' && (k === 3 || k === 4) ? flag() : number());
    if (lower === 'a' && (args[0]! < 0 || args[1]! < 0)) throw new SvgError('path data: an arc radius cannot be negative');
    // After a moveto, further pairs are implicit linetos.
    out.push({ command: current as PathCommand, args });
    if (lower === 'm') current = current === 'm' ? 'l' : 'L';
  }
  return out;
}

/** Path data in its compact form: command letters, numbers separated by a space only where needed. */
export function serializePath(segments: readonly PathSegment[], precision = 3): string {
  let s = '';
  for (const seg of segments) {
    const lower = seg.command.toLowerCase();
    if (seg.args.length !== ARITY[lower]) throw new SvgError(`${seg.command} takes ${ARITY[lower]} numbers, not ${seg.args.length}`);
    s += seg.command;
    seg.args.forEach((a, k) => {
      if (lower === 'a' && (k === 3 || k === 4) && a !== 0 && a !== 1) throw new SvgError('an arc flag must be 0 or 1');
      const n = num(a, precision);
      s += k === 0 || n.startsWith('-') ? n : ` ${n}`;
    });
  }
  return s;
}

/** Builds path data. Every method takes absolute coordinates unless it ends in "By" (relative). */
export class Path {
  private readonly segs: PathSegment[] = [];
  private started = false;

  private push(command: PathCommand, args: number[]): this {
    if (!this.started && command !== 'M' && command !== 'm') throw new SvgError('a path must begin with moveTo');
    for (const a of args) if (!Number.isFinite(a)) throw new SvgError(`${String(a)} is not a finite number`);
    this.started = true;
    this.segs.push({ command, args });
    return this;
  }
  moveTo(x: number, y: number): this { return this.push('M', [x, y]); }
  moveBy(dx: number, dy: number): this { return this.push('m', [dx, dy]); }
  lineTo(x: number, y: number): this { return this.push('L', [x, y]); }
  lineBy(dx: number, dy: number): this { return this.push('l', [dx, dy]); }
  horizontalTo(x: number): this { return this.push('H', [x]); }
  horizontalBy(dx: number): this { return this.push('h', [dx]); }
  verticalTo(y: number): this { return this.push('V', [y]); }
  verticalBy(dy: number): this { return this.push('v', [dy]); }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this { return this.push('C', [x1, y1, x2, y2, x, y]); }
  curveBy(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this { return this.push('c', [x1, y1, x2, y2, x, y]); }
  smoothCurveTo(x2: number, y2: number, x: number, y: number): this { return this.push('S', [x2, y2, x, y]); }
  quadTo(x1: number, y1: number, x: number, y: number): this { return this.push('Q', [x1, y1, x, y]); }
  smoothQuadTo(x: number, y: number): this { return this.push('T', [x, y]); }
  arcTo(rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, x: number, y: number): this {
    if (rx < 0 || ry < 0) throw new SvgError('an arc radius cannot be negative');
    return this.push('A', [rx, ry, rotation, largeArc ? 1 : 0, sweep ? 1 : 0, x, y]);
  }
  close(): this { return this.push('Z', []); }

  get segments(): readonly PathSegment[] { return this.segs; }

  /** A polyline through the points, closed when asked. */
  static through(points: readonly (readonly [number, number])[], closed = false): Path {
    const p = new Path();
    points.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
    return closed && points.length ? p.close() : p;
  }

  /** A rectangle with rounded corners, drawn with arcs. */
  static roundedRect(x: number, y: number, w: number, h: number, r: number): Path {
    const k = Math.max(0, Math.min(r, w / 2, h / 2));
    const p = new Path().moveTo(x + k, y).horizontalTo(x + w - k);
    if (k) p.arcTo(k, k, 0, false, true, x + w, y + k);
    p.verticalTo(y + h - k);
    if (k) p.arcTo(k, k, 0, false, true, x + w - k, y + h);
    p.horizontalTo(x + k);
    if (k) p.arcTo(k, k, 0, false, true, x, y + h - k);
    p.verticalTo(y + k);
    if (k) p.arcTo(k, k, 0, false, true, x + k, y);
    return p.close();
  }

  toString(precision = 3): string { return serializePath(this.segs, precision); }
}

// ---------------------------------------------------------------------------------------------------------------
// Document

export interface SvgOptions {
  readonly width: number;
  readonly height: number;
  /** What the picture shows, in a few words. Required unless `decorative`. */
  readonly title?: string;
  /** What a person who cannot see it needs to know: the trend, the biggest value, the takeaway. */
  readonly desc?: string;
  /** Marks the picture as decoration for assistive technology: no title is needed and it is hidden. */
  readonly decorative?: boolean;
  /** Language of the title and description. */
  readonly lang?: string;
  readonly viewBox?: readonly [number, number, number, number];
  /** Put before every id so two inline SVGs on a page cannot capture each other's references. */
  readonly idPrefix?: string;
  readonly background?: string;
}

export interface Stop {
  readonly offset: number;
  readonly color: string;
  readonly opacity?: number;
}

export class Svg {
  private readonly o: SvgOptions;
  private readonly body: SvgNode[] = [];
  private readonly defsList: SvgNode[] = [];
  private readonly ids = new Set<string>();
  private n = 0;

  constructor(o: SvgOptions) {
    if (!(o.width > 0) || !(o.height > 0) || !Number.isFinite(o.width) || !Number.isFinite(o.height)) throw new SvgError('width and height must be positive numbers');
    if (!o.decorative && !o.title?.trim()) throw new SvgError('a picture needs a title for people who cannot see it; set `title`, or `decorative: true` if it carries no information');
    if (o.idPrefix !== undefined && !/^[A-Za-z_][\w-]*$/.test(o.idPrefix)) throw new SvgError('idPrefix must start with a letter and use letters, digits, - and _');
    if (o.lang !== undefined && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(o.lang)) throw new SvgError(`"${o.lang}" is not a language tag`);
    this.o = o;
  }

  /** An id unique in this document, with the prefix. */
  id(name: string): string {
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new SvgError(`"${name}" is not a usable id`);
    const full = `${this.o.idPrefix ?? ''}${this.o.idPrefix ? '-' : ''}${name}`;
    if (this.ids.has(full)) throw new SvgError(`the id "${full}" is already used in this document`);
    this.ids.add(full);
    return full;
  }

  /** A fresh id with a counter, for generated parts. */
  nextId(base: string): string {
    return this.id(`${base}-${++this.n}`);
  }

  add(...nodes: (SvgNode | undefined)[]): this {
    for (const n of nodes) if (n) this.body.push(n);
    return this;
  }

  defs(...nodes: SvgNode[]): this {
    this.defsList.push(...nodes);
    return this;
  }

  private gradient(tag: 'linearGradient' | 'radialGradient', id: string, attrs: Attrs, stops: readonly Stop[]): string {
    if (stops.length < 2) throw new SvgError('a gradient needs at least two stops');
    let last = -Infinity;
    const full = this.id(id);
    const nodes = stops.map((s) => {
      if (!(s.offset >= 0 && s.offset <= 1)) throw new SvgError('a stop offset is between 0 and 1');
      if (s.offset < last) throw new SvgError('stop offsets must not decrease');
      last = s.offset;
      return el('stop', { offset: s.offset, 'stop-color': s.color, 'stop-opacity': s.opacity });
    });
    this.defsList.push(el(tag, { id: full, ...attrs }, ...nodes));
    return `url(#${full})`;
  }

  /** Defines a linear gradient and returns the paint to use. Coordinates are fractions of the shape unless `userSpace`. */
  linearGradient(id: string, stops: readonly Stop[], o: { x1?: number; y1?: number; x2?: number; y2?: number; userSpace?: boolean } = {}): string {
    return this.gradient('linearGradient', id, { x1: o.x1 ?? 0, y1: o.y1 ?? 0, x2: o.x2 ?? 1, y2: o.y2 ?? 0, gradientUnits: o.userSpace ? 'userSpaceOnUse' : 'objectBoundingBox' }, stops);
  }

  radialGradient(id: string, stops: readonly Stop[], o: { cx?: number; cy?: number; r?: number } = {}): string {
    return this.gradient('radialGradient', id, { cx: o.cx ?? 0.5, cy: o.cy ?? 0.5, r: o.r ?? 0.5 }, stops);
  }

  /** A clip path from shapes; returns the value for clip-path="url(#id)". */
  clipPath(id: string, ...shapes: SvgNode[]): string {
    const full = this.id(id);
    this.defsList.push(el('clipPath', { id: full }, ...shapes));
    return `url(#${full})`;
  }

  /** The finished document. */
  toString(o: { pretty?: boolean; xmlDeclaration?: boolean } = {}): string {
    const { width, height } = this.o;
    const vb = this.o.viewBox ?? [0, 0, width, height];
    const titleId = this.o.decorative ? undefined : `${this.o.idPrefix ? `${this.o.idPrefix}-` : ''}title`;
    const descId = !this.o.decorative && this.o.desc ? `${this.o.idPrefix ? `${this.o.idPrefix}-` : ''}desc` : undefined;
    const kids: SvgNode[] = [];
    if (!this.o.decorative) kids.push(el('title', { id: titleId }, this.o.title!.trim()));
    if (descId) kids.push(el('desc', { id: descId }, this.o.desc!.trim()));
    if (this.defsList.length) kids.push(el('defs', {}, ...this.defsList));
    if (this.o.background) kids.push(el('rect', { x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: this.o.background }));
    kids.push(...this.body);
    const root = el('svg', {
      width,
      height,
      viewBox: vb.map((v) => num(v)).join(' '),
      ...(this.o.decorative ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-labelledby': [titleId, descId].filter(Boolean).join(' ') }),
      ...(this.o.lang ? { lang: this.o.lang } : {}),
    }, ...kids);
    const withNs: SvgNode = { ...root, attrs: { xmlns: 'http://www.w3.org/2000/svg', ...root.attrs } };
    const text = write(withNs, o.pretty ? 0 : -1);
    return `${o.xmlDeclaration ? '<?xml version="1.0" encoding="UTF-8"?>\n' : ''}${text}${o.pretty ? '\n' : ''}`;
  }
}

/** Writes a node. `depth` below zero means no indentation. */
export function write(node: SvgNode, depth = -1): string {
  const pad = depth >= 0 ? '  '.repeat(depth) : '';
  const nl = depth >= 0 ? '\n' : '';
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  if (!node.children.length) return `${pad}<${node.tag}${attrs}/>`;
  const textOnly = node.children.every((c) => typeof c === 'string');
  if (textOnly) return `${pad}<${node.tag}${attrs}>${node.children.map((c) => escapeText(c as string)).join('')}</${node.tag}>`;
  const inner = node.children.map((c) => (typeof c === 'string' ? `${depth >= 0 ? '  '.repeat(depth + 1) : ''}${escapeText(c)}` : write(c, depth >= 0 ? depth + 1 : -1))).join(nl);
  return `${pad}<${node.tag}${attrs}>${nl}${inner}${nl}${pad}</${node.tag}>`;
}
