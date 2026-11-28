/**
 * Multi-tenant isolation helpers, so one customer's data and load never reach another's. Holds: tenant ids that
 * are checked once and cannot be forged into keys (tenantKey escapes every part, so "a:b" + "c" never collides
 * with "a" + "b:c"); a tenant context carried through async work (AsyncLocalStorage), with no default tenant and
 * an error when there is none; per-tenant derived keys (HKDF-SHA-256) so one tenant's encryption or signing key
 * is useless for another; a scoped store whose every read, list, update and delete is confined to the current
 * tenant, answers "not found" for another tenant's id (no existence leak), stamps the tenant on insert, refuses
 * to move a record between tenants, and double-checks what its backing store returns; query scoping for SQL
 * parameters and filter objects; membership and role checks that use the rbac block's evaluator, with the record's
 * tenant checked first; per-plan quotas with reservation; request rate limits per tenant; and noisy-neighbour
 * guards: a concurrency limit that tightens to a fair share when the system is busy, and a report of who is using
 * too large a share. The clock is an argument. It does not run a database; it is the layer in front of one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { hkdfSync } from 'node:crypto';
import { decide, type Policy, type Rec } from '../rbac/index.ts';

export class TenantError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class NoTenant extends TenantError {
  constructor() {
    super('no tenant is set for this work: wrap it in withTenant, or pass the tenant explicitly');
  }
}
export class CrossTenant extends TenantError {}
export class QuotaExceeded extends TenantError {
  readonly resource: string;
  readonly limit: number;
  readonly used: number;
  constructor(resource: string, limit: number, used: number, wanted: number) {
    super(`${resource}: the plan allows ${limit}, ${used} are used, and ${wanted} more were asked for`);
    this.resource = resource;
    this.limit = limit;
    this.used = used;
  }
}
export class TooBusy extends TenantError {
  readonly retryAfterMs: number;
  constructor(why: string, retryAfterMs = 0) {
    super(why);
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------- ids, context, keys

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A tenant id: lower-case letters, digits and hyphens, 2 to 63 long, starting with a letter or digit. */
export function tenantId(v: string): string {
  if (typeof v !== 'string' || !TENANT_ID.test(v) || v.includes('--')) throw new TenantError(`"${String(v).slice(0, 40)}" is not a tenant id (2-63 of a-z, 0-9 and single hyphens)`);
  return v;
}

export interface TenantContext {
  readonly tenant: string;
  readonly actor?: string;
  readonly plan?: string;
}

const als = new AsyncLocalStorage<TenantContext>();

/** Runs work (including its awaits) as one tenant. Contexts nest; the innermost wins and the outer is restored after. */
export function withTenant<T>(ctx: TenantContext, fn: () => T): T {
  return als.run({ ...ctx, tenant: tenantId(ctx.tenant) }, fn);
}

/** The tenant of the running work; an error when there is none, never a default. */
export function currentTenant(): TenantContext {
  const c = als.getStore();
  if (!c) throw new NoTenant();
  return c;
}

const part = (p: string): string => p.replace(/[%:]/g, (c) => (c === '%' ? '%25' : '%3A'));
const unpart = (p: string): string => p.replace(/%3A/g, ':').replace(/%25/g, '%');

/** "t:<tenant>:<part>:<part>" for caches, object stores and queues; parts cannot forge another tenant's prefix. */
export function tenantKey(tenant: string, ...parts: readonly string[]): string {
  return ['t', tenantId(tenant), ...parts.map(part)].join(':');
}

/** The tenant and parts of a key made by tenantKey; null when it is not one. */
export function parseTenantKey(key: string): { tenant: string; parts: string[] } | null {
  const p = key.split(':');
  if (p[0] !== 't' || p.length < 2 || !TENANT_ID.test(p[1]!)) return null;
  return { tenant: p[1]!, parts: p.slice(2).map(unpart) };
}

/** Whether a key belongs to the tenant, for a sweep over a shared store. */
export const keyBelongsTo = (key: string, tenant: string): boolean => parseTenantKey(key)?.tenant === tenant;

/** A 32-byte key for one tenant and purpose, derived from a master secret with HKDF-SHA-256. */
export function tenantSecret(master: Buffer | string, tenant: string, purpose: string): Buffer {
  const m = typeof master === 'string' ? Buffer.from(master) : master;
  if (m.length < 16) throw new TenantError('the master secret must be at least 16 bytes');
  return Buffer.from(hkdfSync('sha256', m, Buffer.from(`tenant:${tenantId(tenant)}`), Buffer.from(`purpose:${purpose}`), 32));
}

// ---------------------------------------------------------------- scoped queries

