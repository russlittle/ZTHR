/**
 * Comments and messages on any record: threads with replies, @mentions resolved to people (and only people who
 * can see the record), edits that keep what was said before, deletion that leaves a marker so a thread still reads,
 * reactions, resolving a thread, and unread counts per person. Comment text is stored as written and escaped
 * where it is shown, so it can never run as markup.
 */

export interface Comment {
  readonly id: number;
  readonly on: string;
  readonly by: string;
  readonly parent?: number;
  text: string;
  readonly at: string;
  edits: { text: string; at: string }[];
  deleted?: string;
  mentions: string[];
  reactions: Record<string, string[]>;
  resolved?: { by: string; at: string };
}

export interface CommentsOptions {
  /** Looks a handle up; undefined for nobody. */
  readonly person: (handle: string) => string | undefined;
  readonly canSee: (who: string, record: string) => boolean;
  readonly onMention?: (who: string, c: Comment) => void;
  readonly now?: () => Date;
  readonly maxLength?: number;
}

export class Comments {
  private readonly list: Comment[] = [];
  private readonly read = new Map<string, number>();
  private readonly o: CommentsOptions & { now: () => Date; maxLength: number };

  constructor(o: CommentsOptions) {
    this.o = { now: () => new Date(), maxLength: 10_000, ...o };
  }

  private mentionsIn(text: string, record: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(/(?:^|[^\w@])@([a-zA-Z0-9_.-]{2,40})/g)) {
      const who = this.o.person(m[1]!);
      if (who && this.o.canSee(who, record)) out.add(who);
    }
    return [...out];
  }

  post(by: string, on: string, text: string, parent?: number): Comment {
    if (!this.o.canSee(by, on)) throw new Error('you cannot see this record');
    const t = text.trim();
    if (!t) throw new Error('a comment needs some text');
    if (t.length > this.o.maxLength) throw new Error(`a comment can be at most ${this.o.maxLength} characters`);
    if (parent !== undefined) {
      const p = this.get(parent);
      if (p.on !== on) throw new Error('a reply belongs on the same record');
      if (p.parent !== undefined) parent = p.parent;
    }
    const c: Comment = { id: this.list.length + 1, on, by, ...(parent !== undefined ? { parent } : {}), text: t, at: this.o.now().toISOString(), edits: [], mentions: this.mentionsIn(t, on), reactions: {} };
    this.list.push(c);
    for (const who of c.mentions) if (who !== by) this.o.onMention?.(who, c);
    return c;
  }

  get(id: number): Comment {
    const c = this.list[id - 1];
    if (!c) throw new Error(`no comment ${id}`);
    return c;
  }

  edit(by: string, id: number, text: string): Comment {
    const c = this.get(id);
    if (c.by !== by) throw new Error('only the author can edit a comment');
    if (c.deleted) throw new Error('this comment was deleted');
    c.edits.push({ text: c.text, at: this.o.now().toISOString() });
    c.text = text.trim();
    const before = new Set(c.mentions);
    c.mentions = this.mentionsIn(c.text, c.on);
    for (const who of c.mentions) if (!before.has(who) && who !== by) this.o.onMention?.(who, c);
    return c;
  }

  remove(by: string, id: number, moderator = false): void {
    const c = this.get(id);
    if (c.by !== by && !moderator) throw new Error('only the author or a moderator can delete a comment');
    c.deleted = moderator && c.by !== by ? 'removed by a moderator' : 'deleted by its author';
    c.text = '';
    c.edits = [];
  }

  react(who: string, id: number, emoji: string): void {
    const c = this.get(id);
    const l = (c.reactions[emoji] ??= []);
    const i = l.indexOf(who);
    if (i >= 0) l.splice(i, 1);
    else l.push(who);
    if (!l.length) delete c.reactions[emoji];
  }

  resolve(who: string, id: number): void {
    const c = this.get(id);
    if (c.parent !== undefined) throw new Error('resolve the thread, not a reply');
    c.resolved = { by: who, at: this.o.now().toISOString() };
  }

  /** Threads on a record, oldest first, each with its replies. */
  threads(on: string, o: { includeResolved?: boolean } = {}): { comment: Comment; replies: Comment[] }[] {
    const here = this.list.filter((c) => c.on === on);
    return here.filter((c) => c.parent === undefined && (o.includeResolved || !c.resolved)).map((comment) => ({ comment, replies: here.filter((r) => r.parent === comment.id) }));
  }

  markRead(who: string, on: string): void {
    const last = this.list.filter((c) => c.on === on).at(-1);
    if (last) this.read.set(`${who}\n${on}`, last.id);
  }

  unread(who: string, on: string): number {
    const seen = this.read.get(`${who}\n${on}`) ?? 0;
    return this.list.filter((c) => c.on === on && c.id > seen && c.by !== who && !c.deleted).length;
  }
}

/** For showing: escaped text with mentions as links. */
export function display(c: Comment, profileUrl: (who: string) => string, name: (who: string) => string): string {
  if (c.deleted) return `<em>${c.deleted}</em>`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  let html = esc(c.text);
  for (const who of c.mentions) html = html.replaceAll(`@${esc(name(who))}`, `<a href="${esc(profileUrl(who))}">@${esc(name(who))}</a>`);
  return html;
}
