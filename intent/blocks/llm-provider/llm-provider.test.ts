import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Meter } from '../costmeter/index.ts';
import {
  LlmClient, TwinProvider, ProviderError, InvalidRequest, StructuredOutputError, openAiAdapter, anthropicAdapter,
  toOpenAiBody, fromOpenAiResponse, toAnthropicBody, fromAnthropicResponse, parseSse, checkRequest, costOf, meterRates, httpError,
  redact, safeJson, extractJson, estimateTokens, STRUCTURED_TOOL, type LlmRequest, type HttpRequest, type HttpResponse, type StreamEvent, type Transport,
} from './index.ts';

const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
const req = (o: Partial<LlmRequest> = {}): LlmRequest => ({ model: 'm', messages: [user('hi')], ...o });
const MODELS = [{ provider: 'a', id: 'big', inputPerMTok: 3, outputPerMTok: 15, cacheReadMultiple: 0.1 }, { provider: 'b', id: 'small', inputPerMTok: 1, outputPerMTok: 2 }];
const code = async (f: () => unknown): Promise<string | undefined> => { try { await f(); return undefined; } catch (e) { return e instanceof ProviderError ? e.kind : e instanceof Error ? `other:${e.constructor.name}` : 'other'; } };
const ok = (body: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function* chunks(s: string, n: number): AsyncGenerator<Uint8Array> { const b = new TextEncoder().encode(s); for (let i = 0; i < b.length; i += n) yield b.subarray(i, i + n); }
async function all<T>(g: AsyncIterable<T>): Promise<T[]> { const o: T[] = []; for await (const x of g) o.push(x); return o; }

function clientFor(providers: TwinProvider[], o: Record<string, unknown> = {}) {
  let t = Date.parse('2024-05-01T00:00:00Z');
  const sleeps: number[] = [];
  const c = new LlmClient({
    providers, models: MODELS, now: () => new Date(t), sleep: async (ms) => { sleeps.push(ms); t += ms; }, random: () => 0.5,
    routes: { m: [{ provider: providers[0]!.name, model: 'big' }, ...providers.slice(1).map((p) => ({ provider: p.name, model: 'small' }))] },
    ...o,
  });
  return { c, sleeps, advance: (ms: number) => { t += ms; } };
}

test('OpenAI request body: system, tools, tool calls and results, structured output, stream options', () => {
  const body = toOpenAiBody({
    model: 'x', system: 'be brief', maxTokens: 100, temperature: 0.2, stop: ['END'], toolChoice: { name: 'get_weather' },
    tools: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    responseSchema: { name: 'out', schema: { type: 'object' } },
    messages: [user('weather in Paris?'), { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'get_weather', arguments: { city: 'Paris' } }] }, { role: 'user', content: [{ type: 'tool_result', id: 'c1', content: '21C' }, { type: 'text', text: 'thanks' }] }],
  }, 'gpt-x', {}, true);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'be brief' }, { role: 'user', content: 'weather in Paris?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '21C' }, { role: 'user', content: 'thanks' },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'get_weather' } });
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: false } });
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.stop, ['END']);
});

test('OpenAI response: text, usage with cached tokens, finish reasons, tool calls', () => {
  const r = fromOpenAiResponse({ id: 'chatcmpl-1', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }, 'openai', 'gpt-x', [{ id: 'gpt-x', inputPerMTok: 10, outputPerMTok: 30, cacheReadMultiple: 0.5 }]);
  assert.equal(r.text, 'Hello!');
  assert.deepEqual(r.usage, { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40 });
  assert.equal(r.costUsd, (60 * 10 + 40 * 5 + 20 * 30) / 1e6);
  assert.equal(r.finish, 'stop');
  const t = fromOpenAiResponse({ id: 'x', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }, { id: 'c2', type: 'function', function: { name: 'g', arguments: '{oops' } }, { id: 'c3', type: 'function', function: { name: 'h', arguments: '[1]' } }] }, finish_reason: 'tool_calls' }] }, 'openai', 'm');
  assert.equal(t.finish, 'tool_calls');
  assert.deepEqual(t.toolCalls[0], { id: 'c1', name: 'f', arguments: { a: 1 } });
  assert.deepEqual(t.toolCalls[1], { id: 'c2', name: 'g', arguments: {}, invalid: 'the arguments are not valid JSON' });
  assert.equal(t.toolCalls[2]!.invalid, 'the arguments are JSON but not an object');
  assert.equal(fromOpenAiResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, 'o', 'm').finish, 'length');
  assert.equal(fromOpenAiResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, 'o', 'm').finish, 'content_filter');
  assert.throws(() => fromOpenAiResponse({ choices: [] }, 'o', 'm'), (e) => e instanceof ProviderError && e.kind === 'invalid_response');
  assert.throws(() => fromOpenAiResponse({ choices: [{ message: { content: 5 } }] }, 'o', 'm'), ProviderError);
});

