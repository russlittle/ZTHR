import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidDefinition, InvalidParameters, Registry, UnknownNode, checkSchema, withDefaults } from './index.ts';
import type { CredentialType, JsonSchema, NodeType } from './index.ts';

const apiKey: CredentialType = {
  name: 'slackApi',
  displayName: 'Slack API',
  schema: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', minLength: 8, description: 'Bot token' }, workspace: { type: 'string' } } },
  secretFields: ['token'],
  authenticate: { kind: 'bearer', field: 'token' },
};

const slack: NodeType = {
  name: 'slack',
  displayName: 'Slack',
  group: 'action',
  versions: [
    {
      version: 1,
      credentials: ['slackApi'],
      operations: [{ name: 'post', description: 'Post a message', parameters: { type: 'object', required: ['channel', 'text'], properties: { channel: { type: 'string' }, text: { type: 'string' } } } }],
    },
    {
      version: 2,
      credentials: ['slackApi'],
      migrateFromPrevious: [{ rename: { channel: 'channelId' } }, { set: { unfurl: false } }],
      operations: [
        {
          name: 'post',
          description: 'Post a message to a channel',
          parameters: { type: 'object', required: ['channelId', 'text'], additionalProperties: false, properties: { channelId: { type: 'string', pattern: '^C[A-Z0-9]+$' }, text: { type: 'string', maxLength: 40 }, unfurl: { type: 'boolean', default: true }, retries: { type: 'integer', minimum: 0, maximum: 5, default: 2 } } },
          output: { type: 'object', required: ['ok', 'ts'], properties: { ok: { type: 'boolean' }, ts: { type: 'string' } } },
        },
        { name: 'list', description: 'List channels', readOnly: true, parameters: { type: 'object' } },
      ],
      fixtures: [{ name: 'basic post', operation: 'post', parameters: { channelId: 'C123', text: 'hi' }, output: { ok: true, ts: '1.2' } }],
    },
  ],
};

const make = () => {
  const r = new Registry();
  r.addCredentialType(apiKey);
  r.addNode(slack);
  return r;
};

test('schema checks report every problem with its path', () => {
  const s = { type: 'object', required: ['a', 'b'], properties: { a: { type: 'integer', minimum: 1 }, b: { type: 'string', enum: ['x', 'y'] }, c: { type: 'array', items: { type: 'string' }, maxItems: 2 } }, additionalProperties: false } as const;
  const p = checkSchema(s, { a: 0, b: 'z', c: ['ok', 3, 'x'], extra: 1 });
  assert.deepEqual(p.map((x) => x.path).sort(), ['/a', '/b', '/c', '/c/1', '/extra']);
  assert.deepEqual(checkSchema(s, { a: 1, b: 'x' }), []);
  assert.deepEqual(checkSchema(s, { a: 1 }), [{ path: '/b', message: 'is required' }]);
});

test('integer is a number, a float is not an integer, null is its own type', () => {
  assert.deepEqual(checkSchema({ type: 'number' }, 3), []);
  assert.match(checkSchema({ type: 'integer' }, 3.5)[0]!.message, /expected integer, got number/);
  assert.match(checkSchema({ type: 'string' }, null)[0]!.message, /got null/);
  assert.deepEqual(checkSchema({ type: ['string', 'null'] }, null), []);
});

test('oneOf needs exactly one match, anyOf at least one, const and pattern are enforced', () => {
  const s: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'string', minLength: 2 }] };
  assert.match(checkSchema(s, 'ab')[0]!.message, /matched 2/);
  assert.deepEqual(checkSchema(s, 'a'), []);
  assert.deepEqual(checkSchema({ anyOf: [{ type: 'null' }, { type: 'integer' }] }, 4), []);
  assert.equal(checkSchema({ anyOf: [{ type: 'null' }, { type: 'integer' }] }, 'x').length, 1);
  assert.equal(checkSchema({ const: { a: 1 } }, { a: 2 }).length, 1);
  assert.equal(checkSchema({ pattern: '^a+$' }, 'aab').length, 1);
});

test('defaults fill in missing fields without changing the input', () => {
  const input = { channelId: 'C1', text: 'x' };
  const filled = withDefaults(slack.versions[1]!.operations[0]!.parameters, input) as Record<string, unknown>;
  assert.equal(filled.unfurl, true);
  assert.equal(filled.retries, 2);
  assert.equal('unfurl' in input, false);
  assert.equal((withDefaults({ properties: { a: { default: 1 } } }, { a: 5 }) as { a: number }).a, 5);
});

