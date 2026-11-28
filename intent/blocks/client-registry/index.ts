/**
 * OAuth 2.0 and OpenID Connect clients: the records an authorization server keeps about each app that may ask for
 * tokens. Redirect URIs are matched exactly as strings (RFC 9700 section 4.1, OAuth 2.1), with the one published
 * exception for native apps: a loopback IP literal on http may use any port (RFC 8252 section 7.3). Registered
 * redirects are refused when they carry a fragment, credentials or a wildcard, use plain http off loopback, or use
 * a script-bearing scheme. Client secrets are random, shown once, kept only as SHA-256 hashes, compared in constant
 * time, and rotated with an overlap so a deployed app keeps working while it moves to the new one. Dynamic client
 * registration follows RFC 7591 (metadata in, client information or an RFC 7591 error out), with the registration
 * access token of RFC 7592 for reading, updating and deleting a client afterwards.
 *
 * Not here: private_key_jwt and mTLS client authentication, software statements (refused with
 * invalid_software_statement), and storage beyond the in-memory map.
 */
import { createHash } from 'node:crypto';
import { equal } from '../crypto/index.ts';

export type ClientErrorCode =
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'invalid_software_statement'
  | 'invalid_client'
  | 'unknown_client'
  | 'forbidden';

/** An RFC 7591 section 3.2.2 style error: a code and a plain description. */
export class ClientError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode, description: string) {
    super(description);
    this.code = code;
  }
  /** The JSON body an endpoint answers with. */
  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

export type AuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';
export type AppType = 'web' | 'native';

export const GRANT_AUTHORIZATION_CODE = 'authorization_code';
export const GRANT_REFRESH = 'refresh_token';
export const GRANT_CLIENT_CREDENTIALS = 'client_credentials';
export const GRANT_DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';
export const GRANT_IMPLICIT = 'implicit';

export interface SecretRecord {
  readonly id: string;
  /** SHA-256 of the secret, hex. The secret itself is never kept. */
  readonly hash: string;
  readonly createdAt: number;
  /** After this instant the secret no longer authenticates; undefined is never. */
  expiresAt?: number;
}

export interface ClientRecord {
  readonly clientId: string;
  readonly name: string;
  readonly applicationType: AppType;
  readonly authMethod: AuthMethod;
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly string[];
  readonly responseTypes: readonly string[];
  readonly scopes: readonly string[];
  readonly secrets: readonly SecretRecord[];
  readonly createdAt: number;
  readonly contacts: readonly string[];
  readonly clientUri?: string;
  readonly logoUri?: string;
  readonly tosUri?: string;
  readonly policyUri?: string;
  readonly softwareId?: string;
  readonly softwareVersion?: string;
  /** The first-party flag: consent screens may be skipped for these. */
  readonly trusted: boolean;
  readonly registrationTokenHash?: string;
  readonly disabled: boolean;
}

export interface Policy {
  readonly allowedGrantTypes: readonly string[];
  /** Scopes dynamic registration may ask for; a client asking for none gets `defaultScopes`. */
  readonly allowedScopes: readonly string[];
  readonly defaultScopes: readonly string[];
  readonly allowLocalhostHost: boolean;
  readonly maxRedirectUris: number;
  /** How long a generated secret lives; undefined is forever. */
  readonly secretTtlMs?: number;
  /** Whether /register may be called without an initial access token. */
  readonly openRegistration: boolean;
}

export const DEFAULT_POLICY: Policy = {
  allowedGrantTypes: [GRANT_AUTHORIZATION_CODE, GRANT_REFRESH, GRANT_CLIENT_CREDENTIALS, GRANT_DEVICE],
  allowedScopes: ['openid', 'profile', 'email', 'offline_access'],
  defaultScopes: ['openid'],
  allowLocalhostHost: false,
  maxRedirectUris: 10,
  openRegistration: false,
};

// ---------------------------------------------------------------- redirect URIs

const DANGEROUS_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'about', 'blob', 'ftp', 'ws', 'wss']);

const isLoopbackIp = (host: string) => /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]';

