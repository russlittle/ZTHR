import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claim } from './equivalent.ts';
import { compareResults, floorsProposal, guardNetRemoval, guardNoDisable, guardScope, guardTestDiff, isEquivalent, modelFamily, mutantKey, occurrenceKeys, parseStryker, remaining, rule, type BlockResult, type Mutant, type Ruling } from './lib.ts';
import { KIND_RANK } from './lib.ts';

const SOURCE = ['export function f(x: number) {', '  if (x >= 0) return x;', '  return -x;', '}', ''].join('\n');

const loc = (line: number, c1: number, c2: number) => ({ start: { line, column: c1 }, end: { line, column: c2 } });
const REPORT = {
  files: {
    'blocks/b/index.ts': {
      source: SOURCE,
      mutants: [
        { id: '0', mutatorName: 'EqualityOperator', replacement: 'x > 0', status: 'Survived', location: loc(2, 7, 13) },
        { id: '1', mutatorName: 'ConditionalExpression', replacement: 'true', status: 'Killed', location: loc(2, 7, 13) },
        { id: '2', mutatorName: 'UnaryOperator', replacement: 'x', status: 'Timeout', location: loc(3, 10, 12) },
        { id: '3', mutatorName: 'StringLiteral', replacement: '""', status: 'CompileError', location: loc(3, 3, 5) },
        { id: '4', mutatorName: 'BlockStatement', replacement: '{}', status: 'NoCoverage', location: { start: { line: 1, column: 30 }, end: { line: 4, column: 2 } } },
      ],
    },
  },
};

test('survivors are parsed with original text, counts and score', () => {
  const r = parseStryker(REPORT, 'b', '2026-01-01T00:00:00Z');
  assert.deepEqual([r.mutants, r.killed, r.timeout, r.survived, r.noCoverage], [4, 1, 1, 1, 1]);
  assert.equal(r.score, 50);
  assert.equal(r.survivors.length, 2);
  const s = r.survivors.find((m) => m.id === '0')!;
  assert.equal(s.original, 'x >= 0');
  assert.equal(s.replacement, 'x > 0');
  assert.equal(s.lineText, 'if (x >= 0) return x;');
  assert.equal(s.prevText, 'export function f(x: number) {');
  const multi = r.survivors.find((m) => m.id === '4')!;
  assert.equal(multi.original, "{\n  if (x >= 0) return x;\n  return -x;\n}");
  assert.equal(r.killedKeys!.length, 2);
});

test('compile errors are not counted in the score', () => {
  const r = parseStryker(REPORT, 'b', 'x');
  assert.equal(r.killed + r.timeout + r.survived + r.noCoverage, r.mutants);
});

test('an equivalence ruling still matches after the source shifts down and the mutant gets a new id and line', () => {
  const before = parseStryker(REPORT, 'b', 'x').survivors.find((m) => m.id === '0')!;
  const shifted = ['// a new header', '// another', ...SOURCE.split('\n')].join('\n');
  const rep2 = structuredClone(REPORT);
  const f = rep2.files['blocks/b/index.ts']!;
  f.source = shifted;
  for (const m of f.mutants) {
    m.location.start.line += 2;
    m.location.end.line += 2;
    m.id = String(Number(m.id) + 40);
  }
  const after = parseStryker(rep2, 'b', 'y').survivors.find((m) => m.mutator === 'EqualityOperator')!;
  assert.notEqual(after.line, before.line);
  assert.notEqual(after.id, before.id);
  assert.equal(mutantKey(after), mutantKey(before));
  const { ruling } = claim('b', before, { argument: 'x is never exactly 0 here', by: 'claude-sonnet-5-5', judge: 'gpt-5', verdict: 'equivalent' }, []);
  assert.equal(ruling.status, 'equivalent');
  assert.equal(isEquivalent(after, [ruling]), true);
  assert.equal(remaining({ survivors: [after] } as BlockResult, [ruling]).length, 0);
});

test('a ruling does not match when the text around the mutant changed or the replacement differs', () => {
  const m: Mutant = { id: '1', line: 2, column: 7, endLine: 2, endColumn: 13, mutator: 'EqualityOperator', original: 'x >= 0', replacement: 'x > 0', lineText: 'if (x >= 0) return x;', prevText: 'a', nextText: 'b' };
  const { ruling } = claim('b', m, { argument: 'a', by: 'claude-opus', judge: 'gemini-3', verdict: 'equivalent' }, []);
  assert.equal(isEquivalent({ ...m, lineText: 'if (x >= 0) return y;' }, [ruling]), false);
  assert.equal(isEquivalent({ ...m, replacement: 'x < 0' }, [ruling]), false);
  assert.equal(isEquivalent({ ...m, nextText: 'c' }, [ruling]), false);
});

