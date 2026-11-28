import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Explorer, html, sections, summarise, view, type Feature, type Sources } from './index.ts';
import type { Surface } from '../surfaces/index.ts';
import { review, expiry } from '../upkeep/index.ts';
import { Incidents } from '../slo/index.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const H = 3_600_000;
const surface = (id: string, path: string): Surface => ({ id, path, title: `The ${id} screen`, purpose: `Shows the ${id} for the people who use it.`, audience: ['admin'], help: 'How to use it.', states: { loading: 'Loading…', empty: { text: 'Nothing here yet.' }, error: 'We could not load this. Try again.' }, owner: 'ops' });

function sources(): Sources {
  const inc = new Incidents(() => new Date(NOW - 2 * H));
  inc.open('Uploads failing', 1);
  const old = inc.open('Slow search', 2);
  inc.update(old.id, 'resolved', 'fixed');
  inc.open('Typo on status page', 3);
  inc.update(3, 'resolved', 'fixed');
  return {
    now: NOW,
    surfaces: [surface('files', '/files')],
    flags: [
      { key: 'new-editor', description: '', owner: 'docs team', on: true, rules: [{ percent: 10 }], removeBy: '2027-01-01' },
      { key: 'old-banner', description: '', owner: 'web team', on: false, removeBy: '2026-10-01' },
      { key: 'kill-me', description: '', owner: 'web team', on: true, killed: true, removeBy: '2027-01-01' },
    ],
    jobs: [
      { id: 'job-1', kind: 'email', payload: null, state: 'dead', attempts: 5, maxAttempts: 5, runAt: NOW - H, lastError: 'mail server refused', created: NOW - 2 * H },
      { id: 'job-2', kind: 'thumbnail', payload: null, state: 'waiting', attempts: 0, maxAttempts: 5, runAt: NOW - H, created: NOW - H },
      { id: 'job-3', kind: 'index', payload: null, state: 'done', attempts: 1, maxAttempts: 5, runAt: NOW - H, created: NOW - H },
    ],
    housekeeping: {
      chores: [
        { job: { name: 'session-sweep', everyMin: 60, graceMin: 10, maxMin: 5 }, title: 'Sweep expired sessions', kind: 'sweep', did: 'removed 41 expired sessions' },
        { job: { name: 'key-rotation', everyMin: 1440, graceMin: 60, maxMin: 10 }, title: 'Rotate signing keys', kind: 'rotation' },
        { job: { name: 'orphan-sweep', everyMin: 60, graceMin: 10, maxMin: 5 }, title: 'Sweep orphaned uploads', kind: 'sweep' },
      ],
      checkIns: [
        { job: 'session-sweep', run: 'r1', at: NOW - 30 * 60_000, kind: 'start' },
        { job: 'session-sweep', run: 'r1', at: NOW - 29 * 60_000, kind: 'end', ok: true },
        { job: 'key-rotation', run: 'r1', at: NOW - 3 * 24 * H, kind: 'start' },
        { job: 'key-rotation', run: 'r1', at: NOW - 3 * 24 * H + 60_000, kind: 'end', ok: true },
      ],
    },
    dependencies: review([{ name: 'left-pad', version: '1.0.0', latest: '1.0.0' }, { name: 'xmldom', version: '0.7.0', latest: '0.9.0' }], [{ package: 'xmldom', id: 'GHSA-1', severity: 'critical', fixedIn: '0.8.4' }], { today: '2026-11-27' }),
    expiries: expiry([{ what: 'api.example.org certificate', kind: 'certificate', expires: '2026-12-04', owner: 'Ops' }, { what: 'example.org domain', kind: 'domain', expires: '2027-08-01', owner: 'Ops' }], '2026-11-27'),
    drills: { list: [{ backup: 'b-20261120T0000', ran: '2026-11-20T01:00:00.000Z', ms: 240_000, targetMs: 600_000, ok: true, collections: [], problems: [] }], everyDays: 7 },
    objectives: [{ objective: { name: 'Requests succeed', target: 0.999, windowDays: 30 }, window: { good: 99_990, total: 100_000 } }],
    incidents: inc.list,
    readiness: { status: 'degraded', checks: [{ name: 'database', ok: true, ms: 3 }, { name: 'search', ok: false, ms: 2000, error: 'no answer within 2000 ms' }] },
  };
}

const all = () => true;

test('each registry becomes a section of items with a status, a reason, a path and a permission', () => {
  const s = sections(sources());
  assert.deepEqual(s.map((x) => [x.id, x.status]), [['service', 'attention'], ['incidents', 'action'], ['housekeeping', 'action'], ['jobs', 'action'], ['backups', 'ok'], ['upkeep', 'action'], ['expiries', 'attention'], ['flags', 'attention'], ['screens', 'ok']]);
  const by = (id: string) => s.flatMap((x) => x.items).find((i) => i.id === id)!;
  assert.deepEqual(by('service:readiness'), { id: 'service:readiness', title: 'Readiness', status: 'attention', reason: 'search is not answering (no answer within 2000 ms).', path: '/admin/service', permission: 'admin:service' });
  assert.equal(by('service:slo-Requests succeed').reason, '90% of the error budget is left.');
  assert.equal(by('service:slo-Requests succeed').path, '/admin/service/objectives/Requests%20succeed');
  assert.deepEqual(s[1]!.items.map((i) => [i.title, i.status, i.reason]), [['Uploads failing', 'action', 'Severity 1, investigating since 2026-11-27 10:00.'], ['Slow search', 'attention', 'Resolved, and still owes a postmortem.']], 'a resolved severity 3 needs nothing');
  assert.deepEqual(by('jobs:email'), { id: 'jobs:email', title: 'email', status: 'action', reason: '1 job gave up; the last error was "mail server refused". Fix the cause, then replay.', path: '/admin/jobs/email', permission: 'admin:jobs' });
  assert.equal(by('jobs:thumbnail').reason, '1 job waiting more than 15 minutes past due.');
  assert.equal(by('jobs:index').status, 'ok');
  assert.equal(by('backups:drill').reason, 'Restored b-20261120T0000 7 days ago in 240000 ms, every collection matched.');
  assert.equal(by('upkeep:xmldom').reason, 'Update now: GHSA-1 (critical) is fixed in 0.8.4.');
  assert.equal(by('expiries:api.example.org certificate').reason, '7 days left. Ops renews it.');
  assert.deepEqual([by('flags:new-editor').status, by('flags:old-banner').reason, by('flags:kill-me').reason], ['ok', 'Off. It was due out of the code by 2026-10-01. web team owns it.', 'Switched off for everyone. Due out of the code by 2027-01-01. web team owns it.']);
});

