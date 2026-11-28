/**
 * Meeting rooms for calls: who may be in one, what each role may do to whom, and what has been agreed about
 * recording. Join tokens are signed JWTs (HS256, from the webrtc-signaling block, so the same token also opens the
 * signalling socket) naming the room, the person, their role and a single-use id. Roles are host, moderator,
 * participant and guest, each able to act only on those below them: moderators can admit, mute and remove
 * participants and guests but not other moderators or the host; only the host can change roles, lock or end the
 * room. A lobby holds people until a moderator admits them (everyone, guests only, or nobody waits); waiting has a
 * time limit. A moderator's mute is hard: the person cannot unmute themselves, but may ask, and a moderator can
 * allow it. Recording needs everyone's say-so: starting it asks every person present; a person who consents is
 * included, one who declines is left out of the recording plan (or must leave, if the room says recording is
 * required), someone who has not answered is never recorded, and people who join later are asked before their media
 * is included. The recording plan is the list of whose audio and video may be captured and why. Every change appends
 * an event so the room can announce it to everyone, and nothing here touches media.
 *
 * Out of scope: carrying media, the recorder itself, and persistence across restarts.
 */
import { signJwt, verifyJwt } from '../webrtc-signaling/index.ts';

export type Role = 'host' | 'moderator' | 'participant' | 'guest';
const RANK: Record<Role, number> = { guest: 0, participant: 1, moderator: 2, host: 3 };

export class NotAllowed extends Error {}
export class NotFound extends Error {}
export class RoomClosed extends Error {}

export interface RoomConfig {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  /** Who waits in the lobby: everyone but the host and moderators, only guests, or nobody. */
  readonly lobby?: 'everyone' | 'guests' | 'off';
  readonly maxParticipants?: number;
  readonly allowGuests?: boolean;
  readonly startMuted?: boolean;
  /** off: no recording; consent: each person decides for themselves; required: a person who declines must leave. */
  readonly recording?: 'off' | 'consent' | 'required';
  readonly lobbyTimeoutMs?: number;
}

export interface RoomEvent { readonly at: number; readonly type: string; readonly by?: string; readonly who?: string; readonly detail?: Readonly<Record<string, unknown>> }

export type Consent = 'pending' | 'consented' | 'declined';

export interface Member {
  readonly user: string;
  readonly name: string;
  role: Role;
  status: 'lobby' | 'present' | 'left' | 'removed';
  audioMuted: boolean;
  videoMuted: boolean;
  /** Muted by a moderator: cannot unmute without being allowed. */
  hardMuted: boolean;
  unmuteRequested: boolean;
  handRaised: boolean;
  consent: Consent;
  readonly requestedAt: number;
  joinedAt?: number;
}

export interface PlanLine { readonly user: string; readonly include: boolean; readonly reason: string }
export interface RecordingPlan {
  readonly state: 'off' | 'asking' | 'recording';
  readonly startedBy?: string;
  readonly lines: readonly PlanLine[];
}

export interface TokenInput { readonly room: string; readonly user: string; readonly name: string; readonly role: Role; readonly ttlSeconds: number; readonly now: number; readonly notBefore?: number }

/** A signed join token. The role is whatever the issuer gave; the room trusts it only because of the signature. */
export function joinToken(secret: string, t: TokenInput): string {
  if (!['host', 'moderator', 'participant', 'guest'].includes(t.role)) throw new NotAllowed(`unknown role ${t.role}`);
  if (!(t.ttlSeconds > 0) || t.ttlSeconds > 86_400) throw new NotAllowed('a join token may last 1 to 86400 seconds');
  const s = Math.floor(t.now / 1000);
  return signJwt(secret, { room: t.room, sub: t.user, name: t.name, role: t.role, jti: `${t.room}.${t.user}.${s}.${Math.random().toString(36).slice(2, 10)}`, nbf: Math.floor((t.notBefore ?? t.now) / 1000), exp: s + Math.floor(t.ttlSeconds) });
}

export class Room {
  readonly config: Required<Omit<RoomConfig, 'lobbyTimeoutMs'>> & { readonly lobbyTimeoutMs: number };
  readonly #members = new Map<string, Member>();
  readonly #banned = new Set<string>();
  readonly #events: RoomEvent[] = [];
  readonly #usedTokens = new Set<string>();
  readonly #secrets: readonly string[];
  readonly #now: () => number;
  #locked = false;
  #ended = false;
  #recording: { state: 'off' | 'asking' | 'recording'; by?: string } = { state: 'off' };

