// Verifies docs/testing/ci.md
import { describe, expect, it } from 'vitest';
import { measure } from '../ci-cost.js';

describe('factory compute cost', () => {
  const start = 1_800_000_000;
  it('multiplies elapsed minutes by the dated rate for the machine', () => {
    const r = measure({ CI_START: String(start), CI_MACHINE: 'E2_HIGHCPU_8', BUILD_ID: 'b1', COMMIT: 'c1' }, (start + 600) * 1000);
    expect(r.minutes).toBe(10);
    expect(r.costUsd).toBeCloseTo(0.156, 4);
    expect(r.kind).toBe('push');
  });
  it('labels nightly and manual runs', () => {
    expect(measure({ CI_START: String(start), CI_KIND: 'nightly', BUILD_ID: 'b' }, start * 1000).kind).toBe('nightly');
    expect(measure({ CI_START: String(start) }, start * 1000).kind).toBe('manual');
  });
  it('refuses a machine with no dated rate instead of guessing', () => {
    expect(() => measure({ CI_START: String(start), CI_MACHINE: 'N2_HUGE' })).toThrow(/No dated rate/);
  });
});