test('tool arguments cannot poison objects through __proto__', () => {
  const r = fromOpenAiResponse({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"__proto__":{"admin":true},"x":1}' } }] }, finish_reason: 'tool_calls' }] }, 'o', 'm');
  const a = r.toolCalls[0]!.arguments;
  assert.deepEqual(Object.keys(a), ['x']);
  assert.equal(({} as Record<string, unknown>).admin, undefined);
  assert.equal((Object.assign({}, a) as Record<string, unknown>).admin, undefined);
  assert.deepEqual(safeJson('{"a":{"__proto__":1,"b":2}}'), { a: { b: 2 } });
});

test('OpenAI adapter: request on the wire, key only in headers, errors mapped and scrubbed', async () => {
  const seen: HttpRequest[] = [];
  const transport: Transport = async (r) => { seen.push(r); return ok({ id: 'r1', model: 'gpt-x', choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }); };
  const p = openAiAdapter({ apiKey: 'sk-secretsecret123', transport, baseUrl: 'https://example.test/v1/' });
  const r = await p.complete(req(), 'gpt-x', {});
  assert.equal(r.text, 'pong');
  assert.equal(seen[0]!.url, 'https://example.test/v1/chat/completions');
  assert.equal(seen[0]!.headers.authorization, 'Bearer sk-secretsecret123');
  assert.ok(!seen[0]!.body.includes('secretsecret'));
  const fail = (status: number, body: string, headers: Record<string, string> = {}) => openAiAdapter({ apiKey: 'sk-secretsecret123', transport: async () => ({ status, headers, body }) }).complete(req(), 'x', {});
  await assert.rejects(fail(429, '{"error":{"message":"slow down"}}', { 'retry-after': '2' }), (e) => e instanceof ProviderError && e.kind === 'rate_limit' && e.retryAfterMs === 2000 && e.retryable);
  await assert.rejects(fail(401, '{"error":{"message":"bad key sk-secretsecret123 given"}}'), (e) => e instanceof ProviderError && e.kind === 'auth' && !e.message.includes('secretsecret') && !e.retryable);
  await assert.rejects(fail(503, 'upstream down'), (e) => e instanceof ProviderError && e.kind === 'server' && e.retryable);
  await assert.rejects(fail(400, '{"error":{"message":"too long"}}'), (e) => e instanceof ProviderError && e.kind === 'bad_request' && !e.retryable);
  await assert.rejects(fail(200, 'not json'), (e) => e instanceof ProviderError && e.kind === 'invalid_response');
  const net = openAiAdapter({ apiKey: 'sk-secretsecret123', transport: async () => { throw new Error('connect ECONNREFUSED with key sk-secretsecret123'); } });
  await assert.rejects(net.complete(req(), 'x', {}), (e) => e instanceof ProviderError && e.kind === 'network' && !e.message.includes('secretsecret'));
});

test('httpError status mapping and retry-after forms', () => {
  assert.equal(httpError(529, {}, '').kind, 'overloaded');
  assert.equal(httpError(504, {}, '').kind, 'timeout');
  assert.equal(httpError(403, {}, '').kind, 'auth');
  assert.equal(httpError(404, {}, '').kind, 'bad_request');
  assert.equal(httpError(429, { 'retry-after-ms': '1500' }, '').retryAfterMs, 1500);
  assert.equal(httpError(429, { 'retry-after': '99999' }, '').retryAfterMs, 600_000);
  assert.equal(httpError(429, { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, '').retryAfterMs, undefined);
  assert.equal(httpError(500, {}, '').message, 'the provider failed (500): HTTP 500');
});

const OPENAI_STREAM = [
  'data: {"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
  ': keep-alive\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
  'data: [DONE]\n\n',
].join('');

test('OpenAI streaming: same events however the bytes are chunked', async () => {
  for (const n of [1, 3, 17, 10_000]) {
    const p = openAiAdapter({ apiKey: 'k-123456', transport: async () => ({ status: 200, headers: {}, body: chunks(OPENAI_STREAM, n) }) });
    const ev = await all(p.stream(req(), 'gpt-x', {}));
    const types = ev.map((e) => e.type);
    assert.deepEqual(types, ['text', 'text', 'tool_call_start', 'tool_call_delta', 'tool_call_delta', 'usage', 'tool_call_end', 'done'], `chunk size ${n}`);
    const done = ev.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.response.text, 'Hello');
    assert.deepEqual(done.response.toolCalls, [{ id: 'call_1', name: 'lookup', arguments: { q: 'cats' } }]);
    assert.equal(done.response.finish, 'tool_calls');
    assert.deepEqual(done.response.usage, { inputTokens: 10, outputTokens: 5 });
  }
});

test('Anthropic request body: blocks, tool choice, structured output through a forced tool', () => {
  const b = toAnthropicBody({
    model: 'x', system: 'sys', toolChoice: 'required', stop: ['STOP'],
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
    messages: [user('go'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_call', id: 't1', name: 'f', arguments: { a: 1 } }] }, { role: 'user', content: [{ type: 'tool_result', id: 't1', content: 'boom', isError: true }] }],
  }, 'claude-x');
  assert.equal(b.system, 'sys');
  assert.deepEqual(b.tool_choice, { type: 'any' });
  assert.deepEqual(b.stop_sequences, ['STOP']);
  assert.deepEqual((b.messages as unknown[])[1], { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }] });
  assert.deepEqual((b.messages as unknown[])[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] });
  const s = toAnthropicBody(req({ responseSchema: { name: 'out', schema: { type: 'object', properties: { n: { type: 'integer' } } } } }), 'claude-x');
  assert.deepEqual(s.tool_choice, { type: 'tool', name: STRUCTURED_TOOL });
  assert.equal((s.tools as { name: string }[])[0]!.name, STRUCTURED_TOOL);
  assert.throws(() => toAnthropicBody(req({ responseSchema: { name: 'o', schema: true }, tools: [{ name: STRUCTURED_TOOL, description: '', parameters: true }] }), 'x'), InvalidRequest);
  assert.equal(toAnthropicBody(req({ maxTokens: 5 }), 'x').max_tokens, 5);
  assert.equal(toAnthropicBody(req(), 'x', { defaultMaxTokens: 777 }).max_tokens, 777);
});

