import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { NEXTCLOUD_RULES, compare, differences, normalise, play, record, shape, type Step } from './index.ts';

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

const R = NEXTCLOUD_RULES;
const xmlOf = (inner: string, root = 'd:multistatus') => `<?xml version="1.0"?><${root} xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:x="urn:x">${inner}</${root}>`;
const bodyOf = (type: string | undefined, text: string, rules = R) => normalise(200, type === undefined ? {} : { 'content-type': type }, text, rules).body;

test('every kind of value has its own shape, and only well-formed digits and dates earn theirs', () => {
  assert.equal(shape(null), 'empty');
  assert.equal(shape(undefined), 'empty');
  assert.equal(shape(7), 'int');
  assert.equal(shape(7.5), 'number');
  assert.equal(shape(true), 'bool');
  assert.equal(shape(false), 'bool');
  assert.equal(shape({}), 'object');
  assert.equal(shape([1]), 'object');
  assert.equal(shape('-12'), 'digits');
  assert.equal(shape('12a'), 'text', 'trailing text is not digits');
  assert.equal(shape('a12'), 'text', 'leading text is not digits');
  assert.equal(shape('2026-12-01'), 'date');
  assert.equal(shape('Tue, 01 Dec 2026 10:00:00 GMT'), 'date');
  assert.equal(shape('x 2026-12-01'), 'text', 'an ISO date must start the value');
  assert.equal(shape('Tue, 01 Dec 2026 10:00:00 GMT+0100'), 'text', 'GMT must end the value');
  assert.equal(shape('Dec 1 2026'), 'text', 'a parseable string that is neither GMT-stamped nor ISO is text');
  assert.equal(shape('GMT'), 'text', 'looking like a date is not enough, it has to parse');
  assert.equal(shape('2026-13-45'), 'text');
  assert.equal(shape('2026-12-01'), shape('2025-01-31'));
});

test('masked properties compare by the shape of their trimmed text; others by their trimmed text', () => {
  const a = bodyOf('application/xml', xmlOf('<d:response><d:getetag> "abc" </d:getetag><oc:fileid> 12 </oc:fileid><x:note> hi </x:note></d:response>'));
  const resp = ((a as Record<string, unknown[]>)['{DAV:}multistatus']![0] as Record<string, unknown[]>)['{DAV:}response']!;
  assert.deepEqual(resp, [{ '{DAV:}getetag': '<text>' }, { '{http://owncloud.org/ns}fileid': '<digits>' }, { '{urn:x}note': 'hi' }]);
});

test('multistatus, prop and share-types are sorted; everything else keeps its order', () => {
  const ordered = (b: unknown) => (Object.values(b as object)[0] as Record<string, unknown>[]).map((o) => Object.keys(o)[0]);
  assert.deepEqual(ordered(bodyOf('application/xml', xmlOf('<x:b>2</x:b><x:a>1</x:a>'))), ['{urn:x}a', '{urn:x}b'], 'multistatus children are sorted');
  assert.deepEqual(ordered(bodyOf('application/xml', xmlOf('<x:b>2</x:b><x:a>1</x:a>', 'd:prop'))), ['{urn:x}a', '{urn:x}b'], 'prop children are sorted');
  assert.deepEqual(ordered(bodyOf('application/xml', xmlOf('<x:b>2</x:b><x:a>1</x:a>', 'x:share-types'))), ['{urn:x}a', '{urn:x}b'], 'share-types children are sorted');
  assert.deepEqual(ordered(bodyOf('application/xml', xmlOf('<x:b>2</x:b><x:a>1</x:a>', 'd:response'))), ['{urn:x}b', '{urn:x}a'], 'a response keeps its order');
  assert.deepEqual(ordered(bodyOf('application/xml', xmlOf('<x:b>2</x:b><x:a>1</x:a>', 'x:prop'))), ['{urn:x}b', '{urn:x}a'], 'only DAV: prop is sorted');
  assert.deepEqual(ordered(bodyOf('application/xml', xmlOf('<x:b>2</x:b><x:a>1</x:a>', 'x:multistatus'))), ['{urn:x}b', '{urn:x}a'], 'only DAV: multistatus is sorted');
  assert.deepEqual(ordered(bodyOf('application/xml', xmlOf('<x:a>2</x:a><x:a>1</x:a>'))), ['{urn:x}a', '{urn:x}a']);
});

