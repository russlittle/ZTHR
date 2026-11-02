import type { Bill, OutboundMessage, Paycheck, Student } from './types.js';
import { addDays, daysBetween, friendly } from './dates.js';

/**
 * Bills and pay calendar (PRD MON-1): see a gap before it happens, with ways
 * to cover it. Amounts are what the student entered; no bank connection.
 */
export interface Gap {
  date: string;
  shortBy: number;
  bill: string;
}

export function findGap(balance: number, bills: Bill[], pay: Paycheck | undefined, today: string, horizonDays = 35): Gap | undefined {
  let bal = balance;
  for (let i = 0; i <= horizonDays; i++) {
    const day = addDays(today, i);
    const dom = Number(day.slice(8, 10));
    if (pay) {
      const since = daysBetween(pay.next, day);
      if (since >= 0 && since % pay.everyDays === 0) bal += pay.amount;
    }
    for (const b of bills.filter((x) => x.dueDay === dom)) {
      bal -= b.amount;
      if (bal < 0) return { date: day, shortBy: Math.ceil(-bal), bill: b.name };
    }
  }
  return undefined;
}

export function gapMessage(s: Student, g: Gap, today: string, options: { label: string; action: string }[]): OutboundMessage {
  const days = daysBetween(today, g.date);
  return {
    studentId: s.id,
    author: 'money-coach',
    urgency: days <= 3 ? 'time-sensitive' : 'routine',
    text: `Heads up: ${g.bill} on ${friendly(g.date)} looks about $${g.shortBy} short, based on the amounts you gave me. There are a few ways to cover it. Want to pick one?`,
    nextSteps: options,
    why: `Your balance, paychecks and bills put ${g.bill} on ${g.date} $${g.shortBy} short.`,
  };
}
