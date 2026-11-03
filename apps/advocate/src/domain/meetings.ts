import type { Deadline } from './types.js';
import { daysBetween, shortDate, time12, sentence } from './dates.js';

/**
 * Meeting preparation (PRD DAY-4): who will be there, what is due, where the
 * work stands, what remains and why it matters.
 */
export interface Meeting {
  id: string;
  title: string;
  date: string;
  start: string;
  attendees: string[];
  course?: string;
  purpose?: string;
}

export function prepText(m: Meeting, deadlines: Deadline[], today: string): string {
  const related = deadlines.filter((d) => (m.course ? d.course === m.course : true) && daysBetween(today, d.due) >= -1 && daysBetween(m.date, d.due) <= 14);
  const done = related.filter((d) => d.done);
  const open = related.filter((d) => !d.done);
  const lines = [sentence(`${m.title}, ${shortDate(m.date)} at ${time12(m.start)}`)];
  if (m.attendees.length) lines.push(`Who: ${m.attendees.join(', ')}.`);
  if (related.length) lines.push(`Due around then: ${related.map((d) => `${d.title} (${shortDate(d.due)})`).join('; ')}.`);
  lines.push(done.length ? `Done: ${done.map((d) => d.title).join(', ')}.` : 'Nothing marked done for this yet.');
  if (open.length) lines.push(`Still to do: ${open.map((d) => d.title).join(', ')}.`);
  if (m.purpose) lines.push(`Why it matters: ${m.purpose}.`);
  return lines.join('\n');
}
