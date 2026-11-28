/**
 * E-signature envelopes: one or more documents sent to named people, in order, to fill in and sign. An envelope
 * is a draft until it is sent, then waits on its signers in routing order (people with the same order act in
 * parallel; viewers only receive copies), and ends in exactly one way: completed, declined by a signer, voided by
 * its sender, or expired. The lifecycle is a declared state machine of the workflow block, so no envelope can be
 * stranded. Fields are typed (signature, initials, date, text, checkbox, dropdown, name, email), belong to one
 * signer, sit on a page of a document at a place the placement helpers of the pdf-forms block understand, and are
 * checked on submission: a signer fills only their own fields, every required one, with values that fit (an option
 * from the list, text matching a pattern and a length, a typed signature that is not blank), after agreeing to use
 * electronic records and signatures. Signing links are signed, purpose-bound, expiring tokens (crypto block); an
 * optional access code is kept as a scrypt hash and locks after repeated wrong tries. Reminders follow a policy
 * (first after, then every, at most). Everything that happens is appended to a hash-chained trail; on completion
 * a certificate states the documents (by SHA-256), each signer's evidence (when viewed, consented and signed, from
 * which address and agent, how they were authenticated) and the trail's head, sealed with an HMAC so any change to
 * it is detected. `finalize` turns a document into its completed form with the pdf-forms block: fields placed,
 * values filled, flattened to page content.
 *
 * Time, randomness and the signing secret are arguments. Messages are returned for the caller to send; nothing is
 * sent from here. Out of scope: painting drawn signatures (the strokes are kept as evidence, typed signatures are
 * painted), cryptographic PDF signatures (the pdf-sign block can seal the finished file), and identity proofing
 * beyond the link and the optional access code.
 */
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { equal, sign as signToken, verify as verifyToken, BadToken } from '../crypto/index.ts';
import { addFields, fill, flatten, pageGeometry, placement } from '../pdf-forms/index.ts';
import type { NewField, PlacementSpec } from '../pdf-forms/index.ts';
import { pdf as makePdf } from '../pdf/index.ts';
import { Workflow, Refused } from '../workflow/index.ts';
import type { Instance } from '../workflow/index.ts';

export class EnvelopeError extends Error {
  readonly problems: readonly string[];
  constructor(why: string | readonly string[]) {
    const list = typeof why === 'string' ? [why] : why;
    super(list.join('; '));
    this.problems = list;
  }
}

export type State = 'draft' | 'sent' | 'completed' | 'declined' | 'voided' | 'expired';
export type FieldKind = 'signature' | 'initials' | 'date' | 'text' | 'checkbox' | 'dropdown' | 'name' | 'email';
export type SignerRole = 'signer' | 'approver' | 'viewer';
export type SignerStatus = 'pending' | 'notified' | 'viewed' | 'signed' | 'declined' | 'cancelled';

export interface Document {
  readonly id: string;
  readonly name: string;
  readonly sha256: string;
  readonly pages: number;
}

export interface Signer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: SignerRole;
  /** Routing order: lower goes first; equal orders act at the same time. */
  readonly order: number;
}

export interface FieldSpec {
  readonly id: string;
  readonly signer: string;
  readonly document: string;
  /** Zero-based page. */
  readonly page: number;
  readonly at: PlacementSpec;
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly label?: string;
  readonly options?: readonly string[];
  readonly maxLen?: number;
  /** A regular expression the whole text must match. */
  readonly pattern?: string;
}

export type Strokes = readonly (readonly (readonly [number, number])[])[];
export type SignatureInput = { readonly typed: string } | { readonly drawn: Strokes };
export type FieldInput = string | boolean | SignatureInput;

export interface Evidence {
  viewedAt?: string;
  viewIp?: string;
  viewAgent?: string;
  consentAt?: string;
  signedAt?: string;
  signIp?: string;
  signAgent?: string;
  auth?: 'link' | 'link+code';
}

export interface Context {
  readonly ip?: string;
  readonly agent?: string;
}

export interface Message {
  readonly kind: 'request' | 'reminder' | 'completed' | 'declined' | 'voided' | 'expired';
  readonly to: string;
  readonly subject: string;
  readonly link?: string;
}

export interface TrailEvent {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly detail: string;
  readonly prev: string;
  readonly hash: string;
}

export interface ReminderPolicy {
  readonly afterHours: number;
  readonly everyHours: number;
  readonly max: number;
}

export interface Deps {
  readonly now: () => number;
  /** Random identifiers: `ids(8)` returns 8 bytes of randomness as url-safe text. */
  readonly ids?: (bytes: number) => string;
  /** Key for signing links and sealing certificates. */
  readonly secret: string;
  readonly baseUrl: string;
}

