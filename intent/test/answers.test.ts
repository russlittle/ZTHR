import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { answerFor } from '../src/questions.ts';
import { questionsPage } from '../src/form.ts';
import { prepare } from '../src/pipeline.ts';
import { readBack } from '../src/readback.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const rough = { path: 'rough.md', text: fx('rough.md') };
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];
const base = { id: 'x', origin: 'diff' as const, text: 'q', protects: 'p', consequence: 'high' as const };

test('each question gets the quickest way to answer it, and every choice takes Other', () => {
  assert.deepEqual(answerFor({ ...base, choices: ['a', 'b'] }), { kind: 'single', options: ['a', 'b'], other: true });
  assert.deepEqual(answerFor({ ...base, choices: ['a'] }), { kind: 'confirm', proposal: 'a' });
  assert.deepEqual(answerFor({ ...base, text: '"Reminders stop": is a receipt needed?' }), { kind: 'single', options: ['Yes', 'No'], other: true });
  assert.deepEqual(answerFor({ ...base, text: 'which staff?' }), { kind: 'text' });
  assert.deepEqual(answerFor({ ...base, answer: { kind: 'multi', options: ['m'], other: true } }), { kind: 'multi', options: ['m'], other: true });
});

test('items only one reading found are asked together as one pick-any question', () => {
  const p = prepare({ files: [rough], readings });
  const q = p.questions.find((x) => x.slot === 'outcome')!;
  assert.equal(q.answer?.kind, 'multi');
  assert.deepEqual(q.answer?.kind === 'multi' && q.answer.options, ['a warning when money will be short']);
});

test('answers become the person\'s own statements, answered questions are not asked again, and nothing else is lost', () => {
  const before = prepare({ files: [rough], readings });
  const why = before.questions.find((q) => q.slot === 'why')!;
  const outcome = before.questions.find((q) => q.slot === 'outcome')!;
  const after = prepare({
    files: [rough],
    readings,
    answers: { [why.id]: { pick: 'stay housed and in school' }, [outcome.id]: { picks: ['a warning when money will be short'], other: 'staff can see who needs help' }, end: { yes: true } },
  });
  const mine = after.statements.filter((s) => s.supplied.kind === 'person' && s.id.startsWith('A:'));
  assert.deepEqual(mine.map((s) => [s.slot, s.text]), [
    ['why', 'stay housed and in school'],
    ['outcome', 'a warning when money will be short'],
    ['outcome', 'staff can see who needs help'],
  ]);
  assert.ok(mine.every((s) => s.state === 'confirmed'));
  assert.ok(!after.questions.some((q) => [why.id, outcome.id, 'end'].includes(q.id)));
  assert.equal(after.model.end, 'I want students to stop getting their power shut off.');
  assert.equal(after.questions.length, before.questions.length - 3);
});

test('confirming a proposed problem and typing an outcome fill their slots, and only what is still open is asked', () => {
  const p0 = prepare({ files: [rough] });
  assert.ok(p0.questions.some((q) => q.id === 'pair:problem'));
  const p1 = prepare({ files: [rough], answers: { 'pair:problem': { yes: true }, 'pair:outcome': { other: 'no student loses power over a missed bill' } } });
  assert.ok(p1.statements.some((s) => s.slot === 'problem' && s.state === 'confirmed'));
  assert.ok(p1.statements.some((s) => s.slot === 'outcome' && s.text === 'no student loses power over a missed bill'));
  assert.ok(!p1.questions.some((q) => q.id === 'pair:problem' || q.id === 'pair:outcome'));
  assert.deepEqual(p1.questions.map((q) => q.id), ['who-sees', 'end']);
});

test('the questions page: one fieldset per question, every input labelled, Other on every choice, nothing unescaped', () => {
  const html = questionsPage(prepare({ files: [rough], readings }), 5);
  assert.equal((html.match(/<fieldset class=""/g) ?? []).length, 5);
  const all = (html.match(/<fieldset/g) ?? []).length;
  const ids = [...html.matchAll(/<input type="(?:radio|checkbox)" id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) assert.ok(html.includes(`<label for="${id}">`), `input ${id} has no label`);
  const typed = (html.match(/<textarea/g) ?? []).length;
  assert.equal((html.match(/value="__other__"/g) ?? []).length, all - typed);
  assert.equal(typed, 0, 'every question here can be answered by tapping');
  assert.match(html, /<html lang="en">/);
  assert.ok(!/<legend>[^<]*"Staff/.test(html) || html.includes('&quot;Staff'), 'quotes in legends are escaped');
  const markdown = readBack(prepare({ files: [rough], readings }));
  assert.match(markdown, /- \( \) stay housed and in school\n {3}- \( \) avoid late fees\n {3}- \( \) Other: ______/);
});

test('one family alone gives proposals to confirm, never agreed statements, and answering them gives gauges', () => {
  const one = [readings[0]];
  const p = prepare({ files: [rough], readings: one });
  assert.ok(!p.statements.some((s) => s.supplied.kind === 'parse'), 'nothing is taken as agreed on one reading');
  assert.ok(p.questions.some((q) => q.id === 'one:outcomes' && /one reading so far, by gemini/.test(q.text)));
  assert.ok(!p.questions.some((q) => q.id === 'pair:problem' || q.id === 'pair:outcome'), 'the gap is offered as a proposal, not asked from nothing');
  const after = prepare({ files: [rough], readings: one, answers: { 'one:problem': { yes: true }, 'one:outcomes': { picks: ['no shut-off from a missed due date'] }, 'one:measures': { picks: ['shut-offs avoided (none in a term)'] } } });
  assert.ok(after.statements.some((s) => s.slot === 'outcome' && s.state === 'confirmed'));
  const m = after.statements.find((s) => s.slot === 'measures' && s.text === 'shut-offs avoided')!;
  assert.equal(m.tolerance, 'none in a term', 'a picked measure keeps its tolerance apart, as a working range');
});

test('two of the person\'s words that want different things are a redline, and the title block waits for the choice', () => {
  const words = { path: 'w.md', text: 'Make it calm and professional for students.' };
  const p = prepare({ files: [words] });
  const q = p.questions.find((x) => x.id === 'clash:palette')!;
  assert.deepEqual(q.answer?.kind === 'single' && q.answer.options, ['soft (for "calm")', 'restrained (for "professional")']);
  assert.match(p.title['palette']!.value, /^undecided/);
  const chosen = prepare({ files: [words], answers: { 'clash:palette': { pick: 'restrained (for "professional")' } } });
  assert.equal(chosen.title['palette']!.value, 'restrained');
  assert.ok(!chosen.questions.some((x) => x.id === 'clash:palette'));
});

test('ratchet: a tolerance answer sets the measure it is about, and never becomes a measure of its own', () => {
  const p = prepare({ files: [rough], readings });
  const tol = p.questions.find((q) => q.tolerates !== undefined)!;
  assert.ok(tol, 'a tolerance question exists');
  const answers: Record<string, { pick?: string; other?: string }> = { [tol.id]: { other: 'two in a term' } };
  const after = prepare({ files: [rough], readings, answers });
  const m = after.statements.find((s) => s.slot === 'measures' && s.text === tol.tolerates);
  assert.equal(m?.tolerance, 'two in a term');
  assert.ok(!after.statements.some((s) => s.slot === 'measures' && s.text === 'two in a term'));
});
