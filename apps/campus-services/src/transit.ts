import { BadRequest, CAMPUSES, NotFound, clock, dateParam, hhmm, meters, minutes, rng, service, weekdayOf, type CampusId } from './common.js';

/**
 * Synthetic regional transit service, shaped like a transit agency's GTFS static and GTFS-realtime feeds plus the
 * trip planner most agencies expose: agency, routes, stops, scheduled departures, trips, a planner with one
 * transfer, realtime arrivals with delay, and service alerts.
 */
export interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  campus?: CampusId;
}

interface RouteDef {
  id: string;
  short: string;
  long: string;
  color: string;
  /** Stops in order with minutes from the first stop. */
  stops: [string, number][];
  /** Minutes between buses, and first and last departure from either end, by day type. */
  service: Partial<Record<'weekday' | 'saturday' | 'sunday', { headway: number; first: string; last: string }>>;
}

const S = (id: string, name: string, lat: number, lon: number, campus?: CampusId): Stop => ({ id, name, lat, lon, ...(campus ? { campus } : {}) });

export const STOPS: Stop[] = [
  S('hub', 'Downtown Transit Hub', 39.7595, -84.1916),
  S('sinclair-5th', 'Fifth St and Perry St (Sinclair)', CAMPUSES.sinclair.lat - 0.0012, CAMPUSES.sinclair.lon + 0.0016, 'sinclair'),
  S('sinclair-3rd', 'Third St and Robert Dr (Sinclair)', CAMPUSES.sinclair.lat + 0.001, CAMPUSES.sinclair.lon - 0.0008, 'sinclair'),
  S('salem-catalpa', 'Salem Ave and Catalpa Dr', 39.7905, -84.2276),
  S('salem-hillcrest', 'Salem Ave and Hillcrest Ave', 39.7752, -84.2132),
  S('huffman-linden', 'Huffman Ave and Linden Ave', 39.7591, -84.1606),
  S('xenia-smithville', 'Xenia Ave and Smithville Rd', 39.7487, -84.1493),
  S('wright-union', 'Student Union (Wright State)', CAMPUSES['wright-state'].lat + 0.0006, CAMPUSES['wright-state'].lon + 0.0011, 'wright-state'),
  S('wright-colonel', 'Colonel Glenn Hwy at Wright State', CAMPUSES['wright-state'].lat - 0.0021, CAMPUSES['wright-state'].lon - 0.0015, 'wright-state'),
  S('fairborn-main', 'Main St and Broad St, Fairborn', 39.8209, -84.0194),
  S('ys-xenia', 'Xenia Ave and Corry St, Yellow Springs', 39.8064, -83.8873, 'antioch'),
  S('linden-ave', 'Linden Ave and Smithville Rd', 39.7620, -84.1496),
];

export const ROUTES: RouteDef[] = [
  { id: 'r1', short: '1', long: 'Third Street Crosstown', color: '0B6E99', stops: [['salem-catalpa', 0], ['salem-hillcrest', 7], ['sinclair-3rd', 15], ['hub', 20], ['huffman-linden', 29], ['xenia-smithville', 35]], service: { weekday: { headway: 20, first: '05:30', last: '23:10' }, saturday: { headway: 30, first: '07:00', last: '21:00' }, sunday: { headway: 60, first: '08:00', last: '19:00' } } },
  { id: 'r2', short: '2', long: 'Campus Connector', color: 'B5651D', stops: [['hub', 0], ['sinclair-5th', 4], ['linden-ave', 14], ['wright-colonel', 27], ['wright-union', 31]], service: { weekday: { headway: 30, first: '06:00', last: '22:30' }, saturday: { headway: 60, first: '08:00', last: '18:00' } } },
  { id: 'r11', short: '11', long: 'Fairborn and Yellow Springs', color: '4B7F52', stops: [['wright-union', 0], ['fairborn-main', 12], ['ys-xenia', 34]], service: { weekday: { headway: 60, first: '06:15', last: '21:15' }, saturday: { headway: 120, first: '08:15', last: '18:15' } } },
];

export const HOLIDAYS: Record<string, string> = { '2026-11-26': 'Thanksgiving: no service', '2026-12-25': 'Christmas: no service', '2027-01-01': "New Year's Day: no service" };

