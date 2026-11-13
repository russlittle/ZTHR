// Verifies docs/flows/resource-guide.md
// Verifies docs/api/guide.md
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DAYTON_CATALOG } from '../src/catalog/dayton.js';
import type { Resource } from '../src/catalog/types.js';
import { isFresh } from '../src/catalog/types.js';
import type { NeedCategory } from '../src/domain/types.js';
import * as B from '../src/guide/barriers.js';
import { admit, admitAll } from '../src/guide/admission.js';
import { coverage, Feed, feed, FeedService } from '../src/guide/feed.js';
import { helpScore, MIN_SHOWN, needsReview, recordLine, tally, type Outcome } from '../src/guide/feedback.js';
import { PACKAGES, packageFor } from '../src/guide/packages.js';
import { MAX, signals } from '../src/guide/signals.js';
import { BARRIER, BARRIERS, DOMAINS, PROVIDER_KINDS, SITUATION_LABEL } from '../src/guide/taxonomy.js';
import { PULSES } from '../src/domain/pulses.js';
import { Hono } from 'hono';
import { createApp } from '../src/server/app.js';
import { Advocate } from '../src/agents/advocate.js';
import { makeAdvocate, maria, TODAY } from './helpers.js';

const guideApp = () => new Hono().route('/advocate', createApp(makeAdvocate(), { base: '/advocate' }));

