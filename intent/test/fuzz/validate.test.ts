/** Fuzz: prototype pollution through blocks/validate (record, list, parse, fieldErrors) and mcp validate(). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate as mcpValidate, type Schema as McpSchema } from '../../blocks/mcp/index.ts';
import { boolean, fieldErrors, integer, list, oneOf, parse, record, text, Invalid, type Schema } from '../../blocks/validate/index.ts';
import { Rand, forAll } from './harness.ts';

const DANGER = ['__proto__', 'constructor', 'prototype'];
const KEYS = [...DANGER, ...DANGER, 'polluted', 'name', 'qty', 'items', 'toString', 'hasOwnProperty', 'valueOf'];

/** JSON text whose objects lean on the dangerous keys, parsed so those keys are own properties. */
const json = (r: Rand, depth = 0): string => {
  const k = r.int(0, depth > 3 ? 3 : 6);
  if (k === 0) return r.pick(['null', 'true', '1', '"x"', '"yes"', '""', '-3']);
  if (k === 1) return '{"polluted":"yes"}';
  if (k === 2) return '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}';
  if (k === 3) return `"${r.pick(['Ana', 'a', '  b  ', 'polluted'])}"`;
  if (k === 4) return `[${r.array(0, 3, () => json(r, depth + 1)).join(',')}]`;
  return `{${r.array(0, 5, () => `${JSON.stringify(r.pick(KEYS))}:${json(r, depth + 1)}`).join(',')}}`;
};

/** Record shapes that name the dangerous keys as fields (as an API might), with a generator of inputs that fit. */
interface Shaped {
  readonly schema: Schema<unknown>;
  /** JSON text that the schema accepts (plus, where extras are allowed, dangerous extra keys). */
  readonly sample: (r: Rand) => string;
}
const LEAVES: (() => { schema: Schema<unknown>; sample: (r: Rand) => string })[] = [
  () => ({ schema: text(), sample: (r) => JSON.stringify(r.pick(['Ana', ' b ', 'polluted', '__proto__'])) }),
  () => ({ schema: integer({ min: 0 }), sample: (r) => r.pick(['0', '7', '"12"']) }),
  () => ({ schema: boolean(), sample: (r) => r.pick(['true', 'false', '"on"', '"0"']) }),
  () => ({ schema: oneOf(['yes', 'no'] as const), sample: (r) => r.pick(['"yes"', '"no"']) }),
  () => ({ schema: text().optional(), sample: (r) => r.pick(['null', '""', '"x"']) }),
];
const shape = (r: Rand, depth = 0): Shaped => {
  const fields: Record<string, Schema<unknown>> = {};
  const samplers: [string, (r: Rand) => string][] = [];
  for (const k of new Set(r.array(1, 4, () => r.pick(KEYS)))) {
    let f: { schema: Schema<unknown>; sample: (r: Rand) => string };
    if (depth < 2 && r.bool(0.3)) {
      const inner = shape(r, depth + 1);
      f = r.bool() ? inner : { schema: list(inner.schema) as Schema<unknown>, sample: (q) => `[${q.array(0, 3, () => inner.sample(q)).join(',')}]` };
    } else f = r.pick(LEAVES)();
    Object.defineProperty(fields, k, { value: f.schema, enumerable: true, writable: true, configurable: true });
    samplers.push([k, f.sample]);
  }
  const allowExtra = r.bool(0.3);
  return {
    schema: record(fields, { allowExtra }) as Schema<unknown>,
    sample: (q) => {
      const parts = samplers.map(([k, f]) => `${JSON.stringify(k)}:${f(q)}`);
      if (allowExtra) for (let n = q.int(0, 3); n > 0; n--) parts.push(`${JSON.stringify(q.pick(DANGER))}:${json(q, 2)}`);
      return `{${parts.join(',')}}`;
    },
  };
};

const polluted = () => ({} as Record<string, unknown>).polluted !== undefined || Object.hasOwn(Object.prototype, 'polluted') || ([] as unknown as Record<string, unknown>).polluted !== undefined;

