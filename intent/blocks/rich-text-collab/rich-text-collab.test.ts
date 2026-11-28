import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mapping, StepMap, basicSchema as S, fragSize, resolve, slice, textContent } from '../rich-text-doc/index.ts';
import type { Node } from '../rich-text-doc/index.ts';
import { Authority, Client, CollabError } from './index.ts';

const t = (s: string, marks?: Parameters<typeof S.text>[1]) => S.text(s, marks);
const p = (...c: Node[]) => S.node('paragraph', undefined, c);
const doc = (...c: Node[]) => S.node('doc', undefined, c);
const strong = S.mark('strong');

const start = () => doc(p(t('hello world')), p(t('second paragraph')));

function setup(n = 2, o: { maxLog?: number; groupMs?: number } = {}) {
  const auth = new Authority(S, start(), o.maxLog ? { maxLog: o.maxLog } : {});
  let now = 0;
  const clients = Array.from({ length: n }, (_, i) => new Client(S, auth.doc, 0, { clientID: `c${i + 1}`, now: () => now, groupMs: o.groupMs ?? 500 }));
  /** Sends what a client has, then pulls what it is missing. Returns whether the authority accepted. */
  const sync = (c: Client): boolean => {
    const b = c.sendable();
    let ok = true;
    if (b) ok = auth.receiveSteps(b).ok;
    pull(c);
    return ok;
  };
  const pull = (c: Client) => {
    const r = auth.stepsSince(c.version);
    assert.ok(r.ok);
    if (r.ok && r.steps.length) c.receiveJSON(r);
  };
  return { auth, clients, sync, pull, tick: (ms: number) => (now += ms) };
}

test('one client: edits are sent, accepted, and confirmed when they come back; the version counts steps', () => {
  const { auth, clients: [a], sync } = setup(1);
  a!.edit((tr) => tr.insertText(6, 'big '));
  a!.edit((tr) => tr.insertText(1, '>> '));
  assert.equal(a!.unconfirmedCount, 2);
  const batch = a!.sendable()!;
  assert.equal(batch.version, 0);
  assert.equal(batch.steps.length, 2);
  assert.equal(sync(a!), true);
  assert.equal(auth.version, 2);
  assert.equal(a!.version, 2);
  assert.equal(a!.unconfirmedCount, 0);
  assert.equal(textContent(auth.doc.content![0]!), '>> hellobig  world');
  assert.deepEqual(a!.doc, auth.doc);
  assert.equal(a!.sendable(), null, 'nothing to send once confirmed');
});

test('two clients editing the same text at once: the second to send is told to catch up, rebases, and both converge', () => {
  const { auth, clients: [a, b], sync, pull } = setup(2);
  a!.edit((tr) => tr.insertText(1, 'A:'));
  b!.edit((tr) => tr.insertText(1, 'B:'));
  assert.equal(sync(a!), true);
  const lost = auth.receiveSteps(b!.sendable()!);
  assert.equal(lost.ok, false);
  assert.equal(!lost.ok && lost.reason, 'version-mismatch');
  assert.equal(!lost.ok && lost.version, 1);
  pull(b!);
  assert.equal(b!.version, 1);
  assert.equal(b!.unconfirmedCount, 1, 'b still has its own step, now rebased');
  assert.equal(sync(b!), true);
  pull(a!);
  assert.deepEqual(a!.doc, b!.doc);
  assert.deepEqual(a!.doc, auth.doc);
  assert.equal(textContent(auth.doc.content![0]!), 'A:B:hello world', 'a got in first; b\'s text went where it was typed, after a\'s');
  assert.equal(auth.version, 2);
});

