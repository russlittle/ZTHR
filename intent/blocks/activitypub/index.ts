/**
 * ActivityPub: the server-to-server core of the fediverse (W3C ActivityPub and ActivityStreams 2.0 Core and
 * Vocabulary). Actor documents, the activities social apps send (Create, Update, Delete, Follow, Accept, Reject,
 * Undo, Like, Announce, Block, Move), ordered collections with pages, an inbox that checks what arrives and keeps
 * the relationships it changes, delivery planning for outgoing activities, WebFinger discovery (RFC 7033), and
 * HTTP Signatures on requests (the draft-cavage scheme every fediverse server speaks, with the body bound by a
 * SHA-256 Digest header).
 *
 * JSON-LD is handled the way the fediverse handles it, not as a general processor: the ActivityStreams context
 * must be present, `type` and `to`/`cc` may be one value or a list, and an object may be embedded or a bare id
 * (`asArray`, `idOf`, `typesOf`). Full expansion and compaction with arbitrary contexts, and LD signatures, are out
 * of scope.
 *
 * What the inbox refuses, because each is a known attack: a request whose signer is not the activity's `actor`; an
 * Update, Delete or Create whose embedded object is on another host than the actor (spoofing); an Undo by someone
 * other than the original actor; a replayed activity id; an activity from a blocked actor; documents that are
 * oversized, too deeply nested, or whose ids are not https URLs. A Move changes nothing until `confirmMove` sees
 * both actors vouch for it (`movedTo` and `alsoKnownAs`).
 *
 * Out of scope: fetching and caching remote actors and objects (`fetchActor` and `send` are arguments), HTML
 * sanitising of `content` (use the html-sanitize block), and persistence; state is held in memory in `Inbox` and
 * `CollectionStore` so a real store is a thin layer over the same calls.
 */
import { createHash, createPublicKey, createSign, createVerify, timingSafeEqual, verify as cryptoVerify, sign as cryptoSign, type KeyObject } from 'node:crypto';

export class ApError extends Error {
  readonly code: 'invalid' | 'forbidden' | 'duplicate' | 'signature' | 'unsupported';
  constructor(code: ApError['code'], message: string) {
    super(message);
    this.name = 'ApError';
    this.code = code;
  }
}

export const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
export const SECURITY_CONTEXT = 'https://w3id.org/security/v1';
export const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
export const MAX_DOCUMENT = 1_000_000;
export const MAX_DEPTH = 8;

