/**
 * The small things that make software feel considerate, each as a tested function rather than a one-off in a
 * screen: snoozing until a time people mean ("tomorrow morning"); bulk edits previewed as a list of exact changes
 * before anything is written; a view (filters, sort, columns) shared as a short signed link; defaults learned from
 * what a person chose before; pasted text recognised as a table, a list of addresses or a link; progress with an
 * honest time left; reading comfort settings as CSS; an answer to "why am I seeing this?"; and "is it me or is it
 * down?" from a check of the service and of the person's own connection.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { instant, wallOf } from '../time/index.ts';
import { parseCsv } from '../tabular/index.ts';

export type When = 'later today' | 'tonight' | 'tomorrow morning' | 'this weekend' | 'next week';

/** The instant someone means, in their zone: mornings are 9:00, evenings 19:00, weekends Saturday 9:00, next week Monday 9:00. */
export function snoozeUntil(when: When, now: Date, tz: string): Date {
  const w = wallOf(now, tz);
  const at = (days: number, h: number) => {
    const d = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
    return instant({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h, min: 0 }, tz);
  };
  switch (when) {
    case 'later today':
      return w.h < 15 ? new Date(now.getTime() + 3 * 3_600_000) : at(0, 19) > now ? at(0, 19) : at(1, 9);
    case 'tonight':
      return w.h < 19 ? at(0, 19) : at(1, 19);
    case 'tomorrow morning':
      return at(1, 9);
    case 'this weekend':
      return w.weekday === 6 || w.weekday === 0 ? at(w.weekday === 6 ? 7 : 6, 9) : at(6 - w.weekday, 9);
    case 'next week':
      return at(((8 - w.weekday) % 7) || 7, 9);
  }
}

