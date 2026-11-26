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