test('Anthropic response: blocks, stop reasons, cache usage, structured tool unwrapped', () => {
  const r = fromAnthropicResponse({ id: 'msg_1', model: 'claude-x', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu_1', name: 'get_time', input: { tz: 'UTC' } }], stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 12, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 } }, 'anthropic', 'claude-x', [{ id: 'claude-x', inputPerMTok: 3, outputPerMTok: 15, cacheReadMultiple: 0.1, cacheWriteMultiple: 1.25 }]);
  assert.equal(r.text, 'Let me check.');
  assert.equal(r.finish, 'tool_calls');
  assert.deepEqual(r.toolCalls, [{ id: 'tu_1', name: 'get_time', arguments: { tz: 'UTC' } }]);
  assert.deepEqual(r.usage, { inputTokens: 50, outputTokens: 12, cacheReadTokens: 200, cacheWriteTokens: 30 });
  assert.equal(r.costUsd, (50 * 3 + 200 * 0.3 + 30 * 3.75 + 12 * 15) / 1e6);
  const s = fromAnthropicResponse({ id: 'm', content: [{ type: 'tool_use', id: 'x', name: STRUCTURED_TOOL, input: { n: 1 } }], stop_reason: 'tool_use' }, 'a', 'm', [], true);
  assert.equal(s.text, '{"n":1}');
  assert.deepEqual(s.toolCalls, []);
  assert.equal(s.finish, 'stop');
  assert.equal(fromAnthropicResponse({ content: [], stop_reason: 'max_tokens' }, 'a', 'm').finish, 'length');
  assert.throws(() => fromAnthropicResponse({ content: [{ type: 'tool_use', id: 'x', name: 'f', input: 'no' }] }, 'a', 'm'), ProviderError);
  assert.throws(() => fromAnthropicResponse({ nope: 1 }, 'a', 'm'), ProviderError);
});

const ANTHROPIC_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","role":"assistant","content":[],"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: ping\ndata: {"type":"ping"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_9","name":"search","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\": \\"ca"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ts\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

test('Anthropic streaming: text, tool input assembled from partial JSON, usage', async () => {
  for (const n of [1, 7, 4096]) {
    const p = anthropicAdapter({ apiKey: 'k-123456', transport: async () => ({ status: 200, headers: {}, body: chunks(ANTHROPIC_STREAM, n) }) });
    const ev = await all(p.stream(req(), 'claude-x', {}));
    assert.deepEqual(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta), ['Checking', '...']);
    const done = ev.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.response.text, 'Checking...');
    assert.deepEqual(done.response.toolCalls, [{ id: 'tu_9', name: 'search', arguments: { query: 'cats' } }]);
    assert.equal(done.response.finish, 'tool_calls');
    assert.deepEqual(done.response.usage, { inputTokens: 25, outputTokens: 40 });
    assert.equal(done.response.id, 'msg_1');
  }
});

test('Anthropic stream error events become typed errors', async () => {
  const body = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const p = anthropicAdapter({ apiKey: 'k-123456', transport: async () => ({ status: 200, headers: {}, body: chunks(body, 5) }) });
  await assert.rejects(all(p.stream(req(), 'x', {})), (e) => e instanceof ProviderError && e.kind === 'overloaded');
  const refused = anthropicAdapter({ apiKey: 'k-123456', transport: async () => ({ status: 529, headers: {}, body: '{"error":{"message":"busy"}}' }) });
  await assert.rejects(all(refused.stream(req(), 'x', {})), (e) => e instanceof ProviderError && e.kind === 'overloaded');
});

test('parseSse handles comments, CRLF, multi-line data, BOM, split lines and a missing final blank line', async () => {
  const text = '\ufeff: hi\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata:three\n\nretry: 5\n\ndata: last';
  for (const n of [1, 4, 100]) {
    const ev = await all(parseSse(chunks(text, n)));
    assert.deepEqual(ev, [{ event: 'a', data: 'one\ntwo' }, { event: undefined, data: 'three' }, { event: undefined, data: 'last' }], `size ${n}`);
  }
  await assert.rejects(all(parseSse(['data: ' + 'x'.repeat(2000) + '\n\n'], 1000)), (e) => e instanceof ProviderError);
  await assert.rejects(all(parseSse(['x'.repeat(50_000)], 1000)), ProviderError);
  assert.deepEqual(await all(parseSse(['data: a\r', '\n\r\n'])), [{ event: undefined, data: 'a' }]);
});

test('request validation', () => {
  const bad = (r: Partial<LlmRequest>) => assert.throws(() => checkRequest(req(r)), InvalidRequest);
  bad({ messages: [] });
  bad({ messages: [{ role: 'system' as never, content: [{ type: 'text', text: 'x' }] }] });
  bad({ messages: [{ role: 'user', content: [] }] });
  bad({ messages: [{ role: 'user', content: [{ type: 'tool_result', id: 'nope', content: 'x' }] }] });
  bad({ messages: [{ role: 'user', content: [{ type: 'tool_call', id: 'a', name: 'f', arguments: {} }] }] });
  bad({ messages: [{ role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'bad name!', arguments: {} }] }] });
  bad({ messages: [{ role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'f', arguments: {} }, { type: 'tool_call', id: 'a', name: 'f', arguments: {} }] }] });
  bad({ tools: [{ name: 'a b', description: '', parameters: true }] });
  bad({ tools: [{ name: 'a', description: '', parameters: true }, { name: 'a', description: '', parameters: true }] });
  bad({ toolChoice: { name: 'missing' }, tools: [{ name: 'a', description: '', parameters: true }] });
  bad({ toolChoice: 'required' });
  bad({ maxTokens: 0 });
  bad({ maxTokens: 1.5 });
  bad({ temperature: 3 });
  bad({ stop: ['', 'x'] });
  bad({ responseSchema: { name: 'bad name', schema: true } });
  checkRequest(req({ messages: [user('a'), { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'f', arguments: {} }] }, { role: 'user', content: [{ type: 'tool_result', id: 'a', content: 'r' }] }] }));
});

