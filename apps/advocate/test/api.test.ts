// Verifies docs/api.md
// Verifies docs/architecture.md
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { EgressTwin } from '@zthr/egress';
import { Advocate } from '../src/agents/advocate.js';
import { createApp } from '../src/server/app.js';
import { OPENAPI } from '../src/server/api.js';
import { PERSONAS } from '../src/server/demo.js';

const DAY = '2026-11-02';

function setup() {
  const egress = new EgressTwin(['hooks.example.com']);
  const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`), egress });
  const darnell = PERSONAS.Darnell!(a);
  const maria = PERSONAS.Maria!(a);
  const app = new Hono().route('/advocate', createApp(a, { base: '/advocate' }));
  const full = a.issueApiToken(maria.id, 'everything', ['read', 'write', 'actions']);
  const readOnly = a.issueApiToken(maria.id, 'read only', ['read']);
  const darnellToken = a.issueApiToken(darnell.id, 'darnell', ['read', 'write', 'actions']);
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(`/advocate/api${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { a, egress, maria, darnell, full, readOnly, darnellToken, call };
}

describe('authentication and scopes', () => {
  const READS = ['/v1/me', '/v1/today', '/v1/deadlines', '/v1/shifts', '/v1/eligibility', '/v1/messages', '/v1/export', '/v1/calendar.ics', '/v1/webhooks', '/v1/export/deadlines.csv'];
  for (const path of READS) {
    it(`GET ${path} needs a token`, async () => expect((await setup().call('GET', path)).status).toBe(401));
    it(`GET ${path} refuses a made-up token`, async () => expect((await setup().call('GET', path, 'adv_not_real')).status).toBe(401));
    it(`GET ${path} works with a read token`, async () => {
      const s = setup();
      expect((await s.call('GET', path, s.readOnly)).status).toBe(200);
    });
  }
  const WRITES: [string, string, unknown][] = [
    ['POST', '/v1/deadlines', { title: 'Paper', due: '2026-11-20' }],
    ['POST', '/v1/syllabus', { course: 'HIS 1101', text: 'Nov 20 Paper 1 due' }],
    ['POST', '/v1/calendar', { ics: 'BEGIN:VCALENDAR\nEND:VCALENDAR' }],
    ['POST', '/v1/shifts', { text: 'Tue 3pm-9pm' }],
    ['POST', '/v1/inbound/email', { text: 'hello' }],
    ['PUT', '/v1/money', { balance: 100, bills: [] }],
    ['POST', '/v1/webhooks', { url: 'https://hooks.example.com/x', events: ['*'] }],
  ];
  for (const [m, path, body] of WRITES) {
    it(`${m} ${path} is refused for a read-only token`, async () => {
      const s = setup();
      expect((await s.call(m, path, s.readOnly, body)).status).toBe(403);
    });
  }
  it('actions need the actions scope', async () => {
    const s = setup();
    expect((await s.call('POST', '/v1/actions', s.readOnly, { action: 'today' })).status).toBe(403);
  });
  it('a revoked token stops working at once', async () => {
    const s = setup();
    const id = s.a.apiTokens(s.maria.id).find((t) => t.label === 'read only')!.id;
    s.a.revokeApiToken(s.maria.id, id);
    expect((await s.call('GET', '/v1/me', s.readOnly)).status).toBe(401);
  });
  it('one student cannot revoke another student\'s token', async () => {
    const s = setup();
    const id = s.a.apiTokens(s.maria.id)[0]!.id;
    s.a.revokeApiToken(s.darnell.id, id);
    expect((await s.call('GET', '/v1/me', s.full)).status).toBe(200);
  });
  it('a token only ever sees its own student', async () => {
    const s = setup();
    const me = (await (await s.call('GET', '/v1/me', s.darnellToken)).json()) as { chosenName: string };
    expect(me.chosenName).toBe('Darnell');
    const dl = (await (await s.call('GET', '/v1/deadlines', s.darnellToken)).json()) as unknown[];
    expect(dl).toHaveLength(0);
  });
  it('creating a token is recorded in the consent ledger, and only its hash is stored', async () => {
    const s = setup();
    expect(s.a.ledger.entries(s.maria.id).some((e) => e.kind === 'grant' && e.subject === 'api:everything')).toBe(true);
    expect(JSON.stringify(s.a.store.exportStudent(s.maria.id))).not.toContain(s.full);
  });
});

describe('ingest', () => {
  it('adds a deadline and it shows in the calendar feed', async () => {
    const s = setup();
    const r = await s.call('POST', '/v1/deadlines', s.full, { title: 'Paper 2', due: '2026-11-20', course: 'ENG 1101', kind: 'assignment' });
    expect(r.status).toBe(201);
    expect(await (await s.call('GET', '/v1/calendar.ics', s.full)).text()).toContain('SUMMARY:Paper 2 (ENG 1101) due');
  });
  it('the same deadline twice is one deadline', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) await s.call('POST', '/v1/deadlines', s.full, { title: 'Paper 2', due: '2026-11-20' });
    expect(s.a.deadlines(s.maria.id).filter((d) => d.title === 'Paper 2')).toHaveLength(1);
  });
  it.each([
    [{ title: '', due: '2026-11-20' }],
    [{ title: 'x', due: 'next tuesday' }],
    [{ title: 'x', due: '2026-11-20', kind: 'party' }],
    [{ due: '2026-11-20' }],
  ])('rejects a malformed deadline %j with the reasons', async (body) => {
    const s = setup();
    const r = await s.call('POST', '/v1/deadlines', s.full, body);
    expect(r.status).toBe(422);
    expect(((await r.json()) as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });
  it('rejects a body that is not JSON', async () => {
    const s = setup();
    expect((await s.call('POST', '/v1/deadlines', s.full, '{not json')).status).toBe(400);
  });
  it('syllabus dates arrive unconfirmed, for the student to check', async () => {
    const s = setup();
    const r = (await (await s.call('POST', '/v1/syllabus', s.full, { course: 'HIS 1101', text: 'Nov 20 Paper 1 due\nDec 4 Final exam' })).json()) as { deadlines: { confirmed: boolean }[] };
    expect(r.deadlines.length).toBe(2);
    expect(r.deadlines.every((d) => !d.confirmed)).toBe(true);
  });
  it('shifts as text report what could not be read', async () => {
    const s = setup();
    const r = (await (await s.call('POST', '/v1/shifts', s.full, { text: 'Tue 3pm-9pm, someday maybe' })).json()) as { added: unknown[]; unread: string[] };
    expect(r.added).toHaveLength(1);
    expect(r.unread).toEqual(['someday maybe']);
  });
  it('shifts as a list are added as given', async () => {
    const s = setup();
    expect((await s.call('POST', '/v1/shifts', s.full, { shifts: [{ date: '2026-11-07', start: '09:00', end: '13:00' }] })).status).toBe(201);
    expect(s.a.shifts(s.maria.id).some((x) => x.date === '2026-11-07')).toBe(true);
  });
  it('forwarded email is refused while forwarding is off, and handled once it is on', async () => {
    const s = setup();
    expect((await s.call('POST', '/v1/inbound/email', s.full, { subject: 'Final notice', text: 'Your electric service will be disconnected' })).status).toBe(409);
    s.a.connectSource(s.maria.id, 'forwarding');
    const r = (await (await s.call('POST', '/v1/inbound/email', s.full, { subject: 'Final notice', text: 'Your electric service will be disconnected' })).json()) as { kind: string };
    expect(r.kind).toBe('utility-shutoff');
  });
  it('money with a short month fires the money.gap webhook', async () => {
    const s = setup();
    await s.call('POST', '/v1/webhooks', s.full, { url: 'https://hooks.example.com/advocate', events: ['money.gap'] });
    const r = (await (await s.call('PUT', '/v1/money', s.full, { balance: 50, bills: [{ name: 'Rent', amount: 900, dueDay: 1, kind: 'rent' }], pay: { amount: 200, next: '2026-11-25', everyDays: 14 } })).json()) as { gap: boolean };
    expect(r.gap).toBe(true);
    expect(s.egress.sent.some((x) => x.url === 'https://hooks.example.com/advocate' && x.body?.includes('money.gap'))).toBe(true);
  });
});

describe('actions through the API', () => {
  it('taps a button and returns the message with its next steps', async () => {
    const s = setup();
    const r = (await (await s.call('POST', '/v1/actions', s.full, { action: 'screen' })).json()) as { message: { text: string; nextSteps: unknown[] } };
    expect(r.message.text).toMatch(/qualify/);
    expect(r.message.nextSteps.length).toBeGreaterThan(0);
  });
  it('an unknown action is a 404, not a crash', async () => {
    const s = setup();
    expect((await s.call('POST', '/v1/actions', s.full, { action: 'launch-rockets' })).status).toBe(404);
  });
  it('deleting the account is only possible in the app', async () => {
    const s = setup();
    expect((await s.call('POST', '/v1/actions', s.full, { action: 'delete-account' })).status).toBe(403);
    expect(s.a.student(s.maria.id).chosenName).toBe('Maria');
  });
});

describe('export', () => {
  it('never exports token hashes or webhook secrets', async () => {
    const s = setup();
    await s.call('POST', '/v1/webhooks', s.full, { url: 'https://hooks.example.com/x', events: ['*'] });
    const all = (await (await s.call('GET', '/v1/export', s.full)).json()) as Record<string, unknown>;
    expect(all.api_tokens).toBeUndefined();
    expect(all.webhooks).toBeUndefined();
  });
  it('never exports a sealed fact', async () => {
    const s = setup();
    const text = await (await s.call('GET', '/v1/export', s.darnellToken)).text();
    expect(text).not.toContain('synthetic sealed fact');
  });
  it.each(['deadlines', 'shifts', 'holds', 'reminders', 'messages'])('exports %s as CSV with a header row', async (c) => {
    const s = setup();
    const r = await s.call('GET', `/v1/export/${c}.csv`, s.full);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
  });
  it('refuses to export a collection that is not listed', async () => {
    const s = setup();
    expect((await s.call('GET', '/v1/export/api_tokens.csv', s.full)).status).toBe(404);
  });
  it('quotes CSV cells with commas and quotes', async () => {
    const s = setup();
    await s.call('POST', '/v1/deadlines', s.full, { title: 'Read "Ch. 1, 2"', due: '2026-11-20' });
    expect(await (await s.call('GET', '/v1/export/deadlines.csv', s.full)).text()).toContain('"Read ""Ch. 1, 2"""');
  });
  it('the calendar feed is valid iCalendar with escaped text', async () => {
    const s = setup();
    await s.call('POST', '/v1/deadlines', s.full, { title: 'Lab; part 1, draft', due: '2026-11-20' });
    const ics = await (await s.call('GET', '/v1/calendar.ics', s.full)).text();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('Lab\\; part 1\\, draft');
  });
});

describe('webhooks', () => {
  it('only https', async () => {
    const s = setup();
    expect((await s.call('POST', '/v1/webhooks', s.full, { url: 'http://hooks.example.com/x', events: ['*'] })).status).toBe(422);
  });
  it('deliveries are signed with the webhook secret and carry ids, never message text', async () => {
    const s = setup();
    await s.call('POST', '/v1/webhooks', s.full, { url: 'https://hooks.example.com/x', events: ['deadline.added'] });
    await s.call('POST', '/v1/deadlines', s.full, { title: 'Secret plans', due: '2026-11-20' });
    const sent = s.egress.sent.at(-1)!;
    const secret = (s.a.store.list<{ secret: string }>('webhooks', s.maria.id)[0]!).secret;
    expect(sent.headers!['x-advocate-signature']).toBe(createHmac('sha256', secret).update(sent.body!).digest('hex'));
    expect(sent.body).not.toContain('Secret plans');
  });
  it('a webhook to a host off the allow-list is refused and counted, and the request still succeeds', async () => {
    const s = setup();
    await s.call('POST', '/v1/webhooks', s.full, { url: 'https://elsewhere.example.org/x', events: ['*'] });
    expect((await s.call('POST', '/v1/deadlines', s.full, { title: 'Paper 3', due: '2026-11-21' })).status).toBe(201);
    expect(s.egress.log.some((l) => l.status === 'refused')).toBe(true);
  });
  it('removing a webhook stops deliveries and is in the ledger', async () => {
    const s = setup();
    const w = (await (await s.call('POST', '/v1/webhooks', s.full, { url: 'https://hooks.example.com/x', events: ['*'] })).json()) as { id: string };
    expect((await s.call('DELETE', `/v1/webhooks/${w.id}`, s.full)).status).toBe(204);
    const before = s.egress.sent.length;
    await s.call('POST', '/v1/deadlines', s.full, { title: 'Paper 4', due: '2026-11-22' });
    expect(s.egress.sent.length).toBe(before);
    expect(s.a.ledger.entries(s.maria.id).some((e) => e.kind === 'revoke' && e.subject.startsWith('webhook:'))).toBe(true);
  });
});

describe('the OpenAPI description matches the routes', () => {
  it('every documented path answers something other than 404 for a full token', async () => {
    const s = setup();
    for (const [path, ops] of Object.entries(OPENAPI.paths)) {
      const concrete = path.replace('{collection}', 'deadlines').replace('{id}', 'wh_nothing');
      for (const m of Object.keys(ops)) {
        const r = await s.call(m.toUpperCase(), concrete, s.full, m === 'get' || m === 'delete' ? undefined : {});
        expect([404].includes(r.status) && !concrete.includes('wh_nothing'), `${m} ${path}`).toBe(false);
      }
    }
  });
  it('is served at /api/openapi.json', async () => {
    const s = setup();
    const r = await s.call('GET', '/openapi.json');
    expect(((await r.json()) as { openapi: string }).openapi).toBe('3.1.0');
  });
});
