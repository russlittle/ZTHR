import { z } from 'zod';
import type { ServiceId } from './index.js';

/**
 * The contracts the Advocate relies on, one schema per endpoint. The synthetic services are held to them by the
 * contract tests; a real vendor is held to the same schemas by `npm run contract -- --base <service>=<url>` before
 * the Advocate is pointed at it. The Advocate's clients parse every response with these schemas, so a vendor that
 * drifts produces an unknown, never a wrong answer.
 */
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const campus = z.enum(['sinclair', 'wright-state', 'antioch']);

export const DiningLocation = z.object({ id: z.string(), campus, name: z.string(), kind: z.enum(['dining-hall', 'cafe', 'market', 'food-truck', 'grab-and-go']), building: z.string(), lat: z.number(), lon: z.number(), accepts: z.array(z.enum(['card', 'cash', 'meal-plan', 'campus-card'])) });
export const Period = z.object({ name: z.string(), open: hhmm, close: hhmm });
export const MenuItem = z.object({ id: z.string(), name: z.string(), station: z.string(), price: z.number().nonnegative(), calories: z.number().int().nonnegative(), tags: z.array(z.string()), allergens: z.array(z.string()) });

export const Stop = z.object({ id: z.string(), name: z.string(), lat: z.number(), lon: z.number(), campus: campus.optional(), distance: z.number().optional() });
export const Leg = z.object({ route: z.string(), routeName: z.string(), trip: z.string(), from: z.string(), to: z.string(), depart: hhmm, arrive: hhmm });
export const Itinerary = z.object({ legs: z.array(Leg).min(1), depart: hhmm, arrive: hhmm, minutes: z.number().int().nonnegative(), transfers: z.number().int().min(0).max(1) });
export const Arrival = z.object({ trip: z.string(), route: z.string(), headsign: z.string(), scheduled: hhmm, predicted: hhmm, delayMinutes: z.number().int().min(0), inMinutes: z.number().int().min(0) });
export const Alert = z.object({ id: z.string(), effect: z.enum(['NO_SERVICE', 'SIGNIFICANT_DELAYS', 'DETOUR']), header: z.string(), routes: z.array(z.string()) });

export const Space = z.object({ id: z.string(), campus, name: z.string(), building: z.string(), kind: z.enum(['library', 'study-room', 'computer-lab', 'lounge']), noise: z.enum(['quiet', 'group']), outlets: z.boolean(), bookable: z.boolean(), seats: z.number().int().positive(), hours: z.record(z.tuple([hhmm, hhmm])), closes: hhmm.optional() });
export const Event = z.object({ id: z.string(), campus, date: ymd, start: hhmm, end: hhmm, title: z.string(), kind: z.string(), tags: z.array(z.string()), where: z.string(), free: z.boolean() });
export const Reservation = z.object({ id: z.string(), room: z.string(), date: ymd, start: hhmm, minutes: z.number().int(), name: z.string() });

