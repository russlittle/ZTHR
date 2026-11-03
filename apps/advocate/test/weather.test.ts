// Verifies docs/flows/weather.md
import { describe, expect, it } from 'vitest';
import { EgressTwin } from '@zthr/egress';
import { Advocate } from '../src/agents/advocate.js';
import { PERSONAS } from '../src/server/demo.js';
import { impactOf, weatherNote, type Period } from '../src/domain/weather.js';
import { checkTone } from '../src/domain/tone.js';

const DAY = '2026-11-02';
const period = (shortForecast: string, temperature = 40, pop = 80, name = 'Today'): Period => ({ name, startTime: `${DAY}T06:00:00-05:00`, isDaytime: true, temperature, temperatureUnit: 'F', shortForecast, probabilityOfPrecipitation: { value: pop } });

const CASES: [string, Period, 0 | 1 | 2][] = [
  ['sunny', period('Sunny', 55, 0), 0],
  ['light chance of rain', period('Slight Chance Rain Showers', 50, 20), 0],
  ['heavy rain', period('Rain', 48, 90), 1],
  ['thunderstorms', period('Showers And Thunderstorms', 70, 70), 1],
  ['snow', period('Snow Likely', 28, 70), 2],
  ['a dusting with low chance', period('Chance Snow Showers', 30, 20), 0],
  ['freezing rain', period('Freezing Rain', 30, 60), 2],
  ['sleet', period('Rain And Sleet', 33, 60), 2],
  ['bitter cold', period('Mostly Sunny', 4, 0), 1],
  ['cold in Celsius', { ...period('Sunny', -15, 0), temperatureUnit: 'C' }, 1],
  ['heat', period('Sunny', 98, 0), 1],
];

describe('what the weather means for getting there', () => {
  for (const [name, p, severity] of CASES) {
    it(`${name}: severity ${severity}`, () => expect(impactOf(p).severity).toBe(severity));
    it(`${name}: the note says nothing on ordinary days and reads plainly otherwise`, () => {
      const n = weatherNote(p, { what: 'BIO 1111', start: '09:00' });
      if (severity === 0) expect(n).toBeUndefined();
      else expect(checkTone({ text: n!, nextSteps: [{ label: 'x', action: 'x' }], urgency: 'routine' }, 'walk-me-through', 8, 'en').problems).toEqual([]);
    });
  }
  it('names the first class and how much earlier to leave', () => expect(weatherNote(period('Snow Likely', 28, 70), { what: 'BIO 1111', start: '09:00' })).toBe('Heads up: today looks like snow. For BIO 1111 at 9:00 a.m., leave about 25 minutes earlier than usual. Bring boots and warm layers.'));
});

function nws(p: Period, opts: { pointsStatus?: number; forecastUrl?: string } = {}) {
  return new EgressTwin(['api.weather.gov'], (req) => {
    if (req.url.includes('/points/')) return { status: opts.pointsStatus ?? 200, body: JSON.stringify({ properties: { forecast: opts.forecastUrl ?? 'https://api.weather.gov/gridpoints/ILN/37,79/forecast' } }) };
    return { status: 200, body: JSON.stringify({ properties: { periods: [p] } }) };
  });
}

describe('weather in the Advocate', () => {
  const setup = (egress: EgressTwin) => {
    const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T12:00:00Z`), egress });
    return { a, sid: PERSONAS.Maria!(a).id };
  };
  it('a snowy morning before class becomes a heads-up naming the class', async () => {
    const egress = nws(period('Snow Likely', 27, 80));
    const { a, sid } = setup(egress);
    const m = await a.weatherMessage(sid);
    expect(m?.text).toContain('BIO 1111');
    expect(m?.urgency).toBe('time-sensitive');
  });
  it('sends only rounded coordinates for the town and a user agent, never anything about the student', async () => {
    const egress = nws(period('Snow Likely', 27, 80));
    const { a, sid } = setup(egress);
    await a.weatherMessage(sid);
    const first = egress.sent[0]!;
    expect(first.url).toBe('https://api.weather.gov/points/39.75,-84.25');
    expect(JSON.stringify(egress.sent)).not.toMatch(/Maria|maria|45417/);
    expect(first.headers?.['user-agent']).toBeTruthy();
  });
  it('a sunny day says nothing', async () => {
    const { a, sid } = setup(nws(period('Sunny', 60, 0)));
    expect(await a.weatherMessage(sid)).toBeUndefined();
  });
  it('a forecast link that points anywhere but the weather service is not followed', async () => {
    const egress = nws(period('Snow', 20, 90), { forecastUrl: 'https://evil.example.com/forecast' });
    const { a, sid } = setup(egress);
    expect(await a.weatherMessage(sid)).toBeUndefined();
    expect(egress.sent).toHaveLength(1);
  });
  it('the weather service being down says nothing and breaks nothing', async () => {
    const { a, sid } = setup(nws(period('Snow', 20, 90), { pointsStatus: 503 }));
    expect(await a.weatherMessage(sid)).toBeUndefined();
  });
  it('the network refusing the host says nothing and breaks nothing', async () => {
    const egress = new EgressTwin(['somewhere-else.example.com']);
    const { a, sid } = setup(egress);
    expect(await a.weatherMessage(sid)).toBeUndefined();
  });
  it('a student outside the area gets nothing rather than a wrong forecast', async () => {
    const egress = nws(period('Snow', 20, 90));
    const a = new Advocate({ today: () => DAY, egress });
    const sid = PERSONAS.Keisha!(a).id;
    expect(await a.weatherMessage(sid)).toBeUndefined();
    expect(egress.sent).toHaveLength(0);
  });
});
