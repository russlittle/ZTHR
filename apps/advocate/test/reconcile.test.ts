// Verifies docs/testing/patterns.md
import { describe, expect, it } from 'vitest';
import { Advocate } from '../src/agents/advocate.js';
import { createApp } from '../src/server/app.js';
import { PERSONAS, PERSONA_NAMES } from '../src/server/demo.js';

/**
 * Diversity of representation (Pattern 22). The same facts read five ways must agree: the store, the API, the
 * exported file, the calendar feed and the screen. A bug that hides in one reading shows up as a disagreement.
 */
async function readings(name: string) {
  const a = new Advocate({ today: () => '2026-11-02', now: () => new Date('2026-11-02T15:00:00Z') });
  const s = PERSONAS[name]!(a);
  a.addDeadline(s.id, { title: 'Lab report 3', course: 'BIO 1111', due: '2026-11-06', kind: 'assignment', source: { type: 'student' }, confirmed: true });
  a.addDeadline(s.id, { title: 'Unconfirmed quiz', course: 'MAT 1130', due: '2026-11-09', kind: 'exam', source: { type: 'syllabus', line: 'Quiz Nov 9' }, confirmed: false });
  const app = createApp(a, {});
  const token = a.issueApiToken(s.id, 'reconcile', ['read']);
  const h = { authorization: `Bearer ${token}` };
  const store = a.deadlines(s.id);
  const api = (await (await app.request('/api/v1/deadlines', { headers: h })).json()) as { id: string; title: string; due: string; confirmed: boolean }[];
  const exported = ((await (await app.request('/api/v1/export', { headers: h })).json()) as { deadlines?: { id: string }[]; collections?: Record<string, { id: string }[]> });
  const ics = await (await app.request('/api/v1/calendar.ics', { headers: h })).text();
  const screen = await (await app.request(`/s/${s.id}/dates`)).text();
  return { a, s, store, api, exported, ics, screen };
}

describe('the same facts, read five ways (Pattern 22)', () => {
  for (const name of PERSONA_NAMES) {
    it(`${name}: store, API, export, calendar feed and screen agree on every date`, async () => {
      const { store, api, exported, ics, screen } = await readings(name);
      expect(api.map((d) => d.id).sort()).toEqual(store.map((d) => d.id).sort());
      for (const d of store) {
        const viaApi = api.find((x) => x.id === d.id)!;
        expect(viaApi.due).toBe(d.due);
        expect(viaApi.confirmed).toBe(d.confirmed);
      }
      const exportedIds = JSON.stringify(exported);
      for (const d of store) expect(exportedIds).toContain(d.id);
      const confirmed = store.filter((d) => d.confirmed && !d.done);
      for (const d of confirmed) {
        expect(ics, `${d.title} in the calendar feed`).toContain(d.title);
        expect(screen, `${d.title} on the dates screen`).toContain(d.title.replace(/&/g, '&amp;'));
      }
      for (const d of store.filter((x) => !x.confirmed)) expect(ics, `${d.title} is unconfirmed, so not in the feed`).not.toContain(d.title);
    });
  }
});