test('cost, token estimates, meter rates, redaction and JSON extraction', () => {
  assert.equal(costOf(MODELS[0]!, { inputTokens: 1000, outputTokens: 500 }), 0.0105);
  assert.equal(costOf(MODELS[0]!, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 }), 0.0003);
  assert.throws(() => costOf(MODELS[0]!, { inputTokens: -1, outputTokens: 0 }), InvalidRequest);
  assert.throws(() => costOf(MODELS[0]!, { inputTokens: NaN, outputTokens: 0 }), InvalidRequest);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens(''), 0);
  assert.deepEqual(meterRates([MODELS[0]!]).map((r) => [r.meter, r.microCentsPerUnit]), [['llm.big.input', 300], ['llm.big.output', 1500]]);
  assert.equal(redact('key=abc12345 and Bearer tok_abcdefghij and sk-abcdefgh12', ['abc12345']), 'key=[redacted] and [redacted] and [redacted]');
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('  [1,2] '), [1, 2]);
  assert.throws(() => extractJson('sure! {"a":1}'), SyntaxError);
});

test('the twin: script order, repeatLast, exhaustion, errors, structured json, streaming chunks', async () => {
  const t = new TwinProvider('t', ['one', { text: 'two', usage: { inputTokens: 7, outputTokens: 9 } }, new ProviderError('overloaded', 'busy'), { json: { a: 1 } }, { toolCalls: [{ name: 'f', arguments: { x: 1 } }] }]);
  assert.equal((await t.complete(req(), 'm', {})).text, 'one');
  const two = await t.complete(req(), 'm', {});
  assert.deepEqual(two.usage, { inputTokens: 7, outputTokens: 9 });
  assert.equal(await code(() => t.complete(req(), 'm', {})), 'overloaded');
  assert.equal((await t.complete(req(), 'm', {})).text, '{"a":1}');
  const tc = await t.complete(req(), 'm', {});
  assert.equal(tc.finish, 'tool_calls');
  assert.deepEqual(tc.toolCalls[0]!.arguments, { x: 1 });
  assert.equal(await code(() => t.complete(req(), 'm', {})), 'server');
  assert.equal(t.calls.length, 6);
  const rep = new TwinProvider('r', ['x'], { repeatLast: true });
  assert.equal((await rep.complete(req(), 'm', {})).text, 'x');
  assert.equal((await rep.complete(req(), 'm', {})).text, 'x');
  const s = new TwinProvider('s', ['abcdefghij'], { chunkSize: 4 });
  const ev = await all(s.stream(req(), 'm', {}));
  assert.deepEqual(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta), ['abcd', 'efgh', 'ij']);
  assert.equal((ev.at(-1) as Extract<StreamEvent, { type: 'done' }>).response.text, 'abcdefghij');
  const ac = new AbortController();
  ac.abort();
  assert.equal(await code(() => s.complete(req(), 'm', { signal: ac.signal })), 'aborted');
});

