/**
 * Settings that change while the system runs: the title of a site, a feature's limit, a user's preferred language.
 * (The config block holds what a service needs to start; this holds what people and administrators change later.)
 *
 * - Declared once: every option has a key, a type (string, number, integer, boolean, enum or JSON), a default that
 *   is itself checked, limits, the scope kinds it may be set at, and whether it is a secret. Unknown keys and values
 *   that do not fit are refused with a message saying which and why; JSON values are copied so nobody can change a
 *   stored value by holding on to it.
 * - Scopes: a value lives at a scope such as `site`, `tenant:acme` or `user:42`. Reading takes the scopes a request
 *   is in, most specific first, and answers with the first scope that has a value, else the default, and says where
 *   it came from.
 * - Autoload: options marked autoload are read from the backend in one call per scope with `preload`, and are then
 *   read synchronously, the way a page render needs; other options are read on demand through the cache block
 *   (one load per key however many readers ask, dropped when the option changes).
 * - Writes: `set` and `reset` are versioned; `update` reads, changes and writes back, retrying when somebody else
 *   wrote in between, so two administrators never lose each other's change. A stale `expectedVersion` is refused.
 * - Events: after a write has committed, listeners to the key (or to everything) get the old and new value, scope,
 *   version, time and who did it. Secrets are shown as [redacted]. A listener that fails is recorded and never
 *   undoes or blocks the write.
 *
 * The cache is per process: another process's write is seen when the entry's time is up (`ttlMs`), or at once if the
 * backend or the caller signals it with `forget`. Not here: storage (a backend is an interface, with a memory one),
 * encryption of secrets at rest, and permissions on who may change what (the caller checks that, then names `by`).
 */
import { Cache } from '../cache/index.ts';

export class UnknownOption extends Error {
  constructor(key: string) {
    super(`there is no option "${key}"`);
    this.name = 'UnknownOption';
  }
}
export class InvalidValue extends Error {
  readonly key: string;
  constructor(key: string, why: string) {
    super(`the value for "${key}" is not valid: ${why}`);
    this.name = 'InvalidValue';
    this.key = key;
  }
}
export class ScopeNotAllowed extends Error {
  constructor(key: string, scope: string, allowed: readonly string[]) {
    super(`"${key}" cannot be set at ${scope}; it is set at ${allowed.join(', ')}`);
    this.name = 'ScopeNotAllowed';
  }
}
export class VersionConflict extends Error {
  constructor(key: string, scope: string) {
    super(`"${key}" at ${scope} was changed by someone else`);
    this.name = 'VersionConflict';
  }
}
export class NotLoaded extends Error {
  constructor(key: string, scope: string) {
    super(`"${key}" is autoloaded but ${scope} has not been preloaded`);
    this.name = 'NotLoaded';
  }
}

export type OptionType = 'string' | 'number' | 'integer' | 'boolean' | 'json' | 'enum';

export interface OptionDef {
  readonly key: string;
  readonly type: OptionType;
  readonly default: unknown;
  readonly description?: string;
  /** Read in one call per scope by preload and then synchronously. */
  readonly autoload?: boolean;
  /** The scope kinds it may be set at, such as ['site', 'tenant']. Default ['site']. */
  readonly scopes?: readonly string[];
  /** For enum. */
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  /** For string; default 10000. */
  readonly maxLength?: number;
  /** Shown as [redacted] in events and listings. */
  readonly secret?: boolean;
  /** A further check; return a message when the value is not acceptable. */
  readonly validate?: (value: unknown) => string | null;
}

export interface Stored {
  readonly value: unknown;
  readonly version: number;
  readonly updatedAt: number;
  readonly updatedBy?: string;
}

export interface Backend {
  read(scope: string, key: string): Promise<Stored | undefined>;
  readMany(scope: string, keys: readonly string[]): Promise<Map<string, Stored>>;
  /** `expected`: null means it must not exist yet, a number that version, undefined anything. Throws VersionConflict. */
  write(scope: string, key: string, value: unknown, expected: number | null | undefined, meta: { at: number; by?: string }): Promise<Stored>;
  remove(scope: string, key: string): Promise<boolean>;
  list(scope: string): Promise<Map<string, Stored>>;
}

