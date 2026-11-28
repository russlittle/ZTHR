/**
 * Lifecycle hooks around create, update and delete: the layer Strapi calls lifecycles and Directus calls filter and
 * action events. Six hook points (beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete),
 * each for one collection or for all (`*`), run in a stated order, with a stated error policy and a record of what ran.
 *
 * The rules, all enforced and tested:
 *  - Order: lowest priority first (default 100), ties in the order registered; `*` hooks and collection hooks share
 *    one order, they are not run in two batches. A hook removed before its turn does not run.
 *  - Before hooks run inside the transaction, see and may change `ctx.data` (the fields about to be written; the id,
 *    the timestamps and the collection's protected fields cannot be set), see the stored record for update and delete, and may
 *    reject the operation (`ctx.reject(reason)`): nothing is written and the caller gets an OperationRejected.
 *  - The write happens after the last before hook; the stored values are the ones the hooks left.
 *  - After hooks run `after-commit` by default: the change is already saved, and a hook that fails cannot undo it, so
 *    its error is recorded and the next hook still runs. An after hook registered `in-transaction` runs before the
 *    commit, sees the written record, and if it fails everything rolls back, the before hooks' effects included.
 *  - Error policy per hook: `abort` (the operation fails and rolls back) or `isolate` (record the failure, carry on).
 *    Defaults: abort for before and in-transaction hooks, isolate for after-commit hooks. A rejection always aborts.
 *  - A hook may start further operations through `ctx.service`; they share the transaction while one is open, count
 *    toward a depth limit (default 5), and run their own hooks. `skipHooks: true` on an operation runs none.
 *    Nested operations share the transaction without savepoints: if one is caught and ignored by an isolating hook,
 *    what it wrote stays unless the whole operation later fails.
 *  - Every hook run, rejection, commit and rollback is written to the audit trail with the clock's time.
 *
 * The store is an argument (`Store`): anything that can run a function in a transaction. `MemoryStore` is one, with
 * real rollback.
 *
 * Out of scope: running hooks in parallel, bulk operations (each record is one operation), and a query language.
 */

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class OperationRejected extends LifecycleError {
  readonly hookId: string;
  readonly reason: string;
  constructor(hookId: string, reason: string) {
    super(`rejected by ${hookId}: ${reason}`);
    this.hookId = hookId;
    this.reason = reason;
  }
}
export class HookFailed extends LifecycleError {
  readonly hookId: string;
  readonly original: unknown;
  constructor(hookId: string, original: unknown) {
    super(`hook ${hookId} failed: ${original instanceof Error ? original.message : String(original)}`);
    this.hookId = hookId;
    this.original = original;
  }
}
export class DepthExceeded extends LifecycleError {}
export class NotFound extends LifecycleError {}

export type Op = 'create' | 'update' | 'delete';
export type Point = 'beforeCreate' | 'afterCreate' | 'beforeUpdate' | 'afterUpdate' | 'beforeDelete' | 'afterDelete';
export type Data = Record<string, unknown>;
export type Phase = 'in-transaction' | 'after-commit';
export type ErrorPolicy = 'abort' | 'isolate';

export interface PointInfo {
  readonly point: Point;
  readonly op: Op;
  readonly runs: string;
  readonly canChangeData: boolean;
  readonly canReject: boolean;
  readonly sees: string;
}

/** What each hook point is, for the plugin author. */
export const POINTS: readonly PointInfo[] = [
  { point: 'beforeCreate', op: 'create', runs: 'inside the transaction, before the write', canChangeData: true, canReject: true, sees: 'data about to be stored' },
  { point: 'afterCreate', op: 'create', runs: 'after the write; after the commit unless registered in-transaction', canChangeData: false, canReject: false, sees: 'the stored record' },
  { point: 'beforeUpdate', op: 'update', runs: 'inside the transaction, before the write', canChangeData: true, canReject: true, sees: 'the stored record and the patch' },
  { point: 'afterUpdate', op: 'update', runs: 'after the write; after the commit unless registered in-transaction', canChangeData: false, canReject: false, sees: 'the record before and after' },
  { point: 'beforeDelete', op: 'delete', runs: 'inside the transaction, before the removal', canChangeData: false, canReject: true, sees: 'the stored record' },
  { point: 'afterDelete', op: 'delete', runs: 'after the removal; after the commit unless registered in-transaction', canChangeData: false, canReject: false, sees: 'the record as it was' },
];

