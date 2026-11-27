import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL, Server, validate, type Tool } from './index.ts';

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
  assert.deepEqual(s.log.map((l) => [l.who, l.tool, l.ok]), [['agent-for-ana', 'read_file', true], ['agent-for-ben', 'delete_file', true], ['agent-for-ana', 'read_file', false]]);
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
