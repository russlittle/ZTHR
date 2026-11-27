/**
 * Reference data: code lists (countries, statuses, plan types) whose entries take effect and retire on dates. A
 * lookup is always "as of" a day, so an old record still shows the label it had then; a retired code can point to
 * its replacement; a new list version is checked against the old one before it is accepted, so a change that
 * would orphan stored values (a code removed rather than retired) is refused.
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
}

export class RefData {
  private readonly lists = new Map<string, List>();

  /** Accepts a new version of a list, or says why not. */
  load(next: List): void {
    const problems = check(this.lists.get(next.name), next);
    if (problems.length) throw new Error(`${next.name} v${next.version} refused: ${problems.join('; ')}`);
    this.lists.set(next.name, next);
  }

  /** The entries in effect on a day, in display order. */
  options(name: string, day: string): Code[] {
    return [...(this.lists.get(name)?.codes ?? [])].filter((c) => c.from <= day && (!c.until || day < c.until)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  }

  /** The label a code had on a day, retired codes included, so old records read as they did. */
  label(name: string, code: string, day: string): string | undefined {
    return this.lists.get(name)?.codes.find((c) => c.code === code && c.from <= day)?.label;
  }

  isValid(name: string, code: string, day: string): boolean {
    return this.options(name, day).some((c) => c.code === code);
  }

  /** Follows replacements to the code in use on a day. */
  current(name: string, code: string, day: string): string | undefined {
    const codes = this.lists.get(name)?.codes ?? [];
    const seen = new Set<string>();
    let c = codes.find((x) => x.code === code);
    while (c && c.until && day >= c.until && c.replacedBy && !seen.has(c.code)) {
      seen.add(c.code);
      c = codes.find((x) => x.code === c!.replacedBy);
    }
    return c && this.isValid(name, c.code, day) ? c.code : undefined;
  }
}

export function check(prev: List | undefined, next: List): string[] {
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
  }
  return out;
}
