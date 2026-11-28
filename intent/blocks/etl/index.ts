/**
 * Declared data pipelines: extract from a source in pages, pass every row through named transforms, and load into
 * a sink keyed by id. Each step stages its output page by page and saves a checkpoint after every page, so a run
 * that fails or is stopped resumes at the step and page where it stopped, and finished steps are not repeated.
 * Loads are idempotent: rows are compared with what the sink already holds by id, unchanged rows are not written,
 * and a repeated page changes nothing. A row a transform cannot handle is recorded with its step, position, id and
 * error while the rest carry on, until more rows fail than the pipeline allows, which stops the run. A dry run
 * does all of this without writing to the sink or touching the real checkpoints, and reports what would be
 * inserted and updated. Every run attempt records its lineage: rows in and out of each step, rows dropped and
 * failed, timings, what was loaded, and a check that every row is accounted for between steps. A schedule runs
 * the pipeline from a cron expression without overlapping itself, and a watch says when the last good run is too
 * old, failed, or loaded a very different number of rows from the one before.
 */
import { cron } from '../jobs/index.ts';

export type Row = Readonly<Record<string, unknown>>;

export interface Source {
  readonly name: string;
  /** The page after `after` (undefined to start), and the cursor for the next page (undefined when there is none). */
  read(after: string | undefined, size: number): Promise<{ rows: readonly Row[]; next?: string | undefined }>;
}

export interface Transform {
  readonly name: string;
  /** One row in; one row, several rows, or none (null or []) out. Throws to reject the row with a reason. */
  readonly run: (row: Row) => Row | readonly Row[] | null;
}

export interface Sink {
  readonly name: string;
  /** The rows the sink already holds for these ids. */
  existing(ids: readonly string[]): Promise<ReadonlyMap<string, Row>>;
  /** Inserts or replaces each row by id. */
  write(rows: readonly { readonly id: string; readonly row: Row }[]): Promise<void>;
}

export interface Pipeline {
  readonly id: string;
  readonly source: Source;
  readonly steps: readonly Transform[];
  readonly sink: Sink;
  /** The id a row is loaded under. */
  readonly key: (row: Row) => string;
  /** Rows per page; defaults to 500. */
  readonly batch?: number;
  /** The run stops once more rows than this have failed; defaults to 100. */
  readonly maxErrors?: number;
}

export interface RowError {
  readonly step: string;
  /** The row's position among the rows that step took in, from 1. */
  readonly at: number;
  readonly id?: string;
  readonly error: string;
  readonly row: Row;
}

export interface StepState {
  readonly name: string;
  readonly kind: 'extract' | 'transform' | 'load';
  status: 'pending' | 'done';
  /** The next page of input to take. */
  page: number;
  /** Extract only: the source cursor for the next page. */
  cursor?: string;
  /** Pages of output staged so far. */
  pages: number;
  rowsIn: number;
  rowsOut: number;
  kept: number;
  dropped: number;
  failed: number;
  ms: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Load only: rows replaced by a later row with the same id in the same page. */
  superseded: number;
}

export interface RunState {
  readonly runId: string;
  readonly pipeline: string;
  readonly startedAt: string;
  attempt: number;
  steps: StepState[];
  errors: RowError[];
}

export type RunStatus = 'done' | 'stopped' | 'failed';

export interface Lineage {
  readonly runId: string;
  readonly pipeline: string;
  readonly attempt: number;
  readonly dryRun: boolean;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly source: string;
  readonly sink: string;
  readonly steps: readonly { readonly name: string; readonly kind: StepState['kind']; readonly rowsIn: number; readonly rowsOut: number; readonly dropped: number; readonly failed: number; readonly ms: number; readonly resumed: boolean }[];
  readonly load: { readonly inserted: number; readonly updated: number; readonly unchanged: number; readonly superseded: number };
  readonly errorCount: number;
  /** The first errors, up to 100. */
  readonly errors: readonly RowError[];
  /** Where rows are not accounted for between or within steps; empty when every row is. */
  readonly unaccounted: readonly string[];
  /** One plain sentence about how the run went and what to do next. */
  readonly message: string;
}

