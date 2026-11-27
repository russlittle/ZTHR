/**
 * API keys: issued with scopes and an expiry, shown once, kept only as a hash, found by a public prefix so a
 * lookup never scans, rotated with an overlap so callers move to the new key without an outage, and revoked one
 * at a time. A key's prefix says what it is ("zk_live_"), so a leaked key is recognisable to secret scanners.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Key {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly hash: string;
  readonly created: number;
  readonly expires?: number;
  lastUsed?: number;
  revoked?: number;
  /** When rotated: the key that replaces it, and when this one stops working. */
  replacedBy?: string;
  retiresAt?: number;
}

export interface KeyStore {
  byId(id: string): Promise<Key | undefined>;
  set(k: Key): Promise<void>;
  list(owner: string): Promise<Key[]>;
}

export function memoryKeys(): KeyStore {
  const m = new Map<string, Key>();
  return { byId: async (id) => m.get(id), set: async (k) => void m.set(k.id, k), list: async (o) => [...m.values()].filter((k) => k.owner === o) };
}

export class Rejected extends Error {
  constructor(why: string) {
    super(why);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class ApiKeys {
  private readonly store: KeyStore;
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(store: KeyStore, o: { prefix?: string; now?: () => number } = {}) {
    this.store = store;
    this.prefix = o.prefix ?? 'zk_live_';
    this.now = o.now ?? Date.now;
  }

  /** A new key: "<prefix><id>_<secret>"; the whole string is shown once and only its hash is kept. */
  async issue(owner: string, name: string, scopes: readonly string[], o: { ttlMs?: number } = {}): Promise<{ key: Key; secret: string }> {
    if (!scopes.length) throw new Rejected('a key needs at least one scope');
    const id = randomBytes(6).toString('hex');
    const secret = `${this.prefix}${id}_${randomBytes(24).toString('base64url')}`;
    const key: Key = { id, owner, name, scopes: [...scopes], hash: sha(secret), created: this.now(), ...(o.ttlMs ? { expires: this.now() + o.ttlMs } : {}) };
    await this.store.set(key);
    return { key, secret };
  }

  /** The key a request presented, if it is good and allows `scope`. */
  async check(secret: string, scope: string): Promise<Key> {
    const m = new RegExp(`^${this.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f]{12})_[A-Za-z0-9_-]+$`).exec(secret);
    if (!m) throw new Rejected('that is not an API key from this service');
    const k = await this.store.byId(m[1]!);
    const h = Buffer.from(sha(secret));
    if (!k || !timingSafeEqual(Buffer.from(k.hash), h)) throw new Rejected('that key is not recognised');
    const t = this.now();
    if (k.revoked) throw new Rejected('that key was revoked');
    if (k.expires && k.expires <= t) throw new Rejected('that key has expired');
    if (k.retiresAt && k.retiresAt <= t) throw new Rejected('that key was replaced; use the new one');
    if (!k.scopes.includes(scope) && !k.scopes.includes('*')) throw new Rejected(`that key does not allow ${scope}`);
    if (!k.lastUsed || t - k.lastUsed > 60_000) {
      k.lastUsed = t;
      await this.store.set(k);
    }
    return k;
  }

  /** A replacement with the same scopes; the old key keeps working for `overlapMs`, then stops. */
  async rotate(owner: string, id: string, overlapMs: number): Promise<{ key: Key; secret: string }> {
    const old = await this.store.byId(id);
    if (!old || old.owner !== owner || old.revoked) throw new Rejected('no such key of yours');
    const next = await this.issue(owner, old.name, old.scopes);
    old.replacedBy = next.key.id;
    old.retiresAt = this.now() + overlapMs;
    await this.store.set(old);
    return next;
  }

  async revoke(owner: string, id: string): Promise<void> {
    const k = await this.store.byId(id);
    if (!k || k.owner !== owner) throw new Rejected('no such key of yours');
    k.revoked = this.now();
    await this.store.set(k);
  }

  /** A person's keys without their hashes, for a settings page. */
  async list(owner: string) {
    return (await this.store.list(owner)).map(({ hash: _hash, ...rest }) => ({ ...rest, active: !rest.revoked && (!rest.expires || rest.expires > this.now()) && (!rest.retiresAt || rest.retiresAt > this.now()) }));
  }
}