test('the housekeeping console says when each chore last ran, what it did, what is due, and which silently stopped', () => {
  const hk = sections(sources()).find((x) => x.id === 'housekeeping')!;
  assert.deepEqual(hk.items.map((i) => [i.title, i.status, i.reason]), [
    ['Rotate signing keys', 'action', 'Last ran 2026-11-24 12:00. Next due 2026-11-25 12:00. Missed: last started 4320 minutes ago; due every 1440.'],
    ['Sweep orphaned uploads', 'action', 'It has never run. Never ran: no run has checked in.'],
    ['Sweep expired sessions', 'ok', 'Last ran 2026-11-27 11:30 and removed 41 expired sessions. Next due 2026-11-27 12:30.'],
  ]);
});

test('a person sees only what their permissions allow, and the summary counts only that', () => {
  const v = view(sources(), (p) => p === 'admin:flags' || p === 'admin:backups');
  assert.deepEqual(v.sections.map((s) => s.id), ['backups', 'flags']);
  assert.deepEqual(v.counts, { ok: 2, attention: 2, action: 0 });
  assert.equal(v.summary, '2 need attention, 2 are fine.');
  const full = view(sources(), all);
  assert.equal(full.summary, '5 need action, 6 need attention, 8 are fine.');
  assert.equal(view(sources(), () => false).summary, 'There is nothing here for you to look after.');
  assert.equal(summarise({ ok: 3, attention: 0, action: 0 }), 'Everything is fine: 3 items checked.');
  assert.equal(summarise({ ok: 0, attention: 1, action: 1 }), '1 needs action, 1 needs attention.');
  const moved = view(sources(), (p) => p === 'ops', { base: '/ops/', permissions: { jobs: 'ops' } });
  assert.deepEqual(moved.sections.flatMap((s) => s.items.map((i) => i.path)), ['/ops/jobs/email', '/ops/jobs/thumbnail', '/ops/jobs/index']);
});

test('backups never restored, a failed drill, or a stale drill are flagged; a spent error budget needs action', () => {
  const b = (drills: Sources['drills']) => sections({ now: NOW, ...(drills ? { drills } : {}) })[0]!.items[0]!;
  assert.deepEqual([b({ list: [], everyDays: 7 }).status, b({ list: [], everyDays: 7 }).reason], ['action', 'No backup has ever been restored. A backup is only proved by restoring it.']);
  assert.equal(b({ list: [{ backup: 'b1', ran: '2026-11-27T00:00:00Z', ms: 9, targetMs: 5, ok: false, collections: [], problems: ['the restore took 9 ms, over the 5 ms target'] }], everyDays: 7 }).reason, 'The last restore drill failed: the restore took 9 ms, over the 5 ms target.');
  const stale = b({ list: [{ backup: 'b1', ran: '2026-11-01T00:00:00Z', ms: 9, targetMs: 50, ok: true, collections: [], problems: [] }], everyDays: 7 });
  assert.deepEqual([stale.status, stale.reason], ['attention', 'Restored b1 26 days ago in 9 ms, every collection matched. Drills are due every 7 days.']);
  const spent = sections({ now: NOW, objectives: [{ objective: { name: 'Up', target: 0.99, windowDays: 30 }, window: { good: 980, total: 1000 } }] })[0]!.items[0]!;
  assert.deepEqual([spent.status, spent.reason], ['action', 'The error budget is spent: 20 failures against 10 allowed.']);
  const paging = sections({ now: NOW, objectives: [{ objective: { name: 'Up', target: 0.99, windowDays: 30 }, window: { good: 999, total: 1000 }, windows: { '1h': { good: 50, total: 100 }, '5m': { good: 5, total: 10 } } }] })[0]!.items[0]!;
  assert.deepEqual([paging.status, paging.reason], ['action', 'Up burning 50.0x over 1h and 50.0x over 5m (limit 14.4x).']);
  assert.deepEqual(sections({ now: NOW }), [], 'no registries, no sections');
});

test('rendering escapes every value and says status in words', () => {
  const v = view({ now: NOW, flags: [{ key: '<script>x</script>', description: '', owner: 'a & b', on: true, removeBy: '2027-01-01' }] }, all);
  const out = html(v);
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(out, /a &amp; b owns it/);
  assert.match(out, /<strong>Fine<\/strong>/);
});

