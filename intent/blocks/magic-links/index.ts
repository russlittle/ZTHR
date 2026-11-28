/**
 * Passwordless sign-in links and short codes, each good for one purpose, one person, one device and one use. A link
 * carries 256 bits of randomness and a code is six digits drawn without modulo bias; the service keeps only an
 * HMAC of each, so a leaked store opens nothing. A token made for "sign-in" does not work for "delete-account"; one
 * asked for on one browser (a device id kept in that browser's cookie) is refused on another, and a wrong-device
 * attempt does not spend it; asking again replaces the earlier one; codes lock after a few wrong guesses; and asking
 * is throttled per person and per address, using the ratelimit block.
 *
 * Mail scanners open links before people do, so a link is made to be read with `peek` (which spends nothing, for the
 * page the link opens) and spent by `redeem` (from that page's button, a POST). `linkUrl` puts the token in the URL
 * fragment, which a browser never sends to a server, a log or a referrer.
 *
 * The clock, the random source and the store are arguments. Follows the guidance of OWASP's Forgot Password and
 * Authentication cheat sheets and NIST SP 800-63B for out-of-band authenticators (a code of at least 6 digits,
 * valid for at most ten minutes, spent once, with a limit on guesses).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { equal } from '../crypto/index.ts';
import { Failures, Limiter } from '../ratelimit/index.ts';

export { Limited } from '../ratelimit/index.ts';

export type Reason = 'unknown' | 'expired' | 'used' | 'wrong_purpose' | 'wrong_device' | 'locked' | 'revoked' | 'throttled';

/** A link or code that cannot be used. `reason` is for logs; `message` is safe to show, and says the same for every reason. */
export class NotValid extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super('That link or code is not valid any more. Ask for a new one.');
    this.reason = reason;
  }
}

export interface Record_ {
  readonly id: string;
  readonly kind: 'link' | 'code';
  readonly subject: string;
  readonly purpose: string;
  /** HMAC of the token (link) or of the code with its subject and purpose (code); never the secret itself. */
  readonly secretHash: string;
  readonly deviceHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly context: Readonly<Record<string, string>>;
  usedAt?: number;
  revoked?: boolean;
  wrongGuesses: number;
}

export interface Store {
  put(r: Record_): void;
  get(id: string): Record_ | undefined;
  /** Records for a person and purpose that could still be spent. */
  open(subject: string, purpose: string): Record_[];
  all(): Record_[];
  delete(id: string): void;
}

export class MemoryStore implements Store {
  private readonly m = new Map<string, Record_>();
  put(r: Record_): void {
    this.m.set(r.id, r);
  }
  get(id: string): Record_ | undefined {
    return this.m.get(id);
  }
  open(subject: string, purpose: string): Record_[] {
    return [...this.m.values()].filter((r) => r.subject === subject && r.purpose === purpose && r.usedAt === undefined && !r.revoked);
  }
  all(): Record_[] {
    return [...this.m.values()];
  }
  delete(id: string): void {
    this.m.delete(id);
  }
}

export interface Options {
  /** Key for the HMACs; keep it with the other secrets. At least 16 characters. */
  readonly secret: string;
  readonly now?: () => number;
  /** Random bytes; defaults to node:crypto, injected in tests. */
  readonly random?: (n: number) => Buffer;
  readonly store?: Store;
  readonly linkTtlMs?: number;
  readonly codeTtlMs?: number;
  readonly codeDigits?: number;
  /** Wrong guesses allowed on one code before it is dead. */
  readonly maxGuesses?: number;
  /** Asking: burst and refill (per second) for one person, and for one address. */
  readonly perSubject?: { readonly burst: number; readonly perSecond: number };
  readonly perAddress?: { readonly burst: number; readonly perSecond: number };
  /** Failed redemptions per address in a window. */
  readonly failuresPerAddress?: { readonly limit: number; readonly windowMs: number };
}

export interface Ask {
  readonly subject: string;
  readonly purpose: string;
  /** The id kept in the asking browser's cookie; the same must be presented to redeem. */
  readonly device: string;
  readonly address: string;
  readonly kind?: 'link' | 'code';
  /** Small facts to hand back on redemption (a return path, an invitation id); never secrets. */
  readonly context?: Readonly<Record<string, string>>;
}

