/**
 * Mail into conversations, and mail loops stopped. Headers: unfolding (RFC 5322), message ids and the References /
 * In-Reply-To lists, and RFC 2047 encoded words (UTF-8, Latin-1 and other charsets, B and Q forms). Subjects: the
 * "base subject" of RFC 5256 section 2.1 (Re:, Fw:, Fwd:, localised prefixes such as AW: and SV:, counters like
 * Re[2]:, [list tags], "(fwd)" trailers and [Fwd: ...] wrappers, whitespace and case folded) so replies group with
 * what they answer. Threads: the JWZ algorithm (Jamie Zawinski, "Message Threading", the one behind RFC 5256's
 * REFERENCES threading): containers keyed by Message-ID, References chains linked without ever making a loop, a
 * missing parent kept as an empty placeholder so a thread is not split by one lost message, empty containers pruned,
 * and root threads with the same base subject merged only when one is clearly a reply. A ThreadIndex does the same
 * incrementally with stable thread ids for ticketing and inboxes (union-find over message ids, falling back to the
 * subject only for replies inside a time window). Loops: Auto-Submitted (RFC 3834) and the other signs of machine
 * mail (null return path, delivery reports, Precedence bulk, list headers, vendor autoreply headers, no-reply
 * senders, too many Received hops), a rule for whether an automatic reply may be sent at all with a per-sender
 * rate limit, and the headers such a reply must carry (Auto-Submitted: auto-replied, In-Reply-To and References per
 * RFC 5322 section 3.6.4). Out of scope: parsing MIME bodies (the mime block), sending (the notify and smtp work),
 * and language detection beyond the listed reply prefixes.
 */

export class ThreadingError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Headers

export interface Header {
  readonly name: string;
  readonly value: string;
}

const MAX_HEADER_BYTES = 256 * 1024;

/** Parses a header block (up to the first blank line), unfolding continuation lines. Names are kept as written. */
export function parseHeaders(raw: string): Header[] {
  if (raw.length > MAX_HEADER_BYTES) throw new ThreadingError(`a header block may be at most ${MAX_HEADER_BYTES} characters`);
  const block = raw.split(/\r?\n\r?\n/)[0]!;
  const out: Header[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      const last = out[out.length - 1];
      if (last) out[out.length - 1] = { name: last.name, value: `${last.value} ${line.trim()}` };
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0 || /[\s\u0000-\u001f]/.test(line.slice(0, i))) continue;
    out.push({ name: line.slice(0, i), value: line.slice(i + 1).trim() });
  }
  return out;
}

const first = (hs: readonly Header[], name: string): string | undefined => hs.find((h) => h.name.toLowerCase() === name)?.value;
const all = (hs: readonly Header[], name: string): string[] => hs.filter((h) => h.name.toLowerCase() === name).map((h) => h.value);

/** Message ids in a header value, in order: everything in angle brackets that looks like id@host. Duplicates are kept once. */
export function parseIdList(value: string | undefined): string[] {
  if (!value || value.length > 64 * 1024) return [];
  const ids: string[] = [];
  for (const m of value.matchAll(/<([^<>\s@()]+@[^<>\s()]+)>/g)) if (!ids.includes(`<${m[1]}>`) && m[1]!.length <= 998) ids.push(`<${m[1]}>`);
  return ids;
}

