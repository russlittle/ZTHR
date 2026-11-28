/**
 * Requests, responses and subscriptions over one WebSocket, as JSON text messages, with the pieces every realtime
 * product rebuilds: an authentication message that must come first (and within a time limit), ids that match each
 * response to its request, subscribe and unsubscribe per topic with an authorisation check on every one, events
 * delivered with a sequence number, and resume tokens, so a client that reconnects is handed back its subscriptions
 * and the events it missed, or told plainly that it must refetch because they can no longer be replayed.
 *
 * It owns no socket and no clock. The server side is one `Connection` per socket, given a `send` function, the
 * events `Hub` it reads from, the methods and topics it serves; the client side is one `RpcClient`, given a `send`
 * function and told when the socket opens, closes or delivers text. Framing is the websocket-frames block's job;
 * this block begins with the text of a whole message. Events are the events block's CloudEvents.
 *
 * Wire messages. Client to server: {t:"auth",token,resume?:{token,seqs}} (first, and nothing else is sent until
 * auth_ok), {t:"req",id,method,params}, {t:"sub",id,sub,topic,params,after?}, {t:"unsub",id,sub}. Server to client:
 * {t:"auth_ok",resume,restored,missed}, {t:"res",id,result,resume?}, {t:"err",id,error:{code,message}},
 * {t:"evt",sub,seq,event}. Close codes used: 4400 malformed, 4401 not authenticated, 4429 too slow or too many.
 */
import { sign, verify } from '../crypto/index.ts';
import type { Failures } from '../ratelimit/index.ts';
import type { CloudEvent, Hub } from '../events/index.ts';

export interface Principal {
  readonly id: string;
  readonly [k: string]: unknown;
}

/** An error a method may throw to answer with a code and a message the caller can show. */
export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** What a client sees when a request fails or the connection goes before the answer. */
export class RpcFailed extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TopicDef {
  /** Event types this topic carries: exact ("files.file.created") or a prefix ("files.*"). */
  readonly types: readonly string[];
  /** Returns a filter for this person's subscription, or null to refuse it. Runs on every subscribe, and on resume. */
  readonly allow: (who: Principal, params: Readonly<Record<string, unknown>>) => ((e: CloudEvent) => boolean) | null;
}

export type Method = (params: unknown, who: Principal) => Promise<unknown> | unknown;

export interface ConnectionOptions {
  readonly send: (text: string) => void;
  readonly close: (code: number, reason: string) => void;
  readonly hub: Hub;
  readonly authenticate: (token: string) => Promise<Principal | null> | Principal | null;
  readonly methods: Readonly<Record<string, Method>>;
  readonly topics: Readonly<Record<string, TopicDef>>;
  /** Signs resume tokens; more than one while rotating (the first signs). */
  readonly secret: string;
  readonly now?: () => number;
  readonly authTimeoutMs?: number;
  readonly resumeTtlMs?: number;
  readonly maxSubscriptions?: number;
  readonly maxInFlight?: number;
  /** True while the socket's buffer is full; an event for a connection that is backed up closes it (it can resume). */
  readonly backedUp?: () => boolean;
  /** Failed authentications per remote address are counted here and refused once over the limit. */
  readonly failures?: Failures;
  readonly remote?: string;
}

interface SubDef {
  readonly id: string;
  readonly topic: string;
  readonly params: Record<string, unknown>;
}
const SUB_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const REQ_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const RESUME = 'ws-rpc-resume';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const matches = (types: readonly string[], type: string) => types.some((p) => (p.endsWith('.*') ? type.startsWith(p.slice(0, -1)) : p === type));

export class Connection {
  private readonly o: ConnectionOptions;
  private readonly now: () => number;
  private who: Principal | undefined;
  private stage: 'new' | 'authenticating' | 'ready' | 'closed' = 'new';
  private readonly openedAt: number;
  private readonly subs = new Map<string, { def: SubDef; stop: () => void }>();
  private readonly inFlight = new Set<string>();

  constructor(o: ConnectionOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.openedAt = this.now();
  }

  get principal(): Principal | undefined {
    return this.who;
  }
  get subscriptions(): string[] {
    return [...this.subs.keys()].sort();
  }
  get closed(): boolean {
    return this.stage === 'closed';
  }

  /** Call now and then: a socket that does not authenticate in time is closed. */
  tick(): void {
    if ((this.stage === 'new' || this.stage === 'authenticating') && this.now() - this.openedAt >= (this.o.authTimeoutMs ?? 10_000)) this.end(4401, 'authentication timed out');
  }

  /** The socket closed: subscriptions end, and a client that comes back resumes from its token. */
  closedByPeer(): void {
    this.shutdown();
  }

  private shutdown(): void {
    this.stage = 'closed';
    for (const s of this.subs.values()) s.stop();
    this.subs.clear();
  }

