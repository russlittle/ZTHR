/**
 * Twin what you don't own (Pattern 33). A twin reproduces an external
 * service's behavior as recorded from the real, as-built service. Its
 * calibration date and the probes it was fitted to travel with it, and a
 * re-probe that disagrees fails the twin rather than the user.
 */
export interface Probe<Req, Res> {
  name: string;
  request: Req;
  /** Response recorded from the real service. */
  recorded: Res;
}

export interface Twin<Req, Res> {
  service: string;
  calibratedAt: string;
  probes: Probe<Req, Res>[];
  handle(req: Req): Promise<Res>;
}

export interface DriftReport {
  service: string;
  checked: number;
  drifted: string[];
}

/** Replays the probes against the twin. In production the same probes run against the real service on a schedule. */
export async function checkCalibration<Req, Res>(twin: Twin<Req, Res>, equal: (a: Res, b: Res) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b)): Promise<DriftReport> {
  const drifted: string[] = [];
  for (const p of twin.probes) {
    const got = await twin.handle(p.request);
    if (!equal(got, p.recorded)) drifted.push(p.name);
  }
  return { service: twin.service, checked: twin.probes.length, drifted };
}

/** A text-messaging provider twin: records every message sent and lets tests deliver inbound ones. */
export interface SmsMessage {
  to: string;
  from: string;
  body: string;
  at: string;
}

export class SmsTwin {
  readonly service = 'sms';
  readonly calibratedAt = '2026-11-02';
  readonly outbox: SmsMessage[] = [];
  private readonly optedOut = new Set<string>();

  async send(to: string, from: string, body: string): Promise<{ id: string; status: 'queued' | 'refused'; reason?: string }> {
    if (this.optedOut.has(to)) return { id: '', status: 'refused', reason: 'recipient opted out' };
    if (body.length === 0) return { id: '', status: 'refused', reason: 'empty body' };
    this.outbox.push({ to, from, body, at: new Date().toISOString() });
    return { id: `SM${this.outbox.length.toString().padStart(6, '0')}`, status: 'queued' };
  }

  /** Carrier keywords honored as the real providers do. */
  inbound(from: string, body: string): 'stop' | 'start' | 'message' {
    const k = body.trim().toUpperCase();
    if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(k)) {
      this.optedOut.add(from);
      return 'stop';
    }
    if (['START', 'UNSTOP'].includes(k)) {
      this.optedOut.delete(from);
      return 'start';
    }
    return 'message';
  }
}

/** A calendar-feed twin: serves an iCalendar document the way learning platforms publish course calendars. */
export class CalendarFeedTwin {
  readonly service = 'lms-calendar-feed';
  constructor(private readonly events: { uid: string; summary: string; start: string; end?: string; description?: string }[]) {}

  ics(): string {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//twin//lms//EN'];
    for (const e of this.events) {
      lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `SUMMARY:${e.summary}`, `DTSTART:${e.start}`);
      if (e.end) lines.push(`DTEND:${e.end}`);
      if (e.description) lines.push(`DESCRIPTION:${e.description}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }
}
