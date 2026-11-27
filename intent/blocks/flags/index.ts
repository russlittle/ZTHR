/**
 * Feature flags: a flag is off, on, on for named people or groups, or on for a stable percentage of people (the
 * same person always lands the same side, and raising the percentage only ever adds people). A kill switch turns
 * a flag off for everyone at once, whatever its rules say. Every evaluation can say why it came out as it did, and
 * a flag past its removal date is reported, so flags do not live for ever.
 */
import { createHash } from 'node:crypto';

export interface Rule {
  readonly people?: readonly string[];
  readonly groups?: readonly string[];
  /** Attributes that must match (plan, region). */
  readonly attrs?: Readonly<Record<string, readonly string[]>>;
  /** 0 to 100: share of the people this rule reaches. */
  readonly percent?: number;
}

export interface Flag {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly on: boolean;
  /** Any rule that matches turns it on; with no rules, `on` alone decides. */
  readonly rules?: readonly Rule[];
  readonly killed?: boolean;
  /** When it should be gone from the code (YYYY-MM-DD). */
  readonly removeBy?: string;
}

export interface Who {
  readonly id: string;
  readonly groups?: readonly string[];
  readonly attrs?: Readonly<Record<string, string>>;
}

/** Where a person falls, 0 to 99.99, for a flag: stable, and independent between flags. */
export const bucket = (key: string, id: string) => (createHash('sha256').update(`${key}:${id}`).digest().readUInt32BE(0) / 2 ** 32) * 100;

export function evaluate(f: Flag | undefined, who: Who): { on: boolean; because: string } {
  if (!f) return { on: false, because: 'no such flag' };
  if (f.killed) return { on: false, because: 'switched off for everyone' };
  if (!f.on) return { on: false, because: 'off' };
  if (!f.rules?.length) return { on: true, because: 'on for everyone' };
  for (const [i, r] of f.rules.entries()) {
    if (r.people && !r.people.includes(who.id)) continue;
    if (r.groups && !r.groups.some((g) => who.groups?.includes(g))) continue;
    if (r.attrs && !Object.entries(r.attrs).every(([k, vs]) => vs.includes(who.attrs?.[k] ?? ''))) continue;
    if (r.percent !== undefined && bucket(f.key, who.id) >= r.percent) continue;
    return { on: true, because: `rule ${i + 1}${r.percent !== undefined ? ` (${r.percent}% rollout)` : ''}` };
  }
  return { on: false, because: 'no rule reaches them' };
}

export class Flags {
  private readonly flags = new Map<string, Flag>();
  constructor(list: readonly Flag[] = []) {
    for (const f of list) this.flags.set(f.key, f);
  }
  set(f: Flag): void {
    this.flags.set(f.key, f);
  }
  isOn(key: string, who: Who): boolean {
    return evaluate(this.flags.get(key), who).on;
  }
  explain(key: string, who: Who) {
    return evaluate(this.flags.get(key), who);
  }
  kill(key: string): void {
    const f = this.flags.get(key);
    if (f) this.flags.set(key, { ...f, killed: true });
  }
  /** Flags past their removal date, or without one: the list that keeps flags from living for ever. */
  stale(today: string): Flag[] {
    return [...this.flags.values()].filter((f) => !f.removeBy || f.removeBy < today);
  }
}
