import type { ClassMeeting, Deadline, OutboundMessage, Shift, Student } from './types.js';
import { addDays, daysBetween, friendly, relDay, shortDate, time12, weekday } from './dates.js';

/**
 * Anticipate, then solve (PRD P3, DAY-3). A deadline is raised early enough to
 * act on, with a concrete plan; a passed one gets a recovery path, never a scold.
 */
export const leadDays = (d: Pick<Deadline, 'effortHours' | 'kind'>): number => {
  const effort = d.effortHours ?? 3;
  return Math.ceil(effort / 2) + 1;
};

export interface Block {
  date: string;
  start: string;
  end: string;
}

const endSentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Find open two-hour blocks between 9:00 and 21:00 on days before the deadline, around classes and shifts. */
export function openBlocks(from: string, until: string, classes: ClassMeeting[], shifts: Shift[], want = 2): Block[] {
  const out: Block[] = [];
  for (let day = from; daysBetween(day, until) > 0 && out.length < want; day = addDays(day, 1)) {
    const busy: [number, number][] = [
      ...classes.filter((c) => c.days.includes(weekday(day))).map((c) => [toMin(c.start), toMin(c.end)] as [number, number]),
      ...shifts.filter((s) => s.date === day).map((s) => [toMin(s.start), toMin(s.end) <= toMin(s.start) ? 24 * 60 : toMin(s.end)] as [number, number]),
    ].sort((a, b) => a[0] - b[0]);
    for (let start = 9 * 60; start + 120 <= 21 * 60; start += 30) {
      const end = start + 120;
      if (busy.every(([s, e]) => end <= s || start >= e + 15)) {
        out.push({ date: day, start: toHHMM(start), end: toHHMM(end) });
        break;
      }
    }
  }
  return out;
}

export function upcomingMessages(
  student: Student,
  today: string,
  deadlines: Deadline[],
  classes: ClassMeeting[],
  shifts: Shift[],
): OutboundMessage[] {
  const out: OutboundMessage[] = [];
  for (const d of deadlines) {
    if (d.done) continue;
    const days = daysBetween(today, d.due);
    const label = d.course ? `${d.title} for ${d.course}` : d.title;
    if (days < 0 && days >= -14 && d.kind !== 'reading') {
      out.push({
        studentId: student.id,
        author: 'coursework-planner',
        urgency: 'time-sensitive',
        text: `The due date for ${label} passed on ${shortDate(d.due)}. Lots of instructors will take work late or set up a plan if you ask soon. Want me to draft a short note to your instructor?`,
        nextSteps: [
          { label: 'Draft a note to my instructor', action: `draft-instructor-note:${d.id}` },
          { label: 'I already turned it in', action: `mark-done:${d.id}` },
        ],
        why: `Seen in your ${d.source.type === 'syllabus' ? 'syllabus' : d.source.type}: "${d.source.line ?? d.title}"`,
      });
      continue;
    }
    if (days < 0 || days > leadDays(d) + 2) continue; // passed readings need no recovery note
    const blocks = openBlocks(today, d.due, classes, shifts, Math.min(3, Math.ceil((d.effortHours ?? 3) / 2)));
    const b0 = blocks[0];
    const workBefore = shifts.filter((s) => daysBetween(today, s.date) >= 0 && daysBetween(s.date, d.due) > 0).sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start));
    const blockNote = b0
      ? ` You have two open hours ${relDay(today, b0.date)}, ${time12(b0.start)} to ${time12(b0.end)}.`
      : " Your schedule is tight, so let's find a short window together.";
    const shiftNote = workBefore.length > 0 ? ` You also work ${relDay(today, workBefore[0]!.date)} at ${time12(workBefore[0]!.start)}` : '';
    out.push({
      studentId: student.id,
      author: 'coursework-planner',
      urgency: days <= 1 ? 'time-sensitive' : 'routine',
      text: `${label} is due ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : friendly(d.due)}.${blockNote}${shiftNote ? endSentence(shiftNote) : ''}${b0 ? ' Want me to hold that time for it?' : ''}`,
      nextSteps: [
        ...(blocks.length > 0 ? [{ label: `Hold ${relDay(today, blocks[0]!.date)} ${time12(blocks[0]!.start)}`, action: `hold-block:${d.id}:${blocks[0]!.date}:${blocks[0]!.start}` }] : []),
        { label: 'Find me help with it', action: `find-help:${d.id}` },
        { label: 'Already done', action: `mark-done:${d.id}` },
      ],
      why: `Due ${d.due}; about ${d.effortHours ?? 3} hours of work, so I raised it ${leadDays(d) + 2} days out.`,
    });
  }
  return out;
}

/** Break a deadline into short, concrete steps placed in open time (for walk-me-through students). */
export function planSteps(d: Deadline, today: string, classes: ClassMeeting[], shifts: Shift[]): { step: string; date: string; start: string; minutes: number }[] {
  const effortMin = Math.round((d.effortHours ?? 3) * 60);
  const chunk = 45;
  const count = Math.max(2, Math.ceil(effortMin / chunk));
  const verbs = d.kind === 'exam'
    ? ['Gather your notes and the study guide', 'Make a list of topics you feel unsure about', 'Practice problems on the first topic', 'Practice the next topic', 'Quiz yourself on everything', 'Review the hardest parts once more']
    : d.kind === 'reading'
      ? ['Skim the headings', 'Read the first half', 'Read the second half', 'Write three sentences about what it said']
      : ['Reread the assignment and list what it asks for', 'Gather sources or notes', 'Make a quick outline', 'Write the first part', 'Write the rest', 'Read it out loud and fix what sounds off', 'Turn it in'];
  const blocks = openBlocks(today, d.due, classes, shifts, 7);
  const out: { step: string; date: string; start: string; minutes: number }[] = [];
  for (let i = 0; i < Math.min(count, verbs.length); i++) {
    const b = blocks[Math.min(i, Math.max(0, blocks.length - 1))];
    out.push({ step: verbs[i]!, date: b?.date ?? today, start: b?.start ?? '18:00', minutes: chunk });
  }
  return out;
}
