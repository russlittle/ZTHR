/**
 * Assignment rules: who gets the next ticket, conversation, booking or lead. Rules are tried in order and the
 * first whose conditions match the item chooses the pool and the strategy: round robin (in a fixed order, from
 * where the last one stopped), least loaded (open work against capacity), skills (must hold every needed skill;
 * specialists before generalists, then load), or weighted by free capacity with an injected random source. Whoever
 * is considered must be available, on shift now (weekly shifts in the person's own fixed UTC offset, overnight
 * shifts and days off included) and under capacity; every person passed over is listed with the reason. Fairness
 * is reported from the counts, and a person with the right permission can override a choice, which is logged with
 * who, why and whether it put the person over capacity. Permission is the rbac block's: action "override" on
 * kind "assignment".
 *
 * Clock and randomness are arguments. Out of scope: storing items, notifying people, and the queue an unassigned
 * item waits in (this block says "nobody can take it, and why").
 */
import { require as requirePermission } from '../rbac/index.ts';
import type { Policy, Subject } from '../rbac/index.ts';

export class AssignmentError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface Shift {
  /** 0 is Sunday. */
  readonly days: readonly number[];
  /** Local "HH:MM"; when `to` is earlier than `from` the shift runs past midnight into the next day. */
  readonly from: string;
  readonly to: string;
}

export interface Agent {
  readonly id: string;
  readonly skills?: readonly string[];
  readonly teams?: readonly string[];
  readonly capacity: number;
  readonly available?: boolean;
  /** Without shifts, the person is always on shift. */
  readonly shifts?: readonly Shift[];
  /** Fixed offset from UTC in minutes (Dayton in winter is -300). */
  readonly utcOffsetMin?: number;
  /** Local dates (YYYY-MM-DD) they are away. */
  readonly daysOff?: readonly string[];
  readonly weight?: number;
}

export type Value = string | number | boolean;

export interface Item {
  readonly id: string;
  readonly fields: Readonly<Record<string, Value>>;
  /** Skills this item needs. */
  readonly needs?: readonly string[];
}

export interface Condition {
  readonly field: string;
  readonly equals?: Value;
  readonly in?: readonly Value[];
  readonly exists?: boolean;
}

export type Strategy = 'round-robin' | 'least-loaded' | 'skills' | 'weighted';

export interface Rule {
  readonly id: string;
  /** Every condition must hold; none means every item. */
  readonly when?: readonly Condition[];
  readonly pool: { readonly team?: string; readonly agents?: readonly string[] };
  readonly strategy: Strategy;
  /** Ignore shifts for this rule (a follow-the-sun queue that is never closed). */
  readonly ignoreShifts?: boolean;
}

export interface Passed {
  readonly agent: string;
  readonly reason: string;
}

export interface Outcome {
  readonly item: string;
  readonly agent: string | null;
  readonly rule: string | null;
  readonly because: string;
  readonly passedOver: readonly Passed[];
}

export interface OverrideEntry {
  readonly at: number;
  readonly item: string;
  readonly by: string;
  readonly from: string | null;
  readonly to: string;
  readonly reason: string;
  readonly overCapacity: boolean;
}

