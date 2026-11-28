/**
 * Location maths without a map service: great-circle distance, a bounding box around a point (for a quick indexed
 * pre-filter), nearest places sorted by true distance, point-in-polygon for service areas (including holes),
 * geohash encoding for grouping nearby points, and coarsening a position so a person's exact location is never
 * stored or shown when an area is enough.
 */

export interface Point {
  readonly lat: number;
  readonly lng: number;
}

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function check(p: Point): Point {
  if (!(p.lat >= -90 && p.lat <= 90) || !(p.lng >= -180 && p.lng <= 180)) throw new Error(`${p.lat}, ${p.lng} is not a position on Earth`);
  return p;
}

/** Metres between two points (haversine). */
export function distance(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A box containing every point within `metres`; may cross the antimeridian (minLng > maxLng). */
export function box(p: Point, metres: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const dLat = (metres / R) * (180 / Math.PI);
  const minLat = Math.max(-90, p.lat - dLat);
  const maxLat = Math.min(90, p.lat + dLat);
  if (minLat === -90 || maxLat === 90) return { minLat, maxLat, minLng: -180, maxLng: 180 };
  const dLng = Math.asin(Math.min(1, Math.sin(metres / R) / Math.cos(rad(p.lat)))) * (180 / Math.PI);
  const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
  return dLng >= 180 ? { minLat, maxLat, minLng: -180, maxLng: 180 } : { minLat, maxLat, minLng: wrap(p.lng - dLng), maxLng: wrap(p.lng + dLng) };
}

export function nearest<T extends Point>(from: Point, places: readonly T[], o: { within?: number; limit?: number } = {}): (T & { metres: number })[] {
  return places
    .map((p) => ({ ...p, metres: distance(from, p) }))
    .filter((p) => o.within === undefined || p.metres <= o.within)
    .sort((a, b) => a.metres - b.metres)
    .slice(0, o.limit ?? 10);
}

/** Ray casting; the first ring is the outline, any further rings are holes. */
export function inside(p: Point, rings: readonly (readonly Point[])[]): boolean {
  const inRing = (ring: readonly Point[]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) c = !c;
    }
    return c;
  };
  const [outer, ...holes] = rings;
  return !!outer && inRing(outer) && !holes.some(inRing);
}

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohash(p: Point, precision = 9): string {
  let [latLo, latHi, lngLo, lngHi] = [-90, 90, -180, 180];
  let out = '';
  let bit = 0;
  let ch = 0;
  let even = true;
  while (out.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (p.lng >= mid) (ch = (ch << 1) | 1), (lngLo = mid);
      else (ch <<= 1), (lngHi = mid);
    } else {
      const mid = (latLo + latHi) / 2;
      if (p.lat >= mid) (ch = (ch << 1) | 1), (latLo = mid);
      else (ch <<= 1), (latHi = mid);
    }
    even = !even;
    if (++bit === 5) {
      out += B32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return out;
}

/** The centre of the geohash cell: a position no more precise than the cell. */
export function decode(hash: string): Point {
  let [latLo, latHi, lngLo, lngHi] = [-90, 90, -180, 180];
  let even = true;
  for (const c of hash) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error(`${hash} is not a geohash`);
    for (let b = 4; b >= 0; b--) {
      const on = (v >> b) & 1;
      if (even) on ? (lngLo = (lngLo + lngHi) / 2) : (lngHi = (lngLo + lngHi) / 2);
      else on ? (latLo = (latLo + latHi) / 2) : (latHi = (latLo + latHi) / 2);
      even = !even;
    }
  }
  return { lat: (latLo + latHi) / 2, lng: (lngLo + lngHi) / 2 };
}

/** Rounds a position to an area: 5 is about 5 km, 6 about 1 km, 7 about 150 m. */
export const coarsen = (p: Point, precision = 5) => decode(geohash(check(p), precision));
