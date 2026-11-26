/**
 * Grants: one person gives another person, a group, or anyone holding a link, a stated set of permissions on one
 * resource and everything under it. A grant can never give more than the giver has; a link can carry a password
 * (stored only as a salted hash) and an expiry, and wrong passwords are throttled per link. What a person may do on a
 * resource is the union of every grant that reaches them on it or on any resource above it.
 */
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Permission bits, as Nextcloud's sharing API numbers them. */
export const READ = 1;
export const UPDATE = 2;
export const CREATE = 4;
export const DELETE = 8;
export const SHARE = 16;
export const ALL = READ | UPDATE | CREATE | DELETE | SHARE;
/** A file has no inside, so nothing can be created or deleted in it. */
export const FILE_MAX = READ | UPDATE | SHARE;

export type Kind = 'person' | 'group' | 'link';

export interface Grant {
  readonly id: number;
  readonly resource: number;
  readonly resourceKind: 'file' | 'folder';
  readonly by: string;
  readonly kind: Kind;
  /** A person or group id; none for a link. */
  readonly to?: string;
  readonly permissions: number;
  readonly token?: string;
  readonly passwordHash?: string;
  /** Milliseconds since the epoch at which it stops working. */
  readonly expires?: number;
  readonly note?: string;
  readonly label?: string;
  readonly created: number;
}

export interface GrantStore {
  all(): Promise<Grant[]>;
  get(id: number): Promise<Grant | undefined>;
  set(g: Grant): Promise<void>;
  delete(id: number): Promise<void>;
  nextId(): Promise<number>;
}

export function memoryGrants(): GrantStore {
  const m = new Map<number, Grant>();
  let n = 0;
  return { all: async () => [...m.values()], get: async (id) => m.get(id), set: async (g) => void m.set(g.id, g), delete: async (id) => void m.delete(id), nextId: async () => ++n };
}

export class Refused extends Error {
  readonly why: string;
  constructor(why: string) {
    super(why);
    this.why = why;
  }
}

export class Throttled extends Error {
  readonly retryAfterMs: number;
  constructor(ms: number) {
    super(`too many wrong passwords; try again in ${Math.ceil(ms / 1000)} s`);
    this.retryAfterMs = ms;
  }
}

/** A link token: 15 letters and digits without look-alikes, about 85 bits, never derived from anything. */
export function linkToken(): string {
  const set = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 15 }, () => set[randomInt(set.length)]).join('');
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length);
  return timingSafeEqual(want, got);
}

export interface CreateInput {
  readonly resource: number;
  readonly resourceKind: 'file' | 'folder';
  readonly by: string;
  /** What the giver may do on the resource; the grant is refused if it asks for more. */
  readonly giverHas: number;
  readonly kind: Kind;
  readonly to?: string;
  readonly permissions?: number;
  readonly password?: string;
  readonly expires?: number;
  readonly note?: string;
  readonly label?: string;
}

export interface GrantsOptions {
  readonly now?: () => number;
  /** Wrong passwords a link allows per window before it waits. */
  readonly attempts?: number;
  readonly windowMs?: number;
  /** A password a link must have, when the deployment requires one. */
  readonly requireLinkPassword?: boolean;
  readonly minPasswordLength?: number;
}

export class Grants {
  private readonly store: GrantStore;
  private readonly now: () => number;
  private readonly attempts: number;
  private readonly windowMs: number;
  private readonly o: GrantsOptions;
  private readonly failures = new Map<string, number[]>();

  constructor(store: GrantStore, o: GrantsOptions = {}) {
    this.store = store;
    this.now = o.now ?? Date.now;
    this.attempts = o.attempts ?? 5;
    this.windowMs = o.windowMs ?? 60_000;
    this.o = o;
  }

  private shape(kind: 'file' | 'folder', wanted: number, has: number): number {
    if (!(wanted & READ)) throw new Refused('a grant must at least allow reading');
    if (wanted & ~ALL) throw new Refused('unknown permission bits');
    const cap = kind === 'file' ? FILE_MAX : ALL;
    if (wanted & ~has) throw new Refused('a grant cannot give more than the giver has');
    return wanted & cap;
  }

  private async checkLinkPassword(pw: string | undefined): Promise<string | undefined> {
    if (pw === undefined || pw === '') {
      if (this.o.requireLinkPassword) throw new Refused('a link needs a password here');
      return undefined;
    }
    if (pw.length < (this.o.minPasswordLength ?? 8)) throw new Refused(`a link password needs at least ${this.o.minPasswordLength ?? 8} characters`);
    return hashPassword(pw);
  }

