/**
 * The pages and small endpoints around the protocols: the status a client checks first, the browser sign-in a
 * new app opens (login flow v2), remote wipe, and public links. Every page is plain HTML with no script, so it
 * works in any browser and in the apps' embedded views.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NotSignedIn } from '../../intent/blocks/devices/index.ts';
import { encodePath, httpDate } from '../../intent/blocks/dav/index.ts';
import { Refused, Throttled, type Grant } from '../../intent/blocks/grants/index.ts';
import { parseRange } from '../../intent/blocks/objects/index.ts';
import type { Node } from '../../intent/blocks/tree/index.ts';
import type { Files } from './app.ts';
import { esc, fields, header, html, json, signInAs, statusOf, type Reply, type Req } from './http.ts';
import { mimeOf } from './mime.ts';
import { VERSION } from './ocs.ts';

export const status = (): Reply => json(200, { installed: true, maintenance: false, needsDbUpgrade: false, version: `${VERSION.major}.${VERSION.minor}.${VERSION.micro}.0`, versionstring: VERSION.string, edition: '', productname: 'Files', extendedSupport: false });

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1b2430;--bg:#f6f8fa;--card:#fff;--line:#c9d3dd;--accent:#1f5f8b;--muted:#4a5866}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0f1720;--card:#16212d;--line:#2d3b49;--accent:#7ab8e6;--muted:#a7b4c2}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);display:grid;min-height:100vh;place-items:center;padding:1rem}
main{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.75rem;max-width:26rem;width:100%}
h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:.5rem 0}.muted{color:var(--muted);font-size:.9rem}
label{display:block;font-weight:600;margin:.9rem 0 .25rem}input{width:100%;font:inherit;padding:.6rem .7rem;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
button,.btn{display:inline-block;margin-top:1.1rem;font:inherit;font-weight:600;padding:.65rem 1rem;border-radius:6px;border:0;background:var(--accent);color:#fff;text-decoration:none;cursor:pointer}
@media (prefers-color-scheme:dark){button,.btn{color:#0f1720}}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.err{color:#b42318;font-weight:600}@media (prefers-color-scheme:dark){.err{color:#ff9b8f}}
</style></head><body><main>${body}</main></body></html>`;

// ---------------------------------------------------------------- login flow v2

export async function loginFlow(files: Files, r: Req, rest: string, origin: string): Promise<Reply> {
  try {
    if (rest === '' && r.method === 'POST') {
      const f = await files.devices.startFlow(header(r, 'user-agent') ?? 'app');
      return json(200, { poll: { token: f.poll, endpoint: `${origin}/index.php/login/v2/poll` }, login: `${origin}/index.php/login/v2/flow/${f.login}` });
    }
    if (rest === '/poll' && r.method === 'POST') {
      const token = (await fields(r))['token'] ?? '';
      const got = await files.devices.poll(token).catch(() => null);
      if (!got) return json(404, []);
      return json(200, { server: origin, loginName: got.user, appPassword: got.password });
    }
    const m = /^\/flow\/([A-Za-z0-9_-]+)$/.exec(rest);
    if (m) {
      const token = m[1]!;
      if (r.method === 'GET') return html(200, page('Connect an app', `<h1>Connect an app to your files</h1><p>An app is asking to sign in to your account. Sign in to allow it. It will get its own password, which you can revoke at any time.</p>${signInForm(token, '')}`));
      if (r.method === 'POST') {
        const f = await fields(r);
        try {
          const s = await signInAs(files, r, f['user'] ?? '', f['password'] ?? '');
          if (s.device !== undefined) throw new NotSignedIn();
          await files.devices.approve(token, s.person.id);
          return html(200, page('App connected', `<h1>App connected</h1><p>The app is now signed in to your files as <strong>${esc(s.person.display)}</strong>. You can close this window.</p>`));
        } catch (e) {
          const s = statusOf(e);
          if (s.status === 404) return html(410, page('Sign-in expired', '<h1>This sign-in has expired</h1><p>Start again from the app.</p>'));
          return html(s.status === 429 ? 429 : 401, page('Connect an app', `<h1>Connect an app to your files</h1><p class="err" role="alert">That name and password did not sign in.</p>${signInForm(token, f['user'] ?? '')}`));
        }
      }
    }
    return json(404, { message: 'no such sign-in' });
  } catch (e) {
    const s = statusOf(e);
    if (s.status === 404 || e instanceof Error) return html(410, page('Sign-in expired', '<h1>This sign-in has expired</h1><p>Start again from the app.</p>'));
    return json(s.status, { message: s.message });
  }
}

const signInForm = (token: string, user: string) => `<form method="post" action="/index.php/login/v2/flow/${esc(token)}">
<label for="user">Login name</label><input id="user" name="user" autocomplete="username" required value="${esc(user)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in and allow</button></form>`;

// ---------------------------------------------------------------- remote wipe

export async function wipe(files: Files, r: Req, rest: string): Promise<Reply> {
  const token = (await fields(r))['token'] ?? '';
  if (rest === '/check' && r.method === 'POST') return (await files.devices.mustWipe(token)) ? json(200, { wipe: true }) : json(404, []);
  if (rest === '/success' && r.method === 'POST') return (await files.devices.wiped(token)) ? json(200, []) : json(404, []);
  return json(404, []);
}

// ---------------------------------------------------------------- public links

const cookieName = (token: string) => `link_${token}`;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A link opened with its password once is remembered for this browser session, by a value only the server can make. */
function linkCookie(files: Files, g: Grant): string {
  return createHmac('sha256', `${files.instance}:${g.passwordHash ?? ''}`).update(g.token ?? '').digest('base64url');
}

