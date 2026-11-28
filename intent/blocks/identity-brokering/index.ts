/**
 * Social and enterprise sign-in turned into local accounts, safely. After an upstream login has been verified (the
 * oidc block checks the token), this block decides what it means here: whose account it is, whether to link it to an
 * existing account, whether to create one on the spot (just-in-time provisioning), and what roles it carries. The
 * rules exist to stop account takeover. An upstream email is believed only as far as the provider is trusted:
 * "none" never, "verified-email" when the provider says it verified the address, "authoritative" for the email
 * domains the provider speaks for (a company's own identity provider). Accounts are never linked on an unverified
 * email; when a verified upstream email meets a local account whose email was never verified, only an authoritative
 * provider may link, and then the account's other credentials are reset (the classic "pre-hijack": an attacker
 * registers the victim's address first and waits); any other case needs the person to sign in to the existing
 * account first (a single-use, expiring pending link). The issuer must match the provider's configured issuer (the
 * mix-up attack), subjects are keyed by provider and subject, never by email, claims map through a declared mapping,
 * roles come only from a grantable list so an upstream group cannot mint "owner", usernames are made unique, an
 * account that would be left with no way to sign in cannot be unlinked, and every outcome says what happened and why
 * for the audit log. Out of scope: verifying tokens or SAML assertions (oidc and the saml work), password and MFA
 * handling (accounts, sessions), and persistence beyond the in-memory store that implements the store interface.
 */

export class BrokeringError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Trust = 'none' | 'verified-email' | 'authoritative';

export interface RoleMapping {
  /** An upstream group name; a trailing * matches a prefix. */
  readonly group: string;
  readonly role: string;
}

export interface ProviderConfig {
  readonly id: string;
  readonly kind: 'social' | 'enterprise';
  /** The issuer the provider's tokens carry; a login claiming another issuer is refused. */
  readonly issuer: string;
  readonly trust: Trust;
  /** Email domains the provider may assert. For "authoritative" these are the domains it speaks for; for others they restrict who may sign in. */
  readonly domains?: readonly string[];
  /** Claim names, with dots for nesting. Defaults: sub, email, email_verified, name, preferred_username, groups. */
  readonly mapping?: { readonly subject?: string; readonly email?: string; readonly emailVerified?: string; readonly name?: string; readonly username?: string; readonly groups?: string };
  /** "create" provisions an account at first sign-in; "deny" only lets existing accounts link. Default "deny". */
  readonly jit?: 'create' | 'deny';
  /** Whether JIT needs a verified email. Default true. */
  readonly requireVerifiedEmail?: boolean;
  /** "import" copies name and roles at first sign-in only; "force" refreshes them at every sign-in. Default "import". */
  readonly sync?: 'import' | 'force';
  readonly roles?: { readonly defaults?: readonly string[]; readonly grantable?: readonly string[]; readonly mappings?: readonly RoleMapping[] };
  readonly disabled?: boolean;
}