test('registering refuses bad names, duplicates, unknown credentials and disordered versions', () => {
  const r = make();
  assert.throws(() => r.addNode(slack), /already registered/);
  assert.throws(() => r.addNode({ ...slack, name: 'Bad Name' }), InvalidDefinition);
  assert.throws(() => r.addNode({ ...slack, name: 'x', versions: [] }), /no versions/);
  assert.throws(() => r.addNode({ ...slack, name: 'x', versions: [{ version: 1, operations: [], credentials: ['nope'] }] }), /unknown credential type nope/);
  assert.throws(() => r.addNode({ ...slack, name: 'x', versions: [{ version: 2, operations: [], credentials: [] }, { version: 1, operations: [], credentials: [] }] }), /ascending/);
  assert.throws(() => r.addNode({ ...slack, name: 'x', versions: [{ version: 1, operations: [], credentials: [] }, { version: 1, operations: [], credentials: [] }] }), /twice/);
  assert.throws(() => r.addCredentialType({ ...apiKey, name: 'other', secretFields: ['missing'] }), /not in the schema/);
  assert.throws(() => r.addCredentialType(apiKey), /already registered/);
});

test('node lookup picks the newest live version and refuses unknown ones', () => {
  const r = make();
  assert.equal(r.node('slack').version, 2);
  assert.equal(r.node('slack', 1).version, 1);
  assert.throws(() => r.node('slack', 9), /has no version 9/);
  assert.throws(() => r.node('nothing'), UnknownNode);
  const d = new Registry();
  d.addNode({ name: 'old', displayName: 'Old', group: 'action', versions: [{ version: 1, operations: [], credentials: [] }, { version: 2, deprecated: 'use 1', operations: [], credentials: [] }] });
  assert.equal(d.node('old').version, 1, 'a deprecated version is not the default');
  assert.deepEqual(d.catalogue()[0]!.deprecatedVersions, [2]);
});

test('parameters are validated per version and operation, with defaults applied', () => {
  const r = make();
  const ok = r.validateParameters('slack', 2, 'post', { channelId: 'C123', text: 'hello' }) as Record<string, unknown>;
  assert.equal(ok.retries, 2);
  assert.throws(() => r.validateParameters('slack', 2, 'post', { channelId: 'general', text: 'x'.repeat(41), retries: 9 }), (e: unknown) => e instanceof InvalidParameters && e.problems.length === 3);
  assert.throws(() => r.validateParameters('slack', 2, 'delete', {}), /no operation delete/);
  r.validateParameters('slack', 1, 'post', { channel: 'general', text: 'x'.repeat(100) });
});

test('credentials are checked against their type and the version that accepts them', () => {
  const r = make();
  r.validateCredential('slack', 2, 'slackApi', { token: 'xoxb-12345678' });
  assert.throws(() => r.validateCredential('slack', 2, 'slackApi', { token: 'short' }), /at least 8/);
  assert.throws(() => r.validateCredential('slack', 2, 'slackApi', { token: 'xoxb-12345678', stray: 1 }), /not a known field/);
  r.addCredentialType({ ...apiKey, name: 'basicCred', schema: { type: 'object', properties: { user: { type: 'string' }, password: { type: 'string' } } }, secretFields: ['password'], authenticate: { kind: 'basic' } });
  assert.throws(() => r.validateCredential('slack', 2, 'basicCred', {}), /does not accept basicCred/);
});

