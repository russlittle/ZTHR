// The invitation rules, tried in the Firestore emulator: who may read what, and who may not.
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-zthr', firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') } });
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'access/invited@example.com'), { active: true, name: 'Invited' });
    await setDoc(doc(c.firestore(), 'access/paused@example.com'), { active: false, name: 'Paused' });
    await setDoc(doc(c.firestore(), 'workspaces/u-invited'), { v: 1, json: '{}', at: 'then' });
  });
});
after(async () => env.cleanup());

const as = (uid, email, verified = true) => env.authenticatedContext(uid, { email, email_verified: verified }).firestore();

test('an invited person reads their own invitation and their own workspace', async () => {
  const db = as('u-invited', 'Invited@Example.com');
  await assertSucceeds(getDoc(doc(db, 'access/invited@example.com')));
  await assertSucceeds(getDoc(doc(db, 'workspaces/u-invited')));
  await assertSucceeds(setDoc(doc(db, 'workspaces/u-invited'), { v: 1, json: '{"words":"x"}', at: 'now' }));
});

test('nobody reads anyone else’s invitation or workspace, or lists invitations', async () => {
  const db = as('u-invited', 'invited@example.com');
  await assertFails(getDoc(doc(db, 'access/paused@example.com')));
  await assertFails(getDoc(doc(db, 'workspaces/u-other')));
  await assertFails(getDocs(collection(db, 'access')));
});

test('signed in but not invited, paused, or unverified: no workspace', async () => {
  await assertFails(setDoc(doc(as('u-x', 'stranger@example.com'), 'workspaces/u-x'), { v: 1, json: '{}', at: 'now' }));
  await assertFails(setDoc(doc(as('u-p', 'paused@example.com'), 'workspaces/u-p'), { v: 1, json: '{}', at: 'now' }));
  await assertFails(getDoc(doc(as('u-invited', 'invited@example.com', false), 'workspaces/u-invited')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'access/invited@example.com')));
});

test('no browser can invite anyone, including itself', async () => {
  await assertFails(setDoc(doc(as('u-x', 'stranger@example.com'), 'access/stranger@example.com'), { active: true }));
  await assertFails(setDoc(doc(as('u-invited', 'invited@example.com'), 'access/invited@example.com'), { active: true, admin: true }));
});

test('a workspace holds only the saved work, within a size', async () => {
  const db = as('u-invited', 'invited@example.com');
  await assertFails(setDoc(doc(db, 'workspaces/u-invited'), { v: 1, json: '{}', at: 'now', role: 'admin' }));
  await assertFails(setDoc(doc(db, 'workspaces/u-invited'), { v: 1, json: 'x'.repeat(900001), at: 'now' }));
});

test('reporting: invited people file tickets while it is switched on, read their own, and only admins triage', async () => {
  const { serverTimestamp, updateDoc, query, where } = await import('firebase/firestore');
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'access/admin@example.com'), { active: true, role: 'admin' });
    await setDoc(doc(c.firestore(), 'config/feedback'), { enabled: true });
  });
  const mine = as('u-invited', 'invited@example.com');
  const t = { reporter: 'u-invited', email: 'invited@example.com', kind: 'bug', title: 'The map will not zoom', happened: 'I pressed +', expected: 'It zooms', page: '/intent', view: 'map', device: 'laptop', status: 'new', createdAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(mine, 'tickets/t1'), t));
  await assertFails(setDoc(doc(mine, 'tickets/t2'), { ...t, reporter: 'someone-else' }), 'nobody files as someone else');
  await assertFails(setDoc(doc(mine, 'tickets/t3'), { ...t, status: 'resolved' }), 'a new ticket starts new');
  await assertFails(setDoc(doc(as('u-x', 'stranger@example.com'), 'tickets/t4'), { ...t, reporter: 'u-x', email: 'stranger@example.com' }), 'the uninvited cannot file');
  await assertSucceeds(getDoc(doc(mine, 'tickets/t1')));
  await assertFails(updateDoc(doc(mine, 'tickets/t1'), { status: 'resolved' }), 'a reporter cannot triage');
  const adm = as('u-admin', 'admin@example.com');
  await assertSucceeds(getDocs(collection(adm, 'tickets')));
  await assertSucceeds(updateDoc(doc(adm, 'tickets/t1'), { status: 'triaged', severity: 'minor', triagedBy: 'admin@example.com', triagedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(adm, 'tickets/t1'), { title: 'rewritten' }), 'triage never rewrites what the person said');
  await assertFails(getDocs(collection(mine, 'tickets')), 'a reporter cannot list everyone’s tickets');
  await assertSucceeds(getDocs(query(collection(mine, 'tickets'), where('reporter', '==', 'u-invited'))));
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'config/feedback'), { enabled: false }));
  await assertFails(setDoc(doc(mine, 'tickets/t5'), t), 'switched off, nothing new is filed');
});
