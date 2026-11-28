/**
 * Fails when any production dependency's licence is outside the allow list, or when it has none. Prints every
 * production dependency with its licence, where the licence was read from, and the verdict.
 *
 *   node tools/supply/licences.ts [<project dir>...]
 *
 * With no project directories it checks the repository root, intent/ and files/, as sbom.ts does. A dependency is
 * production when npm installs it with --omit=dev. Its licence is the lockfile's, or else the installed
 * package.json's. An SPDX expression passes when it can be satisfied from the allow list: an OR needs one allowed
 * branch, an AND needs every branch, and a WITH exception is judged by its licence.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROJECTS, REPO_ROOT, cmp, readProject, type Project } from './sbom.ts';

/** Permissive licences compatible with shipping under Apache-2.0. */
export const ALLOWED: readonly string[] = ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Python-2.0'];

type Expr = { kind: 'id'; id: string } | { kind: 'and' | 'or'; left: Expr; right: Expr } | { kind: 'with'; licence: Expr; exception: string };

/** Parses an SPDX licence expression. Throws on anything that is not one. */
export function parseSpdx(text: string): Expr {
  const tokens = text.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const atom = (): Expr => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`unexpected end of "${text}"`);
    if (t === '(') {
      const e = or();
      if (tokens[i++] !== ')') throw new Error(`unbalanced parentheses in "${text}"`);
      return e;
    }
    if (/^(AND|OR|WITH|\))$/i.test(t) || !/^[A-Za-z0-9.+:-]+$/.test(t)) throw new Error(`"${t}" is not a licence identifier in "${text}"`);
    return { kind: 'id', id: t };
  };
  const withE = (): Expr => {
    const l = atom();
    if (peek()?.toUpperCase() === 'WITH') {
      i++;
      const ex = tokens[i++];
      if (!ex) throw new Error(`WITH needs an exception in "${text}"`);
      return { kind: 'with', licence: l, exception: ex };
    }
    return l;
  };
  const and = (): Expr => {
    let l = withE();
    while (peek()?.toUpperCase() === 'AND') { i++; l = { kind: 'and', left: l, right: withE() }; }
    return l;
  };
  const or = (): Expr => {
    let l = and();
    while (peek()?.toUpperCase() === 'OR') { i++; l = { kind: 'or', left: l, right: and() }; }
    return l;
  };
  const e = or();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}" in "${text}"`);
  return e;
}

/** Whether an expression can be satisfied using only allowed licences. Identifiers compare case-insensitively. */
export function satisfies(e: Expr, allowed: readonly string[] = ALLOWED): boolean {
  const ok = new Set(allowed.map((a) => a.toLowerCase()));
  const walk = (x: Expr): boolean => {
    switch (x.kind) {
      case 'id': return ok.has(x.id.replace(/\+$/, '').toLowerCase());
      case 'with': return walk(x.licence);
      case 'and': return walk(x.left) && walk(x.right);
      case 'or': return walk(x.left) || walk(x.right);
    }
  };
  return walk(e);
}

export interface Row {
  readonly project: string;
  readonly name: string;
  readonly version: string;
  readonly licence: string;
  readonly source: string;
  readonly ok: boolean;
  readonly reason: string;
}

/** One row per distinct production name@version of a project, plus one for the project itself. */
export function check(project: Project, label: string, allowed: readonly string[] = ALLOWED): Row[] {
  const verdict = (licence: string | undefined): { ok: boolean; reason: string } => {
    if (!licence) return { ok: false, reason: 'no licence' };
    try {
      return satisfies(parseSpdx(licence), allowed) ? { ok: true, reason: 'allowed' } : { ok: false, reason: 'not on the allow list' };
    } catch (err) {
      return { ok: false, reason: `not an SPDX expression (${(err as Error).message})` };
    }
  };
  const rows = new Map<string, Row>();
  for (const p of project.packages) {
    if (!p.production) continue;
    const key = `${p.name}@${p.version}`;
    if (rows.has(key)) continue;
    rows.set(key, { project: label, name: p.name, version: p.version, licence: p.licence ?? '-', source: p.licenceSource, ...verdict(p.licence) });
  }
  const self: Row = { project: label, name: `${project.name} (this project)`, version: project.version, licence: project.licence ?? '-', source: 'package.json', ...verdict(project.licence) };
  return [self, ...[...rows.keys()].sort(cmp).map((k) => rows.get(k) as Row)];
}

/** A plain fixed-width table. */
export function table(rows: readonly Row[]): string {
  const cols: [string, (r: Row) => string][] = [
    ['project', (r) => r.project], ['package', (r) => r.name], ['version', (r) => r.version], ['licence', (r) => r.licence],
    ['from', (r) => r.source], ['verdict', (r) => (r.ok ? 'ok' : `FAIL: ${r.reason}`)],
  ];
  const widths = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => f(r).length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ').trimEnd();
  return [line(cols.map(([h]) => h)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map(([, f]) => f(r))))].join('\n');
}

function main(argv: string[]): number {
  const rows: Row[] = [];
  for (const d of argv.length ? argv : DEFAULT_PROJECTS) {
    const dir = resolve(REPO_ROOT, d);
    if (!existsSync(join(dir, 'package-lock.json')) && !existsSync(join(dir, 'package.json'))) {
      console.log(`${d}: no package.json or package-lock.json, skipped`);
      continue;
    }
    rows.push(...check(readProject(dir), d === '.' ? 'root' : d));
  }
  console.log(table(rows));
  const bad = rows.filter((r) => !r.ok);
  const deps = rows.filter((r) => !r.name.endsWith('(this project)')).length;
  console.log(`\n${deps} production dependencies checked against ${ALLOWED.join(', ')}; ${bad.length} failing.`);
  for (const b of bad) console.error(`FAIL ${b.project}: ${b.name}@${b.version} licence ${b.licence}: ${b.reason}`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
