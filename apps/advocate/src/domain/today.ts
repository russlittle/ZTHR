import type { ClassMeeting, Deadline, Depth, Shift, Student } from './types.js';
import { daysBetween, friendly, time12, weekday } from './dates.js';
import { leadDays } from './planner.js';

/** Today in one look (PRD DAY-1), rendered at the student's chosen depth. */
export interface TodayView {
  date: string;
  classes: ClassMeeting[];
  shifts: Shift[];
  dueSoon: Deadline[];
  oneThing?: { title: string; why: string; deadlineId?: string };
}

export function buildToday(today: string, classes: ClassMeeting[], shifts: Shift[], deadlines: Deadline[]): TodayView {
  const todays = classes.filter((c) => c.days.includes(weekday(today))).sort((a, b) => a.start.localeCompare(b.start));
  const todayShifts = shifts.filter((s) => s.date === today);
  const open = deadlines.filter((d) => !d.done && daysBetween(today, d.due) >= 0).sort((a, b) => a.due.localeCompare(b.due));
  const dueSoon = open.filter((d) => daysBetween(today, d.due) <= 7);
  const pressing = open.find((d) => daysBetween(today, d.due) <= leadDays(d) + 2);
  return {
    date: today,
    classes: todays,
    shifts: todayShifts,
    dueSoon,
    oneThing: pressing
      ? { title: `Work on ${pressing.title}${pressing.course ? ` (${pressing.course})` : ''}`, why: `Due ${friendly(pressing.due)}`, deadlineId: pressing.id }
      : undefined,
  };
}

/** Ends a sentence once, even when it already ends in a time like 11:00 p.m. */
const sentence = (t: string): string => (t.endsWith('.') ? t : `${t}.`);

export function renderToday(v: TodayView, s: Student, depth: Depth = s.dial.depth): string {
  const name = s.chosenName;
  const cls = v.classes.map((c) => `${c.course} at ${time12(c.start)}${c.building ? `, ${c.building}${c.room ? ` room ${c.room}` : ''}` : ''}`);
  const sh = v.shifts.map((x) => `work ${time12(x.start)} to ${time12(x.end)}`);
  const due = v.dueSoon.map((d) => `${d.title}${d.course ? ` (${d.course})` : ''} due ${friendly(d.due)}`);
  if (depth === 'brief') {
    const parts = [cls.length ? cls.join('; ') : 'No classes', sh.length ? sh.join('; ') : '', v.oneThing ? `Focus: ${v.oneThing.title}` : ''].filter(Boolean);
    return parts.map(sentence).join(' ');
  }
  const lines = [`Good morning, ${name}. Here's ${friendly(v.date)}.`];
  lines.push(cls.length ? sentence(`Classes: ${cls.join('; ')}`) : 'No classes today.');
  if (sh.length) lines.push(sentence(`Work: ${sh.join('; ')}`));
  if (due.length) lines.push(sentence(`Coming up: ${due.join('; ')}`));
  if (v.oneThing) lines.push(`If you do one thing today: ${sentence(v.oneThing.title)} ${sentence(v.oneThing.why)}`);
  if (depth === 'walk-me-through' && v.oneThing) lines.push('Reply PLAN and I will break it into small steps with times.');
  return lines.join('\n');
}
