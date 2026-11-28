/**
 * Web Push the way a server sends it. Holds: VAPID (RFC 8292) key pairs and the signed ES256 token for the
 * Authorization header, scoped to one push service origin and capped at 24 hours; payload encryption with the
 * aes128gcm content coding (RFC 8188) and the Web Push key schedule (RFC 8291), with the matching decrypt so a
 * round trip can be tested and the RFC's own example reproduced byte for byte; the request a push service expects
 * (TTL, Urgency, Topic, Content-Encoding) built and checked; and the subscription lifecycle: keys checked when a
 * subscription is stored, secrets sealed at rest with the crypto block, expiry honoured, 404 and 410 meaning the
 * subscription is gone and is removed, 429 and 5xx retried after Retry-After or a backoff, 413 and other client
 * errors not retried, VAPID rejections (401 and 403) counted against the sender rather than the subscription, and a
 * subscription dropped after repeated failures. Time, randomness and the network are injected. Not here: the
 * browser side (the pushsubscriptionchange snippet is only a helper string), aesgcm (the old draft coding),
 * topic coalescing at the push service, and the HTTP/2 connection.
 */
import { createECDH, createPrivateKey, createSign, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { open, seal, type KeyRing } from '../crypto/index.ts';

export class PushError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

// ---------------------------------------------------------------- VAPID

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url (65 bytes): the "applicationServerKey" the browser subscribes with. */
  readonly publicKey: string;
  /** The raw 32 byte private scalar, base64url. Keep it secret (see sealVapid). */
  readonly privateKey: string;
}

export function generateVapid(): VapidKeys {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

/** Seals the private key for storage; the public key stays in the clear. */
export const sealVapid = (ring: KeyRing, k: VapidKeys, context = 'vapid') => ({ publicKey: k.publicKey, sealed: seal(ring, k.privateKey, context) });
export const openVapid = (ring: KeyRing, s: { publicKey: string; sealed: string }, context = 'vapid'): VapidKeys => ({ publicKey: s.publicKey, privateKey: open(ring, s.sealed, context) });

const MAX_TOKEN_LIFE_S = 24 * 3600;

function checkPublic(pub: Buffer, what: string): void {
  if (pub.length !== 65 || pub[0] !== 0x04) throw new PushError('key', `${what} must be a 65 byte uncompressed P-256 point`);
  try {
    const e = createECDH('prime256v1');
    e.generateKeys();
    e.computeSecret(pub);
  } catch {
    throw new PushError('key', `${what} is not a point on the P-256 curve`);
  }
}

export function checkVapid(k: VapidKeys): void {
  const priv = unb64u(k.privateKey);
  if (priv.length !== 32) throw new PushError('key', 'the VAPID private key must be 32 bytes');
  const e = createECDH('prime256v1');
  e.setPrivateKey(priv);
  if (b64u(e.getPublicKey()) !== k.publicKey) throw new PushError('key', 'the VAPID public key does not match the private key');
}

export interface VapidOptions {
  /** A mailto: or https: contact for the push service operator (the "sub" claim). */
  readonly subject: string;
  readonly now?: () => number;
  /** Token lifetime in seconds, at most 24 hours. Default 12 hours. */
  readonly ttlSeconds?: number;
}

/** The origin a token is for: scheme, host and port of the endpoint. */
export function endpointOrigin(endpoint: string): string {
  const u = new URL(endpoint);
  return u.origin;
}

/** The signed JWT (ES256) for one push service origin. */
export function vapidToken(k: VapidKeys, endpoint: string, o: VapidOptions): string {
  if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/[^\s]+)$/.test(o.subject)) throw new PushError('vapid', 'the subject must be a mailto: or https: URL');
  const life = o.ttlSeconds ?? 12 * 3600;
  if (!(life > 0 && life <= MAX_TOKEN_LIFE_S)) throw new PushError('vapid', 'the token lifetime must be between 1 second and 24 hours');
  const now = Math.floor((o.now ?? Date.now)() / 1000);
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: endpointOrigin(endpoint), exp: now + life, sub: o.subject })));
  const priv = unb64u(k.privateKey);
  const pub = unb64u(k.publicKey);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(priv), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

