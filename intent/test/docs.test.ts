import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DIAGRAMS, FACTS, html, LINE_DOCS, mermaid, plan, sitePages, svg, TABLES } from '../tools/docs.ts';

const here = (p: string) => new URL(`../${p}`, import.meta.url);

test('every generated doc and every marked region is fresh', () => {
  const stale = plan().filter(({ path, want }) => !existsSync(here(path)) || readFileSync(here(path), 'utf8') !== want).map((x) => x.path);
  assert.deepEqual(stale, [], 'run: node tools/docs.ts --write');
});

test('every fact, table and diagram computes, and the line has a page at every depth', () => {
  for (const [k, f] of Object.entries(FACTS)) assert.ok(f().length > 0, k);
  for (const [k, f] of Object.entries(TABLES)) assert.match(f(), /^\| .+\|\n\| ---/, k);
  for (const [k, f] of Object.entries(DIAGRAMS)) {
    assert.match(mermaid(f()), /^```mermaid/, k);
    assert.ok(svg(f(), k).length > 50, k);
  }
  const pages = sitePages();
  assert.equal(pages.length, LINE_DOCS.length);
  for (const p of pages) {
    for (const id of ['tldr', 'simply', 'engineer', 'architect']) assert.ok(p.body.includes(`id="${id}"`), `${p.doc} has the ${id} depth`);
    assert.doesNotMatch(p.body, /\{\{|\}\}/, `${p.doc} has no unresolved placeholder`);
  }
});

test('the renderer escapes what it is given', () => {
  const out = html('A <script> and **bold** and [a link](x.md)', (h) => `/to/${h}`, () => 's');
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<a href="\/to\/x.md">a link<\/a>/);
});
