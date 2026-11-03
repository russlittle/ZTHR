import type { Shift } from './types.js';
import { addDays, weekday } from './dates.js';

/**
 * Read work shifts the way students type them: "Tue 3pm-9pm, Thu 4-10pm, Sat 9:30am-2". Each shift lands on the
 * next date with that weekday, counting today. Nothing is guessed: a part that cannot be read is returned unread.
 */
const DAYS: Record<string, ReturnType<typeof weekday>> = {
  sun: 'Sun', mon: 'Mon', tue: 'Tue', tues: 'Tue', wed: 'Wed', thu: 'Thu', thur: 'Thu', thurs: 'Thu', fri: 'Fri', sat: 'Sat',
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
};

function clock(raw: string, suffix?: string): number | undefined {
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return undefined;
  if (suffix === 'pm' && h < 12) h += 12;
  if (suffix === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

const hhmm = (x: number) => `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;

export function parseShifts(text: string, today: string, employer?: string): { shifts: Shift[]; unread: string[] } {
  const shifts: Shift[] = [];
  const unread: string[] = [];
  for (const part of text.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.toLowerCase().match(/^([a-z]+)\.?\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?$/);
    const day = m ? DAYS[m[1]!] : undefined;
    if (!m || !day) {
      unread.push(part);
      continue;
    }
    const endSuffix = m[5];
    // "4-10pm": the start takes the end's suffix when that keeps the start before the end.
    let startSuffix = m[3];
    if (!startSuffix && endSuffix === 'pm') {
      const asPm = clock(m[2]!, 'pm');
      const end = clock(m[4]!, 'pm');
      startSuffix = asPm !== undefined && end !== undefined && asPm < end ? 'pm' : 'am';
    }
    const start = clock(m[2]!, startSuffix);
    const end = clock(m[4]!, endSuffix ?? (startSuffix === 'pm' ? 'pm' : undefined));
    if (start === undefined || end === undefined) {
      unread.push(part);
      continue;
    }
    let date = today;
    for (let i = 0; i < 7 && weekday(date) !== day; i++) date = addDays(date, 1);
    shifts.push({ date, start: hhmm(start), end: hhmm(end), employer });
  }
  return { shifts, unread };
}