const walk = (v: unknown, f: (o: object) => void) => {
  if (v && typeof v === 'object') {
    f(v);
    for (const x of Object.values(v)) walk(x, f);
  }
};

test('blocks/validate: inputs with __proto__, constructor and prototype keys never pollute Object.prototype, and clean values keep a plain prototype (3000 cases)', async () => {
  await forAll('validate pollution', {
    cases: 3000,
    gen: (r) => {
      const seed = r.int(0, 2 ** 31);
      const sh = shape(new Rand(seed));
      return { seed, text: r.bool(0.6) ? sh.sample(r) : r.bool(0.8) ? `{${r.array(0, 6, () => `${JSON.stringify(r.pick(KEYS))}:${json(r, 1)}`).join(',')}}` : json(r) };
    },
    shrink: () => [],
    check: ({ seed, text: t }) => {
      // The shape is rebuilt from the case's seed, so shape and input replay together.
      const s = shape(new Rand(seed)).schema;
      let value: unknown;
      try {
        value = parse(s, JSON.parse(t));
      } catch (e) {
        assert.ok(e instanceof Invalid, `threw ${e instanceof Error ? e.constructor.name : typeof e}`);
      }
      assert.ok(!polluted(), 'Object.prototype was polluted');
      walk(value, (o) => {
        const p = Object.getPrototypeOf(o);
        assert.ok(p === Object.prototype || p === Array.prototype, 'a cleaned value has a changed prototype');
        assert.ok(!('polluted' in o) || Object.hasOwn(o, 'polluted'), 'polluted is inherited');
      });
    },
  });
});

test('fieldErrors keeps a message for every problem path, including __proto__ and constructor (500 cases)', async () => {
  await forAll('validate fieldErrors paths', {
    cases: 500,
    gen: (r) => `{${r.array(1, 4, () => `${JSON.stringify(r.pick(['__proto__', 'constructor', 'toString', 'valueOf', 'extra']))}:1`).join(',')}}`,
    shrink: () => [],
    check: (t) => {
      const r = record({ name: text().optional() }).check(JSON.parse(t), '');
      assert.equal(r.ok, false);
      if (r.ok) return;
      const errs = fieldErrors(r.problems);
      for (const p of r.problems) assert.ok(Object.hasOwn(errs, p.path) && typeof errs[p.path] === 'string', `no message for ${p.path}`);
    },
  });
});

const mcpSchema = (r: Rand): McpSchema => {
  const properties: Record<string, McpSchema['properties'][string]> = {};
  for (const k of r.array(0, 3, () => r.pick(KEYS))) Object.defineProperty(properties, k, { value: r.pick([{ type: 'string' as const }, { type: 'integer' as const, minimum: 0 }, { type: 'boolean' as const }, { type: 'array' as const, items: { type: 'string' as const } }]), enumerable: true, writable: true, configurable: true });
  return { type: 'object', properties, ...(r.bool() ? { required: r.array(0, 2, () => r.pick(KEYS)) } : {}), ...(r.bool() ? { additionalProperties: false as const } : {}) };
};

test('mcp validate(): dangerous keys in schema and input never pollute, and inherited names are not treated as declared (3000 cases)', async () => {
  await forAll('mcp validate pollution (schemas with dangerous keys)', {
    cases: 3000,
    gen: (r) => ({ schema: mcpSchema(r), text: `{${r.array(0, 6, () => `${JSON.stringify(r.pick(KEYS))}:${json(r, 1)}`).join(',')}}` }),
    shrink: () => [],
    check: ({ schema, text: t }) => {
      const v = JSON.parse(t) as Record<string, unknown>;
      const out = mcpValidate(schema, v);
      assert.ok(!polluted(), 'Object.prototype was polluted');
      assert.ok(out.every((x) => typeof x === 'string'));
      for (const k of schema.required ?? []) if (!Object.hasOwn(v, k)) assert.ok(out.includes(`${k} is required`), `${k} missing but not reported`);
      if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!Object.hasOwn(schema.properties, k)) assert.ok(out.includes(`${k} is not an argument of this tool`), `${k} slipped through`);
    },
  });
});