test('secrets are redacted and never described, and authentication is built for each kind', () => {
  const r = make();
  assert.deepEqual(r.redactCredential('slackApi', { token: 'xoxb-secret', workspace: 'acme' }), { token: '***', workspace: 'acme' });
  const d = r.describeCredential('slackApi');
  assert.deepEqual(d.fields, [{ name: 'token', secret: true, required: true, description: 'Bot token' }, { name: 'workspace', secret: false, required: false }]);
  assert.equal(r.authenticate('slackApi', { token: 'abc' }).headers.authorization, 'Bearer abc');
  r.addCredentialType({ name: 'basicCred', displayName: 'Basic', schema: { type: 'object', properties: { user: { type: 'string' }, password: { type: 'string' } } }, secretFields: ['password'], authenticate: { kind: 'basic' } });
  assert.equal(r.authenticate('basicCred', { user: 'u', password: 'p' }).headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  r.addCredentialType({ name: 'hdr', displayName: 'Header', schema: { type: 'object', properties: { key: { type: 'string' } } }, secretFields: ['key'], authenticate: { kind: 'header', field: 'key', name: 'X-Api-Key' } });
  assert.deepEqual(r.authenticate('hdr', { key: 'k' }).headers, { 'x-api-key': 'k' });
  r.addCredentialType({ name: 'qry', displayName: 'Query', schema: { type: 'object', properties: { key: { type: 'string' } } }, secretFields: ['key'], authenticate: { kind: 'query', field: 'key', name: 'token' } });
  assert.deepEqual(r.authenticate('qry', { key: 'k' }).query, { token: 'k' });
  assert.throws(() => r.authenticate('qry', {}), /is required/);
});

test('saved parameters migrate forward through declared steps, never backwards', () => {
  const r = make();
  assert.deepEqual(r.migrate('slack', { channel: 'C1', text: 'hi' }, 1, 2), { channelId: 'C1', text: 'hi', unfurl: false });
  assert.deepEqual(r.migrate('slack', { channelId: 'C1' }, 2, 2), { channelId: 'C1' });
  assert.throws(() => r.migrate('slack', {}, 2, 1), /backwards/);
  const m = new Registry();
  m.addNode({ name: 'a', displayName: 'A', group: 'flow', versions: [{ version: 1, operations: [], credentials: [] }, { version: 2, operations: [], credentials: [], migrateFromPrevious: [{ remove: ['old'] }] }] });
  assert.deepEqual(m.migrate('a', { old: 1, keep: 2 }, 1, 2), { keep: 2 });
});

test('the catalogue filters by group and by text in descriptions', () => {
  const r = make();
  r.addNode({ name: 'cron', displayName: 'Cron', group: 'trigger', versions: [{ version: 1, operations: [{ name: 'tick', description: 'Fires on a schedule', parameters: {} }], credentials: [] }] });
  assert.deepEqual(r.catalogue().map((c) => c.name), ['cron', 'slack']);
  assert.deepEqual(r.catalogue({ group: 'trigger' }).map((c) => c.name), ['cron']);
  assert.deepEqual(r.catalogue({ text: 'SCHEDULE' }).map((c) => c.name), ['cron']);
  assert.equal(r.catalogue({ text: 'channels' })[0]!.latest, 2);
});

test('fixtures pass when the executor returns the sample, and fail with a reason when it does not', async () => {
  const r = make();
  const good = await r.runFixtures(async () => ({ ok: true, ts: '1.2' }));
  assert.deepEqual(good, [{ node: 'slack', version: 2, fixture: 'basic post', ok: true }]);
  const differ = await r.runFixtures(async () => ({ ok: true, ts: '9' }));
  assert.equal(differ[0]!.problem, 'executor output differs from the sample');
  const threw = await r.runFixtures(async () => { throw new Error('boom'); });
  assert.equal(threw[0]!.problem, 'executor threw: boom');
});

test('a fixture whose own sample breaks the schema is reported before it is ever run', async () => {
  const r = new Registry();
  r.addNode({ name: 'bad', displayName: 'Bad', group: 'action', versions: [{ version: 1, credentials: [], operations: [{ name: 'op', description: 'd', parameters: { type: 'object', required: ['a'] }, output: { type: 'object', required: ['id'] } }], fixtures: [{ name: 'no params', operation: 'op', parameters: {}, output: { id: 1 } }, { name: 'bad output', operation: 'op', parameters: { a: 1 }, output: {} }, { name: 'ghost', operation: 'zzz', parameters: {}, output: {} }] }] });
  let calls = 0;
  const res = await r.runFixtures(async () => { calls++; return null; });
  assert.equal(calls, 0);
  assert.deepEqual(res.map((x) => x.problem), ['parameters: /a is required', 'sample output: /id is required', 'unknown operation zzz']);
});

test('hostile keys such as __proto__ are not treated as present fields', () => {
  const evil = JSON.parse('{"__proto__": {"required": 1}, "channelId": "C1", "text": "x"}');
  const p = checkSchema(slack.versions[1]!.operations[0]!.parameters, evil);
  assert.deepEqual(p.map((x) => x.path), ['/__proto__']);
  assert.equal(checkSchema({ type: 'object', required: ['toString'] }, {})[0]!.path, '/toString');
});