export interface Issued {
  readonly kind: 'link' | 'code';
  readonly id: string;
  /** The token for a link, or the digits of a code: send it, never store it. */
  readonly secret: string;
  readonly expiresAt: number;
}

export interface Redeemed {
  readonly subject: string;
  readonly purpose: string;
  readonly context: Readonly<Record<string, string>>;
  readonly issuedAt: number;
}

const normalise = (s: string) => s.normalize('NFKC').trim().toLowerCase();

export class MagicLinks {
  private readonly o: Options;
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;
  private readonly store: Store;
  private readonly bySubject: Limiter;
  private readonly byAddress: Limiter;
  private readonly redeemFailures: Failures;
  private readonly digits: number;

  constructor(o: Options) {
    if (o.secret.length < 16) throw new RangeError('the secret must be at least 16 characters');
    this.o = o;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? randomBytes;
    this.store = o.store ?? new MemoryStore();
    this.digits = o.codeDigits ?? 6;
    if (this.digits < 6 || this.digits > 9) throw new RangeError('a code is 6 to 9 digits');
    this.bySubject = new Limiter(o.perSubject ?? { burst: 3, perSecond: 1 / 60 }, { now: this.now, what: 'too many sign-in requests for this person' });
    this.byAddress = new Limiter(o.perAddress ?? { burst: 10, perSecond: 1 / 10 }, { now: this.now, what: 'too many sign-in requests from this address' });
    const f = o.failuresPerAddress ?? { limit: 20, windowMs: 15 * 60_000 };
    this.redeemFailures = new Failures(f.limit, f.windowMs, { now: this.now, what: 'too many invalid links or codes from this address' });
  }

  private mac(...parts: string[]): string {
    return createHmac('sha256', this.o.secret).update(parts.join('\u0000')).digest('base64url');
  }