export interface Record_ extends Data {
  id: string;
}

/** What a hook sees and can do. */
export interface HookContext {
  readonly point: Point;
  readonly op: Op;
  readonly collection: string;
  readonly id: string | undefined;
  /** Before create and update: the fields to be written. Change them freely (not the id or protected fields). After: a copy of what was written. */
  data: Data;
  /** The stored record before the operation (update and delete); undefined for create. */
  readonly before: Readonly<Data> | undefined;
  /** The stored record after the operation (create and update, after hooks). */
  readonly after: Readonly<Data> | undefined;
  readonly actor: string | undefined;
  readonly depth: number;
  readonly phase: Phase | 'before';
  /** Stop the operation: nothing is written. Only before hooks may call it. */
  reject(reason: string): never;
  /** Start further operations from inside a hook. */
  readonly service: Service;
}

export type Handler = (ctx: HookContext) => void | Promise<void>;

export interface HookOptions {
  readonly id?: string;
  readonly priority?: number;
  readonly owner?: string;
  readonly phase?: Phase;
  readonly onError?: ErrorPolicy;
}

export interface OperationOptions {
  readonly actor?: string;
  readonly skipHooks?: boolean;
}

export interface Service {
  create(collection: string, data: Data, options?: OperationOptions): Promise<Data>;
  update(collection: string, id: string, patch: Data, options?: OperationOptions): Promise<Data>;
  delete(collection: string, id: string, options?: OperationOptions): Promise<Data>;
}

export interface AuditEntry {
  readonly seq: number;
  readonly at: number;
  readonly opId: number;
  readonly op: Op;
  readonly collection: string;
  readonly recordId: string | undefined;
  readonly kind: 'hook' | 'committed' | 'rolled-back';
  readonly point?: Point;
  readonly hookId?: string;
  readonly owner?: string;
  readonly outcome: 'ok' | 'error' | 'rejected' | 'ok-after-failure';
  readonly message?: string;
  readonly durationMs?: number;
  /** For a before hook: the fields it changed in `data`. */
  readonly changed?: readonly string[];
  readonly actor?: string;
}

// ------------------------------------------------------------------------------------------------ store

export interface Tx {
  get(collection: string, id: string): Promise<Data | undefined>;
  insert(collection: string, record: Data): Promise<void>;
  replace(collection: string, id: string, record: Data): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
}
export interface Store {
  /** Run fn; commit when it resolves, roll back when it throws. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** A store in memory with real rollback: a transaction works on a copy that replaces the data only on success. */
export class MemoryStore implements Store {
  private data = new Map<string, Map<string, Data>>();
  private open = false;

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.open) throw new LifecycleError('a transaction is already open; nested operations must use the one they were given');
    this.open = true;
    const work = new Map([...this.data].map(([c, m]) => [c, new Map([...m].map(([k, v]) => [k, structuredClone(v)]))]));
    const table = (c: string) => work.get(c) ?? work.set(c, new Map()).get(c)!;
    const tx: Tx = {
      get: async (c, id) => {
        const r = table(c).get(id);
        return r === undefined ? undefined : structuredClone(r);
      },
      insert: async (c, r) => {
        const id = r['id'] as string;
        if (table(c).has(id)) throw new LifecycleError(`${c}/${id} already exists`);
        table(c).set(id, structuredClone(r));
      },
      replace: async (c, id, r) => {
        if (!table(c).has(id)) throw new NotFound(`${c}/${id} does not exist`);
        table(c).set(id, structuredClone(r));
      },
      remove: async (c, id) => {
        if (!table(c).delete(id)) throw new NotFound(`${c}/${id} does not exist`);
      },
    };
    try {
      const out = await fn(tx);
      this.data = work;
      return out;
    } finally {
      this.open = false;
    }
  }

  /** Read outside a transaction (for tests and callers). */
  get(collection: string, id: string): Data | undefined {
    const r = this.data.get(collection)?.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }
  count(collection: string): number {
    return this.data.get(collection)?.size ?? 0;
  }
}

