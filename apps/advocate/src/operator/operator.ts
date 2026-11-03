import { randomUUID } from 'node:crypto';
import { Leases, afterLookup, afterSend, due, exhausted, idempotencyKey, unsettled, type Lease } from '@zthr/operator';
import type { Advocate } from '../agents/advocate.js';
import { Schemas, minutesOf, type CampusFeed, type CommutePlan, type TransitNow } from '../integrations/campus.js';
import { addDays, weekday } from '../domain/dates.js';
import type { ClassMeeting } from '../domain/types.js';

/**
 * The persistent operator (Patterns 24 to 27). It keeps the campus feeds fresh, plans each bus rider's trips,
 * syncs class sites, and carries out writes the student asked for, on a schedule, without being asked each time.
 *
 * Bounded by structure, not judgment:
 *  - It runs only the jobs in JOBS. It reaches the network only through the Advocate's egress door, and only the
 *    campus services. It speaks to a student only through the Advocate's delivery gates (quiet hours, limits, tone).
 *  - Each job takes a lease with a heartbeat before it runs, so two operators, or an operator and a session, never
 *    run the same job at once (Pattern 26).
 *  - A write is a dispatch, not a result (Pattern 25). Each carries an idempotency key; after sending, the
 *    operator looks the result up before telling the student it is done. An ambiguous send is re-sent only with
 *    the same key, so it can never book twice.
 *  - When it holds back, it records what the student loses by the hold (Pattern 24).
 */
export const JOBS = ['campus-feeds', 'commute', 'transit-now', 'class-site', 'dispatch', 'verify'] as const;
export type JobId = (typeof JOBS)[number];

export type { Lease };

export interface Dispatch {
  id: string;
  studentId: string;
  kind: 'room-booking' | 'mentor-request';
  /** room-booking: room, date, start, minutes, name. mentor-request: mentor, firstName, note. */
  request: { room?: string; date?: string; start?: string; minutes?: number; name?: string; mentor?: string; firstName?: string; note?: string };
  key: string;
  status: 'queued' | 'sent' | 'ambiguous' | 'confirmed' | 'refused';
  attempts: number;
  result?: { reservationId?: string; requestId?: string; reason?: string; meeting?: { date: string; time: string; where: string } };
  queuedAt: string;
}

export interface TickReport {
  at: string;
  ran: string[];
  skipped: { job: string; reason: string }[];
  held: { job: string; loss: string }[];
  failed: { job: string; reason: string }[];
}

const SHARED = '_operator';

export class Operator {
  readonly id: string;
  private readonly leases: Leases;
  constructor(
    private readonly a: Advocate,
    id?: string,
  ) {
    this.id = id ?? `op-${randomUUID().slice(0, 6)}`;
    this.leases = new Leases(a.store, this.id, { owner: SHARED, collection: 'leases' });
  }

  // ---------- leases (Pattern 26) ----------

  lease(job: string, now: Date): Lease | undefined {
    return this.leases.take(job, now);
  }

  heartbeat(job: string, now: Date): boolean {
    return this.leases.beat(job, now);
  }

  release(job: string): void {
    this.leases.release(job);
  }

  // ---------- the tick ----------

  /** Runs every due job once. Safe to call as often as you like; leases keep it single. */
  async tick(now: Date = this.a.clock()): Promise<TickReport> {
    const report: TickReport = { at: now.toISOString(), ran: [], skipped: [], held: [], failed: [] };
    const run = async (job: string, fn: () => Promise<unknown>) => {
      const r = await this.leases.run(job, now, fn);
      if (r.status === 'ran') report.ran.push(job);
      else if (r.status === 'skipped') report.skipped.push({ job, reason: r.reason });
      else report.failed.push({ job, reason: r.reason });
    };
    const students = this.a.studentIds();
    for (const campus of [...new Set(students.map((s) => this.a.student(s).enrollment.college))]) await run(`campus-feeds:${campus}`, () => this.refreshCampus(campus, now));
    for (const sid of students) {
      const plan = this.a.commuteSettings(sid);
      if (plan.mode === 'bus' && plan.homeStop) {
        await run(`commute:${sid}`, () => this.refreshCommute(sid, now));
        await run(`transit-now:${sid}`, () => this.refreshTransitNow(sid, now));
      } else if (plan.mode === 'bus') report.held.push({ job: `commute:${sid}`, loss: 'No leave-by times until the student picks a home stop.' });
      if (this.a.classSiteConnected(sid)) await run(`class-site:${sid}`, () => this.a.syncClassSite(sid));
    }
    await run('dispatch', () => this.dispatch(now));
    await run('verify', () => this.verify());
    this.a.evidence.append('operator_tick', this.id, { ran: report.ran.length, skipped: report.skipped.length, held: report.held.length, failed: report.failed.length });
    return report;
  }

