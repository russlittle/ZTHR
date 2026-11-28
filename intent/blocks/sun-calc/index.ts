/**
 * The sun and moon over any place and time, from first principles and with no tables to download. The sun uses the
 * low-accuracy solar coordinates of Jean Meeus, Astronomical Algorithms (2nd ed.) chapter 25 (about 0.01 degree) and
 * the equation of time of chapter 28; the moon uses the leading terms of chapter 47 (about 0.1 degree in longitude).
 * It gives the position of the sun and the moon in the sky (azimuth measured from north, clockwise, altitude above the
 * horizon), the times of solar noon, sunrise, sunset, golden hour and civil, nautical and astronomical twilight for the
 * solar day at a place (found by solving for the altitude, so it is exact to the model, and polar day and polar
 * night come out as "never rises" and "never sets" rather than as wrong times), and the moon's phase, illuminated
 * fraction, age, and the time of the next new, first quarter, full or last quarter moon. Every function takes the
 * instant as an argument. Times are UTC milliseconds since the epoch; angles are degrees; the UTC offset that decides
 * which civil day is meant is the caller's (the time block knows zones), and the default is local mean solar time.
 * Accuracy: sunrise and sunset to about a minute away from the poles (atmospheric refraction varies with weather),
 * moon phases to about an hour. Out of scope: moonrise and moonset, eclipses, planets, and the difference between
 * universal and dynamical time (under 70 seconds, ignored).
 */

export class SunCalcError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const DAY = 86_400_000;
const J2000 = 2451545;
const norm360 = (x: number) => ((x % 360) + 360) % 360;
const wrap180 = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
const sinD = (x: number) => Math.sin(x * RAD);
const cosD = (x: number) => Math.cos(x * RAD);

/** Julian day number of an instant in UTC milliseconds. */
export const julianDay = (ms: number): number => ms / DAY + 2440587.5;

function checkPlace(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new SunCalcError(`latitude ${lat} is not between -90 and 90`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new SunCalcError(`longitude ${lon} is not between -180 and 180`);
}
function checkTime(ms: number): void {
  if (!Number.isFinite(ms)) throw new SunCalcError('the instant is not a finite number of milliseconds');
}

export interface SunCoordinates {
  /** Apparent ecliptic longitude, degrees. */
  readonly longitude: number;
  readonly rightAscension: number;
  readonly declination: number;
  /** Distance in astronomical units. */
  readonly distanceAu: number;
  /** Equation of time in minutes: apparent minus mean solar time. */
  readonly equationOfTimeMin: number;
}

/** Where the sun is on the celestial sphere at an instant (Meeus chapter 25 and 28). */
export function sunCoordinates(ms: number): SunCoordinates {
  checkTime(ms);
  const T = (julianDay(ms) - J2000) / 36525;
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sinD(M) + (0.019993 - 0.000101 * T) * sinD(2 * M) + 0.000289 * sinD(3 * M);
  const trueLong = L0 + C;
  const nu = M + C;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * cosD(nu));
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * sinD(omega);
  const eps0 = 23 + 26 / 60 + 21.448 / 3600 - (46.815 / 3600) * T - (0.00059 / 3600) * T * T + (0.001813 / 3600) * T * T * T;
  const eps = eps0 + 0.00256 * cosD(omega);
  const ra = norm360(Math.atan2(cosD(eps) * sinD(lambda), cosD(lambda)) * DEG);
  const dec = Math.asin(sinD(eps) * sinD(lambda)) * DEG;
  const dpsi = -0.00478 * sinD(omega);
  const E = wrap180(L0 - 0.0057183 - ra + dpsi * cosD(eps));
  return { longitude: norm360(lambda), rightAscension: ra, declination: dec, distanceAu: R, equationOfTimeMin: E * 4 };
}

/** Greenwich mean sidereal time in degrees. */
function gmst(ms: number): number {
  const d = julianDay(ms) - J2000;
  return norm360(280.46061837 + 360.98564736629 * d);
}

