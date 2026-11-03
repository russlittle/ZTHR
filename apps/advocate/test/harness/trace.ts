import { Hono } from 'hono';
import { routedEgress, type Egress, type EgressRequest } from '@zthr/egress';
import { canary, leaks, trace, unexercised, type Canary, type Finding, type FlowPolicy } from '@zthr/privacy';
import { startAll } from '../../../campus-services/src/index.js';
import { Advocate } from '../../src/agents/advocate.js';
import { createApp } from '../../src/server/app.js';

/**
 * The sensitive-data trace (docs/flows/sensitive-data.md). A student is created with a unique marker in every
 * personal, sensitive and secret field the app takes in, then uses the app the way a student would: by text,
 * on the web, through the API, with a mentor introduction sent and a webhook registered. Every place data can
 * land is then searched for every marker. The policy below is the declaration of where each class may go.
 */
export const SINKS = ['store', 'sealed store', 'consent ledger', 'evidence', 'student export', 'student API', 'student screens', 'texts to the student', 'calendar feed', 'sent with approval', 'network: campus services', 'network: webhooks', 'app admin', 'outcomes', 'server logs'] as const;
export type Sink = (typeof SINKS)[number];

const OWN: Sink[] = ['store', 'student export', 'student API', 'student screens', 'texts to the student'];
export const POLICY: FlowPolicy = {
  public: [...SINKS],
  internal: [...SINKS],
  // Personal facts go back to the student, and on to someone else only with the student's approval of the exact text.
  personal: [...OWN, 'calendar feed', 'sent with approval'],
  // Sensitive facts go only back to the student.
  sensitive: [...OWN],
  // Secrets are stored only hashed or encrypted and are never shown, not even to their owner.
  secret: [],
};

const DAY = '2026-11-03';
const NOW = new Date(`${DAY}T14:00:00Z`);

/** A recording door to the network: routes to the synthetic campus services, and keeps every request whole. */
function recordingEgress(): { egress: Egress; sent: EgressRequest[] } {
  const inner = routedEgress({ ...startAll(), 'hooks.example.com': { fetch: () => new Response('{}') } });
  const sent: EgressRequest[] = [];
  return { sent, egress: { log: inner.log, send: (req) => (sent.push(req), inner.send(req)) } };
}

export interface TraceResult {
  at: string;
  canaries: Canary[];
  findings: Finding[];
  leaks: Finding[];
  /** Planted but seen nowhere, though the field should have appeared somewhere: the run did not exercise it. */
  unexercised: string[];
  /** Sealed facts and secrets, which must be seen nowhere in plain text (beyond any declared exception). */
  sealedNowhere: string[];
  sinks: readonly string[];
  policy: FlowPolicy;
}

export async function runTrace(): Promise<TraceResult> {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...xs: unknown[]) => void logs.push(xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    return await session(logs);
  } finally {
    Object.assign(console, orig);
  }
}

