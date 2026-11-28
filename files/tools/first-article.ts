/**
 * The first-article inspection's command line: each subcommand prints markdown for the job summary on stdout and
 * exits non-zero when what it checks fails.
 *
 *   wait    <base> [seconds=600]                       until <base>/status.php says installed: true
 *   record  <base> <user> <pw> --out <file> [--image <ref>]
 *                                                      record the oracle twice against a real Nextcloud, self-check
 *   same    <a.json> <b.json>                          exit 0 when two recordings are the same reference
 *   compare <base> <user> <pw> <recording> [--title T] [--out diffs.json]
 *                                                      the oracle against a recording; every unmasked difference
 *   litmus  <nextcloud.log> <files.log>                both litmus scores; fail on Files-only failures
 *   sync    <control.json> <files.json>                both sync journeys; fail on Files-only failures
 *   limits  <control-load.json> <factor>               benchmark limits from the control, as GITHUB_OUTPUT lines
 *   bench   <control-load.json> <files-load.json>      both benchmark results side by side
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compare, record, type Corpus } from '../../intent/blocks/oracle/index.ts';
import { FIRST_ARTICLE_RULES, TEXT_MASKS, maskedFetch } from '../oracle/masks.ts';
import { renderChecks, renderDifferences, renderLitmus, renderSync, parseLitmus, sameRecording, selfChecks, type JourneyResult, type Recording } from '../oracle/inspect.ts';
import { STEPS } from '../oracle/steps.ts';
import { limitsFrom, type LoadResult } from './bench.ts';

const [mode, ...rest] = process.argv.slice(2);
const pos = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));
const flag = (k: string) => {
  const i = rest.indexOf(`--${k}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const say = (s: string) => process.stdout.write(`${s}\n`);
const readJson = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : undefined);
const trim = (b: string) => b.replace(/\/+$/, '');

async function status(base: string): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await fetch(`${trim(base)}/status.php`, { signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const target = (base: string, user: string, password: string) => ({ base: trim(base), user, password, fetch: maskedFetch(trim(base)) });

async function main(): Promise<number> {
  if (mode === 'wait' && pos.length >= 1) {
    const until = Date.now() + Number(pos[1] ?? 600) * 1000;
    let last: unknown;
    while (Date.now() < until) {
      last = await status(pos[0]!);
      if (last && (last as { installed?: unknown }).installed === true) {
        say(`${pos[0]} is ready: ${JSON.stringify(last)}`);
        return 0;
      }
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    say(`${pos[0]} was not ready in time; last status: ${JSON.stringify(last ?? null)}`);
    return 1;
  }
  if (mode === 'record' && pos.length >= 3 && flag('out')) {
    const [base, user, pw] = pos as [string, string, string];
    const st = await status(base);
    const version = `${typeof st?.['productname'] === 'string' && st['productname'] ? st['productname'] : 'Nextcloud'} ${typeof st?.['versionstring'] === 'string' ? st['versionstring'] : '(version unknown)'}`;
    const image = flag('image');
    const t = target(base, user, pw);
    const first = await record(STEPS, t, FIRST_ARTICLE_RULES, version);
    const second = await record(STEPS, t, FIRST_ARTICLE_RULES, version);
    const checks = selfChecks(first, second, st?.['installed'] === true);
    const rec: Recording = { ...first, ...(image ? { image } : {}), version, rules: FIRST_ARTICLE_RULES, textMasks: TEXT_MASKS.map((m) => m.name) };
    writeFileSync(flag('out')!, `${JSON.stringify(rec, null, 1)}\n`);
    writeFileSync(`${flag('out')!}.second.json`, `${JSON.stringify(second, null, 1)}\n`);
    writeFileSync(`${flag('out')!}.checks.json`, `${JSON.stringify(checks, null, 1)}\n`);
    say(renderChecks(`Reference recording: ${version}${image ? ` (${image})` : ''}`, checks));
    return checks.every((c) => c.pass) ? 0 : 1;
  }
  if (mode === 'same' && pos.length >= 2) {
    const a = readJson<Recording>(pos[0]!);
    const b = readJson<Recording>(pos[1]!);
    if (!a || !b) {
      say(`${!a ? pos[0] : pos[1]} does not exist`);
      return 1;
    }
    const same = sameRecording(a, b);
    say(same ? 'The recording matches the committed reference.' : 'The recording differs from the committed reference.');
    return same ? 0 : 1;
  }
  if (mode === 'compare' && pos.length >= 4) {
    const [base, user, pw, file] = pos as [string, string, string, string];
    const ref = readJson<Recording>(file);
    if (!ref) {
      say(`No reference at ${file}: nothing to compare against.`);
      return 1;
    }
    const rules = (ref.rules as typeof FIRST_ARTICLE_RULES | undefined) ?? FIRST_ARTICLE_RULES;
    const steps = ref.steps.length === STEPS.length && JSON.stringify(ref.steps) === JSON.stringify(STEPS) ? STEPS : ref.steps;
    if (steps !== STEPS) say('> The recording was made with a different script from oracle/steps.ts: comparing with the recording\'s own steps. Record again to bring it up to date.\n');
    const r = await compare(steps, target(base, user, pw), rules, ref as Corpus);
    if (flag('out')) writeFileSync(flag('out')!, `${JSON.stringify(r, null, 1)}\n`);
    say(renderDifferences(r.differences, r.steps, { reference: ref.version ?? ref.reference, candidate: flag('title') ?? 'Files' }));
    return r.differences.length ? 1 : 0;
  }
  if (mode === 'litmus' && pos.length >= 2) {
    const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
    const { markdown, regressions } = renderLitmus(parseLitmus(text(pos[0]!)), parseLitmus(text(pos[1]!)));
    say(markdown);
    return regressions.length ? 1 : 0;
  }
  if (mode === 'sync' && pos.length >= 2) {
    const { markdown, filesFailures } = renderSync(readJson<JourneyResult>(pos[0]!), readJson<JourneyResult>(pos[1]!));
    say(markdown);
    return filesFailures.length ? 1 : 0;
  }
  if (mode === 'limits' && pos.length >= 2) {
    const c = readJson<LoadResult>(pos[0]!);
    if (!c) {
      say('note=no control result; no relative limit');
      return 0;
    }
    const l = limitsFrom(c, Number(pos[1]));
    if (l.maxSeconds !== undefined) say(`max_seconds=${l.maxSeconds}`);
    if (l.maxP95Ms !== undefined) say(`max_p95_ms=${l.maxP95Ms}`);
    say(`note=${l.note}`);
    return 0;
  }
  if (mode === 'bench' && pos.length >= 2) {
    type Line = LoadResult & { pass?: boolean; broken?: string[]; limits?: Record<string, unknown> };
    const c = readJson<Line>(pos[0]!);
    const f = readJson<Line>(pos[1]!);
    const row = (k: keyof LoadResult, unit: string) => `| ${k} | ${c ? `${c[k]}${unit}` : '—'} | ${f ? `${f[k]}${unit}` : '—'} |`;
    say(['### Small-files benchmark, same runner', '', '| Measure | Nextcloud (control) | Files |', '| --- | --- | --- |', row('files', ''), row('completed', ''), row('errors', ''), row('uploadSeconds', ' s'), row('perSecond', '/s'), row('p50ms', ' ms'), row('p95ms', ' ms'), row('p99ms', ' ms'), row('fullListingSeconds', ' s'), row('unchangedRecheckMs', ' ms'), '', `Limits on Files: ${f?.limits ? JSON.stringify(f.limits) : '—'}. Verdict: ${f ? (f.pass ? 'pass' : `**FAIL**: ${(f.broken ?? []).join('; ')}`) : 'no Files result'}.`, ''].join('\n'));
    return 0;
  }
  console.error('usage: see the comment at the top of tools/first-article.ts');
  return 2;
}

process.exit(await main());