test('client: usage records with cost, spend total and the key never in records', async () => {
  const a = new TwinProvider('a', [{ text: 'hi', usage: { inputTokens: 1000, outputTokens: 500 } }], { repeatLast: true });
  const { c } = clientFor([a], { secrets: ['k-secret'] });
  const r = await c.complete(req({ feature: 'chat', tenant: 't1' }));
  assert.equal(r.costUsd, 0.0105);
  assert.equal(r.provider, 'a');
  const [u] = c.usage();
  assert.deepEqual({ ...u, latencyMs: 0 }, { at: '2024-05-01T00:00:00.000Z', provider: 'a', model: 'big', route: 'm', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0105, latencyMs: 0, attempts: 1, fellBackFrom: [], feature: 'chat', tenant: 't1' });
  assert.equal(c.spentUsd, 0.0105);
  assert.equal(await code(() => c.complete(req({ model: 'nope' }))), 'other:InvalidRequest');
  assert.equal((await new LlmClient({ providers: [a], now: () => new Date(0) }).complete(req({ model: 'a/anything' }))).provider, 'a');
});

test('client: retries a retryable error with jittered backoff, then succeeds', async () => {
  const a = new TwinProvider('a', [new ProviderError('server', 'boom'), new ProviderError('rate_limit', 'slow', { retryAfterMs: 4000 }), 'finally']);
  const { c, sleeps } = clientFor([a], { baseMs: 100, maxMs: 1000 });
  const r = await c.complete(req());
  assert.equal(r.text, 'finally');
  assert.deepEqual(sleeps, [50, 4000]);
  assert.equal(c.usage()[0]!.attempts, 3);
  assert.deepEqual(c.errors().map((e) => e.kind), ['server', 'rate_limit']);
});