/** Checkpoints, staged pages and lineage. Production keeps them in a database; `memoryStore` is the twin. */
export interface Store {
  state(pipeline: string): Promise<RunState | undefined>;
  save(s: RunState): Promise<void>;
  clear(pipeline: string): Promise<void>;
  putPage(runId: string, step: string, page: number, rows: readonly Row[]): Promise<void>;
  getPage(runId: string, step: string, page: number): Promise<readonly Row[] | undefined>;
  dropPages(runId: string): Promise<void>;
  record(l: Lineage): Promise<void>;
  history(pipeline: string): Promise<readonly Lineage[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

export function memoryStore(): Store & { pages: Map<string, Row[]>; states: Map<string, RunState>; lineage: Lineage[] } {
  const pages = new Map<string, Row[]>();
  const states = new Map<string, RunState>();
  const lineage: Lineage[] = [];
  const k = (run: string, step: string, page: number) => `${run}\u0000${step}\u0000${page}`;
  return {
    pages,
    states,
    lineage,
    async state(p) {
      const s = states.get(p);
      return s && clone(s);
    },
    async save(s) {
      states.set(s.pipeline, clone(s));
    },
    async clear(p) {
      states.delete(p);
    },
    async putPage(run, step, page, rows) {
      pages.set(k(run, step, page), clone([...rows]));
    },
    async getPage(run, step, page) {
      const r = pages.get(k(run, step, page));
      return r && clone(r);
    },
    async dropPages(run) {
      for (const key of [...pages.keys()]) if (key.startsWith(`${run}\u0000`)) pages.delete(key);
    },
    async record(l) {
      lineage.push(clone(l));
    },
    async history(p) {
      return lineage.filter((l) => l.pipeline === p).map(clone);
    },
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

/** A stable comparison of two rows: same fields and values, in any key order. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((x) => (a as Record<string, unknown>)[x] !== undefined);
  const kb = Object.keys(b).filter((x) => (b as Record<string, unknown>)[x] !== undefined);
  return ka.length === kb.length && ka.every((x) => same((a as Record<string, unknown>)[x], (b as Record<string, unknown>)[x]));
}

/** Refuses a pipeline that could not run as declared. */
export function checkPipeline(p: Pipeline): string[] {
  const problems: string[] = [];
  const names = p.steps.map((s) => s.name);
  if (!p.id.trim()) problems.push('The pipeline needs an id.');
  for (const n of names) if (n === 'extract' || n === 'load') problems.push(`A transform cannot be called "${n}"; that name is the pipeline's own step.`);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) problems.push(`Two transforms are called ${[...new Set(dup)].map((d) => `"${d}"`).join(', ')}; each step needs its own name.`);
  if (p.batch !== undefined && (!Number.isInteger(p.batch) || p.batch < 1)) problems.push('The batch size must be a whole number of at least 1.');
  if (p.maxErrors !== undefined && (!Number.isInteger(p.maxErrors) || p.maxErrors < 0)) problems.push('The error limit must be a whole number of 0 or more.');
  return problems;
}

const fresh = (name: string, kind: StepState['kind']): StepState => ({ name, kind, status: 'pending', page: 0, pages: 0, rowsIn: 0, rowsOut: 0, kept: 0, dropped: 0, failed: 0, ms: 0, inserted: 0, updated: 0, unchanged: 0, superseded: 0 });

/** Where the counts do not add up, within each step and from each step to the next. */
function account(steps: readonly StepState[]): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    if (prev && s.rowsIn !== prev.rowsOut) out.push(`${prev.name} put out ${plural(prev.rowsOut, 'row')} but ${s.name} took in ${plural(s.rowsIn, 'row')}.`);
    if (s.kind === 'transform' && s.rowsIn !== s.kept + s.dropped + s.failed) out.push(`${s.name} took in ${plural(s.rowsIn, 'row')} but kept ${s.kept}, dropped ${s.dropped} and failed ${s.failed}.`);
    if (s.kind === 'load' && s.rowsIn !== s.inserted + s.updated + s.unchanged + s.superseded + s.failed) out.push(`load took in ${plural(s.rowsIn, 'row')} but inserted ${s.inserted}, updated ${s.updated}, left ${s.unchanged} unchanged, superseded ${s.superseded} and failed ${s.failed}.`);
  });
  return out;
}

