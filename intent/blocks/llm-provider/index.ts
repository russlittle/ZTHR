/**
 * One interface over model vendors. A caller writes one request (system prompt, messages, tools, a JSON schema for
 * structured output) and gets one response shape back, whichever vendor answers: text, tool calls, finish reason,
 * token usage and the cost in USD. The same call can stream.
 *
 * Wire formats (documented vendor APIs; pure functions, no network inside this block):
 * - `openAiAdapter`: Chat Completions (`/v1/chat/completions`): messages, `tools` with `tool_calls`, `response_format`
 *   json_schema, streaming deltas with `stream_options.include_usage`.
 * - `anthropicAdapter`: Messages (`/v1/messages`): content blocks `text`, `tool_use`, `tool_result`, `tool_choice`,
 *   streaming events (`message_start`, `content_block_delta` with `text_delta` and `input_json_delta`, `message_delta`).
 *   Structured output is done the way that API supports it: a forced tool whose input schema is the schema.
 * The adapters take an injected `transport` (a function from request to response), so the caller owns the HTTP client,
 * proxy and API key handling. Keys are only put in the request headers the transport receives, never in errors or records.
 *
 * `TwinProvider` is a scripted stand-in for any vendor, with the same streaming and error behaviour, for tests and
 * for running the product with no keys.
 *
 * `LlmClient` adds what every product needs around a vendor call: a deadline, retries with full-jitter backoff
 * that honour Retry-After, a circuit breaker per model, an ordered list of fallback models (tried only for errors
 * another model could fix: overload, rate limits, timeouts, server errors, bad keys), usage records with cost, an
 * optional costmeter Meter feed, a spend ceiling, and structured output checked against a JSON Schema (json-schema
 * block) with a bounded number of repair attempts that show the model its own errors.
 *
 * Clock, sleep and randomness are injected. Out of scope: image and audio input, embeddings, vendor-specific
 * extras (thinking budgets, prompt-cache control markers, batch APIs), and automatic context trimming.
 */

import { Breaker, BreakerOpen, TimedOut, backoff, type RetryPolicy } from '../resilience/index.ts';
import type { Meter, Rate as MeterRate } from '../costmeter/index.ts';
import { compile as compileSchema, type SchemaValue } from '../json-schema/index.ts';

// ------------------------------------------------------------------ types

export type Part =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly id: string; readonly content: string; readonly isError?: boolean };

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: readonly Part[];
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments (an object schema). */
  readonly parameters: SchemaValue;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { readonly name: string };

export interface LlmRequest {
  /** A route name known to the client, or "provider/model". */
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly toolChoice?: ToolChoice;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stop?: readonly string[];
  /** Ask for JSON that matches this schema. */
  readonly responseSchema?: { readonly name: string; readonly schema: SchemaValue };
  /** For the cost record and the meter. */
  readonly feature?: string;
  readonly tenant?: string;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** Set when the model's arguments were not a JSON object; `arguments` is then empty. */
  readonly invalid?: string;
}

export interface LlmResponse {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly message: Message;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finish: FinishReason;
  readonly usage: Usage;
  readonly costUsd: number;
  /** The parsed, schema-checked value when `responseSchema` was given. */
  readonly structured?: unknown;
}

export type StreamEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'tool_call_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_call_delta'; readonly id: string; readonly argumentsDelta: string }
  | { readonly type: 'tool_call_end'; readonly call: ToolCall }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'done'; readonly response: LlmResponse };

export interface CallContext {
  readonly signal?: AbortSignal;
}

/** What a vendor adapter or twin offers; model names are the vendor's own. */
export interface Provider {
  readonly name: string;
  complete(req: LlmRequest, model: string, ctx: CallContext): Promise<LlmResponse>;
  stream(req: LlmRequest, model: string, ctx: CallContext): AsyncGenerator<StreamEvent>;
}

export interface ModelInfo {
  /** The vendor's model name. */
  readonly id: string;
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** Cache reads and writes as multiples of the input price (defaults 1). */
  readonly cacheReadMultiple?: number;
  readonly cacheWriteMultiple?: number;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
}

export type ErrorKind = 'rate_limit' | 'overloaded' | 'timeout' | 'auth' | 'bad_request' | 'content_filter' | 'server' | 'network' | 'invalid_response' | 'budget' | 'aborted';

export class ProviderError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(kind: ErrorKind, message: string, o: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.kind = kind;
    this.status = o.status;
    this.retryAfterMs = o.retryAfterMs;
  }
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'overloaded' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'network';
  }
}
export class InvalidRequest extends Error {}
export class StructuredOutputError extends Error {
  readonly problems: readonly string[];
  readonly lastText: string;
  constructor(message: string, problems: readonly string[], lastText: string) {
    super(message);
    this.problems = problems;
    this.lastText = lastText;
  }
}

// ------------------------------------------------------------------ helpers

/** A cheap token estimate (4 characters a token) for budgets and the twin; real counts come from the vendor. */
export const estimateTokens = (s: string): number => Math.ceil([...s].length / 4);

export const round9 = (usd: number): number => Math.round(usd * 1e9) / 1e9;

export function costOf(m: ModelInfo, u: Usage): number {
  for (const n of [u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0]) if (!(n >= 0) || !Number.isFinite(n)) throw new InvalidRequest('token counts must be finite and zero or more');
  const usd = (u.inputTokens * m.inputPerMTok + (u.cacheReadTokens ?? 0) * m.inputPerMTok * (m.cacheReadMultiple ?? 1) + (u.cacheWriteTokens ?? 0) * m.inputPerMTok * (m.cacheWriteMultiple ?? 1) + u.outputTokens * m.outputPerMTok) / 1e6;
  return round9(usd);
}

/** Meter rates for the token meters `llm.<model>.input` and `llm.<model>.output` (units are tokens). */
export function meterRates(models: readonly ModelInfo[]): MeterRate[] {
  return models.flatMap((m) => [
    { meter: `llm.${m.id}.input`, unit: 'token', microCentsPerUnit: m.inputPerMTok * 100 },
    { meter: `llm.${m.id}.output`, unit: 'token', microCentsPerUnit: m.outputPerMTok * 100 },
  ]);
}

/** Parses JSON, dropping `__proto__` keys so the result is safe to merge or spread. */
export function safeJson(text: string): unknown {
  return JSON.parse(text, (k, v: unknown) => (k === '__proto__' ? undefined : v));
}