export const ACTIVITY_TYPES = ['Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Undo', 'Like', 'Announce', 'Block', 'Move', 'Add', 'Remove', 'Flag'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTOR_TYPES = ['Person', 'Service', 'Application', 'Group', 'Organization'] as const;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Doc = { [k: string]: Json };

// ---------------------------------------------------------------------------------------------------------------
// JSON-LD as the fediverse uses it
// ---------------------------------------------------------------------------------------------------------------

/** A value that may be one thing or a list of things, as a list. */
export function asArray(v: Json | undefined): Json[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

/** The id of a value that is either an id string or an embedded object with an `id`. */
export function idOf(v: Json | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v['id'] === 'string') return v['id'];
  return undefined;
}

export const typesOf = (d: Doc): string[] => asArray(d['type']).filter((t): t is string => typeof t === 'string');

/** True when the document's @context names ActivityStreams, alone or in a list. */
export function hasActivityStreamsContext(d: Doc): boolean {
  return asArray(d['@context']).some((c) => c === AS_CONTEXT || c === `${AS_CONTEXT}#` || c === 'as:');
}

/** Make sure a document carries the ActivityStreams context (and the security context when it has a public key). */
export function withContext(d: Doc, ...extra: Json[]): Doc {
  const have = asArray(d['@context']);
  const want: Json[] = [AS_CONTEXT, ...(d['publicKey'] ? [SECURITY_CONTEXT] : []), ...extra];
  const merged = [...have];
  for (const w of want) if (!merged.some((h) => JSON.stringify(h) === JSON.stringify(w))) merged.push(w);
  return { ...d, '@context': merged.length === 1 ? merged[0]! : merged };
}

const isDoc = (v: Json | undefined): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkShape(v: Json, depth: number): void {
  if (depth > MAX_DEPTH) throw new ApError('invalid', `nesting deeper than ${MAX_DEPTH} levels`);
  if (Array.isArray(v)) v.forEach((x) => checkShape(x, depth + 1));
  else if (v && typeof v === 'object') for (const x of Object.values(v)) checkShape(x, depth + 1);
}

/** An https URL without credentials or fragments of up to 2048 characters; anything else throws. */
export function checkId(id: unknown, what: string): URL {
  if (typeof id !== 'string' || id.length === 0 || id.length > 2048) throw new ApError('invalid', `${what} must be a URL of up to 2048 characters`);
  let u: URL;
  try {
    u = new URL(id);
  } catch {
    throw new ApError('invalid', `${what} is not a URL`);
  }
  if (u.protocol !== 'https:') throw new ApError('invalid', `${what} must be an https URL`);
  if (u.username || u.password) throw new ApError('invalid', `${what} must not carry credentials`);
  return u;
}

export const hostOf = (id: string): string => new URL(id).host.toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Actors and discovery
// ---------------------------------------------------------------------------------------------------------------

export interface ActorInit {
  readonly id: string;
  readonly type?: (typeof ACTOR_TYPES)[number];
  readonly preferredUsername: string;
  readonly name?: string;
  readonly summary?: string;
  readonly inbox: string;
  readonly outbox: string;
  readonly followers?: string;
  readonly following?: string;
  readonly sharedInbox?: string;
  readonly publicKeyPem?: string;
  readonly manuallyApprovesFollowers?: boolean;
  readonly alsoKnownAs?: readonly string[];
  readonly movedTo?: string;
  readonly icon?: string;
}

/** An actor document that servers will accept. */
export function makeActor(a: ActorInit): Doc {
  checkId(a.id, 'actor id');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(a.preferredUsername)) throw new ApError('invalid', 'preferredUsername is letters, digits, _ . - up to 64 characters');
  const d: Doc = { id: a.id, type: a.type ?? 'Person', preferredUsername: a.preferredUsername, inbox: a.inbox, outbox: a.outbox };
  if (a.name !== undefined) d['name'] = a.name;
  if (a.summary !== undefined) d['summary'] = a.summary;
  if (a.followers) d['followers'] = a.followers;
  if (a.following) d['following'] = a.following;
  if (a.sharedInbox) d['endpoints'] = { sharedInbox: a.sharedInbox };
  if (a.publicKeyPem) d['publicKey'] = { id: `${a.id}#main-key`, owner: a.id, publicKeyPem: a.publicKeyPem };
  if (a.manuallyApprovesFollowers !== undefined) d['manuallyApprovesFollowers'] = a.manuallyApprovesFollowers;
  if (a.alsoKnownAs) d['alsoKnownAs'] = [...a.alsoKnownAs];
  if (a.movedTo) d['movedTo'] = a.movedTo;
  if (a.icon) d['icon'] = { type: 'Image', url: a.icon };
  const out = withContext(d);
  validateActor(out);
  return out;
}

/** Check an actor document received from elsewhere: right type, https ids, and endpoints on the actor's own host. */
export function validateActor(d: Doc): { id: string; inbox: string; sharedInbox: string | undefined; keyPem: string | undefined; keyId: string | undefined } {
  checkShape(d, 0);
  const types = typesOf(d);
  if (!types.some((t) => (ACTOR_TYPES as readonly string[]).includes(t))) throw new ApError('invalid', 'not an actor type');
  const id = checkId(d['id'], 'actor id');
  for (const f of ['inbox', 'outbox']) {
    const u = checkId(d[f], f);
    if (u.host.toLowerCase() !== id.host.toLowerCase()) throw new ApError('forbidden', `${f} is on another host than the actor`);
  }
  for (const f of ['followers', 'following']) if (d[f] !== undefined) checkId(d[f], f);
  const ep = isDoc(d['endpoints']) ? d['endpoints']['sharedInbox'] : undefined;
  if (ep !== undefined) checkId(ep, 'sharedInbox');
  const pk = isDoc(d['publicKey']) ? d['publicKey'] : undefined;
  if (pk) {
    if (typeof pk['id'] !== 'string' || pk['owner'] !== d['id']) throw new ApError('forbidden', 'the public key is not owned by the actor');
    if (typeof pk['publicKeyPem'] !== 'string' || !pk['publicKeyPem'].includes('PUBLIC KEY')) throw new ApError('invalid', 'the public key is not PEM');
  }
  return { id: d['id'] as string, inbox: d['inbox'] as string, sharedInbox: typeof ep === 'string' ? ep : undefined, keyPem: pk ? (pk['publicKeyPem'] as string) : undefined, keyId: pk ? (pk['id'] as string) : undefined };
}

