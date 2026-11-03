import { safeRate, tooSmall } from '@zthr/privacy';
import type { Advocate } from '../agents/advocate.js';
import type { Deadline } from './types.js';

/**
 * Outcome measures (PRD Phase 4). What the Advocate changed for students, counted across everyone and never shown
 * for a group smaller than five, so no number can point at one person. Each measure says what it counts, how, and
 * what it cannot tell you. Persistence and credits need the college's own records; until a college shares them,
 * those two are "not measured", never estimated.
 */
export { MIN_CELL } from '@zthr/privacy';

export interface Measure {
  id: string;
  label: string;
  /** What is counted, in a sentence. */
  how: string;
  numerator?: number;
  denominator?: number;
  /** Shown as a rate when there is a denominator, a count when not. */
  value: number | 'suppressed' | 'not measured';
  limits: string;
}


export function outcomes(a: Advocate, today: string): { students: number; measures: Measure[] } {
  const ids = a.studentIds();
  const students = ids.length;
  const ev = (kind: string) => a.evidence.events(kind);
  const m = (id: string, label: string, how: string, n: number, d: number | undefined, limits: string): Measure => ({
    id,
    label,
    how,
    numerator: n,
    ...(d !== undefined ? { denominator: d } : {}),
    value: tooSmall(d ?? students) ? 'suppressed' : d !== undefined ? safeRate(n, d) : n,
    limits,
  });

  const past = ids.flatMap((s) => a.deadlines(s)).filter((d: Deadline) => d.confirmed && d.due.slice(0, 10) < today);
  const doneOnTime = past.filter((d) => d.done).length;
  const searches = ev('find_help');
  const found = searches.filter((e) => Number(e.data.options) > 0).length;
  const runs = ids.flatMap((s) => a.store.list<{ status: string }>('playbook_runs', s));
  const disp = ids.flatMap((s) => a.operator.dispatches(s));
  const bookings = disp.filter((d) => d.kind === 'room-booking');
  const intros = disp.filter((d) => d.kind === 'mentor-request');
  const outbound = ev('outbound');
  const safety = ev('safety_route').length;

  return {
    students,
    measures: [
      m('deadlines-done', 'Past dates marked done', 'Confirmed dates now past, and how many the student marked done.', doneOnTime, past.length, 'Done is what the student told us, not a grade or a submission record.'),
      m('help-found', 'Help searches that found a fit', 'Searches for help that returned a verified, fresh resource the student qualifies for.', found, searches.length, 'Finding a fit is not the same as getting help; follow-through needs the student to tell us.'),
      m('playbooks-finished', 'Playbooks finished', 'Multi-week processes (FAFSA, SNAP, GI Bill and others) carried to their last step.', runs.filter((r) => r.status === 'done').length, runs.length, 'A finished playbook means every step was done here; the agency decides the outcome.'),
      m('drafts-sent', 'Drafts the student chose to send', 'Messages the Advocate drafted that the student approved and sent.', outbound.filter((e) => e.data.sent === true).length, undefined, 'A count, not a rate: a draft not sent is often the right choice.'),
      m('rooms-confirmed', 'Room bookings confirmed', 'Study room bookings confirmed by the room system after the student asked.', bookings.filter((d) => d.status === 'confirmed').length, bookings.length, 'Only bookings made through the Advocate.'),
      m('mentor-meetings', 'Introductions a mentor said yes to', 'Introductions the student sent that a mentor accepted with a meeting time.', intros.filter((d) => d.status === 'confirmed').length, intros.length, 'Whether the meeting happened is not recorded.'),
      m('safety-routed', 'Times someone was routed to crisis help', 'Messages that went straight to 988 or 911 information.', safety, undefined, 'Counted so the routing can be audited; never linked to a person.'),
      { id: 'persistence', label: 'Enrolled the next term', how: 'Needs the college\'s enrollment records for students who opt in, against a comparison group.', value: 'not measured', limits: 'Phase 4 pilot with a college; not estimated from app activity.' },
      { id: 'credits', label: 'Credits earned', how: 'Needs the college\'s records for students who opt in.', value: 'not measured', limits: 'Phase 4 pilot with a college.' },
    ],
  };
}
