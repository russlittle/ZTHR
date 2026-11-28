/**
 * The pure parts of the first-article inspection: the recording's self-checks, change detection that ignores
 * when a recording was made, and the readable reports (oracle differences, litmus scores, sync journeys, the
 * benchmark) that the workflow puts in its job summary.
 */
import { differences, type Answer, type Corpus, type Difference } from '../../intent/blocks/oracle/index.ts';

export interface Check {
  readonly check: string;
  readonly pass: boolean;
  readonly detail: string;
}

/** A recording as written to oracle/nextcloud.json: the corpus plus what it was recorded with. */
export interface Recording extends Corpus {
  readonly image?: string;
  readonly version?: string;
  readonly rules?: unknown;
  readonly textMasks?: readonly string[];
}

const count = (v: unknown, key: string): number => {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + count(x, key), 0);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).reduce((n, [k, x]) => n + (k === key ? 1 : 0) + count(x, key), 0);
  return 0;
};

const unparsed = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(unparsed);
  if (v && typeof v === 'object') return 'unparsed' in (v as object) || Object.values(v as object).some(unparsed);
  return false;
};

const RESPONSE = '{DAV:}response';

/**
 * What a recording must show before it can be the reference: the server was installed and answered every step
 * without a server error, the sign-in worked, the account was empty, later steps had what earlier ones captured,
 * every body parsed, and a second recording straight after matched it exactly once masked.
 */
export function selfChecks(first: Corpus, second: Corpus | undefined, installed: boolean): Check[] {
  const at = (name: string): Answer | undefined => first.answers[first.steps.findIndex((s) => s.name === name)];
  const statuses = first.steps.map((s, i) => [s.name, first.answers[i]?.status ?? 0] as const);
  const server = statuses.filter(([, st]) => st >= 500 || st === 0);
  const denied = statuses.filter(([, st]) => st === 401 || st === 403);
  const root = at('the empty root, one level');
  const roots = root ? count(root.body, RESPONSE) : -1;
  const share = at('read the share back');
  const broken = first.steps.filter((_, i) => unparsed(first.answers[i]?.body)).map((s) => s.name);
  const out: Check[] = [
    { check: 'the reference reports installed: true', pass: installed, detail: installed ? 'status.php installed: true' : 'status.php did not say installed: true' },
    { check: 'every step answered, none with a server error', pass: first.answers.length === first.steps.length && server.length === 0, detail: server.length ? server.map(([n, s]) => `${n}: ${s}`).join('; ') : `${first.answers.length} of ${first.steps.length} answered` },
    { check: 'the sign-in was accepted on every step', pass: denied.length === 0, detail: denied.length ? denied.map(([n, s]) => `${n}: ${s}`).join('; ') : 'no 401 or 403' },
    { check: 'the account started empty', pass: root?.status === 207 && roots === 1, detail: root ? `root listing: status ${root.status}, ${roots} entr${roots === 1 ? 'y' : 'ies'} (1 is the root alone)` : 'no root listing step' },
    { check: 'the share made early was found later', pass: share?.status === 200, detail: share ? `read the share back: ${share.status}` : 'no such step' },
    { check: 'every XML and JSON body parsed', pass: broken.length === 0, detail: broken.length ? broken.join('; ') : 'all parsed' },
  ];
  if (second) {
    const d = repeatDifferences(first, second);
    out.push({ check: 'a second recording matches the first (the masks cover all that varies)', pass: d.length === 0, detail: d.length ? `${d.length} varying value${d.length === 1 ? '' : 's'}, which need a mask: ${[...new Set(d.map((x) => `${x.step} ${x.where}`))].slice(0, 20).join('; ')}` : 'identical' });
  }
  return out;
}

export function repeatDifferences(a: Corpus, b: Corpus): Difference[] {
  return a.steps.flatMap((s, i) => (b.answers[i] && a.answers[i] ? differences(s.name, a.answers[i]!, b.answers[i]!) : [{ step: s.name, where: 'answer', reference: a.answers[i] ?? null, candidate: b.answers[i] ?? null }]));
}

