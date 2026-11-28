/**
 * Putting an app inside someone else's page, safely. Three ways in: an iframe on the page, a popup window, and a
 * one-line script that adds the iframe (a floating button or an inline frame). This block holds what all three
 * share. The embed address and the snippet a site owner pastes (every attribute escaped, a sandbox, a minimal
 * "allow" list, no credentials or script addresses accepted). The message contract between page and frame over
 * postMessage: a versioned envelope, one validator per message type with exact fields and size limits, direction
 * rules (the frame may ask to resize, report an event or close; the page may initialise it), a handshake that
 * gives each connection a random channel id the page makes, and increasing sequence numbers so a replayed or
 * out-of-order message is dropped. Origin checks: a message counts only if its origin equals the single expected
 * origin and its source is the expected window; an allow-list of page origins (exact, or one wildcard
 * subdomain level) is used by the frame to pick its parent, and "*" as a target is refused everywhere. Resize
 * handling that clamps, ignores jitter, coalesces bursts and stops a grow-and-grow loop. And the server side:
 * response headers for embeddable routes (frame-ancestors as the allow-list, built on the secheaders block, no
 * X-Frame-Options, the opener policy popups need), the CSP the host page needs, a partitioned cookie for the
 * frame, and a request check using Sec-Fetch-Dest and the referrer.
 *
 * Out of scope: the browser-side script itself (the endpoints take injected `post` and window handles so this
 * runs and is tested without a DOM), and storage-access prompts, which browsers decide.
 */
import { headers as secureHeaders } from '../secheaders/index.ts';

export class EmbedRefused extends Error {
  constructor(why: string) {
    super(`embed refused: ${why}`);
    this.name = 'EmbedRefused';
  }
}

// ------------------------------------------------------------------------------------------------ origins

