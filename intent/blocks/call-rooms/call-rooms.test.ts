import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Signaling, verifyJwt } from '../webrtc-signaling/index.ts';
import { NotFound, Room, RoomClosed, joinToken } from './index.ts';
import type { Role, RoomConfig } from './index.ts';

const SECRET = 'call-rooms-0123456';
const T0 = 1_800_000_000_000;

const make = (c: Partial<RoomConfig> = {}) => {
  let now = T0;
  const room = new Room({ id: 'standup', title: 'Standup', host: 'hana', ...c }, { secrets: [SECRET], now: () => now });
  const tok = (user: string, role: Role = 'participant', o: { ttl?: number; room?: string } = {}) => joinToken(SECRET, { room: o.room ?? 'standup', user, name: user.toUpperCase(), role, ttlSeconds: o.ttl ?? 300, now });
  const join = (user: string, role: Role = 'participant') => room.join(tok(user, role));
  return { room, tok, join, tick: (ms: number) => void (now += ms) };
};

const crowd = (c: Partial<RoomConfig> = {}) => {
  const r = make({ lobby: 'guests', ...c });
  r.join('hana', 'host'); r.join('mo', 'moderator'); r.join('pat', 'participant'); r.join('pia', 'participant');
  return r;
};

test('a token carries the room, person and role, expires, and also opens the signalling socket', () => {
  const { tok } = make();
  const c = verifyJwt(SECRET, tok('ana'), { now: T0 });
  assert.deepEqual([c.room, c.sub, c.name, c.role], ['standup', 'ana', 'ANA', 'participant']);
  assert.equal(c.exp, T0 / 1000 + 300);
  const sent: string[] = [];
  const sig = new Signaling({ secrets: [SECRET], now: () => T0 });
  sig.message({ send: (t) => void sent.push(t) }, JSON.stringify({ id: 1, method: 'join', params: { token: tok('ana') } }));
  assert.equal(JSON.parse(sent[0]!).result.room, 'standup');
  assert.throws(() => joinToken(SECRET, { room: 'r', user: 'u', name: 'u', role: 'admin' as Role, ttlSeconds: 5, now: T0 }), /unknown role/);
  assert.throws(() => joinToken(SECRET, { room: 'r', user: 'u', name: 'u', role: 'guest', ttlSeconds: 0, now: T0 }), /1 to 86400/);
});

test('tokens for another room, expired, forged, reused or not yet valid are refused', () => {
  const { room, tok, tick } = make();
  assert.throws(() => room.join(tok('ana', 'participant', { room: 'other' })), /different room/);
  assert.throws(() => room.join(joinToken('another-secret-another-secret', { room: 'standup', user: 'x', name: 'x', role: 'host', ttlSeconds: 60, now: T0 })), /signature/);
  const t = tok('ana');
  room.join(t);
  room.leave('ana');
  assert.throws(() => room.join(t), /already been used/);
  const future = joinToken(SECRET, { room: 'standup', user: 'ben', name: 'b', role: 'participant', ttlSeconds: 600, now: T0, notBefore: T0 + 120_000 });
  assert.throws(() => room.join(future), /not valid yet/);
  const old = tok('cy', 'participant', { ttl: 10 });
  tick(60_000);
  assert.throws(() => room.join(old), /expired/);
});

