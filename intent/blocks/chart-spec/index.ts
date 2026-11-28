/**
 * A declarative chart specification turned into an SVG picture and a plain-words description of it. A spec names the
 * type (line, bar, area, pie, heatmap or table), the data rows, and which fields mean what; this block does the
 * rest: scales (linear with "nice" ticks after Heckbert's algorithm, UTC time with calendar-aligned ticks, and band
 * scales for categories), axes with gridlines and thinned labels, a legend, stacking or grouping, gaps where values
 * are missing, a colour-blind-safe palette (Okabe and Ito) and a sequential scale for heatmaps. Every picture is
 * accessible by construction, through the svg-writer block: a title, a description generated from the data (series,
 * ranges, highest and lowest, trend, shares), a <title> on every mark so the value is readable without sight or
 * pointer, and table roles on the table chart. Data is checked: non-finite numbers, negative pie values, unknown
 * fields and over-large inputs are refused with plain messages, and an empty data set draws a "No data" chart
 * rather than failing. Output is deterministic. Out of scope: interaction, animation, log scales, dual axes, labels
 * that avoid every collision, and locales other than those Intl.NumberFormat knows (the number format takes one).
 */
import { Path, Svg, el, estimateTextWidth, group, line, num, pathEl, rect, text } from '../svg-writer/index.ts';
import type { SvgNode } from '../svg-writer/index.ts';

export class ChartSpecError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Cell = string | number | null | undefined;
export type Row = Readonly<Record<string, Cell>>;
export type NumberFormat = 'auto' | 'integer' | 'percent' | 'decimal';

export interface Common {
  readonly title: string;
  /** Extra description for people who cannot see the picture; the generated summary is added after it. */
  readonly description?: string;
  readonly width?: number;
  readonly height?: number;
  readonly data: readonly Row[];
  readonly locale?: string;
  /** Colours for the series or slices, in order; the built-in palette is used when absent. */
  readonly palette?: readonly string[];
  /** A prefix for ids, when several charts share a page. */
  readonly idPrefix?: string;
  readonly lang?: string;
}

export interface AxisSpec {
  readonly field: string;
  /** Detected from the data when absent. */
  readonly type?: 'linear' | 'time' | 'category';
  readonly label?: string;
}

export interface ValueAxis {
  readonly label?: string;
  readonly format?: NumberFormat;
  readonly min?: number;
  readonly max?: number;
}

export interface SeriesSpec {
  readonly field: string;
  readonly label?: string;
  readonly color?: string;
}

export interface CartesianSpec extends Common {
  readonly type: 'line' | 'bar' | 'area';
  readonly x: AxisSpec;
  readonly y?: ValueAxis;
  /** Several value columns, or `{ by, value }` to split one value column by another field. */
  readonly series: readonly SeriesSpec[] | { readonly by: string; readonly value: string };
  readonly stack?: boolean;
}

export interface PieSpec extends Common {
  readonly type: 'pie';
  readonly category: string;
  readonly value: string;
  readonly donut?: boolean;
  readonly format?: NumberFormat;
}

export interface HeatmapSpec extends Common {
  readonly type: 'heatmap';
  readonly x: AxisSpec;
  readonly y: { readonly field: string; readonly label?: string };
  readonly value: { readonly field: string; readonly label?: string; readonly format?: NumberFormat };
  /** Low and high colours, as #rrggbb. */
  readonly colors?: readonly [string, string];
}

export interface Column {
  readonly field: string;
  readonly label?: string;
  readonly align?: 'start' | 'end';
  readonly format?: NumberFormat;
}

export interface TableSpec extends Common {
  readonly type: 'table';
  readonly columns: readonly Column[];
  readonly maxRows?: number;
}

export type ChartSpec = CartesianSpec | PieSpec | HeatmapSpec | TableSpec;

const MAX_ROWS = 20_000;
const MAX_SIZE = 4000;

/** Okabe and Ito (colour-blind safe), ordered by contrast on white: the first five reach 3:1 as graphics need, the last three are lighter and used last. */
export const PALETTE: readonly string[] = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#6B7280', '#E69F00', '#56B4E9', '#F0E442'];

const INK = '#1f2937';
const MUTED = '#4b5563';
const GRID = '#e5e7eb';
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// ---------------------------------------------------------------------------------------------------------------
// Scales and ticks

