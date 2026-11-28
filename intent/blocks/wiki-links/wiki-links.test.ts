import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LinkGraph, MAX_PAGE, WikiLinkError, applyRename, parseLinks, planRename, titleKey, type Page } from './index.ts';

test('every link form parses with its target, heading, label, embed flag and line', () => {
  const l = parseLinks('See [[Home]], [[Home|the start]], [[Home#Setup]], [[Home#Setup|setup]], [[#Local]].\n![[Diagram]]');
  assert.deepEqual(l.map((x) => [x.target, x.heading, x.label, x.embed, x.line]), [
    ['Home', undefined, undefined, false, 1],
    ['Home', undefined, 'the start', false, 1],
    ['Home', 'Setup', undefined, false, 1],
    ['Home', 'Setup', 'setup', false, 1],
    ['', 'Local', undefined, false, 1],
    ['Diagram', undefined, undefined, true, 2],
  ]);
  assert.equal(l[0]!.raw, '[[Home]]');
  assert.equal('See [[Home]]'.slice(l[0]!.start, l[0]!.end), '[[Home]]');
});

test('escaped, empty, multi-line and code links are not links', () => {
  assert.deepEqual(parseLinks('\\[[Nope]] and [[]] and [[ | x ]] and [[a\nb]]'), []);
  assert.equal(parseLinks('\\\\[[Double]]').length, 1, 'an escaped backslash does not escape the bracket');
  const src = 'Real [[One]].\n\n```\n[[Fenced]]\n```\n\n    [[Indented]]\n\nInline `[[Span]]` and ``[[Two ` ticks]]`` end [[Two]].';
  assert.deepEqual(parseLinks(src).map((x) => x.target), ['One', 'Two']);
});

test('hostile input: oversized pages, huge links and bracket floods stay bounded', () => {
  assert.throws(() => parseLinks('x'.repeat(MAX_PAGE + 1)), WikiLinkError);
  assert.deepEqual(parseLinks(`[[${'a'.repeat(301)}]]`), []);
  assert.equal(parseLinks(`[[${'a'.repeat(300)}]]`).length, 1);
  const t = Date.now();
  assert.deepEqual(parseLinks('[['.repeat(50_000)), []);
  assert.ok(Date.now() - t < 2000, 'no runaway matching');
});

test('titles compare without case, spacing, underscores or compatibility forms', () => {
  assert.equal(titleKey('  Project_Plan  '), titleKey('project   plan'));
  assert.equal(titleKey('Ｃafé'), titleKey('café'));
  assert.notEqual(titleKey('Plan A'), titleKey('Plan B'));
});

const pages: Page[] = [
  { id: 'home', title: 'Home', body: '# Home\n\nStart at [[Project Plan]] or [[projectplan]]. See [[Glossary#Terms]] and [[Glossary#Nope]].' },
  { id: 'plan', title: 'Project Plan', aliases: ['Roadmap'], body: '# Project Plan\n\n## Goals\n\nBack to [[home]]. Also [[Roadmap]] and [[#Goals]] and [[#Missing]].' },
  { id: 'gloss', title: 'Glossary', body: '# Glossary\n\n## Terms\n\nSee [[Project Plan#Goals|goals]].\n' },
  { id: 'lonely', title: 'Lonely Page', body: 'Links to [[Ghost]] only.' },
  { id: 'twin1', title: 'Twin', body: 'one' },
  { id: 'twin2', title: 'twin', body: 'two [[Twin]]' },
];

test('the graph resolves titles and aliases, and each link knows whether its heading exists', () => {
  const g = new LinkGraph(pages);
  const home = g.outgoing('home').map((r) => [r.link.target, r.resolution.status, r.anchorOk]);
  assert.deepEqual(home, [['Project Plan', 'ok', undefined], ['projectplan', 'missing', undefined], ['Glossary', 'ok', true], ['Glossary', 'ok', false]]);
  assert.deepEqual(g.resolve('roadmap'), { status: 'ok', page: 'plan' });
  assert.deepEqual(g.resolve('TWIN'), { status: 'ambiguous', pages: ['twin1', 'twin2'] });
  assert.deepEqual(g.outgoing('plan').filter((r) => r.link.target === '').map((r) => r.anchorOk), [true, false]);
});

test('backlinks list who links here with the line and context, and skip self-links', () => {
  const g = new LinkGraph(pages);
  const b = g.backlinks('plan');
  assert.deepEqual(b.map((x) => [x.from, x.line]), [['home', 3], ['gloss', 5]]);
  assert.match(b[0]!.context, /^Start at \[\[Project Plan\]\]/);
  assert.deepEqual(g.backlinks('home').map((x) => x.from), ['plan']);
  assert.equal(g.backlinks('lonely').length, 0);
});

test('orphans are pages nothing else links to, and entry pages can be excused', () => {
  const g = new LinkGraph(pages);
  assert.deepEqual(g.orphans(), ['lonely', 'twin1', 'twin2']);
  assert.deepEqual(g.orphans(['lonely']), ['twin1', 'twin2']);
  assert.equal(new LinkGraph([{ id: 'a', title: 'A', body: 'see [[A]]' }]).orphans().length, 1, 'a link to itself does not rescue a page');
});

