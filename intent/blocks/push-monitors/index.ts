/**
 * Push monitors: the job calls us, not the other way round. A monitor says when a ping is expected (every N
 * minutes, or a five-field cron expression read in UTC), how late it may be (grace), and optionally how long a run
 * may take. From the pings it has received it reports one state: new, up, running, late (inside grace), down
 * (a run was missed), failed (the job said so) or overlong. An alert tracker turns state changes into exactly one
 * alert each, and one recovery. Ping URLs carry an HMAC-SHA-256 token bound to the monitor and its token version,
 * compared in constant time; bumping the version revokes every old URL for that monitor.
 *
 * Cron follows the usual five fields (minute, hour, day of month, month, day of week) with lists, ranges, steps and
 * three-letter month and day names; when both day fields are restricted a day matches if either does (as Vixie
 * cron does). Interval monitors can also be handed to the watchdog block as jobs.
 *
 * Out of scope: receiving HTTP requests and sending the alerts; this block decides, the caller carries.
 */
import { createHmac } from 'node:crypto';
import { equal } from '../crypto/index.ts';
import type { CheckIn, Job } from '../watchdog/index.ts';

export class PushMonitorError extends Error {
  constructor(why: string) {
    super(why);
  }
}

const MIN = 60_000;

// ---------------------------------------------------------------- cron

export interface Cron {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dom: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dow: ReadonlySet<number>;
  readonly domAny: boolean;
  readonly dowAny: boolean;
}

const NAMES: Record<string, Record<string, number>> = {
  month: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dow: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};

function field(text: string, lo: number, hi: number, names?: Record<string, number>): { set: Set<number>; any: boolean } {
  const set = new Set<number>();
  const num = (s: string): number => {
    const n = names && Object.hasOwn(names, s.toLowerCase()) ? names[s.toLowerCase()]! : /^\d{1,3}$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) throw new PushMonitorError(`"${s}" is not allowed here (${lo} to ${hi})`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (range === undefined || range === '' || extra !== undefined) throw new PushMonitorError(`"${part}" is not a cron field`);
    const step = stepText === undefined ? 1 : /^\d{1,3}$/.test(stepText) ? Number(stepText) : NaN;
    if (!Number.isInteger(step) || step < 1) throw new PushMonitorError(`"${part}" has a bad step`);
    let a: number;
    let b: number;
    if (range === '*') {
      a = lo;
      b = hi;
    } else if (range.includes('-')) {
      const [x, y] = range.split('-');
      a = num(x ?? '');
      b = num(y ?? '');
      if (a > b) throw new PushMonitorError(`"${range}" runs backwards`);
    } else {
      a = num(range);
      b = stepText === undefined ? a : hi;
    }
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return { set, any: text.startsWith('*') };
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new PushMonitorError('a cron expression has five fields: minute hour day-of-month month day-of-week');
  const [mi, ho, dm, mo, dw] = f as [string, string, string, string, string];
  const dow = field(dw, 0, 7, NAMES.dow);
  if (dow.set.has(7)) dow.set.add(0);
  dow.set.delete(7);
  return { minute: field(mi, 0, 59).set, hour: field(ho, 0, 23).set, dom: field(dm, 1, 31).set, month: field(mo, 1, 12, NAMES.month).set, dow: dow.set, domAny: field(dm, 1, 31).any, dowAny: dow.any };
}

const dayMatches = (c: Cron, d: Date): boolean => {
  const a = c.dom.has(d.getUTCDate());
  const b = c.dow.has(d.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return b;
  if (c.dowAny) return a;
  return a || b;
};

/** The first matching minute strictly after `after` (ms), in UTC; throws if none within eight years (an impossible date such as 31 February). */
export function nextCron(c: Cron, after: number): number {
  const d = new Date(Math.floor(after / MIN) * MIN + MIN);
  const limit = after + 8 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  throw new PushMonitorError('that schedule never happens');
}

// ---------------------------------------------------------------- monitors and pings

export type Schedule = { readonly everyMin: number } | { readonly cron: string };

export interface PushMonitor {
  readonly id: string;
  readonly schedule: Schedule;
  /** Minutes past the due time a ping may arrive before the run counts as missed. */
  readonly graceMin: number;
  /** Minutes a run may take between its start ping and its end; omit when the job does not send start pings. */
  readonly maxRunMin?: number;
  /** When the monitor was created: the first ping is due one period after this. */
  readonly created: number;
  /** Bumped to revoke every ping URL issued before. */
  readonly tokenVersion: number;
  readonly paused?: boolean;
}

export interface Ping {
  readonly at: number;
  readonly kind: 'start' | 'success' | 'fail';
}

export function validate(m: PushMonitor): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(m.id)) throw new PushMonitorError('a monitor id is 1 to 64 letters, digits, dashes or underscores');
  if ('everyMin' in m.schedule) {
    if (!Number.isInteger(m.schedule.everyMin) || m.schedule.everyMin < 1 || m.schedule.everyMin > 525_600) throw new PushMonitorError('everyMin is a whole number of minutes from 1 to 525600');
  } else parseCron(m.schedule.cron);
  if (!(m.graceMin >= 0) || !Number.isFinite(m.graceMin)) throw new PushMonitorError('grace cannot be negative');
  if (m.maxRunMin !== undefined && !(m.maxRunMin > 0)) throw new PushMonitorError('maxRunMin must be positive');
}

