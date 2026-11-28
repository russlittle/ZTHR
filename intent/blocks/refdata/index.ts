/**
 * Reference data: code lists (countries, statuses, plan types) whose entries take effect and retire on dates. A
 * lookup is always "as of" a day, so an old record still shows the label it had then, across list versions: every
 * accepted version is kept with the day its wording takes effect. A retired code can point to its replacement; a new
 * list version is checked against the old one before it is accepted, so a change that would orphan stored values (a
 * code removed rather than retired) or rewrite history (a label renamed with no day it takes effect) is refused.
 */

export interface Code {
  readonly code: string;
  readonly label: string;
  readonly from: string;
  readonly until?: string;
  readonly replacedBy?: string;
  readonly order?: number;
}

export interface List {
  readonly name: string;
  readonly version: number;
  readonly codes: readonly Code[];
  /**
   * The day this version's wording (labels, order) takes effect; days before it read from the version before. A
   * version that renames a label must give one; without one, a version takes effect from the same day as the
   * version before it (from the start, for the first).
   */
  readonly from?: string;
}

interface Version {
  readonly list: List;
  readonly from: string;
}

export class RefData {
  /** Every accepted version of each list, oldest first. */
  private readonly lists = new Map<string, Version[]>();

  private latest(name: string): List | undefined {
    return this.lists.get(name)?.at(-1)?.list;
  }

  /** The entry for a code as worded on a day: from the newest version in effect then that has it. */
  private entry(name: string, code: string, day: string): Code | undefined {
    const vs = this.lists.get(name) ?? [];
    for (let i = vs.length - 1; i >= 0; i--) {
      if (vs[i]!.from > day) continue;
      const c = vs[i]!.list.codes.find((x) => x.code === code);
      if (c) return c;
    }
    return this.latest(name)?.codes.find((x) => x.code === code);
  }

  /** Accepts a new version of a list, or says why not. */
  load(next: List): void {
    const vs = this.lists.get(next.name) ?? [];
    const prev = vs.at(-1);
    const problems = check(prev?.list, next, prev?.from);
    if (problems.length) throw new Error(`${next.name} v${next.version} refused: ${problems.join('; ')}`);
    vs.push({ list: next, from: next.from ?? prev?.from ?? '' });
    this.lists.set(next.name, vs);
  }

  /** The entries in effect on a day, in display order, worded as they were that day. */
  options(name: string, day: string): Code[] {
    return (this.latest(name)?.codes ?? [])
      .filter((c) => c.from <= day && (!c.until || day < c.until))
      .map((c) => this.entry(name, c.code, day) ?? c)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  }

  /** The label a code had on a day, retired codes included, so old records read as they did. */
  label(name: string, code: string, day: string): string | undefined {
    const c = this.entry(name, code, day);
    return c && c.from <= day ? c.label : undefined;
  }

  isValid(name: string, code: string, day: string): boolean {
    return this.options(name, day).some((c) => c.code === code);
  }

  /** Follows replacements to the code in use on a day. */
  current(name: string, code: string, day: string): string | undefined {
    const codes = this.latest(name)?.codes ?? [];
    const seen = new Set<string>();
    let c = codes.find((x) => x.code === code);
    while (c && c.until && day >= c.until && c.replacedBy && !seen.has(c.code)) {
      seen.add(c.code);
      c = codes.find((x) => x.code === c!.replacedBy);
    }
    return c && this.isValid(name, c.code, day) ? c.code : undefined;
  }
}

/**
 * Why a new version of a list cannot replace the one before, if it cannot. `prevFrom` is the day the previous
 * version took effect (its own `from`, or the day it inherited), when known.
 */
export function check(prev: List | undefined, next: List, prevFrom = prev?.from): string[] {
  const out: string[] = [];
  const codes = new Set<string>();
  for (const c of next.codes) {
    if (codes.has(c.code)) out.push(`${c.code} appears twice`);
    codes.add(c.code);
    if (c.until && c.until <= c.from) out.push(`${c.code} retires before it starts`);
  }
  for (const c of next.codes) if (c.replacedBy && !codes.has(c.replacedBy)) out.push(`${c.code} is replaced by ${c.replacedBy}, which is not in the list`);
  if (prev) {
    if (next.version <= prev.version) out.push(`version must be above ${prev.version}`);
    for (const c of prev.codes) if (!codes.has(c.code)) out.push(`${c.code} was removed; retire it with an end date instead, so stored values still read`);
    if (next.from === undefined) {
      for (const c of prev.codes) {
        const n = next.codes.find((x) => x.code === c.code);
        if (n && n.label !== c.label) out.push(`${c.code} is renamed from ${c.label} to ${n.label}; give the version a from day, so records before it still read ${c.label}`);
      }
    } else if (prevFrom !== undefined && next.from < prevFrom) out.push(`from must not be before ${prevFrom}, when version ${prev.version} took effect`);
  }
  return out;
}