class Stop extends Error {}

/**
 * Runs the pipeline, resuming a run that did not finish. Never throws for a failing source, sink or row: the
 * outcome is in the returned lineage, which is also recorded in the store.
 */
export async function runPipeline(p: Pipeline, store: Store, o: { dryRun?: boolean; now?: () => number } = {}): Promise<Lineage> {
  const problems = checkPipeline(p);
  if (problems.length) throw new Error(problems.join(' '));
  const now = o.now ?? Date.now;
  const dryRun = o.dryRun === true;
  const work = dryRun ? memoryStore() : store;
  const size = p.batch ?? 500;
  const maxErrors = p.maxErrors ?? 100;
  const prior = dryRun ? undefined : await store.state(p.id);
  const layout = [fresh('extract', 'extract'), ...p.steps.map((t) => fresh(t.name, 'transform')), fresh('load', 'load')];
  const sameShape = prior && prior.steps.length === layout.length && prior.steps.every((s, i) => s.name === layout[i]!.name);
  const startedAt = new Date(now()).toISOString();
  const st: RunState = sameShape ? { ...prior, attempt: prior.attempt + 1 } : { runId: `${p.id}@${startedAt}`, pipeline: p.id, startedAt, attempt: 1, steps: layout, errors: [] };
  if (prior && !sameShape) await store.dropPages(prior.runId);
  const resumed = new Set(st.steps.filter((s) => s.status === 'done' || s.page > 0).map((s) => s.name));
  let status: RunStatus = 'done';
  let message = '';
  let pending: RowError[] = [];
  const save = () => work.save(st);
  const timed = async (s: StepState, f: () => Promise<void>) => {
    const t0 = now();
    try {
      await f();
    } finally {
      s.ms += now() - t0;
    }
  };

  const overCap = (extra: RowError[]) => st.errors.length + extra.length > maxErrors;

  try {
    for (let i = 0; i < st.steps.length; i++) {
      const s = st.steps[i]!;
      if (s.status === 'done') continue;
      const prev = st.steps[i - 1];
      await timed(s, async () => {
        if (s.kind === 'extract') {
          for (;;) {
            const r = await p.source.read(s.cursor, size);
            await work.putPage(st.runId, s.name, s.pages, r.rows);
            s.pages++;
            s.page++;
            s.rowsIn += r.rows.length;
            s.rowsOut += r.rows.length;
            s.kept += r.rows.length;
            if (r.next === undefined) {
              delete s.cursor;
              s.status = 'done';
            } else s.cursor = r.next;
            await save();
            if (s.status === 'done') return;
          }
        }
        for (; s.page < prev!.pages; ) {
          const input = await work.getPage(st.runId, prev!.name, s.page);
          if (!input) throw new Error(`the staged page ${s.page + 1} of ${prev!.name} is missing`);
          const errs: RowError[] = [];
          const fail = (row: Row, at: number, e: unknown) => {
            let id: string | undefined;
            try {
              const k = p.key(row);
              if (typeof k === 'string' && k) id = k;
            } catch {
              /* the row has no usable id */
            }
            errs.push({ step: s.name, at, ...(id !== undefined ? { id } : {}), error: msg(e), row });
          };
          if (s.kind === 'transform') {
            const t = p.steps[i - 1]!;
            const out: Row[] = [];
            let kept = 0;
            let dropped = 0;
            input.forEach((row, j) => {
              try {
                const r = t.run(row);
                const rows = r === null ? [] : Array.isArray(r) ? (r as readonly Row[]) : [r as Row];
                if (rows.length) {
                  kept++;
                  out.push(...rows);
                } else dropped++;
              } catch (e) {
                fail(row, s.rowsIn + j + 1, e);
              }
            });
            if (overCap(errs)) {
              pending = errs;
              throw new Stop(s.name);
            }
            await work.putPage(st.runId, s.name, s.pages, out);
            s.pages++;
            s.rowsOut += out.length;
            s.kept += kept;
            s.dropped += dropped;
          } else {
            const byId = new Map<string, Row>();
            let superseded = 0;
            input.forEach((row, j) => {
              try {
                const id = p.key(row);
                if (typeof id !== 'string' || !id) throw new Error('the row has no id to load it under');
                if (byId.has(id)) {
                  superseded++;
                  byId.delete(id);
                }
                byId.set(id, row);
              } catch (e) {
                fail(row, s.rowsIn + j + 1, e);
              }
            });
            if (overCap(errs)) {
              pending = errs;
              throw new Stop(s.name);
            }
            const have = await p.sink.existing([...byId.keys()]);
            const changed: { id: string; row: Row }[] = [];
            let inserted = 0;
            let updated = 0;
            let unchanged = 0;
            for (const [id, row] of byId) {
              const old = have.get(id);
              if (old === undefined) inserted++;
              else if (same(old, row)) {
                unchanged++;
                continue;
              } else updated++;
              changed.push({ id, row });
            }
            if (!dryRun && changed.length) await p.sink.write(changed);
            s.inserted += inserted;
            s.updated += updated;
            s.unchanged += unchanged;
            s.superseded += superseded;
          }
          s.rowsIn += input.length;
          s.failed += errs.length;
          st.errors.push(...errs);
          s.page++;
          await save();
        }
        s.status = 'done';
        await save();
      });
    }
  } catch (e) {
    const at = st.steps.find((x) => x.status !== 'done');
    if (e instanceof Stop) {
      status = 'stopped';
      const n = st.errors.length + pending.length;
      message = `Stopped at ${e.message}: ${plural(n, 'row')} failed, more than the limit of ${maxErrors}. Fix the rows listed and run again; it resumes at page ${(at?.page ?? 0) + 1} of ${e.message}.`;
    } else {
      status = 'failed';
      message = `The run failed at ${at?.name ?? 'the end'}: ${msg(e)}. Run it again to resume at page ${(at?.page ?? 0) + 1} of ${at?.name ?? 'that step'}.`;
    }
    await save();
  }

  const load = st.steps.at(-1)!;
  const unaccounted = status === 'done' ? account(st.steps) : [];
  if (status === 'done') {
    const what = `${plural(load.inserted, 'row')} ${dryRun ? 'would be ' : ''}inserted, ${plural(load.updated, 'row')} ${dryRun ? 'would be ' : ''}updated, ${load.unchanged} unchanged`;
    const errs = st.errors.length ? `; ${plural(st.errors.length, 'row')} failed and ${st.errors.length === 1 ? 'is' : 'are'} listed` : '';
    message = unaccounted.length ? `${dryRun ? 'The dry run' : 'The run'} finished but not every row is accounted for: ${unaccounted.join(' ')} Check the source and the staged pages before trusting this load.` : `${dryRun ? 'Dry run finished, nothing was written' : 'Finished'}: ${what}${errs}.`;
    if (!dryRun) {
      await store.clear(p.id);
      await store.dropPages(st.runId);
    }
  }
  const allErrors = [...st.errors, ...pending];
  const lineage: Lineage = {
    runId: st.runId,
    pipeline: p.id,
    attempt: st.attempt,
    dryRun,
    status,
    startedAt: st.startedAt,
    finishedAt: new Date(now()).toISOString(),
    source: p.source.name,
    sink: p.sink.name,
    steps: st.steps.map((s) => ({ name: s.name, kind: s.kind, rowsIn: s.rowsIn, rowsOut: s.kind === 'load' ? s.inserted + s.updated + s.unchanged : s.rowsOut, dropped: s.dropped, failed: s.failed, ms: s.ms, resumed: resumed.has(s.name) })),
    load: { inserted: load.inserted, updated: load.updated, unchanged: load.unchanged, superseded: load.superseded },
    errorCount: allErrors.length,
    errors: allErrors.slice(0, 100),
    unaccounted,
    message,
  };
  await store.record(lineage);
  return lineage;
}

