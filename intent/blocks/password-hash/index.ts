/**
 * Password storage that can be tightened later without a flag day. One `PasswordHasher` hashes with Argon2id (from the
 * argon2id block), scrypt or PBKDF2 (node:crypto), writes a self-describing string, and on every successful login says
 * whether the stored hash is weaker than today's settings (other algorithm, lower cost, older pepper) and hands back
 * the replacement hash to save: rehash on login. A pepper (a server-side secret that is not in the database) is mixed
 * in as HMAC-SHA256(pepper, password) before the slow hash, with a key id kept in the record so peppers can rotate:
 * old records verify with the pepper they were made with and are upgraded to the current one on the next login.
 * Verifying a user who does not exist, a hash that cannot be read, or a pepper that is gone costs about the same as a
 * real check (it hashes against a decoy built from the current settings), so response time does not reveal which
 * accounts exist. Costs read from a stored string are held to limits, so a tampered record cannot demand gigabytes.
 *
 * Stored form: `zthr1:<pepperId or ->:<PHC string>`; PHC strings are `$argon2id$v=19$m=..,t=..,p=..$salt$tag`,
 * `$scrypt$ln=..,r=..,p=..$salt$tag` and `$pbkdf2-sha256$i=..$salt$tag` (sha512 likewise).
 * Presets: OWASP's current minimums (Argon2id 19 MiB t=2 p=1; scrypt N=2^17 r=8 p=1; PBKDF2-SHA256 600,000).
 *
 * Out of scope: bcrypt, reading hashes made by other libraries' private formats, uses of node's native argon2 (the
 * pure TypeScript one is always used), and password policy (see password-policy). Argon2 in TypeScript is several times
 * slower than native code: measure `calibrate` on the real host and size the parameters from that.
 */