// ------------------------------------------------------------------------------------------------ runner

interface Registered {
  readonly id: string;
  readonly point: Point;
  readonly collection: string;
  readonly handler: Handler;
  readonly priority: number;
  readonly order: number;
  readonly owner: string | undefined;
  readonly phase: Phase;
  readonly onError: ErrorPolicy;
  removed: boolean;
}

export interface LifecycleOptions {
  readonly store: Store;
  readonly now: () => number;
  /** Makes the id of a created record. */
  readonly newId: () => string;
  readonly maxDepth?: number;
  /** Fields hooks and callers may not set in `data`: always `id`, `createdAt` and `updatedAt`, which the runner owns. */
  readonly protectedFields?: readonly string[];
  /** Called with every audit entry as it is written. */
  readonly onAudit?: (e: AuditEntry) => void;
}

const POINT_SET = new Set<string>(POINTS.map((p) => p.point));

interface Scope {
  readonly tx: Tx;
  /** After-commit work, drained by the outermost operation once the transaction has committed. */
  readonly queue: (() => Promise<void>)[];
}

class RejectSignal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Lifecycle {
  private readonly hooks: Registered[] = [];
  private readonly log: AuditEntry[] = [];
  private order = 0;
  private opSeq = 0;
  private auto = 0;
  private readonly o: Required<Omit<LifecycleOptions, 'onAudit'>> & { onAudit: ((e: AuditEntry) => void) | undefined };

  constructor(options: LifecycleOptions) {
    this.o = {
      store: options.store,
      now: options.now,
      newId: options.newId,
      maxDepth: options.maxDepth ?? 5,
      protectedFields: [...new Set(['id', 'createdAt', 'updatedAt', ...(options.protectedFields ?? [])])],
      onAudit: options.onAudit,
    };
  }

  /** Register a hook; returns its id. `collection` may be `*`. */
  on(point: Point, collection: string, handler: Handler, options: HookOptions = {}): string {
    if (!POINT_SET.has(point)) throw new LifecycleError(`unknown hook point "${String(point)}"; use one of ${[...POINT_SET].join(', ')}`);
    if (typeof collection !== 'string' || collection === '') throw new LifecycleError('a hook needs a collection name or "*"');
    const isBefore = point.startsWith('before');
    if (isBefore && options.phase !== undefined) throw new LifecycleError('a before hook always runs inside the transaction; phase is for after hooks');
    const phase: Phase = options.phase ?? 'after-commit';
    if (phase !== 'in-transaction' && phase !== 'after-commit') throw new LifecycleError(`unknown phase "${String(phase)}"`);
    const id = options.id ?? `hook-${++this.auto}`;
    if (this.hooks.some((h) => h.id === id && !h.removed)) throw new LifecycleError(`a hook with id "${id}" is already registered`);
    if (!isBefore && phase === 'after-commit' && options.onError === 'abort') {
      throw new LifecycleError('an after-commit hook cannot abort: the change is already saved; register it in-transaction to roll back on failure');
    }
    const onError: ErrorPolicy = options.onError ?? (!isBefore && phase === 'after-commit' ? 'isolate' : 'abort');
    this.hooks.push({ id, point, collection, handler, priority: options.priority ?? 100, order: this.order++, owner: options.owner, phase, onError, removed: false });
    return id;
  }

  /** Remove one hook by id. */
  off(id: string): boolean {
    const h = this.hooks.find((x) => x.id === id && !x.removed);
    if (h) h.removed = true;
    return h !== undefined;
  }

  /** Remove every hook an owner registered (unloading a plugin). Returns how many. */
  offOwner(owner: string): number {
    let n = 0;
    for (const h of this.hooks) {
      if (h.owner === owner && !h.removed) {
        h.removed = true;
        n++;
      }
    }
    return n;
  }

  /** The hooks that would run for a point and collection, in order. */
  plan(point: Point, collection: string, phase?: Phase): { id: string; priority: number; owner: string | undefined; phase: Phase }[] {
    return this.matching(point, collection, phase).map((h) => ({ id: h.id, priority: h.priority, owner: h.owner, phase: h.phase }));
  }

  get audit(): readonly AuditEntry[] {
    return this.log;
  }