export interface Change {
  readonly id: string;
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** What a bulk edit would do, record by record, field by field; records it would not change are listed apart. */
export function preview<T extends { id: string }>(records: readonly T[], edit: (r: T) => Partial<T>, can: (r: T) => boolean = () => true): { changes: Change[]; unchanged: string[]; refused: string[] } {
  const changes: Change[] = [];
  const unchanged: string[] = [];
  const refused: string[] = [];
  for (const r of records) {
    if (!can(r)) {
      refused.push(r.id);
      continue;
    }
    const next = edit(r);
    const diff = Object.entries(next).filter(([k, v]) => JSON.stringify((r as Record<string, unknown>)[k]) !== JSON.stringify(v));
    if (!diff.length) unchanged.push(r.id);
    for (const [field, to] of diff) changes.push({ id: r.id, field, from: (r as Record<string, unknown>)[field], to });
  }
  return { changes, unchanged, refused };
}

/** A view as a short, tamper-evident string for a link. */
export function shareView(view: Readonly<Record<string, unknown>>, secret: string): string {
  const p = Buffer.from(JSON.stringify(view)).toString('base64url');
  return `${p}.${createHmac('sha256', secret).update(p).digest('base64url').slice(0, 16)}`;
}

export function openView(token: string, secret: string): Record<string, unknown> | undefined {
  const [p, sig] = token.split('.');
  if (!p || !sig) return undefined;
  const want = Buffer.from(createHmac('sha256', secret).update(p).digest('base64url').slice(0, 16));
  if (want.length !== Buffer.from(sig).length || !timingSafeEqual(want, Buffer.from(sig))) return undefined;
  try {
    return JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Suggests the value a person most often chose for a field, if they chose it at least `min` times and most recently. */
export function smartDefault(history: readonly unknown[], o: { min?: number; window?: number } = {}): unknown {
  const recent = history.slice(-(o.window ?? 10));
  const counts = new Map<string, { v: unknown; n: number; last: number }>();
  recent.forEach((v, i) => {
    const k = JSON.stringify(v);
    const c = counts.get(k) ?? { v, n: 0, last: 0 };
    c.n++;
    c.last = i;
    counts.set(k, c);
  });
  const best = [...counts.values()].sort((a, b) => b.n - a.n || b.last - a.last)[0];
  return best && best.n >= (o.min ?? 3) ? best.v : undefined;
}

export type Pasted = { readonly kind: 'table'; readonly rows: string[][] } | { readonly kind: 'emails'; readonly emails: string[]; readonly rejected: string[] } | { readonly kind: 'url'; readonly url: string } | { readonly kind: 'text'; readonly text: string };

/** Works out what was pasted: a table (tabs or commas, consistent columns), a list of addresses, a link, or text. */
export function magicPaste(s: string): Pasted {
  const t = s.trim();
  if (/^https?:\/\/\S+$/i.test(t)) {
    try {
      return { kind: 'url', url: new URL(t).href };
    } catch {
      /* not a URL after all */
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  for (const sep of ['\t', ',']) {
    if (lines.length >= 2 && lines.every((l) => l.includes(sep))) {
      const rows = parseCsv(lines.join('\n'), sep);
      if (rows.every((r) => r.length === rows[0]!.length) && rows[0]!.length >= 2 && !rows.flat().every((c) => /@/.test(c))) return { kind: 'table', rows };
    }
  }
  const parts = t.split(/[\s,;]+/).filter(Boolean).map((x) => x.replace(/^<|>$/g, ''));
  const emails = parts.filter((p) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(p));
  if (emails.length >= 1 && emails.length >= parts.length * 0.6) return { kind: 'emails', emails: [...new Set(emails.map((e) => e.toLowerCase()))], rejected: parts.filter((p) => !emails.includes(p)) };
  return { kind: 'text', text: t };
}

/** Progress with a time left that does not jump about: a smoothed rate, and no estimate until there is enough to go on. */
export class Progress {
  private rate?: number;
  private last?: { at: number; done: number };
  private readonly total: number;
  private readonly start: number;
  constructor(total: number, start: number) {
    this.total = total;
    this.start = start;
  }
  update(done: number, at: number): { percent: number; leftSeconds?: number; text: string } {
    if (this.last && at > this.last.at) {
      const r = (done - this.last.done) / (at - this.last.at);
      this.rate = this.rate === undefined ? r : this.rate * 0.7 + r * 0.3;
    }
    this.last = { at, done };
    const percent = Math.min(100, Math.floor((done / this.total) * 100));
    if (done >= this.total) return { percent: 100, leftSeconds: 0, text: 'Done' };
    if (!this.rate || at - this.start < 3000 || done < this.total * 0.02) return { percent, text: `${percent}%, working out the time left` };
    const leftSeconds = Math.ceil((this.total - done) / this.rate / 1000);
    const text = leftSeconds < 10 ? 'a few seconds left' : leftSeconds < 90 ? `about ${Math.round(leftSeconds / 10) * 10} seconds left` : `about ${Math.round(leftSeconds / 60)} minutes left`;
    return { percent, leftSeconds, text: `${percent}%, ${text}` };
  }
}

export interface Comfort {
  readonly size: 'default' | 'large' | 'larger';
  readonly spacing: 'default' | 'relaxed';
  readonly font: 'default' | 'readable';
  readonly motion: 'default' | 'reduced';
  readonly contrast: 'default' | 'more';
}

/** The person's reading settings as CSS custom properties on the root, layered over their system preferences. */
export function comfortCss(c: Comfort): string {
  const v: string[] = [`--text-scale:${{ default: 1, large: 1.125, larger: 1.25 }[c.size]}`, `--line-height:${c.spacing === 'relaxed' ? 1.8 : 1.5}`, `--letter-spacing:${c.spacing === 'relaxed' ? '0.02em' : 'normal'}`];
  if (c.font === 'readable') v.push('--font-body:Atkinson Hyperlegible, Verdana, sans-serif');
  if (c.contrast === 'more') v.push('--text-muted:var(--text)', '--border:var(--text)');
  const motion = c.motion === 'reduced' ? '*,*::before,*::after{animation-duration:0.01ms!important;transition-duration:0.01ms!important;scroll-behavior:auto!important}' : '';
  return `:root{${v.join(';')}}${motion}`;
}

/** Why something was shown, in plain words, from the reasons that put it there. */
export function why(reasons: readonly ({ kind: 'shared'; by: string } | { kind: 'role'; role: string } | { kind: 'flag'; flag: string; because: string } | { kind: 'follows'; what: string } | { kind: 'recent' } | { kind: 'mentioned'; by: string })[]): string {
  if (!reasons.length) return 'Everyone sees this.';
  const say = reasons.map((r) => {
    switch (r.kind) {
      case 'shared':
        return `${r.by} shared it with you`;
      case 'role':
        return `you are ${/^[aeiou]/i.test(r.role) ? 'an' : 'a'} ${r.role}`;
      case 'flag':
        return `you are in the early group for ${r.flag} (${r.because})`;
      case 'follows':
        return `you follow ${r.what}`;
      case 'recent':
        return 'you opened it recently';
      case 'mentioned':
        return `${r.by} mentioned you`;
    }
  });
  return `You are seeing this because ${say.length === 1 ? say[0] : `${say.slice(0, -1).join(', ')} and ${say.at(-1)}`}.`;
}

/** Is it me or is it down? From the service's own status and a probe of a known-good outside address. */
export function meOrDown(o: { service: 'ok' | 'degraded' | 'down' | 'unreachable'; internet: boolean; incident?: string }): { who: 'you' | 'us' | 'nobody'; say: string } {
  if (!o.internet) return { who: 'you', say: 'Your device seems to be offline. Check your Wi-Fi or network; your changes are kept and will be sent when you are back.' };
  if (o.service === 'down' || o.service === 'degraded') return { who: 'us', say: `It is us, not you${o.incident ? `: ${o.incident}` : ''}. We are working on it; you do not need to do anything.` };
  if (o.service === 'unreachable') return { who: 'you', say: 'Your internet works, but our service cannot be reached from your network. A firewall or VPN may be blocking it.' };
  return { who: 'nobody', say: 'Everything looks fine on our side and yours. Try reloading the page; if it still fails, report the problem and we will look.' };
}
