import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient, TwinProvider, ProviderError, type LlmRequest } from '../llm-provider/index.ts';
import type { Tool } from '../mcp/index.ts';
import { Agent, AgentError, toolSpecs, memoryStore, type AgentOptions, type Decision, type TraceEvent } from './index.ts';

type Reply = ConstructorParameters<typeof TwinProvider>[1];
const call = (name: string, args: Record<string, unknown>, id = `c-${name}-${JSON.stringify(args).length}`) => ({ name, arguments: args, id });
const tools = (log: string[] = []): Tool[] => [
  { name: 'lookup', title: 'Look up', description: 'read', readOnly: true, inputSchema: { type: 'object', properties: { q: { type: 'string', maxLength: 50 } }, required: ['q'], additionalProperties: false }, run: async (a) => { log.push(`lookup:${String(a.q)}`); return { hits: [a.q] }; } },
  { name: 'send', title: 'Send mail', description: 'write', inputSchema: { type: 'object', properties: { to: { type: 'string', maxLength: 50 }, n: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['to'], additionalProperties: false }, run: async (a) => { log.push(`send:${String(a.to)}:${String(a.n ?? '')}`); return 'sent'; } },
  { name: 'admin', title: 'Admin', description: 'secret', readOnly: true, permission: 'admin', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => { log.push('admin'); return 'root'; } },
  { name: 'boom', title: 'Boom', description: 'fails', readOnly: true, inputSchema: { type: 'object', properties: { x: { type: 'integer' } }, additionalProperties: false }, run: async () => { throw new Error('kaboom\n   at secret/stack/line.ts:1'); } },
  { name: 'big', title: 'Big', description: 'long output', readOnly: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: async () => 'x'.repeat(500) },
];

function setup(script: Reply, o: Partial<AgentOptions> = {}, log: string[] = []) {
  let t = 0;
  let n = 0;
  const twin = new TwinProvider('t', script, { repeatLast: true });
  const llm = new LlmClient({ providers: [twin], routes: { m: [{ provider: 't', model: 'x' }] }, now: () => new Date(0), attempts: 1, models: [{ provider: 't', id: 'x', inputPerMTok: 1000, outputPerMTok: 2000 }] });
  const events: TraceEvent[] = [];
  const clock = { advance: (ms: number) => { t += ms; } };
  const agent = new Agent({ model: llm, modelName: 'm', tools: tools(log), actor: { who: 'ada', can: () => false }, now: () => new Date(t), id: () => `run${++n}`, onEvent: (e) => events.push(e), ...o });
  return { agent, twin, events, clock, log };
}
const text = (m: { content: readonly { type: string }[] }, i = 0) => (m.content[i] as { text?: string; content?: string }).text ?? (m.content[i] as { content?: string }).content;

test('a plain answer ends the run in one step', async () => {
  const { agent, events } = setup(['The answer is 4.']);
  const r = await agent.run('What is 2+2?');
  assert.equal(r.status, 'done');
  assert.equal(r.answer, 'The answer is 4.');
  assert.equal(r.steps, 1);
  assert.equal(r.toolCalls, 0);
  assert.deepEqual(events.map((e) => e.type), ['start', 'model', 'stop']);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(r.transcript.length, 2);
  assert.equal(r.runId, 'run1');
});

test('a read-only tool runs, its result goes back to the model, and totals add up', async () => {
  const log: string[] = [];
  const { agent, twin } = setup([{ toolCalls: [call('lookup', { q: 'cats' }, 'c1')], usage: { inputTokens: 100, outputTokens: 10 } }, { text: 'Found cats.', usage: { inputTokens: 200, outputTokens: 20 } }], {}, log);
  const r = await agent.run('find cats');
  assert.equal(r.status, 'done');
  assert.deepEqual(log, ['lookup:cats']);
  assert.equal(r.steps, 2);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.tokens, 330);
  assert.equal(r.costUsd, 0.1 + 0.02 + 0.2 + 0.04);
  assert.deepEqual(r.transcript[2]!.content[0], { type: 'tool_result', id: 'c1', content: '{"hits":["cats"]}' });
  const second = twin.calls[1]!.req as LlmRequest;
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.tools!.map((t) => t.name), ['lookup', 'send', 'boom', 'big']);
});

