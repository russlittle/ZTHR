import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { prepare } from '../src/pipeline.ts';
import { parsePrisma, toPrisma } from '../src/prisma.ts';
import { release } from '../src/release.ts';
import { schemaOf } from '../src/schema.ts';

const intent = `# Student bill reminders

## What I want

- Remind students before bills are due
- When a bill is paid then reminders stop
- Staff should see who is struggling

## The information

- A bill has an amount, a due date, a provider and who it is for.
- A bill can be open, paid or overdue.
- A reminder belongs to one bill.
- A request can be new, in progress or closed.
`;
const theirs = `// The records system already in place
model Student {
  id        Int      @id @default(autoincrement())
  /// Their college email
  email     String   @unique
  fullName  String
  bills     Bill[]
}

model Bill {
  id        Int        @id @default(autoincrement())
  amountDue Decimal
  dueDate   DateTime
  status    BillStatus
  student   Student    @relation(fields: [studentId], references: [id])
  studentId Int
  utility   String?
}

enum BillStatus {
  OPEN
  PAID
  LATE
}
`;
const validate = (text: string) => {
  const w = createRequire(import.meta.url)('@prisma/prisma-schema-wasm') as { validate(p: string): void };
  w.validate(JSON.stringify({ prismaSchema: [['schema.prisma', text]], noColorErrors: true }));
};

test('the schema is written out as a Prisma schema that Prisma itself accepts', () => {
  const s = schemaOf(prepare({ files: [{ path: 'i.md', text: intent }] }));
  const out = toPrisma(s);
  assert.doesNotThrow(() => validate(out));
  assert.match(out, /model Bill \{/);
  assert.match(out, /@@map\("bill"\)/);
  assert.match(out, /enum RequestStatus \{\n  new\n  in_progress @map\("in progress"\)/);
  assert.doesNotMatch(out, /url\s*=/, 'no connection in the schema');
  assert.equal(release(prepare({ files: [{ path: 'i.md', text: intent }] }), { revision: 1 }).files['information/schema.prisma'], out);
});

test('written out and read back, the schema is the same records, fields and types', () => {
  const s = schemaOf(prepare({ files: [{ path: 'i.md', text: intent }] }));
  const back = parsePrisma(toPrisma(s));
  for (const e of s.entities) {
    const b = back.find((x) => x.key === e.key)!;
    assert.ok(b, `${e.name} comes back`);
    for (const f of e.fields) {
      const g = b.fields.find((x) => x.key === f.key)!;
      assert.ok(g, `${e.key}.${f.key} comes back`);
      assert.equal(g.type.startsWith('ref:') ? 'ref' : g.type, f.type.startsWith('ref:') ? 'ref' : f.type, `${e.key}.${f.key}`);
      assert.equal(g.required, f.required, `${e.key}.${f.key} required`);
      if (f.states) assert.deepEqual(g.states, f.states);
    }
  }
});

test('a schema the team already has comes in as provided, and wins over the patterns', () => {
  const p = prepare({ files: [{ path: 'intent.md', text: intent }, { path: 'records.prisma', text: theirs }] });
  const s = schemaOf(p);
  const bill = s.entities.find((e) => e.name === 'Bill')!;
  assert.equal(bill.key, 'bill');
  assert.equal(bill.fields.find((f) => f.key === 'amount_due')!.type, 'money');
  assert.equal(bill.fields.find((f) => f.key === 'due_date')!.type, 'date');
  assert.ok(!bill.fields.some((f) => f.key === 'due_on'), 'their due date replaces the pattern’s');
  assert.deepEqual(bill.fields.find((f) => f.key === 'status')!.states, ['OPEN', 'PAID', 'LATE']);
  assert.ok(bill.fields.find((f) => f.key === 'utility')!.from === 'provided');
  const ref = bill.fields.find((f) => f.key === 'student_id')!;
  assert.ok(ref.type.startsWith('ref:') && ref.from === 'provided');
  assert.ok(!bill.fields.some((f) => f.key === 'owner'), 'their reference to the student replaces the pattern’s owner');
  const student = s.entities.find((e) => e.key === 'student')!;
  assert.equal(student.name, 'Person', 'a student is a person on the schematic, kept in their student table');
  assert.equal(student.fields.find((f) => f.key === 'email')!.meaning, 'Their college email');
  assert.ok(s.relations.some((r) => r.from === 'bill' && r.field === 'student_id' && r.to === 'student'));
  assert.ok(s.unread.some((u) => /OPEN, PAID, LATE/.test(u.why) && /open, paid, overdue/.test(u.why)), 'where your words and the provided schema disagree, it is shown to settle, never decided silently');
  assert.doesNotThrow(() => validate(toPrisma(s)));
});

test('adding a Prisma file does not move the intent’s questions or numbers', () => {
  const a = prepare({ files: [{ path: 'intent.md', text: intent }] });
  const b = prepare({ files: [{ path: 'intent.md', text: intent }, { path: 'records.prisma', text: theirs }] });
  assert.deepEqual(b.questions.map((q) => q.id), a.questions.map((q) => q.id));
  assert.deepEqual(b.statements.map((s) => [s.balloon, s.text]), a.statements.map((s) => [s.balloon, s.text]));
});
