/**
 * Knowing where sensitive data is, and stopping it going where it should not. Every field in every collection is
 * classified (public, internal, personal, sensitive, secret); an unclassified field is itself a finding. The gate
 * checks each flow (a copy to staging, an export, a log line, a call to an outside service) against rules for its
 * destination and returns allow, mask or deny per field with the rule that decided. Each decision can be kept as
 * evidence for an audit.
 */

export type Level = 'public' | 'internal' | 'personal' | 'sensitive' | 'secret';
const ORDER: readonly Level[] = ['public', 'internal', 'personal', 'sensitive', 'secret'];

export interface Field {
  readonly collection: string;
  readonly field: string;
  readonly level?: Level;
  readonly note?: string;
}

const highest = (ls: readonly Level[]): Level => ls.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a));

/** Fields missing a level, fields given two levels (the higher holds), and fields whose names suggest a higher level than they were given. */
export function inventory(fields: readonly Field[]): { byLevel: Record<Level, string[]>; findings: string[] } {
  const byLevel = Object.fromEntries(ORDER.map((l) => [l, [] as string[]])) as unknown as Record<Level, string[]>;
  const findings: string[] = [];
  const hints: [RegExp, Level][] = [[/pass(word)?|secret|token|api_?key|private_?key/i, 'secret'], [/ssn|social|passport|licen[cs]e_?no|diagnos|health|medical|bank|iban|card/i, 'sensitive'], [/email|phone|address|birth|dob|name|ip_?addr/i, 'personal']];
  const given = new Map<string, Level[]>();
  for (const f of fields) if (f.level) given.set(`${f.collection}.${f.field}`, [...(given.get(`${f.collection}.${f.field}`) ?? []), f.level]);
  const done = new Set<string>();
  for (const f of fields) {
    const id = `${f.collection}.${f.field}`;
    const levels = given.get(id);
    if (!levels) {
      if (!done.has(id)) findings.push(`${id} has no classification`);
      done.add(id);
      continue;
    }
    if (done.has(id)) continue;
    done.add(id);
    const level = highest(levels);
    if (new Set(levels).size > 1) findings.push(`${id} is classified twice (${levels.join(', ')}); the higher level holds`);
    byLevel[level].push(id);
    const hint = hints.find(([re]) => re.test(f.field));
    if (hint && ORDER.indexOf(level) < ORDER.indexOf(hint[1])) findings.push(`${id} is ${level} but its name suggests ${hint[1]}`);
  }
  return { byLevel, findings };
}

export interface Rule {
  readonly destination: string | RegExp;
  /** The highest level allowed through as is. */
  readonly allow: Level;
  /** Levels above `allow` up to this are masked; anything higher is denied. */
  readonly mask?: Level;
  readonly why: string;
}

export type Verdict = { readonly field: string; readonly action: 'allow' | 'mask' | 'deny'; readonly level: Level | 'unclassified'; readonly rule: string };

export class Gate {
  private readonly levels = new Map<string, Level>();
  private readonly rules: readonly Rule[];
  readonly evidence: { at: string; destination: string; who: string; verdicts: readonly Verdict[] }[] = [];
  private readonly now: () => Date;

  constructor(fields: readonly Field[], rules: readonly Rule[], now: () => Date = () => new Date()) {
    for (const f of fields) {
      const id = `${f.collection}.${f.field}`;
      const was = this.levels.get(id);
      if (f.level) this.levels.set(id, was ? highest([was, f.level]) : f.level);
    }
    this.rules = rules;
    this.now = now;
  }

  decide(collection: string, fields: readonly string[], destination: string, who: string): Verdict[] {
    const rule = this.rules.find((r) => {
      if (typeof r.destination === 'string') return r.destination === destination;
      r.destination.lastIndex = 0; // a global or sticky pattern would otherwise carry its position into the next call
      return r.destination.test(destination);
    });
    const verdicts = fields.map((f): Verdict => {
      const level = this.levels.get(`${collection}.${f}`);
      if (!level) return { field: f, action: 'deny', level: 'unclassified', rule: 'unclassified fields never leave' };
      if (!rule) return { field: f, action: 'deny', level, rule: `no rule for ${destination}` };
      const i = ORDER.indexOf(level);
      if (i <= ORDER.indexOf(rule.allow)) return { field: f, action: 'allow', level, rule: rule.why };
      if (rule.mask && i <= ORDER.indexOf(rule.mask)) return { field: f, action: 'mask', level, rule: rule.why };
      return { field: f, action: 'deny', level, rule: rule.why };
    });
    this.evidence.push({ at: this.now().toISOString(), destination, who, verdicts });
    return verdicts;
  }

  /** Applies the verdicts to rows: allowed fields copied, masked ones replaced, denied ones dropped. */
  apply(collection: string, rows: readonly Readonly<Record<string, unknown>>[], destination: string, who: string): Record<string, unknown>[] {
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const v = new Map(this.decide(collection, keys, destination, who).map((x) => [x.field, x.action]));
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(r)) {
        const a = v.get(k);
        if (a === 'allow') out[k] = val;
        else if (a === 'mask') out[k] = mask(val);
      }
      return out;
    });
  }
}

/** Keeps the shape, hides the content: "ana@example.org" → "a••@e••••••.org"; numbers keep the last two digits. */
export function mask(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const s = String(v);
  if (/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(s)) {
    const [local, domain] = s.split('@');
    const parts = domain!.split('.');
    const tld = parts.pop();
    return `${local![0]}••@${parts.map((p) => `${p[0]}${'•'.repeat(Math.max(1, p.length - 1))}`).join('.')}.${tld}`;
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 6 && digits.length / s.length > 0.6) return `${'•'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
  return s.length <= 2 ? '••' : `${s[0]}${'•'.repeat(s.length - 1)}`;
}
