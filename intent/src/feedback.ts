/**
 * Report a problem, on ZTHR's own surfaces: the studio, the factory console and mission control.
 *
 * An invited person files a bug, idea, question or praise from the top bar. Where they were (the page, the studio's
 * view, a phone or a larger screen) is captured for them; nothing they typed elsewhere is. They see their own reports
 * and where each stands. An admin sees every report and triages it: status, severity, a note to the reporter.
 *
 * The switch is a document, config/feedback, set by a person: off hides the button and Firestore refuses new reports,
 * at any time, with no release. Firestore's rules, not this script, decide who may file, read and triage.
 */
import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, updateDoc, where, type Firestore } from 'firebase/firestore/lite';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const KINDS = [
  ['bug', 'Something is wrong'],
  ['idea', 'An idea'],
  ['question', 'A question'],
  ['praise', 'Something that works well'],
] as const;
const STATUSES = ['new', 'triaged', 'in progress', 'waiting on reporter', 'resolved', 'closed', "won't fix", 'duplicate'];
const SEVERITIES = ['not set', 'blocks me', 'gets in the way', 'minor'];

interface Ticket {
  id: string;
  kind: string;
  title: string;
  happened: string;
  expected?: string;
  page: string;
  view?: string;
  status: string;
  severity?: string;
  note?: string;
  email?: string;
  createdAt?: { seconds: number };
}

const when = (t: Ticket) => (t.createdAt ? new Date(t.createdAt.seconds * 1000).toLocaleString() : 'just now');

