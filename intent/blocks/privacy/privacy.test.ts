import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzip } from '../docparse/index.ts';
import { Privacy, tableSource } from './index.ts';

const setup = () => {
  const files = [{ owner: 'ana', name: 'plan.pdf' }, { owner: 'ben', name: 'x' }, { owner: 'ana', name: 'photo.jpg' }];
  const invoices = [{ who: 'ana', total: 1000, year: 2026 }, { who: 'ana', total: 500, year: 2019 }];
  const p = new Privacy(() => new Date('2026-11-26T12:00:00Z'));
  p.register(tableSource('files', 'Files you uploaded', files, 'owner'));
  p.register(tableSource('invoices', 'Invoices and payments', invoices, 'who', { when: (r) => (r.year as number) >= 2020, why: 'tax law requires invoices for seven years', until: '2033-12-31' }));
  return { p, files, invoices };
};

test('the export holds every source, a manifest and a readable summary', async () => {
  const { p } = setup();
  p.register({ name: 'broken', description: 'Comments', export: async () => { throw new Error('store offline'); }, erase: async () => ({ removed: 0 }) });
  const { archive, manifest } = await p.export('ana');
  const z = unzip(archive);
  assert.deepEqual([...z.keys()].sort(), ['README.txt', 'files.json', 'invoices.json', 'manifest.json']);
  assert.deepEqual(JSON.parse(z.get('files.json')!.toString()).map((r: { name: string }) => r.name), ['plan.pdf', 'photo.jpg']);
  assert.deepEqual(manifest.sources.map((s) => [s.name, s.records, s.error]), [['files', 2, undefined], ['invoices', 2, undefined], ['broken', 0, 'store offline']]);
  assert.match(z.get('README.txt')!.toString(), /Comments: could not be exported \(store offline\)/);
  assert.equal(JSON.stringify(manifest).includes('ben'), false);
});

test('erasure reports what was removed, what was kept and why, and is complete only if every source succeeded', async () => {
  const { p, files, invoices } = setup();
  const e = await p.erase('ana');
  assert.equal(e.complete, true);
  assert.deepEqual(e.sources, [{ name: 'files', removed: 2 }, { name: 'invoices', removed: 1, kept: { count: 1, why: 'tax law requires invoices for seven years', until: '2033-12-31' } }]);
  assert.deepEqual(files.map((f) => f.owner), ['ben']);
  assert.deepEqual(invoices.map((i) => i.year), [2026]);
  p.register({ name: 'search', description: 'Search index', export: async () => [], erase: async () => { throw new Error('index locked'); } });
  const again = await p.erase('ana');
  assert.equal(again.complete, false);
  assert.equal(again.sources.at(-1)!.error, 'index locked');
  assert.throws(() => p.register(tableSource('files', '', [], 'x')), /already registered/);
});
