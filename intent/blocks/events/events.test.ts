import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalogue, Hub, Presence, sse } from './index.ts';

const cat = new Catalogue([{ type: 'files.file.created', version: 1, owner: 'files', description: 'A file was uploaded', fields: { path: 'string', size: 'number' } }]);

test('only catalogued events with the declared fields are made, in CloudEvents form', () => {
  const e = cat.make('/files', 'files.file.created', { path: '/a.txt', size: 3 }, { subject: 'u1' });
  assert.equal(e.specversion, '1.0');
  assert.equal(e.dataschema, 'urn:zthr:events:files.file.created:v1');
  assert.throws(() => cat.make('/files', 'files.file.renamed', {}), /not in the event catalogue/);
  assert.throws(() => cat.make('/files', 'files.file.created', { path: '/a' }), /size must be a number/);
  assert.throws(() => new Catalogue([{ type: 'FileCreated', version: 1, owner: '', description: '', fields: {} }]), /lower-case and dotted/);
  assert.match(sse(e, 7), /^id: 7\nevent: files\.file\.created\ndata: \{/);
});

test('a reconnecting client catches up from its last id, and knows when it missed some', () => {
  const hub = new Hub(3);
  const ev = () => cat.make('/files', 'files.file.created', { path: '/x', size: 1 });
  const got: number[] = [];
  const s = hub.subscribe(() => true, (_e, seq) => void got.push(seq));
  hub.subscribe(() => true, () => {
    throw new Error('bad subscriber');
  });
  hub.publish(ev());
  hub.publish(ev());
  s.stop();
  hub.publish(ev());
  hub.publish(ev());
  const back: number[] = [];
  const r = hub.subscribe(() => true, (_e, seq) => void back.push(seq), 2);
  assert.deepEqual(got, [1, 2]);
  assert.deepEqual(back, [3, 4]);
  assert.equal(r.missed, false);
  hub.publish(ev());
  hub.publish(ev());
  const late = hub.subscribe(() => true, () => {}, 1);
  assert.equal(late.missed, true, 'events 2 and 3 fell out of the buffer: reload rather than trust the stream');
});

test('presence shows who else is here and forgets people who went quiet', () => {
  let t = 0;
  const p = new Presence(30_000, () => t);
  p.beat('ana', 'doc:1', 'editing');
  p.beat('ben', 'doc:1');
  assert.deepEqual(p.here('doc:1', 'ben'), [{ who: 'ana', doing: 'editing' }]);
  t = 20_000;
  p.beat('ben', 'doc:1');
  t = 40_000;
  assert.deepEqual(p.here('doc:1'), [{ who: 'ben' }]);
  p.leave('ben', 'doc:1');
  assert.deepEqual(p.here('doc:1'), []);
});
