import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTable, checkRow, findDuplicates, conversion, convertValue, previewConversion, createTable, dropTable, diff, toMigration, needsApproval, fieldTypes, SchemaError } from './index.ts';
import type { Table, Field } from './index.ts';
import { plan } from '../migrations/index.ts';

const f = (o: Partial<Field> & Pick<Field, 'id' | 'name' | 'type'>): Field => o;
const contacts: Table = {
  name: 'contacts',
  fields: [
    f({ id: 'a', name: 'full_name', type: 'text', required: true, maxLength: 80 }),
    f({ id: 'b', name: 'email', type: 'email', unique: true }),
    f({ id: 'c', name: 'age', type: 'integer', min: 0, max: 150 }),
    f({ id: 'd', name: 'stage', type: 'select', options: ['lead', 'won', "it's lost"], default: 'lead' }),
    f({ id: 'e', name: 'tags', type: 'multiselect', options: ['x', 'y'] }),
  ],
};

test('registry covers the documented types', () => {
  assert.deepEqual(fieldTypes().sort(), ['boolean', 'date', 'datetime', 'decimal', 'email', 'integer', 'json', 'longtext', 'multiselect', 'select', 'text', 'url', 'uuid']);
});

test('a sound table has no problems', () => assert.deepEqual(checkTable(contacts), []));

test('bad names, reserved words, duplicates and misplaced options are reported', () => {
  const bad: Table = { name: 'Users;', fields: [f({ id: 'a', name: 'select', type: 'text' }), f({ id: 'a', name: 'x', type: 'text', options: ['a'] }), f({ id: 'c', name: 'x', type: 'weird' as never }), f({ id: 'd', name: 'p', type: 'select' }), f({ id: 'e', name: 'j', type: 'json', unique: true })] };
  const p = checkTable(bad).join('\n');
  for (const s of ['table name', 'not allowed', 'two fields have id a', 'two fields have this name', 'unknown type', 'options are 1 to 200', 'cannot be unique', 'options does not apply']) assert.match(p, new RegExp(s));
});

test('defaults must fit their field', () => {
  assert.match(checkTable({ name: 't', fields: [f({ id: 'a', name: 'n', type: 'integer', default: 'abc' })] }).join(), /default/);
  assert.match(checkTable({ name: 't', fields: [f({ id: 'a', name: 'n', type: 'select', options: ['a'], default: 'b' })] }).join(), /default/);
  assert.deepEqual(checkTable({ name: 't', fields: [f({ id: 'a', name: 'n', type: 'boolean', default: false })] }), []);
});