/** The "nice" number at or above x (round = false) or nearest x (round = true): 1, 2, 5 or 10 times a power of ten. */
function niceNum(x: number, round: boolean): number {
  const exp = Math.floor(Math.log10(x));
  const f = x / 10 ** exp;
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

export interface Ticks {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly ticks: readonly number[];
}

/** Round tick values covering [min, max] with about `count` of them, extending the range to the next tick. */
export function niceTicks(min: number, max: number, count = 5): Ticks {
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new ChartSpecError('tick range must be finite');
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
    const pad = Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const step = niceNum(niceNum(max - min, false) / Math.max(1, count - 1), true);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const ticks: number[] = [];
  for (let i = 0; lo + i * step <= hi + step * 1e-9 && i < 1000; i++) ticks.push(Number((lo + i * step).toFixed(decimals)));
  return { min: ticks[0]!, max: ticks[ticks.length - 1]!, step, ticks };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIXED = [SECOND, 5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

export interface TimeTicks {
  readonly ticks: readonly number[];
  readonly format: (ms: number) => string;
  /** A description of the step, such as "1 day" or "3 months". */
  readonly step: string;
}

/** Calendar-aligned UTC ticks: whole minutes, hours or days, then the first of a month, then January the first. */
export function timeTicks(min: number, max: number, count = 6): TimeTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) throw new ChartSpecError('time range must be finite and ordered');
  const span = Math.max(max - min, 1);
  const want = span / Math.max(1, count);
  const fixed = FIXED.find((s) => s >= want);
  if (fixed !== undefined && fixed < 28 * DAY) {
    const ticks: number[] = [];
    for (let t = Math.ceil(min / fixed) * fixed; t <= max; t += fixed) ticks.push(t);
    const fmt = fixed < MINUTE ? (ms: number) => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`; } : fixed < DAY ? (ms: number) => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; } : (ms: number) => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
    return { ticks, format: fmt, step: fixed >= DAY ? `${fixed / DAY} day${fixed > DAY ? 's' : ''}` : fixed >= HOUR ? `${fixed / HOUR} hour${fixed > HOUR ? 's' : ''}` : fixed >= MINUTE ? `${fixed / MINUTE} minute${fixed > MINUTE ? 's' : ''}` : `${fixed / SECOND} seconds` };
  }
  const monthSteps = [1, 3, 6];
  const months = span / (30.4375 * DAY);
  const ms = monthSteps.find((m) => m >= months / count);
  if (ms !== undefined) {
    const a = new Date(min);
    const ticks: number[] = [];
    let y = a.getUTCFullYear();
    let m = Math.floor(a.getUTCMonth() / ms) * ms;
    for (let i = 0; i < 2000; i++) {
      const t = Date.UTC(y, m, 1);
      if (t > max) break;
      if (t >= min) ticks.push(t);
      m += ms;
      if (m >= 12) { m -= 12; y++; }
    }
    return { ticks, format: (t) => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }, step: `${ms} month${ms > 1 ? 's' : ''}` };
  }
  const years = Math.max(1, niceNum(span / (365.25 * DAY) / count, true));
  const ys = Math.max(1, Math.round(years));
  const ticks: number[] = [];
  for (let y = Math.ceil(new Date(min).getUTCFullYear() / ys) * ys; ticks.length < 2000; y += ys) {
    const t = Date.UTC(y, 0, 1);
    if (t > max) break;
    if (t >= min) ticks.push(t);
  }
  return { ticks, format: (t) => String(new Date(t).getUTCFullYear()), step: `${ys} year${ys > 1 ? 's' : ''}` };
}

/** Maps a domain onto a pixel range; values outside are extrapolated, not clamped. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  return (v) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0));
}

export interface Band {
  readonly start: number;
  readonly width: number;
  readonly center: number;
}

/** Equal bands for categories inside [r0, r1], with `padding` (0 to 1) of each band left empty. */
export function bandScale(keys: readonly string[], r0: number, r1: number, padding = 0.2): (key: string) => Band {
  const w = keys.length ? (r1 - r0) / keys.length : 0;
  const index = new Map(keys.map((k, i) => [k, i]));
  return (key) => {
    const i = index.get(key);
    if (i === undefined) throw new ChartSpecError(`"${key}" is not in the scale`);
    const inner = w * (1 - padding);
    return { start: r0 + i * w + (w - inner) / 2, width: inner, center: r0 + i * w + w / 2 };
  };
}

function hex(c: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(c);
  if (!m) throw new ChartSpecError(`"${c}" is not a #rrggbb colour`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A colour between two #rrggbb colours, t from 0 to 1, as #rrggbb. */
export function mixColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const k = Math.max(0, Math.min(1, t));
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

/** The relative luminance of a #rrggbb colour (WCAG), for choosing readable text on it. */
export function luminance(c: string): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hex(c);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// ---------------------------------------------------------------------------------------------------------------
// Data and formatting

export function formatNumber(n: number, format: NumberFormat = 'auto', locale = 'en-US'): string {
  if (!Number.isFinite(n)) return String(n);
  switch (format) {
    case 'integer':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
    case 'percent':
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n);
    case 'decimal':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
    default:
      return Math.abs(n) >= 10_000 ? new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n) : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
  }
}

function checkCommon(spec: Common): void {
  if (!spec.title?.trim()) throw new ChartSpecError('a chart needs a title');
  if (!Array.isArray(spec.data)) throw new ChartSpecError('data must be a list of rows');
  if (spec.data.length > MAX_ROWS) throw new ChartSpecError(`a chart takes at most ${MAX_ROWS} rows; summarise first`);
  for (const [k, v] of [['width', spec.width], ['height', spec.height]] as const) if (v !== undefined && !(v >= 120 && v <= MAX_SIZE)) throw new ChartSpecError(`${k} must be between 120 and ${MAX_SIZE}`);
}

function field(rows: readonly Row[], name: string, what: string): void {
  if (rows.length && !rows.some((r) => name in r)) throw new ChartSpecError(`no row has the field "${name}" (${what})`);
}

function numeric(v: Cell, name: string, i: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ChartSpecError(`row ${i + 1}: "${name}" is not a finite number`);
  return n;
}

type XType = 'linear' | 'time' | 'category';

function detectType(rows: readonly Row[], f: string): XType {
  const vals = rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined && v !== '');
  if (vals.length && vals.every((v) => typeof v === 'number')) return 'linear';
  if (vals.length && vals.every((v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && Number.isFinite(Date.parse(v.length === 7 ? `${v}-01` : v)))) return 'time';
  return 'category';
}

function xValue(v: Cell, type: XType, i: number, name: string): number {
  if (type === 'category') throw new ChartSpecError('internal: a category is not numeric');
  if (type === 'time') {
    const t = typeof v === 'number' ? v : Date.parse(typeof v === 'string' && v.length === 7 ? `${v}-01` : String(v));
    if (!Number.isFinite(t)) throw new ChartSpecError(`row ${i + 1}: "${name}" is not a date or a time`);
    return t;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) throw new ChartSpecError(`row ${i + 1}: "${name}" is not a finite number`);
  return n;
}

const iso = (ms: number) => { const s = new Date(ms).toISOString(); return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s.slice(0, 16).replace('T', ' ') + 'Z'; };

interface Resolved {
  readonly name: string;
  readonly color: string;
  /** One value per x, null for missing. */
  readonly values: (number | null)[];
}

interface CartesianModel {
  readonly xType: XType;
  /** Distinct x keys in order: numbers (ms or linear) as numbers, categories as strings. */
  readonly xs: readonly (number | string)[];
  readonly series: readonly Resolved[];
}

function buildCartesian(spec: CartesianSpec): CartesianModel {
  const rows = spec.data;
  field(rows, spec.x.field, 'the x axis');
  const xType = spec.x.type ?? detectType(rows, spec.x.field);
  const palette = spec.palette ?? PALETTE;
  const keyOf = (r: Row, i: number): number | string => (xType === 'category' ? String(r[spec.x.field] ?? '') : xValue(r[spec.x.field], xType, i, spec.x.field));
  const xsSet = new Map<number | string, number>();
  rows.forEach((r, i) => {
    const k = keyOf(r, i);
    if (!xsSet.has(k)) xsSet.set(k, xsSet.size);
  });
  const xs = [...xsSet.keys()];
  if (xType !== 'category') (xs as number[]).sort((a, b) => (a as number) - (b as number));
  const pos = new Map(xs.map((k, i) => [k, i]));
  const defs: { name: string; color: string | undefined; pick: (r: Row) => Cell; match: (r: Row) => boolean }[] = [];
  if (Array.isArray(spec.series)) {
    if (!spec.series.length) throw new ChartSpecError('a chart needs at least one series');
    for (const s of spec.series as readonly SeriesSpec[]) {
      field(rows, s.field, 'a series');
      defs.push({ name: s.label ?? s.field, color: s.color, pick: (r) => r[s.field], match: () => true });
    }
  } else {
    const { by, value } = spec.series as { by: string; value: string };
    field(rows, by, 'series split');
    field(rows, value, 'series value');
    const groups: string[] = [];
    for (const r of rows) {
      const g = String(r[by] ?? '');
      if (!groups.includes(g)) groups.push(g);
    }
    for (const g of groups) defs.push({ name: g, color: undefined, pick: (r) => r[value], match: (r) => String(r[by] ?? '') === g });
  }
  if (defs.length > palette.length && defs.some((d) => d.color === undefined)) throw new ChartSpecError(`more than ${palette.length} series need colours: pass a longer palette, or colour each series`);
  const series = defs.map((d, si): Resolved => {
    const values: (number | null)[] = xs.map(() => null);
    rows.forEach((r, i) => {
      if (!d.match(r)) return;
      const v = numeric(d.pick(r), d.name, i);
      if (v === null) return;
      const p = pos.get(keyOf(r, i))!;
      values[p] = (values[p] ?? 0) + v;
    });
    return { name: d.name, color: d.color ?? palette[si]!, values };
  });
  return { xType, xs, series };
}

// ---------------------------------------------------------------------------------------------------------------
// Description

function listNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function xLabel(model: CartesianModel, i: number): string {
  const k = model.xs[i]!;
  return typeof k === 'string' ? k : model.xType === 'time' ? iso(k) : formatNumber(k, 'auto');
}

/** A plain-words summary of the chart for the picture's description: what it is, its ranges, highs and lows, trends and shares. */
export function altText(spec: ChartSpec): string {
  checkCommon(spec);
  const loc = spec.locale ?? 'en-US';
  const rows = spec.data;
  const head = `${spec.type === 'line' ? 'Line' : spec.type === 'bar' ? 'Bar' : spec.type === 'area' ? 'Area' : spec.type === 'pie' ? 'Pie' : spec.type === 'heatmap' ? 'Heatmap' : 'Table'} chart titled "${spec.title}".`;
  if (!rows.length) return `${head} There is no data.`;
  if (spec.type === 'pie') {
    const slices = pieSlices(spec);
    const total = slices.reduce((a, s) => a + s.value, 0);
    if (total === 0) return `${head} All values are zero.`;
    const top = slices.slice().sort((a, b) => b.value - a.value);
    const fmt = (s: { name: string; value: number }) => `${s.name} ${formatNumber(s.value / total, 'percent', loc)}`;
    return `${head} ${slices.length} slices. Largest: ${top.slice(0, 3).map(fmt).join('; ')}${top.length > 3 ? `; ${top.length - 3} more` : ''}. Smallest: ${fmt(top[top.length - 1]!)}.`;
  }
  if (spec.type === 'table') return `${head} ${Math.min(rows.length, spec.maxRows ?? rows.length)} of ${rows.length} rows and ${spec.columns.length} columns: ${listNames(spec.columns.map((c) => c.label ?? c.field))}.`;
  if (spec.type === 'heatmap') {
    field(rows, spec.x.field, 'heatmap x');
    field(rows, spec.y.field, 'heatmap y');
    field(rows, spec.value.field, 'heatmap value');
    let hi: { v: number; r: Row } | undefined;
    let lo: { v: number; r: Row } | undefined;
    rows.forEach((r, i) => {
      const v = numeric(r[spec.value.field], spec.value.field, i);
      if (v === null) return;
      if (!hi || v > hi.v) hi = { v, r };
      if (!lo || v < lo.v) lo = { v, r };
    });
    const f = spec.value.format ?? 'auto';
    const name = spec.value.label ?? spec.value.field;
    if (!hi || !lo) return `${head} There are no values.`;
    return `${head} ${name} by ${spec.x.label ?? spec.x.field} and ${spec.y.label ?? spec.y.field}. Highest: ${formatNumber(hi.v, f, loc)} at ${String(hi.r[spec.x.field])}, ${String(hi.r[spec.y.field])}. Lowest: ${formatNumber(lo.v, f, loc)} at ${String(lo.r[spec.x.field])}, ${String(lo.r[spec.y.field])}.`;
  }
  const m = buildCartesian(spec);
  const f = spec.y?.format ?? 'auto';
  const parts: string[] = [`${m.series.length} series (${listNames(m.series.map((s) => s.name))}) over ${m.xs.length} ${m.xType === 'category' ? 'categories' : 'points'}${m.xType === 'time' ? ` from ${xLabel(m, 0)} to ${xLabel(m, m.xs.length - 1)}` : m.xType === 'linear' ? ` from ${xLabel(m, 0)} to ${xLabel(m, m.xs.length - 1)}` : ''}.`];
  for (const s of m.series.slice(0, 5)) {
    const pts = s.values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
    if (!pts.length) {
      parts.push(`${s.name} has no values.`);
      continue;
    }
    const hi = pts.reduce((a, b) => (b.v > a.v ? b : a));
    const lo = pts.reduce((a, b) => (b.v < a.v ? b : a));
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    if (spec.type === 'bar') parts.push(`${s.name}: highest ${formatNumber(hi.v, f, loc)} at ${xLabel(m, hi.i)}, lowest ${formatNumber(lo.v, f, loc)} at ${xLabel(m, lo.i)}.`);
    else {
      const dir = last.v > first.v ? 'rises' : last.v < first.v ? 'falls' : 'ends where it began';
      parts.push(`${s.name} ${dir === 'ends where it began' ? dir : `${dir} from ${formatNumber(first.v, f, loc)} to ${formatNumber(last.v, f, loc)}`}, peaking at ${formatNumber(hi.v, f, loc)} at ${xLabel(m, hi.i)} and lowest at ${formatNumber(lo.v, f, loc)} at ${xLabel(m, lo.i)}.`);
    }
  }
  if (m.series.length > 5) parts.push(`${m.series.length - 5} more series are not described here.`);
  return `${head} ${parts.join(' ')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function frame(spec: Common, w: number, h: number): Svg {
  const desc = [spec.description?.trim(), altText(spec as ChartSpec)].filter(Boolean).join(' ');
  return new Svg({ width: w, height: h, title: spec.title, desc, background: '#ffffff', ...(spec.idPrefix ? { idPrefix: spec.idPrefix } : {}), ...(spec.lang ? { lang: spec.lang } : {}) });
}

const label = (s: string, x: number, y: number, o: { size?: number; anchor?: 'start' | 'middle' | 'end'; fill?: string; weight?: string; rotate?: number } = {}): SvgNode =>
  text(s, x, y, { 'font-family': FONT, 'font-size': o.size ?? 11, 'text-anchor': o.anchor ?? 'start', fill: o.fill ?? MUTED, ...(o.weight ? { 'font-weight': o.weight } : {}), ...(o.rotate ? { transform: `rotate(${num(o.rotate)} ${num(x)} ${num(y)})` } : {}) });

function legend(items: readonly { name: string; color: string }[], x: number, y: number, maxWidth: number): { nodes: SvgNode[]; height: number } {
  const nodes: SvgNode[] = [];
  let cx = x;
  let cy = y;
  for (const it of items) {
    const w = 16 + estimateTextWidth(it.name, 11) + 14;
    if (cx + w > x + maxWidth && cx > x) {
      cx = x;
      cy += 16;
    }
    nodes.push(rect(cx, cy - 9, 11, 11, { fill: it.color, rx: 2 }), label(it.name, cx + 16, cy, { fill: INK }));
    cx += w;
  }
  return { nodes, height: cy - y + 16 };
}

function noData(spec: Common, w: number, h: number): string {
  const s = frame(spec, w, h);
  s.add(label(spec.title, 16, 26, { size: 16, weight: '600', fill: INK }), label('No data', w / 2, h / 2, { anchor: 'middle', size: 14 }));
  return s.toString();
}

function renderCartesian(spec: CartesianSpec): string {
  const w = spec.width ?? 640;
  const h = spec.height ?? 360;
  if (!spec.data.length) return noData(spec, w, h);
  const m = buildCartesian(spec);
  const loc = spec.locale ?? 'en-US';
  const yf = spec.y?.format ?? 'auto';
  const s = frame(spec, w, h);
  const stackOn = spec.stack === true && spec.type !== 'line';
  // Value domain.
  let lo = Infinity;
  let hi = -Infinity;
  const stacked: { base: (number | null)[]; top: (number | null)[] }[] = m.series.map(() => ({ base: [], top: [] }));
  m.xs.forEach((_, i) => {
    let pos = 0;
    let neg = 0;
    m.series.forEach((se, si) => {
      const v = se.values[i] ?? null;
      if (v === null) {
        stacked[si]!.base[i] = null;
        stacked[si]!.top[i] = null;
        return;
      }
      if (stackOn) {
        const b = v >= 0 ? pos : neg;
        stacked[si]!.base[i] = b;
        stacked[si]!.top[i] = b + v;
        if (v >= 0) pos += v;
        else neg += v;
        lo = Math.min(lo, b, b + v);
        hi = Math.max(hi, b, b + v);
      } else {
        stacked[si]!.base[i] = 0;
        stacked[si]!.top[i] = v;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    });
  });
  if (!Number.isFinite(lo)) return noData(spec, w, h);
  if (spec.type !== 'line') {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const yt = niceTicks(spec.y?.min ?? lo, spec.y?.max ?? hi, 5);
  const yTicks = yt.ticks.map((t) => ({ t, text: formatNumber(t, yf, loc) }));
  const yLabelW = Math.max(...yTicks.map((t) => estimateTextWidth(t.text, 11)));
  const legendItems = m.series.length > 1 ? m.series.map((se) => ({ name: se.name, color: se.color })) : [];
  const left = Math.ceil(yLabelW) + (spec.y?.label ? 40 : 24);
  const right = 16;
  const lg = legendItems.length ? legend(legendItems, left, 48, w - left - right) : { nodes: [], height: 0 };
  const top = 40 + lg.height + 8;
  const bottom = h - (spec.x.label ? 52 : 36);
  const plot = { x0: left, x1: w - right, y0: top, y1: bottom };
  if (plot.x1 - plot.x0 < 40 || plot.y1 - plot.y0 < 40) throw new ChartSpecError('the chart is too small for its labels; make it larger');
  const yS = linearScale(yt.min, yt.max, plot.y1, plot.y0);
  s.add(label(spec.title, 16, 26, { size: 16, weight: '600', fill: INK }), ...lg.nodes);
  // Gridlines and y axis.
  for (const t of yTicks) {
    const y = yS(t.t);
    s.add(line(plot.x0, y, plot.x1, y, { stroke: t.t === 0 ? '#9ca3af' : GRID, 'stroke-width': 1 }), label(t.text, plot.x0 - 6, y + 4, { anchor: 'end' }));
  }
  if (spec.y?.label) s.add(label(spec.y.label, 14, (plot.y0 + plot.y1) / 2, { anchor: 'middle', rotate: -90 }));
  // x positions.
  let xPos: (i: number) => number;
  let xTicks: { x: number; text: string }[];
  let band: ((k: string) => Band) | undefined;
  if (m.xType === 'category') {
    band = bandScale(m.xs as string[], plot.x0, plot.x1, spec.type === 'bar' ? 0.25 : 0);
    xPos = (i) => band!(m.xs[i] as string).center;
    const all = (m.xs as string[]).map((k, i) => ({ x: xPos(i), text: k }));
    const widest = Math.max(...all.map((a) => estimateTextWidth(a.text, 11))) + 8;
    const every = Math.max(1, Math.ceil(widest / ((plot.x1 - plot.x0) / all.length)));
    xTicks = all.filter((_, i) => i % every === 0);
  } else if (m.xType === 'time') {
    const lo0 = m.xs[0] as number;
    const hi0 = m.xs[m.xs.length - 1] as number;
    const tt = timeTicks(lo0, hi0, Math.max(2, Math.floor((plot.x1 - plot.x0) / 90)));
    const sx = linearScale(lo0, hi0 === lo0 ? lo0 + 1 : hi0, plot.x0 + (spec.type === 'bar' ? 12 : 0), plot.x1 - (spec.type === 'bar' ? 12 : 0));
    xPos = (i) => sx(m.xs[i] as number);
    xTicks = tt.ticks.map((t) => ({ x: sx(t), text: tt.format(t) }));
  } else {
    const lo0 = m.xs[0] as number;
    const hi0 = m.xs[m.xs.length - 1] as number;
    const nt = niceTicks(lo0, hi0, Math.max(2, Math.floor((plot.x1 - plot.x0) / 80)));
    const sx = linearScale(lo0 === hi0 ? lo0 - 1 : lo0, lo0 === hi0 ? hi0 + 1 : hi0, plot.x0 + (spec.type === 'bar' ? 12 : 0), plot.x1 - (spec.type === 'bar' ? 12 : 0));
    xPos = (i) => sx(m.xs[i] as number);
    xTicks = nt.ticks.filter((t) => t >= lo0 && t <= hi0).map((t) => ({ x: sx(t), text: formatNumber(t, 'auto', loc) }));
  }
  s.add(line(plot.x0, plot.y1, plot.x1, plot.y1, { stroke: '#9ca3af' }));
  for (const t of xTicks) s.add(line(t.x, plot.y1, t.x, plot.y1 + 4, { stroke: '#9ca3af' }), label(t.text, t.x, plot.y1 + 17, { anchor: 'middle' }));
  if (spec.x.label) s.add(label(spec.x.label, (plot.x0 + plot.x1) / 2, h - 10, { anchor: 'middle' }));
  // Marks.
  const nS = m.series.length;
  const marks: SvgNode[] = [];
  m.series.forEach((se, si) => {
    const st = stacked[si]!;
    const pts = m.xs.map((_, i) => (st.top[i] === null || st.top[i] === undefined ? null : ([xPos(i), yS(st.top[i]!), yS(st.base[i]!)] as const)));
    if (spec.type === 'bar') {
      const slot = band ? band(m.xs[0] as string).width : Math.max(4, ((plot.x1 - plot.x0) / m.xs.length) * 0.7);
      const barW = stackOn ? slot : slot / nS;
      pts.forEach((p, i) => {
        if (!p) return;
        const cx = p[0];
        const x = stackOn ? cx - barW / 2 : cx - slot / 2 + si * barW;
        const y = Math.min(p[1], p[2]);
        const bh = Math.max(Math.abs(p[2] - p[1]), 0.5);
        marks.push(el('rect', { x, y, width: Math.max(barW - (stackOn || nS === 1 ? 0 : 1), 1), height: bh, fill: se.color }, el('title', {}, `${se.name}, ${xLabel(m, i)}: ${formatNumber(se.values[i]!, yf, loc)}`)));
      });
      return;
    }
    // Line and area: split into runs at gaps.
    const runs: (readonly [number, number, number])[][] = [];
    let cur: (readonly [number, number, number])[] = [];
    for (const p of pts) {
      if (p) cur.push(p);
      else if (cur.length) {
        runs.push(cur);
        cur = [];
      }
    }
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      if (spec.type === 'area') {
        const p = new Path().moveTo(run[0]![0], run[0]![1]);
        for (const q of run.slice(1)) p.lineTo(q[0], q[1]);
        for (const q of run.slice().reverse()) p.lineTo(q[0], q[2]);
        marks.push(pathEl(p.close(), { fill: se.color, 'fill-opacity': stackOn ? 0.85 : 0.35, stroke: 'none' }));
      }
      if (run.length > 1 || spec.type !== 'area') {
        const p = new Path().moveTo(run[0]![0], run[0]![1]);
        for (const q of run.slice(1)) p.lineTo(q[0], q[1]);
        marks.push(pathEl(p, { fill: 'none', stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      }
    }
    if (m.xs.length <= 60)
      pts.forEach((p, i) => {
        if (p) marks.push(el('circle', { cx: p[0], cy: p[1], r: 3, fill: '#ffffff', stroke: se.color, 'stroke-width': 2 }, el('title', {}, `${se.name}, ${xLabel(m, i)}: ${formatNumber(se.values[i]!, yf, loc)}`)));
      });
  });
  s.add(group({ role: 'list', 'aria-label': 'Data marks' }, ...marks));
  return s.toString();
}

interface Slice {
  readonly name: string;
  readonly value: number;
}

function pieSlices(spec: PieSpec): Slice[] {
  field(spec.data, spec.category, 'pie category');
  field(spec.data, spec.value, 'pie value');
  const acc = new Map<string, number>();
  spec.data.forEach((r, i) => {
    const v = numeric(r[spec.value], spec.value, i);
    if (v === null) return;
    if (v < 0) throw new ChartSpecError(`row ${i + 1}: a pie slice cannot be negative`);
    const k = String(r[spec.category] ?? '');
    acc.set(k, (acc.get(k) ?? 0) + v);
  });
  return [...acc].map(([name, value]) => ({ name, value }));
}

function renderPie(spec: PieSpec): string {
  const w = spec.width ?? 480;
  const h = spec.height ?? 320;
  const slices = pieSlices(spec);
  const total = slices.reduce((a, b) => a + b.value, 0);
  if (!slices.length || total === 0) return noData(spec, w, h);
  const palette = spec.palette ?? PALETTE;
  if (slices.length > palette.length) throw new ChartSpecError(`a pie takes at most ${palette.length} slices (more are unreadable): group the small ones into "Other", or pass a longer palette`);
  const loc = spec.locale ?? 'en-US';
  const f = spec.format ?? 'auto';
  const s = frame(spec, w, h);
  const r = Math.min(h - 70, w * 0.45) / 2;
  const cx = 16 + r + 4;
  const cy = 44 + (h - 44) / 2;
  s.add(label(spec.title, 16, 26, { size: 16, weight: '600', fill: INK }));
  let a0 = -Math.PI / 2;
  const nodes: SvgNode[] = [];
  const inner = spec.donut ? r * 0.55 : 0;
  slices.forEach((sl, i) => {
    if (sl.value === 0) return;
    const frac = sl.value / total;
    const a1 = a0 + frac * 2 * Math.PI;
    const color = palette[i]!;
    const tip = el('title', {}, `${sl.name}: ${formatNumber(sl.value, f, loc)} (${formatNumber(frac, 'percent', loc)})`);
    if (frac >= 0.9999) {
      nodes.push(inner ? el('path', { d: new Path().moveTo(cx, cy - r).arcTo(r, r, 0, true, true, cx, cy + r).arcTo(r, r, 0, true, true, cx, cy - r).moveTo(cx, cy - inner).arcTo(inner, inner, 0, true, false, cx, cy + inner).arcTo(inner, inner, 0, true, false, cx, cy - inner).close().toString(), fill: color, 'fill-rule': 'evenodd', stroke: '#ffffff', 'stroke-width': 1 }, tip) : el('circle', { cx, cy, r, fill: color, stroke: '#ffffff', 'stroke-width': 1 }, tip));
    } else {
      const large = frac > 0.5;
      const p = new Path().moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0)).arcTo(r, r, 0, large, true, cx + r * Math.cos(a1), cy + r * Math.sin(a1));
      if (inner) p.lineTo(cx + inner * Math.cos(a1), cy + inner * Math.sin(a1)).arcTo(inner, inner, 0, large, false, cx + inner * Math.cos(a0), cy + inner * Math.sin(a0));
      else p.lineTo(cx, cy);
      nodes.push(el('path', { d: p.close().toString(), fill: color, stroke: '#ffffff', 'stroke-width': 1 }, tip));
    }
    a0 = a1;
  });
  s.add(group({ role: 'list', 'aria-label': 'Slices' }, ...nodes));
  const lx = cx + r + 28;
  slices.forEach((sl, i) => {
    const y = 64 + i * 20;
    s.add(rect(lx, y - 10, 12, 12, { fill: palette[i]!, rx: 2 }), label(`${sl.name}  ${formatNumber(sl.value / total, 'percent', loc)}`, lx + 18, y, { fill: INK, size: 12 }));
  });
  return s.toString();
}

function renderHeatmap(spec: HeatmapSpec): string {
  const w = spec.width ?? 640;
  const h = spec.height ?? 360;
  if (!spec.data.length) return noData(spec, w, h);
  field(spec.data, spec.x.field, 'heatmap x');
  field(spec.data, spec.y.field, 'heatmap y');
  field(spec.data, spec.value.field, 'heatmap value');
  const [c0, c1] = spec.colors ?? ['#f0f9ff', '#08306b'];
  const loc = spec.locale ?? 'en-US';
  const f = spec.value.format ?? 'auto';
  const xs: string[] = [];
  const ys: string[] = [];
  const cells = new Map<string, number>();
  let lo = Infinity;
  let hi = -Infinity;
  spec.data.forEach((r, i) => {
    const x = String(r[spec.x.field] ?? '');
    const y = String(r[spec.y.field] ?? '');
    if (!xs.includes(x)) xs.push(x);
    if (!ys.includes(y)) ys.push(y);
    const v = numeric(r[spec.value.field], spec.value.field, i);
    if (v === null) return;
    cells.set(`${x}\u0000${y}`, (cells.get(`${x}\u0000${y}`) ?? 0) + v);
  });
  for (const v of cells.values()) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!cells.size) return noData(spec, w, h);
  const s = frame(spec, w, h);
  const left = Math.ceil(Math.max(...ys.map((y) => estimateTextWidth(y, 11)))) + 16;
  const plot = { x0: left, x1: w - 70, y0: 56, y1: h - 40 };
  const xb = bandScale(xs, plot.x0, plot.x1, 0.05);
  const yb = bandScale(ys, plot.y0, plot.y1, 0.05);
  s.add(label(spec.title, 16, 26, { size: 16, weight: '600', fill: INK }));
  const widest = Math.max(...xs.map((x) => estimateTextWidth(x, 11))) + 8;
  const every = Math.max(1, Math.ceil(widest / ((plot.x1 - plot.x0) / xs.length)));
  xs.forEach((x, i) => {
    if (i % every === 0) s.add(label(x, xb(x).center, plot.y1 + 16, { anchor: 'middle' }));
  });
  ys.forEach((y) => s.add(label(y, plot.x0 - 6, yb(y).center + 4, { anchor: 'end' })));
  const nodes: SvgNode[] = [];
  for (const [k, v] of cells) {
    const [x, y] = k.split('\u0000') as [string, string];
    const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
    const fill = mixColor(c0, c1, t);
    const b = xb(x);
    const bb = yb(y);
    nodes.push(el('rect', { x: b.start, y: bb.start, width: b.width, height: bb.width, fill }, el('title', {}, `${x}, ${y}: ${formatNumber(v, f, loc)}`)));
    if (b.width >= 34 && bb.width >= 16) nodes.push(label(formatNumber(v, f, loc), b.center, bb.center + 4, { anchor: 'middle', fill: luminance(fill) > 0.35 ? '#111827' : '#ffffff', size: 10 }));
  }
  s.add(group({ role: 'list', 'aria-label': 'Cells' }, ...nodes));
  const gid = s.linearGradient('scale', [{ offset: 0, color: c1 }, { offset: 1, color: c0 }], { x1: 0, y1: 0, x2: 0, y2: 1 });
  s.add(rect(w - 52, plot.y0, 14, plot.y1 - plot.y0, { fill: gid, stroke: GRID }), label(formatNumber(hi, f, loc), w - 34, plot.y0 + 10), label(formatNumber(lo, f, loc), w - 34, plot.y1));
  return s.toString();
}

function renderTable(spec: TableSpec): string {
  if (!spec.columns.length) throw new ChartSpecError('a table needs at least one column');
  for (const c of spec.columns) field(spec.data, c.field, 'a column');
  const loc = spec.locale ?? 'en-US';
  const rows = spec.data.slice(0, spec.maxRows ?? 200);
  const rowH = 24;
  const cell = (c: Column, v: Cell) => (v === null || v === undefined ? '' : typeof v === 'number' ? formatNumber(v, c.format ?? 'auto', loc) : String(v));
  const widths = spec.columns.map((c) => Math.min(280, Math.ceil(Math.max(estimateTextWidth(c.label ?? c.field, 12) + 4, ...rows.map((r) => estimateTextWidth(cell(c, r[c.field]), 12)))) + 20));
  const w = spec.width ?? Math.max(240, widths.reduce((a, b) => a + b, 0) + 32);
  const h = spec.height ?? 56 + (rows.length + 1) * rowH + 12;
  const s = frame(spec, w, h);
  s.add(label(spec.title, 16, 26, { size: 16, weight: '600', fill: INK }));
  const trunc = (t: string, max: number) => {
    let out = t;
    while (out.length > 1 && estimateTextWidth(out, 12) > max - 16) out = out.slice(0, -1);
    return out === t ? t : `${out.slice(0, -1)}…`;
  };
  const rowNodes: SvgNode[] = [];
  const mk = (cells: { c: Column; text: string }[], y: number, head: boolean, shade: boolean) => {
    let x = 16;
    const kids: SvgNode[] = [];
    if (shade) kids.push(rect(16, y - 16, widths.reduce((a, b) => a + b, 0), rowH, { fill: '#f9fafb' }));
    cells.forEach(({ c, text: t }, i) => {
      const end = c.align === 'end' || (!c.align && !head && typeof t === 'string' && /^[-+\d.,%KMB\s]+$/.test(t) && t.length > 0);
      const tx = end ? x + widths[i]! - 10 : x + 10;
      kids.push(el('g', { role: head ? 'columnheader' : 'cell' }, label(trunc(t, widths[i]!), tx, y, { anchor: end ? 'end' : 'start', fill: head ? INK : '#374151', size: 12, ...(head ? { weight: '600' } : {}) }), ...(trunc(t, widths[i]!) !== t ? [el('title', {}, t)] : [])));
      x += widths[i]!;
    });
    rowNodes.push(el('g', { role: 'row' }, ...kids));
  };
  mk(spec.columns.map((c) => ({ c, text: c.label ?? c.field })), 56, true, false);
  rows.forEach((r, i) => mk(spec.columns.map((c) => ({ c, text: cell(c, r[c.field]) })), 56 + (i + 1) * rowH, false, i % 2 === 1));
  s.add(line(16, 60, 16 + widths.reduce((a, b) => a + b, 0), 60, { stroke: '#9ca3af' }), group({ role: 'table', 'aria-label': spec.title }, ...rowNodes));
  return s.toString();
}

/** Draws a chart as an SVG string. */
export function renderChart(spec: ChartSpec): string {
  checkCommon(spec);
  switch (spec.type) {
    case 'line':
    case 'bar':
    case 'area':
      return renderCartesian(spec);
    case 'pie':
      return renderPie(spec);
    case 'heatmap':
      return renderHeatmap(spec);
    case 'table':
      return renderTable(spec);
    default:
      throw new ChartSpecError(`"${String((spec as { type?: unknown }).type)}" is not a chart type`);
  }
}