const SIGNER_ROLES = ['signer', 'approver', 'viewer'] as const;
const KINDS = new Set<string>(['signature', 'initials', 'date', 'text', 'checkbox', 'dropdown', 'name', 'email']);
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOUR = 3_600_000;
const MAX_ATTEMPTS = 5;

const definition = {
  name: 'e-signature envelope',
  start: 'draft',
  final: ['completed', 'declined', 'voided', 'expired'],
  transitions: [
    { from: 'draft', to: 'sent', action: 'send', roles: ['sender'], guard: (r: Readonly<Record<string, unknown>>) => (r.sendProblems as string | undefined) || undefined },
    { from: 'draft', to: 'voided', action: 'void', roles: ['sender'] },
    { from: 'sent', to: 'completed', action: 'complete', roles: ['system'], guard: (r: Readonly<Record<string, unknown>>) => (r.incomplete as string | undefined) || undefined },
    { from: 'sent', to: 'declined', action: 'decline', roles: ['signer'] },
    { from: 'sent', to: 'voided', action: 'void', roles: ['sender'] },
    { from: 'sent', to: 'expired', action: 'expire', roles: ['system'], guard: (r: Readonly<Record<string, unknown>>) => (r.notExpired as string | undefined) || undefined },
  ],
} as const;

const canon = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

export interface Snapshot {
  readonly id: string;
  readonly subject: string;
  readonly sender: { readonly name: string; readonly email: string };
  readonly state: State;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly sentAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly documents: readonly Document[];
  readonly signers: readonly (Signer & { status: SignerStatus; evidence: Evidence; reminders: number; lastNotified: string | null })[];
  readonly fields: readonly (FieldSpec & { value?: unknown; filledBy?: string })[];
  readonly reminders: ReminderPolicy;
  readonly trail: readonly TrailEvent[];
}

interface SignerRec extends Signer {
  status: SignerStatus;
  evidence: Evidence;
  reminders: number;
  lastNotified: number | null;
  codeHash?: string;
  codeSalt?: string;
  failedCodes: number;
}

interface FieldRec extends FieldSpec {
  value?: unknown;
  filledBy?: string;
}

export class Envelope {
  readonly id: string;
  private readonly deps: Deps;
  private readonly wf: Workflow;
  private readonly inst: Instance;
  private subject: string;
  private readonly sender: { name: string; email: string };
  private readonly createdAt: number;
  private expiresAt: number | null = null;
  private sentAt: number | null = null;
  private endedAt: number | null = null;
  private endReason: string | null = null;
  private readonly docs: Document[] = [];
  private readonly signers: SignerRec[] = [];
  private readonly fields: FieldRec[] = [];
  private policy: ReminderPolicy = { afterHours: 24, everyHours: 48, max: 3 };
  private readonly events: TrailEvent[] = [];

  constructor(deps: Deps, o: { subject: string; sender: { name: string; email: string }; expiresInDays?: number }) {
    if (!deps.secret || deps.secret.length < 16) throw new EnvelopeError('the signing secret must be at least 16 characters');
    if (!o.subject.trim()) throw new EnvelopeError('an envelope needs a subject');
    if (!EMAIL.test(o.sender.email)) throw new EnvelopeError('the sender needs an email address');
    this.deps = deps;
    this.subject = o.subject.trim();
    this.sender = { name: o.sender.name, email: o.sender.email.toLowerCase() };
    this.createdAt = deps.now();
    this.id = (deps.ids ?? ((n) => randomBytes(n).toString('base64url')))(12);
    if (!ID.test(this.id)) throw new EnvelopeError('envelope ids are letters, digits, dashes and underscores');
    this.wf = new Workflow(definition as never, deps.now);
    this.inst = this.wf.start(this.id, this.sender.email);
    if (o.expiresInDays !== undefined) {
      if (!(o.expiresInDays > 0 && o.expiresInDays <= 365)) throw new EnvelopeError('expiry is from 1 to 365 days');
      this.expiresAt = this.createdAt + o.expiresInDays * 24 * HOUR;
    }
    this.log(this.sender.email, 'created', this.subject);
  }

  // ------------------------------------------------------------ state and trail

  get state(): State {
    return this.inst.state as State;
  }

  private log(actor: string, action: string, detail = ''): void {
    const prev = this.events.at(-1)?.hash ?? '0'.repeat(64);
    const e = { seq: this.events.length + 1, at: new Date(this.deps.now()).toISOString(), actor, action, detail, prev };
    this.events.push({ ...e, hash: sha256(`${prev}${canon(e)}`) });
  }