const features: Feature[] = [
  {
    id: 'share', name: 'Share a folder', what: 'People share a folder with a link or by name.', parts: ['grants', 'audit'], data: ['grants'], surfaces: ['files', 'ghost'], flags: ['new-editor', 'nope'],
    journeys: [{ id: 'j-share', persona: 'owner', goal: 'Share a folder with a colleague', status: 'pass' }, { id: 'j-revoke', persona: 'owner', goal: 'Take back a share and see it hold at once', status: 'pass' }],
    evidence: [{ id: 'e1', kind: 'test', href: '/evidence/share.json', at: '2026-11-20T00:00:00Z', proves: ['j-share'], passed: true }, { id: 'e2', kind: 'screenshot', href: '/evidence/x.png', at: '2026-11-21T00:00:00Z', proves: ['j-other'] }],
    permissions: [{ role: 'owner', may: ['share', 'revoke'] }], history: [{ at: '2026-10-01', what: 'Links can expire' }, { at: '2026-11-01', what: 'Passwords on links' }], audit: '/admin/audit?feature=share',
  },
  { id: 'upload', name: 'Upload files', what: 'Large files upload in parts and resume.', journeys: [{ id: 'j-up', persona: 'member', goal: 'Upload a 2 GB video', status: 'fail' }], evidence: [{ id: 'e3', kind: 'run', href: '/evidence/run-9', at: '2026-11-22T00:00:00Z', proves: ['j-up'], passed: false }] },
  { id: 'trash', name: 'Trash', what: 'Deleted things wait thirty days before they go.' },
];

test('the feature explorer joins each feature to its screens, flags, journeys and evidence, and names what points at nothing', () => {
  const ex = new Explorer(features, { surfaces: [surface('files', '/files')], flags: sources().flags! });
  const f = ex.open('share')!;
  assert.deepEqual(f.surfaces, [{ id: 'files', title: 'The files screen', path: '/files' }]);
  assert.deepEqual(f.flags, [{ key: 'new-editor', state: 'on for some people' }, { key: 'nope', state: 'missing' }]);
  assert.deepEqual(f.journeys.map((j) => [j.id, j.evidence.map((e) => e.id)]), [['j-share', ['e1']], ['j-revoke', []]]);
  assert.deepEqual(f.problems, ['It names a screen, ghost, that is not registered.', 'It names a flag, nope, that does not exist.', 'Evidence e2 proves a journey, j-other, the feature does not have.', 'Journey j-revoke has no evidence.']);
  assert.equal(f.status, 'attention');
  assert.deepEqual(f.history.map((h) => h.at), ['2026-11-01', '2026-10-01'], 'newest change first');
  assert.equal(f.path, '/admin/features/share');
  assert.equal(f.audit, '/admin/audit?feature=share');
  assert.deepEqual(ex.open('upload')!.problems, ['Journey j-up is failing.']);
  assert.equal(ex.open('upload')!.status, 'action');
  assert.deepEqual(ex.open('trash')!.problems, ['No journey proves this feature.']);
  assert.equal(ex.open('nothing'), undefined);
  assert.deepEqual(ex.list().map((x) => [x.name, x.status, x.journeys, x.evidence]), [['Share a folder', 'attention', 2, 2], ['Trash', 'action', 0, 0], ['Upload files', 'action', 1, 1]]);
  assert.throws(() => new Explorer([features[2]!, features[2]!]), /two features are called trash/);
});

test('the feature explorer finds features by name first, then by what they do, their parts and their journeys', () => {
  const ex = new Explorer(features, { surfaces: [surface('files', '/files')] });
  assert.deepEqual(ex.search('upl').map((r) => r.id), ['upload']);
  assert.deepEqual(ex.search('trash').map((r) => [r.id, r.matched]), [['trash', 'Trash']]);
  assert.deepEqual(ex.search('colleague').map((r) => [r.id, r.matched]), [['share', 'Share a folder with a colleague']], 'a journey goal is searched');
  assert.deepEqual(ex.search('grants').map((r) => [r.id, r.matched]), [['share', 'grants']], 'a part is searched');
  assert.deepEqual(ex.search('thirty days').map((r) => r.id), ['trash']);
  assert.deepEqual(ex.search('   '), []);
  assert.deepEqual(ex.search('zzzz'), []);
  assert.deepEqual(ex.search('share').map((r) => r.id), ['share'], 'letters scattered through another feature’s sentences do not match');
});

// ---- Every section: its title, the permission it needs, each item's words, status and path. ----

const only = (src: Partial<Sources>, o?: Parameters<typeof sections>[1]) => sections({ now: NOW, ...src }, o);
const items = (src: Partial<Sources>, o?: Parameters<typeof sections>[1]) => only(src, o).flatMap((s) => s.items);

