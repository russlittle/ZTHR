/**
 * WebSocket framing (RFC 6455) as a sans-IO codec and session: the opening handshake check and accept key, the
 * frame encoder and incremental decoder (masking, 7/16/64-bit lengths that must be minimal, control frames that may
 * not be fragmented or longer than 125 bytes, reserved bits refused because no extension is negotiated), message
 * reassembly from fragments with a per-message size limit, UTF-8 checked text, the close handshake with only the
 * close codes the RFC allows on the wire, ping and pong with a liveness timeout, and backpressure rules that queue
 * data messages up to a limit while control frames always go out.
 *
 * The session owns no socket and no clock: bytes come in through `receive`, go out through the `write` function it
 * is given (which answers false when the socket's buffer is full, as Node's `socket.write` does), `now` and the mask
 * generator are arguments. Per-message compression (RFC 7692) is out of scope, so RSV1 is always a protocol error.
 */
import { createHash, randomBytes } from 'node:crypto';

/** A violation of the protocol or a limit, with the close code the peer should be sent. */
export class WsProtocolError extends Error {
  readonly code: number;
  constructor(code: number, why: string) {
    super(why);
    this.code = code;
  }
}

/** Sending was refused: the connection is closing, or the queue behind a slow peer is full. */
export class WsSendRefused extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** The opening request is not a WebSocket upgrade this server will accept. */
export class WsHandshakeRefused extends Error {
  readonly status: number;
  constructor(status: number, why: string) {
    super(why);
    this.status = status;
  }
}

export const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------- handshake

/** Sec-WebSocket-Accept for a client's Sec-WebSocket-Key (RFC 6455 section 4.2.2). */
export const acceptKey = (clientKey: string): string => createHash('sha1').update(clientKey + GUID).digest('base64');

const tokens = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export interface UpgradeCheck {
  readonly key: string;
  readonly protocols: readonly string[];
  readonly origin: string | undefined;
}

/**
 * Checks a client's opening request (header names lower-case). Refuses anything but GET, HTTP/1.1 or later, version
 * 13, a 16-byte base64 key, and (when `origins` is given) an Origin on the list, so a page on another site cannot
 * open a socket with the visitor's cookies. A refusal for the version carries 426 and the header to send back.
 */
export function checkUpgrade(req: { method: string; headers: Readonly<Record<string, string | undefined>> }, o: { origins?: readonly string[]; allowMissingOrigin?: boolean } = {}): UpgradeCheck {
  const h = req.headers;
  if (req.method !== 'GET') throw new WsHandshakeRefused(405, 'a WebSocket opens with GET');
  if (!tokens(h['connection']).includes('upgrade')) throw new WsHandshakeRefused(400, 'Connection must include Upgrade');
  if (!tokens(h['upgrade']).includes('websocket')) throw new WsHandshakeRefused(400, 'Upgrade must be websocket');
  if (h['sec-websocket-version'] !== '13') throw new WsHandshakeRefused(426, 'only WebSocket version 13 is spoken (send Sec-WebSocket-Version: 13)');
  const key = h['sec-websocket-key'] ?? '';
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) throw new WsHandshakeRefused(400, 'Sec-WebSocket-Key must be 16 random bytes in base64');
  const origin = h['origin'];
  if (o.origins) {
    if (origin === undefined ? !o.allowMissingOrigin : !o.origins.includes(origin)) throw new WsHandshakeRefused(403, 'that Origin may not open a socket here');
  }
  return { key, protocols: (h['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean), origin };
}

/** The 101 response; `protocol` must be one the client offered. Nothing the client sent is echoed except the accept hash. */
export function upgradeResponse(check: UpgradeCheck, protocol?: string): string {
  if (protocol !== undefined && !check.protocols.includes(protocol)) throw new WsHandshakeRefused(400, 'a subprotocol the client did not offer');
  if (protocol !== undefined && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)) throw new WsHandshakeRefused(400, 'a subprotocol must be a token');
  return ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(check.key)}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n');
}

// ---------------------------------------------------------------- close codes

/** Codes that may appear in a close frame on the wire (1004, 1005, 1006 and 1015 are reserved and never sent). */
export function validCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