/** The Authorization header value (RFC 8292 scheme "vapid"). */
export const vapidAuthorization = (k: VapidKeys, endpoint: string, o: VapidOptions): string => `vapid t=${vapidToken(k, endpoint, o)}, k=${k.publicKey}`;

// ---------------------------------------------------------------- encryption

export interface Keys {
  /** The browser's public key (65 bytes) and the 16 byte auth secret, base64url. */
  readonly p256dh: string;
  readonly auth: string;
}

export interface EncryptOptions {
  /** Record size, default 4096; the largest plaintext is recordSize - 103 bytes. */
  readonly recordSize?: number;
  /** Zero bytes of padding to hide the length, default 0. */
  readonly padding?: number;
  /** For tests only: the salt and the sender's key pair. */
  readonly salt?: Buffer;
  readonly senderPrivate?: Buffer;
}

export const MAX_PLAINTEXT = 3993;

function keySchedule(ecdh: Buffer, auth: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) {
  const prk = Buffer.from(hkdfSync('sha256', ecdh, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  return { cek, nonce };
}

/** Encrypts a payload for a subscription. The result is the whole request body (header and one record). */
export function encryptPayload(keys: Keys, plaintext: Uint8Array | string, o: EncryptOptions = {}): Buffer {
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const rs = o.recordSize ?? 4096;
  if (!Number.isInteger(rs) || rs < 18 || rs > 0x7fffffff) throw new PushError('payload', 'bad record size');
  const padding = o.padding ?? 0;
  const room = rs - 17;
  if (pt.length + padding + 1 > room) throw new PushError('payload', `the payload is ${pt.length + padding} bytes, over the ${room - 1} that fit in a record of ${rs}`);
  const ua = unb64u(keys.p256dh);
  const auth = unb64u(keys.auth);
  checkPublic(ua, 'p256dh');
  if (auth.length !== 16) throw new PushError('key', 'the auth secret must be 16 bytes');
  const e = createECDH('prime256v1');
  if (o.senderPrivate) e.setPrivateKey(o.senderPrivate);
  else e.generateKeys();
  const asPublic = e.getPublicKey();
  const salt = o.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new PushError('payload', 'the salt must be 16 bytes');
  const { cek, nonce } = keySchedule(e.computeSecret(ua), auth, ua, asPublic, salt);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([c.update(Buffer.concat([pt, Buffer.from([0x02]), Buffer.alloc(padding)])), c.final(), c.getAuthTag()]);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  return Buffer.concat([header, record]);
}

/** Decrypts a body with the browser's private key (for tests, and for a server that receives pushes to relay). */
export function decryptPayload(body: Uint8Array, uaPrivate: Buffer, auth: Buffer): Buffer {
  const b = Buffer.from(body);
  if (b.length < 21 + 16 + 1) throw new PushError('payload', 'too short');
  const salt = b.subarray(0, 16);
  const rs = b.readUInt32BE(16);
  const idlen = b[20]!;
  if (idlen !== 65 || b.length < 21 + idlen) throw new PushError('payload', 'the key id must be a 65 byte public key');
  const asPublic = b.subarray(21, 21 + idlen);
  const data = b.subarray(21 + idlen);
  if (data.length > rs) throw new PushError('payload', 'more than one record is not supported');
  const e = createECDH('prime256v1');
  e.setPrivateKey(uaPrivate);
  const { cek, nonce } = keySchedule(e.computeSecret(asPublic), auth, e.getPublicKey(), asPublic, salt);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  } catch {
    throw new PushError('payload', 'authentication failed');
  }
  let i = plain.length - 1;
  while (i >= 0 && plain[i] === 0) i--;
  if (i < 0 || plain[i] !== 0x02) throw new PushError('payload', 'the padding delimiter is missing or wrong');
  return plain.subarray(0, i);
}

// ---------------------------------------------------------------- request

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface SendOptions {
  /** Seconds the push service may hold the message. Required by the protocol; 0 means deliver now or drop. */
  readonly ttl: number;
  readonly urgency?: Urgency;
  /** Replaces an earlier undelivered message with the same topic: up to 32 URL-safe base64 characters. */
  readonly topic?: string;
}

export interface PushRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/** The endpoint must be https and not point at a private or local address (a stored subscription is user input). */
export function checkEndpoint(endpoint: string): URL {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new PushError('endpoint', 'the endpoint is not a URL');
  }
  if (u.protocol !== 'https:') throw new PushError('endpoint', 'the endpoint must be https');
  if (u.username || u.password) throw new PushError('endpoint', 'the endpoint must not carry credentials');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || !/[.:]/.test(h)) throw new PushError('endpoint', 'the endpoint host is not public');
  if (/^\[?(::1?|f[cd][0-9a-f]{2}:|fe80:|::ffff:)/i.test(h)) throw new PushError('endpoint', 'the endpoint host is not public');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224) throw new PushError('endpoint', 'the endpoint host is not public');
  }
  if (endpoint.length > 2048) throw new PushError('endpoint', 'the endpoint is too long');
  return u;
}

