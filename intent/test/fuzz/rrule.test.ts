/** Fuzz: recurrence (blocks/time parseRule, occurrences) in zones with odd offsets and DST rules. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instant, occurrences, parseRule, wallOf, type Rule, type Wall } from '../../blocks/time/index.ts';
import { forAll, type Rand } from './harness.ts';

const ZONES = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu'] as const;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const LIMIT = 60;
const HORIZON_DAYS = 30 * 366;
const DAY = 86_400_000;

interface Case {
  readonly tz: string;
  readonly start: Wall;
  readonly rule: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const gen = (r: Rand, _i = 0, dupes = false): Case => {
  const tz = r.pick(ZONES);
  const y = r.int(2020, 2030);
  const m = r.int(1, 12);
  // Starts cluster on the hours the clocks change (1:00 to 3:00 local) and on month ends.
  const d = r.bool(0.3) ? dim(y, m) - r.int(0, 2) : r.int(1, dim(y, m));
  const h = r.bool(0.5) ? r.pick([1, 2, 2, 3, 0, 23]) : r.int(0, 23);
  const min = r.bool(0.6) ? r.pick([0, 15, 30, 45]) : r.int(0, 59);
  const freq = r.pick(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const);
  const parts = [`FREQ=${freq}`];
  if (r.bool(0.5)) parts.push(`INTERVAL=${r.int(1, 4)}`);
  const end = r.int(0, 2);
  if (end === 0) parts.push(`COUNT=${r.int(1, 60)}`);
  else if (end === 1) {
    const u = new Date(Date.UTC(y, m - 1, d) + r.int(0, 3 * 365) * DAY);
    const date = `${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}`;
    parts.push(`UNTIL=${r.pick([date, `${date}T${pad(r.int(0, 23))}${pad(r.pick([0, 30, 59]))}00`, `${date}T${pad(r.int(0, 23))}0000Z`])}`);
  }
  const byDay = (numbered: boolean) => {
    const items = r.array(1, 3, () => (numbered && r.bool(0.5) ? `${r.pick(['', '+', '-'])}${r.int(1, 5)}` : '') + r.pick(DAYS));
    return (dupes ? items : [...new Set(items)]).join(',');
  };
  const byMonthDay = () => r.array(1, 3, () => (r.bool(0.3) ? -r.int(1, 31) : r.int(1, 31))).join(',');
  if (freq === 'DAILY') {
    if (r.bool(0.4)) parts.push(`BYDAY=${byDay(false)}`);
    if (r.bool(0.3)) parts.push(`BYMONTHDAY=${byMonthDay()}`);
  } else if (freq === 'WEEKLY') {
    if (r.bool(0.7)) parts.push(`BYDAY=${byDay(false)}`);
    if (r.bool(0.2)) parts.push('WKST=MO');
  } else if (freq === 'MONTHLY') {
    if (r.bool(0.5)) parts.push(`BYDAY=${byDay(true)}`);
    if (r.bool(0.4)) parts.push(`BYMONTHDAY=${byMonthDay()}`);
  }
  return { tz, start: { y, m, d, h, min }, rule: parts.join(';') };
};

/** UTC day number of a calendar date. */
const dayNo = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY;
const ymd = (n: number) => {
  const t = new Date(n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
};

/** An independent expansion: walk every calendar day and ask whether the rule picks it. */
function reference(c: Case, rule: Rule): { dates: Date[]; horizon: number } {
  const s = c.start;
  const s0 = dayNo(s.y, s.m, s.d);
  const sDow = ymd(s0).dow;
  const monday = (n: number) => n - ((ymd(n).dow + 6) % 7);
  const until = rule.until ?? (rule.untilWall ? instant(rule.untilWall, c.tz) : undefined);
  const monthDays = (y: number, m: number) => (rule.byMonthDay ?? []).map((x) => (x < 0 ? dim(y, m) + x + 1 : x));
  const picks = (n: number): boolean => {
    const { y, m, d, dow } = ymd(n);
    const months = (y - s.y) * 12 + (m - s.m);
    switch (rule.freq) {
      case 'DAILY':
        return (n - s0) % rule.interval === 0 && (!rule.byDay || rule.byDay.some((b) => b.day === dow)) && (!rule.byMonthDay || monthDays(y, m).includes(d));
      case 'WEEKLY':
        return ((monday(n) - monday(s0)) / 7) % rule.interval === 0 && (rule.byDay ? rule.byDay.some((b) => b.day === dow) : dow === sDow);
      case 'MONTHLY': {
        if (months % rule.interval !== 0) return false;
        if (rule.byDay?.length) {
          const nth = Math.floor((d - 1) / 7) + 1;
          const nthFromEnd = -(Math.floor((dim(y, m) - d) / 7) + 1);
          const dayOk = rule.byDay.some((b) => b.day === dow && (b.n === undefined || b.n === nth || b.n === nthFromEnd));
          return dayOk && (!rule.byMonthDay || monthDays(y, m).includes(d));
        }
        return rule.byMonthDay ? monthDays(y, m).includes(d) : d === s.d;
      }
      case 'YEARLY':
        return (y - s.y) % rule.interval === 0 && m === s.m && d === s.d;
    }
  };
  const dates: Date[] = [];
  let produced = 0;
  for (let n = s0; n < s0 + HORIZON_DAYS; n++) {
    if (!picks(n)) continue;
    const { y, m, d } = ymd(n);
    const t = instant({ y, m, d, h: s.h, min: s.min }, c.tz);
    if (until && t > until) break;
    if (rule.count !== undefined && produced >= rule.count) break;
    produced++;
    dates.push(t);
    if (dates.length >= LIMIT) break;
  }
  return { dates, horizon: (s0 + HORIZON_DAYS) * DAY };
}

const sameWall = (a: Wall, b: Wall) => a.y === b.y && a.m === b.m && a.d === b.d && a.h === b.h && a.min === b.min;

test('random valid rules: strictly increasing, within COUNT and UNTIL, at the start wall time unless it does not exist, matching an independent expansion (80 cases)', async () => {
  await forAll('rrule occurrences', {
    cases: 80,
    gen,
    shrink: () => [],
    check: (c) => {
      const rule = parseRule(c.rule);
      const got = occurrences(c.start, c.tz, rule, { limit: LIMIT });
      for (let i = 1; i < got.length; i++) assert.ok(got[i]! > got[i - 1]!, `not strictly increasing at ${i}: ${got[i - 1]!.toISOString()} then ${got[i]!.toISOString()}`);
      if (rule.count !== undefined) assert.ok(got.length <= rule.count, `${got.length} occurrences for COUNT=${rule.count}`);
      const until = rule.until ?? (rule.untilWall ? instant(rule.untilWall, c.tz) : undefined);
      if (until) for (const t of got) assert.ok(t <= until, `${t.toISOString()} is after UNTIL ${until.toISOString()}`);
      for (const t of got) {
        const w = wallOf(t, c.tz);
        if (w.h === c.start.h && w.min === c.start.min) continue;
        // Only allowed when that wall time does not exist on that date (it falls in a DST gap).
        const asked = { y: w.y, m: w.m, d: w.d, h: c.start.h, min: c.start.min };
        assert.ok(!sameWall(wallOf(instant(asked, c.tz), c.tz), asked), `${t.toISOString()} reads ${w.h}:${pad(w.min)} in ${c.tz}, wanted ${c.start.h}:${pad(c.start.min)}, and that time exists that day`);
      }
      const ref = reference(c, rule);
      assert.deepEqual(got.filter((t) => t.getTime() < ref.horizon).map((t) => t.toISOString()), ref.dates.map((t) => t.toISOString()));
    },
  });
});

test('COUNT gives exactly COUNT occurrences when the rule can fill it (DAILY and WEEKLY, 80 cases)', async () => {
  await forAll('rrule exact count', {
    cases: 80,
    gen: (r) => {
      const c = gen(r);
      const freq = r.pick(['DAILY', 'WEEKLY']);
      return { ...c, rule: `FREQ=${freq};INTERVAL=${r.int(1, 3)};COUNT=${r.int(1, 80)}${r.bool() ? `;BYDAY=${r.array(1, 3, () => r.pick(DAYS)).join(',')}` : ''}` };
    },
    shrink: () => [],
    check: (c) => {
      const rule = parseRule(c.rule);
      assert.equal(occurrences(c.start, c.tz, rule).length, rule.count);
    },
  });
});

test('a weekday listed twice in BYDAY gives each occurrence once (WEEKLY, 100 cases)', async () => {
  await forAll('rrule duplicate BYDAY', {
    cases: 100,
    gen: (r) => {
      const c = gen(r);
      const d = r.pick(DAYS);
      return { ...c, rule: `FREQ=WEEKLY;COUNT=${r.int(2, 20)};BYDAY=${d},${r.bool() ? `${r.pick(DAYS)},` : ''}${d}` };
    },
    shrink: () => [],
    check: (c) => {
      const got = occurrences(c.start, c.tz, parseRule(c.rule)).map((t) => t.getTime());
      assert.equal(new Set(got).size, got.length, 'the same instant twice');
    },
  });
});

/** The local dates in a year when the zone's offset changes, with the size of the change in minutes. */
const TRANSITIONS = new Map<string, { y: number; m: number; d: number; delta: number }[]>();
const transitions = (tz: string, y: number): { y: number; m: number; d: number; delta: number }[] => {
  const key = `${tz} ${y}`;
  const seen = TRANSITIONS.get(key);
  if (seen) return seen;
  const out: { y: number; m: number; d: number; delta: number }[] = [];
  const off = (t: number) => {
    const w = wallOf(new Date(t), tz);
    return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - t) / 60_000);
  };
  for (let n = Date.UTC(y, 0, 1, 12); n < Date.UTC(y + 1, 0, 1, 12); n += DAY) {
    const delta = off(n + DAY) - off(n);
    if (delta) {
      const w = wallOf(new Date(n + DAY), tz);
      out.push({ y: w.y, m: w.m, d: w.d, delta });
    }
  }
  TRANSITIONS.set(key, out);
  return out;
};