  private end(code: number, reason: string): void {
    if (this.stage === 'closed') return;
    this.shutdown();
    this.o.close(code, reason);
  }

  private reply(m: Record<string, unknown>): void {
    if (this.stage !== 'closed') this.o.send(JSON.stringify(m));
  }

  private fail(id: string | undefined, code: string, message: string): void {
    this.reply({ t: 'err', ...(id !== undefined ? { id } : {}), error: { code, message } });
  }

  private resumeToken(): string {
    const subs = [...this.subs.values()].map((s) => s.def);
    return sign(this.o.secret, RESUME, { who: this.who!.id, subs }, this.o.resumeTtlMs ?? 5 * 60_000, this.now());
  }

  /** One text message from the client. */
  async receive(text: string): Promise<void> {
    if (this.stage === 'closed') return;
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return this.end(4400, 'not JSON');
    }
    if (!isObj(m) || typeof m['t'] !== 'string') return this.end(4400, 'not a message');
    if (this.stage === 'new') {
      if (m['t'] !== 'auth') return this.end(4401, 'authenticate first');
      this.stage = 'authenticating';
      return this.auth(m);
    }
    if (this.stage === 'authenticating') return this.end(4401, 'nothing is sent before auth_ok');
    if (m['t'] === 'auth') return this.end(4400, 'already authenticated');
    const id = m['id'];
    if (typeof id !== 'string' || !REQ_ID.test(id)) return this.end(4400, 'a message needs an id');
    switch (m['t']) {
      case 'req':
        return this.request(id, m);
      case 'sub':
        return this.subscribe(id, m);
      case 'unsub':
        return this.unsubscribe(id, m);
      default:
        return this.fail(id, 'bad_request', `unknown message type ${JSON.stringify(String(m['t']).slice(0, 20))}`);
    }
  }

  private async auth(m: Record<string, unknown>): Promise<void> {
    const token = m['token'];
    const f = this.o.failures;
    const remote = this.o.remote ?? '';
    try {
      f?.check(remote);
    } catch {
      return this.end(4429, 'too many failed attempts');
    }
    let who: Principal | null = null;
    if (typeof token === 'string' && token.length > 0 && token.length <= 4096) {
      try {
        who = await this.o.authenticate(token);
      } catch {
        who = null;
      }
    }
    if (this.stage === 'closed') return;
    if (!who) {
      f?.fail(remote);
      this.fail(undefined, 'unauthorized', 'that credential was not accepted');
      return this.end(4401, 'unauthorized');
    }
    this.who = who;
    this.stage = 'ready';
    const restored: string[] = [];
    const missed: string[] = [];
    const dropped: string[] = [];
    const r = m['resume'];
    if (isObj(r) && typeof r['token'] === 'string') {
      let defs: SubDef[] = [];
      try {
        const d = verify(this.o.secret, RESUME, r['token'], this.now());
        if (d['who'] === who.id && Array.isArray(d['subs'])) defs = d['subs'] as SubDef[];
        else dropped.push('*');
      } catch {
        dropped.push('*');
      }
      const seqs = isObj(r['seqs']) ? r['seqs'] : {};
      for (const def of defs.slice(0, this.o.maxSubscriptions ?? 100)) {
        const after = typeof seqs[def.id] === 'number' ? (seqs[def.id] as number) : undefined;
        const res = this.attach(def, after);
        if (res === 'refused') dropped.push(def.id);
        else {
          restored.push(def.id);
          if (res === 'missed') missed.push(def.id);
        }
      }
    }
    this.reply({ t: 'auth_ok', resume: this.resumeToken(), restored, missed, dropped });
  }

  /** Starts delivering a subscription's events; says whether the replay could not cover everything the client missed. */
  private attach(def: SubDef, after: number | undefined): 'ok' | 'missed' | 'refused' {
    const topic = Object.hasOwn(this.o.topics, def.topic) ? this.o.topics[def.topic] : undefined;
    if (!topic || !SUB_ID.test(def.id) || !isObj(def.params)) return 'refused';
    const filter = topic.allow(this.who!, def.params);
    if (!filter) return 'refused';
    this.subs.get(def.id)?.stop();
    const h = this.o.hub.subscribe(
      (e) => matches(topic.types, e.type) && filter(e),
      (event, seq) => this.deliver(def.id, seq, event),
      after,
    );
    this.subs.set(def.id, { def, stop: h.stop });
    return h.missed ? 'missed' : 'ok';
  }

  private deliver(sub: string, seq: number, event: CloudEvent): void {
    if (this.stage !== 'ready') return;
    if (this.o.backedUp?.()) {
      // A client that cannot keep up is let go, not buffered without end; it resumes and is replayed what it missed.
      this.end(4429, 'too slow: reconnect and resume');
      return;
    }
    this.reply({ t: 'evt', sub, seq, event });
  }

  private subscribe(id: string, m: Record<string, unknown>): void {
    const sub = m['sub'];
    const topic = m['topic'];
    const params = m['params'] ?? {};
    if (typeof sub !== 'string' || !SUB_ID.test(sub) || typeof topic !== 'string' || !isObj(params)) return this.fail(id, 'bad_request', 'a subscription needs a sub id, a topic and object params');
    if (!this.subs.has(sub) && this.subs.size >= (this.o.maxSubscriptions ?? 100)) return this.fail(id, 'too_many', 'too many subscriptions on this connection');
    if (!Object.hasOwn(this.o.topics, topic)) return this.fail(id, 'not_found', 'no such topic');
    const after = typeof m['after'] === 'number' && Number.isFinite(m['after']) ? m['after'] : undefined;
    const r = this.attach({ id: sub, topic, params }, after);
    if (r === 'refused') return this.fail(id, 'forbidden', 'you may not subscribe to that');
    this.reply({ t: 'res', id, result: { sub, missed: r === 'missed' }, resume: this.resumeToken() });
  }

  private unsubscribe(id: string, m: Record<string, unknown>): void {
    const sub = m['sub'];
    const s = typeof sub === 'string' ? this.subs.get(sub) : undefined;
    if (!s) return this.fail(id, 'not_found', 'no such subscription');
    s.stop();
    this.subs.delete(sub as string);
    this.reply({ t: 'res', id, result: { sub }, resume: this.resumeToken() });
  }

  private async request(id: string, m: Record<string, unknown>): Promise<void> {
    const method = m['method'];
    if (typeof method !== 'string') return this.fail(id, 'bad_request', 'a request needs a method');
    if (this.inFlight.has(id)) return this.fail(id, 'bad_request', 'that id is still in use');
    if (this.inFlight.size >= (this.o.maxInFlight ?? 32)) return this.fail(id, 'too_many', 'too many requests at once');
    const fn = Object.hasOwn(this.o.methods, method) ? this.o.methods[method] : undefined;
    if (!fn) return this.fail(id, 'method_not_found', `no method ${JSON.stringify(method.slice(0, 60))}`);
    this.inFlight.add(id);
    try {
      const result = await fn(m['params'], this.who!);
      this.reply({ t: 'res', id, result: result === undefined ? null : result });
    } catch (e) {
      // Only an RpcError's own words reach the client; anything else is ours to log, not theirs to read.
      if (e instanceof RpcError) this.fail(id, e.code, e.message);
      else this.fail(id, 'internal', 'something went wrong');
    } finally {
      this.inFlight.delete(id);
    }
  }
}

