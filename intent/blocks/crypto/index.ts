/**
 * Cryptography a product needs, with the choices made once: envelope encryption at rest (AES-256-GCM with a key
 * ring, so keys rotate without re-encrypting everything at once, and old ciphertexts still open), signed tokens
 * with an expiry and a purpose (HMAC-SHA-256, so a token for one purpose never works for another), constant-time
 * comparison, and random identifiers. Passwords are hashed by the grants block's scrypt.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class Unopenable extends Error {
  constructor(why: string) {
    super(`cannot open: ${why}`);
  }
}

export interface KeyRing {
  /** The key new data is sealed with. */
  readonly current: string;
  /** Every key by id, base64 of 32 bytes; old ones stay so old data still opens. */
  readonly keys: Readonly<Record<string, string>>;
}

const keyOf = (ring: KeyRing, id: string) => {
  const k = ring.keys[id];
  if (!k) throw new Unopenable(`key ${id} is not in the ring`);
  const b = Buffer.from(k, 'base64');
  if (b.length !== 32) throw new Unopenable(`key ${id} is not 32 bytes`);
  return b;
};

export const newKey = () => randomBytes(32).toString('base64');

/**
 * Seals a value: "v1.<key id>.<iv>.<ciphertext>.<tag>", all base64url. `context` binds the ciphertext to where it
 * belongs (a table and field and record id), so a sealed value copied to another record does not open there.
 */
export function seal(ring: KeyRing, plaintext: string, context = ''): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(ring, ring.current), iv);
  c.setAAD(Buffer.from(context));
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', ring.current, iv.toString('base64url'), body.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}

export function open(ring: KeyRing, sealed: string, context = ''): string {
  const [v, id, iv, body, tag] = sealed.split('.');
  if (v !== 'v1' || !id || !iv || body === undefined || !tag) throw new Unopenable('not a sealed value');
  const d = createDecipheriv('aes-256-gcm', keyOf(ring, id), Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(context));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new Unopenable('it was changed, or belongs somewhere else');
  }
}

/** Whether a sealed value is under an old key, for a background job that re-seals as it rotates. */
export const needsReseal = (ring: KeyRing, sealed: string) => sealed.split('.')[1] !== ring.current;

export const reseal = (ring: KeyRing, sealed: string, context = '') => seal(ring, open(ring, sealed, context), context);

// ---------------------------------------------------------------- signed tokens

export class BadToken extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** A signed token for one purpose, carrying data and an expiry; it is readable, so it carries nothing secret. */
export function sign(secret: string, purpose: string, data: Record<string, unknown>, ttlMs: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ p: purpose, d: data, e: now + ttlMs })).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(secret: string | readonly string[], purpose: string, token: string, now = Date.now()): Record<string, unknown> {
  const [body, mac] = token.split('.');
  if (!body || !mac) throw new BadToken('that token is not in the expected form');
  const secrets = typeof secret === 'string' ? [secret] : secret;
  const good = secrets.some((s) => equal(createHmac('sha256', s).update(body).digest('base64url'), mac));
  if (!good) throw new BadToken('that token was not issued here, or was changed');
  const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as { p: string; d: Record<string, unknown>; e: number };
  if (t.p !== purpose) throw new BadToken('that token is for something else');
  if (t.e < now) throw new BadToken('that token has expired');
  return t.d;
}

/** Equal strings in constant time, for comparing secrets. */
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A random identifier: url-safe, with `bytes` of entropy (16 bytes is 128 bits). */
export const randomId = (bytes = 16) => randomBytes(bytes).toString('base64url');
