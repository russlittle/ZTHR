/**
 * Navigation menus kept as data and resolved per request. A menu is a tree of items; each item may carry a label and
 * an address per language, a condition (a small JSON expression over who is asking: signed in, roles, feature flags,
 * language, any value in the context), and a permission checked by a function the application supplies.
 *
 * Resolving a menu for one request:
 * - hides an item whose condition or permission fails, with its whole subtree, and says why in `hidden`;
 * - prunes a group (an item with no address of its own) that has no visible children left, so no empty drop-downs;
 * - picks labels and addresses by language with fallbacks (pt-BR, then pt, then the fallbacks, then the default);
 *   an item with no label in any of them is left out and listed in `missing`, never shown blank;
 * - drops addresses that are not http, https, mailto, tel, relative or in-page, so a stored `javascript:` link cannot
 *   reach a page;
 * - finds the one active item for the current path (exact match beats prefix match, longer beats shorter, deeper
 *   beats shallower on a tie), marks it `page` for aria-current, and marks its ancestors `trail`, so the open
 *   branch and the breadcrumbs come from the same answer.
 *
 * Also here: checks on a stored menu (unique ids, limits, unsafe addresses, groups with nothing in them, labels
 * missing for required languages) and the edits an admin screen needs (insert, remove, move) that never produce a menu
 * which is not a tree. Everything returns new values; nothing is changed in place.
 *
 * Not here: rendering, icons, the storage of menus, and the permission system itself (a function is passed in).
 * Pure: no clock, no network. (The tree block holds file trees with ids and etags; a menu is small and per-request,
 * so it is kept here as plain nested data.)
 */

export class InvalidMenu extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'InvalidMenu';
  }
}
export class InvalidCondition extends Error {
  constructor(why: string) {
    super(`not a valid condition: ${why}`);
    this.name = 'InvalidCondition';
  }
}

export type Localised = string | Readonly<Record<string, string>>;

export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly authenticated: boolean }
  | { readonly role: string | readonly string[] }
  | { readonly flag: string }
  | { readonly locale: string | readonly string[] }
  | { readonly equals: { readonly path: string; readonly value: unknown } }
  | { readonly exists: string };

export type MatchRule = 'exact' | 'prefix' | readonly string[];

export interface MenuItem {
  readonly id: string;
  readonly label: Localised;
  readonly href?: Localised;
  readonly children?: readonly MenuItem[];
  readonly when?: Condition;
  /** Checked with `can`; with no `can` function it is refused. */
  readonly permission?: string;
  /** How the current path selects this item: its address exactly (default), the address and everything below it, or listed patterns (trailing /* is a prefix). */
  readonly match?: MatchRule;
  readonly target?: '_blank' | '_self';
  readonly order?: number;
}

export interface Context {
  /** The request path, with or without query string and fragment. */
  readonly path?: string;
  readonly locale?: string;
  /** Tried after the locale and its language, in order. */
  readonly fallbackLocales?: readonly string[];
  readonly authenticated?: boolean;
  readonly roles?: readonly string[];
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly can?: (permission: string) => boolean;
  /** Anything else a condition may look at, by dotted path. */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface ResolvedItem {
  readonly id: string;
  readonly label: string;
  readonly href?: string;
  readonly external: boolean;
  readonly target?: '_blank' | '_self';
  readonly active: boolean;
  /** 'page' for the active item (aria-current="page"), 'trail' for its ancestors. */
  readonly current: 'page' | 'trail' | null;
  readonly depth: number;
  readonly children: readonly ResolvedItem[];
}

export interface Resolved {
  readonly items: readonly ResolvedItem[];
  readonly active: ResolvedItem | null;
  readonly hidden: readonly { readonly id: string; readonly reason: string }[];
  readonly missing: readonly { readonly id: string; readonly what: 'label'; readonly locale: string }[];
  readonly dropped: readonly { readonly id: string; readonly reason: string }[];
}

// ---------------------------------------------------------------- conditions

const MAX_COND_DEPTH = 10;

function lookup(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const p of path.split('.')) {
    if (typeof v !== 'object' || v === null || !Object.hasOwn(v, p)) return undefined;
    v = (v as Record<string, unknown>)[p];
  }
  return v;
}

