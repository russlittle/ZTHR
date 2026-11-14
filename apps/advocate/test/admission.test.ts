// Verifies docs/flows/resource-guide.md
// Each gate is held to its edge: the planted entry fails that gate and no other, the value on each side of every
// limit lands on the side the rule states, and each check's detail names what it judged, since the detail is what a
// person reads when an entry is held.
import { describe, expect, it } from 'vitest';
import { DAYTON_CATALOG } from '../src/catalog/dayton.js';
import type { Resource } from '../src/catalog/types.js';
import type { NeedCategory } from '../src/domain/types.js';
import { admit, admitAll } from '../src/guide/admission.js';

const OWNERS = new Set(DAYTON_CATALOG.map((r) => r.id));
const good = DAYTON_CATALOG.find((r) => r.id === 'daybreak')!;
const others = DAYTON_CATALOG.filter((r) => r.id !== good.id);
const checks = (change: Partial<Resource>, catalog?: Resource[]) => {
  const r = { ...good, ...change } as Resource;
  return admit(r, catalog ?? [...others, r], OWNERS);
};
const failed = (change: Partial<Resource>, catalog?: Resource[]) => checks(change, catalog).filter((c) => !c.ok).map((c) => c.name);
const detail = (change: Partial<Resource>, name: string) => checks(change).find((c) => c.name === name)!.detail;
const plain = 'Call the hotline.';
const dense = 'Eligibility determinations are contingent upon comprehensive verification of documentation substantiating household composition and residency qualification.';

