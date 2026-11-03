// Verifies docs/testing/exploration.md (the feature walk: every page, link and form, for every student).
import { explore, type ExploreReport } from '@zthr/explore';
import { Hono } from 'hono';
import { Advocate } from '../../src/agents/advocate.js';
import { createApp } from '../../src/server/app.js';
import { PERSONAS, PERSONA_NAMES } from '../../src/server/demo.js';
import { DAY, signature as stateSignature, stateParts, type World } from './world.js';

/**
 * The feature walk: the web app driven the way a person drives it, by following every link and submitting every
 * form on every page, for every student, until no new page in no new state is left. Each page is checked as HTML
 * a browser and a screen reader will get, not as data.
 */
export const BASE = '/advocate';

export interface Page {
  status: number;
  url: string;
  html: string;
}

export interface CrawlWorld extends World {
  app: Hono;
  page?: Page;
}

/** Sample values a person would type into each field. */
const SAMPLE: Record<string, string> = {
  text: 'I need food',
  course: 'HIS 1101',
  size: '3',
  income: '1800',
  work: '20',
  body: 'I need help with my electric bill',
};
const sampleFor = (url: string, name: string): string =>
  url.endsWith('/syllabus') && name === 'text' ? 'Nov 20 Paper 1 due\nDec 4 Final exam' : url.endsWith('/letter') && name === 'text' ? 'Montgomery County Job and Family Services. Your interview is scheduled for Nov 18. Call (937) 225-4148.' : url.endsWith('/shifts') && name === 'text' ? 'Tue 3pm-9pm, Thu 4-10pm' : (SAMPLE[name] ?? 'test');

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]?.replace(/&amp;/g, '&');

