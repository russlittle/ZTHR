// Verifies docs/flows/campus-life.md
// Verifies docs/flows/operator.md
// Verifies docs/flows/class-site.md
import { describe, expect, it } from 'vitest';
import { routedEgress, type Egress } from '@zthr/egress';
import { startAll } from '../../campus-services/src/index.js';
import { Advocate } from '../src/agents/advocate.js';
import { Operator } from '../src/operator/operator.js';
import { PERSONAS } from '../src/server/demo.js';
import { checkTone } from '../src/domain/tone.js';

/** An Advocate wired to the synthetic campus services through its egress door, at a campus-local wall time. */
function campusWorld(localIso: string, opts: { scenario?: string; egress?: Egress; today?: string } = {}) {
  let now = new Date(`${localIso}-05:00`);
  const services = startAll();
  const egress = opts.egress ?? routedEgress(services, undefined, (): Record<string, string> => (opts.scenario ? { 'x-twin-scenario': opts.scenario } : {}));
  const a = new Advocate({ today: () => opts.today ?? localIso.slice(0, 10), now: () => now, egress });
  return { a, services, setNow: (iso: string) => void (now = new Date(`${iso}-05:00`)) };
}

const last = (a: Advocate, sid: string) => a.messages(sid).at(-1)!;

describe('the operator keeps campus feeds (Pattern 24)', () => {
  it('fetches every campus a student attends, with nothing unknown', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    PERSONAS.Maria!(a);
    PERSONAS.Jayden!(a);
    const r = await a.operator.tick();
    expect(r.ran).toEqual(expect.arrayContaining(['campus-feeds:sinclair', 'campus-feeds:wright-state', 'dispatch', 'verify']));
    for (const c of ['sinclair', 'wright-state']) {
      const f = a.campusFeed(c)!;
      expect(f.unknown).toEqual([]);
      expect(f.locations.length).toBeGreaterThan(0);
      expect(f.spaces.length).toBeGreaterThan(0);
      expect(f.postings.length).toBeGreaterThan(0);
      expect(f.stops.length).toBeGreaterThan(0);
    }
  });
  it('a service outage is recorded as unknown, and the student is told plainly instead of shown nothing', async () => {
    const { a } = campusWorld('2026-11-02T12:00', { scenario: 'outage' });
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    expect(a.campusFeed('sinclair')!.unknown.length).toBeGreaterThan(0);
    for (const m of [a.campusFoodMessage(s.id), a.studySpotsMessage(s.id), a.jobsMessage(s.id), a.mentorsMessage(s.id), a.freeFoodMessage(s.id)]) {
      expect(m.text).toMatch(/can't see .* right now, so I won't guess/);
      expect(m.nextSteps.length).toBeGreaterThan(0);
    }
  });
  it('a feed older than a day and a half is not used', async () => {
    const { a, setNow } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    setNow('2026-11-04T08:00');
    expect(a.campusFoodMessage(s.id).text).toMatch(/can't see campus dining/);
  });
  it('two operators never run the same job at once (Pattern 26)', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    PERSONAS.Maria!(a);
    const other = new Operator(a, 'op-other');
    const now = a.clock();
    expect(other.lease('campus-feeds:sinclair', now)).toBeDefined();
    const r = await a.operator.tick(now);
    expect(r.skipped).toContainEqual({ job: 'campus-feeds:sinclair', reason: 'another operator holds the lease' });
    expect(other.heartbeat('campus-feeds:sinclair', now)).toBe(true);
    other.release('campus-feeds:sinclair');
    const r2 = await a.operator.tick(new Date(now.getTime() + 1000));
    expect(r2.ran).toContain('campus-feeds:sinclair');
  });
  it('an expired lease can be taken over', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const other = new Operator(a, 'op-crashed');
    const now = a.clock();
    other.lease('dispatch', now);
    expect(a.operator.lease('dispatch', now)).toBeUndefined();
    expect(a.operator.lease('dispatch', new Date(now.getTime() + 61_000))).toBeDefined();
  });
  it('holds name what the student loses: a bus rider with no stop gets no leave-by times', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.setCommute(s.id, { mode: 'bus' });
    const r = await a.operator.tick();
    expect(r.held).toContainEqual({ job: `commute:${s.id}`, loss: 'No leave-by times until the student picks a home stop.' });
  });
});

