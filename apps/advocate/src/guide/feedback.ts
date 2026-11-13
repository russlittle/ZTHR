/**
 * Whether a resource helped: one question after a student uses it. Answers become the entry's record. The record is
 * shown only once enough students have answered that no one answer can be picked out (MIN_SHOWN), and only as counts.
 */
export type Outcome = 'helped' | 'did-not-help' | 'could-not-reach';
export const OUTCOMES: Outcome[] = ['helped', 'did-not-help', 'could-not-reach'];
export const OUTCOME_LABEL: Record<Outcome, string> = { helped: 'It helped', 'did-not-help': 'I tried; it did not help', 'could-not-reach': 'I could not reach them' };

/** Fewer answers than this are not shown, so one student's answer cannot be recognized. */
export const MIN_SHOWN = 5;

export interface Record_ {
  helped: number;
  tried: number;
  unreachable: number;
}

export function tally(outcomes: Outcome[]): Record_ {
  return {
    helped: outcomes.filter((o) => o === 'helped').length,
    tried: outcomes.length,
    unreachable: outcomes.filter((o) => o === 'could-not-reach').length,
  };
}

/** The sentence shown with a resource, or nothing when there are too few answers to share. */
export function recordLine(r: Record_): string | undefined {
  if (r.tried < MIN_SHOWN) return undefined;
  return `Helped ${r.helped} of ${r.tried} students who tried it${r.unreachable ? `; ${r.unreachable} could not reach them` : ''}.`;
}

/** A share of help from 0 to 1, shrunk toward one half when there are few answers, for ranking only. */
export const helpScore = (r: Record_): number => (r.helped + 1) / (r.tried + 2);

/** Flag for the curator: tried by enough students and rarely helped. Flagged, never hidden. */
export const needsReview = (r: Record_): boolean => r.tried >= MIN_SHOWN * 2 && r.helped / r.tried < 0.25;
