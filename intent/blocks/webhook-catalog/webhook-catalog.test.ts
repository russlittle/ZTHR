import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog, CatalogError, DeliveryLog, InvalidPayload, check, redact, type EventDef } from './index.ts';

const NOW = new Date('2026-03-01T12:00:00Z');
const paid = (over: Partial<EventDef> = {}): EventDef => ({
  type: 'invoice.paid',
  version: 1,
  summary: 'An invoice was paid in full',
  schema: {
    type: 'object',
    required: ['invoice', 'amount', 'currency'],
    additionalProperties: false,
    properties: {
      invoice: { type: 'string', format: 'uuid' },
      amount: { type: 'integer', minimum: 1 },
      currency: { type: 'string', enum: ['USD', 'EUR'] },
      payer: { type: 'object', properties: { email: { type: 'string', format: 'email', 'x-sensitive': true }, name: { type: 'string' } }, required: ['name'] },
      paidAt: { type: 'string', format: 'date-time' },
    },
  },
  sample: { invoice: '3f2b8c1e-0a52-4f6e-9d1a-6c5a2b7e9f10', amount: 4200, currency: 'USD', payer: { email: 'ana@example.org', name: 'Ana' } },
  ...over,
});
const cat = () => {
  const c = new Catalog();
  c.define(paid());
  c.define({ type: 'invoice.voided', version: 1, summary: 'An invoice was voided', schema: { type: 'object', required: ['invoice'], properties: { invoice: { type: 'string' } } }, sample: { invoice: 'inv-1' } });
  c.define({ type: 'user.created', version: 1, summary: 'A user signed up', schema: { type: 'object', properties: { id: { type: 'string' } } }, sample: { id: 'u1' } });
  return c;
};

test('a sample that does not satisfy its own schema is refused at definition', () => {
  const c = new Catalog();
  assert.throws(() => c.define(paid({ sample: { invoice: 'not-a-uuid', amount: 1, currency: 'USD' } })), /sample does not satisfy its schema: \$\.invoice must be a valid uuid/);
  assert.throws(() => c.define(paid({ sample: { amount: 0, currency: 'GBP' } })), /\$\.invoice is required; \$\.amount must be at least 1; \$\.currency must be one of "USD", "EUR"/);
});

test('event names, versions and schemas are checked when declared', () => {
  const c = cat();
  assert.throws(() => c.define(paid({ type: 'InvoicePaid' })), /lower-case and dotted/);
  assert.throws(() => c.define(paid({ version: 1 })), /version 1 is not newer than 1/);
  assert.throws(() => c.define(paid({ version: 0 })), CatalogError);
  assert.throws(() => c.define(paid({ type: 'a.b', summary: ' ' })), /needs a summary/);
  assert.throws(() => c.define(paid({ type: 'a.b', schema: { type: 'array' } })), /describe an object/);
  assert.deepEqual(c.types(), ['invoice.paid', 'invoice.voided', 'user.created']);
});

test('check reports every problem with its path, at any depth', () => {
  const c = cat();
  const p = c.validate('invoice.paid', { invoice: 5, amount: 1.5, currency: 'EUR', payer: { email: 'nope' }, extra: true, paidAt: '2026-02-30T00:00:00Z' });
  assert.deepEqual(p.map((x) => `${x.path} ${x.message}`).sort(), [
    '$.extra is not allowed',
    '$.invoice must be string, not integer',
    '$.amount must be integer, not number',
    '$.payer.email must be a valid email',
    '$.payer.name is required',
    '$.paidAt must be a valid date-time',
  ].sort());
});