export interface ExternalLogin {
  readonly provider: string;
  /** The issuer the verified token carried. */
  readonly issuer: string;
  /** The verified claims. */
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface Account {
  readonly id: string;
  email?: string;
  emailVerified: boolean;
  username: string;
  displayName?: string;
  roles: string[];
  disabled: boolean;
  /** Whether the person can sign in with a local password or key of their own. */
  hasLocalCredential: boolean;
  /** Set when credentials were reset because an authoritative provider took over an unverified account. */
  credentialsResetAt?: number;
  createdAt: number;
}

export interface Link {
  readonly provider: string;
  readonly subject: string;
  readonly accountId: string;
  readonly linkedAt: number;
  lastLoginAt: number;
}

export interface Pending {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly subject: string;
  readonly expiresAt: number;
}

export interface AccountStore {
  findLink(provider: string, subject: string): Link | undefined;
  linksOf(accountId: string): Link[];
  findByEmail(email: string): Account | undefined;
  findByUsername(username: string): Account | undefined;
  get(id: string): Account | undefined;
  add(account: Account): void;
  addLink(link: Link): void;
  removeLink(provider: string, subject: string): void;
  putPending(p: Pending): void;
  takePending(id: string): Pending | undefined;
}

export class MemoryAccountStore implements AccountStore {
  readonly accounts = new Map<string, Account>();
  readonly links = new Map<string, Link>();
  readonly pending = new Map<string, Pending>();
  findLink(provider: string, subject: string): Link | undefined { return this.links.get(`${provider}\u0000${subject}`); }
  linksOf(accountId: string): Link[] { return [...this.links.values()].filter((l) => l.accountId === accountId); }
  findByEmail(email: string): Account | undefined { return [...this.accounts.values()].find((a) => a.email === email); }
  findByUsername(username: string): Account | undefined { return [...this.accounts.values()].find((a) => a.username === username); }
  get(id: string): Account | undefined { return this.accounts.get(id); }
  add(account: Account): void { this.accounts.set(account.id, account); }
  addLink(link: Link): void { this.links.set(`${link.provider}\u0000${link.subject}`, link); }
  removeLink(provider: string, subject: string): void { this.links.delete(`${provider}\u0000${subject}`); }
  putPending(p: Pending): void { this.pending.set(p.id, p); }
  takePending(id: string): Pending | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return p;
  }
}

export type DenyReason = 'provider-unknown' | 'provider-disabled' | 'issuer-mismatch' | 'no-subject' | 'domain-not-allowed' | 'account-disabled' | 'jit-disabled' | 'email-unverified' | 'invalid-email';

export type Outcome =
  | { readonly kind: 'signed-in'; readonly account: Account; readonly events: readonly string[] }
  | { readonly kind: 'created'; readonly account: Account; readonly events: readonly string[] }
  | { readonly kind: 'linked'; readonly account: Account; readonly credentialsReset: boolean; readonly events: readonly string[] }
  | { readonly kind: 'challenge-required'; readonly reason: 'local-email-unverified' | 'provider-email-unverified'; readonly pending: Pending; readonly events: readonly string[] }
  | { readonly kind: 'denied'; readonly reason: DenyReason; readonly message: string; readonly events: readonly string[] };

export interface BrokerOptions {
  readonly providers: readonly ProviderConfig[];
  readonly store?: AccountStore;
  readonly now: () => number;
  /** Makes ids for new accounts and pending links; pass a random source in production. */
  readonly newId: () => string;
  /** How long a pending link may be completed. Default 10 minutes. */
  readonly pendingTtlMs?: number;
}

const MAX_GROUPS = 200;
const EMAIL = /^[^\s@<>()[\],;:"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

function pick(claims: Readonly<Record<string, unknown>>, path: string): unknown {
  let cur: unknown = claims;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : undefined);

/** Lower-cased, trimmed email, or undefined when it is not an address. */
export function normalizeEmail(raw: unknown): string | undefined {
  const s = text(raw, 320)?.toLowerCase();
  return s && EMAIL.test(s) ? s : undefined;
}

/** A login name from an upstream value: lower case, letters, digits, dot, dash and underscore. */
export function usernameFrom(raw: string): string {
  const base = raw.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 32);
  return base.length >= 2 ? base : 'user';
}

/** The roles an upstream login earns under a provider's rules: its defaults, plus mapped groups, never beyond the grantable list. */
export function mapRoles(cfg: ProviderConfig, claims: Readonly<Record<string, unknown>>): string[] {
  const roles = new Set(cfg.roles?.defaults ?? []);
  const raw = pick(claims, cfg.mapping?.groups ?? 'groups');
  const groups = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((g): g is string => typeof g === 'string').slice(0, MAX_GROUPS);
  for (const m of cfg.roles?.mappings ?? []) {
    const hit = m.group.endsWith('*') ? groups.some((g) => g.startsWith(m.group.slice(0, -1))) : groups.includes(m.group);
    if (hit) roles.add(m.role);
  }
  const grantable = cfg.roles?.grantable;
  return [...roles].filter((r) => (cfg.roles?.defaults ?? []).includes(r) || (grantable ?? []).includes(r)).sort();
}

