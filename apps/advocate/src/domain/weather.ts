import type { Egress } from '@zthr/egress';
import { time12, sentence } from './dates.js';

/**
 * Weather and roads (PRD DAY-8). Before the first class or shift of the day, the Advocate checks the forecast for
 * the student's area and, only when it changes the day (snow, ice, freezing rain, storms, extreme cold or heat),
 * says how much earlier to leave and what to bring. Ordinary days say nothing.
 *
 * The forecast comes from the National Weather Service through the egress block: a points lookup for the
 * location, then its forecast. Nothing about the student is sent; only coordinates rounded to the town.
 */
export interface Period {
  name: string;
  startTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  probabilityOfPrecipitation?: { value: number | null };
}

export interface Impact {
  severity: 0 | 1 | 2;
  reason: string;
  leaveEarlyMin: number;
  bring: string[];
}

/** What a forecast period means for getting somewhere. 0: nothing to say; 1: worth a note; 2: plan around it. */
export function impactOf(p: Period): Impact {
  const f = p.shortForecast.toLowerCase();
  const pop = p.probabilityOfPrecipitation?.value ?? 0;
  const t = p.temperatureUnit === 'C' ? p.temperature * 1.8 + 32 : p.temperature;
  if (/freezing rain|ice|sleet|blizzard|ice storm/.test(f)) return { severity: 2, reason: 'ice on the roads', leaveEarlyMin: 30, bring: ['warm layers', 'a charged phone'] };
  if (/snow/.test(f) && pop >= 50) return { severity: 2, reason: 'snow', leaveEarlyMin: 25, bring: ['boots', 'warm layers'] };
  if (/thunderstorm|severe/.test(f) && pop >= 50) return { severity: 1, reason: 'storms', leaveEarlyMin: 15, bring: ['a rain jacket'] };
  if (t <= 10) return { severity: 1, reason: `very cold, about ${Math.round(t)} degrees`, leaveEarlyMin: 10, bring: ['a hat and gloves'] };
  if (t >= 95) return { severity: 1, reason: `very hot, about ${Math.round(t)} degrees`, leaveEarlyMin: 0, bring: ['water'] };
  if (/rain|showers/.test(f) && pop >= 70) return { severity: 1, reason: 'heavy rain', leaveEarlyMin: 10, bring: ['an umbrella'] };
  return { severity: 0, reason: '', leaveEarlyMin: 0, bring: [] };
}

/** The note for the day, or nothing when the weather does not change the day. */
export function weatherNote(p: Period, firstPlace?: { what: string; start: string }): string | undefined {
  const i = impactOf(p);
  if (i.severity === 0) return undefined;
  const lead = sentence(`Heads up: ${p.name.toLowerCase() === 'today' ? 'today' : p.name} looks like ${i.reason}`);
  const leave = i.leaveEarlyMin && firstPlace ? sentence(`For ${firstPlace.what} at ${time12(firstPlace.start)}, leave about ${i.leaveEarlyMin} minutes earlier than usual`) : i.leaveEarlyMin ? sentence(`Leave about ${i.leaveEarlyMin} minutes earlier than usual`) : '';
  const bring = i.bring.length ? sentence(`Bring ${i.bring.join(' and ')}`) : '';
  return [lead, leave, bring].filter(Boolean).join(' ');
}

/** Where to look up the forecast. Rounded to two decimals: about a kilometer, the town, never an address. */
export const ZIP_POINTS: Record<string, [number, number]> = {
  '45402': [39.76, -84.19], '45403': [39.76, -84.16], '45417': [39.75, -84.25], '45435': [39.78, -84.06], '45324': [39.82, -84.03], '45385': [39.69, -83.93], '45387': [39.80, -83.89],
};

export async function forecast(egress: Egress, zip: string): Promise<Period[]> {
  const pt = ZIP_POINTS[zip];
  if (!pt) return [];
  const headers = { 'user-agent': 'Student Advocate reference app (zthr.ai)', accept: 'application/geo+json' };
  const points = await egress.send({ purpose: 'weather:points', method: 'GET', url: `https://api.weather.gov/points/${pt[0]},${pt[1]}`, headers });
  if (points.status !== 200) return [];
  const url = (JSON.parse(points.body) as { properties?: { forecast?: string } }).properties?.forecast;
  if (!url || !url.startsWith('https://api.weather.gov/')) return [];
  const f = await egress.send({ purpose: 'weather:forecast', method: 'GET', url, headers });
  if (f.status !== 200) return [];
  return ((JSON.parse(f.body) as { properties?: { periods?: Period[] } }).properties?.periods ?? []).slice(0, 4);
}