export const CLOSE_NAMES: Readonly<Record<number, string>> = {
  1000: 'normal closure',
  1001: 'going away',
  1002: 'protocol error',
  1003: 'unsupported data',
  1005: 'no status received',
  1006: 'abnormal closure',
  1007: 'invalid payload data',
  1008: 'policy violation',
  1009: 'message too big',
  1010: 'mandatory extension',
  1011: 'internal error',
  1012: 'service restart',
  1013: 'try again later',
  1014: 'bad gateway',
};

/** Close payload: a two-byte code and a reason of at most 123 bytes of UTF-8 (control frames hold 125). */
export function encodeClosePayload(code: number, reason = ''): Buffer {
  if (!validCloseCode(code)) throw new RangeError(`${code} is not a close code that may be sent`);
  let r = Buffer.from(reason, 'utf8');
  if (r.length > 123) {
    // Cut on a character boundary, never in the middle of one.
    let n = 123;
    while (n > 0 && (r[n]! & 0xc0) === 0x80) n--;
    r = r.subarray(0, n);
  }
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code, 0);
  r.copy(b, 2);
  return b;
}

/** Reads a received close payload; an empty one means "no status" (1005). */
export function decodeClosePayload(p: Buffer): { code: number; reason: string } {
  if (p.length === 0) return { code: 1005, reason: '' };
  if (p.length === 1) throw new WsProtocolError(1002, 'a close frame body of one byte');
  const code = p.readUInt16BE(0);
  if (!validCloseCode(code)) throw new WsProtocolError(1002, `close code ${code} may not appear on the wire`);
  let reason: string;
  try {
    reason = new TextDecoder('utf-8', { fatal: true }).decode(p.subarray(2));
  } catch {
    throw new WsProtocolError(1007, 'the close reason is not UTF-8');
  }
  return { code, reason };
}

// ---------------------------------------------------------------- frames

/** XORs a payload with a 4-byte masking key (the same call masks and unmasks); returns a new buffer. */
export function applyMask(payload: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== 4) throw new RangeError('a masking key is 4 bytes');
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ key[i & 3]!;
  return out;
}

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  /** Whether the frame arrived masked (decoder) or is to be sent masked (encoder). */
  readonly masked?: boolean;
}

/** Encodes a frame; give a 4-byte `mask` for frames a client sends (they must all be masked). */
export function encodeFrame(f: { fin?: boolean; opcode: number; payload: Uint8Array; mask?: Uint8Array }): Buffer {
  const fin = f.fin ?? true;
  const n = f.payload.length;
  const isControl = (f.opcode & 0x8) !== 0;
  if (![0, 1, 2, 8, 9, 10].includes(f.opcode)) throw new RangeError(`opcode ${f.opcode} is not defined`);
  if (isControl && (n > 125 || !fin)) throw new RangeError('a control frame is at most 125 bytes and is never fragmented');
  const head: number[] = [(fin ? 0x80 : 0) | f.opcode];
  const m = f.mask ? 0x80 : 0;
  let ext = Buffer.alloc(0);
  if (n < 126) head.push(m | n);
  else if (n <= 0xffff) {
    head.push(m | 126);
    ext = Buffer.alloc(2);
    ext.writeUInt16BE(n);
  } else {
    head.push(m | 127);
    ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(n));
  }
  const body = f.mask ? Buffer.concat([Buffer.from(f.mask), applyMask(f.payload, f.mask)]) : Buffer.from(f.payload);
  return Buffer.concat([Buffer.from(head), ext, body]);
}

export interface DecoderOptions {
  /** `server` requires every frame masked, `client` requires none masked. */
  readonly role: 'server' | 'client';
  /** Largest single frame payload accepted, checked from the length field before any payload is kept. */
  readonly maxFrameBytes?: number;
}