export function buildRequest(sub: { endpoint: string; keys: Keys }, payload: Uint8Array | string | null, vapid: VapidKeys, vo: VapidOptions, so: SendOptions, eo: EncryptOptions = {}): PushRequest {
  checkEndpoint(sub.endpoint);
  if (!Number.isInteger(so.ttl) || so.ttl < 0 || so.ttl > 2 ** 31 - 1) throw new PushError('ttl', 'ttl must be a whole number of seconds, 0 or more');
  if (so.topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(so.topic)) throw new PushError('topic', 'a topic is up to 32 characters of A-Z a-z 0-9 - _');
  const headers: Record<string, string> = { Authorization: vapidAuthorization(vapid, sub.endpoint, vo), TTL: String(so.ttl) };
  if (so.urgency) {
    if (!['very-low', 'low', 'normal', 'high'].includes(so.urgency)) throw new PushError('urgency', 'bad urgency');
    headers.Urgency = so.urgency;
  }
  if (so.topic) headers.Topic = so.topic;
  let body: Buffer = Buffer.alloc(0);
  if (payload !== null && !(typeof payload === 'string' && payload === '')) {
    body = encryptPayload(sub.keys, payload, eo);
    if (body.length > 4096) throw new PushError('payload', `the encrypted body is ${body.length} bytes; push services accept 4096 (${MAX_PLAINTEXT} bytes of payload)`);
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
  }
  headers['Content-Length'] = String(body.length);
  return { url: sub.endpoint, method: 'POST', headers, body };
}

// ---------------------------------------------------------------- lifecycle

export interface Subscription {
  readonly endpoint: string;
  readonly keys: Keys;
  /** Milliseconds since the epoch, from PushSubscription.expirationTime; null or absent: none. */
  readonly expirationTime?: number | null;
}

interface Row {
  endpoint: string;
  owner: string;
  p256dh: string;
  sealedAuth: string;
  expiresAt: number | null;
  createdAt: number;
  lastOk: number | null;
  failures: number;
  firstFailureAt: number | null;
  retryAt: number;
  status: 'active' | 'gone' | 'expired' | 'dropped';
}

export type Outcome =
  | { readonly kind: 'sent'; readonly status: number; readonly location?: string }
  | { readonly kind: 'gone'; readonly status: number }
  | { readonly kind: 'retry'; readonly status: number; readonly retryAt: number }
  | { readonly kind: 'rejected'; readonly status: number; readonly reason: string }
  | { readonly kind: 'vapid'; readonly status: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'skipped'; readonly retryAt: number };

export interface PushResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StoreOptions {
  readonly ring: KeyRing;
  readonly now?: () => number;
  /** Consecutive failures (5xx, 429, network) before a subscription is dropped, over at least `dropAfterMs`. */
  readonly dropAfterFailures?: number;
  readonly dropAfterMs?: number;
  readonly maxPerOwner?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly maxRetryAfterMs?: number;
}

/** Parses Retry-After as seconds or an HTTP date, in milliseconds from now; undefined when absent or unusable. */
export function retryAfterMs(v: string | undefined, now: number): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

