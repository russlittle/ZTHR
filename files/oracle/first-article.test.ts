import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, record } from '../../intent/blocks/oracle/index.ts';
import { PASS, start } from '../test/helpers.ts';
import { limitsFrom, parseLoadArgs, percentile, verdict, type LoadResult } from '../tools/bench.ts';
import { children, chunkedUpload, isConflictCopy, listing, transfers } from '../tools/journey.ts';
import { folders, seededBytes, smallTree } from '../tools/tree.ts';
import { parseLitmus, litmusRegressions, litmusScore, renderDifferences, renderLitmus, renderSync, repeatDifferences, sameRecording, selfChecks, syncVerdicts, type Recording } from './inspect.ts';
import { FIRST_ARTICLE_RULES, maskText, maskedFetch } from './masks.ts';
import { STEPS } from './steps.ts';

test('the tree is the same for a seed, different for another, and small', () => {
  const a = [...smallTree(600)];
  const b = [...smallTree(600)];
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, [...smallTree(600, 1)]);
  assert.equal(a.length, 600);
  assert.equal(a[251]!.path, 'd1/file-251.txt');
  assert.ok(a.every((f) => f.content.startsWith(`file ${f.path.match(/file-(\d+)/)![1]}\n`) && f.content.length < 80));
  assert.deepEqual(folders(600), ['d0', 'd1', 'd2']);
  assert.deepEqual(seededBytes(1001, 3), seededBytes(1001, 3));
  assert.equal(seededBytes(1001, 3).length, 1001);
});

test('benchmark options parse, and bad ones are refused', () => {
  const o = parseLoadArgs(['1000', 'memory', '--time-limit', '60', '--max-seconds=12.5', '--max-p95-ms', '9']);
  assert.equal(o.files, 1000);
  assert.equal(o.store, 'memory');
  assert.equal(o.timeLimit, 60);
  assert.equal(o.maxSeconds, 12.5);
  assert.equal(o.maxP95Ms, 9);
  assert.equal(o.maxErrors, 0);
  assert.equal(parseLoadArgs([]).files, 25_000);
  assert.equal(parseLoadArgs(['--url', 'http://x:1/', '--user', 'u', '--password', 'p']).url, 'http://x:1');
  assert.throws(() => parseLoadArgs(['--url', 'http://x']), /needs --user/);
  assert.throws(() => parseLoadArgs(['--bogus', '1']), /unknown option/);
  assert.throws(() => parseLoadArgs(['10', 'tape']), /disk or memory/);
  assert.throws(() => parseLoadArgs(['--max-seconds']), /needs a value/);
});

const result = (o: Partial<LoadResult> = {}): LoadResult => ({ files: 100, target: 't', completed: 100, errors: 0, timedOut: false, uploadSeconds: 10, perSecond: 10, p50ms: 3, p95ms: 8, p99ms: 12, fullListingSeconds: 1, unchangedRecheckMs: 1, ...o });

test('the verdict names every broken limit and passes when none is', () => {
  assert.deepEqual(verdict(result(), { maxErrors: 0, timeLimit: 60 }), []);
  assert.deepEqual(verdict(result(), { maxErrors: 0, timeLimit: 60, maxSeconds: 10, maxP95Ms: 8 }), [], 'at the limit is a pass');
  const v = verdict(result({ uploadSeconds: 11, p95ms: 9, errors: 2, firstError: 'PUT x: 503' }), { maxErrors: 0, timeLimit: 60, maxSeconds: 10, maxP95Ms: 8 });
  assert.equal(v.length, 3);
  assert.match(v.join(), /503/);
  assert.match(verdict(result({ timedOut: true, completed: 40 }), { maxErrors: 0, timeLimit: 60 })[0]!, /time limit of 60 s with 40 of 100/);
  assert.match(verdict(result({ p95ms: Number.NaN }), { maxErrors: 0, timeLimit: 60, maxP95Ms: 5 })[0]!, /p95/, 'no measurement is not a pass');
});

test('limits come from the control, scaled, and an unfinished control gives none', () => {
  assert.deepEqual(limitsFrom(result({ uploadSeconds: 20, p95ms: 7.5 }), 1), { maxSeconds: 20, maxP95Ms: 7.5, note: '1 × the control: 20 s, p95 7.5 ms' });
  assert.equal(limitsFrom(result({ uploadSeconds: 20 }), 1.5).maxSeconds, 30);
  const none = limitsFrom(result({ timedOut: true, completed: 10 }), 1);
  assert.equal(none.maxSeconds, undefined);
  assert.match(none.note, /did not finish/);
});

