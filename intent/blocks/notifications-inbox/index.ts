/**
 * The in-app notification inbox: the list a person opens from the bell. Each person has their own inbox; an item
 * has an app, a kind, a title and body (plain text, control characters removed, length capped, never HTML), an
 * optional deep link, optional action buttons, and a group key. Items with the same group key collapse into one
 * line with a count ("5 people commented on Budget") that shows the newest and is unread while any member is.
 * An item added again with the same dedupe key inside the dedupe window bumps the existing one instead of piling
 * up. Deep links and action links are checked when the item is added: a path on this site ("/docs/7") or https to
 * a host the site lists; anything else (javascript:, data:, protocol-relative, backslashes, userinfo) is refused,
 * so an inbox item can never carry a script into the click. Reading: mark one, many, a group, an app or all as
 * read; unread counts per app for the badge; archive and restore; acting on an item marks it read and hands back
 * the link. Retention is a cap per person and an age limit with unread items kept longer; paging uses opaque
 * cursors that stay stable while items arrive. Digests render a template (the notify block's render, which refuses
 * a missing value and escapes HTML) over what was unread since a time. Clock and ids are arguments.
 *
 * Out of scope: delivery to other channels and preferences (see notify), real-time push to the browser (a change
 * callback is provided for the caller to forward), and storage (this holds an in-memory index; the caller persists
 * `export()` output).
 */
import { render } from '../notify/index.ts';

export class InboxError extends Error {}

export interface Action {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export interface NewItem {
  readonly app: string;
  readonly kind: string;
  readonly title: string;
  readonly body?: string;
  readonly link?: string;
  readonly actions?: readonly Action[];
  readonly groupKey?: string;
  readonly dedupeKey?: string;
  readonly actor?: string;
  /** Epoch ms after which the item goes away whether read or not. */
  readonly expiresAt?: number;
}

export interface Item {
  readonly id: string;
  readonly person: string;
  readonly app: string;
  readonly kind: string;
  title: string;
  body: string;
  link: string | undefined;
  actions: Action[];
  readonly groupKey: string | undefined;
  readonly dedupeKey: string | undefined;
  actors: string[];
  readonly createdAt: number;
  /** Moves forward when the item is bumped by a duplicate. */
  updatedAt: number;
  bumps: number;
  readAt: number | undefined;
  archivedAt: number | undefined;
  readonly expiresAt: number | undefined;
}

export interface Group {
  readonly key: string;
  readonly count: number;
  readonly unread: number;
  readonly latest: Item;
  readonly ids: readonly string[];
}

export interface Page<T> {
  readonly items: T[];
  readonly next: string | undefined;
}

export interface InboxOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Hosts a link may point at over https. */
  readonly hosts?: readonly string[];
  readonly maxItems?: number;
  readonly maxAgeMs?: number;
  readonly maxUnreadAgeMs?: number;
  readonly dedupeWindowMs?: number;
  readonly maxActions?: number;
  readonly onChange?: (person: string, unread: number) => void;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f‪-‮⁦-⁩]/g;

function clean(s: string, max: number, what: string): string {
  const out = s.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  if (out.length > max) throw new InboxError(`${what} is longer than ${max} characters`);
  return out;
}

export function safeLink(link: string, hosts: readonly string[]): string {
  if (link.length > 2000 || /[\u0000-\u001f\u007f\\\s]/.test(link)) throw new InboxError('the link is not allowed');
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new InboxError('the link is not allowed');
  }
  if (u.protocol !== 'https:' || u.username || u.password || !hosts.includes(u.hostname.toLowerCase())) throw new InboxError('the link is not allowed');
  return u.href;
}

function cursorOf(i: Item): string {
  return Buffer.from(`${i.updatedAt}:${i.id}`).toString('base64url');
}

function readCursor(c: string): [number, string] {
  const s = Buffer.from(c, 'base64url').toString();
  const m = /^(\d{1,16}):(.{1,100})$/s.exec(s);
  if (!m) throw new InboxError('the cursor is not valid');
  return [Number(m[1]), m[2]!];
}