test('JSON keys come out sorted, masked keys by shape, at any depth and inside arrays', () => {
  const b = bodyOf('application/json', JSON.stringify({ z: 1, id: '77', list: [{ token: 'abc', b: 2, a: 1 }], a: { url: 'http://h/x', k: 'v' } })) as Record<string, unknown>;
  assert.deepEqual(Object.keys(b), ['a', 'id', 'list', 'z']);
  assert.deepEqual(b, { a: { k: 'v', url: '<text>' }, id: '<digits>', list: [{ a: 1, b: 2, token: '<text>' }], z: 1 });
  assert.deepEqual(Object.keys((b.list as object[])[0]!), ['a', 'b', 'token']);
  assert.deepEqual(Object.keys(b.a as object), ['k', 'url']);
  assert.deepEqual(bodyOf('application/json', '[1,[2,3]]'), [1, [2, 3]]);
});

test('headers: named ones by value (content type reduced to its media type), masked ones by shape, absent ones omitted', () => {
  const got = normalise(200, { 'content-type': ' Application/JSON ; charset=utf-8', dav: '1, 3 ; Mixed', etag: '"abc"', 'oc-fileid': '00012ocabc', date: 'Tue, 01 Dec 2026 10:00:00 GMT' }, '', R);
  assert.deepEqual(got.headers, { 'content-type': 'application/json', dav: '1, 3 ; Mixed', etag: '<text>', 'oc-fileid': '<text>', date: '<date>' });
  assert.deepEqual(normalise(200, {}, '', R).headers, {}, 'nothing is invented for absent headers');
  assert.deepEqual(normalise(200, { 'x-other': '1', 'x-request-id': '12', 'last-modified': 'Tue, 01 Dec 2026 10:00:00 GMT', 'oc-etag': '"e"' }, '', R).headers, { 'x-request-id': '<digits>', 'last-modified': '<date>', 'oc-etag': '<text>' }, 'unnamed headers are ignored');
  const real = new Headers({ 'Content-Type': 'text/plain; charset=x', ETag: '"e"' });
  assert.deepEqual(normalise(200, real, '', R).headers, { 'content-type': 'text/plain', etag: '<text>' }, 'a Headers object reads the same');
  assert.deepEqual(normalise(200, { 'content-type': 'text/plain;x' }, '', { maskProps: [], maskJson: [], maskHeaders: [], headers: ['content-type'] }).headers, { 'content-type': 'text/plain' });
});

test('a body is reduced by what it is: empty, XML, JSON, HTML or bytes; unreadable XML and JSON report only their length', () => {
  assert.equal(bodyOf('application/xml', ''), '', 'an empty body stays empty whatever the type');
  assert.equal(bodyOf(undefined, ''), '');
  assert.deepEqual(bodyOf('text/html', ''), '');
  assert.deepEqual(bodyOf(undefined, xmlOf('<d:response/>')), { '{DAV:}multistatus': [{ '{DAV:}response': '' }] }, 'XML is recognised by its prolog without a content type');
  assert.deepEqual(bodyOf(undefined, '\n  ' + xmlOf('<d:response/>')), { '{DAV:}multistatus': [{ '{DAV:}response': '' }] }, 'leading whitespace is allowed');
  assert.deepEqual(bodyOf('application/xml', '<d:a xmlns:d="DAV:">z</d:a>'), { '{DAV:}a': 'z' }, 'XML is recognised by its type without a prolog');
  assert.deepEqual(bodyOf('application/xml', 'not xml<'), { unparsed: 8 });
  assert.deepEqual(bodyOf(undefined, 'ends with <?xml'), { bytes: 15 }, 'a prolog must start the text');
  assert.deepEqual(bodyOf('application/json', '{"a":1}'), { a: 1 });
  assert.deepEqual(bodyOf('application/json', '{oops'), { unparsed: 5 });
  assert.deepEqual(bodyOf('text/html; charset=utf-8', '<html>hi</html>'), { html: true });
  assert.deepEqual(bodyOf('application/x-html; q', '<html>'), { bytes: 6 }, 'only a text/html type is html');
  assert.deepEqual(bodyOf('text/plain', 'hello'), { bytes: 5 });
  assert.deepEqual(bodyOf('text/plain', '{"a":1}'), { bytes: 7 }, 'a JSON-looking body with another type is just bytes');
  assert.deepEqual(bodyOf(undefined, 'hello'), { bytes: 5 });
  assert.deepEqual(bodyOf('text/html', '<?xml version="1.0"?><a/>'), { '{}a': '' }, 'XML by prolog wins over an html type');
});