/** `acct:user@host` or `user@host` to its parts; refuses anything else. */
export function parseAcct(resource: string): { user: string; host: string } {
  const m = /^(?:acct:)?@?([A-Za-z0-9_.-]{1,64})@([A-Za-z0-9.-]{1,253})$/.exec(resource.trim());
  if (!m) throw new ApError('invalid', 'not an acct: resource');
  return { user: m[1]!, host: m[2]!.toLowerCase() };
}

/** The WebFinger JRD (RFC 7033) that points `acct:user@host` at an actor. */
export function webfinger(user: string, host: string, actorUrl: string): Doc {
  checkId(actorUrl, 'actor url');
  return {
    subject: `acct:${user}@${host}`,
    aliases: [actorUrl],
    links: [{ rel: 'self', type: 'application/activity+json', href: actorUrl }],
  };
}

/** The actor URL a WebFinger answer gives, for the subject asked about. */
export function actorFromWebfinger(jrd: Doc, expected: string): string {
  if (jrd['subject'] !== `acct:${parseAcct(expected).user}@${parseAcct(expected).host}`) throw new ApError('forbidden', 'the answer is about another subject');
  for (const l of asArray(jrd['links'])) {
    if (isDoc(l) && l['rel'] === 'self' && typeof l['type'] === 'string' && /activity\+json|ld\+json/.test(l['type']) && typeof l['href'] === 'string') {
      checkId(l['href'], 'actor link');
      return l['href'];
    }
  }
  throw new ApError('invalid', 'no ActivityPub link in the answer');
}

// ---------------------------------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------------------------------

export interface Addressing {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly published?: string;
}

function activity(type: ActivityType, id: string, actor: string, fields: Doc, a: Addressing = {}): Doc {
  checkId(id, 'activity id');
  checkId(actor, 'actor');
  const d: Doc = { id, type, actor, ...fields };
  if (a.to) d['to'] = [...a.to];
  if (a.cc) d['cc'] = [...a.cc];
  if (a.published) d['published'] = a.published;
  return withContext(d);
}

/** Create copies the object's own addressing (to, cc) and published time unless told otherwise. */
export function create(id: string, actor: string, object: Doc, a: Addressing = {}): Doc {
  const published = a.published ?? (typeof object['published'] === 'string' ? object['published'] : undefined);
  return activity('Create', id, actor, { object }, {
    to: a.to ?? asArray(object['to']).filter((x): x is string => typeof x === 'string'),
    cc: a.cc ?? asArray(object['cc']).filter((x): x is string => typeof x === 'string'),
    ...(published !== undefined ? { published } : {}),
  });
}
export const update = (id: string, actor: string, object: Doc, a: Addressing = {}): Doc => activity('Update', id, actor, { object }, a);
/** Delete leaves a Tombstone so remote copies can be removed. */
export const remove = (id: string, actor: string, objectId: string, a: Addressing = {}): Doc => activity('Delete', id, actor, { object: { id: objectId, type: 'Tombstone' } }, a);
export const follow = (id: string, actor: string, target: string): Doc => activity('Follow', id, actor, { object: target }, { to: [target] });
export const accept = (id: string, actor: string, followActivity: Doc): Doc => activity('Accept', id, actor, { object: followActivity }, { to: [idOf(followActivity['actor']) ?? ''] });
export const reject = (id: string, actor: string, followActivity: Doc): Doc => activity('Reject', id, actor, { object: followActivity }, { to: [idOf(followActivity['actor']) ?? ''] });
export const like = (id: string, actor: string, objectId: string, a: Addressing = {}): Doc => activity('Like', id, actor, { object: objectId }, a);
export const announce = (id: string, actor: string, objectId: string, a: Addressing = { to: [PUBLIC] }): Doc => activity('Announce', id, actor, { object: objectId }, a);
export const block = (id: string, actor: string, target: string): Doc => activity('Block', id, actor, { object: target });
export const undo = (id: string, actor: string, inner: Doc, a: Addressing = {}): Doc => activity('Undo', id, actor, { object: inner }, a);
/** Tell followers an account moved: `object` is the old actor, `target` the new one. */
export const move = (id: string, actor: string, oldActor: string, newActor: string, a: Addressing = {}): Doc => activity('Move', id, actor, { object: oldActor, target: newActor }, a);

const NEEDS_OBJECT = new Set<string>(['Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Undo', 'Like', 'Announce', 'Block', 'Move', 'Add', 'Remove', 'Flag']);

export interface Checked {
  readonly doc: Doc;
  readonly type: ActivityType;
  readonly id: string;
  readonly actor: string;
}

