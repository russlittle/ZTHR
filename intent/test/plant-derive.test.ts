import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEPARTMENTS, handoff, lineBar, nextDept } from '../src/console/line.ts';
import { AREAS, FLOWS, GLOSSARY, GROUPS, WORK_PATH, area, pageHref, stepOf } from '../src/console/plant-model.ts';
import { factoryFlow, STAGES } from '../src/console/pipeline.ts';
import { LINE_DOCS, DIAGRAMS, FACTS, TABLES, mermaid } from '../tools/docs.ts';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p: string) => readFileSync(join(HERE, p), 'utf8');

test('the bar is the model: every area, in the model’s order and groups, with no step for the front office or the crews', () => {
  const bar = lineBar(null);
  const hrefs = [...bar.matchAll(/<a href="([^"]+)"[^>]* data-dept="(\w+)"/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(hrefs.map(([k]) => k), AREAS.map((a) => a.key), 'one link per area, in the model’s order');
  assert.deepEqual(hrefs.map(([, h]) => h), AREAS.map(pageHref));
  const heads = [...bar.matchAll(/<span class="zg-h">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(heads, GROUPS.map((g) => g.label), 'the groups, by name and order');
  assert.deepEqual(heads, ['Front office', 'Engineering', 'The line', 'The field', 'Support']);
  for (const a of AREAS) {
    const numbered = new RegExp(`data-dept="${a.key}"[^>]*>(?:<span class="zl-n" aria-hidden="true">(\\d+)</span>)`).exec(bar);
    assert.equal(numbered ? Number(numbered[1]) : null, stepOf(a.key), `${a.key} carries its step from the model`);
    if (a.group === 'office' || a.group === 'support') assert.equal(stepOf(a.key), null, `${a.key} has no step`);
  }
  assert.deepEqual(AREAS.filter((a) => stepOf(a.key) !== null).map((a) => a.key), ['design', 'process', 'factory', 'qa', 'shipping', 'fleet']);
  assert.match(bar, /href="\/plant\/"/, 'the plant is one click from every page');
  assert.match(bar, /Plant<\/a>/);
  assert.doesNotMatch(bar, /beneath|serving every department|zl-beneath/);
  assert.match(lineBar('plant'), /href="\/plant\/" aria-current="page"/);
  assert.match(bar, /Product lines[\s\S]*?inside Mission control/, 'product lines sit inside mission control');
  assert.match(bar, /Intent studio[\s\S]*?inside Product lines/, 'the intent studio sits inside its product line');
});

test('the departments the code uses are the areas of the model, and handoffs follow the flows that carry work', () => {
  assert.deepEqual(DEPARTMENTS.map((d) => d.key), AREAS.map((a) => a.key));
  for (const d of DEPARTMENTS) {
    const next = nextDept(d.key);
    const flow = FLOWS.find((f) => f.from === d.key && (f.kind === 'work' || f.kind === 'air'));
    assert.equal(next?.key ?? null, flow?.to ?? null, `${d.key}: the next area is where its flow goes`);
  }
  assert.equal(nextDept('mission'), null, 'mission control runs the plant; no work step follows it');
  assert.equal(nextDept('lines'), null);
  assert.equal(handoff('mission', true, 'x'), '');
  assert.equal(nextDept('qa')?.key, 'shipping');
  assert.equal(nextDept('rework')?.key, 'qa', 'rework goes back through QA');
  assert.match(handoff('design', true, 'why'), /Next: Manufacturing engineering/);
  assert.deepEqual(WORK_PATH, ['intent', 'design', 'process', 'factory', 'qa', 'shipping', 'fleet']);
});

test('every area has a page, a doc source and a generated doc, and the docs are the areas', () => {
  const pages = [...new Set(AREAS.map((a) => a.page))];
  assert.deepEqual(LINE_DOCS, ['index', ...pages, 'architecture', 'standards']);
  for (const a of AREAS) {
    assert.ok(existsSync(join(HERE, `docs/src/line/${a.page}.md`)), `${a.key} has a doc source`);
    assert.ok(existsSync(join(HERE, `docs/line/${a.page}.md`)), `${a.key} has a generated doc`);
    const hasPage = ['intent', 'engineering'].includes(a.page) ? existsSync(join(HERE, 'studio/index.html')) : existsSync(join(HERE, `site/${a.page}.html`));
    assert.ok(hasPage, `${a.key} has a page`);
  }
  assert.ok(!existsSync(join(HERE, 'docs/src/line/plant.md')), 'plant means one thing: the plant, not a map of standards');
  assert.match(read('docs/line/standards.md'), /# The standards map/);
});

test('the docs draw the plant from the model: the areas, the flows, the support crews and each area’s discipline', () => {
  const index = read('docs/line/README.md');
  for (const a of AREAS) assert.ok(index.includes(`[${a.label}](${a.page}.md)`) || index.includes(a.label), `${a.label} is in the index`);
  for (const f of FLOWS) assert.ok(index.includes(`| ${area(f.from).label} | ${area(f.to).label} | ${f.carries} |`), `${f.from} to ${f.to} is in the handoffs`);
  const diagram = mermaid(DIAGRAMS['plant-flow']!());
  for (const a of AREAS) assert.ok(diagram.includes(a.label), `${a.label} is in the plant diagram`);
  assert.match(diagram, /qa -\.->\|Failed product and its evidence\| rework/, 'the rework loop');
  assert.match(diagram, /rework -->\|Fixed product\| qa/);
  assert.match(diagram, /fleet -\.->\|What the field shows\| mission_g/, 'the field report loop');
  assert.match(diagram, /shipping ==>\|over the air: Signed release, over the air\| fleet/, 'updates over the air');
  assert.match(index, /```mermaid\nflowchart LR/);
  const standards = read('docs/line/standards.md');
  for (const a of AREAS) assert.ok(standards.includes(`| ${a.label} | ${a.discipline} | ${a.standard} |`), `${a.label}: its discipline and standard are listed`);
  assert.equal(FACTS['area.count']!(), String(AREAS.length));
  assert.equal(TABLES['support']!().split('\n').length - 2, AREAS.filter((a) => a.group === 'support').length);
});

test('one word per idea: no doc, page or console text uses a name the plant retired', () => {
  const files = [
    ...readdirSync(join(HERE, 'docs/src/line')).map((f) => `docs/src/line/${f}`),
    ...readdirSync(join(HERE, 'site')).filter((f) => f.endsWith('.html') && f !== 'plant.html').map((f) => `site/${f}`),
    ...readdirSync(join(HERE, 'src/console')).filter((f) => f.endsWith('.ts')).filter((f) => f !== 'plant-model.ts').map((f) => `src/console/${f}`),
    'README.md',
  ];
  const retired: [RegExp, string][] = [
    [/beneath (?:the|every) (?:line|department)/i, 'beneath the line'],
    [/serv(?:e|ing) every (?:department|station)/i, 'serving every department'],
    [/\ba reader, never a writer\b/i, 'a reader, never a writer'],
    [/\bsigned schematic\b/i, 'signed schematic (a signed intent package)'],
    [/\breleased package\b/i, 'released package (the build package, or the product spec)'],
    [/\bdepartments?\b/i, 'department (an area)'],
  ];
  for (const f of files) {
    const text = read(f).replace(/`[^`]*`/g, '');
    for (const [re, name] of retired) {
      const ts = f.endsWith('.ts');
      // In code, Department/DEPARTMENTS are identifiers; only the prose word is retired.
      const re2 = ts && /department/.test(re.source) ? /\bdepartments?\b/ : re;
      assert.doesNotMatch(text, re2, `${f} says "${name}"`);
    }
  }
  for (const g of GLOSSARY) for (const never of g.never) for (const f of files.filter((x) => x.endsWith('.md'))) assert.ok(!read(f).toLowerCase().includes(never), `${f} uses "${never}", not "${g.term}"`);
});

test('the site is built from the model: every page carries the bar the model draws, and the new areas have pages', () => {
  const out = mkdtempSync(join(tmpdir(), 'zthr-site-'));
  try {
    execFileSync('node', ['tools/build-site.ts', '--out', out, '--open'], { cwd: HERE, stdio: 'pipe' });
    const bar = (current: string) => lineBar(current as never);
    for (const a of AREAS) {
      const html = readFileSync(join(out, a.page, 'index.html'), 'utf8');
      const hasBar = html.includes(bar(a.key).slice(0, bar(a.key).indexOf('aria-current')).slice(0, 200));
      assert.ok(hasBar && html.includes('class="zgroups"'), `/${a.page} carries the bar`);
      assert.ok(existsSync(join(out, 'line', a.page === 'engineering' ? 'engineering' : a.page, 'index.html')), `/line/${a.page}/ is built`);
      if (!['intent', 'engineering'].includes(a.page)) assert.match(html, /id="h-needs"/, `/${a.page} ends with what the area needs`);
    }
    for (const page of ['process', 'rework', 'deployment']) {
      const html = readFileSync(join(out, page, 'index.html'), 'utf8');
      assert.match(html, /not (?:measured|built) yet/i, `/${page} says what is not measured or built`);
      assert.ok(existsSync(join(out, page, 'app.js')), `/${page} has its script`);
    }
    const plant = readFileSync(join(out, 'plant', 'index.html'), 'utf8');
    assert.match(plant, /class="zgroups"/);
    assert.match(plant, /aria-current="page"/);
    assert.ok(existsSync(join(out, 'line', 'standards', 'index.html')));
    assert.ok(!existsSync(join(out, 'line', 'plant')), 'the old "plant" doc is gone');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the stations a flow reports are the areas that have one', () => {
  assert.deepEqual(STAGES.map((s) => s.key), AREAS.filter((a) => a.station).map((a) => a.station));
  assert.deepEqual(STAGES.map((s) => s.href), AREAS.filter((a) => a.station).map(pageHref));
  assert.equal(typeof factoryFlow, 'function');
});
