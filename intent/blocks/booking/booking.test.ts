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
