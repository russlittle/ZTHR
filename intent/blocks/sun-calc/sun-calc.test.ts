import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SunCalcError, julianDay, moonCoordinates, moonPhase, moonPosition, nextPhase, refraction, solarPosition, sunCoordinates, sunTimes } from './index.ts';

const near = (actual: number, expected: number, tol: number, what: string) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

test('julian day: the epoch and J2000', () => {
  assert.equal(julianDay(0), 2440587.5);
  assert.equal(julianDay(utc(2000, 1, 1, 12)), 2451545);
});

test('Meeus example 25.a: the sun on 1992 October 13 at 0h', () => {
  const c = sunCoordinates(utc(1992, 10, 13));
  near(c.longitude, 199.90895, 0.001, 'apparent longitude');
  near(c.rightAscension, 198.38083, 0.001, 'right ascension');
  near(c.declination, -7.78507, 0.001, 'declination');
  near(c.distanceAu, 0.99766, 0.00001, 'distance');
});

test('Meeus example 28.b: the equation of time on 1992 October 13 is about 13 min 42.6 s', () => {
  near(sunCoordinates(utc(1992, 10, 13)).equationOfTimeMin, 13.71, 0.02, 'equation of time');
});

test('declination at the 2024 equinox is zero and at the June solstice is the obliquity', () => {
  near(sunCoordinates(utc(2024, 3, 20, 3, 6)).declination, 0, 0.02, 'March equinox');
  near(sunCoordinates(utc(2024, 6, 20, 20, 51)).declination, 23.436, 0.01, 'June solstice');
  near(sunCoordinates(utc(2024, 12, 21, 9, 21)).declination, -23.436, 0.01, 'December solstice');
});

test('sun position: due south at noon in the north, due north at noon in the south, overhead at the equator on the equinox', () => {
  const noonLondon = sunTimes(utc(2024, 6, 21, 12), 51.4769, 0).solarNoon;
  const a = solarPosition(noonLondon, 51.4769, 0);
  near(a.azimuth, 180, 0.2, 'azimuth');
  near(a.altitude, 90 - 51.4769 + 23.44, 0.05, 'noon altitude');
  const noonSydney = sunTimes(utc(2024, 6, 21, 2), -33.87, 151.21).solarNoon;
  near(((solarPosition(noonSydney, -33.87, 151.21).azimuth + 180) % 360) - 180, 0, 0.5, 'azimuth in the north (0 or 360)');
  const eq = sunTimes(utc(2024, 3, 20, 12), 0, 0);
  near(solarPosition(eq.solarNoon, 0, 0).altitude, 90, 0.8, 'overhead');
  near(eq.noonAltitude, solarPosition(eq.solarNoon, 0, 0).altitude, 1e-9, 'reported noon altitude');
});

test('refraction lifts a sun on the horizon by about a third of a degree, and nothing far below it', () => {
  near(refraction(0), 0.48, 0.05, 'at the horizon');
  assert.equal(refraction(-10), 0);
  assert.ok(refraction(45) < 0.02);
});

test('sunrise and sunset in London and New York on the June solstice 2024 agree with published tables to the minute', () => {
  const l = sunTimes(utc(2024, 6, 21, 12), 51.4769, 0, { utcOffsetMinutes: 60 });
  near(l.events.sunrise!, utc(2024, 6, 21, 3, 43), 60_000, 'London sunrise 04:43 BST');
  near(l.events.sunset!, utc(2024, 6, 21, 20, 21), 60_000, 'London sunset 21:21 BST');
  const ny = sunTimes(utc(2024, 6, 21, 16), 40.7128, -74.006, { utcOffsetMinutes: -240 });
  near(ny.events.sunrise!, utc(2024, 6, 21, 9, 25), 60_000, 'New York sunrise 5:25 EDT');
  near(ny.events.sunset!, utc(2024, 6, 22, 0, 31), 60_000, 'New York sunset 8:31 EDT');
});

test('every event is exactly where the sun reaches its altitude, and the day is ordered', () => {
  const t = sunTimes(utc(2024, 9, 10, 12), 47.6, -122.3, { utcOffsetMinutes: -420 });
  const e = t.events;
  const levels: [keyof typeof e, number][] = [['sunrise', -0.833], ['sunset', -0.833], ['civilDawn', -6], ['civilDusk', -6], ['nauticalDawn', -12], ['nauticalDusk', -12], ['astronomicalDawn', -18], ['astronomicalDusk', -18], ['goldenHourStart', 6], ['goldenHourEnd', 6]];
  for (const [k, level] of levels) near(solarPosition(e[k]!, 47.6, -122.3).altitude, level, 0.002, String(k));
  const order = [e.astronomicalDawn, e.nauticalDawn, e.civilDawn, e.sunrise, e.goldenHourStart, t.solarNoon, e.goldenHourEnd, e.sunset, e.civilDusk, e.nauticalDusk, e.astronomicalDusk].map(Number);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the equator has about twelve hours of day on the equinox and solar noon is shifted by the equation of time', () => {
  const t = sunTimes(utc(2024, 3, 20, 12), 0, 0);
  const len = (t.events.sunset! - t.events.sunrise!) / 3_600_000;
  near(len, 12.12, 0.03, 'day length');
  near(t.solarNoon, utc(2024, 3, 20, 12, 7, 20), 60_000, 'noon about 7 minutes late in March');
});

