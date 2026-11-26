/**
 * A workspace keeps one intent's work between sittings: the person's sources, the readings, every answer
 * given, and every revision released, with its change notice and its zip. Nothing in it is ever rewritten
 * in place except the answers, which only grow.
 *
 *   sources/            the person's own files, as given
 *   readings/           readings from model families, one file each
 *   answers.json        every answer so far; a later answer to the same question replaces the earlier one
 *   releases/rev-N/     each issued revision, and rev-N.zip beside it
 *   history.jsonl       one line per revision: its number, package hash, reason and readiness
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { prepare, type Given, type Prepared } from './pipeline.ts';
import { release, type Release } from './release.ts';
import { zip } from './zip.ts';

export interface Workspace {
  readonly dir: string;
}

export function init(dir: string, sources: readonly string[]): Workspace {
  for (const d of ['sources', 'readings', 'releases']) mkdirSync(join(dir, d), { recursive: true });
  for (const s of sources) copyFileSync(s, join(dir, 'sources', basename(s)));
  if (!existsSync(join(dir, 'answers.json'))) writeFileSync(join(dir, 'answers.json'), '{}\n');
  if (!existsSync(join(dir, 'history.jsonl'))) writeFileSync(join(dir, 'history.jsonl'), '');
  return { dir };
}

const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')).sort() : []);

export function addReading(ws: Workspace, file: string): void {
  copyFileSync(file, join(ws.dir, 'readings', basename(file)));
}

export function answer(ws: Workspace, given: Readonly<Record<string, Given>>): Record<string, Given> {
  const path = join(ws.dir, 'answers.json');
  const all = { ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, Given>), ...given };
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  return all;
}

export interface History {
  readonly revision: number;
  readonly package: string;
  readonly reason: string | null;
  readonly ready: boolean;
  readonly openQuestions: number;
}

export const history = (ws: Workspace): History[] =>
  readFileSync(join(ws.dir, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as History);

export function load(ws: Workspace): Prepared {
  const files = list(join(ws.dir, 'sources')).map((f) => ({ path: f, text: readFileSync(join(ws.dir, 'sources', f), 'utf8') }));
  const readings = list(join(ws.dir, 'readings')).map((f) => JSON.parse(readFileSync(join(ws.dir, 'readings', f), 'utf8')) as unknown);
  const answers = JSON.parse(readFileSync(join(ws.dir, 'answers.json'), 'utf8')) as Record<string, Given>;
  const last = history(ws).at(-1);
  const prior = last ? (JSON.parse(readFileSync(join(ws.dir, 'releases', `rev-${last.revision}`, 'balloons.json'), 'utf8')) as Record<string, number>) : undefined;
  return prepare({ files, readings, answers, ...(prior ? { prior } : {}) });
}

/** Issue the next revision. After the first, a reason is required; the release is refused without one. */
export function issue(ws: Workspace, reason?: string): { release: Release; revision: number; path: string; zipPath: string } {
  const p = load(ws);
  const last = history(ws).at(-1);
  const revision = (last?.revision ?? 0) + 1;
  const priorDatum = last ? JSON.parse(readFileSync(join(ws.dir, 'releases', `rev-${last.revision}`, 'datum.json'), 'utf8')) : undefined;
  const r = release(p, { revision, ...(priorDatum ? { prior: { revision: last!.revision, datum: priorDatum } } : {}), ...(reason ? { reason } : {}) });
  const refused = r.problems.filter((x) => /must say why|must come after/.test(x));
  if (refused.length) throw new Error(refused.join('; '));
  const path = join(ws.dir, 'releases', `rev-${revision}`);
  for (const [f, body] of Object.entries(r.files)) {
    mkdirSync(dirname(join(path, f)), { recursive: true });
    writeFileSync(join(path, f), body);
  }
  const zipPath = `${path}.zip`;
  writeFileSync(zipPath, zip(r.files, `${p.model.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-rev-${revision}`));
  const m = JSON.parse(r.files['manifest.json']!) as { package: string; ready: boolean; openQuestions: number };
  appendFileSync(join(ws.dir, 'history.jsonl'), `${JSON.stringify({ revision, package: m.package, reason: reason ?? null, ready: m.ready, openQuestions: m.openQuestions } satisfies History)}\n`);
  return { release: r, revision, path, zipPath };
}