test('differences say where: status, headers/<name>, body/<path>[i], and both values', () => {
  const ans = (o: Partial<{ status: number; headers: Record<string, string>; body: unknown }>) => ({ status: 200, headers: {}, body: '', ...o });
  assert.deepEqual(differences('s', ans({}), ans({})), []);
  assert.deepEqual(differences('s', ans({ headers: { dav: '1' } }), ans({ headers: { dav: '2' } })), [{ step: 's', where: 'headers/dav', reference: '1', candidate: '2' }]);
  assert.deepEqual(differences('s', ans({ headers: { dav: '1' } }), ans({})), [{ step: 's', where: 'headers/dav', reference: '1', candidate: undefined }]);
  assert.deepEqual(differences('s', ans({ body: 'a' }), ans({ body: 'b' })), [{ step: 's', where: 'body', reference: 'a', candidate: 'b' }]);
  assert.deepEqual(differences('s', ans({ body: { a: [1, { b: 2 }] } }), ans({ body: { a: [1, { b: 3 }] } })), [{ step: 's', where: 'body/a[1]/b', reference: 2, candidate: 3 }]);
  assert.deepEqual(differences('s', ans({ body: [1, 2, 3] }), ans({ body: [1, 2] })), [{ step: 's', where: 'body[2]', reference: 3, candidate: undefined }], 'a missing element is reported once, at its index');
  assert.deepEqual(differences('s', ans({ body: [1] }), ans({ body: [1, 9] })), [{ step: 's', where: 'body[1]', reference: undefined, candidate: 9 }]);
  assert.deepEqual(differences('s', ans({ body: { a: 1 } }), ans({ body: { a: 1, b: 2 } })), [{ step: 's', where: 'body/b', reference: undefined, candidate: 2 }]);
  assert.deepEqual(differences('s', ans({ body: { a: 1 } }), ans({ body: null })), [{ step: 's', where: 'body', reference: { a: 1 }, candidate: null }]);
  assert.deepEqual(differences('s', ans({ body: null }), ans({ body: { a: 1 } })), [{ step: 's', where: 'body', reference: null, candidate: { a: 1 } }]);
  assert.deepEqual(differences('s', ans({ body: 'abc' }), ans({ body: { 0: 'a' } })), [{ step: 's', where: 'body', reference: 'abc', candidate: { 0: 'a' } }]);
  assert.deepEqual(differences('s', ans({ body: { 0: 'a' } }), ans({ body: 'abc' })), [{ step: 's', where: 'body', reference: { 0: 'a' }, candidate: 'abc' }]);
  assert.deepEqual(differences('s', ans({ body: 5 }), ans({ body: { a: 1 } })), [{ step: 's', where: 'body', reference: 5, candidate: { a: 1 } }]);
  assert.deepEqual(differences('s', ans({ body: { a: 1 } }), ans({ body: 5 })), [{ step: 's', where: 'body', reference: { a: 1 }, candidate: 5 }]);
  assert.deepEqual(differences('s', ans({ body: [1] }), ans({ body: { 0: 1 } })), [{ step: 's', where: 'body', reference: [1], candidate: { 0: 1 } }], 'an array is not an object');
  assert.deepEqual(differences('s', ans({ body: { 0: 1 } }), ans({ body: [1] })), [{ step: 's', where: 'body', reference: { 0: 1 }, candidate: [1] }]);
  assert.deepEqual(differences('s', ans({ body: [[1]] }), ans({ body: [] })), [{ step: 's', where: 'body[0]', reference: [1], candidate: undefined }]);
});

