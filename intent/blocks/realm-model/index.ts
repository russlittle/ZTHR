/**
 * Multi-tenant identity realms. A realm is a closed world of users, groups and roles with its own policy, and
 * nothing in one realm can see or name anything in another. Users have a declared set of attributes (required,
 * pattern, single or multiple values, who may edit); groups form a tree by path and pass their roles and
 * attributes down to their members and sub-groups; roles can be composite (a role made of other roles, cycles
 * refused). Each realm has a policy: password rules, who may register (an email-domain allow list), and lockout
 * after repeated failures with a clock that is passed in. The effective roles and attributes of a user are
 * handed to the rbac block as its Subject, so the same evaluator that decides permissions reads the realm.
 * Passwords are not stored here (the accounts and grants blocks hash them); this block only checks their shape.
 */
import type { Policy, Subject } from '../rbac/index.ts';

export class RealmRefused extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface AttributeDef {
  readonly name: string;
  readonly required?: boolean;
  readonly multivalued?: boolean;
  /** Each value must match, in full. */
  readonly pattern?: string;
  readonly maxLength?: number;
  /** Who may change it: admins only, or the user too. Default admin. */
  readonly editableBy?: 'admin' | 'user';
}

export interface PasswordPolicy {
  readonly minLength: number;
  readonly requireUpper?: boolean;
  readonly requireLower?: boolean;
  readonly requireDigit?: boolean;
  readonly requireSymbol?: boolean;
  readonly notUsername?: boolean;
  readonly notEmail?: boolean;
}

export interface RealmPolicy {
  readonly password: PasswordPolicy;
  readonly registrationAllowed: boolean;
  /** When set, self-registered email addresses must be in one of these domains. */
  readonly emailDomains?: readonly string[];
  readonly lockout: { readonly maxFailures: number; readonly lockMs: number };
  readonly emailAsUsername?: boolean;
}

export interface RoleDef {
  readonly name: string;
  readonly label: string;
  /** Roles this one includes. */
  readonly includes?: readonly string[];
}

export interface User {
  readonly id: string;
  readonly username: string;
  readonly email?: string;
  readonly enabled: boolean;
  readonly roles: readonly string[];
  readonly groups: readonly string[];
  readonly attrs: Readonly<Record<string, readonly string[]>>;
}

export interface Group {
  readonly path: string;
  readonly roles: readonly string[];
  readonly attrs: Readonly<Record<string, readonly string[]>>;
}

const NAME = /^[a-z][a-z0-9_.-]{0,62}$/;
const PATH = /^(?:\/[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,62}){1,16}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || undefined;

export function checkPassword(p: PasswordPolicy, password: string, who: { username?: string; email?: string } = {}): string[] {
  const out: string[] = [];
  if ([...password].length < p.minLength) out.push(`at least ${p.minLength} characters`);
  if (p.requireUpper && !/\p{Lu}/u.test(password)) out.push('an upper-case letter');
  if (p.requireLower && !/\p{Ll}/u.test(password)) out.push('a lower-case letter');
  if (p.requireDigit && !/\p{Nd}/u.test(password)) out.push('a digit');
  if (p.requireSymbol && !/[^\p{L}\p{Nd}\s]/u.test(password)) out.push('a symbol');
  const low = password.toLowerCase();
  if (p.notUsername && who.username && low.includes(who.username.toLowerCase())) out.push('not to contain the username');
  if (p.notEmail && who.email && (low.includes(who.email.toLowerCase()) || low.includes(who.email.split('@')[0]!.toLowerCase()))) out.push('not to contain the email address');
  return out;
}

export interface RealmOptions {
  readonly name: string;
  readonly policy: RealmPolicy;
  readonly attributes?: readonly AttributeDef[];
  readonly defaultRoles?: readonly string[];
  readonly now: () => number;
  readonly newId: () => string;
}

export class Realm {
  readonly name: string;
  private readonly o: RealmOptions;
  private readonly roles = new Map<string, RoleDef>();
  private readonly groups = new Map<string, { roles: string[]; attrs: Record<string, string[]> }>();
  private readonly users = new Map<string, User>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly defs = new Map<string, AttributeDef>();

  constructor(o: RealmOptions) {
    if (!NAME.test(o.name)) throw new RealmRefused('a realm name is lower-case letters, digits and . _ - , starting with a letter');
    this.name = o.name;
    this.o = o;
    for (const d of o.attributes ?? []) this.defs.set(d.name, d);
  }

  get policy(): RealmPolicy {
    return this.o.policy;
  }

  // ------------------------------------------------------------ roles