const hm = (s: string): number => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new AssignmentError(`"${s}" is not a time like 09:30`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Whether the agent is on shift at `now` (ms since the epoch). A shift that runs past midnight belongs to the day it starts. */
export function onShift(a: Agent, now: number): boolean {
  if (!a.shifts?.length) return !isOff(a, now);
  if (isOff(a, now)) return false;
  const local = new Date(now + (a.utcOffsetMin ?? 0) * 60_000);
  const day = local.getUTCDay();
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return a.shifts.some((s) => {
    const f = hm(s.from);
    const t = hm(s.to);
    if (f === t) throw new AssignmentError('a shift cannot start and end at the same time');
    if (f < t) return s.days.includes(day) && minute >= f && minute < t;
    return (s.days.includes(day) && minute >= f) || (s.days.includes((day + 6) % 7) && minute < t);
  });
}

function isOff(a: Agent, now: number): boolean {
  if (!a.daysOff?.length) return false;
  const local = new Date(now + (a.utcOffsetMin ?? 0) * 60_000).toISOString().slice(0, 10);
  return a.daysOff.includes(local);
}

export function matches(r: Rule, item: Item): boolean {
  return (r.when ?? []).every((c) => {
    const has = Object.hasOwn(item.fields, c.field);
    const v = has ? item.fields[c.field] : undefined;
    if (c.exists !== undefined && has !== c.exists) return false;
    if (c.equals !== undefined && v !== c.equals) return false;
    if (c.in !== undefined && !(v !== undefined && c.in.includes(v))) return false;
    return true;
  });
}

/** Problems with a rule set that would only show up on a busy day. */
export function checkRules(rules: readonly Rule[], agents: readonly Agent[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) out.push(`rule id "${r.id}" is used twice`);
    ids.add(r.id);
    if (!r.pool.team && !r.pool.agents?.length) out.push(`rule ${r.id} has no pool`);
    for (const a of r.pool.agents ?? []) if (!agents.some((x) => x.id === a)) out.push(`rule ${r.id} names ${a}, who does not exist`);
    if (r.pool.team && !agents.some((x) => x.teams?.includes(r.pool.team!))) out.push(`rule ${r.id}: nobody is in team ${r.pool.team}`);
    if (!(r.when ?? []).length && r !== rules.at(-1)) out.push(`rule ${r.id} matches everything, so the rules after it never run`);
  }
  for (const a of agents) if (!(a.capacity >= 0) || !Number.isInteger(a.capacity)) out.push(`${a.id} has a capacity that is not a whole number`);
  return out;
}

export class Assigner {
  private readonly rules: readonly Rule[];
  private readonly load = new Map<string, Set<string>>();
  private readonly owner = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly cursor = new Map<string, string>();
  readonly overrides: OverrideEntry[] = [];

  constructor(rules: readonly Rule[]) {
    this.rules = rules;
  }

  open(agent: string): number {
    return this.load.get(agent)?.size ?? 0;
  }

  holder(item: string): string | null {
    return this.owner.get(item) ?? null;
  }

  private take(item: string, agent: string, now: number): void {
    const prev = this.owner.get(item);
    if (prev) this.load.get(prev)?.delete(item);
    if (!this.load.has(agent)) this.load.set(agent, new Set());
    this.load.get(agent)!.add(item);
    this.owner.set(item, agent);
    this.counts.set(agent, (this.counts.get(agent) ?? 0) + 1);
    this.last.set(agent, now);
  }

  /** The item is done: its place in the person's load is freed. */
  complete(item: string): boolean {
    const a = this.owner.get(item);
    if (!a) return false;
    this.load.get(a)?.delete(item);
    this.owner.delete(item);
    return true;
  }

  /** Everything a person holds, released, for reassignment when they go off sick. */
  release(agent: string): string[] {
    const items = [...(this.load.get(agent) ?? [])];
    for (const i of items) this.owner.delete(i);
    this.load.delete(agent);
    return items;
  }

  assign(item: Item, agents: readonly Agent[], now: number, random: () => number = Math.random): Outcome {
    if (this.owner.has(item.id)) throw new AssignmentError(`item ${item.id} is already assigned to ${this.owner.get(item.id)}`);
    const rule = this.rules.find((r) => matches(r, item));
    if (!rule) return { item: item.id, agent: null, rule: null, because: 'no rule matches this item', passedOver: [] };
    const pool = agents.filter((a) => (rule.pool.agents ? rule.pool.agents.includes(a.id) : true) && (rule.pool.team ? a.teams?.includes(rule.pool.team) : true));
    const passed: Passed[] = [];
    const eligible: Agent[] = [];
    for (const a of pool) {
      const why = this.why(a, item, rule, now);
      if (why) passed.push({ agent: a.id, reason: why });
      else eligible.push(a);
    }
    if (!eligible.length) return { item: item.id, agent: null, rule: rule.id, because: pool.length ? 'everyone in the pool was passed over' : 'the pool is empty', passedOver: passed };
    const chosen = this.choose(rule, item, pool, eligible, random);
    this.take(item.id, chosen.agent.id, now);
    this.cursor.set(rule.id, chosen.agent.id);
    return { item: item.id, agent: chosen.agent.id, rule: rule.id, because: chosen.because, passedOver: passed };
  }

