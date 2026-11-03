import type { Hono } from 'hono';
import { careersInfo, careersService } from './careers.js';
import { diningInfo, diningService } from './dining.js';
import { lmsInfo, lmsService } from './lms.js';
import { placesInfo, placesService } from './places.js';
import { transitInfo, transitService } from './transit.js';

/**
 * The synthetic campus services. Each has a stable host name on the reserved .example domain; the Advocate is
 * configured with a base URL per service and reaches it only through its egress door. In the demo and in tests,
 * that door routes these hosts to the services in-process; in a real deployment the base URLs point at a
 * college's actual vendors with the same contracts.
 */
export const SERVICES = {
  dining: { host: 'dining.campus.example', info: diningInfo, make: diningService, port: 7401 },
  transit: { host: 'transit.campus.example', info: transitInfo, make: transitService, port: 7402 },
  places: { host: 'places.campus.example', info: placesInfo, make: placesService, port: 7403 },
  careers: { host: 'careers.campus.example', info: careersInfo, make: careersService, port: 7404 },
  lms: { host: 'lms.campus.example', info: lmsInfo, make: lmsService, port: 7405 },
} as const;
export type ServiceId = keyof typeof SERVICES;
export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

/** One instance of every service, keyed by host, for an in-process egress route table. */
export function startAll(): Record<string, Hono> {
  return Object.fromEntries(SERVICE_IDS.map((id) => [SERVICES[id].host, SERVICES[id].make()]));
}

export const baseUrls = (): Record<ServiceId, string> => Object.fromEntries(SERVICE_IDS.map((id) => [id, `https://${SERVICES[id].host}`])) as Record<ServiceId, string>;

export * from './common.js';
export { LOCATIONS, CLOSURES, hoursOn, menu } from './dining.js';
export { STOPS, ROUTES, HOLIDAYS, plan, tripsOn, delayOf } from './transit.js';
export { SPACES, eventsOn } from './places.js';
export { POSTINGS, MENTORS } from './careers.js';
export { TOKENS, coursesFor, assignmentsFor } from './lms.js';
