import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkError, chunk, chunkAt, cite, defaultCounter, locateQuote, verifyAnchor } from './index.ts';

const bytes = (t: string) => new TextEncoder().encode(t).length;
const doc = `---
title: Guide
---
# Guide

Intro paragraph about the guide.

## Install

Run the installer. It takes a minute.

\`\`\`sh
npm install thing
npm run setup
\`\`\`

## Usage

Call the function. It returns a value.

### Options

- one
- two

## Notes

Last words here.
`;

test('splits by heading: each section is its own chunk with its heading path and slug', () => {
  const cs = chunk(doc, { maxTokens: 200, count: bytes, splitDepth: 2 });
  assert.deepEqual(cs.map((c) => c.headingPath), [['Guide'], ['Guide', 'Install'], ['Guide', 'Usage'], ['Guide', 'Notes']]);
  assert.deepEqual(cs.map((c) => c.headingId), ['guide', 'install', 'usage', 'notes']);
  assert.ok(cs[1]!.text.startsWith('## Install'));
  assert.ok(cs[1]!.text.includes('npm run setup'));
  assert.ok(cs[2]!.text.includes('### Options') && cs[2]!.text.includes('- two'), 'a deeper heading stays inside its section');
  assert.equal(cs.length, 4);
});

test('front matter is skipped, never chunked', () => {
  const cs = chunk(doc, { maxTokens: 200, count: bytes });
  assert.ok(!cs.some((c) => c.text.includes('title: Guide')));
  assert.equal(cs[0]!.start, doc.indexOf('# Guide'));
  assert.equal(cs[0]!.startLine, 4);
});

test('every chunk is a verbatim slice of the source within the budget, and the whole text is covered', () => {
  const big = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something plain.`).join(' ');
  const text = `# Big\n\n${big}\n\n## Second\n\n${big}`;
  const cs = chunk(text, { maxTokens: 60, count: bytes });
  for (const c of cs) {
    assert.equal(text.slice(c.start, c.end), c.text);
    assert.ok(c.tokens <= 60, `chunk ${c.index} has ${c.tokens}`);
    assert.equal(c.tokens, bytes(c.text));
    assert.ok(verifyAnchor(text, c));
  }
  const covered = new Set<number>();
  for (const c of cs) for (let i = c.start; i < c.end; i++) covered.add(i);
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i]!)) assert.ok(covered.has(i), `offset ${i} is in a chunk`);
  assert.ok(cs.length >= 8);
});

test('big paragraphs are cut at sentence ends first', () => {
  const para = 'Alpha is first. Beta is second. Gamma is third. Delta is fourth. Epsilon is fifth.';
  const cs = chunk(para, { maxTokens: 40, count: bytes, format: 'text' });
  assert.deepEqual(cs.map((c) => c.text), ['Alpha is first. Beta is second.', 'Gamma is third. Delta is fourth.', 'Epsilon is fifth.']);
});

test('overlap repeats the end of a full chunk at the start of the next, on a sentence start', () => {
  const para = 'Alpha is first. Beta is second. Gamma is third. Delta is fourth. Epsilon is fifth.';
  const cs = chunk(para, { maxTokens: 50, overlapTokens: 20, count: bytes, format: 'text' });
  assert.deepEqual(cs.map((c) => c.text), ['Alpha is first. Beta is second. Gamma is third.', 'Gamma is third. Delta is fourth. Epsilon is fifth.']);
  assert.equal(cs[1]!.start, para.indexOf('Gamma'));
  assert.equal(cs[1]!.coreStart, para.indexOf('Delta'));
  for (let i = 1; i < cs.length; i++) {
    assert.ok(cs[i]!.coreStart > cs[i]!.start, 'part of the start is overlap');
    assert.ok(cs[i]!.tokens <= 50);
  }
  assert.equal(cs.at(-1)!.end, para.length);
});

test('no overlap across a section break', () => {
  const text = '# One\n\nfirst section text here.\n\n# Two\n\nsecond section text here.';
  const cs = chunk(text, { maxTokens: 100, overlapTokens: 30, count: bytes });
  assert.equal(cs.length, 2);
  assert.equal(cs[1]!.start, cs[1]!.coreStart);
  assert.ok(!cs[1]!.text.includes('first section'));
});

test('a small section merges forward when minTokens asks for it', () => {
  const text = '# A\n\nTiny.\n\n# B\n\nThis section has quite a lot more text than the first.';
  assert.equal(chunk(text, { maxTokens: 200, count: bytes }).length, 2);
  const merged = chunk(text, { maxTokens: 200, minTokens: 30, count: bytes });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.headingPath, ['A']);
});