export const Posting = z.object({ id: z.string(), campus, title: z.string(), employer: z.string(), onCampus: z.boolean(), workStudy: z.boolean(), pay: z.number().positive(), hoursPerWeek: z.number().positive(), schedule: z.array(z.object({ day: z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']), start: hhmm, end: hhmm })), fairChance: z.boolean(), field: z.string(), closes: ymd });
export const Mentor = z.object({ id: z.string(), campus: z.union([campus, z.literal('any')]), displayName: z.string(), field: z.string(), role: z.string(), languages: z.array(z.string()), experiences: z.array(z.string()), openSlots: z.number().int().min(0) });

export const LmsCourse = z.object({ id: z.number().int(), name: z.string(), course_code: z.string(), term: z.string() });
export const LmsAssignment = z.object({ id: z.number().int(), name: z.string(), due_at: z.string().datetime({ offset: true }).nullable(), points_possible: z.number(), submission_types: z.array(z.string()), html_url: z.string().url(), course_id: z.number().int() });
export const LmsAnnouncement = z.object({ id: z.number().int(), title: z.string(), message: z.string(), posted_at: z.string(), context_code: z.string() });

/** The probes: requests every implementation of a contract must answer, with the schema each answer must meet. */
export const PROBES: { service: ServiceId; name: string; path: string; headers?: Record<string, string>; schema: z.ZodTypeAny }[] = [
  { service: 'dining', name: 'locations', path: '/v1/locations?campus=sinclair', schema: z.object({ campus, locations: z.array(DiningLocation).min(1) }) },
  { service: 'dining', name: 'hours-week', path: '/v1/locations/sinclair-commons/hours?date=2026-11-23&days=7', schema: z.object({ location: z.string(), days: z.array(z.object({ date: ymd, periods: z.array(Period), closedReason: z.string().optional() })).length(7) }) },
  { service: 'dining', name: 'menu', path: '/v1/menus?location=sinclair-commons&date=2026-11-02&period=Lunch', schema: z.object({ location: z.string(), date: ymd, period: z.string().nullable(), items: z.array(MenuItem), closedReason: z.string().optional() }) },
  { service: 'dining', name: 'open-now', path: '/v1/open-now?campus=wright-state&at=2026-11-03T04:30:00Z', schema: z.object({ campus, at: z.string(), open: z.array(DiningLocation.extend({ period: z.string(), closes: hhmm })) }) },
  { service: 'dining', name: 'search', path: '/v1/search?campus=sinclair&tag=vegan&at=2026-11-02T17:00:00Z', schema: z.object({ campus, at: z.string(), items: z.array(MenuItem.extend({ location: z.string(), locationName: z.string(), closes: hhmm })) }) },
  { service: 'transit', name: 'routes', path: '/gtfs/v1/routes', schema: z.object({ routes: z.array(z.object({ route_id: z.string(), route_short_name: z.string(), route_long_name: z.string(), route_color: z.string(), stops: z.array(z.string()).min(2) })).min(1) }) },
  { service: 'transit', name: 'stops-near', path: '/gtfs/v1/stops?near=39.7573,-84.1985&radius=600', schema: z.object({ stops: z.array(Stop) }) },
  { service: 'transit', name: 'departures', path: '/gtfs/v1/stops/hub/departures?date=2026-11-02&from=07:00&limit=5', schema: z.object({ stop: z.string(), date: ymd, departures: z.array(z.object({ trip: z.string(), route: z.string(), headsign: z.string(), stop: z.string(), time: hhmm })), notice: z.string().optional() }) },
  { service: 'transit', name: 'plan', path: '/plan/v1?from=salem-catalpa&to=wright-union&date=2026-11-02&arriveBy=09:00', schema: z.object({ from: z.string(), to: z.string(), date: ymd, itineraries: z.array(Itinerary), notice: z.string().optional() }) },
  { service: 'transit', name: 'arrivals', path: '/realtime/v1/arrivals?stop=sinclair-5th&at=2026-11-02T13:00:00Z', schema: z.object({ stop: z.string(), at: z.string(), arrivals: z.array(Arrival) }) },
  { service: 'transit', name: 'alerts', path: '/realtime/v1/alerts?at=2026-11-26T15:00:00Z', schema: z.object({ at: z.string(), alerts: z.array(Alert) }) },
  { service: 'places', name: 'spaces', path: '/v1/spaces?campus=wright-state', schema: z.object({ campus, spaces: z.array(Space).min(1) }) },
  { service: 'places', name: 'spaces-open', path: '/v1/spaces/open-now?campus=sinclair&at=2026-11-02T23:00:00Z', schema: z.object({ campus, at: z.string(), open: z.array(Space) }) },
  { service: 'places', name: 'availability', path: '/v1/rooms/sinclair-room-6142/availability?date=2026-11-04', schema: z.object({ room: z.string(), date: ymd, free: z.array(hhmm) }) },
  { service: 'places', name: 'events', path: '/v1/events?campus=sinclair&from=2026-11-02&days=7', schema: z.object({ campus, from: ymd, days: z.number(), events: z.array(Event), campusName: z.string() }) },
  { service: 'careers', name: 'postings', path: '/v1/postings?campus=sinclair', schema: z.object({ campus, postings: z.array(Posting).min(1) }) },
  { service: 'careers', name: 'mentors', path: '/v1/mentors?campus=sinclair&field=healthcare', schema: z.object({ mentors: z.array(Mentor) }) },
  { service: 'lms', name: 'self', path: '/api/v1/users/self', headers: { authorization: 'Bearer lms-demo' }, schema: z.object({ id: z.number(), name: z.string() }) },
  { service: 'lms', name: 'courses', path: '/api/v1/courses', headers: { authorization: 'Bearer lms-demo' }, schema: z.array(LmsCourse).min(1) },
  { service: 'lms', name: 'assignments', path: '/api/v1/courses/19990/assignments', headers: { authorization: 'Bearer lms-demo' }, schema: z.array(LmsAssignment).min(1) },
  { service: 'lms', name: 'announcements', path: '/api/v1/announcements', headers: { authorization: 'Bearer lms-demo' }, schema: z.array(LmsAnnouncement) },
];