/** Incremental frame decoder: feed it whatever bytes arrive, get the whole frames they complete. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private readonly role: 'server' | 'client';
  private readonly maxFrame: number;
  constructor(o: DecoderOptions) {
    this.role = o.role;
    this.maxFrame = o.maxFrameBytes ?? 1 << 20;
  }

  /** Bytes held waiting for the rest of a frame. */
  get pending(): number {
    return this.buf.length;
  }

  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: Frame[] = [];
    for (;;) {
      const f = this.one();
      if (!f) break;
      out.push(f);
    }
    return out;
  }

  private one(): Frame | undefined {
    const b = this.buf;
    if (b.length < 2) return undefined;
    const b0 = b[0]!;
    const b1 = b[1]!;
    if (b0 & 0x70) throw new WsProtocolError(1002, 'reserved bits set, and no extension was negotiated');
    const opcode = b0 & 0x0f;
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new WsProtocolError(1002, `opcode ${opcode} is not defined`);
    const fin = (b0 & 0x80) !== 0;
    const masked = (b1 & 0x80) !== 0;
    if (this.role === 'server' && !masked) throw new WsProtocolError(1002, 'a client frame must be masked');
    if (this.role === 'client' && masked) throw new WsProtocolError(1002, 'a server frame must not be masked');
    let len = b1 & 0x7f;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return undefined;
      len = b.readUInt16BE(2);
      at = 4;
      if (len < 126) throw new WsProtocolError(1002, 'a length not in its shortest form');
    } else if (len === 127) {
      if (b.length < 10) return undefined;
      const big = b.readBigUInt64BE(2);
      if (big >> 63n) throw new WsProtocolError(1002, 'the top bit of a 64-bit length is set');
      if (big <= 0xffffn) throw new WsProtocolError(1002, 'a length not in its shortest form');
      if (big > BigInt(this.maxFrame)) throw new WsProtocolError(1009, `a frame of ${big} bytes is over the limit of ${this.maxFrame}`);
      len = Number(big);
      at = 10;
    }
    const control = (opcode & 0x8) !== 0;
    if (control && (len > 125 || !fin)) throw new WsProtocolError(1002, 'a control frame must be whole and at most 125 bytes');
    if (len > this.maxFrame) throw new WsProtocolError(1009, `a frame of ${len} bytes is over the limit of ${this.maxFrame}`);
    const maskLen = masked ? 4 : 0;
    if (b.length < at + maskLen + len) return undefined;
    const raw = b.subarray(at + maskLen, at + maskLen + len);
    const payload = masked ? applyMask(raw, b.subarray(at, at + 4)) : Buffer.from(raw);
    this.buf = Buffer.from(b.subarray(at + maskLen + len));
    return { fin, opcode, payload, masked };
  }
}

// ---------------------------------------------------------------- session

export type SessionEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'binary'; readonly data: Buffer }
  | { readonly type: 'ping'; readonly payload: Buffer }
  | { readonly type: 'pong'; readonly payload: Buffer; readonly rttMs?: number }
  | { readonly type: 'close'; readonly code: number; readonly reason: string; readonly clean: boolean; readonly byUs: boolean };

export interface SessionOptions {
  readonly role: 'server' | 'client';
  /** Writes bytes to the socket; false means its buffer is full and sending should pause until `drain()`. */
  readonly write: (bytes: Buffer) => boolean;
  /** Largest whole message (all fragments) accepted. */
  readonly maxMessageBytes?: number;
  readonly maxFrameBytes?: number;
  /** Data bytes held while the socket is full; past this, sending is refused. */
  readonly maxQueuedBytes?: number;
  /** Largest frame this side writes; bigger messages are sent as fragments. */
  readonly fragmentBytes?: number;
  readonly now?: () => number;
  /** A fresh 4-byte masking key per client frame; defaults to node:crypto, injected in tests. */
  readonly maskKey?: () => Uint8Array;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  /** How long to wait for the peer's close after sending ours. */
  readonly closeTimeoutMs?: number;
}

export type SessionState = 'open' | 'closing' | 'closed';

export class Session {
  private readonly o: SessionOptions;
  private readonly dec: FrameDecoder;
  private readonly now: () => number;
  private readonly maxMessage: number;
  private readonly maxQueued: number;
  private readonly fragment: number;
  private readonly pingEvery: number;
  private readonly pongWithin: number;
  private readonly closeWithin: number;
  private st: SessionState = 'open';
  private paused = false;
  private queue: Buffer[] = [];
  private queued = 0;
  private partial: { kind: 'text' | 'binary'; parts: Buffer[]; bytes: number; utf8: TextDecoder | undefined } | undefined;
  private lastHeard: number;
  private pingOut: { payload: string; at: number } | undefined;
  private pingSeq = 0;
  private closeSentAt: number | undefined;
  private closeSent = false;

  constructor(o: SessionOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.dec = new FrameDecoder({ role: o.role, ...(o.maxFrameBytes !== undefined ? { maxFrameBytes: o.maxFrameBytes } : {}) });
    this.maxMessage = o.maxMessageBytes ?? 1 << 20;
    this.maxQueued = o.maxQueuedBytes ?? 1 << 20;
    this.fragment = o.fragmentBytes ?? 64 * 1024;
    this.pingEvery = o.pingIntervalMs ?? 30_000;
    this.pongWithin = o.pongTimeoutMs ?? 10_000;
    this.closeWithin = o.closeTimeoutMs ?? 5_000;
    this.lastHeard = this.now();
  }

