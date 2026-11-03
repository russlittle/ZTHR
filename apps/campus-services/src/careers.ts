import { BadRequest, NotFound, campusParam, minutes, service, type CampusId } from './common.js';

/**
 * Synthetic careers service: job postings (on and near campus, work-study, with weekly schedules and a fair-chance
 * flag) and a mentor directory (alumni and staff who volunteer, by field and language). Shaped like the job boards
 * and mentoring platforms career offices license.
 */
export interface Posting {
  id: string;
  campus: CampusId;
  title: string;
  employer: string;
  onCampus: boolean;
  workStudy: boolean;
  pay: number;
  hoursPerWeek: number;
  /** Fixed weekly shifts, or empty when the schedule is flexible. */
  schedule: { day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'; start: string; end: string }[];
  fairChance: boolean;
  field: string;
  closes: string;
}

const P = (campus: CampusId, n: number, title: string, employer: string, onCampus: boolean, workStudy: boolean, pay: number, schedule: Posting['schedule'], fairChance: boolean, field: string, closes: string): Posting => ({
  id: `${campus}-job-${n}`,
  campus,
  title,
  employer,
  onCampus,
  workStudy,
  pay,
  hoursPerWeek: schedule.length ? schedule.reduce((t, s) => t + (minutes(s.end) - minutes(s.start)) / 60, 0) : 15,
  schedule,
  fairChance,
  field,
  closes,
});

export const POSTINGS: Posting[] = [
  P('sinclair', 1, 'Library desk assistant', 'Sinclair Library', true, true, 13.5, [{ day: 'Mon', start: '13:00', end: '17:00' }, { day: 'Wed', start: '13:00', end: '17:00' }, { day: 'Fri', start: '09:00', end: '13:00' }], false, 'office', '2026-11-20'),
  P('sinclair', 2, 'Tutoring center front desk', 'Sinclair Tutoring', true, true, 13.5, [], false, 'education', '2026-11-30'),
  P('sinclair', 3, 'Warehouse associate, evenings', 'Regional distribution center (synthetic)', false, false, 18.25, [{ day: 'Mon', start: '18:00', end: '23:00' }, { day: 'Tue', start: '18:00', end: '23:00' }, { day: 'Thu', start: '18:00', end: '23:00' }], true, 'logistics', '2026-12-05'),
  P('sinclair', 4, 'Patient access representative', 'Downtown clinic (synthetic)', false, false, 17.0, [{ day: 'Sat', start: '08:00', end: '16:30' }, { day: 'Sun', start: '08:00', end: '16:30' }], true, 'healthcare', '2026-11-25'),
  P('sinclair', 5, 'IT help desk, part time', 'Sinclair IT', true, false, 15.0, [{ day: 'Tue', start: '08:00', end: '12:00' }, { day: 'Thu', start: '08:00', end: '12:00' }], false, 'technology', '2026-12-01'),
  P('wright-state', 1, 'Recreation center attendant', 'Wright State Recreation', true, true, 12.5, [{ day: 'Sat', start: '10:00', end: '16:00' }, { day: 'Sun', start: '12:00', end: '18:00' }], false, 'recreation', '2026-11-22'),
  P('wright-state', 2, 'Research lab assistant', 'Biology department', true, true, 14.0, [], false, 'science', '2026-12-10'),
  P('wright-state', 3, 'Medical billing clerk, remote', 'Billing services firm (synthetic)', false, false, 19.0, [], true, 'healthcare', '2026-12-15'),
  P('wright-state', 4, 'Line cook', 'Fairborn restaurant (synthetic)', false, false, 16.0, [{ day: 'Fri', start: '16:00', end: '22:00' }, { day: 'Sat', start: '16:00', end: '22:00' }], true, 'food service', '2026-11-28'),
  P('antioch', 1, 'Farm crew member', 'Antioch Farm', true, true, 13.0, [{ day: 'Tue', start: '07:00', end: '11:00' }, { day: 'Thu', start: '07:00', end: '11:00' }], false, 'agriculture', '2026-11-30'),
  P('antioch', 2, 'Co-op placement: community health worker', 'County health district (synthetic)', false, false, 17.5, [{ day: 'Mon', start: '09:00', end: '17:00' }, { day: 'Wed', start: '09:00', end: '17:00' }], true, 'healthcare', '2027-01-15'),
];

export interface Mentor {
  id: string;
  campus: CampusId | 'any';
  displayName: string;
  field: string;
  role: string;
  languages: string[];
  experiences: string[];
  openSlots: number;
}

export const MENTORS: Mentor[] = [
  { id: 'm1', campus: 'sinclair', displayName: 'Dana R.', field: 'healthcare', role: 'Nurse, Sinclair graduate', languages: ['en'], experiences: ['student-parents', 'first-generation'], openSlots: 2 },
  { id: 'm2', campus: 'sinclair', displayName: 'Marcus T.', field: 'technology', role: 'Network technician', languages: ['en'], experiences: ['adult-learners', 'veterans'], openSlots: 1 },
  { id: 'm3', campus: 'any', displayName: 'Lucía M.', field: 'business', role: 'Small business owner', languages: ['en', 'es'], experiences: ['first-generation'], openSlots: 3 },
  { id: 'm4', campus: 'wright-state', displayName: 'Priya S.', field: 'science', role: 'Lab manager', languages: ['en'], experiences: ['first-generation'], openSlots: 2 },
  { id: 'm5', campus: 'any', displayName: 'James W.', field: 'logistics', role: 'Operations supervisor, second-chance hire', languages: ['en'], experiences: ['fair-chance'], openSlots: 2 },
  { id: 'm6', campus: 'antioch', displayName: 'Sam K.', field: 'education', role: 'Teacher', languages: ['en'], experiences: ['lgbtq', 'disabled-students'], openSlots: 1 },
  { id: 'm7', campus: 'any', displayName: 'Rosa G.', field: 'healthcare', role: 'Medical assistant', languages: ['en', 'es'], experiences: ['student-parents'], openSlots: 0 },
];

export const careersInfo = {
  id: 'careers',
  title: 'Campus Careers (synthetic)',
  version: '1.0.0',
  description: 'Job postings with weekly schedules, and a volunteer mentor directory.',
  endpoints: [
    { method: 'GET', path: '/v1/postings', summary: 'Open postings for a campus', query: { campus: 'campus id', q: 'words in title or field', workStudy: 'true to show only work-study', maxHours: 'hours per week', fairChance: 'true to show only fair-chance employers', asOf: 'YYYY-MM-DD; postings closed before this are left out' } },
    { method: 'GET', path: '/v1/postings/:id', summary: 'One posting' },
    { method: 'GET', path: '/v1/mentors', summary: 'Mentors with open slots', query: { campus: 'campus id', field: 'field', language: 'en or es', experience: 'a shared experience, such as student-parents' } },
  ],
  scenarios: {},
} as const;

export function careersService() {
  return service(careersInfo as never, (app) => {
    app.get('/v1/postings', (c) => {
      const campus = campusParam(c);
      const q = c.req.query('q')?.toLowerCase();
      const maxHours = c.req.query('maxHours') ? Number(c.req.query('maxHours')) : Infinity;
      if (Number.isNaN(maxHours)) throw new BadRequest('maxHours must be a number');
      const asOf = c.req.query('asOf');
      const postings = POSTINGS.filter(
        (p) => p.campus === campus && (!q || `${p.title} ${p.field} ${p.employer}`.toLowerCase().includes(q)) && (c.req.query('workStudy') !== 'true' || p.workStudy) && (c.req.query('fairChance') !== 'true' || p.fairChance) && p.hoursPerWeek <= maxHours && (!asOf || p.closes >= asOf),
      );
      return c.json({ campus, postings });
    });
    app.get('/v1/postings/:id', (c) => {
      const p = POSTINGS.find((x) => x.id === c.req.param('id'));
      if (!p) throw new NotFound(`no posting ${c.req.param('id')}`);
      return c.json(p);
    });
    app.get('/v1/mentors', (c) => {
      const campus = c.req.query('campus');
      const field = c.req.query('field');
      const language = c.req.query('language');
      const experience = c.req.query('experience');
      const mentors = MENTORS.filter((m) => m.openSlots > 0 && (!campus || m.campus === campus || m.campus === 'any') && (!field || m.field === field) && (!language || m.languages.includes(language)) && (!experience || m.experiences.includes(experience)));
      return c.json({ mentors });
    });
  });
}
