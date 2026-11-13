// Verifies docs/flows/resource-guide.md
import { describe, expect, it } from 'vitest';
import type { Resource } from '../src/catalog/types.js';
import { DAYTON_CATALOG } from '../src/catalog/dayton.js';
import * as B from '../src/guide/barriers.js';
import { coverage, feed, FEED_VERSION, LICENSE, toFeedService } from '../src/guide/feed.js';
import { helpScore, needsReview, OUTCOME_LABEL, OUTCOMES, tally } from '../src/guide/feedback.js';
import { PACKAGES } from '../src/guide/packages.js';
import { signals } from '../src/guide/signals.js';
import { BARRIER, BARRIERS } from '../src/guide/taxonomy.js';

/**
 * The guide's rules, one at a time, where a mutation run showed the broader tests would not notice a change: how
 * the best next step is chosen for a need, how coverage is counted, and exactly what the feed says about a service.
 */
const TODAY = '2026-11-02';
const base = DAYTON_CATALOG.find((r) => r.id === 'daybreak')!;
const make = (id: string, over: Partial<Resource> = {}): Resource => ({ ...base, id, name: `Name ${id}`, description: `About ${id}.`, availability: [], ...over });
const noRecord = () => tally([]);

describe('signals: the best next step for a need', () => {
  const book = B.open(B.empty(), 'food', 'student', 'soon', TODAY);
  const pick = (opts: Resource[], record: (id: string) => ReturnType<typeof tally> = noRecord) => signals({ book, today: TODAY, optionsFor: () => opts, record })[0]!.resource!.id;
  const pkg = PACKAGES.find((p) => p.need === 'food')!;
  const [first, second] = pkg.entries;

  it('a service taking applications now comes before everything else', () => {
    const open = make('open-now', { availability: [{ fact: 'applications-open', value: 'Open until Dec 1', source: 'https://example.org', checkedOn: TODAY }] });
    const funded = make('funded', { availability: [{ fact: 'funding', value: 'Funds left', source: 'https://example.org', checkedOn: TODAY }] });
    expect(pick([make(first!), funded, open])).toBe('open-now');
    expect(pick([open, make(first!)])).toBe('open-now');
  });
  it('then the package order', () => {
    expect(pick([make(second!), make(first!)])).toBe(first);
    expect(pick([make(first!), make(second!)])).toBe(first);
  });
  it('a service in the package comes before one that is not', () => {
    expect(pick([make('not-in-package'), make(second!)])).toBe(second);
  });
  it('then the record of whether it helped', () => {
    const rec = (id: string) => (id === 'often-helps' ? tally(['helped', 'helped', 'helped', 'helped', 'helped']) : id === 'rarely-helps' ? tally(['did-not-help', 'did-not-help', 'did-not-help']) : noRecord());
    expect(pick([make('rarely-helps'), make('often-helps')], rec)).toBe('often-helps');
    expect(pick([make('often-helps'), make('rarely-helps')], rec)).toBe('often-helps');
  });
  it('says why, in the barrier\'s own words', () => {
    const s = signals({ book, today: TODAY, optionsFor: () => [make(first!)], record: noRecord })[0]!;
    expect(s.why).toBe(`For ${BARRIER.food!.label.toLowerCase()}: About ${first}.`);
    expect(s.title).toBe(`Name ${first}`);
    expect(s.packageId).toBe(pkg.id);
    const t = signals({ book: B.open(B.empty(), 'emergency', 'check-in', 'tonight', TODAY), today: TODAY, optionsFor: () => [make('x')], record: noRecord })[0]!;
    expect(t.title).toBe('Tonight: Name x');
  });
});

describe('coverage: what counts where', () => {
  const only = (r: Resource) => coverage([r], TODAY).cells.filter((c) => c.services > 0).map((c) => `${c.barrier}/${c.county}`).sort();
  it('a national service counts in every county', () => {
    expect(only(make('n', { categories: ['food'], serves: { national: true } }))).toEqual(['food/Greene', 'food/Montgomery']);
  });
  it('a county service counts only in its county', () => {
    expect(only(make('c', { categories: ['food'], serves: { counties: ['Greene'] } }))).toEqual(['food/Greene']);
  });
  it('a college\'s own service counts only in the county the college is in', () => {
    expect(only(make('s', { categories: ['books'], serves: { colleges: ['sinclair'] } }))).toEqual(['books/Montgomery']);
    expect(only(make('w', { categories: ['books'], serves: { colleges: ['wright-state'] } }))).toEqual(['books/Greene']);
    expect(only(make('k', { categories: ['books'], serves: { colleges: ['clark-state'] } }))).toEqual([]);
  });
  it('a stale service does not count, and every empty cell is a named gap', () => {
    const stale = make('old', { categories: ['food'], serves: { national: true }, verifiedOn: '2025-01-01', freshnessDays: 30 });
    const c = coverage([stale], TODAY);
    expect(c.cells.every((x) => x.services === 0)).toBe(true);
    expect(c.gaps).toHaveLength(BARRIERS.length * 2);
    expect(c.gaps[0]).toEqual({ barrier: BARRIERS[0]!.id, county: 'Montgomery' });
    const one = coverage([make('f', { categories: ['food'], serves: { counties: ['Montgomery'] }, provider: { kind: 'faith', level: 'local' } })], TODAY);
    expect(one.cells.find((x) => x.barrier === 'food' && x.county === 'Montgomery')).toEqual({ barrier: 'food', county: 'Montgomery', services: 1, kinds: ['faith'] });
    expect(one.gaps).toHaveLength(BARRIERS.length * 2 - 1);
  });
});

