import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { detectForm, intake, intakeOne } from '../src/intake/index.ts';

const read = (name: string) => ({ path: name, text: readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8') });

test('each form is recognised from its own shape', () => {
  const forms = ['speckit.md', 'kiro.md', 'openspec.md', 'bills.feature', 'rough.md'].map((n) => {
    const f = read(n);
    return detectForm(f.path, f.text);
  });
  assert.deepEqual(forms, ['speckit', 'kiro', 'openspec', 'gherkin', 'markdown']);
});

test('Spec Kit: scenarios keep their story, requirements keep their numbers, markers become questions, fenced Gherkin is read', () => {
  const f = read('speckit.md');
  const m = intakeOne(f.path, f.text);
  assert.equal(m.title, 'Bill warnings');
  assert.deepEqual(
    m.examples.map((e) => [e.id, e.of]),
    [
      ['US1.1', 'US1'],
      ['US1.2', 'US1'],
      ['US2.1', 'US2'],
      ['quiet-hours', null],
    ],
  );
  const first = m.examples[0]!;
  assert.equal(first.given, 'rent of $900 due on the 1st and $700 expected');
  assert.equal(first.when, 'the student opens Today');
  assert.equal(first.then, 'a warning shows the $200 gap and ways to cover it');
  assert.deepEqual(m.requirements.map((r) => r.id), ['FR-001', 'FR-002']);
  assert.equal(m.clarifications[0]?.text, 'does "paid" need a receipt?');
  assert.equal(m.clarifications[0]?.origin.line, 27);
  assert.equal(m.requirements[1]?.text, 'Reminders MUST stop once a bill is marked paid.');
  assert.equal(m.examples[3]?.origin.line, 30);
  assert.deepEqual(m.context, ['A bill with no due date is listed, never warned about.']);
});

test('Kiro: every EARS form becomes an example with its trigger and response', () => {
  const f = read('kiro.md');
  const m = intakeOne(f.path, f.text);
  const ex = Object.fromEntries(m.examples.map((e) => [e.id, [e.given, e.when, e.then]]));
  assert.deepEqual(ex['R1.1'], ['', 'expected money is below bills due', 'show the gap before the first of the month']);
  assert.deepEqual(ex['R1.2'], ['a bill has no due date', '', 'list it without a warning']);
  assert.deepEqual(ex['R1.3'], ['quiet hours are on', 'a reminder is due', 'hold it until quiet hours end']);
  assert.deepEqual(ex['R2.1'], ['', 'a bill is marked paid', 'send no further reminders for it']);
  assert.ok(m.requirements.some((r) => r.id === 'R1.4' && /history/.test(r.text)), 'a ubiquitous SHALL is a requirement');
  assert.match(m.requirements.find((r) => r.id === 'R1')!.text, /^As a student/);
});

test('OpenSpec: scenarios under their requirement, AND joins the step before it', () => {
  const f = read('openspec.md');
  const m = intakeOne(f.path, f.text);
  assert.deepEqual(m.requirements.map((r) => r.id), ['short-month-warning', 'reminders-stop']);
  assert.match(m.requirements[0]!.text, /^The system SHALL warn/);
  const s = m.examples.find((e) => e.id === 'short-month-warning/money-short')!;
  assert.equal(s.given, 'rent of $900 due on the 1st; $700 expected');
  assert.equal(s.then, 'a warning shows the $200 gap; ways to cover it are offered');
  assert.equal(m.examples.find((e) => e.id === 'reminders-stop/paid-bill')?.of, 'reminders-stop');
});

test('Gherkin: background steps carry into every scenario, and each outline row is its own example', () => {
  const f = read('bills.feature');
  const m = intakeOne(f.path, f.text);
  assert.deepEqual(m.examples.map((e) => e.id), ['money-short', 'gap-shown#1', 'gap-shown#2']);
  assert.equal(m.examples[0]!.given, 'a student with bills; rent of $900 due on the 1st; $700 expected');
  assert.equal(m.examples[2]!.then, 'the gap shown is none');
  assert.equal(m.examples[2]!.origin.line, 22);
  assert.equal(m.examples[0]!.of, 'warn-before-a-short-month');
});

test('Plain markdown: list items are requirements, scenario lines are examples, prose is context, markers are questions', () => {
  const f = read('rough.md');
  const m = intakeOne(f.path, f.text);
  assert.deepEqual(m.requirements.map((r) => r.text), ['Remind students before bills are due', 'It should be snappy on a phone', 'Staff should see who is struggling']);
  assert.deepEqual(m.examples.map((e) => [e.when, e.then]), [['a bill is paid', 'reminders stop']]);
  assert.equal(m.context[0], 'I want students to stop getting their power shut off. Make it feel calm, not scary.');
  assert.equal(m.clarifications[0]?.text, 'which staff?');
});

test('the same files give the same model, identifiers included, and several files are kept apart', () => {
  const files = [read('speckit.md'), read('kiro.md')];
  assert.deepEqual(intake(files), intake(files));
  const both = intake(files);
  assert.ok(both.examples.some((e) => e.id === 'F1:US1.1' && e.of === 'F1:US1'));
  assert.ok(both.examples.some((e) => e.id === 'F2:R1.1'));
  assert.equal(both.sources.length, 2);
  assert.match(both.sources[0]!.sha256, /^[0-9a-f]{64}$/);
});
