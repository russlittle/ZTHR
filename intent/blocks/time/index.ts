/**
 * Dates and time zones done the way people mean them. Instants are stored in UTC; a wall time ("9:00 on Monday in
 * New York") is turned into an instant for its zone, including across daylight-saving changes (a time that does
 * not exist moves forward; one that happens twice takes the first). Recurrence follows a subset of RFC 5545 RRULE
 * (DAILY, WEEKLY with BYDAY, MONTHLY with BYMONTHDAY or a numbered weekday, YEARLY; INTERVAL, COUNT, UNTIL, EXDATE)
 * and repeats in wall time, so a 9:00 meeting stays at 9:00 after the clocks change.
 */

export interface Wall {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly h: number;
  readonly min: number;
}

/** The wall-clock reading of an instant in a zone. */
export function wallOf(at: Date, tz: string): Wall & { weekday: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!) };
}

/** Minutes the zone is ahead of UTC at an instant. */
export function offset(at: Date, tz: string): number {
  const w = wallOf(at, tz);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant for a wall time in a zone. A skipped time moves forward by the gap; a repeated time takes the earlier. */
export function instant(w: Wall, tz: string): Date {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
  const candidates = [...new Set([offset(new Date(guess - 86_400_000), tz), offset(new Date(guess + 86_400_000), tz)])].map((o) => guess - o * 60_000);
  const exact = candidates.filter((t) => {
    const r = wallOf(new Date(t), tz);
    return r.y === w.y && r.m === w.m && r.d === w.d && r.h === w.h && r.min === w.min;
  });
  if (exact.length) return new Date(Math.min(...exact));
  // In a gap: read the wall time with the offset from before the change, which lands just past the gap.
  return new Date(guess - offset(new Date(guess - 86_400_000), tz) * 60_000);
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export interface Rule {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  readonly interval: number;
  readonly count?: number;
  readonly until?: Date;
  readonly byDay?: readonly { n?: number; day: number }[];
  readonly byMonthDay?: readonly number[];
}

export function parseRule(s: string): Rule {
  const kv = Object.fromEntries(s.replace(/^RRULE:/, '').split(';').map((p) => p.split('=') as [string, string]));
  const freq = kv.FREQ as Rule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw new Error(`unsupported FREQ ${kv.FREQ}`);
  const until = kv.UNTIL ? new Date(kv.UNTIL.replace(/^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$/, (_, y, m, d, _t, h = '23', mi = '59', se = '59') => `${y}-${m}-${d}T${h}:${mi}:${se}Z`)) : undefined;
  return {
    freq,
    interval: kv.INTERVAL ? Number(kv.INTERVAL) : 1,
    ...(kv.COUNT ? { count: Number(kv.COUNT) } : {}),
    ...(until ? { until } : {}),
    ...(kv.BYDAY ? { byDay: kv.BYDAY.split(',').map((x) => {
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x);
      if (!m) throw new Error(`bad BYDAY ${x}`);
      return { ...(m[1] ? { n: Number(m[1]) } : {}), day: DAYS.indexOf(m[2]!) };
    }) } : {}),
    ...(kv.BYMONTHDAY ? { byMonthDay: kv.BYMONTHDAY.split(',').map(Number) } : {}),
  };
}

const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** Occurrences in wall time from a start, up to a limit. */
export function occurrences(start: Wall, tz: string, rule: Rule, o: { limit?: number; after?: Date; before?: Date; exdates?: readonly Date[] } = {}): Date[] {
  const out: Date[] = [];
  const limit = o.limit ?? 500;
  const ex = new Set((o.exdates ?? []).map((d) => d.getTime()));
  let produced = 0;
  const emit = (y: number, m: number, d: number): boolean => {
    const t = instant({ y, m, d, h: start.h, min: start.min }, tz);
    if (t.getTime() < instant(start, tz).getTime()) return true;
    if (rule.until && t > rule.until) return false;
    if (rule.count !== undefined && produced >= rule.count) return false;
    produced++;
    if (ex.has(t.getTime())) return true;
    if (o.before && t >= o.before) return false;
    if (!o.after || t >= o.after) out.push(t);
    return out.length < limit;
  };
  const startDow = dow(start.y, start.m, start.d);
  for (let step = 0; step < 50_000; step++) {
    if (rule.freq === 'DAILY') {
      const dt = new Date(Date.UTC(start.y, start.m - 1, start.d + step * rule.interval));
      if (!emit(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())) break;
    } else if (rule.freq === 'WEEKLY') {
      const days = (rule.byDay?.map((b) => b.day) ?? [startDow]).slice().sort((a, b) => ((a - 1 + 7) % 7) - ((b - 1 + 7) % 7));
      const weekStart = new Date(Date.UTC(start.y, start.m - 1, start.d - ((startDow + 6) % 7) + step * 7 * rule.interval));
      let go = true;
      for (const d of days) {
        const dt = new Date(weekStart.getTime() + ((d + 6) % 7) * 86_400_000);
        if (!(go = emit(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()))) break;
      }
      if (!go) break;
    } else if (rule.freq === 'MONTHLY') {
      const mm = start.m - 1 + step * rule.interval;
      const y = start.y + Math.floor(mm / 12);
      const m = (mm % 12) + 1;
      const n = dim(y, m);
      let days: number[];
      if (rule.byDay?.length)
        days = rule.byDay.flatMap((b) => {
          const all = Array.from({ length: n }, (_, i) => i + 1).filter((d) => dow(y, m, d) === b.day);
          if (b.n === undefined) return all;
          const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
          return pick ? [pick] : [];
        });
      else days = (rule.byMonthDay ?? [start.d]).map((d) => (d < 0 ? n + d + 1 : d)).filter((d) => d >= 1 && d <= n);
      let go = true;
      for (const d of [...new Set(days)].sort((a, b) => a - b)) if (!(go = emit(y, m, d))) break;
      if (!go) break;
    } else {
      const y = start.y + step * rule.interval;
      if (start.m === 2 && start.d === 29 && dim(y, 2) < 29) continue;
      if (!emit(y, start.m, start.d)) break;
    }
  }
  return out;
}

/** Working days between two dates (both inclusive), skipping weekends and listed holidays (YYYY-MM-DD). */
export function workingDays(from: string, to: string, holidays: readonly string[] = []): number {
  const h = new Set(holidays);
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() % 6 !== 0 && !h.has(d.toISOString().slice(0, 10))) n++;
  }
  return n;
}
