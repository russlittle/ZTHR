/**
 * Three-valued verdicts (ZTHR Pattern 9: Unknown Is a State).
 * A verdict is pass, fail or unknown. Unknown never becomes pass: any
 * combination containing an unknown and no fail is unknown.
 */
export type Status = 'pass' | 'fail' | 'unknown';

export interface Verdict {
  gate: string;
  status: Status;
  reason: string;
  evidence?: unknown;
  at: string;
}

export const verdict = (gate: string, status: Status, reason: string, evidence?: unknown): Verdict => ({
  gate,
  status,
  reason,
  evidence,
  at: new Date().toISOString(),
});

export const pass = (gate: string, reason = 'ok', evidence?: unknown) => verdict(gate, 'pass', reason, evidence);
export const fail = (gate: string, reason: string, evidence?: unknown) => verdict(gate, 'fail', reason, evidence);
export const unknown = (gate: string, reason: string, evidence?: unknown) => verdict(gate, 'unknown', reason, evidence);

/** Combine verdicts: any fail is fail; otherwise any unknown is unknown; an empty set is unknown. */
export function combine(gate: string, verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return unknown(gate, 'no verdicts were produced');
  const failed = verdicts.filter((v) => v.status === 'fail');
  if (failed.length > 0) return fail(gate, failed.map((v) => `${v.gate}: ${v.reason}`).join('; '), verdicts);
  const unknowns = verdicts.filter((v) => v.status === 'unknown');
  if (unknowns.length > 0) return unknown(gate, unknowns.map((v) => `${v.gate}: ${v.reason}`).join('; '), verdicts);
  return pass(gate, `${verdicts.length} checks passed`, verdicts);
}

/** Only an explicit pass admits. */
export const admits = (v: Verdict): boolean => v.status === 'pass';