/**
 * The community resource guide (docs/flows/resource-guide.md). Property tests hold the barrier rules for every
 * sequence of events; the rest hold the catalog, packages, feed, signals and feedback to what the docs promise.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const scouts = readdirSync(join(ROOT, 'control/scouts'))
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => parse(readFileSync(join(ROOT, 'control/scouts', f), 'utf8')) as { scout: string; entries: string[]; needs: string[] });
const OWNERS = new Set(scouts.flatMap((s) => s.entries));
const NEEDS = BARRIERS.map((b) => b.id) as NeedCategory[];
const day = (n: number) => new Date(Date.parse('2026-11-02T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

type Ev = { kind: 'open'; need: NeedCategory; by: B.OpenedBy; urgency: B.Urgency } | { kind: 'start' | 'resolve' | 'not-today' | 'asked'; need: NeedCategory };
const need = fc.constantFrom(...NEEDS.slice(0, 6));
const event: fc.Arbitrary<Ev> = fc.oneof(
  fc.record({ kind: fc.constant('open' as const), need, by: fc.constantFrom<B.OpenedBy>('check-in', 'student', 'advocate'), urgency: fc.constantFrom<B.Urgency>('tonight', 'soon', 'someday') }),
  fc.record({ kind: fc.constantFrom('start' as const, 'resolve' as const, 'not-today' as const, 'asked' as const), need }),
);
const apply = (book: B.BarrierBook, e: Ev, today: string): B.BarrierBook => {
  switch (e.kind) {
    case 'open': return B.open(book, e.need, e.by, e.urgency, today);
    case 'start': return B.start(book, e.need, today);
    case 'resolve': return B.resolve(book, e.need, today);
    case 'not-today': return B.notToday(book, e.need, today);
    case 'asked': return B.asked(book, e.need, today);
  }
};
const RANK = { tonight: 0, soon: 1, someday: 2 } as const;

describe('barriers: the rules hold for every sequence of events', () => {
  const runs = { numRuns: 400 };

  it('only resolve closes a barrier', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (evs) => {
      let book = B.empty();
      evs.forEach((e, i) => {
        const before = B.find(book, e.need)?.status;
        book = apply(book, e, day(i));
        const after = B.find(book, e.need)?.status;
        if (after === 'resolved' && before !== 'resolved') expect(e.kind).toBe('resolve');
      });
    }), runs);
  });

  it('opening an open barrier never lowers its urgency', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (evs) => {
      let book = B.empty();
      evs.forEach((e, i) => {
        const before = B.find(book, e.need);
        book = apply(book, e, day(i));
        const after = B.find(book, e.need);
        if (before && before.status !== 'resolved' && after) expect(RANK[after.urgency]).toBeLessThanOrEqual(RANK[before.urgency]);
      });
    }), runs);
  });

  it('one entry per need, never duplicated, whatever happens', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 60 }), (evs) => {
      const book = evs.reduce((b, e, i) => apply(b, e, day(i)), B.empty());
      const needs = book.items.map((b) => b.need);
      expect(new Set(needs).size).toBe(needs.length);
    }), runs);
  });

  it('"not today" never closes anything and only quiets reminders until tomorrow', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 30 }), need, (evs, n) => {
      const book = evs.reduce((b, e, i) => apply(b, e, day(i)), B.empty());
      const t = day(evs.length);
      const before = B.find(book, n);
      const after = B.find(B.notToday(book, n, t), n);
      expect(after?.status).toBe(before?.status);
      if (after && after.status !== 'resolved') {
        expect(B.remindable(after, t)).toBe(false);
        expect(B.remindable(after, day(evs.length + 1))).toBe(true);
      }
    }), runs);
  });

  it('every change is in the history, in order, and history only grows', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (evs) => {
      let book = B.empty();
      evs.forEach((e, i) => {
        const before = B.find(book, e.need)?.history.length ?? 0;
        book = apply(book, e, day(i));
        const h = B.find(book, e.need)?.history ?? [];
        expect(h.length).toBeGreaterThanOrEqual(before);
        expect(h.map((x) => x.on)).toEqual([...h.map((x) => x.on)].sort());
      });
    }), runs);
  });

  it('active is exactly the unresolved barriers, most urgent first', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (evs) => {
      const book = evs.reduce((b, e, i) => apply(b, e, day(i)), B.empty());
      const act = B.active(book);
      expect(act.length).toBe(book.items.filter((b) => b.status !== 'resolved').length);
      for (let i = 1; i < act.length; i++) expect(RANK[act[i - 1]!.urgency]).toBeLessThanOrEqual(RANK[act[i]!.urgency]);
    }), runs);
  });

  it('a resolved barrier that comes back is reopened, with its history kept', () => {
    let book = B.open(B.empty(), 'housing', 'check-in', 'soon', day(0));
    book = B.resolve(book, 'housing', day(3));
    book = B.open(book, 'housing', 'student', 'someday', day(9));
    const b = B.find(book, 'housing')!;
    expect(b.status).toBe('open');
    expect(b.urgency).toBe('someday');
    expect(b.history.map((h) => h.event)).toEqual(['opened', 'resolved', 'reopened']);
    expect(book.items).toHaveLength(1);
  });

  it('a quiet barrier is asked about after a week, once, then not again for a week', () => {
    let book = B.open(B.empty(), 'food', 'check-in', 'soon', day(0));
    expect(B.dueForCheck(book, day(6))).toBeUndefined();
    expect(B.dueForCheck(book, day(7))?.need).toBe('food');
    book = B.asked(book, 'food', day(7));
    expect(B.dueForCheck(book, day(13))).toBeUndefined();
    expect(B.dueForCheck(book, day(14))?.need).toBe('food');
    expect(B.dueForCheck(B.resolve(book, 'food', day(14)), day(30))).toBeUndefined();
  });
});

describe('the taxonomy', () => {
  it('every barrier belongs to one of the five domains, with a plain label', () => {
    expect(DOMAINS).toHaveLength(5);
    for (const b of BARRIERS) {
      expect(DOMAINS).toContain(b.domain);
      expect(b.label.length).toBeGreaterThan(2);
      expect(b.covers.length).toBeGreaterThan(5);
    }
  });
  it('every domain has barriers, and every barrier has at least one entry somewhere', () => {
    for (const d of DOMAINS) expect(BARRIERS.some((b) => b.domain === d)).toBe(true);
    const gaps = BARRIERS.filter((b) => !DAYTON_CATALOG.some((r) => r.categories.includes(b.id)));
    expect(gaps.map((g) => g.id)).toEqual([]);
  });
  it('every provider kind appears in the catalog, faith-based included', () => {
    for (const k of PROVIDER_KINDS) expect(DAYTON_CATALOG.some((r) => r.provider.kind === k), k).toBe(true);
  });
  it('every faith-based entry page says whether help depends on faith', async () => {
    for (const r of DAYTON_CATALOG.filter((x) => x.provider.kind === 'faith')) {
      const html = await (await guideApp().request(`/advocate/guide/service/${r.id}`)).text();
      expect(html, r.id).toMatch(/faith-based/i);
    }
  });
  it('every check-in question opens a barrier from the taxonomy and cites its source', () => {
    for (const p of PULSES) {
      expect(BARRIER[p.need], p.id).toBeDefined();
      expect(p.source.cite.length, p.id).toBeGreaterThan(5);
    }
    expect(PULSES.find((p) => p.id === 'tonight')?.urgency).toBe('tonight');
  });
});

describe('admission: every entry passes, and a planted bad entry is held', () => {
  it('admits every entry in the catalog', () => {
    const held = admitAll(DAYTON_CATALOG, OWNERS).filter((x) => !x.admitted);
    expect(held.map((h) => `${h.id}: ${h.failed.map((f) => f.name).join('; ')}`)).toEqual([]);
  });

  const good = DAYTON_CATALOG.find((r) => r.id === 'daybreak')!;
  const planted: [string, Partial<Resource>, string][] = [
    ['no source', { source: { ...good.source, url: 'not a link' } }, 'source of record cited'],
    ['impossible date', { verifiedOn: '2026-13-40' }, 'verified on a real date'],
    ['never expires', { freshnessDays: 0 }, 'freshness declared'],
    ['a made-up barrier', { categories: ['astrology' as NeedCategory] }, 'barriers from the taxonomy'],
    ['serves nowhere', { serves: {} }, 'serves somewhere'],
    ['no way to reach it', { phone: undefined, url: undefined, location: undefined }, 'a way to reach it'],
    ['a bad phone', { phone: '555-12' }, 'phone is a phone number'],
    ['no steps', { howToApply: [] }, 'how to use it'],
    ['dense eligibility', { eligibility: { text: 'Eligibility determinations are contingent upon comprehensive verification of documentation substantiating household composition, income attestation, and residency qualification pursuant to applicable regulations.' } }, 'eligibility in plain words'],
    ['an unknown rule', { eligibility: { ...good.eligibility, rule: 'made-up' as never } }, 'eligibility rule is one the engine knows'],
    ['an unknown prefill', { prefill: ['ssn' as never] }, 'prefill fields exist'],
    ['an unsourced availability fact', { availability: [{ fact: 'funding', value: 'Plenty', source: 'trust me', checkedOn: '2026-11-13' }] }, 'availability facts are sourced and dated'],
  ];
  for (const [what, change, gate] of planted) {
    it(`holds an entry with ${what}`, () => {
      const bad = { ...good, ...change } as Resource;
      const failed = admit(bad, DAYTON_CATALOG.map((r) => (r.id === good.id ? bad : r)), OWNERS).filter((c) => !c.ok).map((c) => c.name);
      expect(failed).toContain(gate);
    });
  }
  it('holds an entry no scout owns', () => {
    const stray = { ...good, id: 'stray-entry' };
    expect(admit(stray, [...DAYTON_CATALOG, stray], OWNERS).find((c) => c.name === 'owned by a declared scout')?.ok).toBe(false);
  });
  it('holds a duplicated id', () => {
    expect(admit(good, [...DAYTON_CATALOG, good], OWNERS).find((c) => c.name === 'unique id')?.ok).toBe(false);
  });
  it('every scout lists only entries that exist, under needs it declares', () => {
    const ids = new Set(DAYTON_CATALOG.map((r) => r.id));
    for (const s of scouts) for (const e of s.entries) expect(ids.has(e), `${s.scout}: ${e}`).toBe(true);
  });
});

describe('support packages', () => {
  it('every package entry exists, and every package is for a barrier in the taxonomy', () => {
    const ids = new Set(DAYTON_CATALOG.map((r) => r.id));
    for (const p of PACKAGES) {
      expect(BARRIER[p.need], p.id).toBeDefined();
      expect(p.entries.length, p.id).toBeGreaterThan(0);
      for (const e of p.entries) expect(ids.has(e), `${p.id}: ${e}`).toBe(true);
    }
  });
  it('package ids are unique and packageFor finds each one by its barrier', () => {
    expect(new Set(PACKAGES.map((p) => p.id)).size).toBe(PACKAGES.length);
    for (const p of PACKAGES) expect(packageFor(p.need)?.need).toBe(p.need);
  });
  it('the tonight package starts with shelters that answer by phone', () => {
    const t = PACKAGES.find((p) => p.id === 'tonight')!;
    for (const id of t.entries.slice(0, 3)) expect(DAYTON_CATALOG.find((r) => r.id === id)?.phone, id).toBeTruthy();
  });
});

describe('signals: from everything to a few', () => {
  const opts = (rs: Resource[]) => () => rs;
  const record = () => tally([]);
  const shelter = DAYTON_CATALOG.find((r) => r.id === 'daybreak')!;
  const pantry = DAYTON_CATALOG.find((r) => r.categories.includes('food'))!;

  it('never shows more than three, whatever is open', () => {
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (evs) => {
      const book = evs.reduce((b, e, i) => apply(b, e, day(i)), B.empty());
      const t = day(evs.length);
      const s = signals({ book, today: t, optionsFor: opts([shelter]), record });
      expect(s.length).toBeLessThanOrEqual(MAX);
      for (const x of s) {
        const b = B.find(book, x.need)!;
        expect(b.status).not.toBe('resolved');
        expect(B.remindable(b, t)).toBe(true);
      }
      for (let i = 1; i < s.length; i++) expect(RANK[s[i - 1]!.urgency]).toBeLessThanOrEqual(RANK[s[i]!.urgency]);
    }), { numRuns: 300 });
  });

  it('tonight comes first even when it was opened last', () => {
    let book = B.empty();
    for (const [i, n] of (['food', 'transportation', 'utilities', 'books'] as NeedCategory[]).entries()) book = B.open(book, n, 'student', 'soon', day(i));
    book = B.open(book, 'emergency', 'check-in', 'tonight', day(5));
    const s = signals({ book, today: day(5), optionsFor: (n) => (n === 'emergency' ? [shelter] : [pantry]), record });
    expect(s[0]?.urgency).toBe('tonight');
    expect(s[0]?.title).toMatch(/^Tonight:/);
    expect(s).toHaveLength(3);
  });

  it('a barrier with nothing near the student is a counted gap that offers 2-1-1, not silence', () => {
    const book = B.open(B.empty(), 'legal', 'student', 'soon', TODAY);
    const [s] = signals({ book, today: TODAY, optionsFor: () => [], record });
    expect(s?.gap).toBe(true);
    expect(s?.title).toMatch(/2-1-1/);
  });

  it('a resolved barrier and a "not today" barrier drop out of the signals', () => {
    let book = B.open(B.empty(), 'food', 'student', 'soon', TODAY);
    book = B.open(book, 'housing', 'student', 'soon', TODAY);
    book = B.resolve(book, 'food', TODAY);
    book = B.notToday(book, 'housing', TODAY);
    expect(signals({ book, today: TODAY, optionsFor: opts([pantry]), record })).toEqual([]);
  });
});

describe('feedback: one question, shown only in numbers no one can be picked out of', () => {
  it('shows nothing below the threshold and counts at or above it', () => {
    const o = (n: number, k: Outcome = 'helped') => Array<Outcome>(n).fill(k);
    expect(recordLine(tally(o(MIN_SHOWN - 1)))).toBeUndefined();
    expect(recordLine(tally(o(MIN_SHOWN)))).toBe(`Helped ${MIN_SHOWN} of ${MIN_SHOWN} students who tried it.`);
    expect(recordLine(tally([...o(3), ...o(2, 'could-not-reach')]))).toMatch(/2 could not reach them/);
  });
  it('the ranking score stays between 0 and 1 and grows with help', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom<Outcome>('helped', 'did-not-help', 'could-not-reach'), { maxLength: 200 }), (os) => {
      const r = tally(os);
      const s = helpScore(r);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
      expect(helpScore({ ...r, helped: r.helped + 1, tried: r.tried + 1 })).toBeGreaterThan(s);
    }));
  });
  it('flags rarely helpful entries for review once enough answered, never hides them', () => {
    expect(needsReview({ helped: 1, tried: 9, unreachable: 0 })).toBe(false);
    expect(needsReview({ helped: 1, tried: 10, unreachable: 0 })).toBe(true);
  });
  it('in the app, one answer per student counts, and the latest answer wins', () => {
    const a = makeAdvocate();
    const ids = Array.from({ length: MIN_SHOWN }, (_, i) => maria(a, { chosenName: `S${i}`, phone: `+1937555${2000 + i}` }).id);
    for (const id of ids) {
      a.resourceFeedback(id, 'daybreak', 'did-not-help');
      a.resourceFeedback(id, 'daybreak', 'did-not-help');
    }
    a.resourceFeedback(ids[0]!, 'daybreak', 'helped');
    expect(a.resourceRecord('daybreak')).toEqual({ helped: 1, tried: MIN_SHOWN, unreachable: 0 });
    const svc = a.guideFeed().services.find((s) => s.id === 'daybreak')!;
    expect(svc.record).toBe(`Helped 1 of ${MIN_SHOWN} students who tried it.`);
    a.resourceFeedback(ids[0]!, 'not-a-resource', 'helped');
    expect(a.resourceRecord('not-a-resource').tried).toBe(0);
  });
});

describe('the public feed', () => {
  const a = makeAdvocate();
  const s = maria(a);
  a.openBarrier(s.id, 'housing', 'check-in', 'tonight');
  a.resourceFeedback(s.id, 'daybreak', 'helped');
  const f = a.guideFeed();
  const text = JSON.stringify(f);

  it('validates against its published schema', () => {
    expect(Feed.safeParse(f).success).toBe(true);
    for (const svc of f.services) expect(FeedService.safeParse(svc).success, svc.id).toBe(true);
    expect(f.count).toBe(DAYTON_CATALOG.length);
  });
  it('carries no student, ever: no names, phones, ids or answers below the threshold', () => {
    expect(text).not.toContain(s.id);
    expect(text).not.toContain('Maria');
    expect(text).not.toContain('5551001');
    expect(f.services.find((x) => x.id === 'daybreak')?.record).toBeUndefined();
  });
  it('carries attribution, a license and, for every entry, its source and whether it is current', () => {
    expect(f.license.url).toMatch(/creativecommons\.org\/licenses\/by\/4\.0/);
    for (const svc of f.services) {
      expect(svc.source.url).toMatch(/^https?:\/\//);
      expect(svc.verification.current).toBe(isFresh(DAYTON_CATALOG.find((r) => r.id === svc.id)!, TODAY));
    }
  });
  it('marks an entry past its freshness as not current rather than dropping it', () => {
    const stale = { ...DAYTON_CATALOG[0]!, verifiedOn: '2025-01-01', freshnessDays: 30 };
    const out = feed([stale], TODAY);
    expect(out.services[0]?.verification.current).toBe(false);
    expect(coverage([stale], TODAY).cells.every((c) => c.services === 0)).toBe(true);
  });
  it('labels every situation it uses', () => {
    for (const svc of f.services) for (const x of svc.situations) expect(x.label).toBe(SITUATION_LABEL[x.id as keyof typeof SITUATION_LABEL]);
  });
  it('publishes coverage for every barrier in both counties, with gaps named', () => {
    const c = a.guideCoverage();
    expect(c.cells).toHaveLength(BARRIERS.length * 2);
    for (const g of c.gaps) expect(c.cells.find((x) => x.barrier === g.barrier && x.county === g.county)?.services).toBe(0);
  });
});

describe('in the app: a check-in yes stays in the recommendations until the student resolves it', () => {
  it('"no safe place tonight" opens an emergency barrier, answers with shelters, and keeps it on Today', () => {
    const a = makeAdvocate();
    const s = maria(a);
    const msg = a.answerPulse(s.id, 'tonight', 'no');
    expect(msg.urgency).not.toBe('routine');
    expect(msg.text).toMatch(/tonight/i);
    const sig = a.signals(s.id);
    expect(sig[0]?.urgency).toBe('tonight');
    expect(sig[0]?.resource?.phone).toBeTruthy();
    expect(a.carePlan(s.id)[0]?.barrier.need).toBe('emergency');
  });
  it('the barrier survives later check-ins, other needs and "not today", and leaves only when resolved', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.answerPulse(s.id, 'food', PULSES.find((p) => p.id === 'food')!.needOn);
    a.answerPulse(s.id, 'ride', PULSES.find((p) => p.id === 'ride')!.needOn === 'yes' ? 'no' : 'yes');
    a.openBarrier(s.id, 'books', 'student');
    expect(a.signals(s.id).some((x) => x.need === 'food')).toBe(true);
    a.notTodayBarrier(s.id, 'food');
    expect(a.signals(s.id).some((x) => x.need === 'food')).toBe(false);
    expect(a.carePlan(s.id).some((x) => x.barrier.need === 'food')).toBe(true);
    a.resolveBarrier(s.id, 'food');
    expect(a.carePlan(s.id).some((x) => x.barrier.need === 'food')).toBe(false);
    expect(a.barriers(s.id).items.find((b) => b.need === 'food')?.status).toBe('resolved');
  });
  it('a package offers only what serves this student and is current', () => {
    const a = makeAdvocate();
    const s = maria(a);
    for (const p of PACKAGES) {
      const { options } = a.supportPackage(s.id, p);
      for (const o of options) {
        expect(p.entries).toContain(o.resource.id);
        expect(isFresh(o.resource, TODAY)).toBe(true);
        const sv = o.resource.serves;
        expect(!!(sv.national || sv.counties?.includes('Montgomery') || sv.colleges?.includes('sinclair')), `${p.id}: ${o.resource.id}`).toBe(true);
      }
    }
  });
  it('a student can export and delete their barriers with everything else', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.openBarrier(s.id, 'housing', 'student');
    expect(JSON.stringify(a.exportData(s.id))).toContain('housing');
    a.deleteStudent(s.id);
    expect(() => a.barriers(s.id)).not.toThrow();
    expect(a.barriers(s.id).items).toEqual([]);
  });
});

describe('the guide screens and API answer, for anyone, with no student data', () => {
  const app = guideApp();
  const get = (p: string) => app.request(`/advocate${p}`);
  it('the public guide, every barrier page and every entry page render', async () => {
    expect((await get('/guide')).status).toBe(200);
    for (const b of BARRIERS) expect((await get(`/guide/${b.id}`)).status, b.id).toBe(200);
    for (const r of DAYTON_CATALOG) {
      const res = await get(`/guide/service/${r.id}`);
      expect(res.status, r.id).toBe(200);
      const html = await res.text();
      expect(html, r.id).toContain(r.source.url.replace(/&/g, '&amp;'));
    }
    const lost = await get('/guide/not-a-barrier');
    expect(lost.status).toBe(302);
    expect(lost.headers.get('location')).toBe('/advocate/guide');
    expect((await get('/guide/service/not-an-entry')).status).toBe(404);
  });
  it('the feed, one service, filters, barriers, coverage, packages and the OpenAPI document', async () => {
    const all = await (await get('/api/guide/v1/services')).json() as { services: { id: string }[] };
    expect(all.services.length).toBe(DAYTON_CATALOG.length);
    const one = await get('/api/guide/v1/services/daybreak');
    expect(one.status).toBe(200);
    expect(one.headers.get('access-control-allow-origin')).toBe('*');
    expect(FeedService.safeParse(await one.json()).success).toBe(true);
    const food = await (await get('/api/guide/v1/services?barrier=food&county=Greene')).json() as { services: FeedService[] };
    expect(food.services.length).toBeGreaterThan(0);
    for (const x of food.services) expect(x.taxonomy.some((t) => t.barrier === 'food')).toBe(true);
    const faith = await (await get('/api/guide/v1/services?kind=faith')).json() as { services: FeedService[] };
    expect(faith.services.every((x) => x.organization.kind === 'faith')).toBe(true);
    for (const p of ['/api/guide/v1', '/api/guide/v1/barriers', '/api/guide/v1/coverage', '/api/guide/v1/packages', '/api/guide/v1/openapi.json']) expect((await get(p)).status, p).toBe(200);
    expect((await get('/api/guide/v1/services/nope')).status).toBe(404);
  });
});

describe('a quiet need is asked about again, in the check-in slot, until the student says it is sorted out', () => {
  const setup = () => {
    let today = TODAY;
    const a = new Advocate({ today: () => today, now: () => new Date(`${today}T15:00:00Z`) });
    const s = maria(a);
    a.openBarrier(s.id, 'utilities', 'student');
    return { a, s, go: (d: string) => (today = d) };
  };
  it('is not asked in the first week, then is asked before any other check-in', () => {
    const { a, s, go } = setup();
    go('2026-11-06');
    expect(a.pulse(s.id)?.text ?? '').not.toMatch(/sorted out/);
    go('2026-11-09');
    const q = a.pulse(s.id)!;
    expect(q.text).toMatch(/utilities.*sorted out/i);
    expect(q.nextSteps.map((x) => x.action)).toEqual(['barrier:resolve:utilities', 'barrier-still:utilities', 'barrier:not-today:utilities']);
    expect(B.find(a.barriers(s.id), 'utilities')?.lastAskedOn).toBe('2026-11-09');
  });
  it('"not yet" keeps it open and answers with help for it; a text "yes" resolves it', () => {
    const { a, s, go } = setup();
    go('2026-11-09');
    a.pulse(s.id);
    const r = a.converse(s.id, 'no');
    expect(r[0]?.text).toMatch(/utilit|bill|energy|PIPP|HEAP/i);
    expect(B.find(a.barriers(s.id), 'utilities')?.status).toBe('open');
    go('2026-11-16');
    a.pulse(s.id);
    a.converse(s.id, 'yes');
    expect(B.find(a.barriers(s.id), 'utilities')?.status).toBe('resolved');
    go('2026-11-30');
    expect(a.pulse(s.id)?.text ?? '').not.toMatch(/utilities/i);
  });
  it('turning check-ins off stops the follow-up too, and leaves the need open', () => {
    const { a, s, go } = setup();
    a.setPulses(s.id, { off: true });
    go('2026-11-20');
    expect(a.pulse(s.id)).toBeUndefined();
    expect(B.find(a.barriers(s.id), 'utilities')?.status).toBe('open');
  });
  it('the buttons work from the app', async () => {
    const { a, s, go } = setup();
    go('2026-11-09');
    a.pulse(s.id);
    const { ACTIONS } = await import('../src/agents/actions.js');
    const still = ACTIONS['barrier-still']!(a, s.id, 'utilities');
    expect(B.find(a.barriers(s.id), 'utilities')?.status).toBe('open');
    expect(still.message.text.length).toBeGreaterThan(10);
    expect(ACTIONS['my-plan']!(a, s.id, '').view).toBe('plan');
    expect(ACTIONS['barrier-still']!(a, s.id, 'astrology').message.text).toMatch(/could not tell/);
  });
});

describe('a consumer app that knows only the published OpenAPI document can take the feed', () => {
  it('every service, from the list and one by one, validates against the document\'s own schema', async () => {
    // ajv ships CommonJS; take its constructor whichever way the loader hands it over.
    const ajvMod = (await import('ajv')) as unknown as { default: { default?: unknown } };
    const fmtMod = (await import('ajv-formats')) as unknown as { default: { default?: unknown } };
    const Ajv = (ajvMod.default.default ?? ajvMod.default) as new (o: object) => { compile: (s: object) => ((x: unknown) => boolean) & { errors?: unknown[] } };
    const addFormats = (fmtMod.default.default ?? fmtMod.default) as (a: unknown) => void;
    const app = guideApp();
    const get = async (p: string) => (await app.request(`/advocate/api/guide/v1${p}`)).json();
    const doc = (await get('/openapi.json')) as { openapi: string; components: { schemas: Record<string, object> }; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const service = ajv.compile(doc.components.schemas.Service!);
    const props = Object.keys((doc.components.schemas.Service as { properties: object }).properties);
    expect(props).toEqual(expect.arrayContaining(['id', 'organization', 'taxonomy', 'how_to_use', 'source', 'verification']));
    const all = (await get('/services')) as { services: unknown[] };
    for (const svc of all.services) expect(service(svc), JSON.stringify(service.errors?.slice(0, 2))).toBe(true);
    for (const id of DAYTON_CATALOG.slice(0, 10).map((r) => r.id)) expect(service(await get(`/services/${id}`))).toBe(true);
    // The document is not vacuous: a service missing its source, or with a made-up provider kind, is refused.
    const one = all.services[0] as Record<string, unknown>;
    expect(service({ ...one, source: undefined })).toBe(false);
    expect(service({ ...one, organization: { ...(one.organization as object), kind: 'astrology' } })).toBe(false);
    for (const p of Object.keys(doc.paths)) expect((await app.request(`/advocate/api/guide/v1${p.replace('{id}', 'daybreak')}`)).status, p).toBe(200);
  });
});
