import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intake } from '../src/intake/index.ts';
import { prepare } from '../src/pipeline.ts';

const HIRE = `# Bill help

The job I am hiring this for: keep students from losing power over a missed bill
I would know it is doing a good job when: no student on the program has a shut-off
At the end of the year it was a good hire if: more of these students finished the year housed and enrolled
- It is for: students on emergency aid
`;

test("the hiring questions (Christensen's jobs to be done) land in their slots, as the person's own words", () => {
  const m = intake([{ path: 'h.md', text: HIRE }]);
  assert.equal(m.end, 'more of these students finished the year housed and enrolled');
  assert.deepEqual(
    m.labelled.map((l) => [l.slot, l.text, l.origin.line]),
    [
      ['problem', 'keep students from losing power over a missed bill', 3],
      ['measures', 'no student on the program has a shut-off', 4],
      ['people', 'students on emergency aid', 6],
    ],
  );
  assert.deepEqual(m.context, [], 'a labelled line needs no reading');
});

test('labelled lines need no model: no reading is asked for, and every one is confirmed', () => {
  const p = prepare({ files: [{ path: 'h.md', text: HIRE }] });
  assert.deepEqual(p.unread, []);
  const mine = p.statements.filter((s) => s.supplied.kind === 'person');
  assert.ok(mine.every((s) => s.state === 'confirmed'));
  assert.ok(p.questions.some((q) => q.id.startsWith('pair:tolerance')), 'a measure without a tolerance still gets asked how close is close enough');
});

test('planted: a label with nothing after it is not a statement, and a label mid-sentence is not a label', () => {
  const m = intake([{ path: 'h.md', text: '# T\n\nThe job I am hiring this for:\nWe talked about why: it was late\n' }]);
  assert.deepEqual(m.labelled, []);
  assert.equal(m.context.length, 2);
});
