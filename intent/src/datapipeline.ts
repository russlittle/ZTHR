/**
 * CI/CD for the data: how each revision of the information schema reaches every database, and the proof that nothing
 * was lost on the way.
 *
 * Code is rebuilt; data is carried. So a schema revision is never applied straight to a database. It is planned
 * (each change classified, breaking ones split into expand now and contract later), rehearsed on a copy built from the
 * previous revision and filled with synthetic records, checked (every integrity rule holds, every kept column holds the
 * same values as before, the database matches the signed schema), then promoted environment by environment, each
 * step recorded in a ledger inside the database itself. After release the same checks run every night, so drift
 * between what was signed and what is live is found by the system, not by a person in an incident.
 *
 * Every file here is written from the schema by rule, so the same revision gives the same pipeline.
 */
import { changes, type Change, type Entity, type Field, type Schema } from './schema.ts';

const qi = (k: string) => `"${k}"`;
const lit = (t: string) => `'${t.replace(/'/g, "''")}'`;
const ENVS = ['development', 'test', 'uat', 'production'] as const;

/** The family a column's type belongs to, as both PostgreSQL and the rehearsal database name it. */
const family = (f: Field): string => (f.type === 'money' || f.type === 'integer' ? 'number' : f.type === 'date' ? 'date' : f.type === 'timestamp' ? 'time' : f.type === 'boolean' ? 'bool' : 'text');
const FAMILY_SQL = `case
    when lower(c.data_type) like '%char%' or lower(c.data_type) like '%text%' or lower(c.data_type) = 'uuid' then 'text'
    when lower(c.data_type) like '%timestamp%' then 'time'
    when lower(c.data_type) = 'date' then 'date'
    when lower(c.data_type) like '%bool%' then 'bool'
    when lower(c.data_type) like '%int%' or lower(c.data_type) like '%numeric%' or lower(c.data_type) like '%decimal%' or lower(c.data_type) like '%double%' or lower(c.data_type) like '%real%' then 'number'
    else lower(c.data_type) end`;

/** Every table and column the signed schema expects, against what the database has: missing, extra or the wrong kind. */
export function driftSql(s: Schema): string {
  const expected = s.entities.flatMap((e) => e.fields.map((f) => `(${lit(e.key)}, ${lit(f.key)}, ${lit(family(f))}, ${f.required ? 'false' : 'true'})`));
  const tables = s.entities.map((e) => lit(e.key)).join(', ');
  return `-- Drift: the live database against the signed schema ${s.hash.slice(0, 12)}. An empty result means they match.
-- Retired columns are kept on purpose and are not drift.
with expected(table_name, column_name, family, nullable) as (values
  ${expected.join(',\n  ')}
), live as (
  select c.table_name, c.column_name, ${FAMILY_SQL} as family, c.is_nullable = 'YES' as nullable
  from information_schema.columns c
  where c.table_name in (${tables}) and c.table_schema not in ('information_schema', 'pg_catalog')
)
select e.table_name, e.column_name, 'missing' as drift from expected e left join live l on l.table_name = e.table_name and l.column_name = e.column_name where l.column_name is null
union all
select e.table_name, e.column_name, 'type is ' || l.family || ', signed as ' || e.family from expected e join live l on l.table_name = e.table_name and l.column_name = e.column_name where l.family <> e.family and e.column_name <> 'id'
union all
select e.table_name, e.column_name, 'allows empty, signed as required' from expected e join live l on l.table_name = e.table_name and l.column_name = e.column_name where l.nullable and not e.nullable and e.column_name <> 'id'
order by 1, 2;
`;
}

/** One row per integrity rule with the number of records breaking it: the form a pipeline step can fail on. */
export function integritySummarySql(s: Schema): string {
  return `-- Integrity, summarised: one row per rule and how many records break it. Every count must be 0.\n${s.rules.map((r) => `select ${lit(r.id)} as rule, count(*) as broken from (${r.sql}) t`).join('\nunion all\n')}\norder by 1;\n`;
}