test('around DST changes: a skipped time moves forward by the gap, a repeated time takes the earlier instant (60 cases)', async () => {
  await forAll('rrule across DST', {
    cases: 60,
    gen: (r) => {
      const tz = r.pick(['America/New_York', 'Europe/London', 'Australia/Lord_Howe'] as const);
      const t = r.pick(transitions(tz, r.int(2021, 2030)));
      const before = new Date(Date.UTC(t.y, t.m - 1, t.d) - r.int(0, 3) * DAY);
      const h = r.pick([0, 1, 1, 2, 2, 3]);
      return { tz, delta: t.delta, start: { y: before.getUTCFullYear(), m: before.getUTCMonth() + 1, d: before.getUTCDate(), h, min: r.int(0, 59) }, rule: `FREQ=${r.pick(['DAILY', 'WEEKLY'])};COUNT=6` };
    },
    shrink: () => [],
    check: (c) => {
      const got = occurrences(c.start, c.tz, parseRule(c.rule));
      const gap = Math.abs(c.delta) * 60_000;
      for (const t of got) {
        const w = wallOf(t, c.tz);
        const asked = { y: w.y, m: w.m, d: w.d, h: c.start.h, min: c.start.min };
        if (w.h === c.start.h && w.min === c.start.min) {
          // If the same wall time also happens one gap later or earlier, this must be the earlier one.
          const earlier = wallOf(new Date(t.getTime() - gap), c.tz);
          assert.ok(!sameWall(earlier, asked), `${t.toISOString()} is the second ${c.start.h}:${pad(c.start.min)} of the day in ${c.tz}`);
        } else {
          const moved = (w.h * 60 + w.min) - (c.start.h * 60 + c.start.min);
          assert.equal(moved, Math.abs(c.delta), `${t.toISOString()} moved ${moved} minutes past a ${Math.abs(c.delta)}-minute gap`);
        }
      }
    },
  });
});