/** The next time a ping is due after `from`. */
export function nextDue(m: PushMonitor, from: number): number {
  return 'everyMin' in m.schedule ? from + m.schedule.everyMin * MIN : nextCron(parseCron(m.schedule.cron), from);
}

export type State = 'new' | 'up' | 'running' | 'late' | 'down' | 'failed' | 'overlong' | 'paused';

export interface Report {
  readonly state: State;
  readonly due: number | null;
  /** Scheduled runs that have passed their grace without a ping. */
  readonly missed: number;
  readonly lastPing: Ping | null;
  readonly detail: string;
}

/** What the pings say right now. */
export function evaluate(m: PushMonitor, pings: readonly Ping[], now: number): Report {
  if (m.paused) return { state: 'paused', due: null, missed: 0, lastPing: null, detail: 'paused' };
  const mine = pings.filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
  const ends = mine.filter((p) => p.kind !== 'start');
  const lastEnd = ends.at(-1) ?? null;
  const lastPing = mine.at(-1) ?? null;
  const base = lastEnd ? lastEnd.at : m.created;
  const grace = m.graceMin * MIN;
  const due = nextDue(m, base);

  // A run in progress: a start ping with no end after it.
  const lastStart = [...mine].reverse().find((p) => p.kind === 'start');
  if (lastStart && (!lastEnd || lastEnd.at < lastStart.at)) {
    if (m.maxRunMin !== undefined && now - lastStart.at > m.maxRunMin * MIN) return { state: 'overlong', due, missed: 0, lastPing, detail: `started ${Math.round((now - lastStart.at) / MIN)} minutes ago; allowed ${m.maxRunMin}` };
    if (now <= due + grace || m.maxRunMin !== undefined) return { state: 'running', due, missed: 0, lastPing, detail: 'a run has started' };
  }

  // Slots that have come and gone without an end ping.
  let missed = 0;
  let slot = due;
  while (slot + grace < now && missed < 10_000) {
    missed++;
    slot = nextDue(m, slot);
  }
  if (missed > 0) return { state: 'down', due, missed, lastPing, detail: `${missed} expected ${missed === 1 ? 'ping' : 'pings'} did not arrive` };
  if (lastEnd?.kind === 'fail') return { state: 'failed', due, missed: 0, lastPing, detail: 'the job reported failure' };
  if (now > due) return { state: 'late', due, missed: 0, lastPing, detail: `${Math.round((now - due) / MIN)} minutes late, inside its grace` };
  return { state: lastEnd ? 'up' : 'new', due, missed: 0, lastPing, detail: lastEnd ? 'last run reported success' : 'waiting for the first ping' };
}

// ---------------------------------------------------------------- alerts

export interface Alert {
  readonly monitor: string;
  readonly kind: 'down' | 'failed' | 'overlong' | 'recovered';
  readonly at: number;
  readonly detail: string;
}

const BAD = new Set<State>(['down', 'failed', 'overlong']);

