import { Hono } from 'hono';
import type { Advocate, Delivered } from '../agents/advocate.js';
import { intentCompletion, costSummary } from '@zthr/evidence';
import { friendly, shortDate } from '../domain/dates.js';
import type { NeedCategory, OutboundMessage } from '../domain/types.js';
import { actionButton, esc, page } from './html.js';

/**
 * The web app and text-message webhook. Both are thin: every behavior lives in
 * the Advocate, so the app and text channel stay at parity (PRD P8, ADR 0002).
 */
const NEEDS: [NeedCategory, string][] = [
  ['food', 'Food'],
  ['housing', 'Housing'],
  ['utilities', 'Utilities'],
  ['money', 'Money for an emergency'],
  ['transportation', 'Getting around'],
  ['phone-internet', 'Phone or internet'],
  ['childcare', 'Child care'],
  ['legal', 'Legal help'],
  ['mental-health', 'Someone to talk to'],
];

const PROGRAM_RESOURCE: Record<string, string> = {
  snap: 'ohio-benefits-snap',
  lifeline: 'lifeline',
  'ohio-heap': 'ohio-heap',
  'sinclair-emergency-grant': 'sinclair-emergency-grant',
};

function messageCard(sid: string, m: Delivered | (OutboundMessage & { at?: string })): string {
  return `<div class="card"><div class="msg">${esc(m.text)}</div>${m.why ? `<div class="why">Why you're seeing this: ${esc(m.why)}</div>` : ''}<div class="steps">${m.nextSteps
    .map((n, i) => actionButton(sid, n.label, n.action, i > 0))
    .join('')}</div></div>`;
}

export function createApp(a: Advocate): Hono {
  const app = new Hono();

  app.get('/', (c) =>
    c.html(
      page(
        'Student Advocate',
        `<div class="card"><h2>A team that works for you, not your college</h2>
<p>Student Advocate runs your day, finds money and help you qualify for, and does the legwork to get it. It's free, it belongs to you, and it never shares anything unless you say so.</p>
<p><strong>Start by text:</strong> send any message to the Advocate number, or try the <a href="/demo">demo students</a>.</p>
<p class="muted">This is the demonstration build of the ZTHR reference implementation. It runs on synthetic students; nothing here is a real person's data.</p></div>
<div class="card"><h2>Try it by text</h2><form method="post" action="/try"><label for="phone">Pretend phone number</label><input id="phone" name="phone" value="+19375550123"><label for="body">Message</label><input id="body" name="body" value="I need help with my electric bill"><div class="steps"><button>Send</button></div></form></div>`,
      ),
    ),
  );

  app.post('/try', async (c) => {
    const f = await c.req.parseBody();
    const phone = String(f.phone ?? '+19375550123');
    const replies = a.textIn(phone, String(f.body ?? ''));
    const s = a.findByPhone(phone);
    return c.html(
      page(
        'Text conversation',
        `${replies.map((r) => `<div class="card msg">${esc(r)}</div>`).join('')}
