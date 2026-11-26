#!/usr/bin/env node
/**
 * The command line.
 *   intent readback  <files...> [--reading r.json]... [--answers a.json] [--budget n]   prints the read-back
 *   intent questions <files...> [--reading r.json]... [--answers a.json] [--budget n]   prints the questions page (HTML)
 *   intent release   <files...> --rev n --to dir [--prior dir] [--reason text] [--zip f] issues the release package
 *
 * With a workspace, the work is kept between sittings:
 *   intent init <files...> --workspace dir      start one, from the person's files
 *   intent reading r.json --workspace dir       add a reading from a model family
 *   intent answer a.json --workspace dir        add answers; later answers replace earlier ones
 *   intent status --workspace dir               where it is in the process
 *   intent readback|questions --workspace dir   as above, from the workspace
 *   intent release --workspace dir [--reason t] issue the next revision, with its zip
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { release } from './release.ts';
import { zip } from './zip.ts';
import { addReading, answer as addAnswers, history, init, issue, load } from './workspace.ts';
import { STAGES, stageOf } from './progress.ts';
import { questionsPage } from './form.ts';
import { prepare } from './pipeline.ts';
import { readBack } from './readback.ts';

const [cmd, ...rest] = process.argv.slice(2);
const files: { path: string; text: string }[] = [];
const readings: unknown[] = [];
let answers = {};
let rev = 1;
let to = '';
let priorDir = '';
let reason: string | undefined;
let zipTo = '';
let ws = '';
let budget = 5;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a === '--reading') readings.push(JSON.parse(readFileSync(rest[++i]!, 'utf8')));
  else if (a === '--budget') budget = Number(rest[++i]);
  else if (a === '--answers') answers = JSON.parse(readFileSync(rest[++i]!, 'utf8'));
  else if (a === '--rev') rev = Number(rest[++i]);
  else if (a === '--to') to = rest[++i]!;
  else if (a === '--prior') priorDir = rest[++i]!;
  else if (a === '--reason') reason = rest[++i]!;
  else if (a === '--zip') zipTo = rest[++i]!;
  else if (a === '--workspace') ws = rest[++i]!;
  else files.push({ path: a, text: cmd === 'init' || cmd === 'reading' || cmd === 'answer' ? '' : readFileSync(a, 'utf8') });
}
if (ws) {
  const w = { dir: ws };
  const paths = files.map((f) => f.path);
  if (cmd === 'init') init(ws, paths);
  else if (cmd === 'reading') paths.forEach((f) => addReading(w, f));
  else if (cmd === 'answer') paths.forEach((f) => addAnswers(w, JSON.parse(readFileSync(f, 'utf8'))));
  else if (cmd === 'readback') process.stdout.write(readBack(load(w), budget));
  else if (cmd === 'questions') process.stdout.write(questionsPage(load(w), budget));
  else if (cmd === 'release') {
    try {
      const r = issue(w, reason);
      const m = JSON.parse(r.release.files['manifest.json']!);
      console.log(`revision ${r.revision} issued: ${r.path} and ${r.zipPath}, package ${m.package.slice(0, 12)}`);
      console.log(m.ready ? 'ready for a person to sign the gauges' : `not ready to sign: ${[...r.release.problems, `${m.openQuestions} open question(s)`].join('; ')}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }
  if (cmd === 'status' || cmd === 'init' || cmd === 'reading' || cmd === 'answer') {
    const p = load(w);
    const h = history(w);
    const stage = stageOf(p, h.length > 0 && h.at(-1)!.ready);
    const i = STAGES.findIndex((s) => s.key === stage);
    console.log(`step ${i + 1} of ${STAGES.length}: ${STAGES[i]!.label}. ${STAGES[i]!.doing}`);
    console.log(`${p.questions.length} open question(s); ${h.length ? `last released revision ${h.at(-1)!.revision}` : 'nothing released yet'}`);
  }
  process.exit(0);
}
if (!['readback', 'questions', 'release'].includes(cmd ?? '') || files.length === 0 || (cmd === 'release' && !to)) {
  console.error('usage: intent readback|questions|release <files...> [--reading r.json]... [--answers a.json] [--budget n] [--rev n --to dir --prior dir --reason text]');
  process.exit(2);
}
const priorDatum = priorDir ? JSON.parse(readFileSync(join(priorDir, 'datum.json'), 'utf8')) : undefined;
const p = prepare({ files, readings, answers, ...(priorDir ? { prior: JSON.parse(readFileSync(join(priorDir, 'balloons.json'), 'utf8')) } : {}) });
if (cmd === 'readback') process.stdout.write(readBack(p, budget));
else if (cmd === 'questions') process.stdout.write(questionsPage(p, budget));
else {
  const r = release(p, { revision: rev, ...(priorDatum ? { prior: { revision: priorDatum.revision, datum: priorDatum } } : {}), ...(reason ? { reason } : {}) });
  if (r.problems.some((x) => /must say why|must come after/.test(x))) {
    console.error(r.problems.join('\n'));
    process.exit(1);
  }
  for (const [path, body] of Object.entries(r.files)) {
    mkdirSync(dirname(join(to, path)), { recursive: true });
    writeFileSync(join(to, path), body);
  }
  if (zipTo) writeFileSync(zipTo, zip(r.files, `${p.model.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-rev-${rev}`));
  const m = JSON.parse(r.files['manifest.json']!);
  console.log(`revision ${rev} issued to ${to}: ${Object.keys(r.files).length} files, package ${m.package.slice(0, 12)}`);
  console.log(m.ready ? 'ready for a person to sign the gauges' : `not ready to sign: ${[...r.problems, `${m.openQuestions} open question(s)`].join('; ')}`);
}
