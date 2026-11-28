/**
 * Entitlements: what an account may use, decided from its plan. A catalog declares plans (which may extend one
 * another) with features (on or off, optionally also behind a feature flag so a rollout can be staged) and limits
 * (a number per period: per month from the account's billing day, per day, per year, for life, or a "gauge" such as
 * seats that is measured, not summed). Each limit says what happens past it: block, allow free of charge, or
 * allow and charge by the block up to a cap. An account's actual entitlements are its plan, raised by a running
 * trial (the better of plan and trial, once per account), by add-ons, by time-boxed grants, and finally by
 * overrides that can switch a feature off or set a limit outright, each with a reason and an end. The same
 * resolution answers "may they?" (with the reason in words), records usage with an idempotency key so a retried
 * request counts once, warns when a limit is nearly used, prices the overage for an invoice, and reports what a
 * downgrade would break before it happens.
 *
 * Clock is always an argument. Money is whole minor units. Out of scope: taking payment, sending the warnings,
 * and storing usage anywhere but memory (the ledger is an in-memory class with `compact`, behind the same
 * methods a database-backed one would offer).
 */
import { Flags } from '../flags/index.ts';
import type { Who } from '../flags/index.ts';

export class EntitlementError extends Error {
  readonly problems: readonly string[];
  constructor(why: string | readonly string[]) {
    const list = typeof why === 'string' ? [why] : why;
    super(list.join('; '));
    this.problems = list;
  }
}

export type Period = 'day' | 'month' | 'year' | 'lifetime' | 'gauge';

export interface Overage {
  readonly mode: 'block' | 'allow' | 'charge';
  /** For charge: minor units per block of `perUnits`. */
  readonly price?: number;
  readonly perUnits?: number;
  /** The most overage allowed (units); beyond it requests are blocked. */
  readonly cap?: number;
}

export interface LimitSpec {
  /** Included amount; null means unlimited. */
  readonly included: number | null;
  readonly period: Period;
  readonly overage?: Overage;
  /** Share of the limit (0 to 1) at which a warning is given. Default 0.8. */
  readonly warnAt?: number;
}

export interface FeatureSpec {
  readonly enabled: boolean;
  /** Also needs this feature flag on for the person (the flags block). */
  readonly flag?: string;
}

export interface Plan {
  readonly name: string;
  readonly extends?: string;
  readonly features?: Readonly<Record<string, FeatureSpec | boolean>>;
  readonly limits?: Readonly<Record<string, LimitSpec>>;
  /** Days of trial of this plan that an account may have, once. */
  readonly trialDays?: number;
}

export interface Catalog {
  readonly plans: Readonly<Record<string, Plan>>;
  /** Every feature and limit that may be named; anything else is refused. */
  readonly features: readonly string[];
  readonly limits: readonly string[];
}

export interface Grant {
  readonly id: string;
  readonly reason: string;
  readonly from: number;
  readonly until: number;
  readonly feature?: string;
  /** Added to the limit. */
  readonly limit?: string;
  readonly add?: number;
}

export interface Override {
  readonly id: string;
  readonly reason: string;
  readonly until: number | null;
  readonly feature?: string;
  readonly enabled?: boolean;
  readonly limit?: string;
  /** Sets the limit outright (null is unlimited). */
  readonly value?: number | null;
}

export interface Account {
  readonly id: string;
  readonly plan: string;
  /** Billing day of month, 1 to 31 (clamped in short months). */
  readonly anchorDay: number;
  readonly trial?: { readonly plan: string; readonly from: number; readonly until: number };
  readonly trialUsed?: boolean;
  readonly addons?: readonly { readonly limit: string; readonly add: number }[];
  readonly addonFeatures?: readonly string[];
  readonly grants?: readonly Grant[];
  readonly overrides?: readonly Override[];
}

export type Source = 'plan' | 'trial' | 'addon' | 'grant' | 'override';

export interface FeatureView {
  readonly enabled: boolean;
  readonly source: Source | 'none';
  readonly flag?: string;
  readonly because: string;
}

