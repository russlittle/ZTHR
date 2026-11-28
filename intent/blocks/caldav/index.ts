/**
 * CalDAV (RFC 4791) over the dav block's XML reader and multistatus writer, with the calendars themselves read and
 * written by the icalendar block and recurrence worked out by the time block. It holds calendar collections in a
 * store and answers the HTTP methods a calendar app sends: MKCALENDAR, PROPFIND, PROPPATCH (display name and
 * description), PUT and DELETE with ETag preconditions, GET, and POST of a scheduling message to an inbox.
 *
 * Reports: calendar-query (comp-filter, prop-filter, param-filter, text-match with i;ascii-casemap and i;octet,
 * is-not-defined and time-range, where a time range is tested against recurring events by expanding them, and
 * VALARM against the time its alarm fires), calendar-multiget, free-busy-query (merged BUSY and BUSY-TENTATIVE
 * periods, transparent and cancelled events left out), and sync-collection (RFC 6578). Each collection has a ctag
 * that changes with every change and a sync token naming a position in a change log; a token older than the log
 * kept is refused with DAV:valid-sync-token so the client lists everything again. calendar-data may ask for recurring
 * events expanded into single instances (RFC 4791 9.6.5).
 *
 * Writes enforce the RFC's preconditions with the DAV error elements: supported-calendar-data, valid-calendar-object-
 * resource (one UID, one kind of component, no METHOD), supported-calendar-component, no-uid-conflict (naming the
 * resource that has it), and max-resource-size. The scheduling inbox (RFC 6638) accepts iTIP REQUEST, CANCEL and
 * REPLY messages addressed to its owner, refuses repeats and out-of-date sequences, and `processInbox` applies them
 * to a calendar: a request creates or updates the event, a cancel marks it cancelled, a reply sets the attendee's
 * participation status on the organiser's copy.
 *
 * Out of scope: authentication and access control (the caller decides who may reach which path), principals and
 * calendar-home discovery, sending mail for invitations, and VTODO/VJOURNAL time-range beyond the RFC's start/due rules.
 */
import { createHash } from 'node:crypto';
import { BadXml, DAV, child, children, depth as davDepth, el, parseXml, propfindRequest, writeXml } from '../dav/index.ts';
import type { El, Out } from '../dav/index.ts';
import { BadCalendar, alarmTimes, all, buildEvent, expandCalendar, first, formatDateValue, instantOf, param, parseComponents, parseDateValue, prop, readEvent, writeComponent, zonesOf } from '../icalendar/index.ts';
import type { Component, Event } from '../icalendar/index.ts';

export const CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const CS = 'http://calendarserver.org/ns/';
const PREFIXES = { [DAV]: 'd', [CALDAV]: 'c', [CS]: 'cs' };

export class DavError extends Error {
  readonly status: number;
  readonly precondition: { ns: string; name: string; href?: string } | undefined;
  constructor(status: number, message: string, precondition?: { ns: string; name: string; href?: string }) {
    super(message);
    this.status = status;
    this.precondition = precondition;
  }
}

export interface Resource {
  readonly name: string;
  readonly ics: string;
  readonly etag: string;
  readonly uid: string;
  readonly kind: 'VEVENT' | 'VTODO' | 'VJOURNAL' | 'VFREEBUSY';
  readonly modified: number;
}

export interface Collection {
  readonly path: string;
  displayName: string;
  description?: string;
  /** Component kinds that may be stored here. */
  readonly components: readonly string[];
  readonly kind: 'calendar' | 'inbox';
  readonly resources: Map<string, Resource>;
  seq: number;
  readonly log: { seq: number; name: string; deleted: boolean }[];
  logFloor: number;
}

export interface Request { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }
export interface Reply { readonly status: number; readonly headers: Record<string, string>; readonly body: string }

export interface CalDavOptions {
  readonly now?: () => number;
  /** Largest calendar object accepted (default 1 MB). */
  readonly maxResourceBytes?: number;
  /** How many changes each collection remembers for sync (default 1000). */
  readonly logSize?: number;
  /** Where collections live; requests outside it get 404 (default /calendars/). */
  readonly base?: string;
}

const etagOf = (ics: string) => `"${createHash('sha256').update(ics).digest('hex').slice(0, 16)}"`;
const KINDS = ['VEVENT', 'VTODO', 'VJOURNAL', 'VFREEBUSY'];

const rfc = (d: Date) => formatDateValue({ kind: 'utc', at: d }).value;
const parseRange = (e: El): { from: Date; to: Date } => {
  const s = e.attrs.start, t = e.attrs.end;
  const f = (v: string | undefined) => { if (!v || !/^\d{8}T\d{6}Z$/.test(v)) throw new DavError(400, 'time-range start and end must be UTC date-times like 20260601T000000Z'); return new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15))); };
  const from = s ? f(s) : new Date(-8.64e15), to = t ? f(t) : new Date(8.64e15);
  if (from >= to) throw new DavError(400, 'time-range end must be after start');
  return { from, to };
};