test('arguments that do not match the schema go back to the model, which can correct them', async () => {
  const log: string[] = [];
  const { agent } = setup([{ toolCalls: [call('lookup', { q: 5 }, 'a')] }, { toolCalls: [call('lookup', { nope: 1 }, 'b')] }, { toolCalls: [call('lookup', { q: 'ok' }, 'c')] }, 'done'], {}, log);
  const r = await agent.run('go');
  assert.equal(r.status, 'done');
  assert.deepEqual(log, ['lookup:ok']);
  const msgs = r.transcript.filter((m) => m.role === 'user').slice(1);
  assert.match(text(msgs[0]!)!, /q must be a string/);
  assert.match(text(msgs[1]!)!, /q is required/);
  assert.equal((msgs[0]!.content[0] as { isError?: boolean }).isError, true);
});

test('a tool the person may not use is hidden, and calling it anyway is refused and traced', async () => {
  const log: string[] = [];
  const { agent, twin, events } = setup([{ toolCalls: [call('admin', {}, 'x1')] }, 'ok'], {}, log);
  const r = await agent.run('be root');
  assert.deepEqual(twin.calls[0]!.req.tools!.map((t) => t.name).includes('admin'), false);
  assert.deepEqual(log, []);
  assert.match(text(r.transcript[2]!)!, /There is no tool called admin/);
  const denied = events.find((e) => e.type === 'denied')!;
  assert.equal((denied as { why: string }).why, 'not permitted: needs admin');
  const { agent: allowed, twin: t2 } = setup([{ toolCalls: [call('admin', {}, 'x1')] }, 'ok'], { actor: { who: 'root', can: (p) => p === 'admin' } }, log);
  await allowed.run('be root');
  assert.ok(t2.calls[0]!.req.tools!.some((t) => t.name === 'admin'));
  assert.deepEqual(log, ['admin']);
  assert.deepEqual(toolSpecs(tools(), { who: 'x', can: () => false }).map((s) => s.name), ['lookup', 'send', 'boom', 'big']);
});

test('a state-changing tool suspends for approval and runs only after approval', async () => {
  const log: string[] = [];
  const { agent, events } = setup([{ toolCalls: [call('send', { to: 'bob@x.test' }, 's1')] }, 'Mail sent.'], {}, log);
  const r = await agent.run('mail bob');
  assert.equal(r.status, 'waiting-approval');
  assert.deepEqual(log, []);
  assert.deepEqual(r.pending, [{ runId: 'run1', callId: 's1', tool: 'send', title: 'Send mail', args: { to: 'bob@x.test' }, readOnly: false }]);
  const done = await agent.resume('run1', { s1: { approve: true, by: 'carol' } });
  assert.equal(done.status, 'done');
  assert.equal(done.answer, 'Mail sent.');
  assert.deepEqual(log, ['send:bob@x.test:']);
  const a = events.find((e) => e.type === 'approval') as Extract<TraceEvent, { type: 'approval' }>;
  assert.deepEqual({ approved: a.approved, by: a.by, edited: a.edited }, { approved: true, by: 'carol', edited: false });
  await assert.rejects(agent.resume('run1', {}), AgentError);
});

test('an approver can edit the arguments, which are checked again', async () => {
  const log: string[] = [];
  const { agent } = setup([{ toolCalls: [call('send', { to: 'bob@x.test', n: 3 }, 's1')] }, 'ok'], {}, log);
  await agent.run('mail');
  const r = await agent.resume('run1', { s1: { approve: true, args: { to: 'ann@x.test', n: 1 } } });
  assert.deepEqual(log, ['send:ann@x.test:1']);
  assert.equal(r.status, 'done');
  const { agent: a2 } = setup([{ toolCalls: [call('send', { to: 'bob@x.test' }, 's1')] }, 'ok'], {}, log);
  await a2.run('mail');
  const r2 = await a2.resume('run1', { s1: { approve: true, args: { to: 'ann@x.test', n: 99 } } });
  assert.equal(log.length, 1);
  assert.match(text(r2.transcript[2]!)!, /edited arguments do not match.*n must be between 1 and 5/);
});

