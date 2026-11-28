import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { signature } from '../webhooks/index.ts';
import { ActionSigner, BadSignature, BadToken, BotTokens, Dispatcher, InteractiveReceiver, MemoryDirectory, Modals, ResponseUrls, SlashError, blockProblems, escapeMarkup, later, mention, parseCommandLine, parseForm, replyJson, signRequest, tokenize, verifyRequest, viewProblems, type Block, type Deps, type View } from './index.ts';

// Everything secret is derived when the test runs; nothing credential-shaped is written in the file.
const derive = (label: string) => createHash('sha256').update(`slash-commands test ${label}`).digest('hex');
const KEY = derive('request signing');
const KEY2 = derive('rotated signing');

function deps(start = 1_700_000_000_000): Deps & { t: number } {
  let n = 0;
  const d = {
    t: start,
    now: () => d.t,
    random: (len: number) => {
      let out = Buffer.alloc(0);
      while (out.length < len) out = Buffer.concat([out, createHash('sha256').update(`r${++n}`).digest()]);
      return out.subarray(0, len);
    },
  };
  return d;
}

const form = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const signed = (d: { t: number }, body: string, key = KEY) => {
  const ts = Math.floor(d.t / 1000);
  return { body, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': signRequest(key, ts, body) } };
};

function bot(extra: { modals?: boolean } = {}) {
  const d = deps();
  const directory = new MemoryDirectory().add('C1', 'public', ['U1', 'U2']).add('G1', 'private', ['U1']).add('D1', 'dm', ['U1']);
  const responseUrls = new ResponseUrls(d);
  const modals = extra.modals ? new Modals(d) : undefined;
  const disp = new Dispatcher({ ...d, secrets: [KEY], directory, responseUrls, ...(modals ? { modals } : {}) });
  disp.register({ name: '/echo', summary: 'Say it back', usage: '/echo <words>', minArgs: 1, maxArgs: 3, run: (c) => ({ text: `you said: ${escapeMarkup(c.args.join(' '))}`, visibility: 'in_channel' }) });
  const call = (o: Record<string, string>) => disp.handle(signed(d, form({ channel_id: 'C1', user_id: 'U1', ...o })));
  return { d, disp, call, responseUrls, directory, modals };
}

test('command lines are read with quotes, escapes and sensible limits', () => {
  assert.deepEqual(tokenize('deploy prod "my app" --force'), ['deploy', 'prod', 'my app', '--force']);
  assert.deepEqual(tokenize('say "he said \\"hi\\"" ok'), ['say', 'he said "hi"', 'ok']);
  assert.deepEqual(tokenize('a “curly quoted” b'), ['a', 'curly quoted', 'b']);
  assert.deepEqual(tokenize('x "" y'), ['x', '', 'y'], 'an empty quoted argument is kept');
  assert.deepEqual(tokenize('  spaced \t out  '), ['spaced', 'out']);
  assert.deepEqual(tokenize(''), []);
  assert.throws(() => tokenize('open "never closed'), /never closed/);
  assert.throws(() => tokenize(Array(60).fill('a').join(' ')), /more than 50/);
  assert.throws(() => tokenize('x'.repeat(1001)), /longer than 1000/);
  assert.deepEqual(parseCommandLine('/deploy prod "app one"'), { name: '/deploy', args: ['prod', 'app one'] });
  for (const bad of ['deploy', '/Deploy', '/', '/a/b', '']) assert.throws(() => parseCommandLine(bad), SlashError, bad);
});

test('form bodies decode exactly, and hostile ones are bounded', () => {
  assert.deepEqual({ ...parseForm('a=1&b=hello+world&c=%2Fdeploy&d=&e') }, { a: '1', b: 'hello world', c: '/deploy', d: '', e: '' });
  assert.equal(parseForm('a=first&a=second').a, 'first');
  assert.equal(Object.keys(parseForm('__proto__=x&ok=1')).join(), 'ok');
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.throws(() => parseForm('a=%E0%A4%A'), /percent-encoding/);
  assert.throws(() => parseForm(Array(101).fill('a=1').join('&')), /too many/);
  assert.deepEqual({ ...parseForm('') }, {});
});

test('request signatures are v0 HMAC-SHA-256 of the timestamp and exact body, checked in time and in constant time', () => {
  const d = deps();
  const body = form({ command: '/echo', text: 'hi' });
  const ts = Math.floor(d.t / 1000);
  const expected = `v0=${createHmac('sha256', KEY).update(`v0:${ts}:${body}`).digest('hex')}`;
  assert.equal(signRequest(KEY, ts, body), expected);
  const h = { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': expected };
  assert.doesNotThrow(() => verifyRequest([KEY], h, body, { now: d.now }));
  assert.doesNotThrow(() => verifyRequest([KEY2, KEY], h, body, { now: d.now }), 'either key while rotating');
  assert.throws(() => verifyRequest([KEY], h, body + ' ', { now: d.now }), /does not match/);
  assert.throws(() => verifyRequest([KEY2], h, body, { now: d.now }), BadSignature);
  assert.throws(() => verifyRequest([KEY], { ...h, 'x-slack-signature': expected.toUpperCase() }, body, { now: d.now }), /expected form/);
  assert.throws(() => verifyRequest([KEY], {}, body, { now: d.now }), /expected form/);
  d.t += 301_000;
  assert.throws(() => verifyRequest([KEY], h, body, { now: d.now }), /too old/);
  d.t -= 700_000;
  assert.throws(() => verifyRequest([KEY], h, body, { now: d.now }), /future/);
  assert.doesNotThrow(() => verifyRequest([KEY], h, body, { now: d.now, toleranceSec: 3600 }));
});

test('a signed command runs and its reply is shaped for the platform, with the user text escaped', async () => {
  const { call } = bot();
  const r = await call({ command: '/echo', text: 'a <b> &' });
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'application/json');
  assert.deepEqual(JSON.parse(r.body), { response_type: 'in_channel', text: 'you said: a &lt;b&gt; &amp;' });
});

test('unsigned, stale, replayed and oversized requests are refused before anything is read', async () => {
  const { disp, d, call } = bot();
  const body = form({ command: '/echo', text: 'x', channel_id: 'C1', user_id: 'U1' });
  assert.equal((await disp.handle({ headers: {}, body })).status, 401);
  const req = signed(d, body);
  assert.equal((await disp.handle({ ...req, headers: { ...req.headers, 'x-slack-signature': `v0=${'0'.repeat(64)}` } })).status, 401);
  assert.equal((await disp.handle(req)).status, 200);
  const again = await disp.handle(req);
  assert.deepEqual([again.status, again.body], [401, 'this request was already received']);
  const stale = signed(d, body + '&n=1');
  d.t += 600_000;
  assert.equal((await disp.handle(stale)).status, 401);
  assert.equal((await disp.handle({ headers: {}, body: 'x'.repeat(70_000) })).status, 413);
  assert.equal((await call({ text: 'x' })).status, 400, 'no command field');
});

test('who may run a command, where, and with how many arguments', async () => {
  const { disp, call } = bot();
  disp.register({ name: '/admin', summary: 'Admins only', kinds: ['public', 'private'], allow: (c) => c.user === 'U1', run: () => ({ text: 'done' }) });
  disp.register({ name: '/boom', summary: 'Fails', run: () => { throw new Error('secret internals'); } });
  const text = async (o: Record<string, string>) => (JSON.parse((await call(o)).body) as { text: string }).text;
  assert.match(await text({ command: '/nope' }), /Unknown command \/nope/);
  assert.equal(await text({ command: '/echo' }), 'Usage: /echo <words>');
  assert.equal(await text({ command: '/echo', text: 'a b c d' }), 'Usage: /echo <words>');
  assert.match(await text({ command: '/echo', text: '"open' }), /Could not read the arguments/);
  assert.match(await text({ command: '/echo', user_id: 'U9', text: 'hi' }), /need to be in this channel/);
  assert.match(await text({ command: '/echo', channel_id: 'nowhere', text: 'hi' }), /need to be in this channel/);
  assert.equal(await text({ command: '/admin' }), 'done');
  assert.match(await text({ command: '/admin', user_id: 'U2' }), /not allowed/);
  assert.match(await text({ command: '/admin', channel_id: 'D1' }), /cannot be used in direct messages/);
  const boom = await text({ command: '/boom' });
  assert.ok(!boom.includes('secret internals'), 'handler errors are not shown to the user');
  assert.throws(() => disp.register({ name: '/echo', summary: 'again', run: () => undefined }), /already registered/);
  assert.throws(() => disp.register({ name: 'bad', summary: 'x', run: () => undefined }), /bad command name/);
});

test('help lists only what this user may run in this channel', () => {
  const { disp } = bot();
  disp.register({ name: '/admin', summary: 'Admins only', kinds: ['private'], run: () => undefined });
  assert.deepEqual(disp.help('U1', 'C1'), [{ name: '/echo', summary: 'Say it back', usage: '/echo <words>' }]);
  assert.deepEqual(disp.help('U1', 'G1').map((c) => c.name), ['/admin', '/echo']);
  assert.deepEqual(disp.help('U2', 'G1'), [], 'not a member');
  assert.deepEqual(disp.help('U1', 'nowhere'), []);
});

test('slow work is acknowledged at once and delivered to the response URL', async () => {
  const { disp, call, responseUrls } = bot();
  let finish!: (r: { text: string }) => void;
  disp.register({ name: '/slow', summary: 'Takes a while', run: () => later(new Promise((res) => (finish = res))) });
  disp.register({ name: '/fail', summary: 'Fails later', run: () => later(Promise.reject(new Error('x'))) });
  const r = await call({ command: '/slow' });
  assert.deepEqual([r.status, r.body], [200, '']);
  finish({ text: 'all done' });
  await Promise.all(disp.background);
  const url = [...(responseUrls as unknown as { all: Map<string, { delivered: unknown[] }> }).all.values()].find((u) => u.delivered.length)!;
  assert.deepEqual(url.delivered, [{ text: 'all done' }]);
  await call({ command: '/fail' });
  await Promise.all(disp.background);
  const all = [...(responseUrls as unknown as { all: Map<string, { delivered: { text: string }[] }> }).all.values()];
  assert.deepEqual(all.at(-1)!.delivered, [{ text: '/fail failed.' }]);
});

test('response URLs expire, are limited in uses, and refuse bad replies', () => {
  const d = deps();
  const urls = new ResponseUrls(d, { base: 'https://chat.example.test/r/', maxUses: 2, ttlMs: 60_000 });
  const u = urls.issue('U1', 'C1');
  assert.ok(u.url.startsWith('https://chat.example.test/r/') && u.id.length === 48);
  urls.post(u.url, { text: 'one' });
  urls.post(u.id, { text: 'two', replaceOriginal: true });
  assert.throws(() => urls.post(u.url, { text: 'three' }), /2 times/);
  assert.deepEqual(u.delivered.map((r) => r.text), ['one', 'two']);
  const v = urls.issue('U1', 'C1');
  assert.throws(() => urls.post(v.url, { text: 'x'.repeat(40_001) }), /40,000/);
  assert.equal(v.uses, 0, 'a refused reply does not use up the URL');
  d.t += 61_000;
  assert.throws(() => urls.post(v.url, { text: 'late' }), /expired/);
  assert.throws(() => urls.post('https://chat.example.test/r/deadbeef', { text: 'x' }), /no such response URL/);
  assert.notEqual(urls.issue('U1', 'C1').id, urls.issue('U1', 'C1').id);
  assert.equal(JSON.parse(replyJson({ text: 'gone', deleteOriginal: true })).delete_original, true);
});

test('action tokens are signed, expire, bind to a user, and can be single use', () => {
  const d = deps();
  const s = new ActionSigner([KEY, KEY2], d);
  const t = s.sign({ action: 'approve', user: 'U1', message: 'm1', value: '42' }, 60);
  assert.deepEqual(s.verify(t, { user: 'U1' }), { action: 'approve', user: 'U1', message: 'm1', value: '42' });
  assert.throws(() => s.verify(t, { user: 'U2' }), /someone else/);
  assert.throws(() => s.verify(t), /someone else/, 'a bound token needs the user');
  const open = s.sign({ action: 'vote' });
  assert.equal(s.verify(open, { user: 'anyone' }).action, 'vote');
  assert.equal(s.verify(open, { once: true }).action, 'vote');
  assert.throws(() => s.verify(open, { once: true }), /already used/);
  const [h, p, sig] = t.split('.') as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ action: 'approve', user: 'U2', exp: 9e9, n: 'x' })).toString('base64url');
  assert.throws(() => s.verify(`${h}.${forged}.${sig}`, { user: 'U2' }), /not signed by us/);
  assert.throws(() => s.verify(`${h}.${p}.${sig.slice(0, -1)}A`, { user: 'U1' }), /not signed by us/);
  assert.throws(() => s.verify('garbage'), /not an action token/);
  assert.throws(() => new ActionSigner([KEY2], d).verify(new ActionSigner(['short'.padEnd(16, 'x')], d).sign({ action: 'x' })), /not signed by us/);
  assert.throws(() => new ActionSigner(['short'], d), /16 characters/);
  d.t += 61_000;
  assert.throws(() => s.verify(t, { user: 'U1' }), /expired/);
  assert.equal(new ActionSigner([KEY2, KEY], d).verify(s.sign({ action: 'old key' })).action, 'old key', 'a rotated-out key still verifies');
});