test('client: falls back to the next model and records where it came from', async () => {
  const a = new TwinProvider('a', [new ProviderError('overloaded', 'busy')], { repeatLast: true });
  const b = new TwinProvider('b', [{ text: 'from b', usage: { inputTokens: 1000, outputTokens: 1000 } }]);
  const { c, sleeps } = clientFor([a, b]);
  const r = await c.complete(req());
  assert.equal(r.text, 'from b');
  assert.equal(a.calls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.deepEqual(c.usage()[0]!.fellBackFrom, ['a/big']);
  assert.equal(c.usage()[0]!.costUsd, 0.003);
  assert.equal(r.costUsd, 0.003);
});

test('client: a bad request is not retried or sent to another model; a bad key is not retried but falls back', async () => {
  const a = new TwinProvider('a', [new ProviderError('bad_request', 'too long')], { repeatLast: true });
  const b = new TwinProvider('b', ['ok']);
  const x = clientFor([a, b]);
  assert.equal(await code(() => x.c.complete(req())), 'bad_request');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 0);
  const a2 = new TwinProvider('a', [new ProviderError('auth', 'bad key')], { repeatLast: true });
  const b2 = new TwinProvider('b', ['ok']);
  const y = clientFor([a2, b2]);
  assert.equal((await y.c.complete(req())).text, 'ok');
  assert.equal(a2.calls.length, 1);
});

test('client: when every model fails the last error is thrown', async () => {
  const a = new TwinProvider('a', [new ProviderError('server', 'a down')], { repeatLast: true });
  const b = new TwinProvider('b', [new ProviderError('overloaded', 'b busy')], { repeatLast: true });
  const { c } = clientFor([a, b], { attempts: 2 });
  await assert.rejects(c.complete(req()), (e) => e instanceof ProviderError && e.kind === 'overloaded' && e.message === 'b busy');
  assert.equal(a.calls.length + b.calls.length, 4);
});

test('client: a Retry-After longer than the limit falls back instead of waiting', async () => {
  const a = new TwinProvider('a', [new ProviderError('rate_limit', 'later', { retryAfterMs: 120_000 })], { repeatLast: true });
  const b = new TwinProvider('b', ['ok']);
  const { c, sleeps } = clientFor([a, b]);
  assert.equal((await c.complete(req())).text, 'ok');
  assert.deepEqual(sleeps, []);
  assert.equal(a.calls.length, 1);
});