  private why(a: Agent, item: Item, rule: Rule, now: number): string | null {
    if (a.available === false) return 'marked unavailable';
    if (!rule.ignoreShifts && !onShift(a, now)) return 'off shift';
    if (this.open(a.id) >= a.capacity) return `at capacity (${this.open(a.id)} of ${a.capacity})`;
    const missing = (item.needs ?? []).filter((s) => !a.skills?.includes(s));
    if (missing.length && rule.strategy === 'skills') return `lacks ${missing.join(', ')}`;
    return null;
  }

  private choose(rule: Rule, item: Item, pool: readonly Agent[], eligible: readonly Agent[], random: () => number): { agent: Agent; because: string } {
    const ratio = (a: Agent) => this.open(a.id) / Math.max(a.capacity, 1);
    const byId = (a: Agent, b: Agent) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const leastRecent = (a: Agent, b: Agent) => (this.last.get(a.id) ?? -Infinity) - (this.last.get(b.id) ?? -Infinity);
    switch (rule.strategy) {
      case 'round-robin': {
        const order = [...pool].sort(byId);
        const prev = this.cursor.get(rule.id);
        const start = prev === undefined ? 0 : order.findIndex((a) => a.id === prev) + 1;
        for (let i = 0; i < order.length; i++) {
          const a = order[(start + i) % order.length]!;
          if (eligible.includes(a)) return { agent: a, because: `next in turn under rule ${rule.id}` };
        }
        break;
      }
      case 'least-loaded': {
        const a = [...eligible].sort((x, y) => ratio(x) - ratio(y) || leastRecent(x, y) || byId(x, y))[0]!;
        return { agent: a, because: `least loaded (${this.open(a.id)} of ${a.capacity})` };
      }
      case 'skills': {
        const need = item.needs ?? [];
        const a = [...eligible].sort((x, y) => (x.skills?.length ?? 0) - (y.skills?.length ?? 0) || ratio(x) - ratio(y) || leastRecent(x, y) || byId(x, y))[0]!;
        return { agent: a, because: need.length ? `has ${need.join(', ')} with the fewest other skills` : 'no skills needed; fewest other skills' };
      }
      case 'weighted': {
        const free = eligible.map((a) => (a.weight ?? 1) * (a.capacity - this.open(a.id)));
        const total = free.reduce((s, x) => s + x, 0);
        let r = random() * total;
        for (const [i, a] of eligible.entries()) {
          r -= free[i]!;
          if (r < 0) return { agent: a, because: `drawn by weight and free capacity (${free[i]} of ${total})` };
        }
        return { agent: eligible.at(-1)!, because: 'drawn by weight and free capacity' };
      }
    }
    return { agent: eligible[0]!, because: 'first available' };
  }

  /** A person with permission puts an item with someone else, whatever the rules said; it is logged. */
  override(policy: Policy, actor: Subject, item: string, to: Agent, reason: string, now: number): OverrideEntry {
    requirePermission(policy, actor, 'override', 'assignment');
    if (!reason.trim()) throw new AssignmentError('an override needs a reason');
    const from = this.owner.get(item) ?? null;
    const entry: OverrideEntry = { at: now, item, by: actor.id, from, to: to.id, reason: reason.trim(), overCapacity: this.open(to.id) >= to.capacity && from !== to.id };
    this.take(item, to.id, now);
    this.overrides.push(entry);
    return entry;
  }

  /** How evenly work has gone round: each person's share of everything assigned, and the gap between most and least. */
  fairness(agents: readonly Agent[]): { shares: Record<string, number>; spread: number; total: number } {
    const total = agents.reduce((s, a) => s + (this.counts.get(a.id) ?? 0), 0);
    const shares: Record<string, number> = {};
    for (const a of agents) shares[a.id] = total ? Math.round(((this.counts.get(a.id) ?? 0) / total) * 1000) / 1000 : 0;
    const v = Object.values(shares);
    return { shares, spread: v.length ? Math.round((Math.max(...v) - Math.min(...v)) * 1000) / 1000 : 0, total };
  }
}