/** Two recordings are the same reference when everything but the time they were made matches. */
export function sameRecording(a: Recording, b: Recording): boolean {
  const strip = ({ recorded: _r, ...rest }: Recording) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

const cell = (v: unknown, max = 160): string => {
  let s = v === undefined ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length > max) s = `${s.slice(0, max)}… (${s.length} chars)`;
  return `\`${s.replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\n/g, ' ')}\``;
};

/** The oracle's differences as markdown: one table per step, the reference beside the candidate. */
export function renderDifferences(diffs: readonly Difference[], steps: number, titles: { reference: string; candidate: string }, maxRows = 300): string {
  const lines = [`### Oracle: ${titles.candidate} against ${titles.reference}`, '', `${steps} steps, **${diffs.length} unmasked difference${diffs.length === 1 ? '' : 's'}**${diffs.length ? '' : ': every answer matches'}.`, ''];
  if (!diffs.length) return lines.join('\n');
  const byStep = new Map<string, Difference[]>();
  for (const d of diffs) byStep.set(d.step, [...(byStep.get(d.step) ?? []), d]);
  lines.push('| Step | Differences |', '| --- | --- |', ...[...byStep].map(([s, ds]) => `| ${s} | ${ds.length} |`), '');
  let rows = 0;
  for (const [s, ds] of byStep) {
    if (rows >= maxRows) break;
    lines.push(`<details><summary>${s}: ${ds.length}</summary>`, '', `| Where | ${titles.reference} | ${titles.candidate} |`, '| --- | --- | --- |');
    for (const d of ds) {
      if (rows++ >= maxRows) break;
      lines.push(`| ${cell(d.where, 120)} | ${cell(d.reference)} | ${cell(d.candidate)} |`);
    }
    lines.push('', '</details>', '');
  }
  if (rows >= maxRows) lines.push(`(first ${maxRows} rows shown; the full list is in the artefact)`);
  return lines.join('\n');
}

export function renderChecks(title: string, checks: readonly Check[]): string {
  return [`### ${title}`, '', '| Check | Result | Detail |', '| --- | --- | --- |', ...checks.map((c) => `| ${c.check} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '\\|')} |`), ''].join('\n');
}

// ---------------------------------------------------------------- litmus

export type LitmusResult = 'pass' | 'fail' | 'skipped' | 'warning';