export class SubscriptionStore {
  private readonly rows = new Map<string, Row>();
  private readonly o: StoreOptions;
  private readonly now: () => number;
  vapidFailures = 0;

  constructor(o: StoreOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  get size(): number {
    return this.rows.size;
  }

  /** Stores (or refreshes) a subscription for an owner after checking the endpoint and keys. */
  add(owner: string, sub: Subscription): void {
    checkEndpoint(sub.endpoint);
    checkPublic(unb64u(sub.keys.p256dh), 'p256dh');
    if (unb64u(sub.keys.auth).length !== 16) throw new PushError('key', 'the auth secret must be 16 bytes');
    const t = this.now();
    if (sub.expirationTime != null && sub.expirationTime <= t) throw new PushError('expired', 'the subscription has already expired');
    const existing = this.rows.get(sub.endpoint);
    if (existing && existing.owner !== owner) throw new PushError('owner', 'that endpoint belongs to another owner');
    if (!existing) {
      const n = [...this.rows.values()].filter((r) => r.owner === owner && r.status === 'active').length;
      if (n >= (this.o.maxPerOwner ?? 20)) throw new PushError('limit', 'too many subscriptions for this owner');
    }
    this.rows.set(sub.endpoint, { endpoint: sub.endpoint, owner, p256dh: sub.keys.p256dh, sealedAuth: seal(this.o.ring, sub.keys.auth, `push:${sub.endpoint}`), expiresAt: sub.expirationTime ?? null, createdAt: existing?.createdAt ?? t, lastOk: existing?.lastOk ?? null, failures: 0, firstFailureAt: null, retryAt: 0, status: 'active' });
  }

  /** The browser replaced its subscription (pushsubscriptionchange): swap old for new, keeping the owner. */
  replace(oldEndpoint: string, next: Subscription): void {
    const old = this.rows.get(oldEndpoint);
    if (!old) throw new PushError('unknown', 'no such subscription');
    this.rows.delete(oldEndpoint);
    this.add(old.owner, next);
  }

  remove(endpoint: string): boolean {
    return this.rows.delete(endpoint);
  }

  /** Active subscriptions for an owner, after marking expired ones. */
  forOwner(owner: string): Subscription[] {
    this.sweep();
    return [...this.rows.values()].filter((r) => r.owner === owner && r.status === 'active').map((r) => this.open(r));
  }

  status(endpoint: string): Row['status'] | 'unknown' {
    return this.rows.get(endpoint)?.status ?? 'unknown';
  }

  info(endpoint: string): { failures: number; retryAt: number; lastOk: number | null; expiresAt: number | null } | undefined {
    const r = this.rows.get(endpoint);
    return r && { failures: r.failures, retryAt: r.retryAt, lastOk: r.lastOk, expiresAt: r.expiresAt };
  }

  private open(r: Row): Subscription {
    return { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: open(this.o.ring, r.sealedAuth, `push:${r.endpoint}`) }, expirationTime: r.expiresAt };
  }

