import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Advocate, ApiScope } from '../agents/advocate.js';
import { parseShifts } from '../domain/shifts.js';

/**
 * The integration API (PRD Phase 3): a student connects any other tool to their Advocate.
 *
 * Every request carries a bearer token the student created; it reaches only that student's data, within the
 * scopes they chose. Ingest goes through the same code paths as the app (syllabus, calendar, shifts, forwarded
 * mail, money), so it is checked by the same gates. Export gives everything back as JSON, CSV or a calendar feed.
 * Sealed facts are never exported through the API.
 */
type Vars = { Variables: { sid: string; scopes: ApiScope[] } };

const DeadlineIn = z.object({ title: z.string().min(1).max(200), due: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/), course: z.string().max(40).optional(), kind: z.enum(['assignment', 'exam', 'reading', 'college', 'aid', 'benefit', 'bill', 'appointment', 'other']).default('other'), effortHours: z.number().min(0).max(200).optional() });
const SyllabusIn = z.object({ course: z.string().min(1).max(40), text: z.string().min(1).max(50_000), termStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const CalendarIn = z.object({ ics: z.string().min(1).max(500_000), course: z.string().max(40).optional() });
const ShiftsIn = z.union([z.object({ text: z.string().min(1).max(2000) }), z.object({ shifts: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), employer: z.string().max(80).optional() })).max(60) })]);
const EmailIn = z.object({ from: z.string().max(200).optional(), subject: z.string().max(300).optional(), text: z.string().min(1).max(50_000) });
const MoneyIn = z.object({ balance: z.number(), bills: z.array(z.object({ name: z.string().max(60), amount: z.number().min(0), dueDay: z.number().int().min(1).max(31), kind: z.enum(['rent', 'utility', 'phone', 'car', 'childcare', 'other']) })).max(40), pay: z.object({ amount: z.number().min(0), next: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), everyDays: z.number().int().min(1).max(62) }).optional() });
const ActionIn = z.object({ action: z.string().min(1).max(200) });
const WebhookIn = z.object({ url: z.string().url().max(500), events: z.array(z.enum(['*', 'deadline.added', 'deadline.done', 'message.delivered', 'draft.sent', 'money.gap'])).min(1) });

const CSV_COLLECTIONS = ['deadlines', 'shifts', 'holds', 'reminders', 'messages'] as const;

const csv = (rows: Record<string, unknown>[]): string => {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
};

export const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Student Advocate API', version: '1.0.0', description: 'Connect your own tools to your Advocate. Every call uses a token you create; it reaches only your data.' },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  security: [{ bearer: [] }],
  paths: {
    '/v1/me': { get: { summary: 'Your profile (never sealed facts)', 'x-scope': 'read' } },
    '/v1/today': { get: { summary: 'Today: classes, shifts, what is due, the one thing', 'x-scope': 'read' } },
    '/v1/deadlines': { get: { summary: 'All deadlines', 'x-scope': 'read' }, post: { summary: 'Add a deadline', 'x-scope': 'write' } },
    '/v1/syllabus': { post: { summary: 'Ingest a syllabus; dates come back unconfirmed', 'x-scope': 'write' } },
    '/v1/calendar': { post: { summary: 'Ingest an iCalendar feed', 'x-scope': 'write' } },
    '/v1/shifts': { get: { summary: 'Work shifts', 'x-scope': 'read' }, post: { summary: 'Add shifts as text ("Tue 3pm-9pm") or as a list', 'x-scope': 'write' } },
    '/v1/inbound/email': { post: { summary: 'Forward an email; needs forwarding turned on', 'x-scope': 'write' } },
    '/v1/money': { put: { summary: 'Balance, bills and pay', 'x-scope': 'write' } },
    '/v1/eligibility': { get: { summary: 'Programs checked and results', 'x-scope': 'read' } },
    '/v1/messages': { get: { summary: 'Messages your Advocate sent you', 'x-scope': 'read' } },
    '/v1/actions': { post: { summary: 'Tap any button by its action id', 'x-scope': 'actions' } },
    '/v1/export': { get: { summary: 'Everything, as JSON', 'x-scope': 'read' } },
    '/v1/export/{collection}.csv': { get: { summary: 'One collection as CSV', 'x-scope': 'read' } },
    '/v1/calendar.ics': { get: { summary: 'Deadlines and held time as a calendar feed', 'x-scope': 'read' } },
    '/v1/webhooks': { get: { summary: 'Your webhooks', 'x-scope': 'read' }, post: { summary: 'Add a webhook (https only)', 'x-scope': 'write' } },
    '/v1/webhooks/{id}': { delete: { summary: 'Remove a webhook', 'x-scope': 'write' } },
  },
} as const;