/** What is kept, fingerprinted: row counts and a digest of every kept column, taken before and after a migration. */
export function preservationSql(before: Schema, after: Schema): string {
  void after;
  const rows = before.entities.flatMap((e) => [
    `select ${lit(e.key)} as table_name, '*rows' as column_name, cast(count(*) as varchar) as fingerprint from ${qi(e.key)}`,
    ...e.fields.map((f) => `select ${lit(e.key)}, ${lit(f.key)}, cast(count(${qi(f.key)}) as varchar) || ':' || coalesce(cast(sum(length(cast(${qi(f.key)} as varchar))) as varchar), '0') || ':' || coalesce(min(cast(${qi(f.key)} as varchar)), '') || ':' || coalesce(max(cast(${qi(f.key)} as varchar)), '') from ${qi(e.key)}`),
  ]);
  return `-- Preservation: run before and after a migration; the two results must be identical row for row.\n-- Every table and column of the previous revision is fingerprinted, retired ones included: nothing is dropped.\n${rows.join('\nunion all\n')}\norder by 1, 2;\n`;
}

/** The ledger: every revision applied to this database, with the hash it was signed as and the one before it. */
export function ledgerSql(s: Schema, revision: number, prior: Schema | null): string {
  return `-- The schema ledger, kept inside the database: which signed revision it is at, and how it got there.
create table if not exists "zthr_schema_ledger" (
  "revision" integer primary key,
  "schema_hash" varchar not null,
  "prior_hash" varchar,
  "applied_at" timestamp not null,
  "applied_by" varchar not null,
  "environment" varchar not null
);
insert into "zthr_schema_ledger" values (${revision}, ${lit(s.hash)}, ${prior ? lit(prior.hash) : 'null'}, current_timestamp, :'applied_by', :'environment');
`;
}

/** Synthetic records for rehearsal: deterministic, marked synthetic, and built to pass every integrity rule. */
export function seedSql(s: Schema, n = 5): string {
  const base = Date.UTC(2026, 0, 1);
  const day = 86_400_000;
  const value = (e: Entity, f: Field, i: number): string => {
    if (f.key === 'id') return lit(`syn-${e.key}-${i + 1}`);
    if (f.type.startsWith('ref:')) {
      const to = s.relations.find((r) => r.from === e.key && r.field === f.key)!.to;
      // Two references to the same record point at different rows, so nobody is granted their own records.
      const refsTo = e.fields.filter((x) => x.type.startsWith('ref:') && s.relations.find((r) => r.from === e.key && r.field === x.key)?.to === to);
      return lit(`syn-${to}-${((i + refsTo.indexOf(f)) % n) + 1}`);
    }
    if (f.type === 'state') return f.states?.length ? lit(f.states[0]!) : lit('synthetic');
    if (f.type === 'money') return `${10 + i}.00`;
    if (f.type === 'integer') return String(i + 1);
    if (f.type === 'boolean') return i % 2 ? 'true' : 'false';
    if (f.type === 'date') return `date ${lit(new Date(base + (30 + i) * day).toISOString().slice(0, 10))}`;
    if (f.type === 'timestamp') {
      // What starts, is given or is raised comes first; what is sent, ends or clears comes later; what ends a span stays empty.
      if (!f.required && /(withdrawn|cleared|expires|ended)/.test(f.key)) return 'null';
      const offset = /(given|created|raised|opened|starts|added|written)/.test(f.key) ? 0 : /(ends)/.test(f.key) ? 2 : 1;
      return `timestamp ${lit(new Date(base + (i * 7 + offset) * day).toISOString().slice(0, 19).replace('T', ' '))}`;
    }
    if (f.type === 'email') return lit(`synthetic+${e.key}${i + 1}@example.invalid`);
    if (f.type === 'phone') return lit(`+1-555-01${String(i).padStart(2, '0')}`);
    return lit(`Synthetic ${f.name} ${i + 1}`);
  };
  const inserts = s.entities.map((e) => `insert into ${qi(e.key)} (${e.fields.map((f) => qi(f.key)).join(', ')}) values\n${[...Array(n).keys()].map((i) => `  (${e.fields.map((f) => value(e, f, i)).join(', ')})`).join(',\n')};`);
  return `-- Synthetic records for rehearsal. Every id starts syn-; production refuses them. They pass every integrity rule.\n\n${inserts.join('\n\n')}\n`;
}

/** Undo for what can be undone without losing anything: an added column or table, empty since it was added. */
export function rollbackSql(ch: readonly Change[], revision: number): string {
  const lines = ch.map((c) => (c.kind === 'added' ? `-- Undo: ${c.what}. Leave it in place; the previous code does not read it, so nothing needs removing.` : c.kind === 'changed' ? `-- Undo: ${c.what}. The old column was kept; point the previous code back at it.` : `-- Undo: ${c.what}. It was retired, not dropped; clear the retired mark: ${c.sql.replace(/is '.*'/, 'is null')}`));
  return `-- Rollback for revision ${revision}. Nothing was dropped, so going back never needs a restore.\n\n${lines.join('\n')}\n`;
}

