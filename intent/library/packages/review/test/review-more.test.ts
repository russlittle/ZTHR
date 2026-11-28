// Verifies docs/blocks/review.md
import { describe, expect, it } from 'vitest';
import { ModelUnavailable, TwinModelClient, type ModelClient } from '@zthr/models';
import { parseReview, promptFor, reviewPanel, reviewSeat, type Seat } from '../src/index.js';

const input = { diff: 'DIFF', intent: 'INTENT', context: 'CTX', repoFiles: { 'a.ts': 'A', 'b.ts': 'B' } };
const seat = (family: string, text: string, role: Seat['role'] = 'unaided'): Seat => ({ role, family, model: 'm', client: new TwinModelClient(() => text) });

describe('what each role may see', () => {
  it('context-aided sees intent, context and diff; unaided only the diff; independent and in-place the files', () => {
    expect(promptFor('context-aided', input)).toBe('Intent:\nINTENT\n\nContext:\nCTX\n\nDiff:\nDIFF');
    expect(promptFor('context-aided', { diff: 'D', intent: 'I' })).toBe('Intent:\nI\n\nContext:\n(none)\n\nDiff:\nD');
    expect(promptFor('unaided', input)).toBe('Diff:\nDIFF');
    expect(promptFor('independent', input)).toBe('Intent:\nINTENT\n\nResulting files:\n--- a.ts\nA\n--- b.ts\nB');
    expect(promptFor('in-place', input)).toBe('Intent:\nINTENT\n\nMerged files:\n--- a.ts\nA\n--- b.ts\nB');
    expect(promptFor('independent', { diff: 'D', intent: 'I' })).toBe('Intent:\nI\n\nResulting files:\n');
    expect(promptFor('unaided', input)).not.toContain('INTENT');
  });
});

describe('parsing a review', () => {
  it('reads the verdict and findings out of surrounding text, defaulting unknown severities to minor', () => {
    expect(parseReview('ok: {"verdict":"fail","findings":[{"severity":"blocker","summary":"x"},{"severity":"major"},{"severity":"odd","summary":3}]} thanks')).toEqual({ verdict: 'fail', findings: [{ severity: 'blocker', summary: 'x' }, { severity: 'major', summary: '' }, { severity: 'minor', summary: '3' }] });
    expect(parseReview('{"verdict":"pass"}')).toEqual({ verdict: 'pass', findings: [] });
  });
  it('anything else is unparseable', () => {
    for (const t of ['no json', '{"verdict":"maybe"}', '{not json}', '{}']) expect(parseReview(t)).toBeUndefined();
  });
});

describe('a seat', () => {
  it('passes with no blocking findings, and keeps minor ones', async () => {
    const r = await reviewSeat(seat('f1', '{"verdict":"pass","findings":[{"severity":"minor","summary":"nit"}]}'), input);
    expect(r.verdict).toMatchObject({ gate: 'review:unaided:f1', status: 'pass', reason: 'no blocking findings' });
    expect(r.findings).toEqual([{ severity: 'minor', summary: 'nit', seat: 'unaided', family: 'f1' }]);
  });
  it('fails on a fail verdict or any blocking finding, naming them', async () => {
    expect((await reviewSeat(seat('f', '{"verdict":"fail","findings":[]}'), input)).verdict).toMatchObject({ status: 'fail', reason: 'reviewer failed the change' });
    expect((await reviewSeat(seat('f', '{"verdict":"pass","findings":[{"severity":"major","summary":"leak"},{"severity":"blocker","summary":"bug"}]}'), input)).verdict).toMatchObject({ status: 'fail', reason: 'leak; bug' });
  });
  it('unparseable output, an unavailable provider or an error is unknown, never a pass', async () => {
    expect((await reviewSeat(seat('f', 'looks fine to me'), input)).verdict).toMatchObject({ status: 'unknown', reason: 'review output could not be parsed' });
    const down: ModelClient = { provider: 'x', complete: async () => { throw new ModelUnavailable('no key'); } };
    expect((await reviewSeat({ role: 'unaided', family: 'f', model: 'm', client: down }, input)).verdict).toMatchObject({ status: 'unknown', reason: 'provider unavailable: no key' });
    const broken: ModelClient = { provider: 'x', complete: async () => { throw new Error('boom'); } };
    expect((await reviewSeat({ role: 'unaided', family: 'f', model: 'm', client: broken }, input)).verdict).toMatchObject({ status: 'unknown', reason: 'review error: boom' });
  });
  it('sends the system prompt and the role\'s view, under a review purpose', async () => {
    let seen: { purpose?: string; messages?: { role: string; content: string }[] } = {};
    const client: ModelClient = { provider: 'x', complete: async (r) => ((seen = r), { text: '{"verdict":"pass"}', model: 'm', provider: 'x', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } }) };
    await reviewSeat({ role: 'context-aided', family: 'f', model: 'mm', client }, input);
    expect(seen.purpose).toBe('review:context-aided');
    expect(seen.messages![0]!.role).toBe('system');
    expect(seen.messages![0]!.content).toContain('zero-trust panel');
    expect(seen.messages![1]).toEqual({ role: 'user', content: promptFor('context-aided', input) });
  });
});

describe('the panel', () => {
  const ok = '{"verdict":"pass"}';
  it('needs three families before commit; in-place seats do not count', async () => {
    const r = await reviewPanel([seat('a', ok), seat('b', ok), seat('c', ok, 'in-place'), seat('a', ok, 'independent')], input);
    expect(r.verdict).toMatchObject({ status: 'fail', reason: 'only 2 model families before commit; three are required' });
  });
  it('passes when every pre-commit seat passes, and fails when any fails', async () => {
    expect((await reviewPanel([seat('a', ok), seat('b', ok, 'context-aided'), seat('c', ok, 'independent')], input)).verdict.status).toBe('pass');
    const r = await reviewPanel([seat('a', ok), seat('b', ok), seat('c', '{"verdict":"fail","findings":[{"severity":"blocker","summary":"x"}]}'), seat('d', '{"verdict":"fail"}', 'in-place')], input);
    expect(r.verdict.status).toBe('fail');
    expect(r.findings).toEqual([{ severity: 'blocker', summary: 'x', seat: 'unaided', family: 'c' }]);
  });
});
