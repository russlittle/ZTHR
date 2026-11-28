import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CustomFields, FieldError, checkPattern } from './index.ts';

function setup() {
  const cf = new CustomFields({ now: () => 1000 });
  cf.define({ key: 'warranty_end', recordKind: 'asset', kind: 'date', label: 'Warranty ends' });
  cf.define({ key: 'serial', recordKind: 'asset', kind: 'text', label: 'Serial number', required: true, unique: true, pattern: '^[A-Z]{2}-\\d{4}$' });
  cf.define({ key: 'cost', recordKind: 'asset', kind: 'number', label: 'Cost', min: 0, max: 1_000_000 });
  cf.define({ key: 'floor', recordKind: 'asset', kind: 'integer', label: 'Floor', min: -2, max: 90 });
  cf.define({ key: 'status', recordKind: 'asset', kind: 'select', label: 'Status', choices: [{ value: 'live', label: 'In service' }, { value: 'spare', label: 'Spare' }, 'broken'], default: 'live' });
  cf.define({ key: 'tags', recordKind: 'asset', kind: 'multiselect', label: 'Tags', choices: ['red', 'blue', 'green'], max: 2 });
  cf.define({ key: 'salary_band', recordKind: 'asset', kind: 'text', label: 'Band', readRoles: ['hr'], writeRoles: ['hr'] });
  cf.define({ key: 'owner_email', recordKind: 'asset', kind: 'email', label: 'Owner email' });
  cf.define({ key: 'manual', recordKind: 'asset', kind: 'url', label: 'Manual' });
  cf.define({ key: 'seen_at', recordKind: 'asset', kind: 'datetime', label: 'Last seen' });
  cf.define({ key: 'insured', recordKind: 'asset', kind: 'boolean', label: 'Insured' });
  return cf;
}
const problems = (r: ReturnType<CustomFields['validate']>) => (r.ok ? [] : r.problems.map((p) => `${p.path}:${p.code}`));

test('valid values come back cleaned and typed, defaults fill in, and the key set is closed', () => {
  const cf = setup();
  const r = cf.validate('asset', { serial: ' AB-1234 ', cost: '199.5', floor: 3, warranty_end: '2027-02-28', tags: ['red', 'blue'], seen_at: '2026-11-26T14:30:00+02:00', insured: 'on', manual: 'https://example.org/m.pdf', owner_email: 'a@example.org' });
  assert.deepEqual(r.ok && { ...r.value }, { serial: 'AB-1234', cost: 199.5, floor: 3, warranty_end: '2027-02-28', tags: ['red', 'blue'], seen_at: '2026-11-26T12:30:00.000Z', insured: true, manual: 'https://example.org/m.pdf', owner_email: 'a@example.org', status: 'live' });
});

test('every problem is reported at once, with the path custom.<key> and the field label in the message', () => {
  const cf = setup();
  const r = cf.validate('asset', { cost: -1, floor: 1.5, warranty_end: '2027-02-30', tags: ['red', 'blue', 'green'], status: 'gone', owner_email: 'nope', manual: 'http://insecure.example', seen_at: 'yesterday', nonsense: 1 });
  assert.deepEqual(problems(r).sort(), [
    'custom.cost:min', 'custom.floor:integer', 'custom.manual:pattern', 'custom.nonsense:unknown', 'custom.owner_email:pattern',
    'custom.seen_at:datetime', 'custom.serial:required', 'custom.status:choice', 'custom.tags:max', 'custom.warranty_end:date',
  ].sort());
  if (!r.ok) assert.equal(r.problems.find((p) => p.path === 'custom.serial')!.message, 'Serial number is needed');
});

