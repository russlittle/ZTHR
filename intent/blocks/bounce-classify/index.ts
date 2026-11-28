/**
 * Returned mail read for what it means. A delivery status notification (RFC 3464, multipart/report with a
 * message/delivery-status part) is parsed per recipient; enhanced status codes (RFC 3463) and plain SMTP replies
 * (RFC 5321) are classed as hard (the address will never work), soft (try later, or the mailbox is full or the
 * message too big) or delivered; feedback-loop complaints in the Abuse Reporting Format (RFC 5965, with opt-out
 * from RFC 6650) are complaints; and automatic replies (RFC 3834 Auto-Submitted, out-of-office headers) are told
 * apart so they are never counted as bounces. Soft bounces that keep coming are escalated to hard by a tracker.
 * The result feeds the notify block's suppression list through its `bounce(address, kind)` call.
 * A small MIME reader (headers, multipart, size and depth limits) is inside because only these parts are needed.
 */

export class NotAReport extends Error {
  constructor(why: string) {
    super(`not a readable report: ${why}`);
  }
}

export type BounceClass = 'hard' | 'soft' | 'complaint' | 'delivered' | 'unknown';

export interface Part {
  readonly headers: ReadonlyMap<string, string>;
  /** The body, for a leaf. */
  readonly body: string;
  readonly parts: readonly Part[];
}

const MAX_BYTES = 5_000_000;
const MAX_PARTS = 50;
const MAX_DEPTH = 6;

/** Headers, unfolded, with lower-case names; a repeated name keeps the first. */
function parseHeaders(block: string): Map<string, string> {
  const m = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  let name = '';
  let value = '';
  const flush = () => {
    if (name && !m.has(name)) m.set(name, value.trim());
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && name) value += ` ${line.trim()}`;
    else {
      flush();
      const i = line.indexOf(':');
      if (i > 0 && /^[!-9;-~]+$/.test(line.slice(0, i))) {
        name = line.slice(0, i).toLowerCase();
        value = line.slice(i + 1);
      } else {
        name = '';
        value = '';
      }
    }
  }
  flush();
  return m;
}

const splitHead = (raw: string): [string, string] => {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ''];
};

/** The value and parameters of a structured header like Content-Type. */
export function params(h: string | undefined): { value: string; params: Record<string, string> } {
  const [first = '', ...rest] = (h ?? '').split(';');
  const out: Record<string, string> = {};
  for (const p of rest) {
    const m = /^\s*([^=\s]+)\s*=\s*(?:"([^"]*)"|([^\s;]*))/.exec(p);
    if (m) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return { value: first.trim().toLowerCase(), params: out };
}

export function parseMime(raw: string, depth = 0, count = { n: 0 }): Part {
  if (raw.length > MAX_BYTES) throw new NotAReport('it is larger than 5 MB');
  if (depth > MAX_DEPTH) throw new NotAReport('its parts are nested too deeply');
  if (++count.n > MAX_PARTS) throw new NotAReport('it has too many parts');
  const [head, body] = splitHead(raw);
  const headers = parseHeaders(head);
  const ct = params(headers.get('content-type'));
  if (ct.value.startsWith('multipart/')) {
    const b = ct.params['boundary'];
    if (!b) throw new NotAReport('a multipart message has no boundary');
    const chunks = body.split(new RegExp(`(?:^|\\r?\\n)--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?=\\r?\\n|$)`));
    const inner = chunks.slice(1, -1).map((c) => c.replace(/^\r?\n/, ''));
    return { headers, body: '', parts: inner.map((c) => parseMime(c, depth + 1, count)) };
  }
  return { headers, body, parts: [] };
}

const find = (p: Part, pred: (p: Part) => boolean): Part | undefined => {
  if (pred(p)) return p;
  for (const c of p.parts) {
    const f = find(c, pred);
    if (f) return f;
  }
  return undefined;
};
const typeOf = (p: Part) => params(p.headers.get('content-type')).value;

// ---------------------------------------------------------------- status codes

export interface Status {
  readonly cls: 2 | 4 | 5;
  readonly subject: number;
  readonly detail: number;
  readonly text: string;
}

