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

const day = (d: Date) => d.toISOString().slice(0, 10);
const at = (y: number, m: number, d: number, h = 9) => ({ y, m, d, h, min: 0 });
const days = (o: Date[]) => o.map(day);

test('every weekday is read from the zone: Sunday is 0 through Saturday is 6', () => {
  for (let i = 0; i < 7; i++) assert.equal(wallOf(new Date(Date.UTC(2026, 10, 22 + i, 12)), 'UTC').weekday, i);
});

test('a wall time just after a clock change gets the offset that applies then, not the one before', () => {
  assert.equal(iso(instant(at(2026, 3, 8, 3), NY)), '2026-03-08T07:00', 'first hour after spring forward is already summer time');
  assert.equal(iso(instant({ y: 2026, m: 3, d: 8, h: 3, min: 30 }, NY)), '2026-03-08T07:30');
  assert.equal(iso(instant({ y: 2026, m: 11, d: 1, h: 2, min: 30 }, NY)), '2026-11-01T07:30', 'after the repeated hour it is winter time');
  assert.equal(iso(instant(at(2026, 11, 1, 0), NY)), '2026-11-01T04:00', 'before the repeated hour it is still summer time');
});

test('a whole skipped day (Samoa, 30 December 2011) lands on the day after, not on the day before', () => {
  assert.equal(iso(instant(at(2011, 12, 30, 10), 'Pacific/Apia')), '2011-12-30T20:00');
  assert.equal(iso(instant(at(2011, 12, 29, 10), 'Pacific/Apia')), '2011-12-29T20:00');
});

test('weekly on Saturday and Sunday: the week starts on Monday, so Saturday comes before Sunday', () => {
  const o = occurrences(at(2026, 11, 21), 'UTC', parseRule('FREQ=WEEKLY;BYDAY=SU,SA;COUNT=4'));
  assert.deepEqual(days(o), ['2026-11-21', '2026-11-22', '2026-11-28', '2026-11-29']);
});

