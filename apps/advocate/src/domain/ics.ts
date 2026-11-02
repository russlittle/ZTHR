import type { Deadline } from './types.js';

/** Learning-platform calendar feeds (iCalendar). Only the fields the Advocate needs. */
export function parseIcs(ics: string, course?: string): Omit<Deadline, 'id' | 'studentId'>[] {
  const out: Omit<Deadline, 'id' | 'studentId'>[] = [];
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const get = (k: string) => block.match(new RegExp(`^${k}(?:;[^:]*)?:(.*)$`, 'm'))?.[1]?.trim();
    const summary = get('SUMMARY');
    const start = get('DTSTART');
    if (!summary || !start) continue;
    const d = start.replace(/Z$/, '');
    const due = d.length >= 13 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}` : `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const kind: Deadline['kind'] = /\b(exam|quiz|test|midterm|final)\b/i.test(summary) ? 'exam' : 'assignment';
    out.push({ title: summary, due, course, kind, source: { type: 'calendar-feed', ref: get('UID') }, confirmed: true, effortHours: kind === 'exam' ? 6 : 3 });
  }
  return out;
}