/** A SQL fragment and its parameters confining a query to a tenant: `tenant_id = $3`. Column names are checked. */
export function scopeSql(column: string, tenant: string, firstParam = 1): { sql: string; params: [string] } {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) throw new TenantError(`"${column}" is not a column name`);
  if (!Number.isInteger(firstParam) || firstParam < 1) throw new TenantError('parameters are numbered from 1');
  return { sql: `${column} = $${firstParam}`, params: [tenantId(tenant)] };
}

/** A filter object with the tenant added; a filter that names another tenant, or an $or that could escape, is refused. */
export function scopeFilter(tenant: string, filter: Readonly<Record<string, unknown>> = {}, field = 'tenant'): Record<string, unknown> {
  tenantId(tenant);
  if (Object.hasOwn(filter, field) && filter[field] !== tenant) throw new CrossTenant(`the filter asks for ${field} ${JSON.stringify(filter[field])} inside tenant ${tenant}`);
  for (const k of Object.keys(filter)) if (k.startsWith('$') && k !== '$and') throw new CrossTenant(`the filter operator ${k} could reach outside the tenant`);
  return { ...filter, [field]: tenant };
}

export interface Backing<T> {
  /** All rows; the scoped store filters and verifies. A real store passes the tenant down and this stays a check. */
  all(tenant: string): Iterable<T>;
  put(row: T): void;
  remove(id: string): void;
}

export interface Row {
  readonly id: string;
  readonly tenant: string;
}

/** A trivial in-memory backing store, also the reference for the interface. */
export class MemoryBacking<T extends Row> implements Backing<T> {
  readonly rows = new Map<string, T>();
  all(tenant: string): Iterable<T> {
    return [...this.rows.values()].filter((r) => r.tenant === tenant);
  }
  put(row: T): void {
    this.rows.set(row.id, row);
  }
  remove(id: string): void {
    this.rows.delete(id);
  }
}

/** Throws when any row is not the tenant's: the last line of defence behind a query that was scoped wrongly. */
export function assertScoped<T extends { tenant: string }>(rows: readonly T[], tenant: string): readonly T[] {
  const bad = rows.find((r) => r.tenant !== tenant);
  if (bad) throw new CrossTenant(`a row of tenant ${bad.tenant} was returned inside tenant ${tenant}`);
  return rows;
}

/**
 * Records confined to one tenant. The tenant comes from the running context (or `forTenant`), never from the
 * caller's data: an insert with another tenant's name is refused, ids are unique within the tenant only (two
 * tenants may both have an "inv-1"), and another tenant's record is simply not found.
 */
export class ScopedStore<T extends Row> {
  private readonly backing: Backing<T>;
  /** A tenant's ids are kept per tenant so equal ids in two tenants never meet. */
  private readonly index = new Map<string, Map<string, T>>();
  constructor(backing: Backing<T> = new MemoryBacking<T>() as unknown as Backing<T>) {
    this.backing = backing;
  }

  private mine(tenant: string): Map<string, T> {
    let m = this.index.get(tenant);
    if (!m) {
      m = new Map();
      for (const r of assertScoped([...this.backing.all(tenant)], tenant)) m.set(r.id, r);
      this.index.set(tenant, m);
    }
    return m;
  }

  /** A view of the store for an explicit tenant, for jobs and admin tools that run without a request context. */
  forTenant(tenant: string): TenantView<T> {
    return new TenantView(this, tenantId(tenant));
  }

  /** The view for the tenant of the running work. */
  get current(): TenantView<T> {
    return new TenantView(this, currentTenant().tenant);
  }

  /** @internal */
  _mine(tenant: string): Map<string, T> {
    return this.mine(tenant);
  }
  /** @internal */
  _backing(): Backing<T> {
    return this.backing;
  }
}

export class TenantView<T extends Row> {
  readonly tenant: string;
  private readonly store: ScopedStore<T>;
  constructor(store: ScopedStore<T>, tenant: string) {
    this.store = store;
    this.tenant = tenant;
  }
  private m(): Map<string, T> {
    return this.store._mine(this.tenant);
  }
  /** Adds a record; its tenant field is set here. A record that already names another tenant is refused. */
  insert(row: Omit<T, 'tenant'> & { tenant?: string }): T {
    if (row.tenant !== undefined && row.tenant !== this.tenant) throw new CrossTenant(`a record of tenant ${row.tenant} cannot be added inside tenant ${this.tenant}`);
    const full = { ...row, tenant: this.tenant } as T;
    if (this.m().has(full.id)) throw new TenantError(`${full.id} already exists`);
    this.m().set(full.id, full);
    this.store._backing().put(full);
    return full;
  }
  get(id: string): T | undefined {
    return this.m().get(id);
  }
  list(where: (r: T) => boolean = () => true): T[] {
    return assertScoped([...this.m().values()].filter(where), this.tenant) as T[];
  }
  /** Changes a record; the tenant cannot be changed, and nothing is changed when the id is another tenant's. */
  update(id: string, patch: Partial<Omit<T, 'id' | 'tenant'>> & { tenant?: string; id?: string }): T | undefined {
    const cur = this.m().get(id);
    if (!cur) return undefined;
    if (patch.tenant !== undefined && patch.tenant !== this.tenant) throw new CrossTenant('a record cannot be moved to another tenant');
    if (patch.id !== undefined && patch.id !== id) throw new TenantError('a record cannot change its id');
    const next = { ...cur, ...patch, id, tenant: this.tenant } as T;
    this.m().set(id, next);
    this.store._backing().put(next);
    return next;
  }
  delete(id: string): boolean {
    if (!this.m().delete(id)) return false;
    this.store._backing().remove(id);
    return true;
  }
  count(): number {
    return this.m().size;
  }
}