export class Broker {
  readonly store: AccountStore;
  private readonly providers: Map<string, ProviderConfig>;
  private readonly o: BrokerOptions;

  constructor(o: BrokerOptions) {
    this.o = o;
    this.store = o.store ?? new MemoryAccountStore();
    this.providers = new Map();
    for (const p of o.providers) {
      if (this.providers.has(p.id)) throw new BrokeringError(`two providers are called "${p.id}"`);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new BrokeringError(`"${p.id}" is not a usable provider id`);
      if (!/^https:\/\//.test(p.issuer) && !/^https?:\/\/localhost(:\d+)?(\/|$)/.test(p.issuer)) throw new BrokeringError(`the issuer of "${p.id}" must be an https URL`);
      if (p.trust === 'authoritative' && !p.domains?.length) throw new BrokeringError(`"${p.id}" is authoritative but lists no domains it speaks for`);
      this.providers.set(p.id, p);
    }
  }

  private deny(reason: DenyReason, message: string, ev: string[]): Outcome {
    ev.push(`denied:${reason}`);
    return { kind: 'denied', reason, message, events: ev };
  }

  /** Decides what a verified upstream login means. */
  login(login: ExternalLogin): Outcome {
    const ev: string[] = [];
    const cfg = this.providers.get(login.provider);
    if (!cfg) return this.deny('provider-unknown', `no provider "${login.provider}" is configured`, ev);
    if (cfg.disabled) return this.deny('provider-disabled', `${cfg.id} sign-in is switched off`, ev);
    if (login.issuer !== cfg.issuer) return this.deny('issuer-mismatch', `the token was issued by ${login.issuer}, not by ${cfg.id}`, ev);
    const m = cfg.mapping ?? {};
    const rawSub = pick(login.claims, m.subject ?? 'sub');
    const subject = typeof rawSub === 'number' && Number.isSafeInteger(rawSub) ? String(rawSub) : text(rawSub, 255);
    if (!subject) return this.deny('no-subject', 'the login has no subject', ev);
    const rawEmail = pick(login.claims, m.email ?? 'email');
    const email = normalizeEmail(rawEmail);
    if (rawEmail !== undefined && rawEmail !== null && rawEmail !== '' && !email) return this.deny('invalid-email', 'the email address in the login is not valid', ev);
    const domain = email?.split('@')[1];
    const flag = pick(login.claims, m.emailVerified ?? 'email_verified');
    const claimedVerified = flag === true || flag === 'true';
    const spoken = domain !== undefined && (cfg.domains ?? []).some((d) => d.toLowerCase() === domain);
    if (cfg.domains?.length && email !== undefined && !spoken) return this.deny('domain-not-allowed', `${domain} is not a domain ${cfg.id} may sign in`, ev);
    const verified = !!email && ((cfg.trust === 'authoritative' && spoken) || (cfg.trust === 'verified-email' && claimedVerified));
    ev.push(email ? `email:${verified ? 'verified' : 'unverified'}` : 'email:none');
    const name = text(pick(login.claims, m.name ?? 'name'), 200);
    const now = this.o.now();
    // 1. A known link: the same person again.
    const link = this.store.findLink(cfg.id, subject);
    if (link) {
      const account = this.store.get(link.accountId)!;
      if (account.disabled) return this.deny('account-disabled', 'this account is disabled', ev);
      link.lastLoginAt = now;
      if (cfg.sync === 'force') {
        if (name) account.displayName = name;
        account.roles = [...new Set([...account.roles.filter((r) => !(cfg.roles?.grantable ?? []).includes(r)), ...mapRoles(cfg, login.claims)])].sort();
        ev.push('synced');
      }
      ev.push('signed-in:link');
      return { kind: 'signed-in', account, events: ev };
    }
    if (cfg.domains?.length && email === undefined && (cfg.trust === 'authoritative' || cfg.kind === 'enterprise')) return this.deny('domain-not-allowed', `a first sign-in through ${cfg.id} needs an email in one of its domains`, ev);
    // 2. An existing account with this email.
    const existing = email ? this.store.findByEmail(email) : undefined;
    if (existing) {
      if (existing.disabled) return this.deny('account-disabled', 'this account is disabled', ev);
      if (verified && existing.emailVerified) {
        this.store.addLink({ provider: cfg.id, subject, accountId: existing.id, linkedAt: now, lastLoginAt: now });
        ev.push('linked:verified-email');
        return { kind: 'linked', account: existing, credentialsReset: false, events: ev };
      }
      if (verified && cfg.trust === 'authoritative') {
        existing.emailVerified = true;
        existing.hasLocalCredential = false;
        existing.credentialsResetAt = now;
        this.store.addLink({ provider: cfg.id, subject, accountId: existing.id, linkedAt: now, lastLoginAt: now });
        ev.push('linked:authoritative', 'credentials-reset');
        return { kind: 'linked', account: existing, credentialsReset: true, events: ev };
      }
      const reason = verified ? 'local-email-unverified' : 'provider-email-unverified';
      const pending: Pending = { id: this.o.newId(), accountId: existing.id, provider: cfg.id, subject, expiresAt: now + (this.o.pendingTtlMs ?? 600_000) };
      this.store.putPending(pending);
      ev.push(`challenge:${reason}`);
      return { kind: 'challenge-required', reason, pending, events: ev };
    }
    // 3. Nobody yet: provision.
    if ((cfg.jit ?? 'deny') !== 'create') return this.deny('jit-disabled', `${cfg.id} may only be used by people who already have an account`, ev);
    if ((cfg.requireVerifiedEmail ?? true) && !verified) return this.deny('email-unverified', 'a verified email address is needed to create an account', ev);
    let username = usernameFrom(text(pick(login.claims, m.username ?? 'preferred_username'), 100) ?? email ?? subject);
    for (let n = 2; this.store.findByUsername(username); n++) username = `${usernameFrom(username).slice(0, 28)}-${n}`;
    const account: Account = { id: this.o.newId(), ...(email ? { email } : {}), emailVerified: verified, username, ...(name ? { displayName: name } : {}), roles: mapRoles(cfg, login.claims), disabled: false, hasLocalCredential: false, createdAt: now };
    this.store.add(account);
    this.store.addLink({ provider: cfg.id, subject, accountId: account.id, linkedAt: now, lastLoginAt: now });
    ev.push('created:jit');
    return { kind: 'created', account, events: ev };
  }

  /** Finishes a pending link after the person has signed in to the existing account by its own method. Single use. */
  completeLink(pendingId: string, authenticatedAccountId: string): Outcome {
    const p = this.store.takePending(pendingId);
    const ev: string[] = [];
    if (!p) throw new BrokeringError('there is no such pending link, or it was already used');
    const now = this.o.now();
    if (now >= p.expiresAt) throw new BrokeringError('the pending link has expired; sign in with the provider again');
    if (p.accountId !== authenticatedAccountId) throw new BrokeringError('the pending link belongs to a different account');
    const account = this.store.get(p.accountId);
    if (!account || account.disabled) return this.deny('account-disabled', 'this account is disabled', ev);
    if (this.store.findLink(p.provider, p.subject)) throw new BrokeringError('that provider identity is already linked');
    this.store.addLink({ provider: p.provider, subject: p.subject, accountId: account.id, linkedAt: now, lastLoginAt: now });
    ev.push('linked:challenge-completed');
    return { kind: 'linked', account, credentialsReset: false, events: ev };
  }

  /** Removes a link, unless that would leave the account with no way to sign in. */
  unlink(accountId: string, provider: string): void {
    const account = this.store.get(accountId);
    if (!account) throw new BrokeringError('no such account');
    const links = this.store.linksOf(accountId);
    const mine = links.find((l) => l.provider === provider);
    if (!mine) throw new BrokeringError(`${provider} is not linked to this account`);
    if (links.length === 1 && !account.hasLocalCredential) throw new BrokeringError('this is the only way to sign in to the account; add a password or another provider first');
    this.store.removeLink(mine.provider, mine.subject);
  }
}
