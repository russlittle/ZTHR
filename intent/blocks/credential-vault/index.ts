/**
 * Credentials that connectors use to call other systems, kept so that a database leak, a log line or a shared
 * workspace does not hand them out. Holds: encrypted storage (each secret sealed with the crypto block, bound to
 * its credential id and owner so a sealed value copied onto another row does not open), the key ring read from the
 * config block's settings (with a setting declaration, and a refusal of test keys in production), and re-sealing
 * under a new key; typed credentials (API key, basic, bearer, OAuth 2, custom fields) with the fields each needs;
 * sharing with three levels (use: a connector can call with it but nobody sees it; view: the secret can be shown;
 * manage: change, share and delete), with expiry, no granting above your own level, and revocation; use scopes
 * (what a connector may do with it) and host allow-lists (where it may be sent), so a credential cannot be
 * pointed at an attacker's URL; OAuth 2 access tokens refreshed before they expire, one refresh in flight per
 * credential, rotating refresh tokens kept, invalid_grant marked as needing re-authorisation; rotation with a
 * grace window in which the previous secret still works, and a list of what is overdue; masked descriptions and
 * a redactor for logs; and an audit trail that records who used what and never a secret. Not here: the OAuth
 * authorisation-code redirect, a key management service, hardware tokens, and the HTTP client (injected).
 */
import { open, seal, type KeyRing } from '../crypto/index.ts';
import type { Setting, Values } from '../config/index.ts';

export class VaultError extends Error {
  readonly kind: 'denied' | 'missing' | 'invalid' | 'expired' | 'reauth' | 'host' | 'scope' | 'refresh';
  constructor(kind: VaultError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- keys from config

/** Settings the vault reads: "VAULT_KEYS" as id:base64key pairs, and which id seals new data. */
export const vaultSettings: readonly Setting[] = [
  { name: 'VAULT_KEYS', kind: 'list', description: 'Key ring entries as id:base64(32 bytes), comma separated', secret: true, required: true, usedBy: ['credential-vault'], rotateDays: 180, unsafeInProduction: (v) => (/(^|,)\s*(test|dev|demo)[\w-]*:/i.test(v) ? 'a test key id is in the vault key ring' : null) },
  { name: 'VAULT_CURRENT_KEY', kind: 'text', description: 'The id in VAULT_KEYS that seals new credentials', required: true, usedBy: ['credential-vault'] },
];

export function ringFromValues(v: Values): KeyRing {
  const raw = v.VAULT_KEYS;
  const current = v.VAULT_CURRENT_KEY;
  if (!Array.isArray(raw) || typeof current !== 'string') throw new VaultError('invalid', 'VAULT_KEYS and VAULT_CURRENT_KEY are needed');
  const keys: Record<string, string> = {};
  for (const e of raw as string[]) {
    const i = e.indexOf(':');
    const id = e.slice(0, i).trim();
    const k = e.slice(i + 1).trim();
    if (i < 1 || !/^[\w-]+$/.test(id)) throw new VaultError('invalid', 'a key ring entry must be id:base64key');
    if (Buffer.from(k, 'base64').length !== 32) throw new VaultError('invalid', `key ${id} is not 32 bytes`);
    keys[id] = k;
  }
  if (!Object.hasOwn(keys, current)) throw new VaultError('invalid', `the current key ${current} is not in the ring`);
  return { current, keys };
}

// ---------------------------------------------------------------- types

export type CredentialType = 'apiKey' | 'basic' | 'bearer' | 'oauth2' | 'custom';

/** The secret fields each type must carry; extra fields are refused. */
const FIELDS: Readonly<Record<Exclude<CredentialType, 'custom'>, { required: readonly string[]; optional: readonly string[] }>> = {
  apiKey: { required: ['key'], optional: [] },
  basic: { required: ['username', 'password'], optional: [] },
  bearer: { required: ['token'], optional: [] },
  oauth2: { required: ['clientId', 'clientSecret', 'tokenUrl'], optional: ['accessToken', 'refreshToken', 'expiresAt', 'scope'] },
};

export type Secret = Record<string, string | number>;
export type Level = 'use' | 'view' | 'manage';
const RANK: Readonly<Record<Level, number>> = { use: 1, view: 2, manage: 3 };

export interface Share {
  readonly to: string;
  readonly level: Level;
  readonly by: string;
  readonly expiresAt: number | null;
}

interface Row {
  id: string;
  name: string;
  type: CredentialType;
  owner: string;
  scopes: string[];
  hosts: string[];
  sealed: string;
  version: number;
  createdAt: number;
  rotatedAt: number;
  expiresAt: number | null;
  shares: Share[];
  previous: { sealed: string; until: number } | null;
  needsReauth: boolean;
  refreshFailures: number;
  refreshRetryAt: number;
  deleted: boolean;
}

export interface Described {
  readonly id: string;
  readonly name: string;
  readonly type: CredentialType;
  readonly owner: string;
  readonly scopes: readonly string[];
  readonly hosts: readonly string[];
  readonly version: number;
  readonly createdAt: number;
  readonly rotatedAt: number;
  readonly expiresAt: number | null;
  readonly needsReauth: boolean;
  /** Field names with a mask, never a value. */
  readonly fields: Readonly<Record<string, string>>;
  readonly level: Level;
}

export interface AuditEvent {
  readonly at: number;
  readonly actor: string;
  readonly credential: string;
  readonly action: 'create' | 'use' | 'reveal' | 'share' | 'unshare' | 'rotate' | 'refresh' | 'refresh-failed' | 'delete' | 'denied' | 'reseal' | 'update';
  readonly detail?: string;
}

export interface Group {
  /** Groups an actor belongs to; a share to "group:x" applies to its members. */
  readonly groupsOf: (actor: string) => readonly string[];
}

export interface VaultOptions {
  readonly ring: KeyRing;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly audit?: (e: AuditEvent) => void;
  readonly groups?: Group;
  /** Refresh this long before an access token expires, default 60 seconds. */
  readonly refreshSkewMs?: number;
  /** HTTP for token requests: POST a form, get status and JSON. Injected. */
  readonly http?: (url: string, form: Readonly<Record<string, string>>) => Promise<{ status: number; json: unknown }>;
}

const mask = (v: string | number): string => {
  const s = String(v);
  return s.length <= 8 ? '********' : `${'*'.repeat(8)}${s.slice(-2)}`;
};

const hostOf = (url: string): string => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new VaultError('host', 'credentials are only sent over https');
    return u.hostname.toLowerCase();
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError('host', 'not a URL');
  }
};

