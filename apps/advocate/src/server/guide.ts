import { zodToJsonSchema } from 'zod-to-json-schema';
import { Hono } from 'hono';
import * as ui from '@zthr/ui';
import type { Advocate } from '../agents/advocate.js';
import type { Resource } from '../catalog/types.js';
import { isFresh } from '../catalog/types.js';
import type { NeedCategory } from '../domain/types.js';
import { BARRIER, BARRIERS, DOMAINS, DOMAIN_LABEL, PROVIDER_KINDS, PROVIDER_LABEL, SITUATION_LABEL, type ProviderKind } from '../guide/taxonomy.js';
import { serves } from '../domain/navigator.js';
import { recordLine, OUTCOMES, OUTCOME_LABEL } from '../guide/feedback.js';
import { Feed, FeedService, LICENSE, toFeedService } from '../guide/feed.js';
import { PACKAGES } from '../guide/packages.js';
import { active } from '../guide/barriers.js';

/**
 * The community resource guide, on screen and as a feed (docs/flows/resource-guide.md, docs/api/guide.md).
 *
 *  - /guide, /guide/:barrier, /guide/service/:id: the whole guide, public, no sign-in;
 *  - /s/:id/guide, /s/:id/guide/:barrier, /s/:id/plan: the same guide for a student, with what serves them first,
 *    their open barriers, and their care plan;
 *  - /api/guide/v1/...: the public feed, open to any app.
 */
export interface GuideCtx {
  base: string;
  /** The student's screen shell; absent for public pages. */
  page: (sid: string | undefined, title: string, body: string, current?: string) => string;
  u: (sid: string, path?: string) => string;
}

const KIND_ICON: Record<ProviderKind, string> = { college: 'cap', government: 'shield', nonprofit: 'help', faith: 'home', community: 'talk', health: 'check' };
const COST: Record<string, string> = { free: 'Free', 'sliding-scale': 'You pay what you can', 'low-cost': 'Low cost', varies: 'Cost varies; help is available' };

function faithLine(r: Resource): string | undefined {
  if (r.provider.kind !== 'faith') return undefined;
  return r.provider.faithNote ?? 'A faith-based provider. The source does not say whether help depends on attending anything; you can ask when you call.';
}

/** The four facts kept apart: what is known now, each with its source, or "not known". */
function availabilityFacts(a: Advocate, r: Resource, sid?: string): [string, string][] {
  const f = (k: string) => r.availability?.find((x) => x.fact === k);
  const elig = sid && r.eligibility.rule ? a.findHelp(sid, r.categories[0]!).options.find((o) => o.resource.id === r.id)?.eligibility : undefined;
  const rules = elig ? (elig.status === 'likely' ? 'You meet the published rules, from what you told me' : elig.status === 'needs-info' ? 'I need a little more information to tell' : 'From what you told me, the rules may not fit') : sid ? r.eligibility.text : r.eligibility.text;
  const open = f('applications-open') ?? f('season');
  return [
    ['Who it is for', rules],
    ['Open now', open ? `${open.value} (checked ${open.checkedOn})` : 'Not known; call to ask'],
    ['Money or room available', f('funding')?.value ?? 'Not known; only the provider can say'],
    ['How long it takes', f('response-time')?.value ?? 'Not known; ask when you apply'],
  ];
}

