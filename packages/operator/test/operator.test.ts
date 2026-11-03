import { describe, expect, it } from 'vitest';
import { DocStore } from '@zthr/store';
import { Leases, MAX_ATTEMPTS, afterLookup, afterSend, due, exhausted, idempotencyKey, unsettled, type DispatchCore } from '../src/index.js';

// Verifies docs/blocks/operator.md
const t0 = new Date('2026-11-03T12:00:00Z');
const later = (ms: number) => new Date(t0.getTime() + ms);

describe('leases', () => {
  it('a free job is taken, with one beat and an expiry one lease-length out', () => {
    const l = new Leases(new DocStore(), 'a').take('j', t0)!;
    expect(l).toEqual({ job: 'j', holder: 'a', until: later(60_000).toISOString(), beats: 1 });
  });
  it('another holder cannot take an unexpired lease, and can once it lapses', () => {
    const s = new DocStore();
    new Leases(s, 'a').take('j', t0);
    expect(new Leases(s, 'b').take('j', later(59_999))).toBeUndefined();
    expect(new Leases(s, 'b').take('j', later(60_000))?.holder).toBe('b');
  });
  it('a lapsed lease taken by a new holder starts its beats again', () => {
    const s = new DocStore();
    const a = new Leases(s, 'a');
    a.take('j', t0);
    a.take('j', t0);
    expect(new Leases(s, 'b').take('j', later(70_000))?.beats).toBe(1);
  });
  it('the holder renews its own lease and counts the beat', () => {
    const s = new DocStore();
    const a = new Leases(s, 'a');
    a.take('j', t0);
    expect(a.take('j', later(10))?.beats).toBe(2);
  });
  it('a heartbeat extends only our own lease', () => {
    const s = new DocStore();
    const a = new Leases(s, 'a', { ms: 1000 });
    expect(a.beat('j', t0)).toBe(false);
    a.take('j', t0);
    expect(a.beat('j', later(500))).toBe(true);
    expect(s.get<{ until: string; beats: number }>('leases', 'j')).toMatchObject({ until: later(1500).toISOString(), beats: 2 });
    expect(new Leases(s, 'b').beat('j', later(600))).toBe(false);
  });
  it('release frees our lease but never another holder\'s', () => {
    const s = new DocStore();
    new Leases(s, 'a').take('j', t0);
    new Leases(s, 'b').release('j');
    expect(s.get('leases', 'j')).toBeDefined();
    new Leases(s, 'a').release('j');
    expect(s.get('leases', 'j')).toBeUndefined();
  });
  it('honors a custom collection and owner', () => {
    const s = new DocStore();
    new Leases(s, 'a', { collection: 'locks', owner: 'sys' }).take('j', t0);
    expect(s.list('locks', 'sys')).toHaveLength(1);
    expect(s.get('leases', 'j')).toBeUndefined();
  });
  it('run reports ran, skipped or failed, and always releases', async () => {
    const s = new DocStore();
    const a = new Leases(s, 'a');
    let calls = 0;
    expect(await a.run('j', t0, async () => void calls++)).toEqual({ status: 'ran' });
    expect(s.get('leases', 'j')).toBeUndefined();
    expect(await a.run('j', t0, async () => { throw new Error('boom'); })).toEqual({ status: 'failed', reason: 'boom' });
    expect(s.get('leases', 'j')).toBeUndefined();
    new Leases(s, 'b').take('j', t0);
    expect(await a.run('j', t0, async () => void calls++)).toEqual({ status: 'skipped', reason: 'another operator holds the lease' });
    expect(calls).toBe(1);
  });
});

describe('dispatches', () => {
  const d0: DispatchCore<{ id?: string; reason?: string }> = { id: 'k', key: 'k', status: 'queued', attempts: 0 };
  it('the same owner, kind and request always gets the same 24-character key; anything different gets another', () => {
    const k = idempotencyKey('s1', 'room', { room: 'A', at: 1 });
    expect(k).toMatch(/^[0-9a-f]{24}$/);
    expect(idempotencyKey('s1', 'room', { room: 'A', at: 1 })).toBe(k);
    expect(idempotencyKey('s2', 'room', { room: 'A', at: 1 })).not.toBe(k);
    expect(idempotencyKey('s1', 'mentor', { room: 'A', at: 1 })).not.toBe(k);
    expect(idempotencyKey('s1', 'room', { room: 'B', at: 1 })).not.toBe(k);
  });
  it('due, unsettled and exhausted read the status and attempts', () => {
    const st = (status: DispatchCore<unknown>['status']) => ({ ...d0, status });
    expect(['queued', 'sent', 'ambiguous', 'confirmed', 'refused'].map((x) => due(st(x as never)))).toEqual([true, false, true, false, false]);
    expect(['queued', 'sent', 'ambiguous', 'confirmed', 'refused'].map((x) => unsettled(st(x as never)))).toEqual([false, true, true, false, false]);
    expect(MAX_ATTEMPTS).toBe(3);
    expect([2, 3, 4].map((attempts) => exhausted({ ...d0, attempts }))).toEqual([false, true, true]);
    expect(exhausted({ ...d0, attempts: 1 }, 1)).toBe(true);
  });
  it('a successful send is sent, not done, and counts the attempt', () => {
    expect(afterSend(d0, { ok: true, result: { id: 'r1' } }, () => ({}))).toEqual({ ...d0, status: 'sent', attempts: 1, result: { id: 'r1' } });
  });
  it('a 409 or 400 is a definite no, with the caller\'s reason', () => {
    for (const status of [409, 400]) expect(afterSend(d0, { ok: false, status, reason: 'x' }, (s): { id?: string; reason?: string } => ({ reason: `no ${s}` }))).toEqual({ ...d0, status: 'refused', attempts: 1, result: { reason: `no ${status}` } });
  });
  it('anything else is ambiguous: it may have happened, so it keeps its key', () => {
    for (const status of [0, 500, 503, 404]) {
      const n = afterSend({ ...d0, attempts: 1 }, { ok: false, status, reason: 'timed out' }, (): { id?: string; reason?: string } => ({ reason: 'never' }));
      expect(n).toEqual({ ...d0, status: 'ambiguous', attempts: 2, result: { reason: 'timed out' } });
    }
  });
  it('a lookup confirms or refuses; pending leaves it alone', () => {
    const sent = { ...d0, status: 'sent' as const, attempts: 1, result: { id: 'r1' } };
    expect(afterLookup(sent, { outcome: 'pending' })).toBe(sent);
    expect(afterLookup(sent, { outcome: 'confirmed', result: { id: 'r2' } })).toEqual({ ...sent, status: 'confirmed', result: { id: 'r2' } });
    expect(afterLookup(sent, { outcome: 'refused' })).toEqual({ ...sent, status: 'refused', result: { id: 'r1' } });
  });
});
