import { COLLEGES } from './colleges.js';
import type { NeedCategory, Student } from './types.js';
import type { Resource } from '../catalog/types.js';
import { isFresh } from '../catalog/types.js';
import { type EligibilityResult, heap, lifeline, sinclairEmergencyGrant, snap } from '../eligibility/engine.js';

/**
 * The navigator (PRD NAV-3, NAV-6). Finds resources that serve this student,
 * are fresh, and that the eligibility engine does not rule out; then does the
 * legwork: steps, documents still missing, and what can be pre-filled.
 */
export interface PlanOption {
  resource: Resource;
  eligibility?: EligibilityResult;
  why: string;
  steps: string[];
  missingDocuments: string[];
  prefilled: Record<string, string | number>;
  openNow?: boolean;
}

/** Each college's county, from control/colleges. */
export const COLLEGE_COUNTY: Record<string, string> = Object.fromEntries(COLLEGES.map((c) => [c.college, c.county]));

const RULES: Record<string, (s: Student, on: string) => EligibilityResult> = {
  snap,
  lifeline,
  'ohio-heap': heap,
  'sinclair-emergency-grant': (s) => sinclairEmergencyGrant(s),
};

export function serves(r: Resource, s: Student): 'college' | 'county' | 'national' | undefined {
  if (r.serves.colleges?.includes(s.enrollment.college)) return 'college';
  if (r.serves.colleges && !r.serves.counties && !r.serves.national) return undefined;
  const county = s.county ?? COLLEGE_COUNTY[s.enrollment.college];
  if (county && r.serves.counties?.includes(county)) return 'county';
  if (r.serves.national) return 'national';
  return undefined;
}

function profileValue(s: Student, field: string): string | number | undefined {
  switch (field) {
    case 'chosenName':
      return s.chosenName;
    case 'phone':
      return s.phone;
    case 'zip':
      return s.zip;
    case 'college':
      return s.enrollment.college;
    case 'creditHours':
      return s.enrollment.creditHours;
    case 'householdSize':
      return s.household.size;
    case 'monthlyGrossIncome':
      return s.household.monthlyGrossIncome;
    case 'weeklyWorkHours':
      return s.enrollment.weeklyWorkHours;
    default:
      return undefined;
  }
}

export interface FindOptions {
  catalog: Resource[];
  today: string;
  vaultDocuments: string[];
}

export function findHelp(s: Student, need: NeedCategory, o: FindOptions): { options: PlanOption[]; unmet: boolean } {
  const rank = { college: 0, county: 1, national: 2 } as const;
  const options: PlanOption[] = [];
  for (const r of o.catalog) {
    if (!r.categories.includes(need)) continue;
    const scope = serves(r, s);
    if (!scope) continue;
    if (!isFresh(r, o.today)) continue; // stale is unknown, never offered as available
    const elig = r.eligibility.rule ? RULES[r.eligibility.rule]?.(s, o.today) : undefined;
    if (elig?.status === 'unlikely') continue;
    const prefilled: Record<string, string | number> = {};
    for (const f of r.prefill) {
      const v = profileValue(s, f);
      if (v !== undefined) prefilled[f] = v;
    }
    const missingDocuments = r.documents.filter((d) => !o.vaultDocuments.some((v) => d.toLowerCase().includes(v.toLowerCase())));
    options.push({
      resource: r,
      eligibility: elig,
      why: scope === 'college' ? `For ${s.enrollment.college} students` : scope === 'county' ? 'Serves where you live' : 'Available anywhere in the US',
      steps: r.howToApply,
      missingDocuments,
      prefilled,
    });
  }
  options.sort((a, b) => rank[serves(a.resource, s)!] - rank[serves(b.resource, s)!] || (a.eligibility?.status === 'likely' ? -1 : 0) - (b.eligibility?.status === 'likely' ? -1 : 0));
  return { options, unmet: options.length === 0 };
}

/** Steps left to the student for one option: the measure the legwork ratchet holds down. */
export const stepsLeft = (p: PlanOption): number => p.steps.length + p.missingDocuments.length;
