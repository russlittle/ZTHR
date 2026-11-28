/**
 * Product lines and the products in them, kept in this browser beside the studio's own work.
 *
 *   zthr-lines:v1                 the lines: who each serves, to what end, and the defaults its products start from
 *   intent-studio:v1              the product open in the studio now (the studio's own key)
 *   intent-studio:library:v1      every other product, kept whole, ready to open again
 *
 * A product started in a line begins with the line's spec-sheet choices and its end in mind, so engineering only
 * works out what is different about it.
 */
import type { Options } from '../interfaces.ts';

/** The spec-sheet choices a line hands every product started in it. */
export const LINE_CHOICES = ['compliance', 'identity', 'tickets', 'chat', 'feedback', 'api', 'usage'] as const;

export interface Line {
  readonly id: string;
  readonly name: string;
  /** Who the products in this line serve. */
  readonly serves: string;
  /** The end every product in the line serves. */
  readonly end: string;
  readonly defaults: Options;
  readonly products: readonly string[];
  readonly at: string;
}

const LINES = 'zthr-lines:v1';
const CURRENT = 'intent-studio:v1';
const LIBRARY = 'intent-studio:library:v1';

const get = <T>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const put = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* a browser that keeps nothing still works for this visit */
  }
};

export const lines = (): Line[] => get<{ lines: Line[] }>(LINES, { lines: [] }).lines;
export const saveLines = (ls: readonly Line[]) => put(LINES, { lines: ls });

export function saveLine(l: Omit<Line, 'id' | 'at' | 'products'> & { id?: string }): Line {
  const all = lines();
  const was = l.id ? all.find((x) => x.id === l.id) : undefined;
  const line: Line = { id: was?.id ?? `line-${Date.now().toString(36)}`, at: was?.at ?? new Date().toISOString(), products: was?.products ?? [], name: l.name, serves: l.serves, end: l.end, defaults: l.defaults };
  saveLines([...all.filter((x) => x.id !== line.id), line]);
  return line;
}

interface Saved {
  words?: string;
  product?: string;
  path?: string;
  options?: Options;
  releases?: unknown[];
  signed?: unknown;
}

const titleOf = (s: Saved) => /^#\s+(.+)$/m.exec(s.words ?? '')?.[1]?.trim() ?? '';
const nameOf = (s: Saved) => s.product?.trim() || titleOf(s) || 'Untitled product';

export interface ProductRow {
  readonly name: string;
  readonly line: string | null;
  readonly open: boolean;
  readonly words: number;
  readonly released: number;
  readonly signed: boolean;
}

export function products(): ProductRow[] {
  const cur = get<Saved | null>(CURRENT, null);
  const lib = get<Record<string, Saved>>(LIBRARY, {});
  const lineOf = (n: string) => lines().find((l) => l.products.includes(n))?.name ?? null;
  const row = (s: Saved, open: boolean): ProductRow => ({ name: nameOf(s), line: lineOf(nameOf(s)), open, words: (s.words ?? '').split('\n').filter((x) => x.trim()).length, released: (s.releases ?? []).length, signed: !!s.signed });
  return [...(cur && cur.words?.trim() ? [row(cur, true)] : []), ...Object.values(lib).map((s) => row(s, false))];
}

/** Put the product open in the studio away, whole, so another can be opened. */
export function stash(): void {
  const cur = get<Saved | null>(CURRENT, null);
  if (!cur || !cur.words?.trim()) return;
  put(LIBRARY, { ...get<Record<string, Saved>>(LIBRARY, {}), [nameOf(cur)]: cur });
}

/** Open a product in the studio: the one open now is kept, whole, in the library. */
export function openProduct(name: string): void {
  const cur = get<Saved | null>(CURRENT, null);
  if (cur && nameOf(cur) === name) return;
  const lib = get<Record<string, Saved>>(LIBRARY, {});
  const next = lib[name];
  if (!next) return;
  stash();
  const rest = { ...get<Record<string, Saved>>(LIBRARY, {}) };
  delete rest[name];
  put(LIBRARY, rest);
  put(CURRENT, next);
}

/** Start a product in a line: its spec sheet begins from the line's choices, its schematic from the line's end. */
export function startProduct(name: string, line: Line): void {
  stash();
  const words = `# ${name}\n\n## The end in mind\n\n${line.end}\n\n## What it should do\n\n- \n`;
  put(CURRENT, { v: 1, path: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`, words, product: name, options: line.defaults, view: 'map' });
  saveLines(lines().map((l) => (l.id === line.id ? { ...l, products: [...new Set([...l.products, name])] } : l)));
}

/** Add an existing product to a line, without changing its choices. */
export function addToLine(name: string, lineId: string): void {
  saveLines(lines().map((l) => (l.id === lineId ? { ...l, products: [...new Set([...l.products, name])] } : { ...l, products: l.products.filter((x) => x !== name) })));
}