/** Check an incoming activity's shape and the host rules that stop spoofing. Throws ApError. */
export function validateActivity(doc: unknown): Checked {
  if (!isDoc(doc as Json)) throw new ApError('invalid', 'an activity is a JSON object');
  const d = doc as Doc;
  if (JSON.stringify(d).length > MAX_DOCUMENT) throw new ApError('invalid', 'the document is over 1 MB');
  checkShape(d, 0);
  if (!hasActivityStreamsContext(d)) throw new ApError('invalid', 'the ActivityStreams @context is missing');
  const type = typesOf(d).find((t): t is ActivityType => (ACTIVITY_TYPES as readonly string[]).includes(t));
  if (!type) throw new ApError('unsupported', `not an activity type this server handles: ${typesOf(d).join(',') || 'none'}`);
  checkId(d['id'], 'id');
  const id = d['id'] as string;
  const actor = idOf(d['actor']);
  if (!actor) throw new ApError('invalid', 'actor is missing');
  checkId(actor, 'actor');
  const object = d['object'];
  if (NEEDS_OBJECT.has(type) && (object === undefined || object === null)) throw new ApError('invalid', `${type} needs an object`);
  const oid = idOf(object);
  if (type === 'Move' && !idOf(d['target'])) throw new ApError('invalid', 'Move needs a target');
  if ((type === 'Create' || type === 'Update') && !isDoc(object)) throw new ApError('invalid', `${type} needs the object embedded`);
  if (oid !== undefined) checkId(oid, 'object id');
  if ((type === 'Create' || type === 'Update' || type === 'Delete') && oid !== undefined && hostOf(oid) !== hostOf(actor)) {
    throw new ApError('forbidden', `${type} of an object on another host than the actor`);
  }
  if (type === 'Create' && isDoc(object) && object['attributedTo'] !== undefined && idOf(object['attributedTo']) !== actor) {
    throw new ApError('forbidden', 'the object is attributed to someone other than the actor');
  }
  if (type === 'Move' && hostOf(idOf(object)!) !== hostOf(actor) && idOf(object) !== actor) throw new ApError('forbidden', 'only an actor can move itself');
  return { doc: d, type, id, actor };
}

// ---------------------------------------------------------------------------------------------------------------
// Ordered collections
// ---------------------------------------------------------------------------------------------------------------

export const orderedCollection = (id: string, totalItems: number, first: string): Doc => withContext({ id, type: 'OrderedCollection', totalItems, first });

export interface PageOptions {
  /** Page url base, e.g. https://a.example/users/x/outbox */
  readonly id: string;
  readonly limit?: number;
  /** Return items strictly older than this key (the `max_id` of the page before). */
  readonly maxKey?: string;
}

/** A newest-first collection of items with stable keys, served as an ActivityStreams OrderedCollection and its pages. */
export class CollectionStore {
  readonly #items: { key: string; item: Json }[] = [];
  readonly #keys = new Set<string>();

  get totalItems(): number {
    return this.#items.length;
  }

  /** Add an item; keys must sort in time order (an increasing counter or a time-ordered id). Duplicate keys are ignored. */
  add(key: string, item: Json): boolean {
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    this.#items.push({ key, item });
    this.#items.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    return true;
  }