/** Throws ClientError(invalid_redirect_uri) with the reason when a redirect URI could not safely be registered. */
export function checkRedirectUri(uri: unknown, appType: AppType = 'web', o: { allowLocalhostHost?: boolean } = {}): string {
  if (typeof uri !== 'string' || uri === '') throw new ClientError('invalid_redirect_uri', 'a redirect URI must be a non-empty string');
  if (uri.length > 2048) throw new ClientError('invalid_redirect_uri', 'a redirect URI may not be longer than 2048 characters');
  if (/[\s\u0000-\u001f\u007f]/.test(uri)) throw new ClientError('invalid_redirect_uri', 'a redirect URI may not contain spaces or control characters');
  if (uri.includes('#')) throw new ClientError('invalid_redirect_uri', 'a redirect URI may not contain a fragment');
  if (uri.includes('*')) throw new ClientError('invalid_redirect_uri', 'a redirect URI may not contain a wildcard; every redirect is registered exactly');
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ClientError('invalid_redirect_uri', 'a redirect URI must be an absolute URI');
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) throw new ClientError('invalid_redirect_uri', `the ${scheme}: scheme cannot be a redirect`);
  if (u.username || u.password) throw new ClientError('invalid_redirect_uri', 'a redirect URI may not carry a user name or password');
  if (scheme === 'https') {
    if (!u.hostname) throw new ClientError('invalid_redirect_uri', 'a redirect URI needs a host');
    return uri;
  }
  if (scheme === 'http') {
    if (isLoopbackIp(u.hostname)) return uri;
    if (u.hostname === 'localhost' && o.allowLocalhostHost) return uri;
    throw new ClientError('invalid_redirect_uri', 'plain http is allowed only for a loopback address such as 127.0.0.1 or [::1]');
  }
  // A private-use scheme for a native app: reverse domain name, per RFC 8252 section 7.1.
  if (appType !== 'native') throw new ClientError('invalid_redirect_uri', `${scheme}: redirects are for native apps; a web app uses https`);
  if (!scheme.includes('.')) throw new ClientError('invalid_redirect_uri', 'a private-use scheme must be a reverse domain name such as com.example.app');
  return uri;
}

/**
 * Whether a requested redirect equals a registered one. Exact string comparison; the only leniency is the port
 * of an http loopback IP address (RFC 8252 section 7.3), since a native app picks a free port at run time.
 */
export function matchRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol !== 'http:' || !isLoopbackIp(r.hostname) || requested.includes('#')) return false;
  return registered.some((reg) => {
    let g: URL;
    try {
      g = new URL(reg);
    } catch {
      return false;
    }
    return g.protocol === 'http:' && isLoopbackIp(g.hostname) && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
  });
}

// ---------------------------------------------------------------- secrets and header parsing

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Client credentials from an HTTP Basic header (RFC 6749 section 2.3.1: both parts are form-urlencoded first). */
export function parseBasicAuthorization(header: string | undefined): { clientId: string; secret: string } | undefined {
  const m = /^Basic ([A-Za-z0-9+/=_-]+)$/i.exec(header ?? '');
  if (!m) return undefined;
  const text = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = text.indexOf(':');
  if (i < 0) return undefined;
  try {
    const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    return { clientId: dec(text.slice(0, i)), secret: dec(text.slice(i + 1)) };
  } catch {
    return undefined;
  }
}

export interface RegistryOptions {
  readonly now?: () => number;
  /** Source of randomness: `n` random bytes. Injected so tests are deterministic. */
  readonly randomBytes: (n: number) => Uint8Array;
  readonly policy?: Partial<Policy>;
  /** Public base URL of the registration endpoint, for registration_client_uri. */
  readonly registrationEndpoint?: string;
}

export interface NewSecret {
  readonly secret: string;
  readonly id: string;
  readonly expiresAt: number | undefined;
}

/** What RFC 7591 section 3.2.1 sends back. */
export interface RegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  registration_access_token: string;
  registration_client_uri?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: AuthMethod;
  client_name: string;
  scope: string;
  application_type: AppType;
  [k: string]: unknown;
}

const AUTH_METHODS: readonly string[] = ['client_secret_basic', 'client_secret_post', 'none'];
const KNOWN_FIELDS = new Set([
  'redirect_uris', 'token_endpoint_auth_method', 'grant_types', 'response_types', 'client_name', 'client_uri', 'logo_uri', 'scope',
  'contacts', 'tos_uri', 'policy_uri', 'jwks_uri', 'jwks', 'software_id', 'software_version', 'software_statement', 'application_type',
]);

const metaError = (d: string) => new ClientError('invalid_client_metadata', d);

function stringList(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) throw metaError(`${name} must be an array of non-empty strings`);
  return [...new Set(v as string[])];
}

