/**
 * Dated parameters for benefits rules. Every value carries its source and the
 * period it applies to. A rule asked about a date outside every period returns
 * unconfirmed, never a stale answer (PRD P11).
 */
export interface Dated<T> {
  value: T;
  effectiveFrom: string;
  effectiveTo: string;
  source: string;
  verifiedOn: string;
}

/** 2026 HHS poverty guidelines, 48 contiguous states and DC (annual). */
export const FPL_2026: Dated<{ base: number; perAdditional: number }> = {
  value: { base: 15_960, perAdditional: 5_680 },
  effectiveFrom: '2026-01-15',
  effectiveTo: '2027-01-31',
  source: 'https://www.govinfo.gov/content/pkg/FR-2026-01-26/html/2026-01431.htm',
  verifiedOn: '2026-11-02',
};

export const fplAnnual = (size: number, p = FPL_2026.value) => p.base + p.perAdditional * Math.max(0, size - 1);

/** SNAP FY2027 (Oct 1, 2026 - Sep 30, 2027), 48 states and DC. Monthly dollars. */
export const SNAP_FY2027: Dated<{
  gross130: number[];
  grossExtra: number;
  net100: number[];
  netExtra: number;
  maxAllotment: number[];
  standardDeduction: number[]; // by household size 1..6+
}> = {
  value: {
    gross130: [1729, 2345, 2960, 3575, 4191, 4806, 5421, 6037],
    grossExtra: 616,
    net100: [1330, 1804, 2277, 2750, 3224, 3697, 4170, 4644],
    netExtra: 474,
    maxAllotment: [306, 562, 808, 1023, 1217, 1463, 1616, 1841],
    standardDeduction: [217, 217, 217, 229, 268, 308],
  },
  effectiveFrom: '2026-10-01',
  effectiveTo: '2027-09-30',
  source: 'https://www.usda.gov/sites/default/files/guidance-documents/fna.snap-cola2027.pdf',
  verifiedOn: '2026-11-02',
};

/** Ohio HEAP 2026-2027 heating season: 175% of poverty, annual limits by household size. */
export const OHIO_HEAP_2026_27: Dated<{ annual: number[]; applyFrom: string; applyTo: string }> = {
  value: {
    annual: [27_930, 37_870, 47_810, 57_750, 67_690, 77_630, 87_570, 94_881, 96_946, 99_010, 101_069, 103_132],
    applyFrom: '2026-07-01',
    applyTo: '2027-05-31',
  },
  effectiveFrom: '2026-07-01',
  effectiveTo: '2027-05-31',
  source: 'https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap',
  verifiedOn: '2026-11-02',
};

/** Lifeline 2026: 135% of poverty, or participation in a qualifying program. */
export const LIFELINE_2026: Dated<{ base: number; perAdditional: number; monthlyDiscount: number; programs: string[] }> = {
  value: { base: 21_546, perAdditional: 7_668, monthlyDiscount: 9.25, programs: ['snap', 'medicaid', 'ssi', 'federal-public-housing', 'veterans-pension'] },
  effectiveFrom: '2026-01-15',
  effectiveTo: '2027-01-31',
  source: 'https://www.usac.org/lifeline/consumer-eligibility/',
  verifiedOn: '2026-11-02',
};

export function inPeriod<T>(d: Dated<T>, on: string): boolean {
  return d.effectiveFrom <= on && on <= d.effectiveTo;
}
