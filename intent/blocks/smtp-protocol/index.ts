/**
 * SMTP and ESMTP as state machines that hold no socket: bytes in, bytes out, so a server, a client and every
 * hostile case run in tests with nothing on the network. Follows RFC 5321 (commands, replies, limits, dot
 * transparency), RFC 1869/5321 EHLO, RFC 1870 SIZE, RFC 6152 8BITMIME, RFC 6531 SMTPUTF8, RFC 2920 PIPELINING,
 * RFC 3207 STARTTLS, RFC 2034/3463 enhanced status codes, RFC 4954 AUTH with PLAIN (RFC 4616), LOGIN, and XOAUTH2
 * (Google's bearer-token SASL, including its error round trip).
 *
 * Holds: a command parser and path/address parser with the RFC's length limits; a reply parser and writer (multi
 * line, enhanced codes, classification); the SERVER session (greeting, EHLO extensions, MAIL/RCPT/DATA, RSET,
 * VRFY, NOOP, QUIT, AUTH, STARTTLS), which refuses out-of-order commands, oversized messages and lines, too many
 * errors or failed logins, commands smuggled behind STARTTLS (CVE-2011-0411 class) and bare line feeds in message
 * data (SMTP smuggling), and offers AUTH only over TLS unless told otherwise; the CLIENT session, which negotiates
 * STARTTLS, picks an AUTH mechanism, pipelines MAIL and RCPT when the server allows, enforces SIZE, 8BITMIME and
 * SMTPUTF8, dot-stuffs the message and reports each recipient's outcome; and the pipelining rules (which commands
 * end a group). The caller moves bytes and performs the TLS upgrade when told. Not here: DKIM, SPF, MX lookup,
 * CHUNKING/BDAT, DSN parameters, or message parsing.
 */

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- replies

export interface Reply {
  readonly code: number;
  /** Enhanced status code (RFC 3463) when the text begins with one, like "5.7.8". */
  readonly enhanced?: string;
  readonly lines: readonly string[];
}

export type ReplyClass = 'positive' | 'intermediate' | 'transient' | 'permanent';

/** 2xx completed, 3xx waiting for more, 4xx try again later, 5xx do not try again. */
export function classify(code: number): ReplyClass {
  return code < 300 ? 'positive' : code < 400 ? 'intermediate' : code < 500 ? 'transient' : 'permanent';
}

const ENHANCED = /^([245])\.(\d{1,3})\.(\d{1,3})(?: |$)/;

/** Writes a reply with continuation hyphens on all but the last line. */
export function formatReply(code: number, text: string | readonly string[], enhanced?: string): string {
  const lines = typeof text === 'string' ? text.split('\n') : text;
  if (!Number.isInteger(code) || code < 200 || code > 599) throw new ProtocolError(`${code} is not a reply code`);
  if (enhanced !== undefined && !/^[245]\.\d{1,3}\.\d{1,3}$/.test(enhanced)) throw new ProtocolError(`${enhanced} is not an enhanced status code`);
  if (lines.some((l) => /[\r\n\0]/.test(l))) throw new ProtocolError('reply text may not hold line breaks or NUL');
  return lines.map((l, i) => `${code}${i < lines.length - 1 ? '-' : ' '}${enhanced && i === 0 ? `${enhanced} ` : ''}${l}\r\n`).join('');
}

/** Reads replies from a byte stream, however it is cut into chunks; multi-line replies arrive whole. */
export class ReplyParser {
  private buf = '';
  private code = 0;
  private lines: string[] = [];
  private readonly maxLines: number;
  constructor(maxLines = 100) {
    this.maxLines = maxLines;
  }
  push(chunk: string | Buffer): Reply[] {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    const out: Reply[] = [];
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i < 0) {
        if (this.buf.length > 1000) throw new ProtocolError('a reply line is longer than 1000 characters');
        return out;
      }
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^([2-5]\d\d)([ -])?(.*)$/.exec(line);
      if (!m || (m[2] === undefined && m[3] !== '')) throw new ProtocolError(`not a reply line: ${JSON.stringify(line.slice(0, 40))}`);
      const code = Number(m[1]);
      if (this.lines.length && code !== this.code) throw new ProtocolError(`reply lines disagree on the code (${this.code} then ${code})`);
      this.code = code;
      this.lines.push(m[3] ?? '');
      if (this.lines.length > this.maxLines) throw new ProtocolError('a reply has too many lines');
      if (m[2] !== '-') {
        const e = ENHANCED.exec(this.lines[0]!);
        out.push({ code, ...(e ? { enhanced: e[0].trim() } : {}), lines: e ? [this.lines[0]!.slice(e[0].length), ...this.lines.slice(1)] : this.lines });
        this.lines = [];
        this.code = 0;
      }
    }
  }
}

// ---------------------------------------------------------------- addresses and commands

export interface Mailbox {
  readonly local: string;
  readonly domain: string;
  /** local@domain as written (a quoted local part stays quoted). */
  readonly address: string;
}

const LIMITS = { command: 512, path: 256, local: 64, domain: 255, label: 63, data: 1000 } as const;
export const SMTP_LIMITS = LIMITS;

/**
 * Reads a path: "<>" (the null reverse path, as null), "<local@domain>", with an obsolete source route ignored.
 * Quoted local parts and [address literals] are accepted; non-ASCII only when `utf8` is set (RFC 6531).
 */