/** Pulls a JSON value out of model text: the whole text, or the first fenced block. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try { return safeJson(t); } catch { /* try a fenced block */ }
  const m = /```(?:json)?\s*\n([\s\S]*?)\n?```/i.exec(t);
  if (m) return safeJson(m[1]!);
  throw new SyntaxError('the reply is not JSON');
}

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function checkRequest(req: LlmRequest): void {
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw new InvalidRequest('a request needs at least one message');
  if (req.messages.length > 5000) throw new InvalidRequest('a request may have at most 5000 messages');
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const [i, m] of req.messages.entries()) {
    if (m.role !== 'user' && m.role !== 'assistant') throw new InvalidRequest(`message ${i} has the role "${String(m.role)}"; use user or assistant (the system prompt goes in system)`);
    if (!Array.isArray(m.content) || m.content.length === 0) throw new InvalidRequest(`message ${i} has no content`);
    for (const p of m.content) {
      if (p.type === 'text') { if (typeof p.text !== 'string') throw new InvalidRequest(`message ${i} has a text part with no text`); }
      else if (p.type === 'tool_call') {
        if (m.role !== 'assistant') throw new InvalidRequest(`message ${i}: only the assistant makes tool calls`);
        if (!NAME.test(p.name)) throw new InvalidRequest(`message ${i}: "${String(p.name).slice(0, 40)}" is not a valid tool name`);
        if (typeof p.id !== 'string' || p.id === '') throw new InvalidRequest(`message ${i}: a tool call needs an id`);
        if (calls.has(p.id)) throw new InvalidRequest(`message ${i}: the tool call id ${p.id} is used twice`);
        calls.add(p.id);
      } else if (p.type === 'tool_result') {
        if (m.role !== 'user') throw new InvalidRequest(`message ${i}: tool results are sent as the user`);
        if (!calls.has(p.id)) throw new InvalidRequest(`message ${i}: the tool result ${String(p.id).slice(0, 40)} answers a call that was never made`);
        if (answered.has(p.id)) throw new InvalidRequest(`message ${i}: the tool call ${p.id} is answered twice`);
        answered.add(p.id);
      } else throw new InvalidRequest(`message ${i} has a part of an unknown type`);
    }
  }
  const names = new Set<string>();
  for (const t of req.tools ?? []) {
    if (!NAME.test(t.name)) throw new InvalidRequest(`"${String(t.name).slice(0, 40)}" is not a valid tool name (letters, digits, _ and -, up to 64)`);
    if (names.has(t.name)) throw new InvalidRequest(`the tool ${t.name} is listed twice`);
    names.add(t.name);
  }
  if (typeof req.toolChoice === 'object' && !names.has(req.toolChoice.name)) throw new InvalidRequest(`toolChoice names ${req.toolChoice.name}, which is not in tools`);
  if ((req.toolChoice === 'required' || typeof req.toolChoice === 'object') && !names.size) throw new InvalidRequest('toolChoice needs tools');
  if (req.maxTokens !== undefined && (!Number.isInteger(req.maxTokens) || req.maxTokens < 1 || req.maxTokens > 1_000_000)) throw new InvalidRequest('maxTokens must be a whole number from 1 to 1,000,000');
  if (req.temperature !== undefined && !(req.temperature >= 0 && req.temperature <= 2)) throw new InvalidRequest('temperature must be from 0 to 2');
  if (req.stop && (req.stop.length > 8 || req.stop.some((s) => typeof s !== 'string' || s === '' || s.length > 100))) throw new InvalidRequest('stop is at most 8 non-empty strings of at most 100 characters');
  if (req.responseSchema && !NAME.test(req.responseSchema.name)) throw new InvalidRequest('the response schema name must be letters, digits, _ and -');
}

const textOf = (parts: readonly Part[]): string => parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');

/** Removes secrets (API keys, bearer tokens) from text that may reach a log or an error. */
export function redact(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const k of secrets) if (k.length >= 6) out = out.split(k).join('[redacted]');
  return out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g, '[redacted]');
}

// ------------------------------------------------------------------ server-sent events

export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** Reads a text/event-stream (WHATWG): comments, CRLF, multi-line data, split chunks. Stops events over `maxBytes`. */
export async function* parseSse(source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>, maxBytes = 1_000_000): AsyncGenerator<SseEvent> {
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  let size = 0;
  let first = true;
  const flush = (): SseEvent | undefined => {
    if (data.length === 0) { event = undefined; return undefined; }
    const e = { event, data: data.join('\n') };
    event = undefined;
    data = [];
    size = 0;
    return e;
  };
  const line = (l: string): SseEvent | undefined => {
    if (l === '') return flush();
    if (l.startsWith(':')) return undefined;
    const c = l.indexOf(':');
    const field = c < 0 ? l : l.slice(0, c);
    let value = c < 0 ? '' : l.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    size += value.length;
    if (size > maxBytes) throw new ProviderError('invalid_response', `a stream event is larger than ${maxBytes} bytes`);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return undefined;
  };
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    if (first) { buf = buf.replace(/^﻿/, ''); first = false; }
    if (buf.length > maxBytes + 10_000 && !/[\r\n]/.test(buf)) throw new ProviderError('invalid_response', 'a stream line is too long');
    let m: RegExpExecArray | null;
    while ((m = /\r\n|\n|\r/.exec(buf))) {
      if (m[0] === '\r' && m.index === buf.length - 1) break; // maybe half of a CRLF
      const e = line(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (e) yield e;
    }
  }
  buf += dec.decode();
  buf = buf.replace(/\r$/, '');
  if (buf !== '') { const e = line(buf); if (e) yield e; }
  const last = flush();
  if (last) yield last;
}

// ------------------------------------------------------------------ transport and shared adapter code

export interface HttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly stream: boolean;
  readonly signal?: AbortSignal;
}
export interface HttpResponse {
  readonly status: number;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | AsyncIterable<Uint8Array | string>;
}
export type Transport = (r: HttpRequest) => Promise<HttpResponse>;

export interface AdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly transport: Transport;
  readonly models?: readonly ModelInfo[];
  readonly defaultMaxTokens?: number;
  /** Largest reply body read, in bytes (default 10 MB). */
  readonly maxBodyBytes?: number;
}

