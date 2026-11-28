import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { NEXTCLOUD_RULES, compare, differences, normalise, record, shape, type Step } from './index.ts';

const listing = (etag: string, id: string, order: string[]) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${order
    .map((n) => `<d:response><d:href>/remote.php/dav/files/ana/${n}</d:href><d:propstat><d:prop><d:getetag>"${etag}"</d:getetag><oc:fileid>${id}</oc:fileid><oc:size>3</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
    .join('')}</d:multistatus>`;

const serve = (handler: (method: string, url: string, body: string) => { status: number; type?: string; body?: string; headers?: Record<string, string> }) =>
  new Promise<{ base: string; close: () => void }>((ok) => {
    const s: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const r = handler(req.method!, req.url!, body);
        res.writeHead(r.status, { ...(r.type ? { 'content-type': r.type } : {}), ...(r.headers ?? {}) });
        res.end(r.body ?? '');
      });
    });
    s.listen(0, '127.0.0.1', () => ok({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }));
  });

const steps: Step[] = [
  { name: 'list the root', method: 'PROPFIND', path: '/remote.php/dav/files/{user}/', headers: { depth: '1' } },
  { name: 'share a file', method: 'POST', path: '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', body: 'path=/a.txt&shareType=3', capture: { share: 'ocs.data.id' } },
  { name: 'read the share back', method: 'GET', path: '/ocs/v2.php/apps/files_sharing/api/v1/shares/{share}?format=json' },
];

test('the shape of a value is what is compared when its value rightly differs', () => {
  assert.equal(shape('"5f2a9c1e"'), shape('"zz-token"'), 'any two etags or tokens match');
  assert.equal(shape('42'), 'digits');
  assert.equal(shape('Tue, 01 Dec 2026 10:00:00 GMT'), 'date');
  assert.equal(shape(''), 'empty');
  assert.equal(shape('hello'), 'text');
});

test('order, etags, ids and dates never show as differences; a real change always does', async () => {
  const ref = await serve((m, url) =>
    m === 'PROPFIND'
      ? { status: 207, type: 'application/xml; charset=utf-8', body: listing('aaaa1111', '7', ['a.txt', 'b.txt']), headers: { date: 'Tue, 01 Dec 2026 10:00:00 GMT' } }
      : url.includes('/shares/')
        ? { status: 200, type: 'application/json', body: JSON.stringify({ ocs: { meta: { status: 'ok' }, data: { id: '12', token: 'abcabcabcabcabc', permissions: 1 } } }) }
        : { status: 200, type: 'application/json', body: JSON.stringify({ ocs: { meta: { status: 'ok' }, data: { id: '12', token: 'abcabcabcabcabc', permissions: 1 } } }) },
  );
  const same = await serve((m, url) =>
    m === 'PROPFIND'
      ? { status: 207, type: 'application/xml', body: listing('bbbb2222', '99', ['b.txt', 'a.txt']), headers: { date: 'Wed, 02 Dec 2026 11:00:00 GMT' } }
      : url.includes('/shares/99')
        ? { status: 200, type: 'application/json', body: JSON.stringify({ ocs: { data: { token: 'xyzxyzxyzxyzxyz', permissions: 1, id: '99' }, meta: { status: 'ok' } } }) }
        : url.includes('/shares/')
          ? { status: 404, type: 'application/json', body: '{}' }
          : { status: 200, type: 'application/json', body: JSON.stringify({ ocs: { meta: { status: 'ok' }, data: { id: '99', token: 'xyzxyzxyzxyzxyz', permissions: 1 } } }) },
  );
  const wrong = await serve((m) => (m === 'PROPFIND' ? { status: 207, type: 'application/xml', body: listing('cccc3333', '5', ['a.txt']) } : { status: 200, type: 'application/json', body: JSON.stringify({ ocs: { meta: { status: 'ok' }, data: { id: '5', token: 'qqqqqqqqqqqqqqq', permissions: 31 } } }) }));
  try {
    const t = (base: string) => ({ base, user: 'ana', password: 'pw' });
    const ok = await compare(steps, t(same.base), NEXTCLOUD_RULES, t(ref.base));
    assert.deepEqual(ok.differences, [], 'captured ids carry through, so the read-back finds the share');
    const bad = await compare(steps, t(wrong.base), NEXTCLOUD_RULES, t(ref.base));
    assert.ok(bad.differences.some((d) => d.step === 'list the root'), 'a missing file shows');
    assert.ok(bad.differences.some((d) => d.where.endsWith('/permissions') && d.reference === 1 && d.candidate === 31), 'a wrong permission shows, with both values');
  } finally {
    ref.close();
    same.close();
    wrong.close();
  }
});

test('a recorded corpus checks a candidate with no reference running', async () => {
  const ref = await serve(() => ({ status: 207, type: 'application/xml', body: listing('aaaa1111', '7', ['a.txt']) }));
  const corpus = await record(steps.slice(0, 1), { base: ref.base, user: 'ana', password: 'pw' }, NEXTCLOUD_RULES, 'Nextcloud 32', new Date(0));
  ref.close();
  const cand = await serve(() => ({ status: 207, type: 'application/xml', body: listing('ffff0000', '8', ['a.txt']) }));
  try {
    const r = await compare(steps.slice(0, 1), { base: cand.base, user: 'ana', password: 'pw' }, NEXTCLOUD_RULES, JSON.parse(JSON.stringify(corpus)));
    assert.deepEqual(r.differences, []);
    assert.equal(corpus.reference, 'Nextcloud 32');
  } finally {
    cand.close();
  }
});

test('a status difference is reported before anything else', () => {
  const a = normalise(200, {}, '', NEXTCLOUD_RULES);
  const b = normalise(404, {}, '', NEXTCLOUD_RULES);
  assert.deepEqual(differences('x', a, b)[0], { step: 'x', where: 'status', reference: 200, candidate: 404 });
});
