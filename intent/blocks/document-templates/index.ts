/**
 * Reusable documents: a template is data (headings, paragraphs, tables, repeating sections, conditions) with merge
 * fields written {{client.name}} or {{total | money}}, each field declared with a type, a label, whether it is
 * required, and the role that fills it (the issuer, the signer). Rendering is strict: a field with no value, a
 * path that is not declared, or an unknown filter is reported, all at once, and nothing half-merged is ever
 * produced (a draft can opt in to visible «placeholders»). Templates are published as immutable versions with a
 * content hash; every PDF is footed with the template, its version and hash, so any output can be traced to exactly
 * what made it. Output is built with the pdf block.
 *
 * Merge syntax: {{path}} or {{path | filter | filter:"arg"}}, with filters upper, lower, title, trim, default:"x",
 * number:2, money, date:"long", join:", ", truncate:40 and count. Values are never evaluated as code: paths read only
 * own properties (never __proto__, constructor or prototype), conditions are small data structures, repeats and output
 * size are capped. Not in scope: images, page breaks and fonts beyond what the pdf block draws.
 */
import { createHash } from 'node:crypto';
import { pdf } from '../pdf/index.ts';
import type { Block } from '../pdf/index.ts';

export interface Problem {
  readonly where: string;
  readonly message: string;
}

/** Everything wrong with a template or its data, at once. */
export class TemplateProblems extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(`${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.map((p) => `${p.where}: ${p.message}`).join('; ')}`);
    this.problems = problems;
  }
}

export type FieldType = 'text' | 'number' | 'date' | 'money' | 'choice' | 'list';

export interface Field {
  readonly name: string;
  readonly type: FieldType;
  readonly label: string;
  readonly role?: string;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  /** For a list: the fields of each item. */
  readonly item?: readonly Field[];
}

export type Cond =
  | { readonly exists: string }
  | { readonly eq: readonly [string, string | number | boolean] }
  | { readonly gt: readonly [string, number] }
  | { readonly not: Cond }
  | { readonly and: readonly Cond[] }
  | { readonly or: readonly Cond[] };

export type Node =
  | { readonly h: string }
  | { readonly p: string }
  | { readonly space: number }
  | { readonly table: { readonly widths?: readonly number[]; readonly header?: readonly string[]; readonly rows?: readonly (readonly string[])[]; readonly repeat?: { readonly over: string; readonly as: string; readonly cells: readonly string[] } } }
  | { readonly repeat: { readonly over: string; readonly as: string; readonly body: readonly Node[] } }
  | { readonly if: Cond; readonly then: readonly Node[]; readonly else?: readonly Node[] };

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly { readonly id: string; readonly label: string }[];
  readonly fields: readonly Field[];
  readonly body: readonly Node[];
}

export interface Published extends Template {
  readonly version: number;
  readonly hash: string;
  readonly publishedAt: number;
}

export type Data = Readonly<Record<string, unknown>>;

const LIMITS = { maxRepeat: 1000, maxBlocks: 5000, maxText: 20_000, maxDepth: 8, maxNodes: 2000 };

// ---------------------------------------------------------------- merge syntax

export interface MergeRef {
  readonly path: string;
  readonly filters: readonly { readonly name: string; readonly arg: string | number | undefined }[];
}
export type Piece = string | MergeRef;

const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/;
const FILTERS = new Set(['upper', 'lower', 'title', 'trim', 'default', 'number', 'money', 'date', 'join', 'truncate', 'count']);

/** Splits text into literal pieces and merge references. `\{{` is a literal {{. Throws TemplateProblems on a bad tag. */
export function parseMerge(text: string, where = 'text'): Piece[] {
  const out: Piece[] = [];
  let lit = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('\\{{', i)) {
      lit += '{{';
      i += 3;
    } else if (text.startsWith('{{', i)) {
      const end = text.indexOf('}}', i + 2);
      if (end < 0) throw new TemplateProblems([{ where, message: 'a {{ with no closing }}' }]);
      if (lit) out.push(lit);
      lit = '';
      out.push(parseRef(text.slice(i + 2, end), where));
      i = end + 2;
    } else lit += text[i++];
  }
  if (lit) out.push(lit);
  return out;
}

