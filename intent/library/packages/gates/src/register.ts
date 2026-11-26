import { type Verdict, fail, pass } from './verdict.js';

/**
 * Register, don't suppress (Pattern 13): an accepted finding is written down
 * with an owner, a reason and an expiry. Expired entries fail the gate.
 */
export interface RegisteredFinding {
  id: string;
  gate: string;
  reason: string;
  owner: string;
  expires: string;
}

export function checkRegister(entries: RegisteredFinding[], now = new Date()): Verdict {
  const expired = entries.filter((e) => new Date(e.expires).getTime() <= now.getTime());
  if (expired.length > 0) return fail('findings-register', `expired findings: ${expired.map((e) => e.id).join(', ')}`);
  const unowned = entries.filter((e) => !e.owner || !e.reason);
  if (unowned.length > 0) return fail('findings-register', `findings without owner or reason: ${unowned.map((e) => e.id).join(', ')}`);
  return pass('findings-register', `${entries.length} registered findings, none expired`);
}

/** A finding is accepted only if it is registered and current. */
export function isAccepted(entries: RegisteredFinding[], id: string, now = new Date()): boolean {
  const e = entries.find((x) => x.id === id);
  return !!e && new Date(e.expires).getTime() > now.getTime();
}