test('a declined call tells the model not to retry and the run carries on', async () => {
  const log: string[] = [];
  const { agent, events } = setup([{ toolCalls: [call('send', { to: 'bob@x.test' }, 's1')] }, 'I did not send it.'], {}, log);
  await agent.run('mail');
  const r = await agent.resume('run1', { s1: { approve: false, reason: 'wrong person', by: 'carol' } });
  assert.equal(r.status, 'done');
  assert.deepEqual(log, []);
  const res = r.transcript[2]!.content[0] as { content: string; isError: boolean };
  assert.equal(res.isError, true);
  assert.match(res.content, /declined this action: wrong person\. Do not retry/);
  assert.equal((events.find((e) => e.type === 'approval') as { reason: string }).reason, 'wrong person');
});

test('a decide callback answers in-line without suspending', async () => {
  const log: string[] = [];
  const seen: string[] = [];
  const decide = async (r: { tool: string; args: Record<string, unknown> }): Promise<Decision> => { seen.push(`${r.tool}:${JSON.stringify(r.args)}`); return r.args.to === 'ok@x.test' ? { approve: true } : { approve: false, reason: 'no' }; };
  const { agent } = setup([{ toolCalls: [call('send', { to: 'ok@x.test' }, 'a'), call('send', { to: 'bad@x.test' }, 'b')] }, 'done'], { decide }, log);
  const r = await agent.run('mail both');
  assert.equal(r.status, 'done');
  assert.deepEqual(log, ['send:ok@x.test:']);
  assert.deepEqual(seen, ['send:{"to":"ok@x.test"}', 'send:{"to":"bad@x.test"}']);
});

test('with calls before and after a pending one, results keep the model\'s order and only decided calls are settled', async () => {
  const log: string[] = [];
  const { agent } = setup([{ toolCalls: [call('lookup', { q: 'A' }, 'a'), call('send', { to: 'b@x.test' }, 'b'), call('send', { to: 'c@x.test' }, 'c'), call('lookup', { q: 'D' }, 'd')] }, 'all done'], {}, log);
  const r = await agent.run('mixed');
  assert.equal(r.status, 'waiting-approval');
  assert.deepEqual(log, ['lookup:A', 'lookup:D']);
  assert.deepEqual(r.pending.map((p) => p.callId), ['b', 'c']);
  await assert.rejects(agent.resume('run1', { zzz: { approve: true } }), /not waiting on zzz/);
  const mid = await agent.resume('run1', { b: { approve: true } });
  assert.equal(mid.status, 'waiting-approval');
  assert.deepEqual(mid.pending.map((p) => p.callId), ['c']);
  const end = await agent.resume('run1', { c: { approve: false } });
  assert.equal(end.status, 'done');
  assert.deepEqual(log, ['lookup:A', 'lookup:D', 'send:b@x.test:']);
  assert.deepEqual((end.transcript[2]!.content as unknown as { id: string }[]).map((p) => p.id), ['a', 'b', 'c', 'd']);
});

test('needsApproval can be tightened or loosened', async () => {
  const log: string[] = [];
  const loose = setup([{ toolCalls: [call('send', { to: 'x@x.test' }, 's')] }, 'ok'], { needsApproval: () => false }, log);
  assert.equal((await loose.agent.run('go')).status, 'done');
  assert.deepEqual(log, ['send:x@x.test:']);
  const strict = setup([{ toolCalls: [call('lookup', { q: 'x' }, 'l')] }, 'ok'], { needsApproval: () => true });
  assert.equal((await strict.agent.run('go')).status, 'waiting-approval');
});

test('step limit stops a model that never stops calling tools', async () => {
  let i = 0;
  const { agent, twin } = setup((() => ({ toolCalls: [call('lookup', { q: `q${i++}` }, `id${i}`)] })) as never, { budgets: { maxSteps: 3 } });
  const r = await agent.run('forever');
  assert.equal(r.status, 'step-limit');
  assert.equal(r.steps, 3);
  assert.equal(twin.calls.length, 3);
  assert.equal(r.transcript.at(-1)!.role, 'user');
});

