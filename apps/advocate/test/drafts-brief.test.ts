// Verifies docs/flows/careers.md
import { describe, expect, it } from 'vitest';
import { ACTIONS } from '../src/agents/actions.js';
import { COLLEGES } from '../src/domain/colleges.js';
import { TERMS } from '../src/domain/college.js';
import { checkTone } from '../src/domain/tone.js';
import { makeAdvocate, maria } from './helpers.js';
import { applyCampus, campusSeedDocs } from './harness/campus.js';

/**
 * Every draft the Advocate offers, for every job posting at every college, as a student with a long name who asked
 * for brief answers: each must pass the tone rubric for brief mode. The nightly full walk found the fair-chance job
 * draft at 328 to 343 characters against brief mode's 320, held by the tone gate, on paths the quick walks never
 * reach; this checks every draft directly instead.
 */
describe('every draft fits brief mode', () => {
  for (const depth of ['brief', 'standard', 'walk-me-through'] as const) {
    it(`at ${depth}, for every posting at every college, and every other kind of draft`, async () => {
      const a = makeAdvocate();
      const seed = await campusSeedDocs();
      const first = maria(a, { chosenName: 'Seed', phone: '+19375554999' });
      applyCampus(a, first.id, seed);
      const purposes: [string, string][] = [];
      for (const c of COLLEGES) {
        const feed = a.campusFeed(c.college);
        for (const p of feed?.postings ?? []) purposes.push([c.college, `job:${p.id}`]);
      }
      expect(purposes.length).toBeGreaterThan(5);
      for (const t of TERMS) purposes.push(['sinclair', `ask:${t.term}`]);
      purposes.push(['sinclair', 'career'], ['sinclair', `late:${encodeURIComponent('Introduction to Anatomy and Physiology II')}`], ['sinclair', `letter:${encodeURIComponent('Montgomery County Job and Family Services')}`], ['sinclair', 'aid-office']);
      const students = new Map<string, string>();
      const failures: string[] = [];
      for (const [college, purpose] of purposes) {
        if (!students.has(college)) {
          const s = maria(a, { chosenName: 'Christopher-Alexander', phone: `+1937555${4000 + students.size}`, enrollment: { college, creditHours: 12 } });
          a.setDial(s.id, { depth });
          students.set(college, s.id);
        }
        const sid = students.get(college)!;
        const m = ACTIONS.draft!(a, sid, purpose).message;
        const r = checkTone(m, depth, a.student(sid).dial.readingGrade ?? 8);
        if (!r.ok) failures.push(`${college} ${purpose}: ${r.problems.join('; ')} (${m.text.length})`);
        expect(m.text).toMatch(/send|sent/i);
      }
      expect(failures).toEqual([]);
    }, 120_000);
  }
});