test('a text pattern is applied, and unsafe patterns are refused when the field is defined', () => {
  const cf = setup();
  assert.deepEqual(problems(cf.validate('asset', { serial: 'ab-1234' })), ['custom.serial:pattern']);
  for (const bad of ['(a+)+$', '(a*)*b', '(\\w+\\s?)*$', '(a)\\1', 'a'.repeat(201), '([a-z]+)+x', '(']) assert.throws(() => checkPattern(bad), FieldError, bad.slice(0, 20));
  assert.ok(checkPattern('^[A-Z]{2}-\\d{4}$').test('AB-1234'));
  assert.throws(() => cf.define({ key: 'x', recordKind: 'asset', kind: 'number', label: 'X', pattern: '.*' }), /only a text field/);
});

test('partial updates skip missing required fields, but sending null for a required field is a problem; null clears an optional one', () => {
  const cf = setup();
  assert.equal(cf.validate('asset', { cost: 5 }, { partial: true }).ok, true);
  assert.deepEqual(problems(cf.validate('asset', { serial: null }, { partial: true })), ['custom.serial:required']);
  const r = cf.validate('asset', { cost: null }, { partial: true });
  assert.deepEqual(r.ok && { ...r.value }, { cost: null });
  assert.deepEqual(problems(cf.validate('asset', { cost: 5 })), ['custom.serial:required']);
});

test('field definitions are checked: keys, reserved words, duplicates, choices and limits', () => {
  const cf = setup();
  const def = (o: object) => () => cf.define({ key: 'k', recordKind: 'asset', kind: 'text', label: 'K', ...o });
  assert.throws(def({ key: 'Bad Key' }), /lower case/);
  assert.throws(def({ key: 'id' }), /reserved/);
  assert.throws(def({ key: 'serial' }), /already has a field serial/);
  assert.throws(def({ kind: 'select' }), /at least one choice/);
  assert.throws(def({ kind: 'select', choices: ['a', 'a'] }), /different/);
  assert.throws(def({ kind: 'select', choices: ['a b'] }), /letters, digits/);
  assert.throws(def({ choices: ['a'] }), /only select/);
  assert.throws(def({ min: 5, max: 1 }), /min is more than max/);
  assert.throws(def({ kind: 'select', choices: ['a'], default: 'b' }), /default is not valid/);
  assert.throws(def({ kind: 'boolean', unique: true }), /cannot be unique/);
  assert.throws(def({ kind: 'colour' as never }), /kind must be/);
  assert.throws(def({ label: '  ' }), /label/);
  cf.define({ key: 'k', recordKind: 'ticket', kind: 'text', label: 'K' });
  assert.equal(cf.list('ticket').length, 1, 'the same key is fine on another record kind');
});

test('dropping a choice retires it: old records keep it, new writes cannot choose it', () => {
  const cf = setup();
  cf.update('asset', 'status', { choices: [{ value: 'live', label: 'In service' }, { value: 'broken', label: 'broken' }] });
  assert.equal(cf.get('asset', 'status')!.choices!.find((c) => c.value === 'spare')!.retired, true);
  assert.deepEqual(problems(cf.validate('asset', { serial: 'AB-1234', status: 'spare' })), ['custom.status:choice']);
  assert.equal(cf.validate('asset', { serial: 'AB-1234', status: 'spare' }, { existing: { status: 'spare' } }).ok, true, 'unchanged, so allowed');
  assert.throws(() => cf.update('asset', 'status', { choices: [] }), /at least one live choice|choice/);
});

test('tightening reports exactly which records would break, and force applies it anyway', () => {
  const cf = setup();
  const existing = [
    { id: 'a1', values: { cost: 50 } },
    { id: 'a2', values: { cost: 5000 } },
    { id: 'a3', values: {} },
  ];
  assert.deepEqual(cf.preview('asset', 'cost', { max: 100 }, existing), [{ recordId: 'a2', problem: 'cost must be at most 100' }]);
  assert.throws(() => cf.update('asset', 'cost', { max: 100 }, { existing }), /1 record\(s\) would break, for example a2/);
  assert.deepEqual(cf.preview('asset', 'cost', { required: true }, existing).map((x) => x.recordId), ['a3']);
  assert.equal(cf.update('asset', 'cost', { max: 100 }, { existing, force: true }).max, 100);
  assert.equal(cf.update('asset', 'cost', { max: 10_000_000, label: 'Cost (EUR)' }, { existing }).label, 'Cost (EUR)', 'loosening needs no force');
  assert.throws(() => cf.update('asset', 'cost', { kind: 'text' } as never), /never change/);
});

