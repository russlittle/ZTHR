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
  /** How urgent the need is when the answer reveals it. */
  urgency?: 'tonight' | 'soon' | 'someday';
  /** Where the question comes from, and whether it may be reused as written. */
  source: { cite: string; status: 'free-with-citation' | 'adapted, citation and notice pending' | 'written for the Advocate' };
}

const AHC = 'Adapted from the CMS Accountable Health Communities Health-Related Social Needs Screening Tool (Billioux et al., 2017)';

export const PULSES: Pulse[] = [
  { id: 'ride', question: 'Quick one: has not having a reliable ride kept you from class or work lately?', needOn: 'yes', need: 'transportation', tipWhenFine: 'Good. If that changes, tell me and I will find a backup ride fast.', source: { cite: AHC, status: 'adapted, citation and notice pending' } },
  { id: 'food', question: 'Quick one: lately, have you worried your food would run out before you had money to buy more?', needOn: 'yes', need: 'food', tipWhenFine: 'Glad to hear it. Sinclair and Wright State both run free food pantries if a week ever gets tight.', source: { cite: 'Hunger Vital Sign, item 1 (Hager et al., Pediatrics, 2010)', status: 'free-with-citation' } },
  { id: 'bills', question: 'Quick one: is a bill coming up that you are worried about?', needOn: 'yes', need: 'money', tipWhenFine: 'Nice. If you tell me your bills and paydays, I can warn you before a short month.', source: { cite: 'Written for the Advocate', status: 'written for the Advocate' } },
  { id: 'phone', question: 'Quick one: is your phone or internet bill hard to keep up with?', needOn: 'yes', need: 'phone-internet', tipWhenFine: 'Good. Lifeline can cut a phone or internet bill if that ever changes.', source: { cite: 'Written for the Advocate', status: 'written for the Advocate' } },
  { id: 'tonight', question: 'Quick one: do you have a safe place to stay tonight?', needOn: 'no', need: 'emergency', urgency: 'tonight', tipWhenFine: 'Good. If that ever changes, tell me any time, day or night.', source: { cite: 'Written for the Advocate', status: 'written for the Advocate' } },
  { id: 'housing', question: 'Quick one: are you worried about losing the place where you live?', needOn: 'yes', need: 'housing', urgency: 'soon', tipWhenFine: 'Good to hear. If rent ever gets tight, tell me early; there is more help before a due date than after.', source: { cite: AHC, status: 'adapted, citation and notice pending' } },
  { id: 'utilities', question: 'Quick one: has a gas, electric or water company said it might shut off your service?', needOn: 'yes', need: 'utilities', urgency: 'soon', tipWhenFine: 'Good. If a shut-off notice ever comes, tell me the date on it.', source: { cite: AHC, status: 'adapted, citation and notice pending' } },
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