test('polar day, polar night, and twilight that never ends or never comes', () => {
  const summer = sunTimes(utc(2024, 6, 21, 12), 69.65, 18.96);
  assert.equal(summer.polar, 'polar-day');
  assert.equal(summer.events.sunrise, null);
  assert.equal(summer.events.sunset, null);
  const winter = sunTimes(utc(2024, 12, 21, 12), 69.65, 18.96);
  assert.equal(winter.polar, 'polar-night');
  assert.equal(winter.events.sunrise, null);
  assert.ok(winter.noonAltitude < -0.833);
  assert.equal(winter.events.civilDawn !== null, true, 'Tromso still has civil twilight at midwinter noon');
  const london = sunTimes(utc(2024, 6, 21, 12), 51.5, 0);
  assert.equal(london.events.astronomicalDawn, null, 'London has no astronomical night at midsummer');
  assert.equal(london.polar, null);
  assert.equal(sunTimes(utc(2024, 6, 21, 12), 90, 0).polar, 'polar-day');
});

test('a place far from its time zone, and one on the other side of the date line, still get the right civil day', () => {
  const fiji = sunTimes(utc(2024, 1, 15, 0), -17.7, 178.0, { utcOffsetMinutes: 720 });
  assert.ok(fiji.events.sunrise! > utc(2024, 1, 14, 17) && fiji.events.sunrise! < utc(2024, 1, 14, 19), 'Fiji sunrise ~6am local = 18:00 UTC the day before');
  const west = sunTimes(utc(2024, 6, 21, 12), 40, -179, { utcOffsetMinutes: -720 });
  assert.ok(west.solarNoon >= utc(2024, 6, 21, 12) && west.solarNoon < utc(2024, 6, 22, 12));
});

test('moon, Meeus example 47.a: ecliptic position on 1992 April 12 at 0h', () => {
  const m = moonCoordinates(utc(1992, 4, 12));
  near(m.longitude, 133.162655, 0.03, 'longitude');
  near(m.latitude, -3.229126, 0.03, 'latitude');
  near(m.distanceKm, 368409.7, 400, 'distance');
});

test('moon, Meeus example 48.a: the illuminated fraction on 1992 April 12 is 0.679', () => {
  const p = moonPhase(utc(1992, 4, 12));
  near(p.illumination, 0.6786, 0.001, 'illumination');
  assert.equal(p.name, 'first quarter', 'about 110 degrees of elongation: waxing, between first quarter and gibbous');
});

test('the next new, quarter and full moons of January 2024 fall within fifteen minutes of the published times', () => {
  const from = utc(2024, 1, 1);
  near(nextPhase(from, 'last quarter'), utc(2024, 1, 4, 3, 30), 15 * 60_000, 'last quarter');
  near(nextPhase(from, 'new'), utc(2024, 1, 11, 11, 57), 15 * 60_000, 'new');
  near(nextPhase(from, 'first quarter'), utc(2024, 1, 18, 3, 53), 15 * 60_000, 'first quarter');
  near(nextPhase(from, 'full'), utc(2024, 1, 25, 17, 54), 15 * 60_000, 'full');
});

test('phase at those instants: new is dark, full is lit, and names follow the cycle', () => {
  const newMoon = moonPhase(nextPhase(utc(2024, 1, 1), 'new'));
  assert.equal(newMoon.name, 'new');
  assert.ok(newMoon.illumination < 0.005, `lit at new moon: ${newMoon.illumination}`);
  const full = moonPhase(nextPhase(utc(2024, 1, 1), 'full'));
  assert.equal(full.name, 'full');
  assert.ok(full.illumination > 0.99);
  near(full.ageDays, 14.77, 0.05, 'age at full');
  const names = [3, 7, 10, 14.8, 18, 22, 26].map((d) => moonPhase(utc(2024, 1, 11, 12) + d * 86_400_000).name);
  assert.deepEqual(names, ['waxing crescent', 'first quarter', 'waxing gibbous', 'full', 'waning gibbous', 'last quarter', 'waning crescent']);
  const first = nextPhase(utc(2024, 1, 11, 13), 'new');
  near((first - nextPhase(utc(2024, 1, 1), 'new')) / 86_400_000, 29.5, 0.7, 'a lunation is about 29.5 days');
});

test('moon position: the moon is near the sun in the sky at new moon and opposite it at full moon', () => {
  const lat = 40;
  const lon = -75;
  const nm = nextPhase(utc(2024, 1, 1), 'new');
  const s = solarPosition(nm, lat, lon);
  const m = moonPosition(nm, lat, lon);
  assert.ok(Math.abs(s.altitude - m.altitude) < 8, `new moon altitude ${m.altitude} vs sun ${s.altitude}`);
  const fm = nextPhase(utc(2024, 1, 1), 'full');
  near(solarPosition(fm, lat, lon).altitude + moonPosition(fm, lat, lon).altitude, 0, 12, 'full moon opposite the sun');
  assert.ok(m.distanceKm > 356_000 && m.distanceKm < 407_000);
});

test('bad places and instants are refused with plain messages', () => {
  assert.throws(() => solarPosition(0, 91, 0), /latitude 91/);
  assert.throws(() => sunTimes(0, 0, 181), /longitude 181/);
  assert.throws(() => sunTimes(Number.NaN, 0, 0), /finite number/);
  assert.throws(() => moonPhase(Number.POSITIVE_INFINITY), SunCalcError);
  assert.throws(() => moonPosition(0, Number.NaN, 0), SunCalcError);
});
