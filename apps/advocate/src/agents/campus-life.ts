import type { Advocate } from './advocate.js';
import type { ClassMeeting, NextStep, OutboundMessage, Shift } from '../domain/types.js';
import { addDays, relDay, sentence, shortDate, time12, weekday } from '../domain/dates.js';
import { minutesOf, openAt, type CampusFeed, type ItineraryT, type MenuItemT, type PostingT } from '../integrations/campus.js';

/**
 * Campus life (PRD CL-1 to CL-4), getting there by bus (HH-1), jobs that fit (CAR-2) and mentors (CAR-4). Every
 * answer is built from feeds the operator fetched from the college's services, and says so when a feed is missing
 * or old. Nothing here sends anything: booking a room is queued and confirmed later, and an introduction to a
 * mentor is a draft the student approves.
 */
const back: NextStep = { label: 'Show my day', action: 'today' };
const msg = (sid: string, text: string, nextSteps: NextStep[], author = 'navigator', why?: string): OutboundMessage => ({ studentId: sid, author, urgency: 'routine', text, nextSteps, ...(why ? { why } : {}) });
const money = (n: number) => `$${n.toFixed(2)}`;
const STALE_MS = 36 * 3600_000;

function feedFor(a: Advocate, sid: string): CampusFeed | undefined {
  const f = a.campusFeed(a.student(sid).enrollment.college);
  return f && a.clock().getTime() - Date.parse(f.fetchedAt) < STALE_MS ? f : undefined;
}

const cantSee = (sid: string, what: string, steps: NextStep[]) => msg(sid, `I can't see ${what} right now, so I won't guess.`, [...steps, back], 'navigator', 'The college service did not answer, or what it sent did not match what we expect.');

// ---------- food on campus (CL-1, CL-2) ----------

export function campusFoodMessage(a: Advocate, sid: string): OutboundMessage {
  const feed = feedFor(a, sid);
  if (!feed || feed.unknown.some((u) => u.startsWith('dining'))) return cantSee(sid, 'campus dining', [{ label: 'Food help near me', action: 'need:food' }]);
  const { date, min } = a.localNow();
  const open = openAt(feed, date, min);
  const cheapest = (id: string, period: string): MenuItemT | undefined => (feed.menus[`${id}|${period}`] ?? []).slice().sort((x, y) => x.price - y.price)[0];
  const free = feed.events.filter((e) => e.tags.includes('free-food') && e.date === date && minutesOf(e.end) > min);
  const lines = open.map((o) => {
    const c = cheapest(o.location.id, o.period);
    return `- ${sentence(`${o.location.name}, ${o.location.building}, until ${time12(o.closes)}`)}${c ? ` Cheapest: ${c.name}, ${money(c.price)}.` : ''}`;
  });
  const freeLine = free.length ? `\nFree food today: ${free[0]!.title}, ${time12(free[0]!.start)}, ${free[0]!.where}.` : '';
  if (!open.length) {
    const next = nextOpening(feed, date, min);
    return msg(sid, `Nothing on campus is open right now.${next ? ` ${next}` : ''}${freeLine}`, [{ label: 'Free food this week', action: 'free-food' }, { label: 'Food help near me', action: 'need:food' }, back], 'navigator', sentence(`From campus dining hours, as of ${time12(a.localTime(feed.fetchedAt))}`));
  }
  return msg(sid, `Open now on campus:\n${lines.join('\n')}${freeLine}`, [{ label: 'Free food this week', action: 'free-food' }, { label: 'Food help near me', action: 'need:food' }, back], 'navigator', sentence(`From campus dining hours and today's menus, as of ${time12(a.localTime(feed.fetchedAt))}`));
}

function nextOpening(feed: CampusFeed, date: string, min: number): string | undefined {
  for (let d = 0; d < 7; d++) {
    const day = addDays(date, d);
    const opens = feed.locations
      .flatMap((l) => (feed.hours[l.id] ?? []).filter((h) => h.date === day).flatMap((h) => h.periods.map((p) => ({ l, p }))))
      .filter(({ p }) => d > 0 || minutesOf(p.open) > min)
      .sort((x, y) => minutesOf(x.p.open) - minutesOf(y.p.open))[0];
    if (opens) return sentence(`${opens.l.name} opens ${relDay(date, day)} at ${time12(opens.p.open)}`);
  }
  const closed = feed.hours[feed.locations[0]?.id ?? '']?.find((h) => h.closedReason)?.closedReason;
  return closed ? `Campus dining is closed: ${closed}.` : undefined;
}

