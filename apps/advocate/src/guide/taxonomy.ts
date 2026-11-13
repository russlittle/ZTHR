import type { NeedCategory } from '../domain/types.js';

/**
 * The barrier taxonomy (docs/flows/resource-guide.md). Barriers are the service facet of the Open Eligibility
 * taxonomy (Open Referral, CC BY-SA 3.0) as a student experiences them; situations are the second facet and change
 * which resources fit. Barriers are the Advocate's need categories: one vocabulary across check-ins, matching, the
 * guide and the public feed.
 */
/** The five ways support helps a student stay and finish (the first four after Karp, CCRC; the fifth, thriving). */
export const DOMAINS = ['feasible', 'know-how', 'aims', 'people', 'thriving'] as const;
export type Domain = (typeof DOMAINS)[number];
export const DOMAIN_LABEL: Record<Domain, string> = {
  feasible: 'Making college life work',
  'know-how': 'Knowing how college works',
  aims: 'Knowing where you are headed',
  people: 'People in your corner',
  thriving: 'Feeling well and finding opportunity',
};

export interface BarrierDef {
  id: NeedCategory;
  domain: Domain;
  label: string;
  /** What it covers, in the student's words. */
  covers: string;
  /** Shown first when it is open: help that cannot wait. */
  urgent?: boolean;
}

export const BARRIERS: BarrierDef[] = [
  { id: 'emergency', domain: 'feasible', label: 'Emergency', covers: 'No safe place tonight, no food today, or a crisis', urgent: true },
  { id: 'food', domain: 'feasible', label: 'Food', covers: 'Running short, no money for groceries, no way to cook' },
  { id: 'housing', domain: 'feasible', label: 'Housing', covers: 'Behind on rent, facing eviction, unstable, or without a home' },
  { id: 'utilities', domain: 'feasible', label: 'Utilities', covers: 'A shut-off notice, a high bill, or no heat' },
  { id: 'money', domain: 'feasible', label: 'Money', covers: 'A bill coming due, a gap before payday, an emergency cost' },
  { id: 'transportation', domain: 'feasible', label: 'Transportation', covers: 'No reliable way to class or work' },
  { id: 'childcare', domain: 'feasible', label: 'Child care', covers: 'No care for class or shifts' },
  { id: 'caregiving', domain: 'feasible', label: 'Caring for family', covers: 'Caring for a parent, relative or someone ill' },
  { id: 'health', domain: 'feasible', label: 'Health', covers: 'Care, prescriptions, insurance' },
  { id: 'mental-health', domain: 'feasible', label: 'Mental health', covers: 'Stress, anxiety, grief, a hard week' },
  { id: 'safety', domain: 'feasible', label: 'Safety', covers: 'Not safe at home or in a relationship', urgent: true },
  { id: 'legal', domain: 'feasible', label: 'Legal', covers: 'Eviction, records, benefits appeals' },
  { id: 'phone-internet', domain: 'feasible', label: 'Phone and internet', covers: 'No phone, internet or computer' },
  { id: 'goods', domain: 'feasible', label: 'Clothing and goods', covers: 'Clothing, hygiene items, furniture, supplies' },
  { id: 'books', domain: 'feasible', label: 'Books and course supplies', covers: 'Textbooks, calculators, course fees' },
  { id: 'documents', domain: 'feasible', label: 'ID and documents', covers: 'No ID, birth certificate or Social Security card' },
  { id: 'career', domain: 'feasible', label: 'Work', covers: 'Hours cut, a job lost, or looking for a better one' },
  { id: 'aid', domain: 'know-how', label: 'Aid and benefits', covers: 'FAFSA, verification, an appeal, benefits you may qualify for' },
  { id: 'academic', domain: 'know-how', label: 'School', covers: 'Falling behind, a disability, tutoring, advising' },
  { id: 'direction', domain: 'aims', label: 'Direction', covers: 'Unsure about a program or a career' },
  { id: 'belonging', domain: 'people', label: 'Belonging', covers: 'No one to ask, feeling alone, wanting people like me' },
  { id: 'wellbeing', domain: 'thriving', label: 'Move and recharge', covers: 'Parks, trails, gyms, classes and time outdoors' },
  { id: 'opportunity', domain: 'thriving', label: 'Opportunity', covers: 'Events, volunteering, arts and culture, scholarships, paid internships' },
];

export const BARRIER: Record<NeedCategory, BarrierDef> = Object.fromEntries(BARRIERS.map((b) => [b.id, b])) as Record<NeedCategory, BarrierDef>;

/** Situations: not barriers, but they change which resources fit. */
export const SITUATIONS = ['student-parent', 'working-student', 'veteran', 'foster-youth', 'first-generation', 'returning-adult', 'disability', 'no-car', 'youth-under-25'] as const;
export type Situation = (typeof SITUATIONS)[number];

export const SITUATION_LABEL: Record<Situation, string> = {
  'student-parent': 'Student parents',
  'working-student': 'Working students',
  veteran: 'Veterans',
  'foster-youth': 'Former foster youth',
  'first-generation': 'First in family to attend college',
  'returning-adult': 'Returning adults',
  disability: 'Students with a disability',
  'no-car': 'Students without a car',
  'youth-under-25': 'Young adults under 25',
};

/** Who provides a service: a student deciding whether to walk in somewhere wants to know. */
export const PROVIDER_KINDS = ['college', 'government', 'nonprofit', 'faith', 'community', 'health'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  college: 'College',
  government: 'Government',
  nonprofit: 'Nonprofit',
  faith: 'Faith-based',
  community: 'Community',
  health: 'Health care',
};
export const PROVIDER_LEVELS = ['federal', 'state', 'county', 'city', 'regional', 'local', 'college'] as const;
export type ProviderLevel = (typeof PROVIDER_LEVELS)[number];