  defineRole(r: RoleDef): void {
    if (!NAME.test(r.name)) throw new RealmRefused(`${JSON.stringify(r.name)} is not a valid role name`);
    for (const i of r.includes ?? []) if (i !== r.name && !this.roles.has(i)) throw new RealmRefused(`role ${r.name} includes ${i}, which is not defined in realm ${this.name}`);
    const before = this.roles.get(r.name);
    this.roles.set(r.name, r);
    if (this.closure([r.name]).size && this.cyclic(r.name)) {
      if (before) this.roles.set(r.name, before);
      else this.roles.delete(r.name);
      throw new RealmRefused(`role ${r.name} would include itself through its composition`);
    }
  }

  private cyclic(start: string): boolean {
    const seen = new Set<string>();
    const walk = (n: string): boolean => {
      for (const i of this.roles.get(n)?.includes ?? []) {
        if (i === start) return true;
        if (!seen.has(i)) {
          seen.add(i);
          if (walk(i)) return true;
        }
      }
      return false;
    };
    return walk(start);
  }

  /** The roles with everything they include, at any depth. */
  private closure(names: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const add = (n: string) => {
      if (out.has(n) || !this.roles.has(n)) return;
      out.add(n);
      for (const i of this.roles.get(n)!.includes ?? []) add(i);
    };
    for (const n of names) add(n);
    return out;
  }

  // ------------------------------------------------------------ groups

  addGroup(path: string, o: { roles?: readonly string[]; attrs?: Readonly<Record<string, readonly string[]>> } = {}): void {
    if (!PATH.test(path)) throw new RealmRefused(`${JSON.stringify(path)} is not a group path like /engineering/platform`);
    if (this.groups.has(path)) throw new RealmRefused(`group ${path} already exists`);
    const parent = parentOf(path);
    if (parent && !this.groups.has(parent)) throw new RealmRefused(`group ${parent} does not exist yet`);
    this.checkRoles(o.roles ?? []);
    this.groups.set(path, { roles: [...(o.roles ?? [])], attrs: this.cleanAttrs(o.attrs ?? {}, false) });
  }

  groupPaths(): string[] {
    return [...this.groups.keys()].sort();
  }

  /** Removes a group; its sub-groups go too only when asked, and members lose the membership. */
  removeGroup(path: string, o: { cascade?: boolean } = {}): string[] {
    if (!this.groups.has(path)) throw new RealmRefused(`no group ${path}`);
    const gone = this.groupPaths().filter((g) => g === path || g.startsWith(`${path}/`));
    if (gone.length > 1 && !o.cascade) throw new RealmRefused(`group ${path} has sub-groups: ${gone.slice(1).join(', ')}`);
    for (const g of gone) this.groups.delete(g);
    for (const [id, u] of this.users) this.users.set(id, { ...u, groups: u.groups.filter((g) => !gone.includes(g)) });
    return gone;
  }

  /** Moves a group and everything under it. */
  moveGroup(path: string, newParent: string | undefined): void {
    if (!this.groups.has(path)) throw new RealmRefused(`no group ${path}`);
    if (newParent && !this.groups.has(newParent)) throw new RealmRefused(`no group ${newParent}`);
    if (newParent && (newParent === path || newParent.startsWith(`${path}/`))) throw new RealmRefused('a group cannot move into itself');
    const target = `${newParent ?? ''}/${path.slice(path.lastIndexOf('/') + 1)}`;
    if (target === path) return;
    if (this.groups.has(target)) throw new RealmRefused(`group ${target} already exists`);
    const rename = (p: string) => (p === path || p.startsWith(`${path}/`) ? target + p.slice(path.length) : p);
    const entries = [...this.groups.entries()];
    this.groups.clear();
    for (const [p, g] of entries) this.groups.set(rename(p), g);
    for (const [id, u] of this.users) this.users.set(id, { ...u, groups: u.groups.map(rename) });
  }

  // ------------------------------------------------------------ users

  private checkRoles(names: readonly string[]) {
    for (const r of names) if (!this.roles.has(r)) throw new RealmRefused(`role ${r} is not defined in realm ${this.name}`);
  }

