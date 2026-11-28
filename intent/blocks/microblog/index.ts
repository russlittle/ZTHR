/**
 * Microblog: the status model of a Mastodon-style service. A status has text, an optional content warning,
 * a visibility (public, unlisted, followers-only, direct), mentions and hashtags found in the text, up to four
 * media attachments with alt text, and an optional poll. People boost, favourite and bookmark statuses, and
 * collect people into lists.
 *
 * Rules held here, each the way Mastodon and its peers behave:
 *  - who can see a status: public and unlisted by anyone not blocked, followers-only by the author, the author's
 *    followers and people mentioned, direct by the author and people mentioned;
 *  - a reply is never more public than the status it answers when that one is followers-only or direct;
 *  - followers-only and direct statuses cannot be boosted; a boost is never more public than the original;
 *    boosting twice gives the same boost; boosting a boost boosts the original;
 *  - polls need two to four options, close at a set time, accept one vote per person (or several if multiple),
 *    and the author cannot vote;
 *  - media: up to four images, or one video or audio file; alt text up to 1500 characters, and a status can be
 *    asked which attachments lack it;
 *  - editing keeps every earlier version; deleting leaves a tombstone and removes its boosts;
 *  - a list holds only people its owner follows.
 * `toActivity` and `fromNote` map statuses to and from ActivityPub (Note, Question, Announce) with the addressing
 * the fediverse expects for each visibility, using the activitypub block.
 *
 * The clock and the id source are arguments. Out of scope: timelines (see timeline-assembly), storage, rendering
 * rich HTML beyond escaping and linking (`renderHtml`), and moderation.
 */
import { PUBLIC, announce, asArray, create, hostOf, idOf, withContext, type Doc } from '../activitypub/index.ts';

export class MicroblogError extends Error {
  readonly code: 'invalid' | 'forbidden' | 'not-found' | 'closed' | 'conflict';
  constructor(code: MicroblogError['code'], message: string) {
    super(message);
    this.name = 'MicroblogError';
    this.code = code;
  }
}

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct';
const RANK: Record<Visibility, number> = { public: 3, unlisted: 2, private: 1, direct: 0 };
export const moreOpen = (a: Visibility, b: Visibility): boolean => RANK[a] > RANK[b];

export interface Media {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'audio' | 'gifv';
  readonly url: string;
  readonly description: string;
  readonly sensitive?: boolean;
}

export interface Poll {
  readonly options: { readonly title: string; readonly votes: number }[];
  readonly multiple: boolean;
  readonly expiresAt: number;
  readonly votersCount: number;
}

export interface Version {
  readonly text: string;
  readonly spoilerText: string;
  readonly at: number;
}

export interface Status {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly spoilerText: string;
  readonly sensitive: boolean;
  readonly visibility: Visibility;
  readonly createdAt: number;
  readonly editedAt: number | undefined;
  readonly inReplyTo: string | undefined;
  readonly mentions: readonly string[];
  readonly tags: readonly string[];
  readonly media: readonly Media[];
  readonly poll: Poll | undefined;
  readonly boostOf: string | undefined;
  readonly language: string | undefined;
  readonly history: readonly Version[];
  readonly deleted: boolean;
}

export interface Relations {
  follows(follower: string, followed: string): boolean;
  /** True when `blocker` has blocked `blocked`. */
  blocks(blocker: string, blocked: string): boolean;
}

export interface NewStatus {
  readonly text: string;
  readonly spoilerText?: string;
  readonly sensitive?: boolean;
  readonly visibility?: Visibility;
  readonly inReplyTo?: string;
  readonly media?: readonly Omit<Media, 'id'>[];
  readonly poll?: { readonly options: readonly string[]; readonly multiple?: boolean; readonly expiresInMs: number };
  readonly language?: string;
}

export interface Limits {
  readonly maxChars: number;
  readonly maxSpoiler: number;
  readonly maxMedia: number;
  readonly maxAlt: number;
  readonly pollOptions: [number, number];
  readonly pollOptionChars: number;
  readonly pollMinMs: number;
  readonly pollMaxMs: number;
}

export const DEFAULT_LIMITS: Limits = { maxChars: 500, maxSpoiler: 100, maxMedia: 4, maxAlt: 1500, pollOptions: [2, 4], pollOptionChars: 50, pollMinMs: 300_000, pollMaxMs: 30 * 86_400_000 };