  private matching(point: Point, collection: string, phase?: Phase): Registered[] {
    return this.hooks
      .filter((h) => !h.removed && h.point === point && (h.collection === '*' || h.collection === collection) && (phase === undefined || h.phase === phase))
      .sort((a, b) => a.priority - b.priority || a.order - b.order);
  }

  private write(e: Omit<AuditEntry, 'seq' | 'at'>): void {
    const entry: AuditEntry = { seq: this.log.length + 1, at: this.o.now(), ...e };
    this.log.push(entry);
    this.o.onAudit?.(entry);
  }

  /** The service callers use. */
  readonly service: Service = {
    create: (c, d, o) => this.run('create', c, undefined, d, o ?? {}, 0, undefined),
    update: (c, id, p, o) => this.run('update', c, id, p, o ?? {}, 0, undefined),
    delete: (c, id, o) => this.run('delete', c, id, {}, o ?? {}, 0, undefined),
  };

  private serviceFor(scope: Scope | undefined, depth: number): Service {
    return {
      create: (c, d, o) => this.run('create', c, undefined, d, o ?? {}, depth + 1, scope),
      update: (c, id, p, o) => this.run('update', c, id, p, o ?? {}, depth + 1, scope),
      delete: (c, id, o) => this.run('delete', c, id, {}, o ?? {}, depth + 1, scope),
    };
  }

