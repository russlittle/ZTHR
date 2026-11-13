import type { NeedCategory } from '../domain/types.js';
import type { ProviderKind, ProviderLevel, Situation } from '../guide/taxonomy.js';

/**
 * A catalog entry, shaped after the Open Referral Human Services Data
 * Specification (service, organization, location, schedule, eligibility) and
 * extended with what the navigator needs to do the legwork.
 */
export interface Resource {
  id: string;
  name: string;
  organization: string;
  categories: NeedCategory[];
  description: string;
  serves: { counties?: string[]; colleges?: string[]; national?: boolean };
  location?: { address: string; city: string; zip?: string };
  hours?: string; // undefined means not published: "call ahead"
  phone?: string;
  url?: string;
  appointmentOnly?: boolean;
  eligibility: { rule?: string; text: string };
  howToApply: string[];
  documents: string[];
  /** Profile and vault fields that can pre-fill an application. */
  prefill: string[];
  source: { url: string; license: 'public-information' | 'open-license' };
  verifiedOn: string;
  freshnessDays: number;
  tags?: string[];
  /** Who provides it, and at what level. Faith-based entries say plainly whether help depends on attending anything. */
  provider: { kind: ProviderKind; level: ProviderLevel; faithNote?: string };
  /** Situations it fits best; it may still serve others. */
  situations?: Situation[];
  /** What it costs the student. */
  cost?: 'free' | 'sliding-scale' | 'low-cost' | 'varies';
  /** What to expect when you go or call, in the source's terms. */
  whatToExpect?: string;
  /** What is known right now, each fact with its own source and date; absent means not known. */
  availability?: AvailabilityFact[];
}

export interface AvailabilityFact {
  fact: 'applications-open' | 'funding' | 'response-time' | 'season';
  value: string;
  source: string;
  checkedOn: string;
}

/** Fresh while within its freshness window. An entry verified after the reference date (the demonstration runs on a
 * fixed day) was checked more recently than that, so it counts as current. */
export function isFresh(r: Resource, today: string): boolean {
  const age = (Date.parse(today) - Date.parse(r.verifiedOn)) / 86_400_000;
  return age <= r.freshnessDays;
}
