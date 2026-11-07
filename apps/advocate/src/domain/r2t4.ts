/**
 * Return of Title IV funds (34 CFR 668.22), as the Federal Student Aid Handbook, Volume 5, works it. When a student
 * who received federal aid stops attending every class, the aid is earned in proportion to the share of the payment
 * period completed; past 60% all of it is earned. This module computes the estimate a student can understand
 * before deciding. The aid office makes the official calculation; every figure here is labelled an estimate.
 *
 * The oracle for this module is the Handbook's own case study (Volume 5, Chapter 3, Case 2), checked by a gate.
 */

export interface PaymentPeriod {
  start: string; // YYYY-MM-DD, first day of the term
  end: string; // last scheduled day, including finals
  /** Scheduled breaks of five or more consecutive days, which do not count as days in the period. */
  breaks: { from: string; to: string }[];
}

export interface AidDisbursed {
  pell?: number;
  fseog?: number;
  otherGrants?: number; // other Title IV grants
  subsidized?: number;
  unsubsidized?: number;
  plus?: number;
}

const day = 86_400_000;
const t = (d: string) => Date.parse(`${d}T12:00:00Z`);
const inclusiveDays = (a: string, b: string) => Math.round((t(b) - t(a)) / day) + 1;
/** The Handbook rounds the percentage to one decimal place of a percent (three places as a fraction). */
const pct = (x: number) => Math.round(x * 1000) / 1000;
const cents = (x: number) => Math.round(x * 100) / 100;

function breakDaysUpTo(p: PaymentPeriod, upTo?: string): number {
  return p.breaks
    .filter((b) => inclusiveDays(b.from, b.to) >= 5)
    .reduce((n, b) => {
      const to = upTo && t(upTo) < t(b.to) ? upTo : b.to;
      return t(to) < t(b.from) ? n : n + inclusiveDays(b.from, to);
    }, 0);
}

/** Days in the period and days completed by a last date of attendance, with scheduled breaks left out of both. */
export function completed(p: PaymentPeriod, lastDay: string): { totalDays: number; daysCompleted: number; percent: number } {
  const totalDays = inclusiveDays(p.start, p.end) - breakDaysUpTo(p);
  const raw = t(lastDay) < t(p.start) ? 0 : inclusiveDays(p.start, t(lastDay) > t(p.end) ? p.end : lastDay) - breakDaysUpTo(p, lastDay);
  const daysCompleted = Math.max(0, raw);
  return { totalDays, daysCompleted, percent: pct(daysCompleted / totalDays) };
}

/** The first date on which a student has completed more than 60% of the period, after which all aid is earned. */
export function sixtyPercentDay(p: PaymentPeriod): string {
  for (let d = t(p.start); d <= t(p.end); d += day) {
    const iso = new Date(d).toISOString().slice(0, 10);
    if (completed(p, iso).percent > 0.6) return iso;
  }
  return p.end;
}

export interface R2T4Result {
  totalDays: number;
  daysCompleted: number;
  percentCompleted: number;
  allEarned: boolean;
  aidDisbursed: number;
  grants: number;
  loans: number;
  earned: number;
  unearned: number;
  institutionalCharges: number;
  schoolReturns: number;
  studentInitialDue: number;
  studentLoanRepay: number;
  grantProtection: number;
  studentGrantReturn: number;
  sixtyPercentDay: string;
}

/**
 * The worksheet, steps 1 to 10, for aid already disbursed (post-withdrawal disbursements are left to the aid office).
 * The school returns the lesser of the unearned aid and the unearned share of institutional charges; the student
 * owes the rest: loans repaid on the promissory note's terms, and grants only above the 50% protection and $50.
 */
export function r2t4(p: PaymentPeriod, lastDay: string, aid: AidDisbursed, institutionalCharges: number): R2T4Result {
  const c = completed(p, lastDay);
  const allEarned = c.percent > 0.6;
  const grants = cents((aid.pell ?? 0) + (aid.fseog ?? 0) + (aid.otherGrants ?? 0));
  const loans = cents((aid.subsidized ?? 0) + (aid.unsubsidized ?? 0) + (aid.plus ?? 0));
  const total = cents(grants + loans);
  const earned = allEarned ? total : cents(total * c.percent);
  const unearned = cents(total - earned);
  const unearnedCharges = cents(institutionalCharges * pct(1 - c.percent));
  const schoolReturns = allEarned ? 0 : Math.min(unearned, unearnedCharges);
  const studentInitialDue = cents(unearned - schoolReturns);
  // The school returns loans first (unsubsidized, subsidized, PLUS), then grants; the student's share follows the same order.
  const schoolToLoans = Math.min(schoolReturns, loans);
  const studentLoanRepay = cents(Math.min(studentInitialDue, Math.max(0, loans - schoolToLoans)));
  const studentGrantDue = cents(studentInitialDue - studentLoanRepay);
  const grantProtection = cents(grants * 0.5);
  const over = cents(studentGrantDue - grantProtection);
  const studentGrantReturn = over > 50 ? over : 0;
  return {
    totalDays: c.totalDays,
    daysCompleted: c.daysCompleted,
    percentCompleted: c.percent,
    allEarned,
    aidDisbursed: total,
    grants,
    loans,
    earned,
    unearned,
    institutionalCharges,
    schoolReturns: cents(schoolReturns),
    studentInitialDue,
    studentLoanRepay,
    grantProtection,
    studentGrantReturn,
    sixtyPercentDay: sixtyPercentDay(p),
  };
}

/** Handbook Volume 5, Chapter 3, Case 2: the oracle every build checks against. */
export const HANDBOOK_CASE_2 = {
  source: 'https://fsapartners.ed.gov/knowledge-center/fsa-handbook/2025-2026/vol5/ch3-return-title-iv-r2t4-funds-case-studies-part-1',
  period: { start: '2026-01-08', end: '2026-05-04', breaks: [{ from: '2026-03-09', to: '2026-03-15' }] } as PaymentPeriod,
  lastDay: '2026-01-18',
  aid: { pell: 1400, fseog: 1200 } as AidDisbursed,
  charges: 1000,
  expect: { totalDays: 110, daysCompleted: 11, percentCompleted: 0.1, earned: 260, unearned: 2340, schoolReturns: 900, studentInitialDue: 1440, grantProtection: 1300, studentGrantReturn: 140 },
};