/** Whether a host matches an allow-list entry: exact, or "*.example.com" for subdomains (not the bare domain). */
export const hostAllowed = (host: string, allow: readonly string[]): boolean => allow.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host.length > a.length - 1 : host === a.toLowerCase()));

export class Vault {
  private readonly rows = new Map<string, Row>();
  private readonly o: VaultOptions;
  private readonly now: () => number;
  private seq = 0;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(o: VaultOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  private audit(actor: string, credential: string, action: AuditEvent['action'], detail?: string) {
    this.o.audit?.({ at: this.now(), actor, credential, action, ...(detail ? { detail } : {}) });
  }

  private ctx(r: { id: string; owner: string }, version: number) {
    return `vault:${r.owner}:${r.id}:v${version}`;
  }

  private validate(type: CredentialType, secret: Secret): void {
    if (type === 'custom') {
      if (!Object.keys(secret).length) throw new VaultError('invalid', 'a custom credential needs at least one field');
      return;
    }
    const f = FIELDS[type];
    for (const k of f.required) if (secret[k] === undefined || secret[k] === '') throw new VaultError('invalid', `${type} needs ${k}`);
    for (const k of Object.keys(secret)) if (!f.required.includes(k) && !f.optional.includes(k)) throw new VaultError('invalid', `${type} has no field ${k}`);
    if (type === 'oauth2') hostOf(String(secret.tokenUrl));
  }

  private seal(r: Row, secret: Secret, version = r.version): string {
    return seal(this.o.ring, JSON.stringify(secret), this.ctx(r, version));
  }

  private read(r: Row): Secret {
    return JSON.parse(open(this.o.ring, r.sealed, this.ctx(r, r.version))) as Secret;
  }

  create(owner: string, d: { name: string; type: CredentialType; secret: Secret; scopes?: readonly string[]; hosts?: readonly string[]; expiresAt?: number | null }): string {
    this.validate(d.type, d.secret);
    if (!d.name.trim()) throw new VaultError('invalid', 'a credential needs a name');
    for (const r of this.rows.values()) if (!r.deleted && r.owner === owner && r.name === d.name) throw new VaultError('invalid', `you already have a credential called ${d.name}`);
    for (const h of d.hosts ?? []) if (!/^(\*\.)?[a-z0-9.-]+$/i.test(h) || h === '*.') throw new VaultError('invalid', `bad host pattern ${h}`);
    const id = this.o.newId?.() ?? `cred_${(++this.seq).toString(36)}${Math.floor(this.now()).toString(36)}`;
    const t = this.now();
    const row: Row = { id, name: d.name, type: d.type, owner, scopes: [...(d.scopes ?? [])], hosts: (d.hosts ?? []).map((h) => h.toLowerCase()), sealed: '', version: 1, createdAt: t, rotatedAt: t, expiresAt: d.expiresAt ?? null, shares: [], previous: null, needsReauth: false, refreshFailures: 0, refreshRetryAt: 0, deleted: false };
    row.sealed = this.seal(row, d.secret);
    this.rows.set(id, row);
    this.audit(owner, id, 'create', d.type);
    return id;
  }

  private get(id: string): Row {
    const r = this.rows.get(id);
    if (!r || r.deleted) throw new VaultError('missing', 'no such credential');
    return r;
  }

  /** The level an actor has, or null: the owner manages; shares to the actor or to one of their groups apply. */
  levelOf(id: string, actor: string): Level | null {
    const r = this.rows.get(id);
    if (!r || r.deleted) return null;
    if (r.owner === actor) return 'manage';
    const t = this.now();
    const who = new Set([actor, ...(this.o.groups?.groupsOf(actor).map((g) => `group:${g}`) ?? [])]);
    let best: Level | null = null;
    for (const s of r.shares) if (who.has(s.to) && (s.expiresAt === null || s.expiresAt > t) && (best === null || RANK[s.level] > RANK[best])) best = s.level;
    return best;
  }

  private need(id: string, actor: string, level: Level): Row {
    const r = this.get(id);
    const have = this.levelOf(id, actor);
    if (have === null || RANK[have] < RANK[level]) {
      this.audit(actor, id, 'denied', level);
      // The same answer as for a missing credential, so ids cannot be probed.
      throw new VaultError(have === null ? 'missing' : 'denied', have === null ? 'no such credential' : `you may only ${have} this credential`);
    }
    return r;
  }

  describe(id: string, actor: string): Described {
    const r = this.need(id, actor, 'use');
    const level = this.levelOf(id, actor)!;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.read(r))) fields[k] = ['clientId', 'tokenUrl', 'username', 'scope', 'expiresAt'].includes(k) ? String(v) : mask(v);
    return { id: r.id, name: r.name, type: r.type, owner: r.owner, scopes: [...r.scopes], hosts: [...r.hosts], version: r.version, createdAt: r.createdAt, rotatedAt: r.rotatedAt, expiresAt: r.expiresAt, needsReauth: r.needsReauth, fields: level === 'use' ? Object.fromEntries(Object.keys(fields).map((k) => [k, '********'])) : fields, level };
  }

  /** What an actor can see: credentials they own or that are shared with them (use level and up). */
  list(actor: string): Described[] {
    return [...this.rows.values()].filter((r) => !r.deleted && this.levelOf(r.id, actor) !== null).map((r) => this.describe(r.id, actor)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Shows the secret. Needs view. */
  reveal(id: string, actor: string): Secret {
    const r = this.need(id, actor, 'view');
    this.audit(actor, id, 'reveal');
    return this.read(r);
  }

  share(id: string, by: string, to: string, level: Level, expiresAt: number | null = null): void {
    const r = this.need(id, by, 'manage');
    if (to === r.owner) throw new VaultError('invalid', 'the owner already has full access');
    if (!/^(group:)?[\w.@-]+$/.test(to)) throw new VaultError('invalid', 'bad share target');
    if (expiresAt !== null && expiresAt <= this.now()) throw new VaultError('invalid', 'the share would already be expired');
    if (r.expiresAt !== null && r.expiresAt <= this.now()) throw new VaultError('expired', 'the credential itself has expired');
    if (RANK[level] > RANK[this.levelOf(id, by)!]) throw new VaultError('denied', 'you cannot grant more than you have');
    if (level === 'manage' && by !== r.owner) throw new VaultError('denied', 'only the owner can grant manage');
    r.shares = r.shares.filter((s) => s.to !== to);
    r.shares.push({ to, level, by, expiresAt });
    this.audit(by, id, 'share', `${to}:${level}`);
  }

  unshare(id: string, by: string, to: string): boolean {
    const r = this.need(id, by, 'manage');
    const n = r.shares.length;
    r.shares = r.shares.filter((s) => s.to !== to);
    if (r.shares.length !== n) this.audit(by, id, 'unshare', to);
    return r.shares.length !== n;
  }

  shares(id: string, actor: string): Share[] {
    return [...this.need(id, actor, 'manage').shares];
  }

  /** The actor's own copy goes away when they leave a share; the owner removes shares with unshare. */
  delete(id: string, actor: string): void {
    const r = this.need(id, actor, 'manage');
    if (r.owner !== actor) throw new VaultError('denied', 'only the owner can delete');
    r.deleted = true;
    r.sealed = '';
    r.previous = null;
    this.audit(actor, id, 'delete');
  }

  private checkUse(r: Row, actor: string, u: { scope?: string; url?: string }): void {
    if (r.expiresAt !== null && r.expiresAt <= this.now()) throw new VaultError('expired', 'the credential has expired');
    if (r.needsReauth) throw new VaultError('reauth', 'the connection must be authorised again');
    if (u.scope !== undefined && r.scopes.length && !r.scopes.includes(u.scope)) {
      this.audit(actor, r.id, 'denied', `scope ${u.scope}`);
      throw new VaultError('scope', `this credential is not allowed for ${u.scope}`);
    }
    if (u.url !== undefined && r.hosts.length) {
      const h = hostOf(u.url);
      if (!hostAllowed(h, r.hosts)) {
        this.audit(actor, r.id, 'denied', `host ${h}`);
        throw new VaultError('host', `this credential may not be sent to ${h}`);
      }
    }
  }

  /** The Authorization (or X-Api-Key style) headers for a call, checked against scope and host. The secret never leaves except in these. */
  async headersFor(id: string, actor: string, u: { scope?: string; url: string; apiKeyHeader?: string }): Promise<Record<string, string>> {
    const r = this.need(id, actor, 'use');
    this.checkUse(r, actor, u);
    let out: Record<string, string>;
    if (r.type === 'oauth2') out = { Authorization: `Bearer ${await this.accessToken(id, actor)}` };
    else {
      const s = this.secretFor(r);
      if (r.type === 'bearer') out = { Authorization: `Bearer ${s.token}` };
      else if (r.type === 'basic') out = { Authorization: `Basic ${Buffer.from(`${s.username}:${s.password}`).toString('base64')}` };
      else if (r.type === 'apiKey') out = { [u.apiKeyHeader ?? 'X-Api-Key']: String(s.key) };
      else throw new VaultError('invalid', 'a custom credential has no standard headers; use fieldsFor');
    }
    this.audit(actor, id, 'use', `${u.scope ?? '-'} ${hostOf(u.url)}`);
    return out;
  }

  /** Named fields of a custom credential for a connector that builds its own request, with the same checks. */
  fieldsFor(id: string, actor: string, names: readonly string[], u: { scope?: string; url: string }): Record<string, string> {
    const r = this.need(id, actor, 'use');
    this.checkUse(r, actor, u);
    const s = this.secretFor(r);
    const out: Record<string, string> = {};
    for (const n of names) {
      if (s[n] === undefined) throw new VaultError('invalid', `no field ${n}`);
      out[n] = String(s[n]);
    }
    this.audit(actor, id, 'use', `${u.scope ?? '-'} ${hostOf(u.url)}`);
    return out;
  }

  /** The current secret, or the previous one while its grace window is open. */
  private secretFor(r: Row): Secret {
    return this.read(r);
  }

  /** Whether a presented secret value is still accepted for a credential (the current one, or the previous in grace). */
  accepts(id: string, actor: string, field: string, value: string): boolean {
    const r = this.need(id, actor, 'manage');
    const cur = this.read(r)[field];
    if (cur !== undefined && String(cur) === value) return true;
    if (r.previous && r.previous.until > this.now()) {
      const old = JSON.parse(open(this.o.ring, r.previous.sealed, this.ctx(r, r.version - 1))) as Secret;
      return old[field] !== undefined && String(old[field]) === value;
    }
    return false;
  }

  // ------------------------------------------------------------ OAuth

  /** A valid access token for an OAuth 2 credential, refreshed when it is near expiry. One refresh runs at a time. */
  async accessToken(id: string, actor: string): Promise<string> {
    const r = this.need(id, actor, 'use');
    if (r.type !== 'oauth2') throw new VaultError('invalid', 'not an OAuth 2 credential');
    this.checkUse(r, actor, {});
    const s = this.read(r);
    const skew = this.o.refreshSkewMs ?? 60_000;
    if (typeof s.accessToken === 'string' && s.accessToken && (s.expiresAt === undefined || Number(s.expiresAt) - skew > this.now())) return s.accessToken;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.refresh(r, actor).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async refresh(r: Row, actor: string): Promise<string> {
    const t = this.now();
    if (r.refreshRetryAt > t) throw new VaultError('refresh', `the last refresh failed; trying again after ${new Date(r.refreshRetryAt).toISOString()}`);
    const http = this.o.http;
    if (!http) throw new VaultError('refresh', 'no HTTP client is configured for token requests');
    const s = this.read(r);
    const form: Record<string, string> = typeof s.refreshToken === 'string' && s.refreshToken ? { grant_type: 'refresh_token', refresh_token: s.refreshToken } : { grant_type: 'client_credentials' };
    form.client_id = String(s.clientId);
    form.client_secret = String(s.clientSecret);
    if (typeof s.scope === 'string' && s.scope && form.grant_type === 'client_credentials') form.scope = s.scope;
    let res: { status: number; json: unknown };
    try {
      res = await http(String(s.tokenUrl), form);
    } catch (e) {
      return this.refreshFailed(r, actor, `network: ${(e as Error).message}`);
    }
    const j = (res.json ?? {}) as Record<string, unknown>;
    if (res.status >= 200 && res.status < 300 && typeof j.access_token === 'string' && j.access_token) {
      const next: Secret = { ...s, accessToken: j.access_token };
      if (typeof j.expires_in === 'number' && j.expires_in > 0) next.expiresAt = this.now() + j.expires_in * 1000;
      else delete next.expiresAt;
      if (typeof j.refresh_token === 'string' && j.refresh_token) next.refreshToken = j.refresh_token;
      if (typeof j.scope === 'string') next.scope = j.scope;
      r.sealed = this.seal(r, next);
      r.refreshFailures = 0;
      r.refreshRetryAt = 0;
      this.audit(actor, r.id, 'refresh');
      return j.access_token;
    }
    if (res.status === 400 || res.status === 401) {
      const err = typeof j.error === 'string' ? j.error : '';
      if (err === 'invalid_grant' || err === 'invalid_client' || err === 'unauthorized_client') {
        r.needsReauth = true;
        this.audit(actor, r.id, 'refresh-failed', err);
        throw new VaultError('reauth', `the provider rejected the refresh (${err}); the connection must be authorised again`);
      }
    }
    return this.refreshFailed(r, actor, `status ${res.status}`);
  }

  private refreshFailed(r: Row, actor: string, why: string): never {
    r.refreshFailures++;
    r.refreshRetryAt = this.now() + Math.min(15 * 60_000, 5_000 * 2 ** (r.refreshFailures - 1));
    this.audit(actor, r.id, 'refresh-failed', why);
    throw new VaultError('refresh', `could not refresh the token (${why})`);
  }

  /** After a user authorises again: stores the new tokens and clears the flag. */
  reauthorize(id: string, actor: string, tokens: { accessToken: string; refreshToken?: string; expiresAt?: number }): void {
    const r = this.need(id, actor, 'manage');
    if (r.type !== 'oauth2') throw new VaultError('invalid', 'not an OAuth 2 credential');
    const s = this.read(r);
    const next: Secret = { ...s, accessToken: tokens.accessToken };
    if (tokens.refreshToken) next.refreshToken = tokens.refreshToken;
    if (tokens.expiresAt !== undefined) next.expiresAt = tokens.expiresAt;
    else delete next.expiresAt;
    r.sealed = this.seal(r, next);
    r.needsReauth = false;
    r.refreshFailures = 0;
    r.refreshRetryAt = 0;
    this.audit(actor, id, 'update', 'reauthorized');
  }

  // ------------------------------------------------------------ rotation

  /** Replaces the secret. The previous one is still accepted by `accepts` for `graceMs`, so a rollout can finish. */
  rotate(id: string, actor: string, secret: Secret, o: { graceMs?: number } = {}): number {
    const r = this.need(id, actor, 'manage');
    this.validate(r.type, secret);
    const oldSealed = r.sealed;
    const grace = o.graceMs ?? 0;
    r.version++;
    r.sealed = this.seal(r, secret);
    r.rotatedAt = this.now();
    r.needsReauth = false;
    // The previous value is re-sealed under the old version's context so `accepts` can read it.
    r.previous = grace > 0 ? { sealed: seal(this.o.ring, open(this.o.ring, oldSealed, this.ctx(r, r.version - 1)), this.ctx(r, r.version - 1)), until: this.now() + grace } : null;
    this.audit(actor, id, 'rotate', `v${r.version}`);
    return r.version;
  }

  /** Credentials not rotated within maxAgeDays, or expired, or needing re-authorisation, for the owner's attention. */
  due(actor: string, maxAgeDays: number): { id: string; name: string; reason: string }[] {
    const t = this.now();
    const out: { id: string; name: string; reason: string }[] = [];
    for (const r of this.rows.values()) {
      if (r.deleted || this.levelOf(r.id, actor) !== 'manage') continue;
      if (r.expiresAt !== null && r.expiresAt <= t) out.push({ id: r.id, name: r.name, reason: 'expired' });
      else if (r.needsReauth) out.push({ id: r.id, name: r.name, reason: 'needs re-authorisation' });
      else if (t - r.rotatedAt > maxAgeDays * 86_400_000) out.push({ id: r.id, name: r.name, reason: `not rotated for ${Math.floor((t - r.rotatedAt) / 86_400_000)} days` });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Re-seals everything under the ring's current key (after the key ring changes). Returns how many were rewritten. */
  resealAll(actor = 'system'): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.deleted) continue;
      if (r.sealed.split('.')[1] !== this.o.ring.current) {
        r.sealed = seal(this.o.ring, open(this.o.ring, r.sealed, this.ctx(r, r.version)), this.ctx(r, r.version));
        n++;
      }
      if (r.previous && r.previous.sealed.split('.')[1] !== this.o.ring.current) r.previous = { ...r.previous, sealed: seal(this.o.ring, open(this.o.ring, r.previous.sealed, this.ctx(r, r.version - 1)), this.ctx(r, r.version - 1)) };
    }
    if (n) this.audit(actor, '*', 'reseal', String(n));
    return n;
  }

  /** What is stored for a credential, to show a leak does not contain the secret (for tests and diagnostics). */
  rawFor(id: string): string {
    return JSON.stringify(this.rows.get(id) ?? null);
  }

  /** Every secret value an actor manages, for the redactor. */
  private valuesOf(actor: string): string[] {
    const out: string[] = [];
    for (const r of this.rows.values()) {
      if (r.deleted || this.levelOf(r.id, actor) === null) continue;
      for (const [k, v] of Object.entries(this.read(r))) if (!['clientId', 'tokenUrl', 'username', 'scope', 'expiresAt'].includes(k)) out.push(String(v));
    }
    return out.filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  }

  /** Text with every secret the actor can use replaced, for logs and error messages. */
  redact(actor: string, text: string): string {
    let out = text;
    for (const v of this.valuesOf(actor)) {
      out = out.split(v).join('[redacted]');
      out = out.split(Buffer.from(v).toString('base64')).join('[redacted]');
      out = out.split(encodeURIComponent(v)).join('[redacted]');
    }
    return out;
  }
}