test('only a different-family judge saying equivalent counts', () => {
  assert.equal(rule('equivalent', 'claude-opus-4', 'claude-haiku-4'), 'disputed');
  assert.equal(rule('equivalent', 'claude-opus-4', 'gpt-5'), 'equivalent');
  assert.equal(rule('not-equivalent', 'claude-opus-4', 'gpt-5'), 'disputed');
  assert.equal(rule('unsure', 'gpt-5', 'gemini-3-pro'), 'disputed');
  assert.equal(modelFamily('Claude Sonnet 5.5'), 'anthropic');
  assert.equal(modelFamily('my-local-model'), 'my');
});

test('identical keys on different lines stay distinct by occurrence', () => {
  const m = { mutator: 'M', original: 'a', replacement: 'b', lineText: 'x', prevText: '', nextText: '' } as Mutant;
  const k = occurrenceKeys([m, m]);
  assert.notEqual(k[0], k[1]);
});

const testDiff = (lines: string[]) => ['--- a/t.ts', '+++ b/t.ts', '@@ -1,3 +1,4 @@', ...lines].join('\n');

test('diff guard accepts an added test', () => {
  assert.deepEqual(guardTestDiff(testDiff([' import x', "+test('new', () => {", '+  assert.equal(f(1), 1);', '+});'])), []);
});

test('diff guard rejects a removed assert, including a weakened one', () => {
  assert.equal(guardTestDiff(testDiff(['-  assert.deepEqual(a, b);', '+  assert.ok(a);'])).length, 1);
  assert.equal(guardTestDiff(testDiff(['-  assert.strictEqual(a, b);'])).length, 1);
});

test('diff guard rejects added skip, todo, only and Stryker disable', () => {
  for (const bad of ["+test.skip('x', () => {});", "+test('x', { todo: true }, () => {});", "+test('x', { only: true }, () => {});", '+test.only("x", () => {});', '+// Stryker disable next-line all']) {
    assert.ok(guardTestDiff(testDiff([bad])).length >= 1, bad);
  }
  assert.equal(guardNoDisable(testDiff(['+// Stryker disable all'])).length, 1);
  assert.equal(guardNoDisable(testDiff(['+const a = 1;'])).length, 0);
});

test('scope guard rejects an edit outside mayEdit', () => {
  const may = ['intent/blocks/geo/geo.test.ts'];
  assert.deepEqual(guardScope(['intent/blocks/geo/geo.test.ts'], may), []);
  assert.equal(guardScope(['intent/blocks/geo/geo.test.ts', 'intent/blocks/geo/index.ts'], may).length, 1);
});

test('simplify must be a net removal', () => {
  assert.deepEqual(guardNetRemoval(testDiff(['-  if (a) return;', '-  b();', '+  b();'])), []);
  assert.equal(guardNetRemoval(testDiff(['+  x();', '+  y();', '-  z();'])).length, 1);
});

const res = (block: string, score: number, survivors: Mutant[], killedKeys?: string[]) => ({ block, ranAt: '', mutants: 10, killed: 0, timeout: 0, survived: survivors.length, noCoverage: 0, score, survivors, killedKeys }) as BlockResult;
const mu = (original: string): Mutant => ({ id: '1', line: 1, column: 1, endLine: 1, endColumn: 2, mutator: 'M', original, replacement: 'r', lineText: original });

test('ratchet fails on a score drop and on a killed mutant that survives again, and passes otherwise', () => {
  const a = mu('a');
  const prev = res('b', 80, [], occurrenceKeys([a]));
  assert.deepEqual(compareResults(prev, res('b', 80, [])), []);
  assert.deepEqual(compareResults(prev, res('b', 90, [mu('other')])), []);
  assert.equal(compareResults(prev, res('b', 79, []))[0]!.kind, 'score-dropped');
  assert.equal(compareResults(prev, res('b', 85, [a]))[0]!.kind, 'killed-now-survives');
  assert.deepEqual(compareResults(undefined, res('b', 1, [a])), []);
});

test('floors proposal lists every block with its current score', () => {
  const md = floorsProposal('2026-11-27', [{ block: 'geo', score: 81.25, survivors: 3, equivalents: 1 }]);
  assert.match(md, /\| geo \| 81.25 \| 3 \| 1 \|/);
  assert.match(md, /Signed:/);
});

test('task order is fix-bug, then kill-mutant, then simplify', () => {
  assert.ok(KIND_RANK['fix-bug'] < KIND_RANK['kill-mutant'] && KIND_RANK['kill-mutant'] < KIND_RANK.simplify);
});

test('a ruling record keeps a recorded "no simplification" note when re-claimed', () => {
  const m = mu('q');
  const first = claim('b', m, { argument: 'a', by: 'claude-x', judge: 'gpt-y', verdict: 'equivalent' }, []);
  const noted: Ruling = { ...first.ruling, simplify: { status: 'none-possible', reason: 'public API', by: 'w', at: 't' } };
  const again = claim('b', m, { argument: 'a2', by: 'claude-x', judge: 'gpt-z', verdict: 'equivalent' }, [noted]);
  assert.equal(again.rulings.length, 1);
  assert.equal(again.ruling.simplify?.reason, 'public API');
});