const SUBJECTS = ['other or undefined', 'addressing', 'mailbox', 'mail system', 'network and routing', 'mail delivery protocol', 'message content or media', 'security or policy'];
const KNOWN: Readonly<Record<string, string>> = {
  '5.1.1': 'the mailbox does not exist',
  '5.1.2': 'the domain does not exist',
  '5.1.3': 'the address is badly formed',
  '5.1.6': 'the mailbox has moved',
  '5.2.1': 'the mailbox is disabled',
  '5.2.2': 'the mailbox is full',
  '4.2.2': 'the mailbox is full',
  '5.3.4': 'the message is too big for the system',
  '5.4.4': 'no route to the host',
  '5.5.0': 'the receiving server did not understand the command',
  '5.6.1': 'the content type is not supported',
  '5.7.1': 'delivery is not authorised, or blocked by policy',
  '5.7.26': 'the message failed sender authentication',
  '4.4.1': 'the remote server did not answer',
  '4.7.0': 'delivery is temporarily deferred by policy',
};

/** Parses "5.1.1". Refuses anything that is not class 2, 4 or 5 with one to three digits in each part. */
export function parseStatus(s: string): Status {
  const m = /^([245])\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) throw new NotAReport(`${JSON.stringify(s.slice(0, 20))} is not an enhanced status code`);
  const subject = Number(m[2]);
  const code = `${m[1]}.${subject}.${Number(m[3])}`;
  return { cls: Number(m[1]) as 2 | 4 | 5, subject, detail: Number(m[3]), text: KNOWN[code] ?? `${SUBJECTS[subject] ?? 'unknown subject'}: ${m[1] === '5' ? 'permanent' : m[1] === '4' ? 'temporary' : 'success'} failure` };
}

/** The enhanced code that a plain three-digit SMTP reply stands for when the server gave none (RFC 5321 section 4.2). */
export function statusFromReply(code: number): string | undefined {
  const table: Readonly<Record<number, string>> = { 421: '4.4.2', 450: '4.2.0', 451: '4.3.0', 452: '4.2.2', 550: '5.1.1', 551: '5.1.6', 552: '5.2.2', 553: '5.1.3', 554: '5.0.0', 250: '2.0.0' };
  return table[code];
}

// ---------------------------------------------------------------- delivery status

export interface RecipientReport {
  readonly address: string;
  readonly action: string;
  readonly status?: Status;
  readonly diagnostic?: string;
  readonly class: BounceClass;
  readonly reason: string;
}

const ADDRESS = /^[^\s<>()[\]\\,;:"@\x00-\x1f]+@[^\s<>()[\]\\,;:"@\x00-\x1f]+$/;

function recipientAddress(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^\s*[a-zA-Z0-9-]+\s*;\s*(.+)$/.exec(v);
  const a = (m ? m[1]! : v).trim().replace(/^<|>$/g, '').toLowerCase();
  return ADDRESS.test(a) ? a : undefined;
}

