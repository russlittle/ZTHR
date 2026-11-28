/**
 * UAT overrides: what a tester needs to reach a case without editing data by hand. In a test environment, and only
 * there, a tester can switch a feature flag for themselves, set their own clock (to see what happens after a trial
 * ends), or act with a different role, each for a limited time with a reason. Overrides apply to the tester alone,
 * end on their own, show on a banner so nobody forgets one is on, and are recorded in a bounded in-memory log of
 * the most recent overrides, each also handed to a caller-provided sink for durable storage. Outside the named test
 * environments, and in production however it is spelled, every override is refused, whatever the caller says.
 */

export type Override = { readonly kind: 'flag'; readonly flag: string; readonly on: boolean } | { readonly kind: 'clock'; readonly at: string } | { readonly kind: 'role'; readonly role: string };

/** The environments overrides work in unless the caller names others. */
export const TEST_ENVS: readonly string[] = ['local', 'dev', 'development', 'test', 'testing', 'qa', 'uat', 'staging', 'sandbox', 'preview'];

export interface Active {
  readonly id: number;
  readonly who: string;
  readonly o: Override;
  readonly why: string;
  readonly until: number;
}

/** One override as recorded. */
export interface OverrideLog {
  readonly at: string;
  readonly who: string;
  readonly what: string;
  readonly why: string;
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

export class Uat {
  private readonly list: Active[] = [];
  /** The override log: the most recent overrides in memory, with counts of what was recorded, handed to the sink and evicted. */
  readonly records: BoundedLog<OverrideLog>;
  private readonly env: string;
  private readonly now: () => number;
  private readonly allowedRoles: readonly string[];
  private readonly testEnvs: readonly string[];

  /**
   * `testEnvs` names the environments overrides work in; any other environment, production above all, refuses them.
   * `log` bounds the in-memory record and names its durable sink.
   */
  constructor(o: { env: string; now?: () => number; allowedRoles?: readonly string[]; testEnvs?: readonly string[]; log?: LogOptions<OverrideLog> }) {
    this.records = new BoundedLog(o.log);
    this.env = o.env.trim().toLowerCase();
    this.testEnvs = (o.testEnvs ?? TEST_ENVS).map((e) => e.trim().toLowerCase());
    this.now = o.now ?? Date.now;
    this.allowedRoles = o.allowedRoles ?? ['member', 'editor', 'viewer'];
  }

  /** The most recent overrides, oldest first. */
  get log(): readonly OverrideLog[] {
    return this.records.entries;
  }

  private live(): Active[] {
    return this.list.filter((a) => a.until > this.now());
  }

  set(who: string, o: Override, why: string, minutes = 60): Active {
    if (/^(prod|prd|live)/.test(this.env)) throw new Error('overrides are not available in production');
    if (!this.testEnvs.includes(this.env)) throw new Error(`overrides are not available in ${this.env}: it is not a test environment`);
    if (why.trim().length < 8) throw new Error('say why, so the record makes sense later');
    if (!(minutes > 0)) throw new Error('an override lasts some minutes');
    if (minutes > 8 * 60) throw new Error('an override lasts at most a working day');
    if (o.kind === 'role' && !this.allowedRoles.includes(o.role)) throw new Error(`${o.role} cannot be taken on as an override`);
    if (o.kind === 'clock' && Number.isNaN(Date.parse(o.at))) throw new Error('the clock needs a date and time');
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i]!;
      if (a.who === who && a.o.kind === o.kind && (o.kind !== 'flag' || (a.o as { flag: string }).flag === o.flag)) this.list.splice(i, 1);
    }
    // Ids follow every override ever recorded, not the bounded log's length, so they never repeat.
    const a: Active = { id: this.records.recorded + 1, who, o, why, until: this.now() + minutes * 60_000 };
    this.list.push(a);
    this.records.push({ at: new Date(this.now()).toISOString(), who, what: describe(o), why });
    return a;
  }

  clear(who: string): void {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.who === who) this.list.splice(i, 1);
  }

  /** The flag value for this person, if they have an override. */
  flag(who: string, flag: string): boolean | undefined {
    const a = this.live().find((x) => x.who === who && x.o.kind === 'flag' && x.o.flag === flag);
    return a && a.o.kind === 'flag' ? a.o.on : undefined;
  }

  /** The time as this person should see it. */
  clock(who: string): Date {
    const a = this.live().find((x) => x.who === who && x.o.kind === 'clock');
    return a && a.o.kind === 'clock' ? new Date(a.o.at) : new Date(this.now());
  }

  role(who: string, real: string): string {
    const a = this.live().find((x) => x.who === who && x.o.kind === 'role');
    return a && a.o.kind === 'role' ? a.o.role : real;
  }

  /** What the banner says, or nothing. */
  banner(who: string): string | undefined {
    const mine = this.live().filter((a) => a.who === who);
    if (!mine.length) return undefined;
    const mins = Math.ceil((Math.min(...mine.map((a) => a.until)) - this.now()) / 60_000);
    return `Test overrides on: ${mine.map((a) => describe(a.o)).join('; ')}. The first ends in ${mins} minute${mins === 1 ? '' : 's'}.`;
  }
}

const describe = (o: Override) => (o.kind === 'flag' ? `${o.flag} ${o.on ? 'on' : 'off'}` : o.kind === 'clock' ? `clock set to ${o.at}` : `acting as ${o.role}`);
