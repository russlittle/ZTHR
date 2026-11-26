// Verifies docs/blocks/models.md
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExhausted, MeteredModel, ModelUnavailable, OpenRouterClient, TwinModelClient, type CompletionRequest, type Ledger } from '@zthr/models';

afterEach(() => vi.unstubAllGlobals());
const req = (over: Partial<CompletionRequest> = {}): CompletionRequest => ({ model: 'm', purpose: 'p', messages: [{ role: 'user', content: 'abcdefgh' }], ...over });

describe('twin model', () => {
  it('answers by rule and estimates tokens at four characters each, rounding up', async () => {
    const t = new TwinModelClient((r) => `echo ${r.purpose}`);
    expect(t.provider).toBe('twin');
    expect(await t.complete(req({ messages: [{ role: 'system', content: 'abc' }, { role: 'user', content: 'defgh' }] }))).toEqual({ text: 'echo p', model: 'm', provider: 'twin', usage: { inputTokens: 2, outputTokens: 2, cachedTokens: 0 } });
    expect((await t.complete(req({ messages: [{ role: 'user', content: 'abcde' }] }))).usage.inputTokens).toBe(2);
  });
});

describe('openai-compatible client', () => {
  it('posts the conversation with defaults and reads text, model and usage', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', async (u: string, i: RequestInit) => (calls.push([u, i]), new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], model: 'served', usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }))));
    const c = new OpenRouterClient('k', 'https://x.io/v1');
    expect(c.provider).toBe('openai-compatible');
    expect(await c.complete(req())).toEqual({ text: 'hi', model: 'served', provider: 'openai-compatible', usage: { inputTokens: 7, outputTokens: 3, cachedTokens: 2 } });
    expect(calls[0]![0]).toBe('https://x.io/v1/chat/completions');
    expect(calls[0]![1].method).toBe('POST');
    expect(calls[0]![1].headers).toEqual({ authorization: 'Bearer k', 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ model: 'm', messages: [{ role: 'user', content: 'abcdefgh' }], max_tokens: 800, temperature: 0.2, usage: { include: true } });
  });
  it('passes the caller\'s limits, and falls back when the answer is sparse', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_u: string, i: RequestInit) => ((body = JSON.parse(String(i.body))), new Response('{}')));
    expect(await new OpenRouterClient('k', 'https://x.io').complete(req({ maxTokens: 50, temperature: 0 }))).toEqual({ text: '', model: 'm', provider: 'openai-compatible', usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } });
    expect(body).toMatchObject({ max_tokens: 50, temperature: 0 });
  });
  it('a provider error is unavailable, with the status and the start of the body', async () => {
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(300), { status: 429 }));
    await expect(new OpenRouterClient('k', 'https://x.io').complete(req())).rejects.toThrow(`model provider 429: ${'x'.repeat(200)}`);
    await expect(new OpenRouterClient(undefined, 'https://x.io').complete(req())).rejects.toBeInstanceOf(process.env.REVIEW_API_KEY || process.env.OPENROUTER_API_KEY ? Error : ModelUnavailable);
  });
});

describe('metering and budgets', () => {
  const ledger = (): Ledger & { calls: unknown[] } => { const calls: unknown[] = []; return { calls, recordModelCall: (c) => void calls.push(c) }; };
  it('records each call with who it was for, and keeps the provider name', async () => {
    const l = ledger();
    const m = new MeteredModel(new TwinModelClient(() => 'abcd'), l);
    expect(m.provider).toBe('twin');
    await m.complete(req({ candidate: 'c1', studentMonth: 's:2026-11' }));
    expect(l.calls).toEqual([{ provider: 'twin', model: 'm', purpose: 'p', inputTokens: 2, outputTokens: 1, cachedTokens: 0, candidate: 'c1', studentMonth: 's:2026-11' }]);
  });
  it('spends per key: one key exhausted leaves another open, and the limit is reached at exactly the maximum', async () => {
    const m = new MeteredModel(new TwinModelClient(() => 'abcd'), ledger(), [{ maxTokens: 6, key: (r) => r.studentMonth ?? 'all' }]);
    await m.complete(req({ studentMonth: 'a' }));
    await m.complete(req({ studentMonth: 'a' }));
    await expect(m.complete(req({ studentMonth: 'a' }))).rejects.toThrow('budget exhausted for a');
    await expect(m.complete(req({ studentMonth: 'b' }))).resolves.toBeDefined();
    const n = new MeteredModel(new TwinModelClient(() => 'abcd'), ledger(), [{ maxTokens: 3, key: () => 'k' }]);
    await n.complete(req());
    await expect(n.complete(req())).rejects.toBeInstanceOf(BudgetExhausted);
  });
  it('a failed call spends nothing and records nothing', async () => {
    const l = ledger();
    const m = new MeteredModel({ provider: 'x', complete: async () => { throw new ModelUnavailable('down'); } }, l, [{ maxTokens: 1, key: () => 'k' }]);
    await expect(m.complete(req())).rejects.toThrow('down');
    expect(l.calls).toEqual([]);
  });
});
