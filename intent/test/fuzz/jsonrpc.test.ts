/** Fuzz: JSON-RPC handling and argument validation of the MCP server (blocks/mcp Server.handle, validate). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Server, validate, type Schema, type Tool } from '../../blocks/mcp/index.ts';
import { forAll, type Rand } from './harness.ts';

const KEYS = ['jsonrpc', 'id', 'method', 'params', 'name', 'arguments', 'path', 'n', 'tags', 'mode', '__proto__', 'constructor', 'prototype', 'polluted', 'toString', ''];

/** Any JSON value, built as text and parsed, so keys like __proto__ are own properties as they are off the wire. */
export const jsonText = (r: Rand, depth = 0): string => {
  const k = r.int(0, depth > 3 ? 4 : 7);
  if (k === 0) return 'null';
  if (k === 1) return r.pick(['true', 'false']);
  if (k === 2) return String(r.pick([0, -1, 1, 1.5, 1e308, -0, 2 ** 53, r.int(-1e6, 1e6)]));
  if (k <= 4) return JSON.stringify(r.bool(0.5) ? r.pick(['2.0', '1.0', 'ping', 'tools/call', 'read_file', '/a.txt', 'yes', '']) : r.text(0, 6));
  if (k === 5) return `[${r.array(0, 4, () => jsonText(r, depth + 1)).join(',')}]`;
  return `{${r.array(0, 5, () => `${JSON.stringify(r.bool(0.8) ? r.pick(KEYS) : r.text(0, 4))}:${jsonText(r, depth + 1)}`).join(',')}}`;
};

const ID = ['1', '0', '-7', '1.5', '"abc"', '""', 'null', 'true', '[]', '{}', '1e400'];
const METHOD = ['"tools/call"', '"tools/call"', '"tools/call"', '"initialize"', '"ping"', '"tools/list"', '"tools/call"', '"notifications/initialized"', '"nope"', '"__proto__"', '"constructor"', '"toString"', '1', 'null'];

/** A message near the protocol: random fields, often with the right shape. */
const GOOD: Record<string, string[]> = {
  read_file: ['{"path":"/a.txt"}', '{"path":"/boom"}', '{"path":""}', '{"path":"/a.txt","extra":1}', '{}', '{"path":7}'],
  delete_file: ['{"path":"/a.txt"}', '{"path":"/a.txt","extra":true}', '{"path":null}'],
  count: ['{"n":3}', '{"n":0,"tags":["a","b"],"mode":"fast"}', '{"n":100,"tags":[]}', '{"n":101}', '{"n":1.5}', '{"n":3,"tags":["c"]}', '{"n":3,"tags":["a","a","a","a"]}', '{"n":"3"}', '{"n":3,"__proto__":{"polluted":1}}', '{"n":3,"constructor":{"prototype":{"polluted":1}}}'],
};

const message = (r: Rand): string => {
  if (r.bool(0.35)) {
    const name = r.pick(Object.keys(GOOD));
    return `{"jsonrpc":"2.0","id":${r.pick(['1', '"x"', 'null'])},"method":"tools/call","params":{"name":"${name}","arguments":${r.pick(GOOD[name]!)}}}`;
  }
  if (r.bool(0.25)) return jsonText(r);
  const fields: string[] = [];
  if (r.bool(0.9)) fields.push(`"jsonrpc":${r.pick(['"2.0"', '"2.0"', '"2.0"', '"1.0"', '2', 'null'])}`);
  if (r.bool(0.75)) fields.push(`"id":${r.pick(ID)}`);
  if (r.bool(0.95)) fields.push(`"method":${r.pick(METHOD)}`);
  if (r.bool(0.7)) {
    const name = r.pick(['"read_file"', '"delete_file"', '"count"', '"nope"', '"__proto__"', '"constructor"', '7', 'null']);
    const good = r.pick(['{"path":"/a.txt"}', '{"path":"/boom"}', '{"n":3}', '{"n":0,"tags":["a","b"],"mode":"fast"}', '{"n":100,"tags":[]}', '{"path":"x","extra":1}']);
    const args = r.bool(0.4) ? good : r.bool(0.6) ? `{${r.array(0, 4, () => `${JSON.stringify(r.pick(KEYS))}:${r.bool(0.5) ? r.pick(['"/a.txt"', '"x"', '3', '-1', '1000', '1.5', '["a"]', '["a",1]', 'true', '"fast"', '{}', 'null']) : jsonText(r, 2)}`).join(',')}}` : jsonText(r, 2);
    fields.push(`"params":${r.bool(0.8) ? `{"name":${name},"arguments":${args}}` : jsonText(r, 1)}`);
  }
  return `{${fields.join(',')}}`;
};

