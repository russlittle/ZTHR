import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { contentHash } from '@zthr/gates';

/**
 * Approval tokens (PRD principle P9: the student sends). Any action toward an
 * outside party needs a single-use token bound to the exact content, recipient
 * and student. A token cannot be reused, transferred to other content, or forged.
 */
export interface OutboundAction {
  studentId: string;
  kind: 'email' | 'sms' | 'application' | 'booking' | 'share' | 'purchase';
  recipient: string;
  content: unknown;
}

export interface ApprovalToken {
  id: string;
  studentId: string;
  actionHash: string;
  expiresAt: string;
  signature: string;
}

export class ApprovalService {
  private readonly used = new Set<string>();

  constructor(private readonly secret: Buffer, private readonly ttlMs = 30 * 60 * 1000) {
    if (secret.length < 32) throw new Error('approval secret must be at least 32 bytes');
  }

  static actionHash(a: OutboundAction): string {
    return contentHash({ s: a.studentId, k: a.kind, r: a.recipient, c: a.content });
  }

  private sign(id: string, studentId: string, actionHash: string, expiresAt: string): string {
    return createHmac('sha256', this.secret).update(`${id}|${studentId}|${actionHash}|${expiresAt}`).digest('hex');
  }

  /** Issued only when the student taps approve on the exact action shown to them. */
  issue(action: OutboundAction, now = Date.now()): ApprovalToken {
    const id = randomBytes(16).toString('hex');
    const actionHash = ApprovalService.actionHash(action);
    const expiresAt = new Date(now + this.ttlMs).toISOString();
    return { id, studentId: action.studentId, actionHash, expiresAt, signature: this.sign(id, action.studentId, actionHash, expiresAt) };
  }

  /** Verify and consume. Returns a reason when refused. */
  consume(token: ApprovalToken | undefined, action: OutboundAction, now = Date.now()): { ok: true } | { ok: false; reason: string } {
    if (!token) return { ok: false, reason: 'no approval token' };
    const expected = this.sign(token.id, token.studentId, token.actionHash, token.expiresAt);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(token.signature, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature invalid' };
    if (token.studentId !== action.studentId) return { ok: false, reason: 'token belongs to another student' };
    if (token.actionHash !== ApprovalService.actionHash(action)) return { ok: false, reason: 'token does not match this content and recipient' };
    if (new Date(token.expiresAt).getTime() < now) return { ok: false, reason: 'token expired' };
    if (this.used.has(token.id)) return { ok: false, reason: 'token already used' };
    this.used.add(token.id);
    return { ok: true };
  }
}

/** The only way to reach an outbound connector. */
export class OutboundGate {
  constructor(private readonly approvals: ApprovalService, private readonly send: (a: OutboundAction) => Promise<void>) {}

  async dispatch(action: OutboundAction, token: ApprovalToken | undefined): Promise<{ sent: boolean; reason?: string }> {
    const r = this.approvals.consume(token, action);
    if (!r.ok) return { sent: false, reason: r.reason };
    await this.send(action);
    return { sent: true };
  }
}
