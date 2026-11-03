import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @zthr/ui — a small, framework-free block library for server-rendered apps built in the factory.
 *
 * Every component returns an HTML string and escapes everything it interpolates, so a component cannot be the
 * source of an injection. Pages work without JavaScript; forms post and links navigate. One set of tokens drives
 * light and dark themes, and every interactive element has a visible focus ring and an accessible name.
 *
 * Two shells share the tokens: `appShell` for people using a product (phone-first, bottom tabs) and
 * `consoleShell` for people operating one (dense, sidebar).
 */

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Join only the truthy parts; lets components take optional pieces without stray markup. */
export const join = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join('');

// ---------------------------------------------------------------- tokens

export const TOKENS = {
  light: { paper: '#f4f6f3', surface: '#ffffff', ink: '#16231f', muted: '#566660', line: '#d6ded9', action: '#0d6a5b', actionInk: '#ffffff', mark: '#f2b233', markInk: '#3b2a00', alert: '#a8432c', calm: '#e6efe9', focus: '#1b5fd1' },
  dark: { paper: '#0e1513', surface: '#151f1c', ink: '#e6eee9', muted: '#9bb0a8', line: '#2a3833', action: '#5fcfb6', actionInk: '#06231d', mark: '#f2b233', markInk: '#2a1d00', alert: '#f08a6c', calm: '#1b2a25', focus: '#8db4ff' },
} as const;

const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`).join(';');

// ---------------------------------------------------------------- icons

const ICONS: Record<string, string> = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v.01M18 15v.01"/>',
  help: '<path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z"/>',
  you: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  week: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17v.01"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h6"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 21v-3M16 21v-3"/><circle cx="8" cy="15" r=".5"/><circle cx="16" cy="15" r=".5"/>',
  child: '<circle cx="12" cy="6" r="3"/><path d="M8 21l1-7-3-2 3-3h6l3 3-3 2 1 7"/>',
  talk: '<path d="M4 5h16v11H9l-5 4z"/>',
  food: '<path d="M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 21V3c-2 0-4 2-4 6v4h4"/>',
  dollar: '<path d="M12 3v18M17 7a4 4 0 0 0-4-2h-2a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-2a4 4 0 0 1-4-2"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 22): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] ?? ICONS.list}</svg>`;
}

// ---------------------------------------------------------------- styles

