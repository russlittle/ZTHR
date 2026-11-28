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

test('the protocol version is the one MCP published on 2025-06-18', () => {
  assert.equal(PROTOCOL, '2025-06-18');
});

test('arguments that are not an object are refused outright', () => {
  const s = { type: 'object' as const, properties: {} };
  for (const v of [null, undefined, [], [{}], 'x', 5, true]) assert.deepEqual(validate(s, v), ['arguments must be an object'], JSON.stringify(v));
  assert.deepEqual(validate(s, {}), []);
});

test('a string is checked for type, enum and length, the length limit being inclusive', () => {
  const s = { type: 'object' as const, properties: { t: { type: 'string' as const, maxLength: 3 }, e: { type: 'string' as const, enum: ['a', 'b'] }, free: { type: 'string' as const } } };
  assert.deepEqual(validate(s, { t: 'abc' }), []);
  assert.deepEqual(validate(s, { t: 'abcd' }), ['t can be at most 3 characters']);
  assert.deepEqual(validate(s, { t: 7 }), ['t must be a string']);
  assert.deepEqual(validate(s, { e: 'c' }), ['e must be one of a, b']);
  assert.deepEqual(validate(s, { e: 'a' }), []);
  assert.deepEqual(validate(s, { free: 'x'.repeat(10_000) }), [], 'no maxLength, no limit');
});

test('a number must be a finite number of the right kind, within its bounds, the bounds being inclusive', () => {
  const s = { type: 'object' as const, properties: {
    n: { type: 'number' as const },
    i: { type: 'integer' as const },
    r: { type: 'integer' as const, minimum: 1, maximum: 10 },
    lo: { type: 'number' as const, minimum: 5 },
    hi: { type: 'number' as const, maximum: 10 },
    z: { type: 'number' as const, minimum: 0, maximum: 0 },
  } };
  const v = (o: Record<string, unknown>) => validate(s, o);
  assert.deepEqual(v({ n: 1.5, i: 3, r: 5, lo: 5, hi: 10, z: 0 }), []);
  assert.deepEqual(v({ n: 'x' }), ['n must be a number']);
  assert.deepEqual(v({ n: NaN }), ['n must be a number']);
  assert.deepEqual(v({ n: Infinity }), ['n must be a number']);
  assert.deepEqual(v({ n: -Infinity }), ['n must be a number']);
  assert.deepEqual(v({ n: '5' }), ['n must be a number']);
  assert.deepEqual(v({ i: 1.5 }), ['i must be a whole number']);
  assert.deepEqual(v({ i: 'x' }), ['i must be a whole number']);
  assert.deepEqual(v({ i: NaN }), ['i must be a whole number']);
  assert.deepEqual(v({ i: -4 }), []);
  assert.deepEqual(v({ r: 0 }), ['r must be between 1 and 10']);
  assert.deepEqual(v({ r: 11 }), ['r must be between 1 and 10']);
  assert.deepEqual(v({ r: 1 }), []);
  assert.deepEqual(v({ r: 10 }), []);
  assert.deepEqual(v({ lo: 4.9 }), ['lo must be between 5 and ∞']);
  assert.deepEqual(v({ lo: 5.1 }), []);
  assert.deepEqual(v({ lo: 1e9 }), []);
  assert.deepEqual(v({ hi: 10.1 }), ['hi must be between -∞ and 10']);
  assert.deepEqual(v({ hi: -1e9 }), []);
  assert.deepEqual(v({ hi: 9.9 }), []);
  assert.deepEqual(v({ z: 0 }), []);
  assert.deepEqual(v({ z: 1 }), ['z must be between 0 and 0']);
  assert.deepEqual(v({ z: -1 }), ['z must be between 0 and 0']);
});

test('a boolean is true or false and nothing else', () => {
  const s = { type: 'object' as const, properties: { b: { type: 'boolean' as const } } };
  assert.deepEqual(validate(s, { b: true }), []);
  assert.deepEqual(validate(s, { b: false }), []);
  for (const bad of ['true', 1, 0, null]) assert.deepEqual(validate(s, { b: bad }), ['b must be true or false'], JSON.stringify(bad));
});

