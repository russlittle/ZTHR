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

test('RRULE parts outside the supported subset are refused rather than silently ignored', () => {
  for (const r of ['FREQ=YEARLY;BYMONTH=6', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', 'FREQ=WEEKLY;BYHOUR=9', 'FREQ=YEARLY;BYDAY=1MO', 'FREQ=WEEKLY;WKST=SU;BYDAY=SU,MO']) assert.throws(() => parseRule(r), /unsupported/, r);
  for (const r of ['FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;INTERVAL=x', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;COUNT=two', 'FREQ=DAILY;UNTIL=soon', 'FREQ=DAILY;COUNT=2;UNTIL=20260107', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=MONTHLY;BYMONTHDAY=32', 'FREQ=MONTHLY;BYDAY=0MO']) assert.throws(() => parseRule(r), /bad|unsupported|both/, r);
});

test('BYDAY limits DAILY, and BYDAY with BYMONTHDAY in MONTHLY means both (Friday the 13th)', () => {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const weekdays = occurrences({ y: 2026, m: 1, d: 1, h: 9, min: 0 }, 'UTC', parseRule('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=3'));
  assert.deepEqual(weekdays.map(day), ['2026-01-01', '2026-01-02', '2026-01-05']);
  const f13 = occurrences({ y: 2026, m: 1, d: 1, h: 9, min: 0 }, 'UTC', parseRule('FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=3'));
  assert.deepEqual(f13.map(day), ['2026-02-13', '2026-03-13', '2026-11-13']);
});

test('a date-only UNTIL includes the whole of that local day', () => {
  const o = occurrences({ y: 2026, m: 1, d: 1, h: 20, min: 0 }, NY, parseRule('FREQ=DAILY;UNTIL=20260103'));
  assert.deepEqual(o.map(iso), ['2026-01-02T01:00', '2026-01-03T01:00', '2026-01-04T01:00']);
  const utc = occurrences({ y: 2026, m: 1, d: 1, h: 20, min: 0 }, NY, parseRule('FREQ=DAILY;UNTIL=20260103T010000Z'));
  assert.deepEqual(utc.map(iso), ['2026-01-02T01:00', '2026-01-03T01:00']);
});

test('gaps and overlaps in half-hour and quarter-hour zones', () => {
  const LH = 'Australia/Lord_Howe';
  assert.equal(iso(instant({ y: 2026, m: 10, d: 4, h: 2, min: 15 }, LH)), '2026-10-03T15:45', 'the 30-minute gap moves forward 30 minutes');
  assert.equal(iso(instant({ y: 2026, m: 4, d: 5, h: 1, min: 45 }, LH)), '2026-04-04T14:45', 'the repeated half hour takes the first');
  assert.equal(iso(instant({ y: 2026, m: 6, d: 1, h: 9, min: 0 }, 'Asia/Kathmandu')), '2026-06-01T03:15');
  assert.equal(iso(instant({ y: 2026, m: 3, d: 29, h: 1, min: 30 }, 'Europe/London')), '2026-03-29T01:30');
  assert.equal(iso(instant({ y: 2026, m: 10, d: 25, h: 1, min: 30 }, 'Europe/London')), '2026-10-25T00:30');
});

test('WEEKLY BYDAY with repeated days does not repeat occurrences', () => {
  const o = occurrences({ y: 2026, m: 1, d: 5, h: 9, min: 0 }, 'UTC', parseRule('FREQ=WEEKLY;COUNT=4;BYDAY=MO,MO'));
  assert.deepEqual(o.map((d) => d.toISOString()), ['2026-01-05T09:00:00.000Z', '2026-01-12T09:00:00.000Z', '2026-01-19T09:00:00.000Z', '2026-01-26T09:00:00.000Z']);
});