test('only the named host can hold the host role, guests can be disallowed, and a person cannot join twice', () => {
  const { room, join } = make({ allowGuests: false });
  assert.throws(() => join('mallory', 'host'), /only the room's host/);
  assert.throws(() => join('gus', 'guest'), /does not allow guests/);
  join('hana', 'host');
  assert.throws(() => join('hana', 'host'), /already here/);
  assert.equal(room.present().length, 1);
});

test('the lobby holds guests by default, everyone with lobby=everyone, and nobody with lobby=off', () => {
  const a = crowd();
  assert.equal(a.join('gus', 'guest').status, 'lobby');
  assert.equal(a.join('ana', 'participant').status, 'present');
  const b = make({ lobby: 'everyone' });
  assert.equal(b.join('hana', 'host').status, 'present', 'the host never waits');
  assert.equal(b.join('mo', 'moderator').status, 'present');
  assert.equal(b.join('pat').status, 'lobby');
  const c = make({ lobby: 'off' });
  assert.equal(c.join('gus', 'guest').status, 'present');
});

test('moderators admit one or everyone, deny, and the wait times out', () => {
  const { room, join, tick } = crowd({ lobbyTimeoutMs: 60_000 });
  join('g1', 'guest'); tick(1000); join('g2', 'guest'); tick(1000); join('g3', 'guest');
  assert.deepEqual(room.lobby().map((m) => m.user), ['g1', 'g2', 'g3']);
  assert.deepEqual(room.admit('mo', 'g2'), ['g2']);
  assert.throws(() => room.admit('mo', 'g2'), NotFound);
  assert.throws(() => room.admit('pat', 'g1'), /needs a moderator/);
  room.deny('hana', 'g3');
  assert.equal(room.member('g3').status, 'removed');
  tick(60_000);
  assert.deepEqual(room.sweep(), ['g1']);
  assert.equal(room.member('g1').status, 'left');
  assert.deepEqual(room.admit('hana'), []);
});

test('a full room admits nobody more, and a locked room turns away everyone below moderator', () => {
  const { room, join, tok } = make({ maxParticipants: 3, lobby: 'off' });
  join('hana', 'host'); join('pat'); join('pia');
  assert.throws(() => join('late'), /room is full/);
  room.lock('hana');
  assert.throws(() => room.join(tok('late2')), /locked/);
  room.leave('pat');
  room.join(tok('mo', 'moderator'));
  assert.equal(room.present().length, 3, 'a moderator may enter a locked room');
  room.lock('hana', false);
  room.leave('pia');
  assert.equal(join('late3').status, 'present');
  assert.deepEqual(room.events.filter((e) => e.type.includes('lock')).map((e) => e.type), ['locked', 'unlocked']);
});

test('moderators mute participants hard: they cannot unmute themselves, can ask, and a moderator can allow it', () => {
  const { room } = crowd();
  room.mute('mo', 'pat');
  assert.equal(room.member('pat').audioMuted, true);
  assert.throws(() => room.unmute('pat'), /request to speak has been sent/);
  assert.equal(room.member('pat').unmuteRequested, true);
  assert.equal(room.member('pat').audioMuted, true);
  room.allowUnmute('mo', 'pat');
  room.unmute('pat');
  assert.equal(room.member('pat').audioMuted, false);
  assert.throws(() => room.mute('pat', 'pia'), /only moderators/);
  room.mute('pia', 'pia');
  assert.equal(room.member('pia').audioMuted, true);
  room.unmute('pia');
  assert.equal(room.member('pia').audioMuted, false, 'a self-mute can be undone by the person');
});

test('muting rules by rank: moderators cannot mute moderators or the host; the host can mute moderators', () => {
  const { room, join } = crowd();
  join('mo2', 'moderator');
  assert.throws(() => room.mute('mo', 'mo2'), /cannot mute a moderator/);
  assert.throws(() => room.mute('mo', 'hana'), /cannot mute a host/);
  room.mute('hana', 'mo2');
  assert.equal(room.member('mo2').hardMuted, true);
  assert.throws(() => room.mute('hana', 'ghost'), NotFound);
  room.mute('mo', 'pat', { video: true });
  assert.equal(room.member('pat').videoMuted, true);
  assert.equal(room.member('pat').hardMuted, false, 'turning the camera off does not hard-mute the microphone');
});

test('mute all silences participants and guests but not moderators or the host', () => {
  const { room } = crowd();
  assert.deepEqual(room.muteAll('mo').sort(), ['pat', 'pia']);
  assert.equal(room.member('mo').audioMuted, false);
  assert.throws(() => room.muteAll('pat'), /needs a moderator/);
});

test('removing people follows rank, can bar their return, and tells the room', () => {
  const { room, join, tok } = crowd();
  assert.throws(() => room.kick('pat', 'pia'), /needs a moderator/);
  assert.throws(() => room.kick('mo', 'hana'), /host cannot be removed/);
  join('mo2', 'moderator');
  assert.throws(() => room.kick('mo', 'mo2'), /cannot remove a moderator/);
  room.kick('hana', 'mo2');
  room.kick('mo', 'pat', { ban: true, reason: 'disruption' });
  assert.equal(room.member('pat').status, 'removed');
  assert.throws(() => room.join(tok('pat')), /cannot return/);
  const e = room.events.find((x) => x.type === 'removed' && x.who === 'pat')!;
  assert.deepEqual([e.by, e.detail], ['mo', { ban: true, reason: 'disruption' }]);
  room.kick('mo', 'pia');
  assert.equal(room.join(tok('pia')).status, 'present', 'without a ban a removed person may be let back in');
  assert.throws(() => room.kick('mo', 'mo'), /use leave/);
});

test('only the host changes roles; handing the host role over demotes the old host; there is always one host', () => {
  const { room } = crowd();
  assert.throws(() => room.setRole('mo', 'pat', 'moderator'), /needs a host/);
  room.setRole('hana', 'pat', 'moderator');
  assert.equal(room.member('pat').role, 'moderator');
  assert.throws(() => room.setRole('hana', 'hana', 'guest'), /cannot change their own role/);
  room.setRole('hana', 'pia', 'host');
  assert.deepEqual([room.member('hana').role, room.member('pia').role], ['moderator', 'host']);
  assert.equal(room.present().filter((m) => m.role === 'host').length, 1);
  assert.equal(room.present()[0]!.user, 'pia', 'the host is listed first');
  room.kick('pia', 'hana');
});

test('only the host can end the meeting, and then nothing more can happen in it', () => {
  const { room, tok } = crowd();
  assert.throws(() => room.end('mo'), /needs a host/);
  room.end('hana');
  assert.equal(room.ended, true);
  assert.deepEqual(room.present(), []);
  assert.throws(() => room.join(tok('late')), RoomClosed);
  assert.throws(() => room.mute('hana', 'pat'), RoomClosed);
});

test('recording asks everyone present; it starts only when all have answered; decliners are left out', () => {
  const { room } = crowd();
  const plan = room.startRecording('mo');
  assert.equal(plan.state, 'asking');
  assert.deepEqual(plan.lines.map((l) => [l.user, l.include]), [['hana', false], ['mo', false], ['pat', false], ['pia', false]], 'nobody is captured while asking');
  assert.match(room.recordingNotice('pat'), /mo wants to record this meeting/);
  room.consent('hana', true); room.consent('pat', true);
  assert.equal(room.recordingPlan().state, 'asking');
  room.consent('pia', false);
  const p = room.recordingPlan();
  assert.equal(p.state, 'recording');
  assert.deepEqual(p.lines.map((l) => [l.user, l.include, l.reason]), [['hana', true, 'consented'], ['mo', true, 'consented'], ['pat', true, 'consented'], ['pia', false, 'declined; left out of the recording']]);
  assert.match(room.recordingNotice('pia'), /not recorded/);
  assert.match(room.recordingNotice('pat'), /being recorded/);
});

test('someone who joins mid-recording is not recorded until they agree, and can be admitted from the lobby first', () => {
  const { room, join } = crowd();
  room.startRecording('hana');
  room.consent('mo', true); room.consent('pat', true); room.consent('pia', true);
  join('late');
  const l = room.recordingPlan().lines.find((x) => x.user === 'late')!;
  assert.deepEqual([l.include, l.reason], [false, 'has not answered; never recorded without consent']);
  assert.ok(room.events.some((e) => e.type === 'recording-consent-needed' && e.who === 'late'));
  room.consent('late', true);
  assert.equal(room.recordingPlan().lines.find((x) => x.user === 'late')!.include, true);
  join('gus', 'guest');
  assert.equal(room.recordingPlan().lines.some((x) => x.user === 'gus'), false, 'someone still in the lobby is not in the plan');
  room.admit('mo', 'gus');
  assert.equal(room.recordingPlan().lines.find((x) => x.user === 'gus')!.include, false);
});

test('a person leaving unblocks a recording that was waiting on them; stopping resets consent', () => {
  const { room } = crowd();
  room.startRecording('hana');
  room.consent('mo', true); room.consent('pat', true);
  assert.equal(room.recordingPlan().state, 'asking');
  room.leave('pia');
  assert.equal(room.recordingPlan().state, 'recording');
  room.stopRecording('hana');
  assert.equal(room.recordingPlan().state, 'off');
  assert.ok(room.recordingPlan().lines.every((l) => !l.include && l.reason === 'not recording'));
  assert.equal(room.member('pat').consent, 'pending');
  assert.throws(() => room.consent('pat', true), /nothing is being recorded/);
  assert.throws(() => room.stopRecording('hana'), /nothing is being recorded/);
});

test('recording rules: off rooms refuse, participants cannot start it, and required rooms make decliners leave', () => {
  const off = crowd({ recording: 'off' });
  assert.throws(() => off.room.startRecording('hana'), /does not allow recording/);
  const { room } = crowd({ recording: 'required' });
  assert.throws(() => room.startRecording('pat'), /needs a moderator/);
  room.startRecording('hana');
  room.consent('pia', false);
  assert.equal(room.member('pia').status, 'left');
  assert.throws(() => room.startRecording('mo'), /already been started/);
  assert.ok(room.events.some((e) => e.type === 'left-for-recording' && e.who === 'pia'));
});

test('hands and the event trail: every change is recorded with who did it and to whom', () => {
  const { room } = crowd();
  room.raiseHand('pat');
  assert.equal(room.member('pat').handRaised, true);
  room.raiseHand('pat', false);
  room.mute('mo', 'pia');
  const trail = room.events.map((e) => [e.type, e.by, e.who].filter(Boolean).join(' '));
  assert.deepEqual(trail.slice(-3), ['hand-raised pat pat', 'hand-lowered pat pat', 'muted mo pia']);
  assert.ok(room.events.every((e) => e.at === T0));
  assert.throws(() => new Room({ id: 'bad id', title: 't', host: 'h' }, { secrets: [SECRET], now: () => 0 }), /room ids/);
});

test('startMuted rooms put people in muted but not hard-muted, so they can speak when ready', () => {
  const { room, join } = make({ startMuted: true, lobby: 'off' });
  join('hana', 'host'); join('pat');
  assert.equal(room.member('pat').audioMuted, true);
  room.unmute('pat');
  assert.equal(room.member('pat').audioMuted, false);
});