/** Compares a run's extracted rows with the previous finished run; says so when it moved by more than `tolerance`. */
export function drift(current: Lineage, previous: Lineage | undefined, tolerance = 0.25): string | undefined {
  if (!previous) return undefined;
  const a = previous.steps[0]?.rowsOut ?? 0;
  const b = current.steps[0]?.rowsOut ?? 0;
  if (a === 0) return b === 0 ? undefined : `Extracted ${plural(b, 'row')} where the last run extracted none.`;
  const change = (b - a) / a;
  if (Math.abs(change) <= tolerance) return undefined;
  return `Extracted ${plural(b, 'row')}, ${Math.round(Math.abs(change) * 100)}% ${change < 0 ? 'fewer' : 'more'} than the last run (${a.toLocaleString('en-US')}). Check the source before trusting this load.`;
}

/** Whether the pipeline is healthy: a good run recently, the last attempt not failed, and no large drift. */
export function watch(history: readonly Lineage[], at: Date, o: { maxAgeHours: number; tolerance?: number }): { ok: boolean; say: string } {
  const real = history.filter((l) => !l.dryRun);
  const last = real.at(-1);
  const good = real.filter((l) => l.status === 'done' && l.unaccounted.length === 0);
  const lastGood = good.at(-1);
  if (!last) return { ok: false, say: 'The pipeline has never run.' };
  if (last.status !== 'done') return { ok: false, say: `The last run did not finish. ${last.message}` };
  if (last.unaccounted.length) return { ok: false, say: last.message };
  if (!lastGood) return { ok: false, say: 'The pipeline has never finished a run with every row accounted for.' };
  const age = (at.getTime() - Date.parse(lastGood.finishedAt)) / 3_600_000;
  if (age > o.maxAgeHours) return { ok: false, say: `The last good run finished at ${lastGood.finishedAt}, more than ${o.maxAgeHours} hours ago. Check that the schedule is running.` };
  const d = drift(lastGood, good.at(-2), o.tolerance);
  if (d) return { ok: false, say: d };
  return { ok: true, say: `The last run finished at ${lastGood.finishedAt}: ${lastGood.message.replace(/^Finished: /, '')}` };
}

