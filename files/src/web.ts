/**
 * The web interface: sign in, see a folder, open folders, download, upload, make a folder, delete to the trash,
 * and share by link. Pages are rendered on the server and work without script; uploading uses a small script
 * that sends each file straight to WebDAV, so there is no form parsing and no size limit beyond the server's.
 *
 * A browser signs in once and keeps a session cookie. Every change it makes carries the session's request token
 * (a form field, or the requesttoken header for WebDAV), so another site cannot act with the cookie.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { encodePath } from '../../intent/blocks/dav/index.ts';
import { NotFound } from '../../intent/blocks/tree/index.ts';
import type { Files } from './app.ts';
import { esc, fields, header, signInAs, statusOf, type Reply, type Req } from './http.ts';
import type { Person } from './state.ts';

interface WebSession {
  readonly user: string;
  readonly csrf: string;
  readonly until: number;
  /** The person's epoch at sign-in: a password change or disabling raises it, which ends this session. */
  readonly epoch: number;
}

const COOKIE = 'files_session';
const HOURS = 12;
const sessions = new Map<string, WebSession>();

const cookieOf = (r: Req) => (header(r, 'cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The session a request's cookie names, if it is still good. */
export function webSession(files: Files, r: Req): { person: Person; csrf: string } | null {
  const id = cookieOf(r);
  const s = id ? sessions.get(id) : undefined;
  if (!s || s.until < Date.now()) return null;
  const person = files.person(s.user);
  if (!person || (person.epoch ?? 0) !== s.epoch) {
    sessions.delete(id!);
    return null;
  }
  return { person, csrf: s.csrf };
}

/** For WebDAV from the browser: the cookie signs in only together with the session's request token. */
export function cookieAuth(files: Files, r: Req): boolean {
  const s = webSession(files, r);
  const token = header(r, 'requesttoken');
  if (!s || !token || !same(token, s.csrf)) return false;
  r.person = s.person;
  return true;
}

const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const shell = (title: string, body: string, who?: { person: Person; csrf: string }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Files</title>
<style>
:root{color-scheme:light dark;--fg:#1b2430;--bg:#f6f8fa;--card:#fff;--line:#c9d3dd;--accent:#1f5f8b;--muted:#4a5866;--hover:#eef3f7}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0f1720;--card:#16212d;--line:#2d3b49;--accent:#7ab8e6;--muted:#a7b4c2;--hover:#1d2b3a}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.75rem 1.25rem;border-bottom:1px solid var(--line);background:var(--card)}
header strong{font-size:1.1rem}header form{margin:0}main{max-width:60rem;margin:0 auto;padding:1.25rem}
h1{font-size:1.35rem;margin:0 0 .25rem}nav ol{list-style:none;display:flex;flex-wrap:wrap;gap:.25rem;padding:0;margin:0 0 1rem}nav li+li::before{content:"/";margin-right:.25rem;color:var(--muted)}
a{color:var(--accent)}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px}
th,td{text-align:left;padding:.55rem .75rem;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:.85rem;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--hover)}td.num{text-align:right;white-space:nowrap;color:var(--muted)}th.num{text-align:right}
.actions{display:flex;gap:.4rem;justify-content:flex-end;flex-wrap:wrap}.actions form{margin:0}
button,.btn{font:inherit;font-size:.9rem;padding:.4rem .75rem;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block;white-space:nowrap}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}@media (prefers-color-scheme:dark){button.primary{color:#0f1720}}
.bar{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end;margin:0 0 1rem}.bar form{display:flex;gap:.4rem;align-items:end;margin:0}
label{display:block;font-size:.85rem;font-weight:600;margin-bottom:.2rem}input[type=text],input[type=password]{font:inherit;padding:.45rem .6rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
.muted{color:var(--muted);font-size:.9rem}.note{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);padding:.75rem 1rem;border-radius:6px;margin:0 0 1rem}
.err{color:#b42318;font-weight:600}@media (prefers-color-scheme:dark){.err{color:#ff9b8f}}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:40rem){td.hide,th.hide{display:none}}
</style></head><body>
<header><strong>Files</strong>${who ? `<form method="post" action="/logout"><input type="hidden" name="requesttoken" value="${esc(who.csrf)}"><span class="muted">${esc(who.person.display)}</span> <button type="submit">Sign out</button></form>` : ''}</header>
<main>${body}</main>${who ? `<script src="/apps/files/files.js" defer></script>` : ''}</body></html>`;

const page = (status: number, title: string, body: string, who?: { person: Person; csrf: string }, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', ...headers },
  body: shell(title, body, who),
});

const loginForm = (next: string, err = '', user = '', status = err ? 401 : 200, headers: Record<string, string> = {}) =>
  page(status, 'Sign in', `<h1>Sign in</h1>${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}<form method="post" action="/login" style="max-width:22rem">
<input type="hidden" name="next" value="${esc(next)}">
<p><label for="user">Login name</label><input type="text" id="user" name="user" autocomplete="username" required value="${esc(user)}" style="width:100%"></p>
<p><label for="password">Password</label><input type="password" id="password" name="password" autocomplete="current-password" required style="width:100%"></p>
<p><button class="primary" type="submit">Sign in</button></p></form>
<p class="muted">On a computer or phone, add this server's address in the Nextcloud app instead: it signs in through this browser once and keeps its own password.</p>`, undefined, headers);

const safeNext = (n: string | undefined) => (n && n.startsWith('/apps/files') ? n : '/apps/files');

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const when = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
const dirOf = (r: Req) => {
  const d = (r.url.searchParams.get('dir') ?? '/').normalize('NFC');
  return `/${d.split('/').filter(Boolean).join('/')}`;
};

export async function web(files: Files, r: Req): Promise<Reply> {
  const p = r.path;
  if (p === '/login' && r.method === 'GET') return webSession(files, r) ? { status: 303, headers: { location: '/apps/files' } } : loginForm(safeNext(r.url.searchParams.get('next') ?? undefined));
  if (p === '/login' && r.method === 'POST') {
    const f = await fields(r);
    try {
      const s = await signInAs(files, r, f['user'] ?? '', f['password'] ?? '');
      if (s.device !== undefined) return loginForm(safeNext(f['next']), 'Sign in here with your account password, not an app password.', f['user'] ?? '');
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, { user: s.person.id, csrf: randomBytes(24).toString('base64url'), until: Date.now() + HOURS * 3600_000, epoch: s.person.epoch ?? 0 });
      if (sessions.size > 10_000) for (const [k, v] of sessions) if (v.until < Date.now()) sessions.delete(k);
      return { status: 303, headers: { location: safeNext(f['next']), 'set-cookie': `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${HOURS * 3600}` } };
    } catch (e) {
      const st = statusOf(e);
      if (st.status === 429) return loginForm(safeNext(f['next']), 'Too many failed sign-ins. Wait a minute and try again.', f['user'] ?? '', 429, { 'retry-after': String(st.retryAfter ?? 60) });
      return loginForm(safeNext(f['next']), 'That login name and password did not sign in.', f['user'] ?? '');
    }
  }
  const who = webSession(files, r);
  if (p === '/logout' && r.method === 'POST') {
    const id = cookieOf(r);
    const f = await fields(r);
    if (who && id && f['requesttoken'] && same(f['requesttoken'], who.csrf)) sessions.delete(id);
    return { status: 303, headers: { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } };
  }
  if (p === '/apps/files/files.js') return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }, body: SCRIPT };
  if (!who) return { status: 303, headers: { location: `/login?next=${encodeURIComponent(r.url.pathname + r.url.search)}` } };
  const user = who.person.id;

  if (r.method === 'POST') {
    const f = await fields(r);
    if (!f['requesttoken'] || !same(f['requesttoken'], who.csrf)) return page(403, 'Not allowed', '<h1>That request could not be checked</h1><p>Go back, reload the page and try again.</p>', who);
    const dir = `/${(f['dir'] ?? '/').normalize('NFC').split('/').filter(Boolean).join('/')}`;
    const pathField = (f['path'] ?? '').normalize('NFC');
    const back = (note = '') => ({ status: 303, headers: { location: `/apps/files?dir=${encodeURIComponent(dir)}${note ? `&note=${encodeURIComponent(note)}` : ''}` } });
    try {
      if (p === '/apps/files/mkdir') {
        const name = (f['name'] ?? '').normalize('NFC').trim();
        await files.mkdir(user, `${dir === '/' ? '' : dir}/${name}`);
        return back(`Made the folder ${name}.`);
      }
      if (p === '/apps/files/delete') {
        await files.remove(user, pathField);
        return back('Moved to the trash. It can be restored from the trash for 30 days.');
      }
      if (p === '/apps/files/devices/wipe' || p === '/apps/files/devices/revoke') {
        // A person manages their own devices; an admin also anyone's.
        const whose = f['user'] && who.person.admin ? f['user'] : user;
        const id = Number(f['device']);
        const done = p.endsWith('/wipe') ? await files.wipeDevice(whose, id) : (await files.devices.list(whose)).some((d) => d.id === id) && (await files.devices.revoke(whose, id), true);
        const note = done ? (p.endsWith('/wipe') ? 'The device will erase this account the next time it connects.' : 'The device is signed out.') : 'No such device.';
        return { status: 303, headers: { location: `/apps/files/devices?${whose !== user ? `user=${encodeURIComponent(whose)}&` : ''}note=${encodeURIComponent(note)}` } };
      }
      if (p === '/apps/files/share') {
        const g = await files.share(user, pathField, { kind: 'link' });
        return back(`link:${g.token}`);
      }
    } catch (e) {
      return back(`Could not do that: ${statusOf(e).message}`);
    }
    return page(404, 'Not found', '<h1>Nothing here</h1>', who);
  }

  if (p === '/apps/files/devices') return devicesPage(files, r, who);

  if (p === '/apps/files/download') {
    const path = (r.url.searchParams.get('path') ?? '').normalize('NFC');
    const { node } = await files.resolve(user, path);
    if (!node || node.kind !== 'file') throw new NotFound(path);
    return { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}`, 'content-length': String(node.size), 'cache-control': 'private, no-store' }, body: node.size ? await files.objects.get(node.blob!) : '' };
  }

  if (p === '/apps/files' || p === '/apps/files/') {
    const dir = dirOf(r);
    const { node } = await files.resolve(user, dir);
    if (!node || node.kind !== 'folder') return page(404, 'Not found', `<h1>That folder is not here</h1><p><a href="/apps/files">Back to your files</a></p>`, who);
    const kids = await files.children(user, dir);
    const steps = dir.split('/').filter(Boolean);
    const crumbs = [`<li><a href="/apps/files">Your files</a></li>`, ...steps.map((s, i) => (i === steps.length - 1 ? `<li aria-current="page">${esc(s)}</li>` : `<li><a href="/apps/files?dir=${encodeURIComponent(`/${steps.slice(0, i + 1).join('/')}`)}">${esc(s)}</a></li>`))];
    const note = r.url.searchParams.get('note') ?? '';
    const origin = `${(header(r, 'x-forwarded-proto') ?? 'http').split(',')[0]}://${header(r, 'host') ?? ''}`;
    const noteHtml = note.startsWith('link:') ? `<div class="note" role="status"><p>Anyone with this link can download it:</p><p><input type="text" readonly value="${esc(`${origin}/s/${note.slice(5)}`)}" aria-label="Share link" style="width:100%" data-copy> </p><p class="muted">Add a password or an expiry from the Nextcloud app, or take the link back there.</p></div>` : note ? `<div class="note" role="status">${esc(note)}</div>` : '';
    const used = await files.used(user);
    const free = await files.free(user);
    const csrf = `<input type="hidden" name="requesttoken" value="${esc(who.csrf)}"><input type="hidden" name="dir" value="${esc(dir)}">`;
    const rows = kids.map((k) => {
      const path = `${dir === '/' ? '' : dir}/${k.name}`;
      const open = k.node.kind === 'folder' ? `<a href="/apps/files?dir=${encodeURIComponent(path)}">${esc(k.name)}/</a>` : `<a href="/apps/files/download?path=${encodeURIComponent(path)}">${esc(k.name)}</a>`;
      const shared = k.w.via ? ` <span class="muted">shared by ${esc(files.person(k.node.owner)?.display ?? k.node.owner)}</span>` : '';
      return `<tr><td>${open}${shared}</td><td class="num">${k.node.kind === 'file' ? size(k.node.size) : ''}</td><td class="num hide">${when(k.node.mtime)}</td><td><div class="actions"><form method="post" action="/apps/files/share">${csrf}<input type="hidden" name="path" value="${esc(path)}"><button type="submit">Share link<span class="sr"> for ${esc(k.name)}</span></button></form><form method="post" action="/apps/files/delete">${csrf}<input type="hidden" name="path" value="${esc(path)}"><button type="submit">Delete<span class="sr"> ${esc(k.name)}</span></button></form></div></td></tr>`;
    });
    return page(
      200,
      steps.at(-1) ?? 'Your files',
      `<h1>${esc(steps.at(-1) ?? 'Your files')}</h1><nav aria-label="Folder path"><ol>${crumbs.join('')}</ol></nav>${noteHtml}
<div class="bar"><form method="post" action="/apps/files/mkdir">${csrf}<div><label for="newdir">New folder</label><input type="text" id="newdir" name="name" required></div><button type="submit">Make it</button></form>
<form id="up" data-base="/remote.php/dav/files/${esc(encodePath(user))}${esc(encodePath(dir === '/' ? '' : dir))}" data-token="${esc(who.csrf)}"><div><label for="files">Upload files</label><input type="file" id="files" multiple></div><button class="primary" type="submit">Upload</button></form></div>
<p id="progress" class="muted" role="status" aria-live="polite"></p>
${kids.length ? `<table><caption class="sr">Files and folders in ${esc(steps.at(-1) ?? 'your files')}</caption><thead><tr><th scope="col">Name</th><th scope="col" class="num">Size</th><th scope="col" class="num hide">Modified (UTC)</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p>This folder is empty. Upload files, or make a folder.</p>'}
<p class="muted">${size(used)} used${free !== undefined ? `, ${size(free)} free` : ''}. <a href="/apps/files/devices">Devices and apps</a></p>`,
      who,
    );
  }
  return page(404, 'Not found', '<h1>Nothing here</h1><p><a href="/apps/files">Back to your files</a></p>', who);
}

/**
 * The apps signed in to an account, each with its own app password: sign one out, or have it erase the account
 * from itself (remote wipe) the next time it connects. An admin sees anyone's with ?user=.
 */
async function devicesPage(files: Files, r: Req, who: { person: Person; csrf: string }): Promise<Reply> {
  const asked = r.url.searchParams.get('user');
  if (asked && asked !== who.person.id && !who.person.admin) return page(403, 'Not allowed', '<h1>Only an admin sees other people’s devices</h1>', who);
  const whose = asked ?? who.person.id;
  if (!files.state.doc.people[whose]) return page(404, 'Not found', '<h1>No such person</h1>', who);
  const list = await files.devices.list(whose);
  const note = r.url.searchParams.get('note') ?? '';
  const hidden = (d: number) => `<input type="hidden" name="requesttoken" value="${esc(who.csrf)}"><input type="hidden" name="device" value="${d}">${whose !== who.person.id ? `<input type="hidden" name="user" value="${esc(whose)}">` : ''}`;
  const rows = list.map((d) => {
    const actions = d.wipe
      ? '<span class="muted">Waiting to erase itself</span>'
      : `<form method="post" action="/apps/files/devices/revoke">${hidden(d.id)}<button type="submit">Sign out<span class="sr"> ${esc(d.name)}</span></button></form><form method="post" action="/apps/files/devices/wipe">${hidden(d.id)}<button type="submit">Wipe<span class="sr"> ${esc(d.name)}</span></button></form>`;
    return `<tr><td>${esc(d.name)}</td><td class="num hide">${when(Math.floor(d.lastUsed / 1000))}</td><td><div class="actions">${actions}</div></td></tr>`;
  });
  const title = whose === who.person.id ? 'Devices and apps' : `Devices and apps of ${files.state.doc.people[whose]!.display}`;
  return page(
    200,
    title,
    `<h1>${esc(title)}</h1><nav aria-label="Folder path"><ol><li><a href="/apps/files">Your files</a></li><li aria-current="page">Devices</li></ol></nav>${note ? `<div class="note" role="status">${esc(note)}</div>` : ''}
<p class="muted">Wiping a device signs it out and tells it to erase this account’s files from itself the next time it connects.</p>
${list.length ? `<table><caption class="sr">${esc(title)}</caption><thead><tr><th scope="col">App</th><th scope="col" class="num hide">Last used (UTC)</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p>No apps are signed in.</p>'}`,
    who,
  );
}

/** Uploads each chosen file straight to WebDAV with the session's request token, then reloads the folder. */
const SCRIPT = `(() => {
  const form = document.getElementById('up');
  if (!form) return;
  const out = document.getElementById('progress');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const files = [...document.getElementById('files').files];
    if (!files.length) { out.textContent = 'Choose one or more files first.'; return; }
    let done = 0;
    for (const f of files) {
      out.textContent = 'Uploading ' + f.name + ' (' + (done + 1) + ' of ' + files.length + ')';
      const r = await fetch(form.dataset.base + '/' + encodeURIComponent(f.name), { method: 'PUT', body: f, headers: { requesttoken: form.dataset.token, 'x-oc-mtime': String(Math.floor(f.lastModified / 1000)) } });
      if (!r.ok) { out.textContent = 'Could not upload ' + f.name + ': ' + (r.status === 507 ? 'not enough space' : r.status === 400 ? 'that name is not allowed' : 'the server said ' + r.status); return; }
      done++;
    }
    location.reload();
  });
  for (const i of document.querySelectorAll('[data-copy]')) i.addEventListener('focus', () => i.select());
})();
`;
