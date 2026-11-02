import type { NeedCategory } from '../domain/types.js';

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
}

export function isFresh(r: Resource, today: string): boolean {
  const age = (Date.parse(today) - Date.parse(r.verifiedOn)) / 86_400_000;
  return age >= 0 && age <= r.freshnessDays;
}
