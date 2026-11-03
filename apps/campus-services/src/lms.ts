import { BadRequest, NotFound, rng, service } from './common.js';

/**
 * Synthetic learning management system, shaped like the REST APIs of the LMS products colleges run: the signed-in
 * user, active courses, assignments with due dates, announcements and calendar events. Every call needs a bearer
 * token; each token belongs to one synthetic student. The `reschedule` scenario moves one assignment's due date,
 * so sync can be tested against a change made on the class site.
 */
interface Course {
  id: number;
  name: string;
  course_code: string;
  term: string;
}

const TERM = { name: 'Fall 2026', start: '2026-08-24', end: '2026-12-12' };

const COURSE_POOL: Omit<Course, 'id' | 'term'>[] = [
  { name: 'English Composition I', course_code: 'ENG 1101' },
  { name: 'College Algebra', course_code: 'MAT 1470' },
  { name: 'Introduction to Psychology', course_code: 'PSY 1100' },
  { name: 'Medical Terminology', course_code: 'HIM 1101' },
  { name: 'Introduction to Computer Applications', course_code: 'CIS 1107' },
  { name: 'Anatomy and Physiology I', course_code: 'BIO 1121' },
  { name: 'Principles of Accounting I', course_code: 'ACC 1210' },
  { name: 'Health Care Administration', course_code: 'HCA 3100' },
];

/** Tokens issued to synthetic students. A real deployment uses the LMS's OAuth flow instead. */
export const TOKENS: Record<string, { userId: number; name: string; courses: number }> = {
  'lms-maria': { userId: 1001, name: 'Maria', courses: 3 },
  'lms-jayden': { userId: 1002, name: 'Jayden', courses: 4 },
  'lms-keisha': { userId: 1003, name: 'Keisha', courses: 2 },
  'lms-alex': { userId: 1004, name: 'Alex', courses: 4 },
  'lms-tyler': { userId: 1005, name: 'Tyler', courses: 3 },
  'lms-demo': { userId: 1999, name: 'Demo student', courses: 3 },
};

export function coursesFor(token: string): Course[] {
  const t = TOKENS[token]!;
  const r = rng(`lms|${t.userId}`);
  return [...COURSE_POOL].sort(() => r() - 0.5).slice(0, t.courses).map((c, i) => ({ ...c, id: t.userId * 10 + i, term: TERM.name }));
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function assignmentsFor(course: Course, scenario?: string) {
  const r = rng(`assign|${course.id}`);
  const dueDay = 2 + Math.floor(r() * 4); // Tue..Fri
  const out: { id: number; name: string; due_at: string; points_possible: number; submission_types: string[]; html_url: string; course_id: number }[] = [];
  let n = 1;
  for (let wk = 1; wk <= 16; wk++) {
    const monday = addDays(TERM.start, (wk - 1) * 7);
    if (wk % 2 === 1 || r() < 0.3) {
      out.push({ id: course.id * 100 + n, name: `${wk % 4 === 0 ? 'Quiz' : 'Assignment'} ${n}`, due_at: `${addDays(monday, dueDay - 1)}T23:59:00-05:00`, points_possible: wk % 4 === 0 ? 20 : 50, submission_types: wk % 4 === 0 ? ['online_quiz'] : ['online_upload'], html_url: `https://lms.example/courses/${course.id}/assignments/${course.id * 100 + n}`, course_id: course.id });
      n++;
    }
  }
  out.push({ id: course.id * 100 + 99, name: 'Final exam', due_at: `${addDays(TERM.end, -2)}T10:00:00-05:00`, points_possible: 100, submission_types: ['on_paper'], html_url: `https://lms.example/courses/${course.id}/assignments/${course.id * 100 + 99}`, course_id: course.id });
  if (scenario === 'reschedule' && out[0]) {
    const moved = out.find((a) => a.due_at.slice(0, 10) >= '2026-11-02') ?? out[0];
    moved.due_at = `${addDays(moved.due_at.slice(0, 10), 3)}${moved.due_at.slice(10)}`;
  }
  return out;
}

export const lmsInfo = {
  id: 'lms',
  title: 'Class Site LMS (synthetic)',
  version: '1.0.0',
  description: 'The signed-in student, their courses, assignments with due dates, announcements and calendar events. Send Authorization: Bearer <token>.',
  endpoints: [
    { method: 'GET', path: '/api/v1/users/self', summary: 'The signed-in student' },
    { method: 'GET', path: '/api/v1/courses', summary: 'Active courses' },
    { method: 'GET', path: '/api/v1/courses/:id/assignments', summary: 'Assignments in a course, with due dates', query: { bucket: 'upcoming or past', at: 'service clock for bucket' } },
    { method: 'GET', path: '/api/v1/announcements', summary: 'Recent announcements across courses' },
    { method: 'GET', path: '/api/v1/calendar_events', summary: 'Calendar events across courses', query: { start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' } },
  ],
  scenarios: { reschedule: 'the first assignment due on or after Nov 2 moves three days later' },
} as const;

export function lmsService() {
  return service(lmsInfo as never, (app) => {
    app.use('/api/*', async (c, next) => {
      const tok = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
      if (!tok || !TOKENS[tok]) return c.json({ errors: [{ message: 'Invalid access token.' }] }, 401);
      c.set('token' as never, tok as never);
      await next();
    });
    const token = (c: { get: (k: never) => unknown }) => c.get('token' as never) as string;
    app.get('/api/v1/users/self', (c) => {
      const t = TOKENS[token(c)]!;
      return c.json({ id: t.userId, name: t.name, short_name: t.name });
    });
    app.get('/api/v1/courses', (c) => c.json(coursesFor(token(c))));
    app.get('/api/v1/courses/:id/assignments', (c) => {
      const course = coursesFor(token(c)).find((x) => String(x.id) === c.req.param('id'));
      if (!course) throw new NotFound('course not found');
      const bucket = c.req.query('bucket');
      if (bucket && bucket !== 'upcoming' && bucket !== 'past') throw new BadRequest('bucket must be upcoming or past');
      const now = c.req.query('at') ?? new Date().toISOString();
      const list = assignmentsFor(course, c.req.header('x-twin-scenario')).filter((a) => !bucket || (bucket === 'upcoming' ? Date.parse(a.due_at) >= Date.parse(now) : Date.parse(a.due_at) < Date.parse(now)));
      return c.json(list);
    });
    app.get('/api/v1/announcements', (c) =>
      c.json(
        coursesFor(token(c)).map((course, i) => ({ id: course.id * 7, title: i === 0 ? 'Room change for next week' : 'Office hours this week', message: i === 0 ? 'Class meets in Building 12, room 210 next Tuesday.' : 'Office hours are Wednesday 2 to 4 p.m.', posted_at: '2026-10-30T15:00:00-04:00', context_code: `course_${course.id}` })),
      ),
    );
    app.get('/api/v1/calendar_events', (c) => {
      const start = c.req.query('start_date') ?? TERM.start;
      const end = c.req.query('end_date') ?? TERM.end;
      const ev = coursesFor(token(c)).flatMap((course) => assignmentsFor(course, c.req.header('x-twin-scenario')).filter((a) => a.due_at.slice(0, 10) >= start && a.due_at.slice(0, 10) <= end).map((a) => ({ id: `assignment_${a.id}`, title: `${course.course_code}: ${a.name}`, start_at: a.due_at, type: 'assignment', context_code: `course_${course.id}` })));
      return c.json(ev);
    });
  });
}