export interface SkyPosition {
  /** Degrees clockwise from north. */
  readonly azimuth: number;
  /** Degrees above the geometric horizon. */
  readonly altitude: number;
  /** Altitude lifted by standard atmospheric refraction (Saemundsson), the way the body is seen. */
  readonly apparentAltitude: number;
}

function horizontal(ra: number, dec: number, ms: number, lat: number, lon: number): { azimuth: number; altitude: number } {
  const H = norm360(gmst(ms) + lon - ra);
  const sinAlt = sinD(lat) * sinD(dec) + cosD(lat) * cosD(dec) * cosD(H);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
  const azimuth = norm360(Math.atan2(sinD(H), cosD(H) * sinD(lat) - Math.tan(dec * RAD) * cosD(lat)) * DEG + 180);
  return { azimuth, altitude };
}

/** Refraction in degrees for a geometric altitude, 1010 hPa and 10 C (Saemundsson); zero well below the horizon. */
export function refraction(altitude: number): number {
  if (altitude < -2) return 0;
  return (1.02 / Math.tan((altitude + 10.3 / (altitude + 5.11)) * RAD)) / 60;
}

/** The sun's place in the sky for an observer at latitude and longitude (east positive). */
export function solarPosition(ms: number, lat: number, lon: number): SkyPosition {
  checkPlace(lat, lon);
  const c = sunCoordinates(ms);
  const h = horizontal(c.rightAscension, c.declination, ms, lat, lon);
  return { ...h, apparentAltitude: h.altitude + refraction(h.altitude) };
}

export interface SunTimes {
  /** The instant of solar noon (the sun on the meridian) for the solar day. */
  readonly solarNoon: number;
  readonly solarMidnight: number;
  /** Altitude of the sun at solar noon, degrees. */
  readonly noonAltitude: number;
  /** Keys: sunrise/sunset (-0.833), civilDawn/civilDusk (-6), nauticalDawn/nauticalDusk (-12), astronomicalDawn/astronomicalDusk (-18), goldenHourStart/goldenHourEnd (+6). null when the sun never crosses that altitude that day. */
  readonly events: Readonly<Record<EventName, number | null>>;
  /** Whether the sun stays above (polar-day) or below (polar-night) the sunrise altitude all day, else null. */
  readonly polar: 'polar-day' | 'polar-night' | null;
}

export type EventName = 'sunrise' | 'sunset' | 'civilDawn' | 'civilDusk' | 'nauticalDawn' | 'nauticalDusk' | 'astronomicalDawn' | 'astronomicalDusk' | 'goldenHourStart' | 'goldenHourEnd';

const LEVELS: readonly [string, string, number][] = [
  ['sunrise', 'sunset', -0.833],
  ['civilDawn', 'civilDusk', -6],
  ['nauticalDawn', 'nauticalDusk', -12],
  ['astronomicalDawn', 'astronomicalDusk', -18],
  ['goldenHourStart', 'goldenHourEnd', 6],
];

const altitudeAt = (ms: number, lat: number, lon: number) => {
  const c = sunCoordinates(ms);
  return horizontal(c.rightAscension, c.declination, ms, lat, lon).altitude;
};

/** Bisects for the instant in [a, b] where the altitude crosses `level`, given that it does. */
function crossing(a: number, b: number, level: number, lat: number, lon: number): number {
  const rising = altitudeAt(a, lat, lon) < altitudeAt(b, lat, lon);
  let lo = a;
  let hi = b;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const above = altitudeAt(mid, lat, lon) >= level;
    if (above === rising) hi = mid;
    else lo = mid;
  }
  return Math.round((lo + hi) / 2);
}

