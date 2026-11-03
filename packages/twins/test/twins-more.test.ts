// Verifies docs/blocks/twins.md
import { describe, expect, it } from 'vitest';
import { CalendarFeedTwin, SmsTwin, checkCalibration } from '@zthr/twins';

describe('sms twin', () => {
  it('queues with sequential ids and records each message', async () => {
    const s = new SmsTwin();
    expect(s.service).toBe('sms');
    expect(s.calibratedAt).toBe('2026-11-02');
    expect(await s.send('+1a', '+1b', 'one')).toEqual({ id: 'SM000001', status: 'queued' });
    expect(await s.send('+1a', '+1b', 'two')).toEqual({ id: 'SM000002', status: 'queued' });
    expect(s.outbox.map((m) => [m.to, m.from, m.body])).toEqual([['+1a', '+1b', 'one'], ['+1a', '+1b', 'two']]);
    expect(Date.parse(s.outbox[0]!.at)).not.toBeNaN();
  });
  it('refuses an empty body', async () => {
    const s = new SmsTwin();
    expect(await s.send('+1a', '+1b', '')).toEqual({ id: '', status: 'refused', reason: 'empty body' });
    expect(s.outbox).toEqual([]);
  });
  it('honors every stop and start keyword, any case and spacing, for that number only', async () => {
    for (const k of ['STOP', 'stopall', ' Unsubscribe ', 'cancel', 'END', 'quit']) {
      const s = new SmsTwin();
      expect(s.inbound('+1a', k)).toBe('stop');
      expect(await s.send('+1a', '+1b', 'x')).toEqual({ id: '', status: 'refused', reason: 'recipient opted out' });
      expect((await s.send('+1c', '+1b', 'x')).status).toBe('queued');
    }
    for (const k of ['start', 'UNSTOP']) {
      const s = new SmsTwin();
      s.inbound('+1a', 'STOP');
      expect(s.inbound('+1a', k)).toBe('start');
      expect((await s.send('+1a', '+1b', 'x')).status).toBe('queued');
    }
    expect(new SmsTwin().inbound('+1a', 'stop please')).toBe('message');
  });
});

describe('calendar feed twin', () => {
  it('writes a complete iCalendar document with CRLF lines and optional fields only when present', () => {
    const t = new CalendarFeedTwin([{ uid: 'a', summary: 'A', start: '20261105T100000', end: '20261105T110000', description: 'D' }, { uid: 'b', summary: 'B', start: '20261106' }]);
    expect(t.service).toBe('lms-calendar-feed');
    expect(t.ics()).toBe(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//twin//lms//EN', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:A', 'DTSTART:20261105T100000', 'DTEND:20261105T110000', 'DESCRIPTION:D', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:b', 'SUMMARY:B', 'DTSTART:20261106', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  });
});

describe('calibration', () => {
  it('counts every probe and names only the drifted ones, with a custom comparison when given', async () => {
    const twin = { service: 's', calibratedAt: 'x', probes: [{ name: 'a', request: 1, recorded: 2 }, { name: 'b', request: 2, recorded: 9 }], handle: async (n: number) => n + 1 };
    expect(await checkCalibration(twin)).toEqual({ service: 's', checked: 2, drifted: ['b'] });
    expect(await checkCalibration(twin, () => true)).toEqual({ service: 's', checked: 2, drifted: [] });
    expect(await checkCalibration({ ...twin, probes: [] })).toEqual({ service: 's', checked: 0, drifted: [] });
  });
});