function parseRef(src: string, where: string): MergeRef {
  const parts: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of src) {
    if (ch === '"') q = !q;
    if (ch === '|' && !q) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (q) throw new TemplateProblems([{ where, message: `an unclosed quote in {{${src}}}` }]);
  parts.push(cur);
  const path = parts[0]!.trim();
  if (!path.split('.').every((s) => SAFE_SEGMENT.test(s))) throw new TemplateProblems([{ where, message: `${JSON.stringify(path)} is not a field path` }]);
  const filters = parts.slice(1).map((f) => {
    const m = /^\s*([a-z]+)\s*(?::\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?)))?\s*$/.exec(f);
    if (!m || !FILTERS.has(m[1]!)) throw new TemplateProblems([{ where, message: `unknown filter in {{${src}}}` }]);
    return { name: m[1]!, arg: m[2] !== undefined ? m[2] : m[3] !== undefined ? Number(m[3]) : undefined };
  });
  return { path, filters };
}

type Scope = readonly Readonly<Record<string, unknown>>[];

const own = (o: unknown, k: string): unknown => (typeof o === 'object' && o !== null && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);

/** Reads a dotted path from the innermost scope that has its first segment; never reaches inherited properties. */
export function lookup(scope: Scope, path: string): unknown {
  const segs = path.split('.');
  if (segs.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) return undefined;
  let v: unknown;
  for (let i = scope.length - 1; i >= 0; i--)
    if (Object.hasOwn(scope[i]!, segs[0]!)) {
      v = scope[i]![segs[0]!];
      break;
    }
  for (const s of segs.slice(1)) v = Array.isArray(v) && /^\d+$/.test(s) ? v[Number(s)] : own(v, s);
  return v;
}

const isMoney = (v: unknown): v is { minor: number; currency: string } => typeof v === 'object' && v !== null && Number.isInteger((v as { minor?: unknown }).minor) && typeof (v as { currency?: unknown }).currency === 'string';

export interface RenderOptions {
  readonly locale?: string;
  /** Show «path» where a value is missing instead of failing: for drafts only. */
  readonly draft?: boolean;
}

function applyFilter(v: unknown, f: MergeRef['filters'][number], o: RenderOptions, where: string, problems: Problem[]): unknown {
  const locale = o.locale ?? 'en-US';
  switch (f.name) {
    case 'default':
      return v === undefined || v === null || v === '' ? String(f.arg ?? '') : v;
    case 'upper':
      return String(v).toUpperCase();
    case 'lower':
      return String(v).toLowerCase();
    case 'title':
      return String(v).replace(/\b(\p{L})(\p{L}*)/gu, (_m, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
    case 'trim':
      return String(v).trim();
    case 'count':
      return Array.isArray(v) ? v.length : 0;
    case 'join':
      return Array.isArray(v) ? v.map(String).join(String(f.arg ?? ', ')) : String(v);
    case 'truncate': {
      const n = typeof f.arg === 'number' ? f.arg : 40;
      const s = String(v);
      return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
    }
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return void problems.push({ where, message: 'number needs a number' });
      const d = typeof f.arg === 'number' ? f.arg : 0;
      return new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    }
    case 'money': {
      if (!isMoney(v)) return void problems.push({ where, message: 'money needs an amount in minor units and a currency' });
      const nf = new Intl.NumberFormat(locale, { style: 'currency', currency: v.currency });
      const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
      return nf.format(v.minor / 10 ** digits);
    }
    case 'date': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return void problems.push({ where, message: 'date needs a date as YYYY-MM-DD' });
      const style = f.arg === 'short' || f.arg === 'medium' || f.arg === 'full' ? f.arg : 'long';
      return new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: 'UTC' }).format(new Date(`${v}T00:00:00Z`));
    }
  }
  return v;
}

