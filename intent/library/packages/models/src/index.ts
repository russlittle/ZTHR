/**
 * Provider-neutral model access. Every call goes through `MeteredModel`, which
 * records tokens to the evidence ledger and enforces budgets as fixtures: a
 * spent budget is an explicit unresolved state, never a silent overrun.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  purpose: string;
  candidate?: string;
  studentMonth?: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

export interface ModelClient {
  readonly provider: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ModelUnavailable extends Error {}
export class BudgetExhausted extends Error {}

/**
 * Any OpenAI-compatible chat endpoint (OpenRouter by default; a self-hosted
 * server works the same way). Nothing in the factory requires it.
 */
export class OpenRouterClient implements ModelClient {
  readonly provider = 'openai-compatible';
  constructor(
    private readonly apiKey: string | undefined = process.env.REVIEW_API_KEY ?? process.env.OPENROUTER_API_KEY,
    private readonly baseUrl = process.env.REVIEW_BASE_URL || 'https://openrouter.ai/api/v1',
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new ModelUnavailable('no model provider configured (REVIEW_API_KEY)');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 800,
        temperature: req.temperature ?? 0.2,
        usage: { include: true },
      }),
    });
    if (!res.ok) throw new ModelUnavailable(`model provider ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      model: body.model ?? req.model,
      provider: this.provider,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}

/**
 * A twin of a model provider (Pattern 33): deterministic responses keyed by a
 * rule, with token counts estimated from text length so the ledger stays honest
 * about volume even offline.
 */
export class TwinModelClient implements ModelClient {
  readonly provider = 'twin';
  constructor(private readonly respond: (req: CompletionRequest) => string) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const text = this.respond(req);
    const input = req.messages.reduce((s, m) => s + m.content.length, 0);
    return {
      text,
      model: req.model,
      provider: this.provider,
      usage: { inputTokens: Math.ceil(input / 4), outputTokens: Math.ceil(text.length / 4), cachedTokens: 0 },
    };
  }
}

export interface Ledger {
  recordModelCall(c: {
    provider: string;
    model: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    candidate?: string;
    studentMonth?: string;
  }): void;
}

export interface Budget {
  /** Maximum tokens (input + output) per key per period. */
  maxTokens: number;
  key: (req: CompletionRequest) => string;
}

export class MeteredModel implements ModelClient {
  readonly provider: string;
  private readonly spent = new Map<string, number>();

  constructor(private readonly inner: ModelClient, private readonly ledger: Ledger, private readonly budgets: Budget[] = []) {
    this.provider = inner.provider;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    for (const b of this.budgets) {
      const k = b.key(req);
      if ((this.spent.get(k) ?? 0) >= b.maxTokens) throw new BudgetExhausted(`budget exhausted for ${k}`);
    }
    const r = await this.inner.complete(req);
    this.ledger.recordModelCall({
      provider: r.provider,
      model: r.model,
      purpose: req.purpose,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cachedTokens: r.usage.cachedTokens,
      candidate: req.candidate,
      studentMonth: req.studentMonth,
    });
    for (const b of this.budgets) {
      const k = b.key(req);
      this.spent.set(k, (this.spent.get(k) ?? 0) + r.usage.inputTokens + r.usage.outputTokens);
    }
    return r;
  }
}