  /** Six (or more) digits, uniform: values from a biased tail of the random range are thrown away and redrawn. */
  private code(): string {
    const n = 10 ** this.digits;
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const v = this.random(4).readUInt32BE(0);
      if (v < limit) return String(v % n).padStart(this.digits, '0');
    }
  }

  /** Makes a link token or a code. Asking too often, for one person or from one address, throws `Limited`. */
  issue(a: Ask): Issued {
    const subject = normalise(a.subject);
    if (!subject || !a.purpose || !a.device) throw new RangeError('a subject, a purpose and a device are needed');
    this.byAddress.take(a.address);
    this.bySubject.take(`${subject}\u0000${a.purpose}`);
    const kind = a.kind ?? 'link';
    const ttl = kind === 'link' ? (this.o.linkTtlMs ?? 15 * 60_000) : (this.o.codeTtlMs ?? 10 * 60_000);
    const t = this.now();
    // Asking again replaces what was asked before: only the newest message works.
    for (const old of this.store.open(subject, a.purpose)) old.revoked = true;
    const secret = kind === 'link' ? this.random(32).toString('base64url') : this.code();
    const id = this.random(12).toString('base64url');
    this.store.put({
      id,
      kind,
      subject,
      purpose: a.purpose,
      secretHash: kind === 'link' ? this.mac('link', secret) : this.mac('code', subject, a.purpose, secret),
      deviceHash: this.mac('device', a.device),
      issuedAt: t,
      expiresAt: t + ttl,
      context: { ...(a.context ?? {}) },
      wrongGuesses: 0,
    });
    return { kind, id, secret, expiresAt: t + ttl };
  }

  /** The address to put in the email. The token is in the fragment, so no server, log or referrer ever sees it. */
  linkUrl(base: string, token: string): string {
    const u = new URL(base);
    if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) throw new RangeError('a sign-in link must be https');
    u.hash = `t=${token}`;
    return u.toString();
  }

  private find(token: string): Record_ | undefined {
    const h = this.mac('link', token);
    // Stored hashes are looked up one by one in constant time; there is no early exit on a partial match.
    let found: Record_ | undefined;
    for (const r of this.store.all()) if (r.kind === 'link' && equal(r.secretHash, h)) found = r;
    return found;
  }

  private check(r: Record_, purpose: string, device: string): void {
    if (r.revoked) throw new NotValid('revoked');
    if (r.usedAt !== undefined) throw new NotValid('used');
    if (this.now() >= r.expiresAt) throw new NotValid('expired');
    if (r.purpose !== purpose) throw new NotValid('wrong_purpose');
    if (!equal(r.deviceHash, this.mac('device', device))) throw new NotValid('wrong_device');
  }

  private rejected(address: string, e: NotValid): never {
    this.redeemFailures.fail(address);
    throw e;
  }

  /**
   * Reads a link without spending it, for the page the link opens (so a mail scanner's GET costs nothing). Says whom
   * and what it is for, with the address masked.
   */
  peek(token: string, purpose: string, device: string, address: string): { subject: string; purpose: string } {
    this.redeemFailures.check(address);
    const r = this.find(token);
    if (!r) return this.rejected(address, new NotValid('unknown'));
    try {
      this.check(r, purpose, device);
    } catch (e) {
      return this.rejected(address, e as NotValid);
    }
    return { subject: maskSubject(r.subject), purpose: r.purpose };
  }

  /** Spends a link. Once only: a second try, from anywhere, is refused. A wrong device or purpose does not spend it. */
  redeem(token: string, purpose: string, device: string, address: string): Redeemed {
    this.redeemFailures.check(address);
    const r = this.find(token);
    if (!r) return this.rejected(address, new NotValid('unknown'));
    try {
      this.check(r, purpose, device);
    } catch (e) {
      return this.rejected(address, e as NotValid);
    }
    r.usedAt = this.now();
    return { subject: r.subject, purpose: r.purpose, context: r.context, issuedAt: r.issuedAt };
  }

  /**
   * Spends a code for a person. A code is short, so it is only ever checked against that person's newest one, and
   * after `maxGuesses` wrong tries it is dead and a new one must be asked for.
   */
  redeemCode(subject: string, code: string, purpose: string, device: string, address: string): Redeemed {
    this.redeemFailures.check(address);
    const s = normalise(subject);
    const r = this.store.open(s, purpose).find((x) => x.kind === 'code');
    if (!r) return this.rejected(address, new NotValid('unknown'));
    try {
      this.check(r, purpose, device);
    } catch (e) {
      return this.rejected(address, e as NotValid);
    }
    if (!/^\d+$/.test(code) || !equal(r.secretHash, this.mac('code', s, purpose, code))) {
      r.wrongGuesses++;
      if (r.wrongGuesses >= (this.o.maxGuesses ?? 5)) r.revoked = true;
      return this.rejected(address, new NotValid(r.revoked ? 'locked' : 'unknown'));
    }
    r.usedAt = this.now();
    return { subject: r.subject, purpose: r.purpose, context: r.context, issuedAt: r.issuedAt };
  }

  /** Cancels everything outstanding for a person (all purposes, or one): after a password change, or a report of theft. */
  revoke(subject: string, purpose?: string): number {
    let n = 0;
    for (const r of this.store.all())
      if (r.subject === normalise(subject) && (purpose === undefined || r.purpose === purpose) && r.usedAt === undefined && !r.revoked) {
        r.revoked = true;
        n++;
      }
    return n;
  }

  /** Forgets what can no longer matter: expired for a day, used or revoked for a day. Returns how many. */
  sweep(graceMs = 24 * 3600_000): number {
    const t = this.now();
    let n = 0;
    for (const r of this.store.all()) {
      const done = r.usedAt ?? (r.revoked ? r.issuedAt : undefined);
      if (t >= r.expiresAt + graceMs || (done !== undefined && t >= done + graceMs)) {
        this.store.delete(r.id);
        n++;
      }
    }
    return n;
  }
}

/** "ana.lopez@example.org" as "a***@example.org", for showing back who a link is for. */
export function maskSubject(s: string): string {
  const at = s.lastIndexOf('@');
  if (at < 1) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}
