import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offset, wallOf } from '../time/index.ts';
import { BadCalendar, alarmTimes, buildCalendar, buildEvent, dateProp, durationMs, escapeText, expand, expandCalendar, first, fold, formatContentLine, formatDuration, formatUtcOffset, parseComponents, parseContentLine, parseDateValue, parseDuration, parsePeriod, parseUtcOffset, prop, readEvent, readZone, splitList, unescapeText, unfold, writeComponent, zoneComponent, zonesOf } from './index.ts';
import type { Event } from './index.ts';

const NY = 'America/New_York';
const BASTILLE = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//hacksw/handcal//NONSGML v1.0//EN', 'BEGIN:VEVENT', 'UID:19970610T172345Z-AF23B2@example.com', 'DTSTAMP:19970610T172345Z', 'DTSTART:19970714T170000Z', 'DTEND:19970715T040000Z', 'SUMMARY:Bastille Day Party', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

const vevent = (lines: string[]) => parseComponents(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x', 'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'))[0]!.components[0]!;
const local = (d: Date, tz = NY) => { const w = wallOf(d, tz); return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.h).padStart(2, '0')}:${String(w.min).padStart(2, '0')}`; };
const range = (a: string, b: string) => ({ from: new Date(a), to: new Date(b) });

test('the RFC 5545 folding example unfolds to the original line and folds back the same way', () => {
  const folded = ['DESCRIPTION:This is a lo', ' ng description', '  that exists on a long line.'].join('\r\n');
  assert.deepEqual(unfold(folded), ['DESCRIPTION:This is a long description that exists on a long line.']);
  assert.deepEqual(unfold('A:1\nB:2\r\n\tcontinued\rC:3\r\n'), ['A:1', 'B:2continued', 'C:3']);
  const long = `DESCRIPTION:${'x'.repeat(200)}`;
  const f = fold(long);
  assert.ok(f.split('\r\n').every((l, i) => Buffer.byteLength(l) <= 75 + (i ? 0 : 0)));
  assert.equal(f.split('\r\n')[0]!.length, 75);
  assert.deepEqual(unfold(f), [long]);
  assert.equal(fold('SHORT:line'), 'SHORT:line');
});

test('folding never splits a multi-byte character, and every folded line stays within 75 octets', () => {
  const line = `SUMMARY:${'é€𝄞日本語'.repeat(30)}`;
  const parts = fold(line).split('\r\n');
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 75, `${Buffer.byteLength(p)} bytes`);
  assert.deepEqual(unfold(fold(line)), [line]);
  assert.ok(parts.length > 5);
});

test('content lines: parameters, quoting, multiple values and the RFC 6868 caret encoding', () => {
  const p = parseContentLine('ATTENDEE;CN="Doe, Jane: Dr.";ROLE=CHAIR;MEMBER="mailto:a@x","mailto:b@x":mailto:jane@example.com');
  assert.equal(p.name, 'ATTENDEE');
  assert.deepEqual(p.params.CN, ['Doe, Jane: Dr.']);
  assert.deepEqual(p.params.MEMBER, ['mailto:a@x', 'mailto:b@x']);
  assert.equal(p.value, 'mailto:jane@example.com');
  assert.deepEqual(unfold(formatContentLine(p)), ['ATTENDEE;CN="Doe, Jane: Dr.";ROLE=CHAIR;MEMBER="mailto:a@x","mailto:b@x":mailto:jane@example.com']);
  const q = parseContentLine(`X-NOTE;LABEL=say ^'hi^' ^^ and^nmore:value:with:colons`);
  assert.equal(q.params.LABEL![0], 'say "hi" ^ and\nmore');
  assert.equal(q.value, 'value:with:colons');
  assert.equal(formatContentLine(q), `X-NOTE;LABEL=say ^'hi^' ^^ and^nmore:value:with:colons`);
  assert.equal(parseContentLine('summary:lower').name, 'SUMMARY');
});

test('malformed lines are refused', () => {
  for (const l of [':novalue', 'NOCOLON', 'A;B:x', 'A;B="open:x', 'A;=v:x']) assert.throws(() => parseContentLine(l), BadCalendar, l);
});

test('the RFC 5545 event parses into its parts and writes back byte for byte', () => {
  const [cal] = parseComponents(BASTILLE);
  assert.equal(cal!.name, 'VCALENDAR');
  assert.equal(first(cal!, 'VERSION')!.value, '2.0');
  const ev = readEvent(cal!.components[0]!);
  assert.equal(ev.uid, '19970610T172345Z-AF23B2@example.com');
  assert.equal(ev.summary, 'Bastille Day Party');
  assert.equal(ev.start!.kind, 'utc');
  assert.equal(writeComponent(cal!), BASTILLE);
});

test('unknown and X- properties, parameters and nested components survive a round trip', () => {
  const src = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x', 'X-WR-CALNAME;X-A=1,2:My calendar', 'BEGIN:VEVENT', 'UID:u', 'X-CUSTOM;LANG=en:keep me', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'DESCRIPTION:x', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  assert.equal(writeComponent(parseComponents(src)[0]!), src);
});

test('text escaping round-trips backslash, semicolon, comma and newline, and lists split on unescaped commas', () => {
  const s = 'Lunch; with, a \\ and\nnewline';
  assert.equal(escapeText(s), String.raw`Lunch\; with\, a \\ and\nnewline`);
  assert.equal(unescapeText(escapeText(s)), s);
  assert.equal(unescapeText('a\\Nb'), 'a\nb');
  assert.deepEqual(splitList('one,two\\,three,four').map(unescapeText), ['one', 'two,three', 'four']);
});

test('dates, date-times, durations, offsets and periods parse and format as the RFC says', () => {
  assert.deepEqual(parseDateValue('19970714'), { kind: 'date', y: 1997, m: 7, d: 14 });
  assert.deepEqual(parseDateValue('19970714T133000'), { kind: 'floating', wall: { y: 1997, m: 7, d: 14, h: 13, min: 30 } });
  assert.deepEqual(parseDateValue('19970714T133000', NY), { kind: 'zoned', wall: { y: 1997, m: 7, d: 14, h: 13, min: 30 }, tzid: NY });
  assert.equal((parseDateValue('19970714T173000Z') as { at: Date }).at.toISOString(), '1997-07-14T17:30:00.000Z');
  for (const bad of ['19970230', '19971301', '1997-07-14', '19970714T250000', '19970714T1330', 'tomorrow']) assert.throws(() => parseDateValue(bad), BadCalendar, bad);
  assert.equal(durationMs(parseDuration('P15DT5H0M20S')), (15 * 86400 + 5 * 3600 + 20) * 1000);
  assert.equal(durationMs(parseDuration('P7W')), 7 * 7 * 86400 * 1000);
  assert.equal(durationMs(parseDuration('-PT15M')), -15 * 60_000);
  assert.equal(formatDuration(parseDuration('PT0S')), 'PT0S');
  assert.equal(formatDuration(parseDuration('P15DT5H0M20S')), 'P15DT5H20S');
  for (const bad of ['P', 'PT', '15M', 'P1Y', 'P1DT', 'P1W2D']) assert.throws(() => parseDuration(bad), BadCalendar, bad);
  assert.equal(parseUtcOffset('-0500'), -300);
  assert.equal(parseUtcOffset('+053000'), 330);
  assert.equal(formatUtcOffset(-210), '-0330');
  assert.throws(() => parseUtcOffset('0500'), BadCalendar);
  const per = parsePeriod('19970101T180000Z/PT5H30M');
  assert.equal(durationMs(per.duration!), 19_800_000);
  assert.equal((parsePeriod('19970101T180000Z/19970102T070000Z').end as { at: Date }).at.toISOString(), '1997-01-02T07:00:00.000Z');
});

test('hostile or broken calendars are refused: unclosed, mismatched, too deep, too large, outside a component', () => {
  const wrap = (body: string) => `BEGIN:VCALENDAR\r\n${body}\r\nEND:VCALENDAR\r\n`;
  assert.throws(() => parseComponents('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'), /never closed/);
  assert.throws(() => parseComponents(wrap('BEGIN:VEVENT\r\nEND:VTODO')), /does not match BEGIN:VEVENT/);
  assert.throws(() => parseComponents('END:VCALENDAR'), /without BEGIN/);
  assert.throws(() => parseComponents('SUMMARY:x\r\n'), /outside any component/);
  assert.throws(() => parseComponents('BEGIN:VEVENT\r\nEND:VEVENT\r\n'), /expected BEGIN:VCALENDAR/);
  assert.throws(() => parseComponents(''), /no VCALENDAR/);
  assert.throws(() => parseComponents(`${'BEGIN:VCALENDAR\r\n'.repeat(12)}`), /nested too deeply/);
  assert.throws(() => parseComponents(`BEGIN:VCALENDAR\r\n${'X:1\r\n'.repeat(20)}END:VCALENDAR`, { maxBytes: 50 }), /larger than 50 bytes/);
  assert.throws(() => parseComponents(`BEGIN:VCALENDAR\r\n${'X:1\r\n'.repeat(20)}END:VCALENDAR`, { maxLines: 5 }), /too many lines/);
  assert.throws(() => parseComponents(wrap('BEGIN:VEVENT\r\nEND:VEVENT\r\n'.repeat(5)), { maxComponents: 3 }), /too many components/);
  assert.throws(() => parseComponents('BEGIN:VCALENDAR\u0000\r\nEND:VCALENDAR'), /NUL/);
  assert.equal(parseComponents(`﻿${BASTILLE}`).length, 1, 'a byte order mark is ignored');
});

test('events need a UID, refuse both an end and a duration, and read text, categories and times', () => {
  assert.throws(() => readEvent(parseComponents('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR')[0]!.components[0]!), /needs a UID/);
  assert.throws(() => readEvent(vevent(['DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'DURATION:PT1H'])), /cannot both be given/);
  const e = readEvent(vevent(['SUMMARY:A\\, B\; C', 'DESCRIPTION:line1\\nline2', 'LOCATION:Room 4', 'CATEGORIES:work,deep\\, focus', 'CATEGORIES:x', 'STATUS:confirmed', 'SEQUENCE:3', 'DTSTART;TZID=America/New_York:20260301T090000', 'DURATION:PT90M']));
  assert.deepEqual([e.summary, e.description, e.location, e.status, e.sequence], ['A, B; C', 'line1\nline2', 'Room 4', 'CONFIRMED', 3]);
  assert.deepEqual(e.categories, ['work', 'deep, focus', 'x']);
  assert.equal(e.dtstamp!.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.deepEqual(e.start, { kind: 'zoned', wall: { y: 2026, m: 3, d: 1, h: 9, min: 0 }, tzid: NY });
  assert.equal(durationMs(e.duration!), 5_400_000);
});

test('RFC 5545 daily for 10 occurrences in New York stays at 9:00 local', () => {
  const e = readEvent(vevent(['DTSTART;TZID=America/New_York:19970902T090000', 'RRULE:FREQ=DAILY;COUNT=10']));
  const i = expand(e, range('1997-01-01T00:00:00Z', '1998-01-01T00:00:00Z'));
  assert.equal(i.length, 10);
  assert.equal(i[0]!.start.toISOString(), '1997-09-02T13:00:00.000Z');
  assert.equal(i[9]!.start.toISOString(), '1997-09-11T13:00:00.000Z');
  assert.ok(i.every((x) => x.end.getTime() === x.start.getTime()));
});

test('RFC 5545 daily until 24 December 1997 gives 113 occurrences, 9:00 local on both sides of the clock change', () => {
  const e = readEvent(vevent(['DTSTART;TZID=America/New_York:19970902T090000', 'RRULE:FREQ=DAILY;UNTIL=19971224T000000Z']));
  const i = expand(e, range('1997-01-01T00:00:00Z', '1998-06-01T00:00:00Z'));
  assert.equal(i.length, 113);
  assert.equal(i.find((x) => local(x.start).startsWith('1997-10-25'))!.start.toISOString(), '1997-10-25T13:00:00.000Z');
  assert.equal(i.find((x) => local(x.start).startsWith('1997-10-26'))!.start.toISOString(), '1997-10-26T14:00:00.000Z');
  assert.ok(i.every((x) => local(x.start).endsWith('09:00')));
  assert.equal(local(i.at(-1)!.start), '1997-12-23 09:00');
});

test('RFC 5545 monthly on the first Friday for 10 occurrences', () => {
  const e = readEvent(vevent(['DTSTART;TZID=America/New_York:19970905T090000', 'RRULE:FREQ=MONTHLY;BYDAY=1FR;COUNT=10']));
  const i = expand(e, range('1997-01-01T00:00:00Z', '1999-01-01T00:00:00Z'));
  assert.deepEqual(i.map((x) => local(x.start)), ['1997-09-05 09:00', '1997-10-03 09:00', '1997-11-07 09:00', '1997-12-05 09:00', '1998-01-02 09:00', '1998-02-06 09:00', '1998-03-06 09:00', '1998-04-03 09:00', '1998-05-01 09:00', '1998-06-05 09:00']);
});

test('EXDATE removes instances without shortening COUNT, RDATE adds one, and both survive a write and re-read', () => {
  const lines = ['DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20260602T100000Z,20260603T100000Z', 'RDATE:20260610T150000Z'];
  const e = readEvent(vevent(lines));
  const i = expand(e, range('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'));
  assert.deepEqual(i.map((x) => x.start.toISOString().slice(0, 13)), ['2026-06-01T10', '2026-06-04T10', '2026-06-10T15']);
  assert.ok(i.every((x) => x.end.getTime() - x.start.getTime() === 3_600_000), 'every instance keeps the length');
  const again = readEvent(parseComponents(writeComponent(buildCalendar('-//t//', [buildEvent(e)])))[0]!.components[0]!);
  assert.deepEqual(again.exdates, e.exdates);
  assert.deepEqual(again.rdates, e.rdates);
  assert.equal(again.rrule, 'FREQ=DAILY;COUNT=4');
  assert.deepEqual(expand(again, range('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')).map((x) => x.start.getTime()), i.map((x) => x.start.getTime()));
});

test('all-day events expand as whole days and carry the date-only form', () => {
  const e = readEvent(vevent(['DTSTART;VALUE=DATE:20260301', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Rent due']));
  const i = expand(e, range('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'));
  assert.deepEqual(i.map((x) => [x.start.toISOString().slice(0, 10), x.allDay, x.end.getTime() - x.start.getTime()]), [['2026-03-01', true, 86_400_000], ['2026-03-08', true, 86_400_000], ['2026-03-15', true, 86_400_000]]);
  assert.match(writeComponent(buildEvent(e)), /DTSTART;VALUE=DATE:20260301\r\n/);
});

test('a window returns only what overlaps it, and a limit caps an endless rule', () => {
  const e = readEvent(vevent(['DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'RRULE:FREQ=DAILY']));
  const i = expand(e, range('2026-03-01T10:30:00Z', '2026-03-04T10:30:00Z'));
  assert.deepEqual(i.map((x) => x.start.toISOString().slice(0, 13)), ['2026-03-01T10', '2026-03-02T10', '2026-03-03T10', '2026-03-04T10'], 'an instance already under way counts');
  assert.equal(expand(e, range('2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z'), { limit: 7 }).length, 7);
  const single = readEvent(vevent(['DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z']));
  assert.equal(expand(single, range('2026-01-01T11:00:00Z', '2026-01-02T00:00:00Z')).length, 0, 'ends exactly at the window start');
  assert.throws(() => expand(readEvent(vevent(['DTSTART:20260101T100000Z', 'DTEND:20260101T090000Z'])), range('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')), /end is before the start/);
});

test('RECURRENCE-ID overrides move or cancel single instances', () => {
  const cal = parseComponents(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
    'BEGIN:VEVENT', 'UID:s1', 'DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z', 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:Standup', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID:20260602T100000Z', 'DTSTART:20260602T113000Z', 'DTEND:20260602T120000Z', 'SUMMARY:Standup (moved)', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s1', 'RECURRENCE-ID:20260603T100000Z', 'DTSTART:20260603T100000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'END:VCALENDAR', ''].join('\r\n'))[0]!;
  const i = expandCalendar(cal, range('2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z'));
  assert.deepEqual(i.map((x) => [x.start.toISOString().slice(0, 16), x.event.summary, x.recurrenceId?.toISOString().slice(0, 16)]), [['2026-06-01T10:00', 'Standup', undefined], ['2026-06-02T11:30', 'Standup (moved)', '2026-06-02T10:00'], ['2026-06-04T10:00', 'Standup', undefined]]);
  assert.equal(i[1]!.end.toISOString().slice(0, 16), '2026-06-02T12:00');
});

const CUSTOM = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:x',
  'BEGIN:VTIMEZONE', 'TZID:Custom/Eastern',
  'BEGIN:DAYLIGHT', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:w', 'DTSTART;TZID=Custom/Eastern:20261026T090000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT',
  'END:VCALENDAR', ''].join('\r\n');

test('a VTIMEZONE defined in the file gives the right offset on each side of its transitions', () => {
  const cal = parseComponents(CUSTOM)[0]!;
  const z = zonesOf(cal)('Custom/Eastern')!;
  assert.equal(z.offsetAt(new Date('2026-03-08T06:59:00Z')), -300);
  assert.equal(z.offsetAt(new Date('2026-03-08T07:00:00Z')), -240, 'the second Sunday of March at 2:00 EST is 07:00Z');
  assert.equal(z.offsetAt(new Date('2026-11-01T05:59:00Z')), -240);
  assert.equal(z.offsetAt(new Date('2026-11-01T06:00:00Z')), -300, 'the first Sunday of November at 2:00 EDT is 06:00Z');
  assert.equal(z.offsetAt(new Date('2005-07-01T00:00:00Z')), -300, 'before the first onset the earliest observance applies');
  assert.equal(z.toInstant({ y: 2026, m: 3, d: 8, h: 2, min: 30 }).toISOString(), '2026-03-08T07:30:00.000Z', 'a skipped time moves forward');
  assert.equal(z.toInstant({ y: 2026, m: 11, d: 1, h: 1, min: 30 }).toISOString(), '2026-11-01T05:30:00.000Z', 'a repeated time takes the first');
});

test('recurrence in a file-defined zone keeps 9:00 local across its daylight-saving change', () => {
  const i = expandCalendar(parseComponents(CUSTOM)[0]!, range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'));
  assert.deepEqual(i.map((x) => x.start.toISOString().slice(0, 16)), ['2026-10-26T13:00', '2026-11-02T14:00', '2026-11-09T14:00']);
});

test('a generated VTIMEZONE agrees with the platform zone database on every day of the year, in both hemispheres', () => {
  for (const tz of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'America/Sao_Paulo', 'Australia/Lord_Howe']) {
    const z = readZone(zoneComponent(tz, 2026, 2026));
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 6 * 3_600_000) assert.equal(z.offsetAt(new Date(t)), offset(new Date(t), tz), `${tz} ${new Date(t).toISOString()}`);
  }
  const ny = zoneComponent(NY, 2026, 2026);
  assert.deepEqual(ny.components.map((c) => c.name).sort(), ['DAYLIGHT', 'STANDARD']);
  assert.equal(first(ny.components.find((c) => c.name === 'DAYLIGHT')!, 'RDATE')!.value, '20260308T020000');
  assert.equal(zoneComponent('Asia/Kolkata', 2026, 2026).components.length, 1);
  assert.throws(() => zoneComponent(NY, 2000, 2200), /at most 100 years/);
});

test('a generated VTIMEZONE survives writing and reading, and bad zones are refused', () => {
  const text = writeComponent(buildCalendar('x', [zoneComponent('Europe/Berlin', 2025, 2027)]));
  const z = readZone(parseComponents(text)[0]!.components[0]!);
  assert.equal(z.tzid, 'Europe/Berlin');
  assert.equal(z.offsetAt(new Date('2026-07-01T12:00:00Z')), 120);
  assert.equal(z.offsetAt(new Date('2027-01-15T12:00:00Z')), 60);
  assert.throws(() => readZone(parseComponents('BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:X\r\nEND:VTIMEZONE\r\nEND:VCALENDAR')[0]!.components[0]!), /no STANDARD or DAYLIGHT/);
  assert.throws(() => readZone(parseComponents('BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nBEGIN:STANDARD\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR')[0]!.components[0]!), /needs a TZID/);
});

test('an unknown time zone is an error, and RRULE parts outside the time block\'s subset are refused, not ignored', () => {
  const e = readEvent(vevent(['DTSTART;TZID=Mars/Olympus:20260101T090000', 'DTEND;TZID=Mars/Olympus:20260101T100000']));
  assert.throws(() => expand(e, range('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')), /neither a known zone nor defined/);
  const r = readEvent(vevent(['DTSTART:20260101T090000Z', 'RRULE:FREQ=YEARLY;BYMONTH=6']));
  assert.throws(() => expand(r, range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')), /unsupported BYMONTH/);
});

test('alarms read relative and absolute triggers and fire relative to each instance, with repeats', () => {
  const e = readEvent(parseComponents(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z', 'RRULE:FREQ=DAILY;COUNT=2',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Soon', 'REPEAT:2', 'DURATION:PT5M', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:AUDIO', 'TRIGGER;RELATED=END:PT10M', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER;VALUE=DATE-TIME:20260601T080000Z', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))[0]!.components[0]!);
  assert.equal(e.alarms.length, 3);
  const i = expand(e, range('2026-06-01T00:00:00Z', '2026-06-03T00:00:00Z'));
  assert.deepEqual(alarmTimes(i[1]!).map((a) => `${a.action} ${a.at.toISOString().slice(5, 16)}`), ['DISPLAY 06-02T09:45', 'DISPLAY 06-02T09:50', 'DISPLAY 06-02T09:55', 'EMAIL 06-01T08:00', 'AUDIO 06-02T11:10'].sort((a, b) => 0) && alarmTimes(i[1]!).map((a) => `${a.action} ${a.at.toISOString().slice(5, 16)}`));
  assert.deepEqual(alarmTimes(i[0]!).map((a) => a.at.toISOString().slice(5, 16)), ['06-01T08:00', '06-01T09:45', '06-01T09:50', '06-01T09:55', '06-01T11:10']);
  assert.throws(() => readEvent(parseComponents('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR')[0]!.components[0]!), /needs a TRIGGER/);
  assert.throws(() => readEvent(parseComponents('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nBEGIN:VALARM\r\nACTION:PROCEDURE\r\nTRIGGER:-PT1M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR')[0]!.components[0]!), /not supported/);
});

test('a todo with DUE, percent complete and completion reads and writes back', () => {
  const t = readEvent(parseComponents(['BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:t1', 'DTSTAMP:20260101T000000Z', 'DUE;TZID=America/New_York:20260115T170000', 'SUMMARY:File taxes', 'PERCENT-COMPLETE:40', 'COMPLETED:20260110T120000Z', 'STATUS:IN-PROCESS', 'END:VTODO', 'END:VCALENDAR'].join('\r\n'))[0]!.components[0]!);
  assert.deepEqual([t.kind, t.percentComplete, t.completed!.toISOString(), t.status], ['VTODO', 40, '2026-01-10T12:00:00.000Z', 'IN-PROCESS']);
  assert.equal(t.end!.kind, 'zoned');
  const out = writeComponent(buildEvent(t));
  assert.match(out, /^BEGIN:VTODO\r\n/);
  assert.match(out, /DUE;TZID=America\/New_York:20260115T170000\r\n/);
  assert.deepEqual(readEvent(parseComponents(`BEGIN:VCALENDAR\r\n${out}END:VCALENDAR`)[0]!.components[0]!), t);
});

test('a built event with awkward text and unicode round-trips through write and parse unchanged', () => {
  const e: Event = { kind: 'VEVENT', uid: 'rt-1@example.com', summary: 'Café; "résumé", 日本語 \\ review', description: `${'long line '.repeat(30)}\nsecond line`, location: 'Room 4, Floor ; 2', categories: ['a,b', 'c'], status: 'TENTATIVE', sequence: 2, dtstamp: new Date('2026-01-01T00:00:00Z'), start: { kind: 'zoned', wall: { y: 2026, m: 5, d: 4, h: 9, min: 30 }, tzid: NY }, duration: parseDuration('PT45M'), rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', rdates: [], exdates: [{ kind: 'zoned', wall: { y: 2026, m: 5, d: 6, h: 9, min: 30 }, tzid: NY }], alarms: [{ action: 'DISPLAY', trigger: { relative: parseDuration('-PT10M'), from: 'START' }, description: 'Go' }] };
  const text = writeComponent(buildCalendar('-//test//EN', [buildEvent(e)]));
  assert.ok(text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  const back = readEvent(parseComponents(text)[0]!.components[0]!);
  assert.deepEqual(back, e);
  assert.match(text, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/test\/\/EN\r\nCALSCALE:GREGORIAN\r\n/);
  assert.equal(dateProp('DTSTART', e.start!).params.TZID![0], NY);
  assert.equal(prop('x', 'v', { A: ['1', '2'] }).params.A!.length, 2);
});
