import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Statement } from '../src/frame.ts';
import { assignBalloons, balloonKey, prepare, titleBlock } from '../src/pipeline.ts';
import { ranked, readBack } from '../src/readback.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const rough = { path: 'rough.md', text: fx('rough.md') };
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];

test('balloons keep their numbers across a revision; new statements take the next numbers', () => {
  const st = (slot: Statement['slot'], text: string): Statement => ({ id: text, slot, text, state: 'assumed', supplied: { kind: 'person' } });
  const first = assignBalloons([st('problem', 'Power is shut off'), st('outcome', 'No shut-offs')]);
  const prior = Object.fromEntries(first.map((b) => [balloonKey(b), b.balloon]));
  const second = assignBalloons([st('outcome', 'no shut-offs.'), st('measures', 'shut-offs avoided'), st('problem', 'power is SHUT OFF')], prior);
  assert.deepEqual(second.map((b) => [b.text, b.balloon]), [
    ['power is SHUT OFF', 1],
    ['no shut-offs.', 2],
    ['shut-offs avoided', 3],
  ]);
});

test('the title block shows each override with the default it replaces', () => {
  const t = titleBlock([{ term: 'calm', choices: { density: 'spacious', itemsPerScreen: 'few' } }]);
  assert.deepEqual(t['density'], { value: 'spacious', from: '"calm"', replaces: { value: 'comfortable', from: 'default' } });
  assert.deepEqual(t['itemsPerScreen'], { value: 'few', from: '"calm"' });
  assert.deepEqual(t['language'], { value: 'English', from: 'default' });
});

test('without two readings the free text is reported unread, and the person\'s own sentence is offered, never a blank question', () => {
  const p = prepare({ files: [rough] });
  assert.match(p.unread[0]!, /two model families; none has read them yet/);
  const problem = p.questions.find((q) => q.id === 'pair:problem')!;
  assert.deepEqual(problem.choices, ['I want students to stop getting their power shut off.']);
  assert.ok(p.questions.some((q) => q.id === 'who-sees' && q.text.startsWith('"Staff should see who is struggling": where do these staff work?')));
});

test('a reading that breaks the schema counts as unknown, and one family alone does not count as read', () => {
  const p = prepare({ files: [rough], readings: [readings[0], { ...readings[1], extra: 1 }] });
  assert.match(p.unread[0]!, /reading 2 does not match the schema \(unexpected field extra\)/);
  assert.match(p.unread[1]!, /only gemini read them/);
  assert.ok(!p.statements.some((s) => s.supplied.kind === 'parse'));
});

test('two readings: what they share is kept, every difference is a question, and the problem is no longer asked', () => {
  const p = prepare({ files: [rough], readings });
  assert.deepEqual(p.unread, []);
  assert.ok(p.statements.some((s) => s.slot === 'problem' && s.supplied.kind === 'parse'));
  assert.ok(!p.questions.some((q) => q.id === 'pair:problem' || q.id === 'pair:outcome'));
  assert.deepEqual(p.questions.filter((q) => q.origin === 'diff').map((q) => q.slot), ['why', 'outcome', 'people', 'measures']);
});

test('the read-back is rendered, not written: the same input gives the same text, with balloons, marks and the question budget', () => {
  const a = readBack(prepare({ files: [rough], readings }), 3);
  assert.equal(a, readBack(prepare({ files: [rough], readings }), 3));
  assert.match(a, /\*\*\[1\]\*\* students get their power shut off/);
  assert.match(a, /\*\*\(critical\)\*\*/);
  assert.match(a, /## Needs a control before it ships/);
  assert.match(a, /[1-9]\d* smaller questions? can wait/);
  assert.match(a, /\*\*density\*\*: spacious, because you said "calm" \(instead of comfortable\)/);
});

test('questions are ranked by consequence and held beyond the budget', () => {
  const q = (id: string, consequence: 'high' | 'medium' | 'low') => ({ id, origin: 'diff' as const, text: id, protects: 'x', consequence });
  const r = ranked([q('low', 'low'), q('high', 'high'), q('mid', 'medium')], 2);
  assert.deepEqual(r.ask.map((x) => x.id), ['high', 'mid']);
  assert.equal(r.held, 1);
});
