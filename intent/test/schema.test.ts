import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepare } from '../src/pipeline.ts';
import { release } from '../src/release.ts';
import { changes, ddl, integritySql, schemaOf } from '../src/schema.ts';

const base = `# Student bill reminders

## The end in mind

Students stay housed and in school, because a missed bill never becomes a shut-off.

## What I want

- Remind students before bills are due
- When a bill is paid then reminders stop
- Staff should see who is struggling
`;
const info = (lines: string[]) => `${base}\n## The information\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
const WORDS = ['A bill has an amount, a due date, a provider and who it is for.', 'A bill can be open, paid or overdue.', 'A reminder belongs to one bill.', 'A student has a preferred language and a phone.', 'The amount is private to the student and their advisor.', 'Keep bills for 7 years.'];
const of = (text: string) => schemaOf(prepare({ files: [{ path: 'i.md', text }] }));
const ent = (s: ReturnType<typeof of>, name: string) => s.entities.find((e) => e.name === name)!;

test('patterns the intent calls for are named in its own words', () => {
  const s = of(base);
  for (const n of ['Person', 'Bill', 'Payment', 'Reminder', 'Consent', 'Access grant', 'Flag']) assert.ok(ent(s, n), `${n} is kept`);
  assert.deepEqual(ent(s, 'Person').fields.find((f) => f.key === 'role')!.states, ['staff', 'student']);
  assert.equal(ent(s, 'Bill').pattern, 'obligation');
  assert.ok(ent(s, 'Bill').balloons.length > 0, 'traced to the balloons that call for it');
  assert.ok(s.entities.every((e) => e.maintainedBy === 'fleet'));
});

test('the person’s sentences become fields, states, relations, sensitivity and retention, each with its line', () => {
  const s = of(info(WORDS));
  const bill = ent(s, 'Bill');
  assert.ok(bill.fields.some((f) => f.key === 'provider' && f.from === 'your words' && f.line));
  assert.ok(!bill.fields.some((f) => f.key === 'due_date'), '"due date" is the pattern’s "due on", not a second field');
  assert.deepEqual(bill.fields.find((f) => f.key === 'status')!.states, ['open', 'paid', 'overdue']);
  assert.equal(bill.fields.find((f) => f.key === 'amount')!.sensitivity, 'private');
  assert.equal(bill.retention, '7 years');
  assert.ok(s.relations.some((r) => r.from === 'reminder' && r.to === 'bill'));
  assert.ok(ent(s, 'Person').fields.some((f) => f.key === 'phone' && f.type === 'phone'));
  assert.equal(bill.words.length, 4);
  assert.deepEqual(s.unread, []);
});

test('a record nobody’s pattern covers is made from the sentences alone, and maintained by the team', () => {
  const s = of(info(['A household has an address and a number of people.', 'A student belongs to one household.']));
  const h = ent(s, 'Household');
  assert.equal(h.maintainedBy, 'local');
  assert.equal(h.fields.find((f) => f.key === 'number_of_people')!.type, 'integer');
  assert.equal(h.fields.find((f) => f.key === 'address')!.sensitivity, 'contact');
  assert.ok(s.relations.some((r) => r.from === 'person' && r.to === 'household'));
});

test('a sentence that fits no shape is shown back, never guessed at, and the release is not ready', () => {
  const p = prepare({ files: [{ path: 'i.md', text: info(['Students sometimes share a household']) }] });
  assert.equal(schemaOf(p).unread.length, 1);
  assert.ok(release(p, { revision: 1 }).problems.some((x) => x.startsWith('the information, line') && x.includes('fits none of the shapes')));
});

test('the schema is signed: it is in the datum, and the same words give the same bytes', () => {
  const p = prepare({ files: [{ path: 'i.md', text: info(WORDS) }] });
  const a = release(p, { revision: 1 }).files;
  assert.equal(JSON.parse(a['datum.json']!).information.hash, schemaOf(p).hash);
  assert.deepEqual(a, release(p, { revision: 1 }).files);
  for (const f of ['information/schema.json', 'information/schema.md', 'information/schema.sql', 'information/integrity.sql']) assert.ok(a[f], f);
  assert.match(a['information/schema.md']!, /erDiagram/);
});

test('the database builds, and every integrity rule finds the records planted to break it', async () => {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const s = of(info(WORDS));
  const db = await (await DuckDBInstance.create(':memory:')).connect();
  for (const stmt of ddl(s).split(/;\n/).map((x) => x.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim()).filter(Boolean)) await db.run(stmt);
  await db.run(`insert into "person" values ('p1', 'Ana', null, 'student', now(), 'es', null), ('p2', 'Bo', null, 'staff', now(), null, null)`);
  await db.run(`insert into "bill" ("id", "owner", "amount", "due_on", "status", "provider") values ('b1', 'p1', 40, date '2026-12-01', 'open', 'Power co')`);
  await db.run(`insert into "reminder" ("id", "to", "channel", "send_at", "status", "bill") values ('r1', 'p1', 'text', now(), 'scheduled', 'b1')`);
  await db.run(`insert into "access_grant" values ('g1', 'p2', 'p2', 'own', null)`);
  await db.run(`insert into "flag" values ('f1', 'p1', 'missed', 'missed a due date', timestamp '2026-11-02', timestamp '2026-11-01')`);
  const broken = new Set<string>();
  for (const r of s.rules) if ((await db.runAndReadAll(r.sql)).getRows().length) broken.add(r.id);
  assert.ok(broken.has('reminder.to.consented'), 'a reminder to someone who never agreed is found');
  assert.ok(broken.has('access_grant.grantee.not.subject'), 'a grant to oneself is found');
  assert.ok(broken.has('flag.raised_at.before.cleared_at'), 'cleared before raised is found');
  assert.ok(!broken.has('bill.amount.present') && !broken.has('bill.status.allowed'), 'good records pass');
  await db.run(`insert into "consent" values ('c1', 'p1', 'bill reminders', timestamp '2020-01-01', null)`);
  assert.equal((await db.runAndReadAll(s.rules.find((r) => r.id === 'reminder.to.consented')!.sql)).getRows().length, 0, 'with consent it passes');
  assert.match(integritySql(s), /reminder\.to\.consented/);
});

test('a change to the schema is migrated, and nothing is ever dropped', async () => {
  const before = of(info(WORDS));
  const after = of(info([...WORDS.filter((w) => !w.includes('provider')), 'A bill has an amount, a due date, a reference number and who it is for.']));
  const ch = changes(before, after, 2);
  assert.ok(ch.some((c) => c.kind === 'added' && /reference number/.test(c.what) && !c.breaking));
  assert.ok(ch.some((c) => c.kind === 'retired' && /provider/.test(c.what) && c.breaking));
  assert.ok(ch.every((c) => !/\bdrop\b/i.test(c.sql)), 'no migration drops anything');
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await (await DuckDBInstance.create(':memory:')).connect();
  for (const stmt of ddl(before).split(/;\n/).map((x) => x.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim()).filter(Boolean)) await db.run(stmt);
  for (const c of ch) for (const stmt of c.sql.split(/;\n?/).map((x) => x.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim()).filter(Boolean)) await db.run(stmt);
  const cols = (await db.runAndReadAll(`select column_name from information_schema.columns where table_name = 'bill'`)).getRows().map((r) => r[0]);
  assert.ok(cols.includes('reference_number') && cols.includes('provider'), 'the new column is added and the retired one kept');
});
