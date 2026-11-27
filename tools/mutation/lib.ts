/**
 * Shared logic for the mutation loop. Everything that can be pure is pure and unit-tested in lib.test.ts;
 * the functions that touch git, Stryker or the file system are at the bottom and are thin.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const INTENT = join(ROOT, 'intent');
export const RESULTS = join(INTENT, 'eval', 'mutation');
export const QUEUE = join(INTENT, 'factory', 'queue', 'mutation');
export const STRYKER = join(ROOT, 'node_modules', '.bin', 'stryker');

// ---------------------------------------------------------------------------------------------------------------
// Types

export interface Mutant {
  id: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  mutator: string;
  original: string;
  replacement: string;
  /** The full source line the mutant starts on (trimmed); part of the identity used to match across runs. */
  lineText?: string;
  /** The trimmed lines directly before and after; part of the identity. */
  prevText?: string;
  nextText?: string;
}

export interface BlockResult {
  block: string;
  ranAt: string;
  mutants: number;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  score: number;
  survivors: Mutant[];
  /** Occurrence-numbered identity hashes of every detected (Killed or Timeout) mutant; used by the ratchet. */
  killedKeys?: string[];
}

export type Verdict = 'equivalent' | 'not-equivalent' | 'unsure';

export interface Ruling {
  block: string;
  mutant: Mutant;
  key: string;
  argument: string;
  by: string;
  judge: string;
  verdict: Verdict;
  status: 'equivalent' | 'disputed';
  at: string;
  /** Set when a worker looked for a simplification and found none; the ruling then stands without a simplify task. */
  simplify?: { status: 'none-possible'; reason: string; by: string; at: string };
}

export type TaskKind = 'fix-bug' | 'kill-mutant' | 'simplify';
export const KIND_RANK: Record<TaskKind, number> = { 'fix-bug': 0, 'kill-mutant': 1, simplify: 2 };