/** litmus's output as suite/test → result. Lines look like " 3. put_get............... pass". */
export function parseLitmus(text: string): Map<string, LitmusResult> {
  const out = new Map<string, LitmusResult>();
  let suite = '';
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const s = /^-> running `([^']+)'/.exec(raw);
    if (s) {
      suite = s[1]!;
      continue;
    }
    const t = /^\s*\d+\.\s+([A-Za-z0-9_]+)\.*\s+(pass|FAIL|SKIPPED|WARNING)\b/.exec(raw);
    if (t && suite) {
      const r = t[2]!.toLowerCase();
      const key = `${suite}/${t[1]!}`;
      // A test can print WARNING lines then pass; a later verdict on the same test wins only if it is worse.
      const prev = out.get(key);
      const v: LitmusResult = r === 'pass' ? 'pass' : r === 'fail' ? 'fail' : r === 'skipped' ? 'skipped' : 'warning';
      if (!prev || v === 'fail') out.set(key, v);
    }
  }
  return out;
}

export function litmusScore(m: ReadonlyMap<string, LitmusResult>): { passed: number; failed: number; skipped: number; run: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const v of m.values()) {
    if (v === 'pass' || v === 'warning') passed++;
    else if (v === 'fail') failed++;
    else skipped++;
  }
  return { passed, failed, skipped, run: passed + failed };
}

/** Tests that pass (or are only warned about) on the reference and fail, or are missing, on the candidate. */
export function litmusRegressions(reference: ReadonlyMap<string, LitmusResult>, candidate: ReadonlyMap<string, LitmusResult>): string[] {
  const ok = (v: LitmusResult | undefined) => v === 'pass' || v === 'warning';
  return [...reference].filter(([k, v]) => ok(v) && !ok(candidate.get(k)) && candidate.get(k) !== 'skipped').map(([k]) => k);
}

export function renderLitmus(reference: ReadonlyMap<string, LitmusResult>, candidate: ReadonlyMap<string, LitmusResult>): { markdown: string; regressions: string[] } {
  const r = litmusScore(reference);
  const c = litmusScore(candidate);
  const regressions = litmusRegressions(reference, candidate);
  const keys = [...new Set([...reference.keys(), ...candidate.keys()])].filter((k) => reference.get(k) !== candidate.get(k));
  const lines = [
    '### litmus WebDAV compliance',
    '',
    '| Server | Passed | Failed | Skipped |',
    '| --- | --- | --- | --- |',
    `| Nextcloud (control) | ${r.passed}/${r.run} | ${r.failed} | ${r.skipped} |`,
    `| Files | ${c.passed}/${c.run} | ${c.failed} | ${c.skipped} |`,
    '',
    regressions.length ? `**${regressions.length} test${regressions.length === 1 ? '' : 's'} pass on Nextcloud and fail on Files:** ${regressions.join(', ')}` : 'No test passes on Nextcloud and fails on Files.',
    '',
  ];
  if (keys.length) lines.push('| Test | Nextcloud | Files |', '| --- | --- | --- |', ...keys.map((k) => `| ${k} | ${reference.get(k) ?? '(not run)'} | ${candidate.get(k) ?? '(not run)'} |`), '');
  return { markdown: lines.join('\n'), regressions };
}

// ---------------------------------------------------------------- sync journeys

export interface StepResult {
  readonly step: string;
  readonly pass: boolean;
  readonly seconds: number;
  readonly detail: string;
}

export interface JourneyResult {
  readonly server: string;
  readonly client: string;
  readonly files: number;
  readonly steps: readonly StepResult[];
}

/** Whose fault each failure is: a step that fails on Files and passes on Nextcloud is Files'; one that fails on both is reported as failing on the reference too. */
export function syncVerdicts(control: JourneyResult | undefined, files: JourneyResult | undefined): { step: string; verdict: 'pass' | 'files' | 'both' | 'control only' | 'files (no control)' | 'not run'; control?: StepResult; files?: StepResult }[] {
  const names = [...new Set([...(control?.steps ?? []).map((s) => s.step), ...(files?.steps ?? []).map((s) => s.step)])];
  return names.map((step) => {
    const c = control?.steps.find((s) => s.step === step);
    const f = files?.steps.find((s) => s.step === step);
    const verdict = !f ? 'not run' : f.pass ? (c && !c.pass ? 'control only' : 'pass') : !c ? 'files (no control)' : c.pass ? 'files' : 'both';
    return { step, verdict, ...(c ? { control: c } : {}), ...(f ? { files: f } : {}) };
  });
}

export function renderSync(control: JourneyResult | undefined, files: JourneyResult | undefined): { markdown: string; filesFailures: string[] } {
  const v = syncVerdicts(control, files);
  const word: Record<string, string> = { pass: 'pass on both', files: '**Files fails, Nextcloud passes**', both: 'fails on Nextcloud too (not Files\' fault alone)', 'control only': 'Files passes; Nextcloud fails', 'files (no control)': '**Files fails** (no control result)', 'not run': 'not run on Files' };
  const r = (s?: StepResult) => (s ? `${s.pass ? 'pass' : 'FAIL'} ${s.seconds.toFixed(1)} s` : '—');
  const lines = [
    '### Unchanged Nextcloud desktop client (nextcloudcmd)',
    '',
    `Client: ${files?.client ?? control?.client ?? 'unknown'}. Tree: ${files?.files ?? control?.files ?? '?'} small files.`,
    '',
    '| Step | Nextcloud (control) | Files | Verdict |',
    '| --- | --- | --- | --- |',
    ...v.map((x) => `| ${x.step} | ${r(x.control)} | ${r(x.files)} | ${word[x.verdict]} |`),
    '',
  ];
  const details = v.filter((x) => (x.files && !x.files.pass) || (x.control && !x.control.pass));
  if (details.length) lines.push('| Step | Nextcloud detail | Files detail |', '| --- | --- | --- |', ...details.map((x) => `| ${x.step} | ${(x.control?.detail ?? '').replace(/\|/g, '\\|')} | ${(x.files?.detail ?? '').replace(/\|/g, '\\|')} |`), '');
  return { markdown: lines.join('\n'), filesFailures: v.filter((x) => x.verdict === 'files' || x.verdict === 'files (no control)' || x.verdict === 'not run').map((x) => x.step) };
}