/** A Message-ID made from a random source (injected) and a domain, in the form RFC 5322 asks for. */
export function generateMessageId(domain: string, random: Uint8Array): string {
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain)) throw new ThreadingError(`"${domain}" is not a domain for a Message-ID`);
  if (random.length < 8) throw new ThreadingError('a Message-ID needs at least 8 random bytes');
  return `<${[...random].map((b) => b.toString(16).padStart(2, '0')).join('')}@${domain.toLowerCase()}>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Subjects

/** Decodes RFC 2047 encoded words (=?charset?B|Q?text?=); words separated only by whitespace are joined. Unknown charsets are left as written. */
export function decodeWords(s: string): string {
  const word = /=\?([A-Za-z0-9_-]+)(?:\*[A-Za-z-]+)?\?([BbQq])\?([^?\s]*)\?=/g;
  let out = '';
  let last = 0;
  let prevEncoded = false;
  for (const m of s.matchAll(word)) {
    const between = s.slice(last, m.index);
    if (!(prevEncoded && /^\s*$/.test(between))) out += between;
    let bytes: Uint8Array;
    try {
      if (m[2]!.toUpperCase() === 'B') bytes = Uint8Array.from(Buffer.from(m[3]!, 'base64'));
      else {
        const q = m[3]!.replace(/_/g, ' ');
        const arr: number[] = [];
        for (let i = 0; i < q.length; i++) {
          if (q[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) {
            arr.push(parseInt(q.slice(i + 1, i + 3), 16));
            i += 2;
          } else arr.push(q.charCodeAt(i) & 0xff);
        }
        bytes = Uint8Array.from(arr);
      }
      out += new TextDecoder(m[1]!.toLowerCase()).decode(bytes);
    } catch {
      out += m[0];
    }
    last = m.index! + m[0].length;
    prevEncoded = true;
  }
  return out + s.slice(last);
}

const LEADER = /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw|rv|tr|enc|odp|res|rif|vb)(?:\s*\[\s*\d+\s*\]|\s*\(\s*\d+\s*\))?\s*[:：]|(?:回复|答复|转发|回覆|轉寄|返信|回信|답장|전달)\s*[:：])\s*/iu;
const BLOB = /^\s*\[[^[\]]*\]\s*/;

/** The subject with reply, forward and list decorations removed (RFC 5256 base subject), whitespace collapsed. Case is kept. */
export function baseSubject(subject: string): string {
  let s = decodeWords(subject).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let guard = 0; guard < 50; guard++) {
    const before = s;
    s = s.replace(/(?:\s*\(fwd\))+\s*$/i, '').trim();
    // subj-leader: optional [blobs], then re/fw/fwd with optional counter and a colon.
    let t = s;
    while (BLOB.test(t) && LEADER.test(t.replace(BLOB, ''))) t = t.replace(BLOB, '');
    if (LEADER.test(t)) s = t.replace(LEADER, '');
    else if (BLOB.test(s) && s.replace(BLOB, '').trim()) {
      // A leading [list-tag] is removed only when something remains.
      s = s.replace(BLOB, '');
    }
    const wrapped = /^\[\s*fwd?\s*:\s*(.*)\]\s*$/i.exec(s);
    if (wrapped) s = wrapped[1]!.trim();
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

/** Whether a subject is a reply or forward (it had a leader that the base subject dropped). */
export function isReply(subject: string): boolean {
  const s = decodeWords(subject).replace(/\s+/g, ' ').trim();
  if (/^\[\s*fwd?\s*:/i.test(s)) return true;
  let t = s;
  while (BLOB.test(t) && !LEADER.test(t)) t = t.replace(BLOB, '');
  return LEADER.test(t);
}

/** The key two subjects share when they belong together: base subject, case-folded. */
export const subjectKey = (subject: string): string => baseSubject(subject).toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Messages and the JWZ algorithm

export interface Message {
  /** Your own id for the stored message. */
  readonly id: string;
  /** The Message-ID header, with angle brackets. */
  readonly messageId?: string;
  readonly inReplyTo?: readonly string[];
  readonly references?: readonly string[];
  readonly subject: string;
  /** Sent date, ms since the epoch. */
  readonly date: number;
}

/** Builds a Message from a raw header block. Without a Message-ID the message still threads by what it references. */
export function messageFromHeaders(id: string, raw: string, fallbackDate = 0): Message {
  const hs = parseHeaders(raw);
  const mid = parseIdList(first(hs, 'message-id'))[0];
  const d = Date.parse(first(hs, 'date') ?? '');
  return {
    id,
    ...(mid ? { messageId: mid } : {}),
    inReplyTo: parseIdList(first(hs, 'in-reply-to')),
    references: parseIdList(first(hs, 'references')),
    subject: decodeWords(first(hs, 'subject') ?? ''),
    date: Number.isFinite(d) ? d : fallbackDate,
  };
}

export interface ThreadNode {
  /** The Message-ID this node stands for (a placeholder's id is one that others referenced). */
  readonly messageId: string | null;
  /** Absent for a placeholder: a message other messages answer that is not in the set. */
  readonly message: Message | null;
  readonly children: ThreadNode[];
}

export interface Thread {
  readonly root: ThreadNode;
  readonly subject: string;
  readonly count: number;
  readonly first: number;
  readonly last: number;
}

interface Box {
  messageId: string | null;
  message: Message | null;
  parent: Box | null;
  children: Box[];
}

function descendant(a: Box, of: Box): boolean {
  for (let p: Box | null = a; p; p = p.parent) if (p === of) return true;
  return false;
}

function link(parent: Box, child: Box): void {
  if (parent === child || descendant(parent, child)) return;
  if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
  child.parent = parent;
  parent.children.push(child);
}

const firstMessage = (b: Box): Message | null => b.message ?? b.children.map(firstMessage).find((m) => m) ?? null;

export interface ThreadOptions {
  /** Merge root threads that share a base subject when one is a reply. Default true. */
  readonly bySubject?: boolean;
}

/** Threads messages by References and In-Reply-To (JWZ), optionally joining roots by subject. Threads and children are sorted by date. */
export function buildThreads(messages: readonly Message[], o: ThreadOptions = {}): Thread[] {
  const table = new Map<string, Box>();
  const boxFor = (id: string): Box => {
    let b = table.get(id);
    if (!b) table.set(id, (b = { messageId: id, message: null, parent: null, children: [] }));
    return b;
  };
  const loose: Box[] = [];
  for (const m of messages) {
    let box: Box;
    const existing = m.messageId ? table.get(m.messageId) : undefined;
    if (m.messageId && (!existing || !existing.message)) {
      box = boxFor(m.messageId);
      box.message = m;
    } else {
      // No id, or a duplicate id: the message stands alone (the first one keeps the id).
      box = { messageId: null, message: m, parent: null, children: [] };
      loose.push(box);
    }
    const refs = (m.references?.length ? m.references : m.inReplyTo ?? []).filter((r) => r !== m.messageId);
    let prev: Box | undefined;
    for (const r of refs) {
      const b = boxFor(r);
      if (prev && !b.parent) link(prev, b);
      prev = b;
    }
    if (prev && prev !== box) {
      if (box.parent && box.parent !== prev) box.parent.children = box.parent.children.filter((c) => c !== box);
      if (box.parent !== prev) {
        box.parent = null;
        link(prev, box);
      }
    }
  }
  const all = [...table.values(), ...loose];
  let roots = all.filter((b) => !b.parent);
  // Prune empty containers.
  const prune = (list: Box[], top: boolean): Box[] => {
    const out: Box[] = [];
    for (const b of list) {
      b.children = prune(b.children, false);
      for (const c of b.children) c.parent = b;
      if (!b.message && !b.children.length) continue;
      if (!b.message && b.children.length && (!top || b.children.length === 1)) {
        for (const c of b.children) c.parent = null;
        out.push(...b.children);
        continue;
      }
      out.push(b);
    }
    return out;
  };
  roots = prune(roots, true);
  roots.forEach((r) => (r.parent = null));
  if (o.bySubject ?? true) {
    const subjects = new Map<string, Box>();
    const keyOf = (b: Box) => {
      const m = firstMessage(b);
      return m ? subjectKey(m.subject) : '';
    };
    const replyOf = (b: Box) => {
      const m = b.message ?? firstMessage(b);
      return !!m && isReply(m.subject);
    };
    for (const r of roots) {
      const k = keyOf(r);
      if (!k) continue;
      const cur = subjects.get(k);
      if (!cur || (r.message === null && cur.message !== null) || (replyOf(cur) && !replyOf(r) && !(cur.message === null && r.message !== null))) subjects.set(k, r);
    }
    const merged = new Set<Box>();
    for (const r of roots) {
      const k = keyOf(r);
      const t = k ? subjects.get(k) : undefined;
      if (!t || t === r || merged.has(r)) continue;
      if (r.message === null && t.message === null) {
        t.children.push(...r.children);
        r.children.forEach((c) => (c.parent = t));
        r.children = [];
        merged.add(r);
      } else if (r.message === null || t.message === null) {
        const [empty, full] = r.message === null ? [r, t] : [t, r];
        empty.children.push(full);
        full.parent = empty;
        merged.add(full === r ? r : t);
      } else if (!replyOf(r) && replyOf(t)) {
        // r is the original, t a reply that won the table: attach the reply.
        r.children.push(t);
        t.parent = r;
        merged.add(t);
        subjects.set(k, r);
      } else if (replyOf(r) && !replyOf(t)) {
        t.children.push(r);
        r.parent = t;
        merged.add(r);
      } else if (replyOf(r) && replyOf(t)) {
        const dummy: Box = { messageId: null, message: null, parent: null, children: [t, r] };
        t.parent = dummy;
        r.parent = dummy;
        subjects.set(k, dummy);
        merged.add(r);
        merged.add(t);
        roots.push(dummy);
      }
    }
    roots = roots.filter((r) => !r.parent && !merged.has(r));
  }
  const when = (b: Box): number => Math.min(...[b.message?.date ?? Infinity, ...b.children.map(when)]);
  const toNode = (b: Box): ThreadNode => ({ messageId: b.messageId, message: b.message, children: [...b.children].sort((x, y) => when(x) - when(y)).map(toNode) });
  const count = (n: ThreadNode): number => (n.message ? 1 : 0) + n.children.reduce((a, c) => a + count(c), 0);
  const dates = (n: ThreadNode): number[] => [...(n.message ? [n.message.date] : []), ...n.children.flatMap(dates)];
  return roots
    .filter((r, i, a) => a.indexOf(r) === i && !r.parent)
    .sort((x, y) => when(x) - when(y))
    .map((r) => {
      const root = toNode(r);
      const ds = dates(root);
      const m = firstMessage(r);
      return { root, subject: m ? baseSubject(m.subject) : '', count: count(root), first: Math.min(...ds), last: Math.max(...ds) };
    });
}

/** The messages of a thread in reading order, each with its depth. Placeholders are included with message null. */
export function flatten(t: Thread): { node: ThreadNode; depth: number }[] {
  const out: { node: ThreadNode; depth: number }[] = [];
  const walk = (n: ThreadNode, depth: number) => {
    out.push({ node: n, depth });
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(t.root, 0);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Incremental threading

export interface IngestResult {
  /** Stable for the life of the thread: the id of the earliest message id the thread was ever known by. */
  readonly threadId: string;
  readonly isNew: boolean;
  /** Thread ids that this message joined into `threadId`. */
  readonly merged: readonly string[];
  readonly via: 'references' | 'in-reply-to' | 'subject' | 'new';
}

export interface IndexOptions {
  /** How far apart replies may be and still join by subject alone. Default 30 days. */
  readonly subjectWindowMs?: number;
  readonly maxMessages?: number;
}

/** Assigns messages to threads one at a time, so a reply attaches to its ticket or conversation without re-threading everything. */
export class ThreadIndex {
  private readonly parent = new Map<string, string>();
  private readonly bySubject = new Map<string, { id: string; date: number }>();
  private readonly o: IndexOptions;
  private n = 0;

  constructor(o: IndexOptions = {}) {
    this.o = o;
  }

  private find(x: string): string {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    for (let c = x; c !== r; ) {
      const next = this.parent.get(c)!;
      this.parent.set(c, r);
      c = next;
    }
    return r;
  }

  private union(a: string, b: string): string {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    // The older thread id survives: keep the one that was created first.
    const keep = this.order.get(ra)! <= this.order.get(rb)! ? ra : rb;
    const drop = keep === ra ? rb : ra;
    this.parent.set(drop, keep);
    return keep;
  }

  private readonly order = new Map<string, number>();

  private touch(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.order.set(id, this.order.size);
    }
  }

  get size(): number {
    return this.n;
  }

  threadOf(messageId: string): string | undefined {
    return this.parent.has(messageId) ? this.find(messageId) : undefined;
  }

  ingest(m: Message): IngestResult {
    if (this.n >= (this.o.maxMessages ?? 1_000_000)) throw new ThreadingError('the thread index is full');
    this.n++;
    const own = m.messageId ?? `<local-${m.id}@index.invalid>`;
    const refs = m.references?.length ? [...m.references] : [];
    const irt = [...(m.inReplyTo ?? [])];
    this.touch(own);
    const merged: string[] = [];
    let via: IngestResult['via'] = 'new';
    let id = this.find(own);
    for (const r of [...refs, ...irt]) {
      this.touch(r);
      const before = this.find(r);
      const rootBefore = this.find(id);
      id = this.union(own, r);
      for (const gone of [before, rootBefore]) if (gone !== id && gone !== own && !merged.includes(gone)) merged.push(gone);
      via = refs.includes(r) ? (via === 'new' || via === 'references' ? 'references' : via) : via === 'new' ? 'in-reply-to' : via;
    }
    const key = subjectKey(m.subject);
    if (via === 'new' && key && isReply(m.subject)) {
      const prior = this.bySubject.get(key);
      if (prior && Math.abs(m.date - prior.date) <= (this.o.subjectWindowMs ?? 30 * 86_400_000) && this.parent.has(prior.id)) {
        const rootBefore = this.find(id);
        const other = this.find(prior.id);
        id = this.union(own, prior.id);
        for (const gone of [rootBefore, other]) if (gone !== id && gone !== own && !merged.includes(gone)) merged.push(gone);
        via = 'subject';
      }
    }
    if (key && !isReply(m.subject)) this.bySubject.set(key, { id: own, date: m.date });
    else if (key && !this.bySubject.has(key)) this.bySubject.set(key, { id: own, date: m.date });
    const threadId = this.find(own);
    return { threadId, isNew: via === 'new' && merged.length === 0, merged: merged.filter((x) => x !== threadId), via };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Machine mail and loops

export type AutoKind = 'none' | 'auto-generated' | 'auto-replied' | 'auto-notified' | 'bounce' | 'delivery-report' | 'bulk' | 'list' | 'vendor-autoreply';

export interface AutoVerdict {
  readonly auto: boolean;
  readonly kind: AutoKind;
  readonly reasons: readonly string[];
}

const NO_REPLY = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|notifications?|noreply\+.*)(?:[+@])/i;

/** The bare address in a From or Return-Path header value. */
export function addressOf(value: string | undefined): string {
  if (!value) return '';
  const m = /<([^<>]*)>/.exec(value);
  return (m ? m[1]! : value).trim().toLowerCase();
}

/** Whether a message is machine-generated, from its headers alone. Auto-Submitted other than "no" always counts (RFC 3834). */
export function detectAuto(headers: readonly Header[]): AutoVerdict {
  const reasons: string[] = [];
  const auto = first(headers, 'auto-submitted')?.trim().toLowerCase().split(/[;\s]/)[0];
  const ct = first(headers, 'content-type')?.toLowerCase() ?? '';
  const rp = first(headers, 'return-path')?.trim();
  const from = addressOf(first(headers, 'from'));
  const prec = first(headers, 'precedence')?.trim().toLowerCase();
  let kind: AutoKind = 'none';
  if (auto && auto !== 'no') {
    kind = auto === 'auto-replied' ? 'auto-replied' : auto === 'auto-notified' ? 'auto-notified' : 'auto-generated';
    reasons.push(`Auto-Submitted: ${auto}`);
  }
  if (/multipart\/report/.test(ct) || /report-type=(delivery-status|disposition-notification)/.test(ct)) {
    if (kind === 'none') kind = 'delivery-report';
    reasons.push('Content-Type is a delivery or disposition report');
  }
  if (rp !== undefined && /^<\s*>$/.test(rp)) {
    if (kind === 'none') kind = 'bounce';
    reasons.push('empty Return-Path: a bounce');
  }
  if (/^(mailer-daemon|postmaster)@/.test(from)) {
    if (kind === 'none') kind = 'bounce';
    reasons.push(`sent by ${from}`);
  }
  if (prec && /^(bulk|junk|list|auto_reply)$/.test(prec)) {
    if (kind === 'none') kind = prec === 'list' ? 'list' : prec === 'auto_reply' ? 'vendor-autoreply' : 'bulk';
    reasons.push(`Precedence: ${prec}`);
  }
  for (const h of ['list-id', 'list-unsubscribe', 'list-post']) if (first(headers, h) !== undefined) {
    if (kind === 'none') kind = 'list';
    reasons.push(`${h} header present`);
    break;
  }
  for (const h of ['x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'x-failed-recipients', 'x-autogenerated']) if (first(headers, h) !== undefined) {
    if (kind === 'none') kind = h === 'x-failed-recipients' ? 'bounce' : 'vendor-autoreply';
    reasons.push(`${h} header present`);
  }
  return { auto: kind !== 'none', kind, reasons };
}

/** Number of Received headers: the hops a message has made. */
export const hopCount = (headers: readonly Header[]): number => all(headers, 'received').length;

export interface AutoReplyContext {
  /** Addresses that are ours: never answered, and never the recipient of our own automatic mail. */
  readonly ourAddresses: readonly string[];
  readonly now: number;
  /** When we last auto-replied to each address (ms). */
  readonly lastReplyTo: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /** At most one automatic reply per sender in this window. Default 24 hours. */
  readonly windowMs?: number;
  /** More Received hops than this is treated as a loop. Default 25. */
  readonly maxHops?: number;
}

export interface AutoReplyDecision {
  readonly send: boolean;
  readonly reason: string;
}

/** Whether an automatic reply (out of office, ticket acknowledgement) may be sent to this message. Defaults to no when in doubt. */
export function mayAutoReply(headers: readonly Header[], ctx: AutoReplyContext): AutoReplyDecision {
  const v = detectAuto(headers);
  if (v.auto) return { send: false, reason: `the message is automatic (${v.kind}): ${v.reasons[0]}` };
  const replyTo = addressOf(first(headers, 'reply-to') ?? first(headers, 'from'));
  const from = addressOf(first(headers, 'from'));
  const rp = addressOf(first(headers, 'return-path'));
  const target = rp || from || replyTo;
  if (!target || !/^[^@\s]+@[^@\s]+$/.test(target)) return { send: false, reason: 'there is no usable sender address' };
  if (ctx.ourAddresses.some((a) => a.toLowerCase() === target || a.toLowerCase() === from)) return { send: false, reason: 'the sender is one of our own addresses: a reply could loop' };
  if (NO_REPLY.test(target) || NO_REPLY.test(from)) return { send: false, reason: `${target} is a no-reply or system address` };
  if (hopCount(headers) > (ctx.maxHops ?? 25)) return { send: false, reason: `the message has made ${hopCount(headers)} hops: a probable mail loop` };
  if (first(headers, 'x-loop') !== undefined && ctx.ourAddresses.some((a) => first(headers, 'x-loop')!.toLowerCase().includes(a.toLowerCase()))) return { send: false, reason: 'the message already carries our X-Loop mark' };
  const last = ctx.lastReplyTo instanceof Map ? ctx.lastReplyTo.get(target) : (ctx.lastReplyTo as Record<string, number>)[target];
  if (last !== undefined && ctx.now - last < (ctx.windowMs ?? 24 * 3_600_000)) return { send: false, reason: `already auto-replied to ${target} within the window` };
  return { send: true, reason: 'a person wrote it, it is not from us, and we have not answered them lately' };
}

/** Headers an automatic reply must carry so that other systems do not answer it. */
export function autoReplyHeaders(parent: Message, newMessageId: string): Header[] {
  const refs = replyReferences(parent);
  return [
    { name: 'Message-ID', value: newMessageId },
    { name: 'Auto-Submitted', value: 'auto-replied' },
    { name: 'Precedence', value: 'bulk' },
    { name: 'X-Auto-Response-Suppress', value: 'All' },
    ...(parent.messageId ? [{ name: 'In-Reply-To', value: parent.messageId }] : []),
    ...(refs.length ? [{ name: 'References', value: refs.join(' ') }] : []),
    { name: 'Subject', value: replySubject(parent.subject) },
  ];
}

/** References for a reply: the parent's own References (or its In-Reply-To) followed by its Message-ID, keeping the first id and the newest ones (RFC 5322 3.6.4). */
export function replyReferences(parent: Message, max = 20): string[] {
  const base = [...(parent.references?.length ? parent.references : parent.inReplyTo ?? [])];
  if (parent.messageId) base.push(parent.messageId);
  const unique = base.filter((r, i) => base.indexOf(r) === i);
  return unique.length <= max ? unique : [unique[0]!, ...unique.slice(unique.length - (max - 1))];
}

/** "Re: " plus the base subject, once. */
export function replySubject(subject: string): string {
  const b = baseSubject(subject);
  return `Re: ${b || '(no subject)'}`;
}
