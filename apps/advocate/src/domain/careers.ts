import type { Student } from './types.js';

/**
 * Career help (PRD CAR-1, CAR-3). Two things, both started by the student:
 *  - where to get career help at their own college, and what to bring;
 *  - for a student who says they have a record, the fair-chance path in Ohio: the Certificate of Qualification
 *    for Employment, which can lift automatic bars to jobs and licenses.
 * The Advocate never infers a record. A sealed fact is never opened for this; the student says it, or nothing.
 */
export interface CareerSource {
  name: string;
  contact: string;
  source: string;
}

export const CAREER_CENTERS: Record<string, CareerSource> = {
  sinclair: { name: 'Sinclair Student and Community Engagement', contact: '937-512-2509 or studentandcommunity@sinclair.edu', source: 'https://www.collegecentral.com/sinclair/ContactUs.cfm' },
  'wright-state': { name: 'Wright State Career Services', contact: 'wright.edu, under Career Services', source: 'https://www.wsuguardian.com/article/2025/02/career-services-new-and-improved-location' },
  antioch: { name: 'the Antioch College co-op office', contact: 'antiochcollege.edu', source: 'https://antiochcollege.edu' },
};

export const CQE = {
  name: 'the Certificate of Qualification for Employment (CQE)',
  what: 'In Ohio, a CQE can lift automatic bars that a record puts on many jobs and job licenses. Employers who hire someone with a CQE get added legal protection, which makes saying yes easier.',
  how: ['Fill out the petition online through the Ohio Department of Rehabilitation and Correction.', 'The court in your county reviews it.', 'Free legal help can walk you through it.'],
  source: 'https://dam.assets.ohio.gov/image/upload/drc.ohio.gov/Forms/CQE%20Flyer%20-%20Petition%20Instructions%203-5-24.pdf',
} as const;

export const RECORD_WORDS = /\b(i have a (criminal )?record|my record|felony|conviction|convicted|background check|on parole|on probation|was incarcerated|got out of (prison|jail))\b/i;

export function careerText(s: Student): string {
  const c = CAREER_CENTERS[s.enrollment.college];
  return [
    c ? `Your college has free help to find a job: ${c.name}. Reach them at ${c.contact}.` : 'Your college has free help to find a job.',
    'They help you write a resume, get ready to talk to a boss, and find work that fits your classes.',
    'Bring a list of jobs you have had and your class times.',
  ].join(' ');
}

export function fairChanceText(): string {
  return `${CQE.what} Here is how to start:\n${CQE.how.map((h, i) => `${i + 1}. ${h}`).join('\n')}\nNothing about this is saved unless you ask me to.`;
}
