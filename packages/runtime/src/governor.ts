/**
 * Contact governor: the student's frequency limits and quiet hours, enforced
 * deterministically. Urgent safety messages are never held.
 */
export interface ContactPrefs {
  maxPerDay: number;
  quietStart: string; // "22:00"
  quietEnd: string; // "08:00"
  timeZone: string; // IANA zone, e.g. "America/New_York"
}

export type Decision = { action: 'send' } | { action: 'defer'; until: string; reason: string };

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Local wall-clock minutes and date in the student's zone. */
export function localClock(at: Date, timeZone: string): { minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

export function inQuietHours(prefs: ContactPrefs, at: Date): boolean {
  const now = localClock(at, prefs.timeZone).minutes;
  const s = minutes(prefs.quietStart);
  const e = minutes(prefs.quietEnd);
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

export function decideContact(
  prefs: ContactPrefs,
  at: Date,
  sentToday: number,
  urgency: 'safety' | 'time-sensitive' | 'routine',
): Decision {
  if (urgency === 'safety') return { action: 'send' };
  if (inQuietHours(prefs, at)) return { action: 'defer', until: prefs.quietEnd, reason: 'quiet hours' };
  if (urgency === 'routine' && sentToday >= prefs.maxPerDay) {
    return { action: 'defer', until: 'tomorrow', reason: `daily limit of ${prefs.maxPerDay} reached` };
  }
  return { action: 'send' };
}