const HARD_WORDS = /(user unknown|unknown user|no such user|does(?: not|n't) exist|invalid recipient|recipient rejected|mailbox unavailable|account (?:has been )?(?:disabled|closed)|address rejected)/i;
const FULL_WORDS = /(mailbox full|over quota|quota exceeded|insufficient storage|mailbox is full)/i;

/** Decides the class of one recipient from its action, status and what the remote server said. */
export function classifyRecipient(action: string, status: Status | undefined, diagnostic: string | undefined): { class: BounceClass; reason: string } {
  const a = action.toLowerCase();
  if (a === 'delivered' || a === 'relayed' || a === 'expanded') return { class: 'delivered', reason: `reported ${a}` };
  if (a === 'delayed') return { class: 'soft', reason: 'delivery is delayed and the server is still trying' };
  const diag = diagnostic ?? '';
  if (FULL_WORDS.test(diag) || (status && (status.cls === 5 || status.cls === 4) && status.subject === 2 && status.detail === 2)) return { class: 'soft', reason: 'the mailbox is full' };
  if (status && status.cls === 5 && status.subject === 3 && status.detail === 4) return { class: 'soft', reason: 'the message was too big; the address is fine' };
  if (status && status.cls === 5 && status.subject === 7) return { class: 'soft', reason: 'blocked by the remote server policy; the address may be fine' };
  if (status && status.cls === 5 && status.subject === 4) return { class: 'soft', reason: 'a routing problem' };
  if (status && status.cls === 4) return { class: 'soft', reason: status.text };
  if (status && status.cls === 5) return { class: 'hard', reason: status.text };
  if (HARD_WORDS.test(diag)) return { class: 'hard', reason: 'the remote server said the recipient is unknown' };
  if (a === 'failed') return { class: 'hard', reason: 'delivery failed with no further detail' };
  return { class: 'unknown', reason: 'no usable action or status' };
}

function fieldGroups(text: string): Map<string, string>[] {
  return text.split(/\r?\n[ \t]*\r?\n/).map((g) => parseHeaders(g)).filter((m) => m.size > 0);
}

function diagnosticStatus(d: string | undefined): Status | undefined {
  if (!d) return undefined;
  const m = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(d);
  if (m) return parseStatus(m[1]!);
  const r = /^(?:smtp\s*;\s*)?([245]\d\d)\b/i.exec(d.trim());
  const e = r ? statusFromReply(Number(r[1])) : undefined;
  if (e) return parseStatus(e);
  if (r) return parseStatus(`${r[1]![0]}.0.0`);
  return undefined;
}

export function parseDeliveryStatus(text: string): RecipientReport[] {
  const groups = fieldGroups(text);
  const out: RecipientReport[] = [];
  for (const g of groups.slice(1)) {
    const address = recipientAddress(g.get('final-recipient') ?? g.get('original-recipient'));
    if (!address) continue;
    const action = (g.get('action') ?? '').split(/\s/)[0]!.toLowerCase();
    const diagnostic = g.get('diagnostic-code')?.replace(/^[a-z]+\s*;\s*/i, '');
    const sv = g.get('status');
    let status: Status | undefined;
    try {
      status = sv ? parseStatus(sv.split(/\s/)[0]!) : diagnosticStatus(diagnostic);
    } catch {
      status = diagnosticStatus(diagnostic);
    }
    const c = classifyRecipient(action, status, diagnostic);
    out.push({ address, action, ...(status ? { status } : {}), ...(diagnostic ? { diagnostic: diagnostic.slice(0, 500) } : {}), ...c });
  }
  return out;
}

// ---------------------------------------------------------------- complaints and auto-replies

export interface Complaint {
  readonly feedbackType: string;
  readonly address?: string;
  readonly userAgent?: string;
  readonly sourceIp?: string;
}

export function parseFeedbackReport(text: string, original?: Part): Complaint {
  const g = fieldGroups(text)[0];
  if (!g) throw new NotAReport('the feedback report has no fields');
  const ft = g.get('feedback-type');
  if (!ft) throw new NotAReport('the feedback report has no Feedback-Type');
  const direct = recipientAddress(g.get('original-rcpt-to'));
  const fromOriginal = original ? recipientAddress(/<?([^<>\s,]+@[^<>\s,]+)>?/.exec(original.headers.get('to') ?? '')?.[1]) : undefined;
  const address = direct ?? fromOriginal;
  return { feedbackType: ft.toLowerCase(), ...(address ? { address } : {}), ...(g.get('user-agent') ? { userAgent: g.get('user-agent')! } : {}), ...(g.get('source-ip') ? { sourceIp: g.get('source-ip')! } : {}) };
}

/** Whether headers mark a message as machine-made and not a person's reply (RFC 3834 and the common extensions). */
export function isAutoReply(h: ReadonlyMap<string, string>): boolean {
  const auto = h.get('auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return true;
  if (h.has('x-autoreply') || h.has('x-autorespond')) return true;
  if (/^(auto_reply|auto-reply|bulk|junk)$/i.test((h.get('precedence') ?? '').trim()) && /auto/i.test(h.get('precedence') ?? '')) return true;
  if (/\b(?:out of office|automatic reply|auto(?:matic)?[- ]?reply|autoreply|vacation)\b/i.test(h.get('subject') ?? '')) return true;
  return false;
}

export type Classification =
  | { readonly kind: 'bounce'; readonly reportingMta?: string; readonly recipients: readonly RecipientReport[] }
  | { readonly kind: 'complaint'; readonly complaint: Complaint; readonly address?: string }
  | { readonly kind: 'auto-reply'; readonly why: string }
  | { readonly kind: 'other' };

/** Classifies one received message. */
export function classifyMessage(raw: string): Classification {
  const root = parseMime(raw);
  const ct = params(root.headers.get('content-type'));
  if (ct.value === 'multipart/report') {
    const rt = (ct.params['report-type'] ?? '').toLowerCase();
    if (rt === 'feedback-report') {
      const fb = find(root, (p) => typeOf(p) === 'message/feedback-report');
      if (!fb) throw new NotAReport('a feedback report has no message/feedback-report part');
      const orig = find(root, (p) => typeOf(p) === 'message/rfc822' || typeOf(p) === 'text/rfc822-headers');
      const origPart = orig ? (orig.parts[0] ?? parseMime(orig.body)) : undefined;
      const c = parseFeedbackReport(fb.body, origPart);
      if (c.feedbackType === 'not-spam') return { kind: 'other' };
      return { kind: 'complaint', complaint: c, ...(c.address ? { address: c.address } : {}) };
    }
    if (rt === 'delivery-status') {
      const ds = find(root, (p) => typeOf(p) === 'message/delivery-status');
      if (!ds) throw new NotAReport('a delivery report has no message/delivery-status part');
      const recipients = parseDeliveryStatus(ds.body.length ? ds.body : ds.parts.map((p) => p.body).join('\n\n'));
      if (!recipients.length) throw new NotAReport('the delivery report names no recipient');
      const mta = fieldGroups(ds.body)[0]?.get('reporting-mta')?.replace(/^[a-z]+\s*;\s*/i, '');
      return { kind: 'bounce', ...(mta ? { reportingMta: mta } : {}), recipients };
    }
  }
  if (isAutoReply(root.headers)) return { kind: 'auto-reply', why: root.headers.get('auto-submitted') ? `Auto-Submitted: ${root.headers.get('auto-submitted')}` : 'automatic reply headers or subject' };
  return { kind: 'other' };
}

// ---------------------------------------------------------------- feeding suppression

export interface SuppressionTarget {
  bounce(address: string, kind: 'hard' | 'soft' | 'complaint'): void;
}

/** Soft bounces that repeat within a window become a hard bounce. */
export class SoftBounceTracker {
  private readonly seen = new Map<string, number[]>();
  private readonly o: { threshold: number; windowMs: number; now: () => number };
  constructor(o: { threshold: number; windowMs: number; now: () => number }) {
    this.o = o;
  }
  /** Records one soft bounce; true when the address has now reached the threshold. */
  record(address: string): boolean {
    const a = address.toLowerCase();
    const now = this.o.now();
    const list = (this.seen.get(a) ?? []).filter((t) => now - t < this.o.windowMs);
    list.push(now);
    this.seen.set(a, list);
    return list.length >= this.o.threshold;
  }
  clear(address: string): void {
    this.seen.delete(address.toLowerCase());
  }
}

/** Sends what a classification means to the suppression list; returns the addresses suppressed. */
export function feedSuppression(target: SuppressionTarget, c: Classification, tracker?: SoftBounceTracker): string[] {
  const out: string[] = [];
  if (c.kind === 'complaint' && c.address) {
    target.bounce(c.address, 'complaint');
    out.push(c.address);
  }
  if (c.kind === 'bounce') {
    for (const r of c.recipients) {
      if (r.class === 'hard') {
        target.bounce(r.address, 'hard');
        out.push(r.address);
      } else if (r.class === 'soft') {
        if (tracker?.record(r.address)) {
          target.bounce(r.address, 'hard');
          out.push(r.address);
        } else target.bounce(r.address, 'soft');
      } else if (r.class === 'delivered') tracker?.clear(r.address);
    }
  }
  return out;
}