export function freeFoodMessage(a: Advocate, sid: string): OutboundMessage {
  const feed = feedFor(a, sid);
  if (!feed || feed.unknown.some((u) => u.startsWith('events'))) return cantSee(sid, 'campus events', [{ label: 'Food help near me', action: 'need:food' }]);
  const { date } = a.localNow();
  const ev = feed.events.filter((e) => e.tags.includes('free-food')).slice(0, 4);
  if (!ev.length) return msg(sid, 'I don\'t see free food events on campus this week.', [{ label: 'Food help near me', action: 'need:food' }, back]);
  return msg(
    sid,
    `Free food on campus this week:\n${ev.map((e) => `- ${sentence(`${relDay(date, e.date)} ${time12(e.start)}: ${e.title}, ${e.where}`)}`).join('\n')}`,
    [...ev.slice(0, 2).map((e) => ({ label: `Add ${relDay(date, e.date)}'s to my dates`, action: `add-date:${e.date}:${encodeURIComponent(e.title)}` })), back],
    'navigator',
    'From the campus events calendar.',
  );
}

// ---------- study spots (CL-3) ----------

export function studySpotsMessage(a: Advocate, sid: string): OutboundMessage {
  const feed = feedFor(a, sid);
  if (!feed || feed.unknown.some((u) => u.startsWith('spaces'))) return cantSee(sid, 'study spaces', []);
  const { date, min } = a.localNow();
  const wd = weekday(date);
  const open = feed.spaces.filter((s) => {
    const h = s.hours[wd];
    return h && min >= minutesOf(h[0]) && min < minutesOf(h[1]);
  });
  const sorted = [...open].sort((x, y) => Number(y.noise === 'quiet') - Number(x.noise === 'quiet') || y.seats - x.seats);
  const room = feed.spaces.find((s) => s.bookable);
  const steps: NextStep[] = [];
  if (room) {
    const slot = nextSlot(room.hours, date, min);
    if (slot) steps.push({ label: `Book ${room.name}, ${relDay(date, slot.date)} ${time12(slot.start)}`, action: `book-room:${room.id}:${slot.date}:${slot.start}:60` });
  }
  if (!sorted.length) return msg(sid, 'No study space on campus is open right now.', [...steps, back], 'navigator', 'From posted building hours.');
  return msg(sid, `Open now:\n${sorted.slice(0, 3).map((s) => `- ${s.name}, ${s.building}. ${s.noise === 'quiet' ? 'Quiet' : 'Good for groups'}.${s.outlets ? ' Has plugs.' : ''} ${sentence(`Open until ${time12(s.hours[wd]![1])}`)}`).join('\n')}`, [...steps, back], 'navigator', 'From posted building hours.');
}

/** The next whole hour the room is open for an hour, today or in the next week. */
function nextSlot(hours: Record<string, [string, string]>, date: string, min: number): { date: string; start: string } | undefined {
  for (let d = 0; d < 7; d++) {
    const day = addDays(date, d);
    const h = hours[weekday(day)];
    if (!h) continue;
    let start = Math.max(minutesOf(h[0]), d === 0 ? Math.ceil((min + 1) / 60) * 60 : 0);
    start = Math.ceil(start / 60) * 60;
    if (start + 60 <= minutesOf(h[1])) return { date: day, start: `${String(start / 60).padStart(2, '0')}:00` };
  }
  return undefined;
}

export function bookRoom(a: Advocate, sid: string, arg: string): OutboundMessage {
  const [room, date, start, mins] = arg.split(':').length === 5 ? (() => { const p = arg.split(':'); return [p[0]!, p[1]!, `${p[2]}:${p[3]}`, p[4]!]; })() : [];
  const feed = a.campusFeed(a.student(sid).enrollment.college);
  const space = feed?.spaces.find((s) => s.id === room && s.bookable);
  if (!space || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !start || !/^\d{2}:\d{2}$/.test(start)) return msg(sid, 'I could not tell which room or time you meant.', [{ label: 'Study spots', action: 'study-spots' }, back]);
  const d = a.operator.queue({ studentId: sid, kind: 'room-booking', request: { room: space.id, date, start, minutes: Number(mins) || 60, name: a.student(sid).chosenName } }, a.clock());
  a.ledger.append(sid, 'approve', `booking:${d.id}`, { room: space.id, date, start });
  const status = d.status === 'confirmed' ? 'It is confirmed.' : d.status === 'refused' ? `It did not go through: ${d.result?.reason ?? 'refused'}.` : 'I will tell you when it is confirmed.';
  return msg(sid, `${sentence(`I asked to book ${space.name} ${relDay(a.localNow().date, date)} at ${time12(start)}`)} ${status}`, [{ label: 'Study spots', action: 'study-spots' }, back], 'navigator', 'A booking is not done until the room system confirms it.');
}