  private async run(op: Op, collection: string, id0: string | undefined, input: Data, options: OperationOptions, depth: number, outer: Scope | undefined): Promise<Data> {
    if (depth > this.o.maxDepth) throw new DepthExceeded(`hooks started operations more than ${this.o.maxDepth} levels deep`);
    if (typeof collection !== 'string' || collection === '' || collection === '*') throw new LifecycleError('an operation needs a real collection name');
    if (op !== 'delete') {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new LifecycleError('data must be an object');
      const bad = this.o.protectedFields.find((f) => f in input);
      if (bad !== undefined) throw new LifecycleError(`"${bad}" is set by the system and cannot be given in data`);
    }
    const opId = ++this.opSeq;
    const skip = options.skipHooks === true;
    const actor = options.actor === undefined ? {} : { actor: options.actor };
    const queue: (() => Promise<void>)[] = outer ? outer.queue : [];

    const body = async (tx: Tx): Promise<Data> => {
      const scope: Scope = { tx, queue };
      let recordId = id0;
      let stored: Data | undefined;
      if (op !== 'create') {
        stored = await tx.get(collection, id0 as string);
        if (stored === undefined) throw new NotFound(`${collection}/${id0} does not exist`);
      }
      let data: Data = op === 'delete' ? {} : structuredClone(input);
      const note = (h: Registered, point: Point, outcome: AuditEntry['outcome'], t0: number, extra: { message?: string; changed?: string[] } = {}) =>
        this.write({ opId, op, collection, recordId, kind: 'hook', point, hookId: h.id, ...(h.owner ? { owner: h.owner } : {}), outcome, durationMs: this.o.now() - t0, ...extra, ...actor });

      const runBefore = async (point: Point): Promise<void> => {
        if (skip) return;
        for (const h of this.matching(point, collection)) {
          if (h.removed) continue;
          const snapshot = structuredClone(data);
          const t0 = this.o.now();
          const ctx: HookContext = {
            point, op, collection, id: recordId,
            get data() { return data; },
            set data(v: Data) { data = v; },
            before: stored === undefined ? undefined : structuredClone(stored),
            after: undefined, actor: options.actor, depth, phase: 'before',
            reject(reason: string): never { throw new RejectSignal(reason); },
            service: this.serviceFor(scope, depth),
          };
          try {
            await h.handler(ctx);
            const changed = Object.keys({ ...snapshot, ...data }).filter((k) => !same(snapshot[k], data[k])).sort();
            const bad = this.o.protectedFields.find((f) => f in data);
            if (bad !== undefined) {
              data = snapshot;
              throw new LifecycleError(`hook ${h.id} tried to set protected field "${bad}"`);
            }
            note(h, point, 'ok', t0, { changed });
          } catch (err) {
            if (err instanceof RejectSignal) {
              note(h, point, 'rejected', t0, { message: err.reason });
              throw new OperationRejected(h.id, err.reason);
            }
            const message = err instanceof Error ? err.message : String(err);
            if (h.onError === 'abort') {
              note(h, point, 'error', t0, { message });
              throw err instanceof OperationRejected || err instanceof DepthExceeded ? err : new HookFailed(h.id, err);
            }
            note(h, point, 'ok-after-failure', t0, { message });
            data = snapshot;
          }
        }
      };

      const runAfterInTx = async (point: Point, written: Data | undefined): Promise<void> => {
        if (skip) return;
        for (const h of this.matching(point, collection, 'in-transaction')) {
          if (h.removed) continue;
          const t0 = this.o.now();
          const ctx: HookContext = {
            point, op, collection, id: recordId, data: structuredClone(data),
            before: stored === undefined ? undefined : structuredClone(stored),
            after: written === undefined ? undefined : structuredClone(written),
            actor: options.actor, depth, phase: 'in-transaction',
            reject(): never { throw new LifecycleError('an after hook cannot reject; a before hook can'); },
            service: this.serviceFor(scope, depth),
          };
          try {
            await h.handler(ctx);
            note(h, point, 'ok', t0);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (h.onError === 'abort') {
              note(h, point, 'error', t0, { message });
              throw new HookFailed(h.id, err);
            }
            note(h, point, 'ok-after-failure', t0, { message });
          }
        }
      };

      const beforePoint: Point = op === 'create' ? 'beforeCreate' : op === 'update' ? 'beforeUpdate' : 'beforeDelete';
      const afterPoint: Point = op === 'create' ? 'afterCreate' : op === 'update' ? 'afterUpdate' : 'afterDelete';
      await runBefore(beforePoint);

      const now = this.o.now();
      let result: Data;
      if (op === 'create') {
        recordId = this.o.newId();
        result = { ...data, id: recordId, createdAt: now, updatedAt: now };
        await tx.insert(collection, result);
      } else if (op === 'update') {
        result = { ...(stored as Data), ...data, id: id0 as string, updatedAt: now };
        await tx.replace(collection, id0 as string, result);
      } else {
        result = stored as Data;
        await tx.remove(collection, id0 as string);
      }
      const written = op === 'delete' ? undefined : result;
      await runAfterInTx(afterPoint, written);

      if (!skip) {
        const later = this.matching(afterPoint, collection, 'after-commit');
        const finalData = structuredClone(data);
        const idLater = recordId;
        if (later.length > 0) {
          queue.push(async () => {
            for (const h of later) {
              if (h.removed) continue;
              const t0 = this.o.now();
              const ctx: HookContext = {
                point: afterPoint, op, collection, id: idLater, data: structuredClone(finalData),
                before: stored === undefined ? undefined : structuredClone(stored),
                after: written === undefined ? undefined : structuredClone(written),
                actor: options.actor, depth, phase: 'after-commit',
                reject(): never { throw new LifecycleError('an after hook cannot reject: the change is already saved'); },
                service: this.serviceFor(undefined, depth),
              };
              const rec = (outcome: AuditEntry['outcome'], message?: string) =>
                this.write({ opId, op, collection, recordId: idLater, kind: 'hook', point: afterPoint, hookId: h.id, ...(h.owner ? { owner: h.owner } : {}), outcome, durationMs: this.o.now() - t0, ...(message === undefined ? {} : { message }), ...actor });
              try {
                await h.handler(ctx);
                rec('ok');
              } catch (err) {
                rec('ok-after-failure', err instanceof Error ? err.message : String(err));
              }
            }
          });
        }
      }
      return result;
    };

    let result: Data;
    try {
      result = outer ? await body(outer.tx) : await this.o.store.transaction(body);
    } catch (err) {
      if (!outer) {
        this.write({ opId, op, collection, recordId: id0, kind: 'rolled-back', outcome: 'error', message: err instanceof Error ? err.message : String(err), ...actor });
      }
      throw err;
    }
    if (!outer) {
      this.write({ opId, op, collection, recordId: result['id'] as string, kind: 'committed', outcome: 'ok', ...actor });
      for (const f of queue) await f();
    }
    return result;
  }
}