/** Turns a stream of reports into one alert when a monitor goes bad (and again only if it changes how it is bad), and one recovery. */
export class AlertTracker {
  private readonly last = new Map<string, State>();
  step(m: PushMonitor, r: Report, now: number): Alert[] {
    const before = this.last.get(m.id);
    this.last.set(m.id, r.state);
    if (BAD.has(r.state) && r.state !== before) return [{ monitor: m.id, kind: r.state as 'down' | 'failed' | 'overlong', at: now, detail: r.detail }];
    if (!BAD.has(r.state) && before !== undefined && BAD.has(before) && r.state !== 'paused') return [{ monitor: m.id, kind: 'recovered', at: now, detail: `was ${before}` }];
    return [];
  }
}

// ---------------------------------------------------------------- ping tokens

const mac = (secret: string, id: string, version: number) => createHmac('sha256', secret).update(`push-monitor\n${id}\n${version}`).digest('base64url').slice(0, 32);

/** The token that goes in the ping URL: 128 bits of an HMAC bound to the monitor and its token version. */
export const pingToken = (secret: string, m: Pick<PushMonitor, 'id' | 'tokenVersion'>): string => mac(secret, m.id, m.tokenVersion);

export function pingUrl(base: string, secret: string, m: Pick<PushMonitor, 'id' | 'tokenVersion'>, kind: Ping['kind'] = 'success'): string {
  const path = kind === 'success' ? '' : `/${kind}`;
  return `${base.replace(/\/+$/, '')}/ping/${m.id}/${pingToken(secret, m)}${path}`;
}

export interface ParsedPing {
  readonly id: string;
  readonly token: string;
  readonly kind: Ping['kind'];
}

/** Reads a ping path (`/ping/<id>/<token>[/start|/fail]`); anything else is refused. */
export function parsePingPath(path: string): ParsedPing {
  const m = /^\/ping\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{32})(?:\/(start|fail))?\/?$/.exec(path);
  if (!m) throw new PushMonitorError('that is not a ping address');
  return { id: m[1]!, token: m[2]!, kind: (m[3] as 'start' | 'fail' | undefined) ?? 'success' };
}

/** Whether the token belongs to this monitor at its current version, in constant time. */
export const tokenValid = (secret: string, m: Pick<PushMonitor, 'id' | 'tokenVersion'>, token: string): boolean => equal(pingToken(secret, m), token);

/** Accepts a ping path for a monitor and returns the ping, or says why not. A paused monitor still accepts pings. */
export function accept(secret: string, m: PushMonitor, path: string, now: number): Ping {
  const p = parsePingPath(path);
  if (p.id !== m.id || !tokenValid(secret, m, p.token)) throw new PushMonitorError('that ping address is not valid for this monitor');
  return { at: now, kind: p.kind };
}

// ---------------------------------------------------------------- watchdog bridge

/** An interval monitor as a watchdog job, with its pings as check-ins, so one report can cover both kinds of job. */
export function asWatchdog(m: PushMonitor, pings: readonly Ping[]): { job: Job; checkIns: CheckIn[] } {
  if (!('everyMin' in m.schedule)) throw new PushMonitorError('only interval monitors can be handed to the watchdog');
  const job: Job = { name: m.id, everyMin: m.schedule.everyMin, graceMin: m.graceMin, maxMin: m.maxRunMin ?? m.schedule.everyMin };
  const checkIns: CheckIn[] = [];
  let run = 0;
  for (const p of [...pings].sort((a, b) => a.at - b.at)) {
    if (p.kind === 'start') {
      run++;
      checkIns.push({ job: m.id, run: `r${run}`, at: p.at, kind: 'start' });
    } else {
      if (!checkIns.some((c) => c.run === `r${run}` && c.kind === 'start') || checkIns.some((c) => c.run === `r${run}` && c.kind === 'end')) {
        run++;
        checkIns.push({ job: m.id, run: `r${run}`, at: p.at, kind: 'start' });
      }
      checkIns.push({ job: m.id, run: `r${run}`, at: p.at, kind: 'end', ok: p.kind === 'success' });
    }
  }
  return { job, checkIns };
}
