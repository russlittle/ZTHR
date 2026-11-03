import { createHash } from 'node:crypto';
import { BadRequest, CAMPUSES, NotFound, campusParam, clock, dateParam, hhmm, minutes, rng, service, weekdayOf, type CampusId } from './common.js';

/**
 * Synthetic campus places service: study spaces with hours and noise level, bookable study rooms with
 * reservations, and campus events (including events with free food). Shaped like the space-booking and events
 * calendars colleges run.
 */
export interface Space {
  id: string;
  campus: CampusId;
  name: string;
  building: string;
  kind: 'library' | 'study-room' | 'computer-lab' | 'lounge';
  noise: 'quiet' | 'group';
  outlets: boolean;
  bookable: boolean;
  seats: number;
  hours: Partial<Record<string, [string, string]>>;
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu'];
const H = (days: string[], open: string, close: string) => Object.fromEntries(days.map((d) => [d, [open, close] as [string, string]]));

export const SPACES: Space[] = [
  { id: 'sinclair-library', campus: 'sinclair', name: 'Library quiet floor', building: 'Building 6', kind: 'library', noise: 'quiet', outlets: true, bookable: false, seats: 120, hours: { ...H(WEEK, '07:30', '22:00'), ...H(['Fri'], '07:30', '17:00'), ...H(['Sat'], '09:00', '15:00') } },
  { id: 'sinclair-room-6142', campus: 'sinclair', name: 'Study room 6142', building: 'Building 6', kind: 'study-room', noise: 'group', outlets: true, bookable: true, seats: 6, hours: { ...H(WEEK, '08:00', '21:00'), ...H(['Fri'], '08:00', '17:00') } },
  { id: 'sinclair-lab-14', campus: 'sinclair', name: 'Open computer lab', building: 'Building 14', kind: 'computer-lab', noise: 'quiet', outlets: true, bookable: false, seats: 60, hours: { ...H([...WEEK, 'Fri'], '07:00', '22:00'), ...H(['Sat'], '08:00', '16:00') } },
  { id: 'wright-dunbar', campus: 'wright-state', name: 'Dunbar Library, third floor', building: 'Dunbar Library', kind: 'library', noise: 'quiet', outlets: true, bookable: false, seats: 200, hours: { ...H(WEEK, '07:00', '23:59'), ...H(['Fri'], '07:00', '18:00'), ...H(['Sat'], '10:00', '18:00'), ...H(['Sun'], '12:00', '23:59') } },
  { id: 'wright-room-241', campus: 'wright-state', name: 'Group study room 241', building: 'Dunbar Library', kind: 'study-room', noise: 'group', outlets: true, bookable: true, seats: 8, hours: { ...H([...WEEK, 'Sun'], '09:00', '23:00'), ...H(['Fri', 'Sat'], '10:00', '18:00') } },
  { id: 'wright-union-lounge', campus: 'wright-state', name: 'Union lounge', building: 'Student Union', kind: 'lounge', noise: 'group', outlets: false, bookable: false, seats: 40, hours: { ...H([...WEEK, 'Fri'], '07:00', '23:00'), ...H(['Sat', 'Sun'], '10:00', '22:00') } },
  { id: 'antioch-olive-kettering', campus: 'antioch', name: 'Olive Kettering Library', building: 'Olive Kettering Library', kind: 'library', noise: 'quiet', outlets: true, bookable: false, seats: 70, hours: { ...H([...WEEK, 'Fri'], '08:00', '22:00'), ...H(['Sun'], '12:00', '22:00') } },
  { id: 'antioch-room-2', campus: 'antioch', name: 'Library study room 2', building: 'Olive Kettering Library', kind: 'study-room', noise: 'group', outlets: true, bookable: true, seats: 4, hours: { ...H([...WEEK, 'Fri'], '08:00', '22:00') } },
];

const EVENT_KINDS = [
  { title: 'Free pizza and study night', kind: 'free-food', tags: ['free-food'] },
  { title: 'Resume workshop', kind: 'workshop', tags: ['career'] },
  { title: 'Student parents meetup', kind: 'meetup', tags: ['student-parents', 'free-food'] },
  { title: 'FAFSA help session', kind: 'workshop', tags: ['money'] },
  { title: 'Veterans coffee hour', kind: 'meetup', tags: ['veterans', 'free-food'] },
  { title: 'Tutoring drop-in: math', kind: 'tutoring', tags: ['academic'] },
  { title: 'Club fair', kind: 'social', tags: ['social'] },
  { title: 'Late-night breakfast before finals', kind: 'free-food', tags: ['free-food'] },
] as const;

export function eventsOn(campus: CampusId, date: string) {
  const r = rng(`events|${campus}|${date}`);
  const wd = weekdayOf(date);
  if (wd === 'Sun' || (wd === 'Sat' && r() < 0.7)) return [];
  const n = 1 + Math.floor(r() * 3);
  const places = SPACES.filter((s) => s.campus === campus);
  return Array.from({ length: n }, (_, i) => {
    const k = EVENT_KINDS[Math.floor(r() * EVENT_KINDS.length)]!;
    const start = 11 * 60 + Math.floor(r() * 16) * 30;
    const where = places[Math.floor(r() * places.length)]!;
    return { id: `${campus}-${date.replace(/-/g, '')}-${i}`, campus, date, start: hhmm(start), end: hhmm(start + 60 + Math.floor(r() * 3) * 30), title: k.title, kind: k.kind, tags: [...k.tags], where: `${where.building}`, free: true };
  }).sort((a, b) => a.start.localeCompare(b.start));
}

export const placesInfo = {
  id: 'places',
  title: 'Campus Places (synthetic)',
  version: '1.0.0',
  description: 'Study spaces, bookable rooms and campus events for each campus.',
  endpoints: [
    { method: 'GET', path: '/v1/spaces', summary: 'Study spaces on a campus', query: { campus: 'campus id', noise: 'quiet or group' } },
    { method: 'GET', path: '/v1/spaces/open-now', summary: 'Spaces open at the service clock', query: { campus: 'campus id' } },
    { method: 'GET', path: '/v1/rooms/:id/availability', summary: 'Free 30-minute slots in a bookable room', query: { date: 'YYYY-MM-DD' } },
    { method: 'POST', path: '/v1/rooms/:id/reservations', summary: 'Reserve a room (send Idempotency-Key)' },
    { method: 'GET', path: '/v1/reservations/:id', summary: 'One reservation' },
    { method: 'GET', path: '/v1/reservations', summary: 'The reservation made with an Idempotency-Key, if any', query: { key: 'the Idempotency-Key sent with the booking' } },
    { method: 'GET', path: '/v1/events', summary: 'Events on a campus over a date range', query: { campus: 'campus id', from: 'YYYY-MM-DD', days: '1 to 14', tag: 'free-food, career, money, ...' } },
  ],
  scenarios: {},
} as const;

export function placesService() {
  const reservations = new Map<string, { id: string; room: string; date: string; start: string; minutes: number; name: string }>();
  const byKey = new Map<string, string>();
  return service(placesInfo as never, (app) => {
    const space = (id: string) => {
      const s = SPACES.find((x) => x.id === id);
      if (!s) throw new NotFound(`no space ${id}`);
      return s;
    };
    const view = ({ hours, ...s }: Space) => ({ ...s, hours });
    app.get('/v1/spaces', (c) => {
      const campus = campusParam(c);
      const noise = c.req.query('noise');
      return c.json({ campus, spaces: SPACES.filter((s) => s.campus === campus && (!noise || s.noise === noise)).map(view) });
    });
    app.get('/v1/spaces/open-now', (c) => {
      const campus = campusParam(c);
      const { date, min, iso } = clock(c);
      const open = SPACES.filter((s) => s.campus === campus).flatMap((s) => {
        const h = s.hours[weekdayOf(date)];
        return h && min >= minutes(h[0]) && min < minutes(h[1]) ? [{ ...view(s), closes: h[1] }] : [];
      });
      return c.json({ campus, at: iso, open });
    });
    const slots = (s: Space, date: string) => {
      const h = s.hours[weekdayOf(date)];
      if (!h) return [];
      const taken = [...reservations.values()].filter((r) => r.room === s.id && r.date === date);
      const out: string[] = [];
      for (let m = minutes(h[0]); m + 30 <= minutes(h[1]); m += 30) if (!taken.some((r) => m >= minutes(r.start) && m < minutes(r.start) + r.minutes)) out.push(hhmm(m));
      return out;
    };
    app.get('/v1/rooms/:id/availability', (c) => {
      const s = space(c.req.param('id'));
      if (!s.bookable) throw new BadRequest(`${s.id} is not bookable`);
      const date = dateParam(c);
      return c.json({ room: s.id, date, free: slots(s, date) });
    });
    app.post('/v1/rooms/:id/reservations', async (c) => {
      const s = space(c.req.param('id'));
      if (!s.bookable) throw new BadRequest(`${s.id} is not bookable`);
      const key = c.req.header('idempotency-key');
      if (key && byKey.has(key)) return c.json(reservations.get(byKey.get(key)!)!, 200);
      const b = (await c.req.json().catch(() => ({}))) as { date?: string; start?: string; minutes?: number; name?: string };
      if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !b.start || !/^\d{2}:\d{2}$/.test(b.start) || !b.minutes || b.minutes % 30 || b.minutes > 180 || !b.name) throw new BadRequest('need date, start (HH:MM), minutes (30 to 180, in 30s) and name');
      const free = slots(s, b.date);
      for (let m = minutes(b.start); m < minutes(b.start) + b.minutes; m += 30) if (!free.includes(hhmm(m))) return c.json({ error: 'that time is taken or the room is closed' }, 409);
      const id = `res-${createHash('sha256').update(`${s.id}|${b.date}|${b.start}|${b.name}|${reservations.size}`).digest('hex').slice(0, 8)}`;
      const r = { id, room: s.id, date: b.date, start: b.start, minutes: b.minutes, name: b.name };
      reservations.set(id, r);
      if (key) byKey.set(key, id);
      return c.json(r, 201);
    });
    app.get('/v1/reservations/:id', (c) => {
      const r = reservations.get(c.req.param('id'));
      if (!r) throw new NotFound(`no reservation ${c.req.param('id')}`);
      return c.json(r);
    });
    app.get('/v1/reservations', (c) => {
      const key = c.req.query('key');
      if (!key) throw new BadRequest('key is required');
      const id = byKey.get(key);
      return c.json({ reservations: id ? [reservations.get(id)!] : [] });
    });
    app.get('/v1/events', (c) => {
      const campus = campusParam(c);
      const from = c.req.query('from') ?? clock(c).date;
      const days = Number(c.req.query('days') ?? 7);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new BadRequest('from must be YYYY-MM-DD');
      if (!Number.isInteger(days) || days < 1 || days > 14) throw new BadRequest('days must be 1 to 14');
      const tag = c.req.query('tag');
      const events = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${from}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10)).flatMap((d) => eventsOn(campus, d)).filter((e) => !tag || e.tags.includes(tag as never));
      return c.json({ campus, from, days, events, campusName: CAMPUSES[campus].name });
    });
  });
}