/** Merges one text. Missing values and bad filters are added to `problems`; the text is only trusted when none were added. */
export function merge(text: string, scope: Scope, o: RenderOptions, where: string, problems: Problem[]): string {
  let out = '';
  for (const p of parseMerge(text, where)) {
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    let v = lookup(scope, p.path);
    // A value that is not there is reported as missing, not as a bad date or amount; only `default` can fill it.
    for (const f of p.filters) if (f.name === 'default' || !(v === undefined || v === null || v === '')) v = applyFilter(v, f, o, `${where} {{${p.path}}}`, problems);
    if (v === undefined || v === null || v === '') {
      if (o.draft) out += `«${p.path}»`;
      else problems.push({ where, message: `no value for ${p.path}` });
      continue;
    }
    if (typeof v === 'object') {
      problems.push({ where, message: `${p.path} is not a single value (use a filter, or a repeat)` });
      continue;
    }
    out += String(v);
  }
  if (out.length > LIMITS.maxText) problems.push({ where, message: 'the text is too long' });
  return out;
}

function holds(c: Cond, scope: Scope): boolean {
  if ('exists' in c) {
    const v = lookup(scope, c.exists);
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
  }
  if ('eq' in c) return lookup(scope, c.eq[0]) === c.eq[1];
  if ('gt' in c) {
    const v = lookup(scope, c.gt[0]);
    return typeof v === 'number' && v > c.gt[1];
  }
  if ('not' in c) return !holds(c.not, scope);
  if ('and' in c) return c.and.every((x) => holds(x, scope));
  return c.or.some((x) => holds(x, scope));
}

// ---------------------------------------------------------------- checking a template

const fieldPaths = (fields: readonly Field[], prefix = ''): Map<string, Field> => {
  const m = new Map<string, Field>();
  for (const f of fields) {
    m.set(prefix + f.name, f);
    if (f.item) for (const [k, v] of fieldPaths(f.item, `${prefix}${f.name}.`)) m.set(k, v);
  }
  return m;
};

const condPaths = (c: Cond, out: string[]): void => {
  if ('exists' in c) out.push(c.exists);
  else if ('eq' in c) out.push(c.eq[0]);
  else if ('gt' in c) out.push(c.gt[0]);
  else if ('not' in c) condPaths(c.not, out);
  else for (const x of 'and' in c ? c.and : c.or) condPaths(x, out);
};