test('broken links: missing page with near-match suggestions, missing heading, ambiguous title', () => {
  const g = new LinkGraph(pages);
  const by = (reason: string) => g.broken().filter((b) => b.reason === reason).map((b) => `${b.from}:${b.line}:${b.raw}`);
  assert.deepEqual(by('missing page'), ['home:3:[[projectplan]]', 'lonely:1:[[Ghost]]']);
  assert.deepEqual(by('missing heading'), ['home:3:[[Glossary#Nope]]', 'plan:5:[[#Missing]]']);
  assert.deepEqual(by('ambiguous title'), ['twin2:1:[[Twin]]']);
  assert.deepEqual(g.broken().find((b) => b.raw === '[[projectplan]]')!.suggestions, ['Project Plan']);
  assert.deepEqual(g.broken().find((b) => b.raw === '[[Ghost]]')!.suggestions, []);
});

test('health sums up pages, links, orphans, broken links and duplicate titles', () => {
  const h = new LinkGraph(pages).health({ entryPages: ['home'] });
  assert.equal(h.pages, 6);
  assert.equal(h.links, 4 + 4 + 1 + 1 + 0 + 1);
  assert.deepEqual(h.orphans, ['lonely', 'twin1', 'twin2']);
  assert.equal(h.broken.length, 5);
  assert.deepEqual(h.ambiguousTitles, [{ title: 'twin', pages: ['twin1', 'twin2'] }]);
  assert.throws(() => new LinkGraph([pages[0]!, pages[0]!]), /same id|two pages/);
});

test('rename rewrites links, keeps headings and labels, preserves what readers see, and leaves code alone', () => {
  const ps: Page[] = [
    { id: 'a', title: 'Old Name', body: '# Old Name\n\n## Sec\n\nSelf [[old name#Sec]].' },
    { id: 'b', title: 'B', body: 'x [[Old Name]] y [[old_name|custom]] z [[Old Name#Sec]] ![[Old Name]] `[[Old Name]]`\n```\n[[Old Name]]\n```' },
    { id: 'c', title: 'C', body: 'nothing here [[B]]' },
  ];
  const plan = planRename(ps, 'a', 'New Name');
  assert.equal(plan.page.title, 'New Name');
  assert.equal(plan.page.body, '# Old Name\n\n## Sec\n\nSelf [[New Name#Sec|old name]].');
  assert.deepEqual(plan.edits.map((e) => [e.pageId, e.rewritten]), [['b', 4]]);
  assert.equal(plan.edits[0]!.body, 'x [[New Name|Old Name]] y [[New Name|custom]] z [[New Name#Sec|Old Name]] ![[New Name|Old Name]] `[[Old Name]]`\n```\n[[Old Name]]\n```');
  const after = applyRename(ps, plan);
  assert.equal(after[1]!.body, plan.edits[0]!.body);
  assert.equal(after[2], ps[2], 'untouched pages are the same object');
  assert.equal(new LinkGraph(after).broken().length, 0);
});

test('rename without keepDisplay changes the visible text; an alias keeps old titles resolving', () => {
  const ps: Page[] = [{ id: 'a', title: 'Old', body: '' }, { id: 'b', title: 'B', body: 'see [[Old]] and [[old]]' }];
  const plan = planRename(ps, 'a', 'New', { keepDisplay: false, keepOldAsAlias: true });
  assert.equal(plan.edits[0]!.body, 'see [[New]] and [[New]]');
  assert.deepEqual(plan.page.aliases, ['Old']);
  assert.deepEqual(new LinkGraph(applyRename(ps, plan)).resolve('Old'), { status: 'ok', page: 'a' });
});

test('links that reach a page by an alias are left alone, and ambiguous ones are reported, not guessed', () => {
  const ps: Page[] = [
    { id: 'a', title: 'Alpha', aliases: ['A'], body: '' },
    { id: 'b', title: 'B', body: '[[A]] and [[Alpha]]' },
    { id: 'c', title: 'Gamma', body: '' },
    { id: 'd', title: 'gamma', body: '[[Gamma]]' },
  ];
  const plan = planRename(ps, 'a', 'Omega');
  assert.equal(plan.edits[0]!.body, '[[A]] and [[Omega|Alpha]]');
  const p2 = planRename(ps, 'c', 'Delta');
  assert.deepEqual(p2.edits, []);
  assert.deepEqual(p2.skipped, [{ pageId: 'd', line: 1, raw: '[[Gamma]]' }]);
});

test('rename refuses clashing, empty and unsafe titles and unknown pages', () => {
  const ps: Page[] = [{ id: 'a', title: 'A', body: '' }, { id: 'b', title: 'B', aliases: ['Bee'], body: '' }];
  assert.throws(() => planRename(ps, 'a', 'b'), /already the title of page b/);
  assert.throws(() => planRename(ps, 'a', 'BEE'), /already the title/);
  assert.throws(() => planRename(ps, 'a', '  '), WikiLinkError);
  assert.throws(() => planRename(ps, 'a', 'x]]y'), /cannot be empty or contain/);
  assert.throws(() => planRename(ps, 'a', 'x|y'), WikiLinkError);
  assert.throws(() => planRename(ps, 'zzz', 'Q'), /no page zzz/);
  assert.equal(planRename(ps, 'a', '  A   Prime ').page.title, 'A Prime');
});
