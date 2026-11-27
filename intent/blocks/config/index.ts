/**
 * Configuration and secrets: every setting is declared once with its type, default and whether it is a secret;
 * the service reads them all at start and refuses to start when one is missing, malformed or unsafe for the
 * environment, saying which and why. Secrets are fetched by name and never logged; the inventory lists every
 * setting and secret by name with where it is used and when each secret was last rotated, never a value.
 * Drift compares what an environment is running with what was declared and signed.
 */

export type Kind = 'text' | 'number' | 'boolean' | 'url' | 'list' | 'duration';

export interface Setting {
  readonly name: string;
  readonly kind: Kind;
  readonly description: string;
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly default?: string;
  /** Values this setting must never have in production (a debug flag, a test key prefix). */
  readonly unsafeInProduction?: (value: string) => string | null;
  /** Which features read it, for the inventory. */
  readonly usedBy?: readonly string[];
  /** For a secret: the longest it may go between rotations. */
  readonly rotateDays?: number;
}

export type Values = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export class Unsafe extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the service will not start:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

/** Where secrets come from: an environment variable injected by the platform, or a secret manager. */
export interface SecretSource {
  get(name: string): Promise<string | undefined>;
}

export const envSecrets = (env: Readonly<Record<string, string | undefined>>): SecretSource => ({ get: async (n) => env[n] });

const DURATION = /^(\d+)\s*(ms|s|m|h|d)$/;
const toMs = (v: string) => {
  const m = DURATION.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms']!;
};

function convert(s: Setting, raw: string): { value?: string | number | boolean | readonly string[]; problem?: string } {
  switch (s.kind) {
    case 'text':
      return { value: raw };
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) && raw.trim() !== '' ? { value: n } : { problem: `${s.name} must be a number, not "${raw}"` };
    }
    case 'boolean':
      if (/^(true|1|yes|on)$/i.test(raw)) return { value: true };
      if (/^(false|0|no|off)$/i.test(raw)) return { value: false };
      return { problem: `${s.name} must be true or false` };
    case 'url':
      try {
        const u = new URL(raw);
        return /^https?:$/.test(u.protocol) ? { value: raw } : { problem: `${s.name} must be an http or https address` };
      } catch {
        return { problem: `${s.name} must be an address, like https://example.org` };
      }
    case 'list':
      return { value: raw.split(',').map((x) => x.trim()).filter(Boolean) };
    case 'duration': {
      const ms = toMs(raw);
      return ms === null ? { problem: `${s.name} must be a duration like 30s, 5m or 2h` } : { value: ms };
    }
  }
}

/**
 * Reads every declared setting. Plain settings come from `env`; secrets from `secrets`. Every problem is
 * collected and reported together, so one deploy shows everything wrong.
 */
export async function load(decl: readonly Setting[], env: Readonly<Record<string, string | undefined>>, secrets: SecretSource, o: { production: boolean }): Promise<Values> {
  const out: Record<string, string | number | boolean | readonly string[]> = {};
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of decl) {
    if (seen.has(s.name)) problems.push(`${s.name} is declared twice`);
    seen.add(s.name);
    const raw = s.secret ? await secrets.get(s.name) : (env[s.name] ?? s.default);
    if (raw === undefined || raw === '') {
      if (s.required) problems.push(`${s.name} is required: ${s.description}`);
      continue;
    }
    const c = convert(s, raw);
    if (c.problem) {
      problems.push(s.secret ? `${s.name} is not in the expected form` : c.problem);
      continue;
    }
    if (o.production && s.unsafeInProduction) {
      const why = s.unsafeInProduction(raw);
      if (why) problems.push(`${s.name} ${why}`);
    }
    out[s.name] = c.value!;
  }
  if (problems.length) throw new Unsafe(problems);
  return out;
}

/** A copy safe to log: every secret's value replaced by a marker. */
export function redacted(decl: readonly Setting[], v: Values): Record<string, unknown> {
  const secret = new Set(decl.filter((s) => s.secret).map((s) => s.name));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secret.has(k) ? '[secret]' : x]));
}

export interface InventoryLine {
  readonly name: string;
  readonly kind: Kind;
  readonly secret: boolean;
  readonly set: boolean;
  readonly usedBy: readonly string[];
  readonly lastRotated?: string;
  readonly rotationDue?: string;
  readonly overdue?: boolean;
}

/** Every setting and secret by name, where used, and each secret's rotation state. Never a value. */
export function inventory(decl: readonly Setting[], v: Values, rotated: Readonly<Record<string, string>>, now = new Date()): InventoryLine[] {
  return decl.map((s) => {
    const base = { name: s.name, kind: s.kind, secret: !!s.secret, set: s.name in v, usedBy: s.usedBy ?? [] };
    if (!s.secret || !s.rotateDays) return base;
    const last = rotated[s.name];
    if (!last) return { ...base, overdue: true };
    const due = new Date(Date.parse(last) + s.rotateDays * 86_400_000);
    return { ...base, lastRotated: last, rotationDue: due.toISOString().slice(0, 10), overdue: due.getTime() < now.getTime() };
  });
}

export interface Drift {
  readonly name: string;
  readonly declared: unknown;
  readonly live: unknown;
}

/** Settings whose live value differs from the signed declaration (secrets compared by fingerprint only). */
export function drift(declared: Readonly<Record<string, unknown>>, live: Readonly<Record<string, unknown>>): Drift[] {
  const out: Drift[] = [];
  for (const k of new Set([...Object.keys(declared), ...Object.keys(live)])) if (JSON.stringify(declared[k]) !== JSON.stringify(live[k])) out.push({ name: k, declared: declared[k], live: live[k] });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
