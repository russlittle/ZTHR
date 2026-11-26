import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEXTCLOUD_RULES, compare, record } from '../../intent/blocks/oracle/index.ts';
import { STEPS } from '../oracle/steps.ts';
import { PASS, start } from './helpers.ts';

test('the oracle script runs end to end on Files, and two fresh servers answer it identically', async () => {
  const a = await start({ people: [{ id: 'ana' }] });
  const b = await start({ people: [{ id: 'ana' }] });
  try {
    const t = (base: string) => ({ base, user: 'ana', password: PASS });
    const corpus = await record(STEPS, t(a.base), NEXTCLOUD_RULES, 'files');
    const statuses = Object.fromEntries(STEPS.map((s, i) => [s.name, corpus.answers[i]!.status]));
    assert.equal(statuses['make a folder'], 201);
    assert.equal(statuses['make it again'], 405);
    assert.equal(statuses['a folder inside a missing one'], 409);
    assert.equal(statuses['read a range'], 206);
    assert.equal(statuses['something missing'], 404);
    assert.equal(statuses['copy onto it without overwrite'], 412);
    assert.equal(statuses['assemble with a chunk too small'], 201, 'one chunk under the minimum is the last one, so it assembles');
    assert.equal(statuses['share by link'], 200);
    const r = await compare(STEPS, t(b.base), NEXTCLOUD_RULES, corpus);
    assert.deepEqual(r.differences, [], 'the masks cover every value that rightly differs between two servers');
  } finally {
    await a.close();
    await b.close();
  }
});