test('archiving hides a field and refuses new values, keeps the key taken, and stored rows still round trip', () => {
  const cf = setup();
  const rows = cf.toRows('asset', 'a1', { cost: 5 });
  cf.archive('asset', 'cost');
  assert.deepEqual(problems(cf.validate('asset', { serial: 'AB-1234', cost: 5 })), ['custom.cost:unknown']);
  assert.equal(cf.list('asset').some((d) => d.key === 'cost'), false);
  assert.equal(cf.list('asset', { includeArchived: true }).some((d) => d.key === 'cost'), true);
  assert.throws(() => cf.define({ key: 'cost', recordKind: 'asset', kind: 'number', label: 'again' }), /never reused/);
  assert.throws(() => cf.update('asset', 'cost', { label: 'x' }), /archived/);
  assert.deepEqual({ ...cf.fromRows('asset', rows) }, { cost: 5 });
});

test('values become typed rows and come back, one row per chosen option, in order', () => {
  const cf = setup();
  const values = { serial: 'AB-1234', cost: 12.5, insured: false, warranty_end: '2027-01-01', tags: ['blue', 'red'], status: 'live' };
  const rows = cf.toRows('asset', 'r7', values);
  const byKey = (k: string) => rows.filter((r) => r.key === k);
  assert.deepEqual(byKey('cost').map((r) => [r.valueNumber, r.valueText]), [[12.5, null]]);
  assert.deepEqual(byKey('insured').map((r) => r.valueBool), [false]);
  assert.deepEqual(byKey('warranty_end').map((r) => r.valueDate), ['2027-01-01']);
  assert.deepEqual(byKey('tags').map((r) => [r.valueText, r.position]), [['blue', 0], ['red', 1]]);
  assert.ok(rows.every((r) => r.recordId === 'r7' && r.recordKind === 'asset'));
  assert.deepEqual({ ...cf.fromRows('asset', [...rows].reverse()) }, values);
});

test('unique fields report clashes case-insensitively and ignore the record itself', () => {
  const cf = setup();
  const others = [{ id: 'a1', values: { serial: 'ab-1234' } }, { id: 'a2', values: { serial: 'CD-0001' } }];
  assert.deepEqual(cf.uniqueClash('asset', { serial: 'AB-1234' }, others), [{ key: 'serial', recordId: 'a1' }]);
  assert.deepEqual(cf.uniqueClash('asset', { serial: 'AB-1234' }, others, 'a1'), []);
  assert.deepEqual(cf.uniqueClash('asset', { cost: 1 }, others), []);
});

test('read and write roles: redaction on read, refusal on write', () => {
  const cf = setup();
  const v = { serial: 'AB-1234', salary_band: 'L5' };
  assert.deepEqual({ ...cf.redact('asset', v, ['staff']) }, { serial: 'AB-1234' });
  assert.deepEqual({ ...cf.redact('asset', v, ['hr']) }, v);
  assert.deepEqual(problems(cf.validate('asset', { serial: 'AB-1234', salary_band: 'L9' }, { roles: ['staff'] })), ['custom.salary_band:forbidden']);
  assert.equal(cf.validate('asset', { serial: 'AB-1234', salary_band: 'L9' }, { roles: ['hr'] }).ok, true);
});