function httpsUri(v: unknown, name: string): string {
  if (typeof v !== 'string') throw metaError(`${name} must be a URL`);
  try {
    if (new URL(v).protocol !== 'https:') throw new Error();
  } catch {
    throw metaError(`${name} must be an https URL`);
  }
  return v;
}

export class ClientRegistry {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly now: () => number;
  private readonly rand: (n: number) => Uint8Array;
  readonly policy: Policy;
  private readonly endpoint: string | undefined;

  constructor(o: RegistryOptions) {
    this.now = o.now ?? Date.now;
    this.rand = o.randomBytes;
    this.policy = { ...DEFAULT_POLICY, ...o.policy };
    this.endpoint = o.registrationEndpoint;
  }

  private token(bytes: number): string {
    return Buffer.from(this.rand(bytes)).toString('base64url');
  }

  private makeSecret(): { plain: string; record: SecretRecord } {
    const plain = this.token(32);
    const createdAt = this.now();
    const record: SecretRecord = {
      id: `s_${this.token(6)}`,
      hash: sha256(plain),
      createdAt,
      ...(this.policy.secretTtlMs === undefined ? {} : { expiresAt: createdAt + this.policy.secretTtlMs }),
    };
    return { plain, record };
  }

  // ------------------------------------------------------------ RFC 7591