test('every section has its own title and asks for its own permission, and each item opens at its own path', () => {
  const s = sections(sources());
  assert.deepEqual(s.map((x) => [x.id, x.title, [...new Set(x.items.map((i) => i.permission))]]), [
    ['service', 'Service', ['admin:service']],
    ['incidents', 'Incidents', ['admin:service']],
    ['housekeeping', 'Housekeeping', ['admin:housekeeping']],
    ['jobs', 'Background jobs', ['admin:jobs']],
    ['backups', 'Backups', ['admin:backups']],
    ['upkeep', 'Dependencies', ['admin:upkeep']],
    ['expiries', 'Things that expire', ['admin:upkeep']],
    ['flags', 'Feature flags', ['admin:flags']],
    ['screens', 'Screens', ['admin:screens']],
  ]);
  assert.deepEqual(s.flatMap((x) => x.items.map((i) => [i.id, i.path])), [
    ['service:readiness', '/admin/service'],
    ['service:slo-Requests succeed', '/admin/service/objectives/Requests%20succeed'],
    ['incidents:1', '/admin/incidents/1'],
    ['incidents:2', '/admin/incidents/2'],
    ['housekeeping:key-rotation', '/admin/housekeeping/key-rotation'],
    ['housekeeping:orphan-sweep', '/admin/housekeeping/orphan-sweep'],
    ['housekeeping:session-sweep', '/admin/housekeeping/session-sweep'],
    ['jobs:email', '/admin/jobs/email'],
    ['jobs:thumbnail', '/admin/jobs/thumbnail'],
    ['jobs:index', '/admin/jobs/index'],
    ['backups:drill', '/admin/backups'],
    ['upkeep:xmldom', '/admin/upkeep/xmldom'],
    ['upkeep:left-pad', '/admin/upkeep/left-pad'],
    ['expiries:api.example.org certificate', '/admin/upkeep/expiring/api.example.org%20certificate'],
    ['expiries:example.org domain', '/admin/upkeep/expiring/example.org%20domain'],
    ['flags:kill-me', '/admin/flags/kill-me'],
    ['flags:old-banner', '/admin/flags/old-banner'],
    ['flags:new-editor', '/admin/flags/new-editor'],
    ['screens:files', '/admin/screens/files'],
  ]);
  assert.deepEqual(s.find((x) => x.id === 'screens')!.items[0], { id: 'screens:files', title: 'The files screen', status: 'ok', reason: 'Shows the files for the people who use it. For admin.', path: '/admin/screens/files', permission: 'admin:screens' });
});

test('a screen for several audiences names them all, and a section holding a worse item is as bad as its worst', () => {
  const two = { ...surface('files', '/files'), audience: ['admin', 'support'] };
  assert.equal(items({ surfaces: [two] })[0]!.reason, 'Shows the files for the people who use it. For admin, support.');
  const s = only({ flags: [{ key: 'a', description: '', owner: 'o', on: true, removeBy: '2027-01-01' }, { key: 'b', description: '', owner: 'o', on: true, killed: true, removeBy: '2027-01-01' }] });
  assert.deepEqual([s[0]!.status, s[0]!.items.map((i) => [i.title, i.status])], ['attention', [['b', 'attention'], ['a', 'ok']]]);
});

test('readiness: down needs action, degraded needs attention, up is fine, and each failing check is named', () => {
  const ready = (r: Sources['readiness']) => items({ readiness: r! })[0]!;
  const up = ready({ status: 'ok', checks: [{ name: 'database', ok: true, ms: 1 }, { name: 'search', ok: true, ms: 1 }] });
  assert.deepEqual([up.status, up.reason], ['ok', 'All 2 checks answered.']);
  assert.equal(ready({ status: 'ok', checks: [{ name: 'database', ok: true, ms: 1 }] }).reason, 'All 1 check answered.');
  const down = ready({ status: 'down', checks: [{ name: 'database', ok: false, ms: 1, error: 'refused' }, { name: 'search', ok: false, ms: 1 }, { name: 'cache', ok: true, ms: 1 }] });
  assert.deepEqual([down.status, down.reason], ['action', 'database is not answering (refused); search is not answering.']);
  assert.equal(ready({ status: 'degraded', checks: [{ name: 'search', ok: false, ms: 1 }] }).status, 'attention');
});

test('an objective needs action when its budget is gone or a page fires, attention when a ticket fires or under a quarter is left', () => {
  const slo = (good: number, total: number, windows?: Record<string, { good: number; total: number }>) => items({ objectives: [{ objective: { name: 'Up', target: 0.99, windowDays: 30 }, window: { good, total }, ...(windows ? { windows } : {}) }] })[0]!;
  const spent = slo(980, 1000);
  assert.deepEqual([spent.status, spent.reason], ['action', 'The error budget is spent: 20 failures against 10 allowed.']);
  const exactly = slo(990, 1000);
  assert.deepEqual([exactly.status, exactly.reason], ['attention', '0% of the error budget is left.'], 'a budget used to the last failure is not yet spent');
  const quarter = slo(3970, 4000);
  assert.deepEqual([quarter.status, quarter.reason], ['ok', '25% of the error budget is left.']);
  const low = slo(4962, 5000);
  assert.deepEqual([low.status, low.reason], ['attention', '24% of the error budget is left.']);
  const calm = slo(999, 1000);
  assert.deepEqual([calm.status, calm.reason], ['ok', '90% of the error budget is left.']);
  const ticket = slo(999, 1000, { '3d': { good: 90, total: 100 }, '6h': { good: 90, total: 100 } });
  assert.deepEqual([ticket.status, ticket.reason], ['attention', 'Up burning 10.0x over 3d and 10.0x over 6h (limit 1x).']);
  const quiet = slo(999, 1000, { '3d': { good: 100, total: 100 }, '6h': { good: 100, total: 100 } });
  assert.equal(quiet.status, 'ok');
  const none = items({ objectives: [{ objective: { name: 'Up', target: 1, windowDays: 30 }, window: { good: 5, total: 5 } }] })[0]!;
  assert.deepEqual([none.status, none.reason], ['ok', '100% of the error budget is left.']);
  const failing = items({ objectives: [{ objective: { name: 'Up', target: 1, windowDays: 30 }, window: { good: 4, total: 5 } }] })[0]!;
  assert.deepEqual([failing.status, failing.reason], ['action', 'The error budget is spent: 1 failures against 0 allowed.']);
});