const dayType = (date: string): 'weekday' | 'saturday' | 'sunday' => ({ Sat: 'saturday', Sun: 'sunday' } as Record<string, 'saturday' | 'sunday'>)[weekdayOf(date)] ?? 'weekday';

export interface StopTime {
  trip: string;
  route: string;
  headsign: string;
  stop: string;
  time: string; // scheduled, campus local HH:MM (may exceed 24:00 per GTFS)
  min: number;
}

/** Every scheduled trip on a date, both directions, as stop times. */
export function tripsOn(date: string, scenario?: string): { id: string; route: RouteDef; headsign: string; times: StopTime[] }[] {
  if (HOLIDAYS[date] || scenario === 'no-service') return [];
  const out: { id: string; route: RouteDef; headsign: string; times: StopTime[] }[] = [];
  for (const r of ROUTES) {
    const sv = r.service[dayType(date)];
    if (!sv) continue;
    for (const dir of [0, 1] as const) {
      const seq = dir === 0 ? r.stops : [...r.stops].reverse().map(([s, m]) => [s, r.stops[r.stops.length - 1]![1] - m] as [string, number]);
      const headsign = STOPS.find((s) => s.id === seq[seq.length - 1]![0])!.name;
      for (let t = minutes(sv.first); t <= minutes(sv.last); t += sv.headway) {
        const id = `${r.id}-${dir}-${hhmm(t).replace(':', '')}-${date.replace(/-/g, '')}`;
        const skip = scenario === 'detour' && r.id === 'r2' ? 'linden-ave' : undefined;
        out.push({ id, route: r, headsign, times: seq.filter(([s]) => s !== skip).map(([stop, m]) => ({ trip: id, route: r.id, headsign, stop, time: hhmm(t + m), min: t + m })) });
      }
    }
  }
  return out;
}

/** Deterministic delay for a trip, in minutes; heavier in the snow scenario. */
export function delayOf(trip: string, scenario?: string): number {
  const r = rng(`delay|${trip}`)();
  const base = r < 0.6 ? 0 : r < 0.85 ? 2 : r < 0.97 ? 5 : 9;
  return scenario === 'snow-delays' ? base + 10 + Math.floor(rng(`snow|${trip}`)() * 10) : base;
}

export interface Leg {
  route: string;
  routeName: string;
  trip: string;
  from: string;
  to: string;
  depart: string;
  arrive: string;
}

