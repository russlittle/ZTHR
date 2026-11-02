import type { NeedCategory } from './types.js';

/**
 * Single-question pulses (PRD NAV-10). One optional question at a time, at
 * the rhythm the student set. Every answer returns something useful at once:
 * a yes or no that reveals a need opens help; one that doesn't still gets a
 * tip worth having (PRD P6, give before asking).
 */
export interface Pulse {
  id: string;
  question: string;
  /** The answer that signals a need. */
  needOn: 'yes' | 'no';
  need: NeedCategory;
  tipWhenFine: string;
}

export const PULSES: Pulse[] = [
  { id: 'ride', question: 'Quick one: do you have a reliable way to get to campus this week?', needOn: 'no', need: 'transportation', tipWhenFine: 'Good. If that changes, tell me and I will find a backup ride fast.' },
  { id: 'food', question: 'Quick one: has buying food been hard this week?', needOn: 'yes', need: 'food', tipWhenFine: 'Glad to hear it. Sinclair and Wright State both run free food pantries if a week ever gets tight.' },
  { id: 'bills', question: 'Quick one: is a bill coming up that you are worried about?', needOn: 'yes', need: 'money', tipWhenFine: 'Nice. If you tell me your bills and paydays, I can warn you before a short month.' },
  { id: 'phone', question: 'Quick one: is your phone or internet bill hard to keep up with?', needOn: 'yes', need: 'phone-internet', tipWhenFine: 'Good. Lifeline can cut a phone or internet bill if that ever changes.' },
];

export interface PulseState {
  asked: Record<string, string>; // pulse id -> date asked
  off?: boolean;
  everyDays: number;
}

export function nextPulse(state: PulseState, today: string): Pulse | undefined {
  if (state.off) return undefined;
  const last = Object.values(state.asked).sort().at(-1);
  if (last && (Date.parse(today) - Date.parse(last)) / 86_400_000 < state.everyDays) return undefined;
  return PULSES.find((p) => !state.asked[p.id] || (Date.parse(today) - Date.parse(state.asked[p.id]!)) / 86_400_000 >= 28);
}