async function readBody(b: HttpResponse['body'], max: number): Promise<string> {
  if (typeof b === 'string') { if (b.length > max) throw new ProviderError('invalid_response', 'the reply is too large'); return b; }
  const dec = new TextDecoder();
  let out = '';
  for await (const c of b) {
    out += typeof c === 'string' ? c : dec.decode(c, { stream: true });
    if (out.length > max) throw new ProviderError('invalid_response', 'the reply is too large');
  }
  return out + dec.decode();
}

function retryAfter(h: Readonly<Record<string, string>>): number | undefined {
  const ms = h['retry-after-ms'];
  if (ms !== undefined && /^\d+(\.\d+)?$/.test(ms)) return Math.min(Number(ms), 600_000);
  const s = h['retry-after'];
  if (s !== undefined && /^\d+(\.\d+)?$/.test(s)) return Math.min(Number(s) * 1000, 600_000);
  return undefined;
}

/** Turns a failed HTTP reply into a ProviderError. The message never carries the key. */
export function httpError(status: number, headers: Readonly<Record<string, string>>, body: string, secrets: readonly string[] = []): ProviderError {
  let msg = '';
  try {
    const j = safeJson(body) as { error?: { message?: unknown } | string; message?: unknown };
    const e = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
    if (typeof e === 'string') msg = e;
  } catch { /* not JSON */ }
  msg = redact((msg || body).slice(0, 300).replace(/\s+/g, ' ').trim(), secrets) || `HTTP ${status}`;
  const ra = retryAfter(headers);
  const o = { status, ...(ra !== undefined ? { retryAfterMs: ra } : {}) };
  if (status === 401 || status === 403) return new ProviderError('auth', `the provider refused the key: ${msg}`, o);
  if (status === 429) return new ProviderError('rate_limit', `rate limited: ${msg}`, o);
  if (status === 529) return new ProviderError('overloaded', `the provider is overloaded: ${msg}`, o);
  if (status === 408 || status === 504) return new ProviderError('timeout', `the provider timed out: ${msg}`, o);
  if (status >= 500) return new ProviderError('server', `the provider failed (${status}): ${msg}`, o);
  return new ProviderError('bad_request', `the provider rejected the request (${status}): ${msg}`, o);
}

function parseArgs(raw: string): { arguments: Record<string, unknown>; invalid?: string } {
  if (raw.trim() === '') return { arguments: {} };
  try {
    const v = safeJson(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { arguments: {}, invalid: 'the arguments are JSON but not an object' };
    return { arguments: v as Record<string, unknown> };
  } catch { return { arguments: {}, invalid: 'the arguments are not valid JSON' }; }
}

const toolCall = (id: string, name: string, raw: string): ToolCall => ({ id, name, ...parseArgs(raw) });

/** Collects pieces of a streamed reply into a response. */
class Acc {
  text = '';
  readonly calls = new Map<string | number, { id: string; name: string; args: string }>();
  usage: Usage = { inputTokens: 0, outputTokens: 0 };
  finish: FinishReason = 'stop';
  id = '';
  model = '';
  build(provider: string, models: readonly ModelInfo[], requestedModel: string, structuredTool?: string): LlmResponse {
    let calls = [...this.calls.values()].map((c) => toolCall(c.id, c.name, c.args));
    let text = this.text;
    if (structuredTool) { const hit = calls.find((c) => c.name === structuredTool); if (hit) { text = JSON.stringify(hit.arguments); calls = calls.filter((c) => c !== hit); this.finish = 'stop'; } }
    return makeResponse(provider, models, this.id, this.model || requestedModel, text, calls, this.finish, this.usage);
  }
}

function makeResponse(provider: string, models: readonly ModelInfo[], id: string, model: string, text: string, calls: readonly ToolCall[], finish: FinishReason, usage: Usage): LlmResponse {
  const info = models.find((m) => m.id === model);
  const parts: Part[] = [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, arguments: c.arguments }))];
  return { id, provider, model, message: { role: 'assistant', content: parts.length ? parts : [{ type: 'text', text: '' }] }, text, toolCalls: calls, finish, usage, costUsd: info ? costOf(info, usage) : 0 };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (m: string) => new ProviderError('invalid_response', `the provider's reply was not understood: ${m}`);
const str = (v: unknown, what: string): string => { if (typeof v !== 'string') throw bad(`${what} is not text`); return v; };
const nat = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

async function send(o: AdapterOptions, url: string, headers: Record<string, string>, body: unknown, stream: boolean, ctx: CallContext): Promise<HttpResponse> {
  if (ctx.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
  let res: HttpResponse;
  try {
    res = await o.transport({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), stream, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (ctx.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
    throw new ProviderError('network', redact(e instanceof Error ? e.message : String(e), [o.apiKey]).slice(0, 300));
  }
  if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.headers, await readBody(res.body, 100_000).catch(() => ''), [o.apiKey]);
  return res;
}

// ------------------------------------------------------------------ OpenAI Chat Completions

export function toOpenAiBody(req: LlmRequest, model: string, o: { defaultMaxTokens?: number; strict?: boolean } = {}, stream = false): Record<string, unknown> {
  const messages: unknown[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const calls = m.content.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
      const text = textOf(m.content);
      messages.push({ role: 'assistant', content: text === '' && calls.length ? null : text, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) });
    } else {
      for (const p of m.content) if (p.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: p.id, content: p.isError ? `Error: ${p.content}` : p.content });
      const text = textOf(m.content);
      if (text !== '' || !m.content.some((p) => p.type === 'tool_result')) messages.push({ role: 'user', content: text });
    }
  }
  const body: Record<string, unknown> = { model, messages, max_tokens: req.maxTokens ?? o.defaultMaxTokens ?? 4096 };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop = [...req.stop];
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const c = req.toolChoice;
    if (c !== undefined) body.tool_choice = typeof c === 'object' ? { type: 'function', function: { name: c.name } } : c;
  }
  if (req.responseSchema) body.response_format = { type: 'json_schema', json_schema: { name: req.responseSchema.name, schema: req.responseSchema.schema, strict: o.strict ?? false } };
  if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
  return body;
}

const OPENAI_FINISH: Record<string, FinishReason> = { stop: 'stop', length: 'length', tool_calls: 'tool_calls', function_call: 'tool_calls', content_filter: 'content_filter' };