test('percentiles are nearest-rank', () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 50), 50);
  assert.equal(percentile(v, 95), 95);
  assert.equal(percentile([4], 99), 4);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('text masks replace the server address and trash deletion times, nothing else', () => {
  const t = maskText('{"url":"http:\\/\\/localhost:8081\\/ocs","x":"http://127.0.0.1:8081/a","y":"http://localhost:9999/b"}<d:href>/remote.php/dav/trashbin/u/trash/c.txt.d1732712345</d:href><n>a.d12</n>', 'http://localhost:8081');
  assert.equal(t, '{"url":"{base}\\/ocs","x":"{base}/a","y":"http://localhost:9999/b"}<d:href>/remote.php/dav/trashbin/u/trash/c.txt.d{time}</d:href><n>a.d12</n>');
});

test('the masked fetch keeps status and headers and handles bodiless answers', async () => {
  const inner = (async (u: string | URL | Request) => (String(u).endsWith('/none') ? new Response(null, { status: 204, headers: { etag: '"1"' } }) : new Response('see http://h:1/x', { status: 207, headers: { 'content-type': 'application/xml' } }))) as typeof fetch;
  const f = maskedFetch('http://h:1', inner);
  const a = await f('http://h:1/x');
  assert.equal(a.status, 207);
  assert.equal(a.headers.get('content-type'), 'application/xml');
  assert.equal(await a.text(), 'see {base}/x');
  const b = await f('http://h:1/none');
  assert.equal(b.status, 204);
  assert.equal(b.headers.get('etag'), '"1"');
});

