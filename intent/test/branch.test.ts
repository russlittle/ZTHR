import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { questionsPage } from '../src/form.ts';
import { prepare } from '../src/pipeline.ts';
import { detectDomain, loadRoles } from '../src/roles.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const rough = { path: 'rough.md', text: fx('rough.md') };

test('the kind of work is detected from the person\'s words, and nothing is guessed when no domain matches', () => {
  const roles = loadRoles();
  assert.equal(detectDomain(roles, ['Remind students before bills are due'])?.domain, 'education');
  assert.equal(detectDomain(roles, ['Remind patients before appointments'])?.domain, 'health');
  assert.equal(detectDomain(roles, ['Show a list of plants']), null);
});

test('"staff" becomes a branch of taps: where they work, which offices, what they see and when, and taking it back', () => {
  const p = prepare({ files: [rough] });
  const q = p.questions.find((x) => x.id === 'who-sees')!;
  assert.deepEqual(q.answer?.kind === 'multi' && q.answer.options, ['At the college', 'At an outside service']);
  assert.deepEqual(q.follow?.['At the college']?.[0]?.answer?.kind === 'multi' && q.follow['At the college'][0].answer.options.slice(0, 2), ['Counseling', 'Academic advising']);
  const access = q.follow?.['__any__']?.[0]!;
  assert.match(access.answer?.kind === 'single' ? access.answer.recommended ?? '' : '', /^Only what the student chooses to share, after they grant it: one way, from the student to staff$/);
  assert.equal(access.follow?.[access.answer?.kind === 'single' ? access.answer.recommended! : '']?.[0]?.id, 'who-sees:revoke');
  assert.ok(!p.questions.some((x) => x.origin === 'marker' && /which staff/.test(x.text)), 'the marker is answered by the branch, not asked twice');
});

test('answering the branch gives exact, marked statements, and only the follow-ups still open are asked', () => {
  const access = 'Only what the student chooses to share, after they grant it: one way, from the student to staff';
  const p = prepare({ files: [rough], answers: { 'who-sees': { picks: ['At the college'] }, 'who-sees:units:1': { picks: ['Counseling', 'Financial aid'] }, 'who-sees:access': { pick: access } } });
  const mine = p.statements.filter((s) => s.id.startsWith('A:who-sees'));
  assert.deepEqual(mine.map((s) => s.text).sort(), [
    'Counseling staff, at the college (on the other side)',
    'Financial aid staff, at the college (on the other side)',
    'staff at the college are involved',
    'staff see only what the student chooses to share, and only after the student grants it; information flows one way, from the student to staff',
  ]);
  assert.equal(mine.find((s) => s.text.startsWith('staff see only'))!.mark, 'critical');
  assert.deepEqual(p.questions.filter((q) => q.id.startsWith('who-sees')).map((q) => q.id), ['who-sees:revoke']);
});

test('the page nests each branch under its option, pre-selects the recommended choice, and labels every input', () => {
  const html = questionsPage(prepare({ files: [rough] }), 6);
  assert.match(html, /<div class="follow" data-when="q\d+-0">/);
  assert.match(html, /<div class="follow" data-when-any="q\d+">/);
  assert.match(html, / checked><label [^>]+>Only what the student chooses to share[^<]*<span class="rec">recommended<\/span>/);
  const ids = [...html.matchAll(/<input type="(?:radio|checkbox)" id="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ids) assert.ok(html.includes(`<label for="${id}">`), `input ${id} has no label`);
  assert.equal(new Set(ids).size, ids.length, 'every input id is unique');
});