function openAiUsage(u: unknown): Usage {
  if (!isObj(u)) return { inputTokens: 0, outputTokens: 0 };
  const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const cached = nat(details.cached_tokens);
  return { inputTokens: Math.max(0, nat(u.prompt_tokens) - cached), outputTokens: nat(u.completion_tokens), ...(cached ? { cacheReadTokens: cached } : {}) };
}

export function fromOpenAiResponse(j: unknown, provider: string, requestedModel: string, models: readonly ModelInfo[] = []): LlmResponse {
  if (!isObj(j) || !Array.isArray(j.choices) || !isObj(j.choices[0])) throw bad('no choices');
  const ch = j.choices[0];
  const msg = isObj(ch.message) ? ch.message : undefined;
  if (!msg) throw bad('no message');
  const text = msg.content === null || msg.content === undefined ? '' : str(msg.content, 'content');
  const calls: ToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) for (const c of msg.tool_calls) {
    if (!isObj(c) || !isObj(c.function)) throw bad('a tool call has no function');
    calls.push(toolCall(str(c.id, 'a tool call id'), str(c.function.name, 'a tool name'), str(c.function.arguments ?? '', 'tool arguments')));
  }
  const finish = (typeof ch.finish_reason === 'string' ? OPENAI_FINISH[ch.finish_reason] : undefined) ?? (calls.length ? 'tool_calls' : 'stop');
  return makeResponse(provider, models, typeof j.id === 'string' ? j.id : '', typeof j.model === 'string' ? j.model : requestedModel, text, calls, finish, openAiUsage(j.usage));
}

