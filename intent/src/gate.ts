/**
 * The door to the studio, the factory console and mission control: sign in with Google, by invitation only.
 *
 * A page built with the gate carries class="gated" on <html>, so nothing but the bar and this panel shows until the
 * door opens. Signing in proves who someone is; an invitation is what lets them in. Invitations are documents in
 * Firestore at access/{email}, written by a person in the console or Cloud Shell. Firestore's rules, not this script,
 * are what hold the line: a signed-in person may read only their own invitation, and only an invited person may read or
 * write their own workspace. This script only decides what to show.
 *
 * The web configuration comes from Firebase Hosting itself (/__/firebase/init.json), so the repository holds no
 * project settings. Sign-in uses a redirect with the site's own domain as the auth domain, which works in browsers
 * that block third-party storage.
 */
import { initializeApp } from 'firebase/app';
import { getAuth, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, signInWithRedirect, signOut, type User } from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore/lite';

interface Workspace {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(d: Record<string, unknown>): Promise<void>;
}
declare global {
  interface Window {
    zthrAccess?: { email: string; workspace: Workspace };
  }
}

const root = document.documentElement;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function panel(): HTMLElement {
  let el = document.getElementById('zgate');
  if (!el) {
    el = document.createElement('main');
    el.id = 'zgate';
    el.setAttribute('aria-live', 'polite');
    const bar = document.querySelector('.zbar');
    if (bar) bar.after(el);
    else document.body.prepend(el);
  }
  return el;
}

function show(title: string, text: string, action?: { label: string; run: () => void }, secondary?: { label: string; run: () => void }) {
  const el = panel();
  el.innerHTML = `<div class="zgate-card"><h1>${esc(title)}</h1><p>${esc(text)}</p><div class="zgate-actions">${action ? `<button type="button" class="zgate-go" id="zgate-go">${esc(action.label)}</button>` : ''}${secondary ? `<button type="button" class="zgate-quiet" id="zgate-alt">${esc(secondary.label)}</button>` : ''}</div><p class="zgate-small">ZTHR is open source under Apache 2.0. The code is public on GitHub; this hosted copy is for invited people while it is being proved.</p></div>`;
  if (action) document.getElementById('zgate-go')!.addEventListener('click', action.run);
  if (secondary) document.getElementById('zgate-alt')!.addEventListener('click', secondary.run);
  (document.getElementById('zgate-go') ?? el).focus?.();
}

function open(user: User, workspace: Workspace) {
  window.zthrAccess = { email: user.email!, workspace };
  root.classList.remove('gated');
  document.getElementById('zgate')?.remove();
  const bar = document.querySelector('.zbar');
  if (bar && !bar.querySelector('.zwho')) {
    const who = document.createElement('div');
    who.className = 'zwho';
    who.innerHTML = `<span>${esc(user.email!)}</span><button type="button" id="zsignout">Sign out</button>`;
    bar.append(who);
    document.getElementById('zsignout')!.addEventListener('click', () => void signOut(getAuth()).then(() => location.reload()));
  }
  window.dispatchEvent(new CustomEvent('zthr:access', { detail: { email: user.email } }));
}

async function start() {
  if (!root.classList.contains('gated')) return;
  show('Checking who you are', 'One moment.');
  let config: Record<string, string>;
  try {
    const res = await fetch('/__/firebase/init.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    config = (await res.json()) as Record<string, string>;
  } catch {
    show('Invitation only', 'Sign-in is not set up on this site yet, so the tools stay closed. The code is on GitHub for anyone to run.');
    return;
  }
  const app = initializeApp({ ...config, authDomain: location.host });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const google = new GoogleAuthProvider();
  google.setCustomParameters({ prompt: 'select_account' });
  const signIn = () => void signInWithRedirect(auth, google);
  try {
    await getRedirectResult(auth);
  } catch {
    /* a sign-in that did not finish just leaves the person signed out */
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      show('Invitation only', 'ZTHR is open to invited people while it is being proved. Sign in with the Google account your invitation was sent to.', { label: 'Sign in with Google', run: signIn });
      return;
    }
    const email = (user.email ?? '').toLowerCase();
    const out = { label: 'Use a different account', run: () => void signOut(auth).then(signIn) };
    if (!email || !user.emailVerified) {
      show('That account cannot be checked', 'This Google account has no verified email address, so it cannot be matched to an invitation.', out);
      return;
    }
    let invited = false;
    try {
      const snap = await getDoc(doc(db, 'access', email));
      invited = snap.exists() && snap.data()['active'] === true;
    } catch {
      invited = false;
    }
    if (!invited) {
      show('Not invited yet', `You are signed in as ${email}, which does not have an invitation. Ask the person who invited you to add this address, or sign in with the one they used.`, out);
      return;
    }
    const ref = doc(db, 'workspaces', user.uid);
    open(user, {
      get: async () => {
        const s = await getDoc(ref);
        return { exists: s.exists(), data: () => s.data() };
      },
      set: async (d) => setDoc(ref, { ...d, at: new Date().toISOString() }),
    });
  });
}

void start();
