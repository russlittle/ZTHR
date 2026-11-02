/** Small, dependency-free HTML helpers. Everything interpolated is escaped. */
export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function page(title: string, body: string, opts: { studentId?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#1f3a5f">
<style>
:root{--ink:#1b2230;--muted:#5b6475;--line:#d9dee7;--bg:#f6f7f9;--card:#fff;--accent:#1f5fbf;--accent-ink:#fff;--ok:#1d7a46;--warn:#9a5b00}
@media (prefers-color-scheme: dark){:root{--ink:#e8ebf1;--muted:#a5adbb;--line:#2c3443;--bg:#11151c;--card:#181e28;--accent:#6ea2ff;--accent-ink:#0b1220;--ok:#5fd394;--warn:#f0b35a}}
a{color:var(--accent)}*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:space-between}
header a{color:var(--ink);text-decoration:none;font-weight:650}
nav a{margin-left:12px;color:var(--muted);text-decoration:none;font-size:15px}nav a:hover{color:var(--ink)}
main{max-width:720px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.card h2{margin:0 0 8px;font-size:18px}.muted{color:var(--muted);font-size:14px}
.msg{white-space:pre-wrap}.why{font-size:13px;color:var(--muted);margin-top:6px}
.steps{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
button,.btn{font:inherit;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);border-radius:999px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:transparent;color:var(--accent)}
input,textarea,select{font:inherit;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
form.inline{display:inline}label{display:block;margin:8px 0 4px;font-weight:600}
ul.clean{list-style:none;padding:0;margin:0}ul.clean li{padding:8px 0;border-bottom:1px solid var(--line)}ul.clean li:last-child{border:0}
.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.ok{color:var(--ok)}.warn{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}
</style>
</head>
<body>
<header><a href="${opts.studentId ? `/s/${esc(opts.studentId)}` : '/'}">Student Advocate</a>${
    opts.studentId
      ? `<nav><a href="/s/${esc(opts.studentId)}">Today</a><a href="/s/${esc(opts.studentId)}/money">Money</a><a href="/s/${esc(opts.studentId)}/help">Help</a><a href="/s/${esc(opts.studentId)}/settings">Settings</a></nav>`
      : `<nav><a href="/demo">Demo</a><a href="/evidence">Evidence</a></nav>`
  }</header>
<main>${body}</main>
<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}</script>
</body></html>`;
}

export function actionButton(studentId: string, label: string, action: string, secondary = false): string {
  if (action.startsWith('call:')) return `<a class="btn${secondary ? ' secondary' : ''}" href="tel:${esc(action.slice(5))}">${esc(label)}</a>`;
  return `<form class="inline" method="post" action="/s/${esc(studentId)}/action"><input type="hidden" name="action" value="${esc(action)}"><button${secondary ? ' class="secondary"' : ''}>${esc(label)}</button></form>`;
}
