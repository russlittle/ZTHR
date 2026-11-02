import type { Student } from '../domain/types.js';
import { FPL_2026, LIFELINE_2026, OHIO_HEAP_2026_27, SNAP_FY2027, fplAnnual, inPeriod } from './params.js';

/**
 * The eligibility engine. Deterministic rules as code; no model decides who
 * qualifies (PRD NAV-2). Each result cites its rule and source, and says what
 * it still needs when it cannot decide.
 */
export type EligibilityStatus = 'likely' | 'unlikely' | 'needs-info' | 'unconfirmed';

export interface EligibilityResult {
  program: string;
  title: string;
  status: EligibilityStatus;
  reasons: string[];
  needs: string[];
  estimatedMonthlyValue?: number;
  valueIsEstimate?: boolean;
  /** Eligibility that depends on citizenship or immigration status: shown, never asked (PRD NAV-7). */
  statusRuleNote?: string;
  source: string;
  howToApply: string;
}

const at = <T>(arr: T[], size: number, extra: number, toNum: (t: T) => number): number => {
  const i = Math.min(size, arr.length) - 1;
  const base = toNum(arr[i]!);
  return size > arr.length ? base + extra * (size - arr.length) : base;
};

const STATUS_NOTE =
  'Some programs have citizenship or immigration rules. We never ask about that. The agency explains its rules, and you and your family decide whether to apply.';

/** SNAP, including the rule that most students enrolled half-time or more need an exemption. */
export function snap(s: Student, on: string): EligibilityResult {
  const base = {
    program: 'snap',
    title: 'SNAP food benefits',
    source: 'https://www.fna.usda.gov/snap/students',
    howToApply: 'Apply online at benefits.ohio.gov, or with your county Job and Family Services office.',
    statusRuleNote: STATUS_NOTE,
  };
  if (!inPeriod(SNAP_FY2027, on)) return { ...base, status: 'unconfirmed', reasons: ['SNAP income limits for this date have not been verified yet.'], needs: [] };

  const reasons: string[] = [];
  const needs: string[] = [];
  const credits = s.enrollment.creditHours;
  const halfTimeOrMore = credits === undefined ? undefined : credits >= 6;
  if (s.receives?.snap) return { ...base, status: 'likely', reasons: ['You already receive SNAP.'], needs: [] };

  // Student rule (7 CFR 273.5), as listed by USDA.
  let studentOk: boolean | undefined;
  if (halfTimeOrMore === false) {
    studentOk = true;
    reasons.push('Under half-time, the student rule does not apply.');
  } else {
    const exemptions: string[] = [];
    if (s.age !== undefined && (s.age < 18 || s.age >= 50)) exemptions.push('your age');
    if ((s.enrollment.weeklyWorkHours ?? 0) >= 20) exemptions.push('you work 20 or more hours a week');
    if (s.enrollment.workStudy) exemptions.push('you have work-study');
    if ((s.household.childrenUnder6 ?? 0) > 0) exemptions.push('you care for a child under 6');
    if (s.household.singleParent && (s.household.childrenUnder12 ?? 0) > 0 && (credits ?? 0) >= 12) exemptions.push('you are a single parent in school full-time with a child under 12');
    if (s.receives?.tanf) exemptions.push('you receive TANF');
    if (exemptions.length > 0) {
      studentOk = true;
      reasons.push(`You meet a student exemption: ${exemptions.join('; ')}.`);
    } else if (s.enrollment.weeklyWorkHours === undefined || s.enrollment.workStudy === undefined) {
      needs.push('How many hours a week you work, and whether you have work-study');
    } else {
      studentOk = false;
      reasons.push('Students enrolled half-time or more usually need an exemption, such as working 20 hours a week, work-study, or caring for a young child.');
    }
    if (credits === undefined) needs.push('How many credit hours you are taking');
  }

  const size = Math.max(1, s.household.size);
  const gross = s.household.monthlyGrossIncome;
  let incomeOk: boolean | undefined;
  let estimate: number | undefined;
  if (gross === undefined) needs.push('Your household income each month');
  else {
    const p = SNAP_FY2027.value;
    const grossLimit = at(p.gross130, size, p.grossExtra, (x) => x);
    incomeOk = gross <= grossLimit;
    reasons.push(incomeOk ? `Household income is under the limit of $${grossLimit} a month.` : `Household income is over the limit of $${grossLimit} a month.`);
    if (incomeOk) {
      const earned = s.household.monthlyEarnedIncome ?? gross;
      const stdDed = p.standardDeduction[Math.min(size, 6) - 1]!;
      const net = Math.max(0, gross - 0.2 * earned - stdDed);
      // Households larger than the published table get no estimate rather than a guessed one.
      const max = size <= p.maxAllotment.length ? p.maxAllotment[size - 1]! : undefined;
      estimate = max === undefined ? undefined : Math.max(0, Math.round(max - 0.3 * net));
    }
  }

  if (studentOk === false || incomeOk === false) return { ...base, status: 'unlikely', reasons, needs };
  if (studentOk === undefined || incomeOk === undefined) return { ...base, status: 'needs-info', reasons, needs };
  return { ...base, status: 'likely', reasons, needs, estimatedMonthlyValue: estimate, valueIsEstimate: true };
}