// ---------------------------------------------------------------- membership and access

/** Who belongs to which tenant, in which roles. A person may belong to several tenants with different roles. */
export class Memberships {
  private readonly m = new Map<string, Map<string, { roles: readonly string[]; attrs?: Readonly<Record<string, string | readonly string[]>> }>>();

  add(user: string, tenant: string, roles: readonly string[], attrs?: Readonly<Record<string, string | readonly string[]>>): void {
    tenantId(tenant);
    const t = this.m.get(tenant) ?? new Map();
    t.set(user, { roles: [...roles], ...(attrs ? { attrs } : {}) });
    this.m.set(tenant, t);
  }
  remove(user: string, tenant: string): boolean {
    return this.m.get(tenant)?.delete(user) ?? false;
  }
  tenantsOf(user: string): string[] {
    return [...this.m].filter(([, t]) => t.has(user)).map(([id]) => id).sort();
  }
  get(user: string, tenant: string) {
    return this.m.get(tenant)?.get(user);
  }
  /** The tenant to use for a request: the one asked for, only when the person belongs to it. */
  choose(user: string, wanted: string): string {
    if (!this.get(user, tenantId(wanted))) throw new CrossTenant(`${user} does not belong to tenant ${wanted}`);
    return wanted;
  }
}

/**
 * Whether a person may do an action on a record in a tenant: they must belong to the tenant, the record must be
 * the tenant's, and then the rbac policy decides with the roles they hold in that tenant only.
 */
export function can(policy: Policy, members: Memberships, user: string, tenant: string, action: string, kind: string, record: Rec = {}): { allowed: boolean; because: string } {
  const m = members.get(user, tenantId(tenant));
  if (!m) return { allowed: false, because: `${user} does not belong to tenant ${tenant}` };
  if (typeof record.tenant === 'string' && record.tenant !== tenant) return { allowed: false, because: `the record belongs to another tenant` };
  const d = decide(policy, { id: user, roles: m.roles, ...(m.attrs ? { attrs: m.attrs } : {}) }, action, kind, record);
  return { allowed: d.allowed, because: d.because };
}

// ---------------------------------------------------------------- quotas and limits

export interface Plan {
  readonly name: string;
  /** What each resource is capped at; a resource not listed is not allowed at all. */
  readonly limits: Readonly<Record<string, number>>;
  /** Requests per minute, and the burst. */
  readonly rate?: { readonly perMinute: number; readonly burst?: number };
  /** Requests in flight at once. */
  readonly concurrency?: number;
}

export class Quotas {
  private readonly plans: ReadonlyMap<string, Plan>;
  private readonly used = new Map<string, Map<string, number>>();
  private readonly planOf = new Map<string, string>();
  constructor(plans: readonly Plan[]) {
    this.plans = new Map(plans.map((p) => [p.name, p]));
  }
  assign(tenant: string, plan: string): void {
    if (!this.plans.has(plan)) throw new TenantError(`there is no plan named "${plan}"`);
    this.planOf.set(tenantId(tenant), plan);
  }
  plan(tenant: string): Plan {
    const p = this.plans.get(this.planOf.get(tenant) ?? '');
    if (!p) throw new TenantError(`tenant ${tenant} has no plan`);
    return p;
  }
  usage(tenant: string, resource: string): number {
    return this.used.get(tenant)?.get(resource) ?? 0;
  }
  /** Takes `n` of a resource, or refuses with how much is left; nothing is taken on refusal. */
  reserve(tenant: string, resource: string, n = 1): void {
    if (!Number.isInteger(n) || n < 1) throw new TenantError('reserve whole units, at least 1');
    const limit = Object.hasOwn(this.plan(tenant).limits, resource) ? this.plan(tenant).limits[resource]! : 0;
    const u = this.usage(tenant, resource);
    if (u + n > limit) throw new QuotaExceeded(resource, limit, u, n);
    const t = this.used.get(tenant) ?? new Map<string, number>();
    t.set(resource, u + n);
    this.used.set(tenant, t);
  }
  release(tenant: string, resource: string, n = 1): void {
    const t = this.used.get(tenant);
    if (t) t.set(resource, Math.max(0, (t.get(resource) ?? 0) - n));
  }
  /** Every resource with what is used, the limit, and the share, for a settings page and for upgrade nudges. */
  report(tenant: string): { resource: string; used: number; limit: number; share: number }[] {
    return Object.entries(this.plan(tenant).limits).map(([resource, limit]) => ({ resource, used: this.usage(tenant, resource), limit, share: limit ? this.usage(tenant, resource) / limit : 1 }));
  }
}

