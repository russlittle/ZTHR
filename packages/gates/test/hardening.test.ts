// Verifies docs/testing/gates.md
// Verifies docs/blocks/gates.md
import { describe, expect, it } from 'vitest';
import { admits, checkRatchet, combine, fail, pass, unknown, verifyFloorChange, verdict } from '@zthr/gates';

describe('ratchet edges', () => {
  const down = { id: 'r', metric: 'm', direction: 'down' as const, floor: 10 };
  const up = { id: 'u', metric: 'score', direction: 'up' as const, floor: 60 };
  it('equal to the floor holds without changing it', () => {
    const r = checkRatchet(down, 10);
    expect(r.verdict.status).toBe('pass');
    expect(r.verdict.reason).toBe('held at 10');
    expect(r.next).toBe(down);
    expect(checkRatchet(up, 60).next).toBe(up);
  });
  it('one step worse fails in either direction, one step better tightens', () => {
    expect(checkRatchet(down, 10.5).verdict.status).toBe('fail');
    expect(checkRatchet(up, 59.5).verdict.status).toBe('fail');
    expect(checkRatchet(down, 9).verdict.reason).toBe('tightened 10 -> 9');
    expect(checkRatchet(up, 61).next.floor).toBe(61);
    expect(checkRatchet(down, Number.NaN).verdict.status).toBe('unknown');
  });
  it('floor changes: holding or tightening needs no entry; loosening an up ratchet does', () => {
    expect(verifyFloorChange(down, { ...down, floor: 10 }, [], []).status).toBe('pass');
    expect(verifyFloorChange(down, { ...down, floor: 8 }, [], []).status).toBe('pass');
    expect(verifyFloorChange(up, { ...up, floor: 70 }, [], []).status).toBe('pass');
    expect(verifyFloorChange(up, { ...up, floor: 50 }, [], ['russ']).status).toBe('fail');
    const e = { ratchet: 'u', from: 60, to: 50, by: 'russ', reason: 'mutation tool upgrade changed scoring rules', at: 'x' };
    expect(verifyFloorChange(up, { ...up, floor: 50 }, [e], ['russ']).status).toBe('pass');
    expect(verifyFloorChange(up, { ...up, floor: 50 }, [{ ...e, to: 40 }], ['russ']).status).toBe('fail');
    expect(verifyFloorChange(up, { ...up, floor: 50 }, [{ ...e, ratchet: 'other' }], ['russ']).status).toBe('fail');
  });
});

describe('verdict details', () => {
  it('builders set status, gate and reason', () => {
    expect(pass('g')).toMatchObject({ gate: 'g', status: 'pass', reason: 'ok' });
    expect(fail('g', 'r')).toMatchObject({ status: 'fail', reason: 'r' });
    expect(unknown('g', 'r')).toMatchObject({ status: 'unknown' });
    expect(verdict('g', 'pass', 'x', 1).evidence).toBe(1);
    expect(typeof pass('g').at).toBe('string');
  });
  it('combined reasons name the failing gates', () => {
    const v = combine('all', [pass('a'), fail('b', 'broken'), fail('c', 'worse')]);
    expect(v.reason).toBe('b: broken; c: worse');
    expect(combine('all', [pass('a'), unknown('b', 'no data')]).reason).toBe('b: no data');
    expect(combine('all', [pass('a'), pass('b')]).reason).toBe('2 checks passed');
    expect(combine('all', []).reason).toBe('no verdicts were produced');
  });
  it('only pass admits', () => {
    expect(admits(pass('a'))).toBe(true);
    expect(admits(unknown('a', 'x'))).toBe(false);
    expect(admits(fail('a', 'x'))).toBe(false);
  });
});