describe('admission: each gate at its edge', () => {
  it('the reference entry passes every gate, and each detail names what was judged', () => {
    expect(failed({})).toEqual([]);
    expect(checks({}).map((c) => [c.name, c.detail])).toEqual([
      ['source of record cited', good.source.url],
      ['verified on a real date', good.verifiedOn],
      ['freshness declared', '30 days'],
      ['barriers from the taxonomy', 'emergency, housing'],
      ['provider stated', 'nonprofit, regional'],
      ['serves somewhere', '{"counties":["Montgomery","Greene"]}'],
      ['a way to reach it', '937-461-1000 | https://www.daybreakdayton.org | 605 S. Patterson Blvd.'],
      ['phone is a phone number', '937-461-1000'],
      ['how to use it', '2 steps'],
      ['eligibility in plain words', 'grade 4.8'],
      ['description reads plainly', 'grade 6.1'],
      ['every step reads plainly', '0.7, 4.0'],
      ['eligibility rule is one the engine knows', 'none'],
      ['prefill fields exist', 'none'],
      ['availability facts are sourced and dated', '0 facts'],
      ['owned by a declared scout', 'owned'],
      ['not a duplicate', 'unique'],
      ['unique id', 'daybreak'],
    ]);
  });

  it('source: https or http at the start, nothing else', () => {
    const src = (url: string) => ({ source: { ...good.source, url } });
    expect(failed(src('http://example.org'))).toEqual([]);
    expect(failed(src('see https://example.org'))).toEqual(['source of record cited']);
    expect(failed(src('see http://example.org'))).toEqual(['source of record cited']);
    expect(failed(src('ftp://example.org'))).toEqual(['source of record cited']);
  });

  it('dates: a whole date and a real one', () => {
    expect(failed({ verifiedOn: '2026-11-13T00:00' })).toEqual(['verified on a real date']);
    expect(failed({ verifiedOn: 'on 2026-11-13' })).toEqual(['verified on a real date']);
    expect(failed({ verifiedOn: '2026-13-40' })).toEqual(['verified on a real date']);
    expect(detail({ verifiedOn: '2026-13-40' }, 'verified on a real date')).toBe('2026-13-40');
  });

  it('freshness: one day to a year', () => {
    expect(failed({ freshnessDays: 1 })).toEqual([]);
    expect(failed({ freshnessDays: 365 })).toEqual([]);
    expect(failed({ freshnessDays: 0 })).toEqual(['freshness declared']);
    expect(failed({ freshnessDays: 366 })).toEqual(['freshness declared']);
    expect(detail({ freshnessDays: 366 }, 'freshness declared')).toBe('366 days');
  });

  it('barriers: at least one, and every one from the taxonomy', () => {
    expect(failed({ categories: [] })).toEqual(['barriers from the taxonomy']);
    expect(failed({ categories: ['housing', 'astrology' as NeedCategory] })).toEqual(['barriers from the taxonomy']);
    expect(detail({ categories: ['housing', 'astrology' as NeedCategory] }, 'barriers from the taxonomy')).toBe('housing, astrology');
  });

  it('provider: both its kind and its level', () => {
    expect(failed({ provider: undefined as never })).toEqual(['provider stated']);
    expect(detail({ provider: undefined as never }, 'provider stated')).toBe('missing');
    expect(failed({ provider: { kind: 'nonprofit' } as never })).toEqual(['provider stated']);
    expect(failed({ provider: { level: 'regional' } as never })).toEqual(['provider stated']);
  });

  it('serves: national, a county or a college is enough', () => {
    expect(failed({ serves: {} })).toEqual(['serves somewhere']);
    expect(failed({ serves: { counties: [] } })).toEqual(['serves somewhere']);
    expect(failed({ serves: { national: true } })).toEqual([]);
    expect(failed({ serves: { colleges: ['sinclair'] } as never })).toEqual([]);
  });

  it('reach: any one of a phone, a link or a place', () => {
    const none = { phone: undefined, url: undefined, location: undefined };
    expect(failed(none)).toEqual(['a way to reach it']);
    expect(detail(none, 'a way to reach it')).toBe('none');
    expect(failed({ ...none, phone: '937-461-1000' })).toEqual([]);
    expect(failed({ ...none, url: 'https://example.org' })).toEqual([]);
    expect(failed({ ...none, location: good.location })).toEqual([]);
    expect(detail({ ...none, url: 'https://example.org' }, 'a way to reach it')).toBe('https://example.org');
  });

  it('phone: ten or eleven digits, or a three-digit line like 211', () => {
    for (const p of ['937-461-1000', '1-800-273-8255', '211']) expect(failed({ phone: p })).toEqual([]);
    for (const p of ['555-12', '93746110', '937-461-10000-1']) expect(failed({ phone: p })).toEqual(['phone is a phone number']);
    expect(detail({ phone: undefined }, 'phone is a phone number')).toBe('none');
  });

  it('steps: at least one, and every one plain', () => {
    expect(failed({ howToApply: [] })).toEqual(['how to use it']);
    expect(detail({ howToApply: [plain] }, 'how to use it')).toBe('1 steps');
    expect(failed({ howToApply: [plain, dense] })).toEqual(['every step reads plainly']);
    expect(failed({ howToApply: [dense, plain] })).toEqual(['every step reads plainly']);
  });

  it('eligibility: words, and plain ones; under six words is judged plain', () => {
    expect(failed({ eligibility: { text: '' } })).toEqual(['eligibility in plain words']);
    expect(failed({ eligibility: { text: dense } })).toEqual(['eligibility in plain words']);
    expect(failed({ eligibility: { text: 'Anyone. Residency required.' } })).toEqual([]);
    expect(failed({ eligibility: { text: 'Everyone in Montgomery County, unconditionally.' } })).toEqual([]);
    expect(failed({ eligibility: { text: 'Everyone living in Montgomery County, unconditionally.' } })).toEqual(['eligibility in plain words']);
  });

  it('description: plain words', () => {
    expect(failed({ description: dense })).toEqual(['description reads plainly']);
  });

  it('rules and prefill: only those the engine and the form know', () => {
    expect(failed({ eligibility: { ...good.eligibility, rule: 'snap' } })).toEqual([]);
    expect(failed({ eligibility: { ...good.eligibility, rule: 'made-up' as never } })).toEqual(['eligibility rule is one the engine knows']);
    expect(detail({ eligibility: { ...good.eligibility, rule: 'snap' } }, 'eligibility rule is one the engine knows')).toBe('snap');
    expect(failed({ prefill: ['zip', 'phone'] })).toEqual([]);
    expect(detail({ prefill: ['zip', 'phone'] }, 'prefill fields exist')).toBe('zip, phone');
    expect(failed({ prefill: ['zip', 'ssn' as never] })).toEqual(['prefill fields exist']);
  });

  it('availability: every fact sourced and dated', () => {
    const fact = { fact: 'funding' as const, value: 'Open', source: 'https://example.org', checkedOn: '2026-11-13' };
    expect(failed({ availability: [fact, { ...fact, source: 'http://example.org' }] })).toEqual([]);
    expect(detail({ availability: [fact, fact] }, 'availability facts are sourced and dated')).toBe('2 facts');
    expect(failed({ availability: [fact, { ...fact, source: 'see https://example.org' }] })).toEqual(['availability facts are sourced and dated']);
    expect(failed({ availability: [fact, { ...fact, checkedOn: '2026-11-13T00:00' }] })).toEqual(['availability facts are sourced and dated']);
  });

  it('ownership, duplicates and ids', () => {
    const stray = { ...good, id: 'stray-entry' };
    expect(admit(stray, [...others, good, stray], OWNERS).filter((c) => !c.ok).map((c) => [c.name, c.detail])).toEqual([
      ['owned by a declared scout', 'no scout lists it'],
      ['not a duplicate', 'daybreak'],
    ]);
    // The same phone under another name is another place; the same name under another phone is too.
    const renamed = { ...stray, name: 'Another place' };
    expect(admit(renamed, [...others, good, renamed], new Set([...OWNERS, 'stray-entry'])).filter((c) => !c.ok)).toEqual([]);
    const otherPhone = { ...good, id: 'other-phone', phone: '937-555-0100' };
    expect(admit(otherPhone, [...others, good, otherPhone], new Set([...OWNERS, 'other-phone'])).filter((c) => !c.ok)).toEqual([]);
    const noPhone = { ...good, id: 'no-phone', phone: undefined };
    expect(admit(noPhone, [...others, { ...good, phone: undefined }, noPhone], new Set([...OWNERS, 'no-phone'])).filter((c) => !c.ok)).toEqual([]);
    expect(failed({}, [...DAYTON_CATALOG, good])).toEqual(['unique id']);
  });

  it('admitAll holds exactly the entries that fail, with only their failing checks', () => {
    const bad = { ...good, id: 'bad-one', freshnessDays: 0, phone: '12' };
    const out = admitAll([good, bad], new Set(['daybreak', 'bad-one']));
    expect(out.map((o) => [o.id, o.admitted, o.failed.map((f) => f.name)])).toEqual([
      ['daybreak', true, []],
      ['bad-one', false, ['freshness declared', 'phone is a phone number']],
    ]);
  });
});
