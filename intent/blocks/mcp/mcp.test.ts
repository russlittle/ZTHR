import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedLog, PROTOCOL, Server, validate, type CallLog, type Tool } from './index.ts';

const files = new Map([['/a.txt', 'hello']]);
const tools: Tool[] = [
  { name: 'read_file', title: 'Read a file', description: 'Returns a file’s text', readOnly: true, inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 } }, required: ['path'], additionalProperties: false }, run: async (a) => {
    const t = files.get(a.path as string);
    if (t === undefined) throw new Error(`no file ${String(a.path)}`);
    return t;
  } },
  { name: 'delete_file', title: 'Delete a file', description: 'Moves a file to the trash', permission: 'files.delete', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, run: async (a) => ({ deleted: a.path }) },
];
const reader = { who: 'agent-for-ana', can: () => false };
const editor = { who: 'agent-for-ben', can: (p: string) => p === 'files.delete' };

test('initialize, list and call; the agent sees and does only what its person can', async () => {
  const s = new Server({ name: 'files', version: '1.0.0' }, tools, () => new Date('2026-11-26T00:00:00Z'));
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, reader);
  assert.deepEqual(init!.result, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'files', version: '1.0.0' } });
  const list = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, reader))!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
  assert.deepEqual(list.tools.map((t) => [t.name, t.annotations.readOnlyHint]), [['read_file', true]]);
  assert.equal(((await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, editor))!.result as { tools: unknown[] }).tools.length, 2);
  const call = await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/a.txt' } } }, reader);
  assert.deepEqual(call!.result, { content: [{ type: 'text', text: 'hello' }], isError: false });
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delete_file', arguments: { path: '/a.txt' } } }, reader))!.error!.code, -32602);
  const del = (await s.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'delete_file', arguments: { path: '/a.txt' } } }, editor))!.result as { structuredContent: unknown };
  assert.deepEqual(del.structuredContent, { deleted: '/a.txt' });
  const missing = (await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/nope' } } }, reader))!.result as { isError: boolean };
  assert.equal(missing.isError, true, 'a tool failure is a result the agent can read, not a protocol error');
  assert.deepEqual(s.log.map((l) => [l.who, l.tool, l.ok, l.outcome]), [['agent-for-ana', 'read_file', true, 'ok'], ['agent-for-ana', 'delete_file', false, 'denied'], ['agent-for-ben', 'delete_file', true, 'ok'], ['agent-for-ana', 'read_file', false, 'error']]);
});

test('arguments are checked against the schema; protocol errors use the JSON-RPC codes; notifications get no reply', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools);
  const bad = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: 7, extra: true } } }, reader);
  assert.deepEqual(bad!.error, { code: -32602, message: 'the arguments do not match the tool', data: ['path must be a string', 'extra is not an argument of this tool'] });
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, reader))!.error!.code, -32601);
  assert.equal((await s.handle({ id: 3, method: 'ping' }, reader))!.error!.code, -32600);
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, reader), undefined);
  assert.deepEqual(validate({ type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 10 }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 2 } } }, { n: 1.5, tags: ['a', 'c'] }), ['n must be a whole number', 'tags[1] must be one of a, b']);
  assert.throws(() => new Server({ name: 'f', version: '1' }, [{ ...tools[0]!, name: 'read file' }]), /tool names/);
});

test('argument names that live on Object.prototype are checked like any other, never crash the handler', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools);
  const strict = { type: 'object' as const, properties: { path: { type: 'string' as const } }, required: ['path'], additionalProperties: false as const };
  assert.deepEqual(validate(strict, JSON.parse('{"path":"/a","constructor":1}')), ['constructor is not an argument of this tool']);
  assert.deepEqual(validate(strict, JSON.parse('{"path":"/a","__proto__":{"x":1}}')), ['__proto__ is not an argument of this tool']);
  assert.deepEqual(validate({ type: 'object', properties: {}, required: ['toString'] }, {}), ['toString is required']);
  const open = { type: 'object' as const, properties: { path: { type: 'string' as const } }, required: ['path'] };
  assert.deepEqual(validate(open, { path: '/a', toString: 'x' }), []);
  const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_file', arguments: JSON.parse('{"path":"/a","hasOwnProperty":1}') } }, editor);
  assert.equal(r!.error, undefined, 'an unknown extra argument on a tool that allows extras is ignored, not a crash');
});

