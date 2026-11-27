/**
 * Accounts and organisations: sign-up with an emailed confirmation, invitations into an organisation with a
 * role, password reset by a single-use expiring link, and a lifecycle (invited, active, deactivated, offboarded)
 * where offboarding removes every membership and grant on the way out. People who belong to several
 * organisations, or hold several roles, switch between them; an admin can act as a person to reproduce a problem,
 * and anyone with break-glass rights can take emergency access, but both are time-boxed, need a written reason,
 * and are recorded and announced.
 */
import { createHash, randomBytes } from 'node:crypto';

export type State = 'invited' | 'active' | 'deactivated' | 'offboarded';

export interface Account {
  readonly id: string;
  email: string;
  name: string;
  state: State;
  emailConfirmed: boolean;
  passwordHash?: string;
  readonly created: number;
  /** The organisation and role in use now, chosen among their memberships. */
  current?: { org: string; role: string };
}

export interface Membership {
  readonly org: string;
  readonly account: string;
  roles: string[];
  readonly since: number;
}

export interface Org {
  readonly id: string;
  name: string;
  readonly created: number;
}

interface Pending {
  readonly purpose: 'confirm' | 'reset' | 'invite';
  readonly account: string;
  readonly org?: string;
  readonly role?: string;
  readonly expires: number;
}

/** A time-boxed elevation: acting as someone, or emergency access. */
export interface Elevation {
  readonly id: string;
  readonly kind: 'act-as' | 'break-glass';
  readonly by: string;
  readonly as?: string;
  readonly reason: string;
  readonly from: number;
  readonly until: number;
  ended?: number;
}

export class Refused extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface Hooks {
  /** Send a link to a person: confirmation, reset or invitation. */
  readonly send: (to: string, purpose: Pending['purpose'], link: string) => Promise<void>;
  /** Hash and check passwords (the grants block's scrypt). */
  readonly hash: (pw: string) => Promise<string>;
  readonly check: (pw: string, hash: string) => Promise<boolean>;
  /** Every change worth an audit entry. */
  readonly record?: (actor: string, action: string, target: string, detail?: Record<string, unknown>) => Promise<void>;
  /** Announce an elevation to the people who must know (security, the person acted as). */
  readonly announce?: (e: Elevation) => Promise<void>;
  /** Remove everything a person was given outside memberships (shares, keys, devices) when they are offboarded. */
  readonly revokeAll?: (account: string) => Promise<void>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const norm = (e: string) => e.trim().toLowerCase();

export class Accounts {
  readonly accounts = new Map<string, Account>();
  readonly orgs = new Map<string, Org>();
  readonly memberships: Membership[] = [];
  readonly elevations: Elevation[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly h: Hooks;
  private readonly now: () => number;
  private readonly base: string;
  private seq = 0;

  constructor(h: Hooks, o: { now?: () => number; baseUrl: string }) {
    this.h = h;
    this.now = o.now ?? Date.now;
    this.base = o.baseUrl.replace(/\/$/, '');
  }

  private id(p: string) {
    return `${p}_${++this.seq}`;
  }

  byEmail(email: string): Account | undefined {
    return [...this.accounts.values()].find((a) => a.email === norm(email));
  }

  private async link(purpose: Pending['purpose'], account: Account, ttlMs: number, extra: Partial<Pending> = {}): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    this.pending.set(sha(token), { purpose, account: account.id, expires: this.now() + ttlMs, ...extra });
    const link = `${this.base}/${purpose}/${token}`;
    await this.h.send(account.email, purpose, link);
    return token;
  }

  /** Takes a link's token once: it works for its purpose, before it expires, and never again. */
  private take(token: string, purpose: Pending['purpose']): Pending {
    const k = sha(token);
    const p = this.pending.get(k);
    if (!p || p.purpose !== purpose) throw new Refused('that link is not valid');
    this.pending.delete(k);
    if (p.expires < this.now()) throw new Refused('that link has expired; ask for a new one');
    return p;
  }