export function openAiAdapter(o: AdapterOptions & { name?: string; strict?: boolean }): Provider {
  const name = o.name ?? 'openai';
  const url = `${(o.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const headers = { authorization: `Bearer ${o.apiKey}` };
  const max = o.maxBodyBytes ?? 10_000_000;
  const opts = { ...(o.defaultMaxTokens ? { defaultMaxTokens: o.defaultMaxTokens } : {}), ...(o.strict !== undefined ? { strict: o.strict } : {}) };
  return {
    name,
    async complete(req, model, ctx) {
      const res = await send(o, url, headers, toOpenAiBody(req, model, opts), false, ctx);
      let j: unknown;
      try { j = safeJson(await readBody(res.body, max)); } catch (e) { if (e instanceof ProviderError) throw e; throw bad('the body is not JSON'); }
      return fromOpenAiResponse(j, name, model, o.models);
    },
    async *stream(req, model, ctx) {
      const res = await send(o, url, headers, toOpenAiBody(req, model, opts, true), true, ctx);
      if (typeof res.body === 'string') throw bad('expected a stream');
      const acc = new Acc();
      for await (const ev of parseSse(res.body)) {
        if (ev.data === '[DONE]') break;
        let j: unknown;
        try { j = safeJson(ev.data); } catch { throw bad('a stream event is not JSON'); }
        if (!isObj(j)) continue;
        if (isObj(j.error)) throw new ProviderError('server', redact(String(j.error.message ?? 'the stream failed'), [o.apiKey]).slice(0, 300));
        if (typeof j.id === 'string') acc.id = j.id;
        if (typeof j.model === 'string') acc.model = j.model;
        if (j.usage) { acc.usage = openAiUsage(j.usage); yield { type: 'usage', usage: acc.usage }; }
        const ch = Array.isArray(j.choices) && isObj(j.choices[0]) ? j.choices[0] : undefined;
        if (!ch) continue;
        const d = isObj(ch.delta) ? ch.delta : {};
        if (typeof d.content === 'string' && d.content !== '') { acc.text += d.content; yield { type: 'text', delta: d.content }; }
        if (Array.isArray(d.tool_calls)) for (const t of d.tool_calls) {
          if (!isObj(t) || typeof t.index !== 'number') continue;
          let c = acc.calls.get(t.index);
          if (!c) { c = { id: typeof t.id === 'string' ? t.id : `call_${t.index}`, name: '', args: '' }; acc.calls.set(t.index, c); }
          const f = isObj(t.function) ? t.function : {};
          if (typeof f.name === 'string' && f.name) { const first = c.name === ''; c.name += f.name; if (first) yield { type: 'tool_call_start', id: c.id, name: c.name }; }
          if (typeof f.arguments === 'string' && f.arguments) { c.args += f.arguments; if (c.args.length > max) throw bad('tool arguments are too large'); yield { type: 'tool_call_delta', id: c.id, argumentsDelta: f.arguments }; }
        }
        if (typeof ch.finish_reason === 'string') acc.finish = OPENAI_FINISH[ch.finish_reason] ?? 'stop';
      }
      for (const c of acc.calls.values()) yield { type: 'tool_call_end', call: toolCall(c.id, c.name, c.args) };
      if (acc.calls.size && acc.finish === 'stop') acc.finish = 'tool_calls';
      yield { type: 'done', response: acc.build(name, o.models ?? [], model) };
    },
  };
}

// ------------------------------------------------------------------ Anthropic Messages

/** The name of the tool used to get structured output from the Messages API. */
export const STRUCTURED_TOOL = 'respond_with_json';

export function toAnthropicBody(req: LlmRequest, model: string, o: { defaultMaxTokens?: number } = {}, stream = false): Record<string, unknown> {
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: m.content.map((p) => p.type === 'text' ? { type: 'text', text: p.text }
      : p.type === 'tool_call' ? { type: 'tool_use', id: p.id, name: p.name, input: p.arguments }
      : { type: 'tool_result', tool_use_id: p.id, content: p.content, ...(p.isError ? { is_error: true } : {}) }),
  }));
  const body: Record<string, unknown> = { model, max_tokens: req.maxTokens ?? o.defaultMaxTokens ?? 4096, messages };
  if (req.system) body.system = req.system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop_sequences = [...req.stop];
  const tools: unknown[] = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  let choice: unknown;
  const c = req.toolChoice;
  if (c === 'auto') choice = { type: 'auto' };
  else if (c === 'none') choice = { type: 'none' };
  else if (c === 'required') choice = { type: 'any' };
  else if (c) choice = { type: 'tool', name: c.name };
  if (req.responseSchema) {
    if (req.tools?.some((t) => t.name === STRUCTURED_TOOL)) throw new InvalidRequest(`${STRUCTURED_TOOL} is reserved for structured output`);
    tools.push({ name: STRUCTURED_TOOL, description: `Reply with a JSON value that matches the ${req.responseSchema.name} schema.`, input_schema: req.responseSchema.schema });
    if (!req.tools?.length) choice = { type: 'tool', name: STRUCTURED_TOOL };
  }
  if (tools.length) body.tools = tools;
  if (choice) body.tool_choice = choice;
  if (stream) body.stream = true;
  return body;
}

const ANTHROPIC_FINISH: Record<string, FinishReason> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter', pause_turn: 'stop' };

function anthropicUsage(u: unknown): Usage {
  if (!isObj(u)) return { inputTokens: 0, outputTokens: 0 };
  const r = nat(u.cache_read_input_tokens), w = nat(u.cache_creation_input_tokens);
  return { inputTokens: nat(u.input_tokens), outputTokens: nat(u.output_tokens), ...(r ? { cacheReadTokens: r } : {}), ...(w ? { cacheWriteTokens: w } : {}) };
}

export function fromAnthropicResponse(j: unknown, provider: string, requestedModel: string, models: readonly ModelInfo[] = [], structured = false): LlmResponse {
  if (!isObj(j) || !Array.isArray(j.content)) throw bad('no content');
  let text = '';
  let calls: ToolCall[] = [];
  for (const b of j.content) {
    if (!isObj(b)) throw bad('a content block is not an object');
    if (b.type === 'text') text += str(b.text, 'text');
    else if (b.type === 'tool_use') {
      if (!isObj(b.input)) throw bad('tool input is not an object');
      calls.push({ id: str(b.id, 'a tool id'), name: str(b.name, 'a tool name'), arguments: safeJson(JSON.stringify(b.input)) as Record<string, unknown> });
    }
  }
  let finish = (typeof j.stop_reason === 'string' ? ANTHROPIC_FINISH[j.stop_reason] : undefined) ?? 'stop';
  if (structured) { const hit = calls.find((c) => c.name === STRUCTURED_TOOL); if (hit) { text = JSON.stringify(hit.arguments); calls = calls.filter((c) => c !== hit); if (!calls.length) finish = 'stop'; } }
  return makeResponse(provider, models, typeof j.id === 'string' ? j.id : '', typeof j.model === 'string' ? j.model : requestedModel, text, calls, finish, anthropicUsage(j.usage));
}

export function anthropicAdapter(o: AdapterOptions & { name?: string; version?: string }): Provider {
  const name = o.name ?? 'anthropic';
  const url = `${(o.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const headers = { 'x-api-key': o.apiKey, 'anthropic-version': o.version ?? '2023-06-01' };
  const max = o.maxBodyBytes ?? 10_000_000;
  const opts = o.defaultMaxTokens ? { defaultMaxTokens: o.defaultMaxTokens } : {};
  return {
    name,
    async complete(req, model, ctx) {
      const res = await send(o, url, headers, toAnthropicBody(req, model, opts), false, ctx);
      let j: unknown;
      try { j = safeJson(await readBody(res.body, max)); } catch (e) { if (e instanceof ProviderError) throw e; throw bad('the body is not JSON'); }
      return fromAnthropicResponse(j, name, model, o.models, !!req.responseSchema);
    },
    async *stream(req, model, ctx) {
      const res = await send(o, url, headers, toAnthropicBody(req, model, opts, true), true, ctx);
      if (typeof res.body === 'string') throw bad('expected a stream');
      const acc = new Acc();
      const kinds = new Map<number, 'text' | 'tool'>();
      const structured = !!req.responseSchema;
      for await (const ev of parseSse(res.body)) {
        let j: unknown;
        try { j = safeJson(ev.data); } catch { throw bad('a stream event is not JSON'); }
        if (!isObj(j)) continue;
        const idx = typeof j.index === 'number' ? j.index : -1;
        switch (j.type) {
          case 'message_start': {
            const m = isObj(j.message) ? j.message : {};
            if (typeof m.id === 'string') acc.id = m.id;
            if (typeof m.model === 'string') acc.model = m.model;
            acc.usage = anthropicUsage(m.usage);
            break;
          }
          case 'content_block_start': {
            const b = isObj(j.content_block) ? j.content_block : {};
            if (b.type === 'tool_use') {
              kinds.set(idx, 'tool');
              const c = { id: str(b.id, 'a tool id'), name: str(b.name, 'a tool name'), args: '' };
              acc.calls.set(idx, c);
              if (!(structured && c.name === STRUCTURED_TOOL)) yield { type: 'tool_call_start', id: c.id, name: c.name };
            } else { kinds.set(idx, 'text'); if (typeof b.text === 'string' && b.text) { acc.text += b.text; yield { type: 'text', delta: b.text }; } }
            break;
          }
          case 'content_block_delta': {
            const d = isObj(j.delta) ? j.delta : {};
            if (d.type === 'text_delta' && typeof d.text === 'string') { acc.text += d.text; yield { type: 'text', delta: d.text }; }
            else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const c = acc.calls.get(idx);
              if (c) { c.args += d.partial_json; if (c.args.length > max) throw bad('tool arguments are too large'); if (!(structured && c.name === STRUCTURED_TOOL)) yield { type: 'tool_call_delta', id: c.id, argumentsDelta: d.partial_json }; else yield { type: 'text', delta: d.partial_json }; }
            }
            break;
          }
          case 'message_delta': {
            const d = isObj(j.delta) ? j.delta : {};
            if (typeof d.stop_reason === 'string') acc.finish = ANTHROPIC_FINISH[d.stop_reason] ?? 'stop';
            const u = anthropicUsage(j.usage);
            acc.usage = { ...acc.usage, outputTokens: u.outputTokens || acc.usage.outputTokens };
            yield { type: 'usage', usage: acc.usage };
            break;
          }
          case 'error': {
            const e = isObj(j.error) ? j.error : {};
            const t = String(e.type ?? '');
            throw new ProviderError(t === 'overloaded_error' ? 'overloaded' : t === 'rate_limit_error' ? 'rate_limit' : t === 'authentication_error' ? 'auth' : t === 'invalid_request_error' ? 'bad_request' : 'server', redact(String(e.message ?? 'the stream failed'), [o.apiKey]).slice(0, 300));
          }
          default: break;
        }
      }
      for (const c of acc.calls.values()) if (!(structured && c.name === STRUCTURED_TOOL)) yield { type: 'tool_call_end', call: toolCall(c.id, c.name, c.args) };
      yield { type: 'done', response: acc.build(name, o.models ?? [], model, structured ? STRUCTURED_TOOL : undefined) };
    },
  };
}

// ------------------------------------------------------------------ twin

export interface TwinReplyData {
  readonly text?: string;
  /** Structured output: sent as JSON text. */
  readonly json?: unknown;
  readonly toolCalls?: readonly { readonly name: string; readonly arguments: Record<string, unknown>; readonly id?: string }[];
  readonly finish?: FinishReason;
  readonly usage?: Partial<Usage>;
  /** Streaming only: fail with this error after this many events have been sent. */
  readonly failAfterEvents?: number;
  readonly failWith?: ProviderError;
}
export type TwinReply = string | TwinReplyData | ProviderError;
export type TwinScript = readonly TwinReply[] | ((req: LlmRequest, call: number) => TwinReply);

/**
 * A scripted stand-in for a vendor. Replies are used in order (the last one repeats when `repeatLast` is set,
 * otherwise running out is a server error); a ProviderError in the script is thrown instead of answered. Token
 * counts are estimated from the text unless the reply gives them. It streams the same way the adapters do.
 */
export class TwinProvider implements Provider {
  readonly name: string;
  readonly calls: { readonly req: LlmRequest; readonly model: string; readonly stream: boolean }[] = [];
  private readonly script: TwinScript;
  private readonly o: { chunkSize: number; repeatLast: boolean; models: readonly ModelInfo[] };
  private n = 0;

  constructor(name: string, script: TwinScript, o: { chunkSize?: number; repeatLast?: boolean; models?: readonly ModelInfo[] } = {}) {
    this.name = name;
    this.script = script;
    this.o = { chunkSize: o.chunkSize ?? 8, repeatLast: o.repeatLast ?? false, models: o.models ?? [] };
    if (this.o.chunkSize < 1) throw new RangeError('chunkSize must be at least 1');
  }

  private next(req: LlmRequest, model: string, stream: boolean, ctx: CallContext): TwinReplyData {
    if (ctx.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
    this.calls.push({ req, model, stream });
    const i = this.n++;
    const r = typeof this.script === 'function' ? this.script(req, i) : this.script[Math.min(i, this.o.repeatLast ? this.script.length - 1 : i)];
    if (r === undefined) throw new ProviderError('server', `the twin has no reply for call ${i + 1}`);
    if (r instanceof ProviderError) throw r;
    return typeof r === 'string' ? { text: r } : r;
  }

  private build(req: LlmRequest, model: string, r: TwinReplyData, n: number): LlmResponse {
    const text = r.json !== undefined ? JSON.stringify(r.json) : r.text ?? '';
    const calls: ToolCall[] = (r.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `twin_${n}_${i}`, name: c.name, arguments: c.arguments }));
    const inTok = estimateTokens([req.system ?? '', ...req.messages.flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_call' ? JSON.stringify(p.arguments) : p.content)))].join('\n'));
    const outTok = estimateTokens(text + calls.map((c) => JSON.stringify(c.arguments)).join(''));
    const usage: Usage = { inputTokens: r.usage?.inputTokens ?? inTok, outputTokens: r.usage?.outputTokens ?? outTok, ...(r.usage?.cacheReadTokens ? { cacheReadTokens: r.usage.cacheReadTokens } : {}) };
    return makeResponse(this.name, this.o.models, `twin_${n}`, model, text, calls, r.finish ?? (calls.length ? 'tool_calls' : 'stop'), usage);
  }

  async complete(req: LlmRequest, model: string, ctx: CallContext): Promise<LlmResponse> {
    const n = this.n;
    const r = this.next(req, model, false, ctx);
    if (r.failWith) throw r.failWith;
    return this.build(req, model, r, n);
  }

  async *stream(req: LlmRequest, model: string, ctx: CallContext): AsyncGenerator<StreamEvent> {
    const n = this.n;
    const r = this.next(req, model, true, ctx);
    const res = this.build(req, model, r, n);
    let sent = 0;
    const gate = () => {
      if (ctx.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
      if (r.failAfterEvents !== undefined && sent >= r.failAfterEvents) throw r.failWith ?? new ProviderError('network', 'the twin dropped the stream');
      sent++;
    };
    const size = this.o.chunkSize;
    for (let i = 0; i < res.text.length; i += size) { gate(); yield { type: 'text', delta: res.text.slice(i, i + size) }; }
    for (const c of res.toolCalls) {
      gate();
      yield { type: 'tool_call_start', id: c.id, name: c.name };
      const raw = JSON.stringify(c.arguments);
      for (let i = 0; i < raw.length; i += size) { gate(); yield { type: 'tool_call_delta', id: c.id, argumentsDelta: raw.slice(i, i + size) }; }
      gate();
      yield { type: 'tool_call_end', call: c };
    }
    gate();
    yield { type: 'usage', usage: res.usage };
    if (r.failAfterEvents !== undefined && sent >= r.failAfterEvents) gate();
    yield { type: 'done', response: res };
  }
}

// ------------------------------------------------------------------ client

export interface Target {
  readonly provider: string;
  readonly model: string;
}

export interface ClientOptions {
  readonly providers: readonly Provider[];
  /** Prices by provider and vendor model name. */
  readonly models?: readonly (ModelInfo & { readonly provider: string })[];
  /** Route names to an ordered list: the first is tried first and the rest are fallbacks. */
  readonly routes?: Readonly<Record<string, readonly Target[]>>;
  readonly now: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Tries per model, the first included (default 3). */
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Longest wait a Retry-After may ask for (default 30 s); longer means fall back instead. */
  readonly maxRetryAfterMs?: number;
  /** Deadline for one call, or for the first event of a stream (default 60 s). */
  readonly timeoutMs?: number;
  /** Longest silence inside a stream (default: timeoutMs). */
  readonly idleTimeoutMs?: number;
  readonly breaker?: { readonly threshold: number; readonly coolDownMs: number };
  readonly meter?: Meter;
  /** Stop spending once recorded cost reaches this many USD. */
  readonly budgetUsd?: number;
  /** Times a structured reply that fails its schema is sent back for repair (default 2). */
  readonly maxRepairs?: number;
  /** Usage records and error records kept (default 1000 each). */
  readonly keep?: number;
  /** Keys to scrub from any error text. */
  readonly secrets?: readonly string[];
}

export interface UsageRecord {
  readonly at: string;
  readonly provider: string;
  readonly model: string;
  readonly route: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly attempts: number;
  /** Targets that failed before this one answered, as "provider/model". */
  readonly fellBackFrom: readonly string[];
  readonly feature?: string;
  readonly tenant?: string;
}

export interface ErrorRecord {
  readonly at: string;
  readonly provider: string;
  readonly model: string;
  readonly kind: ErrorKind;
  readonly message: string;
}

/** Runs a call with a deadline. On expiry the call is told to stop, and whatever it then throws, the caller sees a timeout. */
async function within<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new ProviderError('timeout', `no answer within ${ms} ms`)); ctl.abort(); }, ms);
  });
  try { return await Promise.race([fn(ctl.signal), deadline]); } catch (e) {
    if (timedOut) throw new ProviderError('timeout', `no answer within ${ms} ms`);
    throw e;
  } finally { clearTimeout(timer); }
}