// ---------------------------------------------------------------- client

export interface ClientOptions {
  readonly send: (text: string) => void;
  /** The current credential, asked for on every (re)connect so a refreshed token is used. */
  readonly token: () => string;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  /** Requests made before the connection is ready wait here, up to this many. */
  readonly maxQueued?: number;
  /** Events were missed and cannot be replayed: refetch what this subscription shows. */
  readonly onResync?: (sub: string) => void;
  readonly onState?: (state: ClientState) => void;
}

export type ClientState = 'closed' | 'authenticating' | 'ready';

interface Pending {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly at: number;
  readonly sent: boolean;
  readonly text: string;
}

interface ClientSub {
  readonly topic: string;
  readonly params: Record<string, unknown>;
  readonly handler: (e: CloudEvent) => void;
  seq: number | undefined;
  live: boolean;
}

export class RpcClient {
  private readonly o: ClientOptions;
  private readonly now: () => number;
  private st: ClientState = 'closed';
  private n = 0;
  private resume: string | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly subs = new Map<string, ClientSub>();

  constructor(o: ClientOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  get state(): ClientState {
    return this.st;
  }

  private set(s: ClientState): void {
    if (s !== this.st) {
      this.st = s;
      this.o.onState?.(s);
    }
  }

  /** The socket opened: authenticate, offering the resume token and where each subscription had got to. */
  onOpen(): void {
    this.set('authenticating');
    const seqs: Record<string, number> = {};
    for (const [id, s] of this.subs) if (s.seq !== undefined) seqs[id] = s.seq;
    this.o.send(JSON.stringify({ t: 'auth', token: this.o.token(), ...(this.resume ? { resume: { token: this.resume, seqs } } : {}) }));
  }

  /** The socket closed: what was in flight failed (it may or may not have run, so it is not resent), subscriptions stay. */
  onClose(): void {
    this.set('closed');
    for (const s of this.subs.values()) s.live = false;
    for (const [id, p] of [...this.pending]) {
      if (p.sent) {
        this.pending.delete(id);
        p.reject(new RpcFailed('connection_lost', 'the connection closed before an answer'));
      }
    }
  }

  private id(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  private ask(id: string, body: Record<string, unknown>): Promise<unknown> {
    const text = JSON.stringify({ ...body, id });
    return new Promise((resolve, reject) => {
      const ready = this.st === 'ready';
      if (!ready && [...this.pending.values()].filter((p) => !p.sent).length >= (this.o.maxQueued ?? 100)) return reject(new RpcFailed('queue_full', 'too many requests waiting for the connection'));
      this.pending.set(id, { resolve, reject, at: this.now(), sent: ready, text });
      if (ready) this.o.send(text);
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return this.ask(this.id('r'), { t: 'req', method, params: params ?? null });
  }

  /** Subscribes; the handler gets each event once, in order, including those replayed after a reconnect. */
  async subscribe(topic: string, params: Record<string, unknown>, handler: (e: CloudEvent) => void): Promise<{ sub: string; stop: () => Promise<void> }> {
    const sub = this.id('s');
    const s: ClientSub = { topic, params, handler, seq: undefined, live: false };
    this.subs.set(sub, s);
    try {
      await this.ask(this.id('r'), { t: 'sub', sub, topic, params });
    } catch (e) {
      this.subs.delete(sub);
      throw e;
    }
    s.live = true;
    return { sub, stop: () => this.unsubscribe(sub) };
  }

  private async unsubscribe(sub: string): Promise<void> {
    const s = this.subs.get(sub);
    if (!s) return;
    this.subs.delete(sub);
    if (this.st === 'ready' && s.live) await this.ask(this.id('r'), { t: 'unsub', sub }).catch(() => undefined);
  }

  /** Fails requests that have waited too long for an answer. */
  tick(): void {
    const limit = this.o.requestTimeoutMs ?? 30_000;
    for (const [id, p] of [...this.pending]) {
      if (this.now() - p.at >= limit) {
        this.pending.delete(id);
        p.reject(new RpcFailed('timeout', 'no answer in time'));
      }
    }
  }

  /** One text message from the server. */
  onMessage(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    switch (m['t']) {
      case 'auth_ok':
        return this.authenticated(m);
      case 'res': {
        const p = typeof m['id'] === 'string' ? this.pending.get(m['id']) : undefined;
        if (typeof m['resume'] === 'string') this.resume = m['resume'];
        if (p) {
          this.pending.delete(m['id'] as string);
          p.resolve(m['result']);
        }
        return;
      }
      case 'err': {
        const e = isObj(m['error']) ? m['error'] : {};
        const p = typeof m['id'] === 'string' ? this.pending.get(m['id']) : undefined;
        if (p) {
          this.pending.delete(m['id'] as string);
          p.reject(new RpcFailed(String(e['code'] ?? 'error'), String(e['message'] ?? 'failed')));
        }
        return;
      }
      case 'evt': {
        const s = typeof m['sub'] === 'string' ? this.subs.get(m['sub']) : undefined;
        const seq = m['seq'];
        if (!s || typeof seq !== 'number' || !isObj(m['event'])) return;
        // A replay can overlap what was already delivered; each event reaches the handler once.
        if (s.seq !== undefined && seq <= s.seq) return;
        s.seq = seq;
        s.handler(m['event'] as unknown as CloudEvent);
        return;
      }
    }
  }

  private authenticated(m: Record<string, unknown>): void {
    if (typeof m['resume'] === 'string') this.resume = m['resume'];
    const restored = new Set(Array.isArray(m['restored']) ? (m['restored'] as unknown[]).map(String) : []);
    const missed = Array.isArray(m['missed']) ? (m['missed'] as unknown[]).map(String) : [];
    this.set('ready');
    for (const [id, s] of this.subs) {
      if (restored.has(id)) s.live = true;
      else if (this.hasPendingSub(id)) continue;
      else {
        // The server did not keep this one (no token, or it lapsed): ask again, from where this client had got to.
        this.ask(this.id('r'), { t: 'sub', sub: id, topic: s.topic, params: s.params, ...(s.seq !== undefined ? { after: s.seq } : {}) })
          .then((r) => {
            s.live = true;
            if (isObj(r) && r['missed'] === true) this.o.onResync?.(id);
          })
          .catch(() => undefined);
      }
    }
    for (const id of missed) this.o.onResync?.(id);
    // Requests made while offline go out now, in the order they were made.
    for (const [id, p] of [...this.pending]) {
      if (!p.sent) {
        this.pending.set(id, { ...p, sent: true });
        this.o.send(p.text);
      }
    }
  }

  private hasPendingSub(sub: string): boolean {
    for (const p of this.pending.values()) if (!p.sent && p.text.includes(`"sub":${JSON.stringify(sub)}`) && p.text.includes('"t":"sub"')) return true;
    return false;
  }
}
