import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepare } from '../src/pipeline.ts';
import { progressHtml, progressLine, stageOf } from '../src/progress.ts';
import { gauges, msFrom, release } from '../src/release.ts';
import { rangeOf, startingRatchets, workingRanges } from '../src/tolerance.ts';
import { answer, history, init, issue, addReading } from '../src/workspace.ts';
import { crc32, zip } from '../src/zip.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const fxPath = (n: string) => new URL(`fixtures/${n}`, import.meta.url).pathname;
const rough = { path: 'rough.md', text: fx('rough.md') };
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];

test('tolerances read as working ranges, and what names no number is said to, never guessed', () => {
  assert.deepEqual(rangeOf('within 100 milliseconds'), { kind: 'time', maxMs: 100 });
  assert.deepEqual(rangeOf('within 1 second on a mid-range phone'), { kind: 'time', maxMs: 1000 });
  assert.deepEqual(rangeOf('nine times in ten'), { kind: 'rate', min: 0.9 });
  assert.deepEqual(rangeOf('nine in ten people'), { kind: 'rate', min: 0.9 });
  assert.deepEqual(rangeOf('95%'), { kind: 'rate', min: 0.95 });
  assert.deepEqual(rangeOf('every time'), { kind: 'rate', min: 1 });
  assert.deepEqual(rangeOf('none in a term'), { kind: 'count', max: 0 });
  assert.deepEqual(rangeOf('at most five'), { kind: 'count', max: 5 });
  assert.deepEqual(rangeOf('fewer than last term'), { kind: 'relative', direction: 'down', against: 'last term' });
  assert.equal(rangeOf('most of the time').kind, 'unread');
  assert.equal(rangeOf(undefined).kind, 'unread');
  assert.equal(msFrom('within 3 seconds'), 3000);
});

test('the working range sets the starting ratchet in the factory\'s shape, and confidence follows how it was established', () => {
  const p = prepare({ files: [rough], readings });
  const w = workingRanges(p.statements);
  assert.ok(w.every((x) => ['firm', 'provisional', 'inherited'].includes(x.confidence)));
  assert.equal(w.find((x) => x.tolerance === 'exactly as stated')?.confidence, 'firm');
  const r = startingRatchets(w);
  assert.ok(r.every((x) => Object.keys(x).join() === 'id,metric,direction,floor'));
  assert.deepEqual(r.find((x) => /every tap/.test(x.metric)), { id: r.find((x) => /every tap/.test(x.metric))!.id, metric: 'visible response to every tap (ms, at most)', direction: 'down', floor: 100 });
  assert.ok(r.some((x) => x.direction === 'down' && x.metric.includes('count, at most') && x.floor === 5));
});

test('gauges come out in the factory\'s card shape, with each forbidden outcome once and phrased as something that happens', () => {
  const g = gauges(prepare({ files: [rough], readings }));
  assert.equal(g.length, 1);
  assert.deepEqual(Object.keys(g[0]!), ['id', 'persona', 'delight', 'phase', 'goal', 'forbidden', 'budget', 'requirements', 'modes', 'channels']);
  assert.equal(g[0]!.persona, 'student');
  assert.ok(g[0]!.forbidden.includes('a message is sent during quiet hours'));
  assert.ok(!g[0]!.forbidden.some((f) => f === 'message during quiet hours'), 'the duplicate phrasing is folded into the derived one');
  assert.ok(g[0]!.forbidden.every((f) => !/the person/.test(f)));
  assert.deepEqual(g[0]!.channels, ['app', 'text']);
});

test('the release is the same bytes every time, every file is hashed in the manifest, and it says plainly when it is not ready', () => {
  const p = prepare({ files: [rough], readings });
  const a = release(p, { revision: 1 });
  assert.deepEqual(a.files, release(p, { revision: 1 }).files);
  const m = JSON.parse(a.files['manifest.json']!);
  assert.deepEqual(Object.keys(m.files).sort(), Object.keys(a.files).filter((f) => f !== 'manifest.json').sort());
  assert.equal(m.ready, false);
  for (const f of ['datum.json', 'schematic.md', 'notes.md', 'control-plan.yaml', 'features.yaml', 'context.md', 'tolerances.json', 'ratchets.json', 'tests/scenarios.test.ts', 'balloons.json', 'knowledge/index.md']) assert.ok(a.files[f], `${f} is in the release`);
  assert.match(a.files['tests/scenarios.test.ts']!, /it\.todo\("\[\d+\] when a bill is paid, then reminders stop"\)/);
  const sk = Object.entries(a.files).find(([k]) => k.startsWith('tests/journeys/'))![1];
  assert.ok(!/^export /m.test(sk), 'a gauge skeleton exports nothing, so the factory reports it unknown, never passed');
});