export function memoryBackend(): Backend {
  const data = new Map<string, Stored>();
  const k = (s: string, key: string) => `${s}\u0000${key}`;
  return {
    async read(scope, key) {
      const v = data.get(k(scope, key));
      return v && { ...v, value: structuredClone(v.value) };
    },
    async readMany(scope, keys) {
      const out = new Map<string, Stored>();
      for (const key of keys) {
        const v = data.get(k(scope, key));
        if (v) out.set(key, { ...v, value: structuredClone(v.value) });
      }
      return out;
    },
    async write(scope, key, value, expected, meta) {
      const cur = data.get(k(scope, key));
      if (expected === null && cur) throw new VersionConflict(key, scope);
      if (typeof expected === 'number' && cur?.version !== expected) throw new VersionConflict(key, scope);
      const next: Stored = { value: structuredClone(value), version: (cur?.version ?? 0) + 1, updatedAt: meta.at, ...(meta.by !== undefined ? { updatedBy: meta.by } : {}) };
      data.set(k(scope, key), next);
      return { ...next, value: structuredClone(next.value) };
    },
    async remove(scope, key) {
      return data.delete(k(scope, key));
    },
    async list(scope) {
      const out = new Map<string, Stored>();
      for (const [kk, v] of data) if (kk.startsWith(`${scope}\u0000`)) out.set(kk.slice(scope.length + 1), { ...v, value: structuredClone(v.value) });
      return out;
    },
  };
}

export interface Change {
  readonly key: string;
  readonly scope: string;
  readonly kind: 'set' | 'reset';
  readonly old: unknown;
  readonly value: unknown;
  readonly version: number;
  readonly at: number;
  readonly by?: string;
}
export type Listener = (change: Change) => void | Promise<void>;

export interface Resolved<T = unknown> {
  readonly value: T;
  /** The scope the value came from, or 'default'. */
  readonly source: string;
  readonly version?: number;
}

export interface StoreOptions {
  readonly backend: Backend;
  readonly now?: () => number;
  /** How long a non-autoloaded value is cached. Default 60 seconds. */
  readonly ttlMs?: number;
  readonly maxCached?: number;
}

const SCOPE = /^([a-z][a-z0-9_-]*)(?::([A-Za-z0-9_.@-]{1,128}))?$/;
const KEY = /^[a-z][a-z0-9_.-]{0,127}$/;
const MAX_JSON = 65_536;

/** The kind of a scope: `tenant:acme` is `tenant`. */
export function scopeKind(scope: string): string {
  const m = SCOPE.exec(scope);
  if (!m) throw new InvalidValue(scope, 'a scope looks like site, tenant:acme or user:42');
  return m[1]!;
}

function check(def: OptionDef, v: unknown): string | null {
  switch (def.type) {
    case 'string':
      if (typeof v !== 'string') return 'it must be text';
      if (v.length > (def.maxLength ?? 10_000)) return `it is longer than ${def.maxLength ?? 10_000} characters`;
      break;
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'it must be a number';
      if (def.type === 'integer' && !Number.isInteger(v)) return 'it must be a whole number';
      if (def.min !== undefined && v < def.min) return `it must be at least ${def.min}`;
      if (def.max !== undefined && v > def.max) return `it must be at most ${def.max}`;
      break;
    case 'boolean':
      if (typeof v !== 'boolean') return 'it must be true or false';
      break;
    case 'enum':
      if (typeof v !== 'string' || !(def.values ?? []).includes(v)) return `it must be one of ${(def.values ?? []).join(', ')}`;
      break;
    case 'json': {
      let s: string | undefined;
      try {
        s = JSON.stringify(v);
      } catch {
        return 'it cannot be written as JSON';
      }
      if (s === undefined) return 'it cannot be written as JSON';
      if (s.length > MAX_JSON) return `it is larger than ${MAX_JSON} characters as JSON`;
      break;
    }
  }
  return def.validate?.(v) ?? null;
}

export class OptionsStore {
  private readonly defs = new Map<string, OptionDef>();
  private readonly cache: Cache<Stored | null>;
  private readonly loaded = new Map<string, Map<string, Stored | null>>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly backend: Backend;
  private readonly now: () => number;
  /** Listener failures, newest last, kept to the last 100. */
  readonly listenerErrors: { key: string; message: string }[] = [];

  constructor(defs: readonly OptionDef[], o: StoreOptions) {
    this.backend = o.backend;
    this.now = o.now ?? Date.now;
    this.cache = new Cache<Stored | null>({ ttlMs: o.ttlMs ?? 60_000, max: o.maxCached ?? 10_000, now: this.now });
    for (const d of defs) {
      if (!KEY.test(d.key)) throw new InvalidValue(d.key, 'a key is lower-case letters, digits, dots, hyphens and underscores, starting with a letter');
      if (this.defs.has(d.key)) throw new InvalidValue(d.key, 'it is declared twice');
      if (d.type === 'enum' && !(d.values?.length)) throw new InvalidValue(d.key, 'an enum option needs its values');
      for (const s of d.scopes ?? ['site']) if (!/^[a-z][a-z0-9_-]*$/.test(s)) throw new InvalidValue(d.key, `"${s}" is not a scope kind`);
      const why = check(d, d.default);
      if (why) throw new InvalidValue(d.key, `its default is wrong: ${why}`);
      this.defs.set(d.key, { ...d, default: structuredClone(d.default) });
    }
  }

