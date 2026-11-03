import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import * as ui from '@zthr/ui';
import type { Advocate, Delivered } from '../agents/advocate.js';
import type { View } from '../agents/actions.js';
import { friendly, relDay, shortDate, time12, weekday } from '../domain/dates.js';
import type { NeedCategory, OutboundMessage } from '../domain/types.js';
import { parseShifts } from '../domain/shifts.js';
import { PERSONA_NAMES } from './demo.js';
import { createApi } from './api.js';
import { createAdmin } from './admin.js';
import type { GoogleVerifier, Sessions } from './auth.js';
import { fileURLToPath } from 'node:url';

/**
 * The web app and the text-message webhook. Both are thin: every behavior lives in the Advocate and its action
 * registry, so the app and the text channel stay at parity (PRD P8, ADR 0002). Pages are server-rendered from
 * the @zthr/ui blocks and work without JavaScript.
 */
export interface AppOptions {
  /** Where the app is mounted, for example "/advocate". Empty for the root. */
  base?: string;
  /** Demonstration students shown on the start page. */
  demo?: { id: string; name: string; line: string }[];
  /** Sign in with Google. When set, every student page needs the owner's session and the admin needs a listed email. */
  auth?: { clientId: string; verifier: GoogleVerifier; sessions: Sessions; adminEmailHashes: string[]; secure?: boolean };
}

const NEEDS: [NeedCategory, string, string][] = [
  ['food', 'Food', 'food'],
  ['housing', 'Rent or a place to stay', 'home'],
  ['utilities', 'Power, gas or water', 'bolt'],
  ['money', 'Money for an emergency', 'dollar'],
  ['transportation', 'Getting around', 'bus'],
  ['phone-internet', 'Phone or internet', 'phone'],
  ['childcare', 'Child care', 'child'],
  ['legal', 'Legal help', 'shield'],
  ['mental-health', 'Someone to talk to', 'talk'],
];
const SITUATIONS: [string, string][] = [
  ['eviction', 'I got an eviction notice'],
  ['utility-shutoff', 'My power is getting shut off'],
  ['car', 'My car died'],
  ['no-food', "I'm out of food"],
  ['rent-short', "I can't make rent"],
];

const FROM: Record<string, string> = {
  'chief-of-staff': 'Your Advocate',
  navigator: 'Help finder',
  'coursework-planner': 'Class planner',
  'household-planner': 'Week planner',
  'safety-router': 'Your Advocate',
  'money-coach': 'Money coach',
  'money-and-life-coach': 'Money coach',
};

const fromLabel = (author: string) => FROM[author] ?? (author.startsWith('playbook:') ? 'Checklist' : 'Your Advocate');