/**
 * Solar noon, sunrise, sunset and the twilights for the solar day containing `ms`, where the day runs from local
 * mean-time midnight to midnight at the longitude, or, when `utcOffsetMinutes` is given, for the civil date that
 * instant falls on at that offset (use the offset the place had that day, daylight saving included).
 */
export function sunTimes(ms: number, lat: number, lon: number, o: { utcOffsetMinutes?: number } = {}): SunTimes {
  checkPlace(lat, lon);
  checkTime(ms);
  const offsetMs = o.utcOffsetMinutes !== undefined ? o.utcOffsetMinutes * 60_000 : Math.round(lon * 240_000);
  const local = new Date(ms + offsetMs);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // The transit near local mean noon, refined with the equation of time; the sun's own noon, not the clock's.
  let transit = day + 12 * 3_600_000 - Math.round(lon * 240_000);
  for (let i = 0; i < 4; i++) transit = day + 12 * 3_600_000 - Math.round(lon * 240_000) - Math.round(sunCoordinates(transit).equationOfTimeMin * 60_000);
  // With a civil offset the day is that civil date: keep the transit inside it.
  if (o.utcOffsetMinutes !== undefined) {
    const dayStart = day - offsetMs;
    while (transit < dayStart) transit += DAY;
    while (transit >= dayStart + DAY) transit -= DAY;
  }
  const noonAltitude = altitudeAt(transit, lat, lon);
  const midnight = transit + DAY / 2;
  const nadirAltitude = altitudeAt(midnight, lat, lon);
  const events = {} as Record<EventName, number | null>;
  for (const [rise, set, level] of LEVELS) {
    const up = noonAltitude >= level;
    const down = nadirAltitude < level;
    if (up && down) {
      events[rise as EventName] = crossing(transit - DAY / 2, transit, level, lat, lon);
      events[set as EventName] = crossing(transit, midnight, level, lat, lon);
    } else {
      events[rise as EventName] = null;
      events[set as EventName] = null;
    }
  }
  const polar = noonAltitude < -0.833 ? 'polar-night' : nadirAltitude >= -0.833 ? 'polar-day' : null;
  return { solarNoon: transit, solarMidnight: midnight, noonAltitude, events, polar };
}

// ---------------------------------------------------------------------------------------------------------------
// The moon

export interface MoonCoordinates {
  /** Geocentric ecliptic longitude and latitude of date, degrees (mean equinox). */
  readonly longitude: number;
  readonly latitude: number;
  readonly distanceKm: number;
}

/** The moon's ecliptic position from the main periodic terms of Meeus chapter 47. */
export function moonCoordinates(ms: number): MoonCoordinates {
  checkTime(ms);
  const T = (julianDay(ms) - J2000) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  const lon =
    Lp + 6.288774 * sinD(Mp) + 1.274027 * sinD(2 * D - Mp) + 0.658314 * sinD(2 * D) + 0.213618 * sinD(2 * Mp) - 0.185116 * sinD(M) - 0.114332 * sinD(2 * F) + 0.058793 * sinD(2 * D - 2 * Mp) + 0.057066 * sinD(2 * D - M - Mp) + 0.053322 * sinD(2 * D + Mp) + 0.045758 * sinD(2 * D - M) - 0.040923 * sinD(M - Mp) - 0.03472 * sinD(D) - 0.030383 * sinD(M + Mp);
  const lat = 5.128122 * sinD(F) + 0.280602 * sinD(Mp + F) + 0.277693 * sinD(Mp - F) + 0.173237 * sinD(2 * D - F) + 0.055413 * sinD(2 * D - Mp + F) + 0.046271 * sinD(2 * D - Mp - F) + 0.032573 * sinD(2 * D + F);
  const dist = 385000.56 - 20905.355 * cosD(Mp) - 3699.111 * cosD(2 * D - Mp) - 2955.968 * cosD(2 * D) - 569.925 * cosD(2 * Mp);
  return { longitude: norm360(lon), latitude: lat, distanceKm: dist };
}