test('client: the breaker stops calling a failing model, then lets a trial through after the cool-down', async () => {
  const a = new TwinProvider('a', (_r, i) => (i < 3 ? new ProviderError('server', 'down') : 'recovered'));
  const b = new TwinProvider('b', ['b-answer'], { repeatLast: true });
  const { c, advance } = clientFor([a, b], { attempts: 1, breaker: { threshold: 3, coolDownMs: 10_000 } });
  for (let i = 0; i < 3; i++) assert.equal((await c.complete(req())).text, 'b-answer');
  assert.equal(a.calls.length, 3);
  assert.equal((await c.complete(req())).text, 'b-answer');
  assert.equal(a.calls.length, 3, 'the open breaker did not call a');
  advance(10_001);
  assert.equal((await c.complete(req())).text, 'recovered');
  assert.equal(a.calls.length, 4);
});

test('client: a hanging model times out and the next model answers', async () => {
  const hang: TwinProvider = new TwinProvider('a', ['never']);
  hang.complete = (_r, _m, ctx) => new Promise((_res, rej) => ctx.signal?.addEventListener('abort', () => rej(new ProviderError('aborted', 'stopped'))));
  const b = new TwinProvider('b', ['ok']);
  const { c } = clientFor([hang, b], { timeoutMs: 20, attempts: 1 });
  assert.equal((await c.complete(req())).text, 'ok');
  assert.deepEqual(c.errors().map((e) => e.kind), ['timeout']);
});

test('client: a cancelled call is not retried and does not fall back', async () => {
  const a = new TwinProvider('a', ['x']);
  const { c } = clientFor([a, new TwinProvider('b', ['y'])]);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await code(() => c.complete(req(), { signal: ac.signal })), 'aborted');
  assert.equal(a.calls.length, 0);
});

test('client: spend ceiling and meter budgets stop further calls', async () => {
  const a = new TwinProvider('a', [{ text: 'x', usage: { inputTokens: 1000, outputTokens: 500 } }], { repeatLast: true });
  const { c } = clientFor([a], { budgetUsd: 0.02 });
  await c.complete(req());
  await c.complete(req());
  assert.equal(await code(() => c.complete(req())), 'budget');
  assert.equal(a.calls.length, 2);
  const meter = new Meter(meterRates(MODELS), [{ name: 'chat', cents: 1, feature: 'chat', hard: true }]);
  const m = clientFor([new TwinProvider('a', [{ text: 'x', usage: { inputTokens: 1000, outputTokens: 500 } }], { repeatLast: true })], { meter });
  await m.c.complete(req({ feature: 'chat', tenant: 't' }));
  assert.equal(meter.spent('2024-05', { feature: 'chat' }), 1.05);
  assert.equal(await code(() => m.c.complete(req({ feature: 'chat', tenant: 't' }))), 'budget');
  assert.equal((await m.c.complete(req({ feature: 'other' }))).text, 'x');
  assert.equal(m.c.meterFailures, 0);
});

test('client: a meter without rates is counted, not fatal', async () => {
  const x = clientFor([new TwinProvider('a', ['x'])], { meter: new Meter([]) });
  assert.equal((await x.c.complete(req())).text, 'x');
  assert.equal(x.c.meterFailures, 1);
});

test('client streaming: fallback before the first event, errors after it propagate, usage recorded once', async () => {
  const a = new TwinProvider('a', [new ProviderError('overloaded', 'busy')], { repeatLast: true });
  const b = new TwinProvider('b', [{ text: 'streamed text', usage: { inputTokens: 10, outputTokens: 4 } }], { chunkSize: 5 });
  const { c } = clientFor([a, b], { attempts: 1 });
  const ev = await all(c.stream(req()));
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join(''), 'streamed text');
  assert.equal(c.usage().length, 1);
  assert.deepEqual(c.usage()[0]!.fellBackFrom, ['a/big']);
  const mid = new TwinProvider('a', [{ text: 'abcdefghijkl', failAfterEvents: 2, failWith: new ProviderError('network', 'dropped') }], { chunkSize: 3 });
  const other = new TwinProvider('b', ['fallback']);
  const z = clientFor([mid, other], { attempts: 1 });
  const got: string[] = [];
  await assert.rejects((async () => { for await (const e of z.c.stream(req())) if (e.type === 'text') got.push(e.delta); })(), (e) => e instanceof ProviderError && e.kind === 'network');
  assert.deepEqual(got, ['abc', 'def']);
  assert.equal(other.calls.length, 0);
  assert.equal(z.c.usage().length, 0);
  assert.equal((await new TwinProvider('s', ['hello']).complete(req(), 'm', {})).text, 'hello');
});

