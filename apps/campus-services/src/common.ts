import type { Context } from 'hono';
import { BadRequest, NotFound, clock } from '@zthr/twin-service';

export * from '@zthr/twin-service';


/**
 * Shared plumbing for the synthetic campus services. Each service is a stand-alone HTTP API shaped like the kind
 * of vendor a college already uses (a dining platform, a transit agency's GTFS feeds, a job board, a learning
 * management system). The data is synthetic and deterministic: the same request at the same clock gives the same
 * answer, so tests and walks can rely on it, and anyone can point the Advocate at a real vendor with the same
 * contract instead.
 *
 * Controls every service honors:
 *  - `at` query parameter or `X-Twin-Clock` header: the service's notion of now (ISO date-time). Default: real now.
 *  - `X-Twin-Scenario` header: `outage` (503), `slow` (adds 1.5 s), plus service-specific scenarios.
 */
export const CAMPUSES = {
  sinclair: { name: 'Sinclair College', city: 'Dayton', lat: 39.7573, lon: -84.1985 },
  'wright-state': { name: 'Wright State University', city: 'Fairborn', lat: 39.7817, lon: -84.0632 },
  antioch: { name: 'Antioch College', city: 'Yellow Springs', lat: 39.8047, lon: -83.8888 },
} as const;
export type CampusId = keyof typeof CAMPUSES;
export const CAMPUS_IDS = Object.keys(CAMPUSES) as CampusId[];


export function campusParam(c: Context): CampusId {
  const v = c.req.query('campus');
  if (!v) throw new BadRequest('campus is required: sinclair, wright-state or antioch');
  if (!(v in CAMPUSES)) throw new NotFound(`no campus ${v}`);
  return v as CampusId;
}

