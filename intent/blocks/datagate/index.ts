/**
 * Knowing where sensitive data is, and stopping it going where it should not. Every field in every collection is
 * classified (public, internal, personal, sensitive, secret); an unclassified field is itself a finding. The gate
 * checks each flow (a copy to staging, an export, a log line, a call to an outside service) against rules for its
 * destination and returns allow, mask or deny per field with the rule that decided. Each decision is kept as
 * evidence for an audit: a bounded in-memory log of the most recent decisions, each also handed to a
 * caller-provided sink for durable storage.
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

/** One decision as kept for an audit: the flow's destination, who asked, and the verdict on every field. */
export interface Decision {
  readonly at: string;
  readonly destination: string;
  readonly who: string;
  readonly verdicts: readonly Verdict[];
}

/** How a bounded log keeps its entries: the most recent `keep` in memory, every one handed to `sink` as it is recorded. */
export interface LogOptions<E> {
  /** How many of the most recent entries stay in memory; a whole number of at least 1, 1000 if not given. */
  readonly keep?: number;
  /**
   * Durable storage, provided by the caller: called once with every entry as it is recorded, before anything is
   * evicted from memory. A sink that throws or whose promise rejects is counted in `sinkFailures` and never breaks
   * the work being recorded.
   */
  readonly sink?: (entry: E) => void | Promise<unknown>;
}

/** An in-memory log that holds only the most recent entries, with counts that say what was recorded, handed on and evicted. */
export class BoundedLog<E> {
  private readonly list: E[] = [];
  private readonly keep: number;
  private readonly sink: ((entry: E) => void | Promise<unknown>) | undefined;
  /** Entries recorded since the log was made. */
  recorded = 0;
  /** Entries handed to the sink. */
  handed = 0;
  /** Hand-offs where the sink threw or its promise rejected. */
  sinkFailures = 0;
  /** Entries dropped from memory to stay within `keep`. */
  evicted = 0;

  constructor(o: LogOptions<E> = {}) {
    const keep = o.keep ?? 1000;
    if (!Number.isInteger(keep) || keep < 1) throw new Error('a log keeps a whole number of entries, at least 1');
    this.keep = keep;
    this.sink = o.sink;
  }

  /** The most recent entries, oldest first. */
  get entries(): readonly E[] {
    return this.list;
  }

  push(entry: E): void {
    this.recorded++;
    if (this.sink) {
      this.handed++;
      try {
        const r = this.sink(entry);
        if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => void this.sinkFailures++);
      } catch {
        this.sinkFailures++;
      }
    }
    this.list.push(entry);
    while (this.list.length > this.keep) {
      this.list.shift();
      this.evicted++;
    }
  }
}

export class Gate {
  private readonly levels = new Map<string, Level>();
  private readonly rules: readonly Rule[];
  /** The evidence log: the most recent decisions in memory, with counts of what was recorded, handed to the sink and evicted. */
  readonly decisions: BoundedLog<Decision>;
  private readonly now: () => Date;

  constructor(fields: readonly Field[], rules: readonly Rule[], now: () => Date = () => new Date(), log: LogOptions<Decision> = {}) {
    this.decisions = new BoundedLog(log);
    for (const f of fields) {
      const id = `${f.collection}.${f.field}`;
      const was = this.levels.get(id);
      if (f.level) this.levels.set(id, was ? highest([was, f.level]) : f.level);
    }
    this.rules = rules;
    this.now = now;
  }

  /** The most recent decisions, oldest first. */
  get evidence(): readonly Decision[] {
    return this.decisions.entries;
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
    this.decisions.push({ at: this.now().toISOString(), destination, who, verdicts });
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
