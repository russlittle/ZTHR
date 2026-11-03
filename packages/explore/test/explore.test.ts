// Verifies docs/blocks/explore.md (the exhaustive explorer).
import { describe, expect, it } from 'vitest';
import { explore } from '../src/index.js';

/** A tiny counter app: buttons inc, dec and reset; a planted bug crashes at 3. */
function counter(bugAt?: number) {
  return explore<{ n: number }, number>({
    seeds: [{ name: 'zero', make: () => ({ n: 0 }) }],
    actions: (w) => (w.n < 4 ? ['inc', 'dec', 'reset'] : ['reset']),
    perform: (w, a) => {
      if (a === 'inc') w.n++;
      if (a === 'dec') w.n = Math.max(0, w.n - 1);
      if (a === 'reset') w.n = 0;
      if (w.n === bugAt) throw new Error('boom');
      return w.n;
    },
    signature: (w) => String(w.n),
    check: (w) => (w.n < 0 ? ['negative'] : []),
  });
}

describe('explore', () => {
  it('reaches every state and stops at the fixpoint', () => {
    const r = counter();
    expect(r.states).toBe(5);
    expect(r.exhausted).toBe(true);
    expect(r.violations).toEqual([]);
  });
  it('reports a crash with the exact path that reached it', () => {
    const r = counter(3);
    expect(r.violations[0]).toMatchObject({ path: ['inc', 'inc', 'inc'], problem: 'crashed: boom' });
  });
  it('reports, never hides, a search cut short', () => {
    const r = explore<{ n: number }, number>({ seeds: [{ name: 'up', make: () => ({ n: 0 }) }], actions: () => ['inc'], perform: (w) => ++w.n, signature: (w) => String(w.n), maxNodes: 10 });
    expect(r.exhausted).toBe(false);
  });
  it('counts verbs across parameterized actions', () => {
    const r = explore<{ n: number }, number>({ seeds: [{ name: 's', make: () => ({ n: 0 }) }], actions: (w) => (w.n ? [] : ['set:1', 'set:2']), perform: (w, a) => (w.n = Number(a.split(':')[1])), signature: (w) => String(w.n) });
    expect(r.verbsSeen.set).toBe(2);
  });
});

describe('explore with fork', () => {
  it('reaches the same states as replay, without replaying paths', () => {
    let performs = 0;
    const spec = (fork: boolean) =>
      explore<{ n: number }, number>({
        seeds: [{ name: 'z', make: () => ({ n: 0 }) }],
        actions: (w) => (w.n < 6 ? ['inc', 'reset'] : ['reset']),
        perform: (w, a) => (performs++, a === 'inc' ? ++w.n : (w.n = 0)),
        signature: (w) => String(w.n),
        freeze: fork ? (w) => ({ ...w }) : undefined,
        thaw: fork ? (f) => ({ ...(f as { n: number }) }) : undefined,
      });
    performs = 0;
    const replayed = spec(false);
    const viaReplay = performs;
    performs = 0;
    const forked = spec(true);
    expect(forked.states).toBe(replayed.states);
    expect(performs).toBeLessThan(viaReplay);
  });
});