  constructor(config: RoomConfig, o: { secrets: readonly string[]; now: () => number }) {
    if (!/^[\w.-]{1,128}$/.test(config.id)) throw new NotAllowed('room ids may hold letters, digits, . _ - only');
    this.config = { lobby: 'guests', maxParticipants: 50, allowGuests: true, startMuted: false, recording: 'consent', lobbyTimeoutMs: 600_000, ...config };
    this.#secrets = o.secrets;
    this.#now = o.now;
  }

  get events(): readonly RoomEvent[] { return this.#events; }
  get locked(): boolean { return this.#locked; }
  get ended(): boolean { return this.#ended; }

  #log(type: string, by?: string, who?: string, detail?: Record<string, unknown>) {
    this.#events.push({ at: this.#now(), type, ...(by ? { by } : {}), ...(who ? { who } : {}), ...(detail ? { detail } : {}) });
  }

  member(user: string): Member {
    const m = this.#members.get(user);
    if (!m) throw new NotFound(`${user} is not in this room`);
    return m;
  }

  /** People present, host first then by role, then by when they joined. */
  present(): Member[] {
    return [...this.#members.values()].filter((m) => m.status === 'present').sort((a, b) => RANK[b.role] - RANK[a.role] || (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
  }

  lobby(): Member[] {
    return [...this.#members.values()].filter((m) => m.status === 'lobby').sort((a, b) => a.requestedAt - b.requestedAt);
  }

  #actor(by: string, min: Role): Member {
    const a = this.member(by);
    if (a.status !== 'present') throw new NotAllowed(`${by} is not in the room`);
    if (RANK[a.role] < RANK[min]) throw new NotAllowed(`${by} is a ${a.role}; this needs a ${min} or higher`);
    return a;
  }

  #open() { if (this.#ended) throw new RoomClosed('the meeting has ended'); }

  /** Use a join token. Returns where the person ended up. */
  join(token: string): { user: string; status: 'present' | 'lobby'; role: Role } {
    this.#open();
    const now = this.#now();
    const c = verifyJwt(this.#secrets, token, { now });
    if (c.room !== this.config.id) throw new NotAllowed('this token is for a different room');
    const user = String(c.sub ?? ''), role = c.role as Role;
    if (!user || !(role in RANK)) throw new NotAllowed('the token has no person or role');
    const jti = String(c.jti ?? '');
    if (!jti) throw new NotAllowed('the token has no id');
    if (this.#usedTokens.has(jti)) throw new NotAllowed('this token has already been used');
    if (this.#banned.has(user)) throw new NotAllowed(`${user} was removed from this meeting and cannot return`);
    if (role === 'host' && user !== this.config.host) throw new NotAllowed('only the room\'s host can hold the host role');
    if (role === 'guest' && !this.config.allowGuests) throw new NotAllowed('this room does not allow guests');
    const prev = this.#members.get(user);
    if (prev && (prev.status === 'present' || prev.status === 'lobby')) throw new NotAllowed(`${user} is already here`);
    if (this.#locked && RANK[role] < RANK.moderator) throw new NotAllowed('the room is locked');
    this.#usedTokens.add(jti);
    const waits = RANK[role] < RANK.moderator && (this.config.lobby === 'everyone' || (this.config.lobby === 'guests' && role === 'guest'));
    const m: Member = { user, name: String(c.name ?? user).slice(0, 80), role, status: waits ? 'lobby' : 'present', audioMuted: this.config.startMuted, videoMuted: false, hardMuted: false, unmuteRequested: false, handRaised: false, consent: 'pending', requestedAt: now };
    if (!waits) {
      if (this.present().length >= this.config.maxParticipants) throw new NotAllowed('the room is full');
      m.joinedAt = now;
    }
    this.#members.set(user, m);
    this.#log(waits ? 'lobby-wait' : 'joined', undefined, user, { role });
    if (!waits && this.#recording.state !== 'off') this.#log('recording-consent-needed', undefined, user);
    return { user, status: m.status as 'present' | 'lobby', role };
  }

  leave(user: string): void {
    const m = this.member(user);
    if (m.status === 'removed') return;
    m.status = 'left';
    this.#log('left', undefined, user);
    this.#maybeStartRecording();
  }

  /** Let people out of the lobby. `who` omitted admits everyone waiting. */
  admit(by: string, who?: string): string[] {
    this.#open();
    this.#actor(by, 'moderator');
    const waiting = who ? [this.member(who)].filter((m) => m.status === 'lobby') : this.lobby();
    if (who && waiting.length === 0) throw new NotFound(`${who} is not waiting`);
    const done: string[] = [];
    for (const m of waiting) {
      if (this.present().length >= this.config.maxParticipants) throw new NotAllowed('the room is full');
      m.status = 'present';
      m.joinedAt = this.#now();
      done.push(m.user);
      this.#log('admitted', by, m.user);
      if (this.#recording.state !== 'off') this.#log('recording-consent-needed', undefined, m.user);
    }
    return done;
  }

  deny(by: string, who: string): void {
    this.#actor(by, 'moderator');
    const m = this.member(who);
    if (m.status !== 'lobby') throw new NotFound(`${who} is not waiting`);
    m.status = 'removed';
    this.#log('denied', by, who);
  }

  /** Remove people who have waited longer than the limit. */
  sweep(): string[] {
    const t = this.#now();
    const out: string[] = [];
    for (const m of this.lobby()) if (t - m.requestedAt >= this.config.lobbyTimeoutMs) { m.status = 'left'; out.push(m.user); this.#log('lobby-timeout', undefined, m.user); }
    return out;
  }

  /** The target may be muted by someone above them; the mute is hard (they cannot undo it). */
  mute(by: string, who: string, kinds: { audio?: boolean; video?: boolean } = { audio: true }): void {
    this.#open();
    const a = this.#actor(by, 'participant');
    const t = this.member(who);
    if (t.status !== 'present') throw new NotFound(`${who} is not in the room`);
    if (by === who) { this.#selfMute(a, kinds); return; }
    if (RANK[a.role] < RANK.moderator) throw new NotAllowed('only moderators can mute other people');
    if (RANK[t.role] >= RANK[a.role] && a.role !== 'host') throw new NotAllowed(`a ${a.role} cannot mute a ${t.role}`);
    if (t.role === 'host') throw new NotAllowed('the host cannot be muted by others');
    if (kinds.audio) { t.audioMuted = true; t.hardMuted = true; }
    if (kinds.video) t.videoMuted = true;
    this.#log('muted', by, who, { audio: !!kinds.audio, video: !!kinds.video });
  }

  muteAll(by: string): string[] {
    this.#actor(by, 'moderator');
    const out: string[] = [];
    for (const t of this.present()) if (RANK[t.role] < RANK.moderator) { t.audioMuted = true; t.hardMuted = true; out.push(t.user); }
    this.#log('muted-all', by, undefined, { count: out.length });
    return out;
  }

  #selfMute(m: Member, k: { audio?: boolean; video?: boolean }) { if (k.audio) m.audioMuted = true; if (k.video) m.videoMuted = true; this.#log('self-muted', m.user, m.user, { ...k }); }

  /** A person turns their own microphone or camera on. A hard mute stands until a moderator allows it. */
  unmute(user: string, kinds: { audio?: boolean; video?: boolean } = { audio: true }): void {
    this.#open();
    const m = this.#actor(user, 'guest');
    if (kinds.audio) {
      if (m.hardMuted) { m.unmuteRequested = true; this.#log('unmute-requested', user, user); throw new NotAllowed('a moderator muted you; your request to speak has been sent'); }
      m.audioMuted = false;
    }
    if (kinds.video) m.videoMuted = false;
    this.#log('unmuted', user, user, { ...kinds });
  }

  allowUnmute(by: string, who: string): void {
    this.#actor(by, 'moderator');
    const t = this.member(who);
    if (t.status !== 'present') throw new NotFound(`${who} is not in the room`);
    t.hardMuted = false;
    t.unmuteRequested = false;
    this.#log('unmute-allowed', by, who);
  }

  raiseHand(user: string, up = true): void {
    const m = this.#actor(user, 'guest');
    m.handRaised = up;
    this.#log(up ? 'hand-raised' : 'hand-lowered', user, user);
  }

  /** Remove someone. They may be barred from coming back. Moderators cannot remove moderators or the host. */
  kick(by: string, who: string, o: { ban?: boolean; reason?: string } = {}): void {
    this.#open();
    const a = this.#actor(by, 'moderator');
    if (by === who) throw new NotAllowed('use leave to leave');
    const t = this.member(who);
    if (t.status !== 'present' && t.status !== 'lobby') throw new NotFound(`${who} is not in the room`);
    if (t.role === 'host') throw new NotAllowed('the host cannot be removed');
    if (RANK[t.role] >= RANK[a.role] && a.role !== 'host') throw new NotAllowed(`a ${a.role} cannot remove a ${t.role}`);
    t.status = 'removed';
    if (o.ban) this.#banned.add(who);
    this.#log('removed', by, who, { ban: !!o.ban, ...(o.reason ? { reason: o.reason } : {}) });
    this.#maybeStartRecording();
  }

  /** The host changes someone's role. There is one host; handing it over makes the old host a moderator. */
  setRole(by: string, who: string, role: Role): void {
    this.#open();
    this.#actor(by, 'host');
    const t = this.member(who);
    if (t.status !== 'present') throw new NotFound(`${who} is not in the room`);
    if (who === by) throw new NotAllowed('the host cannot change their own role; hand the host role to someone');
    if (role === 'host') { const h = this.member(by); h.role = 'moderator'; t.role = 'host'; this.#log('host-handed-over', by, who); return; }
    t.role = role;
    this.#log('role-changed', by, who, { role });
  }

  lock(by: string, locked = true): void {
    this.#open();
    this.#actor(by, 'host');
    this.#locked = locked;
    this.#log(locked ? 'locked' : 'unlocked', by);
  }

  end(by: string): void {
    this.#open();
    this.#actor(by, 'host');
    this.#ended = true;
    this.#recording = { state: 'off' };
    for (const m of this.#members.values()) if (m.status === 'present' || m.status === 'lobby') m.status = 'left';
    this.#log('ended', by);
  }

  // --- recording ---------------------------------------------------------------------------------------------

  /** A moderator asks to record. Everyone present is asked; recording begins when all have answered. */
  startRecording(by: string): RecordingPlan {
    this.#open();
    this.#actor(by, 'moderator');
    if (this.config.recording === 'off') throw new NotAllowed('this room does not allow recording');
    if (this.#recording.state !== 'off') throw new NotAllowed('recording has already been started');
    for (const m of this.present()) m.consent = m.user === by ? 'consented' : 'pending';
    this.#recording = { state: 'asking', by };
    this.#log('recording-asked', by);
    this.#maybeStartRecording();
    return this.recordingPlan();
  }

  stopRecording(by: string): void {
    this.#actor(by, 'moderator');
    if (this.#recording.state === 'off') throw new NotAllowed('nothing is being recorded');
    this.#recording = { state: 'off' };
    for (const m of this.#members.values()) m.consent = 'pending';
    this.#log('recording-stopped', by);
  }

  /** A person answers the recording question for themselves; nobody can answer for them. */
  consent(user: string, agree: boolean): void {
    const m = this.#actor(user, 'guest');
    if (this.#recording.state === 'off') throw new NotAllowed('nothing is being recorded');
    m.consent = agree ? 'consented' : 'declined';
    this.#log(agree ? 'recording-consented' : 'recording-declined', user, user);
    if (!agree && this.config.recording === 'required') {
      m.status = 'left';
      this.#log('left-for-recording', user, user);
    }
    this.#maybeStartRecording();
  }

  #maybeStartRecording() {
    if (this.#recording.state !== 'asking') return;
    if (this.present().every((m) => m.consent !== 'pending')) {
      this.#recording = { state: 'recording', by: this.#recording.by! };
      this.#log('recording-started', this.#recording.by);
    }
  }

  /** Whose media may be captured right now, with the reason for each decision. */
  recordingPlan(): RecordingPlan {
    const s = this.#recording.state;
    const lines: PlanLine[] = [...this.#members.values()].filter((m) => m.status === 'present').sort((a, b) => a.user.localeCompare(b.user)).map((m) => {
      if (s === 'off') return { user: m.user, include: false, reason: 'not recording' };
      if (m.consent === 'consented') return { user: m.user, include: s === 'recording', reason: s === 'recording' ? 'consented' : 'consented; waiting for others to answer' };
      if (m.consent === 'declined') return { user: m.user, include: false, reason: 'declined; left out of the recording' };
      return { user: m.user, include: false, reason: 'has not answered; never recorded without consent' };
    });
    return { state: s, ...(this.#recording.by ? { startedBy: this.#recording.by } : {}), lines };
  }

  /** What a participant's screen should show about recording. */
  recordingNotice(user: string): string {
    const s = this.#recording.state;
    if (s === 'off') return 'This meeting is not being recorded.';
    const m = this.member(user);
    if (m.consent === 'pending') return `${this.#recording.by} wants to record this meeting. Do you agree to be recorded?`;
    if (m.consent === 'declined') return 'You declined: your audio and video are not recorded.';
    return s === 'recording' ? 'This meeting is being recorded. You agreed.' : 'You agreed. Recording starts when everyone has answered.';
  }
}