/** Everything that can be known without data: undeclared fields, bad syntax, roles that do not exist, limits. */
export function checkTemplate(t: Template): Problem[] {
  const problems: Problem[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(t.id)) problems.push({ where: 'id', message: 'an id is lower-case letters, digits and hyphens' });
  const roles = new Set(t.roles.map((r) => r.id));
  const declared = fieldPaths(t.fields);
  for (const [path, f] of declared) {
    if (f.role !== undefined && !roles.has(f.role)) problems.push({ where: `field ${path}`, message: `the role ${f.role} is not declared` });
    if (f.type === 'choice' && !f.choices?.length) problems.push({ where: `field ${path}`, message: 'a choice needs choices' });
    if (f.type === 'list' && !f.item?.length) problems.push({ where: `field ${path}`, message: 'a list needs item fields' });
  }
  let nodes = 0;
  const known = (path: string, loops: ReadonlyMap<string, string>, where: string) => {
    const [first, ...rest] = path.split('.');
    const base = loops.get(first!);
    const full = base !== undefined ? [base, ...rest].join('.') : path;
    if (first === 'loop') return;
    if (!declared.has(full) && !(base !== undefined && rest.length === 0)) problems.push({ where, message: `${path} is not a declared field` });
  };
  const text = (s: string, loops: ReadonlyMap<string, string>, where: string) => {
    try {
      for (const p of parseMerge(s, where)) if (typeof p !== 'string') known(p.path, loops, where);
    } catch (e) {
      if (e instanceof TemplateProblems) problems.push(...e.problems);
    }
  };
  const walk = (ns: readonly Node[], loops: ReadonlyMap<string, string>, depth: number, where: string) => {
    if (depth > LIMITS.maxDepth) return void problems.push({ where, message: 'nested too deeply' });
    ns.forEach((n, i) => {
      const w = `${where}[${i}]`;
      if (++nodes > LIMITS.maxNodes) return void (nodes === LIMITS.maxNodes + 1 && problems.push({ where: w, message: 'too many nodes' }));
      if ('h' in n) text(n.h, loops, w);
      else if ('p' in n) text(n.p, loops, w);
      else if ('space' in n) {
        if (!(n.space >= 0) || n.space > 400) problems.push({ where: w, message: 'space is 0 to 400 points' });
      } else if ('table' in n) {
        const tb = n.table;
        for (const c of tb.header ?? []) text(c, loops, w);
        for (const r of tb.rows ?? []) for (const c of r) text(c, loops, w);
        if (tb.repeat) {
          known(tb.repeat.over, loops, w);
          const inner = new Map(loops).set(tb.repeat.as, tb.repeat.over);
          for (const c of tb.repeat.cells) text(c, inner, w);
        }
      } else if ('repeat' in n) {
        known(n.repeat.over, loops, w);
        if (declared.get(n.repeat.over.split('.').length > 1 && loops.has(n.repeat.over.split('.')[0]!) ? [loops.get(n.repeat.over.split('.')[0]!)!, ...n.repeat.over.split('.').slice(1)].join('.') : n.repeat.over)?.type !== 'list') problems.push({ where: w, message: `${n.repeat.over} is not a list field` });
        walk(n.repeat.body, new Map(loops).set(n.repeat.as, n.repeat.over), depth + 1, `${w}.repeat`);
      } else {
        const ps: string[] = [];
        condPaths(n.if, ps);
        for (const p of ps) known(p, loops, w);
        walk(n.then, loops, depth + 1, `${w}.then`);
        walk(n.else ?? [], loops, depth + 1, `${w}.else`);
      }
    });
  };
  walk(t.body, new Map(), 0, 'body');
  return problems;
}

// ---------------------------------------------------------------- checking data

const TYPE_OK: Record<Exclude<FieldType, 'list' | 'choice'>, (v: unknown) => boolean> = {
  text: (v) => typeof v === 'string' && v.length <= LIMITS.maxText,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
  money: isMoney,
};

/** Checks values against the declared fields: required ones present, types right, choices from the list, nothing undeclared. */
export function checkData(fields: readonly Field[], data: Data, o: { role?: string; where?: string } = {}): Problem[] {
  const problems: Problem[] = [];
  const base = o.where ?? 'data';
  const names = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(data)) if (!names.has(k)) problems.push({ where: `${base}.${k}`, message: 'not a field of this template' });
  for (const f of fields) {
    if (o.role !== undefined && f.role !== o.role) {
      if (Object.hasOwn(data, f.name)) problems.push({ where: `${base}.${f.name}`, message: `${f.label} is not for ${o.role} to fill` });
      continue;
    }
    const v = Object.hasOwn(data, f.name) ? data[f.name] : undefined;
    if (v === undefined || v === null || v === '') {
      if (f.required && o.role === undefined) problems.push({ where: `${base}.${f.name}`, message: `${f.label} is required` });
      continue;
    }
    if (f.type === 'list') {
      if (!Array.isArray(v)) problems.push({ where: `${base}.${f.name}`, message: `${f.label} must be a list` });
      else if (v.length > LIMITS.maxRepeat) problems.push({ where: `${base}.${f.name}`, message: `${f.label} has more than ${LIMITS.maxRepeat} items` });
      else v.forEach((row, i) => (typeof row === 'object' && row !== null && !Array.isArray(row) ? problems.push(...checkData(f.item!, row as Data, { where: `${base}.${f.name}[${i}]` })) : problems.push({ where: `${base}.${f.name}[${i}]`, message: 'an item must be an object' })));
    } else if (f.type === 'choice') {
      if (typeof v !== 'string' || !f.choices!.includes(v)) problems.push({ where: `${base}.${f.name}`, message: `${f.label} must be one of ${f.choices!.join(', ')}` });
    } else if (!TYPE_OK[f.type](v)) problems.push({ where: `${base}.${f.name}`, message: `${f.label} must be a ${f.type}` });
  }
  return problems;
}