const FALLBACK_KINDS: ReadonlySet<ErrorKind> = new Set(['rate_limit', 'overloaded', 'timeout', 'server', 'network', 'auth', 'invalid_response']);

export class LlmClient {
  private readonly o: ClientOptions;
  private readonly providers = new Map<string, Provider>();
  private readonly breakers = new Map<string, Breaker>();
  private readonly prices = new Map<string, ModelInfo>();
  private readonly records: UsageRecord[] = [];
  private readonly errs: ErrorRecord[] = [];
  private spent = 0;
  meterFailures = 0;

  constructor(o: ClientOptions) {
    this.o = o;
    for (const p of o.providers) {
      if (this.providers.has(p.name)) throw new InvalidRequest(`two providers are named ${p.name}`);
      this.providers.set(p.name, p);
    }
    for (const m of o.models ?? []) this.prices.set(`${m.provider}/${m.id}`, m);
    for (const [route, ts] of Object.entries(o.routes ?? {})) {
      if (ts.length === 0) throw new InvalidRequest(`the route ${route} has no targets`);
      for (const t of ts) if (!this.providers.has(t.provider)) throw new InvalidRequest(`the route ${route} names the unknown provider ${t.provider}`);
    }
  }

  /** Total USD of every recorded call. */
  get spentUsd(): number { return round9(this.spent); }
  usage(): readonly UsageRecord[] { return this.records; }
  errors(): readonly ErrorRecord[] { return this.errs; }

