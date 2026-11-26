// Verifies docs/blocks/gates.md
// Verifies docs/testing/mutation.md
import { describe, expect, it } from 'vitest';
import {
  checkDatum, checkRatchet, checkRegister, combine, fail, gateHash, pass, proveGate, runProvenGate, unknown, verifyFloorChange,
  contentHash, isAccepted, sha256, stableStringify, type Gate,
} from '@zthr/gates';
import { createHash } from 'node:crypto';

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
  it('a proof is pinned to the check and the planted defects, not only to the description', async () => {
    const p = await proveGate(noTodo);
    const looser = { ...noTodo, check: (s: string) => (s.includes('TODO!') ? fail('no-todo', 'TODO') : pass('no-todo', 'clean')) };
    expect(gateHash(looser as Gate<unknown>)).not.toBe(p.gateHash);
    const fewer = { ...noTodo, falsification: noTodo.falsification.map((f) => ({ ...f, plant: () => 'a TODO here' })) };
    expect(gateHash(fewer as Gate<unknown>)).not.toBe(p.gateHash);
    expect(gateHash(noTodo as Gate<unknown>)).toBe(p.gateHash);
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

describe('datums, stated rule by rule', () => {
  const zone = { id: 'tone', measure: 'tone score', target: 0.95, min: 0.9, max: 1 };
  it('a value on each bound is inside the zone; one step past either bound is outside', () => {
    const atMin = checkDatum(zone, 0.9);
    expect(atMin).toMatchObject({ gate: 'datum:tone', status: 'pass', reason: 'tone score 0.9 within zone (target 0.95)' });
    expect(checkDatum(zone, 1)).toMatchObject({ status: 'pass', reason: 'tone score 1 within zone (target 0.95)' });
    expect(checkDatum(zone, 0.89)).toMatchObject({ gate: 'datum:tone', status: 'fail', reason: 'tone score 0.89 below 0.9' });
    expect(checkDatum(zone, 1.01)).toMatchObject({ gate: 'datum:tone', status: 'fail', reason: 'tone score 1.01 above 1' });
  });
  it('an unmeasured or NaN value is unknown, named by its measure', () => {
    expect(checkDatum(zone, undefined)).toMatchObject({ gate: 'datum:tone', status: 'unknown', reason: 'tone score not measured' });
    expect(checkDatum(zone, Number.NaN)).toMatchObject({ status: 'unknown', reason: 'tone score not measured' });
  });
  it('an omitted bound limits nothing on its side', () => {
    const floorOnly = { id: 'f', measure: 'm', target: 5, min: 3 };
    expect(checkDatum(floorOnly, 1e9).status).toBe('pass');
    expect(checkDatum(floorOnly, 2).status).toBe('fail');
    const ceilingOnly = { id: 'c', measure: 'm', target: 5, max: 7 };
    expect(checkDatum(ceilingOnly, -1e9).status).toBe('pass');
    expect(checkDatum(ceilingOnly, 8)).toMatchObject({ status: 'fail', reason: 'm 8 above 7' });
    expect(checkDatum({ id: 'n', measure: 'm', target: 5 }, 123)).toMatchObject({ status: 'pass', reason: 'm 123 within zone (target 5)' });
  });
});

describe('the findings register, stated rule by rule', () => {
  const now = new Date('2026-11-02T00:00:00.000Z');
  const row = (id: string, expires: string, more: Partial<{ owner: string; reason: string }> = {}) =>
    ({ id, gate: 'g', reason: 'accepted while the upstream fix lands', owner: 'russ', expires, ...more });
  it('a finding expiring at this very moment has expired; one a millisecond later has not', () => {
    const atNow = checkRegister([row('a', '2026-11-02T00:00:00.000Z')], now);
    expect(atNow).toMatchObject({ gate: 'findings-register', status: 'fail', reason: 'expired findings: a' });
    const later = checkRegister([row('a', '2026-11-02T00:00:00.001Z')], now);
    expect(later).toMatchObject({ gate: 'findings-register', status: 'pass', reason: '1 registered findings, none expired' });
  });
  it('every expired finding is named, in order, and only those', () => {
    const v = checkRegister([row('a', '2026-01-01'), row('b', '2027-01-01'), row('c', '2026-02-01')], now);
    expect(v.reason).toBe('expired findings: a, c');
  });
  it('a finding with no owner, or no reason, fails on its own and is named', () => {
    expect(checkRegister([row('x', '2027-01-01', { owner: '' }), row('y', '2027-01-01')], now))
      .toMatchObject({ gate: 'findings-register', status: 'fail', reason: 'findings without owner or reason: x' });
    expect(checkRegister([row('x', '2027-01-01'), row('y', '2027-01-01', { reason: '' })], now).reason)
      .toBe('findings without owner or reason: y');
    expect(checkRegister([row('x', '2027-01-01', { owner: '' }), row('y', '2027-01-01', { reason: '' })], now).reason)
      .toBe('findings without owner or reason: x, y');
  });
  it('an empty register passes and says so', () => {
    expect(checkRegister([], now)).toMatchObject({ status: 'pass', reason: '0 registered findings, none expired' });
  });
  it('a finding is accepted only while it is registered and current', () => {
    const entries = [row('a', '2026-11-02T00:00:00.001Z'), row('b', '2026-11-02T00:00:00.000Z')];
    expect(isAccepted(entries, 'a', now)).toBe(true);
    expect(isAccepted(entries, 'b', now)).toBe(false);
    expect(isAccepted(entries, 'c', now)).toBe(false);
    expect(isAccepted([row('b', '2026-01-01'), row('a', '2027-01-01')], 'a', now)).toBe(true);
    expect(isAccepted([row('a', '2027-01-01'), row('b', '2026-01-01')], 'b', now)).toBe(false);
    expect(isAccepted([], 'a', now)).toBe(false);
  });
});

describe('ratchets and resets, word for word', () => {
  const down = { id: 'lint', metric: 'findings', direction: 'down' as const, floor: 10 };
  const up = { id: 'mut', metric: 'score', direction: 'up' as const, floor: 60 };
  it('each verdict names its ratchet and states its reason', () => {
    expect(checkRatchet(down, undefined).verdict).toMatchObject({ gate: 'ratchet:lint', status: 'unknown', reason: 'no measurement for findings' });
    expect(checkRatchet(down, 12).verdict).toMatchObject({ gate: 'ratchet:lint', reason: 'findings is 12, worse than the floor 10' });
    expect(checkRatchet(up, 59).verdict.reason).toBe('score is 59, worse than the floor 60');
  });
  it('an up ratchet at its floor holds and passes', () => {
    expect(checkRatchet(up, 60).verdict).toMatchObject({ gate: 'ratchet:mut', status: 'pass', reason: 'held at 60' });
  });
  it('an up floor left where it was needs no entry', () => {
    expect(verifyFloorChange(up, { ...up, floor: 60 }, [], [])).toMatchObject({ gate: 'ratchet-reset:mut', status: 'pass', reason: 'floor held or tightened' });
  });
  const entry = { ratchet: 'lint', from: 10, to: 20, by: 'russ', reason: 'new rule set imported; findings triaged', at: '2026-11-02' };
  it('the entry must match the floor it loosens from, as well as to', () => {
    expect(verifyFloorChange(down, { ...down, floor: 20 }, [{ ...entry, from: 12 }], ['russ']))
      .toMatchObject({ gate: 'ratchet-reset:lint', status: 'fail', reason: 'floor loosened 10 -> 20 without a reset ledger entry' });
  });
  it('a reset by someone not listed is refused by name', () => {
    expect(verifyFloorChange(down, { ...down, floor: 20 }, [{ ...entry, by: 'agent' }], ['russ']).reason)
      .toBe('reset by "agent", who is not a listed person');
  });
  it('a reason of 20 characters is enough, 19 is not, and surrounding spaces do not count', () => {
    const at = (reason: string) => verifyFloorChange(down, { ...down, floor: 20 }, [{ ...entry, reason }], ['russ']);
    expect(at('a'.repeat(20))).toMatchObject({ status: 'pass', reason: `reset by russ: ${'a'.repeat(20)}` });
    expect(at('a'.repeat(19))).toMatchObject({ status: 'fail', reason: 'reset reason is missing or too short to audit' });
    expect(at(`  ${'a'.repeat(19)}   `).status).toBe('fail');
  });
  it('an accepted reset states who made it and why', () => {
    expect(verifyFloorChange(down, { ...down, floor: 20 }, [entry], ['russ']).reason).toBe('reset by russ: new rule set imported; findings triaged');
  });
});

describe('combined unknowns', () => {
  it('every unknown is named, separated by a semicolon', () => {
    expect(combine('all', [unknown('a', 'no data'), pass('b'), unknown('c', 'not run')]).reason).toBe('a: no data; c: not run');
  });
});

describe('stable content hashes, stated rule by rule', () => {
  it('a scalar or null is written as JSON', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('a')).toBe('"a"');
    expect(stableStringify(3)).toBe('3');
    expect(stableStringify(true)).toBe('true');
  });
  it('keys are sorted, nested objects too, and a key with no value is left out', () => {
    expect(stableStringify({ c: 3, a: 1, b: { z: 1, y: [2, 1] }, d: undefined })).toBe('{"a":1,"b":{"y":[2,1],"z":1},"c":3}');
    expect(stableStringify({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    expect(stableStringify({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(stableStringify({})).toBe('{}');
  });
  it('a key compares by its characters, so equal keys cannot appear and an upper-case key sorts first', () => {
    expect(stableStringify({ b: 1, B: 2, a: 3 })).toBe('{"B":2,"a":3,"b":1}');
  });
  it('arrays keep their order and their values are written stably', () => {
    expect(stableStringify([3, { b: 1, a: 2 }, null])).toBe('[3,{"a":2,"b":1},null]');
    expect(stableStringify([])).toBe('[]');
  });
  it('sha256 is the hex digest, of text or of bytes', () => {
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(sha256('abc')).toBe(abc);
    expect(sha256(Buffer.from('abc'))).toBe(abc);
  });
  it('a content hash is the digest of the stable text', () => {
    expect(contentHash({ b: 2, a: 1 })).toBe(createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe('gate identity and proofs, stated rule by rule', () => {
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  it("a gate's hash is its id, purpose, definition, check and each planted defect, one per line", () => {
    const bare = { id: 'g', protects: 'p', definition: 'd' };
    expect(gateHash(bare)).toBe(digest('g\np\nd\n'));
    const check = () => pass('g');
    const plant = () => 'x';
    const full = { ...bare, check, falsification: [{ name: 'one', plant }, { name: 'two', plant }] };
    expect(gateHash(full)).toBe(digest(['g', 'p', 'd', String(check), `one\n${String(plant)}`, `two\n${String(plant)}`].join('\n')));
  });
  it('a proof names the gate, its hash, and each planted case with its status and reason', async () => {
    const before = Date.now();
    const p = await proveGate(noTodo);
    expect(p).toMatchObject({ gate: 'no-todo', gateHash: gateHash(noTodo as Gate<unknown>), valid: true });
    expect(p.cases).toEqual([{ name: 'planted TODO', status: 'fail', reason: 'found TODO' }]);
    expect(Date.parse(p.provenAt)).toBeGreaterThanOrEqual(before - 1000);
  });
  it('a planted defect that throws, in the plant or the check, is unknown with the error stated, and the gate is not proven', async () => {
    const throwsInCheck: Gate<string> = { ...noTodo, check: () => { throw new Error('boom'); } };
    const p = await proveGate(throwsInCheck);
    expect(p.cases).toEqual([{ name: 'planted TODO', status: 'unknown', reason: 'check threw on planted defect: boom' }]);
    expect(p.valid).toBe(false);
    const throwsInPlant: Gate<string> = { ...noTodo, falsification: [{ name: 'bad plant', plant: () => { throw new Error('no subject'); } }] };
    expect((await proveGate(throwsInPlant)).cases[0]).toEqual({ name: 'bad plant', status: 'unknown', reason: 'check threw on planted defect: no subject' });
  });
  it('one caught case does not prove a gate whose other case slips through', async () => {
    const half: Gate<string> = { ...noTodo, falsification: [...noTodo.falsification, { name: 'no marker', plant: () => 'clean' }] };
    const p = await proveGate(half);
    expect(p.cases.map((c) => c.status)).toEqual(['fail', 'pass']);
    expect(p.valid).toBe(false);
    const both: Gate<string> = { ...noTodo, falsification: [...noTodo.falsification, { name: 'second', plant: () => 'TODO again' }] };
    expect((await proveGate(both)).valid).toBe(true);
  });
  it('an unproven, expired or failed proof each give their own verdict, word for word', async () => {
    expect(await runProvenGate(noTodo, 'clean', undefined)).toMatchObject({ gate: 'no-todo', status: 'unknown', reason: 'gate has no falsification proof' });
    const p = await proveGate(noTodo);
    const changed = { ...noTodo, protects: 'something else' };
    expect(await runProvenGate(changed, 'clean', p)).toMatchObject({ gate: 'no-todo', status: 'unknown', reason: 'falsification proof expired: gate changed since it was proven' });
    const failed = { ...p, valid: false };
    const v = await runProvenGate(noTodo, 'clean', failed);
    expect(v).toMatchObject({ gate: 'no-todo', status: 'fail', reason: 'gate failed its own falsification proof' });
    expect(v.evidence).toBe(failed);
  });
  it("a proven gate gives its own check's verdict, and a check that throws is unknown with the error stated", async () => {
    const p = await proveGate(noTodo);
    expect(await runProvenGate(noTodo, 'a TODO', p)).toMatchObject({ gate: 'no-todo', status: 'fail', reason: 'found TODO' });
    const flaky: Gate<string> = { ...noTodo, check: (s) => { if (s === 'live') throw new Error('timeout'); return fail('no-todo', 'x'); } };
    const fp = await proveGate(flaky);
    expect(fp.valid).toBe(true);
    expect(await runProvenGate(flaky, 'live', fp)).toMatchObject({ gate: 'no-todo', status: 'unknown', reason: 'gate check threw: timeout' });
  });
});