// ---------------------------------------------------------------- rendering

/** Expands a template with data into pdf blocks. Throws TemplateProblems unless every merge field has a value (or draft). */
export function renderBlocks(t: Template, data: Data, o: RenderOptions = {}): Block[] {
  const bad = [...checkTemplate(t), ...(o.draft ? [] : checkData(t.fields, data))];
  if (bad.length) throw new TemplateProblems(bad);
  const problems: Problem[] = [];
  const out: Block[] = [];
  const push = (b: Block, where: string) => {
    if (out.length >= LIMITS.maxBlocks) {
      if (out.length === LIMITS.maxBlocks) problems.push({ where, message: `more than ${LIMITS.maxBlocks} blocks of output` });
      out.push({ space: 0 });
      return;
    }
    out.push(b);
  };
  const items = (path: string, scope: Scope, where: string): unknown[] => {
    const v = lookup(scope, path);
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      problems.push({ where, message: `${path} is not a list` });
      return [];
    }
    if (v.length > LIMITS.maxRepeat) {
      problems.push({ where, message: `${path} has more than ${LIMITS.maxRepeat} items` });
      return [];
    }
    return v;
  };
  const walk = (ns: readonly Node[], scope: Scope, where: string) => {
    ns.forEach((n, i) => {
      const w = `${where}[${i}]`;
      if ('h' in n) push({ h: merge(n.h, scope, o, w, problems) }, w);
      else if ('p' in n) push({ p: merge(n.p, scope, o, w, problems) }, w);
      else if ('space' in n) push({ space: n.space }, w);
      else if ('table' in n) {
        const tb = n.table;
        const rows: string[][] = [];
        if (tb.header) rows.push(tb.header.map((c) => merge(c, scope, o, w, problems)));
        for (const r of tb.rows ?? []) rows.push(r.map((c) => merge(c, scope, o, w, problems)));
        if (tb.repeat) {
          const list = items(tb.repeat.over, scope, w);
          list.forEach((row, k) => rows.push(tb.repeat!.cells.map((c) => merge(c, [...scope, { [tb.repeat!.as]: row, loop: loopVars(k, list.length) }], o, w, problems))));
        }
        push({ table: rows, ...(tb.widths ? { widths: tb.widths } : {}) }, w);
      } else if ('repeat' in n) {
        const list = items(n.repeat.over, scope, w);
        list.forEach((row, k) => walk(n.repeat.body, [...scope, { [n.repeat.as]: row, loop: loopVars(k, list.length) }], `${w}.repeat[${k}]`));
      } else walk(holds(n.if, scope) ? n.then : (n.else ?? []), scope, w);
    });
  };
  walk(t.body, [data], 'body');
  if (problems.length) throw new TemplateProblems(problems);
  return out;
}

const loopVars = (i: number, n: number) => ({ index: i + 1, index0: i, first: i === 0, last: i === n - 1, length: n });

export const hashTemplate = (t: Template): string => {
  const { id, name, roles, fields, body } = t;
  return createHash('sha256').update(canonical({ id, name, roles, fields, body })).digest('hex');
};

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export interface Rendered {
  readonly pdf: Buffer;
  /** What made this output: kept with the document so it can be traced and explained later. */
  readonly stamp: { readonly template: string; readonly version: number; readonly templateHash: string; readonly dataHash: string; readonly renderedAt: number };
}

