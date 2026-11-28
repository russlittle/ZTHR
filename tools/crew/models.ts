/**
 * One-shot completions from any catalogue model, for judges and reviewers: Claude through the Messages API on Vertex
 * (rawPredict), everything else through Vertex's OpenAI-compatible endpoint. Returns the text, the provider's
 * response id and the token counts the cost is worked out from.
 */
import type { Model } from '../../intent/blocks/router/index.ts';
import { anthropicUrl, openapiBase, vertexHostAllowed } from './lib.ts';

export interface Completion {
  text: string;
  provider: 'vertex-anthropic' | 'vertex-openapi';
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type Complete = (m: Model, system: string, user: string, maxTokens?: number) => Promise<Completion>;

async function post(f: typeof fetch, url: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  if (!vertexHostAllowed(url)) throw new Error(`refusing an endpoint outside Vertex AI: ${url}`);
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await f(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
    if (res.ok) return (await res.json()) as Record<string, unknown>;
    last = `${res.status} ${(await res.text()).slice(0, 400)}`;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new Error(`${url.split('/v1/')[0]}: ${last}`);
}

export function vertexComplete(project: string, token: () => Promise<string>, f: typeof fetch = fetch): Complete {
  return async (m, system, user, maxTokens = 4000) => {
    if (m.runner === 'claude-code') {
      const j = await post(f, anthropicUrl(project, m.vertexId, m.location), await token(), { anthropic_version: 'vertex-2023-10-16', max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: user }] });
      const usage = (j.usage ?? {}) as Record<string, number>;
      const text = ((j.content ?? []) as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      return { text, provider: 'vertex-anthropic', responseId: String(j.id ?? ''), inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, cacheReadTokens: usage.cache_read_input_tokens ?? 0 };
    }
    const j = await post(f, `${openapiBase(project, m.location)}/chat/completions`, await token(), { model: m.vertexId, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    const usage = (j.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const choice = ((j.choices ?? []) as { message?: { content?: string | null } }[])[0];
    return { text: choice?.message?.content ?? '', provider: 'vertex-openapi', responseId: String(j.id ?? ''), inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached), outputTokens: usage.completion_tokens ?? 0, cacheReadTokens: cached };
  };
}

/** The first JSON object in a model's reply, fenced or not; undefined if there is none that parses. */
export function firstJson(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    for (let end = candidate.lastIndexOf('}'); start >= 0 && end > start; end = candidate.lastIndexOf('}', end - 1)) {
      try {
        const v = JSON.parse(candidate.slice(start, end + 1)) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
      } catch {
        // try a shorter span
      }
    }
  }
  return undefined;
}