/** A fake server: records what it was asked and answers from a list. */
const fake = (answers: Array<{ status?: number; type?: string; body?: string; headers?: Record<string, string> }>) => {
  const seen: Array<{ url: string; init: { method?: string; headers: Record<string, string>; body?: string } & Record<string, unknown> }> = [];
  const f = (async (url: string, init: never) => {
    seen.push({ url, init });
    const a = answers[seen.length - 1] ?? {};
    return new Response(a.body ?? '', { status: a.status ?? 200, headers: { ...(a.type ? { 'content-type': a.type } : {}), ...(a.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { seen, target: { base: 'http://h', user: 'ana', password: 'pw', fetch: f } };
};
const noRules = { maskProps: [], maskJson: [], maskHeaders: [], headers: [] };

test('a step is sent as scripted: method, authorisation, lowercased headers, {base} and {user} filled, body only when there is one', async () => {
  const { seen, target } = fake([{}, {}]);
  await play(
    [
      { name: 'move', method: 'MOVE', path: '/files/{user}/a.txt', headers: { Destination: '{base}/files/{user}/b.txt', Depth: '1' } },
      { name: 'put', method: 'PUT', path: '/x', body: 'hello {user}' },
    ],
    target,
    noRules,
  );
  assert.equal(seen[0]!.url, 'http://h/files/ana/a.txt');
  assert.equal(seen[0]!.init.method, 'MOVE');
  assert.deepEqual(seen[0]!.init.headers, { authorization: `Basic ${Buffer.from('ana:pw').toString('base64')}`, 'ocs-apirequest': 'true', destination: 'http://h/files/ana/b.txt', depth: '1' });
  assert.equal(seen[0]!.init.redirect, 'manual');
  assert.ok(!('body' in seen[0]!.init), 'no body key when the step has none');
  assert.equal(seen[1]!.init.body, 'hello ana');
  assert.equal(seen[1]!.init.method, 'PUT');
});

test('captured values carry to later steps: JSON paths (through arrays), headers; nothing is kept for null, missing or non-object paths', async () => {
  const { seen, target } = fake([
    { type: 'application/json', body: JSON.stringify({ a: { list: [{ id: 'first' }, { id: 'second' }] }, n: null, s: 'text', num: 0 }), headers: { ETag: '"tag1"' } },
    {},
  ]);
  await play(
    [
      {
        name: 'one',
        method: 'GET',
        path: '/one',
        capture: { picked: 'a.list.1.id', tag: 'header:etag', gone: 'n', none: 'a.nothing', deep: 'a.nothing.more', len: 's.length', zero: 'num', nohdr: 'header:x-none' },
      },
      { name: 'two', method: 'GET', path: '/{picked}/{tag}/{gone}/{none}/{deep}/{len}/{zero}/{nohdr}' },
    ],
    target,
    noRules,
  );
  assert.equal(seen[1]!.url, 'http://h/second/"tag1"/{gone}/{none}/{deep}/{len}/0/{nohdr}');
});

test('a capture from a body that is not JSON keeps nothing and does not fail the run', async () => {
  const { seen, target } = fake([{ type: 'text/plain', body: 'not json' }, {}]);
  const out = await play([{ name: 'a', method: 'GET', path: '/a', capture: { v: 'x' } }, { name: 'b', method: 'GET', path: '/{v}' }], target, noRules);
  assert.equal(seen[1]!.url, 'http://h/{v}');
  assert.equal(out.length, 2);
});

test('record keeps what was asked and answered, stamped with its schema and time', async () => {
  const { target } = fake([{ status: 201, type: 'text/plain', body: 'hi' }]);
  const c = await record([{ name: 'n', method: 'GET', path: '/p' }], target, R, 'ref', new Date(1000));
  assert.deepEqual(c, { schema: 'zthr-oracle/1', reference: 'ref', recorded: '1970-01-01T00:00:01.000Z', steps: [{ name: 'n', method: 'GET', path: '/p' }], answers: [{ status: 201, headers: { 'content-type': 'text/plain' }, body: { bytes: 2 } }] });
});

test('compare against a corpus does not call a reference; against a live target it does', async () => {
  const s: Step[] = [{ name: 'n', method: 'GET', path: '/p' }];
  const refAns = { status: 200, headers: {}, body: { bytes: 1 } };
  const corpus = { schema: 'zthr-oracle/1' as const, reference: 'r', recorded: '', steps: s, answers: [refAns] };
  const cand = fake([{ body: 'abcd', type: 'text/plain' }]);
  const r = await compare(s, cand.target, noRules, corpus);
  assert.deepEqual(r, { steps: 1, differences: [{ step: 'n', where: 'body/bytes', reference: 1, candidate: 4 }] });
  const live = fake([{ body: 'a', type: 'text/plain' }]);
  const cand2 = fake([{ body: 'abcd', type: 'text/plain' }]);
  const r2 = await compare(s, cand2.target, noRules, live.target);
  assert.equal(live.seen.length, 1);
  assert.equal(r2.differences.length, 1);
});

test('the Nextcloud rules mask exactly the values that rightly differ, and keep the rest', () => {
  const props = ['{DAV:}getetag', '{DAV:}getlastmodified', '{DAV:}creationdate', '{http://owncloud.org/ns}fileid', '{http://owncloud.org/ns}id', '{http://nextcloud.org/ns}creation_time', '{http://nextcloud.org/ns}upload_time', '{http://owncloud.org/ns}checksums', '{DAV:}quota-available-bytes', '{http://nextcloud.org/ns}data-fingerprint', '{http://nextcloud.org/ns}lock-time', '{http://nextcloud.org/ns}lock-token'];
  for (const p of props) {
    const [, ns, name] = /^\{(.*)\}(.*)$/.exec(p)!;
    const doc = (v: string) => `<?xml version="1.0"?><d:prop xmlns:d="DAV:" xmlns:p="${ns}"><p:${name}>${v}</p:${name}></d:prop>`;
    const a = normalise(207, {}, doc('first-value'), R);
    const b = normalise(207, {}, doc('second-different'), R);
    assert.deepEqual(differences('s', a, b), [], `${p} is masked`);
  }
  const kept = (v: string) => normalise(207, {}, `<?xml version="1.0"?><d:prop xmlns:d="DAV:"><d:getcontentlength>${v}</d:getcontentlength></d:prop>`, R);
  assert.equal(differences('s', kept('1'), kept('2')).length, 1, 'a size is compared by value');
  const keys = ['id', 'token', 'url', 'stime', 'expiration', 'file_source', 'item_source', 'file_parent', 'storage', 'storage_id', 'parent', 'mail_send', 'uid_file_owner', 'displayname_file_owner', 'uid_owner', 'displayname_owner', 'version', 'versionstring', 'edition', 'productname', 'extendedSupport', 'installed', 'maintenance', 'needsDbUpgrade'];
  for (const k of keys) {
    const j = (v: string) => normalise(200, { 'content-type': 'application/json' }, JSON.stringify({ [k]: v }), R);
    assert.deepEqual(differences('s', j('aaa'), j('bbb')), [], `${k} is masked`);
  }
  const jk = (v: number) => normalise(200, { 'content-type': 'application/json' }, JSON.stringify({ permissions: v }), R);
  assert.equal(differences('s', jk(1), jk(31)).length, 1, 'permissions are compared by value');
  const hdr = (name: string, v: string) => normalise(200, { [name]: v }, '', R);
  for (const h of ['etag', 'oc-etag', 'oc-fileid', 'last-modified', 'x-request-id', 'date']) assert.deepEqual(differences('s', hdr(h, 'aaa'), hdr(h, 'bbb')), [], `${h} is masked`);
  for (const h of ['content-type', 'dav']) assert.equal(differences('s', hdr(h, 'aaa'), hdr(h, 'bbb')).length, 1, `${h} is compared by value`);
});