test('envelope wraps a valid payload and refuses an invalid or undeclared one', () => {
  const c = cat();
  const e = c.envelope('invoice.voided', { invoice: 'inv-9' }, { id: 'evt_1', now: NOW });
  assert.deepEqual(e, { id: 'evt_1', type: 'invoice.voided', version: 1, created: '2026-03-01T12:00:00.000Z', data: { invoice: 'inv-9' } });
  assert.throws(() => c.envelope('invoice.voided', {}, { id: 'x', now: NOW }), InvalidPayload);
  assert.throws(() => c.envelope('invoice.voided', {}, { id: 'x', now: NOW }), /\$\.invoice is required/);
  assert.throws(() => c.envelope('invoice.refunded', {}, { id: 'x', now: NOW }), /not in the webhook catalog/);
  assert.throws(() => c.envelope('invoice.voided', { invoice: 'a' }, { id: 'x', now: NOW, version: 3 }), /v3 is not in the webhook catalog/);
});

test('the sample envelope is a copy that cannot change the catalogue', () => {
  const c = cat();
  const s = c.sampleEnvelope('invoice.paid', { id: 'evt_s', now: NOW });
  (s.data as { amount: number }).amount = 1;
  assert.equal((c.sampleEnvelope('invoice.paid', { id: 'evt_s', now: NOW }).data as { amount: number }).amount, 4200);
});

test('subscription patterns expand against the catalogue and name what matches nothing', () => {
  const c = cat();
  assert.deepEqual(c.expand(['invoice.*']), { types: ['invoice.paid', 'invoice.voided'], unmatched: [] });
  assert.deepEqual(c.expand(['*']).types, ['invoice.paid', 'invoice.voided', 'user.created']);
  assert.deepEqual(c.expand(['user.created', 'user.deleted', 'invoic.*']), { types: ['user.created'], unmatched: ['user.deleted', 'invoic.*'] });
  assert.deepEqual(c.expand(['invoice']), { types: [], unmatched: ['invoice'] }, 'a bare prefix is not a pattern');
});

test('comparing versions separates breaking changes from additive ones', () => {
  const c = cat();
  c.define(
    paid({
      version: 2,
      schema: {
        type: 'object',
        required: ['invoice', 'amount', 'currency', 'tax'],
        properties: {
          invoice: { type: 'string', format: 'uuid' },
          amount: { type: 'string' },
          currency: { type: 'string', enum: ['USD', 'GBP'] },
          memo: { type: 'string' },
          tax: { type: 'integer' },
        },
      },
      sample: { invoice: '3f2b8c1e-0a52-4f6e-9d1a-6c5a2b7e9f10', amount: '4200', currency: 'GBP', tax: 0 },
    }),
  );
  const d = c.compare('invoice.paid', 1, 2);
  assert.deepEqual(d.breaking.map((x) => `${x.path}: ${x.change}`).sort(), [
    '$.amount: type changed from "integer" to "string"',
    '$.currency: value "EUR" no longer allowed',
    '$.paidAt: field removed',
    '$.payer: field removed',
    '$.tax: new required field',
  ]);
  assert.deepEqual(d.additive.map((x) => `${x.path}: ${x.change}`).sort(), ['$.currency: value "GBP" added', '$.memo: optional field added']);
  assert.deepEqual(c.compare('invoice.paid', 1, 1), { breaking: [], additive: [] });
  assert.deepEqual(c.versions('invoice.paid'), [1, 2]);
  assert.equal(c.get('invoice.paid')!.version, 2, 'the newest is the default');
});

test('a field that becomes required breaks receivers; one that becomes optional does not', () => {
  const c = new Catalog();
  const mk = (version: number, required: string[]): EventDef => ({ type: 'a.b', version, summary: 's', schema: { type: 'object', required, properties: { x: { type: 'string' }, y: { type: 'string' } } }, sample: { x: 'x', y: 'y' } });
  c.define(mk(1, ['x']));
  c.define(mk(2, ['y']));
  const d = c.compare('a.b', 1, 2);
  assert.deepEqual(d.breaking, [{ path: '$.y', change: 'field became required' }]);
  assert.deepEqual(d.additive, [{ path: '$.x', change: 'field became optional' }]);
});