  async signUp(email: string, name: string, password: string): Promise<Account> {
    if (this.byEmail(email)) {
      // Say nothing different to the caller, so sign-up cannot be used to find out who has an account.
      const existing = this.byEmail(email)!;
      await this.h.send(existing.email, 'reset', `${this.base}/signin`);
      return existing;
    }
    const a: Account = { id: this.id('acct'), email: norm(email), name: name.trim(), state: 'active', emailConfirmed: false, passwordHash: await this.h.hash(password), created: this.now() };
    this.accounts.set(a.id, a);
    await this.link('confirm', a, 7 * 86_400_000);
    await this.h.record?.(a.id, 'sign-up', a.id);
    return a;
  }

  async confirm(token: string): Promise<Account> {
    const p = this.take(token, 'confirm');
    const a = this.accounts.get(p.account)!;
    a.emailConfirmed = true;
    return a;
  }

  async signIn(email: string, password: string): Promise<Account> {
    const a = this.byEmail(email);
    if (!a || !a.passwordHash || !(await this.h.check(password, a.passwordHash))) throw new Refused('that email and password do not sign in');
    if (a.state !== 'active') throw new Refused(a.state === 'invited' ? 'accept your invitation first' : 'this account is not active');
    return a;
  }

  /** Always answers the same, whether or not the email has an account. */
  async requestReset(email: string): Promise<void> {
    const a = this.byEmail(email);
    if (a && a.state === 'active') await this.link('reset', a, 3_600_000);
  }

  async reset(token: string, password: string): Promise<Account> {
    const p = this.take(token, 'reset');
    const a = this.accounts.get(p.account)!;
    // Every other reset link for the account is spent with this one, so an older link cannot reset it again.
    for (const [k, x] of this.pending) if (x.account === a.id && x.purpose === 'reset') this.pending.delete(k);
    a.passwordHash = await this.h.hash(password);
    a.emailConfirmed = true;
    await this.h.record?.(a.id, 'password-reset', a.id);
    return a;
  }

  createOrg(name: string, owner: string): Org {
    const o: Org = { id: this.id('org'), name, created: this.now() };
    this.orgs.set(o.id, o);
    this.memberships.push({ org: o.id, account: owner, roles: ['owner'], since: this.now() });
    const a = this.accounts.get(owner);
    if (a && !a.current) a.current = { org: o.id, role: 'owner' };
    return o;
  }

  /** Invites someone into an organisation with a role (only an owner grants "owner"); they set a password when they accept. */
  async invite(by: string, org: string, email: string, role: string): Promise<Account> {
    const mine = this.rolesIn(by, org);
    if (!mine.some((r) => r === 'owner' || r === 'admin')) throw new Refused('only an owner or admin invites people');
    if (role === 'owner' && !mine.includes('owner')) throw new Refused('only an owner makes someone an owner');
    let a = this.byEmail(email);
    if (!a) {
      a = { id: this.id('acct'), email: norm(email), name: '', state: 'invited', emailConfirmed: false, created: this.now() };
      this.accounts.set(a.id, a);
    }
    await this.link('invite', a, 14 * 86_400_000, { org, role });
    await this.h.record?.(by, 'invite', a.id, { org, role });
    return a;
  }

  async accept(token: string, o: { name?: string; password?: string } = {}): Promise<Account> {
    const p = this.take(token, 'invite');
    const a = this.accounts.get(p.account)!;
    if (a.state === 'offboarded') throw new Refused('this account was closed');
    if (a.state === 'invited') {
      if (!o.password) throw new Refused('choose a password to accept');
      a.passwordHash = await this.h.hash(o.password);
      a.name = o.name?.trim() || a.email;
      a.state = 'active';
    }
    a.emailConfirmed = true;
    const m = this.memberships.find((x) => x.org === p.org && x.account === a.id);
    if (m) m.roles = [...new Set([...m.roles, p.role!])];
    else this.memberships.push({ org: p.org!, account: a.id, roles: [p.role!], since: this.now() });
    a.current ??= { org: p.org!, role: p.role! };
    return a;
  }