test('rebasing keeps meaning: an edit made while someone else inserts before it, deletes around it, or splits the paragraph', () => {
  const { auth, clients: [a, b], sync, pull } = setup(2);
  a!.edit((tr) => tr.insertText(12, '!'));
  b!.edit((tr) => tr.insertText(1, '>>> '));
  b!.edit((tr) => tr.split(6));
  sync(b!);
  assert.equal(sync(a!), false, 'a was behind');
  assert.equal(sync(a!), true);
  pull(b!);
  assert.deepEqual(a!.doc, auth.doc);
  assert.deepEqual(b!.doc, auth.doc);
  assert.equal(textContent(auth.doc), '>>> h' + 'ello world!' + 'second paragraph');
  assert.equal(auth.doc.content!.length, 3, 'the split paragraph, and the second one');
  const exclaim = textContent(auth.doc.content![1]!);
  assert.equal(exclaim, 'ello world!', 'the exclamation mark stayed at the end of the text it was typed after');
});

test('an edit inside text another client deleted is dropped, not applied somewhere else', () => {
  const { auth, clients: [a, b], sync, pull } = setup(2);
  a!.edit((tr) => tr.insertText(4, 'XYZ'));
  b!.edit((tr) => tr.delete(1, 12));
  sync(b!);
  const res = (() => {
    pull(a!);
    return a!.version;
  })();
  assert.equal(res, 1);
  assert.equal(textContent(a!.doc.content![0]!).includes('XYZ'), false, 'its insertion point was inside deleted text; the step was dropped or collapsed to the edge');
  sync(a!);
  pull(b!);
  assert.deepEqual(a!.doc, auth.doc);
  assert.deepEqual(b!.doc, auth.doc);
  assert.deepEqual(S.check(auth.doc), []);
});

test('the authority refuses a bad batch whole: wrong version, steps that do not apply, malformed steps, too many, too large', () => {
  const { auth } = setup(1);
  const good = { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'x' }], openStart: 0, openEnd: 0 } };
  const bad = { stepType: 'replace', from: 500, to: 600, slice: null };
  const r1 = auth.receiveSteps({ version: 0, steps: [good, bad], clientID: 'z' });
  assert.equal(!r1.ok && r1.reason, 'invalid-step');
  assert.match(!r1.ok ? r1.message : '', /step 1 does not apply/);
  assert.equal(auth.version, 0, 'the first step was not kept');
  assert.equal(textContent(auth.doc).includes('x'), false);
  const r2 = auth.receiveSteps({ version: 0, steps: [{ stepType: 'evil' }], clientID: 'z' });
  assert.equal(!r2.ok && r2.reason, 'invalid-step');
  const r3 = auth.receiveSteps({ version: 7, steps: [good], clientID: 'z' });
  assert.equal(!r3.ok && r3.reason, 'version-mismatch');
  const r4 = auth.receiveSteps({ version: 0, steps: Array.from({ length: 501 }, () => good), clientID: 'z' });
  assert.equal(!r4.ok && r4.reason, 'too-many-steps');
  for (const junk of [null, { version: 'x', steps: [], clientID: 'z' }, { version: 0, steps: 'no', clientID: 'z' }, { version: 0, steps: [], clientID: '../x' }, { version: 1.5, steps: [], clientID: 'z' }]) {
    const r = auth.receiveSteps(junk as never);
    assert.equal(!r.ok && r.reason, 'bad-request', JSON.stringify(junk));
  }
  const small = new Authority(S, start(), { maxDocSize: 40 });
  const big = small.receiveSteps({ version: 0, steps: [{ stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'x'.repeat(50) }], openStart: 0, openEnd: 0 } }], clientID: 'z' });
  assert.equal(!big.ok && big.reason, 'too-large');
  assert.equal(auth.receiveSteps({ version: 0, steps: [good], clientID: 'z' }).ok, true);
  assert.throws(() => new Authority(S, { type: 'doc', content: [] }), /not valid/);
});