// ---------- getting there (HH-1) ----------

const describe = (it: ItineraryT, stopName: (id: string) => string) => {
  const [first, second] = it.legs;
  const ride = second ? `Take Route ${first!.route} to ${stopName(first!.to)}, then Route ${second.route}.` : `Take Route ${first!.route}.`;
  return `${sentence(`leave ${stopName(first!.from)} at ${time12(it.depart)}`)} ${ride} ${sentence(`You get there at ${time12(it.arrive)}`)}`;
};

export function leaveByMessage(a: Advocate, sid: string): OutboundMessage {
  const { mode, homeStop } = a.commuteSettings(sid);
  const feed = feedFor(a, sid);
  const stopName = (id: string) => feed?.stops.find((s) => s.id === id)?.name ?? id;
  if (mode !== 'bus' || !homeStop) {
    const choices = (feed?.stops ?? []).filter((s) => !s.campus).slice(0, 4);
    if (!choices.length) return cantSee(sid, 'bus stops', []);
    return msg(sid, 'Which bus stop do you leave from? I will plan your trips to class from there.', [...choices.map((s) => ({ label: s.name, action: `set-stop:${s.id}` })), back]);
  }
  const { date, min } = a.localNow();
  const plans = a.commutePlans(sid).filter((p) => p.date > date || (p.date === date && minutesOf(p.itineraries[0]?.depart ?? '00:00') >= min - 5));
  const p = plans[0];
  if (!p) return msg(sid, `I don't have a bus plan for your next class yet. I check every morning.`, [{ label: 'Next bus', action: 'next-bus' }, back]);
  if (!p.itineraries.length) return msg(sid, sentence(`No bus gets you to ${p.course} by ${time12(p.classStart)} ${relDay(date, p.date)}${p.notice ? `. ${p.notice}` : ''}`), [{ label: 'Find a ride', action: 'need:transportation' }, back]);
  const it = p.itineraries[0]!;
  const now = a.transitNow(sid);
  const firstTrip = it.legs[0]!.trip;
  const late = now?.arrivals.find((x) => x.trip === firstTrip && x.delayMinutes > 0);
  const lateLine = late ? `\nRoute ${late.route} is running ${late.delayMinutes} minutes late right now.` : '';
  const alert = now?.alerts[0] ? `\n${sentence(now.alerts[0].header)}` : '';
  const willBeLate = late && minutesOf(it.arrive) + late.delayMinutes > minutesOf(p.classStart);
  const steps: NextStep[] = willBeLate ? [{ label: 'Tell my instructor I may be late', action: `draft:late:${encodeURIComponent(p.course)}` }, { label: 'Next bus', action: 'next-bus' }, back] : [{ label: 'Next bus', action: 'next-bus' }, { label: 'Change my stop', action: 'set-stop:' }, back];
  return msg(sid, `For ${p.course} ${relDay(date, p.date)} at ${time12(p.classStart)}: ${describe(it, stopName)}${lateLine}${alert}`, steps, 'chief-of-staff', 'From the transit trip planner, ten minutes before class.');
}

export function nextBusMessage(a: Advocate, sid: string): OutboundMessage {
  const { homeStop } = a.commuteSettings(sid);
  if (!homeStop) return leaveByMessage(a, sid);
  const now = a.transitNow(sid);
  const feed = feedFor(a, sid);
  const name = feed?.stops.find((s) => s.id === homeStop)?.name ?? homeStop;
  if (!now || a.clock().getTime() - Date.parse(now.at) > 10 * 60_000) return msg(sid, `I don't have live times for ${name} right now.`, [{ label: 'When should I leave?', action: 'leave-by' }, back], 'navigator', 'Live times are only used when they are under ten minutes old.');
  if (!now.arrivals.length) return msg(sid, sentence(`No more buses at ${name} today${now.alerts[0] ? `. ${now.alerts[0].header}` : ''}`), [{ label: 'Find a ride', action: 'need:transportation' }, back]);
  return msg(sid, `Next buses at ${name}:\n${now.arrivals.slice(0, 3).map((x) => `- Route ${x.route} to ${x.headsign}: ${x.inMinutes} min${x.delayMinutes ? `, ${x.delayMinutes} late` : ''}.`).join('\n')}${now.alerts[0] ? `\n${sentence(now.alerts[0].header)}` : ''}`, [{ label: 'When should I leave?', action: 'leave-by' }, back], 'navigator', sentence(`Live times as of ${time12(a.localTime(now.at))}`));
}