export interface LimitView {
  /** The effective limit; null is unlimited. */
  readonly limit: number | null;
  readonly period: Period;
  readonly overage: Overage;
  readonly warnAt: number;
  readonly sources: readonly string[];
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- catalog checks and inheritance

/** Everything wrong with a catalog, so it can be fixed in one pass. */
export function checkCatalog(c: Catalog): string[] {
  const out: string[] = [];
  const features = new Set(c.features);
  const limits = new Set(c.limits);
  for (const [key, p] of Object.entries(c.plans)) {
    if (p.name !== key) out.push(`plan "${key}" is named "${p.name}"`);
    const seen = new Set<string>([key]);
    for (let n = p.extends; n; n = c.plans[n]?.extends) {
      if (!c.plans[n]) {
        out.push(`plan ${key} extends ${n}, which does not exist`);
        break;
      }
      if (seen.has(n)) {
        out.push(n === key ? `plan ${key} extends itself` : `plan ${key} leads into a loop of plans at ${n}`);
        break;
      }
      seen.add(n);
    }
    for (const f of Object.keys(p.features ?? {})) if (!features.has(f)) out.push(`plan ${key} names an unknown feature "${f}"`);
    for (const [l, spec] of Object.entries(p.limits ?? {})) {
      if (!limits.has(l)) out.push(`plan ${key} names an unknown limit "${l}"`);
      if (spec.included !== null && (!Number.isInteger(spec.included) || spec.included < 0)) out.push(`plan ${key}: ${l} must be null or a whole number from 0`);
      const o = spec.overage;
      if (o?.mode === 'charge' && (!Number.isInteger(o.price) || o.price! < 0 || !Number.isInteger(o.perUnits) || o.perUnits! < 1)) out.push(`plan ${key}: ${l} charges overage but has no whole price and block size`);
      if (o && o.mode !== 'charge' && (o.price !== undefined || o.perUnits !== undefined)) out.push(`plan ${key}: ${l} has a price but its overage mode is ${o.mode}`);
      if (o?.cap !== undefined && (!Number.isInteger(o.cap) || o.cap < 0)) out.push(`plan ${key}: ${l} overage cap must be a whole number`);
      if (spec.period === 'gauge' && o && o.mode !== 'block') out.push(`plan ${key}: ${l} is a gauge, which can only block`);
      if (spec.warnAt !== undefined && !(spec.warnAt > 0 && spec.warnAt <= 1)) out.push(`plan ${key}: ${l} warnAt is above 0 and at most 1`);
    }
    if (p.trialDays !== undefined && (!Number.isInteger(p.trialDays) || p.trialDays < 1 || p.trialDays > 365)) out.push(`plan ${key}: trialDays is 1 to 365`);
  }
  return out;
}

/** A plan with everything it inherits merged in, nearest plan winning. */
export function flatten(c: Catalog, name: string): { features: Record<string, FeatureSpec>; limits: Record<string, LimitSpec> } {
  const chain: Plan[] = [];
  for (let n: string | undefined = name; n; n = c.plans[n]?.extends) {
    const p = c.plans[n];
    if (!p) throw new EntitlementError(`there is no plan "${n}"`);
    if (chain.includes(p)) throw new EntitlementError(`plan ${name} extends itself`);
    chain.push(p);
  }
  const features: Record<string, FeatureSpec> = {};
  const limits: Record<string, LimitSpec> = {};
  for (const p of chain.reverse()) {
    for (const [k, v] of Object.entries(p.features ?? {})) features[k] = typeof v === 'boolean' ? { enabled: v } : v;
    for (const [k, v] of Object.entries(p.limits ?? {})) limits[k] = v;
  }
  return { features, limits };
}

// ---------------------------------------------------------------- periods

const startOfDay = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The billing period [start, end) holding `now`, with the anchor day clamped to short months. */
export function periodOf(period: Period, anchorDay: number, now: number): { start: number; end: number } {
  if (period === 'lifetime' || period === 'gauge') return { start: 0, end: Infinity };
  if (period === 'day') return { start: startOfDay(now), end: startOfDay(now) + DAY_MS };
  const d = new Date(now);
  const at = (y: number, m: number) => Date.UTC(y, m, Math.min(anchorDay, daysIn(y, m)));
  if (period === 'year') {
    // A year is the calendar year.
    return { start: Date.UTC(d.getUTCFullYear(), 0, 1), end: Date.UTC(d.getUTCFullYear() + 1, 0, 1) };
  }
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  if (now < at(y, m)) {
    m--;
    if (m < 0) {
      m = 11;
      y--;
    }
  }
  const start = at(y, m);
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  return { start, end: at(ny, nm) };
}

// ---------------------------------------------------------------- resolution

export interface Resolved {
  readonly plan: string;
  readonly features: Readonly<Record<string, FeatureView>>;
  readonly limits: Readonly<Record<string, LimitView>>;
  readonly trialing: boolean;
}

const active = (from: number, until: number | null, now: number) => from <= now && (until === null || now < until);

export function resolve(c: Catalog, a: Account, now: number): Resolved {
  if (!(Number.isInteger(a.anchorDay) && a.anchorDay >= 1 && a.anchorDay <= 31)) throw new EntitlementError('the billing day is 1 to 31');
  const base = flatten(c, a.plan);
  const trialing = !!a.trial && active(a.trial.from, a.trial.until, now);
  const trial = trialing ? flatten(c, a.trial!.plan) : null;
  const features: Record<string, FeatureView> = {};
  for (const f of c.features) {
    const p = base.features[f];
    const t = trial?.features[f];
    let view: FeatureView = p?.enabled ? { enabled: true, source: 'plan', because: `included in ${a.plan}`, ...(p.flag ? { flag: p.flag } : {}) } : { enabled: false, source: 'none', because: `not in ${a.plan}` };
    if (!view.enabled && t?.enabled) view = { enabled: true, source: 'trial', because: `included in the ${a.trial!.plan} trial until ${new Date(a.trial!.until).toISOString().slice(0, 10)}`, ...(t.flag ? { flag: t.flag } : {}) };
    if (!view.enabled && a.addonFeatures?.includes(f)) view = { enabled: true, source: 'addon', because: 'bought as an add-on' };
    const g = (a.grants ?? []).find((x) => x.feature === f && active(x.from, x.until, now));
    if (!view.enabled && g) view = { enabled: true, source: 'grant', because: `granted: ${g.reason}` };
    const o = (a.overrides ?? []).find((x) => x.feature === f && x.enabled !== undefined && active(0, x.until, now));
    if (o) view = { enabled: o.enabled!, source: 'override', because: `override: ${o.reason}`, ...(o.enabled && view.flag ? { flag: view.flag } : {}) };
    features[f] = view;
  }
  const limits: Record<string, LimitView> = {};
  for (const l of c.limits) {
    const p = base.limits[l];
    const t = trial?.limits[l];
    const spec = p ?? t;
    if (!spec) continue;
    const sources: string[] = [];
    let limit: number | null = p ? p.included : 0;
    if (p) sources.push(`${a.plan}: ${p.included === null ? 'unlimited' : p.included}`);
    // The better of plan and trial: unlimited beats any number, a larger number beats a smaller.
    const better = (x: number | null, y: number | null) => x !== y && (x === null || (y !== null && x > y));
    if (t && better(t.included, limit)) {
      limit = t.included;
      sources.push(`trial of ${a.trial!.plan}: ${t.included === null ? 'unlimited' : t.included}`);
    }
    if (limit !== null) {
      for (const ad of a.addons ?? []) if (ad.limit === l) {
        limit += ad.add;
        sources.push(`add-on: +${ad.add}`);
      }
      for (const g of a.grants ?? []) if (g.limit === l && g.add && active(g.from, g.until, now)) {
        limit += g.add;
        sources.push(`grant: +${g.add} (${g.reason})`);
      }
    }
    const o = (a.overrides ?? []).find((x) => x.limit === l && x.value !== undefined && active(0, x.until, now));
    if (o) {
      limit = o.value!;
      sources.push(`override: ${o.value === null ? 'unlimited' : o.value} (${o.reason})`);
    }
    limits[l] = { limit, period: spec.period, overage: spec.overage ?? { mode: 'block' }, warnAt: spec.warnAt ?? 0.8, sources };
  }
  return { plan: a.plan, features, limits, trialing };
}

// ---------------------------------------------------------------- usage

export interface Usage {
  readonly at: number;
  readonly units: number;
  readonly key: string;
}

export interface Decision {
  readonly allowed: boolean;
  readonly because: string;
  readonly limit: number | null;
  readonly used: number;
  readonly requested: number;
  /** Units left before the limit (null when unlimited). */
  readonly remaining: number | null;
  /** Units of the request that fall past the limit. */
  readonly overage: number;
  /** Minor units the overage would cost. */
  readonly charge: number;
  readonly warn: boolean;
}

/** Usage recorded per account and limit. A gauge holds a current value; the others add up within the period. */
export class Ledger {
  private readonly events = new Map<string, Usage[]>();
  private readonly gauges = new Map<string, number>();
  private readonly seen = new Map<string, Decision>();