export function createApp(a: Advocate, opts: AppOptions = {}): Hono {
  const base = opts.base ?? '';
  const app = new Hono({ strict: false });
  const u = (sid: string, path = '') => `${base}/s/${encodeURIComponent(sid)}${path}`;
  const VIEW_PATH: Record<View, string> = { today: '', money: '/money', help: '/help', settings: '/you', week: '/week', syllabus: '/syllabus', shifts: '/shifts', dates: '/dates', drafts: '/drafts', resource: '/resource', ask: '/ask', deleted: '', share: '/share', letter: '/letter', meals: '/meals' };

  const toAction = (sid: string, n: { label: string; action: string }, i: number): ui.Action =>
    n.action.startsWith('call:')
      ? { label: n.label, href: `tel:${n.action.slice(5)}`, variant: 'call', icon: 'phone' }
      : { label: n.label, post: { url: u(sid, '/action'), fields: { action: n.action } }, variant: i === 0 ? 'primary' : 'quiet' };

  const noteFor = (sid: string, m: OutboundMessage | Delivered, extra: Partial<ui.NoteOpts> = {}) =>
    ui.note({
      kind: m.urgency === 'safety' ? 'safety' : m.urgency === 'time-sensitive' ? 'heads' : m.author === 'coursework-planner' ? 'plan' : 'info',
      from: fromLabel(m.author),
      body: m.text,
      why: m.why,
      actions: m.nextSteps.map((n, i) => toAction(sid, n, i)),
      ...extra,
    });

  const nav = (sid: string, current: string): ui.NavItem[] => [
    { href: u(sid), label: 'Today', icon: 'today', current: current === 'today' },
    { href: u(sid, '/money'), label: 'Money', icon: 'money', current: current === 'money' },
    { href: u(sid, '/help'), label: 'Help', icon: 'help', current: current === 'help' },
    { href: u(sid, '/you'), label: 'You', icon: 'you', current: current === 'you' },
  ];

  const page = (sid: string | undefined, title: string, body: string, current = '') =>
    ui.appShell({ title: `${title} · Student Advocate`, body, base, brand: 'Student Advocate', brandHref: sid ? u(sid) : `${base}/`, nav: sid ? nav(sid, current) : [{ href: `${base}/`, label: 'Start', icon: 'today' }, { href: `${base}/text`, label: 'Try by text', icon: 'send' }] });

  /** A message produced by the last tap, shown at the top of the screen it led to. */
  const flash = (sid: string, id: string | undefined) => {
    if (!id) return '';
    const m = a.messages(sid).find((x) => x.id === id);
    return m ? noteFor(sid, m, { id: 'latest' }) : '';
  };

  const exists = (sid: string) => {
    try {
      a.student(sid);
      return true;
    } catch {
      return false;
    }
  };

  app.get('/_ui/:file', (c) => {
    const f = ui.uiAsset(c.req.param('file'));
    return f ? c.body(f.body as unknown as ArrayBuffer, 200, { 'content-type': f.type, 'cache-control': 'public, max-age=31536000, immutable' }) : c.notFound();
  });

  // ------------------------------------------------------------ sign-in (production)

  const auth = opts.auth;
  if (auth) {
    const who = (c: Parameters<Parameters<typeof app.use>[1]>[0]) => auth.sessions.read(getCookie(c, 'adv_session'));
    app.use('/s/:id/*', async (c, next) => {
      const me = who(c);
      const s = exists(c.req.param('id')) ? a.student(c.req.param('id')) : undefined;
      return me && s && s.account === me.subjectKey ? next() : c.redirect(`${base}/signin`);
    });
    app.use('/s/:id', async (c, next) => {
      const me = who(c);
      const s = exists(c.req.param('id')) ? a.student(c.req.param('id')) : undefined;
      return me && s && s.account === me.subjectKey ? next() : c.redirect(`${base}/signin`);
    });
    if (auth.adminEmailHashes.length) app.use('/admin/*', async (c, next) => (auth.adminEmailHashes.includes(who(c)?.emailHash ?? '') ? next() : c.redirect(`${base}/signin`)));
    app.get('/signin', (c) => {
      const csrf = randomBytes(16).toString('hex');
      setCookie(c, 'g_csrf_token', csrf, { path: base || '/', sameSite: 'Lax', secure: auth.secure, maxAge: 600 });
      return c.html(page(undefined, 'Sign in', `<div class="hello"><h1>Sign in</h1><p class="date">Use your Google account. Your Advocate belongs to you; no one at a college can see it.</p></div><script src="https://accounts.google.com/gsi/client" async></script><div id="g_id_onload" data-client_id="${ui.esc(auth.clientId)}" data-login_uri="${ui.esc(`${base}/auth/google`)}" data-ux_mode="redirect"></div><div class="g_id_signin" data-type="standard" data-shape="pill" data-text="signin_with"></div>`));
    });
    app.post('/auth/google', async (c) => {
      const f = await c.req.parseBody();
      const csrf = getCookie(c, 'g_csrf_token');
      if (!csrf || csrf !== String(f.g_csrf_token ?? '')) return c.html(page(undefined, 'Sign in', ui.note({ title: 'That sign-in did not go through', body: 'Please try again from the sign-in page.', actions: [{ label: 'Sign in', href: `${base}/signin` }] })), 400);
      const v = await auth.verifier.verify(String(f.credential ?? ''));
      if (!v.ok) return c.html(page(undefined, 'Sign in', ui.note({ title: 'That sign-in did not go through', body: 'Google could not confirm it. Please try again.', why: v.reason, actions: [{ label: 'Sign in', href: `${base}/signin` }] })), 401);
      const key = auth.sessions.subjectKey(v.claims.sub);
      const s = a.findByAccount(key) ?? a.createStudent({ chosenName: (v.claims.name ?? 'there').split(' ')[0]!, zip: '00000', account: key });
      setCookie(c, 'adv_session', auth.sessions.issue(key, v.claims.email), { path: base || '/', httpOnly: true, sameSite: 'Lax', secure: auth.secure, maxAge: 12 * 3600 });
      if (auth.adminEmailHashes.includes(auth.sessions.emailHash(v.claims.email)) && c.req.query('to') === 'admin') return c.redirect(`${base}/admin/`);
      return c.redirect(u(s.id));
    });
    app.post('/signout', (c) => {
      setCookie(c, 'adv_session', '', { path: base || '/', maxAge: 0 });
      return c.redirect(`${base}/`);
    });
  }

  app.use('/s/:id/*', async (c, next) => (exists(c.req.param('id')) ? next() : c.html(page(undefined, 'Not found', ui.note({ title: 'That student is not here', body: 'The link may be old, or the account was deleted.', actions: [{ label: 'Go to the start', href: `${base}/` }] })), 404)));
  app.use('/s/:id', async (c, next) => (exists(c.req.param('id')) ? next() : c.html(page(undefined, 'Not found', ui.note({ title: 'That student is not here', body: 'The link may be old, or the account was deleted.', actions: [{ label: 'Go to the start', href: `${base}/` }] })), 404)));

  // ------------------------------------------------------------ start

  app.get('/', (c) => {
    const demo = opts.demo ?? [];
    return c.html(
      page(
        undefined,
        'Start',
        `<div class="hello"><h1>A team that works for you</h1><p class="date">Student Advocate runs your day, finds money and help you qualify for, and does the legwork to get it. It belongs to you, and it never shares anything unless you say so.</p></div>
${demo.length ? ui.section('Meet the students', ui.rows(demo.map((d) => ({ title: d.name, sub: d.line, href: u(d.id) })))) : ''}
${ui.section('Or start by text', ui.note({ body: 'Text the Advocate the way you would text a friend. Try it here without a phone.', actions: [{ label: 'Try it by text', href: `${base}/text`, icon: 'send' }] }))}`,
      ),
    );
  });

  // ------------------------------------------------------------ text, in the browser and from the carrier

  const textPage = (phone: string, thread: { who: 'you' | 'advocate'; text: string }[]) =>
    page(
      undefined,
      'Try it by text',
      `<div class="hello"><h1>Text the Advocate</h1><p class="date">This is exactly what a student sees on their phone.</p></div>
<div class="panel"><ul class="rows">${thread.map((t) => `<li><div class="grow"><b>${t.who === 'you' ? 'You' : 'Advocate'}</b><span style="white-space:pre-line;color:var(--ink)">${ui.esc(t.text)}</span></div></li>`).join('') || '<li><div class="grow"><span>Say anything, like "I need help with my electric bill".</span></div></li>'}</ul></div>
${ui.form({ url: `${base}/text`, submit: 'Send', hidden: { phone }, fields: [{ name: 'body', label: 'Message', placeholder: 'I need help with my electric bill' }] })}
${a.findByPhone(phone) ? ui.actions([{ label: 'Open this account in the app', href: u(a.findByPhone(phone)!.id), variant: 'quiet' }]) : ''}`,
    );

  const threads = new Map<string, { who: 'you' | 'advocate'; text: string }[]>();
  app.get('/text', (c) => {
    let phone = getCookie(c, 'demo_phone');
    if (!phone) {
      phone = `+1937555${String(Math.floor(1000 + Math.random() * 8999))}`;
      setCookie(c, 'demo_phone', phone, { path: base || '/', httpOnly: true, sameSite: 'Lax', maxAge: 86400 });
    }
    return c.html(textPage(phone, threads.get(phone) ?? []));
  });
  app.post('/text', async (c) => {
    const f = await c.req.parseBody();
    const phone = String(f.phone ?? getCookie(c, 'demo_phone') ?? '+19375550123');
    const body = String(f.body ?? '');
    const replies = a.textIn(phone, body);
    const t = threads.get(phone) ?? [];
    t.push({ who: 'you', text: body }, ...replies.map((r) => ({ who: 'advocate' as const, text: r })));
    threads.set(phone, t.slice(-40));
    return c.html(textPage(phone, t));
  });

  // Carrier webhook (form-encoded From and Body), answered in the provider's XML reply format.
  app.post('/sms/inbound', async (c) => {
    const f = await c.req.parseBody();
    const replies = a.textIn(String(f.From ?? ''), String(f.Body ?? ''));
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${replies.map((r) => `<Message>${ui.esc(r)}</Message>`).join('')}</Response>`;
    return c.body(xml, 200, { 'content-type': 'text/xml' });
  });

  // ------------------------------------------------------------ today

  app.get('/s/:id', async (c) => {
    const sid = c.req.param('id');
    const s = a.student(sid);
    const weather = await a.weatherMessage(sid);
    const commute = a.commuteSettings(sid).mode === 'bus' && a.commutePlans(sid).some((p) => p.date === a.today_(sid).date) ? a.leaveByMessage(sid) : undefined;
    const v = a.today_(sid);
    const date = v.date;
    const stops: ui.Stop[] = [
      ...v.classes.map((k) => ({ time: time12(k.start).replace(':00', ''), title: k.course, sub: [k.building, k.room ? `room ${k.room}` : ''].filter(Boolean).join(', '), kind: 'class' as const, at: k.start })),
      ...v.shifts.map((x) => ({ time: time12(x.start).replace(':00', ''), title: 'Work', sub: `${x.employer ?? ''}${x.employer ? ', ' : ''}until ${time12(x.end)}`, kind: 'shift' as const, at: x.start })),
      ...a.holds(sid).filter((h) => h.date === date).map((h) => ({ time: time12(h.start).replace(':00', ''), title: h.title, sub: `Held until ${time12(h.end)}`, kind: 'hold' as const, at: h.start })),
      ...a.deadlines(sid).filter((d) => !d.done && d.confirmed && d.due.slice(0, 10) === date).map((d) => ({ time: d.due.length > 10 ? time12(d.due.slice(11, 16)).replace(':00', '') : 'Today', title: `${d.title} due`, sub: d.course, kind: 'due' as const, at: d.due.length > 10 ? d.due.slice(11, 16) : '23:59' })),
    ].sort((x, y) => x.at.localeCompare(y.at));
    const money = a.moneyCheck(sid);
    const pulse = a.pulse(sid);
    const ahead = a.lookAhead(sid);
    const conflicts = a.conflictMessages(sid);
    const today = a.todayMessage(sid);
    const greeting = `Good ${new Date().getUTCHours() - 5 < 12 ? 'morning' : 'afternoon'}, ${s.chosenName}`;
    const one = v.oneThing;
    const comingUp = v.dueSoon.filter((d) => d.due.slice(0, 10) !== date);
    const unconfirmed = a.deadlines(sid).filter((d) => !d.confirmed && !d.done).length;
    return c.html(
      page(
        sid,
        `Today, ${s.chosenName}`,
        `${flash(sid, c.req.query('m'))}
<div class="hello"><h1>${ui.esc(greeting)}</h1><p class="date">${ui.esc(friendly(date))}</p></div>
${stops.length ? ui.dayLine(stops, `Your ${weekday(date)}`) : ui.note({ body: 'Nothing on your calendar today. Add your classes or shifts and I will plan around them.', actions: [toAction(sid, { label: 'Add a syllabus', action: 'upload-syllabus' }, 0), toAction(sid, { label: 'Add my work shifts', action: 'add-shifts' }, 1)] })}
${one ? ui.note({ kind: 'one', title: 'If you do one thing today', body: `${one.title}. ${one.why}.`, actions: today.nextSteps.map((n, i) => toAction(sid, n, i)) }) : ''}
${[commute, weather, money, pulse, ...conflicts, ...ahead].filter((m): m is OutboundMessage => !!m).map((m) => noteFor(sid, m)).join('')}
${unconfirmed ? ui.note({ kind: 'plan', from: 'Class planner', body: `${unconfirmed} date${unconfirmed === 1 ? '' : 's'} from your syllabus need a quick look before I plan around them.`, actions: [toAction(sid, { label: 'Check the dates', action: 'review-deadlines' }, 0)] }) : ''}
${ui.section('Coming up', ui.rows(comingUp.map((d) => ({ title: d.title, sub: `${d.course ? `${d.course}, ` : ''}${relDay(date, d.due)}`, actions: [toAction(sid, { label: 'Done', action: `mark-done:${d.id}` }, 1)] })), 'Nothing due in the next week.'), `<a href="${u(sid, '/week')}">See the week</a>`)}
${ui.section('Ask your Advocate', ui.form({ url: u(sid, '/say'), submit: 'Send', fields: [{ name: 'text', label: 'Message', placeholder: 'Try: plan my essay, I need food, what is a registrar' }] }))}`,
        'today',
      ),
    );
  });

  app.post('/s/:id/say', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const text = String(f.text ?? '').trim();
    const out = text ? a.converse(sid, text) : [];
    return c.html(page(sid, 'Your Advocate', `<div class="hello"><h1>Your Advocate</h1>${text ? `<p class="date">You asked: ${ui.esc(text)}</p>` : ''}</div>${out.map((m) => noteFor(sid, m)).join('')}${ui.form({ url: u(sid, '/say'), submit: 'Send', fields: [{ name: 'text', label: 'Ask something else' }] })}`, 'today'));
  });

  app.get('/s/:id/ask', (c) => {
    const sid = c.req.param('id');
    const recent = a.messages(sid).filter((m) => m.status === 'delivered').slice(-8).reverse();
    return c.html(page(sid, 'Ask', `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Ask your Advocate</h1><p class="date">School, money or life. Your own words are fine.</p></div>${ui.form({ url: u(sid, '/say'), submit: 'Send', fields: [{ name: 'text', label: 'Message' }] })}${recent.length ? ui.section('Recent', recent.map((m) => noteFor(sid, m)).join('')) : ''}`, 'today'));
  });

  // ------------------------------------------------------------ week, dates, shifts, syllabus

  app.get('/s/:id/week', (c) => {
    const sid = c.req.param('id');
    const w = a.week(sid);
    const date = a.today_(sid).date;
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(`${date}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const grid: ui.WeekDay[] = days.map((d) => ({
      label: `${relDay(date, d)[0]!.toUpperCase()}${relDay(date, d).slice(1)}${relDay(date, d).includes(',') ? '' : `, ${shortDate(d).split(', ')[1] ?? ''}`}`,
      blocks: [
        ...w.blocks.filter((b) => b.date === d && b.kind !== 'sleep').map((b) => ({ time: time12(b.start).replace(':00', ''), title: b.label, kind: b.kind, at: b.start })),
        ...a.holds(sid).filter((h) => h.date === d).map((h) => ({ time: time12(h.start).replace(':00', ''), title: h.title, kind: 'hold', at: h.start })),
        ...a.deadlines(sid).filter((x) => !x.done && x.confirmed && x.due.slice(0, 10) === d).map((x) => ({ time: 'Due', title: x.title, kind: 'due', at: '23:58' })),
      ].sort((x, y) => x.at.localeCompare(y.at)),
      problem: w.problems.filter((p) => p.date === d).map((p) => p.text).join(' ') || undefined,
    }));
    return c.html(page(sid, 'Your week', `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Your week</h1><p class="date">${ui.esc(`${w.studyHours} hours open for study${w.problems.length ? `, and ${w.problems.length} thing${w.problems.length === 1 ? '' : 's'} to fix` : ''}.`)}</p></div>${w.problems.length ? noteFor(sid, w.message) : ''}${ui.weekGrid(grid)}${ui.actions([toAction(sid, { label: 'Add my work shifts', action: 'add-shifts' }, 1), toAction(sid, { label: 'Plan what is due next', action: 'plan-next' }, 1)])}`, 'today'));
  });

  app.get('/s/:id/dates', (c) => {
    const sid = c.req.param('id');
    const all = a.deadlines(sid).filter((d) => !d.done);
    const row = (d: (typeof all)[number]) => ({
      title: d.title,
      sub: `${d.course ? `${d.course}, ` : ''}${shortDate(d.due)}${d.source.line ? `. From: "${d.source.line}"` : ''}`,
      chip: d.confirmed ? { text: 'On your calendar', tone: 'ok' as const } : { text: 'Check this', tone: 'warn' as const },
      actions: d.confirmed ? [toAction(sid, { label: 'Remove', action: `remove-deadline:${d.id}` }, 1)] : [toAction(sid, { label: 'Looks right', action: `confirm-deadline:${d.id}` }, 0), toAction(sid, { label: 'Remove', action: `remove-deadline:${d.id}` }, 1)],
    });
    return c.html(page(sid, 'Your dates', `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Your dates</h1><p class="date">Everything I found, and where I found it.</p></div>${ui.rows(all.map(row), 'No dates yet. Add a syllabus and I will find them.')}${ui.actions([toAction(sid, { label: 'Add a syllabus', action: 'upload-syllabus' }, 1)])}`, 'today'));
  });

  app.get('/s/:id/syllabus', (c) => {
    const sid = c.req.param('id');
    return c.html(page(sid, 'Add a syllabus', `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Add a syllabus</h1><p class="date">Paste the schedule part. I find every date and ask you to check them.</p></div>${ui.form({ url: u(sid, '/syllabus'), submit: 'Find the dates', fields: [{ name: 'course', label: 'Course', placeholder: 'ENG 1101' }, { name: 'text', label: 'Schedule', multiline: 8, placeholder: 'Sep 3 Reading: Chapter 1\nOct 14 Essay 1 due' }] })}`, 'today'));
  });

  app.post('/s/:id/syllabus', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const r = a.uploadSyllabus(sid, String(f.course || 'Course').slice(0, 20), String(f.text ?? '').slice(0, 20000), `${a.today_(sid).date.slice(0, 4)}-08-24`);
    const d = a.deliver(r.message, { force: true });
    return c.redirect(`${u(sid, '/dates')}?m=${d.id}`);
  });

  app.get('/s/:id/shifts', (c) => {
    const sid = c.req.param('id');
    const date = a.today_(sid).date;
    const upcoming = a.shifts(sid).filter((x) => x.date >= date);
    return c.html(page(sid, 'Work shifts', `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Work shifts</h1><p class="date">I plan study time and reminders around these.</p></div>${ui.rows(upcoming.map((x) => ({ title: `${relDay(date, x.date)[0]!.toUpperCase()}${relDay(date, x.date).slice(1)}`, sub: `${time12(x.start)} to ${time12(x.end)}${x.employer ? `, ${x.employer}` : ''}` })), 'No shifts yet.')}${ui.form({ url: u(sid, '/shifts'), submit: 'Add shifts', fields: [{ name: 'text', label: 'Your shifts', placeholder: 'Tue 3pm-9pm, Thu 4-10pm', hint: 'A day and times, separated by commas.' }] })}`, 'today'));
  });

  app.post('/s/:id/shifts', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const parsed = parseShifts(String(f.text ?? '').slice(0, 2000), a.today_(sid).date);
    const m = parsed.shifts.length ? a.addShiftsMessage(sid, parsed.shifts, parsed.unread) : { studentId: sid, author: 'chief-of-staff', urgency: 'routine' as const, text: 'I could not read those. Try a day and times, like Tue 3pm-9pm.', nextSteps: [{ label: 'Show my day', action: 'today' }] };
    const d = a.deliver(m, { force: true });
    return c.redirect(`${u(sid, '/shifts')}?m=${d.id}`);
  });

  // ------------------------------------------------------------ money

  app.get('/s/:id/money', (c) => {
    const sid = c.req.param('id');
    const results = a.screen(sid);
    const likely = results.filter((r) => r.status === 'likely');
    const monthly = likely.reduce((n, r) => n + (r.estimatedMonthlyValue ?? 0), 0);
    const tone = (st: string) => (st === 'likely' ? 'ok' : st === 'unlikely' ? undefined : 'warn') as 'ok' | 'warn' | undefined;
    const programRows = results.map((r) => ({
      title: r.title,
      sub: [...r.reasons, ...r.needs.map((n) => `Need: ${n}`)].join(' '),
      chip: { text: r.status === 'likely' ? (r.estimatedMonthlyValue ? `About $${r.estimatedMonthlyValue.toFixed(r.estimatedMonthlyValue % 1 ? 2 : 0)}/mo` : 'Likely') : r.status === 'unlikely' ? 'Not likely' : 'Need more info', tone: tone(r.status) },
      actions: r.status === 'likely' ? [toAction(sid, { label: 'Start', action: `start-program:${r.program}` }, 0)] : [],
    }));
    const s = a.student(sid);
    return c.html(
      page(
        sid,
        'Money',
        `${flash(sid, c.req.query('m'))}
<div class="hello"><h1>Money you may be missing</h1><p class="date">I checked ${results.length} programs against what you told me. The agencies make the final call.</p></div>
${likely.length ? `<div class="panel" style="padding:18px">${ui.figure(monthly ? `$${Math.round(monthly)}` : `${likely.length}`, monthly ? 'a month you may qualify for' : `program${likely.length === 1 ? '' : 's'} you likely qualify for`)}</div>` : ''}
${a.moneyCheck(sid) ? noteFor(sid, a.moneyCheck(sid)!) : ''}
${ui.section('What I checked', ui.rows(programRows))}
<p class="small muted">Some programs have citizenship or immigration rules. I never ask about that. The agency explains its rules, and you decide whether to apply.</p>
${ui.section('Update what I know', ui.form({ url: u(sid, '/household'), submit: 'Check again', fields: [{ name: 'size', label: 'People in your household, counting you', value: String(s.household.size), type: 'number' }, { name: 'income', label: 'Household income a month, before taxes', value: s.household.monthlyGrossIncome !== undefined ? String(s.household.monthlyGrossIncome) : '', type: 'number' }, { name: 'work', label: 'Hours you work a week', value: s.enrollment.weeklyWorkHours !== undefined ? String(s.enrollment.weeklyWorkHours) : '', type: 'number' }] }))}`,
        'money',
      ),
    );
  });

  app.post('/s/:id/household', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const s = a.student(sid);
    const num = (v: unknown) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Math.max(0, Number(v)));
    a.updateStudent(sid, { household: { ...s.household, size: Math.max(1, Math.min(20, num(f.size) ?? s.household.size)), monthlyGrossIncome: num(f.income) ?? s.household.monthlyGrossIncome }, enrollment: { ...s.enrollment, weeklyWorkHours: num(f.work) ?? s.enrollment.weeklyWorkHours } });
    const d = a.deliver(a.moneyFoundMessage(sid), { force: true });
    return c.redirect(`${u(sid, '/money')}?m=${d.id}`);
  });

  // ------------------------------------------------------------ help

  app.get('/s/:id/help', (c) => {
    const sid = c.req.param('id');
    const post = (action: string) => ({ url: u(sid, '/action'), fields: { action } });
    return c.html(
      page(
        sid,
        'Help',
        `${flash(sid, c.req.query('m'))}
<div class="hello"><h1>What's hard right now?</h1><p class="date">Pick one. I find help that fits you and do the legwork.</p></div>
${ui.tiles(NEEDS.map(([n, label, ic]) => ({ label, icon: ic, post: post(`need:${n}`) })), 'Kinds of help')}
${ui.section('Something went wrong?', ui.tiles([...SITUATIONS.map(([x, label]) => ({ label, icon: 'alert', post: post(`situation:${x}`) })), { label: 'Explain a letter I got', icon: 'doc', href: u(sid, '/letter') }, { label: 'Plan a week of meals', icon: 'food', href: u(sid, '/meals') }, { label: 'Find a job or career help', icon: 'route', post: post('career') }], 'Situations'))}
${ui.section('On campus', ui.tiles([{ label: 'Food on campus now', icon: 'food', post: post('campus-food') }, { label: 'Free food this week', icon: 'food', post: post('free-food') }, { label: 'Study spots', icon: 'book', post: post('study-spots') }, { label: 'Bus to class', icon: 'bus', post: post('leave-by') }, { label: 'Jobs that fit my week', icon: 'route', post: post('jobs-fit') }, { label: 'Talk to a mentor', icon: 'talk', post: post('mentors') }], 'On campus'))}
${ui.note({ kind: 'safety', title: 'Need to talk to someone now?', body: 'Call or text 988 any time, day or night. If you are in danger, call 911.', actions: [{ label: 'Call or text 988', href: 'tel:988', variant: 'call', icon: 'phone' }] })}`,
        'help',
      ),
    );
  });

  app.get('/s/:id/resource/:rid', (c) => {
    const sid = c.req.param('id');
    const r = a.catalog.find((x) => x.id === c.req.param('rid'));
    if (!r) return c.redirect(u(sid, '/help'));
    const opt = a.findHelp(sid, r.categories[0]!).options.find((o) => o.resource.id === r.id);
    const steps = `<ol>${r.howToApply.map((x) => `<li>${ui.esc(x)}</li>`).join('')}</ol>`;
    return c.html(
      page(
        sid,
        r.name,
        `${flash(sid, c.req.query('m'))}<div class="hello"><h1>${ui.esc(r.name)}</h1><p class="date">${ui.esc(r.description)}</p></div>
<div class="panel" style="padding:16px 18px">${r.hours ? `<p><b>Hours:</b> ${ui.esc(r.hours)}</p>` : '<p class="muted">Hours are not published. Call ahead.</p>'}${r.location ? `<p><b>Where:</b> ${ui.esc(r.location.address)}, ${ui.esc(r.location.city)}</p>` : ''}${r.phone ? `<p><b>Call:</b> <a href="tel:${ui.esc(r.phone)}">${ui.esc(r.phone)}</a></p>` : ''}<h2 style="margin-top:14px">Steps</h2>${steps}
${opt?.missingDocuments.length ? `<h3>Still needed</h3><ul>${opt.missingDocuments.map((d) => `<li>${ui.esc(d)}</li>`).join('')}</ul>` : ''}
${opt && Object.keys(opt.prefilled).length ? `<h3>I can fill in</h3><ul>${Object.entries(opt.prefilled).map(([k, v]) => `<li>${ui.esc(k)}: ${ui.esc(v)}</li>`).join('')}</ul>` : ''}
<p class="small muted">Checked ${ui.esc(r.verifiedOn)} against <a href="${ui.esc(r.source.url)}">the source</a>.</p></div>
${ui.actions([...(r.url ? [{ label: 'Open the application', href: r.url }] : []), ...(r.phone ? [{ label: `Call ${r.name}`, href: `tel:${r.phone}`, variant: 'call' as const, icon: 'phone' }] : []), toAction(sid, { label: 'Share with a friend', action: `share:${r.id}` }, 1)])}`,
        'help',
      ),
    );
  });

  app.get('/s/:id/resource', (c) => c.redirect(u(c.req.param('id'), '/help')));

  app.get('/s/:id/meals', (c) => {
    const sid = c.req.param('id');
    const p = a.mealPlan(sid);
    return c.html(
      page(
        sid,
        'Meals for the week',
        `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Meals for the week</h1><p class="date">${ui.esc(`Simple meals for ${p.people === 1 ? 'one person' : `${p.people} people`}${p.weeklyBudget ? `, for about $${p.weeklyBudget} a week from your SNAP estimate` : ''}. SNAP covers all of it.`)}</p></div>
${ui.table(['Day', 'Breakfast', 'Lunch', 'Dinner'], p.meals.map((m) => [m.day, m.breakfast, m.lunch, m.dinner]))}
${ui.section('Shopping list', ui.rows(p.shopping.map((x) => ({ title: x.item, sub: x.amount }))))}
${ui.section('Ways to stretch it', ui.rows(p.tips.map((t) => ({ title: t }))))}
${ui.actions([{ label: 'Buy with SNAP online', href: 'https://www.fns.usda.gov/snap/online-purchasing', variant: 'quiet' }, toAction(sid, { label: 'Find free food near me', action: 'need:food' }, 0)])}`,
        'help',
      ),
    );
  });

  app.get('/s/:id/letter', (c) => {
    const sid = c.req.param('id');
    return c.html(page(sid, 'Explain a letter', `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Explain a letter</h1><p class="date">Paste a letter or notice. I say who it is from, what it means, what to do and by when. Nothing is sent anywhere.</p></div>${ui.form({ url: u(sid, '/letter'), submit: 'Explain it', fields: [{ name: 'text', label: 'The letter', multiline: 10, placeholder: 'Dear resident, ...' }] })}`, 'help'));
  });

  app.post('/s/:id/letter', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const text = String(f.text ?? '').slice(0, 20000);
    const m = text.trim() ? (a.model ? (await a.letterMessageWithModel(sid, text)).message : a.letterMessage(sid, text)) : { studentId: sid, author: 'navigator', urgency: 'routine' as const, text: 'Paste the letter and I will explain it.', nextSteps: [{ label: 'Show my day', action: 'today' }] };
    const d = a.deliver(m, { force: true });
    return c.redirect(`${u(sid, '/letter')}?m=${d.id}`);
  });

  app.get('/s/:id/share', (c) => {
    const sid = c.req.param('id');
    const sh = a.shareText(sid, c.req.query('r') || undefined);
    return c.html(page(sid, 'Share', `<div class="hello"><h1>Send to a friend</h1></div>${ui.note({ body: sh.text, actions: [{ label: 'Send by text', href: sh.smsLink, icon: 'send' }] })}`, 'help'));
  });

  app.get('/s/:id/drafts', (c) => {
    const sid = c.req.param('id');
    const purpose = c.req.query('p');
    const list = a.drafts(sid).filter((d) => !purpose || d.purpose === purpose).reverse();
    return c.html(
      page(
        sid,
        'Messages to send',
        `${flash(sid, c.req.query('m'))}<div class="hello"><h1>Messages I drafted</h1><p class="date">Nothing is sent until you tap send.</p></div>${
          list.length
            ? list.map((d) => ui.note({ kind: d.status === 'sent' ? 'info' : 'plan', title: `To ${d.to}`, body: d.body, actions: d.status === 'sent' ? [] : [toAction(sid, { label: 'Send it', action: `approve:${d.id}` }, 0)], from: d.status === 'sent' ? 'Sent' : 'Waiting for you' })).join('')
            : ui.rows([], 'No drafts right now.')
        }`,
        'today',
      ),
    );
  });

  // ------------------------------------------------------------ you

  app.get('/s/:id/you', (c) => {
    const sid = c.req.param('id');
    const s = a.student(sid);
    const ledger = a.ledger.entries(sid).slice(-12).reverse();
    const ps = a.pulseState(sid);
    const depthLabel = { brief: 'Brief', standard: 'Standard', 'walk-me-through': 'Walk me through' } as const;
    return c.html(
      page(
        sid,
        'You',
        `${flash(sid, c.req.query('m'))}<div class="hello"><h1>${ui.esc(s.chosenName)}</h1><p class="date">${ui.esc([s.pronouns, s.enrollment.college.replace('-', ' '), s.enrollment.creditHours ? `${s.enrollment.creditHours} credits` : ''].filter(Boolean).join(', '))}</p></div>
${ui.section('Your things', ui.rows([
  { title: 'Your week', sub: 'Classes, work, pickups and study time', href: u(sid, '/week') },
  { title: 'Your dates', sub: 'Every deadline I found, and where', href: u(sid, '/dates') },
  { title: 'Work shifts', sub: 'Add or check your shifts', href: u(sid, '/shifts') },
  { title: 'Add a syllabus', sub: 'I find every date in it', href: u(sid, '/syllabus') },
  { title: 'Messages I drafted', sub: 'Nothing is sent until you say so', href: u(sid, '/drafts') },
  { title: 'Ask your Advocate', sub: 'Anything about school, money or life', href: u(sid, '/ask') },
  { title: 'Explain a letter', sub: 'What it means, what to do, by when', href: u(sid, '/letter') },
]))}
${ui.section('How I talk with you', `<div class="panel" style="padding:14px 18px"><p>Right now: <b>${depthLabel[s.dial.depth]}</b>. Quiet from ${ui.esc(time12(s.dial.quietStart))} to ${ui.esc(time12(s.dial.quietEnd))}.</p>${ui.actions((['brief', 'standard', 'walk-me-through'] as const).map((d) => toAction(sid, { label: depthLabel[d], action: `dial:${d}` }, d === s.dial.depth ? 0 : 1)))}</div>`)}
${ui.section('What I can see', ui.rows((['calendar', 'forwarding', 'learning-feed', 'location'] as const).map((src) => ({ title: { calendar: 'Your calendar', forwarding: 'Emails you forward', 'learning-feed': 'Your class site', location: 'Your location' }[src], chip: a.hasSource(sid, src) ? { text: 'On', tone: 'ok' as const } : { text: 'Off' }, actions: [toAction(sid, a.hasSource(sid, src) ? { label: 'Turn off', action: `source-off:${src}` } : { label: 'Turn on', action: `source-on:${src}` }, 1)] }))))}
${ui.section('Quick questions', ui.rows([{ title: ps.off ? 'Off' : `On, at most every ${ps.everyDays} days`, sub: 'One optional question now and then, so I can offer help before it is needed.', actions: [toAction(sid, ps.off ? { label: 'Turn on', action: 'pulses-on' } : { label: 'Turn off', action: 'pulses-off' }, 1)] }]))}
${ui.section('Your record of consent', ui.rows(ledger.map((e) => ({ title: `${e.kind} ${e.subject}`, sub: e.at.slice(0, 16).replace('T', ' ') })), 'Nothing yet.'))}
${ui.section('Your data', `<div class="panel" style="padding:14px 18px"><p>Everything I keep is yours. Download it, connect it to other tools, or delete it.</p>${ui.actions([{ label: 'Download everything', href: u(sid, '/export'), variant: 'quiet' }, { label: 'Calendar feed', href: u(sid, '/calendar.ics'), variant: 'quiet' }, toAction(sid, { label: 'Share the Advocate', action: 'share' }, 1), { label: 'Delete everything', post: { url: u(sid, '/action'), fields: { action: 'delete-account' } }, variant: 'danger' }])}</div>`)}`,
        'you',
      ),
    );
  });

  app.get('/s/:id/settings', (c) => c.redirect(u(c.req.param('id'), '/you')));

  app.get('/s/:id/export', (c) => c.json(a.exportData(c.req.param('id'))));

  // ------------------------------------------------------------ every button

  app.post('/s/:id/action', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const action = String(f.action ?? '');
    const r = a.perform(sid, action);
    if (!r) {
      const d = a.deliver({ studentId: sid, author: 'chief-of-staff', urgency: 'routine', text: 'That button is not available right now. Here is your day.', nextSteps: [{ label: 'Show my day', action: 'today' }] }, { force: true });
      return c.redirect(`${u(sid)}?m=${d.id}`);
    }
    if (r.view === 'deleted') return c.html(page(undefined, 'Deleted', `<div class="hello"><h1>Deleted</h1></div>` + ui.note({ title: 'Everything is deleted', body: 'Your Advocate account and everything in it are gone. You can start again any time.', actions: [{ label: 'Go to the start', href: `${base}/` }] })));
    const d = a.deliver(r.message, { force: true });
    if (r.view) {
      const path = r.view === 'resource' ? `/resource/${encodeURIComponent(r.viewArg ?? '')}` : r.view === 'share' ? '/share' : VIEW_PATH[r.view];
      const q = new URLSearchParams({ m: d.id });
      if (r.view === 'share' && r.viewArg) q.set('r', r.viewArg);
      if (r.view === 'drafts' && r.viewArg) q.set('p', r.viewArg);
      return c.redirect(`${u(sid, path)}?${q}#latest`);
    }
    return c.html(page(sid, 'Your Advocate', `<div class="hello"><h1>Your Advocate</h1></div>${noteFor(sid, d, { id: 'latest' })}${ui.actions([{ label: 'Back to today', href: u(sid), variant: 'quiet' }])}`, 'today'));
  });

  // ------------------------------------------------------------ integration API, calendar feed, app shell bits

  app.route('/api', createApi(a));
  // Authorization by absence (Pattern 30): with sign-in on and no admin listed, the admin is not mounted at all.
  if (!auth || auth.adminEmailHashes.length) app.route('/admin', createAdmin(a, { base, controlDir: fileURLToPath(new URL('../../../../control', import.meta.url)) }));

  app.get('/s/:id/calendar.ics', (c) => c.body(a.calendarFeed(c.req.param('id')), 200, { 'content-type': 'text/calendar; charset=utf-8' }));

  app.get('/manifest.webmanifest', (c) => c.json({ name: 'Student Advocate', short_name: 'Advocate', start_url: `${base}/`, display: 'standalone', background_color: ui.TOKENS.light.paper, theme_color: ui.TOKENS.light.action, icons: [{ src: `${base}/icon.svg`, sizes: 'any', type: 'image/svg+xml' }] }));
  app.get('/icon.svg', (c) => c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${ui.TOKENS.light.action}"/><circle cx="20" cy="44" r="5" fill="#fff"/><circle cx="44" cy="20" r="5" fill="${ui.TOKENS.light.mark}"/><path d="M25 44h12a9 9 0 0 0 0-18H27a9 9 0 0 1 0-18h12" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/></svg>`, 200, { 'content-type': 'image/svg+xml' }));
  app.get('/healthz', (c) => c.json({ ok: true }));

  void PERSONA_NAMES;
  return app;
}