/** Moon's place in the sky, corrected for parallax (up to about a degree) but not for refraction. */
export function moonPosition(ms: number, lat: number, lon: number): SkyPosition & { readonly distanceKm: number } {
  checkPlace(lat, lon);
  const m = moonCoordinates(ms);
  const eps = 23.4393 - 0.0130042 * ((julianDay(ms) - J2000) / 36525);
  const ra = norm360(Math.atan2(sinD(m.longitude) * cosD(eps) - Math.tan(m.latitude * RAD) * sinD(eps), cosD(m.longitude)) * DEG);
  const dec = Math.asin(sinD(m.latitude) * cosD(eps) + cosD(m.latitude) * sinD(eps) * sinD(m.longitude)) * DEG;
  const h = horizontal(ra, dec, ms, lat, lon);
  const parallax = Math.asin(6378.14 / m.distanceKm) * DEG;
  const altitude = h.altitude - parallax * cosD(h.altitude);
  return { azimuth: h.azimuth, altitude, apparentAltitude: altitude + refraction(altitude), distanceKm: m.distanceKm };
}

export type PhaseName = 'new' | 'waxing crescent' | 'first quarter' | 'waxing gibbous' | 'full' | 'waning gibbous' | 'last quarter' | 'waning crescent';

export interface MoonPhase {
  /** Position in the lunar cycle: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  readonly cycle: number;
  /** Fraction of the disc lit as seen from earth, 0 to 1. */
  readonly illumination: number;
  /** Days since the new moon, by the mean month. */
  readonly ageDays: number;
  readonly name: PhaseName;
  /** Degrees of elongation of the moon east of the sun. */
  readonly elongation: number;
}

const SYNODIC_DAYS = 29.530588861;
const NAMES: readonly PhaseName[] = ['new', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full', 'waning gibbous', 'last quarter', 'waning crescent'];

/** Moon minus sun ecliptic longitude, 0 to 360. */
function elongationAt(ms: number): number {
  return norm360(moonCoordinates(ms).longitude - sunCoordinates(ms).longitude);
}

/** The moon's phase at an instant. The name is the eight-fold division with a one-eighth-wide band around each main phase. */
export function moonPhase(ms: number): MoonPhase {
  const moon = moonCoordinates(ms);
  const sun = sunCoordinates(ms);
  const elongation = norm360(moon.longitude - sun.longitude);
  const psi = Math.acos(cosD(moon.latitude) * cosD(elongation)) * DEG;
  const R = 149_597_870.7 * sun.distanceAu;
  const i = Math.atan2(R * sinD(psi), moon.distanceKm - R * cosD(psi)) * DEG;
  const illumination = (1 + cosD(i)) / 2;
  const cycle = elongation / 360;
  const name = NAMES[Math.floor(((cycle + 1 / 16) % 1) * 8)]!;
  return { cycle, illumination, ageDays: cycle * SYNODIC_DAYS, name, elongation };
}

const TARGET = { new: 0, 'first quarter': 90, full: 180, 'last quarter': 270 } as const;
export type MainPhase = keyof typeof TARGET;

/** The next instant after `ms` at which the moon is new, at first quarter, full, or at last quarter. */
export function nextPhase(ms: number, phase: MainPhase): number {
  checkTime(ms);
  const target = TARGET[phase];
  const diff = (t: number) => wrap180(elongationAt(t) - target);
  const step = 3 * 3_600_000;
  let a = ms;
  let da = diff(a);
  for (let i = 0; i < 40 * 8; i++) {
    const b = a + step;
    const db = diff(b);
    if (da < 0 && db >= 0 && db < 90) {
      let lo = a;
      let hi = b;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (diff(mid) >= 0) hi = mid;
        else lo = mid;
      }
      return Math.round((lo + hi) / 2);
    }
    a = b;
    da = db;
  }
  throw new SunCalcError('no such phase was found within forty days');
}