  private k(account: string, limit: string) {
    return `${account}\u0000${limit}`;
  }

  used(account: string, limit: string, period: Period, anchorDay: number, now: number): number {
    if (period === 'gauge') return this.gauges.get(this.k(account, limit)) ?? 0;
    const { start, end } = periodOf(period, anchorDay, now);
    return (this.events.get(this.k(account, limit)) ?? []).reduce((n, e) => (e.at >= start && e.at < end ? n + e.units : n), 0);
  }

  setGauge(account: string, limit: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) throw new EntitlementError('a gauge is a whole number from 0');
    this.gauges.set(this.k(account, limit), value);
  }

  record(account: string, limit: string, u: Usage): void {
    const key = this.k(account, limit);
    if (!this.events.has(key)) this.events.set(key, []);
    this.events.get(key)!.push(u);
  }

  replay(account: string, key: string): Decision | undefined {
    return this.seen.get(`${account}\u0000${key}`);
  }

  remember(account: string, key: string, d: Decision): void {
    this.seen.set(`${account}\u0000${key}`, d);
  }

  /** Drops usage older than `before`, keeping memory bounded; periods older than that can no longer be reported. */
  compact(before: number): number {
    let dropped = 0;
    for (const [k, list] of this.events) {
      const keep = list.filter((e) => e.at >= before);
      dropped += list.length - keep.length;
      this.events.set(k, keep);
    }
    return dropped;
  }
}