  // ---------- feeds ----------

  async refreshCampus(campus: string, now: Date): Promise<CampusFeed> {
    const c = this.a.campus;
    const date = this.a.localDate(now);
    const unknown: string[] = [];
    const locations = await c.get('dining', `/v1/locations?campus=${campus}`, Schemas.locations);
    const feed: CampusFeed = { campus, fetchedAt: now.toISOString(), date, locations: [], hours: {}, menus: {}, spaces: [], events: [], postings: [], mentors: [], stops: [], unknown };
    if (locations.ok) {
      feed.locations = locations.data.locations;
      for (const l of feed.locations) {
        const h = await c.get('dining', `/v1/locations/${l.id}/hours?date=${date}&days=7`, Schemas.hours);
        if (!h.ok) {
          unknown.push(`hours:${l.id}`);
          continue;
        }
        feed.hours[l.id] = h.data.days;
        for (const p of h.data.days[0]?.periods ?? []) {
          const m = await c.get('dining', `/v1/menus?location=${l.id}&date=${date}&period=${encodeURIComponent(p.name)}`, Schemas.menu);
          if (m.ok) feed.menus[`${l.id}|${p.name}`] = m.data.items;
          else unknown.push(`menu:${l.id}:${p.name}`);
        }
      }
    } else unknown.push(`dining: ${locations.reason}`);
    const spaces = await c.get('places', `/v1/spaces?campus=${campus}`, Schemas.spaces);
    if (spaces.ok) feed.spaces = spaces.data.spaces;
    else unknown.push(`spaces: ${spaces.reason}`);
    const events = await c.get('places', `/v1/events?campus=${campus}&from=${date}&days=7`, Schemas.events);
    if (events.ok) feed.events = events.data.events;
    else unknown.push(`events: ${events.reason}`);
    const postings = await c.get('careers', `/v1/postings?campus=${campus}&asOf=${date}`, Schemas.postings);
    if (postings.ok) feed.postings = postings.data.postings;
    else unknown.push(`postings: ${postings.reason}`);
    const mentors = await c.get('careers', `/v1/mentors?campus=${campus}`, Schemas.mentors);
    if (mentors.ok) feed.mentors = mentors.data.mentors;
    else unknown.push(`mentors: ${mentors.reason}`);
    const stops = await c.get('transit', '/gtfs/v1/stops', Schemas.stops);
    if (stops.ok) feed.stops = stops.data.stops;
    else unknown.push(`stops: ${stops.reason}`);
    this.a.store.put('campus_feeds', campus, SHARED, feed);
    return feed;
  }

  async refreshCommute(sid: string, now: Date): Promise<CommutePlan[]> {
    const s = this.a.student(sid);
    const { homeStop } = this.a.commuteSettings(sid);
    const feed = this.a.campusFeed(s.enrollment.college);
    const targets = (feed?.stops ?? []).filter((x) => x.campus === s.enrollment.college).map((x) => x.id);
    if (!homeStop || !targets.length) return [];
    const classes = this.a.store.list<ClassMeeting>('classes', sid);
    const today = this.a.localDate(now);
    const plans: CommutePlan[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(today, i);
      const first = classes.filter((c) => c.days.includes(weekday(date) as ClassMeeting['days'][number])).sort((x, y) => x.start.localeCompare(y.start))[0];
      if (!first) continue;
      const by = Math.max(0, minutesOf(first.start) - 10);
      const arriveBy = `${String(Math.floor(by / 60)).padStart(2, '0')}:${String(by % 60).padStart(2, '0')}`;
      // Plan to every stop on the campus and keep the best: leave latest, then fewest transfers.
      const found: { to: string; its: CommutePlan['itineraries']; notice?: string }[] = [];
      for (const to of targets) {
        const r = await this.a.campus.get('transit', `/plan/v1?from=${homeStop}&to=${to}&date=${date}&arriveBy=${arriveBy}`, Schemas.plan);
        if (r.ok) found.push({ to, its: r.data.itineraries, ...(r.data.notice ? { notice: r.data.notice } : {}) });
      }
      if (!found.length) continue;
      const all = found.flatMap((f) => f.its.map((it) => ({ to: f.to, it }))).sort((x, y) => minutesOf(y.it.depart) - minutesOf(x.it.depart) || x.it.transfers - y.it.transfers);
      const to = all[0]?.to ?? found[0]!.to;
      const notice = found.find((f) => f.notice)?.notice;
      const p: CommutePlan = { date, course: first.course, classStart: first.start, from: homeStop, to, itineraries: all.filter((x) => x.to === to).map((x) => x.it), ...(notice ? { notice } : {}), fetchedAt: now.toISOString() };
      this.a.store.put('commute_plans', `${sid}|${date}`, sid, p);
      plans.push(p);
      this.heartbeat(`commute:${sid}`, now);
    }
    return plans;
  }