test('incidents: an open one needs action; a resolved serious one needs a postmortem; a resolved minor one is not listed', () => {
  const inc = new Incidents(() => new Date(NOW - 3 * H));
  inc.open('Open one', 3);
  const two = inc.open('Resolved sev2', 2);
  inc.update(two.id, 'resolved', 'fixed');
  const three = inc.open('Resolved sev3', 3);
  inc.update(three.id, 'resolved', 'fixed');
  const rows = items({ incidents: inc.list });
  assert.deepEqual(rows.map((i) => [i.id, i.title, i.status, i.reason, i.path, i.permission]), [
    ['incidents:1', 'Open one', 'action', 'Severity 3, investigating since 2026-11-27 09:00.', '/admin/incidents/1', 'admin:service'],
    ['incidents:2', 'Resolved sev2', 'attention', 'Resolved, and still owes a postmortem.', '/admin/incidents/2', 'admin:service'],
  ]);
});

test('a chore that ran twice is described by its latest run, and each kind of trouble has its own weight', () => {
  const chore = (name: string) => ({ job: { name, everyMin: 60, graceMin: 10, maxMin: 5 }, title: name, kind: 'sweep' as const });
  const at = (m: number) => NOW - m * 60_000;
  const hk = (checkIns: Sources['housekeeping'] extends infer H ? (H extends { checkIns: infer C } ? C : never) : never) => items({ housekeeping: { chores: [chore('a')], checkIns } })[0]!;
  const twice = hk([{ job: 'a', run: 'r1', at: at(90), kind: 'start' }, { job: 'a', run: 'r1', at: at(89), kind: 'end', ok: true }, { job: 'a', run: 'r2', at: at(30), kind: 'start' }, { job: 'a', run: 'r2', at: at(29), kind: 'end', ok: true }]);
  assert.deepEqual([twice.status, twice.reason], ['ok', 'Last ran 2026-11-27 11:30. Next due 2026-11-27 12:30.']);
  const failed = hk([{ job: 'a', run: 'r1', at: at(30), kind: 'start' }, { job: 'a', run: 'r1', at: at(29), kind: 'end', ok: false }]);
  assert.deepEqual([failed.status, failed.reason], ['action', 'Last ran 2026-11-27 11:30. Next due 2026-11-27 12:30. Failed: run r1 ended in failure.']);
  const overlong = hk([{ job: 'a', run: 'r1', at: at(30), kind: 'start' }, { job: 'a', run: 'r1', at: at(20), kind: 'end', ok: true }]);
  assert.deepEqual([overlong.status, overlong.reason], ['attention', 'Last ran 2026-11-27 11:30. Next due 2026-11-27 12:30. Overlong: run r1 took 10 minutes; allowed 5.']);
  const both = hk([{ job: 'a', run: 'r1', at: at(30), kind: 'start' }, { job: 'a', run: 'r1', at: at(20), kind: 'end', ok: false }]);
  assert.deepEqual([both.status, both.reason], ['action', 'Last ran 2026-11-27 11:30. Next due 2026-11-27 12:30. Overlong: run r1 took 10 minutes; allowed 5. Failed: run r1 ended in failure.']);
});

test('jobs: dead letters need action, jobs more than fifteen minutes past due need attention, anything else is fine', () => {
  const job = (id: string, kind: string, state: 'dead' | 'waiting' | 'done', runAt: number, lastError?: string) => ({ id, kind, payload: null, state, attempts: 1, maxAttempts: 5, runAt, created: NOW - H, ...(lastError ? { lastError } : {}) });
  const rows = items({ jobs: [job('1', 'k-late', 'waiting', NOW - 15 * 60_000 - 1), job('2', 'k-edge', 'waiting', NOW - 15 * 60_000), job('3', 'k-recent', 'waiting', NOW - 14 * 60_000), job('4', 'k-future', 'waiting', NOW + H), job('5', 'k-dead', 'dead', NOW - H), job('6', 'k-done', 'done', NOW - H), job('7', 'k-two', 'dead', NOW - H, 'first'), job('8', 'k-two', 'dead', NOW - H, 'second'), job('9', 'k-late2', 'waiting', NOW - 20 * 60_000), job('10', 'k-late2', 'waiting', NOW - 30 * 60_000)] });
  assert.deepEqual(rows.map((i) => [i.title, i.status, i.reason]), [
    ['k-dead', 'action', '1 job gave up; the last error was "unknown". Fix the cause, then replay.'],
    ['k-two', 'action', '2 jobs gave up; the last error was "second". Fix the cause, then replay.'],
    ['k-done', 'ok', 'Nothing waiting past due and nothing given up.'],
    ['k-edge', 'ok', 'Nothing waiting past due and nothing given up.'],
    ['k-future', 'ok', 'Nothing waiting past due and nothing given up.'],
    ['k-recent', 'ok', 'Nothing waiting past due and nothing given up.'],
    ['k-late', 'attention', '1 job waiting more than 15 minutes past due.'],
    ['k-late2', 'attention', '2 jobs waiting more than 15 minutes past due.'],
  ].sort((a, b) => ({ action: 0, attention: 1, ok: 2 })[a[1]!]! - ({ action: 0, attention: 1, ok: 2 })[b[1]!]! || a[0]!.localeCompare(b[0]!)));
});

