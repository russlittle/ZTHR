import type { Egress } from '@zthr/egress';
import type { z } from 'zod';
import { z as zod } from 'zod';
import { DiningLocation, Event, Itinerary, LmsAnnouncement, LmsAssignment, LmsCourse, MenuItem, Mentor, Period, Posting, Space, Stop, Alert, Arrival, Reservation, MentorRequest } from '../../../campus-services/src/contracts.js';

/**
 * The Advocate's side of the campus services: dining, transit, places, careers and the class site. Each is a base
 * URL in the college's configuration, reached only through the egress door, and every answer is parsed against
 * its contract. A service that is down, slow or drifted gives an unknown with a reason, never a guess.
 *
 * Conversations never wait on the network. The operator refreshes these feeds into the store on a schedule, and
 * the Advocate answers from what was fetched, saying how old it is (Pattern 19: the most deterministic tool that
 * solves the problem; open-now is computed from posted hours, not asked for on every message).
 */
export interface CampusEndpoints {
  dining: string;
  transit: string;
  places: string;
  careers: string;
  lms: string;
}

export const SYNTHETIC_ENDPOINTS: CampusEndpoints = {
  dining: 'https://dining.campus.example',
  transit: 'https://transit.campus.example',
  places: 'https://places.campus.example',
  careers: 'https://careers.campus.example',
  lms: 'https://lms.campus.example',
};

export type Fetched<T> = { ok: true; data: T } | { ok: false; reason: string };

export class CampusClient {
  /**
   * @param clock When set, the Advocate's clock is sent as X-Twin-Clock, so the synthetic services agree with it on
   * what time it is. Real vendors are not sent it.
   */
  constructor(
    private readonly egress: Egress,
    readonly endpoints: CampusEndpoints = SYNTHETIC_ENDPOINTS,
    private readonly clock?: () => Date,
  ) {}

  private extra(): Record<string, string> {
    return this.clock ? { 'x-twin-clock': this.clock().toISOString() } : {};
  }

  async get<S extends z.ZodTypeAny>(service: keyof CampusEndpoints, path: string, schema: S, headers: Record<string, string> = {}): Promise<Fetched<z.infer<S>>> {
    try {
      const r = await this.egress.send({ purpose: `campus:${service}`, method: 'GET', url: `${this.endpoints[service]}${path}`, headers: { accept: 'application/json', ...this.extra(), ...headers } });
      if (r.status !== 200) return { ok: false, reason: `${service} answered ${r.status}` };
      const parsed = schema.safeParse(JSON.parse(r.body));
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: `${service} answered outside its contract` };
    } catch (e) {
      return { ok: false, reason: `${service} could not be reached: ${(e as Error).message}` };
    }
  }

  async post<S extends z.ZodTypeAny>(service: keyof CampusEndpoints, path: string, body: unknown, schema: S, headers: Record<string, string> = {}): Promise<Fetched<z.infer<S>> & { status?: number }> {
    try {
      const r = await this.egress.send({ purpose: `campus:${service}`, method: 'POST', url: `${this.endpoints[service]}${path}`, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...this.extra(), ...headers } });
      if (r.status !== 200 && r.status !== 201) return { ok: false, reason: `${service} answered ${r.status}`, status: r.status };
      const parsed = schema.safeParse(JSON.parse(r.body));
      return parsed.success ? { ok: true, data: parsed.data, status: r.status } : { ok: false, reason: `${service} answered outside its contract`, status: r.status };
    } catch (e) {
      return { ok: false, reason: `${service} could not be reached: ${(e as Error).message}` };
    }
  }
}

export const Schemas = {
  locations: zod.object({ locations: zod.array(DiningLocation) }),
  hours: zod.object({ days: zod.array(zod.object({ date: zod.string(), periods: zod.array(Period), closedReason: zod.string().optional() })) }),
  menu: zod.object({ items: zod.array(MenuItem) }),
  spaces: zod.object({ spaces: zod.array(Space) }),
  events: zod.object({ events: zod.array(Event) }),
  postings: zod.object({ postings: zod.array(Posting) }),
  mentors: zod.object({ mentors: zod.array(Mentor) }),
  stops: zod.object({ stops: zod.array(Stop) }),
  plan: zod.object({ itineraries: zod.array(Itinerary), notice: zod.string().optional() }),
  arrivals: zod.object({ arrivals: zod.array(Arrival) }),
  alerts: zod.object({ alerts: zod.array(Alert) }),
  reservation: Reservation,
  mentorRequest: MentorRequest,
  mentorRequests: zod.object({ requests: zod.array(MentorRequest) }),
  reservationsByKey: zod.object({ reservations: zod.array(Reservation) }),
  courses: zod.array(LmsCourse),
  assignments: zod.array(LmsAssignment),
  announcements: zod.array(LmsAnnouncement),
};

export type DiningLocationT = z.infer<typeof DiningLocation>;
export type MenuItemT = z.infer<typeof MenuItem>;
export type SpaceT = z.infer<typeof Space>;
export type EventT = z.infer<typeof Event>;
export type PostingT = z.infer<typeof Posting>;
export type MentorT = z.infer<typeof Mentor>;
export type StopT = z.infer<typeof Stop>;
export type ItineraryT = z.infer<typeof Itinerary>;
export type ArrivalT = z.infer<typeof Arrival>;
export type AlertT = z.infer<typeof Alert>;
export type AssignmentT = z.infer<typeof LmsAssignment>;

/** What the operator keeps for one campus. */
export interface CampusFeed {
  campus: string;
  fetchedAt: string;
  date: string;
  locations: DiningLocationT[];
  hours: Record<string, { date: string; periods: { name: string; open: string; close: string }[]; closedReason?: string }[]>;
  menus: Record<string, MenuItemT[]>;
  spaces: SpaceT[];
  events: EventT[];
  postings: PostingT[];
  mentors: MentorT[];
  stops: StopT[];
  /** Which parts could not be fetched, and why. Those parts are unknown, not empty. */
  unknown: string[];
}

/** A student's bus plan for one class meeting. */
export interface CommutePlan {
  date: string;
  course: string;
  classStart: string;
  from: string;
  to: string;
  itineraries: ItineraryT[];
  notice?: string;
  fetchedAt: string;
}

/** Live arrivals at the student's stop, fresh for ten minutes. */
export interface TransitNow {
  stop: string;
  at: string;
  arrivals: ArrivalT[];
  alerts: AlertT[];
}

export const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Open at a campus-local date and minute, computed from posted hours, including late hours that run past midnight. */
export function openAt(feed: CampusFeed, date: string, min: number): { location: DiningLocationT; period: string; closes: string }[] {
  const yday = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return feed.locations.flatMap((l) => {
    const days = feed.hours[l.id] ?? [];
    const today = days.find((d) => d.date === date)?.periods.find((p) => min >= minutesOf(p.open) && (minutesOf(p.close) > minutesOf(p.open) ? min < minutesOf(p.close) : true));
    const spill = days.find((d) => d.date === yday)?.periods.find((p) => minutesOf(p.close) <= minutesOf(p.open) && min < minutesOf(p.close));
    const p = today ?? spill;
    return p ? [{ location: l, period: p.name, closes: p.close }] : [];
  });
}