async function session(logs: string[]): Promise<TraceResult> {
  const C = {
    name: canary('students.chosenName', 'personal', 'word', ['network: campus services']),
    phone: canary('students.phone', 'personal', 'digits'),
    pronouns: canary('students.pronouns', 'sensitive'),
    goal: canary('students.goal', 'personal'),
    income: { field: 'students.household.monthlyGrossIncome', cls: 'sensitive' as const, value: '1987.61' },
    room: canary('classes.room', 'personal'),
    employer: canary('shifts.employer', 'personal'),
    deadline: canary('deadlines.title', 'personal'),
    reminder: canary('reminders.text', 'personal'),
    attendee: canary('meetings.attendees', 'personal'),
    bill: canary('money.bills', 'sensitive'),
    balance: { field: 'money.balance', cls: 'sensitive' as const, value: '413.29' },
    docName: canary('vault.name', 'sensitive'),
    docBody: canary('sealed: doc contents', 'sensitive'),
    justice: canary('sealed: justice_involvement', 'sensitive'),
    lmsToken: canary('sealed: class_site_token', 'secret', 'word', ['network: campus services']),
    tokenLabel: canary('api_tokens.label', 'personal'),
    hookPath: canary('webhooks.url', 'personal', 'word', ['network: webhooks']),
    note: canary('drafts.body (mentor note)', 'personal', 'word', ['network: campus services']),
  };
  const { egress, sent } = recordingEgress();
  const a = new Advocate({ today: () => DAY, now: () => NOW, egress });
  const s = a.createStudent({
    chosenName: C.name.value,
    zip: '45402',
    phone: `+1${C.phone.value}`,
    pronouns: C.pronouns.value,
    goal: `become a ${C.goal.value} nurse`,
    age: 29,
    household: { size: 3, monthlyGrossIncome: Number(C.income.value), monthlyEarnedIncome: Number(C.income.value), childrenUnder6: 1, childrenUnder12: 1, singleParent: true },
    enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 25, workStudy: false },
  });
  const sid = s.id;
  a.addClasses(sid, [{ course: 'BIO 1111', days: ['Tue', 'Thu'], start: '10:00', end: '11:15', building: 'Building 3', room: C.room.value }]);
  a.addShifts(sid, [{ date: '2026-11-05', start: '15:00', end: '21:00', employer: C.employer.value }]);
  const d = a.addDeadline(sid, { title: `${C.deadline.value} lab report`, due: '2026-11-10', kind: 'assignment', source: { kind: 'typed', line: 'typed' }, confirmed: true } as never);
  a.remind(sid, d.id, '2026-11-09', `Finish the ${C.reminder.value} part`);
  a.addMeeting(sid, { title: 'Study group', date: '2026-11-06', start: '16:00', attendees: [C.attendee.value] });
  a.setMoney(sid, Number(C.balance.value), [{ name: `${C.bill.value} electric`, amount: 120, due: '2026-11-15' }] as never);
  a.addDocument(sid, `${C.docName.value} lease`, `lease text ${C.docBody.value}`);
  a.seal(sid, 'justice_involvement', C.justice.value);
  a.connectClassSite(sid, C.lmsToken.value);

  // Every screen and every API answer the student can reach.
  const app = new Hono({ strict: false }).route('/advocate', createApp(a, { base: '/advocate' }));
  const page = async (p: string) => (await app.request(`/advocate${p}`)).text();
  const token = a.issueApiToken(sid, `${C.tokenLabel.value} sync`, ['read', 'write', 'actions']);
  const apiToken: Canary = { field: 'api token (issued)', cls: 'secret', value: token };
  const api = async (method: string, p: string, body?: unknown) => (await app.request(`/advocate/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).text();

  await a.operator.tick(NOW);
  const hook = await api('POST', '/v1/webhooks', { url: `https://hooks.example.com/${C.hookPath.value}`, events: ['*'] });
  const hookSecret = a.store.list<{ secret: string }>('webhooks', sid)[0]?.secret;
  const secretCanary: Canary = { field: 'webhooks.secret', cls: 'secret', value: hookSecret ?? 'none', also: ['store'] };

  const texts: string[] = [];
  for (const t of ['hi', 'what is due', 'help with food', 'I need rent help', 'free food', 'next bus', 'jobs that fit', 'mentor']) texts.push(...a.converse(sid, t).map((m) => m.text));
  a.perform(sid, 'mentor-intro:m1');
  const draft = a.drafts(sid).find((x) => x.purpose.startsWith('mentor:'));
  if (draft) {
    a.store.put('drafts', draft.id, sid, { ...draft, body: `${draft.body} I am a ${C.note.value} student.` });
    await a.send(sid, draft.id, a.approve(sid, draft.id));
  }
  await a.operator.tick(new Date(NOW.getTime() + 3 * 3600_000));
  await api('POST', '/v1/deadlines', { title: 'Quiz', due: '2026-11-12' });

  const screens = (await Promise.all(['', '/week', '/dates', '/shifts', '/money', '/help', '/meals', '/drafts', '/you', '/ask', '/letter', '/share', '/syllabus'].map((p) => page(`/s/${sid}${p}`)))).join('\n');
  const apis = (await Promise.all(['/v1/me', '/v1/today', '/v1/deadlines', '/v1/shifts', '/v1/eligibility', '/v1/messages', '/v1/webhooks', '/v1/export/deadlines.csv'].map((p) => api('GET', p)))).join('\n') + hook;
  const admin = (await Promise.all(['/admin/', '/admin/catalog', '/admin/moderation', '/admin/proposals', '/admin/admissions', '/admin/outcomes', '/admin/scouts'].map(page))).join('\n');
  const outcomes = await page('/api/outcomes');
  const exportText = `${await api('GET', '/v1/export')}\n${await page(`/s/${sid}/export`)}`;
  const calendar = a.calendarFeed(sid);
  const ext = (prefix: string) => sent.filter((r) => r.purpose.startsWith(prefix)).map((r) => `${r.method} ${r.url} ${JSON.stringify(r.headers ?? {})} ${r.body ?? ''}`).join('\n');

  const sinks: Record<Sink, string> = {
    store: a.store.dump(),
    'sealed store': JSON.stringify(a.sealed.dump()),
    'consent ledger': JSON.stringify(a.ledger.dump()),
    evidence: JSON.stringify(a.evidence.events()),
    'student export': exportText,
    'student API': apis,
    'student screens': screens,
    'texts to the student': [...texts, ...a.sms.outbox.map((m) => m.body)].join('\n'),
    'calendar feed': calendar,
    'sent with approval': JSON.stringify(a.outboundLog),
    'network: campus services': ext('campus:'),
    'network: webhooks': ext('webhook:'),
    'app admin': admin,
    outcomes,
    'server logs': logs.join('\n'),
  };
  const canaries: Canary[] = [...Object.values(C), apiToken, secretCanary];
  const findings = trace(canaries, sinks, POLICY);
  const sealedOrSecret = (c: Canary) => c.cls === 'secret' || c.field.startsWith('sealed:');
  const quiet = unexercised(canaries, findings);
  return { at: new Date().toISOString(), canaries, findings, leaks: leaks(findings), unexercised: quiet.filter((f) => !sealedOrSecret(canaries.find((c) => c.field === f)!)), sealedNowhere: quiet.filter((f) => sealedOrSecret(canaries.find((c) => c.field === f)!)), sinks: SINKS, policy: POLICY };
}