<div class="card"><form method="post" action="/try"><input type="hidden" name="phone" value="${esc(phone)}"><label for="body">Reply</label><input id="body" name="body" autofocus><div class="steps"><button>Send</button>${s ? `<a class="btn secondary" href="/s/${esc(s.id)}">Open in the app</a>` : ''}</div></form></div>`,
      ),
    );
  });

  // Carrier webhook (form-encoded From and Body), answered in the provider's XML reply format.
  app.post('/sms/inbound', async (c) => {
    const f = await c.req.parseBody();
    const replies = a.textIn(String(f.From ?? ''), String(f.Body ?? ''));
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${replies.map((r) => `<Message>${esc(r)}</Message>`).join('')}</Response>`;
    return c.body(xml, 200, { 'content-type': 'text/xml' });
  });

  app.get('/s/:id', (c) => {
    const sid = c.req.param('id');
    const s = a.student(sid);
    const v = a.today_(sid);
    const recent = a.messages(sid).filter((m) => m.status === 'delivered').slice(-6).reverse();
    const ahead = a.lookAhead(sid);
    const money = a.moneyCheck(sid);
    const pulse = a.pulse(sid);
    return c.html(
      page(
        `Today, ${s.chosenName}`,
        `${messageCard(sid, a.todayMessage(sid))}
${money ? messageCard(sid, money) : ''}
${pulse ? messageCard(sid, pulse) : ''}
${ahead.map((m) => messageCard(sid, m)).join('')}
<div class="card"><h2>Coming up</h2>${
          v.dueSoon.length
            ? `<ul class="clean">${v.dueSoon.map((d) => `<li>${esc(d.title)}${d.course ? ` <span class="tag">${esc(d.course)}</span>` : ''}<br><span class="muted">${esc(friendly(d.due))}</span> ${actionButton(sid, 'Done', `mark-done:${d.id}`, true)}</li>`).join('')}</ul>`
            : '<p class="muted">Nothing due in the next week. Add a syllabus below and I will find every date.</p>'
        }</div>
<div class="card"><h2>Talk to your Advocate</h2><form method="post" action="/s/${esc(sid)}/say"><label for="t">Message</label><input id="t" name="text" placeholder="Try: I need food, today, what is a registrar"><div class="steps"><button>Send</button></div></form></div>
${recent.length ? `<div class="card"><h2>Recent</h2>${recent.map((m) => `<div class="msg" style="margin:8px 0">${esc(m.text)}</div>`).join('<hr style="border:0;border-top:1px solid var(--line)">')}</div>` : ''}
<div class="card"><h2>Add a syllabus</h2><form method="post" action="/s/${esc(sid)}/syllabus"><label for="course">Course</label><input id="course" name="course" placeholder="ENG 1101"><label for="text">Paste the schedule part of the syllabus</label><textarea id="text" name="text" rows="6"></textarea><div class="steps"><button>Find the dates</button></div></form></div>`,
        { studentId: sid },
      ),
    );
  });

  app.post('/s/:id/say', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const out = a.converse(sid, String(f.text ?? ''));
    return c.html(page('Advocate', out.map((m) => messageCard(sid, m)).join(''), { studentId: sid }));
  });

  app.post('/s/:id/syllabus', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const r = a.uploadSyllabus(sid, String(f.course || 'Course'), String(f.text ?? ''), a.student(sid).createdAt.slice(0, 4) + '-08-24');
    const list = `<div class="card"><h2>Dates I found</h2><ul class="clean">${r.deadlines.map((d) => `<li><strong>${esc(d.title)}</strong> <span class="tag">${esc(shortDate(d.due))}</span><div class="why">From: "${esc(d.source.line)}"</div></li>`).join('')}</ul></div>`;
    return c.html(page('Syllabus', messageCard(sid, a.deliver(r.message, { force: true })) + list, { studentId: sid }));
  });

  app.get('/s/:id/money', (c) => {
    const sid = c.req.param('id');
    const results = a.screen(sid);
    return c.html(
      page(
        'Money',
        `${messageCard(sid, a.moneyFoundMessage(sid))}
<div class="card"><h2>What I checked</h2><table><tr><th>Program</th><th>Result</th><th>Why</th></tr>${results
          .map(
            (r) =>
              `<tr><td>${esc(r.title)}</td><td class="${r.status === 'likely' ? 'ok' : r.status === 'unlikely' ? 'muted' : 'warn'}">${esc(r.status.replace('-', ' '))}${r.estimatedMonthlyValue ? `<br>$${esc(r.estimatedMonthlyValue)}/mo${r.valueIsEstimate ? ' est.' : ''}` : ''}</td><td>${esc([...r.reasons, ...r.needs.map((n) => `Need: ${n}`)].join(' '))}<div class="why"><a href="${esc(r.source)}">Rule source</a>${r.statusRuleNote ? ` · ${esc(r.statusRuleNote)}` : ''}</div></td></tr>`,
          )
          .join('')}</table></div>`,
        { studentId: sid },
      ),
    );
  });

  app.get('/s/:id/help', (c) => {
    const sid = c.req.param('id');
    return c.html(
      page(
        'Help',
        `<div class="card"><h2>What's hard right now?</h2><p class="muted">Pick one. I'll find help that fits you and do the legwork.</p><div class="steps">${NEEDS.map(([n, label]) => actionButton(sid, label, `need:${n}`, true)).join('')}</div></div>
<div class="card"><h2>Something went wrong?</h2><div class="steps">${[
          ['I got an eviction notice', 'situation:eviction'],
          ['My power is getting shut off', 'situation:utility-shutoff'],
          ['My car died', 'situation:car'],
          ["I'm out of food", 'situation:no-food'],
          ["I can't make rent", 'situation:rent-short'],
        ]
          .map(([l, x]) => actionButton(sid, l!, x!, true))
          .join('')}</div></div>
<div class="card"><h2>Need to talk to someone now?</h2><p>Call or text <strong>988</strong> any time. If you are in danger, call 911.</p></div>`,
        { studentId: sid },
      ),
    );
  });

  app.get('/s/:id/settings', (c) => {
    const sid = c.req.param('id');
    const s = a.student(sid);
    const ledger = a.ledger.entries(sid).slice(-10).reverse();
    return c.html(
      page(
        'Settings',
        `<div class="card"><h2>How I work with you</h2><p>Depth: <strong>${esc(s.dial.depth)}</strong> · Channel: <strong>${esc(s.dial.channel)}</strong> · Quiet hours ${esc(s.dial.quietStart)} to ${esc(s.dial.quietEnd)}</p><div class="steps">${actionButton(sid, 'Brief', 'dial:brief', true)}${actionButton(sid, 'Standard', 'dial:standard', true)}${actionButton(sid, 'Walk me through', 'dial:walk-me-through', true)}</div></div>
<div class="card"><h2>What I can see</h2><ul class="clean">${(['calendar', 'forwarding', 'learning-feed', 'location'] as const)
          .map((src) => `<li>${esc(src)}: ${a.hasSource(sid, src) ? `<span class="ok">on</span> ${actionButton(sid, 'Turn off', `source-off:${src}`, true)}` : `<span class="muted">off</span> ${actionButton(sid, 'Turn on', `source-on:${src}`, true)}`}</li>`)
          .join('')}</ul></div>
<div class="card"><h2>Your record of consent</h2>${ledger.length ? `<ul class="clean">${ledger.map((e) => `<li>${esc(e.kind)} <span class="tag">${esc(e.subject)}</span> <span class="muted">${esc(e.at.slice(0, 16).replace('T', ' '))}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</div>
<div class="card"><h2>Quick questions</h2><p>${a.pulseState(sid).off ? 'Off' : `On, at most every ${a.pulseState(sid).everyDays} days`}</p><div class="steps">${a.pulseState(sid).off ? actionButton(sid, 'Turn on', 'pulses-on', true) : actionButton(sid, 'Turn off', 'pulses-off', true)}</div></div>
<div class="card"><h2>Tell a friend</h2><div class="steps">${actionButton(sid, 'Share the Advocate', 'share', true)}</div></div>
<div class="card"><h2>Your data</h2><div class="steps"><a class="btn secondary" href="/s/${esc(sid)}/export">Download everything</a>${actionButton(sid, 'Delete everything', 'delete-account', true)}</div></div>`,
        { studentId: sid },
      ),
    );
  });

  app.get('/s/:id/export', (c) => c.json(a.exportData(c.req.param('id'))));

  app.post('/s/:id/action', async (c) => {
    const sid = c.req.param('id');
    const f = await c.req.parseBody();
    const action = String(f.action ?? '');
    const [verb, ...rest] = action.split(':');
    const arg = rest.join(':');
    const show = (m: OutboundMessage) => c.html(page('Advocate', messageCard(sid, a.deliver(m, { force: true })), { studentId: sid }));
    switch (verb) {
      case 'today':
        return show(a.todayMessage(sid));
      case 'screen':
        return show(a.moneyFoundMessage(sid));
      case 'need':
        return show(a.helpMessage(sid, arg as NeedCategory));
      case 'find-help':
        return arg ? show(a.assignmentHelp(sid, arg)) : c.redirect(`/s/${sid}/help`);
      case 'find-tutor':
      case 'plan-next': {
        const next = a.deadlines(sid).find((d) => !d.done && d.due >= a.today_(sid).date);
        if (!next) return show({ studentId: sid, author: 'coursework-planner', urgency: 'routine', text: 'Nothing is due yet. Add a syllabus and I will find every date.', nextSteps: [{ label: 'Back to today', action: 'today' }] });
        return show(verb === 'find-tutor' ? a.assignmentHelp(sid, next.id) : a.planMessage(sid, next.id));
      }
      case 'pulse': {
        const [pid, ans] = arg.split(':');
        return show(a.answerPulse(sid, pid!, ans === 'yes' ? 'yes' : 'no'));
      }
      case 'pulses-off':
        a.setPulses(sid, { off: true });
        return show({ studentId: sid, author: 'navigator', urgency: 'routine', text: 'Done. No more quick questions. You can turn them back on in Settings.', nextSteps: [{ label: 'Settings', action: 'settings' }] });
      case 'pulses-on':
        a.setPulses(sid, { off: false });
        return c.redirect(`/s/${sid}/settings`);
      case 'settings':
        return c.redirect(`/s/${sid}/settings`);
      case 'share': {
        const sh = a.shareText(sid, arg || undefined);
        return c.html(page('Share', `<div class="card"><h2>Send to a friend</h2><div class="msg">${esc(sh.text)}</div><div class="steps"><a class="btn" href="${esc(sh.smsLink)}">Send by text</a></div></div>`, { studentId: sid }));
      }
      case 'draft-instructor-note': {
        const d = a.deadlines(sid).find((x) => x.id === arg);
        const st = a.student(sid);
        if (d) a.createDraft(sid, 'instructor', `instructor:${d.course ?? 'course'}`, `Hello, this is ${st.chosenName} from ${d.course ?? 'your class'}. I would like to talk about a plan for ${d.title}. Is there a time this week that works, or a way I can still turn it in? Thank you.`, `instructor-note:${d.id}`);
        const drafts = a.drafts(sid).filter((x) => x.status === 'shown' && x.purpose === `instructor-note:${arg}`);
        return c.html(page('Draft', drafts.map((x) => `<div class="card"><h2>To: ${esc(x.to)}</h2><div class="msg">${esc(x.body)}</div><div class="why">Nothing is sent until you tap send.</div><div class="steps">${actionButton(sid, 'Send it', `approve:${x.id}`)}</div></div>`).join(''), { studentId: sid }));
      }
      case 'situation':
        return show(a.crisis(sid, arg as never).message);
      case 'mark-done':
        a.markDone(sid, arg);
        return c.redirect(`/s/${sid}`);
      case 'confirm-deadlines':
        a.confirmDeadlines(sid, 'all');
        return c.redirect(`/s/${sid}`);
      case 'plan':
        return show(a.planMessage(sid, arg));
      case 'dial':
        a.setDial(sid, { depth: arg as never });
        return c.redirect(`/s/${sid}/settings`);
      case 'source-on':
        a.connectSource(sid, arg as never);
        return c.redirect(`/s/${sid}/settings`);
      case 'source-off':
        a.disconnectSource(sid, arg);
        return c.redirect(`/s/${sid}/settings`);
      case 'start-program':
      case 'start-resource': {
        const rid = verb === 'start-program' ? PROGRAM_RESOURCE[arg] ?? arg : arg;
        const r = a.catalog.find((x) => x.id === rid);
        if (!r) return show({ studentId: sid, author: 'navigator', urgency: 'routine', text: "I couldn't find that one. Let's look again.", nextSteps: [{ label: 'Find help', action: 'find-help' }] });
        const opt = a.findHelp(sid, r.categories[0]!).options.find((o) => o.resource.id === rid);
        const body = `<div class="card"><h2>${esc(r.name)}</h2><p>${esc(r.description)}</p>${r.hours ? `<p><strong>Hours:</strong> ${esc(r.hours)}</p>` : '<p class="muted">Hours not published. Call ahead.</p>'}${r.location ? `<p><strong>Where:</strong> ${esc(r.location.address)}, ${esc(r.location.city)}</p>` : ''}${r.phone ? `<p><strong>Call:</strong> <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></p>` : ''}
<h3>Steps</h3><ol>${r.howToApply.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
${opt?.missingDocuments.length ? `<h3>Still needed</h3><ul>${opt.missingDocuments.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
${opt && Object.keys(opt.prefilled).length ? `<h3>I can fill in</h3><ul>${Object.entries(opt.prefilled).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join('')}</ul>` : ''}
${r.url ? `<div class="steps"><a class="btn" href="${esc(r.url)}">Open the application</a></div>` : ''}
<div class="why">Verified ${esc(r.verifiedOn)} from <a href="${esc(r.source.url)}">the source</a>.</div></div>`;
        return c.html(page(r.name, body, { studentId: sid }));
      }
      case 'show-draft': {
        const one = arg ? a.draftFor(sid, arg) : undefined;
        const drafts = one ? [one] : a.drafts(sid).filter((d) => d.status === 'shown');
        return c.html(
          page(
            'Drafts',
            drafts.length
              ? drafts.map((d) => `<div class="card"><h2>To: ${esc(d.to)}</h2><div class="msg">${esc(d.body)}</div><div class="why">Nothing is sent until you tap send.</div><div class="steps">${actionButton(sid, 'Send it', `approve:${d.id}`)}</div></div>`).join('')
              : '<div class="card"><p>No drafts waiting.</p></div>',
            { studentId: sid },
          ),
        );
      }
      case 'approve': {
        const token = a.approve(sid, arg);
        const r = await a.send(sid, arg, token);
        return show({ studentId: sid, author: 'chief-of-staff', urgency: 'routine', text: r.sent ? 'Sent. I will watch for a reply and let you know.' : `That didn't go through (${r.reason}).`, nextSteps: [{ label: 'Back to today', action: 'today' }] });
      }
      case 'playbook': {
        const [id, ev, value] = arg.split(':');
        const run = ev === 'answer' ? a.playbookEvent(sid, id!, { type: 'answer', value: value! }) : ev === 'confirm' ? a.playbookEvent(sid, id!, { type: 'confirm' }) : undefined;
        if (ev === 'draft') return c.redirect(`/s/${sid}`);
        return show(a.playbookMessage(sid, run!));
      }
      case 'delete-account': {
        a.deleteStudent(sid);
        return c.html(page('Deleted', '<div class="card"><h2>Everything is deleted.</h2><p>Your Advocate account and everything in it are gone. You can start again any time by texting the Advocate number.</p></div>'));
      }
      default:
        return show({
          studentId: sid,
          author: 'chief-of-staff',
          urgency: 'routine',
          text: 'That part is still being built. Here is what I can do right now.',
          nextSteps: [
            { label: 'Show my day', action: 'today' },
            { label: 'Find help', action: 'find-help' },
          ],
        });
    }
  });

  app.get('/manifest.webmanifest', (c) =>
    c.json({ name: 'Student Advocate', short_name: 'Advocate', start_url: '/', display: 'standalone', background_color: '#f6f7f9', theme_color: '#1f3a5f', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }),
  );
  app.get('/icon.svg', (c) =>
    c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f5fbf"/><path d="M18 44 L32 16 L46 44 M24 34 H40" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`, 200, { 'content-type': 'image/svg+xml' }),
  );
  app.get('/sw.js', (c) =>
    c.body(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('fetch',()=>{});`, 200, { 'content-type': 'text/javascript' }),
  );

  app.get('/evidence', (c) => {
    const ic = intentCompletion(a.evidence);
    const cost = costSummary(a.evidence);
    return c.html(page('Evidence', `<div class="card"><h2>Live evidence (this server)</h2><p>Intent completion: ${ic.value === undefined ? 'not measured' : `${ic.numerator}/${ic.denominator}`}</p><p>Model calls: ${cost.calls}; cost as paid: ${cost.asPaid === undefined ? 'not measured' : `$${cost.asPaid.toFixed(4)}`}</p><p class="muted">The published evidence page is built from the factory's evidence store by <code>npm run evidence</code>.</p></div>`));
  });

  return app;
}