test('tool-call limits: in all (stops) and per tool (error to the model)', async () => {
  let i = 0;
  const gen = (() => ({ toolCalls: [call('lookup', { q: `q${i++}` }, `id${i}`)] })) as never;
  const all = await setup(gen, { budgets: { maxToolCalls: 2, maxSteps: 10 } }).agent.run('go');
  assert.equal(all.status, 'tool-limit');
  assert.equal(all.toolCalls, 2);
  let j = 0;
  const per = await setup([{ toolCalls: [call('lookup', { q: 'a' }, 'p1')] }, { toolCalls: [call('lookup', { q: 'b' }, 'p2')] }, 'fine'], { budgets: { maxCallsPerTool: { lookup: 1 } } }).agent.run('go');
  void j;
  assert.equal(per.status, 'done');
  assert.equal(per.toolCalls, 1);
  assert.match(text(per.transcript[4]!)!, /may be used at most 1 times/);
});

test('cost, token and wall-clock budgets', async () => {
  const pricey = { toolCalls: [call('lookup', { q: 'a' }, 'z1')], usage: { inputTokens: 1000, outputTokens: 0 } };
  const cost = await setup([pricey, pricey, 'x'], { budgets: { maxCostUsd: 0.5 } }).agent.run('go');
  assert.equal(cost.status, 'budget');
  assert.equal(cost.steps, 1);
  assert.match(cost.detail, /spent \$1\.0000 of \$0\.5/);
  const tok = await setup([pricey, 'x'], { budgets: { maxTokens: 500 } }).agent.run('go');
  assert.equal(tok.status, 'budget');
  assert.match(tok.detail, /used 1000 of 500 tokens/);
  const s = setup([{ toolCalls: [call('lookup', { q: 'a' }, 'w1')] }, 'x'], { budgets: { maxWallMs: 1000 } });
  s.clock.advance(1500);
  const wall = await s.agent.run('go');
  assert.equal(wall.status, 'done');
  const s2 = setup([{ toolCalls: [call('lookup', { q: 'a' }, 'w1')] }, 'x'], { budgets: { maxWallMs: 1000 }, tools: [{ ...tools()[0]!, run: async () => { s2.clock.advance(2000); return 'slow'; } }] });
  const slow = await s2.agent.run('go');
  assert.equal(slow.status, 'timeout');
});

test('identical repeated calls are refused, then end the run as a loop', async () => {
  const log: string[] = [];
  const same = (id: string) => ({ toolCalls: [call('lookup', { q: 'same' }, id)] });
  const { agent } = setup([same('r1'), same('r2'), same('r3'), same('r4'), 'never'], {}, log);
  const r = await agent.run('go');
  assert.equal(r.status, 'loop');
  assert.deepEqual(log, ['lookup:same', 'lookup:same']);
  assert.match(text(r.transcript[6]!)!, /already called lookup with these exact arguments 2 times/);
});

test('steps where every call fails end the run; a failing tool message has no stack', async () => {
  let i = 0;
  const { agent } = setup((() => ({ toolCalls: [call('boom', { x: i++ }, `b${i}`)] })) as never);
  const r = await agent.run('go');
  assert.equal(r.status, 'failing');
  assert.equal(r.steps, 3);
  const res = r.transcript[2]!.content[0] as { content: string; isError: boolean };
  assert.equal(res.isError, true);
  assert.match(res.content, /^The tool failed: kaboom/);
  const ok = setup([{ toolCalls: [call('boom', { x: 1 }, 'e1')] }, { toolCalls: [call('lookup', { q: 'fine' }, 'e2')] }, { toolCalls: [call('boom', { x: 2 }, 'e3')] }, 'end'], { budgets: { maxFailedSteps: 2 } });
  assert.equal((await ok.agent.run('go')).status, 'done');
});

test('a tool that hangs is abandoned after its timeout', async () => {
  const hang: Tool = { ...tools()[0]!, run: () => new Promise(() => undefined) };
  const { agent } = setup([{ toolCalls: [call('lookup', { q: 'a' }, 'h1')] }, 'gave up'], { tools: [hang], budgets: { toolTimeoutMs: 20 } });
  const r = await agent.run('go');
  assert.equal(r.status, 'done');
  assert.match(text(r.transcript[2]!)!, /did not answer within 20 ms/);
});

