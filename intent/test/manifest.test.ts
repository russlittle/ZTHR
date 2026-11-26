import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { manifest } from '../src/manifest.ts';
import { prepare } from '../src/pipeline.ts';
import { release } from '../src/release.ts';

const fx = (n: string) => readFileSync(new URL(`fixtures/${n}`, import.meta.url), 'utf8');
const files = [{ path: 'rough.md', text: fx('rough.md') }];
const readings = [JSON.parse(fx('reading-a.json')), JSON.parse(fx('reading-b.json'))];

test('the manifest is a bill of materials: every line traced, sourced and numbered in build order', () => {
  const m = manifest(prepare({ files, readings }));
  assert.ok(m.lines.length > 20);
  assert.deepEqual(m.lines.map((l) => l.find), m.lines.map((_, i) => i + 1));
  for (const l of m.lines) {
    assert.ok(l.why.length, `${l.part} says why it is there`);
    assert.ok(l.floor || l.balloons.length, `${l.part} is on the floor or traced to a balloon`);
    if (l.source === 'stock' || l.source === 'modify') assert.ok(l.library.length, `${l.part} names the library block it comes from`);
    if (l.source === 'make: new') assert.ok(l.uses.every((f) => m.lines[f - 1]!.source !== 'make: new'), 'a feature is assembled from parts');
  }
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, m.lines.length);
});

test('every outcome is made new, assembled from the parts that build its balloons', () => {
  const p = prepare({ files, readings });
  const m = manifest(p);
  for (const o of p.statements.filter((s) => s.slot === 'outcome')) {
    const f = m.lines.find((l) => l.source === 'make: new' && l.balloons.includes(o.balloon));
    assert.ok(f, `outcome ${o.balloon} has a feature`);
  }
});

test('the drawing and the manifest match: every balloon is built, or left out or taken as given on purpose', () => {
  const m = manifest(prepare({ files, readings }));
  for (const t of m.trace) assert.ok(t.by.length || t.note || m.gaps.some((g) => g.balloon === t.balloon), `balloon ${t.balloon} is accounted for`);
});

test('the same drawing gives the same manifest, and the release carries it', () => {
  const a = manifest(prepare({ files, readings }));
  const b = manifest(prepare({ files, readings }));
  assert.deepEqual(a, b);
  const r = release(prepare({ files, readings }), { revision: 1 });
  const j = JSON.parse(r.files['build-manifest.json']!);
  assert.equal(j.schema, 'zthr-build-manifest/1');
  assert.equal(j.lines.length, a.lines.length);
  assert.ok(JSON.parse(r.files['manifest.json']!).files['build-manifest.json'], 'the build manifest is hashed with the package');
});

test('planted: a part the catalogue does not hold can never reach a manifest', async () => {
  const src = readFileSync(new URL('../src/manifest.ts', import.meta.url), 'utf8');
  const names = [...src.matchAll(/parts: \[([^\]]+)\]/g)].flatMap((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
  const m = manifest(prepare({ files, readings }));
  assert.ok(names.length > 40);
  // Every name the rules call for is checked against the catalogue as the manifest is made; one that is not
  // there throws rather than appearing as a line nobody can build.
  assert.ok(m.lines.every((l) => l.source === 'make: new' || names.includes(l.part)));
});

test('planted: an outcome no part builds still appears, as a feature to make, never silently dropped', () => {
  const text = '# Odd\n\n## The end in mind\n\nPeople keep their bees alive.\n\n## What I want\n\n- Hives are checked every week\n';
  const m = manifest(prepare({ files: [{ path: 'odd.md', text }] }));
  assert.ok(m.lines.some((l) => l.source === 'make: new' && /Hives are checked/.test(l.part)));
});