/** Itineraries between two stops: direct trips, and trips with one transfer of at least 3 minutes. */
export function plan(date: string, from: string, to: string, opts: { departAt?: number; arriveBy?: number }, scenario?: string): { legs: Leg[]; depart: string; arrive: string; minutes: number; transfers: number }[] {
  const trips = tripsOn(date, scenario);
  const legsFrom = (a: string, b: string): (Leg & { dm: number; am: number })[] =>
    trips.flatMap((t) => {
      const i = t.times.findIndex((x) => x.stop === a);
      const j = t.times.findIndex((x) => x.stop === b);
      if (i < 0 || j < 0 || j <= i) return [];
      return [{ route: t.route.short, routeName: t.route.long, trip: t.id, from: a, to: b, depart: t.times[i]!.time, arrive: t.times[j]!.time, dm: t.times[i]!.min, am: t.times[j]!.min }];
    });
  const options: { legs: (Leg & { dm: number; am: number })[] }[] = legsFrom(from, to).map((l) => ({ legs: [l] }));
  for (const via of STOPS.map((s) => s.id).filter((s) => s !== from && s !== to)) {
    const first = legsFrom(from, via);
    if (!first.length) continue;
    const second = legsFrom(via, to);
    for (const a of first) {
      const b = second.filter((x) => x.dm >= a.am + 3 && x.route !== a.route).sort((x, y) => x.dm - y.dm)[0];
      if (b) options.push({ legs: [a, b] });
    }
  }
  const shaped = options
    .map((o) => ({ legs: o.legs, dm: o.legs[0]!.dm, am: o.legs[o.legs.length - 1]!.am }))
    .filter((o) => (opts.departAt === undefined || o.dm >= opts.departAt) && (opts.arriveBy === undefined || o.am <= opts.arriveBy));
  const best = opts.arriveBy !== undefined ? shaped.sort((a, b) => b.am - a.am || b.dm - a.dm) : shaped.sort((a, b) => a.am - b.am || b.dm - a.dm);
  const seen = new Set<string>();
  return best
    .filter((o) => {
      const k = o.legs.map((l) => l.trip).join('+');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3)
    .map((o) => ({ legs: o.legs.map(({ dm: _d, am: _a, ...l }) => l), depart: hhmm(o.dm), arrive: hhmm(o.am), minutes: o.am - o.dm, transfers: o.legs.length - 1 }));
}

export const transitInfo = {
  id: 'transit',
  title: 'Regional Transit (synthetic)',
  version: '1.0.0',
  description: 'GTFS-style static data, a trip planner and realtime arrivals for a synthetic regional bus system serving the three campuses.',
  endpoints: [
    { method: 'GET', path: '/gtfs/v1/agency', summary: 'The agency' },
    { method: 'GET', path: '/gtfs/v1/routes', summary: 'Routes with their stops in order' },
    { method: 'GET', path: '/gtfs/v1/stops', summary: 'Stops, all or near a point or on a campus', query: { near: 'lat,lon', radius: 'meters, default 800', campus: 'campus id' } },
    { method: 'GET', path: '/gtfs/v1/stops/:id', summary: 'One stop' },
    { method: 'GET', path: '/gtfs/v1/stops/:id/departures', summary: 'Scheduled departures from a stop', query: { date: 'YYYY-MM-DD', from: 'HH:MM', limit: '1 to 50' } },
    { method: 'GET', path: '/gtfs/v1/trips/:id', summary: 'A trip with every stop time' },
    { method: 'GET', path: '/plan/v1', summary: 'Itineraries between two stops, with up to one transfer', query: { from: 'stop id', to: 'stop id', date: 'YYYY-MM-DD', departAt: 'HH:MM', arriveBy: 'HH:MM' } },
    { method: 'GET', path: '/realtime/v1/arrivals', summary: 'Predicted arrivals at a stop from the service clock', query: { stop: 'stop id', limit: '1 to 20' } },
    { method: 'GET', path: '/realtime/v1/alerts', summary: 'Service alerts in effect' },
  ],
  scenarios: { 'snow-delays': 'every trip runs 10 to 20 minutes late', detour: 'Route 2 skips Linden Ave', 'no-service': 'no buses run' },
} as const;

export function transitService() {
  return service(transitInfo as never, (app) => {
    const stopById = (id: string) => {
      const s = STOPS.find((x) => x.id === id);
      if (!s) throw new NotFound(`no stop ${id}`);
      return s;
    };
    const time = (v: string | undefined, name: string) => {
      if (v === undefined) return undefined;
      if (!/^\d{2}:\d{2}$/.test(v)) throw new BadRequest(`${name} must be HH:MM`);
      return minutes(v);
    };
    app.get('/gtfs/v1/agency', (c) => c.json({ agency_id: 'mvst', agency_name: 'Miami Valley Synthetic Transit', agency_timezone: 'America/New_York', agency_url: 'https://transit.example', fare: { adult: 2.0, student: 1.0, transferMinutes: 90 } }));
    app.get('/gtfs/v1/routes', (c) => c.json({ routes: ROUTES.map((r) => ({ route_id: r.id, route_short_name: r.short, route_long_name: r.long, route_color: r.color, stops: r.stops.map(([s]) => s), service: r.service })) }));
    app.get('/gtfs/v1/stops', (c) => {
      const near = c.req.query('near');
      const campus = c.req.query('campus');
      let list = STOPS.map((s) => ({ ...s }));
      if (campus) list = list.filter((s) => s.campus === campus);
      if (near) {
        const [lat, lon] = near.split(',').map(Number);
        if (lat === undefined || lon === undefined || Number.isNaN(lat) || Number.isNaN(lon)) throw new BadRequest('near must be lat,lon');
        const radius = Number(c.req.query('radius') ?? 800);
        list = list.map((s) => ({ ...s, distance: meters({ lat, lon }, s) })).filter((s) => s.distance <= radius).sort((a, b) => a.distance - b.distance);
      }
      return c.json({ stops: list });
    });
    app.get('/gtfs/v1/stops/:id', (c) => c.json(stopById(c.req.param('id'))));
    app.get('/gtfs/v1/stops/:id/departures', (c) => {
      const s = stopById(c.req.param('id'));
      const date = dateParam(c);
      const from = time(c.req.query('from'), 'from') ?? 0;
      const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 10)));
      const scenario = c.req.header('x-twin-scenario');
      const deps = tripsOn(date, scenario)
        .flatMap((t) => t.times.filter((x, i) => x.stop === s.id && i < t.times.length - 1))
        .filter((x) => x.min >= from)
        .sort((a, b) => a.min - b.min)
        .slice(0, limit)
        .map(({ min: _m, ...x }) => x);
      return c.json({ stop: s.id, date, departures: deps, ...(HOLIDAYS[date] ? { notice: HOLIDAYS[date] } : {}) });
    });
    app.get('/gtfs/v1/trips/:id', (c) => {
      const id = c.req.param('id');
      const date = `${id.slice(-8, -4)}-${id.slice(-4, -2)}-${id.slice(-2)}`;
      const t = tripsOn(date, c.req.header('x-twin-scenario')).find((x) => x.id === id);
      if (!t) throw new NotFound(`no trip ${id}`);
      return c.json({ trip_id: t.id, route_id: t.route.id, headsign: t.headsign, date, stop_times: t.times.map(({ min: _m, ...x }) => x) });
    });
    app.get('/plan/v1', (c) => {
      const from = stopById(c.req.query('from') ?? '').id;
      const to = stopById(c.req.query('to') ?? '').id;
      const date = dateParam(c);
      const departAt = time(c.req.query('departAt'), 'departAt');
      const arriveBy = time(c.req.query('arriveBy'), 'arriveBy');
      return c.json({ from, to, date, itineraries: plan(date, from, to, { departAt, arriveBy }, c.req.header('x-twin-scenario')), ...(HOLIDAYS[date] ? { notice: HOLIDAYS[date] } : {}) });
    });
    app.get('/realtime/v1/arrivals', (c) => {
      const s = stopById(c.req.query('stop') ?? '');
      const { date, min, iso } = clock(c);
      const scenario = c.req.header('x-twin-scenario');
      const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 5)));
      const arrivals = tripsOn(date, scenario)
        .flatMap((t) => t.times.filter((x, i) => x.stop === s.id && i < t.times.length - 1).map((x) => ({ ...x, delay: delayOf(t.id, scenario) })))
        .map((x) => ({ ...x, predictedMin: x.min + x.delay }))
        .filter((x) => x.predictedMin >= min)
        .sort((a, b) => a.predictedMin - b.predictedMin)
        .slice(0, limit)
        .map((x) => ({ trip: x.trip, route: ROUTES.find((r) => r.id === x.route)!.short, headsign: x.headsign, scheduled: x.time, predicted: hhmm(x.predictedMin), delayMinutes: x.delay, inMinutes: x.predictedMin - min }));
      return c.json({ stop: s.id, at: iso, arrivals });
    });
    app.get('/realtime/v1/alerts', (c) => {
      const { date } = clock(c);
      const scenario = c.req.header('x-twin-scenario');
      const alerts = [
        ...(HOLIDAYS[date] ? [{ id: `holiday-${date}`, effect: 'NO_SERVICE', header: HOLIDAYS[date], routes: ROUTES.map((r) => r.short) }] : []),
        ...(scenario === 'snow-delays' ? [{ id: 'snow', effect: 'SIGNIFICANT_DELAYS', header: 'Snow: buses are running 10 to 20 minutes late', routes: ROUTES.map((r) => r.short) }] : []),
        ...(scenario === 'detour' ? [{ id: 'detour-r2', effect: 'DETOUR', header: 'Route 2 is not stopping at Linden Ave and Smithville Rd', routes: ['2'] }] : []),
        ...(scenario === 'no-service' ? [{ id: 'no-service', effect: 'NO_SERVICE', header: 'No buses are running', routes: ROUTES.map((r) => r.short) }] : []),
      ];
      return c.json({ at: clock(c).iso, alerts });
    });
  });
}