test('a later revision must say why, and its change notice answers balloon by balloon', () => {
  const p1 = prepare({ files: [rough], readings });
  const r1 = release(p1, { revision: 1 });
  const datum = JSON.parse(r1.files['datum.json']!);
  const prior = JSON.parse(r1.files['balloons.json']!);
  const p2 = prepare({ files: [rough], readings, prior, answers: { 'who-sees': { picks: ['At the college'] } } });
  assert.ok(release(p2, { revision: 2, prior: { revision: 1, datum } }).problems.includes('a revision after the first must say why it was made'));
  const r2 = release(p2, { revision: 2, prior: { revision: 1, datum }, reason: 'staff are at the college' });
  assert.match(r2.files['change-notice.md']!, /\*\*Why:\*\* staff are at the college/);
  assert.match(r2.files['change-notice.md']!, /\*\*\[\d+\] added\*\*: staff at the college are involved/);
});

test('the zip is a valid, deterministic archive of exactly the release files', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  const files = { 'b.txt': 'two', 'a.txt': 'one' };
  const z = zip(files, 'pkg');
  assert.deepEqual(z, zip(files, 'pkg'));
  const text = new TextDecoder('latin1').decode(z);
  assert.ok(text.startsWith('PK\u0003\u0004'));
  assert.ok(text.indexOf('pkg/a.txt') < text.indexOf('pkg/b.txt'), 'names are sorted');
  assert.equal(new DataView(z.buffer).getUint16(z.length - 22 + 10, true), 2);
});

test('the stepper shows where the intent is, as text and as an accessible list with the current step marked', () => {
  const p = prepare({ files: [rough] });
  assert.equal(stageOf(p), 'read');
  assert.equal(stageOf(prepare({ files: [rough], readings })), 'questions');
  assert.match(progressLine('questions'), /^Step 3 of 6: Questions\./);
  const html = progressHtml('questions');
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(html, /<li class="now" aria-current="step"><span class="dot" aria-hidden="true">3<\/span><span class="name">Questions<\/span>/);
  assert.equal((html.match(/class="done"/g) ?? []).length, 2);
});

test('a workspace keeps the work between sittings and issues numbered revisions, refusing one without a reason', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'intent-')), 'ws');
  const ws = init(dir, [fxPath('rough.md')]);
  addReading(ws, fxPath('reading-a.json'));
  addReading(ws, fxPath('reading-b.json'));
  const first = issue(ws);
  assert.equal(first.revision, 1);
  answer(ws, { 'who-sees': { picks: ['At the college'] } });
  assert.throws(() => issue(ws), /must say why/);
  const second = issue(ws, 'staff are at the college');
  assert.equal(second.revision, 2);
  assert.deepEqual(history(ws).map((h) => [h.revision, h.reason]), [
    [1, null],
    [2, 'staff are at the college'],
  ]);
  assert.match(readFileSync(join(second.path, 'change-notice.md'), 'utf8'), /revision 1 to 2/);
});

test('the plain SHA-256 matches the platform\'s, so a browser and a server give the same hashes', async () => {
  const { createHash } = await import('node:crypto');
  const { sha256 } = await import('../src/hash.ts');
  for (const s of ['', 'abc', 'x'.repeat(1000), 'naïve — ünïcode ✓', fx('rough.md')]) assert.equal(sha256(s), createHash('sha256').update(s).digest('hex'));
});

test('the reading request carries the person\'s words and the exact schema, the same for every family but its name', async () => {
  const { readingPrompt } = await import('../src/prompt.ts');
  const p = prepare({ files: [rough] });
  const a = readingPrompt(p.model, 'claude');
  assert.match(a, /"family": "claude"/);
  assert.match(a, /I want students to stop getting their power shut off/);
  assert.equal(a.replace('"claude"', '"x"'), readingPrompt(p.model, 'x'));
});
