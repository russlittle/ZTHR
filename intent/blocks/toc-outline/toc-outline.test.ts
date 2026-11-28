import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from '../markdown/index.ts';
import { countWords, excerpt, headingAtLine, outline, readingTime, sections, stableAnchors, tocHtml, tocMarkdown } from './index.ts';

const DOC = '# Guide\n\nIntro text.\n\n## Install\n\nSteps.\n\n### Linux\n\nx\n\n### macOS\n\ny\n\n## Use\n\nz\n\n## Install\n\nagain\n';

test('the outline nests headings by level, in document order, with positions', () => {
  const o = outline(DOC);
  assert.deepEqual(o.headings.map((h) => h.text), ['Guide']);
  assert.deepEqual(o.headings[0]!.children.map((h) => h.text), ['Install', 'Use', 'Install']);
  assert.deepEqual(o.headings[0]!.children[0]!.children.map((h) => h.text), ['Linux', 'macOS']);
  assert.deepEqual(o.flat.map((h) => h.depth), [1, 2, 3, 3, 2, 2]);
  assert.deepEqual(o.flat[2]!.position!.start, { line: 9, column: 1 });
  assert.deepEqual(o.lint.map((l) => l.code), ['duplicate-text']);
});

test('heading text is the plain text, not the markup', () => {
  const o = outline('# The *big* `idea` [link](/x) &amp; more\n');
  assert.equal(o.flat[0]!.text, 'The big idea link & more');
  assert.equal(o.flat[0]!.id, 'the-big-idea-link--more');
});

test('skipped levels, several titles, no title and empty headings are reported; the tree still nests sensibly', () => {
  const o = outline('# One\n\n### Deep\n\n# Two\n\n##\n');
  assert.deepEqual(o.lint.map((l) => l.code), ['many-titles', 'skipped-level', 'empty-heading']);
  assert.equal(o.lint.find((l) => l.code === 'skipped-level')!.heading, 'Deep');
  assert.deepEqual(o.headings.map((h) => [h.text, h.children.map((c) => c.text)]), [['One', ['Deep']], ['Two', ['']]]);
  assert.deepEqual(outline('## Only second\n').lint.map((l) => l.code), ['no-title']);
  assert.deepEqual(outline('plain text only\n').lint, []);
  assert.deepEqual(outline('').flat, []);
});

test('depth limits drop headings from the outline but not from the id numbering', () => {
  const o = outline(DOC, { minDepth: 2, maxDepth: 2 });
  assert.deepEqual(o.flat.map((h) => h.id), ['install', 'use', 'install-1']);
  assert.deepEqual(o.headings.map((h) => h.children.length), [0, 0, 0]);
});

test('anchors are unique, and a repeated text gets the next suffix', () => {
  const o = outline('# A\n## B\n## B\n## B\n');
  assert.deepEqual(o.flat.map((h) => h.id), ['a', 'b', 'b-1', 'b-2']);
});

test('anchors stay put when the document is edited: inserting an earlier twin does not take over an older id', () => {
  const v1 = outline('# T\n## Setup\n## Setup\n');
  assert.deepEqual(v1.flat.map((h) => h.id), ['t', 'setup', 'setup-1']);
  const v2 = outline('# T\n## Setup\n## New part\n## Setup\n', { previous: v1.anchors.anchors });
  assert.deepEqual(v2.flat.map((h) => [h.text, h.id]), [['T', 't'], ['Setup', 'setup'], ['New part', 'new-part'], ['Setup', 'setup-1']]);
  const v3 = outline('## Setup\n# T\n## Setup\n', { previous: v1.anchors.anchors });
  assert.deepEqual(v3.flat.map((h) => h.id), ['setup', 't', 'setup-1'], 'matched by text and order, not by position');
});

test('a new heading never inherits an id a previous heading used; a renamed one redirects its old id', () => {
  const prev = [{ id: 'intro', text: 'Intro' }, { id: 'setup', text: 'Setup' }, { id: 'faq', text: 'FAQ' }];
  const r = stableAnchors([{ text: 'Intro' }, { text: 'Installation' }, { text: 'FAQ' }], prev);
  assert.deepEqual(r.anchors.map((a) => a.id), ['intro', 'installation', 'faq']);
  assert.deepEqual(r.redirects, [{ from: 'setup', to: 'installation' }]);
  const removed = stableAnchors([{ text: 'Intro' }, { text: 'FAQ' }], prev);
  assert.deepEqual(removed.redirects, [{ from: 'setup', to: undefined }]);
  const same = stableAnchors([{ text: 'Intro' }, { text: 'Setup' }, { text: 'FAQ' }], prev);
  assert.deepEqual(same.redirects, []);
});