  /** Whether the trail is unbroken: every event's hash follows from the one before it. */
  static trailIntact(trail: readonly TrailEvent[]): boolean {
    let prev = '0'.repeat(64);
    for (const [i, ev] of trail.entries()) {
      const { hash, ...rest } = ev;
      if (ev.seq !== i + 1 || ev.prev !== prev || sha256(`${prev}${canon(rest)}`) !== hash) return false;
      prev = hash;
    }
    return true;
  }

  private editable(): void {
    if (this.state !== 'draft') throw new EnvelopeError(`the envelope is ${this.state}; only a draft can be changed`);
  }

  // ------------------------------------------------------------ building the draft

  addDocument(d: { id: string; name: string; bytes: Uint8Array; pages: number }): Document {
    this.editable();
    if (!ID.test(d.id) || this.docs.some((x) => x.id === d.id)) throw new EnvelopeError(`document id "${d.id}" is not valid or is already used`);
    if (!Number.isInteger(d.pages) || d.pages < 1) throw new EnvelopeError('a document has at least one page');
    if (!d.bytes.length) throw new EnvelopeError('the document is empty');
    const doc: Document = { id: d.id, name: d.name, sha256: sha256(d.bytes), pages: d.pages };
    this.docs.push(doc);
    this.log(this.sender.email, 'document added', `${doc.id} ${doc.name} ${doc.sha256}`);
    return doc;
  }

  addSigner(s: { id: string; name: string; email: string; role?: SignerRole; order?: number; accessCode?: string }): Signer {
    this.editable();
    const role = s.role ?? 'signer';
    const problems: string[] = [];
    if (!ID.test(s.id) || this.signers.some((x) => x.id === s.id)) problems.push(`signer id "${s.id}" is not valid or is already used`);
    if (!s.name.trim()) problems.push('a signer needs a name');
    if (!EMAIL.test(s.email)) problems.push(`"${s.email}" is not an email address`);
    else if (this.signers.some((x) => x.email === s.email.toLowerCase() && x.order === (s.order ?? 1))) problems.push(`${s.email} is already a recipient at this step`);
    if (!SIGNER_ROLES.includes(role)) problems.push(`role "${role}" is not signer, approver or viewer`);
    if (s.order !== undefined && (!Number.isInteger(s.order) || s.order < 1 || s.order > 100)) problems.push('order is a whole number from 1 to 100');
    if (s.accessCode !== undefined && s.accessCode.length < 4) problems.push('an access code has at least 4 characters');
    if (problems.length) throw new EnvelopeError(problems);
    const rec: SignerRec = { id: s.id, name: s.name.trim(), email: s.email.toLowerCase(), role, order: s.order ?? 1, status: 'pending', evidence: {}, reminders: 0, lastNotified: null, failedCodes: 0 };
    if (s.accessCode) {
      rec.codeSalt = randomBytes(16).toString('hex');
      rec.codeHash = scryptSync(s.accessCode, rec.codeSalt, 32).toString('hex');
    }
    this.signers.push(rec);
    this.log(this.sender.email, 'signer added', `${rec.id} ${rec.email} ${rec.role} step ${rec.order}${rec.codeHash ? ' with access code' : ''}`);
    return { id: rec.id, name: rec.name, email: rec.email, role: rec.role, order: rec.order };
  }