/** Publishes versions, and renders any of them. */
export class TemplateLibrary {
  private readonly versions = new Map<string, Published[]>();
  private readonly now: () => number;
  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  /** Publishes a template as the next version, or returns the existing one if nothing changed. Published versions never change. */
  publish(t: Template): Published {
    const problems = checkTemplate(t);
    if (problems.length) throw new TemplateProblems(problems);
    const hash = hashTemplate(t);
    const list = this.versions.get(t.id) ?? [];
    const last = list.at(-1);
    if (last?.hash === hash) return last;
    const p: Published = deepFreeze({ ...structuredClone(t), version: (last?.version ?? 0) + 1, hash, publishedAt: this.now() });
    this.versions.set(t.id, [...list, p]);
    return p;
  }

  get(id: string, version?: number): Published {
    const list = this.versions.get(id) ?? [];
    const p = version === undefined ? list.at(-1) : list.find((x) => x.version === version);
    if (!p) throw new TemplateProblems([{ where: id, message: version === undefined ? 'no such template' : `no version ${version}` }]);
    return p;
  }

  list(): { id: string; name: string; latest: number }[] {
    return [...this.versions.values()].map((l) => ({ id: l.at(-1)!.id, name: l.at(-1)!.name, latest: l.at(-1)!.version })).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** What differs between two versions, in terms a person can read. */
  changes(id: string, from: number, to: number): string[] {
    const a = this.get(id, from);
    const b = this.get(id, to);
    const out: string[] = [];
    const fa = fieldPaths(a.fields);
    const fb = fieldPaths(b.fields);
    for (const [k, f] of fb) if (!fa.has(k)) out.push(`field added: ${k}${f.required ? ' (required)' : ''}`);
    for (const k of fa.keys()) if (!fb.has(k)) out.push(`field removed: ${k}`);
    for (const [k, f] of fb) {
      const o = fa.get(k);
      if (!o) continue;
      if (o.type !== f.type) out.push(`field ${k}: type ${o.type} became ${f.type}`);
      if (!!o.required !== !!f.required) out.push(`field ${k}: ${f.required ? 'now required' : 'no longer required'}`);
      if (o.role !== f.role) out.push(`field ${k}: role ${o.role ?? 'none'} became ${f.role ?? 'none'}`);
    }
    if (canonical(a.body) !== canonical(b.body)) out.push('body changed');
    return out;
  }

  /** Renders a version (the latest by default) to a PDF with a footer naming the template, version and hash. */
  render(id: string, data: Data, o: RenderOptions & { version?: number; author?: string; size?: 'A4' | 'Letter' } = {}): Rendered {
    const t = this.get(id, o.version);
    const blocks = renderBlocks(t, data, o);
    const dataHash = createHash('sha256').update(canonical(data)).digest('hex');
    const tag = `${t.id} v${t.version} ${t.hash.slice(0, 8)}${o.draft ? ' DRAFT' : ''}`;
    const bytes = pdf(blocks, { title: merge(t.name, [data], { ...o, draft: true }, 'title', []), ...(o.author ? { author: o.author } : {}), ...(o.size ? { size: o.size } : {}), footer: (p, n) => `${tag} - page ${p} of ${n}` });
    return { pdf: bytes, stamp: { template: t.id, version: t.version, templateHash: t.hash, dataHash, renderedAt: this.now() } };
  }

  /** What each role still has to fill in, for a signing flow that goes from person to person. */
  progress(t: Template, data: Data): { role: string; label: string; missing: string[]; done: boolean }[] {
    return t.roles.map((r) => {
      const missing = [...fieldPaths(t.fields)]
        .filter(([k, f]) => f.role === r.id && f.required && !k.includes('.'))
        .filter(([k]) => {
          const v = data[k];
          return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
        })
        .map(([, f]) => f.label);
      return { role: r.id, label: r.label, missing, done: missing.length === 0 };
    });
  }
}

/** Takes one role's submitted values: only that role's fields, checked, merged into what is already there. */
export function fillRole(t: Template, role: string, existing: Data, submitted: Data): Data {
  if (!t.roles.some((r) => r.id === role)) throw new TemplateProblems([{ where: 'role', message: `no role ${role}` }]);
  const problems = checkData(t.fields, submitted, { role });
  if (problems.length) throw new TemplateProblems(problems);
  return { ...existing, ...submitted };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