test('weekly: days given in any order come out in time order, and nothing before the start is produced', () => {
  const o = occurrences(at(2026, 11, 18), 'UTC', parseRule('FREQ=WEEKLY;BYDAY=FR,MO,SU,WE,TU,SA,TH;COUNT=9'));
  assert.deepEqual(days(o), ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']);
  const mondayFirst = occurrences(at(2026, 11, 18), 'UTC', parseRule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3'));
  assert.deepEqual(days(mondayFirst), ['2026-11-18', '2026-11-23', '2026-11-25'], 'the Monday before a Wednesday start is not an occurrence');
});

test('weekly with no BYDAY repeats on the start’s weekday, and INTERVAL skips whole weeks', () => {
  assert.deepEqual(days(occurrences(at(2026, 11, 18), 'UTC', parseRule('FREQ=WEEKLY;COUNT=3'))), ['2026-11-18', '2026-11-25', '2026-12-02']);
  assert.deepEqual(days(occurrences(at(2026, 11, 16), 'UTC', parseRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=4'))), ['2026-11-16', '2026-11-19', '2026-11-30', '2026-12-03']);
});

test('monthly: INTERVAL, year rollover, and a start day that some months lack', () => {
  assert.deepEqual(days(occurrences(at(2026, 11, 15), 'UTC', parseRule('FREQ=MONTHLY;COUNT=3'))), ['2026-11-15', '2026-12-15', '2027-01-15']);
  assert.deepEqual(days(occurrences(at(2026, 1, 15), 'UTC', parseRule('FREQ=MONTHLY;INTERVAL=5;COUNT=3'))), ['2026-01-15', '2026-06-15', '2026-11-15']);
  assert.deepEqual(days(occurrences(at(2026, 1, 31), 'UTC', parseRule('FREQ=MONTHLY;COUNT=3'))), ['2026-01-31', '2026-03-31', '2026-05-31'], 'February has no 31st, so it is skipped');
  assert.deepEqual(days(occurrences(at(2026, 4, 30), 'UTC', parseRule('FREQ=MONTHLY;COUNT=2'))), ['2026-04-30', '2026-05-30'], 'the last day of a month counts');
});

test('monthly BYMONTHDAY: several days in time order, none before the start, out-of-range days skipped', () => {
  assert.deepEqual(days(occurrences(at(2026, 1, 10), 'UTC', parseRule('FREQ=MONTHLY;BYMONTHDAY=28,5,20,12;COUNT=5'))), ['2026-01-12', '2026-01-20', '2026-01-28', '2026-02-05', '2026-02-12']);
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYMONTHDAY=1;COUNT=3'))), ['2026-01-01', '2026-02-01', '2026-03-01']);
  assert.deepEqual(days(occurrences(at(2026, 1, 31), 'UTC', parseRule('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3'))), ['2026-01-31', '2026-03-31', '2026-05-31']);
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYMONTHDAY=-31;COUNT=2'))), ['2026-01-01', '2026-03-01'], 'the 31st from the end does not exist in February');
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYMONTHDAY=-2;COUNT=2'))), ['2026-01-30', '2026-02-27']);
});

test('monthly BYDAY: last and second-to-last weekday, a fifth weekday that only some months have, several weekdays in time order', () => {
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3'))), ['2026-01-30', '2026-02-27', '2026-03-27']);
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYDAY=-2MO;COUNT=2'))), ['2026-01-19', '2026-02-16']);
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYDAY=+1MO;COUNT=2'))), ['2026-01-05', '2026-02-02']);
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYDAY=5MO;COUNT=3'))), ['2026-03-30', '2026-06-29', '2026-08-31'], 'months without a fifth Monday are skipped');
  assert.deepEqual(days(occurrences(at(2026, 2, 1), 'UTC', parseRule('FREQ=MONTHLY;BYDAY=FR,MO;COUNT=4'))), ['2026-02-02', '2026-02-06', '2026-02-09', '2026-02-13']);
});

test('daily BYMONTHDAY keeps only those days of the month', () => {
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=DAILY;BYMONTHDAY=1,-1;COUNT=5'))), ['2026-01-01', '2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01']);
});

test('yearly: INTERVAL, and only a 29 February start skips years without one', () => {
  assert.deepEqual(days(occurrences(at(2026, 3, 1), 'UTC', parseRule('FREQ=YEARLY;COUNT=3'))), ['2026-03-01', '2027-03-01', '2028-03-01']);
  assert.deepEqual(days(occurrences(at(2026, 2, 10), 'UTC', parseRule('FREQ=YEARLY;COUNT=3'))), ['2026-02-10', '2027-02-10', '2028-02-10']);
  assert.deepEqual(days(occurrences(at(2026, 1, 29), 'UTC', parseRule('FREQ=YEARLY;COUNT=3'))), ['2026-01-29', '2027-01-29', '2028-01-29']);
  assert.deepEqual(days(occurrences(at(2026, 6, 1), 'UTC', parseRule('FREQ=YEARLY;INTERVAL=3;COUNT=3'))), ['2026-06-01', '2029-06-01', '2032-06-01']);
  assert.deepEqual(days(occurrences(at(2026, 3, 29), 'UTC', parseRule('FREQ=YEARLY;COUNT=3'))), ['2026-03-29', '2027-03-29', '2028-03-29']);
});

test('limit, after and before: a limit stops the list, after is inclusive, before is exclusive', () => {
  const rule = parseRule('FREQ=DAILY');
  const start = at(2026, 1, 1);
  assert.equal(occurrences(start, 'UTC', rule, { limit: 2 }).length, 2);
  assert.equal(occurrences(start, 'UTC', rule).length, 500, 'the default limit');
  assert.deepEqual(days(occurrences(start, 'UTC', rule, { after: new Date('2026-01-03T09:00:00Z'), limit: 2 })), ['2026-01-03', '2026-01-04'], 'after is inclusive');
  assert.deepEqual(days(occurrences(start, 'UTC', rule, { after: new Date('2026-01-03T09:00:01Z'), limit: 1 })), ['2026-01-04']);
  assert.deepEqual(days(occurrences(start, 'UTC', rule, { before: new Date('2026-01-03T09:00:00Z') })), ['2026-01-01', '2026-01-02'], 'before is exclusive');
  assert.deepEqual(days(occurrences(start, 'UTC', rule, { before: new Date('2026-01-03T09:00:01Z') })), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(days(occurrences(start, 'UTC', parseRule('FREQ=DAILY;COUNT=5'), { after: new Date('2026-01-02T00:00:00Z'), before: new Date('2026-01-04T00:00:00Z') })), ['2026-01-02', '2026-01-03']);
});

test('the search for the next occurrence gives up after 50,000 steps', () => {
  // Friday the 13th daily-filtered, starting so that step 50,000 is a Friday the 13th and nothing else follows within the cap.
  const rule = parseRule('FREQ=DAILY;BYDAY=FR;BYMONTHDAY=13');
  const o = occurrences(at(2002, 4, 20), 'UTC', rule, { after: new Date('2139-03-01T00:00:00Z'), limit: 1 });
  assert.deepEqual(o, []);
  const reachable = occurrences(at(2002, 4, 20), 'UTC', rule, { after: new Date('2139-02-01T00:00:00Z'), limit: 1 });
  assert.deepEqual(days(reachable), ['2139-02-13'], 'the last Friday the 13th inside the cap is found');
});

test('working days include both ends, and a single day counts', () => {
  assert.equal(workingDays('2026-11-27', '2026-11-27'), 1);
  assert.equal(workingDays('2026-11-28', '2026-11-28'), 0);
  assert.equal(workingDays('2026-11-27', '2026-11-27', ['2026-11-27']), 0);
  assert.equal(workingDays('2026-11-23', '2026-11-27'), 5);
});

test('RRULE text: whitespace, a trailing semicolon, the RRULE: prefix only at the start, and malformed parts with their message', () => {
  assert.equal(parseRule('  FREQ=DAILY  ').freq, 'DAILY');
  assert.equal(parseRule('FREQ=DAILY;').freq, 'DAILY');
  assert.equal(parseRule('RRULE:FREQ=DAILY').freq, 'DAILY');
  assert.throws(() => parseRule('FREQ=DAILY;COUNT=RRULE:3'), /bad COUNT RRULE:3/);
  assert.throws(() => parseRule('FREQ=DAILY;COUNT'), /^Error: bad RRULE part COUNT$/);
  assert.throws(() => parseRule('FREQ=DAILY;=5'), /bad RRULE part =5$/);
  assert.throws(() => parseRule('FREQ=DAILY;COUNT=1=2'), /bad RRULE part COUNT=1=2$/);
  assert.throws(() => parseRule('FREQ'), /bad RRULE part FREQ$/);
});

test('RRULE: the parts each frequency allows, and the exact refusal messages', () => {
  assert.equal(parseRule('FREQ=DAILY;BYMONTHDAY=1,15').byMonthDay?.length, 2);
  assert.equal(parseRule('FREQ=WEEKLY;WKST=MO').freq, 'WEEKLY');
  assert.throws(() => parseRule('FREQ=WEEKLY;WKST=SU'), /^Error: unsupported WKST=SU \(weeks start on Monday\)$/);
  assert.throws(() => parseRule('FREQ=WEEKLY;WKST=MO;BYHOUR=9'), /^Error: unsupported BYHOUR with FREQ=WEEKLY$/);
  assert.throws(() => parseRule('FREQ=YEARLY;BYMONTH=6'), /^Error: unsupported BYMONTH with FREQ=YEARLY$/);
  assert.throws(() => parseRule('FREQ=WEEKLY;BYDAY=1MO'), /^Error: unsupported numbered BYDAY 1MO with FREQ=WEEKLY$/);
  assert.throws(() => parseRule('FREQ=HOURLY'), /^Error: unsupported FREQ HOURLY$/);
  assert.throws(() => parseRule('FREQ=DAILY;COUNT=2;UNTIL=20260107'), /^Error: an RRULE cannot have both COUNT and UNTIL$/);
});

test('INTERVAL and COUNT are whole numbers from 1 up, with named errors', () => {
  assert.equal(parseRule('FREQ=DAILY;INTERVAL=1').interval, 1);
  assert.equal(parseRule('FREQ=DAILY;INTERVAL=10').interval, 10);
  assert.equal(parseRule('FREQ=DAILY;COUNT=1').count, 1);
  assert.equal(parseRule('FREQ=DAILY;COUNT=12').count, 12);
  for (const bad of ['x1', '1x', '0', '-1', '1.5', '']) {
    assert.throws(() => parseRule(`FREQ=DAILY;INTERVAL=${bad}`), new RegExp(`^Error: bad INTERVAL ${bad.replace('.', '\\.')}$`), bad);
    assert.throws(() => parseRule(`FREQ=DAILY;COUNT=${bad}`), new RegExp(`^Error: bad COUNT ${bad.replace('.', '\\.')}$`), bad);
  }
});

test('UNTIL: a UTC time, a local time and a date are told apart, and impossible dates are refused', () => {
  assert.deepEqual(parseRule('FREQ=DAILY;UNTIL=20260107T093000Z').until, new Date('2026-01-07T09:30:00Z'));
  assert.equal(parseRule('FREQ=DAILY;UNTIL=20260107T093000Z').untilWall, undefined);
  assert.deepEqual(parseRule('FREQ=DAILY;UNTIL=20260107T093000').untilWall, { y: 2026, m: 1, d: 7, h: 9, min: 30 });
  assert.equal(parseRule('FREQ=DAILY;UNTIL=20260107T093000').until, undefined);
  assert.deepEqual(parseRule('FREQ=DAILY;UNTIL=20260107').untilWall, { y: 2026, m: 1, d: 7, h: 23, min: 59 });
  for (const ok of ['20261231', '20260101', '20260228', '20240229', '20260131']) assert.ok(parseRule(`FREQ=DAILY;UNTIL=${ok}`).untilWall, ok);
  for (const bad of ['20260001', '20261301', '20260100', '20260230', '20260229', '20260431', 'x20260107', '20260107x', '20260107T09']) assert.throws(() => parseRule(`FREQ=DAILY;UNTIL=${bad}`), new RegExp(`^Error: bad UNTIL ${bad}$`), bad);
});

test('BYDAY and BYMONTHDAY values: signs and ranges, and the whole value must match', () => {
  assert.deepEqual(parseRule('FREQ=MONTHLY;BYDAY=+2MO,-1FR,TU').byDay, [{ n: 2, day: 1 }, { n: -1, day: 5 }, { day: 2 }]);
  for (const bad of ['MOX', 'X2MO', '6MO', '0MO', 'XX']) assert.throws(() => parseRule(`FREQ=MONTHLY;BYDAY=${bad}`), new RegExp(`^Error: bad BYDAY ${bad}$`), bad);
  assert.deepEqual(parseRule('FREQ=MONTHLY;BYMONTHDAY=31,-31,+7').byMonthDay, [31, -31, 7]);
  for (const bad of ['x5', '5x', '32', '-32', '0', '123']) assert.throws(() => parseRule(`FREQ=MONTHLY;BYMONTHDAY=${bad}`), new RegExp(`^Error: bad BYMONTHDAY ${bad}$`), bad);
});

test('a wall time that only looks right in the other half-hour offset is not taken for the real one (Lord Howe)', () => {
  const LH = 'Australia/Lord_Howe';
  assert.equal(iso(instant({ y: 2026, m: 4, d: 5, h: 3, min: 45 }, LH)), '2026-04-04T17:15');
  assert.equal(iso(instant({ y: 2026, m: 4, d: 5, h: 3, min: 15 }, LH)), '2026-04-04T16:45');
});

test('Saturday and Sunday are read from BYDAY in daily and monthly rules too', () => {
  const sat = occurrences(at(2026, 11, 23), 'UTC', parseRule('FREQ=DAILY;BYDAY=SA,SU;COUNT=4'));
  assert.deepEqual(days(sat), ['2026-11-28', '2026-11-29', '2026-12-05', '2026-12-06']);
  assert.deepEqual(days(occurrences(at(2026, 11, 1), 'UTC', parseRule('FREQ=MONTHLY;BYDAY=1SA;COUNT=2'))), ['2026-11-07', '2026-12-05']);
});

test('numbered weekdays of one day are different days; only an exact repeat is dropped', () => {
  assert.deepEqual(parseRule('FREQ=MONTHLY;BYDAY=1MO,2MO,1MO,MO').byDay, [{ n: 1, day: 1 }, { n: 2, day: 1 }, { day: 1 }]);
  assert.deepEqual(days(occurrences(at(2026, 1, 1), 'UTC', parseRule('FREQ=MONTHLY;BYDAY=1MO,2MO;COUNT=4'))), ['2026-01-05', '2026-01-12', '2026-02-02', '2026-02-09']);
});