  remove(key: string): boolean {
    if (!this.#keys.delete(key)) return false;
    this.#items.splice(this.#items.findIndex((x) => x.key === key), 1);
    return true;
  }

  has(key: string): boolean {
    return this.#keys.has(key);
  }

  /** The collection document, pointing at its first page. */
  collection(id: string): Doc {
    return orderedCollection(id, this.#items.length, `${id}?page=true`);
  }

  /** One page, newest first, with `next` for older items and `prev` for newer ones. */
  page(o: PageOptions): Doc {
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 100);
    const older = o.maxKey === undefined ? this.#items : this.#items.filter((x) => x.key < o.maxKey!);
    const slice = older.slice(0, limit);
    const d: Doc = {
      id: `${o.id}?page=true${o.maxKey ? `&max_id=${encodeURIComponent(o.maxKey)}` : ''}`,
      type: 'OrderedCollectionPage',
      partOf: o.id,
      orderedItems: slice.map((x) => x.item),
    };
    if (older.length > slice.length) d['next'] = `${o.id}?page=true&max_id=${encodeURIComponent(slice[slice.length - 1]!.key)}`;
    if (o.maxKey !== undefined && slice.length > 0) d['prev'] = `${o.id}?page=true&min_id=${encodeURIComponent(slice[0]!.key)}`;
    return withContext(d);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------------------------------------------

export type InboxEvent =
  | { readonly kind: 'follow-request'; readonly actor: string; readonly activity: string }
  | { readonly kind: 'follower-added'; readonly actor: string }
  | { readonly kind: 'follower-removed'; readonly actor: string }
  | { readonly kind: 'follow-accepted' | 'follow-rejected'; readonly actor: string }
  | { readonly kind: 'like' | 'unlike' | 'announce' | 'unannounce'; readonly actor: string; readonly object: string }
  | { readonly kind: 'create' | 'update'; readonly actor: string; readonly object: Doc }
  | { readonly kind: 'delete'; readonly actor: string; readonly object: string }
  | { readonly kind: 'move-claimed'; readonly from: string; readonly to: string }
  | { readonly kind: 'blocked'; readonly actor: string };

export interface Received {
  readonly status: 'processed' | 'ignored';
  readonly events: InboxEvent[];
  /** Activities to deliver in answer, such as an Accept of a Follow. */
  readonly outgoing: Doc[];
}

export interface InboxOptions {
  /** The local actor this inbox serves. */
  readonly self: string;
  readonly manuallyApprovesFollowers?: boolean;
  /** Makes ids for answers such as Accept: called with a short label. */
  readonly newId: (label: string) => string;
  /** How many activity ids to remember for replay checks. Default 10,000. */
  readonly maxSeen?: number;
}

interface Remembered {
  readonly type: 'Follow' | 'Like' | 'Announce';
  readonly actor: string;
  readonly object: string;
  readonly doc: Doc;
}

export class Inbox {
  readonly self: string;
  readonly followers = new Set<string>();
  readonly following = new Map<string, 'pending' | 'accepted'>();
  readonly blocked = new Set<string>();
  readonly likes = new Map<string, Set<string>>();
  readonly announces = new Map<string, Set<string>>();
  /** Follow requests waiting for a decision, by activity id. */
  readonly pending = new Map<string, Doc>();
  readonly #o: InboxOptions;
  readonly #seen = new Set<string>();
  readonly #remembered = new Map<string, Remembered>();
  readonly #outgoingFollows = new Map<string, string>();

  constructor(o: InboxOptions) {
    checkId(o.self, 'self');
    this.self = o.self;
    this.#o = o;
  }

  #remember(id: string): void {
    this.#seen.add(id);
    if (this.#seen.size > (this.#o.maxSeen ?? 10_000)) this.#seen.delete(this.#seen.values().next().value!);
  }

  /** Build a Follow to send, and remember it so the Accept can be matched. */
  startFollow(target: string): Doc {
    const id = this.#o.newId('follow');
    this.following.set(target, 'pending');
    this.#outgoingFollows.set(id, target);
    return follow(id, this.self, target);
  }

  /** Approve a waiting follow request. Returns the Accept to send. */
  approve(followId: string): Doc {
    const f = this.pending.get(followId);
    if (!f) throw new ApError('invalid', 'no such follow request is waiting');
    this.pending.delete(followId);
    this.followers.add(idOf(f['actor'])!);
    return accept(this.#o.newId('accept'), this.self, f);
  }

  deny(followId: string): Doc {
    const f = this.pending.get(followId);
    if (!f) throw new ApError('invalid', 'no such follow request is waiting');
    this.pending.delete(followId);
    return reject(this.#o.newId('reject'), this.self, f);
  }

  /**
   * Take one verified delivery. `signer` is the actor id the HTTP signature's key belongs to; the activity must be
   * by that actor. Throws ApError for anything refused; a replay throws `duplicate`.
   */
  receive(doc: unknown, signer: string): Received {
    const c = validateActivity(doc);
    if (c.actor !== signer) throw new ApError('forbidden', 'the signature belongs to another actor than the activity');
    if (this.#seen.has(c.id)) throw new ApError('duplicate', 'this activity was already received');
    this.#remember(c.id);
    if (this.blocked.has(c.actor)) return { status: 'ignored', events: [], outgoing: [] };
    const events: InboxEvent[] = [];
    const outgoing: Doc[] = [];
    const object = c.doc['object'] as Json;
    const oid = idOf(object);
    switch (c.type) {
      case 'Follow': {
        if (oid !== this.self) return { status: 'ignored', events, outgoing };
        this.#remembered.set(c.id, { type: 'Follow', actor: c.actor, object: oid, doc: c.doc });
        if (this.#o.manuallyApprovesFollowers) {
          this.pending.set(c.id, c.doc);
          events.push({ kind: 'follow-request', actor: c.actor, activity: c.id });
        } else {
          this.followers.add(c.actor);
          events.push({ kind: 'follower-added', actor: c.actor });
          outgoing.push(accept(this.#o.newId('accept'), this.self, c.doc));
        }
        break;
      }
      case 'Accept':
      case 'Reject': {
        const fid = idOf(object);
        const target = fid ? this.#outgoingFollows.get(fid) : undefined;
        if (!target) return { status: 'ignored', events, outgoing };
        if (target !== c.actor) throw new ApError('forbidden', 'the answer to a Follow came from someone other than who was asked');
        this.#outgoingFollows.delete(fid!);
        if (c.type === 'Accept') {
          this.following.set(target, 'accepted');
          events.push({ kind: 'follow-accepted', actor: target });
        } else {
          this.following.delete(target);
          events.push({ kind: 'follow-rejected', actor: target });
        }
        break;
      }
      case 'Like':
      case 'Announce': {
        const map = c.type === 'Like' ? this.likes : this.announces;
        const set = map.get(oid!) ?? new Set<string>();
        set.add(c.actor);
        map.set(oid!, set);
        this.#remembered.set(c.id, { type: c.type, actor: c.actor, object: oid!, doc: c.doc });
        events.push({ kind: c.type === 'Like' ? 'like' : 'announce', actor: c.actor, object: oid! });
        break;
      }
      case 'Undo': {
        const innerId = idOf(object);
        const mem = innerId ? this.#remembered.get(innerId) : undefined;
        const innerActor = isDoc(object) ? idOf(object['actor']) : mem?.actor;
        if (innerActor !== undefined && innerActor !== c.actor) throw new ApError('forbidden', 'an Undo by someone other than the original actor');
        if (!mem) return { status: 'ignored', events, outgoing };
        if (mem.actor !== c.actor) throw new ApError('forbidden', 'an Undo by someone other than the original actor');
        this.#remembered.delete(innerId!);
        if (mem.type === 'Follow') {
          this.followers.delete(mem.actor);
          this.pending.delete(innerId!);
          events.push({ kind: 'follower-removed', actor: mem.actor });
        } else {
          (mem.type === 'Like' ? this.likes : this.announces).get(mem.object)?.delete(mem.actor);
          events.push({ kind: mem.type === 'Like' ? 'unlike' : 'unannounce', actor: mem.actor, object: mem.object });
        }
        break;
      }
      case 'Create':
      case 'Update':
        events.push({ kind: c.type === 'Create' ? 'create' : 'update', actor: c.actor, object: object as Doc });
        break;
      case 'Delete':
        events.push({ kind: 'delete', actor: c.actor, object: oid! });
        if (oid === c.actor) {
          this.followers.delete(c.actor);
          this.following.delete(c.actor);
        }
        break;
      case 'Block':
        if (oid === this.self) {
          this.followers.delete(c.actor);
          events.push({ kind: 'blocked', actor: c.actor });
        }
        break;
      case 'Move':
        events.push({ kind: 'move-claimed', from: oid!, to: idOf(c.doc['target'])! });
        break;
      default:
        return { status: 'ignored', events, outgoing };
    }
    return { status: 'processed', events, outgoing };
  }

  /** Block an actor locally: they stop being a follower and their deliveries are ignored. */
  blockActor(actor: string): void {
    this.blocked.add(actor);
    this.followers.delete(actor);
  }

  /**
   * Act on a Move once both actor documents agree: the old actor's `movedTo` names the new one and the new one's
   * `alsoKnownAs` names the old. Returns the Follow and Undo to send for each account we followed, or throws.
   */
  confirmMove(oldDoc: Doc, newDoc: Doc): Doc[] {
    const from = checkId(oldDoc['id'], 'old actor id').href;
    const to = checkId(newDoc['id'], 'new actor id').href;
    if (idOf(oldDoc['movedTo']) !== to) throw new ApError('forbidden', 'the old account does not say it moved to the new one');
    if (!asArray(newDoc['alsoKnownAs']).some((x) => x === from)) throw new ApError('forbidden', 'the new account does not list the old one in alsoKnownAs');
    const out: Doc[] = [];
    if (this.following.has(from)) {
      this.following.delete(from);
      out.push(this.startFollow(to));
    }
    if (this.followers.delete(from)) this.followers.add(to);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery planning
// ---------------------------------------------------------------------------------------------------------------

export interface ActorInfo {
  readonly inbox: string;
  readonly sharedInbox?: string | undefined;
}

export interface Plan {
  /** Inbox urls to POST to, one per server where a shared inbox exists. */
  readonly inboxes: string[];
  /** The activity as it goes on the wire, with `bto` and `bcc` removed. */
  readonly body: Doc;
}

/**
 * Work out where to send an activity. Recipients come from to, cc, bto, bcc and audience; the public collection
 * is not an inbox; the sender's own followers collection expands through `followersOf`; the sender never gets its
 * own copy; shared inboxes collapse many recipients on one server into one request.
 */
export function planDelivery(activityDoc: Doc, sender: string, followersOf: () => readonly string[], lookup: (actorId: string) => ActorInfo | undefined, o: { followersCollection?: string } = {}): Plan {
  const wanted = new Set<string>();
  for (const f of ['to', 'cc', 'bto', 'bcc', 'audience']) for (const r of asArray(activityDoc[f])) {
    const id = idOf(r);
    if (id) wanted.add(id);
  }
  const recipients = new Set<string>();
  for (const r of wanted) {
    if (r === PUBLIC || r === 'as:Public' || r === 'Public' || r === sender) continue;
    if (o.followersCollection !== undefined && r === o.followersCollection) for (const f of followersOf()) recipients.add(f);
    else recipients.add(r);
  }
  recipients.delete(sender);
  const inboxes = new Set<string>();
  for (const r of recipients) {
    const info = lookup(r);
    if (!info) continue;
    inboxes.add(info.sharedInbox ?? info.inbox);
  }
  const body = { ...activityDoc };
  delete body['bto'];
  delete body['bcc'];
  return { inboxes: [...inboxes].sort(), body };
}

export interface Sender {
  readonly keyId: string;
  readonly privateKey: KeyObject | string;
  readonly now: () => number;
  readonly send: (inbox: string, req: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
}

/** Sign and POST a plan to every inbox. Returns what each answered; one failure does not stop the others. */
export async function deliver(plan: Plan, s: Sender): Promise<{ inbox: string; status: number | 'error'; ok: boolean }[]> {
  const body = JSON.stringify(plan.body);
  const out: { inbox: string; status: number | 'error'; ok: boolean }[] = [];
  for (const inbox of plan.inboxes) {
    try {
      const headers = signRequest({ method: 'POST', url: inbox, body, keyId: s.keyId, privateKey: s.privateKey, now: s.now() });
      headers['content-type'] = 'application/activity+json';
      const r = await s.send(inbox, { method: 'POST', headers, body });
      out.push({ inbox, status: r.status, ok: r.status >= 200 && r.status < 300 });
    } catch {
      out.push({ inbox, status: 'error', ok: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP Signatures (draft-cavage-http-signatures-12, as used by the fediverse)
// ---------------------------------------------------------------------------------------------------------------

export const SIGNED_HEADERS_POST = ['(request-target)', 'host', 'date', 'digest'] as const;

const lowerHeaders = (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

export const digestOf = (body: string | Uint8Array): string => `SHA-256=${createHash('sha256').update(body).digest('base64')}`;

export interface SignInput {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
  readonly keyId: string;
  readonly privateKey: KeyObject | string;
  readonly now: number;
  /** Extra headers, signed only if listed in `headers`. */
  readonly extra?: Record<string, string>;
  readonly headers?: readonly string[];
}

function signingString(names: readonly string[], method: string, u: URL, h: Record<string, string>): string {
  return names
    .map((n) => {
      if (n === '(request-target)') return `(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}`;
      const v = h[n];
      if (v === undefined) throw new ApError('signature', `the signed header ${n} is missing`);
      return `${n}: ${v}`;
    })
    .join('\n');
}

/** Headers (Host, Date, Digest for a body, and Signature) for an outgoing request. RSA-SHA256 or Ed25519 by key type. */
export function signRequest(i: SignInput): Record<string, string> {
  const u = new URL(i.url);
  const h: Record<string, string> = { host: u.host, date: new Date(i.now).toUTCString(), ...lowerHeaders(i.extra ?? {}) };
  const hasBody = i.body !== undefined;
  if (hasBody) h['digest'] = digestOf(i.body!);
  const names = i.headers ?? (hasBody ? SIGNED_HEADERS_POST : ['(request-target)', 'host', 'date']);
  const text = signingString(names, i.method, u, h);
  const key = typeof i.privateKey === 'string' ? undefined : i.privateKey;
  const isEd = key?.asymmetricKeyType === 'ed25519';
  const sig = isEd ? cryptoSign(null, Buffer.from(text), key!).toString('base64') : createSign('RSA-SHA256').update(text).sign(i.privateKey).toString('base64');
  h['signature'] = `keyId="${i.keyId}",algorithm="${isEd ? 'ed25519' : 'rsa-sha256'}",headers="${names.join(' ')}",signature="${sig}"`;
  return h;
}

export interface SignatureParts {
  readonly keyId: string;
  readonly algorithm: string | undefined;
  readonly headers: string[];
  readonly signature: string;
  readonly created: number | undefined;
  readonly expires: number | undefined;
}

/** Read a Signature header. Refuses repeated parameters and anything it cannot parse. */
export function parseSignatureHeader(value: string): SignatureParts {
  if (value.length > 4096) throw new ApError('signature', 'the Signature header is too long');
  const params = new Map<string, string>();
  const re = /\s*([A-Za-z]+)="([^"]*)"\s*(?:,|$)/y;
  let pos = 0;
  while (pos < value.length) {
    re.lastIndex = pos;
    const m = re.exec(value);
    if (!m) throw new ApError('signature', 'the Signature header is malformed');
    if (params.has(m[1]!)) throw new ApError('signature', `the Signature header repeats ${m[1]}`);
    params.set(m[1]!, m[2]!);
    pos = re.lastIndex;
  }
  const keyId = params.get('keyId');
  const signature = params.get('signature');
  if (!keyId || !signature) throw new ApError('signature', 'the Signature header lacks keyId or signature');
  return {
    keyId,
    algorithm: params.get('algorithm'),
    headers: (params.get('headers') ?? 'date').split(/\s+/).filter(Boolean).map((x) => x.toLowerCase()),
    signature,
    created: params.has('created') ? Number(params.get('created')) : undefined,
    expires: params.has('expires') ? Number(params.get('expires')) : undefined,
  };
}

export interface VerifyInput {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array;
  readonly now: number;
  /** The public key for the signature's keyId, fetched by the caller. */
  readonly publicKey: (keyId: string) => KeyObject | string | undefined;
  /** Allowed clock difference in ms. Default 5 minutes. */
  readonly maxSkewMs?: number;
}

/**
 * Verify a signed request and return the keyId that signed it. Requires the signature to cover the request target,
 * host and date, and for a body also the Digest, checks that Digest against the bytes received, and refuses a Date
 * outside the allowed skew, an unknown algorithm, and a missing key.
 */
export function verifyRequest(i: VerifyInput): string {
  const h = lowerHeaders(i.headers);
  const sigHeader = h['signature'];
  if (!sigHeader) throw new ApError('signature', 'there is no Signature header');
  const p = parseSignatureHeader(sigHeader);
  const required = i.body !== undefined && (i.method.toUpperCase() === 'POST' || i.body.length > 0) ? SIGNED_HEADERS_POST : (['(request-target)', 'host', 'date'] as const);
  for (const r of required) if (!p.headers.includes(r)) throw new ApError('signature', `the signature does not cover ${r}`);
  const algo = (p.algorithm ?? 'hs2019').toLowerCase();
  if (!['rsa-sha256', 'hs2019', 'ed25519'].includes(algo)) throw new ApError('signature', `unsupported algorithm ${algo}`);
  const dateStr = h['date'];
  const t = dateStr ? Date.parse(dateStr) : Number.NaN;
  if (!Number.isFinite(t)) throw new ApError('signature', 'the Date header is missing or not a date');
  if (Math.abs(i.now - t) > (i.maxSkewMs ?? 300_000)) throw new ApError('signature', 'the Date is too far from now');
  if (i.body !== undefined) {
    const want = digestOf(i.body);
    const got = h['digest'] ?? '';
    const a = Buffer.from(want);
    const b = Buffer.from(got);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApError('signature', 'the Digest does not match the body');
  }
  const key = i.publicKey(p.keyId);
  if (!key) throw new ApError('signature', `no key for ${p.keyId}`);
  const u = new URL(i.url);
  const text = signingString(p.headers, i.method, u, h);
  const ko = typeof key === 'string' ? createPublicKey(key) : key;
  const sig = Buffer.from(p.signature, 'base64');
  const ok = ko.asymmetricKeyType === 'ed25519' ? cryptoVerify(null, Buffer.from(text), ko, sig) : createVerify('RSA-SHA256').update(text).verify(ko, sig);
  if (!ok) throw new ApError('signature', 'the signature does not verify');
  return p.keyId;
}
