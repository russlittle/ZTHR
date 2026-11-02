import { describe, expect, it } from 'vitest';
import { decideContact, inQuietHours, localClock } from '@zthr/runtime';

// November 2026: Eastern time is UTC-5.
const et = (hhmm: string, day = '2026-11-02') => new Date(`${day}T${String((Number(hhmm.slice(0, 2)) + 5) % 24).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);

describe('quiet hours boundaries', () => {
  const day = { maxPerDay: 3, quietStart: '13:00', quietEnd: '15:00', timeZone: 'America/New_York' };
  const night = { maxPerDay: 3, quietStart: '22:30', quietEnd: '07:15', timeZone: 'America/New_York' };
  it('non-wrapping window: start inclusive, end exclusive', () => {
    expect(inQuietHours(day, et('12:59'))).toBe(false);
    expect(inQuietHours(day, et('13:00'))).toBe(true);
    expect(inQuietHours(day, et('14:59'))).toBe(true);
    expect(inQuietHours(day, et('15:00'))).toBe(false);
  });
  it('wrapping window across midnight', () => {
    expect(inQuietHours(night, et('22:29'))).toBe(false);
    expect(inQuietHours(night, et('22:30'))).toBe(true);
    expect(inQuietHours(night, et('07:14', '2026-11-03'))).toBe(true);
    expect(inQuietHours(night, et('07:15', '2026-11-03'))).toBe(false);
  });
  it('local clock gives minutes and the local date', () => {
    expect(localClock(new Date('2026-11-03T03:30:00Z'), 'America/New_York')).toEqual({ minutes: 22 * 60 + 30, date: '2026-11-02' });
  });
  it('limit counts are exact and deferrals say why', () => {
    const noon = et('12:00');
    expect(decideContact(day, noon, 2, 'routine')).toEqual({ action: 'send' });
    expect(decideContact(day, noon, 3, 'routine')).toEqual({ action: 'defer', until: 'tomorrow', reason: 'daily limit of 3 reached' });
    expect(decideContact(day, et('13:30'), 0, 'time-sensitive')).toEqual({ action: 'defer', until: '15:00', reason: 'quiet hours' });
  });
});
