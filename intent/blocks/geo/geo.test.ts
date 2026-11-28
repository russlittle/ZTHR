import assert from 'node:assert/strict';
import { test } from 'node:test';
import { box, check, coarsen, decode, distance, geohash, inside, nearest } from './index.ts';

const dayton = { lat: 39.7589, lng: -84.1916 };
const columbus = { lat: 39.9612, lng: -82.9988 };

test('distance and boxes', () => {
  assert.ok(Math.abs(distance(dayton, columbus) - 104_900) < 1500, `${distance(dayton, columbus)}`);
  assert.equal(distance(dayton, dayton), 0);
  const b = box(dayton, 10_000);
  for (const bearing of [0, 90, 180, 270]) {
    const lat = dayton.lat + (Math.cos((bearing * Math.PI) / 180) * 9_999) / 111_195;
    const lng = dayton.lng + (Math.sin((bearing * Math.PI) / 180) * 9_999) / (111_195 * Math.cos((dayton.lat * Math.PI) / 180));
    assert.ok(lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng);
  }
  const fiji = box({ lat: -17.7, lng: 179.9 }, 50_000);
  assert.ok(fiji.minLng > fiji.maxLng, 'crosses the antimeridian');
  assert.throws(() => check({ lat: 91, lng: 0 }), /not a position/);
});

test('nearest, service areas with holes, geohash and coarsening', () => {
  const shops = [{ id: 'c', ...columbus }, { id: 'd', lat: 39.76, lng: -84.19 }, { id: 'x', lat: 0, lng: 0 }];
  assert.deepEqual(nearest(dayton, shops, { within: 200_000 }).map((s) => s.id), ['d', 'c']);
  const area = [[{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 10, lng: 10 }, { lat: 10, lng: 0 }], [{ lat: 4, lng: 4 }, { lat: 4, lng: 6 }, { lat: 6, lng: 6 }, { lat: 6, lng: 4 }]];
  assert.equal(inside({ lat: 2, lng: 2 }, area), true);
  assert.equal(inside({ lat: 5, lng: 5 }, area), false, 'in the hole');
  assert.equal(inside({ lat: 11, lng: 5 }, area), false);
  assert.equal(geohash({ lat: 57.64911, lng: 10.40744 }, 11), 'u4pruydqqvj', 'the reference value');
  const back = decode('u4pruydqqvj');
  assert.ok(Math.abs(back.lat - 57.64911) < 1e-4 && Math.abs(back.lng - 10.40744) < 1e-4);
  const c = coarsen(dayton, 5);
  assert.ok(distance(c, dayton) < 5_000 && distance(c, dayton) > 10, 'near, but not exact');
  assert.deepEqual(coarsen({ lat: 39.759, lng: -84.192 }, 5), c, 'neighbours share an area');
});