export interface Stage {
  readonly id: string;
  readonly name: string;
  readonly does: string;
  readonly checks: readonly string[];
  readonly gate: string;
}

export function stages(ch: readonly Change[]): Stage[] {
  const breaking = ch.filter((c) => c.breaking);
  return [
    { id: 'plan', name: 'Plan', does: ch.length ? `Classify ${ch.length} change${ch.length === 1 ? '' : 's'}: ${ch.length - breaking.length} added, ${breaking.length} breaking. Breaking ones expand now; contracting them is a later revision a person writes.` : 'First revision: create every table from the signed schema.', checks: ['every change classified', 'breaking changes split into expand now, contract later'], gate: 'the plan matches the signed schema hash' },
    { id: 'check', name: 'Check', does: 'Read the migration before running it.', checks: ['no drop of a table or column', 'no rename in place', 'a newly required field is filled before it is enforced'], gate: 'every check holds' },
    { id: 'rehearse', name: 'Rehearse', does: 'On a throwaway copy: build the previous revision, fill it with synthetic records, fingerprint them, apply the migration, fingerprint again.', checks: ['integrity: every rule breaks for 0 records', 'preservation: every kept column has the same fingerprint before and after', 'drift: the copy matches the signed schema'], gate: 'all three hold on the copy' },
    ...ENVS.map((env) => ({
      id: `promote-${env}`,
      name: `Promote to ${env === 'uat' ? 'UAT' : env}`,
      does: env === 'production' ? 'Take a point-in-time backup, apply, record in the ledger, then check.' : 'Apply, record in the ledger, then check.',
      checks: ['ledger: this revision follows the one recorded before it', 'integrity holds', 'drift: none', ...(env === 'development' || env === 'test' ? ['journeys pass against it'] : env === 'uat' ? ['journeys pass against it', 'people in UAT confirm on their own records'] : [])],
      gate: env === 'production' ? 'a named person approves, after UAT passes' : env === 'uat' ? 'test passes' : env === 'test' ? 'development passes' : 'the rehearsal passes',
    })),
    { id: 'watch', name: 'Watch', does: 'Every night in every environment: integrity and drift, against the revision the ledger says is live.', checks: ['integrity holds', 'drift: none'], gate: 'a failure opens a defect and becomes a ratchet' },
  ];
}

const yaml = (v: unknown, pad = ''): string =>
  v === null ? 'null' : typeof v === 'string' ? (/^[\w .,:/@()+-]+$/.test(v) && !/: |^[-\d]|:$/.test(v) ? v : JSON.stringify(v)) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.map((x) => `\n${pad}- ${yaml(x, `${pad}  `).replace(/^\n\s*/, '')}`).join('') : Object.entries(v as Record<string, unknown>).map(([k, x]) => { const y = yaml(x, `${pad}  `); return `\n${pad}${k}:${y.startsWith('\n') ? '' : ' '}${y}`; }).join('');