export function lifeline(s: Student, on: string): EligibilityResult {
  const base = {
    program: 'lifeline',
    title: 'Lifeline phone or internet discount',
    source: LIFELINE_2026.source,
    howToApply: 'Apply through the National Verifier at lifelinesupport.org, or through a participating phone company.',
  };
  if (!inPeriod(LIFELINE_2026, on)) return { ...base, status: 'unconfirmed', reasons: ['Lifeline limits for this date have not been verified yet.'], needs: [] };
  const p = LIFELINE_2026.value;
  const viaProgram = (['snap', 'medicaid', 'ssi'] as const).filter((k) => s.receives?.[k]);
  if (viaProgram.length > 0) {
    return { ...base, status: 'likely', reasons: [`You receive ${viaProgram.join(', ').toUpperCase()}, which qualifies.`], needs: [], estimatedMonthlyValue: p.monthlyDiscount };
  }
  const gross = s.household.monthlyGrossIncome;
  if (gross === undefined) return { ...base, status: 'needs-info', reasons: [], needs: ['Your household income each month'] };
  const limit = p.base + p.perAdditional * Math.max(0, s.household.size - 1);
  if (gross * 12 <= limit) return { ...base, status: 'likely', reasons: [`Household income is under $${limit.toLocaleString('en-US')} a year.`], needs: [], estimatedMonthlyValue: p.monthlyDiscount };
  return { ...base, status: 'unlikely', reasons: [`Household income is over $${limit.toLocaleString('en-US')} a year.`], needs: [] };
}

export function heap(s: Student, on: string): EligibilityResult {
  const base = {
    program: 'ohio-heap',
    title: 'Ohio HEAP heating help',
    source: OHIO_HEAP_2026_27.source,
    howToApply: 'Apply at energyhelp.ohio.gov, or make an appointment with Miami Valley Community Action Partnership.',
    statusRuleNote: STATUS_NOTE,
  };
  if (!inPeriod(OHIO_HEAP_2026_27, on)) return { ...base, status: 'unconfirmed', reasons: ['HEAP limits for this season have not been verified yet.'], needs: [] };
  const gross = s.household.monthlyGrossIncome;
  if (gross === undefined) return { ...base, status: 'needs-info', reasons: [], needs: ['Your household income each month'] };
  const p = OHIO_HEAP_2026_27.value;
  const limit = p.annual[Math.min(s.household.size, p.annual.length) - 1]!;
  return gross * 12 <= limit
    ? { ...base, status: 'likely', reasons: [`Household income is under $${limit.toLocaleString('en-US')} a year (175% of poverty).`], needs: [] }
    : { ...base, status: 'unlikely', reasons: [`Household income is over $${limit.toLocaleString('en-US')} a year.`], needs: [] };
}

/** Sinclair's Student Emergency Grant Fund, per its published criteria. */
export function sinclairEmergencyGrant(s: Student): EligibilityResult {
  const base = {
    program: 'sinclair-emergency-grant',
    title: 'Sinclair Student Emergency Grant',
    source: 'https://sinclair.edu/emergencygrant',
    howToApply: 'Apply through the link on sinclair.edu/emergencygrant with documentation of the emergency. It can be received once while at Sinclair.',
  };
  if (s.enrollment.college !== 'sinclair') return { ...base, status: 'unlikely', reasons: ['This grant is for Sinclair students.'], needs: [] };
  const needs: string[] = [];
  if (s.enrollment.creditHours === undefined) needs.push('How many credit hours you are taking');
  if (s.enrollment.degreeSeeking === undefined) needs.push('Whether you are in a degree or certificate program');
  if (needs.length > 0) return { ...base, status: 'needs-info', reasons: [], needs };
  if ((s.enrollment.creditHours ?? 0) < 6) return { ...base, status: 'unlikely', reasons: ['It requires at least 6 credit hours this semester.'], needs: [] };
  if (!s.enrollment.degreeSeeking) return { ...base, status: 'unlikely', reasons: ['It requires being in a degree or certificate program.'], needs: [] };
  return { ...base, status: 'likely', reasons: ['You meet the enrollment requirements; the college also considers GPA, aid status and past awards.'], needs: [] };
}

export function screenAll(s: Student, on: string): EligibilityResult[] {
  return [snap(s, on), lifeline(s, on), heap(s, on), sinclairEmergencyGrant(s)];
}

export { fplAnnual, FPL_2026 };