test('the log is bounded: a client further behind than it is told to reload, and stepsSince refuses nonsense versions', () => {
  const { auth, clients: [a, b], sync } = setup(2, { maxLog: 3 });
  for (let i = 0; i < 5; i++) {
    a!.edit((tr) => tr.insertText(1, String(i)), { newGroup: true });
    sync(a!);
  }
  assert.equal(auth.version, 5);
  const old = auth.stepsSince(0);
  assert.equal(!old.ok && old.reason, 'too-old');
  const ok = auth.stepsSince(2);
  assert.ok(ok.ok && ok.steps.length === 3 && ok.version === 5);
  const limited = auth.stepsSince(2, 2);
  assert.ok(limited.ok && limited.steps.length === 2 && limited.version === 4);
  assert.equal(auth.stepsSince(9).ok, false);
  assert.equal(auth.stepsSince(-1).ok, false);
  const snap = auth.snapshot();
  const fresh = new Client(S, snap.doc, snap.version, { clientID: 'new' });
  assert.deepEqual(fresh.doc, auth.doc);
  assert.equal(fresh.version, 5);
  assert.equal(b!.version, 0);
});

test('a client refuses steps from the authority that do not follow on, are unsafe, or claim more of its own than it made', () => {
  const { auth, clients: [a, b], sync } = setup(2);
  b!.edit((tr) => tr.insertText(1, 'b'));
  sync(b!);
  const r = auth.stepsSince(0);
  assert.ok(r.ok);
  assert.throws(() => a!.receive(3, [], []), /some are missing/);
  assert.throws(() => a!.receive(0, [], ['x']), /one client id for each step/);
  assert.throws(() => a!.receiveJSON({ from: 0, steps: [{ stepType: 'evil' }], clientIDs: ['c2'] }), /unknown step type/);
  assert.throws(() => a!.receiveJSON({ from: 0, steps: r.ok ? r.steps : [], clientIDs: ['../x'] }), /client id is not valid/);
  assert.throws(() => a!.receiveJSON({ from: 0, steps: r.ok ? r.steps : [], clientIDs: ['c1'] }), /more steps from this client than it sent/);
  assert.equal(a!.version, 0, 'nothing was applied by the refused ones');
  a!.receiveJSON(r.ok ? r : (undefined as never));
  assert.equal(a!.version, 1);
  const again = a!.receiveJSON(r.ok ? r : (undefined as never));
  assert.deepEqual([again.applied, again.confirmed], [0, 0], 'steps already seen are skipped');
  assert.throws(() => new Client(S, auth.doc, 0, { clientID: 'bad id' }), CollabError);
});

test('selections move with other people\'s edits: a cursor after an insertion shifts, one before stays, one inside deleted text lands at the edge', () => {
  const { clients: [a, b], sync, pull } = setup(2);
  b!.edit((tr) => tr.insertText(1, 'XX'));
  b!.edit((tr) => tr.delete(8, 12));
  sync(b!);
  const before = a!.doc;
  a!.edit((tr) => tr.insertText(1, 'a'));
  const sel = { anchor: 14, head: 14 };
  const res = (() => {
    const r = pull;
    r(a!);
    return a!;
  })();
  assert.ok(res.version >= 2);
  // Map through a plain mapping too: insertion of 2 at 1 then deletion of 4 at 8.
  const m = new Mapping([new StepMap([1, 0, 2]), new StepMap([8, 4, 0])]);
  assert.deepEqual(a!.mapSelection({ anchor: 0, head: 5 }, m), { anchor: 0, head: 7 });
  assert.deepEqual(a!.mapSelection({ anchor: 10, head: 10 }, m), { anchor: 8, head: 8 }, 'inside the deleted text: the edge');
  assert.deepEqual(a!.mapSelection({ anchor: 20, head: 20 }, m), { anchor: 18, head: 18 });
  assert.deepEqual(a!.mapSelection({ anchor: 1, head: 1 }, m, -1), { anchor: 1, head: 1 }, 'leaning left stays before the insertion');
  assert.deepEqual(a!.mapSelection({ anchor: 1, head: 1 }, m, 1), { anchor: 3, head: 3 });
  assert.deepEqual(a!.mapSelection({ anchor: 999, head: 999 }, new Mapping()), { anchor: fragSize(a!.doc.content!), head: fragSize(a!.doc.content!) }, 'never past the end of the document');
  void before;
  void sel;
});