export function createApi(a: Advocate): Hono<Vars> {
  const api = new Hono<Vars>();

  api.get('/openapi.json', (c) => c.json(OPENAPI));

  api.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const owner = token ? a.tokenOwner(token) : undefined;
    if (!owner) return c.json({ error: 'A valid token is required. Create one on the You screen.' }, 401);
    c.set('sid', owner.studentId);
    c.set('scopes', owner.scopes);
    await next();
  });

  const need = (c: Context<Vars>, scope: ApiScope) => (c.get('scopes').includes(scope) ? undefined : c.json({ error: `This token does not have the ${scope} scope.` }, 403));
  const body = async <T>(c: Context<Vars>, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; res: Response }> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false, res: c.json({ error: 'The body must be JSON.' }, 400) };
    }
    const r = schema.safeParse(raw);
    return r.success ? { ok: true, value: r.data } : { ok: false, res: c.json({ error: 'The body does not match the schema.', issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 422) };
  };

  api.get('/v1/me', (c) => need(c, 'read') ?? (() => { const s = a.student(c.get('sid')); return c.json({ id: s.id, chosenName: s.chosenName, pronouns: s.pronouns, college: s.enrollment.college, dial: s.dial }); })());
  api.get('/v1/today', (c) => need(c, 'read') ?? c.json(a.today_(c.get('sid'))));
  api.get('/v1/deadlines', (c) => need(c, 'read') ?? c.json(a.deadlines(c.get('sid'))));
  api.post('/v1/deadlines', async (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    const b = await body(c, DeadlineIn);
    if (!b.ok) return b.res;
    const d = a.addDeadline(c.get('sid'), { ...b.value, kind: b.value.kind ?? 'other', source: { type: 'student', ref: 'api' }, confirmed: true });
    await a.emit(c.get('sid'), 'deadline.added', { id: d.id });
    return c.json(d, 201);
  });
  api.post('/v1/syllabus', async (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    const b = await body(c, SyllabusIn);
    if (!b.ok) return b.res;
    const r = a.uploadSyllabus(c.get('sid'), b.value.course, b.value.text, b.value.termStart ?? `${a.today_(c.get('sid')).date.slice(0, 4)}-08-24`);
    return c.json({ deadlines: r.deadlines, aiPolicy: r.aiPolicy, note: 'Dates are unconfirmed until the student checks them.' }, 201);
  });
  api.post('/v1/calendar', async (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    const b = await body(c, CalendarIn);
    if (!b.ok) return b.res;
    return c.json({ deadlines: a.addCalendarFeed(c.get('sid'), b.value.ics, b.value.course) }, 201);
  });
  api.get('/v1/shifts', (c) => need(c, 'read') ?? c.json(a.shifts(c.get('sid'))));
  api.post('/v1/shifts', async (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    const b = await body(c, ShiftsIn);
    if (!b.ok) return b.res;
    const sid = c.get('sid');
    const parsed = 'text' in b.value ? parseShifts(b.value.text, a.today_(sid).date) : { shifts: b.value.shifts, unread: [] as string[] };
    a.addShifts(sid, parsed.shifts);
    return c.json({ added: parsed.shifts, unread: parsed.unread }, 201);
  });
  api.post('/v1/inbound/email', async (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    const b = await body(c, EmailIn);
    if (!b.ok) return b.res;
    const r = a.forward(c.get('sid'), b.value.text, { from: b.value.from, subject: b.value.subject });
    if (r.refused) return c.json({ error: 'Forwarding is turned off for this student.' }, 409);
    const d = r.message ? a.deliver(r.message) : undefined;
    return c.json({ kind: r.item.kind, message: d ? { id: d.id, status: d.status } : null }, 202);
  });
  api.put('/v1/money', async (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    const b = await body(c, MoneyIn);
    if (!b.ok) return b.res;
    a.setMoney(c.get('sid'), b.value.balance, b.value.bills, b.value.pay);
    const gap = a.moneyCheck(c.get('sid'));
    if (gap) await a.emit(c.get('sid'), 'money.gap', {});
    return c.json({ gap: !!gap });
  });
  api.get('/v1/eligibility', (c) => need(c, 'read') ?? c.json(a.screen(c.get('sid'))));
  api.get('/v1/messages', (c) => need(c, 'read') ?? c.json(a.messages(c.get('sid')).map(({ id, at, author, text, nextSteps, status }) => ({ id, at, author, text, nextSteps, status }))));
  api.post('/v1/actions', async (c) => {
    const denied = need(c, 'actions');
    if (denied) return denied;
    const b = await body(c, ActionIn);
    if (!b.ok) return b.res;
    if (b.value.action.startsWith('delete-account')) return c.json({ error: 'Deleting an account is only possible in the app.' }, 403);
    const r = a.perform(c.get('sid'), b.value.action);
    if (!r) return c.json({ error: 'No such action.' }, 404);
    const d = a.deliver(r.message, { force: true });
    return c.json({ message: { id: d.id, text: d.text, nextSteps: d.nextSteps }, view: r.view ?? null });
  });
  api.get('/v1/export', (c) => {
    const denied = need(c, 'read');
    if (denied) return denied;
    const all = a.exportData(c.get('sid'));
    delete (all as Record<string, unknown>).api_tokens;
    delete (all as Record<string, unknown>).webhooks;
    return c.json(all);
  });
  api.get('/v1/export/:file', (c) => {
    const denied = need(c, 'read');
    if (denied) return denied;
    const name = c.req.param('file').replace(/\.csv$/, '');
    if (!(CSV_COLLECTIONS as readonly string[]).includes(name)) return c.json({ error: `Exportable as CSV: ${CSV_COLLECTIONS.join(', ')}.` }, 404);
    const rows = a.store.list<Record<string, unknown>>(name, c.get('sid'));
    return c.body(csv(rows), 200, { 'content-type': 'text/csv; charset=utf-8' });
  });
  api.get('/v1/calendar.ics', (c) => need(c, 'read') ?? c.body(a.calendarFeed(c.get('sid')), 200, { 'content-type': 'text/calendar; charset=utf-8' }));
  api.get('/v1/webhooks', (c) => need(c, 'read') ?? c.json(a.webhooks(c.get('sid'))));
  api.post('/v1/webhooks', async (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    const b = await body(c, WebhookIn);
    if (!b.ok) return b.res;
    try {
      return c.json(a.addWebhook(c.get('sid'), b.value.url, b.value.events), 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });
  api.delete('/v1/webhooks/:id', (c) => {
    const denied = need(c, 'write');
    if (denied) return denied;
    a.removeWebhook(c.get('sid'), c.req.param('id'));
    return c.body(null, 204);
  });

  return api;
}