  get state(): SessionState {
    return this.st;
  }
  /** Data bytes waiting for the socket to drain. */
  get queuedBytes(): number {
    return this.queued;
  }
  /** Whether the socket said it was full: the application should stop producing until `drain()`. */
  get backpressured(): boolean {
    return this.paused;
  }

  private mask(): Uint8Array | undefined {
    if (this.o.role !== 'client') return undefined;
    return this.o.maskKey ? this.o.maskKey() : randomBytes(4);
  }

  private raw(frame: Buffer): void {
    if (!this.o.write(frame)) this.paused = true;
  }

  private control(opcode: number, payload: Buffer): void {
    const m = this.mask();
    this.raw(encodeFrame({ opcode, payload, ...(m ? { mask: m } : {}) }));
  }

  // -------- receiving

  /** Feeds bytes from the socket; returns what they completed. A violation closes the session with the right code. */
  receive(chunk: Uint8Array): SessionEvent[] {
    if (this.st === 'closed') return [];
    const events: SessionEvent[] = [];
    try {
      const frames = this.dec.push(chunk);
      if (frames.length) this.lastHeard = this.now();
      let lastPing: Buffer | undefined;
      for (const f of frames) {
        if ((this.st as SessionState) === 'closed') break;
        const ev = this.frame(f);
        if (ev === 'ping-pending') lastPing = f.payload;
        else if (ev) events.push(ev);
      }
      // Replying to every ping in a burst lets a peer make us write without bound; the latest one is enough (RFC 6455, 5.5.3).
      if (lastPing && this.st === 'open') {
        this.control(OP.pong, lastPing);
        events.push({ type: 'ping', payload: lastPing });
      }
    } catch (e) {
      if (!(e instanceof WsProtocolError)) throw e;
      events.push(this.fail(e.code, e.message));
    }
    return events;
  }

  private frame(f: Frame): SessionEvent | 'ping-pending' | undefined {
    switch (f.opcode) {
      case OP.ping:
        return 'ping-pending';
      case OP.pong: {
        let rtt: number | undefined;
        if (this.pingOut && this.pingOut.payload === f.payload.toString('latin1')) {
          rtt = this.now() - this.pingOut.at;
          this.pingOut = undefined;
        }
        return { type: 'pong', payload: f.payload, ...(rtt !== undefined ? { rttMs: rtt } : {}) };
      }
      case OP.close:
        return this.onClose(f.payload);
      default:
        return this.onData(f);
    }
  }

  private onData(f: Frame): SessionEvent | undefined {
    if (f.opcode === OP.continuation) {
      if (!this.partial) throw new WsProtocolError(1002, 'a continuation with nothing to continue');
    } else if (this.partial) throw new WsProtocolError(1002, 'a new message began before the last one finished');
    else this.partial = { kind: f.opcode === OP.text ? 'text' : 'binary', parts: [], bytes: 0, utf8: f.opcode === OP.text ? new TextDecoder('utf-8', { fatal: true }) : undefined };
    const p = this.partial!;
    p.bytes += f.payload.length;
    if (p.bytes > this.maxMessage) throw new WsProtocolError(1009, `a message over ${this.maxMessage} bytes`);
    // Text is checked as it arrives, so a bad byte fails the message at once and a character split across fragments is fine.
    if (p.utf8) {
      try {
        p.utf8.decode(f.payload, { stream: !f.fin });
      } catch {
        throw new WsProtocolError(1007, 'text that is not valid UTF-8');
      }
    }
    p.parts.push(f.payload);
    if (!f.fin) return undefined;
    this.partial = undefined;
    const whole = Buffer.concat(p.parts);
    return p.kind === 'text' ? { type: 'text', text: whole.toString('utf8') } : { type: 'binary', data: whole };
  }

  private onClose(payload: Buffer): SessionEvent {
    const { code, reason } = decodeClosePayload(payload);
    if (this.closeSent) {
      // Our close was sent first: this is the answer, and the connection ends cleanly.
      this.st = 'closed';
      return { type: 'close', code, reason, clean: true, byUs: true };
    }
    // The peer started it: answer with the same code (1005 is answered with an empty body) and finish.
    this.sendClose(code === 1005 ? undefined : code, '');
    this.st = 'closed';
    return { type: 'close', code, reason, clean: true, byUs: false };
  }