export class CalDav {
  readonly #cols = new Map<string, Collection>();
  readonly #o: Required<CalDavOptions>;
  readonly #seen = new Map<string, number>();

  constructor(o: CalDavOptions = {}) {
    this.#o = { now: o.now ?? Date.now, maxResourceBytes: o.maxResourceBytes ?? 1_000_000, logSize: o.logSize ?? 1000, base: (o.base ?? '/calendars/').replace(/\/?$/, '/') };
  }

  /** Create a collection directly (a home set's inbox, or in tests). */
  create(path: string, o: { displayName?: string; kind?: 'calendar' | 'inbox'; components?: readonly string[]; description?: string } = {}): Collection {
    const p = this.#colPath(path);
    if (this.#cols.has(p)) throw new DavError(405, `${p} already exists`);
    const c: Collection = { path: p, displayName: o.displayName ?? p.split('/').filter(Boolean).at(-1)!, ...(o.description ? { description: o.description } : {}), components: o.components ?? ['VEVENT', 'VTODO'], kind: o.kind ?? 'calendar', resources: new Map(), seq: 0, log: [], logFloor: 0 };
    this.#cols.set(p, c);
    return c;
  }

  collection(path: string): Collection {
    const c = this.#cols.get(this.#colPath(path));
    if (!c) throw new DavError(404, `no calendar at ${path}`);
    return c;
  }

  #colPath(path: string): string {
    const p = path.endsWith('/') ? path : `${path}/`;
    if (!p.startsWith(this.#o.base) || p.includes('..') || p.includes('//') || p.length > 512 || /[\u0000-\u001f\\]/.test(p)) throw new DavError(404, 'not a calendar path');
    return p;
  }

  #split(path: string): { col: Collection; name: string | undefined } {
    if (path.endsWith('/')) return { col: this.collection(path), name: undefined };
    const i = path.lastIndexOf('/');
    return { col: this.collection(path.slice(0, i + 1)), name: path.slice(i + 1) };
  }

  #bump(c: Collection, name: string, deleted: boolean) {
    c.seq++;
    c.log.push({ seq: c.seq, name, deleted });
    while (c.log.length > this.#o.logSize) { c.logFloor = c.log.shift()!.seq; }
  }

  ctag(c: Collection): string { return `${c.path}@${c.seq}`; }
  syncToken(c: Collection): string { return `urn:caldav-sync:${c.seq}`; }

  // --- store ---------------------------------------------------------------------------------------------------

  /** Validate and store a calendar object. Returns what the HTTP answer needs. */
  put(path: string, ics: string, o: { ifMatch?: string; ifNoneMatch?: string } = {}): { status: 201 | 204; etag: string } {
    const { col, name } = this.#split(path);
    if (!name || !/^[A-Za-z0-9._@=+-]{1,200}\.ics$/.test(name)) throw new DavError(403, 'a calendar object must be a file ending .ics with a plain name');
    if (Buffer.byteLength(ics) > this.#o.maxResourceBytes) throw new DavError(403, `larger than ${this.#o.maxResourceBytes} bytes`, { ns: CALDAV, name: 'max-resource-size' });
    const cur = col.resources.get(name);
    if (o.ifNoneMatch === '*' && cur) throw new DavError(412, 'the resource exists');
    if (o.ifMatch !== undefined && (!cur || (o.ifMatch !== '*' && o.ifMatch !== cur.etag))) throw new DavError(412, 'the resource has changed');
    const r = this.#validate(col, name, ics);
    for (const other of col.resources.values()) if (other.uid === r.uid && other.name !== name) throw new DavError(403, `UID ${r.uid} is used by ${other.name}`, { ns: CALDAV, name: 'no-uid-conflict', href: `${col.path}${other.name}` });
    col.resources.set(name, r);
    this.#bump(col, name, false);
    return { status: cur ? 204 : 201, etag: r.etag };
  }

  #validate(col: Collection, name: string, ics: string): Resource {
    let cal: Component;
    try { cal = parseComponents(ics, { maxBytes: this.#o.maxResourceBytes })[0]!; } catch (e) { throw new DavError(403, `not a calendar object: ${(e as Error).message}`, { ns: CALDAV, name: 'supported-calendar-data' }); }
    if (first(cal, 'VERSION')?.value !== '2.0') throw new DavError(403, 'VERSION must be 2.0', { ns: CALDAV, name: 'supported-calendar-data' });
    const bad = (why: string) => new DavError(403, why, { ns: CALDAV, name: 'valid-calendar-object-resource' });
    if (!first(cal, 'PRODID')) throw bad('PRODID is required');
    if (first(cal, 'METHOD') && col.kind === 'calendar') throw bad('a stored calendar object must not have a METHOD');
    const parts = cal.components.filter((c) => c.name !== 'VTIMEZONE');
    if (parts.length === 0) throw bad('there is no event, todo or journal in it');
    const kind = parts[0]!.name;
    if (!KINDS.includes(kind)) throw bad(`${kind} cannot be stored`);
    if (parts.some((p) => p.name !== kind)) throw bad('all components must be of the same kind');
    const uids = new Set(parts.map((p) => first(p, 'UID')?.value));
    if (uids.size !== 1 || uids.has(undefined)) throw bad('every component needs the same UID');
    if (!col.components.includes(kind)) throw new DavError(403, `${kind} is not allowed in ${col.displayName}`, { ns: CALDAV, name: 'supported-calendar-component' });
    if (kind === 'VEVENT' || kind === 'VTODO') {
      try { for (const p of parts) readEvent(p); } catch (e) { throw bad((e as Error).message); }
    }
    return { name, ics, etag: etagOf(ics), uid: [...uids][0]!, kind: kind as Resource['kind'], modified: this.#o.now() };
  }

  delete(path: string, o: { ifMatch?: string } = {}): void {
    const { col, name } = this.#split(path);
    const cur = name ? col.resources.get(name) : undefined;
    if (!name) { this.#cols.delete(col.path); return; }
    if (!cur) throw new DavError(404, 'no such object');
    if (o.ifMatch !== undefined && o.ifMatch !== '*' && o.ifMatch !== cur.etag) throw new DavError(412, 'the resource has changed');
    col.resources.delete(name);
    this.#bump(col, name, true);
  }

  get(path: string): Resource {
    const { col, name } = this.#split(path);
    const r = name ? col.resources.get(name) : undefined;
    if (!r) throw new DavError(404, 'no such object');
    return r;
  }

  // --- properties ----------------------------------------------------------------------------------------------

  #collectionProps(c: Collection, want: readonly { ns: string; name: string }[] | 'all'): { found: Out[]; missing: Out[] } {
    const all: Record<string, Out> = {
      '{DAV:}resourcetype': el(DAV, 'resourcetype', [el(DAV, 'collection'), el(CALDAV, c.kind === 'inbox' ? 'schedule-inbox' : 'calendar')]),
      '{DAV:}displayname': el(DAV, 'displayname', c.displayName),
      '{DAV:}sync-token': el(DAV, 'sync-token', this.syncToken(c)),
      [`{${CS}}getctag`]: el(CS, 'getctag', this.ctag(c)),
      [`{${CALDAV}}supported-calendar-component-set`]: el(CALDAV, 'supported-calendar-component-set', c.components.map((n) => el(CALDAV, 'comp', undefined, { name: n }))),
      '{DAV:}supported-report-set': el(DAV, 'supported-report-set', ['calendar-query', 'calendar-multiget', 'free-busy-query'].map((n) => el(DAV, 'supported-report', [el(DAV, 'report', [el(CALDAV, n)])])).concat([el(DAV, 'supported-report', [el(DAV, 'report', [el(DAV, 'sync-collection')])])])),
      [`{${CALDAV}}max-resource-size`]: el(CALDAV, 'max-resource-size', String(this.#o.maxResourceBytes)),
    };
    if (c.description) all[`{${CALDAV}}calendar-description`] = el(CALDAV, 'calendar-description', c.description);
    if (want === 'all') return { found: Object.values(all), missing: [] };
    const found: Out[] = [], missing: Out[] = [];
    for (const w of want) { const o = all[`{${w.ns}}${w.name}`]; (o ? found : missing).push(o ?? el(w.ns, w.name)); }
    return { found, missing };
  }

  #resourceProps(c: Collection, r: Resource, want: readonly { ns: string; name: string }[] | 'all', data?: El): { found: Out[]; missing: Out[] } {
    const mk = (n: string, ns: string): Out | undefined => {
      if (ns === DAV && n === 'getetag') return el(DAV, 'getetag', r.etag);
      if (ns === DAV && n === 'getcontenttype') return el(DAV, 'getcontenttype', `text/calendar; charset=utf-8; component=${r.kind}`);
      if (ns === DAV && n === 'getcontentlength') return el(DAV, 'getcontentlength', String(Buffer.byteLength(r.ics)));
      if (ns === DAV && n === 'getlastmodified') return el(DAV, 'getlastmodified', new Date(r.modified).toUTCString());
      if (ns === DAV && n === 'resourcetype') return el(DAV, 'resourcetype');
      if (ns === CALDAV && n === 'calendar-data') return el(CALDAV, 'calendar-data', this.#calendarData(r, data));
      return undefined;
    };
    if (want === 'all') return { found: ['getetag', 'getcontenttype', 'getcontentlength', 'getlastmodified', 'resourcetype'].map((n) => mk(n, DAV)!), missing: [] };
    const found: Out[] = [], missing: Out[] = [];
    for (const w of want) { const o = mk(w.name, w.ns); (o ? found : missing).push(o ?? el(w.ns, w.name)); }
    return { found, missing };
  }

  #calendarData(r: Resource, spec?: El): string {
    const ex = spec && child(spec, CALDAV, 'expand');
    if (!ex) return r.ics;
    const range = parseRange(ex);
    const cal = parseComponents(r.ics)[0]!;
    const parts = expandCalendar(cal, range).map((i) => buildEvent({ ...i.event, rrule: undefined as never, rdates: [], exdates: [], start: { kind: 'utc', at: i.start }, ...(i.event.end || i.event.duration ? { end: { kind: 'utc' as const, at: i.end }, duration: undefined as never } : {}), recurrenceId: { kind: 'utc', at: i.recurrenceId ?? i.start } }));
    return writeComponent({ name: 'VCALENDAR', properties: cal.properties.filter((p) => p.name !== 'METHOD'), components: parts });
  }

  // --- filters -------------------------------------------------------------------------------------------------

  #collate(el_: El | undefined): (s: string) => string {
    const c = el_?.attrs.collation ?? 'i;ascii-casemap';
    if (c === 'i;octet') return (s) => s;
    if (c === 'i;ascii-casemap') return (s) => s.replace(/[a-z]/g, (x) => x.toUpperCase());
    throw new DavError(403, `collation ${c} is not supported`, { ns: CALDAV, name: 'supported-collation' });
  }

  #textMatch(tm: El, value: string | undefined): boolean {
    if (value === undefined) return tm.attrs['negate-condition'] === 'yes';
    const f = this.#collate(tm);
    const hit = f(value).includes(f(tm.text));
    return tm.attrs['negate-condition'] === 'yes' ? !hit : hit;
  }

  #matchProp(pf: El, comp: Component): boolean {
    const name = (pf.attrs.name ?? '').toUpperCase();
    const props = all(comp, name);
    if (child(pf, CALDAV, 'is-not-defined')) return props.length === 0;
    if (props.length === 0) return false;
    return props.some((p) => {
      const tm = child(pf, CALDAV, 'text-match');
      if (tm && !this.#textMatch(tm, p.value)) return false;
      const tr = child(pf, CALDAV, 'time-range');
      if (tr) {
        const { from, to } = parseRange(tr);
        try { const t = instantOf(parseDateValue(p.value, param(p, 'TZID'), param(p, 'VALUE') === 'DATE'), () => undefined); if (!(t >= from && t < to)) return false; } catch { return false; }
      }
      for (const pm of children(pf, CALDAV, 'param-filter')) {
        const pn = (pm.attrs.name ?? '').toUpperCase();
        const v = p.params[pn]?.[0];
        if (child(pm, CALDAV, 'is-not-defined')) { if (v !== undefined) return false; continue; }
        if (v === undefined) return false;
        const t2 = child(pm, CALDAV, 'text-match');
        if (t2 && !this.#textMatch(t2, v)) return false;
      }
      return true;
    });
  }

  #matchComp(cf: El, comp: Component | undefined, ctx: { zonesCal: Component }): boolean {
    if (child(cf, CALDAV, 'is-not-defined')) return comp === undefined;
    if (!comp) return false;
    const tr = child(cf, CALDAV, 'time-range');
    if (tr) {
      const range = parseRange(tr);
      if (comp.name === 'VEVENT') { const uid = first(comp, 'UID')?.value; if (!expandCalendar(ctx.zonesCal, range).some((i) => i.uid === uid && i.event.kind === 'VEVENT')) return false; }
      else if (comp.name === 'VTODO') { if (!this.#todoInRange(comp, range)) return false; }
      else if (comp.name === 'VALARM') { /* checked by the parent */ }
      else throw new DavError(403, `a time range cannot be applied to ${comp.name}`, { ns: CALDAV, name: 'supported-filter' });
    }
    for (const pf of children(cf, CALDAV, 'prop-filter')) if (!this.#matchProp(pf, comp)) return false;
    for (const sub of children(cf, CALDAV, 'comp-filter')) {
      const n = (sub.attrs.name ?? '').toUpperCase();
      const candidates = comp.components.filter((c) => c.name === n);
      if (n === 'VALARM' && child(sub, CALDAV, 'time-range')) {
        const range = parseRange(child(sub, CALDAV, 'time-range')!);
        const uid = first(comp, 'UID')?.value;
        const fires = expandCalendar(ctx.zonesCal, { from: new Date(range.from.getTime() - 400 * 86_400_000), to: new Date(range.to.getTime() + 400 * 86_400_000) }).filter((i) => i.uid === uid).flatMap((i) => alarmTimes(i));
        if (!fires.some((a) => a.at >= range.from && a.at < range.to)) return false;
        continue;
      }
      if (child(sub, CALDAV, 'is-not-defined')) { if (candidates.length) return false; continue; }
      if (!candidates.some((c) => this.#matchComp(sub, c, ctx))) return false;
    }
    return true;
  }

  /** RFC 4791 9.9: when a todo falls in a range, from its start, due, completed and created. */
  #todoInRange(comp: Component, r: { from: Date; to: Date }): boolean {
    const t = readEvent(comp);
    const z = zonesOf({ name: 'VCALENDAR', properties: [], components: [] });
    const at = (v: Event['start']) => (v ? instantOf(v, z) : undefined);
    const start = at(t.start), due = at(t.end);
    if (start && due) return (r.from < due || r.from <= start) && (r.to > start || r.to >= due);
    if (start) return r.from <= start && r.to > start;
    if (due) return r.from < due && r.to >= due;
    if (t.completed) return r.from <= t.completed && r.to >= t.completed;
    return true;
  }

  #matchFilter(filter: El, r: Resource): boolean {
    const top = child(filter, CALDAV, 'comp-filter');
    if (!top || (top.attrs.name ?? '').toUpperCase() !== 'VCALENDAR') throw new DavError(400, 'the filter must start with a comp-filter for VCALENDAR');
    const cal = parseComponents(r.ics)[0]!;
    return this.#matchComp(top, cal, { zonesCal: cal });
  }

  // --- reports -------------------------------------------------------------------------------------------------

  report(path: string, body: string): { status: number; body: string } {
    const root = parseXml(body);
    const col = this.collection(path);
    const wantOf = (): { want: readonly { ns: string; name: string }[] | 'all'; data: El | undefined } => {
      const p = child(root, DAV, 'prop');
      if (!p) return { want: [{ ns: DAV, name: 'getetag' }], data: undefined };
      return { want: p.children.map((c) => ({ ns: c.ns, name: c.name })), data: child(p, CALDAV, 'calendar-data') };
    };
    const respFor = (r: Resource) => { const { want, data } = wantOf(); const { found, missing } = this.#resourceProps(col, r, want, data); return propstatResponse(`${col.path}${r.name}`, found, missing); };
    if (root.ns === CALDAV && root.name === 'calendar-query') {
      const filter = child(root, CALDAV, 'filter');
      if (!filter) throw new DavError(400, 'calendar-query needs a filter');
      const out = [...col.resources.values()].filter((r) => this.#matchFilter(filter, r)).sort((a, b) => a.name.localeCompare(b.name)).map(respFor);
      return { status: 207, body: writeXml(el(DAV, 'multistatus', out), PREFIXES) };
    }
    if (root.ns === CALDAV && root.name === 'calendar-multiget') {
      const out: Out[] = [];
      for (const h of children(root, DAV, 'href')) {
        let href: string;
        try { href = decodeURIComponent(h.text.trim()); } catch { throw new DavError(400, 'a href is not valid'); }
        const name = href.startsWith(col.path) ? href.slice(col.path.length) : undefined;
        const r = name && !name.includes('/') ? col.resources.get(name) : undefined;
        out.push(r ? respFor(r) : el(DAV, 'response', [el(DAV, 'href', h.text.trim()), el(DAV, 'status', 'HTTP/1.1 404 Not Found')]));
      }
      return { status: 207, body: writeXml(el(DAV, 'multistatus', out), PREFIXES) };
    }
    if (root.ns === CALDAV && root.name === 'free-busy-query') {
      const tr = child(root, CALDAV, 'time-range');
      if (!tr) throw new DavError(400, 'free-busy-query needs a time-range');
      return { status: 200, body: this.freeBusy(col, parseRange(tr)) };
    }
    if (root.ns === DAV && root.name === 'sync-collection') return this.#sync(col, root);
    throw new DavError(403, `report ${root.name} is not supported`, { ns: DAV, name: 'supported-report' });
  }

  /** A VFREEBUSY for every event in a collection within a range. Transparent and cancelled events do not count. */
  freeBusy(col: Collection, range: { from: Date; to: Date }): string {
    const periods: { s: number; e: number; t: boolean }[] = [];
    for (const r of col.resources.values()) {
      if (r.kind !== 'VEVENT') continue;
      const cal = parseComponents(r.ics)[0]!;
      for (const i of expandCalendar(cal, range)) {
        const ev = i.event;
        if (ev.status === 'CANCELLED' || first(cal.components.find((c) => first(c, 'UID')?.value === i.uid) ?? cal, 'TRANSP')?.value.toUpperCase() === 'TRANSPARENT') continue;
        periods.push({ s: Math.max(i.start.getTime(), range.from.getTime()), e: Math.min(Math.max(i.end.getTime(), i.start.getTime() + 0), range.to.getTime()), t: ev.status === 'TENTATIVE' });
      }
    }
    const merged: { s: number; e: number; t: boolean }[] = [];
    for (const p of periods.filter((x) => x.e > x.s).sort((a, b) => a.s - b.s)) {
      const last = merged.at(-1);
      if (last && p.s <= last.e && p.t === last.t) last.e = Math.max(last.e, p.e);
      else merged.push({ ...p });
    }
    const props = [prop('DTSTART', rfc(range.from)), prop('DTEND', rfc(range.to)), prop('DTSTAMP', rfc(new Date(this.#o.now())))];
    for (const t of [false, true]) {
      const ps = merged.filter((m) => m.t === t).map((m) => `${rfc(new Date(m.s))}/${rfc(new Date(m.e))}`);
      if (ps.length) props.push(prop('FREEBUSY', ps.join(','), t ? { FBTYPE: 'BUSY-TENTATIVE' } : { FBTYPE: 'BUSY' }));
    }
    return writeComponent({ name: 'VCALENDAR', properties: [prop('VERSION', '2.0'), prop('PRODID', '-//ZTHR//caldav//EN')], components: [{ name: 'VFREEBUSY', properties: props, components: [] }] });
  }

  #sync(col: Collection, root: El): { status: number; body: string } {
    const token = child(root, DAV, 'sync-token')?.text.trim() ?? '';
    const m = /^urn:caldav-sync:(\d+)$/.exec(token);
    if (token && !m) throw new DavError(403, 'that sync token was not issued here', { ns: DAV, name: 'valid-sync-token' });
    const since = m ? Number(m[1]) : 0;
    if (since > col.seq || (since > 0 && since < col.logFloor)) throw new DavError(403, 'that sync token is too old or from the future; list the collection again', { ns: DAV, name: 'valid-sync-token' });
    const p = child(root, DAV, 'prop');
    const want = p ? p.children.map((c) => ({ ns: c.ns, name: c.name })) : [{ ns: DAV, name: 'getetag' }];
    const changed = new Map<string, boolean>();
    if (since === 0) for (const n of col.resources.keys()) changed.set(n, false);
    else for (const l of col.log) if (l.seq > since) changed.set(l.name, l.deleted);
    const limitEl = child(root, DAV, 'limit');
    const limit = limitEl ? Number(child(limitEl, DAV, 'nresults')?.text) : Infinity;
    const out: Out[] = [];
    for (const [name, deleted] of [...changed].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (out.length >= limit) throw new DavError(507, 'more changes than the limit; ask again from the returned token', { ns: DAV, name: 'number-of-matches-within-limits' });
      const r = col.resources.get(name);
      if (deleted || !r) { out.push(el(DAV, 'response', [el(DAV, 'href', `${col.path}${name}`), el(DAV, 'status', 'HTTP/1.1 404 Not Found')])); continue; }
      const { found, missing } = this.#resourceProps(col, r, want);
      out.push(propstatResponse(`${col.path}${name}`, found, missing));
    }
    return { status: 207, body: writeXml(el(DAV, 'multistatus', [...out, el(DAV, 'sync-token', this.syncToken(col))]), PREFIXES) };
  }

  // --- scheduling inbox ----------------------------------------------------------------------------------------

  /** Store an iTIP message in an inbox. Only messages for the inbox's owner, and not repeats or older ones. */
  deliver(inboxPath: string, owner: string, ics: string): { name: string } {
    const inbox = this.collection(inboxPath);
    if (inbox.kind !== 'inbox') throw new DavError(403, 'that is not a scheduling inbox');
    let cal: Component;
    try { cal = parseComponents(ics, { maxBytes: this.#o.maxResourceBytes })[0]!; } catch (e) { throw new DavError(400, (e as Error).message); }
    const method = first(cal, 'METHOD')?.value.toUpperCase();
    if (!method || !['REQUEST', 'CANCEL', 'REPLY'].includes(method)) throw new DavError(403, `scheduling method ${method ?? '(none)'} is not supported`, { ns: CALDAV, name: 'valid-scheduling-message' });
    const ev = cal.components.find((c) => c.name === 'VEVENT');
    const uid = ev && first(ev, 'UID')?.value;
    if (!ev || !uid) throw new DavError(403, 'the message has no event with a UID', { ns: CALDAV, name: 'valid-scheduling-message' });
    const mail = (v: string | undefined) => v?.replace(/^mailto:/i, '').toLowerCase();
    const organizer = mail(first(ev, 'ORGANIZER')?.value);
    const attendees = all(ev, 'ATTENDEE').map((a) => mail(a.value));
    const target = method === 'REPLY' ? organizer : undefined;
    if (method === 'REPLY' ? target !== owner.toLowerCase() : !attendees.includes(owner.toLowerCase())) throw new DavError(403, `the message is not addressed to ${owner}`, { ns: CALDAV, name: 'valid-scheduling-message' });
    const seq = Number(first(ev, 'SEQUENCE')?.value ?? 0);
    const key = `${inbox.path}|${method}|${uid}|${method === 'REPLY' ? attendees.join(',') : ''}`;
    const prev = this.#seen.get(key);
    if (prev !== undefined && seq <= prev) throw new DavError(403, `an equal or newer ${method} for ${uid} was already delivered`, { ns: CALDAV, name: 'valid-scheduling-message' });
    const name = `${method.toLowerCase()}-${createHash('sha1').update(`${uid}${seq}${method}${attendees.join()}`).digest('hex').slice(0, 12)}.ics`;
    const r = this.#validate(inbox, name, ics);
    inbox.resources.set(name, { ...r, uid: `${uid}#${method}#${seq}` });
    this.#bump(inbox, name, false);
    this.#seen.set(key, seq);
    return { name };
  }

  /** Apply every waiting message in an inbox to a calendar and remove them. Returns what was done. */
  processInbox(inboxPath: string, calendarPath: string): { name: string; did: string }[] {
    const inbox = this.collection(inboxPath), cal = this.collection(calendarPath);
    const done: { name: string; did: string }[] = [];
    for (const r of [...inbox.resources.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const msg = parseComponents(r.ics)[0]!;
      const method = first(msg, 'METHOD')!.value.toUpperCase();
      const ev = msg.components.find((c) => c.name === 'VEVENT')!;
      const uid = first(ev, 'UID')!.value;
      const seq = Number(first(ev, 'SEQUENCE')?.value ?? 0);
      const existing = [...cal.resources.values()].find((x) => x.uid === uid);
      const stored = (e: Component) => writeComponent({ name: 'VCALENDAR', properties: msg.properties.filter((p) => p.name !== 'METHOD'), components: [...msg.components.filter((c) => c.name === 'VTIMEZONE'), e] });
      let did = '';
      if (method === 'REQUEST') {
        const oldSeq = existing ? Number(first(parseComponents(existing.ics)[0]!.components.find((c) => c.name === 'VEVENT')!, 'SEQUENCE')?.value ?? 0) : -1;
        if (existing && seq <= oldSeq) did = `ignored: sequence ${seq} is not newer than ${oldSeq}`;
        else { this.put(`${cal.path}${existing?.name ?? `${safeName(uid)}.ics`}`, stored(ev)); did = existing ? 'updated' : 'created'; }
      } else if (method === 'CANCEL') {
        if (!existing) did = 'ignored: no such event';
        else { const old = parseComponents(existing.ics)[0]!; const oe = old.components.find((c) => c.name === 'VEVENT')!; const next: Component = { ...oe, properties: [...oe.properties.filter((p) => p.name !== 'STATUS' && p.name !== 'SEQUENCE'), prop('STATUS', 'CANCELLED'), prop('SEQUENCE', String(seq))] }; this.put(`${cal.path}${existing.name}`, writeComponent({ ...old, components: old.components.map((c) => (c === oe ? next : c)) })); did = 'cancelled'; }
      } else {
        const att = all(ev, 'ATTENDEE')[0];
        if (!existing || !att) did = 'ignored: no such event';
        else {
          const old = parseComponents(existing.ics)[0]!; const oe = old.components.find((c) => c.name === 'VEVENT')!;
          const who = att.value.toLowerCase();
          const ps = param(att, 'PARTSTAT') ?? 'NEEDS-ACTION';
          let hit = false;
          const props = oe.properties.map((p) => { if (p.name === 'ATTENDEE' && p.value.toLowerCase() === who) { hit = true; return { ...p, params: { ...p.params, PARTSTAT: [ps] } }; } return p; });
          if (!hit) did = 'ignored: not an attendee';
          else { this.put(`${cal.path}${existing.name}`, writeComponent({ ...old, components: old.components.map((c) => (c === oe ? { ...oe, properties: props } : c)) })); did = `${att.value.replace(/^mailto:/i, '')} is now ${ps}`; }
        }
      }
      inbox.resources.delete(r.name);
      this.#bump(inbox, r.name, true);
      done.push({ name: r.name, did });
    }
    return done;
  }

  // --- HTTP ----------------------------------------------------------------------------------------------------

  handle(req: Request): Reply {
    try {
      return this.#handle(req);
    } catch (e) {
      if (e instanceof DavError) {
        const body = e.precondition ? writeXml(el(DAV, 'error', [el(e.precondition.ns, e.precondition.name, e.precondition.href ? [el(DAV, 'href', e.precondition.href)] : undefined)]), PREFIXES) : e.message;
        return { status: e.status, headers: { 'content-type': e.precondition ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8' }, body };
      }
      if (e instanceof BadXml || e instanceof BadCalendar) return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: (e as Error).message };
      throw e;
    }
  }

  #handle(req: Request): Reply {
    const h = (n: string) => req.headers[n] ?? req.headers[n.toLowerCase()];
    const xml = (status: number, body: string): Reply => ({ status, headers: { 'content-type': 'application/xml; charset=utf-8' }, body });
    switch (req.method.toUpperCase()) {
      case 'OPTIONS': return { status: 200, headers: { dav: '1, 3, calendar-access, calendar-auto-schedule', allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR, POST' }, body: '' };
      case 'MKCALENDAR': {
        const p = this.#colPath(req.path);
        let name: string | undefined, desc: string | undefined, comps: string[] | undefined;
        if (req.body.trim()) {
          const r = parseXml(req.body);
          if (r.ns !== CALDAV || r.name !== 'mkcalendar') throw new DavError(400, 'the body is not a mkcalendar');
          const set = child(r, DAV, 'set'), pr = set && child(set, DAV, 'prop');
          name = pr && child(pr, DAV, 'displayname')?.text.trim();
          desc = pr && child(pr, CALDAV, 'calendar-description')?.text.trim();
          const cs = pr && child(pr, CALDAV, 'supported-calendar-component-set');
          if (cs) comps = children(cs, CALDAV, 'comp').map((c) => (c.attrs.name ?? '').toUpperCase());
          if (comps?.some((c) => !KINDS.includes(c))) throw new DavError(403, 'unsupported component', { ns: CALDAV, name: 'supported-calendar-component' });
        }
        this.create(p, { ...(name ? { displayName: name } : {}), ...(desc ? { description: desc } : {}), ...(comps?.length ? { components: comps } : {}) });
        return { status: 201, headers: { location: p }, body: '' };
      }
      case 'PROPFIND': {
        const { col, name } = this.#splitMaybeRes(req.path);
        const pr = propfindRequest(req.body);
        const want = pr.kind === 'prop' ? pr.props : 'all';
        const d = davDepth(h('depth'), 0);
        if (d === 'infinity') throw new DavError(403, 'Depth: infinity is not allowed', { ns: DAV, name: 'propfind-finite-depth' });
        const out: Out[] = [];
        if (name) { const r = col.resources.get(name); if (!r) throw new DavError(404, 'no such object'); const { found, missing } = this.#resourceProps(col, r, want); out.push(propstatResponse(`${col.path}${name}`, found, missing)); }
        else {
          const { found, missing } = this.#collectionProps(col, want);
          out.push(propstatResponse(col.path, found, missing));
          if (d === 1) for (const r of [...col.resources.values()].sort((a, b) => a.name.localeCompare(b.name))) { const f = this.#resourceProps(col, r, want); out.push(propstatResponse(`${col.path}${r.name}`, f.found, f.missing)); }
        }
        return xml(207, writeXml(el(DAV, 'multistatus', out), PREFIXES));
      }
      case 'PROPPATCH': {
        const col = this.collection(req.path);
        const r = parseXml(req.body);
        if (r.ns !== DAV || r.name !== 'propertyupdate') throw new DavError(400, 'the body is not a propertyupdate');
        for (const op of r.children) {
          const pr = child(op, DAV, 'prop');
          if (!pr) continue;
          for (const p of pr.children) {
            if (p.ns === DAV && p.name === 'displayname' && op.name === 'set') col.displayName = p.text.trim().slice(0, 200);
            else if (p.ns === CALDAV && p.name === 'calendar-description') { if (op.name === 'set') col.description = p.text.trim().slice(0, 2000); else delete col.description; }
            else throw new DavError(403, `${p.name} cannot be changed`, { ns: DAV, name: 'cannot-modify-protected-property' });
          }
        }
        return xml(207, writeXml(el(DAV, 'multistatus', [el(DAV, 'response', [el(DAV, 'href', col.path), el(DAV, 'status', 'HTTP/1.1 200 OK')])]), PREFIXES));
      }
      case 'REPORT': { const r = this.report(req.path, req.body); return xml(r.status, r.body); }
      case 'PUT': {
        const ct = (h('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (ct !== 'text/calendar') throw new DavError(415, 'the content type must be text/calendar');
        const r = this.put(req.path, req.body, { ...(h('if-match') ? { ifMatch: h('if-match')! } : {}), ...(h('if-none-match') ? { ifNoneMatch: h('if-none-match')! } : {}) });
        return { status: r.status, headers: { etag: r.etag }, body: '' };
      }
      case 'GET': case 'HEAD': { const r = this.get(req.path); return { status: 200, headers: { etag: r.etag, 'content-type': 'text/calendar; charset=utf-8' }, body: req.method.toUpperCase() === 'HEAD' ? '' : r.ics }; }
      case 'DELETE': this.delete(req.path, h('if-match') ? { ifMatch: h('if-match')! } : {}); return { status: 204, headers: {}, body: '' };
      case 'POST': {
        const col = this.collection(req.path);
        if (col.kind !== 'inbox') throw new DavError(403, 'POST is accepted only by a scheduling inbox');
        const owner = h('x-schedule-recipient');
        if (!owner) throw new DavError(400, 'say whose inbox this is with X-Schedule-Recipient');
        return { status: 201, headers: { location: `${col.path}${this.deliver(req.path, owner, req.body).name}` }, body: '' };
      }
      default: return { status: 405, headers: { allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR, POST' }, body: '' };
    }
  }

  #splitMaybeRes(path: string): { col: Collection; name: string | undefined } {
    if (this.#cols.has(path.endsWith('/') ? path : `${path}/`) && !path.endsWith('.ics')) return { col: this.collection(path), name: undefined };
    return this.#split(path);
  }
}

const safeName = (uid: string) => uid.replace(/[^A-Za-z0-9._@=+-]/g, '_').slice(0, 150) || 'event';

function propstatResponse(href: string, found: readonly Out[], missing: readonly Out[]): Out {
  const ps: Out[] = [];
  if (found.length) ps.push(el(DAV, 'propstat', [el(DAV, 'prop', found as Out[]), el(DAV, 'status', 'HTTP/1.1 200 OK')]));
  if (missing.length) ps.push(el(DAV, 'propstat', [el(DAV, 'prop', missing as Out[]), el(DAV, 'status', 'HTTP/1.1 404 Not Found')]));
  return el(DAV, 'response', [el(DAV, 'href', href), ...ps]);
}
