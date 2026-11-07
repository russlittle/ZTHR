// Verifies docs/testing/robustness.md
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Hono } from 'hono';
import type { Egress } from '@zthr/egress';
import { routedEgress } from '@zthr/egress';
import { SERVICES, SERVICE_IDS, startAll } from '../../campus-services/src/index.js';
import { Advocate } from '../src/agents/advocate.js';
import { createApp } from '../src/server/app.js';
import { PERSONAS, PERSONA_NAMES } from '../src/server/demo.js';
import { currentGrade, gpa, pace, parseWeights, sap, type Gradebook, type TranscriptCourse } from '../src/domain/academics.js';
import { r2t4 } from '../src/domain/r2t4.js';
import { collegeById } from '../src/domain/colleges.js';

/**
 * Robustness, as evidence. Inputs are generated, not hand-picked: any text a student can send, any form a browser
 * can post, any JSON a client can send, any action name. Campus services fail in every way they can. Nothing may
 * crash, answer 500, or show the student a programming artifact; every answer still offers a next step.
 */
const DAY = '2026-11-02';
const GARBAGE = /\bundefined\b|\bNaN\b|\[object Object\]|TypeError|ReferenceError|at .+\.ts:\d+/;
/** Names every JavaScript object inherits; user input must never reach them through a lookup. */
const PROTO = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'prototype', 'isPrototypeOf'];
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const anyText = fc.oneof(fc.string({ maxLength: 400 }), fc.fullUnicodeString({ maxLength: 200 }), fc.constantFrom('', ' ', '\u0000', '<script>alert(1)</script>', "'; DROP TABLE docs; --", '%00%0d%0a', '𝓗𝓮𝓵𝓵𝓸', 'a'.repeat(5000), 'I got 999 out of 0 on exam in BIO 1111', 'drop ZZZ 9999', 'what do I need on the final in CHM 1210 to get an A+++'));