test('receive returns a mapping that carries a cursor over rebased edits', () => {
  const { clients: [a, b], sync } = setup(2);
  b!.edit((tr) => tr.insertText(1, '12345'));
  sync(b!);
  a!.edit((tr) => tr.insertText(12, '!'));
  const r = a!.receive(0, [], []);
  assert.equal(r.applied, 0);
  const server = (() => {
    const au = new Authority(S, start());
    au.receiveSteps({ version: 0, steps: [{ stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: '12345' }], openStart: 0, openEnd: 0 } }], clientID: 'c2' });
    return au.stepsSince(0);
  })();
  assert.ok(server.ok);
  const res = a!.receiveJSON(server.ok ? server : (undefined as never));
  assert.equal(res.applied, 1);
  assert.equal(res.dropped, 0);
  assert.deepEqual(a!.mapSelection({ anchor: 12, head: 12 }, res.mapping), { anchor: 17, head: 17 });
  assert.equal(textContent(a!.doc.content![0]!), '12345hello world!');
});

test('undo removes only this person\'s work: text added by others around it stays', () => {
  const { auth, clients: [a, b], sync, pull, tick } = setup(2);
  a!.edit((tr) => tr.insertText(6, 'AAA'));
  sync(a!);
  tick(1000);
  b!.edit((tr) => tr.insertText(1, 'BBB'));
  b!.edit((tr) => tr.insertText(15, 'CCC'));
  assert.equal(sync(b!), false, 'b was behind');
  assert.equal(sync(b!), true);
  pull(a!);
  assert.equal(textContent(a!.doc.content![0]!), 'BBBhelloAAA worldCCC');
  assert.equal(a!.undo(), true);
  assert.equal(textContent(a!.doc.content![0]!), 'BBBhello worldCCC');
  sync(a!);
  pull(b!);
  assert.deepEqual(b!.doc, auth.doc);
  assert.equal(textContent(b!.doc.content![0]!), 'BBBhello worldCCC');
  assert.equal(a!.redo(), true);
  assert.equal(textContent(a!.doc.content![0]!), 'BBBhelloAAA worldCCC');
  assert.equal(a!.canRedo, false);
  assert.equal(a!.undo(), true);
  assert.equal(a!.undo(), false, 'nothing more of this person\'s to undo');
  sync(a!);
  assert.deepEqual(auth.doc, a!.doc);
});

test('undo groups edits made close together, and a pause starts a new item', () => {
  const { clients: [a], tick } = setup(1);
  a!.edit((tr) => tr.insertText(1, 'a'));
  tick(100);
  a!.edit((tr) => tr.insertText(2, 'b'));
  tick(100);
  a!.edit((tr) => tr.insertText(3, 'c'));
  tick(2000);
  a!.edit((tr) => tr.insertText(4, 'd'));
  assert.equal(textContent(a!.doc.content![0]!), 'abcdhello world');
  a!.undo();
  assert.equal(textContent(a!.doc.content![0]!), 'abchello world');
  a!.undo();
  assert.equal(textContent(a!.doc.content![0]!), 'hello world', 'abc undone together');
  assert.equal(a!.canUndo, false);
  a!.edit((tr) => tr.insertText(1, 'x'));
  a!.undo();
  assert.equal(a!.canRedo, true);
  a!.edit((tr) => tr.insertText(1, 'y'));
  assert.equal(a!.canRedo, false, 'a new edit clears redo');
  a!.edit((tr) => tr.insertText(1, 'z'), { addToHistory: false });
  a!.undo();
  assert.equal(textContent(a!.doc.content![0]!), 'zhello world', 'an edit kept out of history is not undone');
});

