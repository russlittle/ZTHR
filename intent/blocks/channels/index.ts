/**
 * Team chat channels built on the comments and events blocks. A channel is public (anyone may find and join it),
 * private (members only, joined by invitation) or direct (exactly two people, made once per pair and never
 * joined, left or extended). Members have a role (owner, admin, member); the last owner cannot leave without
 * handing over. Messages are comments on the channel's record, so only members can post or be mentioned, a reply
 * joins its thread (one level, as the comments block does), and edits and deletes keep the comments block's rules;
 * admins may delete anyone's message. Posting returns who should be told and why: a direct message, an @name
 * mention (only of members), @channel (everyone, restricted to a minimum role if the channel says so), @here
 * (members the caller reports as active now) and replies in a thread you took part in. A member who muted the
 * channel hears only direct mentions. Read markers are kept per member and give unread and mention counts.
 * Pins are limited per channel. A retention window hides older messages from every read. Channel names are
 * lower-case and unique; archived channels are read-only. Each change can be published as a CloudEvent through
 * the events block's catalogue and hub (`eventTypes` lists what to register). Clock and ids are arguments.
 *
 * Out of scope: group direct messages, files and link previews, search across messages, typing indicators (see the
 * Presence class in events), and physically deleting messages past retention (the comments block keeps its rows;
 * the window only hides them), and delivery of the notices (see notify and notifications-inbox).
 */
import { Comments } from '../comments/index.ts';
import type { Comment } from '../comments/index.ts';
import type { Catalogue, EventType, Hub } from '../events/index.ts';

export class ChannelError extends Error {}

export type Kind = 'public' | 'private' | 'direct';
export type Role = 'owner' | 'admin' | 'member';
const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export interface Member {
  readonly who: string;
  role: Role;
  readonly joinedAt: number;
  muted: boolean;
  /** Id of the last message read; 0 for none. */
  lastRead: number;
}

export interface Channel {
  readonly id: string;
  readonly kind: Kind;
  name: string;
  topic: string;
  readonly createdBy: string;
  readonly createdAt: number;
  archived: boolean;
  members: Map<string, Member>;
  pins: number[];
  /** Messages older than this many days are hidden from reads. */
  retentionDays: number | undefined;
  /** Who may use @channel and @here. */
  broadcastRole: Role;
}

export interface Message {
  readonly id: number;
  readonly channel: string;
  readonly by: string;
  readonly text: string;
  readonly at: string;
  readonly edited: boolean;
  readonly deleted: string | undefined;
  readonly thread: number | undefined;
  readonly mentions: readonly string[];
  readonly reactions: Readonly<Record<string, readonly string[]>>;
  readonly pinned: boolean;
}

export interface Notice {
  readonly who: string;
  readonly reason: 'direct' | 'mention' | 'channel' | 'here' | 'thread';
}

export interface ChannelsOptions {
  /** Maps an @handle to a person, or undefined. */
  readonly person: (handle: string) => string | undefined;
  /** Who is active right now, for @here. */
  readonly isActive?: (who: string) => boolean;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly hub?: Hub;
  readonly catalogue?: Catalogue;
  readonly source?: string;
  readonly maxMembers?: number;
  readonly maxPins?: number;
  readonly maxLength?: number;
}

export const eventTypes: readonly EventType[] = [
  { type: 'channels.message.posted', version: 1, owner: 'channels', description: 'A message was posted in a channel.', fields: { channel: 'string', message: 'number', by: 'string' } },
  { type: 'channels.member.joined', version: 1, owner: 'channels', description: 'Someone joined a channel.', fields: { channel: 'string', who: 'string' } },
  { type: 'channels.member.left', version: 1, owner: 'channels', description: 'Someone left or was removed from a channel.', fields: { channel: 'string', who: 'string' } },
  { type: 'channels.channel.created', version: 1, owner: 'channels', description: 'A channel was created.', fields: { channel: 'string', kind: 'string', by: 'string' } },
  { type: 'channels.channel.archived', version: 1, owner: 'channels', description: 'A channel was archived or restored.', fields: { channel: 'string', archived: 'boolean' } },
];

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const RESERVED = new Set(['channel', 'here', 'everyone']);
const DAY = 86_400_000;

export class Channels {
  private readonly chans = new Map<string, Channel>();
  private readonly direct = new Map<string, string>();
  private readonly comments: Comments;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly o: ChannelsOptions & { maxMembers: number; maxPins: number };
  private seq = 0;