test('a list is checked for being a list, for its length (inclusive), and each item by the item type', () => {
  const s = { type: 'object' as const, properties: { l: { type: 'array' as const, items: { type: 'integer' as const }, maxItems: 2 }, any: { type: 'array' as const, items: { type: 'string' as const } } } };
  assert.deepEqual(validate(s, { l: 'x' }), ['l must be a list']);
  assert.deepEqual(validate(s, { l: {} }), ['l must be a list']);
  assert.deepEqual(validate(s, { l: [1, 2] }), []);
  assert.deepEqual(validate(s, { l: [1, 2, 3] }), ['l can have at most 2 items']);
  assert.deepEqual(validate(s, { l: [1, 'x', 2.5] }), ['l can have at most 2 items'], 'too long is reported before the items');
  assert.deepEqual(validate(s, { l: [1, 'x'] }), ['l[1] must be a whole number']);
  assert.deepEqual(validate(s, { any: Array.from({ length: 5000 }, () => 'x') }), []);
});

test('a log keeps at least one entry, a whole number of them', async () => {
  const one = new BoundedLog<number>({ keep: 1 });
  one.push(1);
  one.push(2);
  assert.deepEqual(one.entries, [2]);
  assert.equal(one.evicted, 1);
  assert.throws(() => new BoundedLog({ keep: 1.5 }), /whole number/);
  assert.throws(() => new BoundedLog({ keep: -1 }), /at least 1/);
  assert.throws(() => new BoundedLog({ keep: NaN }), /whole number/);
  const none = new BoundedLog<number>();
  none.push(1);
  assert.deepEqual([none.recorded, none.handed, none.sinkFailures, none.evicted], [1, 0, 0, 0], 'no sink: nothing handed on, nothing failed');
});

test('a sink that returns something that is not a promise, or a promise that resolves, is not a failure', async () => {
  const seen: number[] = [];
  const odd = new BoundedLog<number>({ sink: (e) => (seen.push(e), 5 as unknown as void) });
  odd.push(1);
  const obj = new BoundedLog<number>({ sink: () => ({}) as unknown as void });
  obj.push(1);
  const fine = new BoundedLog<number>({ sink: async () => 'stored' });
  fine.push(1);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual([odd.sinkFailures, obj.sinkFailures, fine.sinkFailures], [0, 0, 0]);
  assert.deepEqual([odd.handed, obj.handed, fine.handed], [1, 1, 1]);
  assert.deepEqual(seen, [1]);
});

test('anything that is not a JSON-RPC request object is an invalid request with a null id, and never crashes the handler', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools);
  const fn = Object.assign(() => 0, { jsonrpc: '2.0', id: 5, method: 'ping' });
  const arr = Object.assign([], { jsonrpc: '2.0', id: 5, method: 'ping' });
  for (const raw of [null, undefined, 'ping', 5, true, [], [{ jsonrpc: '2.0', id: 1, method: 'ping' }], arr, fn]) {
    assert.deepEqual(await s.handle(raw, reader), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a JSON-RPC 2.0 request' } }, String(raw));
  }
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 1, method: 5 }, reader), { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'not a JSON-RPC 2.0 request' } }, 'the method must be a string');
  assert.deepEqual(await s.handle({ jsonrpc: '1.0', id: 1, method: 'ping' }, reader), { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'not a JSON-RPC 2.0 request' } });
  assert.deepEqual(await s.handle({ id: 1, method: 'ping' }, reader), { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'not a JSON-RPC 2.0 request' } });
});

test('a request id is echoed whether it is a string or a number; one that is neither is refused', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 'abc', method: 'ping' }, reader), { jsonrpc: '2.0', id: 'abc', result: {} });
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 0, method: 'ping' }, reader), { jsonrpc: '2.0', id: 0, result: {} });
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: '', method: 'ping' }, reader), { jsonrpc: '2.0', id: '', result: {} });
  for (const id of [NaN, Infinity, -Infinity, undefined]) {
    const r = await s.handle({ jsonrpc: '2.0', id, method: 'ping' }, reader);
    assert.deepEqual(r, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'a request id is a string or a number' } }, String(id));
  }
  assert.equal(await s.handle({ jsonrpc: '2.0', method: 'ping' }, reader), undefined, 'no id at all is a notification');
});