  async create(i: CreateInput): Promise<Grant> {
    if (!(i.giverHas & SHARE)) throw new Refused('the giver may not share this');
    if (i.kind !== 'link' && !i.to) throw new Refused('a grant to a person or group names them');
    if (i.kind === 'person' && i.to === i.by) throw new Refused('a person cannot share with themselves');
    if (i.expires !== undefined && i.expires <= this.now()) throw new Refused('the expiry is in the past');
    const permissions = this.shape(i.resourceKind, i.permissions ?? (i.kind === 'link' ? READ : i.resourceKind === 'file' ? FILE_MAX : ALL), i.giverHas);
    const passwordHash = i.kind === 'link' ? await this.checkLinkPassword(i.password) : undefined;
    const g: Grant = {
      id: await this.store.nextId(),
      resource: i.resource,
      resourceKind: i.resourceKind,
      by: i.by,
      kind: i.kind,
      ...(i.to ? { to: i.to } : {}),
      permissions,
      ...(i.kind === 'link' ? { token: linkToken() } : {}),
      ...(passwordHash ? { passwordHash } : {}),
      ...(i.expires !== undefined ? { expires: i.expires } : {}),
      ...(i.note ? { note: i.note } : {}),
      ...(i.label ? { label: i.label } : {}),
      created: this.now(),
    };
    await this.store.set(g);
    return g;
  }

  async update(id: number, by: string, giverHas: number, change: { permissions?: number; password?: string | null; expires?: number | null; note?: string; label?: string }): Promise<Grant> {
    const g = await this.store.get(id);
    if (!g || g.by !== by) throw new Refused('no such grant of yours');
    const permissions = change.permissions === undefined ? g.permissions : this.shape(g.resourceKind, change.permissions, giverHas);
    let passwordHash = g.passwordHash;
    if (change.password === null) {
      if (this.o.requireLinkPassword && g.kind === 'link') throw new Refused('a link needs a password here');
      passwordHash = undefined;
    } else if (change.password !== undefined) passwordHash = await this.checkLinkPassword(change.password);
    if (typeof change.expires === 'number' && change.expires <= this.now()) throw new Refused('the expiry is in the past');
    const expires = change.expires === null ? undefined : (change.expires ?? g.expires);
    const next: Grant = {
      ...g,
      permissions,
      ...(change.note !== undefined ? { note: change.note } : {}),
      ...(change.label !== undefined ? { label: change.label } : {}),
    };
    const out = { ...next } as { -readonly [K in keyof Grant]: Grant[K] };
    if (passwordHash) out.passwordHash = passwordHash;
    else delete out.passwordHash;
    if (expires !== undefined) out.expires = expires;
    else delete out.expires;
    await this.store.set(out);
    return out;
  }

  async revoke(id: number, by: string): Promise<void> {
    const g = await this.store.get(id);
    if (!g || g.by !== by) throw new Refused('no such grant of yours');
    await this.store.delete(id);
  }

  /** Grants still in force; expired ones are left in the store for the sweep and never returned. */
  async live(filter: (g: Grant) => boolean = () => true): Promise<Grant[]> {
    const t = this.now();
    return (await this.store.all()).filter((g) => (g.expires === undefined || g.expires > t) && filter(g)).sort((a, b) => a.id - b.id);
  }

  async get(id: number): Promise<Grant | undefined> {
    const g = await this.store.get(id);
    return g && (g.expires === undefined || g.expires > this.now()) ? g : undefined;
  }

  async byToken(token: string): Promise<Grant | undefined> {
    return (await this.live((g) => g.kind === 'link' && g.token === token))[0];
  }

  /** Opens a link: no password needed, or the right one; wrong ones count against the link's window. */
  async open(token: string, password?: string): Promise<Grant> {
    const g = await this.byToken(token);
    if (!g) throw new Refused('no such link, or it expired');
    if (!g.passwordHash) return g;
    const t = this.now();
    const recent = (this.failures.get(token) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.attempts) throw new Throttled(this.windowMs - (t - recent[0]!));
    if (password !== undefined && (await checkPassword(password, g.passwordHash))) {
      this.failures.delete(token);
      return g;
    }
    this.failures.set(token, [...recent, t]);
    throw new Refused('the password is wrong');
  }

  /**
   * What a person may do on a resource through grants to them or their groups, given the resource and its
   * ancestors (nearest first). A link grant is not counted here; it is opened with its token.
   */
  async effective(person: string, groups: readonly string[], chain: readonly { id: number; kind: 'file' | 'folder' }[]): Promise<number> {
    const ids = new Set(chain.map((c) => c.id));
    const mine = await this.live((g) => ids.has(g.resource) && ((g.kind === 'person' && g.to === person) || (g.kind === 'group' && !!g.to && groups.includes(g.to))));
    const bits = mine.reduce((a, g) => a | g.permissions, 0);
    return chain[0]?.kind === 'file' ? bits & FILE_MAX : bits;
  }

  /** Removes grants that expired, and every grant on a resource that is gone; returns how many. */
  async sweep(exists: (resource: number) => Promise<boolean>): Promise<number> {
    const t = this.now();
    let n = 0;
    for (const g of await this.store.all())
      if ((g.expires !== undefined && g.expires <= t) || !(await exists(g.resource))) {
        await this.store.delete(g.id);
        n++;
      }
    return n;
  }
}