/** Whether a condition holds for a context. Throws InvalidCondition for a shape it does not know. */
export function evaluate(c: Condition, ctx: Context, depth = 0): boolean {
  if (depth > MAX_COND_DEPTH) throw new InvalidCondition(`nested deeper than ${MAX_COND_DEPTH}`);
  if (typeof c !== 'object' || c === null) throw new InvalidCondition('a condition is an object');
  const keys = Object.keys(c);
  if (keys.length !== 1) throw new InvalidCondition(`exactly one of all, any, not, authenticated, role, flag, locale, equals, exists; got ${keys.join(', ') || 'none'}`);
  const k = keys[0]!;
  const v = (c as Record<string, unknown>)[k];
  switch (k) {
    case 'all':
      if (!Array.isArray(v)) throw new InvalidCondition('all needs a list');
      return v.every((x) => evaluate(x as Condition, ctx, depth + 1));
    case 'any':
      if (!Array.isArray(v)) throw new InvalidCondition('any needs a list');
      return v.some((x) => evaluate(x as Condition, ctx, depth + 1));
    case 'not':
      return !evaluate(v as Condition, ctx, depth + 1);
    case 'authenticated':
      if (typeof v !== 'boolean') throw new InvalidCondition('authenticated is true or false');
      return (ctx.authenticated ?? false) === v;
    case 'role': {
      const want = typeof v === 'string' ? [v] : v;
      if (!Array.isArray(want) || !want.every((x) => typeof x === 'string')) throw new InvalidCondition('role is a name or a list of names');
      return want.some((r) => (ctx.roles ?? []).includes(r as string));
    }
    case 'flag':
      if (typeof v !== 'string') throw new InvalidCondition('flag is a name');
      return ctx.flags !== undefined && Object.hasOwn(ctx.flags, v) && ctx.flags[v] === true;
    case 'locale': {
      const want = typeof v === 'string' ? [v] : v;
      if (!Array.isArray(want)) throw new InvalidCondition('locale is a code or a list of codes');
      const l = (ctx.locale ?? '').toLowerCase();
      return want.some((w) => typeof w === 'string' && (l === w.toLowerCase() || l.split('-')[0] === w.toLowerCase()));
    }
    case 'equals': {
      const e = v as { path?: unknown; value?: unknown };
      if (!e || typeof e.path !== 'string') throw new InvalidCondition('equals needs a path and a value');
      return Object.is(lookup(ctx.data, e.path), e.value) || JSON.stringify(lookup(ctx.data, e.path)) === JSON.stringify(e.value);
    }
    case 'exists':
      if (typeof v !== 'string') throw new InvalidCondition('exists is a path');
      return lookup(ctx.data, v) !== undefined;
    default:
      throw new InvalidCondition(`"${k}" is not a known test`);
  }
}

// ---------------------------------------------------------------- languages and addresses

/** The text for a locale: its own entry, then its language, then each fallback and its language. */
export function pick(value: Localised | undefined, locale: string | undefined, fallbacks: readonly string[] = []): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  const tries: string[] = [];
  for (const l of [locale, ...fallbacks]) {
    if (!l) continue;
    tries.push(l, l.split('-')[0]!);
  }
  const keys = Object.keys(value);
  for (const t of tries) {
    const hit = keys.find((k) => k.toLowerCase() === t.toLowerCase());
    if (hit !== undefined && Object.hasOwn(value, hit) && value[hit] !== '') return value[hit];
  }
  return undefined;
}

const SAFE_SCHEME = /^(?:https?|mailto|tel):/i;