describe('food on campus (CL-1, CL-2)', () => {
  it('at noon on a Monday, lists what is open with the cheapest item from today\'s menu', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    const m = a.campusFoodMessage(s.id);
    expect(m.text).toMatch(/Open now on campus/);
    expect(m.text).toMatch(/Third Street Commons, Building 8, until 2:00 p\.m\. Cheapest: .+, \$\d+\.\d{2}\./);
    expect(m.text).toMatch(/The Perk Coffee Bar/);
    expect(m.text).not.toMatch(/Library Grab and Go.*until 5/);
  });
  it('late at night at Wright State, the late market is open past midnight', async () => {
    const { a } = campusWorld('2026-11-02T23:30');
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    const m = a.campusFoodMessage(s.id);
    expect(m.text).toMatch(/Night Owl Market, Hamilton Hall, until 1:00 a\.m\./);
  });
  it('at 3 a.m. nothing is open, and it says what opens next', async () => {
    const { a } = campusWorld('2026-11-03T03:00');
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    expect(a.campusFoodMessage(s.id).text).toMatch(/Nothing on campus is open right now\. The Perk Coffee Bar opens today at 7:30 a\.m\.|Third Street Commons opens today at 7:00 a\.m\./);
  });
  it('over Thanksgiving it says campus dining is closed and why', async () => {
    const { a } = campusWorld('2026-11-27T12:00');
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    const t = a.campusFoodMessage(s.id).text;
    expect(t).toMatch(/Nothing on campus is open right now/);
    expect(t).toMatch(/Thanksgiving|opens/);
  });
  it('free food events are listed, and adding one puts it in the student\'s dates', async () => {
    const { a } = campusWorld('2026-11-02T09:00');
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    const m = a.freeFoodMessage(s.id);
    expect(m.text).toMatch(/Free food on campus this week/);
    const add = m.nextSteps.find((n) => n.action.startsWith('add-date:'))!;
    a.perform(s.id, add.action);
    expect(a.deadlines(s.id).some((d) => d.due === add.action.slice(9, 19))).toBe(true);
  });
  it('the conversation finds it: "what\'s open", "free food", "dining hall"', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    expect(a.converse(s.id, "what's open on campus?")[0]!.text).toMatch(/Open now on campus/);
    expect(a.converse(s.id, 'any free food this week')[0]!.text).toMatch(/Free food/);
    expect(a.converse(s.id, 'is the dining hall open')[0]!.text).toMatch(/Open now on campus/);
  });
});

