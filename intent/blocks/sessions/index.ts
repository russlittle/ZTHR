/**
 * Sessions and a second factor. A session has an idle limit and an absolute limit, warns before it ends so work
 * is not lost, can be extended by activity, and can be ended everywhere at once. Sign-in can require a second
 * factor: time-based one-time codes (RFC 6238, the authenticator apps everyone has), with a one-step allowance for
 * clock drift and each code usable once, and single-use recovery codes kept only as salted scrypt hashes.
 */
import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

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
  private swept = -Infinity;

  constructor(o: { policy?: SessionPolicy; now?: () => number } = {}) {
    this.p = o.policy ?? DEFAULT_POLICY;
    this.now = o.now ?? Date.now;
  }

  start(user: string, device: string, mfa = false): Session {
    // Sessions nobody comes back to would otherwise stay forever; sweep them, at most once per idle period.
    if (this.now() - this.swept >= Math.min(this.p.idleMs, 60_000)) this.sweep();
    const s: Session = { id: randomBytes(32).toString('base64url'), user, created: this.now(), lastSeen: this.now(), mfa, device };
    this.all.set(s.id, s);
    return s;
  }

  /** Forgets every session that has ended; returns how many. */
  sweep(): number {
    const t = this.now();
    this.swept = t;
    let n = 0;
    for (const [id, s] of this.all)
      if (t >= this.endsAt(s)) {
        this.all.delete(id);
        n++;
      }
    return n;
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

  /** A person's sessions that are still signed in, most recently used first. */
  list(user: string): Session[] {
    const t = this.now();
    return [...this.all.values()].filter((s) => s.user === user && t < this.endsAt(s)).sort((a, b) => b.lastSeen - a.lastSeen);
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

/**
 * How recovery codes are kept: scrypt with a fresh 16-byte salt per code, so a leaked list cannot be checked against
 * one precomputed table and each guess at a ten-digit code costs a full scrypt. The defaults (N = 2^14, r = 8, p = 1,
 * 16 MiB and tens of milliseconds a guess) make trying every code for one stored hash take years of CPU. A caller
 * may add a pepper: a server-held secret mixed in as an HMAC key before scrypt, kept outside the database, so a
 * leaked list alone is not enough to start guessing.
 */
export interface RecoveryKdf {
  readonly N?: number;
  readonly r?: number;
  readonly p?: number;
  readonly pepper?: string | Uint8Array;
}

const KDF = { N: 2 ** 14, r: 8, p: 1 } as const;

/** A code in the form it is hashed in: "12345-67890", however it was typed. */
const canonical = (code: string) => {
  const digits = code.replace(/[\s-]/g, '');
  return /^\d{10}$/.test(digits) ? `${digits.slice(0, 5)}-${digits.slice(5)}` : code.trim();
};

const derive = (code: string, salt: Buffer, N: number, r: number, p: number, pepper?: string | Uint8Array) => {
  const input = pepper === undefined ? Buffer.from(code) : createHmac('sha256', pepper).update(code).digest();
  return scryptSync(input, salt, 32, { N, r, p, maxmem: 256 * N * r });
};

/** One stored recovery code: "scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>". */
export function hashRecovery(code: string, o: RecoveryKdf = {}): string {
  const N = o.N ?? KDF.N;
  const r = o.r ?? KDF.r;
  const p = o.p ?? KDF.p;
  const salt = randomBytes(16);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derive(canonical(code), salt, N, r, p, o.pepper).toString('base64url')}`;
}

/** Whether a typed code is the one a stored hash was made from; the cost parameters are read from the hash. */
export function matchesRecovery(code: string, stored: string, o: Pick<RecoveryKdf, 'pepper'> = {}): boolean {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // A stored hash names its own cost; one far outside sane bounds is refused rather than run.
  if (!(N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return false;
  const want = Buffer.from(m[5]!, 'base64url');
  const got = derive(canonical(code), Buffer.from(m[4]!, 'base64url'), N, r, p, o.pepper);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Ten recovery codes, shown once; only their salted scrypt hashes are kept, and each works once. */
export function recoveryCodes(n = 10, o: RecoveryKdf = {}): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: n }, () => {
    const d = String(randomInt(0, 10 ** 10)).padStart(10, '0');
    return `${d.slice(0, 5)}-${d.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => hashRecovery(c, o)) };
}

/**
 * Uses a recovery code: returns the hashes left, or null when the code is not one of them. Every stored hash is
 * checked, matched or not, so the time taken does not say which one matched. Store the list it returns in place of
 * the old one, so the code cannot be used again.
 */
export function useRecovery(code: string, hashes: readonly string[], o: Pick<RecoveryKdf, 'pepper'> = {}): string[] | null {
  let hit = -1;
  hashes.forEach((h, i) => {
    if (matchesRecovery(code, h, o) && hit < 0) hit = i;
  });
  return hit < 0 ? null : hashes.filter((_, j) => j !== hit);
}