export function styles(base = ''): string {
  return `
@font-face{font-family:"Atkinson Hyperlegible";src:url("${base}/_ui/atkinson-400.woff2") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Atkinson Hyperlegible";src:url("${base}/_ui/atkinson-700.woff2") format("woff2");font-weight:700;font-display:swap}
:root{${vars(TOKENS.light)};--r-lg:18px;--r-md:12px;--r-sm:8px;--shadow:0 1px 2px rgba(22,35,31,.06),0 2px 8px rgba(22,35,31,.05);--shadow-lg:0 2px 4px rgba(22,35,31,.06),0 10px 28px rgba(22,35,31,.09);--tint:color-mix(in srgb,var(--action) 9%,var(--surface));color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars(TOKENS.dark)};--shadow:0 1px 2px rgba(0,0,0,.35);--shadow-lg:0 8px 24px rgba(0,0,0,.4);color-scheme:dark}}
:root[data-theme="dark"]{${vars(TOKENS.dark)};--shadow:0 1px 2px rgba(0,0,0,.35);--shadow-lg:0 8px 24px rgba(0,0,0,.4);color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 "Atkinson Hyperlegible",system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--action);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);padding:8px 12px;border-radius:8px;z-index:10}.skip:focus{left:8px}
h1,h2,h3{line-height:1.2;margin:0}
h1{font-size:30px;letter-spacing:-.01em}
h2{font-size:21px}
h3{font-size:17px}
p{margin:.4em 0}
.muted{color:var(--muted)}
.small{font-size:14px}
.ic{flex:none;vertical-align:-5px}
/* app shell */
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top-in{max-width:1120px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:16px}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:700;font-size:18px}
.brand-mark{width:30px;height:30px;border-radius:10px;background:linear-gradient(140deg,var(--action),color-mix(in srgb,var(--action) 70%,var(--ink)));box-shadow:var(--shadow);display:grid;place-items:center;color:var(--action-ink)}
.tabs{display:flex;gap:4px;margin-left:auto}
.tabs a{display:flex;align-items:center;gap:6px;min-height:44px;padding:8px 12px;border-radius:999px;color:var(--muted);text-decoration:none;font-weight:700;font-size:15px}
.tabs a:hover{color:var(--ink);background:color-mix(in srgb,var(--calm) 60%,transparent)}
.tabs a[aria-current="page"]{background:var(--calm);color:var(--ink)}
main.app{max-width:1120px;margin:0 auto;padding:20px 16px 110px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.page{max-width:760px;margin:0 auto}
@media (max-width:640px){
 .top{backdrop-filter:none;background:var(--paper)}
 .tabs{position:fixed;left:0;right:0;bottom:0;margin:0;justify-content:space-around;background:var(--surface);border-top:1px solid var(--line);padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
 .tabs a{flex-direction:column;gap:2px;font-size:12px;padding:6px 10px;border-radius:12px}
 h1{font-size:26px}
}
/* page heading */
.hello{margin:8px 0 18px}
.hello .date{color:var(--muted);font-size:15px;margin-top:4px}
.hero{position:relative;overflow:hidden;background:linear-gradient(135deg,var(--tint),var(--surface) 70%);border:1px solid var(--line);border-radius:22px;padding:22px 24px;margin:6px 0 18px;box-shadow:var(--shadow)}
.hero::after{content:"";position:absolute;right:-70px;top:-70px;width:200px;height:200px;border-radius:50%;background:color-mix(in srgb,var(--mark) 18%,transparent);pointer-events:none}
.hero>*{position:relative;z-index:1}
@media (max-width:640px){.hero{padding:18px}.hero h1{font-size:26px}.hero::after{width:120px;height:120px;right:-50px;top:-50px}}
.hero h1{font-size:32px}
.hero .date{color:var(--muted);font-size:15px;margin-top:4px}
.glance{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;position:relative;z-index:1}
.glance span{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:700;padding:6px 12px;border-radius:999px;background:var(--surface);border:1px solid var(--line)}
.glance span.g-warn{border-color:color-mix(in srgb,var(--mark) 70%,var(--line));background:color-mix(in srgb,var(--mark) 16%,var(--surface))}
.glance span.g-alert{border-color:color-mix(in srgb,var(--alert) 55%,var(--line));color:var(--alert)}
/* Today: the feed, with the day and what is coming up beside it on a wide screen */
.today{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"day" "feed" "side";gap:0 28px}
.t-day{grid-area:day}.t-feed{grid-area:feed;min-width:0}.t-side{grid-area:side;min-width:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 18px;box-shadow:var(--shadow)}
.card>h2{font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:2px 0 8px}
@media (min-width:1040px){.today{grid-template-columns:minmax(0,1fr) 340px;grid-template-rows:auto 1fr;grid-template-areas:"feed day" "feed side";align-items:start}.t-feed>.note:first-child{margin-top:0}.t-side>.sec:first-child{margin-top:22px}}
/* notes: what the team says */
.note{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px 20px 16px 24px;margin:14px 0;box-shadow:var(--shadow)}
.note::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:5px;border-radius:0 4px 4px 0;background:var(--line)}
.note.k-one::before{background:var(--mark)}
.note.k-heads::before{background:var(--alert)}
.note.k-plan::before{background:var(--action)}
.note.k-safety{border-color:var(--alert)}.note.k-safety::before{background:var(--alert)}
.note.k-one{background:linear-gradient(135deg,color-mix(in srgb,var(--mark) 12%,var(--surface)),var(--surface) 60%);box-shadow:var(--shadow-lg)}
.note .tag{position:absolute;top:14px;right:16px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--alert) 14%,var(--surface));color:var(--alert)}
.note h2{font-size:18px;margin-bottom:4px}
.note .body{white-space:pre-line}
.note .from{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--muted);margin-bottom:8px}
.note .from .av{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--tint);color:var(--action)}
details.why{margin-top:8px;font-size:14px;color:var(--muted)}
details.why summary{cursor:pointer;width:max-content}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
form.inline{display:inline}
.btn{font:inherit;font-weight:700;font-size:15px;display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:9px 16px;border-radius:999px;border:1.5px solid var(--action);background:var(--action);color:var(--action-ink);cursor:pointer;text-decoration:none}
.btn.quiet{background:var(--surface);color:var(--action);border-color:color-mix(in srgb,var(--action) 35%,var(--line))}
.btn.quiet:hover{background:var(--tint);filter:none}
.btn.call{background:var(--mark);border-color:var(--mark);color:var(--mark-ink)}
.btn.danger{background:transparent;color:var(--alert);border-color:var(--alert)}
.btn{transition:background .15s,filter .15s,transform .15s}.btn:hover{filter:brightness(1.06)}.btn:active{transform:translateY(1px)}
/* the day: a route line with stops */
.day{list-style:none;margin:6px 0 4px;padding:0;position:relative}
.day::before{content:"";position:absolute;left:68px;top:10px;bottom:10px;width:3px;background:var(--line);border-radius:2px}
.day li{display:grid;grid-template-columns:56px 28px 1fr;align-items:start;gap:0;padding:6px 0;min-height:44px}
.day .t{font-size:14px;color:var(--muted);text-align:right;padding-top:3px;font-variant-numeric:tabular-nums}
.day .dot{width:15px;height:15px;border-radius:50%;margin:5px 0 0 6.5px;background:var(--surface);border:3px solid var(--muted);position:relative;z-index:1}
.day .s-class .dot{border-color:var(--action)}
.day .s-shift .dot{border-color:var(--ink);background:var(--ink)}
.day .s-hold .dot{border-color:var(--mark);background:var(--mark)}
.day .s-due .dot{border-color:var(--alert)}
.day .s-now .dot{width:11px;height:11px;margin-left:8.5px;border:0;background:var(--focus)}
.day .s-now .what{color:var(--focus);font-weight:700;font-size:14px;padding-top:2px}
.day .what b{display:block}
.day .what span{font-size:14px;color:var(--muted)}
/* sections and lists */
.sec{margin:28px 0 10px;display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:6px 18px;box-shadow:var(--shadow)}
.rows{list-style:none;margin:0;padding:0}
.rows li{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
.rows li:last-child{border-bottom:0}
.rows .grow{flex:1;min-width:0}
.rows .grow b{display:block}
.rows .grow span{font-size:14px;color:var(--muted)}
.chip{display:inline-block;font-size:13px;padding:2px 9px;border-radius:999px;background:var(--calm);color:var(--ink);font-weight:700}
.chip.ok{background:color-mix(in srgb,var(--action) 18%,transparent)}
.chip.warn{background:color-mix(in srgb,var(--mark) 30%,transparent)}
.chip.bad{background:color-mix(in srgb,var(--alert) 20%,transparent)}
/* tiles */
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:10px 0}
.tile{display:flex;flex-direction:column;gap:10px;align-items:flex-start;min-height:104px;padding:16px;border-radius:var(--r-lg);background:var(--surface);border:1px solid var(--line);color:var(--ink);font:inherit;font-weight:700;text-align:left;cursor:pointer;width:100%;box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s,border-color .15s}
.tile:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:color-mix(in srgb,var(--action) 40%,var(--line))}
.tile .ic{color:var(--action);background:var(--tint);border-radius:10px;padding:7px;width:38px;height:38px}
/* big number */
.figure{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.figure .n{font-size:44px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
/* forms */
label{display:block;font-weight:700;margin:12px 0 6px}
input,textarea,select{font:inherit;width:100%;padding:11px 12px;border:1.5px solid var(--line);border-radius:var(--r-sm);background:var(--surface);color:var(--ink)}
.hint{font-size:14px;color:var(--muted);margin-top:4px}
/* week */
.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.week .d{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:8px;min-height:140px}
.week .d h3{font-size:13px;color:var(--muted);margin-bottom:6px}
.week .b{font-size:12px;border-radius:7px;padding:4px 6px;margin:4px 0;background:var(--calm);line-height:1.3}
.week .b.class{border-left:4px solid var(--action)}
.week .b.shift{border-left:4px solid var(--ink)}
.week .b.study,.week .b.hold{border-left:4px solid var(--mark)}
.week .b.pickup,.week .b.drop-off{border-left:4px solid var(--alert)}
.week .b.due{border-left:4px solid var(--alert);font-weight:700}
.week .prob{font-size:12px;color:var(--alert);font-weight:700}
@media (max-width:640px){.week{grid-template-columns:1fr}.week .d{min-height:0}.rows li{flex-wrap:wrap}.rows .grow{flex-basis:100%}}
table.t{width:100%;border-collapse:collapse;font-size:15px}
table.t th,table.t td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.t th{font-size:13px;color:var(--muted)}
.empty{padding:22px;text-align:center;color:var(--muted)}
/* console shell */
.console{display:grid;grid-template-columns:230px 1fr;min-height:100vh}
.side{background:var(--surface);border-right:1px solid var(--line);padding:16px 12px;position:sticky;top:0;height:100vh;overflow:auto}
.side a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;color:var(--ink);text-decoration:none;font-weight:700;font-size:15px}
.side a[aria-current="page"]{background:var(--calm)}
.side .grp{font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:20px 10px 6px;padding-top:12px;border-top:1px solid var(--line)}
.side .brand{margin:2px 6px 8px}
.side a:hover{background:color-mix(in srgb,var(--calm) 60%,transparent)}
main.con{padding:24px 28px 60px;max-width:1200px}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:14px 0}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:14px;box-shadow:var(--shadow)}
.kpi .n{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.kpi .l{font-size:14px;color:var(--muted)}
.bar{height:10px;border-radius:5px;background:var(--line);overflow:hidden}.bar>i{display:block;height:100%;background:var(--action)}
pre.code{background:var(--calm);padding:12px;border-radius:var(--r-sm);overflow:auto;font-size:13px}
@media (max-width:860px){.console{grid-template-columns:1fr}.side{position:static;height:auto;display:flex;flex-wrap:wrap;gap:4px}.side .grp{flex-basis:100%;margin:10px 10px 2px;padding-top:8px}main.con{padding:16px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
}

// ---------------------------------------------------------------- assets

const assetDir = fileURLToPath(new URL('../assets/', import.meta.url));
/** Static files a shell references, served by the host app under `${base}/_ui/`. */
export function uiAsset(name: string): { body: Uint8Array; type: string } | undefined {
  if (!/^atkinson-(400|700)\.woff2$/.test(name)) return undefined;
  return { body: readFileSync(`${assetDir}${name}`), type: 'font/woff2' };
}

// ---------------------------------------------------------------- shells

export interface NavItem {
  href: string;
  label: string;
  icon?: string;
  current?: boolean;
}

export interface ShellOpts {
  title: string;
  body: string;
  base?: string;
  brand?: string;
  brandHref?: string;
  nav?: NavItem[];
  lang?: string;
  head?: string;
  description?: string;
  /** The body uses the full width (it lays itself out); otherwise it is set at a comfortable reading width. */
  wide?: boolean;
}

const head = (o: ShellOpts) => `<!doctype html><html lang="${esc(o.lang ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${esc(o.title)}</title>${o.description ? `<meta name="description" content="${esc(o.description)}">` : ''}<meta name="theme-color" content="${TOKENS.light.action}"><style>${styles(o.base ?? '')}</style>${o.head ?? ''}</head>`;

export function appShell(o: ShellOpts): string {
  const nav = (o.nav ?? []).map((n) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}>${n.icon ? icon(n.icon, 20) : ''}<span>${esc(n.label)}</span></a>`).join('');
  return `${head(o)}<body><a class="skip" href="#main">Skip to content</a><header class="top"><div class="top-in"><a class="brand" href="${esc(o.brandHref ?? '/')}"><span class="brand-mark">${icon('route', 18)}</span>${esc(o.brand ?? 'App')}</a>${nav ? `<nav class="tabs" aria-label="Main">${nav}</nav>` : ''}</div></header><main id="main" class="app">${o.wide ? o.body : `<div class="page">${o.body}</div>`}</main></body></html>`;
}

/** A page that lays itself out entirely (a product or landing page): the design system, a skip link, and the body. */
export function bareShell(o: ShellOpts): string {
  return `${head(o)}<body><a class="skip" href="#main">Skip to content</a>${o.body}</body></html>`;
}

export function consoleShell(o: ShellOpts & { groups?: { title: string; items: NavItem[] }[] }): string {
  const side = (o.groups ?? [{ title: '', items: o.nav ?? [] }]).map((g) => `${g.title ? `<div class="grp">${esc(g.title)}</div>` : ''}${g.items.map((n) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}>${n.icon ? icon(n.icon, 18) : ''}${esc(n.label)}</a>`).join('')}`).join('');
  return `${head(o)}<body><a class="skip" href="#main">Skip to content</a><div class="console"><nav class="side" aria-label="Console"><a class="brand" href="${esc(o.brandHref ?? '/')}"><span class="brand-mark">${icon('shield', 18)}</span>${esc(o.brand ?? 'Console')}</a>${side}</nav><main id="main" class="con">${o.body}</main></div></body></html>`;
}

// ---------------------------------------------------------------- components

export interface Action {
  label: string;
  /** A link target, or a form post (url plus hidden fields). */
  href?: string;
  post?: { url: string; fields: Record<string, string> };
  variant?: 'primary' | 'quiet' | 'call' | 'danger';
  icon?: string;
}

export function button(a: Action): string {
  const cls = `btn${a.variant && a.variant !== 'primary' ? ` ${a.variant}` : ''}`;
  const inner = `${a.icon ? icon(a.icon, 18) : ''}${esc(a.label)}`;
  if (a.post) return `<form class="inline" method="post" action="${esc(a.post.url)}">${Object.entries(a.post.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button class="${cls}">${inner}</button></form>`;
  return `<a class="${cls}" href="${esc(a.href ?? '#')}">${inner}</a>`;
}

export const actions = (list: Action[]): string => (list.length ? `<div class="acts">${list.map(button).join('')}</div>` : '');

export interface NoteOpts {
  kind?: 'one' | 'heads' | 'plan' | 'info' | 'safety';
  title?: string;
  from?: string;
  body: string;
  why?: string;
  actions?: Action[];
  id?: string;
  /** An icon for who is speaking. */
  icon?: string;
}

/** Something the team says to the person, with why they are seeing it and what they can do next. */
export function note(n: NoteOpts): string {
  const tag = n.kind === 'heads' ? 'Heads up' : n.kind === 'safety' ? 'Right now' : '';
  return `<section class="note k-${n.kind ?? 'info'}"${n.id ? ` id="${esc(n.id)}"` : ''}${n.title ? ` aria-label="${esc(n.title)}"` : ''}>${tag ? `<span class="tag">${tag}</span>` : ''}${n.from ? `<div class="from">${n.icon ? `<span class="av">${icon(n.icon, 16)}</span>` : ''}${esc(n.from)}</div>` : ''}${n.title ? `<h2>${esc(n.title)}</h2>` : ''}<div class="body">${esc(n.body)}</div>${n.why ? `<details class="why"><summary>Why am I seeing this?</summary><p>${esc(n.why)}</p></details>` : ''}${actions(n.actions ?? [])}</section>`;
}

export interface Stop {
  time: string;
  title: string;
  sub?: string;
  kind: 'class' | 'shift' | 'hold' | 'due' | 'free' | 'now';
}

/** A day as a route line with stops: classes, shifts, held time, things due, and where "now" is. */
export function dayLine(stops: Stop[], label = 'Your day'): string {
  if (!stops.length) return '';
  return `<ol class="day" aria-label="${esc(label)}">${stops.map((s) => `<li class="s-${s.kind}"><span class="t">${esc(s.time)}</span><span class="dot"></span><span class="what">${s.kind === 'now' ? esc(s.title) : `<b>${esc(s.title)}</b>${s.sub ? `<span>${esc(s.sub)}</span>` : ''}`}</span></li>`).join('')}</ol>`;
}

/** Small facts at a glance, for the top of a screen. */
export function glance(items: { text: string; tone?: 'warn' | 'alert'; icon?: string }[]): string {
  return items.length ? `<div class="glance">${items.map((g) => `<span${g.tone ? ` class="g-${g.tone}"` : ''}>${g.icon ? icon(g.icon, 16) : ''}${esc(g.text)}</span>`).join('')}</div>` : '';
}

/** A titled card, for side panels. */
export const card = (title: string, body: string): string => `<section class="card"><h2>${esc(title)}</h2>${body}</section>`;

export function section(title: string, body: string, aside = ''): string {
  return `<div class="sec"><h2>${esc(title)}</h2>${aside}</div>${body}`;
}

export interface Row {
  title: string;
  sub?: string;
  chip?: { text: string; tone?: 'ok' | 'warn' | 'bad' };
  actions?: Action[];
  href?: string;
}

export function rows(items: Row[], empty?: string): string {
  if (!items.length) return `<div class="panel"><p class="empty">${esc(empty ?? 'Nothing here yet.')}</p></div>`;
  return `<div class="panel"><ul class="rows">${items
    .map((r) => `<li><div class="grow">${r.href ? `<a href="${esc(r.href)}"><b>${esc(r.title)}</b></a>` : `<b>${esc(r.title)}</b>`}${r.sub ? `<span>${esc(r.sub)}</span>` : ''}</div>${r.chip ? `<span class="chip${r.chip.tone ? ` ${r.chip.tone}` : ''}">${esc(r.chip.text)}</span>` : ''}${(r.actions ?? []).map(button).join('')}</li>`)
    .join('')}</ul></div>`;
}

export interface Tile {
  label: string;
  icon?: string;
  href?: string;
  post?: { url: string; fields: Record<string, string> };
}

export function tiles(items: Tile[], label: string): string {
  return `<div class="tiles" role="list" aria-label="${esc(label)}">${items
    .map((t) => {
      const inner = `${icon(t.icon ?? 'list', 24)}<span>${esc(t.label)}</span>`;
      return `<div role="listitem">${t.post ? `<form method="post" action="${esc(t.post.url)}">${Object.entries(t.post.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button class="tile">${inner}</button></form>` : `<a class="tile" href="${esc(t.href ?? '#')}">${inner}</a>`}</div>`;
    })
    .join('')}</div>`;
}

export function figure(value: string, label: string): string {
  return `<div class="figure"><span class="n">${esc(value)}</span><span class="muted">${esc(label)}</span></div>`;
}

export interface Field {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  multiline?: number;
  type?: string;
}

export function form(o: { url: string; fields: Field[]; submit: string; hidden?: Record<string, string> }): string {
  return `<form method="post" action="${esc(o.url)}">${Object.entries(o.hidden ?? {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${o.fields
    .map((f) => {
      const id = `f-${esc(f.name).replace(/[^\w-]/g, "_")}`;
      const ctl = f.multiline ? `<textarea id="${id}" name="${esc(f.name)}" rows="${f.multiline}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>${esc(f.value ?? '')}</textarea>` : `<input id="${id}" name="${esc(f.name)}" type="${esc(f.type ?? 'text')}" value="${esc(f.value ?? '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>`;
      return `<label for="${id}">${esc(f.label)}</label>${ctl}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}`;
    })
    .join('')}<div class="acts"><button class="btn">${esc(o.submit)}</button></div></form>`;
}

export interface WeekDay {
  label: string;
  blocks: { time: string; title: string; kind: string }[];
  problem?: string;
}

export function weekGrid(days: WeekDay[]): string {
  return `<div class="week">${days
    .map((d) => `<section class="d" aria-label="${esc(d.label)}"><h3>${esc(d.label)}</h3>${d.blocks.map((b) => `<div class="b ${esc(b.kind)}"><b>${esc(b.time)}</b> ${esc(b.title)}</div>`).join('')}${d.problem ? `<div class="prob">${esc(d.problem)}</div>` : ''}${d.blocks.length || d.problem ? '' : '<div class="small muted">Open</div>'}</section>`)
    .join('')}</div>`;
}

export function table(headers: string[], body: (string | number)[][], opts: { raw?: boolean[]; caption?: string } = {}): string {
  return `<div class="panel" style="overflow:auto"><table class="t">${opts.caption ? `<caption class="small muted" style="text-align:left;padding:8px 0">${esc(opts.caption)}</caption>` : ''}<thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c, i) => `<td>${opts.raw?.[i] ? String(c) : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function kpis(items: { value: string | number; label: string }[]): string {
  return `<div class="kpis">${items.map((k) => `<div class="kpi"><div class="n">${esc(k.value)}</div><div class="l">${esc(k.label)}</div></div>`).join('')}</div>`;
}

export function chip(text: string, tone?: 'ok' | 'warn' | 'bad'): string {
  return `<span class="chip${tone ? ` ${tone}` : ''}">${esc(text)}</span>`;
}

export function bar(fraction: number, label: string): string {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return `<div class="bar" role="img" aria-label="${esc(label)}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
}