/** Whether an address may be linked: http, https, mailto, tel, a path, or a fragment. */
export function safeHref(href: string): boolean {
  const h = href.trim();
  // eslint-disable-next-line no-control-regex
  if (!h || h.length > 2048 || /[\u0000-\u001f\u007f]/.test(h) || /\s/.test(h.replace(/^\s+|\s+$/g, ''))) return false;
  if (SAFE_SCHEME.test(h)) return true;
  if (h.startsWith('//')) return false;
  return /^[/#?]/.test(h) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h);
}

function normPath(p: string): string {
  let s = p.split('#')[0]!.split('?')[0]!;
  try {
    s = decodeURI(s);
  } catch {
    /* keep as written */
  }
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

function matchScore(item: MenuItem, href: string | undefined, path: string): number {
  const rule: MatchRule = item.match ?? 'exact';
  let best = 0;
  const own = href !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('//') ? normPath(href) : undefined;
  if (rule === 'exact') {
    if (own !== undefined && own === path) best = 10_000 + own.length;
  } else if (rule === 'prefix') {
    if (own !== undefined && (own === path || own === '/' || path.startsWith(`${own}/`))) best = (own === path ? 10_000 : 1000) + own.length;
  } else {
    for (const pat of rule) {
      if (pat.endsWith('/*')) {
        const base = normPath(pat.slice(0, -2));
        if (path === base || path.startsWith(`${base}/`)) best = Math.max(best, 1000 + base.length);
      } else if (normPath(pat) === path) best = Math.max(best, 10_000 + pat.length);
    }
    if (own !== undefined && own === path) best = Math.max(best, 10_000 + own.length);
  }
  return best;
}

// ---------------------------------------------------------------- resolving

const sortItems = (list: readonly MenuItem[]) => list.map((it, i) => ({ it, i })).sort((a, b) => (a.it.order ?? 0) - (b.it.order ?? 0) || a.i - b.i).map((x) => x.it);

/** The menu for one request. */
export function resolve(menu: readonly MenuItem[], ctx: Context = {}): Resolved {
  const hidden: { id: string; reason: string }[] = [];
  const missing: { id: string; what: 'label'; locale: string }[] = [];
  const dropped: { id: string; reason: string }[] = [];
  const path = normPath(ctx.path ?? '/');
  const locale = ctx.locale ?? 'en';
  const fb = ctx.fallbackLocales ?? [];
  let bestScore = 0;
  let bestDepth = -1;

  type Draft = { item: MenuItem; label: string; href: string | undefined; external: boolean; depth: number; children: Draft[] };
  const build = (list: readonly MenuItem[], depth: number): Draft[] => {
    const out: Draft[] = [];
    for (const it of sortItems(list)) {
      if (it.when) {
        let ok: boolean;
        try {
          ok = evaluate(it.when, ctx);
        } catch (e) {
          hidden.push({ id: it.id, reason: `its condition is broken: ${(e as Error).message}` });
          continue;
        }
        if (!ok) {
          hidden.push({ id: it.id, reason: 'its condition is not met' });
          continue;
        }
      }
      if (it.permission !== undefined && !(ctx.can?.(it.permission) ?? false)) {
        hidden.push({ id: it.id, reason: `needs the permission ${it.permission}` });
        continue;
      }
      const label = pick(it.label, locale, fb);
      if (label === undefined) {
        missing.push({ id: it.id, what: 'label', locale });
        continue;
      }
      let href = pick(it.href, locale, fb);
      if (href !== undefined && !safeHref(href)) {
        dropped.push({ id: it.id, reason: 'the address is not one that may be linked' });
        href = undefined;
      }
      const children = it.children ? build(it.children, depth + 1) : [];
      if (href === undefined && !children.length) {
        hidden.push({ id: it.id, reason: it.children?.length ? 'nothing in it is visible' : 'it has no address' });
        continue;
      }
      out.push({ item: it, label, href, external: href !== undefined && /^(?:https?:)?\/\//i.test(href) || (href !== undefined && /^(?:mailto|tel):/i.test(href)), depth, children });
    }
    return out;
  };

  const drafts = build(menu, 0);
  // The active item: the best score; a deeper item wins a tie; an earlier one wins after that.
  const scoreOf = new Map<Draft, number>();
  const visit = (ds: Draft[]) => {
    for (const d of ds) {
      const s = matchScore(d.item, d.href, path);
      scoreOf.set(d, s);
      visit(d.children);
    }
  };
  visit(drafts);
  let activeDraft: Draft | null = null;
  const pick2 = (ds: Draft[]) => {
    for (const d of ds) {
      const s = scoreOf.get(d)!;
      if (s > 0 && (s > bestScore || (s === bestScore && d.depth > bestDepth))) {
        bestScore = s;
        bestDepth = d.depth;
        activeDraft = d;
      }
      pick2(d.children);
    }
  };
  pick2(drafts);

  let activeItem: ResolvedItem | null = null;
  const finish = (ds: Draft[]): ResolvedItem[] =>
    ds.map((d) => {
      const kids = finish(d.children);
      const isActive = d === activeDraft;
      const inTrail = kids.some((k) => k.current !== null);
      const r: ResolvedItem = {
        id: d.item.id,
        label: d.label,
        ...(d.href !== undefined ? { href: d.href } : {}),
        external: d.external,
        ...(d.item.target ? { target: d.item.target } : {}),
        active: isActive,
        current: isActive ? 'page' : inTrail ? 'trail' : null,
        depth: d.depth,
        children: kids,
      };
      if (isActive) activeItem = r;
      return r;
    });
  const items = finish(drafts);
  return { items, active: activeItem, hidden, missing, dropped };
}

/** The breadcrumb trail to the active item: labels and addresses from the top down. */
export function breadcrumbs(items: readonly ResolvedItem[]): { id: string; label: string; href?: string }[] {
  const out: { id: string; label: string; href?: string }[] = [];
  let level: readonly ResolvedItem[] = items;
  while (true) {
    const next = level.find((i) => i.current !== null);
    if (!next) break;
    out.push({ id: next.id, label: next.label, ...(next.href !== undefined ? { href: next.href } : {}) });
    if (next.current === 'page') break;
    level = next.children;
  }
  return out;
}

// ---------------------------------------------------------------- checking and editing a stored menu

export interface CheckOptions {
  readonly maxDepth?: number;
  readonly maxItems?: number;
  /** Languages every label must exist in. */
  readonly requiredLocales?: readonly string[];
}

/** Problems with a stored menu, as plain messages with the item they concern. */
export function check(menu: readonly MenuItem[], o: CheckOptions = {}): { id: string; problem: string }[] {
  const out: { id: string; problem: string }[] = [];
  const maxDepth = o.maxDepth ?? 4;
  const maxItems = o.maxItems ?? 500;
  const seen = new Set<string>();
  let count = 0;
  const walk = (list: readonly MenuItem[], depth: number) => {
    for (const it of list) {
      count++;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(it.id)) out.push({ id: it.id, problem: 'the id must be letters, digits and _ . : -' });
      if (seen.has(it.id)) out.push({ id: it.id, problem: 'the id is used twice' });
      seen.add(it.id);
      if (depth >= maxDepth) out.push({ id: it.id, problem: `it is nested deeper than ${maxDepth} levels` });
      for (const [what, v] of [['label', it.label], ['href', it.href]] as const) {
        if (v === undefined) continue;
        for (const s of typeof v === 'string' ? [v] : Object.values(v)) if (typeof s !== 'string') out.push({ id: it.id, problem: `${what} must be text` });
        if (what === 'href') for (const s of typeof v === 'string' ? [v] : Object.values(v)) if (typeof s === 'string' && !safeHref(s)) out.push({ id: it.id, problem: `the address "${s.slice(0, 40)}" cannot be linked` });
      }
      for (const l of o.requiredLocales ?? []) if (pick(it.label, l) === undefined) out.push({ id: it.id, problem: `no label in ${l}` });
      if (typeof it.label === 'string' ? it.label.trim() === '' : Object.keys(it.label).length === 0) out.push({ id: it.id, problem: 'the label is empty' });
      if (it.href === undefined && !(it.children?.length)) out.push({ id: it.id, problem: 'it has no address and nothing in it' });
      if (it.permission !== undefined && !it.permission.trim()) out.push({ id: it.id, problem: 'the permission is empty' });
      if (it.when) {
        try {
          evaluate(it.when, { data: {} });
        } catch (e) {
          if (e instanceof InvalidCondition) out.push({ id: it.id, problem: e.message });
        }
      }
      if (it.children) walk(it.children, depth + 1);
    }
  };
  walk(menu, 0);
  if (count > maxItems) out.push({ id: '', problem: `the menu has ${count} items; the limit is ${maxItems}` });
  return out;
}

export function find(menu: readonly MenuItem[], id: string): MenuItem | undefined {
  for (const it of menu) {
    if (it.id === id) return it;
    const inner = it.children ? find(it.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

const contains = (it: MenuItem, id: string): boolean => it.id === id || (it.children ?? []).some((c) => contains(c, id));

function without(menu: readonly MenuItem[], id: string): MenuItem[] {
  return menu.filter((it) => it.id !== id).map((it) => (it.children ? { ...it, children: without(it.children, id) } : it));
}

/** The menu with `item` added under `parentId` (null for the top) at `index` (default last). */
export function insert(menu: readonly MenuItem[], item: MenuItem, parentId: string | null = null, index?: number): MenuItem[] {
  if (find(menu, item.id)) throw new InvalidMenu(`there is already an item "${item.id}"`);
  const at = (list: readonly MenuItem[]) => {
    const i = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, i), item, ...list.slice(i)];
  };
  if (parentId === null) return at(menu);
  if (!find(menu, parentId)) throw new InvalidMenu(`there is no item "${parentId}" to put it under`);
  const go = (list: readonly MenuItem[]): MenuItem[] => list.map((it) => (it.id === parentId ? { ...it, children: at(it.children ?? []) } : it.children ? { ...it, children: go(it.children) } : it));
  return go(menu);
}

export function remove(menu: readonly MenuItem[], id: string): MenuItem[] {
  if (!find(menu, id)) throw new InvalidMenu(`there is no item "${id}"`);
  return without(menu, id);
}

/** Moves an item, with everything under it, to a new parent and position. Refuses to move it into itself. */
export function move(menu: readonly MenuItem[], id: string, parentId: string | null, index?: number): MenuItem[] {
  const item = find(menu, id);
  if (!item) throw new InvalidMenu(`there is no item "${id}"`);
  if (parentId !== null && contains(item, parentId)) throw new InvalidMenu(`"${id}" cannot be moved into itself or something inside it`);
  return insert(without(menu, id), item, parentId, index);
}
