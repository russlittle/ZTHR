import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bookings, findTime, free, type Calendar } from './index.ts';

const t = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString().slice(0, 16);
const weekdays = (a: number, b: number) => ({ 1: [a, b], 2: [a, b], 3: [a, b], 4: [a, b], 5: [a, b] }) as Calendar['hours'];

test('free time is inside local working hours and outside busy periods', () => {
  const ana: Calendar = { id: 'ana', tz: 'America/New_York', hours: weekdays(9, 17), busy: [{ start: t('2026-11-30T15:00:00Z'), end: t('2026-11-30T16:00:00Z') }] };
  const f = free(ana, { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T00:00:00Z') });
  assert.deepEqual(f.map((s) => [iso(s.start), iso(s.end)]), [['2026-11-30T14:00', '2026-11-30T15:00'], ['2026-11-30T16:00', '2026-11-30T22:00']]);
  assert.deepEqual(free(ana, { start: t('2026-11-28T00:00:00Z'), end: t('2026-11-29T23:00:00Z') }), [], 'no hours at the weekend');
});

test('find a time across zones picks a slot everyone can make, kindest to their days', () => {
  const ana: Calendar = { id: 'ana', tz: 'America/New_York', hours: weekdays(9, 17), busy: [] };
  const raj: Calendar = { id: 'raj', tz: 'Europe/London', hours: weekdays(9, 17), busy: [{ start: t('2026-11-30T14:00:00Z'), end: t('2026-11-30T15:00:00Z') }] };
  const slots = findTime([ana, raj], { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T00:00:00Z') }, 30, { stepMinutes: 30 });
  assert.deepEqual(slots.map((s) => iso(s.start)), ['2026-11-30T15:00', '2026-11-30T15:30', '2026-11-30T16:00', '2026-11-30T16:30']);
  assert.deepEqual(findTime([ana, raj], { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T00:00:00Z') }, 180), [], 'no three-hour overlap');
});

test('a slot can be held by one person only, holds expire, and buffers keep gaps', () => {
  let now = t('2026-11-26T12:00:00Z');
  const b = new Bookings({ now: () => now, bufferMinutes: 10 });
  const slot = { start: t('2026-11-30T15:00:00Z'), end: t('2026-11-30T15:30:00Z') };
  const h = b.hold('room-1', slot, 'ana');
  assert.throws(() => b.hold('room-1', slot, 'ben'), /just been taken/);
  assert.throws(() => b.hold('room-1', { start: slot.end + 5 * 60_000, end: slot.end + 35 * 60_000 }, 'ben'), /just been taken/, 'inside the buffer');
  b.hold('room-1', { start: slot.end + 10 * 60_000, end: slot.end + 40 * 60_000 }, 'ben');
  now += 11 * 60_000;
  assert.throws(() => b.confirm(h.id, 'ana'), /expired/);
  const again = b.hold('room-1', slot, 'cy');
  b.confirm(again.id, 'cy');
  now += 60 * 60_000;
  assert.deepEqual(b.busy('room-1'), [slot], 'confirmed stays; expired holds drop out');
  assert.throws(() => b.hold('room-1', { start: slot.end, end: slot.start }, 'x'), /end after/);
});

test('the day the clocks go forward is not skipped when the range starts near local midnight', () => {
  const every = { 0: [9, 17], 1: [9, 17], 2: [9, 17], 3: [9, 17], 4: [9, 17], 5: [9, 17], 6: [9, 17] } as Calendar['hours'];
  const lon: Calendar = { id: 'lon', tz: 'Europe/London', hours: every, busy: [] };
  const f = free(lon, { start: t('2026-03-28T23:30:00Z'), end: t('2026-03-30T00:00:00Z') });
  assert.deepEqual(f.map((s) => [iso(s.start), iso(s.end)]), [['2026-03-29T08:00', '2026-03-29T16:00']]);
  const lh: Calendar = { id: 'lh', tz: 'Australia/Lord_Howe', hours: every, busy: [] };
  const g = free(lh, { start: t('2026-10-03T13:20:00Z'), end: t('2026-10-04T13:00:00Z') });
  assert.deepEqual(g.map((s) => [iso(s.start), iso(s.end)]), [['2026-10-03T22:00', '2026-10-04T06:00']]);
});

test('working hours can start on the half hour', () => {
  const c: Calendar = { id: 'k', tz: 'Asia/Kathmandu', hours: { 1: [9.5, 17.25] }, busy: [] };
  const f = free(c, { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T00:00:00Z') });
  assert.deepEqual(f.map((s) => [iso(s.start), iso(s.end)]), [['2026-11-30T03:45', '2026-11-30T11:30']]);
});

test('a zero or negative step or length is refused instead of looping forever', () => {
  const c: Calendar = { id: 'a', tz: 'UTC', hours: weekdays(9, 17), busy: [] };
  const r = { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T00:00:00Z') };
  assert.throws(() => findTime([c], r, 30, { stepMinutes: 0 }), /step/);
  assert.throws(() => findTime([c], r, 0), /length/);
  assert.throws(() => new Bookings().hold('r', { start: Number.NaN, end: 5 }, 'x'), /end after/);
});

test('slots nearer the middle of each person’s own working day rank first', () => {
  const early: Calendar = { id: 'e', tz: 'UTC', hours: weekdays(6, 14), busy: [] };
  const slots = findTime([early], { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T00:00:00Z') }, 60, { stepMinutes: 60, limit: 1 });
  assert.equal(iso(slots[0]!.start), '2026-11-30T09:00');
});

test('working hours that cross midnight run into the next morning', () => {
  const night: Calendar = { id: 'n', tz: 'UTC', hours: { 1: [22, 6] }, busy: [] };
  const spans = free(night, { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-02T00:00:00Z') });
  assert.deepEqual(spans.map((s) => [iso(s.start), iso(s.end)]), [['2026-11-30T22:00', '2026-12-01T06:00']]);
  const nyc: Calendar = { id: 'y', tz: 'America/New_York', hours: { 0: [22, 6], 1: [22, 6] }, busy: [{ start: t('2026-11-30T05:00:00Z'), end: t('2026-11-30T06:00:00Z') }] };
  assert.deepEqual(free(nyc, { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T12:00:00Z') }).map((s) => [iso(s.start), iso(s.end)]), [['2026-11-30T03:00', '2026-11-30T05:00'], ['2026-11-30T06:00', '2026-11-30T11:00'], ['2026-12-01T03:00', '2026-12-01T11:00']], 'Sunday night into Monday, in their own zone, around the busy hour');
  const both: Calendar = { id: 'b', tz: 'UTC', hours: { 1: [22, 6], 2: [0, 8] }, busy: [] };
  assert.deepEqual(free(both, { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-02T00:00:00Z') }).map((s) => [iso(s.start), iso(s.end)]), [['2026-11-30T22:00', '2026-12-01T08:00']], 'overlapping hours join into one span');
  const best = findTime([night], { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-02T00:00:00Z') }, 60, { stepMinutes: 60, limit: 8 });
  assert.equal(best.length, 8);
  assert.equal(iso(best[0]!.start), '2026-11-30T23:00', 'the earlier day first, nearest the middle of the shift (2:00) within it');
  assert.deepEqual(best.slice(1, 3).map((s) => iso(s.start)), ['2026-11-30T22:00', '2026-12-01T01:00'], 'then the next day, from the slot nearest 2:00');
  assert.equal(free({ ...night, hours: { 1: [9, 9] } }, { start: t('2026-11-30T00:00:00Z'), end: t('2026-12-01T00:00:00Z') }).length, 0, 'equal hours are not working');
});

test('only the person who booked, or a permitted role, can cancel', () => {
  const b = new Bookings({ now: () => 0, cancelRoles: ['admin'] });
  const span = { start: 1_000_000, end: 2_000_000 };
  const mine = b.hold('room', span, 'ana');
  assert.throws(() => b.cancel(mine.id, 'ben'), /no such booking/);
  assert.throws(() => b.cancel(mine.id, 'ben', ['member']), /no such booking/);
  assert.throws(() => b.cancel(99, 'ana'), /no such booking/);
  assert.equal(b.busy('room').length, 1, 'still held');
  assert.equal(b.cancel(mine.id, 'ana').state, 'cancelled');
  const other = b.hold('room', span, 'cy');
  assert.equal(b.cancel(other.id, 'ops', ['admin']).state, 'cancelled');
});