/** A workflow any CI can follow; this one is GitHub Actions, with a Postgres service as the rehearsal copy. */
export function workflow(revision: number): string {
  const psql = (file: string) => `psql "$DB" -v ON_ERROR_STOP=1 -q -f ${file}`;
  const mustBeEmpty = (file: string, what: string) => `out=$(psql "$DB" -v ON_ERROR_STOP=1 -tA -f ${file}); if [ -n "$out" ]; then echo "$out"; echo "::error::${what}"; exit 1; fi`;
  return `# Data CI/CD for revision ${revision}: rehearse the migration on a copy, then promote environment by environment.
# Generated from the signed schema. PRIOR is the previous release's information/ folder; THIS is this one's.
name: data revision ${revision}
on:
  workflow_dispatch:
  push:
    paths: ['releases/**/information/**']
env:
  PRIOR: releases/previous/information
  THIS: releases/current/information
jobs:
  rehearse:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: rehearsal }
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 5s --health-retries 10
    env:
      DB: postgresql://postgres:rehearsal@localhost:5432/postgres
    steps:
      - uses: actions/checkout@v4
      - name: Build the previous revision, or start empty on the first
        run: if [ -f "$PRIOR/schema.sql" ]; then ${psql('"$PRIOR/schema.sql"')} && ${psql('"$PRIOR/fixtures/seed.sql"')}; fi
      - name: Fingerprint what is kept
        run: if [ -f "$PRIOR/schema.sql" ]; then psql "$DB" -tA -f "$THIS/preservation.sql" > before.txt; fi
      - name: Apply this revision
        run: if [ -f "$THIS/migrations/revision-${revision}.sql" ]; then ${psql(`"$THIS/migrations/revision-${revision}.sql"`)}; else ${psql('"$THIS/schema.sql"')} && ${psql('"$THIS/fixtures/seed.sql"')}; fi
      - name: Nothing kept has changed
        run: if [ -f before.txt ]; then psql "$DB" -tA -f "$THIS/preservation.sql" > after.txt && diff before.txt after.txt; fi
      - name: Every integrity rule holds
        run: out=$(psql "$DB" -v ON_ERROR_STOP=1 -tA -F ' ' -f "$THIS/integrity-summary.sql" | awk '$2 != 0'); if [ -n "$out" ]; then echo "$out"; echo "::error::integrity rules broken"; exit 1; fi
      - name: The copy matches the signed schema
        run: ${mustBeEmpty('"$THIS/drift.sql"', 'the database drifts from the signed schema')}
${ENVS.map((env, i) => `  ${env}:
    needs: ${i === 0 ? 'rehearse' : ENVS[i - 1]}
    runs-on: ubuntu-latest
    environment: ${env}${env === 'production' ? '   # protected: a named person approves' : ''}
    env:
      DB: \${{ secrets.DATABASE_URL }}
    steps:
      - uses: actions/checkout@v4${env === 'production' ? `
      - name: Point-in-time backup first
        run: echo "Take the backup with the database's own tooling, and record its id in the run."` : ''}
      - name: The ledger is at the revision before this one
        run: at=$(psql "$DB" -tA -c 'select coalesce(max(revision), 0) from zthr_schema_ledger' 2>/dev/null || echo 0); if [ "$at" != "${revision - 1}" ]; then echo "::error::${env} is at revision $at, expected ${revision - 1}"; exit 1; fi
      - name: Apply this revision
        run: if [ -f "$THIS/migrations/revision-${revision}.sql" ]; then ${psql(`"$THIS/migrations/revision-${revision}.sql"`)}; else ${psql('"$THIS/schema.sql"')}; fi
      - name: Record it in the ledger
        run: psql "$DB" -v ON_ERROR_STOP=1 -v applied_by="\${{ github.actor }}" -v environment=${env} -f "$THIS/ledger.sql"
      - name: Every integrity rule holds
        run: out=$(psql "$DB" -v ON_ERROR_STOP=1 -tA -F ' ' -f "$THIS/integrity-summary.sql" | awk '$2 != 0'); if [ -n "$out" ]; then echo "$out"; exit 1; fi
      - name: No drift
        run: ${mustBeEmpty('"$THIS/drift.sql"', `${env} drifts from the signed schema`)}`).join('\n')}
`;
}

export function pipelineFiles(s: Schema, before: Schema | null, revision: number): Record<string, string> {
  const ch = changes(before, s, revision);
  const st = stages(ch);
  const files: Record<string, string> = {
    'information/pipeline.yaml': `# How revision ${revision} of the information reaches every database, and the proof nothing was lost.${yaml({ schema: 'zthr-data-pipeline/1', revision, schemaHash: s.hash, priorHash: before?.hash ?? null, changes: ch.map((c) => ({ kind: c.kind, what: c.what, breaking: c.breaking, phase: c.breaking ? 'expand' : 'apply' })), stages: st.map((x) => ({ id: x.id, name: x.name, does: x.does, checks: x.checks, gate: x.gate })) })}\n`,
    'information/drift.sql': driftSql(s),
    'information/integrity-summary.sql': integritySummarySql(s),
    'information/ledger.sql': ledgerSql(s, revision, before),
    'information/fixtures/seed.sql': seedSql(s),
    'information/preservation.sql': preservationSql(before ?? s, s),
    'information/ci/data-pipeline.yml': workflow(revision),
  };
  if (ch.length) files[`information/rollback/revision-${revision}.sql`] = rollbackSql(ch, revision);
  return files;
}
