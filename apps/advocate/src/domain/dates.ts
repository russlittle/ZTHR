/** Local-date helpers. Dates are 'YYYY-MM-DD' strings in the student's zone. */
export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function addDays(date: string, n: number): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}

export function weekday(date: string): 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' {
  return (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const)[new Date(`${date.slice(0, 10)}T12:00:00Z`).getUTCDay()]!;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function friendly(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function shortDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function time12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hh = ((h ?? 0) + 11) % 12 + 1;
  return `${hh}:${pad(m ?? 0)} ${(h ?? 0) < 12 ? 'a.m.' : 'p.m.'}`;
}

/** "today", "tomorrow", a weekday name within the week, or a short date beyond it. */
export function relDay(today: string, date: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n > 1 && n < 7) return new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return shortDate(date);
}

/** End a sentence with one period, even when it ends in an abbreviation like "p.m." */
export const sentence = (t: string): string => (/[.!?]$/.test(t) ? t : `${t}.`);