test('code blocks stay whole when they fit and split by lines when they do not', () => {
  const code = '```\n' + Array.from({ length: 12 }, (_, i) => `line_${i}();`).join('\n') + '\n```';
  const whole = chunk(`Before.\n\n${code}`, { maxTokens: 400, count: bytes });
  assert.equal(whole.length, 1);
  const cs = chunk(code, { maxTokens: 50, count: bytes });
  assert.ok(cs.length > 2);
  for (const c of cs.slice(0, -1)) assert.ok(c.text.endsWith(';') || c.text.endsWith('\n') || /\)\;?\s*$/.test(c.text), JSON.stringify(c.text.slice(-12)));
  assert.equal(cs.map((c) => c.text).join('').replace(/\s/g, ''), code.replace(/\s/g, ''));
});

test('a word longer than the budget is cut by characters, never inside an emoji', () => {
  const text = 'x'.repeat(100);
  const cs = chunk(text, { maxTokens: 30, count: bytes, format: 'text' });
  assert.deepEqual(cs.map((c) => c.text.length), [30, 30, 30, 10]);
  const emoji = chunk('😀'.repeat(20), { maxTokens: 10, count: bytes, format: 'text' });
  for (const c of emoji) {
    assert.doesNotMatch(c.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    assert.ok(c.tokens <= 10);
  }
  assert.equal(emoji.map((c) => c.text).join(''), '😀'.repeat(20));
});

test('anchors: lines, ids that change with text, citations, verify after an edit, and quote location', () => {
  const cs = chunk(doc, { maxTokens: 200, count: bytes, splitDepth: 2, docId: 'guide.md' });
  const install = cs[1]!;
  assert.equal(install.startLine, 8);
  assert.equal(install.endLine, 15);
  assert.match(install.id, /^[0-9a-f]{16}$/);
  const c = cite(install, 'guide.md');
  assert.equal(c.ref, 'guide.md#install:L8-L15');
  assert.equal(c.quote, '## Install Run the installer. It takes a minute. ```sh npm install thing npm run setup ```');
  assert.ok(verifyAnchor(doc, install));
  assert.equal(verifyAnchor(doc.replace('minute', 'second'), install), false);
  const other = chunk(doc, { maxTokens: 200, count: bytes, splitDepth: 2, docId: 'other.md' });
  assert.notEqual(other[1]!.id, install.id, 'the doc id is part of the chunk id');
  assert.deepEqual(locateQuote(doc, 'It takes a minute.'), { start: doc.indexOf('It takes'), end: doc.indexOf('It takes') + 18, line: 10 });
  assert.equal(locateQuote(doc, 'It   takes\na minute.')?.line, 10, 'white space differences are forgiven');
  assert.equal(locateQuote(doc, 'not in the document'), undefined);
  assert.equal(chunkAt(cs, doc.indexOf('Last words'))?.headingId, 'notes');
});

test('chunking is deterministic and plain text splits on blank lines', () => {
  const t = 'one one one.\n\ntwo two two.\n\n\nthree three.';
  const a = chunk(t, { maxTokens: 15, count: bytes, format: 'text' });
  assert.deepEqual(a, chunk(t, { maxTokens: 15, count: bytes, format: 'text' }));
  assert.deepEqual(a.map((c) => c.text), ['one one one.', 'two two two.', 'three three.']);
  assert.deepEqual(chunk('', { maxTokens: 10 }), []);
  assert.deepEqual(chunk('   \n\n  ', { maxTokens: 10 }), []);
});

test('bad options and oversized documents are refused; the default counter is a token per four bytes', () => {
  assert.throws(() => chunk('x', { maxTokens: 0 }), ChunkError);
  assert.throws(() => chunk('x', { maxTokens: 10, overlapTokens: 10 }), /overlapTokens/);
  assert.throws(() => chunk('x', { maxTokens: 10, minTokens: 11 }), /minTokens/);
  assert.throws(() => chunk('x'.repeat(101), { maxTokens: 10, maxChars: 100 }), /over 100 characters/);
  assert.equal(defaultCounter('abcdefgh'), 2);
  assert.equal(defaultCounter('abcde'), 2);
  assert.equal(defaultCounter(''), 0);
});

test('a long document chunks in reasonable time', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `## Part ${i}\n\nParagraph ${i} with some words in it. Another sentence follows here.`).join('\n\n');
  const t = Date.now();
  const cs = chunk(text, { maxTokens: 80, overlapTokens: 10 });
  assert.equal(cs.length, 2000);
  assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t} ms`);
});