describe('study spots and booking a room: a dispatch is not a result (Pattern 25)', () => {
  it('lists open spaces quiet first, and offers a room at the next free hour', async () => {
    const { a } = campusWorld('2026-11-04T13:20');
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    const m = a.studySpotsMessage(s.id);
    expect(m.text.split('\n')[1]).toMatch(/Quiet\./);
    expect(m.nextSteps[0]!.action).toBe('book-room:wright-room-241:2026-11-04:14:00:60');
  });
  it('booking is queued, sent once, then confirmed by looking it up; only then is the student told it is booked', async () => {
    const { a } = campusWorld('2026-11-04T13:20');
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    const r = a.perform(s.id, 'book-room:wright-room-241:2026-11-04:14:00:60')!;
    expect(r.message.text).toMatch(/I will tell you when it is confirmed/);
    expect(a.messages(s.id).some((m) => /^Booked:/.test(m.text))).toBe(false);
    await a.operator.tick();
    const d = a.operator.dispatches(s.id)[0]!;
    expect(d.status).toBe('confirmed');
    expect(d.attempts).toBe(1);
    expect(last(a, s.id).text).toMatch(/^Booked: Group study room 241 Wed, Nov 4 at 2:00 p\.m\./);
  });
  it('asking twice books once', async () => {
    const { a } = campusWorld('2026-11-04T13:20');
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    a.perform(s.id, 'book-room:wright-room-241:2026-11-04:14:00:60');
    a.perform(s.id, 'book-room:wright-room-241:2026-11-04:14:00:60');
    await a.operator.tick();
    expect(a.operator.dispatches(s.id)).toHaveLength(1);
  });
  it('a time someone else took is refused, and the student is told', async () => {
    const { a } = campusWorld('2026-11-04T13:20');
    const j = PERSONAS.Jayden!(a);
    const p = PERSONAS.Priya!(a);
    await a.operator.tick();
    a.perform(j.id, 'book-room:wright-room-241:2026-11-04:14:00:60');
    await a.operator.tick();
    a.perform(p.id, 'book-room:wright-room-241:2026-11-04:14:00:60');
    await a.operator.tick();
    expect(a.operator.dispatches(p.id)[0]!.status).toBe('refused');
    expect(last(a, p.id).text).toMatch(/did not go through: that time was taken/);
  });
  it('a send that fails in flight is marked ambiguous, re-sent only with the same key, and books once', async () => {
    const services = startAll();
    const inner = routedEgress(services);
    let drop = 1;
    const flaky: Egress = {
      log: inner.log,
      async send(req) {
        if (req.method === 'POST' && drop > 0) {
          drop--;
          await inner.send(req); // it reached the service, but the answer is lost
          throw new Error('connection reset');
        }
        return inner.send(req);
      },
    };
    const { a } = campusWorld('2026-11-04T13:20', { egress: flaky });
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    a.perform(s.id, 'book-room:wright-room-241:2026-11-04:14:00:60');
    await a.operator.dispatch(a.clock());
    expect(a.operator.dispatches(s.id)[0]!.status).toBe('ambiguous');
    await a.operator.verify();
    const d = a.operator.dispatches(s.id)[0]!;
    expect(d.status).toBe('confirmed');
    const avail = (await (await services['places.campus.example']!.request('/v1/rooms/wright-room-241/availability?date=2026-11-04')).json()) as { free: string[] };
    expect(avail.free).not.toContain('14:00');
    expect(avail.free).toContain('15:00');
  });
  it('after three failed tries it stops and says so', async () => {
    const dead: Egress = { log: [], send: async () => { throw new Error('unreachable'); } };
    const { a } = campusWorld('2026-11-04T13:20');
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    const b = new Advocate({ today: () => '2026-11-04', now: () => a.clock(), egress: dead });
    const bs = PERSONAS.Jayden!(b);
    b.store.put('campus_feeds', 'wright-state', '_operator', a.campusFeed('wright-state'));
    b.perform(bs.id, 'book-room:wright-room-241:2026-11-04:14:00:60');
    for (let i = 0; i < 4; i++) await b.operator.dispatch(b.clock());
    expect(b.operator.dispatches(bs.id)[0]!.status).toBe('refused');
    expect(last(b, bs.id).text).toMatch(/three tries/);
    expect(s).toBeDefined();
  });
});