export function guideRoutes(a: Advocate, ctx: GuideCtx): Hono {
  const app = new Hono({ strict: false });
  const pub = (title: string, body: string) =>
    ui.bareShell({ theme: 'student', title: `${title} · Community resource guide`, base: ctx.base, head: '<meta name="description" content="Every kind of help for college students in Montgomery and Greene counties, Ohio: kept current, free, and public.">', body: `<main id="main" class="page">${body}<p class="small muted">Not affiliated with any educational institution. All data from public sources. <a href="${ctx.base}/api/guide/v1/services">This guide as a free feed</a>.</p></main>` });
  const guideHref = (sid?: string, path = '') => (sid ? ctx.u(sid, `/guide${path}`) : `${ctx.base}/guide${path}`);
  const serviceHref = (r: Resource, sid?: string) => (sid ? ctx.u(sid, `/resource/${r.id}`) : `${ctx.base}/guide/service/${r.id}`);

  const current = (r: Resource) => isFresh(r, a.dateToday());
  const kindChip = (r: Resource): ui.Row['chip'] => ({ text: PROVIDER_LABEL[r.provider.kind] });

  function home(sid?: string, q = '', kind = ''): string {
    const matchQ = (r: Resource) => !q || `${r.name} ${r.organization} ${r.description} ${r.categories.map((c) => BARRIER[c]?.label ?? c).join(' ')}`.toLowerCase().includes(q.toLowerCase());
    const matchK = (r: Resource) => !kind || r.provider.kind === kind;
    const list = a.catalog.filter((r) => matchQ(r) && matchK(r));
    const open = sid ? active(a.barriers(sid)) : [];
    const search = `<form class="panel" role="search" method="get" action="${ui.esc(guideHref(sid))}" style="padding:12px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:end"><label for="guide-q" style="flex:1 1 220px;display:grid;gap:4px"><span class="small">Search the guide</span><input id="guide-q" type="search" name="q" value="${ui.esc(q)}" placeholder="food, rent, a ride, ID, counseling" autocomplete="off"></label><label for="guide-kind" style="display:grid;gap:4px"><span class="small">Kind of provider</span><select id="guide-kind" name="kind"><option value="">Any</option>${PROVIDER_KINDS.map((k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${PROVIDER_LABEL[k]}</option>`).join('')}</select></label><button class="btn primary">Search</button></form>`;
    const results = q || kind ? ui.section(`${list.length} ${list.length === 1 ? 'result' : 'results'}`, ui.rows(list.map((r) => ({ title: r.name, sub: `${r.organization}. ${r.description}`, chip: kindChip(r), href: serviceHref(r, sid) })), 'Nothing matches. Try another word, or call 2-1-1.')) : '';
    const yours = open.length
      ? ui.section('What you told me is hard', ui.rows(open.map((b) => ({ title: BARRIER[b.need]?.label ?? b.need, sub: `${b.urgency === 'tonight' ? 'Tonight. ' : ''}${b.status === 'in-progress' ? 'You are working on it.' : 'Open.'} It stays here until you say it is resolved.`, href: guideHref(sid, `/${b.need}`) }))))
      : '';
    const domains = DOMAINS.map((d) => {
      const bs = BARRIERS.filter((b) => b.domain === d);
      return ui.section(DOMAIN_LABEL[d], ui.rows(bs.map((b) => {
        const n = a.catalog.filter((r) => r.categories.includes(b.id)).length;
        return { title: b.label, sub: b.covers, chip: { text: `${n} ${n === 1 ? 'place' : 'places'}` }, href: guideHref(sid, `/${b.id}`) };
      })));
    }).join('');
    const tonight = ui.note({ kind: 'safety', title: 'No safe place tonight?', body: 'Call 2-1-1 any time and they will find a shelter with room. If you are in danger, call 911. To talk to someone now, call or text 988.', actions: [{ label: 'Call 2-1-1', href: 'tel:211', variant: 'call', icon: 'phone' }, { label: 'Call or text 988', href: 'tel:988', variant: 'quiet', icon: 'phone' }] });
    return `<div class="hello"><h1>Community resource guide</h1><p class="date">${ui.esc(`${a.catalog.length} places that help college students in Montgomery and Greene counties: colleges, government, nonprofits, faith groups and the community. Every one is checked against its own source.`)}</p></div>
