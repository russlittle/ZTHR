/** Fuzz: full-text search (blocks/search Index.search, snippet). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Index, type Doc } from '../../blocks/search/index.ts';
import { forAll, type Rand } from './harness.ts';

const VOCAB = ['budget', 'budgets', 'café', 'cafe', 'Renovation', 'photo', 'photos', 'invoice', 'plan', 'planning', 'secret', 'the', 'and', 'ÉCOLE', 'naïve', '中文', '😀', 'x1', '42'];
const HTML = ['<script>alert(1)</script>', '<mark>', '</mark>', '<b>', '<', '>', '&lt;', '&amp;', '"', "'", '<img src=x onerror=alert(1)>', '<<budget>>', '>budget<', 'budget<', '<mark>budget</mark>'];
const FACET = ['doc', 'image', 'ops', 'board', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

const text = (r: Rand) => r.array(0, 40, () => (r.bool(0.75) ? r.pick(VOCAB) : r.bool(0.7) ? r.pick(HTML) : r.text(1, 4))).join(r.pick([' ', ' ', '  ', '\n', ' — ']));

interface Case {
  readonly docs: Doc[];
  readonly hidden: string[];
  readonly query: string;
  readonly filters?: Record<string, string>;
}

const gen = (r: Rand): Case => {
  const docs = r.array(1, 25, (i) => ({
    id: `d${i}`,
    fields: { title: text(r), body: text(r) },
    ...(r.bool(0.8) ? { facets: { kind: r.pick(FACET), team: r.pick(FACET) } } : {}),
  }));
  const hidden = docs.filter(() => r.bool(0.4)).map((d) => d.id);
  const qw = r.array(1, 4, () => {
    const w = r.pick(VOCAB);
    return r.pick([w, w.slice(0, r.int(1, w.length)), `"${w} ${r.pick(VOCAB)}"`, r.pick(HTML)]);
  });
  const query = qw.join(' ') + r.pick(['', '', ' ']);
  return { docs, hidden, query, ...(r.bool(0.2) ? { filters: { kind: r.pick(FACET) } } : {}) };
};

const run = (c: Case, facets?: readonly string[]) => {
  const idx = new Index({ weights: { title: 3, body: 1 } });
  for (const d of c.docs) idx.add(d);
  const hidden = new Set(c.hidden);
  return idx.search(c.query, { canSee: (id) => !hidden.has(id), limit: 1000, ...(c.filters ? { filters: c.filters } : {}), ...(facets ? { facets } : {}) });
};

test('search never returns an id that canSee rejects, and every hit matches the filters (1000 cases)', async () => {
  await forAll('search canSee', {
    cases: 1000,
    gen,
    shrink: () => [],
    check: (c) => {
      const res = run(c);
      const hidden = new Set(c.hidden);
      for (const h of res.hits) {
        assert.ok(!hidden.has(h.id), `returned hidden ${h.id}`);
        if (c.filters) assert.equal(c.docs.find((d) => d.id === h.id)!.facets?.kind, c.filters.kind);
      }
      assert.equal(res.total, res.hits.length, 'total counts only what can be seen');
      for (let i = 1; i < res.hits.length; i++) assert.ok(res.hits[i - 1]!.score >= res.hits[i]!.score, 'not sorted by score');
    },
  });
});

test('snippets never carry an unescaped < or > from document text; only <mark> and </mark> tags (1000 cases)', async () => {
  await forAll('search snippet escaping', {
    cases: 1000,
    gen,
    shrink: () => [],
    check: (c) => {
      for (const h of run(c).hits) {
        const bare = h.snippet.replace(/<\/?mark>/g, '');
        assert.doesNotMatch(bare, /[<>]/, `snippet ${JSON.stringify(h.snippet)}`);
        // Marks are balanced and never nested.
        let open = false;
        for (const m of h.snippet.matchAll(/<(\/?)mark>/g)) {
          assert.equal(open, m[1] === '/', `unbalanced marks in ${JSON.stringify(h.snippet)}`);
          open = !open;
        }
        assert.equal(open, false);
      }
    },
  });
});

test('facet counts are whole numbers that add up to the matched documents carrying each facet (600 cases)', async () => {
  await forAll('search facet counts', {
    cases: 600,
    gen,
    shrink: () => [],
    check: (c) => {
      const res = run(c, ['kind', 'team']);
      for (const f of ['kind', 'team'] as const) {
        const counts = res.facets[f]!;
        for (const [v, n] of Object.entries(counts)) assert.ok(Number.isInteger(n) && n > 0, `${f}=${v} count ${String(n)}`);
        const want = new Map<string, number>();
        for (const h of res.hits) {
          const v = c.docs.find((d) => d.id === h.id)!.facets?.[f];
          if (v) want.set(v, (want.get(v) ?? 0) + 1);
        }
        assert.deepEqual(new Map(Object.entries(counts)), want);
      }
    },
  });
});
