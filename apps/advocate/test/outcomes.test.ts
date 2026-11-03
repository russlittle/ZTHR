// Verifies docs/flows/outcomes.md
import { describe, expect, it } from 'vitest';
import { routedEgress } from '@zthr/egress';
import { startAll } from '../../campus-services/src/index.js';
import { Advocate } from '../src/agents/advocate.js';
import { MIN_CELL, outcomes } from '../src/domain/outcomes.js';
import { createApp } from '../src/server/app.js';
import { PERSONAS, PERSONA_NAMES } from '../src/server/demo.js';

const byId = (o: ReturnType<typeof outcomes>, id: string) => o.measures.find((m) => m.id === id)!;

/** Two weeks of a term for all twelve students, with what they did recorded as they did it. */
async function term() {
  let now = new Date('2026-11-02T17:00:00Z');
  let today = '2026-11-02';
  const a = new Advocate({ today: () => today, now: () => now, egress: routedEgress(startAll()) });
  for (const n of PERSONA_NAMES) PERSONAS[n]!(a);
  await a.operator.tick();
  const ids = a.studentIds();
  for (const [i, sid] of ids.entries()) {
    a.addDeadline(sid, { title: `Paper ${i}`, course: 'ENG 1101', due: '2026-11-05', kind: 'assignment', source: { type: 'student' }, confirmed: true });
    a.addDeadline(sid, { title: `Quiz ${i}`, course: 'MAT 1130', due: '2026-11-09', kind: 'exam', source: { type: 'student' }, confirmed: true });
    a.findHelp(sid, 'food');
    if (i % 3 === 0) a.findHelp(sid, 'academic');
  }
  // Two of every three students mark their paper done.
  for (const [i, sid] of ids.entries()) if (i % 3 !== 2) a.perform(sid, `mark-done:${a.deadlines(sid).find((d) => d.title === `Paper ${i}`)!.id}`);
  now = new Date('2026-11-12T17:00:00Z');
  today = '2026-11-12';
  return { a, ids };
}

describe('outcome measures (Phase 4)', () => {
  it('counts from the record: past dates done, searches that found a fit', async () => {
    const { a, ids } = await term();
    const o = outcomes(a, '2026-11-12');
    expect(o.students).toBe(12);
    const past = ids.flatMap((s) => a.deadlines(s)).filter((d) => d.confirmed && d.due < '2026-11-12');
    const done = past.filter((d) => d.done).length;
    expect(byId(o, 'deadlines-done')).toMatchObject({ numerator: done, denominator: past.length, value: Math.round((done / past.length) * 1000) / 10 });
    const searches = a.evidence.events('find_help');
    expect(byId(o, 'help-found')).toMatchObject({ numerator: searches.filter((e) => Number(e.data.options) > 0).length, denominator: searches.length });
  });
  it(`never shows a number for fewer than ${MIN_CELL} students`, async () => {
    const a = new Advocate({ today: () => '2026-11-12' });
    for (const n of PERSONA_NAMES.slice(0, MIN_CELL - 1)) PERSONAS[n]!(a);
    const o = outcomes(a, '2026-11-12');
    for (const m of o.measures.filter((x) => x.value !== 'not measured')) expect(m.value, m.id).toBe('suppressed');
  });
  it('a measure with fewer than five in its own group is suppressed even when there are many students', async () => {
    const { a } = await term();
    const o = outcomes(a, '2026-11-12');
    expect(byId(o, 'rooms-confirmed').value).toBe('suppressed');
  });
  it('persistence and credits are not measured, never estimated', async () => {
    const { a } = await term();
    const o = outcomes(a, '2026-11-12');
    expect(byId(o, 'persistence').value).toBe('not measured');
    expect(byId(o, 'credits').value).toBe('not measured');
    expect(o.measures.every((m) => m.how.length > 20 && m.limits.length > 10)).toBe(true);
  });
  it('is on the API without a token, as aggregates only', async () => {
    const { a } = await term();
    const app = createApp(a, {});
    const r = await app.request('/api/outcomes');
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toMatch(/maria|jayden|Maria|"id":"(maria|jayden)"/);
    expect(JSON.parse(body).students).toBe(12);
  });
  it('is on the admin screen', async () => {
    const { a } = await term();
    const html = await (await createApp(a, {}).request('/admin/outcomes')).text();
    expect(html).toMatch(/Past dates marked done/);
    expect(html).toMatch(/not measured/);
  });
});