  private cleanAttrs(a: Readonly<Record<string, readonly string[]>>, strict: boolean, actor: 'admin' | 'user' = 'admin', old: Readonly<Record<string, readonly string[]>> = {}): Record<string, string[]> {
    const out: Record<string, string[]> = Object.create(null);
    for (const [k, v] of Object.entries(a)) {
      if (FORBIDDEN_KEYS.has(k)) throw new RealmRefused(`attribute name ${k} is not allowed`);
      const d = this.defs.get(k);
      if (strict && !d) throw new RealmRefused(`attribute ${k} is not declared in realm ${this.name}`);
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new RealmRefused(`attribute ${k} must be a list of strings`);
      if (d) {
        if (!d.multivalued && v.length > 1) throw new RealmRefused(`attribute ${k} takes one value`);
        for (const x of v) {
          if (d.maxLength !== undefined && x.length > d.maxLength) throw new RealmRefused(`attribute ${k} is longer than ${d.maxLength}`);
          if (d.pattern && !new RegExp(`^(?:${d.pattern})$`, 'u').test(x)) throw new RealmRefused(`attribute ${k} value ${JSON.stringify(x.slice(0, 40))} does not match its pattern`);
        }
        const changed = JSON.stringify(old[k] ?? []) !== JSON.stringify(v);
        if (strict && changed && actor === 'user' && (d.editableBy ?? 'admin') !== 'user') throw new RealmRefused(`attribute ${k} can only be changed by an administrator`);
      }
      out[k] = [...v];
    }
    return out;
  }

  createUser(o: { username: string; email?: string; roles?: readonly string[]; groups?: readonly string[]; attrs?: Readonly<Record<string, readonly string[]>>; selfRegistered?: boolean }): User {
    const username = (this.o.policy.emailAsUsername && o.email ? o.email : o.username).trim().toLowerCase();
    if (!/^[^\s\x00-\x1f]{1,128}$/u.test(username)) throw new RealmRefused('a username has no spaces or control characters and is at most 128 long');
    if ([...this.users.values()].some((u) => u.username === username)) throw new RealmRefused(`username ${username} is taken in realm ${this.name}`);
    const email = o.email?.trim().toLowerCase();
    if (email !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RealmRefused('that email address is not valid');
      if ([...this.users.values()].some((u) => u.email === email)) throw new RealmRefused(`email ${email} is already used in realm ${this.name}`);
    }
    if (o.selfRegistered) {
      if (!this.o.policy.registrationAllowed) throw new RealmRefused(`realm ${this.name} does not allow self-registration`);
      const dom = email?.split('@')[1];
      if (this.o.policy.emailDomains && (!dom || !this.o.policy.emailDomains.includes(dom))) throw new RealmRefused(`self-registration needs an email in: ${this.o.policy.emailDomains.join(', ')}`);
    }
    const roles = [...new Set([...(this.o.defaultRoles ?? []), ...(o.roles ?? [])])];
    this.checkRoles(roles);
    for (const g of o.groups ?? []) if (!this.groups.has(g)) throw new RealmRefused(`no group ${g}`);
    const attrs = this.cleanAttrs(o.attrs ?? {}, true);
    const missing = [...this.defs.values()].filter((d) => d.required && !(attrs[d.name]?.length)).map((d) => d.name);
    if (missing.length) throw new RealmRefused(`missing required attributes: ${missing.join(', ')}`);
    const u: User = { id: this.o.newId(), username, ...(email ? { email } : {}), enabled: true, roles, groups: [...new Set(o.groups ?? [])], attrs };
    this.users.set(u.id, u);
    return u;
  }

  user(id: string): User {
    const u = this.users.get(id);
    if (!u) throw new RealmRefused(`no user ${id} in realm ${this.name}`);
    return u;
  }

  findByUsername(name: string): User | undefined {
    const n = name.trim().toLowerCase();
    return [...this.users.values()].find((u) => u.username === n || u.email === n);
  }

  userCount(): number {
    return this.users.size;
  }

  setAttrs(id: string, attrs: Readonly<Record<string, readonly string[]>>, actor: 'admin' | 'user' = 'admin'): User {
    const u = this.user(id);
    const merged = { ...u.attrs, ...attrs };
    const clean = this.cleanAttrs(merged, true, actor, u.attrs);
    const missing = [...this.defs.values()].filter((d) => d.required && !(clean[d.name]?.length)).map((d) => d.name);
    if (missing.length) throw new RealmRefused(`missing required attributes: ${missing.join(', ')}`);
    const next = { ...u, attrs: clean };
    this.users.set(id, next);
    return next;
  }

  join(id: string, group: string): void {
    const u = this.user(id);
    if (!this.groups.has(group)) throw new RealmRefused(`no group ${group}`);
    if (!u.groups.includes(group)) this.users.set(id, { ...u, groups: [...u.groups, group] });
  }

  leave(id: string, group: string): void {
    const u = this.user(id);
    this.users.set(id, { ...u, groups: u.groups.filter((g) => g !== group) });
  }