  rolesIn(account: string, org: string): string[] {
    return this.memberships.find((m) => m.org === org && m.account === account)?.roles ?? [];
  }

  /** The organisations and roles a person can switch between, for the top bar. */
  choices(account: string): { org: string; name: string; role: string }[] {
    return this.memberships.filter((m) => m.account === account).flatMap((m) => m.roles.map((role) => ({ org: m.org, name: this.orgs.get(m.org)?.name ?? m.org, role })));
  }

  switchTo(account: string, org: string, role: string): void {
    if (!this.rolesIn(account, org).includes(role)) throw new Refused('you do not hold that role there');
    this.accounts.get(account)!.current = { org, role };
  }

  deactivate(by: string, account: string): void {
    const a = this.accounts.get(account);
    if (!a || a.state !== 'active') throw new Refused('only an active account can be deactivated');
    a.state = 'deactivated';
    this.endElevationsOf(account);
    void this.h.record?.(by, 'deactivate', account);
  }

  reactivate(by: string, account: string): void {
    const a = this.accounts.get(account);
    if (!a || a.state !== 'deactivated') throw new Refused('only a deactivated account can be reactivated');
    a.state = 'active';
    void this.h.record?.(by, 'reactivate', account);
  }

  /** Closes an account for good: every membership and every grant goes, and it cannot sign in again. */
  async offboard(by: string, account: string): Promise<void> {
    const a = this.accounts.get(account);
    if (!a) throw new Refused('no such account');
    for (let i = this.memberships.length - 1; i >= 0; i--) if (this.memberships[i]!.account === account) this.memberships.splice(i, 1);
    await this.h.revokeAll?.(account);
    a.state = 'offboarded';
    delete a.passwordHash;
    delete a.current;
    this.endElevationsOf(account);
    for (const [k, p] of this.pending) if (p.account === account) this.pending.delete(k);
    await this.h.record?.(by, 'offboard', account);
  }

  /** Starts acting as someone (support) or emergency access (break-glass): time-boxed, reasoned, recorded, announced. */
  async elevate(kind: Elevation['kind'], by: string, o: { as?: string; reason: string; minutes: number }): Promise<Elevation> {
    if (o.reason.trim().length < 15) throw new Refused('write the reason in a sentence: it is recorded and reviewed');
    if (!Number.isFinite(o.minutes) || o.minutes < 1 || o.minutes > (kind === 'break-glass' ? 240 : 60)) throw new Refused(`${kind} lasts at most ${kind === 'break-glass' ? 4 : 1} hour${kind === 'break-glass' ? 's' : ''}`);
    if (kind === 'act-as' && (!o.as || !this.accounts.has(o.as))) throw new Refused('name the person to act as');
    if (o.as === by) throw new Refused('you cannot act as yourself');
    const e: Elevation = { id: this.id('elev'), kind, by, ...(o.as ? { as: o.as } : {}), reason: o.reason.trim(), from: this.now(), until: this.now() + o.minutes * 60_000 };
    this.elevations.push(e);
    await this.h.record?.(by, kind, o.as ?? '*', { reason: e.reason, until: e.until });
    await this.h.announce?.(e);
    return e;
  }

  /** The elevation in force for a person now, if any. */
  active(by: string): Elevation | undefined {
    const t = this.now();
    return this.elevations.find((e) => e.by === by && e.ended === undefined && e.until > t);
  }

  /** Ends every elevation held by, or acting as, an account that can no longer act. */
  private endElevationsOf(account: string): void {
    const t = this.now();
    for (const e of this.elevations) if (e.ended === undefined && e.until > t && (e.by === account || e.as === account)) e.ended = t;
  }

  end(id: string): void {
    const e = this.elevations.find((x) => x.id === id);
    if (e && e.ended === undefined) e.ended = this.now();
  }

  /** Elevations still waiting for review, oldest first: every one is reviewed after it ends. */
  toReview(): Elevation[] {
    const t = this.now();
    return this.elevations.filter((e) => e.ended !== undefined || e.until <= t).sort((a, b) => a.from - b.from);
  }
}