${tonight}${yours}${search}${results}${domains}`;
  }

  function barrierPage(need: NeedCategory, sid?: string, kind = ''): string {
    const def = BARRIER[need]!;
    const all = a.catalog.filter((r) => r.categories.includes(need) && (!kind || r.provider.kind === kind));
    const student = sid ? a.student(sid) : undefined;
    const forYou = student ? all.filter((r) => serves(r, student) && current(r)) : [];
    const others = all.filter((r) => !forYou.includes(r));
    const row = (r: Resource): ui.Row => ({ title: r.name, sub: `${r.organization}${r.cost ? `. ${COST[r.cost] ?? ''}` : ''}${current(r) ? '' : '. Not checked recently; call first'}. ${r.description}`, chip: kindChip(r), href: serviceHref(r, sid) });
    const pkg = PACKAGES.find((p) => p.need === need);
    const open = sid ? a.barriers(sid).items.find((b) => b.need === need && b.status !== 'resolved') : undefined;
    const post = (action: string) => (sid ? { url: ctx.u(sid, '/action'), fields: { action } } : undefined);
    const barrierActions: ui.Action[] = sid
      ? open
        ? [{ label: 'It is resolved', post: post(`barrier:resolve:${need}`)!, variant: 'primary' }, { label: 'Not today', post: post(`barrier:not-today:${need}`)!, variant: 'quiet' }]
        : [{ label: 'This is hard for me right now', post: post(`barrier:open:${need}`)!, variant: 'primary' }]
      : [];
    const kinds = [...new Set(a.catalog.filter((r) => r.categories.includes(need)).map((r) => r.provider.kind))];
    const filter = kinds.length > 1 ? `<nav aria-label="Kind of provider" class="small" style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px"><a href="${ui.esc(guideHref(sid, `/${need}`))}"${!kind ? ' aria-current="page"' : ''}>All</a>${kinds.map((k) => `<a href="${ui.esc(guideHref(sid, `/${need}?kind=${k}`))}"${k === kind ? ' aria-current="page"' : ''}>${PROVIDER_LABEL[k]}</a>`).join('')}</nav>` : '';
    return `<div class="hello"><h1>${ui.esc(def.label)}</h1><p class="date">${ui.esc(`${def.covers}. ${DOMAIN_LABEL[def.domain]}.`)}</p></div>
${barrierActions.length ? ui.actions(barrierActions) : ''}
${pkg ? ui.note({ kind: 'plan', title: pkg.title, body: `${pkg.why}${pkg.selfStep ? ` ${pkg.selfStep}` : ''}` }) : ''}
${filter}
${sid ? ui.section('Serves you', ui.rows(forYou.map(row), 'Nothing checked serves your college or county for this yet. 2-1-1 can help any time, and the gap is counted.')) : ''}
${ui.section(sid ? 'Everywhere else in the guide' : `${all.length} ${all.length === 1 ? 'place' : 'places'}`, ui.rows((sid ? others : all).map(row), 'Nothing listed here yet.'))}
<p><a href="${ui.esc(guideHref(sid))}">The whole guide</a></p>`;
  }

  function servicePage(r: Resource, sid?: string): string {
    const opt = sid ? a.findHelp(sid, r.categories[0]!).options.find((o) => o.resource.id === r.id) : undefined;
    const rec = recordLine(a.resourceRecord(r.id));
    const faith = faithLine(r);
    const facts = availabilityFacts(a, r, sid);
    const post = (action: string) => ({ url: ctx.u(sid ?? '', '/action'), fields: { action } });
    return `<div class="hello"><h1>${ui.esc(r.name)}</h1><p class="date">${ui.esc(r.description)}</p></div>
<div class="panel" style="padding:16px 18px">
<p><b>Provided by:</b> ${ui.esc(r.organization)} <span class="chip">${ui.esc(PROVIDER_LABEL[r.provider.kind])}</span></p>
${faith ? `<p class="small">${ui.esc(faith)}</p>` : ''}
${r.cost ? `<p><b>Cost:</b> ${ui.esc(COST[r.cost] ?? r.cost)}</p>` : ''}
${r.hours ? `<p><b>Hours:</b> ${ui.esc(r.hours)}</p>` : '<p class="muted">Hours are not published. Call ahead.</p>'}
${r.location ? `<p><b>Where:</b> ${ui.esc(r.location.address)}${r.location.address === r.location.city ? '' : `, ${ui.esc(r.location.city)}`}</p>` : ''}
${r.phone ? `<p><b>Call:</b> <a href="tel:${ui.esc(r.phone)}">${ui.esc(r.phone)}</a></p>` : ''}
${r.situations?.length ? `<p><b>Especially for:</b> ${ui.esc(r.situations.map((s) => SITUATION_LABEL[s]).join(', '))}</p>` : ''}
<h2 style="margin-top:14px">What is known now</h2>
<dl class="facts">${facts.map(([k, v]) => `<dt>${ui.esc(k)}</dt><dd>${ui.esc(v)}</dd>`).join('')}</dl>
<h2 style="margin-top:14px">How to use it</h2><ol>${r.howToApply.map((x) => `<li>${ui.esc(x)}</li>`).join('')}</ol>
${r.documents.length ? `<h3>Bring</h3><ul>${r.documents.map((d) => `<li>${ui.esc(d)}</li>`).join('')}</ul>` : ''}
${r.whatToExpect ? `<h3>What to expect</h3><p>${ui.esc(r.whatToExpect)}</p>` : ''}
${opt?.missingDocuments.length ? `<h3>Still needed</h3><ul>${opt.missingDocuments.map((d) => `<li>${ui.esc(d)}</li>`).join('')}</ul>` : ''}
${opt && Object.keys(opt.prefilled).length ? `<h3>I can fill in</h3><ul>${Object.entries(opt.prefilled).map(([k, v]) => `<li>${ui.esc(k)}: ${ui.esc(v)}</li>`).join('')}</ul>` : ''}
${rec ? `<p><b>Other students:</b> ${ui.esc(rec)}</p>` : ''}
<p class="small muted">${ui.esc(current(r) ? `Checked ${r.verifiedOn} against its source.` : `Not checked recently (last ${r.verifiedOn}). Call to confirm before you go.`)} <a href="${ui.esc(r.source.url)}">The source</a>.</p>
</div>
${ui.actions([...(r.url ? [{ label: 'Open their page', href: r.url }] : []), ...(r.phone ? [{ label: `Call ${r.name}`, href: `tel:${r.phone}`, variant: 'call' as const, icon: 'phone' }] : [])])}
${sid ? ui.section('Did it help?', `<div class="panel" style="padding:12px 14px"><p class="small">If you used it, tell me. Your answer is counted with others and never shown on its own.</p>${ui.actions(OUTCOMES.map((o, i) => ({ label: OUTCOME_LABEL[o], post: post(`feedback:${r.id}:${o}`), variant: i === 0 ? ('primary' as const) : ('quiet' as const) })))}</div>`) : ''}
${sid ? ui.actions([{ label: 'Share with a friend', post: post(`share:${r.id}`), variant: 'quiet' }]) : ''}
<p>${r.categories.map((c) => `<a href="${ui.esc(guideHref(sid, `/${c}`))}">${ui.esc(BARRIER[c]?.label ?? c)}</a>`).join(' · ')}</p>`;
  }

  function planPage(sid: string): string {
    const plan = a.carePlan(sid);
    const post = (action: string) => ({ url: ctx.u(sid, '/action'), fields: { action } });
    const blocks = plan
      .map(({ barrier: b, pkg, options }) => {
        const label = BARRIER[b.need]?.label ?? b.need;
        const title = pkg?.title ?? label;
        const head = b.urgency === 'tonight' && !/tonight/i.test(title) ? `Tonight: ${title}` : title;
        const steps = options.slice(0, 4).map((o, i) => ({ title: `${i + 1}. ${o.resource.name}`, sub: o.resource.howToApply[0] ?? o.resource.description, chip: kindChip(o.resource), href: ctx.u(sid, `/resource/${o.resource.id}`) }));
        return ui.section(
          head,
          `${pkg ? `<p class="small">${ui.esc(pkg.why)}${pkg.selfStep ? ` ${ui.esc(pkg.selfStep)}` : ''}</p>` : ''}${ui.rows(steps, 'Nothing checked serves you for this yet. 2-1-1 can help any time.')}${ui.actions([
            { label: 'It is resolved', post: post(`barrier:resolve:${b.need}`), variant: 'primary' },
            ...(b.status === 'open' ? [{ label: 'I am working on it', post: post(`barrier:start:${b.need}`), variant: 'quiet' as const }] : []),
            { label: 'Not today', post: post(`barrier:not-today:${b.need}`), variant: 'quiet' },
          ])}`,
        );
      })
      .join('');
    return `<div class="hello"><h1>Your plan</h1><p class="date">${ui.esc(plan.length ? 'What you told me is hard, and the help that fits, most urgent first. Each stays here until you say it is resolved.' : 'Nothing open. When something gets hard, tell me and I will put a plan here.')}</p></div>
${blocks}
${ui.actions([{ label: 'Something else is hard', href: ctx.u(sid, '/help'), variant: plan.length ? 'quiet' : 'primary' }, { label: 'Explore the whole guide', href: ctx.u(sid, '/guide'), variant: 'quiet' }])}`;
  }

  // Public pages
  app.get('/guide', (c) => c.html(pub('Community resource guide', home(undefined, c.req.query('q') ?? '', PROVIDER_KINDS.includes(c.req.query('kind') as ProviderKind) ? c.req.query('kind')! : ''))));
  app.get('/guide/service/:rid', (c) => {
    const r = a.catalog.find((x) => x.id === c.req.param('rid'));
    return r ? c.html(pub(r.name, servicePage(r))) : c.html(pub('Not found', `<div class="hello"><h1>That place is not in the guide</h1><p><a href="${ctx.base}/guide">The whole guide</a></p></div>`), 404);
  });
  app.get('/guide/:need', (c) => {
    const need = c.req.param('need');
    if (!Object.hasOwn(BARRIER, need)) return c.redirect(`${ctx.base}/guide`);
    const kind = c.req.query('kind') ?? '';
    return c.html(pub(BARRIER[need as NeedCategory]!.label, barrierPage(need as NeedCategory, undefined, PROVIDER_KINDS.includes(kind as ProviderKind) ? kind : '')));
  });

  // The student's guide and plan
  app.get('/s/:id/guide', (c) => c.html(ctx.page(c.req.param('id'), 'Guide', home(c.req.param('id'), c.req.query('q') ?? '', PROVIDER_KINDS.includes(c.req.query('kind') as ProviderKind) ? c.req.query('kind')! : ''), 'help')));
  app.get('/s/:id/guide/:need', (c) => {
    const sid = c.req.param('id');
    const need = c.req.param('need');
    if (!Object.hasOwn(BARRIER, need)) return c.redirect(ctx.u(sid, '/guide'));
    const kind = c.req.query('kind') ?? '';
    return c.html(ctx.page(sid, BARRIER[need as NeedCategory]!.label, barrierPage(need as NeedCategory, sid, PROVIDER_KINDS.includes(kind as ProviderKind) ? kind : ''), 'help'));
  });
  app.get('/s/:id/plan', (c) => c.html(ctx.page(c.req.param('id'), 'Your plan', planPage(c.req.param('id')), 'help')));

  // The public feed
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' };
  app.get('/api/guide/v1/services', (c) => {
    const f = a.guideFeed();
    const barrier = c.req.query('barrier');
    const county = c.req.query('county');
    const kind = c.req.query('kind');
    const services = f.services.filter((s) => (!barrier || s.taxonomy.some((t) => t.barrier === barrier)) && (!county || s.serves.national || s.serves.counties.includes(county)) && (!kind || s.organization.kind === kind));
    return c.json({ ...f, count: services.length, services }, 200, cors);
  });
  app.get('/api/guide/v1/services/:id', (c) => {
    const r = a.catalog.find((x) => x.id === c.req.param('id'));
    return r ? c.json(toFeedService(r, a.dateToday(), a.resourceRecord(r.id)), 200, cors) : c.json({ error: 'not found' }, 404, cors);
  });
  app.get('/api/guide/v1/barriers', (c) => c.json({ domains: DOMAINS.map((d) => ({ id: d, label: DOMAIN_LABEL[d], barriers: BARRIERS.filter((b) => b.domain === d).map((b) => ({ id: b.id, label: b.label, covers: b.covers, services: a.catalog.filter((r) => r.categories.includes(b.id)).length })) })), situations: Object.entries(SITUATION_LABEL).map(([id, label]) => ({ id, label })), provider_kinds: PROVIDER_KINDS.map((k) => ({ id: k, label: PROVIDER_LABEL[k] })) }, 200, cors));
  app.get('/api/guide/v1/coverage', (c) => c.json(a.guideCoverage(), 200, cors));
  app.get('/api/guide/v1/packages', (c) => c.json({ packages: PACKAGES.map((p) => ({ id: p.id, barrier: p.need, title: p.title, why: p.why, self_step: p.selfStep ?? null, services: p.entries })) }, 200, cors));
  app.get('/api/guide/v1/openapi.json', (c) => c.json(guideOpenapi(ctx.base), 200, cors));
  app.get('/api/guide/v1', (c) => c.json({ feed: 'community-resource-guide', license: LICENSE, endpoints: ['services', 'services/{id}', 'barriers', 'packages', 'coverage', 'openapi.json'].map((e) => `${ctx.base}/api/guide/v1/${e}`) }, 200, cors));

  return app;
}