  addField(f: FieldSpec): void {
    this.editable();
    const problems: string[] = [];
    const signer = this.signers.find((s) => s.id === f.signer);
    if (!ID.test(f.id) || this.fields.some((x) => x.id === f.id)) problems.push(`field id "${f.id}" is not valid or is already used`);
    if (!signer) problems.push(`there is no signer "${f.signer}"`);
    else if (signer.role === 'viewer') problems.push('a viewer has no fields');
    const doc = this.docs.find((d) => d.id === f.document);
    if (!doc) problems.push(`there is no document "${f.document}"`);
    else if (!Number.isInteger(f.page) || f.page < 0 || f.page >= doc.pages) problems.push(`${doc.name} has ${doc.pages} page(s); there is no page ${f.page + 1}`);
    if (!KINDS.has(f.kind)) problems.push(`"${f.kind}" is not a field type`);
    if (f.kind === 'dropdown' && !(f.options && f.options.length >= 1 && new Set(f.options).size === f.options.length)) problems.push('a dropdown needs one or more different options');
    if (f.kind !== 'dropdown' && f.options) problems.push('only a dropdown has options');
    if (f.pattern !== undefined) {
      try {
        new RegExp(`^(?:${f.pattern})$`);
        if (f.pattern.length > 200 || /\([^)]*[+*][^)]*\)[+*{]/.test(f.pattern)) problems.push('that pattern could take very long to match; use a simpler one');
      } catch {
        problems.push('the pattern is not a valid regular expression');
      }
    }
    if (f.maxLen !== undefined && (!Number.isInteger(f.maxLen) || f.maxLen < 1 || f.maxLen > 10_000)) problems.push('maxLen is a whole number from 1 to 10000');
    const a = f.at;
    if (![a.x, a.y, a.width, a.height].every(Number.isFinite) || !(a.width > 0 && a.height > 0)) problems.push('the field needs a place with a size');
    else if (a.unit === 'fraction' && (a.x < 0 || a.y < 0 || a.x + a.width > 1 || a.y + a.height > 1)) problems.push('a place given as a fraction of the page must lie within it');
    if (problems.length) throw new EnvelopeError(problems);
    this.fields.push({ ...f });
    this.log(this.sender.email, 'field added', `${f.id} ${f.kind} for ${f.signer} on ${f.document} page ${f.page + 1}`);
  }

  setReminders(p: ReminderPolicy): void {
    this.editable();
    if (!(p.afterHours > 0 && p.everyHours > 0) || !Number.isInteger(p.max) || p.max < 0 || p.max > 20) throw new EnvelopeError('reminders: hours above zero and at most 0 to 20 of them');
    this.policy = { ...p };
  }

  // ------------------------------------------------------------ routing

  private signing(): SignerRec[] {
    return this.signers.filter((s) => s.role !== 'viewer');
  }

  private steps(): number[] {
    return [...new Set(this.signers.map((s) => s.order))].sort((a, b) => a - b);
  }

  private done(s: SignerRec): boolean {
    return s.role === 'viewer' || s.status === 'signed';
  }

  /** The step whose people are being waited on, or null when everyone who must act has. */
  private currentStep(): number | null {
    for (const o of this.steps()) if (this.signers.some((s) => s.order === o && !this.done(s))) return o;
    return null;
  }

  private link(s: SignerRec): string {
    const ttl = this.expiresAt ? Math.max(this.expiresAt - this.deps.now(), 60_000) : 30 * 24 * HOUR;
    return `${this.deps.baseUrl}/sign/${signToken(this.deps.secret, 'esign-access', { e: this.id, s: s.id }, ttl, this.deps.now())}`;
  }

  /** People at the current step who have not yet been told get their request. */
  private notifyCurrent(): Message[] {
    const o = this.currentStep();
    const out: Message[] = [];
    if (o === null) return out;
    for (const s of this.signers.filter((x) => x.order === o && x.role !== 'viewer' && x.status === 'pending')) {
      s.status = 'notified';
      s.lastNotified = this.deps.now();
      this.log('system', 'request sent', `${s.id} ${s.email}`);
      out.push({ kind: 'request', to: s.email, subject: `${this.sender.name} sent you "${this.subject}" to ${s.role === 'approver' ? 'approve' : 'sign'}`, link: this.link(s) });
    }
    return out;
  }

  private readyProblems(): string[] {
    const p: string[] = [];
    if (!this.docs.length) p.push('add at least one document');
    const acting = this.signing();
    if (!acting.length) p.push('add at least one signer or approver');
    for (const s of acting) {
      const mine = this.fields.filter((f) => f.signer === s.id);
      if (!mine.length) p.push(`${s.name} has no fields`);
      else if (s.role === 'signer' && !mine.some((f) => f.kind === 'signature' && f.required !== false)) p.push(`${s.name} has no required signature field`);
    }
    return p;
  }

  send(): Message[] {
    this.inst.data.sendProblems = this.readyProblems().join('; ');
    try {
      this.wf.act(this.inst, 'send', this.sender.email, ['sender']);
    } catch (e) {
      if (e instanceof Refused) throw new EnvelopeError(this.readyProblems().length ? this.readyProblems() : e.message);
      throw e;
    }
    this.sentAt = this.deps.now();
    this.log(this.sender.email, 'sent', `${this.signers.length} recipient(s), ${this.docs.length} document(s)`);
    return this.notifyCurrent();
  }

  // ------------------------------------------------------------ a signer's side

  private find(token: string): SignerRec {
    let d: Record<string, unknown>;
    try {
      d = verifyToken(this.deps.secret, 'esign-access', token, this.deps.now());
    } catch (e) {
      throw new EnvelopeError(e instanceof BadToken ? `that link is not valid: ${e.message}` : 'that link is not valid');
    }
    if (d.e !== this.id) throw new EnvelopeError('that link is for a different envelope');
    const s = this.signers.find((x) => x.id === d.s);
    if (!s) throw new EnvelopeError('that link is for someone who is not on this envelope');
    return s;
  }

  private checkCode(s: SignerRec, code: string | undefined): 'link' | 'link+code' {
    if (!s.codeHash) return 'link';
    if (s.failedCodes >= MAX_ATTEMPTS) throw new EnvelopeError('too many wrong access codes; ask the sender for a new link');
    const ok = code !== undefined && equal(scryptSync(code, s.codeSalt!, 32).toString('hex'), s.codeHash);
    if (!ok) {
      s.failedCodes++;
      this.log('system', 'wrong access code', s.id);
      throw new EnvelopeError(code === undefined ? 'this envelope needs its access code' : 'that access code is not right');
    }
    s.failedCodes = 0;
    return 'link+code';
  }

  /** What a person sees when they follow their link; the first time is recorded as the signer having viewed it. */
  open(token: string, ctx: Context & { code?: string } = {}): { signer: Signer; state: State; canSign: boolean; waitingFor: string[]; fields: FieldSpec[]; documents: Document[]; note?: string } {
    const s = this.find(token);
    const auth = this.checkCode(s, ctx.code);
    const waiting = this.waitingFor(s);
    if (this.state === 'sent' && s.role !== 'viewer' && s.status !== 'signed' && !s.evidence.viewedAt) {
      s.evidence.viewedAt = new Date(this.deps.now()).toISOString();
      if (ctx.ip) s.evidence.viewIp = ctx.ip;
      if (ctx.agent) s.evidence.viewAgent = ctx.agent.slice(0, 300);
      s.evidence.auth = auth;
      if (s.status === 'notified') s.status = 'viewed';
      this.log(s.email, 'viewed', ctx.ip ?? '');
    }
    const canSign = this.state === 'sent' && s.role !== 'viewer' && s.status !== 'signed' && s.status !== 'declined' && !waiting.length;
    const note = this.state !== 'sent' ? `this envelope is ${this.state}` : waiting.length ? `waiting for ${waiting.join(', ')}` : s.status === 'signed' ? 'you have already signed' : undefined;
    return { signer: { id: s.id, name: s.name, email: s.email, role: s.role, order: s.order }, state: this.state, canSign, waitingFor: waiting, fields: this.fields.filter((f) => f.signer === s.id), documents: [...this.docs], ...(note ? { note } : {}) };
  }

  private waitingFor(s: SignerRec): string[] {
    return this.signers.filter((x) => x.order < s.order && !this.done(x)).map((x) => x.name);
  }

  /** The signer completes their fields. Returns the messages that follow (the next step's requests, or the completion copies). */
  sign(token: string, o: { values: Readonly<Record<string, FieldInput>>; consent: boolean; code?: string } & Context): Message[] {
    const s = this.find(token);
    if (this.state !== 'sent') throw new EnvelopeError(`the envelope is ${this.state}; it can no longer be signed`);
    if (s.role === 'viewer') throw new EnvelopeError('a viewer has nothing to sign');
    if (s.status === 'signed') throw new EnvelopeError('you have already signed this envelope');
    const waiting = this.waitingFor(s);
    if (waiting.length) throw new EnvelopeError(`it is not your turn: waiting for ${waiting.join(', ')}`);
    const auth = this.checkCode(s, o.code);
    if (o.consent !== true) throw new EnvelopeError('you must agree to use electronic records and signatures before signing');
    const mine = this.fields.filter((f) => f.signer === s.id);
    const problems: string[] = [];
    for (const k of Object.keys(o.values)) if (!mine.some((f) => f.id === k)) problems.push(`${k}: that is not one of your fields`);
    const now = new Date(this.deps.now());
    const result = new Map<string, unknown>();
    for (const f of mine) {
      const given = Object.hasOwn(o.values, f.id) ? o.values[f.id] : undefined;
      const r = this.check(f, given, s, now);
      if (r.error) problems.push(`${f.label ?? f.id}: ${r.error}`);
      else if (r.value !== undefined) result.set(f.id, r.value);
    }
    if (problems.length) throw new EnvelopeError(problems);
    for (const [id, v] of result) {
      const f = this.fields.find((x) => x.id === id)!;
      f.value = v;
      f.filledBy = s.id;
    }
    const at = now.toISOString();
    s.status = 'signed';
    s.evidence = { ...s.evidence, consentAt: at, signedAt: at, auth, ...(o.ip ? { signIp: o.ip } : {}), ...(o.agent ? { signAgent: o.agent.slice(0, 300) } : {}), ...(s.evidence.viewedAt ? {} : { viewedAt: at }) };
    this.log(s.email, s.role === 'approver' ? 'approved' : 'signed', `${result.size} field(s)${o.ip ? ` from ${o.ip}` : ''}`);
    return this.afterAction();
  }

  private check(f: FieldRec, given: FieldInput | undefined, s: SignerRec, now: Date): { value?: unknown; error?: string } {
    const required = f.required !== false;
    const empty = given === undefined || given === '' || given === false || (typeof given === 'object' && given !== null && 'typed' in given && given.typed.trim() === '');
    switch (f.kind) {
      case 'date':
        return { value: now.toISOString().slice(0, 10) };
      case 'name':
        return { value: s.name };
      case 'email':
        return { value: s.email };
      case 'checkbox':
        if (given !== undefined && typeof given !== 'boolean') return { error: 'a check box is true or false' };
        if (required && given !== true) return { error: 'this box must be checked' };
        return { value: given === true };
      case 'dropdown':
        if (empty) return required ? { error: 'choose an option' } : {};
        return typeof given === 'string' && f.options!.includes(given) ? { value: given } : { error: `choose one of: ${f.options!.join(', ')}` };
      case 'text': {
        if (empty) return required ? { error: 'this is required' } : {};
        if (typeof given !== 'string') return { error: 'text is expected' };
        const text = given.normalize('NFC');
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { error: 'contains control characters' };
        if (f.maxLen !== undefined && [...text].length > f.maxLen) return { error: `at most ${f.maxLen} characters` };
        if (f.pattern !== undefined && !new RegExp(`^(?:${f.pattern})$`).test(text)) return { error: 'is not in the expected form' };
        return { value: text };
      }
      default: {
        // signature and initials
        if (empty) return required ? { error: `${f.kind} is required` } : {};
        if (typeof given !== 'object' || given === null) return { error: `${f.kind} is typed or drawn` };
        if ('typed' in given) {
          const t = given.typed.normalize('NFC').trim();
          if (t.length > (f.kind === 'initials' ? 8 : 100) || /[\u0000-\u001f\u007f]/.test(t)) return { error: `the typed ${f.kind} is too long or has control characters` };
          return { value: { typed: t } };
        }
        const strokes: unknown = given.drawn;
        const valid = (st: unknown): st is [number, number][] => Array.isArray(st) && st.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1));
        const list = Array.isArray(strokes) ? (strokes as unknown[]) : [];
        const points = list.reduce<number>((n, st) => n + (Array.isArray(st) ? st.length : 0), 0);
        if (list.length === 0 || list.length > 200 || points < 2 || points > 20_000 || !list.every(valid)) return { error: 'the drawn signature is empty or not valid (points are between 0 and 1)' };
        return { value: { drawn: (list as [number, number][][]).map((st) => st.map((p) => [p[0], p[1]])) } };
      }
    }
  }

  private afterAction(): Message[] {
    const out: Message[] = [];
    if (this.currentStep() === null) {
      this.inst.data.incomplete = this.incomplete() ?? '';
      this.wf.act(this.inst, 'complete', 'system', ['system']);
      this.endedAt = this.deps.now();
      this.endReason = 'every signer finished';
      this.log('system', 'completed', 'all fields filled');
      for (const s of this.signers) out.push({ kind: 'completed', to: s.email, subject: `Completed: ${this.subject}` });
      out.push({ kind: 'completed', to: this.sender.email, subject: `Completed: ${this.subject}` });
      return out;
    }
    return this.notifyCurrent();
  }

  private incomplete(): string | undefined {
    const missing = this.fields.filter((f) => f.required !== false && (f.kind === 'checkbox' ? f.value !== true : f.value === undefined));
    const unsigned = this.signing().filter((s) => s.status !== 'signed');
    return missing.length || unsigned.length ? `${unsigned.length} signer(s) have not signed and ${missing.length} required field(s) are empty` : undefined;
  }

  /** A signer declines, with a reason. The envelope ends; everyone still waiting is released from it. */
  decline(token: string, reason: string, ctx: Context = {}): Message[] {
    const s = this.find(token);
    if (this.state !== 'sent') throw new EnvelopeError(`the envelope is ${this.state}`);
    if (s.role === 'viewer' || s.status === 'signed') throw new EnvelopeError('you cannot decline now');
    if (this.waitingFor(s).length) throw new EnvelopeError('it is not your turn');
    if (!reason.trim()) throw new EnvelopeError('say why you are declining');
    this.wf.act(this.inst, 'decline', s.email, ['signer']);
    s.status = 'declined';
    this.finish(`declined by ${s.name}: ${reason.trim()}`, s.email, 'declined', ctx.ip);
    return [{ kind: 'declined', to: this.sender.email, subject: `${s.name} declined "${this.subject}": ${reason.trim()}` }, ...this.releaseMessages('declined')];
  }

  /** The sender withdraws the envelope, with a reason. */
  void(reason: string): Message[] {
    if (!reason.trim()) throw new EnvelopeError('say why it is being voided');
    const wasSent = this.state === 'sent';
    try {
      this.wf.act(this.inst, 'void', this.sender.email, ['sender']);
    } catch (e) {
      throw new EnvelopeError(e instanceof Refused ? `the envelope is ${this.state}; it cannot be voided` : String(e));
    }
    this.finish(`voided: ${reason.trim()}`, this.sender.email, 'voided');
    return wasSent ? this.releaseMessages('voided') : [];
  }

  /** People who had been asked to act and are now released, told so; people never asked are not troubled. */
  private releaseMessages(kind: 'declined' | 'voided' | 'expired'): Message[] {
    return this.released.map((s) => ({ kind, to: s.email, subject: `"${this.subject}" is no longer waiting for you (${kind})` }));
  }

  private released: SignerRec[] = [];

  private finish(reason: string, actor: string, action: string, ip?: string): void {
    this.endedAt = this.deps.now();
    this.endReason = reason;
    this.released = this.signers.filter((s) => s.lastNotified !== null && (s.status === 'notified' || s.status === 'viewed'));
    for (const s of this.signers) if (s.status === 'pending' || s.status === 'notified' || s.status === 'viewed') s.status = 'cancelled';
    this.log(actor, action, `${reason}${ip ? ` from ${ip}` : ''}`);
  }

  // ------------------------------------------------------------ time

  /** Expires an envelope past its date and says who is due a reminder. Call it from a schedule. */
  tick(): Message[] {
    if (this.state !== 'sent') return [];
    const now = this.deps.now();
    if (this.expiresAt !== null && now >= this.expiresAt) {
      this.inst.data.notExpired = '';
      this.wf.act(this.inst, 'expire', 'system', ['system']);
      this.finish('it was not completed in time', 'system', 'expired');
      return [{ kind: 'expired', to: this.sender.email, subject: `"${this.subject}" expired before it was completed` }, ...this.releaseMessages('expired')];
    }
    const out: Message[] = [];
    const o = this.currentStep();
    for (const s of this.signers.filter((x) => x.order === o && x.role !== 'viewer' && x.status !== 'signed')) {
      if (s.reminders >= this.policy.max || s.lastNotified === null) continue;
      const wait = (s.reminders === 0 ? this.policy.afterHours : this.policy.everyHours) * HOUR;
      if (now - s.lastNotified < wait) continue;
      s.reminders++;
      s.lastNotified = now;
      this.log('system', 'reminder', `${s.id} ${s.reminders} of ${this.policy.max}`);
      out.push({ kind: 'reminder', to: s.email, subject: `Reminder: "${this.subject}" is waiting for you`, link: this.link(s) });
    }
    return out;
  }

  // ------------------------------------------------------------ the record

  snapshot(): Snapshot {
    const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
    return {
      id: this.id, subject: this.subject, sender: { ...this.sender }, state: this.state, createdAt: iso(this.createdAt)!, expiresAt: iso(this.expiresAt), sentAt: iso(this.sentAt), endedAt: iso(this.endedAt), endReason: this.endReason,
      documents: this.docs.map((d) => ({ ...d })),
      signers: this.signers.map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role, order: s.order, status: s.status, evidence: { ...s.evidence }, reminders: s.reminders, lastNotified: iso(s.lastNotified) })),
      fields: this.fields.map((f) => ({ ...f })),
      reminders: { ...this.policy },
      trail: this.events.map((e) => ({ ...e })),
    };
  }

  /** The completion certificate: what was signed, by whom, with what evidence, sealed. Only a completed envelope has one. */
  certificate(): Certificate {
    if (this.state !== 'completed') throw new EnvelopeError(`the envelope is ${this.state}; only a completed envelope has a certificate`);
    const snap = this.snapshot();
    const body = {
      envelope: snap.id, subject: snap.subject, sender: snap.sender, completedAt: snap.endedAt!,
      documents: snap.documents.map((d) => ({ id: d.id, name: d.name, sha256: d.sha256, pages: d.pages })),
      signers: snap.signers.filter((s) => s.role !== 'viewer').map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role, order: s.order, evidence: s.evidence })),
      copiesTo: snap.signers.filter((s) => s.role === 'viewer').map((s) => s.email),
      trailHead: snap.trail.at(-1)!.hash,
      events: snap.trail.length,
    };
    const certificateHash = sha256(canon(body));
    return { ...body, certificateHash, seal: createHmac('sha256', this.deps.secret).update(certificateHash).digest('hex') };
  }

  /** The completed form of a document: fields placed at their places, filled with what was submitted, flattened to page content. */
  finalize(documentId: string, bytes: Uint8Array): Uint8Array {
    if (this.state !== 'completed') throw new EnvelopeError(`the envelope is ${this.state}; documents are finalized when it is completed`);
    const doc = this.docs.find((d) => d.id === documentId);
    if (!doc) throw new EnvelopeError(`there is no document "${documentId}"`);
    if (sha256(bytes) !== doc.sha256) throw new EnvelopeError('these bytes are not the document that was sent (the digest differs)');
    const mine = this.fields.filter((f) => f.document === documentId);
    const specs: NewField[] = mine.map((f) => ({ name: `f_${f.id}`, type: f.kind === 'checkbox' ? 'checkbox' : 'text', page: f.page, at: f.at, ...(f.label ? { tooltip: f.label } : {}) }));
    const values: Record<string, string | boolean> = {};
    for (const f of mine) {
      const v = f.value;
      if (v === undefined) continue;
      if (typeof v === 'boolean') values[`f_${f.id}`] = v;
      else if (typeof v === 'string') values[`f_${f.id}`] = v;
      else if (typeof v === 'object' && v !== null && 'typed' in v) values[`f_${f.id}`] = String((v as { typed: string }).typed);
    }
    const placed = addFields(bytes, specs);
    return flatten(fill(placed, values).pdf).pdf;
  }

  /** A short certificate page set as a PDF, for people who want it on paper. */
  certificatePdf(): Uint8Array {
    const c = this.certificate();
    const rows = [['Signer', 'Role', 'Viewed', 'Signed', 'From']].concat(c.signers.map((s) => [`${s.name} <${s.email}>`, s.role, s.evidence.viewedAt ?? '', s.evidence.signedAt ?? '', s.evidence.signIp ?? '']));
    return makePdf(
      [
        { h: 'Certificate of completion' },
        { p: `${c.subject}` },
        { p: `Envelope ${c.envelope}. Completed ${c.completedAt}. Sent by ${c.sender.name} <${c.sender.email}>.` },
        { h: 'Documents' },
        { table: [['Document', 'SHA-256']].concat(c.documents.map((d) => [d.name, d.sha256])), widths: [1, 2] },
        { h: 'Signers' },
        { table: rows, widths: [3, 1, 2, 2, 1] },
        { h: 'Integrity' },
        { p: `Event trail of ${c.events} events ends at ${c.trailHead}.` },
        { p: `Certificate ${c.certificateHash}. Seal ${c.seal}.` },
      ],
      { title: `Certificate of completion: ${c.subject}`, size: 'Letter' },
    );
  }

  /** Checks a certificate against this envelope's secret. */
  verifyCertificate(c: Certificate): boolean {
    const { certificateHash, seal, ...body } = c;
    return sha256(canon(body)) === certificateHash && equal(createHmac('sha256', this.deps.secret).update(certificateHash).digest('hex'), seal);
  }

  /** The place of a field as PDF coordinates, for a given page of the document it is on. */
  fieldRect(fieldId: string, bytes: Uint8Array): readonly [number, number, number, number] {
    const f = this.fields.find((x) => x.id === fieldId);
    if (!f) throw new EnvelopeError(`there is no field "${fieldId}"`);
    return placementFor(bytes, f);
  }
}

function placementFor(bytes: Uint8Array, f: FieldSpec): readonly [number, number, number, number] {
  return placement(pageGeometry(bytes, f.page), f.at);
}

export interface Certificate {
  readonly envelope: string;
  readonly subject: string;
  readonly sender: { readonly name: string; readonly email: string };
  readonly completedAt: string;
  readonly documents: readonly { id: string; name: string; sha256: string; pages: number }[];
  readonly signers: readonly { id: string; name: string; email: string; role: SignerRole; order: number; evidence: Evidence }[];
  readonly copiesTo: readonly string[];
  readonly trailHead: string;
  readonly events: number;
  readonly certificateHash: string;
  readonly seal: string;
}
