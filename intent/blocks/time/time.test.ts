import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instant, occurrences, offset, parseRule, wallOf, workingDays } from './index.ts';

const NY = 'America/New_York';
const iso = (d: Date) => d.toISOString().slice(0, 16);

test('wall times become the right instants, across daylight-saving changes', () => {
  assert.equal(offset(new Date('2026-07-01T12:00:00Z'), NY), -240);
  assert.equal(offset(new Date('2026-12-01T12:00:00Z'), NY), -300);
  assert.equal(iso(instant({ y: 2026, m: 3, d: 8, h: 2, min: 30 }, NY)), '2026-03-08T07:30', 'a skipped time moves forward');
  assert.equal(iso(instant({ y: 2026, m: 11, d: 1, h: 1, min: 30 }, NY)), '2026-11-01T05:30', 'a repeated time takes the first');
  assert.equal(iso(instant({ y: 2026, m: 6, d: 1, h: 9, min: 0 }, 'Asia/Kolkata')), '2026-06-01T03:30');
  assert.equal(wallOf(new Date('2026-11-26T04:00:00Z'), NY).weekday, 3);
});

test('a weekly 9:00 stays at 9:00 local after the clocks change', () => {
  const r = parseRule('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6');
  const o = occurrences({ y: 2026, m: 10, d: 26, h: 9, min: 0 }, NY, r);
  assert.deepEqual(o.map(iso), ['2026-10-26T13:00', '2026-10-28T13:00', '2026-11-02T14:00', '2026-11-04T14:00', '2026-11-09T14:00', '2026-11-11T14:00']);
});

test('monthly by numbered weekday and month-end, yearly leap days, until, interval and exceptions', () => {
  const second = occurrences({ y: 2026, m: 1, d: 1, h: 10, min: 0 }, 'UTC', parseRule('FREQ=MONTHLY;BYDAY=2TU;COUNT=3'));
  assert.deepEqual(second.map((d) => d.toISOString().slice(0, 10)), ['2026-01-13', '2026-02-10', '2026-03-10']);
  const last = occurrences({ y: 2026, m: 1, d: 31, h: 0, min: 0 }, 'UTC', parseRule('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3'));
  assert.deepEqual(last.map((d) => d.toISOString().slice(0, 10)), ['2026-01-31', '2026-02-28', '2026-03-31']);
  const leap = occurrences({ y: 2024, m: 2, d: 29, h: 0, min: 0 }, 'UTC', parseRule('FREQ=YEARLY;COUNT=2'));
  assert.deepEqual(leap.map((d) => d.toISOString().slice(0, 10)), ['2024-02-29', '2028-02-29']);
  const daily = occurrences({ y: 2026, m: 1, d: 1, h: 8, min: 0 }, 'UTC', parseRule('FREQ=DAILY;INTERVAL=2;UNTIL=20260107'), { exdates: [new Date('2026-01-03T08:00:00Z')] });
  assert.deepEqual(daily.map((d) => d.getUTCDate()), [1, 5, 7]);
  assert.throws(() => parseRule('FREQ=HOURLY'), /unsupported/);
});

test('working days skip weekends and holidays', () => {
  assert.equal(workingDays('2026-11-23', '2026-11-29', ['2026-11-26']), 4);
});