const MENTION = /(?<![\w@/])@([A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?:@([A-Za-z0-9.-]+\.[A-Za-z]{2,}))?/g;
const HASHTAG = /(?<![\w&/#])#([\p{L}\p{N}_]{1,100})(?![\p{L}\p{N}_])/gu;
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Mentions (`@user` or `@user@host`) and hashtags (`#tag`, lower-cased, no repeats) in a text. */
export function parseText(text: string): { mentions: { user: string; host: string | undefined }[]; tags: string[] } {
  const mentions = [...text.matchAll(MENTION)].map((m) => ({ user: m[1]!, host: m[2]?.toLowerCase() }));
  const tags = [...new Set([...text.matchAll(HASHTAG)].map((m) => m[1]!.toLowerCase()))];
  return { mentions, tags };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Status text as safe HTML: everything escaped, then web links, mentions and hashtags linked. Line breaks become <br>. */
export function renderHtml(text: string, o: { tagUrl: (tag: string) => string; mentionUrl: (user: string, host: string | undefined) => string | undefined }): string {
  const parts: string[] = [];
  let last = 0;
  const found: { at: number; end: number; html: string }[] = [];
  for (const m of text.matchAll(URL_RE)) found.push({ at: m.index, end: m.index + m[0].length, html: `<a href="${esc(m[0])}" rel="nofollow noopener noreferrer" target="_blank">${esc(m[0])}</a>` });
  const free = (at: number, end: number) => !found.some((f) => at < f.end && end > f.at);
  for (const m of text.matchAll(MENTION)) {
    const url = o.mentionUrl(m[1]!, m[2]?.toLowerCase());
    if (url && free(m.index, m.index + m[0].length)) found.push({ at: m.index, end: m.index + m[0].length, html: `<span class="h-card"><a href="${esc(url)}" class="u-url mention">@<span>${esc(m[1]!)}</span></a></span>` });
  }
  for (const m of text.matchAll(HASHTAG)) if (free(m.index, m.index + m[0].length)) found.push({ at: m.index, end: m.index + m[0].length, html: `<a href="${esc(o.tagUrl(m[1]!.toLowerCase()))}" class="hashtag" rel="tag">#<span>${esc(m[1]!)}</span></a>` });
  found.sort((a, b) => a.at - b.at);
  for (const f of found) {
    if (f.at < last) continue;
    parts.push(esc(text.slice(last, f.at)), f.html);
    last = f.end;
  }
  parts.push(esc(text.slice(last)));
  return `<p>${parts.join('').replace(/\r?\n/g, '<br>')}</p>`;
}

export interface List {
  readonly id: string;
  readonly owner: string;
  readonly title: string;
  /** Whose replies show: only to people on the list, to anyone the owner follows, or none. */
  readonly repliesPolicy: 'list' | 'followed' | 'none';
  /** Exclusive lists take their members' statuses out of the home timeline. */
  readonly exclusive: boolean;
  readonly members: ReadonlySet<string>;
}

export interface MicroblogOptions {
  readonly now: () => number;
  readonly newId: () => string;
  readonly relations: Relations;
  readonly limits?: Limits;
  /** Resolve a mention to an actor id: local names and `user@host` handles. Unknown handles are left out. */
  readonly resolveMention?: (user: string, host: string | undefined) => string | undefined;
}

type Mut<T> = { -readonly [K in keyof T]: T[K] };

export class Microblog {
  readonly #s = new Map<string, Mut<Status>>();
  readonly #favs = new Map<string, Set<string>>();
  readonly #bookmarks = new Map<string, { id: string; at: number }[]>();
  readonly #votes = new Map<string, Map<string, number[]>>();
  readonly #lists = new Map<string, Mut<List> & { members: Set<string> }>();
  readonly #o: MicroblogOptions;
  readonly limits: Limits;

  constructor(o: MicroblogOptions) {
    this.#o = o;
    this.limits = o.limits ?? DEFAULT_LIMITS;
  }

  get(id: string): Status | undefined {
    return this.#s.get(id);
  }

  #need(id: string): Mut<Status> {
    const s = this.#s.get(id);
    if (!s || s.deleted) throw new MicroblogError('not-found', `there is no status ${id}`);
    return s;
  }

  /** Who may read a status. A deleted one nobody may. */
  canSee(viewer: string | undefined, s: Status): boolean {
    if (s.deleted) return false;
    if (viewer !== undefined && viewer === s.author) return true;
    if (viewer !== undefined && (this.#o.relations.blocks(s.author, viewer) || this.#o.relations.blocks(viewer, s.author))) return false;
    if (s.visibility === 'public' || s.visibility === 'unlisted') return true;
    if (viewer === undefined) return false;
    if (s.mentions.includes(viewer)) return true;
    return s.visibility === 'private' && this.#o.relations.follows(viewer, s.author);
  }

  /** Make a status. Throws MicroblogError for anything over the limits. */
  post(author: string, n: NewStatus): Status {
    const L = this.limits;
    const text = n.text.replace(/\r\n/g, '\n');
    if (text.trim() === '' && (n.media ?? []).length === 0 && !n.poll) throw new MicroblogError('invalid', 'a status needs text, media or a poll');
    if ([...text].length > L.maxChars) throw new MicroblogError('invalid', `a status is at most ${L.maxChars} characters`);
    const spoilerText = n.spoilerText ?? '';
    if ([...spoilerText].length > L.maxSpoiler) throw new MicroblogError('invalid', `a content warning is at most ${L.maxSpoiler} characters`);
    let visibility: Visibility = n.visibility ?? 'public';
    if (!(visibility in RANK)) throw new MicroblogError('invalid', `unknown visibility ${String(visibility)}`);
    let parent: Mut<Status> | undefined;
    if (n.inReplyTo !== undefined) {
      parent = this.#need(n.inReplyTo);
      if (!this.canSee(author, parent)) throw new MicroblogError('forbidden', 'the status being answered is not visible to the author');
      if ((parent.visibility === 'private' || parent.visibility === 'direct') && moreOpen(visibility, parent.visibility)) visibility = parent.visibility;
    }
    const media = this.#media(n.media ?? []);
    if (media.length && n.poll) throw new MicroblogError('invalid', 'a status has media or a poll, not both');
    const poll = n.poll ? this.#poll(n.poll) : undefined;
    const parsed = parseText(`${text}`);
    const mentions = new Set<string>();
    for (const m of parsed.mentions) {
      const id = this.#o.resolveMention?.(m.user, m.host);
      if (id && id !== author) mentions.add(id);
    }
    if (parent && parent.author !== author) mentions.add(parent.author);
    const s: Mut<Status> = {
      id: this.#o.newId(),
      author,
      text,
      spoilerText,
      sensitive: n.sensitive ?? spoilerText !== '',
      visibility,
      createdAt: this.#o.now(),
      editedAt: undefined,
      inReplyTo: parent?.id,
      mentions: [...mentions],
      tags: parsed.tags,
      media,
      poll,
      boostOf: undefined,
      language: n.language,
      history: [],
      deleted: false,
    };
    this.#s.set(s.id, s);
    return s;
  }

  #media(items: readonly Omit<Media, 'id'>[]): Media[] {
    const L = this.limits;
    if (items.length > L.maxMedia) throw new MicroblogError('invalid', `at most ${L.maxMedia} attachments`);
    const kinds = new Set(items.map((m) => (m.kind === 'gifv' ? 'video' : m.kind)));
    if (items.length > 1 && (kinds.size > 1 || !kinds.has('image'))) throw new MicroblogError('invalid', 'several attachments must all be images; a video or audio file goes alone');
    return items.map((m, i) => {
      if ([...m.description].length > L.maxAlt) throw new MicroblogError('invalid', `alt text is at most ${L.maxAlt} characters`);
      if (!/^https:\/\//.test(m.url)) throw new MicroblogError('invalid', 'media urls must be https');
      return { ...m, id: `${this.#o.newId()}-m${i}` };
    });
  }

  #poll(p: NonNullable<NewStatus['poll']>): Poll {
    const L = this.limits;
    const titles = p.options.map((t) => t.trim());
    if (titles.length < L.pollOptions[0] || titles.length > L.pollOptions[1]) throw new MicroblogError('invalid', `a poll has ${L.pollOptions[0]} to ${L.pollOptions[1]} options`);
    if (titles.some((t) => t === '' || [...t].length > L.pollOptionChars)) throw new MicroblogError('invalid', `each poll option is 1 to ${L.pollOptionChars} characters`);
    if (new Set(titles.map((t) => t.toLowerCase())).size !== titles.length) throw new MicroblogError('invalid', 'poll options must differ');
    if (p.expiresInMs < L.pollMinMs || p.expiresInMs > L.pollMaxMs) throw new MicroblogError('invalid', 'a poll lasts from 5 minutes to 30 days');
    return { options: titles.map((title) => ({ title, votes: 0 })), multiple: p.multiple ?? false, expiresAt: this.#o.now() + p.expiresInMs, votersCount: 0 };
  }

  /** Alt-text check: the media of a status that has no description. */
  missingAlt(id: string): Media[] {
    return this.#need(id).media.filter((m) => m.description.trim() === '');
  }

  /** Change text or warning. Earlier versions are kept in `history`. Only the author, and not on a boost. */
  edit(actor: string, id: string, patch: { text?: string; spoilerText?: string }): Status {
    const s = this.#need(id);
    if (s.author !== actor) throw new MicroblogError('forbidden', 'only the author can edit');
    if (s.boostOf) throw new MicroblogError('invalid', 'a boost cannot be edited');
    const text = patch.text ?? s.text;
    const spoilerText = patch.spoilerText ?? s.spoilerText;
    if ([...text].length > this.limits.maxChars) throw new MicroblogError('invalid', `a status is at most ${this.limits.maxChars} characters`);
    if (text === s.text && spoilerText === s.spoilerText) return s;
    s.history = [...s.history, { text: s.text, spoilerText: s.spoilerText, at: s.editedAt ?? s.createdAt }];
    s.text = text;
    s.spoilerText = spoilerText;
    s.editedAt = this.#o.now();
    const parsed = parseText(text);
    s.tags = parsed.tags;
    return s;
  }

  /** Delete: the status becomes a tombstone and its boosts and bookmarks go with it. */
  delete(actor: string, id: string): void {
    const s = this.#need(id);
    if (s.author !== actor) throw new MicroblogError('forbidden', 'only the author can delete');
    s.deleted = true;
    s.text = '';
    s.media = [];
    s.poll = undefined;
    for (const b of this.#s.values()) if (b.boostOf === id) b.deleted = true;
    for (const [u, list] of this.#bookmarks) this.#bookmarks.set(u, list.filter((x) => x.id !== id));
    this.#favs.delete(id);
  }

  /** Boost a status. A boost of a boost boosts the original; repeating returns the existing boost. */
  boost(actor: string, id: string, visibility: Visibility = 'public'): Status {
    let target = this.#need(id);
    if (target.boostOf) target = this.#need(target.boostOf);
    if (!this.canSee(actor, target)) throw new MicroblogError('forbidden', 'that status is not visible');
    if (target.visibility === 'private' || target.visibility === 'direct') throw new MicroblogError('forbidden', 'followers-only and direct statuses cannot be boosted');
    const existing = [...this.#s.values()].find((b) => b.boostOf === target.id && b.author === actor && !b.deleted);
    if (existing) return existing;
    const vis = moreOpen(visibility, target.visibility) ? target.visibility : visibility;
    const b: Mut<Status> = { id: this.#o.newId(), author: actor, text: '', spoilerText: '', sensitive: false, visibility: vis, createdAt: this.#o.now(), editedAt: undefined, inReplyTo: undefined, mentions: [], tags: [], media: [], poll: undefined, boostOf: target.id, language: undefined, history: [], deleted: false };
    this.#s.set(b.id, b);
    return b;
  }

  unboost(actor: string, id: string): boolean {
    let target = this.#s.get(id);
    if (target?.boostOf) target = this.#s.get(target.boostOf);
    const b = [...this.#s.values()].find((x) => x.boostOf === target?.id && x.author === actor && !x.deleted);
    if (!b) return false;
    b.deleted = true;
    return true;
  }

  boostCount(id: string): number {
    let n = 0;
    for (const b of this.#s.values()) if (b.boostOf === id && !b.deleted) n++;
    return n;
  }

  favourite(actor: string, id: string): boolean {
    const s = this.#need(id);
    if (!this.canSee(actor, s)) throw new MicroblogError('forbidden', 'that status is not visible');
    const set = this.#favs.get(id) ?? new Set<string>();
    const added = !set.has(actor);
    set.add(actor);
    this.#favs.set(id, set);
    return added;
  }

  unfavourite(actor: string, id: string): boolean {
    return this.#favs.get(id)?.delete(actor) ?? false;
  }

  favouriteCount(id: string): number {
    return this.#favs.get(id)?.size ?? 0;
  }

  favouritedBy(id: string): string[] {
    return [...(this.#favs.get(id) ?? [])];
  }

  /** Bookmarks are private: a list for one person, newest bookmark first, hiding what they can no longer see. */
  bookmark(actor: string, id: string): void {
    const s = this.#need(id);
    if (!this.canSee(actor, s)) throw new MicroblogError('forbidden', 'that status is not visible');
    const list = this.#bookmarks.get(actor) ?? [];
    if (!list.some((b) => b.id === id)) list.unshift({ id, at: this.#o.now() });
    this.#bookmarks.set(actor, list);
  }

  unbookmark(actor: string, id: string): void {
    this.#bookmarks.set(actor, (this.#bookmarks.get(actor) ?? []).filter((b) => b.id !== id));
  }

  bookmarks(actor: string): Status[] {
    return (this.#bookmarks.get(actor) ?? []).map((b) => this.#s.get(b.id)!).filter((s) => this.canSee(actor, s));
  }

  /** Vote in a poll with the indexes chosen. One vote per person; the author may not vote; closed polls refuse. */
  vote(voter: string, id: string, choices: readonly number[]): Poll {
    const s = this.#need(id);
    if (!s.poll) throw new MicroblogError('invalid', 'that status has no poll');
    if (!this.canSee(voter, s)) throw new MicroblogError('forbidden', 'that status is not visible');
    if (voter === s.author) throw new MicroblogError('forbidden', 'the author cannot vote in their own poll');
    if (this.#o.now() >= s.poll.expiresAt) throw new MicroblogError('closed', 'the poll has closed');
    const votes = this.#votes.get(id) ?? new Map<string, number[]>();
    if (votes.has(voter)) throw new MicroblogError('conflict', 'already voted');
    const uniq = [...new Set(choices)];
    if (uniq.length === 0 || uniq.some((c) => !Number.isInteger(c) || c < 0 || c >= s.poll!.options.length)) throw new MicroblogError('invalid', 'choose existing options');
    if (!s.poll.multiple && uniq.length > 1) throw new MicroblogError('invalid', 'this poll takes one choice');
    votes.set(voter, uniq);
    this.#votes.set(id, votes);
    s.poll = { ...s.poll, options: s.poll.options.map((o, i) => (uniq.includes(i) ? { ...o, votes: o.votes + 1 } : o)), votersCount: s.poll.votersCount + 1 };
    return s.poll;
  }

  votedBy(id: string, voter: string): number[] | undefined {
    return this.#votes.get(id)?.get(voter);
  }

  /** Statuses answering this one, and the chain it answers, each only if the viewer may see it. */
  thread(id: string, viewer: string | undefined): { ancestors: Status[]; descendants: Status[] } {
    const root = this.#need(id);
    const ancestors: Status[] = [];
    for (let p = root.inReplyTo ? this.#s.get(root.inReplyTo) : undefined; p && ancestors.length < 200; p = p.inReplyTo ? this.#s.get(p.inReplyTo) : undefined) if (this.canSee(viewer, p)) ancestors.unshift(p);
    const descendants: Status[] = [];
    const queue = [root.id];
    while (queue.length && descendants.length < 1000) {
      const at = queue.shift()!;
      for (const c of this.#s.values()) if (c.inReplyTo === at) {
        queue.push(c.id);
        if (this.canSee(viewer, c)) descendants.push(c);
      }
    }
    return { ancestors, descendants: descendants.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)) };
  }

  // ---- lists

  createList(owner: string, title: string, o: { repliesPolicy?: List['repliesPolicy']; exclusive?: boolean } = {}): List {
    const t = title.trim();
    if (t === '' || [...t].length > 100) throw new MicroblogError('invalid', 'a list title is 1 to 100 characters');
    const l = { id: this.#o.newId(), owner, title: t, repliesPolicy: o.repliesPolicy ?? 'list', exclusive: o.exclusive ?? false, members: new Set<string>() };
    this.#lists.set(l.id, l);
    return l;
  }

  #list(owner: string, id: string) {
    const l = this.#lists.get(id);
    if (!l) throw new MicroblogError('not-found', `there is no list ${id}`);
    if (l.owner !== owner) throw new MicroblogError('forbidden', 'not your list');
    return l;
  }

  addToList(owner: string, id: string, member: string): void {
    const l = this.#list(owner, id);
    if (!this.#o.relations.follows(owner, member)) throw new MicroblogError('forbidden', 'a list holds only people its owner follows');
    l.members.add(member);
  }

  removeFromList(owner: string, id: string, member: string): void {
    this.#list(owner, id).members.delete(member);
  }

  deleteList(owner: string, id: string): void {
    this.#list(owner, id);
    this.#lists.delete(id);
  }

  list(id: string): List | undefined {
    return this.#lists.get(id);
  }

  /** The list's statuses for its owner, newest first: members' posts and boosts, replies by the list's policy. */
  listStatuses(owner: string, id: string): Status[] {
    const l = this.#list(owner, id);
    const out: Status[] = [];
    for (const s of this.#s.values()) {
      if (!l.members.has(s.author) || !this.canSee(owner, s)) continue;
      if (s.visibility === 'direct') continue;
      if (s.inReplyTo && s.author !== owner) {
        const parent = this.#s.get(s.inReplyTo);
        const to = parent?.author;
        const ok = l.repliesPolicy === 'none' ? to === s.author : l.repliesPolicy === 'list' ? to !== undefined && (l.members.has(to) || to === owner || to === s.author) : to !== undefined && (to === s.author || to === owner || this.#o.relations.follows(owner, to));
        if (!ok) continue;
      }
      out.push(s);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }

  /** Whether a status belongs to an exclusive list of the viewer, and so is kept out of their home timeline. */
  inExclusiveList(viewer: string, s: Status): boolean {
    for (const l of this.#lists.values()) if (l.owner === viewer && l.exclusive && l.members.has(s.author)) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ActivityPub mapping
// ---------------------------------------------------------------------------------------------------------------

export interface ApContext {
  /** The id URL of a status, an actor's followers collection, and a mentioned actor's URL. */
  readonly statusUrl: (id: string) => string;
  readonly followersOf: (actor: string) => string;
  readonly activityUrl: (id: string) => string;
  readonly htmlOf: (s: Status) => string;
}

/** Addressing for a visibility: `to` and `cc` as the fediverse reads them. */
export function addressing(v: Visibility, followers: string, mentions: readonly string[]): { to: string[]; cc: string[] } {
  switch (v) {
    case 'public': return { to: [PUBLIC], cc: [followers, ...mentions] };
    case 'unlisted': return { to: [followers], cc: [PUBLIC, ...mentions] };
    case 'private': return { to: [followers], cc: [...mentions] };
    case 'direct': return { to: [...mentions], cc: [] };
  }
}

/** Visibility read back from `to` and `cc`, as Mastodon does. */
export function visibilityFrom(to: readonly string[], cc: readonly string[], followers: string): Visibility {
  if (to.includes(PUBLIC)) return 'public';
  if (cc.includes(PUBLIC)) return 'unlisted';
  if (to.includes(followers) || cc.includes(followers)) return 'private';
  return 'direct';
}

/** The Create(Note), Create(Question) or Announce that publishes a status. `actorUrl` is the author's actor id. */
export function toActivity(s: Status, actorUrl: string, c: ApContext): Doc {
  const followers = c.followersOf(actorUrl);
  if (s.boostOf) {
    const a = addressing(s.visibility, followers, []);
    return announce(c.activityUrl(`${s.id}/activity`), actorUrl, c.statusUrl(s.boostOf), { to: a.to, cc: a.cc, published: new Date(s.createdAt).toISOString() });
  }
  const a = addressing(s.visibility, followers, s.mentions);
  const note: Doc = {
    id: c.statusUrl(s.id),
    type: s.poll ? 'Question' : 'Note',
    attributedTo: actorUrl,
    content: c.htmlOf(s),
    published: new Date(s.createdAt).toISOString(),
    to: a.to,
    cc: a.cc,
    sensitive: s.sensitive,
    tag: [...s.mentions.map((m) => ({ type: 'Mention', href: m })), ...s.tags.map((t) => ({ type: 'Hashtag', name: `#${t}` }))],
  };
  if (s.spoilerText) note['summary'] = s.spoilerText;
  if (s.inReplyTo) note['inReplyTo'] = c.statusUrl(s.inReplyTo);
  if (s.editedAt) note['updated'] = new Date(s.editedAt).toISOString();
  if (s.language) note['contentMap'] = { [s.language]: c.htmlOf(s) };
  if (s.media.length) note['attachment'] = s.media.map((m) => ({ type: m.kind === 'image' ? 'Image' : m.kind === 'audio' ? 'Audio' : 'Video', url: m.url, name: m.description }));
  if (s.poll) {
    note[s.poll.multiple ? 'anyOf' : 'oneOf'] = s.poll.options.map((o) => ({ type: 'Note', name: o.title, replies: { type: 'Collection', totalItems: o.votes } }));
    note['endTime'] = new Date(s.poll.expiresAt).toISOString();
    note['votersCount'] = s.poll.votersCount;
  }
  return create(c.activityUrl(`${s.id}/activity`), actorUrl, withContext(note), { to: a.to, cc: a.cc, published: note['published'] as string });
}

export interface RemoteStatus {
  readonly url: string;
  readonly author: string;
  readonly text: string;
  readonly spoilerText: string;
  readonly sensitive: boolean;
  readonly visibility: Visibility;
  readonly published: string | undefined;
  readonly inReplyTo: string | undefined;
  readonly mentions: string[];
  readonly tags: string[];
  readonly media: { kind: Media['kind']; url: string; description: string }[];
  readonly pollOptions: string[] | undefined;
}

/** Read a Note or Question from another server. The id must be on the author's host; unknown shapes are refused. */
export function fromNote(note: Doc, followersOf: (actor: string) => string): RemoteStatus {
  const type = asArray(note['type'])[0];
  if (type !== 'Note' && type !== 'Question') throw new MicroblogError('invalid', 'only a Note or a Question is a status');
  const url = idOf(note['id']);
  const author = idOf(note['attributedTo']);
  if (!url || !author) throw new MicroblogError('invalid', 'a note needs an id and an attributedTo');
  if (hostOf(url) !== hostOf(author)) throw new MicroblogError('forbidden', 'the note is not on its author’s host');
  const strs = (v: unknown) => asArray(v as never).map((x) => idOf(x as never)).filter((x): x is string => x !== undefined);
  const tags = asArray(note['tag'] as never).filter((t): t is Doc => typeof t === 'object' && t !== null && !Array.isArray(t));
  const options = asArray((note['oneOf'] ?? note['anyOf']) as never).map((o) => (typeof o === 'object' && o && !Array.isArray(o) ? String(o['name'] ?? '') : '')).filter(Boolean);
  const content = typeof note['content'] === 'string' ? note['content'] : '';
  return {
    url,
    author,
    text: content,
    spoilerText: typeof note['summary'] === 'string' ? note['summary'] : '',
    sensitive: note['sensitive'] === true,
    visibility: visibilityFrom(strs(note['to']), strs(note['cc']), followersOf(author)),
    published: typeof note['published'] === 'string' ? note['published'] : undefined,
    inReplyTo: idOf(note['inReplyTo'] as never),
    mentions: tags.filter((t) => t['type'] === 'Mention' && typeof t['href'] === 'string').map((t) => t['href'] as string),
    tags: tags.filter((t) => t['type'] === 'Hashtag' && typeof t['name'] === 'string').map((t) => (t['name'] as string).replace(/^#/, '').toLowerCase()),
    media: asArray(note['attachment'] as never).filter((a): a is Doc => typeof a === 'object' && a !== null && !Array.isArray(a) && typeof a['url'] === 'string' && /^https:\/\//.test(a['url'])).slice(0, 4).map((a) => ({
      kind: a['type'] === 'Audio' ? 'audio' as const : a['type'] === 'Video' ? 'video' as const : 'image' as const,
      url: a['url'] as string,
      description: typeof a['name'] === 'string' ? a['name'] : '',
    })),
    pollOptions: options.length ? options : undefined,
  };
}
