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

/**
 * Three themes, one per audience, so a person always knows where they are:
 *  - student: the app students use (and its product page): teal and amber.
 *  - admin: the app's staff side, a deeper variation of the same family with a dark side menu.
 *  - factory: the verification tooling (evidence, docs, the case, the map): blueprint blue.
 * Every theme defines the same tokens, light and dark.
 */
const common = { bar: '#10141f', barInk: '#e8ebf5', barMuted: '#9aa3bd', dotApp: '#9a8cff', dotAdmin: '#ffc83d', dotFactory: '#4fd3e3' };
export const THEMES = {
  student: {
    light: { ...common, paper: '#f5f6fb', surface: '#ffffff', ink: '#14152b', muted: '#464962', line: '#e1e3ef', action: '#3f33c0', actionInk: '#ffffff', mark: '#ffc83d', markInk: '#3a2700', alert: '#c2334b', calm: '#eeedfd', focus: '#1b5fd1', side: '#ffffff', sideInk: '#14152b', sideMuted: '#5a5d78', sideActive: '#eeedfd' },
    dark: { ...common, paper: '#0b0b16', surface: '#16172a', ink: '#ecedf8', muted: '#a3a6c4', line: '#2a2c48', action: '#a99dff', actionInk: '#120c3a', mark: '#ffc83d', markInk: '#2a1d00', alert: '#ff7d92', calm: '#1f1d40', focus: '#8db4ff', side: '#16172a', sideInk: '#ecedf8', sideMuted: '#a3a6c4', sideActive: '#1f1d40' },
  },
  admin: {
    light: { ...common, paper: '#f2f2fa', surface: '#ffffff', ink: '#14152b', muted: '#575a76', line: '#dddff0', action: '#4338ca', actionInk: '#ffffff', mark: '#ffc83d', markInk: '#3a2700', alert: '#c2334b', calm: '#e9e8fc', focus: '#1b5fd1', side: '#1a1747', sideInk: '#ecebff', sideMuted: '#a9a5e0', sideActive: '#2e2a72' },
    dark: { ...common, paper: '#09091a', surface: '#141530', ink: '#ecedf8', muted: '#a3a6c4', line: '#282a4c', action: '#a99dff', actionInk: '#120c3a', mark: '#ffc83d', markInk: '#2a1d00', alert: '#ff7d92', calm: '#1d1b42', focus: '#8db4ff', side: '#0f0e2a', sideInk: '#e4e2ff', sideMuted: '#9590d0', sideActive: '#2a2566' },
  },
  factory: {
    light: { ...common, paper: '#f3f6f8', surface: '#ffffff', ink: '#12202a', muted: '#53636f', line: '#d3dde4', action: '#0b6680', actionInk: '#ffffff', mark: '#0e9fb3', markInk: '#03262b', alert: '#b2412a', calm: '#e2f0f4', focus: '#b4590b', side: '#ffffff', sideInk: '#12202a', sideMuted: '#53636f', sideActive: '#e2f0f4' },
    dark: { ...common, paper: '#0a1318', surface: '#111e25', ink: '#e3edf2', muted: '#97abb6', line: '#22343e', action: '#5fd0e6', actionInk: '#032a33', mark: '#4fd3e3', markInk: '#03262b', alert: '#f08a6c', calm: '#13303a', focus: '#ffb36b', side: '#0e1a20', sideInk: '#e3edf2', sideMuted: '#97abb6', sideActive: '#173842' },
  },
} as const;
export type Theme = keyof typeof THEMES;
/** The student theme, kept under its old name for the app's manifest and icon. */
export const TOKENS = THEMES.student;

const vars = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`).join(';');

// ---------------------------------------------------------------- icons

const ICONS: Record<string, string> = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  cap: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/><path d="M22 9v6"/>',
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

export function styles(base = '', theme: Theme = 'student'): string {
  const T = THEMES[theme];
  return `