/** Token buckets per tenant, sized by plan, so one tenant's burst is its own to wait out. */
export class TenantRate {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly quotas: Quotas;
  private readonly now: () => number;
  constructor(quotas: Quotas, now: () => number) {
    this.quotas = quotas;
    this.now = now;
  }
  /** Takes a token or throws TooBusy saying how long to wait. */
  take(tenant: string): void {
    const rate = this.quotas.plan(tenant).rate;
    if (!rate) return;
    const cap = rate.burst ?? rate.perMinute;
    const perMs = rate.perMinute / 60_000;
    const t = this.now();
    const b = this.buckets.get(tenant) ?? { tokens: cap, at: t };
    b.tokens = Math.min(cap, b.tokens + (t - b.at) * perMs);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(tenant, b);
      throw new TooBusy(`tenant ${tenant} is over its request rate`, Math.ceil((1 - b.tokens) / perMs));
    }
    b.tokens -= 1;
    this.buckets.set(tenant, b);
  }
}

// ---------------------------------------------------------------- noisy neighbours

/**
 * Concurrency shared fairly. Each tenant has its plan's cap; the system has a total. While the system is under
 * `contended` (a fraction of the total), a tenant may use up to its cap; above it, a tenant may hold only an equal
 * share of the total among the tenants now active, so a heavy tenant cannot starve the rest when it matters.
 */
export class FairShare {
  private readonly inflight = new Map<string, number>();
  private total = 0;
  private readonly capacity: number;
  private readonly cap: (tenant: string) => number;
  private readonly contended: number;
  constructor(capacity: number, cap: (tenant: string) => number, contended = 0.75) {
    if (capacity < 1) throw new TenantError('capacity must be at least 1');
    this.capacity = capacity;
    this.cap = cap;
    this.contended = contended;
  }
  /** Takes a slot and returns the function that gives it back (safe to call twice), or throws TooBusy. */
  acquire(tenant: string): () => void {
    const mine = this.inflight.get(tenant) ?? 0;
    if (this.total >= this.capacity) throw new TooBusy('the system is at capacity', 1000);
    if (mine >= this.cap(tenant)) throw new TooBusy(`tenant ${tenant} is at its limit of ${this.cap(tenant)} at once`, 1000);
    if (this.total >= this.capacity * this.contended) {
      const active = this.inflight.size + (mine === 0 ? 1 : 0);
      const fair = Math.max(1, Math.floor(this.capacity / active));
      if (mine >= fair) throw new TooBusy(`the system is busy and tenant ${tenant} already has its fair share of ${fair}`, 1000);
    }
    this.inflight.set(tenant, mine + 1);
    this.total++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.inflight.get(tenant) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(tenant);
      else this.inflight.set(tenant, n);
      this.total--;
    };
  }
  /** Slots in use, in total and by tenant. */
  load(): { total: number; byTenant: Record<string, number> } {
    return { total: this.total, byTenant: Object.fromEntries(this.inflight) };
  }
}

/** Usage by tenant over a sliding window, and who is using too large a share of it. */
export class UsageWindow {
  private readonly events: { at: number; tenant: string; cost: number }[] = [];
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(windowMs: number, now: () => number) {
    this.windowMs = windowMs;
    this.now = now;
  }
  record(tenant: string, cost = 1): void {
    this.events.push({ at: this.now(), tenant: tenantId(tenant), cost });
    this.trim();
  }
  private trim(): void {
    const cut = this.now() - this.windowMs;
    let i = 0;
    while (i < this.events.length && this.events[i]!.at <= cut) i++;
    if (i) this.events.splice(0, i);
  }
  /** Tenants over `maxShare` of all usage, when at least `minTenants` are active (one busy tenant alone is not noisy). */
  noisy(maxShare = 0.5, minTenants = 3): { tenant: string; share: number; cost: number }[] {
    this.trim();
    const by = new Map<string, number>();
    let total = 0;
    for (const e of this.events) {
      by.set(e.tenant, (by.get(e.tenant) ?? 0) + e.cost);
      total += e.cost;
    }
    if (by.size < minTenants || total === 0) return [];
    return [...by].map(([tenant, cost]) => ({ tenant, cost, share: cost / total })).filter((x) => x.share > maxShare).sort((a, b) => b.share - a.share);
  }
}