test('undo while edits are unconfirmed, and after a rebase, still removes the right text', () => {
  const { auth, clients: [a, b], sync, pull, tick } = setup(2);
  a!.edit((tr) => tr.insertText(6, 'one'));
  tick(1000);
  a!.edit((tr) => tr.insertText(1, 'two'));
  b!.edit((tr) => tr.insertText(1, 'XYZ'));
  sync(b!);
  pull(a!);
  assert.equal(a!.unconfirmedCount, 2, 'rebased over b');
  assert.equal(textContent(a!.doc.content![0]!), 'XYZtwohelloone world');
  a!.undo();
  assert.equal(textContent(a!.doc.content![0]!), 'XYZhelloone world');
  a!.undo();
  assert.equal(textContent(a!.doc.content![0]!), 'XYZhello world');
  sync(a!);
  pull(b!);
  assert.deepEqual(b!.doc, auth.doc);
  assert.equal(textContent(auth.doc.content![0]!), 'XYZhello world');
});

test('undo of text someone else then deleted does nothing rather than damage the document', () => {
  const { auth, clients: [a, b], sync, pull } = setup(2);
  a!.edit((tr) => tr.insertText(6, 'KEEP'));
  sync(a!);
  pull(b!);
  b!.edit((tr) => tr.delete(1, 20));
  sync(b!);
  pull(a!);
  const before = a!.doc;
  assert.equal(a!.undo(), false);
  assert.deepEqual(a!.doc, before);
  assert.equal(a!.canUndo, false, 'the item that could not apply was dropped');
  assert.deepEqual(S.check(a!.doc), []);
  assert.deepEqual(auth.doc, b!.doc);
});

test('undo of a formatting change leaves other people\'s formatting', () => {
  const { auth, clients: [a, b], sync, pull, tick } = setup(2);
  a!.edit((tr) => tr.addMark(1, 6, strong));
  sync(a!);
  tick(1000);
  b!.edit((tr) => tr.addMark(3, 9, S.mark('em')));
  sync(b!);
  sync(b!);
  pull(a!);
  const marks = (d: Node) => d.content![0]!.content!.map((n) => [n.text, (n.marks ?? []).map((m) => m.type).join('+')]);
  assert.deepEqual(marks(a!.doc), [['he', 'strong'], ['llo', 'em+strong'], [' wo', 'em'], ['rld', '']]);
  a!.undo();
  assert.deepEqual(marks(a!.doc), [['he', ''], ['llo wo', 'em'], ['rld', '']], 'strong is gone, em stays');
  sync(a!);
  pull(b!);
  assert.deepEqual(b!.doc, auth.doc);
});

test('fuzz: many clients editing at random, in random order of sending, always converge on valid documents', () => {
  for (const seed0 of [1, 2, 3, 4, 5, 6]) {
    let seed = seed0 * 7919;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const { auth, clients, sync, pull, tick } = setup(4);
    for (let step = 0; step < 150; step++) {
      const c = clients[rnd(clients.length)]!;
      tick(rnd(1200));
      const kind = rnd(10);
      if (kind < 6) {
        c.edit((tr) => {
          const size = fragSize(tr.doc.content!);
          const pos = rnd(size + 1);
          const $ = resolve(tr.doc, pos);
          if (!S.type($.parent.type).isTextblock) return;
          const op = rnd(5);
          if (op <= 1) tr.insertText(pos, 'abcxyz'.slice(0, 1 + rnd(4)));
          else if (op === 2) tr.delete(pos, Math.min($.end($.depth), pos + 1 + rnd(4)));
          else if (op === 3) tr.addMark(pos, Math.min($.end($.depth), pos + 1 + rnd(6)), strong);
          else if ($.depth === 1) tr.split(pos);
        });
      } else if (kind === 6) c.undo();
      else if (kind === 7) c.redo();
      else if (kind === 8) sync(c);
      else pull(c);
      assert.deepEqual(S.check(c.doc), [], `seed ${seed0} step ${step}`);
    }
    for (let round = 0; round < 6; round++) for (const c of clients) sync(c);
    for (const c of clients) {
      assert.equal(c.unconfirmedCount, 0, `seed ${seed0}: everything confirmed`);
      assert.deepEqual(c.doc, auth.doc, `seed ${seed0}: converged`);
      assert.equal(c.version, auth.version);
    }
    assert.deepEqual(S.check(auth.doc), []);
  }
});