test('index hints follow how each field is used', () => {
  const cf = setup();
  const h = Object.fromEntries(cf.indexHints('asset').map((x) => [`${x.key}:${x.index}`, x.column]));
  assert.equal(h['serial:unique'], 'value_text');
  assert.equal(h['serial:fulltext'], 'value_text');
  assert.equal(h['cost:btree'], 'value_number');
  assert.equal(h['warranty_end:btree'], 'value_date');
  assert.equal(h['insured:partial-true'], 'value_bool');
  assert.equal(h['status:btree'], 'value_text');
  assert.equal('manual:fulltext' in h, false);
});

test('search text uses choice labels and weights; filters work on typed values and refuse unfilterable fields', () => {
  const cf = setup();
  cf.define({ key: 'notes', recordKind: 'asset', kind: 'longtext', label: 'Notes', searchWeight: 0.5 });
  cf.update('asset', 'status', { searchable: true });
  cf.update('asset', 'tags', { searchable: true });
  const sf = cf.searchFields('asset', { serial: 'AB-1234', status: 'spare', tags: ['red', 'green'], notes: 'left wing', cost: 4 });
  assert.deepEqual(sf, [
    { field: 'custom.notes', text: 'left wing', weight: 0.5 },
    { field: 'custom.serial', text: 'AB-1234', weight: 1 },
    { field: 'custom.status', text: 'Spare', weight: 1 },
    { field: 'custom.tags', text: 'red green', weight: 1 },
  ]);
  const f = (key: string, op: never, value?: unknown) => ({ key, op, value }) as Parameters<CustomFields['matches']>[2];
  const v = { cost: 50, tags: ['red'], status: 'live', warranty_end: '2027-05-01', serial: 'AB-1234' };
  assert.equal(cf.matches('asset', v, f('cost', 'gte' as never, 50)), true);
  assert.equal(cf.matches('asset', v, f('cost', 'lt' as never, 50)), false);
  assert.equal(cf.matches('asset', v, f('tags', 'eq' as never, 'red')), true);
  assert.equal(cf.matches('asset', v, f('status', 'in' as never, ['spare', 'live'])), true);
  assert.equal(cf.matches('asset', v, f('serial', 'contains' as never, 'b-12')), true);
  assert.equal(cf.matches('asset', v, f('warranty_end', 'lte' as never, '2027-12-31')), true);
  assert.equal(cf.matches('asset', v, f('floor', 'isEmpty' as never)), true);
  assert.equal(cf.matches('asset', v, f('floor', 'ne' as never, 3)), true);
  assert.throws(() => cf.matches('asset', v, f('notes', 'contains' as never, 'x')), /not filterable/);
  assert.throws(() => cf.matches('asset', v, f('ghost', 'eq' as never, 1)), /no field ghost/);
});

test('report integration: numbers are measures, choices, dates and yes/no are dimensions, text is neither', () => {
  const cf = setup();
  const r = cf.reportFields('asset');
  assert.deepEqual(r.measures.map((m) => m.key).sort(), ['custom.cost', 'custom.floor']);
  assert.deepEqual(r.measures[0]!.aggregates, ['count', 'sum', 'avg', 'min', 'max']);
  assert.deepEqual(r.dimensions.map((d) => d.key).sort(), ['custom.insured', 'custom.status', 'custom.warranty_end']);
  assert.deepEqual(cf.reportFields('nothing'), { dimensions: [], measures: [] });
});

test('prototype-looking keys never become fields or values', () => {
  const cf = setup();
  assert.throws(() => cf.define({ key: '__proto__', recordKind: 'asset', kind: 'text', label: 'x' }), FieldError);
  assert.throws(() => cf.define({ key: 'constructor', recordKind: 'asset', kind: 'text', label: 'x' }), /lower case|reserved/);
  const r = cf.validate('asset', JSON.parse('{"__proto__": {"x": 1}, "serial": "AB-1234"}'));
  assert.ok(!r.ok || !('x' in ({} as object)));
  assert.deepEqual(problems(cf.validate('asset', JSON.parse('{"__proto__": 1, "serial": "AB-1234"}'))), ['custom.__proto__:unknown']);
});
