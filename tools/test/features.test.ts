// Verifies docs/features.md
// Verifies docs/glossary.md
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCards } from '@zthr/intent';
import { loadFeatures } from '../features.js';
import { JOURNEY_DIR, ROOT } from '../lib.js';

describe('features list', () => {
  const phases = loadFeatures();
  const cards = loadCards(JOURNEY_DIR);
  it('covers phases 1 to 5 in order', () => expect(phases.map((p) => p.n)).toEqual([1, 2, 3, 4, 5]));
  it('names only journeys that exist', () => {
    const ids = new Set(cards.map((c) => c.id));
    for (const f of phases.flatMap((p) => p.features)) for (const j of f.journeys) expect(ids.has(j), `${f.name}: ${j}`).toBe(true);
  });
  it('every locked journey proves some feature', () => {
    const named = new Set(phases.flatMap((p) => p.features.flatMap((f) => f.journeys)));
    expect(cards.map((c) => c.id).filter((id) => !named.has(id))).toEqual([]);
  });
  it('a feature proven by a journey sits in that journey\'s phase or a later one', () => {
    for (const p of phases) for (const f of p.features) for (const j of f.journeys) expect(cards.find((c) => c.id === j)!.phase, `${f.name}: ${j}`).toBeLessThanOrEqual(p.n);
  });
  it('every status is built, partial or not measured', () => {
    for (const f of phases.flatMap((p) => p.features)) expect(['built', 'partial', 'not measured']).toContain(f.status);
  });
});

describe('glossary', () => {
  const g = readFileSync(`${ROOT}docs/glossary.md`, 'utf8');
  const terms = [...g.matchAll(/^\| ([A-Z][^|]+?) \| /gm)].map((m) => m[1]!).filter((t) => t !== 'Term');
  it('defines the words the docs rely on', () => {
    for (const t of ['Advocate', 'Dispatch', 'Lease', 'Operator', 'Playbook', 'Scout', 'Sealed fact', 'Sensitivity class', 'Twin', 'Block', 'Canary', 'Gate', 'Journey card', 'Ratchet', 'Register', 'Walk', 'Fixpoint', 'Held out']) expect(terms).toContain(t);
  });
  it('lists each section in alphabetical order, each term once', () => {
    const sections = g.split('## The factory');
    for (const s of sections) {
      const ts = [...s.matchAll(/^\| ([A-Z][^|]+?) \| /gm)].map((m) => m[1]!).filter((t) => t !== 'Term');
      expect(ts).toEqual([...ts].sort((a, b) => a.localeCompare(b)));
    }
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe('affiliation', () => {
  it('the product page and the app\'s front door both say no college is affiliated, and where facts came from', async () => {
    const { NOT_AFFILIATED, productPage, startPage } = await import('../../apps/advocate/src/server/product.js');
    const product = productPage({ app: '/a', docs: '/d', factory: '/f', factoryPage: (p) => p, admin: '/a/admin/', fontBase: '', live: true });
    const start = startPage({ app: '/a', admin: '/a/admin/', fontBase: '', product: '/p', reference: '/r', live: true });
    for (const page of [product, start]) {
      expect(page).toContain(NOT_AFFILIATED.body);
      expect(NOT_AFFILIATED.body).toMatch(/Not affiliated with any educational institution/);
      expect(NOT_AFFILIATED.body).toMatch(/public sources/);
    }
  });
});
