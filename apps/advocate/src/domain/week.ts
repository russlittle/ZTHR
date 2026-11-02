import type { ClassMeeting, Deadline, Shift } from './types.js';
import { addDays, shortDate, time12, weekday } from './dates.js';

/**
 * The week solver (PRD HH-1): shifts, classes, child care hours and commute
 * laid out together, with pickups, study blocks and sleep placed where they
 * fit. Deterministic; anything that cannot fit is reported with a way out.
 */
export interface ChildCare {
  name: string;
  open: string; // "06:30"
  close: string; // "18:00"
  days: ('Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun')[];
}

export interface WeekInput {
  start: string;
  classes: ClassMeeting[];
  shifts: Shift[];
  childCare?: ChildCare;
  commuteMin: number;
  sleepHours: number;
  deadlines: Deadline[];
}

export interface Block {
  date: string;
  start: string;
  end: string;
  kind: 'class' | 'shift' | 'drop-off' | 'pickup' | 'study' | 'sleep';
  label: string;
}

export interface Problem {
  date: string;
  text: string;
  fix: string;
}

const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (x: number) => `${String(Math.floor(((x % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((x % 60) + 60) % 60).padStart(2, '0')}`;

export function solveWeek(w: WeekInput): { blocks: Block[]; problems: Problem[]; studyHours: number } {
  const blocks: Block[] = [];
  const problems: Problem[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(w.start, i);
    const wd = weekday(date);
    const busy: [number, number, Block][] = [];
    for (const c of w.classes.filter((c) => c.days.includes(wd))) busy.push([m(c.start) - w.commuteMin, m(c.end) + w.commuteMin, { date, start: c.start, end: c.end, kind: 'class', label: c.course }]);
    for (const s of w.shifts.filter((s) => s.date === date)) {
      const end = m(s.end) <= m(s.start) ? m(s.end) + 1440 : m(s.end);
      busy.push([m(s.start) - w.commuteMin, end + w.commuteMin, { date, start: s.start, end: s.end, kind: 'shift', label: s.employer ?? 'Work' }]);
    }
    busy.sort((a, b) => a[0] - b[0]);
    blocks.push(...busy.map((b) => b[2]));

    const cc = w.childCare && w.childCare.days.includes(wd) ? w.childCare : undefined;
    if (busy.length && cc) {
      const first = busy[0]!;
      const last = busy.reduce((a, b) => (b[1] > a[1] ? b : a));
      const dropBy = first[0];
      const pickAt = last[1];
      if (dropBy < m(cc.open)) problems.push({ date, text: `${cc.name} opens at ${time12(cc.open)}, after you need to leave for ${first[2].label}.`, fix: 'Ask about early drop-off, or a family, friend or neighbor care option for that morning.' });
      else blocks.push({ date, start: hhmm(dropBy - 15), end: hhmm(dropBy), kind: 'drop-off', label: `Drop-off at ${cc.name}` });
      if (pickAt > m(cc.close)) problems.push({ date, text: `${cc.name} closes at ${time12(cc.close)}, before you're back from ${last[2].label}.`, fix: 'Ask about late pickup, a shift swap, or a backup pickup person. I can draft the request.' });
      else blocks.push({ date, start: hhmm(pickAt), end: hhmm(pickAt + 15), kind: 'pickup', label: `Pickup at ${cc.name}` });
    }
    // Sleep: the longest gap overnight before the next day's first commitment.
    const lastEnd = busy.length ? Math.max(...busy.map((b) => b[1])) : 22 * 60;
    const sleepStart = Math.max(lastEnd + 30, 22 * 60);
    const sleepEnd = sleepStart + w.sleepHours * 60;
    blocks.push({ date, start: hhmm(sleepStart), end: hhmm(sleepEnd), kind: 'sleep', label: 'Sleep' });
    if (lastEnd + 30 > 26 * 60) problems.push({ date, text: `After work ends late on ${shortDate(date)}, there is not enough time for ${w.sleepHours} hours of sleep.`, fix: 'Keep the next morning light; I will not schedule study before 10 a.m.' });
    // Study: one 90-minute block in the first open window between 9:00 and 21:00 that also clears pickups.
    const taken = [...busy.map((b) => [b[0], b[1]] as [number, number]), ...blocks.filter((b) => b.date === date && (b.kind === 'pickup' || b.kind === 'drop-off')).map((b) => [m(b.start), m(b.end)] as [number, number])];
    for (let t = 9 * 60; t + 90 <= 21 * 60; t += 15) {
      if (taken.every(([s, e]) => t + 90 <= s || t >= e)) {
        const due = w.deadlines.find((d) => !d.done && d.due.slice(0, 10) > date);
        blocks.push({ date, start: hhmm(t), end: hhmm(t + 90), kind: 'study', label: due ? `Study: ${due.title}` : 'Study' });
        break;
      }
    }
  }
  const studyHours = blocks.filter((b) => b.kind === 'study').length * 1.5;
  return { blocks: blocks.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)), problems, studyHours };
}
