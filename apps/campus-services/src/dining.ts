import { BadRequest, CAMPUSES, CAMPUS_IDS, NotFound, campusParam, clock, dateParam, minutes, pick, rng, service, weekdayOf, type CampusId } from './common.js';

/**
 * Synthetic campus dining service: locations, hours by day (with breaks and closures), menus by period with prices,
 * dietary tags and allergens, and what is open now. Shaped like the dining platforms colleges license.
 */
export interface DiningLocation {
  id: string;
  campus: CampusId;
  name: string;
  kind: 'dining-hall' | 'cafe' | 'market' | 'food-truck' | 'grab-and-go';
  building: string;
  lat: number;
  lon: number;
  accepts: ('card' | 'cash' | 'meal-plan' | 'campus-card')[];
  /** Hours by weekday: periods with open and close times (24-hour, campus local). */
  hours: Partial<Record<'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat', { name: string; open: string; close: string }[]>>;
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
const every = (days: readonly string[], periods: { name: string; open: string; close: string }[]) => Object.fromEntries(days.map((d) => [d, periods]));

const L = (campus: CampusId, id: string, name: string, kind: DiningLocation['kind'], building: string, dLat: number, dLon: number, accepts: DiningLocation['accepts'], hours: DiningLocation['hours']): DiningLocation => ({
  id: `${campus}-${id}`,
  campus,
  name,
  kind,
  building,
  lat: Number((CAMPUSES[campus].lat + dLat).toFixed(5)),
  lon: Number((CAMPUSES[campus].lon + dLon).toFixed(5)),
  accepts,
  hours,
});

export const LOCATIONS: DiningLocation[] = [
  L('sinclair', 'commons', 'Third Street Commons', 'dining-hall', 'Building 8', 0.0004, 0.0006, ['card', 'cash', 'campus-card'], {
    ...every(WEEK, [{ name: 'Breakfast', open: '07:00', close: '10:00' }, { name: 'Lunch', open: '10:30', close: '14:00' }, { name: 'Dinner', open: '16:30', close: '19:30' }]),
  }),
  L('sinclair', 'perk', 'The Perk Coffee Bar', 'cafe', 'Building 7', -0.0003, 0.0002, ['card', 'cash', 'campus-card'], {
    ...every(WEEK, [{ name: 'All day', open: '07:30', close: '20:00' }]),
    Sat: [{ name: 'All day', open: '09:00', close: '13:00' }],
  }),
  L('sinclair', 'market', 'Library Grab and Go', 'grab-and-go', 'Building 6', 0.0007, -0.0004, ['card', 'campus-card'], {
    ...every(['Mon', 'Tue', 'Wed', 'Thu'], [{ name: 'All day', open: '08:00', close: '22:00' }]),
    Fri: [{ name: 'All day', open: '08:00', close: '17:00' }],
  }),
  L('wright-state', 'union', 'Student Union Food Court', 'dining-hall', 'Student Union', 0.0005, 0.0009, ['card', 'cash', 'meal-plan', 'campus-card'], {
    ...every(WEEK, [{ name: 'Breakfast', open: '07:30', close: '10:30' }, { name: 'Lunch', open: '11:00', close: '14:30' }, { name: 'Dinner', open: '16:30', close: '21:00' }]),
    Sat: [{ name: 'Brunch', open: '10:00', close: '14:00' }],
    Sun: [{ name: 'Brunch', open: '10:00', close: '14:00' }, { name: 'Dinner', open: '16:30', close: '20:00' }],
  }),
  L('wright-state', 'late', 'Night Owl Market', 'market', 'Hamilton Hall', -0.0011, 0.0004, ['card', 'meal-plan', 'campus-card'], {
    ...every([...WEEK, 'Sun'], [{ name: 'Late night', open: '18:00', close: '01:00' }]),
  }),
  L('wright-state', 'truck', 'Raider Grill Truck', 'food-truck', 'Quad, near the library', 0.0002, -0.0012, ['card', 'cash'], {
    ...every(['Tue', 'Thu'], [{ name: 'Lunch', open: '11:00', close: '14:00' }]),
  }),
  L('antioch', 'dining', 'Antioch Dining Commons', 'dining-hall', 'McGregor Hall', 0.0003, 0.0003, ['card', 'meal-plan', 'campus-card'], {
    ...every([...WEEK, 'Sat', 'Sun'], [{ name: 'Breakfast', open: '08:00', close: '10:00' }, { name: 'Lunch', open: '11:30', close: '13:30' }, { name: 'Dinner', open: '17:00', close: '19:00' }]),
  }),
  L('antioch', 'farm', 'Farm Stand Cafe', 'cafe', 'Antioch Farm', -0.0015, -0.0006, ['card', 'cash', 'campus-card'], {
    ...every(['Mon', 'Wed', 'Fri'], [{ name: 'All day', open: '10:00', close: '15:00' }]),
  }),
];

/** Academic-calendar closures, the same for every location on a campus. */
export const CLOSURES: { campus: CampusId | 'all'; from: string; to: string; reason: string }[] = [
  { campus: 'all', from: '2026-11-26', to: '2026-11-29', reason: 'Thanksgiving break' },
  { campus: 'all', from: '2026-12-19', to: '2027-01-04', reason: 'Winter break' },
];

const ITEMS: { name: string; station: string; price: number; calories: number; tags: string[]; allergens: string[]; periods: string[] }[] = [
  { name: 'Scrambled eggs and toast', station: 'Grill', price: 3.5, calories: 420, tags: ['vegetarian'], allergens: ['egg', 'wheat', 'milk'], periods: ['Breakfast', 'Brunch', 'All day'] },
  { name: 'Oatmeal bar', station: 'Hot cereal', price: 2.25, calories: 300, tags: ['vegan', 'vegetarian'], allergens: [], periods: ['Breakfast', 'Brunch', 'All day'] },
  { name: 'Breakfast burrito', station: 'Grill', price: 4.75, calories: 610, tags: [], allergens: ['egg', 'wheat', 'milk'], periods: ['Breakfast', 'Brunch'] },
  { name: 'Fruit cup', station: 'Market', price: 2.0, calories: 90, tags: ['vegan', 'vegetarian', 'gluten-free'], allergens: [], periods: ['Breakfast', 'Lunch', 'All day', 'Late night', 'Brunch'] },
  { name: 'Chicken rice bowl', station: 'Bowls', price: 6.5, calories: 650, tags: ['gluten-free', 'halal'], allergens: ['soy'], periods: ['Lunch', 'Dinner', 'All day'] },
  { name: 'Black bean burger', station: 'Grill', price: 5.75, calories: 540, tags: ['vegetarian'], allergens: ['wheat', 'soy'], periods: ['Lunch', 'Dinner'] },
  { name: 'Lentil soup', station: 'Soup', price: 3.0, calories: 260, tags: ['vegan', 'vegetarian', 'gluten-free'], allergens: [], periods: ['Lunch', 'Dinner', 'All day'] },
  { name: 'Turkey sandwich', station: 'Deli', price: 5.25, calories: 480, tags: [], allergens: ['wheat'], periods: ['Lunch', 'All day', 'Late night'] },
  { name: 'Cheese pizza slice', station: 'Pizza', price: 2.75, calories: 310, tags: ['vegetarian'], allergens: ['wheat', 'milk'], periods: ['Lunch', 'Dinner', 'Late night'] },
  { name: 'Veggie stir fry', station: 'Wok', price: 6.0, calories: 470, tags: ['vegan', 'vegetarian'], allergens: ['soy'], periods: ['Lunch', 'Dinner'] },
  { name: 'Baked chicken plate', station: 'Home style', price: 7.25, calories: 720, tags: ['gluten-free', 'halal'], allergens: [], periods: ['Dinner'] },
  { name: 'Pasta marinara', station: 'Pasta', price: 4.5, calories: 560, tags: ['vegan', 'vegetarian'], allergens: ['wheat'], periods: ['Lunch', 'Dinner'] },
  { name: 'Peanut butter and banana wrap', station: 'Market', price: 3.25, calories: 430, tags: ['vegetarian'], allergens: ['peanut', 'wheat'], periods: ['All day', 'Late night', 'Lunch'] },
  { name: 'Ramen cup', station: 'Market', price: 1.5, calories: 380, tags: ['vegetarian'], allergens: ['wheat', 'soy'], periods: ['Late night', 'All day'] },
  { name: 'Coffee, small', station: 'Coffee', price: 1.75, calories: 5, tags: ['vegan', 'vegetarian', 'gluten-free'], allergens: [], periods: ['Breakfast', 'All day', 'Late night', 'Brunch'] },
  { name: 'Hummus and pita box', station: 'Market', price: 4.0, calories: 390, tags: ['vegan', 'vegetarian'], allergens: ['wheat', 'sesame'], periods: ['Lunch', 'All day', 'Late night'] },
];

export function closureOn(campus: CampusId, date: string): string | undefined {
  return CLOSURES.find((c) => (c.campus === 'all' || c.campus === campus) && date >= c.from && date <= c.to)?.reason;
}

export function hoursOn(loc: DiningLocation, date: string, scenario?: string): { date: string; periods: { name: string; open: string; close: string }[]; closedReason?: string } {
  const closed = scenario === 'weather-closure' ? 'Closed for weather' : closureOn(loc.campus, date);
  if (closed) return { date, periods: [], closedReason: closed };
  const periods = loc.hours[weekdayOf(date)] ?? [];
  return periods.length ? { date, periods } : { date, periods: [], closedReason: 'Closed today' };
}

/** Close times after midnight (e.g. 01:00) count as the same service day. */
const closeMin = (open: string, close: string) => (minutes(close) <= minutes(open) ? minutes(close) + 1440 : minutes(close));

export function menu(loc: DiningLocation, date: string, period: string) {
  const r = rng(`${loc.id}|${date}|${period}`);
  const pool = ITEMS.filter((i) => i.periods.includes(period));
  const n = loc.kind === 'dining-hall' ? 7 : loc.kind === 'food-truck' ? 3 : 5;
  const chosen = [...pool].sort(() => r() - 0.5).slice(0, Math.min(n, pool.length));
  const markup = loc.kind === 'food-truck' ? 1.15 : loc.kind === 'dining-hall' ? 1 : 1.05;
  return chosen
    .map((i) => ({ id: `${loc.id}-${i.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: i.name, station: i.station, price: Math.round(i.price * markup * 4) / 4, calories: i.calories, tags: i.tags, allergens: i.allergens }))
    .sort((a, b) => a.station.localeCompare(b.station) || a.name.localeCompare(b.name));
}

export const diningInfo = {
  id: 'dining',
  title: 'Campus Dining (synthetic)',
  version: '1.0.0',
  description: 'Dining locations, hours, menus and what is open now for each campus.',
  endpoints: [
    { method: 'GET', path: '/v1/locations', summary: 'Dining locations on a campus', query: { campus: 'sinclair, wright-state or antioch' } },
    { method: 'GET', path: '/v1/locations/:id', summary: 'One location' },
    { method: 'GET', path: '/v1/locations/:id/hours', summary: 'Hours for a date, or for several days', query: { date: 'YYYY-MM-DD', days: '1 to 14' } },
    { method: 'GET', path: '/v1/menus', summary: 'Menu for a location, date and period', query: { location: 'location id', date: 'YYYY-MM-DD', period: 'Breakfast, Lunch, Dinner, All day, Late night, Brunch' } },
    { method: 'GET', path: '/v1/open-now', summary: 'Locations open at the service clock, with when each closes', query: { campus: 'campus id' } },
    { method: 'GET', path: '/v1/search', summary: 'Items on menus open now, filtered', query: { campus: 'campus id', tag: 'vegan, vegetarian, gluten-free, halal', maxPrice: 'dollars', avoid: 'an allergen' } },
  ],
  scenarios: { 'weather-closure': 'every location closed today for weather' },
} as const;

export function diningService() {
  return service(diningInfo as never, (app) => {
    const byId = (id: string) => {
      const l = LOCATIONS.find((x) => x.id === id);
      if (!l) throw new NotFound(`no location ${id}`);
      return l;
    };
    const view = ({ hours: _h, ...l }: DiningLocation) => l;
    app.get('/v1/locations', (c) => c.json({ campus: campusParam(c), locations: LOCATIONS.filter((l) => l.campus === campusParam(c)).map(view) }));
    app.get('/v1/locations/:id', (c) => c.json(view(byId(c.req.param('id')))));
    app.get('/v1/locations/:id/hours', (c) => {
      const l = byId(c.req.param('id'));
      const start = dateParam(c);
      const days = Number(c.req.query('days') ?? 1);
      if (!Number.isInteger(days) || days < 1 || days > 14) throw new BadRequest('days must be 1 to 14');
      const out = Array.from({ length: days }, (_, i) => hoursOn(l, new Date(Date.parse(`${start}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10), c.req.header('x-twin-scenario')));
      return c.json({ location: l.id, days: out });
    });
    app.get('/v1/menus', (c) => {
      const l = byId(c.req.query('location') ?? '');
      const date = dateParam(c);
      const h = hoursOn(l, date, c.req.header('x-twin-scenario'));
      const period = c.req.query('period') ?? h.periods[0]?.name;
      if (!period || !h.periods.some((p) => p.name === period)) return c.json({ location: l.id, date, period: period ?? null, items: [], closedReason: h.closedReason ?? `No ${period} service` });
      return c.json({ location: l.id, date, period, items: menu(l, date, period) });
    });
    const openNow = (campus: CampusId, date: string, min: number, scenario?: string) =>
      LOCATIONS.filter((l) => l.campus === campus).flatMap((l) => {
        const today = hoursOn(l, date, scenario).periods.find((p) => min >= minutes(p.open) && min < closeMin(p.open, p.close));
        const yesterday = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
        const spill = hoursOn(l, yesterday, scenario).periods.find((p) => closeMin(p.open, p.close) > 1440 && min + 1440 < closeMin(p.open, p.close));
        const p = today ?? spill;
        return p ? [{ ...view(l), period: p.name, closes: p.close }] : [];
      });
    app.get('/v1/open-now', (c) => {
      const campus = campusParam(c);
      const { date, min, iso } = clock(c);
      return c.json({ campus, at: iso, open: openNow(campus, date, min, c.req.header('x-twin-scenario')) });
    });
    app.get('/v1/search', (c) => {
      const campus = campusParam(c);
      const { date, min, iso } = clock(c);
      const tag = c.req.query('tag');
      const avoid = c.req.query('avoid');
      const maxPrice = c.req.query('maxPrice') ? Number(c.req.query('maxPrice')) : Infinity;
      if (Number.isNaN(maxPrice)) throw new BadRequest('maxPrice must be a number');
      const items = openNow(campus, date, min, c.req.header('x-twin-scenario')).flatMap((l) =>
        menu(byId(l.id), date, l.period)
          .filter((i) => (!tag || i.tags.includes(tag)) && (!avoid || !i.allergens.includes(avoid)) && i.price <= maxPrice)
          .map((i) => ({ ...i, location: l.id, locationName: l.name, closes: l.closes })),
      );
      return c.json({ campus, at: iso, items: items.sort((a, b) => a.price - b.price) });
    });
  });
}

export { CAMPUS_IDS, pick };