describe('getting there by bus (HH-1)', () => {
  const rider = async (localIso: string, scenario?: string) => {
    const w = campusWorld(localIso, { scenario });
    const s = PERSONAS.Maria!(w.a);
    await w.a.operator.tick();
    w.a.perform(s.id, 'set-stop:salem-catalpa');
    await w.a.operator.tick();
    return { ...w, s };
  };
  it('a student with no stop is asked to pick one, from real stops', async () => {
    const { a } = campusWorld('2026-11-02T06:30');
    const s = PERSONAS.Maria!(a);
    await a.operator.tick();
    const m = a.leaveByMessage(s.id);
    expect(m.text).toMatch(/Which bus stop/);
    expect(m.nextSteps.filter((n) => n.action.startsWith('set-stop:')).length).toBeGreaterThan(1);
  });
  it('plans the trip to the first class with ten minutes to spare', async () => {
    const { a, s } = await rider('2026-11-02T06:30');
    const p = a.commutePlans(s.id).find((x) => x.date === '2026-11-02')!;
    expect(p.course).toBe('BIO 1111');
    expect(p.itineraries[0]!.arrive <= '08:50').toBe(true);
    const m = a.leaveByMessage(s.id);
    expect(m.text).toMatch(/^For BIO 1111 today at 9:00 a\.m\.: leave Salem Ave and Catalpa Dr at \d+:\d{2} a\.m\. Take Route 1\./);
  });
  it('in the snow, a late bus that would make the student late offers a note to the instructor', async () => {
    const { a, s, setNow } = await rider('2026-11-02T06:30', 'snow-delays');
    const it = a.commutePlans(s.id)[0]!.itineraries[0]!;
    const [h, mm] = it.depart.split(':').map(Number);
    setNow(`2026-11-02T${String(h! - (mm! < 15 ? 1 : 0)).padStart(2, '0')}:${String((mm! + 45) % 60).padStart(2, '0')}`);
    await a.operator.tick();
    const m = a.leaveByMessage(s.id);
    if (/running \d+ minutes late/.test(m.text)) {
      const lateMin = Number(m.text.match(/running (\d+) minutes late/)![1]);
      const arrive = Number(it.arrive.slice(0, 2)) * 60 + Number(it.arrive.slice(3));
      expect(m.nextSteps[0]!.action.startsWith('draft:late:')).toBe(arrive + lateMin > 9 * 60);
      expect(m.text).toMatch(/Snow/);
    }
    const draft = a.perform(s.id, 'draft:late:BIO%201111')!;
    expect(draft.message.text).toMatch(/My bus is running late today/);
    expect(a.outboundLog).toHaveLength(0);
  });
  it('next bus uses live times only while they are fresh', async () => {
    const { a, s, setNow } = await rider('2026-11-02T07:00');
    expect(a.nextBusMessage(s.id).text).toMatch(/^Next buses at Salem Ave and Catalpa Dr:\n- Route 1/);
    setNow('2026-11-02T07:15');
    expect(a.nextBusMessage(s.id).text).toMatch(/don't have live times/);
  });
  it('on Thanksgiving there is no bus, and it says so', async () => {
    const { a, s } = await rider('2026-11-26T07:00');
    expect(a.nextBusMessage(s.id).text).toMatch(/No more buses .* Thanksgiving: no service/);
  });
  it('the conversation finds it: "when should I leave", "next bus"', async () => {
    const { a, s } = await rider('2026-11-02T06:30');
    expect(a.converse(s.id, 'when should I leave for class?')[0]!.text).toMatch(/^For BIO 1111/);
    expect(a.converse(s.id, 'next bus?')[0]!.text).toMatch(/^Next buses/);
  });
  it('changing the stop clears old plans', async () => {
    const { a, s } = await rider('2026-11-02T06:30');
    expect(a.commutePlans(s.id).length).toBeGreaterThan(0);
    a.perform(s.id, 'set-stop:huffman-linden');
    expect(a.commutePlans(s.id)).toEqual([]);
    expect(a.commuteSettings(s.id).homeStop).toBe('huffman-linden');
  });
});

describe('jobs that fit (CAR-2) and mentors (CAR-4)', () => {
  it('never lists a job whose shifts overlap a class (with 30 minutes to get there) or a work shift', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.addClasses(s.id, [{ course: 'ENG 1101', days: ['Mon', 'Wed'], start: '16:00', end: '17:15' }]);
    a.addShifts(s.id, [{ date: '2026-11-07', start: '08:00', end: '17:00', employer: 'Store' }]);
    await a.operator.tick();
    const m = a.jobsMessage(s.id);
    expect(m.text).not.toMatch(/Library desk assistant/); // Mon/Wed 1-5 p.m. clashes with ENG 1101
    expect(m.text).not.toMatch(/Patient access representative/); // Saturday clashes with the shift
    expect(m.text).toMatch(/Tutoring center front desk.*flexible hours, work-study/);
  });
  it('fair-chance employers only when the student asks, and only from the fair-chance path', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Tyler!(a);
    await a.operator.tick();
    expect(a.careerMessage(s.id).nextSteps.map((n) => n.action)).not.toContain('jobs-fair-chance');
    const fc = a.fairChanceMessage(s.id);
    expect(fc.nextSteps[0]!.action).toBe('jobs-fair-chance');
    const jobs = a.perform(s.id, 'jobs-fair-chance')!.message.text;
    expect(jobs).toMatch(/Warehouse associate|Patient access/);
    expect(JSON.stringify(a.store.exportStudent(s.id))).not.toMatch(/fair|record|felony/i);
  });
  it('a note about a job is a draft; nothing is sent without approval', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    const m = a.jobsMessage(s.id);
    const r = a.perform(s.id, m.nextSteps[0]!.action)!;
    expect(r.message.text).toMatch(/Here is a draft to .+:\n"Hello, this is Jayden\./);
    expect(a.outboundLog).toHaveLength(0);
  });
  it('mentors who share a community the student chose come first; no mentor without open slots', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.setCommunities(s.id, ['student-parents', 'not-a-community']);
    expect(a.student(s.id).communities).toEqual(['student-parents']);
    await a.operator.tick();
    const m = a.mentorsMessage(s.id);
    expect(m.text).not.toMatch(/Rosa G\./);
    expect(m.text.split('\n')[1]).toMatch(/Dana R\./);
    const intro = a.perform(s.id, m.nextSteps[0]!.action)!;
    expect(intro.message.text).toMatch(/I'd like to learn about working in/);
    expect(intro.message.text).not.toMatch(/\d{3}-\d{4}|@/);
  });
});