  constructor(o: ChannelsOptions) {
    this.o = { maxMembers: 1000, maxPins: 50, ...o };
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => `ch${++this.seq}`);
    this.comments = new Comments({
      person: (h) => (RESERVED.has(h.toLowerCase()) ? undefined : o.person(h)),
      canSee: (who, record) => this.chans.get(record.slice(2))?.members.has(who) ?? false,
      now: () => new Date(this.now()),
      maxLength: o.maxLength ?? 4000,
    });
  }

  private emit(type: string, data: Record<string, unknown>, subject: string) {
    if (!this.o.hub || !this.o.catalogue) return;
    this.o.hub.publish(this.o.catalogue.make(this.o.source ?? 'urn:zthr:channels', type, data, { subject, now: new Date(this.now()) }));
  }

  private ch(id: string): Channel {
    const c = this.chans.get(id);
    if (!c) throw new ChannelError(`no channel ${id}`);
    return c;
  }

  private member(c: Channel, who: string): Member {
    const m = c.members.get(who);
    if (!m) throw new ChannelError('you are not a member of this channel');
    return m;
  }

  private need(c: Channel, who: string, role: Role): Member {
    const m = this.member(c, who);
    if (RANK[m.role] < RANK[role]) throw new ChannelError(`this needs the ${role} role`);
    return m;
  }

  private add(c: Channel, who: string, role: Role) {
    if (c.members.size >= this.o.maxMembers) throw new ChannelError(`a channel has at most ${this.o.maxMembers} members`);
    const last = [...this.comments.threads(`c:${c.id}`, { includeResolved: true })].flatMap((t) => [t.comment, ...t.replies]).reduce((n, m) => Math.max(n, m.id), 0);
    c.members.set(who, { who, role, joinedAt: this.now(), muted: false, lastRead: last });
  }

  create(by: string, o: { name: string; kind: 'public' | 'private'; topic?: string; members?: readonly string[]; retentionDays?: number; broadcastRole?: Role }): Channel {
    const name = o.name.trim().toLowerCase();
    if (!NAME.test(name)) throw new ChannelError('a channel name is 1 to 40 lower-case letters, digits, - or _');
    if ([...this.chans.values()].some((c) => c.kind !== 'direct' && c.name === name)) throw new ChannelError(`the name ${name} is taken`);
    if (o.kind !== 'public' && o.kind !== 'private') throw new ChannelError('a channel is public or private');
    if (o.retentionDays !== undefined && (!Number.isInteger(o.retentionDays) || o.retentionDays < 1)) throw new ChannelError('retention is a whole number of days');
    if ((o.topic?.length ?? 0) > 250) throw new ChannelError('a topic is at most 250 characters');
    const c: Channel = { id: this.newId(), kind: o.kind, name, topic: o.topic ?? '', createdBy: by, createdAt: this.now(), archived: false, members: new Map(), pins: [], retentionDays: o.retentionDays, broadcastRole: o.broadcastRole ?? 'member' };
    this.chans.set(c.id, c);
    this.add(c, by, 'owner');
    for (const w of new Set(o.members ?? [])) if (w !== by) this.add(c, w, 'member');
    this.emit('channels.channel.created', { channel: c.id, kind: c.kind, by }, c.id);
    return c;
  }

  /** The direct channel between two people, made on first use. */
  open(a: string, b: string): Channel {
    if (a === b || !a || !b) throw new ChannelError('a direct channel is between two different people');
    const key = [a, b].sort().join('\n');
    const have = this.direct.get(key);
    if (have) return this.ch(have);
    const c: Channel = { id: this.newId(), kind: 'direct', name: '', topic: '', createdBy: a, createdAt: this.now(), archived: false, members: new Map(), pins: [], retentionDays: undefined, broadcastRole: 'owner' };
    this.chans.set(c.id, c);
    this.direct.set(key, c.id);
    this.add(c, a, 'member');
    this.add(c, b, 'member');
    this.emit('channels.channel.created', { channel: c.id, kind: 'direct', by: a }, c.id);
    return c;
  }

  get(id: string, who: string): Channel {
    const c = this.ch(id);
    if (c.kind !== 'public' && !c.members.has(who)) throw new ChannelError(`no channel ${id}`);
    return c;
  }

  /** Channels this person may see: public ones, and private or direct ones they belong to. */
  visible(who: string): Channel[] {
    return [...this.chans.values()].filter((c) => c.kind === 'public' || c.members.has(who)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
  }

  join(who: string, id: string): Channel {
    const c = this.ch(id);
    if (c.kind !== 'public') throw new ChannelError(`no channel ${id}`);
    if (c.archived) throw new ChannelError('this channel is archived');
    if (!c.members.has(who)) {
      this.add(c, who, 'member');
      this.emit('channels.member.joined', { channel: id, who }, id);
    }
    return c;
  }

  invite(by: string, id: string, who: string): Channel {
    const c = this.ch(id);
    if (c.kind === 'direct') throw new ChannelError('a direct channel has only its two people');
    if (c.archived) throw new ChannelError('this channel is archived');
    this.need(c, by, c.kind === 'private' ? 'admin' : 'member');
    if (!c.members.has(who)) {
      this.add(c, who, 'member');
      this.emit('channels.member.joined', { channel: id, who }, id);
    }
    return c;
  }

  leave(who: string, id: string): void {
    const c = this.ch(id);
    if (c.kind === 'direct') throw new ChannelError('a direct channel cannot be left');
    const m = this.member(c, who);
    if (m.role === 'owner' && ![...c.members.values()].some((x) => x.who !== who && x.role === 'owner')) throw new ChannelError('the last owner must hand over before leaving');
    c.members.delete(who);
    this.emit('channels.member.left', { channel: id, who }, id);
  }

  remove(by: string, id: string, who: string): void {
    const c = this.ch(id);
    if (c.kind === 'direct') throw new ChannelError('a direct channel cannot be changed');
    const me = this.need(c, by, 'admin');
    const target = this.member(c, who);
    if (RANK[target.role] >= RANK[me.role] && by !== who) throw new ChannelError('you cannot remove someone of your rank or above');
    if (by === who) return this.leave(who, id);
    c.members.delete(who);
    this.emit('channels.member.left', { channel: id, who }, id);
  }

  setRole(by: string, id: string, who: string, role: Role): void {
    const c = this.ch(id);
    if (c.kind === 'direct') throw new ChannelError('a direct channel cannot be changed');
    this.need(c, by, 'owner');
    const t = this.member(c, who);
    if (t.role === 'owner' && role !== 'owner' && ![...c.members.values()].some((x) => x.who !== who && x.role === 'owner')) throw new ChannelError('a channel needs an owner');
    t.role = role;
  }

  mute(who: string, id: string, on: boolean): void {
    this.member(this.ch(id), who).muted = on;
  }

  archive(by: string, id: string, on = true): Channel {
    const c = this.ch(id);
    if (c.kind === 'direct') throw new ChannelError('a direct channel cannot be archived');
    this.need(c, by, 'owner');
    c.archived = on;
    this.emit('channels.channel.archived', { channel: id, archived: on }, id);
    return c;
  }

  private all(c: Channel): Comment[] {
    const out = this.comments.threads(`c:${c.id}`, { includeResolved: true }).flatMap((t) => [t.comment, ...t.replies]);
    const cut = c.retentionDays === undefined ? -Infinity : this.now() - c.retentionDays * DAY;
    return out.filter((m) => Date.parse(m.at) >= cut).sort((a, b) => a.id - b.id);
  }

  private view(c: Channel, m: Comment): Message {
    return { id: m.id, channel: c.id, by: m.by, text: m.text, at: m.at, edited: m.edits.length > 0, deleted: m.deleted, thread: m.parent, mentions: [...m.mentions], reactions: Object.fromEntries(Object.entries(m.reactions).map(([k, v]) => [k, [...v]])), pinned: c.pins.includes(m.id) };
  }

  private find(c: Channel, id: number): Comment {
    const m = this.all(c).find((x) => x.id === id);
    if (!m) throw new ChannelError(`no message ${id} in this channel`);
    return m;
  }

  /** Posts a message (or a thread reply), and says who to tell. */
  post(by: string, id: string, text: string, o: { thread?: number } = {}): { message: Message; notify: Notice[] } {
    const c = this.ch(id);
    this.member(c, by);
    if (c.archived) throw new ChannelError('this channel is archived');
    let root: Comment | undefined;
    if (o.thread !== undefined) {
      root = this.find(c, o.thread);
      if (root.parent !== undefined) root = this.find(c, root.parent);
    }
    let msg: Comment;
    try {
      msg = this.comments.post(by, `c:${id}`, text, root?.id);
    } catch (e) {
      throw new ChannelError((e as Error).message);
    }
    const notices = new Map<string, Notice['reason']>();
    const tell = (who: string, reason: Notice['reason']) => {
      if (who !== by && c.members.has(who) && !notices.has(who)) notices.set(who, reason);
    };
    if (c.kind === 'direct') for (const w of c.members.keys()) tell(w, 'direct');
    for (const w of msg.mentions) tell(w, 'mention');
    const broadcast = /(?:^|[^\w@])@(channel|here)\b/i.exec(text);
    if (broadcast && RANK[c.members.get(by)!.role] >= RANK[c.broadcastRole]) {
      const here = broadcast[1]!.toLowerCase() === 'here';
      for (const w of c.members.keys()) if (!here || this.o.isActive?.(w)) tell(w, here ? 'here' : 'channel');
    }
    if (root) {
      const parts = new Set([root.by, ...this.all(c).filter((x) => x.parent === root!.id).map((x) => x.by)]);
      for (const w of parts) tell(w, 'thread');
    }
    for (const [w, r] of notices) if (c.members.get(w)!.muted && r !== 'mention' && r !== 'direct') notices.delete(w);
    this.emit('channels.message.posted', { channel: id, message: msg.id, by }, id);
    return { message: this.view(c, msg), notify: [...notices].map(([who, reason]) => ({ who, reason })) };
  }

  edit(by: string, id: string, messageId: number, text: string): Message {
    const c = this.ch(id);
    this.member(c, by);
    if (c.archived) throw new ChannelError('this channel is archived');
    this.find(c, messageId);
    try {
      return this.view(c, this.comments.edit(by, messageId, text));
    } catch (e) {
      throw new ChannelError((e as Error).message);
    }
  }

  delete(by: string, id: string, messageId: number): void {
    const c = this.ch(id);
    const me = this.member(c, by);
    this.find(c, messageId);
    try {
      this.comments.remove(by, messageId, RANK[me.role] >= RANK.admin);
    } catch (e) {
      throw new ChannelError((e as Error).message);
    }
    c.pins = c.pins.filter((p) => p !== messageId);
  }

  react(who: string, id: string, messageId: number, emoji: string): void {
    const c = this.ch(id);
    this.member(c, who);
    if (!emoji || emoji.length > 32) throw new ChannelError('a reaction is 1 to 32 characters');
    this.find(c, messageId);
    this.comments.react(who, messageId, emoji);
  }

  /** Top-level messages, newest first, with thread summaries. Public channels can be read without joining. */
  history(who: string, id: string, o: { before?: number; limit?: number } = {}): { message: Message; replies: number; lastReply: string | undefined; participants: string[] }[] {
    const c = this.get(id, who);
    const all = this.all(c);
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    return all
      .filter((m) => m.parent === undefined && (o.before === undefined || m.id < o.before))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((m) => {
        const rs = all.filter((r) => r.parent === m.id);
        return { message: this.view(c, m), replies: rs.filter((r) => !r.deleted).length, lastReply: rs.at(-1)?.at, participants: [...new Set(rs.map((r) => r.by))] };
      });
  }

  thread(who: string, id: string, rootId: number): Message[] {
    const c = this.get(id, who);
    const all = this.all(c);
    const root = all.find((m) => m.id === rootId && m.parent === undefined);
    if (!root) throw new ChannelError(`no message ${rootId} in this channel`);
    return [root, ...all.filter((m) => m.parent === rootId)].map((m) => this.view(c, m));
  }

  pin(by: string, id: string, messageId: number, on = true): Message[] {
    const c = this.ch(id);
    this.need(c, by, c.kind === 'direct' ? 'member' : 'admin');
    const m = this.find(c, messageId);
    if (m.deleted) throw new ChannelError('this message was deleted');
    if (on && !c.pins.includes(messageId)) {
      if (c.pins.length >= this.o.maxPins) throw new ChannelError(`a channel has at most ${this.o.maxPins} pins`);
      c.pins.push(messageId);
    } else if (!on) c.pins = c.pins.filter((p) => p !== messageId);
    return this.pinned(by, id);
  }

  pinned(who: string, id: string): Message[] {
    const c = this.get(id, who);
    const all = this.all(c);
    return c.pins.map((p) => all.find((m) => m.id === p)).filter((m): m is Comment => m !== undefined).map((m) => this.view(c, m));
  }

  /** Moves the read marker forward (never back) to a message, or to the newest. */
  markRead(who: string, id: string, upTo?: number): number {
    const c = this.ch(id);
    const m = this.member(c, who);
    const newest = this.all(c).at(-1)?.id ?? 0;
    const to = upTo === undefined ? newest : Math.min(upTo, newest);
    if (to > m.lastRead) m.lastRead = to;
    return m.lastRead;
  }

  unread(who: string, id: string): { unread: number; mentions: number } {
    const c = this.ch(id);
    const m = this.member(c, who);
    const fresh = this.all(c).filter((x) => x.id > m.lastRead && x.by !== who && !x.deleted);
    return { unread: fresh.length, mentions: fresh.filter((x) => x.mentions.includes(who) || (c.kind === 'direct') || /(?:^|[^\w@])@(channel|here)\b/i.test(x.text)).length };
  }
}