  private targets(model: string): readonly Target[] {
    const routes = this.o.routes;
    if (routes && Object.hasOwn(routes, model)) return routes[model]!;
    const i = model.indexOf('/');
    if (i > 0 && this.providers.has(model.slice(0, i))) return [{ provider: model.slice(0, i), model: model.slice(i + 1) }];
    throw new InvalidRequest(`there is no model or route called "${model.slice(0, 80)}"`);
  }

  private breaker(key: string): Breaker | undefined {
    if (!this.o.breaker) return undefined;
    let b = this.breakers.get(key);
    if (!b) { b = new Breaker(this.o.breaker.threshold, this.o.breaker.coolDownMs, () => this.o.now().getTime()); this.breakers.set(key, b); }
    return b;
  }

  private guard(req: LlmRequest): void {
    checkRequest(req);
    if (this.o.budgetUsd !== undefined && this.spent >= this.o.budgetUsd) throw new ProviderError('budget', `the spend limit of $${this.o.budgetUsd} has been reached`);
    if (this.o.meter && req.feature && !this.o.meter.allowed(req.feature, req.tenant ?? 'default', this.o.now().toISOString().slice(0, 7))) throw new ProviderError('budget', `the budget for ${req.feature} is spent`);
  }

  private norm(e: unknown): ProviderError {
    if (e instanceof ProviderError) return e;
    if (e instanceof TimedOut) return new ProviderError('timeout', `no answer within ${e.ms} ms`);
    if (e instanceof BreakerOpen) return new ProviderError('overloaded', 'this model keeps failing; it is not being called for now');
    return new ProviderError('network', redact(e instanceof Error ? e.message : String(e), this.o.secrets ?? []).slice(0, 300));
  }

  private noteError(t: Target, e: ProviderError): void {
    this.errs.push({ at: this.o.now().toISOString(), provider: t.provider, model: t.model, kind: e.kind, message: redact(e.message, this.o.secrets ?? []).slice(0, 300) });
    if (this.errs.length > (this.o.keep ?? 1000)) this.errs.shift();
  }

  private sleep = (ms: number) => (this.o.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms);

  private wait(e: ProviderError, attempt: number): number | undefined {
    const p: RetryPolicy = { attempts: 0, baseMs: this.o.baseMs ?? 200, maxMs: this.o.maxMs ?? 5000, retryable: () => true };
    const jitter = backoff(attempt, p, this.o.random ?? Math.random);
    if (e.retryAfterMs === undefined) return jitter;
    if (e.retryAfterMs > (this.o.maxRetryAfterMs ?? 30_000)) return undefined;
    return Math.max(jitter, e.retryAfterMs);
  }

  private finish(req: LlmRequest, t: Target, r: LlmResponse, started: number, attempts: number, fell: string[]): LlmResponse {
    const info = this.prices.get(`${t.provider}/${t.model}`);
    const costUsd = info ? costOf(info, r.usage) : r.costUsd;
    const at = this.o.now().toISOString();
    const rec: UsageRecord = {
      at, provider: t.provider, model: r.model || t.model, route: req.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens ?? 0, cacheWriteTokens: r.usage.cacheWriteTokens ?? 0, costUsd, latencyMs: Math.max(0, this.o.now().getTime() - started),
      attempts, fellBackFrom: fell, ...(req.feature ? { feature: req.feature } : {}), ...(req.tenant ? { tenant: req.tenant } : {}),
    };
    this.records.push(rec);
    if (this.records.length > (this.o.keep ?? 1000)) this.records.shift();
    this.spent += costUsd;
    if (this.o.meter) {
      try {
        const base = { feature: req.feature ?? 'llm', tenant: req.tenant ?? 'default', at };
        this.o.meter.record({ ...base, meter: `llm.${t.model}.input`, units: r.usage.inputTokens + rec.cacheReadTokens + rec.cacheWriteTokens });
        this.o.meter.record({ ...base, meter: `llm.${t.model}.output`, units: r.usage.outputTokens });
      } catch { this.meterFailures++; }
    }
    return { ...r, costUsd, provider: t.provider };
  }