test('message blocks are checked against the platform limits, all problems at once', () => {
  const ok: Block[] = [
    { type: 'section', block_id: 's', text: { type: 'mrkdwn', text: 'Deploy?' } },
    { type: 'actions', block_id: 'a', elements: [{ type: 'button', action_id: 'yes', text: { type: 'plain_text', text: 'Yes' }, value: 'tok' }, { type: 'static_select', action_id: 'env', options: [{ text: { type: 'plain_text', text: 'Prod' }, value: 'prod' }] }] },
    { type: 'divider' },
  ];
  assert.deepEqual(blockProblems(ok), []);
  const bad: Block[] = [
    { type: 'section' },
    { type: 'section', block_id: 's', text: { type: 'mrkdwn', text: 'x'.repeat(3001) } },
    { type: 'section', block_id: 's', text: { type: 'mrkdwn', text: 'dup id' } },
    { type: 'actions', elements: [{ type: 'button', action_id: 'b', text: 'x'.repeat(76) }, { type: 'button', action_id: 'b', text: 'ok', value: 'v'.repeat(2001) }, { type: 'static_select', action_id: 'c' }] },
    { type: 'input', element: { type: 'plain_text_input' } },
    { type: 'bogus' as never },
  ];
  const p = blockProblems(bad);
  for (const piece of ['a section needs text', 'text is 1 to 3000', 'block_id s is used twice', 'at most 75', 'action_id b is used twice', 'at most 2000', 'a select has 1 to 100', 'an input needs a block_id', 'an input needs a label', 'unknown type bogus']) assert.ok(p.some((x) => x.includes(piece)), piece);
  assert.deepEqual(blockProblems(Array(51).fill({ type: 'divider' })), ['at most 50 blocks']);
  assert.throws(() => replyJson({ text: 'x', blocks: bad }), SlashError);
});