  /** Marks expired subscriptions; returns their endpoints and deletes those that are gone, expired or dropped. */
  sweep(): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const [k, r] of this.rows) {
      if (r.status === 'active' && r.expiresAt !== null && r.expiresAt <= t) r.status = 'expired';
      if (r.status !== 'active') {
        out.push(k);
        this.rows.delete(k);
      }
    }
    return out;
  }

  /** Applies a push service's answer to the subscription and says what to do next. */
  record(endpoint: string, res: PushResponse | { error: string }): Outcome {
    const r = this.rows.get(endpoint);
    const t = this.now();
    if (!r) return { kind: 'gone', status: 0 };
    if ('error' in res) return this.fail(r, 0, undefined);
    const s = res.status;
    if (s >= 200 && s < 300) {
      r.failures = 0;
      r.firstFailureAt = null;
      r.retryAt = 0;
      r.lastOk = t;
      const loc = res.headers?.location ?? res.headers?.Location;
      return { kind: 'sent', status: s, ...(loc ? { location: loc } : {}) };
    }
    if (s === 404 || s === 410) {
      r.status = 'gone';
      this.rows.delete(endpoint);
      return { kind: 'gone', status: s };
    }
    if (s === 401 || s === 403) {
      this.vapidFailures++;
      return { kind: 'vapid', status: s };
    }
    if (s === 429 || s >= 500) return this.fail(r, s, res.headers?.['retry-after'] ?? res.headers?.['Retry-After']);
    return { kind: 'rejected', status: s, reason: s === 413 ? 'the payload is too large for this push service' : s === 400 ? 'the push service did not accept the request' : `unexpected status ${s}` };
  }

  private fail(r: Row, status: number, retryAfter: string | undefined): Outcome {
    const t = this.now();
    r.failures++;
    r.firstFailureAt ??= t;
    const base = this.o.backoffBaseMs ?? 30_000;
    const cap = this.o.backoffMaxMs ?? 6 * 3600_000;
    const own = Math.min(cap, base * 2 ** (r.failures - 1));
    const given = retryAfterMs(retryAfter, t);
    const wait = Math.min(this.o.maxRetryAfterMs ?? 24 * 3600_000, Math.max(own, given ?? 0));
    r.retryAt = t + wait;
    if (r.failures >= (this.o.dropAfterFailures ?? 8) && t - r.firstFailureAt >= (this.o.dropAfterMs ?? 24 * 3600_000)) {
      r.status = 'dropped';
      this.rows.delete(r.endpoint);
      return { kind: 'gone', status };
    }
    return { kind: 'retry', status, retryAt: r.retryAt };
  }

  /** Whether the subscription may be tried now (not backing off, not expired). */
  due(endpoint: string): boolean {
    const r = this.rows.get(endpoint);
    return !!r && r.status === 'active' && r.retryAt <= this.now() && (r.expiresAt === null || r.expiresAt > this.now());
  }
}

export type Transport = (req: PushRequest, signal: AbortSignal) => Promise<PushResponse>;

export interface SenderOptions {
  readonly vapid: VapidKeys;
  readonly subject: string;
  readonly store: SubscriptionStore;
  readonly transport: Transport;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/** Sends to stored subscriptions and keeps the store's lifecycle in step with what the push services say. */
export class PushSender {
  private readonly o: SenderOptions;
  constructor(o: SenderOptions) {
    this.o = o;
  }

  async send(sub: Subscription, payload: Uint8Array | string | null, so: SendOptions): Promise<Outcome> {
    const now = this.o.now ?? Date.now;
    const store = this.o.store;
    if (sub.expirationTime != null && sub.expirationTime <= now()) {
      store.remove(sub.endpoint);
      return { kind: 'expired' };
    }
    if (!store.due(sub.endpoint)) {
      const i = store.info(sub.endpoint);
      return i ? { kind: 'skipped', retryAt: i.retryAt } : { kind: 'gone', status: 0 };
    }
    const req = buildRequest(sub, payload, this.o.vapid, { subject: this.o.subject, now }, so);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 15_000);
    try {
      const res = await this.o.transport(req, ac.signal);
      return store.record(sub.endpoint, res);
    } catch (e) {
      return store.record(sub.endpoint, { error: (e as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends to every active subscription of an owner. */
  async sendToOwner(owner: string, payload: Uint8Array | string | null, so: SendOptions): Promise<{ endpoint: string; outcome: Outcome }[]> {
    const out: { endpoint: string; outcome: Outcome }[] = [];
    for (const s of this.o.store.forOwner(owner)) out.push({ endpoint: s.endpoint, outcome: await this.send(s, payload, so) });
    return out;
  }
}

/** A service worker handler for push and subscription changes, as a string to add to the worker script. */
export function pushWorkerSnippet(o: { defaultTitle: string; resubscribeUrl: string }): string {
  return `self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || ${JSON.stringify(o.defaultTitle)}, { body: data.body, data: data.data, tag: data.tag }));
});
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.registration.pushManager.subscribe(event.oldSubscription ? event.oldSubscription.options : { userVisibleOnly: true }).then((s) => fetch(${JSON.stringify(o.resubscribeUrl)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ old: event.oldSubscription && event.oldSubscription.endpoint, subscription: s.toJSON() }) })));
});
`;
}
