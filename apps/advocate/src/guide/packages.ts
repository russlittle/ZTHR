import type { NeedCategory } from '../domain/types.js';

/**
 * Support packages: for one barrier, the combination of help that usually works, in the order to try it. The
 * Advocate offers only the entries that serve this student (their college or county) and are current; a package
 * whose entries all fall away says so plainly and points to 2-1-1.
 */
export interface SupportPackage {
  id: string;
  need: NeedCategory;
  title: string;
  /** Why this combination, in one sentence. */
  why: string;
  /** Catalog entries, in the order to try them. */
  entries: string[];
  /** Something the student can do themselves, alongside. */
  selfStep?: string;
}

export const PACKAGES: SupportPackage[] = [
  {
    id: 'tonight',
    need: 'emergency',
    title: 'A safe place to stay tonight',
    why: 'Call a shelter first to check for room; 2-1-1 can find one that has space, any time.',
    entries: ['daybreak', 'svdp-womens-shelter', 'homefull-mens-shelter', 'greene-ihn', 'united-way-211', 'ywca-dayton', 'greene-fvpc'],
  },
  {
    id: 'not-safe',
    need: 'safety',
    title: 'Getting safe',
    why: 'These hotlines answer day and night and can arrange a safe place to stay.',
    entries: ['ywca-dayton', 'greene-fvpc', 'lifeline-988'],
    selfStep: 'If you are in danger right now, call 911.',
  },
  {
    id: 'rent-short',
    need: 'housing',
    title: 'Short on rent',
    why: 'College emergency money is fastest; the county and community action agencies can add more; legal aid helps if an eviction has started.',
    entries: ['sinclair-emergency-grant', 'sinclair-student-assistance', 'mvcap', 'housing-solutions-greene', 'united-way-211', 'lawo'],
    selfStep: 'Ask your landlord in writing for a few more days, and keep a copy.',
  },
  {
    id: 'food-short',
    need: 'food',
    title: 'Food is running short',
    why: 'A campus pantry helps today; SNAP helps every month after.',
    entries: ['sinclair-food-pantry', 'sinclair-lunch-time-hunger', 'wsu-raider-food-pantry', 'foodbank-dayton', 'house-of-bread', 'ohio-benefits-snap', 'greene-fish-xenia'],
  },
  {
    id: 'shut-off',
    need: 'utilities',
    title: 'A shut-off notice',
    why: 'The winter crisis program and HEAP can stop a shut-off; PIPP Plus keeps the bill steady after.',
    entries: ['ohio-heap', 'mvcap', 'greene-cap', 'ohio-pipp-plus', 'sinclair-emergency-grant'],
    selfStep: 'Call the utility and ask for a payment plan; tell them you are applying for help.',
  },
  {
    id: 'no-ride',
    need: 'transportation',
    title: 'No way to get to class',
    why: 'Students ride the bus at a reduced fare, and rides from the door are there for riders with a disability.',
    entries: ['rta', 'rta-project-mobility', 'greene-cats'],
  },
  {
    id: 'no-child-care',
    need: 'childcare',
    title: 'No child care for class or work',
    why: 'The county can pay for part of child care; 4C finds openings that fit your hours.',
    entries: ['four-c-child-care', 'montgomery-jfs', 'greene-jfs', 'gem-city-diaper-bank'],
  },
  {
    id: 'hard-week',
    need: 'mental-health',
    title: 'A hard week',
    why: 'Talking to someone helps, and so does moving: a walk outside or a free class can lift a hard week.',
    entries: ['sinclair-counseling', 'wsu-counseling', 'samaritan-behavioral', 'tcn-greene', 'metroparks-free-fitness', 'wsu-campus-rec', 'lifeline-988'],
    selfStep: 'If you are thinking about hurting yourself, call or text 988 now.',
  },
  {
    id: 'falling-behind',
    need: 'academic',
    title: 'Falling behind in a class',
    why: 'Tutoring is free, and accommodations help if a disability is part of it.',
    entries: ['sinclair-tutoring', 'sinclair-trio', 'sinclair-accessibility', 'wsu-disability'],
  },
  {
    id: 'no-id',
    need: 'documents',
    title: 'No photo ID',
    why: 'An Ohio state ID is free for residents 17 and older without a driver license.',
    entries: ['ohio-state-id'],
  },
  {
    id: 'need-work',
    need: 'career',
    title: 'Hours cut or need a job',
    why: 'Workforce centers help with jobs and training; your college career office knows jobs that fit a class schedule.',
    entries: ['omj-montgomery', 'omj-greene', 'wsu-career-hub', 'sinclair-trio'],
  },
  {
    id: 'alone',
    need: 'belonging',
    title: 'Finding your people',
    why: 'A center for students like you is a place to belong, and a free class or event is an easy way to meet people.',
    entries: ['sinclair-veterans', 'wsu-veteran-center', 'sinclair-trio', 'metroparks-free-fitness', 'dai-art-for-all'],
  },
];

export const PACKAGE: Record<string, SupportPackage> = Object.fromEntries(PACKAGES.map((p) => [p.id, p]));
export const packageFor = (need: NeedCategory): SupportPackage | undefined => PACKAGES.find((p) => p.need === need);