export function parsePath(text: string, o: { utf8?: boolean; allowNull?: boolean } = {}): Mailbox | null {
  if (!text.startsWith('<') || !text.endsWith('>')) throw new ProtocolError('an address must be inside < and >');
  let inner = text.slice(1, -1);
  if (inner === '') {
    if (o.allowNull) return null;
    throw new ProtocolError('an empty address is allowed only as the sender');
  }
  if (text.length > LIMITS.path) throw new ProtocolError(`a path is longer than ${LIMITS.path}`);
  if (inner.startsWith('@')) {
    const c = inner.indexOf(':');
    if (c < 0 || !/^@[^\s:,]+(,@[^\s:,]+)*$/.test(inner.slice(0, c))) throw new ProtocolError('a source route must be @host,@host:');
    inner = inner.slice(c + 1);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(inner)) throw new ProtocolError('an address may not hold control characters');
  if (!o.utf8 && /[^\x20-\x7e]/.test(inner)) throw new ProtocolError('a non-ASCII address needs SMTPUTF8');
  let local: string;
  let rest: string;
  if (inner.startsWith('"')) {
    let i = 1;
    for (; i < inner.length; i++) {
      if (inner[i] === '\\') i++;
      else if (inner[i] === '"') break;
    }
    if (i >= inner.length || inner[i + 1] !== '@') throw new ProtocolError('a quoted local part must end with "@ after it');
    local = inner.slice(0, i + 1);
    rest = inner.slice(i + 2);
  } else {
    const at = inner.lastIndexOf('@');
    if (at < 1) throw new ProtocolError('an address needs a name, @, and a domain');
    local = inner.slice(0, at);
    rest = inner.slice(at + 1);
    if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) && !(o.utf8 && /^[^\s@<>()[\]\\,;:".]+(\.[^\s@<>()[\]\\,;:".]+)*$/u.test(local))) throw new ProtocolError(`"${local.slice(0, 30)}" is not a valid name before the @`);
  }
  if (local.length > LIMITS.local) throw new ProtocolError(`the name before the @ is longer than ${LIMITS.local}`);
  if (rest.startsWith('[')) {
    if (!/^\[(IPv6:[0-9A-Fa-f:.]+|\d{1,3}(\.\d{1,3}){3})\]$/.test(rest)) throw new ProtocolError('not a valid address literal');
  } else {
    if (rest.length > LIMITS.domain || rest.length < 1) throw new ProtocolError(`a domain is 1 to ${LIMITS.domain} long`);
    const labels = rest.split('.');
    const label = o.utf8 ? /^[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?$/u : /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
    if (labels.some((l) => l.length > LIMITS.label || !label.test(l))) throw new ProtocolError(`"${rest.slice(0, 40)}" is not a valid domain`);
  }
  return { local, domain: rest, address: `${local}@${rest}` };
}

export type Command =
  | { readonly verb: 'HELO' | 'EHLO'; readonly domain: string }
  | { readonly verb: 'MAIL'; readonly from: Mailbox | null; readonly params: Readonly<Record<string, string>> }
  | { readonly verb: 'RCPT'; readonly to: Mailbox; readonly params: Readonly<Record<string, string>> }
  | { readonly verb: 'AUTH'; readonly mechanism: string; readonly initial?: string }
  | { readonly verb: 'DATA' | 'RSET' | 'QUIT' | 'STARTTLS' }
  | { readonly verb: 'NOOP' | 'HELP'; readonly arg: string }
  | { readonly verb: 'VRFY' | 'EXPN'; readonly arg: string };

export class BadCommand extends ProtocolError {
  /** The reply code to answer with: 500 unknown, 501 bad arguments, 555 unsupported parameter. */
  readonly code: 500 | 501 | 555;
  constructor(code: 500 | 501 | 555, message: string) {
    super(message);
    this.code = code;
  }
}

const PARAMS = /^[A-Za-z0-9][A-Za-z0-9-]*(=[\x21-\x3c\x3e-\x7e]+)?$/;

function params(rest: string, utf8: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of rest.split(' ').filter(Boolean)) {
    if (!PARAMS.test(p) && !(utf8 && /^[A-Za-z0-9-]+=\S+$/u.test(p))) throw new BadCommand(501, `"${p.slice(0, 30)}" is not a valid parameter`);
    const [k, v] = p.split(/=(.*)/s);
    const key = k!.toUpperCase();
    if (Object.hasOwn(out, key)) throw new BadCommand(501, `${key} is given twice`);
    out[key] = v ?? '';
  }
  return out;
}