const blocks = (units: number, o: Overage) => (o.mode === 'charge' ? Math.ceil(units / o.perUnits!) * o.price! : 0);

export class Entitlements {
  private readonly catalog: Catalog;
  readonly ledger: Ledger;
  private readonly flags: Flags | undefined;

  constructor(catalog: Catalog, ledger: Ledger = new Ledger(), flags?: Flags) {
    const problems = checkCatalog(catalog);
    if (problems.length) throw new EntitlementError(problems);
    this.catalog = catalog;
    this.ledger = ledger;
    this.flags = flags;
  }

  resolve(a: Account, now: number): Resolved {
    return resolve(this.catalog, a, now);
  }

  /** Whether a feature is on for the account, and for this person when it is behind a flag. */
  feature(a: Account, name: string, now: number, who?: Who): FeatureView {
    if (!this.catalog.features.includes(name)) throw new EntitlementError(`"${name}" is not a feature in the catalog`);
    const v = resolve(this.catalog, a, now).features[name]!;
    if (!v.enabled || !v.flag) return v;
    if (!this.flags || !who) return { ...v, enabled: false, because: `${v.because}, but it is behind the "${v.flag}" flag and nobody was named to check` };
    const e = this.flags.explain(v.flag, who);
    return e.on ? { ...v, because: `${v.because}; flag ${v.flag} is on (${e.because})` } : { ...v, enabled: false, because: `${v.because}, but flag ${v.flag} is off for this person (${e.because})` };
  }

  /** Whether `requested` more units of a limit may be used now, without recording anything. */
  check(a: Account, limit: string, requested: number, now: number): Decision {
    if (!this.catalog.limits.includes(limit)) throw new EntitlementError(`"${limit}" is not a limit in the catalog`);
    if (!Number.isInteger(requested) || requested < 0 || requested > 1e12) throw new EntitlementError('a request is a whole number of units from 0');
    const view = resolve(this.catalog, a, now).limits[limit];
    if (!view) return { allowed: false, because: `${limit} is not part of ${a.plan}`, limit: 0, used: 0, requested, remaining: 0, overage: requested, charge: 0, warn: false };
    const used = this.ledger.used(a.id, limit, view.period, a.anchorDay, now);
    if (view.limit === null) return { allowed: true, because: 'unlimited', limit: null, used, requested, remaining: null, overage: 0, charge: 0, warn: false };
    const room = Math.max(0, view.limit - used);
    const over = Math.max(0, requested - room);
    const base = { limit: view.limit, used, requested, remaining: room, overage: over };
    const warn = view.limit > 0 && (used + requested) / view.limit >= view.warnAt && over === 0;
    if (over === 0) return { ...base, allowed: true, because: `${used + requested} of ${view.limit} used`, charge: 0, warn };
    const o = view.overage;
    const already = Math.max(0, used - view.limit);
    if (o.mode === 'block') return { ...base, allowed: false, because: `that would pass the limit of ${view.limit} (${used} used, ${room} left)`, charge: 0, warn: false };
    if (o.cap !== undefined && already + over > o.cap) return { ...base, allowed: false, because: `that would pass the limit of ${view.limit} and the overage cap of ${o.cap}`, charge: 0, warn: false };
    if (o.mode === 'allow') return { ...base, allowed: true, because: `${over} over the limit of ${view.limit}, at no charge`, charge: 0, warn: true };
    // Blocks already started are paid for: only the blocks this request adds are charged.
    const before = Math.ceil(already / o.perUnits!);
    const after = Math.ceil((already + over) / o.perUnits!);
    return { ...base, allowed: true, because: `${over} over the limit of ${view.limit}; ${after - before} more block(s) at ${o.price} each`, charge: (after - before) * o.price!, warn: true };
  }