// ---------- jobs that fit (CAR-2) and mentors (CAR-4) ----------

const overlaps = (p: PostingT, classes: ClassMeeting[], shifts: Shift[]) =>
  p.schedule.some((s) => classes.some((c) => c.days.includes(s.day) && minutesOf(s.start) < minutesOf(c.end) + 30 && minutesOf(c.start) - 30 < minutesOf(s.end)) || shifts.some((w) => weekday(w.date) === s.day && minutesOf(s.start) < minutesOf(w.end) && minutesOf(w.start) < minutesOf(s.end)));

export function jobsThatFit(a: Advocate, sid: string, opts: { fairChance?: boolean } = {}): PostingT[] {
  const feed = feedFor(a, sid);
  if (!feed) return [];
  const s = a.student(sid);
  const classes = a.store.list<ClassMeeting>('classes', sid);
  const shifts = a.store.list<Shift>('shifts', sid);
  return feed.postings
    .filter((p) => !overlaps(p, classes, shifts) && (!opts.fairChance || p.fairChance))
    .sort((x, y) => Number(!!s.enrollment.workStudy && y.workStudy) - Number(!!s.enrollment.workStudy && x.workStudy) || Number(y.onCampus) - Number(x.onCampus) || y.pay - x.pay);
}

const when = (p: PostingT) => (p.schedule.length ? p.schedule.map((s) => `${s.day} ${time12(s.start)} to ${time12(s.end)}`).join(', ') : 'flexible hours');

export function jobsMessage(a: Advocate, sid: string, opts: { fairChance?: boolean } = {}): OutboundMessage {
  const feed = feedFor(a, sid);
  if (!feed || feed.unknown.some((u) => u.startsWith('postings'))) return cantSee(sid, 'job postings', [{ label: 'Career help at my college', action: 'career' }]);
  const fit = jobsThatFit(a, sid, opts).slice(0, 3);
  if (!fit.length) return msg(sid, `No open posting fits around your classes and shifts right now${opts.fairChance ? ' from a fair-chance employer' : ''}.`, [{ label: 'Career help at my college', action: 'career' }, back]);
  return msg(
    sid,
    `${fit.length} ${fit.length === 1 ? 'job fits' : 'jobs fit'} around your classes and shifts:\n${fit.map((p) => `- ${sentence(`${p.title}, ${p.employer}: ${money(p.pay)} an hour, ${when(p)}${p.workStudy ? ', work-study' : ''}`)}`).join('\n')}`,
    [{ label: `Draft a note about ${fit[0]!.title}`, action: `draft:job:${fit[0]!.id}` }, { label: 'Talk to a mentor', action: 'mentors' }, back],
    'navigator',
    'Postings from the college job board, checked against your class and work times.',
  );
}

export function mentorsMessage(a: Advocate, sid: string): OutboundMessage {
  const feed = feedFor(a, sid);
  if (!feed || feed.unknown.some((u) => u.startsWith('mentors'))) return cantSee(sid, 'the mentor list', [{ label: 'Career help at my college', action: 'career' }]);
  const s = a.student(sid);
  const mine = new Set(s.communities ?? []);
  const ranked = feed.mentors
    .filter((m) => m.openSlots > 0 && (s.dial.language === 'en' || m.languages.includes(s.dial.language)))
    .map((m) => ({ m, shared: m.experiences.filter((e) => mine.has(e)).length }))
    .sort((x, y) => y.shared - x.shared || y.m.openSlots - x.m.openSlots)
    .slice(0, 3);
  if (!ranked.length) return msg(sid, 'No mentor has an open spot right now. I will look again next week.', [{ label: 'Career help at my college', action: 'career' }, back]);
  return msg(
    sid,
    `Mentors with time for you:\n${ranked.map(({ m }) => `- ${m.displayName}, ${m.role}.`).join('\n')}\nIf you want an introduction, I will draft it. Only your first name and what you want to talk about are shared.`,
    [...ranked.slice(0, 2).map(({ m }) => ({ label: `Meet ${m.displayName}`, action: `mentor-intro:${m.id}` })), back],
    'navigator',
    'Volunteers from the college mentor list. You choose; nothing is shared until you send it.',
  );
}

export { shortDate };
