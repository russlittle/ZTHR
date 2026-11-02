import { describe, expect, it } from 'vitest';
import { CalendarFeedTwin, SmsTwin, checkCalibration } from '@zthr/twins';

describe('twins', () => {
  it('honors carrier opt-out keywords like the real providers', async () => {
    const sms = new SmsTwin();
    expect(sms.inbound('+15550001', 'STOP')).toBe('stop');
    expect((await sms.send('+15550001', '+15559999', 'hi')).status).toBe('refused');
    sms.inbound('+15550001', 'START');
    expect((await sms.send('+15550001', '+15559999', 'hi')).status).toBe('queued');
  });
  it('serves a calendar feed', () => {
    const ics = new CalendarFeedTwin([{ uid: '1', summary: 'Essay 1 due', start: '20261105T235900' }]).ics();
    expect(ics).toContain('SUMMARY:Essay 1 due');
  });
  it('reports drift when a twin disagrees with its recorded probes', async () => {
    const twin = { service: 's', calibratedAt: '2026-11-02', probes: [{ name: 'p', request: 1, recorded: 2 }], handle: async (n: number) => n + 2 };
    expect((await checkCalibration(twin)).drifted).toEqual(['p']);
  });
});