const schemas: Record<string, Schema> = {
  read_file: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 } }, required: ['path'], additionalProperties: false },
  delete_file: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  count: { type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 100 }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 3 }, mode: { type: 'string', enum: ['fast', 'slow'] } }, required: ['n'], additionalProperties: false },
};

/** Tools that record what they were run with, so the test can check validation happened first. */
const makeServer = () => {
  const ran: { tool: string; args: Record<string, unknown>; who: string }[] = [];
  const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
    name,
    title: name,
    description: name,
    inputSchema: schemas[name]!,
    run: async (args, as) => {
      ran.push({ tool: name, args, who: as.who });
      if (args.path === '/boom') throw new Error('tool failed');
      return name === 'count' ? { n: args.n } : 'ok';
    },
    ...extra,
  });
  const s = new Server({ name: 'fuzz', version: '1' }, [tool('read_file', { readOnly: true }), tool('delete_file', { permission: 'files.delete' }), tool('count')], () => new Date('2026-11-27T00:00:00Z'));
  return { s, ran };
};

const polluted = () => Object.hasOwn(Object.prototype, 'polluted') || ({} as Record<string, unknown>).polluted !== undefined || Object.hasOwn(Array.prototype, 'polluted');

test('random JSON messages never throw out of Server.handle; replies are JSON-RPC 2.0 with result xor error; notifications get undefined (3000 cases)', async () => {
  await forAll('jsonrpc handle', {
    cases: 3000,
    gen: (r) => ({ text: message(r), editor: r.bool(0.4) }),
    shrink: () => [],
    check: async ({ text, editor }) => {
      const raw: unknown = JSON.parse(text);
      const { s, ran } = makeServer();
      const as = { who: 'agent', can: (p: string) => editor && p === 'files.delete' };
      const reply = await s.handle(raw, as);
      assert.ok(!polluted(), 'Object.prototype was polluted');
      const m = raw as Record<string, unknown> | null;
      const isObj = m !== null && typeof m === 'object' && !Array.isArray(m);
      const wellFormed = isObj && m.jsonrpc === '2.0' && typeof m.method === 'string';
      const hasId = isObj && Object.hasOwn(m, 'id');
      if (wellFormed && !hasId) {
        assert.equal(reply, undefined, 'a notification got a reply');
        assert.equal(ran.length, 0, 'a notification ran a tool');
        return;
      }
      assert.ok(reply, 'a request got no reply');
      assert.equal(reply.jsonrpc, '2.0');
      assert.ok(Object.hasOwn(reply, 'result') !== Object.hasOwn(reply, 'error'), 'needs exactly one of result and error');
      const id = isObj ? m.id : undefined;
      const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
      assert.equal(reply.id, validId ? id : null, 'the reply id');
      if (reply.error) {
        assert.ok(Number.isInteger(reply.error.code) && typeof reply.error.message === 'string');
        assert.ok([-32600, -32601, -32602, -32603, -32700].includes(reply.error.code), `code ${reply.error.code}`);
      }
      assert.doesNotThrow(() => JSON.stringify(reply), 'the reply must serialise');
      // A tool runs only with arguments its schema accepts, only with permission, at most once.
      assert.ok(ran.length <= 1);
      for (const r of ran) {
        assert.deepEqual(validate(schemas[r.tool]!, r.args), [], `${r.tool} ran with bad arguments ${JSON.stringify(r.args)}`);
        if (r.tool === 'delete_file') assert.ok(editor, 'delete_file ran without permission');
      }
      if (ran.length) assert.ok(reply.result && !reply.error);
    },
  });
});

test('mcp validate(): objects with __proto__, constructor and prototype keys never pollute Object.prototype, and return string problems (3000 cases)', async () => {
  await forAll('mcp validate pollution', {
    cases: 3000,
    gen: (r) => ({ schema: r.pick(Object.keys(schemas)), text: r.bool(0.7) ? `{${r.array(0, 5, () => `${JSON.stringify(r.pick(['__proto__', 'constructor', 'prototype', 'polluted', 'n', 'path', 'tags']))}:${r.bool() ? '{"polluted":"yes","__proto__":{"polluted":"yes"}}' : jsonText(r, 2)}`).join(',')}}` : jsonText(r) }),
    shrink: () => [],
    check: ({ schema, text }) => {
      const v: unknown = JSON.parse(text);
      const out = validate(schemas[schema]!, v);
      assert.ok(Array.isArray(out) && out.every((x) => typeof x === 'string'));
      assert.ok(!polluted(), 'Object.prototype was polluted');
      // Only own keys count: an inherited name is never treated as a declared property.
      if (v && typeof v === 'object' && !Array.isArray(v) && schemas[schema]!.additionalProperties === false)
        for (const k of Object.keys(v)) if (!Object.hasOwn(schemas[schema]!.properties, k)) assert.ok(out.includes(`${k} is not an argument of this tool`), `${k} slipped through`);
    },
  });
});
