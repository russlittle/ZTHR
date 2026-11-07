import { mkdirSync, writeFileSync } from 'node:fs';
import { OUT } from './lib.js';

/**
 * A load test against a running Student Advocate: many visitors at once, each with their own demo copy, moving
 * through the screens a student uses. It records every request's time and status, and reports the median, 95th
 * and 99th percentile and the error rate, so the evidence page states how the app holds up rather than asserting it.
 *
 *   tsx tools/load.ts <base url> [visitors=25] [seconds=30]
 *
 * It fails when any request answers 500 or above, or the 95th percentile is over the budget below.
 */
const BUDGET_P95_MS = Number(process.env.LOAD_P95_MS ?? 1500);
const base = (process.argv[2] ?? 'http://localhost:8787/studentadvocate').replace(/\/$/, '');
const visitors = Number(process.argv[3] ?? 25);
const seconds = Number(process.argv[4] ?? 30);
const STUDENTS = ['maria', 'destiny', 'priya', 'tyler', 'jayden', 'sam'];
const SCREENS = ['', '/school', '/money', '/help', '/week', '/school/drop', '/you'];

type Sample = { path: string; ms: number; status: number };
const samples: Sample[] = [];
const stopAt = Date.now() + seconds * 1000;

async function visitor(n: number): Promise<void> {
  let cookie = '';
  const sid = STUDENTS[n % STUDENTS.length]!;
  let i = n;
  while (Date.now() < stopAt) {
    const path = `/s/${sid}${SCREENS[i++ % SCREENS.length]}`;
    const t0 = performance.now();
    let status = 0;
    try {
      const r = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      status = r.status;
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      await r.arrayBuffer();
    } catch {
      status = 599;
    }
    samples.push({ path: path.replace(sid, ':id'), ms: performance.now() - t0, status });
    if (i % 5 === 0) {
      const t1 = performance.now();
      const r = await fetch(`${base}/s/${sid}/action`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=final-need', redirect: 'manual' }).catch(() => undefined);
      samples.push({ path: 'POST /s/:id/action', ms: performance.now() - t1, status: r?.status ?? 599 });
    }
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!) : 0;
};

await Promise.all(Array.from({ length: visitors }, (_, n) => visitor(n)));
const ms = samples.map((s) => s.ms);
const errors = samples.filter((s) => s.status >= 500);
const byPath = Object.fromEntries([...new Set(samples.map((s) => s.path))].map((p) => {
  const xs = samples.filter((s) => s.path === p).map((s) => s.ms);
  return [p, { requests: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) }];
}));
const report = { at: new Date().toISOString(), base, visitors, seconds, requests: samples.length, perSecond: Math.round(samples.length / seconds), p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: Math.round(Math.max(...ms)), errors: errors.length, budgetP95: BUDGET_P95_MS, byPath };
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/load.json`, JSON.stringify(report, null, 1));
console.log(`load: ${report.requests} requests from ${visitors} visitors in ${seconds}s (${report.perSecond}/s); p50 ${report.p50} ms, p95 ${report.p95} ms, p99 ${report.p99} ms; ${errors.length} errors`);
process.exit(errors.length || report.p95 > BUDGET_P95_MS ? 1 : 0);