test('backups: the newest drill counts however the list is ordered, today is said as today, and every problem is named', () => {
  const drill = (backup: string, ran: string, ok: boolean, problems: string[] = []) => ({ backup, ran, ms: 5, targetMs: 50, ok, collections: [], problems });
  const b = (list: ReturnType<typeof drill>[], everyDays = 7) => items({ drills: { list, everyDays } })[0]!;
  const newest = b([drill('old', '2026-11-01T00:00:00Z', false, ['x']), drill('new', '2026-11-27T01:00:00Z', true)]);
  assert.deepEqual([newest.id, newest.title, newest.status, newest.reason, newest.path, newest.permission], ['backups:drill', 'Restore drill', 'ok', 'Restored new today in 5 ms, every collection matched.', '/admin/backups', 'admin:backups']);
  const reversed = b([drill('new', '2026-11-27T01:00:00Z', true), drill('old', '2026-11-01T00:00:00Z', false, ['x'])]);
  assert.equal(reversed.reason, 'Restored new today in 5 ms, every collection matched.');
  assert.equal(b([drill('a', '2026-11-26T00:00:00Z', true)]).reason, 'Restored a 1 day ago in 5 ms, every collection matched.');
  assert.equal(b([drill('a', '2026-11-27T00:00:00Z', false, ['one', 'two'])]).reason, 'The last restore drill failed: one; two.');
  assert.deepEqual([b([drill('a', '2026-11-20T00:00:00Z', true)]).status, b([drill('a', '2026-11-19T00:00:00Z', true)]).status], ['ok', 'attention']);
  assert.equal(b([drill('a', '2026-11-26T00:00:00Z', true)], 1).reason, 'Restored a 1 day ago in 5 ms, every collection matched.');
  assert.equal(b([drill('a', '2026-11-25T00:00:00Z', true)], 1).reason, 'Restored a 2 days ago in 5 ms, every collection matched. Drills are due every 1 day.');
});

test('dependencies: urgent needs action, update needs attention, fine is fine, each in its own words', () => {
  const rows = items({ dependencies: review([{ name: 'a-fine', version: '1.0.0', latest: '1.0.0' }, { name: 'b-old', version: '1.0.0', latest: '2.0.0' }, { name: 'c-bad', version: '1.0.0', latest: '1.0.0' }], [{ package: 'c-bad', id: 'GHSA-9', severity: 'high', fixedIn: '1.0.1' }], { today: '2026-11-27' }) });
  assert.deepEqual(rows.map((i) => [i.title, i.status, i.reason, i.path]), [
    ['c-bad', 'action', 'Update now: GHSA-9 (high) is fixed in 1.0.1.', '/admin/upkeep/c-bad'],
    ['b-old', 'attention', 'Update soon: a major version behind (1.0.0 → 2.0.0).', '/admin/upkeep/b-old'],
    ['a-fine', 'ok', 'Fine: current.', '/admin/upkeep/a-fine'],
  ]);
});

test('expiries: past is action with how long ago, soon is attention, far off is fine', () => {
  const rows = items({ expiries: expiry([{ what: 'gone', kind: 'certificate', expires: '2026-11-25', owner: 'Ops' }, { what: 'today', kind: 'domain', expires: '2026-11-27', owner: 'Ops' }, { what: 'near', kind: 'domain', expires: '2026-12-10', owner: 'Ann' }, { what: 'far', kind: 'domain', expires: '2027-06-01', owner: 'Bo' }], '2026-11-27') });
  assert.deepEqual(rows.map((i) => [i.title, i.status, i.reason, i.path]), [
    ['gone', 'action', 'Expired 2 days ago. Ops renews it.', '/admin/upkeep/expiring/gone'],
    ['today', 'action', 'Expired 0 days ago. Ops renews it.', '/admin/upkeep/expiring/today'],
    ['near', 'attention', '13 days left. Ann renews it.', '/admin/upkeep/expiring/near'],
    ['far', 'ok', '186 days left. Bo renews it.', '/admin/upkeep/expiring/far'],
  ]);
  assert.equal(items({ expiries: expiry([{ what: 'one', kind: 'domain', expires: '2026-11-28', owner: 'Ops' }], '2026-11-27') })[0]!.reason, '1 day left. Ops renews it.');
  assert.equal(items({ expiries: expiry([{ what: 'one', kind: 'domain', expires: '2026-11-26', owner: 'Ops' }], '2026-11-27') })[0]!.reason, 'Expired 1 day ago. Ops renews it.');
});

test('flags: how each is switched, whether it has a removal date, and whether that date has passed', () => {
  const flag = (key: string, extra: Record<string, unknown>) => ({ key, description: '', owner: 'web team', on: true, ...extra }) as Sources['flags'] extends readonly (infer F)[] | undefined ? F : never;
  const rows = items({ flags: [flag('everyone', { removeBy: '2027-01-01' }), flag('one-rule', { rules: [{ percent: 5 }], removeBy: '2027-01-01' }), flag('two-rules', { rules: [{ percent: 5 }, { percent: 6 }], removeBy: '2027-01-01' }), flag('off', { on: false, removeBy: '2027-01-01' }), flag('no-date', {}), flag('today', { removeBy: '2026-11-27' }), flag('yesterday', { removeBy: '2026-11-26' }), flag('spaced key', { removeBy: '2027-01-01' })] });
  assert.deepEqual(rows.map((i) => [i.title, i.status, i.reason, i.path]), [
    ['no-date', 'attention', 'On for everyone. It has no removal date. web team owns it.', '/admin/flags/no-date'],
    ['yesterday', 'attention', 'On for everyone. It was due out of the code by 2026-11-26. web team owns it.', '/admin/flags/yesterday'],
    ['everyone', 'ok', 'On for everyone. Due out of the code by 2027-01-01. web team owns it.', '/admin/flags/everyone'],
    ['off', 'ok', 'Off. Due out of the code by 2027-01-01. web team owns it.', '/admin/flags/off'],
    ['one-rule', 'ok', 'On by 1 rule. Due out of the code by 2027-01-01. web team owns it.', '/admin/flags/one-rule'],
    ['spaced key', 'ok', 'On for everyone. Due out of the code by 2027-01-01. web team owns it.', '/admin/flags/spaced%20key'],
    ['today', 'ok', 'On for everyone. Due out of the code by 2026-11-27. web team owns it.', '/admin/flags/today'],
    ['two-rules', 'ok', 'On by 2 rules. Due out of the code by 2027-01-01. web team owns it.', '/admin/flags/two-rules'],
  ].sort((a, b) => ({ action: 0, attention: 1, ok: 2 })[a[1]!]! - ({ action: 0, attention: 1, ok: 2 })[b[1]!]! || a[0]!.localeCompare(b[0]!)));
});