  async refreshTransitNow(sid: string, now: Date): Promise<TransitNow | undefined> {
    const { homeStop } = this.a.commuteSettings(sid);
    if (!homeStop) return undefined;
    const at = now.toISOString();
    const arr = await this.a.campus.get('transit', `/realtime/v1/arrivals?stop=${homeStop}&at=${at}&limit=6`, Schemas.arrivals);
    const al = await this.a.campus.get('transit', `/realtime/v1/alerts?at=${at}`, Schemas.alerts);
    if (!arr.ok) return undefined;
    const t: TransitNow = { stop: homeStop, at, arrivals: arr.data.arrivals, alerts: al.ok ? al.data.alerts : [] };
    this.a.store.put('transit_now', sid, sid, t);
    return t;
  }

  // ---------- writes: dispatch, then verify (Pattern 25) ----------

  queue(d: Omit<Dispatch, 'id' | 'key' | 'status' | 'attempts' | 'queuedAt'>, now: Date): Dispatch {
    const key = idempotencyKey(d.studentId, d.kind, d.request);
    const existing = this.a.store.get<Dispatch>('dispatches', key);
    if (existing) return existing;
    const full: Dispatch = { ...d, id: key, key, status: 'queued', attempts: 0, queuedAt: now.toISOString() };
    this.a.store.put('dispatches', key, d.studentId, full);
    return full;
  }

  dispatches(sid: string): Dispatch[] {
    return this.a.store.list<Dispatch>('dispatches', sid);
  }

  private all(): Dispatch[] {
    return this.a.studentIds().flatMap((s) => this.dispatches(s));
  }

  async dispatch(now: Date): Promise<void> {
    for (const d of this.all().filter(due)) {
      if (exhausted(d)) {
        const gave: Dispatch = { ...d, status: 'refused', result: { reason: 'could not reach the booking system after three tries' } };
        this.save(gave);
        this.a.notifyDispatch(d.studentId, gave);
        continue;
      }
      const r =
        d.kind === 'mentor-request'
          ? await this.a.campus.post('careers', `/v1/mentors/${d.request.mentor}/requests`, { firstName: d.request.firstName, note: d.request.note }, Schemas.mentorRequest, { 'idempotency-key': d.key })
          : await this.a.campus.post('places', `/v1/rooms/${d.request.room}/reservations`, { date: d.request.date, start: d.request.start, minutes: d.request.minutes, name: d.request.name }, Schemas.reservation, { 'idempotency-key': d.key });
      const next = afterSend<NonNullable<Dispatch['result']>, Dispatch>(
        d,
        r.ok ? { ok: true, result: d.kind === 'mentor-request' ? { requestId: r.data.id } : { reservationId: r.data.id } } : { ok: false, status: r.status ?? 0, reason: r.reason },
        (status) => ({ reason: status === 409 ? (d.kind === 'mentor-request' ? 'the mentor has no open time' : 'that time was taken') : 'the request was refused' }),
      );
      this.save(next);
      if (next.status === 'refused') this.a.notifyDispatch(d.studentId, next);
      this.heartbeat('dispatch', now);
    }
  }

  async verify(): Promise<void> {
    for (const d of this.all().filter(unsettled)) {
      if (d.kind === 'mentor-request') {
        const m = await this.a.campus.get('careers', `/v1/requests?key=${d.key}`, Schemas.mentorRequests);
        const found = m.ok ? m.data.requests[0] : undefined;
        if (!found || found.status === 'pending') continue;
        const done = afterLookup<NonNullable<Dispatch['result']>, Dispatch>(d, found.status === 'accepted' ? { outcome: 'confirmed', result: { requestId: found.id, ...(found.meeting ? { meeting: found.meeting } : {}) } } : { outcome: 'refused', result: { requestId: found.id, reason: found.reason ?? 'declined' } });
        this.save(done);
        this.a.notifyDispatch(d.studentId, done);
        continue;
      }
      const r = await this.a.campus.get('places', `/v1/reservations?key=${d.key}`, Schemas.reservationsByKey);
      if (!r.ok) continue;
      const found = r.data.reservations[0];
      if (found && found.room === d.request.room && found.date === d.request.date && found.start === d.request.start) {
        const done = afterLookup<NonNullable<Dispatch['result']>, Dispatch>(d, { outcome: 'confirmed', result: { reservationId: found.id } });
        this.save(done);
        this.a.notifyDispatch(d.studentId, done);
      }
    }
  }

  private save(d: Dispatch): void {
    this.a.store.put('dispatches', d.id, d.studentId, d);
  }
}