  private def(key: string): OptionDef {
    const d = this.defs.get(key);
    if (!d) throw new UnknownOption(key);
    return d;
  }

  private allowed(d: OptionDef, scope: string): boolean {
    return (d.scopes ?? ['site']).includes(scopeKind(scope));
  }

  get keys(): string[] {
    return [...this.defs.keys()];
  }

  /** Loads every autoload option for these scopes in one call each; afterwards `getSync` works for them. */
  async preload(scopes: readonly string[]): Promise<number> {
    let n = 0;
    for (const scope of scopes) {
      const keys = [...this.defs.values()].filter((d) => d.autoload && this.allowed(d, scope)).map((d) => d.key);
      const rows = keys.length ? await this.backend.readMany(scope, keys) : new Map<string, Stored>();
      const m = new Map<string, Stored | null>();
      for (const key of keys) m.set(key, rows.get(key) ?? null);
      this.loaded.set(scope, m);
      n += keys.length;
    }
    return n;
  }

  private fromRow(d: OptionDef, row: Stored | null | undefined): Stored | null {
    if (!row) return null;
    // A stored value that no longer fits the declaration (the definition changed) is skipped, not served.
    return check(d, row.value) ? null : row;
  }

  /** The value an autoload option has for these scopes, read from memory. */
  getSync<T = unknown>(key: string, scopes: readonly string[] = ['site']): T {
    return this.resolveSync<T>(key, scopes).value;
  }

  resolveSync<T = unknown>(key: string, scopes: readonly string[] = ['site']): Resolved<T> {
    const d = this.def(key);
    if (!d.autoload) throw new InvalidValue(key, 'it is not an autoload option; use get');
    for (const scope of scopes) {
      if (!this.allowed(d, scope)) continue;
      const m = this.loaded.get(scope);
      if (!m) throw new NotLoaded(key, scope);
      const row = this.fromRow(d, m.get(key));
      if (row) return { value: structuredClone(row.value) as T, source: scope, version: row.version };
    }
    return { value: structuredClone(d.default) as T, source: 'default' };
  }

  async get<T = unknown>(key: string, scopes: readonly string[] = ['site']): Promise<T> {
    return (await this.resolve<T>(key, scopes)).value;
  }

  /** The value and where it came from: the first scope (most specific first) with a value, else the default. */
  async resolve<T = unknown>(key: string, scopes: readonly string[] = ['site']): Promise<Resolved<T>> {
    const d = this.def(key);
    for (const scope of scopes) {
      if (!this.allowed(d, scope)) continue;
      let row: Stored | null | undefined;
      const snap = this.loaded.get(scope);
      if (d.autoload && snap?.has(key)) row = snap.get(key);
      else row = await this.cache.get(this.cacheKey(scope, key), async () => (await this.backend.read(scope, key)) ?? null, [`opt:${key}`]);
      const ok = this.fromRow(d, row);
      if (ok) return { value: structuredClone(ok.value) as T, source: scope, version: ok.version };
    }
    return { value: structuredClone(d.default) as T, source: 'default' };
  }

  private cacheKey(scope: string, key: string) {
    return `${scope}\u0000${key}`;
  }

  /** Drops what this process remembers of an option, for when another process changed it. */
  forget(key: string, scope?: string): void {
    if (scope) {
      this.cache.invalidate(this.cacheKey(scope, key));
      this.loaded.get(scope)?.delete(key);
    } else {
      this.cache.invalidateTag(`opt:${key}`);
      for (const m of this.loaded.values()) m.delete(key);
    }
  }

  private async emit(c: Change, secret: boolean | undefined): Promise<void> {
    const shown: Change = secret ? { ...c, old: c.old === undefined ? undefined : '[redacted]', value: '[redacted]' } : c;
    const ls = [...(this.listeners.get(c.key) ?? []), ...(this.listeners.get('*') ?? [])];
    await Promise.all(
      ls.map(async (l) => {
        try {
          await l(shown);
        } catch (e) {
          this.listenerErrors.push({ key: c.key, message: e instanceof Error ? e.message : String(e) });
          if (this.listenerErrors.length > 100) this.listenerErrors.shift();
        }
      }),
    );
  }

