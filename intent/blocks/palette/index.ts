/**
 * A command palette: every action and place in the product, findable by typing a few letters. Matching is fuzzy
 * (letters in order, word starts and consecutive runs score higher), keywords and synonyms count, commands a
 * person cannot use are never offered, recently used ones rise, and each result says where its keys are bound. The
 * same registry feeds keyboard shortcuts, so a conflict between two shortcuts is found when they are registered.
 */

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
  readonly permission?: string;
  readonly run: () => void | Promise<void>;
}

/** Fuzzy score of query against text, or -1 for no match. */
export function score(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 0;
  let s = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    const wordStart = i === 0 || /[\s\-_/.:]/.test(t[i - 1]!);
    run = i === ti ? run + 1 : 1;
    s += 1 + (wordStart ? 8 : 0) + (run > 1 ? run * 2 : 0) - Math.min(i - ti, 10) * 0.2;
    ti = i + 1;
  }
  if (t.startsWith(q)) s += 15;
  return s - t.length * 0.05;
}

const normKeys = (k: string) => k.toLowerCase().split('+').map((x) => x.trim()).sort().join('+');

export class Palette {
  private readonly commands = new Map<string, Command>();
  private readonly keys = new Map<string, string>();
  private readonly recent: string[] = [];

  register(c: Command): void {
    if (this.commands.has(c.id)) throw new Error(`${c.id} is already registered`);
    if (c.shortcut) {
      const k = normKeys(c.shortcut);
      const other = this.keys.get(k);
      if (other) throw new Error(`${c.shortcut} is already ${this.commands.get(other)!.title}`);
      this.keys.set(k, c.id);
    }
    this.commands.set(c.id, c);
  }

  search(query: string, can: (permission: string) => boolean, limit = 8): { command: Command; score: number }[] {
    const out: { command: Command; score: number }[] = [];
    for (const c of this.commands.values()) {
      if (c.permission !== undefined && !can(c.permission)) continue;
      const best = Math.max(score(query, c.title), ...(c.keywords ?? []).map((k) => score(query, k) - 3), score(query, `${c.section} ${c.title}`) - 5);
      if (best < 0) continue;
      const r = this.recent.indexOf(c.id);
      out.push({ command: c, score: best + (r >= 0 ? 6 - r : 0) });
    }
    return out.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title)).slice(0, limit);
  }

  async run(id: string, can: (permission: string) => boolean): Promise<void> {
    const c = this.commands.get(id);
    if (!c) throw new Error(`no command ${id}`);
    if (c.permission !== undefined && !can(c.permission)) throw new Error('you cannot do that');
    const i = this.recent.indexOf(id);
    if (i >= 0) this.recent.splice(i, 1);
    this.recent.unshift(id);
    this.recent.length = Math.min(this.recent.length, 5);
    await c.run();
  }

  /** The command for a key press, if it is bound and allowed. */
  forKeys(keys: string, can: (permission: string) => boolean): Command | undefined {
    const c = this.commands.get(this.keys.get(normKeys(keys)) ?? '');
    return c && (c.permission === undefined || can(c.permission)) ? c : undefined;
  }

  /** Every binding, for the shortcuts help sheet. */
  cheatsheet(can: (permission: string) => boolean): { section: string; title: string; shortcut: string }[] {
    return [...this.commands.values()].filter((c) => c.shortcut && (c.permission === undefined || can(c.permission))).map((c) => ({ section: c.section, title: c.title, shortcut: c.shortcut! })).sort((a, b) => a.section.localeCompare(b.section) || a.title.localeCompare(b.title));
  }
}