/** Reads one command line (without its CRLF). Throws BadCommand saying which reply to give. */
export function parseCommand(line: string, o: { utf8?: boolean } = {}): Command {
  if (line.length + 2 > LIMITS.command && !/^(MAIL|RCPT)/i.test(line)) throw new BadCommand(500, `a command line is longer than ${LIMITS.command - 2}`);
  if (line.length + 2 > LIMITS.command + 1500) throw new BadCommand(500, 'the command line is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\x00\r\n]/.test(line)) throw new BadCommand(501, 'a command may not hold NUL or line breaks');
  const m = /^([A-Za-z]{4,8})(?: (.*))?$/.exec(line);
  if (!m) throw new BadCommand(500, 'command not recognised');
  const verb = m[1]!.toUpperCase();
  const arg = m[2] ?? '';
  const none = () => {
    if (arg !== '') throw new BadCommand(501, `${verb} takes no argument`);
  };
  switch (verb) {
    case 'HELO':
    case 'EHLO': {
      if (!arg || arg.includes(' ')) throw new BadCommand(501, `${verb} needs one domain or address literal`);
      if (!/^(\[[0-9A-Za-z:.]+\]|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*|[^\s\x00-\x1f]+)$/u.test(arg) || arg.length > LIMITS.domain) throw new BadCommand(501, `"${arg.slice(0, 40)}" is not a domain`);
      return { verb, domain: arg };
    }
    case 'MAIL':
    case 'RCPT': {
      const re = verb === 'MAIL' ? /^FROM:\s?(<[^>]*>|<.*>)(?: (.*))?$/i : /^TO:\s?(<[^>]*>|<.*>)(?: (.*))?$/i;
      const mm = re.exec(arg);
      if (!mm) throw new BadCommand(501, `${verb} is written ${verb} ${verb === 'MAIL' ? 'FROM' : 'TO'}:<address>`);
      const p = params(mm[2] ?? '', !!o.utf8);
      try {
        if (verb === 'MAIL') return { verb, from: parsePath(mm[1]!, { allowNull: true, utf8: !!o.utf8 || p.SMTPUTF8 !== undefined }), params: p };
        return { verb, to: parsePath(mm[1]!, { utf8: !!o.utf8 })!, params: p };
      } catch (e) {
        throw new BadCommand(501, e instanceof Error ? e.message : String(e));
      }
    }
    case 'AUTH': {
      const parts = arg.split(' ').filter(Boolean);
      if (parts.length < 1 || parts.length > 2 || !/^[A-Z0-9_-]{1,20}$/i.test(parts[0]!)) throw new BadCommand(501, 'AUTH is written AUTH mechanism [initial-response]');
      return { verb, mechanism: parts[0]!.toUpperCase(), ...(parts[1] !== undefined ? { initial: parts[1] } : {}) };
    }
    case 'DATA':
    case 'RSET':
    case 'QUIT':
    case 'STARTTLS':
      none();
      return { verb };
    case 'NOOP':
    case 'HELP':
      return { verb, arg };
    case 'VRFY':
    case 'EXPN':
      if (!arg) throw new BadCommand(501, `${verb} needs an argument`);
      return { verb, arg };
    default:
      throw new BadCommand(500, `command "${verb}" not recognised`);
  }
}

// ---------------------------------------------------------------- pipelining

/**
 * Commands that must be the last of a pipelined group (RFC 2920 section 3.1): the sender waits for their reply
 * before sending more. MAIL, RCPT and RSET may appear anywhere in a group.
 */
export function endsGroup(verb: string): boolean {
  return ['EHLO', 'HELO', 'DATA', 'VRFY', 'EXPN', 'TURN', 'QUIT', 'NOOP', 'STARTTLS', 'AUTH', 'HELP'].includes(verb.toUpperCase());
}

/** Splits commands into the groups a client may send without waiting between them (when the server allows pipelining). */
export function pipelineGroups(commands: readonly string[], pipelining: boolean): string[][] {
  if (!pipelining) return commands.map((c) => [c]);
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const c of commands) {
    cur.push(c);
    if (endsGroup(c.split(' ')[0]!)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ---------------------------------------------------------------- SASL

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const unb64 = (s: string): Buffer => {
  if (s !== '' && !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new ProtocolError('not base64');
  if (s.length % 4 !== 0) throw new ProtocolError('not base64');
  return Buffer.from(s, 'base64');
};

/** The PLAIN initial response (RFC 4616): authzid NUL authcid NUL password, base64. */
export const plainInitial = (user: string, pass: string, authzid = ''): string => b64(`${authzid}\0${user}\0${pass}`);
/** The XOAUTH2 initial response: user=…^Aauth=Bearer …^A^A, base64. */
export const xoauth2Initial = (user: string, token: string): string => b64(`user=${user}\x01auth=Bearer ${token}\x01\x01`);

export function parsePlain(b64text: string): { authzid: string; user: string; pass: string } {
  const parts = unb64(b64text).toString('utf8').split('\0');
  if (parts.length !== 3 || !parts[1]) throw new ProtocolError('PLAIN needs authzid, user and password separated by NUL');
  return { authzid: parts[0]!, user: parts[1]!, pass: parts[2]! };
}

export function parseXoauth2(b64text: string): { user: string; token: string } {
  const s = unb64(b64text).toString('utf8');
  const m = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]+)\x01\x01$/.exec(s);
  if (!m || !m[1]) throw new ProtocolError('not an XOAUTH2 response');
  return { user: m[1], token: m[2]! };
}

// ---------------------------------------------------------------- server

export interface Verdict {
  readonly code: number;
  readonly text: string;
  readonly enhanced?: string;
}

export interface Envelope {
  /** "" for the null reverse path (bounces). */
  readonly from: string;
  readonly to: readonly string[];
  readonly size?: number;
  readonly body7bit: boolean;
  readonly smtputf8: boolean;
  readonly authenticatedAs?: string;
  readonly tls: boolean;
  readonly client: string;
}

export interface ServerOptions {
  readonly hostname: string;
  readonly maxSize?: number;
  readonly maxRecipients?: number;
  /** STARTTLS is offered; the caller upgrades the socket when the session says so. */
  readonly tls?: boolean;
  /** Mail is refused until the session is encrypted (a submission port). */
  readonly requireTls?: boolean;
  readonly requireAuth?: boolean;
  readonly auth?: {
    readonly mechanisms: readonly ('PLAIN' | 'LOGIN' | 'XOAUTH2')[];
    /** For PLAIN and LOGIN, the password; for XOAUTH2, the bearer token. */
    readonly verify: (mechanism: string, user: string, secret: string) => boolean;
    /** Offer and accept AUTH without TLS. Off by default: credentials never cross in the clear. */
    readonly allowInsecure?: boolean;
  };
  readonly onSender?: (from: string, env: Partial<Envelope>) => Verdict | void;
  readonly onRecipient?: (to: string, env: Partial<Envelope>) => Verdict | void;
  readonly onMessage: (env: Envelope, body: Buffer) => Verdict | void;
  readonly maxAuthFailures?: number;
  readonly maxErrors?: number;
  /** Refuse message data holding a bare LF or CR, which smuggles a second message past a parser that splits differently. */
  readonly allowBareNewlines?: boolean;
}

export interface Output {
  readonly write: string;
  readonly close: boolean;
  /** Upgrade the socket now, then call tlsStarted(). */
  readonly startTls: boolean;
}

type State = 'new' | 'greeted' | 'hello' | 'mail' | 'rcpt' | 'data' | 'auth-plain' | 'auth-login-user' | 'auth-login-pass' | 'auth-xoauth-error' | 'closed';

export class ServerSession {
  private readonly o: Required<Pick<ServerOptions, 'maxSize' | 'maxRecipients' | 'maxAuthFailures' | 'maxErrors'>> & ServerOptions;
  private state: State = 'new';
  private buf: Buffer = Buffer.alloc(0);
  private tls = false;
  private client = '';
  private from: string | undefined;
  private params: Record<string, string> = {};
  private rcpts: string[] = [];
  private user: string | undefined;
  private loginUser = '';
  private authFailures = 0;
  private errors = 0;
  private data: Buffer[] = [];
  private dataBytes = 0;
  private overflow = false;
  private tail: Buffer = Buffer.alloc(0);

  constructor(o: ServerOptions) {
    this.o = { maxSize: 10 * 1024 * 1024, maxRecipients: 100, maxAuthFailures: 3, maxErrors: 10, ...o };
  }

  get authenticatedAs(): string | undefined {
    return this.user;
  }
  get encrypted(): boolean {
    return this.tls;
  }

  /** The 220 line to send when a connection opens. */
  greeting(): string {
    this.state = 'greeted';
    return formatReply(220, `${this.o.hostname} ESMTP ready`);
  }

  /** The socket has been upgraded: the session forgets everything but the encryption (RFC 3207). */
  tlsStarted(): void {
    this.tls = true;
    this.state = 'greeted';
    this.client = '';
    this.user = undefined;
    this.resetTransaction();
    this.buf = Buffer.alloc(0);
  }

  private resetTransaction(): void {
    this.from = undefined;
    this.params = {};
    this.rcpts = [];
    this.data = [];
    this.dataBytes = 0;
    this.overflow = false;
    this.tail = Buffer.alloc(0);
    if (this.state !== 'new' && this.state !== 'greeted' && this.state !== 'closed') this.state = this.client ? 'hello' : 'greeted';
  }

  private authOffered(): boolean {
    return !!this.o.auth && (this.tls || !!this.o.auth.allowInsecure);
  }

  /** Feeds received bytes; returns what to write back, and whether to close or upgrade. */
  feed(chunk: Buffer | string): Output {
    let write = '';
    let close = false;
    let startTls = false;
    if (this.state === 'closed') return { write: '', close: true, startTls: false };
    this.buf = Buffer.concat([this.buf, typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk]);
    for (;;) {
      if (this.state === 'data') {
        const r = this.dataStep();
        if (r === null) break;
        write += r;
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) {
        if (this.buf.length > LIMITS.command + 1500) {
          write += formatReply(500, 'line too long', '5.5.2');
          close = true;
          this.state = 'closed';
          this.buf = Buffer.alloc(0);
        }
        break;
      }
      const line = this.buf.subarray(0, nl).toString('latin1').replace(/\r$/, '');
      const rest = this.buf.subarray(nl + 1);
      this.buf = rest;
      const out = this.line(line, rest.length > 0);
      write += out.write;
      if (out.startTls) {
        startTls = true;
        // Anything the client sent after STARTTLS was read before the handshake; it must not run after it.
        this.buf = Buffer.alloc(0);
        break;
      }
      if (out.close) {
        close = true;
        this.state = 'closed';
        break;
      }
    }
    return { write, close, startTls };
  }

  private bad(code: number, text: string, enhanced: string): Output {
    this.errors++;
    if (this.errors > this.o.maxErrors) {
      this.state = 'closed';
      return { write: formatReply(421, 'too many errors, closing', '4.7.0'), close: true, startTls: false };
    }
    return { write: formatReply(code, text, enhanced), close: false, startTls: false };
  }

  private ok(code: number, text: string | string[], enhanced?: string): Output {
    return { write: formatReply(code, text, enhanced), close: false, startTls: false };
  }

  private verdict(v: Verdict): Output {
    return v.code >= 400 ? this.bad(v.code, v.text, v.enhanced ?? (v.code < 500 ? '4.0.0' : '5.0.0')) : this.ok(v.code, v.text, v.enhanced);
  }

  private env(): Partial<Envelope> {
    return { from: this.from ?? '', to: this.rcpts, tls: this.tls, client: this.client, ...(this.user !== undefined ? { authenticatedAs: this.user } : {}) };
  }

  private line(line: string, more: boolean): Output {
    // The authentication dialogue answers with base64 lines, not commands.
    if (this.state === 'auth-plain' || this.state === 'auth-login-user' || this.state === 'auth-login-pass' || this.state === 'auth-xoauth-error') return this.authLine(line);
    let cmd: Command;
    try {
      cmd = parseCommand(line, { utf8: true });
    } catch (e) {
      if (e instanceof BadCommand) return this.bad(e.code, e.message, e.code === 500 ? '5.5.2' : e.code === 555 ? '5.5.4' : '5.5.4');
      throw e;
    }
    const hello = this.state !== 'new' && this.state !== 'greeted';
    switch (cmd.verb) {
      case 'QUIT':
        return { write: formatReply(221, 'bye', '2.0.0'), close: true, startTls: false };
      case 'NOOP':
        return this.ok(250, 'OK', '2.0.0');
      case 'HELP':
        return this.ok(214, 'see RFC 5321', '2.0.0');
      case 'VRFY':
      case 'EXPN':
        return this.ok(252, 'cannot verify, will accept and attempt delivery', '2.5.0');
      case 'RSET':
        this.resetTransaction();
        return this.ok(250, 'OK', '2.0.0');
      case 'HELO':
      case 'EHLO': {
        this.client = cmd.domain;
        this.resetTransaction();
        this.state = 'hello';
        if (cmd.verb === 'HELO') return this.ok(250, this.o.hostname);
        const ext = ['PIPELINING', `SIZE ${this.o.maxSize}`, '8BITMIME', 'SMTPUTF8', 'ENHANCEDSTATUSCODES'];
        if (this.o.tls && !this.tls) ext.push('STARTTLS');
        if (this.authOffered() && !this.user) ext.push(`AUTH ${this.o.auth!.mechanisms.join(' ')}`);
        return this.ok(250, [`${this.o.hostname} greets ${cmd.domain}`, ...ext]);
      }
      case 'STARTTLS':
        if (!this.o.tls) return this.bad(502, 'STARTTLS is not available', '5.5.1');
        if (this.tls) return this.bad(503, 'already using TLS', '5.5.1');
        if (more) {
          // Bytes arrived behind the command in the clear: they would be run as if sent over TLS.
          this.state = 'closed';
          return { write: formatReply(554, 'commands may not follow STARTTLS in the same packet', '5.5.0'), close: true, startTls: false };
        }
        return { write: formatReply(220, 'ready to start TLS', '2.0.0'), close: false, startTls: true };
      case 'AUTH':
        return this.authStart(cmd, hello);
      case 'MAIL': {
        if (!hello) return this.bad(503, 'send EHLO or HELO first', '5.5.1');
        if (this.state !== 'hello') return this.bad(503, 'a mail transaction is already open', '5.5.1');
        if (this.o.requireTls && !this.tls) return this.bad(530, 'must issue STARTTLS first', '5.7.0');
        if (this.o.requireAuth && !this.user) return this.bad(530, 'authentication required', '5.7.0');
        for (const k of Object.keys(cmd.params)) if (!['SIZE', 'BODY', 'SMTPUTF8', 'AUTH'].includes(k)) return this.bad(555, `${k} is not supported`, '5.5.4');
        if (cmd.params.SIZE !== undefined) {
          if (!/^\d{1,12}$/.test(cmd.params.SIZE)) return this.bad(501, 'SIZE must be a number', '5.5.4');
          if (Number(cmd.params.SIZE) > this.o.maxSize) return this.bad(552, `message size exceeds the limit of ${this.o.maxSize}`, '5.3.4');
        }
        if (cmd.params.BODY !== undefined && !['7BIT', '8BITMIME'].includes(cmd.params.BODY.toUpperCase())) return this.bad(501, 'BODY must be 7BIT or 8BITMIME', '5.5.4');
        if (cmd.params.SMTPUTF8 !== undefined && cmd.params.SMTPUTF8 !== '') return this.bad(501, 'SMTPUTF8 takes no value', '5.5.4');
        const from = cmd.from?.address ?? '';
        const v = this.o.onSender?.(from, this.env());
        if (v) {
          if (v.code >= 400) return this.verdict(v);
        }
        this.from = from;
        this.params = { ...cmd.params };
        this.state = 'mail';
        return this.ok(250, 'sender OK', '2.1.0');
      }
      case 'RCPT': {
        if (this.state !== 'mail' && this.state !== 'rcpt') return this.bad(503, hello ? 'send MAIL first' : 'send EHLO or HELO first', '5.5.1');
        for (const k of Object.keys(cmd.params)) if (k !== 'NOTIFY' && k !== 'ORCPT') return this.bad(555, `${k} is not supported`, '5.5.4');
        if (this.rcpts.length >= this.o.maxRecipients) return this.bad(452, 'too many recipients', '4.5.3');
        const v = this.o.onRecipient?.(cmd.to.address, this.env());
        if (v && v.code >= 400) return this.verdict(v);
        this.rcpts.push(cmd.to.address);
        this.state = 'rcpt';
        return this.ok(250, 'recipient OK', '2.1.5');
      }
      case 'DATA':
        if (this.state === 'mail') return this.bad(554, 'no valid recipients', '5.5.1');
        if (this.state !== 'rcpt') return this.bad(503, hello ? 'send MAIL and RCPT first' : 'send EHLO or HELO first', '5.5.1');
        this.state = 'data';
        this.data = [Buffer.from('\r\n')];
        this.dataBytes = 0;
        this.overflow = false;
        this.tail = Buffer.from('\r\n');
        return this.ok(354, 'end data with <CR><LF>.<CR><LF>');
    }
  }

  /** Reads message data; null when it needs more bytes. */
  private dataStep(): string | null {
    if (!this.buf.length) return null;
    const joined = Buffer.concat([this.tail, this.buf]);
    const end = joined.indexOf('\r\n.\r\n');
    const keepTail = (b: Buffer) => b.subarray(Math.max(0, b.length - 4));
    if (end < 0) {
      this.dataBytes += this.buf.length;
      if (this.dataBytes > this.o.maxSize) {
        this.overflow = true;
        this.data = [];
      } else if (!this.overflow) this.data.push(this.buf);
      this.tail = keepTail(joined);
      this.buf = Buffer.alloc(0);
      return null;
    }
    // `joined` starts with the tail already counted; the terminator ends at end+5.
    const consumed = end + 5 - this.tail.length;
    const piece = this.buf.subarray(0, Math.max(0, consumed));
    const after = this.buf.subarray(Math.max(0, consumed));
    this.dataBytes += piece.length;
    if (this.dataBytes > this.o.maxSize) this.overflow = true;
    let body: Buffer | undefined;
    if (!this.overflow) {
      const all = Buffer.concat([...this.data, piece]);
      // all = "\r\n" + message lines + "\r\n.\r\n": drop the virtual start and the terminator, keep the last CRLF.
      body = all.subarray(2, all.length - 3);
    }
    this.buf = after;
    this.tail = Buffer.alloc(0);
    const env: Envelope = { from: this.from ?? '', to: [...this.rcpts], body7bit: (this.params.BODY ?? '').toUpperCase() !== '8BITMIME', smtputf8: this.params.SMTPUTF8 !== undefined, tls: this.tls, client: this.client, ...(this.params.SIZE ? { size: Number(this.params.SIZE) } : {}), ...(this.user !== undefined ? { authenticatedAs: this.user } : {}) };
    this.data = [];
    this.state = 'hello';
    this.from = undefined;
    this.params = {};
    this.rcpts = [];
    if (this.overflow) {
      this.overflow = false;
      return formatReply(552, 'message too large', '5.3.4');
    }
    const s = body!.toString('latin1');
    if (!this.o.allowBareNewlines && /(?<!\r)\n|\r(?!\n)/.test(s)) return formatReply(554, 'bare line feed or carriage return in message data is not allowed', '5.6.0');
    const clean = Buffer.from(s.replace(/\r\n\./g, '\r\n').replace(/^\./, ''), 'latin1');
    const v = this.o.onMessage(env, clean);
    if (v) return formatReply(v.code, v.text, v.enhanced);
    return formatReply(250, 'message accepted for delivery', '2.0.0');
  }

  private authStart(cmd: Extract<Command, { verb: 'AUTH' }>, hello: boolean): Output {
    const a = this.o.auth;
    if (!hello) return this.bad(503, 'send EHLO first', '5.5.1');
    if (!a) return this.bad(502, 'AUTH is not available', '5.5.1');
    if (!this.authOffered()) return this.bad(538, 'encryption required for requested authentication mechanism', '5.7.11');
    if (this.user) return this.bad(503, 'already authenticated', '5.5.1');
    if (this.state !== 'hello') return this.bad(503, 'AUTH is not allowed during a mail transaction', '5.5.1');
    if (!a.mechanisms.includes(cmd.mechanism as 'PLAIN')) return this.bad(504, 'unrecognized authentication type', '5.5.4');
    if (cmd.mechanism === 'LOGIN') {
      if (cmd.initial === undefined) {
        this.state = 'auth-login-user';
        return this.ok(334, b64('Username:'));
      }
      return this.loginUserLine(cmd.initial);
    }
    if (cmd.initial === undefined) {
      this.state = 'auth-plain';
      this.pending = cmd.mechanism;
      return this.ok(334, '');
    }
    this.pending = cmd.mechanism;
    return this.authLine(cmd.initial === '=' ? '' : cmd.initial);
  }

  private pending = '';

  private authFail(code: number, text: string, enhanced: string): Output {
    this.authFailures++;
    this.state = 'hello';
    if (this.authFailures >= this.o.maxAuthFailures) {
      this.state = 'closed';
      return { write: formatReply(421, 'too many failed logins, closing', '4.7.0'), close: true, startTls: false };
    }
    return this.bad(code, text, enhanced);
  }

  private loginUserLine(line: string): Output {
    if (line === '*') {
      this.state = 'hello';
      return this.bad(501, 'authentication cancelled', '5.0.0');
    }
    try {
      this.loginUser = unb64(line).toString('utf8');
    } catch {
      this.state = 'hello';
      return this.bad(501, 'cannot decode the response', '5.5.2');
    }
    this.state = 'auth-login-pass';
    return this.ok(334, b64('Password:'));
  }

  private authLine(line: string): Output {
    const a = this.o.auth!;
    if (this.state === 'auth-xoauth-error') {
      // The client acknowledges the error JSON with an empty line; the failure is then final.
      return this.authFail(535, 'authentication failed', '5.7.8');
    }
    if (line === '*') {
      this.state = 'hello';
      return this.bad(501, 'authentication cancelled', '5.0.0');
    }
    if (this.state === 'auth-login-user') return this.loginUserLine(line);
    let user = '';
    let secret = '';
    let mech = 'LOGIN';
    try {
      if (this.state === 'auth-login-pass') {
        user = this.loginUser;
        secret = unb64(line).toString('utf8');
      } else if (this.pending === 'PLAIN') {
        mech = 'PLAIN';
        const p = parsePlain(line);
        user = p.user;
        secret = p.pass;
        if (p.authzid && p.authzid !== p.user) return this.authFail(535, 'authorization identity not permitted', '5.7.8');
      } else {
        mech = 'XOAUTH2';
        const x = parseXoauth2(line);
        user = x.user;
        secret = x.token;
      }
    } catch {
      this.state = 'hello';
      return this.bad(501, 'cannot decode the response', '5.5.2');
    }
    if (a.verify(mech, user, secret)) {
      this.user = user;
      this.state = 'hello';
      this.authFailures = 0;
      return this.ok(235, 'authentication successful', '2.7.0');
    }
    if (mech === 'XOAUTH2') {
      this.state = 'auth-xoauth-error';
      return this.ok(334, b64(JSON.stringify({ status: '401', schemes: 'Bearer', scope: 'mail' })));
    }
    return this.authFail(535, 'authentication credentials invalid', '5.7.8');
  }
}

// ---------------------------------------------------------------- client

export interface ClientMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly body: Buffer | string;
}

export interface ClientOptions {
  /** The name sent in EHLO. */
  readonly ehlo: string;
  readonly message: ClientMessage;
  /** required: fail when STARTTLS is not offered; opportunistic: use it when offered; none: never. */
  readonly tls?: 'required' | 'opportunistic' | 'none';
  /** The connection is already encrypted (an implicit-TLS port). */
  readonly alreadyTls?: boolean;
  readonly auth?: { readonly user: string; readonly pass?: string; readonly token?: string };
  /** Send credentials even over a plaintext connection. Off by default. */
  readonly allowInsecureAuth?: boolean;
  readonly pipelining?: boolean;
}

export type ClientResult =
  | { readonly ok: true; readonly accepted: readonly string[]; readonly rejected: readonly { to: string; code: number; text: string }[]; readonly reply: Reply }
  | { readonly ok: false; readonly stage: string; readonly code: number; readonly text: string; readonly temporary: boolean };

export interface ClientStep {
  readonly send: string;
  readonly startTls?: true;
  readonly done?: ClientResult;
}

/** Dot-stuffs a message and ends it: bare LF becomes CRLF, a lone "." line is protected, and the end marker is added. */
export function prepareBody(body: Buffer | string): Buffer {
  const s = (typeof body === 'string' ? Buffer.from(body, 'utf8') : body).toString('latin1');
  let t = s.replace(/\r\n|\r|\n/g, '\r\n');
  if (t !== '' && !t.endsWith('\r\n')) t += '\r\n';
  t = t.replace(/(^|\r\n)\./g, '$1..');
  return Buffer.from(`${t}.\r\n`, 'latin1');
}

type CState = 'greeting' | 'ehlo' | 'starttls' | 'ehlo-tls' | 'auth' | 'auth-login-user' | 'auth-login-pass' | 'auth-error' | 'mail' | 'rcpt' | 'pipeline' | 'data' | 'body' | 'quit' | 'done';

export class ClientSession {
  private state: CState = 'greeting';
  private tls: boolean;
  private ext = new Map<string, string>();
  private readonly o: ClientOptions;
  private accepted: string[] = [];
  private rejected: { to: string; code: number; text: string }[] = [];
  private rcptIndex = 0;
  private pendingReplies = 0;
  private pipelineFailed: ClientResult | undefined;
  private result: ClientResult | undefined;
  private mech = '';

  constructor(o: ClientOptions) {
    this.o = o;
    this.tls = !!o.alreadyTls;
  }

  private fail(stage: string, r: Reply | { code: number; text: string }, quit = true): ClientStep {
    const text = 'lines' in r ? r.lines.join(' ') : r.text;
    this.result = { ok: false, stage, code: r.code, text, temporary: classify(r.code) === 'transient' };
    this.state = 'quit';
    return quit ? { send: 'QUIT\r\n' } : { send: '', done: this.result };
  }

  private failLocal(stage: string, text: string): ClientStep {
    this.result = { ok: false, stage, code: 0, text, temporary: false };
    this.state = 'quit';
    return { send: 'QUIT\r\n' };
  }

  /** After the socket is upgraded in answer to `startTls`. */
  tlsStarted(): ClientStep {
    this.tls = true;
    this.ext.clear();
    this.state = 'ehlo-tls';
    return { send: `EHLO ${this.o.ehlo}\r\n` };
  }

  private mailCommands(): string[] {
    const m = this.o.message;
    const body = prepareBody(m.body);
    const eightBit = [...body].some((b) => b > 127);
    const utf8Addr = [m.from, ...m.to].some((a) => /[^\x20-\x7e]/.test(a));
    const p: string[] = [];
    if (this.ext.has('SIZE')) p.push(`SIZE=${body.length}`);
    if (eightBit && this.ext.has('8BITMIME')) p.push('BODY=8BITMIME');
    if (utf8Addr) p.push('SMTPUTF8');
    return [`MAIL FROM:<${m.from}>${p.length ? ' ' + p.join(' ') : ''}`, ...m.to.map((r) => `RCPT TO:<${r}>`)];
  }

  private beginMail(): ClientStep {
    const m = this.o.message;
    for (const a of [m.from, ...m.to]) if (/[<>\r\n\0]/.test(a)) return this.failLocal('mail', `the address ${JSON.stringify(a.slice(0, 40))} holds characters that cannot be sent`);
    if (!m.to.length) return this.failLocal('mail', 'there is no recipient');
    const body = prepareBody(m.body);
    const eightBit = [...body].some((b) => b > 127);
    const utf8Addr = [m.from, ...m.to].some((a) => /[^\x20-\x7e]/.test(a));
    const size = this.ext.get('SIZE');
    if (size && Number(size) > 0 && body.length > Number(size)) return this.failLocal('mail', `the message is ${body.length} bytes; the server accepts ${size}`);
    if (eightBit && !this.ext.has('8BITMIME')) return this.failLocal('mail', 'the message has 8-bit bytes and the server does not offer 8BITMIME; encode it as 7-bit first');
    if (utf8Addr && !this.ext.has('SMTPUTF8')) return this.failLocal('mail', 'an address is not ASCII and the server does not offer SMTPUTF8');
    const cmds = this.mailCommands();
    if (this.o.pipelining !== false && this.ext.has('PIPELINING')) {
      this.state = 'pipeline';
      this.pendingReplies = cmds.length;
      this.rcptIndex = 0;
      return { send: cmds.map((c) => `${c}\r\n`).join('') };
    }
    this.state = 'mail';
    return { send: `${cmds[0]}\r\n` };
  }

  private afterEhlo(): ClientStep {
    const tlsMode = this.o.tls ?? 'required';
    if (!this.tls && this.ext.has('STARTTLS') && tlsMode !== 'none') {
      this.state = 'starttls';
      return { send: 'STARTTLS\r\n' };
    }
    if (!this.tls && tlsMode === 'required') return this.failLocal('starttls', 'the server does not offer STARTTLS and encryption is required');
    const a = this.o.auth;
    if (a) {
      if (!this.tls && !this.o.allowInsecureAuth) return this.failLocal('auth', 'credentials are not sent over an unencrypted connection');
      const offered = (this.ext.get('AUTH') ?? '').toUpperCase().split(' ').filter(Boolean);
      const pick = a.token && offered.includes('XOAUTH2') ? 'XOAUTH2' : a.pass !== undefined && offered.includes('PLAIN') ? 'PLAIN' : a.pass !== undefined && offered.includes('LOGIN') ? 'LOGIN' : '';
      if (!pick) return this.failLocal('auth', `the server offers ${offered.join(', ') || 'no AUTH'}, none usable with these credentials`);
      this.mech = pick;
      this.state = pick === 'LOGIN' ? 'auth-login-user' : 'auth';
      if (pick === 'LOGIN') return { send: 'AUTH LOGIN\r\n' };
      return { send: `AUTH ${pick} ${pick === 'PLAIN' ? plainInitial(a.user, a.pass!) : xoauth2Initial(a.user, a.token!)}\r\n` };
    }
    return this.beginMail();
  }

  /** Feeds one complete reply; returns what to send next, or the final result. */
  receive(r: Reply): ClientStep {
    const cls = classify(r.code);
    switch (this.state) {
      case 'greeting':
        if (r.code !== 220) return this.fail('greeting', r, false);
        this.state = 'ehlo';
        return { send: `EHLO ${this.o.ehlo}\r\n` };
      case 'ehlo':
      case 'ehlo-tls': {
        if (cls !== 'positive') return this.fail('ehlo', r, false);
        // The first line is the greeting; the rest are extensions.
        for (const l of r.lines.slice(1)) {
          const [k, ...v] = l.split(' ');
          this.ext.set(k!.toUpperCase(), v.join(' '));
        }
        return this.afterEhlo();
      }
      case 'starttls':
        if (r.code !== 220) {
          if ((this.o.tls ?? 'required') === 'required') return this.fail('starttls', r);
          this.ext.delete('STARTTLS');
          return this.afterEhlo();
        }
        return { send: '', startTls: true };
      case 'auth':
        if (r.code === 235) return this.beginMail();
        if (r.code === 334 && this.mech === 'XOAUTH2') {
          this.state = 'auth-error';
          return { send: '\r\n' };
        }
        return this.fail('auth', r);
      case 'auth-error':
        return this.fail('auth', r);
      case 'auth-login-user':
        if (r.code !== 334) return this.fail('auth', r);
        this.state = 'auth-login-pass';
        return { send: `${b64(this.o.auth!.user)}\r\n` };
      case 'auth-login-pass':
        if (r.code !== 334) return this.fail('auth', r);
        this.state = 'auth';
        return { send: `${b64(this.o.auth!.pass!)}\r\n` };
      case 'mail':
        if (cls !== 'positive') return this.fail('mail', r);
        this.state = 'rcpt';
        this.rcptIndex = 0;
        return { send: `RCPT TO:<${this.o.message.to[0]}>\r\n` };
      case 'rcpt': {
        this.recordRcpt(r);
        if (this.rcptIndex < this.o.message.to.length) return { send: `RCPT TO:<${this.o.message.to[this.rcptIndex]}>\r\n` };
        return this.afterRcpts(r);
      }
      case 'pipeline': {
        // The first reply answers MAIL, the rest answer each RCPT in order.
        const total = this.o.message.to.length + 1;
        const n = total - this.pendingReplies;
        this.pendingReplies--;
        if (n === 0) {
          if (cls !== 'positive') this.pipelineFailed = { ok: false, stage: 'mail', code: r.code, text: r.lines.join(' '), temporary: cls === 'transient' };
        } else this.recordRcpt(r);
        if (this.pendingReplies > 0) return { send: '' };
        if (this.pipelineFailed) {
          this.result = this.pipelineFailed;
          this.state = 'quit';
          return { send: 'QUIT\r\n' };
        }
        return this.afterRcpts(r);
      }
      case 'data':
        if (r.code !== 354) return this.fail('data', r);
        this.state = 'body';
        return { send: prepareBody(this.o.message.body).toString('latin1') };
      case 'body':
        if (cls !== 'positive') return this.fail('body', r);
        this.result = { ok: true, accepted: this.accepted, rejected: this.rejected, reply: r };
        this.state = 'quit';
        return { send: 'QUIT\r\n' };
      case 'quit':
        this.state = 'done';
        return { send: '', done: this.result! };
      case 'done':
        return { send: '', done: this.result! };
    }
  }

  private recordRcpt(r: Reply): void {
    const to = this.o.message.to[this.rcptIndex++]!;
    if (classify(r.code) === 'positive') this.accepted.push(to);
    else this.rejected.push({ to, code: r.code, text: r.lines.join(' ') });
  }

  private afterRcpts(last: Reply): ClientStep {
    if (!this.accepted.length) {
      const first = this.rejected[0]!;
      void last;
      return this.fail('rcpt', { code: first.code, text: first.text });
    }
    this.state = 'data';
    return { send: 'DATA\r\n' };
  }

  /** The connection closed or a reply never came: the result so far, or a failure. */
  get final(): ClientResult | undefined {
    return this.result;
  }
}