test('checkRow validates, applies defaults and refuses unknown fields', () => {
  const r = checkRow(contacts, { full_name: ' Ada ', email: 'ada@example.com', age: '36' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { full_name: 'Ada', email: 'ada@example.com', age: 36, stage: 'lead', tags: null });
  const bad = checkRow(contacts, { age: 200, email: 'nope', stage: 'zzz', evil: 1 });
  assert.ok(!bad.ok);
  if (!bad.ok) {
    const paths = bad.problems.map((p) => p.path).sort();
    assert.deepEqual(paths, ['age', 'email', 'evil', 'full_name', 'stage']);
  }
});

test('checkRow partial updates skip missing fields but still check given ones', () => {
  assert.ok(checkRow(contacts, { age: 5 }, { partial: true }).ok);
  assert.ok(!checkRow(contacts, { age: -5 }, { partial: true }).ok);
});

test('multiselect, date and datetime values are checked', () => {
  const t: Table = { name: 't', fields: [f({ id: 'a', name: 'tags', type: 'multiselect', options: ['x', 'y'] }), f({ id: 'b', name: 'due', type: 'date' }), f({ id: 'c', name: 'at', type: 'datetime' })] };
  assert.ok(checkRow(t, { tags: ['x'], due: '2026-02-28', at: '2026-02-28T10:00:00Z' }).ok);
  assert.ok(!checkRow(t, { tags: ['z'] }).ok);
  assert.ok(!checkRow(t, { due: '2026-02-30' }).ok);
  assert.ok(!checkRow(t, { at: '2026-02-28 10:00' }).ok);
});

test('findDuplicates finds repeated unique values, case-insensitive for email', () => {
  const d = findDuplicates(contacts, [{ email: 'A@x.com' }, { email: 'a@x.com ' }, { email: 'b@x.com' }, { email: null }, { email: null }]);
  assert.deepEqual(d, [{ field: 'email', value: 'a@x.com', rows: [0, 1] }]);
});

test('conversion kinds', () => {
  const t = (type: Field['type'], extra: Partial<Field> = {}) => f({ id: 'a', name: 'v', type, ...extra });
  assert.equal(conversion(t('integer'), t('decimal')).kind, 'lossless');
  assert.equal(conversion(t('decimal'), t('integer')).kind, 'lossy');
  assert.equal(conversion(t('text'), t('integer')).kind, 'lossy');
  assert.equal(conversion(t('boolean'), t('json')).kind, 'impossible');
  assert.equal(conversion(t('text', { maxLength: 100 }), t('text', { maxLength: 20 })).kind, 'lossy');
  assert.equal(conversion(t('text', { maxLength: 20 }), t('text', { maxLength: 100 })).kind, 'lossless');
  assert.equal(conversion(t('text'), t('text')).kind, 'lossless');
});

test('convertValue and previewConversion show what would fail', () => {
  const from = f({ id: 'a', name: 'v', type: 'text' });
  const to = f({ id: 'a', name: 'v', type: 'integer' });
  const p = previewConversion(from, to, ['12', '3.5', 'abc', '', null, ' 7 ']);
  assert.equal(p.total, 6);
  assert.equal(p.converted, 4);
  assert.deepEqual(p.failures.map((x) => x.value), ['3.5', 'abc']);
  assert.equal(convertValue(from, to, '12').ok, true);
  assert.deepEqual(convertValue(f({ id: 'a', name: 'v', type: 'boolean' }), f({ id: 'a', name: 'v', type: 'integer' }), true), { ok: true, value: 1 });
  assert.equal(convertValue(f({ id: 'a', name: 'v', type: 'json' }), f({ id: 'a', name: 'v', type: 'boolean' }), {}).ok, false);
});

test('createTable writes columns, checks and escaped literals per dialect', () => {
  const pg = createTable(contacts, 'pg').sql[0]!;
  assert.match(pg, /^CREATE TABLE "contacts" \("id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\), "full_name" varchar\(80\) NOT NULL/);
  assert.match(pg, /"stage" varchar\(100\) DEFAULT 'lead' CHECK \("stage" IN \('lead', 'won', 'it''s lost'\)\)/);
  assert.match(pg, /"age" bigint CHECK \("age" >= 0 AND "age" <= 150\)/);
  assert.match(createTable(contacts, 'mysql').sql[0]!, /^CREATE TABLE `contacts` \(`id` char\(36\) PRIMARY KEY/);
  assert.match(createTable(contacts, 'sqlite').sql[0]!, /"email" TEXT UNIQUE/);
});

test('createTable refuses an unsound table, and backslash or control characters in literals', () => {
  assert.throws(() => createTable({ name: 'drop', fields: [] }), SchemaError);
  assert.match(checkTable({ name: 't', fields: [f({ id: 'a', name: 's', type: 'select', options: ['a\\b'] })] }).join(), /option/);
});

test('diff: add, drop (destructive), rename keeps data', () => {
  const after: Table = { name: 'contacts', fields: [contacts.fields[0]!, f({ id: 'b', name: 'work_email', type: 'email', unique: true }), contacts.fields[2]!, contacts.fields[3]!, f({ id: 'z', name: 'phone', type: 'text' })] };
  const steps = diff(contacts, after, 'pg');
  assert.deepEqual(steps.map((s) => s.kind), ['drop-column', 'rename-column', 'add-column']);
  assert.equal(steps[0]!.field, 'tags');
  assert.match(steps[1]!.sql[0]!, /RENAME COLUMN "email" TO "work_email"/);
  assert.deepEqual(needsApproval(steps).map((s) => s.kind), ['drop-column']);
});

test('diff: swapping two names goes through a temporary name', () => {
  const a = f({ id: 'a', name: 'first', type: 'text' });
  const b = f({ id: 'b', name: 'second', type: 'text' });
  const steps = diff({ name: 't', fields: [a, b] }, { name: 't', fields: [{ ...a, name: 'second' }, { ...b, name: 'first' }] }, 'pg');
  assert.equal(steps.length, 4);
  assert.match(steps[0]!.sql[0]!, /TO "a_tmp"/);
});

test('diff: type change uses USING in pg, a copy through a new column in sqlite, and refuses impossible ones', () => {
  const before: Table = { name: 't', fields: [f({ id: 'a', name: 'n', type: 'text' })] };
  const after: Table = { name: 't', fields: [f({ id: 'a', name: 'n', type: 'integer' })] };
  const pg = diff(before, after, 'pg');
  assert.match(pg[0]!.sql[0]!, /ALTER COLUMN "n" TYPE bigint USING CAST\("n" AS bigint\)/);
  assert.equal(pg[0]!.destructive, true);
  const sl = diff(before, after, 'sqlite')[0]!;
  assert.equal(sl.sql.length, 4);
  assert.match(sl.sql[1]!, /UPDATE "t" SET "n_new" = CAST\("n" AS INTEGER\)/);
  assert.throws(() => diff({ name: 't', fields: [f({ id: 'a', name: 'n', type: 'json' })] }, { name: 't', fields: [f({ id: 'a', name: 'n', type: 'boolean' })] }), /cannot be converted/);
});

test('diff: required, unique, default and range changes', () => {
  const before: Table = { name: 't', fields: [f({ id: 'a', name: 'n', type: 'integer' })] };
  const after: Table = { name: 't', fields: [f({ id: 'a', name: 'n', type: 'integer', required: true, unique: true, default: 3, min: 1 })] };
  const kinds = diff(before, after, 'pg').map((s) => s.kind);
  assert.deepEqual(kinds, ['set-required', 'set-unique', 'set-default', 'set-checks']);
  const back = diff(after, before, 'pg').map((s) => s.kind);
  assert.deepEqual(back, ['drop-required', 'drop-unique', 'drop-default', 'set-checks']);
});

test('diff refuses renaming the table and identical tables give no steps', () => {
  assert.throws(() => diff(contacts, { ...contacts, name: 'people' }), SchemaError);
  assert.deepEqual(diff(contacts, contacts), []);
  assert.equal(dropTable(contacts).destructive, true);
});

test('toMigration runs every statement in order, renewing the lease, and fits the migrations planner', async () => {
  const steps = [createTable(contacts, 'pg'), ...diff(contacts, { ...contacts, fields: [...contacts.fields, f({ id: 'q', name: 'note', type: 'longtext' })] }, 'pg')];
  const ran: string[] = [];
  let renewed = 0;
  const m = toMigration<{ exec(s: string): Promise<void> }>('2026-11-01-contacts', 'contacts table', steps);
  await m.up({ exec: async (s) => void ran.push(s) }, { renew: async () => void renewed++ });
  assert.equal(ran.length, 2);
  assert.equal(renewed, 2);
  assert.match(ran[1]!, /ADD COLUMN "note" text/);
  assert.deepEqual(plan([m], []).pending, ['2026-11-01-contacts']);
});