test('listings are read whatever the prefixes, and conflict copies are recognised', () => {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/u/d0/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/remote.php/dav/files/u/d0/file%201.txt</d:href><d:propstat><d:prop><d:getcontentlength>12</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`;
  assert.equal(listing(xml).length, 2);
  assert.equal(listing(xml.replace(/d:/g, 'D:').replace('xmlns:D', 'xmlns:D')).length, 2);
  const c = children(xml, '/remote.php/dav/files/u/d0');
  assert.deepEqual([...c.keys()], ['file 1.txt']);
  assert.equal(c.get('file 1.txt')!.size, 12);
  assert.ok(isConflictCopy('file-0 (conflicted copy 2026-11-27 101112).txt', 'file-0.txt'));
  assert.ok(isConflictCopy('file-0 (conflicted copy sync 2026-11-27 101112).txt', 'file-0.txt'));
  assert.ok(!isConflictCopy('file-0.txt', 'file-0.txt'));
  assert.ok(!isConflictCopy('file-01 (conflicted copy 2026).txt', 'file-0.txt'));
});

test('the proxy log shows a chunked upload and counts transfers', () => {
  const log = [
    { method: 'MKCOL', path: '/remote.php/dav/uploads/u/123', status: 201 },
    { method: 'PUT', path: '/remote.php/dav/uploads/u/123/00001', status: 201 },
    { method: 'PUT', path: '/remote.php/dav/uploads/u/123/00002', status: 201 },
    { method: 'MOVE', path: '/remote.php/dav/uploads/u/123/.file', status: 201 },
    { method: 'PROPFIND', path: '/remote.php/dav/files/u/', status: 207 },
    { method: 'POST', path: '/remote.php/dav/bulk', status: 200 },
  ];
  assert.deepEqual(chunkedUpload(log), { started: true, chunks: 2, assembled: true });
  assert.equal(transfers(log), 3, 'two chunk PUTs and one bulk upload');
  assert.deepEqual(chunkedUpload(log.slice(4)), { started: false, chunks: 0, assembled: false });
});

const LITMUS = `-> running \`basic':
 0. init.................. pass
 1. begin................. pass
 2. options............... pass
 3. put_get............... pass
 4. delete_null........... FAIL (DELETE nonexistent resource succeeded)
<- summary for \`basic': of 5 tests run: 4 passed, 1 failed. 80.0%
-> running \`props':
 3. propfind_d0........... WARNING: server does not report DAV:getlastmodified
    ...................... pass
 4. propset............... pass
 9. propget............... FAIL (No value given for property {http://example.com/neon/litmus/}prop0)
-> running \`locks':
 0. init.................. pass
 3. lock_excl............. SKIPPED
`;

test('litmus output is read into suite/test results and scored', () => {
  const m = parseLitmus(LITMUS);
  assert.equal(m.get('basic/put_get'), 'pass');
  assert.equal(m.get('basic/delete_null'), 'fail');
  assert.equal(m.get('props/propfind_d0'), 'warning');
  assert.equal(m.get('props/propget'), 'fail');
  assert.equal(m.get('locks/lock_excl'), 'skipped');
  assert.deepEqual(litmusScore(m), { passed: 7, failed: 2, skipped: 1, run: 9 });
  const ref = parseLitmus(LITMUS.replace(/FAIL \(No value[^)]*\)/, 'pass'));
  assert.deepEqual(litmusRegressions(ref, m), ['props/propget'], 'a test failing on both is not a regression');
  assert.deepEqual(litmusRegressions(m, ref), []);
  assert.deepEqual(litmusRegressions(ref, new Map()), [...ref].filter(([, v]) => v === 'pass' || v === 'warning').map(([k]) => k), 'a candidate that never ran fails everything');
  const r = renderLitmus(ref, m);
  assert.match(r.markdown, /\| Files \| 7\/9 \| 2 \| 1 \|/);
  assert.deepEqual(r.regressions, ['props/propget']);
});

test('sync verdicts blame Files only where the control passed', () => {
  const s = (step: string, pass: boolean) => ({ step, pass, seconds: 1, detail: pass ? '' : 'broke' });
  const control = { server: 'nextcloud', client: 'nextcloudcmd 3.11', files: 10, steps: [s('a', true), s('b', false), s('c', true), s('d', false)] };
  const files = { server: 'files', client: 'nextcloudcmd 3.11', files: 10, steps: [s('a', true), s('b', false), s('c', false), s('d', true)] };
  assert.deepEqual(syncVerdicts(control, files).map((v) => v.verdict), ['pass', 'both', 'files', 'control only']);
  const r = renderSync(control, files);
  assert.deepEqual(r.filesFailures, ['c']);
  assert.match(r.markdown, /fails on Nextcloud too/);
  assert.deepEqual(renderSync(control, undefined).filesFailures, ['a', 'b', 'c', 'd'], 'Files not running at all fails every step');
  assert.deepEqual(renderSync(undefined, files).filesFailures, ['b', 'c'], 'without a control every Files failure is reported as Files\'');
});

test('Files against Files: the inspection records, self-checks, repeats exactly and compares clean', async () => {
  const a = await start({ people: [{ id: 'oracle' }] });
  const b = await start({ people: [{ id: 'oracle' }] });
  try {
    const t = (base: string) => ({ base, user: 'oracle', password: PASS, fetch: maskedFetch(base) });
    const first = await record(STEPS, t(a.base), FIRST_ARTICLE_RULES, 'files a');
    const second = await record(STEPS, t(a.base), FIRST_ARTICLE_RULES, 'files a');
    const checks = selfChecks(first, second, true);
    assert.deepEqual(checks.filter((c) => !c.pass), [], 'every self-check passes on Files');
    assert.deepEqual(repeatDifferences(first, second), []);
    assert.ok(sameRecording({ ...first }, { ...second, recorded: 'another time' } as Recording));
    const r = await compare(STEPS, t(b.base), FIRST_ARTICLE_RULES, first);
    assert.deepEqual(r.differences, []);
    // The same script, but the candidate's answers changed: the report shows them by step.
    const broken = { ...first, answers: first.answers.map((x, i) => (STEPS[i]!.name === 'make it again' ? { ...x, status: 201 } : x)) };
    const r2 = await compare(STEPS, t(b.base), FIRST_ARTICLE_RULES, broken);
    assert.deepEqual(r2.differences.map((d) => `${d.step} ${d.where}`), ['make it again status']);
    assert.match(renderDifferences(r2.differences, r2.steps, { reference: 'Nextcloud', candidate: 'Files' }), /1 unmasked difference/);
  } finally {
    await a.close();
    await b.close();
  }
});

test('self-checks catch a recording that is not fit to be the reference', () => {
  const steps = STEPS.slice(0, 4);
  const ok = { status: 200, headers: {}, body: '' };
  const root = { status: 207, headers: {}, body: { '{DAV:}multistatus': [{ '{DAV:}response': [] }, { '{DAV:}response': [] }] } };
  const c = { schema: 'zthr-oracle/1' as const, reference: 'x', recorded: '', steps, answers: [ok, { status: 500, headers: {}, body: '' }, { status: 401, headers: {}, body: { unparsed: 3 } }, root] };
  const failed = selfChecks(c, { ...c, answers: [ok, ok, ok, root] }, false).filter((x) => !x.pass).map((x) => x.check);
  assert.equal(failed.length, 7, failed.join('\n'));
});