  private sendClose(code: number | undefined, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    this.closeSentAt = this.now();
    this.control(OP.close, code === undefined ? Buffer.alloc(0) : encodeClosePayload(code, reason));
  }

  private fail(code: number, why: string): SessionEvent {
    this.sendClose(code, why);
    this.st = 'closed';
    this.partial = undefined;
    this.queue = [];
    this.queued = 0;
    return { type: 'close', code, reason: why, clean: false, byUs: true };
  }

  // -------- sending

  private data(opcode: number, payload: Buffer): void {
    if (this.st !== 'open') throw new WsSendRefused(`the connection is ${this.st}`);
    const pieces: Buffer[] = [];
    if (payload.length <= this.fragment) pieces.push(this.frameOf(opcode, true, payload));
    else
      for (let at = 0; at < payload.length; at += this.fragment) {
        const part = payload.subarray(at, at + this.fragment);
        pieces.push(this.frameOf(at === 0 ? opcode : OP.continuation, at + this.fragment >= payload.length, part));
      }
    const size = pieces.reduce((n, p) => n + p.length, 0);
    if (this.paused) {
      if (this.queued + size > this.maxQueued) throw new WsSendRefused('the peer is not keeping up: the send queue is full');
      this.queue.push(...pieces);
      this.queued += size;
      return;
    }
    // A message goes out whole: a ping or pong may sit between fragments but never another message.
    for (const p of pieces) this.raw(p);
  }

  private frameOf(opcode: number, fin: boolean, payload: Buffer): Buffer {
    const m = this.mask();
    return encodeFrame({ opcode, fin, payload, ...(m ? { mask: m } : {}) });
  }

  sendText(text: string): void {
    this.data(OP.text, Buffer.from(text, 'utf8'));
  }
  sendBinary(data: Uint8Array): void {
    this.data(OP.binary, Buffer.from(data));
  }

  /** Control frames are never queued behind data: a ping or a close must not wait for a slow reader. */
  ping(payload: Uint8Array = Buffer.alloc(0)): void {
    if (this.st !== 'open') throw new WsSendRefused(`the connection is ${this.st}`);
    this.control(OP.ping, Buffer.from(payload));
  }

  /** Starts the close handshake; nothing but the peer's answer (or the timeout) is waited for. Data still queued is dropped. */
  close(code = 1000, reason = ''): void {
    if (this.st !== 'open') return;
    this.queue = [];
    this.queued = 0;
    this.sendClose(code, reason);
    this.st = 'closing';
  }

  /** The socket can take more: sends what was queued, stopping again if it fills. */
  drain(): void {
    this.paused = false;
    while (this.queue.length && !this.paused) {
      const p = this.queue.shift()!;
      this.queued -= p.length;
      this.raw(p);
    }
  }

  /** The socket ended without a close frame: the connection is gone, abnormally (1006). */
  socketClosed(): SessionEvent[] {
    if (this.st === 'closed') return [];
    this.st = 'closed';
    return [{ type: 'close', code: 1006, reason: 'the connection ended without a close frame', clean: false, byUs: false }];
  }

  /** Call now and then: pings when the line is quiet, gives up on a peer that does not answer, ends a close that hangs. */
  tick(): SessionEvent[] {
    const t = this.now();
    if (this.st === 'closed') return [];
    if (this.st === 'closing') {
      if (this.closeSentAt !== undefined && t - this.closeSentAt >= this.closeWithin) {
        this.st = 'closed';
        return [{ type: 'close', code: 1006, reason: 'the peer did not answer our close', clean: false, byUs: true }];
      }
      return [];
    }
    if (this.pingOut) {
      if (t - this.pingOut.at >= this.pongWithin) {
        this.st = 'closed';
        return [{ type: 'close', code: 1006, reason: 'no answer to ping', clean: false, byUs: true }];
      }
      return [];
    }
    if (t - this.lastHeard >= this.pingEvery) {
      const payload = `p${++this.pingSeq}`;
      this.pingOut = { payload, at: t };
      this.control(OP.ping, Buffer.from(payload, 'latin1'));
    }
    return [];
  }
}