test('the table of contents is escaped HTML or Markdown, nested, and limited by depth', () => {
  const o = outline('# Top\n## A & B "q" <i>\n### Deep\n## Next\n');
  assert.equal(tocHtml(o.headings), '<ul><li><a href="#top">Top</a><ul><li><a href="#a--b-q">A &amp; B &quot;q&quot;</a><ul><li><a href="#deep">Deep</a></li></ul></li><li><a href="#next">Next</a></li></ul></li></ul>');
  assert.equal(tocHtml(o.headings, { maxDepth: 2, ordered: true, base: '/docs/x' }), '<ol><li><a href="/docs/x#top">Top</a><ol><li><a href="/docs/x#a--b-q">A &amp; B &quot;q&quot;</a></li><li><a href="/docs/x#next">Next</a></li></ol></li></ol>');
  assert.equal(tocMarkdown(o.headings, { maxDepth: 2 }), '- [Top](#top)\n  - [A & B "q"](#a--b-q)\n  - [Next](#next)');
  assert.equal(tocHtml([]), '');
  const evil = outline('# "><script>alert(1)</script>\n');
  assert.ok(!tocHtml(evil.headings).includes('<script>'));
});

test('word counting: Unicode words, CJK by character, numbers and apostrophes', () => {
  assert.deepEqual(countWords("Don't panic: it's 42 words, maybe."), { words: 6, cjk: 0 });
  assert.deepEqual(countWords('日本語のテキスト'), { words: 0, cjk: 8 });
  assert.deepEqual(countWords('naïve café Ünïcode'), { words: 3, cjk: 0 });
  assert.deepEqual(countWords('--- *** ...'), { words: 0, cjk: 0 });
});

test('reading time: prose at 230 wpm, code at half speed, images cost seconds, at least one minute', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
  assert.deepEqual([readingTime('hello there').minutes, readingTime('hello there').label], [1, '1 min read']);
  const r = readingTime(`# T\n\n${words(460)}\n`);
  assert.deepEqual([r.words, r.seconds, r.minutes], [461, 120, 2]);
  const code = readingTime(`\`\`\`\n${words(115)}\n\`\`\`\n`);
  assert.deepEqual([code.codeWords, code.words, code.seconds], [115, 0, 60]);
  const imgs = readingTime('![a](/a.png) ![b](/b.png) ![c](/c.png)');
  assert.deepEqual([imgs.images, imgs.seconds], [3, 12 + 11 + 10]);
  const many = readingTime(Array.from({ length: 20 }, (_, i) => `![i${i}](/i.png)`).join('\n\n'));
  assert.equal(many.seconds, 12 + 11 + 10 + 9 + 8 + 7 + 6 + 5 + 4 + 3 * 11, 'the cost falls to 3 s and stays');
  const slow = readingTime(words(100), { wordsPerMinute: 100 });
  assert.equal(slow.seconds, 60);
  const cjk = readingTime('日本語'.repeat(150), { cjkPerMinute: 450 });
  assert.deepEqual([cjk.words, cjk.seconds, cjk.minutes], [450, 60, 1]);
});

test('an excerpt is the opening prose as plain text, without headings, code, tables or html', () => {
  const md = '# Title\n\n<div>raw</div>\n\n```\ncode\n```\n\nFirst *para* with [a link](/x) and `code`.\n\n| a |\n| - |\n| 1 |\n\nSecond paragraph.\n';
  assert.equal(excerpt(md), 'First para with a link and code. Second paragraph.');
  assert.equal(excerpt('# Only a heading\n'), '');
  assert.equal(excerpt('> quoted *words*\n\n- item one\n- item two\n'), 'quoted words item one\nitem two'.replace('\n', ' '));
});

test('an excerpt cuts at a sentence, else at a word, else at a character, never inside one, and honours <!--more-->', () => {
  const long = 'This is the first sentence of the post. This is the second one which keeps going and going and going and going on.';
  assert.equal(excerpt(long, { maxChars: 60 }), 'This is the first sentence of the post.');
  assert.equal(excerpt('alpha beta gamma delta epsilon zeta eta theta', { maxChars: 25 }), 'alpha beta gamma delta…');
  assert.equal(excerpt('abcdefghijklmnopqrstuvwxyz', { maxChars: 10 }), 'abcdefghij…');
  assert.equal(excerpt('\u{1F468}‍\u{1F469}‍\u{1F467}'.repeat(10), { maxChars: 3, ellipsis: '' }), '\u{1F468}‍\u{1F469}‍\u{1F467}'.repeat(3), 'a family emoji is one character');
  assert.equal(excerpt('Before the break.\n\n<!--more-->\n\nAfter the break.'), 'Before the break.');
  assert.equal(excerpt('short', { maxChars: 100 }), 'short');
});

test('sections give each heading its line range and the words that belong to it', () => {
  const s = sections(DOC);
  assert.deepEqual(s.map((x) => [x.heading.text, x.lines.from, x.lines.to, x.words]), [
    ['Guide', 1, 23, 7], ['Install', 5, 16, 3], ['Linux', 9, 12, 1], ['macOS', 13, 16, 1], ['Use', 17, 20, 1], ['Install', 21, 23, 1],
  ]);
});

test('the heading at a source line, for a "you are here" marker', () => {
  const o = outline(DOC);
  assert.equal(headingAtLine(o, 1)!.text, 'Guide');
  assert.equal(headingAtLine(o, 7)!.text, 'Install');
  assert.equal(headingAtLine(o, 10)!.text, 'Linux');
  assert.equal(headingAtLine(o, 100)!.text, 'Install');
  assert.equal(headingAtLine(outline('text\n\n# Late\n'), 1), undefined);
  assert.deepEqual(outline(parse(DOC)).flat.map((h) => h.id), o.flat.map((h) => h.id), 'a tree gives the same outline as its source');
});