@font-face{font-family:"Atkinson Hyperlegible";src:url("${base}/_ui/atkinson-400.woff2") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Atkinson Hyperlegible";src:url("${base}/_ui/atkinson-700.woff2") format("woff2");font-weight:700;font-display:swap}
:root{${vars(T.light)};--r-lg:18px;--r-md:12px;--r-sm:8px;--shadow:0 1px 2px rgba(22,35,31,.06),0 2px 8px rgba(22,35,31,.05);--shadow-lg:0 2px 4px rgba(22,35,31,.06),0 10px 28px rgba(22,35,31,.09);--tint:color-mix(in srgb,var(--action) 9%,var(--surface));color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars(T.dark)};--shadow:0 1px 2px rgba(0,0,0,.35);--shadow-lg:0 8px 24px rgba(0,0,0,.4);color-scheme:dark}}
:root[data-theme="dark"]{${vars(T.dark)};--shadow:0 1px 2px rgba(0,0,0,.35);--shadow-lg:0 8px 24px rgba(0,0,0,.4);color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 "Atkinson Hyperlegible",system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--action);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:6px}
html{scroll-padding-top:96px;scroll-padding-bottom:24px}
@media (max-width:640px){html{scroll-padding-bottom:110px}}
.prose,.case{overflow-wrap:break-word}
table.t td a{display:inline-block;padding:3px 0;min-height:24px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);padding:8px 12px;border-radius:8px;z-index:10}.skip:focus{left:8px}
h1,h2,h3{line-height:1.2;margin:0}
h1{font-size:30px;letter-spacing:-.01em}
h2{font-size:21px}
h3{font-size:17px}
p{margin:.4em 0}
.muted{color:var(--muted)}
.small{font-size:14px}
.ic{flex:none;vertical-align:-5px}
/* the bar across every surface: where you are, and every other place, grouped by theme */
.zbar{background:var(--bar);color:var(--bar-ink);font-size:13px}
.zbar-in{max-width:1120px;margin:0 auto;display:flex;align-items:center;gap:4px 14px;flex-wrap:wrap;padding:6px max(16px,env(safe-area-inset-right,0px)) 6px max(16px,env(safe-area-inset-left,0px))}
.zbar a{color:var(--bar-ink);text-decoration:none;padding:3px 8px;border-radius:6px;white-space:nowrap}
.zbar a:hover{background:rgba(255,255,255,.1)}
.zbar a[aria-current="page"]{background:rgba(255,255,255,.16);font-weight:700}
.zbar .zg{display:inline-flex;align-items:center;gap:2px;flex-wrap:wrap}
.zbar .zl{color:var(--bar-muted);font-weight:700;margin-right:4px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.zbar .dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.zbar .d-app{background:var(--dot-app)}.zbar .d-admin{background:var(--dot-admin)}.zbar .d-factory{background:var(--dot-factory)}
.zbar .zmap{margin-left:auto;border:1px solid rgba(255,255,255,.25);font-weight:700}
.zbar .znarrow{display:none}
.zbar summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:9px max(16px,env(safe-area-inset-right,0px)) 9px max(16px,env(safe-area-inset-left,0px));font-weight:700;min-height:40px}
.zbar summary::-webkit-details-marker{display:none}
.zbar .zall{margin-left:auto;color:var(--bar-muted);font-weight:700;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:2px 8px}
.zbar details[open] .zall{background:rgba(255,255,255,.14)}
@media (max-width:640px){.zbar .zwide{display:none}.zbar .znarrow{display:block}.zbar-in{gap:2px 8px;padding-top:0}.zbar .zmap{margin-left:0}}
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
.week .d h2{font-size:13px;color:var(--muted);margin-bottom:6px}
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
.side{background:var(--side);color:var(--side-ink);border-right:1px solid var(--line);padding:16px 12px;position:sticky;top:0;height:100vh;overflow:auto}
.side a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;color:var(--side-ink);text-decoration:none;font-weight:700;font-size:15px}
.side a[aria-current="page"]{background:var(--side-active)}
.side .grp{font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--side-muted);margin:20px 10px 6px;padding-top:12px;border-top:1px solid var(--line)}
.side .brand{margin:2px 6px 8px}
.side a:hover{background:color-mix(in srgb,var(--side-active) 70%,transparent)}
.side .brand{color:var(--side-ink)}
.side-toggle{display:none;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--side-ink);font:inherit;font-weight:600;font-size:14px;cursor:pointer}.side-toggle:focus-visible{outline:3px solid var(--accent,#0b6680);outline-offset:2px}
main.con{padding:24px 28px 60px;max-width:1200px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:14px 0}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:14px;box-shadow:var(--shadow)}
.kpi .n{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
.kpi .l{font-size:14px;color:var(--muted)}
.bar{height:10px;border-radius:5px;background:var(--line);overflow:hidden}.bar>i{display:block;height:100%;background:var(--action)}
pre.code{background:var(--calm);padding:12px;border-radius:var(--r-sm);overflow:auto;font-size:13px}
@media (max-width:860px){.console{grid-template-columns:1fr}.side{position:static;height:auto;display:flex;flex-wrap:wrap;gap:4px}.side .grp{flex-basis:100%;margin:10px 10px 2px;padding-top:8px}main.con{padding:16px}}
/* readings: what was measured, what it must reach, whether it held */
.readings{background:var(--surface);border:1px solid var(--line);border-radius:16px;margin:18px 0 8px;padding:6px 22px}
.reading{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(120px,.8fr) minmax(0,1.6fr) 104px;gap:18px;align-items:center;padding:15px 0;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}
.reading:last-child{border-bottom:0}
a.reading:hover .l{color:var(--action)}
.reading .l{font-family:var(--display);font-weight:650;font-size:17px}
.reading .l small{display:block;font-family:"Atkinson Hyperlegible",system-ui,sans-serif;font-weight:400;font-size:13px;color:var(--muted)}
.reading .v{font-family:var(--display);font-size:26px;font-weight:650;letter-spacing:-.02em;text-align:right;white-space:nowrap}
.reading .v span{font-size:15px;color:var(--muted);font-weight:500;letter-spacing:0}
.gauge{position:relative;height:12px;border-radius:6px;background:var(--r-gauge,var(--line))}
.gauge i{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:var(--action)}
.gauge b{position:absolute;top:-5px;bottom:-5px;width:2px;background:var(--ink);border-radius:1px}
.gauge.none{background:repeating-linear-gradient(90deg,var(--r-gauge,var(--line)) 0 6px,transparent 6px 10px)}
.state{justify-self:end;display:inline-flex;align-items:center;gap:7px;font-weight:700;font-size:14px}
.state::before{content:"";width:10px;height:10px;border-radius:50%;background:currentColor}
.state.pass{color:var(--r-pass,#1d7a55)}.state.fail{color:var(--r-fail,var(--alert))}.state.unk{color:var(--r-unk,#8a6a12)}.state.count{color:var(--muted)}.state.count::before{border-radius:2px;width:9px;height:9px}
.reading.fail .gauge i{background:var(--r-fail,var(--alert))}
@media (max-width:760px){.reading{grid-template-columns:minmax(0,1fr) auto;gap:8px 12px}.reading .gauge{grid-column:1/-1;order:3}.reading .state{order:4;grid-column:1/-1;justify-self:start}.readings{padding:4px 16px}}
.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:16px 0 8px}
.choice{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px 18px;min-width:0}
.choice h2{font-size:18px;margin:0 0 6px}
.choice.off{opacity:.92}.choice.off h2{color:var(--muted)}
.choice dl{margin:10px 0 0;display:grid;gap:2px}
.choice dt{font-size:13px;font-weight:700;color:var(--muted);margin-top:8px}
.choice dd{margin:0;font-size:15px}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.checks{border:0;padding:0;margin:0 0 14px}.checks legend{font-weight:700;margin-bottom:6px}.check{display:flex;align-items:center;gap:10px;font-weight:400;min-height:44px}.check input{width:24px;height:24px;flex:none}

/* ---- controls: one look and behaviour for every button, field and choice ---- */
a{text-underline-offset:3px;text-decoration-thickness:1.5px}
.btn{position:relative;justify-content:center;text-align:center;line-height:1.2;-webkit-tap-highlight-color:transparent;user-select:none}
.btn:active{transform:scale(.97)}
.btn:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.btn .ic{flex:none}
.btn[disabled],.btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed;transform:none}
.btn.busy{pointer-events:none}
.btn.busy>span{opacity:0}
.btn.busy::after{content:"";position:absolute;inset:0;margin:auto;width:18px;height:18px;border-radius:50%;border:2.5px solid currentColor;border-right-color:transparent;animation:zspin .7s linear infinite}
@keyframes zspin{to{transform:rotate(360deg)}}
.btn.danger:hover{background:color-mix(in srgb,var(--alert) 10%,transparent)}
.btn.danger.solid{background:var(--alert);border-color:var(--alert);color:var(--on-alert,#fff)}
/* facts: a label and its value, side by side, stacked on a phone */
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:6px 0 4px}.facts dt{font-weight:700}.facts dd{margin:0;overflow-wrap:break-word}
@media (max-width:560px){.facts{grid-template-columns:minmax(0,1fr);gap:2px}.facts dd{margin-bottom:8px}}
.field{margin:0 0 14px}
.field label{margin:0 0 6px}
input,textarea,select{min-height:48px;transition:border-color .15s,box-shadow .15s}
input:hover,textarea:hover,select:hover{border-color:color-mix(in srgb,var(--ink) 35%,var(--line))}
input:user-invalid,textarea:user-invalid,select:user-invalid{border-color:var(--alert)}
input[readonly]{background:color-mix(in srgb,var(--ink) 4%,var(--surface))}
input[type=number]{-moz-appearance:textfield;appearance:textfield}
input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
select{-webkit-appearance:none;appearance:none;padding-right:44px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23767993' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
input[type=checkbox]{accent-color:var(--l-route,var(--action))}
.check{padding:4px 0;cursor:pointer}
.check:hover{color:var(--l-route,var(--action))}
/* disclosure */
details.why summary{list-style:none;display:inline-flex;align-items:center;gap:8px;min-height:32px;font-weight:600;border-radius:8px;width:max-content;max-width:100%}
details.why summary::-webkit-details-marker{display:none}
details.why summary::before{content:"";width:7px;height:7px;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(-45deg);transition:transform .15s;flex:none}
details.why[open] summary::before{transform:rotate(45deg)}
details.why summary:hover{color:var(--ink)}
details.why p{margin:6px 0 0;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--ink) 5%,transparent);color:var(--ink)}
/* switch */
.sw{display:inline-flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;border:0;background:none;cursor:pointer;font:inherit;font-weight:700;color:var(--ink);border-radius:999px;-webkit-tap-highlight-color:transparent}
.sw-track{width:52px;height:32px;border-radius:999px;background:color-mix(in srgb,var(--ink) 10%,var(--surface));box-shadow:inset 0 0 0 2px var(--muted);position:relative;flex:none;transition:background .2s,box-shadow .2s}
.sw-thumb{position:absolute;top:4px;left:4px;width:24px;height:24px;border-radius:50%;background:var(--muted);transition:transform .2s,background .2s}
.sw[aria-checked="true"] .sw-track{background:var(--l-route,var(--action));box-shadow:none}
.sw[aria-checked="true"] .sw-thumb{transform:translateX(20px);background:#fff}
.sw-text{font-size:14px;color:var(--muted);min-width:2em;text-align:left}
.sw:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.sw.busy .sw-thumb{opacity:.6}
/* segmented choice */
.seg{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px;padding:4px;border-radius:16px;background:color-mix(in srgb,var(--ink) 6%,var(--surface));border:1px solid var(--line);max-width:100%}
.seg form.inline{display:flex}.seg-b{width:100%}
@media (max-width:640px){.seg{display:grid;width:100%}.seg-b{padding:8px 6px;font-size:14px;line-height:1.2}}
.seg-b{font:inherit;font-weight:700;font-size:15px;min-height:44px;padding:8px 18px;border-radius:12px;border:0;background:transparent;color:var(--muted);cursor:pointer;transition:background .15s,color .15s}
.seg-b:hover{color:var(--ink)}
.seg-b[aria-pressed="true"]{background:var(--surface);color:var(--l-route,var(--action));box-shadow:0 1px 3px color-mix(in srgb,var(--ink) 18%,transparent),0 0 0 1px var(--line)}
.seg-b:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
/* copy */
.copy{display:flex;gap:8px;align-items:stretch;margin-top:10px}
.copy input{flex:1;min-width:0}
.copy .btn.copied{border-color:var(--r-pass,#1d7a55);color:var(--r-pass,#1d7a55)}
/* whole rows are the link, with their buttons on top */
.rows li{position:relative}
.rows .grow>a::after{content:"";position:absolute;inset:0;border-radius:12px}
.rows li .btn,.rows li form,.rows li .sw{position:relative;z-index:1}
.rows li:has(.sw){flex-wrap:nowrap;align-items:center}
.rows li:has(>.grow>a):hover{background:color-mix(in srgb,var(--l-route,var(--action)) 5%,transparent);border-radius:12px}
/* on a phone, a note's buttons line up full width, the first one first */
@media (max-width:640px){.note .acts{display:grid;grid-template-columns:1fr}.note .acts form.inline{display:block}.note .acts .btn{width:100%}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
${theme === 'student' ? studentLayer(base) : theme === 'factory' ? factoryLayer(base) : theme === 'admin' ? adminLayer(base) : ''}`;
}

/** The app's admin: the student app's type and green, arranged as a quiet console of counts. */
function adminLayer(base: string): string {
  return `
@font-face{font-family:"Bricolage Grotesque";src:url("${base}/_ui/bricolage.woff2") format("woff2");font-weight:200 800;font-display:swap}
:root{--display:"Bricolage Grotesque","Atkinson Hyperlegible",system-ui,sans-serif}
h1,h2,h3,.brand,.kpi .n{font-family:var(--display);letter-spacing:-.015em}
.side .grp{text-transform:none;letter-spacing:0;font-size:13px}
.side a{font-weight:600}
.panel,.card,.kpi{box-shadow:none}
.kpis{gap:0;background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.kpi{border:0;border-radius:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:none;padding:16px 18px;margin:0 -1px -1px 0}
.kpi .n{font-size:32px;font-weight:650;font-variant-numeric:tabular-nums}
table.t th{border-bottom:1.5px solid var(--ink)}
@media (max-width:860px){.side{flex-wrap:wrap;align-items:center;overflow:visible;padding:8px 12px;gap:4px}.side .grp,.side .brand{display:none}.side a{flex:0 1 auto;min-width:0;max-width:100%;padding:7px 10px;font-size:14px}.side.closed a:not([aria-current="page"]){display:none}.side-toggle{display:inline-flex;margin-left:auto}}
`;
}

/**
 * The factory: an inspection report. Pages are drafted in blue ink on cool paper ruled faintly like graph paper,
 * every figure is set in tabular numerals, and the summary reads as measurements against tolerances: each check
 * shows what was measured, what it must reach, and whether it held, with "not measured" as its own state.
 */
function factoryLayer(base: string): string {
  return `
@font-face{font-family:"Bricolage Grotesque";src:url("${base}/_ui/bricolage.woff2") format("woff2");font-weight:200 800;font-display:swap}
:root{--display:"Bricolage Grotesque","Atkinson Hyperlegible",system-ui,sans-serif;--rule:rgba(11,102,128,.06);--r-pass:#1d7a55;--r-fail:#b2412a;--r-unk:#8a6a12;--r-gauge:#dfe8ed}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--rule:rgba(95,208,230,.05);--r-pass:#5fd39e;--r-fail:#f08a6c;--r-unk:#e8c066;--r-gauge:#1d2f38}}
:root[data-theme="dark"]{--rule:rgba(95,208,230,.05);--r-pass:#5fd39e;--r-fail:#f08a6c;--r-unk:#e8c066;--r-gauge:#1d2f38}
h1,h2,h3,.brand{font-family:var(--display);letter-spacing:-.015em}
h1{font-size:clamp(30px,3.4vw,40px);font-weight:700;line-height:1.08}
h2{font-weight:650}
main.con,body>main{background-image:linear-gradient(var(--rule) 1px,transparent 1px),linear-gradient(90deg,var(--rule) 1px,transparent 1px);background-size:24px 24px}
main.con{max-width:none;padding:30px clamp(16px,3vw,44px) 72px}
main.con>*{max-width:1080px}
main.con>h1+p.muted,main.con>h1+p{font-size:17px;max-width:72ch}
table.t,.kpi .n,.reading .v{font-variant-numeric:tabular-nums}
/* sidebar: plain section names, the current page marked by an ink rule */
.side .grp{text-transform:none;letter-spacing:0;font-size:13px;color:var(--side-muted);font-weight:700}
.side a{font-weight:600;border-radius:8px;position:relative}
.side a[aria-current="page"]{background:var(--side-active);color:var(--action)}
.side a[aria-current="page"]::before{content:"";position:absolute;left:-12px;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--action)}
.side .brand-mark{border-radius:8px;background:var(--action)}
/* panels: flat sheets with a hairline, no drop shadows */
.panel,.card,.kpi{box-shadow:none}
.panel{border-radius:14px}
.sec h2{font-size:21px}
table.t th{font-size:13px;font-weight:700;color:var(--muted);border-bottom:1.5px solid var(--ink)}
table.t td{padding:10px 8px}
table.t tr:hover td{background:color-mix(in srgb,var(--action) 4%,transparent)}
code{font-size:.9em;background:color-mix(in srgb,var(--action) 8%,transparent);padding:1px 5px;border-radius:5px}
/* the readout strip: figures in one sheet, divided by rules, never a wall of cards */
.kpis{gap:0;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.kpi{border:0;border-radius:0;border-right:1px solid var(--line);background:none;padding:16px 18px}
.kpi:last-child{border-right:0}
.kpi .n{font-family:var(--display);font-size:30px;font-weight:650;letter-spacing:-.02em}
/* navigation lists read as an index with arrows, not as prose links */
.rows .grow>a{text-decoration:none;color:var(--ink);display:block}
.rows .grow>a b{font-family:var(--display);font-weight:650;font-size:17px}
.rows .grow>a b::after{content:"";display:inline-block;width:7px;height:7px;margin-left:9px;border:solid var(--action);border-width:2px 2px 0 0;transform:translateY(-2px) rotate(45deg)}
.rows .grow>a:hover b{color:var(--action)}
.rows li{padding:14px 0}
/* long-form writing in the factory */
.prose{max-width:76ch}
.prose h2{margin-top:1.6em}
.prose a{color:var(--action)}
pre.mermaid{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:none}
.chip{border-radius:7px}
@media (max-width:860px){main.con>*{max-width:none}}
/* a list that is only links reads as an index of pages */
.prose ul:has(>li>a:only-child){list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:0 24px;border-top:1px solid var(--line)}
.prose ul:has(>li>a:only-child)>li{border-bottom:1px solid var(--line);margin:0}
.prose ul:has(>li>a:only-child)>li>a{display:block;padding:11px 0;text-decoration:none;color:var(--ink);font-weight:700}
.prose ul:has(>li>a:only-child)>li>a:hover{color:var(--action)}
/* phone: the page list folds behind a Menu button under the bar, so the page itself comes first; open, it wraps */
@media (max-width:860px){
 .side{flex-wrap:wrap;align-items:center;overflow:visible;gap:4px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:4}
 .side.closed a:not([aria-current="page"]){display:none}
 .side-toggle{display:inline-flex;margin-left:auto}
 .side .grp,.side .brand{display:none}
 .side a{flex:0 1 auto;min-width:0;max-width:100%;padding:8px 12px;font-size:14px}
 .side a[aria-current="page"]::before{display:none}
 .side a .ic{display:none}
}
`;
}

/**
 * The student app: a transit map of the day. Each kind of commitment is a line color (class, work, care, held
 * time, due, money), the route on Today is the spine of the app, and the one thing to do today is the single bold
 * block. Everything else is flat and quiet. Bricolage Grotesque sets headings; Atkinson Hyperlegible stays for
 * reading, chosen for low-vision readers.
 */
function studentLayer(base: string): string {
  const lines = { light: '--l-class:#2f6bff;--l-work:#ff7a1a;--l-care:#ec4899;--l-hold:#14b8a6;--l-due:#e5384f;--l-money:#f5b400;--l-route:#5145e8', dark: '--l-class:#6f9bff;--l-work:#ff9a52;--l-care:#ff79b6;--l-hold:#3fd9c4;--l-due:#ff7d92;--l-money:#ffc83d;--l-route:#a99dff' };
  const DARK = `${lines.dark};--paper:#0b0b16;--line:#2a2c48;--board:#100e2e;--board-2:#241a5c;--board-ink:#f4f3ff;--board-muted:#aaa5dc;--on-route:#120c3a;--glass:rgba(22,23,44,.72);--glass-line:rgba(255,255,255,.07);--g1:rgba(110,86,255,.42);--g2:rgba(0,170,255,.24);--g3:rgba(255,80,160,.22);--g4:rgba(255,190,60,.10);--lift:0 12px 34px -16px rgba(0,0,0,.6);--on-alert:#2a0710;--r-pass:#5fd39e;--r-unk:#e8c066;--r-fail:#ff7d92`;
  return `
@font-face{font-family:"Bricolage Grotesque";src:url("${base}/_ui/bricolage.woff2") format("woff2");font-weight:200 800;font-display:swap}
:root{${lines.light};--display:"Bricolage Grotesque","Atkinson Hyperlegible",system-ui,sans-serif;--paper:#f5f6fb;--line:#e1e3ef;--board:#15123d;--board-2:#2b1d6e;--board-ink:#f4f3ff;--board-muted:#b6b2e6;--on-route:#ffffff;--glass:rgba(255,255,255,.78);--glass-line:rgba(255,255,255,.9);--g1:rgba(110,86,255,.38);--g2:rgba(0,190,255,.30);--g3:rgba(255,92,170,.26);--g4:rgba(255,190,60,.22);--lift:0 1px 2px rgba(20,21,43,.04),0 10px 30px -14px rgba(60,50,160,.22)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
/* the backdrop: soft color fields under every container */
body{background:var(--paper);position:relative;isolation:isolate}
body::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(60% 50% at 5% 0%,var(--g1),transparent 72%),radial-gradient(50% 45% at 100% 12%,var(--g2),transparent 72%),radial-gradient(60% 50% at 90% 100%,var(--g3),transparent 72%),radial-gradient(45% 40% at 0% 80%,var(--g4),transparent 72%)}
.t-day .card{position:relative;overflow:hidden}
.t-day .card::before{content:"";position:absolute;right:-20%;top:-40%;width:70%;height:120%;background:radial-gradient(closest-side,rgba(130,110,255,.35),transparent);pointer-events:none}
.t-day .card>*{position:relative}
.panel,.card,.note,.tile,.kpi,.week .d,.glance span,.tabs,.choice{background:var(--glass);border-color:var(--glass-line);box-shadow:var(--lift);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%)}
.top{background:color-mix(in srgb,var(--paper) 80%,transparent)!important;-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%);border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent)}
h1,h2,h3,.brand,.figure .n{font-family:var(--display);letter-spacing:-.015em}
h1{font-weight:700}h2{font-weight:650}
/* header: quiet, with the tabs as one segmented control */
.top{border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent)}
.brand{font-size:19px;font-weight:700}
.brand-mark{border-radius:10px;background:linear-gradient(135deg,#6f5cff,#2f9bff);color:#fff;box-shadow:0 6px 16px -6px rgba(81,69,232,.6)}
.tabs{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:4px;gap:2px}
.tabs a{border-radius:10px;min-height:44px;padding:8px 14px}
.tabs a[aria-current="page"]{background:var(--l-route);color:var(--on-route)}
.tabs a[aria-current="page"] .ic{color:var(--on-route)}
/* greeting: type does the work, no card */
.hero{background:none;border:0;box-shadow:none;padding:12px 0 6px;margin:0 0 14px;overflow:visible}
.hero::after{display:none}
.hero h1{font-size:clamp(34px,5vw,48px);font-weight:700;line-height:1.02}
.hero .date{font-size:17px;margin-top:6px}
.glance{margin-top:16px;gap:8px}
.glance span{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:7px 12px;font-size:14px}
.glance span .ic{color:var(--l-route)}
.glance span.g-warn{background:color-mix(in srgb,var(--l-money) 16%,var(--surface));border-color:color-mix(in srgb,var(--l-money) 55%,var(--line))}
.glance span.g-warn .ic{color:color-mix(in srgb,var(--l-money) 70%,var(--ink))}
/* the route: the day as a transit line on a dark board, the one bold thing on the screen */
.t-day .card{--l-class:#6f9bff;--l-work:#ff9a52;--l-care:#ff79b6;--l-hold:#3fd9c4;--l-due:#ff7d92;--l-money:#ffc83d;background:linear-gradient(150deg,var(--board) 0%,var(--board-2) 100%);color:var(--board-ink);border:1px solid rgba(255,255,255,.08);box-shadow:0 24px 50px -24px rgba(40,25,140,.55);-webkit-backdrop-filter:none;backdrop-filter:none;border-radius:26px;padding:22px 22px 14px;margin:0 0 18px}
.t-day .card>h2{font-family:var(--display);text-transform:none;letter-spacing:-.015em;font-size:26px;font-weight:700;color:var(--board-ink);margin:0 0 14px}
.day{margin:0}
.day::before{display:none}
.day li{grid-template-columns:84px 30px minmax(0,1fr);padding:0;min-height:64px;position:relative}
.day li::after{content:"";position:absolute;left:96px;top:24px;bottom:-6px;width:6px;border-radius:3px;background:var(--lc,var(--board-muted))}
.day li:last-child::after{display:none}
.day .t{font-family:var(--display);font-size:16px;font-weight:600;color:var(--board-ink);padding-top:5px;white-space:nowrap;text-align:right;padding-right:12px}
.day .dot{width:24px;height:24px;margin:4px 0 0 3px;border:6px solid var(--lc,var(--board-muted));background:var(--board);z-index:2}
.day .what{padding:4px 0 14px 10px}
.day .what b{font-size:18px;color:var(--board-ink)}
.day .what span{color:var(--board-muted);font-size:15px}
.day .s-class{--lc:var(--l-class)}.day .s-shift{--lc:var(--l-work)}.day .s-hold{--lc:var(--l-hold)}.day .s-due{--lc:var(--l-due)}
.t-day .day li .dot{border-color:var(--lc,var(--board-muted));background:var(--board)}
.t-day .day li.s-now .dot{background:#fff}
.day .what b{font-family:var(--display);font-weight:650;letter-spacing:-.005em}
.day .s-now{min-height:40px}.day .s-now::after{background:color-mix(in srgb,var(--board-muted) 45%,transparent)}
.day .s-now .t{color:var(--board-ink);opacity:.8;font-size:14px}
.day .s-now .dot{width:16px;height:16px;margin:6px 0 0 7px;border:0;background:#fff;box-shadow:0 0 0 5px color-mix(in srgb,#fff 22%,transparent)}
.day .s-now .what{color:var(--board-ink);font-size:14px;font-weight:700;padding-top:3px}
.day-key{display:flex;flex-wrap:wrap;gap:6px 16px;margin:4px 0 4px;padding-top:12px;border-top:1px solid color-mix(in srgb,var(--board-ink) 14%,transparent);font-size:13px;color:var(--board-muted)}
.day-key span{display:inline-flex;align-items:center;gap:6px}
.day-key i{width:14px;height:6px;border-radius:3px;background:var(--k)}
@media (min-width:1040px){.today{grid-template-columns:minmax(0,1fr) 340px;grid-template-areas:"day side" "feed side"}.t-side>.sec:first-child{margin-top:0}}
/* notes: flat, the speaker first, the line color of what it is about */
.note{box-shadow:none;border-radius:20px;padding:18px 20px 18px 24px}
.note::before{top:18px;bottom:18px;width:5px;border-radius:0 4px 4px 0}
.note.k-heads::before{background:var(--l-due)}.note.k-plan::before{background:var(--l-class)}
.note .from{color:var(--ink);font-size:14px}
.note .from .av{background:color-mix(in srgb,var(--l-route) 14%,var(--surface));color:var(--l-route);border-radius:9px}
.note .tag{border-radius:8px;text-transform:none;letter-spacing:0;font-size:13px;background:color-mix(in srgb,var(--l-due) 12%,var(--surface));color:var(--l-due)}
/* the one thing: a plain card whose sentence is set large */
.note.k-one{background:var(--surface);border:1px solid var(--line);box-shadow:none}
.note.k-one::before{background:var(--l-route)}
.note.k-one h2{font-family:var(--display);font-size:15px;font-weight:650;color:var(--l-route);margin-bottom:6px}
.note.k-one .body{font-family:var(--display);font-size:clamp(21px,2.6vw,25px);font-weight:600;line-height:1.22;letter-spacing:-.01em}
.note.k-info::before{display:none}
.t-feed>h2{font-size:22px;margin:22px 0 10px}
/* buttons: rounded rectangles, the route color */
.btn{border-radius:14px;min-height:46px;padding:10px 18px;background:var(--l-route);border-color:var(--l-route);color:var(--on-route)}
.btn:not(.quiet):not(.call):not(.danger){background:linear-gradient(135deg,color-mix(in srgb,var(--l-route) 88%,#fff),var(--l-route));box-shadow:0 8px 20px -10px color-mix(in srgb,var(--l-route) 80%,transparent)}
.btn.quiet{background:var(--glass);color:var(--ink);border-color:var(--line)}
.btn.quiet .ic{color:var(--l-route)}
.btn.quiet:hover{background:color-mix(in srgb,var(--l-route) 8%,var(--surface))}
.btn.call{background:var(--l-money);border-color:var(--l-money);color:#2a1d00;box-shadow:none}
/* sections and lists: flat, separated by space and hairlines */
.sec h2{font-size:22px}
.panel{box-shadow:none;border-radius:20px}
.card{box-shadow:none;border-radius:20px}
.rows li{padding:14px 0}
.kpi{box-shadow:none;border-radius:18px}
/* help tiles: each a different line color, flat */
.tile{box-shadow:none;border-radius:20px;min-height:116px;padding:18px;font-family:var(--display);font-size:17px;font-weight:650;transition:border-color .15s,background .15s}
.tile:hover{transform:none;box-shadow:none;border-color:var(--tc,var(--l-route));background:color-mix(in srgb,var(--tc,var(--l-route)) 6%,var(--surface))}
.tile .ic{background:color-mix(in srgb,var(--tc,var(--l-route)) 14%,var(--surface));color:var(--tc,var(--l-route));border-radius:12px;width:42px;height:42px;padding:9px}
.tiles>*:nth-child(6n+1) .tile{--tc:var(--l-route)}.tiles>*:nth-child(6n+2) .tile{--tc:var(--l-class)}.tiles>*:nth-child(6n+3) .tile{--tc:var(--l-work)}
.tiles>*:nth-child(6n+4) .tile{--tc:var(--l-care)}.tiles>*:nth-child(6n+5) .tile{--tc:var(--l-hold)}.tiles>*:nth-child(6n+6) .tile{--tc:var(--l-money)}
/* week: the same line colors as the route */
.week .d{border-radius:16px}
.week .b.class{border-left-color:var(--l-class)}.week .b.shift{border-left-color:var(--l-work)}.week .b.study,.week .b.hold{border-left-color:var(--l-hold)}
.week .b.pickup,.week .b.drop-off{border-left-color:var(--l-care)}.week .b.due{border-left-color:var(--l-due)}
input,textarea,select{border-radius:12px;padding:12px 14px}
input:focus,textarea:focus,select:focus{border-color:var(--l-route);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--l-route) 22%,transparent)}
/* phone: an app's bottom bar */
@media (max-width:640px){
 .top{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:var(--paper)!important}
 .tabs{background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(14px);border:0;border-top:1px solid var(--line);border-radius:0;padding:6px 6px calc(8px + env(safe-area-inset-bottom))}
 .tabs a{border-radius:12px;min-height:52px;font-size:12px}
 .tabs a[aria-current="page"]{background:color-mix(in srgb,var(--l-route) 14%,var(--surface));color:var(--l-route)}
 .tabs a[aria-current="page"] .ic{color:var(--l-route)}
 .hero h1{font-size:34px}
 .glance{flex-wrap:wrap;gap:6px}
 .glance span{white-space:nowrap}
 .t-day .card{border-radius:22px;padding:18px 14px 10px}
 .day li{grid-template-columns:76px 30px minmax(0,1fr)}.day li::after{left:88px}.day .t{font-size:14px;padding-right:8px}
}
a.tile,a.tile:hover{text-decoration:none;color:var(--ink)}
/* lists of places to go read as navigation, not as links in prose */
.rows .grow>a{text-decoration:none;color:var(--ink);display:block}
.rows .grow>a b::after{content:"";display:inline-block;width:7px;height:7px;margin-left:8px;border:solid var(--l-route);border-width:2px 2px 0 0;transform:translateY(-2px) rotate(45deg)}
.rows .grow>a:hover b{color:var(--l-route)}
/* the week: the same line colors, as tinted blocks */
.week{gap:8px}
.page:has(.week){max-width:1088px}
.week .d{min-width:0;border-radius:16px;padding:10px;box-shadow:none}
@media (max-width:900px){.week{grid-template-columns:1fr!important}.week .d{min-width:0}}
.week .d h2{font-family:var(--display);font-size:14px;color:var(--ink);font-weight:650}
.week .b{--bc:var(--l-route);font-size:13px;border-radius:9px;padding:6px 8px;border-left:4px solid var(--bc);background:color-mix(in srgb,var(--bc) 11%,var(--surface))}
.week .b.class{--bc:var(--l-class)}.week .b.shift{--bc:var(--l-work)}.week .b.study,.week .b.hold{--bc:var(--l-hold)}.week .b.pickup,.week .b.drop-off{--bc:var(--l-care)}.week .b.due{--bc:var(--l-due)}
.week .d .b{border-left-color:var(--bc)}
.figure{box-shadow:none}
.figure .n{color:var(--l-route)}`;
}

// ---------------------------------------------------------------- assets

const assetDir = fileURLToPath(new URL('../assets/', import.meta.url));
/** Static files a shell references, served by the host app under `${base}/_ui/`. */
export function uiAsset(name: string): { body: Uint8Array; type: string } | undefined {
  if (name === 'app.js') return { body: readFileSync(`${assetDir}app.js`), type: 'text/javascript; charset=utf-8' };
  if (!/^(atkinson-(400|700)|bricolage)\.woff2$/.test(name)) return undefined;
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
  /** Which theme the surface wears. */
  theme?: Theme;
  /** Which surface this page belongs to; shows the bar with every other surface. */
  surface?: Surface;
}

/** Every surface, once, with one label each. The bar on every page is drawn from this list. */
export const SURFACES = [
  { key: 'product', group: 'app', label: 'About the app', href: 'https://zthr.ai/advocate' },
  { key: 'app', group: 'app', label: 'Use the app', href: 'https://zthr.ai/studentadvocate/' },
  { key: 'admin', group: 'admin', label: 'App admin', href: 'https://zthr.ai/studentadvocate/admin/' },
  { key: 'evidence', group: 'factory', label: 'Evidence', href: 'https://zthr.ai/reference/factory/' },
  { key: 'docs', group: 'factory', label: 'Docs', href: 'https://zthr.ai/reference/docs/' },
  { key: 'case', group: 'factory', label: 'The case', href: 'https://zthr.ai/reference/case' },
  { key: 'map', group: 'map', label: 'Map: how it fits together', href: 'https://zthr.ai/reference' },
  { key: 'zthr', group: 'zthr', label: 'ZTHR', href: 'https://zthr.ai/' },
] as const;
export type Surface = (typeof SURFACES)[number]['key'];

/** The bar across the top of every surface. On a phone it folds into one line that names where you are. */
export function zbar(current?: Surface): string {
  const link = (k: Surface) => {
    const x = SURFACES.find((s) => s.key === k)!;
    return `<a href="${x.href}"${k === current ? ' aria-current="page"' : ''}${k === 'map' ? ' class="zmap"' : ''}>${esc(x.label)}</a>`;
  };
  const groups = `${link('zthr')}<span class="zg"><span class="zl"><i class="dot d-app"></i>Student Advocate</span>${link('product')}${link('app')}<span class="zl" style="margin-left:6px"><i class="dot d-admin"></i></span>${link('admin')}</span><span class="zg"><span class="zl"><i class="dot d-factory"></i>Factory</span>${link('evidence')}${link('docs')}${link('case')}</span>${link('map')}`;
  const here = SURFACES.find((s) => s.key === current);
  const dot = here ? (here.group === 'app' ? 'd-app' : here.group === 'admin' ? 'd-admin' : 'd-factory') : 'd-factory';
  return `<nav class="zbar" aria-label="All of the Student Advocate and ZTHR"><div class="zbar-in zwide">${groups}</div><details class="znarrow"><summary><i class="dot ${dot}"></i><span>${esc(here?.label ?? 'ZTHR')}</span><span class="zall">All parts</span></summary><div class="zbar-in">${groups}</div></details></nav>`;
}

const head = (o: ShellOpts) => `<!doctype html><html lang="${esc(o.lang ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${esc(o.title)}</title>${o.description ? `<meta name="description" content="${esc(o.description)}">` : ''}<meta name="theme-color" content="${THEMES[o.theme ?? 'student'].light.action}"><style>${styles(o.base ?? '', o.theme ?? 'student')}</style>${o.head ?? ''}</head>`;

export function appShell(o: ShellOpts): string {
  const nav = (o.nav ?? []).map((n) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}>${n.icon ? icon(n.icon, 20) : ''}<span>${esc(n.label)}</span></a>`).join('');
  const enhanced = { ...o, head: `${o.head ?? ''}<script src="${esc(o.base ?? '')}/_ui/app.js" defer></script>` };
  return `${head(enhanced)}<body><a class="skip" href="#main">Skip to content</a>${o.surface ? zbar(o.surface) : ''}<header class="top"><div class="top-in"><a class="brand" href="${esc(o.brandHref ?? '/')}"><span class="brand-mark">${icon('route', 18)}</span>${esc(o.brand ?? 'App')}</a>${nav ? `<nav class="tabs" aria-label="Main">${nav}</nav>` : ''}</div></header><main id="main" class="app">${o.wide ? o.body : `<div class="page">${o.body}</div>`}</main></body></html>`;
}

/** A page that lays itself out entirely (a product or landing page): the design system, a skip link, and the body. */
export function bareShell(o: ShellOpts): string {
  return `${head(o)}<body><a class="skip" href="#main">Skip to content</a>${o.surface ? zbar(o.surface) : ''}${o.body}</body></html>`;
}

export function consoleShell(o: ShellOpts & { groups?: { title: string; items: NavItem[] }[] }): string {
  const side = (o.groups ?? [{ title: '', items: o.nav ?? [] }]).map((g) => `${g.title ? `<div class="grp">${esc(g.title)}</div>` : ''}${g.items.map((n) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}>${n.icon ? icon(n.icon, 18) : ''}${esc(n.label)}</a>`).join('')}`).join('');
  return `${head(o)}<body><a class="skip" href="#main">Skip to content</a>${o.surface ? zbar(o.surface) : ''}<div class="console"><nav class="side" aria-label="Console"><a class="brand" href="${esc(o.brandHref ?? '/')}"><span class="brand-mark">${icon('shield', 18)}</span>${esc(o.brand ?? 'Console')}</a>${side}</nav><main id="main" class="con">${o.body}</main></div></body></html>`;
}

// ---------------------------------------------------------------- components

export interface Action {
  label: string;
  /** A link target, or a form post (url plus hidden fields). */
  href?: string;
  post?: { url: string; fields: Record<string, string> };
  variant?: 'primary' | 'quiet' | 'call' | 'danger';
  icon?: string;
  /** A switch: a single control that is on or off, announced as a switch with its state. */
  toggle?: { on: boolean; name: string };
}

export function button(a: Action): string {
  if (a.toggle) {
    const t = a.toggle;
    const sw = `<button class="sw" role="switch" aria-checked="${t.on}" aria-label="${esc(t.name)}"><span class="sw-track" aria-hidden="true"><span class="sw-thumb"></span></span><span class="sw-text" aria-hidden="true">${t.on ? 'On' : 'Off'}</span></button>`;
    return a.post ? `<form class="inline" method="post" action="${esc(a.post.url)}">${Object.entries(a.post.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${sw}</form>` : sw;
  }
  const cls = `btn${a.variant && a.variant !== 'primary' ? ` ${a.variant}` : ''}`;
  const inner = `${a.icon ? icon(a.icon, 18) : ''}<span>${esc(a.label)}</span>`;
  if (a.post) return `<form class="inline" method="post" action="${esc(a.post.url)}">${Object.entries(a.post.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button class="${cls}">${inner}</button></form>`;
  return `<a class="${cls}" href="${esc(a.href ?? '#')}">${inner}</a>`;
}

/** One choice of several, shown as a segmented control: each option a button, the current one pressed. */
export function segmented(label: string, options: { label: string; post: { url: string; fields: Record<string, string> }; current: boolean }[]): string {
  return `<div class="seg" role="group" aria-label="${esc(label)}">${options
    .map((o) => `<form class="inline" method="post" action="${esc(o.post.url)}">${Object.entries(o.post.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button class="seg-b" aria-pressed="${o.current}"${o.current ? ' aria-current="true"' : ''}>${esc(o.label)}</button></form>`)
    .join('')}</div>`;
}

/** A read-only value with a button that copies it; without scripts the field is selectable. */
export function copyField(id: string, label: string, value: string): string {
  return `<div class="copy"><label for="${esc(id)}" class="visually-hidden">${esc(label)}</label><input id="${esc(id)}" readonly value="${esc(value)}"><button type="button" class="btn quiet" data-copy="${esc(id)}">${icon('doc', 18)}<span class="copy-label">Copy link</span></button></div>`;
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
  // The note a tap produced is a status message (WCAG 4.1.3): announced, and the target the address points to.
  const live = n.id === 'latest' ? ' role="status" tabindex="-1"' : '';
  return `<section class="note k-${n.kind ?? 'info'}"${n.id ? ` id="${esc(n.id)}"` : ''}${live}${n.title ? ` aria-label="${esc(n.title)}"` : ''}>${tag ? `<span class="tag">${tag}</span>` : ''}${n.from ? `<div class="from">${n.icon ? `<span class="av">${icon(n.icon, 16)}</span>` : ''}${esc(n.from)}</div>` : ''}${n.title ? `<h2>${esc(n.title)}</h2>` : ''}<div class="body">${esc(n.body)}</div>${n.why ? `<details class="why"><summary>Why am I seeing this?</summary><p>${esc(n.why)}</p></details>` : ''}${actions(n.actions ?? [])}</section>`;
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
  const KEY: [Stop['kind'], string, string][] = [['class', 'Class', 'var(--l-class)'], ['shift', 'Work', 'var(--l-work)'], ['hold', 'Held for you', 'var(--l-hold)'], ['due', 'Due', 'var(--l-due)']];
  const kinds = new Set(stops.map((s) => s.kind));
  const key = KEY.filter(([k]) => kinds.has(k));
  return `<ol class="day" aria-label="${esc(label)}">${stops.map((s) => `<li class="s-${s.kind}"><span class="t">${esc(s.time)}</span><span class="dot"></span><span class="what">${s.kind === 'now' ? esc(s.title) : `<b>${esc(s.title)}</b>${s.sub ? `<span>${esc(s.sub)}</span>` : ''}`}</span></li>`).join('')}</ol>${key.length > 1 ? `<p class="day-key">${key.map(([, name, c]) => `<span><i style="--k:${c}"></i>${name}</span>`).join('')}</p>` : ''}`;
}

/** Small facts at a glance, for the top of a screen. */
export function glance(items: { text: string; tone?: 'warn' | 'alert'; icon?: string }[]): string {
  return items.length ? `<div class="glance" tabindex="0" role="region" aria-label="At a glance">${items.map((g) => `<span${g.tone ? ` class="g-${g.tone}"` : ''}>${g.icon ? icon(g.icon, 16) : ''}${esc(g.text)}</span>`).join('')}</div>` : '';
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
  /** For a choice: 'select' draws a menu, 'checks' a group of checkboxes (value is a comma list of the checked ones). */
  options?: { value: string; label: string }[];
  required?: boolean;
  min?: number;
  max?: number;
  step?: string;
  inputmode?: 'numeric' | 'decimal' | 'text';
  autocomplete?: string;
}

export function form(o: { url: string; fields: Field[]; submit: string; hidden?: Record<string, string> }): string {
  return `<form method="post" action="${esc(o.url)}">${Object.entries(o.hidden ?? {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${o.fields
    .map((f) => {
      const id = `f-${esc(f.name).replace(/[^\w-]/g, "_")}`;
      if (f.type === 'checks' && f.options) {
        const on = new Set((f.value ?? '').split(','));
        return `<fieldset class="checks"><legend>${esc(f.label)}</legend>${f.options.map((o, i) => `<label class="check" for="${id}-${i}"><input type="checkbox" name="${esc(f.name)}" value="${esc(o.value)}" id="${id}-${i}"${on.has(o.value) ? ' checked' : ''}> ${esc(o.label)}</label>`).join('')}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</fieldset>`;
      }
      if (f.type === 'select' && f.options) {
        return `<label for="${id}">${esc(f.label)}</label><select id="${id}" name="${esc(f.name)}"${f.required ? ' required' : ''}>${f.options.map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${f.hint ? `<div class="hint" id="${id}-hint">${esc(f.hint)}</div>` : ''}`;
      }
      const extra = `${f.required ? ' required' : ''}${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}${f.step ? ` step="${esc(f.step)}"` : ''}${f.inputmode ? ` inputmode="${f.inputmode}"` : f.type === 'number' ? ' inputmode="decimal"' : ''}${f.autocomplete ? ` autocomplete="${esc(f.autocomplete)}"` : ''}${f.hint ? ` aria-describedby="${id}-hint"` : ''}`;
      const ctl = f.multiline ? `<textarea id="${id}" name="${esc(f.name)}" rows="${f.multiline}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${extra}>${esc(f.value ?? '')}</textarea>` : `<input id="${id}" name="${esc(f.name)}" type="${esc(f.type ?? 'text')}" value="${esc(f.value ?? '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${extra}>`;
      return `<div class="field"><label for="${id}">${esc(f.label)}${f.required ? '' : ''}</label>${ctl}${f.hint ? `<div class="hint" id="${id}-hint">${esc(f.hint)}</div>` : ''}</div>`;
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
    .map((d) => `<section class="d" aria-label="${esc(d.label)}"><h2 class="dh">${esc(d.label)}</h2>${d.blocks.map((b) => `<div class="b ${esc(b.kind)}"><b>${esc(b.time)}</b> ${esc(b.title)}</div>`).join('')}${d.problem ? `<div class="prob">${esc(d.problem)}</div>` : ''}${d.blocks.length || d.problem ? '' : '<div class="small muted">Open</div>'}</section>`)
    .join('')}</div>`;
}

export function table(headers: string[], body: (string | number)[][], opts: { raw?: boolean[]; caption?: string } = {}): string {
  // A table may scroll sideways; its panel is a named region a keyboard can reach and scroll.
  return `<div class="panel" style="overflow:auto" tabindex="0" role="region" aria-label="${esc(opts.caption ?? headers.filter(Boolean).join(', ') ?? 'Table')}"><table class="t">${opts.caption ? `<caption class="small muted" style="text-align:left;padding:8px 0">${esc(opts.caption)}</caption>` : ''}<thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c, i) => `<td>${opts.raw?.[i] ? String(c) : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export interface Reading {
  label: string;
  value: number | undefined;
  /** The full scale; with it a gauge is drawn. */
  of?: number;
  /** What the value must reach; with it the reading passes or fails. */
  floor?: number;
  /** What the value must stay at or under (a limit rather than a target). */
  ceiling?: number;
  unit?: string;
  note?: string;
  href?: string;
  /** Decimal places to show (a GPA reads 3.00, not 3). */
  places?: number;
  /** Words for the states, when Held and Below floor are not the reader's words. */
  words?: { pass: string; fail: string };
}

/** Measurements against their tolerances. A reading with no value says "not measured"; it never counts as a pass. */
export function readings(items: Reading[]): string {
  const fmt = (x: number) => x.toLocaleString('en-US');
  return `<div class="readings">${items
    .map((r) => {
      const measured = r.value !== undefined;
      const w = r.words ?? { pass: 'Held', fail: r.ceiling !== undefined ? 'Over the limit' : 'Below floor' };
      const state = !measured ? ['unk', 'Not measured'] : r.ceiling !== undefined ? (r.value! <= r.ceiling ? ['pass', w.pass] : ['fail', w.fail]) : r.floor === undefined ? ['count', 'Recorded'] : r.value! >= r.floor ? ['pass', w.pass] : ['fail', w.fail];
      const mark = r.floor ?? r.ceiling;
      const scale = r.of ?? 0;
      const gauge = measured && scale ? `<div class="gauge" role="img" aria-label="${esc(`${fmt(r.value!)} of ${fmt(scale)}${r.floor !== undefined ? `, must reach ${fmt(r.floor)}` : r.ceiling !== undefined ? `, must stay at or under ${fmt(r.ceiling)}` : ''}`)}"><i style="width:${Math.max(0, Math.min(100, (r.value! / scale) * 100)).toFixed(1)}%"></i>${mark !== undefined && mark < scale ? `<b style="left:${((mark / scale) * 100).toFixed(1)}%"></b>` : ''}</div>` : `<div class="gauge none" aria-hidden="true"></div>`;
      const v = !measured ? '<span>not measured</span>' : r.unit === '%' ? `${Number(r.value!.toFixed(1))}<span>%</span>` : `${r.places !== undefined ? r.value!.toFixed(r.places) : fmt(r.value!)}${r.of !== undefined && r.unit !== '%' ? `<span> / ${fmt(r.of)}</span>` : ''}`;
      const inner = `<span class="l">${esc(r.label)}${r.note ? `<small>${esc(r.note)}</small>` : ''}</span><span class="v">${v}</span>${gauge}<span class="state ${state[0]}">${state[1]}</span>`;
      return r.href ? `<a class="reading ${state[0]}" href="${esc(r.href)}">${inner}</a>` : `<div class="reading ${state[0]}">${inner}</div>`;
    })
    .join('')}</div>`;
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