/** Runs a pipeline on a cron schedule (UTC), never two at once; a run that does not finish resumes on the next tick. */
export class Scheduled {
  next: number;
  running = false;
  private readonly p: Pipeline;
  private readonly store: Store;
  private readonly expr: string;
  private readonly now: (() => number) | undefined;
  constructor(p: Pipeline, store: Store, expr: string, from: Date, o: { now?: () => number } = {}) {
    this.p = p;
    this.store = store;
    this.expr = expr;
    this.now = o.now;
    this.next = cron(expr).next(from).getTime();
  }
  /** Runs the pipeline if it is due and not already running; returns its lineage, or undefined when it did not run. */
  async tick(at: Date): Promise<Lineage | undefined> {
    if (this.running || at.getTime() < this.next) return undefined;
    this.running = true;
    try {
      return await runPipeline(this.p, this.store, this.now ? { now: this.now } : {});
    } finally {
      this.running = false;
      this.next = cron(this.expr).next(at).getTime();
    }
  }
}

/** A source twin: rows served in pages from a list, with a page that can be made to fail once. */
export function listSource(name: string, rows: readonly Row[]): Source & { reads: number; failAtPage: number | undefined } {
  const s = {
    name,
    reads: 0,
    failAtPage: undefined as number | undefined,
    async read(after: string | undefined, size: number) {
      const start = Number(after ?? 0);
      if (s.failAtPage !== undefined && start / size === s.failAtPage) {
        s.failAtPage = undefined;
        throw new Error(`${name} timed out`);
      }
      s.reads++;
      const end = start + size;
      return { rows: rows.slice(start, end), next: end < rows.length ? String(end) : undefined };
    },
  };
  return s;
}

/** A sink twin: a table of rows by id, counting writes, with a write that can be made to fail once. */
export function tableSink(name: string): Sink & { rows: Map<string, Row>; writes: number; failNextWrite: boolean } {
  const s = {
    name,
    rows: new Map<string, Row>(),
    writes: 0,
    failNextWrite: false,
    async existing(ids: readonly string[]) {
      return new Map(ids.filter((i) => s.rows.has(i)).map((i) => [i, clone(s.rows.get(i)!)] as const));
    },
    async write(rows: readonly { id: string; row: Row }[]) {
      if (s.failNextWrite) {
        s.failNextWrite = false;
        throw new Error(`${name} refused the connection`);
      }
      s.writes++;
      for (const r of rows) s.rows.set(r.id, clone(r.row));
    },
  };
  return s;
}