function world() {
  const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`) });
  const ids = PERSONA_NAMES.map((n) => PERSONAS[n]!(a).id);
  const app = new Hono().route('/sa', createApp(a, { base: '/sa' }));
  return { a, ids, app };
}

describe('generated input never breaks anything', () => {
  const { a, ids, app } = world();

  it('any text, by any student, gets a plain answer with a next step', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ids), anyText, (sid, text) => {
        const out = a.converse(sid, text);
        expect(out.length).toBeGreaterThan(0);
        for (const m of out) {
          expect(m.text).not.toMatch(GARBAGE);
          if (m.urgency !== 'safety') expect(m.nextSteps.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('any action name or argument either runs or is refused, never throws', () => {
    const verbs = ['today', 'school', 'final-need', 'drop', 'aid-progress', 'degree', 'advisor-share', 'start-playbook', 'playbook', 'approve', 'need', 'start-resource', 'dial', 'mark-done', 'hold', 'share', 'show-draft'];
    fc.assert(
      fc.property(fc.constantFrom(...ids), fc.oneof(fc.constantFrom(...verbs), fc.constantFrom(...PROTO), fc.string({ maxLength: 20 })), fc.oneof(fc.constantFrom(...PROTO), fc.string({ maxLength: 60 })), (sid, verb, arg) => {
        const r = a.perform(sid, `${verb}:${arg}`);
        if (r) expect(r.message.text).not.toMatch(GARBAGE);
      }),
      { numRuns: RUNS },
    );
  });

  it('any form posted to any screen answers below 500', async () => {
    const routes = ['/say', '/syllabus', '/shifts', '/household', '/score', '/school/drop/pick', '/advisor', '/advisor/off', '/letter', '/action'];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ids), fc.constantFrom(...routes), fc.dictionary(fc.constantFrom('text', 'course', 'title', 'score', 'outOf', 'size', 'income', 'work', 'label', 'scopes', 'days', 'id', 'action', 'shifts', 'syllabus', 'letter'), fc.oneof(anyText, fc.constantFrom(...PROTO)), { maxKeys: 6 }), async (sid, route, form) => {
        const r = await app.request(`/sa/s/${sid}${route}`, { method: 'POST', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        expect(r.status).toBeLessThan(500);
        expect(await r.text()).not.toMatch(/TypeError|ReferenceError|at .+\.ts:\d+/);
      }),
      { numRuns: RUNS },
    );
  });

  it('any JSON sent to the integration API answers below 500', async () => {
    const token = a.issueApiToken(ids[0]!, 'fuzz', ['read', 'write', 'actions']);
    const json = fc.jsonValue({ maxDepth: 3 });
    const writes: [string, string][] = [['POST', '/v1/deadlines'], ['POST', '/v1/syllabus'], ['POST', '/v1/calendar'], ['POST', '/v1/shifts'], ['POST', '/v1/inbound/email'], ['PUT', '/v1/money'], ['POST', '/v1/actions'], ['POST', '/v1/webhooks']];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...writes), fc.oneof(json, fc.string({ maxLength: 200 })), async ([method, path], body) => {
        const r = await app.request(`/sa/api${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
        expect(r.status).toBeLessThan(500);
      }),
      { numRuns: RUNS },
    );
  });

  it('a page for a student who does not exist answers below 500', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), fc.constantFrom('', '/school', '/money', '/advisor', '/week'), async (sid, p) => {
        const r = await app.request(`/sa/s/${encodeURIComponent(sid)}${p}`);
        expect(r.status).toBeLessThan(500);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('the rules hold for every input, not just the examples', () => {
  const letter = fc.constantFrom<TranscriptCourse['grade']>('A', 'B', 'C', 'D', 'F', 'W', 'I', 'P', 'TR');
  const course = fc.record({ course: fc.constantFrom('A 1', 'B 2', 'C 3', 'D 4', 'E 5'), credits: fc.integer({ min: 1, max: 6 }), grade: letter, term: fc.constantFrom('Fall 2025', 'Spring 2026') });
  it('GPA is between 0 and 4, pace between 0% and 100%, and earned never exceeds attempted', () => {
    fc.assert(
      fc.property(fc.array(course, { maxLength: 30 }), (t) => {
        const g = gpa(t).gpa;
        const p = pace(t);
        if (g !== undefined) expect(g >= 0 && g <= 4).toBe(true);
        expect(p.earned).toBeLessThanOrEqual(p.attempted);
        if (p.rate !== undefined) expect(p.rate >= 0 && p.rate <= 100).toBe(true);
        const r = sap(t, collegeById('wright-state')!.academic!.sap, 120);
        expect(r.meets).toBe(r.checks.every((c) => c.meets !== false));
      }),
      { numRuns: RUNS * 2 },
    );
  });
  it('the withdrawal estimate always balances: earned plus unearned is all aid, and earned only grows with time', () => {
    const period = { start: '2026-08-24', end: '2026-12-12', breaks: [{ from: '2026-11-25', to: '2026-11-29' }] };
    const day = fc.integer({ min: 0, max: 120 }).map((n) => new Date(Date.parse('2026-08-20T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10));
    const money = fc.integer({ min: 0, max: 800_000 }).map((c) => c / 100);
    fc.assert(
      fc.property(day, day, money, money, money, money, (d1, d2, pell, sub, unsub, charges) => {
        const [x, y] = d1 <= d2 ? [d1, d2] : [d2, d1];
        const r1 = r2t4(period, x, { pell, subsidized: sub, unsubsidized: unsub }, charges);
        const r2 = r2t4(period, y, { pell, subsidized: sub, unsubsidized: unsub }, charges);
        expect(Math.abs(r1.earned + r1.unearned - r1.aidDisbursed)).toBeLessThan(0.011);
        expect(r1.percentCompleted >= 0 && r1.percentCompleted <= 1).toBe(true);
        expect(r2.earned).toBeGreaterThanOrEqual(r1.earned - 0.011);
        expect(r1.schoolReturns).toBeLessThanOrEqual(r1.unearned + 0.011);
        expect(r1.studentGrantReturn === 0 || r1.studentGrantReturn > 50).toBe(true);
      }),
      { numRuns: RUNS * 2 },
    );
  });
  it('a grade is a weighted average of the graded work, so it stays between the lowest and highest category', () => {
    const cat = fc.record({ name: fc.constantFrom('Exams', 'Labs', 'Quizzes', 'Final'), weight: fc.integer({ min: 1, max: 60 }) });
    fc.assert(
      fc.property(fc.uniqueArray(cat, { selector: (c) => c.name, minLength: 1, maxLength: 4 }), fc.array(fc.tuple(fc.nat(3), fc.nat(100), fc.integer({ min: 1, max: 100 })), { maxLength: 12 }), (cats, raw) => {
        const items = raw.map(([i, sc, of]) => ({ category: cats[i % cats.length]!.name, title: 't', score: Math.min(sc, of), outOf: of }));
        const g: Gradebook = { course: 'X 1', credits: 3, source: 'student', categories: cats, items };
        const cg = currentGrade(g);
        if (!items.length) {
          expect(cg).toBeUndefined();
          return;
        }
        const pcts = cats.map((c) => items.filter((i) => i.category === c.name)).filter((xs) => xs.length).map((xs) => (xs.reduce((n, i) => n + i.score, 0) / xs.reduce((n, i) => n + i.outOf, 0)) * 100);
        expect(cg!.percent).toBeGreaterThanOrEqual(Math.min(...pcts) - 0.05);
        expect(cg!.percent).toBeLessThanOrEqual(Math.max(...pcts) + 0.05);
      }),
      { numRuns: RUNS * 2 },
    );
  });
  it('reading syllabus weights never throws, and what it returns adds up to 100', () => {
    fc.assert(fc.property(fc.string({ maxLength: 500 }), (t) => { const w = parseWeights(t); if (w.length) expect(Math.round(w.reduce((n, c) => n + c.weight, 0))).toBeGreaterThanOrEqual(99); }), { numRuns: RUNS });
  });
});

describe('when campus services fail, every screen still answers plainly', () => {
  type Fault = 'error' | 'down' | 'garbled' | 'empty' | 'slow';
  const FAULTS: Fault[] = ['error', 'down', 'garbled', 'empty', 'slow'];
  const faulty = (broken: string, fault: Fault): Egress => {
    const healthy = routedEgress(startAll());
    return {
      log: healthy.log,
      async send(req) {
        if (new URL(req.url).host !== broken) return healthy.send(req);
        if (fault === 'down' || fault === 'slow') throw new Error(fault === 'down' ? 'connect ECONNREFUSED' : 'The operation was aborted due to timeout');
        if (fault === 'error') return { status: 503, body: 'Service Unavailable' };
        if (fault === 'garbled') return { status: 200, body: '{"items": [{"id": 7, "name": null, "opens": "half past never"' };
        return { status: 200, body: '{}' };
      },
    };
  };
  const SCREENS = ['', '/money', '/school', '/school/drop', '/help', '/you', '/week', '/meals'];
  for (const id of SERVICE_IDS) {
    it(`${SERVICES[id].info.title}: ${FAULTS.join(', ')}`, async () => {
      for (const fault of FAULTS) {
        const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`), egress: faulty(SERVICES[id].host, fault) });
        const sids = ['Maria', 'Jayden', 'Destiny'].map((n) => PERSONAS[n]!(a).id);
        await a.operator.tick();
        const app = createApp(a);
        for (const sid of sids) {
          for (const p of SCREENS) {
            const r = await app.request(`/s/${sid}${p}`);
            expect(r.status, `${fault} ${p}`).toBe(200);
            expect(await r.text()).not.toMatch(GARBAGE);
          }
          for (const q of ["what's open to eat", 'next bus', 'study spots', 'jobs that fit my week', 'find a mentor']) {
            const [m] = a.converse(sid, q);
            expect(m!.text).not.toMatch(GARBAGE);
            expect(m!.nextSteps.length).toBeGreaterThan(0);
          }
        }
      }
    }, 60_000);
  }
});

describe('a copy restores exactly', () => {
  it('every student\'s export is identical after a snapshot and restore', () => {
    const { a, ids } = world();
    a.converse(ids[0]!, 'I got 20 out of 25 on lab report 5 in BIO 1111');
    a.createShare(ids[0]!, 'Advisor', ['school'], 7);
    const b = a.fork();
    for (const id of ids) expect(b.store.exportStudent(id)).toEqual(a.store.exportStudent(id));
    expect(b.ledger.entries(ids[0]!).length).toBe(a.ledger.entries(ids[0]!).length);
  });
});
