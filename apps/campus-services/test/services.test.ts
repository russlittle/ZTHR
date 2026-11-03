// Verifies docs/blocks/campus-services.md
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROBES } from '../src/contracts.js';
import { CLOSURES, HOLIDAYS, LOCATIONS, MENTORS, POSTINGS, ROUTES, SERVICES, SERVICE_IDS, SPACES, STOPS, TOKENS, hoursOn, minutes, tripsOn, weekdayOf } from '../src/index.js';

const FIX = fileURLToPath(new URL('../fixtures', import.meta.url));
const apps = Object.fromEntries(SERVICE_IDS.map((id) => [id, SERVICES[id].make()]));
const get = async (id: keyof typeof apps, path: string, headers: Record<string, string> = {}) => {
  const r = await apps[id]!.request(path, { headers });
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (id: keyof typeof apps, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await apps[id]!.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  return { status: r.status, body: (await r.json()) as any };
};
/** Campus-local wall time to a UTC instant (November 2026 is EST, UTC-5). */
const at = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00-05:00`)).toISOString();
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

describe('every service', () => {
  for (const id of SERVICE_IDS) {
    it(`${id}: health, OpenAPI with every endpoint, 404 for unknown paths, 503 in the outage scenario`, async () => {
      expect((await get(id, '/healthz')).body).toMatchObject({ ok: true, service: id });
      const spec = (await get(id, '/openapi.json')).body;
      expect(Object.keys(spec.paths)).toHaveLength(SERVICES[id].info.endpoints.length);
      expect((await get(id, '/nope')).status).toBe(404);
      expect((await get(id, '/healthz', { 'x-twin-scenario': 'outage' })).status).toBe(503);
    });
  }
  it('every declared endpoint is routed', async () => {
    for (const id of SERVICE_IDS) {
      for (const e of SERVICES[id].info.endpoints.filter((x) => x.method === 'GET')) {
        const path = e.path.replace(':id', 'x');
        const r = await get(id, path, { authorization: 'Bearer lms-demo' });
        expect(r.body.error === 'no such endpoint', `${id} ${e.path}`).toBe(false);
      }
    }
  });
});

describe('contracts and fixtures (Pattern 33)', () => {
  for (const p of PROBES) {
    it(`${p.service} ${p.name}: meets its schema and matches its recorded fixture`, async () => {
      const r = await get(p.service, p.path, p.headers);
      expect(r.status).toBe(200);
      expect(p.schema.safeParse(r.body).success).toBe(true);
      const fx = JSON.parse(readFileSync(`${FIX}/${p.service}/${p.name}.json`, 'utf8'));
      expect(r.body).toEqual(fx.body);
    });
  }
});

describe('dining', () => {
  it('open-now agrees with each location\'s posted hours, every half hour for two weeks (oracle from the record)', async () => {
    for (const date of days('2026-11-16', 14)) {
      for (let m = 0; m < 1440; m += 30) {
        const hh = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        for (const campus of ['sinclair', 'wright-state', 'antioch']) {
          const open = new Set((await get('dining', `/v1/open-now?campus=${campus}&at=${at(date, hh)}`)).body.open.map((l: { id: string }) => l.id));
          for (const l of LOCATIONS.filter((x) => x.campus === campus)) {
            const yday = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
            const today = hoursOn(l, date).periods.some((p) => m >= minutes(p.open) && (minutes(p.close) > minutes(p.open) ? m < minutes(p.close) : true));
            const spill = hoursOn(l, yday).periods.some((p) => minutes(p.close) <= minutes(p.open) && m < minutes(p.close));
            expect(open.has(l.id), `${l.id} ${date} ${hh}`).toBe(today || spill);
          }
        }
      }
    }
  }, 60_000);
  it('every location is closed on every closure day, with the reason', async () => {
    for (const c of CLOSURES) for (const date of days(c.from, 2)) for (const l of LOCATIONS) expect(hoursOn(l, date)).toMatchObject({ periods: [], closedReason: c.reason });
  });
  it('late-night hours run past midnight', async () => {
    const open = (await get('dining', `/v1/open-now?campus=wright-state&at=${at('2026-11-04', '00:30')}`)).body.open;
    expect(open.map((l: { id: string }) => l.id)).toContain('wright-state-late');
  });
  it('menus are the same for the same request, and differ by day', async () => {
    const a = await get('dining', '/v1/menus?location=sinclair-commons&date=2026-11-02&period=Lunch');
    const b = await get('dining', '/v1/menus?location=sinclair-commons&date=2026-11-02&period=Lunch');
    const c = await get('dining', '/v1/menus?location=sinclair-commons&date=2026-11-03&period=Lunch');
    expect(a.body).toEqual(b.body);
    expect(a.body.items.map((i: { name: string }) => i.name)).not.toEqual(c.body.items.map((i: { name: string }) => i.name));
  });
  it('a menu for a period the location does not serve is empty with a reason', async () => {
    const r = await get('dining', '/v1/menus?location=sinclair-perk&date=2026-11-02&period=Dinner');
    expect(r.body).toMatchObject({ items: [], closedReason: 'No Dinner service' });
  });
  it('search honors tag, allergen and price, cheapest first', async () => {
    const r = (await get('dining', `/v1/search?campus=sinclair&tag=vegetarian&avoid=wheat&maxPrice=4&at=${at('2026-11-02', '12:00')}`)).body.items;
    expect(r.length).toBeGreaterThan(0);
    for (const i of r) expect(i.tags.includes('vegetarian') && !i.allergens.includes('wheat') && i.price <= 4).toBe(true);
    expect(r.map((i: { price: number }) => i.price)).toEqual([...r.map((i: { price: number }) => i.price)].sort((x, y) => x - y));
  });
  it('the weather-closure scenario closes everything', async () => {
    expect((await get('dining', `/v1/open-now?campus=sinclair&at=${at('2026-11-02', '12:00')}`, { 'x-twin-scenario': 'weather-closure' })).body.open).toEqual([]);
  });
  it('rejects bad input plainly', async () => {
    expect((await get('dining', '/v1/locations')).status).toBe(400);
    expect((await get('dining', '/v1/locations?campus=harvard')).status).toBe(404);
    expect((await get('dining', '/v1/locations/sinclair-commons/hours?days=40')).status).toBe(400);
    expect((await get('dining', '/v1/search?campus=sinclair&maxPrice=cheap')).status).toBe(400);
    expect((await get('dining', '/v1/open-now?campus=sinclair&at=yesterday')).status).toBe(400);
  });
});

describe('transit', () => {
  it('every trip visits its stops in order with times that only move forward', () => {
    for (const date of days('2026-11-01', 7)) for (const t of tripsOn(date)) for (let i = 1; i < t.times.length; i++) expect(t.times[i]!.min).toBeGreaterThan(t.times[i - 1]!.min);
  });
  it('no service on holidays, and Route 2 and 11 do not run on Sunday', () => {
    for (const d of Object.keys(HOLIDAYS)) expect(tripsOn(d)).toEqual([]);
    const sunday = tripsOn('2026-11-08');
    expect(new Set(sunday.map((t) => t.route.id))).toEqual(new Set(['r1']));
  });
  it('every planned itinerary, for every pair of stops and arrive-by time, is made of real trips that arrive in time', async () => {
    let checked = 0;
    for (const from of STOPS) {
      for (const to of STOPS) {
        if (from.id === to.id) continue;
        for (const by of ['08:00', '12:30', '18:00']) {
          const r = (await get('transit', `/plan/v1?from=${from.id}&to=${to.id}&date=2026-11-04&arriveBy=${by}`)).body;
          for (const it of r.itineraries) {
            expect(minutes(it.arrive)).toBeLessThanOrEqual(minutes(by));
            for (const leg of it.legs) {
              const trip = (await get('transit', `/gtfs/v1/trips/${leg.trip}`)).body;
              const st = trip.stop_times as { stop: string; time: string }[];
              expect(st.find((s) => s.stop === leg.from)?.time, leg.trip).toBe(leg.depart);
              expect(st.find((s) => s.stop === leg.to)?.time, leg.trip).toBe(leg.arrive);
            }
            if (it.legs.length === 2) expect(minutes(it.legs[1].depart) - minutes(it.legs[0].arrive)).toBeGreaterThanOrEqual(3);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  }, 60_000);
  it('Salem Ave to Wright State needs a transfer downtown', async () => {
    const r = (await get('transit', '/plan/v1?from=salem-catalpa&to=wright-union&date=2026-11-04&arriveBy=09:00')).body;
    expect(r.itineraries[0].transfers).toBe(1);
    expect(r.itineraries[0].legs[0].to).toBe('hub');
  });
  it('arrivals are in order, never in the past, and later in the snow scenario', async () => {
    const plain = (await get('transit', `/realtime/v1/arrivals?stop=hub&at=${at('2026-11-04', '07:00')}&limit=10`)).body.arrivals;
    expect(plain.map((a: { inMinutes: number }) => a.inMinutes)).toEqual([...plain.map((a: { inMinutes: number }) => a.inMinutes)].sort((x, y) => x - y));
    const snow = (await get('transit', `/realtime/v1/arrivals?stop=hub&at=${at('2026-11-04', '07:00')}&limit=10`, { 'x-twin-scenario': 'snow-delays' })).body.arrivals;
    for (const a of snow) expect(a.delayMinutes).toBeGreaterThanOrEqual(10);
    expect((await get('transit', `/realtime/v1/alerts?at=${at('2026-11-04', '07:00')}`, { 'x-twin-scenario': 'snow-delays' })).body.alerts[0].effect).toBe('SIGNIFICANT_DELAYS');
  });
  it('the detour scenario skips Linden Ave on Route 2 and says so', async () => {
    const r = (await get('transit', '/gtfs/v1/stops/linden-ave/departures?date=2026-11-04', { 'x-twin-scenario': 'detour' })).body;
    expect(r.departures).toEqual([]);
    expect((await get('transit', '/realtime/v1/alerts', { 'x-twin-scenario': 'detour' })).body.alerts[0].routes).toEqual(['2']);
  });
  it('departures never include a trip ending at that stop', async () => {
    const r = (await get('transit', '/gtfs/v1/stops/wright-union/departures?date=2026-11-04&limit=50')).body.departures;
    for (const d of r) expect(d.headsign).not.toBe('Student Union (Wright State)');
  });
  it('stops near a campus are sorted by distance', async () => {
    const r = (await get('transit', '/gtfs/v1/stops?near=39.7817,-84.0632&radius=1000')).body.stops;
    expect(r.map((s: { id: string }) => s.id)).toEqual(['wright-union', 'wright-colonel']);
  });
  it('every route serves at least two stops that exist', () => {
    for (const r of ROUTES) for (const [s] of r.stops) expect(STOPS.some((x) => x.id === s)).toBe(true);
  });
});

describe('places', () => {
  it('open-now agrees with posted hours across a week', async () => {
    for (const date of days('2026-11-02', 7)) {
      for (const hh of ['06:00', '09:00', '15:00', '21:30', '23:30']) {
        const open = new Set((await get('places', `/v1/spaces/open-now?campus=wright-state&at=${at(date, hh)}`)).body.open.map((s: { id: string }) => s.id));
        for (const s of SPACES.filter((x) => x.campus === 'wright-state')) {
          const h = s.hours[weekdayOf(date)];
          expect(open.has(s.id), `${s.id} ${date} ${hh}`).toBe(!!h && minutes(hh) >= minutes(h[0]) && minutes(hh) < minutes(h[1]));
        }
      }
    }
  });
  it('a reservation takes its slots, a clash is refused, and the same Idempotency-Key returns the same booking', async () => {
    const app = SERVICES.places.make();
    const call = async (body: unknown, key?: string) => {
      const r = await app.request('/v1/rooms/wright-room-241/reservations', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) } });
      return { status: r.status, body: (await r.json()) as any };
    };
    const before = (await (await app.request('/v1/rooms/wright-room-241/availability?date=2026-11-04')).json()) as { free: string[] };
    const a = await call({ date: '2026-11-04', start: '14:00', minutes: 60, name: 'Ana' }, 'k1');
    expect(a.status).toBe(201);
    const again = await call({ date: '2026-11-04', start: '14:00', minutes: 60, name: 'Ana' }, 'k1');
    expect(again.body.id).toBe(a.body.id);
    expect((await call({ date: '2026-11-04', start: '14:30', minutes: 30, name: 'Sam' })).status).toBe(409);
    const after = (await (await app.request('/v1/rooms/wright-room-241/availability?date=2026-11-04')).json()) as { free: string[] };
    expect(before.free.length - after.free.length).toBe(2);
    expect((await call({ date: '2026-11-04', start: '14:15', minutes: 45, name: 'x' })).status).toBe(400);
    expect((await call({ date: '2026-11-04', start: '23:30', minutes: 60, name: 'x' })).status).toBe(409);
  });
  it('non-bookable spaces refuse bookings', async () => {
    expect((await post('places', '/v1/rooms/sinclair-library/reservations', { date: '2026-11-04', start: '10:00', minutes: 30, name: 'x' })).status).toBe(400);
  });
  it('events are stable, never on Sunday, and filter by tag', async () => {
    const a = (await get('places', '/v1/events?campus=sinclair&from=2026-11-01&days=14')).body.events;
    expect(a).toEqual((await get('places', '/v1/events?campus=sinclair&from=2026-11-01&days=14')).body.events);
    expect(a.some((e: { date: string }) => weekdayOf(e.date) === 'Sun')).toBe(false);
    const food = (await get('places', '/v1/events?campus=sinclair&from=2026-11-01&days=14&tag=free-food')).body.events;
    expect(food.length).toBeGreaterThan(0);
    for (const e of food) expect(e.tags).toContain('free-food');
  });
});

describe('careers', () => {
  it('hours per week match each posting\'s schedule', () => {
    for (const p of POSTINGS.filter((x) => x.schedule.length)) expect(p.hoursPerWeek).toBe(p.schedule.reduce((t, s) => t + (minutes(s.end) - minutes(s.start)) / 60, 0));
  });
  it('filters by work-study, fair chance, hours and closing date', async () => {
    const ws = (await get('careers', '/v1/postings?campus=sinclair&workStudy=true')).body.postings;
    expect(ws.every((p: { workStudy: boolean }) => p.workStudy)).toBe(true);
    const fc = (await get('careers', '/v1/postings?campus=sinclair&fairChance=true')).body.postings;
    expect(fc.length).toBeGreaterThan(0);
    expect(fc.every((p: { fairChance: boolean }) => p.fairChance)).toBe(true);
    const short = (await get('careers', '/v1/postings?campus=sinclair&maxHours=10')).body.postings;
    expect(short.every((p: { hoursPerWeek: number }) => p.hoursPerWeek <= 10)).toBe(true);
    const late = (await get('careers', '/v1/postings?campus=sinclair&asOf=2026-11-26')).body.postings;
    expect(late.every((p: { closes: string }) => p.closes >= '2026-11-26')).toBe(true);
  });
  it('mentors with no open slots are never listed', async () => {
    const all = (await get('careers', '/v1/mentors')).body.mentors;
    expect(all).toHaveLength(MENTORS.filter((m) => m.openSlots > 0).length);
    const es = (await get('careers', '/v1/mentors?language=es')).body.mentors;
    expect(es.map((m: { id: string }) => m.id)).toEqual(['m3']);
  });
});

describe('mentor requests (Phase 4)', () => {
  const at = (iso: string) => ({ 'x-twin-clock': iso, 'content-type': 'application/json' });
  const req = async (app: ReturnType<typeof SERVICES.careers.make>, mentor: string, body: unknown, h: Record<string, string>) => {
    const r = await app.request(`/v1/mentors/${mentor}/requests`, { method: 'POST', body: JSON.stringify(body), headers: h });
    return { status: r.status, body: (await r.json()) as any };
  };
  it('accepts only a first name and a note; anything else is refused', async () => {
    const app = SERVICES.careers.make();
    expect((await req(app, 'm1', { firstName: 'Maria', note: 'I would like to talk about nursing.', phone: '937-555-1001' }, at('2026-11-02T17:00:00Z'))).status).toBe(400);
    expect((await req(app, 'm1', { firstName: 'Maria Lopez-Garcia the third, of Dayton Ohio', note: 'Hello there, mentor.' }, at('2026-11-02T17:00:00Z'))).status).toBe(400);
    expect((await req(app, 'm1', { firstName: 'Maria', note: 'hi' }, at('2026-11-02T17:00:00Z'))).status).toBe(400);
  });
  it('is pending, then accepted two hours later with a weekday meeting, and the same key never makes a second request', async () => {
    const app = SERVICES.careers.make();
    const a = await req(app, 'm1', { firstName: 'Maria', note: 'I would like to talk about nursing.' }, { ...at('2026-11-06T17:00:00Z'), 'idempotency-key': 'k' });
    expect(a).toMatchObject({ status: 201, body: { status: 'pending' } });
    const again = await req(app, 'm1', { firstName: 'Maria', note: 'I would like to talk about nursing.' }, { ...at('2026-11-06T17:30:00Z'), 'idempotency-key': 'k' });
    expect(again.body.id).toBe(a.body.id);
    const later = (await (await app.request(`/v1/requests/${a.body.id}`, { headers: at('2026-11-06T19:01:00Z') })).json()) as any;
    expect(later.status).toBe('accepted');
    expect(['Sat', 'Sun']).not.toContain(weekdayOf(later.meeting.date));
  });
  it('a mentor never accepts more people than their open slots', async () => {
    const app = SERVICES.careers.make();
    const ids: string[] = [];
    for (const n of ['Ana', 'Bea', 'Cy']) ids.push((await req(app, 'm2', { firstName: n, note: 'Could we talk about network jobs?' }, at('2026-11-02T17:00:00Z'))).body.id);
    const st = [];
    for (const id of ids) st.push(((await (await app.request(`/v1/requests/${id}`, { headers: at('2026-11-03T17:00:00Z') })).json()) as any).status);
    expect(st.filter((x) => x === 'accepted')).toHaveLength(MENTORS.find((m) => m.id === 'm2')!.openSlots);
  });
  it('a mentor with no open time refuses at once, and the declines scenario declines', async () => {
    const app = SERVICES.careers.make();
    expect((await req(app, 'm7', { firstName: 'Ana', note: 'Could we talk about medical assisting?' }, at('2026-11-02T17:00:00Z'))).status).toBe(409);
    const r = await req(app, 'm3', { firstName: 'Ana', note: 'Could we talk about running a business?' }, at('2026-11-02T17:00:00Z'));
    const later = (await (await app.request(`/v1/requests/${r.body.id}`, { headers: { ...at('2026-11-03T17:00:00Z'), 'x-twin-scenario': 'mentor-declines' } })).json()) as any;
    expect(later.status).toBe('declined');
  });
});

describe('lms', () => {
  it('refuses a missing or wrong token', async () => {
    expect((await get('lms', '/api/v1/courses')).status).toBe(401);
    expect((await get('lms', '/api/v1/courses', { authorization: 'Bearer wrong' })).status).toBe(401);
  });
  for (const tok of Object.keys(TOKENS)) {
    it(`${tok}: every assignment is due inside the term, with a time zone`, async () => {
      const h = { authorization: `Bearer ${tok}` };
      const courses = (await get('lms', '/api/v1/courses', h)).body;
      expect(courses).toHaveLength(TOKENS[tok]!.courses);
      for (const c of courses) {
        const as = (await get('lms', `/api/v1/courses/${c.id}/assignments`, h)).body;
        for (const a of as) {
          expect(a.due_at.slice(0, 10) >= '2026-08-24' && a.due_at.slice(0, 10) <= '2026-12-12').toBe(true);
          expect(a.due_at).toMatch(/[+-]\d{2}:\d{2}$/);
        }
      }
    });
  }
  it('another student\'s course is not found', async () => {
    expect((await get('lms', '/api/v1/courses/10010/assignments', { authorization: 'Bearer lms-demo' })).status).toBe(404);
  });
  it('the reschedule scenario moves exactly one due date, three days later', async () => {
    const h = { authorization: 'Bearer lms-demo' };
    const [c] = (await get('lms', '/api/v1/courses', h)).body;
    const a = (await get('lms', `/api/v1/courses/${c.id}/assignments`, h)).body;
    const b = (await get('lms', `/api/v1/courses/${c.id}/assignments`, { ...h, 'x-twin-scenario': 'reschedule' })).body;
    const moved = a.filter((x: { id: number; due_at: string }, i: number) => x.due_at !== b[i].due_at);
    expect(moved).toHaveLength(1);
    const i = a.findIndex((x: { id: number }) => x.id === moved[0].id);
    expect((Date.parse(b[i].due_at) - Date.parse(a[i].due_at)) / 86400000).toBe(3);
  });
  it('upcoming and past buckets split at the service clock', async () => {
    const h = { authorization: 'Bearer lms-demo' };
    const [c] = (await get('lms', '/api/v1/courses', h)).body;
    const up = (await get('lms', `/api/v1/courses/${c.id}/assignments?bucket=upcoming&at=2026-11-02T12:00:00Z`, h)).body;
    const past = (await get('lms', `/api/v1/courses/${c.id}/assignments?bucket=past&at=2026-11-02T12:00:00Z`, h)).body;
    const all = (await get('lms', `/api/v1/courses/${c.id}/assignments`, h)).body;
    expect(up.length + past.length).toBe(all.length);
    for (const a of up) expect(Date.parse(a.due_at)).toBeGreaterThanOrEqual(Date.parse('2026-11-02T12:00:00Z'));
  });
});
