import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driftSql, integritySummarySql, ledgerSql, pipelineFiles, preservationSql, seedSql, stages } from '../src/datapipeline.ts';
import { prepare } from '../src/pipeline.ts';
import { release } from '../src/release.ts';
import { changes, ddl, schemaOf } from '../src/schema.ts';

const base = `# Student bill reminders

## What I want

- Remind students before bills are due
- When a bill is paid then reminders stop
- Staff should see who is struggling

## The information

`;
const WORDS = ['A bill has an amount, a due date, a provider and who it is for.', 'A bill can be open, paid or overdue.', 'A reminder belongs to one bill.', 'A request can be new, in progress or closed.'];
const of = (lines: string[]) => schemaOf(prepare({ files: [{ path: 'i.md', text: base + lines.map((l) => `- ${l}`).join('\n') }] }));
const statements = (sql: string) => sql.split(/;\s*\n/).map((x) => x.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()).filter(Boolean);

async function db() {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  return { run: (sql: string) => c.run(sql), rows: async (sql: string) => (await c.runAndReadAll(sql)).getRows() };
}

test('a revision is rehearsed on a copy: synthetic records pass every rule, the copy matches the signed schema', async () => {
  const s = of(WORDS);
  const d = await db();
  for (const x of statements(ddl(s))) await d.run(x);
  for (const x of statements(seedSql(s))) await d.run(x);
  const broken = (await d.rows(integritySummarySql(s))).filter((r) => Number(r[1]) !== 0);
  assert.deepEqual(broken, [], 'the synthetic records pass every integrity rule');
  assert.deepEqual(await d.rows(driftSql(s)), [], 'no drift');
  assert.equal(Number((await d.rows(`select count(*) from "bill" where id like 'syn-%'`))[0]![0]), 5, 'every synthetic record is marked syn-');
});

test('a migration keeps every record: fingerprints before and after are identical, and the new schema matches', async () => {
  const before = of(WORDS);
  const after = of([...WORDS.filter((w) => !w.includes('provider')), 'A bill has an amount, a due date, a reference number and who it is for.', 'A household has an address.']);
  const d = await db();
  for (const x of statements(ddl(before))) await d.run(x);
  for (const x of statements(seedSql(before))) await d.run(x);
  const fp = preservationSql(before, after);
  const was = await d.rows(fp);
  for (const c of changes(before, after, 2)) for (const x of statements(c.sql)) await d.run(x);
  assert.deepEqual(await d.rows(fp), was, 'nothing kept has changed, the retired column included');
  assert.deepEqual(await d.rows(driftSql(after)), [], 'the migrated copy matches the new signed schema');
});

test('drift is found: a column missing from the live database is named', async () => {
  const s = of(WORDS);
  const d = await db();
  for (const x of statements(ddl(s).replace(/,\n  "provider" varchar/, '').replace(/^comment on column "bill"\."provider".*$/m, ''))) await d.run(x);
  const drift = await d.rows(driftSql(s));
  assert.deepEqual(drift.map((r) => [r[0], r[1], r[2]]), [['bill', 'provider', 'missing']]);
});

test('the ledger records each revision with the hash it was signed as and the one before it', async () => {
  const a = of(WORDS);
  const b = of([...WORDS, 'A household has an address.']);
  const d = await db();
  const sub = (sql: string) => sql.replace(":'applied_by'", "'ci'").replace(":'environment'", "'test'");
  for (const x of statements(sub(ledgerSql(a, 1, null)))) await d.run(x);
  for (const x of statements(sub(ledgerSql(b, 2, a)))) await d.run(x);
  const rows = await d.rows('select revision, schema_hash, prior_hash from zthr_schema_ledger order by 1');
  assert.deepEqual(rows.map((r) => [Number(r[0]), r[1], r[2]]), [[1, a.hash, null], [2, b.hash, a.hash]]);
});

test('breaking changes expand now and contract later; every stage has its checks and a gate', () => {
  const before = of(WORDS);
  const after = of(WORDS.filter((w) => !w.includes('provider')).concat('A bill has an amount, a due date and who it is for.'));
  const st = stages(changes(before, after, 2));
  assert.deepEqual(st.map((x) => x.id), ['plan', 'check', 'rehearse', 'promote-development', 'promote-test', 'promote-uat', 'promote-production', 'watch']);
  assert.ok(st.every((x) => x.checks.length && x.gate));
  assert.match(st.find((x) => x.id === 'promote-production')!.gate, /named person approves/);
  const files = pipelineFiles(after, before, 2);
  assert.match(files['information/pipeline.yaml']!, /phase: expand/);
  assert.ok(files['information/rollback/revision-2.sql']);
  assert.doesNotMatch(files['information/ci/data-pipeline.yml']!, /\|\| true/, 'no step hides a failure');
});

test('every release carries the data pipeline', () => {
  const f = release(prepare({ files: [{ path: 'i.md', text: base + WORDS.map((l) => `- ${l}`).join('\n') }] }), { revision: 1 }).files;
  for (const k of ['information/pipeline.yaml', 'information/drift.sql', 'information/integrity-summary.sql', 'information/ledger.sql', 'information/fixtures/seed.sql', 'information/preservation.sql', 'information/ci/data-pipeline.yml']) assert.ok(f[k], k);
});