describe('the feed says exactly what the entry says', () => {
  it('maps every field, and leaves out what an entry does not have', () => {
    const full = make('full', {
      categories: ['food', 'housing'],
      organization: 'Org',
      provider: { kind: 'faith', level: 'local', faithNote: 'Help does not depend on faith.' },
      serves: { counties: ['Greene'] },
      location: { address: '1 Main St', city: 'Xenia', zip: '45385' },
      phone: '937-555-0100',
      url: 'https://example.org/full',
      hours: 'Mon 9-5',
      cost: 'free',
      whatToExpect: 'A short wait.',
      situations: ['veteran'],
      availability: [{ fact: 'funding', value: 'Funds left', source: 'https://example.org/f', checkedOn: TODAY }],
    });
    const f = toFeedService(full, TODAY);
    expect(f.organization).toEqual({ name: 'Org', kind: 'faith', kind_label: 'Faith-based', level: 'local', faith_note: 'Help does not depend on faith.' });
    expect(f.taxonomy).toEqual([
      { barrier: 'food', label: BARRIER.food!.label, domain: BARRIER.food!.domain, domain_label: expect.any(String) },
      { barrier: 'housing', label: BARRIER.housing!.label, domain: BARRIER.housing!.domain, domain_label: expect.any(String) },
    ]);
    expect(f.taxonomy[0]!.domain_label.length).toBeGreaterThan(3);
    expect(f.serves).toEqual({ counties: ['Greene'], colleges: [], national: false });
    expect(f.location).toEqual({ address: '1 Main St', city: 'Xenia', postal_code: '45385' });
    expect([f.phone, f.url, f.hours, f.cost]).toEqual(['937-555-0100', 'https://example.org/full', 'Mon 9-5', 'free']);
    expect(f.how_to_use.what_to_expect).toBe('A short wait.');
    expect(f.situations).toEqual([{ id: 'veteran', label: 'Veterans' }]);
    expect(f.availability).toEqual([{ fact: 'funding', value: 'Funds left', source: 'https://example.org/f', checked_on: TODAY }]);
    const bare = toFeedService(make('bare', { serves: { national: true }, phone: undefined, url: undefined, hours: undefined, cost: undefined, location: undefined, whatToExpect: undefined, situations: undefined, provider: { kind: 'nonprofit', level: 'local' } }), TODAY);
    for (const k of ['phone', 'url', 'hours', 'cost', 'location', 'record'] as const) expect(k in bare, k).toBe(false);
    expect('faith_note' in bare.organization).toBe(false);
    expect('what_to_expect' in bare.how_to_use).toBe(false);
    expect(bare.serves).toEqual({ counties: [], colleges: [], national: true });
    expect(bare.situations).toEqual([]);
  });
  it('a category outside the taxonomy keeps its id and is not given a made-up label', () => {
    const odd = toFeedService(make('odd', { categories: ['not-a-barrier' as Resource['categories'][number]] }), TODAY);
    expect(odd.taxonomy[0]).toMatchObject({ barrier: 'not-a-barrier', label: 'not-a-barrier', domain: 'feasible' });
  });
  it('the feed carries its name, version, region, license and count', () => {
    const f = feed([base], TODAY);
    expect(f).toMatchObject({ feed: 'community-resource-guide', version: FEED_VERSION, region: 'Montgomery and Greene counties, Ohio', generated_on: TODAY, count: 1 });
    expect(FEED_VERSION).toBe('1.0');
    expect(f.license).toEqual(LICENSE);
    expect(LICENSE).toEqual({ name: 'Creative Commons Attribution 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: expect.stringMatching(/^Community resource guide, Student Advocate/) });
  });
});

describe('feedback, exactly', () => {
  it('the three answers and their words', () => {
    expect(OUTCOMES).toEqual(['helped', 'did-not-help', 'could-not-reach']);
    expect(OUTCOME_LABEL).toEqual({ helped: 'It helped', 'did-not-help': 'I tried; it did not help', 'could-not-reach': 'I could not reach them' });
  });
  it('the ranking score, and the review flag at its boundary', () => {
    expect(helpScore({ helped: 3, tried: 8, unreachable: 0 })).toBe(0.4);
    expect(needsReview({ helped: 3, tried: 12, unreachable: 0 })).toBe(false);
    expect(needsReview({ helped: 2, tried: 12, unreachable: 0 })).toBe(true);
  });
});