async function openLink(files: Files, r: Req, token: string): Promise<{ g: Grant; node: Node } | Reply> {
  const g = await files.grants.byToken(token);
  if (!g) return html(404, page('Link not found', '<h1>This link does not work</h1><p>It may have expired, or the person who shared it may have taken it back.</p>'));
  const node = await files.tree.get(g.resource);
  // A link stops working when what it points to is gone, or its owner is removed or disabled.
  if (!node || !files.person(node.owner)) return html(404, page('Link not found', '<h1>This link does not work</h1><p>What it pointed to is gone.</p>'));
  if (g.passwordHash) {
    const cookie = (header(r, 'cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${cookieName(token)}=`))?.split('=')[1];
    const basic = header(r, 'authorization')?.startsWith('Basic ') ? Buffer.from(header(r, 'authorization')!.slice(6), 'base64').toString().split(':').slice(1).join(':') : undefined;
    if (!cookie || !same(cookie, linkCookie(files, g))) {
      // Opening the page without a password is not a wrong password: it shows the form and counts nothing.
      if (basic === undefined) return passwordPage(token, '');
      try {
        await files.grants.open(token, basic);
      } catch (e) {
        return passwordPage(token, e instanceof Throttled ? 'Too many wrong passwords. Wait a minute and try again.' : basic !== undefined ? 'That password is wrong.' : '');
      }
    }
  }
  return { g, node };
}

const passwordPage = (token: string, err: string) =>
  html(err ? 401 : 200, page('This link has a password', `<h1>This link has a password</h1><p>Ask the person who shared it if you do not have it.</p>${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}<form method="post" action="/s/${esc(token)}"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="off"><button type="submit">Open</button></form>`));

export async function link(files: Files, r: Req, token: string, rest: string): Promise<Reply> {
  if (r.method === 'POST' && rest === '') {
    const pw = (await fields(r))['password'] ?? '';
    try {
      const g = await files.grants.open(token, pw);
      const n = await files.tree.get(g.resource);
      if (!n || !files.person(n.owner)) return html(404, page('Link not found', '<h1>This link does not work</h1><p>What it pointed to is gone.</p>'));
      return { status: 303, headers: { location: `/s/${token}`, 'set-cookie': `${cookieName(token)}=${linkCookie(files, g)}; Path=/s/${token}; HttpOnly; Secure; SameSite=Lax` } };
    } catch (e) {
      if (e instanceof Throttled) return passwordPage(token, 'Too many wrong passwords. Wait a minute and try again.');
      if (e instanceof Refused) return passwordPage(token, 'That password is wrong.');
      throw e;
    }
  }
  const got = await openLink(files, r, token);
  if (!('g' in got)) return got;
  const { node } = got;
  if (rest === '/download') {
    if (node.kind === 'folder') return html(400, page('Folder', '<h1>Folders download one file at a time</h1><p>Open a file in the folder to download it.</p>'));
    return fileReply(files, r, node);
  }
  const sub = /^\/download\/(.+)$/.exec(rest);
  if (sub && node.kind === 'folder') {
    const inner = await files.tree.resolve(node.owner, `${await files.tree.pathOf(node)}/${decodeURIComponent(sub[1]!)}`);
    if (!inner || inner.kind !== 'file') return html(404, page('Not found', '<h1>That file is not in this folder</h1>'));
    return fileReply(files, r, inner);
  }
  if (node.kind === 'file')
    return html(200, page(node.name, `<h1>${esc(node.name)}</h1><p class="muted">${size(node.size)} · shared by ${esc(files.person(node.owner)?.display ?? node.owner)}</p><a class="btn" href="/s/${esc(token)}/download">Download</a>`));
  const kids = (await files.tree.list(node)).filter((k) => k.kind === 'file');
  return html(200, page(node.name, `<h1>${esc(node.name)}</h1><p class="muted">Shared by ${esc(files.person(node.owner)?.display ?? node.owner)}</p>${kids.length ? `<ul>${kids.map((k) => `<li><a href="/s/${esc(token)}/download/${encodePath(k.name).slice(0)}">${esc(k.name)}</a> <span class="muted">${size(k.size)}</span></li>`).join('')}</ul>` : '<p>This folder is empty.</p>'}`));
}

async function fileReply(files: Files, r: Req, node: Node): Promise<Reply> {
  const range = parseRange(header(r, 'range'), node.size);
  const common = { 'content-type': node.mime ?? mimeOf(node.name), 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(node.name)}`, etag: `"${node.etag}"`, 'last-modified': httpDate(node.mtime), 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' };
  if (range === 'unsatisfiable') return { status: 416, headers: { 'content-range': `bytes */${node.size}` } };
  if (range) return { status: 206, headers: { ...common, 'content-range': `bytes ${range.start}-${range.end}/${node.size}`, 'content-length': String(range.end - range.start + 1) }, body: await files.objects.get(node.blob!, range) };
  return { status: 200, headers: { ...common, 'content-length': String(node.size) }, body: node.size ? await files.objects.get(node.blob!) : '' };
}

const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

export const home = (): Reply =>
  html(200, page('Files', '<h1>Files</h1><p>This server keeps files for the people who use it. Connect with the Nextcloud app on your computer or phone, using this address as the server.</p><p class="muted">Built by the ZTHR factory from its standard blocks. Apache 2.0.</p>'));