  /**
   * Dynamic client registration. `metadata` is the JSON the caller posted. Returns the client information response,
   * with the secret (once) when the client is confidential. Throws ClientError with the RFC 7591 error code.
   * `initialAccessTokenOk` says the caller presented a valid initial access token; without it, registration is
   * refused unless the policy opens it.
   */
  register(metadata: unknown, initialAccessTokenOk = false): RegistrationResponse {
    if (!this.policy.openRegistration && !initialAccessTokenOk) throw new ClientError('forbidden', 'registration needs an initial access token');
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw metaError('the metadata must be a JSON object');
    const m = metadata as Record<string, unknown>;
    if (m.software_statement !== undefined) throw new ClientError('invalid_software_statement', 'software statements are not accepted here');
    // Unknown members are ignored, as RFC 7591 section 2 asks of a server, but never copied onto the record.
    for (const k of Object.keys(m)) if (!KNOWN_FIELDS.has(k) && /^(client_id|client_secret|registration_)/.test(k)) throw metaError(`${k} is set by the server`);

    const applicationType = (m.application_type ?? 'web') as unknown;
    if (applicationType !== 'web' && applicationType !== 'native') throw metaError('application_type must be web or native');
    const authMethod = (m.token_endpoint_auth_method ?? 'client_secret_basic') as unknown;
    if (typeof authMethod !== 'string' || !AUTH_METHODS.includes(authMethod)) throw metaError(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`);

    const grantTypes = m.grant_types === undefined ? [GRANT_AUTHORIZATION_CODE] : stringList(m.grant_types, 'grant_types');
    if (grantTypes.length === 0) throw metaError('grant_types may not be empty');
    for (const g of grantTypes) if (!this.policy.allowedGrantTypes.includes(g)) throw metaError(`the grant type ${g} is not allowed`);
    const responseTypes = m.response_types === undefined ? (grantTypes.includes(GRANT_AUTHORIZATION_CODE) ? ['code'] : []) : stringList(m.response_types, 'response_types');
    for (const r of responseTypes) if (r !== 'code') throw metaError(`the response type ${r} is not allowed`);
    if (responseTypes.includes('code') && !grantTypes.includes(GRANT_AUTHORIZATION_CODE)) throw metaError('response type code needs the authorization_code grant');
    if (grantTypes.includes(GRANT_AUTHORIZATION_CODE) && !responseTypes.includes('code')) throw metaError('the authorization_code grant needs response type code');
    if (grantTypes.includes(GRANT_REFRESH) && !grantTypes.some((g) => g === GRANT_AUTHORIZATION_CODE || g === GRANT_DEVICE)) throw metaError('refresh_token only goes with a grant that gives a user a token');

    const needsRedirect = grantTypes.includes(GRANT_AUTHORIZATION_CODE);
    const redirectUris = m.redirect_uris === undefined ? [] : stringList(m.redirect_uris, 'redirect_uris');
    if (needsRedirect && redirectUris.length === 0) throw new ClientError('invalid_redirect_uri', 'redirect_uris is required for the authorization_code grant');
    if (redirectUris.length > this.policy.maxRedirectUris) throw new ClientError('invalid_redirect_uri', `no more than ${this.policy.maxRedirectUris} redirect URIs`);
    for (const u of redirectUris) checkRedirectUri(u, applicationType, { allowLocalhostHost: this.policy.allowLocalhostHost });

    if (authMethod === 'none' && grantTypes.includes(GRANT_CLIENT_CREDENTIALS)) throw metaError('a public client cannot use client_credentials');

    const requested = m.scope === undefined ? [...this.policy.defaultScopes] : typeof m.scope === 'string' ? m.scope.split(' ').filter(Boolean) : (() => { throw metaError('scope must be a space-separated string'); })();
    for (const s of requested) if (!this.policy.allowedScopes.includes(s)) throw metaError(`the scope ${s} is not allowed`);

    const name = m.client_name === undefined ? 'Unnamed client' : m.client_name;
    if (typeof name !== 'string' || name.length === 0 || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw metaError('client_name must be text up to 200 characters');
    const contacts = m.contacts === undefined ? [] : stringList(m.contacts, 'contacts');

    const id = `c_${this.token(16)}`;
    const regToken = this.token(32);
    const secret = authMethod === 'none' ? undefined : this.makeSecret();
    const rec: ClientRecord = {
      clientId: id,
      name,
      applicationType,
      authMethod: authMethod as AuthMethod,
      redirectUris,
      grantTypes,
      responseTypes,
      scopes: requested,
      secrets: secret ? [secret.record] : [],
      createdAt: this.now(),
      contacts,
      ...(m.client_uri === undefined ? {} : { clientUri: httpsUri(m.client_uri, 'client_uri') }),
      ...(m.logo_uri === undefined ? {} : { logoUri: httpsUri(m.logo_uri, 'logo_uri') }),
      ...(m.tos_uri === undefined ? {} : { tosUri: httpsUri(m.tos_uri, 'tos_uri') }),
      ...(m.policy_uri === undefined ? {} : { policyUri: httpsUri(m.policy_uri, 'policy_uri') }),
      ...(typeof m.software_id === 'string' ? { softwareId: m.software_id } : {}),
      ...(typeof m.software_version === 'string' ? { softwareVersion: m.software_version } : {}),
      trusted: false,
      registrationTokenHash: sha256(regToken),
      disabled: false,
    };
    this.clients.set(id, rec);
    return this.toResponse(rec, secret?.plain, regToken);
  }

  private toResponse(c: ClientRecord, secret: string | undefined, regToken: string): RegistrationResponse {
    const exp = c.secrets[c.secrets.length - 1]?.expiresAt;
    return {
      client_id: c.clientId,
      ...(secret === undefined ? {} : { client_secret: secret, client_secret_expires_at: exp === undefined ? 0 : Math.floor(exp / 1000) }),
      client_id_issued_at: Math.floor(c.createdAt / 1000),
      registration_access_token: regToken,
      ...(this.endpoint ? { registration_client_uri: `${this.endpoint.replace(/\/$/, '')}/${c.clientId}` } : {}),
      redirect_uris: [...c.redirectUris],
      grant_types: [...c.grantTypes],
      response_types: [...c.responseTypes],
      token_endpoint_auth_method: c.authMethod,
      client_name: c.name,
      scope: c.scopes.join(' '),
      application_type: c.applicationType,
    };
  }

  private byToken(clientId: string, token: string | undefined): ClientRecord {
    const c = this.clients.get(clientId);
    if (!c || !c.registrationTokenHash || token === undefined || !equal(c.registrationTokenHash, sha256(token))) {
      // The same answer whether the client is unknown or the token is wrong, so ids cannot be probed.
      throw new ClientError('invalid_client', 'the registration access token is not valid for that client');
    }
    return c;
  }

  /** RFC 7592 read: the client's configuration, authorised by its registration access token. */
  readRegistration(clientId: string, token: string | undefined): Omit<RegistrationResponse, 'registration_access_token'> {
    const c = this.byToken(clientId, token);
    const { registration_access_token: _t, ...rest } = this.toResponse(c, undefined, '');
    return rest;
  }

  /** RFC 7592 delete. */
  deleteRegistration(clientId: string, token: string | undefined): void {
    this.byToken(clientId, token);
    this.clients.delete(clientId);
  }

  /** RFC 7592 update: the new metadata replaces the old, and is checked exactly as at registration. Secrets are kept. */
  updateRegistration(clientId: string, token: string | undefined, metadata: unknown): Omit<RegistrationResponse, 'registration_access_token'> {
    const old = this.byToken(clientId, token);
    const probe = new ClientRegistry({ now: this.now, randomBytes: this.rand, policy: { ...this.policy, openRegistration: true } });
    const fresh = probe.register({ ...(metadata as object), token_endpoint_auth_method: old.authMethod }, true);
    const next: ClientRecord = {
      ...old,
      name: fresh.client_name,
      redirectUris: fresh.redirect_uris,
      grantTypes: fresh.grant_types,
      responseTypes: fresh.response_types,
      scopes: fresh.scope.split(' ').filter(Boolean),
      applicationType: fresh.application_type,
    };
    this.clients.set(clientId, next);
    const { registration_access_token: _t, ...rest } = this.toResponse(next, undefined, '');
    return rest;
  }

  // ------------------------------------------------------------ administration

  /** Creates a client directly (an operator, not RFC 7591): trusted first-party apps and seeded clients. */
  create(input: {
    name: string;
    redirectUris?: readonly string[];
    authMethod?: AuthMethod;
    grantTypes?: readonly string[];
    scopes?: readonly string[];
    applicationType?: AppType;
    trusted?: boolean;
    clientId?: string;
  }): { client: ClientRecord; secret?: string } {
    const authMethod = input.authMethod ?? 'client_secret_basic';
    const applicationType = input.applicationType ?? 'web';
    const grantTypes = [...(input.grantTypes ?? [GRANT_AUTHORIZATION_CODE])];
    const redirectUris = [...(input.redirectUris ?? [])];
    for (const u of redirectUris) checkRedirectUri(u, applicationType, { allowLocalhostHost: this.policy.allowLocalhostHost });
    if (grantTypes.includes(GRANT_AUTHORIZATION_CODE) && redirectUris.length === 0) throw new ClientError('invalid_redirect_uri', 'a client using authorization_code needs a redirect URI');
    if (authMethod === 'none' && grantTypes.includes(GRANT_CLIENT_CREDENTIALS)) throw metaError('a public client cannot use client_credentials');
    const id = input.clientId ?? `c_${this.token(16)}`;
    if (this.clients.has(id)) throw metaError(`a client with the id ${id} already exists`);
    const secret = authMethod === 'none' ? undefined : this.makeSecret();
    const client: ClientRecord = {
      clientId: id,
      name: input.name,
      applicationType,
      authMethod,
      redirectUris,
      grantTypes,
      responseTypes: grantTypes.includes(GRANT_AUTHORIZATION_CODE) ? ['code'] : [],
      scopes: [...(input.scopes ?? this.policy.defaultScopes)],
      secrets: secret ? [secret.record] : [],
      createdAt: this.now(),
      contacts: [],
      trusted: input.trusted ?? false,
      disabled: false,
    };
    this.clients.set(id, client);
    return { client, ...(secret ? { secret: secret.plain } : {}) };
  }

  get(clientId: string): ClientRecord | undefined {
    return this.clients.get(clientId);
  }

  list(): ClientRecord[] {
    return [...this.clients.values()];
  }

  disable(clientId: string, disabled = true): void {
    const c = this.must(clientId);
    this.clients.set(clientId, { ...c, disabled });
  }

  private must(clientId: string): ClientRecord {
    const c = this.clients.get(clientId);
    if (!c) throw new ClientError('unknown_client', `no client ${clientId}`);
    return c;
  }

  // ------------------------------------------------------------ the questions an authorization server asks

  /**
   * The redirect URI to use for an authorization request. When the request names one, it must match a registered
   * URI exactly; when it names none, the client must have registered exactly one. Anything else is an error the
   * server shows the person and never redirects (RFC 6749 section 3.1.2.4).
   */
  resolveRedirect(clientId: string, requested: string | undefined): string {
    const c = this.must(clientId);
    if (c.disabled) throw new ClientError('invalid_client', 'that client is disabled');
    if (requested === undefined || requested === '') {
      if (c.redirectUris.length === 1) return c.redirectUris[0]!;
      throw new ClientError('invalid_redirect_uri', 'the request names no redirect_uri and the client has not registered exactly one');
    }
    if (!matchRedirectUri(c.redirectUris, requested)) throw new ClientError('invalid_redirect_uri', 'that redirect_uri is not registered for this client');
    return requested;
  }

  allowsGrant(clientId: string, grant: string): boolean {
    const c = this.clients.get(clientId);
    return !!c && !c.disabled && c.grantTypes.includes(grant);
  }

  /** The scopes of `requested` this client may be given, and the ones it may not. */
  filterScopes(clientId: string, requested: readonly string[]): { allowed: string[]; refused: string[] } {
    const c = this.must(clientId);
    return { allowed: requested.filter((s) => c.scopes.includes(s)), refused: requested.filter((s) => !c.scopes.includes(s)) };
  }

  /**
   * Authenticates a client at the token endpoint. A public client authenticates by being known (its proof is PKCE,
   * checked elsewhere); a confidential one by a secret that is current. The secret may come from the Basic header
   * or the body, and only the method the client registered is accepted, so a downgrade is refused.
   */
  authenticate(req: { authorization?: string | undefined; clientId?: string | undefined; clientSecret?: string | undefined }): ClientRecord {
    const basic = parseBasicAuthorization(req.authorization);
    if (basic && req.clientSecret !== undefined) throw new ClientError('invalid_client', 'use one way of sending the client secret, not two');
    const id = basic?.clientId ?? req.clientId;
    if (!id) throw new ClientError('invalid_client', 'no client identified');
    if (basic && req.clientId !== undefined && req.clientId !== basic.clientId) throw new ClientError('invalid_client', 'the client_id in the body differs from the one in the header');
    const c = this.clients.get(id);
    const t = this.now();
    const presented = basic?.secret ?? req.clientSecret;
    // One generic failure for unknown client, wrong secret, expired secret and disabled client.
    const fail = () => new ClientError('invalid_client', 'client authentication failed');
    if (!c || c.disabled) {
      // Spend comparable time so an unknown id is not told apart by speed.
      equal(sha256(presented ?? ''), sha256('x'));
      throw fail();
    }
    if (c.authMethod === 'none') {
      if (presented !== undefined) throw fail();
      return c;
    }
    if (presented === undefined) throw fail();
    if (c.authMethod === 'client_secret_basic' && !basic) throw fail();
    if (c.authMethod === 'client_secret_post' && basic) throw fail();
    const h = sha256(presented);
    // Every stored secret is compared, so the time taken does not say which one matched.
    let ok = false;
    for (const s of c.secrets) if (equal(s.hash, h) && (s.expiresAt === undefined || s.expiresAt > t)) ok = true;
    if (!ok) throw fail();
    return c;
  }

  // ------------------------------------------------------------ rotation

  /**
   * Adds a new secret and gives every current secret an end `overlapMs` from now, so the app can be redeployed
   * with the new one before the old stops working. With an overlap of zero the old secrets stop at once.
   * The new secret is returned once.
   */
  rotateSecret(clientId: string, overlapMs: number): NewSecret {
    const c = this.must(clientId);
    if (c.authMethod === 'none') throw metaError('a public client has no secret to rotate');
    if (!(overlapMs >= 0)) throw metaError('the overlap must be zero or more');
    const t = this.now();
    const end = t + overlapMs;
    const kept = c.secrets.map((s) => ({ ...s, expiresAt: Math.min(s.expiresAt ?? Infinity, end) }));
    const fresh = this.makeSecret();
    this.clients.set(clientId, { ...c, secrets: [...kept.filter((s) => s.expiresAt > t), fresh.record] });
    return { secret: fresh.plain, id: fresh.record.id, expiresAt: fresh.record.expiresAt };
  }

  /** Ends one secret now (a leaked old one), leaving the others. */
  revokeSecret(clientId: string, secretId: string): void {
    const c = this.must(clientId);
    if (!c.secrets.some((s) => s.id === secretId)) throw new ClientError('unknown_client', `no secret ${secretId} on ${clientId}`);
    this.clients.set(clientId, { ...c, secrets: c.secrets.filter((s) => s.id !== secretId) });
  }

  /** Secrets that expire within `withinMs`, for a warning before an app breaks. */
  expiring(withinMs: number): { clientId: string; secretId: string; expiresAt: number }[] {
    const t = this.now();
    const out: { clientId: string; secretId: string; expiresAt: number }[] = [];
    for (const c of this.clients.values()) for (const s of c.secrets) if (s.expiresAt !== undefined && s.expiresAt > t && s.expiresAt - t <= withinMs) out.push({ clientId: c.clientId, secretId: s.id, expiresAt: s.expiresAt });
    return out.sort((a, b) => a.expiresAt - b.expiresAt);
  }
}
