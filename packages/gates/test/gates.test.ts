// Verifies docs/blocks/gates.md
// Verifies docs/testing/mutation.md
import { describe, expect, it } from 'vitest';
import {
  checkDatum, checkRatchet, checkRegister, combine, fail, gateHash, pass, proveGate, runProvenGate, unknown, verifyFloorChange,
  contentHash, type Gate,
} from '@zthr/gates';

describe('three-valued verdicts', () => {
  it('unknown never becomes pass', () => {
    expect(combine('g', [pass('a'), unknown('b', 'x')]).status).toBe('unknown');
    expect(combine('g', []).status).toBe('unknown');
  });
  it('any fail is fail', () => {
    expect(combine('g', [pass('a'), unknown('b', 'x'), fail('c', 'y')]).status).toBe('fail');
  });
  it('all pass is pass', () => {
    expect(combine('g', [pass('a'), pass('b')]).status).toBe('pass');
  });
});

const noTodo: Gate<string> = {
  id: 'no-todo',
  protects: 'Source must not ship TODO markers.',
  definition: 'fail if the text contains TODO',
  check: (s) => (s.includes('TODO') ? fail('no-todo', 'found TODO') : pass('no-todo')),
  falsification: [{ name: 'planted TODO', plant: () => 'const x = 1; // TODO' }],
};

describe('falsification proofs', () => {
  it('proves a gate that catches its planted defect', async () => {
    const p = await proveGate(noTodo);
    expect(p.valid).toBe(true);
  });
  it('a gate that cannot fail is not proven', async () => {
    const blind: Gate<string> = { ...noTodo, id: 'blind', check: () => pass('blind') };
    expect((await proveGate(blind)).valid).toBe(false);
  });
  it('a gate with no planted defects is not proven', async () => {
    expect((await proveGate({ ...noTodo, falsification: [] })).valid).toBe(false);
  });
  it('green from an unproven gate is unknown', async () => {
    expect((await runProvenGate(noTodo, 'clean', undefined)).status).toBe('unknown');
  });
  it('a proof expires when the gate changes', async () => {
    const p = await proveGate(noTodo);
    const changed = { ...noTodo, definition: 'fail if the text contains TODO or FIXME' };
    expect(gateHash(changed as Gate<unknown>)).not.toBe(p.gateHash);
    expect((await runProvenGate(changed, 'clean', p)).status).toBe('unknown');
    expect((await runProvenGate(noTodo, 'clean', p)).status).toBe('pass');
  });
});

describe('ratchets', () => {
  const r = { id: 'lint', metric: 'findings', direction: 'down' as const, floor: 10 };
  it('fails when debt grows', () => expect(checkRatchet(r, 11).verdict.status).toBe('fail'));
  it('tightens automatically', () => expect(checkRatchet(r, 7).next.floor).toBe(7));
  it('unmeasured is unknown', () => expect(checkRatchet(r, undefined).verdict.status).toBe('unknown'));
  it('up-direction ratchets', () => {
    const m = { id: 'mut', metric: 'score', direction: 'up' as const, floor: 60 };
    expect(checkRatchet(m, 59).verdict.status).toBe('fail');
    expect(checkRatchet(m, 65).next.floor).toBe(65);
  });
  it('loosening needs a ledger entry by a listed person with a reason', () => {
    const after = { ...r, floor: 20 };
    expect(verifyFloorChange(r, after, [], ['russ']).status).toBe('fail');
    const entry = { ratchet: 'lint', from: 10, to: 20, by: 'russ', reason: 'new rule set imported; existing findings triaged', at: '2026-11-02' };
    expect(verifyFloorChange(r, after, [entry], ['russ']).status).toBe('pass');
    expect(verifyFloorChange(r, after, [{ ...entry, by: 'agent' }], ['russ']).status).toBe('fail');
    expect(verifyFloorChange(r, after, [{ ...entry, reason: 'x' }], ['russ']).status).toBe('fail');
  });
});

describe('datums and register', () => {
  it('measures against a fixed zone', () => {
    const d = { id: 'tone', measure: 'tone score', target: 0.95, min: 0.9 };
    expect(checkDatum(d, 0.92).status).toBe('pass');
    expect(checkDatum(d, 0.85).status).toBe('fail');
    expect(checkDatum(d, undefined).status).toBe('unknown');
  });
  it('expired findings fail', () => {
    const now = new Date('2026-11-02');
    expect(checkRegister([{ id: 'a', gate: 'g', reason: 'r', owner: 'russ', expires: '2026-11-01' }], now).status).toBe('fail');
    expect(checkRegister([{ id: 'a', gate: 'g', reason: 'r', owner: 'russ', expires: '2026-12-01' }], now).status).toBe('pass');
  });
  it('content hashes ignore key order', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
});