/** scheme://host[:port] with nothing else, lower-cased, default ports removed. */
export function normalizeOrigin(o: string): string {
  if (o === '*' || o === 'null') throw new EmbedRefused(`"${o}" is not an origin`);
  let u: URL;
  try {
    u = new URL(o);
  } catch {
    throw new EmbedRefused(`not an origin: ${o.slice(0, 60)}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'))) throw new EmbedRefused('origins are https (http only on localhost)');
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new EmbedRefused('an origin has no path, query or credentials');
  return u.origin;
}

/** Does an origin match an allow-list entry: exact, or "https://*.example.com" for one subdomain label or more (never the bare domain). */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  let o: string;
  try {
    o = normalizeOrigin(origin);
  } catch {
    return false;
  }
  for (const a of allowed) {
    const w = /^(https):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i.exec(a);
    if (w) {
      const u = new URL(o);
      const port = w[3] ?? '';
      if (u.protocol === `${w[1]!.toLowerCase()}:` && u.hostname.endsWith(`.${w[2]!.toLowerCase()}`) && u.hostname.length > w[2]!.length + 1 && (u.port ? `:${u.port}` : '') === port) return true;
    } else if (!a.includes('*') && normalizeOrigin(a) === o) return true;
    else if (a.includes('*') && !w) throw new EmbedRefused(`the allow-list entry ${a} is not an origin or a wildcard subdomain`);
  }
  return false;
}

/** The origin a frame should treat as its parent: the first candidate (ancestor origins, then the referrer) on the allow-list. */
export function pickHostOrigin(candidates: readonly (string | undefined)[], allowed: readonly string[]): string | undefined {
  for (const c of candidates) {
    if (!c) continue;
    let origin = c;
    try {
      origin = new URL(c).origin;
    } catch {
      continue;
    }
    if (originAllowed(origin, allowed)) return origin;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ embed address

export type Mode = 'inline' | 'floating' | 'popup';
export interface EmbedConfig {
  readonly src: string;
  readonly mode: Mode;
  readonly title: string;
  readonly width?: string;
  readonly height?: number;
  readonly theme?: 'light' | 'dark' | 'auto';
  readonly locale?: string;
  /** Query parameters the embed may be given; only these names, short values. */
  readonly params?: Readonly<Record<string, string>>;
  /** Browser features the frame may use (camera, microphone, payment, clipboard-write). */
  readonly allow?: readonly string[];
}

const PARAM = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const FEATURES = new Set(['camera', 'microphone', 'geolocation', 'payment', 'clipboard-write', 'fullscreen']);

/** The embed address with its parameters set; refuses other schemes, credentials and parameters that look like secrets. */
export function embedUrl(src: string, params: Readonly<Record<string, string>> = {}, extra: { theme?: string; locale?: string } = {}): string {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    throw new EmbedRefused('the embed address is not a URL');
  }
  normalizeOrigin(u.origin);
  if (u.username || u.password) throw new EmbedRefused('the embed address holds credentials');
  u.hash = '';
  const all: Record<string, string> = { ...params, ...(extra.theme ? { theme: extra.theme } : {}), ...(extra.locale ? { locale: extra.locale } : {}) };
  for (const [k, v] of Object.entries(all)) {
    if (!PARAM.test(k)) throw new EmbedRefused(`"${k}" is not an allowed parameter name`);
    if (/(?:token|secret|password|passwd|key|auth)/i.test(k)) throw new EmbedRefused(`"${k}" looks like a secret and addresses end up in logs`);
    if (v.length > 200 || /[\u0000-\u001f]/.test(v)) throw new EmbedRefused(`the value of "${k}" is too long or holds control characters`);
    u.searchParams.set(k, v);
  }
  return u.toString();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What a site owner pastes. Every value is escaped; the iframe is sandboxed to what an app needs and nothing more. */
export function snippet(c: EmbedConfig): string {
  if (!c.title.trim()) throw new EmbedRefused('an embed needs a title for assistive technology');
  for (const f of c.allow ?? []) if (!FEATURES.has(f)) throw new EmbedRefused(`feature "${f}" is not one an embed may ask for`);
  const url = embedUrl(c.src, c.params, { ...(c.theme ? { theme: c.theme } : {}), ...(c.locale ? { locale: c.locale } : {}) });
  const origin = new URL(url).origin;
  if (c.mode === 'popup') return `<button type="button" onclick="window.open('${esc(url).replace(/'/g, '&#39;')}','embed-popup','${popupFeatures(520, 720)}')">${esc(c.title)}</button>`;
  const allow = (c.allow ?? []).map((f) => `${f} ${origin}`).join('; ');
  if (c.mode === 'floating') return `<script async src="${esc(origin)}/embed.js" data-mode="floating" data-src="${esc(url)}" data-title="${esc(c.title)}"></script>`;
  const h = c.height !== undefined ? `${Math.max(100, Math.min(20000, Math.round(c.height)))}px` : '600px';
  if (c.width !== undefined && !/^(?:\d{1,5}(?:px|%|vw|rem|em)|auto)$/.test(c.width)) throw new EmbedRefused('the width is a number with px, %, vw, rem or em');
  return `<iframe src="${esc(url)}" title="${esc(c.title)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"${allow ? ` allow="${esc(allow)}"` : ''} style="border:0;width:${c.width ?? '100%'};height:${h}"></iframe>`;
}

/** Window features for a popup, centred, within sane sizes. Not "noopener": the popup must keep its opener to post back. */
export function popupFeatures(width: number, height: number, screen: { width: number; height: number } = { width: 1280, height: 800 }): string {
  const w = Math.max(320, Math.min(Math.round(width), screen.width));
  const h = Math.max(320, Math.min(Math.round(height), screen.height));
  return `popup=yes,width=${w},height=${h},left=${Math.round((screen.width - w) / 2)},top=${Math.round((screen.height - h) / 2)}`;
}

// ------------------------------------------------------------------------------------------------ messages

export type Role = 'host' | 'frame';
export interface Envelope {
  readonly ns: 'zthr-embed';
  readonly v: 1;
  readonly type: string;
  readonly channel?: string;
  readonly seq: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

type Check = (p: Record<string, unknown>) => string | undefined;
const only = (p: Record<string, unknown>, keys: readonly string[]) => Object.keys(p).find((k) => !keys.includes(k));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;

const SCHEMAS: Readonly<Record<string, { from: readonly Role[]; check: Check }>> = {
  ready: { from: ['frame'], check: (p) => (only(p, ['features']) ? `unknown field ${only(p, ['features'])}` : p.features !== undefined && !(Array.isArray(p.features) && p.features.length <= 20 && p.features.every((f) => typeof f === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(f))) ? 'features is a short list of names' : undefined) },
  init: {
    from: ['host'],
    check: (p) => {
      const bad = only(p, ['theme', 'locale', 'prefill', 'hostOrigin']);
      if (bad) return `unknown field ${bad}`;
      if (p.theme !== undefined && p.theme !== 'light' && p.theme !== 'dark' && p.theme !== 'auto') return 'theme is light, dark or auto';
      if (p.locale !== undefined && !(typeof p.locale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(p.locale))) return 'locale is a language tag';
      if (p.hostOrigin !== undefined && typeof p.hostOrigin !== 'string') return 'hostOrigin is text';
      if (p.prefill !== undefined) {
        if (!isObj(p.prefill) || Object.keys(p.prefill).length > 20) return 'prefill is up to 20 fields';
        for (const [k, v] of Object.entries(p.prefill)) {
          if (!/^[A-Za-z][\w.-]{0,39}$/.test(k)) return `prefill name "${k.slice(0, 20)}" is not allowed`;
          if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 500))) return `prefill value for ${k} is a short text, number or boolean`;
        }
      }
      return undefined;
    },
  },
  resize: { from: ['frame'], check: (p) => (only(p, ['height', 'width']) ? `unknown field ${only(p, ['height', 'width'])}` : !isInt(p.height, 0, 20000) ? 'height is a whole number from 0 to 20000' : p.width !== undefined && !isInt(p.width, 0, 20000) ? 'width is a whole number from 0 to 20000' : undefined) },
  event: {
    from: ['frame', 'host'],
    check: (p) => {
      if (only(p, ['name', 'data'])) return `unknown field ${only(p, ['name', 'data'])}`;
      if (!(typeof p.name === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(p.name))) return 'name is lower case letters, digits, dot, dash or underscore';
      if (p.data !== undefined && !(isObj(p.data) && JSON.stringify(p.data).length <= 4096)) return 'data is an object under 4 KB';
      return undefined;
    },
  },
  navigate: {
    from: ['frame'],
    check: (p) => {
      if (only(p, ['url'])) return `unknown field ${only(p, ['url'])}`;
      try {
        const u = new URL(String(p.url));
        return u.protocol === 'https:' || u.protocol === 'http:' ? undefined : 'url is http or https';
      } catch {
        return 'url is a web address';
      }
    },
  },
  close: { from: ['frame', 'host'], check: (p) => (only(p, ['reason']) ? `unknown field ${only(p, ['reason'])}` : p.reason !== undefined && p.reason !== 'done' && p.reason !== 'cancel' && p.reason !== 'error' ? 'reason is done, cancel or error' : undefined) },
  error: { from: ['frame', 'host'], check: (p) => (only(p, ['code', 'message']) ? `unknown field ${only(p, ['code', 'message'])}` : !(typeof p.code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(p.code)) ? 'code is a short snake_case name' : p.message !== undefined && !(typeof p.message === 'string' && p.message.length <= 200) ? 'message is up to 200 characters' : undefined) },
};

export const MESSAGE_TYPES: readonly string[] = Object.keys(SCHEMAS);
export const MAX_MESSAGE_BYTES = 16_384;

/** Validate a received value as a message from `from`. Returns the envelope, or the reason it is not one. */
export function parseMessage(data: unknown, from: Role): { ok: true; msg: Envelope } | { ok: false; reason: string } {
  if (!isObj(data)) return { ok: false, reason: 'not an object' };
  let size = 0;
  try {
    size = JSON.stringify(data).length;
  } catch {
    return { ok: false, reason: 'not plain data' };
  }
  if (size > MAX_MESSAGE_BYTES) return { ok: false, reason: 'too large' };
  if (data.ns !== 'zthr-embed') return { ok: false, reason: 'not an embed message' };
  if (data.v !== 1) return { ok: false, reason: 'unsupported version' };
  const extra = only(data, ['ns', 'v', 'type', 'channel', 'seq', 'payload']);
  if (extra) return { ok: false, reason: `unknown field ${extra}` };
  const schema = typeof data.type === 'string' && Object.hasOwn(SCHEMAS, data.type) ? SCHEMAS[data.type]! : undefined;
  if (!schema) return { ok: false, reason: 'unknown message type' };
  if (!schema.from.includes(from)) return { ok: false, reason: `${data.type} is not sent by the ${from}` };
  if (!isInt(data.seq, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'seq is a whole number from 1' };
  if (data.channel !== undefined && !(typeof data.channel === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(data.channel))) return { ok: false, reason: 'channel is 16 to 64 URL-safe characters' };
  const payload = data.payload === undefined ? {} : data.payload;
  if (!isObj(payload)) return { ok: false, reason: 'payload is an object' };
  const why = schema.check(payload);
  if (why) return { ok: false, reason: `${data.type}: ${why}` };
  return { ok: true, msg: { ns: 'zthr-embed', v: 1, type: data.type as string, ...(data.channel !== undefined ? { channel: data.channel as string } : {}), seq: data.seq as number, payload } };
}

export interface Incoming {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}
export type Received = { readonly accepted: true; readonly msg: Envelope } | { readonly accepted: false; readonly reason: string };

export interface EndpointOptions {
  readonly role: Role;
  /** The one origin messages are accepted from and posted to. */
  readonly peerOrigin: string;
  /** The window messages must come from (the iframe's contentWindow, the popup, or window.parent). */
  readonly peerWindow: unknown;
  /** Sends a message to the peer; called with the exact target origin, never "*". */
  readonly post: (message: Envelope, targetOrigin: string) => void;
  /** Random URL-safe text of the given length, for the channel id (the host makes it). */
  readonly random: (length: number) => string;
}

/**
 * One end of an embed connection. The frame sends `ready`; the page answers `init` with a fresh channel id; from
 * then on every message must carry that channel and a higher sequence number than the last. A page that
 * reloads the frame gets a new `ready` and re-initialises with a new channel, ending the old one.
 */
export class Endpoint {
  channel: string | undefined;
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  readonly refused: string[] = [];
  private seqOut = 0;
  private seqIn = 0;
  private readonly o: EndpointOptions;
  private readonly peerRole: Role;
  private readonly origin: string;

  constructor(o: EndpointOptions) {
    this.o = o;
    this.origin = normalizeOrigin(o.peerOrigin);
    this.peerRole = o.role === 'host' ? 'frame' : 'host';
  }

  send(type: string, payload: Record<string, unknown> = {}): Envelope {
    if (this.state === 'closed') throw new EmbedRefused('the connection is closed');
    if (type === 'init' && this.o.role === 'host') {
      this.channel = this.o.random(24);
      this.seqIn = 0;
    }
    if (type !== 'ready' && type !== 'init' && this.state !== 'open') throw new EmbedRefused(`${type} cannot be sent before the handshake is done`);
    const msg: Envelope = { ns: 'zthr-embed', v: 1, type, ...(this.channel ? { channel: this.channel } : {}), seq: ++this.seqOut, payload };
    const check = parseMessage(msg, this.o.role);
    if (!check.ok) throw new EmbedRefused(check.reason);
    this.o.post(msg, this.origin);
    if (type === 'init') this.state = 'open';
    if (type === 'close') this.state = 'closed';
    return msg;
  }

  private no(reason: string): Received {
    this.refused.push(reason);
    return { accepted: false, reason };
  }

  /** Handle a window "message" event. Anything not from the expected origin and window is ignored, whatever it says. */
  receive(ev: Incoming): Received {
    if (ev.origin !== this.origin) return this.no('wrong origin');
    if (ev.source !== this.o.peerWindow) return this.no('wrong source window');
    if (this.state === 'closed') return this.no('connection is closed');
    const r = parseMessage(ev.data, this.peerRole);
    if (!r.ok) return this.no(r.reason);
    const m = r.msg;
    if (m.type === 'ready') {
      // the page (re)starts the connection; it is the only message accepted without a channel
      this.state = 'connecting';
      this.channel = undefined;
      this.seqIn = m.seq;
      return { accepted: true, msg: m };
    }
    if (m.type === 'init' && this.o.role === 'frame') {
      if (!m.channel) return this.no('init without a channel');
      this.channel = m.channel;
      this.seqIn = m.seq;
      this.seqOut = Math.max(this.seqOut, 0);
      this.state = 'open';
      return { accepted: true, msg: m };
    }
    if (this.state !== 'open') return this.no('the handshake is not done');
    if (m.channel !== this.channel) return this.no('wrong channel');
    if (m.seq <= this.seqIn) return this.no('replayed or out of order');
    this.seqIn = m.seq;
    if (m.type === 'close') this.state = 'closed';
    return { accepted: true, msg: m };
  }
}

// ------------------------------------------------------------------------------------------------ resize

export interface ResizeOptions {
  readonly min?: number;
  readonly max?: number;
  /** Changes smaller than this many pixels are ignored (scrollbar and rounding jitter). */
  readonly jitter?: number;
  /** Updates closer together than this are held and the latest is applied once the gap has passed. */
  readonly minIntervalMs?: number;
  /** More than this many applied changes within a second looks like a loop and freezes resizing for a second. */
  readonly loopLimit?: number;
}
export type ResizeDecision = { readonly apply: number } | { readonly hold: true; readonly retryAt: number } | { readonly ignore: 'jitter' | 'same' | 'loop suspected' };

/** Decides when a reported height should change the frame. The clock is an argument. */
export class ResizeController {
  height: number;
  private last = Number.NEGATIVE_INFINITY;
  private readonly times: number[] = [];
  private frozenUntil = Number.NEGATIVE_INFINITY;
  private readonly o: Required<ResizeOptions>;
  constructor(initial = 0, o: ResizeOptions = {}) {
    this.o = { min: 0, max: 20_000, jitter: 2, minIntervalMs: 50, loopLimit: 20, ...o };
    this.height = initial;
  }
  report(h: number, now: number): ResizeDecision {
    const want = Math.max(this.o.min, Math.min(this.o.max, Math.round(h)));
    if (now < this.frozenUntil) return { ignore: 'loop suspected' };
    if (want === this.height) return { ignore: 'same' };
    if (Math.abs(want - this.height) < this.o.jitter) return { ignore: 'jitter' };
    if (now - this.last < this.o.minIntervalMs) return { hold: true, retryAt: this.last + this.o.minIntervalMs };
    while (this.times.length && now - this.times[0]! > 1000) this.times.shift();
    if (this.times.length >= this.o.loopLimit) {
      this.frozenUntil = now + 1000;
      this.times.length = 0;
      return { ignore: 'loop suspected' };
    }
    this.times.push(now);
    this.last = now;
    this.height = want;
    return { apply: want };
  }
}

// ------------------------------------------------------------------------------------------------ server side

/**
 * Headers for a route that may be framed by the given page origins: the secure defaults with `frame-ancestors`
 * set to the allow-list (X-Frame-Options removed, since it cannot name several origins and the CSP is the
 * authority), and for popup embeds an opener policy that keeps `window.opener` so the popup can post back.
 */
export function embeddableHeaders(o: { hostOrigins: readonly string[]; popup?: boolean; nonce?: string }): Record<string, string> {
  if (!o.hostOrigins.length) throw new EmbedRefused('an embeddable route needs at least one page origin');
  const list = o.hostOrigins.map((x) => (/^https:\/\/\*\.[a-z0-9.-]+(?::\d+)?$/i.test(x) ? x.toLowerCase() : normalizeOrigin(x)));
  const h = secureHeaders({ ...(o.nonce ? { nonce: o.nonce } : {}) });
  h['content-security-policy'] = h['content-security-policy']!.replace("frame-ancestors 'none'", `frame-ancestors ${list.join(' ')}`);
  delete h['x-frame-options'];
  h['cross-origin-opener-policy'] = o.popup ? 'unsafe-none' : 'same-origin-allow-popups';
  h['cross-origin-resource-policy'] = 'cross-origin';
  return h;
}

/** What the page that embeds needs in its own policy: the frame origin in frame-src (and the loader's origin in script-src for the script embed). */
export function hostPageNeeds(frameOrigin: string, mode: Mode): Record<string, string> {
  const o = normalizeOrigin(frameOrigin);
  return mode === 'popup' ? { 'connect-src': '', 'frame-src': '', note: 'a popup needs no policy change; the page may keep frame-src none' } : { 'frame-src': o, ...(mode === 'floating' ? { 'script-src': o } : {}) };
}

/** The cookie for a session inside a frame: third-party context needs SameSite=None, Secure, and Partitioned so it is keyed to the embedding site. */
export function frameCookie(name: string, value: string, maxAgeSeconds: number): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new EmbedRefused(`"${name}" is not a cookie name`);
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) throw new EmbedRefused('that value cannot be put in a cookie as it is; encode it first');
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw new EmbedRefused('max age is a whole number of seconds above zero');
  return `__Host-${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`;
}

/**
 * A best-effort check on a request for an embeddable route, as a second layer behind frame-ancestors. A frame
 * request says Sec-Fetch-Dest: iframe; a top-level load of the embed address does not, and is refused when the
 * route is frame-only. The referrer, when sent, must be an allowed page origin. It cannot replace the header:
 * both can be absent or stripped.
 */
export function checkEmbedRequest(r: { secFetchDest?: string; secFetchSite?: string; referer?: string }, hostOrigins: readonly string[], o: { frameOnly?: boolean } = {}): { allowed: true } | { allowed: false; reason: string } {
  if (r.secFetchDest !== undefined && r.secFetchDest !== 'iframe' && r.secFetchDest !== 'document' && r.secFetchDest !== 'empty') return { allowed: false, reason: `loaded as ${r.secFetchDest}` };
  if (o.frameOnly && r.secFetchDest === 'document') return { allowed: false, reason: 'loaded as a top-level page; only framing is allowed' };
  if (r.referer) {
    let origin: string;
    try {
      origin = new URL(r.referer).origin;
    } catch {
      return { allowed: false, reason: 'unreadable referrer' };
    }
    if (r.secFetchSite !== 'same-origin' && !originAllowed(origin, hostOrigins)) return { allowed: false, reason: `${origin} is not an allowed page` };
  }
  return { allowed: true };
}