describe('the mentor network (Phase 4)', () => {
  it('an approved introduction goes to the mentor as first name and note only, and a yes puts the meeting on the calendar', async () => {
    const { a, setNow } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.setCommunities(s.id, ['student-parents']);
    await a.operator.tick();
    const intro = a.perform(s.id, a.mentorsMessage(s.id).nextSteps[0]!.action)!;
    expect(a.operator.dispatches(s.id)).toHaveLength(0);
    a.perform(s.id, intro.message.nextSteps[0]!.action);
    await new Promise((r) => setTimeout(r, 0));
    const [d] = a.operator.dispatches(s.id);
    expect(d).toMatchObject({ kind: 'mentor-request', status: 'queued', request: { mentor: 'm1', firstName: 'Maria' } });
    expect(Object.keys(d!.request).sort()).toEqual(['firstName', 'mentor', 'note']);
    await a.operator.tick();
    expect(a.operator.dispatches(s.id)[0]!.status).toBe('sent');
    expect(a.messages(s.id).some((m) => /said yes/.test(m.text))).toBe(false);
    setNow('2026-11-02T14:30');
    await a.operator.tick();
    expect(a.operator.dispatches(s.id)[0]!.status).toBe('confirmed');
    expect(last(a, s.id).text).toMatch(/^Dana R\. said yes\. You meet Wed, Nov 4 at 4:00 p\.m\. Career center, front desk\.$/);
    expect(a.deadlines(s.id).some((x) => x.title === 'Meet Dana R.' && x.due === '2026-11-04T16:00' && x.kind === 'appointment')).toBe(true);
  });
  it('a no is told kindly, with other mentors offered', async () => {
    const { a, setNow } = campusWorld('2026-11-02T12:00', { scenario: 'mentor-declines' });
    const s = PERSONAS.Maria!(a);
    const b = campusWorld('2026-11-02T12:00');
    PERSONAS.Maria!(b.a);
    await b.a.operator.tick();
    a.store.put('campus_feeds', 'sinclair', '_operator', b.a.campusFeed('sinclair'));
    const intro = a.perform(s.id, a.mentorsMessage(s.id).nextSteps[0]!.action)!;
    a.perform(s.id, intro.message.nextSteps[0]!.action);
    await new Promise((r) => setTimeout(r, 0));
    await a.operator.dispatch(a.clock());
    setNow('2026-11-02T15:00');
    await a.operator.verify();
    expect(last(a, s.id).text).toMatch(/can't take someone new right now\. That is about their time, not you\./);
    expect(last(a, s.id).nextSteps[0]!.action).toBe('mentors');
  });
});

describe('class-site sync (Phase 3)', () => {
  it('pulls every assignment once, confirmed, with the class site as the source', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.connectClassSite(s.id, 'lms-maria');
    await a.operator.tick();
    const synced = a.deadlines(s.id).filter((d) => d.source.ref?.startsWith('lms:'));
    expect(synced.length).toBeGreaterThan(20);
    expect(synced.every((d) => d.confirmed && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.due))).toBe(true);
    await a.operator.tick();
    expect(a.deadlines(s.id).filter((d) => d.source.ref?.startsWith('lms:'))).toHaveLength(synced.length);
  });
  it('the token is sealed and opened only by the operator\'s class-site job, and every opening is in the ledger', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.connectClassSite(s.id, 'lms-maria');
    await a.operator.tick();
    expect(JSON.stringify(a.store.exportStudent(s.id))).not.toContain('lms-maria');
    const releases = a.ledger.entries(s.id).filter((e) => e.kind === 'release');
    expect(releases.length).toBeGreaterThan(0);
    expect(releases.every((e) => e.detail.identity === 'operator:class-site')).toBe(true);
    expect(() => a.sealed.open(s.id, 'class_site_token', 'agent:navigator', 'curious')).toThrow();
  });
  it('a due date moved on the class site moves here, with a message', async () => {
    let scenario: string | undefined;
    const services = startAll();
    const egress = routedEgress(services, undefined, (): Record<string, string> => (scenario ? { 'x-twin-scenario': scenario } : {}));
    const { a } = campusWorld('2026-11-02T12:00', { egress });
    const s = PERSONAS.Maria!(a);
    a.connectClassSite(s.id, 'lms-maria');
    await a.operator.tick();
    const before = new Map(a.deadlines(s.id).map((d) => [d.source.ref, d.due]));
    scenario = 'reschedule';
    await a.operator.tick();
    const changed = a.deadlines(s.id).filter((d) => d.source.ref && before.get(d.source.ref) !== d.due);
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(a.messages(s.id).some((m) => /Your class site changed a date\./.test(m.text))).toBe(true);
  });
  it('a room change announced on the class site updates the schedule', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.connectClassSite(s.id, 'lms-maria');
    await a.operator.tick();
    expect(a.messages(s.id).some((m) => /moved|could not tell which one/.test(m.text))).toBe(true);
  });
  it('a wrong token gives an unknown, not a crash and not an empty calendar claim', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.connectClassSite(s.id, 'not-a-token');
    expect(await a.syncClassSite(s.id)).toMatchObject({ added: 0, unknown: 'lms answered 401' });
  });
  it('disconnecting removes the token and stops the sync', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.connectClassSite(s.id, 'lms-maria');
    a.disconnectClassSite(s.id);
    const r = await a.operator.tick();
    expect(r.ran.some((j) => j.startsWith('class-site'))).toBe(false);
    expect(a.sealed.has(s.id, 'class_site_token')).toBe(false);
  });
});

describe('every campus message reads plainly', () => {
  it('passes the tone check at the student\'s own reading grade', async () => {
    const { a } = campusWorld('2026-11-02T12:00');
    for (const name of ['Maria', 'Jayden', 'Sam', 'Alex']) {
      const s = PERSONAS[name]!(a);
      await a.operator.tick();
      a.setCommute(s.id, { mode: 'bus', homeStop: 'salem-catalpa' });
      await a.operator.tick();
      for (const m of [a.campusFoodMessage(s.id), a.freeFoodMessage(s.id), a.studySpotsMessage(s.id), a.leaveByMessage(s.id), a.nextBusMessage(s.id), a.jobsMessage(s.id), a.mentorsMessage(s.id)]) {
        const r = checkTone(m, s.dial.depth, s.dial.readingGrade, s.dial.language);
        expect(r.problems, `${name}: ${m.text}`).toEqual([]);
      }
    }
  });
});
