import { type Verdict, fail, pass, unknown } from './verdict.js';

/**
 * Measure from the datum (Pattern 12): drift is judged against a fixed
 * reference with a tolerance zone, never against the previous build.
 */
export interface Datum {
  id: string;
  measure: string;
  target: number;
  /** Acceptable values lie within [min, max]. Either bound may be omitted. */
  min?: number;
  max?: number;
}

export function checkDatum(d: Datum, measured: number | undefined): Verdict {
  const gate = `datum:${d.id}`;
  if (measured === undefined || Number.isNaN(measured)) return unknown(gate, `${d.measure} not measured`);
  if (d.min !== undefined && measured < d.min) return fail(gate, `${d.measure} ${measured} below ${d.min}`);
  if (d.max !== undefined && measured > d.max) return fail(gate, `${d.measure} ${measured} above ${d.max}`);
  return pass(gate, `${d.measure} ${measured} within zone (target ${d.target})`);
}
