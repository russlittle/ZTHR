/**
 * Booking and finding a time. Each person or resource has working hours in their own zone and busy periods;
 * finding a time returns slots where everyone needed is free and inside their hours, ranked so earlier slots and
 * those nearer the middle of people's days come first. Booking takes a slot only if it is still free, with a
 * buffer either side, so two people can never book the same slot; a hold expires if not confirmed. Only the person
 * who made a booking, or someone with a role allowed to, can cancel it.
 */
import { instant, wallOf } from '../time/index.ts';

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface Calendar {
  readonly id: string;
  readonly tz: string;
  /**
   * Per weekday (0 = Sunday): [startHour, endHour] in local time (9.5 is 9:30); missing means not working. An end
   * before the start crosses midnight: [22, 6] on Monday is Monday 22:00 to Tuesday 06:00. Equal hours mean not
   * working that day; [0, 24] is the whole day.
   */
  readonly hours: Readonly<Partial<Record<number, readonly [number, number]>>>;
  readonly busy: Span[];
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** A local hour of the day (9.5 is 9:30) on a date, as an instant in the zone. */
const at = (y: number, m: number, d: number, hour: number, tz: string) => {
  const mins = Math.round(hour * 60);
  return instant({ y, m, d, h: Math.floor(mins / 60), min: mins % 60 }, tz).getTime();
};

/** The calendar's free spans within a range: inside working hours and outside busy periods. */
export function free(c: Calendar, range: Span): Span[] {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) throw new Error('a range needs a finite start and end');
  const out: Span[] = [];
  // Walk local dates, not 24-hour steps: a day shortened by the clocks going forward must not be stepped over.
  const first = wallOf(new Date(range.start), c.tz);
  for (let i = -1; ; i++) {
    const dt = new Date(Date.UTC(first.y, first.m - 1, first.d + i));
    const [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    if (at(y, m, d, 0, c.tz) >= range.end) break;
    const h = c.hours[dt.getUTCDay()];
    if (!h || h[0] === h[1]) continue;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const end = h[1] > h[0] ? at(y, m, d, h[1], c.tz) : at(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h[1], c.tz);
    const span = { start: Math.max(at(y, m, d, h[0], c.tz), range.start), end: Math.min(end, range.end) };
    if (span.end > span.start) out.push(span);
  }
  // Hours that cross midnight can run into the next day's: join spans that touch or overlap.
  const joined: Span[] = [];
  for (const sp of out.sort((a, b) => a.start - b.start)) {
    const last = joined.at(-1);
    if (last && sp.start <= last.end) joined[joined.length - 1] = { start: last.start, end: Math.max(last.end, sp.end) };
    else joined.push(sp);
  }
  const busy = [...c.busy].sort((a, b) => a.start - b.start);
  return joined
    .flatMap((sp) => {
      let pieces = [sp];
      for (const b of busy) pieces = pieces.flatMap((p) => (overlaps(p, b) ? [{ start: p.start, end: b.start }, { start: b.end, end: p.end }].filter((x) => x.end > x.start) : [p]));
      return pieces;
    });
}

const intersect = (a: Span[], b: Span[]) => a.flatMap((x) => b.filter((y) => overlaps(x, y)).map((y) => ({ start: Math.max(x.start, y.start), end: Math.min(x.end, y.end) })));

/** Slots of `minutes` where all calendars are free, on a step grid, best first. */
export function findTime(cals: readonly Calendar[], range: Span, minutes: number, o: { stepMinutes?: number; limit?: number } = {}): Span[] {
  if (!(minutes > 0)) throw new Error('a slot length must be more than zero minutes');
  if (o.stepMinutes !== undefined && !(o.stepMinutes > 0)) throw new Error('the step must be more than zero minutes');
  if (!cals.length) return [];
  let common = free(cals[0]!, range);
  for (const c of cals.slice(1)) common = intersect(common, free(c, range));
  const len = minutes * 60_000;
  const step = (o.stepMinutes ?? 15) * 60_000;
  const slots: Span[] = [];
  for (const sp of common) for (let t = Math.ceil(sp.start / step) * step; t + len <= sp.end; t += step) slots.push({ start: t, end: t + len });
  // Distance of the slot's middle from the middle of each person's working day, in hours, round the clock: the day
  // is yesterday when the slot falls in the part of yesterday's hours that crossed midnight, else the slot's own.
  const comfort = (s: Span) =>
    cals.reduce((sum, c) => {
      const w = wallOf(new Date((s.start + s.end) / 2), c.tz);
      const x = w.h + w.min / 60;
      const today = c.hours[w.weekday];
      const yesterday = c.hours[(w.weekday + 6) % 7];
      const h = yesterday && yesterday[1] < yesterday[0] && x < yesterday[1] ? yesterday : today;
      const mid = h ? ((h[0] + (h[1] < h[0] ? h[1] + 24 : h[1])) / 2) % 24 : 13;
      const dist = Math.abs(x - mid) % 24;
      return sum + Math.min(dist, 24 - dist);
    }, 0);
  const day = (t: number) => Math.floor(t / 86_400_000);
  return slots.sort((a, b) => day(a.start) - day(b.start) || comfort(a) - comfort(b) || a.start - b.start).slice(0, o.limit ?? 5);
}

export interface Booking {
  readonly id: number;
  readonly resource: string;
  readonly span: Span;
  readonly by: string;
  state: 'held' | 'confirmed' | 'cancelled';
  readonly holdUntil?: number;
}

export class Bookings {
  private readonly list: Booking[] = [];
  private readonly now: () => number;
  private readonly bufferMs: number;
  private readonly cancelRoles: ReadonlySet<string>;
  /** `cancelRoles`: roles that may cancel anyone's booking (none by default). */
  constructor(o: { now?: () => number; bufferMinutes?: number; cancelRoles?: readonly string[] } = {}) {
    this.now = o.now ?? Date.now;
    this.bufferMs = (o.bufferMinutes ?? 0) * 60_000;
    this.cancelRoles = new Set(o.cancelRoles ?? []);
  }
  private live(b: Booking): boolean {
    return b.state === 'confirmed' || (b.state === 'held' && (b.holdUntil ?? Infinity) > this.now());
  }
  /** Holds a slot for a few minutes while someone confirms; refuses if it clashes with anything live. */
  hold(resource: string, span: Span, by: string, holdMinutes = 10): Booking {
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end) || span.end <= span.start) throw new Error('a booking must end after it starts');
    const padded = { start: span.start - this.bufferMs, end: span.end + this.bufferMs };
    const clash = this.list.find((b) => b.resource === resource && this.live(b) && overlaps(padded, b.span));
    if (clash) throw new Error('that time has just been taken');
    const b: Booking = { id: this.list.length + 1, resource, span, by, state: 'held', holdUntil: this.now() + holdMinutes * 60_000 };
    this.list.push(b);
    return b;
  }
  confirm(id: number, by: string): Booking {
    const b = this.list[id - 1];
    if (!b || b.by !== by) throw new Error('no such hold');
    if (!this.live(b)) throw new Error('the hold expired; pick the time again');
    b.state = 'confirmed';
    return b;
  }
  /**
   * Cancels a booking for the person who made it, or for someone holding one of the `cancelRoles`. Anyone else is
   * told there is no such booking, as for an id that does not exist, so ids cannot be probed.
   */
  cancel(id: number, by: string, roles: readonly string[] = []): Booking {
    const b = this.list[id - 1];
    if (!b || (b.by !== by && !roles.some((r) => this.cancelRoles.has(r)))) throw new Error('no such booking');
    b.state = 'cancelled';
    return b;
  }
  /** Live bookings as busy spans, to feed back into a calendar. */
  busy(resource: string): Span[] {
    return this.list.filter((b) => b.resource === resource && this.live(b)).map((b) => b.span);
  }
}