  private combine(signal: AbortSignal, outer: AbortSignal | undefined): AbortSignal {
    return outer ? AbortSignal.any([signal, outer]) : signal;
  }

  /** Makes one call, with retries, deadlines, the breaker and fallbacks. */
  async complete(req: LlmRequest, o: CallContext = {}): Promise<LlmResponse> {
    this.guard(req);
    const targets = this.targets(req.model);
    const attempts = this.o.attempts ?? 3;
    const fell: string[] = [];
    let last: ProviderError | undefined;
    for (const t of targets) {
      const provider = this.providers.get(t.provider)!;
      const br = this.breaker(`${t.provider}/${t.model}`);
      const started = this.o.now().getTime();
      let tries = 0;
      for (let a = 0; a < attempts; a++) {
        if (o.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
        tries++;
        try {
          const call = () => within(this.o.timeoutMs ?? 60_000, (sig) => provider.complete(req, t.model, { signal: this.combine(sig, o.signal) }));
          const r = await (br ? br.call(call) : call());
          return this.finish(req, t, r, started, tries, fell);
        } catch (raw) {
          if (o.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
          const e = this.norm(raw);
          last = e;
          if (!(raw instanceof BreakerOpen)) this.noteError(t, e);
          if (raw instanceof BreakerOpen || !e.retryable || a === attempts - 1) break;
          const w = this.wait(e, a);
          if (w === undefined) break;
          await this.sleep(w);
        }
      }
      if (!FALLBACK_KINDS.has(last!.kind)) throw last!;
      fell.push(`${t.provider}/${t.model}`);
    }
    throw last ?? new ProviderError('server', 'no model answered');
  }

  /** Streams one call. Retries and fallbacks happen only before the first event; after that an error ends the stream. */
  async *stream(req: LlmRequest, o: CallContext = {}): AsyncGenerator<StreamEvent> {
    this.guard(req);
    const targets = this.targets(req.model);
    const attempts = this.o.attempts ?? 3;
    const idle = this.o.idleTimeoutMs ?? this.o.timeoutMs ?? 60_000;
    const fell: string[] = [];
    let last: ProviderError | undefined;
    for (const t of targets) {
      const provider = this.providers.get(t.provider)!;
      const br = this.breaker(`${t.provider}/${t.model}`);
      const started = this.o.now().getTime();
      let tries = 0;
      for (let a = 0; a < attempts; a++) {
        if (o.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
        tries++;
        let it: AsyncGenerator<StreamEvent> | undefined;
        let first: IteratorResult<StreamEvent>;
        try {
          const open = () => within(this.o.timeoutMs ?? 60_000, (sig) => { it = provider.stream(req, t.model, { signal: this.combine(sig, o.signal) }); return it.next(); });
          first = await (br ? br.call(open) : open());
        } catch (raw) {
          await it?.return(undefined).catch(() => undefined);
          if (o.signal?.aborted) throw new ProviderError('aborted', 'the call was cancelled');
          const e = this.norm(raw);
          last = e;
          if (!(raw instanceof BreakerOpen)) this.noteError(t, e);
          if (raw instanceof BreakerOpen || !e.retryable || a === attempts - 1) break;
          const w = this.wait(e, a);
          if (w === undefined) break;
          await this.sleep(w);
          continue;
        }
        const stream = it!;
        try {
          let cur = first;
          while (!cur.done) {
            const ev = cur.value;
            yield ev.type === 'done' ? { type: 'done', response: this.finish(req, t, ev.response, started, tries, fell) } : ev;
            cur = await within(idle, () => stream.next()).catch((e: unknown) => { throw this.norm(e); });
          }
        } catch (raw) {
          const e = this.norm(raw);
          this.noteError(t, e);
          throw e;
        } finally {
          await stream.return(undefined).catch(() => undefined);
        }
        return;
      }
      if (!FALLBACK_KINDS.has(last!.kind)) throw last!;
      fell.push(`${t.provider}/${t.model}`);
    }
    throw last ?? new ProviderError('server', 'no model answered');
  }

  /** Reads a whole stream into the final response. */
  async collect(req: LlmRequest, o: CallContext = {}): Promise<LlmResponse> {
    let res: LlmResponse | undefined;
    for await (const e of this.stream(req, o)) if (e.type === 'done') res = e.response;
    if (!res) throw new ProviderError('invalid_response', 'the stream ended without a final response');
    return res;
  }

  /**
   * Gets a JSON value that matches `req.responseSchema`. A reply that is not JSON, or does not match, is sent back to
   * the model with the problems, up to `maxRepairs` times; the result carries how many repairs it took.
   */
  async structured(req: LlmRequest, o: CallContext = {}): Promise<{ value: unknown; response: LlmResponse; repairs: number }> {
    if (!req.responseSchema) throw new InvalidRequest('structured output needs a responseSchema');
    let v;
    try { v = compileSchema(req.responseSchema.schema); } catch (e) { throw new InvalidRequest(`the response schema is not usable: ${e instanceof Error ? e.message : String(e)}`); }
    const max = this.o.maxRepairs ?? 2;
    let messages = req.messages;
    let problems: string[] = [];
    let lastText = '';
    for (let repairs = 0; repairs <= max; repairs++) {
      const res = await this.complete({ ...req, messages }, o);
      lastText = res.text;
      let value: unknown;
      let parsed = true;
      try { value = extractJson(res.text); } catch { parsed = false; }
      if (parsed) {
        const r = v.validate(value);
        if (r.valid) return { value, response: { ...res, structured: value }, repairs };
        problems = r.problems.slice(0, 10).map((p) => `${p.path}: ${p.message}`);
      } else problems = ['the reply was not valid JSON'];
      if (repairs === max) break;
      messages = [...messages, { role: 'assistant', content: [{ type: 'text', text: res.text || '(empty)' }] }, { role: 'user', content: [{ type: 'text', text: `That reply did not match the required JSON schema:\n${problems.join('\n')}\nReply again with only the corrected JSON.` }] }];
    }
    throw new StructuredOutputError(`the model did not produce valid ${req.responseSchema.name} JSON after ${max + 1} tries`, problems, lastText);
  }
}