  /** Writes a value. `expectedVersion` makes it fail if someone else wrote since you read (null: only if nothing is set). */
  async set(key: string, scope: string, value: unknown, o: { by?: string; expectedVersion?: number | null } = {}): Promise<Stored> {
    const d = this.def(key);
    if (!this.allowed(d, scope)) throw new ScopeNotAllowed(key, scope, d.scopes ?? ['site']);
    const why = check(d, value);
    if (why) throw new InvalidValue(key, why);
    const before = await this.backend.read(scope, key);
    const row = await this.backend.write(scope, key, value, o.expectedVersion, { at: this.now(), ...(o.by !== undefined ? { by: o.by } : {}) });
    this.cache.invalidate(this.cacheKey(scope, key));
    const snap = this.loaded.get(scope);
    if (snap && d.autoload) snap.set(key, row);
    await this.emit({ key, scope, kind: 'set', old: before ? before.value : d.default, value: row.value, version: row.version, at: row.updatedAt, ...(o.by !== undefined ? { by: o.by } : {}) }, d.secret);
    return row;
  }

  /** Reads, changes and writes back, trying again if someone else wrote in between. */
  async update(key: string, scope: string, fn: (current: unknown) => unknown, o: { by?: string; attempts?: number } = {}): Promise<Stored> {
    const d = this.def(key);
    const attempts = o.attempts ?? 5;
    for (let i = 0; i < attempts; i++) {
      const cur = await this.backend.read(scope, key);
      const next = fn(cur ? structuredClone(cur.value) : structuredClone(d.default));
      try {
        return await this.set(key, scope, next, { ...(o.by !== undefined ? { by: o.by } : {}), expectedVersion: cur ? cur.version : null });
      } catch (e) {
        if (!(e instanceof VersionConflict) || i === attempts - 1) throw e;
      }
    }
    throw new VersionConflict(key, scope);
  }

  /** Removes the value at a scope, so reads fall back to the next scope or the default. */
  async reset(key: string, scope: string, o: { by?: string } = {}): Promise<boolean> {
    const d = this.def(key);
    if (!this.allowed(d, scope)) throw new ScopeNotAllowed(key, scope, d.scopes ?? ['site']);
    const before = await this.backend.read(scope, key);
    const removed = await this.backend.remove(scope, key);
    this.cache.invalidate(this.cacheKey(scope, key));
    this.loaded.get(scope)?.set(key, null);
    if (removed && before) await this.emit({ key, scope, kind: 'reset', old: before.value, value: d.default, version: before.version + 1, at: this.now(), ...(o.by !== undefined ? { by: o.by } : {}) }, d.secret);
    return removed;
  }

  /** Every option's effective value for these scopes and where it came from; secrets are shown as [redacted]. */
  async all(scopes: readonly string[] = ['site'], o: { includeSecrets?: boolean } = {}): Promise<Record<string, Resolved>> {
    const out: Record<string, Resolved> = {};
    for (const d of this.defs.values()) {
      const r = await this.resolve(d.key, scopes);
      out[d.key] = d.secret && !o.includeSecrets ? { ...r, value: '[redacted]' } : r;
    }
    return out;
  }

  /** What is stored at one scope (not defaults), for export. Secrets are redacted unless asked for. */
  async snapshot(scope: string, o: { includeSecrets?: boolean } = {}): Promise<Record<string, unknown>> {
    const rows = await this.backend.list(scope);
    const out: Record<string, unknown> = {};
    for (const [key, row] of [...rows].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const d = this.defs.get(key);
      if (!d || !this.allowed(d, scope) || check(d, row.value)) continue;
      out[key] = d.secret && !o.includeSecrets ? '[redacted]' : row.value;
    }
    return out;
  }

  /** Writes many values at one scope, all or none: every value is checked before the first is written. */
  async restore(scope: string, values: Readonly<Record<string, unknown>>, o: { by?: string } = {}): Promise<number> {
    for (const [key, v] of Object.entries(values)) {
      const d = this.def(key);
      if (!this.allowed(d, scope)) throw new ScopeNotAllowed(key, scope, d.scopes ?? ['site']);
      const why = check(d, v);
      if (why) throw new InvalidValue(key, why);
    }
    for (const [key, v] of Object.entries(values)) await this.set(key, scope, v, o);
    return Object.keys(values).length;
  }

  /** Listens to one key, or to every key with '*'. Returns the function that stops listening. */
  on(key: string, listener: Listener): () => void {
    if (key !== '*') this.def(key);
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
    };
  }
}