import { createHmac, pbkdf2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { argon2idAsync, parseEncoded, encode, Argon2Refused, DEFAULT_LIMITS, type Limits } from '../argon2id/index.ts';

export type Algorithm = 'argon2id' | 'scrypt' | 'pbkdf2-sha256' | 'pbkdf2-sha512';

export interface Argon2Cost {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly lanes: number;
}
export interface ScryptCost {
  /** log2 of N. */
  readonly ln: number;
  readonly r: number;
  readonly p: number;
}
export interface Pbkdf2Cost {
  readonly iterations: number;
}

export interface Config {
  readonly algorithm: Algorithm;
  readonly argon2?: Argon2Cost;
  readonly scrypt?: ScryptCost;
  readonly pbkdf2?: Pbkdf2Cost;
  /** Secrets by id, base64, at least 16 bytes. Keep them outside the database. */
  readonly peppers?: Readonly<Record<string, string>>;
  readonly currentPepper?: string;
  readonly saltBytes?: number;
  readonly tagBytes?: number;
  /** Longest password accepted, in bytes (a guard against being fed megabytes). */
  readonly maxPasswordBytes?: number;
  /** Upper bounds on costs read back from stored strings. */
  readonly ceilings?: Partial<Ceilings>;
  readonly random?: (n: number) => Uint8Array;
  readonly now?: () => number;
}

export interface Ceilings {
  readonly argon2MemoryKiB: number;
  readonly argon2Passes: number;
  readonly argon2Lanes: number;
  readonly scryptLn: number;
  readonly scryptR: number;
  readonly scryptP: number;
  readonly pbkdf2Iterations: number;
}

export const OWASP: { argon2: Argon2Cost; scrypt: ScryptCost; pbkdf2Sha256: Pbkdf2Cost; pbkdf2Sha512: Pbkdf2Cost } = {
  argon2: { memoryKiB: 19456, passes: 2, lanes: 1 },
  scrypt: { ln: 17, r: 8, p: 1 },
  pbkdf2Sha256: { iterations: 600_000 },
  pbkdf2Sha512: { iterations: 210_000 },
};

const DEFAULT_CEILINGS: Ceilings = { argon2MemoryKiB: 256 * 1024, argon2Passes: 10, argon2Lanes: 16, scryptLn: 20, scryptR: 16, scryptP: 8, pbkdf2Iterations: 5_000_000 };

export class PasswordRefused extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Verdict =
  | { readonly ok: true; readonly rehash?: string }
  | { readonly ok: false; readonly reason: 'mismatch' | 'missing' | 'malformed' | 'refused' | 'unknown-pepper' };

// ---------------------------------------------------------------- key derivation (also exported for vectors)

export interface DeriveParams {
  readonly algorithm: Algorithm;
  readonly tagBytes: number;
  readonly argon2?: Argon2Cost;
  readonly scrypt?: ScryptCost;
  readonly pbkdf2?: Pbkdf2Cost;
}

export async function derive(password: Uint8Array, salt: Uint8Array, d: DeriveParams, limits: Limits = DEFAULT_LIMITS): Promise<Uint8Array> {
  switch (d.algorithm) {
    case 'argon2id': {
      const c = d.argon2 ?? OWASP.argon2;
      return argon2idAsync(password, salt, { memoryKiB: c.memoryKiB, passes: c.passes, lanes: c.lanes, tagLength: d.tagBytes }, { limits });
    }
    case 'scrypt': {
      const c = d.scrypt ?? OWASP.scrypt;
      const N = 2 ** c.ln;
      return new Promise((res, rej) => scrypt(password, salt, d.tagBytes, { N, r: c.r, p: c.p, maxmem: 128 * N * c.r + 128 * c.r * c.p + 1024 * 1024 }, (e, k) => (e ? rej(e) : res(new Uint8Array(k)))));
    }
    case 'pbkdf2-sha256':
    case 'pbkdf2-sha512': {
      const c = d.pbkdf2 ?? (d.algorithm === 'pbkdf2-sha256' ? OWASP.pbkdf2Sha256 : OWASP.pbkdf2Sha512);
      return new Promise((res, rej) => pbkdf2(password, salt, c.iterations, d.tagBytes, d.algorithm === 'pbkdf2-sha256' ? 'sha256' : 'sha512', (e, k) => (e ? rej(e) : res(new Uint8Array(k)))));
    }
  }
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/=+$/, '');
const unb64 = (s: string) => {
  if (!/^[A-Za-z0-9+/]+$/.test(s)) throw new PasswordRefused('bad base64');
  return new Uint8Array(Buffer.from(s, 'base64'));
};

interface Parsed {
  readonly pepperId: string;
  readonly d: DeriveParams;
  readonly salt: Uint8Array;
  readonly tag: Uint8Array;
}

// ---------------------------------------------------------------- the hasher

export class PasswordHasher {
  readonly #cfg: Config;
  readonly #ceil: Ceilings;
  readonly #random: (n: number) => Uint8Array;
  readonly #maxBytes: number;
  #decoy: Promise<string> | undefined;

  constructor(cfg: Config) {
    this.#cfg = cfg;
    this.#ceil = { ...DEFAULT_CEILINGS, ...cfg.ceilings };
    this.#random = cfg.random ?? ((n) => randomBytes(n));
    this.#maxBytes = cfg.maxPasswordBytes ?? 1024;
    for (const [id, k] of Object.entries(cfg.peppers ?? {})) {
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(id)) throw new PasswordRefused(`pepper id ${JSON.stringify(id)} is not valid`);
      if (unb64(k.replace(/=+$/, '')).length < 16) throw new PasswordRefused(`pepper ${id} is shorter than 16 bytes`);
    }
    if (cfg.currentPepper !== undefined && !cfg.peppers?.[cfg.currentPepper]) throw new PasswordRefused('currentPepper is not among peppers');
    this.#target(); // validates the configured cost against the ceilings
  }

  #limits(): Limits {
    return { ...DEFAULT_LIMITS, maxMemoryKiB: this.#ceil.argon2MemoryKiB, maxPasses: this.#ceil.argon2Passes, maxLanes: this.#ceil.argon2Lanes };
  }

  #target(): DeriveParams {
    const c = this.#cfg;
    const d: DeriveParams = { algorithm: c.algorithm, tagBytes: c.tagBytes ?? 32, argon2: c.argon2 ?? OWASP.argon2, scrypt: c.scrypt ?? OWASP.scrypt, pbkdf2: c.pbkdf2 ?? (c.algorithm === 'pbkdf2-sha512' ? OWASP.pbkdf2Sha512 : OWASP.pbkdf2Sha256) };
    this.#withinCeilings(d);
    return d;
  }

  #withinCeilings(d: DeriveParams): void {
    const k = this.#ceil;
    if (d.algorithm === 'argon2id') {
      const a = d.argon2!;
      if (a.memoryKiB > k.argon2MemoryKiB || a.passes > k.argon2Passes || a.lanes > k.argon2Lanes || a.memoryKiB < 8 * a.lanes || a.passes < 1 || a.lanes < 1) throw new PasswordRefused('argon2 cost is outside the allowed range');
    } else if (d.algorithm === 'scrypt') {
      const s = d.scrypt!;
      if (s.ln > k.scryptLn || s.ln < 1 || s.r > k.scryptR || s.r < 1 || s.p > k.scryptP || s.p < 1) throw new PasswordRefused('scrypt cost is outside the allowed range');
    } else {
      const p = d.pbkdf2!;
      if (p.iterations > k.pbkdf2Iterations || p.iterations < 1) throw new PasswordRefused('pbkdf2 cost is outside the allowed range');
    }
    if (d.tagBytes < 16 || d.tagBytes > 128) throw new PasswordRefused('tag length must be 16 to 128 bytes');
  }

  #prepare(password: string, pepperId: string): Uint8Array {
    const raw = Buffer.from(password.normalize('NFKC'), 'utf8');
    if (raw.length > this.#maxBytes) throw new PasswordRefused(`password is over ${this.#maxBytes} bytes`);
    if (pepperId === '-') return new Uint8Array(raw);
    const key = this.#cfg.peppers?.[pepperId];
    if (!key) throw new PasswordRefused('unknown pepper');
    // HMAC output is fixed-length and free of the NUL and length quirks some KDFs have with raw passwords.
    return new Uint8Array(createHmac('sha256', Buffer.from(key, 'base64')).update(raw).digest());
  }

  /** Hashes a new password with the current settings. */
  async hash(password: string): Promise<string> {
    const d = this.#target();
    const pepperId = this.#cfg.currentPepper ?? '-';
    const salt = this.#random(this.#cfg.saltBytes ?? 16);
    const tag = await derive(this.#prepare(password, pepperId), salt, d, this.#limits());
    return `zthr1:${pepperId}:${phc(d, salt, tag)}`;
  }

  #parse(stored: string): Parsed {
    const m = /^zthr1:([A-Za-z0-9_.-]{1,32}|-):(\$.+)$/.exec(stored);
    if (!m || stored.length > 1024) throw new PasswordRefused('not a stored password hash');
    const body = m[2]!;
    let parsed: Parsed;
    if (body.startsWith('$argon2id$')) {
      const a = parseEncoded(body);
      if (a.variant !== 'argon2id') throw new PasswordRefused('only argon2id is accepted');
      parsed = { pepperId: m[1]!, d: { algorithm: 'argon2id', tagBytes: a.tag.length, argon2: { memoryKiB: a.params.memoryKiB, passes: a.params.passes, lanes: a.params.lanes } }, salt: a.salt, tag: a.tag };
    } else {
      const s = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(body);
      const p = /^\$(pbkdf2-sha256|pbkdf2-sha512)\$i=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(body);
      if (s) {
        const tag = unb64(s[5]!);
        parsed = { pepperId: m[1]!, d: { algorithm: 'scrypt', tagBytes: tag.length, scrypt: { ln: Number(s[1]), r: Number(s[2]), p: Number(s[3]) } }, salt: unb64(s[4]!), tag };
      } else if (p) {
        const tag = unb64(p[4]!);
        parsed = { pepperId: m[1]!, d: { algorithm: p[1] as Algorithm, tagBytes: tag.length, pbkdf2: { iterations: Number(p[2]) } }, salt: unb64(p[3]!), tag };
      } else throw new PasswordRefused('unknown hash format');
    }
    if (parsed.salt.length < 8) throw new PasswordRefused('salt too short');
    this.#withinCeilings(parsed.d);
    return parsed;
  }

  /** True when `stored` is weaker than the current settings, or cannot be read. */
  needsRehash(stored: string): boolean {
    let p: Parsed;
    try {
      p = this.#parse(stored);
    } catch {
      return true;
    }
    const t = this.#target();
    if (p.pepperId !== (this.#cfg.currentPepper ?? '-')) return true;
    if (p.d.algorithm !== t.algorithm) return true;
    if (p.d.tagBytes < t.tagBytes) return true;
    if (p.salt.length < (this.#cfg.saltBytes ?? 16)) return true;
    if (t.algorithm === 'argon2id') return p.d.argon2!.memoryKiB < t.argon2!.memoryKiB || p.d.argon2!.passes < t.argon2!.passes || p.d.argon2!.lanes < t.argon2!.lanes;
    if (t.algorithm === 'scrypt') return p.d.scrypt!.ln < t.scrypt!.ln || p.d.scrypt!.r < t.scrypt!.r || p.d.scrypt!.p < t.scrypt!.p;
    return p.d.pbkdf2!.iterations < t.pbkdf2!.iterations;
  }

  /**
   * Checks a password against a stored hash, or against nothing (`undefined`: no such user). On success, when the
   * stored hash is out of date, `rehash` carries the new hash to save. A failure never says more than the reason code,
   * and every path does one slow hash.
   */
  async verify(password: string, stored: string | undefined | null): Promise<Verdict> {
    if (Buffer.byteLength(password) > this.#maxBytes) {
      await this.#burn();
      return { ok: false, reason: 'refused' };
    }
    if (stored === undefined || stored === null) {
      await this.#burn(password);
      return { ok: false, reason: 'missing' };
    }
    let p: Parsed;
    try {
      p = this.#parse(stored);
    } catch {
      await this.#burn(password);
      return { ok: false, reason: 'malformed' };
    }
    let input: Uint8Array;
    try {
      input = this.#prepare(password, p.pepperId);
    } catch {
      await this.#burn(password);
      return { ok: false, reason: 'unknown-pepper' };
    }
    const got = await derive(input, p.salt, p.d, this.#limits());
    if (got.length !== p.tag.length || !timingSafeEqual(got, p.tag)) return { ok: false, reason: 'mismatch' };
    if (this.needsRehash(stored)) return { ok: true, rehash: await this.hash(password) };
    return { ok: true };
  }

  /** One real hash with the current settings, so a failing path costs what a passing one does. */
  async #burn(password = ''): Promise<void> {
    this.#decoy ??= this.hash('decoy-password-never-used');
    const stored = await this.#decoy;
    const p = this.#parse(stored);
    try {
      await derive(this.#prepare(password, p.pepperId), p.salt, p.d, this.#limits());
    } catch {
      /* an over-long password was already refused; nothing to do */
    }
  }

  /** Milliseconds one hash takes on this host with the current settings, from the injected clock. */
  async calibrate(runs = 3): Promise<number> {
    const now = this.#cfg.now ?? Date.now;
    const t0 = now();
    for (let i = 0; i < runs; i++) await this.hash('calibration');
    return (now() - t0) / runs;
  }
}

function phc(d: DeriveParams, salt: Uint8Array, tag: Uint8Array): string {
  switch (d.algorithm) {
    case 'argon2id': {
      const a = d.argon2 ?? OWASP.argon2;
      return encode('argon2id', { memoryKiB: a.memoryKiB, passes: a.passes, lanes: a.lanes }, salt, tag);
    }
    case 'scrypt': {
      const s = d.scrypt ?? OWASP.scrypt;
      return `$scrypt$ln=${s.ln},r=${s.r},p=${s.p}$${b64(salt)}$${b64(tag)}`;
    }
    default:
      return `$${d.algorithm}$i=${(d.pbkdf2 ?? OWASP.pbkdf2Sha256).iterations}$${b64(salt)}$${b64(tag)}`;
  }
}

export { Argon2Refused };