const VIEW: View = {
  type: 'modal', title: 'New ticket', submit: 'Create', callback_id: 'ticket',
  blocks: [
    { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Title' }, element: { type: 'plain_text_input', action_id: 't', min_length: 3, max_length: 10 } },
    { type: 'input', block_id: 'sev', label: { type: 'plain_text', text: 'Severity' }, element: { type: 'static_select', action_id: 's', options: [{ text: { type: 'plain_text', text: 'High' }, value: 'high' }, { text: { type: 'plain_text', text: 'Low' }, value: 'low' }] } },
    { type: 'input', block_id: 'due', optional: true, label: { type: 'plain_text', text: 'Due' }, element: { type: 'datepicker', action_id: 'd' } },
  ],
};

test('a modal opens only with a fresh trigger id, once, for the user it was made for', () => {
  const d = deps();
  const m = new Modals(d);
  const id = m.trigger('U1');
  assert.throws(() => m.open(id, 'U2', VIEW), /another user/);
  assert.throws(() => m.open(id, 'U1', VIEW), /unknown or already used/, 'the failed try spent it');
  const id2 = m.trigger('U1');
  const v = m.open(id2, 'U1', VIEW);
  assert.match(v.id, /^V[0-9A-F]{12}$/);
  assert.throws(() => m.open(id2, 'U1', VIEW), /already used/);
  const id3 = m.trigger('U1');
  d.t += 3001;
  assert.throws(() => m.open(id3, 'U1', VIEW), /three seconds/);
  const id4 = m.trigger('U1');
  assert.throws(() => m.open(id4, 'U1', { ...VIEW, title: 'x'.repeat(25), callback_id: '' }), /title is 1 to 24.*callback_id/);
  assert.deepEqual(viewProblems({ ...VIEW, submit: undefined as never }), ['a modal with inputs needs a submit button']);
});

test('a submission is checked field by field, by block id, and only its own user may send it', () => {
  const m = new Modals(deps());
  const open = () => m.open(m.trigger('U1'), 'U1', VIEW);
  let v = open();
  assert.deepEqual(m.submit(v.id, 'U1', {}), { ok: false, errors: { title: 'This field is required.', sev: 'This field is required.' } });
  assert.deepEqual(m.submit(v.id, 'U1', { title: { t: 'ab' }, sev: { s: 'urgent' }, due: { d: '2026-02-30' } }), { ok: false, errors: { title: 'Enter at least 3 characters.', sev: 'Choose one of the options.', due: 'Enter a real date.' } });
  assert.deepEqual(m.submit(v.id, 'U1', { title: { t: 'x'.repeat(11) }, sev: { s: 'low' } }), { ok: false, errors: { title: 'Enter at most 10 characters.' } });
  assert.throws(() => m.submit(v.id, 'U2', {}), /someone else/);
  assert.throws(() => m.submit(v.id, 'U1', { evil: { t: 'x' } }), /unknown block evil/);
  assert.throws(() => m.submit(v.id, 'U1', { title: { zzz: 'x' } }), /unknown field zzz/);
  const good = m.submit(v.id, 'U1', { title: { t: 'Broken' }, sev: { s: 'high' }, due: { d: '2026-12-31' } });
  assert.equal(good.ok && good.callback_id, 'ticket');
  assert.throws(() => m.submit(v.id, 'U1', {}), /no such view/, 'a submitted modal is closed');
  v = open();
  const updated = m.update(v.id, v.hash, { ...VIEW, title: 'Changed' });
  assert.notEqual(updated.hash, v.hash);
  assert.throws(() => m.update(v.id, v.hash, VIEW), /changed since/);
});

test('bot tokens are shown once, stored as hashes, scoped, expiring and revocable', () => {
  const d = deps();
  const t = new BotTokens(d);
  const { token, record } = t.issue('deploybot', ['commands', 'chat:write'], 60_000);
  assert.match(token, /^zbot_[0-9a-f]{48}$/);
  assert.ok(!JSON.stringify([...(t as unknown as { byHash: Map<string, unknown> }).byHash.entries()]).includes(token.slice(5)), 'the token itself is not stored');
  assert.equal(t.verify(token).bot, 'deploybot');
  assert.equal(t.verify(token, 'chat:write').id, record.id);
  assert.throws(() => t.verify(token, 'admin'), /lacks the admin scope/);
  assert.throws(() => t.verify(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')), /unknown token/);
  assert.throws(() => t.verify('zbot_short'), /not a bot token/);
  assert.throws(() => t.issue('Bad Name', []), /lower-case/);
  assert.throws(() => t.issue('ok', ['has space']), /scopes look like/);
  t.revoke(record.id);
  assert.throws(() => t.verify(token), /revoked/);
  const short = t.issue('b', ['commands'], 1000);
  d.t += 1001;
  assert.throws(() => t.verify(short.token), /expired/);
});

test('interactive payloads between services are verified, replay-safe and retryable', async () => {
  const d = deps();
  const sec = derive('interactive');
  const rx = new InteractiveReceiver([sec], { now: d.now });
  const body = JSON.stringify({ type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'yes' }] });
  const t = Math.floor(d.t / 1000);
  const header = signature(sec, body, t);
  const seen: unknown[] = [];
  assert.equal(await rx.receive(body, header, 'delivery-1', (p) => (seen.push(p), 'ok')), 'ok');
  assert.deepEqual((seen[0] as { type: string }).type, 'block_actions');
  await assert.rejects(() => rx.receive(body, header, 'delivery-1', () => 'again'), /already received/);
  await assert.rejects(() => rx.receive(body + ' ', signature(derive('wrong'), body + ' ', t), 'delivery-2', () => 'x'), /does not match/);
  const body2 = JSON.stringify({ n: 2 });
  let fail = true;
  const h2 = signature(sec, body2, t);
  await assert.rejects(() => rx.receive(body2, h2, 'delivery-3', () => { if (fail) throw new Error('db down'); return 1; }), /db down/);
  fail = false;
  assert.equal(await rx.receive(body2, h2, 'delivery-3', () => 1), 1, 'a failed handler leaves the delivery retryable');
  const arr = '[1]';
  await assert.rejects(() => rx.receive(arr, signature(sec, arr, t), 'delivery-4', () => 1), /JSON object/);
});

test('markup helpers escape control characters', () => {
  assert.equal(escapeMarkup('<@U1|x> & more'), '&lt;@U1|x&gt; &amp; more');
  assert.equal(mention('U1'), '<@U1>');
  assert.equal(mention('U1|evil>'), '<@U1evil>', 'a user id cannot break out of the mention');
});