  grant(id: string, role: string): void {
    const u = this.user(id);
    this.checkRoles([role]);
    if (!u.roles.includes(role)) this.users.set(id, { ...u, roles: [...u.roles, role] });
  }

  revoke(id: string, role: string): void {
    const u = this.user(id);
    this.users.set(id, { ...u, roles: u.roles.filter((r) => r !== role) });
  }

  setEnabled(id: string, enabled: boolean): void {
    this.users.set(id, { ...this.user(id), enabled });
  }

  // ------------------------------------------------------------ what a user is

  /** Every group a user is in, with each group's ancestors. */
  effectiveGroups(id: string): string[] {
    const out = new Set<string>();
    for (const g of this.user(id).groups) for (let p: string | undefined = g; p; p = parentOf(p)) out.add(p);
    return [...out].sort();
  }

  /** Roles held directly, through groups (and their ancestors), and through composition. A disabled user has none. */
  effectiveRoles(id: string): string[] {
    const u = this.user(id);
    if (!u.enabled) return [];
    const base = [...u.roles];
    for (const g of this.effectiveGroups(id)) base.push(...this.groups.get(g)!.roles);
    return [...this.closure(base)].sort();
  }

  /** Attributes with group values passed down (deeper groups override shallower) and the user's own on top. */
  effectiveAttrs(id: string): Record<string, string[]> {
    const out: Record<string, string[]> = Object.create(null);
    const groups = this.effectiveGroups(id).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const g of groups) for (const [k, v] of Object.entries(this.groups.get(g)!.attrs)) out[k] = [...v];
    for (const [k, v] of Object.entries(this.user(id).attrs)) out[k] = [...v];
    return out;
  }

  /** The rbac block's view of a user: effective roles, and attributes with the realm and groups included. */
  subject(id: string): Subject {
    const attrs: Record<string, string | readonly string[]> = { realm: this.name, groups: this.effectiveGroups(id) };
    for (const [k, v] of Object.entries(this.effectiveAttrs(id))) attrs[k] = v.length === 1 ? v[0]! : v;
    return { id: `${this.name}:${id}`, roles: this.effectiveRoles(id), attrs };
  }

  /** An rbac policy skeleton with this realm's roles and their composition, ready for grants to be added. */
  rolePolicy(grants: Policy['grants'] = []): Policy {
    const roles: Record<string, { label: string; inherits?: readonly string[] }> = {};
    for (const r of this.roles.values()) roles[r.name] = { label: r.label, ...(r.includes?.length ? { inherits: r.includes } : {}) };
    return { roles, grants };
  }

  // ------------------------------------------------------------ policy in use

  passwordProblems(password: string, id?: string): string[] {
    const u = id ? this.user(id) : undefined;
    return checkPassword(this.o.policy.password, password, { ...(u ? { username: u.username } : {}), ...(u?.email ? { email: u.email } : {}) });
  }

  /** Records a failed sign-in; true when it locked the user. */
  recordFailure(id: string): boolean {
    const now = this.o.now();
    const f = this.failures.get(id) ?? { count: 0, lockedUntil: 0 };
    if (f.lockedUntil && now >= f.lockedUntil) {
      f.count = 0;
      f.lockedUntil = 0;
    }
    f.count += 1;
    if (f.count >= this.o.policy.lockout.maxFailures) f.lockedUntil = now + this.o.policy.lockout.lockMs;
    this.failures.set(id, f);
    return f.lockedUntil > now;
  }

  recordSuccess(id: string): void {
    this.failures.delete(id);
  }

  isLocked(id: string): boolean {
    const f = this.failures.get(id);
    return !!f && f.lockedUntil > this.o.now();
  }

  /** The whole realm as plain data, without any failure counts. */
  export(): { name: string; roles: RoleDef[]; groups: Group[]; users: User[] } {
    return { name: this.name, roles: [...this.roles.values()], groups: this.groupPaths().map((p) => ({ path: p, roles: this.groups.get(p)!.roles, attrs: this.groups.get(p)!.attrs })), users: [...this.users.values()] };
  }
}

export class Realms {
  private readonly realms = new Map<string, Realm>();
  create(o: RealmOptions): Realm {
    if (this.realms.has(o.name)) throw new RealmRefused(`realm ${o.name} already exists`);
    const r = new Realm(o);
    this.realms.set(o.name, r);
    return r;
  }
  get(name: string): Realm {
    const r = this.realms.get(name);
    if (!r) throw new RealmRefused(`no realm ${name}`);
    return r;
  }
  names(): string[] {
    return [...this.realms.keys()].sort();
  }
  remove(name: string): void {
    if (!this.realms.delete(name)) throw new RealmRefused(`no realm ${name}`);
  }
}