export interface Task {
  kind: TaskKind;
  block: string;
  mutant: Mutant;
  mayEdit: string[];
  acceptance: string;
  budgetTokens: number;
  tier: 'worker';
  priority: number;
  prompt: string;
  /** Files already modified in the working tree when the task was made (path -> content hash). */
  baseline: Record<string, string>;
  createdAt: string;
  /** fix-bug only: the failing output of the test that found the bug. */
  evidence?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing Stryker's JSON report

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Identity of a mutant that survives line renumbering: what it changes and the text around it. */
export function mutantKey(m: Pick<Mutant, 'mutator' | 'original' | 'replacement' | 'lineText' | 'prevText' | 'nextText'>): string {
  return [m.mutator, norm(m.original), norm(m.replacement), norm(m.lineText ?? ''), norm(m.prevText ?? ''), norm(m.nextText ?? '')].join('␟');
}

const short = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Hashes with an occurrence suffix so that two identical keys stay distinct (key#0, key#1). */
export function occurrenceKeys(ms: Mutant[]): string[] {
  const seen = new Map<string, number>();
  return ms.map((m) => {
    const k = short(mutantKey(m));
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}#${n}`;
  });
}

function sliceSource(lines: string[], line: number, col: number, endLine: number, endCol: number): string {
  if (line === endLine) return (lines[line - 1] ?? '').slice(col - 1, endCol - 1);
  const parts = [(lines[line - 1] ?? '').slice(col - 1)];
  for (let l = line + 1; l < endLine; l++) parts.push(lines[l - 1] ?? '');
  parts.push((lines[endLine - 1] ?? '').slice(0, endCol - 1));
  return parts.join('\n');
}

interface RawMutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

/** Turns a Stryker JSON report (one mutated file) into the per-block result. `source` overrides the report's copy. */
export function parseStryker(report: { files: Record<string, { mutants: RawMutant[]; source?: string }> }, block: string, ranAt: string, source?: string): BlockResult {
  const file = Object.values(report.files)[0];
  if (!file) throw new Error(`report for ${block} has no files`);
  const text = source ?? file.source ?? '';
  const lines = text.split('\n');
  const c = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0 } as Record<string, number>;
  const survivors: Mutant[] = [];
  const detected: Mutant[] = [];
  for (const m of file.mutants) {
    if (!(m.status in c)) continue; // CompileError, RuntimeError, Ignored are not part of the score
    c[m.status]!++;
    const s = m.location.start;
    const e = m.location.end;
    const mu: Mutant = {
      id: m.id,
      line: s.line,
      column: s.column,
      endLine: e.line,
      endColumn: e.column,
      mutator: m.mutatorName,
      original: sliceSource(lines, s.line, s.column, e.line, e.column),
      replacement: m.replacement ?? '',
      lineText: (lines[s.line - 1] ?? '').trim(),
      prevText: (lines[s.line - 2] ?? '').trim(),
      nextText: (lines[s.line] ?? '').trim(),
    };
    if (m.status === 'Survived' || m.status === 'NoCoverage') survivors.push(mu);
    else detected.push(mu);
  }
  survivors.sort((a, b) => a.line - b.line || a.column - b.column || Number(a.id) - Number(b.id));
  const total = c.Killed! + c.Timeout! + c.Survived! + c.NoCoverage!;
  return {
    block,
    ranAt,
    mutants: total,
    killed: c.Killed!,
    timeout: c.Timeout!,
    survived: c.Survived!,
    noCoverage: c.NoCoverage!,
    score: total === 0 ? 100 : Math.round(((c.Killed! + c.Timeout!) / total) * 10000) / 100,
    survivors,
    killedKeys: occurrenceKeys(detected),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Equivalence rulings

const FAMILIES: [RegExp, string][] = [
  [/claude|opus|sonnet|haiku|anthropic/i, 'anthropic'],
  [/gpt|openai|\bo[1-9]\b|codex|chatgpt/i, 'openai'],
  [/gemini|gemma|google|palm/i, 'google'],
  [/llama|meta/i, 'meta'],
  [/mistral|mixtral|codestral/i, 'mistral'],
  [/deepseek/i, 'deepseek'],
  [/qwen|alibaba/i, 'alibaba'],
  [/grok|xai/i, 'xai'],
];

export function modelFamily(model: string): string {
  for (const [re, fam] of FAMILIES) if (re.test(model)) return fam;
  return model.trim().toLowerCase().split(/[\s/:@_-]+/)[0] || 'unknown';
}

/** A ruling counts only for an "equivalent" verdict from a judge of a different model family than the claimant. */
export function rule(verdict: Verdict, by: string, judge: string): 'equivalent' | 'disputed' {
  return verdict === 'equivalent' && modelFamily(by) !== modelFamily(judge) ? 'equivalent' : 'disputed';
}

export function rulingFor(m: Mutant, rulings: Ruling[]): Ruling | undefined {
  const k = mutantKey(m);
  return rulings.find((r) => r.status === 'equivalent' && r.key === k);
}

export const isEquivalent = (m: Mutant, rulings: Ruling[]): boolean => rulingFor(m, rulings) !== undefined;

/** Survivors with no accepted equivalence ruling: the number the loop drives to zero. */
export function remaining(r: BlockResult, rulings: Ruling[]): Mutant[] {
  return r.survivors.filter((m) => !isEquivalent(m, rulings));
}

// ---------------------------------------------------------------------------------------------------------------
// Diff guard

export interface DiffStats {
  added: string[];
  removed: string[];
}

export function diffLines(unified: string): DiffStats {
  const added: string[] = [];
  const removed: string[] = [];
  for (const l of unified.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added.push(l.slice(1));
    else if (l.startsWith('-')) removed.push(l.slice(1));
  }
  return { added, removed };
}

const FORBIDDEN_ADDED = /skip|todo|only:|\.only\b|Stryker disable/i;

/** Conservative test-file guard: nothing that weakens or hides a check. */
export function guardTestDiff(unified: string): string[] {
  const { added, removed } = diffLines(unified);
  const why: string[] = [];
  for (const l of removed) if (/assert/i.test(l)) why.push(`removed a line containing "assert": ${l.trim()}`);
  for (const l of added) if (FORBIDDEN_ADDED.test(l)) why.push(`added a forbidden line (skip/todo/only/Stryker disable): ${l.trim()}`);
  return why;
}

/** Applies to any file the worker may touch: nobody may switch the mutator off. */
export function guardNoDisable(unified: string): string[] {
  return diffLines(unified).added.filter((l) => /Stryker disable/i.test(l)).map((l) => `added a Stryker disable comment: ${l.trim()}`);
}

export function guardScope(changed: string[], mayEdit: string[]): string[] {
  return changed.filter((f) => !mayEdit.includes(f)).map((f) => `changed ${f}, which is outside mayEdit`);
}

/** simplify tasks: the source diff must be a net removal or tightening. */
export function guardNetRemoval(unified: string): string[] {
  const { added, removed } = diffLines(unified);
  return added.length > removed.length ? [`index.ts grew: +${added.length} -${removed.length}; a simplification must not add lines`] : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Ratchet

export interface Regression {
  block: string;
  kind: 'score-dropped' | 'killed-now-survives';
  detail: string;
}

export function compareResults(prev: BlockResult | undefined, cur: BlockResult): Regression[] {
  if (!prev) return [];
  const out: Regression[] = [];
  if (cur.score < prev.score) out.push({ block: cur.block, kind: 'score-dropped', detail: `${prev.score} -> ${cur.score}` });
  if (prev.killedKeys) {
    const was = new Set(prev.killedKeys);
    const curSurvivorKeys = occurrenceKeys(cur.survivors);
    cur.survivors.forEach((m, i) => {
      if (was.has(curSurvivorKeys[i]!)) out.push({ block: cur.block, kind: 'killed-now-survives', detail: `line ${m.line}: ${m.mutator} ${JSON.stringify(m.original)} -> ${JSON.stringify(m.replacement)}` });
    });
  }
  return out;
}

export function floorsProposal(date: string, rows: { block: string; score: number; survivors: number; equivalents: number }[]): string {
  const lines = [
    `# Proposed mutation floors, ${date}`,
    '',
    'Each floor is the block\'s current mutation score. Once signed, a block whose score falls below its floor, or in which a',
    'previously killed mutant survives again, fails the ratchet. A person signs this; nothing here has been applied.',
    '',
    '| Block | Floor (score %) | Survivors left | Of which ruled equivalent |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map((r) => `| ${r.block} | ${r.score} | ${r.survivors} | ${r.equivalents} |`),
    '',
    'Signed: ______________________  Date: ____________',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Prompts

export function excerpt(source: string, line: number, radius = 6): string {
  const ls = source.split('\n');
  const from = Math.max(1, line - radius);
  const to = Math.min(ls.length, line + radius);
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${i === line ? '>' : ' '} ${String(i).padStart(4)}  ${ls[i - 1]}`);
  return out.join('\n');
}

export function describeMutant(m: Mutant): string {
  return `line ${m.line}:${m.column}-${m.endLine}:${m.endColumn}, mutator ${m.mutator}: ${JSON.stringify(m.original)} becomes ${JSON.stringify(m.replacement)}`;
}

export function testStyle(testSource: string): string {
  const ls = testSource.split('\n');
  const head = ls.slice(0, Math.min(ls.length, 30)).join('\n');
  const n = (testSource.match(/^\s*(test|it)\(/gm) ?? []).length;
  return `${n} test() blocks. Imports and the first tests, verbatim:\n${head}`;
}

const RULES = [
  'Edit only the files listed in mayEdit. Do not touch anything else.',
  'Never remove or weaken an assertion, never add skip, todo, only or a Stryker disable comment. Only add lines.',
  'Add the smallest test (or a new assertion inside a new test) that passes on the real code and fails on the mutant. Follow the file\'s style.',
  'Assert behaviour a person could state in a sentence, not the implementation. Use exact values, not ranges, where the code is exact.',
  'If your new test FAILS on the real code, do not bend it to pass: leave it in place and stop. That is a real bug and a fix-bug task follows.',
  'If you think the mutant is equivalent (no input can tell it from the original), do not write a test: stop and say why, with the argument.',
];

export function buildPrompt(kind: TaskKind, t: { block: string; mutant: Mutant; sourceExcerpt: string; testStyle: string; acceptance: string; mayEdit: string[]; evidence?: string }): string {
  const head = `Block "${t.block}". Mutant: ${describeMutant(t.mutant)}.`;
  const code = `Surrounding code in intent/blocks/${t.block}/index.ts (> marks the mutated line):\n${t.sourceExcerpt}`;
  const tail = `Run when done: ${t.acceptance}\nCommit only if it prints "pass": true.`;
  if (kind === 'kill-mutant') {
    return [`TASK kill-mutant. ${head}`, '', 'The tests still pass when the code is changed this way, so nothing checks this behaviour.', '', code, '', `Test file style (${t.mayEdit.find((f) => f.endsWith('.test.ts'))}):`, t.testStyle, '', 'Rules:', ...RULES.map((r) => `- ${r}`), '', tail].join('\n');
  }
  if (kind === 'fix-bug') {
    return [
      `TASK fix-bug. ${head}`,
      '',
      'A new test written to kill this mutant FAILS on the real code. It is in the working tree now. Decide which is wrong: the code or the test.',
      'Read the doc comment on the function and the block\'s intent. If the code violates its stated behaviour, fix index.ts. If the test expects something the block never promised, correct the test. Say which in your final message.',
      '',
      code,
      '',
      'Failing output:',
      t.evidence ?? '(none recorded)',
      '',
      'Rules:',
      '- Edit only the files listed in mayEdit.',
      '- Do not remove or weaken assertions, add skip/todo/only, or add Stryker disable comments.',
      '- After your change every existing test and the new test must pass, and the mutant must be killed.',
      '',
      tail,
    ].join('\n');
  }
  return [
    `TASK simplify. ${head}`,
    '',
    'This mutant was ruled equivalent: no test can tell it from the original. That usually means the code it touches does nothing (a redundant check, a dead branch, an unreachable default, a needless coercion).',
    `Ruling: ${t.evidence ?? '(none recorded)'}`,
    '',
    code,
    '',
    'Remove or tighten that code so the mutant no longer exists. Behaviour must not change; every existing test must still pass; index.ts must not get longer.',
    `If no safe simplification exists, change nothing and run: node tools/mutation/equivalent.ts --stands ${t.block} ${t.mutant.id} --reason "<why>" --by "<your model>"`,
    '',
    tail,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// File system, git, Stryker (thin)

export const sha = (s: string) => createHash('sha1').update(s).digest('hex');
export const rel = (p: string) => relative(ROOT, resolve(p));
export const resultPath = (b: string) => join(RESULTS, `${b}.json`);
export const rulingsPath = (b: string) => join(RESULTS, 'equivalent', `${b}.json`);
export const blockSrc = (b: string) => join(INTENT, 'blocks', b, 'index.ts');
export const blockTest = (b: string) => join(INTENT, 'blocks', b, `${b}.test.ts`);

export function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2) + '\n');
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
}

export const loadResult = (b: string) => readJson<BlockResult>(resultPath(b));
export const loadRulings = (b: string): Ruling[] => readJson<{ rulings: Ruling[] }>(rulingsPath(b))?.rulings ?? [];

export function git(args: string[], cwd = ROOT): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Every path that differs from HEAD (modified, deleted, untracked), minus our own output directories. */
export function dirtyPaths(): string[] {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).out;
  const paths: string[] = [];
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const code = p.slice(0, 2);
    paths.push(p.slice(3));
    if (code[0] === 'R' || code[0] === 'C') i++; // skip the origin path of a rename
  }
  return paths.filter((p) => !p.startsWith('intent/eval/mutation/') && !p.startsWith('intent/factory/queue/mutation/'));
}

export function fileHash(path: string): string {
  const abs = join(ROOT, path);
  return existsSync(abs) ? sha(readFileSync(abs, 'utf8')) : 'deleted';
}

export function snapshotDirty(): Record<string, string> {
  return Object.fromEntries(dirtyPaths().map((p) => [p, fileHash(p)]));
}

/** Files the worker changed since the task was made. */
export function touchedSince(baseline: Record<string, string>): string[] {
  const paths = new Set([...dirtyPaths(), ...Object.keys(baseline)]);
  return [...paths].filter((p) => baseline[p] !== fileHash(p));
}

export function strykerConfig(block: string, o: { out: string; tmp: string; mutate?: string; incrementalFile?: string }): Record<string, unknown> {
  return {
    testRunner: 'command',
    commandRunner: { command: `node --test blocks/${block}/${block}.test.ts` },
    mutate: [o.mutate ?? `blocks/${block}/index.ts`],
    coverageAnalysis: 'off',
    reporters: ['json'],
    jsonReporter: { fileName: o.out },
    tempDirName: o.tmp,
    concurrency: Number(process.env.MUTATION_CONCURRENCY ?? 2),
    timeoutMS: 20000,
    ignorePatterns: ['node_modules', 'docs', 'site', 'studio', 'eval', 'lexicon', 'library'],
    disableTypeChecks: true,
    logLevel: 'error',
    ...(o.incrementalFile ? { incremental: true, incrementalFile: o.incrementalFile } : {}),
  };
}

/** Runs Stryker for one block (or one mutant range) and returns the parsed result. */
export function runStryker(block: string, o: { mutate?: string; incrementalFile?: string } = {}): BlockResult {
  const dir = mkdtempSync(join(tmpdir(), `mutation-${block}-`));
  const out = join(dir, 'report.json');
  const conf = join(dir, 'stryker.conf.json');
  writeJson(conf, strykerConfig(block, { out, tmp: join(dir, 'sandbox'), mutate: o.mutate, incrementalFile: o.incrementalFile }));
  if (o.incrementalFile) mkdirSync(dirname(o.incrementalFile), { recursive: true });
  const r = spawnSync(STRYKER, ['run', conf], { cwd: INTENT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (!existsSync(out)) throw new Error(`stryker produced no report for ${block} (exit ${r.status}): ${(r.stdout + r.stderr).slice(-1500)}`);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  // Stryker's copy of the source is the one the mutants were cut from; prefer the disk copy only if absent.
  return parseStryker(report, block, new Date().toISOString(), undefined);
}

/** Runs the block's whole test file on the real code. */
export function runTests(block: string, file = `blocks/${block}/${block}.test.ts`): { ok: boolean; output: string } {
  const r = spawnSync('node', ['--test', file], { cwd: INTENT, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, output: (r.stdout ?? '') + (r.stderr ?? '') };
}

export function rangeSpec(block: string, m: Mutant): string {
  // the mutate range is 0-based in columns, Stryker's report is 1-based
  return `blocks/${block}/index.ts:${m.line}:${m.column - 1}-${m.endLine}:${m.endColumn - 1}`;
}

export function taskFiles(block?: string): string[] {
  if (!existsSync(QUEUE)) return [];
  const files = readdirSync(QUEUE).filter((f) => f.endsWith('.json') && (!block || f.startsWith(`${block}-`)));
  const tasks = files.map((f) => ({ f, t: JSON.parse(readFileSync(join(QUEUE, f), 'utf8')) as Task }));
  tasks.sort((a, b) => KIND_RANK[a.t.kind] - KIND_RANK[b.t.kind] || a.t.mutant.line - b.t.mutant.line || a.f.localeCompare(b.f));
  return tasks.map((x) => join(QUEUE, x.f));
}
