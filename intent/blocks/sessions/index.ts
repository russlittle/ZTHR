/**
 * Sessions and a second factor. A session has an idle limit and an absolute limit, warns before it ends so work
 * is not lost, can be extended by activity, and can be ended everywhere at once. Sign-in can require a second
 * factor: time-based one-time codes (RFC 6238, the authenticator apps everyone has), with a one-step allowance for
 * clock drift and each code usable once, and single-use recovery codes kept only as hashes.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export interface Session {
  readonly id: string;
  readonly user: string;
  readonly created: number;
  lastSeen: number;
  /** Signed in with a second factor in this session. */
  mfa: boolean;
  readonly device: string;
}

export interface SessionPolicy {
  readonly idleMs: number;
  readonly absoluteMs: number;
  /** How long before the end to warn. */
  readonly warnMs: number;
}

export const DEFAULT_POLICY: SessionPolicy = { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000, warnMs: 2 * 60_000 };

export class Expired extends Error {
  constructor(why: string) {
    super(why);
  }
}

export class Sessions {
  readonly all = new Map<string, Session>();
  private readonly p: SessionPolicy;
  private readonly now: () => number;

  constructor(o: { policy?: SessionPolicy; now?: () => number } = {}) {
    this.p = o.policy ?? DEFAULT_POLICY;
    this.now = o.now ?? Date.now;
  }

  start(user: string, device: string, mfa = false): Session {
    const s: Session = { id: randomBytes(32).toString('base64url'), user, created: this.now(), lastSeen: this.now(), mfa, device };
    this.all.set(s.id, s);
    return s;
  }

  /** When it ends if nothing more happens: the earlier of the idle and absolute limits. */
  endsAt(s: Session): number {
    return Math.min(s.lastSeen + this.p.idleMs, s.created + this.p.absoluteMs);
  }

  /** The session for a request, touched by the activity; throws when it has ended. */
  use(id: string): Session {
    const s = this.all.get(id);
    if (!s) throw new Expired('you are signed out');
    const t = this.now();
    if (t >= s.created + this.p.absoluteMs) {
      this.all.delete(id);
      throw new Expired('your session reached its time limit; sign in again');
    }
    if (t >= s.lastSeen + this.p.idleMs) {
      this.all.delete(id);
      throw new Expired('you were signed out after a while without activity');
    }
    s.lastSeen = t;
    return s;
  }

  /** What a page shows: nothing, or a warning with the seconds left and whether staying signed in can extend it. */
  warning(id: string): { secondsLeft: number; canExtend: boolean } | null {
    const s = this.all.get(id);
    if (!s) return null;
    const left = this.endsAt(s) - this.now();
    if (left > this.p.warnMs || left <= 0) return null;
    return { secondsLeft: Math.ceil(left / 1000), canExtend: s.lastSeen + this.p.idleMs < s.created + this.p.absoluteMs };
  }

  end(id: string): void {
    this.all.delete(id);
  }

  /** Signs a person out everywhere, except optionally the session asking. */
  endAll(user: string, except?: string): number {
    let n = 0;
    for (const [id, s] of this.all)
      if (s.user === user && id !== except) {
        this.all.delete(id);
        n++;
      }
    return n;
  }

  list(user: string): Session[] {
    return [...this.all.values()].filter((s) => s.user === user).sort((a, b) => b.lastSeen - a.lastSeen);
  }
}

// ---------------------------------------------------------------- one-time codes (RFC 6238)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Uint8Array): string {
  let bits = 0;
  let v = 0;
  let out = '';
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let v = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('not base32');
    v = (v << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for a counter (RFC 4226), `digits` long, with SHA-1 as the authenticator apps use. */
export function hotp(secret: Uint8Array, counter: number, digits = 6, algo: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, secret).update(c).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 10 ** digits).padStart(digits, '0');
}

export const totp = (secret: Uint8Array, at: number, o: { step?: number; digits?: number; algo?: 'sha1' | 'sha256' | 'sha512' } = {}) => hotp(secret, Math.floor(at / 1000 / (o.step ?? 30)), o.digits ?? 6, o.algo ?? 'sha1');

/** A new second factor to enrol: the secret, and the address an authenticator app scans as a QR code. */
export function enrol(account: string, issuer: string): { secret: string; uri: string } {
  const secret = base32(randomBytes(20));
  const label = encodeURIComponent(`${issuer}:${account}`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` };
}

/**
 * Checks a code, allowing one step either side for clock drift, and refusing a code already used (so a code seen
 * over a shoulder cannot be replayed). Returns the step it matched, to store as the last one used.
 */
export function checkCode(secretB32: string, code: string, at: number, lastStep?: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = unbase32(secretB32);
  const step = Math.floor(at / 30_000);
  for (const d of [0, -1, 1]) {
    const s = step + d;
    if (lastStep !== undefined && s <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(code))) return s;
  }
  return null;
}

/** Ten recovery codes, shown once; only their hashes are kept, and each works once. */
export function recoveryCodes(n = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: n }, () => {
    const d = String(randomInt(0, 10 ** 10)).padStart(10, '0');
    return `${d.slice(0, 5)}-${d.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => createHash('sha256').update(c).digest('hex')) };
}

/** Uses a recovery code: returns the hashes left, or null when the code is not one of them. */
export function useRecovery(code: string, hashes: readonly string[]): string[] | null {
  const h = createHash('sha256').update(code.trim().replace(/\s/g, '')).digest('hex');
  const i = hashes.indexOf(h);
  return i < 0 ? null : hashes.filter((_, j) => j !== i);
}
