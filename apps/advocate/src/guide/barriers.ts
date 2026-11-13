import type { NeedCategory } from '../domain/types.js';

/**
 * A student's barriers (docs/flows/resource-guide.md): what is hard right now, kept until the student says it is
 * resolved. The rules, which property tests hold for every sequence of events:
 *
 *  - only the student resolves a barrier; nothing else closes it;
 *  - opening a barrier that is already open never lowers its urgency;
 *  - "not today" pauses reminders for a day and never closes anything;
 *  - a resolved barrier that comes back is reopened, not duplicated;
 *  - an open barrier the student has gone quiet about is asked about again, gently, after a week.
 */
export type Urgency = 'tonight' | 'soon' | 'someday';
export type BarrierStatus = 'open' | 'in-progress' | 'resolved';
export type OpenedBy = 'check-in' | 'student' | 'advocate';

export interface StudentBarrier {
  need: NeedCategory;
  openedBy: OpenedBy;
  urgency: Urgency;
  status: BarrierStatus;
  openedOn: string;
  resolvedOn?: string;
  /** Last day the Advocate asked whether it is still a problem. */
  lastAskedOn?: string;
  /** "Not today": no reminders before this day. */
  quietUntil?: string;
  /** Every change, for the student's own record. */
  history: { on: string; event: 'opened' | 'raised' | 'started' | 'resolved' | 'reopened' | 'not-today' | 'asked' }[];
}

export interface BarrierBook {
  items: StudentBarrier[];
}

const RANK: Record<Urgency, number> = { tonight: 0, soon: 1, someday: 2 };
const higher = (a: Urgency, b: Urgency): Urgency => (RANK[a] <= RANK[b] ? a : b);
const day = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * day).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / day);

export const empty = (): BarrierBook => ({ items: [] });

function replace(book: BarrierBook, b: StudentBarrier): BarrierBook {
  return { items: [...book.items.filter((x) => x.need !== b.need), b] };
}

export function find(book: BarrierBook, need: NeedCategory): StudentBarrier | undefined {
  return book.items.find((x) => x.need === need);
}

/** Open a barrier, or raise its urgency if it is already open, or reopen it if it was resolved. */
export function open(book: BarrierBook, need: NeedCategory, by: OpenedBy, urgency: Urgency, today: string): BarrierBook {
  const b = find(book, need);
  if (!b) return replace(book, { need, openedBy: by, urgency, status: 'open', openedOn: today, history: [{ on: today, event: 'opened' }] });
  if (b.status === 'resolved') {
    return replace(book, { ...b, openedBy: by, urgency, status: 'open', openedOn: today, resolvedOn: undefined, quietUntil: undefined, history: [...b.history, { on: today, event: 'reopened' }] });
  }
  const u = higher(b.urgency, urgency);
  return u === b.urgency ? book : replace(book, { ...b, urgency: u, history: [...b.history, { on: today, event: 'raised' }] });
}

/** The student started a step toward it. */
export function start(book: BarrierBook, need: NeedCategory, today: string): BarrierBook {
  const b = find(book, need);
  if (!b || b.status !== 'open') return book;
  return replace(book, { ...b, status: 'in-progress', history: [...b.history, { on: today, event: 'started' }] });
}

/** Only the student calls this: the barrier is resolved. */
export function resolve(book: BarrierBook, need: NeedCategory, today: string): BarrierBook {
  const b = find(book, need);
  if (!b || b.status === 'resolved') return book;
  return replace(book, { ...b, status: 'resolved', resolvedOn: today, quietUntil: undefined, history: [...b.history, { on: today, event: 'resolved' }] });
}

/** "I can't deal with this today": no reminders until tomorrow. Nothing is closed or lost. */
export function notToday(book: BarrierBook, need: NeedCategory, today: string): BarrierBook {
  const b = find(book, need);
  if (!b || b.status === 'resolved') return book;
  return replace(book, { ...b, quietUntil: addDays(today, 1), history: [...b.history, { on: today, event: 'not-today' }] });
}

export function asked(book: BarrierBook, need: NeedCategory, today: string): BarrierBook {
  const b = find(book, need);
  if (!b || b.status === 'resolved') return book;
  return replace(book, { ...b, lastAskedOn: today, history: [...b.history, { on: today, event: 'asked' }] });
}

/** Open barriers, most urgent first, then oldest first. */
export function active(book: BarrierBook): StudentBarrier[] {
  return book.items.filter((b) => b.status !== 'resolved').sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || a.openedOn.localeCompare(b.openedOn));
}

/** Whether reminders about it may be shown today. */
export const remindable = (b: StudentBarrier, today: string): boolean => b.status !== 'resolved' && (!b.quietUntil || b.quietUntil <= today);

/** An open barrier not mentioned for a week gets one gentle question: still a problem? */
export function dueForCheck(book: BarrierBook, today: string, quietDays = 7): StudentBarrier | undefined {
  return active(book).find((b) => remindable(b, today) && daysBetween(b.lastAskedOn ?? b.openedOn, today) >= quietDays);
}