export async function startFeedback(db: Firestore, user: { uid: string; email: string }, isAdmin: boolean): Promise<void> {
  let enabled = false;
  try {
    enabled = (await getDoc(doc(db, 'config', 'feedback'))).data()?.['enabled'] === true;
  } catch {
    enabled = false;
  }
  const bar = document.querySelector('.zbar');
  if (!bar || (!enabled && !isAdmin)) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'zfb';
  dialog.setAttribute('aria-labelledby', 'zfb-h');
  document.body.append(dialog);
  const close = () => dialog.close();

  const mine = async (): Promise<Ticket[]> => {
    const snap = await getDocs(query(collection(db, 'tickets'), where('reporter', '==', user.uid)));
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Ticket, 'id'>) })).sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
  };
  const all = async (): Promise<Ticket[]> => {
    const snap = await getDocs(collection(db, 'tickets'));
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Ticket, 'id'>) })).sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
  };

  const report = async () => {
    const list = await mine().catch(() => []);
    dialog.innerHTML = `<form method="dialog" class="zfb-form" novalidate>
<h2 id="zfb-h">Report a problem</h2>
<fieldset><legend>What is it?</legend>${KINDS.map(([k, label], i) => `<label><input type="radio" name="kind" value="${k}"${i === 0 ? ' checked' : ''}> ${label}</label>`).join('')}</fieldset>
<label for="zfb-title">In a line</label><input id="zfb-title" name="title" maxlength="140" required autocomplete="off">
<label for="zfb-happened">What happened</label><textarea id="zfb-happened" name="happened" maxlength="4000" rows="4"></textarea>
<label for="zfb-expected">What you expected <span class="zfb-opt">(optional)</span></label><textarea id="zfb-expected" name="expected" maxlength="2000" rows="2"></textarea>
<p class="zfb-note">Sent with it: this page${document.body.dataset['view'] ? ` and the ${esc(document.body.dataset['view'])} view` : ''}, and whether you are on a phone. Nothing you typed elsewhere is sent.</p>
<p class="zfb-error" id="zfb-error" role="alert"></p>
<div class="zfb-actions"><button type="submit" class="zgate-go" id="zfb-send"${enabled ? '' : ' disabled'}>${enabled ? 'Send it' : 'Reporting is switched off'}</button><button type="button" class="zgate-quiet" id="zfb-cancel">Close</button></div>
${list.length ? `<h3>Your reports</h3><ul class="zfb-list">${list.map((t) => `<li><strong>${esc(t.title)}</strong> <span class="zfb-status">${esc(t.status)}</span><span class="zfb-when">${esc(when(t))}</span>${t.note ? `<p>${esc(t.note)}</p>` : ''}</li>`).join('')}</ul>` : ''}
</form>`;
    dialog.querySelector('#zfb-cancel')!.addEventListener('click', close);
    const title = dialog.querySelector<HTMLInputElement>('#zfb-title')!;
    title.addEventListener('input', () => (dialog.querySelector('#zfb-error')!.textContent = ''));
    dialog.querySelector('form')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!enabled) return;
      const f = new FormData(e.target as HTMLFormElement);
      const t = String(f.get('title') ?? '').trim();
      if (!t) {
        dialog.querySelector('#zfb-error')!.textContent = 'Say in a line what it is about.';
        title.focus();
        return;
      }
      const send = dialog.querySelector<HTMLButtonElement>('#zfb-send')!;
      send.disabled = true;
      try {
        const ref = await addDoc(collection(db, 'tickets'), {
          reporter: user.uid,
          email: user.email.toLowerCase(),
          kind: String(f.get('kind') ?? 'bug'),
          title: t,
          happened: String(f.get('happened') ?? '').trim(),
          expected: String(f.get('expected') ?? '').trim(),
          page: location.pathname.slice(0, 300),
          view: (document.body.dataset['view'] ?? '').slice(0, 60),
          device: innerWidth < 700 ? 'phone' : 'larger screen',
          status: 'new',
          createdAt: serverTimestamp(),
        });
        dialog.innerHTML = `<div class="zfb-form"><h2 id="zfb-h">Thank you</h2><p>It is filed as <code>${esc(ref.id.slice(0, 8))}</code>. You can see where it stands here, under Report a problem.</p><div class="zfb-actions"><button type="button" class="zgate-go" id="zfb-done">Close</button></div></div>`;
        dialog.querySelector<HTMLButtonElement>('#zfb-done')!.addEventListener('click', close);
        dialog.querySelector<HTMLButtonElement>('#zfb-done')!.focus();
      } catch {
        dialog.querySelector('#zfb-error')!.textContent = 'It could not be sent. Reporting may have just been switched off; try again in a moment.';
        send.disabled = false;
      }
    });
    if (!dialog.open) dialog.showModal();
    title.focus();
  };

  const triage = async (filter = 'open') => {
    const list = await all().catch(() => []);
    const shown = list.filter((t) => (filter === 'open' ? !['resolved', 'closed', "won't fix", 'duplicate'].includes(t.status) : filter === 'all' ? true : t.status === filter));
    const counts = (k: string) => list.filter((t) => t.kind === k).length;
    dialog.innerHTML = `<div class="zfb-form zfb-wide"><h2 id="zfb-h">Triage</h2>
<p class="zfb-note">${list.length} reports: ${KINDS.map(([k]) => `${counts(k)} ${k}`).join(', ')}. ${list.filter((t) => t.status === 'new').length} new. Reporting is ${enabled ? 'on' : 'off'}; it is switched in config/feedback.</p>
<label for="zfb-filter">Show</label><select id="zfb-filter">${['open', 'all', ...STATUSES].map((s) => `<option value="${esc(s)}"${s === filter ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
<ul class="zfb-list">${shown
      .map(
        (t) => `<li data-id="${esc(t.id)}"><p><span class="zfb-kind">${esc(t.kind)}</span> <strong>${esc(t.title)}</strong> <span class="zfb-when">${esc(t.email ?? '')}, ${esc(when(t))}, ${esc(t.page)}${t.view ? ` (${esc(t.view)})` : ''}</span></p>${t.happened ? `<p>${esc(t.happened)}</p>` : ''}${t.expected ? `<p class="zfb-when">Expected: ${esc(t.expected)}</p>` : ''}
<div class="zfb-row"><label>Status <select data-k="status">${STATUSES.map((s) => `<option${s === t.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label><label>Severity <select data-k="severity">${SEVERITIES.map((s) => `<option${s === (t.severity ?? 'not set') ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label><label class="zfb-grow">Note to the reporter <input data-k="note" maxlength="2000" value="${esc(t.note ?? '')}"></label><button type="button" class="zgate-quiet" data-save>Save</button></div></li>`,
      )
      .join('') || '<li>Nothing here.</li>'}</ul>
<div class="zfb-actions"><button type="button" class="zgate-quiet" id="zfb-cancel">Close</button></div></div>`;
    dialog.querySelector('#zfb-cancel')!.addEventListener('click', close);
    dialog.querySelector<HTMLSelectElement>('#zfb-filter')!.addEventListener('change', (e) => void triage((e.target as HTMLSelectElement).value));
    dialog.querySelectorAll<HTMLButtonElement>('[data-save]').forEach((b) =>
      b.addEventListener('click', async () => {
        const li = b.closest<HTMLElement>('li')!;
        const v = (k: string) => li.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-k="${k}"]`)!.value;
        const was = list.find((t) => t.id === li.dataset['id'])!;
        const status = v('status');
        b.disabled = true;
        try {
          await updateDoc(doc(db, 'tickets', li.dataset['id']!), {
            status,
            severity: v('severity'),
            note: v('note'),
            triagedBy: user.email.toLowerCase(),
            ...(was.status === 'new' && status !== 'new' ? { triagedAt: serverTimestamp() } : {}),
            ...(['resolved', 'closed'].includes(status) && !['resolved', 'closed'].includes(was.status) ? { resolvedAt: serverTimestamp() } : {}),
          });
          b.textContent = 'Saved';
        } catch {
          b.textContent = 'Not saved';
        }
        b.disabled = false;
      }),
    );
    if (!dialog.open) dialog.showModal();
  };

  const add = (label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'zfb-open';
    b.textContent = label;
    b.addEventListener('click', run);
    (bar.querySelector('.zwho') ?? bar).before(b);
  };
  if (enabled) add('Report a problem', () => void report());
  if (isAdmin) {
    const n = (await all().catch(() => [])).filter((t) => t.status === 'new').length;
    add(`Triage${n ? ` (${n} new)` : ''}`, () => void triage());
  }
}