test('fields lists every path for documentation, with nesting and arrays', () => {
  const c = new Catalog();
  c.define({ type: 'order.shipped', version: 1, summary: 'Shipped', schema: { type: 'object', required: ['lines'], properties: { lines: { type: 'array', description: 'what shipped', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' }, qty: { type: 'integer' } } } } } }, sample: { lines: [{ sku: 'A' }] } });
  assert.deepEqual(c.fields('order.shipped'), [
    { path: '$.lines', type: 'array', required: true, description: 'what shipped' },
    { path: '$.lines[]', type: 'object', required: true, description: '' },
    { path: '$.lines[].sku', type: 'string', required: true, description: '' },
    { path: '$.lines[].qty', type: 'integer', required: false, description: '' },
  ]);
});

test('deprecations list the events whose sunset is coming', () => {
  const c = cat();
  c.define(paid({ version: 2, deprecated: { since: '2026-01-01', sunset: '2026-09-01', use: 'invoice.settled' } }));
  assert.deepEqual(c.deprecations(), [{ type: 'invoice.paid', version: 2, since: '2026-01-01', sunset: '2026-09-01', use: 'invoice.settled' }]);
});

test('formats, patterns, lengths and ranges are held to', () => {
  assert.deepEqual(check({ type: 'string', format: 'date' }, '2026-02-29'), [{ path: '$', message: 'must be a valid date' }]);
  assert.deepEqual(check({ type: 'string', format: 'date' }, '2028-02-29'), []);
  assert.deepEqual(check({ type: 'string', format: 'uri' }, 'javascript:alert(1)'), [], 'a URI is a URI; schemes are the receiver\'s business');
  assert.deepEqual(check({ type: 'string', format: 'uri' }, 'not a uri'), [{ path: '$', message: 'must be a valid uri' }]);
  assert.deepEqual(check({ type: 'string', pattern: '^evt_[a-z0-9]+$', minLength: 5, maxLength: 8 }, 'evt_'), [{ path: '$', message: 'must be at least 5 characters' }, { path: '$', message: 'must match ^evt_[a-z0-9]+$' }]);
  assert.deepEqual(check({ type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } }, [1, 2.5, 3]), [{ path: '$', message: 'must have at most 2 items' }, { path: '$[1]', message: 'must be integer, not number' }]);
  assert.deepEqual(check({ type: ['string', 'null'] }, null), []);
  assert.deepEqual(check({ type: 'number' }, NaN), [{ path: '$', message: 'must be a finite number' }]);
  assert.deepEqual(check({ const: 'ok' }, 'no'), [{ path: '$', message: 'must be "ok"' }]);
});

test('hostile payloads: deep nesting is refused and prototype keys are plain data', () => {
  let deep: unknown = 1;
  for (let i = 0; i < 100; i++) deep = { a: deep };
  const s = { type: 'object', additionalProperties: {} } as const;
  const nested = (n: number): Record<string, unknown> => (n === 0 ? { type: 'object' } : { type: 'object', additionalProperties: nested(n - 1) });
  const p = check(nested(60) as never, deep);
  assert.ok(p.some((x) => x.message === 'is nested too deeply'));
  const hostile = JSON.parse('{"__proto__":{"x":1},"constructor":2}');
  assert.deepEqual(check({ type: 'object', properties: { x: { type: 'string' } } }, hostile), []);
  assert.deepEqual(check({ type: 'object', additionalProperties: false }, hostile).map((x) => x.path), ['$.__proto__', '$.constructor']);
  assert.deepEqual(check(s, {}), []);
});

test('redaction replaces sensitive fields everywhere, including inside arrays', () => {
  const schema = { type: 'object', properties: { people: { type: 'array', items: { type: 'object', properties: { ssn: { type: 'string', 'x-sensitive': true }, name: { type: 'string' } } } }, token: { type: 'string', 'x-sensitive': true } } } as const;
  assert.deepEqual(redact(schema, { people: [{ ssn: '123', name: 'A' }, { ssn: '456', name: 'B' }], token: 't', other: 1 }), { people: [{ ssn: '[redacted]', name: 'A' }, { ssn: '[redacted]', name: 'B' }], token: '[redacted]', other: 1 });
});

const att = (id: string, endpoint: string, at: number, extra: Partial<Parameters<DeliveryLog['record']>[0]> = {}) => ({ id, endpoint, type: 'invoice.paid', attempt: 1, at, ms: 100, status: 200, body: { invoice: 'x', payer: { email: 'ana@example.org', name: 'Ana' } }, ...extra });

test('the delivery log redacts what the schema marks sensitive, where it is written', () => {
  const log = new DeliveryLog(cat());
  const r = log.record(att('d1', 'ep1', 1000));
  assert.deepEqual(r.body, { invoice: 'x', payer: { email: '[redacted]', name: 'Ana' } });
  assert.ok(!JSON.stringify(log.query()).includes('ana@example.org'));
  assert.equal(log.record(att('d2', 'ep1', 2000, { type: 'mystery.event' })).body, '[unknown event: body not kept]');
});

test('an attempt is a success only when answered 2xx without error', () => {
  const log = new DeliveryLog(cat());
  assert.equal(log.record(att('a', 'e', 1)).ok, true);
  assert.equal(log.record(att('b', 'e', 2, { status: 500 })).ok, false);
  assert.equal(log.record(att('c', 'e', 3, { status: 301 })).ok, false);
  const { status: _s, ...noAnswer } = att('d', 'e', 4);
  assert.equal(log.record({ ...noAnswer, error: 'timed out' }).ok, false);
  assert.equal(log.record(noAnswer).ok, false, 'no answer is not a success');
});

test('explorer: filters, newest first, the story of one delivery, and the summary of an endpoint', () => {
  const log = new DeliveryLog(cat());
  log.record(att('d1', 'e1', 1000, { ms: 50 }));
  log.record(att('d2', 'e1', 2000, { status: 503, ms: 900 }));
  log.record(att('d2', 'e1', 3000, { status: 503, attempt: 2, ms: 800 }));
  log.record(att('d2', 'e1', 4000, { error: 'timed out', status: undefined as never, attempt: 3, ms: 10_000 }));
  log.record(att('d3', 'e2', 5000, { type: 'invoice.voided', body: { invoice: 'i' } }));
  assert.deepEqual(log.query().map((r) => `${r.id}#${r.attempt}`), ['d3#1', 'd2#3', 'd2#2', 'd2#1', 'd1#1']);
  assert.deepEqual(log.query({ endpoint: 'e1', ok: false, limit: 2 }).map((r) => r.at), [4000, 3000]);
  assert.deepEqual(log.query({ since: 2000, until: 4000 }).map((r) => r.at), [4000, 3000, 2000]);
  assert.deepEqual(log.query({ type: 'invoice.voided' }).map((r) => r.id), ['d3']);
  assert.deepEqual(log.history('d2').map((r) => r.attempt), [1, 2, 3]);
  const s = log.summary('e1');
  assert.deepEqual([s.total, s.ok, s.failed, s.consecutiveFailures, s.p50, s.p95, s.successRate], [4, 1, 3, 3, 800, 10_000, 0.25]);
  assert.equal(s.lastFailure!.error, 'timed out');
  assert.deepEqual(log.summary('nobody'), { total: 0, ok: 0, failed: 0, successRate: 1, p50: 0, p95: 0, consecutiveFailures: 0 });
});

test('facets count by type, outcome and reason, and the log is bounded', () => {
  const log = new DeliveryLog(cat(), 3);
  for (let i = 0; i < 5; i++) log.record(att(`d${i}`, 'e', i, i % 2 ? { status: 500 } : {}));
  assert.deepEqual(log.query().map((r) => r.id), ['d4', 'd3', 'd2'], 'only the newest are kept');
  assert.deepEqual(log.facets(), { byType: { 'invoice.paid': 3 }, byOutcome: { delivered: 2, failed: 1 }, byReason: { 'answered 500': 1 } });
});