  /** Checks and, if allowed, records the usage in one step. The same key counts once, however often it is retried. */
  consume(a: Account, limit: string, units: number, key: string, now: number): Decision {
    if (!key) throw new EntitlementError('usage needs an idempotency key');
    const prior = this.ledger.replay(a.id, key);
    if (prior) return prior;
    const d = this.check(a, limit, units, now);
    if (d.allowed) {
      const view = resolve(this.catalog, a, now).limits[limit]!;
      if (view.period === 'gauge') this.ledger.setGauge(a.id, limit, d.used + units);
      else this.ledger.record(a.id, limit, { at: now, units, key });
    }
    this.ledger.remember(a.id, key, d);
    return d;
  }

  /** What this period's overage comes to, per limit, for an invoice. */
  overageLines(a: Account, now: number): { limit: string; included: number; used: number; over: number; blocks: number; amount: number }[] {
    const r = resolve(this.catalog, a, now);
    const out: { limit: string; included: number; used: number; over: number; blocks: number; amount: number }[] = [];
    for (const [l, v] of Object.entries(r.limits)) {
      if (v.limit === null || v.overage.mode !== 'charge') continue;
      const used = this.ledger.used(a.id, l, v.period, a.anchorDay, now);
      const over = Math.max(0, used - v.limit);
      if (over) out.push({ limit: l, included: v.limit, used, over, blocks: Math.ceil(over / v.overage.perUnits!), amount: blocks(over, v.overage) });
    }
    return out;
  }

  /** Starts the trial the plan offers, once per account. Returns the account with it. */
  startTrial(a: Account, plan: string, now: number): Account {
    const p = this.catalog.plans[plan];
    if (!p?.trialDays) throw new EntitlementError(`${plan} has no trial`);
    if (a.trialUsed || a.trial) throw new EntitlementError('this account has already had its trial');
    return { ...a, trial: { plan, from: now, until: now + p.trialDays * DAY_MS }, trialUsed: true };
  }

  /** What would stop working if the account moved to another plan now. */
  downgradeProblems(a: Account, to: string, now: number): string[] {
    const next = resolve(this.catalog, { ...a, plan: to }, now);
    const cur = resolve(this.catalog, a, now);
    const out: string[] = [];
    for (const [f, v] of Object.entries(cur.features)) if (v.enabled && !next.features[f]!.enabled) out.push(`${f} would be switched off`);
    for (const [l, v] of Object.entries(next.limits)) {
      if (v.limit === null) continue;
      const used = this.ledger.used(a.id, l, v.period, a.anchorDay, now);
      if (v.period === 'gauge' && used > v.limit) out.push(`${l} is ${used} but ${to} allows ${v.limit}`);
    }
    for (const [l, v] of Object.entries(cur.limits)) if (!next.limits[l] && v.period === 'gauge' && this.ledger.used(a.id, l, 'gauge', a.anchorDay, now) > 0) out.push(`${l} is in use but not part of ${to}`);
    return out;
  }

  changePlan(a: Account, to: string, now: number, force = false): Account {
    if (!this.catalog.plans[to]) throw new EntitlementError(`there is no plan "${to}"`);
    const problems = this.downgradeProblems(a, to, now);
    if (problems.length && !force) throw new EntitlementError(problems);
    return { ...a, plan: to };
  }
}
