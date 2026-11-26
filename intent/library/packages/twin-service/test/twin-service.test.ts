import { describe, expect, it } from 'vitest';
import { BadRequest, NotFound, WEEKDAYS, clock, dateParam, hhmm, meters, minutes, openapi, pad, pick, rng, service, setTimeZone, weekdayOf } from '../src/index.js';

// Verifies docs/blocks/twin-service.md
const info = { id: 'demo', title: 'Demo', version: '1.2.3', description: 'A demo twin.', endpoints: [{ method: 'GET' as const, path: '/v1/things/:id', summary: 'One thing', query: { full: 'everything' } }], scenarios: { busy: 'all full' } };
const app = service(info, (a) => {
  a.get('/v1/now', (c) => c.json(clock(c)));
  a.get('/v1/date', (c) => c.json({ date: dateParam(c) }));
  a.get('/v1/bad', () => { throw new BadRequest('nope'); });
  a.get('/v1/missing', () => { throw new NotFound('gone'); });
  a.get('/v1/boom', () => { throw new Error('boom'); });
});
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

describe('deterministic helpers', () => {
  it('rng is seeded: same seed same sequence, values in [0,1)', () => {
    const a = rng('x');
    const b = rng('x');
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(rng('y')()).not.toBe(rng('x')());
    expect(new Set(xs).size).toBeGreaterThan(45);
  });
  it('pick chooses by the generator', () => {
    expect(pick(() => 0, ['a', 'b', 'c'])).toBe('a');
    expect(pick(() => 0.99, ['a', 'b', 'c'])).toBe('c');
    expect(pick(() => 0.5, ['a', 'b', 'c'])).toBe('b');
  });
  it('times and dates', () => {
    expect(pad(7)).toBe('07');
    expect(pad(12)).toBe('12');
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(605)).toBe('10:05');
    expect(hhmm(24 * 60 + 30)).toBe('00:30');
    expect(minutes('10:05')).toBe(605);
    expect(WEEKDAYS).toHaveLength(7);
    expect(weekdayOf('2026-11-03')).toBe('Tue');
    expect(weekdayOf('2026-11-08')).toBe('Sun');
  });
  it('meters between two points', () => {
    expect(meters({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
    expect(meters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBe(111195);
    expect(meters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBe(111195);
    expect(meters({ lat: 60, lon: 0 }, { lat: 60, lon: 1 })).toBe(55597);
  });
});

describe('service wrapper', () => {
  it('answers health with id and version, and marks every answer synthetic', async () => {
    const r = await get('/healthz');
    expect(await r.json()).toEqual({ ok: true, service: 'demo', version: '1.2.3' });
    expect(r.headers.get('x-synthetic-service')).toBe('demo');
  });
  it('reads the clock from at or the header, in the twin zone', async () => {
    expect(await (await get('/v1/now?at=2026-11-03T14:30:00Z')).json()).toEqual({ iso: '2026-11-03T14:30:00.000Z', date: '2026-11-03', min: 9 * 60 + 30 });
    expect(await (await get('/v1/now', { 'x-twin-clock': '2026-11-04T03:00:00Z' })).json()).toMatchObject({ date: '2026-11-03', min: 22 * 60 });
    setTimeZone('UTC');
    expect(await (await get('/v1/now?at=2026-11-04T03:00:00Z')).json()).toMatchObject({ date: '2026-11-04', min: 180 });
    setTimeZone('America/New_York');
    const now = (await (await get('/v1/now')).json()) as { iso: string };
    expect(Math.abs(Date.parse(now.iso) - Date.now())).toBeLessThan(5000);
  });
  it('turns bad input and missing things into 400 and 404, and an unknown path into 404 with a pointer', async () => {
    expect((await get('/v1/now?at=tuesday')).status).toBe(400);
    expect(await (await get('/v1/now?at=tuesday')).json()).toEqual({ error: 'not a date-time: tuesday' });
    expect(await (await get('/v1/bad')).json()).toEqual({ error: 'nope' });
    expect((await get('/v1/missing')).status).toBe(404);
    expect(await (await get('/v1/missing')).json()).toEqual({ error: 'gone' });
    await expect(get('/v1/boom')).rejects.toThrow('boom');
    const nf = await get('/nowhere');
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: 'no such endpoint', see: '/openapi.json' });
  });
  it('date parameter defaults to the clock and must be a date', async () => {
    expect(await (await get('/v1/date?date=2026-01-02')).json()).toEqual({ date: '2026-01-02' });
    expect(await (await get('/v1/date?at=2026-11-03T14:30:00Z')).json()).toEqual({ date: '2026-11-03' });
    expect(await (await get('/v1/date?date=Jan 2')).json()).toEqual({ error: 'date must be YYYY-MM-DD' });
  });
  it('acts out an outage at once, and slowness by waiting', async () => {
    const r = await get('/healthz', { 'x-twin-scenario': 'outage' });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'service unavailable', scenario: 'outage' });
    const t = Date.now();
    expect((await get('/healthz', { 'x-twin-scenario': 'slow' })).status).toBe(200);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1400);
    const t2 = Date.now();
    await get('/healthz', { 'x-twin-scenario': 'busy' });
    expect(Date.now() - t2).toBeLessThan(1000);
  });
  it('publishes OpenAPI with path, query and clock parameters, and every scenario', async () => {
    const doc = (await (await get('/openapi.json')).json()) as ReturnType<typeof openapi>;
    expect(doc).toEqual(openapi(info));
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Demo');
    expect(doc.info.description).toContain('outage: returns 503; slow: adds 1.5 s; busy: all full');
    const op = (doc.paths as unknown as Record<string, { get: { summary: string; parameters: { name: string; in: string; required: boolean }[] } }>)['/v1/things/{id}']!.get;
    expect(op.summary).toBe('One thing');
    expect(op.parameters.map((p) => `${p.in}:${p.name}:${p.required}`)).toEqual(['path:id:true', 'query:full:false', 'query:at:false']);
  });
});