test('client streaming: collect returns the final response; idle timeout ends a stalled stream', async () => {
  const t = new TwinProvider('a', [{ text: 'whole', usage: { inputTokens: 1, outputTokens: 1 } }]);
  const x = clientFor([t]);
  assert.equal((await x.c.collect(req())).text, 'whole');
  const stall = new TwinProvider('a', ['x']);
  stall.stream = async function* () { yield { type: 'text', delta: 'a' }; await new Promise((r) => setTimeout(r, 200)); yield { type: 'text', delta: 'b' }; };
  const y = clientFor([stall], { timeoutMs: 1000, idleTimeoutMs: 20 });
  const got: string[] = [];
  await assert.rejects((async () => { for await (const e of y.c.stream(req())) if (e.type === 'text') got.push(e.delta); })(), (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.deepEqual(got, ['a']);
});

const SCHEMA = { name: 'person', schema: { type: 'object', required: ['name', 'age'], properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } }, additionalProperties: false } };

test('structured output: valid reply, fenced JSON, and repair with the errors shown to the model', async () => {
  const a = new TwinProvider('a', [{ json: { name: 'Ada', age: 36 } }]);
  const first = await clientFor([a]).c.structured(req({ responseSchema: SCHEMA }));
  assert.deepEqual(first.value, { name: 'Ada', age: 36 });
  assert.equal(first.repairs, 0);
  assert.deepEqual(first.response.structured, { name: 'Ada', age: 36 });
  const b = new TwinProvider('a', ['not json at all', '```json\n{"name":"Bob","age":-1}\n```', '{"name":"Bob","age":41}']);
  const r = await clientFor([b]).c.structured(req({ responseSchema: SCHEMA }));
  assert.deepEqual(r.value, { name: 'Bob', age: 41 });
  assert.equal(r.repairs, 3 - 1);
  assert.equal(b.calls.length, 3);
  const last = b.calls[2]!.req.messages;
  assert.equal(last.length, 5);
  const msg = (last[4]!.content[0] as { text: string }).text;
  assert.ok(msg.includes('age: must be at least 0'), msg);
  assert.ok((b.calls[1]!.req.messages[2]!.content[0] as { text: string }).text.includes('the reply was not valid JSON'));
});

test('structured output: gives up with the problems, and refuses a missing or unusable schema', async () => {
  const a = new TwinProvider('a', [{ json: { name: 'x', age: 'old' } }], { repeatLast: true });
  await assert.rejects(clientFor([a], { maxRepairs: 1 }).c.structured(req({ responseSchema: SCHEMA })), (e) => e instanceof StructuredOutputError && e.problems.includes('age: expected integer, got string') && e.lastText.includes('old'));
  assert.equal(a.calls.length, 2);
  await assert.rejects(clientFor([a]).c.structured(req()), InvalidRequest);
  await assert.rejects(clientFor([a]).c.structured(req({ responseSchema: { name: 'bad', schema: { $ref: '#/nope' } } })), InvalidRequest);
});

test('structured output through the Anthropic adapter, end to end', async () => {
  let sent: HttpRequest | undefined;
  const transport: Transport = async (r) => { sent = r; return ok({ id: 'm1', model: 'claude-x', content: [{ type: 'tool_use', id: 't', name: STRUCTURED_TOOL, input: { name: 'Eve', age: 30 } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 6 } }); };
  const c = new LlmClient({ providers: [anthropicAdapter({ apiKey: 'sk-ant-secret', transport })], now: () => new Date(0) });
  const r = await c.structured(req({ model: 'anthropic/claude-x', responseSchema: SCHEMA }));
  assert.deepEqual(r.value, { name: 'Eve', age: 30 });
  assert.equal(sent!.headers['x-api-key'], 'sk-ant-secret');
  assert.equal(sent!.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(JSON.parse(sent!.body).tool_choice.name, STRUCTURED_TOOL);
});