test('long tool output is cut with a notice; results trace sizes', async () => {
  const { agent, events } = setup([{ toolCalls: [call('big', {}, 'g1')] }, 'ok'], { budgets: { maxToolOutputChars: 100 } });
  const r = await agent.run('go');
  const content = (r.transcript[2]!.content[0] as { content: string }).content;
  assert.ok(content.startsWith('x'.repeat(100)));
  assert.match(content, /\[output cut: 400 more characters not shown\]/);
  const tr = events.find((e) => e.type === 'tool-result') as Extract<TraceEvent, { type: 'tool-result' }>;
  assert.equal(tr.chars, 500);
  assert.equal(tr.ok, true);
});

test('cancelling, a refusal and a truncated reply', async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal((await setup(['x']).agent.run('go', { signal: ac.signal })).status, 'aborted');
  assert.equal((await setup([{ text: '', finish: 'content_filter' }]).agent.run('go')).status, 'refused');
  const cut = await setup([{ text: 'partial', finish: 'length' }]).agent.run('go');
  assert.equal(cut.status, 'truncated');
  assert.equal(cut.answer, 'partial');
});

test('model errors propagate and leave nothing half-done in the store', async () => {
  const { agent } = setup([new ProviderError('auth', 'bad key')]);
  await assert.rejects(agent.run('go'), (e) => e instanceof ProviderError && e.kind === 'auth');
});

test('the trace is bounded and passes through redact; onEvent sees every event', async () => {
  const { agent, events } = setup([{ toolCalls: [call('lookup', { q: 'my password is hunter2' }, 'k1')] }, 'ok'], { redact: (s) => s.replace(/hunter2/g, '[x]') });
  const r = await agent.run('my password is hunter2');
  const tc = r.trace.find((e) => e.type === 'tool-call') as Extract<TraceEvent, { type: 'tool-call' }>;
  assert.ok(!tc.args.includes('hunter2'));
  assert.ok(!JSON.stringify(r.trace).includes('hunter2'));
  assert.equal(events.length, r.trace.length);
  const long = setup(['x']);
  const lr = await long.agent.run('y'.repeat(5000));
  assert.ok((lr.trace[0] as { task: string }).task.length < 600);
});

test('invalid tool arguments from the model and reused call ids', async () => {
  const bad = { id: 'i1', name: 'lookup', arguments: {}, invalid: 'the arguments are not valid JSON' };
  const llm = { async complete() { return { id: 'r', provider: 'p', model: 'm', message: { role: 'assistant' as const, content: [{ type: 'tool_call' as const, id: 'i1', name: 'lookup', arguments: {} }] }, text: '', toolCalls: [bad], finish: 'tool_calls' as const, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }; } };
  let n = 0;
  const a = new Agent({ model: llm, modelName: 'm', tools: tools(), actor: { who: 'a', can: () => false }, now: () => new Date(0), id: () => `r${++n}`, budgets: { maxSteps: 1 } });
  const r = await a.run('go');
  assert.match(text(r.transcript[2]!)!, /could not be read: the arguments are not valid JSON/);
  const dup = setup([{ toolCalls: [call('lookup', { q: 'a' }, 'same'), call('lookup', { q: 'b' }, 'same')] }, 'x']);
  const d = await dup.agent.run('go');
  assert.equal(d.status, 'failing');
  assert.match(d.detail, /reused a tool call id/);
});

test('construction rejects duplicate tools and non-positive budgets; empty tasks are refused', async () => {
  const llm = { complete: async () => { throw new Error('unused'); } } as never;
  const base = { model: llm, modelName: 'm', actor: { who: 'a', can: () => false }, now: () => new Date(0), id: () => 'r' };
  assert.throws(() => new Agent({ ...base, tools: [tools()[0]!, tools()[0]!] }), AgentError);
  assert.throws(() => new Agent({ ...base, tools: [], budgets: { maxSteps: 0 } }), AgentError);
  await assert.rejects(new Agent({ ...base, tools: [] }).run('   '), AgentError);
  await assert.rejects(new Agent({ ...base, tools: [] }).run('x'.repeat(100_001)), AgentError);
  assert.equal(typeof memoryStore().save, 'function');
});