const newer = (a: Item, b: Item) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export interface ListOptions {
  readonly app?: string;
  readonly unread?: boolean;
  readonly archived?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export class Inbox {
  private readonly boxes = new Map<string, Map<string, Item>>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly o: Required<Omit<InboxOptions, 'now' | 'newId' | 'onChange' | 'hosts'>>;
  private readonly hosts: readonly string[];
  private readonly onChange: ((person: string, unread: number) => void) | undefined;
  private seq = 0;

  constructor(o: InboxOptions = {}) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => `n${++this.seq}`);
    this.hosts = (o.hosts ?? []).map((h) => h.toLowerCase());
    this.onChange = o.onChange;
    this.o = { maxItems: o.maxItems ?? 500, maxAgeMs: o.maxAgeMs ?? 90 * 86_400_000, maxUnreadAgeMs: o.maxUnreadAgeMs ?? 365 * 86_400_000, dedupeWindowMs: o.dedupeWindowMs ?? 3_600_000, maxActions: o.maxActions ?? 3 };
  }

  private box(person: string): Map<string, Item> {
    if (!person) throw new InboxError('whose inbox?');
    let b = this.boxes.get(person);
    if (!b) this.boxes.set(person, (b = new Map()));
    return b;
  }

  private changed(person: string) {
    this.onChange?.(person, this.unreadCount(person).total);
  }

  add(person: string, input: NewItem): Item {
    const box = this.box(person);
    const t = this.now();
    if (!/^[a-z][a-z0-9._-]{0,39}$/.test(input.app) || !/^[a-z][a-z0-9._-]{0,59}$/.test(input.kind)) throw new InboxError('app and kind are short lowercase names');
    const title = clean(input.title, 200, 'the title');
    if (!title) throw new InboxError('a notification needs a title');
    const body = clean(input.body ?? '', 2000, 'the body');
    const link = input.link === undefined ? undefined : safeLink(input.link, this.hosts);
    if ((input.actions?.length ?? 0) > this.o.maxActions) throw new InboxError(`at most ${this.o.maxActions} actions`);
    const actions = (input.actions ?? []).map((a) => {
      if (!/^[a-z][a-z0-9_-]{0,29}$/.test(a.id)) throw new InboxError('an action id is a short lowercase name');
      return { id: a.id, label: clean(a.label, 40, 'an action label'), url: safeLink(a.url, this.hosts) };
    });
    if (new Set(actions.map((a) => a.id)).size !== actions.length) throw new InboxError('action ids must differ');
    if (input.groupKey !== undefined && (!input.groupKey || input.groupKey.length > 200)) throw new InboxError('a group key is 1 to 200 characters');
    this.expire(person);
    if (input.dedupeKey !== undefined) {
      for (const i of box.values()) {
        if (i.dedupeKey === input.dedupeKey && i.app === input.app && i.archivedAt === undefined && t - i.updatedAt <= this.o.dedupeWindowMs) {
          i.title = title;
          i.body = body;
          i.link = link;
          i.actions = actions;
          i.updatedAt = t;
          i.bumps++;
          i.readAt = undefined;
          if (input.actor && !i.actors.includes(input.actor)) i.actors.push(input.actor);
          this.changed(person);
          return i;
        }
      }
    }
    const item: Item = { id: this.newId(), person, app: input.app, kind: input.kind, title, body, link, actions, groupKey: input.groupKey, dedupeKey: input.dedupeKey, actors: input.actor ? [input.actor] : [], createdAt: t, updatedAt: t, bumps: 0, readAt: undefined, archivedAt: undefined, expiresAt: input.expiresAt };
    box.set(item.id, item);
    this.trim(person);
    this.changed(person);
    return item;
  }

  get(person: string, id: string): Item | undefined {
    return this.boxes.get(person)?.get(id);
  }

  private must(person: string, id: string): Item {
    const i = this.get(person, id);
    if (!i) throw new InboxError(`no notification ${id}`);
    return i;
  }

  private trim(person: string) {
    const box = this.box(person);
    if (box.size <= this.o.maxItems) return;
    // read and archived go first, oldest first; unread go only when nothing else is left
    const order = [...box.values()].sort((a, b) => Number(a.readAt === undefined && a.archivedAt === undefined) - Number(b.readAt === undefined && b.archivedAt === undefined) || a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1));
    for (const i of order) {
      if (box.size <= this.o.maxItems) break;
      box.delete(i.id);
    }
  }

  /** Removes what has expired or aged out. Returns how many items went. */
  expire(person: string): number {
    const box = this.boxes.get(person);
    if (!box) return 0;
    const t = this.now();
    let n = 0;
    for (const i of [...box.values()]) {
      const age = t - i.updatedAt;
      const gone = (i.expiresAt !== undefined && i.expiresAt <= t) || age > (i.readAt === undefined ? this.o.maxUnreadAgeMs : this.o.maxAgeMs);
      if (gone) (box.delete(i.id), n++);
    }
    return n;
  }

  list(person: string, o: ListOptions = {}): Page<Item> {
    this.expire(person);
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100);
    let all = [...(this.boxes.get(person)?.values() ?? [])].filter((i) => (o.archived ? i.archivedAt !== undefined : i.archivedAt === undefined)).filter((i) => (o.app ? i.app === o.app : true)).filter((i) => (o.unread ? i.readAt === undefined : true)).sort(newer);
    if (o.cursor !== undefined) {
      const [at, id] = readCursor(o.cursor);
      all = all.filter((i) => i.updatedAt < at || (i.updatedAt === at && i.id < id));
    }
    const items = all.slice(0, limit);
    return { items, next: all.length > limit ? cursorOf(items[items.length - 1]!) : undefined };
  }

  /** Items with a group key collapse into one entry; items without stand alone. Newest group first. */
  groups(person: string, o: { app?: string; archived?: boolean } = {}): Group[] {
    const all = this.list(person, { ...o, limit: 100 });
    let items = all.items;
    let next = all.next;
    while (next) {
      const p = this.list(person, { ...o, limit: 100, cursor: next });
      items = items.concat(p.items);
      next = p.next;
    }
    const by = new Map<string, Item[]>();
    for (const i of items) {
      const k = i.groupKey === undefined ? `\u0000${i.id}` : `${i.app}\u0000${i.groupKey}`;
      by.set(k, [...(by.get(k) ?? []), i]);
    }
    return [...by.entries()].map(([k, m]) => ({ key: k.startsWith('\u0000') ? m[0]!.id : m[0]!.groupKey!, count: m.length, unread: m.filter((i) => i.readAt === undefined).length, latest: m[0]!, ids: m.map((i) => i.id) })).sort((a, b) => newer(a.latest, b.latest));
  }

  unreadCount(person: string): { total: number; byApp: Record<string, number> } {
    this.expire(person);
    const byApp: Record<string, number> = {};
    let total = 0;
    for (const i of this.boxes.get(person)?.values() ?? []) {
      if (i.readAt !== undefined || i.archivedAt !== undefined) continue;
      total++;
      byApp[i.app] = (byApp[i.app] ?? 0) + 1;
    }
    return { total, byApp };
  }

  private setRead(person: string, items: Iterable<Item>, read: boolean): number {
    let n = 0;
    const t = this.now();
    for (const i of items)
      if ((i.readAt === undefined) === read) {
        i.readAt = read ? t : undefined;
        n++;
      }
    if (n) this.changed(person);
    return n;
  }

  /** Marks the listed items read (or unread). Ids that are not this person's are an error and change nothing. */
  markRead(person: string, ids: readonly string[], read = true): number {
    const items = ids.map((id) => this.must(person, id));
    return this.setRead(person, items, read);
  }

  markGroupRead(person: string, app: string, groupKey: string): number {
    return this.setRead(person, [...(this.boxes.get(person)?.values() ?? [])].filter((i) => i.app === app && i.groupKey === groupKey), true);
  }

  markAllRead(person: string, app?: string): number {
    return this.setRead(person, [...(this.boxes.get(person)?.values() ?? [])].filter((i) => (app ? i.app === app : true) && i.archivedAt === undefined), true);
  }

  archive(person: string, id: string, on = true): Item {
    const i = this.must(person, id);
    i.archivedAt = on ? this.now() : undefined;
    if (on && i.readAt === undefined) i.readAt = this.now();
    this.changed(person);
    return i;
  }

  delete(person: string, id: string): void {
    this.must(person, id);
    this.boxes.get(person)!.delete(id);
    this.changed(person);
  }

  /** Acts on an item: marks it read and returns where the click goes (an action's link, or the item's own). */
  act(person: string, id: string, actionId?: string): string | undefined {
    const i = this.must(person, id);
    let url = i.link;
    if (actionId !== undefined) {
      const a = i.actions.find((x) => x.id === actionId);
      if (!a) throw new InboxError(`no action ${actionId} on this notification`);
      url = a.url;
    }
    this.setRead(person, [i], true);
    return url;
  }

  /** A digest of what has been unread since a time: subject and text filled from the templates. */
  digest(person: string, since: number, t: { subject: string; line: string; empty?: string }, values: Readonly<Record<string, string | number>> = {}): { subject: string; text: string; count: number } | undefined {
    const items = [...(this.boxes.get(person)?.values() ?? [])].filter((i) => i.readAt === undefined && i.archivedAt === undefined && i.updatedAt >= since).sort(newer);
    if (items.length === 0 && t.empty === undefined) return undefined;
    const text = items.length === 0 ? render(t.empty!, values, false) : items.map((i) => render(t.line, { ...values, app: i.app, title: i.title, body: i.body, count: i.bumps + 1 }, false)).join('\n');
    return { subject: render(t.subject, { ...values, count: items.length }, false), text, count: items.length };
  }

  /** Items as plain data, for the caller to keep. */
  export(person: string): Item[] {
    return [...(this.boxes.get(person)?.values() ?? [])].sort(newer);
  }

  import(person: string, items: readonly Item[]): void {
    const box = this.box(person);
    for (const i of items) if (i.person === person) box.set(i.id, { ...i, actions: [...i.actions], actors: [...i.actors] });
    this.trim(person);
  }
}