/** Every link and form on a page, as replayable actions: "GET url" or "POST url body". */
export function pageActions(p: Page): string[] {
  const out: string[] = [];
  for (const m of p.html.matchAll(/<a\s[^>]*>/g)) {
    const href = attr(m[0], 'href');
    if (!href || !href.startsWith(BASE) || href.includes('/export') || href.endsWith('.ics') || href.includes('/_ui/')) continue;
    out.push(`GET ${href.split('#')[0]}`);
  }
  for (const m of p.html.matchAll(/<form\s[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/g)) {
    const url = attr(m[0].slice(0, m[0].indexOf('>') + 1), 'action');
    if (!url) continue;
    const fields = new URLSearchParams();
    for (const i of m[1]!.matchAll(/<(input|textarea)\s[^>]*>/g)) {
      const name = attr(i[0], 'name');
      if (!name) continue;
      const type = attr(i[0], 'type');
      fields.set(name, type === 'hidden' ? (attr(i[0], 'value') ?? '') : sampleFor(url, name));
    }
    out.push(`POST ${url} ${fields.toString()}`);
  }
  return out;
}

export async function request(w: CrawlWorld, action: string): Promise<Page> {
  const [method, url, body] = action.split(' ') as ['GET' | 'POST', string, string | undefined];
  let res = await w.app.request(url, method === 'POST' ? { method, body: body ?? '', headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {});
  let at = url;
  for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 5; hops++) {
    at = res.headers.get('location')!;
    res = await w.app.request(at);
  }
  return { status: res.status, url: at, html: await res.text() };
}

const visibleText = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** What a person and a screen reader need from every page. */
export function pageProblems(p: Page, others: string[]): string[] {
  const problems: string[] = [];
  if (p.status !== 200) problems.push(`status ${p.status} at ${p.url}`);
  if (!/<title>[^<]+<\/title>/.test(p.html)) problems.push('no page title');
  if ((p.html.match(/<h1[\s>]/g) ?? []).length !== 1) problems.push(`expected one h1, found ${(p.html.match(/<h1[\s>]/g) ?? []).length}`);
  if (!/<main\s/.test(p.html)) problems.push('no main landmark');
  const text = visibleText(p.html);
  for (const bad of ['undefined', 'NaN', '[object Object]', '${', 'null']) if (new RegExp(`(^|\\W)${bad.replace(/[[\]${}]/g, '\\$&')}(\\W|$)`).test(text)) problems.push(`shows "${bad}"`);
  for (const i of p.html.matchAll(/<(input|textarea|select)\s[^>]*>/g)) {
    if (/type="hidden"/.test(i[0])) continue;
    const id = attr(i[0], 'id');
    if (!id || !p.html.includes(`for="${id}"`)) problems.push(`a ${i[1]} has no label`);
  }
  for (const b of p.html.matchAll(/<(button|a)\s[^>]*>([\s\S]*?)<\/\1>/g)) if (!visibleText(b[2]!).trim() && !/aria-label="[^"]+"/.test(b[0])) problems.push(`a ${b[1]} has no name`);
  for (const n of others) if (new RegExp(`\\b${n}\\b`).test(text)) problems.push(`another student's name appears: ${n}`);
  if (text.includes('synthetic sealed fact')) problems.push('a sealed fact appears on a page');
  if (/still being built|not available right now/i.test(text)) problems.push('a dead-end message appears');
  return problems;
}

export const route = (url: string) => url.replace(/\?.*$/, '').replace(/\/s\/[^/]+/, '/s/:id').replace(/\/resource\/[^/?]+/, '/resource/:rid');

/** Settings are independent switches: the main walk sets them through seeds, and the settings walk covers every combination. */
export const SETTINGS_ACTION = /action=(dial|source-on|source-off|pulses-on|pulses-off)%3A?/;

export async function crawlAdvocate(opts: { only?: string[]; maxNodes?: number; settingsOnly?: boolean } = {}): Promise<ExploreReport & { routes: string[] }> {
  const routes = new Set<string>();
  const merged: ExploreReport & { routes: string[] } = { seeds: [], states: 0, transitions: 0, actionsSeen: [], verbsSeen: {}, violations: [], exhausted: true, routes: [] };
  const seeds = PERSONA_NAMES.filter((n) => !opts.only || opts.only.includes(n)).flatMap((n) => (opts.settingsOnly ? [[n, 'own']] : [[n, 'own'], [n, 'brief'], [n, 'walk-me-through']]) as [string, string][]);
  for (const [name, dial] of seeds) {
    const others = PERSONA_NAMES.filter((n) => n !== name);
    const make = (): CrawlWorld => {
      const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`) });
      const s = PERSONAS[name]!(a);
      if (dial !== 'own') a.setDial(s.id, { depth: dial as 'brief' | 'walk-me-through' });
      return { a, sid: s.id, app: new Hono({ strict: false }).route(BASE, createApp(a, { base: BASE })) as unknown as Hono };
    };
    // explore() is synchronous, so the walk runs breadth-first here with the same rules, awaiting each request.
    const seen = new Set<string>();
    const queue: string[][] = [[`GET ${BASE}/s/${name.toLowerCase()}${opts.settingsOnly ? '/you' : ''}`]];
    let transitions = 0;
    let depth = 0;
    const replay = async (path: string[]) => {
      const w = make();
      for (const act of path) {
        w.page = await request(w, act);
        if (act.includes('action=delete-account')) w.deleted = true;
      }
      return w;
    };
    while (queue.length && seen.size < (opts.maxNodes ?? 4000)) {
      const path = queue.shift()!;
      const w = await replay(path);
      const page = w.page!;
      routes.add(route(page.url));
      for (const problem of pageProblems(page, others)) merged.violations.push({ seed: name, path, problem });
      if (w.deleted) continue;
      const sig = `${route(page.url)}|${stateSignature(w, undefined)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (process.env.DEBUG_SIG) console.log(route(page.url), JSON.stringify(stateParts(w)));
      depth = Math.max(depth, path.length);
      const acts = [...new Set(pageActions(page))].filter((x) => (opts.settingsOnly ? x.startsWith('POST') && SETTINGS_ACTION.test(x) : !SETTINGS_ACTION.test(x)));
      for (const act of acts) {
        transitions++;
        merged.verbsSeen[act.split(' ')[0]!] = (merged.verbsSeen[act.split(' ')[0]!] ?? 0) + 1;
        queue.push([...path, act]);
      }
    }
    const exhausted = queue.length === 0;
    merged.seeds.push({ name: dial === 'own' ? name : `${name}/${dial}`, states: seen.size, transitions, maxDepth: depth, exhausted });
    merged.states += seen.size;
    merged.transitions += transitions;
    merged.exhausted &&= exhausted;
  }
  merged.routes = [...routes].sort();
  void explore;
  return merged;
}
