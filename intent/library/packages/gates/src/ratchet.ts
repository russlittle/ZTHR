import { type Verdict, fail, pass, unknown } from './verdict.js';

/**
 * Ratchets (Pattern 10): existing debt may stay, but it may not grow.
 * Tightening is automatic. Loosening happens only through a reset recorded
 * in the ledger by a named person with a reason.
 */
export interface RatchetState {
  id: string;
  metric: string;
  /** 'down' means lower is better (e.g. lint findings); 'up' means higher is better (e.g. mutation score). */
  direction: 'down' | 'up';
  floor: number;
}

export interface ResetEntry {
  ratchet: string;
  from: number;
  to: number;
  reason: string;
  by: string;
  at: string;
}

export interface RatchetResult {
  verdict: Verdict;
  next: RatchetState;
}

export function checkRatchet(state: RatchetState, current: number | undefined): RatchetResult {
  const gate = `ratchet:${state.id}`;
  if (current === undefined || Number.isNaN(current)) {
    return { verdict: unknown(gate, `no measurement for ${state.metric}`), next: state };
  }
  const worse = state.direction === 'down' ? current > state.floor : current < state.floor;
  if (worse) {
    return { verdict: fail(gate, `${state.metric} is ${current}, worse than the floor ${state.floor}`), next: state };
  }
  const better = state.direction === 'down' ? current < state.floor : current > state.floor;
  const next = better ? { ...state, floor: current } : state;
  return { verdict: pass(gate, better ? `tightened ${state.floor} -> ${current}` : `held at ${state.floor}`), next };
}

/** A change to a floor that loosens it must be matched by a ledger entry made by a person. */
export function verifyFloorChange(
  before: RatchetState,
  after: RatchetState,
  ledger: ResetEntry[],
  people: string[],
): Verdict {
  const gate = `ratchet-reset:${before.id}`;
  const loosened = before.direction === 'down' ? after.floor > before.floor : after.floor < before.floor;
  if (!loosened) return pass(gate, 'floor held or tightened');
  const entry = ledger.find((e) => e.ratchet === before.id && e.from === before.floor && e.to === after.floor);
  if (!entry) return fail(gate, `floor loosened ${before.floor} -> ${after.floor} without a reset ledger entry`);
  if (!people.includes(entry.by)) return fail(gate, `reset by "${entry.by}", who is not a listed person`);
  if (entry.reason.trim().length < 20) return fail(gate, 'reset reason is missing or too short to audit');
  return pass(gate, `reset by ${entry.by}: ${entry.reason}`);
}
