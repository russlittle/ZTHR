import { describe, expect, it } from 'vitest';
import { EvidenceStore } from '@zthr/evidence';
import { BudgetExhausted, MeteredModel, OpenRouterClient, TwinModelClient, ModelUnavailable } from '@zthr/models';

describe('metered models', () => {
  it('records every call and enforces budgets', async () => {
    const ev = new EvidenceStore();
    const m = new MeteredModel(new TwinModelClient(() => 'x'.repeat(400)), ev, [{ maxTokens: 100, key: (r) => r.studentMonth ?? 'all' }]);
    await m.complete({ model: 'twin', purpose: 'draft', messages: [{ role: 'user', content: 'hello' }], studentMonth: 's1:2026-11' });
    expect(ev.modelCalls()).toHaveLength(1);
    await expect(m.complete({ model: 'twin', purpose: 'draft', messages: [{ role: 'user', content: 'again' }], studentMonth: 's1:2026-11' })).rejects.toBeInstanceOf(BudgetExhausted);
  });
  it('a missing key is reported as unavailable, not as an empty answer', async () => {
    await expect(new OpenRouterClient('').complete({ model: 'x', purpose: 'p', messages: [] })).rejects.toBeInstanceOf(ModelUnavailable);
  });
});
