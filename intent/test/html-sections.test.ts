import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decode, htmlToMarkdown, isHtml } from '../src/intake/html.ts';
import { intakeOne } from '../src/intake/index.ts';
import { sections } from '../src/intake/sections.ts';
import { modelContext, prepare } from '../src/pipeline.ts';
import { readBack } from '../src/readback.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');

test('a page is recognised by its name or its doctype', () => {
  assert.equal(isHtml('spec.html', ''), true);
  assert.equal(isHtml('x', '  <!DOCTYPE html><html>'), true);
  assert.equal(isHtml('x.md', '# not a page'), false);
});

test('entities decode, named and numbered', () => {
  assert.equal(decode('a &amp; b &#8209; &#x2014; &nbsp;&unknown;'), 'a & b ‑ — \u00a0&unknown;'.replace('\u00a0', ' '));
});

test('a Claude artifact page becomes markdown: scripts, styles and chrome dropped; headings, lists, tables and code kept', () => {
  const md = htmlToMarkdown(fx('artifact.html'));
  assert.ok(!/not a requirement|font-family|Home|© 2026/.test(md));
  assert.match(md, /^# Feature Specification: Bill help$/m);
  assert.match(md, /^1\. \*\*Given\*\* rent of \$900/m);
  assert.match(md, /^- \*\*FR-002\*\*: Reminders MUST stop/m);
  assert.match(md, /^\| Language \| English \\\| Spanish \|$/m);
  assert.match(md, /^```gherkin\nScenario: Quiet hours\n  Given quiet hours/m);
});

test('the page is parsed as the form it carries, the same as the markdown would be', () => {
  const m = intakeOne('spec.html', fx('artifact.html'));
  assert.equal(m.sources[0]!.form, 'speckit');
  assert.equal(m.sources[0]!.from, 'html');
  assert.deepEqual(m.requirements.map((r) => r.id), ['FR-001', 'FR-002']);
  assert.deepEqual(m.examples.map((e) => e.id), ['US1.1', 'US1.2', 'quiet-hours']);
  assert.equal(m.clarifications[0]!.text, 'is a receipt needed?');
  assert.match(m.end!, /^Students stay housed & in school/);
  assert.equal(m.notes.length, 1);
});

test('the end, engineering notes and variants are read from their own sections, with reasons and effectivity', () => {
  const x = sections('full.md', fx('full.md'));
  assert.match(x.end!, /^Students stay housed and in school/);
  assert.deepEqual(x.notes.map((n) => [n.stance, n.reason]), [
    ['practical', 'the move to the new records system'],
    ['ideal', 'it is approved'],
    ['practical', null],
  ]);
  assert.deepEqual(x.variants.map((v) => [v.id, v.effectivity]), [
    ['A', 'campuses with SMS consent on file'],
    ['B', 'campuses without SMS consent'],
    ['C', null],
  ]);
});

test('notes and variants are not mistaken for requirements, and a variant with no effectivity is a question', () => {
  const p = prepare({ files: [{ path: 'full.md', text: fx('full.md') }] });
  assert.deepEqual(p.model.requirements.map((r) => r.text), ['Remind students before bills are due', "Warn when the month's money will be short"]);
  assert.ok(p.questions.some((q) => q.id === 'variant:C'));
  assert.ok(!p.questions.some((q) => q.id === 'end'));
});

test('the end leads the read-back and every model context; without it, the first question asks for it', () => {
  const p = prepare({ files: [{ path: 'full.md', text: fx('full.md') }] });
  assert.match(readBack(p), /^## The end in mind\n\nStudents stay housed/m);
  const ctx = modelContext(p);
  assert.match(ctx, /^End in mind: Students stay housed/);
  assert.match(ctx, /Engineering notes \(how, for now; never the intent\):/);
  const bare = prepare({ files: [{ path: 'rough.md', text: fx('rough.md') }] });
  assert.ok(bare.questions.some((q) => q.id === 'end' && q.choices?.[0] === 'I want students to stop getting their power shut off.'));
  assert.match(modelContext(bare), /^End in mind: \(not yet stated; ask before building\)/);
});