test('the same sources under another base and other permissions keep their order and say where to open each', () => {
  const rows = items({ flags: [{ key: 'k', description: '', owner: 'o', on: true, removeBy: '2027-01-01' }] }, { base: '/ops/', permissions: { flags: 'ops:flags' } });
  assert.deepEqual(rows.map((i) => [i.path, i.permission]), [['/ops/flags/k', 'ops:flags']]);
});

test('the view reports each visible section by its own visible items and counts and says what is fine in the singular', () => {
  const v = view(sources(), (p) => p === 'admin:jobs' || p === 'admin:backups');
  assert.deepEqual(v.sections.map((s) => [s.id, s.status]), [['jobs', 'action'], ['backups', 'ok']]);
  assert.equal(v.summary, '1 needs action, 1 needs attention, 2 are fine.');
  const single = view(sources(), (p) => p === 'admin:backups');
  assert.deepEqual(single.sections.map((s) => [s.id, s.status]), [['backups', 'ok']]);
  assert.equal(single.summary, 'Everything is fine: 1 item checked.');
  assert.equal(summarise({ ok: 1, attention: 0, action: 2 }), '2 need action, 1 is fine.');
  assert.equal(summarise({ ok: 2, attention: 1, action: 0 }), '1 needs attention, 2 are fine.');
  assert.equal(summarise({ ok: 0, attention: 2, action: 0 }), '2 need attention.');
});

test('rendering names each status in words, quotes are escaped, and sections carry their status', () => {
  const v = view({ now: NOW, flags: [{ key: 'say "hi" it\'s', description: '', owner: 'o', on: true, killed: true, removeBy: '2027-01-01' }], incidents: [{ id: 7, title: 'Down', severity: 1, status: 'investigating', started: '2026-11-27T10:00:00Z', timeline: [] }] }, all);
  assert.equal(html(v), '<main><p role="status">1 needs action, 1 needs attention.</p>'
    + '<section data-status="action"><h2>Incidents <small>Needs action</small></h2><ul><li data-status="action"><a href="/admin/incidents/7">Down</a> <strong>Needs action</strong> <span>Severity 1, investigating since 2026-11-27 10:00.</span></li></ul></section>'
    + '<section data-status="attention"><h2>Feature flags <small>Needs attention</small></h2><ul><li data-status="attention"><a href="/admin/flags/say%20%22hi%22%20it&#39;s">say &quot;hi&quot; it&#39;s</a> <strong>Needs attention</strong> <span>Switched off for everyone. Due out of the code by 2027-01-01. o owns it.</span></li></ul></section></main>');
});

// ---- The feature explorer in full. ----

const flagsFor = (list: Record<string, unknown>[]) => list.map((f) => ({ description: '', owner: 'o', on: true, ...f })) as unknown as NonNullable<Sources['flags']>;

test('a flag reads as off, switched off for everyone, on for some people or on for everyone, and a missing one as missing', () => {
  const ex = new Explorer([{ id: 'f', name: 'F', what: 'w', flags: ['rules', 'killed', 'off', 'plain', 'gone'] }], { flags: flagsFor([{ key: 'rules', rules: [{ percent: 5 }] }, { key: 'killed', killed: true }, { key: 'off', on: false }, { key: 'plain' }]) });
  assert.deepEqual(ex.open('f')!.flags, [{ key: 'rules', state: 'on for some people' }, { key: 'killed', state: 'switched off for everyone' }, { key: 'off', state: 'off' }, { key: 'plain', state: 'on for everyone' }, { key: 'gone', state: 'missing' }]);
  const empty = new Explorer([{ id: 'f', name: 'F', what: 'w', flags: ['e'] }], { flags: flagsFor([{ key: 'e', rules: [] }]) });
  assert.deepEqual(empty.open('f')!.flags, [{ key: 'e', state: 'on for everyone' }]);
});

test('a feature with nothing declared opens empty, with the base it was given; one fully declared opens with everything it declared', () => {
  const ex = new Explorer([{ id: 'bare', name: 'Bare', what: 'Nothing much.' }], { base: '/console/' });
  assert.deepEqual(ex.open('bare'), { id: 'bare', name: 'Bare', what: 'Nothing much.', status: 'action', path: '/console/features/bare', parts: [], data: [], surfaces: [], flags: [], journeys: [], evidence: [], permissions: [], history: [], audit: null, problems: ['No journey proves this feature.'] });
  const full = new Explorer(features, { surfaces: [surface('files', '/files')], flags: sources().flags! }).open('share')!;
  assert.deepEqual(full.parts, ['grants', 'audit']);
  assert.deepEqual(full.data, ['grants']);
  assert.deepEqual(full.permissions, [{ role: 'owner', may: ['share', 'revoke'] }]);
  assert.deepEqual(full.evidence.map((e) => e.id), ['e2', 'e1'], 'newest evidence first');
});