/** The feed's OpenAPI description, with the service schema derived from the same zod schema the feed is checked against. */
const asSchema = (z: Parameters<typeof zodToJsonSchema>[0]) => {
  const { $schema: _drop, ...rest } = zodToJsonSchema(z, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
  return rest as { type: string; properties: Record<string, unknown>; required: string[] };
};
const serviceSchema = () => asSchema(FeedService);
const feedSchema = () => asSchema(Feed);

export function guideOpenapi(base: string) {
  const services = `${base}/api/guide/v1`;
  return {
    openapi: '3.1.0',
    info: { title: 'Community resource guide feed', version: '1.0', description: 'Services that help college students in Montgomery and Greene counties, Ohio, organized by barrier, with each entry\'s source of record and verification. Services, never students. Free to use with attribution.', license: { name: LICENSE.name, url: LICENSE.url } },
    servers: [{ url: services }],
    paths: {
      '/services': { get: { summary: 'Every service, optionally filtered', parameters: [{ name: 'barrier', in: 'query', schema: { type: 'string' } }, { name: 'county', in: 'query', schema: { type: 'string' } }, { name: 'kind', in: 'query', schema: { type: 'string', enum: [...PROVIDER_KINDS] } }], responses: { 200: { description: 'The feed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Feed' } } } } } } },
      '/services/{id}': { get: { summary: 'One service', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The service', content: { 'application/json': { schema: { $ref: '#/components/schemas/Service' } } } }, 404: { description: 'Not in the guide' } } } },
      '/barriers': { get: { summary: 'The barrier taxonomy: domains, barriers, situations and provider kinds', responses: { 200: { description: 'The taxonomy' } } } },
      '/packages': { get: { summary: 'Support packages: the usual combination of help for each barrier', responses: { 200: { description: 'Packages' } } } },
      '/coverage': { get: { summary: 'Current services per barrier and county, and the gaps', responses: { 200: { description: 'Coverage' } } } },
    },
    components: {
      schemas: {
        // Generated from the same schema the feed is checked against in code, so the document cannot drift from it.
        Service: serviceSchema(),
        Feed: { ...feedSchema(), properties: { ...feedSchema().properties, services: { type: 'array', items: { $ref: '#/components/schemas/Service' } } } },
      },
    },
  };
}
