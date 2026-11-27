/**
 * The registry of every screen a product has. Each surface declares what it is for, who it is for, its help text,
 * and what it shows while loading, when empty and on error, so no screen ships with a blank state or a stack
 * trace. The same registry drives contextual help ("explain this screen"), the first-run checklist, "what's new"
 * notes shown once to each person, and friendly error pages that say what happened and what to do next.
 */

export interface Surface {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly purpose: string;
  readonly audience: readonly string[];
  readonly help: string;
  readonly states: { readonly loading: string; readonly empty: { readonly text: string; readonly action?: string }; readonly error: string };
  readonly owner: string;
}

export interface News {
  readonly id: string;
  readonly date: string;
  readonly title: string;
  readonly body: string;
  readonly surfaces?: readonly string[];
  readonly audience?: readonly string[];
}

export interface Step {
  readonly id: string;
  readonly title: string;
  readonly surface: string;
  readonly done: (who: string) => boolean;
}

export function check(list: readonly Surface[]): string[] {
  const out: string[] = [];
  const paths = new Map<string, string>();
  for (const s of list) {
    if (paths.has(s.path)) out.push(`${s.id}: ${s.path} is also ${paths.get(s.path)}`);
    paths.set(s.path, s.id);
    if (s.purpose.trim().length < 20) out.push(`${s.id}: say what the screen is for in a sentence`);
    if (!s.help.trim()) out.push(`${s.id}: no help text`);
    if (!s.states.loading.trim() || !s.states.empty.text.trim() || !s.states.error.trim()) out.push(`${s.id}: every state needs words: loading, empty and error`);
    if (/exception|stack|null|undefined|error code/i.test(s.states.error)) out.push(`${s.id}: the error state reads like a developer message`);
    if (!s.audience.length) out.push(`${s.id}: who is it for?`);
  }
  return out;
}

export class Surfaces {
  private readonly list = new Map<string, Surface>();
  private readonly news: News[] = [];
  private readonly seen = new Map<string, Set<string>>();
  private readonly steps: Step[] = [];

  constructor(list: readonly Surface[], o: { news?: readonly News[]; steps?: readonly Step[] } = {}) {
    const p = check(list);
    if (p.length) throw new Error(p.join('; '));
    for (const s of list) this.list.set(s.id, s);
    this.news.push(...(o.news ?? []));
    this.steps.push(...(o.steps ?? []));
    for (const st of this.steps) if (!this.list.has(st.surface)) throw new Error(`step ${st.id} points at unknown surface ${st.surface}`);
  }

  get(id: string): Surface | undefined {
    return this.list.get(id);
  }

  forPath(path: string): Surface | undefined {
    for (const s of this.list.values()) {
      const re = new RegExp(`^${s.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\:\w+|:\w+/g, '[^/]+')}$`);
      if (re.test(path)) return s;
    }
    return undefined;
  }

  /** What "explain this screen" shows. */
  explain(id: string, roles: readonly string[]): { title: string; purpose: string; help: string; forYou: boolean } | undefined {
    const s = this.list.get(id);
    return s && { title: s.title, purpose: s.purpose, help: s.help, forYou: s.audience.some((a) => roles.includes(a) || a === 'everyone') };
  }

  /** News this person has not seen, for this surface (or general), for their roles; newest first. */
  whatsNew(who: string, roles: readonly string[], surface?: string): News[] {
    const seen = this.seen.get(who) ?? new Set();
    return this.news.filter((n) => !seen.has(n.id) && (!n.audience || n.audience.some((a) => roles.includes(a))) && (!n.surfaces || (surface !== undefined && n.surfaces.includes(surface)))).sort((a, b) => b.date.localeCompare(a.date));
  }

  markSeen(who: string, ids: readonly string[]): void {
    const s = this.seen.get(who) ?? new Set();
    for (const id of ids) s.add(id);
    this.seen.set(who, s);
  }

  firstRun(who: string): { steps: { id: string; title: string; path: string; done: boolean }[]; complete: boolean } {
    const steps = this.steps.map((s) => ({ id: s.id, title: s.title, path: this.list.get(s.surface)!.path, done: s.done(who) }));
    return { steps, complete: steps.every((s) => s.done) };
  }
}

/** A friendly error page for a status: what happened, what to do, and a reference to quote. */
export function errorPage(status: number, ref: string, o: { home?: string; statusPage?: string } = {}): { title: string; body: string; actions: { label: string; href: string }[] } {
  const home = { label: 'Go to the home page', href: o.home ?? '/' };
  const status_ = o.statusPage ? [{ label: 'Check service status', href: o.statusPage }] : [];
  const pages: Record<number, { title: string; body: string; actions: { label: string; href: string }[] }> = {
    400: { title: 'That request did not make sense', body: 'Something in the link or form was not in the form we expect. Go back and try again.', actions: [home] },
    401: { title: 'Sign in to continue', body: 'This page needs you to be signed in.', actions: [{ label: 'Sign in', href: '/login' }] },
    403: { title: 'You do not have access to this', body: 'If you think you should, ask the person who shared it or your administrator.', actions: [home] },
    404: { title: 'We cannot find that page', body: 'It may have moved or been deleted. Check the link, or start from the home page.', actions: [home] },
    409: { title: 'Someone else changed this', body: 'Reload to see the latest version. Your changes are kept as a draft.', actions: [home] },
    413: { title: 'That is too large', body: 'Try a smaller file, or upload it in parts.', actions: [home] },
    429: { title: 'Too many requests at once', body: 'Wait a moment and try again.', actions: [home] },
    503: { title: 'We are down for maintenance', body: 'We will be back shortly.', actions: [...status_, home] },
  };
  const p = pages[status] ?? (status >= 500 ? { title: 'Something went wrong on our side', body: 'It is not something you did. Try again in a moment; if it keeps happening, tell us and quote the reference below.', actions: [...status_, home] } : pages[400]!);
  return { ...p, body: `${p.body} Reference: ${ref}.` };
}