test('a request id must be a string or a number (MCP forbids null); others are invalid requests', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools);
  for (const id of [null, {}, [1], true]) {
    const r = await s.handle({ jsonrpc: '2.0', id, method: 'ping' }, reader);
    assert.equal(r!.error!.code, -32600, JSON.stringify(id));
    assert.equal(r!.id, null);
  }
});

test('structuredContent is only ever a JSON object; duplicate tool names are refused', async () => {
  const list: Tool = { name: 'list', title: 'List', description: 'Lists', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: async () => ['a', 'b'] };
  const s = new Server({ name: 'f', version: '1' }, [list]);
  const r = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list', arguments: {} } }, reader))!.result as Record<string, unknown>;
  assert.deepEqual(r.content, [{ type: 'text', text: '["a","b"]' }]);
  assert.equal('structuredContent' in r, false);
  assert.throws(() => new Server({ name: 'f', version: '1' }, [tools[0]!, { ...tools[1]!, name: 'read_file' }]), /twice/);
});

test('denied and invalid calls are logged for security monitoring, with the outcome apart from ok', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools, () => new Date('2026-11-26T00:00:00Z'));
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_file', arguments: { path: '/a.txt' } } }, reader);
  await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'drop_database', arguments: {} } }, reader);
  await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 7 } } }, reader);
  assert.deepEqual(s.log, [
    { at: '2026-11-26T00:00:00.000Z', who: 'agent-for-ana', tool: 'delete_file', ok: false, outcome: 'denied', error: 'not permitted: needs files.delete' },
    { at: '2026-11-26T00:00:00.000Z', who: 'agent-for-ana', tool: 'drop_database', ok: false, outcome: 'denied', error: 'no such tool' },
    { at: '2026-11-26T00:00:00.000Z', who: 'agent-for-ana', tool: 'read_file', ok: false, outcome: 'invalid', error: 'the arguments do not match the tool', problems: ['path must be a string'] },
  ]);
  const hidden = await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_file', arguments: {} } }, reader);
  const missing = await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }, reader);
  assert.deepEqual(hidden!.error!.code, missing!.error!.code, 'the agent still cannot tell a hidden tool from a missing one');
  await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x'.repeat(10_000), arguments: {} } }, reader);
  assert.equal(s.log.at(-1)!.tool.length, 200, 'a caller cannot bloat the log with a long name');
});

test('the call log keeps the most recent calls in memory and hands every one to the sink', async () => {
  const stored: CallLog[] = [];
  const s = new Server({ name: 'f', version: '1' }, tools, () => new Date('2026-11-26T00:00:00Z'), { keep: 2, sink: (e) => void stored.push(e) });
  for (let i = 0; i < 5; i++) await s.handle({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'read_file', arguments: { path: i % 2 ? '/a.txt' : 7 } } }, reader);
  assert.equal(s.log.length, 2);
  assert.deepEqual(s.log.map((l) => l.outcome), ['ok', 'invalid']);
  assert.equal(stored.length, 5);
  assert.deepEqual([s.calls.recorded, s.calls.handed, s.calls.evicted, s.calls.sinkFailures], [5, 5, 3, 0]);
  const failing = new Server({ name: 'f', version: '1' }, tools, undefined, { sink: () => { throw new Error('disk full'); } });
  const r = await failing.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/a.txt' } } }, reader);
  assert.equal((r!.result as { isError: boolean }).isError, false, 'a failing sink never breaks the call');
  const rejecting = new BoundedLog<number>({ sink: async () => { throw new Error('offline'); } });
  rejecting.push(1);
  await new Promise((res) => setImmediate(res));
  assert.equal(failing.calls.sinkFailures + rejecting.sinkFailures, 2);
  assert.throws(() => new BoundedLog({ keep: 0 }), /at least 1/);
  assert.equal(new Server({ name: 'f', version: '1' }, tools).calls.entries.length, 0);
});