test('errors are complete JSON-RPC replies; data appears only when there is some', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, reader), { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'no method resources/list' } });
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } }, reader), { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'no tool nope' } });
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call' }, reader), { jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'no tool undefined' } }, 'a call with no params at all is a missing tool, not a crash');
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 7 } }, reader), { jsonrpc: '2.0', id: 5, error: { code: -32602, message: 'no tool 7' } });
  assert.deepEqual(s.log.map((l) => [l.tool, l.outcome]), [['nope', 'denied'], ['undefined', 'denied'], ['7', 'denied']]);
});

test('replies to ping and tools/list are complete, with the annotations a client reads to decide whether to ask', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools);
  assert.deepEqual(await s.handle({ jsonrpc: '2.0', id: 1, method: 'ping' }, reader), { jsonrpc: '2.0', id: 1, result: {} });
  const list = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, editor))!;
  assert.equal(list.jsonrpc, '2.0');
  assert.equal(list.id, 2);
  assert.deepEqual((list.result as { tools: unknown[] }).tools, [
    { name: 'read_file', title: 'Read a file', description: 'Returns a file’s text', inputSchema: tools[0]!.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'delete_file', title: 'Delete a file', description: 'Moves a file to the trash', inputSchema: tools[1]!.inputSchema, annotations: { readOnlyHint: false, destructiveHint: true } },
  ]);
});

test('a tool result: text as it is, other values as JSON, objects also as structured content, null and lists not', async () => {
  const mk = (name: string, value: unknown): Tool => ({ name, title: name, description: name, inputSchema: { type: 'object', properties: {} }, run: async () => value });
  const s = new Server({ name: 'f', version: '1' }, [mk('nothing', null), mk('obj', { a: 1 }), mk('text', 'plain'), mk('num', 7)]);
  const call = async (name: string) => (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }, reader))!.result;
  assert.deepEqual(await call('nothing'), { content: [{ type: 'text', text: 'null' }], isError: false });
  assert.deepEqual(await call('obj'), { content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 }, isError: false });
  assert.deepEqual(await call('text'), { content: [{ type: 'text', text: 'plain' }], isError: false });
  assert.deepEqual(await call('num'), { content: [{ type: 'text', text: '7' }], isError: false });
});

test('a tool that fails gives the agent its message as a result flagged as an error, whatever was thrown', async () => {
  const thrower = (v: unknown): Tool => ({ name: 'boom', title: 'Boom', description: 'Fails', inputSchema: { type: 'object', properties: {} }, run: async () => { throw v; } });
  const call = async (v: unknown) => {
    const s = new Server({ name: 'f', version: '1' }, [thrower(v)], () => new Date('2026-11-26T00:00:00Z'));
    const r = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom' } }, reader);
    return { r, log: s.log[0]! };
  };
  const a = await call(new Error('disk on fire'));
  assert.deepEqual(a.r, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'disk on fire' }], isError: true } });
  assert.deepEqual(a.log, { at: '2026-11-26T00:00:00.000Z', who: 'agent-for-ana', tool: 'boom', ok: false, outcome: 'error', error: 'disk on fire' });
  const b = await call('just a string');
  assert.deepEqual((b.r!.result as { content: unknown }).content, [{ type: 'text', text: 'just a string' }]);
  assert.equal(b.log.error, 'just a string');
  assert.equal(((await call(42)).r!.result as { content: { text: string }[] }).content[0]!.text, '42');
});

test('a successful call is logged as ok, with the time it was made and who made it, and no error', async () => {
  const s = new Server({ name: 'f', version: '1' }, tools, () => new Date('2026-11-26T01:02:03Z'));
  await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/a.txt' } } }, reader);
  assert.deepEqual(s.log, [{ at: '2026-11-26T01:02:03.000Z', who: 'agent-for-ana', tool: 'read_file', ok: true, outcome: 'ok' }]);
});