test('a clean feature is ok; a journey fails by its own status or by its newest evidence failing, and a failing journey is named once', () => {
  const ev = (id: string, at: string, passed?: boolean) => ({ id, kind: 'test' as const, href: `/e/${id}`, at, proves: ['j'], ...(passed === undefined ? {} : { passed }) });
  const feat = (status: string, evidence: ReturnType<typeof ev>[]): Feature => ({ id: 'x', name: 'X', what: 'w', journeys: [{ id: 'j', persona: 'p', goal: 'g', status }], evidence });
  const open = (f: Feature) => new Explorer([f]).open('x')!;
  const clean = open(feat('pass', [ev('e1', '2026-11-01', true)]));
  assert.deepEqual([clean.status, clean.problems], ['ok', []]);
  const byStatus = open(feat('fail', [ev('e1', '2026-11-01', true)]));
  assert.deepEqual([byStatus.status, byStatus.problems], ['action', ['Journey j is failing.']]);
  const byEvidence = open(feat('pass', [ev('e1', '2026-11-01', false)]));
  assert.deepEqual([byEvidence.status, byEvidence.problems], ['action', ['Journey j is failing.']]);
  const newestPassing = open(feat('pass', [ev('old', '2026-11-01', false), ev('new', '2026-11-05', true)]));
  assert.deepEqual([newestPassing.status, newestPassing.problems], ['ok', []], 'only the newest evidence counts');
  const newestFirst = open(feat('pass', [ev('new', '2026-11-05', false), ev('old', '2026-11-01', true)]));
  assert.equal(newestFirst.status, 'action');
  const unjudged = open(feat('pass', [ev('e1', '2026-11-01')]));
  assert.equal(unjudged.status, 'ok');
  const none = open(feat('fail', []));
  assert.deepEqual(none.problems, ['Journey j has no evidence.', 'Journey j is failing.']);
});

test('search ranks a whole match over a scattered one, the name over what it does, best first, ties by name, and honours the limit', () => {
  const f = (id: string, name: string, what: string, extra: Partial<Feature> = {}): Feature => ({ id, name, what, ...extra });
  const ex = new Explorer([f('1', 'Billing', 'Charges for plans'), f('2', 'Plans', 'Billing happens here'), f('3', 'Bills', 'Another thing'), f('4', 'Alpha', 'a', { parts: ['Billing', 'billing'] }), f('5', 'Zeta', 'z', { parts: ['Billing'] }), f('6', 'Beta', 'b', { parts: ['Billing'] })]);
  const all = ex.search('billing');
  assert.deepEqual(all.map((r) => [r.id, r.matched]), [['1', 'Billing'], ['2', 'Billing happens here'], ['4', 'Billing'], ['6', 'Billing'], ['5', 'Billing']]);
  assert.ok(all.every((r, i) => i === 0 || all[i - 1]!.score >= r.score), 'best first');
  assert.ok(all[0]!.score > all[1]!.score && all[1]!.score > all[2]!.score);
  assert.deepEqual([all[2]!.score === all[3]!.score, all[3]!.score === all[4]!.score], [true, true], 'equal scores are broken by name');
  assert.deepEqual(ex.search('billing', 2).map((r) => r.id), ['1', '2']);
  assert.deepEqual(ex.search('billing', 3).map((r) => r.id), ['1', '2', '4']);
  assert.ok(all.every((r) => Math.round(r.score * 100) / 100 === r.score), 'scores are kept to two places');
  assert.ok(all[0]!.score > 100 && all[0]!.score < 110, 'a whole-name match scores well above a part match');
});

test('letters scattered across a long sentence do not match unless they score well, and spaces in the query do not count as letters', () => {
  const ex = new Explorer([{ id: 'a', name: 'Alpha', what: 'a long sentence about nothing in particular at all, really' }]);
  assert.deepEqual(ex.search('sentence about').map((r) => r.id), ['a']);
  assert.deepEqual(ex.search('s a n d').map((r) => r.id), [], 'single letters far apart are not a match');
  assert.deepEqual(ex.search('qqq'), []);
});

test('a word that appears whole in a long description is found, however long the description is', () => {
  const long = `${'This feature does many things for people. '.repeat(30)}It also handles zebra crossings.`;
  const ex = new Explorer([{ id: 'a', name: 'Alpha', what: long }, { id: 'b', name: 'Beta', what: 'Short and unrelated.' }]);
  assert.deepEqual(ex.search('zebra').map((r) => [r.id, r.matched === long]), [['a', true]]);
});

test('initials and loosely typed letters find a feature by name, with or without spaces, and the strongest field is the one reported', () => {
  const ex = new Explorer([{ id: 'c', name: 'Share a folder', what: 'x' }, { id: 'b', name: 'A tiny pep rally', what: 'w', parts: ['pep'] }]);
  assert.deepEqual(ex.search('sf').map((r) => [r.id, r.matched]), [['c', 'Share a folder']]);
  assert.deepEqual(ex.search('s f').map((r) => [r.id, r.matched]), [['c', 'Share a folder']]);
  assert.deepEqual(ex.search('pep').map((r) => [r.id, r.matched]), [['b', 'pep']], 'a part that matches whole beats a name that matches inside');
});

test('rendering joins the items of a section and the sections of a page without anything between them', () => {
  const v = view({ now: NOW, flags: [{ key: 'a', description: '', owner: 'o', on: true, removeBy: '2027-01-01' }, { key: 'b', description: '', owner: 'o', on: true, removeBy: '2027-01-01' }] }, all);
  assert.equal(html(v), '<main><p role="status">Everything is fine: 2 items checked.</p><section data-status="ok"><h2>Feature flags <small>Fine</small></h2><ul><li data-status="ok"><a href="/admin/flags/a">a</a> <strong>Fine</strong> <span>On for everyone. Due out of the code by 2027-01-01. o owns it.</span></li><li data-status="ok"><a href="/admin/flags/b">b</a> <strong>Fine</strong> <span>On for everyone. Due out of the code by 2027-01-01. o owns it.</span></li></ul></section></main>');
});
